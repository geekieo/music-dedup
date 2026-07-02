// lib/tier.js — Server-side scrape-status tier computation.
//
// Mirrors the client-side logic in public/app.js (scrapeStatusTier /
// fieldMatchTier / autoSelectFields) but uses the REAL opencc-js converter
// (already a project dependency, used by scraper.js) instead of the client's
// compact single-character lookup table — so this is the more accurate of
// the two implementations. It exists purely to let the library list be
// SORTED by tier across the whole (server-paginated) result set, which the
// client cannot do on its own since it only ever holds one page of rows.
//
// Tiers (see public/app.js for the authoritative visual/UX definition):
//   green  — exact match (raw or Traditional/Simplified-folded) + complete
//   yellow — CJK-folded-only exact match + missing recommendable fields
//   blue   — raw-exact match + missing recommendable fields
//   red    — any field mismatch, or match_basis != 'exact'
//   null   — no usable scraped data
import * as OpenCC from 'opencc-js';

let _t2s = null;
function toSimplified(s) {
  if (!_t2s) _t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
  try { return _t2s(String(s || '')); } catch { return String(s || ''); }
}

const normCmp  = s => String(s || '').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g, '');
const normCmpS = s => toSimplified(normCmp(s));

// 'raw' | 'cjk' | null — mirrors public/app.js fieldMatchTier exactly
function fieldMatchTier(fileVal, scrapedVal) {
  if (!fileVal || !scrapedVal) return 'raw';
  const fn = normCmp(fileVal), sn = normCmp(scrapedVal);
  if (fn === fn && fn === sn) return 'raw';
  if (normCmpS(fileVal) === normCmpS(scrapedVal)) return 'cjk';
  return null;
}

// Minimal mirror of autoSelectFields' "would anything be recommended for
// write" check — doesn't need the full UI reason strings, just the booleans.
function hasRecommendableWrites(file, scraped, exact) {
  const junk = /热歌|慢摇|合辑|精选\d|^\d+首|网络/;
  // Album
  if (scraped.album) {
    if (!file.album) return true;
    if (normCmp(file.album) !== normCmp(scraped.album)) {
      if (exact) return true; // covers both plain-exact and junk-exact-overwrite cases
    }
  }
  // Year
  if (scraped.album_year && (!file.album_year || file.album_year === 0)) return true;
  if (scraped.album_year && file.album_year && file.album_year !== scraped.album_year && exact) return true;
  // Track
  if (scraped.track_number && (!file.track_number || file.track_number === 0)) return true;
  // Genre
  if (scraped.genre && !file.genre) return true;
  return false;
}

export function computeScrapeTier(file, scraped) {
  if (!scraped || !scraped.title || scraped.source === 'none') return null;
  const tR = fieldMatchTier(file.title,  scraped.title);
  const aR = fieldMatchTier(file.artist, scraped.artist);
  const bR = fieldMatchTier(file.album,  scraped.album);
  const anyMismatch = tR === null || aR === null || bR === null;
  const anyCJK       = tR === 'cjk' || aR === 'cjk' || bR === 'cjk';
  if (anyMismatch || scraped.match_basis !== 'exact') return 'red';
  const exact = true;
  const missing = hasRecommendableWrites(file, scraped, exact);
  if (!missing) return 'green';
  return anyCJK ? 'yellow' : 'blue';
}

export const TIER_ORDER = { green: 0, yellow: 1, blue: 2, red: 3 }; // null/no-scrape sorts last (4)
export function tierRank(tier) { return tier == null ? 4 : (TIER_ORDER[tier] ?? 4); }
