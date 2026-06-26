// lib/scraper.js — Music metadata scraping via MusicBrainz + optional AcoustID
//
// MATCHING PHILOSOPHY (see also rules.js metaScore / matcher.js phase 2c):
// Scraped 刮削数据 ends up doing three different jobs downstream — confirming
// a duplicate-group union, feeding the keep/discard decision, and (if the
// person applies it) overwriting 文件属性. Each of those is only as
// trustworthy as the match that produced it, so every scrape result is
// tagged with a `match_basis`:
//   'exact'  — the file's own attributes (title + artist + at least one of
//              album/duration/track) corroborate a SPECIFIC MusicBrainz
//              recording+release. Safe to trust for grouping/overwriting.
//   'fuzzy'  — metadata was too sparse to corroborate anything beyond a
//              plain title(+artist) text search; this is a best-effort
//              guess only, used as a last resort, and must never be treated
//              as third-party confirmation or used to overwrite a field
//              that's already populated.
import { upsertScrapedMeta, getFilesNeedingScrape } from './db.js';
import * as OpenCC from 'opencc-js';

const MB_BASE  = 'https://musicbrainz.org/ws/2';
const AID_BASE = 'https://api.acoustid.org/v2';
const UA       = 'MusicDedup/1.3 (https://github.com/musicdedup)';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Text similarity (script-agnostic, no segmentation needed) ─────────────
// Character-bigram Dice coefficient. Works fine for short CJK strings (where
// word segmentation isn't reliable) as well as Latin text.
function normText(s) {
  return (s || '').toLowerCase()
    .replace(/[\s\u3000()（）\[\]【】「」『』·\-_,.!?！？、，。:：;；'"]/g, '');
}
function bigrams(s) {
  const out = new Set();
  if (s.length < 2) { if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
function textSim(a, b) {
  a = normText(a); b = normText(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a), B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size || 1);
}
// Script-normalized similarity for matching/comparison purposes ONLY — this
// never touches anything that gets stored. It exists so a pure script
// variant (伤 vs 傷) isn't scored as a content mismatch when corroborating a
// candidate against the file's own album/title text.
function textSimForMatch(a, b) {
  return textSim(toSimplifiedForCompare(a || ''), toSimplifiedForCompare(b || ''));
}

// ── Script detection (Simplified vs Traditional) — DETECTION ONLY ─────────
// This never mutates any text that gets stored; it's purely a signal used to
// prefer the candidate release whose script matches the local file's own,
// e.g. so a Simplified-tagged file doesn't get matched to a Traditional/HK
// release (mainland vs Taiwan/HK/international) when a same-script
// alternative is available among the candidates.
const hasHan = s => /[\u4e00-\u9fff]/.test(s || '');
let _t2s = null, _s2t = null;
function toSimplifiedForCompare(s) { if (!_t2s) _t2s = OpenCC.Converter({ from:'tw', to:'cn' }); try { return _t2s(s); } catch { return s; } }
function toTraditionalForCompare(s) { if (!_s2t) _s2t = OpenCC.Converter({ from:'cn', to:'tw' }); try { return _s2t(s); } catch { return s; } }
function scriptOf(s) {
  if (!s || !hasHan(s)) return null;
  const simp = toSimplifiedForCompare(s), trad = toTraditionalForCompare(s);
  if (s === simp && s !== trad) return 'cn';
  if (s === trad && s !== simp) return 'tw';
  return null; // text has no simplified/traditional distinction (or conversion no-op) — no signal
}
// 0/0.5/1 — 1 if both sides resolve to the same script, 0.5 if either side
// has no script signal (no penalty, just no bonus), 0 if they actively differ.
function scriptMatchScore(localText, candidateText) {
  const a = scriptOf(localText), b = scriptOf(candidateText);
  if (!a || !b) return 0.5;
  return a === b ? 1 : 0;
}

function durationScore(localSec, mbMs) {
  if (!localSec || !mbMs) return null;
  const diff = Math.abs(localSec - mbMs / 1000);
  if (diff <= 3)  return 1;
  if (diff <= 8)  return 0.6;
  if (diff <= 20) return 0.2;
  return 0;
}

// ── Pick the best release within one MB recording ─────────────────────────
// Prefers (in order of how much local data is available to corroborate
// with): album-title similarity, then script match, then official+earliest.
function pickRelease(rec, f) {
  const releases = rec.releases || [];
  if (!releases.length) return { release: null, albumSim: 0 };
  if (f.album) {
    let best = null, bestScore = -1, bestSim = 0;
    for (const rel of releases) {
      const sim = textSimForMatch(rel.title, f.album);
      const scr = scriptMatchScore(f.album, rel.title);
      const combined = sim * 0.75 + scr * 0.25;
      if (combined > bestScore) { bestScore = combined; best = rel; bestSim = sim; }
    }
    if (best) return { release: best, albumSim: bestSim };
  }
  const officials = releases.filter(r => r.status === 'Official');
  const pool = officials.length ? officials : releases;
  const sorted = [...pool].sort((a, b) => (a.date || '9999') < (b.date || '9999') ? -1 : 1);
  return { release: sorted[0] || null, albumSim: 0 };
}

// AcoustID returns date as {year,month,day}; MusicBrainz returns "2016-12-09"
function extractYear(dateField) {
  if (!dateField) return 0;
  if (typeof dateField === 'object') return dateField.year || 0;   // AcoustID
  return parseInt(dateField) || 0;                                  // MusicBrainz
}
// Extract track number from release media; handles both 'media' (MB) and 'mediums' (AcoustID)
function extractTrackNumber(release) {
  const track = release?.media?.[0]?.track?.[0]?.number     // MusicBrainz search
             || release?.mediums?.[0]?.tracks?.[0]?.position; // AcoustID (position is 1-based)
  return track ? parseInt(track) || 0 : 0;
}

function formatResult({ rec, release, basis, f, source='musicbrainz' }) {
  return {
    source,
    mb_recording_id: rec.id,
    mb_release_id:   release?.id || null,
    title:           rec.title || f.title,
    artist:          rec['artist-credit']?.map(a => a.name || a.artist?.name).filter(Boolean).join(', ') || f.artist || null,
    album:           release?.title || null,
    album_year:      extractYear(release?.date),
    track_number:    extractTrackNumber(release),
    confidence:      (rec.score || 0) / 100,
    match_basis:     basis,
  };
}

// ── MusicBrainz candidate search ───────────────────────────────────────────
async function mbSearchCandidates(title, artist) {
  if (!title) return [];
  const q = encodeURIComponent(`recording:"${title}"${artist ? ' AND artist:"' + artist + '"' : ''}`);
  try {
    const res = await fetch(`${MB_BASE}/recording?query=${q}&limit=8&fmt=json`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.recordings || [];
  } catch { return []; }
}

// ── Decide a match from candidates using the file's own attributes ────────
// f: { title, artist, album, track_number, duration }
function selectMatch(f, candidates) {
  if (!candidates.length) return null;
  const top = candidates[0], second = candidates[1];
  // Low score gap between #1 and #2 → multiple plausible hits (e.g. the same
  // title performed/released more than once) → text relevance alone can't
  // be trusted to pick the right one.
  const ambiguous = !!second && (top.score - second.score) < 15;
  const hasRichMeta = !!(f.album || f.duration);

  if (!ambiguous && top.score >= 80) {
    const { release, albumSim } = pickRelease(top, f);
    const basis = hasRichMeta ? 'exact' : 'fuzzy';
    return formatResult({ rec: top, release, basis, f });
  }

  if (hasRichMeta) {
    let best = null, bestScore = -1, bestRelease = null, bestAlbumSim = 0, bestDur = null;
    for (const rec of candidates) {
      const { release, albumSim } = pickRelease(rec, f);
      const dScore = durationScore(f.duration, rec.length);
      const trackBonus = (f.track_number && release?.media?.[0]?.track?.[0]?.number
        && parseInt(release.media[0].track[0].number) === f.track_number) ? 0.15 : 0;
      const combined = (rec.score || 0) / 100 * 0.3 + albumSim * 0.5 + (dScore ?? 0) * 0.2 + trackBonus;
      if (combined > bestScore) { bestScore = combined; best = rec; bestRelease = release; bestAlbumSim = albumSim; bestDur = dScore; }
    }
    // Require real corroboration before committing to a disambiguated guess —
    // refusing to pick is better than confidently assigning the wrong one
    // (this is exactly what was going wrong before: 4 different files all
    // converging on the same generic top-hit because nothing checked album).
    if (best && bestScore >= 0.55 && (bestAlbumSim >= 0.45 || (bestDur ?? 0) >= 0.6)) {
      return formatResult({ rec: best, release: bestRelease, basis: 'exact', f });
    }
    return null; // ambiguous and uncorroborated — don't guess
  }

  // Sparse local metadata (no album, no duration — e.g. only a filename-
  // derived title) — fall back to the old loose top-hit behavior.
  if (top.score >= 70) {
    const { release } = pickRelease(top, f);
    return formatResult({ rec: top, release, basis: 'fuzzy', f });
  }
  return null;
}

async function mbMatch(f) {
  const candidates = await mbSearchCandidates(f.title, f.artist);
  return selectMatch(f, candidates);
}

// ── AcoustID lookup (requires client key + fingerprint) ───────────────────
// Audio-fingerprint-verified, so always 'exact' basis when it returns a hit.
async function acoustidLookup(apiKey, fingerprint, duration, f) {
  if (!apiKey || !fingerprint || fingerprint.startsWith('META:')) return null;
  try {
    const params = new URLSearchParams({
      client: apiKey, duration: Math.round(duration || 0),
      fingerprint, meta: 'recordings releases',
    });
    const res = await fetch(`${AID_BASE}/lookup?${params}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'ok') return null;
    const result = data.results?.[0];
    if (!result || result.score < 0.7) return null;
    const rec = result.recordings?.[0];
    if (!rec) return null;
    const releases = (rec.releases || []).map(r => ({ ...r, title: r.title }));
    const { release } = pickRelease({ ...rec, releases }, f);
    return formatResult({ rec: { ...rec, score: result.score * 100 }, release, basis: 'exact', f, source: 'acoustid' });
  } catch { return null; }
}

// ── Single-file on-demand scrape ──────────────────────────────────────────
// Called when the user opens the ScrapeDialog and clicks "刮削匹配".
// Unlike runScrape (which processes a DB-queried batch with rate limiting),
// this does exactly ONE file immediately and returns the stored result.
export async function scrapeSingleFile(db, fileId, acoustidKey='') {
  const f = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!f) return null;
  let meta = null;
  if (acoustidKey && f.fingerprint) {
    meta = await acoustidLookup(acoustidKey, f.fingerprint, f.fingerprint_duration||f.duration, f);
    if (!meta) await sleep(300); // brief pause before falling back to MB
  }
  if (!meta) meta = await mbMatch(f);
  if (meta) {
    upsertScrapedMeta(db, { ...meta, file_id: f.id });
  } else {
    upsertScrapedMeta(db, { file_id:f.id, source:'none', title:null, artist:null, album:null, confidence:0, match_basis:'fuzzy', scraped_at:Date.now() });
  }
  return db.get('SELECT * FROM scraped_meta WHERE file_id=?', [fileId]) || null;
}

// ── Main scrape runner ────────────────────────────────────────────────────
export async function runScrape(db, { smartScan=true, acoustidKey='', onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  const files = getFilesNeedingScrape(db, smartScan);
  const total = files.length;

  if (total === 0) {
    onProgress({ phase:'scrape', pct:100, message:'元数据刮削无需更新（智能模式：所有文件已刮削）' });
    return 0;
  }

  onProgress({ phase:'scrape', pct:0, message:`开始刮削 ${total.toLocaleString()} 个文件的权威元数据...` });

  let done=0, matched=0, exact=0, failed=0;

  for (const f of files) {
    if (onAbort()) break;
    await onPause();
    if (onAbort()) break;

    let meta = null;
    if (acoustidKey && f.fingerprint) {
      meta = await acoustidLookup(acoustidKey, f.fingerprint, f.fingerprint_duration||f.duration, f);
      if (meta) {
        onProgress({ phase:'scrape', pct: Math.round(done/total*100), message:`AcoustID 匹配成功: ${f.title || f.path}` });
      }
      await sleep(200);
    } else if (acoustidKey && !f.fingerprint) {
      onProgress({ phase:'scrape', pct: Math.round(done/total*100), message:`跳过 AcoustID（无声纹）: ${f.title || f.path}，请先执行声纹匹配` });
    }
    if (!meta) {
      meta = await mbMatch(f);
      await sleep(1100); // MusicBrainz: max 1 req/sec
    }

    if (meta) {
      // Stored verbatim — no script conversion. The scraped text's own
      // script (Simplified/Traditional) is meaningful provenance (mainland
      // vs Taiwan/HK/international release) and silently flipping it would
      // both destroy that signal and risk applying the wrong script to a
      // file that didn't ask for it.
      upsertScrapedMeta(db, { ...meta, file_id: f.id });
      matched++;
      if (meta.match_basis === 'exact') exact++;
    } else {
      upsertScrapedMeta(db, { file_id:f.id, source:'none', title:null, artist:null, album:null, confidence:0, match_basis:'fuzzy' });
      failed++;
    }

    done++;
    if (done % 10 === 0 || done === total) {
      onProgress({ phase:'scrape', pct: Math.round(done/total*100),
        message:`刮削: ${done}/${total} (精确匹配 ${exact}，模糊匹配 ${matched-exact}，未找到 ${failed})`, filesProcessed:done });
    }
  }

  onProgress({ phase:'scrape', pct:100,
    message:`刮削完成：${total} 个文件，精确匹配 ${exact} 个，模糊匹配 ${matched-exact} 个，未找到 ${failed} 个`,
    matched, exact, failed });
  return matched;
}
