// lib/scraper.js — Music metadata scraping via MusicBrainz + optional AcoustID
import { upsertScrapedMeta, getFilesNeedingScrape } from './db.js';
import * as OpenCC from 'opencc-js';

const MB_BASE  = 'https://musicbrainz.org/ws/2';
const AID_BASE = 'https://api.acoustid.org/v2';
const UA       = 'MusicDedup/1.2 (https://github.com/musicdedup)';

// Rate-limit: MusicBrainz requires max 1 req/sec
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Traditional → Simplified Chinese normalization ────────────────────────
// MusicBrainz frequently stores Cantonese/Taiwanese/HK releases in Traditional
// Chinese. Local libraries (and this tool's target users) generally expect
// Simplified Chinese, so any scraped text that contains Han characters is
// converted before it's stored/written — otherwise applying "scraped data"
// to a file would silently flip its tags into a different script than the
// rest of the library.
const _hasHan = s => /[\u4e00-\u9fff]/.test(s || '');
let _t2sConverter = null;
function toSimplified(s) {
  if (!s || !_hasHan(s)) return s;
  if (!_t2sConverter) _t2sConverter = OpenCC.Converter({ from: 'tw', to: 'cn' });
  try { return _t2sConverter(s); } catch { return s; }
}
function simplifyMeta(m) {
  return { ...m, title: toSimplified(m.title), artist: toSimplified(m.artist), album: toSimplified(m.album) };
}

// ── MusicBrainz text search ───────────────────────────────────────────────
async function mbSearch(title, artist) {
  if (!title) return null;
  const q = encodeURIComponent(`recording:"${title}"${artist?' AND artist:"'+artist+'"':''}`);
  try {
    const res = await fetch(`${MB_BASE}/recording?query=${q}&limit=3&fmt=json`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const rec = data.recordings?.[0];
    if (!rec || rec.score < 70) return null;
    const release = rec.releases?.[0];
    return {
      source:          'musicbrainz',
      mb_recording_id: rec.id,
      mb_release_id:   release?.id || null,
      title:           rec.title,
      artist:          rec['artist-credit']?.map(a=>a.name||a.artist?.name).filter(Boolean).join(', ') || artist || null,
      album:           release?.title || null,
      album_year:      release?.date ? parseInt(release.date) : 0,
      track_number:    release?.media?.[0]?.track?.[0]?.number ? parseInt(release.media[0].track[0].number) : 0,
      confidence:      rec.score / 100,
    };
  } catch { return null; }
}

// ── AcoustID lookup (requires client key + fingerprint) ───────────────────
async function acoustidLookup(apiKey, fingerprint, duration) {
  if (!apiKey || !fingerprint || fingerprint.startsWith('META:')) return null;
  // AcoustID requires compressed fingerprint from fpcalc, but we can still try
  // with the raw fingerprint format used by chromaprint
  try {
    const params = new URLSearchParams({
      client: apiKey, duration: Math.round(duration||0),
      fingerprint, meta: 'recordings releases',
    });
    const res = await fetch(`${AID_BASE}/lookup?${params}`, {
      headers: { 'User-Agent': UA }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.status !== 'ok') return null;
    const result = data.results?.[0];
    if (!result || result.score < 0.7) return null;
    const rec = result.recordings?.[0];
    if (!rec) return null;
    const release = rec.releases?.[0];
    return {
      source:          'acoustid',
      mb_recording_id: rec.id,
      mb_release_id:   release?.id || null,
      title:           rec.title,
      artist:          rec.artists?.map(a=>a.name).join(', ') || null,
      album:           release?.title || null,
      album_year:      release?.date?.year || 0,
      track_number:    release?.mediums?.[0]?.tracks?.[0]?.position || 0,
      confidence:      result.score,
    };
  } catch { return null; }
}

// ── Main scrape runner ────────────────────────────────────────────────────
export async function runScrape(db, { smartScan=true, acoustidKey='', onProgress=()=>{}, onAbort=()=>false }={}) {
  const files = getFilesNeedingScrape(db, smartScan);
  const total = files.length;

  if (total === 0) {
    onProgress({ phase:'scrape', pct:100, message:'元数据刮削无需更新（智能模式：所有文件已刮削）' });
    return 0;
  }

  onProgress({ phase:'scrape', pct:0, message:`开始刮削 ${total.toLocaleString()} 个文件的权威元数据...` });

  let done=0, matched=0, failed=0;

  for (const f of files) {
    if (onAbort()) break;

    // Try AcoustID first (most accurate — uses fingerprint)
    let meta = null;
    if (acoustidKey && f.fingerprint) {
      meta = await acoustidLookup(acoustidKey, f.fingerprint, f.fingerprint_duration||f.duration);
      await sleep(200);
    }

    // Fallback: MusicBrainz text search
    if (!meta) {
      meta = await mbSearch(f.title, f.artist);
      await sleep(1100); // respect 1 req/sec limit
    }

    if (meta) {
      upsertScrapedMeta(db, { ...simplifyMeta(meta), file_id: f.id });
      matched++;
    } else {
      // Mark as attempted (store empty record to avoid re-querying)
      upsertScrapedMeta(db, { file_id:f.id, source:'none', title:null, artist:null, album:null, confidence:0 });
      failed++;
    }

    done++;
    if (done % 10 === 0 || done === total) {
      onProgress({ phase:'scrape', pct: Math.round(done/total*100),
        message:`刮削: ${done}/${total} (匹配 ${matched}，未找到 ${failed})`, filesProcessed:done });
    }
  }

  onProgress({ phase:'scrape', pct:100,
    message:`刮削完成：${total} 个文件，匹配 ${matched} 个，未找到 ${failed} 个`,
    matched, failed });
  return matched;
}
