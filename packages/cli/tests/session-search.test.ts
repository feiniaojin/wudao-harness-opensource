// M49 §3 — the CJK session search index: bigram CJK + word latin tokenization,
// incremental append indexing (≤50ms/entry budget), BM25-lite ranking, corrupt
// index auto-rebuild, and the shared formatter the CLI subcommand and /search
// both render with.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import { createSessionSearchIndex, searchIndexPath, runSessionSearch, formatSearchHits } from "../src/session-search.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-search-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function seedSession(id: string, messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>): Promise<void> {
  const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
  for (const m of messages) await store.append(id, m);
}

describe("createSessionSearchIndex", () => {
  it("indexes appends incrementally, survives reload, ranks CJK and latin", async () => {
    await seedSession("s1", [
      { role: "user", content: "帮我修复登录页面的 bug" },
      { role: "assistant", content: "已修复:问题出在 auth.ts 的空指针" },
    ]);
    await seedSession("s2", [
      { role: "user", content: "run pnpm eval before merging the milestone" },
      { role: "assistant", content: "all green: 36 deterministic suites" },
    ]);

    const ix = createSessionSearchIndex(dir);
    // Incremental indexing of the persisted messages (the append-site path).
    const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
    for (const id of await store.list()) {
      const entries = await store.loadSessionEntries(id);
      const msgs = entries.filter((e): e is { role: "user" | "assistant"; content: string } => "role" in e && (e.role === "user" || e.role === "assistant"));
      for (const m of msgs) ix.indexMessage(id, m);
    }
    await ix.flush();

    // A fresh instance loads the flushed file and finds the same docs.
    const reloaded = createSessionSearchIndex(dir);
    const zhHits = await reloaded.search("修复 登录");
    expect(zhHits.length).toBeGreaterThan(0);
    expect(zhHits[0]!.sessionId).toBe("s1");
    expect(zhHits[0]!.excerpt).toContain("修复登录页面");
    expect(zhHits[0]!.role).toBe("user");

    const enHits = await reloaded.search("pnpm eval");
    expect(enHits.length).toBeGreaterThan(0);
    expect(enHits[0]!.sessionId).toBe("s2");

    // BM25-lite ordering: the doc mentioning BOTH query terms outranks a
    // single-term doc.
    await seedSession("s3", [{ role: "user", content: "eval only mention" }]);
    const ix3 = createSessionSearchIndex(dir);
    ix3.indexMessage("s3", { role: "user", content: "eval only mention" });
    await ix3.flush();
    const ranked = await ix3.search("pnpm eval");
    expect(ranked[0]!.sessionId).toBe("s2");
  });

  it("later appends continue the ordinal sequence (no clobber, no gaps)", async () => {
    await seedSession("s1", [{ role: "user", content: "first message about caching" }]);
    const ix = createSessionSearchIndex(dir);
    ix.indexMessage("s1", { role: "user", content: "first message about caching" });
    await ix.flush();

    // A new append lands at ordinal 1 in the SAME index instance and after a
    // reload in a fresh one.
    const ix2 = createSessionSearchIndex(dir);
    ix2.indexMessage("s1", { role: "assistant", content: "second message: cache hit rate 89%" });
    await ix2.flush();

    const ix3 = createSessionSearchIndex(dir);
    const all = await ix3.search("cache");
    expect(all.map((h) => h.sessionId)).toContain("s1");
    const second = await ix3.search("hit rate");
    expect(second[0]!.ordinal).toBe(1);
    const first = await ix3.search("first message");
    expect(first[0]!.ordinal).toBe(0);
  });

  it("tool results are not indexed (bulk file content is noise)", async () => {
    const ix = createSessionSearchIndex(dir);
    ix.indexMessage("s1", { role: "user", content: "the word needle" });
    ix.indexMessage("s1", { role: "tool", toolCallId: "c1", name: "read_file", content: "needle needle needle bulk file content" });
    await ix.flush();
    const reloaded = createSessionSearchIndex(dir);
    const hits = await reloaded.search("needle");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.role).toBe("user");
  });

  it("a corrupt index file rebuilds itself from the session JSONLs", async () => {
    await seedSession("s1", [{ role: "user", content: "fix the login bug please" }]);
    await mkdir(join(dir, ".wudao"), { recursive: true });
    await writeFile(searchIndexPath(dir), "{not json at all", "utf8");

    const ix = createSessionSearchIndex(dir);
    const hits = await ix.search("login bug");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sessionId).toBe("s1");
    // The rebuilt file is valid JSON and reloads cleanly.
    const ix2 = createSessionSearchIndex(dir);
    expect((await ix2.search("login bug"))[0]!.sessionId).toBe("s1");
  });

  it("incremental indexing stays inside the ≤50ms/entry budget", async () => {
    await mkdir(join(dir, ".wudao", "sessions"), { recursive: true });
    const ix = createSessionSearchIndex(dir);
    const started = Date.now();
    const N = 100;
    for (let i = 0; i < N; i += 1) {
      ix.indexMessage("perf", { role: i % 2 === 0 ? "user" : "assistant", content: `第${i}条会话消息:修复登录页面并跑 pnpm eval message ${i} about the build` });
    }
    await ix.flush();
    const perEntryMs = (Date.now() - started) / N;
    expect(perEntryMs).toBeLessThan(50);
  });

  it("empty queries and unknown terms degrade politely", async () => {
    const ix = createSessionSearchIndex(dir);
    expect(await ix.search("")).toEqual([]);
    expect(await ix.search("zzz-nothing")).toEqual([]);
    expect(runSessionSearch(dir, "  ")).resolves.toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#8）
    expect(formatSearchHits([])).toContain("no sessions match");
  });

  it("a multi-message flush against a MISSING index never double-indexes (live-smoke regression)", async () => {
    // The append sites persist first, index second, then flush — on the very
    // first run the index file does not exist, so the flush's rebuild scans
    // the file (already carrying the messages) AND the pending queue holds
    // the same messages. The aligned-tail dedup must drop every one of them.
    await seedSession("s1", [
      { role: "user", content: "帮我查看 README 并总结测试命令" },
      { role: "assistant", content: "已查看,测试命令是 pnpm eval" },
      { role: "user", content: "谢谢" },
    ]);
    const ix = createSessionSearchIndex(dir);
    const store = createJsonlSessionStore(join(dir, ".wudao", "sessions"));
    const msgs = (await store.loadSessionEntries("s1")).filter((e): e is { role: "user" | "assistant"; content: string } => "role" in e && (e.role === "user" || e.role === "assistant"));
    for (const m of msgs) ix.indexMessage("s1", m);
    await ix.flush();

    const ix2 = createSessionSearchIndex(dir);
    const hits = await ix2.search("总结 测试");
    expect(hits.every((h) => h.excerpt !== "(session file unavailable)")).toBe(true);
    const raw = JSON.parse(await readFile(searchIndexPath(dir), "utf8")) as { sessions: Record<string, number> };
    expect(raw.sessions["s1"]).toBe(3); // not 6
  });

  it("runSessionSearch formats the shared hit rows (CLI + /search same source)", async () => {
    await seedSession("wudao-abc", [{ role: "user", content: "修复 router 的空指针崩溃" }]);
    // First search rebuilds from disk when no incremental index exists yet.
    const out = await runSessionSearch(dir, "空指针");
    expect(out).toContain("wudao-abc".slice(0, 8));
    expect(out).toContain("[user]");
    expect(out).toContain("空指针");
  });
});
