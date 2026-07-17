// lib/rules.js — Group-level rule engine
// Rules only judge tag results; per-track dimension evaluation and winner
// selection lives in tags.js.

import { normalizeStr } from './fingerprint.js';
import {
  classifyQualityTier, qualityScore, metaScore, classifyReleaseType,
  releaseTypeScore, DEFAULT_TIER_ORDER, PICK_TAG_LABEL, evaluateGroup,
} from './tags.js';

// Re-export helpers for external callers
export {
  classifyQualityTier, qualityScore, metaScore, classifyReleaseType,
  releaseTypeScore, DEFAULT_TIER_ORDER, PICK_TAG_LABEL,
};

// Matching-method tag keys — answer "HOW was this group discovered".
export const MATCHING_METHOD_KEYS = new Set([
  'meta_confirmed', 'spectral_exact', 'same_recording',
  'cp_exact', 'cp_similar', 'mb_confirmed', 'acoustid_confirmed',
]);

// ── Per-track tagging (thin wrapper) ─────────────────────────────────────────

/**
 * Assign dimension tags to tracks. Used by the group-detail API for UI display.
 */
export function tagTracks(tracks, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds) {
  return evaluateGroup(tracks, { tierOrder, pickTagOrder, retentionFileIds, excludeFileIds });
}

// ── Retention rules (thin wrapper) ────────────────────────────────────────────

/**
 * Apply retention rules to pick which track to keep.
 * Delegates dimension evaluation + winner selection to evaluateGroup(),
 * then maps the result to the keep/keep_reason format expected by matcher.
 */
export function applyRetentionRules(tracks, getLocalAlbumCount, tierOrder, pickTagOrder, retentionFileIds, excludeFileIds) {
  const annotated = evaluateGroup(tracks, { tierOrder, pickTagOrder, getLocalAlbumCount, retentionFileIds, excludeFileIds });
  for (const t of annotated) {
    t.keep = t._keepWinner;
    t.keep_reason = t._winReason || null;
    delete t._keepWinner;
    delete t._winReason;
  }
  return annotated;
}

// ── Group-level detection ────────────────────────────────────────────────────

export function detectGroupType(tracks) {
  const fmts = [...new Set(tracks.map(t => t.format))];
  const rtypes = tracks.map(t => classifyReleaseType(t));
  const normTitles  = tracks.map(t => normalizeStr(t.title  || ''));
  const normArtists = tracks.map(t => normalizeStr(t.artist || ''));
  const sameTitle  = normTitles.every(t  => t  === normTitles[0])  && normTitles[0];
  const sameArtist = normArtists.every(t => t  === normArtists[0]) && normArtists[0];

  if (fmts.length > 1 && sameTitle && sameArtist) {
    return 'format_diff';
  }
  if (rtypes.includes('single') && rtypes.includes('album')) {
    return 'single_vs_album';
  }
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
 */
export function detectMatchTags(tracks, similarity, extra = {}) {
  const tags = new Set();
  const {
    spectralConfirmed = false, metaConfirmed = false, mbConfirmed = false,
    acoustidConfirmed = false, cpConfirmed = false, maxCpSim = 0, hasCpData = false,
  } = extra;

  // ── Matching-method tags ──────────────────────────────────────────────
  const fps = tracks.map(t => t.fingerprint).filter(Boolean);
  const spectralExact = fps.length >= 2 && fps.every(f => f === fps[0]);

  const CP_EXACT = 0.98;
  const cpExact = hasCpData && maxCpSim >= CP_EXACT;

  if (spectralExact) tags.add('spectral_exact');
  else if (spectralConfirmed) tags.add('same_recording');
  if (cpExact) tags.add('cp_exact');
  else if (cpConfirmed) tags.add('cp_similar');

  if (metaConfirmed) tags.add('meta_confirmed');

  if (acoustidConfirmed) tags.add('acoustid_confirmed');
  if (mbConfirmed) tags.add('mb_confirmed');

  // ── Characteristic tags ───────────────────────────────────────────────
  const spectralFoundNothing = !spectralConfirmed;
  const cpFoundNothing = !hasCpData || !cpConfirmed;
  if (spectralFoundNothing && cpFoundNothing) tags.add('fp_diff');

  // Format
  const fmts = new Set(tracks.map(t => (t.format||'').toUpperCase()));
  if (fmts.size > 1) tags.add('format_diff');
  else if (fmts.size === 1 && tracks.length >= 2) tags.add('format_same');

  // Filename
  const names = tracks.map(t => {
    const b = (t.path||'').split(/[\/]/).pop() || '';
    return b.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g,' ').trim();
  });
  if (names.length >= 2 && new Set(names).size === 1 && names[0]) tags.add('filename_same');

  // Metadata: title + artist + album
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
  if (years.length >= 2 && new Set(years).size > 1) tags.add('release_year_diff');

  // Release type (album/single/compilation/soundtrack)
  const rtypes = tracks.map(t => classifyReleaseType(t));
  if (rtypes.length >= 2 && new Set(rtypes).size > 1) tags.add('release_type_diff');

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
  spectral_exact:  '频谱声纹一致',
  same_recording:  '频谱声纹相似',
  cp_exact:        'CP声纹一致',
  cp_similar:      'CP声纹相似',
  meta_confirmed:  '属性匹配',
  mb_confirmed:    'MusicBrainz刮削一致',
  acoustid_confirmed: 'AcoustID刮削一致',
  fp_diff:         '无声纹佐证',
  format_diff:     '格式不同',
  format_same:     '格式相同',
  filename_same:   '文件名相同',
  metadata_same:   '属性一致',
  metadata_diff:   '属性不同',
  duration_near:   '时长接近',
  duration_diff:   '时长不同',
  release_year_diff: '年份不同',
  release_type_diff: '发行类型不同',
  meta_score_diff: '属性完整度不同',
  retention_tie:   '保留平局',
};

export const MATCH_TAG_DESCRIPTIONS = {
  spectral_exact:  '频谱声纹完全一致。和文件字节是否相同无关——文件名、标签、体积都可以不一样。',
  same_recording:  '频谱声纹相似度达到设定阈值，但不完全一致，通常是同一录音的不同编码或母带。',
  cp_exact:        'Chromaprint 声纹高度一致（≥98%）。与频谱声纹相互独立，可能会分别找到对方漏掉的重复。',
  cp_similar:      'Chromaprint 声纹相似度达到阈值（≥90%），但未达到完全一致（98%）。',
  meta_confirmed:  '标题、艺术家、时长一致——属性匹配判定为重复，不需要声纹参与。',
  mb_confirmed:    '两个文件被 MusicBrainz 文本搜索匹配到同一条录音，第三方数据库交叉确认。',
  acoustid_confirmed: '两个文件被 AcoustID 声纹识别到同一条录音——由声纹验证，比纯文本搜索的确认更可信。',
  fp_diff:         '频谱声纹和 Chromaprint 声纹都没有可比对的结果（可能是声纹未提取，也可能比对未达阈值），凭标题、艺术家、时长等信息判定。',
  format_diff:     '组内存在不同的文件格式（如 FLAC + MP3），保留规则会优先保留高质量格式。',
  format_same:     '组内所有文件格式相同，保留决策取决于码率、采样率等其他因素。',
  filename_same:   '文件名（不含扩展名）完全相同。',
  metadata_same:   '组内所有文件的标题、艺术家、专辑完全一致（归一化后）。',
  metadata_diff:   '组内文件的标题、艺术家或专辑不一致，标签可能存在错误或写法差异。',
  duration_near:   '组内文件时长几乎完全一致（≤1.5 秒），很可能是同一录音的不同版本。',
  duration_diff:   '组内文件时长差异较大（>1.5 秒），可能是不同剪辑版本（radio edit / album / extended）。',
  release_year_diff: '组内文件的发行年份不同，保留规则可能优先选择首发专辑。',
  release_type_diff: '组内存在不同的发行类型（专辑/单曲/原声/合辑），保留规则优先选择专辑版。',
  meta_score_diff: '组内文件的属性完整度不同，保留规则会优先保留标签更完整的文件。',
  retention_tie:   '智能保留规则无法自动决定——多个候选文件的属性相同，需要手动选择。',
};
