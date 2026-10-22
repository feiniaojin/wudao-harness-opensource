import { describe, it, expect } from "vitest";
import { runAgentLoop, DEFAULT_MAX_TURNS, ABORTED_UNKNOWN_TOOL_RESULT, ABORTED_NOT_STARTED_TOOL_RESULT, TRUNCATED_TOOL_CALL_RESULT, PERSIST_FAILED_TOOL_RESULT, type LoopEvent, type Terminal } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel, type ModelClient, type ModelInput } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createTodoTool } from "../src/tools/todo.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample.txt");

// Drive the generator manually to capture its Terminal *return value*.
// (for-await-of consumes yielded events but discards the generator return value.)
async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  while (true) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

// Type guard for tool-result messages (the union has no discriminating helper).
function mIsTool(m: AgentMessage): m is Extract<AgentMessage, { role: "tool" }> {
  return m.role === "tool";
}

describe("runAgentLoop", () => {
  it("runs a tool call then a final answer (read file -> answer)", async () => {
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }],
      },
      { role: "assistant", content: "THE FILE SAYS: the quick brown fox" },
    ]);

    const state = {
      systemPrompt: "You are a test agent.",
      messages: [{ role: "user", content: "Read the file and echo its content." }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };

    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));

    // events flowed: >=1 turn_started, tool_call_started, tool_call_finished, turn_finished
    expect(events.some((e) => e.type === "tool_call_started")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_finished")).toBe(true);

    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toContain("the quick brown fox");

    // the loop recorded assistant + tool-result messages into state
    const roles = state.messages.map((m) => m.role);
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
  });

  it("returns max_turns when the model never stops calling tools", async () => {
    const looped: { role: "assistant"; content: string; toolCalls: [{ id: string; name: string; arguments: Record<string, unknown> }] } = {
      role: "assistant", content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }],
    };
    const model = createScriptedModel([looped, looped, looped]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "loop" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 2 }));
    expect(terminal.reason).toBe("max_turns");
    // Final-turn nudge: the last allowed model call must see the answer-now note.
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("turn limit reached"))).toBe(true);
  });

  it("tool_call_started carries input; tool_call_finished carries result", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [createReadFileTool()], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const started = events.find((e) => e.type === "tool_call_started") as Extract<LoopEvent, { type: "tool_call_started" }> | undefined;
    const finished = events.find((e) => e.type === "tool_call_finished") as Extract<LoopEvent, { type: "tool_call_finished" }> | undefined;
    expect(started?.input?.path).toBe(fixturePath);
    expect(typeof finished?.result).toBe("string");
  });

  it("turns an unknown tool into an error result and continues", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "nope", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      status: "idle" as const,
    };
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const finished = events.filter((e) => e.type === "tool_call_finished") as Extract<LoopEvent, { type: "tool_call_finished" }>[];
    expect(finished[0]?.isError).toBe(true);
    expect(terminal.reason).toBe("completed");
  });

  // 波次 7 #35: a near-miss tool name carries a did-you-mean built from the
  // registered catalog — the same matcher/wording the argument validator
  // already uses (tool.ts didYouMean), not a second dialect.
  it("unknown tool with a near-miss name gets a did-you-mean suggestion", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_fi", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const err = state.messages.find((m) => m.role === "tool") as { isError?: boolean; content: string } | undefined;
    expect(err?.isError).toBe(true);
    expect(err?.content).toBe('unknown tool: read_fi — did you mean "read_file"?');
  });

  it("unknown tool with no near neighbor keeps the bare message (zero-change pin)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "zzzzzzzz", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const err = state.messages.find((m) => m.role === "tool") as { content: string } | undefined;
    expect(err?.content).toBe("unknown tool: zzzzzzzz");
  });

  it("canUseTool deny → tool not executed, model gets an error result", async () => {
    let executed = false;
    const boom = buildTool({
      name: "boom", description: "d",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { executed = true; return { content: "ran" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "boom", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [boom], status: "idle" as const };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5, canUseTool: () => ({ behavior: "deny", reason: "test-block" }) }));
    expect(executed).toBe(false);
    expect(terminal.reason).toBe("completed");
    const denied = state.messages.find((m) => m.role === "tool") as { isError?: boolean; content: string } | undefined;
    expect(denied?.isError).toBe(true);
    expect(denied?.content).toMatch(/permission denied/);
  });

  it("async canUseTool deny → tool not executed, model gets an error result", async () => {
    let executed = false;
    const boom = buildTool({
      name: "boom", description: "d",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { executed = true; return { content: "ran" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "boom", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [boom], status: "idle" as const };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5, canUseTool: () => Promise.resolve({ behavior: "deny", reason: "async-block" }) }));
    expect(executed).toBe(false);
    expect(terminal.reason).toBe("completed");
    const denied = state.messages.find((m) => m.role === "tool") as { isError?: boolean; content: string } | undefined;
    expect(denied?.isError).toBe(true);
    expect(denied?.content).toMatch(/permission denied: async-block/);
  });

  it("microcompacts large old tool results when over the token threshold", async () => {
    const big = "x".repeat(2000);
    const model = createScriptedModel([
      // Turn 0 must run a tool so the (M24-deferred) compaction executes at
      // the turn boundary; a final-answer-only run never reaches a boundary.
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "big" } }] },
        { role: "tool", toolCallId: "c0", name: "read_file", content: big },
      ],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 3, compaction: { contextWindowTokens: 200, reserveTokens: 0, keepRecent: 0 } }));
    const compacted = events.find((e) => e.type === "compacted") as Extract<LoopEvent, { type: "compacted" }> | undefined;
    expect(compacted).toBeDefined();
    // Magnitude fields: the event reports the token estimate before/after.
    expect(typeof compacted?.beforeTokens).toBe("number");
    expect(typeof compacted?.afterTokens).toBe("number");
    expect((compacted?.afterTokens ?? Infinity) < (compacted?.beforeTokens ?? -1)).toBe(true);
    const stubbed = state.messages.find((m) => m.role === "tool" && m.toolCallId === "c0");
    expect(stubbed?.content.startsWith("[compacted")).toBe(true);
    expect(stubbed?.content.length).toBeLessThan(big.length);
  });

  it("falls back to tier-2 LLM summary when microcompact can't shrink", async () => {
    const big = "y".repeat(1500);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "assistant", content: "T2-SUMMARY" },          // consumed by tier2Compact's summarizer call
      { role: "assistant", content: "final answer" },        // the real turn response
    ]);
    const state = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: "go" },
      ],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 3, compaction: { contextWindowTokens: 300, reserveTokens: 0, keepRecent: 1 } }));
    const compacted = events.find((e) => e.type === "compacted") as Extract<LoopEvent, { type: "compacted" }> | undefined;
    expect(compacted?.summaryMessage?.content).toContain("T2-SUMMARY");
    // Tier-2 path reports magnitude too (estimates before/after the swap).
    expect(typeof compacted?.beforeTokens).toBe("number");
    expect(typeof compacted?.afterTokens).toBe("number");
    expect((compacted?.afterTokens ?? Infinity) < (compacted?.beforeTokens ?? -1)).toBe(true);
    expect(state.messages[0]?.content).toContain("T2-SUMMARY");
  });

  it("uses model.stream when present, emitting assistant_delta and the final message", async () => {
    const streamingModel = {
      async generate() { throw new Error("should not be called"); },
      async *stream() {
        yield { type: "text_delta" as const, text: "Hel" };
        yield { type: "text_delta" as const, text: "lo" };
        yield { type: "done" as const, message: { role: "assistant" as const, content: "Hello" } };
      },
    };
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], status: "idle" as const };
    const { events, terminal } = await drain(runAgentLoop(state, streamingModel, { maxTurns: 5 }));
    const deltas = events.filter((e) => e.type === "assistant_delta") as Extract<LoopEvent, { type: "assistant_delta" }>[];
    expect(deltas.map((e) => e.text).join("")).toBe("Hello");
    expect(terminal.reason).toBe("completed");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello" });
  });

  it("forwards reasoning_delta events from a streaming model", async () => {
    const streamingModel = {
      async generate() { throw new Error("should not be called"); },
      async *stream() {
        yield { type: "reasoning_delta" as const, text: "thin" };
        yield { type: "reasoning_delta" as const, text: "king" };
        yield { type: "text_delta" as const, text: "Hi" };
        yield { type: "done" as const, message: { role: "assistant" as const, content: "Hi", reasoning: "thinking" } };
      },
    };
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], status: "idle" as const };
    const { events, terminal } = await drain(runAgentLoop(state, streamingModel, { maxTurns: 5 }));
    const reasoning = events.filter((e) => e.type === "reasoning_delta") as Extract<LoopEvent, { type: "reasoning_delta" }>[];
    expect(reasoning.map((e) => e.text).join("")).toBe("thinking");
    expect(reasoning.every((e) => e.turn === 0)).toBe(true);
    expect(terminal.reason).toBe("completed");
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hi", reasoning: "thinking" });
  });

  it("hooks: onRunStart fires; onPromptSubmit rewrites the prompt", async () => {
    const events: string[] = [];
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "original" }], tools: [], status: "idle" as const };
    await drain(runAgentLoop(state, model, { maxTurns: 3, hooks: {
      onRunStart: () => { events.push("start"); },
      onPromptSubmit: (p) => { events.push(`prompt:${p}`); return "rewritten"; },
    } }));
    expect(events).toContain("start");
    expect(events).toContain("prompt:original");
    expect(state.messages[0]?.content).toBe("rewritten");
  });

  it("hooks: onRunStop block forces continuation, then allow completes", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "idle" as const };
    let calls = 0;
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5, hooks: {
      onRunStop: () => { calls += 1; return calls === 1 ? { block: true, reason: "not done" } : "allow"; },
    } }));
    expect(calls).toBe(2);
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("second");
    // the blocked stop injected a user message
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("[stop blocked]"))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // M33 §2: onPreToolUse / onPostToolUse.
  // -------------------------------------------------------------------------

  const echoParams = {
    type: "object" as const,
    properties: { text: { type: "string" as const } },
    required: ["text"],
    additionalProperties: false,
  };
  const echoTool = () => buildTool({
    name: "echo",
    description: "echo",
    parameters: echoParams,
    execute: async (args) => ({ content: `echo:${String(args.text)}` }),
  });
  const echoTurn = (text: string) => ({
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id: "c1", name: "echo", arguments: { text } }],
  });

  it("hooks: onPreToolUse runs BEFORE canUseTool and observes (void) without blocking", async () => {
    const order: string[] = [];
    const model = createScriptedModel([echoTurn("hi"), { role: "assistant", content: "done" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool()], status: "idle" as const };
    await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      canUseTool: async () => { order.push("canUseTool"); return { behavior: "allow" as const }; },
      hooks: {
        onPreToolUse: (name, input) => { order.push(`pre:${name}:${String(input.text)}`); },
      },
    }));
    expect(order).toEqual(["pre:echo:hi", "canUseTool"]);
  });

  it("hooks: onPreToolUse {block} denies execution — the reason reaches the model, canUseTool is skipped", async () => {
    const order: string[] = [];
    const model = createScriptedModel([echoTurn("secret"), { role: "assistant", content: "adapted" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool()], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      canUseTool: async () => { order.push("canUseTool"); return { behavior: "allow" as const }; },
      hooks: {
        onPreToolUse: () => ({ block: true as const, reason: "tests must run first" }),
      },
    }));
    // canUseTool never ran for the blocked call; the tool never executed.
    expect(order).toEqual([]);
    const blocked = events.find((e): e is Extract<LoopEvent, { type: "tool_call_finished" }> => e.type === "tool_call_finished");
    expect(blocked?.isError).toBe(true);
    expect(blocked?.result).toContain("tests must run first");
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg && mIsTool(toolMsg) ? toolMsg.content : "").toContain("blocked by hook");
    // the second (unblocked) model turn still completed normally
    expect(state.messages.at(-1)).toMatchObject({ role: "assistant", content: "adapted" });
  });

  it("hooks: a throwing onPreToolUse degrades to allow (the run continues)", async () => {
    const model = createScriptedModel([echoTurn("hi"), { role: "assistant", content: "done" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool()], status: "idle" as const };
    const { terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      hooks: { onPreToolUse: () => { throw new Error("boom"); } },
    }));
    expect(terminal.reason).toBe("completed");
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg && mIsTool(toolMsg) ? toolMsg.content : "").toBe("echo:hi");
  });

  it("hooks: onPostToolUse observes name/input/result after execution; a throw is isolated", async () => {
    const seen: Array<{ name: string; input: unknown; result: string }> = [];
    const model = createScriptedModel([echoTurn("observed"), { role: "assistant", content: "done" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool()], status: "idle" as const };
    const { terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      hooks: {
        onPostToolUse: (name, input, result) => {
          seen.push({ name, input: { ...input }, result });
          if (seen.length === 1) throw new Error("observer boom");
        },
      },
    }));
    expect(terminal.reason).toBe("completed");
    expect(seen).toEqual([{ name: "echo", input: { text: "observed" }, result: "echo:observed" }]);
  });

  it("hooks: onPostToolUse does NOT fire for denied or hook-blocked calls", async () => {
    const posts: string[] = [];
    const model = createScriptedModel([
      echoTurn("blocked"), echoTurn("denied"), { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [echoTool()], status: "idle" as const };
    await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      canUseTool: async (_name, input) =>
        String(input.text) === "denied" ? { behavior: "deny" as const, reason: "nope" } : { behavior: "allow" as const },
      hooks: {
        onPreToolUse: (_name, input) =>
          String(input.text) === "blocked" ? { block: true as const, reason: "hook says no" } : undefined,
        onPostToolUse: (name) => { posts.push(name); },
      },
    }));
    expect(posts).toEqual([]);
  });

  it("hooks: onPostToolUse fires for concurrency-safe batches (per completed call)", async () => {
    const posts: string[] = [];
    const slow = buildTool({
      name: "slow",
      description: "slow safe tool",
      parameters: echoParams,
      isConcurrencySafe: () => true,
      execute: async (args) => ({ content: `slow:${String(args.text)}` }),
    });
    const fast = buildTool({
      name: "fast",
      description: "fast safe tool",
      parameters: echoParams,
      isConcurrencySafe: () => true,
      execute: async (args) => ({ content: `fast:${String(args.text)}` }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "a", name: "slow", arguments: { text: "one" } },
        { id: "b", name: "fast", arguments: { text: "two" } },
      ] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [slow, fast], status: "idle" as const };
    await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      hooks: { onPostToolUse: (name) => { posts.push(name); } },
    }));
    expect(posts.sort()).toEqual(["fast", "slow"]);
  });

  it("runs a concurrency-safe batch concurrently (all started before any finished)", async () => {
    const slowA = buildTool({ name: "a", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: async () => { await new Promise((r) => setTimeout(r, 50)); return { content: "A" }; } });
    const slowB = buildTool({ name: "b", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: async () => { await new Promise((r) => setTimeout(r, 50)); return { content: "B" }; } });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "a", arguments: {} }, { id: "c2", name: "b", arguments: {} },
      ]},
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [slowA, slowB], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const toolEventIdx = events.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "tool_call_started" || e.type === "tool_call_finished");
    const kinds = toolEventIdx.map(({ e }) => e.type);
    expect(kinds).toEqual(["tool_call_started", "tool_call_started", "tool_call_finished", "tool_call_finished"]);
  });

  it("falls back to sequential when any tool in the batch is unsafe", async () => {
    const order: string[] = [];
    const safe = buildTool({ name: "s1", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true, execute: async () => { order.push("s1"); return { content: "S" }; } });
    const unsafe = buildTool({ name: "u1", description: "d", parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { order.push("u1"); return { content: "U" }; } }); // no isConcurrencySafe → defaults false
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "s1", arguments: {} }, { id: "c2", name: "u1", arguments: {} },
      ]},
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [safe, unsafe], status: "idle" as const };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    const kinds = events.filter((e) => e.type === "tool_call_started" || e.type === "tool_call_finished").map((e) => e.type);
    expect(kinds).toEqual(["tool_call_started", "tool_call_finished", "tool_call_started", "tool_call_finished"]);
    expect(order).toEqual(["s1", "u1"]); // original order preserved
  });

  it("aborted mid-model-call → aborted terminal, messages end on the user message", async () => {
    const controller = new AbortController();
    // A hung generate: never resolves, rejects with AbortError when the signal fires.
    const model: ModelClient = {
      generate: (input: ModelInput) =>
        new Promise((_, reject) => {
          input.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          );
        }),
    };
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 10)); // let the loop reach the hung model call
    controller.abort();
    const { terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    // No partial assistant message was appended — state still ends on the user message.
    expect(state.messages.length).toBe(1);
    expect(state.messages.at(-1)).toMatchObject({ role: "user", content: "go" });
  });

  it("aborted mid-tool (hung execute) → aborted terminal promptly, no result appended", async () => {
    const controller = new AbortController();
    const hang = buildTool({
      name: "hang", description: "never resolves",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () => new Promise<{ content: string }>(() => {}), // never resolves
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "hang", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [hang],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 20)); // let the loop reach the hung tool
    const t0 = Date.now();
    controller.abort();
    const { terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(100); // settles promptly, doesn't wait for the hung tool
    // 波次 8 #41 (the upstream format#13+#18): the hung tool's call is paired with the
    // UNKNOWN-outcome synthetic so resume replays a paired history instead of
    // hitting repairOrphanedToolCalls' blind backfill. The model can tell
    // "may have side-effected — verify" from "never ran — safe to re-issue".
    expect(state.messages.filter((m) => m.role === "tool")).toHaveLength(1);
    const toolMsg = state.messages.at(-1);
    expect(toolMsg).toMatchObject({ role: "tool", toolCallId: "c1", name: "hang", isError: true });
    expect((toolMsg as { content: string }).content).toBe(ABORTED_UNKNOWN_TOOL_RESULT);
  });

  it("波次8 #41 ① sequential: abort mid-call-1 of 2 → call 1 gets UNKNOWN synthetic, call 2 gets NOT-STARTED synthetic (both paired)", async () => {
    const controller = new AbortController();
    const hang = buildTool({
      name: "hang", description: "never resolves",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: () => new Promise<{ content: string }>(() => {}), // never resolves
    });
    const never = buildTool({
      name: "never", description: "second sequential call, never reached",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => ({ content: "should not run" }),
    });
    // Neither tool is concurrency-safe → sequential path; abort lands while
    // call 1 hangs, so call 2 is never dispatched.
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "hang", arguments: {} },
        { id: "c2", name: "never", arguments: {} },
      ]},
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [hang, never],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 20)); // call 1 is hung
    controller.abort();
    const { terminal } = await drained;

    expect(terminal.reason).toBe("aborted");
    // History stays PAIRED: assistant(toolCalls ×2) + tool(c1 UNKNOWN) + tool(c2 NOT-STARTED).
    const toolMsgs = state.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]).toMatchObject({ toolCallId: "c1", name: "hang", isError: true });
    expect((toolMsgs[0] as { content: string }).content).toBe(ABORTED_UNKNOWN_TOOL_RESULT);
    expect(toolMsgs[1]).toMatchObject({ toolCallId: "c2", name: "never", isError: true });
    expect((toolMsgs[1] as { content: string }).content).toBe(ABORTED_NOT_STARTED_TOOL_RESULT);
    // A resume over this history needs NO repair — the tool run answers the
    // interrupted assistant's batch directly (assistant immediately before it).
    const firstTool = state.messages.findIndex((m) => m.role === "tool");
    expect(state.messages[firstTool - 1]).toMatchObject({ role: "assistant" });
  });

  it("波次8 #41 ② concurrent fan-out: a call that COMPLETED before the abort keeps its REAL result; the hung one gets UNKNOWN", async () => {
    const controller = new AbortController();
    const fast = buildTool({
      name: "fast", description: "settles before the abort",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: async () => ({ content: "REAL RESULT" }),
    });
    const hang = buildTool({
      name: "hangb", description: "never resolves",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: () => new Promise<{ content: string }>(() => {}),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "fast", arguments: {} },
        { id: "c2", name: "hangb", arguments: {} },
      ]},
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [fast, hang],
      status: "idle" as const,
    };

    const drained = drain(runAgentLoop(state, model, { signal: controller.signal, maxTurns: 3 }));
    await new Promise((r) => setTimeout(r, 25)); // fast settled; hangb still hanging
    controller.abort();
    const { terminal, events } = await drained;

    expect(terminal.reason).toBe("aborted");
    // The completed call's REAL result is no longer discarded by the abort
    // skip — burning a finished side effect's output is the the upstream format#13 complaint.
    const toolMsgs = state.messages.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(2);
    expect(toolMsgs[0]).toMatchObject({ toolCallId: "c1", name: "fast" });
    expect((toolMsgs[0] as { isError?: boolean }).isError).toBeFalsy(); // success carries no isError
    expect((toolMsgs[0] as { content: string }).content).toBe("REAL RESULT");
    expect(toolMsgs[1]).toMatchObject({ toolCallId: "c2", name: "hangb", isError: true });
    expect((toolMsgs[1] as { content: string }).content).toBe(ABORTED_UNKNOWN_TOOL_RESULT);
    // And its finished event was emitted (the observer saw the completion).
    const finished = events.find((e) => e.type === "tool_call_finished" && e.toolCallId === "c1");
    expect(finished).toBeDefined();
  });

  it("steering: drains the queue between turns, appending user messages before the next model call", async () => {
    // The tool executes between turn 0's model call and turn 1's — the seam
    // where a mid-run steer lands. It pushes the new direction into the queue.
    const queue: string[] = [];
    const steeringTool = buildTool({
      name: "read_file", description: "steers on execute",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => { queue.push("NEW DIRECTION"); return { content: "ok" }; },
    });
    const inputs: AgentMessage[][] = [];
    const scripted = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }] },
      { role: "assistant", content: "done" },
    ]);
    const model: ModelClient = {
      // ModelInput.messages is a LIVE view of state.messages — snapshot it or
      // later appends (assistant reply, steering) rewrite history.
      generate: async (input: ModelInput) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [steeringTool], status: "idle" as const };

    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      steering: { take: () => queue.shift() },
    }));

    // Turn 0's model call ran with the queue empty — input unchanged.
    expect(inputs[0]?.at(-1)).toMatchObject({ role: "user", content: "go" });
    // Turn 1's model call saw the steering text as a plain trailing user message.
    expect(inputs[1]?.at(-1)).toEqual({ role: "user", content: "NEW DIRECTION" });
    // The injection was surfaced as a steered event.
    const steered = events.find((e) => e.type === "steered") as Extract<LoopEvent, { type: "steered" }> | undefined;
    expect(steered).toMatchObject({ turn: 1, text: "NEW DIRECTION" });
    // And it is part of the persisted state (append-only, prefix untouched).
    expect(state.messages).toContainEqual({ role: "user", content: "NEW DIRECTION" });
    expect(terminal.reason).toBe("completed");
  });

  it("steering: multiple queued texts are appended in order before one model call", async () => {
    const queue: string[] = [];
    const steeringTool = buildTool({
      name: "read_file", description: "steers on execute",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      execute: async () => { queue.push("FIRST", "SECOND"); return { content: "ok" }; },
    });
    const inputs: AgentMessage[][] = [];
    const scripted = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }] },
      { role: "assistant", content: "done" },
    ]);
    const model: ModelClient = {
      generate: async (input: ModelInput) => { inputs.push([...input.messages]); return scripted.generate(input); },
    };
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [steeringTool], status: "idle" as const };

    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      steering: { take: () => queue.shift() },
    }));

    const tail = inputs[1]?.slice(-2) ?? [];
    expect(tail).toEqual([
      { role: "user", content: "FIRST" },
      { role: "user", content: "SECOND" },
    ]);
    const steered = events.filter((e) => e.type === "steered") as Extract<LoopEvent, { type: "steered" }>[];
    expect(steered.map((e) => e.text)).toEqual(["FIRST", "SECOND"]);
  });

  it("steering: an always-empty queue changes nothing (no steered events, no extra messages)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [createReadFileTool()], status: "idle" as const };
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      steering: { take: () => undefined },
    }));
    expect(events.some((e) => e.type === "steered")).toBe(false);
    expect(terminal.reason).toBe("completed");
    expect(state.messages.filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("hooks: a throwing hook does not crash the loop", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], status: "idle" as const };
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 3, hooks: {
      onRunStart: () => { throw new Error("boom"); },
      onRunStop: () => { throw new Error("boom2"); },
    } }));
    expect(terminal.reason).toBe("completed");
  });

  it("aborted BEFORE tool phase with concurrent batch → aborted terminal promptly (no hang)", async () => {
    const controller = new AbortController();
    let modelDoneCallback: (() => void) | undefined;

    const hungConcurrentTool1 = buildTool({
      name: "hang1", description: "never resolves but safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: () => new Promise<{ content: string }>(() => {}), // never resolves
    });

    const hungConcurrentTool2 = buildTool({
      name: "hang2", description: "never resolves but safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: () => new Promise<{ content: string }>(() => {}), // never resolves
    });

    // Custom model that calls back immediately after finishing
    const customModel: ModelClient = {
      async generate() {
        // Call back immediately when done, before returning
        if (modelDoneCallback) {
          modelDoneCallback();
        }
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "hang1", arguments: {} },
            { id: "c2", name: "hang2", arguments: {} },
          ],
        };
      },
    };

    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" }],
      tools: [hungConcurrentTool1, hungConcurrentTool2],
      status: "idle" as const,
    };

    // Set up callback to abort immediately after model finishes
    modelDoneCallback = () => {
      // Abort immediately after model.generate() returns but before tools start
      // This should set signal.aborted = true before line 187 in loop.ts
      controller.abort();
    };

    const t0 = Date.now();
    const { terminal } = await drain(runAgentLoop(state, customModel, { signal: controller.signal, maxTurns: 3 }));

    expect(terminal.reason).toBe("aborted");
    expect(Date.now() - t0).toBeLessThan(100); // settles promptly, doesn't hang on the concurrent tools
    // The hung tools' results were NOT recorded.
    expect(state.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// M23: todo/verify stop gates + turn fuse
// ---------------------------------------------------------------------------

// Stub write/run tools: the gates track tool NAMES, so no filesystem is needed.
function stubTool(name: string): ReturnType<typeof buildTool> {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: `${name} ok` }),
  });
}

describe("todo gate (M23 §3b)", () => {
  function boardState(todos: { content: string; status: string }[]) {
    return {
      systemPrompt: "s",
      messages: [{ role: "user", content: "do the thing" } as AgentMessage],
      tools: [createTodoTool({}), stubTool("write_file"), stubTool("shell")],
      status: "idle" as const,
    };
  }

  it("blocks an empty-handed answer while the board has incomplete items, then lets a clean board finish", async () => {
    const state = boardState([]);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [{ content: "step a", status: "pending" }] } }] },
      { role: "assistant", content: "I think that's everything" }, // empty-handed → gate
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "todo_write", arguments: { todos: [{ content: "step a", status: "done" }] } }] },
      { role: "assistant", content: "All steps are complete." },
    ]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toContain("All steps are complete");
    // The gate injected the [system note: …] user message…
    const injected = state.messages.find((m) => m.role === "user" && m.content.includes("todo board has 1 incomplete"));
    expect(injected).toBeDefined();
    expect(injected?.content.startsWith("[system note:")).toBe(true);
    // …and surfaced it as an event (the TUI renders notices from it).
    const gateEvents = events.filter((e): e is Extract<LoopEvent, { type: "gate_injected" }> => e.type === "gate_injected");
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]?.text).toContain("todo board has 1 incomplete");
  });

  it("gives up after gateMaxInsists (4th empty answer is allowed through)", async () => {
    const state = boardState([]);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [{ content: "step a", status: "pending" }] } }] },
      { role: "assistant", content: "done-ish 1" },
      { role: "assistant", content: "done-ish 2" },
      { role: "assistant", content: "done-ish 3" },
      { role: "assistant", content: "done-ish 4" },
    ]);
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    const injections = state.messages.filter((m) => m.role === "user" && m.content.includes("todo board has 1 incomplete"));
    expect(injections).toHaveLength(3); // exactly gateMaxInsists (default 3)
    expect(events.filter((e) => e.type === "gate_injected")).toHaveLength(3);
  });

  it("gates.todo=false disables the gate", async () => {
    const state = boardState([]);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [{ content: "step a", status: "pending" }] } }] },
      { role: "assistant", content: "stopping anyway" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10, gates: { todo: false } }));
    expect(terminal.reason).toBe("completed");
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("[system note:"))).toBe(false);
  });
});

describe("verify gate (M23 §3c)", () => {
  function verifyState() {
    return {
      systemPrompt: "s",
      messages: [{ role: "user", content: "change the code" } as AgentMessage],
      tools: [stubTool("write_file"), stubTool("edit"), stubTool("shell"), createTodoTool({})],
      status: "idle" as const,
    };
  }

  it("blocks finishing after write_file with no shell; a run then unlocks the stop", async () => {
    const state = verifyState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: {} }] },
      { role: "assistant", content: "changed it, bye" }, // → verify gate
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: {} }] },
      { role: "assistant", content: "changed and verified" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    const note = state.messages.find((m) => m.role === "user" && m.content.includes("code changes were made but nothing was run"));
    expect(note).toBeDefined();
    expect(note?.content.startsWith("[system note:")).toBe(true);
  });

  it("does not block when shell already followed the write", async () => {
    const state = verifyState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: {} }] },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: {} }] },
      { role: "assistant", content: "verified, finishing" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("nothing was run"))).toBe(false);
  });

  it("tracks edit like write_file (both count as code changes)", async () => {
    const state = verifyState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "edit", arguments: {} }] },
      { role: "assistant", content: "edited, done" },
      { role: "assistant", content: "", toolCalls: [{ id: "c2", name: "shell", arguments: {} }] },
      { role: "assistant", content: "ok now really done" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("nothing was run"))).toBe(true);
  });

  it("todo + verify both firing merge into ONE injection, todo first", async () => {
    const state = verifyState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { todos: [{ content: "s", status: "pending" }] } }, { id: "c2", name: "write_file", arguments: {} }] },
      { role: "assistant", content: "bye" },
      { role: "assistant", content: "", toolCalls: [{ id: "c3", name: "shell", arguments: {} }, { id: "c4", name: "todo_write", arguments: { todos: [{ content: "s", status: "done" }] } }] },
      { role: "assistant", content: "finished properly" },
    ]);
    const { terminal, events } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    const gateEvents = events.filter((e): e is Extract<LoopEvent, { type: "gate_injected" }> => e.type === "gate_injected");
    expect(gateEvents).toHaveLength(1);
    const text = gateEvents[0]?.text ?? "";
    const todoIdx = text.indexOf("todo board has");
    const verifyIdx = text.indexOf("code changes were made");
    expect(todoIdx).toBeGreaterThan(-1);
    expect(verifyIdx).toBeGreaterThan(-1);
    expect(todoIdx).toBeLessThan(verifyIdx);
    // ONE user message carrying both notes.
    const notes = state.messages.filter((m) => m.role === "user" && m.content.startsWith("[system note:"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.content).toContain("todo board has");
    expect(notes[0]?.content).toContain("code changes were made");
  });

  it("verify insists are capped independently from todo insists", async () => {
    const state = verifyState();
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: {} }] },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
      { role: "assistant", content: "a3" },
      { role: "assistant", content: "a4" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: 10 }));
    expect(terminal.reason).toBe("completed");
    const notes = state.messages.filter((m) => m.role === "user" && m.content.includes("nothing was run"));
    expect(notes).toHaveLength(3);
  });
});

describe("turn fuse (M23 §3a)", () => {
  it("DEFAULT_MAX_TURNS is 200", () => {
    expect(DEFAULT_MAX_TURNS).toBe(200);
  });

  it("maxTurns: Infinity runs without a turn-limit nudge (fuse off)", async () => {
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
      { role: "assistant", content: "done" },
    ]);
    const { terminal } = await drain(runAgentLoop(state, model, { maxTurns: Infinity }));
    expect(terminal.reason).toBe("completed");
    expect(state.messages.some((m) => m.role === "user" && m.content.includes("turn limit reached"))).toBe(false);
  });
});

describe("usage event (M24)", () => {
  // A scripted model that reports usage through the onUsage channel.
  function usageReportingModel(
    responses: readonly { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
    usages: readonly { promptTokens: number; cacheHitTokens: number; cacheMissTokens: number }[],
  ): ModelClient & { inputs: ModelInput[] } {
    const inputs: ModelInput[] = [];
    let i = 0;
    return {
      inputs,
      async generate(input: ModelInput) {
        inputs.push(input);
        const response = responses[i];
        const usage = usages[i];
        i += 1;
        if (!response) throw new Error("scripted responses exhausted");
        if (usage) input.onUsage?.(usage);
        return response;
      },
    };
  }

  it("forwards onUsage as a usage event after model_call_finished, per turn", async () => {
    const model = usageReportingModel(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: fixturePath } }] },
        { role: "assistant", content: "done" },
      ],
      [
        { promptTokens: 1000, cacheHitTokens: 100, cacheMissTokens: 900 },
        { promptTokens: 2000, cacheHitTokens: 1900, cacheMissTokens: 100 },
      ],
    );
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [createReadFileTool()],
      status: "idle" as const,
    };
    const { events, terminal } = await drain(runAgentLoop(state, model, { maxTurns: 5 }));
    expect(terminal.reason).toBe("completed");
    const usageEvents = events.filter((e): e is Extract<LoopEvent, { type: "usage" }> => e.type === "usage");
    expect(usageEvents).toHaveLength(2);
    expect(usageEvents[0]).toMatchObject({ turn: 0, usage: { promptTokens: 1000, cacheHitTokens: 100, cacheMissTokens: 900 } });
    expect(usageEvents[1]).toMatchObject({ turn: 1, usage: { promptTokens: 2000, cacheHitTokens: 1900, cacheMissTokens: 100 } });
    // Ordering: the usage event lands right after its turn's model_call_finished.
    const finishedIdx = events.findIndex((e) => e.type === "model_call_finished");
    expect(events[finishedIdx + 1]?.type).toBe("usage");
  });

  it("emits no usage events when the model reports none", async () => {
    const model = usageReportingModel([{ role: "assistant", content: "done" }], []);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: [],
      status: "idle" as const,
    };
    const { events } = await drain(runAgentLoop(state, model, { maxTurns: 3 }));
    expect(events.some((e) => e.type === "usage")).toBe(false);
  });
});

// M45 §1.6 — the display-first iron rule: tool_call_started is emitted BEFORE
// the permission gate (hooks + canUseTool) runs for that call, sequential path
// AND concurrency-safe batch alike. The UI shows tool progress while the
// safety check (e.g. the auto-mode sidecar) runs behind it; the display
// channel never waits on the gate.
describe("tool_call_started precedes the gate (M45 §1.6)", () => {
  const writeTool = () =>
    buildTool({
      name: "write_file",
      description: "stub write",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "wrote" }),
    });
  const readTool = () =>
    buildTool({
      name: "read_file",
      description: "stub read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
        additionalProperties: false,
      },
      execute: async () => ({ content: "stub" }),
      isConcurrencySafe: () => true,
    });

  /** Drive the loop while recording started events and gate calls in one
   *  real-order timeline (the gate runs between the generator's yields, so
   *  push order is causal order). */
  async function runRecording(args: {
    tools: ReturnType<typeof writeTool>[];
    toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[];
  }): Promise<string[]> {
    const timeline: string[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: args.toolCalls },
      { role: "assistant", content: "done" },
    ]);
    const state = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "go" } as AgentMessage],
      tools: args.tools,
      status: "idle" as const,
    };
    const gen = runAgentLoop(state, model, {
      maxTurns: 3,
      // The stop gates would nudge past the scripted answers; order pin only.
      gates: { todo: false, verify: false },
      canUseTool: async (toolName) => {
        timeline.push(`gate:${toolName}`);
        return { behavior: "allow" };
      },
    });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      if (r.value.type === "tool_call_started") timeline.push(`started:${r.value.toolCallId}`);
    }
    return timeline;
  }

  it("sequential path: each call's started event lands before its gate runs", async () => {
    const timeline = await runRecording({
      tools: [writeTool()],
      toolCalls: [
        { id: "c1", name: "write_file", arguments: { path: "a", content: "x" } },
        { id: "c2", name: "write_file", arguments: { path: "b", content: "y" } },
      ],
    });
    expect(timeline).toEqual(["started:c1", "gate:write_file", "started:c2", "gate:write_file"]);
  });

  it("concurrency-safe batch: every started event lands before any gate runs", async () => {
    const timeline = await runRecording({
      tools: [readTool()],
      toolCalls: [
        { id: "r1", name: "read_file", arguments: { path: "a" } },
        { id: "r2", name: "read_file", arguments: { path: "b" } },
      ],
    });
    expect(timeline).toEqual(["started:r1", "started:r2", "gate:read_file", "gate:read_file"]);
  });
});

// ---------------------------------------------------------------------------
// 波次8 #45 (the upstream formatsession-checkpoint-policy): pre-dispatch durability barrier
// ---------------------------------------------------------------------------

describe("波次8 #45 (a ref #17): onBeforeToolDispatch — the tool phase runs only after the session barrier", () => {
  const probe = (name: string) => buildTool({
    name, description: "test probe",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: `${name} RAN` }),
  });

  it("① fires BEFORE execution, once per tool-carrying turn, carrying the assistant(tool_use) tail", async () => {
    const timeline: string[] = [];
    const t = buildTool({
      name: "witness", description: "records execution order",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { timeline.push("exec"); return { content: "ok" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "witness", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [t], status: "idle" as const };
    let saw: readonly AgentMessage[] = [];
    const { terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      onBeforeToolDispatch: async (messages) => { timeline.push("persist"); saw = [...messages]; },
    }));
    expect(terminal.reason).toBe("completed");
    // The barrier ran BEFORE the tool body, exactly once.
    expect(timeline).toEqual(["persist", "exec"]);
    // The snapshot it saw ends on the assistant carrying the tool_use — that
    // is exactly the record whose durability makes a crash-in-tool resumable.
    const tail = saw.at(-1);
    expect(tail).toMatchObject({ role: "assistant" });
    expect((tail as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
  });

  it("② a rejected barrier fails CLOSED: no tool body runs, every call gets the PERSIST_FAILED synthetic, the run continues", async () => {
    let execs = 0;
    const t = buildTool({
      name: "should_not_run", description: "exec witness",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => { execs += 1; return { content: "side effect!" }; },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "should_not_run", arguments: {} }] },
      { role: "assistant", content: "recovered" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [t], status: "idle" as const };
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 3,
      onBeforeToolDispatch: async () => { throw new Error("ENOSPC: store append failed"); },
    }));
    expect(execs).toBe(0); // fail-closed: the body never ran → no side effect
    expect(terminal.reason).toBe("completed"); // the loop itself survives; the MODEL sees the failure
    const toolMsg = state.messages.find((m) => m.role === "tool");
    expect(toolMsg).toMatchObject({ toolCallId: "c1", isError: true });
    expect((toolMsg as { content: string }).content).toBe(PERSIST_FAILED_TOOL_RESULT);
    // Event pairing survives (M70 shape): started + finished for the call.
    expect(events.some((e) => e.type === "tool_call_started" && e.toolCallId === "c1")).toBe(true);
    expect(events.some((e) => e.type === "tool_call_finished" && e.toolCallId === "c1")).toBe(true);
  });

  it("③ a tool-free turn never fires the barrier", async () => {
    let fires = 0;
    const model = createScriptedModel([{ role: "assistant", content: "just text" }]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [probe("p")], status: "idle" as const };
    await drain(runAgentLoop(state, model, { maxTurns: 2, onBeforeToolDispatch: async () => { fires += 1; } }));
    expect(fires).toBe(0);
  });

  it("④ a concurrent multi-call batch crosses the barrier ONCE (batch-level, not per-call)", async () => {
    let fires = 0;
    const a = buildTool({
      name: "ca", description: "concurrency-safe probe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: async () => ({ content: "a" }),
    });
    const b = buildTool({
      name: "cb", description: "concurrency-safe probe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      isConcurrencySafe: () => true,
      execute: async () => ({ content: "b" }),
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "ca", arguments: {} },
        { id: "c2", name: "cb", arguments: {} },
      ]},
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [a, b], status: "idle" as const };
    await drain(runAgentLoop(state, model, { maxTurns: 3, onBeforeToolDispatch: async () => { fires += 1; } }));
    expect(fires).toBe(1);
  });

  it("⑤ a length-truncated turn still crosses the barrier (the assistant record persists), and its synthetic stays TRUNCATED even when the barrier fails — truncation is the more actionable fact", async () => {
    // ⑤a: barrier fires on a length turn (assistant record is worth persisting).
    let fires = 0;
    const model = createScriptedModel([
      { role: "assistant", content: "", stopReason: "length", toolCalls: [{ id: "c1", name: "probe", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [probe("probe")], status: "idle" as const };
    await drain(runAgentLoop(state, model, { maxTurns: 3, onBeforeToolDispatch: async () => { fires += 1; } }));
    expect(fires).toBe(1);

    // ⑤b: length + rejected barrier → still the TRUNCATED synthetic (the
    // guard branch outranks the persistence failure; no tool ran either way).
    const model2 = createScriptedModel([
      { role: "assistant", content: "", stopReason: "length", toolCalls: [{ id: "c1", name: "probe", arguments: {} }] },
      { role: "assistant", content: "done" },
    ]);
    const state2 = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [probe("probe")], status: "idle" as const };
    await drain(runAgentLoop(state2, model2, {
      maxTurns: 3,
      onBeforeToolDispatch: async () => { throw new Error("store down"); },
    }));
    const toolMsg = state2.messages.find((m) => m.role === "tool");
    expect((toolMsg as { content: string }).content).toBe(TRUNCATED_TOOL_CALL_RESULT);
  });
});
