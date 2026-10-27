// M63-A batch A — the loop-level event surface: PreCompact (trigger word +
// defer), PostCompact (trigger word), PostToolUseFailure (the failure face),
// PostToolBatch (the batch face + the continue decision). Deterministic:
// scripted models, stub tools, no fs.
import { describe, it, expect } from "vitest";
import { runAgentLoop } from "../src/loop.js";
import { buildTool } from "../src/index.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentHooks, AgentState, LoopEvent, PostToolBatchCall, Terminal } from "../src/index.js";

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

const params = {
  type: "object" as const,
  properties: { path: { type: "string" as const } },
  required: ["path"],
  additionalProperties: false,
};

function stubTool(name: string, content: string, isError = false) {
  return buildTool({
    name,
    description: `stub ${name}`,
    parameters: params,
    execute: async () => ({ content, isError }),
  });
}

function state(tools: readonly ReturnType<typeof stubTool>[]): AgentState {
  return {
    systemPrompt: "s",
    messages: [{ role: "user", content: "go" }],
    tools,
    status: "idle" as const,
  };
}

describe("M63-A onPreCompact / onPostCompact", () => {
  it("passes trigger 'auto' and fires PostCompact after the compact lands", async () => {
    const preTriggers: string[] = [];
    const postTriggers: string[] = [];
    // A huge tool result over a tiny window forces the immediate tier.
    // ω-3b hand-check: the big result is the active turn's own (unseen) batch,
    // so the floor keeps it verbatim and the cheap tiers do nothing — the
    // compaction that fires is tier-2 (LLM summary), which needs its own
    // scripted response before the final turn's answer.
    const big = "x".repeat(60_000);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const hooks: AgentHooks = {
      onPreCompact: (messages, trigger) => {
        preTriggers.push(trigger);
        expect(messages.length).toBeGreaterThan(0);
      },
      onPostCompact: (messages, trigger) => {
        postTriggers.push(trigger);
      },
    };
    const s = state([stubTool("read_file", big)]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 1_000, keepRecent: 0 },
      hooks,
    }));
    expect(preTriggers.length).toBeGreaterThanOrEqual(1);
    expect(preTriggers.every((t) => t === "auto")).toBe(true);
    expect(postTriggers.length).toBeGreaterThanOrEqual(1);
    expect(postTriggers.every((t) => t === "auto")).toBe(true);
    expect(events.some((e) => e.type === "compacted")).toBe(true);
  });

  it("a defer skips the compaction and emits compact_deferred with the reason", async () => {
    const big = "x".repeat(60_000);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const hooks: AgentHooks = {
      onPreCompact: () => ({ defer: true, reason: "not now" }),
    };
    const s = state([stubTool("read_file", big)]);
    const { events, terminal } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 1_000, keepRecent: 0 },
      hooks,
    }));
    expect(terminal.reason).toBe("completed");
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    const deferred = events.filter((e) => e.type === "compact_deferred");
    expect(deferred.length).toBeGreaterThanOrEqual(1);
    expect((deferred[0] as { reason: string }).reason).toBe("not now");
    // The history never shrank: the big tool result is still there verbatim.
    expect(s.messages.some((m) => m.role === "tool" && m.content === big)).toBe(true);
  });

  it("a throwing preCompact hook degrades to compact-anyway", async () => {
    // ω-3b hand-check: same as above — the floored batch sends the compact to
    // tier-2, whose summary call needs a scripted response of its own.
    const big = "x".repeat(60_000);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", big)]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 1_000, keepRecent: 0 },
      hooks: { onPreCompact: () => { throw new Error("hook blew up"); } },
    }));
    expect(events.some((e) => e.type === "compacted")).toBe(true);
  });
});

describe("M63-A fix — the steering drain runs the prompt gate", () => {
  // A queue that stays empty for the FIRST drain (the run-start model call),
  // then yields one steer — the shape of a submission while a run is busy.
  function busyRunSteerQueue(steer: string) {
    let drainedOnce = false;
    return {
      take(): string | undefined {
        if (drainedOnce) return undefined;
        drainedOnce = true;
        return steer;
      },
    };
  }

  it("a blocked steer is DROPPED (never enters state.messages) and surfaced via blockedReason", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", "A")]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      steering: busyRunSteerQueue("my api key is sk-123"),
      hooks: {
        onPromptSubmit: (prompt) => (prompt.includes("sk-") ? { block: true, reason: "secrets" } : prompt),
      },
    }));
    // The steer never became a user message.
    expect(s.messages.some((m) => m.role === "user" && m.content.includes("sk-"))).toBe(false);
    // The steered event IS the notice: it names the drop + the reason.
    const steered = events.filter((e) => e.type === "steered");
    expect(steered.length).toBe(1);
    expect(steered[0]).toMatchObject({ type: "steered", text: "my api key is sk-123", blockedReason: "secrets" });
  });

  it("a rewritten steer pushes the REWRITTEN text", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", "A")]);
    const { events } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      steering: busyRunSteerQueue("loud text"),
      hooks: {
        onPromptSubmit: (prompt) => `rewritten: ${prompt}`,
      },
    }));
    expect(s.messages.some((m) => m.role === "user" && m.content === "rewritten: loud text")).toBe(true);
    expect(s.messages.some((m) => m.role === "user" && m.content === "loud text")).toBe(false);
    const steered = events.filter((e) => e.type === "steered");
    expect(steered.length).toBe(1);
    expect((steered[0] as { text: string }).text).toBe("rewritten: loud text");
    expect((steered[0] as { blockedReason?: string }).blockedReason).toBeUndefined();
  });

  it("a throwing gate hook degrades to the original steer", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "done" },
    ]);
    const s = state([stubTool("read_file", "A")]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      steering: busyRunSteerQueue("keep me"),
      hooks: { onPromptSubmit: () => { throw new Error("gate blew up"); } },
    }));
    expect(s.messages.some((m) => m.role === "user" && m.content === "keep me")).toBe(true);
  });
});

describe("M63-C updatedInput (the rewrite contract)", () => {
  it("a preToolUse hook's {updatedInput} is what validation and the tool see", async () => {
    const seen: Record<string, unknown>[] = [];
    const echoTool = stubTool("read_file", "ok"); // placeholder replaced below
    void echoTool;
    const tool = buildTool({
      name: "read_file",
      description: "stub read",
      parameters: params,
      execute: async (args) => {
        seen.push(args);
        return { content: "done" };
      },
    });
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "original.txt" } }] },
      { role: "assistant", content: "finished" },
    ]);
    const s = state([tool as never]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 4,
      hooks: {
        onPreToolUse: () => ({ updatedInput: { path: "rewritten-by-hook.txt" } }),
      },
    }));
    expect(seen).toEqual([{ path: "rewritten-by-hook.txt" }]);
    // The rewrite also landed in history (the tool result's arguments).
    const toolMsg = s.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
  });
});

describe("M63-A onPostToolUseFailure", () => {
  it("fires for an EXECUTED call that errored — not for successes or denied calls", async () => {
    const failures: { name: string; result: string }[] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: { path: "ok.txt" } },
          { id: "c2", name: "write_file", arguments: { path: "denied.txt" } },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const hooks: AgentHooks = {
      onPostToolUseFailure: (name, _input, result) => {
        failures.push({ name, result });
      },
    };
    const s = state([
      stubTool("read_file", "boom", true),
      stubTool("write_file", "written"),
    ]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks,
      canUseTool: (name) => name === "write_file" ? { behavior: "deny", reason: "not allowed" } : { behavior: "allow" },
    }));
    // Only the executed-and-errored read_file fired the failure face.
    expect(failures).toEqual([{ name: "read_file", result: "boom" }]);
  });
});

describe("M63-A onPostToolBatch", () => {
  it("fires once per turn with every EXECUTED call and allows continuation", async () => {
    const batches: PostToolBatchCall[][] = [];
    const model = createScriptedModel([
      {
        role: "assistant", content: "",
        toolCalls: [
          { id: "c1", name: "read_file", arguments: { path: "a.txt" } },
          { id: "c2", name: "grep", arguments: { path: "b.txt" } },
        ],
      },
      { role: "assistant", content: "all done" },
    ]);
    const s = state([stubTool("read_file", "A"), stubTool("grep", "B")]);
    const { terminal } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks: {
        onPostToolBatch: (batch) => {
          batches.push([...batch]);
          return "allow";
        },
      },
    }));
    expect(batches.length).toBe(1);
    expect(batches[0]!.map((c) => [c.name, c.isError, c.result])).toEqual([
      ["read_file", false, "A"],
      ["grep", false, "B"],
    ]);
    expect(terminal.reason).toBe("completed");
  });

  it("{continue:false} ends the run at the batch boundary (postToolBatchStop)", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "never reached" },
    ]);
    const s = state([stubTool("read_file", "A")]);
    const { terminal } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks: {
        onPostToolBatch: () => ({ continue: false, reason: "quota" }),
      },
    }));
    expect(terminal.reason).toBe("completed");
    expect(terminal.postToolBatchStop).toBe(true);
    expect(terminal.finalMessage?.content).toBe("");
    // The scripted second model call never ran — the hook decided.
    expect(model.calls).toBe(1);
  });

  it("excludes denied calls from the batch payload and skips empty batches", async () => {
    const batches: PostToolBatchCall[][] = [];
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "d.txt" } }] },
      { role: "assistant", content: "answered with no tools" },
    ]);
    const s = state([stubTool("write_file", "w")]);
    await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks: { onPostToolBatch: (batch) => { batches.push([...batch]); } },
      canUseTool: () => ({ behavior: "deny", reason: "no" }),
    }));
    // Turn 1: the single call was denied → nothing executed → no batch fire.
    // Turn 2: no tool calls at all → no batch fire.
    expect(batches).toEqual([]);
  });

  it("a throwing postToolBatch hook degrades to allow", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "assistant", content: "carried on" },
    ]);
    const s = state([stubTool("read_file", "A")]);
    const { terminal } = await drain(runAgentLoop(s, model, {
      maxTurns: 5,
      hooks: { onPostToolBatch: () => { throw new Error("kaboom"); } },
    }));
    expect(terminal.reason).toBe("completed");
    expect(terminal.finalMessage?.content).toBe("carried on");
  });
});
