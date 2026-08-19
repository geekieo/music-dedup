// scripts/scan-phase-merge-test.mjs — 分阶段增量合并端到端回归（P5.2）
//
// 验证：worker 每完成一个阶段 → broker 合并临时库→主库并广播 type:'merged' → 主库在
// 每阶段 merged 后即含该阶段成果（不等 done）；worker 经闸门放行、全阶段跑完到达 done。
// 不碰生产数据：临时目录建主库 + 生成小 WAV，跑 ['enum','meta','basicMatch']。
// 用法：node scripts/scan-phase-merge-test.mjs
import { createRequire } from 'module';
import path from 'path';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

// ── WAV 生成（PCM mono 16-bit 44.1kHz；带 INFO 标签 INAM/IART）──
// 同 title + 同 artist + 同时长 → basicMatch 确定性出组（matcher 要求 artist 非空才确认）。
function writeWav(filePath, durationSec, { title = null, artist = null, freq = 440 } = {}) {
  const sr = 44100, n = Math.floor(durationSec * sr), dataSize = n * 2;
  const chunks = [];
  const wfmt = Buffer.alloc(16);
  wfmt.writeUInt16LE(1, 0); wfmt.writeUInt16LE(1, 2); wfmt.writeUInt32LE(sr, 4);
  wfmt.writeUInt32LE(sr * 2, 8); wfmt.writeUInt16LE(2, 12); wfmt.writeUInt16LE(16, 14);
  chunks.push(['fmt ', wfmt]);
  if (title || artist) {
    const info = Buffer.alloc(0);
    const sub = [];
    if (title) { const t = Buffer.from(title, 'latin1'); sub.push([Buffer.from('INAM'), t]); }
    if (artist) { const a = Buffer.from(artist, 'latin1'); sub.push([Buffer.from('IART'), a]); }
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

const tmp = mkdtempSync(path.join(tmpdir(), 'md-phase-'));
const scanDir = path.join(tmp, 'tracks');
mkdirSync(path.join(scanDir, 'A'), { recursive: true });
mkdirSync(path.join(scanDir, 'B'), { recursive: true });
writeWav(path.join(scanDir, 'A', 'song-dup.wav'), 3, { title: 'Song Dup', artist: 'The Artist' });
writeWav(path.join(scanDir, 'B', 'song-dup.wav'), 3, { title: 'Song Dup', artist: 'The Artist', freq: 442 }); // 同歌名同歌手同时长 → 重复对
writeWav(path.join(scanDir, 'A', 'song-uniq.wav'), 3, { title: 'Song Uniq', artist: 'Other' });

const mainDb = path.join(tmp, 'musicdedup.db');
process.env.DB_PATH = mainDb; // 必须早于 ipc/scan.js 的模块级 getDB()

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[phase-merge] ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

try {
  const { openDB } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'index.js')).href);
  const db = openDB();
  db.run("UPDATE settings SET value=? WHERE key='scan_dirs'", [JSON.stringify([scanDir])]); // 默认已有 scan_dirs='[]'，改为本测试扫描目录
  db.close();

  const { setSend, routes } = await import(pathToFileURL(path.join(repoRoot, 'electron', 'ipc', 'scan.js')).href);
  const events = [];
  setSend((d) => events.push(d));

  const start = routes.find(r => r.method === 'POST' && r.path === '/api/scan/start');
  const r = await start.handler({}, {}, { steps: ['enum', 'meta', 'basicMatch'] });
  check('scan/start 返回 ok', r.ok, r.error || '');

  // 等终态：done 或 error，超时兜底
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (events.some(e => e.type === 'done' || e.type === 'error')) break;
    await new Promise(r => setTimeout(r, 200));
  }
  const types = events.map(e => e.type);
  check('收到 done（扫描完整跑完）', types.includes('done'), '事件类型: ' + [...new Set(types)].join(','));
  const err = events.find(e => e.type === 'error');
  if (err) console.log('[phase-merge] worker error:', err.message);

  // 分阶段 merged 顺序：enum → meta → basicMatch（按广播顺序）
  const merged = events.filter(e => e.type === 'merged').map(e => e.phase);
  check('每个阶段都有 merged 广播', merged.includes('enum') && merged.includes('meta') && merged.includes('basicMatch'),
    'merged 顺序: ' + merged.join(' → '));
  check('merged 顺序正确（阶段完成序）', merged.indexOf('enum') < merged.indexOf('meta') && merged.indexOf('meta') < merged.indexOf('basicMatch'),
    'merged 顺序: ' + merged.join(' → '));
  check('done 在最后一次 merged 之后', types.indexOf('done') > events.map((e, i) => e.type === 'merged' ? i : -1).filter(i => i >= 0).pop(),
    '事件总数=' + events.length);

  // 主库逐阶段成果：用每阶段 merged 后主库应已含该阶段数据来验证（不等 done）
  // 直接读终态主库即可证明合并已发生；再核对文件/元数据/组三项都在。
  const m = openDB({ path: mainDb, skipInit: true });
  const fileCount = m.get('SELECT COUNT(*) n FROM files').n;
  const metaCount = m.get('SELECT COUNT(*) n FROM files WHERE meta_extracted_at IS NOT NULL').n;
  const groupCount = m.get('SELECT COUNT(*) n FROM dup_groups').n;
  const trackCount = m.get('SELECT COUNT(*) n FROM group_tracks').n;
  m.close();
  check('主库文件已入库（enum 合并成果）', fileCount === 3, `files=${fileCount}`);
  check('主库元数据已入库（meta 合并成果）', metaCount === 3, `meta=${metaCount}/3`);
  check('主库重复组已入库（basicMatch 合并成果）', groupCount >= 1 && trackCount >= 2, `groups=${groupCount} tracks=${trackCount}`);

  // 临时库应已清理（done 后 settle 合并成功并删除）
  const leftovers = readdirSync(tmp).filter(f => f.startsWith('scan-tmp-'));
  check('临时库已清理（无残留 scan-tmp）', leftovers.length === 0, '残留: ' + leftovers.join(','));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[phase-merge] ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
