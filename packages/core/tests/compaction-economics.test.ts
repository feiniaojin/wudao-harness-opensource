// 借鉴弧 B1（the upstream project C1）— 压缩经济学决策层的表驱动验收（the upstream project 的
// economics.test.ts 是 88 行表驱动；这里同形收窄到 wudao 的差异面：
// fail-open 压力回落 / writeTokens 用压缩后重读前缀 / 免费缓存 Infinity /
// 债的替换语义与连本带息门）。
import { describe, it, expect } from "vitest";
import {
  CompactionEconomicsTracker,
  DEFAULT_CACHE_WRITE_READ_RATIO,
  DEFAULT_CACHE_PRICING,
  economicsReport,
  latestBoardIncomplete,
  type CachePricing,
} from "../src/compaction.js";
import type { AgentMessage } from "../src/types.js";

const PRICING = (ratio: number): CachePricing => ({ cacheWriteReadRatio: ratio, ratioSource: "env" });

/** 一个装好边界统计的 tracker（n 个边界、每边界 r 个请求、剩余 m 项）。
 *  step = 每请求的占用增量（喂窗口封顶的均值）。 */
function trackerWithStats(
  pricing: CachePricing,
  boundaries: readonly { readonly requests: number; readonly remaining: number }[],
  step = 100,
): CompactionEconomicsTracker {
  const t = new CompactionEconomicsTracker(pricing);
  for (const b of boundaries) {
    for (let i = 0; i < b.requests; i += 1) t.recordRequest(10_000 + i * step);
    t.recordBoundary(b.remaining);
  }
  return t;
}

describe("B1 decide() — 预检与窗口保护", () => {
  it("没有可压缩 span → native_not_compactable（不压）", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 50_000, windowTokens: 100_000, pressure: true, spanTokens: null });
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("native_not_compactable");
  });

  it("小 span 的摘要回填封顶在 span/2——微压缩场景不被 memo 估穿（压力照压）", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 50_000, windowTokens: 100_000, pressure: true, spanTokens: 500 });
    expect(d.memoTokens).toBe(250);
    expect(d.savingTokens).toBe(250);
    expect(d.compact).toBe(true);
    expect(d.reason).toBe("pressure_fallback");
  });

  it("距窗口不足保护带 → window_protection 覆盖一切（含无边界统计的主动路径）", () => {
    const t = new CompactionEconomicsTracker(); // 无任何边界统计
    const d = t.decide({ occupancy: 84_000, windowTokens: 100_000, pressure: false, spanTokens: 40_000 });
    expect(d.compact).toBe(true);
    expect(d.reason).toBe("window_protection");
    expect(d.windowProtection).toBe(true);
  });

  it("小 span + 距窗口极近 → 窗口保护先于一切（安全网不再被 memo 预检挡住）", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 50_000, windowTokens: 50_100, pressure: false, spanTokens: 500 });
    expect(d.compact).toBe(true);
    expect(d.reason).toBe("window_protection");
  });
});

describe("B1 decide() — 压力回落（fail-open，C2 的「无边界信号回落压力触发」）", () => {
  it("压力 + 无边界统计 → 照压（ω-2b 已钉死的压力语义不动），reason 类型化", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 82_000, windowTokens: 100_000, pressure: true, spanTokens: 40_000 });
    expect(d.compact).toBe(true);
    expect(d.reason).toBe("pressure_fallback");
  });

  it("主动路径（无压力）+ 无边界统计 → horizon_unavailable 不压（不许 fail-open）", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 82_000, windowTokens: 100_000, pressure: false, spanTokens: 40_000 });
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("horizon_unavailable");
  });
});

describe("B1 decide() — 盈亏平衡闭式（表驱动）", () => {
  // ratio 10 → incremental 9。occ 60k / span 45k / memo 1k（缺省）:
  //   saving = 45k − 1k = 44k；write = 60k − 45k + 1k = 16k（② 压缩后重读前缀）。
  //   breakeven = 16k×9/44k = 3.27。
  // 期距：单边界 1 请求、剩余 2 项 → unbounded = 1+1×2 = 3。
  const cases: readonly {
    readonly name: string;
    readonly ratio: number;
    readonly remaining: number;
    readonly first: boolean;
    readonly expectCompact: boolean;
    readonly expectReason: string;
    readonly expectBreakeven?: number;
  }[] = [
    { name: "首压：breakeven 3.27 ≤ 2×期距 6 → economic", ratio: 10, remaining: 2, first: true, expectCompact: true, expectReason: "economic", expectBreakeven: 3.27 },
    { name: "首压但剩余边界 0：期距 1、2×期距 2 < 3.27 → deferred_economic", ratio: 10, remaining: 0, first: true, expectCompact: false, expectReason: "deferred_economic", expectBreakeven: 3.27 },
    { name: "ratio 1（无缓存溢价）：breakeven 0 → economic", ratio: 1, remaining: 2, first: true, expectCompact: true, expectReason: "economic", expectBreakeven: 0 },
    { name: "后续压：breakeven 2.55 ≤ 期距 3 但 1.5×裕度 3.82 > 3 → deferred_subsequent_margin", ratio: 8, remaining: 2, first: false, expectCompact: false, expectReason: "deferred_subsequent_margin", expectBreakeven: 2.55 },
    { name: "后续压 + 长期距（剩余 6 → 期距 7 ≥ 裕度与连本带息）→ economic", ratio: 8, remaining: 6, first: false, expectCompact: true, expectReason: "economic", expectBreakeven: 2.55 },
    { name: "免费缓存（ratio Infinity）：breakeven ∞ → deferred_economic", ratio: Number.POSITIVE_INFINITY, remaining: 2, first: true, expectCompact: false, expectReason: "deferred_economic" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const t = trackerWithStats(PRICING(c.ratio), c.first
        ? [{ requests: 1, remaining: c.remaining }]
        : [{ requests: 1, remaining: 3 }, { requests: 1, remaining: c.remaining }]);
      if (!c.first) t.recordCompaction(1_000, 2_000); // priorCompactionCount 1、小债
      const d = t.decide({ occupancy: 60_000, windowTokens: 10_000_000, pressure: false, spanTokens: 45_000 });
      expect(d.compact).toBe(c.expectCompact);
      expect(d.reason).toBe(c.expectReason);
      if (c.expectBreakeven !== undefined) {
        expect(d.breakevenRequests).toBeCloseTo(c.expectBreakeven, 2);
      }
      if (c.ratio === Number.POSITIVE_INFINITY) {
        expect(Number.isFinite(d.breakevenRequests)).toBe(false);
      }
      // ② 的钉：writeTokens 是压缩后要重读的前缀，不是压缩前全量。
      expect(d.writeTokens).toBe(16_000);
      expect(d.savingTokens).toBe(44_000);
    });
  }

  it("窗口封顶：期距被 (窗口余量 ÷ 平均增量) 截断后 breakeven 过线 → deferred", () => {
    // 3 边界 × 5 请求、剩余 4 → unbounded = 21；窗口余量 20_001 ÷ 增量 2_000
    // → windowUB = 10 → 期距 10（保护带外：60k < 80_001−16_384）。breakeven：
    // occ 60k / span 20k → write 41k、saving 19k → 41k×9/19k ≈ 19.4 > 10。
    const t = trackerWithStats(PRICING(10), [
      { requests: 5, remaining: 4 },
      { requests: 5, remaining: 4 },
      { requests: 5, remaining: 4 },
    ], 2_000);
    const d = t.decide({ occupancy: 60_000, windowTokens: 80_001, pressure: false, spanTokens: 20_000 });
    expect(d.windowProtection).toBe(false);
    expect(d.compact).toBe(false);
    expect(d.reason).toBe("deferred_economic");
    expect(d.windowRequestUpperBound).toBe(10);
    expect(d.expectedRemainingRequests).toBe(10);
  });
});

describe("B1 缓存债记账", () => {
  it("债是替换语义：新压缩立新账，未摊完的旧债沉没", () => {
    const t = trackerWithStats(PRICING(10), [{ requests: 1, remaining: 2 }]);
    t.recordCompaction(10_000, 1_000); // 债 = 10k×9 = 90k，每请求还 1k
    expect(t.carriedDebtTokens).toBe(90_000);
    t.recordCompaction(2_000, 500); // 替换：新债 = 2k×9 = 18k
    expect(t.carriedDebtTokens).toBe(18_000);
  });

  it("每请求按归档节省偿还；清零后不累积信用", () => {
    const t = trackerWithStats(PRICING(10), [{ requests: 1, remaining: 2 }]);
    t.recordCompaction(1_000, 400); // 债 9k，每请求还 400
    t.recordRequest(10_000);
    expect(t.carriedDebtTokens).toBe(8_600);
    for (let i = 0; i < 100; i += 1) t.recordRequest(10_000);
    expect(t.carriedDebtTokens).toBe(0);
  });

  it("后续压缩的连本带息门：base 过线、债不过线 → deferred_carried_debt（非 subsequent_margin）", () => {
    // 期距 1+1×4 = 5；span 45k/memo 1k → saving 44k；write = 60k−45k+1k = 16k。
    // ratio 4：breakeven = 16k×3/44k ≈ 1.09 ≤ 5 且 ×1.5 ≤ 5（base+margin 都
    // 过线）；债 300k（write 100k × 3）→ combined = (300k+48k)/44k ≈ 7.9 > 5。
    const t = trackerWithStats(PRICING(4), [{ requests: 1, remaining: 3 }, { requests: 1, remaining: 4 }]);
    t.recordCompaction(100_000, 1); // ratio 4 → 债 = 100k×3 = 300k
    expect(t.carriedDebtTokens).toBe(300_000);
    t.recordRequest(60_000); // 偿还 1 → 299_999
    const d = t.decide({ occupancy: 60_000, windowTokens: 10_000_000, pressure: false, spanTokens: 45_000 });
    expect(d.breakevenRequests).toBeCloseTo(1.09, 2);
    expect(d.reason).toBe("deferred_carried_debt");
    expect(d.compact).toBe(false);
  });
});

describe("B1 定价缺省与回执面", () => {
  it("缺省定价：ratio 10、来源 default（价目未知的保守缺省，类型化）", () => {
    const t = new CompactionEconomicsTracker();
    const d = t.decide({ occupancy: 50_000, windowTokens: 100_000, pressure: true, spanTokens: 10_000 });
    expect(d.cacheWriteReadRatio).toBe(DEFAULT_CACHE_WRITE_READ_RATIO);
    expect(d.ratioSource).toBe("default");
    expect(DEFAULT_CACHE_PRICING.ratioSource).toBe("default");
  });

  it("economicsReport：决策 + 事件时刻债 → 面板回执", () => {
    const t = trackerWithStats(PRICING(10), [{ requests: 1, remaining: 2 }]);
    const d = t.decide({ occupancy: 60_000, windowTokens: 10_000_000, pressure: false, spanTokens: 45_000 });
    t.recordCompaction(16_000, 44_000);
    const r = economicsReport(d, t.carriedDebtTokens);
    expect(r.reason).toBe("economic");
    expect(r.carriedDebtTokens).toBe(144_000);
    expect(r.cacheWriteReadRatio).toBe(10);
  });
});

describe("B2 latestBoardIncomplete（同 run 续跑的剩余工作判定）", () => {
  const board = (done: number, total: number, ...items: string[]): AgentMessage => ({
    role: "tool",
    toolCallId: "b",
    name: "todo_write",
    content: `[todo board ${done}/${total} done]\n${items.join("\n")}`,
  });

  it("最新 board 的未完成数；(restored) 后缀不破坏解析", () => {
    const msgs: AgentMessage[] = [
      board(0, 2, "☐ a", "☐ b"),
      { role: "user", content: "mid" },
      board(1, 2, "☑ a", "◐ b"),
    ];
    expect(latestBoardIncomplete(msgs)).toBe(1);
    // tier-2 的 board restore 克隆（user 消息 + (restored) 后缀）
    const restored: AgentMessage[] = [
      { role: "user", content: "old" },
      { role: "user", content: "[todo board 2/3 done](restored)\n☑ x\n☑ y\n☐ z" },
    ];
    expect(latestBoardIncomplete(restored)).toBe(1);
  });

  it("无 board → undefined（不打扰收尾）", () => {
    expect(latestBoardIncomplete([{ role: "user", content: "hi" }])).toBeUndefined();
  });
});
