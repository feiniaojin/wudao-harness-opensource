// 拆分运动 C：从 compaction.ts 原样外提的 tier-2 摘要骑缝域
//（ω-5b 任务锚定线、M47 §4 尾界标记助手、夜移 030 文件台账、
// 波次 7 #39 verified-work/plan-mode）。依赖方向：riders → markers（无环）。
import type { AgentMessage } from "./types.js";
import { TODO_LINE_MARKS, parseTodoBoard } from "./tools/todo.js";
import { truncateSafe } from "./text-truncate.js";
import { SUMMARY_END_MARKER, SUMMARY_MARKER, capToLineBoundary } from "./compaction-markers.js";

// ω-5b (I22) — auto task-focus (book ch2, r38: compaction summaries must
// re-anchor on the task or the model drifts — "context rot"). The focus seam
// existed (Tier2Options.focus) but only the manual /compact path populated
// it; the auto tiers now DERIVE one: the span's last todo board's
// in_progress item (first pending fallback), else the span's first user
// message capped at 200 chars (the original task). Undefined only when the
// span has neither — the byte-stable status-quo escape. Explicit focus
// (manual /compact) always wins over the derived one.
/** The composed task line's lead: `Task: <focus>` rides the summary message. */
export const SUMMARY_TASK_LEAD = "Task:";
/** Cap on the first-user-message fallback inside the derived focus. */
const AUTO_FOCUS_CAP_CHARS = 200;

/** ω-5b (I22): the derived task focus of a compacted span. Pure. */
export function autoTaskFocus(span: readonly AgentMessage[]): string | undefined {
  // The LAST board in the span is the current one; its in_progress line is
  // what the agent is mid-flight on (the board contract renders activeForm
  // there), the first pending line the next thing to do.
  for (let i = span.length - 1; i >= 0; i -= 1) {
    const m = span[i];
    if (m === undefined) continue;
    const parsed = parseTodoBoard(m.content);
    if (parsed === undefined) continue;
    const inProgress = parsed.lines
      .filter((l) => l.startsWith(TODO_LINE_MARKS.inProgress))
      .map((l) => l.slice(TODO_LINE_MARKS.inProgress.length));
    if (inProgress.length > 0) return inProgress.join("; ");
    const pending = parsed.lines.find((l) => l.startsWith(TODO_LINE_MARKS.pending));
    if (pending !== undefined) return pending.slice(TODO_LINE_MARKS.pending.length);
    break; // an all-done board has nothing to anchor on — first-user fallback
  }
  const firstUser = span.find((m) => m.role === "user");
  if (firstUser === undefined) return undefined;
  const text = capToLineBoundary(firstUser.content, AUTO_FOCUS_CAP_CHARS);
  return text === "" ? undefined : text;
}

/** ω-5b (I22): the focus a tier-2 compaction actually uses — an explicit
 *  non-empty options.focus (manual /compact) wins, else the derived task.
 *  Module-private: both halves of I22 read this ONE seam. */
export const effectiveFocus = (explicit: string | undefined, span: readonly AgentMessage[]): string | undefined =>
  explicit !== undefined && explicit !== "" ? explicit : autoTaskFocus(span);

/** ω-5b (I22): the deterministic task line riding the composed summary —
 *  AFTER the frozen SUMMARY_MARKER (every marker consumer keys on it:
 *  compactableSpan's chain head, applySummaryMarkers, occupancyBreakdown,
 *  the emergency tier's pinned check, the persist filter) and ABOVE the
 *  summarized body, so even a weak summary carries the task verbatim.
 *  Empty string → today's bytes, untouched (the status-quo escape). */
export const taskFocusLine = (focus: string | undefined): string =>
  focus === undefined ? "" : `${SUMMARY_TASK_LEAD} ${focus}\n`;

// ---------------------------------------------------------------------------
// 125 项 1（codex new_context 形）— the agent-rotation identity riders. When the
// MODEL (not the harness threshold) asks for a context rotation, the boundary
// must carry WHY it rotated (the window-identity seam — 125b's window chain is
// the future home of the numbering; until it lands the marker count IS the
// window number) and WHAT it demanded survive (the preserve block rides the
// frozen summary VERBATIM — never routed through the summarizer alone, so a
// down provider or the zero-LLM digest path cannot lose it).
// ---------------------------------------------------------------------------

/** The rotation header's lead — `[context rotated by agent: …]` rides the
 *  frozen summary right after the SUMMARY_MARKER (before the task line), so
 *  every marker consumer keeps keying on the marker prefix untouched. */
export const ROTATION_HEADER_LEAD = "[context rotated by agent:";
/** Cap on the rationale inside the header LINE (the tool-side argument cap is
 *  larger — see tools/new-context.ts; the header is one identity line, not an
 *  essay). */
export const ROTATION_RATIONALE_HEADER_CAP_CHARS = 200;

/** The rotation header line. Undefined rotation → "" (today's bytes). The
 *  rationale is flattened to one line and capped — pure renderer. */
export function rotationHeaderLine(rotation: { readonly rationale: string } | undefined): string {
  if (rotation === undefined) return "";
  const flat = rotation.rationale.replace(/\s+/g, " ").trim();
  const capped = flat.length > ROTATION_RATIONALE_HEADER_CAP_CHARS
    ? `${flat.slice(0, ROTATION_RATIONALE_HEADER_CAP_CHARS - 1)}…`
    : flat;
  return capped === "" ? "" : `${ROTATION_HEADER_LEAD} ${capped}]\n`;
}

/** The preserve block's lead line. */
export const PRESERVED_BY_AGENT_LEAD = "[preserved by agent — carried into the new context verbatim]";

/** The preserve block riding the summary body (after the summarized text,
 *  before the system note). Undefined/empty preserve → "" (today's bytes).
 *  The text rides VERBATIM — the summarizer instruction only ASKS that it be
 *  woven into the narrative; this block is the guarantee. */
export function preserveSection(preserve: string | undefined): string {
  if (preserve === undefined || preserve.trim() === "") return "";
  return `\n${PRESERVED_BY_AGENT_LEAD}\n${preserve.trim()}\n`;
}

/** Read the rotation header back off a composed summary message (the tests'
 *  pin + the future 125b window-identity reader). Returns the rationale only
 *  when the header line sits directly after the marker prefix. Pure. */
export function parseRotationHeader(content: string): string | undefined {
  if (!content.startsWith(SUMMARY_MARKER)) return undefined;
  const rest = content.slice(SUMMARY_MARKER.length);
  if (!rest.startsWith(` ${ROTATION_HEADER_LEAD} `)) return undefined;
  const lineEnd = rest.indexOf("\n");
  const line = lineEnd === -1 ? rest : rest.slice(0, lineEnd);
  const inner = line.slice(` ${ROTATION_HEADER_LEAD} `.length);
  return inner.endsWith("]") ? inner.slice(0, -1) : undefined;
}

/** Strip a trailing end-marker (an LLM echoing the boundary line) so the
 *  composed message can never carry two copies. Pure. */
export function stripSummaryEndMarker(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(SUMMARY_END_MARKER)
    ? trimmed.slice(0, trimmed.length - SUMMARY_END_MARKER.length).trimEnd()
    : text;
}

/** Append the end-marker to a composed summary body, once. Pure. */
export function withSummaryEndMarker(text: string): string {
  return text.trimEnd().endsWith(SUMMARY_END_MARKER) ? text : `${text}\n${SUMMARY_END_MARKER}`;
}

// ---------------------------------------------------------------------------
// 夜移 030 (pi) — the file-operations ledger riding tier-2 summaries
// (pi compaction/utils.ts extractFileOpsFromMessage / computeFileLists /
// formatFileOperations). When a span is summarized away the model loses its
// file footprint: it re-reads files (full tokens + fresh cache-miss bytes)
// and forgets what it already edited. The ledger is MECHANICAL — extracted
// from the span's assistant toolCall blocks, never LLM-dependent — and
// survives N successive compactions by RE-PARSING the tags out of the prior
// frozen summary. Wudao deltas over pi: ① the running ledger is re-derived
// from frozen summary bytes instead of a persisted `details` field on the
// session entry (state-free, resume-re-derivable — the same determinism
// property the tier-0/1 stubs enjoy); ② entries keep touch-recency order
// and each list is capped (pi is alphabetical and unbounded — a long chained
// session would grow the tags without limit); ③ the static and dual tier-2
// paths carry it too through this ONE shared seam.
// ---------------------------------------------------------------------------

/** Tag names of the two ledger blocks (pi verbatim shape). */
export const FILE_LEDGER_READ_TAG = "read-files";
export const FILE_LEDGER_MODIFIED_TAG = "modified-files";
/** Per-list cap on the ledger a summary carries. Oldest (front) entries
 * drop; the omission line inside the block records how many — and is
 * stripped again by parseFileOpsFromSummary, so a capped ledger re-merges
 * losslessly at the next boundary. */
export const FILE_LEDGER_CAP = 50;

/** The running file ledger: paths in touch (recency) order. */
export interface FileLedger {
  readonly read: string[];
  readonly modified: string[];
}

/** Recency-bump insert: a re-touched path moves to the end. */
function bump(list: string[], v: string): void {
  const i = list.indexOf(v);
  if (i !== -1) list.splice(i, 1);
  list.push(v);
}

/** 夜移 030: the file operations of a message span, from its assistant
 * toolCall blocks — read_file → read; write_file/edit → modified; modified
 * wins over read regardless of order; every other tool (even with a `path`
 * arg) and every non-string/empty path is ignored. Pure; recency order. */
export function extractFileOps(span: readonly AgentMessage[]): FileLedger {
  const read: string[] = [];
  const modified: string[] = [];
  for (const m of span) {
    if (m.role !== "assistant" || m.toolCalls === undefined) continue;
    for (const call of m.toolCalls) {
      const path = call.arguments.path;
      if (typeof path !== "string" || path === "") continue;
      if (call.name === "read_file") bump(read, path);
      else if (call.name === "write_file" || call.name === "edit") bump(modified, path);
    }
  }
  return { read: read.filter((f) => !modified.includes(f)), modified };
}

/** The last complete `<tag>…</tag>` block's entries, or undefined. Torn
 * tags (an LLM echoing an unclosed block) don't parse; the omission line is
 * stripped (it is presentation, not a path). */
function lastTagEntries(content: string, tag: string): string[] | undefined {
  const open = `<${tag}>`;
  const start = content.lastIndexOf(open);
  if (start === -1) return undefined;
  const end = content.indexOf(`</${tag}>`, start);
  if (end === -1) return undefined;
  return content
    .slice(start + open.length, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("[... "));
}

/** 夜移 030: parse the ledger back out of a frozen summary message. Takes
 * the LAST block per tag (an early partial echo can't shadow the appended
 * ledger); undefined when the message carries no tags. Pure. */
export function parseFileOpsFromSummary(content: string): FileLedger | undefined {
  const read = lastTagEntries(content, FILE_LEDGER_READ_TAG);
  const modified = lastTagEntries(content, FILE_LEDGER_MODIFIED_TAG);
  if (read === undefined && modified === undefined) return undefined;
  return { read: read ?? [], modified: modified ?? [] };
}

/** 夜移 030: merge the prior boundary's ledger with the new span's ops.
 * Prior entries first, span ops bump to the end; a path the span modified
 * leaves the read list wherever it came from (pi computeFileLists'
 * modified-wins semantics, applied across boundaries). Pure. */
export function mergeFileOps(prior: FileLedger | undefined, next: FileLedger): FileLedger {
  const modified: string[] = [];
  for (const f of [...(prior?.modified ?? []), ...next.modified]) bump(modified, f);
  const read: string[] = [];
  for (const f of [...(prior?.read ?? []), ...next.read]) {
    if (!modified.includes(f)) bump(read, f);
  }
  return { read, modified };
}

function formatLedgerBlock(tag: string, files: readonly string[]): string | undefined {
  if (files.length === 0) return undefined;
  const dropped = Math.max(0, files.length - FILE_LEDGER_CAP);
  const kept = dropped > 0 ? files.slice(dropped) : [...files];
  const lines = dropped > 0 ? [`[... ${dropped} older files omitted]`, ...kept] : kept;
  return `<${tag}>\n${lines.join("\n")}\n</${tag}>`;
}

/** 夜移 030: the ledger blocks appended to a tier-2 summary (pi verbatim
 * shape: `\n\n` + blocks joined by a blank line; capped lists lead with the
 * omission line). Empty ledger → "" so a file-less span keeps today's
 * summary bytes byte-identical. Pure. */
export function formatFileOperations(readFiles: readonly string[], modifiedFiles: readonly string[]): string {
  const sections = [
    formatLedgerBlock(FILE_LEDGER_READ_TAG, readFiles),
    formatLedgerBlock(FILE_LEDGER_MODIFIED_TAG, modifiedFiles),
  ].filter((s): s is string => s !== undefined);
  return sections.length === 0 ? "" : `\n\n${sections.join("\n\n")}`;
}

/** 夜移 030: the composed ledger section for a tier-2 boundary — the prior
 * chain summary's tags (the running ledger, re-parsed from frozen bytes)
 * merged with the replaced span's ops. "" when both are empty (status-quo
 * bytes). Module-private: the three tier-2 composers read this ONE seam. */
export function fileOpsSection(prior: readonly AgentMessage[], span: readonly AgentMessage[]): string {
  const merged = chainLedger(prior, span);
  if (merged === undefined) return "";
  return formatFileOperations(merged.read, merged.modified);
}

/** The running file ledger of a message chain: the last frozen summary's
 *  re-parsed tags (the cumulative ledger, resume-re-derivable from bytes)
 *  merged with the ops of everything after it. Undefined when the chain
 *  carries no ledger at all. Module-private seam shared by fileOpsSection
 *  and 125 项 2's cumulativeModifiedFiles. */
function chainLedger(prior: readonly AgentMessage[], span: readonly AgentMessage[]): FileLedger | undefined {
  let prev: FileLedger | undefined;
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const m = prior[i];
    if (m !== undefined && m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) {
      prev = parseFileOpsFromSummary(m.content);
      break;
    }
  }
  const next = extractFileOps(span);
  if (prev === undefined && next.read.length === 0 && next.modified.length === 0) return undefined;
  return mergeFileOps(prev, next);
}

/** 125 项 2（WorldState 差分）: the session-cumulative set of CHANGED files
 *  behind a message chain — the running ledger's modified list (recency
 *  order, ledger caps apply), i.e. exactly what a WorldState snapshot's
 *  changedFiles field records. Pure; deterministic per chain (the 夜移030
 *  resume-re-derivable discipline). */
export function cumulativeModifiedFiles(messages: readonly AgentMessage[]): string[] {
  // The chain head = everything through the LAST summary marker; the span
  // = everything after it (the summary itself carries no tool calls).
  let lastMarker = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user" && messages[i]?.content.startsWith(SUMMARY_MARKER)) {
      lastMarker = i;
      break;
    }
  }
  const prior = messages.slice(0, lastMarker + 1);
  const span = messages.slice(lastMarker + 1);
  return [...(chainLedger(prior, span)?.modified ?? [])];
}

// ---------------------------------------------------------------------------
// 波次 7 #39 (OH B1) — the verified-work carryover bucket. OH rides a
// "recent_verified_work" attachment (last 8) so a post-compaction model never
// re-does work that was already verified. Wudao deltas: ① ZERO new state —
// the running list re-parses from the prior frozen summary's tag block (the
// 夜移030 discipline: resume-re-derivable, no metadata side-channel) and the
// LOOP feeds it mechanically from the verify gate's own trail (a successful
// shell after writes — the flip that clears "nothing was run since");
// ② the block rides the SAME frozen-summary seam as the file ledger, so LLM,
// digest (#38), and static-fallback paths carry it identically.
// ---------------------------------------------------------------------------

/** Tag name of the verified-work block (夜移030 tag family). */
export const VERIFIED_WORK_TAG = "verified-work";
/** Cap on verified entries a summary carries; oldest drop with the same
 *  omission-line protocol as the file ledger (lossless re-merge). */
export const VERIFIED_WORK_CAP = 8;
/** Single-line cap on a verified entry's command head (entries are facts,
 *  not logs). */
const VERIFIED_ENTRY_CAP_CHARS = 80;

/** The verified-work block appended to a tier-2 summary: `\n\n` + tag +
 *  `- ` lines, oldest-first. Empty entries → "" (status-quo bytes). Pure. */
export function formatVerifiedWork(entries: readonly string[]): string {
  const clean = entries.map((e) => e.trim()).filter((e) => e !== "");
  if (clean.length === 0) return "";
  const dropped = Math.max(0, clean.length - VERIFIED_WORK_CAP);
  const kept = dropped > 0 ? clean.slice(dropped) : clean;
  const lines = dropped > 0 ? [`[... ${dropped} older entries omitted]`, ...kept] : kept;
  return `\n\n<${VERIFIED_WORK_TAG}>\n${lines.map((l) => `- ${l}`).join("\n")}\n</${VERIFIED_WORK_TAG}>`;
}

/** 波次 7 #39: parse the verified entries back out of a frozen summary
 *  message. Takes the LAST complete block; strips the `- ` prefix and the
 *  omission line (presentation, not a fact). Undefined when no block rides
 *  the text. Pure. */
export function parseVerifiedWorkFromSummary(content: string): string[] | undefined {
  const open = `<${VERIFIED_WORK_TAG}>`;
  const start = content.lastIndexOf(open);
  if (start === -1) return undefined;
  const end = content.indexOf(`</${VERIFIED_WORK_TAG}>`, start);
  if (end === -1) return undefined;
  const lines = content
    .slice(start + open.length, end)
    .split("\n")
    .map((l) => l.trim())
    .map((l) => (l.startsWith("- ") ? l.slice(2) : l))
    .filter((l) => l !== "" && !l.startsWith("[... "));
  return lines.length > 0 ? lines : undefined;
}

/** 波次 7 #39: the composed verified-work section for a tier-2 boundary —
 *  the prior boundary's entries (re-parsed from frozen bytes; the span is
 *  scanned FIRST because in a chained compaction the newer summary sits
 *  inside it) merged with the caller's new entries, deduped, capped to the
 *  LAST VERIFIED_WORK_CAP. "" when empty everywhere (status-quo bytes).
 *  Module-private: the tier-2 composers read this ONE seam. */
export function verifiedWorkSection(prior: readonly AgentMessage[], span: readonly AgentMessage[], extra: readonly string[] | undefined): string {
  let prev: string[] | undefined;
  scan: for (const source of [span, prior]) {
    for (let i = source.length - 1; i >= 0; i -= 1) {
      const m = source[i];
      if (m !== undefined && m.role === "user" && m.content.startsWith(SUMMARY_MARKER)) {
        prev = parseVerifiedWorkFromSummary(m.content);
        if (prev !== undefined) break scan;
      }
    }
  }
  const merged: string[] = [];
  for (const entry of [...(prev ?? []), ...(extra ?? [])]) {
    const trimmed = entry.trim();
    if (trimmed !== "" && !merged.includes(trimmed)) merged.push(trimmed);
  }
  return formatVerifiedWork(merged);
}

/** 波次 7 #39 (OH B1): the plan-mode restatement — a post-compaction model
 *  still knows execution is locked until the user approves the plan. The
 *  board restore (M23) carries the plan itself; this line carries the MODE.
 *  Absent → "" (status-quo bytes). Pure. */
export function planModeLine(active: boolean | undefined): string {
  return active === true
    ? "\n\n[plan mode still active — the plan is the todo board; refine or present it, and run no executing tools until the user approves]"
    : "";
}

// ---------------------------------------------------------------------------
// 113-B1（prime-agent #2385 形）— the kept-tail recency anchor. The summarizer
// only ever sees the compacted span; without a bridge the summary describes
// the world BEFORE the kept tail, and a post-compaction model may read it as
// the newest state (stale-summary drift). The anchor is the LATEST kept-tail
// assistant TEXT — deterministic extraction, no extra model call — riding the
// summary instruction's TAIL rider seat (M58 §C#2 family, next to
// focus/compactInstructions): the warm-replay prefix above the instruction is
// untouched, so the cache cost is zero (the instruction is already cold-tail
// bytes). The in-summary authority line rides the summary MESSAGE (new bytes
// at the compaction boundary — compaction rewrites the prefix by definition,
// no additional cache surface).
// ---------------------------------------------------------------------------

/** Cap on the recency anchor's quoted assistant text (~500 chars). */
export const RECENCY_ANCHOR_CAP_CHARS = 500;

/** The constant authority line riding every tier-2 summary message that has a
 *  non-empty retained tail: whatever the kept messages say wins over the
 *  summary's recollection of the compacted span. */
export const SUMMARY_AUTHORITY_LINE = "保留的消息权威于本摘要";

/** 113-B1: the latest kept-tail assistant TEXT (scanned from the tail's END,
 *  capped, never mid-line when lines exist). undefined when the tail has no
 *  assistant text — the status-quo bytes escape. Pure. */
export function recencyAnchorOf(tail: readonly AgentMessage[]): string | undefined {
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const m = tail[i];
    if (m === undefined || m.role !== "assistant") continue;
    const text = capToLineBoundary(m.content, RECENCY_ANCHOR_CAP_CHARS).trim();
    if (text !== "") return text;
  }
  return undefined;
}

/** 113-B1: the authority line for a composed summary message — rides iff the
 *  boundary actually retained messages (an empty tail would make the line a
 *  lie: nothing is authoritative because nothing was kept). "" = status-quo
 *  bytes. Pure. */
export function summaryAuthorityLine(retainedCount: number): string {
  return retainedCount > 0 ? `\n${SUMMARY_AUTHORITY_LINE}` : "";
}

/** 波次 7 #39: the loop's mechanical verified-entry composer — a successful
 *  shell whose args name a command. Single line, capped; undefined
 *  when the args carry no string command (nothing to assert). Pure. */
export function verifiedRunHead(args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const command = (args as { command?: unknown }).command;
  if (typeof command !== "string" || command.trim() === "") return undefined;
  const oneLine = command.split("\n")[0]!.trim();
  // 113-A4：verified 档案行随摘要持久化（M24 面）——帽收编为代理对安全；
  // 仅劈代理对输入的旧字节不同（旧字节是乱码 bug，行为修正非缓存破坏）。
  return oneLine.length > VERIFIED_ENTRY_CAP_CHARS ? `${truncateSafe(oneLine, VERIFIED_ENTRY_CAP_CHARS - 1)}…` : oneLine;
}
