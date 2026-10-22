// 133 top1 — 台账面收据：entries→缓存身份（最后一条胜）、决策组装、
// 文案（身份变化/冷+估价/冷+无价/暖沉默/无记录沉默）。
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@wudao/core";
import {
  ledgerCacheIdentity,
  coldCacheResumeDecision,
  formatIdle,
  renderColdCacheNotice,
} from "../src/cache-clock-ledger.js";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const SAME = { model: "glm-5.3", provider: "glm-code" };
const PRICE = { inputPerM: 0.27, cacheReadPerM: 0.07 };

const entries = (...xs: Record<string, unknown>[]): SessionEntry[] =>
  xs.map((x) => ({ type: "model_change", ...x }) as never);

describe("133 top1 — 台账身份读取", () => {
  it("最后一条 model_change + 最后一条 thinking_level_change 胜", () => {
    const es = entries(
      { model: "deepseek-chat", provider: "deepseek", at: "2026-09-01T00:00:00Z" },
      { type: "thinking_level_change", level: "medium" },
      { model: "glm-5.3", provider: "glm-code", at: "2026-09-05T00:00:00Z" },
      { type: "thinking_level_change", level: "high" },
    );
    expect(ledgerCacheIdentity(es)).toEqual({ model: "glm-5.3", provider: "glm-code", reasoningEffort: "high" });
  });

  it("消息条目跳过；无 model_change → undefined；坏行字段忽略（fail-safe）", () => {
    expect(ledgerCacheIdentity([{ role: "user", content: "hi" } as never])).toBeUndefined();
    expect(ledgerCacheIdentity([{ type: "thinking_level_change", level: "high" } as never])).toBeUndefined();
    expect(ledgerCacheIdentity(entries({ model: "", at: "x" }))).toBeUndefined();
  });

  it("T003 N2：逐行 last-wins 无跨行残留——后来行缺 provider 则不继承旧值", () => {
    // 全行 last-wins
    expect(ledgerCacheIdentity(entries({ model: "m1", provider: "p1" }, { model: "m2", provider: "p2" }))).toEqual({
      model: "m2",
      provider: "p2",
    });
    // T003 N2 翻转：后来行缺 provider → identity 无 provider（不残留 p1）
    expect(ledgerCacheIdentity(entries({ model: "m1", provider: "p1" }, { model: "m2" }))).toEqual({ model: "m2" });
    // 空 model 被忽略 → model 保持 m1（空串清 provider 不影响 model）
    expect(ledgerCacheIdentity(entries({ model: "m1", provider: "p1" }, { model: "", provider: "p2" }))?.model).toBe("m1");
  });

  it("T003 N11：provider_change 行自带 provider+model，按行更新身份", () => {
    expect(
      ledgerCacheIdentity([
        { type: "model_change", model: "m1", provider: "p1", at: "t1" } as never,
        { type: "provider_change", provider: "p2", model: "m2", from: "p1", at: "t2" } as never,
      ]),
    ).toEqual({ model: "m2", provider: "p2" });
    // 只有 provider_change（无 model_change）也能立身份
    expect(ledgerCacheIdentity([{ type: "provider_change", provider: "p2", model: "m2", at: "t2" } as never])).toEqual({
      model: "m2",
      provider: "p2",
    });
  });

  it("T003 N2 端到端：残行场景不再误报 identity_changed（走闲置车道）", () => {
    const d = coldCacheResumeDecision({
      entries: entries({ model: "m1", provider: "p1" }, { model: "m2" }),
      lastActivityMs: NOW - 3 * HOUR,
      nowMs: NOW,
      currentIdentity: { model: "m2", provider: "p2" },
      prefixTokens: 100_000,
      price: PRICE,
    });
    expect(d.classification.reason).toBe("idle"); // 不是 identity_changed
    expect(d.notice).not.toContain("推理档");
  });

  it("T002 #20：null/undefined 元素不抛（防御直接调用方；上游 store 本就过滤）", () => {
    expect(() => ledgerCacheIdentity([{ model: "m1", provider: "p1" } as never, null])).not.toThrow();
    expect(() => ledgerCacheIdentity([undefined as never])).not.toThrow();
  });
});

describe("133 top1 — 决策组装（resume 位一次调用）", () => {
  it("闲置 3h + 大前缀 + 过阈 → offer + 带价通知", () => {
    const d = coldCacheResumeDecision({
      entries: entries({ model: "glm-5.3", provider: "glm-code" }),
      lastActivityMs: NOW - 3 * HOUR,
      nowMs: NOW,
      currentIdentity: SAME,
      prefixTokens: 200_000,
      price: PRICE,
    });
    expect(d.classification.reason).toBe("idle");
    expect(d.classification.confidence).toBe("may_be_cold");
    expect(d.offer.offer).toBe(true);
    expect(d.estimate!.incrementalCostUsd).toBeCloseTo(0.04, 6);
    expect(d.notice).toContain("3.0 小时");
    expect(d.notice).toContain("$0.04");
    expect(d.notice).not.toContain("$0.0400");
  });

  it("身份变化 → 独立通知（不并入 offer），点名新身份", () => {
    const d = coldCacheResumeDecision({
      entries: entries({ model: "glm-5.3", provider: "glm-code" }),
      lastActivityMs: NOW - 3 * HOUR,
      nowMs: NOW,
      currentIdentity: { model: "deepseek-chat", provider: "deepseek" },
      prefixTokens: 200_000,
      price: PRICE,
    });
    expect(d.classification.reason).toBe("identity_changed");
    expect(d.offer.offer).toBe(false);
    expect(d.notice).toContain("deepseek/deepseek-chat");
    expect(d.notice).toContain("重建缓存");
  });

  it("无 mtime（读不到）→ age_unknown → 沉默（不猜）", () => {
    const d = coldCacheResumeDecision({
      entries: entries({ model: "glm-5.3", provider: "glm-code" }),
      lastActivityMs: undefined,
      nowMs: NOW,
      currentIdentity: SAME,
      prefixTokens: 200_000,
      price: PRICE,
    });
    expect(d.classification.reason).toBe("age_unknown");
    expect(d.notice).toBeUndefined();
  });

  it("暖（短闲置）→ 无通知；冷+无价 → 报闲置不报价", () => {
    const warm = coldCacheResumeDecision({
      entries: entries({ model: "glm-5.3", provider: "glm-code" }),
      lastActivityMs: NOW - 60_000,
      nowMs: NOW,
      currentIdentity: SAME,
      prefixTokens: 200_000,
      price: PRICE,
    });
    expect(warm.notice).toBeUndefined();
    const noPrice = coldCacheResumeDecision({
      entries: entries({ model: "glm-5.3", provider: "glm-code" }),
      lastActivityMs: NOW - 3 * HOUR,
      nowMs: NOW,
      currentIdentity: SAME,
      prefixTokens: 200_000,
      price: undefined,
    });
    expect(noPrice.estimate).toBeUndefined();
    expect(noPrice.offer.offer).toBe(false);
    expect(noPrice.notice).toContain("3.0 小时");
    expect(noPrice.notice).not.toContain("$");
  });
});

describe("133 top1 — 口语化", () => {
  it("formatIdle 三档", () => {
    expect(formatIdle(59 * 60)).toBe("59 分钟");
    expect(formatIdle(3 * 3600)).toBe("3.0 小时");
    expect(formatIdle(3 * 86_400)).toBe("3.0 天");
  });

  it("T002 #24：3599s 进位 1.0 小时（不是 60 分钟）；T002 #3：非有限/负数 → 未知时长（永不渲染 NaN）", () => {
    expect(formatIdle(3599)).toBe("1.0 小时");
    expect(formatIdle(NaN)).toBe("未知时长");
    expect(formatIdle(Number.POSITIVE_INFINITY)).toBe("未知时长");
    expect(formatIdle(-5)).toBe("未知时长");
    expect(formatIdle(0)).toBe("1 分钟");
  });
});

describe("133 top1 — T002 文案收口", () => {
  it("#21：identity_changed 文案在 provider 缺失时不渲染悬空斜杠", () => {
    const d = coldCacheResumeDecision({
      entries: entries({ model: "old-model", provider: "p1" }),
      lastActivityMs: NOW - 3 * HOUR,
      nowMs: NOW,
      currentIdentity: { model: "m1" },
      prefixTokens: 100,
      price: PRICE,
    });
    expect(d.notice).toContain("→ m1");
    expect(d.notice).not.toContain("→ /");
  });

  it("T003 N1：畸形 estimate（NaN/Infinity）视同无价——绝不渲染 $NaN", () => {
    // 直接调 render 面（core 产出不了这种 estimate——防御直接调用方）
    const bad = { prefixTokens: 100, coldCostUsd: Number.NaN, warmCostUsd: 0, incrementalCostUsd: Number.NaN } as never;
    const notice = renderColdCacheNotice({ reason: "idle", confidence: "may_be_cold", idleSeconds: 600 }, bad, undefined);
    expect(notice).toContain("10 分钟");
    expect(notice).not.toContain("$");
    const inf = { prefixTokens: 100, coldCostUsd: Number.POSITIVE_INFINITY, warmCostUsd: 0, incrementalCostUsd: Number.POSITIVE_INFINITY } as never;
    expect(renderColdCacheNotice({ reason: "idle", confidence: "may_be_cold", idleSeconds: 600 }, inf, undefined)).not.toContain("$");
  });
});
