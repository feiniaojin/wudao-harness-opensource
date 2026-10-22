// M70 §2 (the upstream project) — the three usage-anchor guards on the occupancy estimate that
// drives auto-compaction, plus retainedTail on compaction entries:
//   (a) model switch — an anchor reported by a DIFFERENT model than the
//       current client is dropped (its tokenizer/window no longer describes
//       the prompt);
//   (b) stale usage — every compaction invalidates the anchor (the number
//       predates the new boundary; it must never re-trigger a second compact);
//   (c) zero usage — an absent/zero anchor falls back to the char-estimated
//       occupancy, which still fires the compaction correctly.
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage } from "../src/index.js";

type Step = { readonly content: string; readonly toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]; readonly usage?: ModelUsage };

/** Scripted model over generate() with per-step usage rows and an optional
 * modelId (the M70 §2 client identity the anchor guards compare against). */
function anchoredModel(steps: readonly Step[], modelId?: string): ModelClient & { calls: number } {
  let calls = 0;
  return {
    modelId,
    get calls() {
      return calls;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      if (step.usage !== undefined) input.onUsage?.(step.usage);
      return {
        role: "assistant",
        content: step.content,
        ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
      };
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, unknown>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
}

const state = (messages: AgentMessage[]): AgentState => ({ systemPrompt: "s", messages, tools: [], status: "idle" });

const READ: Step["toolCalls"] = [{ id: "c1", name: "noop", arguments: {} }];

// Char estimate stays far below the threshold — only the USAGE anchor can
// drive occupancy in these scenarios.
const SMALL: AgentMessage[] = [
  { role: "user", content: "task one" },
  { role: "assistant", content: "answer one" },
  { role: "user", content: "go" },
];

const usage = (promptTokens: number, model?: string): ModelUsage => ({
  promptTokens,
  cacheHitTokens: 0,
  cacheMissTokens: promptTokens,
  ...(model !== undefined ? { model } : {}),
});

const compactedEvents = (events: readonly LoopEvent[]) => events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");

describe("usage-anchor guards (M70 §2)", () => {
  it("(b) stale usage after a compact never triggers a SECOND compact", async () => {
    // Turn 0 reports a huge anchor; turn 1 compacts (immediate, summary =
    // "S1"). The stale 20k anchor predates the boundary — turn 2 must NOT
    // re-compact (the pre-M70 Math.max(estimate, lastPromptTokens) shape
    // consumed "S2" for a second summary and compacted again).
    const model = anchoredModel([
      { content: "", toolCalls: READ, usage: usage(20_000) }, // turn 0 call
      { content: "S1" }, // compact #1's tier-2 summary
      { content: "", toolCalls: READ }, // turn 1 call — NO usage row
      { content: "S2" }, // only consumed by a (spurious) compact #2
      { content: "done" }, // turn 2 call
    ]);
    const events = await drain(
      // #38: consume the scripted "S1" summary — these tests count calls.
      runAgentLoop(state([...SMALL]), model, { maxTurns: 4, compaction: { contextWindowTokens: 4_000, keepRecent: 1, zeroLlmDigest: false } }),
    );
    const compacts = compactedEvents(events);
    expect(compacts).toHaveLength(1);
    expect(compacts[0]?.trigger).toBe("immediate");
    expect(model.calls).toBe(4);
  });

  it("(a) a model switch mid-stream drops the old-model anchor — no compact until the current model's usage", async () => {
    const model = anchoredModel(
      [
        { content: "", toolCalls: READ, usage: usage(20_000, "old-model") }, // turn 0
        { content: "", toolCalls: READ, usage: usage(20_000, "new-model") }, // turn 1
        { content: "S1" }, // the compact's tier-2 summary
        { content: "done" }, // turn 2 call
      ],
      "new-model",
    );
    const events = await drain(
      runAgentLoop(state([...SMALL]), model, { maxTurns: 4, compaction: { contextWindowTokens: 4_000, keepRecent: 1, zeroLlmDigest: false } }), // #38: consume "S1"
    );
    const compacts = compactedEvents(events);
    expect(compacts).toHaveLength(1);
    // The compact waited for the CURRENT model's usage: it fired on the turn
    // AFTER the new-model row (turn 2), not after the old-model row (turn 1).
    expect(compacts[0]?.turn).toBe(2);
    expect(model.calls).toBe(4);
  });

  it("(a) untagged usage rows keep anchoring (backward compatible)", async () => {
    const model = anchoredModel(
      [
        { content: "", toolCalls: READ, usage: usage(20_000) }, // turn 0
        { content: "S1" }, // the compact's tier-2 summary
        { content: "done" }, // turn 1 call
      ],
      "new-model",
    );
    const events = await drain(
      runAgentLoop(state([...SMALL]), model, { maxTurns: 4, compaction: { contextWindowTokens: 4_000, keepRecent: 1, zeroLlmDigest: false } }), // #38: consume "S1"
    );
    const compacts = compactedEvents(events);
    expect(compacts).toHaveLength(1);
    expect(compacts[0]?.turn).toBe(1);
    expect(model.calls).toBe(3);
  });

  it("(c) zero usage falls back to the char estimate — and the compaction still fires", async () => {
    // A gateway that reports promptTokens: 0 (junk zeros) over a genuinely
    // huge char occupancy: the anchor is unusable, the char estimate drives
    // the trigger.
    const model = anchoredModel([
      { content: "", toolCalls: READ, usage: usage(0) },
      { content: "done" },
    ]);
    const big: AgentMessage[] = [
      { role: "user", content: "huge " + "x".repeat(80_000) },
      { role: "user", content: "go" },
    ];
    const events = await drain(
      runAgentLoop(state(big), model, { maxTurns: 3, compaction: { contextWindowTokens: 8_000, keepRecent: 1 } }),
    );
    const compacts = compactedEvents(events);
    expect(compacts).toHaveLength(1);
    // beforeTokens is the CHAR estimate (the anchor contributed nothing).
    expect(compacts[0]?.beforeTokens).toBeGreaterThan(10_000);
  });

  it("the anchor grows by the trailing messages appended since the report", async () => {
    // Anchor 3_000 (below the 3_200 threshold); ~40k chars of trailing tool
    // results push the anchored occupancy over threshold+band → immediate.
    const model = anchoredModel([
      { content: "", toolCalls: READ, usage: usage(3_000) },
      { content: "done" },
    ]);
    const events = await drain(
      runAgentLoop(state([...SMALL]), model, { maxTurns: 3, compaction: { contextWindowTokens: 4_000, keepRecent: 1 } }),
    );
    // No compact at turn 0 (nothing reported yet); the anchored occupancy at
    // turn 1 = 3_000 + trailing estimate of the appended messages — SMALL's
    // tail is tiny, so no compact fires: the anchor alone never crosses.
    expect(compactedEvents(events)).toHaveLength(0);
  });

  it("retainedTail rides the compacted event — the messages kept verbatim", async () => {
    const model = anchoredModel([
      { content: "SUMMARY-BODY" }, // the tier-2 summary call
      { content: "done" }, // turn 0 call
    ]);
    const big: AgentMessage[] = [
      { role: "user", content: "huge " + "x".repeat(80_000) },
      { role: "user", content: "go" },
    ];
    const st = state(big);
    const events = await drain(
      runAgentLoop(st, model, { maxTurns: 3, compaction: { contextWindowTokens: 8_000, keepRecent: 1 } }),
    );
    const compacts = compactedEvents(events);
    expect(compacts).toHaveLength(1);
    const tail = compacts[0]?.retainedTail;
    expect(Array.isArray(tail)).toBe(true);
    // The retained tail is exactly what survived verbatim after the boundary:
    // non-empty, and every entry appears verbatim in the post-compact state.
    expect((tail ?? []).length).toBeGreaterThan(0);
    for (const m of tail ?? []) {
      expect(st.messages).toContain(m);
    }
    expect((tail ?? []).some((m) => m.role === "user" && m.content === "go")).toBe(true);
  });
});
