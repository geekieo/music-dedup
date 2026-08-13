// lib/db/files.js — files 表查询（含声纹/刮削状态更新、缺失文件清理）
import { runTx } from './index.js';

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
  // Remove DB records for files no longer on disk, including all related tables
  const all = db.all('SELECT id, path FROM files');
  const pathSet = new Set(existingPaths);
  let removed = 0;
  runTx(db, () => {
    for (const f of all) {
      if (!pathSet.has(f.path)) {
        db.run('DELETE FROM write_history WHERE file_id=?',[f.id]);
        db.run('DELETE FROM tag_snapshots WHERE file_id=?',[f.id]);
        db.run('DELETE FROM scraped_meta WHERE file_id=?',[f.id]);
        db.run('DELETE FROM retention_list WHERE file_id=?',[f.id]);
        db.run('DELETE FROM group_tracks WHERE file_id=?',[f.id]);
        db.run('UPDATE dup_groups SET smart_keep_file_id=NULL WHERE smart_keep_file_id=?',[f.id]);
        db.run('DELETE FROM files WHERE id=?', [f.id]);
        removed++;
      }
    }
  });
  return removed;
}
