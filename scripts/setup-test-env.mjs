// scripts/setup-test-env.mjs — P5 真实库复验的隔离测试环境搭建
//
// 用途：不碰生产数据（%APPDATA%/MusicDedup，即 Electron userData）的前提下，
// ① 把当前重复组涉及的全部音轨复制到独立测试目录（保留目录结构）
// ② 备份生产库到 %APPDATA%/MusicDedup/backup（VACUUM INTO 生成单文件快照，
//    不依赖 WAL 边车；备份是生产数据的保险，放生产数据旁边、不进测试区）
// ③ 建一个全新测试 userData 目录
// 之后用 `npm run electron -- --userdata <测试userdata> --migrate no` 启动隔离实例，
// 在「测试曲目」目录上做全流程验证；验证完关窗，`npm run electron` 即回到生产库。
//
// 幂等：文件已存在则跳过（--copy-all 强制重拷）；备份每次生成带时间戳的新文件。
//
// 参数：
//   --root <dir>        测试区根目录     （默认 = 音乐目录同级 musicdedup-test，
//                          由重复文件公共根推导，如 <音乐目录> → <音乐目录>/musicdedup-test）
//   --tracks <dir>      测试曲目根目录   （默认 <root>/tracks）
//   --userdata <dir>    测试 userData    （默认 <root>/userdata）
//   --backup-dir <dir>  生产库备份目录   （默认 %APPDATA%/MusicDedup/backup，不进测试区）
//   --prod-db <path>    生产库路径       （默认 %APPDATA%/MusicDedup/musicdedup.db）
//   --copy-all          强制重拷全部文件（默认已存在则跳过）
//   --no-copy           只备份 + 建目录，不拷文件
//
// 说明：默认测试区放音乐目录同级（不在仓库内、不在音乐目录内）——既避免污染 git，
// 也避免将来全量扫描音乐目录时把测试副本算成重复；生产库备份放生产数据旁，随测试区
// 一起删除会丢失保险，故单独存放。

import { promises as fsp } from 'fs';
import { existsSync, mkdirSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function userDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MusicDedup');
}

// ---- 参数 ----
const argv = process.argv.slice(2);
const opt = (name) => {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='));
  if (!hit) return null;
  return hit === name ? argv[argv.indexOf(hit) + 1] || null : hit.slice(name.length + 1);
};
const prodDb = path.resolve(opt('--prod-db') || path.join(userDataDir(), 'musicdedup.db'));
const copyAll = argv.includes('--copy-all');
const noCopy = argv.includes('--no-copy');

if (!existsSync(prodDb)) {
  console.error(`[setup-test-env] 生产库不存在：${prodDb}`);
  console.error('  可传 --prod-db <path> 指定实际位置。');
  process.exit(1);
}

// ---- 1. 读取生产库：重复组涉及的全部文件 ----
const db = new Database(prodDb, { readOnly: true });
const rows = db
  .prepare('SELECT DISTINCT f.path, f.size FROM group_tracks gt JOIN files f ON f.id = gt.file_id ORDER BY f.path')
  .all();
db.close();
if (!rows.length) {
  console.error('[setup-test-env] 重复组没有关联文件（group_tracks 为空？）。');
  process.exit(1);
}
const totalSize = rows.reduce((s, r) => s + (r.size || 0), 0);
const fmt = (n) => (n > 1073741824 ? (n / 1073741824).toFixed(1) + 'GB' : (n / 1048576).toFixed(0) + 'MB');

// 公共前缀（按路径段）剥离 → 相对结构（如 <音乐目录>/... → Artist/Album/file）
const segs = rows.map((r) => r.path.split(/[\\/]/).filter(Boolean));
const common = segs[0].slice();
for (const s of segs.slice(1)) {
  let i = 0;
  while (i < common.length && i < s.length && common[i] === s[i]) i++;
  common.length = i;
}
const commonPrefix = common.join(path.sep);

// ---- 测试区位置：默认 = 音乐目录同级（--root 可覆盖） ----
const baseRoot = path.resolve(opt('--root') || path.join(path.dirname(commonPrefix), 'musicdedup-test'));
const tracksDir = path.resolve(opt('--tracks') || path.join(baseRoot, 'tracks'));
const userdataDir = path.resolve(opt('--userdata') || path.join(baseRoot, 'userdata'));
// 生产库备份放生产数据旁（%APPDATA%/MusicDedup/backup），不进测试区——随测试区一起删会丢保险。
const backupDir = path.resolve(opt('--backup-dir') || path.join(userDataDir(), 'backup'));

// ---- 2. 备份生产库（VACUUM INTO 单文件快照） ----
mkdirSync(backupDir, { recursive: true });
// 本地时间戳命名（toISOString 是 UTC，会与本地日期错一天）
const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
const backupFile = path.join(backupDir, `musicdedup-${stamp}.db`);
const backupSrc = prodDb.replace(/\\/g, '/');
const esc = backupFile.replace(/'/g, "''");
{
  const bdb = new Database(backupSrc, { readOnly: true });
  try {
    bdb.exec(`VACUUM INTO '${esc}'`);
  } finally {
    bdb.close();
  }
}
const backupSize = statSync(backupFile).size;
console.log(`[setup-test-env] 生产库已备份：${backupFile}（${fmt(backupSize)}）`);
// 回读校验备份可打开
{
  const bdb = new Database(backupFile, { readOnly: true });
  const n = bdb.prepare('SELECT COUNT(*) c FROM files').get().c;
  bdb.close();
  console.log(`[setup-test-env] 备份校验 OK（files=${n}）`);
}

// ---- 3. 复制测试曲目（保留相对目录结构） ----
mkdirSync(tracksDir, { recursive: true });
mkdirSync(userdataDir, { recursive: true });

if (noCopy) {
  console.log('[setup-test-env] --no-copy：跳过文件复制。');
} else {
  console.log(`[setup-test-env] 复制 ${rows.length} 个文件（${fmt(totalSize)}）→ ${tracksDir}`);
  const relOf = (p) => path.relative(commonPrefix, p) || path.basename(p);
  let copied = 0, skipped = 0, failed = 0;
  const work = rows.map((r) => async () => {
    const src = r.path.replace(/\\/g, path.sep);
    const dest = path.join(tracksDir, relOf(src));
    try {
      if (!copyAll && existsSync(dest) && statSync(dest).size === r.size) {
        skipped++;
        return;
      }
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.copyFile(src, dest);
      copied++;
    } catch (e) {
      failed++;
      console.error(`  ✗ ${src} → ${dest}: ${e.message}`);
    }
  });
  // 8 路并发复制
  const CONC = 8;
  let idx = 0;
  const workers = Array.from({ length: CONC }, async () => {
    while (idx < work.length) await work[idx++]();
  });
  await Promise.all(workers);
  console.log(`[setup-test-env] 复制完成：新拷 ${copied} / 跳过 ${skipped} / 失败 ${failed}`);
  if (failed) {
    console.error('[setup-test-env] 存在复制失败项，请检查上方日志。');
    process.exit(1);
  }
}

// ---- 4. 汇总 + 启动指引 ----
console.log('');
console.log('════════ 测试环境就绪 ════════');
console.log(`  测试曲目:    ${tracksDir}`);
console.log(`  测试 userData: ${userdataDir}`);
console.log(`  生产库备份:  ${backupFile}`);
console.log('');
console.log('启动隔离测试实例（全新空库 + 跳过迁移弹窗）：');
console.log(`  npm run electron -- --userdata "${userdataDir}" --migrate no`);
console.log('在设置页「音乐目录」添加测试曲目目录后即可全流程验证。');
console.log('验证完毕：关掉测试实例，`npm run electron` 即回到生产库（生产数据全程未被触碰）。');
