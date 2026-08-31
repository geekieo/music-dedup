// lib/progress.js — 统一的进度报告器
//
// API：
//   emit(evt)    主力。{phase, pct, level, message} → 前端。level 默认 'ok'
//   emitLive(evt) 活动行实时刷新（tqdm 式）：只更新进度条下方活动行，不追加日志
//   flush()      让出事件循环，保持 UI 响应
//   done(msg)    emit({phase:'done', pct:100, level:'done', message}) 的简写
//   error(msg)   emit({phase:'error', pct:0, level:'err', message}) 的简写
//
// level 语义（唯一颜色依据）：
//   info  → 灰色  说明性（"开始...""正在...""已保留..."）
//   ok    → 橙色  统计展示（"完成：110 对""792 组"）
//   done  → 绿色  阶段完成
//   err   → 红色  错误
//
// 消息文本由调用方自行格式化，Progress 不替调用方拼消息模板。

export class Progress {
  #emit;

  /**
   * @param {function} onProgress  原始进度回调
   */
  constructor(onProgress) {
    this.#emit = onProgress;
  }

  /** 让出事件循环，确保之前发出的进度消息被 flush 到前端。
   *   在同步阻塞操作（DB 查询、文件 IO）之前调用。 */
  async flush() {
    await new Promise(r => setImmediate(r));
  }

  /** 主力方法。evt.level 默认 'ok'，调用方可覆盖。
   *   不自动 flush——循环中高频调用时由调用方手动 flush。 */
  emit(evt) {
    this.#emit({ level: 'ok', ...evt });
  }

  /** 活动行实时刷新（tqdm 式）：只更新进度条下方活动行，不追加日志。 */
  emitLive(evt) {
    this.#emit({ level: 'ok', live: true, ...evt });
  }

  /** 阶段完成，emit 简写 */
  done(message) {
    this.#emit({ phase: 'done', pct: 100, level: 'done', message });
  }

  /** 错误，emit 简写 */
  error(message) {
    this.#emit({ phase: 'error', pct: 0, level: 'err', message });
  }
}

// ── 统一阶段日志器 ──────────────────────────────────────────────────────
// 批量阶段的统一进度/日志规则，行数与数据规模无关：
//   start(count, detail) 记开始日志；detail=null 只设总数（开始已由调用方另行发出时用）
//   tick(done, pct)      活动行每 1s 刷新（emitLive，不记日志）；日志每跨 10% 记一条
//   done(message)        记结束日志
// pct 覆盖：双源并行（刮削 AID/MB）时传合并后的整体进度，subPct 恒为本循环比例。
export function createPhaseLog(prog, { phase, label, liveIntervalMs = 1000, logStepPct = 10, logMinIntervalMs = 2000, pctFrom = 0, pctTo = 100 } = {}) {
  let total = 0;
  let lastLiveAt = 0;
  let lastLogPct = 0;
  let lastLogAt = 0;
  const span = pctTo - pctFrom;
  return {
    start(count, detail = '') {
      total = count;
      lastLiveAt = Date.now();
      lastLogAt = Date.now();
      if (detail !== null) prog.emit({ phase, pct: pctFrom, level: 'info', message: `开始${label}（${detail}）...` });
    },
    tick(done, pctOverride) {
      if (total <= 0) return;
      const ratio = done / total;
      const pct = pctOverride ?? (span > 0 ? pctFrom + Math.round(ratio * span) : pctFrom);
      const subPct = Math.round(ratio * 100);
      const now = Date.now();
      if (now - lastLiveAt >= liveIntervalMs) {
        lastLiveAt = now;
        prog.emitLive({ phase, pct, subPct, message: `${label}: ${done} / ${total}` });
      }
      if (subPct >= lastLogPct + logStepPct && now - lastLogAt >= logMinIntervalMs && subPct < 100) {
        lastLogPct = subPct;
        lastLogAt = now;
        prog.emit({ phase, pct, subPct, level: 'ok', message: `${label}: ${done} / ${total}` });
      }
    },
    done(message, { phase: donePhase = 'done', pct: donePct = pctTo, level: doneLevel = 'done' } = {}) {
      prog.emit({ phase: donePhase, pct: donePct, level: doneLevel, message });
    },
  };
}
