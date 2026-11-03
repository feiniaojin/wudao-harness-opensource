// ω99-317 — driver 侧管理面三写 + 读面 join（web schedulesSetEnabled /
// schedulesRemove / schedulesRunNow 三个 op 的进程内落点）：
//  1) 三方法全部路由 o.schedule（进程内 daemon 唯一所有者——直写 store 会被
//     守护的下一次 persist 覆盖）；回执联合 {ok,message}，ok = 回执不以 ⚠️ 开头
//     （createScheduleTools 同判）；
//  2) 无 daemon（REPL/headless 形 driver）→ {ok:false} 诚实指路 wudao ui；
//  3) schedulesList 读面加性补：join「上次运行」（.wudao/sessions/schedules.jsonl
//     的 schedule_run 条目，文件序最后一条胜——用 store 自身 appendEntry 产生
//     canonical 文件，不手写行）。
// 夹具全在 mkdtemp(os.tmpdir())——红线：绝不触碰用户文件。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore, type ModelClient, type ModelInput } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createScheduleDaemon, SCHEDULES_SESSION_ID } from "../src/schedules.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om317-drv-"));
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

const seedStore = async (over: Record<string, unknown> = {}): Promise<void> => {
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(
    join(ws, ".wudao", "schedules.json"),
    JSON.stringify({
      version: 1,
      tasks: [
        {
          id: "manage01",
          schedule: { type: "every", intervalMs: 10 * MIN },
          prompt: "每天整理收件箱",
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

/** The no-op model — no op here ever submits; the driver only needs to stand up. */
const idleModel: ModelClient = {
  async generate(_input: ModelInput) {
    throw new Error("no model call expected in this file");
  },
};

interface Rig {
  readonly driver: ReturnType<typeof createAgentDriver>;
  readonly daemon: Awaited<ReturnType<typeof createScheduleDaemon>>;
  readonly schedulesLog: ReturnType<typeof createJsonlSessionStore>;
  readonly spawns: { count: number };
  readonly busy: { flag: boolean };
}

const makeRig = async (over: Record<string, unknown> = {}): Promise<Rig> => {
  await seedStore(over);
  const spawns = { count: 0 };
  const busy = { flag: false };
  const schedulesLog = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
  const daemon = await createScheduleDaemon({
    workspaceRoot: ws,
    now: () => T0,
    tickMs: 0,
    env: {},
    runTask: async () => {
      spawns.count += 1;
      return { ok: true, exitCode: 0, output: "done" };
    },
    appendRun: async (entry) => {
      await schedulesLog.appendEntry(SCHEDULES_SESSION_ID, entry);
    },
    isBusy: () => busy.flag,
  });
  const driver = createAgentDriver({
    model: idleModel,
    tools: [],
    systemPrompt: "s",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    schedule: daemon,
  });
  return { driver, daemon, schedulesLog, spawns, busy };
};

describe("ω99-317 E — driver 管理面三写（路由 daemon，回执联合 {ok,message}）", () => {
  it("schedulesSetEnabled(false/true) → pause/unpause 路由：paused 位落 store，回执 ok:true 原样中继", async () => {
    const rig = await makeRig();
    const paused = await rig.driver.schedulesSetEnabled("manage01", false);
    expect(paused.ok).toBe(true);
    expect(paused.message).toContain("已暂停");
    await poll(async () => (await storedTasks())[0]!.paused === true);
    const resumed = await rig.driver.schedulesSetEnabled("manage01", true);
    expect(resumed.ok).toBe(true);
    expect(resumed.message).toContain("已恢复");
    await poll(async () => (await storedTasks())[0]!.paused === undefined);
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("schedulesRemove → 调度条目从 store 消失（只动 .wudao 内部状态，零用户文件）", async () => {
    const rig = await makeRig();
    const removed = await rig.driver.schedulesRemove("manage01");
    expect(removed.ok).toBe(true);
    await poll(async () => (await storedTasks()).length === 0);
    // unknown id → daemon 收敛回执（313 的 rm not-found 旧形无 ⚠️ 前缀——
    // 185 钉不动；原样中继即收敛，面板按 message 展示 + refetch 行已消失）。
    const missing = await rig.driver.schedulesRemove("nosuchid");
    expect(missing.message).toContain("无持久任务");
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("schedulesRunNow：快乐径 ok:true；绑定会话忙 → ok:false（busy 守卫穿透 driver 路由）", async () => {
    const rig = await makeRig({ sessionId: "wudao-o317busy" });
    rig.busy.flag = true;
    const refused = await rig.driver.schedulesRunNow("manage01");
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("会话正在跑");
    expect(rig.spawns.count).toBe(0);
    rig.busy.flag = false;
    const ran = await rig.driver.schedulesRunNow("manage01");
    expect(ran.ok).toBe(true);
    expect(ran.message).toContain("已立即启动");
    await poll(() => rig.spawns.count === 1);
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("schedulesRunNow resetBreaker → 熔断任务重开（计数清零 + enabled 复位）后立即跑", async () => {
    const rig = await makeRig({ enabled: false, consecutiveFailures: 3 });
    const receipt = await rig.driver.schedulesRunNow("manage01", { resetBreaker: true });
    expect(receipt.ok).toBe(true);
    expect(receipt.message).toContain("已重新打开");
    await poll(() => rig.spawns.count === 1);
    await poll(async () => {
      const t = (await storedTasks())[0]!;
      return t.enabled === undefined && t.consecutiveFailures === 0;
    });
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("无 daemon（headless 形 driver）→ 三方法 {ok:false} 诚实指路 wudao ui，store 零变化", async () => {
    await seedStore();
    const driver = createAgentDriver({
      model: idleModel,
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ws,
      // no `schedule` — the REPL/headless shape
    });
    const a = await driver.schedulesSetEnabled("manage01", false);
    const b = await driver.schedulesRemove("manage01");
    const c = await driver.schedulesRunNow("manage01");
    for (const r of [a, b, c]) {
      expect(r.ok).toBe(false);
      expect(r.message).toContain("wudao ui");
      expect(r.message).toMatch(/⚠️/);
    }
    expect((await storedTasks()).length).toBe(1); // nothing written
    driver.dispose();
  });
});

describe("ω99-317 F — schedulesList 读面 join（上次运行，schedules 会话日志）", () => {
  it("同一 task 两条运行（败→成）：行带 lastRun={ok:true}（文件序最后一条胜）", async () => {
    const rig = await makeRig();
    await rig.schedulesLog.appendEntry(SCHEDULES_SESSION_ID, {
      type: "schedule_run",
      data: { taskId: "manage01", ok: false, at: "2026-09-14T01:00:00.000Z", triggeredBy: "cron" },
    });
    await rig.schedulesLog.appendEntry(SCHEDULES_SESSION_ID, {
      type: "schedule_run",
      data: { taskId: "manage01", ok: true, at: "2026-09-14T02:00:00.000Z", triggeredBy: "cron" },
    });
    const rows = await rig.driver.schedulesList();
    expect(rows.length).toBe(1);
    expect(rows[0]!.lastRun).toEqual({ ok: true, at: Date.parse("2026-09-14T02:00:00.000Z") });
    // The engine-side additive fields ride too (行加性补的 driver 面).
    expect(rows[0]!.lastFiredAt).toBeNull();
    expect(rows[0]!.consecutiveFailures).toBe(0);
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("无日志文件 → lastRun=null（面显示「还没跑过」，不是缺字段）", async () => {
    const rig = await makeRig();
    const rows = await rig.driver.schedulesList();
    expect(rows[0]!.lastRun).toBeNull();
    rig.driver.dispose();
    rig.daemon.stop();
  });

  it("日志存在但无此 task 的条目 → 该行 lastRun=null", async () => {
    const rig = await makeRig();
    await rig.schedulesLog.appendEntry(SCHEDULES_SESSION_ID, {
      type: "schedule_run",
      data: { taskId: "othertask", ok: true, at: "2026-09-14T03:00:00.000Z", triggeredBy: "cron" },
    });
    const rows = await rig.driver.schedulesList();
    expect(rows[0]!.lastRun).toBeNull();
    rig.driver.dispose();
    rig.daemon.stop();
  });
});
