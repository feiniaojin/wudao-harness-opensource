// 调研引入弧 B（2026-10 spec research-import）：缓存感知压缩调度 — core 纯
// 函数基座。三件：
//
//   B1 报告用量驱动触发（nanobot context_governance 形）——provider 报告的
//      usage 只有在「已测消息仍是当前请求的不变前缀」时才约束触发决策。
//      前缀指纹（单一 canonical serializer）做 O(1) 相等校验；fallback 改写
//      历史后调用方必须把 reportedTokens 置 undefined——旧计数不再约束下一
//      请求。
//   B2 触发耦合 cache-clock 分类（deepagents cache TTL 窗口 × 133 缓存时钟）
//      ——缓存将逝（expired/may_be_cold）窗口内压缩的边际成本最低：反正
//      回来要付全量重算，此刻改写历史不额外破缓存。compactionOpportunity
//      把「用量过线」与「时钟将逝」耦合成一个触发决策。
//   B3 未读大结果降级（nanobot 未读结果降级，413 前最后一级）——本轮新增、
//      尚未被任何 assistant 消息消化过的 read_file 类结果超预算时，按大小
//      降序替换为「分段重读」引导文本。纯函数只提供能力：模型可见==
//      持久化的责任在调用方（降级后的 messages 才是投影源）。
//
// M24 声明：本模块是纯函数，不碰任何请求字节；每个消费它的改写点（B2 接
// 线、B3 调用方）各自声明缓存代价与补偿。指纹用单一 canonical serializer
//（loop-safety 的 canonicalJson——120-a A2 的 ONE serializer 纪律），绝不
// 另造第二套键序。

import { canonicalJson } from "./loop-safety.js";
import type { AgentMessage, ToolResultMessage } from "./types.js";
import type { CacheClassification } from "./cache-clock.js";

// ---------------------------------------------------------------------------
// B1 — 前缀指纹 + 报告用量信任门
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit 单段（与 loop-safety 私有 hash 同族；两个不同种子拼出
 *  64-bit 面降低信任门的碰撞概率——一次错误采信 = 拿旧计数约束新请求）。 */
function fnv1a32(h: number, text: string): number {
  let acc = h >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    acc ^= text.charCodeAt(i);
    acc = Math.imul(acc, 0x01000193) >>> 0;
  }
  return acc >>> 0;
}

/** 对「已测消息前缀」——messages[0..upto)——算确定性指纹。
 *
 *  每条消息经 canonical serializer（键序稳定）后按索引折叠进双种子
 *  FNV-1a；返回 `<count>:<h1>.<h2>`（count 使不同长度前缀即使哈希撞车也
 *  可分辨；空前缀是稳定常量）。upto 越界钳到 [0, messages.length]，非有
 *  限值视为 0（防御直接调用方，不抛）。同一前缀永远同一指纹；前缀里任何
 *  一条消息变了一个字节、或前缀长度变了，指纹必变（canonical 键序保证
 *  「同内容不同键序」不会假阳性相等）。 */
export function usagePrefixFingerprint(messages: readonly AgentMessage[], upto: number): string {
  const n = Number.isFinite(upto) ? Math.min(messages.length, Math.max(0, Math.floor(upto))) : 0;
  let h1 = 0x811c9dc5;
  let h2 = 0x9dc5811c; // 第二种子：字节翻转的 0x811c9dc5（任意固定异种子）
  for (let i = 0; i < n; i += 1) {
    // 定界符钉住「索引 | 序列化」边界——不同切分绝不折出同一流。
    const part = `${i}\u0000${canonicalJson(messages[i]!)}\u0001`;
    h1 = fnv1a32(h1, part);
    h2 = fnv1a32(h2, part);
  }
  return `${n}:${h1.toString(36)}.${h2.toString(36)}`;
}

/** 报告用量信任门：指纹相等才采信。
 *
 *  三个先决全过才 true：报告值是正的有限数（0/NaN/undefined 无可信内
 *  容）；两个指纹都在场且非空；两指纹相等。任一不满足 → false（不采信，
 *  调用方回落估算值——绝不拿一个「可能描述别的前缀」的计数约束当前请
 *  求）。fallback 改写历史后调用方应直接传 reportedContextTokens:
 *  undefined，本门自然回 false。 */
export function shouldTrustUsage(
  reportedContextTokens: number | undefined,
  fingerprintAtReport: string | undefined,
  currentFingerprint: string | undefined,
): boolean {
  if (reportedContextTokens === undefined) return false;
  if (!Number.isFinite(reportedContextTokens) || reportedContextTokens <= 0) return false;
  if (fingerprintAtReport === undefined || currentFingerprint === undefined) return false;
  if (fingerprintAtReport === "" || currentFingerprint === "") return false;
  return fingerprintAtReport === currentFingerprint;
}

/** 触发决策的用量证据面：provider 报告值（经 shouldTrustUsage 才可信）
 *  与本地估算值并存——报告值准但只在指纹成立时有效，估算值永远在场。 */
export interface UsageEvidence {
  /** provider 报告的 promptTokens；fallback 改写后调用方必须传 undefined
   *  （旧计数不约束下一请求）。 */
  readonly reportedTokens?: number;
  /** shouldTrustUsage 的裁决。false = 一律用估算值。 */
  readonly trusted: boolean;
  readonly estimatedTokens: number;
}

/** thresholdDecision 的产出。 */
export interface ThresholdDecision {
  /** 参与比较的占用值（trusted 报告值或估算值）。 */
  readonly effectiveTokens: number;
  readonly source: "reported" | "estimated";
  /** effectiveTokens ≥ threshold。阈值非正/非有限 → false（破损触发线
   *  永不自动触发压缩——形状防御，resolver 本身有 1024 地板）。 */
  readonly over: boolean;
}

/** 用量驱动触发决策（纯阈值判断的替身）：trusted 用报告值，否则用估算
 *  值，与 threshold 比较。B1 的核心纪律落在两处：trusted 但 reportedTokens
 *  缺席（fallback 置空）自动降级到估算；非有限估算产出 over=false 的诚实
 *  拒答（NaN 比较全 false——不猜）。 */
export function thresholdDecision(input: UsageEvidence & { readonly threshold: number }): ThresholdDecision {
  const reportedUsable =
    input.trusted
    && input.reportedTokens !== undefined
    && Number.isFinite(input.reportedTokens)
    && input.reportedTokens > 0;
  const effectiveTokens = reportedUsable ? (input.reportedTokens as number) : input.estimatedTokens;
  const over =
    Number.isFinite(input.threshold)
    && input.threshold > 0
    && Number.isFinite(effectiveTokens)
    && effectiveTokens >= input.threshold;
  return { effectiveTokens, source: reportedUsable ? "reported" : "estimated", over };
}

// ---------------------------------------------------------------------------
// B2 — 触发耦合 cache-clock 分类
// ---------------------------------------------------------------------------

/** 缓存将逝软线缺省：threshold × 0.5。语义：将逝窗口内压缩边际成本最低，
 *  半水位即值得做免费层清理。接线侧可传更保守的显式软线（may_be_cold 不
 *  是 expired——「可能已冷」仍可能在暖，软线越贴近触发线赌注越小）。 */
export const DEFAULT_CACHE_DYING_SOFT_RATIO = 0.5;

/** compactionOpportunity 的产出。 */
export interface CompactionOpportunityDecision {
  readonly compactNow: boolean;
  /** usage_over = 采信后的占用已过触发线（与时钟无关——量到了就该压，
   *  这是 B1 报告用量驱动的触发面）；cache_dying = 占用过软线且时钟已入
   *  将逝窗口（此刻改写历史不额外破缓存——最优压缩时刻）；no = 两者皆
   *  否。判定序互斥：过线永远报 usage_over，cache_dying 只在未过线时才
   *  可达。 */
  readonly reason: "usage_over" | "cache_dying" | "no";
}

/** 缓存感知的压缩时机决策：thresholdDecision（用量过线）+ cache-clock
 *  分类（将逝窗口）耦合。判定序（互斥性来源）：
 *  1. thresholdDecision.over → { compactNow: true, reason: "usage_over" }；
 *  2. 时钟将逝 且 占用过软线 → { compactNow: true, reason: "cache_dying" }；
 *  3. 其余 → { compactNow: false, reason: "no" }。
 *
 *  「将逝」= confidence 为 expired/may_be_cold 且 reason 不是 age_unknown
 *  （identity_changed+expired 是确定性死亡——换模型后缓存必失效，改写免
 *  费；idle 过窗是时间证据；age_unknown 没有任何证据——T002 F7 纪律：时
 *  钟读不到时特性零行为差，不赌）。warm 永不算将逝。软线缺省
 *  floor(threshold × DEFAULT_CACHE_DYING_SOFT_RATIO)，opts.softThresholdTokens
 *  显式覆盖。 */
export function compactionOpportunity(
  clock: CacheClassification,
  usage: UsageEvidence,
  threshold: number,
  opts?: { readonly softThresholdTokens?: number },
): CompactionOpportunityDecision {
  const decision = thresholdDecision({ ...usage, threshold });
  if (decision.over) return { compactNow: true, reason: "usage_over" };
  const dying =
    (clock.confidence === "expired" || clock.confidence === "may_be_cold")
    && clock.reason !== "age_unknown";
  if (!dying) return { compactNow: false, reason: "no" };
  const soft =
    opts?.softThresholdTokens !== undefined
    && Number.isFinite(opts.softThresholdTokens)
    && opts.softThresholdTokens > 0
      ? opts.softThresholdTokens
      : Math.floor(threshold * DEFAULT_CACHE_DYING_SOFT_RATIO);
  if (Number.isFinite(decision.effectiveTokens) && decision.effectiveTokens >= soft) {
    return { compactNow: true, reason: "cache_dying" };
  }
  return { compactNow: false, reason: "no" };
}

// ---------------------------------------------------------------------------
// B3 — 未读大结果降级（413 前最后一级）
// ---------------------------------------------------------------------------

/** 降级桩的前缀（幂等标记：已是桩的结果不再列为候选）。 */
export const PENDING_READ_DOWNGRADE_PREFIX = "[pending read downgraded:";

/** 「read_file 类」结果的缺省判定集：内置读工具的单名集合。调用方可用
 *  options.readToolNames 扩展（如 session_result 回读面）。 */
export const DEFAULT_PENDING_READ_TOOL_NAMES: readonly string[] = ["read_file"];

/** 单条降级桩文本（含原始大小——模型需要知道丢了多大的东西才能决定是否
 *  分段重读）。确定性：同输入同输出。 */
export function formatPendingReadDowngrade(originalChars: number): string {
  return `[pending read downgraded: a read_file result of ~${originalChars} chars was withheld to fit the pending-read budget — re-read the file in segments with read_file offset/limit when you need it; do not assume its content]`;
}

/** 一次降级的收据：被替换消息在原数组的索引 + 原文 chars（按替换顺序——
 *  大小降序——排列，调用方据此落台账）。 */
export interface PendingReadDowngrade {
  readonly index: number;
  readonly originalChars: number;
}

/** 未读大结果降级（纯函数）。
 *
 *  「未读」语义（spec 的近似实现）：最后一条 assistant 消息之后的所有
 *  tool 结果——它们回答的是该 assistant 的 tool_use、且尚无任何后续
 *  assistant 消息消化过（turn 边界内最新一轮的 read_file 类结果）。settled
 *  尾（最后一条就是 assistant）没有未读面 → 原样归还。
 *
 *  预算（chars）按候选结果 content 长度之和计；超预算时按大小降序（同大
 *  小按索引升序——确定性）逐个替换为「分段重读」引导桩，直到回到预算内
 *  或候选耗尽。桩不小于原文的候选跳过（替换只会更大——无净收益）。预算
 *  内 / 无未读 / 无可替换 → 原数组引用原样归还（downgraded 空）。
 *
 *  模型可见==持久化的责任在调用方：降级后的 messages 才是投影源与落盘
 *  源——本函数只提供能力，不替调用方决定投影面。 */
export function degradePendingReads(
  messages: readonly AgentMessage[],
  budget: number,
  options?: { readonly readToolNames?: readonly string[] },
): { readonly downgraded: readonly PendingReadDowngrade[]; readonly messages: readonly AgentMessage[] } {
  // 破损预算（NaN/Infinity）不猜：按现状不动（fail-open，绝不全量降级）。
  if (!Number.isFinite(budget)) return { downgraded: [], messages };
  const cap = Math.max(0, budget);
  const names = options?.readToolNames ?? DEFAULT_PENDING_READ_TOOL_NAMES;

  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }
  if (lastAssistant < 0) return { downgraded: [], messages };

  const candidates: { index: number; chars: number }[] = [];
  for (let i = lastAssistant + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "tool" || m.isError === true) continue;
    if (!names.includes(m.name)) continue;
    const content = m.content;
    if (content.length === 0 || content.startsWith(PENDING_READ_DOWNGRADE_PREFIX)) continue; // 幂等
    candidates.push({ index: i, chars: content.length });
  }
  let total = candidates.reduce((n, c) => n + c.chars, 0);
  if (total <= cap) return { downgraded: [], messages }; // 预算内不动

  candidates.sort((a, b) => b.chars - a.chars || a.index - b.index);
  const out: AgentMessage[] = [...messages];
  const downgraded: PendingReadDowngrade[] = [];
  for (const c of candidates) {
    if (total <= cap) break;
    const m = out[c.index] as ToolResultMessage;
    const stub = formatPendingReadDowngrade(c.chars);
    if (stub.length >= c.chars) continue; // 桩不小于原文 → 替换无净收益
    out[c.index] = { ...m, content: stub };
    total -= c.chars - stub.length;
    downgraded.push({ index: c.index, originalChars: c.chars });
  }
  if (downgraded.length === 0) return { downgraded: [], messages };
  return { downgraded, messages: out };
}
