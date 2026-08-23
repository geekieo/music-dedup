// lib/rules.js — Duplicate-group rule engine
// Evaluates every track in a duplicate group, assigns group tags (how was
// this group discovered?), pick tags (per-track characteristic tags — which
// dimension each track is best at), and display metadata for both tag sets.

import { normalizeStr } from './fingerprint.js';
import { CP_EXACT_SIM } from './constants.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants: quality tiers, pick-tag order, display labels
// ═══════════════════════════════════════════════════════════════════════════

export const DEFAULT_TIER_ORDER = [
  'Hi-Res FLAC / WAV (96kHz+)', 'FLAC / WAV (44.1kHz)', 'AIFF',
  'M4A / AAC ≥ 256k', 'MP3 320k', 'MP3 256k', 'MP3 192k',
  'OGG / Opus', 'MP3 128k 及以下',
];

// Default priority order for pick-tag cascade. Users can reorder in Settings.
// Ordered from "hard" signals intrinsic to the audio itself (can't be
// altered by tag-editing/scraping — low error risk) to "soft" signals
// that are just tag fields, which a scrape-and-write pass can change
// independently of whether the underlying file is actually the more
// authentic/untouched copy:
//   duration_accurate / quality_best  — read from the actual audio,
//     immune to tag edits; duration_accurate additionally verifies
//     against an external authoritative reference rather than trusting
//     any local tag, so it's the closest thing to a correctness check.
//   ctime_best                        — file creation time, newer is
//     better (later imports may be corrected versions).
//   album_best / release_best         — prefer the correct edition
//     (album over single/compilation; earliest known release year)
//     rather than rewarding tag richness.
//   scrape_best                       — only proves this copy's tags
//     were matched against official data, not that this copy is the
//     more authentic file (a scrape-and-write on either duplicate would
//     win this tier regardless of which one is actually original).
//   meta_best                         — pure tag-completeness. Explicitly
//     rewards "more filled-in fields", which directly penalizes an
//     untouched original for lacking scraped-in metadata. Kept only as
//     a last-resort tiebreaker when every harder signal is tied.
export const DEFAULT_PICK_TAG_ORDER = [
  'duration_accurate', 'quality_best', 'ctime_best', 'album_best', 'release_best', 'scrape_best', 'meta_best',
];

export const PICK_TAG_LABEL = {
  duration_accurate: '时长准确', quality_best: '音质最优', ctime_best: '入库更晚', album_best: '专辑优先',
  release_best: '发行更早', scrape_best: '刮削更准',  meta_best: '属性最全', manual_keep: '手动保留',
};
// PICK_TAG_LABEL 留在核心而非展示层（rules-ui.js）：evaluateGroup 的 TIER_DEFS
// 用它拼 _keepReason 文本，是级联输出的契约一部分。配套的 PICK_TAG_COLOR（纯展示）
// 已迁到 lib/rules-ui.js。

// Matching-method tag keys — answer "HOW was this group discovered".
export const MATCHING_METHOD_KEYS = new Set([
  'meta_confirmed', 'spectral_exact', 'same_recording',
  'cp_exact', 'cp_similar', 'mb_confirmed', 'acoustid_confirmed',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Pure helpers: quality, metadata, release type
// ═══════════════════════════════════════════════════════════════════════════

export function classifyQualityTier(track) {
  const fmt = (track.format || '').toUpperCase();
  const br  = track.bitrate  || 0;
  const sr  = track.sample_rate || 44100;
  const bps = track.bits_per_sample || 16;
  const lossless = ['FLAC', 'WAV', 'DSF', 'DFF'].includes(fmt);
  if (lossless && sr >= 88200 && bps >= 24) return 'Hi-Res FLAC / WAV (96kHz+)';
  if (fmt === 'AIFF') return 'AIFF';
  if (lossless) return 'FLAC / WAV (44.1kHz)';
  if ((fmt === 'M4A' || fmt === 'AAC') && br >= 256) return 'M4A / AAC ≥ 256k';
  if (fmt === 'MP3' && br >= 320) return 'MP3 320k';
  if (fmt === 'MP3' && br >= 256) return 'MP3 256k';
  if (fmt === 'MP3' && br >= 192) return 'MP3 192k';
  if (fmt === 'OGG' || fmt === 'OPUS' || fmt === 'OGG VORBIS') return 'OGG / Opus';
  return 'MP3 128k 及以下';
}

export function qualityScore(track, tierOrder) {
  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;
  const tier  = classifyQualityTier(track);
  let idx = order.indexOf(tier);
  if (idx === -1) idx = order.length;
  const tierScore = (order.length - idx) * 100000;
  const br = track.bitrate || 0, sr = track.sample_rate || 44100, bps = track.bits_per_sample || 16;
  return tierScore + br + sr / 1000 + bps;
}

export function metaScore(track) {
  let n = 0;
  if (track.title && track.title.length > 0) n++;
  if (track.artist && track.artist.length > 0) n++;
  if (track.album && track.album.length > 0) n++;
  if (track.album_year > 0) n++;
  if (track.track_number > 0) n++;
  if (track.genre && track.genre.length > 0) n++;
  return n;
}

export function classifyReleaseType(track) {
  if (track.release_type && track.release_type !== 'unknown') return track.release_type;
  const album = (track.album || '').toLowerCase();
  if (!album) return 'unknown';
  if (/greatest hits|best of|collection|compilation|anthology|playlist|top \d+|essential|complete|the very best/i.test(album)) return 'compilation';
  if (/\b(single|ep)\b/i.test(album)) return 'single';
  if (/soundtrack|ost|score|motion picture/i.test(album)) return 'soundtrack';
  return 'album';
}

const RELEASE_TYPE_SCORE = { album: 4, soundtrack: 3, compilation: 2, single: 1, unknown: 0 };

export function releaseTypeScore(track) {
  return RELEASE_TYPE_SCORE[classifyReleaseType(track)] || 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal helpers for evaluateGroup
// ═══════════════════════════════════════════════════════════════════════════

function albumLocalCount(t, fn) {
  return typeof fn === 'function' ? fn(t.album) : (t.localAlbumCount || 0);
}

function countScrapeMatches(t) {
  // Pick the best verified source: MB exact first, then AcoustID exact.
  const useAid = t.scrape_match_basis !== 'exact' && t.aid_match_basis === 'exact';
  const pf = useAid ? 'aid_' : 'scrape_';
  if (!useAid && t.scrape_match_basis !== 'exact') return 0;
  let n = 0;
  const normCmp = s => String(s || '').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g, '');
  if (t[`${pf}title`] && t.title && normCmp(t.title) === normCmp(t[`${pf}title`])) n++;
  if (t[`${pf}artist`] && t.artist && normCmp(t.artist) === normCmp(t[`${pf}artist`])) n++;
  if (t[`${pf}album`] && t.album && normCmp(t.album) === normCmp(t[`${pf}album`])) n++;
  if (t[`${pf}album_year`] && t.album_year && t.album_year === t[`${pf}album_year`]) n++;
  if (t[`${pf}track_number`] && t.track_number && t.track_number === t[`${pf}track_number`]) n++;
  if (t[`${pf}genre`] && t.genre && normalizeStr(t.genre) === normalizeStr(t[`${pf}genre`])) n++;
  return n;
}

// Shared computeScrapeMatch: returns { n, x } where x = 6 (fixed — all six
// fields title, artist, album, album_year, track_number, genre, matching the
// fixed-denominator convention used by metaScore's n/6), and n = count of
// those where the file also has a value and it matches the scraped value.
export function computeScrapeMatch(t) {
  const useAid = t.scrape_match_basis !== 'exact' && t.aid_match_basis === 'exact';
  const pf = useAid ? 'aid_' : 'scrape_';
  const normCmp = s => String(s || '').toLowerCase().replace(/[\s\u3000()（）【】「」\-_,.]/g, '');
  const fields = [
    { key: 'title',        cmp: (a, b) => normCmp(a) === normCmp(b) },
    { key: 'artist',       cmp: (a, b) => normCmp(a) === normCmp(b) },
    { key: 'album',        cmp: (a, b) => normCmp(a) === normCmp(b) },
    { key: 'album_year',   cmp: (a, b) => a === b },
    { key: 'track_number', cmp: (a, b) => a === b },
    { key: 'genre',        cmp: (a, b) => normCmp(a) === normCmp(b) },
  ];
  let n = 0;
  for (const { key, cmp } of fields) {
    const fv = t[key];
    const sv = t[`${pf}${key}`];
    if (fv != null && fv !== 0 && fv !== '' && sv != null && sv !== 0 && sv !== '' && cmp(fv, sv)) n++;
  }
  return { n, x: 6 };
}

const DURATION_ACCURATE_TOLERANCE = 3; // seconds

function groupDurationReference(tracks) {
  const mbVals  = tracks.filter(t => t.scrape_match_basis === 'exact' && t.scrape_duration > 0).map(t => t.scrape_duration);
  const aidVals = tracks.filter(t => t.aid_match_basis === 'exact' && t.aid_duration > 0).map(t => t.aid_duration);
  if (mbVals.length)  return mbVals[0];
  if (aidVals.length) return aidVals[0];
  return null;
}

function fmtQuality(t) {
  const fmt = (t.format || '').toUpperCase();
  const br  = t.bitrate || 0;
  const sr  = t.sample_rate || 44100;
  const lossless = ['FLAC','WAV','AIFF','DSF'].includes(fmt);
  if (lossless && sr >= 88200) return `Hi-Res ${fmt} ${sr/1000}kHz`;
  if (lossless) return fmt;
  return `${fmt} ${br}k`;
}

function fmtCtime(ts) {
  if (!ts) return '未知';
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// evaluateGroup — per-track dimension evaluation + pick-tag cascade
// ═══════════════════════════════════════════════════════════════════════════

export function evaluateGroup(tracks, { tierOrder, pickTagOrder, getLocalAlbumCount, retentionFileIds, excludeFileIds } = {}) {
  if (!tracks || tracks.length === 0) return [];

  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;
  const rids = retentionFileIds instanceof Set ? retentionFileIds : new Set();
  const exids = excludeFileIds instanceof Set ? excludeFileIds : new Set();

  const annotated = tracks.map(t => {
    const verified = t.scrape_match_basis === 'exact' || t.aid_match_basis === 'exact';
    return {
      ...t,
      _quality:        qualityScore(t, order),
      _meta:           metaScore(t),
      _scrapeVerified:  verified,
      _scrapeMatches:   verified ? countScrapeMatches(t) : 0,
      _scrapeMatchInfo: computeScrapeMatch(t),
      _localAlbumCount: albumLocalCount(t, getLocalAlbumCount),
      _rtype:           classifyReleaseType(t),
      _rtypeScore:      releaseTypeScore(t),
    };
  });

  if (annotated.length === 1) {
    annotated[0]._pickTags = [];
    annotated[0]._retained = true;
    annotated[0]._keepReason = '唯一版本';
    return annotated;
  }

  const groupDurationRef = groupDurationReference(annotated);
  for (const t of annotated) {
    t._durationRef = groupDurationRef;
    t._durationDeviation = (groupDurationRef != null && t.duration > 0) ? Math.abs(t.duration - groupDurationRef) : null;
    t._durationAccurate = t._durationDeviation != null ? t._durationDeviation <= DURATION_ACCURATE_TOLERANCE : null;
  }

  // ── Assign dimension tags ─────────────────────────────────────────────
  // Computed independently across the FULL set of tracks (before the
  // cascade), so every track that's best in a dimension gets that tag
  // displayed — even if the cascade later eliminates it at a higher-
  // priority tier. The cascade only narrows the retained candidates; tag display
  // answers "what is this track best at?" for every track.
  const bestQuality = Math.max(...annotated.map(t => t._quality));
  const bestCtime   = Math.max(...annotated.map(t => t.file_ctime || 0));
  const bestMeta    = Math.max(...annotated.map(t => t._meta));
  const bestScrape  = Math.max(...annotated.map(t => t._scrapeMatches));
  const bestRtype   = Math.max(...annotated.map(t => t._rtypeScore));
  const yearsWithVal = annotated.map(t => t.album_year).filter(y => y > 0);
  const earliestYr  = yearsWithVal.length > 0 ? Math.min(...yearsWithVal) : null;

  const diffQuality = new Set(annotated.map(t => t._quality)).size > 1;
  const diffCtime   = new Set(annotated.map(t => t.file_ctime || 0)).size > 1 && bestCtime > 0;
  const diffMeta    = new Set(annotated.map(t => t._meta)).size > 1 && bestMeta > 0;
  const diffScrape  = bestScrape > 0;
  const diffRtype   = new Set(annotated.map(t => t._rtypeScore)).size > 1 && bestRtype > 0;
  const diffYear    = new Set(annotated.map(t => t.album_year).filter(Boolean)).size > 1;
  const withDurationRef = groupDurationRef != null ? annotated.filter(t => t.duration > 0) : [];
  const allDurationAccurate = withDurationRef.length > 0 && withDurationRef.every(t => t._durationAccurate);
  const diffDuration = withDurationRef.length > 0 && !allDurationAccurate;

  for (const t of annotated) {
    const tags = [];
    if (diffQuality && t._quality === bestQuality) tags.push('quality_best');
    if (diffCtime && (t.file_ctime || 0) === bestCtime) tags.push('ctime_best');
    if (diffScrape && t._scrapeVerified && t._scrapeMatches === bestScrape) tags.push('scrape_best');
    if (diffRtype && t._rtypeScore === bestRtype) tags.push('album_best');
    if (diffYear && t.album_year && earliestYr !== null && t.album_year === earliestYr) tags.push('release_best');
    if (diffMeta && t._meta === bestMeta) tags.push('meta_best');
    if (diffDuration && t._durationAccurate) tags.push('duration_accurate');
    t._pickTags = tags;
  }

  let candidates = annotated;
  let smartRetained = null;
  let smartKeepReason = null;

  const TIER_DEFS = {
    scrape_best: {
      label: PICK_TAG_LABEL.scrape_best,
      reason: t => `${PICK_TAG_LABEL.scrape_best}（与官方标签吻合 ${t._scrapeMatches}/6 项：标题/艺术家/专辑/年份/曲目号/风格）`,
      applicable: t => t._scrapeVerified,
      groupGate: (applicable) => new Set(applicable.map(t => t.mb_recording_id).filter(Boolean)).size === 1,
      score: t => t._scrapeMatches,
    },
    quality_best: {
      label: PICK_TAG_LABEL.quality_best,
      reason: t => `优先音质 (${fmtQuality(t)})`,
      applicable: () => true,
      score: t => t._quality,
    },
    ctime_best: {
      label: PICK_TAG_LABEL.ctime_best,
      reason: t => `入库更晚 ${fmtCtime(t.file_ctime)}`,
      applicable: t => (t.file_ctime || 0) > 0,
      score: t => t.file_ctime || 0,
    },
    release_best: {
      label: PICK_TAG_LABEL.release_best,
      reason: t => `发行更早 ${t.album_year}`,
      applicable: t => t.album_year > 0,
      score: t => -t.album_year,
    },
    album_best: {
      label: PICK_TAG_LABEL.album_best,
      reason: t => `发行类型优先 (${t._rtype})`,
      applicable: t => t._rtypeScore > 0,
      score: t => t._rtypeScore,
    },
    meta_best: {
      label: PICK_TAG_LABEL.meta_best,
      reason: t => `属性最完整 (${t._meta}/6 项)`,
      applicable: () => true,
      score: t => t._meta,
    },
    duration_accurate: {
      label: PICK_TAG_LABEL.duration_accurate,
      reason: t => `${PICK_TAG_LABEL.duration_accurate} (${Math.round(t.duration)}s ≈ 精确刮削 ${Math.round(t._durationRef)}s)`,
      applicable: t => t._durationAccurate !== null,
      score: t => -Math.floor(t._durationDeviation / DURATION_ACCURATE_TOLERANCE),
    },
  };

  const tagOrder = Array.isArray(pickTagOrder) && pickTagOrder.length
    ? [...pickTagOrder, ...DEFAULT_PICK_TAG_ORDER.filter(k => !pickTagOrder.includes(k))]
    : DEFAULT_PICK_TAG_ORDER;

  function runTier(cands, def) {
    const applicable = cands.filter(def.applicable);
    if (applicable.length === 0) return { leaders: cands, tierLeaders: [] };
    if (def.groupGate && !def.groupGate(applicable)) return { leaders: cands, tierLeaders: [] };
    const best = Math.max(...applicable.map(def.score));
    const tierLeaders = applicable.filter(t => def.score(t) === best);
    if (tierLeaders.length === applicable.length) return { leaders: cands, tierLeaders: [] };
    const untouched = cands.filter(t => !applicable.includes(t));
    return { leaders: [...tierLeaders, ...untouched], tierLeaders };
  }

  for (const key of tagOrder) {
    if (candidates.length <= 1) break;
    const def = TIER_DEFS[key];
    if (!def) continue;
    const { leaders } = runTier(candidates, def);
    if (leaders.length === 1) {
      smartRetained = [leaders[0]];
      smartKeepReason = def.reason(leaders[0]);
      candidates = leaders;
      break;
    }
    candidates = leaders;
  }

  for (const t of annotated) if (rids.has(t.id)) t._pickTags.push('manual_keep');

  if (!smartRetained && candidates.length > 1) {
    const maxLib = Math.max(...candidates.map(t => t._localAlbumCount));
    if (maxLib > 0) {
      const top = candidates.filter(t => t._localAlbumCount === maxLib);
      if (top.length === 1) {
        smartRetained = [top[0]];
        smartKeepReason = `本地专辑曲目更多 (${top[0]._localAlbumCount} 首)`;
      }
    }
  }

  if (!smartRetained) {
    smartRetained = candidates;
    smartKeepReason = null;
  }

  const smartSet = new Set(smartRetained.map(t => t.id || t.path));
  for (const t of annotated) {
    const isSmart = smartSet.has(t.id || t.path);
    const isManual = rids.has(t.id);
    const isExcluded = exids.has(t.id || t.path);
    t._retained = (isSmart || isManual) && !isExcluded;
    if (isExcluded) {
      t._keepReason = null;
    } else if (isSmart && isManual) {
      t._keepReason = (smartKeepReason || '条件相同，建议手动选择') + ' · 手动保留';
    } else if (isSmart) {
      t._keepReason = smartKeepReason || (smartRetained.length > 1 ? '条件相同，建议手动选择' : null);
    } else if (isManual) {
      t._keepReason = '手动保留';
    } else {
      t._keepReason = null;
    }
  }
  return annotated;
}

// ═══════════════════════════════════════════════════════════════════════════
// Thin wrappers for callers that want the old standalone API
// ═══════════════════════════════════════════════════════════════════════════

export function tagTracks(tracks, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds) {
  return evaluateGroup(tracks, { tierOrder, pickTagOrder, retentionFileIds, excludeFileIds });
}

// ═══════════════════════════════════════════════════════════════════════════
// Group-level detection: type + group tags
// ═══════════════════════════════════════════════════════════════════════════

export function detectGroupType(tracks) {
  const fmts = [...new Set(tracks.map(t => t.format))];
  const rtypes = tracks.map(t => classifyReleaseType(t));
  const normTitles  = tracks.map(t => normalizeStr(t.title  || ''));
  const normArtists = tracks.map(t => normalizeStr(t.artist || ''));
  const sameTitle  = normTitles.every(t => t === normTitles[0]) && normTitles[0];
  const sameArtist = normArtists.every(t => t === normArtists[0]) && normArtists[0];

  if (fmts.length > 1 && sameTitle && sameArtist) return 'format_diff';
  if (rtypes.includes('single') && rtypes.includes('album')) return 'single_vs_album';
  if (sameTitle) return 'format_diff';
  return 'name_diff';
}

// ── Match-tag taxonomy ─────────────────────────────────────────────────────
// Tags are split into two categories, each with its own filter bar:
//
// MATCHING-METHOD tags (how was this group discovered?):
//   Display order: 属性 → 声纹 → 刮削. See matcher.js for global step structure.
//   meta_confirmed    – 步骤3b: title+artist+duration agreement
//   spectral_exact    – 步骤5a: spectral fingerprint byte-identical
//   same_recording    – 步骤5b+5c: spectral similarity + duration bucket
//   cp_exact          – 步骤6: Chromaprint ≥ 98%
//   cp_similar        – 步骤6: Chromaprint ≥ 90%
//   mb_confirmed      – 步骤8: same MusicBrainz recording id
//   acoustid_confirmed– 步骤8: same AcoustID recording id
//
// CHARACTERISTIC tags (intra-group patterns — relationships between files):
//   Each dimension has symmetric positive/negative tags where both poles
//   carry independent information.
//   fp_diff           – no fingerprints match.
//   format_diff/same  – different / same file formats (pick: quality_best)
//   filename_same     – identical filenames (sans extension)
//   metadata_same/diff– title+artist+album agree / disagree (normalized)
//   duration_same/diff– durations same / differ notably
//   release_year_diff – different release years (pick: release_best)
//   release_type_diff – different release types (pick: album_best)
//   meta_score_diff   – different metadata completeness (pick: meta_best)
//   retention_tie     – retention rules tied, manual choice needed
//
export function detectGroupTags(tracks, _similarity, extra = {}) {
  const tags = new Set();
  const {
    spectralConfirmed = false, metaConfirmed = false, mbConfirmed = false,
    acoustidConfirmed = false, cpConfirmed = false, maxCpSim = 0, hasCpData = false,
  } = extra;

  // Matching-method tags
  const fps = tracks.map(t => t.fingerprint).filter(Boolean);
  const spectralExact = fps.length >= 2 && fps.every(f => f === fps[0]);

  const CP_EXACT = CP_EXACT_SIM; // ≥98% 记为 cp_exact（阈值见 constants.js）
  const cpExact = hasCpData && maxCpSim >= CP_EXACT;

  if (spectralExact) tags.add('spectral_exact');
  else if (spectralConfirmed) tags.add('same_recording');
  if (cpExact) tags.add('cp_exact');
  else if (cpConfirmed) tags.add('cp_similar');

  if (metaConfirmed) tags.add('meta_confirmed');
  if (acoustidConfirmed) tags.add('acoustid_confirmed');
  if (mbConfirmed) tags.add('mb_confirmed');

  // Characteristic tags
  const fmts = new Set(tracks.map(t => (t.format||'').toUpperCase()));
  if (fmts.size > 1) tags.add('format_diff');
  else if (fmts.size === 1 && tracks.length >= 2) tags.add('format_same');

  const names = tracks.map(t => {
    const b = (t.path||'').split(/[\/]/).pop() || '';
    return b.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g,' ').trim();
  });
  if (names.length >= 2 && new Set(names).size === 1 && names[0]) tags.add('filename_same');

  const metaKeys = tracks.map(t =>
    `${normalizeStr(t.title||'')}\x00${normalizeStr(t.artist||'')}\x00${normalizeStr(t.album||'')}`);
  const allEmpty = metaKeys.every(k => k === '\x00\x00');
  if (!allEmpty && metaKeys.length >= 2 && new Set(metaKeys).size === 1) {
    tags.add('metadata_same');
  } else if (!allEmpty && metaKeys.length >= 2) {
    tags.add('metadata_diff');
  }

  const years = tracks.map(t => t.album_year || 0).filter(y => y > 0);
  if (years.length >= 2 && new Set(years).size > 1) tags.add('release_year_diff');

  const rtypes = tracks.map(t => classifyReleaseType(t));
  if (rtypes.length >= 2 && new Set(rtypes).size > 1) tags.add('release_type_diff');

  const metaScores = tracks.map(t => metaScore(t));
  if (metaScores.length >= 2 && new Set(metaScores).size > 1) tags.add('meta_score_diff');

  const durs = tracks.map(t => Math.round(t.duration || 0)).filter(d => d > 0);
  if (durs.length >= 2) {
    if (new Set(durs).size === 1) tags.add('duration_same');
    else tags.add('duration_diff');
  }

  return [...tags].join(',');
}

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic tags (not persisted — computed from other tags at read time)
// ═══════════════════════════════════════════════════════════════════════════

const FP_EVIDENCE_TAGS = new Set(['spectral_exact', 'same_recording', 'cp_exact', 'cp_similar']);

/** Inject fp_diff into a group object's group_tags if no fingerprint evidence.
 *  Mutates the group object in place. */
export function injectFpDiff(group) {
  if (!group || group.group_tags == null) return;
  const tags = group.group_tags.split(',').filter(Boolean);
  if (!tags.some(t => FP_EVIDENCE_TAGS.has(t))) {
    tags.push('fp_diff');
    group.group_tags = tags.join(',');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Client-side utilities (served as globals so app.js can use them)
// ═══════════════════════════════════════════════════════════════════════════

export function mergePickOrder(saved) {
  if (!Array.isArray(saved) || !saved.length) return [...DEFAULT_PICK_TAG_ORDER];
  return [...saved, ...DEFAULT_PICK_TAG_ORDER.filter(k => !saved.includes(k))];
}
