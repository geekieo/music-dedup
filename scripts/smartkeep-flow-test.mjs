// scripts/smartkeep-flow-test.mjs — 智能保留 所见即所得回归
//
// 验证：改「保留优先级」后不执行 → resolve 仍按 applied 快照删（展示即所得）；
// 执行 runSmartKeep（模拟琥珀卡/扫描页「智能保留」）→ 新优先级才生效。
// 不碰生产数据：临时目录自建库 + 手工插一个重复组。用法：node scripts/smartkeep-flow-test.mjs
import { createRequire } from 'module';
import path from 'path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const tmp = mkdtempSync(path.join(tmpdir(), 'md-smartkeep-'));
process.env.DB_PATH = path.join(tmp, 'musicdedup.db'); // 须在 duplicates.js 模块级 getDB() 之前

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`[smartkeep] ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures++;
};

try {
  const { openDB } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'index.js')).href);
  const db = openDB();
  const settings = await import(pathToFileURL(path.join(repoRoot, 'lib', 'db', 'settings.js')).href);
  const { runSmartKeep } = await import(pathToFileURL(path.join(repoRoot, 'lib', 'matcher.js')).href);
  const { routes } = await import(pathToFileURL(path.join(repoRoot, 'electron', 'ipc', 'duplicates.js')).href);
  const resolve   = routes.find(r => r.method === 'POST' && r.path === '/api/duplicates/:id/resolve').handler;
  const unresolve = routes.find(r => r.method === 'POST' && r.path === '/api/duplicates/:id/unresolve').handler;
  const detail    = routes.find(r => r.method === 'GET'  && r.path === '/api/duplicates/:id').handler;

  // A：320k、ctime 旧（默认顺序下 音质最优 胜）；B：128k、ctime 新（ctime 优先时胜）
  const tracksDir = path.join(tmp, 'tracks');
  mkdirSync(tracksDir, { recursive: true });
  const pA = path.join(tracksDir, 'song-a.mp3');
  const pB = path.join(tracksDir, 'song-b.mp3');
  writeFileSync(pA, Buffer.from('a'));
  writeFileSync(pB, Buffer.from('b'));
  const ins = (p, br, ctime) => db.run(
    `INSERT INTO files (path,title,artist,format,bitrate,size,duration,file_mtime,file_ctime,scan_time,meta_extracted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [p, 'Song', 'Artist', 'MP3', br, 1000, 180, 1000, ctime, Date.now(), Date.now()]);
  ins(pA, 320, 100); ins(pB, 128, 200);
  const idA = db.get('SELECT id FROM files WHERE path=?', [pA]).id;
  const idB = db.get('SELECT id FROM files WHERE path=?', [pB]).id;
  db.run('INSERT INTO dup_groups (similarity,type,group_tags,resolved,created_time) VALUES (?,?,?,?,?)',
    [0.99, 'basic', 'meta_confirmed', 0, Date.now()]);
  const gid = db.get('SELECT last_insert_rowid() id').id;
  db.run('INSERT INTO group_tracks (group_id,file_id) VALUES (?,?),(?,?)', [gid, idA, gid, idB]);
  db.close();

  const d0 = openDB({ path: process.env.DB_PATH, skipInit: true });
  const del = (id) => d0.get('SELECT deleted FROM files WHERE id=?', [id]).deleted;

  // ── 1. 默认 applied（未设置 → 默认顺序）：音质优的 A 保留 ──
  const r1 = await resolve({ id: String(gid) }, {}, {});
  check('resolve 按默认 applied：A 保留 B 进回收站', r1.ok && del(idA) === 0 && del(idB) === 1, r1.error || '');
  await unresolve({ id: String(gid) }, {}, {});
  check('unresolve 恢复', del(idA) === 0 && del(idB) === 0);

  // ── 2. 改「保留优先级」把 入库更晚 提到最顶，但不执行 ──
  settings.setSetting(d0, 'pick_tag_order', ['ctime_best','duration_accurate','quality_best','album_best','release_best','scrape_best','meta_best']);
  const r2 = await resolve({ id: String(gid) }, {}, {});
  check('改优先级未执行 → resolve 仍按 applied 删（A 保留）', r2.ok && del(idA) === 0 && del(idB) === 1, '未执行就按新优先级 = 违反所见即所得');
  await unresolve({ id: String(gid) }, {}, {});

  // ── 3. 执行「智能保留」（当前草稿 → applied 快照 + 重算推荐保留）→ 新优先级生效 ──
  const curS = settings.getAllSettings(d0); // 模拟 /api/scan/start：把当前草稿固化为 applied
  settings.setAppliedPickSettings(d0, { quality_tiers: curS.quality_tiers, pick_tag_order: curS.pick_tag_order });
  await runSmartKeep(d0, {});
  const smartId = d0.get('SELECT smart_keep_file_id FROM dup_groups WHERE id=?', [gid]).smart_keep_file_id;
  check('执行后 smart_keep_file_id = B（ctime 新）', smartId === idB, `smart=${smartId}`);

  const r3 = await resolve({ id: String(gid) }, {}, {});
  check('执行后 resolve 按新优先级：B 保留 A 进回收站', r3.ok && del(idA) === 1 && del(idB) === 0, r3.error || '');

  // ── 4. 已处理组详情：保留状态反映回收站实际状态 ──
  const d1 = await detail({ id: String(gid) }, {}, {});
  const wa = d1.data.tracks.find(t => t.id === idA);
  const wb = d1.data.tracks.find(t => t.id === idB);
  check('已处理组详情：A _retained=false（已回收）', wa && wa._retained === false, JSON.stringify(wa && wa._retained));
  check('已处理组详情：B _retained=true（保留）', wb && wb._retained === true);
  d0.close();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`[smartkeep] ${failures === 0 ? '全部通过' : failures + ' 项失败'}`);
process.exit(failures ? 1 : 0);
