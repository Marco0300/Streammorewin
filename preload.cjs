const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('streammoreDesktop', {
  version: process.versions.electron,
  platform: process.platform,
});
