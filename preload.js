const { contextBridge, ipcRenderer } = require('electron');

// The overlay page only gets these two functions, nothing else from Node or Electron.
contextBridge.exposeInMainWorld('pounce', {
  on: (channel, handler) => ipcRenderer.on('pounce:' + channel, (_event, data) => handler(data)),
  send: (channel) => ipcRenderer.send('pounce:' + channel),
});
