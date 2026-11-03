// ω99-187: /cost 会话视图（formatCostReport）中文化 receipts —— 三组 8 it，
// 镜像 m55:89-:96 fixture 形（recordUsage + emptyUsageTotals + 注入时钟）与
// cost-registry（priced/unpriced）· m61-goal（evaluator 列）的 fixture。
// A 骨架 / B 三态（零用量 · priced · unpriced · evaluator）/ C 旧英文形反向。
// token 保留：kib 形（10.0k）、formatWallDuration 输出（4m 12s）、$ 金额、
// formatCachePercent 输出（90.0%）、模型 id、/cost·/goal 命令词、
// WUDAO_PRICE_<MODEL>=in,out,cacheRead,cacheWrite、` · ` 分隔、≠、tokens 单位词。
import { describe, it, expect } from "vitest";
import type { ModelUsage } from "@wudao-org/core";
import {
  formatCostReport,
  recordUsage,
  emptyUsageTotals,
  CostRegistry,
} from "../src/commands/cost.js";

const usage = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  promptTokens: 1000,
  cacheHitTokens: 700,
  cacheMissTokens: 300,
  completionTokens: 9,
  cacheWriteTokens: 300,
  ...over,
});

const reportTotals = {
  promptTokens: 1000,
  completionTokens: 9,
  cacheHitTokens: 700,
  cacheMissTokens: 300,
  calls: 1,
  evaluatorTokens: 0,
};

// m55:89-:96 fixture 形：一轮 10k/9k/1k/2.5k + 注入时钟 4m 12s。
const skeleton = () =>
  formatCostReport(
    recordUsage(emptyUsageTotals(), {
      promptTokens: 10_000,
      cacheHitTokens: 9_000,
      cacheMissTokens: 1_000,
      completionTokens: 2_500,
    }),
    { startedAt: 1_000_000, now: () => 1_000_000 + 4 * 60_000 + 12_000 },
  );

// cost-registry:125-:131 fixture 形：定价模型 → $ 行在场、无 未计价 行。
const priced = () => {
  const reg = new CostRegistry({ WUDAO_PRICE_DEEPSEEK_V4_FLASH: "2,4,0.2,2" });
  reg.record({ model: "deepseek-v4-flash", usage: usage() });
  return formatCostReport(reportTotals, { startedAt: 0, now: () => 5000, cost: reg.summary() });
};

// cost-registry:133-:140 fixture 形：无价格表 → 未计价 ≠ 免费 注记。
const unpriced = () => {
  const reg = new CostRegistry({});
  reg.record({ model: "glm-4.6", usage: usage() });
  return formatCostReport(reportTotals, { startedAt: 0, now: () => 5000, cost: reg.summary() });
};

describe("ω99-187 A — /cost 会话视图骨架（中文化）", () => {
  it("首行 费用（本次会话）： + 模型调用：1 + 输出 tokens：", () => {
    const report = skeleton();
    expect(report.split("\n")[0]).toBe("费用（本次会话）：");
    expect(report).toContain("模型调用：1");
    expect(report).toContain("输出 tokens：2.5k");
  });

  it("输入 tokens 行带 缓存命中/未命中/缓存% 三联（kib 形保留）", () => {
    expect(skeleton()).toContain("输入 tokens：10.0k（缓存命中 9.0k · 未命中 1.0k · 缓存 90.0%）");
  });

  it("用时行保留 formatWallDuration 输出（4m 12s）+（自会话开始）", () => {
    expect(skeleton()).toContain("用时：4m 12s（自会话开始）");
  });
});

describe("ω99-187 B — 三态（零用量 · priced · unpriced · evaluator）", () => {
  it("零用量 → 尚无用量 行（/cost 命令词保留）", () => {
    expect(formatCostReport(emptyUsageTotals(), { startedAt: 0, now: () => 0 })).toBe(
      "费用（本次会话）：尚无用量——首次模型调用后再执行 /cost",
    );
  });

  it("priced → 花费：$ 金额行（1/1 轮已计价），无 未计价 行", () => {
    const text = priced();
    expect(text).toContain("花费：$0.000776（1/1 轮已计价）");
    expect(text).not.toContain("未计价");
  });

  it("unpriced → 未计价：N 轮（模型 …）——未计价 ≠ 免费 + WUDAO_PRICE 在场", () => {
    const text = unpriced();
    expect(text).toContain("未计价：1 轮（模型 glm-4.6）——未计价 ≠ 免费");
    expect(text).toContain("WUDAO_PRICE");
  });

  it("evaluator → 评审：120 tokens（/goal 转录判定）", () => {
    // m61-goal:297-:307 fixture 形：评审列只骑自己的列。
    let totals = emptyUsageTotals();
    totals = recordUsage(totals, {
      promptTokens: 100,
      cacheHitTokens: 0,
      cacheMissTokens: 100,
      completionTokens: 20,
      evaluatorTokens: 120,
    });
    totals = recordUsage(totals, { promptTokens: 500, cacheHitTokens: 400, cacheMissTokens: 100, completionTokens: 80 });
    expect(formatCostReport(totals, { startedAt: Date.now() - 1000 })).toContain("评审：120 tokens（/goal 转录判定）");
  });
});

describe("ω99-187 C — 旧英文形反向", () => {
  it("骨架/priced/unpriced 三报告均无旧英文形", () => {
    for (const report of [skeleton(), priced(), unpriced()]) {
      expect(report).not.toContain("cost (this session)");
      expect(report).not.toContain("model calls:");
      expect(report).not.toContain("prompt tokens:");
      expect(report).not.toContain("completion tokens:");
      expect(report).not.toContain("wall time:");
      expect(report).not.toContain("spend:");
      expect(report).not.toContain("unpriced: ");
    }
  });
});
