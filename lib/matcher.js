// lib/matcher.js — Multi-phase duplicate detection (complete rewrite)
//
// Phase 1 – Exact fingerprint match   : identical strings → guaranteed duplicate
// Phase 2 – Title-based match         : same song name extracted from metadata OR filename
// Phase 3 – Fingerprint-prefix LSH    : first N integers shared → near-duplicate candidate
// Phase 4 – Duration bucket           : same duration ±4s, compared within artist/title groups

import nodePath from 'path';
import { fingerprintSimilarity, normalizeStr } from './fingerprint.js';
import { applyRetentionRules, detectGroupType } from './rules.js';
import { getAllFiles, getFilesByAlbum, clearGroups, insertGroup, insertGroupTrack, runTx } from './db.js';
// Note: whitelist filtering done via DB query - files with whitelist entries excluded


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
    onProgress = () => {},
    onAbort    = () => false,
  } = opts;

  const thresh = threshold / 100;
  onProgress({ phase: 'matching', pct: 90, message: '加载文件指纹数据...' });

  const allFiles = getAllFiles(db);
  // Load whitelist to exclude those files from matching
  const whitelist = new Set(db.all('SELECT file_id FROM whitelist').map(r => r.file_id));

  const files    = allFiles.filter(f => {
    if (!f.fingerprint) return false;
    if (whitelist.has(f.id)) return false;   // skip whitelisted files
    // Reject all-zero spectral fingerprints (silent audio causes mass false positives)
    if (!f.fingerprint.startsWith('META:')) {
      const parts = f.fingerprint.trim().split(' ');
      const nonZero = parts.filter(v => v !== '0').length;
      if (nonZero < parts.length * 0.1) return false;
    }
    return true;
  });

  if (files.length === 0) {
    onProgress({ phase: 'done', pct: 100, message: '没有可匹配的文件（缺少指纹数据，请重新扫描）' });
    return;
  }

  onProgress({ phase: 'matching', pct: 91, message: `开始多阶段重复检测（${files.length.toLocaleString()} 个有效文件）...` });

  // ── Build candidate pair set using multiple strategies ─────────────────
  const uf     = buildUF(files.map(f => f.id));
  const simMap = new Map();   // "minId-maxId" → similarity (avoid recomputing)
  const fileById = new Map(files.map(f => [f.id, f]));

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
  onProgress({ phase: 'matching', pct: 92, message: `阶段1完成：精确指纹匹配 ${exactCount} 对` });

  if (onAbort()) return;

  // ── Phase 2: Title-based match ─────────────────────────────────────────
  // Groups files with the same extracted song title (from metadata OR filename)
  const titleMap = new Map();
  for (const f of files) {
    const title = extractTitle(f);
    if (!title || title.length < 2) continue;
    if (!titleMap.has(title)) titleMap.set(title, []);
    titleMap.get(title).push(f);
  }
  let titleGroups = 0;
  for (const group of titleMap.values()) {
    if (group.length < 2) continue;
    compareGroup(group);
    titleGroups++;
  }
  onProgress({ phase: 'matching', pct: 94, message: `阶段2完成：标题分组 ${titleGroups} 组` });

  if (onAbort()) return;

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
  onProgress({ phase: 'matching', pct: 96, message: `阶段3完成：指纹前缀分组 ${prefixGroups} 组` });

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

    // Find max similarity within cluster
    let maxSim = 0;
    for (let i = 0; i < clusterFiles.length; i++) {
      for (let j = i + 1; j < clusterFiles.length; j++) {
        const s = simMap.get(pairKey(clusterFiles[i].id, clusterFiles[j].id)) || 0;
        if (s > maxSim) maxSim = s;
      }
    }

    runTx(db, () => {
      const annotated  = applyRetentionRules(clusterFiles, getLocalAlbumCount);
      const type       = detectGroupType(annotated);
      const similarity = Math.min(100, Math.round(maxSim * 100));
      const groupId    = insertGroup(db, { similarity, type, created_time: Date.now() });
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
    message: `扫描完成！发现 ${inserted} 个重复组（精确匹配 ${exactCount} 对），可释放 ${fmtBytes(dupBytes)}`,
    groups: inserted, savings: dupBytes,
  });
}

function fmtBytes(b) {
  if (b>=1e12) return (b/1e12).toFixed(2)+' TB';
  if (b>=1e9)  return (b/1e9).toFixed(2)+' GB';
  if (b>=1e6)  return (b/1e6).toFixed(1)+' MB';
  return Math.round(b/1e3)+' KB';
}
