// P0-1 (永续迭代) — per-turn prefix-cache WASTE attribution (the upstream projectcache-stats
// port). Pure matrix over a fake clock: idle>TTL loss / idle<TTL no-loss
// (plain miss) / model-switch loss / noise floor / no-cache-report providers
// / coldTurnExpected resets; the monitor's per-cause dedup; the wrapper's
// onTurnUsage side-call filter; and the session-engine wiring (fake usage
// flow → the driver history notice fires / stays silent). No network, no
// real model.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createCacheTrackingModel } from "../src/cache.js";
import {
  CACHE_TTL_MS,
  CACHE_WASTE_NOISE_FLOOR_TOKENS,
  CacheWasteMonitor,
  analyzeCacheWaste,
  asCacheWasteBaseline,
  formatCacheWasteNotice,
  formatWasteTokens,
  type CacheWasteBaseline,
  type CacheWasteTurn,
} from "../src/cache-report.js";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const MIN = 60_000;

const turn = (over: Partial<CacheWasteTurn> = {}): CacheWasteTurn => ({
  promptTokens: 50_000,
  cacheHitTokens: 49_000,
  modelKey: "p/m",
  at: 1_000_000,
  ...over,
});

const base = (over: Partial<CacheWasteBaseline> = {}): CacheWasteBaseline => ({
  promptTokens: 50_000,
  modelKey: "p/m",
  at: 1_000_000,
  reportedCache: true,
  ...over,
});

describe("analyzeCacheWaste (pure matrix, the upstream project detectMiss semantics)", () => {
  it("no previous baseline (first turn / post-reset) → null", () => {
    expect(analyzeCacheWaste(undefined, turn())).toBeNull();
  });

  it("a healthy append-only turn (the hit covers the previous prompt) is NOT waste", () => {
    // prev prompt 50k; curr prompt 52k = 50k prefix (fully read from cache) + 2k delta.
    expect(analyzeCacheWaste(base(), turn({ promptTokens: 52_000, cacheHitTokens: 50_000, at: 1_000_000 + 60_000 }))).toBeNull();
  });

  it("idle beyond the TTL with a cold prefix → cause \"idle\"", () => {
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 1_000, at: 1_000_000 + 10 * MIN }));
    expect(r).not.toBeNull();
    expect(r?.missedTokens).toBe(49_000);
    expect(r?.idleMs).toBe(10 * MIN);
    expect(r?.modelChanged).toBe(false);
    expect(r?.cause).toBe("idle");
  });

  it("idle below the TTL with a real miss → plain \"miss\" (no idle attribution)", () => {
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 30_000, at: 1_000_000 + MIN }));
    expect(r?.missedTokens).toBe(20_000);
    expect(r?.cause).toBe("miss");
  });

  it("model switch takes attribution precedence over idle (the upstream project label order)", () => {
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 1_000, modelKey: "p/m2", at: 1_000_000 + 10 * MIN }));
    expect(r?.cause).toBe("model_changed");
    expect(r?.modelChanged).toBe(true);
  });

  it("missed tokens at/below the 1024 noise floor → null; 1025 counts", () => {
    expect(analyzeCacheWaste(base(), turn({ cacheHitTokens: 50_000 - CACHE_WASTE_NOISE_FLOOR_TOKENS, at: 1_000_000 + 10 * MIN }))).toBeNull();
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 50_000 - CACHE_WASTE_NOISE_FLOOR_TOKENS - 1, at: 1_000_000 + 10 * MIN }));
    expect(r?.missedTokens).toBe(CACHE_WASTE_NOISE_FLOOR_TOKENS + 1);
  });

  it("a provider that never reports cache splits is silent (every turn would otherwise read as a total miss)", () => {
    expect(analyzeCacheWaste(base({ reportedCache: false }), turn({ cacheHitTokens: 0, at: 1_000_000 + 10 * MIN }))).toBeNull();
  });

  it("a cache-capable provider's total miss (its own row reports the write) counts", () => {
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 0, cacheWriteTokens: 50_000, at: 1_000_000 + 30_000 }));
    expect(r?.missedTokens).toBe(50_000);
    expect(r?.cause).toBe("miss");
  });

  it("a coldTurnExpected row (compaction / provider-switch rewrite) is never waste — receipted elsewhere", () => {
    expect(analyzeCacheWaste(base(), turn({ cacheHitTokens: 0, coldTurnExpected: true, at: 1_000_000 + 10 * MIN }))).toBeNull();
  });

  it("a shrinking prompt compares against min(prev, curr) (branch-cut semantics)", () => {
    const r = analyzeCacheWaste(base(), turn({ promptTokens: 30_000, cacheHitTokens: 28_000, at: 1_000_000 + 30_000 }));
    expect(r?.missedTokens).toBe(2_000);
  });

  it("clock skew (curr observed before prev) clamps idle to 0 → plain miss, never idle", () => {
    const r = analyzeCacheWaste(base(), turn({ cacheHitTokens: 10_000, at: 1_000_000 - 5_000 }));
    expect(r?.idleMs).toBe(0);
    expect(r?.cause).toBe("miss");
  });

  it("a zero-prompt row is never waste", () => {
    expect(analyzeCacheWaste(base(), turn({ promptTokens: 0 }))).toBeNull();
  });

  it("the idle TTL is injectable (a provider's documented window beats the 5min default)", () => {
    expect(analyzeCacheWaste(base(), turn({ cacheHitTokens: 0, at: 1_000_000 + 6 * MIN }), 10 * MIN)?.cause).toBe("miss");
    expect(analyzeCacheWaste(base(), turn({ cacheHitTokens: 0, at: 1_000_000 + 11 * MIN }), 10 * MIN)?.cause).toBe("idle");
  });

  it("shipped constants match the the upstream project port (5min TTL, 1024 floor)", () => {
    expect(CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(CACHE_WASTE_NOISE_FLOOR_TOKENS).toBe(1024);
  });
});

describe("asCacheWasteBaseline", () => {
  it("folds the sticky reportedCache flag; a zero-prompt row yields null (keep the old baseline)", () => {
    const b = asCacheWasteBaseline(turn({ cacheHitTokens: 0, cacheWriteTokens: 1_000 }), false);
    expect(b?.reportedCache).toBe(true);
    expect(asCacheWasteBaseline(turn({ promptTokens: 0 }), true)).toBeNull();
    expect(asCacheWasteBaseline(turn({ cacheHitTokens: 0 }), false)?.reportedCache).toBe(false);
  });
});

describe("CacheWasteMonitor (per-cause dedup, baseline always advances)", () => {
  const t = (promptTokens: number, hit: number, modelKey: string, atMin: number): CacheWasteTurn =>
    turn({ promptTokens, cacheHitTokens: hit, modelKey, at: atMin * MIN, ...(hit < promptTokens ? { cacheWriteTokens: promptTokens - hit } : {}) });

  it("same cause fires once per session; a different cause still fires; the model-switch class only fires on the switch row", () => {
    const m = new CacheWasteMonitor();
    expect(m.noteUsage(t(40_000, 39_000, "A", 0))).toBeNull(); // first row — baseline only
    expect(m.noteUsage(t(40_000, 5_000, "A", 10))?.cause).toBe("idle");
    expect(m.noteUsage(t(40_000, 6_000, "A", 20))?.cause ?? "deduped").toBe("deduped"); // idle dedup
    expect(m.noteUsage(t(40_000, 5_000, "B", 21))?.cause).toBe("model_changed");
    expect(m.noteUsage(t(40_000, 5_000, "C", 22))?.cause ?? "deduped").toBe("deduped"); // a LATER switch is the same class
    expect(m.noteUsage(t(40_000, 30_000, "C", 23))?.cause).toBe("miss"); // a different class still fires
    expect(m.noteUsage(t(40_000, 29_000, "C", 24))?.cause ?? "deduped").toBe("deduped");
  });

  it("the baseline keeps advancing through deduped rows (idle measured from the LAST row)", () => {
    const m = new CacheWasteMonitor();
    m.noteUsage(t(40_000, 39_000, "A", 0));
    m.noteUsage(t(40_000, 5_000, "A", 10)); // idle report (consumed)
    // Row at t=70m is 60m after the LAST row — not after the reported one.
    expect(m.noteUsage(t(40_000, 39_500, "A", 70))?.cause ?? "deduped").toBe("deduped");
  });

  it("a zero-prompt row never clobbers the baseline", () => {
    const m = new CacheWasteMonitor();
    m.noteUsage(t(40_000, 39_000, "A", 0));
    m.noteUsage(turn({ promptTokens: 0, modelKey: "A", at: 5 * MIN }));
    // Without the guard this would compare against the 0-token row and read 0 waste.
    expect(m.noteUsage(t(40_000, 5_000, "A", 10))?.missedTokens).toBe(35_000);
  });

  it("a fully warm session never reports", () => {
    const m = new CacheWasteMonitor();
    expect(m.noteUsage(t(40_000, 39_000, "A", 0))).toBeNull();
    expect(m.noteUsage(t(42_000, 41_000, "A", 30))).toBeNull();
    expect(m.noteUsage(t(44_000, 43_000, "A", 60))).toBeNull();
  });
});

describe("formatCacheWasteNotice (user-facing, Chinese)", () => {
  it("idle: names the idle span and the re-billed tokens", () => {
    const s = formatCacheWasteNotice({ missedTokens: 49_000, idleMs: 10 * MIN, modelChanged: false, cause: "idle" });
    expect(s).toContain("10 分钟");
    expect(s).toContain("49k");
    expect(s).toContain("重新计费");
  });

  it("model switch / plain miss labels", () => {
    expect(formatCacheWasteNotice({ missedTokens: 39_000, idleMs: MIN, modelChanged: true, cause: "model_changed" })).toContain("模型切换");
    expect(formatCacheWasteNotice({ missedTokens: 20_000, idleMs: 0, modelChanged: false, cause: "miss" })).toContain("原因未明");
  });

  it("idle spans format up through hours and days", () => {
    expect(formatCacheWasteNotice({ missedTokens: 10_000, idleMs: 90 * MIN, modelChanged: false, cause: "idle" })).toContain("1.5 小时");
    expect(formatCacheWasteNotice({ missedTokens: 10_000, idleMs: 3 * 24 * 60 * MIN, modelChanged: false, cause: "idle" })).toContain("3.0 天");
  });

  it("token formatter tiers (raw / k / M)", () => {
    expect(formatWasteTokens(512)).toBe("512");
    expect(formatWasteTokens(39_000)).toBe("39k");
    expect(formatWasteTokens(1_500_000)).toBe("1.50M");
  });
});

describe("wrapper onTurnUsage (side-call filter)", () => {
  function fakeModel(): ModelClient {
    return {
      async generate(input: ModelInput) {
        input.onUsage?.({ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 });
        return { role: "assistant", content: "ok" };
      },
    };
  }

  it("fires only for MAIN calls (querySource-tagged side calls are excluded); onUsage still sees every row", async () => {
    const main: ModelUsage[] = [];
    const all: ModelUsage[] = [];
    const tracked = createCacheTrackingModel(fakeModel(), {
      onUsage: (u) => all.push(u),
      onTurnUsage: (u) => main.push(u),
    });
    const input = { systemPrompt: "s", messages: [{ role: "user", content: "q" }] as const, tools: [] };
    await tracked.generate({ ...input, messages: [...input.messages] });
    await tracked.generate({ ...input, messages: [...input.messages], querySource: "title" });
    await tracked.generate({ ...input, messages: [...input.messages, { role: "assistant", content: "ok" }] });
    expect(all).toHaveLength(3);
    expect(main).toHaveLength(2);
  });
});

describe("session-engine wiring (P0-1: fake usage flow → driver history notice)", () => {
  const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };
  const sessions: DriverSession[] = [];
  const roots: string[] = [];
  afterEach(async () => {
    for (const s of sessions.splice(0)) await s.close();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const wait = (ms = 10) => new Promise((res) => setTimeout(res, ms));
  async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    await wait();
    while (!(await cond())) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await wait();
    }
  }

  /** A scripted model that reports the CURRENT usage row on main calls only
   *  (side calls — the auto-title — are filtered by the wrapper anyway). */
  function rowModel(row: { current: ModelUsage }): ModelClient {
    return {
      async generate(input: ModelInput) {
        if (input.querySource === undefined) input.onUsage?.(row.current);
        return { role: "assistant", content: "ok" };
      },
    };
  }

  const wasteNotices = (s: DriverSession) => s.driver.getHistory().filter((h) => h.kind === "notice" && h.text.includes("前缀缓存"));

  it("a model-switch waste turn lands EXACTLY ONE notice; warm turns land none; duplicates are muted", async () => {
    const row = { current: { promptTokens: 40_000, cacheHitTokens: 38_000, cacheMissTokens: 2_000, cacheWriteTokens: 2_000 } as ModelUsage };
    const ws = mkdtempSync(join(tmpdir(), "p0-waste-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: rowModel(row),
      tools: [],
      sessionId: "p0-waste-a",
    });
    sessions.push(session);

    // Run 1: warm baseline (hit covers the prefix).
    session.driver.submit("first");
    await until(() => session.driver.getStatus().busy === false, "run 1");
    expect(wasteNotices(session)).toHaveLength(0);

    // Run 2: the answering model changed and the prefix was re-billed.
    row.current = { promptTokens: 42_000, cacheHitTokens: 1_000, cacheMissTokens: 41_000, cacheWriteTokens: 41_000, model: "other-model" };
    session.driver.submit("second");
    await until(() => session.driver.getStatus().busy === false, "run 2");
    const notices = wasteNotices(session);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain("模型切换");
    expect(notices[0]?.text).toContain("39k");

    // Run 3: warm again on the new model — and the class was already reported.
    row.current = { promptTokens: 44_000, cacheHitTokens: 43_000, cacheMissTokens: 1_000, cacheWriteTokens: 1_000, model: "other-model" };
    session.driver.submit("third");
    await until(() => session.driver.getStatus().busy === false, "run 3");
    expect(wasteNotices(session)).toHaveLength(1);
  });

  it("a fully warm session never notifies", async () => {
    const row = { current: { promptTokens: 40_000, cacheHitTokens: 39_000, cacheMissTokens: 1_000, cacheWriteTokens: 1_000 } as ModelUsage };
    const ws = mkdtempSync(join(tmpdir(), "p0-warm-"));
    roots.push(ws);
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: rowModel(row),
      tools: [],
      sessionId: "p0-warm-b",
    });
    sessions.push(session);
    session.driver.submit("one");
    await until(() => session.driver.getStatus().busy === false, "run 1");
    session.driver.submit("two");
    await until(() => session.driver.getStatus().busy === false, "run 2");
    expect(wasteNotices(session)).toHaveLength(0);
  });
});
