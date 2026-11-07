// 2026-11-06 Terminal-Bench 取证 — defer 的 auto 判据补「选择面宽度」上限。
//
// 旧判据只看 defer 候选 schema 占窗口的比例：100 万窗口下 60KB 的候选集
// 只占 1.5%，永远判「装得下」→ 一次都没 defer 过。实测请求里躺着 85 个
// 工具定义 / 114KB schema，单轮响应从 5 秒涨到 10 分钟不返回。
//
// 窗口大 ≠ 应该一次给 85 个并列选项：模型要在里面挑，慢和选错的代价与
// 窗口大小无关。这条钉子钉住那个上限。
import { describe, it, expect } from "vitest";
import { DEFER_CANDIDATE_TOOL_NAMES, EAGER_TOOL_COUNT_CEILING, deferCandidatesFitWindow } from "../src/tools.js";
import type { Tool } from "@wudao-org/core";

/** A no-op tool carrying one of the defer-candidate names. */
function candidate(name: string): Tool {
  return {
    name,
    description: "d",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: "" }),
  } as unknown as Tool;
}

describe("defer auto verdict — 选择面宽度上限", () => {
  it("候选集（docs 家族）收窄后仍受上限约束——超限必 defer（回归保护）", () => {
    const names = [...DEFER_CANDIDATE_TOOL_NAMES];
    // 2026-11-06 用户定调：只有 docs 家族延后（17 个 < 24 上限）。这里钉住
    // 「候选集只剩 docs」这件事本身；超限行为用合成集直接验证。
    expect(names.length).toBeLessThanOrEqual(EAGER_TOOL_COUNT_CEILING);
    expect(names.every((n) => /docx|xlsx|pptx/.test(n))).toBe(true);
    // 候选集按名字过滤——合成工具必须叫 docs 名字才会被数进去。
    const docsNames = [...DEFER_CANDIDATE_TOOL_NAMES];
    const synthetic = Array.from({ length: EAGER_TOOL_COUNT_CEILING + 1 }, (_, i) => candidate(docsNames[i % docsNames.length]!));
    // 100 万 token 窗口：旧判据在这里放行（这正是它失灵的那一格）。
    expect(deferCandidatesFitWindow(synthetic, 1_000_000)).toBe(false);
  });

  it("候选集在上限内、字节也装得下 → 仍然即时加载（不强制往返）", () => {
    expect(deferCandidatesFitWindow([], 1_000_000)).toBe(true);
    // 空候选集没有"装不下"的问题：即使窗口很小也是 0 字节（true = 装得下）。
    expect(deferCandidatesFitWindow([], 8_000)).toBe(true);
  });

  it("上限本身是个可读的常量，不是散落的魔数", () => {
    expect(EAGER_TOOL_COUNT_CEILING).toBe(24);
  });
});
