// M70 §1 — the truncated tool-call guard (the upstream project): when the provider response's
// stop_reason is "length" (the token limit cut the generation mid-arguments),
// EVERY tool call in that message fails with the explanatory error result —
// never executed, never salvage-parsed. The loop continues to the next turn
// so the model can re-issue complete calls.
import { describe, it, expect } from "vitest";
import { runAgentLoop, buildTool } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, Tool } from "../src/index.js";
import { TRUNCATED_TOOL_CALL_RESULT } from "../src/loop.js";

/** A tool that records every execution (the guard must keep this at zero). */
function spyingWriteTool(executed: { name: string; args: Record<string, unknown> }[]): Tool {
  return buildTool({
    name: "write_file",
    description: "spy write",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: async (args) => {
      executed.push({ name: "write_file", args });
      return { content: "wrote" };
    },
  });
}

/** Scripted model returning canned assistant messages in order. */
function scriptedModel(responses: readonly AssistantMessage[]): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(): Promise<AssistantMessage> {
      const r = responses[calls];
      calls += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}

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
  messages: [{ role: "user", content: "write the file" }],
  tools,
  status: "idle",
});

describe("truncated tool-call guard (M70 §1)", () => {
  it("a stop_reason=length tool call NEVER executes; the result explains why; the loop continues", async () => {
    const executed: { name: string; args: Record<string, unknown> }[] = [];
    // Exactly what the provider's salvage parser produces for arguments cut
    // mid-JSON (`{"path": "src/a` → {}): schema-valid-looking, silently wrong.
    const model = scriptedModel([
      {
        role: "assistant",
        content: "",
        stopReason: "length",
        toolCalls: [{ id: "t1", name: "write_file", arguments: {} }],
      },
      { role: "assistant", content: "recovered: answered without tools" },
    ]);
    const st = state([spyingWriteTool(executed)]);
    const events = await drain(runAgentLoop(st, model, { maxTurns: 3 }));

    // The tool NEVER executed (no spy hits, no permission gates reached).
    expect(executed).toHaveLength(0);
    // The result entry explains why, as an error.
    const results = st.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: "t1", name: "write_file", isError: true });
    expect((results[0] as { content: string }).content).toBe(TRUNCATED_TOOL_CALL_RESULT);
    expect(TRUNCATED_TOOL_CALL_RESULT).toContain("参数被截断");
    expect(TRUNCATED_TOOL_CALL_RESULT).toContain("请重新发起完整的工具调用");
    // The finished event mirrors the error shape (display channel).
    const finished = events.find((e) => e.type === "tool_call_finished");
    expect(finished).toMatchObject({ isError: true, result: TRUNCATED_TOOL_CALL_RESULT });
    // The loop CONTINUED: the model was called again and the run completed.
    expect(model.calls).toBe(2);
    expect(events.at(-1)).toBeDefined();
    const terminalEvents = events.filter((e) => e.type === "turn_finished");
    expect(terminalEvents).toHaveLength(2);
  });

  it("fails ALL tool calls of a truncated multi-call batch", async () => {
    const executed: { name: string; args: Record<string, unknown> }[] = [];
    const model = scriptedModel([
      {
        role: "assistant",
        content: "",
        stopReason: "length",
        toolCalls: [
          { id: "t1", name: "write_file", arguments: { path: "a" } },
          { id: "t2", name: "write_file", arguments: {} },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const st = state([spyingWriteTool(executed)]);
    await drain(runAgentLoop(st, model, { maxTurns: 3 }));
    expect(executed).toHaveLength(0);
    const results = st.messages.filter((m) => m.role === "tool");
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.isError === true)).toBe(true);
  });

  it("a stop_reason=stop tool call executes normally (the guard is length-only)", async () => {
    const executed: { name: string; args: Record<string, unknown> }[] = [];
    const model = scriptedModel([
      {
        role: "assistant",
        content: "",
        stopReason: "tool_calls",
        toolCalls: [{ id: "t1", name: "write_file", arguments: { path: "a", content: "x" } }],
      },
      { role: "assistant", content: "done" },
    ]);
    const st = state([spyingWriteTool(executed)]);
    // Gates off: the verify gate would nudge a post-write run for a shell.
    await drain(runAgentLoop(st, model, { maxTurns: 3, gates: { verify: false, todo: false } }));
    expect(executed).toHaveLength(1);
    const results = st.messages.filter((m) => m.role === "tool");
    expect(results[0]?.isError).not.toBe(true);
  });

  it("a length-truncated message with NO tool calls takes the 夜移 013 recovery ladder (opt-out preserves the old ordinary-final-answer behavior)", async () => {
    // Default-ON (夜移 013): the truncated text answer is NOT a stop intent —
    // the ladder nudges. maxTurns:2 admits the original call plus one nudge
    // continuation, so the scripted model sees 2 calls.
    const model = scriptedModel([
      { role: "assistant", content: "partial answ", stopReason: "length" },
      { role: "assistant", content: "partial answer, completed" },
    ]);
    const st = state([]);
    const events = await drain(runAgentLoop(st, model, { maxTurns: 2 }));
    expect(model.calls).toBe(2);
    expect(events.some((e) => e.type === "tool_call_finished")).toBe(false);
    expect(events.some((e) => e.type === "output_limit_recovery" && e.kind === "nudge")).toBe(true);
    expect(events.at(-1)?.type).toBe("turn_finished");

    // Opt-out lane (maxNudges:0): the OLD contract — a length-truncated text
    // answer is an ordinary final answer, one call, no ladder events (the
    // typed output_limit terminal replaces the old silent "completed").
    const m2 = scriptedModel([{ role: "assistant", content: "partial answ", stopReason: "length" }]);
    const st2 = state([]);
    const events2 = await drain(runAgentLoop(st2, m2, { maxTurns: 2, outputLimitRecovery: { maxNudges: 0 } }));
    expect(m2.calls).toBe(1);
    expect(events2.some((e) => e.type === "output_limit_recovery")).toBe(false);
  });
});
