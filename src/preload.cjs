const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('entretela', {
  capabilities: () => ipcRenderer.invoke('capabilities'),
  join: opts => ipcRenderer.invoke('join', opts),
  leave: () => ipcRenderer.invoke('leave'),
  send: msg => ipcRenderer.invoke('send', msg),
  sources: () => ipcRenderer.invoke('sources'),
  selectSource: choice => ipcRenderer.invoke('select-source', choice),
  onEvent: callback => ipcRenderer.on('room-event', (_event, msg) => callback(msg))
});
