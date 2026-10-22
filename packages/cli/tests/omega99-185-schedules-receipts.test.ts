// ω99-185 receipts — /schedule 中文化回执面（23 面弧的确定性验收）。
// 镜像 m61-schedules 的 daemon fixture 形（tmpWs + createScheduleDaemon）；
// 每条断言都咬住面表新串的逐字节形（token 裁定项原样保留）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScheduleDaemon, parseScheduleCommand, formatDurableList } from "../src/schedules.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "om185-sched-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const T0 = new Date("2026-08-17T10:00:00").getTime();
const okRun = async () => ({ ok: true, exitCode: 0, output: "ok" });
// Never resolves: the run stays in the daemon's running set (m61 同款手法).
const neverRun = () => new Promise(() => {}) as Promise<{ ok: boolean; exitCode: number; output: string }>;
const oneId = async (): Promise<string> => {
  const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
  return stored.tasks[0].id as string;
};

describe("ω99-185 A — /schedule list 渲染", () => {
  it("空态：无持久任务（.wudao/schedules.json）", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    expect(daemon.listText()).toBe("无持久任务（.wudao/schedules.json）");
    daemon.stop();
  });

  it("一条 cron 任务：持久任务（1 条）：+ 行（位于/来源/下次 ISO 态）", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "跑构建检查", createdFrom: "/schedule" });
    const text = daemon.listText();
    expect(text).toContain("持久任务（1 条）：");
    expect(text).toContain("- ");
    expect(text).toContain(` · 位于 ${ws} · 来源 /schedule · 下次：`);
    expect(text).toMatch(/下次：\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(text).toContain("\n  prompt: 跑构建检查");
    daemon.stop();
  });

  it("行三态：（已暂停）标注+下次：已暂停 / 下次：无", () => {
    const pausedRow = formatDurableList([
      { id: "aaaaaaaa", schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0, paused: true },
    ], () => T0);
    expect(pausedRow).toContain("⏸ aaaaaaaa（已暂停）");
    expect(pausedRow).toContain("下次：已暂停");
    const noneRow = formatDurableList([
      { id: "bbbbbbbb", schedule: { type: "at", at: T0 - 60_000 }, prompt: "p", workspace: ws, createdFrom: "t", createdAt: T0 - 120_000, lastFiredAt: T0 - 60_000 },
    ], () => T0);
    expect(noneRow).toContain("持久任务（1 条）：");
    expect(noneRow).toContain("下次：无");
  });
});

describe("ω99-185 B — doctor 三态", () => {
  it("hosted：schedules：守护在本进程（wudao ui）· 0 个持久任务 · 下次到期 无待办", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    const line = daemon.doctorLine();
    expect(line).toContain("schedules：守护在本进程（wudao ui）");
    expect(line).toContain("0 个持久任务");
    expect(line).toContain("下次到期 无待办");
    daemon.stop();
  });

  it("disabled（WUDAO_DISABLE_CRON=1）：listText/doctorLine 两形", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, tickMs: 0, env: { WUDAO_DISABLE_CRON: "1" } });
    expect(daemon.listText()).toBe("持久调度已禁用（WUDAO_DISABLE_CRON=1）");
    expect(daemon.doctorLine()).toBe("schedules：已禁用（WUDAO_DISABLE_CRON=1）");
    expect(await daemon.add({ schedule: { type: "at", at: T0 }, prompt: "x" })).toBe("⚠️ 持久调度已禁用（WUDAO_DISABLE_CRON=1）"); // ω99-185: 披露面（面表漏列残面锁步）
    daemon.stop();
  });
});

describe("ω99-185 C — 回执通道", () => {
  it("add：📅 持久任务 … 已添加（cron/ISO 括号原样）· 工作区 …", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    const cron = await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    expect(cron).toContain("📅 持久任务 ");
    expect(cron).toContain(` 已添加（*/10 * * * *）· 工作区 ${ws}`);
    const at = await daemon.add({ schedule: { type: "at", at: T0 + 5 * 60_000 }, prompt: "p", createdFrom: "test" });
    expect(at).toMatch(/📅 持久任务 \w{8} 已添加（\d{4}-\d{2}-\d{2}T.*Z）· 工作区 /);
    daemon.stop();
  });

  it("rm 两形：已移除持久任务 / 无持久任务", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const id = await oneId();
    expect(await daemon.rm(id)).toBe(`已移除持久任务 ${id}`);
    expect(await daemon.rm(id)).toBe(`无持久任务 ${id}`);
    daemon.stop();
  });

  it("run 三态：已立即启动（手动运行——计划不变）/ 已在运行 / ⚠️ 无持久任务", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: neverRun });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const id = await oneId();
    expect(await daemon.runNow(id)).toBe(`▶ ${id} 已立即启动（手动运行——计划不变）`);
    expect(await daemon.runNow(id)).toBe(`⚠️ ${id} 已在运行`);
    expect(await daemon.runNow("zzzzzzzz")).toBe("⚠️ 无持久任务 zzzzzzzz");
    daemon.stop();
  });

  it("pause 三态：⏸ 已暂停（错过的触发不补跑）/ 正在运行——请稍后再暂停 / ⚠️ 无持久任务", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: neverRun });
    expect(await daemon.pause("zzzzzzzz")).toBe("⚠️ 无持久任务 zzzzzzzz");
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "a", createdFrom: "test" });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "b", createdFrom: "test" });
    const stored = JSON.parse(await readFile(join(ws, ".wudao", "schedules.json"), "utf8"));
    const runner = stored.tasks[0].id as string;
    const sleeper = stored.tasks[1].id as string;
    await daemon.runNow(runner); // 占住 running 位（neverRun 不结算）
    expect(await daemon.pause(runner)).toBe(`⚠️ ${runner} 正在运行——请稍后再暂停`);
    expect(await daemon.pause(sleeper)).toBe(`⏸ ${sleeper} 已暂停（错过的触发不补跑）`);
    daemon.stop();
  });

  it("resume：▶ … 已恢复", async () => {
    const daemon = await createScheduleDaemon({ workspaceRoot: ws, now: () => T0, tickMs: 0, env: {}, runTask: okRun });
    await daemon.add({ schedule: { type: "cron", expr: "*/10 * * * *" }, prompt: "p", createdFrom: "test" });
    const id = await oneId();
    await daemon.pause(id);
    expect(await daemon.unpause(id)).toBe(`▶ ${id} 已恢复`);
    daemon.stop();
  });
});

describe("ω99-185 D — parse 错误", () => {
  it("无法解析时间 \"…\"（用 ISO 形，如 @2026-08-20T10:30）", () => {
    const bad = parseScheduleCommand("add @notatime x");
    expect(bad.kind).toBe("bad");
    expect(bad.kind === "bad" && bad.error).toBe('无法解析时间 "@notatime"（用 ISO 形，如 @2026-08-20T10:30）');
  });
});
