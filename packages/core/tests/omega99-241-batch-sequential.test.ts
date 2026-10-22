// ω99-241: #9 — core 批执行钉（brief 面一：核实 + 钉）。调研断言 core 已支
// 持一轮多 tool_use：全 isConcurrencySafe 才 Promise.all，否则顺序执行。本件
// 把它钉死在非并发安全工具（computer 八工具的语义面）上：一轮吐 3 个
// tool_use → **顺序**执行（前一个 settle 后一个才 start）、每个 call 过权限
// 门（gate 先于执行、逐 call 独立）、收据齐（3 条 tool 消息按 call 序配对）。
// 全 mock：scripted model + 内存工具，零盘写零真派生。
import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal, type PermissionDecision } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

// Drive the generator manually to capture its Terminal return value.
async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
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

/** 非并发安全（isConcurrencySafe:false——buildTool fail-closed 默认即此）、带
 *  可观测时序的哑工具：start/settle 各记一行，异步 settle 制造「若误并发必
 *  可检出交错」的窗口。 */
function sequentialProbeTool(name: string, log: string[], settleMs = 5) {
  return buildTool({
    name,
    description: `probe ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      log.push(`start:${name}`);
      await new Promise((r) => setTimeout(r, settleMs));
      log.push(`end:${name}`);
      return { content: `done ${name}` };
    },
  });
}

describe("ω99-241 — multi tool_use batch of NON-concurrency-safe tools", () => {
  it("sequential execution: one turn, 3 calls → strict order, no interleaving", async () => {
    const log: string[] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "c1", name: "act_a", arguments: {} },
          { id: "c2", name: "act_b", arguments: {} },
          { id: "c3", name: "act_c", arguments: {} },
        ],
      },
      { role: "assistant", content: "all done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [sequentialProbeTool("act_a", log), sequentialProbeTool("act_b", log), sequentialProbeTool("act_c", log)],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    expect(terminal.reason).toBe("completed");
    // 钉死顺序语义：a 完全 settle 后 b 才 start（误并发会看到 start×3 在前）。
    expect(log).toEqual(["start:act_a", "end:act_a", "start:act_b", "end:act_b", "start:act_c", "end:act_c"]);
    // 收据齐：3 条 tool 消息按 call 序配对
    const toolMsgs = state.messages.filter(mIsTool);
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    for (const m of toolMsgs) expect(m.isError).toBeFalsy();
  });

  it("permission gate per call: gate→execute strictly interleaved, each call gated exactly once", async () => {
    const log: string[] = [];
    const gate: string[] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "k1", name: "act_a", arguments: {} },
          { id: "k2", name: "act_b", arguments: {} },
          { id: "k3", name: "act_c", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [sequentialProbeTool("act_a", log), sequentialProbeTool("act_b", log), sequentialProbeTool("act_c", log)],
      status: "idle" as const,
    };
    const canUseTool = async (name: string): Promise<PermissionDecision> => {
      log.push(`gate:${name}`);
      gate.push(name);
      return { behavior: "allow" };
    };
    await drain(runAgentLoop(state, model, { maxTurns: 5, canUseTool }));
    // gate 先于每个执行（gate→start→end 逐 call 严格交替）
    expect(log).toEqual([
      "gate:act_a", "start:act_a", "end:act_a",
      "gate:act_b", "start:act_b", "end:act_b",
      "gate:act_c", "start:act_c", "end:act_c",
    ]);
    expect(gate).toEqual(["act_a", "act_b", "act_c"]);
  });

  it("deny mid-batch: the denied call lands its deny receipt, the tail still executes (per-call gates)", async () => {
    const log: string[] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "d1", name: "act_a", arguments: {} },
          { id: "d2", name: "act_b", arguments: {} },
          { id: "d3", name: "act_c", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [sequentialProbeTool("act_a", log), sequentialProbeTool("act_b", log), sequentialProbeTool("act_c", log)],
      status: "idle" as const,
    };
    const canUseTool = (name: string): PermissionDecision =>
      name === "act_b" ? { behavior: "deny", reason: "not allowed" } : { behavior: "allow" };
    await drain(runAgentLoop(state, model, { maxTurns: 5, canUseTool }));
    // act_b 被拒零执行；act_c 照跑（每个 call 独立过门）
    expect(log).toEqual(["start:act_a", "end:act_a", "start:act_c", "end:act_c"]);
    const toolMsgs = state.messages.filter(mIsTool);
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["d1", "d2", "d3"]);
    expect(toolMsgs[0]!.isError).toBeFalsy();
    expect(toolMsgs[1]!.isError).toBe(true);
    expect(toolMsgs[1]!.content).toContain("permission denied");
    expect(toolMsgs[2]!.isError).toBeFalsy();
  });

  it("control: ALL-safe tools in one batch DO run concurrently (the fan-out branch is the other half of the law)", async () => {
    const log: string[] = [];
    const concurrentProbe = (name: string) =>
      buildTool({
        name,
        description: `safe ${name}`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
        isConcurrencySafe: () => true,
        async execute() {
          log.push(`start:${name}`);
          await new Promise((r) => setTimeout(r, 5));
          log.push(`end:${name}`);
          return { content: `done ${name}` };
        },
      });
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "p1", name: "rd_a", arguments: {} },
          { id: "p2", name: "rd_b", arguments: {} },
          { id: "p3", name: "rd_c", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [concurrentProbe("rd_a"), concurrentProbe("rd_b"), concurrentProbe("rd_c")],
      status: "idle" as const,
    };
    await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    // 三个 start 都在任何 end 之前 = 真并发（与顺序钉互为对照）
    const starts = log.filter((l) => l.startsWith("start:"));
    expect(starts).toEqual(["start:rd_a", "start:rd_b", "start:rd_c"]);
    expect(log.indexOf("end:rd_a")).toBeGreaterThan(log.indexOf("start:rd_c"));
    // 收据仍按 call 序落账（fan-out 的消息序钉）
    const toolMsgs = state.messages.filter(mIsTool);
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["p1", "p2", "p3"]);
  });
});
