// electron/main.js — v2 主进程入口
//
// P2（当前）：IPC 化 —— server.js 的 Express 路由已迁到 electron/ipc/*，
//   应用本体（静态资源 / rules-meta / cover / stream）走 musicdedup:// 协议，
//   HTTP 层彻底移除。数据目录一律 userData（%APPDATA%/MusicDedup/）。
// P0 验证路径：P0_VERIFY=1（npm run p0:verify）跑回归套件 + 展示页。
// Smoke 自测：V2_SMOKE=1（npm run smoke）——真实库加载后从主进程经 IPC 打关键
//   接口，验证 preload→ipc→lib 全链路，通过后自动退出。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, protocol, Notification, Tray, Menu, nativeImage } = require('electron');
import './bootstrap-env.js'; // 必须先于其它 import：lib/db.js 在模块加载时即解析 DB_PATH
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Windows 通知/任务栏需要 AppUserModelId（打包后 appId 已在 build 配置）
app.setAppUserModelId('com.geekieo.musicdedup');

import { runMigrationUX } from './migration.js';
// protocol.js / ipc/index.js 在模块级即 getDB()（打开/创建目标库）—— 必须在迁移决策
// 之后才动态 import（见 whenReady），否则首启迁移会被"先建出的空目标库"静默跳过。
import { getDB } from '../lib/db/index.js';
import { getSetting, setSetting } from '../lib/db/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isP0Verify = process.env.P0_VERIFY === '1';
const isSmoke = process.env.V2_SMOKE === '1';

// P0 自测需要渲染进程无手势直接 play()；真实播放器走用户手势
if (isP0Verify) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  { scheme: 'musicdedup', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

// ── P0 回归路径：渲染进程可用的测试样本（只读信息，播放走 musicdedup://）──────
function getSampleFiles() {
  const base = path.join(__dirname, '..', '.p0-tmp', 'samples');
  return [
    { kind: 'FLAC', path: path.join(base, 'BarroomBallet.flac') },
    { kind: 'M4A', path: path.join(base, 'sample.m4a') },
    { kind: 'MP3', path: path.join(base, 'sample.mp3') },
  ].filter((s) => fs.existsSync(s.path));
}

// ── P4 客户端路径 ─────────────────────────────────────────────────────────
let mainWindow = null;
let tray = null;
// P4 关闭行为特殊化：空闲关窗=正常退出；扫描等长任务进行中关窗=最小化到托盘（不中断）。
let scanRunning = false; // 由 scan 事件跟踪（start→true / done→false）
let forceQuit = false;   // 托盘「退出」置位，跳过关窗拦截
function sendScan(data) {
  if (!data) return;
  if (data.type === 'start') scanRunning = true;
  else if (data.type === 'done') scanRunning = false;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scan:progress', data);
  // P4 扫描完成系统通知（done 事件由 scan.js finally 广播，含 abortFlag）
  if (data.type === 'done') {
    try {
      new Notification({
        title: data.abortFlag ? 'MusicDedup 扫描已中止' : 'MusicDedup 扫描完成',
        body: data.abortFlag ? '扫描已被中止。' : '全部所选步骤已完成。',
        icon: appIcon(),
      }).show();
    } catch (e) { /* 通知失败不阻塞 */ }
  }
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// P4 系统托盘：图标由渲染进程首启代码生成（栅格化 favicon SVG → PNG data URL →
// 主进程 createTrayFromDataUrl），不提交图片资产；退出置 forceQuit 跳过关窗拦截。
function createTrayFromDataUrl(dataUrl) {
  try {
    const icon = nativeImage.createFromDataURL(dataUrl);
    if (icon.isEmpty()) { console.log('[v2] 警告：托盘图标（dataURL）为空'); return; }
    if (tray) { tray.setImage(icon); return; } // 已存在则仅更新图标
    tray = new Tray(icon);
    tray.setToolTip('MusicDedup');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: '退出', click: () => { forceQuit = true; app.quit(); } },
    ]));
    tray.on('double-click', showMainWindow);
    console.log('[v2] 托盘已创建（代码生成图标）');
  } catch (e) {
    console.log('[v2] 托盘创建失败：', e.message);
  }
}

// P4 统一图标：窗口/任务栏图标与托盘同源（渲染进程栅格化 favicon SVG 送达，不提交图片资产）
// Windows/Linux: win.setIcon 更新任务栏+标题栏；macOS: Dock 图标走 app.dock
function applyWindowIcon(dataUrl) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const icon = nativeImage.createFromDataURL(dataUrl);
    if (icon.isEmpty()) { console.log('[v2] 警告：窗口图标（dataURL）为空'); return; }
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(icon);
    } else {
      mainWindow.setIcon(icon);
    }
  } catch (e) {
    console.log('[v2] 设置窗口图标失败：', e.message);
  }
}

// 通知用应用图标（Windows toast 小图标）：Electron Notification 的 icon 选项在
// Windows 上生效（否则走 AUMID 快捷方式解析，dev 下 electron.exe 会退化成默认图标）。
// 用 assets/icon.ico（dev 仓库 / 打包 asar 内都存在，build 时由 npm run icons 生成）。
function appIcon() {
  try {
    const p = path.join(__dirname, '..', 'assets', 'icon.ico');
    if (!fs.existsSync(p)) return null;
    return p;
  } catch { return null; }
}

function createClientWindow() {
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  // 窗口状态记忆（存 settings 表，计划 P4）：恢复上次尺寸/位置/最大化。
  // 惰性 getDB()：窗口只在迁移决策（whenReady）后创建，此刻库必已就绪。
  const saved = getSetting(getDB(), 'window_state', null) || {};
  const win = new BrowserWindow({
    width: saved.width || 1280,
    height: saved.height || 840,
    x: saved.x,
    y: saved.y,
    title: 'MusicDedup',
    autoHideMenuBar: true,
    // ── P4 无边框（路线 A · 保留原生窗口控件）────────────────────────────
    // Windows: titleBarStyle hidden + titleBarOverlay（原生 min/max/close 悬浮，
    //   Aero Snap 免费）；配色对齐 header（--bg-base #FFFFFF / --tx-muted #6B7280）
    // macOS:   titleBarStyle hidden + trafficLightPosition（原生红绿灯左上避让）
    // Linux:   frame:false + header 内自绘三键（WindowControls 组件）
    ...(isWin ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#FFFFFF', symbolColor: '#6B7280', height: 54 } } : {}),
    ...(isMac ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 18 } } : {}),
    ...(!isWin && !isMac ? { frame: false } : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (saved.maximized) win.maximize();
  // 关闭/最大化时记录窗口状态（最大化存 normal bounds + 标记，恢复时还原）
  win.on('close', (e) => {
    const b = win.getNormalBounds();
    setSetting(getDB(), 'window_state', { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
    // 扫描进行中关窗 → 最小化到托盘（不中断扫描），并通知用户去向；
    // 托盘「退出」置 forceQuit 后走正常退出
    if (!forceQuit && scanRunning) {
      const wasVisible = win.isVisible();
      e.preventDefault();
      win.hide();
      if (wasVisible) {
        try {
          new Notification({
            title: 'MusicDedup 扫描进行中',
            body: '已最小化到托盘，扫描继续后台运行。恢复窗口请点击托盘图标；退出请用托盘菜单。',
            icon: appIcon(),
          }).show();
        } catch (err) { /* 通知失败不阻塞 */ }
      }
    }
  });
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  if (!app.isPackaged) {
    // dev 下把渲染进程 console 转发到主进程 stdout，便于 smoke/调试定位
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
  }
  return win;
}

// 窗口控制 IPC（供 Linux 自绘按钮 / 通用调用；Win/mac 走原生控件不强制使用）
function registerWindowControls() {
  ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
  ipcMain.handle('win:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
  ipcMain.handle('win:close', () => { if (mainWindow) mainWindow.close(); });
  ipcMain.handle('win:is-maximized', () => (mainWindow ? mainWindow.isMaximized() : false));
}

// Smoke：真实库 + preload + ipc + lib 全链路自测（V2_SMOKE=1 时运行）
async function runSmoke(win) {
  const script = `(async () => {
    const req = (m, u, b) => window.bridge.request(m, u, b)
      .then(x => ({ m, u, ok: !!(x && x.ok), err: (x && x.error) || null }))
      .catch(e => ({ m, u, ok: false, err: String(e) }));
    const out = [];
    out.push(await req('GET', '/api/stats'));
    out.push(await req('GET', '/api/settings'));
    const lib = await window.bridge.request('GET', '/api/library?page=1&limit=2');
    out.push({ m: 'GET', u: '/api/library?page=1&limit=2', ok: !!(lib && lib.ok && lib.data && lib.data.rows && lib.data.rows.length), err: (lib && lib.error) || null });
    const libTier = await window.bridge.request('GET', '/api/library?sort=scrape_tier&limit=5');
    out.push({ m: 'GET', u: '/api/library?sort=scrape_tier&limit=5', ok: !!(libTier && libTier.ok && libTier.data && Array.isArray(libTier.data.rows)), err: (libTier && libTier.error) || null });
    const fid = lib && lib.ok && lib.data && lib.data.rows && lib.data.rows.length ? lib.data.rows[0].id : null;
    if (fid) {
      // 用 <audio>（真实播放路径）验证 id→path 解析 + 协议 Range —— 自定义协议间
      // fetch 被 Chromium 禁止（媒体元素豁免 CORS），不能用 fetch 测
      const st = await new Promise((res) => {
        const audio = document.createElement('audio');
        const t = setTimeout(() => { audio.src = ''; res('TIMEOUT'); }, 6000);
        audio.onloadedmetadata = () => { clearTimeout(t); res('OK'); };
        audio.onerror = () => { clearTimeout(t); res('ERR:' + (audio.error && audio.error.code)); };
        audio.src = 'musicdedup://stream/' + fid;
        audio.load();
      });
      out.push({ m: 'AUDIO', u: 'musicdedup://stream/' + fid, ok: st === 'OK', err: st });
    } else {
      out.push({ m: 'AUDIO', u: 'musicdedup://stream/<id>', ok: false, err: 'no file id from library' });
    }
    out.push({ m: 'JS', u: '/rules-meta.js globals', ok: typeof GROUP_TAG_LABELS !== 'undefined' && typeof computeScrapeMatch === 'function', err: null });
    out.push({ m: 'UI', u: 'React app rendered', ok: document.body.innerText.includes('MusicDedup') && !!document.querySelector('button'), err: null });
    // 托盘图标代码生成验证：favicon SVG → 32px PNG data URL（首启由同一逻辑生成托盘）
    const trayIcon = await (async () => {
      try {
        const link = document.querySelector('link[rel=icon]');
        if (!link) return { m: 'TRAY', u: 'favicon', ok: false, err: 'no favicon link' };
        const img = new Image();
        img.src = link.href;
        await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('svg load failed')); });
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        c.getContext('2d').drawImage(img, 0, 0, 32, 32);
        const url = c.toDataURL('image/png');
        return { m: 'TRAY', u: 'favicon→32px png', ok: url.startsWith('data:image/png') && url.length > 200, err: null };
      } catch (e) { return { m: 'TRAY', u: 'favicon', ok: false, err: String(e) }; }
    })();
    out.push(trayIcon);
    out.push(await req('GET', '/api/duplicates'));
    out.push(await req('GET', '/api/scan/status'));
    out.push(await req('GET', '/api/retention-list'));
    return JSON.stringify(out);
  })()`;
  const res = await win.webContents.executeJavaScript(script);
  const list = JSON.parse(res);
  const failed = list.filter((r) => !r.ok);
  for (const r of list) console.log(`[v2-smoke] ${r.ok ? 'PASS' : 'FAIL'} ${r.m} ${r.u}${r.err ? ' — ' + r.err : ''}`);
  console.log(`[v2-smoke] ${list.length - failed.length}/${list.length} 通过`);
  app.exit(failed.length ? 1 : 0);
}

// ── 启动 ──────────────────────────────────────────────────────────────────
// 单实例锁（防重复打开 → SQLite 并发写冲突，计划 §七.2）：第二个实例直接退出，
// 并把已存在的窗口聚焦到前台。P0/smoke 测试模式不抢锁（smoke 只读，可与客户端共存）。
const isClientMode = !isP0Verify && !isSmoke;if (isClientMode && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (isClientMode) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  app.whenReady().then(async () => {
    // ── P5 数据迁移：决策先于任何 DB 打开 ────────────────────────────────
    // protocol.js 与 ipc/*.js 在模块级即 getDB()（打开/创建目标库），必须等迁移
    // 决策后才动态 import——否则"先建出的空目标库"会让迁移被 target-exists 静默跳过
    // （P2 引入的排序回归，P5 修复）。P0 为 harness 样本专用，不迁移。
    let mig = null;
    if (!isP0Verify) {
      mig = await runMigrationUX({ interactive: isClientMode });
      if (mig.migrated) console.log(`[v2] 已迁移旧数据 → ${mig.target}`);
      else if (mig.reason === 'target-exists')
        console.log(`[v2] 数据库已存在，跳过迁移: ${process.env.DB_PATH}`);
      else if (mig.reason === 'skipped') console.log('[v2] 用户选择全新开始（未迁移旧数据）');
      else if (mig.reason === 'no-legacy-source') console.log('[v2] 未检测到旧数据，使用全新库');
      else if (mig.reason === 'copy-failed')
        console.error(`[v2] 迁移失败（已回滚目标，可重试）：${mig.error}`);
      else console.log(`[v2] 未迁移（${mig.reason}）`);
    }

    // 协议处理（先于任何窗口加载；protocol.js 动态 import 才打开目标库——已在迁移后）
    const { registerProtocol } = await import('./protocol.js');
    registerProtocol();

    if (isP0Verify) {
      // P0 回归套件：主进程跑验证 + P0 渲染页展示
      const { runVerification } = await import('./p0/verify.js');
      const cachedVerify = await runVerification();
      for (const r of cachedVerify) {
        console.log(`[P0] ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  —  ${r.detail}`);
      }
      const passed = cachedVerify.filter((r) => r.pass).length;
      console.log(`[P0] 验证完成：${passed}/${cachedVerify.length} 通过`);

      ipcMain.handle('p0:verify', () => cachedVerify);
      ipcMain.handle('p0:samples', () => getSampleFiles());
      ipcMain.on('p0:stream-result', (_e, r) => {
        console.log(`[P0] ${r && r.pass ? 'PASS' : 'FAIL'}  自定义协议流式播放  —  ${r && r.detail}`);
        if (process.env.P0_AUTORUN) setTimeout(() => app.quit(), 800);
      });

      const win = new BrowserWindow({
        width: 960,
        height: 840,
        title: 'MusicDedup v2 — P0 技术验证',
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          sandbox: true,
        },
      });
      win.loadFile(path.join(__dirname, 'renderer.html'));
      return;
    }

    // 默认：客户端（IPC + 自定义协议，无 HTTP）
    // ipc/index.js 在模块级即 getDB()，动态 import 放在迁移决策之后（见上方注释）
    const { registerApi } = await import('./ipc/index.js');
    mainWindow = createClientWindow();
    registerApi({ send: sendScan });
    registerWindowControls();
    // 托盘：渲染进程首启代码生成图标后经 tray:icon 送达（不提交图片资产）
    ipcMain.on('tray:icon', (_e, dataUrl) => { if (dataUrl) createTrayFromDataUrl(dataUrl); });
    // 统一图标：窗口/任务栏图标同样由渲染进程栅格化 favicon SVG 后经 win:icon 送达
    ipcMain.on('win:icon', (_e, dataUrl) => { if (dataUrl) applyWindowIcon(dataUrl); });
    await mainWindow.loadURL('musicdedup://app/index.html');
    console.log('[v2-P4] 客户端就绪（单实例锁生效，IPC 化，无 HTTP 层）');

    if (isSmoke) await runSmoke(mainWindow);
  });

  app.on('activate', () => {
    if (!isP0Verify && BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createClientWindow();
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
