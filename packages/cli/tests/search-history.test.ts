// 121 挖掘 TOP5 #1 — the CLI side of search_history: the corpus builder over
// the append-only session ledger, the sidechain isolation boundary, the
// compact-boundary resolution, and the tool-surface mount. Acceptance per the
// mining brief: sidechain transcripts NEVER mix into a main session's corpus
// (the loader reads exactly <sid>.jsonl — the chain follows the live sid);
// the boundary the "recent" scope cuts at is derived from the ledger's own
// compact_boundary receipts; the tool joins the top-level set beside
// session_result (append-only tail, fail-absent seam) with the read_file
// permission posture (READ_TOOLS / plan-mode read fence).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStore,
  messageEntryId,
  searchHistory,
  type AgentMessage,
  type SessionStore,
  type Tool,
  type ModelClient,
  type PermissionDecision,
} from "@wudao/core";
import { historySearchCorpus } from "../src/history-search.js";
import { buildCompactBoundaryEntry } from "../src/session-entry.js";
import { buildToolSet } from "../src/tools.js";
import { READ_TOOLS, decidePermission } from "../src/permission.js";

let root: string;
let store: SessionStore;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "search-history-"));
  store = createJsonlSessionStore(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const user = (content: string): AgentMessage => ({ role: "user", content });
const assistant = (content: string, reasoning?: string): AgentMessage => ({
  role: "assistant",
  content,
  ...(reasoning !== undefined ? { reasoning } : {}),
});
const toolMsg = (id: string, content: string): AgentMessage => ({ role: "tool", toolCallId: id, name: "shell", content });

describe("historySearchCorpus over the ledger (121 #1)", () => {
  it("extracts user/assistant text with reasoning as its own field; tool messages occupy seqs without entries", async () => {
    const sid = "corpus-basic";
    await store.append(sid, user("please find the flaky test"));
    await store.append(sid, toolMsg("t1", "huge tool body mentioning flaky"));
    await store.append(sid, assistant("I will investigate the flaky test", "the flakiness smells like cache invalidation"));
    await store.append(sid, toolMsg("t2", "another tool body"));
    await store.append(sid, assistant("done"));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.totalMessages).toBe(5);
    expect(corpus.entries.map((e) => e.seq)).toEqual([0, 2, 4]); // tool rows hold seqs 1 and 3
    expect(corpus.entries.map((e) => e.role)).toEqual(["user", "assistant", "assistant"]);
    expect(corpus.entries[1]?.reasoning).toBe("the flakiness smells like cache invalidation");
    expect(corpus.recentFromSeq).toBeUndefined(); // never compacted

    // tool OUTPUT text is not searchable here (that lane is session_result)
    const r = searchHistory(corpus, "tool body");
    expect(r.header.matches).toBe(0);
    // user + assistant content + reasoning all are
    expect(searchHistory(corpus, "flaky").header.matches).toBe(2);
    expect(searchHistory(corpus, "cache invalidation").hits[0]?.field).toBe("reasoning");
  });

  it("sidechains never mix in: the corpus reads exactly <sid>.jsonl", async () => {
    const sid = "main-only";
    await store.append(sid, user("the shared keyword appears here"));
    // a child sidechain ledger in the SAME root, carrying the same keyword
    await store.appendSidechain("child9", user("the shared keyword ALSO appears in the sidechain"));
    await store.appendSidechain("child9", assistant("sidechain conclusion: shared keyword again"));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.totalMessages).toBe(1);
    const r = searchHistory(corpus, "shared keyword");
    expect(r.header.matches).toBe(1);
    expect(r.hits[0]?.seq).toBe(0);
    expect(JSON.stringify(corpus)).not.toContain("sidechain conclusion");
  });

  it("a run ONTO a sidechain id searches that chain and only it", async () => {
    // (the live-sid contract: a session resumed onto a side- id reads its own
    // transcript — the main session's content does not leak in either)
    await store.append("main2", user("main-only keyword zebra"));
    await store.appendSidechain("s9", user("side-only keyword yak"));

    const sideCorpus = await historySearchCorpus(store, "side-s9");
    expect(searchHistory(sideCorpus, "yak").header.matches).toBe(1);
    expect(searchHistory(sideCorpus, "zebra").header.matches).toBe(0);

    const mainCorpus = await historySearchCorpus(store, "main2");
    expect(searchHistory(mainCorpus, "yak").header.matches).toBe(0);
  });

  it("resolves the compact boundary to the first kept message's seq (tool heads included)", async () => {
    const sid = "compacted";
    const m0 = user("early conclusion: use the sha256 ref");
    const m1 = assistant("middle work");
    const keptHead = toolMsg("t9", "kept tool head");
    const keptText = assistant("post-boundary conclusion: the fix is upstream");
    await store.append(sid, m0);
    await store.append(sid, m1);
    await store.append(sid, keptHead);
    await store.append(sid, keptText);
    // what compaction actually appends at the boundary: the frozen summary
    // message, then the compact_boundary receipt naming the first kept
    // ORIGINAL (here a tool result — the corpus walk must still resolve it).
    await store.append(sid, user("[compacted summary] earlier: sha256 ref decision"));
    await store.appendEntry(sid, buildCompactBoundaryEntry({
      firstKeptEntryId: messageEntryId(keptHead),
      reason: "threshold",
      tier: 2,
    }));
    await store.append(sid, user("post-compact user turn"));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.recentFromSeq).toBe(2); // keptHead's position among ALL messages
    // summary (seq 4) and post-compact turns (seq 6) sit INSIDE the window
    const recent = searchHistory(corpus, "sha256", { scope: "recent" });
    expect(recent.header.scanned).toBe(3); // seq 4 (summary), 5 (keptText), 6
    expect(recent.hits.map((h) => h.seq)).toEqual([4]);
    // scope all reaches the compacted-away original too, marked as such
    const all = searchHistory(corpus, "sha256");
    expect(all.hits.map((h) => h.seq)).toEqual([4, 0]);
    expect(all.hits[1]?.compacted).toBe(true);
  });

  it("the LATEST boundary wins when the session compacted twice", async () => {
    const sid = "twice";
    const a = user("v1 anchor otter");
    const b = assistant("kept after first otter");
    await store.append(sid, a);
    await store.appendEntry(sid, buildCompactBoundaryEntry({ firstKeptEntryId: messageEntryId(a), reason: "threshold", tier: 2 }));
    await store.append(sid, b);
    await store.appendEntry(sid, buildCompactBoundaryEntry({ firstKeptEntryId: messageEntryId(b), reason: "threshold", tier: 2 }));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.recentFromSeq).toBe(1); // b's position — the latest chain head
  });

  it("an unresolvable boundary fingerprint degrades honestly (no boundary)", async () => {
    const sid = "unresolvable";
    await store.append(sid, user("some otter turn"));
    await store.appendEntry(sid, buildCompactBoundaryEntry({ firstKeptEntryId: "user-999-deadbeef", reason: "threshold", tier: 2 }));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.recentFromSeq).toBeUndefined();
    expect(searchHistory(corpus, "otter", { scope: "recent" }).header.matches).toBe(1);
  });

  it("carries time anchors from the ledger's receipts (nearest preceding)", async () => {
    const sid = "timestamps";
    await store.appendEntry(sid, { type: "model_change", model: "glm-5.3", at: "2026-09-26T09:00:00.000Z" });
    await store.append(sid, user("anchored turn"));
    await store.appendEntry(sid, { type: "provider_change", provider: "deepseek", model: "deepseek-v4", at: "2026-09-26T10:00:00.000Z" });
    await store.append(sid, assistant("later anchored turn"));

    const corpus = await historySearchCorpus(store, sid);
    expect(corpus.entries[0]?.at).toBe("2026-09-26T09:00:00.000Z");
    expect(corpus.entries[1]?.at).toBe("2026-09-26T10:00:00.000Z");

    const bare = await historySearchCorpus(store, "corpus-basic"); // no receipts
    expect(bare.entries.every((e) => e.at === undefined)).toBe(true);
  });

  it("an empty/absent ledger is an honest empty corpus", async () => {
    const corpus = await historySearchCorpus(store, "never-written");
    expect(corpus.entries).toEqual([]);
    expect(corpus.totalMessages).toBe(0);
    expect(corpus.recentFromSeq).toBeUndefined();
  });
});

describe("search_history tool surface (121 #1)", () => {
  const stubModel: ModelClient = {
    async generate(): Promise<AgentMessage> {
      return { role: "assistant", content: "" };
    },
  };
  const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });
  const emptyCorpus = async () => ({ entries: [], totalMessages: 0 });

  it("joins the TOP-LEVEL set at a FIXED position right after session_result", () => {
    const tools: readonly Tool[] = buildToolSet({
      workspaceRoot: root,
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      sessionResult: { load: async () => [] },
      historySearch: { load: emptyCorpus },
    });
    const names = tools.map((t) => t.name);
    expect(names).toContain("search_history");
    expect(names.indexOf("search_history")).toBe(names.indexOf("session_result") + 1);
  });

  it("fail-absent seam: no loader, no surface (every existing fixture's bytes unchanged)", () => {
    const names = buildToolSet({
      workspaceRoot: root,
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
    }).map((t) => t.name);
    expect(names).not.toContain("search_history");
  });

  it("the seam composes end-to-end: loader → search → newest-first hits over the real ledger", async () => {
    const sid = "e2e";
    await store.append(sid, user("conclusion one: the otter pipeline works"));
    await store.append(sid, assistant("conclusion two: the otter pipeline is fast"));
    const tools: readonly Tool[] = buildToolSet({
      workspaceRoot: root,
      model: stubModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      historySearch: { load: () => historySearchCorpus(store, sid) },
    });
    const tool = tools.find((t) => t.name === "search_history");
    expect(tool).toBeDefined();
    const r = await tool!.execute({ query: "otter pipeline" }, undefined as never);
    expect(r.isError).toBeUndefined();
    const lines = (r.content as string).split("\n");
    const header = JSON.parse(lines[0] as string) as { matches: number; scope: string };
    expect(header.matches).toBe(2);
    expect(header.scope).toBe("all");
    const first = JSON.parse(lines[1] as string) as { seq: number; role: string };
    expect(first.seq).toBe(1); // newest first
    expect(first.role).toBe("assistant");
  });

  it("carries the read_file permission posture (READ_TOOLS + plan-mode read fence)", () => {
    expect(READ_TOOLS.has("search_history")).toBe(true);
    expect(decidePermission("plan", "search_history")).toEqual({ behavior: "allow" });
  });
});
