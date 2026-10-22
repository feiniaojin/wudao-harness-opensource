// ω-4a — the CLI-side monitor runtime: owns the process machinery core's pure
// module refuses to touch — spawning watched commands (scrubChildEnv, piped
// stdio, workspace cwd), the 64KB ring buffers, fs.watch tailing with
// read-delta, the 1s unref'd tick that evaluates silence/TTL, the SIGTERM →
// grace → SIGKILL reaping, the per-session watch cap, and the FIFO injection
// queue (core's capped/coalescing algebra) the loop's steering drain empties
// between turns. It sits BESIDE cli/src/cron.ts (shares nothing with it at
// runtime — only the pattern) and reuses nothing else in the CLI.
//
// Cache law (the cron precedent, det-48): injections are turn-tail appends
// through the steering channel — the request prefix is byte-stable across all
// monitor activity. The cli tests assert it.
//
// Lifecycle doctrine (report 54 §3.4): watches are in-memory only, session-
// scoped, and die with the process — a spawned child is not a durable object,
// so resume never resurrects a lie. Children spawn DETACHED into their own
// process group with piped stdio (F1 item 1, the former v2 residual: a
// shell:true spawn's real work sits in the shell's CHILDREN, so stop()
// signals the whole GROUP — kill(-pid) — instead of orphaning them; win32,
// which has no process groups, keeps the direct kill).
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import { spawn as nodeSpawn } from "node:child_process";
import { watch as nodeWatch } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  EMPTY_MONITOR_QUEUE,
  MONITOR_DISABLE_ENV,
  MONITOR_INLINE_PAYLOAD_CHARS,
  MONITOR_MAX_WATCHES_PER_SESSION,
  MONITOR_RING_BYTES,
  advanceWatch,
  endWatch,
  formatMonitorInjection,
  initialWatchState,
  monitorDisabled,
  monitorQueuePush,
  monitorQueueTake,
  newMonitorId,
  scrubChildEnv,
  terminalEvent,
  type MonitorEvent,
  type MonitorRegistry,
  type MonitorStartInput,
  type MonitorTerminalReason,
  type MonitorWatch,
  type MonitorWatchState,
} from "@wudao/core";

/** How often silence/TTL are re-checked (unref'd; never keeps the process alive). */
export const MONITOR_TICK_MS = 1000;
/** monitor_stop / TTL reaping: SIGTERM, then SIGKILL after this grace. */
export const MONITOR_KILL_GRACE_MS = 5000;
/** tail read-delta debounce (the file-change.ts:27 precedent: a save bursts). */
export const MONITOR_TAIL_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Injectable process seams (deterministic tests hand in fakes)
// ---------------------------------------------------------------------------

export interface MonitorChildStream {
  on(event: "data", listener: (chunk: string | Buffer) => void): unknown;
}

/** The child surface the runtime needs (ChildProcess satisfies this via the
 *  default adapter below; tests hand in fakes). `pid` is present on live
 *  spawns and drives the v2 group kill; fakes may omit it (killChild then
 *  degrades to the direct child.kill — the pre-v2 path). */
export interface MonitorChild {
  readonly stdout?: MonitorChildStream | null;
  readonly stderr?: MonitorChildStream | null;
  readonly pid?: number;
  onClose(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (err: Error) => void): void;
  kill(signal?: string): boolean;
}

export type MonitorSpawnFn = (
  command: string,
  opts: { readonly cwd: string; readonly env: NodeJS.ProcessEnv; readonly detached: boolean },
) => MonitorChild;

/** F1 item 1 (83): the process-kill seam behind the group kill. The pid is
 *  the NEGATIVE group pid; the default is the real process.kill. Throwing
 *  (ESRCH/EPERM) is part of the contract — killChild falls back to the
 *  direct child kill. */
export type MonitorKillFn = (pid: number, signal: string) => void;

export interface MonitorFileWatcherHandle {
  close(): void;
}

export type MonitorWatchFn = (
  path: string,
  onChange: () => void,
  onError: (err: Error) => void,
) => MonitorFileWatcherHandle;

// ---------------------------------------------------------------------------
// The runtime
// ---------------------------------------------------------------------------

export interface MonitorRuntime {
  /** The tools' registry seam (list/start/stop over the live watches). */
  registry(): MonitorRegistry;
  /** LOW-priority steering drain: one pending injection, or undefined. */
  takeInjection(): string | undefined;
  /** Evaluate silence/TTL (the timer calls this; tests drive it directly).
   *  Returns the events that fired. Enqueues only — never runs anything. */
  tick(now?: number): readonly MonitorEvent[];
  /** The pending (queued, not yet drained) events, in fire order. */
  pending(): readonly MonitorEvent[];
  /** The session sweep: kill children, close watchers, stop the tick. */
  stop(): void;
  /** Why monitoring is unavailable, when it is (kill-switch env). */
  readonly refusal?: string;
}

export interface MonitorRuntimeOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Auto-tick interval (0 = off; tests drive tick() manually). Default 1s. */
  readonly tickMs?: number;
  /** Test seam: the spawn dependency (default: real child_process.spawn). */
  readonly spawn?: MonitorSpawnFn;
  /** F1 item 1: test seam for the group kill (default: real process.kill). */
  readonly killProcess?: MonitorKillFn;
  /** Test seam: the file-watch dependency (default: real fs.watch). */
  readonly watch?: MonitorWatchFn;
  /** M24 spill dir for rings that exceed the inline payload cap. */
  readonly spillDir?: string;
  /** Test seam: SIGTERM→SIGKILL grace (default 5s). */
  readonly killGraceMs?: number;
  /** Test seam: tail debounce (default 500ms). */
  readonly debounceMs?: number;
  /** Test seam: event queue cap (default 32). */
  readonly queueCap?: number;
  /** Error sink for unexpected runtime failures (best-effort; never fatal). */
  readonly onWarn?: (line: string) => void;
}

/** The live watch: the spec, the pure evaluator state, the ring, the handles. */
interface LiveWatch {
  readonly spec: MonitorStartInput;
  readonly id: string;
  readonly createdAt: number;
  state: MonitorWatchState;
  buffer: string;
  /** 夜移 020: cumulative bytes ever appended (monotone) — the absolute
   *  frame both the ring trim and the read cursor are expressed in. */
  absLen: number;
  /** 夜移 020: absolute offset of the next byte a read() returns. Advanced
   *  ONLY by reads — never by event delivery (queue-cap drops make events
   *  untrustworthy as "seen"; undelivered bytes must stay readable). */
  readCursor: number;
  child?: MonitorChild;
  watcher?: MonitorFileWatcherHandle;
  fileSize: number;
  debounceTimer?: NodeJS.Timeout;
}

/** Build the session's monitor runtime. Never throws: the kill-switch env
 *  (WUDAO_DISABLE_MONITOR=1) yields an inert runtime carrying `refusal` —
 *  the tools and commands surface it (fail-closed, never a silent no-op). */
export function createMonitorRuntime(opts: MonitorRuntimeOptions): MonitorRuntime {
  if (monitorDisabled(opts.env ?? {})) {
    const inert: MonitorRuntime = {
      registry: () => ({
        list: () => [],
        start: async () => {
          throw new Error(`monitoring disabled (${MONITOR_DISABLE_ENV}=1)`);
        },
        stop: async () => false,
        read: () => undefined, // 夜移 020: nothing is ever live — the tools' refusal governs anyway
      }),
      takeInjection: () => undefined,
      tick: () => [],
      pending: () => [],
      stop: () => {},
      refusal: `disabled (${MONITOR_DISABLE_ENV}=1)`,
    };
    return inert;
  }

  const now = opts.now ?? Date.now;
  const warn = opts.onWarn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const killGraceMs = opts.killGraceMs ?? MONITOR_KILL_GRACE_MS;
  const debounceMs = opts.debounceMs ?? MONITOR_TAIL_DEBOUNCE_MS;
  const queueCap = opts.queueCap ?? 32;

  const doSpawn: MonitorSpawnFn = opts.spawn ?? ((command, spawnOpts) => {
    const cp = nodeSpawn(command, {
      cwd: spawnOpts.cwd,
      env: spawnOpts.env,
      shell: true,
      // F1 item 1: detached = own process group (pgid = pid), so the group
      // kill below reaches the shell's children too. Piped stdio either way
      // — a harness death still breaks the child's pipes.
      //
      // Known delta (report-83 review minor, report 89 item 5 — the documented
      // cost of group-kill v2): because the child lives in its OWN group, a
      // terminal-wide process-group signal (Ctrl+C SIGINT to the foreground
      // group) does NOT reach it. A detached child therefore SURVIVES the
      // terminal's death signals until monitor stop()'s explicit kill(-pid)
      // or until EPIPE when the harness's pipes (piped stdio above) break.
      // Orphan-until-stop/EPIPE is the accepted trade for the group kill's
      // ability to reap the shell's real worker children; do not "fix" the
      // detachment without replacing the group-kill semantics.
      detached: spawnOpts.detached,
      stdio: ["ignore", "pipe", "pipe"],
      // No console window for shell:true children of the console-less
      // desktop sidecar (closing one would kill the monitored process).
      windowsHide: true,
    });
    return {
      get stdout() { return cp.stdout ?? null; },
      get stderr() { return cp.stderr ?? null; },
      get pid() { return cp.pid; },
      onClose: (l) => { cp.on("close", (code, signal) => l(code, signal)); },
      onError: (l) => { cp.on("error", (err) => l(err)); },
      kill: (signal) => cp.kill(signal as NodeJS.Signals | undefined),
    };
  });

  // F1 item 1: the group-kill dependency (negative pid → the whole group).
  const doKillProcess: MonitorKillFn = opts.killProcess ?? ((pid, signal) => {
    process.kill(pid, signal as NodeJS.Signals);
  });

  const doWatch: MonitorWatchFn = opts.watch ?? ((path, onChange, onError) => {
    const w = nodeWatch(path, { persistent: false }, () => onChange());
    w.on("error", (err: Error) => onError(err));
    return { close: () => w.close() };
  });

  const live = new Map<string, LiveWatch>();
  let queue = EMPTY_MONITOR_QUEUE;
  const timers = new Set<NodeJS.Timeout>();

  const snapshot = (w: LiveWatch): MonitorWatch => ({
    id: w.id,
    kind: w.spec.kind,
    target: w.spec.target,
    conditions: w.spec.conditions,
    ttlMs: w.spec.ttlMs,
    createdAt: w.createdAt,
    fired: [
      ...(w.state.firedKeyword ? ["keyword"] : []),
      ...(w.state.firedLines ? ["lines"] : []),
      ...(w.state.firedSilence ? ["silence"] : []),
    ],
    bufferedBytes: w.buffer.length,
  });

  // M24 spill: the full ring, written when it exceeded the inline payload cap
  // (sync + best-effort — the shell.ts precedent).
  const spill = (text: string): string | undefined => {
    if (opts.spillDir === undefined) return undefined;
    try {
      mkdirSync(opts.spillDir, { recursive: true });
      const name = `${createHash("sha256").update(text).digest("hex").slice(0, 16)}.txt`;
      const path = join(opts.spillDir, name);
      writeFileSync(path, text, "utf8");
      return path;
    } catch {
      return undefined;
    }
  };

  const emit = (w: LiveWatch, event: MonitorEvent): void => {
    const enriched: MonitorEvent = {
      ...event,
      ...(w.buffer !== "" ? { output: w.buffer } : {}),
      ...(w.buffer.length > MONITOR_INLINE_PAYLOAD_CHARS
        ? (() => {
            const p = spill(w.buffer);
            return p !== undefined ? { spillPath: p } : {};
          })()
        : {}),
    };
    queue = monitorQueuePush(
      queue,
      { event: enriched, injection: formatMonitorInjection(enriched, snapshot(w)) },
      queueCap,
    );
  };

  const onChunk = (w: LiveWatch, text: string): void => {
    if (!live.has(w.id)) return; // terminal already fired — a no-op
    w.buffer = w.buffer.length + text.length > MONITOR_RING_BYTES
      ? truncateTailSafe(w.buffer + text, MONITOR_RING_BYTES)
      : w.buffer + text;
    w.absLen += text.length; // 夜移 020: the absolute frame advances monotonically
    const out = advanceWatch(w.state, text, now());
    w.state = out.state;
    for (const event of out.events) emit(w, event);
  };

  // F1 item 1 (83) — v2 process-group kill. The watched command runs under
  // shell:true, so killing only the direct child (the shell) orphans whatever
  // the shell spawned; the group kill (kill(-pid), pgid = the child's pid)
  // reaches the whole tree. Degradations, all preserving the escalation
  // timer: win32 (no process groups), a pid-less child, or a throwing group
  // kill falls back to the direct child.kill. That catch is a deliberate
  // catch-ALL, not an ESRCH/EPERM match — ANY throw from kill(-pid)
  // (ESRCH — the group is already gone; EPERM — reparented out of reach;
  // anything else) degrades to the direct kill, which is the safe
  // direction: the child still gets the signal and the escalation timer
  // still fires, so an unexpected error can only narrow the blast radius
  // from the tree to the shell, never skip the kill.
  const killChild = (child: MonitorChild | undefined): void => {
    if (child === undefined) return;
    const groupKill = (signal: string): boolean => {
      const pid = child.pid;
      if (pid === undefined || process.platform === "win32") return false;
      try { doKillProcess(-pid, signal); return true; } catch { return false; }
    };
    const kill = (signal: string): void => {
      if (groupKill(signal)) return;
      try { child.kill(signal); } catch { /* already gone */ }
    };
    kill("SIGTERM");
    const t = setTimeout(() => {
      timers.delete(t); // F4 (review 57): a fired escalation self-removes
      kill("SIGKILL");
    }, killGraceMs);
    t.unref?.();
    timers.add(t);
  };

  const clearWatchMachinery = (w: LiveWatch, kill: boolean): void => {
    if (w.debounceTimer !== undefined) {
      clearTimeout(w.debounceTimer);
      timers.delete(w.debounceTimer);
      w.debounceTimer = undefined;
    }
    try { w.watcher?.close(); } catch { /* closing a dead watcher */ }
    w.watcher = undefined;
    if (kill) killChild(w.child);
  };

  /** Reach a terminal state: exactly one completion event, then the watch is
   *  gone (children reaped when the runtime still owns a live one — TTL). */
  const terminate = (w: LiveWatch, reason: MonitorTerminalReason): MonitorEvent | undefined => {
    if (!live.has(w.id)) return undefined;
    live.delete(w.id);
    w.state = endWatch(w.state);
    clearWatchMachinery(w, reason.kind === "ttl");
    const event = terminalEvent(snapshot(w), reason, now());
    emit(w, event);
    return event;
  };

  const readDelta = async (w: LiveWatch): Promise<void> => {
    if (!live.has(w.id)) return;
    let size: number;
    try {
      size = (await stat(w.spec.target)).size;
    } catch (err) {
      // Deleted or unreadable — the terminal (a silent monitor is worse than
      // none; the model believed it would be told).
      terminate(w, { kind: "deleted", detail: err instanceof Error ? err.message : String(err) });
      return;
    }
    if (size < w.fileSize) w.fileSize = 0; // truncated/rotated — re-baseline
    if (size > w.fileSize) {
      try {
        const len = size - w.fileSize;
        const buf = Buffer.alloc(len);
        const fh = await open(w.spec.target, "r");
        try {
          const { bytesRead } = await fh.read(buf, 0, len, w.fileSize);
          onChunk(w, buf.subarray(0, bytesRead).toString("utf8"));
        } finally {
          await fh.close().catch(() => {});
        }
      } catch (err) {
        warn(`⚠️ monitor watch ${w.id} read failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    w.fileSize = size;
  };

  const scheduleDelta = (w: LiveWatch): void => {
    if (w.debounceTimer !== undefined) return; // a read is already scheduled
    const t = setTimeout(() => {
      w.debounceTimer = undefined;
      timers.delete(t);
      void readDelta(w);
    }, debounceMs);
    t.unref?.();
    timers.add(t);
    w.debounceTimer = t;
  };

  const tick = (at = now()): readonly MonitorEvent[] => {
    const fired: MonitorEvent[] = [];
    for (const w of [...live.values()]) {
      const out = advanceWatch(w.state, null, at);
      w.state = out.state;
      for (const event of out.events) {
        emit(w, event);
        fired.push(event);
      }
      if (at - w.createdAt >= w.spec.ttlMs) {
        const terminal = terminate(w, { kind: "ttl" });
        if (terminal !== undefined) fired.push(terminal);
      }
    }
    return fired;
  };

  const timer = (opts.tickMs ?? MONITOR_TICK_MS) > 0
    ? setInterval(() => { try { tick(); } catch { /* the runtime never takes the session down */ } }, opts.tickMs ?? MONITOR_TICK_MS)
    : undefined;
  timer?.unref?.();

  return {
    registry: (): MonitorRegistry => ({
      list: () => [...live.values()].map(snapshot),
      start: async (input) => {
        if (live.size >= MONITOR_MAX_WATCHES_PER_SESSION) {
          throw new Error(`monitor watch cap reached: ${MONITOR_MAX_WATCHES_PER_SESSION} per session (monitor_stop one first)`);
        }
        const id = newMonitorId();
        const w: LiveWatch = {
          spec: input,
          id,
          createdAt: now(),
          state: initialWatchState(id, input.conditions, now()),
          buffer: "",
          absLen: 0,
          readCursor: 0,
          fileSize: 0,
        };
        // F6 (review 57): register BEFORE the machinery wiring — a synchronous
        // watcher (or spawner) error during the setup below must reach
        // terminate() (which guards on live.has), not no-op and leave a dead,
        // silent watch behind.
        live.set(id, w);
        if (input.kind === "command") {
          try {
            const child = doSpawn(input.target, {
              cwd: opts.workspaceRoot,
              env: scrubChildEnv(),
              // F1 item 1: own process group on POSIX (win32 has none — the
              // detached flag there would only pop a new console).
              detached: process.platform !== "win32",
            });
            w.child = child;
            child.stdout?.on("data", (chunk) => onChunk(w, String(chunk)));
            child.stderr?.on("data", (chunk) => onChunk(w, String(chunk)));
            child.onClose((code, signal) => {
              if (signal !== null && signal !== undefined) {
                terminate(w, { kind: "error", detail: `killed by ${signal}` });
              } else {
                terminate(w, { kind: "exit", code: code ?? 0 });
              }
            });
            child.onError((err) => {
              const code = (err as { code?: string }).code;
              terminate(w, { kind: "error", detail: `spawn failed: ${code ?? err.message}` });
            });
          } catch (err) {
            live.delete(id); // a throwing spawner leaves nothing registered
            throw err;
          }
        } else {
          let size: number;
          try {
            size = (await stat(input.target)).size;
          } catch (err) {
            live.delete(id);
            throw new Error(`cannot watch ${input.target}: ${err instanceof Error ? err.message : String(err)}`);
          }
          w.fileSize = size; // existing content is old — appended lines only
          try {
            const handle = doWatch(
              input.target,
              () => scheduleDelta(w),
              (err) => {
                // Warn-once-and-drop posture (file-change.ts): the session
                // survives, the watch does not silently survive.
                warn(`⚠️ monitor watcher for ${input.target} stopped: ${err.message}`);
                terminate(w, { kind: "error", detail: `watcher failed: ${err.message}` });
              },
            );
            if (!live.has(id)) {
              // A synchronous onError during setup already terminated the
              // watch — the fresh handle must not dangle on the dead entry.
              try { handle.close(); } catch { /* already dead */ }
            } else {
              w.watcher = handle;
            }
          } catch (err) {
            live.delete(id); // a throwing watcher leaves nothing registered
            throw err;
          }
        }
        return snapshot(w);
      },
      stop: async (id) => {
        const w = live.get(id);
        if (w === undefined) return false;
        // Explicit cancellation: no wake (the asker knows), machinery down.
        live.delete(id);
        w.state = endWatch(w.state);
        clearWatchMachinery(w, true);
        return true;
      },
      // 夜移 020 — the on-demand read (BashOutput paradigm). Live watches
      // only: terminate()/stop() remove the watch, and the terminal event
      // already carried the full ring as its payload.
      read: (id) => {
        const w = live.get(id);
        if (w === undefined) return undefined;
        const trimmed = w.absLen - w.buffer.length; // bytes the ring's front dropped
        const start = Math.max(w.readCursor, trimmed);
        const output = w.buffer.slice(start - trimmed);
        const skippedBytes = Math.max(0, trimmed - w.readCursor);
        w.readCursor = w.absLen;
        return { output, skippedBytes, bufferedBytes: w.buffer.length };
      },
    }),
    takeInjection: () => {
      const taken = monitorQueueTake(queue);
      queue = taken.queue;
      if (taken.entry === undefined) return undefined;
      return taken.droppedPrefix !== undefined
        ? `${taken.droppedPrefix}\n${taken.entry.injection}`
        : taken.entry.injection;
    },
    tick,
    pending: () => queue.entries.map((e) => e.event),
    stop: () => {
      if (timer !== undefined) clearInterval(timer);
      for (const w of [...live.values()]) {
        live.delete(w.id);
        w.state = endWatch(w.state);
        clearWatchMachinery(w, true);
      }
      // F2 (review 57): the SIGKILL escalations armed by the sweep above (and
      // any still pending from earlier kills) must RUN — a SIGTERM-ignoring
      // child must not survive session teardown. They are unref'd and
      // self-delete on fire (F4); the sweep's own debounce timers were
      // already cleared per-watch by clearWatchMachinery, so nothing else
      // remains in `timers` to clean here.
    },
  };
}
