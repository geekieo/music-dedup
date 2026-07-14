// lib/scanner.js — 全局步骤 1,2,4: 枚举 → 提取属性 → 提取声纹
import fg from 'fast-glob';
import { parseFile } from 'music-metadata';
import { statSync } from 'fs';
import path from 'path';
import {
  upsertFileBasic, updateFileMeta, updateFileFingerprint, updateFileChromaprint,
  getFilesNeedingMeta, getFilesNeedingFP, removeMissingFiles, runTx,
} from './db.js';
import { computeFingerprint } from './fingerprint.js';
import { computeChromaprint, detectFpcalc } from './chromaprint-bridge.js';
import { metaScore, classifyReleaseType } from './rules.js';
import { Progress } from './progress.js';

const AUDIO_EXTS = ['flac','mp3','m4a','aac','ogg','opus','wav','aiff','aif','dsf','dff','wma','ape','wv'];
const AUDIO_GLOB = `**/*.{${AUDIO_EXTS.join(',')},${AUDIO_EXTS.map(e=>e.toUpperCase()).join(',')}}`;

function normFormat(ext) {
  const e = ext.toLowerCase();
  return { aif:'AIFF', aac:'M4A', ogg:'OGG' }[e] ?? e.toUpperCase();
}

// ── 步骤1: 枚举 ──────────────────────────────────────────────────────────
export async function runEnumerate(db, { dirs=[], exclude=[], onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  const prog = new Progress(onProgress, 'enum');
  prog.running();
  await onPause();

  if (!dirs.length) {
    prog.error('未配置扫描目录');
    return 0;
  }

  const patterns = dirs.map(d => path.join(d, AUDIO_GLOB).replace(/\\/g, '/'));
  let allPaths = [];
  try {
    allPaths = await fg(patterns, {
      ignore: exclude.map(p=>`**/${p}`),
      absolute:true, suppressErrors:true,
      followSymbolicLinks:false, caseSensitiveMatch:false,
    });
  } catch (e) {
    prog.error(`枚举失败: ${e.message}`); return 0;
  }

  const now = Date.now();
  runTx(db, () => {
    for (const f of allPaths) {
      try {
        const st = statSync(f);
        upsertFileBasic(db, { path:f, size:st.size, file_mtime:Math.floor(st.mtimeMs), file_ctime:Math.floor(st.birthtimeMs), scan_time:now });
      } catch {}
    }
  });

  const removed = removeMissingFiles(db, allPaths);

  prog.say(100,
    `发现 ${allPaths.length.toLocaleString()} 个文件${removed?' (移除 '+removed+' 条过期记录)':''}`,
    { filesFound: allPaths.length });
  prog.done('文件枚举完成');
  return allPaths.length;
}

// ── 步骤2: 提取属性 ──────────────────────────────────────────────────────
export async function runMetadata(db, { threads=8, smartScan=true, onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  const files = getFilesNeedingMeta(db, smartScan);
  const total = files.length;
  const prog = new Progress(onProgress, 'meta');

  if (total === 0) {
    prog.skip('智能扫描：所有文件均未修改');
    prog.done('文件属性提取完成');
    return 0;
  }

  prog.begin(`${total.toLocaleString()} 个文件`);

  const batch = Math.max(1, Math.min(threads, 32));
  let done = 0, errs = 0;

  for (let i = 0; i < files.length; i += batch) {
    if (onAbort()) return done;
    await onPause();
    if (onAbort()) return done;
    const slice = files.slice(i, i + batch);
    const results = await Promise.all(slice.map(async f => {
      const r = await extractMeta(f.path).catch(() => null);
      done++;
      prog.progress(Math.round(done/total*100),
        `${done.toLocaleString()} / ${total.toLocaleString()}${errs?' ('+errs+' 错误)':''}`,
        { filesProcessed: done });
      return r;
    }));

    runTx(db, () => {
      for (const r of results) { if (r) updateFileMeta(db, r); else errs++; }
    });
  }
  prog.done('文件属性提取完成');
  return done;
}

// ── 步骤4: 提取声纹 ──────────────────────────────────────────────────────
export async function runFingerprint(db, { threads=8, smartScan=true, fpcalcPath='', onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  const fpcalc = await detectFpcalc(fpcalcPath);

  const baseFiles  = getFilesNeedingFP(db, smartScan);
  const extraChroma = fpcalc && smartScan
    ? db.all('SELECT id,path,chromaprint,chromaprint_raw,fingerprint FROM files WHERE fingerprint IS NOT NULL AND (chromaprint IS NULL OR chromaprint_raw IS NULL) LIMIT 10000')
    : [];

  const seenIds = new Set(baseFiles.map(f=>f.id));
  const chromaOnlyFiles = extraChroma.filter(f=>!seenIds.has(f.id));
  const allFiles = [...baseFiles, ...chromaOnlyFiles];
  const total    = allFiles.length;
  const chromaOnlySet = new Set(chromaOnlyFiles.map(f=>f.id));

  const prog = new Progress(onProgress, 'fp');

  if (total === 0) {
    prog.say(100, fpcalc
      ? '声纹: 无需更新（频谱声纹 + Chromaprint 声纹均已完整）'
      : '声纹: 无需更新（智能扫描：所有文件均未修改）');
    prog.done('声纹提取完成');
    return 0;
  }

  const hint = fpcalc
    ? ` + Chromaprint(AcoustID)${chromaOnlyFiles.length>0?`，另补算 ${chromaOnlyFiles.length} 个文件 Chromaprint`:''}`
    : ' (未检测到 fpcalc，跳过 Chromaprint)';
  prog.begin(`${total.toLocaleString()} 个文件${hint}`);

  const batch = Math.max(1, Math.min(threads, 16));
  let done = 0, errs = 0;

  for (let i = 0; i < allFiles.length; i += batch) {
    if (onAbort()) return done;
    await onPause();
    const slice = allFiles.slice(i, i+batch);

    await Promise.all(slice.map(async f => {
      try {
        const needsGoertzel = !chromaOnlySet.has(f.id);
        if (needsGoertzel) {
          const { fingerprint, duration, method } = await computeFingerprint(f.path);
          updateFileFingerprint(db, f.id, fingerprint, method, duration);
        }
        if (fpcalc && (!f.chromaprint || !f.chromaprint_raw)) {
          try {
            const cp = await computeChromaprint(f.path, fpcalcPath);
            if (cp?.fingerprint) updateFileChromaprint(db, f.id, cp.fingerprint, cp.fingerprintRaw);
          } catch {}
        }
      } catch { errs++; }
    }));

    done += slice.length;
    if (done % 100 === 0 || done === total) {
      prog.progress(Math.round(done/total*100),
        `${done.toLocaleString()} / ${total.toLocaleString()}${errs?` (${errs} 错误)`:''}`,
        { filesProcessed: done });
    }
  }
  prog.done('声纹提取完成');
  return done;
}

// ── Internal: full metadata for one file ─────────────────────────────────
export async function extractMeta(filePath) {
  let st;
  try { st = statSync(filePath); } catch { return null; }

  let meta = null;
  try { meta = await parseFile(filePath, { duration:true, skipCovers:true }); } catch {}

  const c = meta?.common || {};
  const f = meta?.format  || {};
  const ext = path.extname(filePath).slice(1);

  const rec = {
    path:             filePath,
    title:            c.title || path.basename(filePath, path.extname(filePath)),
    artist:           c.artist || c.albumartist || null,
    album:            c.album  || null,
    album_year:       c.year   || (c.date ? parseInt(c.date) : 0) || 0,
    track_number:     c.track?.no || 0,
    release_type:     classifyReleaseType({ album:c.album, release_type:c.albumtype }),
    format:           normFormat(ext),
    bitrate:          Math.round((f.bitrate||0)/1000) || null,
    sample_rate:      f.sampleRate    || null,
    bits_per_sample:  f.bitsPerSample || null,
    duration:         f.duration      || null,
    has_lyrics:       !!(c.lyrics && c.lyrics.length && c.lyrics.some(l => (l?.text && l.text.length) || (l?.syncText && l.syncText.length))),
    meta_extracted_at: Date.now(),
    scan_time:        Date.now(),
  };
  rec.meta_score = metaScore(rec);
  return rec;
}
