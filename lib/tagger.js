// lib/tagger.js — Tag reading/writing with snapshot protection
// Native pure-JS writers for all common formats — no external tools required:
//   MP3 / WAV / AIFF : node-id3 (already a dependency)
//   FLAC             : lib/flac-writer.js (Vorbis Comment)
//   OGG / Opus       : lib/ogg-writer.js  (Vorbis Comment in OGG pages)
//   M4A / MP4        : lib/m4a-writer.js  (iTunes ilst atoms)
import { createRequire } from 'module';
import { renameSync, existsSync } from 'fs';
import path from 'path';
import { parseFile } from 'music-metadata';
import { writeFlacTags } from './flac-writer.js';
import { writeOggTags  } from './ogg-writer.js';
import { writeM4aTags  } from './m4a-writer.js';

const require = createRequire(import.meta.url);

let _id3 = null;
function getID3() {
  if (!_id3) { try { _id3 = require('node-id3'); } catch {} }
  return _id3;
}

// ── Read actual file tags (NOT from database) ─────────────────────────────
export async function readTagsFromFile(filePath) {
  try {
    const meta = await parseFile(filePath, { duration: false, skipCovers: true });
    const c = meta.common;
    return {
      title:        c.title        || null,
      artist:       c.artist       || c.albumartist || null,
      album:        c.album        || null,
      album_year:   c.year         || (c.date ? parseInt(c.date) : 0) || 0,
      track_number: c.track?.no   || 0,
    };
  } catch (e) {
    return { title: null, artist: null, album: null, album_year: 0, track_number: 0, _err: e.message };
  }
}

// ── Write tags — dispatches to the correct native writer by extension ─────
function writeAudioTags(filePath, fieldsToWrite, format) {
  const ext = path.extname(filePath).toLowerCase();

  // MP3, WAV, AIFF — node-id3 handles all three natively
  if (['.mp3', '.wav', '.aiff', '.aif'].includes(ext)) {
    const id3 = getID3();
    if (!id3) throw new Error('node-id3 not available');
    const obj = {};
    if (fieldsToWrite.title        != null) obj.title       = String(fieldsToWrite.title);
    if (fieldsToWrite.artist       != null) obj.artist      = String(fieldsToWrite.artist);
    if (fieldsToWrite.album        != null) obj.album       = String(fieldsToWrite.album);
    if (fieldsToWrite.album_year   != null) obj.year        = String(fieldsToWrite.album_year);
    if (fieldsToWrite.track_number != null) obj.trackNumber = String(fieldsToWrite.track_number);
    const result = id3.update(obj, filePath);
    if (result !== true) throw new Error('node-id3 写入失败');
    return { method: 'node-id3' };
  }

  if (ext === '.flac') {
    writeFlacTags(filePath, fieldsToWrite);
    return { method: 'flac-writer' };
  }

  if (['.ogg', '.oga', '.opus'].includes(ext)) {
    writeOggTags(filePath, fieldsToWrite);
    return { method: 'ogg-writer' };
  }

  if (['.m4a', '.m4b', '.mp4', '.aac'].includes(ext)) {
    writeM4aTags(filePath, fieldsToWrite);
    return { method: 'm4a-writer' };
  }

  throw new Error(`不支持的格式: ${ext || '未知格式'}`);
}

// ── Safe tag write with snapshot (three-phase: snapshot → write → verify) ──
export async function writeTagsWithSnapshot(db, fileId, fieldsToWrite) {
  const file = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!file) return { ok: false, error: 'File not found' };
  if (!existsSync(file.path)) return { ok: false, error: '文件不存在: ' + file.path };

  // Phase 1: Snapshot — read and store current file tags BEFORE any write
  const currentTags = await readTagsFromFile(file.path);
  if (currentTags._err) return { ok: false, error: '无法读取文件标签: ' + currentTags._err };

  const snapshotId = db.run(
    `INSERT INTO tag_snapshots (file_id, snapshot_time, original_tags, status)
     VALUES (?,?,?,'pending')`,
    [fileId, Date.now(), JSON.stringify(currentTags)]
  ).lastInsertRowid;

  // Phase 2: Atomic write
  // IMPORTANT: FLAC/OGG/M4A writers replace the ENTIRE metadata block.
  // We must merge fieldsToWrite with currentTags so existing tags aren't lost.
  // For MP3 (node-id3.update), the merge is harmless — it writes all fields.
  const effectiveTags = { ...currentTags };
  for (const [k, v] of Object.entries(fieldsToWrite)) {
    // Only overwrite with non-empty values — skip null/undefined/empty/numeric-zero
    const hasValue = v !== null && v !== undefined && v !== ''
                  && !(typeof v === 'number' && v === 0);
    if (hasValue) effectiveTags[k] = v;
  }
  try {
    writeAudioTags(file.path, effectiveTags, file.format);

    // Phase 3: Verify — only check the fields we intended to change
    const verified = await readTagsFromFile(file.path);
    const verifyErrors = [];
    for (const [key, val] of Object.entries(fieldsToWrite)) {
      const written  = String(val || '').trim();
      if (!written) continue; // skip blank/zero fields we didn't write
      const readBack = String(verified[key] || '').trim();
      if (written && !readBack.includes(written) && !written.includes(readBack)) {
        verifyErrors.push(`${key}: 写入 "${written}" 但读回 "${readBack}"`);
      }
    }
    if (verifyErrors.length > 0) throw new Error('验证失败: ' + verifyErrors.join('; '));

    db.run(
      `UPDATE tag_snapshots SET status='written', written_tags=?, written_at=? WHERE id=?`,
      [JSON.stringify(fieldsToWrite), Date.now(), snapshotId]
    );
    db.run(
      `UPDATE files SET title=COALESCE(?,title), artist=COALESCE(?,artist),
       album=COALESCE(?,album), album_year=COALESCE(?,album_year),
       track_number=COALESCE(?,track_number) WHERE id=?`,
      [fieldsToWrite.title ?? null, fieldsToWrite.artist ?? null,
       fieldsToWrite.album ?? null, fieldsToWrite.album_year ?? null,
       fieldsToWrite.track_number ?? null, fileId]
    );
    return { ok: true, snapshotId, verified };

  } catch (err) {
    // Restore from snapshot using the original (unmodified) tags
    try { writeAudioTags(file.path, currentTags, file.format); } catch (restoreErr) {
      db.run(`UPDATE tag_snapshots SET status='failed', error_msg=? WHERE id=?`,
        [`写入失败且恢复失败: ${err.message} / ${restoreErr.message}`, snapshotId]);
      return { ok: false, error: `写入失败，恢复也失败: ${err.message}`, snapshotId };
    }
    db.run(`UPDATE tag_snapshots SET status='failed', error_msg=? WHERE id=?`,
      [err.message, snapshotId]);
    return { ok: false, error: err.message, reverted: true, snapshotId };
  }
}

// ── Revert a snapshot (restore original file tags) ────────────────────────
export async function revertFromSnapshot(db, snapshotId) {
  const snap = db.get('SELECT * FROM tag_snapshots WHERE id=?', [snapshotId]);
  if (!snap) return { ok: false, error: 'Snapshot not found' };
  if (snap.status === 'reverted') return { ok: false, error: '已撤销' };
  if (snap.status !== 'written')  return { ok: false, error: '只能撤销已写入的快照' };

  const file = db.get('SELECT * FROM files WHERE id=?', [snap.file_id]);
  if (!file || !existsSync(file.path)) return { ok: false, error: '文件不存在' };

  const original = JSON.parse(snap.original_tags);
  try {
    writeAudioTags(file.path, original, file.format);
    db.run(`UPDATE tag_snapshots SET status='reverted', reverted_at=? WHERE id=?`,
      [Date.now(), snapshotId]);
    db.run(
      `UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=? WHERE id=?`,
      [original.title, original.artist, original.album, original.album_year, original.track_number, snap.file_id]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────
function sanitize(s) {
  return (s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,120);
}
export function buildFilename({ track_number, artist, title }) {
  const num = track_number ? String(track_number).padStart(2,'0')+'. ' : '';
  const art = artist ? sanitize(artist)+' - ' : '';
  return num + art + sanitize(title||'Unknown');
}
export function renameFile(db, fileId, newBasename) {
  const row = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!row) return { ok:false, error:'File not found' };
  const dir  = path.dirname(row.path);
  const ext  = path.extname(row.path);
  const newPath = path.join(dir, sanitize(newBasename) + ext);
  if (newPath === row.path) return { ok:true, newPath, unchanged:true };
  if (existsSync(newPath)) return { ok:false, error:'目标文件名已存在' };
  try {
    renameSync(row.path, newPath);
    db.run('UPDATE files SET path=? WHERE id=?', [newPath, fileId]);
    return { ok:true, oldPath:row.path, newPath };
  } catch (e) { return { ok:false, error:e.message }; }
}

// Kept for API compatibility — always reports native support now
export async function getExiftoolStatus() {
  return { available: true, native: true, note: '原生写入，支持 MP3/FLAC/OGG/M4A/WAV/AIFF，无需外部工具' };
}
