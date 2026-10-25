// 拆分运动 C：从 compaction.ts 原样外提的摘要调用域
//（M24 暖前缀重放 summarizeSpan、M58 §C#2 指令编织、ω99-45 协作中止助手）。
// 调研引入弧 A（research-import-2026-10）：A2 reasoning 不进摘要输入 +
// A3 Outstanding Work 节（prime-agent 压缩弧 + pi 压缩弧），见下方分节。
import type { AgentMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import type { ModelClient } from "./model-client.js";
import { messageCharLength } from "./compaction-estimation.js";

/** The full request construction for a warm-replay summary call (M24). */
export interface SummaryReplayInput {
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolDefinition[];
  readonly messages: readonly AgentMessage[];
  /** M58 §C#2: the focus phrase woven into the trailing instruction. */
  readonly focus?: string;
  /** M58 §C#2: standing compact instructions woven into the instruction. */
  readonly compactInstructions?: string;
  /** 113-B1 (prime-agent #2385 形): the kept-tail recency anchor — the
   *  latest retained assistant text, woven into the instruction's TAIL so
   *  the summary describes the world the kept messages live in (the summary
   *  alone only ever sees the compacted span). The replayed prefix above the
   *  instruction is untouched — cache cost zero. */
  readonly recencyAnchor?: string;
  /** 125 项 1（codex new_context 形）: the agent-rotation context — WHY the
   *  model rotated plus the facts it demanded survive (preserve). Woven into
   *  the instruction's TAIL beside the focus/anchor riders (cache cost zero).
   *  The preserve block ALSO rides the frozen summary message verbatim
   *  (compaction-riders preserveSection) — this hint asks the summarizer to
   *  WEAVE the facts into the narrative; that block is the survival
   *  guarantee. */
  readonly agentRotation?: { readonly rationale: string; readonly preserve?: string };
  /** M58 §C#12: per-request reasoning_effort override. */
  readonly reasoningEffort?: string;
  /** 调研引入弧 A3（prime-agent #3685 形）: the outstanding-work inventory —
   *  running subagents / background bash handles / active timers, rendered as
   *  a byte-stable "## Outstanding Work" section at the END of the summary
   *  instruction (tail bytes only, never the system prompt). Absent or empty
   *  leaves the instruction byte-identical to the status quo. The compaction
   *  callers do not yet thread this state — wiring is a later arc; this is
   *  the seam. */
  readonly outstandingWork?: readonly OutstandingWorkItem[];
}

// The summarizer input cap, applied to the replayed span only. The cut lands
// at the replay TAIL — everything before it stays byte-identical to the
// conversation being compacted, so the prefix cache keeps hitting.
const SUMMARY_SPAN_CAP_CHARS = 24000;

// ---------------------------------------------------------------------------
// 调研引入弧 A2（pi 压缩弧事故根因，research-import-2026-10）——
// reasoning/thinking 内容绝不进摘要输入。
//
// pi 的事故：摘要请求把历史里的 thinking 块原样重放，996K 的上下文被压缩成
// 1.38M 的摘要请求——摘要调用比它要压缩的上下文还大。wudao 的对应面：
// AssistantMessage.reasoning 是 M47 回放契约的字段（reasoningReplay 开启的
// provider 会把它序列化回 wire），摘要 replay 若不剥它，replay-on 会话的
// 摘要输入就按 reasoning 字节数膨胀。
//
// 缓存代价声明（M24 纪律）：默认配置（reasoningReplay: "never"，缺省）下
// 请求字节零变化；replay-on 的 provider 上，摘要前缀在第一条带 reasoning
// 的 assistant 处偏离父请求暖前缀——这是声明的、有意的冷转：A2 的「摘要
// 输入不含 reasoning」位阶高于暖前缀重放，代价是那一转的缓存重算，补偿
// 是摘要请求不再随 reasoning 字节膨胀（可以超过 span 本身）。
// 模型可见历史仍含 reasoning（回放契约不动）；只有摘要输入剥它。
// ---------------------------------------------------------------------------

/** A2: 剥掉消息列表里 assistant 消息的 reasoning 字段——摘要输入的确定性
 *  投影。纯函数：不带 reasoning 的消息原引用直通（状态 quo 字节），带
 *  reasoning 的只去那一个字段（content/toolCalls/stopReason 等原样）。 */
export function stripReasoningForSummary(messages: readonly AgentMessage[]): AgentMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || m.reasoning === undefined) return m;
    const { reasoning: _dropped, ...rest } = m;
    return rest;
  });
}

// ---------------------------------------------------------------------------
// ω99-45 — cooperative abort through the compaction pipeline. The summarizer
// is the pipeline's only long step; a user cancel (TUI Esc / WS interrupt /
// headless signal) must CANCEL it, never degrade it: the static fallback
// exists for a DOWN provider, and running it after an abort would be MORE
// work exactly when the user asked for LESS (pi findings C2). Abort-shaped
// errors propagate untouched; every other error keeps the M47 fallback
// semantics byte-for-byte. The signal is optional at every seam — absent
// means exactly today's behavior.
// ---------------------------------------------------------------------------

/** True when err carries the cooperative-abort shape (fetch's AbortError, the
 *  loop's abort race, any provider naming its cancellation the same way).
 *  借鉴弧 B2 收口：loop.ts 原私有的孪生识别器退役，两模块共用这一份
 *  （summarizer 不 import loop，无环）。 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Phase-boundary check: throw the AbortError sentinel when the signal has
 *  already fired. Called at compaction entry and after each awaited LLM leg —
 *  a summary that completed while the abort fired still never becomes a
 *  boundary. Same error shape the loop's abort race produces. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
  }
}

/** Ask the model to summarize the span — as a byte-level warm replay of the
 *  conversation it summarizes: the SAME system prompt + tool array + the
 *  span's messages, with one trailing user instruction. The compacted span
 *  is a leading slice of the last real request's message sequence, so this
 *  replay's leading bytes equal that request's leading bytes — the summary
 *  call rides the already-warm cache instead of paying a cold prefix. */
export async function summarizeSpan(
  input: SummaryReplayInput,
  model: ModelClient,
  signal?: AbortSignal,
): Promise<string> {
  // A2（pi 996K→1.38M 事故根因）: reasoning/thinking NEVER enters the
  // summary input — the strip runs BEFORE the cap loop, so the char budget
  // counts exactly what is sent (messageCharLength ignores reasoning either
  // way; the budget math is unchanged).
  const replayInput = stripReasoningForSummary(input.messages);
  // Keep messages from the head while the char budget lasts (always ≥1);
  // the drop happens at the tail, never the head (prefix preservation).
  const kept: AgentMessage[] = [];
  let chars = 0;
  for (const m of replayInput) {
    const len = messageCharLength(m);
    if (kept.length > 0 && chars + len > SUMMARY_SPAN_CAP_CHARS) break;
    kept.push(m);
    chars += len;
  }
  // Pairing safety: never END the replay on an assistant tool_call whose
  // results fell past the cap — drop such trailing messages wholesale.
  while (kept.length > 0) {
    const last = kept[kept.length - 1];
    if (last !== undefined && last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) kept.pop();
    else break;
  }
  const response = await model.generate({
    systemPrompt: input.systemPrompt,
    tools: input.tools,
    // M58 §C#2 + 113-B1: focus + standing compact instructions + the kept-tail
    // recency anchor are woven into the trailing instruction — TAIL bytes
    // only, the replayed prefix above them is untouched (cache-safe).
    // Empty/absent options leave the instruction byte-identical to the
    // status quo.
    messages: [...kept, {
      role: "user",
      content: summaryInstruction(input.focus, input.compactInstructions, input.recencyAnchor, input.agentRotation, input.outstandingWork),
    }],
    // M58 §C#12: the session's effort rides the summary request through the
    // per-request override (absent = the provider config's own effort).
    ...(input.reasoningEffort !== undefined && input.reasoningEffort !== "" ? { reasoningEffort: input.reasoningEffort } : {}),
    // M70 §3: the summarizer is a BACKGROUND call — nobody is blocking on the
    // summary, so the provider ladder's foreground-only retry allowlist bails
    // on overload instead of amplifying a capacity cascade.
    querySource: "summarizer",
    // ω99-45: cooperative cancellation rides the port's own signal field —
    // providers hand it to fetch (a real mid-flight cancel of the summary
    // call). Absent = today's request bytes, exactly.
    ...(signal !== undefined ? { signal } : {}),
  });
  return response.content.trim() || "(empty summary)";
}

/** The tier-2 summary instruction, with the optional M58 §C#2 riders and the
 *  113-B1 recency anchor woven in. The anchor rides LAST among the standing
 *  riders — it is the freshest fact in the request and must survive any later
 *  rider reorder. 125 项 1: the agent-rotation rider sits with the
 *  focus/instruction lines (BEFORE the anchor) — it explains why the model
 *  rotated and names the must-keep facts. 调研引入弧 A3: the Outstanding Work
 *  section rides at the very END (after the anchor) — the still-in-flight
 *  facts are the freshest of all and the section is absent byte-for-byte
 *  when the inventory is empty. */
function summaryInstruction(
  focus?: string,
  compactInstructions?: string,
  recencyAnchor?: string,
  agentRotation?: { readonly rationale: string; readonly preserve?: string },
  outstandingWork?: readonly OutstandingWorkItem[],
): string {
  const base = "Summarize the conversation above for continuation (max 300 words, preserving key facts, decisions, file paths, and open tasks). Always mention: the current in-progress todo item and the files currently being edited.";
  const focusLine = focus !== undefined && focus !== "" ? `\nFocus on: ${focus}` : "";
  const instructionsLine = compactInstructions !== undefined && compactInstructions !== "" ? `\nCompact instructions: ${compactInstructions}` : "";
  const flatRationale = agentRotation?.rationale.replace(/\s+/g, " ").trim() ?? "";
  const rotationLine = agentRotation !== undefined && flatRationale !== ""
    ? `\nContext rotation: the agent asked to start a fresh context window. Reason given: ${flatRationale}`
    : agentRotation !== undefined
      ? "\nContext rotation: the agent asked to start a fresh context window."
      : "";
  const preserveLine = agentRotation?.preserve !== undefined && agentRotation.preserve.trim() !== ""
    ? `\nThe agent marked these facts as MUST-KEEP across the rotation — include them in your summary:\n<agent-preserve>\n${agentRotation.preserve.trim()}\n</agent-preserve>`
    : "";
  const anchorLine = recencyAnchor !== undefined && recencyAnchor !== ""
    ? `\nRecent kept-context anchor (the newest message retained after the compacted span; the kept messages that follow this summary are NEWER than it and authoritative over it):\n<recent-state-anchor>\n${recencyAnchor}\n</recent-state-anchor>`
    : "";
  return base + focusLine + instructionsLine + rotationLine + preserveLine + anchorLine + renderOutstandingWork(outstandingWork ?? []);
}

// ---------------------------------------------------------------------------
// 调研引入弧 A3（prime-agent #3685 形）——摘要指令末尾的 Outstanding Work 节。
//
// prime 的事故面：压缩丢掉运行中编排状态（子代理/后台 bash/心跳），恢复后
// 的 agent 不知道还有活在飞。prime 把「## Outstanding Work」节织进结构化摘
// 要模板（含恢复指针）；wudao 的摘要指令是单行指令 + riders，本弧把节做成
// 末尾 rider：入参是结构化清单，渲染为字节稳定文本（排序确定——同类按
// id、同 id 按 note，跨引擎同字节）。缓存声明：节只随压缩边界的新请求字节
// 走，永不进 system prompt（prime 同律）；空清单不渲染（指令字节回到状态
// quo）。接线（谁把运行中状态喂进来）留给后续弧——本域只提供渲染。
// ---------------------------------------------------------------------------

/** A3: 一条未完成工作。kind 三类对齐 prime 的节模板：运行中子代理 /
 *  后台 bash 句柄 / 活跃定时器；id 是稳定标识（子代理 id / bash handle /
 *  定时器名），note 是一句话状态 + 恢复指引（prime 的 recovery pointer）。 */
export interface OutstandingWorkItem {
  readonly kind: "subagent" | "background_bash" | "timer";
  readonly id: string;
  readonly note: string;
}

/** A3: 节标题（渲染与测试共用的单一真值点）。 */
export const OUTSTANDING_WORK_HEADING = "## Outstanding Work";

// 确定序：kind 固定枚举序（子代理 → 后台 bash → 定时器），同类按 id 字典
// 序，同 id 按 note 字典序——任何 items 输入序都渲染出同一串字节。
const OUTSTANDING_KIND_ORDER: Readonly<Record<OutstandingWorkItem["kind"], number>> = {
  subagent: 0,
  background_bash: 1,
  timer: 2,
};
const OUTSTANDING_KIND_LABEL: Readonly<Record<OutstandingWorkItem["kind"], string>> = {
  subagent: "subagent",
  background_bash: "background bash",
  timer: "timer",
};

/** A3: 渲染 Outstanding Work 节——`\n## Outstanding Work\n- <kind> <id>:
 *  <note>` 每条一行，字节稳定（排序确定，见上）。空清单返回 ""（调用方
 *  拼接后指令字节与状态 quo 逐字节相同——空不渲染）。纯函数。 */
export function renderOutstandingWork(items: readonly OutstandingWorkItem[]): string {
  if (items.length === 0) return "";
  const sorted = [...items].sort((a, b) => {
    const byKind = OUTSTANDING_KIND_ORDER[a.kind] - OUTSTANDING_KIND_ORDER[b.kind];
    if (byKind !== 0) return byKind;
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.note !== b.note) return a.note < b.note ? -1 : 1;
    return 0;
  });
  const lines = sorted.map((i) => `- ${OUTSTANDING_KIND_LABEL[i.kind]} ${i.id}: ${i.note}`);
  return `\n${OUTSTANDING_WORK_HEADING}\n${lines.join("\n")}`;
}
