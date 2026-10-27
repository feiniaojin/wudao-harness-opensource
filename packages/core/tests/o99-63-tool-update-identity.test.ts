// ω99-63 — onToolUpdate 消费端接线的核心不变量：identity 是 loop 级不变量。
// 唯一 executeToolCall 点统一 enrich —— 所有工具、所有调用者免费获得
// toolCallId/toolName（ω99-49 报告点名的"delta 与 call 关联缺失"就此闭合）。
// Deterministic acceptance: scripted model, zero network, zero real processes.
import { describe, it, expect } from "vitest";
import { runAgentLoop, type Terminal } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentMessage, ModelClient, ModelInput } from "../src/types.js";
import type { IdentifiedOutputDelta, OutputDelta } from "../src/tool.js";

// A scripted model that RECORDS every ModelInput (the M24 face — deltas must
// never leak into it).
function recording(responses: readonly import("../src/types.js").AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<unknown, Terminal>): Promise<Terminal> {
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return value;
  }
}

const mkState = (tools: readonly unknown[]) => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" } as AgentMessage],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: tools as any,
  status: "idle" as const,
});

// A streaming test tool: fires append/append/snapshot deltas (unique marker
// bytes) through the injected onUpdate, then settles.
function streamingTool(name: string, marker: string, parallel: boolean) {
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

describe("ω99-63 identified onUpdate (core invariant)", () => {
  it("a fan-out turn's single consumer receives per-call deltas with the correct toolCallId/toolName", async () => {
    const seen: IdentifiedOutputDelta[] = [];
    const model = recording([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "alpha-1", name: "fan_a", arguments: {} },
          { id: "beta-2", name: "fan_b", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = mkState([streamingTool("fan_a", "ALPHA", true), streamingTool("fan_b", "BETA", true)]);
    const terminal = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      onToolUpdate: (d) => { seen.push(d); },
    }));
    expect(terminal.reason).toBe("completed");
    expect(seen.length).toBe(6); // 3 deltas × 2 calls, all routed to ONE consumer
    const alpha = seen.filter((d) => d.toolCallId === "alpha-1");
    const beta = seen.filter((d) => d.toolCallId === "beta-2");
    expect(alpha.length).toBe(3);
    expect(beta.length).toBe(3);
    expect(alpha.every((d) => d.toolName === "fan_a")).toBe(true);
    expect(beta.every((d) => d.toolName === "fan_b")).toBe(true);
    expect(alpha.map((d) => d.text)).toEqual(["ALPHA-a", "ALPHA-b", "ALPHA-final"]);
    expect(alpha[2]).toMatchObject({ kind: "snapshot", droppedHeadBytes: 4 });
  });

  it("the sequential path enriches identically (per-call id + name)", async () => {
    const seen: IdentifiedOutputDelta[] = [];
    const model = recording([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "seq-1", name: "step_one", arguments: {} },
          { id: "seq-2", name: "step_two", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = mkState([streamingTool("step_one", "ONE", false), streamingTool("step_two", "TWO", false)]);
    const terminal = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      onToolUpdate: (d) => { seen.push(d); },
    }));
    expect(terminal.reason).toBe("completed");
    expect(seen.filter((d) => d.toolCallId === "seq-1" && d.toolName === "step_one").length).toBe(3);
    expect(seen.filter((d) => d.toolCallId === "seq-2" && d.toolName === "step_two").length).toBe(3);
  });

  it("deltas never enter history, JSONL, or the model-visible face (M24)", async () => {
    const seen: IdentifiedOutputDelta[] = [];
    const model = recording([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "leak-1", name: "fan_a", arguments: {} }],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = mkState([streamingTool("fan_a", "LEAK", true)]);
    const terminal = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      onToolUpdate: (d) => { seen.push(d); },
    }));
    expect(terminal.reason).toBe("completed");
    expect(seen.length).toBe(3);
    const history = JSON.stringify(state.messages);
    expect(history).not.toContain("LEAK-a");
    expect(history).not.toContain("LEAK-b");
    expect(history).not.toContain("LEAK-final");
    const face = JSON.stringify(model.inputs);
    expect(face).not.toContain("LEAK-a");
    expect(face).not.toContain("LEAK-b");
    expect(face).not.toContain("LEAK-final");
  });
});
