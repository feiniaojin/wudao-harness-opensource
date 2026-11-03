// 0.3.15（用户需求：执行耗时可见）—— run 级耗时记账的三件：
//   1. formatMs / formatRunStats 纯函数（一段格式，所有表面一致）；
//   2. driver：assistant 条目携带最后一次 answering 调用的 durationMs、
//      run 落定的最后一条 history 是 耗时收据 notice（模型/工具段按
//      omit-never-null 省略）；
//   3. 脚本模型（不上报 usage.durationMs）→ assistant 不带 durationMs、
//      收据无模型段（不拿 0 冒充）。
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver, formatMs, formatRunStats } from "../src/driver/agent-driver.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: params,
    execute: async () => ({ content: "CONTENT" }),
  });
}

/** A scripted model whose generate reports a usage row with a durationMs —
 *  the real providers' only usage channel (ModelInput.onUsage). Scripted
 *  models alone never call it, which is exactly the negative case below. */
function usageReportingModel(responses: readonly AssistantMessage[], durationMs: number): ModelClient {
  const scripted = createScriptedModel(responses);
  return {
    async generate(input: ModelInput) {
      input.onUsage?.({ promptTokens: 10, cacheHitTokens: 0, cacheMissTokens: 10, durationMs });
      return scripted.generate(input);
    },
  };
}

describe("formatMs", () => {
  it("renders sub-second as <1s, seconds with one decimal, then m/h compaction", () => {
    expect(formatMs(50)).toBe("<1s");
    expect(formatMs(999)).toBe("<1s"); // the guard is <1000ms, not <100
    expect(formatMs(1_500)).toBe("1.5s");
    expect(formatMs(61_234)).toBe("1m01s");
    expect(formatMs(3_723_456)).toBe("1h02m");
  });
});

describe("formatRunStats", () => {
  it("composes total · 模型 · 工具 (n 次) when everything is known", () => {
    expect(formatRunStats(42_300, 18_100, 24_200, 5)).toBe("耗时 42.3s · 模型 18.1s · 工具 24.2s (5 次)");
  });

  it("omits the 模型 segment when no usage row ever reported (null, not zero)", () => {
    expect(formatRunStats(900, null, 0, 0)).toBe("耗时 <1s");
    expect(formatRunStats(2_100, null, 0, 0)).toBe("耗时 2.1s");
  });

  it("omits the 工具 segment on zero tool calls (pure QA turn)", () => {
    expect(formatRunStats(2_100, 2_000, 0, 0)).toBe("耗时 2.1s · 模型 2.0s");
  });

  // 借鉴弧 B1（a reference project C1）：缓存债行——omit-when-zero；k 格式一位小数。
  it("appends 缓存债 when the run booked cache debt (omit-when-zero)", () => {
    expect(formatRunStats(2_100, 2_000, 0, 1, 0, 0, 0)).toBe("耗时 2.1s · 模型 2.0s · 工具 <1s (1 次)");
    expect(formatRunStats(2_100, 2_000, 0, 1, 0, 0, 144_000)).toBe("耗时 2.1s · 模型 2.0s · 工具 <1s (1 次) · 缓存债 144k");
    expect(formatRunStats(2_100, 2_000, 0, 0, 0, 0, 940)).toBe("耗时 2.1s · 模型 2.0s · 缓存债 940");
    expect(formatRunStats(2_100, 2_000, 0, 0, 0, 0, 1_250)).toBe("耗时 2.1s · 模型 2.0s · 缓存债 1.3k");
  });
});

describe("driver run timing (0.3.15)", () => {
  it("stamps the final assistant entry with the answering call's durationMs and lands the 耗时 receipt as the run's last entry", async () => {
    const driver = createAgentDriver({
      model: usageReportingModel(
        [
          { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: { path: "a.ts" } }] },
          { role: "assistant", content: "all done" },
        ],
        2_100,
      ),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("go");
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((h) => h.kind === "assistant" && h.text === "all done"),
      "run to finish",
    );
    const history = driver.getHistory();

    // The tool entry carries the I21 wall clock (already mirrored pre-0.3.15).
    const tool = history.find((h) => h.kind === "tool");
    expect(tool).toBeDefined();
    expect(tool !== undefined && tool.durationMs !== undefined && tool.durationMs >= 0).toBe(true);

    // The reply's own generation time rides the assistant entry.
    const reply = history.find((h) => h.kind === "assistant");
    expect(reply !== undefined && reply.kind === "assistant" && reply.durationMs).toBe(2_100);

    // The receipt is the LAST entry of the run: total · 模型 (both calls
    // reported 2.1s) · 工具 (1 call).
    const last = history[history.length - 1];
    expect(last !== undefined && last.kind === "notice" && last.text.startsWith("耗时 ")).toBe(true);
    const line = last !== undefined && last.kind === "notice" ? last.text : "";
    expect(line).toContain("模型 4.2s"); // two calls × 2.1s
    expect(line).toContain("(1 次)");
  });

  it("a scripted model (no usage durations) keeps the assistant stamp and the 模型 segment honestly absent", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "quick answer" }]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("go");
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((h) => h.kind === "assistant" && h.text === "quick answer"),
      "run to finish",
    );
    const history = driver.getHistory();
    const reply = history.find((h) => h.kind === "assistant");
    expect(reply !== undefined && reply.kind === "assistant" && reply.durationMs).toBeUndefined();
    const last = history[history.length - 1];
    const line = last !== undefined && last.kind === "notice" ? last.text : "";
    expect(line.startsWith("耗时 ")).toBe(true);
    expect(line).not.toContain("模型"); // omit-never-null: no fake zero
    expect(line).not.toContain("工具"); // zero tool calls: no noise segment
  });
});
