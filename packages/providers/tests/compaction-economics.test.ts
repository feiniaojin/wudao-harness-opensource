// M24 Task 3: compaction economics — 0.8×window threshold, usage-driven
// occupancy (max(estimate, lastPromptTokens)), two-tier timing (approaching →
// deferred to the turn boundary; ≥ threshold+8k → immediate), and the
// tier-2 summary as a byte-level WARM REPLAY of the conversation it
// summarizes. Byte-prefix assertions use the one canonical serializer
// exported by @wudao/providers (core's test-only devDependency).
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { serializePrompt } from "../src/index.js";
import { runAgentLoop } from "@wudao/core";
import { createReadFileTool } from "@wudao/core";
import { createScriptedModel } from "@wudao/core";
import type { LoopEvent, Terminal } from "@wudao/core";
import type { ModelClient, ModelInput, ModelUsage } from "@wudao/core";
import type { AgentMessage, AgentState } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "fixtures", "sample.txt");

async function drain(
  gen: AsyncGenerator<LoopEvent, Terminal>,
): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

/** Scripted model that records every ModelInput (as a SNAPSHOT — the loop
 *  passes the live state.messages array) and optionally reports usage. */
function recordingModel(
  responses: readonly { role: "assistant"; content: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[] }[],
  usages: readonly ModelUsage[] = [],
): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput) {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const response = responses[i];
      const usage = usages[i];
      i += 1;
      if (!response) throw new Error("scripted responses exhausted");
      if (usage) input.onUsage?.(usage);
      return response;
    },
  };
}

const toolCallTurn = (id: string, path: string) => ({
  role: "assistant" as const,
  content: "",
  toolCalls: [{ id, name: "read_file", arguments: { path } }],
});

describe("compaction threshold (0.8 × contextWindowTokens)", () => {
  it("stays silent while occupancy is under the threshold", async () => {
    const model = recordingModel([
      toolCallTurn("r1", fixturePath),
      { role: "assistant", content: "done" },
    ]);
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "x".repeat(400) }, // ~100 tokens of content
        { role: "assistant", content: "y".repeat(400) },
      ],
      tools: [createReadFileTool()],
      status: "idle",
    };
    // threshold = 0.8 × 5000 = 4000 tokens; occupancy ≈ 200 → far under.
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 5000 },
    }));
    expect(events.some((e) => e.type === "compacted")).toBe(false);
    expect(state.messages.some((m) => m.content.includes("[compacted"))).toBe(false);
  });

  it("reserveTokens no longer shifts the trigger (deprecated)", async () => {
    const model = recordingModel([
      toolCallTurn("r1", fixturePath),
      { role: "assistant", content: "done" },
    ]);
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: "x".repeat(400) },
        { role: "assistant", content: "y".repeat(400) },
      ],
      tools: [createReadFileTool()],
      status: "idle",
    };
    // Even with a huge reserve, threshold stays 0.8 × 5000 = 4000 → under → silent.
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 5000, reserveTokens: 4900 },
    }));
    expect(events.some((e) => e.type === "compacted")).toBe(false);
  });
});

describe("two-tier timing (B5)", () => {
  // ~6k tokens of non-tool content: microcompact can't shrink it, occupancy
  // lands in the APPROACHING band for cw=6000 (threshold 4800, band < 12992).
  const bigHistory = (): AgentMessage[] => {
    const big = "z".repeat(3000);
    return [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
    ];
  };

  it("approaching band defers: the model call goes out on the FULL warm suffix, compaction lands at the turn boundary", async () => {
    const model = recordingModel([
      toolCallTurn("r1", fixturePath),
      { role: "assistant", content: "T2" },
      { role: "assistant", content: "done" },
    ]);
    const state: AgentState = {
      systemPrompt: "sys",
      messages: bigHistory(),
      tools: [createReadFileTool()],
      status: "idle",
    };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 6000, keepRecent: 2 },
    }));
    const types = events.map((e) => e.type);
    const firstCompacted = types.indexOf("compacted");
    expect(firstCompacted).toBeGreaterThan(-1);
    // The deferral contract: the compaction event comes AFTER this turn's
    // tool phase (turn_finished) and BEFORE the next model call starts.
    expect(types.indexOf("turn_finished")).toBeLessThan(firstCompacted);
    expect(types.indexOf("model_call_started", types.indexOf("turn_finished"))).toBeGreaterThan(firstCompacted);
    // The turn-0 request carried the full history VERBATIM (warm suffix): the
    // compacted summary is NOT in it, and neither is any stub.
    const r0 = model.inputs[0];
    expect(r0?.messages).toHaveLength(8);
    expect(r0?.messages.some((m) => m.content.includes("[compacted"))).toBe(false);
  });

  it("immediate band (≥ threshold + 8k) compacts BEFORE the model call", async () => {
    const model = recordingModel([
      { role: "assistant", content: "S" },  // consumed by the tier-2 summarizer
      { role: "assistant", content: "done" },
    ]);
    // ~14k tokens: threshold 4800 + 8192 = 12992 < 14000 → immediate.
    const big = "z".repeat(14000);
    const state: AgentState = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
      ],
      tools: [],
      status: "idle",
    };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 6000, keepRecent: 1 },
    }));
    const types = events.map((e) => e.type);
    const firstCompacted = types.indexOf("compacted");
    expect(firstCompacted).toBeGreaterThan(-1);
    // Compacted BEFORE the first model call even started.
    expect(firstCompacted).toBeLessThan(types.indexOf("model_call_started"));
    // generate() order: [S summary replay, R0 rebuilt]. The first REAL
    // request the loop made already carries the summary marker.
    expect(model.inputs).toHaveLength(2);
    expect(model.inputs[0]?.messages.some((m) => m.content.includes("[compacted summary]"))).toBe(false);
    expect(model.inputs[1]?.messages.some((m) => m.content.includes("[compacted summary]"))).toBe(true);
  });

  it("usage-driven: real lastPromptTokens beats a small estimate (B4)", async () => {
    // Estimate stays tiny (short messages + one big tool result), but the
    // provider reports a real 20k-token prompt on turn 0 → at turn 1 the
    // occupancy check uses max(estimate, 20000) → immediate compaction.
    //
    // ω-3b amendment (report 88): the big_echo result is UNSEEN at that check
    // (it is the active turn's own batch — no assistant after it), so the stub
    // floor binds: floorCutoff = min(alignedCutoff=3, stubFloor=1) = 1 keeps it
    // out of tier-0/1 AND out of the tier-2 span. Occupancy stays high, tier-1
    // cannot shrink, and the cheapest-first pipeline escalates to the tier-2
    // summarizer — which consumes a scripted response. Script order mirrors
    // the immediate-band test above: [turn-0 real call, "S" summarizer,
    // turn-1 "done"]. Without the floor the summarizer call would not exist
    // (tier-1 would stub the 8000-char result instead) — the pins below hold
    // the fixture to whichever regime is real.
    const bigTool = {
      name: "big_echo",
      description: "returns a big string",
      parameters: { type: "object" as const, properties: {}, additionalProperties: false },
      execute: async () => ({ content: "x".repeat(8000) }),
    };
    const model = recordingModel(
      [
        { role: "assistant", content: "", toolCalls: [{ id: "b1", name: "big_echo", arguments: {} }] },
        { role: "assistant", content: "S" },  // consumed by the tier-2 summarizer
        { role: "assistant", content: "done" },
      ],
      [{ promptTokens: 20000, cacheHitTokens: 0, cacheMissTokens: 20000 }],
    );
    const state: AgentState = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [bigTool],
      status: "idle",
    };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      // #38: the span is one short user message → the digest front stage would
      // swallow the summarizer slot this test pins (3 calls, LLM path).
      compaction: { contextWindowTokens: 6000, keepRecent: 0, zeroLlmDigest: false },
    }));
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted.length).toBeGreaterThan(0);
    // And the compaction landed before turn 1's model call (immediate band).
    const types = events.map((e) => e.type);
    expect(types.indexOf("compacted")).toBeLessThan(types.indexOf("model_call_started", types.indexOf("turn_finished")));
    // ω-3b pins (report 88) — the floor's own regime, so this fixture cannot
    // silently regress to the pre-floor over-stub. generate() order:
    // [turn-0 real call, S summarizer, turn-1 post-compaction "done"].
    expect(model.inputs).toHaveLength(3);
    // (a) Escalation: the floor empties tier-0/1 (nothing before the last
    // assistant is stubbable — the span is one short user message), so exactly
    // ONE summarizer-shaped call fires (querySource "summarizer",
    // compaction.ts summarizeSpan) and the compacted event carries the
    // escalated tier-2 / immediate shape (loop.ts doCompact).
    expect(model.inputs.filter((i) => i.querySource === "summarizer")).toHaveLength(1);
    expect(model.inputs[1]?.querySource).toBe("summarizer");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.tier).toBe(2);
    expect(compacted[0]?.trigger).toBe("immediate");
    // (b) Survival: the unseen big_echo result rides the post-compaction
    // request BYTE-INTACT — no stub preview, no cleared marker. This is the
    // floor working as designed ("never stub a result the model hasn't
    // responded to"), pinned across the core boundary.
    const survivor = model.inputs[2]?.messages.find((m) => m.role === "tool" && m.name === "big_echo");
    expect(survivor?.content).toBe("x".repeat(8000));
    expect(survivor?.content.startsWith("[compacted")).toBe(false);
  });
});

describe("tier-2 warm replay (dsh-style)", () => {
  it("the summary call replays the conversation's leading bytes, with one trailing instruction", async () => {
    const model = recordingModel([
      toolCallTurn("r1", fixturePath),
      { role: "assistant", content: "WARM-SUMMARY" },
      { role: "assistant", content: "done" },
    ]);
    const big = "z".repeat(3000);
    const state: AgentState = {
      systemPrompt: "THE-SYSTEM-PROMPT",
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
      ],
      tools: [createReadFileTool()],
      status: "idle",
    };
    await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 6000, keepRecent: 2 },
    }));

    // generate() order: [R0 real request, S summary replay, R1 post-compaction].
    expect(model.inputs.length).toBe(3);
    const [r0, s, r1] = model.inputs as const;
    // Same system prompt + same tool array — byte-identical header.
    expect(s.systemPrompt).toBe(r0.systemPrompt);
    expect(s.tools).toEqual(r0.tools);
    // The replay's span section is a byte-prefix of the real request:
    // serializePrompt(S minus the trailing instruction) ⊂ serializePrompt(R0).
    const spanPart = serializePrompt({ ...s, messages: s.messages.slice(0, -1) });
    expect(serializePrompt(r0).startsWith(spanPart)).toBe(true);
    // The one appended message is the summarization instruction.
    const last = s.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content).toContain("Summarize the conversation above");
    // The post-compaction request is rebuilt from the summary marker.
    expect(r1.messages[0]?.content.includes("[compacted summary]")).toBe(true);
  });

  it("pairing-safe: the replay never ends on an assistant tool_call whose results were cut", async () => {
    const seen: ModelInput[] = [];
    const scripted = createScriptedModel([
      toolCallTurn("r1", fixturePath),
      { role: "assistant", content: "S" },
      { role: "assistant", content: "done" },
    ]);
    const model: ModelClient = {
      generate: async (input: ModelInput) => {
        seen.push(input);
        return scripted.generate(input);
      },
    };
    const big = "z".repeat(3000);
    const state: AgentState = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: big },
        { role: "assistant", content: "", toolCalls: [{ id: "old", name: "read_file", arguments: { path: "x" } }] },
        { role: "tool", toolCallId: "old", name: "read_file", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
        { role: "user", content: big },
        { role: "assistant", content: big },
      ],
      tools: [createReadFileTool()],
      status: "idle",
    };
    await drain(runAgentLoop(state, model, {
      maxTurns: 5,
      compaction: { contextWindowTokens: 6000, keepRecent: 2 },
    }));
    const s = seen[1];
    expect(s).toBeDefined();
    // No trailing assistant-with-toolCalls in the replay (provider-legal tail).
    const last = s!.messages.at(-2); // last span message before the instruction
    expect(last?.role === "assistant" && last.toolCalls && last.toolCalls.length > 0).toBe(false);
  });
});
