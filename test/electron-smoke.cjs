// Runs the actual UI, automatic LAN discovery and real WebRTC in two hidden
// windows. Only synthetic camera/microphone/audio are used; no desktop capture.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const { Room } = require('../src/room.cjs');
const { configurePermissions } = require('../src/permissions.cjs');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const rooms = new Map(), windows = [];
const reverseOffer = process.argv.includes('--reverse-offer');
const out = path.resolve(process.env.ENTRETELA_TEST_OUTPUT || 'work/test-media');
app.setPath('userData', path.join(out, 'profile'));
app.setPath('sessionData', path.join(out, 'session'));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (await fn()) return; await pause(150); }
  throw new Error('Timeout: ' + label);
}
async function run() {
  await app.whenReady(); fs.mkdirSync(out, { recursive: true });
  configurePermissions(session.defaultSession, wc => windows.some(w => w.webContents === wc));
  ipcMain.handle('test-capabilities', () => ({ audio: true, version: require('../package.json').version, electron: process.versions.electron }));
  ipcMain.handle('test-send', (e, msg) => rooms.get(e.sender.id)?.send(msg));
  ipcMain.handle('test-leave', e => rooms.get(e.sender.id)?.close());
  ipcMain.handle('test-join', async (e, opts) => {
    if (opts.name === 'Falha de teste') return { ok: false, code: 'HOST_UNREACHABLE', message: 'Encontrei a sala, mas não consegui conectar: conexão recusada.' };
    const r = new Room();
    r.id = opts.name === 'Ana' ? (reverseOffer ? 'z-ana' : 'a-ana') : (reverseOffer ? 'a-bruno' : 'z-bruno');
    rooms.set(e.sender.id, r);
    r.on('event', msg => { if (!e.sender.isDestroyed()) e.sender.send('room-event', msg); });
    try { return { ok: true, ...await r.start(opts) }; }
    catch (error) { return { ok: false, message: error.message }; }
  });
  for (let i = 0; i < 2; i++) {
    const win = new BrowserWindow({ show: false, width: 1180, height: 800, webPreferences: { preload: path.join(__dirname, 'smoke-preload.cjs'), sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
    windows.push(win);
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.log('RENDERER', message); });
    await win.loadURL(pathToFileURL(path.join(__dirname, '../src/index.html')).href);
  }
  const [a, b] = windows; const js = (w, code) => w.webContents.executeJavaScript(code, true);
  await pause(400);
  fs.writeFileSync(path.join(out, 'lobby.png'), (await a.webContents.capturePage()).toPNG());
  assert.equal(await js(a, `document.querySelectorAll('#secret, #invite, #copy').length`), 0);
  await js(a, `$('name').value = 'Falha de teste'; $('join-form').requestSubmit()`);
  await waitFor(() => js(a, `$('notice').textContent.includes('conexão recusada') && !$('join').disabled`), 'clear retryable join error');
  assert.equal(await js(a, `$('notice').textContent.includes('Error invoking') || inRoom`), false);
  await js(a, `$('allow-network').click()`);
  await waitFor(() => js(a, `$('notice').textContent === 'Permissão simulada no teste.' && !$('allow-network').disabled`), 'network permission UI without system changes');
  // Exercise the real one-field form instead of bypassing it through the API.
  await js(a, `$('name').value = 'Ana'; $('join-form').requestSubmit()`);
  await waitFor(() => js(a, `inRoom`), 'first member starts single room');
  if (!reverseOffer) {
    await js(a, `$('mic').click()`);
    await waitFor(() => js(a, `!!microphone`), 'microphone active before friend joins');
  }
  await js(b, `$('name').value = 'Bruno'; $('join-form').requestSubmit()`);
  await waitFor(() => js(b, `inRoom`), 'second member discovers single room');
  await waitFor(async () => await js(a, `peers.size === 1 && [...peers.values()][0].pc.connectionState === 'connected'`) && await js(b, `peers.size === 1 && [...peers.values()][0].pc.connectionState === 'connected'`), 'WebRTC connected');
  if (reverseOffer) await js(a, `$('mic').click()`);
  await waitFor(() => js(b, `(() => {const v=[...peers.values()][0].voice; return !!v.srcObject?.getAudioTracks().length && v.currentTime>0 && !v.paused && !v.muted;})()`), 'listener hears friend with own microphone still off');
  assert.equal(await js(b, `microphone`), null);
  await js(b, `$('mic').click()`);
  await waitFor(async () => await js(a, `!!microphone`) && await js(b, `!!microphone`), 'synthetic microphones');
  await js(a, `send({type:'share-request'})`);
  await waitFor(() => js(a, `presenter === me`), 'presenter lock');
  const syntheticScreen = w => js(w, `(async () => {
    window.testCanvas = document.createElement('canvas'); testCanvas.width = 640; testCanvas.height = 360;
    window.testPaint = setInterval(() => { const c = testCanvas.getContext('2d'); c.fillStyle = '#347e61'; c.fillRect(0,0,640,360); c.fillStyle = 'white'; c.font='30px sans-serif'; c.fillText('Tela de teste ' + Date.now(),40,180); }, 50);
    window.testAudio = new AudioContext(); const osc = testAudio.createOscillator(); const dest = testAudio.createMediaStreamDestination(); osc.connect(dest); osc.start(); await testAudio.resume();
    screen = new MediaStream([...testCanvas.captureStream(15).getVideoTracks(), ...dest.stream.getAudioTracks()]);
    $('preview').srcObject = new MediaStream(screen.getVideoTracks());
    await replace(1, screen.getVideoTracks()[0]); await replace(2, screen.getAudioTracks()[0]); updateStage();
  })()`);
  await syntheticScreen(a);
  await waitFor(() => js(b, `(async () => {const reports = [...(await [...peers.values()][0].pc.getStats()).values()]; return reports.some(r=>r.type==='inbound-rtp' && r.kind==='video' && r.framesDecoded>2) && reports.filter(r=>r.type==='inbound-rtp' && r.kind==='audio' && r.bytesReceived>0).length===2;})()`), 'separate voice, screen sound and decoded video');
  await waitFor(() => js(a, `(async () => { const reports = [...(await [...peers.values()][0].pc.getStats()).values()]; return reports.some(r => r.type === 'inbound-rtp' && r.kind === 'audio' && r.bytesReceived > 0); })()`), 'voice in the opposite direction');
  for (const w of [a, b]) {
    assert.equal(await js(w, `[...peers.values()][0].pc.getTransceivers().length`), 3, 'each peer must negotiate exactly three media roles');
    assert.equal(await js(w, `!![...peers.values()][0].voice.srcObject?.getAudioTracks().length`), true, 'received voice must be attached to a playback element');
  }
  await waitFor(() => js(b, `(() => {const p=[...peers.values()][0]; return !!p.video.srcObject && p.video.videoWidth>0 && p.video.currentTime>0 && !p.video.paused && !p.video.hidden && !!p.sound.srcObject?.getAudioTracks().length && !p.sound.paused;})()`), 'received screen and sound actually play in the interface');
  await waitFor(async () => await js(a, `(() => {const v=[...peers.values()][0].voice; return v.currentTime>0 && !v.paused && !v.muted;})()`) && await js(b, `(() => {const v=[...peers.values()][0].voice; return v.currentTime>0 && !v.paused && !v.muted;})()`), 'received voice actually plays in both interfaces');
  const greenFrame = w => js(w, `(() => {const video=[...peers.values()][0].video; if (!video.videoWidth) return false; const canvas=document.createElement('canvas'); canvas.width=64; canvas.height=36; const ctx=canvas.getContext('2d'); ctx.drawImage(video,0,0,64,36); const rgba=ctx.getImageData(1,1,1,1).data; return rgba[1]>80 && rgba[1]>rgba[0]*1.4;})()`);
  await waitFor(() => greenFrame(b), 'viewer displays transmitted green image instead of a black stage');
  assert.equal(await js(a, `$('preview').muted && $('preview').srcObject.getAudioTracks().length === 0`), true);
  assert.equal(await js(a, `[...peers.values()][0].pc.getTransceivers()[1].sender.getParameters().encodings[0].maxBitrate`), 1400000);
  await js(a, `$('mic').click()`); assert.equal(await js(a, `microphone.getAudioTracks()[0].enabled`), false);
  await js(b, `$('deafen').click()`); assert.equal(await js(b, `[...peers.values()].every(p=>p.voice.muted && p.sound.muted)`), true);
  b.webContents.invalidate(); await pause(400);
  fs.writeFileSync(path.join(out, 'sala.png'), (await b.webContents.capturePage()).toPNG());
  await js(b, `$('fullscreen').click()`);
  await waitFor(() => js(b, `document.fullscreenElement === $('stage')`), 'viewer enters fullscreen');
  assert.equal(await js(b, `getComputedStyle($('stage')).maxHeight`), 'none');
  fs.writeFileSync(path.join(out, 'tela-cheia.png'), (await b.webContents.capturePage()).toPNG());
  await js(b, `$('fullscreen').click()`);
  await waitFor(() => js(b, `!document.fullscreenElement`), 'viewer leaves fullscreen');
  await js(a, `stopScreen()`);
  await waitFor(() => js(b, `presenter === null && !$('empty').hidden`), 'stop sharing');
  await js(b, `$('deafen').click(); send({type:'share-request'})`);
  await waitFor(() => js(b, `presenter === me`), 'second participant takes presentation');
  await syntheticScreen(b);
  await waitFor(() => greenFrame(a), 'screen is visible in the reverse direction');
  await waitFor(() => js(a, `(() => {const p=[...peers.values()][0]; return !!p.sound.srcObject?.getAudioTracks().length && p.sound.currentTime>0 && !p.sound.paused && !p.sound.muted;})()`), 'screen sound plays in the reverse direction');
  await js(a, `$('fullscreen').click()`);
  await waitFor(() => js(a, `document.fullscreenElement === $('stage')`), 'reverse viewer enters fullscreen');
  await js(b, `stopScreen()`);
  await waitFor(() => js(a, `presenter === null && !document.fullscreenElement`), 'ending presentation also exits fullscreen');
  const support = await js(a, `navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio`);
  console.log(JSON.stringify({ ok: true, reverseOffer, electron: process.versions.electron, restrictOwnAudioSupported: support, tests: ['exactly three negotiated roles','receive with own microphone off','bidirectional voice playback','visible screen pixels in both directions','separate screen audio playback','viewer fullscreen','local preview has no audio','microphone mute','deafen','stop sharing'] }));
  fs.writeFileSync(path.join(out, 'passed.json'), JSON.stringify({ok:true,electron:process.versions.electron,restrictOwnAudioSupported:support}));
}
const timeout = setTimeout(() => { console.error('Smoke test timed out'); app.exit(1); }, 60000);
run().then(async () => { clearTimeout(timeout); await Promise.all([...rooms.values()].map(r => r.close())); app.exit(0); }).catch(async e => {
  console.error(e);
  for (const w of windows) try { console.log('DEBUG', await w.webContents.executeJavaScript(`JSON.stringify({notice:$('notice').textContent,me,members:members.map(p=>({id:p.id,name:p.name})),peers:[...peers].map(([id,p])=>({id,state:p.pc.connectionState,ice:p.pc.iceConnectionState,signaling:p.pc.signalingState,transceivers:p.pc.getTransceivers().map(t=>({mid:t.mid,direction:t.currentDirection,kind:t.receiver.track.kind,sending:!!t.sender.track})),playback:[p.voice,p.video,p.sound].map(el=>({tracks:el.srcObject?.getTracks().length||0,paused:el.paused,time:el.currentTime,width:el.videoWidth}))}))})`)); } catch {}
  fs.writeFileSync(path.join(out, 'failed.txt'), String(e)); clearTimeout(timeout); await Promise.all([...rooms.values()].map(r => r.close())); app.exit(1);
});
