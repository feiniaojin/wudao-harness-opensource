// ω99-59 — the in-transcript find: the pure search core. Searches the
// STRUCTURED history entries (message bodies / reasoning / tool names /
// argument summaries / result previews / edit paths / board lines), never
// the rendered text — zero render dependency, CJK native through
// tokenize.ts (consumed, never modified). Pure, synchronous, zero deps.
import { hasCjk, tokenizeText } from "../tokenize.js";
import type { HistoryEntry } from "./use-agent.js";
import type { SlashCommandInfo } from "../slash-commands.js";

export type FindMode = "substring" | "token";

export interface FindMatch {
  /** The entry's position in the history array (displayed as #n). */
  readonly index: number;
  /** The entry's kind. */
  readonly kind: HistoryEntry["kind"];
  /** Row label: the kind, or `tool:<name>` for tool entries. */
  readonly label: string;
  /** Which searchable field produced the context line. */
  readonly field: string;
  /** The matching line, deterministically truncated around the hit. */
  readonly contextLine: string;
}

export interface FindResult {
  readonly mode: FindMode;
  readonly matches: readonly FindMatch[];
}

/** The panel's row cap — the Ink layout stays bounded; the overflow count
 * surfaces as a dim hint (refine the query to reach deeper entries). */
export const FIND_MAX_SHOWN = 20;

/** The TUI-only menu entry for /find. Lives here (not in slash-commands'
 * BUILTIN_COMMANDS) because the command is TUI-owned: app.tsx intercepts
 * the line before the shared parseReplCommand routing (the command union
 * feeds the driver's exhaustive switch, and this feature ships without a
 * driver arm), so the REPL keeps its current behavior for a name it never
 * advertises. */
export const FIND_COMMAND_INFO: SlashCommandInfo = {
  name: "find",
  description: "search the current transcript (overlay; /search is cross-session)",
  args: "<query>",
  source: "builtin",
  sources: ["builtin"],
};

/** Parse a /find line. Bare `/find` yields an empty query (the caller shows
 * usage and refuses to open the panel); prefix-neighbors (`/findx`, which
 * must stay a plain prompt) and any other line return undefined. */
export function parseFindCommand(line: string): { readonly query: string } | undefined {
  const trimmed = line.trim();
  if (trimmed === "/find") return { query: "" };
  if (trimmed.startsWith("/find ")) return { query: trimmed.slice("/find".length).trim() };
  return undefined;
}

// ── the searchable surface of one entry ────────────────────────────────

export interface SearchField {
  readonly field: string;
  readonly text: string;
}

function searchableFields(entry: HistoryEntry): readonly SearchField[] {
  switch (entry.kind) {
    case "user":
      return [{ field: "text", text: entry.text }];
    case "assistant": {
      const out: SearchField[] = [{ field: "text", text: entry.text }];
      if (entry.reasoning !== undefined && entry.reasoning !== "") out.push({ field: "reason", text: entry.reasoning });
      return out;
    }
    case "tool": {
      const out: SearchField[] = [{ field: "name", text: entry.name }, { field: "args", text: entry.summary }];
      if (entry.resultPreview !== undefined && entry.resultPreview !== "") out.push({ field: "result", text: entry.resultPreview });
      return out;
    }
    case "edit":
      return [{ field: "path", text: entry.path }, { field: "old", text: entry.oldString }, { field: "new", text: entry.newString }];
    case "board":
      return [{ field: "board", text: entry.lines.join("\n") }];
    case "notice": {
      const out: SearchField[] = [{ field: "text", text: entry.text }];
      if (entry.detail !== undefined && entry.detail !== "") out.push({ field: "detail", text: entry.detail });
      return out;
    }
    case "divider":
    case "error":
      return [{ field: "text", text: entry.text }];
  }
}

function labelFor(entry: HistoryEntry): string {
  return entry.kind === "tool" ? `tool:${entry.name}` : entry.kind;
}

/** The full-entry view's rows (the focused state): every non-empty searchable
 * field, in entry order. Exported for the panel's Enter view. */
export function focusFields(entry: HistoryEntry): readonly SearchField[] {
  return searchableFields(entry).filter((f) => f.text.trim() !== "");
}

// ── context-line extraction (deterministic truncation) ─────────────────

const CONTEXT_WIDTH = 100;

/** The first non-empty line satisfying `pred` (trimmed). */
function firstLineWhere(text: string, pred: (line: string) => boolean): string | undefined {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line !== "" && pred(line)) return line;
  }
  return undefined;
}

/** Cap a long line around the hit: keep CONTEXT_WIDTH chars starting 30
 * before the hit, ellipsis-marking both ends as needed. */
function truncateAround(line: string, hitAt: number): string {
  if (line.length <= CONTEXT_WIDTH) return line;
  const start = hitAt > 40 ? hitAt - 30 : 0;
  return `${start > 0 ? "…" : ""}${line.slice(start, start + CONTEXT_WIDTH)}…`;
}

function contextForSubstring(text: string, needle: string): string {
  const line = firstLineWhere(text, (l) => l.toLowerCase().includes(needle)) ?? text.trim().split("\n")[0] ?? "";
  return truncateAround(line, line.toLowerCase().indexOf(needle));
}

function contextForToken(fields: readonly SearchField[], qTokens: readonly string[]): { field: string; line: string } {
  for (const f of fields) {
    const line = firstLineWhere(f.text, (l) => {
      const toks = tokenizeText(l);
      return qTokens.some((q) => toks.includes(q));
    });
    if (line !== undefined) {
      const lower = line.toLowerCase();
      let hitAt = -1;
      for (const q of qTokens) {
        const at = lower.indexOf(q);
        if (at !== -1 && (hitAt === -1 || at < hitAt)) hitAt = at;
      }
      return { field: f.field, line: truncateAround(line, hitAt === -1 ? 0 : hitAt) };
    }
  }
  return { field: fields[0]?.field ?? "text", line: "" };
}

// ── the search itself ──────────────────────────────────────────────────

/** Search the structured history. Mode is chosen by the query's shape: a
 * CJK-bearing query runs token mode (word hits via tokenize.ts — spaces in
 * the query separate WORDS, not characters to match, so 「上下文 管理」
 * hits 「上下文与管理」); anything else is a case-insensitive substring
 * scan. Token mode is a per-entry conjunction: every query word must hit
 * somewhere in the entry. */
export function findInHistory(history: readonly HistoryEntry[], query: string): FindResult {
  const trimmed = query.trim();
  if (trimmed === "") return { mode: "substring", matches: [] };
  const mode: FindMode = hasCjk(trimmed) ? "token" : "substring";
  const needle = trimmed.toLowerCase();
  const qTokens = mode === "token" ? [...new Set(tokenizeText(trimmed))] : [];
  if (mode === "token" && qTokens.length === 0) return { mode, matches: [] };
  const matches: FindMatch[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i]!;
    const fields = searchableFields(entry);
    if (mode === "substring") {
      for (const f of fields) {
        if (!f.text.toLowerCase().includes(needle)) continue;
        matches.push({ index: i, kind: entry.kind, label: labelFor(entry), field: f.field, contextLine: contextForSubstring(f.text, needle) });
        break; // one row per entry: the first hitting field wins
      }
    } else {
      const entryTokens = new Set<string>();
      for (const f of fields) for (const t of tokenizeText(f.text)) entryTokens.add(t);
      if (qTokens.every((q) => entryTokens.has(q))) {
        const ctx = contextForToken(fields, qTokens);
        matches.push({ index: i, kind: entry.kind, label: labelFor(entry), field: ctx.field, contextLine: ctx.line });
      }
    }
  }
  return { mode, matches };
}
