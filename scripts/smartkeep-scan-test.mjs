// scripts/smartkeep-scan-test.mjs — 智能保留 worker 步骤端到端回归
//
// 验证：真实扫描（enum→meta→basicMatch→smartKeep）经 worker 跑完后——
//   1. /api/scan/start 主进程写入 applied 快照键；
//   2. smartKeep 阶段有 merged 广播；
//   3. 主库组 smart_keep_file_id 已按级联写入（非空）。
// 不碰生产数据：临时目录建主库 + 生成小 WAV。用法：node scripts/smartkeep-scan-test.mjs
import { createRequire } from 'module';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// ── WAV 生成（同 phase-merge 测试：PCM mono 16-bit 44.1kHz，带 INAM/IART 标签）──
function writeWav(filePath, durationSec, { title = null, artist = null, freq = 440 } = {}) {
  const sr = 44100, n = Math.floor(durationSec * sr), dataSize = n * 2;
  const chunks = [];
  const wfmt = Buffer.alloc(16);
  wfmt.writeUInt16LE(1, 0); wfmt.writeUInt16LE(1, 2); wfmt.writeUInt32LE(sr, 4);
  wfmt.writeUInt32LE(sr * 2, 8); wfmt.writeUInt16LE(2, 12); wfmt.writeUInt16LE(16, 14);
  chunks.push(['fmt ', wfmt]);
  const info = Buffer.alloc(0);
  const sub = [];
  if (title) { const t = Buffer.from(title, 'latin1'); sub.push([Buffer.from('INAM'), t]); }
  if (artist) { const a = Buffer.from(artist, 'latin1'); sub.push([Buffer.from('IART'), a]); }
  if (sub.length) {
    const body = Buffer.concat(sub.map(([id, d]) => {
      const h = Buffer.alloc(8);
      id.copy(h, 0); h.writeUInt32LE(d.length, 4);
      return Buffer.concat([h, d, d.length % 2 ? Buffer.from([0]) : Buffer.alloc(0)]);
    }));
    const listBody = Buffer.concat([Buffer.from('INFO'), body]);
    const lh = Buffer.alloc(8); Buffer.from('LIST').copy(lh, 0); lh.writeUInt32LE(listBody.length, 4);
    chunks.push([null, Buffer.concat([lh, listBody])]);
  }
  const data = Buffer.alloc(dataSize);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / sr) * 12000);
    data.writeInt16LE(v, off); off += 2;
  }
  chunks.push(['data', data]);
  const body = Buffer.concat(chunks.map(([id, d]) => {
    if (!id) return d;
    const h = Buffer.alloc(8);
    Buffer.from(id, 'latin1').copy(h, 0); h.writeUInt32LE(d.length, 4);
    return Buffer.concat([h, d]);
  }));
  const head = Buffer.alloc(12);
  Buffer.from('RIFF').copy(head, 0); head.writeUInt32LE(36 + body.length, 4); Buffer.from('WAVE').copy(head, 8);
  writeFileSync(filePath, Buffer.concat([head, body]));
}

const tmp = mkdtempSync(path.join(tmpdir(), 'md-smartkeep-scan-'));
const scanDir = path.join(tmp, 'tracks');
mkdirSync(scanDir, { recursive: true });
writeWav(path.join(scanDir, 'song-dup-a.wav'), 3, { title: 'Song Dup', artist: 'The Artist' });
writeWav(path.join(scanDir, 'song-dup-b.wav'), 3, { title: 'Song Dup', artist: 'The Artist', freq: 442 }); // 同歌名同歌手同时长 → 重复对

const mainDb = path.join(tmp, 'musicdedup.db');
process.env.DB_PATH = mainDb; // 须早于 ipc/scan.js 的模块级 getDB()

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[smartkeep-scan] ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

try {
  const { openDB } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'index.js')).href);
  const db = openDB();
  db.run("UPDATE settings SET value=? WHERE key='scan_dirs'", [JSON.stringify([scanDir])]);
  db.close();

  const { setSend, routes } = await import(pathToFileURL(path.join(repoRoot, 'electron', 'ipc', 'scan.js')).href);
  const events = [];
  setSend((d) => events.push(d));

  const start = routes.find(r => r.method === 'POST' && r.path === '/api/scan/start');
  const r = await start.handler({}, {}, { steps: ['enum', 'meta', 'basicMatch', 'smartKeep'] });
  check('scan/start 返回 ok', r.ok, r.error || '');

  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (events.some(e => e.type === 'done' || e.type === 'error')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const types = events.map(e => e.type);
  check('收到 done', types.includes('done'), '事件: ' + [...new Set(types)].join(','));
  const err = events.find(e => e.type === 'error');
  if (err) console.log('[smartkeep-scan] worker error:', err.message);

  const merged = events.filter(e => e.type === 'merged').map(e => e.phase);
  check('smartKeep 阶段有 merged 广播', merged.includes('smartKeep'), 'merged: ' + merged.join(' → '));

  // 主库：applied 快照键已由 /api/scan/start 写入；组 smart_keep_file_id 已按级联写入
  const m = openDB({ path: mainDb, skipInit: true });
  const aq = m.get("SELECT value FROM settings WHERE key='quality_tiers_applied'");
  const ap = m.get("SELECT value FROM settings WHERE key='pick_tag_order_applied'");
  check('applied 快照键已写入', aq !== undefined && ap !== undefined, `aq=${JSON.stringify(aq && aq.value)} ap=${JSON.stringify(ap && ap.value)}`);
  const smart = m.get('SELECT smart_keep_file_id FROM dup_groups WHERE resolved=0');
  check('主库组 smart_keep_file_id 已写入（非空）', smart && smart.smart_keep_file_id != null, `smart=${smart && smart.smart_keep_file_id}`);
  m.close();

  const leftovers = readdirSync(tmp).filter(f => f.startsWith('scan-tmp-'));
  check('临时库已清理', leftovers.length === 0, '残留: ' + leftovers.join(','));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[smartkeep-scan] ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
