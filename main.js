const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { Worker } = require('worker_threads');
const { ExportJob } = require('./exporter');

let win;
let job = null;
let analyzer = null;

// files that must live outside app.asar (worker script, native ONNX runtime)
const unpacked = (p) => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
const modelDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'models') : path.join(__dirname, 'models'));

function ffmpegPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'ffmpeg.exe');
  const local = path.join(__dirname, 'bin', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  return fs.existsSync(local) ? local : 'ffmpeg';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1000, minHeight: 640,
    backgroundColor: '#111317',
    title: 'BlurStudio',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('close', (e) => {
    if (job) {
      const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['لغو خروجی و بستن', 'ادامه'], defaultId: 1,
        message: 'خروجی در حال ساخت است. بسته شود؟' });
      if (r === 1) e.preventDefault(); else job.cancel();
    }
    if (analyzer) analyzer.postMessage('cancel');
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

const VIDEO_FILTERS = [{ name: 'Video', extensions: ['mp4', 'mkv', 'mov', 'webm', 'm4v'] }];

ipcMain.handle('open-video', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: VIDEO_FILTERS });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('save-project', async (_e, { defaultPath, data }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters: [{ name: 'BlurStudio Project', extensions: ['blurproj'] }] });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2), 'utf8');
  return r.filePath;
});

ipcMain.handle('open-project', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'BlurStudio Project', extensions: ['blurproj', 'json'] }] });
  if (r.canceled) return null;
  return { path: r.filePaths[0], data: JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')) };
});

ipcMain.handle('file-exists', (_e, p) => !!p && fs.existsSync(p));

ipcMain.handle('choose-output', async (_e, input) => {
  const p = path.parse(input);
  const r = await dialog.showSaveDialog(win, {
    defaultPath: path.join(p.dir, `${p.name}_blurred.mp4`),
    filters: [{ name: 'MP4', extensions: ['mp4'] }]
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('export', async (_e, opts) => {
  if (job) throw new Error('یک خروجی در حال اجراست.');
  if (path.resolve(opts.output) === path.resolve(opts.input)) throw new Error('فایل خروجی نمی‌تواند همان فایل ورودی باشد.');
  job = new ExportJob({ ...opts, ffmpeg: ffmpegPath() }, (p) => {
    if (win && !win.isDestroyed()) win.webContents.send('export-progress', p);
  });
  try {
    return await job.run();
  } finally {
    job = null;
  }
});

ipcMain.handle('cancel-export', () => { if (job) job.cancel(); return true; });
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

ipcMain.handle('probe', (_e, input) => new Promise((resolve) => {
  const p = spawn(ffmpegPath(), ['-hide_banner', '-i', input], { windowsHide: true });
  let err = '';
  p.stderr.on('data', (b) => (err += b));
  p.on('error', () => resolve({}));
  p.on('close', () => {
    const fps = /Video:.*?([\d.]+) fps/.exec(err) || /Video:.*?([\d.]+) tbr/.exec(err);
    resolve({ fps: fps ? parseFloat(fps[1]) : null });
  });
}));

ipcMain.handle('analyze-start', (_e, opts) => {
  if (analyzer) throw new Error('آنالیز در حال اجراست.');
  return new Promise((resolve, reject) => {
    const w = new Worker(unpacked(path.join(__dirname, 'analyzer.js')), {
      workerData: { ...opts, ffmpeg: ffmpegPath(), modelDir: modelDir() }
    });
    analyzer = w;
    const finish = (fn, v) => { if (analyzer === w) analyzer = null; w.terminate().catch(() => {}); fn(v); };
    w.on('message', (m) => {
      if (m.type === 'done') finish(resolve, m);
      else if (m.type === 'cancelled') finish(reject, new Error('cancelled'));
      else if (m.type === 'error') finish(reject, new Error(m.message));
      else if (win && !win.isDestroyed()) win.webContents.send('analyze-progress', m);
    });
    w.on('error', (e) => finish(reject, e));
  });
});
ipcMain.handle('analyze-cancel', () => { if (analyzer) analyzer.postMessage('cancel'); return true; });
