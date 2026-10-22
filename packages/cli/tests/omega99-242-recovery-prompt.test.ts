// ω99-242: #6 — verify-first 恢复注入的 cli 面 R 件（R4 + 收据投影 + 半轮证
// 据 + mission 缝 + boot 装配端到端）。★红线：全 mock/脚本化（scripted
// model、stub 工具），夹具只写 tmpdir，禁删用户文件；无真模型调用、无真进程
// 重启（「重启」由两次 coordinator 装配模拟，恢复流程本身在单进程内验证）。
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSrc } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AgentMessage, SessionEntry, Tool } from "@wudao/core";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import {
  buildRecoveryPrompt,
  recoveryCompletedList,
  turnEvidence,
  missionTopoDepth,
  missionPendingDescription,
  missionRemainingCount,
  sessionMissionRank,
  sessionLastCompletedTask,
  hasMissionActivity,
  isRecoveryCandidateId,
  RECOVERY_EXCLUDED_SESSION_IDS,
} from "../src/recovery-admission.js";
import type { MissionState } from "../src/mission.js";

// ★红线（ω99-236 同款立场）：夹具只写 mkdtemp(os.tmpdir())，只写不删。
const tmp = (): string => mkdtempSync(join(tmpdir(), "o242-prompt-"));

// ---------------------------------------------------------------------------
// R4 — the §三 template, byte-pinned in both forms
// ---------------------------------------------------------------------------
describe("R4 verify-first prompt template", () => {
  it("receipts form: the §三 template verbatim with the receipt list interpolated", () => {
    const p = buildRecoveryPrompt(["改动 2 文件：src/a.ts（修改）", "生成交付物 out.xlsx（1024 B）：<root>/out.xlsx"], "任务 t2（写测试）：补 R4 两形字节钉");
    expect(p).toBe(
      "继续之前的任务。上一进程在执行中中断，我已按会话记录对账：\n" +
      "已完成（收据核实）：\n" +
      "改动 2 文件：src/a.ts（修改）\n" +
      "生成交付物 out.xlsx（1024 B）：<root>/out.xlsx\n" +
      "待续：任务 t2（写测试）：补 R4 两形字节钉\n" +
      "请先检查会话与工作区，确认上面「已完成」的部分真实在盘；保留已完成的工作，不要重复已产生副作用的操作；只完成剩余部分。无法确认某一步是否已执行时，停下来问我，不要猜。\n" +
      // ω99-252: #4 — 同形演进：模板尾新增重发引导句（面二），既有句零演进。
      "上一轮被权限挡住的工具调用请原样重发，授权问句会自动浮出；不要改为口头描述或跳过。",
    );
  });

  it("no-receipts form: the whole 已完成 section is omitted (整段省略)", () => {
    const p = buildRecoveryPrompt([], "继续完成夜间批处理任务");
    expect(p).toBe(
      "继续之前的任务。上一进程在执行中中断，我已按会话记录对账：\n" +
      "待续：继续完成夜间批处理任务\n" +
      "请先检查会话与工作区，确认上面「已完成」的部分真实在盘；保留已完成的工作，不要重复已产生副作用的操作；只完成剩余部分。无法确认某一步是否已执行时，停下来问我，不要猜。\n" +
      "上一轮被权限挡住的工具调用请原样重发，授权问句会自动浮出；不要改为口头描述或跳过。",
    );
    expect(p).not.toContain("已完成（收据核实）：");
  });

  it("refuses an empty 待续 interpolant (fail-closed)", () => {
    expect(() => buildRecoveryPrompt([], "")).toThrow();
    expect(() => buildRecoveryPrompt([], "   ")).toThrow();
  });

  it("M24 declaration: the cold-turn note lives in the module source (代码注释声明)", () => {
    const src = readSrc(fileURLToPath(new URL("../src/recovery-admission.ts", import.meta.url)), "utf8");
    expect(src).toContain("cold turn expected");
    expect(src).toContain("冷转预期");
  });
});

// ---------------------------------------------------------------------------
// The receipt projection (收据对账数据源)
// ---------------------------------------------------------------------------
const turnDiff = (text: string, changes: unknown): SessionEntry =>
  ({ type: "turn_diff_receipt", data: { text, ...(changes !== undefined ? { changes } : {}) } }) as SessionEntry;

describe("recoveryCompletedList", () => {
  it("projects turn-diff receipts in file order; malformed payloads drop silently", () => {
    const entries: SessionEntry[] = [
      turnDiff("回合改动：a.ts（修改 ×2）", [{ path: "a.ts", op: "modified", writes: 2 }]),
      { type: "turn_diff_receipt", data: { text: "" } }, // empty text — dropped
      { type: "turn_diff_receipt", data: "not-an-object" }, // junk — dropped
      turnDiff("回合改动：b.ts（新建）", "changes-not-an-array"), // invalid changes — dropped (217 read contract)
      turnDiff("回合改动：c.ts（修改 ×1）", [{ path: "c.ts", op: "modified", writes: 1 }]),
    ];
    const list = recoveryCompletedList(entries);
    expect(list.lines).toEqual([
      "回合改动：a.ts（修改 ×2）",
      "回合改动：c.ts（修改 ×1）",
    ]);
    expect(list.verifiedDone).toBe(2);
  });

  it("adds file-receipt deliverable lines and the tool-call ledger from the chain", () => {
    const receiptJson = JSON.stringify({ path: "/tmp/x/out.xlsx", relativePath: "out.xlsx", rows: 3, bytes: 2048 });
    const entries: SessionEntry[] = [
      { role: "user", content: "生成报表" },
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "c1", name: "make_xlsx", arguments: { path: "out.xlsx" } },
          { id: "c2", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      { role: "tool", toolCallId: "c1", name: "make_xlsx", content: `已生成表格。\n${receiptJson}` },
      { role: "tool", toolCallId: "c2", name: "read_file", content: "file body" },
    ] as unknown as SessionEntry[];
    const list = recoveryCompletedList(entries);
    expect(list.lines).toEqual([
      "生成交付物 out.xlsx（2048 B）：/tmp/x/out.xlsx",
      "工具调用记录：make_xlsx ×1 · read_file ×1",
    ]);
    expect(list.verifiedDone).toBe(1); // the ledger line is not a receipt
  });

  it("an empty projection gives an empty list (the builder then omits the section)", () => {
    expect(recoveryCompletedList([{ type: "run_stats_receipt", data: { text: "耗时 30 秒" } } as SessionEntry]).lines).toEqual([]);
  });

  it("caps the list at 30 receipt lines with an honest fold prefix", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 33; i += 1) {
      entries.push(turnDiff(`回合 ${i} 改动：f${i}.ts`, [{ path: `f${i}.ts`, op: "modified", writes: 1 }]));
    }
    const list = recoveryCompletedList(entries);
    expect(list.lines[0]).toBe("……（更早 3 条收据略）");
    expect(list.lines).toHaveLength(31); // fold + 30
    expect(list.verifiedDone).toBe(33);
  });
});

// ---------------------------------------------------------------------------
// Half-turn evidence (§二.4)
// ---------------------------------------------------------------------------
describe("turnEvidence", () => {
  it("closed: the chain ends with a plain assistant message", () => {
    expect(turnEvidence([{ role: "user", content: "hi" }, { role: "assistant", content: "done" }]))
      .toEqual({ turnOpen: false, childPending: false });
  });

  it("open: a trailing user turn (submit landed, no reply)", () => {
    expect(turnEvidence([{ role: "assistant", content: "prev" }, { role: "user", content: "继续" }]))
      .toEqual({ turnOpen: true, childPending: false });
  });

  it("open: assistant tool calls whose results never landed (the orphaned-call crash shape)", () => {
    expect(turnEvidence([
      { role: "user", content: "跑测试" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] },
    ] as unknown as AgentMessage[])).toEqual({ turnOpen: true, childPending: false });
  });

  it("open: a trailing tool result (the loop never wrote the closing assistant)", () => {
    expect(turnEvidence([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "body" },
    ] as unknown as AgentMessage[])).toEqual({ turnOpen: true, childPending: false });
  });

  it("blocked shape: the open turn is waiting on a delegated child (父等子)", () => {
    expect(turnEvidence([
      { role: "user", content: "委派子任务" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "task", arguments: { prompt: "x" } }] },
    ] as unknown as AgentMessage[])).toEqual({ turnOpen: true, childPending: true });
  });
});


// ---------------------------------------------------------------------------
// The mission seam (待续 + DAG rank + boot-scan filter)
// ---------------------------------------------------------------------------
const mission = (tasks: MissionState["tasks"], status: MissionState["status"] = "active"): MissionState => ({
  id: "m1", objective: "完成夜间迁移", createdAt: "2026-09-01T00:00:00Z", status, tasks,
});

describe("mission seam", () => {
  it("topo depth: roots 0, dependents one past their deepest dep", () => {
    const m = mission([
      { id: "t1", title: "A", dependsOn: [], status: "done", attempts: 0 },
      { id: "t2", title: "B", dependsOn: ["t1"], status: "todo", attempts: 0 },
      { id: "t3", title: "C", dependsOn: [], status: "todo", attempts: 0 },
    ]);
    const depth = missionTopoDepth(m.tasks);
    expect(depth.get("t1")).toBe(0);
    expect(depth.get("t2")).toBe(1);
    expect(depth.get("t3")).toBe(0);
  });

  it("pending description: the earliest READY task with id+title+detail; remaining counts todo+doing", () => {
    const m = mission([
      { id: "t1", title: "A", dependsOn: [], status: "done", attempts: 0 },
      { id: "t2", title: "B", dependsOn: ["t1"], status: "todo", attempts: 0, detail: "细节X" },
      { id: "t3", title: "C", dependsOn: ["t2"], status: "todo", attempts: 0 },
    ]);
    expect(missionPendingDescription(m)).toBe("任务 t2（B）：细节X");
    expect(missionRemainingCount(m)).toBe(2);
    expect(missionPendingDescription(null)).toBe("");
    expect(missionRemainingCount(null)).toBe(1); // mission-less: the one interrupted turn
  });

  it("session rank: last mission_complete marker +1 on the DAG; unbound → Infinity", () => {
    const m = mission([
      { id: "t1", title: "A", dependsOn: [], status: "done", attempts: 0 },
      { id: "t2", title: "B", dependsOn: ["t1"], status: "doing", attempts: 0 },
    ]);
    const doneA: SessionEntry[] = [
      { role: "user", content: "开工" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "mission_complete", arguments: { taskId: "t1", result: "ok" } }] },
    ] as unknown as SessionEntry[];
    expect(sessionLastCompletedTask(doneA.filter((e): e is AgentMessage => "role" in e))).toBe("t1");
    expect(sessionMissionRank(doneA, m)).toBe(1); // depth(t1)=0 → next work at 1
    const noMission: SessionEntry[] = [{ role: "user", content: "闲聊" }] as unknown as SessionEntry[];
    expect(sessionMissionRank(noMission, m)).toBe(Number.POSITIVE_INFINITY);
    expect(hasMissionActivity(doneA)).toBe(true);
    expect(hasMissionActivity(noMission)).toBe(false);
  });

  it("excluded lane ids are never candidates", () => {
    for (const id of RECOVERY_EXCLUDED_SESSION_IDS) expect(isRecoveryCandidateId(id)).toBe(false);
    expect(isRecoveryCandidateId("side-abc")).toBe(false);
    expect(isRecoveryCandidateId("nighttask01")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The boot wiring, end to end (scripted model — no real model calls)
// ---------------------------------------------------------------------------
describe("boot wiring (startUiSession + coordinator)", () => {
  it("recovers a checkpointed half-turn session: resume + verify-first submit, journal claim→settle", async () => {
    const { startUiSession } = await import("../src/ui.js");
    const root = tmp();
    // The previous process's night session: a half-open turn + the journal's
    // shutdown checkpoint for it.
    const nightId = "nighttask01";
    const sessionsDir = join(root, ".wudao", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, `${nightId}.jsonl`), [
      JSON.stringify({ role: "user", content: "夜里把迁移做完" }),
      JSON.stringify({ role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: "pnpm test" } }] }),
    ].join("\n") + "\n", "utf8");
    writeFileSync(join(root, ".wudao", "recovery.jsonl"),
      `${JSON.stringify({ type: "checkpoint", sessionId: nightId, at: 1 })}\n`, "utf8");

    const config: ProviderConfig = { apiKey: "k", baseURL: "http://127.0.0.1:1/v1", model: "fake" };
    const model = createScriptedModel([{ role: "assistant", content: "NIGHT-CONTINUED" }]);
    const session = await startUiSession({
      config,
      workspaceRoot: root,
      contextWindowTokens: 64000,
      modelOverride: model,
      tools: [] as readonly Tool[],
      announce: false,
    } as never);
    try {
      // The coordinator ticks on its real 2s interval — wait for the recovery
      // admission to land (resume + submit + settle).
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        if (session.driver.getSessionId() === nightId) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(session.driver.getSessionId()).toBe(nightId);
      // …then the settle ACK lands after the submit returns (the run may
      // still be draining) — wait for the journal to complete the discipline.
      const journalPath = join(root, ".wudao", "recovery.jsonl");
      const deadline2 = Date.now() + 12_000;
      while (Date.now() < deadline2) {
        const types = readFileSync(journalPath, "utf8").trim().split("\n").map((l) => (JSON.parse(l) as { type: string }).type);
        if (types.includes("settle") || types.includes("cancel")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      // The verify-first prompt landed as the recovery turn (§三 header).
      const userTurns = session.driver.getHistory().filter((e) => (e as { kind?: string }).kind === "user");
      expect(userTurns.some((e) => String((e as { text?: string }).text).startsWith("继续之前的任务。上一进程在执行中中断"))).toBe(true);
      // The journal carries the discipline: checkpoint → claim → settle.
      const journal = readFileSync(journalPath, "utf8").trim().split("\n")
        .map((l) => JSON.parse(l) as { type: string });
      expect(journal.map((e) => e.type)).toEqual(["checkpoint", "claim", "settle"]);
    } finally {
      await session.close();
    }
  }, 20_000);
});
