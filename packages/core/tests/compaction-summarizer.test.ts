// 调研引入弧 A（research-import-2026-10）——摘要输入域的两件守卫：
//   A2（pi 压缩弧事故根因）reasoning/thinking 不进摘要输入：模型可见历史
//   含它（M47 回放契约不动），摘要输入不含——pi 996K→1.38M 事故的形状是
//   摘要请求比它要压缩的上下文还大。断言在「序列化后」层面：canonical
//   JSON 里既无 reasoning 键也无 reasoning 文本。
//   A3（prime-agent #3685 形）摘要指令末尾的 Outstanding Work 节：结构化
//   清单渲染为字节稳定文本（排序确定），空清单不渲染（指令字节不变）。
import { describe, it, expect } from "vitest";
import {
  summarizeSpan,
  stripReasoningForSummary,
  renderOutstandingWork,
  OUTSTANDING_WORK_HEADING,
} from "../src/compaction-summarizer.js";
import { tier2Compact } from "../src/compaction.js";
import { canonicalJson } from "../src/loop-safety.js";
import type { AgentMessage, AssistantMessage } from "../src/types.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";

/** A recording model: every ModelInput captured, one scripted reply. */
function recordingModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return { role: "assistant", content: "S" };
    },
  };
}

// ---------------------------------------------------------------------------
// A2 — reasoning 不进摘要输入（pi 996K→1.38M 事故根因）
// ---------------------------------------------------------------------------

const REASONING_A = "chain-of-thought A: the user wants the auth module refactored";
const REASONING_B = "chain-of-thought B: verify the test matrix before answering";

const reasoningHistory: AgentMessage[] = [
  { role: "user", content: "refactor auth" },
  {
    role: "assistant",
    content: "reading the module first",
    reasoning: REASONING_A,
    toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "auth.ts" } }],
    stopReason: "tool_calls",
  },
  { role: "tool", toolCallId: "c0", name: "read_file", content: "export function auth() {}" },
  { role: "assistant", content: "planning the rewrite", reasoning: REASONING_B, stopReason: "stop" },
  { role: "user", content: "continue" },
];

describe("stripReasoningForSummary (A2)", () => {
  it("strips the reasoning field off assistant messages — the SERIALIZED summary input carries neither the key nor the text", async () => {
    const model = recordingModel();
    const out = await summarizeSpan({ systemPrompt: "s", tools: [], messages: reasoningHistory }, model);
    expect(out).toBe("S");
    const sent = model.inputs[0]!.messages;
    // 字段层：没有任何发送消息携带 reasoning。
    for (const m of sent) {
      if (m.role === "assistant") expect((m as { reasoning?: string }).reasoning).toBeUndefined();
    }
    // 序列化层（canonical serializer——前缀字节断言走同一份）：键与文本都不在。
    const serialized = canonicalJson(sent);
    expect(serialized).not.toContain('"reasoning"');
    expect(serialized).not.toContain(REASONING_A);
    expect(serialized).not.toContain(REASONING_B);
  });

  it("only the reasoning field is dropped — content, toolCalls, stopReason survive; non-reasoning messages pass through by reference (status-quo bytes)", () => {
    const stripped = stripReasoningForSummary(reasoningHistory);
    // 非 assistant / 无 reasoning 的消息原引用直通。
    expect(stripped[0]).toBe(reasoningHistory[0]);
    expect(stripped[2]).toBe(reasoningHistory[2]);
    expect(stripped[4]).toBe(reasoningHistory[4]);
    // 带 reasoning 的 assistant 只去那一个字段，其余原样。
    const a0 = stripped[1]!;
    expect(a0.role).toBe("assistant");
    expect(a0.content).toBe("reading the module first");
    expect(a0).toEqual({
      role: "assistant",
      content: "reading the module first",
      toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "auth.ts" } }],
      stopReason: "tool_calls",
    });
    expect(stripped[3]).toEqual({ role: "assistant", content: "planning the rewrite", stopReason: "stop" });
    // 输入不被改写（持久化历史不动——守卫只投影，不改源）。
    expect(reasoningHistory[1]).toHaveProperty("reasoning", REASONING_A);
  });

  it("a history with no reasoning is byte-identical (every message the same reference)", () => {
    const clean: AgentMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ];
    expect(stripReasoningForSummary(clean)).toEqual(clean);
    expect(stripReasoningForSummary(clean)[0]).toBe(clean[0]);
  });

  it("the tier2Compact LLM lane inherits the strip (summarizeSpan is the ONE seam for every summary call)", async () => {
    const model = recordingModel();
    const messages: AgentMessage[] = [
      { role: "user", content: "task 0 " + "x".repeat(2000) },
      { role: "assistant", content: "answer 0 " + "y".repeat(2000), reasoning: REASONING_A },
      { role: "user", content: "go" },
      { role: "assistant", content: "final answer" },
    ];
    const out = await tier2Compact(messages, model, { keepRecent: 1, zeroLlmDigest: false });
    expect(out).not.toBeNull();
    expect(model.inputs).toHaveLength(1);
    expect(canonicalJson(model.inputs[0]!.messages)).not.toContain('"reasoning"');
    expect(canonicalJson(model.inputs[0]!.messages)).not.toContain(REASONING_A);
  });
});

// ---------------------------------------------------------------------------
// A3 — Outstanding Work 节（prime #3685 形：字节稳定 + 空不渲染）
// ---------------------------------------------------------------------------

describe("renderOutstandingWork (A3, prime #3685)", () => {
  const items = [
    { kind: "timer" as const, id: "watchdog", note: "heartbeat every 30s (rlm_heartbeat.list())" },
    { kind: "subagent" as const, id: "sub-2", note: "porting the CLI tests" },
    { kind: "background_bash" as const, id: "bash-7", note: "pnpm build still running" },
    { kind: "subagent" as const, id: "sub-1", note: "refactoring the auth module" },
    { kind: "subagent" as const, id: "sub-0", note: "surveying the parser" },
  ];

  it("renders byte-stable: the same item SET in any input order is the same bytes", () => {
    const a = renderOutstandingWork(items);
    const b = renderOutstandingWork([...items].reverse());
    const c = renderOutstandingWork([items[2]!, items[4]!, items[0]!, items[1]!, items[3]!]);
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("orders by kind (subagent → background bash → timer), then id — the section names each item with its note", () => {
    const out = renderOutstandingWork(items);
    expect(out.startsWith(`\n${OUTSTANDING_WORK_HEADING}\n`)).toBe(true);
    expect(out).toBe(
      `\n${OUTSTANDING_WORK_HEADING}\n` +
        "- subagent sub-0: surveying the parser\n" +
        "- subagent sub-1: refactoring the auth module\n" +
        "- subagent sub-2: porting the CLI tests\n" +
        "- background bash bash-7: pnpm build still running\n" +
        "- timer watchdog: heartbeat every 30s (rlm_heartbeat.list())",
    );
  });

  it("ties on kind+id break deterministically by note", () => {
    const out = renderOutstandingWork([
      { kind: "subagent", id: "sub-1", note: "zeta note" },
      { kind: "subagent", id: "sub-1", note: "alpha note" },
    ]);
    expect(out).toBe(`\n${OUTSTANDING_WORK_HEADING}\n- subagent sub-1: alpha note\n- subagent sub-1: zeta note`);
  });

  it("empty items render NOTHING (the instruction stays byte-identical to the status quo)", async () => {
    expect(renderOutstandingWork([])).toBe("");
    const without = recordingModel();
    const withEmpty = recordingModel();
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: reasoningHistory }, without);
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: reasoningHistory, outstandingWork: [] }, withEmpty);
    expect(withEmpty.inputs[0]!.messages.at(-1)!.content).toBe(without.inputs[0]!.messages.at(-1)!.content);
  });

  it("the section rides the summary instruction's END (after every standing rider, never the system prompt)", async () => {
    const model = recordingModel();
    await summarizeSpan(
      {
        systemPrompt: "s",
        tools: [],
        messages: reasoningHistory,
        focus: "the auth refactor",
        recencyAnchor: "kept-tail anchor text",
        outstandingWork: [{ kind: "subagent", id: "sub-1", note: "refactoring the auth module" }],
      },
      model,
    );
    const tail = model.inputs[0]!.messages.at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.content.endsWith("- subagent sub-1: refactoring the auth module")).toBe(true);
    // 末尾位序钉：focus 在节之前、anchor 也在节之前（节是最末 rider）。
    expect(tail.content.indexOf("Focus on:")).toBeLessThan(tail.content.indexOf(OUTSTANDING_WORK_HEADING));
    expect(tail.content.indexOf("<recent-state-anchor>")).toBeLessThan(tail.content.indexOf(OUTSTANDING_WORK_HEADING));
    // 节只随请求尾字节走，不进 system prompt。
    expect(model.inputs[0]!.systemPrompt).toBe("s");
  });
});
