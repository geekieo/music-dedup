// electron/main.js — v2 主进程入口（P0 技术验证版）
//
// P0 目标：验证客户端化的核心技术前提全部可用，即"一个能读 FLAC 标签、
// 播放一段音频的最小 Electron 壳"。本文件承载：
//   1. 自定义流媒体协议 musicdedup:// —— 替代 v1 的 HTTP Range 流式接口
//   2. 启动时在主进程内跑一遍 P0 验证套件（electron/p0/verify.js），
//      结果经 IPC 交给渲染进程展示，同时打印到主进程终端便于核对
//
// 后续演进：P1 在此骨架内嵌 Express；P2 改为逐路由 IPC 化（main/ipc/*.js）。
// 该文件刻意保持"壳"的形态，业务验证逻辑全部收敛在 p0/verify.js。

// 通过 createRequire 走 CJS 的 require() 解析 electron 内置模块 —— 这是 ESM 主进程里
// 最稳妥的写法：Electron 会把 require('electron') 拦截为真正的 API 对象（node_modules
// 里的 electron 包只是个 CLI/路径引导 stub，import 直接拿到的是路径字符串而非 API）。
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, protocol } = require('electron');
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import { fileURLToPath } from 'url';

import { runVerification } from './p0/verify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// P0 自测需要渲染进程无手势直接 play()；真实 v2 中播放器走用户手势，此开关届时移除
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ── 自定义流媒体协议 musicdedup://stream/<encodedPath> ────────────────────
// 语义与 v1 server.js 的 /api/files/:id/stream 完全一致：支持 HTTP Range
// （<audio> 的 seek/scrub 依赖 206），本地文件由主进程直接读盘流式返回，
// 不经过 IPC 序列化。standard+stream+secure 特权对应 v1 里浏览器对音频
// Range 请求的能力。
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

// ── 窗口 ──────────────────────────────────────────────────────────────────
function createWindow() {
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
  return win;
}

// ── 渲染进程可用的测试样本（只读信息，播放通过 musicdedup:// 协议） ──────
function getSampleFiles() {
  const base = path.join(__dirname, '..', '.p0-tmp', 'samples');
  return [
    { kind: 'FLAC', path: path.join(base, 'BarroomBallet.flac') },
    { kind: 'M4A',  path: path.join(base, 'sample.m4a') },
    { kind: 'MP3',  path: path.join(base, 'sample.mp3') },
  ].filter((s) => fs.existsSync(s.path));
}

// ── 启动 ──────────────────────────────────────────────────────────────────
let cachedVerify = null;

app.whenReady().then(async () => {
  protocol.handle('musicdedup', handleStreamRequest);

  // 启动时跑一次验证并缓存：结果同时用于主进程日志与渲染进程展示
  cachedVerify = await runVerification();
  for (const r of cachedVerify) {
    console.log(`[P0] ${r.pass ? 'PASS' : 'FAIL'}  ${r.label}  —  ${r.detail}`);
  }
  const passed = cachedVerify.filter((r) => r.pass).length;
  console.log(`[P0] 验证完成：${passed}/${cachedVerify.length} 通过`);

  ipcMain.handle('p0:verify', () => cachedVerify);
  ipcMain.handle('p0:samples', () => getSampleFiles());

  // 渲染进程的流式播放自测结果：打印到主进程日志；P0_AUTORUN=1 时自动退出
  // （便于无人工介入地验证整条链路后干净退出）
  ipcMain.on('p0:stream-result', (_e, r) => {
    console.log(`[P0] ${r && r.pass ? 'PASS' : 'FAIL'}  自定义协议流式播放  —  ${r && r.detail}`);
    if (process.env.P0_AUTORUN) setTimeout(() => app.quit(), 800);
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
