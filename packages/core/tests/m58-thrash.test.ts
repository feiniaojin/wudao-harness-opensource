// M58 §C#3 — the compaction thrash breaker: when the auto-compaction trigger
// re-fires within ≤2 turns for 2 consecutive compactions, the loop stops
// auto-compacting and surfaces the typed CompactionThrashError (suggesting
// /clear, --fork-session, /context) instead of looping forever. The guard is
// SHARED with the §A reactive path; an isolated compaction (or none) never
// trips it, and the run completes normally.
import { describe, it, expect } from "vitest";
import { runAgentLoop, CompactionThrashError } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, ModelClient, Tool } from "../src/index.js";
import { drainSettled } from "./helpers/drain.js";

/** A read tool whose Nth call returns a huge result (refills the window). */
function refillingReadTool(): Tool {
  let n = 0;
  return {
    name: "read_file",
    description: "returns a big result every call",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    execute: async (args) => {
      n += 1;
      void args;
      return { content: `result ${n}\n${"payload line\n".repeat(240)}` };
    },
  };
}

const state = (messages: AgentMessage[], tools: Tool[]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools,
  status: "idle",
});

/** Scripted model: one tool-call turn per script entry (varied paths keep the
 * loop-safety identical-call detector quiet), then a final answer. */
function scriptedTurnsModel(paths: readonly string[], final = "done"): ModelClient & { calls: number } {
  let calls = 0;
  const responses: AssistantMessage[] = [
    ...paths.map((p, i) => ({ role: "assistant" as const, content: "", toolCalls: [{ id: `r${i}`, name: "read_file", arguments: { path: p } }] })),
    { role: "assistant" as const, content: final },
  ];
  return {
    get calls() {
      return calls;
    },
    async generate(): Promise<AssistantMessage> {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

describe("compaction thrash breaker (M58 §C#3)", () => {
  it("two consecutive rapid re-fires stop auto-compaction with the typed error", async () => {
    // Each read result (~3.3k chars ≈ 800 tokens) refills past the 500-token
    // threshold on its own; compactions land every other turn (the boundary
    // of the turn whose top-of-turn check saw the refill) — gaps of 2.
    const model = scriptedTurnsModel(["a", "b", "c", "d", "e", "f"]);
    const { error, events } = await drainSettled(
      runAgentLoop(
        state([{ role: "user", content: "go" }], [refillingReadTool()]),
        model,
        {
          maxTurns: 10,
          gates: { todo: false, verify: false },
          compaction: { contextWindowTokens: 625, keepRecent: 1 },
        },
      ),
    );
    // At least the two compactions that built the streak ran first…
    expect(events.filter((e) => e.type === "compacted").length).toBeGreaterThanOrEqual(2);
    // …and the third rapid trigger is the breaker, not another compaction.
    expect(error).toBeInstanceOf(CompactionThrashError);
    expect(error?.name).toBe("CompactionThrashError");
    expect(error?.message).toContain("/clear");
    expect(error?.message).toContain("--fork-session");
    expect(error?.message).toContain("/context");
  });

  it("an isolated compaction (no rapid re-fire) completes normally", async () => {
    // One huge result only; after the single compaction the window stays low.
    let n = 0;
    const oneBigRead: Tool = {
      name: "read_file",
      description: "one big result",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      execute: async () => {
        n += 1;
        return { content: n === 1 ? `first\n${"payload line\n".repeat(240)}` : "tiny" };
      },
    };
    const model = scriptedTurnsModel(["a", "b", "c", "d"]);
    const { error, events } = await drainSettled(
      runAgentLoop(state([{ role: "user", content: "go" }], [oneBigRead]), model, {
        maxTurns: 8,
        gates: { todo: false, verify: false },
        compaction: { contextWindowTokens: 625, keepRecent: 1 },
      }),
    );
    expect(error).toBeUndefined();
    expect(events.filter((e) => e.type === "compacted").length).toBeLessThan(2);
  });

  it("the guard is SHARED with the reactive 413 path (spec §A: 共用单次守卫)", async () => {
    // Two consecutive reactive compactions, then a third overflow — the
    // breaker fires instead of a third compaction.
    const cle = (): Error => Object.assign(new Error("provider context length exceeded: 413"), { name: "ContextLengthError" });
    const echo: Tool = {
      name: "echo",
      description: "trivial",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => ({ content: String((args as { text?: string }).text ?? "") }),
    };
    const summary = (): AssistantMessage => ({ role: "assistant", content: "SUMMARY" });
    // The retry must keep the loop alive: a tool-call turn (distinct ids keep
    // the loop-safety identical-call detector quiet).
    const ok = (id: string): AssistantMessage => ({
      role: "assistant",
      content: "",
      toolCalls: [{ id, name: "echo", arguments: { text: id } }],
    });
    const steps: Array<() => AssistantMessage> = [
      () => { throw cle(); }, summary, () => ok("t1"),
      () => { throw cle(); }, summary, () => ok("t2"),
      () => { throw cle(); },
    ];
    let calls = 0;
    const model: ModelClient & { calls: number } = {
      get calls() {
        return calls;
      },
      async generate() {
        const step = steps[calls];
        calls += 1;
        if (step === undefined) throw new Error("scripted responses exhausted");
        return step();
      },
    };
    const messages: AgentMessage[] = [
      { role: "user", content: "task one " + "x".repeat(300) },
      { role: "assistant", content: "answer one " + "y".repeat(300) },
      { role: "user", content: "go" },
    ];
    const { error } = await drainSettled(
      runAgentLoop(state(messages, [echo]), model, {
        maxTurns: 6,
        gates: { todo: false, verify: false },
        // ω-2b: the small window keeps the ladder's clip step out of range
        // (physical < 1024), so the reactive COMPACT path runs here.
        compaction: { contextWindowTokens: 9_000, keepRecent: 1, zeroLlmDigest: false }, // #38: the digest never fails, so the breaker needs the LLM path
      }),
    );
    expect(error).toBeInstanceOf(CompactionThrashError);
  });
});
