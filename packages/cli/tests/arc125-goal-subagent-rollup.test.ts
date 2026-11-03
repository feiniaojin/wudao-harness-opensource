// 125 项 3（codex 预算上卷 4761851ff3 形）— GoalRuntime 的子代理用量归账面：
// onSubagentUsage 汇入计数器（childId 去重计子代理数），query/statusLine/
// webSnapshot 展示「子代理累计」，settle 行落盘，restore 续算；扇出用量
// 永不进预算触发（ω99-8b 分区）。含 task-tool-support 的 childId 盖章与
// session-engine 的接线面（源码缝断言）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { GenericSessionEntry } from "@wudao-org/core";
import { createGoalRuntime } from "../src/goal-runtime.js";
import { subagentEventWithUsage } from "../src/agents/task-tool-support.js";
import type { GoalRuntime } from "../src/goal-runtime.js";
import type { MissionState, MissionTask } from "../src/mission.js";

// —— omega99-249-goal-mission.test.ts 同款夹具 ————————————————
const task = (id: string, over: Partial<MissionTask> = {}): MissionTask => ({
  id,
  title: `任务 ${id}`,
  dependsOn: [],
  status: "todo",
  attempts: 0,
  ...over,
});
const mission = (tasks: readonly MissionTask[]): MissionState => ({
  id: "m1",
  objective: "完成发布",
  createdAt: "2026-09-26T00:00:00.000Z",
  status: "active",
  tasks,
});

const makeRuntime = (): { runtime: GoalRuntime; entries: GenericSessionEntry[] } => {
  const ledger = { current: mission([task("t1", { status: "doing", budgetTokens: 5000 })]) };
  const entries: GenericSessionEntry[] = [];
  const runtime = createGoalRuntime({
    appendEntry: async (entry) => { entries.push(entry); },
    getMission: () => ledger.current,
  });
  return { runtime, entries };
};

const goalRows = (entries: readonly GenericSessionEntry[]): Record<string, unknown>[] =>
  entries.filter((e) => e.type === "goal_state") as unknown as Record<string, unknown>[];

const usage = (promptTokens: number, completionTokens = 0): { promptTokens: number; completionTokens: number } =>
  ({ promptTokens, completionTokens });

describe("125 项 3 — GoalRuntime.onSubagentUsage 归账", () => {
  it("有子代理：query 文本含「子代理累计：N tokens（M 个子代理）」——childId 去重", () => {
    const { runtime } = makeRuntime();
    runtime.onRunStart(); // materialize
    // 两个子代理，各两行 usage（childId 去重：M=2，不是 4）。
    runtime.onSubagentUsage({ childId: "sub-a", model: "m", usage: usage(100, 50) });
    runtime.onSubagentUsage({ childId: "sub-a", model: "m", usage: usage(200, 50) });
    runtime.onSubagentUsage({ childId: "sub-b", model: "m", usage: usage(300, 50) });
    runtime.onSubagentUsage({ childId: "sub-b", model: "m", usage: usage(10, 0) });
    const q = runtime.query();
    expect(q.text).toContain("子代理累计：760 tokens（2 个子代理）");
  });

  it("无子代理：行缺席（缺省隐藏）", () => {
    const { runtime } = makeRuntime();
    runtime.onRunStart();
    const q = runtime.query();
    expect(q.text).not.toContain("子代理累计");
  });

  it("onRunStart 的注入行同样携带上卷（预算行的 codex 补面）", () => {
    const { runtime } = makeRuntime();
    runtime.onRunStart();
    runtime.onSubagentUsage({ childId: "sub-a", model: "m", usage: usage(400, 100) });
    const secondLine = runtime.onRunStart();
    expect(secondLine).toContain("子代理累计：500 tokens（1 个子代理）");
  });

  it("settle 落盘：行携带 subagentsUsed，pending 清零后继续累计", () => {
    const { runtime, entries } = makeRuntime();
    runtime.onRunStart();
    runtime.onSubagentUsage({ childId: "sub-a", model: "m", usage: usage(100, 20) });
    runtime.onRunSettle({ input: 300, output: 40, ms: 1000 });
    const rows = goalRows(entries);
    const settled = rows.at(-1)?.["data"] as Record<string, unknown>;
    expect(settled.subagentsUsed).toEqual({ tokens: 120, count: 1 });
    // settle 后新子代理从零继续（行内值 120 是新起点）。
    runtime.onSubagentUsage({ childId: "sub-c", model: "m", usage: usage(50, 10) });
    expect(runtime.query().text).toContain("子代理累计：180 tokens（2 个子代理）");
  });

  it("计入报告、不计入触发：巨量子代理用量不翻预算（ω99-8b 分区）", () => {
    const { runtime } = makeRuntime(); // budget 5000
    runtime.onRunStart();
    runtime.onSubagentUsage({ childId: "sub-x", model: "m", usage: usage(999_999, 1) });
    const settle = runtime.onRunSettle({ input: 100, output: 100, ms: 0 });
    expect(settle).toBeUndefined(); // 没有预算穿越 note
    expect(runtime.snapshot()?.status).toBe("active");
    expect(runtime.query().text).toContain("子代理累计：1000000 tokens（1 个子代理）");
    expect(runtime.query().text).toContain("预算：已花 200（输入 100 · 输出 100） / 预算 5000，剩余 4800");
  });

  it("restore 续算：行内 rollup 是新目标的起点", () => {
    const { runtime, entries } = makeRuntime();
    runtime.onRunStart();
    runtime.onSubagentUsage({ childId: "sub-a", model: "m", usage: usage(80, 20) });
    runtime.onRunSettle({ input: 10, output: 5, ms: 1 });
    const rows = goalRows(entries).map((r) => r as unknown);

    const restored2 = makeRuntime();
    expect(restored2.runtime.restoreFromEntries(rows as never)).toBe(true);
    restored2.runtime.onSubagentUsage({ childId: "sub-z", model: "m", usage: usage(10, 0) });
    expect(restored2.runtime.query().text).toContain("子代理累计：110 tokens（2 个子代理）");
  });

  it("无 live 目标时静默丢弃（goal 面缺席的会话无归账处）", () => {
    const { runtime } = makeRuntime(); // 未 onRunStart → 无目标
    expect(() => runtime.onSubagentUsage({ childId: "s", model: "m", usage: usage(1) })).not.toThrow();
  });

  it("webSnapshot 携带上卷（absent = 零子代理）", () => {
    const { runtime } = makeRuntime();
    runtime.onRunStart();
    expect(runtime.webSnapshot()?.subagentsUsed).toBeUndefined();
    runtime.onSubagentUsage({ childId: "s1", model: "m", usage: usage(60, 40) });
    expect(runtime.webSnapshot()?.subagentsUsed).toEqual({ tokens: 100, count: 1 });
  });
});

describe("125 项 3 — subagentEventWithUsage 的 childId 盖章", () => {
  const seen: { childId?: string; model: string }[] = [];
  const model = { modelId: "test-model", generate: async () => ({ role: "assistant", content: "" }) } as never;
  it("同一包装器（同一子代理）多行 usage 同一 childId；不同包装器不同 id", () => {
    const wrap1 = subagentEventWithUsage(undefined, (info) => { seen.push({ childId: info.childId, model: info.model }); }, model);
    wrap1({ type: "usage", turn: 1, usage: { promptTokens: 5, completionTokens: 1 } } as never);
    wrap1({ type: "usage", turn: 2, usage: { promptTokens: 6, completionTokens: 1 } } as never);
    const wrap2 = subagentEventWithUsage(undefined, (info) => { seen.push({ childId: info.childId, model: info.model }); }, model);
    wrap2({ type: "usage", turn: 1, usage: { promptTokens: 7, completionTokens: 1 } } as never);
    const ids = seen.map((s) => s.childId);
    expect(ids[0]).toBeDefined();
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("125 项 3 — session-engine 接线面（源码缝）", () => {
  it("onSubagentUsage 同时喂 cost registry 与 goal 上卷（晚绑 goalRuntimeBox）", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/driver/session-engine.ts", import.meta.url)), "utf8");
    expect(src).toContain("goalRuntimeBox.current?.onSubagentUsage(info)");
  });
});
