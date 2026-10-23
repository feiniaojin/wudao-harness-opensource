// 121 项 1 — the registry's AIMD wiring: with a concurrencyGate present the
// pump consults gate.current() (not the frozen maxConcurrent), settlement
// feeds the gate (ok → onSuccess; overload-class death via the injected
// classifier → onThrottle), and a shrink only bars NEW admissions (running
// children are never killed — a reference harness's pause-new-admissions law). Gate
// ABSENT must stay byte-equal to the pre-121 static cap (the default every
// embedder keeps) — that half is pinned by the whole existing registry suite.
import { describe, it, expect } from "vitest";
import { createAgentRegistry } from "../src/agents/registry.js";
import type { AgentSpawnSpec } from "../src/agents/registry.js";
import { AimdGate } from "../src/agents/aimd.js";
import { BUILTIN_ROLES } from "../src/agents/roster.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AssistantMessage } from "../src/types.js";

const ROLE = BUILTIN_ROLES["general-purpose"]!;
const POLICY = { maxConcurrent: 3, hardCap: 16, childTurns: 20, graceTools: ["todo_write"] } as const;

/** A model whose response is held at a gate the test releases (registry.test
 *  shape). */
function gatedModel(): { readonly model: ModelClient; readonly release: (text: string) => void } {
  let release!: (m: AssistantMessage) => void;
  const gate = new Promise<AssistantMessage>((resolve) => { release = resolve; });
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
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

function spec(model: ModelClient, over: Partial<AgentSpawnSpec> = {}): AgentSpawnSpec {
  return { model, allTools: [], role: ROLE, prompt: "p", ...over };
}

/** A marker error the injected classifier recognizes as overload-class. */
class OverloadMarkerError extends Error {
  constructor() { super("provider request failed: 429"); this.name = "OverloadMarkerError"; }
}

describe("registry × AimdGate (121 项 1)", () => {
  it("a fresh gate admits exactly the old static cap (initial = max = zero behavior change)", async () => {
    const gate = new AimdGate({ max: 3 });
    const reg = createAgentRegistry({ ...POLICY, concurrencyGate: gate });
    const c1 = gatedModel();
    const c2 = gatedModel();
    const c3 = gatedModel();
    reg.spawn(spec(c1.model));
    reg.spawn(spec(c2.model));
    reg.spawn(spec(c3.model));
    await new Promise((r) => setTimeout(r, 10));
    // All three admitted (current() === max === 3), all RUNNING.
    expect(reg.status().filter((s) => s.status === "running").length).toBe(3);
    // A fourth queues (same as the static cap).
    const c4 = gatedModel();
    const d = reg.spawn(spec(c4.model));
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.status(d.id)!.status).toBe("queued");
    c1.release("1");
    c2.release("2");
    c3.release("3");
    c4.release("4");
    await d.done;
    reg.abortAll();
  });

  it("a mid-flight throttle bars NEW admissions — running children finish untouched", async () => {
    const gate = new AimdGate({ max: 3 });
    const reg = createAgentRegistry({ ...POLICY, concurrencyGate: gate });
    const c1 = gatedModel();
    const c2 = gatedModel();
    const c3 = gatedModel();
    const a = reg.spawn(spec(c1.model));
    const b = reg.spawn(spec(c2.model));
    const c = reg.spawn(spec(c3.model));
    await new Promise((r) => setTimeout(r, 10));
    // The storm arrives: capacity halves (3 → 1) while three children run.
    gate.onThrottle();
    expect(gate.current()).toBe(1);
    expect(reg.status().filter((s) => s.status === "running").length).toBe(3); // nobody killed
    // A queued fourth must NOT start even as slots free — admission reads the gate.
    const c4 = gatedModel();
    const d = reg.spawn(spec(c4.model));
    c1.release("1");
    await a.done;
    await new Promise((r) => setTimeout(r, 10));
    // c1's ok settle regrew the gate (1 → 2) but active is still 2 → no admission.
    expect(gate.current()).toBe(2);
    expect(reg.status(d.id)!.status).toBe("queued");
    // The next ok settle regrows past active (2 → 3, active 1) → admitted.
    c2.release("2");
    await b.done;
    await new Promise((r) => setTimeout(r, 10));
    expect(reg.status(d.id)!.status).toBe("running");
    c3.release("3");
    await c.done;
    c4.release("4");
    await d.done;
  });

  it("settlement feeds the gate: an ok child is onSuccess, an overload-class death is onThrottle", async () => {
    const gate = new AimdGate({ max: 4, initial: 1 });
    const reg = createAgentRegistry({ ...POLICY, concurrencyGate: gate, isThrottleFailure: (err) => err instanceof OverloadMarkerError });
    // Throttle the gate down to 1 first so growth is observable.
    const okModel: ModelClient = { async generate() { return { role: "assistant", content: "done" }; } };
    const a = reg.spawn(spec(okModel));
    await a.done;
    expect(gate.current()).toBe(2); // ok settle → +1
    const boom: ModelClient = { async generate() { throw new OverloadMarkerError(); } };
    const b = reg.spawn(spec(boom));
    const rb = await b.done;
    expect(rb.ok).toBe(false);
    expect(gate.current()).toBe(1); // overload-class death → halve (2 → 1)
    // A NON-overload failure must NOT throttle (capacity said nothing).
    const other: ModelClient = { async generate() { throw new Error("provider request failed: 400 nope"); } };
    const cc = reg.spawn(spec(other));
    await cc.done;
    expect(gate.current()).toBe(1); // untouched
  });

  it("no injected classifier → a failure never throttles (core stays classification-free)", async () => {
    const gate = new AimdGate({ max: 4, initial: 4 });
    const reg = createAgentRegistry({ ...POLICY, concurrencyGate: gate });
    const boom: ModelClient = { async generate() { throw new OverloadMarkerError(); } };
    const a = reg.spawn(spec(boom));
    await a.done;
    expect(gate.current()).toBe(4); // no signal without a classifier
  });
});
