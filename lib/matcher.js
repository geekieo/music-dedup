// lib/matcher.js — 重复检测匹配器
//
// ═══════════════════════════════════════════════════════════════════════════
// 全局 8 步执行流程（server.js 调度顺序）
// ═══════════════════════════════════════════════════════════════════════════
//
//   步骤 1  枚举              scanner.js    扫描目录，发现文件，入库
//   步骤 2  提取属性          scanner.js    读取文件标签（标题/艺术家/专辑/时长等）
//   步骤 3  属性匹配          matcher.js    runBasicMatcher
//            3a  标题分组                    从标签或文件名提取歌名，同名归组
//            3b  元数据确认                  标题+艺术家+时长匹配 → 确认重复
//   步骤 4  提取声纹          scanner.js    频谱声纹(Goertzel) + CP声纹(fpcalc)
//   步骤 5  频谱声纹匹配      matcher.js    runFpMatcher
//            5a  精确声纹                    频谱声纹逐字节相同 → 直接判定
//            5b  多段LSH分组                 5段指纹前缀哈希 → 候选对（滑动窗口±8对齐）
//            5c  时长桶+相似度               时长±4s分桶 + 超限桶递归细分 + fingerprintSimilarity()
//   步骤 6  CP声纹匹配        matcher.js    runFpMatcher Chromaprint 部分
//            6a  CP多段LSH                  同5b策略
//            6b  CP时长桶                   递归细分 + chromaprintSimilarity() ≥ CP_THRESH（滑动窗口）
//   步骤 7  刮削              scraper.js    MB / AcoustID API 获取外部元数据
//   步骤 8  刮削匹配          matcher.js    runScrapeMatcher
//                                           MB/AcoustID recording ID 相同 → 确认重复
//
//   runMatcher() = 步骤 3+5+6+8 全集（向后兼容"全部执行"）
//
//   扫描页三个独立匹配通道：
//     属性匹配     → 步骤 3  (runBasicMatcher)
//     声纹匹配     → 步骤 5+6 (runFpMatcher)
//     刮削匹配     → 步骤 8  (runScrapeMatcher)
//
// ═══════════════════════════════════════════════════════════════════════════
//
// 设计说明：
// - 属性匹配（步骤 3）不依赖声纹，无声纹文件也可参与
// - 频谱声纹因编码器 padding/alignment 差异，相似度可能骤降，不可靠
//   的声纹分数永远不能否决属性匹配的结果
// - 用户配置的"频谱声纹相似度阈值"仅影响步骤 5c（时长桶+相似度）
// - CP声纹（步骤 6）使用独立硬编码阈值 CP_THRESH=0.90，不受用户滑块影响

import nodePath from 'path';
import { fingerprintSimilarity, chromaprintSimilarity, normalizeStr, strSim } from './fingerprint.js';
import { applyRetentionRules, detectGroupType, detectMatchTags, MATCHING_METHOD_KEYS } from './rules.js';
import { getAllFilesForMatching, getFilesByAlbum, clearGroups, insertGroup, insertGroupTrack, runTx } from './db.js';
// Note: whitelist filtering done via DB query - files with whitelist entries excluded

// ── Multi-artist tag comparison ─────────────────────────────────────────
// Tags may use different separators (; / ,) or include extra suffixes on
// secondary artist names, so strict equality fails on common real-world
// cases. Instead: split each side into tokens on common separators, then
// count how many tokens have a counterpart on the other side (exact match,
// or one token containing the other).
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

// ── Multi-segment LSH keys ────────────────────────────────────────────────
// Instead of a single prefix (fragile — one misaligned anchor breaks the
// bucket), extract 5 segments spread across the full fingerprint duration.
// Each file lands in ~5 buckets; a match in ANY bucket triggers full
// comparison. This mimics multi-hash-table LSH without random projections,
// and dramatically improves recall when encoder padding shifts anchors.
const NUM_LSH_SEGMENTS = 5;
const DUR_BUCKET_LIMIT = 600;

function fpMultiKeys(fp) {
  if (!fp || fp.startsWith('META:')) return [];
  const isRaw = /^-?\d/.test(fp.trim());
  if (isRaw) {
    const parts = fp.trim().split(/\s+/);
    if (parts.length < 6) return [fp.trim()];
    const keys = [];
    const step = Math.max(1, Math.floor((parts.length - 3) / (NUM_LSH_SEGMENTS - 1)));
    for (let i = 0; i < NUM_LSH_SEGMENTS; i++) {
      const start = Math.min(i * step, parts.length - 3);
      keys.push(parts.slice(start, start + 3).join(' '));
    }
    return [...new Set(keys)];
  }
  // base64 fingerprint
  if (fp.length < 30) return [fp];
  const keys = [];
  const step = Math.max(1, Math.floor((fp.length - 20) / (NUM_LSH_SEGMENTS - 1)));
  for (let i = 0; i < NUM_LSH_SEGMENTS; i++) {
    const start = Math.min(i * step, fp.length - 20);
    keys.push(fp.slice(start, start + 20));
  }
  return [...new Set(keys)];
}

function cpMultiKeys(raw) {
  if (!raw) return [];
  const parts = raw.split(',');
  if (parts.length < 6) return [raw.slice(0, 100)];
  const keys = [];
  const step = Math.max(1, Math.floor((parts.length - 3) / (NUM_LSH_SEGMENTS - 1)));
  for (let i = 0; i < NUM_LSH_SEGMENTS; i++) {
    const start = Math.min(i * step, parts.length - 3);
    keys.push(parts.slice(start, start + 3).join(','));
  }
  return [...new Set(keys)];
}

// ── Recursive duration-bucket subdivision ──────────────────────────────────
// When a duration bucket exceeds DUR_BUCKET_LIMIT, subdivide by fingerprint
// segment keys instead of skipping it entirely. Up to 3 levels of subdivision
// ensure we never silently drop a hot duration range (e.g. 3–4 min pop songs).
function subdivideDurBucket(group, getSegmentKeys, compareFn, depth = 0) {
  if (group.length <= DUR_BUCKET_LIMIT || depth >= 3) {
    if (group.length <= DUR_BUCKET_LIMIT) compareFn(group);
    return group.length <= DUR_BUCKET_LIMIT;
  }
  const subMap = new Map();
  for (const f of group) {
    const keys = getSegmentKeys(f);
    const subKey = keys[Math.min(depth, keys.length - 1)] || `_fb_${f.id}`;
    if (!subMap.has(subKey)) subMap.set(subKey, []);
    subMap.get(subKey).push(f);
  }
  let allOk = true;
  for (const sub of subMap.values()) {
    if (sub.length < 2) continue;
    if (!subdivideDurBucket(sub, getSegmentKeys, compareFn, depth + 1)) allOk = false;
  }
  return allOk;
}

// Fingerprint similarity offset: ±8 positions covers ~±46 ms of audio shift
// per anchor (at 5.8 ms / frame step), enough for typical encoder priming
// (MP3 ~50 ms, AAC ~93 ms) without meaningfully increasing false positives.
const FP_MAX_OFFSET = 8;

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
// Chromaprint uses its own hardcoded threshold, independent of the user-configurable
// spectral threshold — the two fingerprinting algorithms have different similarity
// distributions, so a single slider would be misleading.
const CP_THRESH = 0.90;
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

  // Snapshot existing matching-method tags before clearing, so tags from other
  // phases survive partial rematches (e.g. runBasicMatcher / runFpMatcher).
  const prevMethodTags = new Map(); // "id1,id2,..." → Set of method-tag strings
  const oldGroups = db.all('SELECT g.id, g.match_tags FROM dup_groups g');
  for (const g of oldGroups) {
    const trackIds = db.all('SELECT file_id FROM group_tracks WHERE group_id=? ORDER BY file_id', [g.id]).map(r => r.file_id);
    if (trackIds.length >= 2) {
      const methodTags = (g.match_tags || '').split(',').filter(Boolean).filter(t => MATCHING_METHOD_KEYS.has(t));
      if (methodTags.length) prevMethodTags.set(trackIds.join(','), new Set(methodTags));
    }
  }

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

    // Detect recording-ID matches from track data (survives partial rematches
    // where mbConfirmedPairs / acoustidConfirmedPairs are null).
    if (!anyAcoustidConfirmed) {
      const aidIds = clusterFiles.map(f => f.acoustid_recording_id).filter(Boolean);
      if (aidIds.length >= 2 && new Set(aidIds).size === 1) anyAcoustidConfirmed = true;
    }
    if (!anyMbConfirmed) {
      const mbIds = clusterFiles.map(f => f.mb_recording_id).filter(Boolean);
      if (mbIds.length >= 2 && new Set(mbIds).size === 1) anyMbConfirmed = true;
    }

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
      // retention_tie: the retention rules produced a tie (multiple equally-
      // qualified candidates) — the user must manually pick the winner.
      const hasTie = annotated.some(t => t.keep_reason === '属性相同，建议手动选择');
      let final_tags = hasTie ? match_tags + ',retention_tie' : match_tags;

      // Merge matching-method tags from previous runs (survives partial rematches).
      const clusterKey = [...cluster].sort((a, b) => a - b).join(',');
      const prevTags = prevMethodTags.get(clusterKey);
      if (prevTags && prevTags.size) {
        const merged = new Set(final_tags.split(',').filter(Boolean));
        for (const t of prevTags) merged.add(t);
        final_tags = [...merged].join(',');
      }
      const similarity  = Math.min(100, Math.round(maxSim * 100));
      const groupId     = insertGroup(db, { similarity, type, match_tags: final_tags, created_time: Date.now() });
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
  onProgress({ phase: 'matching', pct: 90, message: '开始匹配分析...' });

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
  // for tag/metadata-based phases (3a, 3b, 8), which don't need a fingerprint
  // to compare in the first place. `files` is always a subset of this.
  const metaFiles = allFiles.filter(f => !whitelist.has(f.id));

  if (metaFiles.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件' });
    return;
  }

  // Data-source statistics for visibility into what each phase has to work with
  const withSpectral = files.length;
  const withChroma = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id)).length;
  const withMbRid = metaFiles.filter(f => f.mb_recording_id).length;
  const withAidRid = metaFiles.filter(f => f.acoustid_recording_id).length;
  onProgress({
    phase: 'matching', pct: 91,
    message: `开始多阶段重复检测（${metaFiles.length.toLocaleString()} 个文件，声纹：频谱 ${withSpectral} / Chromaprint ${withChroma}，刮削：MB ${withMbRid} / AcoustID ${withAidRid}）...`,
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

  function comparePair(a, b) {
    const key = pairKey(a.id, b.id);
    if (simMap.has(key)) return simMap.get(key);
    const sim = fingerprintSimilarity(a.fingerprint, b.fingerprint, FP_MAX_OFFSET);
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

  // ── 步骤5a: 精确声纹 ───────────────────────────────────────────────────
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
  onProgress({ phase: 'matching', pct: 92, message: `精确声纹匹配完成：${exactCount} 对` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── 步骤3a: 标题分组 ───────────────────────────────────────────────────
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
  onProgress({ phase: 'matching', pct: 93, message: `标题分组完成：${titleGroups} 组` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── 步骤3b: 属性确认 ───────────────────────────────────────────────────
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
  if (metaConfirmed) onProgress({ phase: 'matching', pct: 94, message: `属性确认匹配完成：${metaConfirmed} 对` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── 步骤8: 刮削匹配 (MusicBrainz / AcoustID) ───────────────────────────
  // Two files independently scraped to the same MusicBrainz recording ID is
  // strong evidence they're the same recording. Does NOT require each scrape's
  // own match_basis to be 'exact' — the same recording can appear on different
  // albums, causing one side's album tag not to match → 'fuzzy', even though
  // the recording ID is correct.
  //
  // MB and AcoustID recording IDs are combined into a single map (same ID
  // space, different verification channels). Pairs tagged by which source(s)
  // confirmed the match; cross-source matches count as acoustidConfirmed.
  const recordingMap = new Map();
  for (const f of metaFiles) {
    // Collect all unique recording IDs from both sources
    const ids = new Set();
    if (f.mb_recording_id) ids.add(f.mb_recording_id);
    if (f.acoustid_recording_id) ids.add(f.acoustid_recording_id);
    for (const rid of ids) {
      if (!recordingMap.has(rid)) recordingMap.set(rid, []);
      recordingMap.get(rid).push(f);
    }
  }
  let mbConfirmed = 0, acoustidConfirmed = 0;
  for (const group of recordingMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!plausiblePair(a, b)) continue;
        uf.union(a.id, b.id);
        // Tag based on which source(s) both files independently got the SAME
        // recording ID. A pair can carry both tags (both sources agree).
        // Cross-source (same ID, different source columns) → counts as
        // acoustidConfirmed because at least one file has audio verification.
        const sameMb = a.mb_recording_id && b.mb_recording_id && a.mb_recording_id === b.mb_recording_id;
        const sameAid = a.acoustid_recording_id && b.acoustid_recording_id && a.acoustid_recording_id === b.acoustid_recording_id;
        const crossSource = !sameMb && !sameAid; // different source columns, same recording ID
        if (sameMb) { mbConfirmedPairs.add(pairKey(a.id, b.id)); mbConfirmed++; }
        if (sameAid || crossSource) { acoustidConfirmedPairs.add(pairKey(a.id, b.id)); acoustidConfirmed++; }
      }
    }
  }
  if (mbConfirmed||acoustidConfirmed) onProgress({ phase: 'matching', pct: 94, message: `刮削交叉确认完成：${mbConfirmed+acoustidConfirmed} 对（MusicBrainz ${mbConfirmed}，AcoustID ${acoustidConfirmed}）` });

  // ── 步骤5b: 多段LSH分组 ─────────────────────────────────────────────────
  // Each file lands in ~5 buckets spread across its fingerprint duration.
  // A match in ANY bucket triggers full comparison — mimics multi-hash-table
  // LSH without random projections, and recovers matches even when encoder
  // padding shifts individual anchors.
  const prefixMap = new Map();
  for (const f of files) {
    const keys = fpMultiKeys(f.fingerprint);
    for (const key of keys) {
      if (!prefixMap.has(key)) prefixMap.set(key, []);
      prefixMap.get(key).push(f);
    }
  }
  let prefixGroups = 0;
  for (const group of prefixMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group);
    prefixGroups++;
  }
  onProgress({ phase: 'matching', pct: 96, message: `多段LSH分组完成：${prefixGroups} 组` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── 步骤5c: 时长桶+相似度 ──────────────────────────────────────────────
  // Group all files with the same duration (±0 exact bucket, 4s window).
  // Within the bucket, compare fingerprints.  Catches renames with bad metadata.
  // Oversized buckets (>600) are recursively subdivided by fingerprint segments
  // instead of being skipped, so hot duration ranges (e.g. 3–4 min pop) are
  // never silently dropped.
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
  const durKeyFn = (f) => fpMultiKeys(f.fingerprint);
  for (const group of durMap.values()) {
    if (group.length < 2) continue;
    if (group.length > DUR_BUCKET_LIMIT) {
      if (!subdivideDurBucket(group, durKeyFn, compareGroup)) durSkipped++;
      else durGroups++;
    } else {
      compareGroup(group);
      durGroups++;
    }
  }
  onProgress({ phase: 'matching', pct: 97, message: `时长桶匹配完成：${durGroups} 组${durSkipped?`（另有 ${durSkipped} 个超大分组递归细分后仍超限，已跳过）`:''}` });

  if (onAbort()) return;
  await onPause();
  if (onAbort()) return;

  // ── 步骤6: CP声纹匹配 ──────────────────────────────────────────────────
  // Multi-segment LSH (same strategy as spectral 5b) followed by duration
  // buckets with recursive subdivision. Both use sliding-window alignment.
  const cpConfirmedPairs = new Set();
  const cpFiles = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id));

  function compareCpGroup(group) {
    for (let i = 0; i < group.length && !onAbort(); i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const key = pairKey(a.id, b.id);
        if (cpSimMap.has(key)) continue;
        const sim = chromaprintSimilarity(a.chromaprint_raw, b.chromaprint_raw, FP_MAX_OFFSET);
        cpSimMap.set(key, sim);
        if (sim >= CP_THRESH && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) { uf.union(a.id, b.id); cpConfirmedPairs.add(key); }
      }
    }
  }

  let cpLshGroups = 0, cpDurGroups = 0, cpDurSkipped = 0;
  if (cpFiles.length >= 2) {
    // 6a: CP多段LSH
    const cpPrefixMap = new Map();
    for (const f of cpFiles) {
      const keys = cpMultiKeys(f.chromaprint_raw);
      for (const key of keys) {
        if (!cpPrefixMap.has(key)) cpPrefixMap.set(key, []);
        cpPrefixMap.get(key).push(f);
      }
    }
    for (const group of cpPrefixMap.values()) {
      if (group.length < 2) continue;
      compareCpGroup(group);
      cpLshGroups++;
    }

    // 6b: CP时长桶（递归细分超限桶）
    const cpDurMap = new Map();
    for (const f of cpFiles) {
      if (!f.duration) continue;
      const bucket = Math.round(f.duration / 4);
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        const ckey = `CPDUR:${b}`;
        if (!cpDurMap.has(ckey)) cpDurMap.set(ckey, []);
        cpDurMap.get(ckey).push(f);
      }
    }
    const cpKeyFn = (f) => cpMultiKeys(f.chromaprint_raw);
    for (const group of cpDurMap.values()) {
      if (group.length < 2) continue;
      if (group.length > DUR_BUCKET_LIMIT) {
        if (!subdivideDurBucket(group, cpKeyFn, compareCpGroup)) cpDurSkipped++;
        else cpDurGroups++;
      } else {
        compareCpGroup(group);
        cpDurGroups++;
      }
    }
  }
  const cpGroupsTotal = cpLshGroups + cpDurGroups;
  onProgress({ phase: 'matching', pct: 98,
    message: cpFiles.length >= 2
      ? `CP声纹匹配完成：${cpFiles.length} 个文件参与，LSH ${cpLshGroups} + 时长 ${cpDurGroups} 组${cpDurSkipped?`（${cpDurSkipped} 个超限）`:''}`
      : `CP声纹匹配跳过：无 CP 声纹（未安装/未配置 fpcalc）` });

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
    message: `匹配完成！发现 ${inserted} 个重复组（声纹精确匹配 ${exactCount} 对），可释放 ${fmtBytes(dupBytes)}`,
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
// Decoupled from runMatcher: only runs 步骤8 (scrape-confirmed matching by
// shared mb_recording_id). Reads existing groups from group_tracks and merges
// new scrape-based connections into them, then persists the merged result.
// MB and AcoustID scrape matching are tracked independently within the same
// function — both share the same logic (步骤8), but pairs are tagged
// separately so the duplicate group reflects which confirmation it got.
export async function runScrapeMatcher(db, opts = {}) {
  const {
    qualityTiers = null,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;

  onProgress({ phase: 'matching', pct: 0, message: '开始刮削匹配分析...' });

  const allFiles  = getAllFilesForMatching(db);
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));
  const metaFiles = allFiles.filter(f => !whitelist.has(f.id));

  if (metaFiles.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件' });
    return;
  }

  const withMbRid2 = metaFiles.filter(f => f.mb_recording_id).length;
  const withAidRid2 = metaFiles.filter(f => f.acoustid_recording_id).length;
  onProgress({
    phase: 'matching', pct: 10,
    message: `开始刮削数据重复检测（${metaFiles.length.toLocaleString()} 个文件，MB recording ID: ${withMbRid2}，AcoustID recording ID: ${withAidRid2}）...`,
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

  // ── 步骤8: 刮削匹配 ──────────────────────────────────────────────────
  // Combined recording-id map: both MB and AcoustID sources produce
  // MusicBrainz recording IDs — same ID space, different verification
  // channels. A single map ensures cross-source matches are found (e.g.
  // file A via MB and file B via AcoustID converging on the same MBID).
  const recordingMap = new Map();
  for (const f of metaFiles) {
    const ids = new Set();
    if (f.mb_recording_id) ids.add(f.mb_recording_id);
    if (f.acoustid_recording_id) ids.add(f.acoustid_recording_id);
    for (const rid of ids) {
      if (!recordingMap.has(rid)) recordingMap.set(rid, []);
      recordingMap.get(rid).push(f);
    }
  }

  let mbConfirmed = 0, acoustidConfirmed = 0;
  for (const group of recordingMap.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!plausiblePair(a, b)) continue;
        uf.union(a.id, b.id);
        const sameMb = a.mb_recording_id && b.mb_recording_id && a.mb_recording_id === b.mb_recording_id;
        const sameAid = a.acoustid_recording_id && b.acoustid_recording_id && a.acoustid_recording_id === b.acoustid_recording_id;
        const crossSource = !sameMb && !sameAid;
        if (sameMb) { mbConfirmedPairs.add(pairKey(a.id, b.id)); mbConfirmed++; }
        if (sameAid || crossSource) { acoustidConfirmedPairs.add(pairKey(a.id, b.id)); acoustidConfirmed++; }
      }
    }
  }

  onProgress({
    phase: 'matching', pct: 80,
    message: `刮削交叉确认完成：${mbConfirmed + acoustidConfirmed} 对（MusicBrainz ${mbConfirmed}，AcoustID ${acoustidConfirmed}）`,
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
// Decoupled from runMatcher: only runs 步骤3a (title grouping) + 步骤3b
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

  onProgress({ phase: 'matching', pct: 0, message: '开始基础匹配分析...' });

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

  // ── 步骤3a: 标题分组 ───────────────────────────────────────────────────
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
  onProgress({ phase: 'matching', pct: 40, message: `标题分组完成：${titleGroups} 组` });

  if (onAbort()) return;
  await onPause();

  // ── 步骤3b: 属性确认 ──────────────────────────────────────────────────
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
    message: `属性确认匹配完成：${metaConfirmed} 对`,
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
// fingerprint — 步骤5a (exact FP), 步骤5b (prefix LSH), 步骤5c (duration
// bucket), and 步骤6 (Chromaprint). Preserves existing groups and merges
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
  onProgress({ phase: 'matching', pct: 0, message: '开始声纹匹配分析...' });

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

  const withChromaFp = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id)).length;
  onProgress({
    phase: 'matching', pct: 10,
    message: `开始声纹重复检测（${files.length.toLocaleString()} 个频谱声纹文件，${withChromaFp} 个 Chromaprint 声纹文件）...`,
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
    const sim = fingerprintSimilarity(a.fingerprint, b.fingerprint, FP_MAX_OFFSET);
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

  // ── 步骤5a: 精确声纹 ───────────────────────────────────────────────────
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
  onProgress({ phase: 'matching', pct: 30, message: `精确声纹匹配完成：${exactCount} 对` });

  if (onAbort()) return;
  await onPause();

  // ── 步骤5b: 多段LSH分组 ─────────────────────────────────────────────────
  const prefixMap = new Map();
  for (const f of files) {
    const keys = fpMultiKeys(f.fingerprint);
    for (const key of keys) {
      if (!prefixMap.has(key)) prefixMap.set(key, []);
      prefixMap.get(key).push(f);
    }
  }
  let prefixGroups = 0;
  for (const group of prefixMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group);
    prefixGroups++;
  }
  onProgress({ phase: 'matching', pct: 50, message: `多段LSH分组完成：${prefixGroups} 组` });

  if (onAbort()) return;
  await onPause();

  // ── 步骤5c: 时长桶+相似度 ──────────────────────────────────────────────
  // Oversized buckets are recursively subdivided by fingerprint segments
  // instead of being skipped.
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
  const durKeyFn = (f) => fpMultiKeys(f.fingerprint);
  for (const group of durMap.values()) {
    if (group.length < 2) continue;
    if (group.length > DUR_BUCKET_LIMIT) {
      if (!subdivideDurBucket(group, durKeyFn, compareGroup)) durSkipped++;
      else durGroups++;
    } else {
      compareGroup(group);
      durGroups++;
    }
  }
  onProgress({ phase: 'matching', pct: 75, message: `时长桶匹配完成：${durGroups} 组${durSkipped?`（另有 ${durSkipped} 个超大分组递归细分后仍超限，已跳过）`:''}` });

  if (onAbort()) return;
  await onPause();

  // ── 步骤6: CP声纹匹配 ──────────────────────────────────────────────────
  // Uses hardcoded CP_THRESH (0.90), independent of the spectral threshold.
  // Multi-segment LSH + duration buckets with recursive subdivision.
  const cpFiles = allFiles.filter(f => f.chromaprint_raw && !whitelist.has(f.id));

  function compareCpGroup(group) {
    for (let i = 0; i < group.length && !onAbort(); i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const key = pairKey(a.id, b.id);
        if (cpSimMap.has(key)) continue;
        const sim = chromaprintSimilarity(a.chromaprint_raw, b.chromaprint_raw, FP_MAX_OFFSET);
        cpSimMap.set(key, sim);
        if (sim >= CP_THRESH && (sim >= VERY_HIGH_SIM || plausiblePair(a, b))) { uf.union(a.id, b.id); cpConfirmedPairs.add(key); }
      }
    }
  }

  let cpLshGroups = 0, cpDurGroups = 0, cpDurSkipped = 0;
  if (cpFiles.length >= 2) {
    // 6a: CP多段LSH
    const cpPrefixMap = new Map();
    for (const f of cpFiles) {
      const keys = cpMultiKeys(f.chromaprint_raw);
      for (const key of keys) {
        if (!cpPrefixMap.has(key)) cpPrefixMap.set(key, []);
        cpPrefixMap.get(key).push(f);
      }
    }
    for (const group of cpPrefixMap.values()) {
      if (group.length < 2) continue;
      compareCpGroup(group);
      cpLshGroups++;
    }

    // 6b: CP时长桶（递归细分超限桶）
    const cpDurMap = new Map();
    for (const f of cpFiles) {
      if (!f.duration) continue;
      const bucket = Math.round(f.duration / 4);
      for (const b of [bucket - 1, bucket, bucket + 1]) {
        const ckey = `CPDUR:${b}`;
        if (!cpDurMap.has(ckey)) cpDurMap.set(ckey, []);
        cpDurMap.get(ckey).push(f);
      }
    }
    const cpKeyFn = (f) => cpMultiKeys(f.chromaprint_raw);
    for (const group of cpDurMap.values()) {
      if (group.length < 2) continue;
      if (group.length > DUR_BUCKET_LIMIT) {
        if (!subdivideDurBucket(group, cpKeyFn, compareCpGroup)) cpDurSkipped++;
        else cpDurGroups++;
      } else {
        compareCpGroup(group);
        cpDurGroups++;
      }
    }
  }
  onProgress({ phase: 'matching', pct: 90,
    message: cpFiles.length >= 2
      ? `CP声纹匹配完成：${cpFiles.length} 个文件参与，LSH ${cpLshGroups} + 时长 ${cpDurGroups} 组${cpDurSkipped?`（${cpDurSkipped} 个超限）`:''}`
      : `CP声纹匹配跳过：无 CP 声纹（未安装/未配置 fpcalc）` });

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
