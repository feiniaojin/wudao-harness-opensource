// ω99-19 — mission 启动入口通用化（brief: mission_start 工具 + driver/desktop
// slash 面）。E1-E3 钉工具面（createMissionTools 尾部追加的第 9 件），E4-E8 钉
// driver 的 /mission slash 真路由（此前是 ω99-15 的响指针占位）。零真 shell、
// 零网络：controller 全用 fake 对象，driver 用离线 script model（mission slash
// 路径不拨号，model 仅为满足接口）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, Tool } from "@wudao-org/core";
import { createMissionTools, type MissionController } from "../src/mission.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "m81-entry-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

/** A recording stub controller — every call logged verbatim (the m81-mission
 *  P8 stub pattern); start/abandon/status are the three faces this arc wires. */
function stubController(
  log: string[],
  behavior: { startResult?: string; throwIn?: "start" | "abandon" | "status" } = {},
): MissionController {
  return {
    start: async (o) => {
      log.push(`start:${o}`);
      if (behavior.throwIn === "start") throw new Error("boom-start");
      return behavior.startResult ?? `🚩 mission 已创建：${o}`;
    },
    abandon: async () => {
      log.push("abandon");
      if (behavior.throwIn === "abandon") throw new Error("boom-abandon");
      return "mission 已放弃";
    },
    status: () => {
      log.push("status");
      if (behavior.throwIn === "status") throw new Error("boom-status");
      return "mission status one-pager";
    },
    plan: async () => ({ ok: true, text: "planned" }),
    nextReady: async () => ({ text: "no" }),
    claim: async () => ({ task: undefined, text: "no" }),
    complete: async () => ({ ok: true, text: "done" }),
    fail: async () => ({ ok: true, text: "failed" }),
    ratchetCheck: async () => ({ ok: true, text: "ok" }),
    knowAdd: async () => ({ ok: true, text: "ok" }),
    know: async () => ({ ok: true, text: "ok" }),
    bundle: async () => ({ ok: true, text: "ok" }),
    snapshot: () => undefined,
  } as unknown as MissionController;
}

const stubModel: ModelClient = {
  async generate() {
    return { role: "assistant", content: "" };
  },
} as unknown as ModelClient;

/** Minimal offline driver (the m61-goal §3 paradigm). missionBox ABSENT when
 *  the argument is omitted (E7's no-opt arm), present when passed. */
function mkDriver(missionBox?: { current?: MissionController }): AgentDriver {
  return createAgentDriver({
    model: stubModel,
    tools: [],
    systemPrompt: "sp",
    summarize: summarizeToolCall,
    workspaceRoot: ws,
    statusline: { model: "test-model", version: "0" },
    ...(missionBox !== undefined ? { missionBox } : {}),
  });
}

describe("ω99-19 E1-E3 — mission_start 工具面（createMissionTools 第 9 件，尾部追加）", () => {
  it("E1: the nine-tool face carries mission_start at the tail (annotations 四 false; objective required)", () => {
    const tools = createMissionTools(() => undefined);
    expect(tools.map((t) => t.name)).toEqual([
      "mission_plan",
      "mission_next",
      "mission_complete",
      "mission_fail",
      "mission_ratchet",
      "mission_know_add",
      "mission_know",
      "mission_bundle",
      "mission_start",
    ]);
    const start = tools[8]!;
    expect(start.description).toContain("mission_plan");
    // Fail-closed risk annotations: a state writer like its eight siblings.
    expect(start.isReadOnly?.({})).toBe(false);
    expect(start.isDestructive?.({})).toBe(false);
    expect(start.isOpenWorld?.({})).toBe(false);
    expect(start.isConcurrencySafe?.({})).toBe(false);
    // Schema: objective is the one required input.
    expect(Object.keys(start.parameters.properties)).toEqual(["objective"]);
    expect(start.parameters.required).toEqual(["objective"]);
  });

  it("E2: mission_start passes the objective straight to controller.start and returns its notice", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log) };
    const tools = createMissionTools(() => box.current);
    const byName = new Map<string, Tool>(tools.map((t) => [t.name, t]));
    const r = await byName.get("mission_start")!.execute({ objective: "ship the big feature" });
    expect(r.content).toBe("🚩 mission 已创建：ship the big feature");
    expect(log).toEqual(["start:ship the big feature"]);
  });

  it("E3: a rejecting start notice passes through verbatim; empty/absent objective refuses BEFORE the controller", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = {
      current: stubController(log, { startResult: "⚠️ 已有进行中的 mission — /mission 查看状态" }),
    };
    const tools = createMissionTools(() => box.current);
    const start = tools.find((t) => t.name === "mission_start")!;
    const r = await start.execute({ objective: "another" });
    expect(r.content).toBe("⚠️ 已有进行中的 mission — /mission 查看状态");
    expect(r.isError).toBeUndefined(); // 直通：controller 文案即结果，不加工
    // Argument validation fires BEFORE the controller is touched (zero calls).
    const blank = await start.execute({ objective: "   " });
    expect(blank.isError).toBe(true);
    const absent = await start.execute({});
    expect(absent.isError).toBe(true);
    expect(log).toEqual(["start:another"]);
    // An empty box (controller not yet created) is a loud refusal.
    box.current = undefined;
    const none = await start.execute({ objective: "x" });
    expect(none.isError).toBe(true);
  });
});

describe("ω99-19 E4-E8 — driver /mission slash 面（desktop/web 输入框入口）", () => {
  it("E4/E5/E6: bare → status(); clear → abandon(); <objective> → start(objective)", async () => {
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log) };
    const driver = mkDriver(box);
    try {
      driver.submit("/mission");
      await until(() => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("mission status one-pager")), "status notice");
      driver.submit("/mission clear");
      await until(() => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("mission 已放弃")), "abandon notice");
      driver.submit("/mission 把整个系统迁移到新架构");
      await until(() => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("🚩 mission 已创建")), "start notice");
      expect(log).toEqual(["status", "abandon", "start:把整个系统迁移到新架构"]);
    } finally {
      driver.dispose();
    }
  });

  it("E7: no missionBox (or an unfilled box) → the loud pointer notice, never a silent no-op", async () => {
    const driver = mkDriver(); // opt absent — a driver outside the session engine
    try {
      const out = driver.submit("/mission");
      expect(out).toBe("notice");
      // ω99-165: 钉随源演进（agent-driver.ts :5621 中文化，B2 授权同弧收口）。
      await until(() => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("无任务战役界面")), "pointer notice (no opt)");
    } finally {
      driver.dispose();
    }
    const empty = mkDriver({ current: undefined }); // box present, controller not yet filled
    try {
      empty.submit("/mission start something");
      // ω99-165: 钉随源演进（同上，断源 agent-driver.ts :5621）。
      await until(() => empty.getHistory().some((h) => h.kind === "notice" && h.text.includes("无任务战役界面")), "pointer notice (empty box)");
    } finally {
      empty.dispose();
    }
  });

  it("E8: a throwing controller surfaces as the fail-loud ⚠️ /mission 失败 notice", async () => { // ω99-166c-i: 描述串随 #27 演进。
    const log: string[] = [];
    const box: { current?: MissionController } = { current: stubController(log, { throwIn: "status" }) };
    const driver = mkDriver(box);
    try {
      driver.submit("/mission");
      await until(() => driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("⚠️ /mission 失败：boom-status")), "failure notice"); // ω99-166c-i: #27 正钉随改。
    } finally {
      driver.dispose();
    }
  });
});
