// ω-5a I19 — context-window identity through the cache tracking wrapper:
// ONE id per wrapper process, advance on structural prefix change (never on
// append-only growth), the firstCall receipt join (the M24 attribution
// seam), the session-engine-shaped JSONL entry write, and the
// projection-channel reservation (the id NEVER rides a ModelInput).
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput, ModelUsage } from "@wudao-org/core";
import { createCacheTrackingModel, type ContextWindowInfo, type WindowAdvance } from "../src/cache.js";
import { appendSessionEntry, buildContextWindowEntry, CONTEXT_WINDOW_TYPE } from "../src/session-entry.js";
import type { GenericSessionEntry } from "@wudao-org/core";

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

const U = (promptTokens: number, hit: number, extra: Partial<ModelUsage> = {}): ModelUsage =>
  ({ promptTokens, cacheHitTokens: hit, cacheMissTokens: promptTokens - hit, ...extra });

const settle = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)); };

describe("context_window_id through createCacheTrackingModel (I19)", () => {
  it("three append-only requests → ONE id across every onUsage, no advance", async () => {
    const { model } = fakeModel([U(5000, 4900), U(6000, 5800), U(7000, 6800)]);
    const windows: ContextWindowInfo[] = [];
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (_u, _s, w) => windows.push(w),
      onWindowAdvance: (a) => advances.push(a),
    });
    const m1: AgentMessage[] = [{ role: "user", content: "one" }];
    const m2: AgentMessage[] = [...m1, { role: "assistant", content: "answer-1" }, { role: "user", content: "two" }];
    const m3: AgentMessage[] = [...m2, { role: "assistant", content: "answer-2" }, { role: "user", content: "three" }];
    await tracked.generate({ systemPrompt: "s", messages: m1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m3, tools: [] });
    expect(windows).toHaveLength(3);
    const [w1, w2, w3] = windows;
    expect(w1?.id).toBe(w2?.id);
    expect(w2?.id).toBe(w3?.id);
    expect(w1?.id).toEqual(expect.any(String));
    expect(windows.map((w) => w.call)).toEqual([1, 2, 3]);
    expect(advances).toEqual([]);
  });

  it("a compaction-shaped rewrite advances: from ≠ to, divergedAt names the role, then stable", async () => {
    const { model } = fakeModel([U(5000, 4900), U(6000, 5800), U(20000, 4000), U(21000, 19000)]);
    const windows: ContextWindowInfo[] = [];
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (_u, _s, w) => windows.push(w),
      onWindowAdvance: (a) => advances.push(a),
    });
    const m1: AgentMessage[] = [{ role: "user", content: "one" }];
    const m2: AgentMessage[] = [...m1, { role: "assistant", content: "answer-1" }, { role: "user", content: "two" }];
    // Compaction-shaped: an EARLY message differs (the summary replaced it).
    const m3: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "(compacted)" },
      { role: "user", content: "two" },
    ];
    const m4: AgentMessage[] = [...m3, { role: "assistant", content: "answer-4" }, { role: "user", content: "four" }];
    await tracked.generate({ systemPrompt: "s", messages: m1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m3, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m4, tools: [] });
    expect(advances).toHaveLength(1);
    const adv = advances[0]!;
    expect(adv.from).toBe(windows[0]?.id);
    expect(adv.to).not.toBe(adv.from);
    expect(adv.atCall).toBe(3);
    expect(adv.divergedAt).toBe("message:assistant");
    // The rows from the divergent call on ride the NEW id and stay on it.
    expect(windows[2]?.id).toBe(adv.to);
    expect(windows[3]?.id).toBe(adv.to);
    expect(advances).toHaveLength(1); // append-only growth after the rewrite never re-advances
  });

  it("firstCall carries the divergent row, including an upstream coldTurnExpected stamp", async () => {
    const { model } = fakeModel([
      U(5000, 4900),
      U(6000, 5800),
      U(20000, 4000, { coldTurnExpected: true, cacheBreakAttribution: "threshold" }),
    ]);
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, { onWindowAdvance: (a) => advances.push(a) });
    const m1: AgentMessage[] = [{ role: "user", content: "one" }];
    const m2: AgentMessage[] = [...m1, { role: "assistant", content: "answer-1" }, { role: "user", content: "two" }];
    const m3: AgentMessage[] = [
      { role: "user", content: "DIFFERENT EARLY BYTES" },
      { role: "assistant", content: "answer-1" },
      { role: "user", content: "two" },
    ];
    await tracked.generate({ systemPrompt: "s", messages: m1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m3, tools: [] });
    expect(advances).toHaveLength(1);
    expect(advances[0]?.firstCall).toEqual({
      promptTokens: 20000,
      cacheHitTokens: 4000,
      coldTurnExpected: true,
      cacheBreakAttribution: "threshold",
    });
  });

  it("the session-engine-shaped callback writes exactly one entry per advance, deep-equal pinned", async () => {
    const { model } = fakeModel([U(5000, 4900), U(6000, 5800), U(20000, 4000), U(7000, 6800), U(30000, 9000, { coldTurnExpected: true })]);
    const entries: GenericSessionEntry[] = [];
    const fakeStore = {
      appendEntry: async (_sid: string, e: GenericSessionEntry): Promise<void> => { entries.push(e); },
    };
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, {
      // The exact session-engine shape: fire-and-forget appendSessionEntry
      // of buildContextWindowEntry per advance (onWindowAdvance → JSONL).
      onWindowAdvance: (w) => {
        advances.push(w);
        void appendSessionEntry(fakeStore, "sess", buildContextWindowEntry({
          id: w.to,
          advancedFrom: w.from,
          divergedAt: w.divergedAt,
          ...(w.firstCall !== undefined ? { firstCall: w.firstCall } : {}),
        }));
      },
    });
    const m1: AgentMessage[] = [{ role: "user", content: "one" }];
    const m2: AgentMessage[] = [...m1, { role: "assistant", content: "a1" }, { role: "user", content: "two" }];
    const rewriteA: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "(compacted-A)" },
      { role: "user", content: "two" },
    ];
    const m4: AgentMessage[] = [...rewriteA, { role: "assistant", content: "a4" }, { role: "user", content: "four" }];
    const rewriteB: AgentMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "(compacted-B)" },
      { role: "user", content: "two" },
    ];
    await tracked.generate({ systemPrompt: "s", messages: m1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: rewriteA, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m4, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: rewriteB, tools: [] });
    await settle();
    expect(advances).toHaveLength(2);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      type: CONTEXT_WINDOW_TYPE,
      data: {
        id: advances[0]!.to,
        advancedFrom: advances[0]!.from,
        divergedAt: "message:assistant",
        at: expect.any(String),
        firstCall: { promptTokens: 20000, cacheHitTokens: 4000 },
      },
    });
    expect(entries[1]).toEqual({
      type: CONTEXT_WINDOW_TYPE,
      data: {
        id: advances[1]!.to,
        advancedFrom: advances[1]!.from,
        divergedAt: "message:assistant",
        at: expect.any(String),
        firstCall: { promptTokens: 30000, cacheHitTokens: 9000, coldTurnExpected: true },
      },
    });
  });

  it("reservation: the window id appears nowhere in any ModelInput the model received", async () => {
    const { model, inputs } = fakeModel([U(5000, 4900), U(6000, 5800), U(20000, 4000)]);
    const windows: ContextWindowInfo[] = [];
    const advances: WindowAdvance[] = [];
    const tracked = createCacheTrackingModel(model, {
      onUsage: (_u, _s, w) => windows.push(w),
      onWindowAdvance: (a) => advances.push(a),
    });
    const m1: AgentMessage[] = [{ role: "user", content: "one" }];
    const m2: AgentMessage[] = [...m1, { role: "assistant", content: "a1" }, { role: "user", content: "two" }];
    const rewrite: AgentMessage[] = [
      { role: "user", content: "CHANGED" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "two" },
    ];
    await tracked.generate({ systemPrompt: "s", messages: m1, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: m2, tools: [] });
    await tracked.generate({ systemPrompt: "s", messages: rewrite, tools: [] });
    expect(inputs).toHaveLength(3);
    const ids = new Set<string>([...windows.map((w) => w.id), ...advances.flatMap((a) => [a.from, a.to])]);
    expect(ids.size).toBeGreaterThanOrEqual(2);
    for (const input of inputs) {
      const json = JSON.stringify(input);
      for (const id of ids) expect(json.includes(id)).toBe(false);
    }
  });
});

describe("provider-switch synthetic advance (review I1 fix round)", () => {
  it("a wrapper built as a REPLACEMENT (mintedFrom) fires ONE synthetic advance on its first observed row", async () => {
    // The pre-switch wrapper: one observed row, silent mint (no advance).
    const a = createCacheTrackingModel(fakeModel([U(5000, 4900)]).model, {});
    await a.generate({ systemPrompt: "s", messages: [{ role: "user", content: "one" }], tools: [] });
    const predecessor = a.currentWindowId();
    expect(predecessor).toEqual(expect.any(String));

    // The session-engine build() shape: the replacement carries the old id.
    const { model: modelB } = fakeModel([U(6000, 5800), U(6500, 6300)]);
    const advances: WindowAdvance[] = [];
    const b = createCacheTrackingModel(modelB, {
      onWindowAdvance: (w) => advances.push(w),
      mintedFrom: predecessor,
    });
    await b.generate({ systemPrompt: "s2", messages: [{ role: "user", content: "x" }], tools: [] });
    expect(advances).toHaveLength(1);
    expect(advances[0]).toStrictEqual({
      from: predecessor,
      to: b.currentWindowId(),
      atCall: 1,
      firstCall: { promptTokens: 6000, cacheHitTokens: 5800 },
    });
    expect(advances[0]!.to).not.toBe(predecessor);
    // Exactly once: the second row fires nothing.
    await b.generate({
      systemPrompt: "s2",
      messages: [{ role: "user", content: "x" }, { role: "assistant", content: "a1" }, { role: "user", content: "y" }],
      tools: [],
    });
    expect(advances).toHaveLength(1);
  });

  it("the switch lands exactly ONE context_window entry with advancedFrom and no divergedAt", async () => {
    const entries: GenericSessionEntry[] = [];
    const fakeStore = {
      appendEntry: async (_sid: string, e: GenericSessionEntry): Promise<void> => { entries.push(e); },
    };
    const a = createCacheTrackingModel(fakeModel([U(5000, 4900)]).model, {});
    await a.generate({ systemPrompt: "s", messages: [{ role: "user", content: "one" }], tools: [] });
    const predecessor = a.currentWindowId();

    const advances: WindowAdvance[] = [];
    const b = createCacheTrackingModel(fakeModel([U(7000, 100)]).model, {
      onWindowAdvance: (w) => {
        advances.push(w);
        void appendSessionEntry(fakeStore, "sess", buildContextWindowEntry({
          id: w.to,
          advancedFrom: w.from,
          ...(w.divergedAt !== undefined ? { divergedAt: w.divergedAt } : {}),
          ...(w.firstCall !== undefined ? { firstCall: w.firstCall } : {}),
        }));
      },
      mintedFrom: predecessor,
    });
    await b.generate({ systemPrompt: "s2", messages: [{ role: "user", content: "x" }], tools: [] });
    await settle();
    expect(advances).toHaveLength(1);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      type: CONTEXT_WINDOW_TYPE,
      data: {
        id: advances[0]!.to,
        advancedFrom: predecessor,
        at: expect.any(String),
        firstCall: { promptTokens: 7000, cacheHitTokens: 100 },
      },
    });
    // A synthetic advance has no divergent line — the key is absent.
    expect("divergedAt" in (entries[0]!.data as Record<string, unknown>)).toBe(false);
  });
});
