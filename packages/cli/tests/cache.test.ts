// M24 cache observability + attribution unit tests.
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelInput, ModelUsage } from "@wudao/core";
import { serializePrompt } from "@wudao/providers";
import {
  CACHE_FLOOR_TOKENS,
  CacheStats,
  createCacheTrackingModel,
  detectCacheBreak,
  formatCachePercent,
  formatUsageLine,
} from "../src/cache.js";

describe("formatting", () => {
  it("renders the per-turn info line", () => {
    expect(formatUsageLine({ promptTokens: 48000, cacheHitTokens: 45200, cacheMissTokens: 2800 })).toBe(
      "缓存 94.2%（命中 45.2k / 未命中 2.8k）", // ω99-188: 钉随源演进
    );
  });
  it("M63 §A: a cold-turn receipt names WHY — the provider-switch attribution rides the line", () => {
    expect(
      formatUsageLine({
        promptTokens: 48000,
        cacheHitTokens: 0,
        cacheMissTokens: 48000,
        coldTurnExpected: true,
        cacheBreakAttribution: "provider switched — full history reprocessed",
      }),
    ).toBe("缓存 0.0%（命中 0k / 未命中 48k） [冷：provider switched — full history reprocessed]"); // ω99-188: 钉随源演进（归因值 token 保）
    // An ordinary turn carries no suffix.
    expect(formatUsageLine({ promptTokens: 100, cacheHitTokens: 100, cacheMissTokens: 0 })).not.toContain("[冷"); // ω99-188: 钉随源演进
  });
  it("renders -- for an empty denominator", () => {
    expect(formatCachePercent(10, 0)).toBe("--");
  });

  it("hides cumulative stats under the 1KB noise floor", () => {
    const stats = new CacheStats();
    stats.record({ promptTokens: 900, cacheHitTokens: 0, cacheMissTokens: 900 });
    expect(stats.percent).toBeNull();
    expect(stats.footerLabel).toBeNull();
    stats.record({ promptTokens: 5000, cacheHitTokens: 4000, cacheMissTokens: 1000 });
    expect(stats.percent).not.toBeNull();
    expect(stats.footerLabel).toBe("cache 68%"); // 4000 / 5900
    expect(stats.summaryLine()).toBe("缓存：67.8%（命中 4k / 未命中 1.9k，2 次模型调用）"); // ω99-188: 钉随源演进
  });

  it("summaryLine is null before any usage", () => {
    expect(new CacheStats().summaryLine()).toBeNull();
  });
});

describe("detectCacheBreak (B3)", () => {
  const tools = [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {}, additionalProperties: false } }];
  const serialized = (messages: readonly AgentMessage[]): string =>
    serializePrompt({ systemPrompt: "sys", tools, messages });

  const base: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c1", name: "read_file", content: "A".repeat(200) },
  ];

  it("names the first divergent tool result and its turn on a miss spike", () => {
    // History rewritten: the old tool result got stubbed (compaction-style).
    const rewritten: AgentMessage[] = [
      base[0]!,
      base[1]!,
      { role: "tool", toolCallId: "c1", name: "read_file", content: "[compacted tool_result c1: AAA…]" },
      { role: "user", content: "again" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b" } }] },
      { role: "tool", toolCallId: "c2", name: "read_file", content: "B" },
    ];
    const warning = detectCacheBreak({
      prevSerialized: serialized(base),
      currSerialized: serialized(rewritten),
      currMessages: rewritten,
      missTokens: 12000,
      recentMisses: [500, 400, 600],
    });
    // ω99-28 T2: the report carries its cost tier (no promptTokens on this
    // hand-built input → the honest degraded form, magnitude only).
    expect(warning).toBe("⚠️ cache break at read_file result (turn 0) — miss 12k");
  });

  it("stays silent without a rolling baseline (first calls)", () => {
    const rewritten = [...base, { role: "user", content: "again" }];
    expect(
      detectCacheBreak({
        prevSerialized: serialized(base),
        currSerialized: serialized(rewritten),
        currMessages: rewritten,
        missTokens: 12000,
        recentMisses: [],
      }),
    ).toBeUndefined();
  });

  it("stays silent when the miss is proportional (append-only growth)", () => {
    const grown = [...base, { role: "user", content: "again" }];
    expect(
      detectCacheBreak({
        prevSerialized: serialized(base),
        currSerialized: serialized(grown),
        currMessages: grown,
        missTokens: 1200,
        recentMisses: [500, 600],
      }),
    ).toBeUndefined();
  });

  it("stays silent under the 4k floor even at 2× the mean", () => {
    const grown = [...base, { role: "user", content: "again" }];
    expect(
      detectCacheBreak({
        prevSerialized: serialized(base),
        currSerialized: serialized(grown),
        currMessages: grown,
        missTokens: 3000,
        recentMisses: [1000, 1000],
      }),
    ).toBeUndefined();
  });

  it("reports the header when the divergence is inside the tools section", () => {
    const changedTools = [{ ...tools[0]!, description: "changed description" }];
    const grown = [...base, { role: "user", content: "again" }];
    const warning = detectCacheBreak({
      prevSerialized: serialized(base),
      currSerialized: serializePrompt({ systemPrompt: "sys", tools: changedTools, messages: grown }),
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [500, 500],
    });
    expect(warning).toContain("system/tools header");
  });

  it("stays silent when the prefix is a pure extension AND the miss is delta-sized (夜移 008 split)", () => {
    // 夜移 008: the old blanket silence on pure extensions conflated two
    // cases — a benign big new turn (the appended delta IS the miss) and a
    // provider-side eviction (the PREFIX re-missed). A delta big enough to
    // explain the whole miss stays silent; the eviction case now reports.
    const bigDelta = "x".repeat(24_000); // ≈6k tokens at 4 bytes/token — explains a 6k miss
    const grown = [...base, { role: "user", content: bigDelta }];
    const s1 = serialized(base);
    const s2 = serialized(grown);
    expect(s2.startsWith(s1)).toBe(true);
    expect(
      detectCacheBreak({
        prevSerialized: s1,
        currSerialized: s2,
        currMessages: grown,
        missTokens: 6000,
        recentMisses: [100, 100],
      }),
    ).toBeUndefined();
  });

  it("夜移 008 — pure extension with a miss FAR beyond the delta reports provider-side eviction", () => {
    // Identical prefix, tiny appended delta, miss 12k: the delta cannot
    // explain the miss — the provider re-processed the prefix (eviction/TTL).
    const grown = [...base, { role: "user", content: "again" }];
    const s1 = serialized(base);
    const s2 = serialized(grown);
    expect(s2.startsWith(s1)).toBe(true);
    const warning = detectCacheBreak({
      prevSerialized: s1,
      currSerialized: s2,
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [100, 100],
    });
    expect(warning).toContain("provider-side");
    expect(warning).toContain("eviction");
  });

  it("夜移 008 — a CJK delta stays conservative (serializer escaping keeps the estimate high)", () => {
    // A 5k-char CJK delta serializes to ~30k bytes (\uXXXX) → ~7.5k estimated
    // tokens vs the true ~5k: the residue bias is conservative, so a 5.5k
    // miss is delta-explained → silent (never a false eviction warning).
    const cjkDelta = "汉".repeat(5_000);
    const grown = [...base, { role: "user", content: cjkDelta }];
    const s1 = serialized(base);
    const s2 = serialized(grown);
    expect(
      detectCacheBreak({
        prevSerialized: s1,
        currSerialized: s2,
        currMessages: grown,
        missTokens: 5_500,
        recentMisses: [100, 100],
      }),
    ).toBeUndefined();
  });

  it("夜移 008 — a divergence INSIDE the system line reports the header (was silently swallowed)", () => {
    // line 0 divergence: the old `line <= 0` guard lumped "identical" and
    // "system line changed" together — the single worst prefix killer went
    // unattributed. claude-code forensics: attribute it.
    const grown = [...base, { role: "user", content: "again" }];
    const warning = detectCacheBreak({
      prevSerialized: serializePrompt({ systemPrompt: "sys", tools, messages: base }),
      currSerialized: serializePrompt({ systemPrompt: "sys CHANGED", tools, messages: grown }),
      currMessages: grown,
      missTokens: 12000,
      recentMisses: [500, 500],
    });
    expect(warning).toContain("system");
  });
});

describe("createCacheTrackingModel", () => {
  function fakeModel(
    usages: readonly ModelUsage[],
  ): { model: import("@wudao/core").ModelClient; inputs: ModelInput[] } {
    const inputs: ModelInput[] = [];
    let i = 0;
    return {
      inputs,
      model: {
        async generate(input: ModelInput) {
          inputs.push(input);
          const usage = usages[i];
          i += 1;
          if (usage) input.onUsage?.(usage);
          return { role: "assistant", content: `answer-${i}` };
        },
      },
    };
  }

  it("accumulates stats, forwards onUsage, and attributes a miss spike", async () => {
    const { model, inputs } = fakeModel([
      { promptTokens: 5000, cacheHitTokens: 4900, cacheMissTokens: 100 },
      { promptTokens: 6000, cacheHitTokens: 5800, cacheMissTokens: 200 },
      { promptTokens: 20000, cacheHitTokens: 4000, cacheMissTokens: 16000 },
    ]);
    const breaks: string[] = [];
    const seen: ModelUsage[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (u) => seen.push(u),
      onBreak: (w) => breaks.push(w),
    });

    const messages1: AgentMessage[] = [{ role: "user", content: "one" }];
    const messages2: AgentMessage[] = [...messages1, { role: "assistant", content: "answer-1" }, { role: "user", content: "two" }];
    // Third call REWRITES history (compaction-style stub) → divergent prefix.
    const messages3: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "(compacted)" },
      { role: "user", content: "two" },
    ];
    await tracked.generate({ systemPrompt: "s", messages: messages1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: messages2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: messages3, tools: [] });

    expect(seen).toHaveLength(3); // caller's onUsage still receives every report
    expect(inputs).toHaveLength(3); // underlying model saw every call
    expect(tracked.stats.summaryLine()).toContain("3 次模型调用"); // ω99-188: 钉随源演进（census 兜出：面 #4 的 summaryLine 消费钉）
    // The spike call (16k miss vs ~150 mean) got attributed.
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain("⚠️ cache break at");
    expect(breaks[0]).toContain("(turn 0)");
  });

  it("夜移 008 — pure append-only growth with a miss FAR beyond the delta reports eviction", async () => {
    // The pre-008 blanket silence on pure extensions conflated two cases.
    // This scenario IS the provider-eviction signature: the prefix only grew
    // by ~10 chars, yet hit fell 5800→6000 while miss exploded to 24k — the
    // provider re-processed the prefix (eviction/TTL), and the tracker now
    // says so instead of staying silent.
    const { model } = fakeModel([
      { promptTokens: 5000, cacheHitTokens: 4900, cacheMissTokens: 100 },
      { promptTokens: 6000, cacheHitTokens: 5800, cacheMissTokens: 200 },
      { promptTokens: 30000, cacheHitTokens: 6000, cacheMissTokens: 24000 },
    ]);
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(model, { onBreak: (w) => breaks.push(w) });
    const messages1: AgentMessage[] = [{ role: "user", content: "one" }];
    const messages2: AgentMessage[] = [...messages1, { role: "assistant", content: "a1" }, { role: "user", content: "two" }];
    const messages3: AgentMessage[] = [...messages2, { role: "assistant", content: "a2" }, { role: "user", content: "three" }];
    await tracked.generate({ systemPrompt: "s", messages: messages1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: messages2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: messages3, tools: [] });
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain("provider-side eviction");
  });

  it("respects the 1KB floor in footerLabel", async () => {
    const { model } = fakeModel([{ promptTokens: 900, cacheHitTokens: 0, cacheMissTokens: 900 }]);
    const tracked = createCacheTrackingModel(model);
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [] });
    expect(tracked.stats.footerLabel).toBeNull();
    expect(CACHE_FLOOR_TOKENS).toBe(1024);
  });

  it("forwards usage to the caller's onUsage (the loop's event channel)", async () => {
    const { model } = fakeModel([{ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 }]);
    const tracked = createCacheTrackingModel(model);
    const forwarded: ModelUsage[] = [];
    await tracked.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "x" }],
      tools: [],
      onUsage: (u) => forwarded.push(u),
    });
    expect(forwarded).toEqual([{ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 }]);
  });

  // ω99-8b: onUsage widens with a 4th argument — the row's querySource tag —
  // so client-level COST LEDGERS can partition (skip "subagent" rows; the
  // task tool's forwarder owns those). Observer-neutral by contract: the
  // callback still fires for EVERY call, tagged or not.
  it("ω99-8b — onUsage's 4th argument carries the querySource tag (undefined when untagged)", async () => {
    const row = { promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 };
    const { model } = fakeModel([row, { ...row }, { ...row }]);
    const seen: (string | undefined)[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (_u, _s, _w, src) => seen.push(src),
    });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "y" }], tools: [], querySource: "subagent" });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "z" }], tools: [], querySource: "summarizer" });
    expect(seen).toEqual([undefined, "subagent", "summarizer"]); // fires on every call — tagged included
  });

  it("ω99-8b — onTurnUsage (P0-1 MAIN-only) now EXCLUDES tagged child rows without touching its own check", async () => {
    const { model } = fakeModel([
      { promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 },
      { promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 100 },
    ]);
    const turns: ModelUsage[] = [];
    const tracked = createCacheTrackingModel(model, { onTurnUsage: (u) => turns.push(u) });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "main" }], tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: [{ role: "user", content: "child" }], tools: [], querySource: "subagent" });
    expect(turns).toHaveLength(1); // the stamped child row is a side call — never a MAIN turn
  });
});
