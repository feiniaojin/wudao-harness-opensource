// ω99-115 — foreign-task adoption（A 半：cli 侧收养）. RED-first.
// 弧门：「今晚对宠物说一句『明早9点提醒我X』，中途关过 app，明早打开宠物
// 照样把提醒送到脸上。」——桌面冷启动恒 fresh session，旧任务变 foreign，
// 现状 due 循环 `sessionId !== sessionId continue` 一律跳过 → 链路静默哑火。
//
// 语义边界（brief 裁决，钉在此处）：
// ① 收养=「这条提醒的主人已经不在了，我现在接手送」。并发角落（两个 wudao
//    进程同工作区、其一持有该任务）：reload 复核把双发窗压到 ≤tick 间隔，
//    但不归零——v1 接受（双发=两个气泡，one-shot 首个 persist 后自删；
//    真实病例出现再加 #48 lease 守卫=触发判据门控）。
// ② 收养不查 CRON_TASK_CAP_PER_SESSION（cap 是创建时防模型刷量，不是运行时
//    不变量；收养被 cap 拦=提醒静默死，更糟）。
// ③ 收养只发生在「任务已经 due」的时刻——live foreign 会话的未来任务不被抢
//    （它的主人还可能自己触发）；主人死了的未来任务在其 due 的首个 tick 被
//    本进程接手（覆盖「8:50 开 app、9:00 到点」：9:00 的 tick 里它
//    due+foreign→收养→触发）。
// ④ inert runtime（disabled/symlink refused）零改动零收养。
// ⑤ expiry-final 与 one-shot 自删语义照旧作用于被收养任务。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadCronStore,
  CRON_TASK_CAP_PER_SESSION,
  CRON_EXPIRY_MS,
  type CronTask,
} from "@wudao/core";
import { createCronRuntime } from "../src/cron.js";

const at = (iso: string): number => new Date(iso).getTime();
const MIN = 60_000;
// 09:00 建 runtime（startup tick 无 due）；09:23/09:15 的 one-shot（分钟数
// 非 :00/:30 → 早抖动为 0，fireAt 确定性）；09:30 显式 tick 收养。
const BASE = at("2026-09-07T09:00:00");
const TICK = at("2026-09-07T09:30:00");
const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w115-cron-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** one-shot（分钟非 :00/:30 → fireAt=at 无抖动），createdAt 早于 at。 */
const oneshot = (id: string, sessionId: string, atTime: number): CronTask => ({
  id,
  sessionId,
  prompt: `提醒_${id}`,
  schedule: { type: "at", at: atTime },
  createdAt: atTime - 10 * MIN,
});

async function runtimeWith(
  tasks: readonly CronTask[],
  sessionId = "s-live",
  clock: () => number = () => BASE,
): Promise<ReturnType<typeof createCronRuntime> extends Promise<infer R> ? R : never> {
  await mkdir(join(ws, ".wudao"), { recursive: true });
  await writeFile(join(ws, ".wudao", "cron.json"), JSON.stringify({ version: 1, tasks }), "utf8");
  return createCronRuntime({ workspaceRoot: ws, sessionId, tickMs: 0, now: clock });
}

const storeTasks = async (): Promise<CronTask[]> =>
  (JSON.parse(await readFile(join(ws, ".wudao", "cron.json"), "utf8")) as { tasks: CronTask[] }).tasks;

describe("ω99-115 A — foreign 任务收养", () => {
  it("foreign due 任务：tick 后被改绑+入队+store 里 sessionId 更新（两个 due 一并收养；改绑后 list 可见）", async () => {
    let clock = BASE;
    const rt = await runtimeWith(
      [oneshot("aaaa0001", "dead-session", at("2026-09-07T09:23:00")), oneshot("aaaa0002", "dead-session", at("2026-09-07T09:15:00"))],
      "s-live",
      () => clock,
    );
    clock = TICK;
    const fires = await rt.tick();
    expect(fires.length).toBe(2);
    expect(rt.pending().length).toBe(2);
    // 改绑落到 store（立即 persist，不等 drain）
    const disk = await storeTasks();
    expect(disk.map((t) => t.sessionId).sort()).toEqual(["s-live", "s-live"]);
    // 改绑后进入本会话可见表（工具/命令照常看得见）
    expect(rt.list().map((t) => t.id).sort()).toEqual(["aaaa0001", "aaaa0002"]);
    rt.stop();
  });

  it("foreign 非 due（未来任务）：零动作——不入队、store 原样（边界③：不抢 live foreign 会话的未来任务）", async () => {
    let clock = BASE;
    const rt = await runtimeWith([oneshot("bbbb0001", "dead-session", at("2026-09-07T11:11:00"))], "s-live", () => clock);
    clock = TICK;
    const fires = await rt.tick();
    expect(fires.length).toBe(0);
    expect(rt.pending().length).toBe(0);
    const disk = await storeTasks();
    expect(disk.length).toBe(1);
    expect(disk[0]!.sessionId).toBe("dead-session");
    expect(rt.list().length).toBe(0);
    rt.stop();
  });

  it("同 id（本会话）任务照旧触发：own due 与 foreign due 同 tick 各自入队（resume/--continue 路径零变化）", async () => {
    let clock = BASE;
    const rt = await runtimeWith(
      [oneshot("cccc0001", "s-live", at("2026-09-07T09:23:00")), oneshot("cccc0002", "dead-session", at("2026-09-07T09:23:00"))],
      "s-live",
      () => clock,
    );
    clock = TICK;
    const fires = await rt.tick();
    expect(fires.map((f) => f.task.id).sort()).toEqual(["cccc0001", "cccc0002"]);
    expect(fires.every((f) => f.injection.startsWith("[scheduled task "))).toBe(true);
    rt.stop();
  });

  it("reload 复核：他进程已触发（lastFiredAt 新）→ 不收养不双发，store 原样（边界①的复核半边）", async () => {
    let clock = BASE;
    // 每 30m 的 recurring，createdAt=08:45 → 按内存快照 fireAt=09:15+抖动(≤15m)
    // ∈[09:15,09:30]：startup tick(09:00) 未 due，显式 tick(10:30) due。
    const task: CronTask = {
      id: "dddd0001",
      sessionId: "dead-session",
      prompt: "每半小时检查",
      schedule: { type: "interval", everyMs: 30 * MIN },
      createdAt: at("2026-09-07T08:45:00"),
    };
    const rt = await runtimeWith([task], "s-live", () => clock);
    // 他进程（另一 store 句柄）已触发并落盘：lastFiredAt=10:29 → 重读后
    // fireAt=10:59+抖动 > 10:30 → 不再 due。
    const external = await loadCronStore({ workspaceRoot: ws });
    await external.save([{ ...task, lastFiredAt: at("2026-09-07T10:29:00") }]);
    clock = at("2026-09-07T10:30:00");
    const fires = await rt.tick();
    expect(fires.length).toBe(0);
    expect(rt.pending().length).toBe(0);
    const disk = await storeTasks();
    expect(disk.length).toBe(1);
    expect(disk[0]!.sessionId).toBe("dead-session"); // 未被改绑
    expect(disk[0]!.lastFiredAt).toBe(at("2026-09-07T10:29:00")); // 他进程的记录未被覆盖
    rt.stop();
  });

  it("cap 满 → 照样收养（边界②：cap 是创建时防线，不是运行时不变量）", async () => {
    let clock = BASE;
    const own: CronTask[] = Array.from({ length: CRON_TASK_CAP_PER_SESSION }, (_, i) => ({
      id: `e${`${i}`.padStart(7, "0")}`,
      sessionId: "s-live",
      prompt: `own${i}`,
      schedule: { type: "interval", everyMs: 60 * MIN } as const,
      createdAt: BASE,
    }));
    const rt = await runtimeWith([...own, oneshot("eeee9999", "dead-session", at("2026-09-07T09:15:00"))], "s-live", () => clock);
    clock = TICK;
    const fires = await rt.tick();
    expect(fires.map((f) => f.task.id)).toEqual(["eeee9999"]); // 本会话任务都未 due，只有 foreign 被收养
    const disk = await storeTasks();
    expect(disk.filter((t) => t.sessionId === "s-live").length).toBe(CRON_TASK_CAP_PER_SESSION + 1);
    expect(disk.find((t) => t.id === "eeee9999")!.sessionId).toBe("s-live");
    rt.stop();
  });

  it("inert runtime（disabled）→ 零收养（边界④）", async () => {
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const task = oneshot("ffff0001", "dead-session", at("2026-09-07T09:23:00"));
    await writeFile(join(ws, ".wudao", "cron.json"), JSON.stringify({ version: 1, tasks: [task] }), "utf8");
    const rt = await createCronRuntime({
      workspaceRoot: ws,
      sessionId: "s-live",
      tickMs: 0,
      env: { WUDAO_DISABLE_CRON: "1" },
    });
    expect(rt.refusal).toBe("disabled");
    expect(await rt.tick(TICK)).toEqual([]);
    const disk = await storeTasks();
    expect(disk.length).toBe(1);
    expect(disk[0]!.sessionId).toBe("dead-session"); // store 原样未被触碰
    rt.stop();
  });

  it("被收养的 one-shot 触发后自删（边界⑤）", async () => {
    let clock = BASE;
    const rt = await runtimeWith([oneshot("aaaa0003", "dead-session", at("2026-09-07T09:23:00"))], "s-live", () => clock);
    clock = TICK;
    await rt.tick();
    const injection = rt.takeInjection();
    expect(injection).toContain("提醒_aaaa0003");
    await wait(); // recordFire 的 persist 落定
    expect((await storeTasks()).length).toBe(0);
    expect(rt.list().length).toBe(0);
    rt.stop();
  });

  it("被收养的过期 recurring → expiry-final 终发后自删（边界⑤）", async () => {
    let clock = BASE;
    // expiresAt = BASE+5m（09:05）：startup tick(09:00) 未过期未 due；
    // 显式 tick(09:30) 已过期 → expiry-final。lastFiredAt=03:00 让常规档
    // （03:00+24h+抖动）不 due，只有 expiry-final 这一条路。
    const created = BASE - CRON_EXPIRY_MS + 5 * MIN;
    const rt = await runtimeWith(
      [{
        id: "aaaa0004",
        sessionId: "dead-session",
        prompt: "每日汇报",
        schedule: { type: "interval", everyMs: 24 * 60 * MIN },
        createdAt: created,
        expiresAt: created + CRON_EXPIRY_MS,
        lastFiredAt: BASE - 6 * 60 * MIN,
      }],
      "s-live",
      () => clock,
    );
    clock = TICK;
    const fires = await rt.tick();
    expect(fires.length).toBe(1);
    expect(fires[0]!.kind).toBe("expiry-final");
    rt.takeInjection();
    await wait();
    expect((await storeTasks()).length).toBe(0);
    rt.stop();
  });
});
