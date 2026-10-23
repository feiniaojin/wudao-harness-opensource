// 拆分运动 C：从 compaction.ts 原样外提的冻结标记 + 保留目标域
//（tier-0/1/2 全部冻结标记常量、ω-2b 保留目标、M48 §3 skill 标记、
// M58 §C#3 thrash 断路器、capToLineBoundary 共享文本帽）。包内依赖仅
// 113-A4 引入的 text-truncate（叶子模块，零依赖，无环）。
import type { Tool } from "./tool.js";
import { truncateSafe } from "./text-truncate.js";

export const COMPACTION_STUB_PREFIX = "[compacted";

// ---------------------------------------------------------------------------
// ω-2b (I2-a) — per-tool retention targeting (Strands OffloadTarget, minus
// the string DSL). The cheap tiers may be told WHICH tools' results they may
// stub/clear: an include list (ONLY those), an exclude list (everything but
// those), or neither (the status quo — every tool result is a candidate).
// Eligibility is a PURE function of the tool name riding ToolResultMessage,
// so stub bytes stay a pure function of history (cache-stable, re-derivable
// on resume).
// ---------------------------------------------------------------------------

/** Which tools' results the cheap compaction tiers may touch. */
export interface RetentionTarget {
  /** When set: ONLY these tool names are eligible (the include set wins). */
  readonly include?: readonly string[];
  /** Otherwise: these tool names are exempt from tier-0/1. */
  readonly exclude?: readonly string[];
}

/** Pure: does this tool name fall inside the retention target? No filter =
 *  match (status quo); an include set wins over an exclude list; an empty
 *  include list matches nothing. */
export function matchesRetention(toolName: string, t?: RetentionTarget): boolean {
  if (t === undefined) return true;
  if (t.include !== undefined) return t.include.includes(toolName);
  if (t.exclude !== undefined) return !t.exclude.includes(toolName);
  return true;
}

/** ω-2b (I2-a): the CLI-built retention target — the exclude set of every
 *  tool that declared `compactionExempt` (its results must survive tier-0/1).
 *  Undefined when no tool is exempt (byte-identical options, status quo). */
export function compactionRetentionFor(tools: readonly Tool[]): RetentionTarget | undefined {
  const excluded = tools.filter((t) => t.compactionExempt === true).map((t) => t.name);
  return excluded.length > 0 ? { exclude: excluded } : undefined;
}

export interface MicrocompactOptions {
  /** Don't stub the last N messages (the active working set). Default 6. */
  readonly keepRecent?: number;
  /** Only stub tool results longer than this many chars. Default 1000. */
  readonly minChars?: number;
  /** M48 §3: known skill reads — a stubbed skill-read result becomes the
   *  canonical [SKILL_PRUNED: …] marker instead of the generic stub. */
  readonly skillReads?: SkillReadMap;
  /** ω-2b (I2-a): per-tool retention — only matching tools' results are
   *  stubbed (see matchesRetention). Absent = every tool (status quo). */
  readonly retention?: RetentionTarget;
}

// ---------------------------------------------------------------------------
// M48 §3 — ghost-skill markers (hermes). A skill the model loaded via
// read_file whose message later falls into a compaction span would silently
// vanish: the agent stops obeying the skill with no signal why. Every tier
// now swaps a pruned skill-read tool result for the canonical marker (the
// reload instruction), and tier 2 re-injects one marker per distinct skill
// right after the summary — the M23 board-restore shape.
// ---------------------------------------------------------------------------

/** Marker prefix; pruned messages lead with it (parseSkillPrunedMarker). */
export const SKILL_PRUNED_PREFIX = "[SKILL_PRUNED:";

/** The canonical replacement text for one pruned skill read. */
export function formatSkillPrunedMarker(name: string, path: string): string {
  return `[SKILL_PRUNED: ${name} — reload with read_file ${path}]`;
}

// M58 §C#11 — hybrid skill reinjection. Markers alone (M48 §3) tell the
// model a skill exists but not what it said, so post-compaction the agent
// re-derails on the skill it was just following. Tier 2 now re-injects the
// BODY of the most recent distinct invoked skill (head-capped at 5000 chars
// with the line-boundary backoff) as a NEW message at the compact boundary;
// every older distinct skill keeps its [SKILL_PRUNED] marker. The M48 rule
// that a marker is never re-processed still holds: the reinjected body is
// ordinary context (part of the next span if a later compaction fires).

/** Marker prefix of the re-injected skill body message. */
export const SKILL_REINJECTED_PREFIX = "[SKILL_REINJECTED:";

/** Head cap on a re-injected skill body (chars, line-boundary backoff). */
export const SKILL_REINJECT_CAP_CHARS = 5_000;

/** The re-injected body message content: header line + capped head of the
 *  body (capToLineBoundary — never cuts mid-line). */
export function formatSkillReinjectedBody(name: string, path: string, body: string): string {
  return `${SKILL_REINJECTED_PREFIX} ${name} — skill body reloaded from read_file ${path}]\n${capToLineBoundary(body, SKILL_REINJECT_CAP_CHARS)}`;
}

/** Parse a message that IS a marker; undefined for anything else. */
export function parseSkillPrunedMarker(content: string): { name: string; path: string } | undefined {
  const m = /^\[SKILL_PRUNED: (.+?) — reload with read_file (.+?)\]$/.exec(content);
  return m === null ? undefined : { name: m[1] ?? "", path: m[2] ?? "" };
}

/** A known skill read: toolCallId → what to reload. */
export type SkillReadMap = ReadonlyMap<string, { readonly name: string; readonly path: string }>;

// ---------------------------------------------------------------------------
// M58 §C#3 — the compaction thrash breaker. When the compaction trigger
// re-fires within ≤2 turns for 2 consecutive compactions, the context is
// refilling faster than compaction can shed it (a pinned huge object, an
// unbounded tool output). Auto-compaction stops with this typed error — the
// loop never thrashes itself to death. The static fallback INSIDE the tiers
// (a failed LLM summary degrading to the deterministic one) is unaffected;
// manual /compact bypasses the loop's guard entirely.
// ---------------------------------------------------------------------------

/** The typed thrash failure (thrown by the loop's auto-compaction guard). */
export class CompactionThrashError extends Error {
  /** How many consecutive rapid re-fires tripped the breaker (always ≥2). */
  readonly streak: number;

  constructor(streak: number) {
    super(
      "compaction thrashing detected: the context refilled within 2 turns of the previous compaction twice in a row — auto-compaction stopped. " +
        "Start a fresh session with /clear, fork this one (--fork-session), or inspect the large objects with /context",
    );
    this.name = "CompactionThrashError";
    this.streak = streak;
  }
}

export const CLEARED_MARKER = "[Old tool result content cleared]";
export const CLEAR_TIER_MIN_CHARS = 30_000;

/** Marker prefix; the frozen drop-count user message leads with it. */
export const EMERGENCY_DROP_PREFIX = "[emergency context drop:";

// ---------------------------------------------------------------------------
// Tier 2: LLM-summary compaction (M4)
//
// Unlike microcompact, the summary is produced by an LLM call, so it is NOT
// reproducible. The summary text is therefore persisted exactly once (as a
// frozen user message starting with SUMMARY_MARKER); applySummaryMarkers
// reproduces the identical bytes from the stored marker on load, keeping the
// request prefix byte-stable so the provider prefix cache re-warms after one
// cold turn — the same determinism property microcompact gets for free.
// ---------------------------------------------------------------------------

export const SUMMARY_MARKER = "[compacted summary]";

// M47 §4 (A1): the summary END marker — a frozen trailing line on every tier-2
// summary message. Weak models (GLM/Qwen) were continuing the SUMMARY as if it
// were the task; this line draws the boundary: the conversation to answer
// resumes BELOW the summary message. Idempotent: exactly one copy ever rides a
// summary, no matter how many re-injections/applySummaryMarkers passes run.
export const SUMMARY_END_MARKER = "[End of summary — respond to the user below, not to the summary]";

/**
 * Cap text at `cap` chars, backing off to just after the last newline so the
 * cap never cuts mid-line. If the slice contains no newline, or the text fits,
 * the plain slice/text is returned. 113-A4: the cap itself is
 * surrogate-pair-safe (truncateSafe) — a cut that would sever an emoji/CJK
 * ext-B pair backs off one unit instead of emitting a lone surrogate.
 */
export function capToLineBoundary(text: string, cap: number): string {
  if (text.length <= cap) return text;
  const sliced = truncateSafe(text, cap);
  const lastNl = sliced.lastIndexOf("\n");
  return lastNl === -1 ? sliced : sliced.slice(0, lastNl + 1);
}
