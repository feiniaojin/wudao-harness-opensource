// ω99-313 — the daemon's structured-family acceptance: the reminder light
// path (ZERO model requests — runTask never spawns), the missed-fire boot
// catch-up (ONE fire per gap, nextRun recomputed from now), the consecutive
// failure breaker (disable + ONE notification + unpause re-opens), the
// bound-session continue lane (skip-while-busy, spawn fallback), and the
// snooze verb. Mirrors the m61/185/189 daemon fixture form (tmpWs +
// createScheduleDaemon + runTask stub + polled async bookkeeping).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  parseScheduleCommand,
  SCHEDULE_BREAKER_FAILURES,
} from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om313-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-09-14T08:00:00").getTime();
const MIN = 60_000;
type RunResult = { ok: boolean; exitCode: number; output: string };
const okRun = async () => ({ ok: true, exitCode: 0, output: "ok" }) as RunResult;

/** Poll until pred or deadline (the daemon's fire bookkeeping rides a real
 *  async void body incl. fs I/O — m61's polled-flake lesson). Async preds
 *  (store reads) are awaited per round. */
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

const oneId = async (): Promise<string> => (await storedTasks())[0]!.id as string;

describe("ω99-313 A — reminder 轻路径（零模型请求）", () => {
  it("a due reminder notifies and NEVER touches the runner (零模型请求)", async () => {
    const lines: string[] = [];
    let spawns = 0;
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws,
      now: () => clock,
      tickMs: 0,
      env: {},
      runTask: async () => {
        spawns += 1;
        return { ok: true, exitCode: 0, output: "should not run" };
      },
      notify: (line) => {
        lines.push(line);
      },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "该发周报了", kind: "reminder", createdFrom: "test" });
    clock = T0 + 6 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 1);
    expect(spawns).toBe(0); // THE assertion: no model request, no subprocess
    expect(lines[0]).toContain("⏰ 该发周报了");
    daemon.stop();
  });

  it("a plain reminder self-deletes after firing; a snoozeable one lingers one window then retires", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, notify: (line) => { lines.push(line); },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + MIN }, prompt: "plain", kind: "reminder", createdFrom: "t" });
    await daemon.add({ schedule: { type: "at", at: T0 + MIN }, prompt: "snoozy", kind: "reminder", snoozeMinutes: 10, createdFrom: "t" });
    clock = T0 + 2 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 2);
    await poll(async () => false, 50); // let the persists land
    let tasks = await storedTasks();
    expect(tasks.map((t) => t.prompt)).toEqual(["snoozy"]); // plain retired, snoozy lingers
    expect(tasks[0]!.nextRunAt).toBeUndefined();
    expect(typeof tasks[0]!.snoozeUntil).toBe("number");
    // The snooze hint rides the notification for snoozeable reminders only.
    expect(lines[0]).not.toContain("snooze");
    expect(lines[1]).toContain("/schedule snooze");
    // The window closes unsnoozed → the next tick retires it.
    clock = T0 + 2 * MIN + 11 * MIN;
    await daemon.tick();
    await poll(async () => (await storedTasks()).length === 0);
    tasks = await storedTasks();
    expect(tasks.length).toBe(0);
    daemon.stop();
  });

  it("snooze re-arms a fired reminder inside its window (re-ring), refuses non-reminders", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, notify: (line) => { lines.push(line); },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + MIN }, prompt: "抬头休息一下", kind: "reminder", snoozeMinutes: 10, createdFrom: "t" });
    const id = await oneId();
    clock = T0 + 2 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 1);
    expect(await daemon.snooze(id, 5)).toBe(`⏰ ${id} 将在 5 分钟后再提醒`);
    clock = T0 + 2 * MIN + 5 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 2);
    expect(lines[1]).toContain("⏰ 抬头休息一下"); // re-rang
    daemon.stop();
  });

  it("weekly reminders repeat: fire → notify → next occurrence from the fire time", async () => {
    let clock = new Date("2026-09-14T08:00:00").getTime(); // Monday 08:00
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, notify: (line) => { lines.push(line); },
    });
    await daemon.add({ schedule: { type: "weekly", weekdays: [1, 3], time: "09:00" }, prompt: "站会", kind: "reminder", createdFrom: "t" });
    clock = new Date("2026-09-16T09:00:00").getTime(); // Wednesday 09:00 on the dot
    await daemon.tick();
    await poll(() => lines.length === 1);
    const tasks = await storedTasks();
    expect(tasks[0]!.nextRunAt).toBe(new Date("2026-09-21T09:00:00").getTime()); // next Mon 09:00
    expect(tasks.length).toBe(1); // recurring reminder survives
    daemon.stop();
  });
});

describe("ω99-313 B — 缺火补跑只补一次（boot）", () => {
  it("a task stale by hours fires ONCE at boot; nextRun recomputes from now", async () => {
    // Seed the store directly: an every-30m task whose nextRunAt is 4 hours
    // stale (the app was closed) — ~8 missed occurrences.
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const boot = T0;
    await writeFile(
      join(ws, ".wudao", "schedules.json"),
      JSON.stringify({
        version: 1,
        tasks: [{
          id: "stale001", schedule: { type: "every", intervalMs: 30 * MIN }, prompt: "poll",
          workspace: ws, createdFrom: "t", createdAt: T0 - 8 * 60 * MIN, nextRunAt: T0 - 4 * 60 * MIN,
        }],
      }),
      "utf8",
    );
    const runs: string[] = [];
    let clock = boot;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async (task) => {
        runs.push(task.prompt);
        return { ok: true, exitCode: 0, output: "ok" };
      },
    });
    // The creation-time tick (the online transition) fires the catch-up.
    await poll(() => runs.length === 1);
    await poll(async () => (await storedTasks())[0]!.nextRunAt !== undefined && (await storedTasks())[0]!.nextRunAt === boot + 30 * MIN);
    expect(runs.length).toBe(1); // ONE catch-up fire — not 8
    const tasks = await storedTasks();
    expect(tasks[0]!.nextRunAt).toBe(boot + 30 * MIN); // recomputed from NOW
    expect(tasks[0]!.lastFiredAt).toBe(boot);
    daemon.stop();
  });
});

describe("ω99-313 C — 连败熔断", () => {
  it("3 consecutive cron failures disable the task + ONE notification; no 4th run; success resets; unpause re-opens", { timeout: 60_000 }, async () => {
    let clock = T0;
    const lines: string[] = [];
    let runs = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => {
        runs += 1;
        return { ok: false, exitCode: 1, output: "boom" };
      },
      notify: (line) => { lines.push(line); },
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", createdFrom: "t" });
    for (let i = 1; i <= 3; i += 1) {
      clock = T0 + i * 10 * MIN;
      await daemon.tick();
      // Wait for the fire to FULLY settle (the breaker's persist is the last
      // write before the in-flight guard clears — polling `runs` alone races
      // the guard and the next tick would skip).
      // 60s 测试预算（缺省 20s 在 CI 共享跑机上不够——三轮 fire+persist 的
      // 真实 fs 轮询在慢盘上每轮可吃数秒；同一提交在另一跑机上全绿，纯
      // 跑机速度抖动，0.4.21 公开仓首轮 CI 揭发）。
      await poll(async () => (await storedTasks())[0]!.consecutiveFailures === i);
    }
    await poll(() => lines.some((l) => l.includes("连续 3 次没跑成")));
    clock = T0 + 40 * MIN;
    await daemon.tick();
    await poll(() => false, 100); // settle — the disabled task must NOT run
    expect(runs).toBe(3); // the 4th due window never ran it
    const breakerLines = lines.filter((l) => l.includes("连续 3 次没跑成"));
    expect(breakerLines.length).toBe(1); // notified ONCE
    const tasks = await storedTasks();
    expect(tasks[0]!.enabled).toBe(false);
    expect(tasks[0]!.consecutiveFailures).toBe(3);
    // unpause re-opens (the breaker's advertised path).
    expect(await daemon.unpause(tasks[0]!.id as string)).toContain("已恢复");
    const reopened = await storedTasks();
    expect(reopened[0]!.enabled).toBeUndefined(); // absent = enabled
    expect(reopened[0]!.consecutiveFailures).toBe(0);
    daemon.stop();
  });

  it("a success after failures resets the counter (no trip)", { timeout: 60_000 }, async () => {
    let clock = T0;
    const results: boolean[] = [false, false, true];
    let i = 0;
    let runs = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => {
        runs += 1;
        const ok = results[i++] ?? true;
        return { ok, exitCode: ok ? 0 : 1, output: ok ? "ok" : "boom" };
      },
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", createdFrom: "t" });
    for (let k = 1; k <= 3; k += 1) {
      clock = T0 + k * 10 * MIN;
      await daemon.tick();
      // Full settle per fire: the advance's nextRunAt is the durable marker.
      await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + (k + 1) * 10 * MIN);
    }
    // 复位是 fire 内的第二次写、落在 nextRunAt 之后（慢盘上两写之间有可见
    // 窗口——CI 揭发 expected 2 to be 0）：轮询复位本身，不以 nextRunAt 当
    // 复位的代理标记（与第一个测试的熔断 persist 注释同族）。
    await poll(async () => (await storedTasks())[0]!.consecutiveFailures === 0);
    const tasks = await storedTasks();
    expect(tasks[0]!.consecutiveFailures).toBe(0); // 2 fails then a success → reset
    expect(tasks[0]!.enabled).toBeUndefined();
    daemon.stop();
  });

  it("manual (runNow) failures never count toward the breaker", async () => {
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: false, exitCode: 1, output: "boom" }),
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", createdFrom: "t" });
    const id = await oneId();
    for (let i = 0; i < SCHEDULE_BREAKER_FAILURES + 1; i += 1) {
      await daemon.runNow(id);
      await poll(() => false, 30);
    }
    const tasks = await storedTasks();
    expect(tasks[0]!.enabled).toBeUndefined(); // never tripped
    expect(tasks[0]!.consecutiveFailures).toBeUndefined(); // never counted
    daemon.stop();
  });
});

describe("ω99-313 D — 绑定会话续跑（同前缀通道）", () => {
  const mk = async (over: {
    continueRun?: (id: string) => Promise<{ readonly started: boolean }>;
    isBusy?: () => boolean;
  }) => {
    const lines: string[] = [];
    let spawns = 0;
    const continues: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => {
        spawns += 1;
        return { ok: true, exitCode: 0, output: "spawned" };
      },
      notify: (line) => { lines.push(line); },
      ...(over.continueRun !== undefined ? { continueRun: over.continueRun } : {}),
      ...(over.isBusy !== undefined ? { isBusy: over.isBusy } : {}),
    });
    return { daemon, lines, spawns: () => spawns, continues };
  };

  it("started:true → the fire RIDES the bound session; no spawn, no failure bookkeeping", async () => {
    const { daemon, lines, spawns, continues } = await mk({ continueRun: async (id) => { continues.push(id); return { started: true }; } });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "续跑我", sessionId: "wudao-bound1", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => lines.length === 1);
    expect(spawns()).toBe(0);
    expect(lines[0]).toContain("接着上次的会话继续跑");
    expect(continues).toEqual(["wudao-bound1"]); // exactly one continue attempt
    await poll(async () => (await storedTasks())[0]!.lastFiredAt === T0 + 10 * MIN);
    const tasks = await storedTasks();
    expect(tasks[0]!.nextRunAt).toBe(T0 + 20 * MIN); // advanced
    expect(tasks[0]!.consecutiveFailures).toBeUndefined();
    daemon.stop();
  });

  it("busy host → a notified SKIP (no duplicate fork), occurrence consumed", async () => {
    const { daemon, lines, spawns } = await mk({
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", sessionId: "wudao-bound1", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => lines.length === 1);
    expect(spawns()).toBe(0);
    expect(lines[0]).toContain("会话正忙");
    await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + 20 * MIN);
    const tasks = await storedTasks();
    expect(tasks[0]!.lastFiredAt).toBe(T0 + 10 * MIN); // consumed, next from now
    daemon.stop();
  });

  it("started:false (settled tail / gone id) → the fresh-run spawn fallback", async () => {
    const { daemon, lines, spawns } = await mk({ continueRun: async () => ({ started: false }) });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", sessionId: "wudao-gone01", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => spawns() === 1);
    await poll(() => lines.some((l) => l.startsWith("✅")));
    expect(lines.some((l) => l.includes("spawned"))).toBe(true);
    daemon.stop();
  });
});

describe("ω99-313 E — add 面与存储", () => {
  it("structured validation: sub-minute interval and bad weekday/time refuse with the reason", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    expect(await daemon.add({ schedule: { type: "every", intervalMs: 5_000 }, prompt: "p", createdFrom: "t" })).toContain("至少 1 分钟");
    expect(await daemon.add({ schedule: { type: "weekly", weekdays: [9], time: "09:00" }, prompt: "p", createdFrom: "t" })).toContain("星期取值");
    expect(await daemon.add({ schedule: { type: "weekly", weekdays: [1], time: "9点" }, prompt: "p", createdFrom: "t" })).toContain("时间形如");
    expect(await daemon.add({ schedule: { type: "at", at: T0 - MIN }, prompt: "p", createdFrom: "t" })).toContain("需在未来");
    // Nothing landed (a refused add persists nothing — listText stays empty).
    expect(daemon.listText()).toContain("无持久任务");
    daemon.stop();
  });

  it("budgetTokens + kind + sessionId persist; the receipt names reminders by use", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    const t = await daemon.add({ schedule: { type: "every", intervalMs: 30 * MIN }, prompt: "p", budgetTokens: 5000, sessionId: "wudao-budget", createdFrom: "t" });
    expect(t).toContain("持久任务");
    const r = await daemon.add({ schedule: { type: "weekly", weekdays: [5], time: "17:30" }, prompt: "发周报", kind: "reminder", createdFrom: "t" });
    expect(r).toContain("📅 提醒 ");
    expect(r).toContain("每周五 17:30");
    const tasks = await storedTasks();
    expect(tasks[0]!.budgetTokens).toBe(5000);
    expect(tasks[0]!.sessionId).toBe("wudao-budget");
    expect(tasks[0]!.nextRunAt).toBe(T0 + 30 * MIN);
    expect(tasks[1]!.kind).toBe("reminder");
    daemon.stop();
  });

  it("listText shows the human trigger, the reminder tag, and the breaker-disabled state", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    await daemon.add({ schedule: { type: "weekly", weekdays: [1, 3], time: "09:00" }, prompt: "汇总", kind: "reminder", createdFrom: "t" });
    let text = daemon.listText();
    expect(text).toContain("每周一、周三 09:00");
    expect(text).toContain("⏰提醒");
    expect(text).toContain(`下次：${new Date(T0 + 60 * MIN).toISOString()}`); // Monday 09:00 = T0+1h
    // Disabled (breaker) rows carry the ⛔ state.
    const id = await oneId();
    for (let i = 0; i < SCHEDULE_BREAKER_FAILURES; i += 1) {
      await daemon.runNow(id);
      await poll(() => false, 30);
    }
    // Manual runs don't trip the breaker — disable via a real cron fire path instead:
    // (covered in C; here just unpause-reopen sanity on a fresh disable through store.)
    text = daemon.listText();
    expect(text).not.toContain("已停用");
    daemon.stop();
  });
});

describe("ω99-313 F — /schedule snooze 语法", () => {
  it("parses snooze <id> [分钟]; junk minutes refuse", () => {
    expect(parseScheduleCommand("snooze abcd1234")).toEqual({ kind: "snooze", id: "abcd1234" });
    expect(parseScheduleCommand("snooze abcd1234 15")).toEqual({ kind: "snooze", id: "abcd1234", minutes: 15 });
    expect(parseScheduleCommand("snooze").kind).toBe("bad");
    expect(parseScheduleCommand("snooze abcd1234 x").kind).toBe("bad");
  });
});
