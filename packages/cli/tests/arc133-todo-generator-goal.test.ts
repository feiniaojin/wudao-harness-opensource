// 133 #4（a reference harness collection-planner 轻量形）— goal 续跑缝的工作集生成器
// 集成收据：not-yet 组装（四闸附加扩板指令）、封盘一次性 notify、板增长
// 重置无增长计数、板契约字节零改动（指令走 block-reason 车道）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@wudao-org/core";
import { createGoalController, type EvaluatorModel, type GoalController } from "../src/goal.js";

let ws: string;
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), "arc133-todo-gen-"));
});
afterEach(async () => {
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
});

const NOT_YET = ["VERDICT: not-yet\nreal work remains"];

function fixture(verdicts: readonly string[], messages: AgentState["messages"], generatorPolicy?: import("@wudao-org/core").TodoGeneratorPolicy) {
  const responses = verdicts.map((v) => ({ role: "assistant" as const, content: v }));
  let i = 0;
  const evalModel: EvaluatorModel = {
    client: { generate: async () => responses[i++] ?? (i = 1, responses[0]!) } as never,
    label: "test-eval",
    fallback: false,
  };
  const notices: string[] = [];
  const controller = createGoalController({
    workspaceRoot: ws,
    sessionId: () => "s-gen",
    getMessages: () => messages,
    evaluator: evalModel,
    appendEntry: async () => {},
    notify: (t) => notices.push(t),
    ...(generatorPolicy !== undefined ? { generatorPolicy } : {}),
    env: {},
  });
  return { controller, notices, messages };
}

/** 板工具消息（todo_write 的结果形——头行权威 + marks 行）。 */
const boardMsg = (done: number, total: number, lines: string[]) => ({
  role: "tool" as const,
  toolCallId: "c1",
  name: "todo_write",
  content: [`[todo board ${done}/${total} done]`, ...lines].join("\n"),
});

const state = (messages: AgentState["messages"]): AgentState => ({
  systemPrompt: "s",
  messages,
  tools: [],
  status: "running",
});

/** 阻断决断的 reason（allow 决断 → 空串）。 */
const reasonOf = (d: unknown): string => (typeof d === "object" && d !== null && "reason" in d ? String((d as { reason?: unknown }).reason ?? "") : "");

describe("133 #4 — goal 续跑缝的工作集生成器", () => {
  it("板将耗尽（在飞<帽）→ not-yet 附加扩板指令；评估指导仍在场", async () => {
    const messages: AgentState["messages"] = [
      { role: "user", content: "audit everything" },
      boardMsg(2, 3, ["☑ a", "☑ b", "☐ c"]),
    ];
    const f = fixture(NOT_YET, messages);
    await f.controller.set("audit all files");
    const d = await f.controller.onStop(state(f.messages));
    expect(d).toEqual({ block: true, reason: `goal not yet met — evaluator guidance: real work remains\n[工作集生成] todo 板只剩 1 项在飞（done 2/3）。若任务集合还有未覆盖的工作，请立即用 todo_write 从中派生下一批工作项（一次一批，别等板清空再扩）；若集合已穷尽，把剩余项做完即可，不要为扩而扩。` });
  });

  it("在飞充足（frontier 忙）→ 无指令；无板 → 无指令", async () => {
    const busy: AgentState["messages"] = [
      boardMsg(0, 3, ["☐ a", "☐ b", "☐ c"]),
    ];
    const f1 = fixture(NOT_YET, busy);
    await f1.controller.set("g");
    expect(await f1.controller.onStop(state(f1.messages))).toEqual({ block: true, reason: "goal not yet met — evaluator guidance: real work remains" });
    const noBoard: AgentState["messages"] = [{ role: "user", content: "go" }];
    const f2 = fixture(NOT_YET, noBoard);
    await f2.controller.set("g");
    expect(await f2.controller.onStop(state(f2.messages))).toEqual({ block: true, reason: "goal not yet met — evaluator guidance: real work remains" });
  });

  it("板增长重置无增长；指令继续到来", async () => {
    const messages: AgentState["messages"] = [boardMsg(2, 3, ["☑ a", "☑ b", "☐ c"])];
    const f = fixture(NOT_YET, messages);
    await f.controller.set("g");
    const d1 = await f.controller.onStop(state(f.messages));
    expect(reasonOf(d1).includes("工作集生成")).toBe(true);
    // 模型扩了板（3→6 项）并完成一项（done 2→3）——用最新板替换
    messages[messages.length - 1] = boardMsg(3, 6, ["☑ a", "☑ b", "☑ c", "☐ d", "☐ e", "☐ f"]);
    const d2 = await f.controller.onStop(state(f.messages));
    // 在飞=3 ≥ frontierTarget → frontier 忙，本轮无指令（闸的真实转向）
    expect(reasonOf(d2).includes("工作集生成")).toBe(false);
  });

  it("有新完成但连续不扩（模型忽略指令）→ 封盘通知恰一次，此后不再扩", async () => {
    // 紧治理策略（熔断须可调——默认帽下在飞<3 时最多 2 轮新完成，error
    // 难触发；这是设计事实，policy 旋钮就是为此存在）。
    const POLICY = { frontierTarget: 5, maxPlannerRuns: 10, maxNoGrowthRounds: 2 };
    // 10 项板：done 每轮 +2（过新完成闸），total 恒 10（模型忽略扩板指令）。
    const lines = (done: number) => [
      ...Array.from({ length: done }, (_, i) => `☑ item ${i + 1}`),
      ...Array.from({ length: 10 - done }, (_, i) => `☐ item ${done + i + 1}`),
    ];
    const messages: AgentState["messages"] = [boardMsg(6, 10, lines(6))];
    const f = fixture(NOT_YET, messages, POLICY);
    await f.controller.set("g");
    // 轮 1：在飞 4 < 5 → 首扩豁免 → 指令
    let d = await f.controller.onStop(state(f.messages));
    expect(reasonOf(d).includes("工作集生成")).toBe(true);
    // 轮 2：done 8（新完成过闸），total 不变 → 无增长=1，指令再来
    messages[messages.length - 1] = boardMsg(8, 10, lines(8));
    d = await f.controller.onStop(state(f.messages));
    expect(reasonOf(d).includes("工作集生成")).toBe(true);
    // 轮 3：noGrowthRounds=2 到帽 → 封盘（通知恰一次，指令停发）
    messages[messages.length - 1] = boardMsg(10, 10, lines(10));
    d = await f.controller.onStop(state(f.messages));
    expect(reasonOf(d).includes("工作集生成")).toBe(false);
    const exhaustNotices = f.notices.filter((n) => n.includes("封盘"));
    expect(exhaustNotices.length).toBe(1);
    expect(exhaustNotices[0]).toContain("error_threshold");
    // 之后再钩子：不重复通知、不再扩
    await f.controller.onStop(state(f.messages));
    expect(f.notices.filter((n) => n.includes("封盘")).length).toBe(1);
  });

  it("goal 关闭后生成器状态重置（新 goal 首扩豁免重临）", async () => {
    const messages: AgentState["messages"] = [boardMsg(2, 3, ["☑ a", "☑ b", "☐ c"])];
    const f = fixture(NOT_YET, messages);
    await f.controller.set("g");
    await f.controller.onStop(state(f.messages));
    await f.controller.clear();
    await f.controller.set("g2");
    const d = await f.controller.onStop(state(f.messages));
    // 新 goal：plannerRuns 归零 → 首扩豁免 → 指令再来（且基线重置为当前板）
    expect(reasonOf(d).includes("工作集生成")).toBe(true);
  });
});
