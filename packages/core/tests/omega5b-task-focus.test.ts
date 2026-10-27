// ω-5b (I22) — auto task-focus for tier-2 compactions (book ch2, r38: a
// summary that does not re-anchor on the task invites context rot; weak
// models need structural help, not a polite instruction). Two halves, both
// confined to compaction.ts:
//   (a) tier2Compact / dualTier2Compact / staticTier2Compact weave the
//       DERIVED focus (autoTaskFocus) into the existing "Focus on:" rider
//       whenever options.focus is absent — summaryInstruction untouched;
//   (b) the composed summary message carries one deterministic
//       `Task: <focus>` line right after the frozen SUMMARY_MARKER, above
//       the summarized body, so even a weak summary shows the task verbatim.
// Explicit focus (manual /compact) wins. No derivable focus → today's bytes.
import { describe, it, expect } from "vitest";
import {
  autoTaskFocus,
  SUMMARY_TASK_LEAD,
  SUMMARY_MARKER,
  SUMMARY_END_MARKER,
  staticFallbackSummary,
  staticTier2Compact,
  tier2Compact,
  dualTier2Compact,
} from "../src/compaction.js";
import { runAgentLoop } from "../src/index.js";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, LoopEvent, Terminal, Tool, AgentState } from "../src/index.js";

const board = (header: string, ...lines: string[]): string => [header, ...lines].join("\n");

const SPAN_NO_BOARD: AgentMessage[] = [
  { role: "user", content: "refactor the auth module" },
  { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
  { role: "tool", toolCallId: "t1", name: "read_file", content: "src bytes" },
  { role: "assistant", content: "working" },
];

/** Captures every generate() input; answers with a canned summary. */
function capturingModel(): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      return { role: "assistant", content: "SUMMARY" };
    },
  };
}

const lastInstruction = (model: { inputs: ModelInput[] }): string => {
  const last = model.inputs[model.inputs.length - 1];
  const finalMsg = last?.messages[last.messages.length - 1];
  return finalMsg?.role === "user" ? finalMsg.content : "";
};

describe("autoTaskFocus (ω-5b I22) — the pure derivation", () => {
  it("span with a board carrying one in_progress item → that item's line text", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "original ask" },
      { role: "tool", toolCallId: "b1", name: "todo_write", content: board("[todo board 1/3 done]", "☑ first", "◐ Writing tests", "☐ last") },
    ];
    expect(autoTaskFocus(span)).toBe("Writing tests");
  });

  it("in_progress wins over pending; the LAST board in the span wins", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "ask" },
      { role: "tool", toolCallId: "b1", name: "todo_write", content: board("[todo board 0/2 done]", "◐ old active", "☐ old pending") },
      { role: "tool", toolCallId: "b2", name: "todo_write", content: board("[todo board 0/2 done]", "☐ newer pending", "◐ newer active") },
    ];
    expect(autoTaskFocus(span)).toBe("newer active");
  });

  it("no in_progress line → the FIRST pending line", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "ask" },
      { role: "tool", toolCallId: "b1", name: "todo_write", content: board("[todo board 0/2 done]", "☐ first pending", "☐ second pending") },
    ];
    expect(autoTaskFocus(span)).toBe("first pending");
  });

  it("all-done board (neither in_progress nor pending) → the first-user fallback", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "the original task" },
      { role: "tool", toolCallId: "b1", name: "todo_write", content: board("[todo board 2/2 done]", "☑ a", "☑ b") },
    ];
    expect(autoTaskFocus(span)).toBe("the original task");
  });

  it("no board → the first user message capped at 200 chars", () => {
    expect(autoTaskFocus(SPAN_NO_BOARD)).toBe("refactor the auth module");
    const long: AgentMessage[] = [{ role: "user", content: "z".repeat(300) }, { role: "assistant", content: "ok" }];
    const focus = autoTaskFocus(long);
    expect(focus).toHaveLength(200);
    expect(focus).toBe("z".repeat(200));
  });

  it("empty span / no user and no board → undefined (the byte-stable escape)", () => {
    expect(autoTaskFocus([])).toBeUndefined();
    expect(autoTaskFocus([{ role: "assistant", content: "only" }, { role: "tool", toolCallId: "t", name: "x", content: "r" }])).toBeUndefined();
  });

  it("pure and deterministic", () => {
    expect(autoTaskFocus(SPAN_NO_BOARD)).toBe(autoTaskFocus(SPAN_NO_BOARD));
  });
});

describe("static path (ω-5b I22 b)", () => {
  it("the composed message carries the Task line after the marker, above the body; end marker exactly once", () => {
    // keepRecent 1 → the span is everything but the trailing assistant turn.
    const span = SPAN_NO_BOARD.slice(0, -1);
    const out = staticTier2Compact(SPAN_NO_BOARD, { keepRecent: 1 });
    expect(out).not.toBeNull();
    const content = out!.messages[0]!.content;
    // Marker FIRST (every marker consumer keys on it), Task line directly
    // above the summarized body.
    expect(content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} refactor the auth module\n`)).toBe(true);
    expect(content).toContain(staticFallbackSummary(span));
    expect(content.split(SUMMARY_END_MARKER)).toHaveLength(2); // exactly once
    expect(content.endsWith(SUMMARY_END_MARKER)).toBe(true);
  });

  it("a span with a board derives the board's in_progress item (first-pending fallback covered by the same seam)", () => {
    // ω-3b hand-check: the board result used to end the exchange unseen —
    // spanning it was the over-stub the floor closes. The ack makes it SEEN.
    const span: AgentMessage[] = [
      { role: "user", content: "u1 " + "x".repeat(100) },
      { role: "assistant", content: "", toolCalls: [{ id: "b0", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "b0", name: "todo_write", content: board("[todo board 1/2 done]", "☑ first", "☐ second") },
      { role: "assistant", content: "board written" },
      { role: "user", content: "continue" },
    ];
    const out = staticTier2Compact(span, { keepRecent: 1 });
    expect(out!.messages[0]!.content).toContain(`${SUMMARY_TASK_LEAD} second\n`);
    // assembleTier2 shape unchanged: the restored board still follows.
    expect(out!.messages[1]!.content.startsWith("[todo board 1/2 done](restored)")).toBe(true);
  });

  it("escape hatch: no derivable focus → output is byte-identical to the pre-change golden", () => {
    // A span with neither a board nor any user message (compactable via its
    // assistant/tool messages) must compose EXACTLY today's bytes.
    const msgs: AgentMessage[] = [
      { role: "assistant", content: "a1 " + "x".repeat(200) },
      { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "t1", name: "read_file", content: "r1 " + "y".repeat(200) },
      { role: "assistant", content: "a2" },
    ];
    const span = msgs.slice(0, -1); // keepRecent 1
    const out = staticTier2Compact(msgs, { keepRecent: 1 });
    expect(out).not.toBeNull();
    // 113-B1：权威行常驻 rider——kept tail（a2 assistant 轮）>0 时必骑（新契约重钉）。
    const golden = `${SUMMARY_MARKER} ${staticFallbackSummary(span)}\n[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]\n保留的消息权威于本摘要\n${SUMMARY_END_MARKER}`;
    expect(out!.messages[0]!.content).toBe(golden);
    expect(out!.messages[0]!.content.includes(SUMMARY_TASK_LEAD)).toBe(false);
  });
});

describe("LLM path (ω-5b I22 a+b)", () => {
  it("the summarizer instruction carries the DERIVED focus when options.focus is absent", async () => {
    const model = capturingModel();
    // 波次 7 #38: these tests assert the LLM instruction/body seam; the span
    // is thin, so the digest gate would skip the model call.
    const out = await tier2Compact(SPAN_NO_BOARD, model, { keepRecent: 1, zeroLlmDigest: false });
    expect(out).not.toBeNull();
    expect(lastInstruction(model)).toContain("Focus on: refactor the auth module");
    // The replayed PREFIX above the instruction is untouched (cache-safe).
    const replayed = model.inputs[0]?.messages.slice(0, -1) ?? [];
    expect(replayed.some((m) => m.content.includes("refactor the auth module"))).toBe(true);
    // The composed message also carries the Task line.
    expect(out!.summaryMessage.content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} refactor the auth module\n`)).toBe(true);
  });

  it("explicit focus wins: the rider AND the Task line carry it, derived text absent", async () => {
    const model = capturingModel();
    const out = await tier2Compact(SPAN_NO_BOARD, model, { keepRecent: 1, focus: "only open questions", zeroLlmDigest: false });
    expect(lastInstruction(model)).toContain("Focus on: only open questions");
    expect(lastInstruction(model)).not.toContain("Focus on: refactor the auth module");
    expect(out!.summaryMessage.content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} only open questions\n`)).toBe(true);
    expect(out!.summaryMessage.content.includes("Task: refactor the auth module")).toBe(false);
  });

  it("the dual summarizer weaves the derived focus into BOTH halves and the merged message", async () => {
    const big = "y".repeat(4000);
    const turn: AgentMessage[] = [
      { role: "user", content: "do the huge thing" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c0", name: "read_file", content: big },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: big },
      { role: "assistant", content: "working" },
      { role: "user", content: "final tail" },
    ];
    const model = capturingModel();
    const out = await dualTier2Compact(turn, model, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(out).not.toBeNull();
    expect(model.inputs.length).toBe(2);
    for (const input of model.inputs) {
      const instruction = input.messages[input.messages.length - 1]?.content ?? "";
      expect(instruction).toContain("Focus on: do the huge thing");
    }
    expect(out!.messages[0]!.content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} do the huge thing\n`)).toBe(true);
    expect(out!.messages[0]!.content).toContain("[turn summary]");
  });

  it("an LLM summary echoing the task line keeps the composed line as the message head (end marker once)", async () => {
    const model: ModelClient = {
      async generate(): Promise<AssistantMessage> {
        return { role: "assistant", content: "Task: refactor the auth module\nSUMMARY" };
      },
    };
    const out = await tier2Compact(SPAN_NO_BOARD, model, { keepRecent: 1, zeroLlmDigest: false }); // #38: the echo premise is an LLM call
    // The COMPOSED task line is deterministic and rides the head (right
    // after the marker); the model's echo is ordinary body text below it.
    expect(out!.summaryMessage.content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} refactor the auth module\n`)).toBe(true);
    expect(out!.summaryMessage.content).toContain("\nTask: refactor the auth module\n");
    expect(out!.summaryMessage.content.split(SUMMARY_END_MARKER)).toHaveLength(2);
  });
});

describe("loop auto-compaction derives the focus (ω-5b I22)", () => {
  it("a threshold-triggered tier-2 compaction weaves the derived focus without any LoopOptions change", async () => {
    const seed: AgentMessage[] = [];
    for (let i = 0; i < 6; i += 1) {
      seed.push({ role: "user", content: `task ${i} ${"x".repeat(600)}` });
      seed.push({ role: "assistant", content: `answer ${i} ${"y".repeat(600)}` });
    }
    const inputs: ModelInput[] = [];
    let n = 0;
    const echo: Tool = {
      name: "echo",
      description: "trivial",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: (args) => Promise.resolve({ content: String((args as { text?: string }).text ?? "") }),
    };
    const model: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        n += 1;
        if (n === 1) return { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }] };
        if (n === 2) return { role: "assistant", content: "SUMMARY" };
        return { role: "assistant", content: "done" };
      },
    };
    const state: AgentState = { systemPrompt: "s", messages: [...seed, { role: "user", content: "go" }], tools: [echo], status: "idle" };
    const events: LoopEvent[] = [];
    const gen = runAgentLoop(state, model, { maxTurns: 6, gates: { todo: false, verify: false }, compaction: { contextWindowTokens: 1_500, keepRecent: 1 } });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      events.push(r.value as LoopEvent);
    }
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    if (compacted === undefined || compacted.tier !== 2) throw new Error("test premise failed: no tier-2 compaction");
    const summaryCall = inputs[1];
    const last = summaryCall?.messages[summaryCall.messages.length - 1];
    expect(last?.role === "user" ? last.content : "").toContain("Focus on: task 0");
    expect(compacted.summaryMessage?.content.startsWith(`${SUMMARY_MARKER} ${SUMMARY_TASK_LEAD} task 0`)).toBe(true);
  });
});
