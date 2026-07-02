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
import { upsertScrapedMeta, getFilesNeedingScrape, getFilesNeedingAcoustidScrape } from './db.js';
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
// Priority:
// 1. If file has an album tag → find releases whose title matches, then among
//    those pick the EARLIEST (first-press preference).
// 2. No album tag → pick the earliest Official release (or earliest of all).
// "Earliest" avoids picking reissues / deluxe editions / remasters when the
// original 1st-press is available.
function releaseYear(rel) {
  const d = rel?.date;
  if (!d) return 9999;
  if (typeof d === 'object') return d.year || 9999;
  return parseInt(d) || 9999;
}

function pickRelease(rec, f) {
  const releases = rec.releases || [];
  if (!releases.length) return { release: null, albumSim: 0 };

  if (f.album) {
    // Score every release by how well its title matches the file's album tag
    const scored = releases.map(rel => {
      const sim = textSimForMatch(rel.title, f.album);
      const scr = scriptMatchScore(f.album, rel.title);
      return { rel, sim, score: sim * 0.75 + scr * 0.25 };
    });
    scored.sort((a, b) => b.score - a.score);
    const topScore = scored[0]?.score ?? 0;
    // Collect all releases within 10% of the best score — pick earliest among them
    const threshold = Math.max(0.4, topScore * 0.9);
    const candidates = scored.filter(s => s.score >= threshold);
    // Among equally-good album matches, prefer the earliest Official, then earliest overall
    const officials = candidates.filter(s => s.rel.status === 'Official');
    const pool = officials.length ? officials : candidates;
    pool.sort((a, b) => releaseYear(a.rel) - releaseYear(b.rel));
    const best = pool[0];
    if (best) return { release: best.rel, albumSim: best.sim };
  }

  // No album tag — pick earliest Official, falling back to earliest overall
  const officials = releases.filter(r => r.status === 'Official');
  const pool = officials.length ? officials : releases;
  pool.sort((a, b) => releaseYear(a) - releaseYear(b));
  return { release: pool[0] || null, albumSim: 0 };
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
  // Best genre: pick the highest-count genre/tag
  const genreList = rec.genres || rec.tags || [];
  const genre = genreList.length
    ? [...genreList].sort((a,b)=>(b.count||0)-(a.count||0))[0]?.name || null
    : null;
  return {
    source,
    mb_recording_id: rec.id,
    mb_release_id:   release?.id || null,
    title:           rec.title || f.title,
    artist:          rec['artist-credit']?.map(a => a.name || a.artist?.name).filter(Boolean).join(', ') || f.artist || null,
    album:           release?.title || null,
    album_year:      extractYear(release?.date),
    track_number:    extractTrackNumber(release),
    genre,
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
//
// F9 bugfix: this used to swallow EVERY failure (HTTP error, rate limit,
// invalid key, network error, unparseable body) into a single `return null`,
// indistinguishable from "AcoustID genuinely doesn't know this recording".
// That's how a systemic problem (e.g. every request 429-throttled, or an
// invalid client key) could silently present as "0 命中 / N 个" across an
// entire library with zero diagnostic trail. acoustidLookup now returns a
// small `{ ok, reason }` alongside the match (or null match), and the caller
// aggregates + surfaces reasons in the progress message / server log instead
// of just counting misses.
async function acoustidLookup(apiKey, fingerprint, duration, f) {
  if (!apiKey || !fingerprint) return { match: null, reason: 'no-key-or-fingerprint' };
  if (fingerprint.startsWith('META:')) return { match: null, reason: 'no-fingerprint' };
  try {
    const params = new URLSearchParams({
      client: apiKey, duration: Math.round(duration || 0),
      fingerprint, meta: 'recordings releases',
    });
    const res = await fetch(`${AID_BASE}/lookup?${params}`, { headers: { 'User-Agent': UA } });
    if (res.status === 429) return { match: null, reason: 'rate-limited' };
    if (!res.ok) return { match: null, reason: `http-${res.status}` };
    const data = await res.json();
    if (data.status !== 'ok') {
      // AcoustID error code 3 = invalid client key — this is the single most
      // common cause of a suspicious "0 hits across the whole library" run,
      // since a personal/user key (not an application/client key) will fail
      // this way on every single request.
      const code = data.error?.code;
      return { match: null, reason: code === 3 ? 'invalid-key' : `api-error-${code ?? '?'}` };
    }
    const result = data.results?.[0];
    if (!result) return { match: null, reason: 'no-results' };
    if (result.score < 0.7) return { match: null, reason: 'low-score' };
    const rec = result.recordings?.[0];
    if (!rec) return { match: null, reason: 'no-recording' };
    const releases = (rec.releases || []).map(r => ({ ...r, title: r.title }));
    const { release } = pickRelease({ ...rec, releases }, f);
    return { match: formatResult({ rec: { ...rec, score: result.score * 100 }, release, basis: 'exact', f, source: 'acoustid' }), reason: null };
  } catch (e) { return { match: null, reason: 'network-error:' + (e.message || e) }; }
}

// ── Single-file on-demand scrape ──────────────────────────────────────────
// Called when the user opens the ScrapeDialog and clicks "刮削匹配".
// Unlike runScrape (which processes a DB-queried batch with rate limiting),
// this does exactly ONE file immediately and returns the stored result.
export async function scrapeSingleFile(db, fileId, acoustidKey='') {
  const f = db.get('SELECT * FROM files WHERE id=?', [fileId]);
  if (!f) return null;
  let meta = null;
  // AcoustID requires Chromaprint (from fpcalc), NOT the internal Goertzel fingerprint
  if (acoustidKey && f.chromaprint) {
    const { match, reason } = await acoustidLookup(acoustidKey, f.chromaprint, f.fingerprint_duration||f.duration, f);
    meta = match;
    if (!meta) {
      if (reason && reason !== 'no-results' && reason !== 'low-score') console.warn(`[AcoustID] 单文件刮削未命中 (file ${f.id}): ${reason}`);
      await sleep(300);
    }
  } else if (acoustidKey && !f.chromaprint) {
    // No Chromaprint yet — fall through to MusicBrainz only
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
  let totalMatched=0, totalExact=0;

  // ── Phase A: AcoustID ────────────────────────────────────────────────────
  // Runs independently from MB — processes all files with fingerprints that
  // haven't been AcoustID-scraped yet (regardless of MB scrape status).
  // This lets users add an AcoustID key and re-run without re-downloading MB data.
  if (acoustidKey) {
    const aidFiles = getFilesNeedingAcoustidScrape(db);
    const aidTotal = aidFiles.length;
    if (aidTotal === 0) {
      onProgress({ phase:'scrape', pct:0, message:'AcoustID: 所有有声纹的文件均已处理' });
    } else {
      onProgress({ phase:'scrape', pct:0, message:`AcoustID 阶段：处理 ${aidTotal.toLocaleString()} 个有声纹的文件...` });
      let aidDone=0, aidHit=0;
      const missReasons=new Map(); // reason -> count, for a diagnosable completion summary
      let consecutiveFailures=0, invalidKeyStop=false;
      for (const f of aidFiles) {
        if (onAbort()) break;
        await onPause();
        // AcoustID requires Chromaprint format fingerprint (from fpcalc), NOT our Goertzel fingerprint
        if (!f.chromaprint) {
          aidDone++;
          continue; // file has no Chromaprint yet — needs fp step with fpcalc installed
        }
        const { match, reason } = await acoustidLookup(acoustidKey, f.chromaprint, f.fingerprint_duration||f.duration, f);
        if (match) {
          upsertScrapedMeta(db, { ...match, file_id: f.id });
          aidHit++;
          if (match.match_basis === 'exact') totalExact++;
          totalMatched++;
          consecutiveFailures=0;
        } else {
          if (reason) missReasons.set(reason, (missReasons.get(reason)||0)+1);
          // An invalid client key (or a hard block) will fail identically on
          // every single request — bail out early instead of burning through
          // the whole library at 0% just to report the same error thousands
          // of times. A few genuine misses/rate-limit blips don't trigger this.
          if (reason==='invalid-key') { invalidKeyStop=true; consecutiveFailures=0; }
          else if (reason==='rate-limited'||(reason&&reason.startsWith('http-'))||(reason&&reason.startsWith('network-error'))) consecutiveFailures++;
          else consecutiveFailures=0;
        }
        aidDone++;
        // AcoustID's documented limit is 3 req/sec; 350ms keeps us under that
        // with margin (250ms = 4/sec was OVER the limit and could 429 every
        // single request, silently producing "0 命中" with no visible cause).
        await sleep(350);
        if (invalidKeyStop || consecutiveFailures>=30) {
          onProgress({ phase:'scrape', pct: Math.round(aidDone/aidTotal*50),
            message: invalidKeyStop
              ? `AcoustID 已中止：Key 无效（错误代码 3）。请在设置中重新验证 AcoustID API Key —— 注意需要 acoustid.org 的"应用/client"密钥，不是登录后看到的个人密钥。`
              : `AcoustID 已中止：连续 ${consecutiveFailures} 次请求失败（限流/网络错误），请稍后重试。` });
          break;
        }
        if (aidDone % 20 === 0 || aidDone === aidTotal) {
          onProgress({ phase:'scrape', pct: Math.round(aidDone/aidTotal*50),
            message:`AcoustID: ${aidDone}/${aidTotal}，命中 ${aidHit} 个` });
        }
      }
      if (!invalidKeyStop && consecutiveFailures<30) {
        const reasonSummary=[...missReasons.entries()].filter(([r])=>r!=='no-results'&&r!=='low-score')
          .map(([r,n])=>`${r}×${n}`).join('，');
        onProgress({ phase:'scrape', pct:50, message:`AcoustID 完成：${aidTotal} 个，命中 ${aidHit} 个${reasonSummary?`（异常：${reasonSummary}）`:''}` });
      }
    }
  }

  // ── Phase B: MusicBrainz ─────────────────────────────────────────────────
  // Smart mode: only processes files with NO scraped data at all.
  // Force mode: processes all files.
  // Files already scraped by AcoustID (Phase A) are skipped in smart mode.
  const mbFiles = getFilesNeedingScrape(db, smartScan);
  const mbTotal = mbFiles.length;

  if (mbTotal === 0) {
    const msg = acoustidKey
      ? 'MusicBrainz: 所有文件已处理（智能模式）'
      : '元数据刮削无需更新（智能模式：所有文件已刮削）';
    onProgress({ phase:'scrape', pct:100, message: msg });
    return totalMatched;
  }

  onProgress({ phase:'scrape', pct:acoustidKey?50:0, message:`MusicBrainz 阶段：处理 ${mbTotal.toLocaleString()} 个文件...` });

  let mbDone=0, mbMatched=0, mbExact=0, mbFailed=0;

  for (const f of mbFiles) {
    if (onAbort()) break;
    await onPause();

    const meta = await mbMatch(f);
    await sleep(1100); // MusicBrainz: max 1 req/sec

    if (meta) {
      upsertScrapedMeta(db, { ...meta, file_id: f.id });
      mbMatched++; totalMatched++;
      if (meta.match_basis === 'exact') { mbExact++; totalExact++; }
    } else {
      upsertScrapedMeta(db, { file_id:f.id, source:'none', title:null, artist:null, album:null,
        confidence:0, match_basis:'fuzzy', scraped_at:Date.now() });
      mbFailed++;
    }

    mbDone++;
    if (mbDone % 10 === 0 || mbDone === mbTotal) {
      const pctBase = acoustidKey ? 50 : 0;
      onProgress({ phase:'scrape', pct: pctBase + Math.round(mbDone/mbTotal*(100-pctBase)),
        message:`MB 刮削: ${mbDone}/${mbTotal} (精确 ${mbExact}，模糊 ${mbMatched-mbExact}，未找到 ${mbFailed})`,
        filesProcessed: mbDone });
    }
  }

  onProgress({ phase:'scrape', pct:100,
    message:`刮削完成：MB ${mbTotal} 个文件，精确 ${mbExact} 个，模糊 ${mbMatched-mbExact} 个，未找到 ${mbFailed} 个`,
    matched: totalMatched, exact: totalExact, failed: mbFailed });
  return totalMatched;
}
