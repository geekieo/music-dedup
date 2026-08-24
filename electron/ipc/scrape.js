// electron/ipc/scrape.js — 刮削域：scrape-single / 双源候选 / 选择落库 / scraped CRUD / AcoustID key 校验
// 注：scrape-single 与 scraped(GET) 共用 overallTierOf() 计算整体 tier。
import { getDB } from '../../lib/db/index.js';
import { getAllSettings } from '../../lib/db/settings.js';
import { getFileById } from '../../lib/db/files.js';
import { getScrapedMeta, upsertScrapedMeta } from '../../lib/db/scrape.js';
import { scrapeSingleFile, getMbCandidates, getAcoustidCandidates, setHttpFetch } from '../../lib/scraper.js';
import { computeScrapeTier, mergeDualScrapeShape } from '../../lib/tier.js';
import { createRequire } from 'module';

// 主进程网络请求一律走 Electron net.fetch（Chromium 网络栈）：
// 全局 fetch（undici）在主进程跑会占主进程事件循环——网络不可达/代理环境下连接挂起时
// 会阻塞全部 IPC，表现为"验证时整个应用卡死、其他功能点不了"（曾实测复现）。
// net.fetch 跑在 Chromium IO 线程、尊重系统代理，天然不阻塞主进程 JS。
// 手动刮削（scrape-single / mb-candidates / acoustid-candidates）经 lib/scraper.js
// 的可注入 httpFetch 同样切到 net.fetch；scan worker 线程保持全局 fetch（不影响主进程）。
const require = createRequire(import.meta.url);
const { net } = require('electron');
setHttpFetch(net.fetch);

const db = getDB();

// 整体 tier：由双源合并后的 shape 计算（非逐源 max）
function overallTierOf(f, dual, ignoreScript) {
  if (!dual.mb && !dual.acoustid) return null;
  if (!f) return null;
  const toShape = (row) => row ? {
    title: row.title, artist: row.artist, album: row.album,
    album_year: row.album_year || 0, track_number: row.track_number || 0,
    genre: (row.genre && !/^\d+\.\d+$/.test(String(row.genre))) ? row.genre : null,
    match_basis: row.match_basis, source: row.source,
  } : null;
  const mbShape = toShape(dual.mb);
  const aidShape = toShape(dual.acoustid);
  return computeScrapeTier(f, mergeDualScrapeShape(f, mbShape, aidShape, ignoreScript), ignoreScript);
}

// 双源各自挂 tier + 整体 tier（scrape-single 与 scraped GET 共用）
function attachTiers(f, dual, ignoreScript) {
  const mb = dual.mb ? { ...dual.mb, scrape_tier: f ? computeScrapeTier(f, dual.mb, ignoreScript) : null } : null;
  const aid = dual.acoustid ? { ...dual.acoustid, scrape_tier: f ? computeScrapeTier(f, dual.acoustid, ignoreScript) : null } : null;
  return { mb, acoustid: aid, scrape_tier: overallTierOf(f, dual, ignoreScript) };
}

export const routes = [
  // 按需单文件刮削（ScrapeDialog 调用）
  { method: 'POST', path: '/api/files/:id/scrape-single', handler: async (p, query) => {
    const s = getAllSettings(db);
    const dual = await scrapeSingleFile(db, +p.id, s.acoustid_key || '', { skipMb: query.skip_mb === '1' });
    if (!dual) return { ok: true, data: null };
    const f = getFileById(db, +p.id);
    const ignoreScript = s.ignore_script_variant !== false;
    return { ok: true, data: attachTiers(f, dual, ignoreScript) };
  } },
  // MB 搜索候选（带分数，不落库）
  { method: 'GET', path: '/api/files/:id/mb-candidates', handler: async (p) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false, error: 'Not found' };
    return { ok: true, data: await getMbCandidates(f) };
  } },
  // AcoustID 候选（带分数，不落库）
  { method: 'GET', path: '/api/files/:id/acoustid-candidates', handler: async (p) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false, error: 'Not found' };
    const s = getAllSettings(db);
    const { candidates, error } = await getAcoustidCandidates(f, s.acoustid_key || '');
    return { ok: true, data: candidates, error: error || null };
  } },
  { method: 'POST', path: '/api/files/:id/select-mb', handler: (p, _q, body) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false, error: 'Not found' };
    const { candidate } = body;
    if (!candidate) return { ok: false, error: 'candidate required' };
    upsertScrapedMeta(db, { ...candidate, file_id: f.id, source: 'musicbrainz', scraped_at: Date.now() });
    return { ok: true };
  } },
  { method: 'POST', path: '/api/files/:id/select-acoustid', handler: (p, _q, body) => {
    const f = getFileById(db, +p.id);
    if (!f) return { ok: false, error: 'Not found' };
    const { candidate } = body;
    if (!candidate) return { ok: false, error: 'candidate required' };
    upsertScrapedMeta(db, { ...candidate, file_id: f.id, source: 'acoustid', scraped_at: Date.now() });
    return { ok: true };
  } },
  // 刮削数据 CRUD
  { method: 'GET', path: '/api/files/:id/scraped', handler: (p) => {
    const dual = getScrapedMeta(db, +p.id);
    if (!dual.mb && !dual.acoustid) return { ok: true, data: null };
    const f = getFileById(db, +p.id);
    const ignoreScript = getAllSettings(db).ignore_script_variant !== false;
    return { ok: true, data: attachTiers(f, dual, ignoreScript) };
  } },
  { method: 'DELETE', path: '/api/files/:id/scraped', handler: (p) => {
    db.run('DELETE FROM scraped_meta WHERE file_id=?', [+p.id]);
    return { ok: true };
  } },
  // AcoustID API Key 校验
  { method: 'POST', path: '/api/validate-acoustid', handler: async (_p, _q, body) => {
    const { key } = body;
    if (!key || !key.trim()) return { ok: false, error: '请输入 API Key' };
    try {
      // 用最小（故意无效）指纹做一次 lookup —— 若 KEY 本身有效，AcoustID 会改报指纹
      // 问题而非 key 问题，从而无需真实指纹即可确认 key 可用。
      const params = new URLSearchParams({ client: key.trim(), duration: '240', fingerprint: 'AQAAA', meta: 'recordings' });
      // 10s 超时：网络不可达时 acoustid.org 连接会无限挂起（AbortController 兜底）。
      // 用 net.fetch（Chromium 栈，不阻塞主进程事件循环）而非全局 fetch（undici 会卡 IPC）。
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      let d;
      try {
        const r = await net.fetch(`https://api.acoustid.org/v2/lookup?${params}`, {
          headers: { 'User-Agent': 'MusicDedup/2.0' },
          signal: ac.signal,
        });
        d = await r.json();
      } catch (e) {
        if (e.name === 'AbortError') return { ok: false, error: '请求超时（10s），请检查网络连接后重试' };
        return { ok: false, error: '网络错误: ' + e.message };
      } finally {
        clearTimeout(timer);
      }
      // Code 4（而非 3）= key 无效。同时匹配 message 文本（文档化的契约，code 可能变化）。
      const msg = (d.error?.message || '').toLowerCase();
      const isKeyInvalid = d.status === 'error' && (d.error?.code === 4 || msg.includes('invalid api key') || msg.includes('invalid client'));
      if (d.status === 'ok' || (d.status === 'error' && !isKeyInvalid)) {
        return { ok: true };
      }
      const base = d.error?.message || '无效的 API Key';
      // 常见原因：粘贴的是个人 user key 而非应用 client key
      return { ok: false, error: `${base}（请确认使用的是 acoustid.org/my-applications 注册应用后获得的 "client" 密钥，而不是 acoustid.org/api-key 页面看到的个人 "user" 密钥）` };
    } catch (e) {
      return { ok: false, error: '网络错误: ' + e.message };
    }
  } },
];
