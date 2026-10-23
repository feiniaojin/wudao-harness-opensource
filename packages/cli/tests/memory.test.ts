// M49 §1 — memory store: append-only JSONL, the write-assessment matrix
// (bounded / non-sensitive / novel / project-scope), the pending-review flow
// (surface once → ok/del), bounded recall, and the /memory command family.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  openMemoryStore,
  assessMemoryWrite,
  CREDENTIAL_RE,
  memoryStorePath,
  recallMemories,
  RECALL_LEAD,
  createMemoryTools,
  runMemoryCommand,
  surfacePendingReview,
  formatPendingReview,
  createMemoryRuntime,
  memoryAgeDays,
  memoryAgeLabel,
  RECALL_STALENESS_NOTE,
  applyRefinement,
} from "../src/memory/index.js";
import type { MemoryEntry, MemoryWriteInput, RefineProposal } from "../src/memory/index.js";
import { recallCutoff } from "../src/memory/recall.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-memory-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function entry(over: Partial<MemoryEntry> & { id: string; content: string }): MemoryEntry {
  return {
    kind: "fact",
    scope: "project",
    tags: [],
    created: "2026-08-17T00:00:00.000Z",
    hits: 0,
    status: "active",
    ...over,
  };
}

function write(content: string, over: Partial<MemoryWriteInput> = {}): MemoryWriteInput {
  return { kind: "fact", content, ...over };
}

// ---------------------------------------------------------------------------
// Write assessment matrix (pure)
// ---------------------------------------------------------------------------

describe("assessMemoryWrite — the auto-allow matrix", () => {
  it("auto-allows a bounded, non-sensitive, novel, project-scope note", () => {
    const r = assessMemoryWrite(write("run pnpm eval before merging any milestone"), []);
    expect(r.decision).toBe("auto");
    expect(r.reasons).toEqual([]);
  });

  it("rejects unbounded content (>500 chars) to pending", () => {
    const r = assessMemoryWrite(write("x".repeat(501)), []);
    expect(r.decision).toBe("pending");
    expect(r.reasons.join(" ")).toContain("bounded");
  });

  it("rejects credential-shaped content to pending", () => {
    for (const bad of [
      "the api key is sk-abcdef12345678",
      "password: hunter2hunter2",
      "-----BEGIN RSA PRIVATE KEY-----",
      "token gh token ghp_" + "a1b2c3d4e5f6a1b2c3d4",
    ]) {
      expect(CREDENTIAL_RE.test(bad)).toBe(true);
      const r = assessMemoryWrite(write(bad), []);
      expect(r.decision).toBe("pending");
      expect(r.reasons.join(" ")).toContain("sensitive");
    }
  });

  it("rejects near-duplicates (Jaccard ≥ 0.7) to pending", () => {
    const existing = [entry({ id: "m-a", content: "run pnpm eval before merging any milestone change" })];
    const r = assessMemoryWrite(write("run pnpm eval before merging any milestone"), existing);
    expect(r.decision).toBe("pending");
    expect(r.reasons.join(" ")).toContain("novelty");
    // A clearly different note stays auto.
    expect(assessMemoryWrite(write("the router tests live in packages/core/tests"), existing).decision).toBe("auto");
  });

  it("never auto-allows user scope", () => {
    const r = assessMemoryWrite(write("user prefers dark theme", { scope: "user" }), []);
    expect(r.decision).toBe("pending");
    expect(r.reasons.join(" ")).toContain("scope");
  });

  it("CJK near-duplicates are caught too (bigram Jaccard)", () => {
    const existing = [entry({ id: "m-a", content: "合并里程碑之前必须先跑确定性验收测试" })];
    const dup = assessMemoryWrite(write("合并里程碑之前必须先跑确定性验收"), existing);
    expect(dup.decision).toBe("pending");
    expect(assessMemoryWrite(write("登录页面使用中文提示信息"), existing).decision).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// The store itself
// ---------------------------------------------------------------------------

describe("openMemoryStore — append-only JSONL + pending flow", () => {
  it("auto writes land active; assessed-pending writes land pending", async () => {
    const store = await openMemoryStore(dir);
    const a = await store.write(write("run pnpm eval before merging"));
    expect(a.decision).toBe("auto");
    expect(a.entry.status).toBe("active");
    // 永续 v6 弧 A（reef C3）钉随迁：凭据**话题**（无值）保持 pending 人审；
    // 含 sk- 值的写入现被块档门拒之门外（不入 pending——见 memory-guard.test.ts）。
    const b = await store.write(write("the password policy is rotating monthly"));
    expect(b.decision).toBe("pending");
    expect(b.entry.status).toBe("pending");

    const all = await store.load();
    expect(all).toHaveLength(2);
    expect(await store.active()).toHaveLength(1);
    expect(await store.pendingReview()).toHaveLength(1);

    // The file is JSONL with exactly these entries, in order.
    const text = await readFile(memoryStorePath(dir), "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!).id).toBe(b.entry.id);
  });

  it("the pending flow: surface once → still listed → ok confirms → surfaced no more", async () => {
    const store = await openMemoryStore(dir);
    const p = await store.write(write("user prefers dark theme", { scope: "user" }));
    expect(await store.pendingReview()).toHaveLength(1);

    await store.markSurfaced([p.entry.id]);
    expect(await store.pendingReview()).toHaveLength(0); // one-time rule
    expect((await store.load()).find((e) => e.id === p.entry.id)?.status).toBe("pending"); // decision still open

    expect(await store.confirm(p.entry.id)).toBe(true);
    const confirmed = (await store.load()).find((e) => e.id === p.entry.id);
    expect(confirmed?.status).toBe("active");
    expect(await store.confirm(p.entry.id)).toBe(false); // already active
  });

  it("del removes by id; bumpHits is the recall telemetry", async () => {
    const store = await openMemoryStore(dir);
    const a = await store.write(write("run pnpm eval before merging"));
    await store.bumpHits([a.entry.id, "m-nope"]);
    const after = (await store.load()).find((e) => e.id === a.entry.id);
    expect(after?.hits).toBe(1);
    expect(await store.remove(a.entry.id)).toBe(true);
    expect(await store.remove(a.entry.id)).toBe(false);
    expect(await store.load()).toHaveLength(0);
  });

  it("skips corrupt lines on load (never aborts the store)", async () => {
    await mkdir(join(dir, ".wudao"), { recursive: true });
    await writeFile(memoryStorePath(dir), "not json\n" + JSON.stringify({ id: "m-x", junk: true }) + "\n", "utf8");
    const store = await openMemoryStore(dir);
    expect(await store.load()).toEqual([]);
    // And the store still works for a fresh write.
    const r = await store.write(write("fresh note after corruption"));
    expect(r.decision).toBe("auto");
  });
});

// ---------------------------------------------------------------------------
// Bounded recall
// ---------------------------------------------------------------------------

describe("recallMemories — bounded greedy recall (≤4 items / 2400 chars)", () => {
  it("scores by prompt tag match + recent-session tags, low-authority lead", () => {
    const entries = [
      entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"] }),
      entry({ id: "m-2", content: "the router tests live in core", tags: ["testing"] }),
      entry({ id: "m-3", content: "banner colors are themed", tags: ["ui"] }),
    ];
    const r = recallMemories({ entries, prompt: "how do I check the build before merge?", recentTags: ["testing"] });
    expect(r.note).toBeDefined();
    expect(r.note!.startsWith(RECALL_LEAD)).toBe(true);
    expect(r.note!).toContain("run pnpm eval");
    expect(r.note!).toContain("router tests");
    expect(r.note).not.toContain("banner");
    expect(r.selected.map((e) => e.id)).toEqual(["m-1", "m-2"]);
  });

  it("caps at 4 items and 2400 chars", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      entry({ id: `m-${i}`, content: `note number ${i} `.repeat(40), tags: ["build"] }),
    );
    const r = recallMemories({ entries: many, prompt: "build build build" });
    expect(r.selected.length).toBeLessThanOrEqual(4);
    // 夜移 015: the slack covers per-line age suffixes + the note-level
    // staleness caveat (framing, like the lead — never item budget).
    expect(r.note!.length).toBeLessThanOrEqual(2400 + RECALL_LEAD.length + 224);
  });

  it("returns nothing when nothing scores (no noise injection)", () => {
    const r = recallMemories({ entries: [entry({ id: "m-1", content: "unrelated note" })], prompt: "fix the login page" });
    expect(r.selected).toEqual([]);
    expect(r.note).toBeUndefined();
  });

  it("only ACTIVE entries are recall candidates", () => {
    const r = recallMemories({
      entries: [entry({ id: "m-p", content: "pending password note", tags: ["login"], status: "pending" })],
      prompt: "login login",
    });
    expect(r.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ω99-6a — recall 相对分地板 (MiMo memory_search_score_floor 的无 SQLite 落法,
// MiMo-Code .../memory/service.ts:83)。score>0 即入选让纯 overlap 弱尾巴与
// 强 tag 匹配同池占预算; 地板 = top * 0.15 (top 恒保留)。整数分域效果:
// best=10 (5 tag 命中) → 纯 overlap 尾巴 (≤1 分) 被裁; 相对非绝对, 弱 query
// 不至于全空。(6b 起 cutoff 由 recallCutoff 复合计算, 下方 ω99-6b。)
// ---------------------------------------------------------------------------

describe("ω99-6a — relative score floor (top * RECALL_FLOOR_RATIO)", () => {
  it("cuts the pure-overlap tail when a strong tag match tops the pool", () => {
    const entries = [
      entry({ id: "m-strong", content: "pnpm eval gates the merge", tags: ["build", "test", "ci", "merge", "gate"] }),
      // overlap-only weak tail: prompt words recur in content but tags never match.
      entry({ id: "m-weak-1", content: "the build step also runs a lint pass" }),
      entry({ id: "m-weak-2", content: "see the build docs before every release" }),
    ];
    const r = recallMemories({ entries, prompt: "build test ci merge gate release" });
    // top = 5 tag hits = 10 分 → 6b cutoff max(1.5, 2) = 2; overlap-only ≤1 → cut.
    expect(r.selected.map((e) => e.id)).toEqual(["m-strong"]);
    expect(r.note).not.toContain("lint pass");
    expect(r.note).not.toContain("build docs");
  });

  it("always keeps the top hit even when its score is low", () => {
    const r = recallMemories({
      entries: [entry({ id: "m-only", content: "deploys go through the release channel", tags: ["deploy"] })],
      prompt: "deploy the site",
    });
    // top = 单 tag 命中 = 2.1 分 → 6b cutoff 2, 2.1 < 2 false —— 弱 query 不至于全空。
    expect(r.selected.map((e) => e.id)).toEqual(["m-only"]);
    expect(r.note).toContain("release channel");
  });

  it("never cuts a uniform pool (equal scores all clear the floor)", () => {
    const entries = [
      entry({ id: "m-a", content: "first build note", tags: ["build"] }),
      entry({ id: "m-b", content: "second build note", tags: ["build"] }),
      entry({ id: "m-c", content: "third build note", tags: ["build"] }),
    ];
    const r = recallMemories({ entries, prompt: "check the build" });
    // 全部同分 (2.1) → 6b cutoff 2 → 全入选 —— 地板不误伤均匀池。
    expect(r.selected.map((e) => e.id)).toHaveLength(3);
  });

  it("empty and no-match pools still return nothing (regression)", () => {
    expect(recallMemories({ entries: [], prompt: "anything" })).toEqual({ selected: [], note: undefined });
    const miss = recallMemories({ entries: [entry({ id: "m-x", content: "unrelated note" })], prompt: "fix the login page" });
    expect(miss.selected).toEqual([]);
    expect(miss.note).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ω99-6b — recall 地板分域修正 (wudao 自研, 修 6a 照搬常数之洞)。6a 的裸
// 比例 0.15 源自 MiMo 的连续相似度分域; wudao 的分域是分层整数:
// score = tagHits*2 + min(1, overlap*0.1) —— ≥1 tag 命中 ∈ [2,∞), 纯
// overlap ∈ (0,1], 断崖在 (1,2]。中强 top (2 tag = 4 分) 下 relative 0.6
// 够不到断崖, 1.0 纯 overlap 弱尾漏过占预算。修法 (超越点, 无参考有此
// 机制): cutoff = top ≥ tierMin ? max(relative, tierMin) : relative ——
// 比例语义保留 (强 top 相对裁), tier 最小值把地板钉在断崖上; top 未达
// tag 层 (全池无 tag 命中) 时纯比例继续, 弱 query 不至于全空。
// ---------------------------------------------------------------------------

describe("ω99-6b — tier 感知断崖地板 (max(relative, tierMin))", () => {
  it("cuts the pure-overlap tail under a mid-strong 2-tag top (6a's hole)", () => {
    // top = 2 tag 命中 = 4 分 (content 与 prompt 零重叠); 弱尾 10 个 distinct
    // 词重叠 = 恰 1.0 分。6a 裸比例 cutoff 0.6 → 弱尾入选; 6b cutoff 2 → 裁。
    const entries = [
      entry({ id: "m-strong", content: "deploys go through the ci channel nightly", tags: ["build", "test"] }),
      entry({ id: "m-weak", content: "build test deploy release merge cache prefix stream reason tool plus filler" }),
    ];
    const r = recallMemories({ entries, prompt: "build test deploy release merge cache prefix stream reason tool" });
    expect(r.selected.map((e) => e.id)).toEqual(["m-strong"]);
    expect(r.note).not.toContain("filler");
  });

  it("keeps a 1-tag entry (score 2) under a 5-tag top — the cliff never cuts its own tier", () => {
    const entries = [
      entry({ id: "m-strong", content: "pnpm eval before any milestone lands", tags: ["build", "test", "ci", "merge", "gate"] }),
      entry({ id: "m-onetag", content: "the gatehouse note ships weekly", tags: ["build"] }),
      entry({ id: "m-weak", content: "the build step also runs a lint pass" }),
    ];
    const r = recallMemories({ entries, prompt: "build test ci merge gate release" });
    // top = 10 → cutoff max(1.5, 2) = 2: m-onetag 2 < 2 false 留; 弱尾 0.1 裁。
    expect(r.selected.map((e) => e.id)).toEqual(["m-strong", "m-onetag"]);
    expect(r.note).not.toContain("lint pass");
  });

  it("a single-tag top (score 2) survives its own cliff; the overlap tail does not", () => {
    const entries = [
      entry({ id: "m-top", content: "deploys go through the merge channel", tags: ["build"] }),
      entry({ id: "m-second", content: "the other queue carries hotfix trains", tags: ["build"] }),
      entry({ id: "m-weak", content: "alpha beta gamma delta epsilon zeta eta theta iota build filler" }),
    ];
    const r = recallMemories({ entries, prompt: "build alpha beta gamma delta epsilon zeta eta theta iota" });
    // top = 2 (1 tag 零重叠) → cutoff 2; 2 < 2 false —— top 恒留, 第二个
    // 1-tag 条目 (同 2 分) 留, 1.0 纯 overlap 弱尾裁。
    expect(r.selected.map((e) => e.id).sort()).toEqual(["m-second", "m-top"]);
    expect(r.note).not.toContain("filler");
  });

  it("a no-tag pool (top below the tier) keeps pure-ratio behavior — weak queries never empty out", () => {
    const entries = [
      entry({ id: "m-top", content: "alpha beta gamma delta epsilon zeta eta theta iota kappa plus" }),
      entry({ id: "m-near", content: "alpha beta filler only" }),
      entry({ id: "m-far", content: "gamma filler only" }),
    ];
    const r = recallMemories({ entries, prompt: "alpha beta gamma delta epsilon zeta eta theta iota kappa" });
    // 全池无 tag → top 1.0 < 2 → 纯比例 cutoff 0.15: near 0.2 留, far 0.1 裁。
    expect(r.selected.map((e) => e.id)).toEqual(["m-top", "m-near"]);
  });

  it("a uniform all-tag pool (every score ≥ 2) is never cut by its own cliff", () => {
    const entries = [
      entry({ id: "m-a", content: "first build note", tags: ["build"] }),
      entry({ id: "m-b", content: "second build note", tags: ["build"] }),
      entry({ id: "m-c", content: "third build note", tags: ["build"] }),
    ];
    const r = recallMemories({ entries, prompt: "check the build" });
    // 全池同 2.1 → cutoff 2, 2.1 < 2 false —— 均匀池全留 (6a 语义回归)。
    expect(r.selected.map((e) => e.id).sort()).toEqual(["m-a", "m-b", "m-c"]);
  });

  it("exhaustive integer-domain table: top ∈ {2,4,10} × candidate score 的裁/留全表", () => {
    // 断崖钉位后 top ∈ {2,4,10} 的 cutoff 全为 2 (relative 0.3/0.6/1.5 均被
    // max 顶到断崖): ≥2 的候选全留 (含恰 2), ≤1 的纯 overlap 候选全裁。
    const KEEP = new Set([2.0, 2.2, 4.0]);
    for (const top of [2, 4, 10]) {
      for (const score of [0.1, 0.5, 1.0, 2.0, 2.2, 4.0]) {
        expect(score >= recallCutoff(top), `top=${top} score=${score}`).toBe(KEEP.has(score));
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 夜移 015 (#22) — 真 CC memdir 读侧召回的 wudao 适配切片: memoryAge 陈旧
// 注记（模型不做日期算术——条目带 created ISO 但模型从未见过"多旧"），
// 读侧池 200 帽，hits 每会话一次。见 ledger 候选 #22 行。
// ---------------------------------------------------------------------------

describe("memoryAge — staleness annotation (真 CC memoryAge.ts adaptation)", () => {
  const NOW = Date.parse("2026-08-28T12:00:00.000Z");

  it("memoryAgeDays floors whole days, clamps clock skew to 0, tolerates junk", () => {
    expect(memoryAgeDays("2026-08-28T12:00:00.000Z", NOW)).toBe(0);
    expect(memoryAgeDays("2026-08-27T12:00:00.000Z", NOW)).toBe(1); // exactly 24h
    expect(memoryAgeDays("2026-08-27T00:00:00.000Z", NOW)).toBe(1); // 36h floors to 1
    expect(memoryAgeDays("2026-08-25T12:01:00.000Z", NOW)).toBe(2); // 71h59m floors to 2
    expect(memoryAgeDays("2026-08-25T12:00:00.000Z", NOW)).toBe(3); // exactly 72h
    expect(memoryAgeDays("2026-08-29T00:00:00.000Z", NOW)).toBe(0); // future clamps to 0
    expect(memoryAgeDays("not-a-timestamp", NOW)).toBe(0); // junk reads as fresh
  });

  it("memoryAgeLabel is the model-facing arithmetic (today/yesterday/Nd)", () => {
    expect(memoryAgeLabel(0)).toBe("today");
    expect(memoryAgeLabel(1)).toBe("yesterday");
    expect(memoryAgeLabel(2)).toBe("2d ago");
    expect(memoryAgeLabel(400)).toBe("400d ago");
  });

  it("recall lines carry the age suffix (the model never sees raw created)", () => {
    const aged = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: "2026-08-25T12:00:00.000Z" })],
      prompt: "how about the build",
      now: NOW,
    });
    expect(aged.note).toContain("(tags: build; 3d ago)");
    const fresh = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: new Date(NOW).toISOString() })],
      prompt: "how about the build",
      now: NOW,
    });
    expect(fresh.note).toContain("(tags: build; today)");
    const untagged = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", created: new Date(NOW - 86_400_000).toISOString() })],
      prompt: "run pnpm eval",
      now: NOW,
    });
    expect(untagged.note).toContain("(yesterday)");
  });

  it("appends the staleness caveat exactly when a selected entry is ≥2 days old", () => {
    const stale = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: "2026-08-25T12:00:00.000Z" })],
      prompt: "how about the build",
      now: NOW,
    });
    expect(stale.note).toContain(RECALL_STALENESS_NOTE);
    const fresh = recallMemories({
      entries: [entry({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"], created: new Date(NOW - 86_400_000).toISOString() })],
      prompt: "how about the build",
      now: NOW,
    });
    expect(fresh.note).not.toContain(RECALL_STALENESS_NOTE);
  });
});

describe("createMemoryRuntime — 夜移 015: pool cap + once-per-session hits", () => {
  async function seedLines(root: string, lines: string[]): Promise<string> {
    const path = join(root, ".wudao", "memory.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, lines.join("\n") + "\n", "utf8");
    return path;
  }
  const line = (over: Record<string, unknown>): string =>
    JSON.stringify({ kind: "fact", scope: "project", tags: [], created: new Date().toISOString(), hits: 0, status: "active", ...over });

  it("re-injects every run but counts hits once per session (alreadySurfaced adapted to an ephemeral channel)", async () => {
    const path = await seedLines(dir, [line({ id: "m-1", content: "run pnpm eval before merging", tags: ["build"] })]);
    const rt = createMemoryRuntime(dir);
    await rt.refresh();
    // Both runs surface the memory — the MetaNote channel is per-run
    // ephemeral (projection-only), so re-injection is the design.
    expect(rt.recall("how about the build")).toContain("run pnpm eval");
    expect(rt.recall("how about the build")).toContain("run pnpm eval");
    // The telemetry counts ONE session surfacing, not one per run.
    let hits = -1;
    for (let i = 0; i < 200 && hits !== 1; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
      hits = (JSON.parse((await readFile(path, "utf8")).trim()) as { hits: number }).hits;
    }
    expect(hits).toBe(1);
  });

  it("caps the recall pool at the newest 200 entries (真 CC memoryScan MAX_MEMORY_FILES adaptation)", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 6; i += 1) lines.push(line({ id: `old-${i}`, content: `old high-scorer ${i}`, tags: ["build", "merge"] }));
    for (let i = 0; i < 200; i += 1) lines.push(line({ id: `new-${i}`, content: `new regular note ${i}`, tags: ["build"] }));
    await seedLines(dir, lines);
    const rt = createMemoryRuntime(dir);
    await rt.refresh();
    const note = rt.recall("build merge");
    expect(note).toBeDefined();
    // The old group out-scores (2 tag matches vs 1) but sits beyond the
    // newest-200 cap — capped out of the pool, never surfaced.
    expect(note).not.toContain("old high-scorer");
    expect(note).toContain("new regular note");
  });
});

// ---------------------------------------------------------------------------
// Tools + commands
// ---------------------------------------------------------------------------

describe("memory tools + /memory command", () => {
  it("memory_write returns an active receipt; sensitive payloads queue", async () => {
    const store = await openMemoryStore(dir);
    const [writeTool, searchTool] = createMemoryTools({ store });
    expect(writeTool.name).toBe("memory_write");
    expect(searchTool.name).toBe("memory_search");

    const ok = await writeTool.execute({ kind: "fact", content: "run pnpm eval before merging", tags: ["build"] });
    expect(ok.isError).toBeUndefined();
    expect(ok.content).toContain("memory saved");
    expect(ok.content).toContain("(active)");

    const queued = await writeTool.execute({ kind: "fact", content: "the password policy is rotating monthly" });
    expect(queued.content).toContain("queued for review");
    expect(queued.content).toContain("pending");

    const bad = await writeTool.execute({ kind: "nope", content: "x" });
    expect(bad.isError).toBe(true);

    const hit = await searchTool.execute({ query: "eval merging" });
    expect(hit.content).toContain("run pnpm eval");
    const miss = await searchTool.execute({ query: "zzz-nothing" });
    expect(miss.content).toContain("no memories match");
  });

  it("readOnly spelling emits only memory_search", () => {
    const tools = createMemoryTools({ store: null as never, readOnly: true });
    expect(tools.map((t) => t.name)).toEqual(["memory_search"]);
  });

  it("/memory list | del | ok round-trip; surfacePendingReview fires once", async () => {
    const store = await openMemoryStore(dir);
    const a = await store.write(write("run pnpm eval before merging"));
    const p = await store.write(write("user prefers dark theme", { scope: "user" }));

    const list = await runMemoryCommand(dir, "list");
    expect(list).toContain(a.entry.id);
    expect(list).toContain("⏳");

    const surfaced = await surfacePendingReview(dir);
    expect(surfaced).toBeDefined();
    expect(surfaced).toContain(p.entry.id);
    expect(await surfacePendingReview(dir)).toBeUndefined(); // one-time

    expect(await runMemoryCommand(dir, `ok ${p.entry.id}`)).toContain("confirmed");
    expect(await runMemoryCommand(dir, `del ${a.entry.id}`)).toContain("deleted");
    expect(await runMemoryCommand(dir, "del m-nope")).toContain("no memory entry");
    expect(await runMemoryCommand(dir, "bogus")).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#15）
    expect(formatPendingReview([])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ω99-3a — versioned update + audit-driven rollback + forcePending + the
// harness kind (the /refine store extensions). The write/remove/confirm/
// bumpHits semantics exercised above are untouched by this batch.
// ---------------------------------------------------------------------------

describe("ω99-3a — store.update / rollback / forcePending / harness kind", () => {
  it("update bumps version, flips the entry pending, keeps the id; unknown id → undefined", async () => {
    const store = await openMemoryStore(dir);
    const a = await store.write(write("run pnpm eval before merging"));
    expect(a.entry.status).toBe("active");
    const updated = await store.update(a.entry.id, { content: "run pnpm eval and vitest before merging" });
    expect(updated?.id).toBe(a.entry.id);
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("pending"); // LLM 策展不过人审不落 active —— /memory ok 才回 active
    expect(updated?.content).toContain("vitest");
    // One line per id in the file (update replaces, never duplicates).
    const all = await store.load();
    expect(all.filter((e) => e.id === a.entry.id)).toHaveLength(1);
    // The old active version no longer sits in the recall pool.
    expect((await store.active()).find((e) => e.id === a.entry.id)).toBeUndefined();
    expect(await store.update("m-nope", { content: "x" })).toBeUndefined();
  });

  it("update keeps the old tags when none are passed, replaces them when they are", async () => {
    const store = await openMemoryStore(dir);
    const a = await store.write(write("run pnpm eval before merging", { tags: ["build"] }));
    expect((await store.update(a.entry.id, { content: "run pnpm eval and vitest before merging" }))?.tags).toEqual(["build"]);
    expect((await store.update(a.entry.id, { content: "run pnpm eval and vitest before merging", tags: ["build", "testing"] }))?.tags).toEqual(["build", "testing"]);
  });

  it("forcePending lands pending even when the assessment would auto-allow", async () => {
    const store = await openMemoryStore(dir);
    const forced = await store.write(write("run pnpm eval before merging", { forcePending: true }));
    expect(forced.decision).toBe("pending");
    expect(forced.entry.status).toBe("pending");
    // 对照: the same input without the flag still auto-allows (assess untouched).
    const normal = await store.write(write("the router tests live in packages/core/tests"));
    expect(normal.decision).toBe("auto");
    expect(normal.entry.status).toBe("active");
  });

  it("harness kind round-trips and joins the recall pool; version-less legacy lines read as v1", async () => {
    const store = await openMemoryStore(dir);
    const h = await store.write(write("gate plan mode behind a user-visible ask first", { kind: "harness", tags: ["plan-gate"] }));
    expect(h.entry.kind).toBe("harness");
    expect(h.entry.status).toBe("active"); // a normal assessed kind — nothing special at the gate
    expect(h.entry.version).toBe(1);
    const r = recallMemories({ entries: [h.entry], prompt: "when do I enter plan mode? plan gate" });
    expect(r.note).toContain("plan mode");
    // A pre-ω99-3a line (no version field) parses back as v1.
    await mkdir(join(dir, ".wudao"), { recursive: true });
    const legacy = JSON.stringify({
      id: "m-old",
      kind: "preference",
      content: "user prefers terse receipts",
      scope: "user",
      tags: [],
      created: new Date().toISOString(),
      hits: 0,
      status: "active",
    });
    await appendFile(memoryStorePath(dir), `${legacy}\n`, "utf8");
    const reopened = await openMemoryStore(dir);
    expect((await reopened.load()).find((e) => e.id === "m-old")?.version).toBe(1);
  });

  it("rollback reverses a refine's create+update from the audit snapshots (version +1 again, status restored)", async () => {
    const store = await openMemoryStore(dir);
    const seeded = await store.write(write("run focused vitest files, never the full suite during the day", { kind: "skill_note" }));
    expect(seeded.entry.status).toBe("active");
    const proposal: RefineProposal = {
      summary: "tighten the test-selection note",
      rationale: "trajectory shows repeated full-suite runs",
      expectedOutcome: "focused runs by default",
      edits: [
        { action: "create", kind: "harness", content: "after each edit, rerun only the touched test file", tags: ["testing"], evidence: "three turns reran the whole suite" },
        { action: "update", id: seeded.entry.id, kind: "skill_note", content: "run focused vitest files only (full suite is user-gated)", evidence: "user said full runs are night-only" },
      ],
    };
    const { refineId } = await applyRefinement(dir, store, proposal);
    expect(refineId).toMatch(/^rf-[0-9a-f]{8}$/);
    const afterApply = await store.load();
    const created = afterApply.find((e) => e.kind === "harness");
    expect(created?.status).toBe("pending");
    const updated = afterApply.find((e) => e.id === seeded.entry.id);
    expect(updated?.version).toBe(2);
    expect(updated?.status).toBe("pending");
    // Rollback: the update restores before content/status at v3; the create removes its entry.
    expect(await store.rollback(refineId)).toBe(true);
    const rolled = await store.load();
    expect(rolled.find((e) => e.id === created!.id)).toBeUndefined();
    const restored = rolled.find((e) => e.id === seeded.entry.id);
    expect(restored?.content).toBe(seeded.entry.content);
    expect(restored?.version).toBe(3);
    expect(restored?.status).toBe("active");
    expect(await store.rollback("rf-nope")).toBe(false);
  });
});
