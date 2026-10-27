// M61 §1 — the in-session scheduler: vixie-cron parsing (5-field subset),
// deterministic jitter, fire/no-catch-up semantics, the 7-day expiry, and the
// `.wudao/cron.json` session-scoped task store. Pure core: no provider, no
// process.env reads (the caller passes env), no timers — the CLI runtime
// (cli/src/cron.ts) owns ticking and the steering-channel enqueue.
//
// Semantics (spec §1, CC scheduled-tasks):
//   • fires ONLY between turns (idle): a due task enqueues through the
//     steering queue's low-priority channel; a task that came due while busy
//     fires ONCE when the drain happens — never once per missed occurrence.
//   • deterministic jitter: the offset is derived from hash(taskId) — the
//     same id always gets the same offset. Recurring tasks fire LATE by at
//     most min(30min, interval/2); :00/:30 one-shots fire EARLY by at most
//     90s (avoiding the top-of-hour stampede).
//   • 7-day expiry: an expired recurring task fires one final time, then
//     self-deletes. One-shots self-delete on fire.
//   • storage: .wudao/cron.json, session-scoped (tasks carry sessionId), 50
//     tasks per session cap, symlinked path refused, WUDAO_DISABLE_CRON=1
//     disables everything.
import { lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { truncateSafe } from "./text-truncate.js";
import { randomInt } from "node:crypto";
import { buildTool } from "./tool.js";
import type { Tool } from "./tool.js";

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** A 5-field vixie-cron expression (`m h dom mon dow`). */
export interface CronSchedule {
  readonly type: "cron";
  readonly expr: string;
}

/** One absolute fire time (epoch ms) — used by durable §4 tasks and tests. */
export interface AtSchedule {
  readonly type: "at";
  readonly at: number;
}

/** A fixed interval (ms) — the /loop fixed mode (§2). */
export interface IntervalSchedule {
  readonly type: "interval";
  readonly everyMs: number;
}

export type CronTaskSchedule = CronSchedule | AtSchedule | IntervalSchedule;

/** One session-scoped scheduled task. */
export interface CronTask {
  /** 8-char [a-z0-9] id — also the jitter key. */
  readonly id: string;
  /** Owning session; cron_list and the per-session cap scope by it. */
  readonly sessionId: string;
  /** The prompt injected when the task fires. */
  readonly prompt: string;
  readonly schedule: CronTaskSchedule;
  /** Epoch ms. */
  readonly createdAt: number;
  /** Epoch ms; recurring/interval tasks expire 7 days after creation. */
  readonly expiresAt?: number;
  /** Epoch ms of the last FIRE (not the scheduled time — no catch-up). */
  readonly lastFiredAt?: number;
  /** M61 §2: `loop` tasks are /loop's own wakeups — Esc clears only those. */
  readonly origin?: "model" | "loop";
  /** M61 §2: a dynamic /loop task self-schedules via schedule_wakeup. */
  readonly dynamic?: boolean;
}

export const CRON_TASK_CAP_PER_SESSION = 50;
export const CRON_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
export const CRON_DISABLE_ENV = "WUDAO_DISABLE_CRON";
/** The late-jitter ceiling for recurring tasks (spec: min(30min, interval/2)). */
export const RECURRING_JITTER_MAX_MS = 30 * 60 * 1000;
/** The early-jitter ceiling for :00/:30 one-shots (spec: ≤90s early). */
export const ONESHOT_EARLY_MAX_MS = 90 * 1000;
/** Cron fields: [minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-7(0|7=Sun)]. */
const FIELD_RANGES: readonly [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];

/** Pure env check (the caller passes process.env; core never reads it). */
export function cronDisabled(env: NodeJS.ProcessEnv = {}): boolean {
  return (env[CRON_DISABLE_ENV] ?? "").trim() === "1";
}

/** A fresh 8-char [a-z0-9] task id. */
export function newCronTaskId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 8; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

// ---------------------------------------------------------------------------
// M61 §1 — vixie-cron parsing (5-field subset)
// ---------------------------------------------------------------------------

export interface CronFieldSpec {
  /** `*` (unrestricted) — the DOM/DOW OR rule keys on "both restricted". */
  readonly any: boolean;
  readonly values: ReadonlySet<number>;
}

export interface CronSpec {
  readonly minute: CronFieldSpec;
  readonly hour: CronFieldSpec;
  readonly dom: CronFieldSpec;
  readonly month: CronFieldSpec;
  readonly dow: CronFieldSpec;
}

export type CronParseResult = { ok: true; spec: CronSpec } | { ok: false; error: string };

/**
 * Parse one 5-field vixie-cron expression. Supported per field: star, plain
 * value, range (a-b), step (star-slash-n, a-b-slash-n), and comma lists.
 * NOT supported (fail with a clear error): L / W / ? / # / day-month names /
 * @aliases / a 6th seconds field — the subset the spec pins.
 */
export function parseCronExpr(expr: string): CronParseResult {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `cron expression must have exactly 5 fields (minute hour dom month dow), got ${fields.length}: "${expr}"` };
  }
  const out: CronFieldSpec[] = [];
  for (let i = 0; i < 5; i += 1) {
    const field = fields[i] as string;
    const [lo, hi] = FIELD_RANGES[i] as [number, number];
    // Any letter immediately names the unsupported extras (L, W, ?, JAN, mon,
    // @yearly …) — one check covers the whole alias family.
    if (/[A-Za-z@?]/.test(field)) {
      return { ok: false, error: `cron field ${i + 1} "${field}": L/W/?/# and name aliases (@yearly, mon, jan …) are not supported` };
    }
    const values = new Set<number>();
    let any = false;
    for (const part of field.split(",")) {
      if (part === "") return { ok: false, error: `cron field ${i + 1} "${field}": empty list item` };
      const m = /^(?:(\*|\d+-\d+|\d+)(?:\/(\d+))?)$/.exec(part);
      if (m === null) return { ok: false, error: `cron field ${i + 1} "${field}": cannot parse item "${part}"` };
      const step = m[2] !== undefined ? Number(m[2]) : 1;
      if (!Number.isInteger(step) || step < 1) {
        return { ok: false, error: `cron field ${i + 1} "${field}": step must be a positive integer` };
      }
      let start: number;
      let end: number;
      if (m[1] === "*") {
        any = true;
        start = lo;
        end = hi;
      } else if (m[1]!.includes("-")) {
        const [a, b] = m[1]!.split("-");
        start = Number(a);
        end = Number(b);
      } else {
        start = Number(m[1]);
        end = start;
      }
      if (start > end) return { ok: false, error: `cron field ${i + 1} "${field}": range start > end in "${part}"` };
      if (start < lo || end > hi) {
        return { ok: false, error: `cron field ${i + 1} "${field}": value out of range ${lo}-${hi} in "${part}"` };
      }
      for (let v = start; v <= end; v += step) values.add(i === 4 && v === 7 ? 0 : v); // dow 7 → 0 (Sunday)
    }
    out.push({ any, values });
  }
  return { ok: true, spec: { minute: out[0]!, hour: out[1]!, dom: out[2]!, month: out[3]!, dow: out[4]! } };
}

/** Does `date` (local timezone — spec: 本地时区) match the spec? */
export function cronMatches(spec: CronSpec, date: Date): boolean {
  if (!spec.minute.values.has(date.getMinutes())) return false;
  if (!spec.hour.values.has(date.getHours())) return false;
  if (!spec.month.values.has(date.getMonth() + 1)) return false;
  const domOk = spec.dom.values.has(date.getDate());
  const dowOk = spec.dow.values.has(date.getDay());
  // Vixie deviation the spec pins: when BOTH dom and dow are restricted,
  // either matching fires (OR); when only one is restricted it must match.
  if (!spec.dom.any && !spec.dow.any) return domOk || dowOk;
  return domOk && dowOk;
}

/** Scan forward minute-by-minute from `from` (exclusive) for the next match.
 *  Bounded to 4 years (Feb-29-class specs); undefined = no match in bound. */
export function nextCronTime(spec: CronSpec, from: Date): Date | undefined {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const bound = d.getTime() + 4 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= bound) {
    if (cronMatches(spec, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// M61 §1 — deterministic jitter (hash(taskId)-derived; same id ⇒ same offset)
// ---------------------------------------------------------------------------

/** FNV-1a over the key → a stable [0,1) fraction. */
export function hashFraction(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h / 0x1_0000_0000;
}

/** Recurring/interval tasks: how LATE the fire may land (0 … min(30min, interval/2)). */
export function recurringLateJitterMs(taskId: string, intervalMs: number): number {
  const cap = Math.min(RECURRING_JITTER_MAX_MS, Math.floor(intervalMs / 2));
  return Math.floor(hashFraction(taskId) * cap);
}

/** :00/:30 one-shots: how EARLY the fire may land (0 … 90s). Others: 0. */
export function oneshotEarlyJitterMs(taskId: string, fireAt: number): number {
  const d = new Date(fireAt);
  const minuteOfHour = d.getMinutes();
  if (minuteOfHour !== 0 && minuteOfHour !== 30) return 0;
  return Math.floor(hashFraction(taskId) * ONESHOT_EARLY_MAX_MS);
}

/** The cron spec's typical interval (gap between the first two upcoming
 *  occurrences from `from`) — the recurring jitter's interval/2 input. */
export function cronIntervalMs(spec: CronSpec, from: Date): number {
  const first = nextCronTime(spec, from);
  if (first === undefined) return RECURRING_JITTER_MAX_MS;
  const second = nextCronTime(spec, first);
  if (second === undefined) return RECURRING_JITTER_MAX_MS;
  return Math.max(60_000, second.getTime() - first.getTime());
}

// ---------------------------------------------------------------------------
// Fire-time computation (the scheduler's due math)
// ---------------------------------------------------------------------------

export type FireKind = "scheduled" | "expiry-final";

export interface FireDecision {
  /** Effective epoch-ms fire time (jitter applied). */
  readonly fireAt: number;
  /** Why: the normal next occurrence, or the 7-day-expiry final fire. */
  readonly kind: FireKind;
}

/** The next scheduled time strictly after `after` for the task's schedule
 *  (undefined = none — an `at` in the past, or a cron that never matches). */
export function nextScheduledTime(task: CronTask, after: number): number | undefined {
  switch (task.schedule.type) {
    case "cron": {
      const parsed = parseCronExpr(task.schedule.expr);
      if (!parsed.ok) return undefined;
      const next = nextCronTime(parsed.spec, new Date(after));
      return next?.getTime();
    }
    case "at":
      return task.schedule.at > after ? task.schedule.at : undefined;
    case "interval": {
      const anchor = task.lastFiredAt ?? task.createdAt;
      return anchor + task.schedule.everyMs;
    }
  }
}

/** Is this task a one-shot? (cron with recurring:false, or an `at` schedule). */
export function isOneShotTask(task: CronTask): boolean {
  if (task.schedule.type === "at") return true;
  if (task.schedule.type !== "cron") return false;
  // A cron task without expiresAt is a one-shot (recurring=false at create).
  return task.expiresAt === undefined;
}

/** The effective next fire for a task, or undefined when nothing is pending
 *  (one-shot already fired/deleted, or no upcoming occurrence). Pure. */
export function nextFire(task: CronTask, now: number): FireDecision | undefined {
  const after = task.lastFiredAt ?? task.createdAt;
  // The 7-day expiry: an expired recurring task fires ONE final time even
  // when its next occurrence is further out, then self-deletes.
  if (!isOneShotTask(task) && task.expiresAt !== undefined && now >= task.expiresAt && (task.lastFiredAt ?? 0) < task.expiresAt) {
    return { fireAt: task.expiresAt, kind: "expiry-final" };
  }
  const scheduled = nextScheduledTime(task, after);
  if (scheduled === undefined) return undefined;
  if (isOneShotTask(task)) {
    return { fireAt: scheduled - oneshotEarlyJitterMs(task.id, scheduled), kind: "scheduled" };
  }
  // Recurring: deterministic LATE jitter, capped at min(30min, interval/2).
  const intervalMs = task.schedule.type === "interval"
    ? task.schedule.everyMs
    : task.schedule.type === "cron"
      ? (() => {
          const parsed = parseCronExpr(task.schedule.expr);
          return cronIntervalMs(parsed.ok ? parsed.spec : FALLBACK_ANY_SPEC, new Date(after));
        })()
      : RECURRING_JITTER_MAX_MS;
  return { fireAt: scheduled + recurringLateJitterMs(task.id, intervalMs), kind: "scheduled" };
}

/** parseCronExpr's error branch can't happen here (validated at create), but
 *  the type must narrow — an any-field spec degrades the jitter cap to the
 *  30-minute ceiling, the same value an unmatchable cron produces. */
const FALLBACK_ANY_SPEC: CronSpec = {
  minute: { any: true, values: new Set<number>() },
  hour: { any: true, values: new Set<number>() },
  dom: { any: true, values: new Set<number>() },
  month: { any: true, values: new Set<number>() },
  dow: { any: true, values: new Set<number>() },
};

// ---------------------------------------------------------------------------
// The .wudao/cron.json store (session-scoped; symlink-refusing)
// ---------------------------------------------------------------------------

export const CRON_STORE_FILE = "cron.json";

export type CronStoreReason = "disabled" | "symlink" | undefined;

interface CronFileShape {
  readonly version: 1;
  readonly tasks: readonly CronTask[];
}

/** Errors the store refuses with (disabled env / symlinked path). Anything
 *  else (read/write IO) throws normally. */
export class CronStoreRefusedError extends Error {
  constructor(reason: "disabled" | "symlink", detail: string) {
    super(reason === "disabled" ? `cron store disabled (${CRON_DISABLE_ENV}=1)` : `cron store refused: ${detail} is a symlink`);
    this.name = "CronStoreRefusedError";
  }
}

/** Normalize one parsed JSON value into a valid task, or drop it. */
function validTask(v: unknown): CronTask | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const t = v as Record<string, unknown>;
  const id = t.id;
  const sessionId = t.sessionId;
  const prompt = t.prompt;
  const createdAt = t.createdAt;
  if (typeof id !== "string" || id.length !== 8) return undefined;
  if (typeof sessionId !== "string" || typeof prompt !== "string" || typeof createdAt !== "number") return undefined;
  const s = t.schedule as Record<string, unknown> | undefined;
  if (typeof s !== "object" || s === null) return undefined;
  let schedule: CronTaskSchedule | undefined;
  if (s.type === "cron" && typeof s.expr === "string") schedule = { type: "cron", expr: s.expr };
  else if (s.type === "at" && typeof s.at === "number") schedule = { type: "at", at: s.at };
  else if (s.type === "interval" && typeof s.everyMs === "number" && s.everyMs > 0) schedule = { type: "interval", everyMs: s.everyMs };
  if (schedule === undefined) return undefined;
  return {
    id,
    sessionId,
    prompt,
    schedule,
    createdAt,
    ...(typeof t.expiresAt === "number" ? { expiresAt: t.expiresAt } : {}),
    ...(typeof t.lastFiredAt === "number" ? { lastFiredAt: t.lastFiredAt } : {}),
    ...(t.origin === "loop" ? { origin: "loop" as const } : {}),
    ...(t.dynamic === true ? { dynamic: true } : {}),
  };
}

/** Load (or create) the cron.json store. Throws CronStoreRefusedError when
 *  the kill-switch env is set or the target path is a symlink; other IO
 *  errors propagate (a read of a missing file yields an empty store). */
export async function loadCronStore(opts: {
  readonly workspaceRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly fileName?: string;
}): Promise<{ tasks: CronTask[]; save(tasks: readonly CronTask[]): Promise<void> }> {
  if (cronDisabled(opts.env ?? {})) throw new CronStoreRefusedError("disabled", "");
  const dir = join(opts.workspaceRoot, ".wudao");
  const path = join(dir, opts.fileName ?? CRON_STORE_FILE);
  const info = await lstat(path).catch(() => undefined);
  if (info?.isSymbolicLink()) throw new CronStoreRefusedError("symlink", path);
  let tasks: CronTask[] = [];
  if (info !== undefined) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<CronFileShape>;
      if (Array.isArray(parsed.tasks)) {
        tasks = parsed.tasks.map(validTask).filter((t): t is CronTask => t !== undefined);
      }
    } catch {
      tasks = []; // corrupt file → empty store (fail-safe, never fatal)
    }
  }
  return {
    tasks,
    save: async (next) => {
      await mkdir(dir, { recursive: true });
      const body = `${JSON.stringify({ version: 1, tasks: next } satisfies CronFileShape, null, 2)}\n`;
      // Atomic-ish: write beside, then rename over.
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, body, "utf8");
      await rename(tmp, path);
    },
  };
}

// ---------------------------------------------------------------------------
// M61 §1 — the model-facing tool trio (cron_create / cron_list / cron_delete)
// ---------------------------------------------------------------------------

export interface CronToolDeps {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Live task table (the runtime's source of truth — ALREADY scoped to the
   *  live session id, which rotates on resume); absent → the tools load from
   *  disk per call and scope by `sessionId` themselves (headless/test usage). */
  readonly table?: {
    list(): readonly CronTask[];
    add(task: CronTask): Promise<void>;
    remove(id: string): Promise<boolean>;
  };
  readonly now?: () => number;
}

export const SCHEDULED_INJECTION_LEAD = "[scheduled task";

/** The user-message text a fired task injects (steering channel, turn tail). */
export function formatScheduledInjection(task: CronTask): string {
  return `${SCHEDULED_INJECTION_LEAD} ${task.id}] ${task.prompt}`;
}

function describeTask(task: CronTask, now: number): string {
  const sched = task.schedule.type === "cron"
    ? task.schedule.expr
    : task.schedule.type === "at"
      ? new Date(task.schedule.at).toISOString()
      : `every ${Math.round(task.schedule.everyMs / 60000)}m`;
  const fire = nextFire(task, now);
  const next = fire === undefined ? "none" : `${new Date(fire.fireAt).toISOString()}${fire.kind === "expiry-final" ? " (final — expires)" : ""}`;
  return `- ${task.id}: ${sched}${task.origin === "loop" ? " (/loop)" : ""} · next: ${next}${task.lastFiredAt !== undefined ? ` · last fired: ${new Date(task.lastFiredAt).toISOString()}` : ""}\n  prompt: ${truncateSafe(task.prompt, 120)}`; // 113-A4
}

/** The tool trio, session-scoped. Registered at session START (like the other
 *  builtins) so the request tool list — part of the cacheable prefix — never
 *  changes mid-session when scheduling activity happens. */
export function createCronTools(deps: CronToolDeps): Tool[] {
  const now = deps.now ?? Date.now;
  // With a live table the runtime owns the (rotating) session id; the static
  // deps.sessionId is only the disk-path fallback.
  const sessionOf = (): string => (deps.table !== undefined ? "" : deps.sessionId);
  const loadTable = async () => {
    if (deps.table !== undefined) return { list: () => deps.table!.list(), add: deps.table!.add, remove: deps.table!.remove };
    const store = await loadCronStore({ workspaceRoot: deps.workspaceRoot, env: deps.env });
    let tasks = store.tasks;
    return {
      list: () => tasks.filter((t) => t.sessionId === deps.sessionId),
      add: async (task: CronTask) => {
        tasks = [...tasks, task];
        await store.save(tasks);
      },
      remove: async (id: string) => {
        const before = tasks.length;
        tasks = tasks.filter((t) => t.id !== id);
        await store.save(tasks);
        return tasks.length < before;
      },
    };
  };
  // The refusal surfaces as a tool error (fail-closed, never a silent no-op).
  const refusal = (err: unknown): { content: string; isError: true } | undefined =>
    err instanceof CronStoreRefusedError ? { content: `scheduling unavailable: ${err.message}`, isError: true } : undefined;

  const cronCreate = buildTool({
    name: "cron_create",
    description:
      "Schedule a prompt to run on a 5-field cron expression (minute hour day-of-month month day-of-week, local timezone). Supports *, ranges (a-b), steps (*/n, a-b/n) and lists (a,b,c); does NOT support L/W/?/# or name aliases. When both day-of-month AND day-of-week are restricted, EITHER match fires (vixie OR semantics). recurring=true keeps firing until deleted or 7-day expiry (one final fire then auto-delete); recurring=false fires once at the next match then auto-deletes. Tasks fire only between turns; missed occurrences are not caught up (one fire when idle). Max 50 tasks per session.",
    parameters: {
      type: "object",
      properties: {
        cron: { type: "string", description: "5-field cron expression, e.g. \"*/30 * * * *\" (every 30 minutes) or \"0 9 * * 1-5\" (weekdays 09:00)" },
        prompt: { type: "string", description: "The prompt to inject when the task fires" },
        recurring: { type: "boolean", description: "true = recurring until 7-day expiry or cron_delete; false = fire once at the next match" },
      },
      required: ["cron", "prompt", "recurring"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(args) {
      const expr = String(args.cron ?? "");
      const parsed = parseCronExpr(expr);
      if (!parsed.ok) return { content: `invalid cron expression: ${parsed.error}`, isError: true };
      // A spec that never matches within 4 years cannot ever fire — refuse.
      const next = nextCronTime(parsed.spec, new Date(now()));
      if (next === undefined) {
        return { content: `invalid cron expression: "${expr}" has no matching time in the next 4 years`, isError: true };
      }
      let table;
      try {
        table = await loadTable();
      } catch (err) {
        const r = refusal(err);
        if (r !== undefined) return r;
        throw err;
      }
      const mine = table.list();
      if (mine.length >= CRON_TASK_CAP_PER_SESSION) {
        return { content: `cron task cap reached: ${CRON_TASK_CAP_PER_SESSION} tasks per session (cron_delete one first)`, isError: true };
      }
      const recurring = args.recurring === true;
      const createdAt = now();
      const task: CronTask = {
        id: newCronTaskId(),
        sessionId: sessionOf(),
        prompt: String(args.prompt ?? ""),
        schedule: { type: "cron", expr },
        createdAt,
        ...(recurring ? { expiresAt: createdAt + CRON_EXPIRY_MS } : {}),
        origin: "model",
      };
      await table.add(task);
      const fire = nextFire(task, createdAt);
      return {
        content: `scheduled task ${task.id}${recurring ? " (recurring, expires " + new Date(task.expiresAt!).toISOString() + ")" : " (one-shot)"} · next fire ~${fire ? new Date(fire.fireAt).toISOString() : "n/a"}\nfires only between turns; missed occurrences are not caught up`,
      };
    },
  });

  const cronList = buildTool({
    name: "cron_list",
    description: "List this session's scheduled tasks (id, schedule, next fire, last fired, prompt preview).",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      let table;
      try {
        table = await loadTable();
      } catch (err) {
        const r = refusal(err);
        if (r !== undefined) return r;
        throw err;
      }
      const mine = table.list();
      if (mine.length === 0) return { content: "no scheduled tasks this session" };
      return { content: `scheduled tasks (${mine.length}/${CRON_TASK_CAP_PER_SESSION}):\n${mine.map((t) => describeTask(t, now())).join("\n")}` };
    },
  });

  const cronDelete = buildTool({
    name: "cron_delete",
    description: "Delete one of this session's scheduled tasks by its 8-character id (see cron_list).",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "8-character task id from cron_list" } },
      required: ["id"],
      additionalProperties: false,
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    isOpenWorld: () => false,
    async execute(args) {
      const id = String(args.id ?? "");
      let table;
      try {
        table = await loadTable();
      } catch (err) {
        const r = refusal(err);
        if (r !== undefined) return r;
        throw err;
      }
      const owned = table.list().some((t) => t.id === id);
      if (!owned) return { content: `no scheduled task ${id} in this session (cron_list lists the ids)`, isError: true };
      await table.remove(id);
      return { content: `deleted scheduled task ${id}` };
    },
  });

  return [cronCreate, cronList, cronDelete];
}
