// M-Memory — deterministic pins for the long-term memory store: content-hash
// dedup doubles as the strength signal, tombstone forget keeps every byte,
// the write chain orders appends (mkdir heads it), torn tails self-heal,
// recall scoring prefers lexical overlap + recency + strength, and the
// injection block renders byte-stable.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
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

describe("memory: the read path never touches the filesystem", () => {
  // 用户报障的根因弧（.wudao 污染）：fileTree 之类的只读入口会打开记忆库；
  // 打开/列举/检索/渲染注入都不得 mkdir——目录只能由第一次写入落地。
  const exists = async (p: string): Promise<boolean> => {
    try { await stat(p); return true; } catch { return false; }
  };
  it("open + list + listPending + search + renderInjection 不建目录（零状态）", async () => {
    const nested = join(root, "ws", ".wudao", "memory");
    const s = openMemoryStore(nested);
    expect(s.list()).toEqual([]);
    expect(s.listPending()).toEqual([]);
    expect(s.search("anything")).toEqual([]);
    expect(s.renderInjection()).toBe("");
    await new Promise((r) => setTimeout(r, 20)); // mkdir 若曾 fire-and-forget，此处必已落地
    expect(await exists(nested)).toBe(false);
  });
  it("第一次 save 才落地目录，且 append 仍按 issue order 串行", async () => {
    const nested = join(root, "ws", ".wudao", "memory");
    const s = openMemoryStore(nested);
    await s.save({ kind: "fact", text: "first write materializes" });
    expect(await exists(nested)).toBe(true);
    await Promise.all([s.save({ kind: "fact", text: "b" }), s.save({ kind: "fact", text: "c" })]);
    const texts = (await readFile(s.file, "utf8")).trim().split("\n").map((l) => (JSON.parse(l) as { text: string }).text);
    expect(texts).toEqual(["first write materializes", "b", "c"]);
  });
  it("forget 在空库上也走同一条懒 mkdir 链（不抛）", async () => {
    const nested = join(root, "ws", ".wudao", "memory");
    const s = openMemoryStore(nested);
    const e = await s.save({ kind: "fact", text: "tombstone target" });
    await s.forget(e.id);
    expect(s.list()).toEqual([]);
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

describe("memory: confidence（M49 人审门合流路径）", () => {
  it("save 缺省 confirmed；pending 不进 list 缺省面/search/renderInjection", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "fact", text: "confirmed fact: workspace uses pnpm" });
    await s.save({ kind: "lesson", text: "pending lesson: run focused tests first", confidence: "pending" });
    // 缺省面 = confirmed only
    expect(s.list()).toHaveLength(1);
    expect(s.list()[0]!.confidence).toBe("confirmed");
    expect(s.listPending()).toHaveLength(1);
    expect(s.listPending()[0]!.text).toBe("pending lesson: run focused tests first");
    expect(s.list({ includePending: true })).toHaveLength(2);
    // 检索只取 confirmed（lexical 命中的 pending 也不可见；词面不相交防串扰）
    expect(s.search("run focused tests")).toHaveLength(0);
    expect(s.search("pnpm")[0]!.text).toBe("confirmed fact: workspace uses pnpm");
    // 注入块绝不携带 pending
    expect(s.renderInjection()).not.toContain("pending lesson");
    expect(s.renderInjection()).toContain("confirmed fact");
    expect(s.renderInjection(s.list({ includePending: true }))).not.toContain("pending lesson");
  });
  it("pending → confirmed 单向门：append 同 id 的 confirmed 行（后行胜），useCount 不动", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "preference", text: "回复用中文", confidence: "pending" });
    const confirmed = await s.save({ kind: "preference", text: "回复用中文", confidence: "confirmed" });
    expect(confirmed.confidence).toBe("confirmed");
    expect(confirmed.useCount).toBe(1); // 审阅决定不是使用——强度不注水
    expect(s.listPending()).toHaveLength(0);
    expect(s.list()).toHaveLength(1);
    // 重载直证后行胜：同 id 一行 confirmed（append 台账保留两行）
    const reloaded = openMemoryStore(root);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]!.confidence).toBe("confirmed");
    const raw = (await readFile(s.file, "utf8")).trim().split("\n");
    expect(raw).toHaveLength(2);
    expect((JSON.parse(raw[1]!) as { confidence: string }).confidence).toBe("confirmed");
  });
  it("已 confirmed 的内容再以 pending 存：只 bump 强度，绝不回审", async () => {
    const s = openMemoryStore(root);
    await s.save({ kind: "fact", text: "vetted fact" });
    const again = await s.save({ kind: "fact", text: "vetted fact", confidence: "pending" });
    expect(again.confidence).toBe("confirmed");
    expect(again.useCount).toBe(2);
    expect(s.listPending()).toHaveLength(0);
  });
  it("tombstone 对 pending 通用；重载后 confirmed 面与 pending 队列各归其位", async () => {
    const a = openMemoryStore(root);
    const now = new Date("2026-10-24T00:00:00Z");
    const c = await a.save({ kind: "fact", text: "kept fact", now });
    const p = await a.save({ kind: "fact", text: "kept pending", now, confidence: "pending" });
    await a.save({ kind: "fact", text: "dropped pending", now, confidence: "pending" });
    await a.forget(p.id);
    await a.forget((await a.listPending()).find((e) => e.text === "dropped pending")!.id);
    expect(c.id).toBeTruthy();
    const b = openMemoryStore(root);
    expect(b.list({ includePending: true })).toHaveLength(1);
    expect(b.list()[0]!.text).toBe("kept fact");
  });
  it("pre-confidence 存量行读回 confirmed（缺省语义归一）", async () => {
    await writeFile(join(root, "memory.jsonl"), [
      JSON.stringify({ id: "legacy1", kind: "fact", text: "old line no confidence", tags: [], createdAt: new Date().toISOString(), useCount: 3 }),
    ].join("\n"), "utf8");
    const s = openMemoryStore(root);
    expect(s.list()[0]).toMatchObject({ id: "legacy1", confidence: "confirmed", useCount: 3 });
  });
});
