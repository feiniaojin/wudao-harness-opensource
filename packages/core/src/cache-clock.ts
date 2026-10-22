// 133 top1（deepagents 64dccb060 引进，"缓存时钟"弧的纯函数基座）— 冷缓存
// 到期决策点：时钟 + 身份 + 分类 + 重暖估价。
//
// 问题：前缀缓存有保留窗口。会话空闲超过窗口后，下一条消息要全前缀按
// 输入价重付。用户对此既不知情也无选择——其实存在一个决策点：趁冷读还
// 没发生，摘要开新窗（小前缀）或继续当前线程（付冷读），两者成本可估。
//
// 时钟源（零新增写入）：会话 JSONL 的最后落盘时刻（文件 mtime，调用方
// 读）即"上次缓存承载请求"的时刻；身份源是 JSONL 里的 model_change /
// thinking_level_change 条目（最后一条胜）。本模块只做纯分类与估价——
// 不碰任何请求字节（M24：纯决策点，缓存代价为零）。
//
// 诚实纪律（deepagents 的四分手感，国产模型现实）：
// - 冷因三分互斥：idle（超窗闲置）/ identity_changed（模型或推理档变
//   了）/ age_unknown（无可读记录）。age_unknown 绝不报成
//   identity_changed——那等于宣称一次从未发生的换模型。
// - 置信二分：expired（确定没了——文档化窗口超期，或身份确定性变化）
//   / may_be_cold（可能还在——国产模型前缀缓存无文档化 TTL，闲置超
//   地板后永远诚实地说"可能已冷"，不说"已过期"）。
// - 估价无价不报：价格目录缺这档的输入价或缓存读价 → estimate 为
//   undefined（不猜）；NaN 单独先检（比较器拦不住 NaN——deepagents
//   不变量）。

/** 缓存身份：前缀缓存按什么键存活。"身份问题是值变没变，不是哪个请求
 * 形状载着它"——模型 + provider 端点 + 推理档的值元组。 */
export interface CacheIdentity {
  readonly model: string;
  readonly provider?: string;
  readonly reasoningEffort?: string;
}

/** 值相等（T003 N2/N3 语义）：model 双侧非空且相等是必要条件；provider/
 * reasoningEffort 只在**双侧都在场**（非空）时参与比较——一侧缺字段=
 * "台账无该字段的变化证据"，不构成不等（绝不宣称一次没有记录的切换）。
 * 任一侧 model 空/缺失 → false（无可比证据，不宣称相等）。 */
export function cacheIdentityEqual(a: CacheIdentity | undefined, b: CacheIdentity | undefined): boolean {
  if (a === undefined || b === undefined) return false; // 任一侧未知 → 不宣称相等（fail-open 到"不比"由调用方决定）
  if (a.model === "" || b.model === "" || a.model !== b.model) return false;
  if (a.provider !== undefined && a.provider !== "" && b.provider !== undefined && b.provider !== "") {
    if (a.provider !== b.provider) return false;
  }
  if (a.reasoningEffort !== undefined && a.reasoningEffort !== "" && b.reasoningEffort !== undefined && b.reasoningEffort !== "") {
    if (a.reasoningEffort !== b.reasoningEffort) return false;
  }
  return true;
}

/** 冷因三分（互斥；文案由 reason 主导）。 */
export type ColdReason = "idle" | "identity_changed" | "age_unknown";
/** 置信二分 + warm（地板内闲置——不值得注意）。 */
export type CacheConfidence = "warm" | "may_be_cold" | "expired";

/** 时钟策略。documentedWindowSeconds 缺省 undefined——国产模型
 * （DeepSeek/GLM/Qwen）前缀缓存无文档化 TTL，闲置超地板后永远
 * may_be_cold；有文档化窗口的模型（如 Anthropic 5m TTL）填上后超窗
 * 才敢说 expired。 */
export interface CacheClockPolicy {
  /** 闲置低于此秒数视为 warm（不打扰刚切回来的会话）。 */
  readonly idleFloorSeconds: number;
  /** 文档化的最大保留窗（秒）。undefined = 无文档 → may_be_cold。 */
  readonly documentedWindowSeconds?: number;
  /** 前缀小于此 token 数不弹决策点（短会话冷读本来就便宜）。 */
  readonly minimumPrefixTokens: number;
  /** 冷读增量成本低于此美元数不弹（不打扰便宜的重暖）。 */
  readonly costThresholdUsd: number;
}

/** 国产模型缺省：5 分钟地板、无文档窗（诚实 may_be_cold）、8k 前缀门槛、
 * 1 美分成本门槛。 */
export const DEFAULT_CACHE_CLOCK_POLICY: CacheClockPolicy = {
  idleFloorSeconds: 300,
  minimumPrefixTokens: 8192,
  costThresholdUsd: 0.01,
};

export interface CacheClassification {
  readonly reason: ColdReason;
  readonly confidence: CacheConfidence;
  /** 闲置秒数（信息面；age_unknown/identity_changed 时仍尽力给出）。 */
  readonly idleSeconds: number;
}

/** 时钟分类。判定序（互斥性的来源）：
 * 1. 无记录 → age_unknown（没有任何可比较的东西，绝不宣称换过模型）；
 * 2. 身份变了 → identity_changed（缓存按身份失效是确定性的——与新窗口
 *    的闲置时长无关）；
 * 3. 闲置 < 地板 → warm；
 * 4. 闲置 ≥ 地板：有文档窗且超窗 → expired；否则 may_be_cold。 */
export function classifyCacheClock(
  nowMs: number,
  lastActivityMs: number | undefined,
  ledgerIdentity: CacheIdentity | undefined,
  currentIdentity: CacheIdentity | undefined,
  policy: CacheClockPolicy = DEFAULT_CACHE_CLOCK_POLICY,
): CacheClassification {
  if (lastActivityMs === undefined || !Number.isFinite(lastActivityMs) || !Number.isFinite(nowMs)) {
    // T002 深测发现：nowMs 非有限时 idleSeconds=NaN 会漏进文案（"闲置 NaN
    // 天"）且一切比较为 false（直落 may_be_cold）——与 lastActivityMs 同等
    // 收口到 age_unknown（无可读时钟就没有可说的）。
    return { reason: "age_unknown", confidence: "may_be_cold", idleSeconds: 0 };
  }
  const idleSeconds = Math.max(0, (nowMs - lastActivityMs) / 1000);
  // 身份比较只在两侧都有值时进行（任一侧未知 → 不比较，走闲置车道）。
  if (
    ledgerIdentity !== undefined &&
    currentIdentity !== undefined &&
    ledgerIdentity.model !== undefined &&
    !cacheIdentityEqual(ledgerIdentity, currentIdentity)
  ) {
    return { reason: "identity_changed", confidence: "expired", idleSeconds };
  }
  if (idleSeconds < policy.idleFloorSeconds) {
    return { reason: "idle", confidence: "warm", idleSeconds };
  }
  const window = policy.documentedWindowSeconds;
  if (window !== undefined && Number.isFinite(window) && idleSeconds >= window) {
    return { reason: "idle", confidence: "expired", idleSeconds };
  }
  return { reason: "idle", confidence: "may_be_cold", idleSeconds };
}

/** 重暖估价（美元）。不变量（deepagents 同款）：非负、有限、
 * incremental ≤ cold。 */
export interface RewarmEstimate {
  readonly prefixTokens: number;
  /** 冷读全额（前缀 × 输入价）。 */
  readonly coldCostUsd: number;
  /** 暖读成本（前缀 × 缓存读价）。 */
  readonly warmCostUsd: number;
  /** 继续当前线程比暖缓存多付的钱 = cold − warm。 */
  readonly incrementalCostUsd: number;
}

/** 估价：per-M-USD 价格面。inputPerM ≤ 0 或 cacheReadPerM 缺失/无效 →
 * undefined（无价不报——不猜）。 */
export function estimateRewarm(
  prefixTokens: number,
  price: { readonly inputPerM: number; readonly cacheReadPerM: number },
): RewarmEstimate | undefined {
  // NaN 先检（比较器拦不住 NaN——先于一切合法性判断）。
  if (Number.isNaN(prefixTokens) || Number.isNaN(price.inputPerM) || Number.isNaN(price.cacheReadPerM)) return undefined;
  if (!Number.isFinite(prefixTokens) || !Number.isFinite(price.inputPerM) || !Number.isFinite(price.cacheReadPerM)) return undefined;
  if (prefixTokens <= 0 || price.inputPerM <= 0 || price.cacheReadPerM < 0) return undefined;
  const cold = (prefixTokens / 1e6) * price.inputPerM;
  const warm = (prefixTokens / 1e6) * price.cacheReadPerM;
  // 钳取保不变量（浮点尘埃下 incremental 可能微越 cold 一丝）。
  const incremental = Math.max(0, Math.min(cold - warm, cold));
  if (!Number.isFinite(cold) || !Number.isFinite(warm) || !Number.isFinite(incremental)) return undefined;
  return { prefixTokens, coldCostUsd: cold, warmCostUsd: warm, incrementalCostUsd: incremental };
}

export interface ColdCacheOffer {
  readonly offer: boolean;
  /** 不弹的原因（offer=false 时给，调用方可记日志/测试可断言）。 */
  readonly suppressed?: "warm" | "identity" | "no-clock" | "no-price" | "small-prefix" | "below-threshold";
}

/** 决策门：闲置类冷缓存，且前缀够大、估价过阈，才值得打扰用户一次
 * "摘要开新窗 or 付冷读"。身份变化类（identity_changed）不并入这个
 * offer——它是独立的通知面（换模型的通知不说"可以轮转省钱"，模型都换
 * 了，新身份本来就要冷读）。T002 深测 F7 裁决：age_unknown 也不
 * offer——时钟读不到时特性必须零行为差（跳过预热却连通知都不发=
 * 隐形动作）；信息缺失不改任何行为，预热照跑。 */
export function coldCacheOffer(
  classification: CacheClassification,
  estimate: RewarmEstimate | undefined,
  policy: CacheClockPolicy = DEFAULT_CACHE_CLOCK_POLICY,
): ColdCacheOffer {
  if (classification.confidence === "warm") return { offer: false, suppressed: "warm" };
  if (classification.reason === "identity_changed") return { offer: false, suppressed: "identity" };
  if (classification.reason === "age_unknown") return { offer: false, suppressed: "no-clock" };
  if (estimate === undefined) return { offer: false, suppressed: "no-price" };
  if (estimate.prefixTokens < policy.minimumPrefixTokens) return { offer: false, suppressed: "small-prefix" };
  if (estimate.incrementalCostUsd < policy.costThresholdUsd) return { offer: false, suppressed: "below-threshold" };
  return { offer: true };
}
