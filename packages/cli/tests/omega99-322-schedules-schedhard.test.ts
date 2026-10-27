// ω99-322 — schedules 健壮性双债（321 c1+c2 兑现）：
//  A) c1-continue — continue 车道 appendRun reject → fire 流程存活：notify
//     已发、advanceAfterFire 已推（nextRunAt 重算）、running 守卫已清（下一
//     tick 照常续跑）、无未处理拒绝；
//  B) c1-spawn — spawn 车道同形（continueRun 缺席、runTask 正常 resolve、
//     appendRun reject）→ 账丢一条但 notify/breaker/守卫全存活；
//  C) c1 回归 — appendRun 正常 resolve 时两车道与 main 等价（账恰一条、
//     字段全：continue 带 mode、spawn 带 exitCode/output 无 mode 键）；
//  D) c2-丢弃 — store 含 1 条坏 id（9 字符，唯一例外——测试本体）+ 1 条好
//     任务 → load 后 tasks 恰 1 条、discardedAtLoad===1、起动 notify 恰一条
//     且含「1」与「已忽略」；
//  E) c2-全好 — 全合法 store → discardedAtLoad===0、零 notify；
//  F) c2-缺文件/边界 — 文件缺席 → 零 notify（missing → empty store 既有
//     语义不变）；整文件 JSON 解析失败同样零计数零 notify（边界如实钉）。
// 夹具全在 mkdtemp(os.tmpdir())——红线：绝不触碰用户文件。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  loadSchedulesStore,
} from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om322-hard-"));
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

/** Direct-store seed of ARBITRARY rows（daemon 创建前落表——守护在创建时采纳；
 * 行由调用方给全形状，坏行是 c2 的测试本体）。 */
const seedRows = async (rows: Record<string, unknown>[]): Promise<void> => {
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(join(ws, ".wudao", "schedules.json"), JSON.stringify({ version: 1, tasks: rows }), "utf8");
};

type RunEntry = { type: string; data: Record<string, unknown> };

describe("ω99-322 A — c1-continue：appendRun reject → fire 流程存活", () => {
  it("catch 吞（无未处理拒绝）；notify 已发；advance 已落；下一 tick 照常", async () => {
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
      isBusy: () => false,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "续跑我", sessionId: "wudao-cont001", createdFrom: "t" });
    const id = await oneId();
    await daemon.tick(T0 + 10 * MIN);
    // notify 先于 appendRun（continue 车道序）——账 reject 时通知必已发。
    await poll(() => lines.length === 1);
    expect(lines[0]).toContain(id);
    expect(lines[0]).toContain("接着上次的会话继续跑");
    // advanceAfterFire 仍推一格（occurrence consumed——账丢了计划不丢）。
    await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + 20 * MIN);
    await poll(() => false, 120); // settle——无 catch 时此处之后是未处理拒绝（红）
    // 守护还活着：下一窗口照常续跑（running 守卫已被 finally 清）。
    clock = T0 + 20 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 2);
    expect(lines[1]).toContain("接着上次的会话继续跑");
    daemon.stop();
  });
});

describe("ω99-322 B — c1-spawn：appendRun reject → 账丢一条、其余全存活", () => {
  it("catch 吞；notify/breaker/advance 已落；下一 tick 照常", async () => {
    let clock = T0;
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
      appendRun: async () => {
        throw new Error("disk full");
      },
      // continueRun 缺席 + 无 sessionId → spawn 车道
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "跑我", createdFrom: "t" });
    const id = await oneId();
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => lines.length === 1); // 跑成通知已发（先于 appendRun）
    expect(lines[0]).toContain("✅");
    expect(lines[0]).toContain(id);
    await poll(async () => (await storedTasks())[0]!.nextRunAt === T0 + 20 * MIN); // advance 已落
    await poll(async () => (await storedTasks())[0]!.consecutiveFailures === 0); // breakerStep 已落（成功清零）
    await poll(() => false, 120); // settle——无 catch 时此处之后是未处理拒绝（红）
    clock = T0 + 20 * MIN;
    await daemon.tick();
    await poll(() => lines.length === 2); // 守卫已清，下一 tick 照常
    daemon.stop();
  });
});

describe("ω99-322 C — c1 回归：appendRun 正常 resolve → 两车道账面与 main 等价", () => {
  it("continue 车道：账恰一条、全形状（mode=continue、ok=true、prompt 帽 200）", async () => {
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "spawned" }),
      notify: () => {},
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
      continueRun: async () => ({ started: true }),
      isBusy: () => false,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "长".repeat(260), sessionId: "wudao-free001", createdFrom: "t" });
    const id = await oneId();
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => runs.length === 1);
    expect(runs.length).toBe(1); // 恰一条
    expect(runs[0]!.type).toBe("schedule_run");
    expect(runs[0]!.data).toEqual({
      taskId: id,
      prompt: "长".repeat(200),
      workspace: ws,
      ok: true,
      at: new Date(T0 + 10 * MIN).toISOString(),
      mode: "continue",
      triggeredBy: "cron",
    });
    daemon.stop();
  });

  it("spawn 车道：账恰一条、全形状（exitCode/output 在、无 mode 键）", async () => {
    const runs: RunEntry[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "done-line" }),
      notify: () => {},
      appendRun: async (entry) => { runs.push(entry as RunEntry); },
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 10 * MIN }, prompt: "长".repeat(260), createdFrom: "t" });
    const id = await oneId();
    await daemon.tick(T0 + 10 * MIN);
    await poll(() => runs.length === 1);
    expect(runs.length).toBe(1); // 恰一条
    expect(runs[0]!.type).toBe("schedule_run");
    expect(runs[0]!.data).toEqual({
      taskId: id,
      prompt: "长".repeat(200),
      workspace: ws,
      ok: true,
      exitCode: 0,
      at: new Date(T0 + 10 * MIN).toISOString(),
      output: "done-line",
      triggeredBy: "cron",
    });
    daemon.stop();
  });
});

describe("ω99-322 D — c2-丢弃：坏行不再无声消失（计数 + 起动通知）", () => {
  it("1 坏 id（9 字符）+ 1 好任务 → tasks 恰 1、discardedAtLoad===1、notify 恰一条含「1」", async () => {
    await seedRows([
      {
        id: "good0001",
        schedule: { type: "every", intervalMs: 10 * MIN },
        prompt: "好任务",
        workspace: ws,
        createdFrom: "test",
        createdAt: T0,
        nextRunAt: T0 + 10 * MIN, // 未来——起动 boot tick 不触发（notify 计数独占）
      },
      {
        id: "bad9char0", // 9 字符——validDurable 拒（321 亲踩形）
        schedule: { type: "every", intervalMs: 10 * MIN },
        prompt: "坏任务",
        workspace: ws,
        createdFrom: "test",
        createdAt: T0,
        nextRunAt: T0 + 10 * MIN,
      },
    ]);
    // 面一：直接 load——字段级（好行存活、坏行被数出来）。
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(store.tasks.length).toBe(1);
    expect(store.tasks[0]!.id).toBe("good0001");
    expect(store.discardedAtLoad).toBe(1);
    // 面二：daemon 起动——通知通道恰一条（具体计数 + 「已忽略」语义）。
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
    });
    expect(lines.length).toBe(1); // 恰一条
    expect(lines[0]).toContain("1 条");
    expect(lines[0]).toContain("已忽略");
    await poll(() => false, 60); // settle——boot tick 不加通知（好任务未到期）
    expect(lines.length).toBe(1);
    daemon.stop();
  });
});

describe("ω99-322 E — c2-全好：合法 store 零计数零通知", () => {
  it("全合法 → discardedAtLoad===0、零 notify", async () => {
    await seedRows([
      {
        id: "fine0001",
        schedule: { type: "every", intervalMs: 10 * MIN },
        prompt: "合法任务",
        workspace: ws,
        createdFrom: "test",
        createdAt: T0,
        nextRunAt: T0 + 10 * MIN,
      },
    ]);
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(store.tasks.length).toBe(1);
    expect(store.discardedAtLoad).toBe(0);
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
    });
    await poll(() => false, 60); // settle
    expect(lines.length).toBe(0);
    daemon.stop();
  });
});

describe("ω99-322 F — c2-缺文件与解析失败边界：零通知（既有语义不变）", () => {
  it("文件缺席 → empty store、discardedAtLoad===0、零 notify", async () => {
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(store.tasks.length).toBe(0);
    expect(store.discardedAtLoad).toBe(0);
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
    });
    await poll(() => false, 60); // settle
    expect(lines.length).toBe(0);
    daemon.stop();
  });

  it("整文件 JSON 解析失败 → 空 tasks、零计数零 notify（连 tasks 数组都拿不到——如实边界）", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    await writeFile(join(ws, ".wudao", "schedules.json"), "{ not json", "utf8");
    const store = await loadSchedulesStore({ workspaceRoot: ws, env: {} });
    expect(store.tasks.length).toBe(0);
    expect(store.discardedAtLoad).toBe(0);
    const lines: string[] = [];
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: async () => ({ ok: true, exitCode: 0, output: "ok" }),
      notify: (line) => { lines.push(line); },
    });
    await poll(() => false, 60); // settle
    expect(lines.length).toBe(0);
    daemon.stop();
  });
});
