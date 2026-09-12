const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('entretela', {
  capabilities: () => ipcRenderer.invoke('test-capabilities'),
  join: opts => ipcRenderer.invoke('test-join', opts),
  allowNetwork: () => Promise.resolve({ ok: true, message: 'Permissão simulada no teste.' }),
  leave: () => ipcRenderer.invoke('test-leave'),
  send: msg => ipcRenderer.invoke('test-send', msg),
  sources: () => Promise.resolve([]),
  selectSource: () => Promise.resolve(),
  onEvent: callback => ipcRenderer.on('room-event', (_e, msg) => callback(msg))
});
