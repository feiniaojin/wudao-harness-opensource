// det-73-night-porting-16 — the deterministic behavior pins for 夜移 028
// (preventSleep, CCB caffeinate ported multi-driver). The harness runs long
// unattended jobs; on macOS an idle sleep mid-run kills them. This suite
// pins the contract through the PUBLIC export (`wudao-harness/prevent-sleep`):
// the exact caffeinate spawn (idle-sleep assertion, 5-min self-healing -t
// window, unref'd), the refCount composition that lets N concurrent drivers
// share ONE assertion, the guard's idempotent debounced derived-state sync
// (CCB's React useEffect pairing, imperative and self-healing), and the two
// no-op gates (non-darwin platforms, the test kill-switch env). All spawns
// are injected fakes — zero real caffeinate, zero network, zero filesystem.
import type { EvalDefinition } from "../runner.js";
import {
  createPreventSleepController,
  createSleepGuard,
  defaultPreventSleep,
  CAFFEINATE_TIMEOUT_SECONDS,
  CAFFEINATE_RESTART_INTERVAL_MS,
  RELEASE_DEBOUNCE_MS,
  PREVENT_SLEEP_DISABLE_ENV,
  type PreventSleepChild,
} from "wudao-harness/prevent-sleep";

/** Minimal structural fake for the injected spawn seam. */
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
  emitExit(): void {
    for (const l of this.exitListeners) l();
  }
}

interface Rec {
  readonly spawns: Array<{ command: string; args: string[] }>;
  readonly children: FakeChild[];
}

function makeController(overrides: { platform?: string } = {}): { controller: ReturnType<typeof createPreventSleepController>; rec: Rec } {
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
  });
  return { controller, rec: { spawns, children } };
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface NightPorting16Evidence {
  // ① first acquire spawns `caffeinate -i -t 300`, unref'd, CCB constants
  readonly spawnContract: boolean;
  // ② N holders share one process; SIGKILL only on the LAST release
  readonly refCountComposition: boolean;
  // ③ guard: sync acquires idempotently, releases after the debounce,
  //    re-acquires; release() is immediate
  readonly guardMatrix: boolean;
  // ④ false→true inside the debounce window never churns the assertion
  readonly continuity: boolean;
  // ⑤ non-darwin spawns nothing
  readonly nonDarwinNoOp: boolean;
  // ⑥ the disable env makes the production singleton a no-op (stable identity)
  readonly disableEnvGate: boolean;
}

export const det73Eval: EvalDefinition<Record<string, never>, NightPorting16Evidence> = {
  name: "det-73-night-porting-16",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① spawn contract + constants.
    const a = makeController();
    a.controller.acquire();
    const first = a.rec.spawns[0];
    const spawnContract = first !== undefined
      && first.command === "caffeinate"
      && first.args.length === 3
      && first.args[0] === "-i"
      && first.args[1] === "-t"
      && first.args[2] === String(CAFFEINATE_TIMEOUT_SECONDS)
      && CAFFEINATE_TIMEOUT_SECONDS === 300
      && CAFFEINATE_RESTART_INTERVAL_MS === 4 * 60 * 1000
      && RELEASE_DEBOUNCE_MS === 1000
      && a.rec.children[0]!.unrefCount === 1
      && a.controller.refCount() === 1;
    a.controller.forceStop();

    // ② refCount composition across holders.
    const b = makeController();
    b.controller.acquire();
    b.controller.acquire();
    const oneForTwo = b.rec.spawns.length === 1;
    b.controller.release();
    const partialKeeps = b.controller.refCount() === 1 && b.rec.children[0]!.killed.length === 0;
    b.controller.release();
    const refCountComposition = oneForTwo && partialKeeps
      && b.controller.refCount() === 0
      && b.rec.children[0]!.killed.length === 1
      && b.rec.children[0]!.killed[0] === "SIGKILL";

    // ③ guard transition matrix (fast debounce; real timers).
    const c = makeController();
    const guard = createSleepGuard({ controller: c.controller, releaseDebounceMs: 5 });
    guard.sync(true);
    const acquired = c.controller.refCount() === 1 && c.rec.spawns.length === 1;
    guard.sync(true);
    guard.sync(true);
    const idempotent = c.rec.spawns.length === 1;
    guard.sync(false);
    const heldInWindow = c.controller.refCount() === 1;
    await wait(16);
    const releasedAfterDebounce = c.controller.refCount() === 0
      && c.rec.children[0]!.killed.includes("SIGKILL");
    guard.sync(true);
    const reAcquired = c.controller.refCount() === 1 && c.rec.spawns.length === 2;
    guard.release();
    const releaseImmediate = c.controller.refCount() === 0;
    const guardMatrix = acquired && idempotent && heldInWindow && releasedAfterDebounce && reAcquired && releaseImmediate;

    // ④ continuity: settle→drain re-acquire inside the window never kills.
    const d = makeController();
    const g2 = createSleepGuard({ controller: d.controller, releaseDebounceMs: 8 });
    g2.sync(true);
    g2.sync(false);
    g2.sync(true);
    await wait(24);
    const continuity = d.rec.spawns.length === 1
      && d.rec.children[0]!.killed.length === 0
      && d.controller.refCount() === 1;
    g2.release();

    // ⑤ non-darwin: no spawn side at all.
    const e = makeController({ platform: "linux" });
    e.controller.acquire();
    e.controller.release();
    const nonDarwinNoOp = e.rec.spawns.length === 0 && e.controller.refCount() === 0;

    // ⑥ the disable env switches the production singleton to a no-op.
    const prev = process.env[PREVENT_SLEEP_DISABLE_ENV];
    process.env[PREVENT_SLEEP_DISABLE_ENV] = "1";
    let disableEnvGate = false;
    try {
      const s1 = defaultPreventSleep();
      const s2 = defaultPreventSleep();
      s1.acquire();
      s1.acquire();
      disableEnvGate = s1 === s2 && s1.refCount() === 0;
      s1.release();
      s1.forceStop();
    } finally {
      if (prev === undefined) delete process.env[PREVENT_SLEEP_DISABLE_ENV];
      else process.env[PREVENT_SLEEP_DISABLE_ENV] = prev;
    }

    return { spawnContract, refCountComposition, guardMatrix, continuity, nonDarwinNoOp, disableEnvGate };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => {
      if (!ok) errs.push(msg);
    };

    need(e.spawnContract, "① first acquire must spawn `caffeinate -i -t 300` unref'd with the CCB constants (300s / 4min restart / 1s debounce)");
    need(e.refCountComposition, "② N holders must share one caffeinate; SIGKILL only on the LAST release");
    need(e.guardMatrix, "③ the guard must acquire idempotently, release after the debounce, re-acquire, and release() immediately");
    need(e.continuity, "④ false→true inside the debounce window must never churn the assertion (settle→queue-drain seam)");
    need(e.nonDarwinNoOp, "⑤ non-darwin platforms must spawn nothing");
    need(e.disableEnvGate, "⑥ the disable env must make the production singleton a stable no-op");

    return errs;
  },
};
