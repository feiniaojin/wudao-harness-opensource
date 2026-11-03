// M31 §2/§3 — adaptive budget wiring + resume_from lineage at the task tool:
// stable t-N callIds on receipts, suggestBudget driving spawn budgets
// (explicit maxTurns wins, env off disables, samples recorded on settle),
// resume_from validating its source (settled + has a child session) and
// spawning a resume child whose first request carries the source transcript.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { AssistantMessage, ModelClient, ModelInput, Tool } from "@wudao-org/core";
import { createReadFileTool, createWriteFileTool } from "@wudao-org/core";
import { createAgentsTaskTool, createRegistryTools, createSessionRegistry, defaultStatsPath, loadAgentStats } from "../src/agents/index.js";
import type { AgentRegistry } from "../src/agents/index.js";

let root: string;
let statsPath: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lineage-"));
  statsPath = join(root, "stats.json");
});
afterEach(async () => {
  // The budget record write is fire-and-forget and can race this cleanup —
  // a failed temp-dir removal must never fail the test.
  try { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* raced */ }
  vi.unstubAllEnvs();
});

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

const answer = (text: string): AssistantMessage => ({ role: "assistant", content: text });

/** Parks its FIRST generate() until released (keeps a background child
 *  verifiably in flight); later calls answer immediately. */
function gatedModel(): { model: ModelClient; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  let parked = false;
  const model: ModelClient = {
    async generate(): Promise<AssistantMessage> {
      if (!parked) {
        parked = true;
        await gate;
      }
      return answer("gated done");
    },
  };
  return { model, release };
}

const ALL_TOOLS: readonly Tool[] = [
  createReadFileTool({ workspaceRoot: root }),
  createWriteFileTool({ workspaceRoot: root }),
];

function task(model: ModelClient, registry: AgentRegistry, over: Record<string, unknown> = {}): Tool {
  return createAgentsTaskTool({
    model,
    allTools: ALL_TOOLS,
    registry,
    workspaceRoot: root,
    runId: "lineage-test",
    defaultEffort: "off",
    statsPath,
    ...over,
  });
}

// ---------------------------------------------------------------------------
// callIds + budget receipts
// ---------------------------------------------------------------------------

describe("task tool — callIds + budget wiring", () => {
  it("sync and background dispatches get stable t-N callIds on their receipts", async () => {
    const registry = createSessionRegistry();
    const model = recordingModel([answer("one"), answer("two"), answer("three")]);
    const t = task(model, registry);
    const sync = await t.execute({ description: "s1", prompt: "p" });
    expect(sync.content).toContain("callId: t-1");
    const bg1 = await t.execute({ description: "b1", prompt: "p", background: true });
    expect(bg1.content).toContain('"callId":"t-2"');
    const bg2 = await t.execute({ description: "b2", prompt: "p", background: true });
    expect(bg2.content).toContain('"callId":"t-3"');
    await registry.awaitAgents({ ids: ["bg-1", "bg-2"], mode: "all" });
  });

  it("await receipts carry the budget {suggested, used, budgetLimited} and lineage ids", async () => {
    const registry = createSessionRegistry();
    const model = recordingModel([answer("worker done")]);
    const t = task(model, registry);
    await t.execute({ description: "w", prompt: "p", background: true, session: "new" });
    const rows = await createRegistryTools(registry)[0]!.execute({ ids: ["bg-1"], mode: "all" });
    const row = (JSON.parse(rows.content) as Array<Record<string, unknown>>)[0]!;
    expect(row.callId).toBe("t-1");
    expect(row.budget).toEqual({ suggested: 20, used: 1, budgetLimited: false }); // <3 samples → default 20
  });

  it("explicit maxTurns wins over the suggestion and lands on the spawn", async () => {
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(statsPath, JSON.stringify({ version: 1, roles: { coder: [
      { turns: 10, ok: true, budgetLimited: false },
      { turns: 20, ok: true, budgetLimited: false },
      { turns: 30, ok: true, budgetLimited: false },
    ] } }));
    const registry = createSessionRegistry();
    const model = recordingModel([answer("quick")]);
    const t = task(model, registry);
    // coder has 3 success samples → suggestion would be 20; explicit 4 wins.
    const spawn = await t.execute({ description: "w", prompt: "p", background: true, role: "coder", maxTurns: 4 });
    expect(spawn.content).toContain('"budget":{"suggested":4}');
    const rows = await createRegistryTools(registry)[0]!.execute({ ids: ["bg-1"], mode: "all" });
    const row = (JSON.parse(rows.content) as Array<Record<string, unknown>>)[0]!;
    expect(row.budget).toEqual({ suggested: 4, used: 1, budgetLimited: false });
  });

  it("3+ success samples make the spawn ride the median (censored samples exert zero force)", async () => {
    const samples = [
      { turns: 10, ok: true, budgetLimited: false },
      { turns: 20, ok: true, budgetLimited: false },
      { turns: 30, ok: true, budgetLimited: false },
      { turns: 999, ok: true, budgetLimited: true }, // censored: must not move the estimate
      { turns: 500, ok: false, budgetLimited: false }, // failure: no force either
    ];
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(statsPath, JSON.stringify({ version: 1, roles: { coder: samples } }));
    const registry = createSessionRegistry();
    const model = recordingModel([answer("quick")]);
    const t = task(model, registry);
    const spawn = await t.execute({ description: "w", prompt: "p", background: true, role: "coder" });
    expect(spawn.content).toContain('"budget":{"suggested":20}');
  });

  it("settled children append a per-role sample to the stats file", async () => {
    const registry = createSessionRegistry();
    const model = recordingModel([answer("sampled")]);
    const t = task(model, registry);
    await t.execute({ description: "w", prompt: "p", background: true, role: "coder" });
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
    await new Promise((r) => setTimeout(r, 30)); // the record write is fire-and-forget
    const stats = await loadAgentStats(statsPath);
    const sample = stats.roles.coder?.at(-1);
    expect(sample).toEqual({ turns: 1, ok: true, budgetLimited: false });
  });

  it("WUDAO_AGENT_BUDGETS=off disables suggestions AND recording", async () => {
    vi.stubEnv("WUDAO_AGENT_BUDGETS", "off");
    const registry = createSessionRegistry();
    const model = recordingModel([answer("off")]);
    const t = task(model, registry);
    const spawn = await t.execute({ description: "w", prompt: "p", background: true, role: "coder" });
    expect(spawn.content).not.toContain('"budget"');
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
    await new Promise((r) => setTimeout(r, 30));
    expect(existsSync(statsPath)).toBe(false);
  });

  it("suggestBudget: false on a single call falls back to the role default", async () => {
    await mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(statsPath, JSON.stringify({ version: 1, roles: { coder: [
      { turns: 10, ok: true, budgetLimited: false },
      { turns: 10, ok: true, budgetLimited: false },
      { turns: 10, ok: true, budgetLimited: false },
    ] } }));
    const registry = createSessionRegistry();
    const model = recordingModel([answer("quick")]);
    const t = task(model, registry);
    const spawn = await t.execute({ description: "w", prompt: "p", background: true, role: "coder", suggestBudget: false });
    expect(spawn.content).toContain('"budget":{"suggested":20}'); // the role default, NOT the median 10
  });
});

// ---------------------------------------------------------------------------
// resume_from lineage (§3)
// ---------------------------------------------------------------------------

describe("task tool — resumeFrom lineage", () => {
  it("unknown call id fails closed", async () => {
    const model = recordingModel([]);
    const r = await task(model, createSessionRegistry()).execute({
      description: "r", prompt: "p", background: true, resumeFrom: "t-9",
    });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("t-9");
  });

  it("an in-flight source is refused (resume needs a settled source)", async () => {
    const registry = createSessionRegistry();
    const first = gatedModel();
    const t = task(first.model, registry);
    await t.execute({ description: "s", prompt: "p", background: true, session: "new" });
    const r = await t.execute({ description: "r", prompt: "p", background: true, resumeFrom: "t-1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("in flight");
    first.release();
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
  });

  it("a source that ran without a child session cannot be resumed", async () => {
    const registry = createSessionRegistry();
    const model = recordingModel([answer("no session")]);
    const t = task(model, registry);
    await t.execute({ description: "s", prompt: "p", background: true });
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
    const r = await t.execute({ description: "r", prompt: "p", background: true, resumeFrom: "t-1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("child session");
  });

  it("resumeFrom spawns a resume child: prior transcript + [resume] steering, parentCallId lineage", async () => {
    const registry = createSessionRegistry();
    // One tool → one bound model serving BOTH children: call 1 = child A
    // (fresh), call 2 = child B (the resume).
    const model = recordingModel([answer("STEP-ONE-DONE: mapped the modules"), answer("STEP-TWO-DONE: implemented on top")]);
    const t = task(model, registry);
    const s1 = await t.execute({ description: "explore", prompt: "map the modules", background: true, session: "new" });
    expect(s1.isError).toBeFalsy();
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });

    // Child B resumes t-1: its FIRST request must carry A's transcript and
    // the [resume] steering — explore→implement without re-reading anything.
    const s2 = await t.execute({ description: "implement", prompt: "implement the plan", background: true, resumeFrom: "t-1" });
    expect(s2.isError).toBeFalsy();
    expect(s2.content).toContain('"callId":"t-2"');
    expect(s2.content).toContain("resumes: t-1");
    // agent_status shows the lineage row.
    const statusRows = await createRegistryTools(registry)[1]!.execute({});
    expect(statusRows.content).toContain("t-2");
    expect(JSON.parse(statusRows.content).some((row: Record<string, unknown>) => row.id === "bg-2" && row.parentCallId === "t-1")).toBe(true);
    await registry.awaitAgents({ ids: ["bg-2"], mode: "all" });
    // B's first request (the model's SECOND call): prior transcript + steering.
    const first = model.inputs[1]!;
    const texts = first.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((c) => c.includes("STEP-ONE-DONE"))).toBe(true);
    expect(texts.some((c) => c.startsWith("[resume]") && c.includes("implement the plan"))).toBe(true);
    expect(texts.some((c) => c.includes("map the modules"))).toBe(true); // A's original brief survives
  });

  it("resumeFrom refuses to combine with an explicit session param", async () => {
    const registry = createSessionRegistry();
    const model = recordingModel([answer("one")]);
    const t = task(model, registry);
    await t.execute({ description: "s", prompt: "p", background: true, session: "new" });
    await registry.awaitAgents({ ids: ["bg-1"], mode: "all" });
    const r = await t.execute({ description: "r", prompt: "p", background: true, resumeFrom: "t-1", session: "new" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("session");
  });

  it("defaultStatsPath lives under .wudao", () => {
    expect(defaultStatsPath(root)).toBe(join(root, ".wudao", "agents-stats.json"));
  });
});
