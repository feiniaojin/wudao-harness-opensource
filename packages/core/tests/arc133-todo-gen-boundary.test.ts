// T004 — 探针 3：边界探测
// 关注：census 的 done>total、负数、极大值；policy 的 NaN/0/负数；
// 以及 state 字段被外部改坏。
import { describe, it, expect } from "vitest";
import {
  checkTodoExpansion,
  censusFromBoard,
  armExpansionRound,
  settleExpansionRound,
  todoExpansionDirective,
  INITIAL_TODO_GENERATOR_STATE,
  TODO_GENERATOR_DEFAULT_POLICY,
  type TodoBoardCensus,
  type TodoGeneratorPolicy,
} from "../src/todo-generator.js";
import { parseTodoBoard } from "../src/tools/todo.js";

describe("T004-探针3 — census 边界（腐数据）", () => {
  it("done > total（头行腐数据）→ incomplete 为负数（不防呆）", () => {
    // parseTodoBoard 返回 incomplete = total - done = -2
    const parsed = parseTodoBoard("[todo board 5/3 done]\n☑ a\n☑ b\n☑ c");
    expect(parsed).toBeDefined();
    expect(parsed!.done).toBe(5);
    expect(parsed!.total).toBe(3);
    expect(parsed!.incomplete).toBe(-2);
    const c = censusFromBoard(parsed!)!;
    expect(c.incomplete).toBe(-2);
    // 在负 incomplete 下，incomplete >= frontierTarget (3) → false → 走 no-new-completions
    // 但首扩豁免 → expand
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE).expand).toBe(true);
  });

  it("done > total + plannerRuns=1 + lastDoneCount=0 → no-new-completions（5>0 → 扩）", () => {
    // 修了观察：done=5 > lastDoneCount=0 → 扩（即使 total<done 也算"新完成"）
    const c: TodoBoardCensus = { done: 5, pending: 0, inProgress: 0, total: 3, incomplete: -2 };
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, lastDoneCount: 0 };
    expect(checkTodoExpansion(c, s).expand).toBe(true);
  });

  it("negative pending/inProgress 计数（手工构造）", () => {
    const c: TodoBoardCensus = { done: 0, pending: -5, inProgress: -5, total: 10, incomplete: 10 };
    // incomplete = 10 ≥ 3 → frontier-busy
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE).suppressed).toBe("frontier-busy");
  });

  it("极大值 census（Number.MAX_SAFE_INTEGER）→ frontier-busy（incomplete 远大于帽）", () => {
    const c: TodoBoardCensus = { done: 0, pending: Number.MAX_SAFE_INTEGER, inProgress: 0, total: Number.MAX_SAFE_INTEGER, incomplete: Number.MAX_SAFE_INTEGER };
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE).suppressed).toBe("frontier-busy");
  });

  it("incomplete = NaN（手工构造；parseTodoBoard 走的是整数，censusFromBoard 不该造 NaN）", () => {
    const c = { done: 0, pending: 0, inProgress: 0, total: 0, incomplete: NaN } as unknown as TodoBoardCensus;
    // NaN >= 3 → false（任何与 NaN 比较为 false）→ 走首扩豁免 → expand
    // 这是个 trap：开发者以为"非数会被卡"，但 NaN 永远让比较为 false → 放行
    const r = checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE);
    expect(r.expand).toBe(true);
  });

  it("parseTodoBoard 接受 [todo board 0/0 done]（空板）→ incomplete=0 → frontier-busy", () => {
    const parsed = parseTodoBoard("[todo board 0/0 done]");
    expect(parsed).toBeDefined();
    expect(parsed!.total).toBe(0);
    expect(parsed!.incomplete).toBe(0);
    const c = censusFromBoard(parsed!)!;
    // incomplete=0 < frontierTarget=3 → 扩
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE).expand).toBe(true);
  });

  it("板有 activeForm 时仍按 marks 计数（activeForm 不改行级语义）", () => {
    const c = censusFromBoard({
      done: 0,
      total: 3,
      incomplete: 3,
      lines: ["◐ 在读 parser 源", "☐ 写 tokenizer 测试", "☐ 修 off-by-one"],
    })!;
    expect(c.pending).toBe(2);
    expect(c.inProgress).toBe(1);
  });
});

describe("T004-探针3 — policy 边界", () => {
  it("policy.maxPlannerRuns = 0 → 有板任一状态都 max-planner-runs", () => {
    const P: TodoGeneratorPolicy = { frontierTarget: 3, maxPlannerRuns: 0, maxNoGrowthRounds: 3 };
    // max-planner-runs 在 no-board 之后判定 → census=undefined 仍走 no-board
    expect(checkTodoExpansion(undefined, INITIAL_TODO_GENERATOR_STATE, P).suppressed).toBe("no-board");
    // 有板时立即封盘
    const c: TodoBoardCensus = { done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 };
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE, P).suppressed).toBe("max-planner-runs");
  });

  it("policy.maxPlannerRuns = NaN → max-planner-runs 熔断失效；error-threshold 仍能触发", () => {
    // 设计观察：NaN 与任何值比较为 false，>= NaN 永 false → max-planner-runs 闸永不命中。
    // 但 noGrowthRounds 仍是合法数 → error-threshold 闸仍正常。
    const P = { frontierTarget: 3, maxPlannerRuns: NaN, maxNoGrowthRounds: 3 } as TodoGeneratorPolicy;
    const c: TodoBoardCensus = { done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 };
    // INITIAL 状态：首扩豁免 → expand
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE, P).expand).toBe(true);
    // 跑了 100 轮、熔断到帽 → error-threshold（不是 max-planner-runs，因为 NaN 失效）
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 100, noGrowthRounds: 3, lastDoneCount: 0 };
    expect(checkTodoExpansion(c, s, P)).toEqual({
      expand: false,
      suppressed: "error-threshold",
      exhausted: "error_threshold",
    });
  });

  it("policy.maxNoGrowthRounds = NaN → 熔断永不到；闸最终落 no-new-completions", () => {
    const P = { frontierTarget: 3, maxPlannerRuns: 10, maxNoGrowthRounds: NaN } as TodoGeneratorPolicy;
    const c: TodoBoardCensus = { done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 };
    // 第二轮（plannerRuns=1, lastDoneCount=0），done=0<=0 → no-new-completions
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, noGrowthRounds: 100, lastDoneCount: 0 };
    expect(checkTodoExpansion(c, s, P).suppressed).toBe("no-new-completions");
    // 即便 noGrowthRounds=9999999，因 NaN 比较永 false → error-threshold 永不触发
  });

  it("policy.frontierTarget = NaN → incomplete >= NaN 永 false → 永远首扩放行", () => {
    const P = { frontierTarget: NaN, maxPlannerRuns: 10, maxNoGrowthRounds: 3 } as TodoGeneratorPolicy;
    const c: TodoBoardCensus = { done: 0, pending: 999, inProgress: 0, total: 999, incomplete: 999 };
    // incomplete=999 >= NaN → false → frontier 闸永不开
    // 走首扩豁免 → expand
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE, P).expand).toBe(true);
    // 但 plannerRuns=1, lastDoneCount=0, done=0 → 0<=0 命中 no-new-completions
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, lastDoneCount: 0 };
    expect(checkTodoExpansion(c, s, P).suppressed).toBe("no-new-completions");
  });

  it("policy 全部 0 → 无 frontier 检查 + 立即 max-planner-runs 封盘", () => {
    const P: TodoGeneratorPolicy = { frontierTarget: 0, maxPlannerRuns: 0, maxNoGrowthRounds: 0 };
    const c: TodoBoardCensus = { done: 0, pending: 0, inProgress: 0, total: 0, incomplete: 0 };
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE, P)).toEqual({
      expand: false,
      suppressed: "max-planner-runs",
      exhausted: "max_planner_runs",
    });
  });

  it("policy.frontierTarget = -100（极负）→ 不挡任何扩板", () => {
    const P = { frontierTarget: -100, maxPlannerRuns: 10, maxNoGrowthRounds: 3 } as TodoGeneratorPolicy;
    const c: TodoBoardCensus = { done: 0, pending: 50, inProgress: 0, total: 50, incomplete: 50 };
    // incomplete=50 >= -100 → true → frontier-busy！负帽反而紧（>= 语义）
    expect(checkTodoExpansion(c, INITIAL_TODO_GENERATOR_STATE, P).suppressed).toBe("frontier-busy");
    // 注意到这与"放开"相反：负数帽让 frontier-busy 永远触发。
  });
});

describe("T004-探针3 — state 字段被外部改坏", () => {
  it("state.plannerRuns = -1 → 未到帽（>= 语义）→ 闸行为正常", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: -1 };
    expect(checkTodoExpansion({ done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 }, s).expand).toBe(true);
  });

  it("state.noGrowthRounds = -1 → 未到帽 → 闸行为正常", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, noGrowthRounds: -1 };
    expect(checkTodoExpansion({ done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 }, s).expand).toBe(true);
  });

  it("state.lastDoneCount = NaN → no-new-completions 判定走 NaN<=NaN（false）→ 反而扩", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, lastDoneCount: NaN } as TodoGeneratorState;
    const c: TodoBoardCensus = { done: 5, pending: 1, inProgress: 0, total: 6, incomplete: 1 };
    // NaN <= NaN 是 false → 不命中 no-new-completions → expand
    expect(checkTodoExpansion(c, s).expand).toBe(true);
  });

  it("arm 时 census.done = NaN → lastDoneCount 变 NaN（污染持久化）", () => {
    const c = { done: NaN, pending: 1, inProgress: 0, total: 1, incomplete: 1 } as unknown as TodoBoardCensus;
    const armed = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, c);
    expect(Number.isNaN(armed.lastDoneCount)).toBe(true);
    expect(Number.isNaN(armed.lastTotal)).toBe(false); // total=1 不 NaN
    // 污染持续：下一轮 newDone=0 ≤ NaN → false（NaN 比较） → expand
    const s2 = { ...INITIAL_TODO_GENERATOR_STATE, plannerRuns: 1, lastDoneCount: NaN } as TodoGeneratorState;
    expect(checkTodoExpansion({ done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 }, s2).expand).toBe(true);
  });

  it("settle 在 noGrowthRounds=NaN 时 +1 = NaN（NaN 仍 NaN）", () => {
    const armed = { ...INITIAL_TODO_GENERATOR_STATE, armed: true, noGrowthRounds: NaN } as TodoGeneratorState;
    const after = settleExpansionRound(armed, false);
    expect(Number.isNaN(after.noGrowthRounds)).toBe(true); // NaN + 1 = NaN
    expect(after.armed).toBe(false);
  });

  it("settle 在 noGrowthRounds=NaN 时 +1 = NaN → checkTodoExpansion 永不到帽", () => {
    const armed = { ...INITIAL_TODO_GENERATOR_STATE, armed: true, noGrowthRounds: NaN } as TodoGeneratorState;
    const settled = settleExpansionRound(armed, false); // NaN
    expect(checkTodoExpansion({ done: 0, pending: 1, inProgress: 0, total: 1, incomplete: 1 }, settled).expand).toBe(true);
  });
});

describe("T004-探针3 — todoExpansionDirective 文本质面", () => {
  it("NaN 报数（坏 census）→ 输出含 'NaN' 字面", () => {
    const c = { done: NaN, pending: 1, inProgress: 0, total: 1, incomplete: 1 } as unknown as TodoBoardCensus;
    const text = todoExpansionDirective(c);
    expect(text).toContain("NaN");
    // 板字节不可控（指令文本会暴露腐数据）
  });

  it("极大值报数（数字模板插值 → 纯十进制，无千分位）", () => {
    // 观察：JS 模板字面量 `${1e6}` → "1000000"（纯十进制，无 thousands 分隔）。
    // 如果模型实际用到 10000+ 项的板（生成器场景的极端情况），报数会很丑但可读。
    const c: TodoBoardCensus = { done: 1000000, pending: 9000000, inProgress: 0, total: 11000000, incomplete: 10000000 };
    const text = todoExpansionDirective(c);
    expect(text).toContain("1000000/11000000");
    expect(text).toContain("10000000 项在飞");
    // 注意：模板不做千分位格式化；不是 bug，是显式取舍（可读性 ≤ 准确传达）
  });
});
