// 131 弧（zcode off-peak 引进）— defer（闲时）车道收据。
// 面一：纯层（idle 触发的形状/人话/nextRun/不补跑）；面二：daemon（物化/
// 空闲资格/一次性自删/忙不火）；面三：工具面（defer_task 盖 origin+绑定、
// 回执、闲时轮工具不可见律）；面四：spawn 车道（DEFER env + [闲时任务] 前缀）。
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  describeScheduleHuman,
  nextFireOf,
  armMissRetry,
  originResumePrompt,
  DEFER_IDLE_DEFAULT_MINUTES,
  DEFER_RUN_ENV,
  type ScheduleDaemonOptions,
} from "../src/schedules.js";
import { createScheduleTools } from "../src/schedules-tools.js";
import { validDurable } from "../src/schedules-model.js";
import { buildToolSet } from "../src/tools.js";

let ws = "";
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc131-defer-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  delete process.env[DEFER_RUN_ENV];
});

const T0 = new Date("2026-09-29T10:00:00").getTime();
const MIN = 60_000;
const idleTask = (over: Record<string, unknown> = {}) => ({
  id: "aaaaaaaa",
  schedule: { type: "idle", idleMinutes: 15 },
  prompt: "重构 utils",
  workspace: "/w",
  createdFrom: "defer_task",
  createdAt: T0,
  ...over,
});

// ---------------------------------------------------------------------------
// 面一 — 纯层
// ---------------------------------------------------------------------------
describe("131 面一 — idle 触发的纯层", () => {
  it("validDurable：接受整数窗；越界夹回 [5,120]；非整数丢任务", () => {
    expect(validDurable(idleTask())?.schedule).toEqual({ type: "idle", idleMinutes: 15 });
    expect(validDurable(idleTask({ schedule: { type: "idle", idleMinutes: 200 } }))?.schedule).toEqual({ type: "idle", idleMinutes: 120 });
    expect(validDurable(idleTask({ schedule: { type: "idle", idleMinutes: 3 } }))?.schedule).toEqual({ type: "idle", idleMinutes: 5 });
    expect(validDurable(idleTask({ schedule: { type: "idle", idleMinutes: 7.5 } }))).toBeUndefined();
  });

  it("人话：空闲 ≥15 分钟后一次", () => {
    expect(describeScheduleHuman({ type: "idle", idleMinutes: 15 })).toBe("空闲 ≥15 分钟后一次");
  });

  it("nextFireOf：物化 nextRunAt 优先；缺则 createdAt+窗（最早可火）", () => {
    expect(nextFireOf(idleTask() as never, T0 + 1)).toBe(T0 + 15 * MIN);
    expect(nextFireOf(idleTask({ nextRunAt: T0 + 40 * MIN }) as never, T0 + 1)).toBe(T0 + 40 * MIN);
  });

  it("armMissRetry：idle 一次性永不补跑", () => {
    expect(armMissRetry(idleTask() as never, T0, T0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 面二 — daemon：物化 + 空闲资格 + 一次性
// ---------------------------------------------------------------------------
const storedTasks = async (): Promise<Record<string, unknown>[]> => {
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: Record<string, unknown>[] };
  return stored.tasks;
};
const poll = async (pred: () => boolean | Promise<boolean>, ms = 8_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) return;
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe("131 面二 — daemon 的空闲资格与一次性", () => {
  it("add 物化 nextRunAt = createdAt + idleMinutes；回执带闲时语义", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "done" }),
      notify: (l) => lines.push(l),
    });
    const receipt = await daemon.add({
      schedule: { type: "idle", idleMinutes: 15 },
      prompt: "清理临时文件",
      kind: "task",
      createdFrom: "defer_task",
    });
    expect(receipt).toContain("已添加");
    expect(receipt).toContain("空闲 ≥15 分钟后一次");
    const [row] = await storedTasks();
    expect(row!.nextRunAt).toBe(T0 + 15 * MIN);
    daemon.stop();
  });

  it("钟面到点但用户未离够 → 不火；离够 + 空闲 → 火且一次性自删", async () => {
    let clock = T0;
    let lastActivity = T0; // 用户在 T0 活动过
    let fires = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => { fires += 1; return { ok: true, exitCode: 0, output: "done" }; },
      notify: () => {},
      lastActivityAt: () => lastActivity,
    } as ScheduleDaemonOptions);
    await daemon.add({ schedule: { type: "idle", idleMinutes: 15 }, prompt: "p", kind: "task", createdFrom: "t" });
    // t=T0+16min：nextRunAt(T0+15) 已过，但距最后活动仅 16... 16≥15 → 火。
    // 先测未离够：t=T0+16 但 lastActivity=T0+10（距 6min < 15min）。
    lastActivity = T0 + 10 * MIN;
    clock = T0 + 16 * MIN;
    await daemon.tick();
    expect(fires).toBe(0); // 未离够——火不消耗
    // 离够了：t=T0+26，lastActivity=T0+10（距 16min ≥ 15）。
    clock = T0 + 26 * MIN;
    await daemon.tick();
    await poll(() => fires === 1);
    expect(fires).toBe(1);
    await poll(async () => (await storedTasks()).length === 0); // 一次性自删
    daemon.stop();
  });

  it("宿主正忙 → 不火（等空闲）", async () => {
    let clock = T0;
    let fires = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => { fires += 1; return { ok: true, exitCode: 0, output: "done" }; },
      notify: () => {},
      isBusy: () => true, // 宿主永远在忙
      lastActivityAt: () => T0 - 60 * MIN, // 早已空闲
    } as ScheduleDaemonOptions);
    await daemon.add({ schedule: { type: "idle", idleMinutes: 5 }, prompt: "p", kind: "task", createdFrom: "t" });
    clock = T0 + 30 * MIN;
    await daemon.tick();
    expect(fires).toBe(0);
    daemon.stop();
  });

  it("lastActivityAt 缺席（headless）→ 钟面到点即火（降级语义）", async () => {
    let clock = T0;
    let fires = 0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => { fires += 1; return { ok: true, exitCode: 0, output: "done" }; },
      notify: () => {},
    });
    await daemon.add({ schedule: { type: "idle", idleMinutes: 5 }, prompt: "p", kind: "task", createdFrom: "t" });
    clock = T0 + 6 * MIN;
    await daemon.tick();
    await poll(() => fires === 1);
    expect(fires).toBe(1);
    daemon.stop();
  });
});

// ---------------------------------------------------------------------------
// 面三 — 工具面：defer_task + 闲时轮不可见律
// ---------------------------------------------------------------------------
describe("131 面三 — defer_task 工具面", () => {
  const fakeModel = { async generate() { return { role: "assistant" as const, content: "" }; } };

  it("defer_task 盖 origin + sessionId 绑定；入表 idle 形", async () => {
    let clock = T0;
    let added: import("../src/schedules.js").ScheduleAddInput | undefined;
    const face = {
      add: async (input: import("../src/schedules.js").ScheduleAddInput) => {
        added = input;
        return `📅 闲时任务 aaaaaaaa 已添加（空闲 ≥15 分钟后一次）· 工作区 ${ws}`;
      },
      rm: async () => "",
      listText: () => "",
      list: () => [],
      liveSessionId: () => "sess1234",
    };
    const tools = createScheduleTools(face as never);
    const defer = tools.find((t) => t.name === "defer_task");
    expect(defer).toBeDefined();
    const res = await defer!.execute({ title: "重构 utils", prompt: "把 utils 目录按模块拆分", idle_minutes: 15 });
    expect(res.isError).not.toBe(true);
    expect(added?.schedule).toEqual({ type: "idle", idleMinutes: 15 });
    expect(added?.origin).toEqual({ sessionId: "sess1234", contextHint: "重构 utils" });
    expect(added?.sessionId).toBe("sess1234");
    expect(added?.kind).toBe("task");
    expect(added?.createdFrom).toBe("defer_task");
  });

  it("缺省 idle_minutes = 15（DEFER_IDLE_DEFAULT_MINUTES）", async () => {
    let added: import("../src/schedules.js").ScheduleAddInput | undefined;
    const face = {
      add: async (input: import("../src/schedules.js").ScheduleAddInput) => { added = input; return "📅 ok"; },
      rm: async () => "", listText: () => "", list: () => [], liveSessionId: () => undefined,
    };
    const defer = createScheduleTools(face as never).find((t) => t.name === "defer_task")!;
    await defer.execute({ title: "t", prompt: "p" });
    expect(added?.schedule).toEqual({ type: "idle", idleMinutes: DEFER_IDLE_DEFAULT_MINUTES });
    expect(added?.origin).toBeUndefined(); // 无 live 会话缝 = 不盖章
  });

  it("闲时轮工具不可见律：WUDAO_DEFER_RUN=1 时排程/交棒面不挂、schedule_list 保留", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const face = { add: async () => "ok", rm: async () => "", listText: () => "", list: () => [] };
    const mk = async (): string[] => {
      const set = buildToolSet({
        workspaceRoot: ws,
        model: fakeModel as never,
        canUseTool: async () => ({ behavior: "allow" as const }),
        contextWindowTokens: 64_000,
        schedules: face as never,
      });
      return set.map((t) => t.name);
    };
    const normal = await mk();
    expect(normal).toContain("schedule_add");
    expect(normal).toContain("defer_task");
    expect(normal).toContain("continue_task");
    process.env[DEFER_RUN_ENV] = "1";
    const deferTurn = await mk();
    expect(deferTurn).not.toContain("schedule_add");
    expect(deferTurn).not.toContain("schedule_remove");
    expect(deferTurn).not.toContain("defer_task");
    expect(deferTurn).not.toContain("continue_task");
    expect(deferTurn).toContain("schedule_list"); // 只读面保留
  });
});

// ---------------------------------------------------------------------------
// 面四 — spawn 车道：[闲时任务] 前缀
// ---------------------------------------------------------------------------
describe("131 面四 — origin 前缀与 env", () => {
  it("idle 任务的 origin resume 前缀 = [闲时任务]", () => {
    const task = idleTask({ origin: { sessionId: "sess1234", contextHint: "重构 utils" } }) as never;
    expect(originResumePrompt(task)).toBe("[闲时任务] 重构 utils");
  });
  it("非 idle 的 origin 前缀照旧 [定时续跑]", () => {
    const task = idleTask({ schedule: { type: "at", at: T0 + MIN }, origin: { sessionId: "s" } }) as never;
    expect(originResumePrompt(task).startsWith("[定时续跑]")).toBe(true);
  });
});
