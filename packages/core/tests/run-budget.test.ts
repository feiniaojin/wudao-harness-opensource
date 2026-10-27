import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import { createScriptedModel, type ModelClient, type ModelInput } from "../src/model-client.js";
import type { AgentState } from "../src/state.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample.txt");

// Drive the generator manually to capture its Terminal *return value*.
// (for-await-of consumes yielded events but discards the generator return value.)
async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const toolTurn = {
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }],
};

const mkState = (): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" }],
  tools: [createReadFileTool()],
  status: "idle",
});

/** A scripted model that always calls the tool, advancing a shared clock by
 *  `stepMs` per call — the deterministic time source for budget tests (no
 *  sleeps, no fake timers). The clock is read through `now` below. */
function steppingModel(stepMs: number): ModelClient & { calls: number; clock: () => number } {
  const base = createScriptedModel([toolTurn, toolTurn, toolTurn, toolTurn, toolTurn, toolTurn]);
  let clock = 0;
  let calls = 0;
  return {
    clock: () => clock,
    async generate(input: ModelInput) {
      const out = await base.generate(input);
      calls += 1;
      clock += stepMs;
      return out;
    },
    get calls() {
      return calls;
    },
  };
}

// The one non-injectable event field: per-call wall time comes from
// performance.now() inside the loop — normalize it for equality asserts.
const stripDurations = (events: readonly LoopEvent[]): LoopEvent[] =>
  events.map((e) => (e.type === "tool_call_finished" ? { ...e, durationMs: undefined } : e));

describe("runAgentLoop run budget (maxRunMs)", () => {
  it("budget exhausted → typed run_budget_exhausted exit at the turn top; model called exactly the turns the budget allowed; queued steering not consumed", async () => {
    // 2s per model call, 5s budget → calls at t=0,2k,4k allowed; the t=6k
    // turn-top check (6000 > 5000) exits before the 4th model call.
    const model = steppingModel(2_000);
    // A steer queued "just before" the exhausted turn: available from the
    // moment the clock hits the exhausted point (turn 3's top). The exit
    // happens BEFORE that turn's steering drain — the item must remain
    // unconsumed (no take() serves it, no steered event fires).
    let steerServed = false;
    const steering = {
      take: (): string | undefined => {
        if (!steerServed && model.clock() >= 6_000) {
          steerServed = true;
          return "late steer";
        }
        return undefined;
      },
    };
    const state = mkState();
    const { events, terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 50, maxRunMs: 5_000, now: model.clock, steering }),
    );

    expect(terminal.reason).toBe("run_budget_exhausted");
    expect(model.calls).toBe(3);
    // The exhausted turn began no events at all (top-of-turn fuse, max_turns' shape).
    expect(Math.max(...events.map((e) => e.turn))).toBe(2);
    // Queued steering stays queued — the drain never ran on the exited turn.
    expect(steerServed).toBe(false);
    expect(events.some((e) => e.type === "steered")).toBe(false);
  });

  it("budget not exhausted → event-for-event identical to an unbudgeted run; history byte-identical", async () => {
    const stateA = mkState();
    const stateB = mkState();
    const a = await drain(
      runAgentLoop(stateA, createScriptedModel([toolTurn, { role: "assistant", content: "done" }]), { maxTurns: 5 }),
    );
    const b = await drain(
      runAgentLoop(stateB, createScriptedModel([toolTurn, { role: "assistant", content: "done" }]), {
        maxTurns: 5,
        maxRunMs: 3_600_000,
        now: () => 42,
      }),
    );

    expect(b.terminal.reason).toBe("completed");
    expect(b.terminal.finalMessage?.content).toBe("done");
    expect(stripDurations(b.events)).toEqual(stripDurations(a.events));
    // Prefix-cache witness: the persisted history is byte-identical.
    expect(JSON.stringify(stateB.messages)).toBe(JSON.stringify(stateA.messages));
  });

  it("maxRunMs undefined → zero change: a stepping clock alone never stops the run", async () => {
    const script = createScriptedModel([toolTurn, { role: "assistant", content: "done" }]);
    // Stepping clock without a budget: elapsed (4s at the end) would pass any
    // small budget, but no maxRunMs is set — the run must complete on the
    // script alone (the undefined path is the zero-change contract).
    let clock = 0;
    const timedScript: ModelClient = {
      async generate(input: ModelInput) {
        const out = await script.generate(input);
        clock += 2_000;
        return out;
      },
    };
    const { events, terminal } = await drain(
      runAgentLoop(mkState(), timedScript, { maxTurns: 5, now: () => clock }),
    );

    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("done");
    expect(events.filter((e) => e.type === "model_call_finished")).toHaveLength(2);
    expect(clock).toBe(4_000);
  });

  // 波次 7 #40 (hive #6): the run-budget soft landing. The maxTurns fuse has
  // a last-chance nudge; maxRunMs was a bare hard wall — a model still
  // exploring at the fuse lost the run with no answer at all. At 80% of the
  // budget the loop injects ONE answer-now note at the turn boundary (the
  // same append-only-tail shape as the turn-limit nudge); the hard exit
  // itself stays injection-free.
  it("crossing 80% of the budget injects one answer-now note; the model lands the answer instead of hitting the wall", async () => {
    const script = createScriptedModel([toolTurn, toolTurn, toolTurn, toolTurn, { role: "assistant", content: "landed" }]);
    let clock = 0;
    const inputs: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        const out = await script.generate(input);
        clock += 1_000;
        return out;
      },
    };
    const state = mkState();
    const { terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 10, maxRunMs: 5_000, now: () => clock }),
    );

    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("landed");
    // The note fired exactly once (turn 4's top: elapsed 4000 ≥ 0.8×5000).
    const notes = state.messages.filter((m) => m.role === "user" && m.content.startsWith("[system note: run budget nearly exhausted"));
    expect(notes).toHaveLength(1);
    // The answering model call SAW the note.
    expect(inputs.at(-1)?.messages.some((m) => m.role === "user" && m.content.startsWith("[system note: run budget nearly exhausted"))).toBe(true);
  });

  it("the note fires at most once when the model keeps tool-calling past 80% into the wall", async () => {
    // 1s per call, 4.5s budget: note at turn 4's top (4000 ≥ 0.8×4500=3600);
    // the wall trips at turn 5's top (5000 > 4500) — six scripted calls used
    // exactly. The run ends through the fuse with exactly one note.
    const model = steppingModel(1_000);
    const state = mkState();
    const { terminal } = await drain(
      runAgentLoop(state, model, { maxTurns: 50, maxRunMs: 4_500, now: model.clock }),
    );

    expect(terminal.reason).toBe("run_budget_exhausted");
    const notes = state.messages.filter((m) => m.role === "user" && m.content.startsWith("[system note: run budget nearly exhausted"));
    expect(notes).toHaveLength(1);
  });

  it("a sub-80% run never sees the note (zero-change witness)", async () => {
    const state = mkState();
    const { terminal } = await drain(
      runAgentLoop(state, createScriptedModel([toolTurn, { role: "assistant", content: "done" }]), {
        maxTurns: 5,
        maxRunMs: 3_600_000,
        now: () => 42,
      }),
    );

    expect(terminal.reason).toBe("completed");
    expect(state.messages.some((m) => m.role === "user" && m.content.startsWith("[system note: run budget nearly exhausted"))).toBe(false);
  });
});
