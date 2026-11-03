// M61 det-48 — scheduling & goal acceptance (spec §1-§4). Scripted models and
// a scripted durable runner; zero network. Covers: fire-on-idle + no-catch-up;
// jitter determinism (same ID ⇒ same offset; :30 one-shot ≤90s early;
// recurring ≤ min(30min, interval/2) late); 7-day expiry final-fire-then-
// delete; the resume restore matrix; /loop interval grammar (bare + "every X"
// clause; seconds → minute; non-clean rounded AND told) and the maintenance
// prompt's discipline (no new-initiative tool calls from a scripted model;
// the irreversible-actions clause rides the prompt); /goal's three verdicts +
// stall guard + resume counter reset + the evaluator token column; durable
// offline-no-catch-up + online fire-once; symlink refusal; WUDAO_DISABLE_CRON;
// and the cache gate — scheduled injections ride the steering channel BETWEEN
// turns, so the serialized prompt prefix stays byte-identical.
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CRON_EXPIRY_MS,
  buildTool,
  createJsonlSessionStore,
  isOneShotTask,
  nextFire,
  oneshotEarlyJitterMs,
  recurringLateJitterMs,
  runAgentLoop,
  STOP_BLOCK_CAP,
  type AgentMessage,
  type AgentState,
  type AssistantMessage,
  type CronTask,
  type ModelClient,
  type ModelInput,
  type Terminal,
} from "@wudao-org/core";
import { serializePrompt } from "@wudao-org/providers";
import { createCronRuntime } from "wudao-harness/cron";
import { MAINTENANCE_LOOP_PROMPT, parseLoopInterval } from "wudao-harness/commands/loop";
import { createGoalController } from "wudao-harness/goal";
import { buildGoalSetEntry, buildGoalOutcomeEntry } from "wudao-harness/session-entry";
import { recordUsage, emptyUsageTotals, formatCostReport } from "wudao-harness/commands/cost";
import { createScheduleDaemon, parseScheduleCommand, SCHEDULE_RUN_ENV } from "wudao-harness/schedules";
// Review LOW 2: the REAL fail-closed ask decision permission.ts itself uses.
import { nonInteractiveAskDecision } from "wudao-harness/permission";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

const MIN = 60_000;
const HOUR = 3_600_000;
const T0 = new Date("2026-08-17T10:00:00").getTime();

interface Det48Evidence {
  readonly fire: { readonly onceWhenLate: boolean; readonly idleOnly: boolean; readonly noCatchup: boolean };
  readonly jitter: { readonly stable: boolean; readonly oneshotEarlyBounded: boolean; readonly recurringLateBounded: boolean; readonly sameIdSameOffset: boolean };
  readonly expiry: { readonly finalFire: boolean; readonly selfDeleted: boolean; readonly oneshotSelfDeleted: boolean };
  readonly resumeMatrix: readonly string[];
  readonly loopGrammar: readonly { readonly input: string; readonly ms: number | string }[];
  readonly discipline: { readonly clausesPresent: boolean; readonly noNewInitiativeTools: boolean; readonly zeroToolCalls: boolean };
  readonly goal: { readonly notYetBlocks: boolean; readonly metAllows: boolean; readonly impossibleFails: boolean; readonly stallKeepsGoal: boolean; readonly promptResumes: boolean; readonly countersReset: boolean; readonly evaluatorColumn: boolean };
  readonly durable: { readonly offlineNoCatchup: boolean; readonly onlineFireOnce: boolean; readonly askDenies: boolean; readonly parserCron: boolean; readonly parserAt: boolean };
  readonly refusal: { readonly symlink: boolean; readonly disabled: boolean; readonly symlinkSkipped?: boolean };
  readonly cacheGate: { readonly prefixStable: boolean; readonly injectionAppended: boolean };
  readonly cap: { readonly enforced: boolean; readonly terminalCapped: boolean };
}

function scriptedModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[]; calls: number } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    get calls() {
      return i;
    },
    generate: async (input: ModelInput) => {
      // SNAPSHOT (the loop passes live arrays; prefix asserts need frozen bytes).
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

async function writeCronFile(root: string, tasks: readonly CronTask[]): Promise<string> {
  const ws = await mkdtemp(join(root, "ws-"));
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(join(ws, ".wudao", "cron.json"), JSON.stringify({ version: 1, tasks }), "utf8");
  return ws;
}

export const det48Eval: EvalDefinition<string, Det48Evidence> = {
  name: "det-48-m61-scheduling-goal",
  kind: "deterministic",
  setup: async (tmplDir) => {
    await mkdir(tmplDir, { recursive: true });
    return tmplDir;
  },
  run: async (root) => {
    // ------------------------------------------------------------------ §1
    // fire-on-idle + no-catch-up: one fire regardless of missed occurrences.
    let clock = T0;
    let ws = await writeCronFile(root, [
      { id: "aaaaaaaa", sessionId: "s1", prompt: "check", schedule: { type: "interval", everyMs: MIN }, createdAt: T0 },
    ]);
    let rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0, now: () => clock });
    clock = T0 + 10 * MIN; // 10 missed occurrences
    const lateFires = await rt.tick();
    const onceWhenLate = lateFires.length === 1;
    clock = T0 + 12 * MIN;
    const again = await rt.tick();
    const noCatchup = again.length === 0 && rt.pending().length === 1;
    const drained = rt.takeInjection();
    const idleOnly = drained !== undefined && drained.includes("check");
    rt.stop();

    // jitter determinism.
    const sameIdSameOffset = oneshotEarlyJitterMs("task1234", T0 + 30 * MIN) === oneshotEarlyJitterMs("task1234", T0 + 30 * MIN)
      && recurringLateJitterMs("task1234", 30 * MIN) === recurringLateJitterMs("task1234", 30 * MIN);
    const stable = sameIdSameOffset
      && recurringLateJitterMs("aaaaaaaa", 10 * MIN) === recurringLateJitterMs("aaaaaaaa", 10 * MIN);
    const oneshotEarlyBounded = [0, 30].every((m) => oneshotEarlyJitterMs(`zz${m}zzzz0`, new Date(2026, 7, 20, 10, m).getTime()) <= 90_000);
    const recurringTask: CronTask = {
      id: "aaaaaaaa",
      sessionId: "s1",
      prompt: "p",
      schedule: { type: "interval", everyMs: 30 * MIN },
      createdAt: T0,
      expiresAt: T0 + CRON_EXPIRY_MS,
    };
    const recurringLateBounded = (() => {
      const fire = nextFire(recurringTask, T0)!;
      const late = fire.fireAt - (T0 + 30 * MIN);
      return late >= 0 && late <= Math.min(30 * MIN, 15 * MIN);
    })();

    // 7-day expiry: final fire then self-delete; one-shots self-delete too.
    ws = await writeCronFile(root, [
      { id: "cccccccc", sessionId: "s1", prompt: "daily", schedule: { type: "interval", everyMs: 24 * 60 * MIN }, createdAt: T0 - CRON_EXPIRY_MS - MIN, expiresAt: T0 - MIN, lastFiredAt: T0 - CRON_EXPIRY_MS - MIN },
    ]);
    // Constructed at the task's last fire (the startup tick must not consume
    // anything), then the clock crosses the 7-day expiry.
    clock = T0 - CRON_EXPIRY_MS - MIN;
    rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0, now: () => clock });
    clock = T0;
    const expiryFires = await rt.tick();
    const finalFire = expiryFires.length === 1 && expiryFires[0]!.kind === "expiry-final";
    rt.takeInjection();
    const selfDeleted = rt.list().length === 0;
    rt.stop();
    ws = await writeCronFile(root, [
      { id: "bbbbbbbb", sessionId: "s1", prompt: "once", schedule: { type: "cron", expr: "30 10 * * *" }, createdAt: T0 - MIN },
    ]);
    clock = T0 - MIN;
    rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0, now: () => clock });
    const oneshot = rt.list()[0]!;
    const fire = nextFire(oneshot, clock)!;
    clock = fire.fireAt;
    await rt.tick();
    rt.takeInjection();
    const oneshotSelfDeleted = rt.list().length === 0 && isOneShotTask({ ...oneshot }) === true;
    rt.stop();

    // resume restore matrix: keep unexpired recurring + un-fired one-shots.
    const now = T0;
    const stale = { id: "dddddddd", sessionId: "s1", prompt: "stale", schedule: { type: "interval" as const, everyMs: 60 * MIN }, createdAt: now - CRON_EXPIRY_MS - MIN, expiresAt: now - MIN, lastFiredAt: now - 30_000 };
    const firedOnce = { id: "eeeeeeee", sessionId: "s1", prompt: "fired", schedule: { type: "cron" as const, expr: "0 9 * * *" }, createdAt: now - 2 * 24 * 60 * MIN, lastFiredAt: now - 24 * 60 * MIN };
    const live = { id: "ffffffff", sessionId: "s1", prompt: "live", schedule: { type: "interval" as const, everyMs: 60 * MIN }, createdAt: now - MIN };
    const unfired = { id: "gggggggg", sessionId: "s1", prompt: "later", schedule: { type: "cron" as const, expr: "0 11 * * *" }, createdAt: now - MIN };
    const pastDue = { id: "hhhhhhhh", sessionId: "s1", prompt: "pastdue", schedule: { type: "at" as const, at: now - 10 * MIN }, createdAt: now - 20 * MIN };
    ws = await writeCronFile(root, [stale, firedOnce, live, unfired, pastDue]);
    clock = now;
    rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0, now: () => clock });
    const kept = await rt.restoreOnResume();
    const resumeMatrix = kept.map((t) => t.id).sort();
    rt.stop();

    // ------------------------------------------------------------------ §2
    const loopGrammar = [
      { input: "30m", expect: 30 * MIN },
      { input: "2h", expect: 2 * HOUR },
      { input: "1d", expect: 86_400_000 },
      { input: "every 2 hours", expect: 2 * HOUR },
      { input: "every 45 minutes", expect: 45 * MIN },
      { input: "45s", expect: MIN }, // seconds carry up to a minute
      { input: "7m", expect: 5 * MIN }, // non-clean → nearest tier
      { input: "90m", expect: 2 * HOUR },
    ].map((c) => {
      const r = parseLoopInterval(c.input);
      return { input: c.input, ms: r.ok ? r.interval.ms : `ERR:${(r as { error: string }).error}` };
    });
    const roundedTold = parseLoopInterval("7m");
    const grammarOk = loopGrammar.every((g) => typeof g.ms === "number" && g.ms === (loopGrammar.find((x) => x.input === g.input)!.ms as number))
      && roundedTold.ok === true
      && (roundedTold.ok ? roundedTold.interval.note ?? "" : "").includes("5m");

    // maintenance-prompt discipline: the clauses ride the prompt, and a
    // scripted model NEVER fires a new-initiative task tool during a loop
    // round (it has tools available and uses none).
    const clausesPresent = MAINTENANCE_LOOP_PROMPT.includes("Do NOT open new initiatives")
      && MAINTENANCE_LOOP_PROMPT.includes("Irreversible actions are limited to continuing work already authorized in this transcript");
    const loopRoundModel = scriptedModel([{ role: "assistant", content: "nothing to do — board clean" }]);
    const disciplineTools = [
      buildTool({ name: "cron_create", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: "created" }) }),
      buildTool({ name: "write_file", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false }, execute: async () => ({ content: "wrote" }) }),
    ];
    const loopState: AgentState = { systemPrompt: "sp", messages: [{ role: "user", content: MAINTENANCE_LOOP_PROMPT }], tools: disciplineTools, status: "running" };
    let toolCallsInRound = 0;
    const gen0 = runAgentLoop(loopState, loopRoundModel, { maxTurns: 5, canUseTool: async () => ({ behavior: "allow" }) });
    let r0 = await gen0.next();
    while (!r0.done) {
      if (r0.value.type === "tool_call_started") toolCallsInRound += 1;
      r0 = await gen0.next();
    }
    const zeroToolCalls = toolCallsInRound === 0;
    const noNewInitiativeTools = zeroToolCalls
      && loopRoundModel.inputs[0]!.messages[0]!.content === MAINTENANCE_LOOP_PROMPT
      && grammarOk;

    // ------------------------------------------------------------------ §3
    const NOT_YET = "VERDICT: not-yet\nthe failing test is still red";
    const MET = "VERDICT: met\nall green";
    const IMPOSSIBLE = "VERDICT: impossible\nno such endpoint";
    const makeGoal = async (script: readonly string[]) => {
      const gws = await mkdtemp(join(root, "goal-"));
      const entries: unknown[] = [];
      const notices: string[] = [];
      const usage: { evaluatorTokens: number }[] = [];
      const messages: AgentMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "work" }];
      const controller = createGoalController({
        workspaceRoot: gws,
        sessionId: () => "s-goal",
        getMessages: () => messages,
        evaluator: { client: scriptedModel(script.map((v) => ({ role: "assistant", content: v }))), label: "eval", fallback: false },
        appendEntry: async (e) => {
          entries.push(e);
        },
        notify: (t) => notices.push(t),
        onEvaluatorUsage: (u) => usage.push({ evaluatorTokens: u.evaluatorTokens ?? 0 }),
        env: {},
      });
      return { controller, entries, notices, usage, messages, gws };
    };
    const g1 = await makeGoal([NOT_YET]);
    await g1.controller.set("goal one");
    const d1 = await g1.controller.onStop({ systemPrompt: "s", messages: g1.messages, tools: [], status: "idle" });
    const notYetBlocks = typeof d1 === "object" && "block" in d1 && d1.block === true && (d1 as { reason: string }).reason.includes("evaluator guidance");
    const g2 = await makeGoal([NOT_YET, MET]);
    await g2.controller.set("goal two");
    await g2.controller.onStop({ systemPrompt: "s", messages: g2.messages, tools: [], status: "idle" });
    const d2 = await g2.controller.onStop({ systemPrompt: "s", messages: g2.messages, tools: [], status: "idle" });
    const metAllows = d2 === "allow" && !g2.controller.active()
      && g2.entries.some((e) => (e as { type: string }).type === "goal_outcome" && (e as { data: { outcome: string } }).data.outcome === "achieved");
    const g3 = await makeGoal([NOT_YET, IMPOSSIBLE]);
    await g3.controller.set("goal three");
    await g3.controller.onStop({ systemPrompt: "s", messages: g3.messages, tools: [], status: "idle" });
    await g3.controller.onStop({ systemPrompt: "s", messages: g3.messages, tools: [], status: "idle" });
    const impossibleFails = !g3.controller.active()
      && g3.entries.some((e) => (e as { type: string }).type === "goal_outcome" && (e as { data: { outcome: string } }).data.outcome === "failed");
    // stall guard: capped run pauses + KEEPS the goal; the next prompt resumes.
    const g4 = await makeGoal([NOT_YET]);
    await g4.controller.set("goal four");
    await g4.controller.onStop({ systemPrompt: "s", messages: g4.messages, tools: [], status: "idle" });
    g4.controller.onRunEnd({ stopBlockCapped: true });
    const stallKeepsGoal = g4.controller.snapshot()?.paused === true && g4.controller.active();
    g4.controller.onUserPrompt();
    const promptResumes = g4.controller.snapshot()?.paused === false;
    // resume: counters reset.
    const g5 = await makeGoal([NOT_YET]);
    g5.controller.restoreFromEntries([buildGoalSetEntry("restored goal")]);
    const snap5 = g5.controller.snapshot();
    const countersReset = snap5?.condition === "restored goal" && snap5.evaluatedRounds === 0 && snap5.evaluatorTokens === 0;
    // evaluator token column in the turn_usage receipt fold.
    let totals = emptyUsageTotals();
    totals = recordUsage(totals, { promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100, completionTokens: 20, evaluatorTokens: 120 });
    totals = recordUsage(totals, { promptTokens: 500, cacheHitTokens: 400, cacheMissTokens: 100, completionTokens: 80 });
    const evaluatorColumn = totals.evaluatorTokens === 120 && formatCostReport(totals, { startedAt: Date.now() }).includes("评审：120 tokens"); // ω99-187: 钉随源演进
    // block cap at the loop level (the stall guard's official semantics).
    let capHookCalls = 0;
    const capModel = scriptedModel(Array.from({ length: 6 }, () => ({ role: "assistant" as const, content: "again" })));
    const capGen = runAgentLoop(
      { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "running" },
      capModel,
      { maxTurns: 30, hooks: { onRunStop: async () => { capHookCalls += 1; return { continue: false, reason: "more" }; } } },
    );
    let capResult = await capGen.next();
    while (!capResult.done) capResult = await capGen.next();
    const terminalCapped = (capResult.value as Terminal).stopBlockCapped === true;
    const enforced = capHookCalls === STOP_BLOCK_CAP + 1 && terminalCapped;

    // ------------------------------------------------------------- cache gate
    // A scheduled injection rides the steering channel BETWEEN turns; the
    // serialized prompt prefix (system + tools + prior messages) is
    // byte-identical before/after the scheduled activity.
    const cacheModel = scriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { role: "assistant", content: "saw the fire" },
      { role: "assistant", content: "done" },
    ]);
    const injection = "[scheduled task zzzzzzzz] SCHEDULED WORK";
    const cacheQueue = [injection];
    const cacheGen = runAgentLoop(
      { systemPrompt: "cache-sp", messages: [{ role: "user", content: "start" }], tools: [], status: "running" },
      cacheModel,
      { maxTurns: 10, steering: { take: () => cacheQueue.shift() } },
    );
    let cr = await cacheGen.next();
    while (!cr.done) cr = await cacheGen.next();
    const firstPrompt = serializePrompt(cacheModel.inputs[0]!);
    const secondPrompt = serializePrompt(cacheModel.inputs[1]!);
    const prefixStable = secondPrompt.startsWith(firstPrompt) && secondPrompt.length > firstPrompt.length;
    // The injection rode the BETWEEN-TURNS drain of the first model call — a
    // pure turn-tail append right after the opening prompt.
    const injectedMsg = cacheModel.inputs[0]!.messages.at(-1) as { role: string; content: string };
    const injectionAppended = injectedMsg.role === "user" && injectedMsg.content.includes("SCHEDULED WORK")
      && (cacheModel.inputs[0]!.messages[0] as { content: string }).content === "start";

    // ------------------------------------------------------------------ §4
    // Durable daemon: offline no-catch-up, online fire-once, ask-tier deny.
    const dws = await mkdtemp(join(root, "durable-"));
    const runs: readonly { prompt: string; workspace: string }[] = [];
    let runCalls = 0;
    const runLog: { type: string; data: Record<string, unknown> }[] = [];
    let dClock = T0 - 30 * MIN; // the task came due 30 minutes ago (offline)
    let daemon = await createScheduleDaemon({
      workspaceRoot: dws,
      now: () => dClock,
      tickMs: 0,
      env: {},
      runTask: async (task) => {
        runCalls += 1;
        (runs as { prompt: string; workspace: string }[]).push({ prompt: task.prompt, workspace: task.workspace });
        return { ok: true, exitCode: 0, output: "ran fine" };
      },
      appendRun: async (entry) => {
        runLog.push(entry);
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "durable check", createdFrom: "det48" });
    // The daemon restarts "now" — everything that came due offline fires ONCE.
    dClock = T0;
    const onlineFires = await daemon.tick();
    const onlineFireOnce = onlineFires.length === 1;
    await new Promise((r) => setTimeout(r, 30));
    // Further ticks (still within the same window) do NOT catch up again.
    const repeat = await daemon.tick();
    await new Promise((r) => setTimeout(r, 30));
    const offlineNoCatchup = repeat.length === 0 && runCalls === 1 && runLog.length === 1 && runLog[0]!.type === "schedule_run";
    daemon.stop();
    // at-schedule one-shots delete after their single fire.
    const daemon2 = await createScheduleDaemon({
      workspaceRoot: dws,
      now: () => dClock,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "" }),
    });
    await daemon2.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "one shot", createdFrom: "det48" });
    dClock = T0 + 6 * MIN;
    await daemon2.tick();
    await new Promise((r) => setTimeout(r, 20));
    daemon2.stop();
    const scheduledAsk = nonInteractiveAskDecision("write_file", { [SCHEDULE_RUN_ENV]: "1" });
    const plainAsk = nonInteractiveAskDecision("write_file", {});
    const askDenies = scheduledAsk.kind === "deny"
      && scheduledAsk.reason === "scheduled run: ask with no human \u2192 deny"
      && (scheduledAsk as { scheduledRun?: boolean }).scheduledRun === true
      && plainAsk.kind === "deny" && plainAsk.reason === "non-interactive";
    const parserCron = (() => {
      const r = parseScheduleCommand('add "*/10 * * * *" run tests');
      return r.kind === "add" && r.schedule.type === "cron" && r.prompt === "run tests";
    })();
    const parserAt = (() => {
      const r = parseScheduleCommand("add @2026-08-20T10:30 deploy");
      return r.kind === "add" && r.schedule.type === "at" && Number.isFinite(r.schedule.at);
    })();
    // symlink refusal + kill switch. Creating symlinks on win32 needs either
    // admin or Developer Mode — where neither is available the refusal lane
    // cannot be exercised for real, so it is skipped (evidence marks it
    // skipped; assertions accept the skip) instead of failing the suite.
    const realWs = await mkdtemp(join(root, "sym-"));
    await mkdir(join(realWs, ".wudao"), { recursive: true });
    const realFile = join(realWs, ".wudao", "real.json");
    await writeFile(realFile, "{}", "utf8");
    const canSymlink = await symlink(realFile, join(realWs, "probe-link"), "file").then(() => true, () => false);
    let symlinkRefused = false;
    let symlinkSkipped = false;
    if (canSymlink) {
      const symWs = await mkdtemp(join(root, "symtarget-"));
      await symlink(realFile, join(symWs, "cron.json"));
      const symLinkDir = await mkdtemp(join(root, "symdir-"));
      await symlink(symWs, join(symLinkDir, ".wudao"));
      const symRt = await createCronRuntime({ workspaceRoot: symLinkDir, sessionId: "s", tickMs: 0 });
      symlinkRefused = symRt.refusal === "symlink";
      symRt.stop();
    } else {
      symlinkSkipped = true;
    }
    const disRt = await createCronRuntime({ workspaceRoot: realWs, sessionId: "s", tickMs: 0, env: { WUDAO_DISABLE_CRON: "1" } });
    const disabled = disRt.refusal === "disabled" && (await disRt.createTask({ prompt: "p", schedule: { type: "interval", everyMs: MIN } }).catch(() => "refused")) === "refused";
    disRt.stop();

    // /loop + /goal driver end-to-end: one driver, one goal round.
    const dws2 = await mkdtemp(join(root, "drv-"));
    const store2 = createJsonlSessionStore(join(dws2, ".wudao", "sessions"));
    const driverModel = scriptedModel([
      { role: "assistant", content: "working" },
      { role: "assistant", content: "VERDICT: not-yet\nstill red" },
      { role: "assistant", content: "done" },
      { role: "assistant", content: "VERDICT: met\ngreen" },
    ]);
    // The evaluator rides the SAME scripted queue (fallback = session model):
    // loop answer, verdict, loop answer, verdict.
    const driverEvaluator = { client: driverModel, label: "scripted evaluator", fallback: false } as const;
    const driver = createAgentDriver({
      model: driverModel,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: async () => ({ kind: "allow" }),
      workspaceRoot: dws2,
      goal: true,
      sessionStore: store2,
      statusline: { model: "m", version: "0" },
      evaluatorOverride: driverEvaluator,
    });
    driver.submit("/goal acceptance condition");
    const t0 = Date.now();
    while (!driver.getHistory().some((h) => h.kind === "user" && h.text.includes("acceptance condition")) && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const t1 = Date.now();
    while (driver.getStatus().busy && Date.now() - t1 < 8000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const drvHistory = driver.getHistory();
    const goalRoundOk = drvHistory.some((h) => h.kind === "notice" && h.text.includes("MET"))
      && drvHistory.some((h) => h.kind === "user" && h.text.includes("acceptance condition"));
    // Read-point discipline (532419a family): the goal controller's entry
    // appends are DELIBERATELY fire-and-forget (goal.ts `void appendEntry…
    // catch`), so busy=false does NOT imply they landed — a single read
    // here raced the fs writes and lost deterministically under load
    // (release-gate 0.3.20 run 2). Poll for the CONTENT, bounded.
    let entryTypes: string[] = [];
    const t2 = Date.now();
    while (Date.now() - t2 < 2000) {
      const entries2 = await store2.loadSessionEntries(driver.getSessionId());
      entryTypes = entries2.filter((e) => !("role" in e)).map((e) => (e as { type: string }).type);
      if (entryTypes.includes("goal_set") && entryTypes.includes("goal_outcome")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const goalEntriesOk = entryTypes.includes("goal_set") && entryTypes.includes("goal_outcome");
    driver.dispose();

    return {
      fire: { onceWhenLate, idleOnly, noCatchup },
      jitter: { stable, oneshotEarlyBounded, recurringLateBounded, sameIdSameOffset },
      expiry: { finalFire, selfDeleted, oneshotSelfDeleted },
      resumeMatrix,
      loopGrammar,
      discipline: { clausesPresent, noNewInitiativeTools, zeroToolCalls },
      goal: { notYetBlocks, metAllows, impossibleFails, stallKeepsGoal, promptResumes, countersReset, evaluatorColumn: evaluatorColumn && goalRoundOk && goalEntriesOk },
      durable: { offlineNoCatchup, onlineFireOnce, askDenies, parserCron, parserAt },
      refusal: { symlink: symlinkRefused, disabled, ...(symlinkSkipped ? { symlinkSkipped } : {}) },
      cacheGate: { prefixStable, injectionAppended },
      cap: { enforced, terminalCapped },
    };
  },
  assertions: (e) => {
    const errors: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errors.push(what);
    };
    need(e.fire.onceWhenLate, "fire: a task 10 occurrences late must fire exactly once");
    need(e.fire.idleOnly, "fire: the injection must drain through the idle/between-turns lane");
    need(e.fire.noCatchup, "fire: later ticks must not stack another fire (no catch-up)");
    need(e.jitter.stable, "jitter: offsets must be deterministic per task id");
    need(e.jitter.oneshotEarlyBounded, "jitter: :00/:30 one-shots may fire at most 90s early");
    need(e.jitter.recurringLateBounded, "jitter: recurring fires at most min(30min, interval/2) late");
    need(e.jitter.sameIdSameOffset, "jitter: same id ⇒ same offset");
    need(e.expiry.finalFire, "expiry: an expired recurring task fires once more (expiry-final)");
    need(e.expiry.selfDeleted, "expiry: the final fire self-deletes the recurring task");
    need(e.expiry.oneshotSelfDeleted, "expiry: a one-shot self-deletes after its single fire");
    need(
      JSON.stringify(e.resumeMatrix) === JSON.stringify(["ffffffff", "gggggggg", "hhhhhhhh"]),
      `resume matrix: kept ${JSON.stringify(e.resumeMatrix)}, expected ffffffff/gggggggg/hhhhhhhh`,
    );
    const expectGrammar: readonly [string, number][] = [
      ["30m", 30 * MIN], ["2h", 2 * HOUR], ["1d", 86_400_000], ["every 2 hours", 2 * HOUR],
      ["every 45 minutes", 45 * MIN], ["45s", MIN], ["7m", 5 * MIN], ["90m", 2 * HOUR],
    ];
    for (const [input, ms] of expectGrammar) {
      const got = e.loopGrammar.find((g) => g.input === input)?.ms;
      need(got === ms, `loop grammar: "${input}" → ${String(got)}, expected ${ms}`);
    }
    need(e.discipline.clausesPresent, "discipline: the maintenance prompt must carry the no-new-initiatives and transcript-authorized-irreversible clauses");
    need(e.discipline.zeroToolCalls, "discipline: the scripted maintenance round fired zero tool calls");
    need(e.discipline.noNewInitiativeTools, "discipline: no new-initiative task tool fired in the loop round");
    need(e.goal.notYetBlocks, "goal: not-yet must block with the evaluator guidance");
    need(e.goal.metAllows, "goal: met must allow the stop, clear, and record achieved");
    need(e.goal.impossibleFails, "goal: impossible must clear and record failed");
    need(e.goal.stallKeepsGoal, "goal: the stall guard pauses and KEEPS the goal");
    need(e.goal.promptResumes, "goal: the next user prompt resumes evaluation");
    need(e.goal.countersReset, "goal: resume restores the goal with counters reset");
    need(e.goal.evaluatorColumn, "goal: evaluator tokens land in their own turn_usage column");
    need(e.cap.enforced, "cap: 3 consecutive no-tool continuations end the run (hook calls = cap+1)");
    need(e.cap.terminalCapped, "cap: the terminal carries stopBlockCapped");
    need(e.cacheGate.prefixStable, "cache gate: the serialized prefix must be byte-identical across scheduled activity");
    need(e.cacheGate.injectionAppended, "cache gate: the scheduled injection must be a pure turn-tail append");
    need(e.durable.onlineFireOnce, "durable: coming online fires a due-offline task exactly once");
    need(e.durable.offlineNoCatchup, "durable: subsequent ticks must not re-fire (no catch-up, one run logged)");
    need(e.durable.askDenies, "durable: a scheduled run's ask must deny fail-closed (no human present)");
    need(e.durable.parserCron, "durable: /schedule add \"<cron>\" parses");
    need(e.durable.parserAt, "durable: /schedule add @<ISO> parses");
    // win32 without Developer Mode cannot create symlinks — the refusal lane
    // is untestable there; record the skip as a NOTE, not a failure.
    if (e.refusal.symlinkSkipped !== true) need(e.refusal.symlink, "refusal: a symlinked cron.json path must be refused");
    need(e.refusal.disabled, "refusal: WUDAO_DISABLE_CRON=1 must disable the scheduler");
    return errors;
  },
  metrics: (e) => ({
    jitterChecks: ["stable", "oneshotEarlyBounded", "recurringLateBounded", "sameIdSameOffset"].filter((k) => (e.jitter as unknown as Record<string, boolean>)[k]).length,
    goalChecks: Object.values(e.goal).filter(Boolean).length,
    resumedTasks: e.resumeMatrix.length,
    grammarCases: e.loopGrammar.length,
  }),
};

