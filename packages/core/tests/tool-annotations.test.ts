// M51 §3 — Tool interface extensions: the annotation matrix (fail-closed
// defaults, builtin markings), outputSchema (buildTool validation + loop
// application), and the interruptBehavior block path.
import { describe, it, expect } from "vitest";
import { buildTool, runAgentLoop, type AgentState, type AssistantMessage, type ModelClient, type ModelInput, type Tool } from "../src/index.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";
import { createShellTool, commandLooksDestructive } from "../src/tools/shell.js";

describe("annotation defaults (fail-closed)", () => {
  it("a stub tool reads risky to auditors: isDestructive/isOpenWorld true, interruptBehavior cancel", () => {
    const t = buildTool({
      name: "stub",
      description: "d",
      parameters: { type: "object", properties: {} },
      async execute() { return { content: "ok" }; },
    });
    expect(t.isDestructive?.({})).toBe(true);
    expect(t.isOpenWorld?.({})).toBe(true);
    expect(t.interruptBehavior).toBe("cancel");
  });
});

describe("builtin markings", () => {
  it("write_file/edit are destructive, closed-world", () => {
    const root = process.cwd();
    for (const t of [createWriteFileTool({ workspaceRoot: root }), createEditTool({ workspaceRoot: root })]) {
      expect(t.isDestructive?.({})).toBe(true);
      expect(t.isOpenWorld?.({})).toBe(false);
      expect(t.interruptBehavior).toBe("cancel");
    }
  });

  it("shell: isDestructive depends on the command; open-world (a shell can reach the network)", () => {
    const t = createShellTool({ workspaceRoot: process.cwd() });
    expect(t.isOpenWorld?.({})).toBe(true);
    expect(t.isDestructive?.({ command: "rm -rf build" })).toBe(true);
    expect(t.isDestructive?.({ command: "git push --force origin main" })).toBe(true);
    expect(t.isDestructive?.({ command: "git reset --hard HEAD~3" })).toBe(true);
    expect(t.isDestructive?.({ command: "ls -la" })).toBe(false);
    expect(t.isDestructive?.({ command: "echo rm" })).toBe(false);
    expect(commandLooksDestructive("cat foo; rm bar")).toBe(true);
    expect(commandLooksDestructive("cat foo")).toBe(false);
  });
});

describe("outputSchema", () => {
  const schema = {
    type: "object" as const,
    required: ["status"],
    properties: { status: { type: "string" as const, enum: ["ok", "error"] } },
  };

  it("buildTool rejects malformed schemas loudly (dev-time)", () => {
    expect(() => buildTool({
      name: "bad", description: "d", parameters: { type: "object", properties: {} },
      // @ts-expect-error deliberate malformation
      outputSchema: { type: "strung" },
      async execute() { return { content: "{}" }; },
    })).toThrow(/outputSchema/);
    expect(() => buildTool({
      name: "bad2", description: "d", parameters: { type: "object", properties: {} },
      // @ts-expect-error deliberate malformation
      outputSchema: { required: 3 },
      async execute() { return { content: "{}" }; },
    })).toThrow(/outputSchema/);
  });

  function scriptModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
    const inputs: ModelInput[] = [];
    let i = 0;
    return {
      inputs,
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        const r = responses[i];
        i += 1;
        return r ?? { role: "assistant", content: "(done)" };
      },
    };
  }

  async function runWithResult(tool: Tool, resultContent: string): Promise<{ isError: boolean | undefined; content: string }> {
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      status: "idle",
    };
    const model = scriptModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: tool.name, arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    let finished: { isError: boolean; result: string } | undefined;
    for await (const ev of runAgentLoop(state, model, { maxTurns: 3 })) {
      if (ev.type === "tool_call_finished") finished = { isError: ev.isError, result: ev.result };
    }
    return { isError: finished?.isError, content: finished?.result ?? "" };
  }

  it("a conforming JSON result passes untouched", async () => {
    const tool = buildTool({
      name: "t1", description: "d", parameters: { type: "object", properties: {} },
      outputSchema: schema,
      async execute() { return { content: '{"status":"ok"}' }; },
    });
    const r = await runWithResult(tool, "");
    expect(r.isError).not.toBe(true);
    expect(r.content).toBe('{"status":"ok"}');
  });

  it("a violating result becomes isError with the annotation line", async () => {
    const tool = buildTool({
      name: "t2", description: "d", parameters: { type: "object", properties: {} },
      outputSchema: schema,
      async execute() { return { content: '{"status":"weird"}' }; },
    });
    const r = await runWithResult(tool, "");
    expect(r.isError).toBe(true);
    expect(r.content).toContain('{"status":"weird"}');
    expect(r.content).toContain("[output schema violation:");
    expect(r.content).toContain("enum");
  });

  it("non-JSON from a schema-declared tool is the error path", async () => {
    const tool = buildTool({
      name: "t3", description: "d", parameters: { type: "object", properties: {} },
      outputSchema: schema,
      async execute() { return { content: "plain text" }; },
    });
    const r = await runWithResult(tool, "");
    expect(r.isError).toBe(true);
    expect(r.content).toContain("[output schema violation:");
  });

  it("already-error results skip the check (no double marking)", async () => {
    const tool = buildTool({
      name: "t4", description: "d", parameters: { type: "object", properties: {} },
      outputSchema: schema,
      async execute() { return { content: "boom", isError: true }; },
    });
    const r = await runWithResult(tool, "");
    expect(r.isError).toBe(true);
    expect(r.content).not.toContain("[output schema violation:");
  });
});

describe("interruptBehavior block (loop)", () => {
  it("a block tool is NOT raced against the abort signal: it completes and its result lands", async () => {
    const ac = new AbortController();
    let settled = false;
    const tool = buildTool({
      name: "slowbutcritical",
      description: "d",
      parameters: { type: "object", properties: {} },
      interruptBehavior: "block",
      async execute() {
        await new Promise((r) => setTimeout(r, 60));
        settled = true;
        return { content: "finished" };
      },
    });
    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [tool],
      status: "idle",
    };
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.messages.at(-1)?.role === "user") {
          // abort WHILE the tool is in flight
          setTimeout(() => ac.abort(), 10);
          return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: tool.name, arguments: {} }] };
        }
        return { role: "assistant", content: "unreached" };
      },
    };
    let sawResult: string | undefined;
    const gen = runAgentLoop(state, model, { maxTurns: 3, signal: ac.signal });
    let terminal: { reason: string } | undefined;
    for (;;) {
      const r = await gen.next();
      if (r.done) { terminal = r.value; break; }
      if (r.value.type === "tool_call_finished") sawResult = r.value.result;
    }
    expect(settled).toBe(true);
    expect(sawResult).toBe("finished");
    // the tool result message is present in state (not orphaned away)
    expect(state.messages.some((m) => m.role === "tool" && m.content === "finished")).toBe(true);
    expect(terminal?.reason).toBe("aborted");
  });

  it("concurrent allSafe batch: a block tool's result lands even when signal aborted mid-batch", async () => {
    const ac = new AbortController();
    let blockToolSettled = false;
    let normalToolSettled = false;

    // Both tools marked concurrencySafe to trigger the concurrent batch path
    // Normal tool is fast (10ms) so it completes before abort
    // Block tool is slow (60ms) so it's still running when abort hits
    const blockTool = buildTool({
      name: "block_tool",
      description: "d",
      parameters: { type: "object", properties: {} },
      interruptBehavior: "block",
      isConcurrencySafe: () => true,
      async execute() {
        await new Promise((r) => setTimeout(r, 60));
        blockToolSettled = true;
        return { content: "block_result" };
      },
    });

    const normalTool = buildTool({
      name: "normal_tool",
      description: "d",
      parameters: { type: "object", properties: {} },
      interruptBehavior: "cancel",
      isConcurrencySafe: () => true,
      async execute() {
        await new Promise((r) => setTimeout(r, 10));
        normalToolSettled = true;
        return { content: "normal_result" };
      },
    });

    const state: AgentState = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [blockTool, normalTool],
      status: "idle",
    };

    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        if (input.messages.at(-1)?.role === "user") {
          // abort AFTER normal tool completes but BEFORE block tool completes
          setTimeout(() => ac.abort(), 30);
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "c1", name: blockTool.name, arguments: {} },
              { id: "c2", name: normalTool.name, arguments: {} },
            ],
          };
        }
        return { role: "assistant", content: "unreached" };
      },
    };

    const gen = runAgentLoop(state, model, { maxTurns: 3, signal: ac.signal });
    let terminal: { reason: string } | undefined;
    const finishedCallIds: string[] = [];

    for (;;) {
      const r = await gen.next();
      if (r.done) { terminal = r.value; break; }
      if (r.value.type === "tool_call_finished") {
        finishedCallIds.push(r.value.toolCallId);
      }
    }

    // Both tools should complete
    expect(blockToolSettled).toBe(true);
    expect(normalToolSettled).toBe(true);

    // The block tool's result message MUST be in state.messages even though abort occurred
    expect(state.messages.some((m) => m.role === "tool" && m.content === "block_result")).toBe(true);

    // The run should still end in abort
    expect(terminal?.reason).toBe("aborted");

    // We should have seen the block tool's finished event (c1 is the block tool's call ID)
    expect(finishedCallIds).toContain("c1");
  });
});
