// lib/tags.js — Unified per-track dimension evaluation & winner selection
// Evaluates every track in a duplicate group, assigns dimension tags, and
// picks the winner via a priority cascade. Rules (rules.js) then only judge
// the tag results to produce keep/keep_reason.

import { normalizeStr } from './fingerprint.js';

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
  'duration_accurate', 'quality_best', 'album_best', 'release_best', 'scrape_best', 'meta_best',
];

export const PICK_TAG_LABEL = {
  scrape_best: '刮削更准', quality_best: '音质最优', release_best: '发售更早',
  album_best: '专辑优先', meta_best: '属性最全', duration_accurate: '时长准确',
  manual_keep: '手动保留',
};

// ── Pure helpers ─────────────────────────────────────────────────────────────

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
  let score = 0;
  if (track.title   && track.title.length > 0)   score += 20;
  if (track.artist  && track.artist.length > 0)  score += 20;
  if (track.album   && track.album.length > 0)   score += 20;
  if (track.album_year > 0)                       score += 15;
  if (track.track_number > 0)                     score += 15;
  if (track.release_type && track.release_type !== 'unknown') score += 10;
  if (track.has_lyrics) score += 10;
  if (track.mb_recording_id && (track.scrape_match_basis === 'exact' || track.scrape_match_basis === undefined)) score += 10;
  return score;
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

// ── Internal helpers ─────────────────────────────────────────────────────────

function albumLocalCount(t, fn) {
  return typeof fn === 'function' ? fn(t.album) : (t.localAlbumCount || 0);
}

// scrape_best only measures how well the file's *tags* line up with the
// official MusicBrainz record (year / track number / genre). It is
// deliberately NOT a proxy for audio correctness/quality: two files can
// both be the correct recording and legitimately differ here (a reissue
// has a different official year than the original pressing, a track's
// number changes when it's part of a compilation vs. the album, genre
// tagging is subjective). Duration used to be folded into this same sum,
// but duration is the one signal here that actually reflects the audio
// itself — mixing it with three soft/subjective tag-agreement points let
// a file with the wrong duration outscore (and thus win over) a file with
// the exactly correct duration, as long as it happened to match more tag
// fields. Duration is now handled on its own via the duration_accurate
// dimension, which isn't diluted this way; see groupDurationReference() below.
function countScrapeMatches(t) {
  if (t.scrape_match_basis !== 'exact') return 0;
  let n = 0;
  if (t.scrape_album_year && t.album_year && t.album_year === t.scrape_album_year) n++;
  if (t.scrape_track_number && t.track_number && t.track_number === t.scrape_track_number) n++;
  if (t.scrape_genre && t.genre && normalizeStr(t.genre) === normalizeStr(t.scrape_genre)) n++;
  return n;
}

// Reference duration for the "时长准确" dimension: only 精确刮削
// (match_basis === 'exact') counts as a trustworthy source. MB and
// AcoustID are matched independently per file, so a single track can
// carry an exact result from both; when both are present, MB is the
// default tie-breaker regardless of whether the two actually disagree —
// if they agree the choice is moot, and if they conflict this is exactly
// the rule that should win.
//
// This is computed ONCE PER GROUP, not per track. All tracks in a
// duplicate group are (by definition of being grouped) the same
// recording, so any single track's exact-scrape duration is valid ground
// truth for every other track in the group — including a track that was
// never scraped itself. Scoping this per-track instead would mean a
// pristine, untouched original that simply hasn't been scraped can never
// be confirmed "accurate", even when its actual duration is correct and
// another group member's scrape data proves it — silently defeating the
// "don't penalize a file just for lacking scraped info" goal.
const DURATION_ACCURATE_TOLERANCE = 3; // seconds

function groupDurationReference(tracks) {
  const mbVals  = tracks.filter(t => t.scrape_match_basis === 'exact' && t.scrape_duration > 0).map(t => t.scrape_duration);
  const aidVals = tracks.filter(t => t.aid_match_basis === 'exact' && t.aid_duration > 0).map(t => t.aid_duration);
  if (mbVals.length)  return mbVals[0];  // MB wins over AcoustID, and over disagreeing MB entries alike
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

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Evaluate all tracks in a duplicate group: assign dimension tags, then pick
 * the winner via priority cascade.
 *
 * Returns tracks augmented with:
 *   _pickTags   — dimension tags for UI display
 *   _keepWinner — true for the track that should be kept
 *   _winReason  — human-readable reason (only on the winner)
 *
 * @param {Array} tracks
 * @param {Object} opts
 * @param {Array}  [opts.tierOrder]         — quality tier priority list
 * @param {Array}  [opts.pickTagOrder]      — pick-tag priority list
 * @param {Function} [opts.getLocalAlbumCount] — (albumName) => count of local files in that album
 */
export function evaluateGroup(tracks, { tierOrder, pickTagOrder, getLocalAlbumCount, retentionFileIds, excludeFileIds } = {}) {
  if (!tracks || tracks.length === 0) return [];

  const order = Array.isArray(tierOrder) && tierOrder.length ? tierOrder : DEFAULT_TIER_ORDER;
  const rids = retentionFileIds instanceof Set ? retentionFileIds : new Set();
  const exids = excludeFileIds instanceof Set ? excludeFileIds : new Set();

  // ── Compute scores ───────────────────────────────────────────────────
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
      _rtypeScore:      releaseTypeScore(t),
    };
  });

  // Single track → trivially the winner
  if (annotated.length === 1) {
    annotated[0]._pickTags = [];
    annotated[0]._keepWinner = true;
    annotated[0]._winReason = '唯一版本';
    return annotated;
  }

  // ── Assign dimension tags ─────────────────────────────────────────────
  // Only assign a tag when the dimension actually discriminates (not
  // everyone is "best") — otherwise the tag is noise in the UI.
  const bestQuality = Math.max(...annotated.map(t => t._quality));
  const bestMeta    = Math.max(...annotated.map(t => t._meta));
  const bestScrape  = Math.max(...annotated.map(t => t._scrapeMatches));
  const bestRtype   = Math.max(...annotated.map(t => t._rtypeScore));
  const yearsWithVal = annotated.map(t => t.album_year).filter(y => y > 0);
  const earliestYr  = yearsWithVal.length > 0 ? Math.min(...yearsWithVal) : null;

  const diffQuality = new Set(annotated.map(t => t._quality)).size > 1;
  const diffMeta    = new Set(annotated.map(t => t._meta)).size > 1 && bestMeta > 0;
  const diffScrape  = bestScrape > 0;
  const diffRtype   = new Set(annotated.map(t => t._rtypeScore)).size > 1 && bestRtype > 0;
  const diffYear    = new Set(annotated.map(t => t.album_year).filter(Boolean)).size > 1;

  // Duration accuracy: one shared reference for the whole group (see
  // groupDurationReference) — every track's own local duration is judged
  // against it, whether or not that specific track has been scraped
  // itself. If no track in the group has any exact-scrape duration at
  // all, the dimension isn't evaluable and no one gets tagged. If every
  // evaluable track is accurate, the dimension carries no discriminating
  // information for this group, so no one gets tagged either.
  const groupDurationRef = groupDurationReference(annotated);
  for (const t of annotated) {
    t._durationRef = groupDurationRef;
    t._durationAccurate = (groupDurationRef != null && t.duration > 0)
      ? Math.abs(t.duration - groupDurationRef) <= DURATION_ACCURATE_TOLERANCE
      : null;
  }
  const withDurationRef = groupDurationRef != null ? annotated.filter(t => t.duration > 0) : [];
  const allDurationAccurate = withDurationRef.length > 0 && withDurationRef.every(t => t._durationAccurate);
  const diffDuration = withDurationRef.length > 0 && !allDurationAccurate;

  for (const t of annotated) {
    const tags = [];
    if (diffQuality && t._quality === bestQuality) tags.push('quality_best');
    if (diffScrape && t._scrapeVerified && t._scrapeMatches === bestScrape) tags.push('scrape_best');
    if (diffRtype && t._rtypeScore === bestRtype) tags.push('album_best');
    if (diffYear && t.album_year && earliestYr !== null && t.album_year === earliestYr) tags.push('release_best');
    if (diffMeta && t._meta === bestMeta) tags.push('meta_best');
    if (diffDuration && t._durationAccurate) tags.push('duration_accurate');
    if (rids.has(t.id)) tags.push('manual_keep');
    t._pickTags = tags;
  }

  // ── Priority cascade: pick winner from tags ───────────────────────────
  // Built dynamically from user-configurable pickTagOrder so the priority
  // is as adjustable as quality tiers.
  let candidates = annotated;
  let smartWinners = null;
  let smartReason = null;

  const TIER_DEFS = {
    scrape_best: {
      label: PICK_TAG_LABEL.scrape_best,
      reason: t => `${PICK_TAG_LABEL.scrape_best}（与官方标签吻合 ${t._scrapeMatches} 项：年份/曲目号/风格）`,
      filter: (cs) => {
        const verified = cs.filter(t => t._scrapeVerified);
        if (verified.length === 0) return null;
        const recIds = new Set(verified.map(t => t.mb_recording_id).filter(Boolean));
        if (recIds.size !== 1) return null;
        const best = Math.max(...verified.map(t => t._scrapeMatches));
        return verified.filter(t => t._scrapeMatches === best);
      },
    },
    quality_best: { label: PICK_TAG_LABEL.quality_best, reason: t => `优先音质 (${fmtQuality(t)})`, tag: 'quality_best' },
    release_best: { label: PICK_TAG_LABEL.release_best, reason: t => `发售更早 ${t.album_year}`, tag: 'release_best' },
    album_best:   { label: PICK_TAG_LABEL.album_best,   reason: t => `发行类型优先 (${t._rtype})`, tag: 'album_best' },
    meta_best:    { label: PICK_TAG_LABEL.meta_best,    reason: () => '属性最完整', tag: 'meta_best' },
    duration_accurate: {
      label: PICK_TAG_LABEL.duration_accurate,
      reason: t => `${PICK_TAG_LABEL.duration_accurate} (${Math.round(t.duration)}s ≈ 精确刮削 ${Math.round(t._durationRef)}s)`,
      tag: 'duration_accurate',
    },
  };

  // Merge in any DEFAULT_PICK_TAG_ORDER keys the caller's saved order is
  // missing (appended at the end) — otherwise a pre-existing custom order
  // saved before a new dimension was introduced would silently never
  // evaluate that dimension.
  const tagOrder = Array.isArray(pickTagOrder) && pickTagOrder.length
    ? [...pickTagOrder, ...DEFAULT_PICK_TAG_ORDER.filter(k => !pickTagOrder.includes(k))]
    : DEFAULT_PICK_TAG_ORDER;

  for (const key of tagOrder) {
    if (candidates.length <= 1) break;
    const def = TIER_DEFS[key];
    if (!def) continue;

    let winners;
    if (def.filter) {
      winners = def.filter(candidates);
      if (winners === null) continue; // constraint not met, skip tier
    } else {
      winners = candidates.filter(t => t._pickTags.includes(def.tag));
    }

    if (winners.length === 1) {
      smartWinners = [winners[0]];
      smartReason = def.reason(winners[0]);
      break;
    }
    if (winners.length > 1) {
      candidates = winners;
    }
  }

  // Post-tag tiebreaker: prefer track with more local album tracks
  if (!smartWinners && candidates.length > 1) {
    const maxLib = Math.max(...candidates.map(t => t._localAlbumCount));
    if (maxLib > 0) {
      const top = candidates.filter(t => t._localAlbumCount === maxLib);
      if (top.length === 1) {
        smartWinners = [top[0]];
        smartReason = `本地专辑曲目更多 (${top[0]._localAlbumCount} 首)`;
      }
    }
  }

  // If cascade didn't find a unique winner, all remaining candidates are tied
  if (!smartWinners) {
    smartWinners = candidates;
    smartReason = null; // tie → "条件相同，建议手动选择"
  }

  // ── Apply OR: smart winner(s) ∪ retention list, minus excludes ────────
  const smartSet = new Set(smartWinners.map(t => t.id || t.path));
  for (const t of annotated) {
    const isSmart = smartSet.has(t.id || t.path);
    const isManual = rids.has(t.id);
    const isExcluded = exids.has(t.id || t.path);
    t._keepWinner = (isSmart || isManual) && !isExcluded;

    if (isExcluded) {
      t._winReason = null;
    } else if (isSmart && isManual) {
      t._winReason = (smartReason || '条件相同，建议手动选择') + ' · 手动保留';
    } else if (isSmart) {
      t._winReason = smartReason || (smartWinners.length > 1 ? '条件相同，建议手动选择' : null);
    } else if (isManual) {
      t._winReason = '手动保留';
    } else {
      t._winReason = null;
    }
  }
  return annotated;
}
