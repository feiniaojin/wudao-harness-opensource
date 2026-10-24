// 借鉴弧 B2（SoL-Pi C2）+ B1 的轮界面 — 边界时机压缩、同 run 续跑注记、
// 类型化推迟、压力回落与窗口保护在真实 loop 形状下的验收。SoL-Pi 用
// settlement barrier + 假消息绕 Pi 的 API 形状；wudao 自有 loop：压缩点 =
// 轮边界原生操作（本测试钉「压缩后同 run 继续，无 barrier hack」）。
import { describe, it, expect } from "vitest";
import { runAgentLoop, createTodoTool, createScriptedModel } from "../src/index.js";
import type { AgentMessage, AgentState, LoopEvent, Terminal, Tool, ToolCall } from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
}

const ECHO: Tool = {
  name: "echo",
  description: "trivial",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (args) => ({ content: String((args as { text?: string }).text ?? "") }),
};

const bigText = (chars: number): string => "x".repeat(chars);

/** 历史：n 对 user/assistant 大消息 + 一个既有 board（todo_write 结果）+
 *  尾部 "go"。keepRecent 6 下 span ≈ 前部大消息。 */
function historyWithBoard(pairs: number, charsPerMsg: number, boardContent: string): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    msgs.push({ role: "user", content: bigText(charsPerMsg) });
    msgs.push({ role: "assistant", content: bigText(charsPerMsg) });
  }
  // 既有 board：todo_write 的工具结果（老 board，全部 pending）。
  msgs.push({ role: "tool", toolCallId: "board-seed", name: "todo_write", content: boardContent });
  msgs.push({ role: "assistant", content: "board created" });
  msgs.push({ role: "user", content: "go" });
  return msgs;
}

const todoCall = (id: string, todos: { content: string; status: string }[]): ToolCall => ({
  id,
  name: "todo_write",
  arguments: { todos },
});

const state = (messages: AgentMessage[], tools: readonly Tool[]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools,
  status: "idle",
});

describe("B2 边界时机压缩 + 同 run 续跑", () => {
  // W=80_000 → 阈值 64_000、floor 32_000。历史 10 对 × 8k chars（≈2k token
  // 每条）+ board + 尾部 → occ ≈ 41k（floor 之上、阈值之下——纯边界候选，
  // 无压力）。span（keepRecent 6）≈ 30k token；ratio 4 → breakeven ≈ 1.1，
  // 期距（1 请求/边界 × 剩余 2 + 1 = 3，首压 ×2 = 6）→ economic。
  const W = 80_000;
  const BOARD_OLD = "[todo board 0/3 done]\n☐ item one\n☐ item two\n☐ item three";
  const ADVANCE: { content: string; status: string }[] = [
    { content: "item one", status: "done" },
    { content: "item two", status: "in_progress" },
    { content: "item three", status: "pending" },
  ];

  it("边界信号 + 经济学放行 → 轮边界压缩（reason economic），续跑注记随边界存档", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [todoCall("t1", ADVANCE)] },
      { role: "assistant", content: "SUMMARY" }, // tier-2 摘要调用消费
      { role: "assistant", content: "done" },
    ]);
    const st = state(historyWithBoard(10, 8_000, BOARD_OLD), [createTodoTool({}), ECHO]);
    const { events } = await drain(runAgentLoop(st, model, {
      maxTurns: 5,
      gates: { todo: false, verify: false },
      compaction: {
        contextWindowTokens: W,
        keepRecent: 6,
        cachePricing: { cacheWriteReadRatio: 4, ratioSource: "env" },
      },
    }));
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type !== "compacted") throw new Error("unreachable");
    expect(compacted.trigger).toBe("boundary");
    expect(compacted.reason).toBe("economic");
    expect(compacted.economics?.reason).toBe("economic");
    expect(compacted.economics?.ratioSource).toBe("env");
    expect(compacted.economics?.carriedDebtTokens).toBeGreaterThan(0);
    // 同 run 续跑注记：board 还有 2 项 → ONE 条重锚定 user note（纯尾部追加）。
    const note = st.messages.find((m) => m.role === "user" && m.content.startsWith("[system note: context was compacted at a task boundary"));
    expect(note).toBeDefined();
    expect(note?.content).toContain("2 remaining");
    // 压缩后同 run 继续：compacted 之后还有下一次模型调用（无 barrier、无断流）。
    const compactedAt = events.findIndex((e) => e.type === "compacted");
    const nextCall = events.findIndex((e) => e.type === "model_call_started");
    const lastCall = events.map((e) => e.type).lastIndexOf("model_call_started");
    expect(lastCall).toBeGreaterThan(compactedAt);
    expect(nextCall).toBeGreaterThanOrEqual(0);
  });

  it("经济学不放行（剩余边界 0，期距太短）→ 类型化推迟，暖前缀原样发出", async () => {
    // 老 board 2/3 done，新 board 3/3 → 完成 transition 但 remaining 0：
    // 期距 1（首压 ×2 = 2）。实测量：occ≈40.8k、span≈38.7k → write≈3.1k、
    // saving≈37.7k；ratio 40 → breakeven ≈ 3.1k×39/37.7k ≈ 3.2 > 2 → 推迟。
    const boardOld = "[todo board 2/3 done]\n☑ item one\n☑ item two\n☐ item three";
    const finish: { content: string; status: string }[] = [
      { content: "item one", status: "done" },
      { content: "item two", status: "done" },
      { content: "item three", status: "done" },
    ];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [todoCall("t1", finish)] },
      { role: "assistant", content: "done" },
    ]);
    const st = state(historyWithBoard(10, 8_000, boardOld), [createTodoTool({}), ECHO]);
    const { events } = await drain(runAgentLoop(st, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: W, keepRecent: 6, cachePricing: { cacheWriteReadRatio: 40, ratioSource: "env" } },
    }));
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    const deferred = events.find((e) => e.type === "compact_deferred");
    expect(deferred).toBeDefined();
    if (deferred?.type !== "compact_deferred") throw new Error("unreachable");
    expect(deferred.reason.startsWith("economics:")).toBe(true);
    expect(deferred.economics?.reason).toBe("deferred_economic");
    // board 全 done → 无续跑注记（模型可以收尾）。
    expect(st.messages.find((m) => m.role === "user" && m.content.includes("task boundary"))).toBeUndefined();
  });

  it("无边界统计的压力路径 → fail-open 照压（ω-2b 压力语义不动），reason pressure_fallback 入回执", async () => {
    // W=120_000 → 阈值 96k、保护带 103.6k、immediate 104k。24 对 × 8k chars
    // ≈ 96.6k token：压力带内且在窗口保护带外 → pendingCompaction → 轮边界
    // 审议；无 board 无边界统计 → fail-open 照压。
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 24; i += 1) {
      msgs.push({ role: "user", content: bigText(8_000) });
      msgs.push({ role: "assistant", content: bigText(8_000) });
    }
    msgs.push({ role: "user", content: "go" });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "echo", arguments: { text: "x" } }] },
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const { events } = await drain(runAgentLoop(state(msgs, [ECHO]), model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 120_000, keepRecent: 6 },
    }));
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type !== "compacted") throw new Error("unreachable");
    expect(compacted.trigger).toBe("boundary");
    expect(compacted.reason).toBe("threshold");
    expect(compacted.economics?.reason).toBe("pressure_fallback");
  });

  it("窗口保护带内（占用 ≥ 窗口 − 16k）→ 覆盖经济学照压（reason window_protection）", async () => {
    // W=50_000：阈值 40_000。occ ≈ 45k → 在 [阈值, 阈值+8k) 压力带内且
    // ≥ 50_000−16_384 = 33_616 → 轮边界窗口保护。
    const msgs: AgentMessage[] = [];
    for (let i = 0; i < 11; i += 1) {
      msgs.push({ role: "user", content: bigText(8_000) });
      msgs.push({ role: "assistant", content: bigText(8_000) });
    }
    msgs.push({ role: "user", content: "go" });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "e1", name: "echo", arguments: { text: "x" } }] },
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const { events } = await drain(runAgentLoop(state(msgs, [ECHO]), model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 50_000, keepRecent: 6 },
    }));
    const compacted = events.find((e) => e.type === "compacted");
    expect(compacted).toBeDefined();
    if (compacted?.type !== "compacted") throw new Error("unreachable");
    expect(compacted.economics?.reason).toBe("window_protection");
    // 无 board → 无续跑注记。
  });

  it("边界在占用下限以下 → 静默（统计入账、无压缩无推迟事件）", async () => {
    // 3 对 × 8k chars → occ ≈ 12k < floor 32_000：board 完成只是统计。
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [todoCall("t1", ADVANCE)] },
      { role: "assistant", content: "done" },
    ]);
    const st = state(historyWithBoard(3, 8_000, BOARD_OLD), [createTodoTool({}), ECHO]);
    const { events } = await drain(runAgentLoop(st, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: W, keepRecent: 6 },
    }));
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(events.find((e) => e.type === "compact_deferred")).toBeUndefined();
  });

  it("被 todo 钩子拦下的完成 transition 不算边界（SoL-Pi turn_end 卫生）", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [todoCall("t1", ADVANCE)] },
      { role: "assistant", content: "done" },
    ]);
    const st = state(historyWithBoard(10, 8_000, BOARD_OLD), [createTodoTool({}), ECHO]);
    const { events } = await drain(runAgentLoop(st, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: W, keepRecent: 6 },
      hooks: {
        onTaskCompleted: () => ({ block: true, reason: "not verified yet" }),
      },
    }));
    // 拦下 = error 工具结果 → 无边界 → 占用在 floor 之上也无候选。
    expect(events.find((e) => e.type === "compacted")).toBeUndefined();
    expect(events.find((e) => e.type === "compact_deferred")).toBeUndefined();
    // 且模型看到的是 blocked 结果。
    const blocked = events.find((e) => e.type === "tool_call_finished" && e.isError);
    expect(blocked).toBeDefined();
  });
});

describe("B1 缓存债在事件流的可见性", () => {
  it("推迟事件携带决策回执（breakeven/期距/债）；两次推迟间债随回执采样", async () => {
    const boardOld = "[todo board 2/3 done]\n☑ item one\n☑ item two\n☐ item three";
    const finish: { content: string; status: string }[] = [
      { content: "item one", status: "done" },
      { content: "item two", status: "done" },
      { content: "item three", status: "done" },
    ];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [todoCall("t1", finish)] },
      { role: "assistant", content: "done" },
    ]);
    const st = state(historyWithBoard(10, 8_000, boardOld), [createTodoTool({}), ECHO]);
    const { events } = await drain(runAgentLoop(st, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 80_000, keepRecent: 6, cachePricing: { cacheWriteReadRatio: 40, ratioSource: "env" } },
    }));
    const deferred = events.find((e) => e.type === "compact_deferred");
    if (deferred?.type !== "compact_deferred") throw new Error("unreachable");
    expect(deferred.economics?.breakevenRequests).not.toBeNull();
    expect(deferred.economics?.expectedRemainingRequests).toBe(1);
    expect(deferred.economics?.cacheWriteReadRatio).toBe(40);
    expect(deferred.economics?.ratioSource).toBe("env");
    expect(deferred.economics?.carriedDebtTokens).toBe(0); // 尚无压缩立账
  });
});
