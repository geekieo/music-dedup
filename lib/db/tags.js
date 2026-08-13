// lib/db/tags.js — 标签写入历史（write_history）+ 快照（tag_snapshots）
// write_history：每文件一行，写入前的原始标签 vs 当前状态，供回滚。
// tag_snapshots：旧版快照，为 API 兼容保留。
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
