// electron/ipc/scan.js — 扫描域薄 broker（P5 扫描隔离）
//
// 扫描的 8 步流水线整体移入 electron/scan-worker.js（worker 线程），主进程不再跑任何
// 扫描 CPU 活——窗口其他功能（播放/导航/IPC 读库）不再被占用。本模块职责：
//   1. 维护镜像 scanState（供 /api/scan/status 与 main.js sendScan）
//   2. 转发 worker 消息 → broadcast（send 注入的 webContents）
//   3. abort/pause/resume 控制位 → 更新镜像 + 转发 worker
//   4. worker 生命周期：spawn per-scan、done/error 后 settle + terminate
// 对外契约不变：routes（start/abort/pause/resume/status）+ setSend。
//
// 镜像同步规则：display 字段（phase/pct/message/level/subPct/groups/savings）以 worker
// 为准；控制位（paused/abortFlag/running）永远以 broker 镜像为准——worker 的 progress
// 载荷携带自身控制位且落后于 broker 的控制意图，直接覆盖会漂移。
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { Worker } from 'node:worker_threads';
import { getDB } from '../../lib/db/index.js';
import { getAllSettings } from '../../lib/db/settings.js';
import { detectFpcalc } from '../../lib/chromaprint-bridge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = getDB();

let scanState = { running: false, abortFlag: false, paused: false, phase: 'idle', pct: 0, message: '', startTime: null };
let send = () => {}; // 由 registerApi 注入（绑定窗口 webContents）
let activeWorker = null;
let settled = false; // 终态只广播一次（worker exit 在 terminate 后仍会触发，须防重）

const now = () => new Date().toLocaleTimeString([], { hour12: false });

// threads 语义：扫描在单 worker 线程上，threads 是并发批大小（异步 I/O 交叠 + 并发读入
// 内存的文件数），不并行多核、不影响速度。默认按核心数自适应（封顶 8 防大文件库并发读入
// 的内存尖峰）：低端机（2-4 核）自动落到 2-4，内存峰值随之减半以上；用户手动设置的优先。
const DEFAULT_THREADS = Math.min(8, Math.max(1, os.cpus().length));

export function setSend(fn) { send = fn; }

function broadcast(data) {
  // 关键：type 不能并入 scanState —— broadcast({type:'done', ...scanState}) 时若
  // scanState 已带 type:'progress'（被 Object.assign 污染），会把 done 覆盖成 progress，
  // 渲染进程的 onDone / 主进程 sendScan 的 scanRunning=false 全部失效（P5 联调复现：
  // "扫描后重复组不刷新""关闭按钮始终最小化到托盘"同源）。type 仅走事件载荷。
  const { type, ...rest } = data;
  Object.assign(scanState, rest);
  send({ ...data });
}

// ── 终态 ──────────────────────────────────────────────────────────────────
function settle() {
  if (settled) return;
  settled = true;
  scanState.running = false;
  scanState.paused = false;
  // 终态归一：phase 固定为 done/error/aborted（error 优先于 abort），否则"仅跑单步"
  // 或"中止"后 phase 会停在最后一个步骤名，前端进度区块永不收起、'已中止'标签不生效。
  if (scanState.phase !== 'error') scanState.phase = scanState.abortFlag ? 'aborted' : 'done';
  broadcast({ type: 'done', ...scanState });
  if (activeWorker) { try { activeWorker.terminate(); } catch {} activeWorker = null; }
}

function onWorkerMessage(msg) {
  if (msg.type === 'start' || msg.type === 'progress') {
    const { paused, abortFlag, running, ...rest } = msg;
    Object.assign(scanState, rest); // 只合并 display 字段，控制位保留镜像
    broadcast({ type: msg.type, ...scanState });
  } else if (msg.type === 'done') {
    const { paused, abortFlag, running, ...rest } = msg;
    Object.assign(scanState, rest);
    settle();
  } else if (msg.type === 'error') {
    scanState.phase = 'error';
    scanState.level = 'err';
    scanState.message = `[${now()}] 扫描进程异常：${msg.message || ''}`;
    settle();
  }
}

function onWorkerError(e) {
  // 广播 type:'done'（而非 progress）：main.js sendScan 靠它复位 scanRunning，
  // 否则关窗=托盘行为会一直保持、托盘退出流程异常。
  console.log('[scan] worker 错误：', e && e.message);
  if (!settled) {
    scanState.phase = 'error';
    scanState.level = 'err';
    scanState.message = `[${now()}] 扫描进程异常：${(e && e.message) || ''}`;
    settle();
  }
}

function onWorkerExit(code) {
  if (!settled) {
    scanState.phase = 'error';
    scanState.level = 'err';
    scanState.message = `[${now()}] 扫描进程异常退出（code ${code}）`;
    settle();
  }
}

// ── 启动（fire-and-forget：同步置 running → spawn → 立即返回）─────────────
function startScanInWorker(options) {
  // 同步先置 running（spawn 同步，postMessage 前已生效）→ 挡住并发 start
  scanState = { running: true, abortFlag: false, paused: false, phase: 'starting', pct: 0, level: 'info', message: `[${now()}] 准备中...`, startTime: Date.now() };
  settled = false;
  let worker;
  try {
    // type:'module' 显式指定：打包后 worker 在 app.asar.unpacked/（该目录无 package.json，
    // type:module 判定会回退 CJS，顶层 import 直接 SyntaxError）。env 显式传 process.env
    // 保证 DB_PATH 到达 worker。
    worker = new Worker(path.join(__dirname, '..', 'scan-worker.js'), { type: 'module', env: process.env });
  } catch (e) {
    console.log('[scan] worker 启动失败：', e.message);
    scanState.phase = 'error';
    scanState.level = 'err';
    scanState.message = `[${now()}] 扫描进程启动失败：${e.message}`;
    scanState.running = false;
    broadcast({ type: 'done', ...scanState });
    return;
  }
  activeWorker = worker;
  worker.on('message', onWorkerMessage);
  worker.on('error', onWorkerError);
  worker.on('exit', onWorkerExit);
  broadcast({ type: 'start', ...scanState });
  worker.postMessage({ cmd: 'start', options });
}

export const routes = [
  { method: 'POST', path: '/api/scan/start', handler: async (_p, _q, body) => {
    if (scanState.running) return { ok: false, error: '已有扫描进行中' };
    const s = getAllSettings(db);
    const dirs = s.scan_dirs || [], exclude = s.exclude_patterns || [];
    const threads = parseInt(s.threads) || DEFAULT_THREADS, threshold = parseInt(s.threshold || '90');
    const durationTolerance = parseInt(s.duration_tolerance || '5');
    const smartScan = s.smart_scan !== false;
    const steps = body?.steps || ['enum', 'meta', 'basicMatch', 'fp', 'fpMatch', 'scrape', 'scrapeMatch'];
    const force = body?.force === true;
    const retryMissed = body?.retryMissed === true;
    if (steps.includes('enum') && !dirs.length) return { ok: false, error: '未配置扫描目录' };
    const acoustidKey = s.acoustid_key || '';
    // fpcalc 在主进程预解析（worker 线程无 process.resourcesPath，打包版无法自行检测）；
    // 解析出的绝对路径传给 worker（computeChromaprint 内 detectFpcalc(绝对路径) 直命中）。
    let fpcalcPath = s.fpcalc_path || '';
    if (steps.includes('fp')) fpcalcPath = (await detectFpcalc(fpcalcPath)) || '';
    startScanInWorker({ dirs, exclude, threads, threshold, durationTolerance, smartScan, steps, force, retryMissed, acoustidKey, fpcalcPath });
    return { ok: true, message: '扫描已启动', steps };
  } },
  { method: 'POST', path: '/api/scan/abort', handler: () => {
    if (!scanState.running) return { ok: false };
    scanState.abortFlag = true;
    scanState.paused = false;
    broadcast({ type: 'progress', ...scanState });
    // abort 是软停止：不 terminate，让 worker 走检查点自行收尾（close DB + 上送 done）
    activeWorker?.postMessage({ cmd: 'abort' });
    return { ok: true };
  } },
  { method: 'POST', path: '/api/scan/pause', handler: () => {
    if (!scanState.running || scanState.abortFlag) return { ok: false };
    scanState.paused = true;
    broadcast({ type: 'progress', ...scanState, level: 'info', message: `[${now()}] 已暂停 · 点击继续以恢复` });
    activeWorker?.postMessage({ cmd: 'pause' });
    return { ok: true };
  } },
  { method: 'POST', path: '/api/scan/resume', handler: () => {
    if (!scanState.running || !scanState.paused) return { ok: false };
    scanState.paused = false;
    broadcast({ type: 'progress', ...scanState, level: 'info', message: `[${now()}] 已恢复` });
    activeWorker?.postMessage({ cmd: 'resume' });
    return { ok: true };
  } },
  { method: 'GET', path: '/api/scan/status', handler: () => ({ ok: true, data: scanState }) },
];
