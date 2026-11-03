// 127 项 2/3（F1/F2，docs/research/127-cross-session-chaining.md §3.6）—
// F1: origin 车道占用探测——origin 会话被活租约占用时本次火跳过（通知 +
// 台账 mode="skipped"），绝不 spawn 全新子进程白烧熔断计数；`at` 一次性火
// 有界重排（+2min 帽 5），循环火走自然节律；占用解除后正常 resume。
// F2: sessionId 绑定任务的 continue 被拒（占用/损坏）不再静默降级 -p 全新
// 会话——通知 + 台账披露；settled 尾是绑定语义的既有回落，不算拒绝。
// 附：daemon.list()（continue_task 幂等扫描的结构化真相）与 continue_task
// 的挂载面（buildToolSet 紧跟 schedules 三件套；缺缝零表面）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleDaemon } from "../src/schedules.js";
import type { ScheduleDaemonOptions, ScheduleContinueRefusal } from "../src/schedules.js";
import {
  SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS,
  SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP,
} from "../src/schedules-model.js";
import type { DurableTask } from "../src/schedules-model.js";
import { buildToolSet } from "../src/tools.js";
import { continueTaskPrompt } from "@wudao-org/core";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "sched-127-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-27T03:00:00Z");
const MIN = 60_000;
const RETRY = SCHEDULE_ORIGIN_OCCUPIED_RETRY_MS;

/** Poll until cond or deadline (the daemon's fire bookkeeping is async-void
 *  with real fs I/O — m61's flake lesson, schedules-origin-121 同款). */
async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 25));
  }
}

interface Harness {
  readonly daemon: Awaited<ReturnType<typeof createScheduleDaemon>>;
  readonly seen: DurableTask[];
  readonly log: { readonly type: string; readonly data: Record<string, unknown> }[];
  readonly notifications: string[];
  setClock: (t: number) => void;
  setOccupied: (v: boolean) => void;
}

const harness = async (over: Partial<ScheduleDaemonOptions> = {}): Promise<Harness> => {
  let clock = T0;
  let occupied = false;
  const seen: DurableTask[] = [];
  const log: { type: string; data: Record<string, unknown> }[] = [];
  const notifications: string[] = [];
  const base: ScheduleDaemonOptions = {
    workspaceRoot: ws,
    now: () => clock,
    tickMs: 0,
    env: {},
    runTask: async (t) => {
      seen.push(t);
      return { ok: true, exitCode: 0, output: "ok" };
    },
    appendRun: async (entry) => {
      log.push(entry as { type: string; data: Record<string, unknown> });
    },
    notify: (line) => notifications.push(line),
    originSessionExists: () => true,
    originSessionOccupied: async () => occupied,
  };
  const daemon = await createScheduleDaemon({ ...base, ...over });
  return {
    daemon,
    seen,
    log,
    notifications,
    setClock: (t) => { clock = t; },
    setOccupied: (v) => { occupied = v; },
  };
};

describe("F1 — origin 车道占用探测", () => {
  it("占用 → 跳过本次火：不 spawn、台账 mode=skipped、`at` 火重排 +2min、熔断不吃", async () => {
    const h = await harness();
    h.setOccupied(true);
    const add = await h.daemon.add({
      schedule: { type: "at", at: T0 + MIN },
      prompt: "[接力] 继续任务 abcd0001",
      createdFrom: "continue_task",
      origin: { sessionId: "wudao-occ1", contextHint: "继续任务 abcd0001" },
    });
    expect(add).toContain("已添加");
    h.setClock(T0 + 2 * MIN); // due
    await h.daemon.tick();
    await until(() => h.log.length === 1);
    expect(h.seen).toHaveLength(0); // 绝不 spawn 全新子进程
    expect(h.log[0]!.data.mode).toBe("skipped");
    expect(h.log[0]!.data.originOccupied).toBe(true);
    expect(h.notifications.some((n) => n.includes("origin 会话正被占用，跳过本次火"))).toBe(true);
    // 有界重排：债还在（行不自删），nextRunAt 拨到 now+2min
    const row = h.daemon.list().find((t) => t.prompt.includes("abcd0001"))!;
    expect(row).toBeDefined();
    expect(row.nextRunAt).toBe(T0 + 2 * MIN + RETRY);
    // 熔断不吃：连续失败计数根本没动（未推进），任务未停用
    expect(row.consecutiveFailures).toBeUndefined();
    expect(row.enabled).toBeUndefined();
    h.daemon.stop();
  });

  it("占用解除 → 重排后的下一火正常 origin-resume（计数清零、台账 originResume）", async () => {
    const h = await harness();
    h.setOccupied(true);
    await h.daemon.add({
      schedule: { type: "at", at: T0 + MIN },
      prompt: "[接力] 继续任务 abcd0001",
      createdFrom: "continue_task",
      origin: { sessionId: "wudao-occ2" },
    });
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick(); // skip #1 → nextRunAt = +2min
    await until(() => h.log.length === 1);
    h.setOccupied(false);
    h.setClock(T0 + 2 * MIN + RETRY + 1000);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 2);
    expect(h.seen[0]!.origin).toEqual({ sessionId: "wudao-occ2" }); // resume-shaped task reached the runner
    expect(h.log[1]!.data.originResume).toBe("wudao-occ2");
    expect(h.daemon.list().some((t) => t.prompt.includes("abcd0001"))).toBe(false); // fired at one-shot self-deleted
    h.daemon.stop();
  });

  it("循环火（every）占用跳过走自然节律：occurrence 消耗、nextRunAt=fire+interval，不重排", async () => {
    const h = await harness();
    h.setOccupied(true);
    await h.daemon.add({
      schedule: { type: "every", intervalMs: 60 * MIN },
      prompt: "check the build",
      createdFrom: "test",
      origin: { sessionId: "wudao-occ3" },
    });
    // every 行在 add 时物化 nextRunAt = createdAt + intervalMs = T0 + 60min
    const fireAt = T0 + 61 * MIN;
    h.setClock(fireAt);
    await h.daemon.tick();
    await until(() => h.log.length === 1);
    expect(h.seen).toHaveLength(0);
    expect(h.log[0]!.data.mode).toBe("skipped");
    const row = h.daemon.list().find((t) => t.prompt === "check the build")!;
    expect(row.nextRunAt).toBe(fireAt + 60 * MIN); // 自然节律：fire 时间 + interval（不是 +2min 重排）
    h.daemon.stop();
  });

  it("连续占用到帽（5 次重排后第 6 次）→ 放弃：行消耗（at 自删）、诚实通知", async () => {
    const h = await harness();
    h.setOccupied(true);
    await h.daemon.add({
      schedule: { type: "at", at: T0 + MIN },
      prompt: "[接力] 继续任务 abcd0001",
      createdFrom: "continue_task",
      origin: { sessionId: "wudao-occ4" },
    });
    let clock = T0 + 2 * MIN;
    for (let i = 1; i <= SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP; i += 1) {
      h.setClock(clock);
      await h.daemon.tick();
      await until(() => h.log.length === i);
      expect(h.daemon.list().some((t) => t.prompt.includes("abcd0001"))).toBe(true); // 债还在
      clock += RETRY + 1000;
    }
    // 第 6 次：skips = cap+1 → 放弃
    h.setClock(clock);
    await h.daemon.tick();
    await until(() => h.log.length === SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP + 1);
    expect(h.seen).toHaveLength(0);
    expect(h.daemon.list().some((t) => t.prompt.includes("abcd0001"))).toBe(false); // 火被消耗（at 自删）
    expect(h.notifications.some((n) => n.includes("已放弃本次接力"))).toBe(true);
    expect(h.log[SCHEDULE_ORIGIN_OCCUPIED_SKIP_CAP]!.data.originSkipGaveUp).toBe(true);
    h.daemon.stop();
  });

  it("手动火（runNow）不探测占用——用户显式要求，尝试本身是诚实路径", async () => {
    const h = await harness();
    h.setOccupied(true);
    await h.daemon.add({
      schedule: { type: "every", intervalMs: 60 * MIN },
      prompt: "manual probe",
      createdFrom: "test",
      origin: { sessionId: "wudao-occ5" },
    });
    const row = h.daemon.list().find((t) => t.prompt === "manual probe")!;
    await h.daemon.runNow(row.id);
    await until(() => h.seen.length === 1);
    expect(h.seen[0]!.origin).toEqual({ sessionId: "wudao-occ5" });
    h.daemon.stop();
  });
});

describe("F2 — 绑定降级诚实化", () => {
  const boundHarness = (refused: ScheduleContinueRefusal | "throw"): Harness =>
    harness({
      continueRun: async () => {
        if (refused === "throw") throw new Error("seam blew up");
        return { started: false, refused };
      },
    });

  const addBound = async (h: Harness): Promise<void> => {
    const add = await h.daemon.add({
      schedule: { type: "at", at: T0 + MIN },
      prompt: "keep building",
      createdFrom: "test",
      sessionId: "wudao-bound1",
    });
    expect(add).toContain("已添加");
  };

  it("continue 被拒（busy）→ 通知「续跑被拒（占用），改为全新 spawn」+ 台账披露，不再静默", async () => {
    const h = await boundHarness("busy");
    await addBound(h);
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 1);
    expect(h.seen[0]!.prompt).toBe("keep building"); // spawn lane DID run (the degrade)
    expect(h.notifications.some((n) => n.includes("绑定会话 wudao-bo") && n.includes("续跑被拒（占用）") && n.includes("全新 spawn"))).toBe(true);
    expect(h.log[0]!.data.boundContinueRefused).toBe("busy");
    h.daemon.stop();
  });

  it("continue 被拒（not_found=损坏/不可读）→ 通知与台账同样披露", async () => {
    const h = await boundHarness("not_found");
    await addBound(h);
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 1);
    expect(h.notifications.some((n) => n.includes("续跑被拒（损坏或不可读）"))).toBe(true);
    expect(h.log[0]!.data.boundContinueRefused).toBe("not_found");
    h.daemon.stop();
  });

  it("settled 尾不算拒绝——绑定语义的既有回落（无通知、无台账字段）", async () => {
    const h = await boundHarness("settled");
    await addBound(h);
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 1);
    expect(h.notifications.some((n) => n.includes("绑定会话"))).toBe(false);
    expect("boundContinueRefused" in h.log[0]!.data).toBe(false);
    h.daemon.stop();
  });

  it("seam 抛异常 → 未知成因也披露（占用或损坏），不静默", async () => {
    const h = await boundHarness("throw");
    await addBound(h);
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 1);
    expect(h.notifications.some((n) => n.includes("续跑被拒（占用或损坏）"))).toBe(true);
    expect(h.log[0]!.data.boundContinueRefused).toBe("unknown");
    h.daemon.stop();
  });

  it("无宿主 seam（continueRun 缺席）→ 结构性全新 spawn 保持静默（既有设计，非降级）", async () => {
    const h = await harness(); // no continueRun seam
    await addBound(h);
    h.setClock(T0 + 2 * MIN);
    await h.daemon.tick();
    await until(() => h.seen.length === 1 && h.log.length === 1);
    expect(h.notifications.some((n) => n.includes("绑定会话"))).toBe(false);
    expect("boundContinueRefused" in h.log[0]!.data).toBe(false);
    h.daemon.stop();
  });
});

describe("127 项 1 — daemon.list() 与 continue_task 挂载面", () => {
  it("daemon.list() reports the live table (the idempotency scan's truth)", async () => {
    const h = await harness();
    await h.daemon.add({
      schedule: { type: "at", at: T0 + MIN },
      prompt: continueTaskPrompt("abcd0001"),
      createdFrom: "continue_task",
      origin: { sessionId: "wudao-live1" },
    });
    const rows = h.daemon.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdFrom).toBe("continue_task");
    expect(rows[0]!.origin).toEqual({ sessionId: "wudao-live1" });
    // the store file agrees (the daemon is the single writer)
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: DurableTask[] };
    expect(stored.tasks).toHaveLength(1);
    h.daemon.stop();
  });

  it("buildToolSet: schedules 面带 list → continue_task 挂载在 schedules 三件套之后（live 会话缝执行时读）", async () => {
    const face = {
      add: async (input: unknown) => {
        void input;
        return "📅 ok";
      },
      rm: async () => "",
      listText: () => "",
      list: () => [] as { id: string; createdFrom: string; prompt: string; schedule: { type: string; at?: number } }[],
    } as never as Parameters<typeof buildToolSet>[0]["schedules"];
    const tools = buildToolSet({
      workspaceRoot: ws,
      model: { modelId: "m", generate: async () => ({ role: "assistant", content: "x" }) } as never,
      canUseTool: async () => ({ behavior: "allow" }) as never,
      contextWindowTokens: 100_000,
      schedules: face,
    });
    const names = tools.map((t) => t.name);
    const iRemove = names.indexOf("schedule_remove");
    const iContinue = names.indexOf("continue_task");
    expect(iRemove).toBeGreaterThanOrEqual(0);
    expect(iContinue).toBe(iRemove + 2); // 131：defer_task 插在中间（schedules 族内 append-only）
    const tool = tools.find((t) => t.name === "continue_task")!;
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.isConcurrencySafe?.({})).toBe(false);
    expect(tool.isDestructive?.({})).toBe(false);
    // 晚绑纪律：liveSessionId 在工具集构建之后才绑上（ui.ts 宿主的真实顺序），
    // 绑好前的调用 fail-closed 拒答，绑好后的调用正常走 resume 车道。
    const lateBound: { liveSessionId?: () => string | undefined } = face as { liveSessionId?: () => string | undefined };
    const args = { task_id: "abcd0001", handoff: "h" };
    const refused = await tool.execute(args);
    expect(refused.isError).toBe(true); // seam 未绑 → 拒，不静默
    lateBound.liveSessionId = () => "wudao-mount1";
    const ok = await tool.execute(args);
    expect(ok.isError).toBeFalsy();
    expect(ok.content).toContain("已安排任务 abcd0001");
  });

  it("缺缝零表面：无 list 或无 schedules → continue_task 不挂载（既有字节不变）", () => {
    const base = {
      workspaceRoot: ws,
      model: { modelId: "m", generate: async () => ({ role: "assistant", content: "x" }) } as never,
      canUseTool: async () => ({ behavior: "allow" }) as never,
      contextWindowTokens: 100_000,
    };
    const noList = buildToolSet({
      ...base,
      schedules: { add: async () => "📅 ok", rm: async () => "", listText: () => "", liveSessionId: () => "wudao-mount1" },
    });
    expect(noList.some((t) => t.name === "continue_task")).toBe(false);
    const noSchedules = buildToolSet({ ...base });
    expect(noSchedules.some((t) => t.name === "continue_task")).toBe(false);
    expect(noSchedules.some((t) => t.name === "schedule_add")).toBe(false);
  });
});
