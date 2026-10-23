// M49 §4 — tool-result taint (langroid). Tool results carrying user-provided
// file content (read_file: provenance "user-file") or external-server content
// (MCP: "mcp") get a TAINT BIT in the frontend's message metadata — a WeakMap
// SIDE CHANNEL keyed by the ToolResultMessage objects themselves, so nothing
// rides the wire or the persisted JSONL (core messages stay untouched; the
// taint survives only as long as the message objects do).
//
// Repackaging preservation: when a tool result EMBEDS verbatim a known tainted
// result's content (a Pass/Forward-shaped tool re-shipping it), the wrapper
// inherits the taint automatically — substring match against a bounded ring of
// recorded excerpts. Honest limit (spec): taint CANNOT cross model generation
// — an assistant message quoting a tainted file is model output, not tainted
// content; only verbatim carriage propagates.
//
// Consumer: the auto-mode sidecar's classifier input. When a gated tool call's
// ARGUMENTS embed recorded tainted content (e.g. the model copying file-borne
// "instructions" into a shell), the sidecar layer tags the classifier
// input [untrusted] (sidecar.ts) so embedded instructions read as data.
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import type { ToolResultMessage } from "@wudao/core";

/** Excerpts shorter than this never match (trivial substrings are noise). */
const EXCERPT_MIN_CHARS = 24;
/** The bounded ring of recorded tainted excerpts (last N results). */
const EXCERPT_LIMIT = 32;

export interface TaintExcerpt {
  readonly toolCallId: string;
  readonly source: string;
  readonly excerpt: string;
}

export interface TaintTracker {
  /** Record one finished tool result: mark the message object (WeakMap) with
   *  its source, or the INHERITED source when the content re-packages a
   *  known tainted excerpt (Pass/Forward propagation). Returns the effective
   *  source (undefined = untainted). */
  record(message: ToolResultMessage, provenance: string | undefined): string | undefined;
  /** The taint source of a message object (undefined = untainted). */
  sourceOf(message: object): string | undefined;
  /** The recorded excerpt ring (diagnostics / tests). */
  excerpts(): readonly TaintExcerpt[];
  /** True when serialized tool ARGUMENTS embed any recorded tainted excerpt;
   *  returns the first matching source. */
  probeArgs(serializedArgs: string): string | undefined;
}

function excerptOf(content: string): string {
  // Record a bounded middle window — enough to match verbatim re-packaging,
  // never enough to balloon memory. Skip error results (harness text).
  if (content.length <= 200) return content.trim();
  const head = truncateSafe(content, 120);
  const tail = truncateTailSafe(content, 80);
  return `${head}…${tail}`;
}

/** The JSON-string form of an excerpt (escaped newlines/quotes) — tool args
 *  reach the probe as serialized JSON, where a raw newline became \n. */
function jsonEscaped(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

export function createTaintTracker(): TaintTracker {
  // The side channel: message object → taint source. Weak so it can never
  // leak a transcript (compaction dropping a message drops its taint too).
  const taints = new WeakMap<object, string>();
  const ring: TaintExcerpt[] = [];

  return {
    record(message, provenance) {
      // Inheritance first: content embedding a known tainted excerpt is
      // tainted even when its own tool reported no provenance.
      let source = provenance;
      if (source === undefined && message.isError !== true && message.content.length > 0) {
        for (const e of ring) {
          if (e.excerpt.length >= EXCERPT_MIN_CHARS && message.content.includes(e.excerpt)) {
            source = e.source;
            break;
          }
        }
      }
      if (source === undefined) return undefined;
      taints.set(message, source);
      if (message.isError !== true && provenance !== undefined && message.content.length > 0) {
        ring.push({ toolCallId: message.toolCallId, source, excerpt: excerptOf(message.content) });
        if (ring.length > EXCERPT_LIMIT) ring.shift();
      }
      return source;
    },
    sourceOf(message) {
      return taints.get(message);
    },
    excerpts() {
      return [...ring];
    },
    probeArgs(serializedArgs) {
      for (const e of ring) {
        if (e.excerpt.length < EXCERPT_MIN_CHARS) continue;
        if (serializedArgs.includes(e.excerpt) || serializedArgs.includes(jsonEscaped(e.excerpt))) {
          return e.source;
        }
      }
      return undefined;
    },
  };
}

/** Serialize tool arguments the way the sidecar's canonical JSON would, for
 *  probing (a stable, total serialization — never throws). */
export function serializeArgs(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/** The shared consumer helper: does THIS gated tool call embed tainted
 *  content in its arguments? (The sidecar layer calls it before classify.) */
export function argsCarryTaint(
  tracker: TaintTracker,
  input: Record<string, unknown>,
): string | undefined {
  return tracker.probeArgs(serializeArgs(input));
}
