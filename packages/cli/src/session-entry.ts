// M35 §2 — appendEntry, the CLI wrapper. The session store accepts GENERIC
// non-message entries ({type, data} rides the same JSONL as messages and
// model-state entries, filtered out of the model-visible history on load).
// This module is the thin, typed front door the frontends (and future
// extensions) use: build the entry, persist it, count it back on resume.
import { truncateSafe, parseWorldStateData, type WorldState } from "@wudao/core"; // 113-A4
import { ACTIVE_BRANCH_ENTRY_TYPE, type ActiveBranchData, type GenericSessionEntry, type ModelUsage, type SessionEntry, type SessionStore } from "@wudao/core";

/** M61 §3 — /goal session entries: the goal's durable record. goal_set marks
 *  an active goal; goal_outcome closes it (achieved | failed | cleared, ω99-13
 *  adds budget_limited — the token ceiling's forced close). On
 *  resume the latest set without a following outcome is the active goal
 *  (counters/timing/token baseline reset per spec). */
export const GOAL_SET_TYPE = "goal_set";
export const GOAL_OUTCOME_TYPE = "goal_outcome";

export interface GoalSetData {
  readonly condition: string;
  readonly at: string;
  /** ω99-14 — the gate command's raw text (≤500 chars — validated at set
   *  time AND re-validated on read; a hand-edited/corrupt JSONL field is
   *  DROPPED, degrading the goal to condition-only instead of corrupting
   *  the run). Absent = the goal runs un-gated. */
  readonly gate?: string;
  /** ω99-14 — the goal's main-call token ceiling (positive integer). Absent
   *  = unbudgeted. */
  readonly budgetTokens?: number;
}

export interface GoalOutcomeData {
  readonly outcome: "achieved" | "failed" | "cleared" | "budget_limited";
  readonly reason?: string;
  /** ω99-13 — the budget wrap-up's usage report (`tokens used X of budget;
   *  continuations Y; duration Zs`, prime completionBudgetReport pattern).
   *  Present on budget_limited entries only. */
  readonly usageReport?: string;
  readonly at: string;
}

export function buildGoalSetEntry(
  condition: string,
  at: Date = new Date(),
  options?: { readonly gate?: string; readonly budgetTokens?: number },
): GenericSessionEntry {
  // ω99-14 — the constraints ride the entry (additive; absent when unset, so
  // old readers and old entries stay byte-compatible).
  return {
    type: GOAL_SET_TYPE,
    data: {
      condition,
      at: at.toISOString(),
      ...(options?.gate !== undefined && options.gate !== "" ? { gate: options.gate } : {}),
      ...(options?.budgetTokens !== undefined ? { budgetTokens: options.budgetTokens } : {}),
    } satisfies GoalSetData,
  };
}

export function buildGoalOutcomeEntry(outcome: "achieved" | "failed" | "cleared" | "budget_limited", reason?: string, at: Date = new Date(), usageReport?: string): GenericSessionEntry {
  return {
    type: GOAL_OUTCOME_TYPE,
    data: {
      outcome,
      ...(reason !== undefined && reason !== "" ? { reason } : {}),
      ...(usageReport !== undefined && usageReport !== "" ? { usageReport } : {}),
      at: at.toISOString(),
    } satisfies GoalOutcomeData,
  };
}

/** The session's ACTIVE goal (latest goal_set not yet closed by an outcome),
 *  or undefined — the resume projection for /goal. */
export function activeGoalFromEntries(entries: readonly SessionEntry[]): GoalSetData | undefined {
  let active: GoalSetData | undefined;
  for (const e of entries) {
    if ("role" in e) continue;
    if (e.type === GOAL_SET_TYPE) {
      const d = e.data as Partial<GoalSetData>;
      if (typeof d.condition === "string") {
        // ω99-14 — per-field fail-safe (mirrors goal.ts's GOAL_GATE_MAX_CHARS;
        // duplicated here because goal.ts imports this module): gate must be
        // a non-empty ≤500-char string, budgetTokens a positive integer. A
        // field that fails is DROPPED (condition-only goal), never thrown —
        // a hand-edited or corrupt JSONL degrades honestly.
        const gate = typeof d.gate === "string" && d.gate.length > 0 && d.gate.length <= 500 ? d.gate : undefined;
        const budgetTokens =
          typeof d.budgetTokens === "number" && Number.isInteger(d.budgetTokens) && d.budgetTokens > 0 ? d.budgetTokens : undefined;
        active = {
          condition: d.condition,
          at: typeof d.at === "string" ? d.at : "",
          ...(gate !== undefined ? { gate } : {}),
          ...(budgetTokens !== undefined ? { budgetTokens } : {}),
        };
      }
    } else if (e.type === GOAL_OUTCOME_TYPE) {
      active = undefined;
    }
  }
  return active;
}

/** The receipt recorded when the run's one load_tools call applied. */
export const DEFERRED_LOADED_TYPE = "deferred_loaded";

export interface DeferredLoadedData {
  /** The deferred tool names whose definitions joined the tools array. */
  readonly names: readonly string[];
}

export function buildDeferredLoadedEntry(names: readonly string[]): GenericSessionEntry {
  return { type: DEFERRED_LOADED_TYPE, data: { names: [...names] } satisfies DeferredLoadedData };
}

/** ω-4b — the loop-safety reflection fork's receipt: the challenger's
 *  adjudication at the run's second loop verdict, recorded where it
 *  happened. Audit-only on resume (a GenericSessionEntry — load() filters it
 *  from the model-visible history); the directive itself is deliberately
 *  ephemeral (MetaNote projection), so this entry is its durable record. */
export const LOOP_REFLECTION_TYPE = "loop_reflection";

export interface LoopReflectionEntryInfo {
  /** The detector kind that fired the second verdict. */
  readonly kind: string;
  /** The DETECTOR's evidence (authoritative in every outcome). */
  readonly evidence: string;
  /** The challenger's adjudication. */
  readonly outcome: "recoverable" | "stuck" | "unavailable";
  readonly rationale?: string;
  /** The directive note — present only on "recoverable". */
  readonly directive?: string;
  readonly turn: number;
  /** The fork call's usage row (reflectionTokens-stamped), when reported. */
  readonly usage?: ModelUsage;
}

export interface LoopReflectionData {
  readonly kind: string;
  readonly evidence: string;
  readonly outcome: "recoverable" | "stuck" | "unavailable";
  readonly rationale?: string;
  readonly directive?: string;
  readonly turn: number;
  readonly usage?: {
    readonly promptTokens: number;
    readonly completionTokens?: number;
    readonly cacheHitTokens?: number;
    readonly reflectionTokens?: number;
  };
}

export function buildLoopReflectionEntry(info: LoopReflectionEntryInfo): GenericSessionEntry {
  return {
    type: LOOP_REFLECTION_TYPE,
    data: {
      kind: info.kind,
      evidence: info.evidence,
      outcome: info.outcome,
      ...(info.rationale !== undefined ? { rationale: info.rationale } : {}),
      ...(info.directive !== undefined ? { directive: info.directive } : {}),
      turn: info.turn,
      ...(info.usage !== undefined
        ? {
            usage: {
              promptTokens: info.usage.promptTokens,
              ...(info.usage.completionTokens !== undefined ? { completionTokens: info.usage.completionTokens } : {}),
              ...(info.usage.cacheHitTokens !== undefined ? { cacheHitTokens: info.usage.cacheHitTokens } : {}),
              ...(info.usage.reflectionTokens !== undefined ? { reflectionTokens: info.usage.reflectionTokens } : {}),
            },
          }
        : {}),
    } satisfies LoopReflectionData,
  };
}

/** M52 §1 — the compact boundary, recorded as a SESSION ENTRY (not embedded
 *  in a message): every tier-2 compaction appends `{type: compact_boundary,
 *  data:{firstKeptEntryId, …}}` next to its frozen summary message. On resume
 *  the entry is the durable record of where the current chain's kept region
 *  began — the next compaction continues the chain from that boundary instead
 *  of re-summarizing it. `firstKeptEntryId` is core's messageEntryId
 *  fingerprint of the first kept ORIGINAL message. */
export const COMPACT_BOUNDARY_TYPE = "compact_boundary";

export interface CompactBoundaryData {
  /** Fingerprint (core messageEntryId) of the first kept original message. */
  readonly firstKeptEntryId: string;
  /** Why compaction fired: manual (/compact), threshold, overflow. */
  readonly reason: string;
  /** The compaction tier that produced the boundary (always 2). */
  readonly tier: number;
  /** ISO timestamp. */
  readonly at: string;
  /** 125 项 1（the upstream project窗口链）— the window index this boundary OPENED
   *  (compact_boundary rows so far + 1). Additive: absent on pre-125 rows =
   *  no window concept, behavior unchanged. */
  readonly windowIndex?: number;
  /** 125 项 2（the upstream projectWorldState）— the world snapshot AT the rotation (goal
   *  state + cumulative changed files + active tools); the diff baseline for
   *  the NEXT window's boundary. Additive: absent on pre-125 rows. */
  readonly worldState?: WorldState;
}

/** ω99-14-style per-field fail-safe for the boundary's additive fields: a
 *  hand-edited/corrupt field DROPS (degrades to the pre-125 shape) instead
 *  of corrupting the chain reconstruction. */
const validWindowIndex = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;

export function buildCompactBoundaryEntry(info: {
  readonly firstKeptEntryId: string;
  readonly reason: string;
  readonly tier: number;
  readonly windowIndex?: number;
  readonly worldState?: WorldState;
}): GenericSessionEntry {
  return {
    type: COMPACT_BOUNDARY_TYPE,
    data: {
      firstKeptEntryId: info.firstKeptEntryId,
      reason: info.reason,
      tier: info.tier,
      at: new Date().toISOString(),
      // 125 项 1/项 2: additive fields — omitted when absent, so old readers
      // and old sessions keep the exact pre-125 bytes.
      ...(info.windowIndex !== undefined ? { windowIndex: info.windowIndex } : {}),
      ...(info.worldState !== undefined ? { worldState: info.worldState } : {}),
    } satisfies CompactBoundaryData,
  };
}

/** The most recent compact boundary in a loaded entry list (the current chain
 *  head), or undefined when the session never compacted. 125 项 1/项 2: the
 *  additive window fields ride back when present and well-formed. */
export function lastCompactBoundary(entries: readonly SessionEntry[]): CompactBoundaryData | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e !== undefined && !("role" in e) && e.type === COMPACT_BOUNDARY_TYPE) {
      const d = e.data as Partial<CompactBoundaryData>;
      if (typeof d.firstKeptEntryId === "string") {
        const windowIndex = validWindowIndex(d.windowIndex);
        const worldState = parseWorldStateData(d.worldState);
        return {
          firstKeptEntryId: d.firstKeptEntryId,
          reason: typeof d.reason === "string" ? d.reason : "",
          tier: typeof d.tier === "number" ? d.tier : 2,
          at: typeof d.at === "string" ? d.at : "",
          ...(windowIndex !== undefined ? { windowIndex } : {}),
          ...(worldState !== undefined ? { worldState } : {}),
        };
      }
    }
  }
  return undefined;
}

/** 125 项 1/项 2 — the window chain rebuilt from session entries (the
 *  receiptAnchorsFromEntries 同族读取): how many rotation boundaries the
 *  session has landed (the count — authoritative even for pre-125 rows, which
 *  carry no windowIndex but ARE boundaries) plus the last boundary's additive
 *  window fields (the next rotation's identity index and diff baseline). */
export interface WindowChainInfo {
  /** compact_boundary rows in file order — the next window opens at
   *  boundaryCount + 1. */
  readonly boundaryCount: number;
  /** The last boundary's windowIndex, when any row carried a valid one. */
  readonly lastWindowIndex?: number;
  /** The last boundary's world snapshot, when any row carried a valid one. */
  readonly lastWorldState?: WorldState;
}

export function windowChainFromEntries(entries: readonly SessionEntry[]): WindowChainInfo {
  let boundaryCount = 0;
  let lastWindowIndex: number | undefined;
  let lastWorldState: WorldState | undefined;
  for (const e of entries) {
    if ("role" in e) continue;
    if (e.type !== COMPACT_BOUNDARY_TYPE) continue;
    const d = e.data as Partial<CompactBoundaryData>;
    // The same malformed-row guard as lastCompactBoundary: a row without a
    // string firstKeptEntryId never counted as a boundary.
    if (typeof d.firstKeptEntryId !== "string") continue;
    boundaryCount += 1;
    const wi = validWindowIndex(d.windowIndex);
    if (wi !== undefined) lastWindowIndex = wi;
    const ws = parseWorldStateData(d.worldState);
    if (ws !== undefined) lastWorldState = ws;
  }
  return {
    boundaryCount,
    ...(lastWindowIndex !== undefined ? { lastWindowIndex } : {}),
    ...(lastWorldState !== undefined ? { lastWorldState } : {}),
  };
}

/** M80 — the clear boundary. A /clear never truncates the JSONL (the
 * append-only invariant): the PRE-clear id's file keeps every byte and gains
 * one `{type: clear_boundary, data:{nextSessionId, at}}` entry — the durable
 * record that the conversation moved to a fresh segment id at that point.
 * load() filters it out of the model-visible history like every generic
 * entry, so resuming the pre-clear id still reaches the old content exactly
 * as it was. */
export const CLEAR_BOUNDARY_TYPE = "clear_boundary";

export interface ClearBoundaryData {
  /** The fresh session id the conversation continues in after the clear. */
  readonly nextSessionId: string;
  /** ISO timestamp of the clear. */
  readonly at: string;
}

export function buildClearBoundaryEntry(nextSessionId: string): GenericSessionEntry {
  return { type: CLEAR_BOUNDARY_TYPE, data: { nextSessionId, at: new Date().toISOString() } satisfies ClearBoundaryData };
}

/** ω-5a I19 — the context-window identity receipt. The CLI cache wrapper
 *  mints one `context_window_id` per process (resume mints fresh — a resumed
 *  prefix is presumptively cold) and ADVANCES it on any structural prefix
 *  change (compaction, /edit branch cut, provider-switch rebuild — the
 *  serialization-diff signal, never append-only growth). Every advance
 *  appends this generic entry to the session JSONL, giving the M58 §A cold
 *  turns a joinable window identity. The id is wrapper-minted only (reserved
 *  against override: never in ModelInput, never from client/session data);
 *  load() filters this entry out of model-visible history like every
 *  generic entry. */
export const CONTEXT_WINDOW_TYPE = "context_window";

export interface ContextWindowFirstCall {
  readonly promptTokens: number;
  readonly cacheHitTokens: number;
  readonly coldTurnExpected?: true;
  readonly cacheBreakAttribution?: string;
}

export interface ContextWindowData {
  readonly id: string;
  /** The predecessor window id (absent on a mint receipt — the wrapper only
   *  reports advances today, so present in practice). */
  readonly advancedFrom?: string;
  readonly divergedAt?: string;
  readonly at: string;
  /** First usage row observed on this window — the M24 attribution join. */
  readonly firstCall?: ContextWindowFirstCall;
}

export interface ContextWindowEntryInfo {
  readonly id: string;
  readonly advancedFrom?: string;
  readonly divergedAt?: string;
  readonly firstCall?: ContextWindowFirstCall;
  /** ISO timestamp; defaults to now. */
  readonly at?: string;
}

export function buildContextWindowEntry(info: ContextWindowEntryInfo): GenericSessionEntry {
  return {
    type: CONTEXT_WINDOW_TYPE,
    data: {
      id: info.id,
      ...(info.advancedFrom !== undefined ? { advancedFrom: info.advancedFrom } : {}),
      ...(info.divergedAt !== undefined ? { divergedAt: info.divergedAt } : {}),
      at: info.at ?? new Date().toISOString(),
      ...(info.firstCall !== undefined ? { firstCall: info.firstCall } : {}),
    } satisfies ContextWindowData,
  };
}

/** Append one generic non-message entry (fire-and-forget safe: the caller
 *  decides whether a failure is worth surfacing). */
export async function appendSessionEntry(
  store: Pick<SessionStore, "appendEntry">,
  sessionId: string,
  entry: GenericSessionEntry,
): Promise<void> {
  await store.appendEntry(sessionId, entry);
}

/** M53 review fix — the ACTIVE branch marker. The JSONL keeps trunk +
 *  abandoned + branch in file order; a linear load flattens them into one
 *  conversation. The driver appends this entry at /edit branch cuts and
 *  /switch; resolveSession and driver.resume walk parentUuid from the
 *  recorded leaf (falling back to the linear-last chain when absent/corrupt).
 */
export function buildActiveBranchEntry(leafKey: string): GenericSessionEntry {
  return { type: ACTIVE_BRANCH_ENTRY_TYPE, data: { leafKey } satisfies ActiveBranchData };
}

/** P2-10 (96 队列) — the conversation-rewind receipt. `/rewind turn <n>` swaps
 *  the active chain to before message n (branch semantics: the rewound turns
 *  stay in the file — this entry audits the cut, it never rewrites history).
 *  Audit-only on resume (a GenericSessionEntry — load() filters it out of
 *  model-visible history like every generic entry). */
export const REWIND_TURN_TYPE = "rewind_turn";

export interface RewindTurnData {
  /** The 1-based message number the user rewound before (1 = most recent). */
  readonly n: number;
  /** Active-chain message count before / after the swap. */
  readonly fromMessages: number;
  readonly toMessages: number;
  readonly at: string;
}

export interface RewindTurnEntryInfo {
  readonly n: number;
  readonly fromMessages: number;
  readonly toMessages: number;
  /** ISO timestamp; defaults to now. */
  readonly at?: string;
}

export function buildRewindTurnEntry(info: RewindTurnEntryInfo): GenericSessionEntry {
  return {
    type: REWIND_TURN_TYPE,
    data: {
      n: info.n,
      fromMessages: info.fromMessages,
      toMessages: info.toMessages,
      at: info.at ?? new Date().toISOString(),
    } satisfies RewindTurnData,
  };
}

/** Count entries of one type (e.g. the TUI status bar's deferred_loaded
 *  count on a resumed session). */
export function countEntriesOfType(entries: readonly SessionEntry[], type: string): number {
  return entries.reduce((n, e) => (!("role" in e) && e.type === type ? n + 1 : n), 0);
}

/** P2-12（96 队列 #12）— 持久 PTY 工具的审计条目：全动作记一条（含被拒
 *  绝前的合法调用面——校验通过即记，副作用成败不影响审计）。command 只
 *  记首行且 ≤200 字符（多行/超长截断带标记）；input 记原文——控制字符
 *  的"转义形"由 JSONL 序列化面保证（JSON.stringify 把 \x03 写成
 *  ，审计可读且不可注入换行）。Audit-only on resume（load() 过滤
 *  出模型可见历史，同 rewind_turn）。 */
export const TERMINAL_ENTRY_TYPE = "terminal";

/** 审计条目的命令首行预算。 */
const TERMINAL_COMMAND_MAX_CHARS = 200;

export interface TerminalEntryData {
  readonly action: "run" | "send" | "read" | "interrupt" | "exit";
  readonly session: string;
  /** run only：命令首行，≤200 字符（截断带 …）。 */
  readonly command?: string;
  /** send only：原文（控制字符的转义发生在 JSONL 序列化）。 */
  readonly input?: string;
  /** read only：请求的行数（缺省 50 / 上限 200 之后的生效值）。 */
  readonly lines?: number;
  readonly at: string;
}

export function buildTerminalEntry(info: {
  readonly action: TerminalEntryData["action"];
  readonly session: string;
  readonly command?: string;
  readonly input?: string;
  readonly lines?: number;
  /** ISO timestamp; defaults to now. */
  readonly at?: string;
}): GenericSessionEntry {
  const firstLine = (text: string): string => {
    const line = text.split("\n")[0] ?? "";
    // The FIELD is ≤200 chars including its truncation marker (200 content
    // chars + "…" would overshoot by one).
    return line.length > TERMINAL_COMMAND_MAX_CHARS
      ? `${truncateSafe(line, TERMINAL_COMMAND_MAX_CHARS - 1)}…`
      : line;
  };
  return {
    type: TERMINAL_ENTRY_TYPE,
    data: {
      action: info.action,
      session: info.session,
      ...(info.command !== undefined ? { command: firstLine(info.command) } : {}),
      ...(info.input !== undefined ? { input: info.input } : {}),
      ...(info.lines !== undefined ? { lines: info.lines } : {}),
      at: info.at ?? new Date().toISOString(),
    } satisfies TerminalEntryData,
  };
}
