// lib/db/retention.js — 保留名单（keep=1 保留 / keep=0 排除 override）
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
