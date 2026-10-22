// 夜移 024 — 空白终局守卫（empty-final guard）：Reasonix run_loop.go:571-596
// 的 wudao 适配。终答轮（无 tool calls）content trim 后为空 = 没有可见回
// 答——今天的 loop 直接 `completed` 落定空白，前端只见空转。守卫：合成一
// 条 user nudge（纯追加，前缀字节稳定）续一轮；连续空白计数封顶（默认 1，
// provider 层已为 reasoning-only 形状前置过一次冻结重放——loop 是第二道
// 防线）；任何工具轮重置计数；耗尽 → exhausted 事件 + 照常 completed（不
// 经 gates/hooks——空白不是可判答案，013 耗尽同纪律）。maxNudges:0 =
// opt-out（零事件零额外调用）。
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import { EMPTY_FINAL_NUDGE } from "../src/loop.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal } from "../src/index.js";

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[]; calls: number } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  return {
    get inputs() {
      return inputs;
    },
    get calls() {
      return calls;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      calls += 1;
      const r = responses[calls - 1];
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
}

const state = (): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "answer the question" }],
  tools: [],
  status: "idle",
});

const blank = (): AssistantMessage => ({ role: "assistant", content: "" });
const done = (text: string): AssistantMessage => ({ role: "assistant", content: text });
const nudges = (events: readonly LoopEvent[]): number => events.filter((e) => e.type === "empty_final_recovery" && e.kind === "nudge").length;
const exhausted = (events: readonly LoopEvent[]): boolean => events.some((e) => e.type === "empty_final_recovery" && e.kind === "exhausted");

describe("empty-final guard (夜移 024)", () => {
  it("A: default ON — a blank final gets ONE nudge: the event fires, the nudge user message is appended, the continuation recovers", async () => {
    const model = recordingModel([blank(), done("the answer")]);
    const st = state();
    const { events, terminal } = await drain(runAgentLoop(st, model, { maxTurns: 5 }));

    expect(nudges(events)).toBe(1);
    expect(exhausted(events)).toBe(false);
    // The nudge is a PURE APPEND: the second call's tail is the synthetic
    // user message right after the blank assistant turn.
    const second = model.inputs[1]!.messages;
    expect(second[second.length - 1]).toEqual({ role: "user", content: EMPTY_FINAL_NUDGE });
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("the answer");
  });

  it("B: recovery completes cleanly — exactly 2 model calls, no stray markers in history beyond the nudge", async () => {
    const model = recordingModel([blank(), done("recovered")]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));

    expect(model.calls).toBe(2);
    expect(nudges(events)).toBe(1);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("recovered");
  });

  it("C: persistent blank — the nudge budget (default 1) caps the spiral: exhausted event, completed with the blank final, exactly 2 calls", async () => {
    const model = recordingModel([blank(), blank()]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));

    expect(model.calls).toBe(2);
    expect(nudges(events)).toBe(1);
    expect(exhausted(events)).toBe(true);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("");
  });

  it("D: maxNudges:0 is the opt-out — single call, zero events, today's blank exit unchanged", async () => {
    const model = recordingModel([blank()]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5, emptyFinalRecovery: { maxNudges: 0 } }));

    expect(model.calls).toBe(1);
    expect(events.filter((e) => e.type === "empty_final_recovery")).toHaveLength(0);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("");
  });

  it("E: a reasoning-present blank is nudged too — the provider layer already replayed it once; the loop's nudge is the second, different-instruction chance", async () => {
    const model = recordingModel([
      { role: "assistant", content: "", reasoning: "thought hard about the answer" },
      done("visible answer"),
    ]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));

    expect(model.calls).toBe(2);
    expect(nudges(events)).toBe(1);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("visible answer");
  });

  it("F: episode reset — a tool round restores the nudge budget: blank → nudge → tool → blank → nudge again", async () => {
    const noop = buildTool({
      name: "noop",
      description: "bridge turn",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "ok" }),
    });
    const model = recordingModel([
      blank(),
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      blank(),
      done("finally answered"),
    ]);
    const st: AgentState = { ...state(), tools: [noop] };
    const { events, terminal } = await drain(runAgentLoop(st, model, { maxTurns: 10 }));

    expect(model.calls).toBe(4);
    expect(nudges(events)).toBe(2); // the SECOND nudge exists only because the tool round reset the streak
    expect(exhausted(events)).toBe(false);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("finally answered");
  });

  it("G: an abort racing the blank decision never nudges — one call, zero empty_final events", async () => {
    // The abort lands AT the decision point (fires as the blank answer is
    // produced), so the model WAS called — the guard's `!signal.aborted`
    // check is what skips the nudge, not a pre-loop abort check.
    const controller = new AbortController();
    const inputs: ModelInput[] = [];
    let calls = 0;
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        calls += 1;
        controller.abort();
        return blank();
      },
    };
    const { events } = await drain(runAgentLoop(state(), model, { maxTurns: 5, signal: controller.signal }));

    expect(calls).toBe(1);
    expect(events.filter((e) => e.type === "empty_final_recovery")).toHaveLength(0);
  });

  it("H: a length-cut blank belongs to 013 — no empty_final event ever fires for it", async () => {
    const truncBlank = (): AssistantMessage => ({ role: "assistant", content: "", stopReason: "length" });
    const model = recordingModel([truncBlank(), truncBlank(), truncBlank(), truncBlank()]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));

    expect(events.filter((e) => e.type === "empty_final_recovery")).toHaveLength(0);
    expect(terminal.reason).toBe("output_limit");
  });

  it("whitespace-only content counts as blank", async () => {
    const model = recordingModel([{ role: "assistant", content: "   \n  " }, done("real answer")]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5 }));

    expect(nudges(events)).toBe(1);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("real answer");
  });
});
