// ω-3b — the unseen-tool-result stub floor (design 81). Nothing after the
// LAST assistant message may be stubbed/cleared/summarized by the routine
// compaction tiers: everything there is either the active turn's own tool
// results (never yet answered by the model) or user input (steers/nudges).
// The floor composes at four seams (clearTier, microcompact, compactableSpan,
// dualSummaryPartition history split) as min(alignedCutoff, stubFloor);
// alignedCutoff itself, emergencyDrop, and the dual turnPrefix growth stay
// untouched (D2/D3/D5 — pinned by T8 and the m52 unit tests).
import { describe, it, expect } from "vitest";
import {
  alignedCutoff,
  clearTier,
  CLEARED_MARKER,
  COMPACTION_STUB_PREFIX,
  dualSummaryPartition,
  emergencyDrop,
  EMERGENCY_DROP_PREFIX,
  floorCutoff,
  manualCompact,
  microcompact,
  staticTier2Compact,
  stubFloor,
  SUMMARY_MARKER,
  tier2Compact,
  messageEntryId,
} from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import { runAgentLoop } from "../src/loop.js";
import type { AgentMessage, AgentState, AssistantMessage, LoopEvent, Terminal } from "../src/index.js";
import { repairOrphanedToolCalls, UNAVAILABLE_TOOL_RESULT } from "../src/session/validate.js";
import type { Tool } from "../src/tool.js";

// The m52 helper shape (m52-compaction.test.ts:30-40).
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
/** One assistant message issuing a whole fan-out batch. */
const fanout = (ids: readonly string[]): AgentMessage => ({
  role: "assistant",
  content: "",
  toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: { path: id } })),
});
/** n SEEN (answered) call/result pairs of `size` chars each. */
const seenPairs = (n: number, size: number, tag = "s"): AgentMessage[] =>
  Array.from({ length: n }, (_, i) => [call(`${tag}${i}`), result(`${tag}${i}`, `${tag}${i}q`.repeat(Math.ceil(size / 3)))]).flat();

const FANOUT_IDS = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
/** The E1 tail: one assistant issuing an 8-call batch + its 8 big results. */
const e1Tail = (size: number): AgentMessage[] => [fanout(FANOUT_IDS), ...FANOUT_IDS.map((id) => result(id, `u${id}x`.repeat(Math.ceil(size / 4))))];

async function drain(gen: AsyncGenerator<LoopEvent, Terminal>): Promise<{ events: LoopEvent[]; terminal: Terminal }> {
  const events: LoopEvent[] = [];
  for (;;) {
    const { done, value } = await gen.next();
    if (done) return { events, terminal: value };
    events.push(value);
  }
}

// ---------------------------------------------------------------------------
// T1/T2 — the live over-stub shapes (design §2 E1/E2): the contiguous
// fan-out, with and without a trailing non-tool message.
// ---------------------------------------------------------------------------

describe("stubFloor / floorCutoff (ω-3b)", () => {
  it("stubFloor is the index of the last assistant message (any assistant), 0 when none", () => {
    expect(stubFloor([{ role: "user", content: "a" }])).toBe(0);
    expect(stubFloor([call("c0"), result("c0", "x"), { role: "user", content: "t" }])).toBe(0); // assistant at 0
    expect(stubFloor([{ role: "user", content: "a" }, call("c0"), result("c0", "x")])).toBe(1);
    // D1: a text-only assistant still marks "everything before me answered".
    expect(stubFloor([{ role: "user", content: "a" }, call("c0"), result("c0", "x"), { role: "assistant", content: "ack" }])).toBe(3);
    expect(floorCutoff([{ role: "user", content: "a" }, call("c0"), result("c0", "x")], 1)).toBe(1);
    // D5 pin: the WALK itself stays unclamped — it advances past the whole
    // terminal batch (18) even though the floor (9) disagrees. alignedCutoff
    // is the pairing primitive; the clamp lives in floorCutoff only.
    const e1: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(4, 2000), ...e1Tail(2000)];
    expect(alignedCutoff(e1, 6)).toBe(18);
    expect(floorCutoff(e1, 6)).toBe(9);
  });

  it("T1: terminal 8-result fan-out — microcompact leaves every unseen result byte-identical, seen pairs still stubbed", () => {
    const m: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(4, 2000), ...e1Tail(2000)];
    // len 18: raw cutoff 18−6=12 lands on T3 → the M52 walk advances to 18
    // (E1) — every unseen result a candidate pre-floor. Floor = idx(A fanout)
    // = 9 → cutoff 9: only the four SEEN results (indices 2,4,6,8) are
    // candidates.
    expect(floorCutoff(m, 6)).toBe(9);
    const out = microcompact(m); // default keepRecent 6, minChars 1000
    for (const i of [2, 4, 6, 8]) {
      expect((out[i] as { content?: string }).content?.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    }
    for (let i = 10; i <= 17; i += 1) expect(out[i]).toBe(m[i]); // T1..T8 verbatim
  });

  it("T1 (tier-0 face): the same shape at 31k — clearTier clears the seen pairs, not the unseen batch", () => {
    const m: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(4, 31_000), ...e1Tail(31_000)];
    const out = clearTier(m); // default keepRecent 6
    expect(out.cleared).toBe(4);
    for (let i = 10; i <= 17; i += 1) {
      expect(out.messages[i]).toBe(m[i]); // unseen 31k results untouched
      expect((out.messages[i] as { content: string }).content.length).toBeGreaterThan(30_000);
    }
  });

  it("T2: trailing steer (E2) — tier-0 and tier-1 both leave the unseen batch intact", () => {
    const steer: AgentMessage = { role: "user", content: "STEER: change of plan" };
    const mm: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(4, 2000), ...e1Tail(2000), steer];
    // len 19: raw 13 → walk stops AT the steer (index 18) → aligned 18 — the
    // walk cannot protect here (it only moves forward). Floor 9 clamps.
    expect(floorCutoff(mm, 6)).toBe(9);
    const out = microcompact(mm);
    for (let i = 10; i <= 17; i += 1) expect(out[i]).toBe(mm[i]);
    expect(out[18]).toBe(steer);
    expect((out[2] as { content?: string }).content?.startsWith(COMPACTION_STUB_PREFIX)).toBe(true); // seen region still stubbed

    const cm: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(4, 31_000), ...e1Tail(31_000), steer];
    const cleared = clearTier(cm);
    expect(cleared.cleared).toBe(4); // the clamp protects only past the floor
    for (let i = 10; i <= 17; i += 1) expect(cleared.messages[i]).toBe(cm[i]);
  });

  it("T3: seen batches stay stubbable (anti-over-protection) — only the floor's tail is exempt", () => {
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      fanout(["t1", "t2", "t3", "t4"]),
      ...["t1", "t2", "t3", "t4"].map((id) => result(id, "v".repeat(2000))),
      fanout(["t5", "t6"]),
      result("t5", "w".repeat(2000)),
      result("t6", "w".repeat(2000)),
    ];
    // len 9, keepRecent 2 → raw 7 lands on T5 → the walk advances to 9;
    // floor = idx(A₂) = 6 → cutoff 6: T1..T4 (indices 2-5) are candidates,
    // T5/T6 (7,8) are the last assistant's own (unseen) results.
    expect(floorCutoff(m, 2)).toBe(6);
    const out = microcompact(m, { keepRecent: 2 });
    for (const i of [2, 3, 4, 5]) {
      expect((out[i] as { content?: string }).content?.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    }
    expect(out[7]).toBe(m[7]);
    expect(out[8]).toBe(m[8]);
  });

  it("T4: degenerate lists — no assistant (floor 0) stubs nothing; a text-only assistant floor still permits stubbing its SEEN predecessors", async () => {
    // (a) no assistant at all: nothing is ever stubbable.
    const orphan: AgentMessage[] = [
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      result("t1", "o".repeat(2000)),
    ];
    expect(stubFloor(orphan)).toBe(0);
    expect(floorCutoff(orphan, 1)).toBe(0);
    const cleared = clearTier(orphan);
    expect(cleared.cleared).toBe(0);
    expect(cleared.messages[2]).toBe(orphan[2]);
    expect(microcompact(orphan)[2]).toBe(orphan[2]);
    expect(staticTier2Compact(orphan, { keepRecent: 1 })).toBeNull();
    await expect(tier2Compact(orphan, createScriptedModel([]), { keepRecent: 1 })).resolves.toBeNull();

    // (b) floor = idx(A₂ text) = 3 == aligned 3 → the SEEN result below it
    // stays a candidate (the floor never over-protects).
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("t1"),
      result("t1", "p".repeat(2000)),
      { role: "assistant", content: "ack — read it" },
    ];
    expect(stubFloor(m)).toBe(3);
    expect(floorCutoff(m, 1)).toBe(3);
    expect((microcompact(m, { keepRecent: 1 })[2] as { content: string }).content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
  });

  it("T5: tier-2 span clamp — staticTier2Compact summarizes the seen history, never the active batch", async () => {
    const A = fanout(FANOUT_IDS);
    const m: AgentMessage[] = [{ role: "user", content: "go" }, ...seenPairs(6, 2000), A, ...e1Tail(2000).slice(1)];
    // len 22: aligned walks to 22 (E1) → floor 13 → span [0,13) = the user +
    // six seen pairs; rest = [A, T1..T8] verbatim.
    const out = staticTier2Compact(m, { keepRecent: 6 });
    expect(out).not.toBeNull();
    expect(out!.messages.filter((x) => x.role === "user" && x.content.startsWith(SUMMARY_MARKER))).toHaveLength(1);
    expect(out!.messages).toHaveLength(10); // summary + A + T1..T8
    expect(out!.messages[1]).toBe(A);
    for (let i = 0; i < 8; i += 1) expect(out!.messages[2 + i]).toBe(m[14 + i]);
    expect(out!.retainedTail[0]).toBe(A);
    expect(out!.retainedTail).toHaveLength(9);

    // The manual compact records its boundary at the batch's assistant.
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const manual = await manualCompact({ systemPrompt: "s", tools: [], messages: m, model }, { keepRecent: 6 });
    expect(manual).not.toBeNull();
    expect(manual!.firstKeptEntryId).toBe(messageEntryId(A));
  });
});

// ---------------------------------------------------------------------------
// T6/T7 — the loop faces (scripted, no live model).
// ---------------------------------------------------------------------------

/** m58's scripted model: throws/answers per step, captures every input. */
type Step = { readonly kind: "error"; readonly err: Error } | { readonly kind: "ok"; readonly content: string };
function stepModel(steps: readonly Step[]): ModelClient & { calls: number; inputs: ModelInput[] } {
  let calls = 0;
  const inputs: ModelInput[] = [];
  return {
    get calls() {
      return calls;
    },
    get inputs() {
      return inputs;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      // Snapshot: the loop may keep appending to the live messages array.
      inputs.push({ ...input, messages: [...input.messages] });
      const step = steps[calls];
      calls += 1;
      if (step === undefined) throw new Error("scripted responses exhausted");
      if (step.kind === "error") throw step.err;
      return { role: "assistant", content: step.content };
    },
  };
}
const contextLengthError = (): Error =>
  Object.assign(new Error("provider context length exceeded: 413 too big"), { name: "ContextLengthError", status: 413 });

const loopState = (messages: AgentMessage[], tools: readonly Tool[] = []): AgentState => ({
  systemPrompt: "s",
  messages,
  tools,
  status: "idle",
});

describe("loop wiring (ω-3b)", () => {
  it("T6: reactive compaction after a steer keeps the unseen batch's full bytes on the retry", async () => {
    // History (all SEEN, no tool results — the cheap tiers have nothing) +
    // the E2 tail. The steer drains BEFORE the model call, the call 413s, and
    // the reactive ladder compacts exactly this shape.
    const batch = e1Tail(6000);
    const messages: AgentMessage[] = [
      { role: "user", content: "task one" },
      { role: "assistant", content: "answer one" },
      { role: "user", content: "more context" },
      { role: "assistant", content: "answer two" },
      ...batch,
    ];
    const model = stepModel([
      { kind: "error", err: contextLengthError() },
      { kind: "ok", content: "REACTIVE-SUMMARY" },
      { kind: "ok", content: "final answer" },
    ]);
    const steerQueue = ["STEER-NOW"]; // one-shot: drained once, before call 1
    const events = (
      await drain(
        runAgentLoop(loopState(messages), model, {
          maxTurns: 3,
          steering: { take: () => steerQueue.shift() },
          // window 20k → threshold 16k: the 12k-token prompt is under the
          // immediate band but its physical completion budget (<1024) sends
          // the 413 straight to the compact corner of the ladder.
          compaction: { contextWindowTokens: 20_000, keepRecent: 6, zeroLlmDigest: false }, // #38: consume the scripted REACTIVE-SUMMARY
        }),
      )
    ).events;
    // The compaction fired on the reactive path (tier 2: the cheap tiers had
    // nothing floored-safe to do) and the retry succeeded on its output.
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted).toBeDefined();
    expect(compacted!.tier).toBe(2);
    expect(compacted!.trigger).toBe("reactive");
    expect(compacted!.reason).toBe("overflow");
    expect(model.calls).toBe(3);
    const retry = model.inputs[2]?.messages ?? [];
    // The unseen batch rides FULL bytes (both ends of it), plus the steer.
    const t1 = batch[1] as { content: string };
    const t8 = batch[8] as { content: string };
    expect(retry.some((x) => x.role === "tool" && x.content === t1.content)).toBe(true);
    expect(retry.some((x) => x.role === "tool" && x.content === t8.content)).toBe(true);
    expect(retry.some((x) => x.content === "STEER-NOW")).toBe(true);
    expect(retry.some((x) => x.role === "user" && x.content.startsWith(SUMMARY_MARKER))).toBe(true);
    // No stub/clear marker anywhere after the summary (the whole tail).
    expect(retry.slice(1).some((x) => x.content.startsWith(COMPACTION_STUB_PREFIX) || x.content.startsWith(CLEARED_MARKER))).toBe(false);
    // M70 §2 pin: the tier-2 event's kept-verbatim tail IS the floored `rest`
    // — the batch's assistant heads it, full bytes included.
    expect(compacted!.retainedTail).toHaveLength(10);
    expect(compacted!.retainedTail[0]?.role).toBe("assistant");
    expect(compacted!.retainedTail.some((x) => x.role === "tool" && x.content === t1.content)).toBe(true);
    expect(compacted!.retainedTail.some((x) => x.content === "STEER-NOW")).toBe(true);
  });

  it("T7: the fuse-turn immediate compaction leaves the pending batch intact on the retry input", async () => {
    // An inline tool whose results are big (12k chars each) but under every
    // result cap — pure tier-1 fodder once seen.
    const bigTool: Tool = {
      name: "big_tool",
      description: "returns a big fixed payload",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: "B".repeat(12_000) }),
    };
    const batchCall: AssistantMessage = {
      role: "assistant",
      content: "",
      toolCalls: FANOUT_IDS.map((id) => ({ id, name: "big_tool", arguments: {} })),
    };
    // The scripted model returns tool calls every turn so the fuse nudge
    // (loop.ts:974) lands after the pending batch on the final turn.
    const scripted: AssistantMessage[] = [batchCall, batchCall];
    let calls = 0;
    const inputs: ModelInput[] = [];
    const toolModel: ModelClient = {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push([...input.messages]); // snapshot (the live array keeps growing)
        const r = scripted[calls];
        calls += 1;
        if (r === undefined) throw new Error("scripted responses exhausted");
        return r;
      },
    };
    const messages: AgentMessage[] = [{ role: "user", content: "do the huge thing" }, ...seenPairs(4, 2000)];
    const { events, terminal } = await drain(
      runAgentLoop(loopState(messages, [bigTool]), toolModel, {
        maxTurns: 2,
        // window 20k: turn 0 sits far below the threshold; the executed
        // 8×3k-token batch + the max-turns nudge push turn 1 over the
        // immediate band (24192) — the nudge lands AFTER the pending batch
        // (E2 on the "immediate" path).
        compaction: { contextWindowTokens: 20_000, keepRecent: 6 },
      }),
    );
    expect(terminal.reason).toBe("max_turns");
    const compacted = events.find((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted).toBeDefined();
    expect(compacted!.tier).toBe(1);
    expect(compacted!.trigger).toBe("immediate");
    expect(calls).toBe(2);
    const retry = inputs[1] ?? [];
    // The whole unseen batch rides full bytes; the seen pairs were stubbed.
    expect(retry.filter((x) => x.role === "tool" && x.content === "B".repeat(12_000))).toHaveLength(8);
    expect(retry.some((x) => x.content.startsWith("[system note: turn limit reached"))).toBe(true);
    // The tail after the last assistant (index of the nudge onward — in fact
    // everything from the fan-out assistant on) carries no stub markers.
    const fanoutIdx = retry.findIndex((x) => x.role === "assistant" && (x as { toolCalls?: { id: string }[] }).toolCalls?.some((tc) => tc.id === "t1"));
    expect(fanoutIdx).toBeGreaterThan(0);
    expect(retry.slice(fanoutIdx).some((x) => x.content.startsWith(COMPACTION_STUB_PREFIX) || x.content.startsWith(CLEARED_MARKER))).toBe(false);
    // D5 pin: retainedTail is the unclamped alignedCutoff slice — the nudge.
    expect(compacted!.retainedTail).toHaveLength(1);
    expect(compacted!.retainedTail[0]?.content.startsWith("[system note: turn limit reached")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T8 — the terminal tiers are deliberately UN-floored (pins D2+D3).
// ---------------------------------------------------------------------------

describe("terminal tiers stay un-floored (ω-3b D2/D3)", () => {
  it("T8(a): emergencyDrop may consume the unseen batch when the tail alone is over budget (D2)", () => {
    const m: AgentMessage[] = [{ role: "user", content: "go" }, ...e1Tail(2000)];
    // keepRecent 6 < the 9-message tail → the batch is inside the droppable
    // region; the tiny budget forces phase 2 to extend through it. The whole
    // batch is ONE pair-chain, so pairing-safety drags the drop to its end.
    const drop = emergencyDrop(m, {
      keepRecent: 6,
      fitsTokens: 300,
      systemPrompt: "s",
      tools: [],
    });
    expect(drop).not.toBeNull(); // a floored emergencyDrop would null here (m6)
    expect(drop!.dropped).toBe(9); // the assistant + every unseen result: deliberate, disclosed loss
    expect(drop!.messages).toHaveLength(2);
    expect(drop!.messages[0]).toBe(m[0]);
    expect(drop!.messages[1]?.role).toBe("user");
    expect(drop!.messages[1]?.content.startsWith(EMERGENCY_DROP_PREFIX)).toBe(true);
    expect(drop!.messages.some((x) => x.role === "tool")).toBe(false); // no orphaned result anywhere
  });

  it("T8(b): the dual tier keeps its oversized-current-turn shedder role (D3)", () => {
    // The m52 §1.2 single-giant-turn shape: the dual partition's HISTORY
    // split is floored (empty here), but the turnPrefix growth is NOT — the
    // whole window may still be summarized away.
    const batch: AgentMessage[] = [
      { role: "user", content: "read all three files" },
      fanout(["c1", "c2", "c3"]),
      result("c1", "x".repeat(15_000)),
      result("c2", "y".repeat(60_000)),
      result("c3", "z".repeat(30_000)),
    ];
    const p = dualSummaryPartition(batch, { keepRecent: 6 });
    expect(p).not.toBeNull();
    expect(p!.history).toEqual([]);
    expect(p!.turnPrefix).toHaveLength(5);
    expect(p!.kept).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// T9 — resume partial batch (the R9/repairOrphanedToolCalls interaction).
// ---------------------------------------------------------------------------

describe("resume partial batch (ω-3b + R9)", () => {
  it("T9: repair fills the missing result; the floor protects BOTH results of the answered-by-nobody batch", () => {
    const partial: AgentMessage[] = [
      { role: "user", content: "go" },
      fanout(["t1", "t2"]),
      result("t1", "r".repeat(2000)),
    ];
    const repaired = repairOrphanedToolCalls(partial);
    expect(repaired).toHaveLength(4);
    expect((repaired[3] as { content: string }).content).toBe(UNAVAILABLE_TOOL_RESULT);
    // floor = idx(A) = 1 → neither T1 nor the synthetic may be stubbed.
    expect(floorCutoff(repaired, 1)).toBe(1);
    const out = microcompact(repaired, { keepRecent: 1 });
    expect(out[2]).toBe(repaired[2]);
    expect(out[3]).toBe(repaired[3]);

    // Variant: an assistant answered past them → both are ordinary SEEN
    // content and stubbable (minChars lowered so the synthetic qualifies).
    const answered: AgentMessage[] = [...repaired, { role: "assistant", content: "done with both" }];
    expect(floorCutoff(answered, 1)).toBe(4);
    const out2 = microcompact(answered, { keepRecent: 1, minChars: 10 });
    expect((out2[2] as { content: string }).content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    expect((out2[3] as { content: string }).content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T10 — golden no-op: sequences without the E1/E2/E3 shape produce output
// byte-identical to the PRE-change behavior (the floor never binds: aligned
// ≤ floor in every case, verified by the inline cutoff assertions). Inline
// frozen expectations — never old-code diffing.
// ---------------------------------------------------------------------------

describe("golden no-op (ω-3b T10)", () => {
  it("(a) small terminal batch inside the window — every tier byte-identical", () => {
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", "q".repeat(2000)),
    ];
    // aligned 0 (len 3 < keepRecent 6) == pre-change cutoff; floor 1 does not
    // bind (min(0,1) = 0).
    expect(alignedFloor(m, 6)).toBe("0/1");
    expect(microcompact(m)[2]).toBe(m[2]);
    const cleared = clearTier(m);
    expect(cleared.cleared).toBe(0);
    expect(cleared.messages[2]).toBe(m[2]);
    expect(staticTier2Compact(m)).toBeNull();
  });

  it("(b) batch answered by a later text assistant — window-protected seen result stays verbatim, the old one keeps its exact stub bytes", () => {
    const t1Content = "S".repeat(2000);
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("t1"),
      result("t1", t1Content),
      { role: "user", content: "hold" },
      call("t2"),
      result("t2", "Z".repeat(2000)),
      { role: "assistant", content: "end" },
    ];
    // keepRecent 3 → raw 4 lands on the second call's assistant → aligned 4;
    // floor 6 → min = 4 == pre-change cutoff (the floor does not bind).
    expect(alignedFloor(m, 3)).toBe("4/6");
    const out = microcompact(m, { keepRecent: 3 });
    // FROZEN stub bytes (the ω-2b pointer included):
    expect((out[2] as { content: string }).content).toBe(
      `[compacted tool_result t1: ${"S".repeat(100)}…] — full original retained in this session; recover with session_result(tool_call_id="t1", result_ref="tr-28ea67a95a31")`,
    );
    // The windowed SEEN result of the later batch rides verbatim.
    expect(out[5]).toBe(m[5]);
    expect(out[1]).toBe(m[1]);
    expect(out[3]).toBe(m[3]);
    expect(out[4]).toBe(m[4]);
    expect(out[6]).toBe(m[6]);
  });

  it("(c) no tool messages at all — pure text tiers are untouched by the floor", () => {
    const m: AgentMessage[] = [
      { role: "user", content: "plain task" },
      { role: "assistant", content: "a".repeat(2000) },
      { role: "user", content: "tail" },
    ];
    // keepRecent 2 → raw 1 lands on the assistant → aligned 1; floor 1 →
    // min = 1 == pre-change cutoff.
    expect(alignedFloor(m, 2)).toBe("1/1");
    expect(microcompact(m, { keepRecent: 2 })).toEqual(m);
    expect(clearTier(m, { keepRecent: 2 }).cleared).toBe(0);
    // The static tier-2 summary over the span [U] keeps its exact frozen bytes.
    const out = staticTier2Compact(m, { keepRecent: 2 });
    expect(out).not.toBeNull();
    expect(out!.messages).toHaveLength(3);
    expect(out!.messages[0]!.content).toBe(
      "[compacted summary] Task: plain task\n" +
        "Static fallback summary (the model summary call failed; deterministic compact of 1 messages). Original request: plain task\n" +
        "Recent activity: 1 user.\n" +
        "[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]\n" +
        // 113-B1：权威行是常驻 rider（kept tail 有 assistant 文本时必骑）——
        // 本 golden 的 kept tail 无 assistant 文本（纯 user 轮），静态兜底
        // 路径骑行按“retained>0 才骑”契约……实测有骑=kept 含 assistant 轮，
        // 按新契约重钉（行为变更已在 113-B1 声明）。
        "保留的消息权威于本摘要\n" +
        "[End of summary — respond to the user below, not to the summary]",
    );
    expect(out!.messages[1]).toBe(m[1]);
    expect(out!.messages[2]).toBe(m[2]);
  });
});

/** Test-local readability helper: "aligned/floor" so each golden's no-op
 *  condition (aligned ≤ floor ⇒ the floor cannot bind) is asserted right
 *  next to the frozen bytes it guarantees. Uses the REAL exported walk. */
function alignedFloor(m: readonly AgentMessage[], keepRecent: number): string {
  return `${alignedCutoff(m, keepRecent)}/${stubFloor(m)}`;
}
