// 121 挖掘 TOP5 #1 — the model-side retrieval surface over compacted
// history. Acceptance per the mining brief:
//   · keyword hits across user/assistant entries (substring, both casings);
//   · hits newest-first (reverse file order), one per entry;
//   · assistant reasoning_content searched as its own labeled field;
//   · limit: default 10, hard cap 50 (an over-ask CLAMPS with a declared
//     header note, never errors), garbage limits/queries are typed errors;
//   · scope "recent" scans only the current uncompacted window (seq ≥ the
//     boundary the loader resolved); "all" (default) reaches through every
//     compaction and marks compacted-region hits as such;
//   · no boundary → "recent" degrades to the whole ledger (honest);
//   · empty results are honest results (matches: 0), never errors;
//   · loader failures surface as typed errors;
//   · the loader IS the corpus boundary: whatever it hands is what gets
//     searched (sidechain non-mixing is pinned at the CLI corpus builder).
import { describe, it, expect } from "vitest";
import {
  createSearchHistoryTool,
  searchHistory,
  historySearchSnippet,
  SEARCH_HISTORY_LIMIT_DEFAULT,
  SEARCH_HISTORY_LIMIT_MAX,
  SEARCH_HISTORY_SNIPPET_CONTEXT,
} from "../src/index.js";
import type { HistorySearchCorpus, HistorySearchEntry } from "../src/index.js";

const e = (seq: number, role: "user" | "assistant", content: string, extra?: { readonly reasoning?: string; readonly at?: string }): HistorySearchEntry => ({
  seq,
  role,
  content,
  ...(extra?.reasoning !== undefined ? { reasoning: extra.reasoning } : {}),
  ...(extra?.at !== undefined ? { at: extra.at } : {}),
});

/** A compacted-session corpus: seq 0-3 compacted away, boundary at 4. */
const CORPUS: HistorySearchCorpus = {
  entries: [
    e(0, "user", "find the flaky cache test"),
    e(1, "assistant", "the cache invalidation bug is in permissions.ts", { reasoning: "the trail points at the prefix cache key", at: "2026-09-26T10:00:00Z" }),
    e(2, "assistant", "intermediate data: 47 hits at 64KB windows"),
    e(3, "user", "[compacted summary] earlier we fixed the cache key bug"),
    e(4, "assistant", "the fix landed; the flaky test now passes", { at: "2026-09-26T11:00:00Z" }),
    e(5, "user", "why was the cache key unstable?"),
  ],
  totalMessages: 8,
  recentFromSeq: 4,
};

describe("searchHistory (pure, 121 #1)", () => {
  it("finds keyword hits across roles with role + time labels", () => {
    const { header, hits } = searchHistory(CORPUS, "cache");
    // seq 0, 1, 3, 5 mention "cache"; seq 1's content AND reasoning both do —
    // ONE hit per entry (the entry is the retrieval unit).
    expect(header.matches).toBe(4);
    expect(hits.map((h) => h.seq)).toEqual([5, 3, 1, 0]);
    expect(hits.every((h) => h.role === "user" || h.role === "assistant")).toBe(true);
    const bySeq = new Map(hits.map((h) => [h.seq, h]));
    expect(bySeq.get(5)?.role).toBe("user");
    expect(bySeq.get(1)?.at).toBe("2026-09-26T10:00:00Z");
    expect(bySeq.get(0)?.at).toBeUndefined();
  });

  it("is case-insensitive in both directions", () => {
    expect(searchHistory(CORPUS, "FLAKY").hits.map((h) => h.seq)).toEqual([4, 0]);
    expect(searchHistory(CORPUS, "flaky").hits.map((h) => h.seq)).toEqual([4, 0]);
    expect(searchHistory(CORPUS, "flaky").hits[0]?.at).toBe("2026-09-26T11:00:00Z");
    expect(searchHistory(CORPUS, "cAcHe").header.matches).toBe(4);
  });

  it("orders hits newest-first (descending seq)", () => {
    const seqs = searchHistory(CORPUS, "cache").hits.map((h) => h.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("searches assistant reasoning as its own labeled field", () => {
    const { hits } = searchHistory(CORPUS, "trail points");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.field).toBe("reasoning");
    expect(hits[0]?.seq).toBe(1);
    expect(hits[0]?.match_index).toBe(4);
    // content-only hit stays labeled content
    expect(searchHistory(CORPUS, "invalidation").hits[0]?.field).toBe("content");
  });

  it("emits ONE hit per entry even when the keyword repeats", () => {
    const corpus: HistorySearchCorpus = {
      entries: [e(0, "assistant", "needle then needle then needle")],
      totalMessages: 1,
    };
    const { header, hits } = searchHistory(corpus, "needle");
    expect(header.matches).toBe(1);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.match_index).toBe(0);
  });

  it("limits returned hits, declaring truncation; default limit is 10", () => {
    const many: HistorySearchCorpus = {
      entries: Array.from({ length: 23 }, (_, i) => e(i, "assistant", `hit ${i}`)),
      totalMessages: 23,
    };
    expect(SEARCH_HISTORY_LIMIT_DEFAULT).toBe(10);
    const all = searchHistory(many, "hit");
    expect(all.header.limit).toBe(10);
    expect(all.header.matches).toBe(23);
    expect(all.hits).toHaveLength(10);
    expect(all.header.truncated).toBe(true);
    expect(all.header.returned).toBe(10);
    // newest-first under the cut
    expect(all.hits[0]?.seq).toBe(22);
    const two = searchHistory(many, "hit", { limit: 2 });
    expect(two.hits.map((h) => h.seq)).toEqual([22, 21]);
    expect(two.header.matches).toBe(23);
  });

  it("caps limit at 50 with a declared clamp, never an error", () => {
    expect(SEARCH_HISTORY_LIMIT_MAX).toBe(50);
    const many: HistorySearchCorpus = {
      entries: Array.from({ length: 80 }, (_, i) => e(i, "assistant", `zap ${i}`)),
      totalMessages: 80,
    };
    const r = searchHistory(many, "zap", { limit: 500 });
    expect(r.header.limit).toBe(50);
    expect(r.header.limit_clamped).toBe(true);
    expect(r.header.matches).toBe(80);
    expect(r.hits).toHaveLength(50);
    expect(r.header.truncated).toBe(true);
    // exactly 50 is not a clamp
    expect(searchHistory(many, "zap", { limit: 50 }).header.limit_clamped).toBeUndefined();
  });

  it("rejects garbage query/scope/limit as typed argument errors", () => {
    expect(() => searchHistory(CORPUS, "")).toThrow(/query must be a non-empty keyword/);
    expect(() => searchHistory(CORPUS, "   ")).toThrow(/query must be a non-empty keyword/);
    expect(() => searchHistory(CORPUS, "x", { scope: "everything" as "all" })).toThrow(/scope must be/);
    expect(() => searchHistory(CORPUS, "x", { limit: 0 })).toThrow(/limit must be an integer/);
    expect(() => searchHistory(CORPUS, "x", { limit: 1.5 })).toThrow(/limit must be an integer/);
    expect(() => searchHistory(CORPUS, "x", { limit: -3 })).toThrow(/limit must be an integer/);
  });

  it('scope "recent" scans only the uncompacted window (seq ≥ boundary)', () => {
    const { header, hits } = searchHistory(CORPUS, "cache", { scope: "recent" });
    expect(header.recent_from_seq).toBe(4);
    expect(header.scanned).toBe(2); // seq 4, 5 — the whole current window
    expect(hits.map((h) => h.seq)).toEqual([5]);
    expect(hits[0]?.compacted).toBe(false);
    // the compacted-away conversation stays reachable under "all"
    const all = searchHistory(CORPUS, "cache");
    expect(all.hits.some((h) => h.seq === 1)).toBe(true);
    expect(all.hits.find((h) => h.seq === 1)?.compacted).toBe(true);
    expect(all.header.scanned).toBe(6);
  });

  it('scope "recent" without a boundary degrades to the whole ledger', () => {
    const never: HistorySearchCorpus = { entries: CORPUS.entries, totalMessages: 8 };
    const { header, hits } = searchHistory(never, "cache", { scope: "recent" });
    expect(header.recent_from_seq).toBeUndefined();
    expect(header.matches).toBe(4);
    expect(hits.map((h) => h.seq)).toEqual([5, 3, 1, 0]);
    expect(hits.every((h) => h.compacted === false)).toBe(true);
  });

  it("returns honest empty results", () => {
    const { header, hits } = searchHistory(CORPUS, "quantum-turtle");
    expect(header.matches).toBe(0);
    expect(hits).toEqual([]);
    expect(header.truncated).toBe(false);
    expect(header.total_messages).toBe(8);
  });

  it("snippets carry ±context with ellipsis marks at clipped edges", () => {
    expect(SEARCH_HISTORY_SNIPPET_CONTEXT).toBe(50);
    const text = `${"a".repeat(200)}NEEDLE${"b".repeat(200)}`;
    const s = historySearchSnippet(text, 200, 6);
    expect(s.startsWith("…")).toBe(true);
    expect(s.endsWith("…")).toBe(true);
    expect(s).toContain("NEEDLE");
    expect(s.length).toBeLessThanOrEqual(50 + 6 + 50 + 2);
    // near the start: no leading ellipsis
    const head = historySearchSnippet("NEEDLE-tail", 0, 6);
    expect(head.startsWith("…")).toBe(false);
  });
});

describe("createSearchHistoryTool (121 #1)", () => {
  const run = async (tool = createSearchHistoryTool(async () => CORPUS), args: Record<string, unknown> = {}) =>
    tool.execute(args, undefined as never);

  it("renders one JSON header line + one JSON hit line per match", async () => {
    const r = await createSearchHistoryTool(async () => CORPUS).execute({ query: "flaky" }, undefined as never);
    expect(r.isError).toBeUndefined();
    const lines = (r.content as string).split("\n");
    expect(lines).toHaveLength(3);
    const header = JSON.parse(lines[0] as string) as { matches: number; scope: string; limit: number };
    expect(header.matches).toBe(2);
    expect(header.scope).toBe("all");
    expect(header.limit).toBe(10);
    for (const line of lines.slice(1)) {
      const hit = JSON.parse(line as string) as { seq: number; role: string; snippet: string };
      expect(typeof hit.seq).toBe("number");
      expect(["user", "assistant"]).toContain(hit.role);
      expect(typeof hit.snippet).toBe("string");
    }
  });

  it("answers empty findings honestly (not an error)", async () => {
    const r = await createSearchHistoryTool(async () => CORPUS).execute({ query: "nothing-matches-this" }, undefined as never);
    expect(r.isError).toBeUndefined();
    const lines = (r.content as string).split("\n");
    const header = JSON.parse(lines[0] as string) as { matches: number };
    expect(header.matches).toBe(0);
    expect(lines[1]).toContain("no matches");
    expect(lines[1]).toContain("6");
  });

  it("surfaces typed errors for bad arguments", async () => {
    expect((await run(undefined, {})).isError).toBe(true);
    expect((await run(undefined, { query: "  " })).isError).toBe(true);
    expect((await run(undefined, { query: "x", scope: "later" })).isError).toBe(true);
    expect((await run(undefined, { query: "x", limit: 0 })).isError).toBe(true);
  });

  it("clamps an over-asked limit through the tool too", async () => {
    const many: HistorySearchCorpus = {
      entries: Array.from({ length: 80 }, (_, i) => e(i, "assistant", `zap ${i}`)),
      totalMessages: 80,
    };
    const r = await createSearchHistoryTool(async () => many).execute({ query: "zap", limit: 999 }, undefined as never);
    expect(r.isError).toBeUndefined();
    const header = JSON.parse((r.content as string).split("\n")[0] as string) as { limit: number; limit_clamped?: boolean };
    expect(header.limit).toBe(50);
    expect(header.limit_clamped).toBe(true);
  });

  it("surfaces a loader failure as a typed error, never a fake empty", async () => {
    const r = await createSearchHistoryTool(async () => {
      throw new Error("ledger unreadable");
    }).execute({ query: "x" }, undefined as never);
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ledger unreadable");
  });

  it("an empty ledger is an honest empty, not an error", async () => {
    const r = await createSearchHistoryTool(async () => ({ entries: [], totalMessages: 0 })).execute({ query: "x" }, undefined as never);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("no matches");
    expect(r.content).toContain("0");
  });

  it("is read-only and concurrency-safe (the read_file posture)", () => {
    const tool = createSearchHistoryTool(async () => CORPUS);
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
    expect(tool.name).toBe("search_history");
    expect(tool.parameters.required).toEqual(["query"]);
  });
});
