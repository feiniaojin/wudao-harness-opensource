// ω99-317 — 定时任务 web 管理面的引擎侧写面收据：
//  1) runNow 的 busy 守卫（绑定会话 + 宿主忙 → 明示拒绝回执，零 runner
//     调用——313 continueRun 忙跳过同语义，本弧补到手动车道）；
//  2) runNow 的熔断重开口（resetBreaker → 复位连败计数 + 重新打开 +
//     立即跑——「给用户一个手动解熔断的口子」）；健康任务带旗零变异；
//  3) 读面加性补：scheduleRowsOf 行带 lastFiredAt/consecutiveFailures；
//  4) lastRunsOf 纯函数（schedules 会话日志 → 每 task 的最近一次运行结果）。
// 夹具全在 mkdtemp(os.tmpdir())——红线：绝不触碰用户文件。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  scheduleRowsOf,
  lastRunsOf,
} from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om317-mgmt-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-09-14T08:00:00").getTime();
const MIN = 60_000;

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

/** Direct-store seed (a task the breaker already disabled) — the daemon
 *  adopts it at creation. */
const seedTask = async (over: Record<string, unknown>): Promise<void> => {
  const dir = join(ws, ".wudao");
  await mkdir(dir);
  await writeFile(
    join(dir, "schedules.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "brkr0001",
          schedule: { type: "every", intervalMs: 10 * MIN },
          prompt: "汇总日报",
          workspace: ws,
          createdFrom: "test",
          createdAt: T0,
          nextRunAt: T0 + 10 * MIN,
          ...over,
        },
      ],
    }),
    "utf8",
  );
};

describe("ω99-317 A — runNow 的 busy 守卫（绑定会话忙 → 明示拒绝）", () => {
  it("绑定会话 + isBusy → ⚠️ 回执点名会话正忙；runner 零调用；计划零推进", async () => {
    let clock = T0;
    let spawns = 0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => {
        spawns += 1;
        return { ok: true, exitCode: 0, output: "spawned" };
      },
      notify: (line) => { lines.push(line); },
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "续跑我", sessionId: "wudao-busy001", createdFrom: "t" });
    const id = (await storedTasks())[0]!.id as string;
    const before = (await storedTasks())[0]!.nextRunAt as number;
    const receipt = await daemon.runNow(id);
    expect(receipt).toMatch(/^⚠️/);
    expect(receipt).toContain("会话正在跑");
    await poll(() => false, 50);
    expect(spawns).toBe(0); // THE assertion: no fork of a busy session
    const after = (await storedTasks())[0]!.nextRunAt as number;
    expect(after).toBe(before); // the schedule itself is untouched (manual runs never advance)
    daemon.stop();
  });

  it("无绑定（spawn 车道）不受 busy 门；未绑定会话的手动试跑照常启动", async () => {
    let clock = T0;
    let spawns = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => {
        spawns += 1;
        return { ok: true, exitCode: 0, output: "ok" };
      },
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "独立跑", createdFrom: "t" });
    const id = (await storedTasks())[0]!.id as string;
    expect(await daemon.runNow(id)).toContain("已立即启动");
    await poll(() => spawns === 1);
    daemon.stop();
  });

  it("提醒（零模型车道）不受 busy 门——手动试响照常", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "x" }),
      notify: (line) => { lines.push(line); },
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "抬头休息", kind: "reminder", createdFrom: "t" });
    const id = (await storedTasks())[0]!.id as string;
    expect(await daemon.runNow(id)).toContain("已立即启动");
    await poll(() => lines.some((l) => l.startsWith("⏰")));
    daemon.stop();
  });
});

describe("ω99-317 B — runNow 的熔断重开口（resetBreaker）", () => {
  it("熔断任务 + resetBreaker → 计数清零 + 重新打开 + 立即跑（回执明说）", async () => {
    let clock = T0;
    let spawns = 0;
    await seedTask({ enabled: false, consecutiveFailures: 3, sessionId: "wudao-bound9" });
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => {
        spawns += 1;
        return { ok: true, exitCode: 0, output: "ok" };
      },
    });
    const receipt = await daemon.runNow("brkr0001", { resetBreaker: true });
    expect(receipt).toContain("已重新打开");
    expect(receipt).toContain("立即试跑");
    await poll(() => spawns === 1);
    await poll(async () => (await storedTasks())[0]!.consecutiveFailures === 0);
    const tasks = await storedTasks();
    expect(tasks[0]!.enabled).toBeUndefined(); // re-opened
    expect(tasks[0]!.consecutiveFailures).toBe(0); // count reset
    daemon.stop();
  });

  it("健康任务带 resetBreaker → 零变异（连败计数不动），普通启动回执", async () => {
    let clock = T0;
    await seedTask({ consecutiveFailures: 2 });
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
    });
    expect(await daemon.runNow("brkr0001", { resetBreaker: true })).toContain("已立即启动");
    await poll(() => false, 80); // let the manual run settle (running cleared)
    expect(await daemon.runNow("brkr0001")).toBe("▶ brkr0001 已立即启动（手动运行——计划不变）");
    await poll(async () => (await storedTasks())[0]!.consecutiveFailures === 2);
    const tasks = await storedTasks();
    expect(tasks[0]!.consecutiveFailures).toBe(2); // untouched on a healthy task
    daemon.stop();
  });
});

describe("ω99-317 C — 读面加性补（scheduleRowsOf 行字段）", () => {
  it("lastFiredAt（null ↔ 数字）与 consecutiveFailures（缺省 0）上桌", () => {
    const base = {
      id: "rowtest01",
      schedule: { type: "weekly", weekdays: [1], time: "09:00" } as const,
      prompt: "周报",
      workspace: "/w",
      createdFrom: "t",
      createdAt: T0,
    };
    const rows = scheduleRowsOf([
      base,
      { ...base, id: "rowtest02", lastFiredAt: T0 + MIN, consecutiveFailures: 2 },
    ], () => T0);
    expect(rows[0]!.lastFiredAt).toBeNull();
    expect(rows[0]!.consecutiveFailures).toBe(0);
    expect(rows[1]!.lastFiredAt).toBe(T0 + MIN);
    expect(rows[1]!.consecutiveFailures).toBe(2);
    // The pre-313 fields ride unchanged (additive only).
    expect(rows[0]!.trigger).toBe("每周一 09:00");
    expect(rows[0]!.kind).toBe("task");
  });
});

describe("ω99-317 D — lastRunsOf 纯函数（会话日志 → 最近一次运行）", () => {
  it("同一 task 多条 → 文件序最后一条胜；异形行跳过；零条 → 空 map", () => {
    const entries: unknown[] = [
      { type: "schedule_run", data: { taskId: "aaaa1111", ok: false, at: "2026-09-14T01:00:00.000Z" } },
      { kind: "user", text: "干扰条目（不是 schedule_run）" },
      { type: "schedule_run", data: { taskId: "aaaa1111", ok: true, at: "2026-09-14T02:00:00.000Z" } },
      { type: "schedule_run", data: { taskId: "bbbb2222", ok: false, at: "2026-09-14T03:00:00.000Z" } },
      { type: "schedule_run", data: "垃圾 data（无 taskId）" },
      { type: "schedule_run" },
      "整行垃圾",
    ];
    const runs = lastRunsOf(entries);
    expect(runs.size).toBe(2);
    expect(runs.get("aaaa1111")).toEqual({ ok: true, at: Date.parse("2026-09-14T02:00:00.000Z") }); // last wins
    expect(runs.get("bbbb2222")).toEqual({ ok: false, at: Date.parse("2026-09-14T03:00:00.000Z") });
    expect(lastRunsOf([]).size).toBe(0);
  });
});
