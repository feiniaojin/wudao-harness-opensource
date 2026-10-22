// ω-2b (I2-b) — the emergency truncate tier: pure-tier semantics + the
// reactive-corner call site. Acceptance per design §3-D:
//   · keep-recent tail alone over budget ⇒ null;
//   · scripted overflow until the emergency retry: after the compact-retry
//     fails, the oldest 20% is gone, the marker message is present, zero
//     orphaned tool results, compacted{trigger:"emergency"};
//   · a third overflow ⇒ ContextOverflowHardError;
//   · the attempt-count bound holds (≤ 4 model calls per turn).
import { describe, it, expect } from "vitest";
import { runAgentLoop, emergencyDrop, EMERGENCY_DROP_PREFIX, estimateTokens, occupancyBreakdown, SUMMARY_MARKER } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput } from "../src/index.js";
import type { Tool } from "../src/index.js";
import { drainSettled } from "./helpers/drain.js";

const contextLengthError = (): Error =>
  Object.assign(new Error("provider context length exceeded: 400 too big"), { name: "ContextLengthError", status: 400 });

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

/** A 20-message alternating history with big user bodies: n×0.2 = 4 dropped. */
function bigHistory(n: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "user", content: `u${i} ` + "x".repeat(2_000) });
    out.push({ role: "assistant", content: `a${i} y`.repeat(4) });
  }
  out.push({ role: "user", content: "go" });
  return out;
}

/** A tool-result-heavy history (5k-char results, microcompact-eligible): a
 * reactive compact stubs them IN PLACE — the list length never changes, so
 * the emergency tier's droppable head survives the compact. */
function toolHistory(n: number): AgentMessage[] {
  const out: AgentMessage[] = [{ role: "user", content: "task" }];
  for (let i = 0; i < n; i += 1) {
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `c${i}`, name: "echo", arguments: { text: String(i) } }] });
    out.push({ role: "tool", toolCallId: `c${i}`, name: "echo", content: `r${i} ` + "z".repeat(5_000) });
  }
  out.push({ role: "user", content: "go" });
  return out;
}

describe("emergencyDrop — the pure tier", () => {
  it("drops the oldest 20%, splices ONE frozen count-marker, keeps the head and the tail", () => {
    const messages = bigHistory(10); // 21 messages → desired = ceil(0.2×21) = 5
    const res = emergencyDrop(messages, { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [] });
    expect(res).not.toBeNull();
    const out = res!.messages;
    // The marker: exactly one, right after the pinned head.
    const markers = out.filter((m) => m.content.startsWith(EMERGENCY_DROP_PREFIX));
    expect(markers).toHaveLength(1);
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(markers[0]);
    // The oldest messages are gone; the tail survives verbatim.
    for (const gone of messages.slice(1, res!.dropped + 1)) {
      expect(out).not.toContain(gone);
    }
    expect(out.slice(-1)[0]?.content).toBe("go");
    expect(res!.dropped).toBe(Math.ceil(0.2 * messages.length));
  });

  it("never drops a SUMMARY_MARKER message (chain head frozen) or message 0", () => {
    const messages = bigHistory(6);
    messages[0] = { role: "user", content: `${SUMMARY_MARKER} the frozen chain head` };
    const markerMsg = { role: "user", content: `${SUMMARY_MARKER} second frozen summary` };
    messages.splice(3, 0, markerMsg);
    const res = emergencyDrop(messages, { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [] });
    expect(res).not.toBeNull();
    const kept = res!.messages;
    expect(kept.some((m) => m === messages[0])).toBe(true);
    expect(kept.some((m) => m === markerMsg)).toBe(true);
    expect(kept.filter((m) => m.content.startsWith(SUMMARY_MARKER))).toHaveLength(2);
  });

  it("is pairing-safe: no orphaned tool results, no dangling tool calls", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "1" } }] },
      { role: "tool", toolCallId: "c1", name: "echo", content: "1" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "echo", arguments: { text: "2" } }] },
      { role: "tool", toolCallId: "c2", name: "echo", content: "2" },
      { role: "user", content: "m" + "x".repeat(2_000) },
      { role: "assistant", content: "m" },
      { role: "user", content: "go" },
    ];
    // desired = ceil(0.2×8) = 2 → the assistant c1 + ... pairing must pull the
    // result along (never a dangling call).
    const res = emergencyDrop(messages, { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [], keepRecent: 3 });
    expect(res).not.toBeNull();
    const kept = res!.messages;
    const callIdsKept = new Set<string>();
    for (const m of kept) if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) callIdsKept.add(tc.id);
    for (const m of kept) {
      if (m.role !== "tool") continue;
      expect(callIdsKept.has(m.toolCallId), `result ${m.toolCallId} keeps its call`).toBe(true);
    }
    // Zero orphaned results AND zero dangling calls (each kept call's result
    // is present or was dropped wholesale — here both were dropped together).
    for (const id of callIdsKept) {
      const callKept = kept.some((m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.id === id));
      const resultKept = kept.some((m) => m.role === "tool" && m.toolCallId === id);
      expect(callKept === resultKept, `call ${id} and its result travel together`).toBe(true);
    }
  });

  it("extends the drop while the budget still does not fit", () => {
    const messages = bigHistory(10); // 21 messages
    // The MINIMAL safe result (pinned head + keep window) plus marker slack —
    // a budget that tight forces the extension phase past the 20% floor.
    const minimal = estimateTokens("s", [], [messages[0]!, ...messages.slice(15)]);
    const res = emergencyDrop(messages, { fitsTokens: minimal + 100, systemPrompt: "s", tools: [] });
    expect(res).not.toBeNull();
    expect(estimateTokens("s", [], res!.messages)).toBeLessThanOrEqual(minimal + 100);
    expect(res!.dropped).toBeGreaterThan(Math.ceil(0.2 * messages.length));
  });

  it("null when even the MINIMAL safe drop cannot fit (tail alone over budget)", () => {
    const messages = bigHistory(10);
    const minimal = estimateTokens("s", [], [messages[0]!, ...messages.slice(15)]);
    expect(emergencyDrop(messages, { fitsTokens: minimal - 1, systemPrompt: "s", tools: [] })).toBeNull();
  });

  it("null on idempotence (a marker already present), tiny lists, and nothing droppable", () => {
    const once = emergencyDrop(bigHistory(10), { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [] })!;
    expect(emergencyDrop(once.messages, { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [] })).toBeNull();
    expect(emergencyDrop([{ role: "user", content: "a" }], { fitsTokens: 100, systemPrompt: "s", tools: [] })).toBeNull();
    expect(emergencyDrop(bigHistory(2), { fitsTokens: 1e9, systemPrompt: "s", tools: [], keepRecent: 40 })).toBeNull();
  });

  it("deterministic: identical inputs produce identical outputs", () => {
    const a = emergencyDrop(bigHistory(8), { fitsTokens: 3_000, systemPrompt: "s", tools: [] });
    const b = emergencyDrop(bigHistory(8), { fitsTokens: 3_000, systemPrompt: "s", tools: [] });
    expect(a).toEqual(b);
  });

  it("occupancyBreakdown counts emergency markers (additive key)", () => {
    const once = emergencyDrop(bigHistory(10), { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [] })!;
    expect(occupancyBreakdown("s", [], once.messages).compaction.emergency).toBe(1);
    expect(occupancyBreakdown("s", [], bigHistory(10)).compaction.emergency).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The reactive-corner call site
// ---------------------------------------------------------------------------

function scriptedModel(steps: readonly (() => AssistantMessage | Error)[]): ModelClient & { calls: number; inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  return {
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
      const out = step();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

describe("the reactive corner — emergency drop fires after the compact-retry fails", () => {
  // Small window: the clip step is out of range (physical < 1024), so the
  // ladder goes straight to the reactive compact. The history is tool-result
  // heavy, so the reactive compact lands on TIER 1 (stubs in place — the
  // message LIST keeps its length): the emergency tier still has a droppable
  // head when the compact-retry overflows again.
  const MESSAGES = toolHistory(10);
  const ok = (content: string): AssistantMessage => ({ role: "assistant", content });

  it("compacted{trigger:emergency} + marker + no orphans + ≤4 model attempts, then success", async () => {
    const model = scriptedModel([
      contextLengthError, // call 1: the original request overflows
      contextLengthError, // call 2: the tier-1 compact-retry ALSO overflows
      () => ok("saved by the emergency drop"), // call 3: the emergency retry
    ]);
    const st = state([...MESSAGES]);
    const events = await drain(
      runAgentLoop(st, model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 12_000, keepRecent: 6 },
      }),
    );
    const emergency = events.find((e) => e.type === "compacted" && e.trigger === "emergency");
    expect(emergency).toBeDefined();
    if (emergency?.type === "compacted") {
      expect(emergency.tier).toBe(3);
      expect(emergency.reason).toBe("overflow");
    }
    // The marker message is in the live history.
    expect(st.messages.some((m) => m.content.startsWith(EMERGENCY_DROP_PREFIX))).toBe(true);
    // Pairing integrity of the live history.
    const callIds = new Set<string>();
    for (const m of st.messages) if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) callIds.add(tc.id);
    for (const m of st.messages) {
      if (m.role === "tool") expect(callIds.has(m.toolCallId)).toBe(true);
    }
    // The hard bound: exactly 3 model attempts this turn (tier-1 stubs make
    // no summary call: original + compact-retry + emergency-retry ≤ 4).
    expect(model.calls).toBe(3);
    // The oldest tool-result pair was dropped (its stub is gone from the
    // live history — the JSONL keeps the original, resume re-derives).
    expect(st.messages.some((m) => m.role === "tool" && m.toolCallId === "c0")).toBe(false);
    expect(st.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((tc) => tc.id === "c0"))).toBe(false);
    // 87 item 3: the recovery is OBSERVABLE like its siblings — exactly one
    // context_recovery, kind "emergency" (the tier-3 compacted event carries
    // the drop; this event says the turn was recovered), emitted AFTER the
    // compacted event, carrying no cap (the emergency retry sends no clip).
    const recoveries = events.filter((e) => e.type === "context_recovery");
    expect(recoveries).toHaveLength(1);
    const recovery = recoveries[0];
    if (recovery?.type === "context_recovery") {
      expect(recovery.kind).toBe("emergency");
      expect(recovery.maxTokens).toBeUndefined();
    }
    expect(events.findIndex((e) => e.type === "compacted" && e.trigger === "emergency")).toBeLessThan(
      events.findIndex((e) => e.type === "context_recovery"),
    );
  });

  it("a THIRD overflow (after the emergency retry) is the terminal hard error", async () => {
    const model = scriptedModel([
      contextLengthError, // call 1: original
      contextLengthError, // call 2: the compact-retry fails → emergency
      contextLengthError, // call 3: the EMERGENCY retry fails → terminal
    ]);
    const gen = runAgentLoop(state([...MESSAGES]), model, {
      maxTurns: 3,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 12_000, keepRecent: 6 },
    });
    const { error: threw } = await drainSettled(gen);
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("/clear");
    expect((threw as { hard?: true }).hard).toBe(true);
    expect(model.calls).toBe(3);
  });

  it("the emergency retry's receipt carries the cold-turn compensation (attribution \"emergency\")", async () => {
    // The final ok reports usage; the loop must stamp it with
    // coldTurnExpected + cacheBreakAttribution "emergency" — the emergency
    // drop rewrote the prefix, so the next request's cold cache is expected.
    const model = {
      calls: 0,
      async generate(input: ModelInput): Promise<AssistantMessage> {
        const self = this as unknown as { calls: number };
        self.calls += 1;
        if (self.calls === 3) {
          input.onUsage?.({ promptTokens: 800, cacheHitTokens: 0, cacheMissTokens: 800, completionTokens: 3 });
          return { role: "assistant", content: "done" };
        }
        throw contextLengthError();
      },
    } as unknown as ModelClient & { calls: number };
    const events = await drain(
      runAgentLoop(state([...MESSAGES]), model, {
        maxTurns: 3,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 12_000, keepRecent: 6 },
      }),
    );
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.usage.coldTurnExpected).toBe(true);
      expect(usage.usage.cacheBreakAttribution).toBe("emergency");
    }
  });
});
