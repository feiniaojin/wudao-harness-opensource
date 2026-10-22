// 多 driver 并发弧 A — the lane manager's cli 域行为面：N 个 driver 并发
// （主车道 + 副车道池），每车道独立 sessionId/独立租约槽（多槽盒）。
//   - 生命周期：open（幂等）/close（释放租约+dispose）/activeLanes/main
//   - 隔离：车道 A 的 run 挂起不影响车道 B 跑完落盘（互不渗漏）
//   - 纪律：主车道不可 close；副车道降配 preset（无 schedules/cron/memory/
//     extraTools/hooks/extensions——进程单例面随主车道）
//   - 诚实拒绝：他进程持锁的会话 open 直接失败（引擎 boot lease 同款回执）
// ★红线（09-09 用户令）：夹具只写 mkdtemp(os.tmpdir())，全程不删任何文件。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool } from "@wudao/core";
import type { ModelClient, ModelInput } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { createDriverSession } from "../src/driver/session-engine.js";
import type { DriverSession, DriverSessionOptions } from "../src/driver/session-engine.js";
import type { ScheduleDaemon } from "../src/schedules.js";
import { createLaneManager } from "../src/driver/lane-manager.js";
import type { LaneManager } from "../src/driver/lane-manager.js";
import { TITLE_QUERY_SOURCE } from "../src/session-title.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

/** A model that answers instantly and never trips the auto-title fork. */
function fastModel(reply: string): ModelClient {
  return {
    async generate(input: ModelInput) {
      if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
      return { role: "assistant", content: reply };
    },
  };
}

/** A model whose FIRST conversation call hangs until released (busy pin). */
function heldModel(gate: Promise<void>, reply: string): ModelClient {
  let first = true;
  return {
    async generate(input: ModelInput) {
      if (input.querySource === TITLE_QUERY_SOURCE) return { role: "assistant", content: "标题" };
      if (first) {
        first = false;
        await gate;
      }
      return { role: "assistant", content: reply };
    },
  };
}

const laneBase = (root: string, modelOverride: ModelClient): DriverSessionOptions => ({
  config,
  workspaceRoot: root,
  contextWindowTokens: 64_000,
  modelOverride,
  tools: [],
  gates: { verify: false },
});

const lockPath = (root: string, id: string): string => join(root, ".wudao", "sessions", ".leases", `${id}.json`);

const sessions: DriverSession[] = [];
const managers: LaneManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) {
    for (const id of m.activeLanes().slice(1)) await m.close(id).catch(() => {});
  }
  for (const s of sessions.splice(0)) await s.close().catch(() => {});
});

describe("多 driver 并发弧 A — lane manager 生命周期", () => {
  it("(a) open 建独立车道：多槽锁各自落盘、activeLanes 主前副后、get/main 各归其位", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-a-"));
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-OK")) });
    managers.push(lm);

    const sideA = await lm.open("lane-a");
    const sideB = await lm.open("lane-b");
    expect(sideA.getSessionId()).toBe("lane-a");
    expect(sideB.getSessionId()).toBe("lane-b");
    expect(sideA).not.toBe(sideB);
    expect(lm.main()).toBe(main.driver);
    expect(lm.main()).not.toBe(sideA);
    // 三把锁并存：多槽盒不 ping-pong（单槽盒会在 lane-b acquire 时放掉 lane-a）。
    expect(existsSync(lockPath(root, "main-lane"))).toBe(true);
    expect(existsSync(lockPath(root, "lane-a"))).toBe(true);
    expect(existsSync(lockPath(root, "lane-b"))).toBe(true);
    expect(lm.activeLanes()).toEqual(["main-lane", "lane-a", "lane-b"]);
    expect(lm.get("lane-a")).toBe(sideA);
    expect(lm.get("main-lane")).toBe(main.driver);
    expect(lm.get("nope")).toBeUndefined();
  });

  it("(b) 幂等：重复 open 同 id 返回现有实例；open 主车道当前 id 返回主 driver", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-b-"));
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-OK")) });
    managers.push(lm);

    const once = await lm.open("lane-a");
    const twice = await lm.open("lane-a");
    expect(twice).toBe(once);
    expect(lm.activeLanes()).toEqual(["main-lane", "lane-a"]);
    // 主车道当前 id 的 open = 主车道本身（不建副车道、不再开锁）。
    const viaMain = await lm.open("main-lane");
    expect(viaMain).toBe(main.driver);
    expect(lm.activeLanes()).toEqual(["main-lane", "lane-a"]);
  });

  it("(c) close 释放本车道租约+dispose：锁文件消失、兄弟车道不动、未知 id 幂等 no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-c-"));
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-OK")) });
    managers.push(lm);

    const a = await lm.open("lane-a");
    const b = await lm.open("lane-b");
    await lm.close("lane-a");
    expect(existsSync(lockPath(root, "lane-a"))).toBe(false);
    expect(existsSync(lockPath(root, "lane-b"))).toBe(true);
    expect(existsSync(lockPath(root, "main-lane"))).toBe(true);
    expect(lm.activeLanes()).toEqual(["main-lane", "lane-b"]);
    expect(lm.get("lane-a")).toBeUndefined();
    expect(lm.get("lane-b")).toBe(b);
    // 未知 id 的 close 是 no-op；已关车道的再 close 同样幂等。
    await lm.close("never-opened");
    await lm.close("lane-a");
    expect(lm.activeLanes()).toEqual(["main-lane", "lane-b"]);
    // close 后可重开（座位已清）。
    const reopened = await lm.open("lane-a");
    expect(reopened).not.toBe(a);
  });

  it("(d) 主车道不可 close：显式 throw（主车道随宿主进程存亡）", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-d-"));
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-OK")) });
    managers.push(lm);

    await expect(lm.close("main-lane")).rejects.toThrow(/主车道不可关闭/);
    expect(existsSync(lockPath(root, "main-lane"))).toBe(true);
    expect(lm.main().getSessionId()).toBe("main-lane");
  });

  it("(e) 他进程持锁的会话 open 诚实失败（boot lease occupied 同款回执），车道表不受污染", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-e-"));
    // 种一个活体外部持有者（本 pid 活着且不在租约注册表——与真进程无异）。
    mkdirSync(join(root, ".wudao", "sessions", ".leases"), { recursive: true });
    writeFileSync(lockPath(root, "held-x"), JSON.stringify({ pid: process.pid, at: new Date().toISOString(), gen: "foreign" }), "utf8");
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-OK")) });
    managers.push(lm);

    await expect(lm.open("held-x")).rejects.toThrow(/held-x/);
    expect(lm.activeLanes()).toEqual(["main-lane"]);
    expect(lm.get("held-x")).toBeUndefined();
    // 失败不占用座位：此后开别的车道照常，held-x 不在车道表。
    const ok = await lm.open("clean-lane");
    expect(ok.getSessionId()).toBe("clean-lane");
    expect(lm.activeLanes()).toEqual(["main-lane", "clean-lane"]);
  });
});

describe("多 driver 并发弧 A — 车道隔离（并发 busy）", () => {
  it("(f) 车道 A 的 run 挂起时车道 B 照常跑完落盘：busy 是 per-lane 的，互不 steer、互不渗漏", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-f-"));
    let releaseMain!: () => void;
    const gateMain = new Promise<void>((r) => {
      releaseMain = r;
    });
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const main = await createDriverSession({
      ...laneBase(root, heldModel(gateMain, "MAIN-DONE")),
      sessionId: "main-lane",
    });
    sessions.push(main);
    const lm = createLaneManager({ main, base: laneBase(root, fastModel("SIDE-B-DONE")) });
    managers.push(lm);

    // 主车道 run 挂起（busy 钉）。
    main.driver.submit("主车道长任务");
    await until(() => main.driver.getStatus().busy === true, "main lane busy");

    // 车道 A 用挂起模型（opts 的 modelOverride 覆盖面——preset 不钉模型），
    // 车道 B 沿 base 的快模型：A 挂着、B 跑完——busy per-lane。
    const sideA = await lm.open("lane-a", { modelOverride: heldModel(gateA, "SIDE-A-DONE") });
    const sideB = await lm.open("lane-b");
    sideA.submit("车道A的问题");
    sideB.submit("车道B的问题");
    await until(() => sideA.getStatus().busy === true, "lane-a busy");
    // B 在 A 与主车道同时挂起时照常跑完落盘。
    await until(
      () => {
        try {
          return readFileSync(join(root, ".wudao", "sessions", "lane-b.jsonl"), "utf8").includes("SIDE-B-DONE");
        } catch {
          return false;
        }
      },
      "lane-b run settles while main + lane-a are held",
    );
    // 三态钉：主/A 忙、B 已闲（同一进程三个并发 driver，busy 互不串台）。
    expect(main.driver.getStatus().busy).toBe(true);
    expect(sideA.getStatus().busy).toBe(true);
    expect(sideB.getStatus().busy).toBe(false);

    // 泄漏钉：B 的交换不进主车道/车道 A 的转写。
    expect(readFileSync(join(root, ".wudao", "sessions", "lane-b.jsonl"), "utf8")).not.toContain("主车道长任务");
    try {
      const aText = readFileSync(join(root, ".wudao", "sessions", "lane-a.jsonl"), "utf8");
      expect(aText).not.toContain("SIDE-B-DONE");
    } catch {
      /* lane-a fresh boot 未 settle → 文件未物化（ω99-211 落盘延迟）——本就无泄漏 */
    }

    releaseA();
    releaseMain();
    await until(() => main.driver.getStatus().busy === false, "main settles after release");
    await until(() => sideA.getStatus().busy === false, "lane-a settles after release");
  });
});

describe("多 driver 并发弧 A — 副车道降配 preset", () => {
  it("(g) 进程单例面不进副车道：schedules/cron/memory/extraTools/hooks/extensions 全数摘除，mode 恒 auto，租约走多槽 view", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-g-"));
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);

    // base 故意带满毒面：preset 必须把它们全部摘掉（spawn 缝捕获真实入参）。
    const captured: DriverSessionOptions[] = [];
    const lm = createLaneManager({
      main,
      base: {
        ...laneBase(root, fastModel("SIDE-OK")),
        schedule: { stop: () => {} } as unknown as ScheduleDaemon,
        extraTools: [
          buildTool({
            name: "terminal_history_stub",
            description: "poisoned stub",
            parameters: { type: "object", properties: { x: { type: "string" } }, required: [], additionalProperties: false },
            execute: async () => ({ content: "stub" }),
          }),
        ],
        hooks: { onSessionStart: async () => {} },
      },
      spawnSession: async (opts) => {
        captured.push(opts);
        return createDriverSession(opts);
      },
    });
    managers.push(lm);
    await lm.open("lane-g");

    expect(captured).toHaveLength(1);
    const lane = captured[0];
    // —— 任务清单的六项 + pet 清单的进程单例面 ——
    expect(lane.schedule).toBeUndefined(); // 无 schedules 守护
    expect(lane.cronDisabled).toBe(true); // 无 cron（inert refusal）
    expect(lane.memoryDisabled).toBe(true); // 无 memory runtime
    expect(lane.extraTools).toBeUndefined(); // 无 terminal/lsp/MCP/extension 工具
    expect(lane.hooks).toBeUndefined(); // 无 hooks
    expect(lane.extensions).toBeUndefined(); // 无 extensions
    expect(lane.pluginCommands).toBeUndefined();
    expect(lane.pluginAgents).toBeUndefined();
    expect(lane.hookRuntime).toBeUndefined();
    expect(lane.readState).toBeUndefined(); // read-state 表车道隔离
    expect(lane.agentRootBox).toBeUndefined(); // 车道私有盒
    expect(lane.defaultPermissionMode).toBe("auto"); // 车道=托付（无权限卡 UI 的车道不能挂死 run）
    // 车道身份钉：id/历史/租约 view。
    expect(lane.sessionId).toBe("lane-g");
    expect(lane.sessionFresh).toBe(true); // 无历史 → fresh（落盘延迟适用）
    expect(lane.sessionLeases).toBeDefined();
    // 主车道不受 preset 影响（对照组：base 的毒面本就只喂给副车道）。
    expect(lm.main()).toBe(main.driver);
  });

  it("(h) open 已有会话采纳历史（resume 链），fresh 落盘延迟不适用", async () => {
    const root = mkdtempSync(join(tmpdir(), "lane-mgr-h-"));
    // 预置一个既有会话的 JSONL（两轮对话）。
    mkdirSync(join(root, ".wudao", "sessions"), { recursive: true });
    writeFileSync(
      join(root, ".wudao", "sessions", "existing.jsonl"),
      JSON.stringify({ role: "user", content: "早前的问题" }) + "\n" + JSON.stringify({ role: "assistant", content: "早前的回答" }) + "\n",
      "utf8",
    );
    const main = await createDriverSession({ ...laneBase(root, fastModel("MAIN-OK")), sessionId: "main-lane" });
    sessions.push(main);

    const captured: DriverSessionOptions[] = [];
    const lm = createLaneManager({
      main,
      base: laneBase(root, fastModel("SIDE-OK")),
      spawnSession: async (opts) => {
        captured.push(opts);
        return createDriverSession(opts);
      },
    });
    managers.push(lm);
    const driver = await lm.open("existing");

    expect(captured[0].resumeHistory).toHaveLength(2);
    expect(captured[0].sessionFresh).toBe(false);
    // 历史真的进了车道（采纳不是空转）。
    expect(driver.getHistory().some((e) => e.kind === "user" && e.text === "早前的问题")).toBe(true);
  });
});
