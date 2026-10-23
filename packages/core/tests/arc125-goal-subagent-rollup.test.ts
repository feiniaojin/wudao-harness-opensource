// 125 项 3（codex 预算上卷 4761851ff3 形）— goal_state 行的 subagentsUsed
// 附加车道 + 渲染面钉子。计入报告、不计入触发（ω99-8b 分区不动）；
// 零子代理缺席（缺省隐藏，旧读侧零感知）。
import { describe, it, expect } from "vitest";
import {
  GOAL_STATE_ENTRY_TYPE,
  buildGoalStateEntry,
  parseGoalStateData,
  replayGoalStates,
  goalStatusLine,
  goalQueryText,
  type GoalStateData,
  type GenericSessionEntry,
} from "../src/index.js";

const baseGoal = (over: Partial<GoalStateData> = {}): GoalStateData => ({
  goalId: "g1",
  objective: "写认证模块",
  missionTaskId: "t2",
  status: "active",
  tokenBudget: 5000,
  tokensUsed: { input: 1000, output: 200 },
  timeUsedMs: 0,
  continuationsUsed: 0,
  createdAt: "2026-09-26T00:00:00.000Z",
  updatedAt: "2026-09-26T00:00:00.000Z",
  ...over,
});

describe("125 项 3 — subagentsUsed 车道（写入/读回/回放）", () => {
  it("buildGoalStateEntry：在场写出（截断取整），缺席整个键省略（旧字节不变）", () => {
    const withSub = buildGoalStateEntry(baseGoal({ subagentsUsed: { tokens: 12345.7, count: 3 } }));
    expect((withSub.data as Record<string, unknown>).subagentsUsed).toEqual({ tokens: 12345, count: 3 });
    const without = buildGoalStateEntry(baseGoal());
    expect((without.data as Record<string, unknown>).subagentsUsed).toBeUndefined();
    expect(JSON.stringify(without.data)).not.toContain("subagentsUsed");
  });

  it("parseGoalStateData：往返保真；缺席读回 undefined", () => {
    const round = parseGoalStateData(buildGoalStateEntry(baseGoal({ subagentsUsed: { tokens: 900, count: 2 } })).data);
    expect(round?.subagentsUsed).toEqual({ tokens: 900, count: 2 });
    const bare = parseGoalStateData(buildGoalStateEntry(baseGoal()).data);
    expect(bare?.subagentsUsed).toBeUndefined();
  });

  it("畸形 subagentsUsed 丢整行（fail-safe 纪律：永不部分加载）", () => {
    const good = buildGoalStateEntry(baseGoal()).data as Record<string, unknown>;
    for (const bad of [
      { tokens: "x", count: 1 },
      { tokens: -5, count: 1 },
      { tokens: 10, count: 1.5 },
      { tokens: 10 },
      null,
    ]) {
      const row: Record<string, unknown> = { ...good, subagentsUsed: bad };
      expect(parseGoalStateData(row), `subagentsUsed=${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("replayGoalStates：最后一行的 rollup 随目标恢复", () => {
    const rows: GenericSessionEntry[] = [
      buildGoalStateEntry(baseGoal({ subagentsUsed: { tokens: 100, count: 1 } })),
      buildGoalStateEntry(baseGoal({ subagentsUsed: { tokens: 550, count: 2 } })),
    ];
    const restored = replayGoalStates(rows as never);
    expect(restored?.subagentsUsed).toEqual({ tokens: 550, count: 2 });
  });
});

describe("125 项 3 — 渲染面（statusLine/queryText 的聚合行）", () => {
  it("有子代理：statusLine 与 queryText 都带「子代理累计：N tokens（M 个子代理）」", () => {
    const g = baseGoal({ subagentsUsed: { tokens: 4321, count: 2 } });
    const line = goalStatusLine(g, { done: 1, total: 3 });
    expect(line).toContain("子代理累计：4321 tokens（2 个子代理）");
    const q = goalQueryText(g, { done: 1, total: 3 });
    expect(q).toContain("子代理累计：4321 tokens（2 个子代理）");
  });

  it("零子代理：行缺席（缺省隐藏，125 前字节不变）", () => {
    const g = baseGoal();
    expect(goalStatusLine(g, { done: 0, total: 3 })).not.toContain("子代理累计");
    expect(goalQueryText(g, { done: 0, total: 3 })).not.toContain("子代理累计");
    const zero = baseGoal({ subagentsUsed: { tokens: 0, count: 0 } });
    expect(goalStatusLine(zero, { done: 0, total: 3 })).not.toContain("子代理累计");
  });

  it("上卷不碰预算行：tokensUsed/剩余只算根 loop（ω99-8b 分区在渲染面同样成立）", () => {
    const g = baseGoal({ subagentsUsed: { tokens: 999_999, count: 9 } });
    const line = goalStatusLine(g, { done: 0, total: 3 });
    expect(line).toContain("已花 1200（输入 1000 · 输出 200）/ 5000");
    expect(line).not.toContain("预算还剩约"); // 1200/5000 = 24% > 20%，本就不该出现
  });
});
