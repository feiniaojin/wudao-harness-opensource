// ω-2b (I1) — the context-overflow ladder's loop half: calibration + window
// learning + the graded reactive ladder (clip → compact → hard error) + the
// proactive admission clip on shared-window profiles. Design §2.I1(c)/(d),
// acceptance (i)-(iv) plus the §5 single-calibration interplay:
//   (i)  a usage row calibrates the occupancy (ratio 1.25) and the threshold
//        crossing flips accordingly; a model switch / out-of-clamp row does
//        not;
//   (ii) a trusted observed overflow with room to spare recovers via ONE
//        clip-retry — NO compacted event, messages byte-identical, retry
//        carried maxTokens, context_recovery{kind:"clip"};
//   (iii) the same with a prompt that leaves no usable budget compacts once
//        (compacted{trigger:"reactive"}, context_recovery{kind:"compacted"});
//   (iv) no compaction configured → ContextOverflowHardError unchanged;
//   (v)  the shared-window admission clip caps the request's maxTokens when
//        occupancy crossed the threshold (and stays off for unknown modes).
import { describe, it, expect } from "vitest";
import { runAgentLoop, isContextLengthError, CLEARED_MARKER, SUMMARY_MARKER } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage } from "../src/index.js";
import type { Tool } from "../src/index.js";
import { drainSettled } from "./helpers/drain.js";

/** A duck-typed ContextLengthError with the ω-2b trusted-parse observation. */
const contextLengthError = (observed?: { promptTokens: number; windowTokens: number }, status = 400): Error =>
  Object.assign(new Error(`provider context length exceeded: ${status} too big`), {
    name: "ContextLengthError",
    status,
    ...(observed !== undefined ? { observed } : {}),
  });

type ScriptStep =
  | { readonly kind: "error"; readonly err: Error }
  | { readonly kind: "ok"; readonly content: string; readonly usage?: ModelUsage; readonly model?: string }
  | { readonly kind: "toolcall"; readonly id: string; readonly usage?: ModelUsage; readonly model?: string };

function scriptedModel(
  steps: readonly ScriptStep[],
  modelId?: string,
): ModelClient & { calls: number; inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  const client: ModelClient & { calls: number; inputs: ModelInput[] } = {
    modelId,
    get calls() {
      return calls;
    },
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      if (step.kind === "error") throw step.err;
      if (step.usage !== undefined) {
        input.onUsage?.({ ...step.usage, ...(step.model !== undefined ? { model: step.model } : {}) });
      }
      if (step.kind === "toolcall") {
        return { role: "assistant", content: "", toolCalls: [{ id: step.id, name: "echo", arguments: { text: step.id } }] };
      }
      return { role: "assistant", content: step.content };
    },
  };
  return client;
}

const state = (messages: AgentMessage[], tools: readonly Tool[] = []): AgentState => ({
  systemPrompt: "s",
  messages,
  tools,
  status: "idle",
});

const ECHO: Tool = {
  name: "echo",
  description: "trivial",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => ({ content: String((args as { text?: string }).text ?? "") }),
};

async function drain(gen: AsyncGenerator<LoopEvent, unknown>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
}

const bigText = (chars: number): string => "x".repeat(chars);

// ---------------------------------------------------------------------------
// (i) calibration off real usage rows
// ---------------------------------------------------------------------------

describe("ω-2b (i) — usage-row calibration drives the occupancy", () => {
  // 64_000 chars ≈ 16_000 tokens estimate; threshold at W=21_000 is 16_800.
  // Uncalibrated (16_000) stays under; a 20_000-token usage row (ratio 1.25)
  // lifts occupancy to 20_000 → the boundary compaction fires. Both turns
  // carry tool calls: a text turn would end the run before the boundary
  // compaction executes.
  const CAL_MESSAGES = (): AgentMessage[] => [
    { role: "user", content: bigText(32_000) },
    { role: "assistant", content: bigText(31_990) },
    { role: "user", content: "go" },
  ];

  const runCal = async (usage: ModelUsage, modelTag?: string): Promise<LoopEvent[]> => {
    const model = scriptedModel(
      [
        { kind: "toolcall", id: "c1", usage, ...(modelTag !== undefined ? { model: modelTag } : {}) },
        { kind: "toolcall", id: "c2" },
        { kind: "ok", content: "SUMMARY" },
        { kind: "ok", content: "done" },
      ],
      "m1",
    );
    return drain(
      runAgentLoop(state(CAL_MESSAGES(), [ECHO]), model, {
        maxTurns: 5,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 21_000, keepRecent: 1 },
      }),
    );
  };

  it("a usage row whose ratio crosses the threshold triggers the boundary compact", async () => {
    const events = await runCal({ promptTokens: 20_000, cacheHitTokens: 0, cacheMissTokens: 20_000, completionTokens: 1 });
    expect(events.find((e) => e.type === "compacted")).toBeDefined();
  });

  it("without calibration (ratio 1) the same transcript stays under the threshold", async () => {
    const events = await runCal({ promptTokens: 16_000, cacheHitTokens: 0, cacheMissTokens: 16_000, completionTokens: 1 });
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
  });

  it("a usage row from a DIFFERENT model (guard (a) shape) never calibrates", async () => {
    const events = await runCal({ promptTokens: 20_000, cacheHitTokens: 0, cacheMissTokens: 20_000, completionTokens: 1 }, "m-other");
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
  });

  // The ratio's protected surface is the anchor-less moment AFTER a
  // compaction (guard (b) drops the anchor; §5 says the ratio survives — it
  // describes the tokenizer, not the transcript). 9 messages ≈ 17.4k-token
  // estimate, keepRecent 6 → the compact replaces only the small 3-message
  // head, so the post-compact estimate stays ~16.5k tokens: under the 16.8k
  // threshold uncalibrated, OVER it with a surviving in-clamp ratio.
  const SURVIVE_MESSAGES = (): AgentMessage[] => [
    { role: "user", content: bigText(2_000) },
    { role: "assistant", content: bigText(2_000) },
    { role: "user", content: "0123456789" },
    { role: "assistant", content: bigText(16_400) },
    { role: "user", content: bigText(16_400) },
    { role: "assistant", content: bigText(16_400) },
    { role: "user", content: bigText(16_400) },
    { role: "assistant", content: bigText(16_400) },
    { role: "user", content: "go" },
  ];

  const runSurvive = async (promptTokens: number): Promise<LoopEvent[]> => {
    const model = scriptedModel(
      [
        { kind: "toolcall", id: "c1", usage: { promptTokens, cacheHitTokens: 0, cacheMissTokens: promptTokens, completionTokens: 1 } },
        { kind: "toolcall", id: "c2" },
        { kind: "toolcall", id: "c3" },
        { kind: "ok", content: "S1" },
        { kind: "ok", content: "done" },
      ],
      "m1",
    );
    return drain(
      runAgentLoop(state(SURVIVE_MESSAGES(), [ECHO]), model, {
        maxTurns: 6,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 21_000, keepRecent: 6 },
      }),
    );
  };

  it("§5: an in-clamp ratio SURVIVES the compaction (post-compact occupancy stays calibrated)", async () => {
    // ratio = 34_808 / 17_404 ≈ 2.0 (in clamp): the first compact fires
    // immediately on the anchor, and the surviving ratio re-crosses the
    // threshold on the post-compact estimate → a SECOND compaction.
    const events = await runSurvive(34_808);
    expect(events.filter((e) => e.type === "compacted").length).toBe(2);
  });

  it("the clamp [0.5, 2.5] ignores a poisoned ratio (no post-compact re-crossing)", async () => {
    // ratio = 87_020 / 17_404 ≈ 5.0 (OUT of clamp): the first compact still
    // fires (the anchor is ground truth), but no calibrated occupancy remains
    // afterward → exactly one compaction.
    const events = await runSurvive(87_020);
    expect(events.filter((e) => e.type === "compacted").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (ii)/(iii)/(iv) — the graded reactive ladder
// ---------------------------------------------------------------------------

const LADDER_MESSAGES: AgentMessage[] = [
  { role: "user", content: "task one " + bigText(400) },
  { role: "assistant", content: "answer one " + bigText(400) },
  { role: "user", content: "go" },
];

describe("ω-2b (ii) — trusted observed overflow with room recovers via the clip-retry", () => {
  it("no compacted event, messages byte-identical, retry carried the exact maxTokens", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      { kind: "ok", content: "shorter answer" },
    ]);
    const st = state([...LADDER_MESSAGES]);
    const before = JSON.parse(JSON.stringify(st.messages)) as AgentMessage[];
    const events = await drain(
      runAgentLoop(st, model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000 },
      }),
    );
    // NO compaction — the prefix was never rewritten.
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(st.messages.slice(0, before.length)).toEqual(before);
    // Exactly two calls; the retry is the identical input + the physical cap:
    // 64_000 − 40_000 − 8_192 = 15_808.
    expect(model.calls).toBe(2);
    expect(model.inputs[0]?.maxTokens).toBeUndefined();
    expect(model.inputs[1]?.maxTokens).toBe(64_000 - 40_000 - 8_192);
    expect(model.inputs[1]?.messages).toEqual(model.inputs[0]?.messages);
    expect(model.inputs[1]?.systemPrompt).toBe(model.inputs[0]?.systemPrompt);
    // The recovery event names the clip and the cap.
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") {
      expect(recovery.kind).toBe("clip");
      expect(recovery.maxTokens).toBe(64_000 - 40_000 - 8_192);
    }
  });

  it("a failed clip-retry (still overflowing) falls through to the reactive compact", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
      { kind: "error", err: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) }, // clip retry fails
      { kind: "ok", content: "SUMMARY" }, // the tier-2 summary call
      { kind: "ok", content: "recovered" }, // the compact retry
    ]);
    const events = await drain(
      runAgentLoop(state([...LADDER_MESSAGES]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, keepRecent: 1, zeroLlmDigest: false }, // #38: consume the scripted SUMMARY
      }),
    );
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type === "compacted") {
      expect(compacted.trigger).toBe("reactive");
      expect(compacted.reason).toBe("overflow");
    }
    const recovery = events.find((e) => e.type === "context_recovery");
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("compacted");
    expect(model.calls).toBe(4);
  });
});

describe("ω-2b (iii) — an observed prompt with no usable budget compacts once", () => {
  it("physical < 1024 → compacted{trigger:reactive} and the retry succeeds", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 63_000, windowTokens: 64_000 }) },
      { kind: "ok", content: "SUMMARY" },
      { kind: "ok", content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state([...LADDER_MESSAGES]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, keepRecent: 1, zeroLlmDigest: false }, // #38: consume the scripted SUMMARY
      }),
    );
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type === "compacted") expect(compacted.trigger).toBe("reactive");
    const recovery = events.find((e) => e.type === "context_recovery");
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("compacted");
    expect(model.calls).toBe(3);
  });

  it("the learned window SHRINKS the effective window (min of config and observed)", async () => {
    // Config says 64_000; the endpoint says 9_000. A 4_000-token prompt
    // against a 9_000 window leaves no clip budget → compact fires even
    // though the config window would have allowed one.
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 4_000, windowTokens: 9_000 }) },
      { kind: "ok", content: "SUMMARY" },
      { kind: "ok", content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state([...LADDER_MESSAGES]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, keepRecent: 1 },
      }),
    );
    // physical = min(9_000, 64_000) − 4_000 − 8_192 < 0 → the compact corner.
    expect(events.find((e) => e.type === "compacted")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 87 item 1 — honest recovery kind when the reactive compact freed NOTHING
// ---------------------------------------------------------------------------

describe("87 item 1 — a no-op reactive compact recovered by the bare resend is kind:'retried'", () => {
  // Single-message history: nothing is compactable (tier-0/1 need old tool
  // results; tier-2 needs a span before keepRecent; dual needs a window of
  // ≥2) — doCompact("reactive") returns ZERO events and history is untouched.
  // If the identical resend then succeeds (the 400 was transient), the
  // recovery event must not claim compaction it did not perform.
  it("no compacted event, byte-identical resend, recovery kind 'retried' (not 'compacted')", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 800, windowTokens: 9_000 }) },
      { kind: "ok", content: "done" },
    ]);
    const st = state([{ role: "user", content: "go" }]);
    const events = await drain(
      runAgentLoop(st, model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 9_000 },
      }),
    );
    // The compact arm ran but nothing was compactable — zero compaction.
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    // Two calls: the original + the byte-identical resend (no summary call).
    expect(model.calls).toBe(2);
    expect(model.inputs[1]?.messages).toEqual(model.inputs[0]?.messages);
    expect(model.inputs[1]?.maxTokens).toBeUndefined();
    expect(st.messages.slice(0, 1)).toEqual([{ role: "user", content: "go" }]);
    // The honest classification: the recovery was a bare retry, not a compact.
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("retried");
  });

  // The honest compaction case stays "compacted" (guard against the fix
  // over-correcting): when tier-2 DID rewrite history, the label names it.
  it("a real reactive compaction recovered by the retry keeps kind:'compacted'", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 8_000, windowTokens: 9_000 }) },
      { kind: "ok", content: "SUMMARY" },
      { kind: "ok", content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state([...LADDER_MESSAGES]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 9_000, keepRecent: 1 },
      }),
    );
    expect(events.find((e) => e.type === "compacted")).toBeDefined();
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("compacted");
  });
});

// ---------------------------------------------------------------------------
// 89 item 2 — the tier-0 clear corner: history moved with NO compacted event
// ---------------------------------------------------------------------------

describe("89 item 2 — a reactive compact that only CLEARED recovers with kind:'cleared'", () => {
  // "retried" promises a byte-identical bare resend — but doCompact("reactive")
  // can mutate state.messages WITHOUT emitting a compacted event: the tier-0
  // clear replaces an old huge tool result with the cleared marker (cleared>0)
  // yet the post-clear occupancy still exceeds the threshold (no tier-0 event),
  // microcompact finds nothing further (no tier-1 event), and BOTH summary
  // tiers bail before doing anything (no tier-2 event). The resend then rides
  // the cleared — NOT byte-identical — prefix, so neither "compacted" (no
  // compaction event fired) nor "retried" (bytes moved) is honest. The corner
  // is REACHABLE, not hypothetical: this test drives it end to end.
  it("cleared>0 with no compacted event → the recovery kind is 'cleared', not 'retried'", async () => {
    const model = scriptedModel([
      // physical = min(64_000, learned 4_000) − 8_000 − 8_192 < 0 → skips the
      // clip tier straight into the reactive compact; the learned window's
      // threshold (3_200) is what the post-clear occupancy must stay OVER.
      { kind: "error", err: contextLengthError({ promptTokens: 8_000, windowTokens: 4_000 }) },
      { kind: "ok", content: "done" }, // the resend recovers (the 400 was "transient")
    ]);
    // The corner's ingredients (len 10, keepRecent 6 → cutoff = stubFloor = 4):
    //  · a >30k-char tool result at index 1 (below the cutoff) — tier-0 clears it;
    //  · a summary marker at index 3 = cutoff−1 — the tier-2 span past it is
    //    EMPTY (compactableSpan → null, and the static fallback with it);
    //  · a LATER summary marker at index 8 = len−2 — dualSummaryPartition's
    //    post-chain rest is ONE message (history empty, window ≤ 1 → null);
    //  · a ~60k-char window at indices 5-7 (no assistant after index 4, so
    //    stubFloor stays 4) — post-clear occupancy ~15k tokens stays over the
    //    learned 3_200 threshold, so the tier-0 event (needs a fit) never fires.
    const messages: AgentMessage[] = [
      { role: "user", content: "seed" },
      { role: "tool", toolCallId: "c0", name: "echo", content: bigText(30_500) },
      { role: "assistant", content: "ack" },
      { role: "user", content: `${SUMMARY_MARKER} first pass` },
      { role: "assistant", content: "mid" },
      { role: "user", content: bigText(20_000) },
      { role: "user", content: bigText(20_000) },
      { role: "user", content: bigText(20_000) },
      { role: "user", content: `${SUMMARY_MARKER} second pass` },
      { role: "user", content: "go" },
    ];
    const st = state(messages);
    const events = await drain(
      runAgentLoop(st, model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, keepRecent: 6 },
      }),
    );
    // The clear RAN (history moved) but NO compact tier emitted an event.
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(events.find((e) => e.type === "compact_deferred")).toBeUndefined();
    const cleared = st.messages[1];
    expect(cleared?.role === "tool" && cleared.content.startsWith(CLEARED_MARKER)).toBe(true);
    // Two calls, no summary call (both summary tiers bailed partition-null),
    // and the resend is NOT byte-identical — it rode the cleared prefix.
    expect(model.calls).toBe(2);
    expect(model.inputs[1]?.messages).not.toEqual(model.inputs[0]?.messages);
    // The honest label for the mutated-without-event corner.
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("cleared");
  });

  // The label's other two branches stay exact under the same fix (guards
  // against over-correction): the untouched resend keeps "retried" (pinned
  // above, 87 item 1) and the byte-identical demand is real — a resend whose
  // messages array was swapped but whose BYTES are equal still happened here
  // only through a compaction, so "compacted"/"cleared" remain the only
  // history-moving labels.
});

// ---------------------------------------------------------------------------
// 87 item 2 — observed.windowTokens floor (poisoned-parse defense)
// ---------------------------------------------------------------------------

describe("87 item 2 — a poisoned tiny windowTokens parse cannot collapse the effective window", () => {
  // A trusted-parse body with a garbage window (7 tokens) is learned as-is
  // today (windowTokens > 0), collapsing effectiveWindow to 7 → threshold 5
  // → every occupancy "crosses" → the shared-window admission clip degenerates
  // to max(1024, 7 − occupancy − 8192) = the MIN_CLIP floor on a healthy
  // ~80-token context. With the floor, effectiveWindow stays ≥ 4096 →
  // threshold 3276 → the next request goes out uncapped.
  it("the turn AFTER a poisoned parse sends a plain request (no degenerate min-clip)", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 800, windowTokens: 7 }) },
      { kind: "toolcall", id: "c1" }, // turn 1 recovers (nothing compactable → bare resend)
      { kind: "ok", content: "done" }, // turn 2 — the probe request
    ]);
    const events = await drain(
      runAgentLoop(state([{ role: "user", content: "go" }], [ECHO]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, windowMode: "shared" },
      }),
    );
    // Nothing was compactable — the run stayed healthy end to end.
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    // Turn 1's original request: uncapped (the base window was still unknown).
    expect(model.inputs[0]?.maxTokens).toBeUndefined();
    // Turn 2's request against the LEARNED window — the poisoned 7 must not
    // collapse the effective window below the 4096 floor (threshold 3276
    // stays above the ~80-token occupancy → no admission clip at all).
    expect(model.inputs[2]?.maxTokens).toBeUndefined();
    expect(model.calls).toBe(3);
  });
});

describe("ω-2b (iv) — no compaction configured keeps the unchanged terminal", () => {
  it("even a trusted observed overflow hard-errors immediately (no clip, no compact, one call)", async () => {
    const model = scriptedModel([
      { kind: "error", err: contextLengthError({ promptTokens: 40_000, windowTokens: 64_000 }) },
    ]);
    const gen = runAgentLoop(state([...LADDER_MESSAGES]), model, { maxTurns: 2 });
    const { error: threw } = await drainSettled(gen);
    expect(isContextLengthError(threw)).toBe(true);
    expect((threw as { hard?: true }).hard).toBe(true);
    expect((threw as { compacted?: boolean }).compacted).toBe(false);
    expect(model.calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (v) — the proactive admission clip (shared-window profiles only)
// ---------------------------------------------------------------------------

describe("ω-2b (v) — the proactive admission clip", () => {
  // 207_997 chars + 2 ("go") + 1 (system "s") = 208_000 units ≈ exactly
  // 52_000 tokens; W=64_000 → threshold 51_200 (approaching band: 51_200 ≤
  // 52_000 < 59_392) → clip = 64_000 − 52_000 − 8_192 = 3_808.
  const CLIP_MESSAGES = (): AgentMessage[] => [
    { role: "user", content: bigText(104_000) },
    { role: "assistant", content: bigText(103_997) },
    { role: "user", content: "go" },
  ];

  it("a shared-window profile gets maxTokens capped on the crossing request", async () => {
    const model = scriptedModel([{ kind: "ok", content: "done" }]);
    await drain(
      runAgentLoop(state(CLIP_MESSAGES()), model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, windowMode: "shared" },
      }),
    );
    expect(model.inputs[0]?.maxTokens).toBe(64_000 - 52_000 - 8_192);
  });

  it("an unknown (or absent) window mode never clips the request bytes", async () => {
    for (const windowMode of [undefined, "unknown", "independent"] as const) {
      const model = scriptedModel([{ kind: "ok", content: "done" }]);
      await drain(
        runAgentLoop(state(CLIP_MESSAGES()), model, {
          maxTurns: 2,
          gates: { todo: false, verify: false },
          compaction: { contextWindowTokens: 64_000, ...(windowMode === undefined ? {} : { windowMode }) },
        }),
      );
      expect(model.inputs[0]?.maxTokens, `windowMode=${String(windowMode)}`).toBeUndefined();
    }
  });

  it("under the threshold a shared-window profile sends plain requests", async () => {
    const model = scriptedModel([{ kind: "ok", content: "done" }]);
    await drain(
      runAgentLoop(state([...LADDER_MESSAGES]), model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, windowMode: "shared" },
      }),
    );
    expect(model.inputs[0]?.maxTokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F1 (clip-conflict) — a computed-cap/thinking-budget conflict routes into
// the compact ladder, not a hard fail.
//
// The anthropic wire requires max_tokens > thinking.budget_tokens, and the
// provider boundary fails closed (typed conflict, pre-wire) when an EXPLICIT
// cap sits at/below the budget. Core's computed caps — the admission clip
// and the clip-retry's physical — are context-budget arithmetic: under a high
// effort (budget up to 32K) an armed clip is at/below the budget by
// construction. Compaction recovers it (a shorter prompt raises the computed
// cap), so the loop routes the conflict through the SAME reactive ladder as
// an overflow instead of rethrowing it as a hard failure.
// ---------------------------------------------------------------------------

/** A duck-typed computed-cap/thinking-budget conflict — the shape the
 * providers boundary stamps (MaxTokensThinkingBudgetConflictError). Core
 * duck-types the `code` string alone; the literal pin lives in the providers
 * suite (wire-effort), this factory mirrors the stamp for the core side. */
const budgetConflictError = (maxTokens: number, budgetTokens: number): Error =>
  Object.assign(
    new Error(
      `explicit maxTokens ${maxTokens} conflicts with thinking budget_tokens ${budgetTokens} ` +
        `(the anthropic wire requires max_tokens > budget_tokens, so this body can never be served)`,
    ),
    {
      name: "MaxTokensThinkingBudgetConflictError",
      code: "MAXTOKENS_THINKING_BUDGET_CONFLICT",
      maxTokens,
      budgetTokens,
    },
  );

describe("F1 (clip-conflict) — computed-cap/thinking-budget conflicts route into the compact ladder", () => {
  // ~207k chars ≈ ~51_757 tokens; W=64_000 shared → threshold 51_200 crossed,
  // immediate band (51_200 + 8_192 = 59_392) NOT reached → the admission clip
  // arms at ~4_051 — at/below any high-effort thinking budget (8_192 …
  // 32_768), so the provider's fail-closed gate throws the typed conflict on
  // the ORIGINAL request, before the wire. keepRecent 6 on len 10 → cutoff 4:
  // the >30k-char tool result at index 1 is tier-0 clearable, and the clear
  // fits the threshold back under → the reactive compact fires observably.
  const CONFLICT_MESSAGES = (): AgentMessage[] => [
    { role: "user", content: "seed" },
    { role: "tool", toolCallId: "c0", name: "echo", content: bigText(72_000) },
    { role: "assistant", content: "ack" },
    { role: "user", content: "mid" },
    { role: "assistant", content: "mid2" },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: "filler" },
    { role: "user", content: "go" },
  ];

  it("an armed admission clip that conflicts compacts (tier 0) and retries with the cap dropped", async () => {
    const model = scriptedModel([
      { kind: "error", err: budgetConflictError(4_051, 32_768) },
      { kind: "ok", content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state(CONFLICT_MESSAGES()), model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000, windowMode: "shared", keepRecent: 6 },
      }),
    );
    // The compact ladder ran — observably: the tier-0 clear fits the
    // occupancy back under the threshold, so the compacted event fires.
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted).toHaveLength(1);
    if (compacted[0]?.type === "compacted") expect(compacted[0].trigger).toBe("reactive");
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("compacted");
    // The conflicting computed cap rode the original request only; the retry
    // carries NO maxTokens (the provider's own cap — the natural post-compact
    // rise the recovery relies on). The pre-conflict request DID carry a
    // small computed cap (the thing that conflicted).
    expect(model.inputs[0]?.maxTokens).toBeGreaterThan(0);
    expect(model.inputs[0]?.maxTokens).toBeLessThanOrEqual(8_192);
    expect(model.inputs[1]?.maxTokens).toBeUndefined();
    expect(model.calls).toBe(2);
  });

  it("a conflict on the clip-retry's OWN computed cap falls through to the compact arm (no rethrow)", async () => {
    const model = scriptedModel([
      // Original overflow with a trusted parse: physical = 64_000 − 51_808 −
      // 8_192 = 4_000 ≥ MIN_CLIP → the clip-retry arm runs …
      { kind: "error", err: contextLengthError({ promptTokens: 51_808, windowTokens: 64_000 }) },
      // … and its 4_000 cap sits below the thinking budget → the same typed
      // conflict, this time from the clipped retry itself.
      { kind: "error", err: budgetConflictError(4_000, 8_192) },
      // The compact arm's resend (no cap — the admission clip never armed on
      // this tiny context) recovers the turn.
      { kind: "ok", content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state([{ role: "user", content: "go" }]), model, {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 64_000 },
      }),
    );
    expect(model.inputs[0]?.maxTokens).toBeUndefined(); // original: nothing armed
    expect(model.inputs[1]?.maxTokens).toBe(4_000); // the clip-retry carried the computed cap
    expect(model.inputs[2]?.maxTokens).toBeUndefined(); // the compact resend dropped it
    expect(model.calls).toBe(3);
    // Nothing was compactable — the honest recovery label is the bare resend.
    const recovery = events.find((e) => e.type === "context_recovery");
    expect(recovery).toBeDefined();
    if (recovery?.type === "context_recovery") expect(recovery.kind).toBe("retried");
  });

  it("a conflict that persists past the compact retry terminates typed — the ladder runs once, no infinite compact loop", async () => {
    const model = scriptedModel([
      { kind: "error", err: budgetConflictError(4_051, 32_768) },
      // The post-compact resend STILL conflicts (the scripted provider throws
      // the typed conflict unconditionally — mirroring a conflict compaction
      // cannot fix). The once-per-arm ladder structure is the guard: this is
      // the SECOND and FINAL model attempt of the turn.
      { kind: "error", err: budgetConflictError(4_096, 32_768) },
    ]);
    const gen = runAgentLoop(state(CONFLICT_MESSAGES()), model, {
      maxTurns: 2,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 64_000, windowMode: "shared", keepRecent: 6 },
    });
    const { error: threw, events } = await drainSettled(gen);
    // Typed termination: the surfaced error IS the conflict (duck-typed on
    // the code), not a generic loop failure and not an overflow hard error.
    expect((threw as { code?: string } | undefined)?.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
    // The guard: ONE compact + ONE resend — exactly two model calls, one
    // compacted event, no emergency shed for a non-overflow failure.
    expect(model.calls).toBe(2);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(1);
    expect(model.inputs[1]?.maxTokens).toBeUndefined();
  });

  it("a conflict with NO computed cap of ours (a caller-chosen config cap) keeps the fail-closed propagation", async () => {
    const model = scriptedModel([{ kind: "error", err: budgetConflictError(2_048, 8_192) }]);
    const gen = runAgentLoop(state([{ role: "user", content: "go" }]), model, {
      maxTurns: 2,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 64_000, windowMode: "shared" },
    });
    const { error: threw, events } = await drainSettled(gen);
    expect((threw as { code?: string } | undefined)?.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
    // No ladder burned on an un-compactable conflict: one call, no compact.
    expect(model.calls).toBe(1);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// conflict-origin — the config-cap marker skips the pre-doomed compact.
//
// The double-cap corner: the admission clip armed this turn AND the caller's
// PERSISTENT config.maxTokens also sits at/below the thinking budget. The
// old router judged the conflict "computed" (the clip is armed), dropped the
// clip, and burned a FULL reactive compact — yet the post-compact resend's
// cap resolves back to config.maxTokens and re-conflicts before the wire:
// the compact was pre-doomed. The provider's gate knows this (it sees
// config.maxTokens), so the typed conflict now carries a marker field; the
// loop reads it and keeps the typed fail-closed propagation directly —
// zero compact, zero extra model call. Same corner, same skip, in the
// clip-retry arm's catch (a conflict on the clipped retry's own computed
// cap whose config cap ALSO conflicts: the compact below is equally
// pre-doomed).
// ---------------------------------------------------------------------------

/** The same typed conflict WITH the config-cap marker: the provider stamped
 *  that the persistent config.maxTokens also sits at/below the budget. The
 *  field name is core-owned (CONFIG_CAP_ALSO_CONFLICTS_FIELD); pinned
 *  literally here so a rename of the core constant goes loud on both sides
 *  of the seam. */
const configCapBudgetConflictError = (maxTokens: number, budgetTokens: number): Error =>
  Object.assign(budgetConflictError(maxTokens, budgetTokens), { configCapAlsoConflicts: true });

describe("conflict-origin — a conflict stamped config-cap-also-conflicts skips the futile compact ladder", () => {
  // Same shape as the F1 corner above: ~207k chars ≈ ~51_757 tokens,
  // W=64_000 shared → threshold crossed → the admission clip arms at
  // ~4_051, at/below any high-effort thinking budget. The difference: the
  // thrown conflict ALSO carries the config-cap marker.
  const DOUBLE_CAP_MESSAGES = (): AgentMessage[] => [
    { role: "user", content: "seed" },
    { role: "tool", toolCallId: "c0", name: "echo", content: bigText(72_000) },
    { role: "assistant", content: "ack" },
    { role: "user", content: "mid" },
    { role: "assistant", content: "mid2" },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: bigText(45_000) },
    { role: "user", content: "filler" },
    { role: "user", content: "go" },
  ];

  it("the double-cap corner (armed clip + conflicting config cap) terminates typed with ZERO compact and ONE model call", async () => {
    const model = scriptedModel([{ kind: "error", err: configCapBudgetConflictError(4_051, 32_768) }]);
    const gen = runAgentLoop(state(DOUBLE_CAP_MESSAGES()), model, {
      maxTurns: 2,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 64_000, windowMode: "shared", keepRecent: 6 },
    });
    const { error: threw, events } = await drainSettled(gen);
    // The pre-doomed ladder never ran: no compact event, no recovery event,
    // no resend — exactly ONE model call (compaction cannot raise a
    // caller-chosen config cap; the resend would re-conflict pre-wire).
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(events.filter((e) => e.type === "context_recovery")).toHaveLength(0);
    expect(model.calls).toBe(1);
    // Typed termination, straight to the surface: the error IS the conflict,
    // not an overflow hard error and not the second conflict the old router
    // eventually surfaced after burning the compact.
    expect((threw as { code?: string } | undefined)?.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
    // The clip WAS armed on the original request — the corner this batch
    // kills: the old router judged this conflict "computed" and compacted.
    expect(model.inputs[0]?.maxTokens).toBeGreaterThan(0);
    expect(model.inputs[0]?.maxTokens).toBeLessThanOrEqual(8_192);
  });

  it("the clip-retry's OWN conflict carrying the marker skips the compact arm too (typed termination, no third call)", async () => {
    const model = scriptedModel([
      // Original overflow with a trusted parse: physical = 64_000 − 51_808 −
      // 8_192 = 4_000 ≥ MIN_CLIP → the clip-retry arm runs …
      { kind: "error", err: contextLengthError({ promptTokens: 51_808, windowTokens: 64_000 }) },
      // … and its 4_000 computed cap conflicts while the config cap ALSO
      // sits below the budget — the marker says the compact below is
      // pre-doomed (its resend resolves back to config.maxTokens and
      // re-conflicts before the wire).
      { kind: "error", err: configCapBudgetConflictError(4_000, 8_192) },
    ]);
    const gen = runAgentLoop(state([{ role: "user", content: "go" }]), model, {
      maxTurns: 2,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 64_000 },
    });
    const { error: threw, events } = await drainSettled(gen);
    // No compact arm burned on the pre-doomed conflict — two model calls
    // total (original + clip-retry), no resend past it.
    expect(model.calls).toBe(2);
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(events.filter((e) => e.type === "context_recovery")).toHaveLength(0);
    expect((threw as { code?: string } | undefined)?.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
    expect(model.inputs[0]?.maxTokens).toBeUndefined(); // original: nothing armed
    expect(model.inputs[1]?.maxTokens).toBe(4_000); // the clip-retry carried the computed cap
  });

  // The COMPOUND corner (the ledger's "复合角落裁决" — the path where the
  // catch-comment's "pre-doomed" MECHANISM is false and the skip stands BY
  // POLICY): a GENUINE overflow first (conflictOnComputedCap false → the
  // admission-clip drop never ran), the armed clip's value ABOVE the thinking
  // budget (it never conflicted and is still LIVE), and a physical that
  // landed in [MIN_CLIP_TOKENS, budget] so the clip-retry's own cap conflicts
  // AND carries the marker. Had the compact arm run, its resend
  // (buildModelInput reads admissionClip at call time) would carry the
  // still-armed >budget clip and could PHYSICALLY serve — so the mechanism
  // argument does not reach this corner. The skip is the maxtokens-narrow
  // ruling: fail-closed beats a speculative recovery that would mask a
  // deterministic config conflict with core arithmetic. This test pins that
  // ruling into the suite.
  it("the compound corner (genuine overflow + live clip above budget + physical within [MIN_CLIP, budget]) skips the compact BY POLICY", async () => {
    // 416_000 units ≈ exactly 104_000 tokens; W=128_000 shared → threshold
    // 102_400 crossed, immediate band (110_592) NOT reached → the admission
    // clip arms at 128_000 − 104_000 − 8_192 = 15_808 — ABOVE the 8_192
    // budget the scripted conflict below carries.
    const model = scriptedModel([
      // Original request riding the live 15_808 clip: a GENUINE overflow
      // with a trusted parse — physical = 128_000 − 116_000 − 8_192 =
      // 3_808 ∈ [1_024, 8_192] → the clip-retry arm runs.
      { kind: "error", err: contextLengthError({ promptTokens: 116_000, windowTokens: 128_000 }) },
      // The retry's own 3_808 computed cap conflicts while the config cap
      // ALSO sits at/below the budget — the marked conflict.
      { kind: "error", err: configCapBudgetConflictError(3_808, 8_192) },
    ]);
    const gen = runAgentLoop(
      state([
        { role: "user", content: bigText(208_000) },
        { role: "assistant", content: bigText(207_997) },
        { role: "user", content: "go" },
      ]),
      model,
      {
        maxTurns: 2,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 128_000, windowMode: "shared" },
      },
    );
    const { error: threw, events } = await drainSettled(gen);
    // The corner's ingredients, pinned: the original rode a LIVE clip above
    // the budget (15_808 > 8_192 — this is what makes the corner compound);
    // the retry's computed cap sat inside [MIN_CLIP_TOKENS, budget].
    expect(model.inputs[0]?.maxTokens).toBe(128_000 - 104_000 - 8_192);
    expect(model.inputs[0]?.maxTokens ?? 0).toBeGreaterThan(8_192);
    expect(model.inputs[1]?.maxTokens).toBe(128_000 - 116_000 - 8_192);
    // The ruling: typed fail-closed termination with the compact arm
    // unburned — zero compacted, zero recovery, exactly two model calls.
    expect((threw as { code?: string } | undefined)?.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    expect(events.filter((e) => e.type === "context_recovery")).toHaveLength(0);
    expect(model.calls).toBe(2);
  });
});
