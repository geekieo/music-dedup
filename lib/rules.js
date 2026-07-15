// lib/rules.js — Smart retention rule engine
// Decides which track to keep in a duplicate group.

import { normalizeStr } from './fingerprint.js';

// Matching-method tag keys — answer "HOW was this group discovered".
// These are the tags that depend on specific matcher phases (fingerprint,
// chromaprint, scrape) and must be preserved across partial rematches.
export const MATCHING_METHOD_KEYS = new Set([
  'meta_confirmed', 'spectral_exact', 'same_recording',
  'cp_exact', 'cp_similar', 'mb_confirmed', 'acoustid_confirmed',
]);

export const DEFAULT_TIER_ORDER = [
  'Hi-Res FLAC / WAV (96kHz+)', 'FLAC / WAV (44.1kHz)', 'AIFF',
  'M4A / AAC ≥ 256k', 'MP3 320k', 'MP3 256k', 'MP3 192k',
  'OGG / Opus', 'MP3 128k 及以下',
];

/**
 * Classify a track into one of the fixed quality-tier buckets shown in
 * Settings → 音质优先级. The bucket boundaries are fixed; only their
 * *order* (and therefore which one wins) is user-configurable.
 */
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

/**
 * Quality ranking for audio formats + bitrates.
 * Higher score = better quality. Driven by the user-orderable tier list in
 * Settings (`tierOrder`) — reordering it there changes which file wins ties,
 * not just the displayed order.
 */
export function qualityScore(track, tierOrder) {
  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;
  const tier  = classifyQualityTier(track);
  let idx = order.indexOf(tier);
  if (idx === -1) idx = order.length; // unrecognized tier label → lowest priority
  const tierScore = (order.length - idx) * 100000;
  // Fine-grained tiebreak *within* a tier (e.g. MP3 320k vs MP3 320k with a
  // higher sample rate) so ties don't fall through to less relevant rules.
  const br = track.bitrate || 0, sr = track.sample_rate || 44100, bps = track.bits_per_sample || 16;
  return tierScore + br + sr / 1000 + bps;
}

/**
 * Metadata completeness score [0–120].
 * More complete metadata = more trustworthy file.
 */
export function metaScore(track) {
  let score = 0;
  if (track.title   && track.title.length > 0)   score += 20;
  if (track.artist  && track.artist.length > 0)  score += 20;
  if (track.album   && track.album.length > 0)   score += 20;
  if (track.album_year > 0)                       score += 15;
  if (track.track_number > 0)                     score += 15;
  if (track.release_type && track.release_type !== 'unknown') score += 10;
  // Embedded lyrics are a real, user-facing completeness signal (and easy to
  // miss just eyeballing tags/file size), so they count toward the score.
  if (track.has_lyrics) score += 10;
  // Small trust bonus: this file's tags were independently cross-referenced
  // against MusicBrainz and matched via a *precise* basis (title+artist+album/
  // duration/track all corroborating, not just a loose title-only guess) —
  // only that kind of verification is trustworthy enough to count here.
  // scrape_match_basis comes from getAllFilesForMatching's join; fall back to
  // treating a bare mb_recording_id as trustworthy only when no basis info is
  // present at all (keeps this safe for callers that don't pass it).
  if (track.mb_recording_id && (track.scrape_match_basis === 'exact' || track.scrape_match_basis === undefined)) score += 10;
  return score;
}

/**
 * Classify the release type of a track by its album name.
 * Returns: 'album' | 'single' | 'compilation' | 'unknown'
 */
export function classifyReleaseType(track) {
  if (track.release_type && track.release_type !== 'unknown') return track.release_type;
  const album = (track.album || '').toLowerCase();
  if (!album) return 'unknown';
  // Compilation signals
  if (/greatest hits|best of|collection|compilation|anthology|playlist|top \d+|essential|complete|the very best/i.test(album)) return 'compilation';
  // Single signals
  if (/\b(single|ep)\b/i.test(album)) return 'single';
  // Soundtrack / score
  if (/soundtrack|ost|score|motion picture/i.test(album)) return 'soundtrack';
  return 'album';
}

/**
 * Priority-cascade retention.
 *
 *   Rule 1 — 刮削准确性：精确刮削且字段匹配官方数据时，只在验证过的文件里选
 *   Rule 2 — 音质优先：按用户音质优先级 + 同档内码率/采样率精细比对
 *   Rule 3 — 发售更早：年份越早越好
 *   Rule 4 — 专辑版优先：本地同专辑 ≥2 首 → 偏向专辑版
 *   Rule 5 — 属性完整：标签越完整越好
 *   平局   — 条件相同，建议手动选择
 *
 * 每关严格筛选，唯一胜出即返回。
 * _tags 标注每条曲目的维度优势，供 UI 展示。
 */

// ── Helpers ────────────────────────────────────────────────────────────────

function albumLocalCount(t, fn) {
  return typeof fn === 'function' ? fn(t.album) : (t.localAlbumCount || 0);
}

function countScrapeMatches(t) {
  if (t.scrape_match_basis !== 'exact') return 0;
  let n = 0;
  if (t.scrape_album_year && t.album_year && t.album_year === t.scrape_album_year) n++;
  if (t.scrape_track_number && t.track_number && t.track_number === t.scrape_track_number) n++;
  if (t.scrape_genre && t.genre && normalizeStr(t.genre) === normalizeStr(t.scrape_genre)) n++;
  if (t.scrape_duration && t.duration) {
    const diff = Math.abs(t.duration - t.scrape_duration);
    if (diff <= 3) n += 2;
    else if (diff <= 8) n += 1;
  }
  return n;
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

// ── API helper: tag tracks from raw data (no scrape data available) ──────

export function tagTracks(tracks, tierOrder) {
  if (!tracks || tracks.length <= 1) {
    if (tracks) for (const t of tracks) t._tags = [];
    return tracks || [];
  }
  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;
  const annotated = tracks.map(t => ({
    ...t,
    _quality: qualityScore(t, order),
    _meta:    metaScore(t),
  }));
  const bestQuality = Math.max(...annotated.map(t => t._quality));
  const bestMeta    = Math.max(...annotated.map(t => t._meta));
  const allHaveYear = annotated.every(t => t.album_year > 0);
  const earliestYr  = allHaveYear ? Math.min(...annotated.map(t => t.album_year)) : 0;

  for (const t of annotated) {
    const tags = [];
    if (t._quality === bestQuality) tags.push('quality_best');
    if (t._meta === bestMeta && bestMeta > 0) tags.push('meta_best');
    if (t.album_year && earliestYr > 0 && t.album_year === earliestYr) tags.push('release_best');
    t._tags = tags;
  }
  return annotated;
}

// ── Main ────────────────────────────────────────────────────────────────────

export function applyRetentionRules(tracks, getLocalAlbumCount, tierOrder) {
  if (tracks.length === 0) return tracks;
  if (tracks.length === 1) return [{ ...tracks[0], keep: true, keep_reason: '唯一版本', _tags: [] }];

  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;

  const annotated = tracks.map(t => {
    const verified = t.scrape_match_basis === 'exact';
    return {
      ...t,
      _quality:        qualityScore(t, order),
      _meta:           metaScore(t),
      _scrapeVerified:  verified,
      _scrapeMatches:   verified ? countScrapeMatches(t) : 0,
      _localAlbumCount: albumLocalCount(t, getLocalAlbumCount),
      _rtype:           classifyReleaseType(t),
    };
  });

  // ── Tags: 各维度胜负（所有曲目参与，与后续规则使用同一份评分） ────
  const bestQuality = Math.max(...annotated.map(t => t._quality));
  const bestMeta    = Math.max(...annotated.map(t => t._meta));
  const bestScrape  = Math.max(...annotated.map(t => t._scrapeMatches));
  const allHaveYear = annotated.every(t => t.album_year > 0);
  const earliestYr  = allHaveYear ? Math.min(...annotated.map(t => t.album_year)) : null;

  for (const t of annotated) {
    const tags = [];
    if (t._quality === bestQuality) tags.push('quality_best');
    if (t._scrapeVerified && t._scrapeMatches === bestScrape && bestScrape > 0) tags.push('scrape_best');
    if (t._meta === bestMeta && bestMeta > 0) tags.push('meta_best');
    if (t.album_year && earliestYr !== null && t.album_year === earliestYr) tags.push('release_best');
    t._tags = tags;
  }

  let candidates = annotated;

  // ── Rule 1: 刮削准确性 ───────────────────────────────────────────────
  const verified = candidates.filter(t => t._scrapeVerified);
  if (verified.length > 0) {
    const recIds = new Set(verified.map(t => t.mb_recording_id).filter(Boolean));
    if (recIds.size === 1) {
      candidates = verified.filter(t => t._scrapeMatches === bestScrape);
      if (candidates.length === 1) {
        return markResult(annotated, candidates[0], `刮削一致 · ${fmtQuality(candidates[0])}`);
      }
    }
  }

  // ── Rules 2/3/5: 按优先级采纳维度赢家 ──────────────────────────────────
  const tiers = [
    { tag: 'quality_best', reason: t => `优先音质 (${fmtQuality(t)})` },
    { tag: 'release_best', reason: t => `优先音质 · 发售更早 ${t.album_year}`,
      prefilter: cs => { const o = cs.filter(t => t._rtype === 'album' || t._rtype === 'soundtrack'); return o.length > 0 ? o : cs; } },
    { tag: 'meta_best',    reason: () => '属性最完整' },
  ];

  for (const { tag, reason, prefilter } of tiers) {
    if (candidates.length <= 1) break;
    const pool = prefilter ? prefilter(candidates) : candidates;
    const winners = pool.filter(t => t._tags.includes(tag));
    if (winners.length === 1) {
      return markResult(annotated, winners[0], reason(winners[0]));
    }
    if (winners.length > 1) {
      candidates = winners;
    }
  }

  // ── Rule 4: 专辑版优先 ───────────────────────────────────────────────
  if (candidates.length > 1) {
    const albums = candidates.filter(t => t._rtype === 'album');
    const singles = candidates.filter(t => t._rtype === 'single');
    if (albums.length > 0 && singles.length > 0) {
      const albumWithLib = albums.filter(t => t._localAlbumCount >= 2);
      if (albumWithLib.length > 0) {
        candidates = albumWithLib.sort((a, b) => b._localAlbumCount - a._localAlbumCount);
        return markResult(annotated, candidates[0], `专辑版 · 本地专辑有 ${candidates[0]._localAlbumCount} 首`);
      }
      return markResult(annotated, singles[0], `单曲版 · 本地专辑仅 ${albums[0]?._localAlbumCount || 1} 首`);
    }
  }

  // ── 平局 ─────────────────────────────────────────────────────────────
  const tiedIds = new Set(candidates.map(t => t.id || t.path));
  return annotated.map(t => ({
    ...t,
    keep: tiedIds.has(t.id || t.path),
    keep_reason: tiedIds.has(t.id || t.path) ? '条件相同，建议手动选择' : null,
  }));
}

function markResult(all, winner, reason) {
  return all.map(t => ({
    ...t,
    keep: t.id === winner.id || t.path === winner.path,
    keep_reason: t.id === winner.id || t.path === winner.path ? reason : null,
  }));
}

/**
 * Detect duplicate group type for labelling.
 */
export function detectGroupType(tracks) {
  const fmts = [...new Set(tracks.map(t => t.format))];
  const rtypes = tracks.map(t => classifyReleaseType(t));
  const normTitles  = tracks.map(t => normalizeStr(t.title  || ''));
  const normArtists = tracks.map(t => normalizeStr(t.artist || ''));
  const sameTitle  = normTitles.every(t  => t  === normTitles[0])  && normTitles[0];
  const sameArtist = normArtists.every(t => t  === normArtists[0]) && normArtists[0];

  if (fmts.length > 1 && sameTitle && sameArtist) {
    return 'format_diff'; // Same song, different format
  }
  if (rtypes.includes('single') && rtypes.includes('album')) {
    return 'single_vs_album';
  }
  // Check title similarity (normalized, so accents/case don't cause false negatives)
  if (sameTitle) return 'format_diff';
  return 'name_diff';
}

export const GROUP_TYPE_LABELS = {
  format_diff:    '格式差异',
  single_vs_album:'单曲vs专辑',
  name_diff:      '名称不同',
  name_partial:   '名称相似',
};

/**
 * Detect all applicable match tag types for a group of tracks.
 * Returns comma-separated tag string for DB storage.
 *
 * @param {Array} tracks - the group's file records
 * @param {number} similarity - max spectral fingerprint similarity found in the cluster (0-1)
 * @param {Object} extra - { spectralConfirmed, mbConfirmed } — *why* the matcher
 *   unioned this cluster, so the tag reflects the real basis for the match.
 */
export function detectMatchTags(tracks, similarity, extra = {}) {
  const tags = new Set();
  const {
    spectralConfirmed = false, metaConfirmed = false, mbConfirmed = false,
    acoustidConfirmed = false, cpConfirmed = false, maxCpSim = 0, hasCpData = false,
  } = extra;

  // ── Matching-method tags ──────────────────────────────────────────────
  // These answer "HOW was this duplicate group discovered?" — each tag maps
  // to a specific phase that actively unions pairs. They appear in the
  // duplicate-list filter bar so users can narrow groups by discovery method.

  // Spectral fingerprint string is byte-identical (步骤5a).
  const fps = tracks.map(t => t.fingerprint).filter(Boolean);
  const spectralExact = fps.length >= 2 && fps.every(f => f === fps[0]);

  // Chromaprint "exact" — ≥98% (步骤6). fpcalc output can vary by a few
  // bits even for identical audio, so byte equality is too strict.
  const CP_EXACT = 0.98;
  const cpExact = hasCpData && maxCpSim >= CP_EXACT;

  if (spectralExact) tags.add('spectral_exact');
  else if (spectralConfirmed) tags.add('same_recording');
  if (cpExact) tags.add('cp_exact');
  else if (cpConfirmed) tags.add('cp_similar');

  // Metadata-confirmed: title+artist+duration agreement (步骤3a/3b).
  if (metaConfirmed) tags.add('meta_confirmed');

  // Scrape-confirmed: two files independently matched to the same external
  // recording id (步骤8). AcoustID is audio-fingerprint-verified (higher
  // confidence); MusicBrainz text search is weaker corroboration.
  if (acoustidConfirmed) tags.add('acoustid_confirmed');
  if (mbConfirmed) tags.add('mb_confirmed');

  // ── Characteristic tags ───────────────────────────────────────────────
  // These describe intra-group relationships — patterns between files within
  // the cluster. They appear in the "其他组内特征" filter bar and inform
  // retention decisions. Each dimension has symmetric positive/negative tags
  // where both poles carry independent information.

  // "声纹不同": neither spectral nor Chromaprint found evidence — this group
  // was formed entirely by metadata or scrape methods.
  const spectralFoundNothing = !spectralConfirmed;
  const cpFoundNothing = !hasCpData || !cpConfirmed;
  if (spectralFoundNothing && cpFoundNothing) tags.add('fp_diff');

  // Format
  const fmts = new Set(tracks.map(t => (t.format||'').toUpperCase()));
  if (fmts.size > 1) tags.add('format_diff');
  else if (fmts.size === 1 && tracks.length >= 2) tags.add('format_same');

  // Filename (no symmetric tag — different filenames are the default)
  const names = tracks.map(t => {
    const b = (t.path||'').split(/[\/]/).pop() || '';
    return b.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g,' ').trim();
  });
  if (names.length >= 2 && new Set(names).size === 1 && names[0]) tags.add('filename_same');

  // Metadata: title + artist + album, normalized. Aligned with scraper's
  // definition of "exact match" (all three must agree).
  const metaKeys = tracks.map(t =>
    `${normalizeStr(t.title||'')}\x00${normalizeStr(t.artist||'')}\x00${normalizeStr(t.album||'')}`);
  const allEmpty = metaKeys.every(k => k === '\x00\x00');
  if (!allEmpty && metaKeys.length >= 2 && new Set(metaKeys).size === 1) {
    tags.add('metadata_same');
  } else if (!allEmpty && metaKeys.length >= 2) {
    tags.add('metadata_diff');
  }

  // Album year
  const years = tracks.map(t => t.album_year || 0).filter(y => y > 0);
  if (years.length >= 2 && new Set(years).size > 1) tags.add('album_year_diff');

  // Metadata completeness score
  const metaScores = tracks.map(t => metaScore(t));
  if (metaScores.length >= 2 && new Set(metaScores).size > 1) tags.add('meta_score_diff');

  // Duration
  const durs = tracks.map(t => Math.round((t.duration || 0) * 10) / 10).filter(d => d > 0);
  if (durs.length >= 2) {
    if (Math.max(...durs) - Math.min(...durs) <= 1.5) tags.add('duration_near');
    else tags.add('duration_diff');
  }

  return [...tags].join(',');
}

export const MATCH_TAG_LABELS = {
  // Matching-method tags (shown in filter bar)
  spectral_exact:  '频谱声纹一致',
  same_recording:  '频谱声纹相似',
  cp_exact:        'CP声纹一致',
  cp_similar:      'CP声纹相似',
  meta_confirmed:  '属性匹配',
  mb_confirmed:    'MusicBrainz刮削一致',
  acoustid_confirmed: 'AcoustID刮削一致',
  // Characteristic tags (group detail + 其他组内特征 filter)
  fp_diff:         '声纹不同',
  format_diff:     '格式不同',
  format_same:     '格式相同',
  filename_same:   '文件名相同',
  metadata_same:   '属性一致',
  metadata_diff:   '属性不同',
  duration_near:   '时长接近',
  duration_diff:   '时长不同',
  album_year_diff: '年份不同',
  meta_score_diff: '属性完整度不同',
  retention_tie:   '保留平局',
};

// Short, literal descriptions — every tag that can appear gets exactly one
// of these, shown on hover. No restating of "why the threshold wasn't met"
// boilerplate; the tag name already says that.
export const MATCH_TAG_DESCRIPTIONS = {
  // Matching-method tags
  spectral_exact:  '频谱声纹完全一致。和文件字节是否相同无关——文件名、标签、体积都可以不一样。',
  same_recording:  '频谱声纹相似度达到设定阈值，但不完全一致，通常是同一录音的不同编码或母带。',
  cp_exact:        'Chromaprint 声纹高度一致（≥98%）。与频谱声纹相互独立，可能会分别找到对方漏掉的重复。',
  cp_similar:      'Chromaprint 声纹相似度达到阈值（≥90%），但未达到完全一致（98%）。',
  meta_confirmed:  '标题、艺术家、时长一致——属性匹配判定为重复，不需要声纹参与。',
  mb_confirmed:    '两个文件被 MusicBrainz 文本搜索匹配到同一条录音，第三方数据库交叉确认。',
  acoustid_confirmed: '两个文件被 AcoustID 声纹识别到同一条录音——由声纹验证，比纯文本搜索的确认更可信。',
  // Characteristic tags
  fp_diff:         '频谱声纹和 Chromaprint 声纹都没有比对上，凭标题、艺术家、时长等信息判定为重复。',
  format_diff:     '组内存在不同的文件格式（如 FLAC + MP3），保留规则会优先保留高质量格式。',
  format_same:     '组内所有文件格式相同，保留决策取决于码率、采样率等其他因素。',
  filename_same:   '文件名（不含扩展名）完全相同。',
  metadata_same:   '组内所有文件的标题、艺术家、专辑完全一致（归一化后）。',
  metadata_diff:   '组内文件的标题、艺术家或专辑不一致，标签可能存在错误或写法差异。',
  duration_near:   '组内文件时长几乎完全一致（≤1.5 秒），很可能是同一录音的不同版本。',
  duration_diff:   '组内文件时长差异较大（>1.5 秒），可能是不同剪辑版本（radio edit / album / extended）。',
  album_year_diff: '组内文件的发行年份不同，保留规则可能优先选择首发专辑。',
  meta_score_diff: '组内文件的属性完整度不同，保留规则会优先保留标签更完整的文件。',
  retention_tie:   '智能保留规则无法自动决定——多个候选文件的属性相同，需要手动选择。',
};
