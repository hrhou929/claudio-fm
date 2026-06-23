'use strict';

const { app, BrowserWindow, shell, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');

// ── App root ───────────────────────────────────────────────────────
// 打包后：Contents/Resources/app/
// 开发时：项目根目录
const appRoot = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : path.join(__dirname, '..');

// 切换工作目录，让 server.js 内的相对路径正确解析
process.chdir(appRoot);

// 加载 .env
require('dotenv').config({ path: path.join(appRoot, '.env') });

// ── 可写目录（App 包内只读，数据写到用户目录）───────────────────────
const userData = app.getPath('userData');
const neteaseDataDir = path.join(userData, 'netease');
const ttsCacheDir    = path.join(userData, 'tts-cache');
fs.mkdirSync(neteaseDataDir, { recursive: true });
fs.mkdirSync(ttsCacheDir,    { recursive: true });
process.env.NETEASE_DATA_DIR = neteaseDataDir;
process.env.TTS_CACHE_DIR    = ttsCacheDir;
process.env.CLAUDIO_DB_PATH  = path.join(userData, 'claudio.sqlite');

// ── 端口 ───────────────────────────────────────────────────────────
const PORT = parseInt(process.env.CLAUDIO_PORT || '8888', 10);
const NETEASE_PORT = (() => {
  try { return new URL(process.env.NETEASE_API_BASE || 'http://127.0.0.1:3000').port || '3000'; }
  catch { return '3000'; }
})();
const NETEASE_URL = `http://127.0.0.1:${NETEASE_PORT}`;

let neteaseProc = null;
let mainWindow  = null;

// ── HTTP 轮询（通用）──────────────────────────────────────────────
function pollUrl(url, maxMs = 45000) {
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

// ── 等待 NeteaseCloudMusicApi 完全就绪（轮询 /inner/version）───────
// 根路径有响应≠API 就绪，必须用 /inner/version 确认
function waitForNeteaseReady(maxMs = 30000) {
  const url = NETEASE_URL.replace(/\/$/, '') + '/inner/version';
  return new Promise((resolve, reject) => {
    const start = Date.now();
    function check() {
      const req = http.request(url, { method: 'POST' }, res => {
        res.resume();
        if (res.statusCode < 500) resolve();
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

// ── 带重试的 verifyLoginStatus ─────────────────────────────────────
// 启动后 API 可能还在热身，最多重试 3 次（间隔 1.5s）
async function verifyCookieWithRetry(neteaseSessionModule, cookie, maxRetries = 3) {
  const { verifyLoginStatus, neteaseBaseUrl } = neteaseSessionModule;
  for (let i = 0; i < maxRetries; i++) {
    const st = await verifyLoginStatus({ baseUrl: neteaseBaseUrl(), cookie });
    if (st.valid) return st;
    if (i < maxRetries - 1) await new Promise(r => setTimeout(r, 1500));
  }
  return { valid: false };
}

// ── 启动 NeteaseCloudMusicApi 子进程 ──────────────────────────────
// 直接传 [scriptPath] 数组，避免路径含空格被 split 切断
function startNetease() {
  const neteaseJs = path.join(appRoot, 'node_modules', 'NeteaseCloudMusicApi', 'app.js');
  neteaseProc = spawn(process.execPath, [neteaseJs], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: NETEASE_PORT },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  neteaseProc.stdout.on('data', d => process.stdout.write(`[netease] ${d}`));
  neteaseProc.stderr.on('data', d => process.stderr.write(`[netease] ${d}`));
  neteaseProc.on('exit', code => console.log(`[netease] 退出 code=${code}`));
}

// ── 网易云登录（在 Electron 窗口内显示二维码）──────────────────────
async function ensureNeteaseLogin() {
  const {
    resolveCookie, verifyLoginStatus, neteaseBaseUrl,
    createQrLogin, requestNeteaseJson, writeLocalConfig,
  } = require(path.join(appRoot, 'netease-session'));

  // 已有 cookie，验证是否有效（带重试，防止 API 刚启动时报错）
  const { cookie } = resolveCookie();
  if (cookie) {
    const ns = require(path.join(appRoot, 'netease-session'));
    const st = await verifyCookieWithRetry(ns, cookie);
    if (st.valid) { console.log(`[electron] 已登录网易云 UID ${st.userId}`); return; }
    console.log('[electron] cookie 已失效，重新登录');
  }

  // 生成二维码
  let qr;
  try { qr = await createQrLogin({ baseUrl: neteaseBaseUrl() }); }
  catch (e) { throw new Error('连接网易云失败: ' + e.message); }

  // 在 Electron 窗口内显示二维码，不依赖外部浏览器
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
  body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;
       display:flex;flex-direction:column;align-items:center;justify-content:center;
       gap:16px;height:100vh;background:#fff;padding:28px}
  h2{font-size:17px;font-weight:600;color:#111}
  img{border-radius:12px;box-shadow:0 2px 20px rgba(0,0,0,.14)}
  p{font-size:13px;color:#888;text-align:center;line-height:1.6}
  #status{font-size:12px;color:#e15c5c;min-height:18px;font-weight:500}
</style></head><body>
  <h2>网易云音乐登录</h2>
  <img src="${qr.qrImg}" width="180" height="180" alt="二维码">
  <p>用手机网易云 App 扫描上方二维码<br>然后在手机上点击<strong>确认登录</strong></p>
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
        const state = await requestNeteaseJson('/login/qr/check', { key: qr.key }, {
          baseUrl: neteaseBaseUrl(), withCookie: false,
        });
        const code = Number(state?.code);
        if (code === 802) {
          setStatus('已扫码，请在手机上点击确认…');
        } else if (code === 803 && state.cookie) {
          cleanup();
          writeLocalConfig({ cookie: state.cookie, source: 'qr-login' });
          console.log('[electron] 网易云登录成功');
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

// ── 在主进程内启动 Claudio 服务器（不再 spawn 子进程）────────────────
function startClaudioServer() {
  // server.js 内的 __dirname 解析为 appRoot，相对 require 正常工作
  require(path.join(appRoot, 'server.js'));
}

// ── Splash 窗口 ────────────────────────────────────────────────────
function createSplash() {
  const win = new BrowserWindow({
    width: 360, height: 260,
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
  p{font-size:13px;margin:0;color:rgba(255,255,255,.55)}
</style></head><body>
  <h2>Claudio FM</h2>
  <p id="msg">正在启动…</p>
</body></html>`);
  return win;
}

function setSplashMsg(win, msg) {
  if (win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `document.getElementById('msg').textContent=${JSON.stringify(msg)}`
  ).catch(() => {});
}

// ── 主窗口 ─────────────────────────────────────────────────────────
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

// ── 应用菜单 ───────────────────────────────────────────────────────
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

// ── 启动序列 ───────────────────────────────────────────────────────
app.whenReady().then(async () => {
  setAppMenu();
  const splash = createSplash();

  try {
    // 1. 启动 NeteaseCloudMusicApi，等 /inner/version 真正就绪
    setSplashMsg(splash, '正在启动网易云服务…');
    startNetease();
    await waitForNeteaseReady(30000);
    console.log('[electron] 网易云服务就绪');

    // 2. 检查 / 完成网易云登录
    setSplashMsg(splash, '检查账号登录状态…');
    await ensureNeteaseLogin();

    // 3. 在主进程内启动 Claudio 服务器
    setSplashMsg(splash, '正在启动电台服务…');
    startClaudioServer();
    await pollUrl(`http://localhost:${PORT}`, 30000);
    console.log('[electron] 电台服务就绪');

    // 4. 打开主窗口
    createMainWindow();
    splash.destroy();
  } catch (err) {
    console.error('[electron] 启动失败:', err.message);
    if (!splash.isDestroyed()) {
      setSplashMsg(splash, `启动失败: ${err.message}`);
      setTimeout(() => app.quit(), 4000);
    }
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
