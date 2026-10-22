// M48 §2 — the loop side of the terminal-shape repair: the provider fires
// ModelInput.onTerminalRepair from inside the call; the loop parks the kind
// and surfaces it as a `terminal_repair` event right after the call settles.
// (The repair itself — one frozen byte-identical replay — is provider-side,
// pinned in packages/providers/tests/terminal-repair.test.ts.)
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, TerminalRepairKind, Tool } from "../src/index.js";

const echoTool: Tool = {
  name: "echo",
  description: "echoes its arg",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => ({ content: `echo: ${String((args as { text?: string }).text ?? "")}` }),
};

/** A model that repairs its first (degenerate) finish itself, like the
 *  provider wrapper does — one onTerminalRepair, then the recovered message. */
function repairingModel(repairOnCall: number, kind: TerminalRepairKind): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      call += 1;
      if (call === repairOnCall) input.onTerminalRepair?.(kind);
      if (call === 1 && repairOnCall === 1) {
        return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "after repair" } }] };
      }
      if (call === 1) return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "x" } }] };
      return { role: "assistant", content: "settled after repair" };
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

describe("runAgentLoop — terminal_repair event", () => {
  it("surfaces the provider's repair as an event after the model call settles", async () => {
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      status: "idle",
    };
    const model = repairingModel(1, "reasoning-only");
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 4, gates: { todo: false, verify: false } }));

    const repair = events.filter((e): e is Extract<LoopEvent, { type: "terminal_repair" }> => e.type === "terminal_repair");
    expect(repair).toHaveLength(1);
    expect(repair[0]?.kind).toBe("reasoning-only");
    expect(repair[0]?.turn).toBe(0);
    // Ordering: after model_call_finished of the same turn, before tools.
    const callIdx = events.findIndex((e) => e.type === "model_call_finished");
    const toolIdx = events.findIndex((e) => e.type === "tool_call_started");
    const repairIdx = events.findIndex((e) => e.type === "terminal_repair");
    expect(callIdx).toBeLessThan(repairIdx);
    expect(repairIdx).toBeLessThan(toolIdx);
    expect(terminal.reason).toBe("completed");
  });

  it("no callback, no event (status quo untouched)", async () => {
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [echoTool],
      status: "idle",
    };
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        return { role: "assistant", content: "plain" };
      },
    };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 4, gates: { todo: false, verify: false } }));
    expect(events.some((e) => e.type === "terminal_repair")).toBe(false);
  });
});
