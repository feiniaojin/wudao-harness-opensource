// #302 (0.3.29) — 分段提交：工具回合里每次模型调用的正文在该调用的工具相
// 开启时落为独立 assistant 历史条目，与工具条目按时间序交错（此前整轮正文
// 汇进一条回复、钉在工具流下方）。live.answer 只显示当前调用的流式文本；
// reasoning 按调用窗口切片（不再整轮堆在最后一条）；纯工具调用轮不产生
// 空正文卡；单调用回合字节不变。
import { describe, it, expect, vi } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver, AgentDriverOptions } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function makeDriver(opts: Partial<AgentDriverOptions> & Pick<AgentDriverOptions, "model" | "tools">): AgentDriver {
  return createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, ...opts });
}

const readOnlyParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(content = "STUB FILE CONTENT"): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: readOnlyParams,
    execute: async () => ({ content }),
  });
}

const allow = vi.fn(async () => ({ kind: "allow" as const }));

// 流式脚本模型：第 i 次调用按 deltas[i] 先吐 reasoning_delta 再 text_delta，
// 最后以 done 携带权威 responses[i]（loop 的 stream 优先路径）。
function streamingScriptedModel(
  responses: readonly AssistantMessage[],
  deltas: readonly { reasoning?: string; text?: string }[],
): ModelClient & { calls: number } {
  let calls = 0;
  const take = (): number => {
    const n = calls;
    calls += 1;
    return n;
  };
  const respond = (n: number): AssistantMessage => {
    const r = responses[n];
    if (!r) throw new Error(`scripted model exhausted (call ${n})`);
    return r;
  };
  return {
    get calls() {
      return calls;
    },
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      return respond(take());
    },
    async *stream(_input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      const n = take();
      const d = deltas[n] ?? {};
      if (d.reasoning !== undefined) yield { type: "reasoning_delta", text: d.reasoning };
      if (d.text !== undefined) yield { type: "text_delta", text: d.text };
      yield { type: "done", message: respond(n) };
    },
  };
}

const threeCallScript: readonly AssistantMessage[] = [
  { role: "assistant", content: "先看文件", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
  { role: "assistant", content: "改好了", toolCalls: [{ id: "c2", name: "read_file", arguments: { path: "b.txt" } }] },
  { role: "assistant", content: "完成" },
];

describe("AgentDriver — #302 分段提交（正文与工具按时间序交错）", () => {
  it("非流式脚本模型也分段：user → 文1 → tool → 文2 → tool → 终答，无重复无遗漏", async () => {
    const model = createScriptedModel(threeCallScript);
    const driver = makeDriver({ model, tools: [stubReadTool()], onPermissionAsk: allow });
    await wait();

    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run to finish");

    const history = driver.getHistory();
    // 末位是 0.3.15 的耗时 run receipt（notice）。
    expect(history.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "notice"]);
    expect(history[1]).toEqual({ kind: "assistant", text: "先看文件" });
    expect(history[2]).toMatchObject({ kind: "tool", name: "read_file" });
    expect(history[3]).toEqual({ kind: "assistant", text: "改好了" });
    expect(history[4]).toMatchObject({ kind: "tool", name: "read_file" });
    expect(history[5]).toEqual({ kind: "assistant", text: "完成" });
    driver.dispose();
  });

  it("流式：工具相一开启分段已落历史、live.answer 已清空；reasoning 按调用窗口切片", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = buildTool({
      name: "read_file",
      description: "gated read",
      parameters: readOnlyParams,
      execute: async () => {
        await gate;
        return { content: "GATED RESULT" };
      },
    });
    const model = streamingScriptedModel(threeCallScript, [
      { reasoning: "R1", text: "先看文件" },
      { reasoning: "R2", text: "改好了" },
      { reasoning: "R3", text: "完成" },
    ]);
    const driver = makeDriver({ model, tools: [gated], onPermissionAsk: allow });
    await wait();

    driver.submit("hi");
    await until(() => driver.getStatus().live.busyTools.length === 1, "tool phase opens");

    // 工具相开启的瞬间：第一段已在历史（时间序在其工具之前），live 卡不再
    // 持有已提交的正文——它只显示"当前调用"的流式文本。
    expect(driver.getHistory().some((e) => e.kind === "assistant" && e.text === "先看文件")).toBe(true);
    expect(driver.getStatus().live.answer).toBe("");

    release!();
    await until(() => driver.getStatus().busy === false, "run to finish");

    const history = driver.getHistory();
    expect(history.map((e) => e.kind)).toEqual(["user", "assistant", "tool", "assistant", "tool", "assistant", "notice"]);
    // 每段携带本调用窗口的 reasoning；终答只带最后一段（不再整轮累积）。
    expect(
      history
        .filter((e) => e.kind === "assistant")
        .map((e) => [e.text, e.reasoning]),
    ).toEqual([
      ["先看文件", "R1"],
      ["改好了", "R2"],
      ["完成", "R3"],
    ]);
    driver.dispose();
  });

  it("单调用回合（无工具）字节不变：一条 assistant，整段 reasoning", async () => {
    const model = streamingScriptedModel([{ role: "assistant", content: "HELLO" }], [{ reasoning: "TH", text: "HELLO" }]);
    const driver = makeDriver({ model, tools: [stubReadTool()], onPermissionAsk: allow });
    await wait();

    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run to finish");

    const history = driver.getHistory();
    expect(history.map((e) => e.kind)).toEqual(["user", "assistant", "notice"]);
    expect(history[1]).toEqual({ kind: "assistant", text: "HELLO", reasoning: "TH" });
    driver.dispose();
  });

  it("纯工具调用轮（无正文）不产生空 assistant 卡", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "DONE" },
    ]);
    const driver = makeDriver({ model, tools: [stubReadTool()], onPermissionAsk: allow });
    await wait();

    driver.submit("hi");
    await until(() => driver.getStatus().busy === false, "run to finish");

    expect(driver.getHistory().map((e) => e.kind)).toEqual(["user", "tool", "assistant", "notice"]);
    driver.dispose();
  });
});
