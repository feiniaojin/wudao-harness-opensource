// R6 quickwin (ui-review-r5 P2 follow-up) — the defer_loaded event now rides
// history as a dim notice BEFORE the onDeferLoaded seam fires. Before this,
// the load_tools pick was invisible in every frontend: the driver only
// emitted the seam, and the seam's sole consumer is the session store's
// deferred_loaded entry (session-engine) — the web/TUI render history, so
// nothing crossed the wire. Deterministic: scripted model calls load_tools
// once, a shouldDefer stub tool rides the defer controller, no workspace.
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";

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

/** A shouldDefer-marked tool — the defer controller hides it behind the
 * load_tools meta-tool until the model asks for it (M35 §1). */
function deferredHeavyTool(): Tool {
  return buildTool({
    name: "heavy_tool",
    description: "stub deferred orchestration tool",
    parameters: params,
    shouldDefer: () => true,
    isConcurrencySafe: () => false,
    execute: async () => ({ content: "HEAVY-DONE" }),
  });
}

describe("defer_loaded rides history (r6 quickwin)", () => {
  it("a load_tools call lands a dim notice in history, then the seam still fires for the store", async () => {
    const seamCalls: readonly string[][] = [];
    const driver = createAgentDriver({
      model: createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "d1", name: "load_tools", arguments: { names: ["heavy_tool"] } }] },
        { role: "assistant", content: "done" },
      ]),
      tools: [stubReadTool(), deferredHeavyTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      // The meta-tool rides the normal gating pipeline; default mode would
      // park it as an ask — allow upfront (the permission seams have their
      // own tests; this one is about the history notice).
      canUseTool: async () => ({ behavior: "allow" as const }),
      onDeferLoaded: (names) => {
        (seamCalls as string[][]).push([...names]);
      },
    });
    driver.submit("go");
    await until(
      () => driver.getStatus().busy === false && driver.getHistory().some((h) => h.kind === "assistant" && h.text === "done"),
      "run to finish",
    );
    // The notice names the loaded tools and the next-turn semantics — the
    // same facts the tool result carries, surfaced where frontends render.
    const notice = driver.getHistory().find((h) => h.kind === "notice" && h.text.includes("延迟工具已加载")); // ω99-166e-i: 钉随 #5 演进
    expect(notice?.text).toBe(
      "⏳ 延迟工具已加载：heavy_tool——定义下一轮并入工具列表（本次运行工具集已冻结）",
    ); // ω99-166e-i: 钉随 #5 演进（整串逐字）
    // The seam is intact: the session store's deferred_loaded entry still
    // has its one source.
    expect(seamCalls).toEqual([["heavy_tool"]]);
    driver.dispose();
  });

  it("no defer, no notice — runs without a load_tools call stay quiet", async () => {
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "plain" }]),
      tools: [stubReadTool()],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      onDeferLoaded: () => {
        throw new Error("seam must not fire without a load");
      },
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(driver.getHistory().some((h) => h.kind === "notice" && h.text.includes("延迟工具已加载"))).toBe(false); // ω99-166e-i: 负钉随 #5 演进
    driver.dispose();
  });
});
