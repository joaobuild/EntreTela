const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Room } = require('./room.cjs');
let win, room, selected = null, starting = false;
const page = pathToFileURL(path.join(__dirname, 'index.html')).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.restore(); win?.focus(); });
  app.whenReady().then(() => {
    session.defaultSession.setPermissionCheckHandler((wc, permission) => wc === win?.webContents && ['media', 'display-capture'].includes(permission));
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => callback(wc === win?.webContents && ['media', 'display-capture'].includes(permission)));
    session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const choice = selected; selected = null;
      try {
        if (!choice || Date.now() - choice.time > 15000 || request.frame !== win.webContents.mainFrame) return callback({});
        const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
        const source = sources.find(s => s.id === choice.id);
        if (!source) return callback({});
        callback({ video: source, ...(choice.audio ? { audio: 'loopback' } : {}) });
      } catch { callback({}); }
    });
    win = new BrowserWindow({ width: 1180, height: 800, minWidth: 850, minHeight: 650, backgroundColor: '#10131a', autoHideMenuBar: true, title: 'EntreTela', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', e => e.preventDefault());
    win.loadURL(page);
    win.on('closed', () => { room?.close(); room = null; });
  });
}
function handle(name, fn) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('Origem inválida.');
    return fn(...args);
  });
}
handle('capabilities', () => ({ audio: process.platform === 'win32' && Number(os.release().split('.')[2]) >= 20348, version: app.getVersion(), electron: process.versions.electron }));
handle('join', async opts => {
  if (starting || room) throw new Error('Você já está entrando em uma sala.');
  starting = true;
  const current = new Room(); room = current;
  current.on('event', msg => { if (room === current && !win?.isDestroyed()) win.webContents.send('room-event', msg); });
  try { return await current.start(opts); } catch (e) { if (room === current) room = null; throw e; } finally { starting = false; }
});
handle('leave', async () => { const old = room; room = null; await old?.close(); });
handle('send', msg => {
  if (!msg || !['signal', 'share-request', 'share-stop'].includes(msg.type)) throw new Error('Mensagem inválida.');
  room?.send(msg);
});
handle('sources', async () => (await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 280, height: 160 } })).filter(s => s.name !== 'EntreTela').map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })));
handle('select-source', choice => {
  if (!room || !choice || typeof choice.id !== 'string') throw new Error('Entre em uma sala primeiro.');
  const supported = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 20348;
  if (choice.audio && !supported) throw new Error('A transmissão de som sem retorno requer Windows 11.');
  selected = { id: choice.id, audio: !!choice.audio, time: Date.now() };
});
app.on('window-all-closed', () => app.quit());
