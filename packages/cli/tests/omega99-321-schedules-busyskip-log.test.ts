// ω99-321 — busy-skip 落账收据（317 债兑现：忙跳过要在账上可查）：
//  A) busy 窗口 cron-fire → skipped 车道恰落一条 schedule_run（mode:
//     "skipped"/ok:true/taskId/prompt 帽 200/workspace/at=tick 时刻/
//     triggeredBy:"cron" 全形状）；advanceAfterFire 仍推一格；notify 恰一条；
//  B) 回归——手动 runNow 忙拒答零新条目；非 busy 续跑车道照旧 mode:
//     "continue"（无 skipped 泄漏）；提醒车道照旧零落账；
//  C) 熔断隔离——busy-skip 后 consecutiveFailures 不变（skipped 早退
//     不走 breakerStep——结构性保证钉死）；
//  D) appendRun reject → fire 流程不炸（catch 吞，notify 已发，后续 tick
//     照常——账丢一条比中断差）；
//  E) lastRunsOf join——mode 透传（老条目无 mode 键零变化）；skipped 条目
//     作为最后一条胜出（文件序语义回归）。
// 夹具全在 mkdtemp(os.tmpdir())——红线：绝不触碰用户文件。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  lastRunsOf,
} from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om321-skip-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-09-14T08:00:00").getTime();
const MIN = 60_000;

/** Poll until pred or deadline（fire 记账骑真异步 void 体——m61 防闪烁范式）。 */
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

/** Direct-store seed（daemon 创建前落表——守护在创建时采纳）。 */
const seedTask = async (over: Record<string, unknown>): Promise<void> => {
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(
    join(ws, ".wudao", "schedules.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "seed0001",
          schedule: { type: "every", intervalMs: 10 * MIN },
          prompt: "seedy",
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

type RunEntry = { type: string; data: Record<string, unknown> };

describe("ω99-321 A — busy 窗口 cron-fire → skipped 车道恰落一条运行日志", () => {
  it("mode=skipped / ok=true / 全形状；advance 仍推一格；notify 恰一条；prompt 帽 200", async () => {
    const lines: string[] = [];
    const runs: RunEntry[] = [];
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "spawned" }),
      notify: (line) => { lines.push(line); },
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    const longPrompt = "长".repeat(260); // 超帽——断言 data.prompt 恰 200
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: longPrompt, sessionId: "wudao-bound1", createdFrom: "t" });
    const id = await oneId();
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => runs.length === 1);
    // notify 先于 appendRun（与 continue 车道同序）——账到手时通知必已发。
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("会话正忙");
    expect(runs.length).toBe(1); // 恰一条
    expect(runs[0]!.type).toBe("schedule_run");
    expect(runs[0]!.data).toEqual({
      taskId: id,
      prompt: "长".repeat(200),
      workspace: ws,
      ok: true, // 语义裁定：健康跳过不是失败——「不失败」占位，消费面先判 mode
      at: new Date(T0 + 10 * MIN).toISOString(), // 本 tick 的时刻（continue 车道同源）
      mode: "skipped",
      triggeredBy: "cron",
    });
    // advanceAfterFire 仍只推一格（occurrence consumed）。
    await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + 20 * MIN);
    const tasks = await storedTasks();
    expect(tasks[0]!.lastFiredAt).toBe(T0 + 10 * MIN);
    daemon.stop();
  });
});

describe("ω99-321 B — 回归：其余车道照旧（零 skipped 泄漏）", () => {
  it("手动 runNow 忙拒答 → 零新条目（317 守卫不动）", async () => {
    const lines: string[] = [];
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "续跑我", sessionId: "wudao-busy001", createdFrom: "t" });
    const id = await oneId();
    const receipt = await daemon.runNow(id);
    expect(receipt).toMatch(/^⚠️/);
    expect(receipt).toContain("会话正在跑");
    await poll(() => false, 50);
    expect(runs.length).toBe(0); // 拒答不落账
    daemon.stop();
  });

  it("非 busy 续跑车道照旧 mode=continue（不是 skipped）", async () => {
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "spawned" }),
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => false,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "续跑我", sessionId: "wudao-free001", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => runs.length === 1);
    expect(runs[0]!.data.mode).toBe("continue");
    expect(runs[0]!.data.triggeredBy).toBe("cron");
    daemon.stop();
  });

  it("提醒车道照旧零落账（busy 与否无关——轻路径在 busy 门之前）", async () => {
    const lines: string[] = [];
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "x" }),
      notify: (line) => { lines.push(line); },
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "抬头休息", kind: "reminder", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => lines.length === 1);
    await poll(() => false, 50);
    expect(runs.length).toBe(0); // 提醒不进运行日志（313 既定语义）
    daemon.stop();
  });
});

describe("ω99-321 C — 熔断隔离：busy-skip 不进连败计数", () => {
  it("预置连败 2 的绑定任务 busy-skip 后计数不动、不熔断", async () => {
    await seedTask({ consecutiveFailures: 2, sessionId: "wudao-bound9" });
    const lines: string[] = [];
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => runs.length === 1);
    await poll(() => false, 50); // settle——若有熔断步，计数persist已落
    const tasks = await storedTasks();
    expect(tasks[0]!.consecutiveFailures).toBe(2); // 原值不动
    expect(tasks[0]!.enabled).toBeUndefined(); // 不熔断
    expect(lines.some((l) => l.includes("连续"))).toBe(false); // 无熔断通知
    daemon.stop();
  });
});

describe("ω99-321 D — appendRun reject → fire 流程不炸", () => {
  it("catch 吞（无未处理拒绝）；notify 已发；后续 tick 照常", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
      appendRun: async () => {
        throw new Error("disk full");
      },
      continueRun: async () => ({ started: true }),
      isBusy: () => true,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "p", sessionId: "wudao-bound1", createdFrom: "t" });
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => lines.length === 1); // 通知已发（先于 appendRun）
    await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + 20 * MIN); // 推进已落
    await poll(() => false, 120); // settle——无 catch 时此处之后是未处理拒绝（红）
    // 守护还活着：下一个到期窗口照常跳过（running 守卫已被 finally 清）。
    clock = T0 + 20 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 2);
    expect(lines[1]).toContain("会话正忙");
    daemon.stop();
  });
});

describe("ω99-321 E — lastRunsOf join（mode 透传 + 文件序最后一条胜）", () => {
  it("skipped 条目透传 mode；老条目（无 mode）零变化；异型 mode 当缺省", () => {
    const entries: unknown[] = [
      { type: "schedule_run", data: { taskId: "aaaa1111", ok: true, at: "2026-09-14T01:00:00.000Z", mode: "continue" } },
      { type: "schedule_run", data: { taskId: "aaaa1111", ok: true, at: "2026-09-14T02:00:00.000Z", mode: "skipped" } },
      { type: "schedule_run", data: { taskId: "bbbb2222", ok: false, at: "2026-09-14T03:00:00.000Z" } },
      { type: "schedule_run", data: { taskId: "cccc3333", ok: true, at: "2026-09-14T04:00:00.000Z", mode: 42 } },
    ];
    const runs = lastRunsOf(entries);
    // 同 task 两条 → 文件序最后一条（skipped）胜——重启后 join 直答「会话忙」。
    expect(runs.get("aaaa1111")).toEqual({ ok: true, at: Date.parse("2026-09-14T02:00:00.000Z"), mode: "skipped" });
    // 老条目（spawn 车道无 mode）→ 无 mode 键（不是 mode:undefined）。
    expect(runs.get("bbbb2222")).toEqual({ ok: false, at: Date.parse("2026-09-14T03:00:00.000Z") });
    // 异型 mode 当缺省——条目本身仍有效。
    expect(runs.get("cccc3333")).toEqual({ ok: true, at: Date.parse("2026-09-14T04:00:00.000Z") });
  });

  it("skipped 在前、continue 在后 → 后者胜（文件序语义对 skipped 同样成立）", () => {
    const entries: unknown[] = [
      { type: "schedule_run", data: { taskId: "dddd4444", ok: true, at: "2026-09-14T01:00:00.000Z", mode: "skipped" } },
      { type: "schedule_run", data: { taskId: "dddd4444", ok: true, at: "2026-09-14T02:00:00.000Z", mode: "continue" } },
    ];
    const runs = lastRunsOf(entries);
    expect(runs.get("dddd4444")!.mode).toBe("continue");
  });
});
