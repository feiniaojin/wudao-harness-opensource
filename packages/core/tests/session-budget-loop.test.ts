// 夜移 036 — loop ↔ session-budget integration: the threaded budget charges
// real responses (usage → recordUsage, cached input free), ends the run the
// moment the pool goes dry (before the tool batch — the crossing response's
// tool calls never execute), and the reminder rides the MetaNote projection
// (first request of the window restates the full remaining; a threshold
// crossing restates at the higher index; same window + same index is silent).
import { describe, it, expect } from "vitest";
import { runAgentLoop, createSessionBudget } from "../src/index.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput, SessionBudget, Tool, ToolResultMessage } from "../src/index.js";

/** Scripted model: each generate() fires onUsage with the scripted row, then
 *  answers (or tool-calls). The recorded input messages let the tests assert
 *  what the model actually SAW (the projected reminder notes). */
function budgetModel(
  steps: readonly { content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]; usage?: { prompt?: number; cacheHit?: number; completion?: number } }[],
): ModelClient & { inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      input.onUsage?.({
        promptTokens: step.usage?.prompt ?? 0,
        cacheHitTokens: step.usage?.cacheHit ?? 0,
        cacheMissTokens: Math.max(0, (step.usage?.prompt ?? 0) - (step.usage?.cacheHit ?? 0)),
        completionTokens: step.usage?.completion ?? 0,
      });
      return {
        role: "assistant",
        content: step.content,
        ...(step.toolCalls !== undefined ? { toolCalls: step.toolCalls } : {}),
      };
    },
  };
}

const echoTool: Tool = {
  name: "echo",
  description: "answers done",
  parameters: { type: "object" as const, properties: {}, required: [] },
  isReadOnly: true,
  async execute(): Promise<{ content: string }> {
    return { content: "done" };
  },
};

async function drain(gen: AsyncGenerator<LoopEvent, unknown>): Promise<{ events: LoopEvent[]; terminal: unknown }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return { events, terminal: r.value };
    events.push(r.value);
  }
}

const state = (tools: Tool[]): AgentState => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" } satisfies AgentMessage],
  tools,
  status: "idle",
});

/** All <system_note> payload text that reached the model across inputs. */
const noteText = (inputs: readonly ModelInput[]): string =>
  inputs.map((i) => i.messages.map((m) => (m as ToolResultMessage).content ?? "").join("\n")).join("\n");

describe("夜移 036 — loop wiring: charge, exhaust, remind", () => {
  it("charges every response (cached input free) and the first request restates the full remaining", async () => {
    const budget = createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 50, 25] });
    // turn 1: tool call, 10 output + 20 non-cached input = 30 units
    // turn 2: plain answer, 5 output, all 30 input cached = 5 units
    const model = budgetModel([
      { content: "work", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage: { prompt: 30, cacheHit: 10, completion: 10 } },
      { content: "done", usage: { prompt: 30, cacheHit: 30, completion: 5 } },
    ]);
    const { events, terminal } = await drain(runAgentLoop(state([echoTool]), model, {
      sessionBudget: { budget, threadId: "root" },
    }));
    expect(terminal).toMatchObject({ reason: "completed" });
    expect(budget.usedUnits()).toBe(30 + 5);
    expect(events.some((e) => e.type === "session_budget_exhausted")).toBe(false);
    // the FIRST request of the window carried the index-0 initial reminder
    // (full remaining = the limit)
    expect(noteText(model.inputs)).toContain("You have 100 weighted tokens left in the shared session token budget.");
  });

  it("exhaustion ends the run before the tool batch; the crossing response's tool calls never execute", async () => {
    const budget = createSessionBudget({ limitTokens: 40, reminderAtRemainingTokens: [20] });
    const model = budgetModel([
      // 50 units ≥ 40 → exhausted; the response asks for a tool, but the run
      // must die before the batch (no tool_call_started, no execution)
      { content: "work", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage: { prompt: 40, cacheHit: 0, completion: 10 } },
      { content: "never reached", usage: {} },
    ]);
    const { events, terminal } = await drain(runAgentLoop(state([echoTool]), model, {
      sessionBudget: { budget, threadId: "root" },
    }));
    expect(terminal).toMatchObject({ reason: "session_budget_exhausted" });
    expect(events.some((e) => e.type === "tool_call_started")).toBe(false);
    expect(events.some((e) => e.type === "session_budget_exhausted")).toBe(true);
    // the dying request carried the PRE-crossing reminder (40 = the limit —
    // usage records after the request, and the exhausted run never issues a
    // follow-up that could show 0). The event carries the weighted total.
    expect(noteText(model.inputs)).toContain("You have 40 weighted tokens left");
    const exh = events.find((e) => e.type === "session_budget_exhausted");
    expect(exh).toMatchObject({ turn: 0, usedUnits: 50 });
    // sticky: a later run burns one call, records, fails the same way
    const model2 = budgetModel([{ content: "again", usage: { completion: 1 } }]);
    const second = await drain(runAgentLoop(state([]), model2, {
      sessionBudget: { budget, threadId: "root" },
    }));
    expect(second.terminal).toMatchObject({ reason: "session_budget_exhausted" });
  });

  it("threshold crossing restates at the higher index; same window + same index stays silent", async () => {
    const budget = createSessionBudget({ limitTokens: 100, reminderAtRemainingTokens: [75, 50, 25] });
    // turn 1: 30 units → remaining 70 → index 1 (75 crossed); the FIRST
    // request already showed index 0 (100), so this request restates 70.
    // turn 2: +20 units → remaining 50 → index 2 (75 and 50 crossed).
    // turn 3: +5 units → remaining 45 → still index 2 — silent (dedup).
    const model = budgetModel([
      { content: "t1", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage: { completion: 30 } },
      { content: "t2", toolCalls: [{ id: "c2", name: "echo", arguments: {} }], usage: { completion: 20 } },
      { content: "t3", toolCalls: [{ id: "c3", name: "echo", arguments: {} }], usage: { completion: 5 } },
      { content: "done", usage: {} },
    ]);
    const { terminal } = await drain(runAgentLoop(state([echoTool]), model, {
      sessionBudget: { budget, threadId: "root" },
    }));
    expect(terminal).toMatchObject({ reason: "completed" });
    const seen = noteText(model.inputs);
    expect(seen).toContain("You have 100 weighted tokens left");
    expect(seen).toContain("You have 70 weighted tokens left");
    expect(seen).toContain("You have 50 weighted tokens left");
    // index 2 delivered on the third request; the fourth request (same
    // window, same index) restates NOTHING — "45" never appears.
    expect(seen).not.toContain("You have 45 weighted tokens left");
  });

  it("absent sessionBudget: the run behaves exactly as before", async () => {
    const model = budgetModel([
      { content: "t1", toolCalls: [{ id: "c1", name: "echo", arguments: {} }], usage: { completion: 9_999_999 } },
      { content: "done", usage: {} },
    ]);
    const { events, terminal } = await drain(runAgentLoop(state([echoTool]), model, {}));
    expect(terminal).toMatchObject({ reason: "completed" });
    expect(events.some((e) => e.type === "session_budget_exhausted")).toBe(false);
    expect(noteText(model.inputs)).not.toContain("weighted tokens left");
  });
});
