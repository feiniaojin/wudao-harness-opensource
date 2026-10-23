// 拆分运动 C：从 compaction.ts 原样外提的 tier-2 确定 lane
//（M52 §1 可压缩 span、M47 §5 静态回退、波次 7 #38 零 LLM 摘要、
// 边界装配/板恢复/skill 重注入/链式标记投影）。
// 依赖方向：static → markers/riders/tiers（无环）；LLM lane（compaction.ts 的
// tier2Compact/dual/manual 编排）经由本模块的确定性件组装。
import type { AgentMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import { TODO_BOARD_PREFIX } from "./tools/todo.js";
import {
  SKILL_PRUNED_PREFIX,
  SUMMARY_MARKER,
  SkillReadMap,
  capToLineBoundary,
  formatSkillPrunedMarker,
  formatSkillReinjectedBody,
} from "./compaction-markers.js";
import { floorCutoff } from "./compaction-tiers.js";
import { messageCharLength } from "./compaction-estimation.js";
import {
  effectiveFocus,
  fileOpsSection,
  planModeLine,
  preserveSection,
  rotationHeaderLine,
  summaryAuthorityLine,
  taskFocusLine,
  verifiedWorkSection,
  withSummaryEndMarker,
} from "./compaction-riders.js";
import { worldDiffSection, windowIdentitySection, type WindowIdentity } from "./window-chain.js";
import { pendingActionsSection } from "./pending-actions.js";

/** The shared tier-2 result shape (LLM summary and static fallback alike). */
export interface Tier2Result {
  readonly messages: AgentMessage[];
  readonly summaryMessage: AgentMessage;
  /** M70 §2 (pi): the retained tail — the messages the compact kept VERBATIM
   *  after the boundary. Carried on the compacted event (and from there on
   *  compaction entries) so future compactions can rebuild from it instead of
   *  re-deriving the boundary tail. */
  readonly retainedTail: AgentMessage[];
}

/** The compactable span: everything before the keep-recent window, with the
 *  pairing-safe cutoff (never splitting an assistant tool_call from its tool
 *  results) and the nothing-to-compact check. Shared by the LLM summary and
 *  the M47 static fallback so both compact EXACTLY the same span.
 *
 *  M52 §1 chained spans: the span starts AFTER the last frozen summary marker
 *  (prior summaries and their covered prefixes stay byte-identical in place —
 *  no summary-of-summary drift, no rewriting of already-cached bytes). The
 *  returned `prior` is the frozen chain head the caller must re-prepend. */
export function compactableSpan(
  messages: readonly AgentMessage[],
  keepRecent: number,
): { span: AgentMessage[]; rest: AgentMessage[]; prior: AgentMessage[] } | null {
  // ω-3b: floored — the summary span may not replace the active turn's own
  // (unanswered) batch; the clamp only ever shrinks the span.
  const cutoff = floorCutoff(messages, keepRecent);
  // Everything fits in the keep-recent window — nothing to compact. Checked
  // BEFORE the pairing loop: an orphaned leading tool message could otherwise
  // advance cutoff from 0 to 1 and compact despite the fit.
  if (cutoff <= 0) return null;
  // The chain boundary: the last summary marker before the cutoff. Everything
  // before it is frozen history (prior summaries + the messages they cover).
  let start = 0;
  for (let i = cutoff - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i]?.content.startsWith(SUMMARY_MARKER)) {
      start = i + 1;
      break;
    }
  }
  const span = messages.slice(start, cutoff);
  if (span.length === 0) return null;
  const compactable = span.some((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER)));
  if (!compactable) return null;
  return { span, rest: messages.slice(cutoff), prior: messages.slice(0, start) };
}

export interface Tier2Options {
  readonly keepRecent?: number; // default 6
  /** M24 warm replay: the parent conversation's system prompt — the summary
   *  call reuses it VERBATIM so the replayed prefix stays byte-identical. */
  readonly systemPrompt?: string;
  /** M24 warm replay: the parent conversation's tool definitions. */
  readonly tools?: readonly ModelToolDefinition[];
  /** M48 §3: known skill reads — every DISTINCT skill whose read fell inside
   *  the replaced span is re-injected as a canonical marker user message
   *  right after the summary (board-restore-isomorphic). */
  readonly skillReads?: SkillReadMap;
  /** M58 §C#2 (/compact focus): an explicit focus phrase woven into the
   *  summary instruction — "summarize with attention to X". Empty/absent =
   *  the status-quo instruction (byte-stable). */
  readonly focus?: string;
  /** M58 §C#2: standing compact instructions (the WUDAO.md/AGENTS.md
   *  `## Compact Instructions` section, parsed at session start by the CLI)
   *  woven into every tier-2 summary instruction. */
  readonly compactInstructions?: string;
  /** M58 §C#12: the session's reasoning_effort riding the tier-2 summary
   *  request (ModelInput.reasoningEffort — the per-request override of the
   *  provider config's own effort field). Absent = the provider config's. */
  readonly reasoningEffort?: string;
  /** 波次 7 #38 (OH C2): skip the LLM summary call when the span passes the
   *  digest sufficiency gate (thin narrative — nothing a 300-word summary
   *  would keep that the deterministic digest riders don't). Default TRUE
   *  (the gate is the safety); explicit false restores the always-LLM path. */
  readonly zeroLlmDigest?: boolean;
  /** 波次 7 #39 (OH B1): already-verified facts riding the summary — the
   *  loop derives them mechanically (a successful shell AFTER writes
   *  clears the verify gate's trail; that flip IS a verified fact) and
   *  re-parses the prior boundary's block, so the model never re-does
   *  finished work across the compaction boundary. Absent/empty = no block
   *  (status-quo bytes). */
  readonly verifiedWork?: readonly string[];
  /** 波次 7 #39 (OH B1): plan mode is active — the summary restates it so a
   *  post-compaction model still knows execution is locked until approval
   *  (the M23 board restore carries the plan itself; this line carries the
   *  MODE). Absent = no line (status-quo bytes). */
  readonly planMode?: boolean;
  /** 125 项 1（codex 窗口链）: the rotation identity riding the summary
   *  message header — `[context window #N | chain: … | first/prev]`. The
   *  model sees WHICH window it is in and where the chain began. Absent =
   *  no line (status-quo bytes; pre-125 callers byte-identical). Cache
   *  declaration (M24): the line lands on a boundary that rewrites the
   *  prefix anyway — ZERO additional cache surface. */
  readonly windowIdentity?: WindowIdentity;
  /** 125 项 2（codex WorldState）: the pre-rendered world-diff body
   *  (worldStateDiff(prev, curr)) riding the summary header under the
   *  identity line. Absent/"" = no section (the first compaction has no
   *  previous snapshot — behavior unchanged). */
  readonly worldDiff?: string;
  /** 125 项 1：模型侧轮转回执——trigger 为 agent-rotation 时携带。 */
  agentRotation?: { rationale: string; preserve?: string };
}

// M47 §5 (A2): the STATIC tier-2 fallback. The LLM summary is the only
// fallible step in compaction — when the provider is down, tier-2 used to
// take the whole run with it. The fallback is a pure, zero-LLM summary that
// can never fail: the first user message of the compacted span + deterministic
// role counts over its recent messages. Same span, same frozen-marker shape,
// same board survival as the LLM path.
// ---------------------------------------------------------------------------

/** Recent tail of the span feeding the role counts (bounded, deterministic). */
const STATIC_RECENT_MESSAGES = 10;
/** Cap on the first-user-message quote inside the static summary. */
const STATIC_FIRST_USER_CAP_CHARS = 400;

/** Deterministic role counts over a message list ("2 user, 3 tool" shape) —
 *  the shared body of the static fallback and the zero-LLM digest. */
function roleCountsText(messages: readonly AgentMessage[]): string {
  const counts: string[] = [];
  for (const role of ["user", "assistant", "tool"] as const) {
    const n = messages.filter((m) => m.role === role).length;
    if (n > 0) counts.push(`${n} ${role}`);
  }
  return counts.length > 0 ? counts.join(", ") : "no messages";
}

/** Pure, deterministic fallback summary of a compacted span: the original
 *  request (first user message, capped) + role counts of the span's recent
 *  tail. Never calls a model, never throws, never varies. */
export function staticFallbackSummary(span: readonly AgentMessage[], recentN: number = STATIC_RECENT_MESSAGES): string {
  const firstUser = span.find((m) => m.role === "user");
  const head = firstUser !== undefined ? capToLineBoundary(firstUser.content, STATIC_FIRST_USER_CAP_CHARS) : "(no user message in the compacted span)";
  return `Static fallback summary (the model summary call failed; deterministic compact of ${span.length} messages). Original request: ${head}\nRecent activity: ${roleCountsText(span.slice(-recentN))}.`;
}

// ---------------------------------------------------------------------------
// 波次 7 #38 (OH C2) — the zero-LLM digest front stage. OH's deterministic
// on-disk digest lets a compaction skip the LLM summary call when the digest
// is SUFFICIENT; wudao's static fallback only fired when the LLM call FAILED.
// The port: a conservative sufficiency gate — when the span's NARRATIVE is
// thin (user + assistant text both under small caps) there is nothing a
// 300-word LLM summary preserves that the digest does not already carry
// deterministically (original-request quote + role counts + the ω-5b task
// line + the 夜移030 file ledger + the M23 board restore). Digest text rides
// the SAME frozen-summary shape as the LLM path, so every marker consumer
// (chain head, occupancy, persist filter) is untouched — and there is no new
// on-disk state: the digest IS the frozen summary (the 夜移030 determinism
// discipline, resume-re-derivable from bytes).
// ---------------------------------------------------------------------------

/** Digest cap on the span's total ASSISTANT text (the "key facts and
 *  decisions" the LLM summary exists to preserve). */
export const DIGEST_ASSISTANT_TEXT_CAP_CHARS = 1200;
/** Digest cap on the span's total USER text — the digest quotes only the
 *  first user message (capped), so a talkative span must go the LLM way. */
export const DIGEST_USER_TEXT_CAP_CHARS = 800;

/** 波次 7 #38: is this span's narrative thin enough that the deterministic
 *  digest loses nothing the LLM summary would have kept? Pure. Requires a
 *  non-empty user message (the anchor the digest quotes) and both text
 *  totals at-or-under the caps (boundary inclusive). */
export function digestibleSpan(span: readonly AgentMessage[]): boolean {
  let assistantChars = 0;
  let userChars = 0;
  let hasAnchor = false;
  for (const m of span) {
    if (m.role === "user") {
      userChars += m.content.length;
      if (m.content.trim() !== "") hasAnchor = true;
    } else if (m.role === "assistant") {
      assistantChars += m.content.length;
    }
  }
  return hasAnchor && userChars <= DIGEST_USER_TEXT_CAP_CHARS && assistantChars <= DIGEST_ASSISTANT_TEXT_CAP_CHARS;
}

/** 波次 7 #38: the deterministic digest body — span size, the original
 *  request (capped), role counts. Pure; the task line / file ledger / board
 *  / skill riders compose around it exactly as around an LLM body. */
export function digestSummary(span: readonly AgentMessage[]): string {
  const firstUser = span.find((m) => m.role === "user" && m.content.trim() !== "");
  const head = firstUser !== undefined ? capToLineBoundary(firstUser.content, STATIC_FIRST_USER_CAP_CHARS) : "(no user message in the compacted span)";
  return `Deterministic context digest (zero-LLM compact of ${span.length} messages — span narrative under the digest thresholds; task, files, and board carried by the riders). Original request: ${head}\nActivity: ${roleCountsText(span)}.`;
}

/** The static tier-2 compact — same shape and span as tier2Compact, zero LLM. */
export function staticTier2Compact(
  messages: readonly AgentMessage[],
  options: Tier2Options = {},
): Tier2Result | null {
  const split = compactableSpan(messages, options.keepRecent ?? 6);
  if (split === null) return null;
  // ω-5b (I22): the static fallback needs the task anchor MOST — it is the
  // weak-model path (the LLM summary call already failed).
  const focus = effectiveFocus(options.focus, split.span);
  const summaryMessage: AgentMessage = {
    role: "user",
    content: withSummaryEndMarker(
      // 125 项 1/项 2: the window identity + world diff ride the HEADER —
      // above the task line and the body, below the frozen marker. Absent
      // options render "" (byte-identical status-quo summaries).
      `${SUMMARY_MARKER} ${windowIdentitySection(options.windowIdentity)}${worldDiffSection(options.worldDiff, options.windowIdentity)}${rotationHeaderLine(options.agentRotation)}${taskFocusLine(focus)}${staticFallbackSummary(split.span)}\n[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]`
        + preserveSection(options.agentRotation?.preserve)
        // 113-B1: the authority declaration rides the static fallback's
        // message too (same boundary family; zero cache involvement).
        + summaryAuthorityLine(split.rest.length)
        + fileOpsSection(split.prior, split.span)
        + verifiedWorkSection(split.prior, split.span, options.verifiedWork)
        // 借鉴弧 ζ1: 未决写记录尾注（同一 riders 位、同一 status-quo-bytes 律）。
        + pendingActionsSection(split.prior, split.span)
        + planModeLine(options.planMode),
    ),
  };
  return assembleTier2(split.span, split.rest, summaryMessage, options.skillReads, split.prior);
}

/** Shared assembly: summary message + deterministic board survival + the
 *  kept tail. The `(restored)` suffix rides the board's header line; item
 *  lines stay verbatim, and parseTodoBoard still recognizes the whole
 *  message (M23 §2). M48 §3: distinct pruned-skill markers follow the board;
 *  M58 §C#11: the MOST RECENT distinct skill's body is re-injected after
 *  them instead of a marker (see skillReinjection). */
export function assembleTier2(
  span: readonly AgentMessage[],
  rest: readonly AgentMessage[],
  summaryMessage: AgentMessage,
  skillReads?: SkillReadMap,
  prior: readonly AgentMessage[] = [],
): Tier2Result {
  const restored = restoreBoardFromSpan(span);
  const { markers, reinjected } = skillReinjection(span, skillReads);
  return {
    messages: [
      ...prior,
      summaryMessage,
      ...(restored !== undefined ? [restored] : []),
      ...markers,
      ...(reinjected !== undefined ? [reinjected] : []),
      ...rest,
    ],
    summaryMessage,
    // M70 §2: the kept-verbatim tail (the `rest` messages survive the boundary untouched).
    retainedTail: [...rest],
  };
}

/** M58 §C#11 hybrid reinjection over the replaced span. The most recent
 *  distinct skill read that still HAS its body (a tier-0/1 pass may already
 *  have swapped a marker in place — a marker is not a body) is re-injected
 *  head-capped at 5000 chars; every OTHER distinct skill keeps one canonical
 *  [SKILL_PRUNED] marker (first-seen order, re-reads collapsed). Absent
 *  skillReads → nothing (status quo).
 *
 *  DECISION (review ruling, pinned by tests): the selection is deliberately
 *  LATEST-WITH-BODY, not latest-invoked — when the most recent skill's body
 *  was already tier-0/1 marker-ized, the most recent skill that still HAS a
 *  body is re-injected in its place (the markerized skill keeps its marker).
 *  A marker presented as a body would be worse than an older real body. */
function skillReinjection(
  span: readonly AgentMessage[],
  skillReads?: SkillReadMap,
): { markers: AgentMessage[]; reinjected?: AgentMessage } {
  if (skillReads === undefined) return { markers: [] };
  // The most recent skill read with a real body, scanning from the span's
  // END (a re-read of the same skill picks up its latest body).
  let recent: { name: string; path: string; body: string } | undefined;
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = span[i];
    if (m?.role !== "tool") continue;
    const read = skillReads.get(m.toolCallId);
    if (read === undefined) continue;
    if (m.content.startsWith(SKILL_PRUNED_PREFIX)) continue; // already a marker
    recent = { name: read.name, path: read.path, body: m.content };
    break;
  }
  const byName = new Map<string, { name: string; path: string }>();
  for (const m of span) {
    if (m.role !== "tool") continue;
    const read = skillReads.get(m.toolCallId);
    if (read !== undefined) byName.set(read.name, read);
  }
  const markers = [...byName.values()]
    .filter((r) => r.name !== recent?.name)
    .map((r) => ({ role: "user" as const, content: formatSkillPrunedMarker(r.name, r.path) }));
  return {
    markers,
    reinjected: recent !== undefined
      ? { role: "user" as const, content: formatSkillReinjectedBody(recent.name, recent.path, recent.body) }
      : undefined,
  };
}

/** Clone the last board message of the span as an equivalent user message. */
function restoreBoardFromSpan(span: readonly AgentMessage[]): AgentMessage | undefined {
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = span[i];
    if (m && m.content.startsWith(TODO_BOARD_PREFIX)) {
      const firstNl = m.content.indexOf("\n");
      if (firstNl === -1) return { role: "user", content: `${m.content}(restored)` };
      return { role: "user", content: `${m.content.slice(0, firstNl)}(restored)${m.content.slice(firstNl)}` };
    }
  }
  return undefined;
}

/** Pure: on load, reset history at each summary marker (append-only-friendly
 *  checkpoint). M52 §1 `chain: true` — the chained-span projection: keep from
 *  the FIRST marker onward (the whole chain of frozen summaries), because each
 *  later summary covers only the span SINCE the previous one; resetting at
 *  every marker would drop everything an earlier summary still stands for. */
export function applySummaryMarkers(
  messages: readonly AgentMessage[],
  opts: { readonly chain?: boolean } = {},
): AgentMessage[] {
  if (opts.chain === true) {
    const first = messages.findIndex((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER));
    return first === -1 ? [...messages] : messages.slice(first);
  }
  let out: AgentMessage[] = [];
  for (const m of messages) {
    if (m.content.startsWith(SUMMARY_MARKER)) out = [m];
    else out.push(m);
  }
  return out;
}

/** 125 项 1: the boundary count of a message list — how many frozen summary
 *  markers the chain carries. The agent-rotation "window number" is THIS
 *  count + 1 (window 1 = no compaction yet), the INDEPENDENT numbering that
 *  stands until 125b's window-identity chain lands (at which point the chain
 *  becomes the single numbering source and this helper flips to reading it).
 *  Pure. */
export function countSummaryMarkers(messages: readonly AgentMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// M52 §1（借鉴弧 B2 收口自 compaction.ts 原样外提）— the DUAL partition: the
// pairing-safe split of a single oversized turn (history / turn prefix / kept
// tail). LLM lane（compaction.ts 的 dualTier2Compact）与 economics 的 span
// 估计共用；字节零演进。
// ---------------------------------------------------------------------------

/** Default char budget for the summarized turn prefix (the pi dual-summary
 *  split point: the prefix is summarized, the tail is kept verbatim). */
export const DUAL_TURN_PREFIX_CHARS = 12_000;

export interface DualSummaryOptions extends Tier2Options {
  /** Char budget for the summarized turn prefix. Default 12_000. */
  readonly turnPrefixChars?: number;
}

export interface DualPartition {
  /** Frozen chain head: everything through the last summary marker. Never
   *  re-summarized (M52 §1 chained spans). */
  readonly prior: AgentMessage[];
  /** The pre-window span (what a standard tier-2 would summarize). */
  readonly history: AgentMessage[];
  /** The leading slice of the oversized turn that gets summarized away. */
  readonly turnPrefix: AgentMessage[];
  /** The verbatim tail that survives. */
  readonly kept: AgentMessage[];
}

/** Pairing-safe at BOTH edges: the prefix never ends on an assistant
 *  tool_call whose results were cut (the results ride along), and the kept
 *  tail never starts with an orphaned tool result. Always keeps ≥1 message
 *  verbatim. Null when there is nothing to partition. */
export function dualSummaryPartition(
  messages: readonly AgentMessage[],
  options: DualSummaryOptions = {},
): DualPartition | null {
  const keepRecent = options.keepRecent ?? 6;
  const turnPrefixChars = options.turnPrefixChars ?? DUAL_TURN_PREFIX_CHARS;
  // The chain head: everything up to AND INCLUDING the last summary marker is
  // frozen prior — the dual summary never re-summarizes it.
  let chainEnd = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i]?.content.startsWith(SUMMARY_MARKER)) {
      chainEnd = i + 1;
      break;
    }
  }
  const prior = messages.slice(0, chainEnd);
  const rest = messages.slice(chainEnd);
  // ω-3b: floored on the SAME list the tier indexes (stubFloor(rest) — the
  // frozen chain head never contains messages newer than the last assistant,
  // so this equals the whole-list floor shifted by chainEnd).
  const cutoff = floorCutoff(rest, keepRecent);
  const history = rest.slice(0, cutoff);
  const window = rest.slice(cutoff);
  if (history.length === 0 && window.length <= 1) return null;
  // Grow the turn prefix while the char budget lasts (always consider ≥1).
  let end = 0;
  let chars = 0;
  while (end < window.length) {
    const m = window[end];
    if (m === undefined) break;
    const len = messageCharLength(m);
    if (end > 0 && chars + len > turnPrefixChars) break;
    end += 1;
    chars += len;
  }
  // Soft keep-≥1: when the budget swallowed the whole window, back off to the
  // last message (pairing below may legitimately re-empty the tail when the
  // window is one entire call/result chain).
  if (end > window.length - 1 && window.length >= 2) end = window.length - 1;
  // Pairing-safety: never end the prefix between a tool_call and its results.
  while (end > 0 && end < window.length) {
    const last = window[end - 1];
    if (last !== undefined && last.role === "assistant" && last.toolCalls && last.toolCalls.length > 0) {
      end += 1; // the following tool results ride with their call
      continue;
    }
    break;
  }
  // The kept tail must never START with an orphaned tool result — a result
  // whose assistant call was summarized into the prefix is provider-illegal
  // as a history head. Advance past results whose call ids live in the
  // prefix ONLY (a result whose call is outside the prefix is a legal head).
  // When the window is one entire pair-chain, kept is legitimately empty:
  // the conversation continues after the summary (mid-run) — the whole TURN
  // is never silently dropped, it is the dual summary's subject.
  const prefixCallIds = new Set<string>();
  for (const m of window.slice(0, end)) {
    if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) prefixCallIds.add(tc.id);
  }
  let keptFrom = Math.max(end, 1);
  while (keptFrom < window.length) {
    const head = window[keptFrom];
    if (head !== undefined && head.role === "tool" && prefixCallIds.has(head.toolCallId)) {
      keptFrom += 1;
      continue;
    }
    break;
  }
  if (keptFrom <= 0) return null;
  return {
    prior,
    history,
    turnPrefix: window.slice(0, keptFrom),
    kept: window.slice(keptFrom),
  };
}
