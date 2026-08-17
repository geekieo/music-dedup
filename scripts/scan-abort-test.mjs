// scripts/scan-abort-test.mjs — 扫描中止/暂停响应与 fpcalc 流水线的 e2e 回归
//
// 覆盖：fpcalc 子进程中止响应（killActiveFpcalc）、中止管道、暂停→恢复继续、fp 全流水线。
// 不碰生产数据：全部在 os.tmpdir() 临时目录完成，结束自动清理。
// 用法：node scripts/scan-abort-test.mjs
//
//   阶段1：fp 全流水线正确性（Goertzel + fpcalc×2）——校验 chromaprint 落库
//     （smoke/p0 不覆盖 fpcalc 流水线）。
//   阶段2：多文件 fp 扫描中止，断言 abort→done 提前停止。
//   阶段3：暂停→恢复，断言暂停期间无进度、恢复后继续产出。
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync, statSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { openDB } from '../lib/db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const fpcalcPath = path.join(repoRoot, 'fpcalc.exe');
const workerPath = path.join(repoRoot, 'electron', 'scan-worker.js');

if (!existsSync(fpcalcPath)) {
  console.error(`[scan-abort-test] 未找到 fpcalc：${fpcalcPath}`);
  process.exit(1);
}

// ── WAV 生成（PCM mono 16-bit 44.1kHz；freq=0 → 静音）──────────────────────
function writeWav(filePath, durationSec, freq = 440) {
  const sr = 44100;
  const n = Math.floor(durationSec * sr);
  const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let off = 44;
  if (freq) {
    for (let i = 0; i < n; i++) {
      const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000);
      buf.writeInt16LE(v, off); off += 2;
    }
  }
  writeFileSync(filePath, buf);
}

// ── worker 包装：fire-and-forget 直连（绕过 broker，聚焦 worker 行为）──────────
function spawnWorker(dbPath, options, { onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { type: 'module', env: process.env });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('scan worker 超时')); }, 120_000);
    worker.on('message', (msg) => {
      if (msg.type === 'done') { clearTimeout(timer); worker.terminate(); resolve(msg); }
      else if (msg.type === 'error') { clearTimeout(timer); worker.terminate(); reject(new Error('worker error: ' + (msg.message || ''))); }
      else if (onProgress) onProgress(msg);
    });
    worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    worker.postMessage({ cmd: 'start', options: { ...options, tempDbPath: dbPath } });
  });
}

// 阶段2专用：fp 阶段开始后 abortDelayMs 再 abort，返回 abort→done 延迟
//（多文件 fp 流水线持续 ~5s+，abort 落在线程中在跑的批上——批内含多个 fpcalc 子进程，
//  中止路径会 kill 它们；done 若在 <3s 内到达即证明「提前停止」而非等自然完成）
function spawnAndAbort(dbPath, options, abortDelayMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { type: 'module', env: process.env });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('abort 测试超时')); }, 120_000);
    let abortSentAt = null, doneAt = null;
    let armed = false;
    worker.on('message', (msg) => {
      if (msg.type === 'done') {
        doneAt = Date.now();
        clearTimeout(timer); worker.terminate();
        resolve({ msg, latency: abortSentAt ? doneAt - abortSentAt : null, abortSentAt });
      } else if (msg.type === 'error') {
        clearTimeout(timer); worker.terminate();
        reject(new Error('worker error: ' + (msg.message || '')));
      } else if (msg.phase === 'fp' && !armed) {
        // fp 阶段已开始（批循环在进行，fpcalc 子进程在跑）——延时后 abort
        armed = true;
        setTimeout(() => {
          abortSentAt = Date.now();
          worker.postMessage({ cmd: 'abort' });
        }, abortDelayMs);
      }
    });
    worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    worker.postMessage({ cmd: 'start', options: { ...options, tempDbPath: dbPath } });
  });
}

// 阶段3专用：fp 阶段开始后 pauseDelayMs 暂停、500ms 后恢复，统计暂停前/中/后进度事件。
// 断言：暂停期间无进度事件（pause 真正阻塞了批边界）、恢复后继续产出事件（worker 未挂起）。
function spawnPauseResume(dbPath, options, pauseDelayMs = 300) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath, { type: 'module', env: process.env });
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('pause/resume 测试超时')); }, 60_000);
    const events = { before: 0, during: 0, after: 0 };
    let paused = false, resumedAt = null, armed = false;
    worker.on('message', (msg) => {
      if (msg.type === 'done') {
        clearTimeout(timer); worker.terminate();
        resolve({ ...events, done: msg });
      } else if (msg.type === 'error') {
        clearTimeout(timer); worker.terminate();
        reject(new Error('worker error: ' + (msg.message || '')));
      } else if (msg.phase === 'fp') {
        if (!paused) events.before++;
        else if (!resumedAt) events.during++;
        else events.after++;
        if (!armed) {
          armed = true;
          setTimeout(() => {
            worker.postMessage({ cmd: 'pause' });
            paused = true;
            setTimeout(() => { resumedAt = Date.now(); worker.postMessage({ cmd: 'resume' }); }, 500);
          }, pauseDelayMs);
        }
      }
    });
    worker.on('error', (e) => { clearTimeout(timer); reject(e); });
    worker.postMessage({ cmd: 'start', options: { ...options, tempDbPath: dbPath } });
  });
}
function makeDb(dbPath, rows) {
  const db = openDB({ path: dbPath });
  for (const r of rows) {
    const cols = ['path', 'size', 'file_mtime', 'file_ctime', 'scan_time', 'title', 'duration'];
    const vals = [r.path, statSync(r.path).size, null, null, Date.now(), r.title || 'test', r.duration ?? 3];
    if (r.fingerprint) { cols.push('fingerprint', 'fp_extracted_at'); vals.push(r.fingerprint, Date.now()); }
    db.run(`INSERT INTO files (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, vals);
  }
  db.close();
}

const tmp = mkdtempSync(path.join(tmpdir(), 'md-scan-abort-'));
let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[scan-abort-test] ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

try {
  // ── 阶段1：fp 全流水线正确性（execP 重写回归）────────────────────────────
  const small = path.join(tmp, 'small.wav');
  writeWav(small, 3, 440);
  const db1 = path.join(tmp, 't1.db');
  makeDb(db1, [{ path: small, duration: 3 }]);
  const done1 = await spawnWorker(db1, { steps: ['fp'], fpcalcPath, smartScan: true, threads: 2 });
  check('阶段1 done 到达（phase=' + done1.phase + '）', done1.type === 'done' && !done1.abortFlag);
  const v1 = openDB({ path: db1 });
  const row1 = v1.get('SELECT fingerprint, chromaprint, chromaprint_raw FROM files WHERE id=1');
  v1.close();
  check('阶段1 chromaprint 已写入', !!(row1 && row1.chromaprint && row1.chromaprint_raw), row1 ? `fp=${String(row1.fingerprint).slice(0, 20)}… cp=${String(row1.chromaprint).slice(0, 24)}… raw=${String(row1.chromaprint_raw).length} 项` : 'row 缺失');

  // ── 阶段2：中止提前停止 ────────────────────────────────────────────────
  // 150 个小 WAV → fp 步骤持续数秒；fp 阶段开始后 1.5s 中止，批内含多个在跑的 fpcalc
  // 子进程，中止路径 kill 它们，done 应 < 3s 到达（早于自然完成）。
  const N = 150;
  console.log(`[scan-abort-test] 生成 ${N} 个 3s WAV…`);
  const wavs = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(tmp, `f${String(i).padStart(3, '0')}.wav`);
    writeWav(f, 3, 200 + (i % 500));
    wavs.push(f);
  }
  const db2 = path.join(tmp, 't2.db');
  makeDb(db2, wavs.map((p, i) => ({ path: p, title: `tone ${i}`, duration: 3 })));
  const { msg: done2, latency } = await spawnAndAbort(db2, { steps: ['fp'], fpcalcPath, smartScan: true, threads: 8 }, 1500);
  check('阶段2 abort→done 延迟 < 3s（提前停止）', latency !== null && latency < 3000, latency === null ? 'done 在 abort 前已到达（fp 流水线过短，测试无效）' : `${latency}ms`);
  check('阶段2 终态标记 aborted', done2.abortFlag === true && done2.running === false, `abortFlag=${done2.abortFlag} running=${done2.running} phase=${done2.phase}`);

  // ── 阶段3：暂停→恢复后 worker 是否继续产出进度 ──────────────────────────
  // 120 个小 WAV、fp 步骤持续 ~2-3s；fp 开始 300ms 后暂停 500ms 再恢复。
  // 若恢复后无更多进度事件 → worker 挂起；若暂停期间有事件 → 暂停未生效。
  const N3 = 120;
  const wavs3 = [];
  for (let i = 0; i < N3; i++) {
    const f = path.join(tmp, `p${String(i).padStart(3, '0')}.wav`);
    writeWav(f, 3, 300 + (i % 400));
    wavs3.push(f);
  }
  const db3 = path.join(tmp, 't3.db');
  makeDb(db3, wavs3.map((p, i) => ({ path: p, title: `tone ${i}`, duration: 3 })));
  const p3 = await spawnPauseResume(db3, { steps: ['fp'], fpcalcPath, smartScan: true, threads: 8 }, 300);
  check('阶段3 暂停期间无进度事件（pause 生效）', p3.during === 0, `before=${p3.before} during=${p3.during} after=${p3.after}`);
  check('阶段3 恢复后继续产出进度（worker 未挂起）', p3.after > 0, `before=${p3.before} during=${p3.during} after=${p3.after} phase=${p3.done && p3.done.phase}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[scan-abort-test] ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
