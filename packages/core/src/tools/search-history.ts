// 121 挖掘 TOP5 #1 — the model-side retrieval surface over COMPACTED history
// (codex history/notes · a reference harness retained-evidence handles · qm type#seq —
// three repos converged on the same quarter; this is wudao's take). Long
// sessions compact, and everything the summarizer swallowed used to be gone
// from the model's reach exactly when long-range tasks need it most — "what
// did I conclude three hours ago". session_result already pages TOOL-RESULT
// originals back in; the CONVERSATION flow itself (user messages, assistant
// reasoning/decisions/intermediate conclusions) had no retrieval face. This
// tool is that face:
//   · data source = the session's append-only JSONL ledger, read BYPASS (the
//     same holographic record the RL trajectory exporter reads — zero new
//     index layer, zero kernel changes, zero new persisted files: PURE READ);
//   · retrieval = keyword + time window, deliberately NOT vectors (the
//     zero-new-dependency red line): case-insensitive substring over user
//     and assistant text (assistant reasoning_content included — model
//     reasoning is precisely what compaction swallows);
//   · hits are role- and time-labeled and ordered NEWEST FIRST, so the model
//     can tell "I said" from "the user said" and jump straight to the most
//     recent statement of whatever it is looking for;
//   · `scope: "recent"` restricts the scan to the CURRENT UNCOMPACTED window
//     (the post-boundary kept region); `scope: "all"` (default) scans the
//     full ledger INCLUDING everything compaction summarized away.
// M24 discipline: the tool RESULT is a suffix-appended tool output (history
// is never rewritten); the tool DEFINITION joining the tools list is one
// declared cross-version cold point, never a mid-session change. The
// injected `load` keeps core store-shape-agnostic — the CLI builds it with
// {store, sessionId} (session_result precedent).
import { buildTool } from "../tool.js";
import type { Tool, ToolParameterSchema } from "../tool.js";

/** Default max hits returned per call. */
export const SEARCH_HISTORY_LIMIT_DEFAULT = 10;
/** Hard hit ceiling per call (帽 50 — an over-ask clamps, never errors). */
export const SEARCH_HISTORY_LIMIT_MAX = 50;
/** Chars of context on EACH side of the match inside a hit snippet. */
export const SEARCH_HISTORY_SNIPPET_CONTEXT = 50;

/** One searchable conversation entry from the session ledger. The corpus the
 *  loader hands the tool: user + assistant messages only (tool outputs have
 *  their own recovery lane, session_result — this face is the conversation
 *  flow compaction swallows). */
export interface HistorySearchEntry {
  /** Position among ALL messages in the ledger (file order, oldest first,
   *  0-based — tool messages occupy positions too, they just emit no entry).
   *  Scope filtering compares THIS number against the boundary. */
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly content: string;
  /** Assistant reasoning_content, when persisted (M47) — searched as its own
   *  field so a hit can say WHICH text matched. */
  readonly reasoning?: string;
  /** ISO time anchor: the nearest recorded timestamp AT OR BEFORE this
   *  entry (model/provider switches, compact boundaries — the ledger's own
   *  receipts), when any is known. Absent = no time receipt precedes it. */
  readonly at?: string;
}

/** What the loader returns: the conversation corpus plus the compaction
 *  boundary the CLI derives from the ledger's `compact_boundary` entries. */
export interface HistorySearchCorpus {
  readonly entries: readonly HistorySearchEntry[];
  /** All messages in the ledger, any role (the honest denominator). */
  readonly totalMessages: number;
  /** The seq where the CURRENT UNCOMPACTED window starts: the first kept
   *  message of the latest tier-2 compaction (the summary message and
   *  everything after it carry higher seqs and stay inside the window).
   *  Absent → the session never compacted: the whole ledger IS the recent
   *  window and both scopes scan it. */
  readonly recentFromSeq?: number;
}

/** The loader contract — resolved PER CALL (the live session id), never
 *  frozen into the schema bytes. */
export type HistorySearchLoader = () => Promise<HistorySearchCorpus>;

/** One hit: the entry, which field matched, where, and the ±context snippet. */
export interface HistorySearchHit {
  readonly seq: number;
  readonly role: "user" | "assistant";
  readonly at?: string;
  /** Which text matched — the assistant's visible content or its reasoning. */
  readonly field: "content" | "reasoning";
  /** Char index of the (first) match inside that field's text. */
  readonly match_index: number;
  /** True when the hit sits in the compacted-away region (seq BEFORE the
   *  boundary) — only ever true under scope "all". */
  readonly compacted: boolean;
  /** Up to ±SEARCH_HISTORY_SNIPPET_CONTEXT chars around the match, "…"-marked
   *  at either truncated edge. */
  readonly snippet: string;
}

/** The search result header (rendered as the output's first JSON line). */
export interface HistorySearchHeader {
  readonly query: string;
  readonly scope: "all" | "recent";
  /** The EFFECTIVE limit (after the 帽-50 clamp). */
  readonly limit: number;
  /** Present only when the caller's limit was clamped down to the cap. */
  readonly limit_clamped?: boolean;
  /** Total matches in the scanned window (before the limit cut). */
  readonly matches: number;
  readonly returned: number;
  readonly truncated: boolean;
  /** Messages in the whole ledger (any role). */
  readonly total_messages: number;
  /** Conversation entries the scan actually covered. */
  readonly scanned: number;
  /** The boundary the "recent" window starts at (when one exists). */
  readonly recent_from_seq?: number;
}

/** Build the ±context snippet around the first match. Pure; "…" marks each
 *  truncated edge so the model can tell a clipped span from a full one. */
export function historySearchSnippet(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - SEARCH_HISTORY_SNIPPET_CONTEXT);
  const end = Math.min(text.length, matchIndex + matchLength + SEARCH_HISTORY_SNIPPET_CONTEXT);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

/** The pure search. Case-insensitive substring over content (then reasoning)
 *  of every in-scope entry; hits come back NEWEST FIRST (reverse file
 *  order); `limit` caps the returned list while `matches` counts everything.
 *  One hit per entry (the entry is the retrieval unit — a message repeating
 *  the keyword matches once, at its first occurrence). Throws on an empty or
 *  whitespace-only query (argument error — the tool surfaces it typed). */
export function searchHistory(
  corpus: HistorySearchCorpus,
  query: string,
  opts?: { readonly scope?: "all" | "recent"; readonly limit?: number },
): { header: HistorySearchHeader; hits: readonly HistorySearchHit[] } {
  const q = query.trim();
  if (q === "") {
    throw new Error("search_history: query must be a non-empty keyword (case-insensitive substring)");
  }
  if (opts?.scope !== undefined && opts.scope !== "all" && opts.scope !== "recent") {
    throw new Error(`search_history: scope must be "all" or "recent" (got ${String(opts.scope)})`);
  }
  if (opts?.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
    throw new Error(`search_history: limit must be an integer ≥ 1 (got ${String(opts.limit)})`);
  }
  const scope = opts?.scope ?? "all";
  const limitClamped = opts?.limit !== undefined && opts.limit > SEARCH_HISTORY_LIMIT_MAX;
  const limit = limitClamped ? SEARCH_HISTORY_LIMIT_MAX : (opts?.limit ?? SEARCH_HISTORY_LIMIT_DEFAULT);
  const needle = q.toLowerCase();
  const recentFromSeq = corpus.recentFromSeq;
  const inScope = (seq: number): boolean =>
    scope !== "recent" || recentFromSeq === undefined || seq >= recentFromSeq;

  const hits: HistorySearchHit[] = [];
  let matches = 0;
  let scanned = 0;
  // Reverse file order: newest first is the retrieval posture (the most
  // recent statement of a conclusion is usually the operative one).
  for (let i = corpus.entries.length - 1; i >= 0; i -= 1) {
    const e = corpus.entries[i];
    if (e === undefined || !inScope(e.seq)) continue;
    scanned += 1;
    const fields: readonly ("content" | "reasoning")[] = e.reasoning === undefined ? ["content"] : ["content", "reasoning"];
    for (const field of fields) {
      const text = field === "content" ? e.content : (e.reasoning ?? "");
      const idx = text.toLowerCase().indexOf(needle);
      if (idx === -1) continue;
      matches += 1;
      if (hits.length < limit) {
        hits.push({
          seq: e.seq,
          role: e.role,
          ...(e.at !== undefined ? { at: e.at } : {}),
          field,
          match_index: idx,
          compacted: recentFromSeq !== undefined && e.seq < recentFromSeq,
          snippet: historySearchSnippet(text, idx, q.length),
        });
      }
      break; // one hit per entry — the entry is the unit
    }
  }
  return {
    header: {
      query: q,
      scope,
      limit,
      ...(limitClamped ? { limit_clamped: true } : {}),
      matches,
      returned: hits.length,
      truncated: matches > hits.length,
      total_messages: corpus.totalMessages,
      scanned,
      ...(recentFromSeq !== undefined ? { recent_from_seq: recentFromSeq } : {}),
    },
    hits,
  };
}

const PARAMETERS: ToolParameterSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "keyword to find (case-insensitive substring match)" },
    scope: {
      type: "string",
      enum: ["all", "recent"],
      description: '"all" (default) searches the FULL ledger including everything compaction summarized away; "recent" searches only the current uncompacted window',
    },
    limit: { type: "number", description: `max hits to return (default ${SEARCH_HISTORY_LIMIT_DEFAULT}, capped at ${SEARCH_HISTORY_LIMIT_MAX}); results are newest-first, check "truncated" in the header` },
  },
  required: ["query"],
  additionalProperties: false,
};

/** The read-only conversation-history search tool. `load` supplies the
 *  CURRENT session's corpus per call (the CLI binds the live session id);
 *  the result is ONE JSON header line + one JSON line per hit (or the honest
 *  no-matches line). Never an error for finding nothing. */
export function createSearchHistoryTool(load: HistorySearchLoader): Tool {
  return buildTool({
    name: "search_history",
    description:
      "Search THIS session's full conversation ledger (user and assistant messages, assistant reasoning included) by keyword — including everything context compaction summarized away. " +
      'After a long session compacts, use this to look up earlier conclusions, decisions, reasoning, or intermediate data instead of guessing from memory. ' +
      "Hits are role- and time-labeled, newest first. scope \"recent\" searches only the current uncompacted window; the default \"all\" reaches back through every compaction. " +
      "Tool OUTPUTS are not searched here — recover those by id with session_result.",
    parameters: PARAMETERS,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") {
        return { content: "search_history: query must be a non-empty keyword string", isError: true };
      }
      const scope = args["scope"] === undefined ? "all" : args["scope"];
      if (scope !== "all" && scope !== "recent") {
        return { content: `search_history: scope must be "all" or "recent" (got ${JSON.stringify(String(scope))})`, isError: true };
      }
      const limit = args["limit"] === undefined ? SEARCH_HISTORY_LIMIT_DEFAULT : Number(args["limit"]);
      if (!Number.isInteger(limit) || limit < 1) {
        return { content: `search_history: limit must be an integer ≥ 1 (got ${String(args["limit"])})`, isError: true };
      }
      let corpus: HistorySearchCorpus;
      try {
        corpus = await load();
      } catch (err) {
        return { content: `search_history: loading the session ledger failed — ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
      try {
        const { header, hits } = searchHistory(corpus, query, { scope, limit });
        const body =
          hits.length === 0
            ? `no matches for ${JSON.stringify(header.query)} in the ${scope === "recent" ? "current uncompacted window" : "full ledger"} (${header.scanned} message${header.scanned === 1 ? "" : "s"} scanned, ${header.total_messages} in the ledger)`
            : hits.map((h) => JSON.stringify(h)).join("\n");
        return { content: `${JSON.stringify(header)}\n${body}` };
      } catch (err) {
        return { content: err instanceof Error ? err.message : String(err), isError: true };
      }
    },
  });
}
