// M61 §2 — /loop: recurring self-directed work. Two modes:
//   fixed    `/loop 30m [prompt]` — the interval grammar (Ns/Nm/Nh/Nd bare
//            token or an "every X" clause; seconds carry up to a minute;
//            non-clean intervals round to the nearest clean tier AND say so);
//            runs until the 7-day expiry, /loop stop, or Esc on the pending
//            wakeups.
//   dynamic  `/loop [prompt]` (interval omitted) — the agent self-paces: at
//            each turn end it picks a 1m-1h delay through the schedule_wakeup
//            model tool (delaySeconds clamps to [60, 3600]; stop:true ends).
//            A round that neither continues nor stops gets one ~20-minute
//            fallback wakeup; a SECOND silent round ends the loop.
// The bare /loop prompt is the built-in maintenance prompt (discipline
// verbatim from the spec); .wudao/loop.md (project) overrides ~/.wudao/loop.md
// (global), 25KB truncated, edits effective next round. Skills as prompts:
// only model-invocable skills expand; disable-model-invocation ones arrive as
// plain text (M58-B #4).
import { truncateSafe } from "@wudao/core"; // 113-A4
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTool } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { findSkill, buildSubstitutedSkillMessage } from "../skills.js";
import type { LoadedSkill } from "../skills.js";
import { resolveGlobalHome } from "../settings-layer.js";
import type { CronRuntime } from "../cron.js";

// ---------------------------------------------------------------------------
// Interval grammar
// ---------------------------------------------------------------------------

/** The clean tiers a non-clean interval rounds to (nearest wins; ties up).
 *  Spec examples: 7m → 5m, 90m → 2h (the 1h/2h tie rounds up). */
export const CLEAN_INTERVAL_TIERS_MS: readonly number[] = [
  60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 20 * 60_000, 30 * 60_000, 45 * 60_000,
  3_600_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000, 8 * 3_600_000, 12 * 3_600_000, 24 * 3_600_000,
];

export interface LoopInterval {
  readonly ms: number;
  /** Present when the input rounded (seconds→minute, or non-clean→tier). */
  readonly note?: string;
}

export type LoopIntervalResult = { ok: true; interval: LoopInterval } | { ok: false; error: string };

const UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MINUTE = 60_000;

function fmtDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/** Parse `/loop`'s interval: a bare token (`30m`) or an "every X" clause
 *  (`every 2 hours`). Seconds carry UP to a whole minute; non-clean intervals
 *  (7m, 90m) round to the nearest clean tier — and the chosen tier is told. */
export function parseLoopInterval(raw: string): LoopIntervalResult {
  const text = raw.trim().toLowerCase();
  let ms: number | undefined;
  let source = "";
  // Bare token: `30m`, `2h`, `45s`, `1d`.
  const bare = /^(\d+)([smhd])$/.exec(text);
  if (bare !== null) {
    ms = Number(bare[1]) * (UNIT_MS[bare[2]!] ?? 0);
    source = bare[0];
  } else {
    // Clause: `every 2 hours`, `every 30m`, `every 1 day`.
    const clause = /^every\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)$/.exec(text);
    if (clause !== null) {
      const unit = clause[2]![0] as "s" | "m" | "h" | "d";
      ms = Number(clause[1]) * (UNIT_MS[unit] ?? 0);
      source = clause[0];
    }
  }
  if (ms === undefined) {
    return { ok: false, error: `cannot parse interval "${raw.trim()}" — use a bare token (30m, 2h, 1d) or an "every X" clause (every 2 hours)` };
  }
  // Seconds carry up to a minute (nothing fires sub-minute).
  if (ms < MINUTE) {
    return { ok: true, interval: { ms: MINUTE, note: `"${source}" carries up to 1m (sub-minute intervals round up to a minute)` } };
  }
  const exact = CLEAN_INTERVAL_TIERS_MS.find((t) => t === ms);
  if (exact !== undefined) return { ok: true, interval: { ms: exact } };
  // Nearest clean tier; ties round up.
  let best = CLEAN_INTERVAL_TIERS_MS[0]!;
  for (const tier of CLEAN_INTERVAL_TIERS_MS) {
    if (Math.abs(tier - ms) < Math.abs(best - ms) || (Math.abs(tier - ms) === Math.abs(best - ms) && tier > best)) {
      best = tier;
    }
  }
  return { ok: true, interval: { ms: best, note: `${fmtDuration(ms)} is not a clean interval — using ${fmtDuration(best)}` } };
}

// ---------------------------------------------------------------------------
// The built-in maintenance prompt (discipline verbatim, spec §2)
// ---------------------------------------------------------------------------

/** The bare-/loop prompt: the maintenance ladder + the two hard disciplines.
 *  Wording is load-bearing — det-48 asserts the clauses. */
export const MAINTENANCE_LOOP_PROMPT = `You are in a maintenance loop. Work through this ladder in order, stopping at the first item with real work to do:

1. Continue unfinished work: pick up any in-progress task in this transcript (a partial change, a failing build, an unresolved review thread) and finish it.
2. Tend the current branch's health: address new review comments, check CI status, resolve conflicts or a stale rebase.
3. When nothing needs attention, do cleanup and housekeeping: hunt small bugs, simplify code you have already touched, remove dead code you can prove dead.

Discipline — non-negotiable:
- Do NOT open new initiatives. This loop continues existing work only; a new feature, refactor, or investigation belongs to the human, not the loop.
- Irreversible actions are limited to continuing work already authorized in this transcript (an approved plan, an explicit instruction, an in-flight change). When in doubt, stop and leave it for the user.`;

export const LOOP_MD_CAP_BYTES = 25 * 1024;

/** Resolve the loop prompt: explicit arg > .wudao/loop.md > ~/.wudao/loop.md >
 *  the built-in maintenance prompt. Project wins over global; 25KB truncated;
 *  re-read each round so edits are effective next round. */
export async function resolveLoopPrompt(opts: {
  readonly workspaceRoot: string;
  readonly arg?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<{ prompt: string; source: "arg" | "project-loop-md" | "global-loop-md" | "maintenance" }> {
  if (opts.arg !== undefined && opts.arg.trim() !== "") {
    return { prompt: opts.arg.trim(), source: "arg" };
  }
  const tryRead = async (path: string): Promise<string | undefined> => {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim() === "") return undefined;
      return text.length > LOOP_MD_CAP_BYTES ? truncateSafe(text, LOOP_MD_CAP_BYTES) : text;
    } catch {
      return undefined;
    }
  };
  const project = await tryRead(join(opts.workspaceRoot, ".wudao", "loop.md"));
  if (project !== undefined) return { prompt: project, source: "project-loop-md" };
  const global = await tryRead(join(resolveGlobalHome(opts.env ?? process.env), "loop.md"));
  if (global !== undefined) return { prompt: global, source: "global-loop-md" };
  return { prompt: MAINTENANCE_LOOP_PROMPT, source: "maintenance" };
}

/** Expand a fire prompt for submission: `/skill:name …` expands to the skill
 *  envelope ONLY for model-invocable skills — a disable-model-invocation
 *  skill arrives as plain text (the literal line), per M58-B #4. cc-plugins
 *  D2: the envelope rides the unified SUBSTITUTION pass (same expander as
 *  interactive invocation) — but deliberately NOT the dynamic injection: the
 *  loop fires headless (no human at the wheel), and executing `!`cmd` spans
 *  without an approval surface is exactly the wrong default. They stay
 *  literal for the model to reason about. */
export function expandLoopSkillPrompt(
  prompt: string,
  skills: readonly LoadedSkill[],
  opts: { readonly workspaceRoot?: string; readonly sessionId?: string } = {},
): string {
  if (!prompt.startsWith("/skill:")) return prompt;
  const body = prompt.slice("/skill:".length);
  const ws = body.search(/\s/);
  const name = ws === -1 ? body : body.slice(0, ws);
  const skill = findSkill(skills, name);
  if (skill === undefined || skill.disableModelInvocation === true) return prompt;
  return buildSubstitutedSkillMessage(skill, ws === -1 ? "" : body.slice(ws + 1).trim(), opts);
}

// ---------------------------------------------------------------------------
// schedule_wakeup — the dynamic loop's self-scheduling model tool
// ---------------------------------------------------------------------------

export const WAKEUP_DELAY_MIN_S = 60;
export const WAKEUP_DELAY_MAX_S = 3_600;
export const WAKEUP_FALLBACK_MS = 20 * 60_000;

/** The pending decision recorded from a schedule_wakeup call. */
export interface WakeupDecision {
  readonly kind: "continue" | "stop";
  readonly delaySeconds?: number;
  readonly reason?: string;
}

export interface LoopController {
  /** `/loop <args>` — parse + start (fixed or dynamic). Returns notice text. */
  command(args: string): Promise<string>;
  /** `/loop stop` and friends. Returns notice text. */
  stopCommand(reason?: string): string;
  /** The status line (bare /loop status). */
  status(): string;
  /** schedule_wakeup's landing: records the model's decision. Returns the
   *  tool result text. */
  onWakeupCall(args: { delaySeconds?: unknown; stop?: unknown; reason?: unknown }): string;
  /** Each run-settle: apply the dynamic-mode rules (stop/delay/fallback/end)
   *  and arm the next wakeup. Also ends a fixed loop whose task expired. */
  onRunEnd(): Promise<void>;
  /** True while a loop is active (either mode). */
  active(): boolean;
  /** Esc: clear the loop's PENDING wakeups only (the armed injections). */
  clearPendingOnEsc(): number;
}

export interface LoopControllerOptions {
  readonly cron: CronRuntime;
  readonly workspaceRoot: string;
  readonly skills?: readonly LoadedSkill[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Submit a loop round's prompt (idle start; full routing, skills expand). */
  readonly submit: (prompt: string) => void;
  /** Notice channel (history lines). */
  readonly notify: (text: string) => void;
}

/** The dynamic-mode bookkeeping, exported for tests. */
export function nextDynamicAction(decision: WakeupDecision | undefined, wasFallbackRound: boolean): { kind: "end" } | { kind: "schedule"; delayMs: number; fallback: boolean; note: string } {
  if (decision?.kind === "stop") return { kind: "end" };
  if (decision?.kind === "continue" && decision.delaySeconds !== undefined) {
    const clamped = Math.min(WAKEUP_DELAY_MAX_S, Math.max(WAKEUP_DELAY_MIN_S, Math.round(decision.delaySeconds)));
    const note = `⏳ /loop continues in ${fmtDuration(clamped * 1000)}${decision.reason !== undefined && decision.reason !== "" ? ` — ${decision.reason}` : ""}`;
    return { kind: "schedule", delayMs: clamped * 1000, fallback: false, note };
  }
  if (wasFallbackRound) return { kind: "end" };
  return {
    kind: "schedule",
    delayMs: WAKEUP_FALLBACK_MS,
    fallback: true,
    note: `⏳ /loop: no wakeup scheduled this round — fallback wakeup in ~20m; a second silent round ends the loop`,
  };
}

/** Build the /loop controller over the cron runtime (wakeup tasks are
 *  origin:"loop" one-shots — Esc clears only their pending injections). */
export function createLoopController(opts: LoopControllerOptions): LoopController {
  const now = opts.now ?? Date.now;
  type Mode = { kind: "fixed"; everyMs: number; arg?: string; startedAt: number } | { kind: "dynamic"; arg?: string; startedAt: number; fallbackRound: boolean };
  /** The /loop lifetime cap (spec §2: 固定模式跑到 7 天过期或停止). */
  const LOOP_TIME_LIMIT_MS = 7 * 86_400_000;
  let mode: Mode | undefined;
  let decision: WakeupDecision | undefined;

  const clearWakeupTasks = async (): Promise<void> => {
    for (const t of opts.cron.list()) {
      if (t.origin === "loop") await opts.cron.remove(t.id).catch(() => {});
    }
  };

  const resolveAndSubmit = async (): Promise<string> => {
    const arg = mode?.arg;
    const resolved = await resolveLoopPrompt({ workspaceRoot: opts.workspaceRoot, ...(arg !== undefined ? { arg } : {}), env: opts.env });
    // Skills expand only when model-invocable (plain text otherwise).
    opts.submit(expandLoopSkillPrompt(resolved.prompt, opts.skills ?? [], { workspaceRoot: opts.workspaceRoot }));
    return resolved.source;
  };

  const command = async (rawArgs: string): Promise<string> => {
    const args = rawArgs.trim();
    if (args === "stop" || args === "off" || args === "clear" || args === "end" || args === "cancel") {
      return stopCommand("/loop stop");
    }
    // A leading interval: a bare token (`30m do X` / `30m`) or an "every X"
    // clause (`every 2 hours do X` / `every 2 hours`). Everything after it is
    // the (optional) prompt.
    let intervalSource: string | undefined;
    let rest = "";
    const bare = /^(\d+[smhd])(?:\s+(.*))?$/i.exec(args);
    if (bare !== null) {
      intervalSource = bare[1]!.toLowerCase();
      rest = (bare[2] ?? "").trim();
    } else {
      const clause = /^every\s+(\d+\s*[a-z]+)(?:\s+(.*))?$/i.exec(args);
      if (clause !== null) {
        intervalSource = `every ${clause[1]!.replace(/\s+/g, "")}`;
        rest = (clause[2] ?? "").trim();
      }
    }
    if (intervalSource !== undefined) {
      const parsed = parseLoopInterval(intervalSource);
      if (!parsed.ok) return `⚠️ ${parsed.error}`;
      return startFixed(parsed.interval, rest !== "" ? rest : undefined);
    }
    // No interval → dynamic mode with the (optional) prompt.
    return startDynamic(args !== "" ? args : undefined);
  };

  const startFixed = async (interval: LoopInterval, arg: string | undefined): Promise<string> => {
    await clearWakeupTasks();
    decision = undefined;
    mode = { kind: "fixed", everyMs: interval.ms, ...(arg !== undefined ? { arg } : {}), startedAt: now() };
    const source = await resolveAndSubmit();
    return `🔁 /loop fixed: every ${fmtDuration(interval.ms)}${interval.note !== undefined ? ` (${interval.note})` : ""} · ends at /loop stop or the 7-day limit (${new Date(mode.startedAt + LOOP_TIME_LIMIT_MS).toISOString().slice(0, 10)}) · prompt: ${source}${arg === undefined ? " (editable via .wudao/loop.md)" : ""}`;
  };

  const startDynamic = async (arg: string | undefined): Promise<string> => {
    await clearWakeupTasks();
    decision = undefined;
    mode = { kind: "dynamic", ...(arg !== undefined && arg !== "" ? { arg } : {}), startedAt: now(), fallbackRound: false };
    const source = await resolveAndSubmit();
    return `🔁 /loop dynamic: the agent self-paces via schedule_wakeup (1m-1h; stop:true ends); silent rounds get one ~20m fallback, a second ends the loop · prompt: ${source}`;
  };

  const stopCommand = (reason?: string): string => {
    if (mode === undefined) return "(no /loop active)";
    void clearWakeupTasks();
    const was = mode.kind;
    mode = undefined;
    decision = undefined;
    return `⏹ /loop ${was} stopped${reason !== undefined && reason !== "/loop stop" ? ` (${reason})` : ""} — pending wakeups cleared; explicit scheduled tasks untouched`;
  };

  const onWakeupCall = (args: { delaySeconds?: unknown; stop?: unknown; reason?: unknown }): string => {
    if (mode === undefined || mode.kind !== "dynamic") {
      return "schedule_wakeup refused: no dynamic /loop is active (start one with /loop, or stop:true is meaningless here)";
    }
    if (args.stop === true) {
      decision = { kind: "stop" };
      return "loop stop recorded — this /loop ends at this turn's close";
    }
    const raw = Number(args.delaySeconds);
    if (!Number.isFinite(raw) || raw <= 0) {
      return "schedule_wakeup needs delaySeconds (60-3600) or stop:true";
    }
    const clamped = Math.min(WAKEUP_DELAY_MAX_S, Math.max(WAKEUP_DELAY_MIN_S, Math.round(raw)));
    const note = raw < WAKEUP_DELAY_MIN_S || raw > WAKEUP_DELAY_MAX_S ? ` (clamped from ${raw}s to the [60, 3600] range)` : "";
    decision = { kind: "continue", delaySeconds: clamped, ...(typeof args.reason === "string" && args.reason !== "" ? { reason: args.reason } : {}) };
    return `next wakeup in ${fmtDuration(clamped * 1000)}${note}${typeof args.reason === "string" && args.reason !== "" ? ` — ${args.reason}` : ""}`;
  };

  const onRunEnd = async (): Promise<void> => {
    if (mode === undefined) return;
    // Both modes re-arm at each run settle: the next wakeup carries a freshly
    // resolved prompt (loop.md edits are effective next round), and fires only
    // happen between rounds (fire-on-idle — rounds never stack).
    const m = mode;
    if (now() >= m.startedAt + LOOP_TIME_LIMIT_MS) {
      await clearWakeupTasks();
      opts.notify("⏹ /loop ended — the 7-day limit was reached");
      mode = undefined;
      decision = undefined;
      return;
    }
    let delayMs: number;
    let note: string | undefined;
    let fallbackRound = false;
    if (m.kind === "fixed") {
      delayMs = m.everyMs;
    } else {
      const action = nextDynamicAction(decision, m.fallbackRound);
      if (action.kind === "end") {
        await clearWakeupTasks();
        opts.notify("⏹ /loop dynamic ended — no wakeup scheduled in two consecutive rounds");
        mode = undefined;
        decision = undefined;
        return;
      }
      delayMs = action.delayMs;
      note = action.note;
      fallbackRound = action.fallback;
    }
    decision = undefined;
    await clearWakeupTasks();
    const resolved = await resolveLoopPrompt({ workspaceRoot: opts.workspaceRoot, ...(m.arg !== undefined ? { arg: m.arg } : {}), env: opts.env });
    await opts.cron.createTask({
      prompt: expandLoopSkillPrompt(resolved.prompt, opts.skills ?? [], { workspaceRoot: opts.workspaceRoot }),
      schedule: { type: "at", at: now() + delayMs },
      origin: "loop",
    });
    if (m.kind === "dynamic") mode = { ...m, fallbackRound };
    if (note !== undefined) opts.notify(note);
  };

  return {
    command,
    stopCommand,
    status: () => {
      if (mode === undefined) return "(no /loop active — /loop <interval> [prompt] for fixed, /loop [prompt] for dynamic)";
      const dur = fmtDuration(now() - mode.startedAt);
      return mode.kind === "fixed"
        ? `/loop fixed · every ${fmtDuration(mode.everyMs)} · running ${dur}`
        : `/loop dynamic · running ${dur}${mode.fallbackRound ? " · fallback armed (one more silent round ends it)" : ""}`;
    },
    onWakeupCall,
    onRunEnd,
    active: () => mode !== undefined,
    clearPendingOnEsc: () => opts.cron.clearLoopPending(),
  };
}

/** The schedule_wakeup model tool (session-start registration — prefix law).
 *  Late-bound controller: the tool joins the tool set before the driver (and
 *  therefore the controller) exists. */
export function createScheduleWakeupTool(getController: () => LoopController | undefined): Tool {
  return buildTool({
    name: "schedule_wakeup",
    description:
      "During a dynamic /loop, choose when this loop should wake next. delaySeconds clamps to [60, 3600] (1 minute to 1 hour); give a short reason for the chosen delay. stop:true ends the loop at this turn's close. A round that calls neither gets one ~20-minute fallback wakeup; two silent rounds end the loop.",
    parameters: {
      type: "object",
      properties: {
        delaySeconds: { type: "number", description: "Seconds until the next loop wakeup (clamped to 60-3600)" },
        stop: { type: "boolean", description: "true = end this /loop" },
        reason: { type: "string", description: "One line: why this delay" },
      },
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      const controller = getController();
      if (controller === undefined) {
        return { content: "schedule_wakeup refused: no /loop is active in this session (start one with /loop)", isError: true };
      }
      return { content: controller.onWakeupCall(args) };
    },
  });
}
