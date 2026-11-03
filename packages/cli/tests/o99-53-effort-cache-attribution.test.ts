// ω99-53 — effort-switch 冷轮归因 + M47 字节纪律 pin（brief §2 #2/#4/#5/#6）。
// 纯矩阵：相邻 CacheWasteTurn 的 effort 不同且真 miss（超噪音底线、provider
// 报缓存、非预期冷）→ cause "effort_changed"（含前后值）；effort 相同或单侧
// 缺席 → 落既有链；coldTurnExpected 优先；model_changed 优先（裁定见报告）；
// 每会话每类一次。serializePrompt 字节 pin：assistant 消息带不带 effort，
// 下一轮 ModelInput 序列化（systemPrompt+messages+tools）逐字节相同。
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "@wudao-org/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import { serializePrompt } from "@wudao-org/providers";
import {
  analyzeCacheWaste,
  asCacheWasteBaseline,
  CacheWasteMonitor,
  formatCacheWasteNotice,
  type CacheWasteBaseline,
  type CacheWasteTurn,
} from "../src/cache-report.js";

const MIN = 60_000;

const turn = (over: Partial<CacheWasteTurn> = {}): CacheWasteTurn => ({
  promptTokens: 50_000,
  cacheHitTokens: 1_000,
  cacheWriteTokens: 49_000,
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

describe("analyzeCacheWaste — effort attribution (ω99-53 #4)", () => {
  it("adjacent turns with different effort and a real miss → cause \"effort_changed\" carrying both values", () => {
    const r = analyzeCacheWaste(base({ effort: "high" }), turn({ effort: "low", at: 1_000_000 + 30_000 }));
    expect(r?.cause).toBe("effort_changed");
    expect(r?.prevEffort).toBe("high");
    expect(r?.currEffort).toBe("low");
    expect(r?.missedTokens).toBe(49_000);
  });

  it("the same effort on both turns stays on the existing chain (never effort_changed)", () => {
    const r = analyzeCacheWaste(base({ effort: "high" }), turn({ effort: "high", at: 1_000_000 + 10 * MIN }));
    expect(r?.cause).toBe("idle");
  });

  it("effort unknown on either side → no effort attribution (partial telemetry must not misfire)", () => {
    expect(analyzeCacheWaste(base({ effort: "high" }), turn({ at: 1_000_000 + 30_000 }))?.cause).toBe("miss");
    expect(analyzeCacheWaste(base(), turn({ effort: "low", at: 1_000_000 + 30_000 }))?.cause).toBe("miss");
  });

  it("coldTurnExpected outranks an effort change — the expected-cold early return stands (ω99-53 #5)", () => {
    expect(analyzeCacheWaste(base({ effort: "high" }), turn({ effort: "low", coldTurnExpected: true }))).toBeNull();
  });

  it("a model switch outranks an effort change (model_changed stays first: across a switch the effort value follows the provider config)", () => {
    const r = analyzeCacheWaste(base({ effort: "high" }), turn({ effort: "low", modelKey: "p/m2" }));
    expect(r?.cause).toBe("model_changed");
  });

  it("asCacheWasteBaseline carries the row's effort for the NEXT comparison", () => {
    expect(asCacheWasteBaseline(turn({ effort: "low" }), true)).toMatchObject({ effort: "low" });
    expect(asCacheWasteBaseline(turn(), true)?.effort).toBeUndefined();
  });
});

describe("CacheWasteMonitor — effort_changed notifies once per session (ω99-53 #6)", () => {
  it("two consecutive effort-switch cold turns report the class exactly once", () => {
    const m = new CacheWasteMonitor();
    expect(m.noteUsage(turn({ cacheHitTokens: 49_000, effort: "high", at: 0 }))).toBeNull(); // warm baseline
    expect(m.noteUsage(turn({ effort: "low", at: MIN }))?.cause).toBe("effort_changed");
    expect(m.noteUsage(turn({ cacheHitTokens: 49_000, effort: "low", at: 2 * MIN }))).toBeNull(); // warm again
    expect(m.noteUsage(turn({ effort: "high", at: 3 * MIN }))?.cause ?? "deduped").toBe("deduped"); // second switch: deduped
  });
});

describe("formatCacheWasteNotice — the effort label names both values (ω99-53 #4)", () => {
  it("carries prev → curr and the re-billed tokens", () => {
    const s = formatCacheWasteNotice({
      missedTokens: 49_000,
      idleMs: MIN,
      modelChanged: false,
      cause: "effort_changed",
      prevEffort: "high",
      currEffort: "low",
    });
    expect(s).toContain("high");
    expect(s).toContain("low");
    expect(s).toContain("49k");
    expect(s).toContain("重新计费");
  });
});

describe("M47 byte discipline — effort never reaches the wire (ω99-53 #2)", () => {
  const scripted: ModelClient = {
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      return { role: "assistant", content: "final answer", stopReason: "stop" };
    },
  };

  async function runOnce(effortSent?: string): Promise<AgentMessage[]> {
    const state = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "q" } as AgentMessage],
      tools: [],
      status: "idle" as const,
    };
    const gen = runAgentLoop(state, scripted, { maxTurns: 3, ...(effortSent !== undefined ? { effortSent } : {}) });
    for (;;) {
      const { done } = await gen.next();
      if (done) break;
    }
    return state.messages;
  }

  it("the next ModelInput serializes byte-identically with and without the effort trail", async () => {
    const withTrail = await runOnce("high");
    const without = await runOnce();
    expect((withTrail.at(-1) as AssistantMessage).effort).toBe("high");
    expect(Object.hasOwn(without.at(-1) as object, "effort")).toBe(false);
    const tools = [{ name: "t", description: "d", parameters: { type: "object" as const, properties: {} } }];
    expect(serializePrompt({ systemPrompt: "sys", messages: withTrail, tools }))
      .toBe(serializePrompt({ systemPrompt: "sys", messages: without, tools }));
  });

  it("pure projection pin: messages differing ONLY in assistant effort serialize identically", () => {
    const msgs = (effort?: string): AgentMessage[] => [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", ...(effort !== undefined ? { effort } : {}) },
      { role: "user", content: "next" },
    ];
    expect(serializePrompt({ systemPrompt: "s", messages: msgs("high"), tools: [] }))
      .toBe(serializePrompt({ systemPrompt: "s", messages: msgs(), tools: [] }));
  });
});

// ω99-53 #1（engine 层）+ #4（走真实 /effort 链）：boot config 携带
// reasoningEffort → JSONL 里 assistant entry 落 "effort" 形状；/effort 切换后
// 下一轮冷 → 一条 effort_changed 通知（含前后值）。
import { afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, type ModelUsage } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession } from "../src/driver/session-engine.js";

const sessions: DriverSession[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.close();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  await wait();
  // 0.4.3 gate fix: AWAIT the condition — `while (!cond())` on an async cond
  // sees a truthy Promise and exits without ever waiting (this describe's
  // async conds raced the persistence instead of polling it; fast machines
  // masked it, gate load exposed it).
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function rowModel(row: { current: ModelUsage }): ModelClient {
  return {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (input.querySource === undefined) input.onUsage?.(row.current);
      return { role: "assistant", content: "ok" };
    },
  };
}

describe("session-engine wiring — the trail lands on the JSONL and attributes a /effort cold turn", () => {
  it("assistant entries carry the turn's effort; a /effort low→high cold turn reports effort_changed exactly once", async () => {
    const row = { current: { promptTokens: 40_000, cacheHitTokens: 39_000, cacheMissTokens: 1_000, cacheWriteTokens: 1_000 } as ModelUsage };
    const ws = mkdtempSync(join(tmpdir(), "o99-53-engine-"));
    roots.push(ws);
    const config: ProviderConfig = {
      apiKey: "test-key",
      baseURL: "http://127.0.0.1:1/v1",
      model: "fake-model-x",
      reasoningEffort: "low",
    };
    const session = await createDriverSession({
      config,
      workspaceRoot: ws,
      contextWindowTokens: 64_000,
      modelOverride: rowModel(row),
      tools: [],
      sessionId: "o99-53-engine-a",
    });
    sessions.push(session);
    const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));

    // Run 1: warm baseline at effort "low".
    session.driver.submit("first");
    await until(() => session.driver.getStatus().busy === false, "run 1");
    // 0.4.3 gate fix: poll-then-assert on the SAME load (the old shape polled
    // "some assistant" then re-read for the assertion — the second read could
    // hit a transient state and lose the race ~1-in-N under load; the
    // snapshot form asserts exactly what the passing poll saw).
    let first: Awaited<ReturnType<typeof store.loadSessionEntries>> = [];
    await until(async () => {
      first = (await store.loadSessionEntries("o99-53-engine-a")).filter((e) => e.role === "assistant");
      return first.length > 0;
    }, "run 1 persisted");
    expect(first.at(-1)).toMatchObject({ role: "assistant", effort: "low" });

    // /effort high → the next turn runs (and is attributed) at "high".
    session.driver.submit("/effort high");
    await wait();
    row.current = { promptTokens: 42_000, cacheHitTokens: 1_000, cacheMissTokens: 41_000, cacheWriteTokens: 41_000 } as ModelUsage;
    session.driver.submit("second");
    await until(() => session.driver.getStatus().busy === false, "run 2");
    let assistants: Awaited<ReturnType<typeof store.loadSessionEntries>> = [];
    await until(
      async () => {
        assistants = (await store.loadSessionEntries("o99-53-engine-a")).filter((e) => e.role === "assistant");
        return assistants.length >= 2;
      },
      "run 2 persisted",
    );
    expect(assistants.at(-1)).toMatchObject({ role: "assistant", effort: "high" });

    const notices = session.driver.getHistory().filter((h) => h.kind === "notice" && h.text.includes("前缀缓存"));
    expect(notices.length).toBe(1);
    expect(notices[0]?.text).toContain("low");
    expect(notices[0]?.text).toContain("high");

    // Run 3: warm again at "high" — the class was already reported.
    row.current = { promptTokens: 44_000, cacheHitTokens: 43_000, cacheMissTokens: 1_000, cacheWriteTokens: 1_000 } as ModelUsage;
    session.driver.submit("third");
    await until(() => session.driver.getStatus().busy === false, "run 3");
    expect(session.driver.getHistory().filter((h) => h.kind === "notice" && h.text.includes("前缀缓存"))).toHaveLength(1);
  });
});
