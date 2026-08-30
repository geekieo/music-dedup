// lib/progress.js — 统一的进度报告器
//
// API（4 个方法）：
//   emit(evt)    主力。{phase, pct, level, message} → 前端。level 默认 'ok'
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

  /** 阶段完成，emit 简写 */
  done(message) {
    this.#emit({ phase: 'done', pct: 100, level: 'done', message });
  }

  /** 错误，emit 简写 */
  error(message) {
    this.#emit({ phase: 'error', pct: 0, level: 'err', message });
  }
}
