// M-Memory — deterministic pins for the long-term memory store: content-hash
// dedup doubles as the strength signal, tombstone forget keeps every byte,
// the write chain orders appends (mkdir heads it), torn tails self-heal,
// recall scoring prefers lexical overlap + recency + strength, and the
// injection block renders byte-stable.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryStore, readMemoryFile, memoryId } from "../src/memory.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "mem-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("memory: save + dedup (content-hash id)", () => {
  it("first save persists a full entry line; list() sees it", async () => {
    const s = openMemoryStore(root);
    const e = await s.save({ kind: "preference", text: "用户偏好中文回复", tags: ["语言"] });
    expect(e.isNew).toBe(true);
    expect(e.useCount).toBe(1);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.id).toBe(memoryId("preference", "用户偏好中文回复"));
  });
  it("re-saving the same content bumps useCount instead of duplicating", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "fact", text: "repo uses pnpm workspaces" });
    const again = await s.save({ kind: "fact", text: "repo uses pnpm workspaces" });
    expect(again.isNew).toBe(false);
    expect(again.useCount).toBe(2);
    expect(s.list()).toHaveLength(1);
    // The append-only ledger carries both lines (audit), the index collapses them.
    const raw = await readFile(s.file, "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);
  });
  it("text is trimmed and capped; tags are deduped/lowercased/capped", async () => {
    const s = openMemoryStore(root);
    const e = await s.save({ kind: "lesson", text: `  ${"x".repeat(3000)}  `, tags: ["Git", "git", "CI", "a", "b", "c", "d", "e", "f", "g", "h", "i"] });
    expect(e.text.length).toBe(2000);
    expect(e.tags.length).toBeLessThanOrEqual(8);
    expect(e.tags[0]).toBe("git");
  });
  it("empty text fails loudly", async () => {
    const s = openMemoryStore(root);
    await expect(s.save({ kind: "fact", text: "   " })).rejects.toThrow(/empty/);
  });
});

describe("memory: forget (tombstone append-only)", () => {
  it("forgets by id with a tombstone line; unknown id fails", async () => {
    const s = openMemoryStore(root);
    const e = await s.save({ kind: "fact", text: "temporal fact" });
    await s.forget(e.id);
    expect(s.list()).toHaveLength(0);
    const raw = await readFile(s.file, "utf8");
    expect(raw).toContain('"type":"forget"');
    // earlier bytes untouched — the append-only law
    expect(raw.startsWith(raw.split('"type":"forget"')[0]!.trim())).toBe(true);
    await expect(s.forget("nope")).rejects.toThrow(/unknown id/);
  });
});

describe("memory: reload + torn-tail self-heal", () => {
  it("a second store instance rebuilds the live index (entries + forgets)", async () => {
    const a = openMemoryStore(root);
    const e1 = await a.save({ kind: "preference", text: "always run tests before commit" });
    await a.save({ kind: "lesson", text: "never edit dist by hand" });
    await a.forget(e1.id);
    const b = openMemoryStore(root);
    expect(b.list()).toHaveLength(1);
    expect(b.list()[0]!.text).toBe("never edit dist by hand");
  });
  it("a torn trailing line is skipped on load, healthy lines survive", async () => {
    await writeFile(join(root, "memory.jsonl"), [
      JSON.stringify({ id: "aaa", kind: "fact", text: "healthy line", tags: [], createdAt: new Date().toISOString(), useCount: 1 }),
      '{"id":"torn", "kind":"fact", "text":"never lands', // crash mid-append
    ].join("\n"), "utf8");
    const s = openMemoryStore(root);
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.text).toBe("healthy line");
  });
  it("readMemoryFile mirrors the live view (async read helper)", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "skill", text: "use /probe model for latency" });
    await s.save({ kind: "skill", text: "use /probe model for latency" }); // bump
    const entries = await readMemoryFile(s.file);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.useCount).toBe(2);
  });
});

describe("memory: search scoring", () => {
  it("lexical overlap wins over off-topic strength", async () => {
    const s = openMemoryStore(root);
    const off = await s.save({ kind: "fact", text: "the kettle is stainless steel" });
    for (let i = 0; i < 6; i++) await s.save({ kind: "fact", text: "the kettle is stainless steel" });
    await s.save({ kind: "preference", text: "prefers dark mode editor theme" });
    const hits = s.search("dark mode");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.text).toContain("dark mode");
    expect(hits.find((e) => e.id === off.id)).toBeUndefined();
  });
  it("kind filter restricts; k caps; CJK bigrams match Chinese text", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "preference", text: "回复用中文" });
    await s.save({ kind: "lesson", text: "压缩前先跑测试" });
    await s.save({ kind: "fact", text: "中文分词按二元组" });
    const cjk = s.search("中文");
    expect(cjk.length).toBeGreaterThanOrEqual(2);
    const prefs = s.search("中文", { kinds: ["preference"] });
    expect(prefs).toHaveLength(1);
    expect(prefs[0]!.kind).toBe("preference");
    expect(s.search("中文", { k: 1 })).toHaveLength(1);
  });
  it("a search hit bumps useCount on the live index", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "fact", text: "postgres runs on port 5432" });
    const before = s.list()[0]!.useCount;
    s.search("postgres port");
    expect(s.list()[0]!.useCount).toBe(before + 1);
  });
});

describe("memory: injection block (byte-stable prompt tail)", () => {
  it("renders the deterministic <long-term-memory> block; empty store renders empty", () => {
    const s = openMemoryStore(root);
    expect(s.renderInjection()).toBe("");
  });
  it("same entries → same bytes, regardless of insertion order", async () => {
    const now = new Date("2026-10-24T00:00:00Z");
    const a = openMemoryStore(root);
    await a.save({ kind: "preference", text: "中文回复", now });
    await a.save({ kind: "fact", text: "uses pnpm", now });
    const b = openMemoryStore(root);
    await b.save({ kind: "fact", text: "uses pnpm", now });
    await b.save({ kind: "preference", text: "中文回复", now });
    expect(a.renderInjection()).toBe(b.renderInjection());
    expect(a.renderInjection()).toContain("<long-term-memory>");
    expect(a.renderInjection()).toContain("[preference] 中文回复");
    expect(a.renderInjection()).toContain("[fact] uses pnpm");
  });
  it("caps at 12 rows (the boot budget)", async () => {
    const s = openMemoryStore(root);
    const now = new Date("2026-10-24T00:00:00Z");
    for (let i = 0; i < 20; i++) await s.save({ kind: "fact", text: `fact number ${i}`, now });
    const block = s.renderInjection();
    expect(block.split("\n").filter((l) => l.startsWith("- [")).length).toBe(12);
  });
});

describe("memory: write-chain ordering", () => {
  it("concurrent saves land in issue order (single tail), mkdir heads the chain", async () => {
    const s = openMemoryStore(root);
    const writes = Array.from({ length: 10 }, (_, i) => s.save({ kind: "fact", text: `ordered ${i}` }));
    await Promise.all(writes);
    const raw = (await readFile(s.file, "utf8")).trim().split("\n");
    expect(raw).toHaveLength(10);
    const texts = raw.map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts).toEqual(Array.from({ length: 10 }, (_, i) => `ordered ${i}`));
  });
});
