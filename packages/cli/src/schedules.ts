// M61 §4 — the durable scheduling daemon. The HOST is the `wudao ui`
// resident process: it owns `<workspace>/.wudao/schedules.json` (durable
// tasks: {cron|at, prompt, workspace, createdFrom}), ticks due-ness, and runs
// each due task as a HEADLESS ONE-SHOT in the task's own workspace (the same
// runReal path as `wudao -p`). Results append to the dedicated "schedules"
// session log and surface as a web statusline notification (driver.notify →
// history). Offline = no catch-up (a task that came due while the daemon was
// down fires ONCE on the next online — same semantics as §1). Security:
// durable prompts run at the ASK permission tier — a spawned headless run is
// non-interactive, so an ask denies (fail-closed, no human present; the
// WUDAO_SCHEDULE_RUN marker names it in the deny reason).
// ω99-5a (goose scheduler parity): pause/unpause/run verbs + the triggeredBy
// audit on every run. Negative rulings: (1) no job↔session foreign key — the
// trigger source is audited only as schedule_run.triggeredBy ("cron" |
// "manual") in the schedules session log; (2) no catch-up — unpause computes
// the next future fire, missed fires are not compensated. `paused` is an
// ADDITIVE store field: an older host re-saving the store drops it (one-way
// upgrade, accepted).
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextFire, parseCronExpr } from "@wudao/core";
import type { CronTask } from "@wudao/core";
import { cronDisabled } from "@wudao/core";
import { buildTool } from "@wudao/core";
import type { Tool } from "@wudao/core";
// 113-C1 — the runtime tier's persona door reuses the providers' persona
// registry (merged builtin/global/workspace — the REPL boot chain's loader).
import { loadPersonaRegistry, lookupPersona } from "@wudao/providers";
import { resolveGlobalHome } from "./settings-layer.js";
import {
  SCHEDULES_STORE_FILE, SCHEDULES_SESSION_ID, SCHEDULE_RUN_ENV, SCHEDULE_TICK_MS,
  SCHEDULE_BREAKER_FAILURES, SCHEDULE_RUN_TIMEOUT_MS, SCHEDULE_MIN_INTERVAL_MS, RUN_PREVIEW_CHARS,
  SCHEDULE_MISS_RETRY_DELAY_MS, SCHEDULE_MODEL_UNREACHED_MARKER,
  SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS, SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP,
  validWeekdays, validTimeOfDay, validDurable, SchedulesRefusedError,
  eventSourceError, validWatchPath, SCHEDULE_WEBHOOK_HOST, SCHEDULE_WEBHOOK_PORT_ENV,
  scheduleRuntimeError, validScheduleOriginSessionId, type ScheduleRuntimeOverrides,
  DEFER_IDLE_MAX_MINUTES, DEFER_IDLE_MIN_MINUTES,
} from "./schedules-model.js";
import type { DurableSchedule, DurableTask, StructuredSchedule, SchedulesStore, SchedulesFile, EventSource, ScheduleOrigin } from "./schedules-model.js";
import {
  durableNextFire, nextFireOf, structuredScheduleError, armMissRetry,
  isStructuredSchedule, computeNextRun, dueSchedules, applyMissedFire, describeScheduleHuman,
} from "./schedules-logic.js";
// 借鉴弧 ε — 事件触发源基座（file 盯梢 + webhook 回环监听）。
import { createEventSources, webhookPortOf } from "./schedules-events.js";
import type { EventSourcesHandle } from "./schedules-events.js";
// 122 项 1 — 临火睡眠守卫（等火期间不入睡；缺省 10min 窗，见模块头注）。
import { createNearFireGuard, nearestWakeAt } from "./schedules-sleep.js";
import type { NearFireGuard } from "./schedules-sleep.js";
import type { PreventSleepController } from "./prevent-sleep.js";
// 122 项 2 — LaunchAgent 离线唤起（min-wake 单 plist 同步；默认关）。
import { createLaunchAgentSync, nextCalendarOccurrence, parseLaunchAgentPlist, startCalendarIntervalOf } from "./schedules-launchagent.js";
import type { LaunchAgentSync, LaunchctlRunner, LaunchAgentOutcome } from "./schedules-launchagent.js";
import { randomBytes } from "node:crypto";
// v7 γ2——终态成因词表 + 失败指纹账本（「怎么结束」的姊妹车道）。
import { describeRunEndCause } from "./run-end-cause.js";
import { appendFailureEvent, buildObservedEvent, failureFingerprintPath } from "./failure-fingerprints.js";
// 127 项 2（F1）— origin 会话占用探针的判据源（活 pid 在持 = 占用；本宿主
// 进程自己持有同样算——spawn 出去的子进程 boot 租约对谁都拒）。
import { sessionLeaseAlive } from "./driver/session-delete.js";


// ---------------------------------------------------------------------------
// ω99 拆分运动 弧 B re-export 门面——保原 schedules.js 公共面（域模型→
// schedules-model.ts；纯调度逻辑→schedules-logic.ts；命令/读面→
// schedules-command.ts；工具面→schedules-tools.ts）。
// ---------------------------------------------------------------------------
export {
  SCHEDULES_STORE_FILE, SCHEDULES_SESSION_ID, SCHEDULE_RUN_ENV,
  SCHEDULE_TICK_MS, SCHEDULE_BREAKER_FAILURES, SCHEDULE_RUN_TIMEOUT_MS, SCHEDULE_MIN_INTERVAL_MS,
  SCHEDULE_MISS_RETRY_DELAY_MS, SCHEDULE_MODEL_UNREACHED_MARKER,
  SCHEDULE_EVENT_DEBOUNCE_MS, SCHEDULE_WEBHOOK_HOST, SCHEDULE_WEBHOOK_DEFAULT_PORT,
  SCHEDULE_WEBHOOK_PORT_ENV, SCHEDULE_WEBHOOK_BODY_CAP, SCHEDULE_NEAR_FIRE_GUARD_MS,
  SCHEDULE_LAUNCHAGENT_LABEL, SCHEDULE_LAUNCHAGENT_PLIST_FILE, SCHEDULE_LAUNCHAGENT_APP_NAME,
  SCHEDULE_WAKE_ARG, SCHEDULE_WAKE_ENV,
  SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS, SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP,
  validWatchPath, eventSourceError,
} from "./schedules-model.js";
export type { DurableSchedule, StructuredSchedule, DurableTask, EventSource, EventSourceInput, AddableSchedule, ScheduleRuntimeOverrides, ScheduleOrigin } from "./schedules-model.js";
export { DEFER_IDLE_DEFAULT_MINUTES, DEFER_IDLE_MIN_MINUTES, DEFER_IDLE_MAX_MINUTES } from "./schedules-model.js";
/** 131 弧 — 闲时火的车道旗标（spawn 子进程读）：本轮无人值守且为 defer
 * 火时置 1——defer_task/schedule_add/continue_task 三工具面据此拒绝（防
 * 递归：闲时任务不得再排任务）。与 SCHEDULE_RUN_ENV 并列（后者管权限
 * ask 姿态，前者管排程递归）。 */
export const DEFER_RUN_ENV = "WUDAO_DEFER_RUN";
export { SchedulesRefusedError, scheduleRuntimeError, SCHEDULE_RUNTIME_EFFORTS, validScheduleOriginSessionId } from "./schedules-model.js";
export type { SchedulesStore } from "./schedules-model.js";
export { createEventSources, armableEventTask, webhookPortOf } from "./schedules-events.js";
export type { EventSourcesHandle } from "./schedules-events.js";
export { createNearFireGuard, nearestWakeAt } from "./schedules-sleep.js";
export type { NearFireGuard } from "./schedules-sleep.js";
export {
  createLaunchAgentSync, parseScheduleWakeArgv, scheduleWakeRequested,
  renderLaunchAgentPlist, parseLaunchAgentPlist, launchAgentMinuteOf,
  startCalendarIntervalOf, nextCalendarOccurrence,
} from "./schedules-launchagent.js";
export type { LaunchAgentSync, LaunchctlRunner, LaunchAgentOutcome, LaunchAgentSyncOptions } from "./schedules-launchagent.js";
export {
  durableNextFire, structuredScheduleError, armMissRetry,
  isStructuredSchedule, computeNextRun, dueSchedules, applyMissedFire,
  describeScheduleHuman, nextFireOf,
} from "./schedules-logic.js";
export type { MissedFireOutcome } from "./schedules-logic.js";
export { parseScheduleCommand, parseScheduleRuntime, scheduleRowsOf, lastRunsOf } from "./schedules-command.js";
export type { ScheduleCommand, ScheduleListRow, ScheduleLastRun, ScheduleActionResult } from "./schedules-command.js";
export { createScheduleTools } from "./schedules-tools.js";
export type { ScheduleToolFace } from "./schedules-tools.js";


/** Race a run promise against the timeout. Pure helper (exported for tests). */
export function runWithTimeout<T>(
  run: Promise<T>,
  ms: number,
  onTimeout: () => T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    timer.unref?.();
    run.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

/** Load (or create) the durable store. Refuses the kill-switch env and a
 *  symlinked path; other IO errors propagate; missing file → empty store. */
export async function loadSchedulesStore(opts: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<SchedulesStore> {
  if (cronDisabled(opts.env ?? {})) throw new SchedulesRefusedError("disabled", "");
  const dir = join(opts.workspaceRoot, ".wudao");
  const path = join(dir, SCHEDULES_STORE_FILE);
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new SchedulesRefusedError("symlink", path);
  let tasks: DurableTask[] = [];
  let discardedAtLoad = 0;
  if (info !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SchedulesFile>;
      if (Array.isArray(parsed.tasks)) {
        tasks = parsed.tasks.map(validDurable).filter((t): t is DurableTask => t !== undefined);
        // ω99-322: the silent filter gets a voice — count what it dropped.
        discardedAtLoad = parsed.tasks.length - tasks.length;
      }
    } catch {
      tasks = [];
    }
  }
  return {
    tasks,
    discardedAtLoad,
    save: async (next) => {
      await mkdir(dir, { recursive: true });
      const body = `${JSON.stringify({ version: 1, tasks: next } satisfies SchedulesFile, null, 2)}\n`;
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
    },
  };
}


// ---------------------------------------------------------------------------
// The one-shot runner (the headless runReal path, as a subprocess)
// ---------------------------------------------------------------------------

export interface ScheduleRunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly output: string;
  /** v7 γ2——终态成因：超时 kill 车道带 "schedule-timeout"（词表在
   *  run-end-cause.ts）；正常结束/命令自身失败缺席（exitCode 已说尽）。
   *  可选、additive——旧 runner 注入面零演进。 */
  readonly endCause?: import("./run-end-cause.js").RunEndCause;
}

/** The default runner: `node <cli> -p <prompt>` in the task's workspace, a
 *  non-TTY headless run whose permission gate sits at the ASK tier and DENIES
 *  every ask (fail-closed — no human is present; WUDAO_SCHEDULE_RUN=1 names
 *  it in the deny reason).
 *  113-C1（qm #1593 形）: a task carrying a `runtime` tier hands it to the
 *  child through the SAME resolution chain a human `wudao --provider X
 *  --model Y` run uses (parseSessionFlags → buildRunPlan, alongside
 *  storedModelDefaults) — provider/model/effort as argv flags, persona via
 *  the bootstrap chain's own WUDAO_PERSONA env. Absent tier → argv/env
 *  byte-identical to the pre-113 spawn. */
export function scheduleRuntimeFlags(runtime: ScheduleRuntimeOverrides | undefined): string[] {
  if (runtime === undefined) return [];
  return [
    ...(runtime.provider !== undefined && runtime.provider !== "" ? ["--provider", runtime.provider] : []),
    ...(runtime.model !== undefined && runtime.model !== "" ? ["--model", runtime.model] : []),
    ...(runtime.effort !== undefined ? ["--reasoning-effort", runtime.effort] : []),
  ];
}

/** 113-C1: the spawn env's runtime additions (WUDAO_PERSONA only — the
 *  bootstrap persona chain reads it; no CLI flag exists for it). */
export function scheduleRuntimeEnv(
  runtime: ScheduleRuntimeOverrides | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return runtime?.persona !== undefined && runtime.persona !== ""
    ? { ...env, WUDAO_PERSONA: runtime.persona }
    : env;
}

/** 121 项 2 — the origin lane's fired-turn text: 「[定时续跑] {hint ?? prompt}」.
 *  Pure. The prefix names the lane to the MODEL (it is resuming a conversation
 *  it knows — the line tells it WHY it is waking up mid-thread) and to the
 *  receipts. */
export const SCHEDULE_ORIGIN_PROMPT_PREFIX = "[定时续跑]";
/** 131 弧 — defer（闲时）火的 origin 前缀：告诉模型它在一个无人值守的
 *  闲时轮里醒来（别问问题——没人应答；ask_user 的错误路径会自决）。 */
export const DEFER_ORIGIN_PROMPT_PREFIX = "[闲时任务]";

export function originResumePrompt(task: DurableTask): string {
  if (task.schedule.type === "idle") {
    return `${DEFER_ORIGIN_PROMPT_PREFIX} ${task.origin !== undefined && task.origin.contextHint !== undefined && task.origin.contextHint.trim() !== "" ? task.origin.contextHint : task.prompt}`;
  }
  const origin = task.origin;
  if (origin === undefined) return task.prompt;
  return `${SCHEDULE_ORIGIN_PROMPT_PREFIX} ${origin.contextHint !== undefined && origin.contextHint.trim() !== "" ? origin.contextHint : task.prompt}`;
}

/** The default origin-existence probe: the session file the one-shot's
 *  resolveSession would read (same source of truth, one stat). */
export function defaultOriginSessionExists(sessionId: string, workspace: string): boolean {
  return existsSync(join(workspace, ".wudao", "sessions", `${sessionId}.jsonl`));
}

/** 127 项 3（F2）— the bound-session continue lane's typed refusal (the
 *  driver's continueSession returns it additively; `settled` is NOT a
 *  refusal-to-disclose — 「有未完尾才续，否则全新跑」是绑定语义的既有承诺). */
export type ScheduleContinueRefusal = "busy" | "not_found" | "settled" | "shape";

/** 127 项 2（F1）— the default origin-occupancy probe: the lease file the
 *  spawned child's own boot would hit (<workspace>/.wudao/sessions/.leases/
 *  <id>.json — sessionLeaseAlive's law: a LIVE holder pid means occupied,
 *  this host process itself included). Occupied means the child's
 *  resolveSession + boot-lease would refuse and exit(1) — probing first
 *  turns that guaranteed failure into a notified skip (no breaker food). */
export function defaultOriginSessionOccupied(sessionId: string, workspace: string): Promise<boolean> {
  return sessionLeaseAlive(join(workspace, ".wudao", "sessions"), sessionId);
}

export function spawnScheduleRun(
  task: DurableTask,
  env: NodeJS.ProcessEnv = process.env,
  seams: { readonly timeoutMs?: number; readonly entryPath?: string } = {},
): Promise<ScheduleRunResult> {
  const timeoutMs = seams.timeoutMs ?? SCHEDULE_RUN_TIMEOUT_MS;
  // dist/schedules.js → dist/index.js (the CLI entry).
  const cliEntry = seams.entryPath ?? join(dirname(fileURLToPath(import.meta.url)), "index.js");
  let out = "";
  // 121 项 2 — the origin lane: resume the originating session instead of a
  // fresh headless run. `--resume <id>` rides the SAME one-shot resolveSession
  // chain a human `wudao --resume X "prompt"` uses (JSONL replay, warm prefix
  // — quota-park continueSession's cross-process twin, durable across app
  // restarts because the store IS the truth). The origin-less argv stays
  // byte-identical to the pre-121 spawn (pinned by tests).
  const argv = task.origin !== undefined
    ? [cliEntry, originResumePrompt(task), "--resume", task.origin.sessionId, ...scheduleRuntimeFlags(task.runtime)]
    : [cliEntry, "-p", task.prompt, ...scheduleRuntimeFlags(task.runtime)];
  const child = spawn(
    process.execPath,
    argv,
    {
      cwd: task.workspace,
      env: scheduleRuntimeEnv(
        task.runtime,
        { ...env, [SCHEDULE_RUN_ENV]: "1", ...(task.schedule.type === "idle" ? { [DEFER_RUN_ENV]: "1" } : {}) },
      ),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (d: Buffer) => {
    out += d.toString();
  });
  child.stderr.on("data", (d: Buffer) => {
    out += d.toString();
  });
  // Re-review item 5: the kill rides the ONE timeout implementation —
  // spawnScheduleRun routes through runWithTimeout exactly like any other
  // bounded run (the seam makes the real kill path testable).
  return runWithTimeout(
    new Promise<ScheduleRunResult>((resolve) => {
      child.on("error", (err) => resolve({ ok: false, exitCode: null, output: `spawn 失败：${err.message}` })); // ω99-185: #1
      child.on("close", (code) => resolve({ ok: code === 0, exitCode: code, output: truncateTailSafe(out, RUN_PREVIEW_CHARS) }));
    }),
    timeoutMs,
    () => {
      child.kill("SIGKILL");
      return {
        ok: false,
        exitCode: null,
        output: `${truncateTailSafe(out, RUN_PREVIEW_CHARS)}\n[计划任务运行 ${Math.max(1, Math.round(timeoutMs / 60_000))} 分钟超时——已终止]`, // ω99-185: #2
        // v7 γ2：kill 有回执——结构化成因随结果走（output 尾巴一行文本只是
        // 人读面；台账/指纹消费 endCause 字段）。
        endCause: "schedule-timeout" as const,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// The daemon
// ---------------------------------------------------------------------------

export interface ScheduleDaemon {
  /** One due-check now (the timer calls this; tests call it directly). */
  tick(now?: number): Promise<readonly DurableTask[]>;
  /** Add a durable task. Returns the notice text. */
  add(input: ScheduleAddInput): Promise<string>;
  /** Remove by id. */
  rm(id: string): Promise<string>;
  /** ω99-5a: run a task now (goose run_now — refuses a run already in
   *  flight; a manual run never advances the schedule). ω99-317: the
   *  management face adds two guards — a busy-session refusal (a bound task
   *  refuses while the host is mid-run, the 313 continue-lane skip semantics
   *  brought to the manual lane) and the explicit breaker re-open flag
   *  (resetBreaker on a disabled task clears the count and re-opens it
   *  before firing — 「连败 N 次已熔断，仍要试跑？」的复位口). */
  runNow(id: string, flags?: { readonly resetBreaker?: boolean }): Promise<string>;
  /** ω99-5a: pause (refuses a running task — the run finishes on its own). */
  pause(id: string): Promise<string>;
  /** ω99-5a: unpause (next future fire per schedule; no catch-up). ω99-313:
   *  also re-opens a breaker-disabled task (enabled:false → true) — the
   *  「连败熔断后去 /schedule 重新打开」 path. */
  unpause(id: string): Promise<string>;
  /** ω99-313: snooze a reminder — re-arm it N minutes out (default: its own
   *  snoozeMinutes, else 10). Works on a pending reminder (delays it) and on
   *  a fired one inside its snooze window (re-rings); non-reminders refuse. */
  snooze(id: string, minutes?: number): Promise<string>;
  /** 借鉴弧 ε — webhook 任务的地址回执（curl 一行：端口+token）。监听未
   *  起来（端口被占）→ ⚠️ 行如实；非 webhook 任务拒答。 */
  webhookLine(id: string): Promise<string>;
  /** The listing text. */
  listText(): string;
  /** 127 项 1 — the structured read for the continue_task tool face: the
   *  daemon's LIVE table (the single-host truth — never a re-read of the
   *  file on disk, which an in-flight snapshot would have overwritten
   *  anyway). A defensive copy; rows are immutable. */
  list(): readonly DurableTask[];
  /** The /doctor node (daemon hosted, task count, next due). */
  doctorLine(): string;
  stop(): void;
  readonly refusal?: string;
  /** 121 项 2 — the LIVE session read for the tool face (the daemon object IS
   *  the ScheduleToolFace the session engine threads to schedule_add; the ui
   *  host late-binds this AFTER the driver exists — execute-time reads see
   *  the current session, post-resume rotations included). Absent = no
   *  origin stamping (tests/embedders). */
  liveSessionId?: () => string | undefined;
}

/** ω99-313 — the add face: the structured family + the task/reminder split.
 *  借鉴弧 ε — schedule 收 AddableSchedule（webhook 事件源不带 token——
 *  守护生成，token 从不出现在调用方参数里）。 */
export interface ScheduleAddInput {
  readonly schedule: import("./schedules-model.js").AddableSchedule;
  readonly prompt: string;
  readonly workspace?: string;
  readonly createdFrom?: string;
  /** "task" (default) runs the prompt; "reminder" notifies with ZERO model
   *  requests (the light path). */
  readonly kind?: "task" | "reminder";
  /** Bind fires to a session (unfinished tail → continue; else fresh run). */
  readonly sessionId?: string;
  /** 121 项 2 — agent 自设章（schedule_add 工具面自动盖）：fire 的 spawn
   *  车道 resume 该会话（跨重启 durable）。形状门在 add 门口（坏形状拒收，
   *  非静默丢弃——与 runtime 档位同纪律）。 */
  readonly origin?: ScheduleOrigin;
  /** Per-fire token ceiling (stored + surfaced; v1 spawn path stores it —
   *  the honest-debt note lives in the ω99-313 report). */
  readonly budgetTokens?: number;
  /** 113-C1（qm #1593 形）— the per-task runtime tier (model/provider/persona/
   *  effort). Typed-checked at the door (union + non-empty + persona registry);
   *  consumed ONLY by the spawn lane (fresh headless driver startup). */
  readonly runtime?: ScheduleRuntimeOverrides;
  /** The reminder's default snooze length in minutes. */
  readonly snoozeMinutes?: number;
}

export interface ScheduleDaemonOptions {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  readonly tickMs?: number;
  /** Results append to the "schedules" session log (host workspace). */
  readonly appendRun?: (entry: { type: "schedule_run"; data: Record<string, unknown> }) => Promise<void>;
  /** The web statusline notification channel (driver.notify → history). */
  readonly notify?: (line: string) => void;
  /** Injectable runner (tests script it; default = spawnScheduleRun). */
  readonly runTask?: (task: DurableTask) => Promise<ScheduleRunResult>;
  /** ω99-313 — the bound-session continue seam (the ui host late-binds it to
   *  driver.continueSession). started:true means the fire RIDES that
   *  session's pending continuation (same request prefix — the cache law);
   *  started:false falls back to a fresh headless run. 127 项 3（F2）: the
   *  additive `refused` reason names WHY (busy/not_found/settled/shape) so
   *  the degrade to a fresh spawn can be disclosed honestly — `settled` is
   *  the binding's own designed fallback (unfinished tail only), never a
   *  failure to notify about. */
  readonly continueRun?: (sessionId: string) => Promise<{ readonly started: boolean; readonly refused?: ScheduleContinueRefusal }>;
  /** ω99-313 — the busy read (late-bound to !driver.isIdle()). A cron fire
   *  landing while the host is mid-run SKIPS the occurrence (notified,
   *  schedule advanced) instead of forking a duplicate run. */
  readonly isBusy?: () => boolean;
  /** 131 弧 — the idle-eligibility read (late-bound): the epoch ms of the
   *  host's LAST user-visible activity (a submit / a permission answer / a
   *  run settle). A defer (idle) task fires only when now - lastActivity >=
   *  its idleMinutes. Absent (headless hosts / tests) = degrade to the busy
   *  check alone — the earliest-fire clock (nextRunAt) still bounds it. */
  readonly lastActivityAt?: () => number;
  /** 121 项 2 — origin 会话存在性探针（fire 时降级判据）：缺省读
   *  `<workspace>/.wudao/sessions/<id>.jsonl` 的存在（resolveSession 的同源
   *  事实）；测试注入。会话不在（清理/手编行）→ 剥掉 origin 按全新 spawn
   *  跑 + 回执说明，绝不因为出生地丢了就不跑。 */
  readonly originSessionExists?: (sessionId: string, workspace: string) => boolean;
  /** 127 项 2（F1）— origin 会话占用探针（fire 前判据）：缺省读
   *  `<workspace>/.wudao/sessions/.leases/<id>.json` 的活持有者
   *  （defaultOriginSessionOccupied；测试注入）。占用（活 pid 在持——含本
   *  宿主进程自己）→ 本次火跳过（通知 + 台账 mode="skipped" + `at` 火
   *  重排 +2min 帽 5），绝不喂熔断——子进程的 boot 租约对谁都拒，
   *  spawn 是注定失败的白烧。 */
  readonly originSessionOccupied?: (sessionId: string, workspace: string) => Promise<boolean>;
  /** 借鉴弧 ε — 事件源测试缝（防抖窗/固定端口/时钟）；生产面走缺省。 */
  readonly eventSeams?: {
    readonly debounceMs?: number;
    readonly webhookPort?: number;
  };
  /** 122 项 1 — 临火睡眠守卫的可注入面：controller 让测试观察 refCount；
   *  缺省 = 进程级共享 controller（与 driver 的活跃 run 守卫按 refCount
   *  叠加——夜移 028 的多驱动合成律，测试环境整体 env 门控关）。 */
  readonly preventSleep?: PreventSleepController;
  /** 临火窗（ms；0=关）。缺省 SCHEDULE_NEAR_FIRE_GUARD_MS（10min）；生产面
   *  由 ui 宿主从 settings 的 schedules.sleepGuardMs 读入后传入。 */
  readonly nearFireGuardMs?: number;
  /** 122 项 2 — LaunchAgent 离线唤起（fail-closed 家族：缺省 undefined =
   *  完全关——不读设置、不碰 ~/Library/LaunchAgents、零行为变化）。
   *  生产面由 ui 宿主传入 readEnabled（live 读 settings 的
   *  schedules.launchAgent——设置页开关落地后 ≤ 一个 tick 内生效，无需重
   *  启）；测试用 enabled 钉死 + homeDir/launchctl 假件。 */
  readonly launchAgent?: ScheduleLaunchAgentDaemonOptions;
}

/** 122 项 2 — the daemon-side LaunchAgent face. The sync target is
 *  nearestWakeAt min-only (see schedules-launchagent.ts's module head);
 *  reconcile fires at every persist + boot + tick, idempotent (byte-equal
 *  plist = no write, no launchctl). */
export interface ScheduleLaunchAgentDaemonOptions {
  /** Test seam: pin the resolved bit. */
  readonly enabled?: boolean;
  /** Production: live read of schedules.launchAgent (layered settings);
   *  a throw reads as off (fail-closed — no system footprint on
   *  uncertainty). */
  readonly readEnabled?: () => boolean | Promise<boolean>;
  readonly homeDir?: string;
  readonly platform?: string;
  readonly launchctl?: LaunchctlRunner;
}


/** The listing text for a task list (shared by the daemon and the REPL's
 *  read-only /schedule list). */
export function formatDurableList(tasks: readonly DurableTask[], now: () => number = Date.now): string {
  if (tasks.length === 0) return "无持久任务（.wudao/schedules.json）"; // ω99-185: #4
  const lines = tasks.map((t) => {
    const sched = t.schedule.type === "cron"
      ? t.schedule.expr
      : t.schedule.type === "at"
        ? `@${new Date(t.schedule.at).toISOString()}`
        : describeScheduleHuman(t.schedule); // ω99-313: 每周一、周三 09:00 人话形
    const fire = nextFireOf(t, now());
    const paused = t.paused === true; // ω99-5a: ⏸/(paused) markers
    const disabled = t.enabled === false && !paused; // ω99-313: breaker ⛔
    const kindTag = t.kind === "reminder" ? " ⏰提醒" : ""; // ω99-313
    // 借鉴弧 α3: a pending miss-retry names itself (「为什么这个点会跑一次」在列表上有答案).
    const retryTag = t.missRetryAt !== undefined ? ` · 补跑 ${new Date(t.missRetryAt).toISOString()}` : "";
    // 113-C1: the runtime tier names itself (the cheap model the night cron
    // runs on is a fact the list should say out loud).
    const runtimeTag = t.runtime !== undefined
      ? ` · 档位 ${[t.runtime.provider, t.runtime.model, t.runtime.persona, t.runtime.effort].filter((s) => s !== undefined && s !== "").join("/")}`
      : "";
    // 借鉴弧 ε: event 行没有「下次」——「等信号」就是它的待命态。
    const nextText = paused ? "已暂停" : fire === undefined ? (t.schedule.type === "event" ? "等信号" : "无") : new Date(fire).toISOString();
    return `- ${paused ? "⏸ " : disabled ? "⛔ " : ""}${t.id}${paused ? "（已暂停）" : ""}${disabled ? "（已停用——连续没跑成）" : ""}${kindTag}: ${sched} · 位于 ${t.workspace} · 来源 ${t.createdFrom} · 下次：${nextText}${retryTag}${runtimeTag}\n  prompt: ${truncateSafe(t.prompt, 120)}`; // ω99-185: #5 #6
  });
  return `持久任务（${tasks.length} 条）：\n${lines.join("\n")}`; // ω99-185: #7
}

export async function createScheduleDaemon(opts: ScheduleDaemonOptions): Promise<ScheduleDaemon> {
  const now = opts.now ?? Date.now;
  const run = opts.runTask ?? ((task: DurableTask) => spawnScheduleRun(task, opts.env ?? process.env));
  if (cronDisabled(opts.env ?? {})) {
    // 122 项 2 — the kill-switch also disarms the system footprint: an
    // opted-in LaunchAgent waking the app for a DISABLED scheduler is a
    // user-visible no-op. Best-effort removal (fail-open — the inert
    // daemon must still construct; a leftover plist just opens an app that
    // honestly reports 持久调度已禁用).
    if (opts.launchAgent !== undefined) {
      const agent = createLaunchAgentSync({
        ...(opts.launchAgent.homeDir !== undefined ? { homeDir: opts.launchAgent.homeDir } : {}),
        ...(opts.launchAgent.platform !== undefined ? { platform: opts.launchAgent.platform } : {}),
        ...(opts.launchAgent.launchctl !== undefined ? { launchctl: opts.launchAgent.launchctl } : {}),
      });
      void agent.sync(undefined).catch(() => {});
    }
    const inert: ScheduleDaemon = {
      tick: async () => [],
      add: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: 披露面 #8 同族（面表漏列，钉 :137 红兜出）
      rm: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: 披露面 #8 同族（面表漏列，钉 :137 红兜出）
      runNow: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: 披露面 #8 同族（面表漏列，钉 :137 红兜出）
      pause: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: 披露面 #8 同族（面表漏列，钉 :137 红兜出）
      unpause: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: 披露面 #8 同族（面表漏列，钉 :137 红兜出）
      snooze: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-313: 同族披露面
      webhookLine: async () => "⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）", // 借鉴弧 ε：同族披露面
      list: () => [], // 127 项 1：同族披露面——禁用态没有表
      listText: () => "持久调度已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: #8
      doctorLine: () => "schedules：已禁用（WUDAO_DISABLE_CRON=1）", // ω99-185: #9
      stop: () => {},
      refusal: "disabled",
    };
    return inert;
  }
  let store: SchedulesStore;
  try {
    store = await loadSchedulesStore({ workspaceRoot: opts.workspaceRoot, env: opts.env });
  } catch (err) {
    if (err instanceof SchedulesRefusedError) {
      const reason = err.message;
      return {
        tick: async () => [],
        add: async () => `⚠️ ${reason}`,
        rm: async () => `⚠️ ${reason}`,
        runNow: async () => `⚠️ ${reason}`,
        pause: async () => `⚠️ ${reason}`,
        unpause: async () => `⚠️ ${reason}`,
        snooze: async () => `⚠️ ${reason}`,
        webhookLine: async () => `⚠️ ${reason}`,
        list: () => [], // 127 项 1：refused 态没有表
        listText: () => reason,
        doctorLine: () => `schedules：不可用（${reason}）`, // ω99-185: #10
        stop: () => {},
        refusal: err.message.includes("symlink") ? "symlink" : "disabled",
      };
    }
    throw err;
  }
  // ω99-322 — the load dropped invalid rows: silent data loss becomes ONE
  // startup notice on the notify channel (the ledger is best-effort; knowing
  // "N tasks vanished" is a hard promise). The two read-only callers
  // (agent-driver's schedulesList / the REPL list) carry no notify — they
  // simply ignore the additive field.
  if (store.discardedAtLoad > 0) {
    opts.notify?.(`⏳ 有 ${store.discardedAtLoad} 条定时任务无法读取，已忽略——存储文件里可能有改坏的条目`);
  }
  let tasks: DurableTask[] = [...store.tasks];
  // ω99-313: serialize the store saves. Two fires landing in ONE tick (a
  // batch of due reminders, a fire racing the breaker step) used to collide
  // on the shared tmp-then-rename path — the loser's rename hit ENOENT and
  // its snapshot silently never reached disk. The tail chain queues every
  // whole-table snapshot in call order (cron.ts ω-1's saveTail idiom).
  let saveTail: Promise<void> = Promise.resolve();
  // 借鉴弧 ε — 事件源基座（file 盯梢 + webhook 监听）。在 persist 之前
  // 声明、在 launchRun 之后装配：每次表落盘后 reconcile 重武装（add 新
  // 盯、rm/pause/熔断即时退场——「默认关」是结构性的：没有生效的 webhook
  // 任务就没有 socket）。
  let sources: EventSourcesHandle | undefined;
  // 122 项 1 — 临火睡眠守卫：派生态同步（persist/tick/boot 每处都调，
  // 幂等）。持有纪律见 schedules-sleep.ts 模块头——只动自己那一票。
  const sleepGuard: NearFireGuard = createNearFireGuard({
    now,
    ...(opts.preventSleep !== undefined ? { controller: opts.preventSleep } : {}),
    ...(opts.nearFireGuardMs !== undefined ? { nearFireMs: opts.nearFireGuardMs } : {}),
  });
  // 122 项 2 — LaunchAgent 离线唤起：min-wake 单 plist 同步（缺省关 =
  // agentSync undefined，零足迹）。reconcile 在 persist/boot/tick 尾部都
  // 调（幂等：字节相同不写不 reload）；调用 fire-and-forget + 尾链串行
  // （launchctl spawn 绝不挡火车道）。设置经 readEnabled 每轮 live 读——
  // 设置页开关落地后 ≤ 一个 tick 生效，无需重启。失败 → 一次 notify（同
  // 错不重复）+ /doctor ⚠️，下轮自愈重试。
  const agentSync: LaunchAgentSync | undefined = opts.launchAgent === undefined ? undefined : createLaunchAgentSync({
    now,
    ...(opts.launchAgent.homeDir !== undefined ? { homeDir: opts.launchAgent.homeDir } : {}),
    ...(opts.launchAgent.platform !== undefined ? { platform: opts.launchAgent.platform } : {}),
    ...(opts.launchAgent.launchctl !== undefined ? { launchctl: opts.launchAgent.launchctl } : {}),
  });
  type AgentView =
    | { readonly kind: "off" }
    | { readonly kind: "unsupported" }
    | { readonly kind: "on"; readonly nextWakeAt?: number; readonly failure?: string };
  let agentView: AgentView = { kind: "off" };
  let agentTail: Promise<void> = Promise.resolve();
  // launchd 的日历格每日重复——「下次系统唤起」从 now 起算下一次 H:M，
  // 而不是写盘时的那一格（一天后显示的必须是明天的同一时刻）。
  const nextWakeOfMinute = (minuteAt: number, at: number): number => {
    const { Hour, Minute } = startCalendarIntervalOf(minuteAt);
    return nextCalendarOccurrence(Hour, Minute, at);
  };
  const syncLaunchAgent = (): void => {
    if (agentSync === undefined) return;
    agentTail = agentTail
      .then(async () => {
        let enabled = false;
        if (opts.launchAgent?.readEnabled !== undefined) {
          try {
            enabled = await opts.launchAgent.readEnabled();
          } catch {
            enabled = false; // fail-closed：读不到设置就不碰系统足迹
          }
        } else {
          enabled = opts.launchAgent?.enabled === true;
        }
        const nearest = nearestWakeAt(tasks, now());
        const outcome: LaunchAgentOutcome = await agentSync.sync(enabled ? nearest : undefined);
        if (outcome.kind === "unsupported") {
          agentView = { kind: "unsupported" };
          return;
        }
        if (!enabled) {
          agentView = { kind: "off" };
          return;
        }
        if (outcome.kind === "failed") {
          if (agentView.kind !== "on" || agentView.failure !== outcome.error) {
            opts.notify?.(`⚠️ 离线唤起设置失败（下次到点仍会在应用开着时执行）：${outcome.error}`);
          }
          agentView = { kind: "on", ...(agentView.kind === "on" ? agentView : {}), failure: outcome.error };
          return;
        }
        if (outcome.kind === "written" || outcome.kind === "current") {
          agentView = { kind: "on", nextWakeAt: nextWakeOfMinute(outcome.at, now()) };
          return;
        }
        // held（火正发射中——plist 未动，格子仍是旧值）/ noop / removed（无
        // 待唤起任务）：从盘上读回格子补全显示，读不到就如实说无。
        const xml = await agentSync.readback();
        const parts = xml !== undefined ? parseLaunchAgentPlist(xml) : undefined;
        agentView = {
          kind: "on",
          ...(parts !== undefined ? { nextWakeAt: nextCalendarOccurrence(parts.hour, parts.minute, now()) } : {}),
        };
      })
      .catch(() => {
        // The plist lane is best-effort by design — a reconcile crash must
        // never take a fire lane down with it.
      });
  };
  const persist = async (next: readonly DurableTask[]): Promise<void> => {
    tasks = [...next];
    sources?.reconcile(tasks);
    sleepGuard.sync(tasks);
    syncLaunchAgent();
    const attempt = saveTail.then(() => store.save(next));
    saveTail = attempt.then(() => undefined, () => undefined);
    await attempt.catch((err) => {
      opts.notify?.(`⚠️ schedules 存储写入失败：${err instanceof Error ? err.message : String(err)}`); // ω99-185: #3
    });
  };
  const running = new Set<string>();
  const kindOf = (t: DurableTask): "task" | "reminder" => (t.kind === "reminder" ? "reminder" : "task");
  // 127 项 2（F1）— origin 占用跳过的连续计数（进程内；占用真相在盘上
  // 租约文件里，daemon 重启后重探即重新起算）。一次成功进入 run 车道即清零。
  const originSkipCounts = new Map<string, number>();

  // ω99-313 — the post-fire table advance. The structured family recomputes
  // nextRunAt from the ACTUAL fire time (the missed-fire law: one fire per
  // gap, never per missed occurrence); a fired `at` one-shot self-deletes —
  // UNLESS it is a snoozeable reminder, which lingers for one snooze window
  // instead. Only the CRON path calls this (a manual run never advances the
  // schedule — the ω99-5a contract).
  const advanceAfterFire = async (task: DurableTask, fireTime: number): Promise<void> => {
    let selfDelete = false;
    let patch: Partial<DurableTask> = {};
    // ω99-313 rider: the structured family (every/weekly — always — and `at`
    // via its materialized nextRunAt; at fire time the due-ness source IS
    // nextRunAt, so the guard is presence, not legacy derivation) takes the
    // recompute path; everything else keeps the exact legacy mutation. At
    // runtime this is the same set the old OR-guard routed: a cron row never
    // materializes nextRunAt, and an every/weekly row always carries one —
    // the rewrite just narrows the discriminant for the type checker.
    const s = task.schedule;
    // 131 弧 — idle 是一次性（at 的同族）：火被消耗即自删。
    if (s.type === "idle") {
      await persist(tasks.filter((t) => t.id !== task.id));
      return;
    }
    if (s.type === "every" || s.type === "weekly" || (s.type === "at" && task.nextRunAt !== undefined)) {
      if (s.type === "at") {
        if (kindOf(task) === "reminder" && task.snoozeMinutes !== undefined) {
          patch = { lastFiredAt: fireTime, nextRunAt: undefined, snoozeUntil: fireTime + task.snoozeMinutes * 60_000 };
        } else {
          selfDelete = true;
        }
      } else {
        const next = computeNextRun(s, fireTime);
        patch = next === undefined
          ? { lastFiredAt: fireTime, nextRunAt: undefined }
          : { lastFiredAt: fireTime, nextRunAt: next };
      }
    } else {
      // The pre-313 rows (cron, jitter-era `at`): the exact legacy mutation.
      selfDelete = task.schedule.type === "at";
      patch = { lastFiredAt: fireTime };
    }
    await persist(
      tasks
        .filter((t) => !(selfDelete && t.id === task.id))
        .map((t) => (t.id === task.id ? { ...t, ...patch } : t)),
    );
  };

  // ω99-313 — the breaker step (cron-fired spawn runs only). A success
  // resets; the 3rd consecutive failure disables the task and notifies ONCE
  // (the disable gates any further fire, so the notification cannot repeat).
  // Returns whether the breaker tripped on this step.
  const breakerStep = async (id: string, ok: boolean): Promise<boolean> => {
    const task = tasks.find((t) => t.id === id);
    if (task === undefined) return false; // a self-deleted one-shot is gone — nothing to trip
    const failures = ok ? 0 : (task.consecutiveFailures ?? 0) + 1;
    const trips = !ok && failures >= SCHEDULE_BREAKER_FAILURES;
    await persist(
      tasks.map((t) => (t.id === id ? { ...t, consecutiveFailures: failures, ...(trips ? { enabled: false } : {}) } : t)),
    );
    if (trips) {
      opts.notify?.(`⚠️ 计划任务 ${id} 连续 ${SCHEDULE_BREAKER_FAILURES} 次没跑成，已自动暂停——/schedule unpause ${id} 重新打开`);
    }
    return trips;
  };

  // ω99-313 — the one fire-and-forget execution path (tick and runNow share
  // it). Three lanes: the REMINDER light path (zero model requests — the
  // fire IS the notification), the bound-session CONTINUE lane (the ui
  // host's continueSession seam; same request prefix, cache law), and the
  // pre-313 SPAWN lane. Only a CRON fire advances the schedule; a manual
  // run leaves it untouched (goose run_now semantics).
  // 借鉴弧 α3: triggeredBy gains "miss-retry" — the bounded re-fire for a
  // consumed cron fire that never reached the model (the child stamped
  // UNREACHED on stderr). It shares manual's non-advancing semantics (the
  // fire it retries was ALREADY consumed and advanced), still feeds the
  // breaker, and its own failure NEVER arms another retry — the bound lives
  // at the cron-only arm below, so no counter is needed.
  // 借鉴弧 ε: triggeredBy gains "event" — a watched signal arrived (file
  // change / webhook POST). Non-advancing (nothing to advance — the signal
  // is a fact, not a schedule), breaker-feeding (a task that fails on every
  // signal is a stuck loop the breaker must stop), and the busy-skip lane
  // applies (a signal landing mid-run on the bound session races it).
  const launchRun = (
    task: DurableTask,
    at: number,
    triggeredBy: "cron" | "manual" | "miss-retry" | "event",
    eventSource?: "file" | "webhook",
  ): void => {
    running.add(task.id);
    void (async () => {
      const startedAt = new Date(at).toISOString();
      try {
        if (kindOf(task) === "reminder") {
          // 轻路径：零模型请求。调度事件不进会话 JSONL——notify 是历史
          // 通道的 notice（不落盘），appendRun 只归发起 run 的 task 线。
          if (triggeredBy === "cron") await advanceAfterFire(task, at);
          opts.notify?.(
            `⏰ ${task.prompt}${task.snoozeMinutes !== undefined ? `（/schedule snooze ${task.id} 可稍后再提醒）` : ""}`,
          );
          return;
        }
        let lane: "continue" | "spawn" | "skipped" = "spawn";
        // 127 项 3（F2）— 绑定续跑被拒的类型化成因（started:false 的加性字段，
        // driver.continueSession 填；旧 seam 值/异常回落不带它 = 未知成因照实披露）。
        // continueAttempted 区分「试过续跑被拒」（要披露）与「根本没有续跑车道」
        // （无宿主 seam 的结构性缺席——那是既有设计，不是降级）。
        let continueRefused: ScheduleContinueRefusal | undefined;
        let continueAttempted = false;
        if (task.sessionId !== undefined && opts.continueRun !== undefined) {
          if ((triggeredBy === "cron" || triggeredBy === "event") && opts.isBusy?.() === true) {
            lane = "skipped";
          } else {
            continueAttempted = true;
            const outcome = await opts.continueRun(task.sessionId).catch(
              (): { readonly started: boolean; readonly refused?: ScheduleContinueRefusal } => ({ started: false }),
            );
            if (outcome.started) {
              lane = "continue";
            } else {
              lane = "spawn";
              continueRefused = outcome.refused;
            }
          }
        }
        if (lane === "skipped") {
          // The fire landed mid-run: forking a duplicate would race the very
          // session it is bound to — the honest move is a notified skip (the
          // occurrence is consumed; the schedule advances).
          if (triggeredBy === "cron") await advanceAfterFire(task, at);
          opts.notify?.(`⏳ ${triggeredBy === "event" ? "事件任务" : "计划任务"} ${task.id} ${triggeredBy === "event" ? "收到信号" : "到点"}，但会话正忙——本次跳过`);
          // ω99-321: the skip is a run fact — it lands in the ledger too
          // (「昨晚 3 点那次为什么没跑」在账上可查，跨重启）。data 形状注记：
          // ok:true 是「不失败」占位（会话忙=产品在干活，且熔断不吃本车道
          // ——breakerStep 只在 spawn 车道）；任何新消费面必须先判 mode 再判
          // ok，否则 skipped 会被读成「跑成了」。
          await opts.appendRun?.({
            type: "schedule_run",
            data: {
              taskId: task.id,
              prompt: truncateSafe(task.prompt, 200),
              workspace: task.workspace,
              ok: true,
              at: startedAt,
              mode: "skipped",
              triggeredBy,
              ...(eventSource !== undefined ? { eventSource } : {}),
            },
          }).catch(() => {
            // The notify already went out — a lost ledger line beats an
            // aborted fire lane (an unhandled rejection would kill the void
            // body's promise).
          });
          return;
        }
        if (lane === "continue") {
          if (triggeredBy === "cron") await advanceAfterFire(task, at);
          opts.notify?.(`↪ 计划任务 ${task.id}：接着上次的会话继续跑（${String(task.sessionId).slice(0, 8)}）`);
          await opts.appendRun?.({
            type: "schedule_run",
            data: {
              taskId: task.id,
              prompt: truncateSafe(task.prompt, 200),
              workspace: task.workspace,
              ok: true,
              at: startedAt,
              mode: "continue",
              triggeredBy,
            },
          }).catch(() => {
            // ω99-322: same law as the skipped lane — the notify already went
            // out; a lost ledger line beats an aborted fire lane (an unhandled
            // rejection would kill the void body's promise).
          });
          return;
        }
        // 127 项 3（F2）— 绑定降级诚实化：sessionId 绑定任务的 continue 被拒
        // （占用/损坏）时绝不静默变道 -p 全新会话——一行通知 + 台账披露（用户
        // 「绑定会话」的意图在降级路径上必须可见）。settled 尾不算拒绝：绑
        // 定语义本就是「有未完尾才续，否则全新跑」（schedule_add 的既有承诺），
        // 不为它发噪音。
        if (continueAttempted && task.sessionId !== undefined && continueRefused !== "settled") {
          const why = continueRefused === "busy"
            ? "占用"
            : continueRefused === "shape"
              ? "形状不合法"
              : continueRefused === "not_found"
                ? "损坏或不可读"
                : "占用或损坏"; // 未带成因的旧 seam 值/异常——照实说「不知道哪种」，仍不静默
          opts.notify?.(`⚠️ 绑定会话 ${task.sessionId.slice(0, 8)} 续跑被拒（${why}），改为全新 spawn`);
        }
        // 121 项 2 — the origin lane's degrade door: an agent-stamped task
        // whose birthplace session no longer exists on disk (cleaned, or a
        // hand-edited row) strips origin and runs the PLAIN spawn — the work
        // still happens; one honest receipt line explains the shape change.
        let runTask = task;
        let originDropped = false;
        if (
          task.origin !== undefined
          && !(opts.originSessionExists ?? defaultOriginSessionExists)(task.origin.sessionId, task.workspace)
        ) {
          runTask = { ...task, origin: undefined };
          originDropped = true;
          opts.notify?.(
            `⚠️ 计划任务 ${task.id} 设定时绑定的会话 ${task.origin.sessionId.slice(0, 8)} 已不在（可能被清理）——本次按全新任务运行`,
          );
        }
        // 127 项 2（F1）— origin 占用探测：spawn 前 probe 活租约。占用 → 本次
        // 火跳过（通知 + 台账 mode="skipped"，ω99-321 语义），绝不喂熔断——
        // 子进程的 boot 租约对谁都拒，spawn 是注定失败的白烧。有界重排：
        // 一次性（at）火重排 +2min（债还在，occurrence 不消耗）帽 5 次后放
        // 弃（火被消耗——at 自删；链的下一棒需重新安排，诚实通知）；循环火
        // 走自然节律（advance——「等待下一次」的本来含义）；event 火信号已
        // 消费（busy-skip 车道同语义：不推进不重排）。手动火（runNow）不探
        // ——用户显式要求，尝试失败本身是诚实回执，且手动失败本就不喂熔断。
        if (
          triggeredBy !== "manual"
          && runTask.origin !== undefined
          && await (opts.originSessionOccupied ?? defaultOriginSessionOccupied)(runTask.origin.sessionId, runTask.workspace)
        ) {
          const oneShot = task.schedule.type === "at";
          const skips = (originSkipCounts.get(task.id) ?? 0) + 1;
          const gaveUp = oneShot && skips > SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP;
          if (gaveUp) {
            originSkipCounts.delete(task.id);
            if (triggeredBy === "cron") await advanceAfterFire(task, at); // 火被消耗（at 自删）
          } else {
            originSkipCounts.set(task.id, skips);
            if (oneShot) {
              await persist(tasks.map((t) => (t.id === task.id ? { ...t, nextRunAt: now() + SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS } : t)));
            } else if (triggeredBy === "cron") {
              await advanceAfterFire(task, at); // 循环火：occurrence 消耗，自然节律的下一火即「下一次」
            }
          }
          opts.notify?.(gaveUp
            ? `⚠️ 计划任务 ${task.id} 的续跑会话持续被占用，已放弃本次接力（连续 ${String(SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP)} 次跳过）——需要时重新安排`
            : `⏳ 计划任务 ${task.id} 到点，但 origin 会话正被占用，跳过本次火（等待下一次）${oneShot && !gaveUp ? `——约 ${String(Math.round(SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS / 60_000))} 分钟后重试` : ""}`);
          await opts.appendRun?.({
            type: "schedule_run",
            data: {
              taskId: task.id,
              prompt: truncateSafe(task.prompt, 200),
              workspace: task.workspace,
              ok: true, // ω99-321 语义：skipped 是「不失败」占位——熔断不吃本车道（breakerStep 不跑）
              at: startedAt,
              mode: "skipped",
              triggeredBy,
              originOccupied: true,
              ...(gaveUp ? { originSkipGaveUp: true } : {}),
            },
          }).catch(() => {
            // same law as the other skip lanes — a lost ledger line beats an
            // aborted fire lane.
          });
          return;
        }
        originSkipCounts.delete(task.id);
        const result = await run(runTask);
        if (triggeredBy === "cron") await advanceAfterFire(task, at);
        if (triggeredBy !== "manual") await breakerStep(task.id, result.ok);
        // 借鉴弧 α3 — 漏火有界重跑：一次 cron fire 失败、子进程盖了 UNREACHED
        // 章（瞬态 provider 死 + 模型零接触——零 assistant/reasoning 字节 = 零
        // 工具副作用，重跑安全性可证，hermes session_api_calls==0 的对应判据），
        // 且 armMissRetry 四门全过 → 武装 missRetryAt。通知抑制（hermes「重跑
        // 期间不发失败通知」的对应件）：此刻不说「跑失败了」，说「没到达模型，
        // 将补跑」；补跑自身若再失败则走普通失败行（有界性不靠计数器，靠车道
        // 身份——miss-retry 的失败不再武装）。
        let missRetryArmed = false;
        if (triggeredBy === "cron" && !result.ok && result.output.includes(SCHEDULE_MODEL_UNREACHED_MARKER)) {
          const live = tasks.find((t) => t.id === task.id);
          const retryAt = live === undefined ? undefined : armMissRetry(live, at, now());
          if (retryAt !== undefined) {
            missRetryArmed = true;
            await persist(tasks.map((t) => (t.id === task.id ? { ...t, missRetryAt: retryAt } : t)));
            const inMin = Math.max(1, Math.round((retryAt - now()) / 60_000));
            opts.notify?.(`⚠️ 计划任务 ${task.id} 到点但模型不可达（本次零输出——不是任务本身的问题）——约 ${inMin} 分钟后自动补跑一次，不晚于自然周期`);
          }
        }
        const line = `${result.ok ? "✅" : "⚠️"}${triggeredBy === "miss-retry" && result.ok ? "（补跑）" : ""} 计划任务 ${task.id}（${task.schedule.type === "cron" ? task.schedule.expr : task.schedule.type === "at" ? new Date(task.schedule.at).toISOString() : describeScheduleHuman(task.schedule)}）于 ${task.workspace}：${truncateSafe(result.output, 200).replace(/\n/g, " ")}`; // ω99-189: #1（313：结构化形用人话触发器；α3：补跑成功的回执带（补跑）标）
        if (!missRetryArmed) opts.notify?.(line);
        await opts.appendRun?.({
          type: "schedule_run",
          data: {
            taskId: task.id,
            prompt: truncateSafe(task.prompt, 200),
            workspace: task.workspace,
            ok: result.ok,
            exitCode: result.exitCode,
            // v7 γ2：kill 留名——超时 kill 的台账行带结构化成因（正常结束/
            // 命令失败缺席；「schedules 超时 kill 无回执」的缺口闭合）。
            ...(result.endCause !== undefined ? { endCause: result.endCause } : {}),
            at: startedAt,
            output: truncateSafe(result.output, RUN_PREVIEW_CHARS),
            triggeredBy,
            ...(eventSource !== undefined ? { eventSource } : {}),
            ...(missRetryArmed ? { missRetryArmed: true } : {}),
            // 121 项 2 — origin 车道事实：这次 fire 是「定时续跑」（resume 了
            // 哪个会话），还是出生地丢了降级成全新 spawn（originDropped）。
            ...(task.origin !== undefined && !originDropped ? { originResume: task.origin.sessionId } : {}),
            ...(originDropped ? { originDropped: true } : {}),
            // 127 项 3（F2）— 绑定降级的台账披露：sessionId 绑定任务的 continue
            // 被拒后落 spawn 的成因（settled 不披露——那是绑定语义的既有回落；
            // 未带成因的旧 seam 值记 "unknown"）。
            ...(continueAttempted && task.sessionId !== undefined && continueRefused !== "settled"
              ? { boundContinueRefused: continueRefused ?? "unknown" }
              : {}),
          },
        }).catch(() => {
          // ω99-322: same law as the other two lanes — the notify already
          // went out; a lost ledger line beats an aborted fire lane.
        });
        // v7 γ2——「怎么结束」入指纹账（「怎么失败」的姊妹面）：超时 kill 是
        // 用户要追问的事（「昨晚那次为什么没结果」），subject=计划任务 id
        // （跨次稳定——同一任务第 N 次超时可数）。防污染：正常结束与命令
        // 自身失败不进（那是失败车道/已有熔断的事）；fire-and-forget——台账
        // 落不下值一行 stderr，绝不挡火。
        if (result.endCause !== undefined && opts.workspaceRoot !== undefined) {
          void appendFailureEvent(
            failureFingerprintPath(opts.workspaceRoot),
            buildObservedEvent({
              subject: `计划任务 ${task.id}`,
              stage: "run-end",
              cause: describeRunEndCause(result.endCause),
              at: startedAt,
            }),
          ).catch((err: unknown) => {
            process.stderr.write(`wudao: 结束方式指纹落盘失败（继续，不影响任务结算）：${err instanceof Error ? err.message : String(err)}\n`);
          });
        }
      } finally {
        running.delete(task.id);
      }
    })();
  };

  // 借鉴弧 ε — the event lane's fire door: the substrate debounces raw
  // signals; THIS side owns the run decisions. A signal for a task whose run
  // is still in flight is a notified + ledgered SKIP (ω99-321 semantics —
  // the signal is consumed, never queued); a paused/breaker task drops it
  // silently (no debt owed: 事件无「火」，停用期间不欠新账).
  const fireEvent = (taskId: string, source: "file" | "webhook"): void => {
    const task = tasks.find((t) => t.id === taskId);
    if (task === undefined) return;
    if (task.paused === true || task.enabled === false) return;
    if (running.has(taskId)) {
      opts.notify?.(`⏳ 事件任务 ${taskId} 收到信号，但上一次运行还没结束——本次跳过`);
      void opts.appendRun?.({
        type: "schedule_run",
        data: {
          taskId,
          prompt: truncateSafe(task.prompt, 200),
          workspace: task.workspace,
          ok: true,
          at: new Date(now()).toISOString(),
          mode: "skipped",
          triggeredBy: "event",
          ...(source === "file" || source === "webhook" ? { eventSource: source } : {}),
        },
      }).catch(() => {
        // same law as the other lanes — a lost ledger line beats an aborted fire
      });
      return;
    }
    launchRun(task, now(), "event", source);
  };

  const tick = async (at = now()): Promise<readonly DurableTask[]> => {
    const fired: DurableTask[] = [];
    // ω99-313: retire the snooze windows that closed unsnoozed (a fired
    // reminder nobody delayed has said its say).
    const retired = tasks.filter(
      (t) => t.nextRunAt === undefined && t.snoozeUntil !== undefined && t.snoozeUntil <= at && t.paused !== true && t.enabled !== false,
    );
    if (retired.length > 0) await persist(tasks.filter((t) => !retired.some((r) => r.id === t.id)));
    for (const task of tasks) {
      if (running.has(task.id)) continue; // one in-flight run per task
      if (retired.some((r) => r.id === task.id)) continue;
      // 借鉴弧 α3 — the armed miss-retry goes FIRST: it is owed work from a
      // consumed fire, not a new occurrence (its timing is independent of
      // due-ness; a daemon restart that spans the arm keeps it — durable in
      // the store precisely so the outage window cannot eat it). A running
      // task re-checks on the next tick (the arm stays). A paused/disabled
      // task WAIVES its retry (dropped, not deferred — 停用期间不欠新账).
      if (task.missRetryAt !== undefined) {
        if (at < task.missRetryAt) continue;
        if (task.paused === true || task.enabled === false) {
          await persist(tasks.map((t) => (t.id === task.id ? { ...t, missRetryAt: undefined } : t)));
          continue;
        }
        await persist(tasks.map((t) => (t.id === task.id ? { ...t, missRetryAt: undefined } : t)));
        launchRun(task, at, "miss-retry");
        fired.push(task);
        continue;
      }
      // 131 弧 — defer（idle）族：钟面到点（nextRunAt 过）只是「最早可火」，
      // 真火还需空闲资格——宿主不忙 + 距最后活动 ≥ idleMinutes。不满足就
      // 等下一个 tick（火不消耗：这是 defer 的产品语义，不是漏火）。
      if (task.schedule.type === "idle") {
        const fireAt = nextFireOf(task, at);
        if (fireAt === undefined || at < fireAt) continue;
        if (opts.isBusy?.() === true) continue;
        const last = opts.lastActivityAt?.();
        if (last !== undefined && at - last < task.schedule.idleMinutes * 60_000) continue;
        launchRun(task, at, "cron");
        fired.push(task);
        continue;
      }
      const fireAt = nextFireOf(task, at);
      if (fireAt === undefined || at < fireAt) continue;
      // Due (including "came due while the daemon was offline" — one fire,
      // never one per missed occurrence): run, then advance lastFiredAt.
      // A paused/disabled task never reaches here (nextFireOf refuses it).
      launchRun(task, at, "cron");
      fired.push(task);
    }
    // 122 项 1 — 时间驱动的合闸：表没变但钟在走，最近一火进窗就在这里
    // 拿到断言（发射中的行 nextRunAt 仍 stale 在过去 → 继续持有，盖满
    // 在途 run；advanceAfterFire 的 persist 自然放行）。
    sleepGuard.sync(tasks);
    // 122 项 2 — tick 尾部的 reconcile：外部漂移（手改 plist/删文件）与
    // 设置页开关的落地都在 ≤ 一个 tick 内自愈（幂等，字节相同零成本）。
    syncLaunchAgent();
    return fired;
  };

  const timer = (opts.tickMs ?? SCHEDULE_TICK_MS) > 0
    ? setInterval(() => void tick().catch(() => {}), opts.tickMs ?? SCHEDULE_TICK_MS)
    : undefined;
  timer?.unref?.();
  // ω99-313 boot: the missed-fire catch-up. (1) Materialize nextRunAt for
  // structured rows that lack one (a hand-edited store / future migration);
  // (2) clamp every stale nextRunAt to NOW — each task that came due while
  // the app was away fires ONCE on this boot (never once per missed
  // occurrence; the post-fire advance recomputes from the fire time). In
  // memory — the fire's own persist lands it, and a crash before the fire
  // re-clamps on the next boot (still one fire).
  {
    const bootAt = now();
    const materialized = tasks.map((t) => {
      if (t.nextRunAt !== undefined) return t;
      if (t.schedule.type === "idle") {
        return { ...t, nextRunAt: t.createdAt + t.schedule.idleMinutes * 60_000 };
      }
      if (t.schedule.type !== "every" && t.schedule.type !== "weekly") return t;
      const next = computeNextRun(t.schedule, t.lastFiredAt ?? t.createdAt);
      return next === undefined ? t : { ...t, nextRunAt: next };
    });
    tasks = [...applyMissedFire(materialized, bootAt).entries];
    // 122 项 1 — boot 即合闸：重启时已进窗（或已 due）的火不等第一个
    // tick 就拿到断言（tickMs=0 的直接构造面同样成立）。
    sleepGuard.sync(tasks);
    // 122 项 2 — boot 即 reconcile：崩溃遗留的 stale plist 在打开 app 的
    // 这一刻自愈（重算 min、与盘上现值比对、漂了才写）。
    syncLaunchAgent();
  }
  // 借鉴弧 ε — boot：事件源武装现行表（盯梢/监听即刻生效），绑定结果等到
  // 落定（端口被占的 notify 也在这一等里发出来——不阻塞任何车道，绑定
  // 失败时 webhookReady 解 undefined）。
  sources = createEventSources({
    fire: fireEvent,
    notify: (line) => opts.notify?.(line),
    env: opts.env,
    ...(opts.eventSeams?.debounceMs !== undefined ? { debounceMs: opts.eventSeams.debounceMs } : {}),
    ...(opts.eventSeams?.webhookPort !== undefined ? { webhookPort: opts.eventSeams.webhookPort } : {}),
  });
  sources.reconcile(tasks);
  await sources.webhookReady();
  // The online transition: one immediate check — everything that came due
  // while the daemon was down fires ONCE here (no catch-up by count).
  void tick().catch(() => {});

  const nextDueText = (): string => {
    const next = tasks
      .map((t) => nextFireOf(t, now()))
      .filter((f): f is number => f !== undefined)
      .sort((a, b) => a - b)[0];
    return next === undefined ? "无待办" : new Date(next).toISOString(); // ω99-185: #12
  };

  // 122 项 2 — /doctor 的离线唤起现值行（设计 §4c：「今晚 3 点谁叫醒我」
  // 在医生面可查）。读的是 daemon 的 reconcile 视图（off/unsupported/on +
  // plist 现格的下一次 occurrence / 同步失败 ⚠️）。
  const launchAgentDoctorText = (): string => {
    if (agentSync === undefined || agentView.kind === "off") return "离线唤起 关";
    if (agentView.kind === "unsupported") return "离线唤起 不支持（非 macOS）";
    if (agentView.failure !== undefined) return `离线唤起 ⚠️（${agentView.failure}）`;
    return agentView.nextWakeAt !== undefined
      ? `离线唤起 开 · 下次系统唤起 ${new Date(agentView.nextWakeAt).toISOString()}`
      : "离线唤起 开（当前无待唤起任务）";
  };

  return {
    tick,
    add: async (input) => {
      // 借鉴弧 ε — add 面归一化：webhook 事件源不带 token 进来，token 在
      // 这里铸造（唯一出生点）；file 路径过逃逸门（相对路径、无 ..）。
      let schedule: DurableSchedule;
      // 131 弧 — idle 族门口归一化：非正整数拒收；越界夹回产品窗 [5,120]。
      if (input.schedule.type === "idle") {
        if (!Number.isInteger(input.schedule.idleMinutes) || input.schedule.idleMinutes < 1) {
          return "⚠️ 空闲等待分钟须为正整数";
        }
        schedule = {
          type: "idle",
          idleMinutes: Math.min(DEFER_IDLE_MAX_MINUTES, Math.max(DEFER_IDLE_MIN_MINUTES, input.schedule.idleMinutes)),
        };
      } else if (input.schedule.type === "event") {
        if (input.schedule.source.kind === "file") {
          const err = eventSourceError(input.schedule.source);
          if (err !== undefined) return `⚠️ ${err}`;
          schedule = { type: "event", source: { kind: "file", path: input.schedule.source.path } };
        } else {
          schedule = { type: "event", source: { kind: "webhook", token: randomBytes(24).toString("base64url") } };
        }
      } else {
        schedule = input.schedule;
      }
      if (schedule.type === "cron") {
        const parsed = parseCronExpr(schedule.expr);
        if (!parsed.ok) return `⚠️ ${parsed.error}`;
      }
      const structuredError = structuredScheduleError(schedule);
      if (structuredError !== undefined) return `⚠️ ${structuredError}`;
      if (schedule.type === "at" && schedule.at <= now()) {
        return "⚠️ 一次性时间需在未来"; // a past `at` would never fire — refuse at the door
      }
      // 113-C1 — the runtime tier's typed door: shape (union/non-empty/
      // at-least-one) synchronously, persona existence against the MERGED
      // registry (builtin + global + workspace — the same loader the REPL
      // boot chain uses, fail-closed on typos: a bad tier name must refuse
      // here, never silently fall back to defaults at 3am).
      if (input.runtime !== undefined) {
        const shapeErr = scheduleRuntimeError(input.runtime);
        if (shapeErr !== undefined) return `⚠️ ${shapeErr}`;
        if (input.runtime.persona !== undefined) {
          const registry = await loadPersonaRegistry({
            globalDir: join(resolveGlobalHome(opts.env ?? process.env), "personas"),
            workspaceDir: join(opts.workspaceRoot, ".wudao", "personas"),
          });
          if (lookupPersona(registry, input.runtime.persona) === undefined) {
            return `⚠️ persona "${input.runtime.persona}" 不在注册表（内置/全局/工作区）——先建好 persona 再加档位`;
          }
        }
      }
      // 121 项 2 — the origin door: shape-gated at ADD (a malformed stamp is
      // REFUSED, not silently dropped — the schedule_add tool face only
      // stamps well-formed live ids, so garbage here means a hand-built call
      // the caller deserves to hear about; same discipline as runtime's
      // typed door). Only kind=task rows carry it (a reminder never runs —
      // a birthplace would be dead weight).
      if (input.origin !== undefined) {
        if (input.kind === "reminder") return "⚠️ origin 只属于 task（提醒零模型调用，无会话可续）";
        if (!validScheduleOriginSessionId(input.origin.sessionId)) {
          return "⚠️ origin.sessionId 需为合法主会话 id（side- 副链不可续）";
        }
        if (input.origin.contextHint !== undefined && (typeof input.origin.contextHint !== "string" || input.origin.contextHint.trim() === "")) {
          return "⚠️ origin.contextHint 需为非空字符串";
        }
      }
      const createdAt = now();
      // The structured family materializes nextRunAt at creation (the
      // due-ness field applyMissedFire clamps and the fire recomputes);
      // cron keeps the legacy derivation. 借鉴弧 ε：event 家族不物化——
      // due-ness 由信号驱动。
      // 131 弧 — idle 族也物化（最早可火时刻 = 创建 + 空闲窗；真火资格在
      // daemon 的空闲判定）。
      const nextRunAt = isStructuredSchedule(schedule)
        ? computeNextRun(schedule, createdAt)
        : schedule.type === "idle"
          ? createdAt + schedule.idleMinutes * 60_000
          : undefined;
      const id = Array.from({ length: 8 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("");
      await persist([...tasks, {
        id,
        schedule,
        prompt: input.prompt,
        workspace: input.workspace ?? opts.workspaceRoot,
        createdFrom: input.createdFrom ?? "/schedule",
        createdAt,
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.sessionId !== undefined && input.sessionId !== "" ? { sessionId: input.sessionId } : {}),
        ...(input.origin !== undefined && input.kind !== "reminder" ? { origin: input.origin } : {}),
        ...(input.budgetTokens !== undefined ? { budgetTokens: input.budgetTokens } : {}),
        ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
        ...(input.snoozeMinutes !== undefined ? { snoozeMinutes: input.snoozeMinutes } : {}),
      }]);
      const noun = input.kind === "reminder" ? "提醒" : "持久任务"; // ω99-313: 收益语——按用途称呼
      const schedText = schedule.type === "cron"
        ? schedule.expr
        : schedule.type === "at"
          ? new Date(schedule.at).toISOString()
          : describeScheduleHuman(schedule);
      let receipt = `📅 ${noun} ${id} 已添加（${schedText}）· 工作区 ${input.workspace ?? opts.workspaceRoot}`; // ω99-185: #13
      // 121 项 2 — the origin stamp rides the receipt (收益语：到点接着本会话
      // 继续跑，上下文不丢；会话短 id 供核对)。
      if (input.origin !== undefined && input.kind !== "reminder") {
        receipt += `\n🔗 到点将接着本会话继续跑（${input.origin.sessionId.slice(0, 8)}）——上下文不丢，跨重启有效`;
      }
      // 113-C1 — the runtime tier rides the receipt (it only arms the SPAWN
      // lane; a bound continue lane keeps the session's own runtime).
      if (input.runtime !== undefined) {
        receipt += `\n🎚 档位：${[
          input.runtime.provider,
          input.runtime.model,
          input.runtime.persona !== undefined ? `persona ${input.runtime.persona}` : undefined,
          input.runtime.effort !== undefined ? `effort ${input.runtime.effort}` : undefined,
        ].filter((s) => s !== undefined && s !== "").join(" · ")}（触发新开运行时生效）`;
      }
      // 借鉴弧 ε — webhook 的触发地址随回执走一次（端口等绑定落定——
      // persist 的 reconcile 刚把它拉起）；收不到就如实说收不到。
      if (schedule.type === "event" && schedule.source.kind === "webhook") {
        const port = await sources?.webhookReady();
        receipt += port !== undefined
          ? `\n📡 触发地址（本地）：curl -X POST -H "Authorization: Bearer ${schedule.source.token}" http://${SCHEDULE_WEBHOOK_HOST}:${port}/trigger/${id}`
          : `\n⚠️ webhook 监听未启动——信号暂时收不到；/schedule webhook ${id} 可重查`;
      }
      return receipt;
    },
    rm: async (id) => {
      const before = tasks.length;
      await persist(tasks.filter((t) => t.id !== id));
      return tasks.length < before ? `已移除持久任务 ${id}` : `无持久任务 ${id}`; // ω99-185: #14 #15
    },
    runNow: async (id, flags) => {
      const task = tasks.find((t) => t.id === id);
      if (task === undefined) return `⚠️ 无持久任务 ${id}`; // ω99-185: #16
      if (running.has(id)) return `⚠️ ${id} 已在运行`; // ω99-185: #17
      // ω99-317 — busy 守卫（绑定会话车道）：313 的 cron-fire 忙跳过同语义
      // 补到手动面——宿主正忙时分叉必与它绑定的会话撞车，明示拒绝（不排队、
      // 不静默）。未绑定的 spawn 车道与零模型提醒不受此门。
      if (task.sessionId !== undefined && opts.isBusy?.() === true) {
        return `⚠️ ${id} 绑定的会话正在跑——等当前对话结束再试`;
      }
      // ω99-317 — 熔断重开口（显式旗）：连败熔断（enabled=false）时复位
      // 计数并重新打开（unpause 同形），再立即跑；健康任务带旗零变异。
      if (flags?.resetBreaker === true && task.enabled === false) {
        const reopened = tasks.map((t) => (t.id === id ? { ...t, enabled: undefined, consecutiveFailures: 0 } : t));
        await persist(reopened);
        launchRun(reopened.find((t) => t.id === id)!, now(), "manual");
        return `▶ ${id} 已重新打开并立即试跑（连败计数清零——计划不变）`;
      }
      launchRun(task, now(), "manual");
      return `▶ ${id} 已立即启动（手动运行——计划不变）`; // ω99-185: #18
    },
    pause: async (id) => {
      if (!tasks.some((t) => t.id === id)) return `⚠️ 无持久任务 ${id}`; // ω99-185: #16
      if (running.has(id)) return `⚠️ ${id} 正在运行——请稍后再暂停`; // ω99-185: #19
      await persist(tasks.map((t) => (t.id === id ? { ...t, paused: true } : t)));
      return `⏸ ${id} 已暂停（错过的触发不补跑）`; // ω99-185: #20
    },
    unpause: async (id) => {
      if (!tasks.some((t) => t.id === id)) return `⚠️ 无持久任务 ${id}`; // ω99-185: #16
      // ω99-313: unpause is also the breaker's re-open path — a disabled
      // task comes back enabled (a stale nextRunAt in the past fires once
      // on the next tick, the catch-up law).
      await persist(tasks.map((t) => (t.id === id ? { ...t, paused: undefined, enabled: undefined, consecutiveFailures: 0 } : t)));
      return `▶ ${id} 已恢复`; // ω99-185: #21
    },
    snooze: async (id, minutes) => {
      const task = tasks.find((t) => t.id === id);
      if (task === undefined) return `⚠️ 无持久任务 ${id}`;
      if (kindOf(task) !== "reminder") return `⚠️ ${id} 不是提醒——只有提醒能稍后再响`;
      const m = minutes ?? task.snoozeMinutes ?? 10;
      if (!Number.isInteger(m) || m <= 0) return "⚠️ snooze 分钟数需为正整数";
      if (running.has(id)) return `⚠️ ${id} 正在响`;
      await persist(tasks.map((t) => (t.id === id ? { ...t, nextRunAt: now() + m * 60_000, snoozeUntil: undefined } : t)));
      return `⏰ ${id} 将在 ${m} 分钟后再提醒`;
    },
    // 借鉴弧 ε — webhook 地址回执（token 常驻任务上——回执丢了随时重取；
    // rm 任务即吊销）。监听未起 → 如实 ⚠️（端口占用是最常见原因）。
    webhookLine: async (id) => {
      const task = tasks.find((t) => t.id === id);
      if (task === undefined) return `⚠️ 无持久任务 ${id}`;
      if (task.schedule.type !== "event" || task.schedule.source.kind !== "webhook") {
        return `⚠️ ${id} 不是 webhook 触发任务`;
      }
      const port = await sources?.webhookReady();
      if (port === undefined) {
        const want = webhookPortOf({ env: opts.env, webhookPort: opts.eventSeams?.webhookPort });
        return `⚠️ webhook 监听未启动（127.0.0.1:${want} 起不来？）——检查端口占用，或用 ${SCHEDULE_WEBHOOK_PORT_ENV} 换端口`;
      }
      return `📡 curl -X POST -H "Authorization: Bearer ${task.schedule.source.token}" http://${SCHEDULE_WEBHOOK_HOST}:${port}/trigger/${id}`;
    },
    listText: () => formatDurableList(tasks, now),
    // 127 项 1 — continue_task 幂等扫描的结构化真相（活表副本；单宿主法则：
    // 工具面永远读 daemon 的内存表，绝不直读盘上文件）。
    list: () => [...tasks],
    doctorLine: () => `schedules：守护在本进程（wudao ui）· ${tasks.length} 个持久任务 · 下次到期 ${nextDueText()} · ${launchAgentDoctorText()}`, // ω99-185: #11；122 项 2：离线唤起现值行
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      sleepGuard.release(); // 122 项 1：只放自己的票——同进程其它持有者不受牵连
      sources?.stop(); // 借鉴弧 ε：关 watcher、关监听（socket 不留给宿主）
    },
  };
}
