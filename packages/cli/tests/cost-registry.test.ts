// M56 §3 — the cost stack core (a reference harness cost_status, pragmatic subset).
// A per-session ledger of per-call rows {model, provider, usage, price
// lookup}; prices come from WUDAO_PRICE_<MODEL> ("in,out,cacheRead,cacheWrite
// per-M-USD"). The completeness rule is the point: UNPRICED ≠ FREE — a turn
// on a model without a price entry is recorded with cost null and counted as
// unpriced (missing spend), never absorbed into a $0.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelUsage } from "@wudao/core";
import {
  priceEnvName,
  parsePriceEntry,
  parsePriceTable,
  usageCostUsd,
  CostRegistry,
  formatCostReport,
  resolveRunCachePricing,
} from "../src/commands/cost.js";
import { costLedgerPath, readCostLedger } from "../src/commands/wallet.js";

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  promptTokens: 1000,
  cacheHitTokens: 700,
  cacheMissTokens: 300,
  completionTokens: 9,
  cacheWriteTokens: 300,
  ...over,
});

describe("price table (env WUDAO_PRICE_<MODEL>)", () => {
  it("model id → env var name (uppercased, non-alphanumerics folded to _)", () => {
    expect(priceEnvName("deepseek-v4-flash")).toBe("WUDAO_PRICE_DEEPSEEK_V4_FLASH");
    expect(priceEnvName("glm-4.6")).toBe("WUDAO_PRICE_GLM_4_6");
  });

  it("parses the in,out,cacheRead,cacheWrite per-M-USD format", () => {
    expect(parsePriceEntry("0.27,1.10,0.07,0.27")).toEqual({
      inputPerM: 0.27,
      outputPerM: 1.1,
      cacheReadPerM: 0.07,
      cacheWritePerM: 0.27,
    });
  });

  it("junk is unpriced, never guessed (fail-closed on malformed lines)", () => {
    expect(parsePriceEntry("0.27,1.10")).toBeUndefined(); // too few
    expect(parsePriceEntry("a,b,c,d")).toBeUndefined();
    expect(parsePriceEntry("")).toBeUndefined();
    expect(parsePriceEntry("1,2,3,-4")).toBeUndefined(); // negative rate
  });

  it("parsePriceTable maps the env's priced models (folded spelling)", () => {
    const table = parsePriceTable({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
    expect(table.get("deepseek_v4_flash")?.outputPerM).toBe(4);
    // A model id with different separators resolves through the same fold.
    expect(parsePriceEntry("1,1,1,1") && table.has("deepseek-v4-flash")).toBe(false);
  });
});

describe("usageCostUsd — disjoint billing classes", () => {
  it("miss/write/hit/completion each bill at their own rate (no double count)", () => {
    const price = parsePriceEntry("2,4,0.2,2")!;
    // hit 700 @0.2 + write 300 @2 + completion 9 @4 (miss fully explained by
    // the write: input-billed = miss - write = 0) = 140+600+36 = 776 per M.
    expect(usageCostUsd(usage(), price)).toBeCloseTo(776 / 1e6, 12);
  });

  it("an omitted cacheWrite falls back to input-rate billing of the miss", () => {
    const price = parsePriceEntry("2,4,0.2,2")!;
    const u = usage({ cacheWriteTokens: undefined });
    // miss 300 @2 (input) + hit 700 @0.2 + 9 @4 = 600+140+36 = 776 — same
    // total here because write==input rates; the classes stay disjoint.
    expect(usageCostUsd(u, price)).toBeCloseTo(776 / 1e6, 12);
  });
});

describe("CostRegistry — unpriced ≠ free", () => {
  it("a turn on an unpriced model is recorded, cost null, counted unpriced", () => {
    const reg = new CostRegistry({});
    reg.record({ model: "mystery-model", usage: usage() });
    const s = reg.summary();
    expect(s).toEqual({ calls: 1, pricedTurns: 0, unpricedTurns: 1, costUsd: null, unpricedModels: ["mystery-model"] });
    expect(reg.rows).toHaveLength(1);
    expect(reg.rows[0]?.costUsd).toBeNull();
  });

  it("a priced turn accumulates dollars", () => {
    const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
    reg.record({ model: "deepseek-v4-flash", provider: "deepseek", usage: usage() });
    const s = reg.summary();
    expect(s.pricedTurns).toBe(1);
    expect(s.unpricedTurns).toBe(0);
    expect(s.costUsd).toBeCloseTo(776 / 1e6, 12);
    expect(s.unpricedModels).toEqual([]);
  });

  it("mixed sessions: priced dollars + unpriced counted (never absorbed into $0)", () => {
    const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
    reg.record({ model: "deepseek-v4-flash", usage: usage() });
    reg.record({ model: "glm-4.6", usage: usage() });
    const s = reg.summary();
    expect(s.calls).toBe(2);
    expect(s.pricedTurns).toBe(1);
    expect(s.unpricedTurns).toBe(1);
    expect(s.costUsd).toBeCloseTo(776 / 1e6, 12);
    expect(s.unpricedModels).toEqual(["glm-4.6"]);
  });

  it("scope isolation: two registries never share rows", () => {
    const a = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
    const b = new CostRegistry({});
    a.record({ model: "deepseek-v4-flash", usage: usage() });
    expect(b.summary().calls).toBe(0);
    expect(b.rows).toHaveLength(0);
  });
});

describe("/cost $ rendering", () => {
  const totals = {
    promptTokens: 1000, completionTokens: 9, cacheHitTokens: 700, cacheMissTokens: 300, calls: 1,
  };

  it("gains a $ line when the session's turns are priced", () => {
    const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
    reg.record({ model: "deepseek-v4-flash", usage: usage() });
    const text = formatCostReport(totals, { startedAt: 0, now: () => 5000, cost: reg.summary() });
    expect(text).toContain("$0.000776");
    expect(text).not.toContain("未计价"); // ω99-187: 钉随源演进
  });

  it("shows the unpriced-model note (unpriced ≠ free) when turns could not be priced", () => {
    const reg = new CostRegistry({});
    reg.record({ model: "glm-4.6", usage: usage() });
    const text = formatCostReport(totals, { startedAt: 0, now: () => 5000, cost: reg.summary() });
    expect(text).toContain("未计价"); // ω99-187: 钉随源演进
    expect(text).toContain("glm-4.6");
    expect(text).toContain("WUDAO_PRICE");
  });

  it("without a cost summary the legacy token-only report is unchanged", () => {
    const text = formatCostReport(totals, { startedAt: 0, now: () => 5000 });
    expect(text).not.toContain("$");
    expect(text).toContain("模型调用：1"); // ω99-187: 钉随源演进
  });
});

// P0-4 (96 队列) — flushToLedger: the session's rows land in the cross-session
// wallet ledger (.wudao/costs.jsonl) at the sessionEnd boundary. Priced and
// unpriced rows never share a line; the flush is idempotent (sessionEnd can
// fire repeatedly: clear / resume / exit); an empty registry writes nothing.
describe("CostRegistry.flushToLedger — the cross-session wallet", () => {
  const NOW = () => new Date("2026-08-30T00:00:00.000Z");

  async function tmpWs(): Promise<string> {
    return mkdtemp(join(tmpdir(), "p04-flush-"));
  }

  it("writes one row per (model, provider, priced-ness) with summed tokens and costs", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
      reg.record({ model: "deepseek-v4-flash", provider: "deepseek", usage: usage() });
      reg.record({ model: "deepseek-v4-flash", provider: "deepseek", usage: usage() });
      reg.record({ model: "glm-4.6", provider: "glm", usage: usage() });
      const written = reg.flushToLedger(ws, "sess-1", NOW);
      expect(written).toBe(2); // deepseek priced + glm unpriced
      const rows = readCostLedger(ws);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toEqual({
        ts: "2026-08-30T00:00:00.000Z",
        sessionId: "sess-1",
        model: "deepseek-v4-flash",
        provider: "deepseek",
        calls: 2,
        promptTokens: 2000,
        completionTokens: 18,
        cacheHitTokens: 1400,
        cacheMissTokens: 600,
        costUsd: (776 / 1e6) * 2,
      });
      expect(rows[1]?.costUsd).toBeNull();
      expect(rows[1]?.calls).toBe(1);
      expect(rows[1]?.model).toBe("glm-4.6");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("same model priced + unpriced → TWO rows (the split is per-row, defensive)", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({});
      // Through `record` a model is deterministically priced or not (the
      // price table is frozen at construction), so the mixed case is forced
      // white-box: flushToLedger must still split, never blend.
      const ledger = (reg as unknown as { ledger: { model: string; usage: ModelUsage; costUsd: number | null }[] }).ledger;
      ledger.push(
        { model: "m", usage: usage(), costUsd: 1 },
        { model: "m", usage: usage(), costUsd: null },
      );
      const written = reg.flushToLedger(ws, "sess-2", NOW);
      expect(written).toBe(2);
      const rows = readCostLedger(ws);
      expect(rows.map((r) => [r.model, r.costUsd, r.calls])).toEqual([
        ["m", 1, 1],
        ["m", null, 1],
      ]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("empty ledger → 0 rows and NO file created", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({});
      expect(reg.flushToLedger(ws, "sess-3", NOW)).toBe(0);
      expect(existsSync(costLedgerPath(ws))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("idempotent: the second flush writes 0 (sessionEndHook can fire repeatedly)", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
      reg.record({ model: "deepseek-v4-flash", usage: usage() });
      expect(reg.flushToLedger(ws, "sess-4", NOW)).toBe(1);
      expect(reg.flushToLedger(ws, "sess-4", NOW)).toBe(0);
      const text = await readFile(costLedgerPath(ws), "utf8");
      expect(text.split("\n").filter((l) => l !== "")).toHaveLength(1);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("rows without a provider omit the field (optional column, not \"\")", async () => {
    const ws = await tmpWs();
    try {
      const reg = new CostRegistry({});
      reg.record({ model: "mystery", usage: usage() });
      expect(reg.flushToLedger(ws, "sess-5", NOW)).toBe(1);
      const raw = JSON.parse((await readFile(costLedgerPath(ws), "utf8")).trim()) as Record<string, unknown>;
      expect("provider" in raw).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// 借鉴弧 B1（a reference project C1）— 压缩经济学定价解析：catalog pin > WUDAO_PRICE env
// > 保守缺省，来源类型化（不暴露为用户配置）。
// ---------------------------------------------------------------------------
describe("resolveRunCachePricing (B1 compaction economics)", () => {
  it("env 行推导：in,out,cacheRead,cacheWrite 的同形消费", () => {
    const p = resolveRunCachePricing({ model: "deepseek-v4-flash", env: { WUDAO_PRICE_DEEPSEEK_V4_FLASH: "0.28,1.1,0.028,0.28" } });
    expect(p.ratioSource).toBe("env");
    expect(p.cacheWriteReadRatio).toBeCloseTo(10, 5);
  });

  it("catalog pin 优先于 env", () => {
    const profiles = new Map([
      ["deepseek", { models: [{ name: "deepseek-v4-flash", prices: { inputPerM: 0.5, cacheReadPerM: 0.1 } }] }],
    ]);
    const p = resolveRunCachePricing({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      env: { WUDAO_PRICE_DEEPSEEK_V4_FLASH: "0.28,1.1,0.028,0.28" },
      profiles,
    });
    expect(p.ratioSource).toBe("catalog");
    expect(p.cacheWriteReadRatio).toBeCloseTo(5, 5);
  });

  it("无价目 → 保守缺省（default 来源类型化）", () => {
    const p = resolveRunCachePricing({ model: "mystery-model", env: {} });
    expect(p.ratioSource).toBe("default");
    expect(p.cacheWriteReadRatio).toBe(10);
  });

  it("无模型名 → 缺省（空 id 推不出比值）", () => {
    expect(resolveRunCachePricing({ model: "", env: {} }).ratioSource).toBe("default");
    expect(resolveRunCachePricing({ env: {} }).ratioSource).toBe("default");
  });
});
