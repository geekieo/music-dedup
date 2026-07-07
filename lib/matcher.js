// lib/matcher.js — Multi-phase duplicate detection
//
// Phase 1  – Exact fingerprint match    : identical strings → guaranteed duplicate
// Phase 2  – Title-based match          : same song name extracted from metadata OR filename
// Phase 2b – Metadata-confirmed match   : title+artist+duration agree even if the spectral
//                                          score is inconclusive (cross-codec alignment drift,
//                                          or no fingerprint at all — see note below)
// Phase 2c – MusicBrainz-confirmed match: two local files were scraped to the same MB
//                                          recording id — independent, high-confidence signal
// Phase 3  – Fingerprint-prefix LSH     : first N integers shared → near-duplicate candidate
// Phase 4  – Duration bucket            : same duration ±4s, compared within artist/title groups
//
// IMPORTANT: Phases 2/2b/2c intentionally do NOT require a fingerprint to be present.
// A file whose spectral fingerprint failed to extract, was never computed, or was
// skipped for any reason must still be catchable as a duplicate via its tags alone —
// otherwise it becomes permanently invisible to the matcher. (Phases 1/3/4 inherently
// need a fingerprint to compare, so they keep operating on the fingerprinted subset.)
//
// WHY METADATA IS THE PRIMARY SIGNAL, NOT THE SPECTRAL FINGERPRINT:
// The spectral fingerprint compares fixed anchors by *percentage of duration*. Any
// phase/alignment difference between two encodes of the same recording (different
// encoder padding, a slightly different rip/master, a few ms of silence trimmed at
// the head) shifts every anchor and can crash the similarity score to near-zero even
// though the recording is identical — the score alone is not a reliable "are these
// the same song" signal. So Phase 2b (title+artist+duration) is a first-class,
// independent way to confirm a duplicate — it does NOT require the spectral score to
// agree, and a low/zero spectral score never overrides a metadata match. The spectral
// comparison still runs and its result feeds the "声纹一致 / 声纹相似 / 声纹不同"
// label, but that label is informational only, never a gate that excludes a group.

import nodePath from 'path';
import { fingerprintSimilarity, chromaprintSimilarity, normalizeStr, strSim } from './fingerprint.js';
import { applyRetentionRules, detectGroupType, detectMatchTags } from './rules.js';
import { getAllFilesForMatching, getFilesByAlbum, clearGroups, insertGroup, insertGroupTrack, runTx } from './db.js';
// Note: whitelist filtering done via DB query - files with whitelist entries excluded

// ── Multi-artist tag comparison ─────────────────────────────────────────
// Tags routinely disagree on separator ("范玮琪;MC HotDog" vs "范玮琪/MC HotDog
// 热狗") and on whether a secondary artist's name carries an extra suffix. A
// strict normalizeStr(a)===normalizeStr(b) equality check (the old behaviour)
// fails on both of those completely ordinary cases — which is exactly why a
// real duplicate pair like that example was being filtered out. Instead:
// split each side into individual artist tokens on common separators, then
// count how many tokens have *some* counterpart on the other side (exact
// match, or one token containing the other — handles "mc hotdog" vs
// "mc hotdog 热狗").
const ARTIST_SPLIT_RE = /[;,\/、，&×x]+|\s+(?:feat\.?|ft\.?|with)\s+/i;
function splitArtistTokens(raw) {
  if (!raw) return [];
  return raw.split(ARTIST_SPLIT_RE).map(t => normalizeStr(t)).filter(Boolean);
}
function artistsMatch(rawA, rawB) {
  const a = splitArtistTokens(rawA), b = splitArtistTokens(rawB);
  if (!a.length || !b.length) return false;
  let matched = 0;
  for (const ta of a) {
    if (b.some(tb => ta === tb || ta.includes(tb) || tb.includes(ta))) matched++;
  }
  return matched / Math.max(a.length, b.length) >= 0.5;
}


// ── Title extraction ──────────────────────────────────────────────────────

/**
 * Extract the best normalized song title from a file record.
 * Tries (in order): metadata title tag → artist-stripped filename → raw filename.
 */
function extractTitle(file) {
  const basename = nodePath.basename(file.path, nodePath.extname(file.path));

  // 1. If metadata title exists and looks real (not just the filename echoed back)
  const metaTitle = (file.title || '').trim();
  const basenameNorm = normalizeStr(basename);
  const metaNorm     = normalizeStr(metaTitle);

  if (metaTitle && metaNorm !== basenameNorm && metaTitle.length >= 2) {
    return cleanTitle(metaTitle);
  }

  // 2. Extract from filename
  let name = basename;

  // Remove leading track numbers: "01 - ", "1.", "Track01 - "
  name = name.replace(/^(?:track\s*)?\d{1,3}[\s.\-_]+/i, '');

  // Common pattern: "Artist - Title" or "Artist – Title"
  // Try to split on the first dash/em-dash surrounded by spaces
  const dashMatch = name.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  if (dashMatch) {
    // Use the SHORTER part (usually title is shorter than "Artist - Title")
    // or the right part (after dash) which is usually the title
    const right = dashMatch[2].trim();
    if (right.length >= 2) name = right;
  }

  return cleanTitle(name);
}

function cleanTitle(s) {
  return normalizeStr(
    s
      .replace(/\s*[\(\[][^\)\]]{0,40}[\)\]]\s*/g, ' ')            // remove (year), [HQ], etc.
      .replace(/\s*(feat\.?|ft\.?|with)\s+.*/i, '')                // remove feat. ...
      .replace(/\s*(official|mv|video|audio|lyric|live|remix)\s*/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

// ── Fingerprint prefix key (for LSH) ─────────────────────────────────────
// For raw-integer fingerprints: use first 3 integers as bucket key
// For base64 fingerprints: use first 20 characters
function fpPrefixKey(fp) {
  if (!fp || fp.startsWith('META:')) return null;
  const isRaw = /^-?\d/.test(fp.trim());
  if (isRaw) {
    return fp.trim().split(/\s+/).slice(0, 3).join(' ');
  }
  return fp.slice(0, 20);
}

// ── Union-Find ────────────────────────────────────────────────────────────
function buildUF(ids) {
  const p = new Map(ids.map(id => [id, id]));
  function find(x) {
    while (p.get(x) !== x) { p.set(x, p.get(p.get(x))); x = p.get(x); }
    return x;
  }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) p.set(ra, rb); }
  function clusters() {
    const m = new Map();
    for (const id of ids) { const r = find(id); if (!m.has(r)) m.set(r, []); m.get(r).push(id); }
    return [...m.values()].filter(c => c.length > 1);
  }
  return { union, clusters };
}

function pairKey(a, b) { return `${Math.min(a,b)}-${Math.max(a,b)}`; }

// ── Shared: plausibility gate ──────────────────────────────────────────────
// Below ~97% spectral similarity (essentially certain to be the same audio
// regardless of tags), require SOME independent corroboration — title or
// artist text actually overlapping — before trusting a bare spectral/
// Chromaprint score enough to union. Also used by scrape/basic matchers as
// a sanity check on candidate pairs.
const VERY_HIGH_SIM = 0.97;
function plausiblePair(a, b) {
  const tA = normalizeStr(a.title||''), tB = normalizeStr(b.title||'');
  if (tA && tB && strSim(tA, tB) >= 0.5) return true;
  const arA = normalizeStr(a.artist||''), arB = normalizeStr(b.artist||'');
  if (arA && arB && strSim(arA, arB) >= 0.5) return true;
  return false;
}

// ── Shared: load existing groups into UF ──────────────────────────────────
function loadExistingGroups(db, uf, fileById) {
  const rows = db.all('SELECT group_id, file_id FROM group_tracks ORDER BY group_id');
  if (!rows.length) return 0;
  const groupMap = new Map();
  for (const row of rows) {
    if (!groupMap.has(row.group_id)) groupMap.set(row.group_id, []);
    groupMap.get(row.group_id).push(row.file_id);
  }
  let count = 0;
  for (const [, fileIds] of groupMap) {
    const valid = fileIds.filter(id => fileById.has(id));
    if (valid.length < 2) continue;
    for (let i = 1; i < valid.length; i++) uf.union(valid[0], valid[i]);
    count++;
  }
  return count;
}

// ── Shared: persist clusters to DB ────────────────────────────────────────
function persistClusters(db, uf, fileById, opts) {
  const {
    simMap, cpSimMap, thresh,
    metaConfirmedPairs, mbConfirmedPairs, acoustidConfirmedPairs, cpConfirmedPairs,
    qualityTiers, onProgress, onAbort,
  } = opts;

  const dupClusters = uf.clusters();
  onProgress({ phase: 'matching', pct: 95, message: `发现 ${dupClusters.length} 个重复组，应用保留规则...` });

  clearGroups(db);

  const albumCountCache = new Map();
  function getLocalAlbumCount(album) {
    if (!album) return 0;
    if (!albumCountCache.has(album)) {
      albumCountCache.set(album, getFilesByAlbum(db, album).length);
    }
    return albumCountCache.get(album);
  }

  let inserted = 0;
  for (const cluster of dupClusters) {
    if (onAbort()) break;

    const clusterFiles = cluster.map(id => fileById.get(id)).filter(Boolean);
    if (clusterFiles.length < 2) continue;

    let maxSim = 0, maxCpSim = 0;
    let anyMetaConfirmed = false, anyMbConfirmed = false, anyAcoustidConfirmed = false, anyCpConfirmed = false;
    for (let i = 0; i < clusterFiles.length; i++) {
      for (let j = i + 1; j < clusterFiles.length; j++) {
        const key = pairKey(clusterFiles[i].id, clusterFiles[j].id);
        const s = simMap?.get(key) || 0;
        if (s > maxSim) maxSim = s;
        const cs = cpSimMap?.get(key) || 0;
        if (cs > maxCpSim) maxCpSim = cs;
        if (metaConfirmedPairs?.has(key))     anyMetaConfirmed     = true;
        if (mbConfirmedPairs?.has(key))       anyMbConfirmed       = true;
        if (acoustidConfirmedPairs?.has(key)) anyAcoustidConfirmed = true;
        if (cpConfirmedPairs?.has(key))       anyCpConfirmed       = true;
      }
    }
    const spectralConfirmed = simMap != null && maxSim >= thresh;
    const hasCpData = clusterFiles.some(f => !!f.chromaprint_raw);

    runTx(db, () => {
      const annotated  = applyRetentionRules(clusterFiles, getLocalAlbumCount, qualityTiers);
      const type        = detectGroupType(annotated);
      const match_tags  = detectMatchTags(clusterFiles, maxSim, {
        spectralConfirmed,
        metaConfirmed:  anyMetaConfirmed,
        mbConfirmed:    anyMbConfirmed,
        acoustidConfirmed: anyAcoustidConfirmed,
        cpConfirmed: anyCpConfirmed,
        maxCpSim, hasCpData,
      });
      const similarity  = Math.min(100, Math.round(maxSim * 100));
      const groupId     = insertGroup(db, { similarity, type, match_tags, created_time: Date.now() });
      for (const t of annotated) {
        insertGroupTrack(db, {
          group_id:        groupId,
          file_id:         t.id,
          keep:            t.keep ? 1 : 0,
          keep_reason:     t.keep_reason || null,
          manual_override: 0,
        });
      }
    });
    inserted++;
  }

  const dupBytes = db.get(`
    SELECT COALESCE(SUM(f.size),0) s FROM group_tracks gt JOIN files f ON f.id=gt.file_id WHERE gt.keep=0
  `).s || 0;

  return { inserted, dupBytes };
}

// ── Main entry ────────────────────────────────────────────────────────────
export async function runMatcher(db, opts = {}) {
  const {
    threshold  = 95,
    durationTolerance = 5,
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;

  const thresh = threshold / 100;
  onProgress({ phase: 'matching', pct: 90, message: '加载文件数据...' });

  const allFiles  = getAllFilesForMatching(db);
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));

  // Files with a usable spectral/metadata fingerprint — the only ones eligible
  // for the fingerprint-COMPARISON phases (1, 3, 4).
  const files = allFiles.filter(f => {
    if (!f.fingerprint) return false;
    if (whitelist.has(f.id)) return false;
    // Reject all-zero spectral fingerprints (silent audio causes mass false positives)
    if (!f.fingerprint.startsWith('META:')) {
      const parts = f.fingerprint.trim().split(' ');
      const nonZero = parts.filter(v => v !== '0').length;
      if (nonZero < parts.length * 0.1) return false;
    }
    return true;
  });

  // ALL non-whitelisted files, regardless of fingerprint status — the universe
  // for tag/metadata-based phases (2, 2b, 2c), which don't need a fingerprint
  // to compare in the first place. `files` is always a subset of this.
  const metaFiles = allFiles.filter(f => !whitelist.has(f.id));

  if (metaFiles.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件' });
    return;
  }

  onProgress({
    phase: 'matching', pct: 91,
    message: `开始多阶段重复检测（${metaFiles.length.toLocaleString()} 个文件，其中 ${files.length.toLocaleString()} 个含声纹）...`,
  });

  // ── Build candidate pair set using multiple strategies ─────────────────
  const uf       = buildUF(metaFiles.map(f => f.id));
  const simMap   = new Map();   // "minId-maxId" → spectral similarity (avoid recomputing)
  const cpSimMap = new Map();   // "minId-maxId" → Chromaprint similarity (avoid recomputing)
  const fileById = new Map(metaFiles.map(f => [f.id, f]));

  // Track *why* a pair was unioned when it wasn't via the spectral threshold,
  // so the final group can be tagged with the real basis for the match instead
  // of implying a spectral confirmation that never happened.
  const metaConfirmedPairs = new Set(); // pairKey → unioned by title+artist+duration alone
  const mbConfirmedPairs   = new Set(); // pairKey → unioned by shared recording id, MB text-search confirmed
  const acoustidConfirmedPairs = new Set(); // pairKey → unioned by shared recording id, AcoustID audio-fingerprint confirmed (higher confidence)

  // F9 bugfix: comparePair() used to union purely on fingerprintSimilarity()

  function comparePair(a, b) {
    const key = pairKey(a.id, b.id);
    if (simMap.has(key)) return simMap.get(key);
    const sim = fingerprintSimilarity(a.fingerprint, b.fingerprint);
    simMap.set(key, sim);
    if (sim >= thresh && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) uf.union(a.id, b.id);
    return sim;
  }

  function compareGroup(group) {
    for (let i = 0; i < group.length && !onAbort(); i++) {
      for (let j = i + 1; j < group.length; j++) {
        comparePair(group[i], group[j]);
      }
    }
  }

  // ── Phase 1: Exact fingerprint match (guaranteed) ──────────────────────
  // Any two files with IDENTICAL fingerprint string = definite duplicate, no threshold needed
  const exactMap = new Map();
  for (const f of files) {
    const key = f.fingerprint;
    if (!exactMap.has(key)) exactMap.set(key, []);
    exactMap.get(key).push(f);
  }
  let exactCount = 0;
  for (const group of exactMap.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) {
      uf.union(group[0].id, group[i].id);
      simMap.set(pairKey(group[0].id, group[i].id), 1.0);
      exactCount++;
    }
  }
  onProgress({ phase: 'matching', pct: 92, message: `阶段1完成：声纹精确匹配 ${exactCount} 对` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Phase 2: Title-based match ─────────────────────────────────────────
  // Groups files with the same extracted song title (from metadata OR filename).
  // Built from metaFiles (not files) so fingerprint-less files can still be grouped.
  const titleMap = new Map();
  for (const f of metaFiles) {
    const title = extractTitle(f);
    if (!title || title.length < 2) continue;
    if (!titleMap.has(title)) titleMap.set(title, []);
    titleMap.get(title).push(f);
  }
  let titleGroups = 0;
  for (const group of titleMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group); // safe even if some members lack a fingerprint (sim → 0, no union)
    titleGroups++;
  }
  onProgress({ phase: 'matching', pct: 93, message: `阶段2完成：标题分组 ${titleGroups} 组` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Phase 2b: Metadata-confirmed match ─────────────────────────────────
  // The spectral fingerprint compares fixed percentage-of-duration anchors.
  // Different codecs (e.g. an MP3 re-encode of a FLAC) can shift the actual
  // decoded audio by tens of milliseconds (encoder priming/padding samples),
  // which is enough to throw off this frame-level comparison and produce a
  // similarity score no better than chance — even though the recording is
  // identical. And some files have NO fingerprint at all (decode failure,
  // unsupported codec, or simply not yet processed). In both cases, title +
  // artist agreement (after normalization) plus a near-identical duration is
  // itself strong, independent evidence of a duplicate, so we confirm the
  // pair on that basis alone.
  let metaConfirmed = 0;
  const DURATION_TOLERANCE_S = durationTolerance;
  for (const group of titleMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!artistsMatch(a.artist, b.artist)) continue;
        if (!a.duration || !b.duration) continue;
        if (Math.abs(a.duration - b.duration) > DURATION_TOLERANCE_S) continue;
        uf.union(a.id, b.id);
        metaConfirmedPairs.add(pairKey(a.id, b.id));
        metaConfirmed++;
      }
    }
  }
  if (metaConfirmed) onProgress({ phase: 'matching', pct: 94, message: `阶段2b完成：元数据确认（标题+艺术家+时长）匹配 ${metaConfirmed} 对` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Phase 2c: scrape-confirmed match (MusicBrainz / AcoustID) ──────────
  // If two local files were independently scraped to the SAME MusicBrainz
  // recording id, that's strong third-party corroboration they're the same
  // underlying recording — regardless of how different their local tags,
  // filenames, or fingerprints look.
  //
  // F9 bugfix: this used to also require match_basis==='exact' on each
  // file's OWN scrape — but the same recording can legitimately appear on
  // several different compilation CDs under different album titles (very
  // common for anime BGM/OST cues), so one file's local album tag can fail
  // to corroborate its own scrape (→ 'fuzzy') even though the scrape itself
  // correctly identified the right recording. This is exactly why two
  // genuinely duplicate files (same artist, same MB recording, different
  // source album) went unmatched. TWO INDEPENDENT local files converging on
  // the same specific MBID — combined with the plausiblePair() gate below
  // (title or artist must actually correspond) — is itself strong enough
  // evidence without also requiring each individual scrape's own confidence
  // to be 'exact'.
  //
  // Also now distinguishes HOW that shared ID was reached: if both files'
  // scrape came from AcoustID (audio-fingerprint-verified, not just a text
  // search), that's meaningfully higher-confidence than a MusicBrainz text
  // search landing on the same ID for both — tagged separately so the
  // duplicate group reflects which kind of confirmation it actually got.
  const mbMap = new Map();
  for (const f of metaFiles) {
    if (!f.mb_recording_id) continue;
    if (!mbMap.has(f.mb_recording_id)) mbMap.set(f.mb_recording_id, []);
    mbMap.get(f.mb_recording_id).push(f);
  }
  let mbConfirmed = 0, acoustidConfirmed = 0;
  for (const group of mbMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!plausiblePair(a, b)) continue;
        uf.union(a.id, b.id);
        const key = pairKey(a.id, b.id);
        if (a.scrape_source === 'acoustid' && b.scrape_source === 'acoustid') {
          acoustidConfirmedPairs.add(key); acoustidConfirmed++;
        } else {
          mbConfirmedPairs.add(key); mbConfirmed++;
        }
      }
    }
  }
  if (mbConfirmed||acoustidConfirmed) onProgress({ phase: 'matching', pct: 94, message: `阶段2c完成：刮削数据确认匹配 ${mbConfirmed+acoustidConfirmed} 对（MusicBrainz ${mbConfirmed}，AcoustID ${acoustidConfirmed}）` });

  // ── Phase 3: Fingerprint-prefix LSH ───────────────────────────────────
  // Group by the first few integers (or chars) of the fingerprint.
  // Same audio → same or very similar prefix → candidates for full comparison.
  const prefixMap = new Map();
  for (const f of files) {
    const key = fpPrefixKey(f.fingerprint);
    if (!key) continue;
    if (!prefixMap.has(key)) prefixMap.set(key, []);
    prefixMap.get(key).push(f);
  }
  let prefixGroups = 0;
  for (const group of prefixMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group);
    prefixGroups++;
  }
  onProgress({ phase: 'matching', pct: 96, message: `阶段3完成：声纹前缀分组 ${prefixGroups} 组` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Phase 4: Duration-bucket match ────────────────────────────────────
  // Group all files with the same duration (±0 exact bucket, 4s window).
  // Within the bucket, compare fingerprints.  Catches renames with bad metadata.
  const durMap = new Map();
  for (const f of files) {
    if (!f.duration) continue;
    // 4-second bucket: songs within 4s of each other land in same or adjacent bucket
    const bucket = Math.round(f.duration / 4);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const key = `DUR:${b}`;
      if (!durMap.has(key)) durMap.set(key, []);
      durMap.get(key).push(f);
    }
  }
  let durGroups = 0, durSkipped = 0;
  for (const group of durMap.values()) {
    if (group.length < 2) continue;
    // F9: this used to hard-skip any bucket over 200 files with zero
    // visibility — for a library with lots of short BGM/stings clustering
    // around similar durations (common in anime OST collections), entire
    // duration buckets could be silently skipped, missing genuine
    // duplicates with no indication anything was left uncompared.
    // fingerprintSimilarity() is a cheap bitwise hamming-distance over ~120
    // ints, so a much higher cap is still fast; a bucket THIS big is now
    // rare enough to just report instead of silently dropping.
    if (group.length > 600) { durSkipped++; continue; }
    compareGroup(group);
    durGroups++;
  }
  onProgress({ phase: 'matching', pct: 97, message: `阶段4完成：时长分组 ${durGroups} 组${durSkipped?`（另有 ${durSkipped} 个超大分组已跳过，未比较）`:''}` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Phase 5 (experimental): Chromaprint-based local match ──────────────
  // Only runs for files that have a raw Chromaprint fingerprint (requires
  // fpcalc — see lib/chromaprint-bridge.js). Entirely independent of the
  // spectral phases above: unions its own pairs and tags them separately
  // (cp_confirmed) so the resulting duplicate groups make it possible to
  // compare the two fingerprinting methods' results (see which groups only
  // one of them found) rather than silently blending them together.
  // Everything above still works with zero setup if fpcalc isn't installed
  // — this phase just finds nothing to compare and is skipped.
  const cpConfirmedPairs = new Set();
  const cpFiles = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id));
  let cpGroups = 0;
  if (cpFiles.length >= 2) {
    const cpDurMap = new Map();
    for (const f of cpFiles) {
      if (!f.duration) continue;
      const bucket = Math.round(f.duration / 4);
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        const key = `CPDUR:${b}`;
        if (!cpDurMap.has(key)) cpDurMap.set(key, []);
        cpDurMap.get(key).push(f);
      }
    }
    for (const group of cpDurMap.values()) {
      if (group.length < 2 || group.length > 600) continue;
      for (let i = 0; i < group.length && !onAbort(); i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const key = pairKey(a.id, b.id);
          if (cpSimMap.has(key)) continue;
          const sim = chromaprintSimilarity(a.chromaprint_raw, b.chromaprint_raw);
          cpSimMap.set(key, sim);
          if (sim >= thresh && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) { uf.union(a.id, b.id); cpConfirmedPairs.add(key); }
        }
      }
      cpGroups++;
    }
  }
  onProgress({ phase: 'matching', pct: 98,
    message: cpFiles.length >= 2
      ? `阶段5完成（实验性）：Chromaprint 本地匹配，${cpFiles.length} 个文件参与，${cpGroups} 组`
      : `阶段5跳过：无 Chromaprint 指纹（未安装/未配置 fpcalc）` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── Collect clusters & persist ─────────────────────────────────────────
  const { inserted, dupBytes } = persistClusters(db, uf, fileById, {
    simMap, cpSimMap, thresh,
    metaConfirmedPairs, mbConfirmedPairs, acoustidConfirmedPairs, cpConfirmedPairs,
    qualityTiers, onProgress: (evt) => onProgress({ phase: 'matching', ...evt }), onAbort,
  });

  onProgress({
    phase: 'done', pct: 100,
    message: `扫描完成！发现 ${inserted} 个重复组（声纹精确匹配 ${exactCount} 对），可释放 ${fmtBytes(dupBytes)}`,
    groups: inserted, savings: dupBytes,
  });
}

function fmtBytes(b) {
  if (b>=1e12) return (b/1e12).toFixed(2)+' TB';
  if (b>=1e9)  return (b/1e9).toFixed(2)+' GB';
  if (b>=1e6)  return (b/1e6).toFixed(1)+' MB';
  return Math.round(b/1e3)+' KB';
}

// ── Scrape-only matcher ────────────────────────────────────────────────────
// Decoupled from runMatcher: only runs Phase 2c (scrape-confirmed matching by
// shared mb_recording_id). Reads existing groups from group_tracks and merges
// new scrape-based connections into them, then persists the merged result.
// MB and AcoustID scrape matching are tracked independently within the same
// function — both share the same logic (Phase 2c), but pairs are tagged
// separately so the duplicate group reflects which confirmation it got.
export async function runScrapeMatcher(db, opts = {}) {
  const {
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;

  onProgress({ phase: 'matching', pct: 0, message: '加载文件数据...' });

  const allFiles  = getAllFilesForMatching(db);
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));
  const metaFiles = allFiles.filter(f => !whitelist.has(f.id));

  if (metaFiles.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件' });
    return;
  }

  onProgress({
    phase: 'matching', pct: 10,
    message: `开始刮削数据重复检测（${metaFiles.length.toLocaleString()} 个文件）...`,
  });

  const uf       = buildUF(metaFiles.map(f => f.id));
  const fileById = new Map(metaFiles.map(f => [f.id, f]));

  const mbConfirmedPairs       = new Set();
  const acoustidConfirmedPairs = new Set();

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById);
  if (preservedCount) onProgress({ phase: 'matching', pct: 20, message: `已保留 ${preservedCount} 个现有重复组，合并刮削数据...` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 2c: scrape-confirmed match ──────────────────────────────────
  const mbMap = new Map();
  for (const f of metaFiles) {
    if (!f.mb_recording_id) continue;
    if (!mbMap.has(f.mb_recording_id)) mbMap.set(f.mb_recording_id, []);
    mbMap.get(f.mb_recording_id).push(f);
  }

  let mbConfirmed = 0, acoustidConfirmed = 0;
  for (const group of mbMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!plausiblePair(a, b)) continue;
        uf.union(a.id, b.id);
        const key = pairKey(a.id, b.id);
        if (a.scrape_source === 'acoustid' && b.scrape_source === 'acoustid') {
          acoustidConfirmedPairs.add(key); acoustidConfirmed++;
        } else {
          mbConfirmedPairs.add(key); mbConfirmed++;
        }
      }
    }
  }

  onProgress({
    phase: 'matching', pct: 80,
    message: `刮削数据确认匹配 ${mbConfirmed + acoustidConfirmed} 对（MusicBrainz ${mbConfirmed}，AcoustID ${acoustidConfirmed}）`,
  });

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  const { inserted, dupBytes } = persistClusters(db, uf, fileById, {
    simMap: null, cpSimMap: null, thresh: 0,
    metaConfirmedPairs: null, mbConfirmedPairs, acoustidConfirmedPairs, cpConfirmedPairs: null,
    qualityTiers, onProgress: (evt) => onProgress({ phase: 'matching', ...evt }), onAbort,
  });

  onProgress({
    phase: 'done', pct: 100,
    message: `刮削匹配完成！发现 ${inserted} 个重复组，可释放 ${fmtBytes(dupBytes)}`,
    groups: inserted, savings: dupBytes,
  });
}

// ── Basic matcher (metadata-only) ─────────────────────────────────────────
// Decoupled from runMatcher: only runs Phase 2 (title grouping) + Phase 2b
// (title+artist+duration confirmation). No fingerprint dependency — works on
// ALL files with metadata, regardless of whether a spectral fingerprint was
// ever extracted. Preserves existing groups and merges new results.
export async function runBasicMatcher(db, opts = {}) {
  const {
    durationTolerance = 5,
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;

  onProgress({ phase: 'matching', pct: 0, message: '加载文件数据...' });

  const allFiles  = getAllFilesForMatching(db);
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));
  const metaFiles = allFiles.filter(f => !whitelist.has(f.id));

  if (metaFiles.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件' });
    return;
  }

  onProgress({
    phase: 'matching', pct: 10,
    message: `开始基础重复检测（${metaFiles.length.toLocaleString()} 个文件）...`,
  });

  const uf       = buildUF(metaFiles.map(f => f.id));
  const fileById = new Map(metaFiles.map(f => [f.id, f]));
  const metaConfirmedPairs = new Set();

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById);
  if (preservedCount) onProgress({ phase: 'matching', pct: 20, message: `已保留 ${preservedCount} 个现有重复组，合并基础匹配...` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 2: Title-based grouping ─────────────────────────────────────
  const titleMap = new Map();
  for (const f of metaFiles) {
    const title = extractTitle(f);
    if (!title || title.length < 2) continue;
    if (!titleMap.has(title)) titleMap.set(title, []);
    titleMap.get(title).push(f);
  }

  let titleGroups = 0;
  for (const group of titleMap.values()) {
    if (group.length < 2) continue;
    titleGroups++;
  }
  onProgress({ phase: 'matching', pct: 40, message: `阶段2完成：标题分组 ${titleGroups} 组` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 2b: Metadata-confirmed match ────────────────────────────────
  // Same title + matching artist + similar duration → duplicate.
  // No fingerprint comparison — this is the core signal for the basic lane.
  let metaConfirmed = 0;
  const DURATION_TOLERANCE_S = durationTolerance;
  for (const group of titleMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!artistsMatch(a.artist, b.artist)) continue;
        if (!a.duration || !b.duration) continue;
        if (Math.abs(a.duration - b.duration) > DURATION_TOLERANCE_S) continue;
        uf.union(a.id, b.id);
        metaConfirmedPairs.add(pairKey(a.id, b.id));
        metaConfirmed++;
      }
    }
  }

  onProgress({
    phase: 'matching', pct: 80,
    message: `阶段2b完成：元数据确认（标题+艺术家+时长）匹配 ${metaConfirmed} 对`,
  });

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  const { inserted, dupBytes } = persistClusters(db, uf, fileById, {
    simMap: null, cpSimMap: null, thresh: 0,
    metaConfirmedPairs, mbConfirmedPairs: null, acoustidConfirmedPairs: null, cpConfirmedPairs: null,
    qualityTiers, onProgress: (evt) => onProgress({ phase: 'matching', ...evt }), onAbort,
  });

  onProgress({
    phase: 'done', pct: 100,
    message: `基础匹配完成！发现 ${inserted} 个重复组，可释放 ${fmtBytes(dupBytes)}`,
    groups: inserted, savings: dupBytes,
  });
}

// ── Fingerprint matcher (spectral-only) ───────────────────────────────────
// Decoupled from runMatcher: only runs phases that require a spectral
// fingerprint — Phase 1 (exact FP), Phase 3 (prefix LSH), Phase 4 (duration
// bucket), and Phase 5 (Chromaprint). Preserves existing groups and merges
// new fingerprint-based connections into them.
export async function runFpMatcher(db, opts = {}) {
  const {
    threshold  = 95,
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;

  const thresh = threshold / 100;
  onProgress({ phase: 'matching', pct: 0, message: '加载文件数据...' });

  const allFiles  = getAllFilesForMatching(db);
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));

  const files = allFiles.filter(f => {
    if (!f.fingerprint) return false;
    if (whitelist.has(f.id)) return false;
    if (!f.fingerprint.startsWith('META:')) {
      const parts = f.fingerprint.trim().split(' ');
      const nonZero = parts.filter(v => v !== '0').length;
      if (nonZero < parts.length * 0.1) return false;
    }
    return true;
  });

  if (files.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件（无声纹数据）' });
    return;
  }

  onProgress({
    phase: 'matching', pct: 10,
    message: `开始声纹重复检测（${files.length.toLocaleString()} 个含声纹文件）...`,
  });

  // UF built from ALL non-whitelisted files so existing groups can be preserved
  const uf       = buildUF(allFiles.filter(f => !whitelist.has(f.id)).map(f => f.id));
  const simMap   = new Map();
  const cpSimMap = new Map();
  const fileById = new Map(allFiles.filter(f => !whitelist.has(f.id)).map(f => [f.id, f]));
  const cpConfirmedPairs = new Set();

  function comparePair(a, b) {
    const key = pairKey(a.id, b.id);
    if (simMap.has(key)) return simMap.get(key);
    const sim = fingerprintSimilarity(a.fingerprint, b.fingerprint);
    simMap.set(key, sim);
    if (sim >= thresh && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) uf.union(a.id, b.id);
    return sim;
  }

  function compareGroup(group) {
    for (let i = 0; i < group.length && !onAbort(); i++) {
      for (let j = i + 1; j < group.length; j++) {
        comparePair(group[i], group[j]);
      }
    }
  }

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById);
  if (preservedCount) onProgress({ phase: 'matching', pct: 15, message: `已保留 ${preservedCount} 个现有重复组，合并声纹匹配...` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 1: Exact fingerprint match ──────────────────────────────────
  const exactMap = new Map();
  for (const f of files) {
    const key = f.fingerprint;
    if (!exactMap.has(key)) exactMap.set(key, []);
    exactMap.get(key).push(f);
  }
  let exactCount = 0;
  for (const group of exactMap.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) {
      uf.union(group[0].id, group[i].id);
      simMap.set(pairKey(group[0].id, group[i].id), 1.0);
      exactCount++;
    }
  }
  onProgress({ phase: 'matching', pct: 30, message: `阶段1完成：声纹精确匹配 ${exactCount} 对` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 3: Fingerprint-prefix LSH ───────────────────────────────────
  const prefixMap = new Map();
  for (const f of files) {
    const key = fpPrefixKey(f.fingerprint);
    if (!key) continue;
    if (!prefixMap.has(key)) prefixMap.set(key, []);
    prefixMap.get(key).push(f);
  }
  let prefixGroups = 0;
  for (const group of prefixMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group);
    prefixGroups++;
  }
  onProgress({ phase: 'matching', pct: 50, message: `阶段3完成：声纹前缀分组 ${prefixGroups} 组` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 4: Duration-bucket match ────────────────────────────────────
  const durMap = new Map();
  for (const f of files) {
    if (!f.duration) continue;
    const bucket = Math.round(f.duration / 4);
    for (const b of [bucket - 1, bucket, bucket + 1]) {
      const key = `DUR:${b}`;
      if (!durMap.has(key)) durMap.set(key, []);
      durMap.get(key).push(f);
    }
  }
  let durGroups = 0, durSkipped = 0;
  for (const group of durMap.values()) {
    if (group.length < 2) continue;
    if (group.length > 600) { durSkipped++; continue; }
    compareGroup(group);
    durGroups++;
  }
  onProgress({ phase: 'matching', pct: 75, message: `阶段4完成：时长分组 ${durGroups} 组${durSkipped?`（另有 ${durSkipped} 个超大分组已跳过，未比较）`:''}` });

  if (onAbort()) return;
  await onPause();

  // ── Phase 5 (experimental): Chromaprint-based local match ──────────────
  const cpFiles = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id));
  let cpGroups = 0;
  if (cpFiles.length >= 2) {
    const cpDurMap = new Map();
    for (const f of cpFiles) {
      if (!f.duration) continue;
      const bucket = Math.round(f.duration / 4);
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        const key = `CPDUR:${b}`;
        if (!cpDurMap.has(key)) cpDurMap.set(key, []);
        cpDurMap.get(key).push(f);
      }
    }
    for (const group of cpDurMap.values()) {
      if (group.length < 2 || group.length > 600) continue;
      for (let i = 0; i < group.length && !onAbort(); i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          const key = pairKey(a.id, b.id);
          if (cpSimMap.has(key)) continue;
          const sim = chromaprintSimilarity(a.chromaprint_raw, b.chromaprint_raw);
          cpSimMap.set(key, sim);
          if (sim >= thresh && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) { uf.union(a.id, b.id); cpConfirmedPairs.add(key); }
        }
      }
      cpGroups++;
    }
  }
  onProgress({ phase: 'matching', pct: 90,
    message: cpFiles.length >= 2
      ? `阶段5完成（实验性）：Chromaprint 本地匹配，${cpFiles.length} 个文件参与，${cpGroups} 组`
      : `阶段5跳过：无 Chromaprint 指纹（未安装/未配置 fpcalc）` });

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  const { inserted, dupBytes } = persistClusters(db, uf, fileById, {
    simMap, cpSimMap, thresh,
    metaConfirmedPairs: null, mbConfirmedPairs: null, acoustidConfirmedPairs: null, cpConfirmedPairs,
    qualityTiers, onProgress: (evt) => onProgress({ phase: 'matching', ...evt }), onAbort,
  });

  onProgress({
    phase: 'done', pct: 100,
    message: `声纹匹配完成！发现 ${inserted} 个重复组（声纹精确匹配 ${exactCount} 对），可释放 ${fmtBytes(dupBytes)}`,
    groups: inserted, savings: dupBytes,
  });
}
