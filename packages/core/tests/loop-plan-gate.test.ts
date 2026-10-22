// M37 §1 — plan mode stop gate. While gates.plan is on, the todo gate's lane
// changes meaning: a plan run may stop as soon as a todo board EXISTS (the
// plan IS the board — completeness is the execution run's business), but an
// empty-handed stop with NO board is nudged back, up to maxInsists.
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/tool.js";
import { createScriptedModel } from "../src/model-client.js";
import { createTodoTool } from "../src/tools/todo.js";
import type { AgentMessage, AgentState, LoopEvent, Tool } from "../src/types.js";

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: `${name} ok` };
    },
  });
}

async function drain(gen: AsyncGenerator<LoopEvent, unknown, unknown>): Promise<{ events: LoopEvent[] }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events };
    events.push(r.value);
  }
}

function planState(): AgentState {
  return {
    systemPrompt: "s",
    messages: [{ role: "user", content: "plan the feature" } as AgentMessage],
    tools: [createTodoTool({}), stubTool("read_file"), stubTool("write_file")],
    status: "idle",
  };
}

const BOARD_TODOS = [{ content: "read the parser", status: "pending" }, { content: "fix the bug", status: "pending" }];

describe("plan gate (M37 §1)", () => {
  it("blocks an empty-handed answer while NO board exists, then accepts a stop once the board lands", async () => {
    const state = planState();
    const model = createScriptedModel([
      { role: "assistant", content: "here is my plan: ..." }, // no board → gate
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: BOARD_TODOS } }] },
      { role: "assistant", content: "Plan ready (2 steps)." }, // board exists → allowed
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { plan: true } }));
    const gateEvents = events.filter((e): e is Extract<LoopEvent, { type: "gate_injected" }> => e.type === "gate_injected");
    expect(gateEvents).toHaveLength(1);
    // The nudge names plan mode and asks for a todo_write board.
    expect(gateEvents[0]?.text).toContain("plan mode");
    expect(gateEvents[0]?.text).toContain("todo_write");
    const injected = state.messages.find((m) => m.role === "user" && m.content.includes("plan mode"));
    expect(injected?.content.startsWith("[system note:")).toBe(true);
    // The final answer is the post-board one (completed, not max_turns).
    const last = state.messages.at(-1);
    expect(last?.content).toContain("Plan ready");
  });

  it("allows an immediate answer WITH a board (an all-pending plan board is a legitimate stop)", async () => {
    const state = planState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: BOARD_TODOS } }] },
      { role: "assistant", content: "Plan: 2 steps, risks covered." },
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { plan: true } }));
    expect(events.filter((e) => e.type === "gate_injected")).toHaveLength(0);
    const last = state.messages.at(-1);
    expect(last?.content).toContain("Plan: 2 steps");
  });

  it("gives up after maxInsists empty answers (deadlock escape, same cap as the todo gate)", async () => {
    const state = planState();
    const model = createScriptedModel([
      { role: "assistant", content: "no board 1" },
      { role: "assistant", content: "no board 2" },
      { role: "assistant", content: "no board 3" },
      { role: "assistant", content: "no board 4 — allowed through" },
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { plan: true } }));
    expect(events.filter((e) => e.type === "gate_injected")).toHaveLength(3);
    const last = state.messages.at(-1);
    expect(last?.content).toContain("allowed through");
  });

  it("gates.plan=false (default) keeps the M23 todo-gate semantics — an all-pending board INSISTS, never passes", async () => {
    const state = planState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: BOARD_TODOS } }] },
      { role: "assistant", content: "stopping with pending items" }, // → todo gate insists
      { role: "assistant", content: "still stopping" },
      { role: "assistant", content: "still stopping 2" },
      { role: "assistant", content: "still stopping 3" }, // insists exhausted → through
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    const gateEvents = events.filter((e): e is Extract<LoopEvent, { type: "gate_injected" }> => e.type === "gate_injected");
    expect(gateEvents).toHaveLength(3);
    expect(gateEvents[0]?.text).toContain("todo board has 2 incomplete");
    expect(gateEvents[0]?.text).not.toContain("plan mode");
  });
});
