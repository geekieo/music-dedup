// lib/db/tags.js — 标签写入历史（write_history）
// 每文件一行，记录写入前的原始标签 vs 当前状态，供回滚。
export function getWriteHistory(db) {
  return db.all(`SELECT wh.*, f.title as cur_title, f.artist as cur_artist,
    f.album as cur_album FROM write_history wh
    LEFT JOIN files f ON f.id=wh.file_id
    ORDER BY wh.last_written_at DESC`);
}
