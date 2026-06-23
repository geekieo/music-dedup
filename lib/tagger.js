// lib/tagger.js — File rename and tag writing
import { createRequire } from 'module';
import { renameSync, existsSync } from 'fs';
import path from 'path';
import { getFilesForSmartFill } from './db.js';

const require = createRequire(import.meta.url);

let _id3 = null;
function getID3() {
  if (!_id3) { try { _id3 = require('node-id3'); } catch {} }
  return _id3;
}

function sanitize(s) {
  return (s||'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').trim().slice(0,120);
}

export function buildFilename({ track_number, artist, title }) {
  const num  = track_number ? String(track_number).padStart(2,'0')+'. ' : '';
  const art  = artist ? sanitize(artist)+' - ' : '';
  return num + art + sanitize(title||'Unknown');
}

export function renameFile(db, fileId, newBasename) {
  const row = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!row) return { ok:false, error:'File not found' };
  const dir     = path.dirname(row.path);
  const ext     = path.extname(row.path);
  const newPath = path.join(dir, sanitize(newBasename) + ext);
  if (newPath === row.path)  return { ok:true, newPath, unchanged:true };
  if (existsSync(newPath))   return { ok:false, error:'目标文件名已存在' };
  try {
    renameSync(row.path, newPath);
    db.run('UPDATE files SET path=? WHERE id=?', [newPath, fileId]);
    return { ok:true, oldPath:row.path, newPath };
  } catch (e) { return { ok:false, error:e.message }; }
}

export function writeMP3Tags(filePath, tags) {
  const id3 = getID3();
  if (!id3) return { ok:false, error:'node-id3 not available' };
  const obj = {};
  if (tags.title)        obj.title       = tags.title;
  if (tags.artist)       obj.artist      = tags.artist;
  if (tags.album)        obj.album       = tags.album;
  if (tags.album_year)   obj.year        = String(tags.album_year);
  if (tags.track_number) obj.trackNumber = String(tags.track_number);
  try {
    return id3.update(obj, filePath) ? { ok:true } : { ok:false, error:'id3.update returned false' };
  } catch (e) { return { ok:false, error:e.message }; }
}

// ── Smart-fill core ──────────────────────────────────────────────────────
// Shared by both the single-file "应用刮削数据" button (duplicate-group
// detail) and the library-wide batch fill, so the same trust rules apply
// everywhere 刮削数据 gets written onto 文件属性.
//
// title/artist are only ever used to fill a BLANK field — they're rarely
// wrong in a way that needs correcting, and silently rewriting a populated
// title (e.g. into a different script) is exactly the kind of surprising
// overwrite this is meant to avoid. album/year/track are filled when blank
// regardless of match confidence, but only OVERWRITE an already-populated
// (e.g. wrong/generic) value when the match is 'exact' — i.e. corroborated
// by the file's own album/duration/track, not just a title-only guess.
export function computeSmartFill(local, scraped, matchBasis) {
  const exact = matchBasis === 'exact';
  const out = {};
  if (scraped.title  && !local.title)  out.title  = scraped.title;
  if (scraped.artist && !local.artist) out.artist = scraped.artist;
  if (scraped.album) {
    if (!local.album) out.album = scraped.album;
    else if (exact && scraped.album !== local.album) out.album = scraped.album;
  }
  if (scraped.album_year) {
    if (!local.album_year) out.album_year = scraped.album_year;
    else if (exact && scraped.album_year !== local.album_year) out.album_year = scraped.album_year;
  }
  if (scraped.track_number) {
    if (!local.track_number) out.track_number = scraped.track_number;
    else if (exact && scraped.track_number !== local.track_number) out.track_number = scraped.track_number;
  }
  return out;
}

export function applyScrapedToFile(db, fileId) {
  const f  = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  const sm = db.get('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]);
  if (!f)             return { ok:false, error:'File not found' };
  if (!sm||!sm.title) return { ok:false, error:'No scraped metadata' };

  const fill = computeSmartFill(f, sm, sm.match_basis);
  if (Object.keys(fill).length === 0) {
    return { ok:true, dbUpdated:false, filled:{}, message:'文件属性已是完整/最新，无需覆写' };
  }

  const merged = { ...f, ...fill };
  db.run('UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=? WHERE id=?',
    [merged.title, merged.artist, merged.album, merged.album_year, merged.track_number, fileId]);

  const tagResult = f.format==='MP3'
    ? writeMP3Tags(f.path, merged)
    : { ok:false, error:`${f.format} 格式暂不支持写入文件内嵌标签（仅支持 MP3 写回；数据库中的属性已更新）` };

  return { ok:true, dbUpdated:true, filled:fill, tags:tagResult };
}

// ── Library-wide smart-fill ──────────────────────────────────────────────
// Applies the same trust-gated fill to every file that has usable scraped
// data, not just files inside a detected duplicate group (item 8).
export function applySmartFillLibrary(db) {
  const candidates = getFilesForSmartFill(db);

  let filled = 0, exactCount = 0, skipped = 0;
  for (const c of candidates) {
    const local = { title:c.title, artist:c.artist, album:c.album, album_year:c.album_year, track_number:c.track_number };
    const scraped = { title:c.sm_title, artist:c.sm_artist, album:c.sm_album, album_year:c.sm_album_year, track_number:c.sm_track_number };
    const fill = computeSmartFill(local, scraped, c.sm_match_basis);
    if (Object.keys(fill).length === 0) { skipped++; continue; }
    const merged = { ...local, ...fill };
    db.run('UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=? WHERE id=?',
      [merged.title, merged.artist, merged.album, merged.album_year, merged.track_number, c.id]);
    filled++;
    if (c.sm_match_basis === 'exact') exactCount++;
  }
  return { ok:true, filled, exact:exactCount, skipped, total:candidates.length };
}
