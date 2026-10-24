import type { AgentMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
import type { ModelClient } from "./model-client.js";
// 拆分运动 C：域文件外提后本模块保留 tier-2 LLM lane 的编排
//（tier2Compact / dual / manual / occupancy）；下面逐名 import 域件、
// 再逐名 re-export 保公共面（loop/authz-evidence/index/tests 零演进）。
import {
  CLEARED_MARKER,
  COMPACTION_STUB_PREFIX,
  EMERGENCY_DROP_PREFIX,
  SKILL_PRUNED_PREFIX,
  SUMMARY_MARKER,
  capToLineBoundary,
} from "./compaction-markers.js";
import {
  type CharCount,
  charCountTokens,
  countChars,
  estimateTokens,
  messageCharCount,
  messageCharLength,
  messageImagesTokens,
} from "./compaction-estimation.js";
import { clearTier, floorCutoff, microcompact } from "./compaction-tiers.js";
import {
  effectiveFocus,
  fileOpsSection,
  planModeLine,
  preserveSection,
  recencyAnchorOf,
  rotationHeaderLine,
  stripSummaryEndMarker,
  summaryAuthorityLine,
  taskFocusLine,
  verifiedWorkSection,
  withSummaryEndMarker,
} from "./compaction-riders.js";
import { isAbortError, summarizeSpan, throwIfAborted } from "./compaction-summarizer.js";
import { pendingActionsSection } from "./pending-actions.js";
import { worldDiffSection, windowIdentitySection, type WindowIdentity } from "./window-chain.js";
import {
  Tier2Options,
  Tier2Result,
  applySummaryMarkers,
  assembleTier2,
  compactableSpan,
  digestSummary,
  digestibleSpan,
  staticFallbackSummary,
  staticTier2Compact,
  dualSummaryPartition,
  type DualSummaryOptions,
} from "./compaction-tier2-static.js";
export {
  // markers 域
  COMPACTION_STUB_PREFIX, matchesRetention, compactionRetentionFor,
  SKILL_PRUNED_PREFIX, formatSkillPrunedMarker, SKILL_REINJECTED_PREFIX,
  SKILL_REINJECT_CAP_CHARS, formatSkillReinjectedBody, parseSkillPrunedMarker,
  CompactionThrashError, CLEARED_MARKER, CLEAR_TIER_MIN_CHARS, EMERGENCY_DROP_PREFIX,
  SUMMARY_MARKER, SUMMARY_END_MARKER, capToLineBoundary,
} from "./compaction-markers.js";
export type { RetentionTarget, MicrocompactOptions, SkillReadMap } from "./compaction-markers.js";
export {
  // estimation 域
  CJK_TOKENS_PER_CHAR, NON_CJK_CHARS_PER_TOKEN, estimateTokens,
  estimateTokensBreakdown,
} from "./compaction-estimation.js";
export type { TokenBreakdown } from "./compaction-estimation.js";
export {
  // tiers 域
  clearTier, microcompact, alignedCutoff, stubFloor, floorCutoff, emergencyDrop,
} from "./compaction-tiers.js";
export type { ClearTierOptions, ClearTierResult, EmergencyDropOptions } from "./compaction-tiers.js";
export {
  // riders 域
  SUMMARY_TASK_LEAD, autoTaskFocus, stripSummaryEndMarker, withSummaryEndMarker,
  FILE_LEDGER_READ_TAG, FILE_LEDGER_MODIFIED_TAG, FILE_LEDGER_CAP,
  extractFileOps, parseFileOpsFromSummary, mergeFileOps, formatFileOperations,
  cumulativeModifiedFiles,
  VERIFIED_WORK_TAG, VERIFIED_WORK_CAP, formatVerifiedWork, parseVerifiedWorkFromSummary,
  planModeLine, verifiedRunHead,
  // 113-B1 — kept-tail recency anchor + the summary authority line.
  recencyAnchorOf, summaryAuthorityLine, SUMMARY_AUTHORITY_LINE, RECENCY_ANCHOR_CAP_CHARS,
  // 125 项 1 — agent-rotation identity riders (codex new_context 形).
  ROTATION_HEADER_LEAD, ROTATION_RATIONALE_HEADER_CAP_CHARS,
  rotationHeaderLine, PRESERVED_BY_AGENT_LEAD, preserveSection, parseRotationHeader,
} from "./compaction-riders.js";
export type { FileLedger } from "./compaction-riders.js";
// 125 项 1/项 2 — 窗口身份链 + WorldState 差分（codex baton-pass 件）。
export {
  windowIdentityLine, windowIdentitySection, windowId,
  worldStateDiff, worldDiffSection, WORLD_DIFF_CAP_CHARS,
  activeToolsOf, ACTIVE_TOOLS_CAP, parseWorldStateData,
} from "./window-chain.js";
export type { WindowIdentity, WorldState } from "./window-chain.js";
export {
  // summarizer 域
  summarizeSpan,
} from "./compaction-summarizer.js";
export type { SummaryReplayInput } from "./compaction-summarizer.js";
export {
  // tier-2 static 域
  staticFallbackSummary, DIGEST_ASSISTANT_TEXT_CAP_CHARS, DIGEST_USER_TEXT_CAP_CHARS,
  digestibleSpan, digestSummary, staticTier2Compact, applySummaryMarkers, compactableSpan,
  dualSummaryPartition, DUAL_TURN_PREFIX_CHARS, countSummaryMarkers,
} from "./compaction-tier2-static.js";
export type { Tier2Result, Tier2Options, DualSummaryOptions, DualPartition } from "./compaction-tier2-static.js";
export {
  // economics 域（借鉴弧 B1/B2，SoL-Pi C1/C2）
  CompactionEconomicsTracker, economicsReport, latestBoardIncomplete,
  DEFAULT_CACHE_WRITE_READ_RATIO, DEFAULT_CACHE_PRICING,
  ECONOMICS_WINDOW_RESERVE_TOKENS, SUMMARY_MEMO_TOKEN_ESTIMATE,
  BOUNDARY_CANDIDATE_FLOOR_RATIO, FIRST_COMPACTION_REQUEST_SCALE,
  SUBSEQUENT_COMPACTION_MARGIN,
} from "./compaction-economics.js";
export type {
  CachePricing, CacheRatioSource, CompactionEconomicsDecision,
  CompactionEconomicsReason, CompactionEconomicsReport, EconomicsDecideInput,
} from "./compaction-economics.js";

/** Replace the compactable span with one frozen summary message. Returns null
 *  if nothing to compact; THROWS if the summarizer model call fails (the M47
 *  loop catches that and degrades to staticTier2Compact — never a dead run). */
export async function tier2Compact(
  messages: readonly AgentMessage[],
  model: ModelClient,
  options: Tier2Options = {},
  signal?: AbortSignal,
): Promise<Tier2Result | null> {
  // ω99-45: entry phase check — a compaction starting after the cancel never
  // spends its summarizer call.
  throwIfAborted(signal);
  const keepRecent = options.keepRecent ?? 6;
  const split = compactableSpan(messages, keepRecent);
  if (split === null) return null;
  const { span, rest, prior } = split;
  // ω-5b (I22): the effective focus — explicit (manual /compact) wins over
  // the derived task anchor; both halves below read this ONE seam.
  const focus = effectiveFocus(options.focus, span);
  // 113-B1 (prime-agent #2385 形): the recency anchor — the LATEST kept-tail
  // assistant text. The summarizer only sees `span`; without the anchor its
  // output describes the world BEFORE `rest`. Derived here (deterministic,
  // zero extra model calls) and threaded into the summary request's TAIL
  // instruction rider — the warm-replay prefix stays byte-identical, so the
  // declared cache cost is zero. The digest path makes no model call — no
  // anchor to inject (the authority line below still rides its message).
  const anchor = recencyAnchorOf(rest);
  // 125 项 1: an agent rotation with a preserve block NEVER takes the digest
  // front stage — the model handed must-keep facts, which only the LLM
  // summarizer can weave into the narrative (the verbatim preserve block
  // rides the message either way; the digest path just cannot also fold it
  // into the summary body). Rationale-only rotations keep the digest gate.
  const rotation = options.agentRotation;
  const digestEligible = (options.zeroLlmDigest ?? true) && digestibleSpan(span)
    && !(rotation?.preserve !== undefined && rotation.preserve.trim() !== "");
  // 波次 7 #38 (OH C2): the zero-LLM front stage — a digestible span (thin
  // narrative) skips the summarizer call entirely; the deterministic digest
  // body composes under the SAME riders as an LLM body. Any span over the
  // caps (or an explicit zeroLlmDigest:false) keeps the LLM path below.
  const summary = digestEligible
    ? digestSummary(span)
    : await summarizeSpan({
        systemPrompt: options.systemPrompt ?? "",
        tools: options.tools ?? [],
        messages: span,
        ...(focus !== undefined ? { focus } : {}),
        ...(options.compactInstructions !== undefined ? { compactInstructions: options.compactInstructions } : {}),
        ...(anchor !== undefined ? { recencyAnchor: anchor } : {}),
        ...(rotation !== undefined ? { agentRotation: rotation } : {}),
        ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
      }, model, signal);
  // ω99-45: post-call phase check — the summary landed while the abort fired
  // (the fetch raced the cancel and won) still never becomes a boundary.
  throwIfAborted(signal);
  const summaryMessage: AgentMessage = {
    role: "user",
    content: withSummaryEndMarker(
      // 125 项 1/项 2: the window identity + world diff ride the HEADER —
      // below the frozen marker, above the task line and the summary body.
      // Absent options render "" (byte-identical status-quo summaries);
      // present options land on a boundary that rewrites the prefix anyway
      // (M24 cache declaration: zero additional cache surface).
      `${SUMMARY_MARKER} ${windowIdentitySection(options.windowIdentity)}${worldDiffSection(options.worldDiff, options.windowIdentity)}${rotationHeaderLine(rotation)}${taskFocusLine(focus)}${stripSummaryEndMarker(summary)}\n[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]`
        // 113-B1: the authority declaration — kept messages outrank the
        // summary (new bytes at the boundary; zero cache involvement).
        + summaryAuthorityLine(rest.length)
        + preserveSection(rotation?.preserve)
        + fileOpsSection(prior, span)
        + verifiedWorkSection(prior, span, options.verifiedWork)
        // 借鉴弧 ζ1: 未决写记录尾注（同一 riders 位、同一 status-quo-bytes 律）。
        + pendingActionsSection(prior, span)
        + planModeLine(options.planMode),
    ),
  };
  return assembleTier2(span, rest, summaryMessage, options.skillReads, split.prior);
}

// ---------------------------------------------------------------------------
// M52 §1 — single turn over budget: the DUAL merged summary (pi). When the
// recent window ITSELF is what blows the budget, standard tier-2 has no span
// (everything is "recent") and used to give up — a 413 was one call away.
// Instead of dropping the whole oversized turn, shed a PREFIX of it: the dual
// summary = the turn's history summary + a summary of the turn prefix, and
// only the true tail stays verbatim. 借鉴弧 B2 收口：partition 外提
// compaction-tier2-static.ts（economics 的 span 估计也要读它，无环）。
// ---------------------------------------------------------------------------

/** One frozen summary message merging both parts (history + turn prefix).
 *  ω-5b (I22): the task line rides the same position — after the frozen
 *  marker, above the merged body. 夜移 030: the file-ops section (when any)
 *  rides after the system note, same position as the standard tier-2.
 *  113-B1: the authority line rides after the system note iff the dual
 *  boundary kept a verbatim tail. 125 项 1/项 2: the window identity + world
 *  diff ride the header (same seat as the standard tier-2; absent =
 *  status-quo bytes). */
function dualSummaryMessage(
  historyText: string,
  turnText: string,
  focus: string | undefined,
  fileOps = "",
  pendingActions = "",
  authority = "",
  windowIdentity?: WindowIdentity,
  worldDiff?: string,
): AgentMessage {
  return {
    role: "user",
    content: withSummaryEndMarker(
      `${SUMMARY_MARKER} ${windowIdentitySection(windowIdentity)}${worldDiffSection(worldDiff, windowIdentity)}${taskFocusLine(focus)}${stripSummaryEndMarker(historyText)}\n[turn summary] ${stripSummaryEndMarker(turnText)}\n[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]${authority}${fileOps}${pendingActions}`,
    ),
  };
}

/** Summarize one part, degrading to the deterministic static summary when the
 *  model call fails (each half falls back independently — never a dead dual).
 *  113-B1: `recencyAnchor` threads the dual's ONE derived kept-tail anchor
 *  into each half's instruction (both halves summarize into the same tail). */
async function summarizePart(
  part: readonly AgentMessage[],
  label: string,
  options: DualSummaryOptions,
  model: ModelClient,
  signal?: AbortSignal,
  recencyAnchor?: string,
): Promise<string> {
  if (part.length === 0) return `(${label}: nothing to summarize)`;
  try {
    // M58 §C#2 + 113-B1: the same riders the standard tier-2 weaves (focus,
    // compact instructions, the kept-tail recency anchor, session effort)
    // ride each dual half — the dual-summarizer STRUCTURE is unchanged, only
    // the instruction grows. Both halves summarize INTO the same kept tail,
    // so the anchor is the same latest kept assistant text for each.
    return await summarizeSpan({
      systemPrompt: options.systemPrompt ?? "",
      tools: options.tools ?? [],
      messages: part,
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.compactInstructions !== undefined ? { compactInstructions: options.compactInstructions } : {}),
      ...(recencyAnchor !== undefined ? { recencyAnchor } : {}),
      ...(options.agentRotation !== undefined ? { agentRotation: options.agentRotation } : {}),
      ...(options.reasoningEffort !== undefined ? { reasoningEffort: options.reasoningEffort } : {}),
    }, model, signal);
  } catch (err) {
    // ω99-45: an abort propagates — the per-part static fallback below is for
    // a down provider, never for a cancelled user.
    if (signal?.aborted || isAbortError(err)) throw err;
    return `${label} — ${staticFallbackSummary(part)}`;
  }
}

/** The dual tier-2 compact: history summary + turn-prefix summary merged into
 *  ONE frozen summary message; the turn's tail survives verbatim, and the
 *  frozen chain head (prior summaries) stays in place byte-identical. */
export async function dualTier2Compact(
  messages: readonly AgentMessage[],
  model: ModelClient,
  options: DualSummaryOptions = {},
  signal?: AbortSignal,
): Promise<Tier2Result | null> {
  // ω99-45: entry phase check (same contract as tier2Compact).
  throwIfAborted(signal);
  const split = dualSummaryPartition(messages, options);
  if (split === null) return null;
  // ω-5b (I22): the dual halves read the ONE effective focus — derived from
  // the whole replaced region (history + turn prefix), explicit wins.
  const focus = effectiveFocus(options.focus, [...split.history, ...split.turnPrefix]);
  const withFocus: DualSummaryOptions = focus === undefined ? options : { ...options, focus };
  // 113-B1: the dual's kept-tail anchor — same derivation as the standard
  // tier-2, over the dual partition's verbatim tail.
  const anchor = recencyAnchorOf(split.kept);
  const historyText = await summarizePart(split.history, "History", withFocus, model, signal, anchor);
  const turnText = await summarizePart(split.turnPrefix, "Turn prefix", withFocus, model, signal, anchor);
  const summaryMessage = dualSummaryMessage(
    historyText,
    turnText,
    focus,
    fileOpsSection(split.prior, [...split.history, ...split.turnPrefix]),
    // 借鉴弧 ζ1: 未决写记录尾注（同一 riders 位、同一 status-quo-bytes 律）。
    pendingActionsSection(split.prior, [...split.history, ...split.turnPrefix]),
    // 113-B1: the authority line rides iff the dual boundary kept a tail.
    summaryAuthorityLine(split.kept.length),
    // 125 项 1/项 2: the rotation identity + world diff ride the dual's
    // header too (a dual boundary is a window rotation like any other).
    options.windowIdentity,
    options.worldDiff,
  );
  return assembleTier2([...split.history, ...split.turnPrefix], split.kept, summaryMessage, options.skillReads, split.prior);
}

// ---------------------------------------------------------------------------
// M52 §1 — manual compaction (/compact): compact NOW, regardless of occupancy.
// Same tier pipeline the loop runs, minus the threshold gate; the reason is
// "manual" all the way down (the event + the compact_boundary session entry).
// ---------------------------------------------------------------------------

export interface ManualCompactResult {
  readonly messages: AgentMessage[];
  readonly summaryMessage?: AgentMessage;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly tier: 0 | 1 | 2;
  readonly reason: "manual";
  /** M52 §1: the fingerprint of the first kept ORIGINAL message — the compact
   *  boundary persisted as a session entry so a resumed session's next
   *  compaction continues the chain from here. */
  readonly firstKeptEntryId?: string;
}

/** FNV-1a fingerprint of one message — the entry id persisted at compact
 *  boundaries (stable across resumes, zero deps). */
export function messageEntryId(m: AgentMessage): string {
  const key = m.role === "tool" ? `tool|${m.toolCallId}|${m.name}|${m.content}` : m.role === "assistant" ? `assistant|${(m.toolCalls ?? []).map((c) => c.id).join(",")}|${m.content}` : `${m.role}|${m.content}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${m.role}-${m.content.length}-${h.toString(16)}`;
}

export async function manualCompact(
  input: {
    readonly systemPrompt: string;
    readonly tools: readonly ModelToolDefinition[];
    readonly messages: readonly AgentMessage[];
    readonly model: ModelClient;
    /** ω99-45: cooperative abort — cancels the summarizer mid-flight (the
     *  signal reaches the provider fetch) and guarantees no boundary lands;
     *  abort-shaped throws propagate to the caller. Absent = today's
     *  behavior, byte-for-byte. */
    readonly signal?: AbortSignal;
  },
  options: Tier2Options = {},
): Promise<ManualCompactResult | null> {
  const { systemPrompt, tools, model, signal } = input;
  // ω99-45: entry phase check — a cancelled compact never starts work.
  throwIfAborted(signal);
  const messages = [...input.messages];
  const before = estimateTokens(systemPrompt, tools, messages);
  // Tier 2 first (it subsumes the cheaper tiers for a manual compact — the
  // user asked for a summary boundary, not a shave); static fallback keeps a
  // down provider from killing the manual compact.
  let t2: Tier2Result | null;
  try {
    t2 = await tier2Compact(messages, model, options, signal);
  } catch (err) {
    // ω99-45: an abort goes THROUGH — the static fallback below is the M47
    // down-provider degrade, and running it after the user cancelled would be
    // more work after a request for less (never a boundary from an abort).
    if (signal?.aborted || isAbortError(err)) throw err;
    t2 = staticTier2Compact(messages, options);
  }
  if (t2 === null) {
    try {
      t2 = await dualTier2Compact(messages, model, options, signal);
    } catch (err) {
      // ω99-45: same direct-through for the dual path — the free tiers below
      // are work too, and a cancelled compact must not fall into them.
      if (signal?.aborted || isAbortError(err)) throw err;
      t2 = null;
    }
  }
  // ω99-45: post-summary phase boundary — a summary that completed while the
  // abort fired never lands; the caller sees the abort, history stays put.
  throwIfAborted(signal);
  if (t2 !== null) {
    const kept = t2.messages.filter((m) => !(m.role === "user" && m.content.startsWith(SUMMARY_MARKER)));
    return {
      messages: t2.messages,
      summaryMessage: t2.summaryMessage,
      beforeTokens: before,
      afterTokens: estimateTokens(systemPrompt, tools, t2.messages),
      tier: 2,
      reason: "manual",
      // When the window was one entire pair-chain (kept empty), the boundary
      // is the summary itself — resume continues the chain after it.
      firstKeptEntryId: messageEntryId(kept[0] ?? t2.summaryMessage),
    };
  }
  // No span and no dual partition — fall back to the free tiers. ω99-45: an
  // abort skips them too (phase check) — a cancelled compact does no work.
  throwIfAborted(signal);
  const cleared = clearTier(messages, { ...options, skillReads: options.skillReads });
  const stubbed = microcompact(cleared.messages, options);
  const after = estimateTokens(systemPrompt, tools, stubbed);
  if (after >= before) return null;
  return {
    messages: stubbed,
    beforeTokens: before,
    afterTokens: after,
    tier: after < estimateTokens(systemPrompt, tools, cleared.messages) ? 1 : 0,
    reason: "manual",
  };
}

// ---------------------------------------------------------------------------
// M52 §3 — the occupancy breakdown ctx_inspect and /context share: the model's
// token budget, split by segment, with the compaction-state counts. Pure.
// ---------------------------------------------------------------------------

export interface OccupancyBreakdown {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  /** R5-I1 — the image estimate across every `m.images` rider (0 when none);
   *  counted in totalTokens but NOT in messagesByRole (that split stays
   *  text-only chars/4 by role). */
  readonly imagesTokens: number;
  /** R5-I1 — how many images ride the message list (the count shown next to
   *  the estimate by ctx_inspect and /context). */
  readonly imageCount: number;
  readonly totalTokens: number;
  readonly messagesByRole: { readonly user: number; readonly assistant: number; readonly tool: number };
  readonly compaction: { readonly summaries: number; readonly stubbed: number; readonly cleared: number; readonly skillPruned: number; /** ω-2b (I2-b): emergency-drop markers in the list. */ readonly emergency: number };
  readonly messageCount: number;
}

export function occupancyBreakdown(
  systemPrompt: string,
  tools: readonly ModelToolDefinition[],
  messages: readonly AgentMessage[],
): OccupancyBreakdown {
  // ω-1: script-aware per section (ceil of charCountTokens) — ctx_inspect and
  // /context keep agreeing with the compaction watermark on CJK payloads too.
  const tokensFor = (c: CharCount): number => Math.ceil(charCountTokens(c));
  const toolCount = countChars(tools.map((t) => JSON.stringify(t)).join(""));
  let msgUnits = 0;
  let msgCjkChars = 0;
  let msgCjkUnits = 0;
  const byRole = { user: 0, assistant: 0, tool: 0 };
  const compaction = { summaries: 0, stubbed: 0, cleared: 0, skillPruned: 0, emergency: 0 };
  let imagesTokens = 0;
  let imageCount = 0;
  for (const m of messages) {
    const count = messageCharCount(m);
    msgUnits += count.units;
    msgCjkChars += count.cjkChars;
    msgCjkUnits += count.cjkUnits;
    const images = m.role === "assistant" ? undefined : m.images;
    if (images !== undefined) {
      imagesTokens += messageImagesTokens(m);
      imageCount += images.length;
    }
    if (m.role === "user" || m.role === "assistant") byRole[m.role] += tokensFor(count);
    else {
      byRole.tool += tokensFor(count);
      // ω-2b (I3): tier-0 clear markers now carry a pointer line — the exact
      // equality becomes a prefix check (the marker's sole consumer).
      if (m.content.startsWith(CLEARED_MARKER)) compaction.cleared += 1;
      else if (m.content.startsWith(COMPACTION_STUB_PREFIX)) compaction.stubbed += 1;
      else if (m.content.startsWith(SKILL_PRUNED_PREFIX)) compaction.skillPruned += 1;
    }
    if (m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) compaction.summaries += 1;
    // ω-2b (I2-b): the emergency drop marker is a user message — count it.
    if (m.content.startsWith(EMERGENCY_DROP_PREFIX)) compaction.emergency += 1;
  }
  const systemTokens = tokensFor(countChars(systemPrompt));
  const toolsTokens = tokensFor(toolCount);
  const messagesTokens = tokensFor({ units: msgUnits, cjkChars: msgCjkChars, cjkUnits: msgCjkUnits });
  return {
    systemTokens,
    toolsTokens,
    messagesTokens,
    imagesTokens,
    imageCount,
    totalTokens: systemTokens + toolsTokens + messagesTokens + imagesTokens,
    messagesByRole: byRole,
    compaction,
    messageCount: messages.length,
  };
}
