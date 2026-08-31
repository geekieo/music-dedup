// electron/match-worker.js — 声纹匹配相似度计算 worker（worker_thread）
//
// 与 fp-decode 的子进程方案不同：相似度是纯 JS 位运算，无需 WASM 解码，worker_thread
// 即可（子进程退出会触发 node-sqlite3-wasm 的 libuv 断言，见 match-pool 头注释）。
// 协议：
//   主→worker { type:'records', records:[{id,fingerprint,chromaprint_raw}] }  一次性注入指纹
//   主→worker { type:'job', jobId, maxOffset, spectralPairs:[[a,b]], cpPairs:[[a,b]] }
//   worker→主 { type:'result', jobId, spectral:{"a-b":sim}, cp:{"a-b":sim} } | {error}
// 只算相似度，不做并查集/阈值判定——合并与 union 决策留在主线程 matcher。
import { parentPort } from 'node:worker_threads';
import { fingerprintSimilarity, chromaprintSimilarity } from '../lib/fingerprint.js';

let records = null; // Map id → {fingerprint, chromaprint_raw}（prepare 时收到，消息有序先于 job）
function pairKey(a, b) { return a < b ? a + '-' + b : b + '-' + a; }

parentPort.on('message', (msg) => {
  if (msg.type === 'records') {
    records = new Map(msg.records.map(r => [r.id, r]));
  } else if (msg.type === 'job') {
    const { jobId, maxOffset = 0, spectralPairs = [], cpPairs = [] } = msg;
    const out = { type: 'result', jobId, spectral: {}, cp: {} };
    try {
      for (const [a, b] of spectralPairs) {
        const fa = records?.get(a), fb = records?.get(b);
        if (fa && fb && fa.fingerprint && fb.fingerprint) out.spectral[pairKey(a, b)] = fingerprintSimilarity(fa.fingerprint, fb.fingerprint, maxOffset);
      }
      for (const [a, b] of cpPairs) {
        const fa = records?.get(a), fb = records?.get(b);
        if (fa && fb && fa.chromaprint_raw && fb.chromaprint_raw) out.cp[pairKey(a, b)] = chromaprintSimilarity(fa.chromaprint_raw, fb.chromaprint_raw, maxOffset);
      }
    } catch (e) {
      out.error = (e && e.message) || String(e);
    }
    parentPort.postMessage(out);
  }
});
