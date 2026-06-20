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
import { fingerprintSimilarity, normalizeStr } from './fingerprint.js';
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

// ── Main entry ────────────────────────────────────────────────────────────
export async function runMatcher(db, opts = {}) {
  const {
    threshold  = 95,
    durationTolerance = 5,
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
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
  const fileById = new Map(metaFiles.map(f => [f.id, f]));

  // Track *why* a pair was unioned when it wasn't via the spectral threshold,
  // so the final group can be tagged with the real basis for the match instead
  // of implying a spectral confirmation that never happened.
  const metaConfirmedPairs = new Set(); // pairKey → unioned by title+artist+duration alone
  const mbConfirmedPairs   = new Set(); // pairKey → unioned by shared MusicBrainz recording id

  function pairKey(a, b) { return `${Math.min(a,b)}-${Math.max(a,b)}`; }

  function comparePair(a, b) {
    const key = pairKey(a.id, b.id);
    if (simMap.has(key)) return simMap.get(key);
    const sim = fingerprintSimilarity(a.fingerprint, b.fingerprint);
    simMap.set(key, sim);
    if (sim >= thresh) uf.union(a.id, b.id);
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

  // ── Phase 2c: MusicBrainz-confirmed match ──────────────────────────────
  // If two local files were independently scraped to the SAME MusicBrainz
  // recording id, that is strong third-party confirmation they're the same
  // underlying recording — regardless of how different their local tags,
  // filenames, or fingerprints look.
  const mbMap = new Map();
  for (const f of metaFiles) {
    if (!f.mb_recording_id) continue;
    if (!mbMap.has(f.mb_recording_id)) mbMap.set(f.mb_recording_id, []);
    mbMap.get(f.mb_recording_id).push(f);
  }
  let mbConfirmed = 0;
  for (const group of mbMap.values()) {
    if (group.length < 2) continue;
    for (let i = 1; i < group.length; i++) {
      uf.union(group[0].id, group[i].id);
      mbConfirmedPairs.add(pairKey(group[0].id, group[i].id));
      mbConfirmed++;
    }
  }
  if (mbConfirmed) onProgress({ phase: 'matching', pct: 94, message: `阶段2c完成：MusicBrainz 刮削数据确认匹配 ${mbConfirmed} 对` });

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
  let durGroups = 0;
  for (const group of durMap.values()) {
    if (group.length < 2 || group.length > 200) continue; // skip huge buckets (common durations)
    compareGroup(group);
    durGroups++;
  }
  onProgress({ phase: 'matching', pct: 97, message: `阶段4完成：时长分组 ${durGroups} 组` });

  if (onAbort()) return;

  // ── Collect clusters & persist ─────────────────────────────────────────
  const dupClusters = uf.clusters();
  onProgress({ phase: 'matching', pct: 98, message: `发现 ${dupClusters.length} 个重复组，应用保留规则...` });

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

    // Find max spectral similarity within cluster, and whether any edge in the
    // cluster was confirmed via metadata/MusicBrainz rather than the spectral
    // threshold (so groups whose own spectral score is low/absent still get
    // an honest explanation of why they were flagged).
    let maxSim = 0;
    let anyMetaConfirmed = false, anyMbConfirmed = false;
    for (let i = 0; i < clusterFiles.length; i++) {
      for (let j = i + 1; j < clusterFiles.length; j++) {
        const key = pairKey(clusterFiles[i].id, clusterFiles[j].id);
        const s = simMap.get(key) || 0;
        if (s > maxSim) maxSim = s;
        if (metaConfirmedPairs.has(key)) anyMetaConfirmed = true;
        if (mbConfirmedPairs.has(key))   anyMbConfirmed   = true;
      }
    }
    // Did the spectral score itself reach the threshold for at least one edge?
    const spectralConfirmed = maxSim >= thresh;

    runTx(db, () => {
      const annotated  = applyRetentionRules(clusterFiles, getLocalAlbumCount, qualityTiers);
      const type        = detectGroupType(annotated);
      const match_tags  = detectMatchTags(clusterFiles, maxSim, {
        spectralConfirmed,
        metaConfirmed: anyMetaConfirmed,
        mbConfirmed:   anyMbConfirmed,
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
