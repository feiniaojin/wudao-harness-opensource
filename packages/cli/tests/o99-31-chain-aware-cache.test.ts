// ω99-31 — chain-aware cache detection (campaign evidence: /tmp/o26-campaign.log
// turn 5 :488 / turn 8 :560 / turn 16 :666 / turn-0 ×5 :395/:443/:599-601).
// The wrapper's observation state used to be ONE chain shared by the main
// conversation and every side chain riding the same wrapper (subagents via
// withChildQuerySource, plus summarizer / loop-reflector / title side calls):
// a side row fed prevSerialized / recentMisses / windowBase and was diffed
// against the main chain. Cross-chain pairs mislabeled steady main rows as
// header breaks (the child's different system line diverges at line 0),
// advanced the window identity off child rows, polluted the eviction
// baseline, and let side rows eat the main chain's one-shot cold
// attributions. querySource IS the chain identity: undefined = main, any
// tag = side. Side rows now record usage + forward onUsage (the cost
// ledger's channel — the ω99-8b red line) and touch NO chain state.
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import { createCacheTrackingModel, type ContextWindowInfo } from "../src/cache.js";

function fakeModel(usages: readonly ModelUsage[]): { model: ModelClient; inputs: ModelInput[] } {
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

const U = (promptTokens: number, hit: number): ModelUsage =>
  ({ promptTokens, cacheHitTokens: hit, cacheMissTokens: promptTokens - hit });

describe("ω99-31 T1 — observe partitions by querySource (cross-chain diff pollution is gone)", () => {
  it("① turn-5 shape: main → child (header-level different system) → main′ (append-only) — ZERO warnings, usage/stats intact", async () => {
    // The campaign's turn 5: a main call sandwiched around a subagent call.
    // The child's system line differs → firstDivergentLine(child, main) is in
    // the header region → the child's ENTRY misreported ⚠️ header, and the
    // main chain's RE-ENTRY (prev evicted by the child's finally) misreported
    // ⚠️ header again — while both sides' usage brackets proved ~0.2k paid.
    const { model, inputs } = fakeModel([
      U(5000, 4900), // main row 1 — miss 100
      U(8100, 3100), // child row — its cold tail, miss 5000 (spike vs [100])
      U(13000, 7000), // main′ row — append-only extension, miss 6000 = the appended delta
    ]);
    const breaks: string[] = [];
    const sources: (string | undefined)[] = [];
    const tracked = createCacheTrackingModel(model, {
      onBreak: (w) => breaks.push(w),
      onUsage: (_u, _s, _w, src) => sources.push(src),
    });
    const main1: AgentMessage[] = [{ role: "user", content: "one" }];
    const child: AgentMessage[] = [{ role: "user", content: "survey the README drift" }];
    // append-only from main1: the appended delta ≈ 10k estimated tokens
    const mainPrime: AgentMessage[] = [
      ...main1,
      { role: "assistant", content: "answer-2" },
      { role: "user", content: "x".repeat(40_000) },
    ];
    await tracked.generate({ systemPrompt: "main-sys", tools: [], messages: main1 });
    await tracked.generate({ systemPrompt: "child-sys", tools: [], messages: child, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "main-sys", tools: [], messages: mainPrime });

    expect(breaks).toHaveLength(0); // RED before: 2 false ⚠️ header reports
    expect(sources).toEqual([undefined, "subagent", undefined]); // the cost ledger's channel is intact
    expect(inputs).toHaveLength(3); // the model saw every call
    expect(tracked.stats.summaryLine()).toContain("3 次模型调用"); // ω99-188: 钉随源演进（census 兜出；usage accounting stays session-wide）
  });

  it("② two interleaved subagents A,B,A′,B′ — zero warnings, every row's onUsage present", async () => {
    // Two children share the wrapper (CHILD_QUERY_SOURCE is one value — no
    // per-child ids); under one-chain state their alternating serializations
    // diffed against EACH OTHER. Chain partition removes the whole class.
    const { model } = fakeModel([
      U(8100, 3100), // A first call (no prev on any reading)
      U(15000, 3000), // B first call — vs A's serialization = cross-chain header diff
      U(25000, 7000), // A′ second call — vs B's serialization = cross-chain header diff
      U(15500, 15200), // B′ steady tail
    ]);
    const breaks: string[] = [];
    const sources: (string | undefined)[] = [];
    const tracked = createCacheTrackingModel(model, {
      onBreak: (w) => breaks.push(w),
      onUsage: (_u, _s, _w, src) => sources.push(src),
    });
    const a1: AgentMessage[] = [{ role: "user", content: "task A" }];
    const b1: AgentMessage[] = [{ role: "user", content: "task B" }];
    const a2: AgentMessage[] = [...a1, { role: "assistant", content: "a1" }, { role: "user", content: "A follow-up" }];
    const b2: AgentMessage[] = [...b1, { role: "assistant", content: "b1" }, { role: "user", content: "B follow-up" }];
    await tracked.generate({ systemPrompt: "a-sys", tools: [], messages: a1, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "b-sys", tools: [], messages: b1, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "a-sys", tools: [], messages: a2, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "b-sys", tools: [], messages: b2, querySource: "subagent" });

    expect(breaks).toHaveLength(0); // RED before: the B-entry and A′-re-entry false header reports
    expect(sources).toEqual(["subagent", "subagent", "subagent", "subagent"]);
    expect(tracked.stats.callCount).toBe(4); // every child row is still accounted
  });

  it("③ coldFirst is consumed by the first MAIN row, never a side row; a parked pendingColdAttribution survives side rows too", async () => {
    // One wrapper receives a side row BEFORE its first main row: the M63 §A
    // cold-turn receipt must land on the first MAIN row (the one that actually
    // rides the switched endpoint's prefix), not be eaten by the child.
    const sideThenMain = fakeModel([U(9000, 8900), U(6000, 5900)]);
    const stamped: (boolean | undefined)[] = [];
    const attributions: (string | undefined)[] = [];
    const first = createCacheTrackingModel(sideThenMain.model, {
      coldFirstTurnAttribution: "provider switched — full history reprocessed",
      onUsage: (u) => {
        stamped.push(u.coldTurnExpected);
        attributions.push(u.cacheBreakAttribution);
      },
    });
    await first.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "child first" }], querySource: "subagent" });
    await first.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "main first" }] });
    expect(stamped).toEqual([undefined, true]); // RED before: the side row ate coldFirst
    expect(attributions).toEqual([undefined, "provider switched — full history reprocessed"]);

    // ω99-24 B pin (already-correct gate, double insurance): a parked bundle
    // attribution survives a side row and stamps the NEXT main row.
    const parked: string[] = ["mission-bundle:mount demo"];
    const sideThenMain2 = fakeModel([U(9000, 8900), U(6000, 5900)]);
    const rows: ModelUsage[] = [];
    const second = createCacheTrackingModel(sideThenMain2.model, {
      pendingColdAttribution: () => parked.pop(),
      onUsage: (u) => rows.push(u),
    });
    await second.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "child" }], querySource: "subagent" });
    await second.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "main" }] });
    expect(rows[0]?.coldTurnExpected).toBeUndefined();
    expect(rows[1]?.cacheBreakAttribution).toBe("mission-bundle:mount demo");
  });
});
describe("ω99-31 T1 — isolation pins (checkpoint / window identity / spike baseline)", () => {
  it("④ coldCache.noteUsage fires exactly once per MAIN row (a side row never feeds the main window's checkpoint)", async () => {
    // ω-5a I23: the checkpoint feeds the MAIN window's residency inference
    // with the construction site's identity. A child's prompt length says
    // nothing about the main window — feeding it made the residency
    // inference read child rows as main-window pressure.
    const { model } = fakeModel([U(5000, 4900), U(9000, 8900), U(6000, 5900), U(7000, 6900)]);
    const feeds: [string, number][] = [];
    const tracked = createCacheTrackingModel(model, {
      coldCache: { identity: "id-x", noteUsage: (id, pt) => feeds.push([id, pt]) },
    });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "m1" }] });
    await tracked.generate({ systemPrompt: "child", tools: [], messages: [{ role: "user", content: "c1" }], querySource: "subagent" });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "m2" }] });
    await tracked.generate({ systemPrompt: "child", tools: [], messages: [{ role: "user", content: "c2" }], querySource: "subagent" });
    expect(feeds).toEqual([["id-x", 5000], ["id-x", 6000]]); // RED before: 4 feeds (child prompts included)
  });

  it("⑤ window identity: a side row never advances; main append-only never advances; a real main rewrite still does", async () => {
    // The campaign's third face: every child row advanced windowBase
    // (firstDivergentLine(windowBase, childSer) > 0 — same frozen system
    // line, different message region) → fake onWindowAdvance events and a
    // fragmented context-window identity in the JSONL.
    const { model } = fakeModel([U(5000, 4900), U(6000, 5800), U(7000, 6800), U(7100, 6900)]);
    const windows: ContextWindowInfo[] = [];
    const advances: { from: string; to: string; divergedAt?: string }[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (_u, _s, w) => windows.push(w),
      onWindowAdvance: (a) => advances.push(a),
    });
    const main1: AgentMessage[] = [{ role: "user", content: "one" }];
    // The child shares the main system line (a frozen parent prompt) and
    // REPLACES the message region — divergence lands at line 1 (> 0), the
    // exact shape that used to fake-advance the window.
    const child: AgentMessage[] = [{ role: "user", content: "child task" }];
    const main2: AgentMessage[] = [...main1, { role: "assistant", content: "a1" }, { role: "user", content: "two" }];
    const rewrite: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "(compacted)" },
      { role: "user", content: "two" },
    ];
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main1 });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: child, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main2 });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: rewrite });

    expect(advances).toHaveLength(1); // RED before: 3 (side row + main2 + rewrite)
    expect(advances[0]?.divergedAt).toBe("message:assistant"); // the REAL main-chain rewrite, named
    expect(windows[0]?.id).toBe(windows[1]?.id); // the side row rides the main window's id — no fragmentation
    expect(windows[1]?.id).toBe(windows[2]?.id); // main append-only growth keeps it
    expect(windows[3]?.id).toBe(advances[0]?.to); // the rewrite rides the new id (existing semantics)
  });

  it("⑥ recentMisses isolation: a 50k side miss neither false-reports eviction nor masks the next real main break", async () => {
    // The eviction lane's rolling baseline belongs to the MAIN chain. A
    // child's cold-start miss used to (a) itself false-report "provider-side
    // eviction" (pure-extension diff vs the main prev) and (b) raise the
    // spike threshold so far that the next REAL main break fell under it.
    const { model } = fakeModel([
      U(5000, 4900), // main1 miss 100
      U(6000, 5900), // main2 miss 100 → baseline [100, 100]
      U(52000, 2000), // side row: pure extension of main2 (frozen prefix + child tail), miss 50000
      U(20000, 8000), // main3: append-only big tail, miss 12000 — delta-explained, must stay silent
      U(15000, 5000), // main4: a REAL rewrite of an early message, miss 10000 (clears the [100,100,12000] mean)
    ]);
    const breaks: string[] = [];
    const tracked = createCacheTrackingModel(model, { onBreak: (w) => breaks.push(w) });
    const main1: AgentMessage[] = [{ role: "user", content: "one" }];
    const main2: AgentMessage[] = [...main1, { role: "assistant", content: "a1" }, { role: "user", content: "two" }];
    const child: AgentMessage[] = [...main2, { role: "user", content: "small child tail" }];
    const main3: AgentMessage[] = [...main2, { role: "assistant", content: "a2" }, { role: "user", content: "y".repeat(40_000) }];
    const main4: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "two EDITED" },
    ];
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main1 });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main2 });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: child, querySource: "subagent" });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main3 });
    await tracked.generate({ systemPrompt: "s", tools: [], messages: main4 });

    // RED before: breaks[0] was the side row's "⚠️ cache miss spike beyond
    // appended delta — provider-side eviction?" and the real main4 break was
    // MASKED (mean [100, 50000, 12000] put 10000 under the spike gate).
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toContain("cache break at user message"); // the real main break, still detected
    expect(breaks.every((b) => !b.includes("eviction"))).toBe(true); // no false eviction off child rows
  });
});

