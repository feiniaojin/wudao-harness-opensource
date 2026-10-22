// T004 — 探针 2：settle / arm 两步归约的状态机
// 关注：armed 标志的每条转移；是否存在重复武装 / 未武装结算 / 计数器泄漏。
import { describe, it, expect } from "vitest";
import {
  INITIAL_TODO_GENERATOR_STATE,
  armExpansionRound,
  settleExpansionRound,
  TODO_GENERATOR_DEFAULT_POLICY,
  type TodoBoardCensus,
  type TodoGeneratorState,
} from "../src/todo-generator.js";

const census = (over: Partial<TodoBoardCensus> = {}): TodoBoardCensus => ({
  done: 2,
  pending: 1,
  inProgress: 0,
  total: 3,
  incomplete: 1,
  ...over,
});

describe("T004-探针2 — settle/arm 互转", () => {
  it("未武装 settle(grew=true) → 恒等（不误清 noGrowthRounds）", () => {
    // 即便给了 grew=true，未武装就什么都不做；这是安全的"无害恒等"
    const s = { ...INITIAL_TODO_GENERATOR_STATE, noGrowthRounds: 2 };
    const after = settleExpansionRound(s, true);
    expect(after).toBe(s);
    expect(after.noGrowthRounds).toBe(2);
  });

  it("未武装 settle(grew=false) → 恒等（同上；计数器不漏增）", () => {
    const s = { ...INITIAL_TODO_GENERATOR_STATE, noGrowthRounds: 1 };
    const after = settleExpansionRound(s, false);
    expect(after).toBe(s);
    expect(after.noGrowthRounds).toBe(1);
  });

  it("【潜在 bug】连续 arm 不 settle → plannerRuns 单调增；armed 不被清掉", () => {
    // goal.ts 不会这样调用（arm 前必 settle），但裸 API 暴露这条路径。
    // 观察：第二轮 arm 时 armed 仍是 true（被覆盖置 true），plannerRuns=2，
    // lastDoneCount / lastTotal 被新基线覆盖。这是"忘记结算"的失控面。
    const s1 = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, census({ done: 1, total: 5 }));
    const s2 = armExpansionRound(s1, census({ done: 2, total: 6 }));
    expect(s2.plannerRuns).toBe(2);
    expect(s2.armed).toBe(true);
    expect(s2.lastDoneCount).toBe(2);
    expect(s2.lastTotal).toBe(6);
  });

  it("armed=true 状态直接 armExpansionRound 覆盖 → 计数器走基线更新，无警告", () => {
    // 这是接上条的状态再 settle(grew=false) 时会发生什么：
    // armed=true,grew=false → noGrowthRounds++
    const s1 = armExpansionRound(INITIAL_TODO_GENERATOR_STATE, census({ done: 1, total: 5 }));
    const s2 = armExpansionRound(s1, census({ done: 2, total: 6 })); // 漏结算重武装
    const s3 = settleExpansionRound(s2, false);
    expect(s3.plannerRuns).toBe(2); // 计数是"发了多少条扩板指令"——重武装也是发指令
    expect(s3.noGrowthRounds).toBe(1); // 漏结算的重武装不计"无增长"，因为没单独结算
    expect(s3.armed).toBe(false);
  });

  it("重复 settle 一个未武装的状态 → 恒等（不漏增计数器）", () => {
    // 验证 settle 不在 armed=false 时偷偷 +1
    let s = INITIAL_TODO_GENERATOR_STATE;
    s = settleExpansionRound(s, false);
    s = settleExpansionRound(s, false);
    s = settleExpansionRound(s, false);
    expect(s.noGrowthRounds).toBe(0);
  });

  it("settle 后立即 arm 是正常的 goal.ts 路径（计数器应当清零保留）", () => {
    // goal.ts 第 91-94 行就是 settle + arm
    let s = INITIAL_TODO_GENERATOR_STATE;
    s = armExpansionRound(s, census({ done: 0, total: 3 }));
    s = settleExpansionRound(s, false); // 第一轮无增长
    expect(s.noGrowthRounds).toBe(1);
    expect(s.armed).toBe(false);
    s = armExpansionRound(s, census({ done: 1, total: 5 })); // 第二轮扩了板
    s = settleExpansionRound(s, true); // 增长了
    expect(s.noGrowthRounds).toBe(0); // 增长清零
    expect(s.armed).toBe(false);
    expect(s.plannerRuns).toBe(2);
    expect(s.lastDoneCount).toBe(1);
    expect(s.lastTotal).toBe(5);
  });

  it("settle 用 census 重写基线后，新 total 即使 < lastTotal 也算 '无增长'", () => {
    // 当模型 SHRINKS 板（删了一些项），total 从 10 缩到 8。
    // armExpansionRound 把 lastTotal 更新为 8；下一轮 grew 看 8 > 8 = false。
    // 观察：goal.ts 的 grew 判定是 census.total > generator.lastTotal
    // （在 settleExpansionRound 之前先 arm，所以 lastTotal 已经是新板）。
    let s = INITIAL_TODO_GENERATOR_STATE;
    s = armExpansionRound(s, census({ done: 2, total: 10 }));
    s = settleExpansionRound(s, true); // total 从某值增到 10；首扩
    s = armExpansionRound(s, census({ done: 4, total: 8 })); // 模型缩了板
    // 现在 lastTotal=8, armed=true
    const after = settleExpansionRound(s, false); // 假设下一轮没增长
    expect(after.noGrowthRounds).toBe(1);
  });
});

describe("T004-探针2 — 不变性（repeated application）", () => {
  it("100 轮 settle(armed=false) 不改 INITIAL_TODO_GENERATOR_STATE（引用相等）", () => {
    let s = INITIAL_TODO_GENERATOR_STATE;
    for (let i = 0; i < 100; i += 1) s = settleExpansionRound(s, false);
    expect(s).toBe(INITIAL_TODO_GENERATOR_STATE);
  });

  it("arm + settle 反复，plannerRuns 与 noGrowthRounds 独立累计", () => {
    let s = INITIAL_TODO_GENERATOR_STATE;
    for (let i = 0; i < 5; i += 1) {
      s = armExpansionRound(s, census({ done: i, total: 3 + i }));
      s = settleExpansionRound(s, false); // 假设一直无增长
    }
    expect(s.plannerRuns).toBe(5);
    expect(s.noGrowthRounds).toBe(5);
    expect(s.armed).toBe(false);
  });

  it("轮替：3 无增长 → 2 增长 → 3 无增长，noGrowthRounds 序列 0,1,2,3→0,1,2,3", () => {
    let s = INITIAL_TODO_GENERATOR_STATE;
    const seq: number[] = [s.noGrowthRounds];
    for (let i = 0; i < 3; i += 1) {
      s = armExpansionRound(s, census({ done: i, total: 3 }));
      s = settleExpansionRound(s, false);
      seq.push(s.noGrowthRounds);
    }
    for (let i = 0; i < 2; i += 1) {
      s = armExpansionRound(s, census({ done: 3 + i, total: 5 }));
      s = settleExpansionRound(s, true);
      seq.push(s.noGrowthRounds);
    }
    for (let i = 0; i < 3; i += 1) {
      s = armExpansionRound(s, census({ done: 5 + i, total: 8 }));
      s = settleExpansionRound(s, false);
      seq.push(s.noGrowthRounds);
    }
    expect(seq).toEqual([0, 1, 2, 3, 0, 0, 1, 2, 3]);
  });
});
