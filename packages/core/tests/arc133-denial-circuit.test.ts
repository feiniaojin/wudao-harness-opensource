// 133 #6（the upstream projectce 引进）— Guardian 父链通知收据：否决墙判定
// （failure_streak/identical_calls 全 denied → verdict.denialCircuit）、
// 强制中止 Terminal 带旗、SubagentRunInfo 终因、Task 工具的行为契约通知
// （"用户确认前禁止恢复"）。
import { describe, expect, it } from "vitest";
import { detectLoop, type LoopSafetyTurn } from "../src/loop-safety.js";
import { runAgentLoop, STOP_BLOCK_CAP } from "../src/index.js";
import { createTaskTool, subagentDenialNotice, SUBAGENT_DENIAL_CONTRACT_PREFIX } from "../src/tools/task.js";
import { buildTool } from "../src/tool.js";
import type { ModelClient, ModelStreamEvent, AgentState, ModelInput, LoopEvent, Terminal } from "../src/index.js";

const deniedCall = (name: string, args: Record<string, unknown>) => ({ name, args, isError: true, denied: true as const });
const failedCall = (name: string, args: Record<string, unknown>) => ({ name, args, isError: true });

describe("133 #6 — 否决墙判定（loop-safety 纯层）", () => {
  it("failure_streak：连续 4 次权限拒（args 变化）→ verdict.denialCircuit", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [deniedCall("shell", { cmd: "a1" })] },
      { calls: [deniedCall("shell", { cmd: "a2" })] },
      { calls: [deniedCall("shell", { cmd: "a3" })] },
      { calls: [deniedCall("shell", { cmd: "a4" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("failure_streak");
    expect(v.denialCircuit).toBe(true);
  });

  it("混合失败（真执行失败掺权限拒）→ 无旗（不是否决墙）", () => {
    const turns: LoopSafetyTurn[] = [
      { calls: [failedCall("shell", { cmd: "a1" })] },
      { calls: [deniedCall("shell", { cmd: "a2" })] },
      { calls: [failedCall("shell", { cmd: "a3" })] },
      { calls: [deniedCall("shell", { cmd: "a4" })] },
    ];
    const v = detectLoop(turns)!;
    expect(v.kind).toBe("failure_streak");
    expect(v.denialCircuit).toBeUndefined();
  });

  it("identical_calls：同指纹全是权限拒 → 有旗；掺真失败 → 无旗", () => {
    const d = deniedCall("edit", { path: "f" });
    const all = Array.from({ length: 3 }, () => ({ calls: [d] }));
    expect(detectLoop(all)!.denialCircuit).toBe(true);
    const mixed: LoopSafetyTurn[] = [
      { calls: [deniedCall("edit", { path: "f" })] },
      { calls: [deniedCall("edit", { path: "f" })] },
      { calls: [failedCall("edit", { path: "f" })] },
    ];
    expect(detectLoop(mixed)!.denialCircuit).toBeUndefined();
  });
});

/** A model that always calls the denied tool; the gate denies EVERY call. */
function denialWallModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async *stream(input) {
      inputs.push(input);
      yield { type: "text_delta", text: "trying" } as ModelStreamEvent;
      yield {
        type: "done",
        message: {
          role: "assistant",
          content: "trying",
          toolCalls: [{ id: `c-${inputs.length}`, name: "run_command", arguments: { command: `echo ${inputs.length}` } }],
        },
      } as ModelStreamEvent;
    },
  } as never;
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>) {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const shellTool = () =>
  buildTool({
    name: "run_command",
    description: "stub",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      return { content: "ran" };
    },
  });

describe("133 #6 — loop 集成：否决墙 → 强制中止带旗", () => {
  it("连续否决到二裁 → aborted + denialCircuit（终因可查）", async () => {
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const { terminal } = await drain(
      runAgentLoop(state, denialWallModel(), {
        maxTurns: 30,
        canUseTool: () => ({ behavior: "deny", reason: "test wall" }),
      }),
    );
    expect(terminal.reason).toBe("aborted");
    expect(terminal.loopEvidence).toBeTruthy();
    expect(terminal.denialCircuit).toBe(true);
  });

  it("普通失败墙（执行失败非否决）→ aborted 无旗", async () => {
    const state: AgentState = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" };
    const model = denialWallModel();
    const { terminal } = await drain(
      runAgentLoop(state, model, {
        maxTurns: 30,
        // 允许权限，但工具本体每次执行失败 → failure_streak 无 denied 旗
      }),
    );
    // 执行失败墙：aborted 但不带 denialCircuit（用会失败的 stub）
    expect(terminal.reason).toBe("aborted");
    expect(terminal.denialCircuit).toBeUndefined();
  });
});

describe("133 #6 — Task 工具父链契约", () => {
  const failingShell = () =>
    buildTool({
      name: "run_command",
      description: "stub",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false },
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      isDestructive: () => false,
      isOpenWorld: () => false,
      async execute() {
        return { content: "boom", isError: true };
      },
    });

  it("子代理否决墙 → 结果带行为契约（isError + 禁止恢复 + 部分输出保留）", async () => {
    const task = createTaskTool({
      model: denialWallModel(),
      allTools: [shellTool()],
      loopOptions: { maxTurns: 30 },
      canUseTool: () => ({ behavior: "deny", reason: "parent wall" }),
    });
    const result = await task.execute({ description: "probe", prompt: "run it" });
    expect(result.isError).toBe(true);
    expect(result.content.startsWith(SUBAGENT_DENIAL_CONTRACT_PREFIX)).toBe(true);
    expect(result.content).toContain("不要重启此子代理");
    expect(result.content).toContain("等待确认");
    expect(result.content).toContain("（中止前的部分输出：）");
  });

  it("正常完成/普通失败墙 → 不带契约前缀", async () => {
    const task = createTaskTool({
      model: denialWallModel(),
      allTools: [failingShell()],
      loopOptions: { maxTurns: 30 },
    });
    const result = await task.execute({ description: "probe", prompt: "run it" });
    expect(result.content.startsWith(SUBAGENT_DENIAL_CONTRACT_PREFIX)).toBe(false);
  });

  it("契约文本有界（≤512B）且注入卫生（不含被拒参数原文）", () => {
    const text = subagentDenialNotice({ loopEvidence: "run_command failed ×4 consecutively (args vary)" });
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(512);
    expect(text).not.toContain("echo");
    expect(text).toContain("run_command");
  });
});
