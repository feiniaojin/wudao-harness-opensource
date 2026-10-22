// 122 项 1 — 临火睡眠守卫（near-fire sleep guard）的聚焦验收：等火的
// 间隙持有 prevent-sleep 断言（refCount>0）、火落/任务删除/暂停后释放、
// 阈值外不持有、多任务取最近、武装中的 missRetryAt 同样算 wake 时刻、
// 守卫票与活跃 run 的票按 refCount 叠加（不互斥）、daemon.stop() 只放
// 自己的票。控制器一律注入计数假件——真单例另有 env 门控（测试环境整体
// 关），这里测的是守护的「票数」语义，不是 caffeinate 本身（那是
// prevent-sleep.test.ts 的地盘）。解析器（scheduleSleepGuardFromNode）的
// 容忍姿势同套收尾。镜像 313 守护测试的夹具形（tmpWs + 时钟缝 + 轮询）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  nearestWakeAt,
  SCHEDULE_NEAR_FIRE_GUARD_MS,
  SCHEDULE_MISS_RETRY_DELAY_MS,
  SCHEDULE_MODEL_UNREACHED_MARKER,
} from "../src/schedules.js";
import type { PreventSleepController } from "../src/prevent-sleep.js";
import {
  scheduleSleepGuardFromNode,
  DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS,
} from "../src/misc-config.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w122-sleep-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-09-26T22:00:00").getTime();
const MIN = 60_000;
type RunResult = { ok: boolean; exitCode: number; output: string };
const okRun = async () => ({ ok: true, exitCode: 0, output: "ok" }) as RunResult;

/** Poll until pred or deadline (the daemon's fire bookkeeping rides a real
 *  async void body incl. fs I/O — the 313 polled-flake lesson). Async preds
 *  (store reads) are awaited per round. */
const poll = async (pred: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Counting fake for the shared controller: refCount IS the contract under
 *  test (the guard's vote must stack with the drivers' busy-run votes). */
const makeController = (): PreventSleepController & { calls: string[] } => {
  let count = 0;
  const calls: string[] = [];
  return {
    acquire() {
      calls.push("acquire");
      count += 1;
    },
    release() {
      calls.push("release");
      count = Math.max(0, count - 1);
    },
    forceStop() {
      calls.push("forceStop");
      count = 0;
    },
    refCount() {
      return count;
    },
    calls,
  };
};

const idsOf = async (): Promise<string[]> => (await storedTasks()).map((t) => t.id as string);

const storedTasks = async (): Promise<Record<string, unknown>[]> => {
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: Record<string, unknown>[] };
  return stored.tasks;
};

describe("122 项 1 — 守护的合闸/放行（daemon 面）", () => {
  it("a fire inside the window holds the assertion right after add (临火 refCount>0)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "夜报", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1); // add → persist → sync：窗内即合闸
    expect(ctl.calls.filter((c) => c === "acquire").length).toBe(1);
    daemon.stop();
  });

  it("a fire outside the window holds nothing; the tick closes the guard as the clock walks in (阈值外不持有)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "远火", createdFrom: "test" });
    expect(ctl.refCount()).toBe(0); // 30min 出窗
    clock = T0 + 10 * MIN;
    await daemon.tick();
    expect(ctl.refCount()).toBe(0); // 还剩 20min，仍出窗
    clock = T0 + 21 * MIN; // 剩 9min ≤ 10min 窗——时间驱动的合闸靠 tick
    await daemon.tick();
    expect(ctl.refCount()).toBe(1);
    daemon.stop();
  });

  it("releases after the fire lands (at one-shot self-deletes → 火后释放)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "一次性", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1);
    clock = T0 + 6 * MIN;
    await daemon.tick();
    await poll(() => ctl.refCount() === 0); // run 落定 → advance/self-delete persist → 放行
    expect(ctl.refCount()).toBe(0);
    daemon.stop();
  });

  it("a recurring fire re-arms far out and releases until the next window (every 族)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    // every 的 nextRunAt = createdAt + intervalMs：add 于 T0 → 首火 T0+60min。
    await daemon.add({ schedule: { type: "every", intervalMs: 60 * MIN }, prompt: "周期", createdFrom: "test" });
    expect(ctl.refCount()).toBe(0); // 首火 60min 外，出窗
    clock = T0 + 51 * MIN; // 距首火 9min——进窗
    await daemon.tick();
    expect(ctl.refCount()).toBe(1);
    clock = T0 + 61 * MIN; // 过火 1min
    await daemon.tick();
    await poll(() => ctl.refCount() === 0); // 火落、次火 = fire+60min 出窗 → 放行
    expect(ctl.refCount()).toBe(0);
    daemon.stop();
  });

  it("multiple tasks take the NEAREST fire; removing the near one releases (多任务取最近 + 删除后释放)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 45 * MIN }, prompt: "远", createdFrom: "test" });
    expect(ctl.refCount()).toBe(0); // 只有远火 → 不持有
    await daemon.add({ schedule: { type: "at", at: T0 + 4 * MIN }, prompt: "近", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1); // 最近一火进窗 → 合闸
    const ids = await idsOf();
    const nearId = ids[1]!;
    await daemon.rm(nearId);
    expect(ctl.refCount()).toBe(0); // 剩远火出窗 → 放行（rm → persist → sync）
    daemon.stop();
  });

  it("pause releases; unpause re-closes inside the window (暂停语义)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "暂停我", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1);
    const id = (await idsOf())[0]!;
    await daemon.pause(id);
    expect(ctl.refCount()).toBe(0); // paused 任务的 fire 被 tick 免单——不欠 wake
    await daemon.unpause(id);
    expect(ctl.refCount()).toBe(1); // 恢复后仍在窗内（还剩 5min）
    daemon.stop();
  });

  it("an armed missRetryAt is a wake moment too (miss-retry 火也算)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: async () => ({ ok: false, exitCode: 1, output: `${SCHEDULE_MODEL_UNREACHED_MARKER} provider down` }) as RunResult,
      preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "every", intervalMs: 6 * 60 * MIN }, prompt: "补跑者", createdFrom: "test" });
    clock = T0 + 6 * 60 * MIN + MIN; // 过首火 1min：自然次火在 ~6h 外
    await daemon.tick();
    // 火已消耗、run 失败且盖章 UNREACHED → missRetryAt = fire + 5min（窗内），
    // 自然次火出窗——守卫必须仍持有（补跑等待期被盖住）。
    await poll(async () => (await storedTasks())[0]?.missRetryAt !== undefined);
    await poll(() => false, 50); // 让 missRetry 的 persist 与 sync 落定
    expect(ctl.refCount()).toBe(1);
    daemon.stop();
  });

  it("the guard's vote STACKS with an active run's vote — never mutually exclusive (共存叠加)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    ctl.acquire(); // 模拟 driver 的活跃 run 守卫（夜移 028 的共享 refCount）
    expect(ctl.refCount()).toBe(1);
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "叠加", createdFrom: "test" });
    expect(ctl.refCount()).toBe(2); // 两票并存
    clock = T0 + 6 * MIN;
    await daemon.tick();
    await poll(() => ctl.refCount() === 1); // 守卫放自己的票，run 的票不受牵连
    expect(ctl.refCount()).toBe(1);
    ctl.release();
    expect(ctl.refCount()).toBe(0);
    daemon.stop();
    expect(ctl.refCount()).toBe(0); // stop 不重复放票（held 状态门）
    expect(ctl.calls.includes("forceStop")).toBe(false); // 绝不拆别人的断言
  });

  it("stop() releases the guard's own vote and never forceStops", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "关停", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1);
    daemon.stop();
    expect(ctl.refCount()).toBe(0);
    expect(ctl.calls.includes("forceStop")).toBe(false);
  });

  it("nearFireGuardMs=0 disables the guard entirely (显式关)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl, nearFireGuardMs: 0,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + MIN }, prompt: "关了", createdFrom: "test" });
    expect(ctl.refCount()).toBe(0);
    clock = T0 + 2 * MIN;
    await daemon.tick();
    await poll(() => false, 50);
    expect(ctl.refCount()).toBe(0);
    daemon.stop();
  });

  it("a custom window is honored (阈值可配)", async () => {
    const ctl = makeController();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl, nearFireGuardMs: 2 * MIN,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "窄窗", createdFrom: "test" });
    expect(ctl.refCount()).toBe(0); // 5min > 2min 窗
    await daemon.add({ schedule: { type: "at", at: T0 + 90_000 }, prompt: "窗内", createdFrom: "test" });
    expect(ctl.refCount()).toBe(1); // 90s ≤ 2min 窗
    daemon.stop();
  });

  it("boot closes the guard for a near task already in the store — no tick needed (重启即合闸)", async () => {
    const ctl = makeController();
    await mkdir(join(ws, ".wudao"), { recursive: true });
    const fireAt = T0 + 5 * MIN;
    await writeFile(join(ws, ".wudao", "schedules.json"), `${JSON.stringify({
      version: 1,
      tasks: [{
        id: "bootnear", schedule: { type: "at", at: fireAt }, prompt: "重启后",
        workspace: ws, createdFrom: "test", createdAt: T0 - MIN, nextRunAt: fireAt,
      }],
    }, null, 2)}\n`, "utf8");
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: okRun, preventSleep: ctl,
    });
    expect(ctl.refCount()).toBe(1); // boot clamp → sync，不等第一个 tick
    daemon.stop();
  });
});

describe("122 项 1 — 纯层（nearestWakeAt）", () => {
  it("takes the min across fires and armed retries; skips paused/disabled/event", () => {
    const base = { prompt: "p", workspace: "/w", createdFrom: "t", createdAt: T0 };
    const active = { ...base, id: "a", schedule: { type: "at", at: T0 + 30 * MIN } as const, nextRunAt: T0 + 30 * MIN };
    const retrying = { ...base, id: "r", schedule: { type: "every", intervalMs: 6 * 60 * MIN } as const, nextRunAt: T0 + 6 * 60 * MIN, missRetryAt: T0 + 3 * MIN };
    const paused = { ...base, id: "p", schedule: { type: "at", at: T0 + MIN } as const, nextRunAt: T0 + MIN, paused: true };
    const disabled = { ...base, id: "d", schedule: { type: "at", at: T0 + MIN } as const, nextRunAt: T0 + MIN, enabled: false };
    const evented = { ...base, id: "e", schedule: { type: "event", source: { kind: "file", path: "a.txt" } as const } };
    expect(nearestWakeAt([active, retrying, paused, disabled, evented], T0)).toBe(T0 + 3 * MIN); // missRetryAt 胜出
    expect(nearestWakeAt([active], T0)).toBe(T0 + 30 * MIN);
    expect(nearestWakeAt([paused, disabled, evented], T0)).toBeUndefined();
  });
});

describe("122 项 1 — 解析器（scheduleSleepGuardFromNode，misc 家族容忍姿势）", () => {
  it("defaults on undefined; accepts explicit values and 0 (off)", () => {
    expect(scheduleSleepGuardFromNode(undefined)).toEqual({ nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS });
    expect(DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS.nearFireMs).toBe(10 * MIN);
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: 120_000 })).toEqual({ nearFireMs: 120_000 });
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: 0 })).toEqual({ nearFireMs: 0 });
  });

  it("junk warns and falls back — never fatal", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    expect(scheduleSleepGuardFromNode("nope", warn)).toEqual(DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS);
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: "soon" }, warn)).toEqual(DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS);
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: -5 }, warn)).toEqual(DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS);
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: 1.5 }, warn)).toEqual(DEFAULT_SCHEDULE_SLEEP_GUARD_SETTINGS);
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: 60_000, bogus: 1 }, warn)).toEqual({ nearFireMs: 60_000 }); // 未知键只警告不拒收
    expect(warns.length).toBe(5);
    expect(warns.some((w) => w.includes("unknown schedules key"))).toBe(true);
  });

  it("the miss-retry delay constant stays inside the default window (常数一致性)", () => {
    // 补跑延迟 5min < 窗 10min：武装中的 missRetryAt 恒在窗内——守卫必然覆盖补跑等待期。
    expect(SCHEDULE_MISS_RETRY_DELAY_MS).toBeLessThanOrEqual(SCHEDULE_NEAR_FIRE_GUARD_MS);
  });
});
