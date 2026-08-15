// electron/ipc/scan.js — 扫描域：start（fire-and-forget）/ abort / pause / resume / status + 进度事件
//
// SSE 广播替换为 IPC 事件：broadcast() 通过 setSend() 注入的 webContents 发送
// 'scan:progress'（v2-arch-review 步骤 5 决策 4）。Electron 依赖注入使本模块可测。
// scan/start 保持 v1 语义：handler 立即返回 {ok:true}，8 步流水线异步执行，绝不 await。
import { getDB } from '../../lib/db/index.js';
import { getAllSettings } from '../../lib/db/settings.js';
import { forceStripLaneTags } from '../../lib/db/groups.js';
import { runEnumerate, runMetadata, runFingerprint } from '../../lib/scanner.js';
import { runScrapeMatcher, runBasicMatcher, runFpMatcher } from '../../lib/matcher.js';
import { runScrape } from '../../lib/scraper.js';
import { startFpWorker } from '../fp-worker.js';

const db = getDB();

// `paused` 是软停止：长耗时阶段在既有的批次/阶段检查点处 waitIfPaused() 阻塞
//（暂停期间仍可经 abortFlag 取消），而不是把整轮执行拆掉。
let scanState = { running: false, abortFlag: false, paused: false, phase: 'idle', pct: 0, message: '', startTime: null };
let send = () => {}; // 由 registerApi 注入（绑定窗口 webContents）

export function setSend(fn) { send = fn; }

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitIfPaused() {
  while (scanState.paused && !scanState.abortFlag) await sleep(200);
}

function broadcast(data) {
  // 关键：type 不能并入 scanState —— broadcast({type:'done', ...scanState}) 时若
  // scanState 已带 type:'progress'（被 Object.assign 污染），会把 done 覆盖成 progress，
  // 渲染进程的 onDone / 主进程 sendScan 的 scanRunning=false 全部失效（P5 联调复现：
  // "扫描后重复组不刷新""关闭按钮始终最小化到托盘"同源）。type 仅走事件载荷。
  const { type, ...rest } = data;
  Object.assign(scanState, rest);
  send({ ...data });
}

// 根据 DB 文件数量预估各步骤耗时占比，使进度条反映真实耗时分布（估算逻辑原样保留）。
function estimateStepWeights(db, steps, { force, acoustidKey }) {
  const totalAudio = (db.get("SELECT COUNT(*) n FROM files") || { n: 0 }).n;
  const withTitle = (db.get("SELECT COUNT(*) n FROM files WHERE title IS NOT NULL AND title!=''") || { n: 0 }).n;
  const withFp = (db.get("SELECT COUNT(*) n FROM files WHERE fingerprint IS NOT NULL AND fingerprint!='META:'") || { n: 0 }).n;
  const withChroma = (db.get("SELECT COUNT(*) n FROM files WHERE chromaprint IS NOT NULL") || { n: 0 }).n;

  const costs = {};
  for (const s of steps) {
    switch (s) {
      case 'enum':       costs[s] = totalAudio * 0.002 + 1; break;
      case 'meta':       costs[s] = (force ? totalAudio : Math.max(1, (db.get("SELECT COUNT(*) n FROM files WHERE meta_extracted_at IS NULL") || { n: 0 }).n)) * 0.06 + 1; break;
      case 'basicMatch': costs[s] = Math.max(1, withTitle) * 0.03 + 1; break;
      case 'fp':         costs[s] = (force ? totalAudio : Math.max(1, (db.get("SELECT COUNT(*) n FROM files WHERE fp_extracted_at IS NULL OR chromaprint IS NULL") || { n: 0 }).n)) * 0.18 + 1; break;
      case 'fpMatch':    costs[s] = Math.max(1, withFp) * 0.10 + Math.max(1, withChroma) * 0.04 + 1; break;
      case 'scrape': {
        const mbN = force ? Math.max(1, withTitle) : Math.max(1, (db.get("SELECT COUNT(*) n FROM files WHERE mb_checked_at IS NULL AND title IS NOT NULL AND title!=''") || { n: 0 }).n);
        const aidN = acoustidKey ? (force ? Math.max(1, withChroma) : Math.max(1, (db.get("SELECT COUNT(*) n FROM files WHERE acoustid_checked_at IS NULL AND chromaprint IS NOT NULL AND title IS NOT NULL AND title!=''") || { n: 0 }).n)) : 0;
        costs[s] = aidN * 0.45 + mbN * 1.15 + 1; break;
      }
      case 'scrapeMatch': costs[s] = Math.max(1, withTitle) * 0.02 + 1; break;
      default: costs[s] = 1;
    }
  }
  const total = Object.values(costs).reduce((a, b) => a + b, 0);
  const w = {};
  for (const [k, v] of Object.entries(costs)) w[k] = v / total;
  return w;
}

async function runScanPipeline({ dirs, exclude, threads, threshold, durationTolerance, smartScan, steps, force, retryMissed, acoustidKey, fpcalcPath }) {
  scanState = { running: true, abortFlag: false, paused: false, phase: 'starting', pct: 0, level: 'info', message: `[${new Date().toLocaleTimeString([], { hour12: false })}] 准备中...`, startTime: Date.now() };
  broadcast({ type: 'start', ...scanState });
  // 原地 mutate scanState 并广播——只广播 evt 会因前端整体替换而丢掉 running/paused/abortFlag
  const prog = (evt) => {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    Object.assign(scanState, evt.message ? { ...evt, message: `[${ts}] ${evt.message}` } : evt);
    broadcast({ type: 'progress', ...scanState });
  };
  const abort = () => scanState.abortFlag;
  const pause = waitIfPaused;
  let stepWeights = {}; // 延迟到 try 内计算：若抛错可走 catch→finally 广播 done，不卡 running 态
  let cumWeight = 0;
  // P5：指纹阶段委派 worker（audio-decode 同步 CPU 大户，主进程跑会阻塞事件循环导致
  // 窗口"未响应"）。仅当本轮含 fp 步骤才创建；finally 里 terminate。
  let fpWorker = null;
  function wrapProg(stepName) {
    const w = stepWeights[stepName] || 0;
    const startWeight = cumWeight;
    return (evt) => {
      const innerPct = evt.pct || 0;
      const overallPct = w > 0 ? Math.round((startWeight + Math.min(100, innerPct) / 100 * w) * 100) : Math.round(cumWeight * 100);
      prog({ ...evt, pct: Math.min(100, overallPct) });
    };
  }
  function advanceWeight(stepName) { cumWeight += stepWeights[stepName] || 0; }
  try {
    stepWeights = estimateStepWeights(db, steps, { force, acoustidKey });
    // 步骤1: 枚举
    if (steps.includes('enum') && !abort()) {
      await runEnumerate(db, { dirs, exclude, onProgress: wrapProg('enum'), onAbort: abort, onPause: pause });
      advanceWeight('enum');
    }
    // 步骤2: 提取属性
    if (steps.includes('meta') && !abort()) {
      await runMetadata(db, { threads, smartScan: force ? false : smartScan, onProgress: wrapProg('meta'), onAbort: abort, onPause: pause });
      advanceWeight('meta');
    }
    // 步骤3: 属性匹配（标题分组 + 元数据确认，不依赖声纹）
    if (steps.includes('basicMatch') && !abort()) {
      if (force) forceStripLaneTags(db, ['meta_confirmed']);
      wrapProg('basicMatch')({ phase: 'basicMatch', pct: 0, level: 'info', message: force ? '全量重新执行：清除本通道旧组，重新匹配后合并' : '开始基础匹配分析...' });
      await runBasicMatcher(db, { durationTolerance, onProgress: wrapProg('basicMatch'), onAbort: abort, onPause: pause });
      advanceWeight('basicMatch');
    }
    // 步骤4: 提取声纹
    if (steps.includes('fp') && !abort()) {
      if (!fpWorker) fpWorker = startFpWorker();
      await runFingerprint(db, { threads, smartScan: force ? false : smartScan, fpcalcPath, fpCompute: fpWorker.compute, onProgress: wrapProg('fp'), onAbort: abort, onPause: pause });
      advanceWeight('fp');
    }
    // 步骤5+6: 声纹匹配（频谱声纹 + CP声纹）
    if (steps.includes('fpMatch') && !abort()) {
      if (force) forceStripLaneTags(db, ['spectral_exact', 'same_recording', 'cp_exact', 'cp_similar']);
      wrapProg('fpMatch')({ phase: 'fpMatch', pct: 0, level: 'info', message: force ? '全量重新执行：清除本通道旧组，重新匹配后合并' : '开始声纹匹配分析...' });
      await runFpMatcher(db, { threshold, onProgress: wrapProg('fpMatch'), onAbort: abort, onPause: pause });
      advanceWeight('fpMatch');
    }
    // 步骤7: 刮削
    if (steps.includes('scrape') && !abort()) {
      await runScrape(db, { smartScan: force ? false : smartScan, retryMissed, acoustidKey, onProgress: wrapProg('scrape'), onAbort: abort, onPause: pause });
      advanceWeight('scrape');
    }
    // 步骤8: 刮削匹配（recording ID 对比）
    if (steps.includes('scrapeMatch') && !abort()) {
      if (force) forceStripLaneTags(db, ['mb_confirmed', 'acoustid_confirmed']);
      wrapProg('scrapeMatch')({ phase: 'scrapeMatch', pct: 0, level: 'info', message: force ? '全量重新执行：清除本通道旧组，重新匹配后合并' : '开始刮削匹配分析...' });
      await runScrapeMatcher(db, { onProgress: wrapProg('scrapeMatch'), onAbort: abort, onPause: pause });
      advanceWeight('scrapeMatch');
    }
  } catch (e) {
    prog({ phase: 'error', pct: 0, level: 'err', message: `失败: ${e.message}` });
  } finally {
    if (fpWorker) { fpWorker.terminate(); fpWorker = null; }
    scanState.running = false;
    scanState.paused = false;
    broadcast({ type: 'done', ...scanState });
  }
}

export const routes = [
  { method: 'POST', path: '/api/scan/start', handler: (_p, _q, body) => {
    if (scanState.running) return { ok: false, error: '已有扫描进行中' };
    const s = getAllSettings(db);
    const dirs = s.scan_dirs || [], exclude = s.exclude_patterns || [];
    const threads = parseInt(s.threads || '8'), threshold = parseInt(s.threshold || '90');
    const durationTolerance = parseInt(s.duration_tolerance || '5');
    const smartScan = s.smart_scan !== false;
    const steps = body?.steps || ['enum', 'meta', 'basicMatch', 'fp', 'fpMatch', 'scrape', 'scrapeMatch'];
    const force = body?.force === true;
    const retryMissed = body?.retryMissed === true;
    if (steps.includes('enum') && !dirs.length) return { ok: false, error: '未配置扫描目录' };
    const acoustidKey = s.acoustid_key || '';
    const fpcalcPath = s.fpcalc_path || '';
    // fire-and-forget：先返回已启动，流水线异步跑
    runScanPipeline({ dirs, exclude, threads, threshold, durationTolerance, smartScan, steps, force, retryMissed, acoustidKey, fpcalcPath });
    return { ok: true, message: '扫描已启动', steps };
  } },
  { method: 'POST', path: '/api/scan/abort', handler: () => {
    if (!scanState.running) return { ok: false };
    scanState.abortFlag = true;
    scanState.paused = false;
    broadcast({ type: 'progress', ...scanState });
    return { ok: true };
  } },
  { method: 'POST', path: '/api/scan/pause', handler: () => {
    if (!scanState.running || scanState.abortFlag) return { ok: false };
    scanState.paused = true;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    broadcast({ type: 'progress', ...scanState, level: 'info', message: `[${ts}] 已暂停 · 点击继续以恢复` });
    return { ok: true };
  } },
  { method: 'POST', path: '/api/scan/resume', handler: () => {
    if (!scanState.running || !scanState.paused) return { ok: false };
    scanState.paused = false;
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    broadcast({ type: 'progress', ...scanState, level: 'info', message: `[${ts}] 已恢复` });
    return { ok: true };
  } },
  { method: 'GET', path: '/api/scan/status', handler: () => ({ ok: true, data: scanState }) },
];
