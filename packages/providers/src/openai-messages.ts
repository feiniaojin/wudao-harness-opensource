// 拆分运动 C：从 openai-compatible.ts 原样外提的 openai-chat 消息序列化域
//（OOM 累计上限、M47 reasoning 回放、ω-1a id 还原、M24 canonical prompt）。
// 纯函数模块：零包内依赖（config 类型 + tool-call-ids 除外），无环。
import type { FileBlock, ImageBlock, ModelInput } from "@wudao-org/core";
import { truncateSafe } from "@wudao-org/core";
import type { ReasoningReplay } from "./config.js";
import { restoreToolCallId, restoreToolCallIds } from "./tool-call-ids.js";

// OOM fix: per-response accumulation caps. A degenerate endpoint (or an
// adversarial stream) can pump unbounded reasoning/content/argument bytes
// into a single response; every accumulator is capped so no downstream
// consumer (driver live state, history, persistence) can ever hold an
// unbounded per-response string. 2M chars ≈ the largest legitimate response
// by an order of magnitude; truncation is always marked.
export const MAX_ACCUM_CHARS = 2_000_000;
export const TRUNCATED_MARK = "[truncated at 2M chars]";

/** Cap a finished accumulator: truncate at the cap and append the marker. */
export function capAccumulated(s: string): string {
  return s.length > MAX_ACCUM_CHARS ? truncateSafe(s, MAX_ACCUM_CHARS) + TRUNCATED_MARK : s; // 113-A4
}

/** ω-2a: is this reasoning string a tail the CLIENT truncated at the
 *  accumulator cap? The in-band marker is the truncation signal (every cap
 *  site appends exactly it) — a reasoning string ending in it is incomplete
 *  by construction and must never be treated as a complete tail. */
export function isCappedReasoning(reasoning: string | undefined): boolean {
  return reasoning !== undefined && reasoning.endsWith(TRUNCATED_MARK);
}

/** M47 §1: does this assistant message's stored reasoning ride back out?
 *  Byte discipline: the value is passed through VERBATIM — never trimmed,
 *  never reformatted — so the replayed bytes equal the stored bytes. */
function replayReasoning(m: Extract<ModelInput["messages"][number], { role: "assistant" }>, replay: ReasoningReplay): string | undefined {
  if (replay === "never" || m.reasoning === undefined) return undefined;
  // ω-2a: a client-capped tail is incomplete — never replayed as complete.
  // Omitting the optional reasoning_content keeps the request wire-valid
  // (the pre-M47 shape every "never"-mode session already sends).
  if (isCappedReasoning(m.reasoning)) return undefined;
  if (replay === "always") return m.reasoning;
  // toolCallTurns: only the turns that carry tool calls (CLAUDE.md §4.4).
  return m.toolCalls !== undefined && m.toolCalls.length > 0 ? m.reasoning : undefined;
}

export function toOpenAIMessage(m: ModelInput["messages"][number], replay: ReasoningReplay = "never") {
  switch (m.role) {
    case "user":
      return { role: "user", content: m.content };
    case "assistant": {
      const reasoning = replayReasoning(m, replay);
      return {
        role: "assistant",
        content: m.content,
        // ω-1a: the stored ids may carry the dedupe's `#n` suffix — the wire
        // gets the provider-native shape back (real ids strip to themselves).
        ...(m.toolCalls && m.toolCalls.length > 0
          ? { tool_calls: restoreToolCallIds(m.toolCalls).map((tc) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } })) }
          : {}),
        // Appended AFTER the pinned fields: the default (never) request bytes
        // are unchanged, and an enabled replay only grows the message tail.
        ...(reasoning !== undefined ? { reasoning_content: reasoning } : {}),
      };
    }
    case "tool":
      // ω-1a: tool_result ids restore in lockstep with the assistant calls
      // they answer (a stripped call with a suffixed result would 400).
      return { role: "tool", tool_call_id: restoreToolCallId(m.toolCallId, m.name), content: m.content };
  }
}

// ---------------------------------------------------------------------------
// Canonical prompt serialization (M24).
//
// serializePrompt is THE one serializer every byte-prefix assertion uses
// (det-06, fork prefix sharing, CLI miss attribution) — nowhere else may a
// hand-rolled comparison live. Shape:
//   - one JSON line per segment, each terminated by "\n";
//   - stable header FIRST (system line, then one line per tool), messages
//     after — mirroring where the prompt bytes actually diverge: appending a
//     message (append-only growth) only ever APPENDS bytes at the tail, so
//     request N's serialization is a byte-prefix of request N+1's whenever
//     the history grew append-only and the header stayed frozen;
//   - canonical key order (recursive sort) — the caller's insertion order
//     never leaks into the bytes.
// ---------------------------------------------------------------------------

/** JSON with recursively sorted object keys (arrays keep their order). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** M79: the CANONICAL (durable) form of one message. Image-bearing turns
 *  serialize their REFS — the transient data URL never appears here (it
 *  exists only inside one request build, and never in a byte-pin). Text-only
 *  turns return exactly toOpenAIMessage's shape, so every pre-M79 golden
 *  byte is unchanged. ω99-55: FILE-bearing user turns pin their blocks
 *  (same durable discipline — without this, a file turn and a text turn
 *  with equal content would pin identical bytes and the pin would lose the
 *  file identity; the projected handle is derived text, versioned by the
 *  projection, and rides only the wire). */
function canonicalMessage(m: ModelInput["messages"][number]): unknown {
  const imgs = (m as { images?: readonly ImageBlock[] }).images;
  const files = m.role === "user" ? (m as { files?: readonly FileBlock[] }).files : undefined;
  const hasImgs = Array.isArray(imgs) && imgs.length > 0;
  const hasFiles = Array.isArray(files) && files.length > 0;
  if (hasImgs || hasFiles) {
    if (m.role === "user") {
      return {
        role: "user",
        content: m.content,
        ...(hasImgs ? { images: imgs } : {}),
        ...(hasFiles ? { files } : {}),
      };
    }
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content, images: imgs };
  }
  return toOpenAIMessage(m);
}

/** Deterministic byte serialization of a ModelInput's prompt content. NOTE
 *  (M47 §1): this pins the message SET (system+tools+messages) — the
 *  reasoning_replay field is provider-config-side and rides the wire only when
 *  `reasoningReplay` is enabled; its wire-shape pins live in the replay tests
 *  (raw request bodies), not here. M79: image-bearing turns pin their
 *  ImageAttachmentRefs (durable form); a text-only session's bytes are
 *  IDENTICAL to pre-M79. */
export function serializePrompt(input: ModelInput): string {
  const lines: string[] = [canonicalJson({ role: "system", content: input.systemPrompt })];
  for (const t of input.tools) {
    lines.push(
      canonicalJson({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }),
    );
  }
  for (const m of input.messages) {
    lines.push(canonicalJson(canonicalMessage(m)));
  }
  return lines.map((l) => `${l}\n`).join("");
}
