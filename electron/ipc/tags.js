// electron/ipc/tags.js — 标签域：write-tags / snapshots（写入历史 + 回滚）
// 安全写回（三阶段：快照 → 写入 → 验证）逻辑在 lib/tagger.js。
import { getDB, getTagSnapshots, getWriteHistory } from '../../lib/db.js';
import { writeTagsWithSnapshot, revertFromWriteHistory } from '../../lib/tagger.js';

const db = getDB();

export const routes = [
  { method: 'POST', path: '/api/files/:id/write-tags', handler: async (p, _q, body) => {
    const { fields } = body;
    if (!fields || !Object.keys(fields).length) return { ok: false, error: 'fields required' };
    return await writeTagsWithSnapshot(db, +p.id, fields);
  } },
  { method: 'GET', path: '/api/files/:id/snapshots', handler: (p) => ({ ok: true, data: getTagSnapshots(db, +p.id) }) },
  { method: 'GET', path: '/api/snapshots', handler: () => {
    // 自动清理超过 30 天保留窗口的条目
    db.run('DELETE FROM write_history WHERE expires_at > 0 AND expires_at < ?', [Date.now()]);
    return { ok: true, data: getWriteHistory(db) };
  } },
  { method: 'POST', path: '/api/snapshots/:fileId/revert', handler: async (p) => (await revertFromWriteHistory(db, +p.fileId)) },
  { method: 'DELETE', path: '/api/snapshots/:fileId', handler: (p) => {
    db.run('DELETE FROM write_history WHERE file_id=?', [+p.fileId]);
    return { ok: true };
  } },
];
