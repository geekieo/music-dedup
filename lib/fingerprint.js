// lib/fingerprint.js — Pure-JS spectral fingerprinting (Goertzel algorithm)
//
// Key design decisions:
// - Samples from 5 anchor points (15%–85%) so leading silence / encoder padding
//   is always skipped. Each anchor independently skips silent frames.
// - Each anchor produces ~24 fingerprint integers; 5 anchors → 120 total.
// - Fingerprints with too few non-zero integers are rejected (unreliable).
// - mpg123-decoder stderr noise is suppressed globally.

import { parseFile } from 'music-metadata';
import nodePath from 'path';
import { SPECTRAL_SIM_MIN, SPECTRAL_SIM_CAP } from './constants.js';

// ── Suppress mpg123 decoder noise on stderr ──────────────────────────────
const _origWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (typeof chunk === 'string' && chunk.includes('mpg123-decoder')) return true;
  if (Buffer.isBuffer(chunk) && chunk.toString().includes('mpg123-decoder')) return true;
  return _origWrite(chunk, ...args);
};

// ── Lazy-load audio-decode ────────────────────────────────────────────────
let _decode = null;
async function getDecoder() {
  if (!_decode) { const m = await import('audio-decode'); _decode = m.default; }
  return _decode;
}

// ── DSP constants ─────────────────────────────────────────────────────────
const TARGET_SR  = 11025;   // Hz – same as Chromaprint
const FRAME_SIZE = 256;     // ~23 ms per frame
const FRAME_STEP = 64;      // 75 % overlap
const RMS_THRESH = 0.002;   // min per-sample RMS to count as "real audio"

// 33 log-spaced frequencies, 300 Hz → 2 kHz (most distinctive range for music)
const FREQS = Array.from({ length: 33 }, (_, i) =>
  Math.round(300 * Math.pow(2000 / 300, i / 32))
);

// Anchor positions (fraction of total duration). Spread avoids intros/outros.
const ANCHOR_PCTS   = [0.15, 0.30, 0.50, 0.65, 0.80];
const FRAMES_PER_ANCHOR = 25;   // 25 frames → 24 integer pairs per anchor

// ── Goertzel: power at one frequency in one frame ─────────────────────────
function goertzel(samples, freq, sr) {
  const omega = 2 * Math.PI * freq / sr;
  const coeff = 2 * Math.cos(omega);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const s0 = samples[i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - s1 * s2 * coeff;
}

// ── Linear resample to TARGET_SR ─────────────────────────────────────────
function resample(pcm, fromSR) {
  if (fromSR === TARGET_SR) return pcm;
  const ratio = fromSR / TARGET_SR;
  const len   = Math.floor(pcm.length / ratio);
  const out   = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i * ratio;
    const lo  = Math.floor(pos);
    const hi  = Math.min(lo + 1, pcm.length - 1);
    out[i]    = pcm[lo] + (pcm[hi] - pcm[lo]) * (pos - lo);
  }
  return out;
}

// ── Mix stereo → mono ─────────────────────────────────────────────────────
function toMono(channelData) {
  if (channelData.length === 1) return channelData[0];
  const len  = channelData[0].length;
  const mono = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const ch of channelData) s += ch[i];
    mono[i] = s / channelData.length;
  }
  return mono;
}

// ── Spectral energies for one frame ──────────────────────────────────────
function frameEnergies(frame) {
  return FREQS.map(f => goertzel(frame, f, TARGET_SR));
}

// ── Frame RMS ─────────────────────────────────────────────────────────────
function frameRMS(pcm, offset) {
  let e = 0;
  for (let i = offset; i < offset + FRAME_SIZE; i++) e += pcm[i] * pcm[i];
  return Math.sqrt(e / FRAME_SIZE);
}

// ── Build fingerprint from PCM ────────────────────────────────────────────
// For each anchor pct, scans forward until a non-silent frame is found,
// then collects FRAMES_PER_ANCHOR consecutive non-silent frames.
// Integers are computed WITHIN each anchor (never crossing anchor boundaries).
function fpFromPCM(pcmOrig, sr) {
  const pcm = resample(pcmOrig, sr);
  const len = pcm.length;
  if (len < FRAME_SIZE * 10) return null;   // too short

  const allInts = [];

  for (const pct of ANCHOR_PCTS) {
    // Find the first non-silent frame at or after the anchor position
    let anchorStart = Math.floor(pct * len);

    let startIdx = -1;
    for (let i = anchorStart; i + FRAME_SIZE <= len; i += FRAME_STEP) {
      if (frameRMS(pcm, i) > RMS_THRESH) { startIdx = i; break; }
    }
    // Also try searching backward if forward search reaches end of file
    if (startIdx === -1) {
      for (let i = anchorStart; i >= 0; i -= FRAME_STEP) {
        if (i + FRAME_SIZE <= len && frameRMS(pcm, i) > RMS_THRESH) {
          startIdx = i; break;
        }
      }
    }
    if (startIdx === -1) continue;  // entire anchor region is silent

    // Collect frames, skipping silent ones
    const frames = [];
    for (let i = startIdx; i + FRAME_SIZE <= len && frames.length < FRAMES_PER_ANCHOR; i += FRAME_STEP) {
      if (frameRMS(pcm, i) > RMS_THRESH) {
        frames.push(frameEnergies(pcm.subarray(i, i + FRAME_SIZE)));
      }
    }

    if (frames.length < 2) continue;

    // Build integers from consecutive frame pairs within this anchor
    for (let t = 0; t + 1 < frames.length; t++) {
      let val = 0;
      for (let b = 0; b < 32; b++) {
        const d_t  = frames[t    ][b] - frames[t    ][b + 1];
        const d_t1 = frames[t + 1][b] - frames[t + 1][b + 1];
        if (d_t > d_t1) val |= (1 << b);
      }
      allInts.push(val >>> 0);
    }
  }

  if (allInts.length < 20) return null;

  // Reject all-zero fingerprints (silence throughout the entire audio)
  const nonZero = allInts.filter(v => v !== 0).length;
  if (nonZero < allInts.length * 0.1) return null;

  return allInts.join(' ');
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compute fingerprint for an audio file.
 * Returns { fingerprint, duration, method: 'spectral'|'metadata' }
 */
export async function computeFingerprint(filePath) {
  // FP_DEBUG 内部分段计时（定位慢在哪一段）
  const FP_DEBUG = process.env.FP_DEBUG === '1';
  const tRead = Date.now();
  let readMs = 0, decMs = 0, restMs = 0;
  // 1. Try spectral fingerprint via audio-decode (pure JS)
  try {
    const { readFile } = await import('fs/promises');
    const buf    = await readFile(filePath);
    readMs = Date.now() - tRead;
    const decode = await getDecoder();
    const tDec = Date.now();
    const audio  = await decode(buf);
    decMs = Date.now() - tDec;

    const pcmMono = toMono(audio.channelData);
    const duration = pcmMono.length / audio.sampleRate;
    const fp       = fpFromPCM(pcmMono, audio.sampleRate);
    restMs = Date.now() - tRead - readMs - decMs;

    if (FP_DEBUG) console.log(`[fp-dbg] 内部 read=${readMs}ms decode=${decMs}ms mono+goertzel=${restMs}ms`);
    if (fp) return { fingerprint: fp, duration, method: 'spectral' };
    // fp is null → silent-only file, fall through to metadata
  } catch { /* unsupported format or corrupt file */ }

  // 2. Metadata pseudo-fingerprint (title + filename fallback + duration)
  try {
    const meta  = await parseFile(filePath, { duration: true, skipCovers: true });
    const title = normalizeStr(
      meta.common.title ||
      extractTitleFromFilename(filePath)
    );
    const dur = Math.round(meta.format.duration || 0);

    // Don't emit a fingerprint that would be identical for all untagged files
    if (!title && dur === 0) return { fingerprint: null, duration: 0, method: 'metadata' };

    return {
      fingerprint: `META:${title}:::${dur}`,
      duration: dur,
      method: 'metadata',
    };
  } catch {
    return { fingerprint: null, duration: 0, method: 'metadata' };
  }
}

// ── Similarity ────────────────────────────────────────────────────────────

export function fingerprintSimilarity(fp1, fp2, maxOffset = 0) {
  if (!fp1 || !fp2)  return 0;
  if (fp1 === fp2)   return 1.0;

  const m1 = fp1.startsWith('META:');
  const m2 = fp2.startsWith('META:');
  if (m1 && m2)  return metaSim(fp1, fp2);
  if (m1 !== m2) return 0;

  return spectralSim(fp1, fp2, maxOffset);
}

function spectralSim(fp1, fp2, maxOffset = 0) {
  const a = fp1.trim().split(/\s+/).map(Number);
  const b = fp2.trim().split(/\s+/).map(Number);
  if (a.length === 0 || b.length === 0) return 0;

  // Sliding-window alignment: encoder priming/padding samples shift the
  // decoded audio by tens of ms, which throws off fixed-anchor fingerprints.
  // A small offset search (±maxOffset positions) recovers the alignment.
  let bestBits = 0, bestLen = 0;
  for (let off = -maxOffset; off <= maxOffset; off++) {
    const a0 = Math.max(0, off), b0 = Math.max(0, -off);
    const len = Math.min(a.length - a0, b.length - b0);
    if (len < 20) continue;
    let bits = 0;
    for (let i = 0; i < len; i++) bits += 32 - hammingWeight((a[a0 + i] ^ b[b0 + i]) >>> 0);
    if (bits > bestBits) { bestBits = bits; bestLen = len; }
  }
  return bestLen > 0 ? bestBits / (bestLen * 32) : 0;
}

function metaSim(fp1, fp2) {
  const [, t1, d1] = fp1.split(':::');
  const [, t2, d2] = fp2.split(':::');
  if (Math.abs(+d1 - +d2) > 8) return 0;
  const ts = strSim(t1 || '', t2 || '');
  return ts >= SPECTRAL_SIM_MIN ? Math.min(ts, SPECTRAL_SIM_CAP) : 0;
}

// ── Chromaprint similarity ────────────────────────────────────────────────
// Compares the RAW (uncompressed) integer arrays from fpcalc -raw — see
// lib/chromaprint-bridge.js. Same bit-difference + sliding-window approach as
// spectralSim above: a small offset search (±maxOffset positions) recovers
// alignment lost to encoder priming/padding samples. This is a simple
// whole-fingerprint alignment, not the full cross-correlation a production
// AcoustID match implementation would do — a reasonable approximation for
// comparing against the built-in spectral fingerprint's results.
export function chromaprintSimilarity(raw1, raw2, maxOffset = 0) {
  if (!raw1 || !raw2) return 0;
  const a = raw1.split(',').map(Number);
  const b = raw2.split(',').map(Number);
  if (a.length === 0 || b.length === 0) return 0;

  let bestBits = 0, bestLen = 0;
  for (let off = -maxOffset; off <= maxOffset; off++) {
    const a0 = Math.max(0, off), b0 = Math.max(0, -off);
    const len = Math.min(a.length - a0, b.length - b0);
    if (len < 20) continue;
    let bits = 0;
    for (let i = 0; i < len; i++) bits += 32 - hammingWeight((a[a0 + i] ^ b[b0 + i]) >>> 0);
    if (bits > bestBits) { bestBits = bits; bestLen = len; }
  }
  return bestLen > 0 ? bestBits / (bestLen * 32) : 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────

export function normalizeStr(s) {
  return (s || '')
    // Decompose accented Latin letters (é,à,ë,ñ...) into base letter + combining
    // mark, then strip the marks. Without this, "Micmacs à la gare" and
    // "Micmacs A La Gare" normalize to DIFFERENT strings, which silently breaks
    // title-based duplicate matching for files with accented tags or filenames.
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Keep any Unicode letter/number (covers CJK, Cyrillic, Hangul, etc.) plus underscore.
    .replace(/[^\p{L}\p{N}_]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTitleFromFilename(filePath) {
  let name = nodePath.basename(filePath, nodePath.extname(filePath));
  name = name.replace(/^\d{1,3}[\s.\-_]+/, '');
  const m = name.match(/^.+?\s*[-–—]\s*(.+)$/);
  return m ? m[1].trim() : name;
}

export function strSim(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function hammingWeight(n) {
  n = n >>> 0;
  n -= (n >> 1) & 0x55555555;
  n  = (n & 0x33333333) + ((n >> 2) & 0x33333333);
  n  = (n + (n >> 4)) & 0x0f0f0f0f;
  return (n * 0x01010101) >>> 24;
}
