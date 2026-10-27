// ω99-41 — 流式文本线性累积的纯数据结构。
// 每个 delta push 进 chunk 数组（O(1) 摊销）；观察缝（emit / 段落提交）一次
// join 取走全部。取代「每 delta 整串拷贝」的 O(n²) 累积——万字正文的数千
// delta 在主线程上是可感的 quadratic 抖动，而 live 的观测点只有（节流的）
// emit，本不需要逐 delta 重算。
//
// 契约（brief §1.1）：
// - takeJoined() 空缓冲返回 "" 且不计 joins（无谓 materialize 不污染计数）；
// - reset() 是 epoch 边界整清，stats 跨 reset 存活（per-driver 生命周期
//   观测，非 per-run）；
// - 零依赖、零时钟——纯数据结构，不碰任何 I/O。

export interface TextBufferStats {
  pushes: number;
  joins: number;
}

export interface TextBuffer {
  /** delta 进缓冲；O(1) amortized。 */
  push(chunk: string): void;
  /** 取走全部并清空缓冲（materialize 用）；joins++ 仅当有内容。 */
  takeJoined(): string;
  /** epoch 边界整清（不清 stats）。 */
  reset(): void;
  /** 缓冲字符数（判空用，不 join）。 */
  length(): number;
  /** 测试钉 joins < pushes 的确定性面。 */
  readonly stats: TextBufferStats;
}

export function createTextBuffer(): TextBuffer {
  const chunks: string[] = [];
  const stats: TextBufferStats = { pushes: 0, joins: 0 };
  let buffered = 0;
  return {
    push(chunk) {
      chunks.push(chunk);
      buffered += chunk.length;
      stats.pushes += 1;
    },
    takeJoined() {
      if (chunks.length === 0) return "";
      const joined = chunks.join("");
      chunks.length = 0;
      buffered = 0;
      stats.joins += 1;
      return joined;
    },
    reset() {
      chunks.length = 0;
      buffered = 0;
    },
    length() {
      return buffered;
    },
    get stats() {
      return stats;
    },
  };
}
