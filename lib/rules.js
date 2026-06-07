// lib/rules.js — Smart retention rule engine
// Decides which track to keep in a duplicate group.

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
        reason = `元数据最完整 (${best._meta}/100)`;
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

  if (fmts.length > 1 && tracks.every(t => t.title === tracks[0].title && t.artist === tracks[0].artist)) {
    return 'format_diff'; // Same song, different format
  }
  if (rtypes.includes('single') && rtypes.includes('album')) {
    return 'single_vs_album';
  }
  // Check title similarity
  const titles = tracks.map(t => (t.title || '').toLowerCase());
  const allSame = titles.every(t => t === titles[0]);
  if (allSame) return 'format_diff';
  return 'name_diff';
}

export const GROUP_TYPE_LABELS = {
  format_diff:    '格式差异',
  single_vs_album:'单曲vs专辑',
  name_diff:      '名称不同',
  name_partial:   '名称相似',
};
