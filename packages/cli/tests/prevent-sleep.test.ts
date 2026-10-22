// 夜移 028 — preventSleep (CCB caffeinate port) contract tests.
// The manager is a refCounted caffeinate holder (spawn `caffeinate -i -t 300`,
// 4-min restart self-healing, SIGKILL to stop, darwin-only, silent failure);
// the guard is the driver-side derived-state sync (idempotent, debounced
// release) that replaces CCB's React useEffect pairing. All spawns are
// injected fakes — the real singleton is additionally env-gated so driver
// tests never spawn the developer's real caffeinate.
import { describe, expect, test } from "vitest";
import {
  createPreventSleepController,
  createSleepGuard,
  defaultPreventSleep,
  CAFFEINATE_TIMEOUT_SECONDS,
  CAFFEINATE_RESTART_INTERVAL_MS,
  RELEASE_DEBOUNCE_MS,
  PREVENT_SLEEP_DISABLE_ENV,
  type PreventSleepChild,
} from "../src/prevent-sleep.js";

// Platform contract: this suite exercises the macOS execution plane
// (osascript / caffeinate seams) — skip off-darwin CI runners instead of
// failing against the tool's platform guard.
const d: typeof describe = process.platform === "darwin" ? describe : describe.skip;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Structural fake for the injected spawn seam: records spawns, kills,
 *  unrefs, and lets tests drive the async error/exit events. */
class FakeChild implements PreventSleepChild {
  unrefCount = 0;
  readonly killed: string[] = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitListeners: Array<() => void> = [];

  unref(): void {
    this.unrefCount++;
  }
  onError(listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }
  onExit(listener: () => void): void {
    this.exitListeners.push(listener);
  }
  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
  emitError(error: Error): void {
    for (const l of this.errorListeners) l(error);
  }
  emitExit(): void {
    for (const l of this.exitListeners) l();
  }
}

interface Harness {
  readonly controller: ReturnType<typeof createPreventSleepController>;
  readonly spawns: Array<{ command: string; args: string[] }>;
  readonly children: FakeChild[];
}

function makeController(overrides: { platform?: string; restartIntervalMs?: number } = {}): Harness {
  const spawns: Array<{ command: string; args: string[] }> = [];
  const children: FakeChild[] = [];
  const spawnFn = (command: string, args: readonly string[]): PreventSleepChild => {
    spawns.push({ command, args: [...args] });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const controller = createPreventSleepController({
    spawnFn,
    ...(overrides.platform !== undefined ? { platform: overrides.platform } : {}),
    ...(overrides.restartIntervalMs !== undefined ? { restartIntervalMs: overrides.restartIntervalMs } : {}),
  });
  return { controller, spawns, children };
}

d("createPreventSleepController", () => {
  test("A first acquire spawns caffeinate -i -t 300, unref'd, not killed", () => {
    const h = makeController();
    h.controller.acquire();
    expect(h.spawns.length).toBe(1);
    expect(h.spawns[0]!.command).toBe("caffeinate");
    expect(h.spawns[0]!.args).toEqual(["-i", "-t", "300"]);
    expect(h.children[0]!.unrefCount).toBe(1);
    expect(h.children[0]!.killed.length).toBe(0);
    expect(h.controller.refCount()).toBe(1);
    h.controller.forceStop();
  });

  test("B refCount composition: one spawn for two holders, SIGKILL only on the last release", () => {
    const h = makeController();
    h.controller.acquire();
    h.controller.acquire();
    expect(h.spawns.length).toBe(1);
    h.controller.release();
    expect(h.controller.refCount()).toBe(1);
    expect(h.children[0]!.killed.length).toBe(0);
    h.controller.release();
    expect(h.controller.refCount()).toBe(0);
    expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  });

  test("C release below zero is a defensive no-op", () => {
    const h = makeController();
    expect(() => h.controller.release()).not.toThrow();
    expect(h.spawns.length).toBe(0);
  });

  test("D restart interval self-heals: kill + respawn while held", async () => {
    const h = makeController({ restartIntervalMs: 5 });
    h.controller.acquire();
    await wait(18);
    expect(h.spawns.length).toBeGreaterThanOrEqual(2);
    // every retired child was SIGKILLed; at most the newest one lives
    const retired = h.children.slice(0, -1);
    for (const c of retired) expect(c.killed).toContain("SIGKILL");
    expect(h.controller.refCount()).toBe(1);
    h.controller.forceStop();
  });

  test("E non-darwin is a complete no-op on the spawn side", () => {
    const h = makeController({ platform: "linux" });
    h.controller.acquire();
    h.controller.acquire();
    h.controller.release();
    h.controller.release();
    expect(h.spawns.length).toBe(0);
    expect(h.controller.refCount()).toBe(0);
  });

  test("F spawn error clears the child ref; the restart re-arms", async () => {
    const h = makeController({ restartIntervalMs: 5 });
    h.controller.acquire();
    h.children[0]!.emitError(new Error("spawn caffeinate ENOENT"));
    await wait(18);
    expect(h.spawns.length).toBeGreaterThanOrEqual(2);
    // the dead child was never SIGKILLed (it was never alive)
    expect(h.children[0]!.killed.length).toBe(0);
    h.controller.forceStop();
  });

  test("G natural child exit clears the ref; the restart respawns", async () => {
    const h = makeController({ restartIntervalMs: 5 });
    h.controller.acquire();
    h.children[0]!.emitExit();
    await wait(18);
    expect(h.spawns.length).toBeGreaterThanOrEqual(2);
    h.controller.forceStop();
  });

  test("H forceStop kills regardless of remaining holders", () => {
    const h = makeController();
    h.controller.acquire();
    h.controller.acquire();
    h.controller.forceStop();
    expect(h.controller.refCount()).toBe(0);
    expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  });
});

d("createSleepGuard", () => {
  test("I sync state machine: true acquires, idempotent, false releases after the debounce", async () => {
    const h = makeController();
    const guard = createSleepGuard({ controller: h.controller, releaseDebounceMs: 5 });
    guard.sync(true);
    expect(h.spawns.length).toBe(1);
    guard.sync(true);
    guard.sync(true);
    expect(h.spawns.length).toBe(1); // idempotent — one acquire per hold
    guard.sync(false);
    expect(h.controller.refCount()).toBe(1); // still held inside the window
    await wait(16);
    expect(h.controller.refCount()).toBe(0);
    expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  });

  test("J continuity: false→true inside the debounce window never kills", async () => {
    const h = makeController();
    const guard = createSleepGuard({ controller: h.controller, releaseDebounceMs: 8 });
    guard.sync(true);
    guard.sync(false); // settle — queue drain is about to re-start a run
    guard.sync(true); // …and it does, inside the window
    await wait(24);
    expect(h.spawns.length).toBe(1); // never churned
    expect(h.children[0]!.killed.length).toBe(0);
    expect(h.controller.refCount()).toBe(1);
    guard.release();
  });

  test("K release() drops immediately (no debounce) and is a no-op when idle", async () => {
    const h = makeController();
    const guard = createSleepGuard({ controller: h.controller, releaseDebounceMs: 50 });
    guard.sync(true);
    guard.release();
    expect(h.controller.refCount()).toBe(0);
    expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
    expect(() => guard.release()).not.toThrow(); // idle no-op
    await wait(60);
    expect(h.spawns.length).toBe(1); // no deferred second release either
  });

  test("L two guards over one controller compose (multi-driver pin)", async () => {
    const h = makeController();
    const g1 = createSleepGuard({ controller: h.controller, releaseDebounceMs: 5 });
    const g2 = createSleepGuard({ controller: h.controller, releaseDebounceMs: 5 });
    g1.sync(true);
    g2.sync(true);
    expect(h.spawns.length).toBe(1); // one caffeinate for two busy drivers
    g1.sync(false);
    await wait(16);
    expect(h.controller.refCount()).toBe(1); // g2 still working
    expect(h.children[0]!.killed.length).toBe(0);
    g2.sync(false);
    await wait(16);
    expect(h.controller.refCount()).toBe(0);
    expect(h.children[0]!.killed).toEqual(["SIGKILL"]);
  });
});

d("constants and the production singleton", () => {
  test("M CCB values pinned: -t 300s, 4-min restart, 1s release debounce", () => {
    expect(CAFFEINATE_TIMEOUT_SECONDS).toBe(300);
    expect(CAFFEINATE_RESTART_INTERVAL_MS).toBe(4 * 60 * 1000);
    expect(RELEASE_DEBOUNCE_MS).toBe(1000);
  });

  test("N the disable env switches the singleton to a no-op (driver tests rely on this)", () => {
    const prev = process.env[PREVENT_SLEEP_DISABLE_ENV];
    process.env[PREVENT_SLEEP_DISABLE_ENV] = "1";
    try {
      const a = defaultPreventSleep();
      const b = defaultPreventSleep();
      expect(a).toBe(b); // stable singleton identity
      a.acquire();
      a.acquire();
      expect(a.refCount()).toBe(0); // no-op: nothing held, nothing spawned
      a.release();
      a.forceStop();
      expect(a.refCount()).toBe(0);
    } finally {
      if (prev === undefined) delete process.env[PREVENT_SLEEP_DISABLE_ENV];
      else process.env[PREVENT_SLEEP_DISABLE_ENV] = prev;
    }
  });
});
