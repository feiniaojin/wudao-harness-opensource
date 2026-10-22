// M58 §C#13 — the cache-cost notice: a successful /model switch appends
// "cache is cold next turn (per-model cache namespace)" to its receipt.
// /effort gets NO notice — OpenAI-compatible request prefixes don't vary
// with effort, and a fake cost warning would be a lie.
import { describe, it, expect } from "vitest";
import { createScriptedModel, buildTool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { MODEL_SWITCH_CACHE_NOTE } from "../src/commands/model.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

const stubTool = buildTool({
  name: "read_file",
  description: "stub read",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
  execute: async () => ({ content: "x" }),
});

function noticeTexts(driver: ReturnType<typeof createAgentDriver>): string[] {
  return driver
    .getHistory()
    .filter((e): e is { kind: "notice"; text: string } => e.kind === "notice")
    .map((e) => e.text);
}

describe("model-switch cache-cost notice (M58 §C#13)", () => {
  it("/model carries the cold-cache note", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "x" }]),
      tools: [stubTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      // No workspaceRoot → the model_change entry write is skipped (no fs).
      sessionMeta: { provider: "deepseek", model: "old-model" },
      availableModels: [
        { provider: "deepseek" as const, model: "old-model", source: "env" as const },
        { provider: "deepseek" as const, model: "new-model", source: "env" as const },
      ],
    });
    driver.submit("/model new-model");
    await wait(30);
    const notices = noticeTexts(driver);
    expect(notices.some((t) => t.includes("模型 → deepseek/new-model"))).toBe(true); // ω99-195: 钉随源演进
    expect(notices.some((t) => t.includes(MODEL_SWITCH_CACHE_NOTE))).toBe(true);
    // The note names the reason, not just a bare warning.
    expect(MODEL_SWITCH_CACHE_NOTE).toContain("缓存命名空间"); // ω99-166f-ii: 钉随源演进
    driver.dispose();
  });

  it("/effort gets NO cache note (prefixes don't change with effort)", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "x" }]),
      tools: [stubTool],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      sessionMeta: { provider: "deepseek", model: "old-model" },
    });
    driver.submit("/effort high");
    await wait(30);
    const notices = noticeTexts(driver);
    expect(notices.some((t) => t.includes("effort → high"))).toBe(true);
    expect(notices.some((t) => t.includes("cache is cold"))).toBe(false);
    driver.dispose();
  });

  it("the note text is pinned (receipt stability)", () => {
    expect(MODEL_SWITCH_CACHE_NOTE).toBe(
      "❄️ 切模型后下一轮缓存变冷——切模型会更换供应商的缓存命名空间（下一个请求对整个提示词重新计费）",
    ); // ω99-166f-ii: 钉随源演进
  });
});
