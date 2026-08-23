// lib/scanner.js — 全局步骤 1,2,4: 枚举 → 提取属性 → 提取声纹
import fg from 'fast-glob';
import { parseFile } from 'music-metadata';
import { statSync } from 'fs';
import path from 'path';
import { runTx } from './db/index.js';
import { upsertFileBasic, updateFileMeta, updateFileFingerprint, updateFileChromaprint, getFilesNeedingMeta, getFilesNeedingFP, removeMissingFiles } from './db/files.js';
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
  const prog = new Progress(onProgress);
  prog.emit({ phase:'enum', pct:2, level:'info', message:'正在文件枚举...' });
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

  prog.emit({ phase:'enum', pct:100, level:'ok',
    message: `发现 ${allPaths.length.toLocaleString()} 个文件${removed?' (移除 '+removed+' 条过期记录)':''}`,
    filesFound: allPaths.length });
  prog.done('文件枚举完成');
  return allPaths.length;
}

// ── 步骤2: 提取属性 ──────────────────────────────────────────────────────
export async function runMetadata(db, { threads=8, smartScan=true, onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  const files = getFilesNeedingMeta(db, smartScan);
  const total = files.length;
  const prog = new Progress(onProgress);

  if (total === 0) {
    prog.emit({ phase:'meta', pct:100, level:'info', message:'文件属性提取: 无需更新（智能扫描：所有文件均未修改）' });
    prog.done('文件属性提取完成');
    return 0;
  }

  prog.emit({ phase:'meta', pct:0, level:'info', message:`开始文件属性提取（${total.toLocaleString()} 个文件）...` });

  const batch = Math.max(1, Math.min(threads, 32));
  let done = 0, errs = 0;

  for (let i = 0; i < files.length; i += batch) {
    if (onAbort()) return done;
    await onPause();
    if (onAbort()) return done;
    const slice = files.slice(i, i + batch);
    // 解析串行 + 逐文件 abort/pause 检查：music-metadata 解析是同步 CPU，并发不加速，
    // 且阻塞线程会挡住中止消息（STOP 等整批解析完才生效）。
    for (const f of slice) {
      if (onAbort()) return done;
      await onPause();
      const r = await extractMeta(f.path).catch(() => null);
      if (r) updateFileMeta(db, r); else errs++;
      done++;
    }
    prog.emit({ phase:'meta', pct:Math.round(done/total*100), subPct:Math.round(done/total*100), level:'ok',
      message:`文件属性提取: ${done.toLocaleString()} / ${total.toLocaleString()}${errs?' ('+errs+' 错误)':''}`,
      filesProcessed: done });
  }
  prog.done('文件属性提取完成');
  return done;
}

// ── 步骤4: 提取声纹 ──────────────────────────────────────────────────────
// FP_DEBUG=1 时打印每文件解码/Goertzel/fpcalc 与批尾等待耗时（定位性能瓶颈用，默认零开销）。
const FP_DEBUG = process.env.FP_DEBUG === '1';
const dbg = (...a) => { if (FP_DEBUG) console.log('[fp-dbg]', ...a); };
const mb = (n) => (n / 1048576).toFixed(1) + 'M';
// fpcalc 并发上限（FP_FPCALC_CAP env 可调，默认 2）：fpcalc 内嵌 FFmpeg 多线程，
// 无上限时批内多个 fpcalc 进程同时抢 CPU 会拖慢解码。上限 2 给解码留 CPU。
const FP_FPCALC_CAP = Math.max(1, parseInt(process.env.FP_FPCALC_CAP || '2', 10) || 2);

export async function runFingerprint(db, { threads=8, smartScan=true, fpcalcPath='', fpCompute, fpComputeParallel=false, onProgress=()=>{}, onAbort=()=>false, onPause=async()=>{} }={}) {
  // fpCompute：可注入自定义 compute（缺省即本地 computeFingerprint——worker 线程本身
  // 就是隔离）；无注入时保持 lib 自包含可测。
  const compute = fpCompute || computeFingerprint;
  let fpcalc = await detectFpcalc(fpcalcPath);
  if (process.env.FP_NO_FPCALC === '1') fpcalc = null; // 调试：跳过 Chromaprint 只测频谱

  const baseFiles  = getFilesNeedingFP(db, smartScan);
  const extraChroma = fpcalc && smartScan
    ? db.all('SELECT id,path,chromaprint,chromaprint_raw,fingerprint FROM files WHERE fingerprint IS NOT NULL AND (chromaprint IS NULL OR chromaprint_raw IS NULL) LIMIT 10000')
    : [];

  const seenIds = new Set(baseFiles.map(f=>f.id));
  const chromaOnlyFiles = extraChroma.filter(f=>!seenIds.has(f.id));
  const allFiles = [...baseFiles, ...chromaOnlyFiles];
  const total    = allFiles.length;
  const chromaOnlySet = new Set(chromaOnlyFiles.map(f=>f.id));

  const prog = new Progress(onProgress);

  if (total === 0) {
    prog.emit({ phase:'fp', pct:100, level:'info', message: fpcalc
      ? '声纹: 无需更新（频谱声纹 + Chromaprint 声纹均已完整）'
      : '声纹: 无需更新（智能扫描：所有文件均未修改）' });
    prog.done('声纹提取完成');
    return 0;
  }

  const hint = fpcalc
    ? ` + Chromaprint(AcoustID)${chromaOnlyFiles.length>0?`，另补算 ${chromaOnlyFiles.length} 个文件 Chromaprint`:''}`
    : ' (未检测到 fpcalc，跳过 Chromaprint)';
  prog.emit({ phase:'fp', pct:0, level:'info', message:`开始声纹提取（${total.toLocaleString()} 个文件${hint}）...` });

  const batch = Math.max(1, Math.min(threads, 16));
  let done = 0, errs = 0;
  // fpcalc 并发信号量：批内最多 FP_FPCALC_CAP 个 computeChromaprint 同时在跑（每个内部
  // 串行两次 fpcalc spawn），把核心让给串行解码线程。cpSlot 返回 acquired（true=已持槽），
  // 中止时 cpAbort 置位 + 排空等待者（resolve false → 空转跳过，不碰计数器）。
  let cpInFlight = 0;
  const cpWaiters = [];
  let cpAbort = false;
  const cpSlot = () => {
    if (cpAbort) return Promise.resolve(false);
    if (cpInFlight < FP_FPCALC_CAP) { cpInFlight++; return Promise.resolve(true); }
    return new Promise((r) => cpWaiters.push(r));
  };
  const cpRelease = () => {
    cpInFlight--;
    const next = cpWaiters.shift();
    if (next) { cpInFlight++; next(true); }
  };
  const drainCp = () => {
    cpAbort = true;
    while (cpWaiters.length) cpWaiters.shift()(false);
  };

  // 单文件处理：解码（sidecar 池或本地）→ 落库 → fpcalc（信号量限并发）。
  // fpComputeParallel（sidecar 解码池注入）时批内并行提交；缺省串行——本地
  // computeFingerprint 是单线程 WASM，并发不加速。逐文件 abort/pause 检查。
  let cpTasks = []; // 批内 fpcalc 任务集（批循环重置）
  const processOne = async (f) => {
    if (onAbort()) return;
    await onPause();
    try {
      const needsGoertzel = !chromaOnlySet.has(f.id);
      if (needsGoertzel) {
        const t0 = Date.now();
        const r = await compute(f.path);
        dbg(`goertzel ${mb(f.size)} ${path.basename(f.path)} = ${Date.now() - t0}ms`);
        if (r) updateFileFingerprint(db, f.id, r.fingerprint, r.method, r.duration);
        else errs++;
      }
      if (fpcalc && (!f.chromaprint || !f.chromaprint_raw)) {
        const t0 = Date.now();
        cpTasks.push(cpSlot().then(async (acquired) => {
          if (acquired && !onAbort()) {
            try {
              const cp = await computeChromaprint(f.path, fpcalcPath);
              dbg(`fpcalc  ${mb(f.size)} ${path.basename(f.path)} = ${Date.now() - t0}ms${cp?.error ? ' ERR ' + cp.error : ''}`);
              if (cp?.fingerprint) updateFileChromaprint(db, f.id, cp.fingerprint, cp.fingerprintRaw);
              // computeChromaprint 失败不静默：计数 + 记前几条日志，
              // 否则 Chromaprint 缺失被当"无需更新"，AcoustID 匹配悄悄降级。
              else if (cp?.error) { errs++; if (errs <= 5) console.log(`[v2] Chromaprint 失败 (${f.path}): ${cp.error}`); }
            } catch (e) { errs++; if (errs <= 5) console.log(`[v2] Chromaprint 失败 (${f.path}): ${e.message}`); }
          }
          if (acquired) cpRelease();
        }));
      }
    } catch (e) { errs++; if (errs <= 5) console.log(`[v2] 声纹提取失败 (${f.path}): ${e.message}`); }
    done++;
    if (done % 16 === 0 || done === total) {
      prog.emit({ phase:'fp', pct:Math.round(done/total*100), subPct:Math.round(done/total*100), level:'ok',
        message:`声纹提取: ${done.toLocaleString()} / ${total.toLocaleString()}${errs?` (${errs} 错误)`:''}`,
        filesProcessed: done });
    }
  };

  for (let i = 0; i < allFiles.length; i += batch) {
    if (onAbort()) { drainCp(); await Promise.all(cpTasks); return done; }
    await onPause();
    const slice = allFiles.slice(i, i + batch);
    cpTasks = [];
    const tBatch = Date.now();
    if (fpComputeParallel) {
      await Promise.all(slice.map((f) => processOne(f)));
    } else {
      for (const f of slice) {
        if (onAbort()) { drainCp(); await Promise.all(cpTasks); return done; }
        await processOne(f);
      }
    }
    const tWait = Date.now();
    await Promise.all(cpTasks);
    dbg(`batch ${i / batch + 1}: 解码 ${tWait - tBatch}ms + 等 fpcalc ${Date.now() - tWait}ms`);
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
