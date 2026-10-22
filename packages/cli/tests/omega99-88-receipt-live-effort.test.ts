// ω99-88 — the Task receipt's `effective` follows the lane the spawn actually
// runs at (86 concern ④ close-out, contract alignment). Post-ω99-86 an armed
// run's child ModelClient carries the parent's LIVE level (shared client +
// liveConfig), and the trail records it (effortToSend) — but the receipt kept
// reporting the boot static defaultEffort, contradicting both its own contract
// comment ("what the child actually carries") and the same spawn's trail. The
// fix reuses the already-computed ToSend one-liner: effective := effortToSend
// ?? effective — three states: burned override → the burned value; armed live
// → the live value; guard-out/un-armed/armed-unset → the boot baseline. The
// strong assertion face is the captured spawn spec (spec.effectiveReasoningEffort,
// registry-facing); requested/wants/meta-line format are untouched lanes.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AssistantMessage } from "@wudao/core";
import type { AgentRegistry, AgentSpawnSpec } from "@wudao/core";
import { buildToolSet } from "../src/tools.js";
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

const allow = async () => ({ kind: "allow" as const });
type EffortLiveBox = { get?: () => string | undefined };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "receipt-live-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

function recording(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  const model: ModelClient & { inputs: ModelInput[] } = {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages] });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return model;
}

/** Records every background spawn's spec verbatim — the assertion face for
 *  spec.effectiveReasoningEffort (registry-facing receipt, ω99-88's target). */
function stubRegistry(): AgentRegistry & { specs: AgentSpawnSpec[] } {
  const specs: AgentSpawnSpec[] = [];
  const stub: unknown = {
    specs,
    spawn: (spec: AgentSpawnSpec) => {
      specs.push(spec);
      return { id: "bg-1", done: Promise.resolve({ ok: true, report: "stub", turns: 0 }), warnings: [] };
    },
    awaitAgents: async () => [],
    status: () => [],
    cancel: () => false,
    abortAll: () => {},
    steer: () => {},
  };
  return stub as AgentRegistry & { specs: AgentSpawnSpec[] };
}

describe("ω99-88 receipt effective follows the actual lane", () => {
  it("case1 armed no-override: /effort high (idle) → the next run's armed box → the background spawn's receipt carries the live level", async () => {
    const effortLiveBox: EffortLiveBox = {};
    const reg = stubRegistry();
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "task", arguments: { description: "child job", prompt: "research the thing", background: true } }] },
      { role: "assistant", content: "PARENT DONE" },
    ]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox,
      agents: { registry: reg, runId: "test-run" },
    });
    const driver = createAgentDriver({
      systemPrompt: "s",
      summarize: (_n: string, i: Record<string, unknown>) => JSON.stringify(i).slice(0, 60),
      model,
      tools,
      effortLiveBox,
      onPermissionAsk: allow,
    });
    try {
      driver.submit("/effort high");
      await until(() => !driver.getStatus().busy, "switch settles");
      driver.submit("delegate the job");
      await until(() => driver.getStatus().busy === false, "run to finish");
      expect(reg.specs).toHaveLength(1);
      // The child's requests actually run at live "high" (ω99-86's shared-client
      // liveConfig) — the receipt must say the same, not the boot static "off".
      expect(reg.specs[0]!.effectiveReasoningEffort).toBe("high");
    } finally {
      driver.dispose();
    }
  });

  it("case2 override lane pin: a workspace role pin low burned by the resolver beats the live high — the receipt keeps the burned value", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "auditor.json"), JSON.stringify({
      description: "ws auditor",
      systemPrompt: "WS-AUDITOR",
      toolNames: ["read_file"],
      reasoningEffort: "low",
    }));
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const childModel = recording([{ role: "assistant", content: "child on pinned effort" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox: { get: () => "high" },
      agents: {
        registry: reg,
        runId: "test-run",
        resolveModel: (o) => ({ ok: true, model: childModel, effectiveEffort: o.reasoningEffort ?? "off" }),
      },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", role: "auditor", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs).toHaveLength(1);
    expect(reg.specs[0]!.effectiveReasoningEffort).toBe("low");
  });

  it("case3 un-armed byte pin: bare buildToolSet (no box) — the receipt keeps the boot baseline, byte-identical to pre-88", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs[0]!.effectiveReasoningEffort).toBe("low");
    // requested lane untouched: no pin/caller override ⇒ the boot default.
    expect(reg.specs[0]!.reasoningEffort).toBe("low");
  });

  it("case4 armed-unset fallback pin: an armed box whose getter returns undefined (session never set a level) falls back to the boot baseline", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox: { get: () => undefined },
      agents: { registry: reg, runId: "test-run", defaultEffort: "low" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs[0]!.effectiveReasoningEffort).toBe("low");
  });
});
