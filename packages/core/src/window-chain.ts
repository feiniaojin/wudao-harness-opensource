// 125 项 1/项 2（the upstream projectauto_compact_window.rs / world_state 形）— 窗口身份链 +
// WorldState 差分，两个 baton-pass 件的纯函数域。设计依据：
// docs/research/125-infinite-task-architecture.md §1.1。
//
// 窗口身份链：每次 tier-2 压缩都是一次窗口轮转。the upstream project给每个新窗口一个 UUID
// 身份（first/prev/current 链）且对模型可见；wudao 的等价物不需要独立 UUID——
// 同一 session 内窗口链由「session id 短前缀 + 序号」唯一标识（uuid8#N 形），
// 序号 N = 已落盘 compact_boundary 条目数 + 1。身份行骑在 summary message 头部
// （SUMMARY_MARKER 之后、正文之前）——压缩边界本来就要重写前缀，这是 M24 已
// 声明的缓存代价面，身份行不产生任何额外代价（红线声明）。
//
// WorldState 差分：轮转的连续性不靠摘要转述，靠「世界状态变了什么」。纯函数
// worldStateDiff(prev, curr) 产出两个快照的差异文本（≤500 字），注入 summary
// message 头部（身份行之下）；快照本体作为 additive 字段落在 compact_boundary
// 条目上，跨 resume 由条目重建。
//
// 依赖方向：window-chain → compaction-markers（capToLineBoundary）+ types（纯
// 类型），无环；riders/tier2-static/loop 经由本模块组装，CLI 层只消费类型与
// 纯函数。
import type { AgentMessage } from "./types.js";
import { capToLineBoundary } from "./compaction-markers.js";

// ---------------------------------------------------------------------------
// 125 项 1 — 窗口身份链
// ---------------------------------------------------------------------------

/** The identity of one context window in the session's rotation chain. */
export interface WindowIdentity {
  /** 1-based window index (compact_boundary entries so far + 1). */
  readonly index: number;
  /** The short session key (session id's 8-char prefix) — the chain is
   *  unique within one session as `<sessionKey>#<index>`. */
  readonly sessionKey: string;
}

/** How many chain elements render verbatim before the middle elides. */
const WINDOW_CHAIN_FULL_CAP = 10;

/** The window id of index N: `<sessionKey>#N`. */
export function windowId(identity: WindowIdentity): string {
  return `${identity.sessionKey}#${identity.index}`;
}

/** The chain rendering `#1→#2→…→#N` (middle elided past the full cap). Pure. */
function windowChainOf(index: number): string {
  if (index <= WINDOW_CHAIN_FULL_CAP) {
    return Array.from({ length: index }, (_, i) => `#${i + 1}`).join("→");
  }
  return `#1→#2→…→#${index - 1}→#${index}`;
}

/** 125 项 1: the window identity line riding the tier-2 summary message
 *  header — `[context window #N | chain: #1→…→#N | first: k#1 | prev:
 *  k#(N-1)]` (prev absent on the first window). Always ends with `\n` so
 *  the next section starts on its own line. Pure; deterministic per
 *  (index, sessionKey). */
export function windowIdentityLine(identity: WindowIdentity): string {
  const head = `[context window #${identity.index} | chain: ${windowChainOf(identity.index)} | first: ${identity.sessionKey}#1`;
  const prev = identity.index > 1 ? ` | prev: ${identity.sessionKey}#${identity.index - 1}` : "";
  return `${head}${prev}]\n`;
}

/** The composed identity section for a tier-2 summary: the line above, or ""
 *  when no identity rides the boundary (the status-quo bytes escape —
 *  pre-125 callers and every identity-less path keep byte-identical
 *  summaries). Pure. */
export function windowIdentitySection(identity: WindowIdentity | undefined): string {
  return identity === undefined ? "" : windowIdentityLine(identity);
}

// ---------------------------------------------------------------------------
// 125 项 2 — WorldState 快照 + 差分
// ---------------------------------------------------------------------------

/** The world snapshot at one window's rotation: the typed facts a surviving
 *  model must not lose across the boundary (goal state + file footprint +
 *  active toolset). All fields mechanically derived — nothing here is
 *  LLM-dependent, so the diff survives where a summary would be lossy. */
export interface WorldState {
  /** The live goal's objective (absent = no live goal). */
  readonly goalSummary?: string;
  /** The live goal's tokens used so far (absent = no live goal). */
  readonly goalBudgetUsed?: number;
  /** The session-cumulative set of files changed (write/edit ledger). */
  readonly changedFiles: readonly string[];
  /** Distinct tool names in recent use (last-seen order). */
  readonly activeTools: readonly string[];
}

/** The diff text cap — the whole injected block stays ≤500 chars (红线). */
export const WORLD_DIFF_CAP_CHARS = 500;
/** Cap on a quoted goal summary inside the diff (both arms). */
const GOAL_SUMMARY_CAP_CHARS = 60;
/** Cap on listed tool names per direction inside the diff. */
const TOOLS_LISTED_CAP = 5;
/** Cap on the activeTools snapshot itself (driver-side extractor bound). */
export const ACTIVE_TOOLS_CAP = 8;

const fmtNum = (n: number | undefined): string => (n === undefined ? "—" : `${n}`);

/** 125 项 2: the difference text of two world snapshots — indented body
 *  lines (`  goal: …`, `  files: +N changed, -M reverted`, `  tools: …`),
 *  "" when the snapshots are semantically identical (no injection). Pure,
 *  deterministic, capped at WORLD_DIFF_CAP_CHARS. */
export function worldStateDiff(prev: WorldState, curr: WorldState): string {
  const lines: string[] = [];
  // Defensive array read: a hand-built snapshot skipping the lists degrades
  // to empty sets (the parse-side discipline, applied at the diff seam too).
  const files = (w: WorldState): readonly string[] => w.changedFiles ?? [];
  const tools = (w: WorldState): readonly string[] => w.activeTools ?? [];
  // goal — the objective changing hands (set/cleared/reworded).
  if (prev.goalSummary !== curr.goalSummary) {
    const p = prev.goalSummary === undefined ? undefined : capToLineBoundary(prev.goalSummary, GOAL_SUMMARY_CAP_CHARS);
    const c = curr.goalSummary === undefined ? undefined : capToLineBoundary(curr.goalSummary, GOAL_SUMMARY_CAP_CHARS);
    if (p === undefined) lines.push(`  goal: now tracking "${c ?? ""}"`);
    else if (c === undefined) lines.push(`  goal: no longer tracking "${p}"`);
    else lines.push(`  goal: "${p}" → "${c}"`);
  }
  // budget — the goal's burn crossing the boundary.
  if (prev.goalBudgetUsed !== curr.goalBudgetUsed) {
    const delta =
      prev.goalBudgetUsed !== undefined && curr.goalBudgetUsed !== undefined
        ? ` (${curr.goalBudgetUsed >= prev.goalBudgetUsed ? "+" : ""}${curr.goalBudgetUsed - prev.goalBudgetUsed})`
        : "";
    lines.push(`  goal budget: ${fmtNum(prev.goalBudgetUsed)} → ${fmtNum(curr.goalBudgetUsed)} tokens used${delta}`);
  }
  // files — set difference of the cumulative changed-file ledger: newly
  // changed (+N) and dropped-from-the-ledger (-M, i.e. reverted windows).
  const filesAdded = files(curr).filter((f) => !files(prev).includes(f));
  const filesReverted = files(prev).filter((f) => !files(curr).includes(f));
  if (filesAdded.length > 0 || filesReverted.length > 0) {
    const parts: string[] = [];
    if (filesAdded.length > 0) parts.push(`+${filesAdded.length} changed`);
    if (filesReverted.length > 0) parts.push(`-${filesReverted.length} reverted`);
    lines.push(`  files: ${parts.join(", ")}`);
  }
  // tools — the active toolset shifting across the boundary.
  const toolsAdded = tools(curr).filter((t) => !tools(prev).includes(t));
  const toolsDropped = tools(prev).filter((t) => !tools(curr).includes(t));
  if (toolsAdded.length > 0 || toolsDropped.length > 0) {
    const listed = (names: readonly string[], sign: "+" | "-"): string => {
      const head = names.slice(0, TOOLS_LISTED_CAP).map((n) => `${sign}${n}`);
      const tail = names.length > TOOLS_LISTED_CAP ? [`${sign}…(${names.length - TOOLS_LISTED_CAP} more)`] : [];
      return [...head, ...tail].join(", ");
    };
    const parts: string[] = [];
    if (toolsAdded.length > 0) parts.push(listed(toolsAdded, "+"));
    if (toolsDropped.length > 0) parts.push(listed(toolsDropped, "-"));
    lines.push(`  tools: ${parts.join("; ")}`);
  }
  if (lines.length === 0) return "";
  return capToLineBoundary(lines.join("\n"), WORLD_DIFF_CAP_CHARS);
}

/** 125 项 2: the composed diff section for a tier-2 summary — the
 *  `[world diff since window #K]` header (K = the window the diff is
 *  against, i.e. identity.index - 1) over the diff body, capped at
 *  WORLD_DIFF_CAP_CHARS as a WHOLE (header included — the injected block is
 *  ≤500 chars, period). "" when the diff is empty (no injection — the
 *  first compaction has no previous snapshot, behavior unchanged). Pure. */
export function worldDiffSection(diff: string | undefined, identity: WindowIdentity | undefined): string {
  // Emptiness is judged on the TRIMMED text, but the EMBEDDED body is the
  // original (trimEnd only) — worldStateDiff's per-line indentation is part
  // of the contract and a leading-trim would flatten the first line.
  const body = (diff ?? "").trimEnd();
  if (body.trim() === "") return "";
  const head =
    identity !== undefined && identity.index > 1
      ? `[world diff since window #${identity.index - 1}]`
      : "[world diff since the previous window]";
  return `${capToLineBoundary(`${head}\n${body}`, WORLD_DIFF_CAP_CHARS)}\n`;
}

// ---------------------------------------------------------------------------
// 125 项 2 — 机械提取面（driver 侧快照的确定性构件）
// ---------------------------------------------------------------------------

/** The distinct tool names of the recent working set — last-seen order over
 *  the assistant tool_calls of the trailing messages, capped at
 *  ACTIVE_TOOLS_CAP. Pure; resume-stable (a pure function of the message
 *  chain). */
export function activeToolsOf(messages: readonly AgentMessage[], recentN: number = 40): string[] {
  const seen: string[] = [];
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - recentN; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "assistant" || m.toolCalls === undefined) continue;
    for (let j = m.toolCalls.length - 1; j >= 0; j -= 1) {
      const name = m.toolCalls[j]?.name;
      if (typeof name === "string" && name !== "" && !seen.includes(name)) seen.push(name);
      if (seen.length >= ACTIVE_TOOLS_CAP) return seen;
    }
  }
  return seen;
}

/** 125 项 2: parse a WorldState back off a compact_boundary entry's payload.
 *  Per-field fail-safe (the goal-gate discipline): changedFiles/activeTools
 *  must be string arrays or the whole snapshot drops (never a half-typed
 *  lie); the optional goal fields drop individually on a bad shape.
 *  undefined = no snapshot on the row (pre-125 rows). Pure. */
export function parseWorldStateData(raw: unknown): WorldState | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const strArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined;
  const changedFiles = strArray(r.changedFiles);
  const activeTools = strArray(r.activeTools);
  if (changedFiles === undefined || activeTools === undefined) return undefined;
  const goalSummary = typeof r.goalSummary === "string" && r.goalSummary !== "" ? r.goalSummary : undefined;
  const goalBudgetUsed =
    typeof r.goalBudgetUsed === "number" && Number.isFinite(r.goalBudgetUsed) && r.goalBudgetUsed >= 0
      ? r.goalBudgetUsed
      : undefined;
  return {
    ...(goalSummary !== undefined ? { goalSummary } : {}),
    ...(goalBudgetUsed !== undefined ? { goalBudgetUsed } : {}),
    changedFiles,
    activeTools,
  };
}
