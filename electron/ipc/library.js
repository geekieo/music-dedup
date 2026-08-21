// electron/ipc/library.js — 音乐库域：stats / library / locate
// db 为 lib/db/index.js 单例。
import { getDB } from '../../lib/db/index.js';
import { getAllSettings } from '../../lib/db/settings.js';
import { statsQuery, queryLibrary, locateFileInLibrary, libraryStats } from '../../lib/db/library.js';

const db = getDB();

// /api/library —— sort=scrape_tier / scrapeTier 过滤的 tier 路径已并入 queryLibrary
function libraryHandler(_params, query) {
  const { search = '', sort = 'title', order = 'asc', page = 1, limit = 100, format = '', libFilter = 'all', scrapeTier = '' } = query;
  // 繁简忽略 (settings.ignore_script_variant, default true) — 见 lib/tier.js。
  // 逐请求读取（不缓存）：tier 是纯展示计算，切换设置即刻生效，无需重扫。
  const ignoreScript = getAllSettings(db).ignore_script_variant !== false;
  return { ok: true, data: queryLibrary(db, { search, sort, order, page: +page, limit: +limit, format, libFilter, scrapeTier, ignoreScript }) };
}

export const routes = [
  { method: 'GET', path: '/api/stats', handler: () => ({ ok: true, data: statsQuery(db) }) },
  { method: 'GET', path: '/api/library', handler: libraryHandler },
  { method: 'GET', path: '/api/library/stats', handler: () => ({ ok: true, data: libraryStats(db) }) },
  // 定位文件在未过滤全库中的零基索引，让客户端直接跳到对应页
  { method: 'GET', path: '/api/library/locate/:id', handler: (p, query) => ({ ok: true, index: locateFileInLibrary(db, +p.id, { sort: query.sort || 'title', order: query.order || 'asc' }) }) },
];
