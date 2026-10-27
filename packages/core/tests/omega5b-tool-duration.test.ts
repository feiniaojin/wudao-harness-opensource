// ω-5b (I21) — after-tool durationMs in the event + batch schemas (Strands,
// r38): slow-tool telemetry (sidecar gate latency, hung shell) is the
// missing half of ModelUsage.durationMs. Measurement (pinned): wall time
// from THAT call's gateCall start to its result settle — gate + execution,
// per call, performance.now() (monotonic). Omitted on the truncated-guard
// path (the call never executed); PostToolBatchCall mirrors the per-call
// value; the onPostToolUse signature is deliberately NOT widened (Q3).
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { LoopEvent, Terminal, Tool } from "../src/index.js";
import type { ModelInput } from "../src/model-client.js";

const drain = async (gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> => {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
};

const params = { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };

const delayedTool = (name: string, ms: number): Tool => buildTool({
  name,
  description: "delayed",
  parameters: params,
  isConcurrencySafe: () => true,
  execute: async () => {
    await new Promise((r) => setTimeout(r, ms));
    return { content: `${name}-done` };
  },
});

const finishedOf = (events: readonly LoopEvent[]) =>
  events.filter((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");

describe("tool_call_finished durationMs (ω-5b I21)", () => {
  it("sequential path: a tool resolving after a timer carries durationMs >= its delay; an immediate tool too", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "slow", arguments: { text: "x" } }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "fast", arguments: { text: "y" } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 60), delayedTool("fast", 0)], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    const finished = finishedOf(events);
    expect(finished).toHaveLength(2);
    for (const f of finished) {
      expect(typeof f.durationMs).toBe("number");
      expect(f.durationMs).toBeGreaterThanOrEqual(0);
    }
    // Timers only fire late — the per-call clock must cover the execution.
    expect(finished[0]!.durationMs).toBeGreaterThanOrEqual(50);
  });

  it("allSafe batch: per-call clocks, not batch wall time — each duration covers its OWN delay", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "slow", arguments: { text: "x" } },
        { id: "c2", name: "fast", arguments: { text: "y" } },
      ] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 60), delayedTool("fast", 20)], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 4 }));
    const finished = finishedOf(events);
    expect(finished).toHaveLength(2);
    expect(finished[0]!.durationMs).toBeGreaterThanOrEqual(50); // its own 60ms
    expect(finished[1]!.durationMs).toBeGreaterThanOrEqual(10); // its own 20ms
    // Under fan-out the two overlap, so NEITHER duration approaches the sum.
    expect(finished[0]!.durationMs!).toBeLessThan(110);
  });

  it("truncated-guard turn (stopReason length): the field is absent on every finished event", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", stopReason: "length", toolCalls: [{ id: "c1", name: "slow", arguments: { text: "x" } }] },
      { role: "assistant", content: "redone" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 50)], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));
    const finished = finishedOf(events);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.isError).toBe(true);
    expect("durationMs" in finished[0]!).toBe(false);
  });

  it("PostToolBatchCall mirrors the per-call values (executed calls only)", async () => {
    const batches: (readonly { readonly name: string; readonly durationMs?: number }[])[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "slow", arguments: { text: "x" } },
        { id: "c2", name: "fast", arguments: { text: "y" } },
      ] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 60), delayedTool("fast", 20)], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      hooks: { onPostToolBatch: (batch) => { batches.push([...batch]); } },
    }));
    expect(batches).toHaveLength(1);
    const finished = finishedOf(events);
    expect(batches[0]).toHaveLength(2);
    for (let i = 0; i < 2; i += 1) {
      expect(batches[0]![i]!.durationMs).toBe(finished[i]!.durationMs);
      expect(typeof batches[0]![i]!.durationMs).toBe("number");
    }
  });

  it("denied calls: the event carries the gate-span duration; the batch payload stays executed-only", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "slow", arguments: { text: "x" } }] },
      { role: "assistant", content: "done" },
    ]);
    const batches: (readonly { readonly name: string }[])[] = [];
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 0)], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      canUseTool: async () => {
        await new Promise((r) => setTimeout(r, 30));
        return { behavior: "deny", reason: "no" };
      },
      hooks: { onPostToolBatch: (batch) => { batches.push([...batch]); } },
    }));
    const finished = finishedOf(events);
    expect(finished).toHaveLength(1);
    expect(finished[0]!.isError).toBe(true);
    // The clock spans gate + execution — a 30ms gate shows up even though
    // nothing executed.
    expect(finished[0]!.durationMs).toBeGreaterThanOrEqual(20);
    // The "actually executed" doctrine: the denied call never rides the batch.
    expect(batches).toHaveLength(0);
  });

  it("cache-neutral: durationMs never reaches any ModelInput (events/receipts are not model-visible bytes)", async () => {
    const inputs: ModelInput[] = [];
    const model = {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "slow", arguments: { text: "x" } }] };
      },
    };
    const model2 = { async generate(input: ModelInput) { inputs.push(input); return { role: "assistant" as const, content: "done" }; } };
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [delayedTool("slow", 50)], status: "idle" as const };
    await drain(runAgentLoop(state, model, { maxTurns: 2 }));
    await drain(runAgentLoop(state, model2, { maxTurns: 2 }));
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    for (const input of inputs) {
      expect(JSON.stringify(input)).not.toContain("durationMs");
    }
  });

  it("additive-only: an old-shape finished event (no field) still satisfies the union", () => {
    const ev: LoopEvent = { type: "tool_call_finished", turn: 1, toolCallId: "x", isError: false, result: "r" };
    expect(ev.type).toBe("tool_call_finished");
  });
});
