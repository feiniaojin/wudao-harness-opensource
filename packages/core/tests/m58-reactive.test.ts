// M58 §A — the 413 reactive layer's loop half: a provider-classified
// ContextLengthError (duck-typed at the port) triggers the compaction ladder
// (trigger "reactive", reason "overflow"), retries the model call ONCE, and
// stamps the retry's turn_usage receipt with the cold-turn compensation
// (coldTurnExpected + cacheBreakAttribution). A second overflow is the
// terminal failure with the /clear-or-smaller-task wording.
import { describe, it, expect } from "vitest";
import { runAgentLoop, isContextLengthError } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, ModelUsage } from "../src/index.js";
import { SUMMARY_MARKER } from "../src/compaction.js";
import { drainSettled } from "./helpers/drain.js";

/** A duck-typed ContextLengthError exactly as the providers package stamps
 * it (core recognizes the shape without importing the class). */
const contextLengthError = (status = 413): Error =>
  Object.assign(new Error(`provider context length exceeded: ${status} too big`), { name: "ContextLengthError", status });

type ScriptStep = { readonly kind: "error"; readonly err: Error } | { readonly kind: "ok"; readonly content: string; readonly usage?: ModelUsage };

/** Scripted model over generate() — throws or answers per step, and reports
 * usage on every ok (the loop's receipt annotation rides onUsage). Captures
 * every input so tests can assert what the model actually saw. */
function scriptedScriptModel(steps: readonly ScriptStep[]): ModelClient & { calls: number; inputs: ModelInput[] } {
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
      if (step.kind === "error") throw step.err;
      if (step.usage !== undefined) input.onUsage?.(step.usage);
      return { role: "assistant", content: step.content };
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

const state = (messages: AgentMessage[]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools: [],
  status: "idle",
});

const MESSAGES: AgentMessage[] = [
  { role: "user", content: "task one " + "x".repeat(400) },
  { role: "assistant", content: "answer one " + "y".repeat(400) },
  { role: "user", content: "go" },
];

const USAGE: ModelUsage = { promptTokens: 50, cacheHitTokens: 0, cacheMissTokens: 50, completionTokens: 4 };

describe("runAgentLoop — reactive context overflow (M58 §A)", () => {
  it("compacts (trigger reactive), retries once, and annotates the retry's receipt", async () => {
    const model = scriptedScriptModel([
      { kind: "error", err: contextLengthError() },
      { kind: "ok", content: "REACTIVE-SUMMARY" }, // the tier-2 summary call
      { kind: "ok", content: "final answer", usage: USAGE }, // the one retry
    ]);
    const events = await drain(
      runAgentLoop(state([...MESSAGES]), model, {
        maxTurns: 3,
        // ω-2b: the small window keeps the ladder's clip step out of range
        // (physical < 1024), so these tests still exercise the COMPACT corner.
        compaction: { contextWindowTokens: 9_000, keepRecent: 1, zeroLlmDigest: false }, // #38: consume the scripted summary
      }),
    );
    // Compaction fired with the reactive vocabulary.
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type === "compacted") {
      expect(compacted.trigger).toBe("reactive");
      expect(compacted.reason).toBe("overflow");
    }
    // The rewritten prefix is in place (a frozen summary marker).
    // The retry's usage receipt carries the cold-turn compensation.
    const usage = events.find((e) => e.type === "usage");
    expect(usage).toBeDefined();
    if (usage?.type === "usage") {
      expect(usage.usage.coldTurnExpected).toBe(true);
      expect(usage.usage.cacheBreakAttribution).toBe("reactive");
    }
    // Exactly the scripted calls: overflow → summary → retry (no extra).
    expect(model.calls).toBe(3);
  });

  it("a SECOND overflow after the reactive compaction is a hard error suggesting /clear", async () => {
    const model = scriptedScriptModel([
      { kind: "error", err: contextLengthError() },
      { kind: "ok", content: "REACTIVE-SUMMARY" },
      { kind: "error", err: contextLengthError(400) },
    ]);
    const st = state([...MESSAGES]);
    const gen = runAgentLoop(st, model, {
      maxTurns: 3,
      // ω-2b: the small window keeps the ladder's clip step out of range
        // (physical < 1024), so these tests still exercise the COMPACT corner.
        compaction: { contextWindowTokens: 9_000, keepRecent: 1, zeroLlmDigest: false }, // #38: consume the scripted summary
    });
    const { error: threw } = await drainSettled(gen);
    expect(threw).toBeInstanceOf(Error);
    expect((threw as Error).message).toContain("/clear");
    expect((threw as Error).message).toContain("smaller");
    // The hard variant: compaction ran, message names the reactive path, and
    // the distinguishing field marks it terminal.
    expect((threw as { hard?: true }).hard).toBe(true);
    expect((threw as { compacted?: boolean }).compacted).toBe(true);
    expect((threw as Error).message).toContain("after reactive compaction");
    // Still duck-typed as the overflow family for front-ends.
    expect(isContextLengthError(threw)).toBe(true);
    // One compaction only — the retry is single-shot, no death spiral.
    expect(model.calls).toBe(3);
  });

  it("with no compaction configured, the overflow hard-errors immediately (no compact, no retry)", async () => {
    const model = scriptedScriptModel([{ kind: "error", err: contextLengthError() }]);
    const gen = runAgentLoop(state([...MESSAGES]), model, { maxTurns: 2 });
    const { error: threw } = await drainSettled(gen);
    expect(isContextLengthError(threw)).toBe(true);
    expect((threw as Error).message).toContain("/clear");
    // No compaction ran — the message must NOT claim one did.
    expect((threw as Error).message).not.toContain("after reactive compaction");
    expect((threw as { hard?: true }).hard).toBe(true);
    expect((threw as { compacted?: boolean }).compacted).toBe(false);
    expect(model.calls).toBe(1);
  });

  it("non-overflow model errors keep their existing rethrow semantics", async () => {
    const boom = new Error("provider request failed: 503 unavailable");
    const model = scriptedScriptModel([{ kind: "error", err: boom }]);
    const gen = runAgentLoop(state([...MESSAGES]), model, {
      maxTurns: 2,
      compaction: { contextWindowTokens: 64_000 },
    });
    const { error: threw } = await drainSettled(gen);
    expect(threw).toBe(boom);
  });

  it("the reactive compaction rewrites state.messages with a frozen summary boundary", async () => {
    const model = scriptedScriptModel([
      { kind: "error", err: contextLengthError() },
      { kind: "ok", content: "REACTIVE-SUMMARY" },
      { kind: "ok", content: "done", usage: USAGE },
    ]);
    const st = state([...MESSAGES]);
    await drain(runAgentLoop(st, model, { maxTurns: 3, // ω-2b: the small window keeps the ladder's clip step out of range
        // (physical < 1024), so these tests still exercise the COMPACT corner.
        compaction: { contextWindowTokens: 9_000, keepRecent: 1 } }));
    expect(st.messages.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(true);
    expect(st.messages.some((m) => m.content.includes("REACTIVE-SUMMARY"))).toBe(true);
    // Append-only: the kept tail survives verbatim.
    expect(st.messages[st.messages.length - 2]?.content).toBe("go");
  });

  it("review fix: a MetaNote drained for the overflowing call still reaches the RETRY input", async () => {
    const model = scriptedScriptModel([
      { kind: "error", err: contextLengthError() },
      { kind: "ok", content: "REACTIVE-SUMMARY" },
      { kind: "ok", content: "done", usage: USAGE },
    ]);
    const note = "external file changed: src/a.ts (recall your earlier edit)";
    const queue = [note];
    const events = await drain(
      runAgentLoop(state([...MESSAGES]), model, {
        maxTurns: 3,
        // ω-2b: the small window keeps the ladder's clip step out of range
        // (physical < 1024), so these tests still exercise the COMPACT corner.
        compaction: { contextWindowTokens: 9_000, keepRecent: 1, zeroLlmDigest: false }, // #38: consume the scripted summary
        metaNotes: { take: () => queue.shift() },
      }),
    );
    // The note was surfaced once (projection event) and never persisted.
    expect(events.filter((e) => e.type === "meta_note")).toHaveLength(1);
    // BOTH the failed call's input and the retry's input carry the note.
    expect(model.inputs.length).toBe(3);
    const firstInput = model.inputs[0]?.messages ?? [];
    const retryInput = model.inputs[2]?.messages ?? [];
    expect(firstInput.some((m) => m.content.includes(note))).toBe(true);
    expect(retryInput.some((m) => m.content.includes(note))).toBe(true);
    // The retry rides the COMPACTED messages (a summary marker replaced the
    // overflowed prefix) — the note landed on the rewritten shape.
    expect(retryInput.some((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))).toBe(true);
  });
});
