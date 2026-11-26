const { contextBridge, ipcRenderer, webUtils } = require('electron');
const { pathToFileURL } = require('url');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: (p) => pathToFileURL(p).href,
  openVideo: () => ipcRenderer.invoke('open-video'),
  saveProject: (defaultPath, data) => ipcRenderer.invoke('save-project', { defaultPath, data }),
  openProject: () => ipcRenderer.invoke('open-project'),
  fileExists: (p) => ipcRenderer.invoke('file-exists', p),
  chooseOutput: (input) => ipcRenderer.invoke('choose-output', input),
  exportVideo: (opts) => ipcRenderer.invoke('export', opts),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  probe: (p) => ipcRenderer.invoke('probe', p),
  analyze: (opts) => ipcRenderer.invoke('analyze-start', opts),
  cancelAnalyze: () => ipcRenderer.invoke('analyze-cancel'),
  onAnalyzeProgress: (cb) => ipcRenderer.on('analyze-progress', (_e, p) => cb(p)),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, p) => cb(p))
});
