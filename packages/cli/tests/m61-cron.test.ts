// M61 §1 — the in-session scheduler: cron parsing (vixie subset + DOM/DOW
// OR), deterministic jitter bounds, the cron.json store (symlink refusal,
// kill switch, cap), the fire/no-catch-up semantics, 7-day expiry, resume
// restore matrix, the model tools' round-trip, and the driver's
// steering-channel integration (prefix byte-stability included).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, symlink, writeFile, readFile, chmod, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCronExpr,
  cronMatches,
  nextCronTime,
  nextFire,
  nextScheduledTime,
  isOneShotTask,
  hashFraction,
  recurringLateJitterMs,
  oneshotEarlyJitterMs,
  cronDisabled,
  loadCronStore,
  createCronTools,
  formatScheduledInjection,
  CRON_TASK_CAP_PER_SESSION,
  CRON_EXPIRY_MS,
  type CronTask,
  type ModelClient,
  type ModelInput,
  type AssistantMessage,
} from "@wudao/core";
import { createCronRuntime } from "../src/cron.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { stripProjectedNotes } from "./projected-notes.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m61-cron-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

// A recording scripted model — captures every ModelInput for prefix asserts.
// `holdAt` parks generate call #n on an external promise so a test can arm a
// scheduled fire mid-flight deterministically.
function recordingModel(responses: readonly AssistantMessage[], holdAt?: { index: number; until: Promise<void> }): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (holdAt !== undefined && i === holdAt.index) await holdAt.until;
      // SNAPSHOT: the loop passes live arrays; without the copy every captured
      // input would alias the final conversation and prefix asserts would lie.
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })) });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const at = (iso: string): number => new Date(iso).getTime();
const MIN = 60_000;
const allowAsk = async () => ({ kind: "allow" as const });

describe("M61 §1 — vixie-cron parsing", () => {
  it("accepts the supported subset and rejects L/W/?/aliases/6 fields", () => {
    expect(parseCronExpr("*/30 * * * *").ok).toBe(true);
    expect(parseCronExpr("0 9 * * 1-5").ok).toBe(true);
    expect(parseCronExpr("5,35 8-18 * * *").ok).toBe(true);
    expect(parseCronExpr("0 0 1 1 *").ok).toBe(true);
    for (const bad of ["*/5 * * * * *", "0 9 * * mon", "@daily", "0 9 * * 1L", "0 9 15 W *", "0 9 ? * *", "61 * * * *", "* 9-5 * * *"]) {
      const r = parseCronExpr(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it("DOM and DOW both restricted fire on EITHER (vixie OR semantics)", () => {
    // Fires on the 1st of any month (any weekday) OR any Sunday.
    const spec = parseCronExpr("0 12 1 * 0");
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    // 2026-08-02 is a Sunday, not the 1st → must fire (dow matches).
    expect(cronMatches(spec.spec, new Date(2026, 7, 2, 12, 0))).toBe(true);
    // 2026-08-01 is a Saturday AND the 1st → fires (dom matches).
    expect(cronMatches(spec.spec, new Date(2026, 7, 1, 12, 0))).toBe(true);
    // 2026-08-03 is a Monday, not the 1st → no.
    expect(cronMatches(spec.spec, new Date(2026, 7, 3, 12, 0))).toBe(false);
    // DOW 7 folds to Sunday.
    const spec7 = parseCronExpr("0 12 * * 7");
    expect(spec7.ok && cronMatches(spec7.spec, new Date(2026, 7, 2, 12, 0))).toBe(true);
  });

  it("nextCronTime scans forward from (exclusive of) the given time", () => {
    const spec = parseCronExpr("*/30 * * * *");
    expect(spec.ok).toBe(true);
    if (!spec.ok) return;
    const next = nextCronTime(spec.spec, new Date(2026, 7, 17, 10, 10));
    expect(next?.getHours()).toBe(10);
    expect(next?.getMinutes()).toBe(30);
  });
});

describe("M61 §1 — deterministic jitter", () => {
  it("hashFraction is stable per key and spread over [0,1)", () => {
    expect(hashFraction("abcdefgh")).toBe(hashFraction("abcdefgh"));
    expect(hashFraction("abcdefgh")).toBeGreaterThanOrEqual(0);
    expect(hashFraction("abcdefgh")).toBeLessThan(1);
    expect(hashFraction("abcdefgh")).not.toBe(hashFraction("abcdefgi"));
  });

  it("recurring late jitter ≤ min(30min, interval/2), same id ⇒ same offset", () => {
    // 30-minute interval → cap 15 minutes.
    const j30 = recurringLateJitterMs("task1234", 30 * MIN);
    expect(j30).toBe(recurringLateJitterMs("task1234", 30 * MIN));
    expect(j30).toBeLessThanOrEqual(15 * MIN);
    expect(j30).toBeGreaterThanOrEqual(0);
    // A 2-hour interval → cap 30 minutes.
    expect(recurringLateJitterMs("task1234", 120 * MIN)).toBeLessThanOrEqual(30 * MIN);
    // A 10-minute interval → cap 5 minutes.
    expect(recurringLateJitterMs("task1234", 10 * MIN)).toBeLessThanOrEqual(5 * MIN);
  });

  it(":00/:30 one-shots may fire ≤90s EARLY; other minutes fire exactly", () => {
    const halfPast = at("2026-08-20T10:30:00");
    const e = oneshotEarlyJitterMs("task1234", halfPast);
    expect(e).toBe(oneshotEarlyJitterMs("task1234", halfPast)); // deterministic
    expect(e).toBeLessThanOrEqual(90_000);
    expect(oneshotEarlyJitterMs("task1234", at("2026-08-20T10:00:00"))).toBeLessThanOrEqual(90_000);
    expect(oneshotEarlyJitterMs("task1234", at("2026-08-20T10:15:00"))).toBe(0);
    expect(oneshotEarlyJitterMs("task1234", at("2026-08-20T10:45:00"))).toBe(0);
  });
});

describe("M61 §1 — store", () => {
  it("WUDAO_DISABLE_CRON=1 refuses every operation", async () => {
    expect(cronDisabled({ WUDAO_DISABLE_CRON: "1" })).toBe(true);
    await expect(loadCronStore({ workspaceRoot: ws, env: { WUDAO_DISABLE_CRON: "1" } })).rejects.toThrow(/disabled/);
    const runtime = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", env: { WUDAO_DISABLE_CRON: "1" }, tickMs: 0 });
    expect(runtime.refusal).toBe("disabled");
    await expect(runtime.createTask({ prompt: "p", schedule: { type: "interval", everyMs: MIN } })).rejects.toThrow(/disabled/);
  });

  it("refuses a symlinked cron.json (fail-closed, with the reason)", async () => {
    const real = join(ws, "real-cron.json");
    await writeFile(real, "{}", "utf8");
    await symlink(real, join(ws, ".wudao-cron-link"));
    // The store looks at <root>/.wudao/cron.json — point .wudao at a dir whose
    // cron.json is a symlink.
    await mkdtemp(join(ws, "wudao-")).then(async (d) => {
      await symlink(real, join(d, "cron.json")).catch(() => {});
      await symlink(d, join(ws, ".wudao")).catch(() => {});
    });
    const runtime = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0 });
    expect(runtime.refusal).toBe("symlink");
  });

  it("enforces the 50-per-session cap", async () => {
    const runtime = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0 });
    for (let i = 0; i < CRON_TASK_CAP_PER_SESSION; i += 1) {
      await runtime.createTask({ prompt: `p${i}`, schedule: { type: "interval", everyMs: 60 * MIN } });
    }
    await expect(runtime.createTask({ prompt: "over", schedule: { type: "interval", everyMs: 60 * MIN } })).rejects.toThrow(/cap/);
    // A different session's tasks do not count against this session.
    const other = await createCronRuntime({ workspaceRoot: ws, sessionId: "s2", tickMs: 0 });
    await expect(other.createTask({ prompt: "other", schedule: { type: "interval", everyMs: 60 * MIN } })).resolves.toBeTruthy();
    runtime.stop();
    other.stop();
  });
});

describe("M61 §1 — fire semantics (idle-only, no catch-up, expiry)", () => {
  const T0 = at("2026-08-17T10:00:00");

  async function runtimeWith(tasks: readonly CronTask[], sessionId = "s1", clock: () => number = () => T0) {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", "cron.json"), JSON.stringify({ version: 1, tasks }), "utf8");
    return createCronRuntime({ workspaceRoot: ws, sessionId, tickMs: 0, now: clock });
  }

  it("a due interval task fires ONCE regardless of how many occurrences were missed", async () => {
    // Every minute since T0; the session re-opens 10 minutes late.
    let clock = T0;
    const rt = await runtimeWith(
      [{ id: "aaaaaaaa", sessionId: "s1", prompt: "check", schedule: { type: "interval", everyMs: MIN }, createdAt: T0 }],
      "s1",
      () => clock,
    );
    clock = T0 + 10 * MIN;
    const fires = await rt.tick();
    expect(fires.length).toBe(1);
    expect(fires[0]!.injection).toContain("[scheduled task aaaaaaaa]");
    expect(rt.pending().length).toBe(1);
    // Further ticks do NOT stack another fire for the same due task.
    clock = T0 + 12 * MIN;
    const again = await rt.tick();
    expect(again.length).toBe(0);
    expect(rt.pending().length).toBe(1);
    // Draining records the fire and advances the anchor (no catch-up).
    const injection = rt.takeInjection();
    expect(injection).toContain("check");
    const after = rt.list().find((t) => t.id === "aaaaaaaa");
    expect(after?.lastFiredAt).toBe(T0 + 12 * MIN);
    const next = nextScheduledTime(after!, T0 + 12 * MIN);
    expect(next! - (T0 + 12 * MIN)).toBe(MIN);
    rt.stop();
  });

  it("one-shots self-delete on fire", async () => {
    let clock = T0 - MIN;
    const rt = await runtimeWith(
      [{ id: "bbbbbbbb", sessionId: "s1", prompt: "once", schedule: { type: "cron", expr: "30 10 * * *" }, createdAt: T0 - MIN }],
      "s1",
      () => clock,
    );
    expect(isOneShotTask(rt.list()[0]!)).toBe(true);
    // The deterministic early jitter: fireAt = 10:30 − offset(id) ∈ [10:28:30, 10:30].
    const fire = nextFire(rt.list()[0]!, clock)!;
    expect(fire.kind).toBe("scheduled");
    expect(fire.fireAt).toBeLessThanOrEqual(at("2026-08-17T10:30:00"));
    expect(fire.fireAt).toBeGreaterThanOrEqual(at("2026-08-17T10:28:30"));
    clock = fire.fireAt; // exactly due
    await rt.tick();
    expect(rt.pending().length).toBe(1);
    rt.takeInjection();
    expect(rt.list().length).toBe(0);
    rt.stop();
  });

  it("7-day expiry: the expired recurring task fires one FINAL time, then self-deletes", async () => {
    const expired = T0 - CRON_EXPIRY_MS - MIN; // created 7d+1m ago
    let clock = expired;
    const rt = await runtimeWith(
      [{ id: "cccccccc", sessionId: "s1", prompt: "daily", schedule: { type: "interval", everyMs: 24 * 60 * MIN }, createdAt: expired, expiresAt: expired + CRON_EXPIRY_MS, lastFiredAt: expired }],
      "s1",
      () => clock,
    );
    clock = T0;
    const fires = await rt.tick();
    expect(fires.length).toBe(1);
    expect(fires[0]!.kind).toBe("expiry-final");
    rt.takeInjection();
    expect(rt.list().length).toBe(0);
    rt.stop();
  });

  it("resume restore matrix: keeps unexpired recurring + un-fired one-shots, prunes the rest", async () => {
    const now = at("2026-08-17T10:00:00");
    const stale = { id: "dddddddd", sessionId: "s1", prompt: "stale", schedule: { type: "interval", everyMs: 60 * MIN } as const, createdAt: now - CRON_EXPIRY_MS - MIN, expiresAt: now - MIN, lastFiredAt: now - 30_000 };
    const firedOnce = { id: "eeeeeeee", sessionId: "s1", prompt: "fired", schedule: { type: "cron", expr: "0 9 * * *" } as const, createdAt: now - 2 * 24 * 60 * MIN, lastFiredAt: now - 24 * 60 * MIN };
    const live = { id: "ffffffff", sessionId: "s1", prompt: "live", schedule: { type: "interval", everyMs: 60 * MIN } as const, createdAt: now - MIN };
    const unfired = { id: "gggggggg", sessionId: "s1", prompt: "later", schedule: { type: "cron", expr: "0 11 * * *" } as const, createdAt: now - MIN };
    const pastDue = { id: "hhhhhhhh", sessionId: "s1", prompt: "pastdue", schedule: { type: "at", at: now - 10 * MIN } as const, createdAt: now - 20 * MIN };
    let clock = now;
    const rt = await runtimeWith([stale, firedOnce, live, unfired, pastDue], "s1", () => clock);
    const kept = await rt.restoreOnResume();
    const ids = kept.map((t) => t.id).sort();
    // stale (expired + final-fired) and firedOnce (one-shot already fired) are
    // pruned; live recurring, un-fired one-shot, and the past-due un-fired
    // one-shot (fires once next tick) are restored.
    expect(ids).toEqual(["ffffffff", "gggggggg", "hhhhhhhh"]);
    const onDisk = JSON.parse(await readFile(join(ws, ".wudao", "cron.json"), "utf8"));
    expect(onDisk.tasks.length).toBe(3);
    rt.stop();
  });

  it("nextFire applies the recurring late jitter within the cap", async () => {
    const task: CronTask = {
      id: "aaaaaaaa",
      sessionId: "s1",
      prompt: "p",
      schedule: { type: "interval", everyMs: 30 * MIN },
      createdAt: T0,
      expiresAt: T0 + CRON_EXPIRY_MS,
    };
    const fire = nextFire(task, T0);
    expect(fire).toBeDefined();
    const late = fire!.fireAt - (T0 + 30 * MIN);
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThanOrEqual(Math.min(30 * MIN, 15 * MIN));
  });
});

// ω-1 — the nanobot dirty-flag pattern for fire persistence: mark the store
// dirty BEFORE mutating in-memory fire state, clear only on a successful
// save, flush a dirty store at the TOP of the tick (before anything
// executes), and never let an older on-disk snapshot resurrect an
// already-fired due date through a reload. A failing write degrades the
// scheduler (warn + keep running) instead of crashing it.
describe("ω-1 — dirty-flag persist (crash-safe fire recording)", () => {
  const T0 = at("2026-08-17T10:00:00");
  const storePath = () => join(ws, ".wudao", "cron.json");
  // A read-only .wudao makes the store's tmp-write fail (EACCES) while reads
  // keep working — the deterministic "persist fails" injection. win32: chmod
  // never denies the owner — the same denial is shaped by squatting the
  // tmp-write TARGET name with a directory (writeFile into a dir fails).
  const tmpPath = () => join(ws, ".wudao", `cron.json.tmp-${process.pid}`);
  const breakStore = () =>
    process.platform === "win32"
      ? mkdir(tmpPath(), { recursive: true })
      : chmod(join(ws, ".wudao"), 0o500);
  const healStore = () =>
    process.platform === "win32"
      ? rm(tmpPath(), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      : chmod(join(ws, ".wudao"), 0o700);

  async function freshRuntime(clock: () => number, extra: Partial<Parameters<typeof createCronRuntime>[0]> = {}) {
    return createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0, now: clock, ...extra });
  }

  it("(a) a failed save after a drained fire still advances in-memory lastFiredAt and keeps the store dirty", async () => {
    let clock = T0;
    const warns: string[] = [];
    const rt = await freshRuntime(() => clock, { onWarn: (l) => warns.push(l) });
    await rt.createTask({ prompt: "check", schedule: { type: "interval", everyMs: MIN } });
    await breakStore();
    clock = T0 + 2 * MIN;
    await rt.tick();
    expect(rt.takeInjection()).toContain("check");
    // The in-memory fire state advanced even though the persist will fail...
    expect(rt.list()[0]?.lastFiredAt).toBe(T0 + 2 * MIN);
    expect(rt.isDirty()).toBe(true);
    await wait(); // the failed save settles
    // ...and the dirty flag SURVIVES the failure (only a success clears it).
    expect(rt.isDirty()).toBe(true);
    expect(warns.join("\n")).toContain("cron store save failed");
    // The on-disk snapshot is stale — only memory knows the fire happened.
    const disk = JSON.parse(await readFile(storePath(), "utf8")) as { tasks: { lastFiredAt?: number }[] };
    expect(disk.tasks[0]?.lastFiredAt).toBeUndefined();
    await healStore();
    rt.stop();
  });

  it("(b) reload while dirty keeps the in-memory snapshot; a clean reload re-reads disk", async () => {
    let clock = T0;
    const rt = await freshRuntime(() => clock);
    await rt.createTask({ prompt: "check", schedule: { type: "interval", everyMs: MIN } });
    // Clean reload: an external store edit is picked up from disk.
    const external = await loadCronStore({ workspaceRoot: ws });
    await external.save([{ ...rt.list()[0]!, lastFiredAt: T0 - 5 * MIN }]);
    await rt.reload();
    expect(rt.list()[0]?.lastFiredAt).toBe(T0 - 5 * MIN);
    // Dirty reload: the fire is recorded in memory but the save failed — the
    // stale on-disk copy ("never fired") must never resurrect the due date.
    await breakStore();
    clock = T0 + 2 * MIN;
    await rt.tick();
    rt.takeInjection();
    expect(rt.list()[0]?.lastFiredAt).toBe(T0 + 2 * MIN);
    await wait();
    expect(rt.isDirty()).toBe(true);
    await rt.reload();
    expect(rt.list()[0]?.lastFiredAt).toBe(T0 + 2 * MIN);
    expect(rt.isDirty()).toBe(true);
    await healStore();
    rt.stop();
  });

  it("(c) a dirty store is persisted BEFORE the tick executes due work (the flush lands before the onDue poke)", async () => {
    let clock = T0;
    let diskAtDue: { tasks: { lastFiredAt?: number }[] } | undefined;
    const rt = await freshRuntime(() => clock, {
      onDue: () => {
        // SYNC read: when the due poke fires, the tick's flush must already
        // be on disk.
        diskAtDue = JSON.parse(readFileSync(storePath(), "utf8"));
      },
    });
    await rt.createTask({ prompt: "check", schedule: { type: "interval", everyMs: MIN } });
    await breakStore();
    clock = T0 + 2 * MIN;
    await rt.tick(); // arms occurrence 1 (store still clean at tick entry)
    rt.takeInjection(); // records the fire — the persist FAILS, store goes dirty
    await wait();
    expect(rt.isDirty()).toBe(true);
    await healStore();
    clock = T0 + 4 * MIN; // occurrence 2 (anchor = the recorded fire) is due
    const fires = await rt.tick();
    expect(fires.length).toBe(1);
    // The flush completed before the poke: disk already carries lastFiredAt.
    expect(diskAtDue?.tasks[0]?.lastFiredAt).toBe(T0 + 2 * MIN);
    expect(rt.isDirty()).toBe(false);
    rt.stop();
  });

  it("(c') a failing flush degrades: the warn precedes the due poke and the scheduler keeps running", async () => {
    let clock = T0;
    const order: string[] = [];
    const rt = await freshRuntime(() => clock, {
      onWarn: (l) => order.push(l.includes("cron store save failed") ? "warn" : `other:${l}`),
      onDue: () => order.push("due"),
    });
    await rt.createTask({ prompt: "check", schedule: { type: "interval", everyMs: MIN } });
    await breakStore();
    clock = T0 + 2 * MIN;
    await rt.tick(); // occurrence 1 armed; the store was clean — no flush
    rt.takeInjection(); // the fire's persist fails → dirty
    await wait();
    order.length = 0; // isolate the dirty tick's event order
    clock = T0 + 4 * MIN;
    const fires = await rt.tick();
    expect(fires.length).toBe(1); // the scheduler kept scheduling
    expect(order[0]).toBe("warn"); // the flush was attempted FIRST
    expect(order[1]).toBe("due"); // then the due poke
    expect(rt.isDirty()).toBe(true); // still degraded, still alive
    await healStore();
    rt.stop();
  });
});

describe("M61 §1 — model tools round-trip", () => {
  it("cron_create/list/delete against the live runtime table", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0 });
    const [create, list, remove] = createCronTools({ workspaceRoot: ws, sessionId: "s1", table: rt.table() });
    const bad = await create.execute({ cron: "0 9 * * mon-fri", prompt: "x", recurring: true });
    expect(bad.isError).toBe(true);
    const ok = await create.execute({ cron: "*/15 * * * *", prompt: "heartbeat", recurring: true });
    expect(ok.isError).not.toBe(true);
    const listed = await list.execute({});
    expect(listed.content).toContain("heartbeat");
    const id = (rt.list()[0]!).id;
    const gone = await remove.execute({ id });
    expect(gone.isError).not.toBe(true);
    expect(rt.list().length).toBe(0);
    const missing = await remove.execute({ id: "zzzzzzzz" });
    expect(missing.isError).toBe(true);
    rt.stop();
  });

  it("cap error from the tool surface", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s1", tickMs: 0 });
    const [create] = createCronTools({ workspaceRoot: ws, sessionId: "s1", table: rt.table() });
    for (let i = 0; i < CRON_TASK_CAP_PER_SESSION; i += 1) {
      const r = await create.execute({ cron: `${i % 60} 9 * * *`, prompt: `p${i}`, recurring: false });
      expect(r.isError).not.toBe(true);
    }
    const over = await create.execute({ cron: "59 9 * * *", prompt: "over", recurring: false });
    expect(over.isError).toBe(true);
    expect(over.content).toContain("cap");
    rt.stop();
  });
});

describe("M61 §1 — driver integration (steering lane, idle auto-start, prefix stability)", () => {
  it("a mid-run due fire rides the steering drain between turns; the request prefix stays byte-identical", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-driver", tickMs: 0 });
    await rt.createTask({ prompt: "SCHEDULED WORK", schedule: { type: "interval", everyMs: 5 * MIN } });
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    const model = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "noop", arguments: {} }] },
      { role: "assistant", content: "second turn saw the fire" },
      { role: "assistant", content: "done" },
    ], { index: 0, until: gate });
    const driver: AgentDriver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      cron: rt,
    });
    driver.submit("start");
    await until(() => driver.getStatus().busy === true, "run started");
    // The first model call is parked — arm the fire MID-RUN, then let the
    // turn boundary drain it (busy ≠ idle: no auto-start must happen).
    await rt.tick(Date.now() + 10 * MIN);
    expect(rt.pending().length).toBe(1);
    releaseFirst();
    await until(() => driver.getStatus().busy === false, "run finished");
    // The second model input must carry the injection as a trailing user
    // message, and its PREFIX (everything before the new suffix) byte-equal
    // the first request's serialization.
    expect(model.inputs.length).toBeGreaterThanOrEqual(2);
    // Prefix law: the second request = the first request's bytes + the new
    // suffix (injection + reply). Compare per component — system prompt and
    // tools byte-equal, the message list strictly APPENDED.
    expect(model.inputs[1]!.systemPrompt).toBe(model.inputs[0]!.systemPrompt);
    expect(JSON.stringify(model.inputs[1]!.tools)).toBe(JSON.stringify(model.inputs[0]!.tools));
    // 夜移 003：前缀比较两侧先剥临时投影（时间提醒随下一请求消失）。
    const firstStable = stripProjectedNotes(model.inputs[0]!.messages);
    const secondStable = stripProjectedNotes(model.inputs[1]!.messages);
    const firstMsgs = JSON.stringify(firstStable);
    const secondPrefix = JSON.stringify(secondStable.slice(0, firstStable.length));
    expect(secondPrefix).toBe(firstMsgs);
    expect(model.inputs[1]!.messages.length).toBeGreaterThan(model.inputs[0]!.messages.length);
    const injected = model.inputs[1]!.messages.at(-1);
    expect(injected?.role).toBe("user");
    expect((injected as { content: string }).content).toContain("SCHEDULED WORK");
    // The fire was recorded exactly once (no catch-up).
    const task = rt.list()[0]!;
    expect(task.lastFiredAt).toBeDefined();
    rt.stop();
    driver.dispose();
  });

  it("an idle fire auto-starts a run once (the driver's fire-on-idle seam)", async () => {
    const t0 = Date.now();
    let clock = t0;
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-idle", tickMs: 0, now: () => clock });
    await rt.createTask({ prompt: "IDLE FIRE", schedule: { type: "interval", everyMs: 10 * MIN } });
    const model = recordingModel([{ role: "assistant", content: "idle answer" }]);
    const driver = createAgentDriver({
      model,
      tools: [],
      systemPrompt: "sp",
      summarize: summarizeToolCall,
      onPermissionAsk: allowAsk,
      cron: rt,
    });
    await until(() => driver.getStatus().busy === false, "driver idle");
    clock = t0 + 15 * MIN; // past the 10-minute fire (+jitter ≤5min)
    await rt.tick();
    await until(() => driver.getHistory().some((h) => h.kind === "user" && h.text.includes("IDLE FIRE")), "auto-started run");
    await until(() => driver.getStatus().busy === false, "auto run finished");
    expect(rt.pending().length).toBe(0);
    rt.stop();
    driver.dispose();
  });

  it("Esc (clearLoopPending) removes due /loop wakeups so they do NOT re-arm next tick; explicit tasks survive", async () => {
    const rt = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-esc", tickMs: 0 });
    await rt.createTask({ prompt: "explicit", schedule: { type: "interval", everyMs: 60 * MIN } });
    // The explicit task is NOT due yet (fires in ~60m) — arm only via a due at-task.
    const loop = await rt.createTask({ prompt: "loop round", schedule: { type: "interval", everyMs: MIN }, origin: "loop" });
    // Rewind nothing: make the loop task due by advancing a controlled clock.
    rt.stop();
    let clock = Date.now();
    const rt2 = await createCronRuntime({ workspaceRoot: ws, sessionId: "s-esc", tickMs: 0, now: () => clock });
    await rt2.remove(loop.id).catch(() => {});
    await rt2.createTask({ prompt: "loop round 2", schedule: { type: "interval", everyMs: MIN }, origin: "loop" });
    clock = Date.now() + 5 * MIN;
    await rt2.tick();
    expect(rt2.pending().length).toBe(1); // the loop wakeup armed
    // Esc: clears the pending injection AND the due loop task.
    expect(rt2.clearLoopPending()).toBeGreaterThanOrEqual(1);
    expect(rt2.pending().length).toBe(0);
    // Review MEDIUM 1 pin: the NEXT tick must not re-arm it.
    clock = Date.now() + 7 * MIN;
    await rt2.tick();
    expect(rt2.pending().length).toBe(0);
    // The explicit task survived Esc untouched and stays armed on its own due
    // (60m interval + ≤30m late jitter ⇒ due by +90m).
    clock = Date.now() + 95 * MIN;
    await rt2.tick();
    const pend = rt2.pending();
    expect(pend.length).toBe(1);
    expect(pend[0]!.task.origin ?? "model").toBe("model");
    rt2.stop();
  });

  it("formatScheduledInjection embeds the task id", () => {
    const task: CronTask = { id: "abcd1234", sessionId: "s", prompt: "do it", schedule: { type: "at", at: 0 }, createdAt: 0 };
    expect(formatScheduledInjection(task)).toBe("[scheduled task abcd1234] do it");
  });
});
