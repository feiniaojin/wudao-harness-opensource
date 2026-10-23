// 夜移 036 — 会话树级 token 预算（codex codex-rs/core/src/rollout_budget.rs 移植）。
// wudao 有 run 级墙钟保险丝（maxRunMs → run_budget_exhausted）与会话级
// 用量统计（usage 事件）但无「这棵 agent 树一共能烧多少 token」的硬顶——
// 子 agent 扇出可以绕开一切按 run 计的限额。共享记账 + 阈值提醒 + 耗尽
// 熔断：记账单位 = output×sampling_weight + 非缓存输入×prefill_weight
// （或 provider 显式单位，非法即 Fatal）；耗尽粘滞（used ≥ limit 后每次
// 记账都返回 true）；提醒 = 跨越阈值数（reminder_index），按
// {thread, window} 去重，标记在投递之后；rearm 只去标记不退款；窗口切换
// （压缩边界）后重述当前余量。语义钉：加权记账 / 阈值计数 / 去重矩阵 /
// 耗尽粘滞 / 配置 fail-closed。
import { describe, it, expect } from "vitest";
import { createSessionBudget } from "../src/session-budget.js";
import type { ModelUsage } from "../src/model-client.js";

/** Minimal usage shape: only the fields the budget reads. */
function usage(output: number, promptTokens = 0, cacheHitTokens = 0): ModelUsage {
  return {
    promptTokens,
    cacheHitTokens,
    cacheMissTokens: Math.max(0, promptTokens - cacheHitTokens),
    completionTokens: output,
  } as ModelUsage;
}

/** codex rollout_budget() test config: limit 100, thresholds [75,50,25]. */
function codexConfig() {
  return {
    limitTokens: 100,
    reminderAtRemainingTokens: [75, 50, 25],
  };
}

describe("夜移 036 — session budget: weighted accounting + threshold reminders (codex rollout_budget.rs)", () => {
  it("config validation is fail-closed: bad limit / thresholds / weights throw", () => {
    expect(() => createSessionBudget({ limitTokens: 0, reminderAtRemainingTokens: [] })).toThrow();
    expect(() => createSessionBudget({ limitTokens: -5, reminderAtRemainingTokens: [] })).toThrow();
    expect(() => createSessionBudget({ limitTokens: 10.5, reminderAtRemainingTokens: [] })).toThrow();
    // thresholds must be positive AND below the limit
    expect(() => createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [0] })).toThrow();
    expect(() => createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [100] })).toThrow();
    expect(() => createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 150] })).toThrow();
    expect(() => createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [-25] })).toThrow();
    // weights finite ≥ 0
    expect(() => createSessionBudget({ ...codexConfig(), samplingTokenWeight: -1 })).toThrow();
    expect(() => createSessionBudget({ ...codexConfig(), prefillTokenWeight: Number.NaN })).toThrow();
    expect(() => createSessionBudget({ ...codexConfig(), samplingTokenWeight: Number.POSITIVE_INFINITY })).toThrow();
    // the codex reference config itself is valid
    expect(() => createSessionBudget(codexConfig())).not.toThrow();
  });

  it("weighted accounting: output×sampling + non-cached input×prefill (codex: 15×2 + 20×0.5 = 40 of 100)", () => {
    const b = createSessionBudget({ ...codexConfig(), samplingTokenWeight: 2.0, prefillTokenWeight: 0.5 });
    // input 60 of which 40 cached → non-cached 20; output 15
    const exhausted = b.recordUsage(usage(15, 60, 40));
    expect(exhausted).toBe(false);
    expect(b.usedUnits()).toBe(40);
    // remaining = floor(100 − 40) = 60 (the codex follow-up reminder value)
    const rem = b.pendingReminder("root", "w0");
    expect(rem?.remainingTokens).toBe(60);
    // thresholds [75,50,25]: 60 ≤ 75 only → index 1
    expect(rem?.reminderIndex).toBe(1);
  });

  it("default weights 1.0: units = output + non-cached input; cached input is free", () => {
    const b = createSessionBudget(codexConfig());
    b.recordUsage(usage(10, 90, 80));
    expect(b.usedUnits()).toBe(10 + 10);
    // remaining 80, index 0 (80 > 75 — nothing crossed)
    const rem = b.pendingReminder("root", "w0");
    expect(rem?.remainingTokens).toBe(80);
    expect(rem?.reminderIndex).toBe(0);
  });

  it("provider units override is used verbatim; invalid override (negative / NaN) throws", () => {
    const b = createSessionBudget(codexConfig());
    b.recordUsage(usage(1, 0, 0), 90);
    expect(b.usedUnits()).toBe(90);
    expect(() => b.recordUsage(usage(1, 0, 0), -1)).toThrow();
    expect(() => b.recordUsage(usage(1, 0, 0), Number.NaN)).toThrow();
    // the failed override recorded nothing
    expect(b.usedUnits()).toBe(90);
  });

  it("exhaustion is sticky: crossing the limit returns true and later calls keep returning true", () => {
    const b = createSessionBudget(codexConfig());
    expect(b.recordUsage(usage(60))).toBe(false);
    expect(b.recordUsage(usage(41))).toBe(true);
    expect(b.isExhausted()).toBe(true);
    // a later turn's usage still reports exhausted (codex: fails later turns)
    expect(b.recordUsage(usage(1))).toBe(true);
    // remaining clamps at 0; index = every positive threshold crossed
    const rem = b.pendingReminder("root", "w0");
    expect(rem?.remainingTokens).toBe(0);
    expect(rem?.reminderIndex).toBe(3);
  });

  it("reminder dedup: same thread+window+index suppressed; higher index / new window / other thread pass", () => {
    const b = createSessionBudget(codexConfig());
    // burn to remaining 60 → index 1
    b.recordUsage(usage(40));
    const first = b.pendingReminder("root", "w0");
    expect(first?.reminderIndex).toBe(1);
    b.markReminderDelivered("root", "w0", first!);
    // same window, same index → suppressed
    expect(b.pendingReminder("root", "w0")).toBeUndefined();
    // cross the 50 threshold → index 2 → passes despite the marker
    b.recordUsage(usage(15)); // used 55, remaining 45
    expect(b.pendingReminder("root", "w0")?.reminderIndex).toBe(2);
    // a different window (compaction boundary) restates at the SAME index
    expect(b.pendingReminder("root", "w1")?.reminderIndex).toBe(2);
    // a different thread observes thresholds independently
    expect(b.pendingReminder("child", "w0")?.reminderIndex).toBe(2);
    // the other thread's marker does not suppress the root thread
    b.markReminderDelivered("child", "w0", b.pendingReminder("child", "w0")!);
    expect(b.pendingReminder("root", "w0")).toBeDefined();
  });

  it("rearm removes the marker without refunding usage", () => {
    const b = createSessionBudget(codexConfig());
    b.recordUsage(usage(40));
    const first = b.pendingReminder("root", "w0");
    b.markReminderDelivered("root", "w0", first!);
    expect(b.pendingReminder("root", "w0")).toBeUndefined();
    b.rearmReminder("root");
    const again = b.pendingReminder("root", "w0");
    expect(again?.remainingTokens).toBe(60);
    // usage untouched — rearm restates, never refunds
    expect(b.usedUnits()).toBe(40);
  });

  it("remaining floors and clamps at 0 when usage overshoots", () => {
    const b = createSessionBudget(codexConfig());
    b.recordUsage(usage(100));
    b.recordUsage(usage(33)); // used 133 > limit
    const rem = b.pendingReminder("root", "w0");
    expect(rem?.remainingTokens).toBe(0);
  });
});
