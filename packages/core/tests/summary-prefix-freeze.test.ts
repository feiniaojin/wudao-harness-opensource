// 120-a A2 (CodeWhale #6540 形) — the summary-call byte-prefix freeze
// contract, unified across the whole summary-family census. CodeWhale's live
// incident: a 219K-token compaction-summary call silently DROPPED its
// reasoning tier and hit 0% prefix cache — every dimension of the request
// that drifts from the parent turn's (system, tools, message prefix,
// reasoning tier) forfeits the warm prefix the summary was supposed to ride.
// wudao's compaction-summarizer already carries the tier (M58 §C#12 +
// warm-replay M24); this file pins that EVERY core-side summary-class call
// keeps the "parent prefix bytes + declared tail" shape, with drift reports
// that NAME the drifted field (break attribution — which field, which index).
//
// Census (core side; the CLI side lives in cli/tests/summary-prefix-freeze):
//   autocompact threshold    the loop's tier-2 summarizeSpan (runAgentLoop)
//   tier2Compact LLM lane    the same summarizeSpan via the exported seam
//   dualTier2Compact         history half (full prefix) + turn half (the
//                            turn's own prefix — restarts at the turn
//                            boundary by M52 §1 design; system+tools frozen)
//   reflection challenger    loop-reflection's one verdict call (deliberate
//                            effort omission pinned as part of the contract)
// The static tier-2 / digest lanes make NO model call — nothing to freeze.
// No new probe here (that is a later arc): this is the contract pin only.
import { describe, it, expect } from "vitest";
import { summarizeSpan, tier2Compact, runAgentLoop, buildTool, summaryPrefixDrift, floorCutoff } from "../src/index.js";
import { dualTier2Compact } from "../src/compaction.js";
import { runReflectionFork } from "../src/loop-reflection.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, ModelClient, ModelInput } from "../src/index.js";
import type { PrefixFreezeContract } from "../src/index.js";

// ---------------------------------------------------------------------------
// The assertion shim: empty drift list = frozen. Written via toEqual([]) so a
// red run prints the attribution lines verbatim (the field that drifted).
// ---------------------------------------------------------------------------

function expectFrozen(parent: ModelInput, child: ModelInput, contract: PrefixFreezeContract): void {
  const drift = summaryPrefixDrift(parent, child, contract);
  expect(drift, `${contract.label} broke the summary prefix-freeze contract:\n${drift.join("\n")}`).toEqual([]);
}

/** A recording model: every ModelInput captured, answers scripted in order. */
function recordingModel(respond: (input: ModelInput, call: number) => AssistantMessage): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let call = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push(input);
      call += 1;
      return respond(input, call);
    },
  };
}

const SYSTEM = "you are the parent turn's system prompt (byte-stable)";
const TOOLS = [
  { name: "read_file", description: "reads a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
  { name: "shell", description: "runs a command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } },
];

/** A narrative-dense multi-pair history (over the #38 digest caps, under the
 *  24 000-char replay cap → the LLM lane replays the FULL leading slice). */
const denseHistory = (): AgentMessage[] => [
  { role: "user", content: "task 0 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
  { role: "user", content: "task 1 " + "x".repeat(2000) },
  { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
  { role: "user", content: "go" },
];

// ---------------------------------------------------------------------------
// The contract helper itself — drift must REPORT, naming the drifted field
// ---------------------------------------------------------------------------

describe("summaryPrefixDrift — break attribution (the (c) clause)", () => {
  const parent: ModelInput = {
    systemPrompt: SYSTEM,
    tools: TOOLS,
    messages: denseHistory(),
    reasoningEffort: undefined,
  };
  const frozenChild: ModelInput = {
    ...parent,
    messages: [...parent.messages.slice(0, 4), { role: "user", content: "Summarize the conversation above." }],
    reasoningEffort: "high",
  };
  const contract: PrefixFreezeContract = { label: "fixture member", tailCount: 1, expectedEffort: "high" };

  it("a frozen parent-prefix + tail request reports zero drift", () => {
    expect(summaryPrefixDrift(parent, frozenChild, contract)).toEqual([]);
  });

  it("a drifted system prompt names systemPrompt (cache lost from byte 0)", () => {
    const drift = summaryPrefixDrift(parent, { ...frozenChild, systemPrompt: "other system" }, contract);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("systemPrompt");
    expect(drift[0]).toContain("byte 0");
  });

  it("a drifted tool table names tools (the block above the message prefix)", () => {
    const drift = summaryPrefixDrift(parent, { ...frozenChild, tools: [...TOOLS, TOOLS[0]!] }, contract);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("tools");
  });

  it("a rewritten replayed message names messages[i] with its index", () => {
    const messages = [...frozenChild.messages];
    messages[1] = { role: "assistant", content: "REWRITTEN — not the parent turn's bytes" };
    const drift = summaryPrefixDrift(parent, { ...frozenChild, messages }, contract);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("messages[1]");
  });

  it("a DROPPED reasoning tier names reasoningEffort and cites the CodeWhale shape", () => {
    // The exact #6540 failure: the summary request lost the session's tier.
    const drift = summaryPrefixDrift(parent, { ...frozenChild, reasoningEffort: undefined }, contract);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("reasoningEffort");
    expect(drift[0]).toContain("session declares");
  });

  it("a tier the session never declared drifts too (both directions)", () => {
    const drift = summaryPrefixDrift(parent, frozenChild, { ...contract, expectedEffort: undefined });
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("reasoningEffort");
  });

  it("a tail-count violation names the shape (not a prefix + declared tail)", () => {
    const drift = summaryPrefixDrift(parent, { ...frozenChild, messages: [{ role: "user", content: "cold summary request" }] }, contract);
    expect(drift.some((line) => line.startsWith("messages:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Census member: summarizeSpan — the ONE model call under autocompact,
// tier2Compact's LLM lane, the dual halves, and manual /compact.
// ---------------------------------------------------------------------------

describe("prefix-freeze census (core)", () => {
  it("summarizeSpan: parent prefix + exactly one trailing instruction, session tier riding", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "S" }));
    const messages = denseHistory();
    const parent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages };
    await summarizeSpan({ ...parent, reasoningEffort: "high" }, model);
    expect(model.inputs).toHaveLength(1);
    expectFrozen(parent, model.inputs[0]!, { label: "summarizeSpan", tailCount: 1, expectedEffort: "high" });
    // The declared tail is exactly ONE trailing USER instruction.
    const tail = model.inputs[0]!.messages.at(-1)!;
    expect(tail.role).toBe("user");
    expect(tail.content).toContain("Summarize the conversation above");
  });

  it("summarizeSpan: no declared session tier → the request carries none (deliberate omission)", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "S" }));
    const parent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages: denseHistory() };
    await summarizeSpan(parent, model);
    expectFrozen(parent, model.inputs[0]!, { label: "summarizeSpan (no tier)", tailCount: 1 });
  });

  it("tier2Compact LLM lane: the summary request freezes against the compacted conversation", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "S" }));
    const messages = denseHistory();
    const parent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages };
    const out = await tier2Compact(messages, model, {
      keepRecent: 1,
      zeroLlmDigest: false, // force the LLM lane (the digest lane makes no call)
      systemPrompt: SYSTEM,
      tools: TOOLS,
      reasoningEffort: "high",
    });
    expect(out).not.toBeNull();
    expect(model.inputs).toHaveLength(1);
    expectFrozen(parent, model.inputs[0]!, { label: "tier2Compact LLM lane", tailCount: 1, expectedEffort: "high" });
  });

  it("dualTier2Compact: the history half freezes the FULL parent prefix; the turn half restarts at the partition boundary with system+tools still frozen", async () => {
    const model = recordingModel(() => ({ role: "assistant", content: "S" }));
    // One oversized turn after a short history: standard tier-2 has no span,
    // the dual splits history / turn-prefix / kept tail (M52 §1). The split
    // boundary is the production floorCutoff (stub-floor aware) — the test
    // reads it, not a hand-rolled guess.
    const messages: AgentMessage[] = [
      { role: "user", content: "task 0 " + "x".repeat(2000) },
      { role: "assistant", content: "answer 0 " + "y".repeat(2000) },
      { role: "user", content: "big ask " + "t".repeat(20_000) },
      { role: "assistant", content: "big answer " + "u".repeat(20_000) },
      { role: "user", content: "final nudge" },
    ];
    const parent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages };
    const out = await dualTier2Compact(messages, model, {
      keepRecent: 1,
      zeroLlmDigest: false,
      systemPrompt: SYSTEM,
      tools: TOOLS,
      reasoningEffort: "high",
    });
    expect(out).not.toBeNull();
    expect(model.inputs).toHaveLength(2);
    // Half 1 — the history replay IS a leading slice of the whole parent list.
    expectFrozen(parent, model.inputs[0]!, { label: "dual history half", tailCount: 1, expectedEffort: "high" });
    // Half 2 — the turn-prefix replay restarts at the partition boundary (by
    // design, M52 §1: only the system prompt / tool table / tier bytes are
    // shared with the parent request). Its freeze parent is the post-cutoff
    // WINDOW — the region the partition calls the turn — so the pinned
    // invariant is "a leading slice of the window + declared tail, system /
    // tools / tier bytes identical to the parent's".
    const cutoff = floorCutoff(messages, 1);
    const turnParent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages: messages.slice(cutoff) };
    expectFrozen(turnParent, model.inputs[1]!, { label: "dual turn-prefix half", tailCount: 1, expectedEffort: "high" });
    expect(model.inputs[1]!.systemPrompt).toBe(SYSTEM);
    expect(model.inputs[1]!.tools).toEqual(TOOLS);
  });

  it("runReflectionFork (评审门): the challenger freezes the run's prefix + one brief, tier deliberately omitted", async () => {
    const model = recordingModel(() => ({
      role: "assistant",
      content: "VERDICT: stuck\nRATIONALE: same call\nDIRECTIVE: none",
    }));
    const messages = denseHistory();
    const parent: ModelInput = { systemPrompt: SYSTEM, tools: TOOLS, messages };
    await runReflectionFork(model, {
      systemPrompt: SYSTEM,
      tools: TOOLS,
      messages,
      evidence: "call #3 repeated",
      digest: "line",
      timeoutMs: 1_000,
    });
    expect(model.inputs).toHaveLength(1);
    expectFrozen(parent, model.inputs[0]!, { label: "reflection challenger", tailCount: 1 });
  });

  it("autocompact (runAgentLoop threshold): the tier-2 summary call freezes against the pre-compaction turn request", async () => {
    const model = recordingModel((_input, call) => {
      // Call 1 is the summarizer (occupancy sits in the IMMEDIATE zone —
      // threshold+8k — so the tier-2 runs at the turn top, before the call);
      // call 2 answers the turn and ends the run.
      if (call === 1) return { role: "assistant", content: "SUMMARY" };
      return { role: "assistant", content: "done" };
    });
    // Big enough to land in the immediate zone (~21k tokens against a 1.5k
    // window): the compaction must run BEFORE the first model call.
    const bigHistory: AgentMessage[] = [];
    for (let i = 0; i < 20; i += 1) {
      bigHistory.push({ role: "user", content: `task ${i} ` + "x".repeat(2000) });
      bigHistory.push({ role: "assistant", content: `answer ${i} ` + "y".repeat(2000) });
    }
    bigHistory.push({ role: "user", content: "go" });
    const state: AgentState = {
      systemPrompt: SYSTEM,
      messages: bigHistory,
      tools: [buildTool({ name: "read_file", description: "reads", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }, async execute() { return { content: "FILE" }; } })],
      status: "idle",
    };
    const preCompactionMessages = [...state.messages];
    const drain = async (gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> => {
      const events: LoopEvent[] = [];
      for (;;) {
        const r = await gen.next();
        if (r.done) return events;
        events.push(r.value);
      }
    };
    const events = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { todo: false, verify: false },
      compaction: { contextWindowTokens: 1_500, keepRecent: 1, zeroLlmDigest: false, reasoningEffort: "high" },
    }));
    expect(events.find((e) => e.type === "compacted" && e.tier === 2)).toBeDefined();
    const summaryCall = model.inputs.find((i) => i.querySource === "summarizer");
    const turnCall = model.inputs.find((i) => i.querySource !== "summarizer");
    expect(summaryCall).toBeDefined();
    expect(turnCall).toBeDefined();
    // The parent reference is the request the loop WOULD have made without
    // compaction: its own system prompt + tool defs (read off the turn call —
    // the authoritative live values) + the pre-compaction message list.
    const parent: ModelInput = {
      systemPrompt: turnCall!.systemPrompt,
      tools: turnCall!.tools,
      messages: preCompactionMessages,
    };
    expectFrozen(parent, summaryCall!, { label: "autocompact threshold summarizer", tailCount: 1, expectedEffort: "high" });
  });
});
