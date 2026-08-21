// electron/ipc/files.js — 文件域：详情 / reveal（shell）/ live-tags
// reveal 用 Electron shell.showItemInFolder 替换 server.js 的 explorer spawn。
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shell } = require('electron');

import { getDB } from '../../lib/db/index.js';
import { getFileById } from '../../lib/db/files.js';
import { readTagsFromFile } from '../../lib/tagger.js';
import { existsSync } from 'fs';

const db = getDB();

export const routes = [
  { method: 'GET', path: '/api/files/:id', handler: (p) => {
    const f = getFileById(db, +p.id);
    return f ? { ok: true, data: f } : { ok: false, error: 'Not found' };
  } },
  { method: 'POST', path: '/api/files/:id/reveal', handler: (p) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false };
    const fp = existsSync(f.path) ? f.path : (existsSync(f.path + '.deleted') ? f.path + '.deleted' : f.path);
    shell.showItemInFolder(fp);
    return { ok: true };
  } },
  // 批量检查：给定的文件 id 各自属于哪个组
  { method: 'POST', path: '/api/files/in-groups', handler: (_p, _q, body) => {
    const { ids } = body || {};
    if (!Array.isArray(ids) || !ids.length) return { ok: true, data: {} };
    const placeholders = ids.map(() => '?').join(',');
    const rows = db.all(
      `SELECT gt.file_id, gt.group_id FROM group_tracks gt
       JOIN dup_groups g ON g.id=gt.group_id
       WHERE gt.file_id IN (${placeholders})
       ORDER BY g.resolved ASC, g.id ASC`,
      ids
    );
    const map = {};
    for (const r of rows) { if (!(r.file_id in map)) map[r.file_id] = r.group_id; }
    for (const id of ids) { if (!(id in map)) map[id] = null; }
    return { ok: true, data: map };
  } },
  // 读取音频文件本身的真实标签（非数据库）
  { method: 'GET', path: '/api/files/:id/live-tags', handler: async (p) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false, error: 'Not found' };
    return { ok: true, data: await readTagsFromFile(f.path) };
  } },
];
