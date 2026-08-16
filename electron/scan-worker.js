// electron/scan-worker.js — 扫描流水线执行器（worker 线程，P5 扫描隔离）
//
// 扫描的 8 步流水线（enum→meta→basicMatch→fp→fpMatch→scrape→scrapeMatch）整体从
// 主进程事件循环搬到这里运行——music-metadata 解析、matcher 相似度、DB 批量写这些
// 同步 CPU 大户从此不再占用主进程，窗口其他功能（播放/导航/IPC 读库）保持响应。
// 主进程侧（electron/ipc/scan.js）只做薄 broker：转发消息 + 维护状态镜像。
//
// 与主进程的契约：
//   broker→worker：{cmd:'start', options} / {cmd:'abort'} / {cmd:'pause'} / {cmd:'resume'}
//   worker→broker：{type:'start'|'progress'|'done', ...scanState}；异常走 {type:'error', message}
// 控制位（paused/abortFlag/running）虽随载荷上送，但最终以 broker 镜像为准（防漂移）。
// DB 在流水线内打开/关闭（worker 进程级 fd，terminate() 不自动关——必须 close 防文件锁泄漏）。
import { parentPort } from 'node:worker_threads';
import { openDB } from '../lib/db/index.js';
import { forceStripLaneTags } from '../lib/db/groups.js';
import { runEnumerate, runMetadata, runFingerprint } from '../lib/scanner.js';
import { runScrapeMatcher, runBasicMatcher, runFpMatcher } from '../lib/matcher.js';
import { runScrape } from '../lib/scraper.js';

let scanState = { running: false, abortFlag: false, paused: false, phase: 'idle', pct: 0, message: '', startTime: null };
let db = null; // 流水线内打开，finally 里 close

function post(data) {
  parentPort.postMessage(data);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitIfPaused() {
  while (scanState.paused && !scanState.abortFlag) await sleep(200);
}

// 根据 DB 文件数量预估各步骤耗时占比，使进度条反映真实耗时分布（从主进程原样迁移）。
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

async function runScanPipeline(options) {
  const { dirs, exclude, threads, threshold, durationTolerance, smartScan, steps, force, retryMissed, acoustidKey, fpcalcPath } = options;
  // 本 worker 独立 DB 连接（WAL 多连接，主进程为读者）。skipInit：schema 已由主进程建立。
  db = openDB({ skipInit: true });
  scanState = { running: true, abortFlag: false, paused: false, phase: 'starting', pct: 0, level: 'info', message: `[${new Date().toLocaleTimeString([], { hour12: false })}] 准备中...`, startTime: Date.now() };
  post({ type: 'start', ...scanState });
  // 原地 mutate scanState 并上送——只上送 evt 会因前端整体替换而丢掉 running/paused/abortFlag
  const prog = (evt) => {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    Object.assign(scanState, evt.message ? { ...evt, message: `[${ts}] ${evt.message}` } : evt);
    post({ type: 'progress', ...scanState });
  };
  const abort = () => scanState.abortFlag;
  const pause = waitIfPaused;
  let stepWeights = {}; // 延迟到 try 内计算：若抛错可走 catch→finally 广播 done，不卡 running 态
  let cumWeight = 0;
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
      // fp 直接在本 worker 线程跑 computeFingerprint（runFingerprint 的 fpCompute 缺省即本地）——
      // worker 线程本身就是隔离，无需再套一层 fp-worker。fpcalcPath 由主进程预解析后传入
      //（worker 内无 process.resourcesPath，打包版无法自行检测）。
      await runFingerprint(db, { threads, smartScan: force ? false : smartScan, fpcalcPath, onProgress: wrapProg('fp'), onAbort: abort, onPause: pause });
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
    // 终态归一由主进程 broker 以镜像控制位做（本 worker 只报原始 phase + running/paused 复位）。
    // 关键：先 close DB 再上送 done——fd 是进程级资源，terminate() 不自动关。
    scanState.running = false;
    scanState.paused = false;
    if (db) { try { db.close(); } catch {} db = null; }
    post({ type: 'done', ...scanState });
  }
}

// 崩溃兜底：任何未捕获异常也保证 close DB + 通知主进程（否则文件锁泄漏、broker 卡 running）。
process.on('uncaughtException', (e) => {
  console.error('[scan-worker] uncaughtException:', e);
  try { if (db) db.close(); } catch {}
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[scan-worker] unhandledRejection:', e);
  try { if (db) db.close(); } catch {}
  parentPort.postMessage({ type: 'error', message: e && e.message ? e.message : String(e) });
  process.exit(1);
});

parentPort.on('message', (msg) => {
  switch (msg.cmd) {
    case 'start':
      runScanPipeline(msg.options); // fire-and-forget：不 await，立即返回处理下一条消息
      break;
    case 'abort':
      if (scanState.running) { scanState.abortFlag = true; scanState.paused = false; }
      break;
    case 'pause':
      if (scanState.running && !scanState.abortFlag) scanState.paused = true;
      break;
    case 'resume':
      if (scanState.running) scanState.paused = false;
      break;
  }
});
