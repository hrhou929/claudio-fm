'use strict';

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// 加载 .env
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

require('dotenv').config({ path: path.join(appRoot, '.env') });

// 网易云数据目录写到用户目录（asar 里无法写入）
const neteaseDataDir = path.join(app.getPath('userData'), 'netease');
fs.mkdirSync(neteaseDataDir, { recursive: true });

const PORT = parseInt(process.env.CLAUDIO_PORT || '8888', 10);
const SERVER_URL = `http://localhost:${PORT}`;
let serverProcess = null;
let mainWindow = null;

// ── 启动 Node.js 后端 ─────────────────────────────────────────────
function startServer() {
  const startScript = path.join(appRoot, 'scripts', 'start.js');
  const neteaseAppJs = path.join(appRoot, 'node_modules', 'NeteaseCloudMusicApi', 'app.js');
  serverProcess = spawn(process.execPath, [startScript], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // 让 netease sidecar 也用 Electron 内置 Node，无需系统 node
      NETEASE_SIDECAR_COMMAND: process.execPath,
      NETEASE_SIDECAR_ARGS: neteaseAppJs,
      // 网易云数据目录 & TTS 缓存目录重定向到可写路径
      NETEASE_DATA_DIR: neteaseDataDir,
      TTS_CACHE_DIR: path.join(app.getPath('userData'), 'tts-cache'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', (code) => {
    console.log(`[server] exited with code ${code}`);
  });
}

// ── 等待服务启动 ───────────────────────────────────────────────────
function waitForServer(maxWait = 120000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      http.get(SERVER_URL, (res) => {
        res.resume();
        resolve();
      }).on('error', () => {
        if (Date.now() - start > maxWait) return reject(new Error('Server timeout'));
        setTimeout(check, 800);
      });
    }
    check();
  });
}

// ── 创建主窗口 ─────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 780,
    minWidth: 700,
    minHeight: 600,
    title: 'Claudio FM',
    backgroundColor: '#030f28',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });

  mainWindow.loadURL(SERVER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // 外部链接在浏览器里打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 加载页 ─────────────────────────────────────────────────────────
function createSplash() {
  const splash = new BrowserWindow({
    width: 360, height: 240,
    resizable: false, frame: false,
    backgroundColor: '#030f28',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false },
  });
  splash.loadURL(`data:text/html,<!DOCTYPE html>
<html>
<head><meta charset="utf-8">
<style>
  body { margin:0; background:#030f28; display:flex; flex-direction:column;
         align-items:center; justify-content:center; height:100vh;
         font-family:-apple-system,sans-serif; color:rgba(255,255,255,.6); }
  h2 { font-size:20px; font-weight:600; color:#fff; margin:0 0 10px; letter-spacing:-.02em; }
  p  { font-size:13px; margin:0; }
</style>
</head>
<body>
  <h2>Claudio FM</h2>
  <p>正在启动电台服务…</p>
</body></html>`);
  return splash;
}

// ── 应用菜单 ───────────────────────────────────────────────────────
function setMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    { label: '编辑', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── App 生命周期 ───────────────────────────────────────────────────
app.whenReady().then(async () => {
  setMenu();
  const splash = createSplash();
  startServer();
  try {
    await waitForServer();
    createWindow();
    splash.destroy();
  } catch (err) {
    console.error('Server failed to start:', err.message);
    splash.destroy();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) { serverProcess.kill(); serverProcess = null; }
});
