// lib/tagger.js — File rename and tag writing
import { createRequire } from 'module';
import { renameSync, existsSync } from 'fs';
import path from 'path';

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

export function applyScrapedToFile(db, fileId) {
  const f  = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  const sm = db.get('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]);
  if (!f)             return { ok:false, error:'File not found' };
  if (!sm||!sm.title) return { ok:false, error:'No scraped metadata' };

  db.run('UPDATE files SET title=?,artist=?,album=?,album_year=?,track_number=? WHERE id=?',
    [sm.title, sm.artist||f.artist, sm.album||f.album, sm.album_year||f.album_year, sm.track_number||f.track_number, fileId]);

  const tagResult = f.format==='MP3'
    ? writeMP3Tags(f.path, sm)
    : { ok:false, error:`${f.format} 格式暂不支持写入标签（仅支持 MP3）` };

  return { ok:true, dbUpdated:true, tags:tagResult };
}
