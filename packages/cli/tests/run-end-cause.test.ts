// v7 借鉴弧 γ2（digest-a 候选 2，源 the upstream format #6162「取消的 run 有回执」）
// ——运行终态留名的词表层 RED 件：稳定枚举全集、中文人话逐字、缺席降级
// （无因=无 detail，绝不臆造）、中断回执行的逐字节旧形保持（用户手动/
// 成因不可知）与括注臂（关窗/看门狗/超时/授权拒）。纯函数，零 IO。
import { describe, it, expect } from "vitest";
import { RUN_END_CAUSES, isRunEndCause, describeRunEndCause, interruptedNotice } from "../src/run-end-cause.js";
import { validMission } from "../src/mission-model.js";

describe("v7 γ2 终态成因词表（稳定 ASCII 枚举，跨进程/跨版本可 grep）", () => {
  it("全集逐字（新增成因必改这里+回执文案）", () => {
    expect(RUN_END_CAUSES).toEqual(["user-abort", "watchdog-abort", "shutdown", "schedule-timeout", "approval-deny"]);
  });
  it("isRunEndCause：全集内 true，其余 false（坏值不部分信任）", () => {
    for (const c of RUN_END_CAUSES) expect(isRunEndCause(c)).toBe(true);
    expect(isRunEndCause("crash")).toBe(false);
    expect(isRunEndCause("")).toBe(false);
    expect(isRunEndCause(42)).toBe(false);
    expect(isRunEndCause(undefined)).toBe(false);
    expect(isRunEndCause(null)).toBe(false);
  });
});

describe("v7 γ2 describeRunEndCause（中文人话逐字钉）", () => {
  it("每个成因有非空文案且不含 ASCII 枚举词本体", () => {
    for (const c of RUN_END_CAUSES) {
      const text = describeRunEndCause(c);
      expect(text).not.toBe("");
      expect(text).not.toMatch(/[A-Za-z-]/);
    }
  });
  it("缺席（undefined/null/非法值）→ 空串：legacy 无因记录降级为无 detail，绝不臆造", () => {
    expect(describeRunEndCause(undefined)).toBe("");
    expect(describeRunEndCause(null)).toBe("");
    expect(describeRunEndCause("crash" as never)).toBe("");
  });
});

describe("v7 γ2 interruptedNotice（中断回执行的两臂）", () => {
  it("成因不可知（null/undefined）→ 「⚠️ 已中断」逐字节旧形（ω99-166c-ii repl 逐字钉不动）", () => {
    expect(interruptedNotice(null)).toBe("⚠️ 已中断");
    expect(interruptedNotice(undefined)).toBe("⚠️ 已中断");
  });
  it("用户手动停止 → 同旧形（用户刚按了停止，括注是噪音）", () => {
    expect(interruptedNotice("user-abort")).toBe("⚠️ 已中断");
  });
  it("关窗/看门狗/定时超时/授权拒 → 括注人话（那才是用户不知道的事）", () => {
    expect(interruptedNotice("shutdown")).toBe("⚠️ 已中断（窗口关闭时被结束）");
    expect(interruptedNotice("watchdog-abort")).toBe("⚠️ 已中断（等待太久被看门狗中止）");
    expect(interruptedNotice("schedule-timeout")).toBe("⚠️ 已中断（计划任务超时被终止）");
    expect(interruptedNotice("approval-deny")).toBe("⚠️ 已中断（未获授权而结束）");
  });
});

describe("v7 γ2 mission 台账的 endCause 字段（additive 容错）", () => {
  const base = {
    id: "m1",
    objective: "目标",
    createdAt: "2026-09-15T00:00:00.000Z",
    status: "abandoned" as const,
    tasks: [],
  };
  it("缺席（legacy 台账）照常通过——无因记录降级为无 detail", () => {
    expect(validMission(base)).toBe(true);
  });
  it("在场必须是串；非串畸形拒绝", () => {
    expect(validMission({ ...base, endCause: "user-abort" })).toBe(true);
    expect(validMission({ ...base, endCause: "shutdown" })).toBe(true);
    expect(validMission({ ...base, endCause: 42 })).toBe(false);
  });
});
