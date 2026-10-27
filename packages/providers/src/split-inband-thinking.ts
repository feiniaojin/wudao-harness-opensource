import { resolveReasoningContext, type ProviderConfig } from "./config.js";

// 夜移 011 (DeepSeek-Reasonix internal/provider/openai/think.go:18-98): the
// in-band `<think>` splitter. vLLM chat-template lanes (`qwen-chat-template`
// format — `chat_template_kwargs.enable_thinking`) inline the model's CoT
// into the CONTENT channel as a turn-initial `<think>…</think>` block instead
// of a separate reasoning field. Without peeling, that CoT pollutes the
// assistant content — it replays forever, immune to the reasoning-replay
// contract (夜移 011's whole point), and double-bills every turn after the
// first. The machine routes the block into the reasoning channel, where the
// existing replay/effort machinery governs it like native reasoning.
//
// Three rules, straight from Reasonix:
//   1. ARMED ONLY AT TURN START — a `<think>` mentioned mid-prose (docs,
//      code about think tags) is never hijacked; only a block at the very
//      beginning of the content stream peels.
//   2. DELTA-BOUNDARY HOLDBACK — either tag can straddle SSE deltas
//      (`…</th` + `ink>…`); the longest marker-prefix suffix is held back
//      until the next delta resolves it, so no tag fragment ever leaks into
//      either channel.
//   3. UNTERMINATED BLOCK = REASONING TO THE END — a stream that dies inside
//      an open think block classifies everything it emitted as reasoning
//      (never silently drops, never dumps CoT into content).

const OPEN_TAG = "<think>";
const CLOSE_TAG = "</think>";

/** One push's classification: absent keys carry nothing (never ""). */
export interface SplitOutput {
  readonly reasoning?: string;
  readonly content?: string;
}

/** Longest suffix of `s` that is a PROPER prefix of `marker` ("" if none) —
 *  the holdback rule. A full marker is not held (it IS the tag; the caller
 *  consumes it), and `s` itself shorter than the marker can be held whole. */
function heldPrefix(s: string, marker: string): string {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return s.slice(s.length - k);
  }
  return "";
}

/** The pure streaming state machine. Not tied to SSE, fetch, or config —
 *  feed content deltas, get classifications, call finish() once at stream
 *  end. Single-turn: one instance per assistant turn (loop resets per call). */
export class InbandThinkSplitter {
  private state: "seeking" | "reasoning" | "content" = "seeking";
  private held = "";
  private finished = false;

  push(delta: string): SplitOutput {
    if (delta === "" || this.finished) return {};
    this.held += delta;
    if (this.state === "seeking") return this.stepSeeking();
    if (this.state === "reasoning") return this.stepReasoning();
    return { content: this.take() };
  }

  /** Stream end: flush what the holdback still owes. Seeking-held bytes were
   *  never a tag → content; reasoning-held bytes (including a dangling
   *  close-tag prefix) → reasoning (the unterminated-block rule). */
  finish(): SplitOutput {
    if (this.finished) return {};
    this.finished = true;
    if (this.held === "") return {};
    if (this.state === "reasoning") return { reasoning: this.take() };
    return { content: this.take() };
  }

  private take(): string {
    const out = this.held;
    this.held = "";
    return out;
  }

  /** Turn start: decide armed-or-not. Leading whitespace is template
   *  artifact — held (and swallowed) while a tag might still follow,
   *  flushed as content the moment real prose arrives. */
  private stepSeeking(): SplitOutput {
    const idx = this.held.search(/\S/);
    if (idx === -1) return {}; // whitespace only — cannot decide yet
    const rest = this.held.slice(idx);
    if (rest.startsWith(OPEN_TAG)) {
      this.state = "reasoning";
      this.held = rest.slice(OPEN_TAG.length);
      return this.stepReasoning();
    }
    if (OPEN_TAG.startsWith(rest)) return {}; // still could become the open tag
    this.state = "content";
    return { content: this.take() }; // prose (or a partial that can't be the tag)
  }

  /** Inside the block: everything up to `</think>` is reasoning; a possible
   *  straddling close-tag prefix is held back for the next delta. */
  private stepReasoning(): SplitOutput {
    const close = this.held.indexOf(CLOSE_TAG);
    if (close >= 0) {
      const before = this.held.slice(0, close);
      this.held = this.held.slice(close + CLOSE_TAG.length);
      this.state = "content";
      // Remainder after the tag is content — but it might itself end in a
      // partial NOTHING (content state has no markers), so emit it directly.
      const after = this.take();
      return { ...(before !== "" ? { reasoning: before } : {}), ...(after !== "" ? { content: after } : {}) };
    }
    const hold = heldPrefix(this.held, CLOSE_TAG);
    const emit = this.held.slice(0, this.held.length - hold.length);
    this.held = hold;
    return emit !== "" ? { reasoning: emit } : {};
  }
}

/** 夜移 011: whether this config's content stream needs the in-band peel.
 *  The `qwen-chat-template` format IS the vLLM inline-CoT lane — selecting
 *  it turns the splitter on with no extra knob. An explicit
 *  `splitInbandThinking` beats the format default in both directions (a
 *  misbehaving gateway on another format can opt in; a qwen-chat-template
 *  deployment that reports reasoning properly can opt out). */
export function resolveSplitInbandThinking(config: ProviderConfig): boolean {
  return config.splitInbandThinking ?? resolveReasoningContext(config).format === "qwen-chat-template";
}
