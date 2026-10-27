import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAgentRegistry } from "../src/agents/registry.js";
import type { AgentSpawnSpec, ReportValidator, SubsetSchema } from "../src/agents/registry.js";
import { BUILTIN_ROLES } from "../src/agents/roster.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";
import { createReadFileTool, buildTool } from "../src/index.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "reg-"));
  await writeFile(join(root, "data.txt"), "hello");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const ROLE = BUILTIN_ROLES["general-purpose"]!;
const CODER = BUILTIN_ROLES["coder"]!;

/** M41: core keeps no registry policy values — these tests pin the
 *  historical operating points (the pre-M41 core defaults, identical to the
 *  cli kernel-policy single source) so the hoist provably changes nothing. */
const REGISTRY_POLICY = { maxConcurrent: 3, hardCap: 16, childTurns: 20, graceTools: ["todo_write"] } as const;

/** A model whose response is held at a gate the test releases — and which
 *  honors input.signal like a real provider (aborts reject with AbortError). */
function gatedModel(counter?: { calls: number }): {
  readonly model: ModelClient;
  readonly release: (text: string) => void;
} {
  let release!: (m: AssistantMessage) => void;
  const gate = new Promise<AssistantMessage>((resolve) => { release = resolve; });
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (counter) counter.calls += 1;
      if (!input.signal) return gate;
      return new Promise<AssistantMessage>((resolve, reject) => {
        const onAbort = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (input.signal.aborted) { onAbort(); return; }
        input.signal.addEventListener("abort", onAbort, { once: true });
        void gate.then((m) => {
          input.signal.removeEventListener("abort", onAbort);
          resolve(m);
        });
      });
    },
  };
  return { model, release: (text) => release({ role: "assistant", content: text }) };
}

/** N independent gated children, one model each. */
function gatedChildren(n: number) {
  const gates: Array<(t: string) => void> = [];
  const models: ModelClient[] = [];
  for (let i = 0; i < n; i += 1) {
    const { model, release } = gatedModel();
    models.push(model);
    gates.push(release);
  }
  return { models, gates };
}

function spawnSpec(model: ModelClient, over: Partial<AgentSpawnSpec> = {}): AgentSpawnSpec {
  return { model, allTools: [createReadFileTool()], role: ROLE, prompt: "p", ...over };
}

describe("createAgentRegistry spawn/lifecycle", () => {
  it("assigns bg-N ids and spawns without awaiting the child", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const a = reg.spawn(spawnSpec(gatedModel().model));
    const b = reg.spawn(spawnSpec(gatedModel().model));
    expect(a.id).toBe("bg-1");
    expect(b.id).toBe("bg-2");
    expect(reg.status().length).toBe(2);
    // Synchronous return: spawn must not await the child.
    expect(reg.status(a.id)!.status).toBe("running");
    expect(reg.status(b.id)!.status).toBe("running");
  });

  it("serializes children to maxConcurrent and releases slots as they finish", async () => {
    const calls = { calls: 0 };
    const mk = () => gatedModel(calls);
    const c1 = mk();
    const c2 = mk();
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 1 });
    const a = reg.spawn(spawnSpec(c1.model));
    const b = reg.spawn(spawnSpec(c2.model));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.calls).toBe(1); // second child is queued, not started
    c1.release("first done");
    const ra = await a.done;
    expect(ra.ok).toBe(true);
    expect(ra.report).toBe("first done");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.calls).toBe(2); // slot freed → second child starts
    c2.release("second done");
    const rb = await b.done;
    expect(rb.report).toBe("second done");
  });

  it("refuses spawns past the hard cap (fail-closed)", () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, hardCap: 2 });
    reg.spawn(spawnSpec(gatedModel().model));
    reg.spawn(spawnSpec(gatedModel().model));
    expect(() => reg.spawn(spawnSpec(gatedModel().model))).toThrow(/hard cap \(2 live agents\)/);
  });

  it("captures a thrown child error as ok:false instead of rejecting done", async () => {
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> { throw new Error("boom"); },
    };
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const a = reg.spawn(spawnSpec(model));
    const r = await a.done;
    expect(r.ok).toBe(false);
    expect(r.error).toContain("boom");
    expect(reg.status(a.id)!.status).toBe("failed");
  });
});

describe("awaitAgents semantics", () => {
  it("all: resolves with every result in requested id order", async () => {
    const { models, gates } = gatedChildren(2);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 2 });
    const a = reg.spawn(spawnSpec(models[0]!));
    const b = reg.spawn(spawnSpec(models[1]!));
    gates[0]?.("one");
    gates[1]?.("two");
    const results = await reg.awaitAgents({ ids: [b.id, a.id], mode: "all" });
    expect(results.map((r) => r.report)).toEqual(["two", "one"]);
    expect(results.map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("all: rejects when any child failed", async () => {
    const bad: ModelClient = {
      async generate(): Promise<AssistantMessage> { throw new Error("worker exploded"); },
    };
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const good = gatedModel();
    const ok = reg.spawn(spawnSpec(good.model));
    const fail = reg.spawn(spawnSpec(bad));
    await fail.done; // failure lands first…
    good.release("fine"); // …then the success arrives
    await expect(reg.awaitAgents({ ids: [ok.id, fail.id], mode: "all" })).rejects.toThrow(/worker exploded/);
  });

  it("allSettled: resolves with failures included", async () => {
    const bad: ModelClient = {
      async generate(): Promise<AssistantMessage> { throw new Error("nope"); },
    };
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const good = gatedModel();
    const ok = reg.spawn(spawnSpec(good.model));
    const fail = reg.spawn(spawnSpec(bad));
    good.release("fine");
    const results = await reg.awaitAgents({ ids: [ok.id, fail.id], mode: "allSettled" });
    expect(results.map((r) => r.ok)).toEqual([true, false]);
  });

  it("any: resolves with the first SUCCESS even after an earlier failure", async () => {
    const bad: ModelClient = {
      async generate(): Promise<AssistantMessage> { throw new Error("fast fail"); },
    };
    const good = gatedModel();
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 2 });
    const fail = reg.spawn(spawnSpec(bad));
    const win = reg.spawn(spawnSpec(good.model));
    await fail.done; // failure lands first…
    good.release("the winner"); // …then the success arrives
    const results = await reg.awaitAgents({ ids: [fail.id, win.id], mode: "any" });
    expect(results).toHaveLength(1);
    expect(results[0]!.report).toBe("the winner");
  });

  it("race: settles with the FIRST result, success or failure", async () => {
    const bad: ModelClient = {
      async generate(): Promise<AssistantMessage> { throw new Error("first to settle"); },
    };
    const slow = gatedModel();
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 2 });
    const fail = reg.spawn(spawnSpec(bad));
    const late = reg.spawn(spawnSpec(slow.model));
    const results = await reg.awaitAgents({ ids: [fail.id, late.id], mode: "race" });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    slow.release("too late to matter");
    await late.done;
  });

  it("rejects unknown ids", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    await expect(reg.awaitAgents({ ids: ["bg-99"], mode: "all" })).rejects.toThrow(/unknown agent id/);
  });
});

describe("registry abort linking and cancellation", () => {
  it("a parent signal abort tears down running AND queued children", async () => {
    const parent = new AbortController();
    const { models } = gatedChildren(2);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 1, signal: parent.signal });
    const running = reg.spawn(spawnSpec(models[0]!));
    const queued = reg.spawn(spawnSpec(models[1]!));
    await new Promise((r) => setTimeout(r, 10));
    parent.abort();
    const r1 = await running.done;
    const r2 = await queued.done;
    expect(r1.aborted).toBe(true);
    expect(r1.ok).toBe(false);
    expect(r2.aborted).toBe(true);
    expect(reg.status(running.id)!.status).toBe("aborted");
  });

  it("cancel(id) aborts a running child and drops a queued one without starting it", async () => {
    const calls = { calls: 0 };
    const mk = () => gatedModel(calls);
    const c1 = mk();
    const c2 = mk();
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 1 });
    const running = reg.spawn(spawnSpec(c1.model));
    const queued = reg.spawn(spawnSpec(c2.model));
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.cancel(queued.id)).toBe(true);
    const rq = await queued.done;
    expect(rq.aborted).toBe(true);
    expect(calls.calls).toBe(1); // queued child never started
    expect(reg.cancel(running.id)).toBe(true);
    const rr = await running.done;
    expect(rr.aborted).toBe(true);
    expect(reg.cancel("bg-77")).toBe(false); // unknown → false
  });
});

describe("registry grace + worker report", () => {
  it("synthesizes a [WORKER_REPORT] when the child's budget fuse fires", async () => {
    let call = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        call += 1;
        if (call === 1) {
          return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] };
        }
        return { role: "assistant", content: "ran out of budget mid-read" };
      },
    };
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const a = reg.spawn(spawnSpec(model, {
      role: CODER,
      maxTurns: 1,
      allTools: [createReadFileTool()],
    }));
    const r = await a.done;
    expect(r.ok).toBe(true);
    expect(r.budgetLimited).toBe(true);
    expect(r.report).toContain("ran out of budget");
    expect(r.workerReport).toContain("[WORKER_REPORT]");
    expect(r.workerReport).toContain("status: budget_limited");
    expect(r.workerReport).toContain("turns_used:");
    expect(r.workerReport).toContain("tool_calls_completed: 1");
    expect(r.workerReport).toContain("hint:");
  });

  it("no worker report when the child finishes within budget", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model));
    g.release("clean finish");
    const r = await a.done;
    expect(r.budgetLimited).toBeFalsy();
    expect(r.workerReport).toBeUndefined();
  });
});

describe("registry reportSchema enforcement", () => {
  const schema = { type: "object" as const, required: ["answer"] };

  it("validates the final report through the injected validator", async () => {
    const seen: string[] = [];
    const reg = createAgentRegistry({ ...REGISTRY_POLICY,
      validateReport: (text, s) => { seen.push(`${text}|${JSON.stringify(s)}`); return []; },
    });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model, { reportSchema: schema }));
    g.release('{"answer": 42}');
    const r = await a.done;
    expect(r.reportValid).toBe(true);
    expect(r.reportErrors).toEqual([]);
    expect(seen[0]).toContain("answer");
  });

  it("marks invalid reports with the validator's errors", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY,
      validateReport: () => ["$.answer: missing required property"],
    });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model, { reportSchema: schema }));
    g.release("no json here");
    const r = await a.done;
    expect(r.reportValid).toBe(false);
    expect(r.reportErrors).toEqual(["$.answer: missing required property"]);
    // ok stays true: a shape failure is marked, never silently retried.
    expect(r.ok).toBe(true);
  });

  it("fails closed when a schema is requested but no validator was injected", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model, { reportSchema: schema }));
    g.release("anything");
    const r = await a.done;
    expect(r.reportValid).toBe(false);
    expect(r.reportErrors?.[0]).toContain("no validateReport");
  });

  it("skips validation entirely when no schema was requested", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY,
      validateReport: () => { throw new Error("must not be called"); },
    });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model));
    g.release("freeform");
    const r = await a.done;
    expect(r.reportValid).toBeUndefined();
  });
});

describe("registry reasoning receipt", () => {
  it("echoes requested/effective effort from the role and spawn overrides", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const g = gatedModel();
    const a = reg.spawn(spawnSpec(g.model, { role: BUILTIN_ROLES["consultant"]! }));
    g.release("done");
    const r = await a.done;
    expect(r.reasoning).toEqual({ requested: "high", effective: "high" });

    const g2 = gatedModel();
    const b = reg.spawn(spawnSpec(g2.model, {
      role: BUILTIN_ROLES["coder"]!,
      reasoningEffort: "low",
      effectiveReasoningEffort: "medium",
    }));
    g2.release("done");
    const r2 = await b.done;
    expect(r2.reasoning).toEqual({ requested: "low", effective: "medium" });
  });
});

// M31 §1/§3 — write-scope overlap detection + callId lineage + budget receipt.
describe("registry write-scope overlap + lineage receipts (M31)", () => {
  it("warns on spawn when a live agent's write scope overlaps, and surfaces overlapWith on both receipts", async () => {
    const { models, gates } = gatedChildren(2);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 2 });
    const a = reg.spawn(spawnSpec(models[0]!, { writeScope: { roots: ["src/"] } }));
    const b = reg.spawn(spawnSpec(models[1]!, { writeScope: { roots: ["src/lib/"] } }));
    expect(a.warnings).toEqual([]);
    expect(b.warnings.length).toBe(1);
    expect(b.warnings[0]).toContain(a.id);
    expect(b.warnings[0]).toContain("src/lib");
    // Status carries the scope summary for relists.
    expect(reg.status(b.id)!.writeScope).toBe("roots src/lib");
    gates[0]?.("first"); // release both children
    gates[1]?.("second");
    const rb = await b.done;
    const ra = await a.done;
    // Both receipts keep the overlap: the fan-in sees both candidates.
    expect(rb.overlapWith).toEqual([a.id]);
    expect(rb.writeScope).toBe("roots src/lib");
    expect(ra.overlapWith).toBeUndefined(); // a was spawned before b existed
    expect(ra.writeScope).toBe("roots src");
  });

  it("no warning for disjoint scopes or unscoped agents", async () => {
    const { models, gates } = gatedChildren(3);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 3 });
    reg.spawn(spawnSpec(models[0]!, { writeScope: { roots: ["src/lib/"] } }));
    const disjoint = reg.spawn(spawnSpec(models[1]!, { writeScope: { roots: ["tests/"] } }));
    const unscoped = reg.spawn(spawnSpec(models[2]!));
    expect(disjoint.warnings).toEqual([]);
    expect(unscoped.warnings).toEqual([]);
    for (const g of gates) g?.("done");
    await reg.awaitAgents({ ids: [disjoint.id, unscoped.id], mode: "allSettled" });
  });

  it("strictOverlaps refuses the spawn outright (fail-closed)", async () => {
    const { models, gates } = gatedChildren(2);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 2, strictOverlaps: true });
    reg.spawn(spawnSpec(models[0]!, { writeScope: { roots: ["src/"] } }));
    expect(() =>
      reg.spawn(spawnSpec(models[1]!, { writeScope: { roots: ["src/lib/"], exactFiles: ["pkg.json"] } })),
    ).toThrow(/write-scope overlap/);
    expect(reg.status()).toHaveLength(1); // refused spawn never registered
    gates[0]?.("done");
    await reg.awaitAgents({ ids: ["bg-1"], mode: "all" });
  });

  it("settled agents no longer count for overlap (only in-flight scopes pair)", async () => {
    const g1 = gatedModel();
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const a = reg.spawn(spawnSpec(g1.model, { writeScope: { roots: ["src/"] } }));
    g1.release("done");
    await a.done;
    const g2 = gatedModel();
    const b = reg.spawn(spawnSpec(g2.model, { writeScope: { roots: ["src/"] } }));
    expect(b.warnings).toEqual([]);
    g2.release("done");
    await b.done;
  });

  it("carries callId / parentCallId lineage through status and results", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const g1 = gatedModel();
    const a = reg.spawn(spawnSpec(g1.model, { callId: "t-1" }));
    expect(reg.status(a.id)!.callId).toBe("t-1");
    expect(reg.status(a.id)!.parentCallId).toBeUndefined();
    g1.release("done");
    await a.done;
    const g2 = gatedModel();
    const b = reg.spawn(spawnSpec(g2.model, { callId: "t-2", parentCallId: "t-1" }));
    g2.release("done");
    const rb = await b.done;
    expect(rb.callId).toBe("t-2");
    expect(rb.parentCallId).toBe("t-1");
    expect(reg.status(b.id)!.parentCallId).toBe("t-1");
    // The relist row renders the lineage the TUI shows.
    expect(reg.status().map((s) => `${s.id}←${s.parentCallId ?? "-"}`)).toEqual(["bg-1←-", "bg-2←t-1"]);
  });

  it("reports budget {suggested, used, budgetLimited} and turns, and fires onSettle once", async () => {
    let call = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        call += 1;
        if (call === 1) {
          return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: join(root, "data.txt") } }] };
        }
        return { role: "assistant", content: "all done" };
      },
    };
    const settled: unknown[] = [];
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, ...REGISTRY_POLICY });
    const a = reg.spawn(spawnSpec(model, {
      role: CODER,
      maxTurns: 5,
      suggestedBudget: 5,
      allTools: [createReadFileTool()],
      onSettle: (r) => void settled.push(r),
    }));
    const r = await a.done;
    expect(r.budget).toEqual({ suggested: 5, used: 2, budgetLimited: false });
    expect(r.turns).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled.length).toBe(1);
  });
});

describe("波次8 #47 (OH#6): per-agent wall-clock timeout — the hung child cannot pin a slot forever", () => {
  it("① timeoutMs expiry aborts the child (aborted:true, report names the timeout) and frees the slot for the next queued agent", async () => {
    // One slot: B queues behind the hung A; A's timeout must free the slot.
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, maxConcurrent: 1 });
    const aGated = gatedModel();
    const bCounted = { calls: 0 };
    const bGated = gatedModel(bCounted);
    const a = reg.spawn(spawnSpec(aGated.model, { timeoutMs: 40 }));
    const b = reg.spawn(spawnSpec(bGated.model));
    expect(reg.status(b.id)?.status).toBe("queued"); // pinned behind A
    const r = await a.done;
    expect(r.ok).toBe(false);
    expect(r.aborted).toBe(true);
    expect(r.report).toContain("timed out after 40ms");
    expect(reg.status(a.id)?.status).toBe("aborted");
    // The slot freed: B pumped from queued to running (its model was called).
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bCounted.calls).toBe(1);
    expect(reg.status(b.id)?.status).toBe("running");
    bGated.release("b done");
    const rb = await b.done;
    expect(rb.ok).toBe(true);
  });

  it("② a child that settles normally is immune to its own late timer (handle cleared on every settle path)", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY });
    const gated = gatedModel();
    const a = reg.spawn(spawnSpec(gated.model, { timeoutMs: 50 }));
    setTimeout(() => gated.release("fast answer"), 10);
    const r = await a.done;
    expect(r.ok).toBe(true);
    expect(r.report).toBe("fast answer");
    // Past the (cleared) deadline: status and result must not flip.
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(reg.status(a.id)?.status).toBe("done");
    expect((await a.done).ok).toBe(true);
  });

  it("③ registry-level defaultTimeoutMs bounds children that pass no timeoutMs of their own", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, defaultTimeoutMs: 40 });
    const a = reg.spawn(spawnSpec(gatedModel().model)); // no spec timeout
    const r = await a.done;
    expect(r.aborted).toBe(true);
    expect(r.report).toContain("timed out after 40ms");
  });

  it("④ spec.timeoutMs beats the registry default (an explicit longer budget wins)", async () => {
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, defaultTimeoutMs: 40 });
    const gated = gatedModel();
    const a = reg.spawn(spawnSpec(gated.model, { timeoutMs: 5_000 }));
    setTimeout(() => gated.release("explicit wins"), 10);
    const r = await a.done;
    expect(r.ok).toBe(true);
    expect(r.report).toBe("explicit wins");
  });
});

// ---------------------------------------------------------------------------
// ω99-5b §B (registry face): a schema'd spawn names the finishing tool — the
// final_output tool_use in the transcript becomes the report. §C: an invalid
// schema'd report gets ONE corrective resume of the same child transcript
// (maxTurns 2, grace off), then re-validation; a failed repair keeps the
// original marking. Repair is gated on a resumable child session (mode
// new/resume with a known id — a session-fork writes elsewhere, a sessionless
// spawn leaves no transcript to continue).
// ---------------------------------------------------------------------------
describe("registry report repair round + finalTool (ω99-5b)", () => {
  const schema: SubsetSchema = { type: "object", required: ["answer"], properties: { answer: { type: "number" } } };

  /** A test-local subset validator (core ships none): JSON.parse + walk. */
  const validator: ReportValidator = (text, s) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return ["report is not valid JSON"];
    }
    const errors: string[] = [];
    const walk = (v: unknown, node: SubsetSchema, path: string): void => {
      if (node.type !== undefined) {
        const t = node.type;
        const ok = t === "object" ? typeof v === "object" && v !== null && !Array.isArray(v)
          : t === "array" ? Array.isArray(v)
          : t === "integer" ? typeof v === "number" && Number.isInteger(v)
          : t === "null" ? v === null
          : t === "number" ? typeof v === "number"
          : typeof v === t;
        if (!ok) {
          errors.push(`${path}: expected ${t}`);
          return;
        }
      }
      if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const rec = v as Record<string, unknown>;
        for (const k of node.required ?? []) if (!(k in rec)) errors.push(`${path}.${k}: missing required property`);
        for (const [k, sub] of Object.entries(node.properties ?? {})) if (k in rec) walk(rec[k], sub, `${path}.${k}`);
      }
    };
    walk(parsed, s, "$");
    return errors;
  };

  /** A scripted model that records each request (messages snapshot). */
  function scriptModel(responses: readonly string[], inputs: ModelInput[], calls: { calls: number }): ModelClient {
    let i = 0;
    return {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        calls.calls += 1;
        inputs.push({ ...input, messages: [...input.messages] });
        const r = responses[i];
        i += 1;
        if (r === undefined) throw new Error("scripted responses exhausted");
        return { role: "assistant", content: r };
      },
    };
  }

  it("passes finalTool to a schema'd spawn — the final_output tool_use becomes the report", async () => {
    const finalTool = buildTool({
      name: "final_output",
      description: "submit the final report",
      parameters: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
      async execute() { return { content: "final output recorded ✓" }; },
    });
    let call = 0;
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        call += 1;
        return call === 1
          ? { role: "assistant", content: "", toolCalls: [{ id: "f1", name: "final_output", arguments: { answer: 41 } }] }
          : { role: "assistant", content: "done" };
      },
    };
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, validateReport: validator });
    const a = reg.spawn(spawnSpec(model, {
      role: { ...ROLE, toolNames: ["final_output"] },
      allTools: [finalTool],
      reportSchema: schema,
    }));
    const r = await a.done;
    expect(r.report).toBe('{"answer":41}');
    expect(r.reportValid).toBe(true);
  });

  it("repairs an invalid report in one bounded round and takes the qualifying output", async () => {
    const inputs: ModelInput[] = [];
    const calls = { calls: 0 };
    const model = scriptModel(['{"answer":"nope"}', '{"answer":42}'], inputs, calls);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, validateReport: validator });
    const a = reg.spawn(spawnSpec(model, {
      reportSchema: schema,
      session: { mode: "new", id: "rep-1", store: createJsonlSessionStore(join(root, "sessions")) },
    }));
    const r = await a.done;
    expect(calls.calls).toBe(2);
    expect(r.reportValid).toBe(true);
    expect(r.reportErrors).toEqual([]);
    expect(r.report).toBe('{"answer":42}');
    // The corrective steering message carries the error list + the directive.
    const steering = inputs[1]!.messages.at(-1);
    expect(steering?.role).toBe("user");
    expect(steering?.content).toContain("[report repair]");
    expect(steering?.content).toContain("expected number");
    expect(steering?.content).toContain("Output ONLY");
  });

  it("a still-invalid repair keeps the original marking (reportValid:false + errors)", async () => {
    const calls = { calls: 0 };
    const model = scriptModel(['{"answer":"x"}', '{"answer":"y"}'], [], calls);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, validateReport: validator });
    const a = reg.spawn(spawnSpec(model, {
      reportSchema: schema,
      session: { mode: "new", id: "rep-2", store: createJsonlSessionStore(join(root, "sessions")) },
    }));
    const r = await a.done;
    expect(calls.calls).toBe(2); // the repair round RAN …
    expect(r.reportValid).toBe(false); // … but its output did not qualify
    expect(r.reportErrors?.[0]).toContain("expected number");
    expect(r.report).toBe('{"answer":"x"}'); // the original receipt stands
  });

  it("reportRepairRounds:0 disables the repair round entirely", async () => {
    const calls = { calls: 0 };
    const model = scriptModel(['{"answer":"x"}'], [], calls);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, validateReport: validator, reportRepairRounds: 0 });
    const a = reg.spawn(spawnSpec(model, {
      reportSchema: schema,
      session: { mode: "new", id: "rep-3", store: createJsonlSessionStore(join(root, "sessions")) },
    }));
    const r = await a.done;
    expect(calls.calls).toBe(1);
    expect(r.reportValid).toBe(false);
  });

  it("a sessionless spawn cannot repair (no transcript to continue)", async () => {
    const calls = { calls: 0 };
    const model = scriptModel(['{"answer":"x"}'], [], calls);
    const reg = createAgentRegistry({ ...REGISTRY_POLICY, validateReport: validator });
    const a = reg.spawn(spawnSpec(model, { reportSchema: schema }));
    const r = await a.done;
    expect(calls.calls).toBe(1);
    expect(r.reportValid).toBe(false);
  });
});
