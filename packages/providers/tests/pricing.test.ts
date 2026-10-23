// 借鉴弧 B1（a reference project C1）— 价目面验收：ratio 自动推导的优先级与边界形状
//（catalog > env > 保守缺省）、免费缓存的永不经济档、registry 行的
// prices 校验（fail-visible）、overlay 的空字段继承。
import { describe, it, expect } from "vitest";
import { deriveCachePricing, isModelPrices, catalogPricesFor, validateUserProviderEntry } from "../src/index.js";
import { DEFAULT_CACHE_WRITE_READ_RATIO } from "@wudao/core";

const PRICES = (inputPerM: number, cacheReadPerM: number, cacheWritePerM?: number) =>
  ({ inputPerM, cacheReadPerM, ...(cacheWritePerM !== undefined ? { cacheWritePerM } : {}) });

describe("B1 ratio 推导链（不手填，来源类型化）", () => {
  it("catalog pin 优先：max(input, cacheWrite)/cacheRead", () => {
    // DeepSeek 形（无独立写价）：0.28/0.028 → 10。
    const d = deriveCachePricing({ catalog: PRICES(0.28, 0.028) });
    expect(d.cacheWriteReadRatio).toBeCloseTo(10, 5);
    expect(d.ratioSource).toBe("catalog");
    // Anthropic 形（写价 1.25× 输入且更贵）：max(3, 3.75)/0.3 = 12.5。
    const a = deriveCachePricing({ catalog: PRICES(3, 0.3, 3.75) });
    expect(a.cacheWriteReadRatio).toBeCloseTo(12.5, 5);
  });

  it("catalog 缺席 → env（WUDAO_PRICE 行的同形输入）", () => {
    const d = deriveCachePricing({ env: PRICES(0.5, 0.1) });
    expect(d.cacheWriteReadRatio).toBeCloseTo(5, 5);
    expect(d.ratioSource).toBe("env");
  });

  it("catalog 在场但推不出（免费读+零输入的空行）→ 回落 env", () => {
    const d = deriveCachePricing({ catalog: PRICES(0, 0), env: PRICES(0.5, 0.1) });
    expect(d.ratioSource).toBe("env");
  });

  it("两档皆无 → 保守缺省（DEFAULT_CACHE_WRITE_READ_RATIO，source default）", () => {
    const d = deriveCachePricing({});
    expect(d.cacheWriteReadRatio).toBe(DEFAULT_CACHE_WRITE_READ_RATIO);
    expect(d.ratioSource).toBe("default");
  });

  it("免费缓存（cacheRead 0、input > 0）→ +Infinity（归档节省 $0，永不经济）", () => {
    const d = deriveCachePricing({ catalog: PRICES(0.14, 0) });
    expect(d.cacheWriteReadRatio).toBe(Number.POSITIVE_INFINITY);
    expect(d.ratioSource).toBe("catalog");
  });

  it("无缓存溢价（ratio 1：input == cacheRead）→ 0 溢价 → breakeven 0", () => {
    const d = deriveCachePricing({ env: PRICES(0.1, 0.1) });
    expect(d.cacheWriteReadRatio).toBe(1);
  });
});

describe("B1 isModelPrices / catalogPricesFor", () => {
  it("形状校验 fail-closed：缺必需面 / 负数 / NaN / 数组全拒", () => {
    expect(isModelPrices(PRICES(1, 0.1))).toBe(true);
    expect(isModelPrices(PRICES(1, 0.1, 2))).toBe(true);
    expect(isModelPrices({ inputPerM: 1 })).toBe(false);
    expect(isModelPrices({ cacheReadPerM: 0.1 })).toBe(false);
    expect(isModelPrices({ inputPerM: -1, cacheReadPerM: 0.1 })).toBe(false);
    expect(isModelPrices({ inputPerM: Number.NaN, cacheReadPerM: 0.1 })).toBe(false);
    expect(isModelPrices({ inputPerM: 1, cacheReadPerM: 0.1, outputPerM: -3 })).toBe(false);
    expect(isModelPrices([1, 0.1])).toBe(false);
    expect(isModelPrices(null)).toBe(false);
  });

  it("catalogPricesFor：精确名查找；缺该模型 = undefined", () => {
    const models = [
      { name: "a", prices: PRICES(1, 0.1) },
      { name: "b" },
    ];
    expect(catalogPricesFor(models, "a")?.inputPerM).toBe(1);
    expect(catalogPricesFor(models, "b")).toBeUndefined();
    expect(catalogPricesFor(undefined, "a")).toBeUndefined();
  });
});

describe("B1 registry 行的 prices 列（fail-visible）", () => {
  const base = { baseUrl: "https://api.example.com" };

  it("好 pin 通过并保留在目录上", () => {
    const r = validateUserProviderEntry("custom", {
      ...base,
      models: [{ name: "m1", contextLength: 128_000, prices: { inputPerM: 0.28, cacheReadPerM: 0.028, outputPerM: 1.1, cacheWritePerM: 0.28 } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.models?.[0]?.prices?.cacheReadPerM).toBe(0.028);
    }
  });

  it("坏形状拒行（静默丢掉会把「配了价」伪装成「价目未知」）", () => {
    const r = validateUserProviderEntry("custom", {
      ...base,
      models: [{ name: "m1", prices: { inputPerM: -1, cacheReadPerM: 0.1 } }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("prices");
  });

  it("缺 cacheRead（ratio 的必需面）拒行", () => {
    const r = validateUserProviderEntry("custom", {
      ...base,
      models: [{ name: "m1", prices: { inputPerM: 1 } }],
    });
    expect(r.ok).toBe(false);
  });
});
