// ω-5b (R9) — serialize tool batches when hooks may write (Reasonix
// 56f72ef80). `allSafe` fans the GATE layer out via Promise.all, so a
// concurrency-safe batch runs onPreToolUse / onTaskCreated / onTaskCompleted
// CONCURRENTLY — and production hooks are arbitrary external commands; two
// hook invocations appending to one log or read-modify-writing shared state
// race. Fail-closed rule: when ANY per-call hook face is configured and the
// embedder has not asserted `toolHooksConcurrencySafe`, the batch takes the
// sequential path. No hooks (or the assertion) keeps today's fan-out; the
// predicate never consults canUseTool (the M45 read-gate parallelism
// survives). Verdicts are ORDER-based (deferred checkpoints, zero timing).
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { LoopEvent, Terminal, Tool, AgentState, AgentHooks } from "../src/index.js";

const drain = async (gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> => {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
};

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

const params = { type: "object" as const, properties: {}, additionalProperties: false };

/** Tool "a" hangs on an externally-released promise; tool "b" completes
 *  immediately. Both report isConcurrencySafe — the fan-out eligible batch. */
function makeHeldPair(): {
  readonly a: Tool;
  readonly b: Tool;
  readonly log: string[];
  releaseA(): void;
} {
  const log: string[] = [];
  let releaseA!: () => void;
  const heldA = new Promise<void>((r) => { releaseA = r; });
  const a: Tool = buildTool({
    name: "a",
    description: "held safe tool",
    parameters: params,
    isConcurrencySafe: () => true,
    execute: async () => { log.push("a:start"); await heldA; log.push("a:end"); return { content: "A" }; },
  });
  const b: Tool = buildTool({
    name: "b",
    description: "fast safe tool",
    parameters: params,
    isConcurrencySafe: () => true,
    execute: async () => { log.push("b:start"); log.push("b:end"); return { content: "B" }; },
  });
  return { a, b, log, releaseA };
}

const batchModel = () => createScriptedModel([
  { role: "assistant", content: "", toolCalls: [
    { id: "c1", name: "a", arguments: {} },
    { id: "c2", name: "b", arguments: {} },
  ] },
  { role: "assistant", content: "done" },
]);

const stateFor = (tools: readonly Tool[]): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" }],
  tools: [...tools],
  status: "idle",
});

/** Run the loop to completion in the background; returns a handle. */
const runLoop = (state: AgentState, hooks?: AgentHooks) =>
  drain(runAgentLoop(state, batchModel(), { maxTurns: 4, ...(hooks !== undefined ? { hooks } : {}) }));

describe("R9 — serialize tool batches when hooks may write", () => {
  it("a configured onPreToolUse serializes the batch (strict non-overlap)", async () => {
    const { a, b, log, releaseA } = makeHeldPair();
    const preLog: string[] = [];
    const done = runLoop(stateFor([a, b]), {
      onPreToolUse: async (name) => { preLog.push(`pre:${name}:start`); await wait(1); preLog.push(`pre:${name}:end`); },
    });
    await until(() => log.includes("a:start"), "tool a to start");
    // While a is held, NOTHING else may start: not b, not another hook face.
    await wait(25);
    expect(log).toEqual(["a:start"]);
    expect(preLog).toEqual(["pre:a:start", "pre:a:end"]);
    releaseA();
    await done;
    // b's hook + execution only start after a finished — strict order.
    expect(preLog).toEqual(["pre:a:start", "pre:a:end", "pre:b:start", "pre:b:end"]);
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("the same batch with NO hooks keeps the fan-out (overlap pinned — the perf regression net)", async () => {
    const { a, b, log, releaseA } = makeHeldPair();
    const done = runLoop(stateFor([a, b]));
    await until(() => log.includes("b:end"), "b to finish while a is still held");
    expect(log.includes("a:end")).toBe(false); // b completed DURING a's flight
    releaseA();
    const { terminal } = await done;
    expect(terminal.reason).toBe("completed");
    // Overlap proof (order-based, zero timing): b:end strictly before a:end.
    expect(log.indexOf("b:end")).toBeLessThan(log.indexOf("a:end"));
    expect(log).toContain("a:end");
  });

  it("toolHooksConcurrencySafe: true restores the fan-out under the same hook", async () => {
    const { a, b, log, releaseA } = makeHeldPair();
    const done = drain(runAgentLoop(stateFor([a, b]), batchModel(), {
      maxTurns: 4,
      hooks: { toolHooksConcurrencySafe: true, onPreToolUse: async () => undefined },
    }));
    await until(() => log.includes("b:end"), "b to finish while a is still held");
    expect(log.includes("a:end")).toBe(false);
    releaseA();
    await done;
    expect(log.indexOf("b:end")).toBeLessThan(log.indexOf("a:end"));
  });

  it("each per-call hook face counts: onTaskCreated ALONE (no pre-hook) serializes", async () => {
    const { a, b, log, releaseA } = makeHeldPair();
    const done = runLoop(stateFor([a, b]), {
      onTaskCreated: async () => undefined,
    });
    await until(() => log.includes("a:start"), "tool a to start");
    await wait(25);
    expect(log).toEqual(["a:start"]); // b never started while a was held
    releaseA();
    await done;
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("canUseTool (slow, checkpointed) with NO hooks stays parallel — the M45 pin", async () => {
    const log: string[] = [];
    let releaseGate!: () => void;
    const heldGate = new Promise<void>((r) => { releaseGate = r; });
    const a: Tool = buildTool({
      name: "a", description: "d", parameters: params, isConcurrencySafe: () => true,
      execute: async () => { log.push("a:start"); log.push("a:end"); return { content: "A" }; },
    });
    const b: Tool = buildTool({
      name: "b", description: "d", parameters: params, isConcurrencySafe: () => true,
      execute: async () => { log.push("b:start"); log.push("b:end"); return { content: "B" }; },
    });
    const done = drain(runAgentLoop(stateFor([a, b]), batchModel(), {
      maxTurns: 4,
      canUseTool: async (name) => {
        if (name === "a") await heldGate; // a's GATE is the slow thing
        return { behavior: "allow" };
      },
    }));
    await until(() => log.includes("b:end"), "b to execute while a's gate is held");
    expect(log.includes("a:start")).toBe(false); // a's gate still pending
    releaseGate();
    await done;
    expect(log.indexOf("b:end")).toBeLessThan(log.indexOf("a:start"));
  });

  it("output equivalence: identical messages and finished-event order with and without serialization", async () => {
    const build = (hooks?: AgentHooks) => {
      const a: Tool = buildTool({ name: "a", description: "d", parameters: params, isConcurrencySafe: () => true, execute: async () => ({ content: "A" }) });
      const b: Tool = buildTool({ name: "b", description: "d", parameters: params, isConcurrencySafe: () => true, execute: async () => ({ content: "B" }) });
      const state = stateFor([a, b]);
      return { state, run: () => drain(runAgentLoop(state, batchModel(), { maxTurns: 4, ...(hooks !== undefined ? { hooks } : {}) })) };
    };
    const serialized = build({ onPreToolUse: async () => undefined });
    const s = await serialized.run();
    const concurrent = build();
    const c = await concurrent.run();
    expect(serialized.state.messages).toEqual(concurrent.state.messages);
    const ids = (evs: readonly LoopEvent[]) =>
      evs.filter((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished").map((e) => e.toolCallId);
    expect(ids(s.events)).toEqual(["c1", "c2"]);
    expect(ids(s.events)).toEqual(ids(c.events));
    expect(s.terminal.reason).toBe("completed");
    expect(c.terminal.reason).toBe("completed");
  });

  // R1 (review NEEDS_FIXES): the fan-out path must execute the GATED call —
  // gateCall returns the M63-C {updatedInput} rewrite, and the base code
  // executed the returned call. A rewriting pre-hook under an asserted-
  // safe batch used to run the ORIGINAL args while turnBatch.input,
  // turnSafetyCalls and the skill/rule reads recorded the REWRITTEN ones
  // (execution and audit trail disagreeing).
  it("R1: a rewriting onPreToolUse under the fan-out (flag asserted) executes the REWRITTEN args, in agreement with the batch audit trail", async () => {
    const textParams = { type: "object" as const, properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false };
    const run = (assertSafe: boolean) => {
      const executed: { readonly name: string; readonly text: string }[] = [];
      const mk = (name: string): Tool => buildTool({
        name,
        description: "d",
        parameters: textParams,
        isConcurrencySafe: () => true,
        execute: async (args) => {
          executed.push({ name, text: String((args as { text?: string }).text ?? "") });
          return { content: `${name}:${String((args as { text?: string }).text ?? "")}` };
        },
      });
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [
          { id: "c1", name: "a", arguments: { text: "orig-a" } },
          { id: "c2", name: "b", arguments: { text: "orig-b" } },
        ] },
        { role: "assistant", content: "done" },
      ]);
      const batches: (readonly { readonly name: string; readonly input: Record<string, unknown> }[])[] = [];
      const state = stateFor([mk("a"), mk("b")]);
      const run2 = drain(runAgentLoop(state, model, {
        maxTurns: 4,
        hooks: {
          ...(assertSafe ? { toolHooksConcurrencySafe: true } : {}),
          onPreToolUse: (name, input) => ({ updatedInput: { text: `rewritten:${String(input.text)}` } }),
          onPostToolBatch: (batch) => { batches.push([...batch]); },
        },
      }));
      return { executed, batches, state, run2 };
    };

    // Fan-out (flag asserted): both tools must RECEIVE and ECHO the rewrite.
    const fanout = run(true);
    await fanout.run2;
    expect(fanout.executed).toEqual([
      { name: "a", text: "rewritten:orig-a" },
      { name: "b", text: "rewritten:orig-b" },
    ]);
    // Execution and the batch audit trail agree (the M63-C contract).
    expect(fanout.batches[0]!.map((c) => [c.name, c.input])).toEqual([
      ["a", { text: "rewritten:orig-a" }],
      ["b", { text: "rewritten:orig-b" }],
    ]);
    // The rewrite landed in history too.
    const toolMsgs = fanout.state.messages.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => (m as { content: string }).content)).toEqual(["a:rewritten:orig-a", "b:rewritten:orig-b"]);

    // Sequential control (no flag → R9 serialization): same contract.
    const sequential = run(false);
    await sequential.run2;
    expect(sequential.executed).toEqual([
      { name: "a", text: "rewritten:orig-a" },
      { name: "b", text: "rewritten:orig-b" },
    ]);
    expect(sequential.batches[0]!.map((c) => [c.name, c.input])).toEqual([
      ["a", { text: "rewritten:orig-a" }],
      ["b", { text: "rewritten:orig-b" }],
    ]);
  });
});
