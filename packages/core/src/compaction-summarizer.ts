// 拆分运动 C：从 compaction.ts 原样外提的摘要调用域
//（M24 暖前缀重放 summarizeSpan、M58 §C#2 指令编织、ω99-45 协作中止助手）。
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
}

// The summarizer input cap, applied to the replayed span only. The cut lands
// at the replay TAIL — everything before it stays byte-identical to the
// conversation being compacted, so the prefix cache keeps hitting.
const SUMMARY_SPAN_CAP_CHARS = 24000;

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
  // Keep messages from the head while the char budget lasts (always ≥1);
  // the drop happens at the tail, never the head (prefix preservation).
  const kept: AgentMessage[] = [];
  let chars = 0;
  for (const m of input.messages) {
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
      content: summaryInstruction(input.focus, input.compactInstructions, input.recencyAnchor, input.agentRotation),
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
 *  113-B1 recency anchor woven in. The anchor rides LAST — it is the freshest
 *  fact in the request and must survive any later rider reorder. 125 项 1:
 *  the agent-rotation rider sits with the focus/instruction lines (BEFORE the
 *  anchor) — it explains why the model rotated and names the must-keep facts. */
function summaryInstruction(
  focus?: string,
  compactInstructions?: string,
  recencyAnchor?: string,
  agentRotation?: { readonly rationale: string; readonly preserve?: string },
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
  return base + focusLine + instructionsLine + rotationLine + preserveLine + anchorLine;
}
