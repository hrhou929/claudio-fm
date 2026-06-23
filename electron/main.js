'use strict';

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// ── App root ───────────────────────────────────────────────────────
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

// ── 日志写入文件（调试用）─────────────────────────────────────────
const logDir  = app.getPath('userData');
const logFile = path.join(logDir, 'claudio-startup.log');
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(logFile, line); } catch {}
}

// ── 可写目录 ─────────────────────────────────────────────────────
const userData       = app.getPath('userData');
const neteaseDataDir = path.join(userData, 'netease');
const ttsCacheDir    = path.join(userData, 'tts-cache');

// ── 端口 ─────────────────────────────────────────────────────────
const PORT = parseInt(process.env.CLAUDIO_PORT || '8888', 10);

let neteaseProc = null;
let mainWindow  = null;

// ── 轮询通用 URL ──────────────────────────────────────────────────
function pollUrl(url, maxMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      http.get(url, res => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() - start > maxMs) return reject(new Error(`启动超时: ${url}`));
          setTimeout(check, 800);
        });
    }
    check();
  });
}

// ── 等待 NeteaseCloudMusicApi /inner/version 真正就绪 ─────────────
function waitForNeteaseReady(maxMs = 30000) {
  const base = process.env.NETEASE_API_BASE || 'http://127.0.0.1:3000';
  const url  = base.replace(/\/$/, '') + '/inner/version';
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      const req = http.request(url, { method: 'POST' }, res => {
        res.resume();
        if (res.statusCode < 500) { log('网易云服务 /inner/version 就绪'); resolve(); }
        else if (Date.now() - start > maxMs) reject(new Error('网易云服务启动超时'));
        else setTimeout(check, 800);
      });
      req.on('error', () => {
        if (Date.now() - start > maxMs) return reject(new Error('网易云服务启动超时'));
        setTimeout(check, 800);
      });
      req.end('{}');
    }
    check();
  });
}

// ── 带重试的 cookie 验证 ──────────────────────────────────────────
async function verifyCookieWithRetry(ns, cookie, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const st = await ns.verifyLoginStatus({ baseUrl: ns.neteaseBaseUrl(), cookie });
    if (st.valid) return st;
    log(`cookie 验证第 ${i+1} 次失败: ${st.reason}，${i < maxRetries - 1 ? '重试…' : '放弃'}`);
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1500));
  }
  return { valid: false };
}

// ── 启动 NeteaseCloudMusicApi ────────────────────────────────────
function startNetease() {
  const neteaseJs = path.join(appRoot, 'node_modules', 'NeteaseCloudMusicApi', 'app.js');
  const base = process.env.NETEASE_API_BASE || 'http://127.0.0.1:3000';
  const port = (() => { try { return new URL(base).port || '3000'; } catch { return '3000'; } })();

  log(`启动 NeteaseCloudMusicApi: ${neteaseJs}`);
  neteaseProc = spawn(process.execPath, [neteaseJs], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  neteaseProc.stdout.on('data', d => log(`[netease] ${d.toString().trim()}`));
  neteaseProc.stderr.on('data', d => log(`[netease:err] ${d.toString().trim()}`));
  neteaseProc.on('exit', code => log(`[netease] 退出 code=${code}`));
}

// ── 网易云 QR 登录窗口 ───────────────────────────────────────────
async function ensureNeteaseLogin() {
  const ns = require(path.join(appRoot, 'netease-session'));
  const { cookie } = ns.resolveCookie();
  log(`cookie 来源: ${cookie ? '已有' : '无'}`);

  if (cookie) {
    const st = await verifyCookieWithRetry(ns, cookie);
    if (st.valid) { log(`已登录 UID ${st.userId}`); return; }
    log('cookie 已失效，需重新登录');
  }

  log('生成网易云二维码…');
  let qr;
  try { qr = await ns.createQrLogin({ baseUrl: ns.neteaseBaseUrl() }); }
  catch (e) { throw new Error('连接网易云失败: ' + e.message); }

  await new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 380, height: 480,
      resizable: false, minimizable: false,
      title: '登录网易云音乐 — Claudio FM',
      backgroundColor: '#ffffff',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    win.loadURL(`data:text/html;charset=utf-8,<!DOCTYPE html>
<html lang="zh"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,sans-serif;display:flex;flex-direction:column;
       align-items:center;justify-content:center;gap:16px;height:100vh;
       background:#fff;padding:28px}
  h2{font-size:17px;font-weight:600;color:#111}
  img{border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.14)}
  p{font-size:13px;color:#888;text-align:center;line-height:1.6}
  #status{font-size:12px;color:#e15c5c;min-height:18px;font-weight:500}
</style></head><body>
  <h2>网易云音乐登录</h2>
  <img src="${qr.qrImg}" width="180" height="180" alt="二维码">
  <p>用手机网易云 App 扫描上方二维码<br>然后点击<strong>确认登录</strong></p>
  <div id="status"></div>
</body></html>`);

    const setStatus = msg =>
      win.webContents.executeJavaScript(
        `document.getElementById('status').textContent=${JSON.stringify(msg)}`
      ).catch(() => {});

    const cleanup = () => { clearInterval(timer); win.removeAllListeners('closed'); };
    win.on('closed', () => { cleanup(); reject(new Error('用户关闭了登录窗口')); });

    const timer = setInterval(async () => {
      try {
        const state = await ns.requestNeteaseJson('/login/qr/check', { key: qr.key }, {
          baseUrl: ns.neteaseBaseUrl(), withCookie: false,
        });
        const code = Number(state?.code);
        if (code === 802) { setStatus('已扫码，请在手机上点击确认…'); }
        else if (code === 803 && state.cookie) {
          cleanup();
          ns.writeLocalConfig({ cookie: state.cookie, source: 'qr-login' });
          log('网易云登录成功');
          win.removeAllListeners('closed');
          win.close();
          resolve();
        } else if (code === 800) {
          cleanup();
          win.removeAllListeners('closed');
          win.close();
          reject(new Error('二维码已过期，请重新打开 App'));
        }
      } catch {}
    }, 2500);
  });
}

// ── 在主进程内启动 Claudio 服务器 ──────────────────────────────
function startClaudioServer() {
  log('加载 server.js…');
  require(path.join(appRoot, 'server.js'));
  log('server.js 加载完成');
}

// ── Splash 窗口 ─────────────────────────────────────────────────
function createSplash() {
  const win = new BrowserWindow({
    width: 360, height: 280,
    resizable: false, frame: false,
    backgroundColor: '#030f28',
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: false },
  });
  win.loadURL(`data:text/html;charset=utf-8,<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body{margin:0;background:#030f28;display:flex;flex-direction:column;align-items:center;
       justify-content:center;height:100vh;font-family:-apple-system,sans-serif;gap:12px}
  h2{font-size:20px;font-weight:600;color:#fff;margin:0;letter-spacing:-.02em}
  p{font-size:13px;margin:0;color:rgba(255,255,255,.55);text-align:center;padding:0 20px}
  small{font-size:10px;color:rgba(255,255,255,.25)}
</style></head><body>
  <h2>Claudio FM</h2>
  <p id="msg">正在启动…</p>
  <small id="sub"></small>
</body></html>`);
  return win;
}

function setSplashMsg(win, msg, sub = '') {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `document.getElementById('msg').textContent=${JSON.stringify(msg)};
     document.getElementById('sub').textContent=${JSON.stringify(sub)};`
  ).catch(() => {});
}

// ── 持久错误弹窗（不自动关闭，让用户看清楚）────────────────────
function showError(err) {
  dialog.showMessageBox({
    type: 'error',
    title: 'Claudio FM 启动失败',
    message: err.message || String(err),
    detail: `日志文件: ${logFile}\n\n请截图发给开发者。`,
    buttons: ['退出'],
  }).then(() => app.quit());
}

// ── 主窗口 ──────────────────────────────────────────────────────
function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1000, height: 780,
    minWidth: 700, minHeight: 600,
    title: 'Claudio FM',
    backgroundColor: '#030f28',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    show: false,
  });
  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── 应用菜单 ─────────────────────────────────────────────────────
function setAppMenu() {
  const tpl = [
    ...(process.platform === 'darwin' ? [{
      label: app.name,
      submenu: [
        { role: 'about' }, { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' }, { role: 'quit' },
      ],
    }] : []),
    { label: '编辑', submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// ── 启动序列 ─────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setAppMenu();

  // 所有文件操作放在 whenReady 后，确保 Electron 完全初始化
  try { process.chdir(appRoot); } catch (e) { log('chdir 失败: ' + e.message); }

  // 加载 .env
  try {
    require('dotenv').config({ path: path.join(appRoot, '.env') });
    log('.env 加载完成');
  } catch (e) { log('.env 加载失败: ' + e.message); }

  // 创建可写目录
  [neteaseDataDir, ttsCacheDir].forEach(d => fs.mkdirSync(d, { recursive: true }));
  process.env.NETEASE_DATA_DIR = neteaseDataDir;
  process.env.TTS_CACHE_DIR    = ttsCacheDir;
  process.env.CLAUDIO_DB_PATH  = path.join(userData, 'claudio.sqlite');

  log(`appRoot: ${appRoot}`);
  log(`userData: ${userData}`);
  log(`PORT: ${PORT}`);

  const splash = createSplash();

  try {
    // 1. 启动网易云服务
    setSplashMsg(splash, '正在启动网易云服务…');
    startNetease();
    await waitForNeteaseReady(30000);

    // 2. 检查登录状态
    setSplashMsg(splash, '检查账号登录状态…');
    await ensureNeteaseLogin();

    // 3. 启动 Claudio 服务器
    setSplashMsg(splash, '正在启动电台服务…');
    startClaudioServer();
    await pollUrl(`http://localhost:${PORT}`, 30000);
    log('电台服务就绪');

    // 4. 打开主窗口
    createMainWindow();
    if (!splash.isDestroyed()) splash.destroy();
  } catch (err) {
    log('启动失败: ' + err.stack || err.message);
    if (!splash.isDestroyed()) splash.destroy();
    showError(err);
  }
});

app.on('window-all-closed', () => {
  if (neteaseProc) { neteaseProc.kill(); neteaseProc = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
});

app.on('before-quit', () => {
  if (neteaseProc) { neteaseProc.kill(); neteaseProc = null; }
});
