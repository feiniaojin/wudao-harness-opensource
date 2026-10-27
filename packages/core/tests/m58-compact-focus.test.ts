// M58 §C#2 (core side) — the tier-2 summarizer's optional focus and
// compactInstructions options (woven into the summary instruction; the
// dual-summarizer structure is unchanged) and the session reasoning_effort
// riding the tier-2 request through ModelInput.reasoningEffort. The CLI-side
// parsing of `/compact focus …` and of the WUDAO.md `## Compact Instructions`
// section lands in a later batch — this pack pins the OPTIONS CONTRACT.
import { describe, it, expect } from "vitest";
import { tier2Compact, dualTier2Compact, manualCompact, dualSummaryPartition, SUMMARY_MARKER } from "../src/compaction.js";
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput } from "../src/index.js";

const call = (id: string): AgentMessage => ({
  role: "assistant",
  content: "",
  toolCalls: [{ id, name: "read_file", arguments: { path: "a" } }],
});
const result = (id: string, content: string): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name: "read_file",
  content,
});

const MESSAGES: AgentMessage[] = [
  { role: "user", content: "task one " + "x".repeat(400) },
  { role: "assistant", content: "answer one " + "y".repeat(400) },
  { role: "user", content: "go" },
];

// ω-5b (I22): a span with NEITHER a board NOR a user message has nothing to
// derive — the byte-stable status-quo escape (autoTaskFocus → undefined).
const NO_USER_MESSAGES: AgentMessage[] = [
  call("c0"),
  result("c0", "r".repeat(1200)),
  { role: "assistant", content: "working" },
];

const STATUS_QUO_INSTRUCTION =
  "Summarize the conversation above for continuation (max 300 words, preserving key facts, decisions, file paths, and open tasks). Always mention: the current in-progress todo item and the files currently being edited.";

// 113-B1: the kept-tail recency anchor block, as the instruction's LAST rider.
// Byte-pin shape (the pins below stay byte-exact; the anchor is part of the
// contract now — it rides whenever the boundary kept an assistant text).
const anchorBlock = (text: string) =>
  `\nRecent kept-context anchor (the newest message retained after the compacted span; the kept messages that follow this summary are NEWER than it and authoritative over it):\n<recent-state-anchor>\n${text}\n</recent-state-anchor>`;

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

describe("tier-2 focus / compactInstructions / reasoningEffort (M58 §C#2 core)", () => {
  it("without options the instruction now carries the DERIVED focus (ω-5b I22 default ON); no effort rider", async () => {
    const model = capturingModel();
    // 波次 7 #38: these tests assert the LLM instruction seam; MESSAGES is a
    // thin span, so the zero-LLM digest gate would skip the model call.
    await tier2Compact(MESSAGES, model, { keepRecent: 1, zeroLlmDigest: false });
    expect(model.inputs).toHaveLength(1);
    // keepRecent 1 → the span is the first two messages; its first user
    // message is the 400-char task, capped at 200 by the derivation.
    expect(lastInstruction(model)).toBe(
      // keepRecent 1 + the stub floor → span [u task], kept tail [a answer,
      // u go]: the derived focus from the span's first user + the recency
      // anchor from the kept tail's latest assistant text (113-B1).
      `${STATUS_QUO_INSTRUCTION}\nFocus on: task one ${"x".repeat(191)}${anchorBlock(`answer one ${"y".repeat(400)}`)}`,
    );
    expect(model.inputs[0]?.reasoningEffort).toBeUndefined();
  });

  it("with NO derivable focus (no user, no board) the instruction stays byte-identical to the status quo plus the anchor rider", async () => {
    const model = capturingModel();
    await tier2Compact(NO_USER_MESSAGES, model, { keepRecent: 1 });
    // 113-B1: no derivable focus stays focus-free, but the kept tail's
    // assistant text ("working") still anchors — the rider is unconditional
    // when a kept assistant text exists, focus was never its gate.
    expect(lastInstruction(model)).toBe(`${STATUS_QUO_INSTRUCTION}${anchorBlock("working")}`);
    // And the composed message carries no Task line (today's bytes).
    const out = await tier2Compact(NO_USER_MESSAGES, capturingModel(), { keepRecent: 1 });
    expect(out!.summaryMessage.content.startsWith(`${SUMMARY_MARKER} SUMMARY\n`)).toBe(true);
  });

  it("weaves focus and compactInstructions into the summary instruction", async () => {
    const model = capturingModel();
    await tier2Compact(MESSAGES, model, {
      keepRecent: 1,
      focus: "the auth refactor decisions",
      compactInstructions: "always preserve file paths verbatim",
      zeroLlmDigest: false, // #38: assert the LLM instruction, not the digest
    });
    const instruction = lastInstruction(model);
    expect(instruction.startsWith(STATUS_QUO_INSTRUCTION)).toBe(true);
    expect(instruction).toContain("Focus on: the auth refactor decisions");
    expect(instruction).toContain("Compact instructions: always preserve file paths verbatim");
    // Focus precedes the standing instructions (stable rider order).
    expect(instruction.indexOf("Focus on:")).toBeLessThan(instruction.indexOf("Compact instructions:"));
    // The replayed PREFIX above the instruction is untouched by the riders.
    const replayed = model.inputs[0]?.messages.slice(0, -1) ?? [];
    expect(replayed.some((m) => m.content.includes("task one"))).toBe(true);
  });

  it("empty strings degrade to the DERIVED focus (an empty explicit focus is no focus — ω-5b I22)", async () => {
    const model = capturingModel();
    await tier2Compact(MESSAGES, model, { keepRecent: 1, focus: "", compactInstructions: "", zeroLlmDigest: false });
    expect(lastInstruction(model)).toBe(
      `${STATUS_QUO_INSTRUCTION}\nFocus on: task one ${"x".repeat(191)}${anchorBlock(`answer one ${"y".repeat(400)}`)}`,
    );
  });

  it("passes the session reasoning_effort through on the tier-2 request", async () => {
    const model = capturingModel();
    await tier2Compact(MESSAGES, model, { keepRecent: 1, reasoningEffort: "high", zeroLlmDigest: false });
    expect(model.inputs[0]?.reasoningEffort).toBe("high");
  });

  it("the dual summarizer carries the same riders into BOTH halves (structure unchanged)", async () => {
    const big = "y".repeat(4000);
    const turn: AgentMessage[] = [
      { role: "user", content: "do the huge thing" },
      call("c0"),
      result("c0", big),
      call("c1"),
      result("c1", big),
      { role: "assistant", content: "working" },
      { role: "user", content: "final tail" },
    ];
    expect(dualSummaryPartition(turn, { keepRecent: 2, turnPrefixChars: 9000 })).not.toBeNull();
    const model = capturingModel();
    const out = await dualTier2Compact(turn, model, {
      keepRecent: 2,
      turnPrefixChars: 9000,
      focus: "the failing test",
      compactInstructions: "keep the repro steps",
      reasoningEffort: "max",
    });
    expect(out).not.toBeNull();
    // One summary call per non-empty half, each carrying the riders.
    expect(model.inputs.length).toBe(2);
    for (const input of model.inputs) {
      const instruction = input.messages[input.messages.length - 1]?.content ?? "";
      expect(instruction).toContain("Focus on: the failing test");
      expect(instruction).toContain("Compact instructions: keep the repro steps");
      expect(input.reasoningEffort).toBe("max");
    }
    // The merged message keeps the dual shape (two parts, one marker).
    expect(out!.messages[0]?.content).toContain("[turn summary]");
  });

  it("manualCompact forwards the options (the /compact driver passes them through)", async () => {
    const model = capturingModel();
    const out = await manualCompact(
      { systemPrompt: "s", tools: [], messages: MESSAGES, model },
      { keepRecent: 1, focus: "open questions only", compactInstructions: "be terse", reasoningEffort: "low", zeroLlmDigest: false },
    );
    expect(out).not.toBeNull();
    expect(lastInstruction(model)).toContain("Focus on: open questions only");
    expect(lastInstruction(model)).toContain("Compact instructions: be terse");
    expect(model.inputs[0]?.reasoningEffort).toBe("low");
  });
});

// M58-D (CLI-side close-out) — the STANDING rider through the LOOP: auto/
// boundary/reactive compactions weave LoopOptions.compaction.compactInstructions
// into the tier-2 summary instruction exactly like the manual path.
import { runAgentLoop } from "../src/index.js";
import type { AgentState, LoopEvent, Tool } from "../src/index.js";

describe("loop auto-compaction carries the standing compactInstructions (M58 §C#2)", () => {
  /** Drive a threshold-triggered tier-2 compaction through the REAL loop and
   *  return the summarizer call's ModelInput. PROSE history (microcompact
   *  only stubs tool results, the clear tier only huge ones) so the trigger
   *  deterministically reaches the tier-2 LLM summary. */
  const runTier2ThroughLoop = async (
    compaction: { contextWindowTokens: number; keepRecent: number; compactInstructions?: string; reasoningEffort?: string },
  ): Promise<ModelInput | undefined> => {
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
        if (n === 2) return { role: "assistant", content: "SUMMARY" }; // the tier-2 summary call
        return { role: "assistant", content: "done" };
      },
    };
    const state: AgentState = { systemPrompt: "s", messages: [...seed, { role: "user", content: "go" }], tools: [echo], status: "idle" };
    const events: LoopEvent[] = [];
    const gen = runAgentLoop(state, model, { maxTurns: 6, gates: { todo: false, verify: false }, compaction });
    for (;;) {
      const r = await gen.next();
      if (r.done) break;
      events.push(r.value);
    }
    const compacted = events.find((e) => e.type === "compacted");
    if (compacted === undefined) throw new Error("test premise failed: no compaction fired");
    if (compacted.type === "compacted" && compacted.tier !== 2) {
      throw new Error(`test premise failed: expected the tier-2 LLM summary, got tier ${compacted.tier}`);
    }
    return inputs[1]; // the summary call
  };

  it("the standing rider reaches the summary instruction; unset adds nothing", async () => {
    const withRider = await runTier2ThroughLoop({
      contextWindowTokens: 1_500,
      keepRecent: 1,
      compactInstructions: "always preserve file paths verbatim",
    });
    const last = withRider?.messages[withRider.messages.length - 1];
    const instruction = last?.role === "user" ? last.content : "";
    expect(instruction).toContain("Compact instructions: always preserve file paths verbatim");
    // Without the rider the same fixture's instruction keeps the status-quo
    // bytes and the request carries no per-request effort override.
    const bare = await runTier2ThroughLoop({ contextWindowTokens: 1_500, keepRecent: 1 });
    const bareLast = bare?.messages[bare.messages.length - 1];
    expect(bareLast?.role === "user" ? bareLast.content : "").not.toContain("Compact instructions:");
    expect(bare?.reasoningEffort).toBeUndefined();
  });

  it("M58 §C#12: the session's reasoning_effort rides the tier-2 summarizer request; unset stays absent", async () => {
    const withEffort = await runTier2ThroughLoop({
      contextWindowTokens: 1_500,
      keepRecent: 1,
      compactInstructions: "be terse",
      reasoningEffort: "high",
    });
    expect(withEffort?.reasoningEffort).toBe("high");
    // An EMPTY string is treated as absent (byte-identical options, nothing
    // added) — the same guard the rider uses.
    const emptyEffort = await runTier2ThroughLoop({ contextWindowTokens: 1_500, keepRecent: 1, reasoningEffort: "" });
    expect(emptyEffort?.reasoningEffort).toBeUndefined();
  });
});
