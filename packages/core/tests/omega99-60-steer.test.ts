// ω99-60 — parent→child steer (the parent half-arc). Deterministic coverage:
// the global message_child tool (typed no-registry refusal, fail-closed
// argument shapes, 8k cap mirror), the registry's per-child FIFO mailbox and
// its steer() API (unknown id / terminal typed errors, queued accepted,
// steer during a pending await allowed — the T0 rulings), mid-run arrival on
// the child's next ModelInput with the unforgeable [steer from parent]
// attribution, FIFO ordering, the chained caller-first steering rule, the
// same-drain gate law (onPromptSubmit block drops a steer exactly like a
// user steer), and sidechain persistence + resume visibility.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AgentState, LoopEvent, Terminal } from "../src/index.js";
import type { AssistantMessage } from "../src/types.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import type { SessionStore } from "../src/session/store.js";
import { createAgentRegistry } from "../src/agents/registry.js";
import type { AgentRegistry } from "../src/agents/registry.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createMessageChildTool,
  CHILD_MESSAGE_TOOL_NAME,
  STEER_FROM_PARENT_PREFIX,
  STEER_NO_EDGE_ERROR,
  MAIL_CONTENT_MAX_CHARS,
} from "../src/agents/steer.js";

let root: string;
let store: SessionStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "steer-"));
  store = createJsonlSessionStore(join(root, "sessions"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

/** Bounded wait — the registry's child runs async; tests park it mid-run. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 1000 && !cond(); i += 1) await new Promise((r) => setTimeout(r, 2));
  if (!cond()) throw new Error("condition never became true");
}

/** A model whose every call PARKS until the test releases it — the child is
 *  observably "running" (call N entered, response withheld), so a steer can
 *  be submitted mid-run with deterministic ordering. */
function gated(responses: readonly AssistantMessage[]): {
  model: ModelClient;
  inputs: ModelInput[];
  release: () => void;
} {
  const inputs: ModelInput[] = [];
  const parked: Array<() => void> = [];
  let call = 0;
  const model: ModelClient = {
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      await new Promise<void>((resolve) => { parked.push(resolve); });
      const r = responses[call];
      call += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
  return { model, inputs, release: () => { parked.shift()?.(); } };
}

function pingTool() {
  return buildTool({
    name: "ping",
    description: "ping",
    parameters: { type: "object", properties: {} },
    async execute() { return { content: "pong" }; },
  });
}

const coderRole = (toolNames: readonly string[]) => ({
  id: "coder",
  description: "d",
  systemPrompt: "s",
  toolNames,
});

function makeRegistry(): AgentRegistry {
  return createAgentRegistry({ maxConcurrent: 2, hardCap: 4, childTurns: 5, graceTools: [] });
}

// ---------------------------------------------------------------------------
// The tool itself — global face, typed refusals (acceptance 3)
// ---------------------------------------------------------------------------

describe("ω99-60 message_child tool (global face)", () => {
  it("exists under the reserved name with an {id, content} schema", async () => {
    const tool = createMessageChildTool();
    expect(tool.name).toBe("message_child");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        id: { type: "string", description: expect.stringContaining("bg-") },
        content: { type: "string", description: expect.stringContaining("self-contained") },
      },
      required: ["id", "content"],
      additionalProperties: false,
    });
  });

  it("without a registry binding (no steer edge) the call is a typed refusal", async () => {
    const tool = createMessageChildTool();
    const r = await tool.execute({ id: "bg-1", content: "pivot" });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(STEER_NO_EDGE_ERROR);
  });

  it("fail-closed argument shapes: empty/non-string id, empty content, over-cap content", async () => {
    const tool = createMessageChildTool(makeRegistry());
    const emptyId = await tool.execute({ id: "  ", content: "x" });
    expect(emptyId.isError).toBe(true);
    expect(emptyId.content).toContain('"id" must be a non-empty string');
    const nonStringId = await tool.execute({ id: 7, content: "x" });
    expect(nonStringId.isError).toBe(true);
    const emptyContent = await tool.execute({ id: "bg-1", content: "   " });
    expect(emptyContent.isError).toBe(true);
    expect(emptyContent.content).toContain('"content" must be a non-empty string');
    const tooLong = await tool.execute({ id: "bg-1", content: "x".repeat(MAIL_CONTENT_MAX_CHARS + 1) });
    expect(tooLong.isError).toBe(true);
    expect(tooLong.content).toContain(`${MAIL_CONTENT_MAX_CHARS}`);
  });

  it("an unknown id surfaces the registry's typed error through the tool", async () => {
    const tool = createMessageChildTool(makeRegistry());
    const r = await tool.execute({ id: "bg-99", content: "anyone?" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("unknown agent id: bg-99");
  });
});

// ---------------------------------------------------------------------------
// registry.steer — the typed API (T0 rulings pinned)
// ---------------------------------------------------------------------------

describe("ω99-60 registry.steer (typed API)", () => {
  it("a terminal child (done) refuses with the status in the error", async () => {
    const registry = makeRegistry();
    const spawned = registry.spawn({
      model: createScriptedModel([{ role: "assistant", content: "done" }]),
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
    });
    const result = await spawned.done;
    expect(result.ok).toBe(true);
    expect(() => registry.steer(spawned.id, "late")).toThrowError(
      `agent ${spawned.id} already settled (status: done) — steer is only possible while queued or running`,
    );
  });

  it("an aborted child refuses with the aborted status (T0: pinned wording)", async () => {
    const registry = makeRegistry();
    const g = gated([{ role: "assistant", content: "never returned" }]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
    });
    await until(() => g.inputs.length === 1);
    expect(registry.cancel(spawned.id)).toBe(true);
    const result = await spawned.done;
    expect(result.aborted).toBe(true);
    expect(() => registry.steer(spawned.id, "too late")).toThrowError(
      `agent ${spawned.id} already settled (status: aborted) — steer is only possible while queued or running`,
    );
  });

  it("steering while agent_await is pending is ALLOWED (await never changes status)", async () => {
    const registry = createAgentRegistry({ maxConcurrent: 2, hardCap: 4, childTurns: 5, graceTools: [] });
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "awakened" },
    ]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
    });
    await until(() => g.inputs.length === 1);
    const awaiting = registry.awaitAgents({ ids: [spawned.id] });
    expect(() => registry.steer(spawned.id, "while awaiting")).not.toThrow();
    g.release();
    await until(() => g.inputs.length === 2);
    g.release();
    const results = await awaiting;
    expect(results[0]!.report).toBe("awakened");
  });

  it("a QUEUED child accepts the steer: the mailbox accumulates and drains on its first model call", async () => {
    const registry = createAgentRegistry({ maxConcurrent: 1, hardCap: 4, childTurns: 5, graceTools: [] });
    const a = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "a done" },
    ]);
    const spawnedA = registry.spawn({ model: a.model, allTools: [pingTool()], role: coderRole(["ping"]), prompt: "a" });
    await until(() => a.inputs.length === 1);
    // bg-2 sits in the queue (the single slot is held by bg-1).
    const b = gated([{ role: "assistant", content: "b done" }]);
    const spawnedB = registry.spawn({ model: b.model, allTools: [pingTool()], role: coderRole(["ping"]), prompt: "b" });
    expect(() => registry.steer(spawnedB.id, "early bird")).not.toThrow();
    a.release();
    await until(() => a.inputs.length === 2);
    a.release();
    await spawnedA.done;
    await until(() => b.inputs.length === 1);
    expect(b.inputs[0]!.messages.some((m) => m.role === "user" && m.content === `${STEER_FROM_PARENT_PREFIX}\nearly bird`)).toBe(true);
    b.release();
    const resultB = await spawnedB.done;
    expect(resultB.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mid-run arrival + FIFO (acceptance 1/2)
// ---------------------------------------------------------------------------

describe("ω99-60 mid-run steer arrival", () => {
  it("a steer submitted while the child runs lands on its next ModelInput as the formatted user turn, and the child reaches final", async () => {
    const registry = makeRegistry();
    const events: LoopEvent[] = [];
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "final after steer" },
    ]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
      onEvent: (e) => { events.push(e); },
    });
    await until(() => g.inputs.length === 1);
    // The parent (test-driven) steers through the TOOL — the full path.
    const tool = createMessageChildTool(registry);
    const r = await tool.execute({ id: spawned.id, content: "pivot: also check the config loader" });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(spawned.id);
    g.release();
    await until(() => g.inputs.length === 2);
    const steered = g.inputs[1]!.messages.filter(
      (m) => m.role === "user" && m.content.startsWith(STEER_FROM_PARENT_PREFIX),
    );
    expect(steered).toHaveLength(1);
    expect(steered[0]).toEqual({ role: "user", content: `${STEER_FROM_PARENT_PREFIX}\npivot: also check the config loader` });
    // Append-only FIFO site: the steer is the LAST message, after the tool result.
    expect(g.inputs[1]!.messages.at(-1)).toBe(steered[0]);
    // The steered event is the observability notice (same drain as user steering).
    const steeredEvents = events.filter((e) => e.type === "steered");
    expect(steeredEvents).toHaveLength(1);
    expect(steeredEvents[0]).toMatchObject({ type: "steered", text: `${STEER_FROM_PARENT_PREFIX}\npivot: also check the config loader` });
    g.release();
    const result = await spawned.done;
    expect(result.ok).toBe(true);
    expect(result.report).toBe("final after steer");
  });

  it("FIFO: two steers submitted before the child's next call both land, in submit order, in the SAME input", async () => {
    const registry = makeRegistry();
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "final" },
    ]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
    });
    await until(() => g.inputs.length === 1);
    registry.steer(spawned.id, "first steer");
    registry.steer(spawned.id, "second steer");
    g.release();
    await until(() => g.inputs.length === 2);
    const steers = g.inputs[1]!.messages.filter((m) => m.role === "user" && m.content.startsWith(STEER_FROM_PARENT_PREFIX));
    expect(steers).toHaveLength(2);
    expect(steers[0]!.content).toBe(`${STEER_FROM_PARENT_PREFIX}\nfirst steer`);
    expect(steers[1]!.content).toBe(`${STEER_FROM_PARENT_PREFIX}\nsecond steer`);
    // Consecutive tail positions, after the tool result.
    expect(g.inputs[1]!.messages.at(-2)).toBe(steers[0]);
    expect(g.inputs[1]!.messages.at(-1)).toBe(steers[1]);
    g.release();
    await spawned.done;
  });
});

// ---------------------------------------------------------------------------
// Chained steering (acceptance 5) — caller queue first, mailbox second
// ---------------------------------------------------------------------------

describe("ω99-60 chained steering (caller-first rule)", () => {
  it("a spawn spec with its own steering drains BOTH queues, caller items before mailbox items", async () => {
    const registry = makeRegistry();
    const caller: string[] = [];
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "final" },
    ]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
      loopOptions: { maxTurns: 5, steering: { take: () => caller.shift() } },
    });
    await until(() => g.inputs.length === 1);
    // Both queues populated mid-run: the caller's steer and the mailbox's.
    caller.push("caller first");
    registry.steer(spawned.id, "mailbox second");
    g.release();
    await until(() => g.inputs.length === 2);
    const tail = g.inputs[1]!.messages.slice(-2);
    expect(tail[0]).toEqual({ role: "user", content: "caller first" });
    expect(tail[1]).toEqual({ role: "user", content: `${STEER_FROM_PARENT_PREFIX}\nmailbox second` });
    g.release();
    await spawned.done;
  });
});

// ---------------------------------------------------------------------------
// The gate law (acceptance 4) — same drain, same onPromptSubmit contract
// ---------------------------------------------------------------------------

describe("ω99-60 steer gate law (same drain as user steering)", () => {
  function state(tools: readonly ReturnType<typeof pingTool>[]): AgentState {
    return {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools,
      status: "idle" as const,
    };
  }
  async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
    const events: LoopEvent[] = [];
    for (;;) {
      const { done, value } = await gen.next();
      if (done) return { events, terminal: value };
      events.push(value);
    }
  }
  /** The registry mailbox's exact shape: empty at the first drain, one
   *  formatted steer from mid-run on, FIFO thereafter. */
  function mailboxAfterFirstDrain(text: string) {
    let drainedOnce = false;
    let served = false;
    return {
      take(): string | undefined {
        if (!drainedOnce) { drainedOnce = true; return undefined; }
        if (!served) { served = true; return text; }
        return undefined;
      },
    };
  }

  it("a blocked steer is DROPPED (never enters history) and the steered event carries blockedReason", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([pingTool()]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      steering: mailboxAfterFirstDrain(`${STEER_FROM_PARENT_PREFIX}\nmy api key is sk-123`),
      hooks: {
        onPromptSubmit: (prompt) => (prompt.includes("sk-") ? { block: true, reason: "secrets" } : prompt),
      },
    }));
    expect(s.messages.some((m) => m.role === "user" && m.content.includes("sk-"))).toBe(false);
    const steered = events.filter((e) => e.type === "steered");
    expect(steered).toHaveLength(1);
    expect(steered[0]).toMatchObject({
      type: "steered",
      text: `${STEER_FROM_PARENT_PREFIX}\nmy api key is sk-123`,
      blockedReason: "secrets",
    });
  });

  it("a rewritten steer pushes the rewritten text (rewrite law unchanged)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([pingTool()]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      steering: mailboxAfterFirstDrain(`${STEER_FROM_PARENT_PREFIX}\nloud text`),
      hooks: {
        onPromptSubmit: (prompt) => `rewritten: ${prompt}`,
      },
    }));
    expect(s.messages.some((m) => m.role === "user" && m.content === `rewritten: ${STEER_FROM_PARENT_PREFIX}\nloud text`)).toBe(true);
    const steered = events.filter((e) => e.type === "steered");
    expect(steered[0]).toMatchObject({ type: "steered", text: `rewritten: ${STEER_FROM_PARENT_PREFIX}\nloud text` });
    expect((steered[0] as { blockedReason?: string }).blockedReason).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Persistence (acceptance 6) — sidechain + resume visibility
// ---------------------------------------------------------------------------

describe("ω99-60 steer persistence", () => {
  it("the steered user turn persists on the session'd child's sidechain and is visible after resume", async () => {
    const registry = makeRegistry();
    const g = gated([
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "ping", arguments: {} }] },
      { role: "assistant", content: "first stint done" },
    ]);
    const spawned = registry.spawn({
      model: g.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "work",
      session: { mode: "new", id: "side-steer-1", store },
    });
    await until(() => g.inputs.length === 1);
    registry.steer(spawned.id, "persisted pivot");
    g.release();
    await until(() => g.inputs.length === 2);
    g.release();
    const result = await spawned.done;
    expect(result.ok).toBe(true);
    const messages = await store.loadSidechain("side-steer-1");
    expect(messages.some((m) => m.role === "user" && m.content === `${STEER_FROM_PARENT_PREFIX}\npersisted pivot`)).toBe(true);
    // Resume rebuilds from the sidechain: the steered turn is in the resumed
    // child's first ModelInput (the parent's steer survived the stint boundary).
    const g2 = gated([{ role: "assistant", content: "resumed final" }]);
    const spawned2 = registry.spawn({
      model: g2.model,
      allTools: [pingTool()],
      role: coderRole(["ping"]),
      prompt: "continue",
      session: { mode: "resume", id: "side-steer-1", store },
    });
    await until(() => g2.inputs.length === 1);
    expect(g2.inputs[0]!.messages.some((m) => m.role === "user" && m.content.startsWith(STEER_FROM_PARENT_PREFIX))).toBe(true);
    g2.release();
    const result2 = await spawned2.done;
    expect(result2.ok).toBe(true);
  });
});
