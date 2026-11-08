import { describe, expect, it } from "vitest";
import { createTaskWallBudget, formatTaskWallBudgetNote, formatTaskContextMessage } from "../src/task-wall-budget.js";

// 「原则进系统提示词，数字进上下文」分层的运行期半边。测试面：
//   · 档位语义：0=首请求全量重述；50%/80% 各一次，全局去重；
//   · 窗口语义：压缩边界切换后 0 号档重述（sessionBudget 同款）；
//   · 文案：80% 档引用配速原则（收缩到最短可验证路径）；
//   · 注入块：机器可读 task_context，含 budget_seconds/started_at/source。
describe("task wall-clock budget", () => {
  const T0 = 1_000_000;
  const MIN = 60_000;

  it("index 0 restates the full budget on a window's first request", () => {
    const b = createTaskWallBudget(10 * MIN, T0, () => T0 + 10_000);
    const r = b.pendingReminder("w0");
    expect(r?.index).toBe(0);
    expect(r?.remainingMs).toBe(9 * MIN + 50_000);
    b.markReminderDelivered("w0", r!);
    // 同窗口不重复
    expect(b.pendingReminder("w0")).toBeUndefined();
    // 新窗口（压缩后）重述
    const again = b.pendingReminder("w1");
    expect(again?.index).toBe(0);
  });

  it("crossing 50% and 80% fires each once, globally", () => {
    let nowMs = T0;
    const b = createTaskWallBudget(10 * MIN, T0, () => nowMs);
    nowMs = T0 + 1_000;
    b.markReminderDelivered("w0", b.pendingReminder("w0")!);
    // 49%：无新档
    nowMs = T0 + 49 / 100 * 10 * MIN;
    expect(b.pendingReminder("w0")).toBeUndefined();
    // 51%：1 号档
    nowMs = T0 + 51 / 100 * 10 * MIN;
    const half = b.pendingReminder("w0");
    expect(half?.index).toBe(1);
    b.markReminderDelivered("w0", half);
    // 70%：仍无
    nowMs = T0 + 7 * MIN;
    expect(b.pendingReminder("w0")).toBeUndefined();
    // 81%：2 号档；跨窗口也不重复
    nowMs = T0 + 81 / 100 * 10 * MIN;
    const eighty = b.pendingReminder("w2");
    expect(eighty?.index).toBe(2);
    b.markReminderDelivered("w2", eighty);
    nowMs = T0 + 95 / 100 * 10 * MIN;
    expect(b.pendingReminder("w3")).toBeUndefined();
  });

  it("remaining clamps at zero and elapsed never negative", () => {
    const b = createTaskWallBudget(MIN, T0, () => T0 + 5 * MIN);
    expect(b.remainingMs()).toBe(0);
    expect(b.elapsedMs(T0 - 100)).toBe(0);
  });

  it("note copy quotes the pacing principle at 80%", () => {
    expect(formatTaskWallBudgetNote({ index: 2, remainingMs: 120_000 })).toContain("shortest verifiable path");
    expect(formatTaskWallBudgetNote({ index: 1, remainingMs: 300_000 })).toContain("half gone");
    expect(formatTaskWallBudgetNote({ index: 0, remainingMs: 600_000 })).toContain("clock tool");
  });

  it("context message is machine-readable and carries source", () => {
    const msg = formatTaskContextMessage(90_000, T0, "cli-flag");
    expect(msg).toContain('<task_context budget_seconds="90"');
    expect(msg).toContain('source="cli-flag"');
    expect(msg).toContain("started_at=");
  });

  it("rejects non-positive budgets (fail-closed)", () => {
    expect(() => createTaskWallBudget(0, T0)).toThrow();
    expect(() => createTaskWallBudget(-5, T0)).toThrow();
    expect(() => createTaskWallBudget(Number.NaN, T0)).toThrow();
  });
});
