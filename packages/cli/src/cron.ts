// M61 §1 — the CLI-side scheduler runtime: owns the live task table over
// core's `.wudao/cron.json` store, the tick that decides due-ness, and the
// low-priority injection queue the loop's steering drain empties between
// turns. The driver (TUI/web/Slack) and the REPL both wire `takeInjection()`
// into their steering seam AFTER the user queue — scheduled work is strictly
// lower priority than the human — and auto-start a run from a pending
// injection when the frontend is idle (the "fire once when idle" path).
//
// Cache law: injections are turn-tail appends through the steering channel —
// the request prefix (system prompt + tools + prior messages) is byte-stable
// across all scheduled activity. det-48 asserts it.
import {
  CRON_EXPIRY_MS,
  CRON_TASK_CAP_PER_SESSION,
  CronStoreRefusedError,
  cronDisabled,
  formatScheduledInjection,
  isOneShotTask,
  loadCronStore,
  newCronTaskId,
  nextFire,
  type CronTask,
  type CronTaskSchedule,
} from "@wudao-org/core";

/** How often due-ness is re-checked (unref'd; never keeps the process alive). */
export const CRON_TICK_MS = 15_000;

export interface CronFire {
  readonly task: CronTask;
  /** The user-message text to inject (steering channel). */
  readonly injection: string;
  readonly kind: "scheduled" | "expiry-final";
}

export interface CronRuntime {
  /** The live table (the model tools' source of truth). */
  list(): readonly CronTask[];
  /** Raw insert (the core tools' path — core builds the task). Throws on
   *  per-session cap. Returns the task inserted. */
  addTask(task: CronTask): Promise<CronTask>;
  /** Create + insert a task for the current session (the CLI path — /loop and
   *  friends): generates the id, stamps createdAt/expiresAt. */
  createTask(input: { readonly prompt: string; readonly schedule: CronTaskSchedule; readonly origin?: "model" | "loop"; readonly dynamic?: boolean }): Promise<CronTask>;
  /** Remove by id. Returns false when unknown. */
  remove(id: string): Promise<boolean>;
  /** The core tools' table adapter (session-scoped list/add/remove). */
  table(): { list(): readonly CronTask[]; add(task: CronTask): Promise<void>; remove(id: string): Promise<boolean> };
  /** LOW-priority steering drain: one pending injection, or undefined. The
   *  fire is recorded when the injection is drained (fires only when the
   *  agent actually reaches the turn boundary). */
  takeInjection(): string | undefined;
  /** Re-check due-ness now (the timer calls this; tests call it directly).
   *  Returns the injections that became due. Pure-ish: it enqueues, it never
   *  runs anything — the frontend decides how a fire lands. */
  tick(now?: number): Promise<readonly CronFire[]>;
  /** The pending (queued, not yet drained) injections, in fire order. */
  pending(): readonly CronFire[];
  /** M61 §2: Esc — clear ONLY /loop-origin pending wakeups. Explicit
   *  model-created tasks stay armed. Returns the cleared count. */
  clearLoopPending(): number;
  /** M61 §1 resume: prune stale tasks for the session (expired-and-final-fired
   *  recurring, fired one-shots left by a crash) so only restorable work
   *  remains: unexpired recurring + un-fired one-shots. */
  restoreOnResume(now?: number): Promise<readonly CronTask[]>;
  /** ω-1: true while the in-memory table holds mutations a failed store
   *  write left unpersisted (memory is newer than disk). */
  isDirty(): boolean;
  /** ω-1: re-read the store from disk. While dirty the in-memory snapshot
   *  WINS — an older on-disk copy must never resurrect an already-fired
   *  due date. */
  reload(): Promise<void>;
  /** Stop the tick timer (driver dispose / REPL close). */
  stop(): void;
  /** Why the store is unavailable, when it is (kill-switch env / symlink). */
  readonly refusal?: string;
  /** Live session id (rotates on resume — the runtime follows). */
  setSessionId(id: string): void;
}

export interface CronRuntimeOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Auto-tick interval (0 = off; tests drive tick() manually). Default 15s. */
  readonly tickMs?: number;
  /** Fires each tick that found due work (driver pokes its idle seam here). */
  readonly onDue?: (fires: readonly CronFire[]) => void;
  /** Error sink for store failures (best-effort; never fatal). */
  readonly onWarn?: (line: string) => void;
}

/** Build the session's scheduler runtime. Never throws: a disabled env or a
 *  symlinked store yields an inert runtime carrying `refusal` (the tools and
 *  commands surface it — fail-closed, never a silent no-op). */
export async function createCronRuntime(opts: CronRuntimeOptions): Promise<CronRuntime> {
  const now = opts.now ?? Date.now;
  const warn = opts.onWarn ?? ((line: string) => process.stderr.write(`${line}\n`));
  let sessionId = opts.sessionId;

  // The refused/inert runtime: every operation reports the refusal.
  const inert = (reason: string): CronRuntime => ({
    list: () => [],
    addTask: async () => {
      throw new CronStoreRefusedError(reason === "disabled" ? "disabled" : "symlink", reason === "disabled" ? "" : "cron.json");
    },
    createTask: async () => {
      throw new CronStoreRefusedError(reason === "disabled" ? "disabled" : "symlink", reason === "disabled" ? "" : "cron.json");
    },
    remove: async () => false,
    table: () => ({
      list: () => [],
      add: async () => {
        throw new CronStoreRefusedError(reason === "disabled" ? "disabled" : "symlink", reason === "disabled" ? "" : "cron.json");
      },
      remove: async () => false,
    }),
    takeInjection: () => undefined,
    tick: async () => [],
    pending: () => [],
    clearLoopPending: () => 0,
    restoreOnResume: async () => [],
    isDirty: () => false,
    reload: async () => {},
    stop: () => {},
    refusal: reason,
    setSessionId: () => {},
  });

  if (cronDisabled(opts.env ?? {})) return inert("disabled");

  let tasks: CronTask[];
  let save: (tasks: readonly CronTask[]) => Promise<void>;
  try {
    const store = await loadCronStore({ workspaceRoot: opts.workspaceRoot, env: opts.env });
    tasks = [...store.tasks];
    save = store.save;
  } catch (err) {
    if (err instanceof CronStoreRefusedError) return inert(err.message.includes("symlink") ? "symlink" : "disabled");
    throw err;
  }

  // ω-1 — the dirty-flag persist (nanobot cron/service.py pattern): the store
  // is marked dirty BEFORE the in-memory table advances, and only a
  // successful save of that-or-newer snapshot clears the flag. A crashed run
  // that never re-saved can no longer replay a stale on-disk `lastFiredAt`
  // past a fire memory already recorded: reload defers to memory while
  // dirty, and every tick flushes a dirty snapshot before executing
  // anything. A failing write DEGRADES the scheduler (warn + keep running).
  let dirty = false;
  let saveSeq = 0;
  let saveTail: Promise<void> = Promise.resolve();
  const persist = (next: readonly CronTask[]): Promise<void> => {
    const mine = saveSeq += 1;
    dirty = true;
    tasks = [...next];
    // Saves serialize so an older snapshot can never land after a newer one.
    // Snapshots are whole-table and monotonic: a later success legitimately
    // clears the dirt an earlier failure left (its mutation is contained in
    // the newer on-disk snapshot); the seq guard stops a stale success from
    // clearing a newer attempt's dirt.
    const attempt = saveTail.then(() => save(next));
    saveTail = attempt.then(() => undefined, () => undefined);
    return attempt.then(
      () => {
        if (mine === saveSeq) dirty = false;
      },
      (err) => {
        dirty = true;
        warn(`⚠️ cron store save failed: ${err instanceof Error ? err.message : String(err)}`);
      },
    );
  };

  // ω-1: reload only while clean — a dirty memory is strictly newer than any
  // on-disk snapshot, so the disk copy must never overwrite it.
  const reload = async (): Promise<void> => {
    if (dirty) return;
    const store = await loadCronStore({ workspaceRoot: opts.workspaceRoot, env: opts.env });
    tasks = [...store.tasks];
  };

  // The pending injection queue: one entry per armed fire (deduped by task id
  // — a task that stays due across ticks enqueues exactly once).
  const queue: CronFire[] = [];
  const armed = new Set<string>();

  const fireOf = (task: CronTask, kind: "scheduled" | "expiry-final"): CronFire => ({
    task,
    injection: formatScheduledInjection(task),
    kind,
  });

  const armFire = (task: CronTask, kind: "scheduled" | "expiry-final"): CronFire | undefined => {
    if (armed.has(task.id)) return undefined;
    armed.add(task.id);
    const fire = fireOf(task, kind);
    queue.push(fire);
    return fire;
  };

  // ω99-115 — foreign-task adoption: a due task whose owning session is gone
  // (the desktop cold-starts a fresh session id every launch) is rebound to
  // the live session and fired — "明早9点提醒我X" survives an app restart.
  // Adoption happens ONLY at the moment the task is due (boundary ③): a live
  // foreign session's future tasks are never stolen; a dead owner's future
  // task is picked up by the first tick after it comes due. The pre-adopt
  // reload() re-checks disk under ω-1 rules (dirty ⇒ memory wins): if another
  // process already fired it (a fresh lastFiredAt, or a one-shot that
  // self-deleted) we decline — no adoption, no double fire. HONEST LIMIT
  // (boundary ①): two live processes sharing one workspace can both see
  // "due + foreign" inside a tick window — the reload narrows the double-fire
  // window to ≤ the tick interval, never to zero. v1 accepts it (a double
  // fire = two bubbles; the one-shot self-deletes on the first persist); the
  // #48 lease guard is the trigger gate to add if a real case shows up. The
  // per-session cap is deliberately NOT consulted (boundary ②): it guards
  // creation-time model spam, not runtime — an adoption blocked by the cap
  // is a reminder dying silently, which is worse.
  const adopt = async (
    task: CronTask,
    at: number,
  ): Promise<{ task: CronTask; kind: "scheduled" | "expiry-final" } | undefined> => {
    await reload();
    const fresh = tasks.find((t) => t.id === task.id);
    if (fresh === undefined) return undefined; // 他进程已触发，one-shot/expiry-final 已自删
    const fire = nextFire(fresh, at);
    if (fire === undefined || at < fire.fireAt) return undefined; // 他进程已触发（lastFiredAt 已新）→ 不收养不双发
    if (fresh.sessionId === sessionId) return { task: fresh, kind: fire.kind };
    const rebound = { ...fresh, sessionId };
    await persist(tasks.map((t) => (t.id === fresh.id ? rebound : t)));
    return { task: rebound, kind: fire.kind };
  };

  const tick = async (at = now()): Promise<readonly CronFire[]> => {
    // ω-1: flush a dirty store FIRST — the snapshot about to drive due-ness
    // (and any fire this tick arms) reaches disk before anything executes.
    if (dirty) await persist(tasks);
    const due: CronFire[] = [];
    for (const task of tasks) {
      const fire = nextFire(task, at);
      if (fire === undefined) continue;
      if (at < fire.fireAt) continue;
      if (task.sessionId !== sessionId) {
        const adopted = await adopt(task, at);
        if (adopted === undefined) continue;
        const armed2 = armFire(adopted.task, adopted.kind);
        if (armed2 !== undefined) due.push(armed2);
        continue;
      }
      const armed2 = armFire(task, fire.kind);
      if (armed2 !== undefined) due.push(armed2);
    }
    if (due.length > 0) opts.onDue?.(due);
    return due;
  };

  const recordFire = (fire: CronFire, at: number): void => {
    const task = fire.task;
    // One-shots and the expiry-final fire self-delete; everything else
    // records lastFiredAt = the actual fire time (no catch-up: missed
    // occurrences are skipped, never replayed).
    const selfDelete = isOneShotTask(task) || fire.kind === "expiry-final";
    void persist(
      selfDelete
        ? tasks.filter((t) => t.id !== task.id)
        : tasks.map((t) => (t.id === task.id ? { ...t, lastFiredAt: at } : t)),
    );
  };

  const timer = (opts.tickMs ?? CRON_TICK_MS) > 0
    ? setInterval(() => void tick().catch(() => {}), opts.tickMs ?? CRON_TICK_MS)
    : undefined;
  timer?.unref?.();
  // One tick at startup: a task that came due while the session was closed
  // fires once now (offline = no catch-up, one fire on next online).
  void tick().catch(() => {});

  const addTask = async (task: CronTask): Promise<CronTask> => {
    const mine = tasks.filter((t) => t.sessionId === sessionId);
    if (mine.length >= CRON_TASK_CAP_PER_SESSION) {
      throw new Error(`cron task cap reached: ${CRON_TASK_CAP_PER_SESSION} tasks per session (cron_delete one first)`);
    }
    await persist([...tasks, { ...task, sessionId }]);
    return { ...task, sessionId };
  };

  return {
    list: () => tasks.filter((t) => t.sessionId === sessionId),
    addTask,
    createTask: async (input) => {
      const createdAt = now();
      const recurring = input.schedule.type !== "at";
      return addTask({
        id: newCronTaskId(),
        sessionId,
        prompt: input.prompt,
        schedule: input.schedule,
        createdAt,
        ...(recurring ? { expiresAt: createdAt + CRON_EXPIRY_MS } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        ...(input.dynamic === true ? { dynamic: true } : {}),
      });
    },
    table: () => ({
      list: () => tasks.filter((t) => t.sessionId === sessionId),
      add: async (task: CronTask) => {
        await addTask(task);
      },
      remove: async (id: string) => {
        const before = tasks.length;
        await persist(tasks.filter((t) => t.id !== id));
        armed.delete(id);
        for (let i = queue.length - 1; i >= 0; i -= 1) {
          if (queue[i]!.task.id === id) queue.splice(i, 1);
        }
        return tasks.length < before;
      },
    }),
    remove: async (id) => {
      const before = tasks.length;
      await persist(tasks.filter((t) => t.id !== id));
      armed.delete(id);
      // Drop any pending injection for the removed task.
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        if (queue[i]!.task.id === id) queue.splice(i, 1);
      }
      return tasks.length < before;
    },
    takeInjection: () => {
      const fire = queue.shift();
      if (fire === undefined) return undefined;
      armed.delete(fire.task.id);
      recordFire(fire, now());
      return fire.injection;
    },
    tick,
    pending: () => [...queue],
    clearLoopPending: () => {
      let cleared = 0;
      for (let i = queue.length - 1; i >= 0; i -= 1) {
        const fire = queue[i]!;
        if (fire.task.origin === "loop") {
          queue.splice(i, 1);
          armed.delete(fire.task.id);
          cleared += 1;
        }
      }
      // M61 review fix: a due loop task left in the table would re-arm on the
      // next tick (≤15s) and the Esc would be a no-op. Remove the loop tasks
      // that are due RIGHT NOW — the pending wakeup dies with them. Explicit
      // model-created tasks are never touched, and a /loop that keeps running
      // re-arms its next wakeup at its next run settle (the controller owns
      // the cadence).
      const at = now();
      for (const task of tasks) {
        if (task.origin !== "loop" || task.sessionId !== sessionId) continue;
        const fire = nextFire(task, at);
        if (fire !== undefined && at >= fire.fireAt) {
          void persist(tasks.filter((t) => t.id !== task.id));
          armed.delete(task.id);
          cleared += 1;
        }
      }
      return cleared;
    },
    restoreOnResume: async (at = now()) => {
      // Prune what a crash could leave behind; keep the restorable set:
      // unexpired recurring + un-fired one-shots (a past-due un-fired
      // one-shot stays — it fires once on the next tick, then deletes).
      const stale = tasks.filter((t) => {
        if (t.sessionId !== sessionId) return false;
        if (isOneShotTask(t) && t.lastFiredAt !== undefined) return true; // fired but not deleted
        if (!isOneShotTask(t) && t.expiresAt !== undefined && t.lastFiredAt !== undefined && t.lastFiredAt >= t.expiresAt) return true; // final fire done
        return false;
      });
      if (stale.length > 0) await persist(tasks.filter((t) => !stale.includes(t)));
      return tasks.filter((t) => t.sessionId === sessionId);
    },
    isDirty: () => dirty,
    reload,
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
    },
    setSessionId: (id) => {
      sessionId = id;
    },
  };
}
