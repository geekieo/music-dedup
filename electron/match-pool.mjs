// electron/match-pool.mjs — 声纹匹配相似度计算 worker 池（worker_thread）
//
// 并发上限由 createMatchPool({concurrency}) 传入（scan-worker 复用 decodeConcurrency，
// 即设置页「同时处理文件数」）。worker 不碰库：指纹记录由主线程 prepare 注入，配对经
// computeShard 分发；close() 幂等 terminate 所有 worker（finally/中止均可调用）。
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

const workerPath = fileURLToPath(new URL('match-worker.js', import.meta.url));

export function createMatchPool({ concurrency = 1 } = {}) {
  const cap = Math.max(1, concurrency | 0);
  const workers = [];
  const idle = [];
  const pending = new Map(); // jobId → {resolve, reject}
  let jobSeq = 0;
  let closed = false;

  function spawn() {
    const w = new Worker(workerPath, { type: 'module' });
    w._busy = null; // 当前处理的任务 jobId
    w.on('message', (msg) => {
      if (msg.type !== 'result') return;
      const p = pending.get(msg.jobId);
      pending.delete(msg.jobId);
      w._busy = null;
      if (p) { if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg); }
      idle.push(w);
    });
    w.on('error', () => { /* worker 异常：其任务在 exit 统一拒绝 */ });
    w.on('exit', () => {
      if (w._busy != null) {
        const p = pending.get(w._busy);
        pending.delete(w._busy);
        if (p) p.reject(new Error('匹配 worker 意外退出'));
      }
      const i = idle.indexOf(w); if (i >= 0) idle.splice(i, 1);
      const j = workers.indexOf(w); if (j >= 0) workers.splice(j, 1);
    });
    workers.push(w);
    idle.push(w);
  }

  function prepare(records) {
    for (const w of workers) w.postMessage({ type: 'records', records });
  }

  function computeShard(job) {
    return new Promise((resolve, reject) => {
      const jobId = ++jobSeq;
      pending.set(jobId, { resolve, reject });
      enqueue(job, jobId);
    });
  }

  function enqueue(job, jobId) {
    const w = idle.shift();
    if (w) {
      w._busy = jobId;
      w.postMessage({ type: 'job', jobId, ...job });
    } else {
      setTimeout(() => enqueue(job, jobId), 0); // 分片数≤并发，正常不会走到
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const w of workers) { try { w.terminate(); } catch {} }
    workers.length = 0;
    idle.length = 0;
    for (const [, p] of pending) p.reject(new Error('匹配池已关闭'));
    pending.clear();
  }

  for (let i = 0; i < cap; i++) spawn();

  return { computeShard, prepare, close, concurrency: cap };
}
