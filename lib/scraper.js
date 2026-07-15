// lib/scraper.js — Music metadata scraping via MusicBrainz + optional AcoustID
//
// MATCHING PHILOSOPHY (see also rules.js metaScore / matcher.js 步骤8):
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
import { upsertScrapedMeta, getFilesNeedingScrape, getFilesNeedingAcoustidScrape, updateFileAcoustidChecked, updateFileMbChecked, getScrapedMeta } from './db.js';
import * as OpenCC from 'opencc-js';
import { Progress } from './progress.js';

const MB_BASE  = 'https://musicbrainz.org/ws/2';
const AID_BASE = 'https://api.acoustid.org/v2';
const UA       = 'MusicDedup (standalone)';

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
  // Recording duration: MB returns `length` in ms; AcoustID may not include it.
  const duration = rec.length ? Math.round(rec.length / 1000) : null;
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
    duration,
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

  if (!ambiguous && top.score >= 80) {
    const { release, albumSim } = pickRelease(top, f);
    // Exact requires real corroboration: album text match or tight duration+score.
    const durScore = durationScore(f.duration, top.length);
    const corroborated = (f.album && albumSim >= 0.6) || ((durScore ?? 0) >= 0.8 && top.score >= 90);
    const basis = corroborated ? 'exact' : 'fuzzy';
    return formatResult({ rec: top, release, basis, f });
  }

  const hasRichMeta = !!(f.album || f.duration);
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
    // Require real corroboration before committing to a disambiguated pick.
    if (best && bestScore >= 0.55 && (bestAlbumSim >= 0.45 || (bestDur ?? 0) >= 0.6)) {
      // Album corroboration → exact; duration-only on ambiguous result → fuzzy.
      const basis = bestAlbumSim >= 0.45 ? 'exact' : 'fuzzy';
      return formatResult({ rec: best, release: bestRelease, basis, f });
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

// MusicBrainz's /recording search endpoint embeds each candidate recording's
// `releases` array, but that list isn't guaranteed complete — for a track
// re-released many times (reissues, greatest-hits, remasters), the search index
// can omit the earliest/original release entirely. This fetches the recording's
// FULL release list directly so pickRelease() can select the true earliest.
async function mbFetchAllReleases(recordingId) {
  try {
    const res = await fetch(`${MB_BASE}/recording/${recordingId}?inc=releases&fmt=json`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.releases || null;
  } catch { return null; }
}

async function mbMatch(f) {
  const candidates = await mbSearchCandidates(f.title, f.artist);
  const meta = selectMatch(f, candidates);
  if (meta && f.album && meta.match_basis === 'exact' && meta.mb_recording_id) {
    await sleep(1000); // MusicBrainz: 1 req/sec
    const fullReleases = await mbFetchAllReleases(meta.mb_recording_id);
    if (fullReleases && fullReleases.length) {
      const { release } = pickRelease({ releases: fullReleases }, f);
      if (release) {
        const newYear = extractYear(release.date);
        if (newYear && (!meta.album_year || newYear < meta.album_year)) {
          meta.album_year   = newYear;
          meta.mb_release_id= release.id;
          meta.album         = release.title || meta.album;
          meta.track_number  = extractTrackNumber(release) || meta.track_number;
        }
      }
    }
  }
  return meta;
}

// ── AcoustID lookup (requires client key + fingerprint) ───────────────────
// Returns { match, reason } so callers can aggregate failure reasons instead
// of treating every miss as "unknown recording". Uses POST because long
// fingerprints can exceed GET URL length limits on some proxies.
async function acoustidLookup(apiKey, fingerprint, duration, f) {
  if (!apiKey || !fingerprint) return { match: null, reason: 'no-key-or-fingerprint' };
  if (fingerprint.startsWith('META:')) return { match: null, reason: 'no-fingerprint' };
  const roundedDuration = Math.round(duration || 0);
  if (roundedDuration <= 0) return { match: null, reason: 'no-duration' };
  try {
    const body = new URLSearchParams({
      client: apiKey, duration: String(roundedDuration),
      // Include releasegroups + tracks for album/year/track_number.
      // AcoustID's lookup API does not expose genre/tag data.
      fingerprint, meta: 'recordings releasegroups releases tracks',
    });
    const res = await fetch(`${AID_BASE}/lookup`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (res.status === 429) return { match: null, reason: 'rate-limited' };
    let data;
    const rawText = await res.text();
    try { data = JSON.parse(rawText); }
    catch {
      return { match: null, reason: `http-${res.status}${rawText ? ':' + rawText.slice(0,200).replace(/\s+/g,' ').trim() : ''}` };
    }
    if (data.status !== 'ok') {
      const code = data.error?.code;
      const msg  = (data.error?.message || '').toLowerCase();
      const isKeyInvalid = code === 4 || msg.includes('invalid api key') || msg.includes('invalid client');
      return { match: null, reason: isKeyInvalid ? 'invalid-key' : `api-error-${code ?? '?'}:${data.error?.message||''}${!res.ok?` (http ${res.status})`:''}` };
    }
    const result = data.results?.[0];
    if (!result) return { match: null, reason: 'no-results' };
    if (result.score < 0.7) return { match: null, reason: 'low-score' };
    const rec = result.recordings?.[0];
    if (!rec) return { match: null, reason: 'no-recording' };
    const directReleases = rec.releases || [];
    const groupReleases = (rec.releasegroups || []).flatMap(rg => rg.releases || []);
    const releases = [...directReleases, ...groupReleases].map(r => ({ ...r, title: r.title }));
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

  // ── AcoustID (audio-fingerprint verified, requires fpcalc) ───────────
  if (acoustidKey && f.chromaprint) {
    const { match, reason } = await acoustidLookup(acoustidKey, f.chromaprint, f.fingerprint_duration||f.duration, f);
    if (match) {
      upsertScrapedMeta(db, { ...match, file_id: f.id });
    } else {
      upsertScrapedMeta(db, { file_id: f.id, source: 'acoustid', title: null,
        artist: null, album: null, confidence: 0, match_basis: 'fuzzy', scraped_at: Date.now() });
      await sleep(300);
    }
  }

  // ── MusicBrainz (text-search based, always available) ────────────────
  const mbMeta = await mbMatch(f);
  if (mbMeta) {
    upsertScrapedMeta(db, { ...mbMeta, file_id: f.id });
  } else {
    upsertScrapedMeta(db, { file_id: f.id, source: 'musicbrainz', title: null,
      artist: null, album: null, confidence: 0, match_basis: 'fuzzy', scraped_at: Date.now() });
  }

  return getScrapedMeta(db, fileId);
}

// ── Main scrape runner ────────────────────────────────────────────────────
export async function runScrape(db, { smartScan=true, retryMissed=false, acoustidKey='', onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  let totalMatched=0, totalExact=0;
  const prog = new Progress(onProgress);

  // ── Phase A: AcoustID ────────────────────────────────────────────────────
  if (acoustidKey) {
    const aidFiles = getFilesNeedingAcoustidScrape(db, { smartScan, retryMissed });
    const aidTotal = aidFiles.length;

    const totalWithChroma = (db.get("SELECT COUNT(*) n FROM files WHERE chromaprint IS NOT NULL AND title IS NOT NULL AND title!=''")||{n:0}).n;
    const alreadyChecked = (db.get("SELECT COUNT(*) n FROM files WHERE chromaprint IS NOT NULL AND acoustid_checked_at IS NOT NULL")||{n:0}).n;
    const alreadyHit = (db.get("SELECT COUNT(*) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE f.chromaprint IS NOT NULL AND sm.source='acoustid'")||{n:0}).n;
    const pending = totalWithChroma - alreadyChecked;

    if (aidTotal === 0) {
      const parts = [`共 ${totalWithChroma} 个有声纹文件`];
      if (totalWithChroma === 0) {
        parts.length = 0;
        parts.push('没有文件具备 Chromaprint 声纹（需安装 fpcalc 并运行声纹提取）');
      } else if (retryMissed) {
        parts.push(`${alreadyHit} 个已 AcoustID 命中（跳过），${totalWithChroma - alreadyHit} 个可重试`);
        if (totalWithChroma - alreadyHit === 0) parts.push('所有有声纹文件均已命中，无需重试');
      } else if (smartScan) {
        parts.push(`${alreadyChecked} 个已检查，${pending} 个待处理`);
        if (pending === 0) parts.push('所有文件均已通过 AcoustID 检查');
      }
      prog.emit({ phase:'scrape', pct:0, level:'ok', message:`AcoustID 刮削: 无需处理（${parts.join('，')}）` });
    } else {
      const modeLabel = !smartScan ? '强制重扫' : retryMissed ? '未命中重试' : '智能模式';
      prog.emit({ phase:'scrape', pct:0, level:'info', message:`开始AcoustID 刮削（${modeLabel}，${aidTotal} 个文件）...` });
      let aidDone=0, aidHit=0;
      const missReasons=new Map();
      let consecutiveFailures=0, invalidKeyStop=false;
      const lastFailReasons=[];
      for (const f of aidFiles) {
        if (onAbort()) break;
        await onPause();
        if (!f.chromaprint) {
          updateFileAcoustidChecked(db, f.id);
          aidDone++;
          continue;
        }
        const { match, reason } = await acoustidLookup(acoustidKey, f.chromaprint, f.fingerprint_duration||f.duration, f);
        if (match) {
          upsertScrapedMeta(db, { ...match, file_id: f.id });
          aidHit++;
          if (match.match_basis === 'exact') totalExact++;
          totalMatched++;
          consecutiveFailures=0;
          updateFileAcoustidChecked(db, f.id);
        } else {
          if (reason) {
            missReasons.set(reason, (missReasons.get(reason)||0)+1);
            lastFailReasons.push(reason);
            if (lastFailReasons.length>3) lastFailReasons.shift();
          }
          const isTransient = reason === 'rate-limited'
            || (reason && reason.startsWith('http-'))
            || (reason && reason.startsWith('network-error'));
          const isDefinitive = reason === 'no-results' || reason === 'low-score'
            || reason === 'no-recording' || reason === 'no-duration';
          if (isDefinitive) updateFileAcoustidChecked(db, f.id);

          if (reason==='invalid-key') { invalidKeyStop=true; consecutiveFailures=0; }
          else if (isTransient) consecutiveFailures++;
          else consecutiveFailures=0;
        }
        aidDone++;
        await sleep(350);
        if (invalidKeyStop || consecutiveFailures>=30) {
          prog.emit({ phase:'scrape', pct:Math.round(aidDone/aidTotal*50), level:'err',
            message: invalidKeyStop
              ? `AcoustID 已中止：Key 无效（错误代码 4，invalid API key）。请在设置中重新验证 AcoustID API Key —— 需要 acoustid.org/my-applications 注册应用后获得的"client"密钥，不是 acoustid.org/api-key 页面看到的个人密钥。`
              : `AcoustID 已中止：连续 ${consecutiveFailures} 次请求失败。最近的错误详情：${lastFailReasons.join('｜') || '（无）'}` });
          break;
        }
        if (aidDone % 20 === 0 || aidDone === aidTotal) {
          prog.emit({ phase:'scrape', pct:Math.round(aidDone/aidTotal*50), level:'ok',
            message:`AcoustID 刮削: ${aidDone} / ${aidTotal}，命中 ${aidHit} 个` });
        }
      }
      if (!invalidKeyStop && consecutiveFailures<30) {
        const noResults = missReasons.get('no-results') || 0;
        const lowScore = missReasons.get('low-score') || 0;
        const noRecording = missReasons.get('no-recording') || 0;
        const transient = [...missReasons.entries()].filter(([r])=>r.startsWith('http-')||r.startsWith('network-error')||r==='rate-limited');
        const parts = [`${aidTotal} 个，命中 ${aidHit} 个`];
        if (noResults > 0) parts.push(`${noResults} 个未在 AcoustID 数据库`);
        if (lowScore > 0) parts.push(`${lowScore} 个匹配分数过低`);
        if (noRecording > 0) parts.push(`${noRecording} 个 AcoustID 命中但无关联 MusicBrainz 录音`);
        if (transient.length > 0) {
          const transientTotal = transient.reduce((s,[,n])=>s+n, 0);
          parts.push(`⚠ ${transientTotal} 个临时错误（下次智能扫描将重试）：${transient.map(([r,n])=>`${r}×${n}`).join('，')}`);
        }
        prog.emit({ phase:'scrape', pct:50, level:'ok', message:`AcoustID 刮削完成：${parts.join('，')}` });
      }
    }
  }

  // ── Phase B: MusicBrainz ─────────────────────────────────────────────────
  const mbFiles = getFilesNeedingScrape(db, { smartScan, retryMissed });
  const mbTotal = mbFiles.length;

  const totalWithTitle = (db.get("SELECT COUNT(*) n FROM files WHERE title IS NOT NULL AND title!=''")||{n:0}).n;
  const mbChecked = (db.get("SELECT COUNT(*) n FROM files WHERE mb_checked_at IS NOT NULL AND title IS NOT NULL AND title!=''")||{n:0}).n;
  const mbPending = totalWithTitle - mbChecked;

  if (mbTotal === 0) {
    const parts = [`共 ${totalWithTitle} 个有标题文件`];
    if (totalWithTitle === 0) {
      parts.length = 0;
      parts.push('没有文件具备标题信息');
    } else if (retryMissed) {
      const mbHit = (db.get("SELECT COUNT(*) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.source='musicbrainz' AND f.title IS NOT NULL AND f.title!=''")||{n:0}).n;
      parts.push(`${mbHit} 个已 MB 命中（跳过），${totalWithTitle - mbHit} 个可重试`);
      if (totalWithTitle - mbHit === 0) parts.push('所有文件均已 MB 命中，无需重试');
    } else if (smartScan) {
      parts.push(`${mbChecked} 个已检查，${mbPending} 个待处理`);
      if (mbPending === 0) parts.push('所有文件均已通过 MB 检查');
    }
    prog.emit({ phase:'scrape', pct:100, level:'ok', message:`MusicBrainz 刮削: 无需处理（${parts.join('，')}）` });
    prog.done('刮削完成');
    return totalMatched;
  } else {
    const modeLabel = !smartScan ? '强制重扫' : retryMissed ? '未命中重试' : '智能模式';
    const pctBase = acoustidKey ? 50 : 0;
    prog.emit({ phase:'scrape', pct:pctBase, level:'info', message:`开始MusicBrainz 刮削（${modeLabel}，${mbTotal} 个文件）...` });

    let mbDone=0, mbMatched=0, mbExact=0, mbFailed=0;

    for (const f of mbFiles) {
      if (onAbort()) break;
      await onPause();

      const meta = await mbMatch(f);
      await sleep(1000); // MusicBrainz: 1 req/sec

      if (meta) {
        upsertScrapedMeta(db, { ...meta, file_id: f.id });
        mbMatched++; totalMatched++;
        if (meta.match_basis === 'exact') { mbExact++; totalExact++; }
        updateFileMbChecked(db, f.id);
      } else {
        upsertScrapedMeta(db, { file_id:f.id, source:'musicbrainz', title:null, artist:null, album:null,
          confidence:0, match_basis:'fuzzy', scraped_at:Date.now() });
        mbFailed++;
        updateFileMbChecked(db, f.id);
      }

      mbDone++;
      if (mbDone % 10 === 0 || mbDone === mbTotal) {
        const pctBase2 = acoustidKey ? 50 : 0;
        prog.emit({ phase:'scrape', pct:pctBase2 + Math.round(mbDone/mbTotal*(100-pctBase2)), level:'ok',
          message:`MusicBrainz 刮削: ${mbDone} / ${mbTotal}（精确 ${mbExact}，模糊 ${mbMatched-mbExact}，未找到 ${mbFailed}）`,
          filesProcessed: mbDone });
      }
    }

    const aidSummary = acoustidKey
      ? ` | AcoustID ${(() => {
          const total = (db.get("SELECT COUNT(*) n FROM files WHERE chromaprint IS NOT NULL")||{n:0}).n;
          const hit = (db.get("SELECT COUNT(*) n FROM files f JOIN scraped_meta sm ON sm.file_id=f.id WHERE sm.source='acoustid' AND sm.title IS NOT NULL AND sm.title!=''")||{n:0}).n;
          return `${hit}/${total} 个命中`;
        })()}`
      : '';
    prog.emit({ phase:'scrape', pct:100, level:'ok',
      message:`刮削完成：MB ${mbTotal} 个文件，精确 ${mbExact} 个，模糊 ${mbMatched-mbExact} 个，未找到 ${mbFailed} 个${aidSummary}`,
      matched: totalMatched, exact: totalExact, failed: mbFailed });
    prog.done('刮削完成');
  }
  return totalMatched;
}
