// lib/db.js — SQLite (WASM) schema + queries
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeScrapeTier, tierRank } from './tier.js';
import { injectFpDiff } from './rules.js';

const require = createRequire(import.meta.url);
const { Database } = require('node-sqlite3-wasm');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'musicdedup.db');
mkdirSync(path.dirname(DB_PATH), { recursive: true });

let _db = null;
export function getDB() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA cache_size=-32000;');
  initSchema(_db);
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
      scan_time            INTEGER NOT NULL DEFAULT 0
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
      ('threads',          '8'),
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

// ── Write history (per-file, one row per file_id) ─────────────────────────
export function getWriteHistory(db) {
  return db.all(`SELECT wh.*, f.title as cur_title, f.artist as cur_artist,
    f.album as cur_album FROM write_history wh
    LEFT JOIN files f ON f.id=wh.file_id
    ORDER BY wh.last_written_at DESC`);
}
export function getWriteHistoryEntry(db, fileId) {
  return db.get('SELECT * FROM write_history WHERE file_id=?', [fileId]);
}

// ── Tag snapshots (legacy, kept for API compat) ────────────────────────────
export function getTagSnapshots(db, fileId) {
  return db.all(`SELECT ts.*, f.path, f.title FROM tag_snapshots ts
    JOIN files f ON f.id=ts.file_id
    WHERE ts.file_id=? ORDER BY ts.snapshot_time DESC`, [fileId]);
}
export function getAllTagSnapshots(db, limit=100) {
  return db.all(`SELECT ts.*, f.path, f.title, f.artist FROM tag_snapshots ts
    JOIN files f ON f.id=ts.file_id
    WHERE ts.status='written'
    ORDER BY ts.snapshot_time DESC LIMIT ?`, [limit]);
}
export function getTagSnapshot(db, id) {
  return db.get('SELECT * FROM tag_snapshots WHERE id=?', [id]);
}

// ── File queries ──────────────────────────────────────────────────────────
export function upsertFileBasic(db, f) {
  db.run(`
    INSERT INTO files (path, size, file_mtime, file_ctime, scan_time)
    VALUES (?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      size=excluded.size, file_mtime=excluded.file_mtime, file_ctime=excluded.file_ctime, scan_time=excluded.scan_time
  `, [f.path, f.size, f.file_mtime, f.file_ctime, f.scan_time]);
}

export function updateFileMeta(db, f) {
  db.run(`UPDATE files SET
    title=?,artist=?,album=?,album_year=?,track_number=?,release_type=?,
    format=?,bitrate=?,sample_rate=?,bits_per_sample=?,duration=?,
    meta_score=?,meta_extracted_at=?,scan_time=?,has_lyrics=?
    WHERE path=?`, [
    f.title,f.artist,f.album,f.album_year||0,f.track_number||0,f.release_type||'unknown',
    f.format,f.bitrate,f.sample_rate,f.bits_per_sample,f.duration,
    f.meta_score||0,f.meta_extracted_at,f.scan_time,f.has_lyrics?1:0,f.path
  ]);
}

export function updateFileFingerprint(db, id, fp, fpMethod, fpDur) {
  db.run(`UPDATE files SET fingerprint=?,fingerprint_method=?,fingerprint_duration=?,fp_extracted_at=?
    WHERE id=?`, [fp, fpMethod, fpDur, Date.now(), id]);
}

export function updateFileChromaprint(db, id, chromaprint, chromaprintRaw = null) {
  db.run(`UPDATE files SET chromaprint=?, chromaprint_raw=? WHERE id=?`, [chromaprint, chromaprintRaw, id]);
}

export function updateFileAcoustidChecked(db, id) {
  db.run(`UPDATE files SET acoustid_checked_at=? WHERE id=?`, [Date.now(), id]);
}

export function updateFileMbChecked(db, id) {
  db.run(`UPDATE files SET mb_checked_at=? WHERE id=?`, [Date.now(), id]);
}

export function getFilesNeedingMeta(db, smartScan) {
  if (!smartScan) return db.all('SELECT * FROM files');
  return db.all(`SELECT * FROM files WHERE
    meta_extracted_at IS NULL
    OR (file_mtime IS NOT NULL AND meta_extracted_at < file_mtime)`);
}

export function getFilesNeedingFP(db, smartScan) {
  const selectFields = 'id, path, size, file_mtime, fp_extracted_at';
  if (!smartScan) return db.all(`SELECT ${selectFields} FROM files`);
  return db.all(`
    SELECT ${selectFields} FROM files 
    WHERE fp_extracted_at IS NULL
       OR fingerprint IS NULL
       OR (file_mtime IS NOT NULL AND fp_extracted_at < file_mtime)
  `);
}

export function getAllFiles(db) {
  return db.all('SELECT * FROM files ORDER BY id');
}

// Same as getAllFiles, but left-joins the scraped MusicBrainz/AcoustID result
// (if any) so the matcher can use mb_recording_id as a high-confidence match
// signal, and retention rules can give a small trust bonus to files with
// confirmed scrape data. `scrape_match_basis` distinguishes a precise,
// attribute-corroborated match ('exact') from a last-resort title-only guess
// ('fuzzy') — only 'exact' matches are trustworthy enough to corroborate a
// duplicate-group union or earn the metadata-completeness trust bonus; a
// fuzzy guess landing on the same generic recording for unrelated files
// (e.g. two different language versions of a song with the same title)
// must NOT be treated as third-party confirmation.
export function getAllFilesForMatching(db) {
  return db.all(`
    SELECT f.*,
      sm_mb.mb_recording_id AS mb_recording_id,
      sm_mb.confidence AS scrape_confidence,
      sm_mb.match_basis AS scrape_match_basis,
      sm_mb.source AS scrape_source,
      sm_mb.title AS scrape_title,
      sm_mb.artist AS scrape_artist,
      sm_mb.album AS scrape_album,
      sm_mb.album_year AS scrape_album_year,
      sm_mb.track_number AS scrape_track_number,
      sm_mb.genre AS scrape_genre,
      sm_mb.duration AS scrape_duration,
      sm_aid.mb_recording_id AS acoustid_recording_id,
      sm_aid.confidence AS acoustid_confidence,
      sm_aid.match_basis AS acoustid_match_basis,
      sm_aid.match_basis AS aid_match_basis,
      sm_aid.duration AS aid_duration
    FROM files f
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    ORDER BY f.id`);
}

export function getFilesByAlbum(db, album) {
  return db.all('SELECT * FROM files WHERE album=? COLLATE NOCASE', [album]);
}

export function getFileById(db, id) {
  return db.get('SELECT * FROM files WHERE id=?', [id]);
}

export function removeMissingFiles(db, existingPaths) {
  // Remove DB records for files no longer on disk
  const all = db.all('SELECT id, path FROM files');
  const pathSet = new Set(existingPaths);
  let removed = 0;
  runTx(db, () => {
    for (const f of all) {
      if (!pathSet.has(f.path)) {
        db.run('DELETE FROM files WHERE id=?', [f.id]);
        removed++;
      }
    }
  });
  return removed;
}

// ── Stats ─────────────────────────────────────────────────────────────────
export function statsQuery(db) {
  const total      = (db.get('SELECT COUNT(*) n FROM files')||{n:0}).n;
  const albums     = (db.get("SELECT COUNT(DISTINCT album) n FROM files WHERE album IS NOT NULL AND album!=''")||{n:0}).n;
  const artists    = (db.get("SELECT COUNT(DISTINCT artist) n FROM files WHERE artist IS NOT NULL AND artist!=''")||{n:0}).n;
  const totalBytes = (db.get('SELECT COALESCE(SUM(size),0) s FROM files')||{s:0}).s;
  const formats    = db.all('SELECT format, COUNT(*) n FROM files WHERE format IS NOT NULL GROUP BY format ORDER BY n DESC');
  const withMeta   = (db.get('SELECT COUNT(*) n FROM files WHERE meta_extracted_at IS NOT NULL')||{n:0}).n;
  const withFP     = (db.get('SELECT COUNT(*) n FROM files WHERE fingerprint IS NOT NULL')||{n:0}).n;
  const dupGroups  = (db.get('SELECT COUNT(*) n FROM dup_groups')||{n:0}).n;
  const dupFiles   = (db.get(`SELECT COUNT(*) n FROM group_tracks gt JOIN dup_groups g ON g.id=gt.group_id WHERE gt.file_id != g.smart_keep_file_id`)||{n:0}).n;
  const dupBytes   = (db.get(`SELECT COALESCE(SUM(f.size),0) s FROM group_tracks gt JOIN files f ON f.id=gt.file_id JOIN dup_groups g ON g.id=gt.group_id WHERE gt.file_id != g.smart_keep_file_id`)||{s:0}).s;
  const pendingGroups = (db.get('SELECT COUNT(*) n FROM dup_groups WHERE resolved=0')||{n:0}).n;
  return { total, albums, artists, totalBytes, formats, withMeta, withFP, dupGroups, dupFiles, dupBytes, pendingGroups };
}

// ── Groups ────────────────────────────────────────────────────────────────
export function clearGroups(db) {
  db.exec('DELETE FROM group_tracks; DELETE FROM dup_groups;');
}

export function insertGroup(db, { similarity, type, group_tags='', created_time }) {
  db.run('INSERT INTO dup_groups (similarity,type,group_tags,created_time) VALUES (?,?,?,?)', [similarity, type, group_tags||'', created_time]);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

export function insertGroupTrack(db, { group_id, file_id }) {
  db.run('INSERT OR REPLACE INTO group_tracks (group_id,file_id) VALUES (?,?)',
    [group_id, file_id]);
}

export function getGroups(db, { resolved, limit=100000, offset=0 }={}) {
  const where = resolved===undefined ? '' : `WHERE g.resolved=${resolved?1:0}`;
  const groups = db.all(`
    SELECT g.*,
      COUNT(gt.file_id) AS track_count,
      COALESCE(SUM(CASE WHEN gt.file_id != COALESCE(g.smart_keep_file_id, (SELECT gt3.file_id FROM group_tracks gt3 JOIN files f3 ON f3.id=gt3.file_id WHERE gt3.group_id=g.id ORDER BY f3.bitrate DESC LIMIT 1)) THEN f.size END),0) AS savings_bytes,
      COALESCE(
        (SELECT f2.title  FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.title  FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_title,
      COALESCE(
        (SELECT f2.artist FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.artist FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_artist,
      COALESCE(
        (SELECT f2.album FROM files f2 WHERE f2.id=g.smart_keep_file_id),
        (SELECT f4.album FROM group_tracks gt4 JOIN files f4 ON f4.id=gt4.file_id WHERE gt4.group_id=g.id ORDER BY f4.bitrate DESC LIMIT 1)
      ) AS keep_album,
      (SELECT GROUP_CONCAT(f5.path, '|') FROM group_tracks gt5 JOIN files f5 ON f5.id=gt5.file_id WHERE gt5.group_id=g.id) AS paths
    FROM dup_groups g
    JOIN group_tracks gt ON gt.group_id=g.id
    JOIN files f ON f.id=gt.file_id
    ${where} GROUP BY g.id ORDER BY savings_bytes DESC
    LIMIT ${+limit} OFFSET ${+offset}`);
  for (const g of groups) injectFpDiff(g);
  return groups;
}

export function getGroupDetail(db, groupId) {
  const group = db.get('SELECT * FROM dup_groups WHERE id=?', [groupId]);
  if (!group) return null;
  const tracks = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.match_basis AS scrape_match_basis,
      sm_mb.title AS scrape_title,
      sm_mb.artist AS scrape_artist,
      sm_mb.album AS scrape_album,
      sm_mb.album_year AS scrape_album_year,
      sm_mb.track_number AS scrape_track_number,
      sm_mb.genre AS scrape_genre,
      sm_mb.duration AS scrape_duration,
      sm_mb.mb_recording_id AS mb_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      sm_aid.duration AS aid_duration
    FROM group_tracks gt JOIN files f ON f.id=gt.file_id
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    WHERE gt.group_id=? ORDER BY f.bitrate DESC`, [groupId]);
  injectFpDiff(group);
  return { ...group, tracks };
}

export function resolveGroup(db, groupId) {
  db.run('UPDATE dup_groups SET resolved=1,resolved_time=? WHERE id=?', [Date.now(), groupId]);
}

export function setGroupSmartKeep(db, groupId, fileId) {
  db.run('UPDATE dup_groups SET smart_keep_file_id=? WHERE id=?', [fileId || null, groupId]);
}

// ── Retention list ────────────────────────────────────────────────────────
export function addRetentionList(db, fileId, reason='', keep=1) {
  db.run('INSERT OR REPLACE INTO retention_list (file_id,reason,added_time,keep) VALUES (?,?,?,?)',
    [fileId, reason, Date.now(), keep ? 1 : 0]);
}
export function removeRetentionList(db, fileId) {
  db.run('DELETE FROM retention_list WHERE file_id=?', [fileId]);
}
export function getRetentionList(db) {
  return db.all(`SELECT rl.file_id AS id, rl.reason, rl.added_time, rl.keep,
    f.path,f.title,f.artist,f.album,f.format,f.bitrate,f.sample_rate,f.bits_per_sample,
    f.fingerprint
    FROM retention_list rl JOIN files f ON f.id=rl.file_id WHERE rl.keep=1 ORDER BY rl.added_time DESC`);
}
export function isRetentionListed(db, fileId) {
  return !!(db.get('SELECT 1 FROM retention_list WHERE file_id=? AND keep=1', [fileId]));
}
export function getRetentionFileIds(db) {
  return new Set(db.all('SELECT file_id FROM retention_list WHERE keep=1').map(r => r.file_id));
}
export function getExcludeFileIds(db) {
  return new Set(db.all('SELECT file_id FROM retention_list WHERE keep=0').map(r => r.file_id));
}

// ── Settings ──────────────────────────────────────────────────────────────
export function getSetting(db, key, fallback=null) {
  const row = db.get('SELECT value FROM settings WHERE key=?', [key]);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
export function setSetting(db, key, value) {
  db.run('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)', [key, JSON.stringify(value)]);
}
export function getAllSettings(db) {
  const rows = db.all('SELECT key,value FROM settings');
  const out = {};
  for (const r of rows) { try { out[r.key]=JSON.parse(r.value); } catch { out[r.key]=r.value; } }
  return out;
}

// ── Library query variant for scrape-tier sort ─────────────────────────
// ── Search normalization (mirrors public/app.js normalizeForSearch) ─────
function normalizeForSearch(s) {
  if (!s) return '';
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function filterBySearch(rows, search, fields) {
  const q = normalizeForSearch(search);
  if (!q) return rows;
  return rows.filter(row => fields.some(f => {
    const val = row[f] || '';
    return normalizeForSearch(val).includes(q);
  }));
}

// Tier sort needs the FULL matching result set (not just one page) because
// tier depends on Traditional/Simplified folding that can't be expressed in
// SQL — see lib/tier.js. Reuses the same WHERE/JOIN logic as queryLibrary.
export function queryLibraryAllForTier(db, { search='', format='', libFilter='all' }={}) {
  const whereParts = [];
  const params = [];
  if (format) { whereParts.push("f.format=?"); params.push(format.toUpperCase()); }
  if (libFilter==='scraped') whereParts.push("(sm_mb.title IS NOT NULL AND sm_mb.title!='' OR sm_aid.title IS NOT NULL AND sm_aid.title!='')");
  if (libFilter==='dup')     whereParts.push("dt.file_id IS NOT NULL");
  const join = libFilter==='dup'
    ? 'LEFT JOIN group_tracks dt ON dt.file_id=f.id'
    : '';
  const where = whereParts.length ? 'WHERE '+whereParts.join(' AND ') : '';
  const rows = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
      sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
      sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
      sm_mb.match_basis AS mb_match_basis,
      sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
      sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
      sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
      COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
      COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
      COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
      COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
      COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
      COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
      CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
           WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
           ELSE NULL END AS scrape_source
    FROM files f
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    ${join}
    ${where}
    ORDER BY f.id`, params);
  return filterBySearch(rows, search, ['title', 'artist', 'album', 'path']);
}

// ── Locate a file's row position under the full (unfiltered) library ──────
// Used by the "点击定位到音乐库" feature: rather than linearly re-fetching
// pages until the target file turns up, the client asks the server for its
// zero-based index under the given sort so it can jump straight to the
// containing page. Ignores search/format/libFilter — locate always targets
// the canonical whole-library view, since that's the one guaranteed to
// contain any given file.
export function locateFileInLibrary(db, fileId, { sort = 'title', order = 'asc' } = {}) {
  const safeSort  = ['title', 'artist', 'album', 'format', 'size', 'duration', 'album_year'].includes(sort) ? sort : 'title';
  const safeOrder = order === 'desc' ? 'DESC' : 'ASC';
  const rows = db.all(`SELECT id FROM files ORDER BY ${safeSort} ${safeOrder} NULLS LAST`);
  return rows.findIndex(r => r.id === fileId); // -1 if the file no longer exists
}

// Shape a library row's scraped_* columns into the {title,artist,album,...}
// object computeScrapeTier()/autoSelectFields() expect. Used by BOTH
// queryLibrary and queryLibraryByTier so there's exactly one place that
// builds this shape — previously each had its own inline version (and the
// browser had a THIRD, incomplete one), which is how 筛选/标注 could show
// different tiers for the same file.
function scrapedShapeFromRow(f, ignoreScript = true) {
  // Build shapes for both sources, compute tier for each independently,
  // then merge: matching fields (title/artist/album) from the better-tier
  // source, recommendable-write fields (year/track/genre) from both.
  // This keeps library filter tiers consistent with the scraping dialog
  // (server.js /api/files/:id/scraped), which merges rather than picking one.
  const aidShape = f.aid_title ? {
    title: f.aid_title, artist: f.aid_artist,
    album: f.aid_album, album_year: f.aid_album_year || 0,
    track_number: f.aid_track_number || 0,
    genre: (f.aid_genre && !/^\d+\.\d+$/.test(String(f.aid_genre))) ? f.aid_genre : null,
    match_basis: f.aid_match_basis, source: 'acoustid',
  } : null;
  const mbShape = f.mb_title ? {
    title: f.mb_title, artist: f.mb_artist,
    album: f.mb_album, album_year: f.mb_album_year || 0,
    track_number: f.mb_track_number || 0,
    genre: (f.mb_genre && !/^\d+\.\d+$/.test(String(f.mb_genre))) ? f.mb_genre : null,
    match_basis: f.mb_match_basis, source: 'musicbrainz',
  } : null;
  if (!aidShape && !mbShape) return { title: null, artist: null, album: null,
    album_year: 0, track_number: 0, genre: null, match_basis: null, source: 'none' };
  if (!aidShape) return mbShape;
  if (!mbShape) return aidShape;
  // Compute per-source tier to pick the better matching basis.
  const aidTier = computeScrapeTier(f, aidShape, ignoreScript);
  const mbTier  = computeScrapeTier(f, mbShape, ignoreScript);
  const rank = t => t === 'green' ? 0 : t === 'blue' ? 1 : t === 'yellow' ? 2 : 3;
  // Primary source = better tier; on tie prefer AcoustID (audio-verified).
  const primary = rank(aidTier) <= rank(mbTier) ? aidShape : mbShape;
  const secondary = primary === aidShape ? mbShape : aidShape;
  // Merge: matching fields from primary, recommendable-write fields from both.
  return {
    title: primary.title, artist: primary.artist, album: primary.album,
    album_year: primary.album_year || secondary.album_year || 0,
    track_number: primary.track_number || secondary.track_number || 0,
    genre: primary.genre || secondary.genre,
    match_basis: primary.match_basis === 'exact' ? 'exact' : secondary.match_basis,
    source: primary.source,
  };
}

// Generic JS comparator mirroring the SQL "ORDER BY col ASC/DESC NULLS LAST"
// semantics used by queryLibrary — needed wherever sorting happens in JS
// (i.e. whenever a 刮削分类 filter is active, since tier can't be expressed in SQL).
function cmpLibraryField(a, b, sort, order) {
  const dir = order === 'desc' ? -1 : 1;
  let av = a[sort], bv = b[sort];
  if (av == null && bv == null) return 0;
  if (av == null) return 1;  // NULLS LAST regardless of direction
  if (bv == null) return -1;
  if (typeof av === 'string') av = av.toLowerCase();
  if (typeof bv === 'string') bv = bv.toLowerCase();
  if (av < bv) return -1 * dir;
  if (av > bv) return 1 * dir;
  return 0;
}

// ── Library query filtered by 刮削分类 (scrape tier) ───────────────────────
// Tier can't be expressed in SQL (CJK folding happens in JS — see lib/tier.js),
// so like the existing sort==='scrape_tier' path, this fetches the full
// matching set, computes tier per row, filters/sorts in JS, then paginates.
// scrapeTier: 'green'|'blue'|'yellow'|'none' (no usable scraped data) | '' (no filter, still needed when sort==='scrape_tier')
export function queryLibraryByTier(db, { search = '', sort = 'title', order = 'asc', page = 1, limit = 100, format = '', libFilter = 'all', scrapeTier = '', ignoreScript = true } = {}) {
  const safeSort = ['title', 'artist', 'album', 'format', 'size', 'duration', 'album_year'].includes(sort) ? sort : 'title';
  const allRows = queryLibraryAllForTier(db, { search, format, libFilter });
  const withTier = allRows.map(f => ({ ...f, _tier: computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript) }));
  const filtered = scrapeTier
    ? withTier.filter(f => scrapeTier === 'none' ? f._tier == null : f._tier === scrapeTier)
    : withTier;
  if (sort === 'scrape_tier') {
    const dir = order === 'desc' ? -1 : 1;
    filtered.sort((a, b) => dir * (tierRank(a._tier) - tierRank(b._tier)));
  } else {
    filtered.sort((a, b) => cmpLibraryField(a, b, safeSort, order));
  }
  const total = filtered.length;
  const start = (+page - 1) * +limit;
  // Attach computed tier to each row so the library 刮削 icon reads the same
  // value the 刮削分类 filter would compute — single source of truth.
  const rows = filtered.slice(start, start + +limit).map(({ _tier, ...rest }) => ({ ...rest, scrape_tier: _tier }));
  return { total, page: +page, limit: +limit, rows };
}

// ── Library query (paginated, searchable) ────────────────────────────────
export function queryLibrary(db, { search='', sort='title', order='asc', page=1, limit=100, format='', libFilter='all', ignoreScript=true }={}) {
  const offset = (page-1)*limit;
  const safeSort  = ['title','artist','album','format','size','duration','album_year'].includes(sort) ? sort : 'title';
  const safeOrder = order==='desc'?'DESC':'ASC';
  const whereParts = [];
  const params = [];
  // Search is handled in JS (normalizeForSearch) for accent/punctuation
  // tolerance — SQL LIKE alone can't do NFKD folding.
  if (format) { whereParts.push("f.format=?"); params.push(format.toUpperCase()); }
  if (libFilter==='scraped') whereParts.push("(sm_mb.title IS NOT NULL AND sm_mb.title!='' OR sm_aid.title IS NOT NULL AND sm_aid.title!='')");
  if (libFilter==='dup')     whereParts.push("dt.file_id IS NOT NULL");
  const scrapeJoin = libFilter==='scraped'
    ? 'LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = \'musicbrainz\' LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = \'acoustid\''
    : '';
  const join = libFilter==='dup'
    ? 'LEFT JOIN group_tracks dt ON dt.file_id=f.id'
    : '';
  const where = whereParts.length ? 'WHERE '+whereParts.join(' AND ') : '';

  // When search is active, fetch all rows and filter/sort/paginate in JS
  // so that normalizeForSearch (NFKD + accent stripping) is applied.
  // This mirrors the client-side filterBySearch in public/app.js.
  if (search) {
    const allRows = db.all(`
      SELECT f.*,
        CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
        sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
        sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
        sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
        sm_mb.match_basis AS mb_match_basis,
        sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
        sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
        sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
        sm_aid.match_basis AS aid_match_basis,
        COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
        COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
        COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
        COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
        COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
        COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
        COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
        CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
             WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
             ELSE NULL END AS scrape_source
      FROM files f
      LEFT JOIN retention_list rl ON rl.file_id=f.id
      LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
      LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
      ${join}
      ${where}`, params);
    const filtered = filterBySearch(allRows, search, ['title', 'artist', 'album', 'path']);
    filtered.sort((a, b) => cmpLibraryField(a, b, safeSort, order));
    const total = filtered.length;
    const rows = filtered.slice(offset, offset + +limit);
    for (const f of rows) f.scrape_tier = computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript);
    return { total, page: +page, limit: +limit, rows };
  }

  const total = (db.get(`SELECT COUNT(DISTINCT f.id) n FROM files f ${scrapeJoin} ${join} ${where}`, params)||{n:0}).n;

  const rows = db.all(`
    SELECT f.*,
      CASE WHEN rl.file_id IS NOT NULL AND rl.keep=1 THEN 1 ELSE 0 END AS in_retention_list,
      sm_mb.title AS mb_title, sm_mb.artist AS mb_artist, sm_mb.album AS mb_album,
      sm_mb.album_year AS mb_album_year, sm_mb.track_number AS mb_track_number,
      sm_mb.genre AS mb_genre, sm_mb.mb_recording_id AS mb_recording_id,
      sm_mb.match_basis AS mb_match_basis,
      sm_aid.title AS aid_title, sm_aid.artist AS aid_artist, sm_aid.album AS aid_album,
      sm_aid.album_year AS aid_album_year, sm_aid.track_number AS aid_track_number,
      sm_aid.genre AS aid_genre, sm_aid.mb_recording_id AS aid_recording_id,
      sm_aid.match_basis AS aid_match_basis,
      COALESCE(sm_aid.title, sm_mb.title) AS scraped_title,
      COALESCE(sm_aid.artist, sm_mb.artist) AS scraped_artist,
      COALESCE(sm_aid.album, sm_mb.album) AS scraped_album,
      COALESCE(sm_aid.album_year, sm_mb.album_year) AS scraped_album_year,
      COALESCE(sm_aid.track_number, sm_mb.track_number) AS scraped_track_number,
      COALESCE(sm_aid.genre, sm_mb.genre) AS scraped_genre,
      COALESCE(sm_aid.match_basis, sm_mb.match_basis) AS scrape_match_basis,
      CASE WHEN sm_aid.source IS NOT NULL THEN 'acoustid'
           WHEN sm_mb.source IS NOT NULL THEN 'musicbrainz'
           ELSE NULL END AS scrape_source
    FROM files f
    LEFT JOIN retention_list rl ON rl.file_id=f.id
    LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
    LEFT JOIN scraped_meta sm_aid ON sm_aid.file_id = f.id AND sm_aid.source = 'acoustid'
    ${join}
    ${where}
    ORDER BY f.${safeSort} ${safeOrder} NULLS LAST
    LIMIT ${+limit} OFFSET ${+offset}`, params);
  // Compute scrape_tier server-side — single source of truth for the 刮削 icon.
  for (const f of rows) f.scrape_tier = computeScrapeTier(f, scrapedShapeFromRow(f, ignoreScript), ignoreScript);
  return { total, page:+page, limit:+limit, rows };
}

export function libraryStats(db) {
  const base = db.get(`SELECT
    COUNT(DISTINCT f.id) AS total,
    COUNT(DISTINCT f.album) AS albums,
    COUNT(DISTINCT f.artist) AS artists,
    SUM(f.size) AS totalBytes,
    SUM(CASE WHEN f.fingerprint IS NOT NULL THEN 1 ELSE 0 END) AS withFP
    FROM files f`) || {};
  const scraped = (db.get(`SELECT COUNT(DISTINCT sm.file_id) n FROM scraped_meta sm
    WHERE sm.title IS NOT NULL AND sm.title!='' AND sm.source!='none'`) || {n:0}).n;
  const dupFiles = (db.get(`SELECT COUNT(DISTINCT gt.file_id) n FROM group_tracks gt
    JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`) || {n:0}).n;
  const dupGroups = (db.get(`SELECT COUNT(*) n FROM dup_groups WHERE resolved=0`) || {n:0}).n;
  // savings_bytes: sum of sizes of files marked keep=0 (non-keep tracks) in unresolved groups
  const dupBytes  = (db.get(`SELECT SUM(f.size) n FROM files f
    JOIN group_tracks gt ON gt.file_id=f.id
    JOIN dup_groups g ON g.id=gt.group_id
    WHERE g.resolved=0 AND gt.file_id != g.smart_keep_file_id`) || {n:0}).n || 0;
  const dupTotalBytes = (db.get(`SELECT SUM(f.size) n FROM files f
    JOIN group_tracks gt ON gt.file_id=f.id
    JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`) || {n:0}).n || 0;
  const formats = db.all(`SELECT format, COUNT(*) n FROM files GROUP BY format ORDER BY n DESC LIMIT 10`);
  return { ...base, scraped, dupFiles, dupGroups, dupBytes, dupTotalBytes, formats,
    scrapedAlbums: (db.get(`SELECT COUNT(DISTINCT f.album) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.title IS NOT NULL AND sm.source!='none'`)||{n:0}).n,
    scrapedArtists: (db.get(`SELECT COUNT(DISTINCT f.artist) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.title IS NOT NULL AND sm.source!='none'`)||{n:0}).n,
    dupAlbums: (db.get(`SELECT COUNT(DISTINCT f.album) n FROM files f JOIN group_tracks gt ON gt.file_id=f.id JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`)||{n:0}).n,
    dupArtists: (db.get(`SELECT COUNT(DISTINCT f.artist) n FROM files f JOIN group_tracks gt ON gt.file_id=f.id JOIN dup_groups g ON g.id=gt.group_id WHERE g.resolved=0`)||{n:0}).n,
  };
}
export function upsertScrapedMeta(db, m) {
  db.run(`INSERT OR REPLACE INTO scraped_meta
    (file_id,source,mb_recording_id,mb_release_id,title,artist,album,album_year,track_number,genre,duration,confidence,match_basis,scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [m.file_id,m.source,m.mb_recording_id||null,m.mb_release_id||null,
     m.title,m.artist,m.album,m.album_year||0,m.track_number||0,m.genre||null,m.duration||null,m.confidence||0,
     m.match_basis||'fuzzy',m.scraped_at||Date.now()]);
}

// MusicBrainz 刮削是默认刮削通道，与 AcoustID 互相独立。
// MB 使用 `files.mb_checked_at` 跟踪自己的处理状态（类似 acoustid_checked_at），
// 不依赖其他刮削器的状态。
// - smartScan=true, retryMissed=false（增量执行）：仅选取 mb_checked_at 为空或
//   文件修改时间晚于上次检查的文件
// - smartScan=true, retryMissed=true（未命中重新执行）：未检查 + 之前 MB 未命中的
//   文件（source='none'），但跳过 MB 已确认命中的（source='musicbrainz'）
// - smartScan=false（强制重扫）：所有有标题的文件
// AcoustID 已命中的文件仍然允许 MB 刮削（两者独立），但 scraper.js Phase B
// 写保护确保不会覆盖 AcoustID 的声纹验证结果。
export function getFilesNeedingScrape(db, { smartScan=true, retryMissed=false } = {}) {

  if (!smartScan) {
    return db.all(`SELECT * FROM files f WHERE title IS NOT NULL AND title!='' ORDER BY f.id`);
  }

  if (retryMissed) {
    // Unchecked + previously missed by MB, skip MB-already-matched.
    // JOIN on source='musicbrainz': if a row exists, MB already matched → exclude.
    return db.all(`SELECT f.* FROM files f
      LEFT JOIN scraped_meta sm_mb ON sm_mb.file_id = f.id AND sm_mb.source = 'musicbrainz'
      WHERE f.title IS NOT NULL AND f.title!=''
      AND sm_mb.file_id IS NULL
      ORDER BY f.id`);
  }

  // Smart: only files not yet checked by MB (or modified since last check)
  return db.all(`SELECT * FROM files f WHERE
    title IS NOT NULL AND title!=''
    AND (mb_checked_at IS NULL OR (file_mtime IS NOT NULL AND mb_checked_at < file_mtime))
    ORDER BY f.id`);
}

// AcoustID 刮削是独立于 MusicBrainz 刮削的可选通道，两者各自跟踪自己的状态。
// AcoustID 使用 `files.acoustid_checked_at` 判断是否已尝试过（类似 fp_extracted_at），
// 不依赖 `scraped_meta` 表，确保 AcoustID 和 MB 互不干扰。
// - smartScan=true, retryMissed=false（增量执行）：仅选取 acoustid_checked_at 为空或
//   文件修改时间晚于上次检查的文件
// - smartScan=true, retryMissed=true（未命中重新执行）：未检查 + 之前未命中的文件，
//   但跳过 AcoustID 已确认命中的（source='acoustid'），避免重复请求已匹配的曲目
// - smartScan=false（强制重扫）：所有有 Chromaprint 的文件，包括已命中的
export function getFilesNeedingAcoustidScrape(db, { smartScan=true, retryMissed=false } = {}) {
  if (!smartScan) {
    return db.all("SELECT * FROM files WHERE chromaprint IS NOT NULL AND title IS NOT NULL AND title!='' ORDER BY id");
  }
  if (retryMissed) {
    // Retry unchecked + previously missed, but skip files AcoustID already matched.
    // Uses scraped_meta read-only to check AcoustID's own past results.
    return db.all(`SELECT f.* FROM files f
      LEFT JOIN scraped_meta sm ON sm.file_id = f.id AND sm.source = 'acoustid'
      WHERE f.chromaprint IS NOT NULL
      AND f.title IS NOT NULL AND f.title!=''
      AND sm.file_id IS NULL
      ORDER BY f.id`);
  }
  return db.all(`SELECT * FROM files f WHERE
    chromaprint IS NOT NULL
    AND title IS NOT NULL AND title!=''
    AND (acoustid_checked_at IS NULL OR (file_mtime IS NOT NULL AND acoustid_checked_at < file_mtime))
    ORDER BY f.id`);
}

export function getScrapedMeta(db, fileId) {
  const rows = db.all('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]);
  const result = { mb: null, acoustid: null };
  for (const r of rows) {
    // Clean up legacy bogus genre values (AcoustID scores mistakenly stored
    // as genre by an older scraper version — they look like "0.98816586").
    if (r.genre && /^\d+\.\d+$/.test(String(r.genre))) r.genre = null;
    if (r.source === 'musicbrainz') result.mb = r;
    else if (r.source === 'acoustid') result.acoustid = r;
  }
  return result;
}
