// M61 §4 — the durable daemon: offline-no-catch-up/online-fire-once, the
// ask-tier posture, the /schedule grammar, and the store refusals.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleDaemon, parseScheduleCommand, loadSchedulesStore, durableNextFire, formatDurableList, runWithTimeout, spawnScheduleRun, SCHEDULES_SESSION_ID, SCHEDULE_RUN_ENV, SCHEDULE_RUN_TIMEOUT_MS } from "../src/schedules.js";
import { loadPermissionSettings, decideRichPermission, createDurableAskTierGate } from "../src/permission.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m61-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-08-17T10:00:00").getTime();
const MIN = 60_000;

describe("M61 §4 — /schedule grammar", () => {
  it("parses list / quoted cron / @ISO one-shot / rm / rejects junk", () => {
    expect(parseScheduleCommand("")).toEqual({ kind: "list" });
    expect(parseScheduleCommand("list")).toEqual({ kind: "list" });
    const cron = parseScheduleCommand('add "*/10 * * * *" run the checks');
    expect(cron).toEqual({ kind: "add", schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "run the checks" });
    const at = parseScheduleCommand("add @2026-08-20T10:30 deploy the site");
    expect(at.kind === "add" && at.schedule.type === "at" && at.schedule.at).toBe(new Date("2026-08-20T10:30").getTime());
    expect(parseScheduleCommand("rm abcd1234")).toEqual({ kind: "rm", id: "abcd1234" });
    expect(parseScheduleCommand('add "0 9 * * mon"').kind).toBe("bad");
    expect(parseScheduleCommand("add @notatime x").kind).toBe("bad");
    expect(parseScheduleCommand("frobnicate").kind).toBe("bad");
  });
});

describe("M61 §4 — the daemon", () => {
  it("offline no-catch-up: a task due while down fires ONCE on the next online, never again by count", async () => {
    let clock = T0 - 30 * MIN;
    const runs: string[] = [];
    const log: { type: string }[] = [];
    let daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (task) => {
        runs.push(task.prompt);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      appendRun: async (entry) => {
        log.push(entry);
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "decide", createdFrom: "test" });
    clock = T0; // 30 minutes "offline" elapsed — three occurrences missed
    const online = await daemon.tick();
    expect(online.length).toBe(1);
    // The fire's bookkeeping (run → persist → appendRun) rides the daemon's
    // async void body incl. real fs I/O — a fixed 20ms nap loses the race
    // under a loaded pool (the flake 0.3.19 classed as budget B; same lesson
    // the one-shot test below already learned). Poll with a deadline.
    const bookedBy = Date.now() + 10_000;
    while (!(runs.length === 1 && log.length === 1)) {
      if (Date.now() > bookedBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(runs).toEqual(["decide"]);
    expect(log.length).toBe(1);
    expect(log[0]!.type).toBe("schedule_run");
    const again = await daemon.tick();
    expect(again.length).toBe(0);
    expect(runs.length).toBe(1);
    daemon.stop();
    // The store recorded the fire; a restarted daemon does not re-fire it.
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    expect(stored.tasks[0].lastFiredAt).toBe(T0);
    clock = T0 + MIN;
    const daemon2 = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    const fires2 = await daemon2.tick();
    await new Promise((r) => setTimeout(r, 20));
    // 1 minute on: the next */10 boundary (+jitter ≤ min(30m, 10m/2)) may or
    // may not have passed — but never more than one fire.
    expect(fires2.length).toBeLessThanOrEqual(1);
    daemon2.stop();
  });

  it("at one-shots delete after their single fire; listText and doctorLine carry state", async () => {
    let clock = T0;
    let fired = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => {
        fired += 1;
        return { ok: false, exitCode: 1, output: "boom" };
      },
    });
    const notice = await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "one shot", createdFrom: "test" });
    expect(notice).toContain("持久任务"); // ω99-185: 钉随源演进
    clock = T0 + 6 * MIN;
    await daemon.tick();
    // The fire + self-delete ride the daemon's async bookkeeping — a fixed
    // 20ms nap loses the race under a loaded win32 pool. Poll, then also
    // poll for the persisted self-delete before reading the file.
    const firedBy = Date.now() + 10_000;
    while (fired === 0) {
      if (Date.now() > firedBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fired).toBe(1);
    const deletedBy = Date.now() + 10_000;
    let stored: { tasks: unknown[] } = { tasks: [1] };
    while (stored.tasks.length > 0) {
      if (Date.now() > deletedBy) break;
      await new Promise((r) => setTimeout(r, 25));
      stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    }
    expect(stored.tasks.length).toBe(0);
    expect(stored.tasks.length).toBe(0);
    expect(daemon.listText()).toContain("无持久任务"); // ω99-185: 钉随源演进
    expect(daemon.doctorLine()).toContain("守护在本进程"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    expect(daemon.doctorLine()).toContain("0 个持久任务"); // ω99-185: 钉随源演进
    daemon.stop();
  });

  it("WUDAO_DISABLE_CRON=1 disables the daemon (explained, not silent)", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, env: { WUDAO_DISABLE_CRON: "1" } });
    expect(daemon.refusal).toBe("disabled");
    expect(await daemon.add({ schedule: { type: "at", at: T0 }, prompt: "x" })).toContain("已禁用"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    daemon.stop();
  });

  it("a symlinked schedules.json is refused", async () => {
    const real = join(ws, "real.json");
    await writeFile(real, "{}", "utf8");
    const target = await mkdtemp(join(ws, "t-"));
    await symlink(real, join(target, "schedules.json"));
    const linked = await mkdtemp(join(ws, "l-"));
    await symlink(target, join(linked, ".wudao"));
    await expect(loadSchedulesStore({ workspaceRoot: linked, env: {} })).rejects.toThrow(/symlink/);
  });

  it("durableNextFire: no next fire for a past fired at-task; cron tasks keep recurring", () => {
    const atTask = { id: "aaaaaaaa", schedule: { type: "at" as const, at: T0 }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0 - MIN, lastFiredAt: T0 };
    expect(durableNextFire(atTask, T0 + MIN)).toBeUndefined();
    const cronTask = { id: "bbbbbbbb", schedule: { type: "cron" as const, expr: "*/10 * * * *" }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0, lastFiredAt: T0 };
    const next = durableNextFire(cronTask, T0 + MIN);
    expect(next).toBeDefined();
    expect(next! - T0).toBeGreaterThan(MIN);
    expect(next! - T0).toBeLessThanOrEqual(10 * MIN + 5 * MIN); // + late jitter cap (interval/2)
  });

  it("the scheduled-run ask posture: the REAL permission decision denies fail-closed (review LOW 2)", async () => {
    const { nonInteractiveAskDecision } = await import("../src/permission.js");
    // The exported decision askApprove itself uses for non-TTY input.
    const scheduled = nonInteractiveAskDecision("write_file", { [SCHEDULE_RUN_ENV]: "1" });
    expect(scheduled.kind).toBe("deny");
    expect(scheduled.reason).toContain("scheduled run");
    expect((scheduled as { scheduledRun?: boolean }).scheduledRun).toBe(true);
    const plain = nonInteractiveAskDecision("write_file", {});
    expect(plain).toEqual({ kind: "deny", reason: "non-interactive" });
    expect((plain as { scheduledRun?: boolean }).scheduledRun).toBeUndefined();
  });

  it("a hung run resolves with the timeout failure instead of wedging the task (review LOW 1)", async () => {
    const never = new Promise<never>(() => {});
    const started = Date.now();
    const out = await runWithTimeout(never, 50, () => ({ ok: false, output: "timed out" }));
    expect(out).toEqual({ ok: false, output: "timed out" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    const fast = await runWithTimeout(Promise.resolve({ ok: true, output: "done" }), 5_000, () => ({ ok: false, output: "timed out" }));
    expect(fast).toEqual({ ok: true, output: "done" });
    expect(SCHEDULE_RUN_TIMEOUT_MS).toBe(30 * 60_000);
  });

  it("SCHEDULES_SESSION_ID names the dedicated session log", () => {
    expect(SCHEDULES_SESSION_ID).toBe("schedules");
  });
});

describe("M61 §4 — the durable ask tier (re-review item 8 + ruling)", () => {
  it("read-only passes, everything else denies; allow rules and a global bypass opt-in are never consulted", async () => {
    const { mkdir, writeFile: wf } = await import("node:fs/promises");
    // Project tier: an ALLOW rule for write_file/shell + a DENY rule on
    // a read-only secrets read. Global tier: the bypass opt-in (legal there).
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await wf(join(ws, ".wudao", "settings.json"), JSON.stringify({
      permissions: { allow: ["write_file", "shell"], deny: ["read_file:secrets.env"] },
    }), "utf8");
    const globalHome = await mkdtemp(join(ws, "gh-"));
    await mkdir(globalHome, { recursive: true });
    await wf(join(globalHome, "settings.json"), JSON.stringify({ bypassPermissions: true }), "utf8");
    // Isolate the global tier to the fixture (the loaders read
    // WUDAO_GLOBAL_HOME from process.env).
    const savedGlobal = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    try {
    // The REAL staticDeny pipeline runReal builds (settings union + the
    // layered decision, deny outcomes only).
    const settings = await loadPermissionSettings(ws, undefined);
    const staticDeny = async (toolName: string, input: Record<string, unknown>) => {
      const d = decideRichPermission({ mode: "default", toolName, input, settings });
      return d !== "ask" && d.behavior === "deny" ? d : undefined;
    };
    const gate = createDurableAskTierGate({
      getTools: () => [
        {
          name: "read_file",
          isReadOnly: () => true,
          checkPermissions: async (input) =>
            String(input.path ?? "").includes("forbidden") ? { behavior: "deny", reason: "checkPermissions denied" } : { behavior: "allow" },
        },
        { name: "write_file", isReadOnly: () => false },
        { name: "shell", isReadOnly: () => false },
      ],
      staticDeny,
    });

    // Non-read-only: the persisted ALLOW rule and the global bypass opt-in
    // change NOTHING — the scheduled ask tier denies (ask with no human).
    const w = await gate("write_file", { path: "a.txt" });
    expect(w).toEqual({ behavior: "deny", reason: "scheduled run: ask tier with no human — deny" });
    const r = await gate("shell", { command: "echo hi" });
    expect(r.behavior).toBe("deny");

    // Read-only: allowed (the ask layer is bypassed)…
    const okRead = await gate("read_file", { path: "README.md" });
    expect(okRead).toEqual({ behavior: "allow" });
    // …but a DENY rule on the read-only tool still binds (the ruling).
    const deniedRead = await gate("read_file", { path: "secrets.env" });
    expect(deniedRead.behavior).toBe("deny");
    // …and so does the tool's own checkPermissions deny.
    const cpDenied = await gate("read_file", { path: "forbidden.txt" });
    expect(cpDenied.behavior).toBe("deny");
    // An unknown tool (no isReadOnly) denies too.
    expect((await gate("mystery", {})).behavior).toBe("deny");
    } finally {
      if (savedGlobal !== undefined) process.env.WUDAO_GLOBAL_HOME = savedGlobal;
      else delete process.env.WUDAO_GLOBAL_HOME;
    }
  });

  it("the REAL kill path: a hung child is SIGKILLed and reported as a timeout (re-review item 5)", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const sleeper = join(ws, "sleep-forever.mjs");
    await wf(sleeper, "setInterval(() => {}, 1000);\nprocess.stdout.write('started\\n');\n", "utf8");
    const task: import("../src/schedules.js").DurableTask = {
      id: "kkkkkkkk",
      schedule: { type: "at", at: Date.now() },
      prompt: "sleep",
      workspace: ws,
      createdFrom: "test",
      createdAt: Date.now(),
    };
    const started = Date.now();
    const result = await spawnScheduleRun(task, {}, { timeoutMs: 400, entryPath: sleeper });
    expect(result.ok).toBe(false);
    expect(result.output).toContain("超时"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    expect(result.output).toContain("已终止"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    expect(Date.now() - started).toBeLessThan(10_000);
    // v7 γ2——kill 留名：超时车道带结构化成因（output 尾巴只是人读面）。
    expect(result.endCause).toBe("schedule-timeout");
  });

  it("v7 γ2 — 正常结束不带成因（exitCode 已说尽；omit-when-no-cause）", async () => {
    const { writeFile: wf } = await import("node:fs/promises");
    const quitter = join(ws, "quit-now.mjs");
    await wf(quitter, "process.stdout.write('bye\\n');\n", "utf8");
    const task: import("../src/schedules.js").DurableTask = {
      id: "qqqqqqqq",
      schedule: { type: "at", at: Date.now() },
      prompt: "quit",
      workspace: ws,
      createdFrom: "test",
      createdAt: Date.now(),
    };
    const result = await spawnScheduleRun(task, {}, { timeoutMs: 5_000, entryPath: quitter });
    expect(result.ok).toBe(true);
    expect(result.endCause).toBeUndefined();
  });

  it("v7 γ2 — 超时 kill 的台账行带 endCause，且「怎么结束」入指纹账（姊妹面）", async () => {
    let clock = T0 - 30 * MIN;
    const log: { type: string; data: Record<string, unknown> }[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      // Scripted timeout lane — the REAL spawn path's endCause contract (the
      // kill test above pins the spawn side end-to-end; here we pin the
      // daemon's ledger + fingerprint bookkeeping).
      runTask: async () => ({
        ok: false,
        exitCode: null,
        output: "…\n[计划任务运行 30 分钟超时——已终止]",
        endCause: "schedule-timeout" as const,
      }),
      appendRun: async (entry) => {
        log.push(entry as { type: string; data: Record<string, unknown> });
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "hang", createdFrom: "test" });
    clock = T0;
    await daemon.tick();
    const bookedBy = Date.now() + 10_000;
    while (log.length < 1) {
      if (Date.now() > bookedBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(log.length).toBe(1);
    expect(log[0]!.type).toBe("schedule_run");
    expect(log[0]!.data.endCause).toBe("schedule-timeout"); // kill 留名：台账行带结构化成因
    daemon.stop();
    // The fingerprint ledger got the run-end observation (subject=计划任务 id,
    // 稳定可数) — read back through the same reader the mission boot folds.
    const { readFailureEvents, failureFingerprintPath } = await import("../src/failure-fingerprints.js");
    const bookedFp = Date.now() + 10_000;
    let fpEvents: unknown[] = [];
    while (Date.now() < bookedFp) {
      fpEvents = await readFailureEvents(failureFingerprintPath(ws)).then((e) => [...e]);
      if (fpEvents.length === 1) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(fpEvents).toHaveLength(1);
    const row = fpEvents[0] as { stage?: string; subject?: string; normalized?: string };
    expect(row.stage).toBe("run-end");
    expect(row.subject).toContain("计划任务 ");
    expect(row.normalized).toBe("计划任务超时被终止");
  });
});

// ω99-5a — the goose daemon verbs: pause/unpause/run (run_now) + the
// triggeredBy audit on every spawned run. Pause never kills an in-flight
// run; a manual run never advances the schedule.
describe("ω99-5a — /schedule pause/unpause/run", () => {
  it("parses pause/unpause/run <id>; a missing id is bad", () => {
    expect(parseScheduleCommand("pause abcd1234")).toEqual({ kind: "pause", id: "abcd1234" });
    expect(parseScheduleCommand("unpause abcd1234")).toEqual({ kind: "unpause", id: "abcd1234" });
    expect(parseScheduleCommand("run abcd1234")).toEqual({ kind: "run", id: "abcd1234" });
    expect(parseScheduleCommand("pause").kind).toBe("bad");
    expect(parseScheduleCommand("unpause").kind).toBe("bad");
    expect(parseScheduleCommand("run").kind).toBe("bad");
  });

  it("durableNextFire: a paused task has nothing pending even when due; unpaused resumes to the next future fire (no catch-up burst)", () => {
    // Fired at T0, then paused: the 10:00-boundary aftermath is frozen — no
    // fire accrues while paused.
    const base = { id: "cccccccc", schedule: { type: "cron" as const, expr: "*/10 * * * *" }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0 - 40 * MIN, lastFiredAt: T0 };
    const now = T0 + 3 * MIN;
    expect(durableNextFire({ ...base, paused: true }, now)).toBeUndefined();
    const resumed = durableNextFire(base, now);
    expect(resumed).toBeDefined();
    expect(resumed! - now).toBeGreaterThan(0); // one future boundary (10:10 + jitter)
    expect(resumed! - now).toBeLessThanOrEqual(10 * MIN + 5 * MIN); // + late jitter cap
  });

  it("tick: a paused due task fires nothing — zero runs, zero appendRun", async () => {
    let clock = T0;
    const runs: string[] = [];
    const log: unknown[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (task) => {
        runs.push(task.id);
        return { ok: true, exitCode: 0, output: "ok" };
      },
      appendRun: async (entry) => {
        log.push(entry);
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    const id = stored.tasks[0].id as string;
    await daemon.pause(id);
    clock = T0 + 30 * MIN; // several boundaries pass while paused
    expect((await daemon.tick()).length).toBe(0);
    await new Promise((r) => setTimeout(r, 50));
    expect(runs).toEqual([]);
    expect(log).toEqual([]);
    daemon.stop();
  });

  it("pause: persists paused (reload asserts); refuses a running task; unknown id warns", async () => {
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      // Never resolves: the fired task stays in the running set.
      runTask: async () => new Promise(() => {}) as Promise<{ ok: boolean; exitCode: number; output: string }>,
    });
    expect(await daemon.pause("zzzzzzzz")).toMatch(/^⚠️/);
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "a", createdFrom: "test" });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "b", createdFrom: "test" });
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    const runner = stored.tasks[0].id as string; // stays active
    const sleeper = stored.tasks[1].id as string; // gets paused
    const notice = await daemon.pause(sleeper);
    expect(notice).toContain("已暂停"); // ω99-185: 钉随源演进
    const reloaded = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(reloaded.tasks.find((t) => t.id === sleeper)!.paused).toBe(true);
    expect(reloaded.tasks.find((t) => t.id === runner)!.paused).toBeUndefined();
    // A running task refuses to pause (the run finishes on its own; nothing killed).
    clock = T0 + 30 * MIN; // past any late-jitter cap, so the fire is surely due
    const fired = await daemon.tick();
    expect(fired.map((t) => t.id)).toEqual([runner]);
    expect(await daemon.pause(runner)).toMatch(/^⚠️.*正在运行/); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    const reloaded2 = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(reloaded2.tasks.find((t) => t.id === runner)!.paused).toBeUndefined();
    daemon.stop();
  });

  it("unpause: clears the flag (reload asserts); unknown id warns", async () => {
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => T0,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(await daemon.unpause("zzzzzzzz")).toMatch(/^⚠️/);
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    const id = stored.tasks[0].id as string;
    await daemon.pause(id);
    expect(await daemon.unpause(id)).toContain("已恢复"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    const reloaded = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(reloaded.tasks[0]!.paused).toBeUndefined();
    daemon.stop();
  });

  it("runNow: spawns immediately with triggeredBy manual; lastFiredAt unchanged; concurrent refused; unknown id warns", async () => {
    let clock = T0;
    const runs: string[] = [];
    const log: { type: string; data: Record<string, unknown> }[] = [];
    let release: (() => void) | undefined;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async (task) => {
        runs.push(task.id);
        return new Promise((r) => {
          release = () => r({ ok: true, exitCode: 0, output: "ok" });
        });
      },
      appendRun: async (entry) => {
        log.push(entry);
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    const id = stored.tasks[0].id as string;
    expect(await daemon.runNow(id)).toContain("已立即启动"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    const ranBy = Date.now() + 10_000;
    while (runs.length < 1) {
      if (Date.now() > ranBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(runs).toEqual([id]);
    // Still in the running set: a second manual run is refused (goose run_now).
    expect(await daemon.runNow(id)).toMatch(/^⚠️.*已在运行/); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
    expect(await daemon.runNow("zzzzzzzz")).toMatch(/^⚠️/);
    release?.();
    const bookedBy = Date.now() + 10_000;
    while (log.length < 1) {
      if (Date.now() > bookedBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(log[0]!.type).toBe("schedule_run");
    expect(log[0]!.data.triggeredBy).toBe("manual");
    // The manual run advanced nothing: no lastFiredAt, next scheduled fire intact.
    const after = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    expect(after.tasks[0].lastFiredAt).toBeUndefined();
    expect(after.tasks.length).toBe(1);
    daemon.stop();
  });

  it("tick's appendRun carries triggeredBy cron", async () => {
    let clock = T0;
    const log: { type: string; data: Record<string, unknown> }[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      appendRun: async (entry) => {
        log.push(entry);
      },
    });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    clock = T0 + 30 * MIN; // past any late-jitter cap
    await daemon.tick();
    const bookedBy = Date.now() + 10_000;
    while (log.length < 1) {
      if (Date.now() > bookedBy) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(log[0]!.data.triggeredBy).toBe("cron");
    daemon.stop();
  });

  it("formatDurableList: a paused row carries the ⏸/(paused) markers", () => {
    const text = formatDurableList([
      { id: "dddddddd", schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0, paused: true },
    ], () => T0);
    expect(text).toContain("⏸");
    expect(text).toContain("（已暂停）"); // ω99-185: 钉随源演进（brief 漏列，census 兜出）
  });

  it("store normalization: a garbage paused value drops the field but keeps the task", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", "schedules.json"), JSON.stringify({
      version: 1,
      tasks: [{ id: "abcd1234", schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0, paused: "yes" }],
    }), "utf8");
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(store.tasks.length).toBe(1); // bad field never drops the task
    expect(store.tasks[0]!.paused).toBeUndefined();
  });
});
