// 133 #4（the upstream format collection-planner 轻量形）— todo 板生成器治理收据：
// 四闸矩阵（frontier 帽/新完成门槛+首扩豁免/轮数帽/无增长熔断）、
// 轮后归约、封盘终因二分、指令与通知文本有界。
import { describe, expect, it } from "vitest";
import {
  TODO_GENERATOR_DEFAULT_POLICY,
  INITIAL_TODO_GENERATOR_STATE,
  censusFromBoard,
  checkTodoExpansion,
  settleExpansionRound,
  armExpansionRound,
  todoExpansionDirective,
  todoExhaustionNote,
  type TodoBoardCensus,
} from "../src/todo-generator.js";

const census = (over: Partial<TodoBoardCensus> = {}): TodoBoardCensus => ({
  done: 2,
  pending: 1,
  inProgress: 0,
  total: 3,
  incomplete: 1,
  ...over,
});

describe("133 #4 — census 读取", () => {
  it("从头行读 done/total，行级 marks 补 pending/in_progress 分布", () => {
    const board = {
      done: 1,
      total: 4,
      incomplete: 3,
      lines: ["☑ a", "◐ b", "☐ c", "☐ d"],
    };
    const c = censusFromBoard(board)!;
    expect(c).toEqual({ done: 1, pending: 2, inProgress: 1, total: 4, incomplete: 3 });
  });

  it("无板 → undefined", () => {
    expect(censusFromBoard(undefined)).toBeUndefined();
  });
});

describe("133 #4 — 四闸矩阵", () => {
  it("无板 → no-board（没有可治理的面）", () => {
    expect(checkTodoExpansion(undefined, INITIAL_TODO_GENERATOR_STATE)).toEqual({ expand: false, suppressed: "no-board" });
  });

  it("frontier 帽：在飞 ≥ frontierTarget 不扩；在飞 < 帽才扩", () => {
    const busy = census({ pending: 3, inProgress: 0, total: 5, incomplete: 3 });
    expect(checkTodoExpansion(busy, INITIAL_TODO_GENERATOR_STATE)).toEqual({ expand: false, suppressed: "frontier-busy" });
    // 边界：incomplete 恰好 = frontierTarget → 不扩（the upstream format 的 < 语义）
    const atCap = census({ pending: 3, incomplete: 3 });
    expect(checkTodoExpansion(atCap, INITIAL_TODO_GENERATOR_STATE).expand).toBe(false);
    // 在飞 2 < 3 → 首扩豁免 → 扩
    expect(checkTodoExpansion(census(), INITIAL_TODO_GENERATOR_STATE)).toEqual({ expand: true });
  });

  it("新完成门槛：首扩豁免；后续轮无新 done 不扩；有新 done 才扩", () => {
    // 首扩（plannerRuns=0）不需要完成证据
    expect(checkTodoExpansion(census(), INITIAL_TODO_GENERATOR_STATE).expand).toBe(true);
    // 第二轮（plannerRuns=1，lastDoneCount=2）：done 仍是 2 → 不扩
    const s1 = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, lastDoneCount: 2, lastTotal: 3 };
    expect(checkTodoExpansion(census(), s1)).toEqual({ expand: false, suppressed: "no-new-completions" });
    // done 3 > 2 → 扩
    expect(checkTodoExpansion(census({ done: 3, total: 4, incomplete: 1 }), s1).expand).toBe(true);
  });

  it("轮数帽：plannerRuns ≥ maxPlannerRuns → 封盘 max_planner_runs（先于资源闸）", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 10 };
    // 即使 frontier 空且新完成在场，帽是终态
    expect(checkTodoExpansion(census({ done: 9, pending: 0, inProgress: 0, total: 10, incomplete: 0 }), s)).toEqual({
      expand: false,
      suppressed: "max-planner-runs",
      exhausted: "max_planner_runs",
    });
  });

  it("无增长熔断：noGrowthRounds ≥ 帽 → 封盘 error_threshold", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 2, noGrowthRounds: 3 };
    expect(checkTodoExpansion(census(), s)).toEqual({
      expand: false,
      suppressed: "error-threshold",
      exhausted: "error_threshold",
    });
  });

  it("自定义策略：帽可调（frontierTarget=1 更紧 / maxPlannerRuns=0 即关）", () => {
    expect(checkTodoExpansion(census(), INITIAL_TODO_GENERATOR_STATE, { frontierTarget: 1, maxPlannerRuns: 10, maxNoGrowthRounds: 3 }).expand).toBe(false);
    expect(
      checkTodoExpansion(census(), INITIAL_TODO_GENERATOR_STATE, { frontierTarget: 5, maxPlannerRuns: 0, maxNoGrowthRounds: 3 }),
    ).toEqual({ expand: false, suppressed: "max-planner-runs", exhausted: "max_planner_runs" });
  });
});

describe("133 #4 — 轮后归约（结算/武装两步）", () => {
  it("武装轮：plannerRuns+1、基线更新、armed 置位", () => {
    const s1 = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, census({ done: 3, total: 5, incomplete: 2 }));
    expect(s1).toEqual({ plannerRuns: 1, noGrowthRounds: 0, lastDoneCount: 3, lastTotal: 5, armed: true });
  });

  it("结算：无增长累加；增长清零；未武装恒等", () => {
    const armed = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, census());
    const s1 = settleExpansionRound(armed, false);
    expect(s1.noGrowthRounds).toBe(1);
    expect(s1.armed).toBe(false);
    // 连续无增长：每轮都要重新武装再结算（无增长只在武装轮计入）
    const s1b = armExpansionRound(s1, census());
    const s2 = settleExpansionRound(s1b, false);
    expect(s2.noGrowthRounds).toBe(2);
    const s2b = armExpansionRound(s2, census());
    const s3 = settleExpansionRound(s2b, true);
    expect(s3.noGrowthRounds).toBe(0);
    // 未武装 → 恒等（不误计）
    expect(settleExpansionRound(INITIAL_TODO_GENERATOR_STATE, false)).toBe(INITIAL_TODO_GENERATOR_STATE);
  });

  it("全流程：武装→板增长→结算→再武装（plannerRuns 连续计数，熔断清零）", () => {
    let s = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, census({ done: 2, total: 3 }));
    s = settleExpansionRound(s, true); // 模型扩了板（total 3→8）
    s = armExpansionRound(s, census({ done: 2, total: 8 }));
    expect(s.plannerRuns).toBe(2);
    expect(s.lastTotal).toBe(8);
    s = settleExpansionRound(s, true);
    expect(s.noGrowthRounds).toBe(0);
  });
});

describe("133 #4 — 文本面", () => {
  it("指令文本：报数正确 + 一次一批纪律 + 有界（≤ 400 字符）", () => {
    const text = todoExpansionDirective(census({ done: 7, total: 9, incomplete: 2 }));
    expect(text).toContain("2 项在飞");
    expect(text).toContain("7/9");
    expect(text).toContain("一次一批");
    expect(text.length).toBeLessThanOrEqual(400);
  });

  it("封盘通知：两终因各自带理由与出口路径，不写板字节（纯文本）", () => {
    expect(todoExhaustionNote("max_planner_runs")).toContain("max_planner_runs");
    expect(todoExhaustionNote("max_planner_runs")).toContain("封盘");
    expect(todoExhaustionNote("error_threshold")).toContain("error_threshold");
    expect(todoExhaustionNote("error_threshold")).toContain("未换来板增长");
  });
});
