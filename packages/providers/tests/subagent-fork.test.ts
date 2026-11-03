// M24 B2: fork subagents (shareContext) — the child reuses the parent's
// system prompt + FULL tool array + message snapshot and appends one
// `[subagent task]` brief, so its first request is a byte-level EXTENSION of
// the parent's last request. All byte-prefix assertions go through the one
// canonical serializer exported by @wudao-org/providers (core test-only
// devDependency). The default (isolated) subagent semantics are unchanged.
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serializePrompt } from "../src/index.js";
import { runAgentLoop } from "@wudao-org/core";
import { createReadFileTool } from "@wudao-org/core";
import { createTaskTool } from "@wudao-org/core";
import { BUILTIN_SUBAGENT_TYPES, runSubagent } from "@wudao-org/core";
import { createScriptedModel } from "@wudao-org/core";
import type { LoopEvent, Terminal } from "@wudao-org/core";
import type { ModelClient, ModelInput } from "@wudao-org/core";
import type { AgentMessage, AgentState } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample.txt");

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

type Turn = { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] };

/** Shared scripted model for parent AND child loops; snapshots every input. */
function sharedModel(responses: readonly Turn[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const response = responses[i];
      i += 1;
      if (!response) throw new Error(`scripted responses exhausted (call ${inputs.length})`);
      return response;
    },
  };
}

const taskCall = (id: string, args: Record<string, unknown>): Turn => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "task", arguments: args }],
});

function parentLoopFixture(model: ModelClient, forkWired: boolean) {
  const parentState: AgentState = {
    systemPrompt: "PARENT-SYSTEM-PROMPT",
    messages: [{ role: "user", content: "explore, delegate, report" }],
    tools: [createReadFileTool(), createTaskTool({
      model,
      allTools: [createReadFileTool()],
      loopOptions: { maxTurns: 20 },
      ...(forkWired ? { getForkContext: () => parentState } : {}),
    })],
    status: "idle",
  };
  return parentState;
}

describe("fork subagents (B2, shareContext)", () => {
  it("the child's first request is a byte-level extension of the parent's last request", async () => {
    const model = sharedModel([
      taskCall("t1", { description: "verify", prompt: "check the fixture", shareContext: true }),
      { role: "assistant", content: "fork answer" },
      { role: "assistant", content: "parent done" },
    ]);
    const parentState = parentLoopFixture(model, true);
    const { terminal } = await drain(runAgentLoop(parentState, model, { maxTurns: 5 }));
    expect(terminal.reason).toBe("completed");

    // generate() order: [parent R0, fork child C0, parent R1].
    expect(model.inputs).toHaveLength(3);
    const [r0, c0] = model.inputs as const;
    // THE property: the parent's request serialization is a byte PREFIX of
    // the fork child's — the shared segment rides the parent's paid cache.
    const parentBytes = serializePrompt(r0);
    const childBytes = serializePrompt(c0);
    expect(childBytes.startsWith(parentBytes)).toBe(true);
    expect(childBytes.length).toBeGreaterThan(parentBytes.length);
    // The only increment: the parent's exact messages + one [subagent task] brief.
    expect(c0.systemPrompt).toBe(r0.systemPrompt);
    expect(c0.tools.map((t) => t.name)).toEqual(r0.tools.map((t) => t.name));
    expect(c0.messages.slice(0, -1)).toEqual(r0.messages);
    const brief = c0.messages.at(-1);
    expect(brief?.role).toBe("user");
    expect(brief?.content).toBe("[subagent task] check the fixture");
    // The dangling assistant task-call is NOT replayed (provider-legal tail).
    expect(c0.messages.some((m) => m.role === "assistant" && m.toolCalls?.length)).toBe(false);
  });

  it("the trailing unanswered assistant call is trimmed; an ANSWERED pair is kept", async () => {
    // Parent history where an earlier tool round already completed: the fork
    // replay keeps the answered pair verbatim (still a byte prefix).
    const model = sharedModel([
      taskCall("t1", { description: "verify", prompt: "go", shareContext: true }),
      { role: "assistant", content: "fork answer" },
      { role: "assistant", content: "parent done" },
    ]);
    const parentState = parentLoopFixture(model, true);
    // Pre-seed a completed tool round before the run.
    parentState.messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "", toolCalls: [{ id: "c9", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "tool", toolCallId: "c9", name: "read_file", content: "file body" },
      { role: "user", content: "explore, delegate, report" },
    ];
    await drain(runAgentLoop(parentState, model, { maxTurns: 5 }));
    const [r0, c0] = model.inputs as const;
    expect(serializePrompt(c0).startsWith(serializePrompt(r0))).toBe(true);
    expect(c0.messages[1]?.role).toBe("assistant");
    expect(c0.messages[2]?.role).toBe("tool");
  });

  it("nested task calls refuse inside a fork (recursion guard, byte-identical header)", async () => {
    const model = sharedModel([
      taskCall("t1", { description: "verify", prompt: "go", shareContext: true }),
      // The fork child tries to nest a task call…
      taskCall("t2", { description: "nested", prompt: "nested", shareContext: true }),
      { role: "assistant", content: "fork answer" },
      { role: "assistant", content: "parent done" },
    ]);
    const parentState = parentLoopFixture(model, true);
    const subagentEvents: LoopEvent[] = [];
    // Rebuild the task tool so we can observe the child's events.
    parentState.tools = [createReadFileTool(), createTaskTool({
      model,
      allTools: [createReadFileTool()],
      loopOptions: { maxTurns: 20 },
      getForkContext: () => parentState,
      onSubagentEvent: (e) => subagentEvents.push(e),
    })];
    const { terminal } = await drain(runAgentLoop(parentState, model, { maxTurns: 5 }));
    expect(terminal.reason).toBe("completed");
    // Exactly 4 model calls: parent, child(task attempt), child(final), parent.
    expect(model.inputs).toHaveLength(4);
    // The child's task call refused — an error result, no nested loop.
    const nested = subagentEvents.filter(
      (e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished",
    );
    const refusal = nested.find((e) => e.isError);
    expect(refusal).toBeDefined();
    // The refusal is a byte-identical header: the child's tool array (with the
    // inert task clone) still matches the parent's request tools exactly.
    expect(model.inputs[1]?.tools.map((t) => t.name)).toEqual(model.inputs[0]?.tools.map((t) => t.name));
  });

  it("fork without an exposed parent conversation fails with a clear error", async () => {
    const model = sharedModel([
      taskCall("t1", { description: "verify", prompt: "go", shareContext: true }),
      { role: "assistant", content: "parent done" },
    ]);
    const parentState = parentLoopFixture(model, false); // no getForkContext wired
    const { events } = await drain(runAgentLoop(parentState, model, { maxTurns: 5 }));
    const finished = events.find((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(finished?.isError).toBe(true);
    expect(finished?.result).toContain("requires the caller to expose the parent conversation");
  });

  it("default subagents stay isolated (no prefix sharing, own system prompt)", async () => {
    const model = sharedModel([
      taskCall("t1", { description: "verify", prompt: "isolated brief" }),
      { role: "assistant", content: "isolated answer" },
      { role: "assistant", content: "parent done" },
    ]);
    const parentState = parentLoopFixture(model, true); // fork wired, but NOT requested
    await drain(runAgentLoop(parentState, model, { maxTurns: 5 }));
    expect(model.inputs).toHaveLength(3);
    const [r0, c0] = model.inputs as const;
    expect(serializePrompt(c0).startsWith(serializePrompt(r0))).toBe(false);
    expect(c0.systemPrompt).not.toBe(r0.systemPrompt);
    expect(c0.messages).toEqual([{ role: "user", content: "isolated brief" }]);
    // Isolated child: only the type's read tools that exist in allTools.
    expect(c0.tools.map((t) => t.name)).toEqual(["read_file"]);
  });
});

describe("runSubagent forkFrom", () => {
  it("runs the fork branch directly with the given snapshot", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "direct fork answer" }]);
    const tools = [createReadFileTool()];
    const messages: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const answer = await runSubagent({
      model,
      allTools: tools,
      subagentType: BUILTIN_SUBAGENT_TYPES["fork"]!,
      prompt: "direct brief",
      loopOptions: { maxTurns: 20 },
      forkFrom: { systemPrompt: "FORK-SYS", tools, messages },
    });
    expect(answer).toBe("direct fork answer");
  });
});
