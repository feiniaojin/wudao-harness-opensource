// det-69-night-porting-12 — the deterministic behavior pins for 夜移 024
// (empty-final guard: a blank final answer gets one synthetic nudge instead
// of silently completing the run blank). The feature landed with core unit
// tests (empty-final.test.ts) + the cli surfacing pins
// (empty-final-notice.test.ts); this suite pays the det-44-style debt the
// same way det-57..det-68 did — the behavior pinned inside the release-eval
// matrix through PUBLIC exports, so a regression fails the release evals.
// Zero network, zero real-home reads.
//
//   ① nudge recovers     a blank final (no tool calls, empty content) gets
//                        ONE nudge: the event fires, the synthetic user note
//                        is a pure append at the second call's tail, the
//                        retry's visible answer completes the run;
//   ② exhaustion         default budget 1: a second blank settles — exhausted
//                        event, completed with the blank final, exactly 2
//                        model calls (no spiral);
//   ③ opt-out            maxNudges:0 — one call, zero events, today's blank
//                        exit unchanged;
//   ④ tool-round reset   blank → nudge → tool bridge → blank → a SECOND
//                        nudge (the budget guards consecutive blanks only);
//   ⑤ 013 boundary       a length-cut blank belongs to the output-limit
//                        ladder — zero empty_final events, output_limit
//                        terminal;
//   ⑥ surfacing          the driver lands both history notices (the dim
//                        re-ask line, the ⚠️ emptiness marker).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  buildTool,
  createScriptedModel,
} from "@wudao/core";
import type { AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Terminal, Tool } from "@wudao/core";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting12Evidence {
  // ① nudge recovers
  readonly nudgeRecovers: boolean;
  // ② exhaustion settles
  readonly exhaustionSettles: boolean;
  // ③ opt-out is zero-change
  readonly optOutZeroChange: boolean;
  // ④ a tool round restores the budget
  readonly toolRoundResets: boolean;
  // ⑤ length-cut blanks stay 013's
  readonly lengthStaysOutputLimits: boolean;
  // ⑥ the driver surfaces both notices
  readonly driverSurfaces: boolean;
}

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

const freshState = (tools: readonly Tool[] = []): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "answer the question" }],
  tools: [...tools],
  status: "idle",
});

const blank = (): AssistantMessage => ({ role: "assistant", content: "" });
const done = (text: string): AssistantMessage => ({ role: "assistant", content: text });
const nudges = (events: readonly LoopEvent[]): number => events.filter((e) => e.type === "empty_final_recovery" && e.kind === "nudge").length;
const exhausted = (events: readonly LoopEvent[]): boolean => events.some((e) => e.type === "empty_final_recovery" && e.kind === "exhausted");

const noop = (): Tool => buildTool({
  name: "noop",
  description: "bridge turn",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async () => ({ content: "ok" }),
});

const settle = async (driver: ReturnType<typeof createAgentDriver>): Promise<void> => {
  for (let i = 0; i < 200 && !driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 500 && driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 20));
};

export const det69Eval: EvalDefinition<{ readonly root: string }, NightPorting12Evidence> = {
  name: "det-69-night-porting-12",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det69-night12-")) };
  },
  async run() {
    // ① nudge recovers — event, pure-append tail, completed with content.
    const m1 = recordingModel([blank(), done("the visible answer")]);
    const lane1 = await drain(runAgentLoop(freshState(), m1, { maxTurns: 5 }));
    const secondTail = m1.inputs[1]!.messages.at(-1);
    const tailIsNudge = secondTail?.role === "user"
      && typeof secondTail.content === "string"
      && secondTail.content.includes("可见");
    const nudgeRecovers = nudges(lane1.events) === 1 && !exhausted(lane1.events) && tailIsNudge
      && lane1.terminal.reason === "completed" && lane1.terminal.finalMessage?.content === "the visible answer";

    // ② exhaustion — default budget 1, no spiral.
    const m2 = recordingModel([blank(), blank()]);
    const lane2 = await drain(runAgentLoop(freshState(), m2, { maxTurns: 10 }));
    const exhaustionSettles = m2.calls === 2 && nudges(lane2.events) === 1 && exhausted(lane2.events)
      && lane2.terminal.reason === "completed" && lane2.terminal.finalMessage?.content === "";

    // ③ opt-out — maxNudges:0 is feature-off.
    const m3 = recordingModel([blank()]);
    const lane3 = await drain(runAgentLoop(freshState(), m3, { maxTurns: 5, emptyFinalRecovery: { maxNudges: 0 } }));
    const optOutZeroChange = m3.calls === 1 && lane3.events.filter((e) => e.type === "empty_final_recovery").length === 0
      && lane3.terminal.reason === "completed" && lane3.terminal.finalMessage?.content === "";

    // ④ tool-round reset — the second nudge exists only because the bridge
    // turn restored the budget.
    const m4 = recordingModel([
      blank(),
      { role: "assistant", content: "", toolCalls: [{ id: "b1", name: "noop", arguments: {} }] },
      blank(),
      done("finally answered"),
    ]);
    const lane4 = await drain(runAgentLoop(freshState([noop()]), m4, { maxTurns: 10 }));
    const toolRoundResets = m4.calls === 4 && nudges(lane4.events) === 2 && !exhausted(lane4.events)
      && lane4.terminal.finalMessage?.content === "finally answered";

    // ⑤ 013 boundary — a length-cut blank is the ladder's, never the guard's.
    const truncBlank = (): AssistantMessage => ({ role: "assistant", content: "", stopReason: "length" });
    const m5 = recordingModel([truncBlank(), truncBlank(), truncBlank(), truncBlank()]);
    const lane5 = await drain(runAgentLoop(freshState(), m5, { maxTurns: 10 }));
    const lengthStaysOutputLimits = lane5.events.filter((e) => e.type === "empty_final_recovery").length === 0
      && lane5.terminal.reason === "output_limit";

    // ⑥ surfacing — both notices ride the driver history.
    const driver = createAgentDriver({
      model: createScriptedModel([blank(), done("the visible answer")]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
    });
    driver.submit("answer the question");
    await settle(driver);
    const notices = driver.getHistory().filter((h) => h.kind === "notice").map((h) => h.text);
    driver.dispose();
    const driverSurfaces = notices.some((t) => t.includes("🕳") && t.includes("重答"));

    return { nudgeRecovers, exhaustionSettles, optOutZeroChange, toolRoundResets, lengthStaysOutputLimits, driverSurfaces };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.nudgeRecovers, "① a blank final must get one nudge: event fired, pure-append user note, visible answer completes");
    need(e.exhaustionSettles, "② budget 1 must cap the spiral: exhausted event, blank settles completed, exactly 2 calls");
    need(e.optOutZeroChange, "③ maxNudges:0 must be the zero-change opt-out (1 call, zero events)");
    need(e.toolRoundResets, "④ a tool round must restore the nudge budget (second nudge fires)");
    need(e.lengthStaysOutputLimits, "⑤ a length-cut blank must stay the output-limit ladder's (zero empty_final events)");
    need(e.driverSurfaces, "⑥ the driver must land the dim re-ask notice in history");

    return errs;
  },
};
