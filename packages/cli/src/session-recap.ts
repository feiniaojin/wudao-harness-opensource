// ω99-213: #1 — 回来摘要（auto-recap）纯函数层。镜像 session-title.ts 的
// side-channel 范式：一次独立小模型调用（独立 system prompt，与主会话前缀
// 零共享）、失败容忍（失败=降级纯统计卡，不造假）、永不进主转录。区别于
// title 的入参形状：recap 的「mark」索引的是 history 通道（web 所见即
// driver getHistory 的重放），故统计与叙事同读 HistoryEntry 切片——数字从
// 结构化历史**数**出来，不是模型编的；模型只写叙事胶水。
// querySource:"recap" 走 providers 的 background 语义（不在
// FOREGROUND_QUERY_SOURCES 集内——过载即弃零重试，title/btw 同律）。
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import type { HistoryEntry } from "./driver/agent-driver.js";

/** Rides ModelInput.querySource — a background lane (bail-on-overload, no
 *  retries); logs/telemetry attribute the call apart from the main one. */
export const RECAP_QUERY_SOURCE = "recap";
/** On-wire discriminator (the title lane's TITLE_SYSTEM_FIRST_LINE twin):
 *  querySource never serializes into the HTTP body, so fakes/tests identify
 *  the background recap call by its standalone system prompt's first line. */
export const RECAP_SYSTEM_FIRST_LINE =
  "You summarize what happened in a chat session while the user was away. Reply with ONLY the recap:";
/** Narrative hard cap, in Unicode code points. A reply over the cap is a
 *  contract violation → undefined (honest degradation, never a mangled
 *  half-recap). */
export const RECAP_MAX_CODEPOINTS = 400;
/** Dual-threshold gate: the viewer's absence must span ≥ 10 minutes AND the
 *  session must have ≥ 3 new conversational messages; either below = zero
 *  action zero calls. The web mirrors these (it cannot import cli — the
 *  receipts here pin the canonical values). */
export const RECAP_MIN_AWAY_MS = 10 * 60_000;
export const RECAP_MIN_NEW_MESSAGES = 3;
/** The narrative contract's three labeled sections (order is the contract). */
export const RECAP_LABELS = ["完成了：", "还在进行：", "等你决定："] as const;

/** The deterministic half of the recap card — counted, never generated. */
export interface RecapStatsCounters {
  /** User entries in the slice (each user entry = one turn). */
  readonly turns: number;
  /** Finished tool-call receipts: kind "tool" + "edit" + "board" (every
   *  settled call lands exactly one entry of one of these kinds). */
  readonly toolCalls: number;
  /** Distinct changed-or-delivered files: edit paths ∪ deliverable file
   *  receipts (make_xlsx/… entries' `file`), deduped. */
  readonly filesTouched: number;
}

/** The op's wire payload. `narrative` absent is LEGAL — the degraded card
 *  (stats only) is the honest fallback, not an error. */
export interface RecapPayload {
  readonly stats: { readonly turns: number; readonly toolCalls: number; readonly filesTouched: number; readonly sinceTs: number | null };
  readonly narrative?: string;
}

/** Pure: count the slice's deterministic stats. Local only — no model, no
 *  IO; notices/dividers/errors count nothing (they are not activity). */
export function composeRecapStats(entries: readonly HistoryEntry[]): RecapStatsCounters {
  let turns = 0;
  let toolCalls = 0;
  const files = new Set<string>();
  for (const e of entries) {
    if (e.kind === "user") turns += 1;
    else if (e.kind === "tool") {
      toolCalls += 1;
      if (e.file !== undefined) files.add(e.file.path);
    } else if (e.kind === "edit") {
      toolCalls += 1;
      files.add(e.path);
    } else if (e.kind === "board") toolCalls += 1;
  }
  return { turns, toolCalls, filesTouched: files.size };
}

/** Pure: the dual gate's message unit — conversational entries only (user ∪
 *  assistant); tool receipts ride assistant turns and notices are noise. */
export function countNewMessages(entries: readonly HistoryEntry[]): number {
  let n = 0;
  for (const e of entries) if (e.kind === "user" || e.kind === "assistant") n += 1;
  return n;
}

/** Pure: the dual-threshold predicate — both must hold, else zero action. */
export function recapDue(awayMs: number, newMessages: number): boolean {
  return awayMs >= RECAP_MIN_AWAY_MS && newMessages >= RECAP_MIN_NEW_MESSAGES;
}

const EXCERPT_CHARS = 800;
const TOTAL_CHARS = 2_400;

/** Pure: build the standalone recap request from the away-window slice
 *  (entries AFTER the viewer's mark). Undefined when the slice holds no
 *  assistant entry (nothing happened that a narrative could summarize — the
 *  caller answers stats-only without any model call). */
export function buildRecapRequest(
  entries: readonly HistoryEntry[],
): { systemPrompt: string; user: string } | undefined {
  if (!entries.some((e) => e.kind === "assistant")) return undefined;
  const clip = (s: string): string => (s.length > EXCERPT_CHARS ? `${truncateSafe(s, EXCERPT_CHARS)}…` : s);
  const lines: string[] = [];
  for (const e of entries) {
    if (e.kind === "user") lines.push(`user: ${clip(e.text)}`);
    else if (e.kind === "assistant") lines.push(`assistant: ${clip(e.text)}`);
    else if (e.kind === "tool") lines.push(`tool ${e.name}: ${clip(e.summary)}`);
    else if (e.kind === "edit") lines.push(`edit: ${e.path}`);
    // notice / board / divider / error: not narrative material.
  }
  const systemPrompt = [
    RECAP_SYSTEM_FIRST_LINE,
    "- at most 5 lines, in Chinese, exactly three labeled sections in this order, each label starting its own line",
    "- 完成了：<what got done>",
    "- 还在进行：<what is still running or unfinished; 无 if nothing>",
    "- 等你决定：<what needs the user's decision; 无 if nothing>",
    "- facts only from the transcript below; no invented details; no preamble",
  ].join("\n");
  let user = lines.join("\n");
  if (user.length > TOTAL_CHARS) user = `${truncateSafe(user, TOTAL_CHARS)}…`;
  return { systemPrompt, user };
}

/** Pure: clean a raw model recap into a displayable narrative — undefined
 *  whenever the reply breaks the contract (the degraded stats-only card is
 *  the honest fallback, never a fabricated story):
 *  - empty/whitespace-only, or any control character (\n exempt) → undefined;
 *  - ALL THREE labels must start a line (the card is three-segment by
 *    contract); junk lines before the first label are stripped;
 *  - over RECAP_MAX_CODEPOINTS code points → undefined (CJK-safe check). */
export function sanitizeRecap(raw: string): string | undefined {
  if (raw.length === 0) return undefined;
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 0x20 && c !== 0x0a) || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return undefined;
  }
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  if (lines.length === 0) return undefined;
  const first = lines.findIndex((l) => RECAP_LABELS.some((label) => l.startsWith(label)));
  if (first < 0) return undefined;
  const body = lines.slice(first);
  for (const label of RECAP_LABELS) {
    if (!body.some((l) => l.startsWith(label))) return undefined;
  }
  const out = body.join("\n");
  return Array.from(out).length <= RECAP_MAX_CODEPOINTS ? out : undefined;
}
