// 调研引入弧 A3 接线 — Outstanding Work 的两层钉：
// ① tier2Compact 层：options.outstandingWork 织入 LLM 摘要指令的
//    "## Outstanding Work" 节（字节稳定排序；空清单字节不变——no-op 契约）。
// ② loop 层：options.compaction.outstandingWork 回调在压缩时刻取快照，
//    回调的返回值逐项到达 tier2 指令（驱动层状态喂数据的缝）。
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelClient, ModelInput } from "../src/types.js";
import { tier2Compact } from "../src/compaction.js";
import { runAgentLoop } from "../src/loop.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { OUTSTANDING_WORK_HEADING, type OutstandingWorkItem } from "../src/compaction-summarizer.js";

const MESSAGES: AgentMessage[] = [
  { role: "user", content: "task one " + "x".repeat(400) },
  { role: "assistant", content: "answer one " + "y".repeat(400) },
  { role: "user", content: "go" },
];

function capturingModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return { role: "assistant", content: "SUMMARY" };
    },
  };
}

const lastInstruction = (model: { inputs: ModelInput[] }): string => {
  const last = model.inputs[model.inputs.length - 1];
  const finalMsg = last?.messages[last.messages.length - 1];
  return finalMsg?.role === "user" ? finalMsg.content : "";
};

const ITEMS: readonly OutstandingWorkItem[] = [
  { kind: "background_bash", id: "bash-long-watch", note: "watching logs" },
  { kind: "subagent", id: "agent-explorer", note: "running agent" },
  { kind: "subagent", id: "agent-alpha", note: "queued agent" },
];

const expectedSection = `${OUTSTANDING_WORK_HEADING}\n- subagent agent-alpha: queued agent\n- subagent agent-explorer: running agent\n- background bash bash-long-watch: watching logs`;

describe("A3 接线: tier2Compact 的 outstandingWork rider", () => {
  it("非空清单织入指令尾部（kind 枚举序 → id 序，字节稳定）；空清单字节不变", async () => {
    const withItems = capturingModel();
    await tier2Compact(MESSAGES, withItems, { keepRecent: 1, zeroLlmDigest: false, outstandingWork: ITEMS });
    expect(lastInstruction(withItems)).toContain(expectedSection);

    const without = capturingModel();
    await tier2Compact(MESSAGES, without, { keepRecent: 1, zeroLlmDigest: false });
    expect(lastInstruction(without)).not.toContain(OUTSTANDING_WORK_HEADING);
  });

  it("同清单两次调用逐字节相同（排序确定）", async () => {
    const a = capturingModel();
    const b = capturingModel();
    await tier2Compact(MESSAGES, a, { keepRecent: 1, zeroLlmDigest: false, outstandingWork: ITEMS });
    await tier2Compact(MESSAGES, b, { keepRecent: 1, zeroLlmDigest: false, outstandingWork: [...ITEMS].reverse() });
    expect(lastInstruction(a)).toBe(lastInstruction(b));
  });
});

describe("A3 接线: loop 的压缩时刻快照回调", () => {
  it("options.compaction.outstandingWork 回调的返回织入 tier-2 指令（loop 级透传；loop.test:225 同款 tier-2 触发形态）", async () => {
    const inputs: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return inputs.length === 1
          ? { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "big" } }] }
          : inputs.length === 2
            ? { role: "assistant", content: "T2-SUMMARY" } // tier2Compact 的摘要调用
            : { role: "assistant", content: "final answer" };
      },
    };
    const state = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "y".repeat(1500) },
        { role: "assistant", content: "y".repeat(1500) },
        { role: "user", content: "go" },
      ],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    for await (const _e of runAgentLoop(state, model, {
      maxTurns: 3,
      compaction: {
        contextWindowTokens: 300, reserveTokens: 0, keepRecent: 1,
        zeroLlmDigest: false,
        outstandingWork: () => [{ kind: "subagent", id: "agent-loop-fed", note: "from the getter" }],
      },
    })) { void _e; }
    const instr = inputs.map((i) => {
      const last = i.messages[i.messages.length - 1];
      return last?.role === "user" ? last.content : "";
    }).find((t) => t.includes(OUTSTANDING_WORK_HEADING));
    expect(instr).toContain("- subagent agent-loop-fed: from the getter");
  });

  it("回调缺席时指令无该节（缺省零变化）", async () => {
    const inputs: ModelInput[] = [];
    const model: ModelClient = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return inputs.length === 1
          ? { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: "big" } }] }
          : { role: "assistant", content: "final answer" };
      },
    };
    const state = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "y".repeat(1500) },
        { role: "assistant", content: "y".repeat(1500) },
        { role: "user", content: "go" },
      ],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    for await (const _e of runAgentLoop(state, model, {
      maxTurns: 3,
      compaction: { contextWindowTokens: 300, reserveTokens: 0, keepRecent: 1, zeroLlmDigest: false },
    })) { void _e; }
    for (const i of inputs) {
      const last = i.messages[i.messages.length - 1];
      if (last?.role === "user") expect(last.content).not.toContain(OUTSTANDING_WORK_HEADING);
    }
  });
});
