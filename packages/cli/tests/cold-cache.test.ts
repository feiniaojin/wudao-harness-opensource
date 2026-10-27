// ω-5a I23 — cold-cache pre-send prediction: the rule table over a fake
// clock, the silent cases, the monitor (latest-checkpoint + one-shot mute +
// reset), the wrapper's per-row noteUsage feed with the injected identity,
// and the driver's startRun notice (exactly one per session, kill-switch
// gated). Pure + scripted — no network, no real model.
import { describe, it, expect } from "vitest";
import type { ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import { createCacheTrackingModel } from "../src/cache.js";
import {
  COLD_CACHE_POLICIES,
  ColdCacheMonitor,
  coldCacheIdentity,
  predictColdCache,
  type ColdCacheCheckpoint,
} from "../src/cold-cache.js";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

const MAX_POLICY = { windowSeconds: 100, windowKind: "maximum" } as const;
const MIN_POLICY = { windowSeconds: 100, windowKind: "minimum" } as const;
const UNKNOWN_POLICY = { windowKind: "unknown" } as const;

const ckpt = (over: Partial<ColdCacheCheckpoint> = {}): ColdCacheCheckpoint => ({
  identity: "id-a",
  promptTokens: 12000,
  at: 1_000_000,
  ...over,
});

describe("predictColdCache (rule table, fake clock)", () => {
  const base = { identityNow: "id-a", historyLength: 5, now: 1_000_000 + 200_000 /* 200s later */ };

  it("no checkpoint → undefined (fresh session; unmeasured resume equally silent)", () => {
    expect(predictColdCache({ ...base, checkpoint: undefined, policy: MAX_POLICY })).toBeUndefined();
    expect(predictColdCache({ ...base, historyLength: 0, checkpoint: undefined, policy: MAX_POLICY })).toBeUndefined();
  });

  it("identity mismatch → identity_changed / expired", () => {
    const p = predictColdCache({ ...base, identityNow: "id-b", checkpoint: ckpt(), policy: UNKNOWN_POLICY });
    expect(p).toEqual({ reason: "identity_changed", confidence: "expired", idleSeconds: 200, reprocessTokens: 12000 });
  });

  it("age past a MAXIMUM window → idle / expired; past a MINIMUM window → idle / may-be-cold", () => {
    expect(predictColdCache({ ...base, checkpoint: ckpt(), policy: MAX_POLICY })).toEqual({
      reason: "idle",
      confidence: "expired",
      idleSeconds: 200,
      reprocessTokens: 12000,
    });
    expect(predictColdCache({ ...base, checkpoint: ckpt(), policy: MIN_POLICY })).toEqual({
      reason: "idle",
      confidence: "may-be-cold",
      idleSeconds: 200,
      reprocessTokens: 12000,
    });
  });

  it("malformed/zero-time checkpoint → age_unknown, NEVER identity_changed (even when identity also differs)", () => {
    const p = predictColdCache({ ...base, identityNow: "id-b", checkpoint: ckpt({ at: 0 }), policy: MAX_POLICY });
    expect(p?.reason).toBe("age_unknown");
    expect(p?.confidence).toBe("may-be-cold");
    expect(p?.reprocessTokens).toBe(12000);
    const nanAt = predictColdCache({ ...base, identityNow: "id-b", checkpoint: ckpt({ at: Number.NaN }), policy: MAX_POLICY });
    expect(nanAt?.reason).toBe("age_unknown");
  });

  it("silent cases: unknown policy, checkpoint within window", () => {
    expect(predictColdCache({ ...base, checkpoint: ckpt(), policy: UNKNOWN_POLICY })).toBeUndefined();
    const within = predictColdCache({
      ...base,
      now: 1_000_000 + 50_000, // 50s < 100s window
      checkpoint: ckpt(),
      policy: MAX_POLICY,
    });
    expect(within).toBeUndefined();
  });

  it("the shipped table is DeepSeek-only and maximum-kind", () => {
    expect(Object.keys(COLD_CACHE_POLICIES)).toEqual(["deepseek"]);
    expect(COLD_CACHE_POLICIES.deepseek?.windowKind).toBe("maximum");
    expect(COLD_CACHE_POLICIES.deepseek?.windowSeconds).toBeGreaterThan(24 * 3600);
  });

  it("coldCacheIdentity hashes baseURL + model + effort (deterministic, discriminates)", () => {
    const a = coldCacheIdentity({ baseURL: "https://api.deepseek.com", model: "deepseek-chat", reasoningEffort: "high" });
    expect(a).toEqual(expect.any(String));
    expect(a).toBe(coldCacheIdentity({ baseURL: "https://api.deepseek.com", model: "deepseek-chat", reasoningEffort: "high" }));
    expect(a).not.toBe(coldCacheIdentity({ baseURL: "https://api.deepseek.com", model: "deepseek-reasoner", reasoningEffort: "high" }));
    expect(a).not.toBe(coldCacheIdentity({ baseURL: "https://other.example", model: "deepseek-chat", reasoningEffort: "high" }));
    expect(a).not.toBe(coldCacheIdentity({ baseURL: "https://api.deepseek.com", model: "deepseek-chat" }));
  });
});

describe("ColdCacheMonitor", () => {
  it("checkpoint holds the LATEST noteUsage; preSend consults it", () => {
    const m = new ColdCacheMonitor(MAX_POLICY);
    m.noteUsage("id-a", 100, 1_000_000);
    m.noteUsage("id-b", 200, 1_100_000);
    // 150s after the SECOND row → the latest checkpoint (identity id-b, 200
    // tokens) is what predicts.
    const p = m.preSend("id-b", 3, 1_100_000 + 150_000);
    expect(p).toEqual({ reason: "idle", confidence: "expired", idleSeconds: 150, reprocessTokens: 200 });
    // The stale identity no longer matches the live one only insofar as the
    // CHECKPOINT says id-b.
    expect(m.preSend("id-a", 3, 1_100_000 + 150_000)?.reason).toBe("identity_changed");
  });

  it("consumeWarning fires once, stays silent until reset", () => {
    const m = new ColdCacheMonitor(MAX_POLICY);
    m.noteUsage("id-a", 100, 1_000_000);
    const p = m.preSend("id-a", 0, 1_000_000 + 150_000);
    expect(p).toBeDefined();
    expect(m.consumeWarning(p)?.reason).toBe("idle");
    expect(m.consumeWarning(p)).toBeUndefined();
    m.reset();
    expect(m.consumeWarning(p)?.reason).toBe("idle");
    expect(m.consumeWarning(undefined)).toBeUndefined();
  });

  it("defaults to the silent unknown policy", () => {
    const m = new ColdCacheMonitor();
    m.noteUsage("id-a", 100, 1_000_000);
    expect(m.preSend("id-a", 5, 1_000_000 + 10 * 365 * 24 * 3600 * 1000)).toBeUndefined();
  });
});

describe("wrapper integration (I23 feed)", () => {
  function fakeModel(usages: readonly ModelUsage[]): ModelClient {
    let i = 0;
    return {
      async generate(input: ModelInput) {
        const usage = usages[i];
        i += 1;
        if (usage) input.onUsage?.(usage);
        return { role: "assistant", content: `a-${i}` };
      },
    };
  }

  it("noteUsage called once per usage row with the injected identity", async () => {
    const rows: Array<[string, number]> = [];
    const tracked = createCacheTrackingModel(fakeModel([
      { promptTokens: 5000, cacheHitTokens: 4900, cacheMissTokens: 100 },
      { promptTokens: 6000, cacheHitTokens: 5800, cacheMissTokens: 200 },
    ]), {
      coldCache: { identity: "fixed-identity", noteUsage: (id, pt) => rows.push([id, pt]) },
    });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "one" }], tools: [] });
    await tracked.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "one" }, { role: "assistant", content: "a-1" }, { role: "user", content: "two" }],
      tools: [],
    });
    expect(rows).toEqual([["fixed-identity", 5000], ["fixed-identity", 6000]]);
  });

  it("a function identity is resolved per row (follows live config switches)", async () => {
    const rows: Array<[string, number]> = [];
    const tracked = createCacheTrackingModel(fakeModel([
      { promptTokens: 5000, cacheHitTokens: 4900, cacheMissTokens: 100 },
    ]), {
      coldCache: { identity: () => "fn-identity", noteUsage: (id, pt) => rows.push([id, pt]) },
    });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "one" }], tools: [] });
    expect(rows).toEqual([["fn-identity", 5000]]);
  });
});

describe("driver startRun notice (I23)", () => {
  const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
  async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    await wait();
    while (!(await cond())) {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
      await wait();
    }
  }
  const fixture = { reason: "idle" as const, confidence: "expired" as const, idleSeconds: 400_000, reprocessTokens: 12000 };

  it("a preSend prediction appends EXACTLY ONE notice on the first submit, none later", async () => {
    const seenLengths: number[] = [];
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok1" }, { role: "assistant", content: "ok2" }]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      coldCache: { preSend: (historyLength) => { seenLengths.push(historyLength); return fixture; } },
    });
    const snowflakes = () => driver.getHistory().filter((h) => h.kind === "notice" && h.text.startsWith("❄️"));
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "first run");
    expect(snowflakes()).toHaveLength(1);
    expect(snowflakes()[0]?.text).toBe("❄️ 缓存可能已冷（idle）——约 12000 token 需重新处理（expired）"); // ω99-166f-iii: 钉随源演进
    driver.submit("again");
    await until(() => driver.getStatus().busy === false, "second run");
    expect(snowflakes()).toHaveLength(1); // the mute
    // The consult saw the pre-push history length both times (0, then the
    // settled history of run 1).
    expect(seenLengths[0]).toBe(0);
    expect(seenLengths[1]).toBeGreaterThan(0);
    driver.dispose();
  });

  it("undefined prediction → no notice", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      coldCache: { preSend: () => undefined },
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run");
    expect(driver.getHistory().some((h) => h.kind === "notice" && h.text.startsWith("❄️"))).toBe(false);
    driver.dispose();
  });

  it("kill switch: WUDAO_NO_COLD_CACHE_WARNING silences the seam", async () => {
    const prev = process.env.WUDAO_NO_COLD_CACHE_WARNING;
    process.env.WUDAO_NO_COLD_CACHE_WARNING = "1";
    try {
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "ok" }]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        coldCache: { preSend: () => fixture },
      });
      driver.submit("go");
      await until(() => driver.getStatus().busy === false, "run");
      expect(driver.getHistory().some((h) => h.kind === "notice" && h.text.startsWith("❄️"))).toBe(false);
      driver.dispose();
    } finally {
      if (prev === undefined) delete process.env.WUDAO_NO_COLD_CACHE_WARNING;
      else process.env.WUDAO_NO_COLD_CACHE_WARNING = prev;
    }
  });
});
