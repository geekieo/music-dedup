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
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
import './bootstrap-env.js'; // 必须先于其它 import：lib/db.js 在模块加载时即解析 DB_PATH
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { migrateLegacyData } from '../scripts/migrate-data.mjs';
import { registerProtocol } from './protocol.js';
import { registerApi } from './ipc/index.js';

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

// ── P2 客户端路径 ─────────────────────────────────────────────────────────
let mainWindow = null;
function sendScan(data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('scan:progress', data);
}

function createClientWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'MusicDedup',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  if (!app.isPackaged) {
    // dev 下把渲染进程 console 转发到主进程 stdout，便于 smoke/调试定位
    win.webContents.on('console-message', (event) => console.log(`[renderer] ${event.message}`));
  }
  return win;
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
app.whenReady().then(async () => {
  // 数据迁移（幂等）：首启从旧 data/ 搬迁，绝不覆盖已存在库
  const mig = migrateLegacyData({ targetDb: process.env.DB_PATH });
  if (mig.migrated) console.log(`[v2] 已从旧 data/ 搬迁数据库 → ${mig.target}`);
  else if (mig.reason === 'target-exists')
    console.log(`[v2] 数据库已存在，跳过搬迁: ${process.env.DB_PATH}`);
  else if (fs.existsSync(process.env.DB_PATH))
    console.log(`[v2] 无旧 data/ 库，沿用已存在库: ${process.env.DB_PATH}`);
  else console.log(`[v2] 无旧 data/ 库，使用全新库: ${process.env.DB_PATH}`);

  // 协议处理（先于任何窗口加载）
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

  // 默认：P2 客户端（IPC + 自定义协议，无 HTTP）
  mainWindow = createClientWindow();
  registerApi({ send: sendScan });
  await mainWindow.loadURL('musicdedup://app/index.html');
  console.log('[v2-P2] 客户端就绪（IPC 化，无 HTTP 层）');

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
