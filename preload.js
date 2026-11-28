const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  dir: () => ipcRenderer.invoke('dir:get'),
  pickDir: () => ipcRenderer.invoke('dir:pick'),
  resetDir: () => ipcRenderer.invoke('dir:reset'),
  get: () => ipcRenderer.invoke('store:get'),
  set: d => ipcRenderer.invoke('store:set', d),
  start: a => ipcRenderer.invoke('chat:start', a),
  models: p => ipcRenderer.invoke('models:list', p),
  open: u => ipcRenderer.invoke('open', u),
  stop: id => ipcRenderer.send('chat:stop', id),
  on: cb => ipcRenderer.on('chat:evt', (_, m) => cb(m))
});
