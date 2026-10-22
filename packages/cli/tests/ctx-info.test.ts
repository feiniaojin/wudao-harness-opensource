// M76-ux2 §8 — the ctxInfo driver op (PROTOCOL "ctxInfo"): the serialized
// prompt's per-section token estimates (system / tool schemas / messages)
// plus the free remainder against the context window. Same chars/4 accounting
// the ctx watermark uses (estimateTokensBreakdown), read from LIVE state — a
// loadHistory swap is immediately visible. This is the data face of the web
// StatusBar's ctx hover; it never rides the permission pipeline (a data op).
import { describe, it, expect, vi } from "vitest";
import { buildTool, createScriptedModel, toModelToolDefinition } from "@wudao/core";
import type { AgentMessage } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

const readOnlyParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubTool(): ReturnType<typeof buildTool> {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: readOnlyParams,
    execute: async () => ({ content: "STUB" }),
  });
}

describe("AgentDriver.ctxInfo (M76-ux2 §8)", () => {
  it("reports the per-section estimates from live state: system, tools, messages, available", async () => {
    const tool = stubTool();
    const driver: AgentDriver = createAgentDriver({
      systemPrompt: "s".repeat(400), // 100 tokens
      summarize: summarizeToolCall,
      model: createScriptedModel([]),
      tools: [tool],
    });
    try {
      const info = await driver.ctxInfo();
      const toolTokens = Math.ceil(JSON.stringify(toModelToolDefinition(tool)).length / 4);
      expect(info.systemTokens).toBe(100);
      expect(info.toolsTokens).toBe(toolTokens);
      expect(info.messagesTokens).toBe(0); // fresh session, nothing loaded
      // Default window (no compaction config): 64k minus the combined estimate.
      expect(info.availableTokens).toBe(64_000 - (100 + toolTokens));
    } finally {
      driver.dispose();
    }
  });

  it("follows the live conversation: messagesTokens reflects a loadHistory swap immediately", async () => {
    const driver: AgentDriver = createAgentDriver({
      systemPrompt: "s".repeat(40),
      summarize: summarizeToolCall,
      model: createScriptedModel([]),
      tools: [],
    });
    try {
      const messages: AgentMessage[] = [{ role: "user", content: "x".repeat(800) }];
      driver.loadHistory(messages, "sess-ctxinfo");
      const info = await driver.ctxInfo();
      expect(info.messagesTokens).toBe(200);
      expect(info.toolsTokens).toBe(0);
      // loadHistory seeds state; the estimate is the same one the ctx
      // watermark's updateCtxTokens would compute over this state.
      driver.loadHistory([{ role: "user", content: "y".repeat(4000) }], "sess-ctxinfo-2");
      await expect(driver.ctxInfo()).resolves.toMatchObject({ messagesTokens: 1000 });
    } finally {
      driver.dispose();
    }
  });

  it("counts image riders as the imagesTokens dimension (R5-I1); 0 on text-only state", async () => {
    const driver: AgentDriver = createAgentDriver({
      systemPrompt: "s".repeat(40),
      summarize: summarizeToolCall,
      model: createScriptedModel([]),
      tools: [],
    });
    try {
      // Fresh text-only state: imagesTokens reports 0 (never undefined).
      expect((await driver.ctxInfo()).imagesTokens).toBe(0);

      const img = (byteLength: number) => ({
        kind: "image" as const,
        ref: { kind: "image" as const, attachmentId: "00000000-0000-4000-8000-000000000000", mediaType: "image/png", byteLength },
      });
      driver.loadHistory(
        [
          { role: "user", content: "look", images: [img(75_000)] },
          { role: "assistant", content: "seen" },
        ],
        "sess-ctxinfo-img",
      );
      const info = await driver.ctxInfo();
      // base 85 + ceil(75_000/750) = 185 — the image term the watermark also counts.
      expect(info.imagesTokens).toBe(85 + 100);
      expect(info.messagesTokens).toBe(Math.ceil(("look" + "seen").length / 4)); // text chars/4 unchanged
      expect(info.availableTokens).toBe(64_000 - (info.systemTokens + info.toolsTokens + info.messagesTokens + info.imagesTokens));
    } finally {
      driver.dispose();
    }
  });

  it("never fires the permission pipeline (a read-only data op over state)", async () => {
    const ask = vi.fn();
    const driver: AgentDriver = createAgentDriver({
      systemPrompt: "s",
      summarize: summarizeToolCall,
      model: createScriptedModel([]),
      tools: [],
      onPermissionAsk: ask,
    });
    try {
      await driver.ctxInfo();
      expect(ask).not.toHaveBeenCalled();
    } finally {
      driver.dispose();
    }
  });
});
