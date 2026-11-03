// 136 — 工具轮分段思考必须进转录（2026-11-02 用户报障：
// 「模型的思考过程没有流式输出，现在思考和结果全部一股脑展示出来了」）。
//
// 病灶：flushAssistantSegment 只在 m.content !== "" 时落 assistant 条目 ——
// 纯工具调用的模型调用（工具重回合的常态）思考被整段丢弃：live 卡在
// tool_call_started 被清空，历史里又没有对账条目，用户只在回合末尾看到
// 最后一轮思考与正文同时出现。10-27 用户令「LLM 返回的任何内容都要展示」
// 同样要求这段思考进转录。
import { describe, it, expect } from "vitest";
import { createReadFileTool } from "@wudao-org/core";
import type { ModelClient, Tool } from "@wudao-org/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { HistoryEntry } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 6000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

function stubReadTool(): Tool {
  return createReadFileTool();
}

describe("136 — 工具轮的分段思考落进转录", () => {
  it("call 1 只有思考 + 工具调用（无正文）时，思考仍作为 assistant 条目落史", async () => {
    let call = 0;
    const model: ModelClient = {
      async *stream() {
        call += 1;
        if (call === 1) {
          yield { type: "reasoning_delta", text: "先读文件" };
          yield { type: "done", message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] } };
          return;
        }
        yield { type: "reasoning_delta", text: "归纳" };
        yield { type: "text_delta", text: "答" };
        yield { type: "done", message: { role: "assistant", content: "答" } };
      },
    };
    const driver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [stubReadTool()], onPermissionAsk: async () => ({ kind: "allow" }) });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const entries = driver.getHistory() as HistoryEntry[];
    const thinkings = entries.filter((e) => e.kind === "assistant" && (e as { reasoning?: string }).reasoning !== undefined);
    // 两轮调用各落一条思考；第一轮无正文 → text 为空串。
    expect(thinkings.length).toBe(2);
    const first = thinkings[0] as { text: string; reasoning?: string };
    expect(first.reasoning).toBe("先读文件");
    expect(first.text).toBe("");
    const second = thinkings[1] as { text: string; reasoning?: string };
    expect(second.reasoning).toBe("归纳");
    expect(second.text).toBe("答");
    driver.dispose();
  });

  it("无思考的纯工具轮不凭空造条目（零噪音）", async () => {
    let call = 0;
    const model: ModelClient = {
      async *stream() {
        call += 1;
        if (call === 1) {
          yield { type: "done", message: { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] } };
          return;
        }
        yield { type: "text_delta", text: "答" };
        yield { type: "done", message: { role: "assistant", content: "答" } };
      },
    };
    const driver = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [stubReadTool()], onPermissionAsk: async () => ({ kind: "allow" }) });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const assistantEntries = (driver.getHistory() as HistoryEntry[]).filter((e) => e.kind === "assistant");
    expect(assistantEntries.length).toBe(1); // 只有终答那条
    driver.dispose();
  });
});
