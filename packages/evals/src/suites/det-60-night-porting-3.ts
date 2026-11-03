// det-60-night-porting-3 — the deterministic behavior pins for 夜移 013
// (output-limit recovery ladder) + its surfacing. The feature landed with
// core unit tests (tests/output-limit-recovery.test.ts, 9 cases) and a cli
// notice test; this suite pays the det-44-style debt the same way det-57
// (010/011/012) and det-58 (001-009) did — the behavior pinned inside the
// release-eval matrix, so a regression fails the release evals, not just a
// package test someone might not run. Zero network, zero real-home reads.
//
//   ① ladder default-ON        a length-truncated TEXT answer (no tool
//      calls) gets the resume-mid-thought nudge: the nudge user message
//      enters history, a second model call runs, the continuation
//      completes normally — roles [user,assistant,user,assistant].
//   ② exhaustion               an always-truncating model gets exactly
//      maxNudges+1 calls (default 3 → 4), then the typed output_limit
//      terminal with the LAST truncated assistant as finalMessage.
//   ③ opt-out                  maxNudges:0 = feature off: one call, zero
//      ladder events, the typed terminal alone carries the failure.
//   ④ M70 boundary             length + toolCalls takes the guard path —
//      no ladder events, no nudge message in state (M70 owns that case).
//   ⑤ escalation threading     escalateTo rides ONLY the continuation call
//      (first call cap-free); absent config → no cap anywhere.
//   ⑥ episode reset            a tool-call turn between truncation
//      episodes restores the full budget (4th nudge fires after burn).
//   ⑦ surfacing                the driver history gets the ✂️ dim notice on
//      nudge and the ⚠️ incompleteness marker on exhaustion — without
//      them a cut answer is indistinguishable from a finished one.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runAgentLoop,
  buildTool,
  createScriptedModel,
  type AgentMessage,
  type AgentState,
  type AssistantMessage,
  type LoopEvent,
  type ModelClient,
  type ModelInput,
  type Terminal,
  type Tool,
} from "@wudao-org/core";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting3Evidence {
  readonly root: string;
  // ① ladder default-ON
  readonly ladderCalls: number;
  readonly ladderNudgeEvents: number;
  readonly ladderRoles?: string;
  readonly ladderReason?: string;
  // ② exhaustion
  readonly exhaustCalls: number;
  readonly exhaustNudges: number;
  readonly exhaustEvent: boolean;
  readonly exhaustReason?: string;
  readonly exhaustFinal?: string;
  // ③ opt-out
  readonly optCalls: number;
  readonly optEvents: number;
  readonly optReason?: string;
  // ④ M70 boundary
  readonly m70Events: number;
  readonly m70NudgeInState: boolean;
  // ⑤ escalation threading
  readonly escFirstCap?: number;
  readonly escSecondCap?: number;
  readonly escEventCap?: number;
  readonly noescSecondCap?: number;
  // ⑥ episode reset
  readonly resetCalls: number;
  readonly resetNudges: number;
  readonly resetReason?: string;
  // ⑦ surfacing
  readonly surfaceNudgeNotice: boolean;
  readonly surfaceExhaustNotice: boolean;
  readonly surfaceFinalAnswer?: string;
}

/** Recording scripted model — every request's input captured (deep enough
 *  for the escalation-cap and prefix assertions). */
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
      const r = responses[calls];
      calls += 1;
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

const freshState = (tools: Tool[] = []): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "write a long report" }] as AgentMessage[],
  tools,
  status: "idle" as const,
});

const truncated = (text: string): AssistantMessage => ({ role: "assistant", content: text, stopReason: "length" });
const done = (text: string): AssistantMessage => ({ role: "assistant", content: text });

const ladderEvents = (events: readonly LoopEvent[]): Extract<LoopEvent, { type: "output_limit_recovery" }>[] =>
  events.filter((e): e is Extract<LoopEvent, { type: "output_limit_recovery" }> => e.type === "output_limit_recovery");

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

export const det60Eval: EvalDefinition<{ readonly root: string }, NightPorting3Evidence> = {
  name: "det-60-night-porting-3",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det60-night3-")) };
  },
  async run(ctx) {
    // ① ladder default-ON: nudge → continuation → completed.
    const ladderModel = recordingModel([truncated("partial answ"), done("partial answer, finished")]);
    const ladderState = freshState();
    const ladder = await drain(runAgentLoop(ladderState, ladderModel, { maxTurns: 5 }));
    const ladderRoles = ladderState.messages.map((m) => m.role).join(",");
    // ② exhaustion: default budget 3 → 4 calls, typed terminal.
    const exhaustModel = recordingModel([truncated("a"), truncated("b"), truncated("c"), truncated("d")]);
    const exhaust = await drain(runAgentLoop(freshState(), exhaustModel, { maxTurns: 10 }));
    // ③ opt-out: maxNudges:0 — feature off.
    const optModel = recordingModel([truncated("only")]);
    const opt = await drain(runAgentLoop(freshState(), optModel, { maxTurns: 5, outputLimitRecovery: { maxNudges: 0 } }));
    // ④ M70 boundary: length + toolCalls → the guard path, never the ladder.
    const m70State = freshState();
    const m70 = await drain(runAgentLoop(m70State, createScriptedModel([
      { role: "assistant", content: "", stopReason: "length", toolCalls: [{ id: "t1", name: "noop", arguments: {} }] },
      done("recovered"),
    ]), { maxTurns: 3 }));
    void m70;
    // ⑤ escalation threading: the cap rides ONLY the continuation call.
    const escModel = recordingModel([truncated("p"), done("d")]);
    const esc = await drain(runAgentLoop(freshState(), escModel, { maxTurns: 5, outputLimitRecovery: { escalateTo: 8192 } }));
    const escEvent = esc.events.find((e) => e.type === "output_limit_recovery" && e.kind === "nudge");
    const noescModel = recordingModel([truncated("p"), done("d")]);
    await drain(runAgentLoop(freshState(), noescModel, { maxTurns: 5 }));
    // ⑥ episode reset: burn 3 nudges, bridge on a tool turn, 4th nudge fires.
    const resetModel = recordingModel([
      truncated("a"), truncated("b"), truncated("c"),
      { role: "assistant", content: "bridging", toolCalls: [{ id: "b1", name: "noop", arguments: {} }] },
      truncated("d"), done("end"),
    ]);
    const reset = await drain(runAgentLoop(freshState([noop()]), resetModel, { maxTurns: 10 }));
    // ⑦ surfacing: the driver history notices (compact_deferred idiom).
    const surfaceDriver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "partial answ", stopReason: "length" },
        { role: "assistant", content: "partial answer, completed" },
      ]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ctx.root,
    });
    surfaceDriver.submit("write a long report");
    await settle(surfaceDriver);
    const surfaceHistory = surfaceDriver.getHistory();
    const surfaceNotices = surfaceHistory
      .filter((e) => e.kind === "notice")
      .map((e) => String((e as { text?: string }).text ?? ""));
    const surfaceAnswers = surfaceHistory.filter((e) => e.kind === "assistant");
    surfaceDriver.dispose();

    const exhaustDriver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "cut one", stopReason: "length" },
        { role: "assistant", content: "cut two", stopReason: "length" },
      ]),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ctx.root,
      maxTurns: 2,
    });
    exhaustDriver.submit("write a long report");
    await settle(exhaustDriver);
    const exhaustNotices = exhaustDriver.getHistory()
      .filter((e) => e.kind === "notice")
      .map((e) => String((e as { text?: string }).text ?? ""));
    exhaustDriver.dispose();

    return {
      root: ctx.root,
      ladderCalls: ladderModel.calls,
      ladderNudgeEvents: ladderEvents(ladder.events).filter((e) => e.kind === "nudge").length,
      ladderRoles,
      ladderReason: ladder.terminal.reason,
      exhaustCalls: exhaustModel.calls,
      exhaustNudges: ladderEvents(exhaust.events).filter((e) => e.kind === "nudge").length,
      exhaustEvent: ladderEvents(exhaust.events).some((e) => e.kind === "exhausted"),
      exhaustReason: exhaust.terminal.reason,
      exhaustFinal: exhaust.terminal.finalMessage?.content,
      optCalls: optModel.calls,
      optEvents: ladderEvents(opt.events).length,
      optReason: opt.terminal.reason,
      m70Events: ladderEvents(m70.events).length,
      m70NudgeInState: m70State.messages.some((m) => m.role === "user" && m.content.includes("从中断处继续")),
      escFirstCap: escModel.inputs[0]?.maxTokens,
      escSecondCap: escModel.inputs[1]?.maxTokens,
      escEventCap: escEvent !== undefined && "maxTokens" in escEvent ? escEvent.maxTokens : undefined,
      noescSecondCap: noescModel.inputs[1]?.maxTokens,
      resetCalls: resetModel.calls,
      resetNudges: ladderEvents(reset.events).filter((e) => e.kind === "nudge").length,
      resetReason: reset.terminal.reason,
      surfaceNudgeNotice: surfaceNotices.some((t) => t.includes("✂️") && t.includes("继续")),
      surfaceExhaustNotice: exhaustNotices.some((t) => t.includes("⚠️") && t.includes("截断")),
      surfaceFinalAnswer: surfaceAnswers.at(-1) !== undefined ? String((surfaceAnswers.at(-1) as { text?: string }).text ?? "") : undefined,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.ladderCalls === 2 && e.ladderNudgeEvents === 1,
      `① a truncated text answer gets exactly one nudge and a second call (calls=${e.ladderCalls}, nudges=${e.ladderNudgeEvents})`);
    need(e.ladderRoles === "user,assistant,user,assistant",
      `① history is pure-append [u,a,u,a] (got ${String(e.ladderRoles)})`);
    need(e.ladderReason === "completed",
      `① the recovered run completes normally (got ${String(e.ladderReason)})`);

    need(e.exhaustCalls === 4 && e.exhaustNudges === 3,
      `② default budget: 4 calls / 3 nudges then stop (calls=${e.exhaustCalls}, nudges=${e.exhaustNudges})`);
    need(e.exhaustEvent && e.exhaustReason === "output_limit",
      `② exhaustion emits the event and the typed terminal (event=${String(e.exhaustEvent)}, reason=${String(e.exhaustReason)})`);
    need(e.exhaustFinal === "d", `② finalMessage carries the last truncated assistant (got ${JSON.stringify(e.exhaustFinal)})`);

    need(e.optCalls === 1 && e.optEvents === 0 && e.optReason === "output_limit",
      `③ maxNudges:0 = feature off (calls=${e.optCalls}, events=${e.optEvents}, reason=${String(e.optReason)})`);

    need(e.m70Events === 0 && !e.m70NudgeInState,
      `④ length+toolCalls stays on the M70 guard path (events=${e.m70Events}, nudgeInState=${String(e.m70NudgeInState)})`);

    need(e.escFirstCap === undefined && e.escSecondCap === 8192,
      `⑤ escalateTo rides only the continuation call (first=${String(e.escFirstCap)}, second=${String(e.escSecondCap)})`);
    need(e.escEventCap === 8192, `⑤ the nudge event reports the applied cap (got ${String(e.escEventCap)})`);
    need(e.noescSecondCap === undefined,
      `⑤ absent config → no cap is invented (second=${String(e.noescSecondCap)})`);

    need(e.resetCalls === 6 && e.resetNudges === 4 && e.resetReason === "completed",
      `⑥ a tool turn between episodes restores the budget (calls=${e.resetCalls}, nudges=${e.resetNudges}, reason=${String(e.resetReason)})`);

    need(e.surfaceNudgeNotice, "⑦ the nudge lands the ✂️ dim notice in driver history");
    need(e.surfaceExhaustNotice, "⑦ exhaustion lands the ⚠️ incompleteness marker in driver history");
    need(e.surfaceFinalAnswer === "partial answer, completed",
      `⑦ the recovered answer is the history's last assistant (got ${JSON.stringify(e.surfaceFinalAnswer)})`);

    return errs;
  },
};
