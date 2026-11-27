const { contextBridge, ipcRenderer } = require('electron');

// Pages only get these functions, nothing else from Node or Electron.
contextBridge.exposeInMainWorld('scrollwise', {
  on: (channel, handler) => ipcRenderer.on('scrollwise:' + channel, (_event, data) => handler(data)),
  send: (channel) => ipcRenderer.send('scrollwise:' + channel),
  // Resolves to an error message, or null once the site is saved.
  addSite: (text) => ipcRenderer.invoke('scrollwise:add-site', String(text)),
});
