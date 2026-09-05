const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('miniApi', {
  onTimerState: (callback) => ipcRenderer.on('timer-state', (event, data) => callback(data)),
  restoreMainWindow: () => ipcRenderer.send('restore-main-window'),
  stopTimer: () => ipcRenderer.send('stop-timer-from-widget')
});