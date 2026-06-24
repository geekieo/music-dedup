// lib/tagger.js — File rename, tag reading/writing with snapshot protection
import { createRequire } from 'module';
import { renameSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { parseFile } from 'music-metadata';

const require = createRequire(import.meta.url);

let _id3 = null;
function getID3() {
  if (!_id3) { try { _id3 = require('node-id3'); } catch {} }
  return _id3;
}

// ── exiftool availability cache ───────────────────────────────────────────
let _exiftoolAvail = null;
async function exiftoolAvailable() {
  if (_exiftoolAvail !== null) return _exiftoolAvail;
  return new Promise(resolve => {
    const p = spawn('exiftool', ['-ver']);
    p.on('close', code => { _exiftoolAvail = code === 0; resolve(_exiftoolAvail); });
    p.on('error', () => { _exiftoolAvail = false; resolve(false); });
  });
}

function runExiftool(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('exiftool', args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || `exiftool exit ${code}`)));
    p.on('error', reject);
  });
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

// ── Write tags to audio file ──────────────────────────────────────────────
// Tries exiftool first (all formats), falls back to node-id3 for MP3 only.
async function writeAudioTags(filePath, fieldsToWrite, format) {
  const hasExiftool = await exiftoolAvailable();

  if (hasExiftool) {
    const args = ['-overwrite_original'];
    const map = {
      title:        '-Title',
      artist:       '-Artist',
      album:        '-Album',
      album_year:   '-Year',
      track_number: '-TrackNumber',
    };
    for (const [key, flag] of Object.entries(map)) {
      if (fieldsToWrite[key] !== undefined && fieldsToWrite[key] !== null) {
        args.push(`${flag}=${fieldsToWrite[key]}`);
      }
    }
    args.push(filePath);
    await runExiftool(args);
    return { method: 'exiftool' };
  }

  // Fallback: node-id3 for MP3 only
  if ((format || '').toUpperCase() === 'MP3') {
    const id3 = getID3();
    if (!id3) throw new Error('node-id3 not available');
    const obj = {};
    if (fieldsToWrite.title        != null) obj.title       = String(fieldsToWrite.title);
    if (fieldsToWrite.artist       != null) obj.artist      = String(fieldsToWrite.artist);
    if (fieldsToWrite.album        != null) obj.album       = String(fieldsToWrite.album);
    if (fieldsToWrite.album_year   != null) obj.year        = String(fieldsToWrite.album_year);
    if (fieldsToWrite.track_number != null) obj.trackNumber = String(fieldsToWrite.track_number);
    const result = id3.update(obj, filePath);
    if (result !== true) throw new Error('node-id3 write failed');
    return { method: 'node-id3' };
  }

  throw new Error(
    `不支持 ${format || '未知'} 格式的标签写入。` +
    `请安装 exiftool（macOS: brew install exiftool / Windows: https://exiftool.org）`
  );
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
  try {
    await writeAudioTags(file.path, fieldsToWrite, file.format);

    // Phase 3: Verify — re-read and confirm each written field landed
    const verified = await readTagsFromFile(file.path);
    const verifyErrors = [];
    for (const [key, val] of Object.entries(fieldsToWrite)) {
      const written = String(val || '').trim();
      const readBack = String(verified[key] || '').trim();
      // Loose check: readback must contain the written value (exiftool may reformat year etc.)
      if (written && !readBack.includes(written) && !written.includes(readBack)) {
        verifyErrors.push(`${key}: 写入 "${written}" 但读回 "${readBack}"`);
      }
    }
    if (verifyErrors.length > 0) throw new Error('验证失败: ' + verifyErrors.join('; '));

    // Mark snapshot written, update database to stay in sync with file
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
    // Restore original tags from snapshot
    try {
      await writeAudioTags(file.path, currentTags, file.format);
    } catch (restoreErr) {
      // If restore also fails, mark as catastrophic failure
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
  if (snap.status !== 'written') return { ok: false, error: '只能撤销已写入的快照' };

  const file = db.get('SELECT * FROM files WHERE id=?', [snap.file_id]);
  if (!file || !existsSync(file.path)) return { ok: false, error: '文件不存在' };

  const original = JSON.parse(snap.original_tags);

  try {
    await writeAudioTags(file.path, original, file.format);
    db.run(`UPDATE tag_snapshots SET status='reverted', reverted_at=? WHERE id=?`,
      [Date.now(), snapshotId]);
    // Sync database back to original
    db.run(
      `UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=? WHERE id=?`,
      [original.title, original.artist, original.album, original.album_year, original.track_number, snap.file_id]
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── Utility ───────────────────────────────────────────────────────────────
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
  const dir = path.dirname(row.path);
  const ext = path.extname(row.path);
  const newPath = path.join(dir, sanitize(newBasename) + ext);
  if (newPath === row.path) return { ok:true, newPath, unchanged:true };
  if (existsSync(newPath)) return { ok:false, error:'目标文件名已存在' };
  try {
    renameSync(row.path, newPath);
    db.run('UPDATE files SET path=? WHERE id=?', [newPath, fileId]);
    return { ok:true, oldPath:row.path, newPath };
  } catch (e) { return { ok:false, error:e.message }; }
}
export async function getExiftoolStatus() {
  const avail = await exiftoolAvailable();
  return { available: avail, note: avail ? 'exiftool 可用，支持所有格式' : 'exiftool 未找到，仅支持 MP3 (node-id3)；安装 exiftool 可支持 FLAC/M4A/OGG 等所有格式' };
}
