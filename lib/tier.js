// lib/tier.js — Server-side scrape-status tier computation. SINGLE SOURCE OF
// TRUTH: both the library list and ScrapeDialog read the server-computed
// `scrape_tier` value, instead of each recomputing independently (the old
// browser-side ~2700-char CJK lookup table missed characters like 鐘/藉).
//
// Tiers (per user's simplified 3-tier spec):
//   green — 精确匹配（MusicBrainz/AcoustID 确认的录音，标题/艺术家/专辑三项一致）
//           且没有值得推荐写入的缺失字段
//   blue  — 同上的精确匹配，但有可推荐写入的缺失字段（年份/曲目号/流派等）
//   yellow — 模糊匹配（match_basis !== 'exact'，或标题/艺术家/专辑三项中
//           任一项连繁简折叠后都对不上），但有可写入字段（年份/曲目号/流派）
//   red    — 模糊匹配且无可写入字段，基本上没有实用信息，可直接忽略
//   null   — 未刮削 / 无可用刮削数据
//
// ignoreScript (繁简忽略, 设置项 ignore_script_variant, 默认 true): 决定一个
// 仅繁简写法不同（例如 大笨钟/大笨鐘）的字段，是否计入"一致"从而进入
// 精确匹配（绿/蓝）；关闭后这类字段会被当作不一致，从而落入模糊匹配（黄）。
import * as OpenCC from 'opencc-js';

let _t2s = null;
function toSimplified(s) {
  if (!_t2s) _t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
  try { return _t2s(String(s || '')); } catch { return String(s || ''); }
}

const normCmp  = s => String(s || '').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g, '');
const normCmpS = s => toSimplified(normCmp(s));

// 'raw' (byte-identical after normCmp) | 'cjk' (only equal after T↔S folding) | null (mismatch)
// Either side being empty is treated as neutral ('raw' — no evidence of conflict).
function fieldMatchTier(fileVal, scrapedVal) {
  if (!fileVal || !scrapedVal) return 'raw';
  const fn = normCmp(fileVal), sn = normCmp(scrapedVal);
  if (fn === sn) return 'raw';
  if (normCmpS(fileVal) === normCmpS(scrapedVal)) return 'cjk';
  return null;
}

// Drives green vs blue vs yellow vs red: are there fields worth writing?
// Only considers album_year / track_number / genre — title/artist/album are
//身份字段 used solely for exact/fuzzy classification, not for writability.
function hasWritableFields(file, scraped) {
  if (scraped.album_year && (!file.album_year || file.album_year === 0)) return true;
  if (scraped.album_year && file.album_year && file.album_year !== scraped.album_year) return true;
  if (scraped.track_number && (!file.track_number || file.track_number === 0)) return true;
  if (scraped.genre && !file.genre) return true;
  return false;
}

// Legacy alias — kept so existing callers don't break.
function hasRecommendableWrites(file, scraped, ignoreScript) {
  // Old logic included album; new callers should use hasWritableFields.
  // For backward compat, check album too.
  if (scraped.album) {
    if (!file.album) return true;
    const albumMatches = ignoreScript ? fieldMatchTier(file.album, scraped.album) !== null : fieldMatchTier(file.album, scraped.album) === 'raw';
    if (!albumMatches) return true;
  }
  return hasWritableFields(file, scraped);
}

export function computeScrapeTier(file, scraped, ignoreScript = true) {
  // "精确匹配" requires title, artist, AND album to all exist in the scraped
  // data AND match the file. A scraped source missing any of the three is
  // automatically 模糊匹配 (yellow), not 精确匹配.
  if (!scraped || scraped.source === 'none') return null;
  if (!scraped.title && !scraped.artist && !scraped.album) return null;
  const hasAllThree = !!(scraped.title && scraped.artist && scraped.album);
  const tR = fieldMatchTier(file.title,  scraped.title);
  const aR = fieldMatchTier(file.artist, scraped.artist);
  const bR = fieldMatchTier(file.album,  scraped.album);
  const isExactField = r => ignoreScript ? r !== null : r === 'raw';
  const allExact = hasAllThree && isExactField(tR) && isExactField(aR) && isExactField(bR);
  if (!allExact || scraped.match_basis !== 'exact') {
    return hasWritableFields(file, scraped) ? 'yellow' : 'red';
  }
  return hasRecommendableWrites(file, scraped, ignoreScript) ? 'blue' : 'green';
}

export const TIER_ORDER = { green: 0, blue: 1, yellow: 2, red: 3 }; // null/no-scrape sorts last
export function tierRank(tier) { return tier == null ? 4 : (TIER_ORDER[tier] ?? 4); }
