// 弧 C（research-import-2026-10，nanobot turn_continuation）— 预算切片续跑
// 的确定性验收：C1 分支矩阵 + 续跑消息结构/打标 + 上限 12 +
// iterationLimitContextBlock 文案 + loop 接线（scripted model）+ C2 JSONL
// 打标通道。夹具只写 tmpdir。
import { describe, it, expect } from "vitest";
import { runAgentLoop, type LoopEvent, type Terminal } from "../src/loop.js";
import {
  shouldFinalizeOnLimit, lastStopReasonOf, internalContinuationMessage, isInternalContinuation,
  iterationLimitContextBlock, continuationMarkerEntry, CONTINUATION_SLICE_CAP,
  type ContinuationMarkerEntry,
} from "../src/turn-slicing.js";
import { createScriptedModel, type ModelClient, type ModelInput } from "../src/model-client.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { buildTool } from "../src/index.js";
import type { AgentMessage } from "../src/types.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample.txt");

// Drive the generator manually to capture its Terminal *return value*.
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

// 一个永远在干活（tool_use）的 assistant 响应。
const toolTurn = {
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }],
};

describe("shouldFinalizeOnLimit（C1 分支矩阵）", () => {
  it("tool_use 且无 pending steer → slice（不 finalize）", () => {
    expect(shouldFinalizeOnLimit({ lastStopReason: "tool_use", pendingSteers: false }))
      .toEqual({ finalize: false, slice: true });
  });

  it("end_turn → finalize（不 slice）", () => {
    expect(shouldFinalizeOnLimit({ lastStopReason: "end_turn", pendingSteers: false }))
      .toEqual({ finalize: true, slice: false });
  });

  it("有 pending steer → 永不 slice（steer 接管；end_turn 同样 finalize）", () => {
    expect(shouldFinalizeOnLimit({ lastStopReason: "tool_use", pendingSteers: true }))
      .toEqual({ finalize: true, slice: false });
    expect(shouldFinalizeOnLimit({ lastStopReason: "end_turn", pendingSteers: true }))
      .toEqual({ finalize: true, slice: false });
  });

  it("矩阵全集满足恰好一真（finalize XOR slice）", () => {
    for (const lastStopReason of ["tool_use", "end_turn", "stop", "length"]) {
      for (const pendingSteers of [false, true]) {
        const v = shouldFinalizeOnLimit({ lastStopReason, pendingSteers });
        expect(v.finalize !== v.slice).toBe(true);
      }
    }
  });
});

describe("lastStopReasonOf", () => {
  it("尾部 tool 轮形状 → tool_use", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "t", content: "ok" },
    ];
    expect(lastStopReasonOf(messages)).toBe("tool_use");
  });

  it("无工具 assistant → 透传 stopReason（缺省 end_turn）；无 assistant → end_turn", () => {
    expect(lastStopReasonOf([
      { role: "user", content: "go" },
      { role: "assistant", content: "done", stopReason: "stop" },
    ])).toBe("stop");
    expect(lastStopReasonOf([{ role: "user", content: "go" }])).toBe("end_turn");
  });
});

describe("internalContinuationMessage（C1 结构 + 打标）", () => {
  it("是 user 消息、[system note: …] 家族文案、带 sliceIndex/sessionId 打标", () => {
    const m = internalContinuationMessage("sess-1", 3);
    expect(m.role).toBe("user");
    expect(m.content.startsWith("[system note: ")).toBe(true);
    expect(m.content).toContain("iteration budget");
    expect(m.content).toContain("do not repeat tool calls that already completed");
    expect(m.internalContinuation).toEqual({ sliceIndex: 3, sessionId: "sess-1" });
    // 字节固定：同参两次构造全等（每片同文，前缀缓存友好）。
    expect(internalContinuationMessage("sess-1", 3)).toEqual(m);
  });

  it("sessionId 缺席则不打该键", () => {
    const m = internalContinuationMessage(undefined, 1);
    expect(m.internalContinuation?.sliceIndex).toBe(1);
    expect("sessionId" in (m.internalContinuation ?? {})).toBe(false);
  });

  it("isInternalContinuation：只认打标的 user 消息（显示层过滤谓词）", () => {
    expect(isInternalContinuation(internalContinuationMessage(undefined, 1))).toBe(true);
    expect(isInternalContinuation({ role: "user", content: "普通用户输入" })).toBe(false);
    expect(isInternalContinuation({ role: "assistant", content: "" })).toBe(false);
    expect(isInternalContinuation({ role: "tool", toolCallId: "c", name: "n", content: "x" })).toBe(false);
  });
});

describe("iterationLimitContextBlock（硬停 Runtime Context 块文案）", () => {
  it("携带上限 N、停机轮号、恢复守则，[system note: …] 家族格式", () => {
    const text = iterationLimitContextBlock(25, 40);
    expect(text.startsWith("[system note: ")).toBe(true);
    expect(text.endsWith("]")).toBe(true);
    expect(text).toContain("迭代上限 25");
    expect(text).toContain("第 40 轮");
    expect(text).toContain("仅在用户要求时恢复");
    expect(text).toContain("勿盲目重跑已完成的工具调用");
  });
});

describe("continuationMarkerEntry（C2 类型化 entry）", () => {
  it("type=continuation，data 携带 sliceIndex/turn/at；sessionId 缺席不打", () => {
    const e = continuationMarkerEntry("sess-1", 2, 7, "2026-10-26T00:00:00.000Z");
    expect(e.type).toBe("continuation");
    expect(e.data).toEqual({ sliceIndex: 2, turn: 7, at: "2026-10-26T00:00:00.000Z", sessionId: "sess-1" });
    const bare = continuationMarkerEntry(undefined, 1, 2, "2026-10-26T00:00:01.000Z");
    expect("sessionId" in bare.data).toBe(false);
  });
});

describe("loop 接线（scripted model）", () => {
  it("切片：撞上限注入续跑消息为下一片首条输入、slice 0 不排无工具最终化 nudge、超限硬停", async () => {
    // maxTurns=2、maxSlices=1：slice 0 = 轮 0/1；边界注入续跑 #1；slice 1 =
    // 轮 2/3（轮 3 是最后一片 → 「answer NOW」nudge 恢复）；边界 2 名额用尽
    // → max_turns 硬停。共 4 次模型调用。
    const scripted = createScriptedModel([toolTurn, toolTurn, toolTurn, toolTurn, toolTurn]);
    const inputs: AgentMessage[][] = [];
    const model: ModelClient = {
      generate: async (input: ModelInput) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const entries: ContinuationMarkerEntry[] = [];
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 2,
      continuation: { sessionId: "sess-1", maxSlices: 1, appendEntry: (e) => { entries.push(e); } },
    }));

    expect(terminal.reason).toBe("max_turns");
    expect(scripted.calls).toBe(4);

    // 续跑消息恰好一条（#1），作为 slice 1 首个模型调用的尾部输入。
    const continuationMessages = state.messages.filter(isInternalContinuation);
    expect(continuationMessages).toHaveLength(1);
    expect(continuationMessages[0]?.internalContinuation).toEqual({ sliceIndex: 1, sessionId: "sess-1" });
    const slice1Input = inputs[2] ?? [];
    expect(slice1Input.at(-1)?.role).toBe("user");
    expect(isInternalContinuation(slice1Input.at(-1) as AgentMessage)).toBe(true);

    // slice 0 的两次调用没有「answer NOW」最终化 nudge（不排无工具最终化
    // 调用）；nudge 只在最后一片（轮 3）出现，且晚于续跑消息。
    const nudgeCheck = (m: AgentMessage) => m.role === "user" && m.content.includes("turn limit reached");
    expect(inputs[0]?.some(nudgeCheck)).toBe(false);
    expect(inputs[1]?.some(nudgeCheck)).toBe(false);
    const nudgeIdx = state.messages.findIndex(nudgeCheck);
    const contIdx = state.messages.findIndex((m) => isInternalContinuation(m));
    expect(nudgeIdx).toBeGreaterThan(contIdx);
    expect(nudgeIdx).toBeGreaterThan(-1);

    // 事件 + 类型化 entry 回调。
    const ev = events.find((e) => e.type === "continuation_injected") as Extract<LoopEvent, { type: "continuation_injected" }> | undefined;
    expect(ev).toMatchObject({ turn: 2, sliceIndex: 1 });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.type).toBe("continuation");
    expect(entries[0]?.data.sliceIndex).toBe(1);
    expect(entries[0]?.data.sessionId).toBe("sess-1");
    expect(entries[0]?.data.turn).toBe(2);
  });

  it("steering 优先（C3）：边界处有 pending steer 时不切片——steer 接管新预算窗且不占名额", async () => {
    // maxTurns=1：轮 0 干活（工具执行期把 steer 入队——它必须在边界轮的
    // drain 才落地，而不是 run 开始时就在队列里）；边界处 drain 落地
    // steer → 不注入续跑消息；steer 文本成为 slice 1 的输入；模型收口 →
    // completed。
    const queue: string[] = [];
    const steeringTool = buildTool({
      name: "read_file", description: "steers on execute",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => { queue.push("NEW DIRECTION"); return { content: "ok" }; },
    });
    const scripted = createScriptedModel([toolTurn, { role: "assistant", content: "done" }]);
    const inputs: AgentMessage[][] = [];
    const model: ModelClient = {
      generate: async (input: ModelInput) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [steeringTool],
      status: "idle" as const,
    };
    const entries: ContinuationMarkerEntry[] = [];
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 1,
      steering: { take: () => queue.shift() },
      continuation: { maxSlices: 3, appendEntry: (e) => { entries.push(e); } },
    }));

    expect(terminal.reason).toBe("completed");
    expect(scripted.calls).toBe(2);
    // steer 落地、无切片：续跑消息/事件/entry 一条都没有。
    expect(events.some((e) => e.type === "continuation_injected")).toBe(false);
    expect(state.messages.some(isInternalContinuation)).toBe(false);
    expect(entries).toHaveLength(0);
    expect(events.some((e) => e.type === "steered")).toBe(true);
    // steer 文本是接管轮的尾部输入（不是续跑消息）。
    const last = inputs[1]?.at(-1);
    expect(last).toMatchObject({ role: "user", content: "NEW DIRECTION" });
    expect(isInternalContinuation(last as AgentMessage)).toBe(false);
    // 续跑武装时轮 0 不排「answer NOW」（预算窗有余量时不施加最终化压力）。
    expect(inputs[0]?.some((m) => m.role === "user" && m.content.includes("turn limit reached"))).toBe(false);
  });

  it("end_turn 在边界 → finalize 硬停（无续跑）", async () => {
    // 让最后一片的收口轮照常 nudge 后模型仍无工具也不可能在边界出现
    // end_turn（无工具轮在收口缝结算）；这里直接验证顶部预筛对非
    // tool_use 停因的守卫：用一个空工具批（toolCalls: []）的 assistant。
    const scripted = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [], stopReason: "end_turn" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { events, terminal } = await drain(runAgentLoop(state, scripted, {
      maxTurns: 1,
      continuation: {},
    }));
    // 无工具终答：走既有 completed/空答守卫路径（不切片、无续跑注入）。
    expect(events.some((e) => e.type === "continuation_injected")).toBe(false);
    expect(state.messages.some(isInternalContinuation)).toBe(false);
    expect(["completed", "max_turns"]).toContain(terminal.reason);
  });

  it("切片上限 12（缺省 CONTINUATION_SLICE_CAP）：第 13 个预算窗前硬停", async () => {
    expect(CONTINUATION_SLICE_CAP).toBe(12);
    // maxTurns=1、模型永远 tool_use：slice 0..12 共 13 次调用、12 条续跑
    // 消息（sliceIndex 1..12）；最后一片（轮 12）恢复「answer NOW」nudge，
    // 模型仍干活 → 边界硬停 max_turns。M53 §5 ablation：13 轮同一调用是
    // loop-safety/repetition 的 scripted 形状，与本测试的对象（预算边界）
    // 正交，按既定缝关掉。
    const scripted = createScriptedModel(Array.from({ length: 14 }, () => toolTurn));
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, scripted, {
      maxTurns: 1,
      continuation: {},
      loopSafety: false,
      repetitionBreaker: false,
    }));

    expect(terminal.reason).toBe("max_turns");
    expect(scripted.calls).toBe(13);
    const continuationMessages = state.messages.filter(isInternalContinuation);
    expect(continuationMessages).toHaveLength(12);
    expect(continuationMessages.map((m) => m.internalContinuation?.sliceIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    // 最后一片（轮 12）恢复「answer NOW」nudge（名额用尽的 finalize 对
    // 位），恰好一次；maxTurns=1 时它在本片注入（msg #12）之前入列。
    const nudges = state.messages.filter((m) => m.role === "user" && m.content.includes("turn limit reached"));
    expect(nudges).toHaveLength(1);
    expect(state.messages.indexOf(nudges[0] as AgentMessage))
      .toBeGreaterThan(state.messages.indexOf(continuationMessages[10] as AgentMessage));
  });

  it("continuation 缺席 = 零行为变化：既有 max_turns 语义原样（回归锚）", async () => {
    const scripted = createScriptedModel([toolTurn, toolTurn, toolTurn]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "loop" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, scripted, { maxTurns: 2 }));
    expect(terminal.reason).toBe("max_turns");
    expect(scripted.calls).toBe(2);
    expect(state.messages.some(isInternalContinuation)).toBe(false);
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("turn limit reached"))).toBe(true);
  });
});

describe("C2：JSONL 打标通道（tmpdir 夹具）", () => {
  it("类型化 continuation entry：entry 视图可见、消息视图过滤（显示层不渲染）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "turn-slicing-"));
    try {
      const store = createJsonlSessionStore(dir);
      await store.appendEntry("sess-1", continuationMarkerEntry("sess-1", 1, 2, "2026-10-26T00:00:00.000Z"));
      // entry 视图：一等 turn 记录在档。
      const entries = await store.loadSessionEntries("sess-1");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ type: "continuation", data: { sliceIndex: 1, turn: 2 } });
      // 消息视图：generic entry 被过滤——模型历史/用户输入里没有它。
      const messages = await store.load("sess-1");
      expect(messages).toHaveLength(0);
      expect(store.lastLoadSkipped).toBe(0); // 已知 entry 类型，不计 skip

      // 打标消息本身若经消息通道落盘，标记字段完整往返（持久化专用字段）。
      await store.append("sess-1", internalContinuationMessage("sess-1", 2));
      const roundTrip = await store.load("sess-1");
      expect(roundTrip).toHaveLength(1);
      expect(isInternalContinuation(roundTrip[0] as AgentMessage)).toBe(true);
      expect((roundTrip[0] as AgentMessage & { internalContinuation?: { sliceIndex: number } }).internalContinuation?.sliceIndex).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
