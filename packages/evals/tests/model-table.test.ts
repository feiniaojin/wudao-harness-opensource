// 134 — 模型路由器数据面（model_table）收据：类别映射、最优选、可路由
// 判定、渲染。核心断言：零区分度（单模型）→ 零可路由；双模型 → 可路由。
import { describe, it, expect } from "vitest";
import {
  bestFor,
  routableCategories,
  renderTable,
  BENCHMARK_CATEGORY,
  type ModelBenchmarkResult,
  type ModelTable,
} from "../src/model-table.js";

const cell = (over: Partial<ModelBenchmarkResult> = {}): ModelBenchmarkResult => ({
  model: "glm-5.3",
  provider: "glm-code",
  benchmark: "gaia-validation",
  passAt1: 0.8,
  totalRuns: 100,
  passed: 80,
  measuredAt: "2026-09-25",
  methodology: "frozen-config net test",
  ...over,
});

describe("134 — 基准→类别映射", () => {
  it("八个基准各归一类", () => {
    expect(BENCHMARK_CATEGORY["swe-bench-lite"]).toBe("bug-fix");
    expect(BENCHMARK_CATEGORY["gaia-validation"]).toBe("research");
    expect(BENCHMARK_CATEGORY["terminal-bench"]).toBe("terminal");
    expect(BENCHMARK_CATEGORY["tau2-telecom"]).toBe("conversation");
    expect(BENCHMARK_CATEGORY["humaneval"]).toBe("greenfield");
  });
});

describe("134 — bestFor（最优选）", () => {
  it("双模型研究类：高分者胜", () => {
    const table: ModelTable = {
      results: [
        cell({ model: "glm-5.3", passAt1: 0.835 }),
        cell({ model: "MiniMax-M3", provider: "minimax-code", passAt1: 0.72 }),
      ],
    };
    expect(bestFor(table, "research")?.model).toBe("glm-5.3");
    expect(bestFor(table, "research")?.passAt1).toBeCloseTo(0.835);
  });

  it("单模型 → 仍返回该模型（但不可路由）", () => {
    const table: ModelTable = { results: [cell()] };
    expect(bestFor(table, "research")?.model).toBe("glm-5.3");
  });

  it("空表 → undefined", () => {
    expect(bestFor({ results: [] }, "research")).toBeUndefined();
  });
});

describe("134 — routableCategories（可路由判定）", () => {
  it("单模型（当前状态）→ 零可路由", () => {
    const table: ModelTable = {
      results: [
        cell({ benchmark: "gaia-validation" }),
        cell({ benchmark: "swe-bench-lite" }),
        cell({ benchmark: "terminal-bench" }),
      ],
    };
    expect(routableCategories(table)).toEqual([]);
  });

  it("双模型同基准 → 该类别可路由", () => {
    const table: ModelTable = {
      results: [
        cell({ model: "glm-5.3", benchmark: "gaia-validation", passAt1: 0.835 }),
        cell({ model: "MiniMax-M3", benchmark: "gaia-validation", passAt1: 0.72 }),
      ],
    };
    expect(routableCategories(table)).toContain("research");
  });

  it("不同基准不同模型 → 不可路由（类别内无竞争）", () => {
    const table: ModelTable = {
      results: [
        cell({ model: "glm-5.3", benchmark: "gaia-validation" }),
        cell({ model: "MiniMax-M3", benchmark: "swe-bench-lite" }),
      ],
    };
    expect(routableCategories(table)).toEqual([]);
  });
});

describe("134 — renderTable（渲染）", () => {
  it("单模型渲染含警告；双模型含可路由列表", () => {
    const single: ModelTable = { results: [cell()] };
    expect(renderTable(single)).toContain("零可路由");
    expect(renderTable(single)).toContain("glm-5.3");
    expect(renderTable(single)).toContain("80.0%");

    const dual: ModelTable = {
      results: [
        cell({ model: "glm-5.3", passAt1: 0.835 }),
        cell({ model: "MiniMax-M3", passAt1: 0.72 }),
      ],
    };
    expect(renderTable(dual)).toContain("可路由");
    expect(renderTable(dual)).toContain("MiniMax-M3");
  });
});
