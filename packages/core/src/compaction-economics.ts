// 借鉴弧 B1（SoL-Pi C1）— 压缩经济学决策层（OCC economics.ts 的 wudao 形）。
//
// 问题定义：wudao 的自动压缩只在占用压力（0.8×window 阶梯）下触发，时机从未
// 给「打碎暖前缀」这笔账定价——对按前缀缓存计价的推理模型（DeepSeek/GLM/
// Qwen），每次过早压缩都在付无人记账的 cache-write 溢价（M24 教义：改写历史
// 的特性必须声明缓存代价与补偿）。本模块是纯算术的闭式定价层，零模型调用：
//   · 盈亏平衡：压缩一次的净节省（span − 摘要）必须在未来请求里挣回
//     幸存前缀的重读溢价（write × (ratio − 1)）——`breakeven ≤ 剩余请求期距`
//     才值得现在压；
//   · 请求期距：已完成边界的「每边界请求数」均值 × 剩余边界数，再被
//     （窗口余量 ÷ 平均上下文增量）封顶；
//   · 缓存债记账：上次压缩的溢价按每请求的归档节省逐请求偿还；后续压缩要
//     连本带息（combined breakeven）过线，连续压缩自我限制。
//
// 与 SoL-Pi 的三点差异（超越/收窄，均有出处）：
//   ① ratio 不手填——由调用方从 providers 价目（cache_hit 价 / 输入价）自动
//     推导后传入（CachePricing）；价目未知时保守缺省
//     （DEFAULT_CACHE_WRITE_READ_RATIO，ratioSource:"default" 类型化标注），
//     不暴露给用户配置（N7 负裁决）。
//   ② writeTokens 用压缩后实际要重读的前缀（occ − span + memo），不是 SoL-Pi
//     的压缩前全量上下文——重读溢价只落在真正重读的字节上。
//   ③ 无边界统计时压力路径 fail-open（reason:"pressure_fallback"）——C2 的
//     「无边界信号才回落压力触发」：没有证据就不改变已钉死的压力语义，但债
//     照记（每次前缀断裂都有账）。
//
// 状态面：tracker 是 run 级内存态（与 usageAnchor/calibRatio 同生命周期），
// resume 后从下一个边界重新学习——不像 SoL-Pi 持久化 OCC 状态（其 custom
// entry 恢复是为了跨进程续跑同一计划；wudao 的 run 边界由 SessionRuntime
// 协调，跨 run 的边界统计没有稳定语义）。
import type { AgentMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import { parseTodoBoard } from "./tools/todo.js";
import { estimateTokens } from "./compaction-estimation.js";
import { compactableSpan, dualSummaryPartition } from "./compaction-tier2-static.js";

// ---------------------------------------------------------------------------
// 定价面（B1）：调用方推导，本模块只消费。
// ---------------------------------------------------------------------------

/** ratio 的来源——每个决策都带，价目未知时是 "default"（保守缺省的类型化标注）。 */
export type CacheRatioSource = "catalog" | "env" | "default";

/** 压缩经济学用的全部定价事实：重读全价 ÷ 缓存命中价的比值。 */
export interface CachePricing {
  /** cacheWriteReadRatio = 重读每 token 价格 ÷ 缓存命中每 token 价格。 */
  readonly cacheWriteReadRatio: number;
  readonly ratioSource: CacheRatioSource;
}

/**
 * 价目未知时的保守缺省。10 是 DeepSeek 系 miss/hit 价差的量级；「保守」指
 * 偏向推迟压缩（ratio 越大盈亏平衡越难过线）——错过的只是时机收益，窗口
 * 保护仍在，而错误的早压是确定的缓存溢价损失。
 */
export const DEFAULT_CACHE_WRITE_READ_RATIO = 10;

export const DEFAULT_CACHE_PRICING: CachePricing = Object.freeze({
  cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
  ratioSource: "default",
});

// ---------------------------------------------------------------------------
// 常量（SoL-Pi DEFAULT_COMPACTION_ECONOMICS 的 wudao 收窄：stddevK砍掉——
// 边界样本本身就是小样本，方差下界只会把期距压到 0，等价于永远推迟；scale
// 融合进 first/subsequent 两档里）。
// ---------------------------------------------------------------------------

/** 窗口保护带：距窗口不足此数时无条件压（覆盖一切经济考量）。 */
export const ECONOMICS_WINDOW_RESERVE_TOKENS = 16_384;
/** 首次压缩的期距放大（SoL-Pi firstCompactionRequestScale：首压激进）。 */
export const FIRST_COMPACTION_REQUEST_SCALE = 2;
/** 后续压缩的期距裕度（SoL-Pi subsequentCompactionMargin）。 */
export const SUBSEQUENT_COMPACTION_MARGIN = 1.5;
/** 摘要回填的 token 估计（SoL-Pi DEFAULT_NATIVE_SUMMARY_TOKEN_ESTIMATE）。
 * 决策是压缩前的闭式估算——摘要还没生成；tier-0/1 无摘要时实际回填更小，
 * 估算偏保守（节省被高估一点点，盈亏平衡略偏高）。 */
export const SUMMARY_MEMO_TOKEN_ESTIMATE = 1_000;
/** 边界主动压缩的占用下限（× threshold）：低于它连审议都不值得——暖前缀
 * 便宜、历史价值最大，边界遗忘的收益撑不起一次前缀断裂。 */
export const BOUNDARY_CANDIDATE_FLOOR_RATIO = 0.5;

// ---------------------------------------------------------------------------
// 决策类型
// ---------------------------------------------------------------------------

/** 每笔决策（压与不压）的类型化理由——不压的决策必须可审计、可进面板。 */
export type CompactionEconomicsReason =
  | "economic" // 压：盈亏平衡 ≤ 期距，现在压比留着暖前缀划算
  | "window_protection" // 压：距窗口不足保护带（覆盖一切经济考量）
  | "pressure_fallback" // 压：占用压力且无边界统计（fail-open，C2 回落规则）
  | "deferred_economic" // 不压：盈亏平衡 > 期距
  | "deferred_subsequent_margin" // 不压：过线但不满 1.5× 裕度
  | "deferred_carried_debt" // 不压：连本带息（含缓存债）未过线
  | "horizon_unavailable" // 不压：无边界统计且非压力路径（主动路径不许 fail-open）
  | "native_not_compactable" // 不压：没有可压缩 span（预检）
  | "non_positive_saving"; // 不压：span 比摘要还小，压了反而更大

/** 完整决策（审计面：进 compacted/compact_deferred 事件与测试断言）。 */
export interface CompactionEconomicsDecision {
  readonly compact: boolean;
  readonly reason: CompactionEconomicsReason;
  readonly writeTokens: number; // 压缩后需要重读的前缀估计（溢价的落点）
  readonly archiveTokens: number; // 可归档的 span token
  readonly memoTokens: number; // 摘要回填估计
  readonly savingTokens: number; // 每请求净节省（archive − memo）
  readonly requestsPerBoundaryMean: number | null;
  readonly remainingBoundaries: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly windowRequestUpperBound: number | null;
  readonly breakevenRequests: number | null;
  readonly combinedBreakevenRequests: number | null;
  readonly effectiveHorizonRequests: number | null;
  readonly cacheWriteReadRatio: number;
  readonly ratioSource: CacheRatioSource;
  readonly priorCompactionCount: number;
  readonly carriedDebtTokens: number; // 决策时的存量债（未偿还部分）
  readonly windowProtection: boolean;
}

/** decide() 的输入。 */
export interface EconomicsDecideInput {
  /** 当前占用（occupancyNow()——已含 usage 锚定与校准）。 */
  readonly occupancy: number;
  /** 生效窗口（effectiveWindow()——含 learned window）。 */
  readonly windowTokens: number;
  /** 压力路径（pendingCompaction 已武装）。 */
  readonly pressure: boolean;
  /** tier-2 可替换 span 的 token 估计；null/≤0 = 没有可压缩物。 */
  readonly spanTokens: number | null;
  /** 摘要回填估计，缺省 SUMMARY_MEMO_TOKEN_ESTIMATE。 */
  readonly memoTokens?: number;
}

// ---------------------------------------------------------------------------
// run 级追踪器：请求计数、边界统计、增量均值、缓存债。
// ---------------------------------------------------------------------------

/**
 * 一个 run 一个实例（runAgentLoop 闭包内构造）。纯记账 + 纯决策，无 IO、无
 * 时钟、无随机——全部确定性，表驱动可测。
 */
export class CompactionEconomicsTracker {
  private requestCount = 0;
  private lastBoundaryRequestCount = 0;
  private readonly boundaryIntervals: number[] = [];
  private remainingBoundaries: number | null = null;
  private lastOccupancy: number | null = null;
  private positiveDeltaTotal = 0;
  private positiveDeltaCount = 0;
  private compactionCount = 0;
  private debtTokens = 0;
  private debtRepaymentPerRequest = 0;

  constructor(private readonly pricing: CachePricing = DEFAULT_CACHE_PRICING) {}

  /** 每次模型调用前记一笔：请求数 +1、占用增量累计、缓存债偿还。 */
  recordRequest(occupancyTokens: number): void {
    this.requestCount += 1;
    if (this.lastOccupancy !== null) {
      const delta = Math.max(0, occupancyTokens - this.lastOccupancy);
      this.positiveDeltaTotal += delta;
      if (delta > 0) this.positiveDeltaCount += 1;
    }
    this.lastOccupancy = occupancyTokens;
    // 债的偿还：每请求按归档节省递减；清零后保持零（不累积信用——节省是
    // 相对「不压缩的反事实」计的，不能兑换成未来的压缩额度）。
    if (this.debtTokens > 0 && this.debtRepaymentPerRequest > 0) {
      this.debtTokens = Math.max(0, this.debtTokens - this.debtRepaymentPerRequest);
    }
  }

  /**
   * 一个子任务边界落地（todo 节点完成、结果非 error）。remainingIncomplete
   * 是新 board 的未完成项数——期距估计的「剩余边界数」。
   */
  recordBoundary(remainingIncomplete: number): void {
    const interval = Math.max(0, this.requestCount - this.lastBoundaryRequestCount);
    this.boundaryIntervals.push(interval);
    this.lastBoundaryRequestCount = this.requestCount;
    this.remainingBoundaries = Math.max(0, Math.floor(remainingIncomplete));
  }

  /**
   * 一次已发生的自动压缩入账（决策后的实际值：事件里的 before/after）。
   * 债是替换语义不是累积（SoL-Pi 同款）：旧债摊销的前缀已不存在，新压缩
   * 按自己的重读溢价重新立账——未摊完的旧债是已接受的沉没损失。
   */
  recordCompaction(writeTokens: number, removedTokens: number): void {
    const incremental = Math.max(0, this.pricing.cacheWriteReadRatio - 1);
    this.compactionCount += 1;
    this.debtTokens = Math.max(0, writeTokens * incremental);
    this.debtRepaymentPerRequest = Math.max(0, removedTokens);
    // 压缩后上下文变小，增量基线重置（下一请求的 delta 从新基数起算）。
    this.lastOccupancy = null;
    this.positiveDeltaTotal = 0;
    this.positiveDeltaCount = 0;
  }

  /** 边界主动候选的占用下限（× 0.8×window 阈值）。 */
  boundaryCandidateFloor(thresholdTokens: number): number {
    return BOUNDARY_CANDIDATE_FLOOR_RATIO * thresholdTokens;
  }

  /** 已记录的边界数（≥1 即有期距证据，压力路径从 fail-open 切入经济学）。 */
  get boundariesRecorded(): number {
    return this.boundaryIntervals.length;
  }

  /** 当前存量缓存债（未偿还的 token 溢价）。 */
  get carriedDebtTokens(): number {
    return this.debtTokens;
  }

  /** 本 run 已发生的（经此 tracker 入账的）自动压缩次数。 */
  get compactionsRecorded(): number {
    return this.compactionCount;
  }

  /** 定价事实（决策与面板共用）。 */
  get cachePricing(): CachePricing {
    return this.pricing;
  }

  /** 纯决策：给定占用/窗口/压力/span 估计，判定现在压是否划算。 */
  decide(input: EconomicsDecideInput): CompactionEconomicsDecision {
    // 摘要回填估计，封顶在 span 的一半：tier-0/1 桩没有摘要（回填≈0）、tier-2
    // 摘要有界——固定 1000 的裸估会在小 span 上把节省估成负数（微压缩场景
    // 的钉：小 span 的廉价遗忘不许被 memo 估穿）。
    const memo = input.spanTokens === null || input.spanTokens <= 0
      ? (input.memoTokens ?? SUMMARY_MEMO_TOKEN_ESTIMATE)
      : Math.min(input.memoTokens ?? SUMMARY_MEMO_TOKEN_ESTIMATE, Math.floor(input.spanTokens / 2));
    // 预检一：没有可替换 span（tier-2 的 compactableSpan 为 null——三个 tier
    // 用同一个 cutoff，谁也没东西可动）。
    if (input.spanTokens === null || input.spanTokens <= 0) {
      return this.decision(false, "native_not_compactable", {
        writeTokens: input.occupancy, archiveTokens: 0, memoTokens: memo,
        mean: null, horizon: null, windowUB: null, breakeven: null, combined: null,
        effective: null, windowProtection: false,
      });
    }
    const archive = input.spanTokens;
    // 窗口保护覆盖一切（含节省为负的角落）：距窗口不足保护带时压缩管线本身
    // 就是安全网——413 一念之间，经济性无话事权。含 threshold+8k 已被轮顶
    // immediate 臂接走的情形；这里是 SoL-Pi 的 16k 形——小窗口下比 immediate
    // 更早触发。
    const windowProtection =
      input.windowTokens > 0 && input.occupancy >= input.windowTokens - ECONOMICS_WINDOW_RESERVE_TOKENS;
    if (windowProtection) {
      return this.decision(true, "window_protection", {
        writeTokens: Math.max(0, input.occupancy - archive + memo), archiveTokens: archive,
        memoTokens: memo, mean: this.meanInterval(), horizon: null, windowUB: null,
        breakeven: null, combined: null, effective: null, windowProtection: true,
      });
    }
    const saving = archive - memo;
    // 预检二（防御性——memo 封顶后不可达，模型变化时的保险丝）：span 比回填
    // 还小，压缩反而长大上下文。
    if (saving <= 0) {
      return this.decision(false, "non_positive_saving", {
        writeTokens: Math.max(0, input.occupancy - archive + memo), archiveTokens: archive,
        memoTokens: memo, mean: null, horizon: null, windowUB: null,
        breakeven: null, combined: null, effective: null, windowProtection: false,
      });
    }
    // 压力路径无边界统计 → fail-open（C2 回落规则；债照记——见 recordCompaction）。
    if (input.pressure && this.boundaryIntervals.length === 0) {
      return this.decision(true, "pressure_fallback", {
        writeTokens: Math.max(0, input.occupancy - archive + memo), archiveTokens: archive,
        memoTokens: memo, mean: null, horizon: null, windowUB: null,
        breakeven: null, combined: null, effective: null, windowProtection: false,
      });
    }
    if (this.boundaryIntervals.length === 0) {
      // 主动（边界）路径不许 fail-open：没有期距证据就不压（horizon_unavailable）。
      return this.decision(false, "horizon_unavailable", {
        writeTokens: Math.max(0, input.occupancy - archive + memo), archiveTokens: archive,
        memoTokens: memo, mean: null, horizon: null, windowUB: null,
        breakeven: null, combined: null, effective: null, windowProtection: false,
      });
    }
    // ---- 期距（SoL-Pi estimateRemainingRequests 的 mean+scale 形）----
    const mean = this.meanInterval()!;
    const remaining = Math.max(0, this.remainingBoundaries ?? 0);
    const unbounded = 1 + Math.floor(mean * remaining);
    const avgIncrement = this.positiveDeltaCount > 0
      ? this.positiveDeltaTotal / this.positiveDeltaCount
      : null;
    const windowUB = avgIncrement !== null && avgIncrement > 0 && input.windowTokens > 0
      ? Math.max(0, Math.floor((input.windowTokens - input.occupancy) / avgIncrement))
      : null;
    const horizon = windowUB === null ? unbounded : Math.min(unbounded, windowUB);
    // ---- 盈亏平衡（②：write 用压缩后实际重读的前缀）----
    const write = Math.max(0, input.occupancy - archive + memo);
    const incremental = Math.max(0, this.pricing.cacheWriteReadRatio - 1);
    const breakeven = (write * incremental) / saving;
    const combined = (this.debtTokens + write * incremental) / saving;
    const first = this.compactionCount === 0;
    const effective = first
      ? Math.min(horizon * FIRST_COMPACTION_REQUEST_SCALE, windowUB ?? Number.POSITIVE_INFINITY)
      : horizon;
    const baseEconomic = horizon > 0 && breakeven <= horizon;
    const firstEconomic = first && effective > 0 && breakeven <= effective;
    const marginOpen = !first && breakeven * SUBSEQUENT_COMPACTION_MARGIN <= horizon;
    const debtGateOpen = !first && combined <= horizon;
    const economic = first ? firstEconomic : baseEconomic && marginOpen && debtGateOpen;
    const reason: CompactionEconomicsReason = economic
      ? "economic"
      : !first && baseEconomic && !marginOpen
        ? "deferred_subsequent_margin"
        : !first && baseEconomic && !debtGateOpen
          ? "deferred_carried_debt"
          : "deferred_economic";
    return this.decision(economic, reason, {
      writeTokens: write, archiveTokens: archive, memoTokens: memo,
      mean, horizon, windowUB, breakeven, combined, effective, windowProtection: false,
    });
  }

  private meanInterval(): number | null {
    if (this.boundaryIntervals.length === 0) return null;
    const total = this.boundaryIntervals.reduce((a, b) => a + b, 0);
    return total / this.boundaryIntervals.length;
  }

  private decision(
    compact: boolean,
    reason: CompactionEconomicsReason,
    f: {
      writeTokens: number; archiveTokens: number; memoTokens: number;
      mean: number | null; horizon: number | null; windowUB: number | null;
      breakeven: number | null; combined: number | null; effective: number | null;
      windowProtection: boolean;
    },
  ): CompactionEconomicsDecision {
    return {
      compact,
      reason,
      writeTokens: f.writeTokens,
      archiveTokens: f.archiveTokens,
      memoTokens: f.memoTokens,
      savingTokens: Math.max(0, f.archiveTokens - f.memoTokens),
      requestsPerBoundaryMean: f.mean,
      remainingBoundaries: this.remainingBoundaries,
      expectedRemainingRequests: f.horizon,
      windowRequestUpperBound: f.windowUB,
      breakevenRequests: f.breakeven,
      combinedBreakevenRequests: f.combined,
      effectiveHorizonRequests: f.effective,
      cacheWriteReadRatio: this.pricing.cacheWriteReadRatio,
      ratioSource: this.pricing.ratioSource,
      priorCompactionCount: this.compactionCount,
      carriedDebtTokens: this.debtTokens,
      windowProtection: f.windowProtection,
    };
  }
}

// ---------------------------------------------------------------------------
// 面板面（B1：缓存债进 run-stats / cost 面的形状）+ 边界信号提取。
// ---------------------------------------------------------------------------

/** compacted / compact_deferred 事件携带的经济学回执（面板与测试的消费面）。 */
export interface CompactionEconomicsReport {
  readonly reason: CompactionEconomicsReason;
  readonly breakevenRequests: number | null;
  readonly expectedRemainingRequests: number | null;
  readonly cacheWriteReadRatio: number;
  readonly ratioSource: CacheRatioSource;
  /** 事件时刻的存量缓存债（压缩事件 = 入账后的新债；推迟事件 = 未变旧债）。 */
  readonly carriedDebtTokens: number;
}

/** 从决策 + tracker 现值组装面板回执。 */
export function economicsReport(
  decision: CompactionEconomicsDecision,
  debtAfter: number,
): CompactionEconomicsReport {
  return {
    reason: decision.reason,
    breakevenRequests: decision.breakevenRequests,
    expectedRemainingRequests: decision.expectedRemainingRequests,
    cacheWriteReadRatio: decision.cacheWriteReadRatio,
    ratioSource: decision.ratioSource,
    carriedDebtTokens: debtAfter,
  };
}

/**
 * B2（SoL-Pi C2）：本轮消息里最新的 board 未完成项数——边界压缩后的「同 run
 * 续跑」注记判断还有没有活（复用 parseTodoBoard 的单识别器；board restore
 * 后的 (restored) 后缀不破坏表头解析）。undefined = 无 board。
 */
export function latestBoardIncomplete(messages: readonly AgentMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined) continue;
    const parsed = parseTodoBoard(m.content);
    if (parsed === undefined) continue;
    return parsed.incomplete;
  }
  return undefined;
}

/** B1：决策的可读推迟理由（事件 reason 的 economics: 前缀由 loop 拼）。 */
export function deferReasonDetail(decision: CompactionEconomicsDecision): string {
  return decision.breakevenRequests !== null && decision.expectedRemainingRequests !== null
    ? `（盈亏平衡 ${decision.breakevenRequests.toFixed(1)} 轮 > 期距 ${decision.expectedRemainingRequests} 轮）`
    : "";
}

/** B2：同 run 续跑的重锚定注记——ONE 条纯尾部 user note（压缩后的下一请求
 *  本就 cold-expected，M24 无新增代价）。 */
export function boundaryContinuationNote(incomplete: number): AgentMessage {
  return {
    role: "user",
    content: `[system note: context was compacted at a task boundary — the task is still active; the board lists ${incomplete} remaining item(s); continue with the next item, do not restate completed work]`,
  };
}

/**
 * B1：tier-2 可替换 span 的 token 估计（决策的 archive 输入）。标准 span 优先；
 * span 为 null 时 M52 §1 的 dual 分区仍然可压（单个超窗 turn 即窗口）——两条路
 * 都没有才真是 null（native_not_compactable）。纯函数。
 */
export function estimateCompactableTokens(
  messages: readonly AgentMessage[],
  systemPrompt: string,
  tools: readonly ModelToolDefinition[],
  keepRecent: number,
): number | null {
  const span = compactableSpan(messages, keepRecent);
  if (span !== null) return estimateTokens(systemPrompt, tools, span.span);
  const dual = dualSummaryPartition(messages, { keepRecent });
  if (dual !== null) return estimateTokens(systemPrompt, tools, [...dual.history, ...dual.turnPrefix]);
  return null;
}
