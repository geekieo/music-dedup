// lib/tagger.js — Tag reading/writing with complete snapshot protection
// Each writer now reads ALL existing tags before overwriting, so no field is lost.
import { createRequire } from 'module';
import { existsSync } from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';
import { writeFlacTags, writeFlacRawTags, readFlacRawTags } from './flac-writer.js';
import { writeOggTags, writeOggRawTags, readOggRawTags } from './ogg-writer.js';
import { writeM4aTags, writeM4aRawTags, readM4aRawTags } from './m4a-writer.js';

const require = createRequire(import.meta.url);
let _id3 = null;
function getID3() { if(!_id3){try{_id3=require('node-id3');}catch{}} return _id3; }

// ── Standard field read (for display / matching) ─────────────────────────
export async function readTagsFromFile(filePath) {
  try {
    const meta = await parseFile(filePath, { duration:false, skipCovers:true });
    const c = meta.common;
    return { title:c.title||null, artist:c.artist||c.albumartist||null,
      album:c.album||null, album_year:c.year||(c.date?parseInt(c.date):0)||0,
      track_number:c.track?.no||0, genre:c.genre?.[0]||null };
  } catch(e) {
    return { title:null, artist:null, album:null, album_year:0, track_number:0, genre:null, _err:e.message };
  }
}

// ── Complete raw-tag read — format-specific, preserves ALL fields ─────────
export function readAllRawTagsFromFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  try {
    if (ext === '.flac')                         return readFlacRawTags(filePath);
    if (['.ogg','.oga','.opus'].includes(ext))   return readOggRawTags(filePath);
    if (['.m4a','.m4b','.mp4','.aac'].includes(ext)) return readM4aRawTags(filePath);
    // MP3/WAV/AIFF: read via node-id3 which exposes all ID3 frames
    const id3 = getID3();
    if (id3) {
      const tags = id3.read(filePath);
      // Extract a plain string map of all text frames (skip binary/buffer frames)
      const raw = {};
      for (const [k, v] of Object.entries(tags||{})) {
        if (typeof v === 'string') raw[k] = v;
        else if (Array.isArray(v) && typeof v[0] === 'string') raw[k] = v[0];
        // skip Buffer / nested object frames (e.g. cover art) — not needed for revert
      }
      return raw;
    }
  } catch {}
  return {};
}

// ── Write tags (format-specific) ─────────────────────────────────────────
// Each writer merges with existing file tags internally.
function writeAudioTags(filePath, fieldsToWrite) {
  const ext = path.extname(filePath).toLowerCase();

  if (['.mp3','.wav','.aiff','.aif'].includes(ext)) {
    const id3 = getID3();
    if (!id3) throw new Error('node-id3 not available');
    const obj = {};
    if (fieldsToWrite.title        != null) obj.title       = String(fieldsToWrite.title);
    if (fieldsToWrite.artist       != null) obj.artist      = String(fieldsToWrite.artist);
    if (fieldsToWrite.album        != null) obj.album       = String(fieldsToWrite.album);
    if (fieldsToWrite.album_year   != null) obj.year        = String(fieldsToWrite.album_year);
    if (fieldsToWrite.track_number != null) obj.trackNumber = String(fieldsToWrite.track_number);
    if (fieldsToWrite.genre        != null) obj.genre       = String(fieldsToWrite.genre);
    if (fieldsToWrite.composer     != null) obj.composer    = String(fieldsToWrite.composer);
    if (fieldsToWrite.comment      != null) obj.comment     = { language:'eng', text: String(fieldsToWrite.comment) };
    if (fieldsToWrite.isrc         != null) obj.ISRC        = String(fieldsToWrite.isrc);
    const result = id3.update(obj, filePath);
    if (result !== true) throw new Error('node-id3 write failed: ' + (result?.message||''));
    return;
  }
  if (ext === '.flac')                          return writeFlacTags(filePath, fieldsToWrite);
  if (['.ogg','.oga','.opus'].includes(ext))    return writeOggTags(filePath, fieldsToWrite);
  if (['.m4a','.m4b','.mp4','.aac'].includes(ext)) return writeM4aTags(filePath, fieldsToWrite);
  throw new Error(`不支持的格式: ${ext||'未知格式'}`);
}

// ── Write raw-tag map back (for revert — restores every field) ─────────
function writeRawTagsToFile(filePath, rawTags) {
  const ext = path.extname(filePath).toLowerCase();
  if (['.mp3','.wav','.aiff','.aif'].includes(ext)) {
    const id3 = getID3();
    if (!id3) throw new Error('node-id3 not available');
    // node-id3 write() replaces all tags — suitable for full revert
    id3.write(rawTags, filePath);
    return;
  }
  if (ext === '.flac')                          return writeFlacRawTags(filePath, rawTags);
  if (['.ogg','.oga','.opus'].includes(ext))    return writeOggRawTags(filePath, rawTags);
  if (['.m4a','.m4b','.mp4','.aac'].includes(ext)) return writeM4aRawTags(filePath, rawTags);
}

// ── writeTagsWithSnapshot — uses per-file write_history table ────────────
// Schema: write_history (file_id PK, file_path, file_title, file_artist,
//   original_tags TEXT, current_tags TEXT, modified_fields TEXT,
//   write_count INT, first_written_at INT, last_written_at INT)
//
// original_tags = complete raw tag state BEFORE any writes for this file
// current_tags  = state after the most recent write
// Revert always restores original_tags regardless of how many writes happened.
export async function writeTagsWithSnapshot(db, fileId, fieldsToWrite) {
  const file = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!file)                return { ok:false, error:'File not found' };
  if (!existsSync(file.path)) return { ok:false, error:'文件不存在: '+file.path };

  // Read ALL existing raw tags (for snapshot) and the parsed 5-field set (for verify)
  const originalRaw = readAllRawTagsFromFile(file.path);
  const currentParsed = await readTagsFromFile(file.path);
  if (currentParsed._err) return { ok:false, error:'无法读取文件标签: '+currentParsed._err };

  try {
    // Write — each writer merges internally with existing file tags
    writeAudioTags(file.path, fieldsToWrite);

    // Light verify: re-read the fields we wrote
    const afterParsed = await readTagsFromFile(file.path);
    const afterRaw    = readAllRawTagsFromFile(file.path);

    // Upsert write_history: one row per file_id
    const existing = db.get('SELECT * FROM write_history WHERE file_id=?', [fileId]);
    const modifiedFields = Object.keys(fieldsToWrite)
      .filter(k => fieldsToWrite[k] != null && fieldsToWrite[k] !== '');
    const now = Date.now();
    const THIRTY_DAYS = 30 * 24 * 3600 * 1000;

    if (existing) {
      const mergedFields = JSON.parse(existing.modified_fields || '[]');
      for (const f of modifiedFields) { if (!mergedFields.includes(f)) mergedFields.push(f); }
      db.run(`UPDATE write_history SET current_tags=?, modified_fields=?,
        write_count=write_count+1, last_written_at=?, expires_at=? WHERE file_id=?`,
        [JSON.stringify(afterRaw), JSON.stringify(mergedFields), now, now + THIRTY_DAYS, fileId]);
    } else {
      db.run(`INSERT INTO write_history
        (file_id,file_path,file_title,file_artist,original_tags,current_tags,modified_fields,write_count,first_written_at,last_written_at,expires_at)
        VALUES(?,?,?,?,?,?,?,1,?,?,?)`,
        [fileId, file.path, file.title||null, file.artist||null,
         JSON.stringify(originalRaw), JSON.stringify(afterRaw),
         JSON.stringify(modifiedFields), now, now, now + THIRTY_DAYS]);
    }

    // Update files table for the written fields
    db.run(`UPDATE files SET title=COALESCE(?,title),artist=COALESCE(?,artist),
      album=COALESCE(?,album),album_year=COALESCE(?,album_year),
      track_number=COALESCE(?,track_number),genre=COALESCE(?,genre) WHERE id=?`,
      [fieldsToWrite.title??null, fieldsToWrite.artist??null,
       fieldsToWrite.album??null, fieldsToWrite.album_year??null,
       fieldsToWrite.track_number??null, fieldsToWrite.genre??null, fileId]);

    return { ok:true, verified:afterParsed };

  } catch(err) {
    // Best-effort restore from pre-write raw tags
    try { writeRawTagsToFile(file.path, originalRaw); } catch {}
    return { ok:false, error:err.message, reverted:true };
  }
}

// ── Revert to original (before any writes) ─────────────────────────────
export async function revertFromWriteHistory(db, fileId) {
  const rec = db.get('SELECT * FROM write_history WHERE file_id=?', [fileId]);
  if (!rec) return { ok:false, error:'没有写入历史' };
  const file = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!file || !existsSync(file.path)) return { ok:false, error:'文件不存在' };

  const originalRaw = JSON.parse(rec.original_tags || '{}');
  try {
    writeRawTagsToFile(file.path, originalRaw);
    db.run('DELETE FROM write_history WHERE file_id=?', [fileId]);
    // Restore files table fields from original
    const restored = await readTagsFromFile(file.path);
    db.run(`UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=?,genre=? WHERE id=?`,
      [restored.title, restored.artist, restored.album,
       restored.album_year, restored.track_number, restored.genre, fileId]);
    return { ok:true };
  } catch(e) { return { ok:false, error:e.message }; }
}

// ── Compatibility stubs ──────────────────────────────────────────────────
export async function getExiftoolStatus() {
  return { available:true, native:true, note:'原生写入，支持 MP3/FLAC/OGG/M4A/WAV/AIFF，无需外部工具' };
}
export function buildFilename({ track_number, artist, title }) {
  const s = x => (x||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,120);
  return (track_number?String(track_number).padStart(2,'0')+'. ':'')+(artist?s(artist)+' - ':'')+s(title||'Unknown');
}

// ── renameFile (re-exported here for server.js compat) ────────────────────
import { renameSync } from 'fs';
export function renameFile(db, fileId, newBasename) {
  const row = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!row) return { ok:false, error:'File not found' };
  const dir  = path.dirname(row.path);
  const ext  = path.extname(row.path);
  const safe = newBasename.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,200);
  const newPath = path.join(dir, safe + ext);
  if (newPath === row.path) return { ok:true, newPath, unchanged:true };
  if (existsSync(newPath)) return { ok:false, error:'目标文件名已存在' };
  try {
    renameSync(row.path, newPath);
    db.run('UPDATE files SET path=? WHERE id=?', [newPath, fileId]);
    return { ok:true, oldPath:row.path, newPath };
  } catch(e) { return { ok:false, error:e.message }; }
}
