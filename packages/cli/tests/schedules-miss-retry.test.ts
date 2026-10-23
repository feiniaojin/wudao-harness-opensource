// 借鉴弧 α3（hermes ec58e08a35 思想）— 漏火有界重跑：fire 已被消耗（表已
// 前进）但子进程从未到达模型（WUDAO_MODEL_UNREACHED 章）→ 武装一次
// missRetryAt，到点以 triggeredBy "miss-retry" 补跑（不推进表、不再武装——
// 有界性靠车道身份，不靠计数器）。对垒：fire-once/no-catch-up 与 boot 缺火
// 补跑（ω99-313 applyMissedFire——「没 fire 过」的补）都不覆盖「fire 已消耗
// 但从未到达模型」的持续宕机窗口；turn-retry 阶梯只管瞬态错。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  armMissRetry,
  SCHEDULE_MODEL_UNREACHED_MARKER,
  SCHEDULE_MISS_RETRY_DELAY_MS,
} from "../src/schedules.js";
import type { DurableTask } from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc-a3-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-09-15T03:00:00").getTime();
const MIN = 60_000;
const RETRY_MS = SCHEDULE_MISS_RETRY_DELAY_MS; // 5min — the single-ladder bound

const poll = async (pred: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

const storedTasks = async (): Promise<Record<string, unknown>[]> => {
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: Record<string, unknown>[] };
  return stored.tasks;
};

const oneTask = async (): Promise<Record<string, unknown>> => (await storedTasks())[0]!;

/** A daily 03:00 cron row (the 挂机 cron the arc protects — a missed fire
 *  costs a whole day). Post-advance shape: fired at T0, next fire tomorrow. */
const dailyFired = (over: Partial<DurableTask> = {}): DurableTask => ({
  id: "aaaaaaaa",
  schedule: { type: "cron", expr: "0 3 * * *" },
  prompt: "nightly report",
  workspace: ws,
  createdFrom: "test",
  createdAt: T0 - 24 * 60 * MIN,
  lastFiredAt: T0,
  ...over,
});

describe("α3 纯逻辑 — armMissRetry 四门", () => {
  it("arms at fireAt+delay when every gate passes (recurring, un-armed, alive, before natural)", () => {
    expect(armMissRetry(dailyFired(), T0, T0 + MIN)).toBe(T0 + RETRY_MS);
  });

  it("refuses one-shot `at` rows (no next natural cycle to look forward to)", () => {
    const at = dailyFired({ schedule: { type: "at", at: T0 - MIN } });
    expect(armMissRetry(at, T0, T0 + MIN)).toBeUndefined();
  });

  it("refuses when an arm is already pending (no stacking) / paused / breaker-disabled", () => {
    expect(armMissRetry(dailyFired({ missRetryAt: T0 + RETRY_MS }), T0, T0 + MIN)).toBeUndefined();
    expect(armMissRetry(dailyFired({ paused: true }), T0, T0 + MIN)).toBeUndefined();
    expect(armMissRetry(dailyFired({ enabled: false }), T0, T0 + MIN)).toBeUndefined();
  });

  it("refuses when the retry would land at/after the next natural fire (hermes: 不晚于 next_run_at)", () => {
    // every 5min: the next natural fire is T0+5min == the retry instant → superseded.
    const tight = dailyFired({ schedule: { type: "every", intervalMs: 5 * MIN }, nextRunAt: T0 + 5 * MIN });
    expect(armMissRetry(tight, T0, T0 + MIN)).toBeUndefined();
    // every 30min: the retry at +5min lands strictly inside the gap → armed.
    const wide = dailyFired({ schedule: { type: "every", intervalMs: 30 * MIN }, nextRunAt: T0 + 30 * MIN });
    expect(armMissRetry(wide, T0, T0 + MIN)).toBe(T0 + RETRY_MS);
  });

  it("refuses an already-expired retry instant (clock skew / malformed delay)", () => {
    expect(armMissRetry(dailyFired(), T0 - 2 * RETRY_MS, T0)).toBeUndefined();
  });
});

describe("α3 守护 — 漏火补跑车道", () => {
  it("a marker failure arms ONE durable retry; the tick fires it as miss-retry without advancing the table; its own failure never re-arms", async () => {
    let clock = T0 - 25 * 60 * MIN; // created "yesterday 02:00" so the daily 03:00 occurrence is the next one
    const lines: string[] = [];
    const runs: { at: number; output: string }[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (task) => {
        const unreachable = runs.length < 2; // first fire + the retry both die in the outage
        const output = unreachable ? `wudao: provider request failed: 503\n${SCHEDULE_MODEL_UNREACHED_MARKER}\n` : "ok";
        runs.push({ at: clock, output });
        return { ok: !unreachable, exitCode: unreachable ? 1 : 0, output };
      },
      notify: (line) => lines.push(line),
    });
    await daemon.add({ schedule: { type: "cron", expr: "0 3 * * *" }, prompt: "nightly report", createdFrom: "test" });
    clock = T0 + MIN; // the daily fire came due
    await daemon.tick();
    await poll(async () => runs.length === 1 && (await oneTask()).missRetryAt !== undefined);
    // The marker failure suppressed the plain-failure line and said the retry is armed.
    expect(lines.some((l) => l.includes("模型不可达") && l.includes("自动补跑"))).toBe(true);
    expect(lines.some((l) => l.includes("nightly report") && l.startsWith("⚠️") && !l.includes("补跑"))).toBe(false);
    // The table advanced (fire consumed) AND the arm is durable in the store.
    const armed = await oneTask();
    expect(armed.lastFiredAt).toBe(T0 + MIN);
    expect(armed.missRetryAt).toBe(T0 + MIN + RETRY_MS);
    // The retry fires at the armed instant…
    clock = T0 + MIN + RETRY_MS;
    await daemon.tick();
    await poll(async () => runs.length === 2 && (await oneTask()).missRetryAt === undefined);
    // …without consuming/advancing anything: a daily row's lastFiredAt is STILL the original fire.
    expect((await oneTask()).lastFiredAt).toBe(T0 + MIN);
    // The retry also died in the outage with the marker — but it is a miss-retry
    // lane death: NO second arm (the bound is the lane identity, not a counter).
    await poll(async () => runs.length === 2);
    clock = T0 + 3 * 60 * MIN;
    await daemon.tick();
    await daemon.tick();
    await poll(async () => runs.length === 2);
    expect((await oneTask()).missRetryAt).toBeUndefined();
    daemon.stop();
  });

  it("a NON-marker failure (the model ran, the task itself failed) never arms a retry", async () => {
    let clock = T0 - 25 * 60 * MIN;
    const runs: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => {
        runs.push("run");
        return { ok: false, exitCode: 1, output: "the model answered but the script failed" };
      },
      notify: () => {},
    });
    await daemon.add({ schedule: { type: "cron", expr: "0 3 * * *" }, prompt: "nightly", createdFrom: "test" });
    clock = T0 + MIN;
    await daemon.tick();
    await poll(async () => runs.length === 1);
    expect((await oneTask()).missRetryAt).toBeUndefined(); // plain failure — the breaker's territory
    daemon.stop();
  });

  it("a paused task waives its armed retry at the tick (停用期间不欠新账)", async () => {
    let clock = T0 - 25 * 60 * MIN;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: false, exitCode: 1, output: `x\n${SCHEDULE_MODEL_UNREACHED_MARKER}\n` }),
      notify: () => {},
    });
    await daemon.add({ schedule: { type: "cron", expr: "0 3 * * *" }, prompt: "nightly", createdFrom: "test" });
    clock = T0 + MIN;
    await daemon.tick();
    await poll(async () => (await oneTask()).missRetryAt !== undefined);
    await daemon.pause(((await oneTask()).id as string));
    clock = T0 + MIN + RETRY_MS + MIN;
    await daemon.tick();
    await poll(async () => (await oneTask()).missRetryAt === undefined);
    daemon.stop();
  });

  it("the run ledger carries missRetryArmed on the armed failure (morning evidence)", async () => {
    let clock = T0 - 25 * 60 * MIN;
    const ledger: Record<string, unknown>[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: false, exitCode: 1, output: `wudao: provider request failed: 503\n${SCHEDULE_MODEL_UNREACHED_MARKER}\n` }),
      notify: () => {},
      appendRun: async (entry) => { ledger.push(entry.data); },
    });
    await daemon.add({ schedule: { type: "cron", expr: "0 3 * * *" }, prompt: "nightly", createdFrom: "test" });
    clock = T0 + MIN;
    await daemon.tick();
    await poll(async () => ledger.length === 1 && (await oneTask()).missRetryAt !== undefined);
    expect(ledger[0]!.missRetryArmed).toBe(true);
    expect(ledger[0]!.triggeredBy).toBe("cron");
    daemon.stop();
  });
});

describe("α3 子进程章 — modelUnreachedStampDue", () => {
  it("stamps only transient-class deaths with zero model bytes", async () => {
    const { oneShotRunFacts, modelUnreachedStampDue } = await import("../src/cli-main-helpers.js");
    oneShotRunFacts.reachedModel = false;
    expect(modelUnreachedStampDue(new Error("provider request failed: 503"))).toBe(true);
    expect(modelUnreachedStampDue(new Error("fetch failed"))).toBe(true); // network class
    expect(modelUnreachedStampDue(new Error("provider request failed: 401"))).toBe(false); // not transient — a config problem
    oneShotRunFacts.reachedModel = true; // reasoning/assistant bytes arrived
    expect(modelUnreachedStampDue(new Error("fetch failed"))).toBe(false); // the model WAS reached
    oneShotRunFacts.reachedModel = false;
  });
});
