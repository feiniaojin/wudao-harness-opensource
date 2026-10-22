// M63-B batch B — the loop-level faces: TaskCreated/TaskCompleted (todo
// board transition gate), InstructionsLoaded (path_glob_match + compact),
// prompt_blocked (the submit-time user-channel notice), and
// SubagentStart/Stop via runSubagent's subagentHooks (incl. the blocking
// stop keeping the child working). Deterministic: scripted models, stub
// tools.
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { runSubagent } from "../src/subagent.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentHooks, AgentState, LoopEvent, Terminal, Tool } from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

// The loop fires observer hooks VOIDED (isolated); a macrotask lets them settle.
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const NO_GATES = { todo: false, verify: false } as const;

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubTool(name: string, content: string): Tool {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: params,
    execute: async () => ({ content }),
  });
}

function state(tools: readonly Tool[], messages: { role: "user"; content: string }[] = [{ role: "user", content: "go" }]): AgentState {
  return { systemPrompt: "s", messages, tools: [...tools], status: "idle" as const };
}

function todoWriteCall(id: string, todos: { content: string; status: string }[]) {
  return { role: "assistant" as const, content: "", toolCalls: [{ id, name: "todo_write", arguments: { todos } }] };
}

describe("M63-B TaskCreated / TaskCompleted", () => {
  const boardTool = (): Tool => buildTool({
    name: "todo_write",
    description: "stub board",
    parameters: {
      type: "object",
      properties: { todos: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string" } }, required: ["content", "status"] } } },
      required: ["todos"],
      additionalProperties: false,
    },
    isConcurrencySafe: () => true,
    execute: async ({ todos }: { todos: { content: string; status: string }[] }) => ({
      content: `[todo board ${todos.filter((t) => t.status === "done").length}/${todos.length} done]\n${todos.map((t) => `${t.status === "done" ? "☑" : t.status === "in_progress" ? "◐" : "☐"} ${t.content}`).join("\n")}`,
    }),
  });

  it("a board write that ADDS items fires onTaskCreated with the new contents", async () => {
    const created: { items: string[]; board: { total: number; done: number } }[] = [];
    const model = createScriptedModel([
      todoWriteCall("c1", [{ content: "first", status: "pending" }, { content: "second", status: "pending" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onTaskCreated: (items, board) => { created.push({ items: [...items], board }); },
      },
    }));
    expect(created).toEqual([{ items: ["first", "second"], board: { total: 2, done: 0 } }]);
  });

  it("a LATER write completing an item fires onTaskCompleted with that item only", async () => {
    const created: string[][] = [];
    const completed: string[][] = [];
    const model = createScriptedModel([
      todoWriteCall("c1", [{ content: "first", status: "pending" }]),
      todoWriteCall("c2", [{ content: "first", status: "done" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onTaskCreated: (items) => { created.push([...items]); },
        onTaskCompleted: (items) => { completed.push([...items]); },
      },
    }));
    await tick();
    // Write 1: item created. Write 2: same item, now done → completed only.
    expect(created).toEqual([["first"]]);
    expect(completed).toEqual([["first"]]);
  });

  it("a no-delta write (same board) fires NEITHER hook", async () => {
    let fires = 0;
    const model = createScriptedModel([
      todoWriteCall("c1", [{ content: "first", status: "pending" }]),
      todoWriteCall("c2", [{ content: "first", status: "pending" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onTaskCreated: () => { fires += 1; },
        onTaskCompleted: () => { fires += 1; },
      },
    }));
    expect(fires).toBe(1); // only the first write (a real create)
  });

  it("R1: the canonical 3-state flow (pending → in_progress(activeForm) → done) fires Created once + Completed once", async () => {
    const created: string[] = [];
    const completed: string[] = [];
    const model = createScriptedModel([
      // Write 1: pending — the item is created.
      todoWriteCall("c1", [{ content: "Fix the bug", status: "pending" }]),
      // Write 2: in_progress with an activeForm — the board line now shows
      // the activeForm IN PLACE of the content (neither created nor done).
      todoWriteCall("c2", [{ content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" }]),
      // Write 3: done — the content spelling returns.
      todoWriteCall("c3", [{ content: "Fix the bug", status: "done" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 6,
      gates: NO_GATES,
      hooks: {
        onTaskCreated: (items) => { created.push(...items); },
        onTaskCompleted: (items) => { completed.push(...items); },
      },
    }));
    // R1 defect fixed: no spurious Created on the done write, and the
    // completion (masked by activeForm in the old board) IS detected.
    expect(created).toEqual(["Fix the bug"]);
    expect(completed).toEqual(["Fix the bug"]);
  });

  it("a blocking onTaskCreated refuses the write (error tool result, board unchanged)", async () => {
    const model = createScriptedModel([
      todoWriteCall("c1", [{ content: "forbidden", status: "pending" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onTaskCreated: () => ({ block: true, reason: "not in the plan" }),
      },
    }));
    // The call produced an error tool result naming the hook.
    const toolMsg = s.messages.find((m) => m.role === "tool");
    expect(toolMsg && toolMsg.content).toBe("todo_write blocked by hook: not in the plan");
    const finished = events.find((e) => e.type === "tool_call_finished");
    expect(finished && "isError" in finished && finished.isError).toBe(true);
    // No board ever landed in history.
    expect(s.messages.some((m) => m.role === "tool" && m.content.includes("[todo board"))).toBe(false);
  });

  it("a blocking onTaskCompleted refuses the completion write; a throwing hook allows", async () => {
    const model = createScriptedModel([
      todoWriteCall("c1", [{ content: "task a", status: "pending" }]),
      todoWriteCall("c2", [{ content: "task a", status: "done" }]),
      todoWriteCall("c3", [{ content: "task b", status: "pending" }, { content: "task a", status: "done" }]),
      { role: "assistant", content: "done" },
    ]);
    const s = state([boardTool()]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onTaskCompleted: () => { throw new Error("hook down"); },
      },
    }));
    // Throwing completed-hook → both completion writes went through.
    const boards = s.messages.filter((m) => m.role === "tool" && m.content.includes("[todo board"));
    expect(boards.length).toBe(3);
  });
});

describe("M63-B InstructionsLoaded", () => {
  it("fires path_glob_match when a gated context rule lands", async () => {
    const loaded: { source: string; detail?: string }[] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/a.ts" } }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", "CONTENT")]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      gates: NO_GATES,
      hooks: {
        onInstructionsLoaded: (source, info) => { loaded.push({ source, detail: info.detail }); },
      },
      contextRules: {
        match: (toolName, args) =>
          toolName === "read_file" && args["path"] === "src/a.ts"
            ? [{ source: ".wudao/rules/a.md", body: "RULE BODY" }]
            : [],
      },
    }));
    await tick();
    expect(loaded).toEqual([{ source: "path_glob_match", detail: ".wudao/rules/a.md" }]);
  });

  it("fires compact when the standing rider rides an auto compaction", async () => {
    const sources: string[] = [];
    // ω-3b hand-check: the floored unseen batch routes the compact to tier-2
    // (LLM summary), which needs a scripted response of its own.
    const big = "x".repeat(60_000);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", big)]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 1_000, keepRecent: 0, compactInstructions: "keep repro steps" },
      gates: NO_GATES,
      hooks: {
        onInstructionsLoaded: (source) => { sources.push(source); },
      },
    }));
    await tick();
    expect(sources).toContain("compact");
  });
});

describe("M63-B prompt_blocked (submit-time user notice)", () => {
  it("emits the event when the run-start gate blocks the prompt", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "ok" }]);
    const s = state([], [{ role: "user", content: "leak sk-123" }]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks: {
        onPromptSubmit: () => ({ block: true, reason: "secrets detected" }),
      },
    }));
    const blocked = events.filter((e) => e.type === "prompt_blocked");
    expect(blocked.length).toBe(1);
    expect(blocked[0]).toMatchObject({ type: "prompt_blocked", reason: "secrets detected" });
    // The model-visible replacement also landed.
    expect(s.messages.some((m) => m.role === "user" && m.content === "[prompt blocked] secrets detected")).toBe(true);
  });
});

describe("M63-B SubagentStart / SubagentStop (runSubagent)", () => {
  const childTools: Tool[] = [stubTool("read_file", "CHILD CONTENT")];
  const childModel = (answers: string[]) => {
    const model = createScriptedModel(answers.map((content) => ({ role: "assistant" as const, content })));
    return model;
  };

  it("onStart fires with the agent type at the child's start; onStop at its stop", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const answer = await runSubagent({
      model: childModel(["child done"]),
      allTools: childTools,
      subagentType: { name: "general-purpose", description: "d", systemPrompt: "child", toolNames: ["read_file"] },
      prompt: "do the thing",
      loopOptions: { maxTurns: 4 },
      subagentHooks: {
        onStart: (t) => { starts.push(t); },
        onStop: (t) => { stops.push(t); return "allow"; },
      },
    });
    expect(answer).toBe("child done");
    expect(starts).toEqual(["general-purpose"]);
    expect(stops).toEqual(["general-purpose"]);
  });

  it("a blocking onStop keeps the child working one more turn", async () => {
    let stops = 0;
    const model = createScriptedModel([
      { role: "assistant", content: "first answer" },
      { role: "assistant", content: "final answer" },
    ]);
    const answer = await runSubagent({
      model,
      allTools: childTools,
      subagentType: { name: "coder", description: "d", systemPrompt: "child", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 4 },
      subagentHooks: {
        onStop: () => {
          stops += 1;
          // Block the FIRST stop only — the second stop is allowed, or the
          // block cap would end the run anyway (also fine, but assert deterministically).
          return stops === 1 ? { continue: false, reason: "one more turn" } : "allow";
        },
      },
    });
    expect(stops).toBe(2);
    expect(answer).toBe("final answer");
    expect(model.calls).toBe(2); // the child was called again after the block
  });

  it("R1: exactly-once per lifecycle — max_turns + grace fires onStart ONCE and onStop ONCE", async () => {
    let starts = 0;
    let stops = 0;
    // A model that ALWAYS tool-calls: the child blows its 1-turn fuse, the
    // grace pass runs (stop face only), and both passes end non-completed.
    const looping = { role: "assistant" as const, content: "", toolCalls: [{ id: "c", name: "read_file", arguments: { path: "a" } }] };
    const model = createScriptedModel([looping, looping, looping, looping, looping]);
    await runSubagent({
      model,
      allTools: childTools,
      subagentType: { name: "coder", description: "d", systemPrompt: "child", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 1 },
      graceTools: ["read_file"],
      subagentHooks: {
        onStart: () => { starts += 1; },
        onStop: () => { stops += 1; return "allow"; },
      },
    });
    expect(starts).toBe(1); // R1 (b): the grace pass must not re-fire start
    expect(stops).toBe(1); // R1 (a): the non-completed terminal consults stop once
  });

  it("R1: an aborted child consults onStop exactly once (observationally)", async () => {
    let stops = 0;
    const controller = new AbortController();
    const model = createScriptedModel([{ role: "assistant", content: "never lands" }]);
    const answer = runSubagent({
      model,
      allTools: childTools,
      subagentType: { name: "general-purpose", description: "d", systemPrompt: "child", toolNames: ["read_file"] },
      prompt: "work",
      loopOptions: { maxTurns: 4, signal: controller.signal },
      subagentHooks: {
        onStop: () => { stops += 1; return { continue: false, reason: "ignored anyway" }; },
      },
    });
    controller.abort();
    await answer;
    expect(stops).toBe(1);
  });

  it("the type matcher is the CALLER's concern — a 'fork' type name rides through", async () => {
    const types: string[] = [];
    await runSubagent({
      model: childModel(["forked answer"]),
      allTools: childTools,
      subagentType: { name: "fork", description: "d", systemPrompt: "child", toolNames: ["read_file"] },
      prompt: "p",
      loopOptions: { maxTurns: 2 },
      subagentHooks: {
        onStart: (t) => { types.push(t); },
        onStop: () => "allow",
      },
    });
    expect(types).toEqual(["fork"]);
  });
});
