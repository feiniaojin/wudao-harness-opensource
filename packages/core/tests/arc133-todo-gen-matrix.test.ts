// T004 — 探针 1：checkTodoExpansion 判定序穷举矩阵
// 目的：验证五类 suppressed 的互斥性 + 优先级 + 首扩豁免边界。
// 每个 case 打印一行紧凑表格，方便定位反例。
import { describe, it, expect } from "vitest";
import {
  checkTodoExpansion,
  TODO_GENERATOR_DEFAULT_POLICY,
  type TodoBoardCensus,
  type TodoGeneratorState,
} from "../src/todo-generator.js";

const DEFAULT = TODO_GENERATOR_DEFAULT_POLICY; // frontier 3 / maxPlannerRuns 10 / maxNoGrowthRounds 3
const census = (over: Partial<TodoBoardCensus> = {}): TodoBoardCensus => ({
  done: 2,
  pending: 1,
  inProgress: 0,
  total: 3,
  incomplete: 1,
  ...over,
});
const state = (over: Partial<TodoGeneratorState> = {}): TodoGeneratorState => ({
  plannerRuns: 0,
  noGrowthRounds: 0,
  lastDoneCount: 0,
  lastTotal: 0,
  armed: false,
  ...over,
});

describe("T004-探针1 — 判定序互斥性", () => {
  it("在 frontier 忙 + 轮数到帽 + 无增长到帽同时发生时，max-planner-runs 优先", () => {
    // 三闸同时具备：应按源代码序截到 max-planner-runs
    const s = state({ plannerRuns: 10, noGrowthRounds: 3, lastDoneCount: 0 });
    const c = census({ done: 0, pending: 5, inProgress: 5, total: 10, incomplete: 10 });
    expect(checkTodoExpansion(c, s)).toEqual({
      expand: false,
      suppressed: "max-planner-runs",
      exhausted: "max_planner_runs",
    });
  });

  it("无增长到帽 + frontier 忙同时发生时，error-threshold 优先（max-planner-runs 未到）", () => {
    const s = state({ plannerRuns: 5, noGrowthRounds: 3, lastDoneCount: 5 });
    const c = census({ done: 5, pending: 3, inProgress: 3, total: 11, incomplete: 6 });
    expect(checkTodoExpansion(c, s)).toEqual({
      expand: false,
      suppressed: "error-threshold",
      exhausted: "error_threshold",
    });
  });

  it("frontier 忙 + 无新完成同时发生时，frontier-busy 优先（资源闸先于完成证据闸）", () => {
    const s = state({ plannerRuns: 1, noGrowthRounds: 0, lastDoneCount: 5 });
    const c = census({ done: 5, pending: 3, inProgress: 0, total: 8, incomplete: 3 });
    expect(checkTodoExpansion(c, s)).toEqual({
      expand: false,
      suppressed: "frontier-busy",
    });
  });

  it("首扩豁免（plannerRuns===0）即使 done 没增长也扩（lastDoneCount=5 但 done=5）", () => {
    const s = state({ plannerRuns: 0, lastDoneCount: 5 });
    const c = census({ done: 5, pending: 1, inProgress: 0, total: 6, incomplete: 1 });
    // 关键：首扩豁免跳过了第 5 条 done<=lastDoneCount 检查
    expect(checkTodoExpansion(c, s).expand).toBe(true);
  });

  it("首扩豁免的反例：plannerRuns===1 时 done===lastDoneCount 仍不扩", () => {
    const s = state({ plannerRuns: 1, lastDoneCount: 2 });
    const c = census({ done: 2, pending: 1, inProgress: 0, total: 3, incomplete: 1 });
    expect(checkTodoExpansion(c, s)).toEqual({
      expand: false,
      suppressed: "no-new-completions",
    });
  });

  it("首扩豁免的反例：plannerRuns===1 且 done>lastDoneCount 才扩（确认新完成门槛）", () => {
    const s = state({ plannerRuns: 1, lastDoneCount: 2 });
    const c = census({ done: 3, pending: 0, inProgress: 1, total: 4, incomplete: 1 });
    expect(checkTodoExpansion(c, s).expand).toBe(true);
  });
});

describe("T004-探针1 — 边界值（含等号）", () => {
  it("incomplete === frontierTarget → frontier-busy（>= 而非 >）", () => {
    const s = state();
    expect(checkTodoExpansion(census({ incomplete: 3 }), s).suppressed).toBe("frontier-busy");
  });

  it("incomplete === frontierTarget - 1 → expand", () => {
    const s = state();
    expect(checkTodoExpansion(census({ incomplete: 2 }), s).expand).toBe(true);
  });

  it("plannerRuns === maxPlannerRuns → max-planner-runs（>= 语义）", () => {
    const s = state({ plannerRuns: 10 });
    expect(checkTodoExpansion(census(), s).suppressed).toBe("max-planner-runs");
  });

  it("plannerRuns === maxPlannerRuns - 1（资源闸全空）→ expand", () => {
    const s = state({ plannerRuns: 9, lastDoneCount: 0 });
    expect(checkTodoExpansion(census({ done: 5, pending: 0, inProgress: 0, total: 5, incomplete: 0 }), s).expand).toBe(true);
  });

  it("noGrowthRounds === maxNoGrowthRounds → error-threshold（>= 语义）", () => {
    const s = state({ noGrowthRounds: 3 });
    expect(checkTodoExpansion(census(), s).suppressed).toBe("error-threshold");
  });

  it("done === lastDoneCount（严格相等） → no-new-completions（<= 语义）", () => {
    const s = state({ plannerRuns: 1, lastDoneCount: 2 });
    expect(checkTodoExpansion(census({ done: 2 }), s).suppressed).toBe("no-new-completions");
  });

  it("done === lastDoneCount - 1（倒退） → no-new-completions", () => {
    const s = state({ plannerRuns: 1, lastDoneCount: 5 });
    expect(checkTodoExpansion(census({ done: 4 }), s).suppressed).toBe("no-new-completions");
  });
});

describe("T004-探针1 — policy 旋钮（全矩阵小穷举）", () => {
  it("frontierTarget=0 → 任一 census 都 frontier-busy（0 是合法且最紧的帽）", () => {
    const P = { frontierTarget: 0, maxPlannerRuns: 10, maxNoGrowthRounds: 3 };
    expect(checkTodoExpansion(census({ incomplete: 0 }), state(), P).suppressed).toBe("frontier-busy");
    // 注：frontier-busy 在 max-planner-runs / error-threshold 之后；这里状态全空 → frontier 先命中
  });

  it("maxPlannerRuns=0 → 任何状态都封盘 max_planner_runs（立即封盘）", () => {
    const P = { frontierTarget: 3, maxPlannerRuns: 0, maxNoGrowthRounds: 3 };
    expect(checkTodoExpansion(census(), state(), P).suppressed).toBe("max-planner-runs");
  });

  it("maxNoGrowthRounds=0 → 任何非首扩都封盘 error_threshold", () => {
    const P = { frontierTarget: 3, maxPlannerRuns: 10, maxNoGrowthRounds: 0 };
    // INITIAL 状态 noGrowthRounds=0 >= 0 → 封盘
    expect(checkTodoExpansion(census(), state(), P).suppressed).toBe("error-threshold");
  });

  it("负数 frontierTarget=-1 → 不应被触发（incomplete >= -1 永远为真 → 恒 frontier-busy）", () => {
    // 这是一个观察点：policy 没有前置验证；负数帽等于"永扩不出"
    const P = { frontierTarget: -1, maxPlannerRuns: 10, maxNoGrowthRounds: 3 };
    expect(checkTodoExpansion(census({ incomplete: 0 }), state(), P).suppressed).toBe("frontier-busy");
  });
});
