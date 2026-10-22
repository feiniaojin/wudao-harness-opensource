// det-61-night-porting-4 — the deterministic behavior pins for 夜移 014
// (/btw 缓存共享旁问, 真 the upstream formatsideQuestion.ts 的 wudao 适配). The feature
// landed with cli unit tests (tests/btw-side-question.test.ts, 4 contracts);
// this suite pays the det-44-style debt the same way det-57..det-60 did —
// the behavior pinned inside the release-eval matrix, so a regression fails
// the release evals, not just a package test someone might not run. Zero
// network, zero real-home reads.
//
//   ① prefix-share      the btw fork's request shares the session's prefix
//      bytes exactly — same systemPrompt, same tools list, history + the
//      [旁问] suffix — with querySource "btw" and the 1024 budget.
//   ② state purity      the question and the answer NEVER enter
//      state.messages (the fork is read-only over the snapshot; persistence
//      and the main agent stay untouched) — and the answer lands as a
//      💬 notice in driver history.
//   ③ mid-run           a gated tool holds the loop, /btw answers WHILE the
//      run is busy, then the run still completes normally.
//   ④ parser            /btw <q> parses to the btw kind (question carried
//      verbatim); bare /btw parses with an empty question (usage lane).
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, toModelToolDefinition } from "@wudao/core";
import type { ModelClient, ModelInput, Tool } from "@wudao/core";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import { parseReplCommand } from "wudao-harness/repl";
import { BTW_MAX_TOKENS, BTW_QUERY_SOURCE } from "wudao-harness/btw";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting4Evidence {
  readonly root: string;
  // ① prefix-share
  readonly sameSystem: boolean;
  readonly sameToolNames: boolean;
  readonly prefixIsMainHistory: boolean;
  readonly btwTailRole?: string;
  readonly btwTailHasEnvelope: boolean;
  readonly btwQuerySource?: string;
  readonly btwMaxTokens?: number;
  // ② state purity + surfacing
  readonly answerNotice: boolean;
  readonly questionInState: boolean;
  readonly answerInState: boolean;
  // ③ mid-run
  readonly midRunAnsweredWhileBusy: boolean;
  readonly midRunFinal?: string;
  readonly midRunSuffixOnFork: boolean;
  // ④ parser
  readonly parseKind?: string;
  readonly parseQuestion?: string;
  readonly parseBareQuestion?: string;
}

/** Recording model: captures every generate() input, answers from a script
 *  keyed by call order.
 *
 *  ω99-25 `delayFirstMs` — the busy-fork race reproducer's one-shot latency
 *  injection: delays the FIRST MAIN-LOOP call (querySource !== "btw") BEFORE
 *  it is recorded, modeling the main submit→first-generate pipeline losing
 *  its head start under CPU contention. The btw fork is never delayed — its
 *  dispatch path is the short one being raced against, so delaying it would
 *  manufacture the opposite of the race. */
function recordingModel(
  script: readonly ((input: ModelInput, calls: number) => { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] })[],
  opts?: { readonly delayFirstMs?: number },
): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  let mainDelayed = false;
  return {
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput) {
      if (opts?.delayFirstMs !== undefined && !mainDelayed && input.querySource !== BTW_QUERY_SOURCE) {
        mainDelayed = true;
        await new Promise((r) => setTimeout(r, opts.delayFirstMs));
      }
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const make = script[calls];
      calls += 1;
      if (make === undefined) throw new Error("script exhausted");
      return make(input, calls);
    },
  };
}

const params = { type: "object" as const, properties: {}, additionalProperties: false as const };

const settle = async (driver: ReturnType<typeof createAgentDriver>): Promise<void> => {
  for (let i = 0; i < 200 && !driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
  for (let i = 0; i < 500 && driver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 30));
};

const waitNotice = async (driver: ReturnType<typeof createAgentDriver>, pred: (t: string) => boolean, timeoutMs = 4000): Promise<boolean> => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 10));
  for (;;) {
    const hit = driver.getHistory().some((e) => e.kind === "notice" && pred(String((e as { text?: string }).text ?? "")));
    if (hit) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ω99-25 — the det-61 ③ scenario (a gated read tool holds the main run; a
// /btw fork answers mid-run) as a reusable, evidence-rich function. The
// suite pins its product behavior; tests/det61-busyfork-race.test.ts pins
// its SCHEDULING behavior (the wall-clock race the ω99-23 walk found, made
// manufacturable via recordingModel's delayFirstMs).
export type BusyForkScheduling = "legacy" | "handshake";

export interface BusyForkScenarioOptions {
  readonly root: string;
  /** "handshake" (the suite's scheduling — causality pinned on recorder
   *  evidence) or "legacy" (the ω99-23 wall-clock specimen, kept verbatim
   *  as the race reproducer's control arm).
   *
   *  legacy:    poll the busy flag (it flips true SYNCHRONOUSLY in submit,
   *             so the poll exits on its first check) and trust ~0ms of
   *             ordering to keep the fork behind the main loop's first
   *             model call. Under contention the head start evaporates and
   *             the fork lands in the recorder first → slot swap (the
   *             ω99-23 high-load failure, manufacturable via delayFirstMs).
   *  handshake: the fork may only be submitted once the main call is
   *             RECORDED and the gated tool's execute has ENTERED (busy is
   *             then a proven fact, not a raced flag); the gate is only
   *             released once the fork's call is RECORDED as inputs[1] with
   *             the [旁问] tail (the script-slot order pinned by evidence).
   *             Wall-clock survives only as the 10s deadlock-insurance
   *             deadline, which fails LOUD with a dump — never a flake. */
  readonly scheduling: BusyForkScheduling;
  /** One-shot latency injected into the main loop's first model call BEFORE
   *  it is recorded (see recordingModel). 50ms manufactures the ω99-23 race
   *  on an idle machine; undefined = natural timing. */
  readonly delayFirstMs?: number;
}

/** One recorded model call, identified for slot dumps. */
export interface BusyForkSlot {
  readonly index: number;
  /** querySource of the call ("btw" = the fork, "main" = anything else). */
  readonly source: string;
  /** First 16 chars of the call's last message content. */
  readonly tail: string;
}

export interface BusyForkScenarioEvidence {
  /** A 💬 notice landed (waitNotice over driver history). */
  readonly midAnswer: boolean;
  /** busy === true, captured right after the notice landed. */
  readonly stillBusy: boolean;
  /** Last assistant entry in driver history after settle. */
  readonly final: string | undefined;
  /** inputs[1]'s tail starts with the <side_question> envelope — the suite's
   *  ③ slot pin. (ω99-316：信封标签形。)*/
  readonly forkSuffixOnSlot1: boolean;
  /** Every recorded call in ARRIVAL order — the slot dump for diagnostics. */
  readonly slots: readonly BusyForkSlot[];
  /** Recorded inputs count at release() time. */
  readonly inputsAtRelease: number;
  /** Whether the gated grep's execute had been entered at release() time. */
  readonly toolEnteredAtRelease: boolean;
  /** Notice texts after settle (diagnostics). */
  readonly notices: readonly string[];
}

/** The handshake's deadlock-insurance deadline. The handshake polls evidence
 *  (recorded inputs + the tool-entry flag) at 10ms ticks; on a healthy
 *  driver the evidence is present within milliseconds even under the 50ms
 *  injection. 10s is therefore NOT a retry budget — breaching it means the
 *  harness itself broke, and the wait fails LOUD with a full dump instead
 *  of degrading into a flake. */
const HANDSHAKE_DEADLINE_MS = 10_000;

export async function runBusyForkScenario(opts: BusyForkScenarioOptions): Promise<BusyForkScenarioEvidence> {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  // The entry signal: execute flips the flag BEFORE awaiting the gate.
  // "toolEntered === true" is observable proof that the main loop issued
  // its first model call, got the grep toolCall back, and is NOW parked
  // inside the tool — the evidence handshake A waits on instead of a
  // wall-clock head start.
  let toolEntered = false;
  const gated = buildTool({
    name: "grep", description: "gated read", parameters: params,
    execute: async () => {
      toolEntered = true;
      await gate;
      return { content: "GATED" };
    },
  });
  const midRun = recordingModel([
    () => ({ role: "assistant", content: "", toolCalls: [{ id: "t1", name: "grep", arguments: {} }] }),
    () => ({ role: "assistant", content: "旁答：主任务还在跑" }),
    () => ({ role: "assistant", content: "主线完成" }),
  ], { delayFirstMs: opts.delayFirstMs });
  const busyDriver = createAgentDriver({
    model: midRun, tools: [gated], systemPrompt: "s", summarize: summarizeToolCall, workspaceRoot: opts.root,
    canUseTool: async () => ({ behavior: "allow" as const }),
  });
  const slotsNow = (): BusyForkSlot[] =>
    midRun.inputs.map((input, index) => ({
      index,
      source: input.querySource ?? "main",
      tail: String(input.messages.at(-1)?.content ?? "").slice(0, 16),
    }));
  const dump = (): string =>
    `busy=${String(busyDriver.getStatus().busy)} toolEntered=${String(toolEntered)} inputs=${String(midRun.inputs.length)} slots=${JSON.stringify(slotsNow())}`;
  const waitForEvidence = async (what: string, ready: () => boolean): Promise<void> => {
    const start = Date.now();
    while (!ready()) {
      if (Date.now() - start > HANDSHAKE_DEADLINE_MS) {
        busyDriver.dispose();
        throw new Error(`det-61 busy-fork handshake stuck >${HANDSHAKE_DEADLINE_MS}ms waiting for ${what} — dump: ${dump()}`);
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  busyDriver.submit("main task");
  if (opts.scheduling === "legacy") {
    for (let i = 0; i < 200 && !busyDriver.getStatus().busy; i += 1) await new Promise((r) => setTimeout(r, 10));
  } else {
    // Handshake A — the fork may only be submitted once BOTH hold:
    //   (a) the main loop's first call is RECORDED (inputs.length >= 1), and
    //   (b) the gated grep's execute has ENTERED.
    await waitForEvidence("handshake A: the main call recorded and the gated grep entered",
      () => midRun.inputs.length >= 1 && toolEntered);
  }
  busyDriver.submit("/btw 现在怎么样了？");
  const midAnswer = await waitNotice(busyDriver, (t) => t.startsWith("💬"));
  const stillBusy = busyDriver.getStatus().busy;
  if (opts.scheduling === "handshake") {
    // Handshake B — release only once the fork's call is RECORDED as
    // inputs[1] AND carries the <side_question> envelope tail: the slot order
    // (fork = script[1]) is pinned by recorder evidence, not arrival luck.
    // (ω99-316 随源演进、0.3.91 gate 补钉：信封由 [旁问] 方括号形改为
    // <side_question> 标签形——buildBtwEnvelope。)
    await waitForEvidence("handshake B: the btw fork recorded as inputs[1] with the <side_question> tail",
      () => midRun.inputs.length >= 2 && String(midRun.inputs[1]?.messages.at(-1)?.content ?? "").startsWith("<side_question>"));
  }
  const inputsAtRelease = midRun.inputs.length;
  const toolEnteredAtRelease = toolEntered;
  release?.();
  await settle(busyDriver);
  const finalAssistant = busyDriver.getHistory().filter((e) => e.kind === "assistant").at(-1);
  const fork2 = midRun.inputs[1];
  const notices = busyDriver.getHistory().filter((e) => e.kind === "notice").map((e) => String((e as { text?: string }).text ?? ""));
  const slots = slotsNow();
  busyDriver.dispose();
  return {
    midAnswer,
    stillBusy,
    final: finalAssistant !== undefined ? String((finalAssistant as { text?: string }).text ?? "") : undefined,
    forkSuffixOnSlot1: String(fork2?.messages.at(-1)?.content ?? "").startsWith("<side_question>"),
    slots,
    inputsAtRelease,
    toolEnteredAtRelease,
    notices,
  };
}

export const det61Eval: EvalDefinition<{ readonly root: string }, NightPorting4Evidence> = {
  name: "det-61-night-porting-4",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det61-night4-")) };
  },
  async run(ctx) {
    // ①+② idle session: main run completes, then the btw fork fires.
    const tools: Tool[] = [
      buildTool({ name: "noop", description: "stub", parameters: params, execute: async () => ({ content: "ok" }) }),
      buildTool({ name: "read_file", description: "stub", parameters: params, execute: async () => ({ content: "ok" }) }),
    ];
    const idle = recordingModel([
      () => ({ role: "assistant", content: "主线完成" }),
      () => ({ role: "assistant", content: "旁答：就绪" }),
    ]);
    const driver = createAgentDriver({ model: idle, tools, systemPrompt: "SYS", summarize: summarizeToolCall, workspaceRoot: ctx.root });
    driver.submit("main task");
    await settle(driver);
    const mainInput = idle.inputs[0];
    if (mainInput === undefined) throw new Error("main run produced no model input");
    // The prefix contract is against the SESSION (state.messages at submit
    // time), not the main call's input — the loop appends ephemeral
    // projection riders (the time note) to its own calls that the durable
    // history never sees.
    const stateBeforeBtw = JSON.stringify(
      (driver as unknown as { state?: { messages?: unknown[] } }).state?.messages ?? [],
    );
    driver.submit("/btw 主任务用的什么算法？");
    const answered = await waitNotice(driver, (t) => t.startsWith("💬"));
    const btwInput = idle.inputs[idle.inputs.length - 1];
    if (btwInput === undefined) throw new Error("btw fork produced no model input");
    // ② state purity over the LIVE driver (same state object the fork snapshotted).
    const stateText = JSON.stringify((driver as unknown as { state?: { messages?: unknown[] } }).state?.messages ?? []);
    const notices = driver.getHistory().filter((e) => e.kind === "notice").map((e) => String((e as { text?: string }).text ?? ""));
    driver.dispose();
    // The prefix the fork sent must be the session's message list verbatim.
    const forkPrefix = btwInput.messages.slice(0, -1);
    const prefixIsMainHistory = JSON.stringify(forkPrefix) === stateBeforeBtw;

    // ③ mid-run: a gated read tool holds the loop; /btw fires while busy.
    // ω99-25: the scheduling is EVIDENCE-HANDSHAKEN (runBusyForkScenario
    // "handshake") — the fork is submitted only after the main call is
    // recorded AND the gated grep's execute has entered, and released only
    // after the fork's call is recorded as inputs[1] with the [旁问] tail.
    // Same product pins, causality pinned on recorder evidence instead of
    // a ~0ms wall-clock head start.
    const mid = await runBusyForkScenario({ root: ctx.root, scheduling: "handshake" });

    // ④ parser pins.
    const parsed = parseReplCommand("/btw 这个逻辑为什么对？", [], []);
    const parsedBare = parseReplCommand("/btw", [], []);

    return {
      root: ctx.root,
      sameSystem: btwInput.systemPrompt === mainInput.systemPrompt,
      sameToolNames: JSON.stringify(btwInput.tools?.map((t) => t.name)) === JSON.stringify(mainInput.tools?.map((t) => t.name)),
      prefixIsMainHistory,
      btwTailRole: btwInput.messages.at(-1)?.role,
      btwTailHasEnvelope: String(btwInput.messages.at(-1)?.content ?? "").startsWith("<side_question>"),
      btwQuerySource: btwInput.querySource,
      btwMaxTokens: btwInput.maxTokens,
      answerNotice: answered && notices.some((t) => t.startsWith("💬")),
      questionInState: stateText.includes("主任务用的什么算法"),
      answerInState: stateText.includes("旁答"),
      midRunAnsweredWhileBusy: mid.midAnswer && mid.stillBusy,
      midRunFinal: mid.final,
      midRunSuffixOnFork: mid.forkSuffixOnSlot1,
      parseKind: parsed.kind,
      parseQuestion: parsed.kind === "btw" ? parsed.question : undefined,
      parseBareQuestion: parsedBare.kind === "btw" ? parsedBare.question : undefined,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.sameSystem && e.sameToolNames && e.prefixIsMainHistory,
      `① the fork shares system/tools/message-prefix bytes with the main run (sys=${String(e.sameSystem)}, tools=${String(e.sameToolNames)}, prefix=${String(e.prefixIsMainHistory)})`);
    need(e.btwTailRole === "user" && e.btwTailHasEnvelope,
      `① the question rides as a pure <side_question> user suffix (role=${String(e.btwTailRole)}, envelope=${String(e.btwTailHasEnvelope)})`);
    need(e.btwQuerySource === BTW_QUERY_SOURCE && e.btwMaxTokens === BTW_MAX_TOKENS,
      `① the side lane is marked and bounded (source=${String(e.btwQuerySource)}, cap=${String(e.btwMaxTokens)})`);

    need(e.answerNotice, "② the answer lands as a 💬 driver notice");
    need(!e.questionInState && !e.answerInState,
      `② neither question nor answer ever enters state.messages (q=${String(e.questionInState)}, a=${String(e.answerInState)})`);

    need(e.midRunAnsweredWhileBusy, "③ /btw answers while the main run is busy");
    need(e.midRunFinal === "主线完成", `③ the held run still completes normally (final=${JSON.stringify(e.midRunFinal)})`);
    need(e.midRunSuffixOnFork, "③ the mid-run fork carried the <side_question> suffix");

    need(e.parseKind === "btw" && e.parseQuestion === "这个逻辑为什么对？",
      `④ /btw <q> parses to the btw kind with the question verbatim (kind=${String(e.parseKind)}, q=${JSON.stringify(e.parseQuestion)})`);
    need(e.parseBareQuestion === "", `④ bare /btw parses with an empty question (got ${JSON.stringify(e.parseBareQuestion)})`);

    return errs;
  },
};
