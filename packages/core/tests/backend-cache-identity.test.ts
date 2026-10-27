// 120-a A4 (OpenHands #16699/#17430 形) — the backend-identity permutation
// pin over the run's learned caches. OpenHands' live bug class: caches keyed
// without the answering backend's identity silently fed one backend's data
// to another (subscription cache, settings cache). wudao has no client-side
// prompt-cache keys at all (prefix caching is provider-side over byte-stable
// prefixes), but the SAME invariant lives on the loop's learned caches — the
// occupancy calibration ratio, the usage anchor, and the learned window are
// all keyed by the ANSWERING model identity (u.model ?? u.fallbackModel)
// with a read-time mismatch guard: a value learned under backend B must
// never drive backend A's occupancy decisions.
//
// The census (nothing else in the tree caches per-backend state):
//   provider-registry memo   keyed by FILE PATH (whole-registry view — no
//                            per-backend entries to cross-contaminate)
//   mandatory-reasoning flag per-CLIENT factory closure (endpoint-scoped by
//                            construction, in-process only)
//   calibration/anchor/window THIS FILE's subject — model-identity keyed
// The permutation matrix below is the property test: for driver (the run's
// modelId) × backend (the answering model on usage rows), same-combo values
// apply across turns; any cross-combo value is dead at read time.
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool, SUMMARY_MARKER } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, Tool } from "../src/index.js";

/** ~16k tokens of dense ASCII history (chars/4): below the 24k threshold
 *  uncalibrated, at 36k reported tokens a 2.25x calibration that lands in
 *  the immediate zone (>= threshold + 8192). */
const bigHistory = (): AgentMessage[] => [
  { role: "user", content: "task 0 " + "x".repeat(16_000) },
  { role: "assistant", content: "answer 0 " + "y".repeat(16_000) },
  { role: "user", content: "task 1 " + "x".repeat(16_000) },
  { role: "assistant", content: "answer 1 " + "y".repeat(16_000) },
  { role: "user", content: "go" },
];

const ECHO: Tool = buildTool({
  name: "echo",
  description: "echoes",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  async execute() { return { content: "echoed" }; },
});

const REPORTED_PROMPT_TOKENS = 36_000; // 2.25x over the ~16k char estimate

interface MatrixRun {
  readonly driverModel: string | undefined;
  readonly answererFor: (nonSummarizerCall: number) => string | undefined;
  readonly toolCallTurns: number;
}

/** Drive one run of the matrix. Each non-summarizer model call reports a
 *  usage row stamped `answererFor(call)`; the first `toolCallTurns` calls
 *  answer with a tool call (keeping the run alive), the rest answer "done". */
async function matrixRun(cfg: MatrixRun): Promise<{ events: LoopEvent[]; modelCalls: number }> {
  let nonSummarizerCalls = 0;
  const model: ModelClient = {
    ...(cfg.driverModel !== undefined ? { modelId: cfg.driverModel } : {}),
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (input.querySource === "summarizer") return { role: "assistant", content: "SUMMARY" };
      nonSummarizerCalls += 1;
      const answerer = cfg.answererFor(nonSummarizerCalls);
      input.onUsage?.({
        promptTokens: REPORTED_PROMPT_TOKENS,
        cacheHitTokens: 0,
        cacheMissTokens: REPORTED_PROMPT_TOKENS,
        completionTokens: 8,
        ...(answerer !== undefined ? { model: answerer } : {}),
      });
      return nonSummarizerCalls <= cfg.toolCallTurns
        ? { role: "assistant", content: "", toolCalls: [{ id: `c${nonSummarizerCalls}`, name: "echo", arguments: { text: "hi" } }] }
        : { role: "assistant", content: "done" };
    },
  };
  const state: AgentState = {
    systemPrompt: "s",
    messages: bigHistory(),
    tools: [ECHO],
    status: "idle",
  };
  const events: LoopEvent[] = [];
  const gen = runAgentLoop(state, model, {
    maxTurns: 6,
    gates: { todo: false, verify: false },
    compaction: { contextWindowTokens: 30_000, keepRecent: 1, zeroLlmDigest: false },
  });
  for (;;) {
    const r = await gen.next();
    if (r.done) break;
    events.push(r.value);
  }
  return { events, modelCalls: nonSummarizerCalls };
}

const tier2Compacted = (events: readonly LoopEvent[]): LoopEvent | undefined =>
  events.find((e) => e.type === "compacted" && e.tier === 2);

describe("backend-keyed learned caches — the permutation matrix (120-a A4)", () => {
  it("diagonal (same backend): a calibration learned under the run's own model drives the next turn's occupancy — the immediate compaction fires", async () => {
    // driver A, answered by A
    const r1 = await matrixRun({ driverModel: "modelA", answererFor: () => "modelA", toolCallTurns: 1 });
    expect(tier2Compacted(r1.events)).toBeDefined();
    expect(r1.modelCalls).toBeGreaterThanOrEqual(2);
    // driver B, answered by B — symmetric cell of the matrix
    const r2 = await matrixRun({ driverModel: "modelB", answererFor: () => "modelB", toolCallTurns: 1 });
    expect(tier2Compacted(r2.events)).toBeDefined();
  });

  it("off-diagonal (cross backend): rows stamped by a DIFFERENT answering model never drive this run's occupancy — no compaction, run completes cleanly", async () => {
    // driver A, answered by B (the OpenHands shape: backend B's numbers fed
    // toward backend A's decisions — the guard must kill them at read time)
    const r1 = await matrixRun({ driverModel: "modelA", answererFor: () => "modelB", toolCallTurns: 1 });
    expect(tier2Compacted(r1.events)).toBeUndefined();
    expect(r1.modelCalls).toBe(2); // turn 1 (tool) + turn 2 (done) — nothing else
    // driver B, answered by A — the other off-diagonal cell
    const r2 = await matrixRun({ driverModel: "modelB", answererFor: () => "modelA", toolCallTurns: 1 });
    expect(tier2Compacted(r2.events)).toBeUndefined();
    expect(r2.modelCalls).toBe(2);
  });

  it("write side is last-wins per row, read side still guards: a cross-backend row poisons nothing — the next SAME-backend row re-arms and fires", async () => {
    // Turn 1 answers under modelB (dead for a modelA run); turn 2 under
    // modelA (arms the calibration); the turn-3 top check fires.
    const r = await matrixRun({
      driverModel: "modelA",
      answererFor: (call) => (call === 1 ? "modelB" : "modelA"),
      toolCallTurns: 2,
    });
    expect(tier2Compacted(r.events)).toBeDefined();
    expect(r.modelCalls).toBeGreaterThanOrEqual(3);
  });

  it("an UNTAGGED run (no modelId) accepts rows from any answerer — the backward-compatible default, pinned", async () => {
    // modelId undefined = the mismatch guard cannot fire (pre-ω-2b clients);
    // the usage row's own figure still drives occupancy. This is the
    // documented default, so it is pinned as deliberately NOT guarded.
    const r = await matrixRun({ driverModel: undefined, answererFor: () => "modelA", toolCallTurns: 1 });
    expect(tier2Compacted(r.events)).toBeDefined();
  });

  it("the compaction the calibration triggers is an ordinary tier-2 boundary (a real summary message landed)", async () => {
    const r = await matrixRun({ driverModel: "modelA", answererFor: () => "modelA", toolCallTurns: 1 });
    const ev = tier2Compacted(r.events) as Extract<LoopEvent, { type: "compacted" }>;
    expect(ev.summaryMessage?.content.startsWith(SUMMARY_MARKER)).toBe(true);
  });
});
