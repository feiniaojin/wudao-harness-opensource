// ω99-40 — boot 时结算空壳 mission：硬崩溃窗口的补充缝。ω99-36 的
// settleAtSessionBoundary 接在 repl fireSessionEnd funnel 与 driver
// close()/onSessionCleared 三缝（优雅退出+轮换），但 SIGKILL/断电级硬崩绕过
// 一切 finally——空壳 active 遗物要等下一个会话边界才落终态。boot 时
// （createMissionController 构造、store 载入后）指针目标是 active 且全空壳
// ⇒ 必然是上一个已死进程的遗物（本进程刚启动，尚不可能创建任何 mission）——
// boot 结算安全且无歧义：同 isShellMission 判定、同 "stale" 终态快照、
// 静默（用户无需知道上个进程崩了）、写失败不拒 controller（一次性 stderr 行）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir, chmod, stat, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMissionController,
  loadMissionStore,
  MISSION_STORE_FILE,
  type MissionState,
} from "../src/mission.js";

let ws: string;
beforeEach(async () => {
  ws = await realpath(await mkdtemp(join(tmpdir(), "o9940-mission-")));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const stubGate = async () => ({ code: 0, output: "" });

/** A controller over the REAL tmpdir store (the disk layout under test IS
 *  the subject — the boot seam reads the relic the crashed process left). */
const fresh = async (notices: string[] = []) =>
  createMissionController({ workspaceRoot: ws, notify: (t) => notices.push(t), runGateCommand: stubGate });

const missionsDir = (): string => join(ws, ".wudao", "missions");
const archiveOf = (id: string): string => join(missionsDir(), `${id}.json`);
const pointerPath = (): string => join(ws, ".wudao", MISSION_STORE_FILE);
const readJson = async (p: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;

/** Seed the crashed process's leftovers: a per-mission archive + the v2
 *  active pointer naming it (exactly what ω99-36's storage leaves behind
 *  when the process dies before any boundary seam fires). */
const seedRelic = async (mission: MissionState): Promise<void> => {
  await mkdir(missionsDir(), { recursive: true });
  await writeFile(archiveOf(mission.id), JSON.stringify({ version: 1, mission }, null, 2), "utf8");
  await writeFile(pointerPath(), JSON.stringify({ version: 2, missionId: mission.id, summary: null }, null, 2), "utf8");
};

/** The hard-crash shell: active, zero tasks/ratchet/notes/bundles. */
const shellRelic = (id: string, status: MissionState["status"] = "active"): MissionState => ({
  id,
  objective: "硬崩遗物目标",
  createdAt: "2026-09-01T00:00:00.000Z",
  status,
  tasks: [],
});

/** A non-empty active relic: a task exists → the campaign actually started →
 *  跨会话续作 is the feature, boot must NEVER settle it. */
const taskedRelic = (id: string): MissionState => ({
  id,
  objective: "跨会话续作目标",
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "active",
  tasks: [{ id: "t1", title: "续作任务", dependsOn: [], status: "todo", attempts: 0 }],
});

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("ω99-40 — boot 时结算空壳遗物（SIGKILL 窗口的终态保证）", () => {
  it("红例① 空壳遗物 → 构造即结算：归档落 stale、指针 summary 同步、零通知（boot 静默修复）", async () => {
    await seedRelic(shellRelic("mboot1"));
    const notices: string[] = [];
    const c = await fresh(notices);
    expect(c.snapshot()?.status).toBe("stale"); // RED pre-fix
    const a = (await readJson(archiveOf("mboot1"))) as { mission: MissionState };
    expect(a.mission.status).toBe("stale"); // 终局快照在归档里
    const pointer = (await readJson(pointerPath())) as { missionId: string; summary: { status: string } };
    expect(pointer.missionId).toBe("mboot1");
    expect(pointer.summary.status).toBe("stale"); // 指针 summary 同步
    expect(notices).toEqual([]); // 静默——用户无需知道上个进程崩了
  });

  it("验收② 非空 active 遗物 → 构造后仍 active（跨会话续作是特性，boot 只碰空壳）", async () => {
    await seedRelic(taskedRelic("mboot2"));
    const notices: string[] = [];
    const c = await fresh(notices);
    expect(c.snapshot()?.status).toBe("active");
    expect(c.snapshot()?.tasks[0]?.status).toBe("todo");
    expect(notices.join("\n")).toContain("已恢复"); // 恢复面照常（非结算面）
    const after = await loadMissionStore({ workspaceRoot: ws });
    expect(after.mission?.status).toBe("active");
  });

  it("验收③ 终态遗物（已 stale）→ 零写入（幂等：内容与 mtime 皆不变）", async () => {
    await seedRelic(shellRelic("mboot3", "stale"));
    const archiveBefore = await readFile(archiveOf("mboot3"), "utf8");
    const pointerBefore = await readFile(pointerPath(), "utf8");
    const aStat = await stat(archiveOf("mboot3"));
    const pStat = await stat(pointerPath());
    const c = await fresh();
    expect(c.snapshot()?.status).toBe("stale"); // 终态遗物原样载入
    await delay(15); // 任何重写都会撞上新 mtime
    expect(await readFile(archiveOf("mboot3"), "utf8")).toBe(archiveBefore);
    expect((await stat(archiveOf("mboot3"))).mtimeMs).toBe(aStat.mtimeMs);
    expect(await readFile(pointerPath(), "utf8")).toBe(pointerBefore);
    expect((await stat(pointerPath())).mtimeMs).toBe(pStat.mtimeMs);
  });

  it("验收④ 结算写失败（目录只读）→ 构造不抛、controller 可用、一次性 stderr 行、盘上遗物原样", async () => {
    await seedRelic(shellRelic("mboot4"));
    await chmod(missionsDir(), 0o555); // 只读归档目录——writeAtomic 的 tmp 落不下去
    const stderrLines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    let c: Awaited<ReturnType<typeof fresh>> | undefined;
    try {
      c = await fresh(); // 不抛——结算失败不是 boot 失败
    } finally {
      spy.mockRestore();
      await chmod(missionsDir(), 0o755); // 还原给 afterEach 清理
    }
    expect(c?.refusal).toBeUndefined(); // controller 可用（非 refused）
    expect(c?.status()).not.toContain("⚠️");
    // 盘上遗物原样（原子写：无半写）——下个边界/boot 重试。
    const a = (await readJson(archiveOf("mboot4"))) as { mission: MissionState };
    expect(a.mission.status).toBe("active");
    expect(stderrLines.filter((l) => l.includes("结算"))).toHaveLength(1); // 一次性 stderr 行
  });

  it("验收⑤ 正常 boot（无 mission）→ 纯 no-op（零通知、不落任何文件）", async () => {
    const notices: string[] = [];
    const c = await fresh(notices);
    expect(c.snapshot()).toBeUndefined();
    expect(c.refusal).toBeUndefined();
    expect(notices).toEqual([]);
    expect(existsSync(join(ws, ".wudao"))).toBe(false); // 连目录都不建
  });
});
