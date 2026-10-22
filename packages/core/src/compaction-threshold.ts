// 125 项 1（the upstream formatresolveCompactSpec 形）— 预留感知压缩触发线。纯函数：输入窗口/
// 比例/安全余量/输出预留，输出触发阈值（token 数）。loop 的 effectiveThreshold
// 与 CLI 的 context_remaining 工具共享这一个真值点，模型/人/harness 对
// 「还有多少上下文」永不各执一词。
//
// 形状（the upstream formatpackages/compaction/compaction-basic/src/config.ts:141-217 的
// resolveCompactSpec，三次真实 1M 窗死亡的事故尸检背书）：
//
//   threshold = min(thresholdRatio × window, window − outputReserve − headroom)
//
// - 平比帽（thresholdRatio×window）永远是上限：新公式只会收紧、永不放宽
//   （「ratio 帽仍生效」钉）。缺省 0.8 = M24 以来的触发线，行为不变。
// - outputReserve 是请求侧的完成预留（本会话请求实际携带的 maxTokens ——
//   provider profile 的 defaultMaxTokens 或用户 config.maxTokens，由 CLI
//   解析后线程进来）。长输出场景（maxTokens 相对窗口大）下，平比 0.8 的
//   触发线会在「prompt + max_tokens 已撑爆窗口」之后才到 —— 413 每轮都由
//   reactive clip-retry 事后救 = 从未 proactive（the upstream format同款迟到形态）。扣掉
//   预留后触发线提前到「下一次请求还放得下完整输出」的地方。
// - headroom 是触发线之下的固定安全余量（the upstream formatheadroomTokens 同位件）：
//   压缩产物重放、序列化开销、估算误差都从这里吸收。
// - outputReserve 未知（缺省 undefined / 0）= 平比 0.8 原样 —— 对每个
//   未解析出请求帽的会话/测试夹具字节不变（红线：不改正常短输出行为；
//   threshold 只在 outputReserve 相对窗口足够大时才收紧）。
//
// 「shared/independent 窗口」的口径（ω-2b windowMode 家族）：两种已知窗口
// 语义下的物理约束同形 —— 请求侧都必须 prompt + max_tokens ≤ window 才
// 不 413（DeepSeek 文档化的 max_tokens 顶穿总额度；anthropic-wire 网关的
// prompt+max_tokens ≤ window 请求帽）。所以 reserve 都取 maxTokens：对
// shared（DeepSeek），完成额度与 prompt 同一窗口，occupancy ≥
// window − reserve − headroom ⟺ prompt + maxTokens ≤ window − headroom
// （prompt 项就是被比较的 occupancy，不重复计账）；对 independent
// （glm-code），完成走独立预算但请求帽仍按 prompt+max_tokens 检查，同一条
// 线。windowMode 未知（未画像端点）的会话不扣预留 —— 平比，零行为变化。
//
// fail-loud 的边界（the upstream format对非正压力预算当场抛配置错误）：本模块是纯函数，
// 不抛 —— 压力预算（window − reserve − headroom）非正时钳到地板值，触发
// 线落到「立即压缩」一侧（诚实反应：这个配置放不下任何输出），CLI 装配缝
// 负责 warn（那里同时知道窗口和预留两个数）。压缩死亡螺旋由 M58 §C#3 的
// thrash breaker 兜底，不在这里重复。

/** ω-2b 的窗口语义联合（providers 的 WindowMode 在 core 的镜像字面 —— core
 *  对 providers 零依赖，端口语义以字符串联合穿过端口）。 */
export type CompactionWindowMode = "shared" | "independent" | "unknown";

/** 平比帽缺省 —— M24 以来的 0.8×window 触发线（行为锚点，永不漂移）。 */
export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.8;
/** 触发线之下的固定安全余量（the upstream formatheadroomTokens 同位件；2K 缺省）。 */
export const DEFAULT_COMPACTION_HEADROOM_TOKENS = 2048;
/** 压力预算非正时的触发线地板 —— 预留吃满窗口的病态配置落到「立即压缩」
 *  一侧，永不产出 ≤0 的阈值（负阈值会让 occupancy ≥ threshold 恒真，
 *  每轮空转压缩；thrash breaker 兜底之外的最后一道形状守卫）。 */
export const COMPACTION_THRESHOLD_FLOOR_TOKENS = 1024;

/** resolveCompactionThresholdTokens 的输入面（全部可序列化，纯数据）。 */
export interface CompactionThresholdSpec {
  /** 端点上下文窗口（token）。≤0 视为无窗口知识 → 平比帽自然为 0（调用方
   *  保证正窗口；这个分支只做形状防御）。 */
  readonly windowTokens: number;
  /** 平比帽的比例；缺省 0.8（DEFAULT_COMPACTION_THRESHOLD_RATIO）。 */
  readonly thresholdRatio?: number;
  /** 触发线之下的安全余量；缺省 2048。 */
  readonly headroomTokens?: number;
  /** 请求侧完成预留（本会话请求的 maxTokens）。undefined/≤0 = 未知 → 平比
   *  （预留感知关闭，行为与 M24 平比逐字节一致）。 */
  readonly outputReserveTokens?: number;
}

/** CLI 装配缝的预留解析：已知窗口语义（shared/independent）且请求帽已知 →
 *  reserve = maxTokens；windowMode 未知或请求帽未解析 → undefined（平比）。
 *  这是「独立窗口 vs 共享窗口的 reserve 计算」的单一真值点：两种已知语义
 *  的请求帽约束同形（见模块头），区别只在 unknown 不扣（未画像端点零行为
 *  变化的红线）。 */
export function resolveOutputReserveTokens(
  maxTokens: number | undefined,
  windowMode: CompactionWindowMode | undefined,
): number | undefined {
  if (maxTokens === undefined || maxTokens <= 0) return undefined;
  if (windowMode !== "shared" && windowMode !== "independent") return undefined;
  return maxTokens;
}

/** 预留感知触发线（the upstream formatresolveCompactSpec 形；纯函数）。
 *
 *  返回值永远 ≤ floor(thresholdRatio × window)（ratio 帽是硬上限——新公式
 *  只收紧不放宽）；outputReserveTokens 缺席时正好等于它（平比，字节不变）。
 *  压力预算（window − reserve − headroom）非正时钳到地板 1024。 */
export function resolveCompactionThresholdTokens(spec: CompactionThresholdSpec): number {
  const window = Math.max(0, Math.floor(spec.windowTokens));
  const ratio = spec.thresholdRatio ?? DEFAULT_COMPACTION_THRESHOLD_RATIO;
  const headroom = spec.headroomTokens ?? DEFAULT_COMPACTION_HEADROOM_TOKENS;
  const ratioCap = Math.floor(ratio * window);
  const reserve = spec.outputReserveTokens !== undefined && spec.outputReserveTokens > 0
    ? spec.outputReserveTokens
    : undefined;
  if (reserve === undefined) return ratioCap;
  const pressureBudget = window - reserve - headroom;
  return Math.max(COMPACTION_THRESHOLD_FLOOR_TOKENS, Math.min(ratioCap, pressureBudget));
}
