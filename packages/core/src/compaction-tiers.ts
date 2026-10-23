// 拆分运动 C：从 compaction.ts 原样外提的免费层域
//（tier-0 clear、tier-1 microcompact、M52 §1 配对安全边界、ω-3b 桩下限、
// ω-2b (I2-b) 紧急截断层）。依赖方向：tiers → markers/estimation/text-truncate
//（text-truncate 为 113-A4 引入的零依赖叶子，无环）。
import type { AgentMessage, ToolResultMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import { truncateSafe } from "./text-truncate.js";
import { toolResultRef } from "./tools/session-result.js";
import {
  CLEARED_MARKER,
  CLEAR_TIER_MIN_CHARS,
  COMPACTION_STUB_PREFIX,
  EMERGENCY_DROP_PREFIX,
  SKILL_PRUNED_PREFIX,
  SUMMARY_MARKER,
  formatSkillPrunedMarker,
  matchesRetention,
  type MicrocompactOptions,
  type RetentionTarget,
  type SkillReadMap,
} from "./compaction-markers.js";
import { estimateTokens } from "./compaction-estimation.js";

// ---------------------------------------------------------------------------
// Tier 0: clear (M34 §3) — the FREE tier that runs before microcompact.
//
// Oldest tool results past keepRecent whose content exceeds 30k chars are
// replaced with the frozen "[Old tool result content cleared]" marker: no
// summary, no LLM call, fully deterministic (pure oldest-largest — the
// selective-retention policy is deliberately out of scope). Pairing-safe by
// construction: the message (and its toolCallId) stays, only the content
// shrinks, so an assistant tool_call never loses its result. When clearing
// alone brings the occupancy back under the threshold, the dearer tiers
// never fire.
// ---------------------------------------------------------------------------

export interface ClearTierOptions {
  /** Don't clear the last N messages (the active working set). Default 6
   *  (mirrors microcompact's keepRecent). */
  readonly keepRecent?: number;
  /** Only clear tool results longer than this many chars. Default 30_000 —
   *  deliberately independent of microcompact's minChars: tier 0 targets the
   *  huge results whose content is worthless once old, tier 1 the merely
   *  large ones worth a stub preview. */
  readonly minChars?: number;
  /** Occupancy budget (tokens): clearing stops as soon as the estimate fits
   *  (the cheapest tier wins). Absent → every eligible result is cleared. */
  readonly fitsTokens?: number;
  /** Estimate inputs (system prompt + tool defs) — only needed for fitsTokens. */
  readonly systemPrompt?: string;
  readonly tools?: readonly ModelToolDefinition[];
  /** M48 §3: known skill reads — a cleared skill-read result becomes the
   *  canonical [SKILL_PRUNED: …] marker instead of the bare cleared marker. */
  readonly skillReads?: SkillReadMap;
  /** ω-2b (I2-a): per-tool retention — only matching tools' results are
   *  cleared (see matchesRetention). Absent = every tool (status quo). */
  readonly retention?: RetentionTarget;
}

export interface ClearTierResult {
  readonly messages: AgentMessage[];
  /** How many tool results were cleared. */
  readonly cleared: number;
}

export function clearTier(messages: readonly AgentMessage[], options: ClearTierOptions = {}): ClearTierResult {
  const keepRecent = options.keepRecent ?? 6;
  const minChars = options.minChars === undefined ? CLEAR_TIER_MIN_CHARS : options.minChars;
  // ω-3b: floored — an unseen result (no assistant after it) is never cleared.
  const cutoff = floorCutoff(messages, keepRecent); // indices < cutoff are candidates
  const out = [...messages];
  let cleared = 0;
  for (let i = 0; i < cutoff; i++) {
    // Stop the moment the budget fits — clearing past it would discard
    // content the context can still afford to keep.
    if (options.fitsTokens !== undefined && estimateTokens(options.systemPrompt ?? "", options.tools ?? [], out) <= options.fitsTokens) {
      break;
    }
    const m = out[i];
    if (m === undefined || m.role !== "tool" || m.content.length <= minChars) continue;
    // ω-2b (I2-a): retention-ineligible tools' results are never cleared.
    if (!matchesRetention(m.name, options.retention)) continue;
    // Already-cleared markers and microcompact stubs are far below minChars,
    // so the length filter alone keeps this idempotent. M48 §3: a cleared
    // skill read degrades to the reload marker, not the bare cleared marker.
    const skillRead = options.skillReads?.get(m.toolCallId);
    // ω-2b (I3): the cleared marker carries the recovery pointer on a second
    // line — the original bytes stay recoverable through session_result (a
    // skill read keeps its reload marker: read_file is the better recovery).
    out[i] = {
      ...m,
      content: skillRead !== undefined
        ? formatSkillPrunedMarker(skillRead.name, skillRead.path)
        : `${CLEARED_MARKER}\n${sessionResultPointer(m)}`,
    };
    cleared += 1;
  }
  return { messages: out, cleared };
}

/**
 * Replace OLD, LARGE tool_result content with a deterministic, frozen stub.
 * Pure + idempotent (already-stubbed results are skipped) + pairing-preserving.
 * Determinism is what keeps the prefix byte-identical across runs (and across --resume),
 * so the provider's prefix cache keeps hitting after the one cold post-compaction turn.
 */
export function microcompact(messages: readonly AgentMessage[], options: MicrocompactOptions = {}): AgentMessage[] {
  const keepRecent = options.keepRecent ?? 6;
  const minChars = options.minChars ?? 1000;
  // ω-3b: floored — an unseen result (no assistant after it) is never stubbed.
  const cutoff = floorCutoff(messages, keepRecent); // indices < cutoff are candidates
  return messages.map((m, i) => {
    if (i >= cutoff) return m;
    if (m.role !== "tool") return m;
    // ω-2b (I2-a): retention-ineligible tools' results are never stubbed.
    if (!matchesRetention(m.name, options.retention)) return m;
    if (m.content.length <= minChars) return m;
    if (m.content.startsWith(COMPACTION_STUB_PREFIX) || m.content.startsWith(SKILL_PRUNED_PREFIX)) return m; // idempotent
    // M48 §3: a pruned skill read degrades to the reload marker — the model
    // keeps a pointer to what it lost instead of a preview of prose it can no
    // longer follow.
    const skillRead = options.skillReads?.get(m.toolCallId);
    if (skillRead !== undefined) {
      return { ...m, content: formatSkillPrunedMarker(skillRead.name, skillRead.path) };
    }
    return stubResult(m);
  });
}

// ω-2b (I3): the canonical recovery pointer every stub/clear carries — the
// model is HANDED the session_result call (marker-embedded args). Pure
// sha256 of id+content ⇒ deterministic ⇒ the stub bytes stay a pure function
// of history (cache-stable across runs and resume).
function sessionResultPointer(m: ToolResultMessage): string {
  return `full original retained in this session; recover with session_result(tool_call_id="${m.toolCallId}", result_ref="${toolResultRef(m.toolCallId, m.content)}")`;
}

function stubResult(m: ToolResultMessage): ToolResultMessage {
  // 113-A4: the stub preview is PERSISTED bytes (resume re-derives it) — the
  // surrogate-safe cap keeps stub bytes a pure function of history; only
  // surrogate-straddling inputs change bytes vs. the old cap (declared
  // behavior fix: the old bytes were a lone-surrogate mojibake bug).
  const preview = truncateSafe(m.content.replace(/\s+/g, " ").trim(), 100);
  return { ...m, content: `${COMPACTION_STUB_PREFIX} tool_result ${m.toolCallId}: ${preview}…] — ${sessionResultPointer(m)}` };
}

// ---------------------------------------------------------------------------
// M52 §1 — the shared pairing-safe cutoff. The keep-recent boundary NEVER
// starts on a tool result: if the message at the raw cutoff is a `tool`
// message, its assistant tool_call already fell on the span side, so the pair
// is pulled into the span together ("never cut at a tool result"). Tier 2 has
// always done this; tier 0 (clear) and tier 1 (microcompact) now align to the
// SAME boundary, so all three tiers agree on what "old" means for a pair
// straddling the window edge.
// ---------------------------------------------------------------------------

/** The pairing-safe span/kept boundary for a keep-recent window. */
export function alignedCutoff(messages: readonly AgentMessage[], keepRecent: number): number {
  let cutoff = messages.length - keepRecent;
  if (cutoff <= 0) return Math.max(cutoff, 0);
  while (cutoff < messages.length && messages[cutoff]?.role === "tool") {
    cutoff += 1;
  }
  return cutoff;
}

// ---------------------------------------------------------------------------
// ω-3b — the unseen-tool-result stub floor. The M52 walk above pulls a
// straddling pair into the span, but on the ACTIVE turn's own batch that same
// walk stubs/clears/summarizes results the model has never responded to (its
// next call — the one compaction is preparing — would read previews of the
// fan-out it just issued). The floor: nothing after the LAST assistant
// message may be degraded by the routine tiers (learn-a reference harness b5bd0dd:
// "preserve the latest tool result batch during compaction", translated from
// their batch-inside-user-message shape to wudao's one-result-per-message
// shape via the index rule). emergencyDrop and the dual turnPrefix growth
// stay UN-floored by design (the deliberate-loss terminal tier / the
// oversized-current-turn shedder — design 81 §5 D2/D3).
// ---------------------------------------------------------------------------

/** ω-3b: the stub FLOOR — the index of the last assistant message. No
 *  message at an index > floor may be stubbed/cleared/summarized by the
 *  routine compaction tiers: everything after the last assistant is either
 *  its own tool results (never yet answered by the model) or user input.
 *  0 when no assistant exists (nothing is ever stubbable). Pure. */
export function stubFloor(messages: readonly AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "assistant") return i;
  }
  return 0;
}

/** ω-3b: the routine-tier boundary — the M52 pairing-safe cutoff CLAMPED by
 *  the stub floor. `alignedCutoff` itself is untouched (still the pairing
 *  primitive its unit tests pin). The clamp only ever removes candidates. */
export function floorCutoff(messages: readonly AgentMessage[], keepRecent: number): number {
  return Math.min(alignedCutoff(messages, keepRecent), stubFloor(messages));
}

// ---------------------------------------------------------------------------
// ω-2b (I2-b) — the emergency truncate tier (Strands EmergencyTruncateStrategy,
// adapted as a pure wudao tier). It fires ONLY from the reactive ladder's
// terminal corner — when the compact-retry ALSO overflows, before the hard
// error — and never walks the ordinary tier pipeline:
//   · drops the oldest `dropRatio` (default 20%) of the DROPPABLE head (all
//     roles), then keeps extending while the estimate still exceeds
//     fitsTokens — deliberate loss, bounded by the keep-recent window;
//   · head-pinned: message 0 and every SUMMARY_MARKER message stay (the
//     M52 §1 chain head is frozen; covered prefixes MAY go — the marker
//     below makes the loss visible);
//   · pairing-safe at BOTH edges with dualSummaryPartition's technique
//     (a dropped assistant tool_call swallows its results; the kept region
//     never starts with an orphaned result);
//   · splices ONE frozen count-marker user message at the drop point
//     (Strands' _makeRemovalMarker insert);
//   · idempotent (an existing emergency marker ⇒ null) and deterministic —
//     never persisted, re-derived on resume exactly like tier-0/1 stubs;
//   · null when there is nothing to drop, the list is trivially small
//     (≤3 messages, Strands' guard), or even the maximal safe drop leaves
//     the keep-recent tail alone over budget (nothing emergency can do).
// ---------------------------------------------------------------------------

export interface EmergencyDropOptions {
  /** Fraction of the conversation (by count) to drop from the head. Default 0.2. */
  readonly dropRatio?: number;
  /** The keep-recent window that must survive verbatim. Default 6. */
  readonly keepRecent?: number;
  /** The token budget the result should fit (the ladder's window minus
   *  reserve); the drop extends while the estimate exceeds it. */
  readonly fitsTokens: number;
  readonly systemPrompt: string;
  readonly tools: readonly ModelToolDefinition[];
}

/** The frozen count-marker spliced at the drop point. Pure. */
function emergencyDropMarker(dropped: number): AgentMessage {
  return {
    role: "user",
    content: `${EMERGENCY_DROP_PREFIX} ${dropped} oldest messages were removed to fit the context window — the full history remains in the session file]`,
  };
}

/** True for a message the emergency tier must never drop. */
const emergencyPinned = (m: AgentMessage | undefined): boolean =>
  m !== undefined && m.role === "user" && m.content.startsWith(SUMMARY_MARKER);

export function emergencyDrop(
  messages: readonly AgentMessage[],
  options: EmergencyDropOptions,
): { messages: AgentMessage[]; dropped: number } | null {
  // Idempotence: one emergency drop per derivation (the ladder's one-shot
  // bound; a resumed run re-derives from the never-persisted originals).
  if (messages.some((m) => m.role === "user" && m.content.startsWith(EMERGENCY_DROP_PREFIX))) return null;
  // Strands' guard: a trivially small conversation has nothing to shed.
  if (messages.length <= 3) return null;
  const keepRecent = options.keepRecent ?? 6;
  const dropRatio = options.dropRatio ?? 0.2;
  const cutoff = alignedCutoff(messages, keepRecent);
  // Index 0 is pinned (the task head) — the droppable region is [1, cutoff).
  if (cutoff <= 1) return null;
  const desired = Math.max(1, Math.ceil(dropRatio * messages.length));

  // Build the result for a drop boundary at `end` (exclusive): head + the
  // pinned summary markers inside the dropped region + the count-marker +
  // the kept tail. Pinned markers keep their relative order.
  const build = (end: number): { out: AgentMessage[]; dropped: number } => {
    const pinned: AgentMessage[] = [];
    let dropped = 0;
    for (let i = 1; i < end; i += 1) {
      const m = messages[i];
      if (m === undefined) continue;
      if (emergencyPinned(m)) pinned.push(m);
      else dropped += 1;
    }
    return { out: [messages[0]!, ...pinned, emergencyDropMarker(dropped), ...messages.slice(end)], dropped };
  };
  // Pairing safety, dualSummaryPartition's technique applied to a head drop:
  // (B) a dropped region may not END on an assistant tool_call whose results
  //     were kept — the results ride with their call;
  // (A) the kept region may not START with an orphaned tool result whose
  //     call was dropped — it rides with its call too.
  const fixPairing = (end: number): number => {
    let e = end;
    while (e > 1 && e < cutoff) {
      const last = messages[e - 1];
      if (last !== undefined && last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
        e += 1;
        continue;
      }
      break;
    }
    const droppedCallIds = new Set<string>();
    for (let i = 1; i < e; i += 1) {
      const m = messages[i];
      if (m !== undefined && m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) droppedCallIds.add(tc.id);
    }
    while (e < cutoff) {
      const head = messages[e];
      if (head !== undefined && head.role === "tool" && droppedCallIds.has(head.toolCallId)) {
        e += 1;
        continue;
      }
      break;
    }
    return e;
  };

  let end = 1;
  let dropped = 0;
  // Phase 1: the oldest `desired` droppable messages.
  while (end < cutoff && dropped < desired) {
    const m = messages[end];
    if (m !== undefined && !emergencyPinned(m)) dropped += 1;
    end += 1;
  }
  // Phase 2: extend while the budget still does not fit (deliberate loss,
  // bounded by the keep-recent window).
  for (;;) {
    end = fixPairing(end);
    const built = build(end);
    if (estimateTokens(options.systemPrompt, options.tools, built.out) <= options.fitsTokens) break;
    if (end >= cutoff) {
      // Even the maximal safe drop cannot fit — the tail alone is over
      // budget; the hard error is the honest answer.
      return null;
    }
    end += 1;
  }
  const built = build(end);
  if (built.dropped === 0) return null;
  return { messages: built.out, dropped: built.dropped };
}
