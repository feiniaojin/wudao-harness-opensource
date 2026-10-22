// 夜移 028 — preventSleep 电源断言 (CCB caffeinate 的多驱动移植).
// Keeps macOS awake while agent runs are actively working: a refCounted
// `caffeinate -i -t 300` child process (idle-sleep assertion, 5-minute
// self-expiry — the orphan self-heals if THIS process is SIGKILLed, e.g. a
// desktop force-quit) restarted on a 4-minute interval before expiry.
// Held only while work is in flight: a run parked on a human permission
// dialog does NOT hold the assertion (the dialog can sit for hours; sleep
// prevention is for unattended runs — blocked-on-human means the human is
// present).
//
// Wudao deltas over CCB (recorded in the ledger):
// - The refCount is load-bearing: the web/desktop server hosts multiple
//   concurrent drivers in one process — N busy sessions share ONE
//   caffeinate; the last release tears it down.
// - createSleepGuard replaces CCB's React useEffect pairing for the
//   imperative driver: idempotent derived-state sync (a missed transition
//   self-heals at the next one) with a debounced release so the
//   settle→queue-drain seam never churns the assertion between
//   back-to-back queued runs.
// - Injectable spawn/platform/interval seams (CCB ships zero tests).
import { spawn } from "node:child_process";

/** caffeinate auto-exits after this many seconds (self-healing ceiling for
 *  orphaned assertions); the restart interval re-spawns before expiry. */
export const CAFFEINATE_TIMEOUT_SECONDS = 300;
/** Restart cadence — comfortably inside the 5-minute -t window. */
export const CAFFEINATE_RESTART_INTERVAL_MS = 4 * 60 * 1000;
/** Guard release debounce: settle→drain re-acquire must not churn the
 *  assertion (acquisition is immediate; only release waits). */
export const RELEASE_DEBOUNCE_MS = 1000;
/** Kill switch — the whole cli test environment sets this (driver tests
 *  transition busy constantly and must never spawn the developer's real
 *  caffeinate); users can set it too. */
export const PREVENT_SLEEP_DISABLE_ENV = "WUDAO_NO_PREVENT_SLEEP";

/** The child-process surface the controller consumes — deliberately NOT
 *  Node's overloaded EventEmitter shape (plain methods, trivial to fake). */
export interface PreventSleepChild {
  unref(): void;
  onError(listener: (error: Error) => void): void;
  onExit(listener: () => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** Injectable spawn seam (tests record calls; production spawns real
 *  caffeinate with stdio ignored). */
export type PreventSleepSpawn = (command: string, args: readonly string[]) => PreventSleepChild;

const defaultCaffeinateSpawn: PreventSleepSpawn = (command, args) => {
  const proc = spawn(command, [...args], { stdio: "ignore" });
  return {
    unref: () => {
      proc.unref();
    },
    onError: (listener) => {
      proc.on("error", listener);
    },
    onExit: (listener) => {
      proc.on("exit", () => listener());
    },
    kill: (signal) => proc.kill(signal),
  };
};

export interface PreventSleepController {
  /** A unit of work started that should keep the machine awake. The first
   *  holder spawns caffeinate; later holders just bump the count. */
  acquire(): void;
  /** A unit of work finished. The assertion dies with the LAST release. */
  release(): void;
  /** Drop the assertion regardless of outstanding holders (process-exit
   *  sweep / dispose safety net). */
  forceStop(): void;
  /** Outstanding holder count (introspection for tests and the det suite). */
  refCount(): number;
}

export interface PreventSleepOptions {
  readonly spawnFn?: PreventSleepSpawn;
  readonly platform?: string;
  readonly restartIntervalMs?: number;
  /** Register a process-exit forceStop on creation (the production
   *  singleton does; test controllers skip it). */
  readonly exitCleanup?: boolean;
}

export function createPreventSleepController(options: PreventSleepOptions = {}): PreventSleepController {
  const spawnFn = options.spawnFn ?? defaultCaffeinateSpawn;
  const darwin = (options.platform ?? process.platform) === "darwin";
  const restartMs = options.restartIntervalMs ?? CAFFEINATE_RESTART_INTERVAL_MS;

  let child: PreventSleepChild | null = null;
  let restartInterval: ReturnType<typeof setInterval> | null = null;
  let holders = 0;

  const killCaffeinate = (): void => {
    if (child !== null) {
      const proc = child;
      child = null;
      try {
        // SIGKILL for immediate termination — SIGTERM could be delayed.
        proc.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  };

  const spawnCaffeinate = (): void => {
    if (!darwin || child !== null) return;
    try {
      const proc = spawnFn("caffeinate", ["-i", "-t", String(CAFFEINATE_TIMEOUT_SECONDS)]);
      child = proc;
      // Never let caffeinate hold this process open.
      proc.unref();
      // Identity-guarded cleanup: an async error/exit only clears the slot
      // if this child still occupies it (a restart may have already won it).
      proc.onError(() => {
        if (child === proc) child = null;
      });
      proc.onExit(() => {
        if (child === proc) child = null;
      });
    } catch {
      // caffeinate missing / spawn refused — silently fail (best-effort).
      child = null;
    }
  };

  const stopRestart = (): void => {
    if (restartInterval !== null) {
      clearInterval(restartInterval);
      restartInterval = null;
    }
  };

  const startRestart = (): void => {
    if (!darwin || restartInterval !== null) return;
    restartInterval = setInterval(() => {
      if (holders > 0) {
        killCaffeinate();
        spawnCaffeinate(); // fresh -t window; also re-arms after error/exit
      }
    }, restartMs);
    restartInterval.unref();
  };

  const controller: PreventSleepController = {
    acquire() {
      holders += 1;
      if (holders === 1) {
        spawnCaffeinate();
        startRestart();
      }
    },
    release() {
      if (holders > 0) holders -= 1;
      if (holders === 0) {
        stopRestart();
        killCaffeinate();
      }
    },
    forceStop() {
      holders = 0;
      stopRestart();
      killCaffeinate();
    },
    refCount() {
      return holders;
    },
  };

  if (options.exitCleanup === true) {
    process.once("exit", () => controller.forceStop());
  }
  return controller;
}

const NO_OP_CONTROLLER: PreventSleepController = {
  acquire() {},
  release() {},
  forceStop() {},
  refCount() {
    return 0;
  },
};

let sharedController: PreventSleepController | null = null;

/** The process-wide controller shared by every driver (the refCount is what
 *  composes concurrent busy sessions into ONE caffeinate). Env-gated off for
 *  the whole cli test environment and for users who want default behavior. */
export function defaultPreventSleep(): PreventSleepController {
  if (process.env[PREVENT_SLEEP_DISABLE_ENV] === "1") return NO_OP_CONTROLLER;
  if (sharedController === null) {
    sharedController = createPreventSleepController({ exitCleanup: true });
  }
  return sharedController;
}

export interface SleepGuard {
  /** Idempotent derived-state sync: call at EVERY transition of
   *  `busy && pendingPermission === null` (run start/settle, permission
   *  park/answer). Redundant calls no-op; an imbalance heals at the next
   *  transition. Release is debounced so settle→queue-drain→startRun
   *  doesn't churn the assertion between back-to-back runs. */
  sync(shouldHold: boolean): void;
  /** Drop this guard's hold immediately — driver dispose safety net. */
  release(): void;
}

export interface SleepGuardOptions {
  readonly controller?: PreventSleepController;
  readonly releaseDebounceMs?: number;
}

export function createSleepGuard(options: SleepGuardOptions = {}): SleepGuard {
  const controller = options.controller ?? defaultPreventSleep();
  const debounceMs = options.releaseDebounceMs ?? RELEASE_DEBOUNCE_MS;

  let holding = false;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPendingRelease = (): void => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  return {
    sync(shouldHold) {
      if (shouldHold) {
        // Work resumed inside the window — keep the assertion continuous.
        cancelPendingRelease();
        if (!holding) {
          holding = true;
          controller.acquire();
        }
      } else if (holding && releaseTimer === null) {
        releaseTimer = setTimeout(() => {
          releaseTimer = null;
          if (holding) {
            holding = false;
            controller.release();
          }
        }, debounceMs);
        releaseTimer.unref();
      }
    },
    release() {
      cancelPendingRelease();
      if (holding) {
        holding = false;
        controller.release();
      }
    },
  };
}
