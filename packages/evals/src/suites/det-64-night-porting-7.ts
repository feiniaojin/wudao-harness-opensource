// det-64-night-porting-7 — the deterministic behavior pins for 夜移 018
// (候选 #31 ⑥延迟预取 wudao 适配: MCP 后台装载, boot 不等握手). The feature
// landed with cli unit tests (tests/driver-add-tools.test.tsx, 5 contracts
// incl. the full ink TUI render); this suite pays the det-44-style debt the
// same way det-57..det-63 did — the behavior pinned inside the release-eval
// matrix, so a regression fails the release evals, not just a package test
// someone might not run. Zero network, zero real MCP servers.
//
//   ① idle append   addTools while idle appends; the next run's ModelInput
//                   carries the tool; the M35-style receipt lands;
//   ② busy park     mid-run addTools parks — the in-flight ModelInput is
//                   byte-frozen (no new tool); settle applies it and the
//                   NEXT run carries it; the receipt names the boundary;
//   ③ empty no-op   addTools([]) changes nothing (no receipt);
//   ④ merge         two parked arrivals during one run both land.
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import { buildTool, createScriptedModel } from "@wudao/core";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao/core";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting7Evidence {
  // ① idle append
  readonly idleReceipt: boolean;
  readonly idleNextRunCarries: boolean;
  // ② busy park
  readonly inflightFrozen: boolean;
  readonly noPrematureReceipt: boolean;
  readonly settleReceipt: boolean;
  readonly nextRunCarries: boolean;
  // ③ empty no-op
  readonly emptyNoReceipt: boolean;
  // ④ merge
  readonly mergedBothCarried: boolean;
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) return false;
    await wait();
  }
  return true;
}

const mcpParams = { type: "object" as const, properties: {}, additionalProperties: false as const };

function mcpTool(name: string): Tool {
  return buildTool({ name, description: "stub mcp tool", parameters: mcpParams, execute: async () => ({ content: "ok" }) });
}

/** Records each ModelInput at ENTRY, then hangs until release(). */
function recordingGatedModel(): ModelClient & { inputs: ModelInput[]; release: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const inner = createScriptedModel([
    { role: "assistant", content: "first answer", stopReason: "end_turn" },
    { role: "assistant", content: "second answer", stopReason: "end_turn" },
  ]);
  const inputs: ModelInput[] = [];
  let calls = 0;
  return {
    inputs,
    release: () => open(),
    async generate(input: ModelInput): Promise<AssistantMessage> {
      calls += 1;
      inputs.push({ ...input, messages: input.messages.map((m) => ({ ...m })), tools: input.tools });
      const r = await inner.generate(input);
      await gate;
      return r;
    },
  };
}

export const det64Eval: EvalDefinition<Record<string, never>, NightPorting7Evidence> = {
  name: "det-64-night-porting-7",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run() {
    // ① idle append.
    const m1 = recordingGatedModel();
    const d1 = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model: m1, tools: [] });
    d1.addTools([mcpTool("mcp__a")]);
    const idleReceipt = d1.getHistory().some((e) => e.kind === "notice" && e.text.includes("mcp__a") && e.text.includes("一次性工具集变更")); // ω99-166f-iii: 钉随源演进
    d1.submit("hello");
    await until(() => m1.inputs.length === 1);
    m1.release();
    await until(() => d1.getStatus().busy === false);
    const idleNextRunCarries = m1.inputs[0]?.tools?.some((t) => t.name === "mcp__a") === true;
    d1.dispose();

    // ② busy park + ③ empty no-op.
    const m2 = recordingGatedModel();
    const d2 = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model: m2, tools: [] });
    // ③ no-op = ZERO appended events, not "no notice anywhere" — the driver's
    // history already carries session-start notices before any addTools call.
    const beforeEmpty = d2.getHistory().length;
    d2.addTools([]);
    const emptyNoReceipt = d2.getHistory().length === beforeEmpty;
    d2.submit("first");
    await until(() => m2.inputs.length === 1);
    d2.addTools([mcpTool("mcp__b")]);
    const inflightFrozen = m2.inputs[0]?.tools?.some((t) => t.name === "mcp__b") !== true;
    const noPrematureReceipt = d2.getHistory().some((e) => e.kind === "notice" && e.text.includes("mcp__b")) !== true;
    m2.release();
    await until(() => d2.getStatus().busy === false);
    const settleReceipt = d2.getHistory().some((e) => e.kind === "notice" && e.text.includes("mcp__b") && e.text.includes("运行收束时落地")); // ω99-166f-iii: 钉随源演进（#1 settle 臂；brief 钉表漏盘）
    d2.submit("second");
    await until(() => m2.inputs.length === 2);
    m2.release();
    await until(() => d2.getStatus().busy === false);
    const nextRunCarries = m2.inputs[1]?.tools?.some((t) => t.name === "mcp__b") === true;
    d2.dispose();

    // ④ merge.
    const m3 = recordingGatedModel();
    const d3 = createAgentDriver({ systemPrompt: "s", summarize: summarizeToolCall, model: m3, tools: [] });
    d3.submit("first");
    await until(() => m3.inputs.length === 1);
    d3.addTools([mcpTool("mcp__c")]);
    d3.addTools([mcpTool("mcp__d")]);
    m3.release();
    await until(() => d3.getStatus().busy === false);
    d3.submit("second");
    await until(() => m3.inputs.length === 2);
    m3.release();
    await until(() => d3.getStatus().busy === false);
    const mergedBothCarried = m3.inputs[1]?.tools?.some((t) => t.name === "mcp__c") === true
      && m3.inputs[1]?.tools?.some((t) => t.name === "mcp__d") === true;
    d3.dispose();

    return {
      idleReceipt,
      idleNextRunCarries,
      inflightFrozen,
      noPrematureReceipt,
      settleReceipt,
      nextRunCarries,
      emptyNoReceipt,
      mergedBothCarried,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.idleReceipt, "① idle addTools lands the one-time-toolset-change receipt");
    need(e.idleNextRunCarries, "① the next run's ModelInput carries the added tool");
    need(e.inflightFrozen, "② a mid-run arrival NEVER disturbs the in-flight request's tool bytes");
    need(e.noPrematureReceipt, "② no receipt while parked (premature receipt would mislead)");
    need(e.settleReceipt, "② the settle application names the run-settle boundary in the receipt");
    need(e.nextRunCarries, "② the run AFTER the settle carries the tool");
    need(e.emptyNoReceipt, "③ addTools([]) is a no-op (no receipt)");
    need(e.mergedBothCarried, "④ two parked arrivals during one run both land at settle");

    return errs;
  },
};
