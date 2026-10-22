import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel, type ModelClient } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// 夜移 002（2026-08-28 night porting，the upstream formatguard/timeout-policy，设计加强）：
// Tool 可声明 timeoutMs —— executor 对调用做兜底竞速，超时返回结构化
// [timeout after Nms] 错误结果（底层 promise 不取消，弃结果不断进程）。
// fail-open：缺省 = 无限等待（既有行为）；interruptBehavior:"block" 工具
// 豁免（"运行必须等它 settle" 是更强的契约，提前弃等破坏它）。

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

function mIsTool(m: AgentMessage): m is Extract<AgentMessage, { role: "tool" }> {
  return m.role === "tool";
}

const hangTool = (timeoutMs: number | undefined, extra: { block?: boolean } = {}) =>
  buildTool({
    name: "hang",
    description: "hangs forever",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: () => new Promise<{ content: string }>(() => {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(extra.block ? { interruptBehavior: "block" as const } : {}),
  });

describe("generic tool timeout (夜移 002)", () => {
  it("a tool exceeding timeoutMs gets a structured timeout error result and the run completes", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "hang", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [hangTool(30)],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("recovered");
    const toolMsg = state.messages.find(mIsTool);
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.isError).toBe(true);
    expect(toolMsg?.content).toContain("[timeout after 30ms]");
    // The abandoned call is named for the model's next-round recovery.
    expect(toolMsg?.name).toBe("hang");
  });

  it("a tool finishing inside timeoutMs returns its real result", async () => {
    const slowButOk = buildTool({
      name: "slowok",
      description: "finishes in time",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return { content: "REAL" };
      },
      timeoutMs: 2_000,
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "slowok", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [slowButOk],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(state.messages.find(mIsTool)?.content).toBe("REAL");
    expect(state.messages.find(mIsTool)?.isError).toBeFalsy();
  });

  it("interruptBehavior:block tools are exempt — the run waits past timeoutMs for the real result", async () => {
    const blocky = buildTool({
      name: "blocky",
      description: "uninterruptible, slow",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        await new Promise((r) => setTimeout(r, 60));
        return { content: "BLOCK-REAL" };
      },
      timeoutMs: 20,
      interruptBehavior: "block",
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "blocky", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [blocky],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    expect(state.messages.find(mIsTool)?.content).toBe("BLOCK-REAL");
    expect(state.messages.find(mIsTool)?.isError).toBeFalsy();
  });

  it("a normal tool error keeps its own message (timeout machinery stays out of the way)", async () => {
    const boomer = buildTool({
      name: "boomer",
      description: "throws",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        throw new Error("boom");
      },
      timeoutMs: 5_000,
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "boomer", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }] as AgentMessage[],
      tools: [boomer],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));

    expect(terminal.reason).toBe("completed");
    const toolMsg = state.messages.find(mIsTool);
    expect(toolMsg?.isError).toBe(true);
    expect(toolMsg?.content).toContain("boom");
    expect(toolMsg?.content).not.toContain("timeout");
  });
});
