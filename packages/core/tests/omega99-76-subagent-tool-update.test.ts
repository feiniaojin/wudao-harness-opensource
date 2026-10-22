// ω99-76 — runSubagent 转发 onToolUpdate：63 的 run 级 sink 到子 agent 的
// 最后一段消费链。核心不变量：(1) 子 delta 抵达父 sink 时 callId 带子身份
// 命名空间 `sub:<child>:<rawId>`（父与子是两个独立请求，provider 各自从
// call_0 编号——裸转发必撞键；命名空间让撞名结构性不可能）；(2) toolName
// 保持子工具真实名；(3) 缺席 onToolUpdate ⇒ 行为不变（直接调用方零感知）。
// Deterministic acceptance: scripted models, zero network, zero real processes.
import { describe, it, expect } from "vitest";
import { runSubagent } from "../src/subagent.js";
import { runAgentLoop, type Terminal } from "../src/loop.js";
import { buildTool } from "../src/tool.js";
import type { Tool, OutputDelta } from "../src/tool.js";
import { createScriptedModel } from "../src/model-client.js";
import type { SubagentType } from "../src/subagent.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";
import type { IdentifiedOutputDelta } from "../src/tool.js";

async function drain(gen: AsyncGenerator<unknown, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
}

// A streaming test tool: fires append/append/snapshot deltas (unique marker
// bytes) through the injected onUpdate, then settles (the ω99-63 shape).
function streamingTool(name: string, marker: string, parallel = false): Tool {
  return buildTool({
    name,
    description: `streams ${marker}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    ...(parallel ? { isConcurrencySafe: () => true } : {}),
    async execute(_args: Record<string, unknown>, onUpdate?: (delta: OutputDelta) => void) {
      onUpdate?.({ kind: "append", text: `${marker}-a` });
      onUpdate?.({ kind: "append", text: `${marker}-b` });
      onUpdate?.({ kind: "snapshot", text: `${marker}-final`, droppedHeadBytes: 4 });
      return { content: `${marker} result` };
    },
  });
}

const CHILD_TYPE: SubagentType = {
  name: "stream-probe",
  description: "streams once",
  systemPrompt: "s",
  toolNames: ["stream_probe"],
};

const CHILD_TOOL_TURN: AssistantMessage = {
  role: "assistant",
  content: "",
  toolCalls: [{ id: "call_0", name: "stream_probe", arguments: {} }],
};

describe("ω99-76 runSubagent forwards onToolUpdate", () => {
  it("forwards the child's identified deltas to the parent sink with a child-namespaced callId and the real toolName", async () => {
    const seen: IdentifiedOutputDelta[] = [];
    const model = createScriptedModel([
      CHILD_TOOL_TURN,
      { role: "assistant", content: "child done" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: [streamingTool("stream_probe", "KID")],
      subagentType: CHILD_TYPE,
      prompt: "stream",
      loopOptions: { maxTurns: 5, onToolUpdate: (d) => { seen.push(d); } },
    });
    expect(answer).toContain("child done");
    // RED on base: the rebuilt loopOptions literal drops onToolUpdate — the
    // sink receives NOTHING (0 deltas, not 3).
    expect(seen.length).toBe(3);
    expect(seen.every((d) => /^sub:.+:call_0$/.test(d.toolCallId))).toBe(true);
    expect(seen.every((d) => d.toolName === "stream_probe")).toBe(true);
    expect(seen.map((d) => d.text)).toEqual(["KID-a", "KID-b", "KID-final"]);
    expect(seen[2]).toMatchObject({ kind: "snapshot", droppedHeadBytes: 4 });
  });

  it("collision proof: parent and child streaming the SAME raw callId concurrently land in one sink as DISTINCT ids", async () => {
    const seen: IdentifiedOutputDelta[] = [];
    const sink = (d: IdentifiedOutputDelta): void => { seen.push(d); };
    // The child model (inside the spawner tool): raw id call_0.
    const childModel = createScriptedModel([
      CHILD_TOOL_TURN,
      { role: "assistant", content: "child done" },
    ]);
    // A tool whose execution runs the child — the task-tool spawn shape.
    const spawner = buildTool({
      name: "spawn_kid",
      description: "runs the child",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      async execute() {
        const answer = await runSubagent({
          model: childModel,
          allTools: [streamingTool("stream_probe", "KID")],
          subagentType: CHILD_TYPE,
          prompt: "stream",
          loopOptions: { maxTurns: 5, onToolUpdate: sink },
        });
        return { content: answer };
      },
    });
    // The parent loop: one fan-out turn — its OWN streamer (raw id call_0,
    // identical to the child's) beside the spawner, both concurrency-safe.
    const parentModel = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_0", name: "parent_stream", arguments: {} },
          { id: "p2", name: "spawn_kid", arguments: {} },
        ],
      },
      { role: "assistant", content: "parent done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [streamingTool("parent_stream", "PAR", true), spawner],
      status: "running" as const,
    };
    const terminal = await drain(runAgentLoop(state, parentModel, {
      maxTurns: 4,
      onToolUpdate: sink,
    }));
    expect(terminal.reason).toBe("completed");
    // RED on base: only the parent's bare call_0 arrives — the Set has ONE
    // id, the child's namespaced twin never lands.
    const ids = [...new Set(seen.map((d) => d.toolCallId))];
    expect(ids.length).toBe(2);
    expect(ids).toContain("call_0"); // the parent's own — bare, un-namespaced
    const namespaced = ids.find((i) => i !== "call_0");
    expect(namespaced).toMatch(/^sub:.+:call_0$/); // same raw id, distinct key
    // 3 deltas per emitter, each attributed to its real tool name.
    expect(seen.filter((d) => d.toolCallId === "call_0").every((d) => d.toolName === "parent_stream")).toBe(true);
    expect(seen.filter((d) => d.toolCallId === namespaced).every((d) => d.toolName === "stream_probe")).toBe(true);
    expect(seen.length).toBe(6);
  });

  it("absence pin: without onToolUpdate the child run behaves exactly as before (streams settle, answer intact)", async () => {
    const model = createScriptedModel([
      CHILD_TOOL_TURN,
      { role: "assistant", content: "child done" },
    ]);
    const events: string[] = [];
    const answer = await runSubagent({
      model,
      allTools: [streamingTool("stream_probe", "KID")],
      subagentType: CHILD_TYPE,
      prompt: "stream",
      loopOptions: { maxTurns: 5 },
      onEvent: (e) => events.push(e.type),
    });
    expect(answer).toContain("child done");
    expect(events).toContain("turn_started");
    expect(events).toContain("tool_call_finished");
  });
});
