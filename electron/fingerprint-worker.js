// electron/fingerprint-worker.js — worker 线程：跑 computeFingerprint（读文件 + audio-decode + Goertzel）
//
// P5 修复"扫描时窗口未响应"：audio-decode 在主进程线程同步解码，单个 ~100MB FLAC 会阻塞
// 事件循环 1~2.5s，指纹阶段 2754 个文件连续解码 → 主进程消息泵长期不泵 → Windows 标记
// 窗口"未响应"、拖动卡死。把整个 computeFingerprint 挪到本 worker，主进程只发路径等结果。
import { parentPort } from 'node:worker_threads';

const { computeFingerprint } = await import('../lib/fingerprint.js');

parentPort.on('message', async (msg) => {
  if (msg.cmd !== 'compute') return;
  // computeFingerprint 内部已 catch 所有异常，返回 { fingerprint, duration, method }
  const result = await computeFingerprint(msg.path);
  parentPort.postMessage({ id: msg.id, result });
});
