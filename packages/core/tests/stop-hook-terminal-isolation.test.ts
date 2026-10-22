// 夜移 016 (#29) — 停止钩死亡螺旋守卫的行为 pin。真 the upstream format纪律：「最后消息是
// API 错误 → 跳过停止钩」——一个对错误终态做反应的策略钩不得把机械故障再
// 驱成螺旋（钩拦停 → 模型重试 → 又错 → 钩又拦停……）。wudao 的架构已经
// 满足它（onRunStop 咨询点 loop.ts 只在「成功产出最终回答」分支可达），
// 但这是**结构上的偶然**，没有任何东西阻止重构把咨询点挪进错误路径。
// 本文件把五条非回答出口全部钉死 + 一条正向对照（干净完成确实咨询）：
//
//   ① completed           onRunStop consulted exactly once (the control)
//   ② model throw         the error propagates; onRunStop NEVER runs
//   ③ aborted             pre-aborted signal → aborted terminal, never runs
//   ④ max_turns           tool-loop model burns the budget → never runs
//   ⑤ output_limit        maxNudges:0 opt-out terminal → never runs (013's
//      discipline, here pinned as part of the family)
//
// 候选 #29 审计的另一半（reactive-compact 标志防再压缩螺旋）已有守卫：
// rapidCompactStreak≥2 → CompactionThrashError；M58 §A 溢出重试仍满 →
// ContextOverflowHardError{compacted:true} 终态——不再第二次压缩。ledger 记行。
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal } from "../src/index.js";

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(_input: ModelInput): Promise<AssistantMessage> {
      calls += 1;
      const r = responses[calls - 1];
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

/** A model whose generate() rejects — the API-error stand-in. */
function failingModel(err: Error): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(): Promise<AssistantMessage> {
      calls += 1;
      throw err;
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<Terminal> {
  for (;;) {
    const r = await gen.next();
    if (r.done) return r.value;
  }
}

const state = (tools: AgentState["tools"] = []): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "do the thing" }],
  tools,
  status: "idle",
});

/** The spy hook: records every consult, always allows. */
const spyStop = (): { onRunStop: () => Promise<"allow">; count: () => number } => {
  let n = 0;
  return { onRunStop: async () => { n += 1; return "allow"; }, count: () => n };
};

const params = { type: "object" as const, properties: {}, additionalProperties: false as const };

describe("stop-hook terminal isolation (夜移 016, 真 the upstream format「API 错误跳停止钩」纪律)", () => {
  it("① control: a clean completed answer consults onRunStop exactly once", async () => {
    const spy = spyStop();
    const model = recordingModel([{ role: "assistant", content: "all done", stopReason: "end_turn" }]);
    const terminal = await drain(runAgentLoop(state(), model, { maxTurns: 3, hooks: { onRunStop: spy.onRunStop } }));
    expect(terminal.reason).toBe("completed");
    expect(spy.count()).toBe(1);
  });

  it("② a model throw propagates and NEVER consults onRunStop (the death-spiral guard)", async () => {
    const spy = spyStop();
    const model = failingModel(new Error("503 upstream"));
    const gen = runAgentLoop(state(), model, { maxTurns: 3, hooks: { onRunStop: spy.onRunStop } });
    await expect(drain(gen)).rejects.toThrow("503 upstream");
    expect(spy.count()).toBe(0);
    expect(model.calls).toBe(1);
  });

  it("③ a pre-aborted signal exits aborted without consulting onRunStop", async () => {
    const spy = spyStop();
    const model = recordingModel([{ role: "assistant", content: "too late", stopReason: "end_turn" }]);
    const controller = new AbortController();
    controller.abort();
    const terminal = await drain(runAgentLoop(state(), model, { maxTurns: 3, signal: controller.signal, hooks: { onRunStop: spy.onRunStop } }));
    expect(terminal.reason).toBe("aborted");
    expect(spy.count()).toBe(0);
    expect(model.calls).toBe(0); // the loop-top abort check fires before any call
  });

  it("④ a max_turns terminal (tool loop burns the budget) never consults onRunStop", async () => {
    const spy = spyStop();
    const tool = buildTool({ name: "noop", description: "stub", parameters: params, execute: async () => ({ content: "ok" }) });
    const forever: AssistantMessage[] = Array.from({ length: 5 }, () => ({
      role: "assistant",
      content: "",
      stopReason: "tool_use",
      toolCalls: [{ id: "t", name: "noop", arguments: {} }],
    }));
    const model = recordingModel(forever);
    const terminal = await drain(runAgentLoop(state([tool]), model, { maxTurns: 2, hooks: { onRunStop: spy.onRunStop } }));
    expect(terminal.reason).toBe("max_turns");
    expect(spy.count()).toBe(0);
  });

  it("⑤ an output_limit terminal (maxNudges:0 opt-out) never consults onRunStop", async () => {
    const spy = spyStop();
    const model = recordingModel([{ role: "assistant", content: "cut off mid-sent", stopReason: "length" }]);
    const terminal = await drain(runAgentLoop(state(), model, {
      maxTurns: 3,
      outputLimitRecovery: { maxNudges: 0 },
      hooks: { onRunStop: spy.onRunStop },
    }));
    expect(terminal.reason).toBe("output_limit");
    expect(spy.count()).toBe(0);
  });
});
