// ω99-188 receipts — usage 行双通道中文化（cache.ts 渲染 4 面 + index/repl `← 模型` 锁步对 + debug 行）。
// 归因值/百分比/kb 形/`←`/缩进 token 全部按 brief §零保留。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CacheStats, formatUsageLine } from "../src/cache.js";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SRC = {
  cache: readFileSync(join(srcDir, "cache.ts"), "utf8"),
  index: readFileSync(join(srcDir, "index.ts"), "utf8"),
  repl: readFileSync(join(srcDir, "repl.ts"), "utf8"),
};

describe("ω99-188 A — formatUsageLine 主行三态", () => {
  it("无注记：缓存 94.2%（命中 45.2k / 未命中 2.8k）", () => {
    expect(formatUsageLine({ promptTokens: 48000, cacheHitTokens: 45200, cacheMissTokens: 2800 })).toBe(
      "缓存 94.2%（命中 45.2k / 未命中 2.8k）",
    );
  });

  it("回退注记（M62 链）：[回退 模型（自 来源）] 两形", () => {
    expect(
      formatUsageLine({
        promptTokens: 48000,
        cacheHitTokens: 45200,
        cacheMissTokens: 2800,
        fallbackModel: "glm-4.6",
        fallbackFrom: "deepseek-chat",
      }),
    ).toBe("缓存 94.2%（命中 45.2k / 未命中 2.8k） [回退 glm-4.6（自 deepseek-chat）]");
    expect(
      formatUsageLine({ promptTokens: 48000, cacheHitTokens: 45200, cacheMissTokens: 2800, fallbackModel: "glm-4.6" }),
    ).toBe("缓存 94.2%（命中 45.2k / 未命中 2.8k） [回退 glm-4.6]");
  });

  it("冷注记（M63 §A）：归因值 token 原样骑行；普通轮无后缀", () => {
    expect(
      formatUsageLine({
        promptTokens: 48000,
        cacheHitTokens: 0,
        cacheMissTokens: 48000,
        coldTurnExpected: true,
        cacheBreakAttribution: "provider switched — full history reprocessed",
      }),
    ).toBe("缓存 0.0%（命中 0k / 未命中 48k） [冷：provider switched — full history reprocessed]");
    expect(formatUsageLine({ promptTokens: 100, cacheHitTokens: 100, cacheMissTokens: 0 })).not.toContain("[冷");
  });

  it("-- 零除态：formatCachePercent 输出 token 原样骑行", () => {
    expect(formatUsageLine({ promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 })).toBe("缓存 --（命中 0k / 未命中 0k）");
  });
});

describe("ω99-188 B — summaryLine", () => {
  it("2 次调用态 toBe 全等；零调用 → null", () => {
    const stats = new CacheStats();
    stats.record({ promptTokens: 900, cacheHitTokens: 0, cacheMissTokens: 900 });
    stats.record({ promptTokens: 5000, cacheHitTokens: 4000, cacheMissTokens: 1000 });
    expect(stats.summaryLine()).toBe("缓存：67.8%（命中 4k / 未命中 1.9k，2 次模型调用）");
    expect(new CacheStats().summaryLine()).toBeNull();
  });

  it("1 次调用态：复数 s 分支随面 #4 消解", () => {
    const stats = new CacheStats();
    stats.record({ promptTokens: 5000, cacheHitTokens: 4000, cacheMissTokens: 1000 });
    expect(stats.summaryLine()).toBe("缓存：80.0%（命中 4k / 未命中 1k，1 次模型调用）");
  });
});

describe("ω99-188 C — 三域 src 锁步（旧形=0 / 新形在位）", () => {
  it("旧英文形在三域 src 零残留（渲染形 `(hit ${`；裸头词见 census 归类）", () => {
    for (const text of [SRC.cache, SRC.index, SRC.repl]) {
      expect(text).not.toContain("(hit ${");
      expect(text).not.toContain("← model (");
      expect(text).not.toContain("tool call(s)");
      expect(text).not.toContain("[cold: ");
    }
  });

  it("新形在位：缓存（命中 … / 未命中 …）· ← 模型（… 个工具调用）· 输入：", () => {
    expect(SRC.cache).toContain("（命中 ${kb(u.cacheHitTokens)} / 未命中 ${kb(u.cacheMissTokens)}）");
    expect(SRC.cache).toContain("（命中 ${kb(this.hit)} / 未命中 ${kb(miss)}，${this.calls} 次模型调用）");
    expect(SRC.index).toContain("\\n← 模型（${event.toolCallCount} 个工具调用）\\n");
    expect(SRC.repl).toContain("\\n← 模型（${event.toolCallCount} 个工具调用）\\n");
    expect(SRC.index).toContain("    输入：${JSON.stringify(event.input)}\\n");
  });
});
