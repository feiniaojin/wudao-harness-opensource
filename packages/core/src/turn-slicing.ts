// 弧 C（research-import-2026-10，nanobot turn_continuation）— 预算切片续跑。
//
// maxTurns 的语义从「run 终点」升格为「切片边界」：模型上一停因是
// tool_use（还有活儿在推进）且 steering 队列空时，撞上限不硬停——注入
// 一条内部续跑消息作为下一片的首条输入，预算窗重置续跑；切片上限
// CONTINUATION_SLICE_CAP（12，nanobot _MAX_GOAL_CONTINUATION_ROUNDS 同
// 源），超限走既有 max_turns 硬停路径。与 nanobot 的语义差异见
// loop.ts 接线处注释（本文件只放纯函数；loop 拥有全部接线）。
//
// 缓存声明（M24）：切片是纯尾部追加——历史 append-only、续跑消息字节
// 固定（每片同文）、无任何前缀改写；切片不声明缓存代价。

import type { AgentMessage, UserMessage } from "./types.js";

/** 切片上限：一个 run 最多 12 条内部续跑消息（原 run + 12 个续跑片 =
 * 13 个预算窗；nanobot 的 12 轮 continuation rounds 语义）。超限走既有
 * max_turns 硬停路径。 */
export const CONTINUATION_SLICE_CAP = 12;

/** 撞迭代上限时的判定输入。lastStopReason 用 provider 停因词表（只有
 * "tool_use" 算「还有活儿」）；pendingSteers = 有已落地/待落地的用户
 * steer（steer 就是新的方向，见 C3）。 */
export interface FinalizeOnLimitInput {
  readonly lastStopReason: string;
  readonly pendingSteers: boolean;
}

/** 判定结果：恰好一真（slice ⇔ !finalize）。
 *  slice    = 不最终化——注入内部续跑消息，下一片继续干（省掉无工具
 *             最终化调用）；
 *  finalize = 最终化——end_turn（模型自己停了）或 pending steer 接管，
 *             不切片。 */
export interface FinalizeOnLimitVerdict {
  readonly finalize: boolean;
  readonly slice: boolean;
}

/** C1 分支矩阵（纯函数）：
 *  · tool_use 且无 pending steer → slice（不 finalize）；
 *  · 其余一切（end_turn、或 steer 在场）→ finalize（不 slice）。 */
export function shouldFinalizeOnLimit(input: FinalizeOnLimitInput): FinalizeOnLimitVerdict {
  if (input.lastStopReason === "tool_use" && !input.pendingSteers) {
    return { finalize: false, slice: true };
  }
  return { finalize: true, slice: false };
}

/** 从消息尾部回扫最近一条 assistant，归纳「上一停因」：带 toolCalls ⇒
 * "tool_use"（还有活儿）；否则用其持久化 stopReason（缺省 "end_turn"）。
 * 纯函数、确定性；供 loop 在切片边界调用（边界处的尾部通常是
 * [assistant(toolCalls), toolResults…] 形状）。 */
export function lastStopReasonOf(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "assistant") {
      if ((m.toolCalls?.length ?? 0) > 0) return "tool_use";
      return m.stopReason ?? "end_turn";
    }
  }
  return "end_turn";
}

/** 内部续跑消息的固定文本（[system note: …] 家族文案；字节固定——每片
 * 同文，前缀缓存友好）。对齐 nanobot 的 continuation prompt 语义：从当
 * 前上下文继续、不重跑已完成调用、收口时给最终答案、不向用户提及切片
 * 边界。 */
export const CONTINUATION_NOTE =
  "[system note: the turn reached its iteration budget with work still in progress. "
  + "Continue the task from the current context — do not repeat tool calls that already "
  + "completed; finish the remaining work and produce the final answer when done. "
  + "Do not mention this continuation boundary to the user.]";

/** 构造内部续跑消息（C1）。打标走 UserMessage 的持久化专用字段
 * internalContinuation（types.ts；同 uuid/stopReason 契约——永不进
 * wire）：显示层据此不渲染，持久层据此把这条消息改落类型化
 * continuation entry 而不是用户输入（nanobot 的 skip-user-persist 同义）。
 * sessionId 由驱动层透传（关联用，loop 自身不消费）；缺席则不打。 */
export function internalContinuationMessage(sessionId: string | undefined, sliceIndex: number): UserMessage {
  return {
    role: "user",
    content: CONTINUATION_NOTE,
    internalContinuation: { sliceIndex, ...(sessionId !== undefined ? { sessionId } : {}) },
  };
}

/** 显示层过滤谓词（纯函数）：internalContinuation 打标的 user 消息是内
 * 部续跑指令，web/cli 的 history 渲染不应把它当用户输入显示。 */
export function isInternalContinuation(m: AgentMessage): m is UserMessage {
  return m.role === "user" && m.internalContinuation !== undefined;
}

/** 硬停（非 goal）后，附加到下一条用户消息的 Runtime Context 块（C1）：
 * 告知模型上一 run 停在预算线、未完成工作仅在用户要求时恢复、勿盲目重
 * 跑已完成调用。由消费层（驱动）在硬停后的下一条用户提交上附加；文本
 * 风格对齐仓库现有 [system note: …] 运行期上下文块。
 *  limit    = 迭代上限（LoopOptions.maxTurns，逐片预算窗大小）；
 *  stoppedAt = 停机时的全局轮号（诚实口径：跨片累计的 turn 数）。 */
export function iterationLimitContextBlock(limit: number, stoppedAt: number): string {
  return `[system note: 上轮运行停在迭代上限 ${limit}（第 ${stoppedAt} 轮）；未完成的工作仅在用户要求时恢复；`
    + `恢复时勿盲目重跑已完成的工具调用——先从上下文确认哪些调用已完成、结果如何，再继续剩余工作。]`;
}

/** C2：切片的类型化 JSONL entry（一等 turn 记录）。骑 M35 §2 generic
 * entry 通道（{type, data}）append-only 落盘（ω99-48 AssistantAttemptEntry
 * 同款：类型即契约，store 无需 schema 变更；load() 的消息视图自然过滤，
 * loadSessionEntries() 的 entry 视图可见）。data 是切片落地的最小事实
 * 集——显示层据此渲染「预算切片 #N」而非消息本体。 */
export interface ContinuationMarkerEntry {
  readonly type: "continuation";
  readonly data: {
    /** 续跑片序号（1-based：第一条内部续跑消息 = 1）。 */
    readonly sliceIndex: number;
    /** 驱动层关联用（缺席 = 未关联）。 */
    readonly sessionId?: string;
    /** 切片落地的全局轮号。 */
    readonly turn: number;
    /** ISO 时刻（审计用；消息本体不带时间戳——字节固定）。 */
    readonly at: string;
  };
}

/** 构造类型化 marker entry（纯函数；at 由调用方传入保持可测）。 */
export function continuationMarkerEntry(
  sessionId: string | undefined,
  sliceIndex: number,
  turn: number,
  at: string,
): ContinuationMarkerEntry {
  return {
    type: "continuation",
    data: { sliceIndex, turn, at, ...(sessionId !== undefined ? { sessionId } : {}) },
  };
}
