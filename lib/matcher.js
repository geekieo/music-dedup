// lib/matcher.js — 重复检测匹配器
//
// ═══════════════════════════════════════════════════════════════════════════
// 全局 8 步执行流程（server.js 调度顺序）
// ═══════════════════════════════════════════════════════════════════════════
//
//   步骤 1  枚举              scanner.js    扫描目录，发现文件，入库
//   步骤 2  提取属性          scanner.js    读取文件属性（标题/艺术家/专辑/时长/格式/比特率等）
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
import { detectGroupType, detectGroupTags, MATCHING_METHOD_KEYS, evaluateGroup } from './rules.js';
import { SPECTRAL_EXACT_SIM, CP_SIMILAR_SIM } from './constants.js';
import { getAllFilesForMatching } from './db/files.js';
import { clearGroups, insertGroup, insertGroupTrack, setGroupSmartKeep, getGroups, getGroupDetail } from './db/groups.js';
import { getRetentionFileIds, getExcludeFileIds } from './db/retention.js';
import { getAppliedPickSettings } from './db/settings.js';
import { Progress, createPhaseLog } from './progress.js';

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
const MAX_SUBDIVIDE_DEPTH = 3;

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

// ── Recursive duration-bucket pair collection ─────────────────────────────
// 超限时长桶按指纹段键细分至多 3 层，把最终会参与比对的配对收集进 pairSet；
// skip=simMap 用于频谱侧排除 5a 已确认的精确对（CP 侧无预置对，不传）。
function addPairsToSet(group, pairSet, skip = null) {
  for (let i = 0; i < group.length; i++)
    for (let j = i + 1; j < group.length; j++) {
      const key = pairKey(group[i].id, group[j].id);
      if (!skip?.has(key)) pairSet.add(key);
    }
}
function collectBucketPairs(group, getSegmentKeys, pairSet, skip = null, depth = 0) {
  if (group.length <= DUR_BUCKET_LIMIT || depth >= MAX_SUBDIVIDE_DEPTH) {
    if (group.length <= DUR_BUCKET_LIMIT) addPairsToSet(group, pairSet, skip);
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
    if (!collectBucketPairs(sub, getSegmentKeys, pairSet, skip, depth + 1)) allOk = false;
  }
  return allOk;
}

// ── 匹配阶段协作式让出事件循环 ──────────────────────────────────────
// 匹配阶段是纯 CPU 同步（相似度对比 × 大量文件对），在主进程线程跑会让窗口"未响应"。
// maybeYield 每 ~YIELD_INTERVAL_MS 让出一次（setImmediate → macrotask → 事件循环泵出
// 窗口消息/拖动）。算法与结果不变。
const YIELD_INTERVAL_MS = 40;
async function maybeYield(lastYieldRef) {
  const now = Date.now();
  if (now - lastYieldRef.t > YIELD_INTERVAL_MS) {
    lastYieldRef.t = now;
    await new Promise(r => setImmediate(r));
  }
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

// 分片哈希：同一配对（pairKey 一致）跨子阶段落同一分片，去重/合并天然成立
function hashPairKey(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}

// ── Shared: plausibility gate ──────────────────────────────────────────────
// Below ~97% spectral similarity (essentially certain to be the same audio
// regardless of tags), require SOME independent corroboration — title or
// artist text actually overlapping — before trusting a bare spectral/
// Chromaprint score enough to union. Also used by scrape/basic matchers as
// a sanity check on candidate pairs.
// 阈值常量在 lib/constants.js；局部别名保留 matcher 上下文语义。
const VERY_HIGH_SIM = SPECTRAL_EXACT_SIM;
// Chromaprint uses its own hardcoded threshold, independent of the user-configurable
// spectral threshold — the two fingerprinting algorithms have different similarity
// distributions, so a single slider would be misleading.
const CP_THRESH = CP_SIMILAR_SIM;
function plausiblePair(a, b) {
  const tA = normalizeStr(a.title||''), tB = normalizeStr(b.title||'');
  if (tA && tB && strSim(tA, tB) >= 0.5) return true;
  const arA = normalizeStr(a.artist||''), arB = normalizeStr(b.artist||'');
  if (arA && arB && strSim(arA, arB) >= 0.5) return true;
  return false;
}

// ── Shared: load existing groups into UF ──────────────────────────────────
function loadExistingGroups(db, uf, fileById) {
  const rows = db.all('SELECT gt.group_id, gt.file_id FROM group_tracks gt JOIN dup_groups g ON g.id=gt.group_id ORDER BY gt.group_id');
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
// async + 时间切片让出（大组 maxSim 对 + 每簇 detectGroupType/tags 都是同步 CPU）
async function persistClusters(db, uf, fileById, opts) {
  const {
    simMap, cpSimMap, thresh,
    metaConfirmedPairs, mbConfirmedPairs, acoustidConfirmedPairs, cpConfirmedPairs,
    phase = 'match', onProgress, onAbort,
  } = opts;

  // Snapshot existing matching-method tags before clearing, so tags from other
  // phases survive partial rematches (e.g. runBasicMatcher / runFpMatcher).
  const prevMethodTags = new Map(); // "id1,id2,..." → Set of method-tag strings
  const oldGroups = db.all('SELECT g.id, g.group_tags FROM dup_groups g');
  for (const g of oldGroups) {
    const trackIds = db.all('SELECT file_id FROM group_tracks WHERE group_id=? ORDER BY file_id', [g.id]).map(r => r.file_id);
    if (trackIds.length >= 2) {
      const methodTags = (g.group_tags || '').split(',').filter(Boolean).filter(t => MATCHING_METHOD_KEYS.has(t));
      if (methodTags.length) prevMethodTags.set(trackIds.join(','), new Set(methodTags));
    }
  }

  const dupClusters = uf.clusters();
  const innerProg = new Progress(onProgress);
  const persistLog = createPhaseLog(innerProg, { phase, label: '写入重复组', pctFrom: 95, pctTo: 100 });
  innerProg.emit({ pct: 95, level: 'info', message: `发现 ${dupClusters.length} 个重复组，写入数据库...` });
  persistLog.start(dupClusters.length, null);

  clearGroups(db);

  // 智能保留级联参数在扫描开始时固定（applied 快照 = 主进程 /api/scan/start 写入的
  // 当前值）：扫描即执行，扫描结果与详情/放入回收站使用同一份优先级。
  const { quality_tiers, pick_tag_order } = getAppliedPickSettings(db);
  const retentionFileIds = getRetentionFileIds(db);
  const excludeFileIds   = getExcludeFileIds(db);

  let inserted = 0, totalDupBytes = 0;
  const y = { t: Date.now() };
  // 分批事务：批间检查 abort + 让出事件循环；abort 时当前批 COMMIT（已写保留）
  const TX_BATCH = 100;
  db.exec('BEGIN');
  try {
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
          await maybeYield(y);
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

      // 智能保留级联：与 /api/duplicates 详情/操作同源（applied 快照 + 手动保留名单），
      // 扫描时即固化推荐保留，列表/统计/操作全用它。
      const annotated = evaluateGroup(clusterFiles, { tierOrder: quality_tiers, pickTagOrder: pick_tag_order, retentionFileIds, excludeFileIds });
      const smartKeepFileId = annotated.find(t => t._retained)?.id || null;

      const type        = detectGroupType(clusterFiles);
      const group_tags = detectGroupTags(clusterFiles, maxSim, {
        spectralConfirmed,
        metaConfirmed:  anyMetaConfirmed,
        mbConfirmed:    anyMbConfirmed,
        acoustidConfirmed: anyAcoustidConfirmed,
        cpConfirmed: anyCpConfirmed,
        maxCpSim, hasCpData,
      });
      let final_tags = group_tags;

      // Merge matching-method tags from previous runs (survives partial rematches).
      const clusterKey = [...cluster].sort((a, b) => a - b).join(',');
      const prevTags = prevMethodTags.get(clusterKey);
      if (prevTags && prevTags.size) {
        const merged = new Set(final_tags.split(',').filter(Boolean));
        for (const t of prevTags) merged.add(t);
        final_tags = [...merged].join(',');
      }
      const similarity  = Math.min(100, Math.round(maxSim * 100));
      const groupId     = insertGroup(db, { similarity, type, group_tags: final_tags, created_time: Date.now() });
      setGroupSmartKeep(db, groupId, smartKeepFileId);
      // Compute savings: sum of non-kept tracks（多个推荐保留平局时按真实删除集算）
      const keepIds = new Set(annotated.filter(t => t._retained).map(t => t.id));
      for (const t of clusterFiles) {
        insertGroupTrack(db, { group_id: groupId, file_id: t.id });
        if (!keepIds.has(t.id)) totalDupBytes += t.size || 0;
      }
      inserted++;
      persistLog.tick(inserted);
      await maybeYield(y);
      if (inserted % TX_BATCH === 0) { db.exec('COMMIT'); db.exec('BEGIN'); }
    }
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }

  return { inserted, dupBytes: totalDupBytes };
}


function fmtBytes(b) {
  if (b>=1e12) return (b/1e12).toFixed(2)+' TB';
  if (b>=1e9)  return (b/1e9).toFixed(2)+' GB';
  if (b>=1e6)  return (b/1e6).toFixed(1)+' MB';
  return Math.round(b/1e3)+' KB';
}

// ── 智能保留（standalone 重算，步骤 'smartKeep'）────────────────────────────
// 只重算未处理组的 smart_keep_file_id（用 applied 快照 + 手动保留名单跑级联），
// 不清除/重建组。worker 侧跑在临时库副本上，结果经分阶段合并回主库。
export async function runSmartKeep(db, opts = {}) {
  const {
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;
  const prog = new Progress(onProgress);
  const log = createPhaseLog(prog, { phase: 'smartKeep', label: '智能保留', pctFrom: 5, pctTo: 100 });
  const { quality_tiers, pick_tag_order } = getAppliedPickSettings(db);
  const retentionFileIds = getRetentionFileIds(db);
  const excludeFileIds   = getExcludeFileIds(db);

  const groups = getGroups(db, { resolved: false });
  if (!groups.length) {
    log.start(0, '无未处理组');
    log.done('没有未处理的重复组');
    return;
  }
  log.start(groups.length, `${groups.length} 个未处理组`);

  let updated = 0;
  for (let i = 0; i < groups.length; i++) {
    if (onAbort()) break;
    const g = getGroupDetail(db, groups[i].id);
    if (!g) continue;
    const annotated = evaluateGroup(g.tracks, { tierOrder: quality_tiers, pickTagOrder: pick_tag_order, retentionFileIds, excludeFileIds });
    setGroupSmartKeep(db, g.id, annotated.find(t => t._retained)?.id || null);
    updated++;
    log.tick(i + 1);
  }
  await onPause();
  return { message: `智能保留完成：更新 ${updated} 个组` };
}

// ── Scrape-only matcher ────────────────────────────────────────────────────
// Only runs 步骤8 (scrape-confirmed matching by
// shared mb_recording_id). Reads existing groups from group_tracks and merges
// new scrape-based connections into them, then persists the merged result.
// MB and AcoustID scrape matching are tracked independently within the same
// function — both share the same logic (步骤8), but pairs are tagged
// separately so the duplicate group reflects which confirmation it got.
export async function runScrapeMatcher(db, opts = {}) {
  const {
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;
  const prog = new Progress(onProgress);
  prog.emit({ phase: 'scrapeMatch', pct: 0, level: 'info', message: '开始刮削匹配...' });

  const allFiles  = getAllFilesForMatching(db);
  const metaFiles = allFiles;

  if (metaFiles.length === 0) {
    prog.done('没有可匹配的文件');
    return;
  }

  const withMbRid2 = metaFiles.filter(f => f.mb_recording_id).length;
  const withAidRid2 = metaFiles.filter(f => f.acoustid_recording_id).length;
  prog.emit({
    phase: 'scrapeMatch', pct: 10, level: 'info',
    message: `开始刮削数据重复检测（${metaFiles.length.toLocaleString()} 个文件，MB recording ID: ${withMbRid2}，AcoustID recording ID: ${withAidRid2}）...`,
  });

  const uf       = buildUF(metaFiles.map(f => f.id));
  const fileById = new Map(metaFiles.map(f => [f.id, f]));

  const mbConfirmedPairs       = new Set();
  const acoustidConfirmedPairs = new Set();

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById, null);
  if (preservedCount) prog.emit({ phase: 'scrapeMatch', pct: 20, level: 'info', message: `已保留 ${preservedCount} 个现有重复组，合并刮削数据...` });

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
  const y = { t: Date.now() }; // 时间切片让出
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
        await maybeYield(y);
      }
    }
  }

  prog.emit({
    phase: 'scrapeMatch', pct: 80,
    message: `刮削交叉确认完成：${mbConfirmed + acoustidConfirmed} 对（MusicBrainz ${mbConfirmed}，AcoustID ${acoustidConfirmed}）`,
  });

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  const { inserted, dupBytes } = await persistClusters(db, uf, fileById, {
    simMap: null, cpSimMap: null, thresh: 0, phase: 'scrapeMatch',
    metaConfirmedPairs: null, mbConfirmedPairs, acoustidConfirmedPairs, cpConfirmedPairs: null,
    onProgress: (evt) => prog.emit({level:'info', ...evt}), onAbort,
  });

  return { message: `刮削匹配完成！发现 ${inserted} 个重复组，可释放 ${fmtBytes(dupBytes)}`, groups: inserted, savings: dupBytes };
}

// ── Basic matcher (metadata-only) ─────────────────────────────────────────
// Only runs 步骤3a (title grouping) + 步骤3b
// (title+artist+duration confirmation). No fingerprint dependency — works on
// ALL files with metadata, regardless of whether a spectral fingerprint was
// ever extracted. Preserves existing groups and merges new results.
export async function runBasicMatcher(db, opts = {}) {
  const {
    durationTolerance = 5,
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;
  const prog = new Progress(onProgress);
  prog.emit({ phase: 'basicMatch', pct: 0, level: 'info', message: '开始基础匹配...' });

  const allFiles  = getAllFilesForMatching(db);
  const metaFiles = allFiles;

  if (metaFiles.length === 0) {
    prog.done('没有可匹配的文件');
    return;
  }

  prog.emit({
    phase: 'basicMatch', pct: 10, level: 'info',
    message: `开始基础重复检测（${metaFiles.length.toLocaleString()} 个文件）...`,
  });

  const uf       = buildUF(metaFiles.map(f => f.id));
  const fileById = new Map(metaFiles.map(f => [f.id, f]));
  const metaConfirmedPairs = new Set();

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById, null);
  if (preservedCount) prog.emit({ phase: 'basicMatch', pct: 20, level: 'info', message: `已保留 ${preservedCount} 个现有重复组，合并基础匹配...` });

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
  prog.emit({ phase: 'basicMatch', pct: 40, message: `标题分组完成：${titleGroups} 组` });

  if (onAbort()) return;
  await onPause();

  // ── 步骤3b: 属性确认 ──────────────────────────────────────────────────
  // Same title + matching artist + similar duration → duplicate.
  // No fingerprint comparison — this is the core signal for the basic lane.
  const confirmLog = createPhaseLog(prog, { phase: 'basicMatch', label: '属性确认', pctFrom: 40, pctTo: 80 });
  let metaConfirmed = 0;
  const DURATION_TOLERANCE_S = durationTolerance;
  const titleGroupList = [...titleMap.values()];
  const titleGroupTotal = titleGroupList.length;
  let titleGroupDone = 0;
  confirmLog.start(titleGroupTotal, `${titleGroupTotal} 组`);
  const y = { t: Date.now() }; // 时间切片让出，超大同名组不阻塞窗口
  for (const group of titleGroupList) {
    if (group.length < 2) { titleGroupDone++; continue; }
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        if (!artistsMatch(a.artist, b.artist)) continue;
        if (!a.duration || !b.duration) continue;
        if (Math.abs(a.duration - b.duration) > DURATION_TOLERANCE_S) continue;
        uf.union(a.id, b.id);
        metaConfirmedPairs.add(pairKey(a.id, b.id));
        metaConfirmed++;
        await maybeYield(y);
      }
    }
    titleGroupDone++;
    confirmLog.tick(titleGroupDone);
  }

  confirmLog.done(`属性确认匹配完成：${metaConfirmed} 对`, { phase: 'basicMatch', pct: 80 });

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  const { inserted, dupBytes } = await persistClusters(db, uf, fileById, {
    simMap: null, cpSimMap: null, thresh: 0, phase: 'basicMatch',
    metaConfirmedPairs, mbConfirmedPairs: null, acoustidConfirmedPairs: null, cpConfirmedPairs: null,
    onProgress: (evt) => prog.emit({level:'info', ...evt}), onAbort,
  });

  return { message: `基础匹配完成！发现 ${inserted} 个重复组，可释放 ${fmtBytes(dupBytes)}`, groups: inserted, savings: dupBytes };
}

// ── Fingerprint matcher (spectral-only) ───────────────────────────────────
// Only runs phases that require a spectral
// fingerprint — 步骤5a (exact FP), 步骤5b (prefix LSH), 步骤5c (duration
// bucket), and 步骤6 (Chromaprint). Preserves existing groups and merges
// new fingerprint-based connections into them.
export async function runFpMatcher(db, opts = {}) {
  const {
    threshold  = 95,
    matchPool = null, // 并发池（electron/match-pool.mjs）；null = 串行内联兜底
    onProgress = () => {},
    onAbort    = () => false,
    onPause    = async () => {},
  } = opts;
  const thresh = threshold / 100;
  const prog = new Progress(onProgress);
  prog.emit({ phase: 'fpMatch', pct: 0, level: 'info', message: '开始声纹匹配...' });

  const allFiles  = getAllFilesForMatching(db);

  const files = allFiles.filter(f => {
    if (!f.fingerprint) return false; // 无指纹：不参与声纹匹配
    if (!f.fingerprint.startsWith('META:')) {
      const parts = f.fingerprint.trim().split(' ');
      const nonZero = parts.filter(v => v !== '0').length;
      if (nonZero < parts.length * 0.1) return false;
    }
    return true;
  });

  if (files.length === 0) {
    prog.done('没有可匹配的文件（无声纹数据）');
    return;
  }

  const withChromaFp = allFiles.filter(f => f.chromaprint_raw).length;
  prog.emit({
    phase: 'fpMatch', pct: 10, level: 'info',
    message: `开始频谱声纹重复检测（${files.length.toLocaleString()} 个频谱声纹文件，${withChromaFp} 个 Chromaprint 声纹文件）...`,
  });

  // UF built from ALL files so existing groups can be preserved
  const uf       = buildUF(allFiles.map(f => f.id));
  const simMap   = new Map();
  const cpSimMap = new Map();
  const fileById = new Map(allFiles.map(f => [f.id, f]));
  const cpConfirmedPairs = new Set();

  // ── Preserve existing groups ──────────────────────────────────────────
  const preservedCount = loadExistingGroups(db, uf, fileById, null);
  if (preservedCount) prog.emit({ phase: 'fpMatch', pct: 15, level: 'info', message: `已保留 ${preservedCount} 个现有重复组，合并声纹匹配...` });

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
  prog.emit({ phase: 'fpMatch', pct: 30, message: `频谱精确声纹匹配完成：${exactCount} 对` });

  if (onAbort()) return;
  await onPause();

  // ── 候选收集：5b 频谱LSH + 5c 频谱时长桶 + 6a CP-LSH + 6b CP时长桶 ──
  // 只收集最终要两两比对的配对进 Set（超限桶按段键细分），不算相似度；相似度交给
  // 并发池统一计算（见下）。skip=simMap 排除 5a 已确认的精确对，避免重复比对。
  const spectralPairs = new Set();
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
    addPairsToSet(group, spectralPairs, simMap);
    prefixGroups++;
  }
  prog.emit({ phase: 'fpMatch', pct: 42, message: `频谱多段LSH分组完成：${prefixGroups} 组` });

  if (onAbort()) return;
  await onPause();

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
    if (group.length > DUR_BUCKET_LIMIT) {
      if (!collectBucketPairs(group, fpMultiKeys, spectralPairs, simMap)) durSkipped++;
      else durGroups++;
    } else {
      addPairsToSet(group, spectralPairs, simMap);
      durGroups++;
    }
  }
  prog.emit({ phase: 'fpMatch', pct: 50, message: `频谱时长桶收集完成：${durGroups} 组${durSkipped?`（${durSkipped} 超限）`:''}，频谱候选 ${spectralPairs.size} 对` });

  if (onAbort()) return;
  await onPause();

  const cpFiles = allFiles.filter(f => f.chromaprint_raw);
  const cpPairs = new Set();
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
      addPairsToSet(group, cpPairs);
      cpLshGroups++;
    }
    // 6b: CP时长桶（递归细分超限桶）
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
      if (group.length < 2) continue;
      if (group.length > DUR_BUCKET_LIMIT) {
        if (!collectBucketPairs(group, cpMultiKeys, cpPairs)) cpDurSkipped++;
        else cpDurGroups++;
      } else {
        addPairsToSet(group, cpPairs);
        cpDurGroups++;
      }
    }
  }
  prog.emit({ phase: 'fpMatch', pct: 60,
    message: cpFiles.length >= 2
      ? `声纹候选收集完成：频谱 ${spectralPairs.size} 对 + CP ${cpPairs.size} 对（CP-LSH ${cpLshGroups} 组 + CP时长 ${cpDurGroups} 组${cpDurSkipped?`，${cpDurSkipped} 超限`:''}）`
      : `声纹候选收集完成：频谱 ${spectralPairs.size} 对（无 CP 声纹，跳过 Chromaprint）` });

  if (onAbort()) return;
  await onPause();

  // ── 相似度计算：并发池分片 或 串行兜底 ──
  const results = { spectral: new Map(), cp: new Map() };
  if (matchPool) {
    // 指纹一次性注入 worker（只算相似度，不碰库），配对按 pairKey 哈希分片同池并行
    matchPool.prepare(allFiles.map(f => ({ id: f.id, fingerprint: f.fingerprint, chromaprint_raw: f.chromaprint_raw })));
    const totalPairs = spectralPairs.size + cpPairs.size;
    const shardCount = Math.min(matchPool.concurrency || 1, Math.max(1, Math.ceil(totalPairs / 40)));
    const shards = Array.from({ length: shardCount }, () => ({ spectral: [], cp: [] }));
    for (const key of spectralPairs) {
      const [a, b] = key.split('-').map(Number);
      shards[hashPairKey(key) % shardCount].spectral.push([a, b]);
    }
    for (const key of cpPairs) {
      const [a, b] = key.split('-').map(Number);
      shards[hashPairKey(key) % shardCount].cp.push([a, b]);
    }
    const jobs = shards.filter(s => s.spectral.length || s.cp.length);
    const jobsTotal = jobs.length;
    const matchLog = createPhaseLog(prog, { phase: 'fpMatch', label: '声纹比对', pctFrom: 60, pctTo: 92 });
    matchLog.start(jobsTotal, `${jobsTotal} 个分片`);
    let done = 0;
    const settled = await Promise.allSettled(jobs.map((sh) =>
      matchPool.computeShard({ maxOffset: FP_MAX_OFFSET, spectralPairs: sh.spectral, cpPairs: sh.cp }).then((r) => {
        done++;
        matchLog.tick(done);
        for (const [k, v] of Object.entries(r.spectral || {})) results.spectral.set(k, v);
        for (const [k, v] of Object.entries(r.cp || {})) results.cp.set(k, v);
      })
    ));
    if (onAbort()) return; // 中止：池已 terminate 在途 worker，分片 reject 被 allSettled 吞掉
    matchLog.done(`声纹比对完成：频谱 ${results.spectral.size} 对 + CP ${results.cp.size} 对`, { phase: 'fpMatch', pct: 92, level: 'ok' });
    for (const s of settled) if (s.status === 'rejected') throw s.reason;
  } else {
    const y = { t: Date.now() };
    for (const key of spectralPairs) {
      if (onAbort()) break;
      const [a, b] = key.split('-').map(Number);
      const fa = fileById.get(a), fb = fileById.get(b);
      if (fa && fb && fa.fingerprint && fb.fingerprint) results.spectral.set(key, fingerprintSimilarity(fa.fingerprint, fb.fingerprint, FP_MAX_OFFSET));
      await maybeYield(y);
    }
    for (const key of cpPairs) {
      if (onAbort()) break;
      const [a, b] = key.split('-').map(Number);
      const fa = fileById.get(a), fb = fileById.get(b);
      if (fa && fb && fa.chromaprint_raw && fb.chromaprint_raw) results.cp.set(key, chromaprintSimilarity(fa.chromaprint_raw, fb.chromaprint_raw, FP_MAX_OFFSET));
      await maybeYield(y);
    }
    prog.emit({ phase: 'fpMatch', pct: 92, message: `声纹比对完成：频谱 ${results.spectral.size} 对 + CP ${results.cp.size} 对` });
  }
  if (onAbort()) return;
  await onPause();

  // ── 应用并查集：阈值 + 佐证门 ──
  for (const key of spectralPairs) {
    const sim = results.spectral.get(key);
    if (sim == null) continue;
    simMap.set(key, sim);
    const [a, b] = key.split('-').map(Number);
    if (sim >= thresh && (sim >= VERY_HIGH_SIM || plausiblePair(fileById.get(a), fileById.get(b)))) uf.union(a, b);
  }
  for (const key of cpPairs) {
    const sim = results.cp.get(key);
    if (sim == null) continue;
    cpSimMap.set(key, sim);
    const [a, b] = key.split('-').map(Number);
    if (sim >= CP_THRESH && (sim >= VERY_HIGH_SIM || plausiblePair(fileById.get(a), fileById.get(b)))) { uf.union(a, b); cpConfirmedPairs.add(key); }
  }

  if (onAbort()) return;
  await onPause();

  // ── Collect clusters & persist ───────────────────────────────────────
  await prog.flush();
  const { inserted, dupBytes } = await persistClusters(db, uf, fileById, {
    simMap, cpSimMap, thresh, phase: 'fpMatch',
    metaConfirmedPairs: null, mbConfirmedPairs: null, acoustidConfirmedPairs: null, cpConfirmedPairs,
    onProgress: (evt) => prog.emit({level:'info', ...evt}), onAbort,
  });

  return { message: `声纹匹配完成！发现 ${inserted} 个重复组（频谱精确 ${exactCount} 对 + CP 确认 ${cpConfirmedPairs.size} 对），可释放 ${fmtBytes(dupBytes)}`, groups: inserted, savings: dupBytes };
}
