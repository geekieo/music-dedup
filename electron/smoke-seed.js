// electron/smoke-seed.js — 打包版冒烟种子：在隔离 userData 生成一个最小 WAV（1 秒静音）
// 并写入 files 表，让 /api/library 与 musicdedup:// 流式路径在空库下也能被验证。
// 仅 SMOKE_SEED=1 时由 main.js 调用（scripts/smoke-packaged.mjs 注入）；dev 冒烟用真实库、不种子。
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getDB } from '../lib/db/index.js';
import { upsertFileBasic } from '../lib/db/files.js';

export function seedSmokeLibrary(userData) {
  const dir = path.join(userData, 'smoke-seed');
  mkdirSync(dir, { recursive: true });
  const wav = path.join(dir, 'smoke-seed.wav');
  // 44 字节 WAV 头 + 1 秒 8kHz 16bit 单声道静音（Chromium 解码器必支持）
  const sr = 8000;
  const n = sr * 2; // 16bit → 2 字节/采样
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(1, 22); // 单声道
  b.writeUInt32LE(sr, 24);
  b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); // 块对齐
  b.writeUInt16LE(16, 34); // 位深
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  writeFileSync(wav, b);
  const st = statSync(wav);
  upsertFileBasic(getDB(), {
    path: wav,
    size: st.size,
    file_mtime: Math.floor(st.mtimeMs / 1000),
    file_ctime: Math.floor(st.ctimeMs / 1000),
    scan_time: Date.now(),
  });
}
