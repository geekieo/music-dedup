// scripts/trash-flow-test.mjs — 回收站标记与音乐库可见性回归
//
// 验证：resolve → 被删文件 deleted=1（音乐库隐藏 / stats 不计 / 扫描不处理）→
// unresolve → deleted=0（音乐库恢复显示）；removeMissingFiles 跳过回收站文件。
// 不碰生产数据：临时目录自建库 + 手工插一个重复组。用法：node scripts/trash-flow-test.mjs
import { createRequire } from 'module';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const tmp = mkdtempSync(path.join(tmpdir(), 'md-trash-'));
process.env.DB_PATH = path.join(tmp, 'musicdedup.db'); // 须在 duplicates.js 模块级 getDB() 之前

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[trash] ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

try {
  const { openDB } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'index.js')).href);
  const db = openDB();
  // 两个同歌名同歌手文件：A 音质高（320k）→ 智能保留冠军；B 音质低 → 应被删除
  const tracksDir = path.join(tmp, 'tracks');
  mkdirSync(tracksDir, { recursive: true });
  const pA = path.join(tracksDir, 'song-a.flac');
  const pB = path.join(tracksDir, 'song-b.flac');
  writeFileSync(pA, Buffer.from('a'));
  writeFileSync(pB, Buffer.from('b'));
  const ins = (p, br) => db.run(
    `INSERT INTO files (path,title,artist,bitrate,size,file_mtime,file_ctime,scan_time,meta_extracted_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [p, 'Song', 'Artist', br, 1000, 1000, 1000, Date.now(), Date.now()]);
  ins(pA, 320); ins(pB, 128);
  const idA = db.get('SELECT id FROM files WHERE path=?', [pA]).id;
  const idB = db.get('SELECT id FROM files WHERE path=?', [pB]).id;
  db.run('INSERT INTO dup_groups (similarity,type,group_tags,resolved,created_time) VALUES (?,?,?,?,?)',
    [0.99, 'basic', 'meta_confirmed', 0, Date.now()]);
  const gid = db.get('SELECT last_insert_rowid() id').id;
  db.run('INSERT INTO group_tracks (group_id,file_id) VALUES (?,?),(?,?)', [gid, idA, gid, idB]);
  db.close();

  const { routes } = await import(pathToFileURL(path.join(repoRoot, 'electron', 'ipc', 'duplicates.js')).href);
  const resolve = routes.find(r => r.method === 'POST' && r.path === '/api/duplicates/:id/resolve').handler;
  const unresolve = routes.find(r => r.method === 'POST' && r.path === '/api/duplicates/:id/unresolve').handler;
  const lib = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'library.js')).href);
  const { removeMissingFiles } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'files.js')).href);

  const d0 = openDB({ path: process.env.DB_PATH, skipInit: true });

  let rows = lib.queryLibrary(d0, {}).rows.map(r => r.id);
  check('初始两个文件都在音乐库', rows.includes(idA) && rows.includes(idB), `ids=${rows.join(',')}`);

  // ── resolve：B 放入回收站 ──
  const r1 = await resolve({ id: String(gid) }, {}, {});
  check('resolve 返回 ok', r1.ok, r1.error || '');
  check('B 磁盘已改 .deleted', !existsSync(pB) && existsSync(pB + '.deleted'));
  check('B 标记 deleted=1', d0.get('SELECT deleted FROM files WHERE id=?', [idB]).deleted === 1);
  check('A（保留）未标记', d0.get('SELECT deleted FROM files WHERE id=?', [idA]).deleted === 0);
  rows = lib.queryLibrary(d0, {}).rows.map(r => r.id);
  check('音乐库隐藏 B', rows.includes(idA) && !rows.includes(idB), `ids=${rows.join(',')}`);
  check('stats.total=1（不含回收站）', lib.statsQuery(d0).total === 1, `total=${lib.statsQuery(d0).total}`);

  // ── removeMissingFiles 跳过回收站文件（模拟扫描：只枚举到 A）──
  const removed = removeMissingFiles(d0, [pA]);
  const bAfter = d0.get('SELECT deleted FROM files WHERE id=?', [idB]);
  check('扫描不清回收站文件', bAfter && bAfter.deleted === 1, `removed=${removed} bDeleted=${bAfter && bAfter.deleted}`);

  // ── unresolve：B 恢复 ──
  const r2 = await unresolve({ id: String(gid) }, {}, {});
  check('unresolve 返回 ok', r2.ok, r2.error || '');
  check('B 磁盘文件恢复', existsSync(pB));
  check('B 恢复 deleted=0', d0.get('SELECT deleted FROM files WHERE id=?', [idB]).deleted === 0);
  rows = lib.queryLibrary(d0, {}).rows.map(r => r.id);
  check('音乐库重新显示 B', rows.includes(idA) && rows.includes(idB), `ids=${rows.join(',')}`);
  d0.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[trash] ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
