// electron/fp-decode-pool.mjs — 声纹解码进程池（sidecar）
//
// 解码/Goertzel 在普通 Node 子进程里执行（Electron worker 线程内跑 WASM 解码性能
// 不稳定），由本池以固定并发 N 个一次性子进程执行（每进程解一个文件即退出，谁空补谁）。
// compute(filePath) 返回 Promise<computeFingerprint 结果>。并发上限由
// createDecodePool({concurrency}) 传入（scan-worker 按逻辑核数计算）。
//
// 子进程可执行体：
//   打包版 / dev Electron：process.execPath（app exe）+ ELECTRON_RUN_AS_NODE=1 退化纯 Node
//   独立 Node 测试（scan-abort-test）：process.execPath 就是 node，ELECTRON_RUN_AS_NODE 无副作用
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('fp-decode-cli.mjs', import.meta.url));

export function createDecodePool({ concurrency = 4 } = {}) {
  const cap = Math.max(1, concurrency | 0);
  let queue = [];
  let running = 0;
  let closed = false;
  const activeChildren = new Set(); // 在途子进程（close 时一并终止，防孤儿）

  function compute(filePath) {
    return new Promise((resolve, reject) => {
      queue.push({ filePath, resolve, reject });
      pump();
    });
  }

  function pump() {
    while (!closed && running < cap && queue.length) {
      const job = queue.shift();
      running++;
      spawnOne(job);
    }
  }

  function spawnOne(job) {
    const child = spawn(process.execPath, [cliPath, job.filePath], {
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    activeChildren.add(child);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      running--;
      if (err) job.reject(err);
      else {
        // stdout 可能混有调试日志（如 FP_DEBUG 的 computeFingerprint 内部计时），
        // JSON 是最后一行——取末行解析，容忍噪声。
        const lines = out.trim().split(/\r?\n/);
        let parsed = null;
        try { parsed = JSON.parse(lines[lines.length - 1]); } catch { /* fall through */ }
        if (parsed && parsed.error) job.reject(new Error(parsed.error));
        else if (parsed) job.resolve(parsed);
        else job.reject(new Error(`解码进程输出无法解析: ${out.slice(0, 80)}`));
      }
      pump();
    };
    child.on('error', (e) => finish(e));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`解码进程退出 code=${code}`)));
  }

  function close() {
    closed = true;
    for (const c of activeChildren) { try { c.kill(); } catch {} }
    activeChildren.clear();
    while (queue.length) queue.shift().reject(new Error('解码池已关闭'));
  }

  return { compute, close };
}
