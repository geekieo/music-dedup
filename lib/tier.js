// lib/tier.js — Server-side scrape-status tier computation. SINGLE SOURCE OF
// TRUTH: both the library list (刮削 column icon + 刮削分类 filter) and the
// per-track ScrapeDialog badge read the `scrape_tier` value this file
// computes from the API, instead of each recomputing it independently.
//
// F9: they used to have two separate implementations — this file (using the
// real opencc-js Traditional↔Simplified converter) and a hand-rolled
// ~2700-character compact lookup table in public/app.js for browser use.
// The compact table was missing plenty of real-world characters (e.g. 鐘,
// 藉), so a file could satisfy the "繁简折叠精确匹配" filter (computed here,
// accurately) while its own per-track badge showed 模糊匹配 (computed in the
// browser, inaccurately) — the exact "filter says X but the badge says Y"
// bug reports this rewrite fixes structurally: there is now only one
// implementation, and the client displays what the server computed.
//
// Tiers (per user's simplified 3-tier spec):
//   green — 精确匹配（MusicBrainz/AcoustID 确认的录音，标题/艺术家/专辑三项一致）
//           且没有值得推荐写入的缺失字段
//   blue  — 同上的精确匹配，但有可推荐写入的缺失字段（年份/曲目号/流派等）
//   red   — 模糊匹配（match_basis !== 'exact'，或标题/艺术家/专辑三项中
//           任一项连繁简折叠后都对不上）
//   null  — 未刮削 / 无可用刮削数据
//
// ignoreScript (繁简忽略, 设置项 ignore_script_variant, 默认 true): 决定一个
// 仅繁简写法不同（例如 大笨钟/大笨鐘）的字段，是否计入"一致"从而进入
// 精确匹配（绿/蓝）；关闭后这类字段会被当作不一致，从而落入模糊匹配（红）。
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

// Mirrors public/app.js autoSelectFields' "would anything be recommended
// for write" check — doesn't need the full UI reason strings, just whether
// ANY field is worth recommending (drives green vs blue).
//
// F9 bugfix: the album check used to be a plain normCmp() (byte-level, no
// CJK folding) regardless of ignoreScript — so a file whose title/artist/
// album all only differed by Traditional/Simplified spelling (e.g.
// 看我72变/看我72變) still got flagged as "has a recommendable album write"
// even with 繁简忽略 turned on, incorrectly landing on blue ("精确匹配 ·
// 可写入") instead of green. It now uses the same fieldMatchTier()+
// ignoreScript logic as the exact-match check above, so a pure script-
// variant album spelling counts as "already matching" exactly when the
// tier computation itself would treat it that way.
function hasRecommendableWrites(file, scraped, ignoreScript) {
  if (scraped.album) {
    if (!file.album) return true;
    const albumMatches = ignoreScript ? fieldMatchTier(file.album, scraped.album) !== null : fieldMatchTier(file.album, scraped.album) === 'raw';
    if (!albumMatches) return true;
  }
  if (scraped.album_year && (!file.album_year || file.album_year === 0)) return true;
  if (scraped.album_year && file.album_year && file.album_year !== scraped.album_year) return true;
  if (scraped.track_number && (!file.track_number || file.track_number === 0)) return true;
  if (scraped.genre && !file.genre) return true;
  return false;
}

export function computeScrapeTier(file, scraped, ignoreScript = true) {
  if (!scraped || !scraped.title || scraped.source === 'none') return null;
  const tR = fieldMatchTier(file.title,  scraped.title);
  const aR = fieldMatchTier(file.artist, scraped.artist);
  const bR = fieldMatchTier(file.album,  scraped.album);
  const isExactField = r => ignoreScript ? r !== null : r === 'raw';
  const allExact = isExactField(tR) && isExactField(aR) && isExactField(bR);
  if (!allExact || scraped.match_basis !== 'exact') return 'red';
  return hasRecommendableWrites(file, scraped, ignoreScript) ? 'blue' : 'green';
}

export const TIER_ORDER = { green: 0, blue: 1, red: 2 }; // null/no-scrape sorts last
export function tierRank(tier) { return tier == null ? 3 : (TIER_ORDER[tier] ?? 3); }
