// ω-5b (I21, driver side) — the history receipt `kind:"tool"` carries the
// per-call durationMs mirrored from the loop's finished event (gate +
// execution). The board-result path (todo_write mapped to kind:"board")
// legitimately omits it — pinned as omitted (design §2 I21 acceptance 5).
import { describe, it, expect, vi } from "vitest";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { Tool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";

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
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const allow = vi.fn(async () => ({ kind: "allow" as const }));

function makeDriver(tools: readonly Tool[], model: ReturnType<typeof createScriptedModel>): AgentDriver {
  return createAgentDriver({
    model,
    tools,
    systemPrompt: "s",
    summarize: summarizeToolCall,
    onPermissionAsk: allow,
  });
}

describe("driver history receipt durationMs (ω-5b I21)", () => {
  it("a slow tool lands in history with durationMs; the board path omits it", async () => {
    const slow: Tool = buildTool({
      name: "read_file",
      description: "slow read",
      parameters: params,
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { content: "SLOW RESULT" };
      },
    });
    const board: Tool = buildTool({
      name: "todo_write",
      description: "board",
      parameters: {
        type: "object",
        properties: { todos: { type: "array" } },
        required: ["todos"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "[todo board 0/1 done]\n☐ only" }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { text: "x" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "todo_write", arguments: { todos: [] } }] },
      { role: "assistant", content: "done" },
    ]);
    const driver = makeDriver([slow, board], model);
    await wait();
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    const history = driver.getHistory();
    const toolEntry = history.find((h) => h.kind === "tool");
    expect(toolEntry).toMatchObject({ kind: "tool", name: "read_file", isError: false });
    expect(typeof (toolEntry as { durationMs?: number }).durationMs).toBe("number");
    expect((toolEntry as { durationMs?: number }).durationMs!).toBeGreaterThanOrEqual(40);
    // The board-result path maps to kind:"board" — durationMs omitted there.
    const boardEntry = history.find((h) => h.kind === "board");
    expect(boardEntry).toMatchObject({ kind: "board", done: 0, total: 1 });
    expect("durationMs" in (boardEntry ?? {})).toBe(false);
    driver.dispose();
  });
});
