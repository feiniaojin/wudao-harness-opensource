// 122 项 2 — LaunchAgent 离线唤起的聚焦验收（方案：
// docs/research/122-launchagent-design.md §5 MVP）。四个面：
//   ① 纯层——plist 渲染/解析/分钟取整/下次 occurrence（时区无关夹具：本地
//      零点派生时刻）；
//   ② 读写器——写/读回/删/原子性（无 tmp 残留）/min 更新重写/幂等（字节相
//      同零 launchctl）/非 macOS 零足迹/bootstrap 失败如实；
//   ③ daemon reconcile——设置开+min 变化→plist 同步/设置关→移除/幂等/火后
//      前进重写/空表删除/opt-in 缺省关（零足迹零调用）/kill-switch 卸载/
//      /doctor 现值行；
//   ④ 旗标与设置——--schedule-wake 解析（精确 token）、schedules.launchAgent
//      解析容忍姿势、settingsSet typed 三形（落盘/回读/非布尔拒/兄弟键存活）。
// launchctl 一律注入记录假件，home 一律 tmpdir——绝不碰真实
// ~/Library/LaunchAgents（★红线：权限边界）。镜像 122 项 1 测试的夹具形。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createScheduleDaemon,
  createLaunchAgentSync,
  parseScheduleWakeArgv,
  scheduleWakeRequested,
  renderLaunchAgentPlist,
  parseLaunchAgentPlist,
  launchAgentMinuteOf,
  startCalendarIntervalOf,
  nextCalendarOccurrence,
  SCHEDULE_LAUNCHAGENT_LABEL,
  SCHEDULE_LAUNCHAGENT_PLIST_FILE,
  SCHEDULE_WAKE_ENV,
  SCHEDULE_NEAR_FIRE_GUARD_MS,
} from "../src/schedules.js";
import type { LaunchctlRunner } from "../src/schedules.js";
import { schedulesSettingsFromNode, scheduleSleepGuardFromNode, DEFAULT_SCHEDULES_SETTINGS } from "../src/misc-config.js";
import { createSettingsOps } from "../src/driver/settings-ops.js";
import { globalSettingsPath } from "../src/settings-layer.js";

let ws: string;
let home: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "w122-agent-"));
  home = await mkdtemp(join(tmpdir(), "w122-home-"));
});
afterEach(async () => {
  for (const dir of [ws, home]) {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});

/** 本地日历时刻（时区无关夹具）：2026-09-26 本地 22:00 起。 */
const T0 = new Date(2026, 8, 26, 22, 0, 0, 0).getTime();
const MIN = 60_000;
type RunResult = { ok: boolean; exitCode: number; output: string };
const okRun = async () => ({ ok: true, exitCode: 0, output: "ok" }) as RunResult;

/** gate 红收据（0.4.9）：poll 超时静默返回会让后续断言在未满足的前置上
 * 立即评估——reconcile 合并窗口下 toBe(2) 变 flaky。pollMust 超时即抛
 * （真正的前置门槛用它；sleep 形的 poll(() => false, 50) 保留旧语义）。 */
const pollMust = async (pred: () => boolean | Promise<boolean>, what: string, ms = 5_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) throw new Error(`pollMust timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const poll = async (pred: () => boolean | Promise<boolean>, ms = 5_000): Promise<void> => {
  const by = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > by) return;
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** Recording launchctl fake: every call lands in calls; bootstrap can be
 *  scripted to fail (the honest ⚠️ face). */
const makeLaunchctl = (opts: { readonly failBootstrap?: boolean } = {}): LaunchctlRunner & { calls: string[][] } => {
  const calls: string[][] = [];
  const runner = async (args: readonly string[]): Promise<{ ok: boolean; stderr: string }> => {
    calls.push([...args]);
    if (opts.failBootstrap === true && args[0] === "bootstrap") {
      return { ok: false, stderr: "Bootstrap failed: 5: Input/output error" };
    }
    return { ok: true, stderr: "" };
  };
  return Object.assign(runner, { calls });
};

const plistPath = (): string => join(home, "Library", "LaunchAgents", SCHEDULE_LAUNCHAGENT_PLIST_FILE);
const plistText = async (): Promise<string | undefined> => await readFile(plistPath(), "utf8").catch(() => undefined);
const bootstraps = (ctl: { calls: string[][] }): number => ctl.calls.filter((c) => c[0] === "bootstrap").length;
const storedIds = async (): Promise<string[]> =>
  (JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8")) as { tasks: { id: string }[] }).tasks.map((t) => t.id);

// ---------------------------------------------------------------------------
// ① 纯层
// ---------------------------------------------------------------------------

describe("122 项 2 — 纯层（plist 字节与分钟语义）", () => {
  it("launchAgentMinuteOf：整分不动、秒内进位（严格未来由调用方保证）", () => {
    expect(launchAgentMinuteOf(T0)).toBe(T0); // 22:00:00.000 恰在格上
    expect(launchAgentMinuteOf(T0 + 1)).toBe(T0 + MIN); // 22:00:00.001 → 22:01
    expect(launchAgentMinuteOf(T0 + MIN - 1)).toBe(T0 + MIN);
    expect(launchAgentMinuteOf(T0 + 29.5 * MIN)).toBe(T0 + 30 * MIN);
  });

  it("startCalendarIntervalOf 是本地钟（launchd 日历格 = 墙钟）", () => {
    expect(startCalendarIntervalOf(T0)).toEqual({ Hour: 22, Minute: 0 });
    expect(startCalendarIntervalOf(T0 + 30 * MIN)).toEqual({ Hour: 22, Minute: 30 });
    expect(startCalendarIntervalOf(T0 + 2 * 60 * MIN)).toEqual({ Hour: 0, Minute: 0 }); // 次日零点
  });

  it("render 的字节契约：label / open -a 应用名 / 唤醒旗标 / 日历格 / RunAtLoad=false", () => {
    const xml = renderLaunchAgentPlist(T0 + 30 * MIN);
    expect(xml).toContain(`<string>${SCHEDULE_LAUNCHAGENT_LABEL}</string>`);
    expect(xml).toContain("<string>/usr/bin/open</string>");
    expect(xml).toContain("<string>-a</string>");
    expect(xml).toContain("<string>悟道Harness</string>");
    expect(xml).toContain("<string>--args</string>");
    expect(xml).toContain("<string>--schedule-wake</string>");
    expect(xml).toMatch(/<key>Hour<\/key>\s*<integer>22<\/integer>/);
    expect(xml).toMatch(/<key>Minute<\/key>\s*<integer>30<\/integer>/);
    expect(xml).toContain("<key>RunAtLoad</key>\n\t<false/>");
  });

  it("同一 {H,M} 字节相同——跨天幂等的地基（日历格每日重复）", () => {
    const today = T0 + 30 * MIN; // 09-26 22:30
    const tomorrow = today + 24 * 60 * MIN; // 09-27 22:30
    expect(renderLaunchAgentPlist(today)).toBe(renderLaunchAgentPlist(tomorrow));
    expect(renderLaunchAgentPlist(today)).not.toBe(renderLaunchAgentPlist(T0 + 31 * MIN));
  });

  it("parse 读回自家形；外来/畸形 → undefined（漂移的答案是覆写不是崩）", () => {
    const xml = renderLaunchAgentPlist(T0 + 30 * MIN);
    expect(parseLaunchAgentPlist(xml)).toEqual({ hour: 22, minute: 30 });
    expect(parseLaunchAgentPlist(xml.replace(/\s+/g, " "))).toEqual({ hour: 22, minute: 30 }); // 容忍空白
    expect(parseLaunchAgentPlist("not a plist")).toBeUndefined();
    expect(parseLaunchAgentPlist('<key>Hour</key><integer>25</integer><key>Minute</key><integer>0</integer>')).toBeUndefined();
    expect(parseLaunchAgentPlist('<key>Minute</key><integer>0</integer>')).toBeUndefined();
  });

  it("nextCalendarOccurrence：今天的格子今天、过了格子明天", () => {
    const at = T0; // 22:00
    expect(nextCalendarOccurrence(23, 0, at)).toBe(T0 + 60 * MIN); // 今天 23:00
    expect(nextCalendarOccurrence(21, 0, at)).toBe(T0 + 23 * 60 * MIN); // 明天 21:00
    expect(nextCalendarOccurrence(22, 0, at)).toBe(T0 + 24 * 60 * MIN); // 恰在格上=已过 → 明天
  });
});

// ---------------------------------------------------------------------------
// ② 读写器
// ---------------------------------------------------------------------------

describe("122 项 2 — 读写器（写/读/删/原子/幂等/min 更新）", () => {
  it("写入：原子落盘 + bootout+bootstrap 各一次；读回字节相等", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    const outcome = await sync.sync(T0 + 30 * MIN);
    expect(outcome).toEqual({ kind: "written", at: T0 + 30 * MIN });
    const text = await plistText();
    expect(text).toBe(renderLaunchAgentPlist(T0 + 30 * MIN));
    expect(ctl.calls.length).toBe(2);
    expect(ctl.calls[0]).toEqual(["bootout", `gui/${process.getuid()}`, SCHEDULE_LAUNCHAGENT_LABEL]);
    expect(ctl.calls[1]![0]).toBe("bootstrap");
    // 原子性：目录里没有 tmp 残留（rename 已换名）。
    const files = await readdir(join(home, "Library", "LaunchAgents"));
    expect(files).toEqual([SCHEDULE_LAUNCHAGENT_PLIST_FILE]);
  });

  it("幂等：同 desired 再 sync = current，零 launchctl、零重写", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    await sync.sync(T0 + 30 * MIN);
    expect(bootstraps(ctl)).toBe(1);
    const before = await plistText();
    expect(await sync.sync(T0 + 30 * MIN)).toEqual({ kind: "current", at: T0 + 30 * MIN });
    expect(bootstraps(ctl)).toBe(1); // 未 reload
    expect(await plistText()).toBe(before);
    // 跨天同格（明天 22:30）也字节相同 → 仍 current（at 报请求侧的分钟时刻）。
    expect(await sync.sync(T0 + 24 * 60 * MIN + 30 * MIN)).toEqual({ kind: "current", at: T0 + 24 * 60 * MIN + 30 * MIN });
  });

  it("min 变化 → 重写 + 重新装载；回早也重写（更早的火插进来是正确行为）", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    await sync.sync(T0 + 60 * MIN);
    expect(bootstraps(ctl)).toBe(1);
    expect(await sync.sync(T0 + 5 * MIN)).toEqual({ kind: "written", at: T0 + 5 * MIN });
    expect(bootstraps(ctl)).toBe(2);
    expect(parseLaunchAgentPlist((await plistText())!)).toEqual({ hour: 22, minute: 5 });
  });

  it("已过/正发射的 wake：held——plist 不动（写过去=launchd 排到明天）", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    await sync.sync(T0 + 30 * MIN);
    const before = await plistText();
    expect(await sync.sync(T0)).toEqual({ kind: "held" });
    expect(await sync.sync(T0 - MIN)).toEqual({ kind: "held" });
    expect(await plistText()).toBe(before);
    expect(bootstraps(ctl)).toBe(1);
  });

  it("删除：bootout + unlink；无文件时 noop 零调用", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    await sync.sync(T0 + 30 * MIN);
    expect(await sync.sync(undefined)).toEqual({ kind: "removed" });
    expect(existsSync(plistPath())).toBe(false);
    expect(ctl.calls.filter((c) => c[0] === "bootout")).toHaveLength(2);
    ctl.calls.length = 0;
    expect(await sync.sync(undefined)).toEqual({ kind: "noop" });
    expect(ctl.calls).toHaveLength(0);
  });

  it("非 macOS：unsupported——零目录零文件零调用", async () => {
    const ctl = makeLaunchctl();
    const sync = createLaunchAgentSync({ homeDir: home, platform: "linux", now: () => T0, launchctl: ctl });
    expect(await sync.sync(T0 + 30 * MIN)).toEqual({ kind: "unsupported" });
    expect(existsSync(join(home, "Library"))).toBe(false);
    expect(ctl.calls).toHaveLength(0);
    expect(await sync.readback()).toBeUndefined();
  });

  it("bootstrap 失败：failed 携带 stderr（⚠️ 如实面的数据源）", async () => {
    const ctl = makeLaunchctl({ failBootstrap: true });
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    const outcome = await sync.sync(T0 + 30 * MIN);
    expect(outcome.kind).toBe("failed");
    if (outcome.kind === "failed") expect(outcome.error).toContain("Bootstrap failed");
    // plist 已落盘（文件在、装载失败）——下轮 reconcile 自愈重试。
    expect(await plistText()).toBeDefined();
  });

  it("崩溃残留的 stale plist：内容漂了就覆写（自愈）", async () => {
    const ctl = makeLaunchctl();
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath(), renderLaunchAgentPlist(T0 + 45 * MIN), "utf8");
    const sync = createLaunchAgentSync({ homeDir: home, platform: "darwin", now: () => T0, launchctl: ctl });
    expect(await sync.sync(T0 + 30 * MIN)).toEqual({ kind: "written", at: T0 + 30 * MIN });
    expect(parseLaunchAgentPlist((await plistText())!)).toEqual({ hour: 22, minute: 30 });
  });
});

// ---------------------------------------------------------------------------
// ③ daemon reconcile
// ---------------------------------------------------------------------------

describe("122 项 2 — daemon reconcile（persist/boot/tick 尾部）", () => {
  it("设置开 + add → plist 同步到最近一火（min-wake 单格）", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 60 * MIN }, prompt: "远火", createdFrom: "test" });
    await poll(async () => (await plistText()) !== undefined);
    expect(parseLaunchAgentPlist((await plistText())!)).toEqual({ hour: 23, minute: 0 });
    daemon.stop();
  });

  it("更近的火插进来 → 重写；删掉近火 → 回退到远火", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 60 * MIN }, prompt: "远火", createdFrom: "test" });
    // gate 红收据（0.4.9）：负载下两次 add 可落进同一 reconcile 观察窗（字节
    // 幂等下一次 reload 是正确行为）——强制在 add#2 之前观察到第一次 reload，
    // "两次内容变化各一次"的断言才有确定性的前置。
    await pollMust(async () => bootstraps(ctl) >= 1, "first reload after 远火");
    await poll(async () => parseLaunchAgentPlist((await plistText()) ?? "")?.minute === 0);
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "近火", createdFrom: "test" });
    await poll(async () => parseLaunchAgentPlist((await plistText()) ?? "")?.minute === 5);
    await pollMust(() => bootstraps(ctl) >= 2, "second reload after 近火");
    expect(bootstraps(ctl)).toBe(2); // 两次内容变化各一次 reload
    const ids = await storedIds();
    await daemon.rm(ids[1]!); // 近火
    await poll(async () => parseLaunchAgentPlist((await plistText()) ?? "")?.minute === 0);
    daemon.stop();
  });

  it("幂等：settle 后连打 tick 不再 reload（字节相同零成本）", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "稳定", createdFrom: "test" });
    await poll(() => bootstraps(ctl) === 1);
    for (let i = 0; i < 3; i += 1) await daemon.tick();
    await poll(() => false, 50);
    expect(bootstraps(ctl)).toBe(1);
    daemon.stop();
  });

  it("火后前进：一次性任务烧完 → 表空 → plist 移除", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 5 * MIN }, prompt: "一次性", createdFrom: "test" });
    await poll(async () => (await plistText()) !== undefined);
    clock = T0 + 6 * MIN;
    await daemon.tick();
    await poll(() => existsSync(plistPath()) === false); // 自删 + reconcile 移除
    daemon.stop();
  });

  it("周期任务火后 → plist 前进到次火（每日一写）", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    // every：add 于 T0（22:00）→ 首火 T0+6h = 次日 04:00 本地。
    await daemon.add({ schedule: { type: "every", intervalMs: 6 * 60 * MIN }, prompt: "周期", createdFrom: "test" });
    await poll(async () => {
      const parts = parseLaunchAgentPlist((await plistText()) ?? "");
      return parts?.hour === 4 && parts?.minute === 0;
    });
    // 火落（tick 于 T0+6h+1min）→ 次火 = 火时刻+6h = 次日 10:01。
    clock = T0 + 6 * 60 * MIN + MIN;
    await daemon.tick();
    await poll(async () => {
      const parts = parseLaunchAgentPlist((await plistText()) ?? "");
      return parts?.hour === 10 && parts?.minute === 1;
    });
    daemon.stop();
  });

  it("设置关（读回 false）→ 已有 stale plist 在 boot reconcile 移除", async () => {
    const ctl = makeLaunchctl();
    // 先用开设置的 daemon 写一个 plist（模拟此前 opt-in 过、后关掉）。
    let clock = T0;
    const armed = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await armed.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "将关", createdFrom: "test" });
    await poll(async () => (await plistText()) !== undefined);
    armed.stop();
    // 同一 store、同 home，但设置已关（readEnabled: false）。
    const disarmed = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: false, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await poll(() => existsSync(plistPath()) === false);
    expect(disarmed.doctorLine()).toContain("离线唤起 关");
    disarmed.stop();
  });

  it("opt-in 缺省关：enabled 未给（也非 readEnabled）→ 零 plist 零 launchctl", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { homeDir: home, platform: "darwin", launchctl: ctl }, // enabled 缺省
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "没开", createdFrom: "test" });
    await daemon.tick();
    await poll(() => false, 100);
    expect(existsSync(plistPath())).toBe(false);
    expect(ctl.calls).toHaveLength(0);
    expect(daemon.doctorLine()).toContain("离线唤起 关");
    daemon.stop();
  });

  it("daemon 面完全不带 launchAgent（既有调用形）→ 行为零变化，doctor 仍如实报关", async () => {
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "老路", createdFrom: "test" });
    clock = T0 + 31 * MIN;
    await daemon.tick();
    expect(existsSync(join(home, "Library"))).toBe(false); // 谁都没碰 home
    expect(daemon.doctorLine()).toContain("离线唤起 关");
    daemon.stop();
  });

  it("kill-switch（WUDAO_DISABLE_CRON=1）：opt-in 面在场则 best-effort 卸载 plist", async () => {
    const ctl = makeLaunchctl();
    await mkdir(join(home, "Library", "LaunchAgents"), { recursive: true });
    await writeFile(plistPath(), renderLaunchAgentPlist(T0 + 30 * MIN), "utf8");
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: { WUDAO_DISABLE_CRON: "1" },
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    expect(daemon.refusal).toBe("disabled");
    await poll(() => existsSync(plistPath()) === false);
    daemon.stop();
  });

  it("/doctor 现值行：开 + 已武装 → 下次系统唤起（从 now 起算的下一次格子）", async () => {
    const ctl = makeLaunchctl();
    let clock = T0;
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => clock, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await daemon.add({ schedule: { type: "at", at: T0 + 30 * MIN }, prompt: "查医生", createdFrom: "test" });
    await poll(() => daemon.doctorLine().includes("下次系统唤起"));
    const line = daemon.doctorLine();
    expect(line).toContain("离线唤起 开");
    expect(line).toContain(new Date(T0 + 30 * MIN).toISOString());
    expect(line).toContain("守护在本进程"); // 既有段落不丢
    daemon.stop();
  });

  it("/doctor 现值行：开 + 空表 → 无待唤起；非 macOS → 不支持", async () => {
    const ctl = makeLaunchctl();
    const daemon = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "darwin", launchctl: ctl },
    });
    await poll(() => daemon.doctorLine().includes("当前无待唤起任务"));
    daemon.stop();
    const linux = await createScheduleDaemon({
      workspaceRoot: ws, now: () => T0, tickMs: 0, env: {},
      runTask: okRun,
      launchAgent: { enabled: true, homeDir: home, platform: "linux", launchctl: ctl },
    });
    await poll(() => linux.doctorLine().includes("离线唤起 不支持"));
    linux.stop();
  });
});

// ---------------------------------------------------------------------------
// ④ 旗标与设置
// ---------------------------------------------------------------------------

describe("122 项 2 — 唤醒旗标解析", () => {
  it("精确 token：值、前缀、后缀都不是", () => {
    expect(parseScheduleWakeArgv(["node", "wudao-server", "ui", "--no-open"])).toBe(false);
    expect(parseScheduleWakeArgv(["node", "wudao-server", "ui", "--no-open", "--schedule-wake"])).toBe(true);
    expect(parseScheduleWakeArgv(["--schedule-wake=1"])).toBe(false);
    expect(parseScheduleWakeArgv(["--schedule"])).toBe(false);
    expect(parseScheduleWakeArgv([])).toBe(false);
  });

  it("sidecar 读法：env 直通（Tauri 壳译来的）或自身 argv", () => {
    expect(scheduleWakeRequested({ [SCHEDULE_WAKE_ENV]: "1" }, [])).toBe(true);
    expect(scheduleWakeRequested({}, ["node", "ui", "--schedule-wake"])).toBe(true);
    expect(scheduleWakeRequested({ [SCHEDULE_WAKE_ENV]: "0" }, [])).toBe(false);
    expect(scheduleWakeRequested({}, [])).toBe(false);
  });
});

describe("122 项 2 — schedules 节点解析（misc 家族容忍姿势）", () => {
  it("缺省：窗 10min + launchAgent 关（fail-closed）", () => {
    expect(schedulesSettingsFromNode(undefined)).toEqual(DEFAULT_SCHEDULES_SETTINGS);
    expect(DEFAULT_SCHEDULES_SETTINGS).toEqual({ nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS, launchAgent: false });
    expect(schedulesSettingsFromNode({})).toEqual(DEFAULT_SCHEDULES_SETTINGS);
  });

  it("显式值：launchAgent true / sleepGuardMs 0 共存", () => {
    expect(schedulesSettingsFromNode({ launchAgent: true })).toEqual({ nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS, launchAgent: true });
    expect(schedulesSettingsFromNode({ sleepGuardMs: 0, launchAgent: true })).toEqual({ nearFireMs: 0, launchAgent: true });
  });

  it("垃圾：警告 + 缺省，never fatal；未知键只警告不拒收", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    expect(schedulesSettingsFromNode("nope", warn)).toEqual(DEFAULT_SCHEDULES_SETTINGS);
    expect(schedulesSettingsFromNode({ launchAgent: "yes" }, warn)).toEqual(DEFAULT_SCHEDULES_SETTINGS);
    expect(schedulesSettingsFromNode({ sleepGuardMs: -1 }, warn)).toEqual(DEFAULT_SCHEDULES_SETTINGS);
    expect(schedulesSettingsFromNode({ launchAgent: true, bogus: 1 }, warn)).toEqual({ nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS, launchAgent: true });
    expect(warns.some((w) => w.includes("launchAgent must be a boolean"))).toBe(true);
    expect(warns.some((w) => w.includes("unknown schedules key"))).toBe(true);
  });

  it("旧门面委托：launchAgent 是已知键（不误报 unknown），窗值照旧", () => {
    const warns: string[] = [];
    const warn = (m: string) => warns.push(m);
    expect(scheduleSleepGuardFromNode({ launchAgent: true }, warn)).toEqual({ nearFireMs: SCHEDULE_NEAR_FIRE_GUARD_MS });
    expect(scheduleSleepGuardFromNode({ sleepGuardMs: 120_000, launchAgent: false }, warn)).toEqual({ nearFireMs: 120_000 });
    expect(warns).toHaveLength(0);
  });
});

describe("122 项 2 — settingsSet schedules.launchAgent（typed 三形）", () => {
  const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });
  let root: string;
  beforeEach(() => {
    root = ws;
  });

  it("set true → 落盘全局 tier 的 schedules 节点 + settingsStatus 回读 true", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    expect(await ops.settingsSet("schedules.launchAgent", true)).toEqual({ key: "schedules.launchAgent", saved: true });
    const saved = JSON.parse(await readFile(globalSettingsPath(env()), "utf8")) as Record<string, unknown>;
    expect(saved["schedules"]).toEqual({ launchAgent: true });
    const status = await ops.settingsStatus();
    expect(status.settings.schedulesLaunchAgent).toBe(true);
  });

  it("set false → 落盘回读 false", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await ops.settingsSet("schedules.launchAgent", true);
    expect(await ops.settingsSet("schedules.launchAgent", false)).toEqual({ key: "schedules.launchAgent", saved: true });
    const status = await ops.settingsStatus();
    expect(status.settings.schedulesLaunchAgent).toBe(false);
  });

  it("非布尔拒（typed 门），错误串点名该键", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    for (const bad of ["true", 1, null, { enabled: true }]) {
      await expect(ops.settingsSet("schedules.launchAgent", bad)).rejects.toThrow(/schedules\.launchAgent must be a boolean/);
    }
  });

  it("兄弟键存活（whole-node merge）：先写的 sleepGuardMs 不被丢弃", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    await ops.settingsSet("schedules.launchAgent", true);
    const file = globalSettingsPath(env());
    const node = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    node["schedules"] = { sleepGuardMs: 120_000, launchAgent: true };
    await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
    await ops.settingsSet("schedules.launchAgent", false);
    const after = JSON.parse(await readFile(file, "utf8")) as { schedules: Record<string, unknown> };
    expect(after["schedules"]).toEqual({ sleepGuardMs: 120_000, launchAgent: false });
  });

  it("平台门回传（macOS 真、其余假——渲染门的数据面）", async () => {
    const ops = createSettingsOps({ env: env(), workspaceRoot: root });
    const status = await ops.settingsStatus();
    expect(status.settings.schedulesLaunchAgentSupported).toBe(process.platform === "darwin");
  });
});
