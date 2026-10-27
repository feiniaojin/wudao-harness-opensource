// 125 项 1（codex new_context 形）— the model-side context-rotation tests.
// Four contract faces pinned here:
//   1. the loop-level fire: a new_context call lands a tier-2 rotation
//      boundary (header + verbatim preserve + the summarizer instruction
//      rider), the receipt carries the opened window number, and the compacted
//      event carries trigger "agent-rotation" + agentRotation.
//   2. the budget cap: AGENT_ROTATION_CAP spent → typed refusal, nothing
//      fired, nothing counted.
//   3. one-per-turn: a second call in the SAME batch refuses honestly.
//   4. the independent window numbering (no 125b window chain): window =
//      boundary-marker count + 1, across harness compactions and rotations.
// Plus the pure riders/entry-lane/validation unit faces.
import { describe, it, expect } from "vitest";
import {
  createNewContextTool,
  validateNewContextArgs,
  newContextReceipt,
  newContextRefusal,
  buildContextRotationEntry,
  parseContextRotationData,
  countContextRotations,
  CONTEXT_ROTATION_ENTRY_TYPE,
  AGENT_ROTATION_CAP,
  NEW_CONTEXT_RATIONALE_MAX_CHARS,
  NEW_CONTEXT_PRESERVE_MAX_CHARS,
  type NewContextPortBox,
} from "../src/tools/new-context.js";
import {
  rotationHeaderLine,
  preserveSection,
  parseRotationHeader,
  PRESERVED_BY_AGENT_LEAD,
  staticTier2Compact,
  tier2Compact,
  countSummaryMarkers,
  SUMMARY_MARKER,
  compactableSpan,
} from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";
import { runAgentLoop } from "../src/loop.js";
import type { AgentMessage, AgentState, LoopEvent, ModelClient, AssistantMessage } from "../src/types.js";

async function drain(gen: AsyncGenerator<LoopEvent, unknown, unknown>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for (;;) {
    const r = await gen.next();
    if (r.done) return events;
    events.push(r.value);
  }
}

const call = (id: string, name: string, args: Record<string, unknown>): AgentMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name, arguments: args }],
});
const result = (id: string, name: string, content: string): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name,
  content,
});

/** A history with a rotatable span (> keepRecent messages before the window). */
function rotatableHistory(): AgentMessage[] {
  return [
    { role: "user", content: "first task" },
    call("a1", "read_file", { path: "a" }),
    result("a1", "read_file", "data a"),
    call("a2", "read_file", { path: "b" }),
    result("a2", "read_file", "data b"),
    { role: "user", content: "go on" },
    call("a3", "read_file", { path: "c" }),
    result("a3", "read_file", "data c"),
    { role: "user", content: "continue from here" },
  ];
}

/** A scripted model that also CAPTURES every generate input (the summarizer
 *  instruction assertions need the request bytes, not just the responses). */
function capturingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: unknown[] } {
  const inner = createScriptedModel(responses);
  const inputs: unknown[] = [];
  return {
    get inputs() {
      return inputs;
    },
    modelId: inner.modelId,
    async generate(input) {
      inputs.push(input);
      return inner.generate(input);
    },
  };
}

function rotationState(box: NewContextPortBox, history: AgentMessage[]): AgentState {
  return {
    systemPrompt: "s",
    messages: history,
    tools: [createNewContextTool(() => box.current)],
    status: "idle",
  };
}

describe("new_context pure riders", () => {
  it("rotationHeaderLine renders the identity line and flattens/caps the rationale", () => {
    expect(rotationHeaderLine(undefined)).toBe("");
    expect(rotationHeaderLine({ rationale: "subtask A done" })).toBe("[context rotated by agent: subtask A done]\n");
    const multiLine = rotationHeaderLine({ rationale: "line one\nline two  with   gaps" });
    expect(multiLine).toBe("[context rotated by agent: line one line two with gaps]\n");
    const long = rotationHeaderLine({ rationale: "x".repeat(500) });
    expect(long.length).toBeLessThanOrEqual("[context rotated by agent: ".length + 200 + 2);
    expect(long.endsWith("…]\n")).toBe(true);
    // An all-whitespace rationale renders NOTHING (status-quo bytes).
    expect(rotationHeaderLine({ rationale: "   " })).toBe("");
  });

  it("preserveSection carries the text verbatim; absent/blank = status-quo bytes", () => {
    expect(preserveSection(undefined)).toBe("");
    expect(preserveSection("   ")).toBe("");
    const block = preserveSection("path X verified\nkey decision: Y");
    expect(block.startsWith(`\n${PRESERVED_BY_AGENT_LEAD}\n`)).toBe(true);
    expect(block).toContain("path X verified\nkey decision: Y");
    expect(block.endsWith("\n")).toBe(true);
  });

  it("parseRotationHeader reads the identity back off a composed summary head", () => {
    const head = `${SUMMARY_MARKER} ${rotationHeaderLine({ rationale: "subtask A done" })}Task: t\nbody`;
    expect(parseRotationHeader(head)).toBe("subtask A done");
    expect(parseRotationHeader(`${SUMMARY_MARKER} Task: t`)).toBeUndefined();
    expect(parseRotationHeader("not a summary")).toBeUndefined();
  });
});

describe("new_context tier-2 weaving", () => {
  it("tier2Compact with agentRotation weaves header + preserve into the frozen summary and the instruction", async () => {
    const history = rotatableHistory();
    const model = capturingModel([
      { role: "assistant", content: "summary body: subtask A complete, key facts kept" },
    ]);
    const t2 = await tier2Compact(history, model, {
      keepRecent: 6,
      agentRotation: { rationale: "subtask A done", preserve: "path X verified" },
    });
    expect(t2).not.toBeNull();
    const summary = t2!.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))!;
    expect(summary.content).toContain("[context rotated by agent: subtask A done]");
    expect(parseRotationHeader(summary.content)).toBe("subtask A done");
    expect(summary.content).toContain(PRESERVED_BY_AGENT_LEAD);
    expect(summary.content).toContain("path X verified");
    // The summarizer instruction carried the must-keep rider (tail bytes only).
    const lastInput = model.inputs.at(-1) as { messages: AgentMessage[] };
    const instruction = lastInput.messages.at(-1);
    expect(instruction?.role).toBe("user");
    expect(instruction?.content).toContain("<agent-preserve>");
    expect(instruction?.content).toContain("path X verified");
    expect(instruction?.content).toContain("subtask A done");
    // The boundary is a NORMAL chain head: marker consumers still key on it.
    expect(countSummaryMarkers(t2!.messages)).toBe(1);
  });

  it("a preserve-bearing rotation skips the zero-LLM digest (the facts must reach the summarizer)", async () => {
    const history = rotatableHistory();
    const model = capturingModel([{ role: "assistant", content: "woven summary" }]);
    await tier2Compact(history, model, {
      keepRecent: 6,
      agentRotation: { rationale: "r", preserve: "keep me" },
    });
    // The LLM path ran (one generate = the summarizer); the digest path makes none.
    expect(model.inputs.length).toBe(1);
  });

  it("staticTier2Compact carries the rotation riders too (down-provider identity survives)", () => {
    const history = rotatableHistory();
    const t2 = staticTier2Compact(history, {
      keepRecent: 6,
      agentRotation: { rationale: "subtask A done", preserve: "path X verified" },
    });
    expect(t2).not.toBeNull();
    const summary = t2!.messages.find((m) => m.role === "user" && m.content.startsWith(SUMMARY_MARKER))!;
    expect(summary.content).toContain("[context rotated by agent: subtask A done]");
    expect(summary.content).toContain("path X verified");
  });

  it("status-quo bytes: options without agentRotation compose byte-identically", async () => {
    const history = rotatableHistory();
    const a = await tier2Compact(history, createScriptedModel([{ role: "assistant", content: "s" }]), { keepRecent: 6 });
    const b = await tier2Compact(history, createScriptedModel([{ role: "assistant", content: "s" }]), {
      keepRecent: 6,
      agentRotation: undefined,
    });
    expect(b!.summaryMessage.content).toBe(a!.summaryMessage.content);
  });
});

describe("new_context session lane", () => {
  it("build/parse/count round-trips; corrupt rows drop whole, messages are not rotations", () => {
    const e = buildContextRotationEntry({ window: 3, rationale: "r", at: "2026-09-26T00:00:00.000Z" });
    expect(e.type).toBe(CONTEXT_ROTATION_ENTRY_TYPE);
    expect(parseContextRotationData(e.data)).toEqual({ window: 3, rationale: "r", at: "2026-09-26T00:00:00.000Z" });
    expect(parseContextRotationData({ window: 0, rationale: "r", at: "x" })).toBeUndefined();
    expect(parseContextRotationData("junk")).toBeUndefined();
    expect(countContextRotations([
      e,
      { role: "user", content: "m" },
      buildContextRotationEntry({ window: 4, rationale: "r2", at: "2026-09-26T00:01:00.000Z" }),
      { type: CONTEXT_ROTATION_ENTRY_TYPE, data: { bad: true } },
    ])).toBe(2);
  });
});

describe("new_context args + receipts", () => {
  it("validates rationale (required, non-empty, capped) and preserve (optional, capped)", () => {
    expect(validateNewContextArgs({ rationale: "  done  " })).toEqual({ ok: true, req: { rationale: "done" } });
    expect(validateNewContextArgs({ rationale: "r", preserve: " p " }).ok && validateNewContextArgs({ rationale: "r", preserve: " p" }).req.preserve).toBe("p");
    expect(validateNewContextArgs({}).ok).toBe(false);
    expect(validateNewContextArgs({ rationale: "" }).ok).toBe(false);
    expect(validateNewContextArgs({ rationale: 42 }).ok).toBe(false);
    expect(validateNewContextArgs({ rationale: "x".repeat(NEW_CONTEXT_RATIONALE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateNewContextArgs({ rationale: "r", preserve: "x".repeat(NEW_CONTEXT_PRESERVE_MAX_CHARS + 1) }).ok).toBe(false);
    expect(validateNewContextArgs({ rationale: "r", preserve: "" }).ok).toBe(false);
  });

  it("receipts carry the window + remaining budget; refusals are typed one-liners", () => {
    const receipt = newContextReceipt(2, AGENT_ROTATION_CAP - 1);
    expect(receipt).toContain("[context rotated] window 2");
    expect(receipt).toContain(`9/${AGENT_ROTATION_CAP}`);
    for (const code of ["cap", "nothing-to-rotate", "already-rotated-this-turn", "deferred"] as const) {
      const text = newContextRefusal(code, "why");
      expect(text.startsWith("new_context:")).toBe(true);
      expect(text).toContain("why");
    }
  });
});

describe("new_context loop integration (the port fires inside execute)", () => {
  it("a rotation lands the boundary, the receipt names the window, the event carries agentRotation", async () => {
    const box: NewContextPortBox = {};
    const state = rotationState(box, rotatableHistory());
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "subtask A done", preserve: "path X verified" } }] },
      { role: "assistant", content: "SUM: subtask A complete, key facts kept" }, // the summarizer call
      { role: "assistant", content: "continuing in the fresh window" }, // the post-rotation turn
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      contextRotation: { port: box, rotationsUsed: 0 },
    }));
    // The compacted event: agent-rotation trigger, window 2 (markers 1 + 1 —
    // the independent numbering, no 125b window chain involved).
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.trigger).toBe("agent-rotation");
    expect(compacted[0]?.agentRotation).toEqual({ window: 2, rationale: "subtask A done" });
    expect(compacted[0]?.tier).toBe(2);
    expect(compacted[0]?.summaryMessage?.content).toContain("[context rotated by agent: subtask A done]");
    // The receipt the model read names the window and is NOT an error.
    const receipt = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc1");
    expect(receipt?.isError).not.toBe(true);
    expect(receipt?.content).toContain("[context rotated] window 2");
    expect(receipt?.content).toContain(`剩余模型侧轮转额度：${AGENT_ROTATION_CAP - 1}/${AGENT_ROTATION_CAP}`);
    // The new context's first message IS the rotated summary (preserve aboard).
    expect(state.messages[0]?.content).toContain("[context rotated by agent: subtask A done]");
    expect(state.messages[0]?.content).toContain("path X verified");
    // Pairing survived: the receipt follows its assistant call; the run completed.
    expect(state.messages.at(-1)?.content).toContain("continuing in the fresh window");
  });

  it("the cap refuses honestly: nothing fires, nothing is counted, the receipt is a typed error", async () => {
    const box: NewContextPortBox = {};
    const state = rotationState(box, rotatableHistory());
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "r" } }] },
      { role: "assistant", content: "fine, continuing without rotating" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      contextRotation: { port: box, rotationsUsed: AGENT_ROTATION_CAP },
    }));
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    const receipt = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc1");
    expect(receipt?.isError).toBe(true);
    expect(receipt?.content).toContain("额度已用完");
    // No summary marker landed — the history is untouched by a boundary.
    expect(countSummaryMarkers(state.messages)).toBe(0);
  });

  it("one rotation per turn: a second new_context call in the SAME batch refuses", async () => {
    const box: NewContextPortBox = {};
    const state = rotationState(box, rotatableHistory());
    const model = createScriptedModel([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "nc1", name: "new_context", arguments: { rationale: "first" } },
          { id: "nc2", name: "new_context", arguments: { rationale: "second" } },
        ],
      },
      { role: "assistant", content: "SUM: rotated once" }, // nc1's summarizer
      { role: "assistant", content: "done after one rotation" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      contextRotation: { port: box, rotationsUsed: 0 },
    }));
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted).toHaveLength(1);
    const refused = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc2");
    expect(refused?.isError).toBe(true);
    expect(refused?.content).toContain("本轮已经轮转过");
    // Budget honesty: only ONE fire consumed.
    expect(compacted[0]?.agentRotation?.rationale).toBe("first");
  });

  it("independent window numbering: a PRIOR harness boundary counts (no 125b chain state exists)", async () => {
    const box: NewContextPortBox = {};
    // A history that already carries one frozen summary (an earlier threshold
    // compaction) — the rotation's window must be 3 (markers 2 + 1), derived
    // purely from the chain, not from any window-identity object.
    const history: AgentMessage[] = [
      { role: "user", content: `${SUMMARY_MARKER} earlier threshold boundary\nbody` },
      ...rotatableHistory(),
    ];
    expect(compatableSpanGuard(history)).toBe(true);
    const state = rotationState(box, history);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "r" } }] },
      { role: "assistant", content: "SUM: second boundary" },
      { role: "assistant", content: "ok" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      contextRotation: { port: box, rotationsUsed: 1 },
    }));
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted[0]?.agentRotation?.window).toBe(3);
    const receipt = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc1");
    expect(receipt?.content).toContain("window 3");
    expect(receipt?.content).toContain(`剩余模型侧轮转额度：${AGENT_ROTATION_CAP - 2}/${AGENT_ROTATION_CAP}`);
  });

  it("nothing to rotate (early window): typed refusal, budget untouched", async () => {
    const box: NewContextPortBox = {};
    const short: AgentMessage[] = [
      { role: "user", content: "hi" },
      call("a1", "read_file", { path: "a" }),
      result("a1", "read_file", "d"),
    ];
    const state = rotationState(box, short);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "r" } }] },
      { role: "assistant", content: "understood, staying put" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      contextRotation: { port: box, rotationsUsed: 0 },
    }));
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    const receipt = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc1");
    expect(receipt?.isError).toBe(true);
    expect(receipt?.content).toContain("没有可轮转的内容");
  });

  it("an unwired box (no loop seam) fail-closes: the tool refuses, the run continues", async () => {
    const box: NewContextPortBox = {};
    const state = rotationState(box, rotatableHistory());
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "r" } }] },
      { role: "assistant", content: "carrying on" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 200_000 },
      // NO contextRotation seam — an unwired frontend.
    }));
    expect(events.filter((e) => e.type === "compacted")).toHaveLength(0);
    const receipt = state.messages.find((m) => m.role === "tool" && m.toolCallId === "nc1");
    expect(receipt?.isError).toBe(true);
    expect(receipt?.content).toContain("未接线");
  });

  it("a rotation SUBSUMES an armed pendingCompaction (no second boundary, no deferred noise)", async () => {
    const box: NewContextPortBox = {};
    // A heavy history inside the APPROACHING band: occupancy ≥ 0.8×window
    // (pendingCompaction arms at the turn top) but < threshold+8k (no
    // immediate compact). The rotation then fires mid-turn; the turn
    // boundary must NOT re-deliberate a second compaction.
    // Sizing: 3×70k chars ≈ 52k tokens vs window 60k → threshold 48k ≤ 52k
    // < 56k (the band's top) — armed, not immediate.
    const big = "x".repeat(70_000);
    const heavy: AgentMessage[] = [
      { role: "user", content: "heavy task" },
      call("a1", "read_file", { path: "a" }),
      result("a1", "read_file", big),
      call("a2", "read_file", { path: "b" }),
      result("a2", "read_file", big),
      call("a3", "read_file", { path: "c" }),
      result("a3", "read_file", big),
      { role: "user", content: "continue" },
    ];
    const state = rotationState(box, heavy);
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "nc1", name: "new_context", arguments: { rationale: "r" } }] },
      { role: "assistant", content: "SUM: heavy span summarized" },
      { role: "assistant", content: "done" },
    ]);
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 6,
      compaction: { contextWindowTokens: 60_000 },
      contextRotation: { port: box, rotationsUsed: 0 },
    }));
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.trigger).toBe("agent-rotation");
    // The armed pendingCompaction was consumed BY the rotation — no
    // compact_deferred deliberation follows it at the turn boundary.
    expect(events.filter((e) => e.type === "compact_deferred")).toHaveLength(0);
  });
});

/** The independent-numbering fixture's own guard: the span really is rotatable. */
function compatableSpanGuard(history: AgentMessage[]): boolean {
  return compactableSpan(history, 6) !== null;
}
