// lib/rules.js — Smart retention rule engine
// Decides which track to keep in a duplicate group.

import { normalizeStr } from './fingerprint.js';

/**
 * Quality ranking for audio formats + bitrates.
 * Higher score = better quality.
 */
export function qualityScore(track) {
  const fmt = (track.format || '').toUpperCase();
  const br  = track.bitrate  || 0;
  const sr  = track.sample_rate || 44100;
  const bps = track.bits_per_sample || 16;

  // Hi-Res lossless (96kHz+, 24bit+)
  if ((fmt === 'FLAC' || fmt === 'WAV' || fmt === 'AIFF') && sr >= 88200 && bps >= 24) return 1000 + sr / 100;
  // Standard lossless
  if (fmt === 'FLAC' || fmt === 'WAV' || fmt === 'AIFF') return 900;
  // DSD / DSF
  if (fmt === 'DSF' || fmt === 'DFF') return 950;
  // AAC / M4A high bitrate
  if ((fmt === 'M4A' || fmt === 'AAC') && br >= 256) return 750 + (br / 1000);
  if ((fmt === 'M4A' || fmt === 'AAC') && br >= 128) return 680 + (br / 1000);
  // MP3
  if (fmt === 'MP3') {
    if (br >= 320) return 700 + br / 1000;
    if (br >= 256) return 640 + br / 1000;
    if (br >= 192) return 580 + br / 1000;
    if (br >= 128) return 500 + br / 1000;
    return 400 + br / 1000;
  }
  // OGG Vorbis
  if (fmt === 'OGG' || fmt === 'OGG VORBIS') return 560 + (br / 1000);
  // Opus
  if (fmt === 'OPUS') return 620 + (br / 1000);
  // Default
  return 300 + (br / 1000);
}

/**
 * Metadata completeness score [0–100].
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
  // Small trust bonus: this file's tags were independently cross-referenced
  // against MusicBrainz (via the scraping step) and matched a recording —
  // externally-verified metadata is more trustworthy than unverified tags.
  if (track.mb_recording_id) score += 10;
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
 * Determine which track should be kept in a duplicate group.
 *
 * @param {Array} tracks - array of track objects (with quality, album data, localAlbumCount)
 * @returns {Array} tracks with { keep: boolean, keepReason: string } annotated
 */
export function applyRetentionRules(tracks, getLocalAlbumCount) {
  if (tracks.length === 0) return tracks;
  if (tracks.length === 1) return [{ ...tracks[0], keep: true, keepReason: '唯一版本' }];

  // Annotate each track with derived fields
  const annotated = tracks.map(t => ({
    ...t,
    _quality:    qualityScore(t),
    _meta:       metaScore(t),
    _rtype:      classifyReleaseType(t),
    _albumCount: typeof getLocalAlbumCount === 'function' ? getLocalAlbumCount(t.album) : (t.localAlbumCount || 0),
  }));

  // ── Rule 1: Best quality wins ──────────────────────────────────────────
  const maxQ = Math.max(...annotated.map(t => t._quality));
  let candidates = annotated.filter(t => t._quality === maxQ);

  let winner = null;
  let reason = '';

  if (candidates.length === 1) {
    winner = candidates[0];
    reason = `最高音质 (${fmtQuality(winner)})`;
  } else {
    // ── Rule 2: Earliest official album ────────────────────────────────
    // Filter out compilations / singles
    const officialAlbum = candidates.filter(t => t._rtype === 'album' || t._rtype === 'soundtrack');
    const pool = officialAlbum.length > 0 ? officialAlbum : candidates;

    const minYear = Math.min(...pool.map(t => t.album_year || 9999));
    const earliest = pool.filter(t => (t.album_year || 9999) === minYear);

    if (earliest.length === 1) {
      winner = earliest[0];
      reason = `最高音质 · 首发专辑 (${minYear > 0 ? minYear : '年份未知'})`;
    } else {
      candidates = earliest;

      // ── Rule 3: Album vs Single ──────────────────────────────────────
      const albumVersions  = candidates.filter(t => t._rtype === 'album');
      const singleVersions = candidates.filter(t => t._rtype === 'single');

      if (albumVersions.length > 0 && singleVersions.length > 0) {
        // Check if local library has ≥2 tracks from the album
        const albumWithLib = albumVersions.filter(t => t._albumCount >= 2);
        if (albumWithLib.length > 0) {
          winner = albumWithLib.sort((a, b) => b._albumCount - a._albumCount)[0];
          reason = `专辑版 · 本地专辑有 ${winner._albumCount} 首`;
        } else {
          winner = singleVersions[0];
          reason = `单曲版 · 本地专辑仅 ${albumVersions[0]?._albumCount || 1} 首`;
        }
      }

      if (!winner) {
        // ── Rule 4: Metadata completeness ────────────────────────────
        const best = candidates.sort((a, b) => b._meta - a._meta)[0];
        winner = best;
        reason = `元数据最完整 (${best._meta}/110)`;
      }
    }
  }

  // Annotate all tracks with keep flag
  return annotated.map(t => {
    const keep = t.id === winner.id || t.path === winner.path;
    return {
      ...t,
      keep,
      keep_reason: keep ? reason : null,
    };
  });
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
 * @param {Object} extra - { spectralConfirmed, metaConfirmed, mbConfirmed } — *why* the
 *   matcher unioned this cluster, so the tags reflect the real basis for the match rather
 *   than implying a spectral confirmation that may not have happened.
 */
export function detectMatchTags(tracks, similarity, extra = {}) {
  const tags = new Set();
  const { spectralConfirmed = false, metaConfirmed = false, mbConfirmed = false } = extra;

  // Spectral fingerprint string is byte-identical. This is about the extracted
  // AUDIO fingerprint, not the files themselves — two different files (different
  // names, tags, sizes) can easily share this if they're lossless re-encodes of
  // the same PCM, so the label is deliberately scoped to "fingerprint", not "file".
  const fps = tracks.map(t => t.fingerprint).filter(Boolean);
  if (fps.length >= 2 && fps.every(f => f === fps[0])) tags.add('exact_copy');

  // Format difference (same recording, different container/codec)
  const fmts = new Set(tracks.map(t => (t.format||'').toUpperCase()));
  if (fmts.size > 1) tags.add('format_diff');

  // Quality difference (same format, different bitrate)
  if (fmts.size === 1) {
    const bitrates = new Set(tracks.map(t => t.bitrate||0));
    if (bitrates.size > 1) tags.add('quality_diff');
  }

  // Same filename (without extension)
  const names = tracks.map(t => {
    const b = (t.path||'').split(/[\/]/).pop() || '';
    return b.replace(/\.[^.]+$/, '').toLowerCase().replace(/\s+/g,' ').trim();
  });
  if (names.length >= 2 && new Set(names).size === 1 && names[0]) tags.add('filename_same');

  // Same metadata (title + artist), compared after normalization so accents/
  // case/punctuation differences don't hide a real metadata match
  const metaKeys = tracks.map(t =>
    `${normalizeStr(t.title||'')}__${normalizeStr(t.artist||'')}`);
  if (metaKeys.length >= 2 && new Set(metaKeys).size === 1 && !metaKeys[0].startsWith('__'))
    tags.add('metadata_same');

  // Single vs album
  const rtypes = tracks.map(t => t.release_type || t._rtype || 'unknown');
  if (rtypes.includes('single') && (rtypes.includes('album') || rtypes.includes('unknown')))
    tags.add('single_vs_album');

  // Duration essentially identical. Tightened to ≤1.5s on purpose: with the old
  // ≤5s window this fired on almost every group regardless of how the match was
  // found (most matching strategies already imply similar duration), so it had
  // no value as a filter. At ≤1.5s it actually distinguishes "same recording,
  // different encode" (near-zero drift) from "different cut of the same song"
  // (radio edit / extended mix / live, which differ by many seconds).
  const durs = tracks.map(t => Math.round((t.duration || 0) * 10) / 10).filter(d => d > 0);
  if (durs.length >= 2 && Math.max(...durs) - Math.min(...durs) <= 1.5)
    tags.add('duration_near');

  // High spectral similarity but not byte-identical (same recording, different encode)
  if (similarity >= 0.85 && !tags.has('exact_copy'))
    tags.add('same_recording');

  // The audio fingerprint comparison itself did not reach the matching threshold
  // (or there was nothing to compare) — this cluster was confirmed some other way.
  // Surfacing this avoids a confusing "matched as duplicate, but similarity 48%"
  // with no explanation.
  if (metaConfirmed && !spectralConfirmed) tags.add('meta_confirmed');

  // Two files independently scraped to the SAME MusicBrainz recording id —
  // third-party confirmation, independent of local tags/fingerprint quality.
  if (mbConfirmed) tags.add('mb_confirmed');

  return [...tags].join(',');
}

export const MATCH_TAG_LABELS = {
  exact_copy:      '声纹完全一致',
  same_recording:  '声纹高度相似',
  format_diff:     '格式差异',
  quality_diff:    '音质差异',
  filename_same:   '文件名相同',
  metadata_same:   '标题/艺术家一致',
  single_vs_album: '单曲vs专辑',
  duration_near:   '时长基本一致',
  meta_confirmed:  '元数据判定（声纹不足）',
  mb_confirmed:    'MusicBrainz确认',
};
