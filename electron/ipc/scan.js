// electron/ipc/scan.js — 扫描域薄 broker（扫描隔离）
//
// 扫描的 8 步流水线在 electron/scan-worker.js（worker 线程）运行，主进程不跑扫描 CPU 活，
// 窗口其他功能（播放/导航/IPC 读库）不被占用。本模块职责：
//   1. 维护镜像 scanState（供 /api/scan/status 与 main.js sendScan）
//   2. 转发 worker 消息 → broadcast（send 注入的 webContents）
//   3. abort/pause/resume 控制位 → 更新镜像 + 转发 worker
//   4. worker 生命周期：spawn per-scan、done/error 后 settle + terminate
// 对外契约：routes（start/abort/pause/resume/status）+ setSend。
//
// 镜像同步规则：display 字段（phase/pct/message/level/subPct/groups/savings）以 worker
// 为准；控制位（paused/abortFlag/running）永远以 broker 镜像为准——worker 的 progress
// 载荷携带自身控制位且落后于 broker 的控制意图，直接覆盖会漂移。
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync, rmSync, readdirSync } from 'fs';
import { Worker } from 'node:worker_threads';
import { getDB, openDB } from '../../lib/db/index.js';
import { getAllSettings, setAppliedPickSettings } from '../../lib/db/settings.js';
import { detectFpcalc } from '../../lib/chromaprint-bridge.js';
import { getPhysicalCores } from '../cpuinfo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = getDB();

let scanState = { running: false, abortFlag: false, paused: false, phase: 'idle', pct: 0, message: '', startTime: null };
let send = () => {}; // 由 registerApi 注入（绑定窗口 webContents）
let activeWorker = null;
let settled = false; // 终态只广播一次（worker exit 在 terminate 后仍会触发，须防重）
let activeTempDb = null; // 本次扫描 worker 用的临时库副本路径（结束后合并回主库并删除）

const now = () => new Date().toLocaleTimeString([], { hour12: false });

// threads 语义：用户设置的声纹解码并发数（1~12，UI「同时处理文件数」），缺省 null=自动
//（worker 按逻辑核数计算 min(12, 逻辑核/2)）。meta 步骤仅用它作批大小（解析本身串行）。

export function setSend(fn) { send = fn; }

function broadcast(data) {
  // 关键：type 不能并入 scanState —— broadcast({type:'done', ...scanState}) 时若
  // scanState 已带 type:'progress'（被 Object.assign 污染），会把 done 覆盖成 progress，
  // 渲染进程的 onDone / 主进程 sendScan 的 scanRunning=false 全部失效。type 仅走事件载荷。
  const { type, ...rest } = data;
  Object.assign(scanState, rest);
  send({ ...data });
}

// ── 临时库（锁冲突修复）────────────────────────────────────────────
// 根因：node-sqlite3-wasm 不支持 WAL（PRAGMA journal_mode=WAL 静默回退 delete），主进程与
// worker 双连接在 DELETE 模式下读写互锁，busy_timeout=10s 是同步忙等 → 主进程冻结 +
// "database is locked" 崩溃。方案：worker 用主库的 VACUUM INTO 快照副本，
// 全程独享（与主进程零冲突）；结束后主进程单连接 ATTACH 合并回主库，再删临时库。
function snapshotDbForScan() {
  const dbDir = path.dirname(process.env.DB_PATH);
  const tmpPath = path.join(dbDir, `scan-tmp-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
  return tmpPath;
}

function cleanupTempDb(tmpPath) {
  if (!tmpPath) return;
  for (const p of [tmpPath, tmpPath + '-wal', tmpPath + '-shm', tmpPath + '-journal']) { try { rmSync(p, { force: true }); } catch {} }
  try { rmSync(tmpPath + '.lock', { recursive: true, force: true }); } catch {}
  if (activeTempDb === tmpPath) activeTempDb = null;
}

// 把 worker 写好的临时库合并回主库（主连接 ATTACH，单连接无争用）。
// temp 是主库快照 + 扫描全部写入，故 files/scraped_meta 整表 upsert；
// matcher 的 clearGroups 是全删重写，故组表整表替换（temp 即完整正确状态）。
function mergeTempDb(tmpPath) {
  if (!tmpPath || !existsSync(tmpPath)) return;
  // worker 已在 finally 关闭临时库连接；残留的 .lock 为陈旧锁（mkdir 未 rmdir），
  // 不清会让下方 ATTACH 报 database is locked。
  try { rmSync(tmpPath + '.lock', { recursive: true, force: true }); } catch {}
  try {
    db.exec(`ATTACH DATABASE '${tmpPath.replace(/'/g, "''")}' AS scan_tmp`);
    // REPLACE 语义 = DELETE+INSERT，可能触发 tag_snapshots 的 FK；合并保留全部 id 引用
    // 完整性，期间关闭 FK 校验（事务内不可改，须在 BEGIN 之前设置）。
    db.exec('PRAGMA foreign_keys=OFF');
    db.exec('BEGIN');
    db.exec('INSERT OR REPLACE INTO files SELECT * FROM scan_tmp.files');
    db.exec('DELETE FROM group_tracks; DELETE FROM dup_groups;');
    db.exec('INSERT INTO dup_groups SELECT * FROM scan_tmp.dup_groups');
    db.exec('INSERT INTO group_tracks SELECT * FROM scan_tmp.group_tracks');
    db.exec('INSERT OR REPLACE INTO scraped_meta SELECT * FROM scan_tmp.scraped_meta');
    db.exec('COMMIT');
    db.exec('PRAGMA foreign_keys=ON');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    db.exec('PRAGMA foreign_keys=ON');
    throw e;
  } finally {
    try { db.exec('DETACH scan_tmp'); } catch {}
  }
}

// ── 终态 ──────────────────────────────────────────────────────────────────
let doneMessage = ''; // worker 的最终完成消息（settle 的合并广播会覆盖 scanState.message，须先保存）

function settle() {
  if (settled) return;
  settled = true;
  // 先合并临时库（worker 已完成且关闭 temp 连接，此刻 ATTACH 无锁冲突），
  // 再广播 done——done 后前端 refreshStats 读到的是合并后的最新数据。
  if (activeTempDb) {
    broadcast({ type: 'progress', ...scanState, level: 'info', message: `[${now()}] 正在合并扫描结果...` });
    try {
      mergeTempDb(activeTempDb);
      cleanupTempDb(activeTempDb); // 合并成功才清理；失败保留临时库，下次扫描孤儿恢复兜底
    }
    catch (e) { console.log('[scan] 临时库合并失败，保留临时库供下次恢复：', e.message); }
  }
  scanState.running = false;
  scanState.paused = false;
  // 终态归一：phase 固定为 done/error/aborted（error 优先于 abort），否则"仅跑单步"
  // 或"中止"后 phase 会停在最后一个步骤名，前端进度区块永不收起、'已中止'标签不生效。
  if (scanState.phase !== 'error') scanState.phase = scanState.abortFlag ? 'aborted' : 'done';
  // 终态消息：abort 给出明确总结；正常 done 恢复 worker 的最后完成消息（不被合并广播覆盖）。
  if (scanState.abortFlag) {
    scanState.level = 'info';
    scanState.message = `[${now()}] 扫描已中止，已完成步骤的结果已保留`;
  } else if (doneMessage) {
    scanState.message = doneMessage;
  }
  broadcast({ type: 'done', ...scanState });
  if (activeWorker) { try { activeWorker.terminate(); } catch {} activeWorker = null; }
}

function onWorkerMessage(msg) {
  if (msg.type === 'start' || msg.type === 'progress') {
    const { paused, abortFlag, running, type, ...rest } = msg;
    Object.assign(scanState, rest); // 只合并 display 字段（type 不入镜像，防覆盖后续广播），控制位保留镜像
    // start 已由 startScanInWorker 广播过，worker 的 start 回执只更新镜像，不重复转发
    if (msg.type !== 'start') broadcast({ type: msg.type, ...scanState });
  } else if (msg.type === 'phase') {
    // 分阶段增量合并：每完成一个阶段，把该阶段成果合并进主库并广播 merged，
    // 渲染层据此刷新（"完成一个阶段，更新一个阶段"，扫描期间即可看到已完成的阶段数据）。
    // 合并完再放行 worker 进下一阶段（gatePhase 等待）。临时库此刻由 worker 持有但空闲，
    // 无写事务 → 无 .lock → ATTACH 只读零冲突；合并失败不影响 worker 继续，终态 settle 兜底。
    if (activeTempDb) {
      try { mergeTempDb(activeTempDb); }
      catch (e) { console.log('[scan] 分阶段合并失败：', e.message); }
    }
    broadcast({ type: 'merged', phase: msg.phase });
    activeWorker?.postMessage({ cmd: 'phaseContinue' });
  } else if (msg.type === 'done') {
    const { paused, abortFlag, running, type, ...rest } = msg;
    doneMessage = rest.message || ''; // 保存 worker 完成消息（合并广播前）
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
  // 否则任务进行中的关窗确认流程会一直等待、窗口无法正常退出。
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

// ── 启动（fire-and-forget：同步置 running → 快照 → spawn → 立即返回）─────────────
// 清理上次残留的临时库（app 在上次扫描合并前被关闭/崩溃会留下 scan-tmp-*.db；
// 单实例锁 + start 路由防并发，此刻无进行中扫描，均为陈旧残留）。
// 若残留库含比主库新的扫描结果（scan_time 更新）→ 先合并恢复，再清理——防止
// 停止/关闭时合并没有完成导致扫描数据（声纹/重复组）丢失。
function cleanupStaleTempDbs() {
  const dir = path.dirname(process.env.DB_PATH);
  try {
    const orphans = readdirSync(dir).filter(f => f.startsWith('scan-tmp-') && f.endsWith('.db')).sort();
    if (!orphans.length) return;
    console.log(`[scan] 检测到 ${orphans.length} 个上次扫描未合并的残留临时库`);
    const latest = path.join(dir, orphans[orphans.length - 1]);
    // 先清陈旧锁再探测：孤儿库的 .lock 是上次崩溃残留（此处无进行中扫描，必为陈旧），
    // 不清则 openDB 直接 database is locked → 恢复失败 → 还会被清理删除（数据再次丢失）。
    try { rmSync(latest + '.lock', { recursive: true, force: true }); } catch {}
    try {
      const o = openDB({ skipInit: true, skipPragma: true, path: latest });
      const orphMax = (o.get('SELECT MAX(scan_time) m FROM files') || { m: 0 }).m || 0;
      o.close();
      const mainMax = (db.get('SELECT MAX(scan_time) m FROM files') || { m: 0 }).m || 0;
      if (orphMax > mainMax) {
        console.log('[scan] 残留临时库含未入库的扫描结果，正在合并恢复...');
        mergeTempDb(latest);
        console.log('[scan] 已恢复上次扫描结果');
      }
    } catch (e) {
      console.log('[scan] 残留临时库恢复失败：', e.message);
    }
    for (const f of orphans) cleanupTempDb(path.join(dir, f));
  } catch { /* 目录不可读/不存在 */ }
}

function startScanInWorker(options) {
  // 同步先置 running（spawn 同步，postMessage 前已生效）→ 挡住并发 start
  scanState = { running: true, abortFlag: false, paused: false, phase: 'starting', pct: 0, level: 'info', message: `[${now()}] 准备中...`, startTime: Date.now() };
  settled = false;
  cleanupStaleTempDbs(); // 清上次残留临时库（快照前，防陈旧文件堆积）
  // 快照主库 → 临时库副本（worker 全程只读写副本，与主进程零锁冲突）
  let tempDbPath;
  try {
    tempDbPath = snapshotDbForScan();
    activeTempDb = tempDbPath;
  } catch (e) {
    console.log('[scan] 库快照失败：', e.message);
    scanState.phase = 'error';
    scanState.level = 'err';
    scanState.message = `[${now()}] 扫描库快照失败：${e.message}`;
    scanState.running = false;
    broadcast({ type: 'done', ...scanState });
    return;
  }
  let worker;
  try {
    // type:'module' 显式指定：打包后 worker 在 app.asar.unpacked/（该目录无 package.json，
    // type:module 判定会回退 CJS，顶层 import 直接 SyntaxError）。env 显式传 process.env
    // 保证 DB_PATH 到达 worker。
    worker = new Worker(path.join(__dirname, '..', 'scan-worker.js'), { type: 'module', env: process.env });
  } catch (e) {
    console.log('[scan] worker 启动失败：', e.message);
    cleanupTempDb(tempDbPath);
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
  worker.postMessage({ cmd: 'start', options: { ...options, tempDbPath } });
}

export const routes = [
  { method: 'POST', path: '/api/scan/start', handler: async (_p, _q, body) => {
    if (scanState.running) return { ok: false, error: '已有扫描进行中' };
    const s = getAllSettings(db);
    const dirs = s.scan_dirs || [], exclude = s.exclude_patterns || [];
    const threads = s.threads ? parseInt(s.threads, 10) : null, threshold = parseInt(s.threshold || '90');
    const durationTolerance = parseInt(s.duration_tolerance || '5');
    const smartScan = s.smart_scan !== false;
    const steps = body?.steps || ['enum', 'meta', 'basicMatch', 'fp', 'fpMatch', 'scrape', 'scrapeMatch'];
    const force = body?.force === true;
    const retryMissed = body?.retryMissed === true;
    if (steps.includes('enum') && !dirs.length) return { ok: false, error: '未配置扫描目录' };
    // 显式执行点：任何包含匹配/智能保留步骤的扫描都会把当前优先级固化为 applied 快照，
    // 之后的详情展示与放入回收站都读它——未执行前改优先级不影响任何已有结果（所见即所得）。
    if (steps.some(x => ['basicMatch', 'fpMatch', 'scrapeMatch', 'smartKeep'].includes(x))) {
      setAppliedPickSettings(db, { quality_tiers: s.quality_tiers, pick_tag_order: s.pick_tag_order });
    }
    const acoustidKey = s.acoustid_key || '';
    // fpcalc 在主进程预解析（worker 线程无 process.resourcesPath，打包版无法自行检测）；
    // 解析出的绝对路径传给 worker（computeChromaprint 内 detectFpcalc(绝对路径) 直命中）。
    let fpcalcPath = s.fpcalc_path || '';
    if (steps.includes('fp')) fpcalcPath = (await detectFpcalc(fpcalcPath)) || '';
    startScanInWorker({ dirs, exclude, threads, physicalCores: getPhysicalCores(), threshold, durationTolerance, smartScan, steps, force, retryMissed, acoustidKey, fpcalcPath });
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
