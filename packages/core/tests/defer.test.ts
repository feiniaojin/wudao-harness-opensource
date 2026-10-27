// M35 §1 — deferred tool loading (the `shouldDefer` DNA annotation, realized).
// A tool marked shouldDefer never enters the request's tools array; a single
// trailing `load_tools` meta-tool advertises one-line summaries instead. The
// model calls it once; the chosen definitions are APPENDED after load_tools
// from the NEXT request of the run — the one tool-set change a run allows.
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/tool.js";
import { createDeferController, LOAD_TOOLS_NAME, deferSummary } from "../src/defer.js";
import type { LoopEvent, Terminal } from "../src/loop.js";
import type { AgentState } from "../src/state.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import type { Tool } from "../src/tool.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** Scripted responses in call order; records every ModelInput it receives. */
function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const call = (id: string, name: string, args: Record<string, unknown>): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] });

function eagerTool(name = "eager"): Tool {
  return buildTool({
    name,
    description: `Eager tool ${name}.`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute() {
      return { content: `${name} ran` };
    },
  });
}

function deferredOrchestrator(name = "task"): Tool {
  return buildTool({
    name,
    description: `Orchestration tool ${name}. Launches work. Second sentence is longer and must not reach the summary line.`,
    parameters: {
      type: "object",
      properties: { prompt: { type: "string", description: "The work." } },
      required: ["prompt"],
      additionalProperties: false,
    },
    shouldDefer: () => true,
    async execute() {
      return { content: `${name} ran` };
    },
  });
}

const stateWith = (tools: readonly Tool[], responses: readonly AssistantMessage[]): { state: AgentState; model: ReturnType<typeof recordingModel> } => ({
  state: { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [...tools], status: "idle" },
  model: recordingModel(responses),
});

const names = (input: ModelInput | undefined): string[] => (input?.tools ?? []).map((t) => t.name);

// ---------------------------------------------------------------------------
// Controller unit surface
// ---------------------------------------------------------------------------

describe("createDeferController", () => {
  it("inactive (no deferred tools): requestDefs is the plain full map, no load_tools, effectiveTools unchanged", () => {
    const tools = [eagerTool(), deferredOrchestrator()];
    const c = createDeferController([tools[0]!]); // eager only
    expect(c.hasDeferred).toBe(false);
    expect(c.requestDefs()).toEqual(tools.slice(0, 1).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })));
    expect(c.requestDefs().map((d) => d.name)).toEqual(["eager"]);
    expect(c.effectiveTools()).toHaveLength(1);
    expect(c.consumeApplied()).toBeUndefined();
  });

  it("active: load_tools rides the tail; its description lists each deferred tool's name + one-line summary", async () => {
    const c = createDeferController([eagerTool(), deferredOrchestrator("task"), deferredOrchestrator("agent_await")]);
    expect(c.hasDeferred).toBe(true);
    expect(namesOf(c.requestDefs())).toEqual(["eager", LOAD_TOOLS_NAME]);
    const meta = c.requestDefs().find((d) => d.name === LOAD_TOOLS_NAME)!;
    expect(meta.description).toContain("- task: Orchestration tool task.");
    expect(meta.description).toContain("- agent_await: Orchestration tool agent_await.");
    // The meta tool is executable through the normal pipeline and NOT concurrency-safe.
    const exec = c.effectiveTools().find((t) => t.name === LOAD_TOOLS_NAME)!;
    expect(exec.isConcurrencySafe?.({})).toBe(false);
    expect(exec.isReadOnly?.({})).toBe(true);
  });

  it("deferSummary collapses to one line and caps long descriptions", () => {
    expect(deferSummary("First sentence. Second sentence.")).toBe("First sentence.");
    const long = `${"word ".repeat(60)}.`;
    expect(deferSummary(long).length).toBeLessThanOrEqual(120);
    expect(deferSummary(long)).not.toContain("\n");
  });

  function namesOf(defs: readonly { name: string }[]): string[] {
    return defs.map((d) => d.name);
  }
});

// ---------------------------------------------------------------------------
// Loop behavior
// ---------------------------------------------------------------------------

describe("deferred tool loading in the loop", () => {
  it("no shouldDefer tools → requests carry the full array and no load_tools (behavior unchanged)", async () => {
    const { state, model } = stateWith([eagerTool(), eagerTool("task")], [
      call("c1", "eager", {}),
      { role: "assistant", content: "done" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    expect(terminal.reason).toBe("completed");
    expect(names(model.inputs[0])).toEqual(["eager", "task"]);
    expect(names(model.inputs[1])).toEqual(["eager", "task"]);
    expect(names(model.inputs[0]).includes(LOAD_TOOLS_NAME)).toBe(false);
  });

  it("deferred tools are excluded from the first request; load_tools sits at the tail", async () => {
    const { state, model } = stateWith([deferredOrchestrator("task"), eagerTool(), deferredOrchestrator("agent_await")], [
      { role: "assistant", content: "done" },
    ]);
    await drain(runAgentLoop(state, model, { maxTurns: 2 }));
    expect(names(model.inputs[0])).toEqual(["eager", LOAD_TOOLS_NAME]);
  });

  it("load_tools({names}) appends the chosen definitions AFTER load_tools from the next request (one-time, append-only, base order kept)", async () => {
    const { state, model } = stateWith([eagerTool("a"), deferredOrchestrator("task"), deferredOrchestrator("agent_await"), eagerTool("b")], [
      call("c1", LOAD_TOOLS_NAME, { names: ["agent_await", "task"] }),
      { role: "assistant", content: "done" },
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    const before = names(model.inputs[0]);
    const after = names(model.inputs[1]);
    expect(before).toEqual(["a", "b", LOAD_TOOLS_NAME]);
    // Chosen defs appended at the tail in TOOL-SET order (task before agent_await),
    // after the load_tools meta-tool — the pre-change segment is a prefix.
    expect(after).toEqual(["a", "b", LOAD_TOOLS_NAME, "task", "agent_await"]);
    expect(after.slice(0, before.length)).toEqual(before);
    // The defer_loaded event fired exactly once, with the applied names.
    const loaded = events.filter((e): e is Extract<LoopEvent, { type: "defer_loaded" }> => e.type === "defer_loaded");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.names).toEqual(["task", "agent_await"]);
    // The load_tools tool result tells the model what joined its toolset.
    const result = state.messages.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(result?.content).toContain("task");
  });

  it("one-time window: a second load_tools call changes nothing further (receipt says frozen; tools bytes stable)", async () => {
    const { state, model } = stateWith([eagerTool(), deferredOrchestrator("task"), deferredOrchestrator("agent_await")], [
      call("c1", LOAD_TOOLS_NAME, { names: ["task"] }),
      call("c2", LOAD_TOOLS_NAME, { names: ["agent_await"] }),
      { role: "assistant", content: "done" },
    ]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    expect(names(model.inputs[1])).toEqual(["eager", LOAD_TOOLS_NAME, "task"]);
    expect(names(model.inputs[2])).toEqual(["eager", LOAD_TOOLS_NAME, "task"]);
    // Byte-stable: the post-load tools segment never changes again.
    expect(JSON.stringify(model.inputs[1]?.tools)).toBe(JSON.stringify(model.inputs[2]?.tools));
    const loaded = events.filter((e): e is Extract<LoopEvent, { type: "defer_loaded" }> => e.type === "defer_loaded");
    expect(loaded).toHaveLength(1);
    const second = state.messages.filter((m) => m.role === "tool")[1];
    expect(second?.content).toContain("frozen");
  });

  it("bad names (unknown / eager / empty) fail closed WITHOUT consuming the one-time window", async () => {
    const { state, model } = stateWith([eagerTool(), deferredOrchestrator("task")], [
      call("c1", LOAD_TOOLS_NAME, { names: ["nope"] }),
      call("c2", LOAD_TOOLS_NAME, { names: ["eager"] }),
      call("c3", LOAD_TOOLS_NAME, { names: [] }),
      call("c4", LOAD_TOOLS_NAME, { names: ["task"] }),
      { role: "assistant", content: "done" },
    ]);
    await drain(runAgentLoop(state, model, { maxTurns: 6 }));
    const results = state.messages.filter((m) => m.role === "tool") as { content: string; isError?: boolean }[];
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("nope");
    expect(results[1]?.isError).toBe(true);
    expect(results[1]?.content).toContain("not a deferred tool");
    expect(results[2]?.isError).toBe(true);
    // The window was still intact: the valid 4th call applied — the request
    // that CARRIED it (inputs[3]) predates the load; the next one has task.
    expect(names(model.inputs[3])).toEqual(["eager", LOAD_TOOLS_NAME]);
    expect(names(model.inputs[4])).toEqual(["eager", LOAD_TOOLS_NAME, "task"]);
  });

  it("a deferred tool that was never loaded stays hidden all run (chosen-only loading)", async () => {
    const { state, model } = stateWith([deferredOrchestrator("task"), deferredOrchestrator("agent_cancel"), eagerTool()], [
      call("c1", LOAD_TOOLS_NAME, { names: ["task"] }),
      { role: "assistant", content: "done" },
    ]);
    await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    expect(names(model.inputs[1])).toEqual(["eager", LOAD_TOOLS_NAME, "task"]);
    expect(names(model.inputs[1]).includes("agent_cancel")).toBe(false);
  });

  it("load_tools goes through the permission pipeline: canUseTool deny → not applied, error result, next request unchanged", async () => {
    const { state, model } = stateWith([deferredOrchestrator("task"), eagerTool()], [
      call("c1", LOAD_TOOLS_NAME, { names: ["task"] }),
      { role: "assistant", content: "done" },
    ]);
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      canUseTool: (name) => name === LOAD_TOOLS_NAME ? { behavior: "deny", reason: "no orchestration" } : { behavior: "allow" },
    }));
    const denied = state.messages.find((m) => m.role === "tool") as { isError?: boolean; content: string } | undefined;
    expect(denied?.isError).toBe(true);
    expect(denied?.content).toContain("permission denied");
    expect(events.filter((e) => e.type === "defer_loaded")).toHaveLength(0);
    expect(names(model.inputs[1])).toEqual(["eager", LOAD_TOOLS_NAME]);
  });

  it("onPreToolUse sees load_tools calls (block → not applied)", async () => {
    const { state, model } = stateWith([deferredOrchestrator("task"), eagerTool()], [
      call("c1", LOAD_TOOLS_NAME, { names: ["task"] }),
      { role: "assistant", content: "done" },
    ]);
    const seen: string[] = [];
    await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      hooks: {
        onPreToolUse(name) {
          seen.push(name);
          return { block: true, reason: "policy" };
        },
      },
    }));
    expect(seen).toContain(LOAD_TOOLS_NAME);
    expect(names(model.inputs[1])).toEqual(["eager", LOAD_TOOLS_NAME]);
  });

  it("load_tools with no deferring active is an unknown tool (error result)", async () => {
    const { state, model } = stateWith([eagerTool()], [
      call("c1", LOAD_TOOLS_NAME, { names: ["whatever"] }),
      { role: "assistant", content: "done" },
    ]);
    await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    const result = state.messages.find((m) => m.role === "tool") as { isError?: boolean; content: string } | undefined;
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("unknown tool");
  });

  it("buildTool's fail-closed default: shouldDefer is false when unset", () => {
    const t = buildTool({
      name: "x", description: "d",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return { content: "" };
      },
    });
    expect(t.shouldDefer?.()).toBe(false);
  });
});
