// lib/progress.js — 统一的进度报告器
//
// 所有模块通过 Progress 实例汇报进度，不再各自手写 onProgress 调用。
// 规范：
//   begin() / running()  → 过程描述（灰色）
//   progress() / sub*()  → 过程结果（绿色）
//   done()               → 阶段完成（橙色）
//   error()              → 错误（红色）
//
// 进度条标签由 PHASE_META 统一映射，app.js 应保持同步。

/** 单一致信源：phase → 中文标签 */
export const PHASE_META = {
  starting:    '准备中',
  enum:        '文件枚举',
  meta:        '文件属性提取',
  basicMatch:  '基础匹配',
  fp:          '声纹提取',
  fpMatch:     '声纹匹配',
  scrape:      '刮削',
  scrapeMatch: '刮削匹配',
  done:        '完成',
  error:       '错误',
};

export class Progress {
  #emit;
  #phase;
  #label;

  /**
   * @param {function} onProgress  原始进度回调
   * @param {string}   phase       本阶段的 phase 标识
   * @param {object}   [ctx]       可选上下文，会合并到每条进度事件中（如 {filesProcessed}）
   */
  constructor(onProgress, phase, ctx) {
    this.#emit = onProgress;
    this.#phase = phase;
    this.#label = PHASE_META[phase] || phase;
    this.ctx = ctx || null;
  }

  /** 只读 */
  get phase() { return this.#phase; }
  get label() { return this.#label; }

  // ── 标准方法 ────────────────────────────────────────────────────────

  /** 过程描述（灰）："开始文件属性提取（1,234 个文件）..." */
  begin(detail) {
    this.#emit({ phase: this.#phase, pct: 0, message: `开始${this.#label}（${detail}）...` });
  }

  /** 过程描述（灰）："正在文件枚举..."（用于首个操作，pct 非零） */
  running() {
    this.#emit({ phase: this.#phase, pct: 2, message: `正在${this.#label}...` });
  }

  /** 进度更新（绿）："文件属性提取: 500 / 1,234" */
  progress(pct, info, extra) {
    const base = this.ctx ? { ...this.ctx } : {};
    this.#emit({ phase: this.#phase, pct, message: `${this.#label}: ${info}`, ...base, ...(extra || {}) });
  }

  /** 跳过 / 无需处理（绿）："文件属性提取: 无需更新（智能扫描：...）" */
  skip(reason) {
    this.#emit({ phase: this.#phase, pct: 100, message: `${this.#label}: 无需更新（${reason}）` });
  }

  /** 自定义消息（绿），用于不适用标准模板的场合 */
  say(pct, message, extra) {
    this.#emit({ phase: this.#phase, pct, message, ...(extra || {}) });
  }

  /** 阶段完成（橙） */
  done(message, extra) {
    this.#emit({ phase: 'done', pct: 100, message, ...(extra || {}) });
  }

  /** 透传事件，自动附加当前 phase（供子函数回调使用） */
  emit(evt) {
    this.#emit({ phase: this.#phase, ...evt });
  }

  /** 错误（红） */
  error(message) {
    this.#emit({ phase: 'error', pct: 0, message });
  }

  // ── 子阶段方法（刮削的 AcoustID/MusicBrainz，匹配器的各步骤）──────

  /** 子阶段开始（灰）："开始 AcoustID 刮削（智能模式，50 个文件）..." */
  subBegin(pct, subLabel, detail) {
    this.#emit({ phase: this.#phase, pct, message: `开始${subLabel}（${detail}）...` });
  }

  /** 子阶段进度（绿）："AcoustID 刮削: 20 / 100，命中 5 个" */
  subProgress(pct, subLabel, info, extra) {
    const base = this.ctx ? { ...this.ctx } : {};
    this.#emit({ phase: this.#phase, pct, message: `${subLabel}: ${info}`, ...base, ...(extra || {}) });
  }

  /** 子阶段完成（绿）："AcoustID 刮削完成：50 个，命中 30 个" */
  subDone(pct, subLabel, detail) {
    const extra = this.ctx ? { ...this.ctx } : {};
    this.#emit({ phase: this.#phase, pct, message: `${subLabel}完成：${detail}`, ...extra });
  }

  /** 子阶段跳过（绿）："AcoustID 刮削: 无需处理（...）" */
  subSkip(pct, subLabel, reason) {
    this.#emit({ phase: this.#phase, pct, message: `${subLabel}: 无需处理（${reason}）` });
  }
}
