// scripts/migrate-data.mjs — v2 数据搬迁：把 v1 项目相对 data/ 目录的 SQLite 库
// 搬到系统标准位置（Windows %APPDATA%/MusicDedup/，即 Electron userData）。
//
// 规则：源存在且目标缺失才复制（含 -wal 边车文件，若有），绝不覆盖目标——
// 目标已存在视为"已迁移/另用"，保持幂等。复制后做完整性校验，失败则回滚
// （删除目标）保证可重迁。首启自动迁移（electron/migration.js 交互式 UX）与
// 手动 `npm run migrate-data` 共用本文件，避免两处实现漂移。
//
// P5 修正（相对 v1 脚本）：① probeSourceDb 区分"无源/非 SQLite/非 MusicDedup 库/
// 损坏"；② 只复制 .db + -wal（-shm 是 WAL 索引，SQLite 打开即重建，复制陈旧
// -shm 有假锁风险）；③ 复制后目标 PRAGMA quick_check，失败 unlink 回滚。

import {
  closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readSync, rmSync, statSync,
} from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm');

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 默认旧数据目录 = 仓库 data/（打包版该路径在 asar 内不存在 → probe 自然 no-op）。
export const DEFAULT_LEGACY_DIR = path.join(__dirname, '..', 'data');

// 与 electron/main.js 里 app.setPath('userData', …) 保持一致的目录。
// 不用 Electron 的 app.getPath 以便纯 Node CLI 也能算到同一位置。
// 注意：仅 CLI 默认路径用（Electron 路径一律显式传 targetDb，避免 userData 覆盖时漂移）。
export function userDataDir() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'MusicDedup');
}

const SQLITE_HEADER = Buffer.from('SQLite format 3\0');

// 只读探测某 .db 是否 MusicDedup 库（有 files 表）。只读优先；WAL 只读打开可能
// 因 -shm 访问失败 → 回退读写（源已关闭，读写打开干净关闭后不留边车）。返回 { ok, error }。
function probeOpen(dbPath) {
  let lastErr = new Error('未知');
  for (const opts of [{ readOnly: true }, {}]) {
    try {
      const db = new Database(dbPath, { fileMustExist: true, ...opts });
      try {
        const row = db.get(`SELECT name FROM sqlite_master WHERE type='table' AND name='files'`);
        if (row) return { ok: true };
        return { ok: false, error: '不是 MusicDedup 数据库（无 files 表）' };
      } finally { db.close(); }
    } catch (e) { lastErr = e; }
  }
  return { ok: false, error: lastErr.message };
}

/**
 * 探测旧数据源。返回 { sourceDb, exists, size, valid, error }。
 * valid=false 的三种情况（不存在 / 非 SQLite / 无 files 表或打不开）一律视为无源。
 */
export function probeSourceDb({ sourceDir } = {}) {
  const sourceDb = path.join(sourceDir || DEFAULT_LEGACY_DIR, 'musicdedup.db');
  if (!existsSync(sourceDb)) return { sourceDb, exists: false, size: 0, valid: false, error: '文件不存在' };
  const size = statSync(sourceDb).size;
  // SQLite 文件头魔数（前 16 字节，便宜，避免打开任意文件）
  let header;
  try {
    const fd = openSync(sourceDb, 'r');
    const buf = Buffer.alloc(16);
    try { readSync(fd, buf, 0, 16, 0); } finally { closeSync(fd); }
    header = buf;
  } catch (e) {
    return { sourceDb, exists: true, size, valid: false, error: `无法读取: ${e.message}` };
  }
  if (!header.equals(SQLITE_HEADER)) {
    return { sourceDb, exists: true, size, valid: false, error: '不是 SQLite 数据库' };
  }
  const probe = probeOpen(sourceDb);
  return { sourceDb, exists: true, size, valid: probe.ok, error: probe.ok ? null : probe.error };
}

// 复制后校验目标库完整性（读写打开 quick_check，与 app 后续打开方式一致）。
// 打开会触发 WAL 恢复/checkpoint，干净关闭后不留边车。返回 { ok, error }。
export function verifyCopiedDb(dbPath) {
  let db;
  try {
    db = new Database(dbPath);
    const row = db.get('PRAGMA quick_check');
    if (row && row.quick_check === 'ok') return { ok: true };
    return { ok: false, error: `quick_check 异常: ${row && row.quick_check}` };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
}

function cleanupTarget(targetDb) {
  for (const p of [targetDb, targetDb + '-wal', targetDb + '-shm']) {
    try { rmSync(p, { force: true }); } catch {}
  }
}

/**
 * 迁移旧数据目录 → userData。返回 { migrated, reason?, source?, target? }。
 * - sourceDir 缺省 = DEFAULT_LEGACY_DIR（仓库 data/；打包版 asar 内不存在 → no-op）
 * - targetDb  缺省 = userData/musicdedup.db（仅 CLI 用；Electron 路径必须显式传）
 * 只做"源存在 + 目标缺失"的复制，永不覆盖；复制后校验，失败回滚目标保证可重迁。
 */
export function migrateLegacyData({ sourceDir, targetDb } = {}) {
  if (!sourceDir) sourceDir = DEFAULT_LEGACY_DIR;
  if (!targetDb) targetDb = path.join(userDataDir(), 'musicdedup.db');

  const srcDb = path.join(sourceDir, 'musicdedup.db');
  if (!existsSync(srcDb)) return { migrated: false, reason: 'no-legacy-source' };
  if (existsSync(targetDb)) return { migrated: false, reason: 'target-exists', target: targetDb };

  mkdirSync(path.dirname(targetDb), { recursive: true });
  try {
    copyFileSync(srcDb, targetDb);
    // WAL 边车：源未干净关闭时存在；只搬 -wal（-shm 由 SQLite 打开时重建）
    const s = srcDb + '-wal';
    if (existsSync(s)) copyFileSync(s, targetDb + '-wal');
  } catch (e) {
    cleanupTarget(targetDb);
    return { migrated: false, reason: 'copy-failed', error: e.message, source: srcDb, target: targetDb };
  }
  const check = verifyCopiedDb(targetDb);
  if (!check.ok) {
    cleanupTarget(targetDb);
    return { migrated: false, reason: 'copy-failed', error: check.error, source: srcDb, target: targetDb };
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
  else if (r.reason === 'copy-failed')
    console.error(`[migrate-data] 迁移失败（已回滚目标，可重试）：${r.error}`);
  else console.log(`[migrate-data] 未找到旧数据源（data/musicdedup.db），无需迁移`);
}
