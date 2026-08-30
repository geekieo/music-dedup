// lib/db/index.js — SQLite (WASM) 连接初始化、schema 与迁移（按域拆分 db 模块的入口）
// 各域查询见：./files.js ./groups.js ./library.js ./retention.js ./settings.js ./tags.js ./scrape.js
// runTx 是跨域共享的事务 helper，放这里由 files/groups 引用。
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSetting, setSetting } from './settings.js';

const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 本文件在 lib/db/，默认库路径上溯两级到仓库 data/（实际运行始终由
// bootstrap-env 注入 process.env.DB_PATH，此处仅为无注入时的兜底）
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'musicdedup.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;
export function openDB({ skipInit = false, path: dbPath = null, skipPragma = false } = {}) {
  // path 显式传入时用指定文件（scan worker 用主库的 VACUUM INTO 快照副本，避免锁冲突）；
  // 缺省仍为 DB_PATH（主进程单连接）。skipPragma：worker 的临时库单连接、不需要并发 pragma，
  // 且 worker 线程对 VACUUM 产物执行 journal_mode=WAL 会报 database is locked。
  const db = new Database(dbPath || DB_PATH);
  if (!skipPragma) {
    // busy_timeout：主进程与扫描 worker 双连接并发写时，短写等待重试而非立即 SQLITE_BUSY。
    // node-sqlite3-wasm 的 Database 构造器无 timeout 选项，只能靠 pragma。
    // 本 WASM 编译版不支持 WAL（PRAGMA journal_mode=WAL 静默回退 delete），双连接在
    // DELETE 模式下会互锁——扫描 worker 用主库快照的独立临时库副本避免（见 electron/ipc/scan.js）。
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-32000; PRAGMA busy_timeout=10000;');
  }
  if (!skipInit) initSchema(db);
  return db;
}
export function getDB() {
  if (_db) return _db;
  _db = openDB();
  return _db;
}

export function runTx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch {} throw e; }
}

// ── Safe migration helper ─────────────────────────────────────────────────
function addColIfMissing(db, table, col, type) {
  const cols = db.all(`PRAGMA table_info(${table})`);
  if (!cols.some(c => c.name === col))
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      path                 TEXT    UNIQUE NOT NULL,
      title                TEXT,
      artist               TEXT,
      album                TEXT,
      album_year           INTEGER DEFAULT 0,
      track_number         INTEGER DEFAULT 0,
      release_type         TEXT    DEFAULT 'unknown',
      format               TEXT,
      bitrate              INTEGER,
      sample_rate          INTEGER,
      bits_per_sample      INTEGER,
      duration             REAL,
      size                 INTEGER,
      file_mtime           INTEGER,
      fingerprint          TEXT,
      fingerprint_duration REAL,
      fingerprint_method   TEXT,
      meta_score           INTEGER DEFAULT 0,
      meta_extracted_at    INTEGER,
      fp_extracted_at      INTEGER,
      has_lyrics           INTEGER DEFAULT 0,
      scan_time            INTEGER NOT NULL DEFAULT 0,
      deleted              INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_fp    ON files(fingerprint);
    CREATE INDEX IF NOT EXISTS idx_title ON files(title COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_album ON files(album COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS dup_groups (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      similarity    REAL    NOT NULL,
      type          TEXT    NOT NULL,
      group_tags    TEXT    DEFAULT '',
      resolved      INTEGER DEFAULT 0,
      resolved_time INTEGER,
      created_time  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_tracks (
      group_id        INTEGER NOT NULL,
      file_id         INTEGER NOT NULL,
      PRIMARY KEY (group_id, file_id)
    );

    CREATE TABLE IF NOT EXISTS retention_list (
      file_id    INTEGER PRIMARY KEY,
      reason     TEXT,
      added_time INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tag_snapshots (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id       INTEGER NOT NULL,
      snapshot_time INTEGER NOT NULL,
      original_tags TEXT NOT NULL,
      written_tags  TEXT,
      status        TEXT DEFAULT 'pending',
      written_at    INTEGER,
      reverted_at   INTEGER,
      error_msg     TEXT,
      FOREIGN KEY(file_id) REFERENCES files(id)
    );

    -- Per-file write history: one row per file, original vs current state
    CREATE TABLE IF NOT EXISTS write_history (
      file_id          INTEGER PRIMARY KEY,
      file_path        TEXT,
      file_title       TEXT,
      file_artist      TEXT,
      original_tags    TEXT NOT NULL,
      current_tags     TEXT NOT NULL,
      modified_fields  TEXT DEFAULT '[]',
      write_count      INTEGER DEFAULT 1,
      first_written_at INTEGER NOT NULL,
      last_written_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS scraped_meta (
      file_id          INTEGER NOT NULL,
      source           TEXT NOT NULL,
      mb_recording_id  TEXT,
      mb_release_id    TEXT,
      title            TEXT,
      artist           TEXT,
      album            TEXT,
      album_year       INTEGER,
      track_number     INTEGER,
      genre            TEXT,
      confidence       REAL,
      match_basis      TEXT DEFAULT 'fuzzy',
      scraped_at       INTEGER,
      PRIMARY KEY (file_id, source)
    );

    INSERT OR IGNORE INTO settings VALUES
      ('scan_dirs',        '[]'),
      ('exclude_patterns', '["*.tmp",".DS_Store","Thumbs.db","desktop.ini"]'),
      ('threshold',        '90'),
      ('duration_tolerance','5'),
      ('threads',          ''),
      ('smart_scan',       'true'),
      ('quality_tiers',    'null'),
      ('pick_tag_order',   'null'),
      ('last_enumerate',   'null'),
      ('last_metadata',    'null'),
      ('last_fingerprint', 'null'),
      ('last_match',       'null');
  `);

  // Safe migrations for existing databases
  addColIfMissing(db, 'files', 'file_mtime', 'INTEGER');
  addColIfMissing(db, 'files', 'fingerprint_method', 'TEXT');
  addColIfMissing(db, 'files', 'meta_extracted_at', 'INTEGER');
  addColIfMissing(db, 'files', 'fp_extracted_at', 'INTEGER');
  addColIfMissing(db, 'files', 'has_lyrics', 'INTEGER DEFAULT 0');
  addColIfMissing(db, 'files', 'chromaprint', 'TEXT');
  addColIfMissing(db, 'files', 'chromaprint_raw', 'TEXT');
  addColIfMissing(db, 'files', 'acoustid_checked_at', 'INTEGER');
  addColIfMissing(db, 'files', 'mb_checked_at', 'INTEGER');
  addColIfMissing(db, 'files', 'genre', 'TEXT');
  addColIfMissing(db, 'files', 'deleted', 'INTEGER DEFAULT 0'); // 回收站标记：1=已放入回收站（从音乐库隐藏，扫描不处理，purge 才彻底删）
  addColIfMissing(db, 'dup_groups', 'group_tags', "TEXT DEFAULT ''");
  db.exec(`UPDATE dup_groups SET group_tags = REPLACE(group_tags, 'album_year_diff', 'release_year_diff') WHERE group_tags LIKE '%album_year_diff%'`);
  addColIfMissing(db, 'scraped_meta', 'match_basis', "TEXT DEFAULT 'fuzzy'");
  addColIfMissing(db, 'scraped_meta', 'genre', 'TEXT');
  addColIfMissing(db, 'scraped_meta', 'duration', 'REAL');
  // Ensure `source` column exists and is backfilled (safety: old DBs may not have it)
  addColIfMissing(db, 'scraped_meta', 'source', "TEXT NOT NULL DEFAULT 'musicbrainz'");
  // Backfill any null sources. Old AcoustID-first scraper: files with chromaprint
  // were scraped via AcoustID; files without were scraped via MusicBrainz text search.
  db.exec(`UPDATE scraped_meta SET source = 'acoustid'
    WHERE (source IS NULL OR source = '')
    AND file_id IN (SELECT id FROM files WHERE chromaprint IS NOT NULL)`);
  db.exec(`UPDATE scraped_meta SET source = 'musicbrainz'
    WHERE source IS NULL OR source = ''`);
  // Migration: change scraped_meta PK from file_id to (file_id, source)
  migrateScrapedMetaCompositeKey(db);
  // Ensure write_history table exists (may not exist in older DBs)
  db.exec(`CREATE TABLE IF NOT EXISTS write_history (
    file_id INTEGER PRIMARY KEY, file_path TEXT, file_title TEXT, file_artist TEXT,
    original_tags TEXT NOT NULL DEFAULT '{}', current_tags TEXT NOT NULL DEFAULT '{}',
    modified_fields TEXT DEFAULT '[]', write_count INTEGER DEFAULT 1,
    first_written_at INTEGER NOT NULL DEFAULT 0, last_written_at INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL DEFAULT 0
  )`);
  addColIfMissing(db, 'write_history', 'expires_at', 'INTEGER NOT NULL DEFAULT 0');
  addColIfMissing(db, 'files', 'file_ctime', 'INTEGER');
  addColIfMissing(db, 'dup_groups', 'smart_keep_file_id', 'INTEGER');
  addColIfMissing(db, 'retention_list', 'keep', 'INTEGER DEFAULT 1');

  // Migration: whitelist → retention_list
  migrateWhitelistToRetentionList(db);
  // Migration: drop keep/keep_reason/manual_override from group_tracks
  migrateGroupTracksDropKeep(db);
  // 智能保留"已应用"快照一次性回填：旧库无 applied 键时以当前值起底（getSetting 显式
  // undefined 区分"键缺失"与"存了 null"，避免每次启动都回填）。worker 临时库 skipInit
  // 不执行，applied 键只写主库。
  if (getSetting(db, 'quality_tiers_applied', undefined) === undefined)
    setSetting(db, 'quality_tiers_applied', getSetting(db, 'quality_tiers'));
  if (getSetting(db, 'pick_tag_order_applied', undefined) === undefined)
    setSetting(db, 'pick_tag_order_applied', getSetting(db, 'pick_tag_order'));
}

// Migrate scraped_meta from single-column PK (file_id) to composite PK (file_id, source).
// SQLite cannot ALTER primary keys, so we recreate the table.
function migrateScrapedMetaCompositeKey(db) {
  const info = db.all("PRAGMA table_info(scraped_meta)");
  const pkCols = info.filter(c => c.pk > 0);
  // Already migrated: composite PK has 2 pk columns
  if (pkCols.length >= 2) return;
  // Only file_id is PK — old schema, needs migration
  db.exec(`
    CREATE TABLE scraped_meta_new (
      file_id          INTEGER NOT NULL,
      source           TEXT NOT NULL,
      mb_recording_id  TEXT,
      mb_release_id    TEXT,
      title            TEXT,
      artist           TEXT,
      album            TEXT,
      album_year       INTEGER,
      track_number     INTEGER,
      genre            TEXT,
      confidence       REAL,
      match_basis      TEXT DEFAULT 'fuzzy',
      scraped_at       INTEGER,
      PRIMARY KEY (file_id, source)
    );
    INSERT OR REPLACE INTO scraped_meta_new SELECT * FROM scraped_meta;
    DROP TABLE scraped_meta;
    ALTER TABLE scraped_meta_new RENAME TO scraped_meta;
  `);
}

// Migrate whitelist → retention_list (rename table, preserve data)
function migrateWhitelistToRetentionList(db) {
  const hasWhitelist = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='whitelist'");
  if (!hasWhitelist) return;
  db.exec(`INSERT OR IGNORE INTO retention_list SELECT * FROM whitelist`);
  db.exec(`DROP TABLE whitelist`);
}

// Drop keep/keep_reason/manual_override columns from group_tracks
function migrateGroupTracksDropKeep(db) {
  const info = db.all("PRAGMA table_info(group_tracks)");
  const hasKeep = info.some(c => c.name === 'keep');
  if (!hasKeep) return; // Already migrated
  db.exec(`
    CREATE TABLE group_tracks_new (
      group_id INTEGER NOT NULL,
      file_id  INTEGER NOT NULL,
      PRIMARY KEY (group_id, file_id)
    );
    INSERT INTO group_tracks_new SELECT group_id, file_id FROM group_tracks;
    DROP TABLE group_tracks;
    ALTER TABLE group_tracks_new RENAME TO group_tracks;
  `);
}
