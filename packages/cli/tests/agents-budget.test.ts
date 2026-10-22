// M31 §2 — adaptive fan-out budget: per-role sample persistence in
// .wudao/agents-stats.json (50-sample cap, corrupt-tolerant) and the
// anti-ratchet suggestion (median of uncensored successes, 1.25×max
// ceiling, <3 successes → default, WUDAO_AGENT_BUDGETS=off kill switch).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestBudget,
  loadAgentStats,
  recordAgentSample,
  parseAgentStats,
  budgetsDisabled,
  defaultStatsPath,
  AGENT_STATS_KEEP,
} from "../src/agents/budget.js";

let dir: string;
let statsPath: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "budget-")); statsPath = join(dir, "agents-stats.json"); });
afterEach(async () => { await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const ok = (turns: number) => ({ turns, ok: true, budgetLimited: false });
const censored = (turns: number) => ({ turns, ok: true, budgetLimited: true });
const failed = (turns: number) => ({ turns, ok: false, budgetLimited: false });

describe("suggestBudget (anti-ratchet)", () => {
  it("uses the median of successful uncensored samples", () => {
    const r = suggestBudget([ok(10), ok(20), ok(30)], 20);
    expect(r.suggested).toBe(20);
    expect(r.defaulted).toBe(false);
    expect(r.successSamples).toBe(3);
    expect(r.median).toBe(20);
    expect(r.max).toBe(30);
  });

  it("even sample counts take the mean of the middle pair (rounded)", () => {
    expect(suggestBudget([ok(10), ok(20), ok(30), ok(40)], 20).suggested).toBe(25);
  });

  it("budget-limited successes are censored — zero force on the estimate", () => {
    const r = suggestBudget([ok(10), ok(20), ok(30), censored(999)], 20);
    expect(r.suggested).toBe(20);
    expect(r.successSamples).toBe(3); // the 999-turn sample never counted
    expect(r.max).toBe(30);
  });

  it("failures never count either", () => {
    const r = suggestBudget([ok(10), ok(20), ok(30), failed(500)], 20);
    expect(r.suggested).toBe(20);
  });

  it("the ceiling is 1.25 × the observed success max (returned in the basis)", () => {
    const r = suggestBudget([ok(4), ok(8), ok(40)], 20);
    expect(r.suggested).toBe(8); // median
    expect(r.ceiling).toBe(50); // floor(1.25 × 40) — raises can never top this
  });

  it("fewer than 3 success samples → the default (role maxTurns ?? 20)", () => {
    for (const samples of [[], [ok(7)], [ok(7), ok(9)], [censored(5), censored(6), censored(7)], [ok(1), failed(2), ok(3)]]) {
      const r = suggestBudget(samples, 20);
      expect(r.defaulted).toBe(true);
      expect(r.suggested).toBe(20);
    }
    expect(suggestBudget([], 7).suggested).toBe(7); // a role-pinned maxTurns default
  });

  it("suggestions stay ≥ 1 and integral", () => {
    const r = suggestBudget([ok(1), ok(1), ok(1)], 20);
    expect(r.suggested).toBe(1);
  });
});

describe("stats persistence (.wudao/agents-stats.json)", () => {
  it("records per-role samples and loads them back", async () => {
    await recordAgentSample(statsPath, "coder", ok(3));
    await recordAgentSample(statsPath, "coder", { turns: 5, ok: true, budgetLimited: true, tokens: 1200 });
    await recordAgentSample(statsPath, "scout", ok(2));
    const stats = await loadAgentStats(statsPath);
    expect(stats.roles.coder?.length).toBe(2);
    expect(stats.roles.coder?.[1]).toEqual({ turns: 5, ok: true, budgetLimited: true, tokens: 1200 });
    expect(stats.roles.scout).toEqual([ok(2)]);
  });

  it("keeps only the most recent 50 samples per role", async () => {
    for (let i = 0; i < AGENT_STATS_KEEP + 7; i += 1) await recordAgentSample(statsPath, "coder", ok(i));
    const stats = await loadAgentStats(statsPath);
    expect(stats.roles.coder?.length).toBe(AGENT_STATS_KEEP);
    expect(stats.roles.coder?.[0]).toEqual(ok(7)); // oldest dropped
    expect(stats.roles.coder?.at(-1)).toEqual(ok(AGENT_STATS_KEEP + 6));
  });

  it("a missing file loads empty; a corrupt file resets empty (warn-not-crash)", async () => {
    expect((await loadAgentStats(join(dir, "nope.json"))).roles).toEqual({});
    await writeFile(statsPath, "{corrupt", "utf8");
    expect((await loadAgentStats(statsPath)).roles).toEqual({});
    // and the corrupt file is replaced by the next record, not poisoned
    await recordAgentSample(statsPath, "coder", ok(1));
    expect((await loadAgentStats(statsPath)).roles.coder?.length).toBe(1);
  });

  it("creates the .wudao directory on demand and defaults the path under it", async () => {
    const nested = join(dir, "ws");
    const p = defaultStatsPath(nested);
    expect(p).toBe(join(nested, ".wudao", "agents-stats.json"));
    await mkdir(nested, { recursive: true });
    await recordAgentSample(p, "coder", ok(4));
    expect(JSON.parse(await readFile(p, "utf8")).roles.coder.length).toBe(1);
  });

  it("parseAgentStats tolerates junk and keeps the version", () => {
    expect(parseAgentStats(undefined).roles).toEqual({});
    expect(parseAgentStats("not json").roles).toEqual({});
    expect(parseAgentStats('{"roles":{"a":[{"turns":2,"ok":true,"budgetLimited":false}]}}').roles.a?.length).toBe(1);
    // malformed samples are dropped, not fatal (a role left with none disappears)
    const stats = parseAgentStats('{"roles":{"a":[{"turns":"x","ok":true},{"ok":true,"budgetLimited":false}]}}');
    expect(stats.roles.a).toBeUndefined();
    expect(parseAgentStats('{"roles":{"a":[{"turns":"x","ok":true},{"turns":3,"ok":true,"budgetLimited":false}]}}').roles.a?.length).toBe(1);
  });
});

describe("WUDAO_AGENT_BUDGETS=off", () => {
  it("disables the feature for the exact value 'off'", () => {
    expect(budgetsDisabled({ WUDAO_AGENT_BUDGETS: "off" })).toBe(true);
    expect(budgetsDisabled({ WUDAO_AGENT_BUDGETS: "OFF" })).toBe(false); // exact match only
    expect(budgetsDisabled({ WUDAO_AGENT_BUDGETS: "on" })).toBe(false);
    expect(budgetsDisabled({})).toBe(false);
  });
});
