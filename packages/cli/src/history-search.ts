// 121 挖掘 TOP5 #1 — the CLI side of search_history: the corpus builder that
// turns ONE session's append-only JSONL into the searchable conversation
// view core's tool consumes. A PURE BYPASS READ of the ledger (the same
// holographic record scripts/dev/export-trajectory.mjs reads — the RL
// trajectory exporter's source): no kernel state is touched, nothing is
// persisted, the store's own load path is the only I/O.
//
// WHAT RIDES AN ENTRY:
//   · user + assistant messages (the conversation flow compaction swallows —
//     tool outputs keep their own recovery lane, session_result);
//   · assistant reasoning_content as its own searchable field;
//   · `at` = the nearest recorded timestamp AT OR BEFORE the message — the
//     ledger's own receipts (model_change/provider_change `at`, the compact/
//     clear boundaries' `at`) are the only per-position time source; a fresh
//     session's boot model_change lands before the first user line, so in
//     practice the anchor covers the whole file. Legacy sessions with no
//     receipts ahead of a message just carry no `at` (honest absence);
//   · seq = the message's position among ALL messages in file order (tool
//     messages occupy positions without emitting entries) — the scope filter
//     compares seq against the boundary.
//
// THE BOUNDARY: the latest `compact_boundary` entry names the fingerprint
// (core messageEntryId) of the first message the last tier-2 compaction
// KEPT. The kept region, the frozen summary message, and everything after
// it all carry seq ≥ that position — exactly the current uncompacted
// window. Resolution walks the full message stream (tool messages included:
// the kept head can be a tool result, which emits no corpus entry but still
// owns a seq). An unresolvable fingerprint (a boundary naming bytes that
// never persisted) degrades honestly: no boundary, both scopes scan the
// whole ledger.
//
// SIDECHAINS ARE NOT SEARCHED: side-<id>.jsonl files are separate ledgers;
// this builder reads exactly <sid>.jsonl for the sid it is handed (the LIVE
// session id — a run resumed onto a side-chain id searches that chain and
// only it; a main-session run never mixes child transcripts in).
import {
  messageEntryId,
  type AgentMessage,
  type HistorySearchCorpus,
  type HistorySearchEntry,
  type SessionEntry,
  type SessionStore,
} from "@wudao-org/core";
import { COMPACT_BOUNDARY_TYPE } from "./session-entry.js";

/** The `at` timestamp of a timestamped ledger receipt, when it has one. */
function receiptAt(e: SessionEntry): string | undefined {
  if (!("role" in e)) {
    if (e.type === "model_change" || e.type === "provider_change") {
      const at = (e as { readonly at?: unknown }).at;
      return typeof at === "string" && at !== "" ? at : undefined;
    }
    if (e.type === COMPACT_BOUNDARY_TYPE || e.type === "clear_boundary") {
      const at = (e as { readonly data?: { readonly at?: unknown } }).data?.at;
      return typeof at === "string" && at !== "" ? at : undefined;
    }
  }
  return undefined;
}

/** The boundary fingerprint a compact_boundary receipt names, when it has
 *  one (CLI session-entry.ts owns the entry shape; this reads it without
 *  re-deriving the lastCompactBoundary walk — that helper takes the WHOLE
 *  entry list, this builder resolves boundaries incrementally while seqs
 *  are being assigned). */
function boundaryFingerprint(e: SessionEntry): string | undefined {
  if ("role" in e || e.type !== COMPACT_BOUNDARY_TYPE) return undefined;
  const id = (e as { readonly data?: { readonly firstKeptEntryId?: unknown } }).data?.firstKeptEntryId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Read one session's ledger into the search corpus. Pure read — the store's
 *  own load path (torn-tail healing included) is the only file I/O. */
export async function historySearchCorpus(store: SessionStore, sessionId: string): Promise<HistorySearchCorpus> {
  const entries = await store.loadSessionEntries(sessionId);
  const out: HistorySearchEntry[] = [];
  // entryId → the LATEST seq seen with that fingerprint (identical messages
  // collide by design; a boundary computed after both resolves to the last).
  const seqByEntryId = new Map<string, number>();
  let seq = 0; // position among ALL messages (any role)
  let at: string | undefined;
  let recentFromSeq: number | undefined;
  for (const e of entries) {
    const receiptTime = receiptAt(e);
    if (receiptTime !== undefined) at = receiptTime;
    if (!("role" in e)) {
      const fp = boundaryFingerprint(e);
      if (fp !== undefined) {
        const resolved = seqByEntryId.get(fp);
        // Unresolvable fingerprints degrade to "no boundary" (both scopes
        // then scan the whole ledger) — never a wrong window.
        if (resolved !== undefined) recentFromSeq = resolved;
      }
      continue;
    }
    const m = e as AgentMessage;
    seqByEntryId.set(messageEntryId(m), seq);
    if (m.role === "user") {
      out.push({ seq, role: "user", content: m.content, ...(at !== undefined ? { at } : {}) });
    } else if (m.role === "assistant") {
      out.push({
        seq,
        role: "assistant",
        content: m.content,
        ...(typeof m.reasoning === "string" && m.reasoning !== "" ? { reasoning: m.reasoning } : {}),
        ...(at !== undefined ? { at } : {}),
      });
    }
    seq += 1;
  }
  return {
    entries: out,
    totalMessages: seq,
    ...(recentFromSeq !== undefined ? { recentFromSeq } : {}),
  };
}
