// 133 top1 — 缓存时钟纯函数收据：分类矩阵（冷因三分互斥 + 置信二分）、
// 估价不变量（非负/有限/增量≤总额/NaN 先检/无价不报）、offer 门四闸。
import { describe, expect, it } from "vitest";
import {
  cacheIdentityEqual,
  classifyCacheClock,
  estimateRewarm,
  coldCacheOffer,
  DEFAULT_CACHE_CLOCK_POLICY,
  type CacheIdentity,
} from "../src/cache-clock.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SAME: CacheIdentity = { model: "glm-5.3", provider: "glm-code" };

const hours = (n: number): number => NOW - n * HOUR;

describe("133 top1 — 缓存时钟分类矩阵", () => {
  it("无记录 → age_unknown（绝不报成 identity_changed——那等于宣称一次从未发生的换模型）", () => {
    const out = classifyCacheClock(NOW, undefined, undefined, SAME);
    expect(out.reason).toBe("age_unknown");
    expect(out.confidence).toBe("may_be_cold");
    // 即使两侧身份显然不同，无记录就是 age_unknown
    const out2 = classifyCacheClock(NOW, undefined, { model: "a" }, { model: "b" });
    expect(out2.reason).toBe("age_unknown");
  });

  it("身份变了 → identity_changed + expired（确定性的，与闲置时长无关）", () => {
    for (const idle of [0, 60_000, 10 * HOUR]) {
      const out = classifyCacheClock(NOW, NOW - idle, SAME, { model: "deepseek-chat" });
      expect(out.reason).toBe("identity_changed");
      expect(out.confidence).toBe("expired");
    }
    // 推理档变化也算身份变化（值元组；T003 语义——双侧都记录了档才比）
    const out = classifyCacheClock(NOW, hours(2), { ...SAME, reasoningEffort: "medium" }, { ...SAME, reasoningEffort: "high" });
    expect(out.reason).toBe("identity_changed");
  });

  it("闲置 < 地板 → warm（刚切回来的会话不打扰）", () => {
    const out = classifyCacheClock(NOW, NOW - 60_000, SAME, SAME);
    expect(out.reason).toBe("idle");
    expect(out.confidence).toBe("warm");
    expect(out.idleSeconds).toBe(60);
  });

  it("闲置 ≥ 地板 + 无文档窗（国产缺省）→ may_be_cold（诚实：可能已冷，不说已过期）", () => {
    const out = classifyCacheClock(NOW, hours(3), SAME, SAME);
    expect(out.reason).toBe("idle");
    expect(out.confidence).toBe("may_be_cold");
    expect(out.idleSeconds).toBeCloseTo(3 * 3600, 5);
  });

  it("有文档窗且超窗 → expired；窗内 → may_be_cold", () => {
    const policy = { ...DEFAULT_CACHE_CLOCK_POLICY, documentedWindowSeconds: 300 };
    expect(classifyCacheClock(NOW, hours(1), SAME, SAME, policy).confidence).toBe("expired");
    expect(classifyCacheClock(NOW, NOW - 301_000, SAME, SAME, policy).confidence).toBe("expired");
    expect(classifyCacheClock(NOW, NOW - 302_000, SAME, SAME, { ...DEFAULT_CACHE_CLOCK_POLICY, documentedWindowSeconds: 400 }).confidence).toBe("may_be_cold");
  });

  it("T002 #8：文档窗非有限（NaN/Infinity）视作无文档窗 → may_be_cold", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = classifyCacheClock(NOW, hours(1), SAME, SAME, { ...DEFAULT_CACHE_CLOCK_POLICY, documentedWindowSeconds: bad });
      expect(out.confidence).toBe("may_be_cold");
    }
  });

  it("身份任一侧未知 → 不比较，走闲置车道（fail-open 到不比）", () => {
    expect(classifyCacheClock(NOW, hours(2), undefined, SAME).reason).toBe("idle");
    expect(classifyCacheClock(NOW, hours(2), SAME, undefined).reason).toBe("idle");
  });

  it("负闲置（时钟回拨）钳到 0 → warm", () => {
    const out = classifyCacheClock(NOW, NOW + 5_000, SAME, SAME);
    expect(out.idleSeconds).toBe(0);
    expect(out.confidence).toBe("warm");
  });

  it("T002 深测发现：nowMs 非有限 → age_unknown（idleSeconds 永不为 NaN）", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const out = classifyCacheClock(bad, NOW - 3 * HOUR, SAME, SAME);
      expect(out.reason).toBe("age_unknown");
      expect(out.idleSeconds).toBe(0);
      expect(Number.isFinite(out.idleSeconds)).toBe(true);
    }
  });

  it("identity 值相等：undefined 字段与缺失同义", () => {
    expect(cacheIdentityEqual({ model: "m" }, { model: "m", provider: undefined })).toBe(true);
    expect(cacheIdentityEqual({ model: "m", reasoningEffort: "high" }, { model: "m", reasoningEffort: "high" })).toBe(true);
    // T003 语义翻转：单侧有档=台账无该字段变化证据 → 不构成不等
    expect(cacheIdentityEqual({ model: "m" }, { model: "m", reasoningEffort: "low" })).toBe(true);
    expect(cacheIdentityEqual(undefined, undefined)).toBe(false); // 未知 ≠ 相等
  });

  it("T003 N2/N3：字段在场才比对——单侧缺 provider 不构成不等；双侧空 model 不宣称相等", () => {
    // N2 的核心：ledger {m2}（无 provider）vs current {m2,p2} → 相等（无证据不比对）
    expect(cacheIdentityEqual({ model: "m2" }, { model: "m2", provider: "p2" })).toBe(true);
    expect(cacheIdentityEqual({ model: "m2", provider: "p2" }, { model: "m2" })).toBe(true);
    // 双侧都在场才比：不同 provider → 不等
    expect(cacheIdentityEqual({ model: "m2", provider: "p1" }, { model: "m2", provider: "p2" })).toBe(false);
    // 空串与缺失同义（在场判定用非空）
    expect(cacheIdentityEqual({ model: "m2", provider: "" }, { model: "m2", provider: "p2" })).toBe(true);
    // N3：双侧空 model → false（无可比证据，不宣称相等）
    expect(cacheIdentityEqual({ model: "" }, { model: "" })).toBe(false);
    // model 不同仍是一票否决
    expect(cacheIdentityEqual({ model: "a" }, { model: "b" })).toBe(false);
  });
});

describe("133 top1 — 重暖估价不变量（deepagents RewarmEstimate 同款）", () => {
  const DEEPSEEK = { inputPerM: 0.27, cacheReadPerM: 0.07 };

  it("基础数学：100k 前缀 × DeepSeek 价 → cold/warm/incremental", () => {
    const e = estimateRewarm(100_000, DEEPSEEK)!;
    expect(e.coldCostUsd).toBeCloseTo(0.027, 6);
    expect(e.warmCostUsd).toBeCloseTo(0.007, 6);
    expect(e.incrementalCostUsd).toBeCloseTo(0.02, 6);
  });

  it("不变量：非负、有限、incremental ≤ cold", () => {
    for (const [tok, price] of [
      [8192, DEEPSEEK],
      [1_000_000, DEEPSEEK],
      [50_000, { inputPerM: 1.25, cacheReadPerM: 0.1 }],
      [50_000, { inputPerM: 0.27, cacheReadPerM: 0.27 }], // 缓存读价=输入价 → 增量 0
    ] as const) {
      const e = estimateRewarm(tok, price)!;
      expect(e.coldCostUsd).toBeGreaterThanOrEqual(0);
      expect(e.warmCostUsd).toBeGreaterThanOrEqual(0);
      expect(e.incrementalCostUsd).toBeGreaterThanOrEqual(0);
      expect(e.incrementalCostUsd).toBeLessThanOrEqual(e.coldCostUsd + 1e-12);
      expect(Number.isFinite(e.coldCostUsd)).toBe(true);
    }
  });

  it("NaN 先检（比较器拦不住）→ undefined", () => {
    expect(estimateRewarm(Number.NaN, DEEPSEEK)).toBeUndefined();
    expect(estimateRewarm(1000, { inputPerM: Number.NaN, cacheReadPerM: 0.07 })).toBeUndefined();
    expect(estimateRewarm(1000, { inputPerM: 0.27, cacheReadPerM: Number.NaN })).toBeUndefined();
  });

  it("无价不报：inputPerM≤0 / cacheReadPerM 缺语义（负值）→ undefined", () => {
    expect(estimateRewarm(1000, { inputPerM: 0, cacheReadPerM: 0.07 })).toBeUndefined();
    expect(estimateRewarm(1000, { inputPerM: -1, cacheReadPerM: 0.07 })).toBeUndefined();
    expect(estimateRewarm(1000, { inputPerM: 0.27, cacheReadPerM: -0.01 })).toBeUndefined();
    expect(estimateRewarm(0, DEEPSEEK)).toBeUndefined();
  });

  it("T002 #10：乘后溢出为 Infinity → undefined（结果三项 finite 检）", () => {
    expect(estimateRewarm(1e300, { inputPerM: 1e300, cacheReadPerM: 1e300 })).toBeUndefined();
  });

  it("T002 #11：cacheReadPerM=0（免费缓存）合法，incremental=cold（理论最大节省）", () => {
    const e = estimateRewarm(1000, { inputPerM: 3, cacheReadPerM: 0 })!;
    expect(e).toBeDefined();
    expect(e.warmCostUsd).toBe(0);
    expect(e.incrementalCostUsd).toBe(e.coldCostUsd);
  });

  it("T002 #12：cacheReadPerM>inputPerM 时 warm>cold 合法，incremental 钳 0（warm≤cold 非不变量）", () => {
    const e = estimateRewarm(1000, { inputPerM: 3, cacheReadPerM: 5 })!;
    expect(e.warmCostUsd).toBeGreaterThan(e.coldCostUsd);
    expect(e.incrementalCostUsd).toBe(0);
  });
});

describe("133 top1 — offer 决策门", () => {
  const POLICY = DEFAULT_CACHE_CLOCK_POLICY; // 8192 tokens / $0.01
  const bigEst = estimateRewarm(200_000, { inputPerM: 0.27, cacheReadPerM: 0.07 })!; // incremental $0.04
  const tinyEst = estimateRewarm(4_000, { inputPerM: 0.27, cacheReadPerM: 0.07 })!; // prefix below floor
  const cheapEst = estimateRewarm(10_000, { inputPerM: 0.27, cacheReadPerM: 0.26 })!; // incremental $0.0001

  it("冷 + 大前缀 + 过阈 → offer", () => {
    const cls = classifyCacheClock(NOW, hours(3), SAME, SAME);
    expect(coldCacheOffer(cls, bigEst, POLICY).offer).toBe(true);
  });

  it("四闸全挡：warm / identity / no-price / small-prefix / below-threshold", () => {
    expect(coldCacheOffer(classifyCacheClock(NOW, NOW - 60_000, SAME, SAME), bigEst, POLICY)).toEqual({ offer: false, suppressed: "warm" });
    expect(coldCacheOffer(classifyCacheClock(NOW, hours(3), SAME, { model: "x" }), bigEst, POLICY)).toEqual({ offer: false, suppressed: "identity" });
    expect(coldCacheOffer(classifyCacheClock(NOW, hours(3), SAME, SAME), undefined, POLICY)).toEqual({ offer: false, suppressed: "no-price" });
    expect(coldCacheOffer(classifyCacheClock(NOW, hours(3), SAME, SAME), tinyEst, POLICY)).toEqual({ offer: false, suppressed: "small-prefix" });
    expect(coldCacheOffer(classifyCacheClock(NOW, hours(3), SAME, SAME), cheapEst, POLICY)).toEqual({ offer: false, suppressed: "below-threshold" });
  });

  it("T002 #14（F7 裁决翻转）：age_unknown 不 offer——时钟读不到=特性零行为差（不隐形跳预热）", () => {
    expect(coldCacheOffer({ reason: "age_unknown", confidence: "may_be_cold", idleSeconds: 0 }, bigEst, POLICY)).toEqual({ offer: false, suppressed: "no-clock" });
  });
});
