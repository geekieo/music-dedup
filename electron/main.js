// electron/main.js — v2 主进程入口
//
// P1（当前）：把 v1 的 Express 服务（server.js）整体内嵌进主进程，监听
//   127.0.0.1 随机端口，窗口直接加载该地址 → 双击图标即可打开的可用客户端。
//   数据目录一律切到 userData（%APPDATA%/MusicDedup/，见 scripts/migrate-data.mjs），
//   首启自动从旧 data/ 搬迁，保证打开即有真实曲库。
// P0 验证路径：P0_VERIFY=1（npm run p0:verify）时跑回归套件——验证
//   node-sqlite3-wasm / music-metadata / 标签写入 / Goertzel 在主进程可用，
//   并展示 musicdedup:// 流式播放自测。保留为回归工具，不在默认启动里跑。
// 后续演进：P2 把内嵌 Express 逐路由改为 IPC（main/ipc/*.js），音频流切 musicdedup://。

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import { migrateLegacyData } from '../scripts/migrate-data.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isP0Verify = process.env.P0_VERIFY === '1';

// P0 自测需要渲染进程无手势直接 play()；真实播放器走用户手势，此开关届时移除
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── 自定义流媒体协议 musicdedup://（P2 音频流切换用；P1 前端仍走 HTTP Range）──
const MIME = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.aiff': 'audio/aiff', '.opus': 'audio/ogg',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'musicdedup', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

async function handleStreamRequest(request) {
  const url = new URL(request.url);
  // musicdedup://stream/<encodeURIComponent(绝对路径)>
  const filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!fs.existsSync(filePath)) return new Response('Not found', { status: 404 });

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'audio/mpeg';
  const total = fs.statSync(filePath).size;

  const range = request.headers.get('Range');
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
    const chunkSize = end - start + 1;
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(chunkSize),
        'Content-Type': mime,
      },
    });
  }
  const stream = Readable.toWeb(fs.createReadStream(filePath));
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Length': String(total), 'Accept-Ranges': 'bytes', 'Content-Type': mime },
  });
}

// ── userData 固定为 %APPDATA%/MusicDedup（与 migrate-data 脚本一致，dev/打包统一）─
app.setPath('userData', path.join(app.getPath('appData'), 'MusicDedup'));

// ── P0 回归路径：渲染进程可用的测试样本（只读信息，播放走 musicdedup://）──────
function getSampleFiles() {
  const base = path.join(__dirname, '..', '.p0-tmp', 'samples');
  return [
    { kind: 'FLAC', path: path.join(base, 'BarroomBallet.flac') },
    { kind: 'M4A',  path: path.join(base, 'sample.m4a') },
    { kind: 'MP3',  path: path.join(base, 'sample.mp3') },
  ].filter((s) => fs.existsSync(s.path));
}

// ── P1 客户端路径 ──────────────────────────────────────────────────────────
let _server = null;

// 幂等：注入 DB_PATH/HOST/PORT 后动态 import server.js，等待监听就绪。
// 必须动态 import——ESM 静态 import 先于 env 注入执行，而 server.js 模块顶层
// 即会打开 DB（getDB）并 app.listen，env 必须在加载前就位。
async function ensureServer() {
  if (_server) return _server;

  process.env.DB_PATH = path.join(app.getPath('userData'), 'musicdedup.db');
  // 不传 sourceDir，用 migrate-data 的脚本相对默认（仓库 data/）——app.getAppPath()
  // 在 `electron electron/main.js` 启动方式下解析到的不是仓库根，不可依赖；打包后
  // 该路径在 asar 内不存在，自动 no-op。
  const mig = migrateLegacyData({ targetDb: process.env.DB_PATH });
  if (mig.migrated) console.log(`[v2] 已从旧 data/ 搬迁数据库 → ${mig.target}`);
  else if (mig.reason === 'target-exists')
    console.log(`[v2] 数据库已存在，跳过搬迁: ${process.env.DB_PATH}`);
  else if (fs.existsSync(process.env.DB_PATH))
    console.log(`[v2] 无旧 data/ 库，沿用已存在库: ${process.env.DB_PATH}`);
  else console.log(`[v2] 无旧 data/ 库，使用全新库: ${process.env.DB_PATH}`);

  process.env.HOST = '127.0.0.1';
  process.env.PORT = '0';

  const { server } = await import('../server.js');
  await new Promise((r) => server.once('listening', r));
  _server = server;
  return server;
}

function createClientWindow() {
  const port = _server.address().port;
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'MusicDedup',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(`http://127.0.0.1:${port}`);
  return win;
}

// ── 启动 ──────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  protocol.handle('musicdedup', handleStreamRequest);

  if (isP0Verify) {
    // P0 回归套件：主进程跑验证 + P0 渲染页展示（原 P0 壳保留）
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

  // 默认：P1 客户端（内嵌 Express + 真实 UI）
  await ensureServer();
  console.log(`[v2-P1] 内嵌服务就绪: http://127.0.0.1:${_server.address().port}`);
  createClientWindow();
});

app.on('activate', () => {
  if (!isP0Verify && BrowserWindow.getAllWindows().length === 0) createClientWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
