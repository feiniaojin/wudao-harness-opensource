// M58 §C#1 — acceptEdits: the fourth permission mode. Edits auto-allow,
// commands still ask, and the mode is RUNTIME state only — the serialized
// system-prompt prefix must stay byte-identical across a mode switch (the
// provider prefix cache must not see the cycle).
import { describe, it, expect } from "vitest";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { Tool } from "@wudao-org/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { decideRichPermission, EMPTY_PERMISSION_SETTINGS } from "../src/permission.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const pathParams = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubTool(name: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: pathParams,
    execute: async (input) => ({ content: `${name} ran on ${String(input.path)}` }),
  });
}

/** The frontends' gate shape: layered rules over the LIVE mode, asks parked
 *  through the driver's ask seam (pendingPermission). */
function wireGate(driver: AgentDriver): (toolName: string, input: Record<string, unknown>) => Promise<import("@wudao-org/core").PermissionDecision> {
  return async (toolName, input) => {
    const d = decideRichPermission({ mode: driver.getMode(), toolName, input, settings: EMPTY_PERMISSION_SETTINGS });
    return d !== "ask" ? d : driver.ask(toolName, input);
  };
}

describe("acceptEdits (M58 §C#1)", () => {
  it("setMode does not touch the system prompt — the serialized prefix is byte-identical across the switch", () => {
    const model = createScriptedModel([{ role: "assistant", content: "done" }]);
    const driver = createAgentDriver({
      model,
      tools: [stubTool("write_file")],
      systemPrompt: "PROMPT-PREFIX-BYTES",
      summarize: summarizeToolCall,
      mode: "default",
    });
    const before = driver.state.systemPrompt;
    expect(driver.getMode()).toBe("default");
    driver.setMode("acceptEdits");
    expect(driver.getMode()).toBe("acceptEdits");
    expect(driver.state.systemPrompt).toBe(before);
    // And across the whole cycle — every stop shares the same prefix bytes.
    driver.setMode("auto");
    driver.setMode("read-only");
    driver.setMode("default");
    expect(driver.state.systemPrompt).toBe(before);
    driver.dispose();
  });

  it("edits run without an ask in acceptEdits; commands still park one (det-44 semantics)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "WROTE-DONE" },
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "shell", arguments: { path: "cmd" } }] },
      { role: "assistant", content: "CMD-DONE" },
    ]);
    const tools = [stubTool("write_file"), stubTool("shell")];
    const driver = createAgentDriver({
      model,
      tools,
      systemPrompt: "s",
      summarize: summarizeToolCall,
      mode: "acceptEdits",
      // The verify stop gate would demand an extra model call after the edit.
      gates: { verify: false },
    });
    // Re-wire canUseTool after construction so the gate reads the driver's
    // live mode (the closure needs the driver handle).
    driver.setOptions({
      model,
      tools,
      systemPrompt: "s",
      summarize: summarizeToolCall,
      mode: "acceptEdits",
      gates: { verify: false },
      canUseTool: wireGate(driver),
    });
    // Run 1 (write_file): an ungated edit means the run settles on its own —
    // a parked ask would keep it busy forever.
    driver.submit("edit the file");
    await until(() => !driver.getStatus().busy && (driver.getHistory().some((e) => e.kind === "assistant" && e.text === "WROTE-DONE")), "write run to settle ungated");
    expect(driver.getStatus().pendingPermission).toBeNull();
    expect(driver.getHistory().some((e) => e.kind === "tool" && e.name === "write_file")).toBe(true);
    // Run 2 (shell): the default pipeline inside acceptEdits still
    // parks the human ask.
    driver.submit("run the command");
    await until(() => driver.getStatus().pendingPermission !== null, "shell to park an ask");
    expect(driver.getStatus().pendingPermission?.toolName).toBe("shell");
    expect(driver.getStatus().busy).toBe(true);
    expect(driver.answerPermission(false, "test deny")).toBe(true);
    await until(() => !driver.getStatus().busy && (driver.getHistory().some((e) => e.kind === "assistant" && e.text === "CMD-DONE")), "command run to settle");
    driver.dispose();
  }, 10000);
});
