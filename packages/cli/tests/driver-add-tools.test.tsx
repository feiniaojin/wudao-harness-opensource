// 夜移 018 (#31 ⑥延迟预取 wudao 适配) — MCP 后台装载：boot 不等握手。
// The gap: both the TUI (:949) and the desktop `wudao ui` (:751) boots AWAIT
// loadMcpToolsFor before first paint / before the server listens — with MCP
// servers configured, their spawn+initialize handshakes delay time-to-UI.
// The fix: a driver `addTools` seam (idle: append + receipt; busy: park at
// the run-settle boundary — the same discipline as pendingExtSwap: never
// mid-run, the in-flight request keeps its tool bytes) + both boots hand an
// UNAWAITED load promise over; tools land in the user's typing window.
//
//   ① idle      addTools appends; the next run's ModelInput carries the
//               tool; the M35-style receipt lands in history;
//   ② busy      parks — the in-flight ModelInput does NOT carry it; the
//               settle seam applies it; the NEXT run does; receipt says so;
//   ③ empty     addTools([]) is a no-op (no receipt, no tool);
//   ④ merge     two parked addTools during one run both land at settle;
//   ⑤ TUI e2e   the deferredTools promise resolving after mount feeds the
//               driver through the app's mount effect (receipt + tool in
//               the run).
import { describe, it, expect, afterEach } from "vitest";
import React from "react";
import { render } from "ink-testing-library";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTool, createScriptedModel } from "@wudao-org/core";
import type { AgentMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import type { ProviderConfig } from "@wudao-org/providers";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import type { AgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";
import { WudaoApp } from "../src/tui/app.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const config: ProviderConfig = { apiKey: "test-key", baseURL: "http://127.0.0.1:1/v1", model: "fake-model-x" };

const mcpParams = { type: "object" as const, properties: {}, additionalProperties: false as const };

function mcpTool(name: string): Tool {
  return buildTool({
    name,
    description: "stub mcp tool",
    parameters: mcpParams,
    execute: async () => ({ content: "ok" }),
  });
}

/** Records every ModelInput AT ENTRY, then hangs until release() — the
 *  in-flight-run observer (what the busy-path parking must NOT disturb). */
function recordingGatedModel(): ModelClient & { inputs: ModelInput[]; release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const inner = createScriptedModel([
    { role: "assistant", content: "first answer", stopReason: "end_turn" },
    { role: "assistant", content: "second answer", stopReason: "end_turn" },
    { role: "assistant", content: "third answer", stopReason: "end_turn" },
  ]);
  const inputs: ModelInput[] = [];
  let calls = 0;
  return {
    inputs,
    release: () => open(),
    async generate(input: ModelInput): Promise<AgentMessage> {
      calls += 1;
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })), tools: input.tools });
      const r = await inner.generate(input);
      await gate;
      return r;
    },
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const notices = (d: AgentDriver): readonly string[] =>
  d.getHistory().filter((e) => e.kind === "notice").map((e) => (e.kind === "notice" ? e.text : ""));

async function type(stdin: { write(s: string): void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await wait(15);
  }
}

describe("夜移 018 — driver addTools seam (deferred MCP load, boot never waits on handshakes)", () => {
  it("① idle: appends + receipt; the next run's ModelInput carries the tool", async () => {
    const model = recordingGatedModel();
    const d = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
    const t = mcpTool("mcp__srv_a");
    d.addTools([t]);
    expect(notices(d).some((n) => n.includes("mcp__srv_a") && n.includes("一次性工具集变更"))).toBe(true); // ω99-166f-iii: 钉随源演进
    d.submit("hello");
    await until(() => model.inputs.length === 1, "first model call");
    model.release();
    await until(() => d.getStatus().busy === false, "run settles");
    expect(model.inputs[0]!.tools?.some((td) => td.name === "mcp__srv_a")).toBe(true);
    d.dispose();
  });

  it("② busy: parks — the in-flight input does NOT carry it; settle applies; the NEXT run does", async () => {
    const model = recordingGatedModel();
    const d = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
    d.submit("first");
    await until(() => model.inputs.length === 1, "first model call in flight");
    // Mid-run arrival — must park (byte-stability of the in-flight request).
    d.addTools([mcpTool("mcp__srv_b")]);
    expect(model.inputs[0]!.tools?.some((td) => td.name === "mcp__srv_b")).not.toBe(true);
    expect(notices(d).length).toBe(0); // no premature receipt while parked
    model.release();
    await until(() => d.getStatus().busy === false, "run settles");
    expect(notices(d).some((n) => n.includes("mcp__srv_b") && n.includes("运行收束时落地"))).toBe(true); // ω99-166f-iii: 钉随源演进（#1 settle 臂；brief 钉表漏盘）
    d.submit("second");
    await until(() => model.inputs.length === 2, "second model call");
    model.release();
    await until(() => d.getStatus().busy === false, "second run settles");
    expect(model.inputs[1]!.tools?.some((td) => td.name === "mcp__srv_b")).toBe(true);
    d.dispose();
  });

  it("③ addTools([]) is a no-op — no receipt, no tool", async () => {
    const model = recordingGatedModel();
    const d = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
    d.addTools([]);
    expect(notices(d).length).toBe(0);
    d.dispose();
  });

  it("④ two parked addTools during one run merge and both land at settle", async () => {
    const model = recordingGatedModel();
    const d = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model, tools: [] });
    d.submit("first");
    await until(() => model.inputs.length === 1, "first model call in flight");
    d.addTools([mcpTool("mcp__srv_c")]);
    d.addTools([mcpTool("mcp__srv_d")]);
    model.release();
    await until(() => d.getStatus().busy === false, "run settles");
    d.submit("second");
    await until(() => model.inputs.length === 2, "second model call");
    model.release();
    await until(() => d.getStatus().busy === false, "second run settles");
    expect(model.inputs[1]!.tools?.some((td) => td.name === "mcp__srv_c")).toBe(true);
    expect(model.inputs[1]!.tools?.some((td) => td.name === "mcp__srv_d")).toBe(true);
    d.dispose();
  });

  it("⑤ TUI e2e: deferredTools resolving after mount feeds the driver (receipt + tool in the run)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "DEFERRED-OK", stopReason: "end_turn" }]);
    const root = mkdtempSync(join(tmpdir(), "night018-tui-"));
    roots.push(root);
    let resolveTools!: (t: Tool[]) => void;
    const deferred = new Promise<readonly Tool[]>((r) => { resolveTools = r; });
    const inst = render(
      <WudaoApp config={config} workspaceRoot={root} contextWindowTokens={64000} modelOverride={model} tools={[]} deferredTools={deferred} />,
    );
    await wait();
    // The typing-window arrival: the app is already painted; tools land now.
    resolveTools([mcpTool("mcp__srv_e")]);
    await until(() => (inst.lastFrame() ?? "").includes("mcp__srv_e"), "tool-loaded receipt in frame");
    inst.unmount();
  });
});
