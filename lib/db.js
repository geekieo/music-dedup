// lib/db.js — SQLite (WASM) schema + queries
import { createRequire } from 'module';
import { mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

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
      match_tags    TEXT    DEFAULT '',
      resolved      INTEGER DEFAULT 0,
      resolved_time INTEGER,
      created_time  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_tracks (
      group_id        INTEGER NOT NULL,
      file_id         INTEGER NOT NULL,
      keep            INTEGER DEFAULT 0,
      keep_reason     TEXT,
      manual_override INTEGER DEFAULT 0,
      PRIMARY KEY (group_id, file_id)
    );

    CREATE TABLE IF NOT EXISTS whitelist (
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

    CREATE TABLE IF NOT EXISTS scraped_meta (
      file_id          INTEGER PRIMARY KEY,
      source           TEXT,
      mb_recording_id  TEXT,
      mb_release_id    TEXT,
      title            TEXT,
      artist           TEXT,
      album            TEXT,
      album_year       INTEGER,
      track_number     INTEGER,
      confidence       REAL,
      match_basis      TEXT DEFAULT 'fuzzy',
      scraped_at       INTEGER
    );

    INSERT OR IGNORE INTO settings VALUES
      ('scan_dirs',        '[]'),
      ('exclude_patterns', '["*.tmp",".DS_Store","Thumbs.db","desktop.ini"]'),
      ('threshold',        '90'),
      ('duration_tolerance','5'),
      ('threads',          '8'),
      ('smart_scan',       'true'),
      ('quality_tiers',    'null'),
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
  addColIfMissing(db, 'dup_groups', 'match_tags', "TEXT DEFAULT ''");
  addColIfMissing(db, 'scraped_meta', 'match_basis', "TEXT DEFAULT 'fuzzy'");
}

// ── Tag snapshots ─────────────────────────────────────────────────────────
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
    INSERT INTO files (path, size, file_mtime, scan_time)
    VALUES (?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      size=excluded.size, file_mtime=excluded.file_mtime, scan_time=excluded.scan_time
  `, [f.path, f.size, f.file_mtime, f.scan_time]);
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

// NOTE on `scan_time`: it is touched on EVERY enumerate pass for EVERY file
// that's still present on disk (see upsertFileBasic), regardless of whether
// that file actually changed. It therefore only means "last seen by an
// enumerate pass", not "last modified". The smart-skip checks below used to
// compare `extracted_at < scan_time`, which — since scan_time is bumped to
// Date.now() on literally every enum run — was true for EVERY file after any
// 'enum' step, defeating smart-skip entirely (every basic/fp/scrape lane
// includes 'enum', so this silently forced a full re-extraction every time).
// The correct staleness signal is file_mtime (did the file on disk actually
// change) plus "never extracted" — both already covered without scan_time.
export function getFilesNeedingMeta(db, smartScan) {
  if (!smartScan) return db.all('SELECT * FROM files');
  return db.all(`SELECT * FROM files WHERE
    meta_extracted_at IS NULL
    OR (file_mtime IS NOT NULL AND meta_extracted_at < file_mtime)`);
}

export function getFilesNeedingFP(db, smartScan) {
  if (!smartScan) return db.all('SELECT id,path,size,file_mtime,fp_extracted_at FROM files');
  return db.all(`SELECT id,path,size,file_mtime,fp_extracted_at FROM files WHERE
    fp_extracted_at IS NULL
    OR fingerprint IS NULL
    OR (file_mtime IS NOT NULL AND fp_extracted_at < file_mtime)`);
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
    SELECT f.*, sm.mb_recording_id AS mb_recording_id, sm.confidence AS scrape_confidence,
      sm.match_basis AS scrape_match_basis
    FROM files f
    LEFT JOIN scraped_meta sm ON sm.file_id = f.id
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
  const dupFiles   = (db.get('SELECT COUNT(*) n FROM group_tracks WHERE keep=0')||{n:0}).n;
  const dupBytes   = (db.get(`SELECT COALESCE(SUM(f.size),0) s FROM group_tracks gt JOIN files f ON f.id=gt.file_id WHERE gt.keep=0`)||{s:0}).s;
  const pendingGroups = (db.get('SELECT COUNT(*) n FROM dup_groups WHERE resolved=0')||{n:0}).n;
  return { total, albums, artists, totalBytes, formats, withMeta, withFP, dupGroups, dupFiles, dupBytes, pendingGroups };
}

// ── Groups ────────────────────────────────────────────────────────────────
export function clearGroups(db) {
  db.exec('DELETE FROM group_tracks; DELETE FROM dup_groups;');
}

export function insertGroup(db, { similarity, type, match_tags='', created_time }) {
  db.run('INSERT INTO dup_groups (similarity,type,match_tags,created_time) VALUES (?,?,?,?)', [similarity, type, match_tags||'', created_time]);
  return db.get('SELECT last_insert_rowid() AS id').id;
}

export function insertGroupTrack(db, { group_id, file_id, keep, keep_reason, manual_override }) {
  db.run('INSERT OR REPLACE INTO group_tracks (group_id,file_id,keep,keep_reason,manual_override) VALUES (?,?,?,?,?)',
    [group_id, file_id, keep?1:0, keep_reason||null, manual_override?1:0]);
}

export function getGroups(db, { resolved, limit=300, offset=0 }={}) {
  const where = resolved===undefined ? '' : `WHERE g.resolved=${resolved?1:0}`;
  return db.all(`
    SELECT g.*,
      COUNT(gt.file_id) AS track_count,
      COALESCE(SUM(CASE WHEN gt.keep=0 THEN f.size END),0) AS savings_bytes,
      (SELECT f2.title  FROM group_tracks gt2 JOIN files f2 ON f2.id=gt2.file_id
       WHERE gt2.group_id=g.id AND gt2.keep=1 LIMIT 1) AS keep_title,
      (SELECT f2.artist FROM group_tracks gt2 JOIN files f2 ON f2.id=gt2.file_id
       WHERE gt2.group_id=g.id AND gt2.keep=1 LIMIT 1) AS keep_artist
    FROM dup_groups g
    JOIN group_tracks gt ON gt.group_id=g.id
    JOIN files f ON f.id=gt.file_id
    ${where} GROUP BY g.id ORDER BY savings_bytes DESC
    LIMIT ${+limit} OFFSET ${+offset}`);
}

export function getGroupDetail(db, groupId) {
  const group = db.get('SELECT * FROM dup_groups WHERE id=?', [groupId]);
  if (!group) return null;
  const tracks = db.all(`
    SELECT f.*, gt.keep, gt.keep_reason, gt.manual_override,
      CASE WHEN w.file_id IS NOT NULL THEN 1 ELSE 0 END AS whitelisted
    FROM group_tracks gt JOIN files f ON f.id=gt.file_id
    LEFT JOIN whitelist w ON w.file_id=f.id
    WHERE gt.group_id=? ORDER BY gt.keep DESC, f.bitrate DESC`, [groupId]);
  return { ...group, tracks };
}

export function resolveGroup(db, groupId) {
  db.run('UPDATE dup_groups SET resolved=1,resolved_time=? WHERE id=?', [Date.now(), groupId]);
}

export function setTrackKeep(db, groupId, fileId, keep, reason, manual=1) {
  db.run('UPDATE group_tracks SET keep=?,keep_reason=?,manual_override=? WHERE group_id=? AND file_id=?',
    [keep?1:0, reason||null, manual?1:0, groupId, fileId]);
}

// ── Whitelist ─────────────────────────────────────────────────────────────
export function addWhitelist(db, fileId, reason='') {
  db.run('INSERT OR REPLACE INTO whitelist (file_id,reason,added_time) VALUES (?,?,?)',
    [fileId, reason, Date.now()]);
}
export function removeWhitelist(db, fileId) {
  db.run('DELETE FROM whitelist WHERE file_id=?', [fileId]);
}
export function getWhitelist(db) {
  return db.all(`SELECT w.file_id AS id, w.reason, w.added_time,
    f.path,f.title,f.artist,f.album,f.format,f.bitrate,f.sample_rate,f.bits_per_sample,
    f.fingerprint
    FROM whitelist w JOIN files f ON f.id=w.file_id ORDER BY w.added_time DESC`);
}
export function isWhitelisted(db, fileId) {
  return !!(db.get('SELECT 1 FROM whitelist WHERE file_id=?', [fileId]));
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

// ── Library query (paginated, searchable) ────────────────────────────────
export function queryLibrary(db, { search='', sort='title', order='asc', page=1, limit=100, format='', libFilter='all' }={}) {
  const offset = (page-1)*limit;
  const safeSort = ['title','artist','album','format','size','duration','album_year'].includes(sort)?sort:'title';
  const safeOrder = order==='desc'?'DESC':'ASC';
  const whereParts = [];
  const params = [];
  if (search) { whereParts.push("(f.title LIKE ? OR f.artist LIKE ? OR f.album LIKE ?)"); params.push('%'+search+'%','%'+search+'%','%'+search+'%'); }
  if (format) { whereParts.push("f.format=?"); params.push(format.toUpperCase()); }
  // Library filter: 'scraped' = has usable scraped data; 'dup' = appears in at least one dup group
  if (libFilter==='scraped') whereParts.push("sm.title IS NOT NULL AND sm.title!='' AND sm.source!='none'");
  if (libFilter==='dup')     whereParts.push("dt.file_id IS NOT NULL");
  const join = libFilter==='scraped'
    ? 'LEFT JOIN scraped_meta sm ON sm.file_id=f.id'
    : libFilter==='dup'
      ? 'LEFT JOIN group_tracks dt ON dt.file_id=f.id LEFT JOIN scraped_meta sm ON sm.file_id=f.id'
      : 'LEFT JOIN scraped_meta sm ON sm.file_id=f.id';
  const where = whereParts.length ? 'WHERE '+whereParts.join(' AND ') : '';
  const total = (db.get(`SELECT COUNT(DISTINCT f.id) n FROM files f ${join} ${where}`, params)||{n:0}).n;
  const rows  = db.all(`
    SELECT f.*,
      CASE WHEN w.file_id IS NOT NULL THEN 1 ELSE 0 END AS whitelisted,
      sm.title AS scraped_title, sm.artist AS scraped_artist,
      sm.album AS scraped_album, sm.album_year AS scraped_album_year,
      sm.track_number AS scraped_track_number,
      sm.mb_recording_id, sm.match_basis AS scrape_match_basis
    FROM files f
    LEFT JOIN whitelist w ON w.file_id=f.id
    ${join}
    ${where}
    GROUP BY f.id
    ORDER BY f.${safeSort} ${safeOrder} NULLS LAST
    LIMIT ${+limit} OFFSET ${+offset}`, params);
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
    WHERE g.resolved=0 AND gt.keep=0`) || {n:0}).n || 0;
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
    (file_id,source,mb_recording_id,mb_release_id,title,artist,album,album_year,track_number,confidence,match_basis,scraped_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [m.file_id,m.source,m.mb_recording_id||null,m.mb_release_id||null,
     m.title,m.artist,m.album,m.album_year||0,m.track_number||0,m.confidence||0,
     m.match_basis||'fuzzy',m.scraped_at||Date.now()]);
}

export function getFilesNeedingScrape(db, smartScan=true) {
  // Scraping (MusicBrainz text search) only needs a title — it doesn't require
  // a spectral fingerprint. Previously this required fingerprint IS NOT NULL,
  // which meant any file whose fingerprint extraction failed/was skipped could
  // never be scraped either, compounding that failure.
  if (!smartScan) return db.all("SELECT * FROM files WHERE title IS NOT NULL AND title!='' ORDER BY id");
  return db.all(`SELECT f.* FROM files f
    LEFT JOIN scraped_meta sm ON sm.file_id=f.id
    WHERE f.title IS NOT NULL AND f.title!='' AND sm.file_id IS NULL
    ORDER BY f.id`);
}

// AcoustID phase: files that HAVE a fingerprint but have NOT been scraped via AcoustID yet.
// This lets AcoustID run over the whole library independently of the MusicBrainz scrape —
// so re-running after adding an AcoustID key doesn't re-download already-good MB data.
export function getFilesNeedingAcoustidScrape(db) {
  return db.all(`SELECT f.* FROM files f
    LEFT JOIN scraped_meta sm ON sm.file_id=f.id
    WHERE f.fingerprint IS NOT NULL
    AND f.title IS NOT NULL AND f.title!=''
    AND (sm.file_id IS NULL OR sm.source != 'acoustid')
    ORDER BY f.id`);
}

export function getScrapedMeta(db, fileId) {
  return db.get('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]);
}

// Every file that has *usable* scraped data (a title came back, i.e. source
// wasn't 'none') — the candidate set for library-wide smart-fill. Joins the
// file's own current attributes so the caller can decide, per field and per
// match_basis, whether to fill a blank or overwrite a populated-but-wrong one.
export function getFilesForSmartFill(db) {
  return db.all(`
    SELECT f.id, f.title, f.artist, f.album, f.album_year, f.track_number, f.format,
      sm.title AS sm_title, sm.artist AS sm_artist, sm.album AS sm_album,
      sm.album_year AS sm_album_year, sm.track_number AS sm_track_number,
      sm.match_basis AS sm_match_basis, sm.confidence AS sm_confidence
    FROM files f JOIN scraped_meta sm ON sm.file_id=f.id
    WHERE sm.title IS NOT NULL AND sm.title!=''`);
}

// ── Convenience: upsertFile = upsertFileBasic + updateFileMeta ──────────────
export function upsertFile(db, f) {
  upsertFileBasic(db, {
    path: f.path, size: f.size || 0,
    file_mtime: f.file_mtime || 0, scan_time: f.scan_time || Date.now(),
  });
  updateFileMeta(db, f);
}

// ── Alias for consistency ──────────────────────────────────────────────────
export const getFilesNeedingFp = getFilesNeedingFP;
export const getWhitelistedIds = (db) => new Set(db.all('SELECT file_id FROM whitelist').map(r=>r.file_id));
