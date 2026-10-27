// ω99-86 — 子 agent effort 跟随父 live effort（53 停泊债清偿）的 CLI 侧：
// the driver arms effortLiveBox.get = () => modelLive.effort at run start
// (cleared at the run's finally seam — the ω99-79 subagentUpdateBox
// discipline); the task tool reads the getter AT SPAWN, guards
// undefined/""/"off", and spreads the surviving value into the child's
// loopOptions.effortSent — the same trail source the parent run threads
// (agent-driver's own effortSent). The child loop's EXISTING stamp (ω99-53,
// persistence-only AssistantMessage.effort) is the observable. Absent box ⇒
// no key ⇒ byte-identical spawns (the zero-change pin). Override spawns
// (role pin / caller override burned into a resolved child config) YIELD:
// the trail records the burned value, not the parent's live level.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelClient, ModelInput, AssistantMessage, AgentState } from "@wudao/core";
import type { AgentRegistry, AgentSpawnSpec } from "@wudao/core";
import { buildToolSet } from "../src/tools.js";
import { createSessionRegistry } from "../src/agents/index.js";
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

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "effort-box-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

/** The session-engine box shape (ω99-79's stateHandle mirror): an empty
 *  single-slot object the DRIVER writes at run start and clears at run end. */
type EffortLiveBox = { get?: () => string | undefined };

/** A scripted recording model shared by parent and children — core's
 *  withChildQuerySource tags every child-loop call querySource="subagent",
 *  so the child's requests are partitionable from the parent's. */
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

/** A registry stub that records every background spawn's spec verbatim (the
 *  byte-invariance pins assert on spec.loopOptions' key set directly). */
function stubRegistry(): AgentRegistry & { specs: AgentSpawnSpec[] } {
  const specs: AgentSpawnSpec[] = [];
  const stub: unknown = {
    specs,
    spawn: (spec: AgentSpawnSpec) => {
      specs.push(spec);
      return {
        id: "bg-1",
        done: Promise.resolve({ ok: true, report: "stub", turns: 0 }),
        warnings: [],
      };
    },
    awaitAgents: async () => [],
    status: () => [],
    cancel: () => false,
    abortAll: () => {},
    steer: () => {},
  };
  return stub as AgentRegistry & { specs: AgentSpawnSpec[] };
}

describe("ω99-86 effort live box (driver → task tool → child effortSent)", () => {
  it("case1 end-to-end: /effort high (idle) → the next run's armed box → the child's spawn carries the live effort (subagent-tagged request + trail)", async () => {
    const effortLiveBox: EffortLiveBox = {};
    const model = recording([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "task", arguments: { description: "child job", prompt: "research the thing" } }] },
      { role: "assistant", content: "CHILD DONE" },
      { role: "assistant", content: "PARENT DONE" },
    ]);
    let childState: AgentState | undefined;
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox,
      agents: {
        registry: createSessionRegistry(),
        runId: "test-run",
        hooks: {
          onSubagentStop: (_t, state) => {
            childState = state;
            return "allow";
          },
        },
      },
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
      // Idle /effort switch lands on the driver's modelLive NOW (the next
      // run's requests — and, through the box, its children — carry it).
      driver.submit("/effort high");
      await until(() => !driver.getStatus().busy, "switch settles");
      driver.submit("delegate the job");
      await until(() => driver.getStatus().busy === false, "run to finish");

      // The child really ran (its request tagged by core's child wrapper).
      expect(model.inputs.some((i) => i.querySource === "subagent")).toBe(true);
      // The child's final assistant message carries the run's live effort —
      // the ω99-53 trail, threaded through spawn → registry → whitelist →
      // the child loop's stamp. Dropped at ANY of those seams ⇒ undefined.
      expect(childState).toBeDefined();
      const final = childState!.messages.at(-1) as AssistantMessage;
      expect(final.content).toBe("CHILD DONE");
      expect(final.effort).toBe("high");
    } finally {
      driver.dispose();
    }
  });

  it("case2 byte-invariance: no box (bare buildToolSet) → the spawn's loopOptions has NO effortSent key (zero-change pin)", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      agents: { registry: reg, runId: "test-run" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    expect(reg.specs).toHaveLength(1);
    const loopOptions = reg.specs[0]!.loopOptions!;
    expect(loopOptions).toBeDefined();
    expect("effortSent" in loopOptions).toBe(false);
  });

  it("case3 \"off\" guard: an armed getter returning \"off\" does NOT arm the child (no effortSent key — \"off\" is receipt vocabulary, never a wire value)", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const tools = buildToolSet({
      workspaceRoot: root,
      model,
      canUseTool: allow,
      contextWindowTokens: 64_000,
      effortLiveBox: { get: () => "off" },
      agents: { registry: reg, runId: "test-run" },
    });
    const task = tools.find((t) => t.name === "task")!;
    const out = await task.execute({ description: "job", prompt: "do it", background: true });
    expect(out.isError).toBeUndefined();
    const loopOptions = reg.specs[0]!.loopOptions!;
    expect("effortSent" in loopOptions).toBe(false);
  });

  it("case4 override consistency: role/caller override burned low wins over the parent's live high — the child carries the BURNED value", async () => {
    const reg = stubRegistry();
    const model = recording([{ role: "assistant", content: "x" }]);
    const childModel = recording([{ role: "assistant", content: "child on pinned model" }]);
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
    // Caller override reasoningEffort=low → the resolver burns it into the
    // child's config; the live "high" must YIELD (the trail records what the
    // child's requests actually run at — the burned "low").
    const out = await task.execute({ description: "job", prompt: "do it", background: true, reasoningEffort: "low" });
    expect(out.isError).toBeUndefined();
    const loopOptions = reg.specs[0]!.loopOptions!;
    expect(loopOptions.effortSent).toBe("low");
  });
});
