// M30 registry tests against the real core registry (spec §B/§C): bg-N ids,
// concurrency gating, cancellation, abort-all linkage, settle semantics, and
// the session-layer single-writer guard. Drives the registry through the same
// seam the task tool and TUI use; counts/in-flight are expressed as status()
// aggregations — the registry exposes no counters or change notification.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient } from "@wudao-org/core";
import { createJsonlSessionStore } from "@wudao-org/core";
import { createSessionRegistry } from "../src/agents/index.js";
import type { AgentRegistry, AgentSpawnSpec } from "../src/agents/index.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "registry-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

/** A model whose every generate() call parks until the test releases it —
 *  the child stays verifiably in flight. */
function gatedModel(): ModelClient & { release: (answer?: string) => void; fail: (err: Error) => void } {
  let resolve!: (m: AssistantMessage) => void;
  let reject!: (e: Error) => void;
  const gate = new Promise<AssistantMessage>((res, rej) => { resolve = res; reject = rej; });
  return {
    release: (answer = "done") => resolve({ role: "assistant", content: answer }),
    fail: (err) => reject(err),
    async generate(): Promise<AssistantMessage> { return gate; },
  };
}

const ROLE: AgentSpawnSpec["role"] = { id: "tester", description: "test role", toolNames: [] };

function spec(model: ModelClient, over: Partial<AgentSpawnSpec> = {}): AgentSpawnSpec {
  return { model, allTools: [], role: ROLE, prompt: "p", ...over };
}

/** counts() as the real API expresses it: aggregate status(). */
function counts(reg: AgentRegistry): { active: number; spawned: number } {
  const all = reg.status();
  return {
    active: all.filter((s) => s.status === "queued" || s.status === "running").length,
    spawned: all.length,
  };
}

describe("createSessionRegistry", () => {
  it("spawns bg-N ids and reports counts via status() aggregation", () => {
    const reg = createSessionRegistry({ maxConcurrent: 2 });
    const m1 = gatedModel();
    const m2 = gatedModel();
    const a = reg.spawn(spec(m1));
    const b = reg.spawn(spec(m2));
    expect(a.id).toBe("bg-1");
    expect(b.id).toBe("bg-2");
    expect(counts(reg)).toEqual({ active: 2, spawned: 2 });
    reg.abortAll();
    expect(counts(reg).spawned).toBe(2);
    expect(counts(reg).active).toBe(0);
  });

  it("gates concurrency: maxConcurrent running, the rest queued", async () => {
    const reg = createSessionRegistry({ maxConcurrent: 1 });
    const m1 = gatedModel();
    const m2 = gatedModel();
    const a = reg.spawn(spec(m1));
    const b = reg.spawn(spec(m2));
    expect(reg.status(a.id)?.status).toBe("running");
    expect(reg.status(b.id)?.status).toBe("queued");
    m1.release("r1");
    m2.release("r2");
    const results = await reg.awaitAgents({ ids: [a.id, b.id] });
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(reg.status(a.id)?.status).toBe("done");
    expect(reg.status(b.id)?.status).toBe("done");
  });

  it("clamps maxConcurrent into [1,16]", () => {
    expect(() => createSessionRegistry({ maxConcurrent: 0 })).not.toThrow();
    expect(() => createSessionRegistry({ maxConcurrent: 99 })).not.toThrow();
  });

  it("cancel dequeues a queued agent and settles a running one", () => {
    const reg = createSessionRegistry({ maxConcurrent: 1 });
    const m1 = gatedModel();
    const m2 = gatedModel();
    const a = reg.spawn(spec(m1));
    const b = reg.spawn(spec(m2));
    expect(reg.cancel("bg-2")).toBe(true);
    expect(reg.status(b.id)?.status).toBe("aborted");
    expect(reg.cancel("bg-2")).toBe(false); // already settled
    expect(reg.cancel("bg-9")).toBe(false); // unknown
    expect(reg.status(a.id)?.status).toBe("running");
    reg.abortAll();
    expect(reg.status(a.id)?.status).toBe("aborted");
  });

  it("abortAll settles every in-flight agent (registry-side, synchronously)", () => {
    const reg = createSessionRegistry();
    const m = gatedModel();
    reg.spawn(spec(m));
    reg.abortAll();
    const statuses = reg.status().map((s) => s.status);
    expect(statuses.every((s) => s !== "queued" && s !== "running")).toBe(true);
  });

  it("failed runners settle as failed with the error message", async () => {
    const reg = createSessionRegistry();
    const m = gatedModel();
    const spawned = reg.spawn(spec(m));
    m.fail(new Error("boom"));
    const settled = await spawned.done;
    expect(settled.ok).toBe(false);
    expect(settled.error).toContain("boom");
    expect(reg.status(spawned.id)?.status).toBe("failed");
  });

  it("single-writer guard: a second in-flight agent on the same session id fails", async () => {
    const reg = createSessionRegistry({ maxConcurrent: 3 });
    const store = createJsonlSessionStore(join(root, ".wudao", "sessions"));
    const m1 = gatedModel();
    const m2 = gatedModel();
    const a = reg.spawn(spec(m1, { session: { mode: "new", id: "child-7", store } }));
    const b = reg.spawn(spec(m2, { session: { mode: "new", id: "child-7", store } }));
    // The guard lives in core's session layer: the second spawn is accepted,
    // its CHILD fails the moment it starts on the already-owned sidechain
    // (mode "new" reaches the guard synchronously, before any store I/O).
    m1.release("first");
    const [ra, rb] = await reg.awaitAgents({ ids: [a.id, b.id], mode: "allSettled" });
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(false);
    expect(rb.error).toMatch(/single-writer/);
    // A settled writer frees the id; a different id is fine.
    const m3 = gatedModel();
    const c = reg.spawn(spec(m3, { session: { mode: "new", id: "child-7", store } }));
    expect(reg.status(c.id)?.status).toBe("running");
    const m4 = gatedModel();
    const d = reg.spawn(spec(m4, { session: { mode: "new" } }));
    expect(reg.status(d.id)?.status).toBe("running");
    reg.abortAll();
  });

  it("status() reflects the lifecycle the TUI bg counter polls", async () => {
    const reg = createSessionRegistry();
    const m = gatedModel();
    const spawned = reg.spawn(spec(m));
    expect(reg.status(spawned.id)?.status).toBe("running");
    m.release("done");
    const settled = await spawned.done;
    expect(settled.ok).toBe(true);
    expect(reg.status(spawned.id)?.status).toBe("done");
    expect(counts(reg)).toEqual({ active: 0, spawned: 1 });
  });
});
