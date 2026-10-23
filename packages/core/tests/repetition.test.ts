// ω-1b — the repetition circuit breaker (goose tool_monitor.rs:34-82, digest
// 98a): N consecutive IDENTICAL tool calls (same name + JSON-stringified
// arguments) trip an error tool result instead of executing; any different
// call resets the streak; the trip itself resets the counter (the breaker
// shorts ONE call, never the tool — the next identical call accumulates
// again). Loop integration: the tripped call gets the breaker text as its
// tool result and the tool body never runs (spy).
import { describe, it, expect } from "vitest";
import {
  createRepetitionInspector,
  repetitionBreakerMessage,
  REPETITION_DEFAULT_THRESHOLD,
} from "../src/tools/repetition.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool, ToolCall } from "../src/index.js";

const call = (name: string, args: Record<string, unknown>, id = name): ToolCall => ({ id, name, arguments: args });

// ---------------------------------------------------------------------------
// pure inspector
// ---------------------------------------------------------------------------

describe("createRepetitionInspector", () => {
  it("default threshold 3: the third consecutive identical call trips", () => {
    const insp = createRepetitionInspector();
    expect(REPETITION_DEFAULT_THRESHOLD).toBe(3);
    expect(insp.inspect(call("read_file", { path: "a.txt" }))).toEqual({ repeated: false, count: 1 });
    expect(insp.inspect(call("read_file", { path: "a.txt" }))).toEqual({ repeated: false, count: 2 });
    expect(insp.inspect(call("read_file", { path: "a.txt" }))).toEqual({ repeated: true, count: 3 });
  });

  it("a trip RESETS the counter — the next identical call accumulates again (no deadlock)", () => {
    const insp = createRepetitionInspector();
    for (let i = 0; i < 3; i += 1) insp.inspect(call("t", { a: 1 }));
    // 4th identical: fresh streak.
    expect(insp.inspect(call("t", { a: 1 }))).toEqual({ repeated: false, count: 1 });
    expect(insp.inspect(call("t", { a: 1 }))).toEqual({ repeated: false, count: 2 });
    expect(insp.inspect(call("t", { a: 1 }))).toEqual({ repeated: true, count: 3 });
  });

  it("any DIFFERENT call in between resets the streak", () => {
    const insp = createRepetitionInspector();
    expect(insp.inspect(call("t", { a: 1 })).repeated).toBe(false);
    expect(insp.inspect(call("t", { a: 1 })).repeated).toBe(false);
    expect(insp.inspect(call("t", { a: 2 })).count).toBe(1); // different args
    expect(insp.inspect(call("t", { a: 1 }))).toEqual({ repeated: false, count: 1 });
    expect(insp.inspect(call("u", { a: 1 })).count).toBe(1); // different tool
    expect(insp.inspect(call("t", { a: 1 }))).toEqual({ repeated: false, count: 1 });
  });

  it("same tool + different arguments is NOT a repeat (alternating args never trip)", () => {
    const insp = createRepetitionInspector();
    // a,b,a,b,a — every call differs from its predecessor: streak never passes 1.
    for (const p of ["a.txt", "b.txt", "a.txt", "b.txt", "a.txt"]) {
      expect(insp.inspect(call("read_file", { path: p })).repeated).toBe(false);
    }
    // Different tool, same args: also a different call.
    expect(insp.inspect(call("grep", { pattern: "x" })).count).toBe(1);
  });

  it("threshold is configurable", () => {
    const strict = createRepetitionInspector({ threshold: 2 });
    expect(strict.inspect(call("t", {})).repeated).toBe(false);
    expect(strict.inspect(call("t", {})).repeated).toBe(true);
    const loose = createRepetitionInspector({ threshold: 5 });
    for (let i = 0; i < 4; i += 1) expect(loose.inspect(call("t", {})).repeated).toBe(false);
    expect(loose.inspect(call("t", {})).repeated).toBe(true);
  });

  it("the breaker message names the count and the directive", () => {
    const msg = repetitionBreakerMessage({ name: "shell" }, 3);
    expect(msg).toContain("第 3 次");
    expect(msg).toContain("熔断");
    expect(msg).toContain("换一种做法");
    expect(msg).toContain("shell");
  });

  it("documented bound: JSON.stringify keys are order-SENSITIVE (reordered keys are a different call)", () => {
    // The known limitation, pinned: the key is name + JSON.stringify(args),
    // so {a,b} and {b,a} do not match. The M48 loop-safety net (canonical
    // fingerprints) is the second line for that shape.
    const insp = createRepetitionInspector();
    insp.inspect(call("t", { a: 1, b: 2 }));
    expect(insp.inspect(call("t", { b: 2, a: 1 })).count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// per-turn counting (the loop's lane): M48's windowCalls doctrine — a turn
// contributes at most 1 to a call's streak. Same-batch identical calls are
// ONE decision (a parallel fan-out): they never accumulate and never trip on
// their own; the streak counts the model RE-CHOOSING the call across turns.
// ---------------------------------------------------------------------------

describe("createRepetitionInspector — per-turn lane (turn argument)", () => {
  it("one call per turn: trips on the 3rd consecutive identical TURN", () => {
    const insp = createRepetitionInspector();
    expect(insp.inspect(call("read_file", { path: "a" }), 0)).toEqual({ repeated: false, count: 1 });
    expect(insp.inspect(call("read_file", { path: "a" }), 1)).toEqual({ repeated: false, count: 2 });
    expect(insp.inspect(call("read_file", { path: "a" }), 2)).toEqual({ repeated: true, count: 3 });
  });

  it("a same-batch fan-out of identical calls counts ONCE per turn (T7's shape)", () => {
    const insp = createRepetitionInspector();
    const fanout = Array.from({ length: 8 }, (_, i) => call("big_tool", {}, `t${i + 1}`));
    for (let turn = 0; turn < 2; turn += 1) {
      for (const c of fanout) {
        expect(insp.inspect(c, turn).repeated).toBe(false); // 8 copies, ONE streak count per turn
      }
    }
    // Third consecutive identical TURN trips — and every copy of THAT turn's
    // batch shares the verdict (the whole re-choice is refused, not 2 of 8).
    for (const c of fanout) {
      expect(insp.inspect(c, 2)).toEqual({ repeated: true, count: 3 });
    }
  });

  it("when a turn's re-choice trips, every identical copy in THAT turn shares the verdict", () => {
    const insp = createRepetitionInspector();
    insp.inspect(call("t", {}), 0);
    insp.inspect(call("t", {}), 1);
    // Turn 2 re-chooses the call TWICE (a same-batch duplicate): both refuse.
    expect(insp.inspect(call("t", {}), 2)).toEqual({ repeated: true, count: 3 });
    expect(insp.inspect(call("t", {}), 2)).toEqual({ repeated: true, count: 3 });
    // Trip reset: turn 3 restarts the accumulation.
    expect(insp.inspect(call("t", {}), 3)).toEqual({ repeated: false, count: 1 });
  });

  it("a different call between turns still resets the streak (per-turn lane)", () => {
    const insp = createRepetitionInspector();
    insp.inspect(call("t", { a: 1 }), 0);
    insp.inspect(call("t", { a: 1 }), 1);
    insp.inspect(call("u", {}), 2);
    expect(insp.inspect(call("t", { a: 1 }), 3)).toEqual({ repeated: false, count: 1 });
  });
});

// ---------------------------------------------------------------------------
// loop integration: the breaker rides the executeToolCall seam.
// ---------------------------------------------------------------------------

const SYSTEM = "You are a deterministic test agent.";

function stateWith(tools: readonly Tool[]): AgentState {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: "do the thing" }], tools: [...tools], status: "idle" };
}

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

describe("runAgentLoop — repetition breaker integration", () => {
  it("the 3rd consecutive identical call gets the breaker error and the tool never runs", async () => {
    let execCount = 0;
    const echoTool: Tool = {
      name: "echo",
      description: "echoes its arg",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async () => {
        execCount += 1;
        return { content: "ok" };
      },
    };
    const sameCall = (id: string) => ({ role: "assistant" as const, content: "", toolCalls: [{ id, name: "echo", arguments: { text: "same" } }] });
    const model = recordingModel([sameCall("c1"), sameCall("c2"), sameCall("c3"), { role: "assistant", content: "done" }]);
    const state = stateWith([echoTool]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false, verify: false } }));

    expect(terminal.reason).toBe("completed");
    // Calls 1-2 executed; call 3 was short-circuited before the tool body.
    expect(execCount).toBe(2);
    const breakerMsg = state.messages.find((m) => m.role === "tool" && m.content.includes("熔断"));
    expect(breakerMsg).toBeDefined();
    expect(breakerMsg?.content).toContain("第 3 次");
    expect(breakerMsg?.content).toContain("换一种做法");
    expect((breakerMsg as { isError?: boolean }).isError).toBe(true);
    const finished = events.filter((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(finished.filter((e) => e.isError)).toHaveLength(1);
    expect(finished.find((e) => e.isError)?.result).toContain("熔断");
  });

  it("varied calls never trip the breaker", async () => {
    let execCount = 0;
    const echoTool: Tool = {
      name: "echo",
      description: "echoes its arg",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async () => {
        execCount += 1;
        return { content: "ok" };
      },
    };
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "a" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "echo", arguments: { text: "b" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "echo", arguments: { text: "a" } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = stateWith([echoTool]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false, verify: false } }));

    expect(terminal.reason).toBe("completed");
    expect(execCount).toBe(3);
    expect(state.messages.some((m) => m.role === "tool" && m.content.includes("熔断"))).toBe(false);
  });
});
