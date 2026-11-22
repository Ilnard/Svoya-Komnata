const {contextBridge,ipcRenderer} = require('electron');
contextBridge.exposeInMainWorld('roomDevices',{
  onSources: callback => { ipcRenderer.on('capture:list',(_event,sources) => callback(sources)); },
  choose: id => ipcRenderer.send('capture:choice',id),
  onMute:cb=>ipcRenderer.on('mute:toggle',()=>cb()),
  muteKey:()=>ipcRenderer.invoke('mute:get'),
  setMuteKey:key=>ipcRenderer.invoke('mute:set',key),
  checkUpdate:()=>ipcRenderer.invoke('updates:check'),
  installUpdate:version=>ipcRenderer.invoke('updates:install',version),
  onUpdateProgress:cb=>ipcRenderer.on('updates:progress',(_event,percent)=>cb(percent)),
  prefs:()=>ipcRenderer.invoke('prefs:get'),
  save:patch=>ipcRenderer.invoke('prefs:set',patch),
  getGpu: () => ipcRenderer.invoke('gpu:get'),
  setGpu: enabled => ipcRenderer.invoke('gpu:set',enabled),
  getMic: () => ipcRenderer.invoke('mic:get'),
  setMic: label => ipcRenderer.invoke('mic:set',label),
});
