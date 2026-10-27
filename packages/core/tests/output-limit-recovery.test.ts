// 夜移 013 — 输出上限恢复梯（nudge-only）：真 CC 的 tiered max_output_tokens
// recovery（query.ts:1188-1256 escalate→nudge×3→surface）针对 wudao 架构的
// 适配。关键取舍：wudao 的截断 assistant 在 loop.ts 已入史（append-only、
// 前缀纯增长），因此**放弃** tier-1 的「同请求升档重试」（那需要弹掉已入史
// 消息）；阶梯退为纯 append 的续写 nudge——「从中断处继续、拆小步骤」至多
// maxNudges 次（默认 3，连续计数：任一非 length 干净轮清零），escalation
// 变为 nudge 呼叫的可选 maxTokens 提升（LoopOptions 供给，缺省不开——盲目
// 64k 会在 DeepSeek 这类硬上限提供方 400）。恢复耗尽返回新终态
// reason:"output_limit"。M70 边界不动：length+tool_calls 走既有守卫。
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import { OUTPUT_LIMIT_NUDGE, DEFAULT_OUTPUT_LIMIT_NUDGES } from "../src/loop.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal } from "../src/index.js";

/** Scripted model that records every request's input (deep enough for the
 *  prefix-stability assertion; the loop never mutates what it handed out). */
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
  messages: [{ role: "user", content: "write a long report" }],
  tools: [],
  status: "idle",
});

const truncated = (text: string): AssistantMessage => ({ role: "assistant", content: text, stopReason: "length" });
const done = (text: string): AssistantMessage => ({ role: "assistant", content: text });

describe("output-limit recovery ladder (夜移 013, nudge-only)", () => {
  it("default ON: a length-truncated text answer gets ONE nudge, the continuation completes, history is pure-append", async () => {
    const model = recordingModel([truncated("partial answ"), done("partial answer: finished")]);
    const st = state();
    const { events, terminal } = await drain(runAgentLoop(st, model, { maxTurns: 5 }));

    // The nudge happened: two calls, one nudge event, canonical text in history.
    expect(model.calls).toBe(2);
    const nudges = events.filter((e) => e.type === "output_limit_recovery" && e.kind === "nudge");
    expect(nudges).toHaveLength(1);
    expect(OUTPUT_LIMIT_NUDGE).toContain("从中断处继续");
    expect(st.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    const nudgeMsg = st.messages[2];
    expect(nudgeMsg && nudgeMsg.role === "user" ? nudgeMsg.content : "").toBe(OUTPUT_LIMIT_NUDGE);
    // Recovered: normal completion, the final message is the completed one.
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("partial answer: finished");
    expect(events.at(-1)?.type).toBe("turn_finished");
  });

  it("escalateTo: the continuation call carries the raised cap (the first call had none); the nudge event reports it", async () => {
    const model = recordingModel([truncated("p"), done("d")]);
    const { events } = await drain(runAgentLoop(state(), model, { maxTurns: 5, outputLimitRecovery: { escalateTo: 8192 } }));
    expect(model.inputs[0]?.maxTokens).toBeUndefined();
    expect(model.inputs[1]?.maxTokens).toBe(8192);
    const nudge = events.find((e) => e.type === "output_limit_recovery" && e.kind === "nudge");
    expect(nudge).toMatchObject({ kind: "nudge", maxTokens: 8192 });
  });

  it("NO default escalation: absent outputLimitRecovery, the continuation goes out with maxTokens undefined", async () => {
    const model = recordingModel([truncated("p"), done("d")]);
    await drain(runAgentLoop(state(), model, { maxTurns: 5 }));
    expect(model.inputs[1]?.maxTokens).toBeUndefined();
  });

  it("exhaustion: an always-truncating model gets exactly maxNudges+1 calls, then the typed terminal; episodes reset on a clean turn", async () => {
    expect(DEFAULT_OUTPUT_LIMIT_NUDGES).toBe(3);
    const model = recordingModel([truncated("a"), truncated("b"), truncated("c"), truncated("d")]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 10 }));
    expect(model.calls).toBe(4); // 1 original + 3 nuded continuations
    expect(events.filter((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toHaveLength(3);
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "exhausted")).toBe(true);
    expect(terminal.reason).toBe("output_limit");
    expect(terminal.finalMessage?.content).toBe("d");
  });

  it("maxNudges: 0 is the opt-out — single call, no nudges, still the typed terminal", async () => {
    const model = recordingModel([truncated("only")]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 5, outputLimitRecovery: { maxNudges: 0 } }));
    expect(model.calls).toBe(1);
    expect(events.filter((e) => e.type === "output_limit_recovery")).toHaveLength(0);
    expect(terminal.reason).toBe("output_limit");
  });

  it("episode reset: any non-length turn — including a TOOL turn — restores the full nudge budget", async () => {
    // Burn the entire budget (3 nudges), bridge with a successful tool-call
    // turn, then truncate again: the 4th nudge fires ONLY if the tool turn
    // reset the episode. Without the reset this run ends output_limit at
    // call 5 with 3 nudges.
    const noop = buildTool({
      name: "noop",
      description: "bridge turn",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "ok" }),
    });
    const model = recordingModel([
      truncated("a"),
      truncated("b"),
      truncated("c"),
      { role: "assistant", content: "bridging", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      truncated("d"),
      done("end"),
    ]);
    const st: AgentState = { ...state(), tools: [noop] };
    const { events, terminal } = await drain(runAgentLoop(st, model, { maxTurns: 10 }));
    expect(model.calls).toBe(6);
    expect(events.filter((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toHaveLength(4);
    expect(terminal.reason).toBe("completed");
  });

  it("M70 boundary: a length-truncated TOOL call takes the guard path — no nudge, no output_limit events", async () => {
    const model = recordingModel([
      { role: "assistant", content: "", stopReason: "length", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      done("recovered"),
    ]);
    const st: AgentState = { ...state(), tools: [] };
    const { events } = await drain(runAgentLoop(st, model, { maxTurns: 3 }));
    expect(events.some((e) => e.type === "output_limit_recovery")).toBe(false);
    expect(st.messages.some((m) => m.role === "user" && m.content === OUTPUT_LIMIT_NUDGE)).toBe(false);
    expect(model.calls).toBe(2);
  });

  it("prefix stability: the nudge is pure-append — the first request's message array is a byte-prefix of the second's", async () => {
    const model = recordingModel([truncated("p"), done("d")]);
    await drain(runAgentLoop(state(), model, { maxTurns: 5 }));
    const first = JSON.stringify(model.inputs[0]?.messages ?? []);
    const second = JSON.stringify(model.inputs[1]?.messages ?? []);
    // "array A is a byte-prefix of array B": strip A's closing bracket.
    expect(second.startsWith(first.slice(0, -1))).toBe(true);
    expect(second.length).toBeGreaterThan(first.length);
  });

  it("maxTurns boundary: the turn budget caps the ladder — exhausted terminal, not max_turns", async () => {
    const model = recordingModel([truncated("a"), truncated("b")]);
    const { events, terminal } = await drain(runAgentLoop(state(), model, { maxTurns: 2 }));
    expect(model.calls).toBe(2); // original + 1 nudge; turn+1 would exceed maxTurns
    expect(terminal.reason).toBe("output_limit");
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "exhausted")).toBe(true);
  });
});
