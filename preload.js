const { contextBridge, ipcRenderer } = require('electron');

// The overlay page only gets these two functions, nothing else from Node or Electron.
contextBridge.exposeInMainWorld('scrollwise', {
  on: (channel, handler) => ipcRenderer.on('scrollwise:' + channel, (_event, data) => handler(data)),
  send: (channel) => ipcRenderer.send('scrollwise:' + channel),
});
