const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('api', {
  agentCfg: () => ipcRenderer.invoke('agent:cfg:get'),
  agentSetCfg: c => ipcRenderer.invoke('agent:cfg:set', c),
  agentPick: () => ipcRenderer.invoke('agent:pick'),
  agentRun: a => ipcRenderer.invoke('agent:run', a),
  agentStop: id => ipcRenderer.send('agent:stop', id),
  agentConfirm: r => ipcRenderer.send('agent:confirm', r),
  onAgent: cb => ipcRenderer.on('agent:evt', (_, m) => cb(m)),
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
