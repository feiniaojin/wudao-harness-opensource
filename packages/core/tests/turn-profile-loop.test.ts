// 夜移 035 — loop ↔ turn-profile integration: the recorder threaded through
// LoopOptions instruments the run's real seams — run entry (markTurnStarted),
// callModel (every request: happy path AND the reactive-ladder retries), the
// doCompact wrapper (compaction bucket), and the tool batch (tool-blocking
// bucket). Real clock + tolerance assertions (≥ the injected sleeps): the
// unit suite pins exact transitions; here we pin the WIRING, not the
// arithmetic.
import { describe, it, expect } from "vitest";
import { runAgentLoop, createTurnProfileRecorder } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Tool } from "../src/index.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Slow scripted model: each generate() sleeps, then answers (or tool-calls). */
function slowModel(steps: readonly { content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[]): ModelClient {
  let calls = 0;
  return {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      void input;
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      await sleep(20);
      return {
        role: "assistant",
        content: step.content,
        ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
      };
    },
  };
}

const slowTool = (ms: number): Tool => ({
  name: "slow_tool",
  description: "sleeps, then answers",
  parameters: { type: "object" as const, properties: {}, required: [] },
  isReadOnly: false,
  async execute(_args: Record<string, unknown>): Promise<{ content: string }> {
    await sleep(ms);
    return { content: "done" };
  },
});

async function drain(gen: AsyncGenerator<LoopEvent, unknown>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
}

const state = (tools: Tool[]): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" } satisfies AgentMessage],
  tools,
  status: "idle",
});

describe("夜移 035 — loop wiring: the threaded recorder sees the run's real seams", () => {
  it("a plain single-request run: sampling bucket ≥ the request sleep, tail in afterLastSampling", async () => {
    const recorder = createTurnProfileRecorder();
    const model = slowModel([{ content: "a" }]);
    const events = await drain(runAgentLoop(state([]), model, { maxTurns: 5, turnProfile: recorder }));
    expect(events.filter((e) => e.type === "model_call_finished")).toHaveLength(1);
    const p = recorder.complete();
    expect(p.samplingRequestCount).toBe(1);
    expect(p.samplingRetryCount).toBe(0);
    expect(p.samplingMs).toBeGreaterThanOrEqual(18); // the injected request sleep (≥20, −2ms timer granularity for CI)
    expect(p.compactionMs).toBe(0);
    expect(p.toolBlockingMs).toBe(0);
    expect(p.betweenSamplingOverheadMs).toBe(0); // no second sampling round
    // the six buckets always re-sum to the wall clock (absorption invariant)
    expect(
      p.beforeFirstSamplingMs + p.samplingMs + p.compactionMs
      + p.betweenSamplingOverheadMs + p.toolBlockingMs + p.afterLastSamplingMs,
    ).toBe(p.totalMs);
  });

  it("tool execution lands in the tool-blocking bucket", async () => {
    const recorder = createTurnProfileRecorder();
    const model = slowModel([
      { content: "calling", toolCalls: [{ id: "c1", name: "slow_tool", arguments: {} }] },
      { content: "done" },
    ]);
    const events = await drain(runAgentLoop(state([slowTool(30)]), model, { maxTurns: 5, turnProfile: recorder }));
    expect(events.some((e) => e.type === "tool_call_finished" && e.toolCallId === "c1")).toBe(true);
    const p = recorder.complete();
    expect(p.toolBlockingMs).toBeGreaterThanOrEqual(30);
    expect(p.samplingRequestCount).toBe(2);
    expect(p.totalMs).toBeGreaterThanOrEqual(p.toolBlockingMs + p.samplingMs);
  });

  it("absent recorder = the run behaves identically (opt-in, zero overhead path)", async () => {
    const model = slowModel([{ content: "plain" }]);
    const events = await drain(runAgentLoop(state([]), model, { maxTurns: 5 }));
    expect(events.some((e) => e.type === "model_call_finished")).toBe(true);
  });
});
