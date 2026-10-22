// 125 项 2（the upstream projectget_context_remaining 形）— context_remaining 工具的钉子。
// 模型第一次能「查」自己的上下文水位线：{ windowTokens, promptTokens,
// remainingTokens, remainingRatio, compressionThreshold, tokensUntilThreshold }。
// compressionThreshold 与 loop 的 effectiveThreshold 读同一条线（125 项 1 的
// resolveCompactionThresholdTokens 单一真值点）——含 outputReserve 感知。
import { describe, it, expect } from "vitest";
import { createContextRemainingTool, estimateTokens } from "../src/index.js";
import type { ModelToolDefinition } from "../src/index.js";

const defs: readonly ModelToolDefinition[] = [];

describe("125 项 2 — createContextRemainingTool（数值面）", () => {
  const run = async (snapshot: {
    systemPrompt: string;
    messages: { role: "user"; content: string }[];
    contextWindowTokens: number;
    lastUsagePromptTokens?: number;
    threshold?: { thresholdRatio?: number; headroomTokens?: number; outputReserveTokens?: number };
  }): Promise<string> => {
    const tool = createContextRemainingTool(() => ({ tools: defs, ...snapshot }));
    const r = await tool.execute({});
    return r.content as string;
  };

  it("六个数值字段齐全且正确（平比缺省：threshold = 0.8×window）", async () => {
    const out = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "hello world" }],
      contextWindowTokens: 100_000,
    });
    const used = estimateTokens("s", defs, [{ role: "user", content: "hello world" }]);
    const threshold = Math.floor(0.8 * 100_000);
    expect(out).toContain(`windowTokens: 100000`);
    expect(out).toContain(`promptTokens: ${used}`);
    expect(out).toContain(`remainingTokens: ${100_000 - used} (remainingRatio: ${Math.round((1 - used / 100_000) * 100)}%)`);
    expect(out).toContain(`compressionThreshold: ${threshold}`);
    expect(out).toContain(`tokensUntilThreshold: ${threshold - used}`);
  });

  it("threshold 含 outputReserve 感知：长输出配置下早于 80% 平比", async () => {
    // 128K 窗 + 32K reserve → threshold = 93_184（非平比 102_400）。
    const out = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "q" }],
      contextWindowTokens: 128_000,
      threshold: { outputReserveTokens: 32_768 },
    });
    expect(out).toContain("compressionThreshold: 93184");
    expect(out).not.toContain("compressionThreshold: 102400");
  });

  it("lastUsagePromptTokens 赢过估算（与 loop 触发器同纪律）", async () => {
    const out = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "short" }],
      contextWindowTokens: 100_000,
      lastUsagePromptTokens: 50_000,
    });
    expect(out).toContain("promptTokens: 50000");
    expect(out).toContain("remainingTokens: 50000");
  });

  it("remaining 低于 20% 时给外化/收尾建议；高于时不唠叨", async () => {
    const low = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "x".repeat(400) }],
      contextWindowTokens: 1_000,
      lastUsagePromptTokens: 900,
    });
    expect(low).toContain("低于 20%");
    expect(low).toContain("note_write");
    const high = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "q" }],
      contextWindowTokens: 100_000,
    });
    expect(high).not.toContain("低于 20%");
  });

  it("越过触发线时的显式警示行", async () => {
    const out = await run({
      systemPrompt: "s",
      messages: [{ role: "user", content: "q" }],
      contextWindowTokens: 10_000,
      lastUsagePromptTokens: 9_000, // ≥ threshold 8_000
    });
    expect(out).toContain("tokensUntilThreshold: 0");
    expect(out).toContain("已到/越过压缩触发线");
  });
});

describe("125 项 2 — 工具面（只读/零参数/并发安全）", () => {
  it("isReadOnly + isConcurrencySafe + 零参数 schema + description 写明何时查询", () => {
    const tool = createContextRemainingTool(() => ({ systemPrompt: "", tools: [], messages: [], contextWindowTokens: 1 }));
    expect(tool.name).toBe("context_remaining");
    expect(tool.isReadOnly?.({})).toBe(true);
    expect(tool.isConcurrencySafe?.({})).toBe(true);
    expect(tool.isDestructive?.({})).toBe(false);
    expect(tool.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
    expect(tool.description).toContain("20%");
    expect(tool.description).toContain("note_write");
    expect(tool.description).toContain("定期");
  });
});
