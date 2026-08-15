// electron/fp-worker.js — 声纹计算 worker 池（主进程侧管理）
//
// P5 修复"扫描时窗口未响应"：指纹阶段的 audio-decode 是同步 CPU 大户，在主进程线程跑会
// 长时间阻塞事件循环（单个 ~100MB FLAC 解码 1~2.5s × 全库连续解码）。把 computeFingerprint
// 委托给 worker 线程（electron/fingerprint-worker.js），主进程保持响应（拖动窗口/点击正常）。
//
// 安全设计：
//   - worker 启动失败 / 中途崩溃（error/exit）→ healthy=false，在途请求全部回退本地计算，
//     后续调用也走本地 —— 扫描绝不停摆，只是降级回主进程解码。
//   - 每个请求 id 对应一个 pending；worker 串行处理（postMessage 队列天然有序）。
import { Worker } from 'node:worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeFingerprint as localCompute } from '../lib/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 启动指纹 worker。返回 { compute(filePath) → Promise<result>, terminate() }。
 */
export function startFpWorker() {
  let worker = null;
  try {
    worker = new Worker(path.join(__dirname, 'fingerprint-worker.js'));
  } catch (e) {
    console.log('[fp-worker] 启动失败，回退主进程计算：', e.message);
    worker = null;
  }

  let healthy = !!worker;
  const pending = new Map(); // id → { resolve, path }
  let nextId = 0;

  function failAll() {
    healthy = false;
    for (const [, p] of pending) {
      // worker 崩溃 → 在途文件回退主进程本地计算（保证扫描不中断）
      localCompute(p.path).then(p.resolve, () => p.resolve({ fingerprint: null, duration: 0, method: 'metadata' }));
    }
    pending.clear();
  }

  if (worker) {
    worker.on('message', (msg) => {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result); }
    });
    worker.on('error', (e) => { console.log('[fp-worker] 错误，回退主进程计算：', e.message); failAll(); });
    worker.on('exit', () => { healthy = false; failAll(); });
  }

  async function compute(filePath) {
    if (!healthy || !worker) return localCompute(filePath);
    return new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, { resolve, path: filePath });
      try {
        worker.postMessage({ cmd: 'compute', id, path: filePath });
      } catch (e) {
        pending.delete(id);
        resolve(localCompute(filePath));
      }
    });
  }

  function terminate() {
    if (worker) { try { worker.terminate(); } catch {} }
    worker = null;
    healthy = false;
  }

  return { compute, terminate };
}
