// 夜移 003（2026-08-28 night porting，codex time_reminder，设计加强）：
// 周期性把当前时间注入模型视野 —— 走既有 MetaNote 通道（projection-only、
// 尾部追加、KV 前缀缓存安全、不落盘）；按墙钟漂移阈值触发（run 首轮必注入，
// 其后 drift ≥ intervalMs 才再注入），时间串用确定性手排格式（无 locale 依赖）。
// 缺省不启用：无 timeReminder 选项 = 零行为变化。
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** Records a snapshot of every ModelInput the loop sends. */
function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const toolCall = (id: string, name: string): AssistantMessage =>
  ({ role: "assistant", content: "", toolCalls: [{ id, name, arguments: {} }] });

/** A no-op tool whose execute() runs between model call 1 and call 2 — the
 *  hook the clock-advance tests use to simulate wall-clock drift. */
const noopTool = (name: string, onExecute?: () => void): Tool =>
  buildTool({
    name,
    description: "no-op",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      onExecute?.();
      return { content: "ok" };
    },
  });

const stateOf = (tools: readonly Tool[]): AgentState => ({
  systemPrompt: "sys",
  messages: [{ role: "user", content: "go" }],
  tools: [...tools],
  status: "idle",
});

const T0 = new Date(2026, 7, 28, 1, 35, 0, 0).getTime();
/** The expected note for a timestamp — derived from the date via the SAME
 *  hand-format contract the implementation documents (all parts from local
 *  getters; the UTC offset necessarily depends on the host timezone).
 *  Test 1 additionally hardcodes T0's semantic parts inline to pin the
 *  format itself. */
function expectedNoteAt(t0: number): string {
  const d = new Date(t0);
  const pad = (n: number) => String(n).padStart(2, "0");
  const tz = -d.getTimezoneOffset();
  const sign = tz >= 0 ? "+" : "-";
  const a = Math.abs(tz);
  const wd = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getDay()] ?? "";
  return `[current time: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)} ${wd} (local)]`;
}

const metaEventsOf = (events: LoopEvent[]) =>
  events.filter((e): e is Extract<LoopEvent, { type: "meta_note" }> => e.type === "meta_note");

describe("time reminder (夜移 003)", () => {
  it("injects the current-time note on the first call (user channel, exact deterministic format)", async () => {
    let clock = T0;
    const model = recordingModel([toolCall("c1", "noop"), { role: "assistant", content: "done" }]);
    const state = stateOf([noopTool("noop")]);
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      now: () => clock,
      timeReminder: { intervalMs: 1_800_000 },
    }));

    expect(model.inputs.length).toBe(2);
    const call1 = model.inputs[0]?.messages ?? [];
    const last = call1[call1.length - 1];
    // No tool_result yet → degraded trailing user message carrying the note.
    expect(last?.role).toBe("user");
    expect(last?.content).toBe(`<system_note>\n${expectedNoteAt(T0)}\n</system_note>`);
    // Format pinned by hardcoding T0's semantic parts (2026-08-28 01:35, Friday).
    expect(last?.content).toContain("[current time: 2026-08-28 01:35");
    expect(last?.content).toContain(" Friday (local)]");
    // Projection-only: the persisted transcript stays clean.
    expect(JSON.stringify(state.messages)).not.toContain("current time");
    // Observability: exactly one meta_note event, on the user channel.
    const meta = metaEventsOf(events);
    expect(meta.length).toBe(1);
    expect(meta[0]?.channel).toBe("user");
    expect(meta[0]?.text).toContain(expectedNoteAt(T0));
  });

  it("does not re-inject while wall-clock drift stays under intervalMs", async () => {
    let clock = T0; // never advances
    const model = recordingModel([toolCall("c1", "noop"), { role: "assistant", content: "done" }]);
    const state = stateOf([noopTool("noop")]);
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      now: () => clock,
      timeReminder: { intervalMs: 1_800_000 },
    }));

    // Call 2 (one turn later, same clock): no time note anywhere — not even
    // in the tool_result tail; the turn-0 note was projection-only.
    const call2 = model.inputs[1]?.messages ?? [];
    expect(JSON.stringify(call2)).not.toContain("current time");
    const meta = metaEventsOf(events);
    expect(meta.length).toBe(1); // only the turn-0 injection
  });

  it("re-injects into the LAST tool_result tail once drift ≥ intervalMs (cache-safe suffix)", async () => {
    let clock = T0;
    const model = recordingModel([toolCall("c1", "tick"), { role: "assistant", content: "done" }]);
    const state = stateOf([noopTool("tick", () => { clock = T0 + 7_200_000; })]); // +2h during the tool turn
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      now: () => clock,
      timeReminder: { intervalMs: 1_800_000 },
    }));

    const call2 = model.inputs[1]?.messages ?? [];
    const last = call2[call2.length - 1];
    expect(last?.role).toBe("tool");
    expect((last?.content ?? "").endsWith(`\n<system_note>\n${expectedNoteAt(T0 + 7_200_000)}\n</system_note>`)).toBe(true);
    // Persisted tool_result keeps its original bytes.
    const persisted = state.messages.find((m) => m.role === "tool");
    expect(persisted?.content).toBe("ok");
    const meta = metaEventsOf(events);
    expect(meta.length).toBe(2);
    expect(meta[1]?.channel).toBe("tool_result");
  });

  it("absent option → zero behavior change (no meta_note events, no time text)", async () => {
    const model = recordingModel([toolCall("c1", "noop"), { role: "assistant", content: "done" }]);
    const state = stateOf([noopTool("noop")]);
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));

    expect(metaEventsOf(events)).toHaveLength(0);
    expect(JSON.stringify(model.inputs)).not.toContain("current time");
    expect(JSON.stringify(state.messages)).not.toContain("current time");
  });
});
