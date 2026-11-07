// ω-long-1 — integration: the turn-budget note really reaches the model.
// The pure milestone math is pinned in turn-budget.test.ts; THIS file proves
// the wire: a run with turnBudget:true carries the watermark into a model
// request, exactly at the two milestones, never per-turn, and a run without
// the option stays byte-identical (the zero-change contract).
import { describe, expect, it } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import type {
  AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool,
} from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
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

// Varying arguments on purpose: an identical-args noop triples into the
// loop-safety identical_calls verdict and the run aborts long before the
// milestones this file is about (learned the hard way).
const toolCall = (id: string, n: number): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name: "noop", arguments: { n } }] });

const noopTool = (): Tool =>
  buildTool({
    name: "noop",
    description: "no-op",
    parameters: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false },
    execute: async () => ({ content: "ok" }),
  });

const stateOf = (): AgentState => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "go" }],
  tools: [noopTool()],
  status: "idle",
});

/** Every system_note string seen across all model inputs, in order. */
function notesSeen(inputs: readonly ModelInput[]): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    for (const m of input.messages) {
      const text = typeof m.content === "string" ? m.content : "";
      if (text.includes("turn budget:")) out.push(text);
    }
  }
  return out;
}

/** N tool-calling responses then a final answer. */
function script(turns: number): AssistantMessage[] {
  return [
    ...Array.from({ length: turns }, (_, i) => toolCall(`c${i}`, i)),
    { role: "assistant", content: "done" },
  ];
}

describe("turn-budget watermark on the wire", () => {
  it("injects the 50% note at the halfway turn, and only once per milestone", async () => {
    const model = recordingModel(script(10));
    await drain(runAgentLoop(stateOf(), model, { maxTurns: 10, turnBudget: true }));
    const notes = notesSeen(model.inputs);
    // A 10-turn run crosses BOTH milestones (50% at ~turn 5, 20% at ~turn 8);
    // what matters is that neither fires twice.
    const pace = notes.filter((n) => n.includes("Pace yourself"));
    const wrap = notes.filter((n) => n.includes("Wrap up NOW"));
    expect(pace).toHaveLength(1);
    expect(wrap).toHaveLength(1);
    expect(notes).toHaveLength(2);
  });

  it("injects both milestones for a longer run and never nags per turn", async () => {
    const model = recordingModel(script(20));
    await drain(runAgentLoop(stateOf(), model, { maxTurns: 20, turnBudget: true }));
    const notes = notesSeen(model.inputs);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/\b(10|9) turn\(s\) left/);
    expect(notes[1]).toContain("Wrap up NOW");
    expect(notes[1]).toContain("the run stops when they reach 0");
  });

  it("is silent when the option is absent (zero-change contract)", async () => {
    const model = recordingModel(script(10));
    await drain(runAgentLoop(stateOf(), model, { maxTurns: 10 }));
    expect(notesSeen(model.inputs)).toHaveLength(0);
  });

  it("notes are never persisted into the transcript", async () => {
    const state = stateOf();
    const model = recordingModel(script(10));
    await drain(runAgentLoop(state, model, { maxTurns: 10, turnBudget: true }));
    const persisted = state.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(persisted).not.toContain("turn budget:");
  });
});
