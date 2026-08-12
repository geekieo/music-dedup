// scripts/migrate-data.mjs — v2 数据搬迁：把 v1 项目相对 data/ 目录的 SQLite 库
// 搬到系统标准位置（Windows %APPDATA%/MusicDedup/，即 Electron userData）。
//
// 规则：源存在且目标缺失才复制（含 -wal/-shm 边车文件，若有），绝不覆盖目标——
// 目标已存在视为"已迁移/另用"，保持幂等。首启自动迁移（electron/main.js 内）与
// 手动 `npm run migrate-data` 共用本函数，避免两处实现漂移。

import { copyFileSync, existsSync, mkdirSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 与 electron/main.js 里 app.setPath('userData', …) 保持一致的目录。
// 不用 Electron 的 app.getPath 以便纯 Node CLI 也能算到同一位置。
export function userDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MusicDedup');
}

/**
 * 迁移旧数据目录 → userData。返回 { migrated:boolean, reason?:string }。
 * - sourceDir 缺省 = 仓库 data/（打包版该路径在 asar 内不存在 → no-op）
 * - targetDb  缺省 = userData/musicdedup.db
 * 只做"源存在 + 目标缺失"的复制，永不覆盖。
 */
export function migrateLegacyData({ sourceDir, targetDb } = {}) {
  if (!sourceDir) sourceDir = path.join(__dirname, '..', 'data');
  if (!targetDb) targetDb = path.join(userDataDir(), 'musicdedup.db');

  const srcDb = path.join(sourceDir, 'musicdedup.db');
  if (!existsSync(srcDb)) return { migrated: false, reason: 'no-legacy-source' };
  if (existsSync(targetDb)) return { migrated: false, reason: 'target-exists', target: targetDb };

  mkdirSync(path.dirname(targetDb), { recursive: true });
  copyFileSync(srcDb, targetDb);
  // WAL/SHM 边车文件：v1 关闭后通常不存在，存在则一并搬走（保证库文件一致）
  for (const suffix of ['-wal', '-shm']) {
    const s = srcDb + suffix;
    if (existsSync(s)) copyFileSync(s, targetDb + suffix);
  }
  return { migrated: true, source: srcDb, target: targetDb };
}

// 手动执行入口：node scripts/migrate-data.mjs（npm run migrate-data）
const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = migrateLegacyData();
  if (r.migrated) console.log(`[migrate-data] 已复制 ${r.source} → ${r.target}`);
  else if (r.reason === 'target-exists')
    console.log(`[migrate-data] 目标已存在，跳过（${r.target}）`);
  else console.log(`[migrate-data] 未找到旧数据源（data/musicdedup.db），无需迁移`);
}
