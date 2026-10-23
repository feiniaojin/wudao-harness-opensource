// 夜移 035 — 回合相位计时（codex codex-rs/core/src/turn_timing.rs 移植）。
// wudao 有缓存取证（M24 字节断言）无延迟取证——「这回合为何 90s」不可答。
// 六桶归账：beforeFirstSampling（run 起点到首个采样相——排队/投影/首投
// 影开销）/ sampling（模型流往返，含消费者背压）/ compaction（压缩梯，
// 其内部 tier-2 摘要 LLM 时间随桶走）/ toolBlocking（权限 gate + 工具执
// 行）/ betweenSamplingOverhead（两轮采样之间的恢复梯/注记/批次钩子等
// harness 开销）/ afterLastSampling（末采后的收尾）。采样请求计数与重试
// 计数分离（重试也是一次请求）。
// 语义（codex 同款）：advance() 在每个转换点把流逝时间归账给「当前活动
// 相」，无活动相时按 seenSampling 分到 pendingIdle（下一轮采样开启时转
// between_overhead）或 beforeFirstSampling；嵌套 begin 惰性（活动相不换
// ——guard 的 active=false，end 无操作）；complete() 幂等且冻结（记忆化，
// 之后一切 begin/end 惰性）；各桶 ms 向下取整产生的舍入残差吸入「终相」
// 桶（六桶恒重加 = total，codex 的尾相吸收取整）；时钟回退饱和为零
// （saturating_duration_since）。guard 显式 end()（无 RAII——TS 的
// try/finally 由调用方持）。
// 分叉：codex 的 TurnTimingState 还带 TTFT/TTFM 与 item 起始表——那是
// 协议层逐 item 事件的计时，wudao 的流事件形状不同，第一刀只移植相位归
// 账本体；时钟注入（codex 用真 Instant，测试不可控）。
export interface TurnProfile {
  readonly beforeFirstSamplingMs: number;
  readonly samplingMs: number;
  readonly compactionMs: number;
  readonly betweenSamplingOverheadMs: number;
  readonly toolBlockingMs: number;
  readonly afterLastSamplingMs: number;
  readonly samplingRequestCount: number;
  readonly samplingRetryCount: number;
  /** 全程墙钟（started→complete 取整）；六桶恒等于它（吸收不变量）。 */
  readonly totalMs: number;
}

export interface TurnProfileGuard {
  /** 结束当前相。幂等安全；非活动相/已 complete 时无操作。 */
  end(): void;
}

export interface TurnProfileRecorder {
  markTurnStarted(): void;
  beginSampling(): TurnProfileGuard;
  beginCompaction(): TurnProfileGuard;
  beginToolBlocking(): TurnProfileGuard;
  recordSamplingRetry(): void;
  /** 幂等（记忆化）；冻结此后一切相位操作。 */
  complete(): TurnProfile;
}

type Phase = "sampling" | "compaction" | "tool-blocking";

const FLOOR_MS = (ms: number): number => Math.max(0, Math.floor(ms));

export function createTurnProfileRecorder(now: () => number = () => performance.now()): TurnProfileRecorder {
  let startedAt: number | undefined;
  let lastTransitionAt: number | undefined;
  let activePhase: Phase | undefined;
  let seenSampling = false;
  let beforeFirstSampling = 0;
  let sampling = 0;
  let compaction = 0;
  let betweenSamplingOverhead = 0;
  let toolBlocking = 0;
  let pendingIdleAfterSampling = 0;
  let samplingRequestCount = 0;
  let samplingRetryCount = 0;
  let completed: TurnProfile | undefined;

  // 转换点归账：流逝时间给当前活动相；无活动相按 seenSampling 分 pending
  // 或 beforeFirst。时钟回退饱和为零。
  const advance = (): void => {
    const nowT = now();
    if (lastTransitionAt === undefined) {
      lastTransitionAt = nowT;
      return;
    }
    const elapsed = Math.max(0, nowT - lastTransitionAt);
    lastTransitionAt = nowT;
    if (activePhase === "sampling") sampling += elapsed;
    else if (activePhase === "compaction") compaction += elapsed;
    else if (activePhase === "tool-blocking") toolBlocking += elapsed;
    else if (seenSampling) pendingIdleAfterSampling += elapsed;
    else beforeFirstSampling += elapsed;
  };

  const beginPhase = (phase: Phase): { guard: TurnProfileGuard; active: boolean } => {
    if (completed !== undefined || startedAt === undefined || activePhase !== undefined) {
      return { guard: { end: () => {} }, active: false };
    }
    advance();
    if (phase === "sampling") {
      if (seenSampling) {
        betweenSamplingOverhead += pendingIdleAfterSampling;
        pendingIdleAfterSampling = 0;
      }
      seenSampling = true;
      samplingRequestCount += 1;
    }
    activePhase = phase;
    let ended = false;
    return {
      active: true,
      guard: {
        end: (): void => {
          if (ended || completed !== undefined || activePhase !== phase) return;
          ended = true;
          advance();
          activePhase = undefined;
        },
      },
    };
  };

  return {
    markTurnStarted(): void {
      if (completed !== undefined || startedAt !== undefined) return;
      startedAt = now();
      lastTransitionAt = startedAt;
    },
    beginSampling: (): TurnProfileGuard => beginPhase("sampling").guard,
    beginCompaction: (): TurnProfileGuard => beginPhase("compaction").guard,
    beginToolBlocking: (): TurnProfileGuard => beginPhase("tool-blocking").guard,
    recordSamplingRetry(): void {
      if (completed === undefined && startedAt !== undefined) samplingRetryCount += 1;
    },
    complete(): TurnProfile {
      if (completed !== undefined) return completed;
      const nowT = now();
      const finalPhase = activePhase;
      advance();
      const afterLastSampling = seenSampling ? pendingIdleAfterSampling : 0;
      if (seenSampling) pendingIdleAfterSampling = 0;

      const totalMs = startedAt !== undefined ? FLOOR_MS(Math.max(0, nowT - startedAt)) : 0;
      let before = FLOOR_MS(beforeFirstSampling);
      let sample = FLOOR_MS(sampling);
      let compact = FLOOR_MS(compaction);
      let between = FLOOR_MS(betweenSamplingOverhead);
      let tools = FLOOR_MS(toolBlocking);
      let after = FLOOR_MS(afterLastSampling);
      // 舍入残差吸入终相：六桶恒重加 = total（诊断行不剩不可归账的洞）。
      // 残差是整数（total 取整 − 各桶取整之和），直接加进终相的取整值。
      const rounding = totalMs - (before + sample + compact + between + tools + after);
      if (finalPhase === "sampling") sample += rounding;
      else if (finalPhase === "compaction") compact += rounding;
      else if (finalPhase === "tool-blocking") tools += rounding;
      else if (seenSampling) after += rounding;
      else before += rounding;

      const profile: TurnProfile = {
        beforeFirstSamplingMs: before,
        samplingMs: sample,
        compactionMs: compact,
        betweenSamplingOverheadMs: between,
        toolBlockingMs: tools,
        afterLastSamplingMs: after,
        samplingRequestCount,
        samplingRetryCount,
        totalMs,
      };
      activePhase = undefined;
      completed = profile;
      return profile;
    },
  };
}
