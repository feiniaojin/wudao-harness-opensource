// M52 §1 — the upstream projectcompaction correctness pack: boundary alignment (tier0/tier1
// share tier2's pairing-safe cutoff), the single-turn-over-budget dual
// summary, chained compaction spans (a second compaction continues after the
// prior summary instead of re-summarizing it), and the manual reason.
import { describe, it, expect } from "vitest";
import {
  alignedCutoff,
  clearTier,
  CLEARED_MARKER,
  COMPACTION_STUB_PREFIX,
  dualSummaryPartition,
  dualTier2Compact,
  manualCompact,
  microcompact,
  occupancyBreakdown,
  applySummaryMarkers,
  staticTier2Compact,
  SUMMARY_MARKER,
  tier2Compact,
} from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";
import { runAgentLoop } from "../src/loop.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import type { AgentMessage } from "../src/types.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.txt");

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

// ---------------------------------------------------------------------------
// §1.1 — boundary alignment: tier0/tier1 use tier2's pairing-safe cutoff.
// ---------------------------------------------------------------------------

describe("alignedCutoff (M52 tier0/tier1 boundary alignment)", () => {
  // messages[2] is a tool result whose assistant call (messages[1]) sits
  // OUTSIDE the keep window — the raw cutoff would split the pair across the
  // boundary. Alignment pulls the result into the span side.
  const msgs: AgentMessage[] = [
    { role: "user", content: "go" },
    call("c0"),
    result("c0", "data"),
    call("c1"),
    result("c1", "data"),
    { role: "user", content: "tail" },
  ];

  it("advances past a tool result heading the kept region (never cut at a tool result)", () => {
    expect(alignedCutoff(msgs, 3)).toBe(3); // raw 3 → messages[3] is a call, already aligned
    expect(alignedCutoff(msgs, 4)).toBe(3); // raw 2 → messages[2] is a tool result → advance to 3
  });

  it("clearTier clears the pair-split SEEN result; the UNSEEN pair rides verbatim (ω-3b floor)", () => {
    const big = "x".repeat(31_000);
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", big),
      call("c1"),
      result("c1", big),
      { role: "user", content: "tail" },
    ];
    // keepRecent 2 → raw cutoff 4 lands ON the unseen result; the M52 walk
    // pulls the pair past it into the candidate region (aligned 5 — the
    // pair-pull is still exercised), but the ω-3b floor clamps the boundary
    // at the last assistant (index 3): result(c0) is SEEN (call(c1) responded
    // past it) and clearable; result(c1) is UNSEEN and stays verbatim.
    const out = clearTier(m, { keepRecent: 2 });
    expect(out.cleared).toBe(1);
    expect(out.messages[2]?.role).toBe("tool");
    if (out.messages[2]?.role === "tool") expect(out.messages[2].content.startsWith(CLEARED_MARKER)).toBe(true);
    expect(out.messages[4]).toBe(m[4]);
    // keepRecent 3 on the same shape: aligned 3 == floor 3 — the SEEN result
    // below the window edge stays a candidate (the floor never over-protects).
    expect(clearTier(m, { keepRecent: 3 }).cleared).toBe(1);
  });

  it("microcompact stubs the pair-split SEEN result; the UNSEEN pair rides verbatim (ω-3b floor)", () => {
    const big = "x".repeat(2000);
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", big),
      call("c1"),
      result("c1", big),
      { role: "user", content: "tail" },
    ];
    const out = microcompact(m, { keepRecent: 2, minChars: 1000 });
    if (out[2]?.role === "tool") {
      expect(out[2].content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
    } else {
      expect.unreachable("the pair-split tool result must be stubbed");
    }
    expect(out[4]).toBe(m[4]);
  });

  it("ω-3b floor: the OLD single-pair shape no longer clears/stubs its only (unseen) result", () => {
    const big = "x".repeat(31_000);
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", big),
      { role: "user", content: "tail" },
    ];
    // keepRecent 2 → aligned 3 (the M52 pair-pull still runs), floor 1 (the
    // last assistant) → cutoff 1: result(c0) has NO assistant after it — the
    // model never responded to it — so no routine tier may degrade it. This
    // was the pre-ω-3b pin's shape; its cleared=1/stub expectation was the
    // over-stub the floor closes (design 81 §2, D6).
    expect(clearTier(m, { keepRecent: 2 }).cleared).toBe(0);
    expect(microcompact(m, { keepRecent: 2, minChars: 1000 })[2]).toBe(m[2]);
    // keepRecent 3 still protects the pair the old way: the raw cutoff 1
    // lands ON the call (index 1) and the walk stops there — the pair sits
    // inside the kept window, floor or no floor.
    expect(clearTier(m, { keepRecent: 3 }).cleared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §1.2 — single turn over budget: dual merged summary, not a dropped turn.
// ---------------------------------------------------------------------------

describe("dualSummaryPartition / dualTier2Compact (M52 single-turn-over-budget)", () => {
  const big = "y".repeat(4000);
  // ONE giant turn: everything after the opening user message is one exchange
  // blowing the window; there is nothing outside the keep window to compact.
  const turn: AgentMessage[] = [
    { role: "user", content: "do the huge thing" },
    call("c0"),
    result("c0", big),
    call("c1"),
    result("c1", big),
    { role: "assistant", content: "working" },
    { role: "user", content: "final tail" },
  ];

  it("partitions into history + turn prefix + kept, pairing-safe at both edges", () => {
    const p = dualSummaryPartition(turn, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(p).not.toBeNull();
    // The kept tail is the final user message; the turn prefix carries the
    // head of the oversized turn INCLUDING whole call/result pairs.
    expect(p!.kept.map((m) => m.content)).toEqual(["final tail"]);
    expect(p!.turnPrefix.map((m) => m.content)).toEqual(["working"]);
    const lastPrefix = p!.turnPrefix[p!.turnPrefix.length - 1];
    expect(lastPrefix?.role === "assistant" && (lastPrefix.toolCalls?.length ?? 0) > 0).toBe(false);
    // history = everything the standard span would have covered (the head of
    // the single oversized turn, pairs intact).
    expect(p!.history.map((m) => m.content)).toContain("do the huge thing");
    expect(p!.history.length).toBe(5);
  });

  it("never ends the prefix on an assistant tool_call whose results were cut", () => {
    const m: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", "x".repeat(2000)),
      call("c1"),
      result("c1", "y".repeat(2000)),
      { role: "user", content: "tail" },
    ];
    // keepRecent 3 → the window is [call c1, result c1, tail]; a tiny char
    // budget would end the prefix on call c1 — the pairing rule must pull its
    // result along.
    const p = dualSummaryPartition(m, { keepRecent: 3, turnPrefixChars: 10 });
    expect(p).not.toBeNull();
    expect(p!.turnPrefix.length).toBeGreaterThan(0);
    const last = p!.turnPrefix[p!.turnPrefix.length - 1];
    expect(last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0).toBe(false);
    expect(p!.kept.length).toBeGreaterThan(0);
  });

  it("dualTier2Compact merges the two summaries into ONE frozen summary message", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "HISTORY-PART" },
      { role: "assistant", content: "TURN-PART" },
    ]);
    const out = await dualTier2Compact(turn, model, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(out).not.toBeNull();
    const head = out!.messages[0];
    expect(head?.role).toBe("user");
    expect(head?.content).toContain(SUMMARY_MARKER);
    expect(head?.content).toContain("HISTORY-PART");
    expect(head?.content).toContain("TURN-PART");
    expect(head?.content.indexOf("HISTORY-PART")).toBeLessThan(head!.content.indexOf("TURN-PART"));
    // the kept tail survives verbatim
    expect(out!.messages[out!.messages.length - 1]?.content).toBe("final tail");
    // exactly ONE summary message — a merge, not two markers
    expect(out!.messages.filter((m) => m.content.startsWith(SUMMARY_MARKER))).toHaveLength(1);
  });

  it("summarizes prior history AND the turn prefix when both exist", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "EARLIER" },
      { role: "assistant", content: "TURNHEAD" },
    ]);
    const m: AgentMessage[] = [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new huge turn" },
      call("c0"),
      result("c0", big),
      { role: "assistant", content: "still working" },
    ];
    const out = await dualTier2Compact(m, model, { keepRecent: 4, turnPrefixChars: 6000 });
    expect(out).not.toBeNull();
    expect(out!.messages[0]?.content).toContain("EARLIER");
    expect(out!.messages[0]?.content).toContain("TURNHEAD");
  });

  it("returns null when there is nothing to partition (single message)", async () => {
    const model = createScriptedModel([]);
    expect(await dualTier2Compact([{ role: "user", content: "only" }], model, { keepRecent: 2 })).toBeNull();
  });

  it("a whole-window tool batch joins the prefix; kept may be empty (the turn IS the summary's subject)", async () => {
    // One user message + one assistant turn batching 3 reads — the whole
    // conversation is one pair-chain, and the reads blow the window.
    const model = createScriptedModel([
      { role: "assistant", content: "H" },
      { role: "assistant", content: "T" },
    ]);
    const batch: AgentMessage[] = [
      { role: "user", content: "read all three files" },
      { role: "assistant", content: "", toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a" } },
        { id: "c2", name: "read_file", arguments: { path: "b" } },
        { id: "c3", name: "read_file", arguments: { path: "c" } },
      ] },
      result("c1", "x".repeat(15000)),
      result("c2", "y".repeat(60000)),
      result("c3", "z".repeat(30000)),
    ];
    const p = dualSummaryPartition(batch, { keepRecent: 6 });
    expect(p).not.toBeNull();
    expect(p!.kept).toEqual([]); // nothing orphaned, nothing silently dropped
    expect(p!.turnPrefix).toHaveLength(5);
    const out = await dualTier2Compact(batch, model, { keepRecent: 6 });
    expect(out).not.toBeNull();
    expect(out!.messages[0]?.content).toContain(SUMMARY_MARKER);
    // and the manual compact still records a boundary (the summary itself)
    const manual = await manualCompact({ systemPrompt: "s", tools: [], messages: batch, model }, { keepRecent: 6 });
    expect(manual?.firstKeptEntryId).toMatch(/^user-\d+-[0-9a-f]+$/);
  });

  it("degrades each half to the static summary when the model call fails", async () => {
    const model: import("../src/model-client.js").ModelClient = {
      // biome-ignore lint/suspicious/useFnvPair: test double
      async generate() {
        throw new Error("provider down");
      },
    };
    const out = await dualTier2Compact(turn, model, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(out).not.toBeNull();
    expect(out!.messages[0]?.content).toContain("Static fallback summary");
    expect(out!.messages[0]?.content).toContain("Turn prefix");
  });
});

// ---------------------------------------------------------------------------
// §1.3 — chained spans: a second tier-2 compaction continues AFTER the prior
// summary (frozen bytes, no summary-of-summary drift); applySummaryMarkers is
// chain-aware so a resumed session keeps the whole chain.
// ---------------------------------------------------------------------------

describe("chained spans (M52)", () => {
  const big = "z".repeat(2000);
  const first: AgentMessage[] = [
    { role: "user", content: "task A " + big },
    { role: "assistant", content: "answer A " + big },
    { role: "user", content: "task B" },
  ];

  it("a second compaction keeps the first summary verbatim and chains after it", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "SUMMARY-ONE" }]);
    const once = await tier2Compact(first, model, { keepRecent: 1 });
    expect(once).not.toBeNull();
    // …the conversation continues past the first compaction…
    const grown: AgentMessage[] = [
      ...once!.messages,
      { role: "assistant", content: "answer B " + big },
      { role: "user", content: "task C" },
    ];
    const replayed: import("../src/model-client.js").ModelInput[] = [];
    const model2: import("../src/model-client.js").ModelClient = {
      async generate(input) {
        replayed.push(input);
        return { role: "assistant", content: "SUMMARY-TWO" };
      },
    };
    const twice = await tier2Compact(grown, model2, { keepRecent: 1 });
    expect(twice).not.toBeNull();
    const messages = twice!.messages;
    // The FIRST summary survives byte-identical (frozen), the SECOND follows it.
    expect(messages[0]?.content).toContain("SUMMARY-ONE");
    expect(messages[1]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(messages[1]?.content).toContain("SUMMARY-TWO");
    expect(messages[messages.length - 1]?.content).toBe("task C");
    // The second summary call replayed ONLY the post-boundary span.
    expect(replayed.length).toBe(1);
    const replayMessages = replayed[0]?.messages ?? [];
    expect(replayMessages.some((m) => m.content.includes("SUMMARY-ONE"))).toBe(false);
    expect(replayMessages.some((m) => m.content.includes("task A"))).toBe(false);
    expect(replayMessages.some((m) => m.content.includes("task B"))).toBe(true);
  });

  it("the static fallback chains identically", () => {
    const once = staticTier2Compact(first, { keepRecent: 1 });
    expect(once).not.toBeNull();
    const grown: AgentMessage[] = [
      ...once!.messages,
      { role: "assistant", content: "answer B " + big },
      { role: "user", content: "task C" },
    ];
    const twice = staticTier2Compact(grown, { keepRecent: 1 });
    expect(twice).not.toBeNull();
    expect(twice!.messages[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(twice!.messages[1]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  it("returns null while everything since the last summary is still in the window", async () => {
    const model = createScriptedModel([]);
    const msgs: AgentMessage[] = [
      { role: "user", content: `${SUMMARY_MARKER} prior chain head` },
      { role: "user", content: "recent" },
    ];
    expect(await tier2Compact(msgs, model, { keepRecent: 1 })).toBeNull();
  });

  it("applySummaryMarkers chain mode keeps the whole chain from the FIRST marker", () => {
    const s1: AgentMessage = { role: "user", content: `${SUMMARY_MARKER} one` };
    const s2: AgentMessage = { role: "user", content: `${SUMMARY_MARKER} two` };
    const msgs: AgentMessage[] = [
      { role: "user", content: "ancient" },
      s1,
      { role: "user", content: "between" },
      s2,
      { role: "user", content: "after" },
    ];
    expect(applySummaryMarkers(msgs, { chain: true }).map((m) => m.content)).toEqual([
      `${SUMMARY_MARKER} one`,
      "between",
      `${SUMMARY_MARKER} two`,
      "after",
    ]);
    // default (single) mode is unchanged: reset at every marker
    expect(applySummaryMarkers(msgs).map((m) => m.content)).toEqual([`${SUMMARY_MARKER} two`, "after"]);
  });
});

// ---------------------------------------------------------------------------
// §1.4 — manual compaction: reason "manual", compacts regardless of occupancy.
// ---------------------------------------------------------------------------

describe("manualCompact (M52 /compact)", () => {
  const big = "m".repeat(2000);
  const msgs: AgentMessage[] = [
    { role: "user", content: "task 1 " + big },
    { role: "assistant", content: "answer 1 " + big },
    { role: "user", content: "task 2" },
  ];

  it("compacts even far below any threshold, with reason manual and a frozen marker", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "MANUAL-SUMMARY" }]);
    const out = await manualCompact({ systemPrompt: "s", tools: [], messages: msgs, model }, { keepRecent: 1 });
    expect(out).not.toBeNull();
    expect(out.reason).toBe("manual");
    expect(out.tier).toBe(2);
    expect(out.summaryMessage?.content).toContain("MANUAL-SUMMARY");
    expect(out.messages[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(out.messages[out.messages.length - 1]?.content).toBe("task 2");
    expect(out.afterTokens).toBeLessThan(out.beforeTokens);
  });

  it("degrades to the static summary when the model call fails (never a dead manual)", async () => {
    const model: import("../src/model-client.js").ModelClient = {
      async generate() {
        throw new Error("provider down");
      },
    };
    const out = await manualCompact({ systemPrompt: "s", tools: [], messages: msgs, model }, { keepRecent: 1 });
    expect(out).not.toBeNull();
    expect(out.reason).toBe("manual");
    expect(out.messages[0]?.content).toContain("Static fallback summary");
  });

  it("compacts a single turn that fills the whole window (dual path, static fallback)", async () => {
    // The scripted model is EMPTY → every summary call throws → both dual
    // halves degrade to the deterministic static summary; the run still ends
    // with a frozen marker. The call/result pair rides into the summary
    // TOGETHER (pairing), and a boundary is recorded even though nothing
    // survived verbatim.
    const model = createScriptedModel([]);
    const huge = "h".repeat(31_000);
    const single: AgentMessage[] = [
      { role: "user", content: "go" },
      call("c0"),
      result("c0", huge),
    ];
    const out = await manualCompact({ systemPrompt: "s", tools: [], messages: single, model }, { keepRecent: 6 });
    expect(out).not.toBeNull();
    expect(out.reason).toBe("manual");
    expect(out.tier).toBe(2);
    expect(out.messages[0]?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(out.messages[0]?.content).toContain("Static fallback summary");
    // never an orphaned result: no tool message survives without its call
    const keptCalls = new Set<string>();
    for (const m of out.messages) {
      if (m.role === "assistant" && m.toolCalls) for (const tc of m.toolCalls) keptCalls.add(tc.id);
    }
    for (const m of out.messages) {
      if (m.role === "tool") expect(keptCalls.has(m.toolCallId)).toBe(true);
    }
    expect(out.firstKeptEntryId).toMatch(/^user-\d+-[0-9a-f]+$/);
  });
});

// ---------------------------------------------------------------------------
// §1 (loop wiring) — the compacted event's reason + the dual fallback firing
// when the recent window itself is the overflow.
// ---------------------------------------------------------------------------

describe("loop compacted event (M52 reason + dual)", () => {
  async function drain(gen: AsyncGenerator<import("../src/loop.js").LoopEvent, unknown>): Promise<import("../src/loop.js").LoopEvent[]> {
    const events: import("../src/loop.js").LoopEvent[] = [];
    for (;;) {
      const r = await gen.next();
      if (r.done) return events;
      events.push(r.value);
    }
  }
  // Turn 0 must run a tool so the (M24-deferred) compaction executes at the
  // turn boundary; a final-answer-only run never reaches a boundary.
  const toolCall = { role: "assistant" as const, content: "", toolCalls: [{ id: "r1", name: "read_file", arguments: { path: fixturePath } }] };
  const state = (messages: AgentMessage[]) => ({
    systemPrompt: "s",
    messages,
    tools: [createReadFileTool()],
    status: "idle" as const,
  });

  it("labels threshold compactions with reason threshold and carries firstKeptEntryId", async () => {
    const big = "q".repeat(4000);
    const messages: AgentMessage[] = [
      { role: "user", content: "task " + big },
      { role: "assistant", content: "ans " + big },
      { role: "user", content: "go" },
    ];
    const model = createScriptedModel([
      toolCall,
      { role: "assistant", content: "SUMMARY" },
      { role: "assistant", content: "final answer" },
    ]);
    const events = await drain(
      runAgentLoop(state(messages), model, {
        maxTurns: 4,
        compaction: { contextWindowTokens: 700, keepRecent: 2 },
      }),
    );
    const compacted = events.filter((e) => e.type === "compacted");
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    const c = compacted[0];
    if (c?.type !== "compacted") throw new Error("unreachable");
    expect(c.tier).toBe(2);
    expect(c.reason).toBe("threshold");
    // keepRecent 2 keeps the boundary tool pair → a first kept ORIGINAL
    // message exists and is fingerprinted.
    expect(c.firstKeptEntryId).toMatch(/^assistant-\d+-[0-9a-f]+$/);
  });

  it("dual-compacts when the single oversized turn IS the window (no standard span)", async () => {
    const big = "w".repeat(30_000);
    // 4 messages, keepRecent 6 → cutoff ≤ 0: no standard span, but occupancy
    // far over threshold → the dual summary must fire at the turn boundary.
    const messages: AgentMessage[] = [
      { role: "user", content: "do it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c0", name: "read_file", content: big },
      { role: "user", content: "go" },
    ];
    const model = createScriptedModel([
      toolCall,
      { role: "assistant", content: "H" },
      { role: "assistant", content: "T" },
      { role: "assistant", content: "final answer" },
    ]);
    const events = await drain(
      runAgentLoop(state(messages), model, {
        maxTurns: 4,
        compaction: { contextWindowTokens: 1000, keepRecent: 6 },
      }),
    );
    const c = events.find((e) => e.type === "compacted");
    expect(c).toBeDefined();
    if (c?.type === "compacted") {
      expect(c.tier).toBe(2);
      expect(c.reason).toBe("threshold");
      expect(c.summaryMessage?.content).toContain("[turn summary]");
    }
  });
});

// ---------------------------------------------------------------------------
// §3 support — the occupancy breakdown both ctx_inspect and /context share.
// ---------------------------------------------------------------------------

describe("occupancyBreakdown (M52 ctx visibility)", () => {
  it("splits occupancy into system/tools/messages and counts compaction markers", () => {
    const tools = [{ name: "t", description: "abcd".repeat(10), parameters: { type: "object", properties: {} } }];
    const messages: AgentMessage[] = [
      { role: "user", content: `${SUMMARY_MARKER} s` },
      { role: "user", content: "hello" },
      call("c0"),
      result("c0", COMPACTION_STUB_PREFIX + " stub"),
      result("c1", CLEARED_MARKER),
      { role: "assistant", content: "done" },
    ];
    const b = occupancyBreakdown("system prompt text", tools, messages);
    expect(b.systemTokens).toBe(Math.ceil("system prompt text".length / 4));
    expect(b.toolsTokens).toBe(Math.ceil(JSON.stringify(tools[0]).length / 4));
    expect(b.messagesTokens).toBeGreaterThan(0);
    expect(b.totalTokens).toBe(b.systemTokens + b.toolsTokens + b.messagesTokens);
    expect(b.messagesByRole).toEqual({ user: expect.any(Number), assistant: expect.any(Number), tool: expect.any(Number) });
    expect(b.compaction.summaries).toBe(1);
    expect(b.compaction.stubbed).toBe(1);
    expect(b.compaction.cleared).toBe(1);
    expect(b.messageCount).toBe(messages.length);
  });

  // R5-I1 — occupancy sees images too: same estimate the compactor and the
  // ctx watermark use, so ctx_inspect //context can never disagree with the
  // bar about image pressure.
  it("counts image riders as their own dimension (R5-I1); text-only stays three-way", () => {
    const img = (byteLength: number): { kind: "image"; ref: { kind: "image"; attachmentId: string; mediaType: string; byteLength: number } } => ({
      kind: "image",
      ref: { kind: "image", attachmentId: "00000000-0000-4000-8000-000000000000", mediaType: "image/png", byteLength },
    });
    const textOnly: AgentMessage[] = [
      { role: "user", content: "hello" },
      { role: "tool", toolCallId: "c0", name: "shot", content: "r" },
    ];
    const withImages: AgentMessage[] = [
      { role: "user", content: "hello", images: [img(300_000)] },
      { role: "tool", toolCallId: "c0", name: "shot", content: "r", images: [img(300_000), img(10)] },
    ];
    const b0 = occupancyBreakdown("s", [], textOnly);
    expect(b0.imagesTokens).toBe(0);
    expect(b0.imageCount).toBe(0);
    expect(b0.totalTokens).toBe(b0.systemTokens + b0.toolsTokens + b0.messagesTokens); // parity pin

    const b1 = occupancyBreakdown("s", [], withImages);
    const base = 85; // IMAGE_TOKEN_ESTIMATE.base
    expect(b1.imageCount).toBe(3);
    expect(b1.imagesTokens).toBe(3 * base + Math.ceil(300_000 / 750) * 2 + Math.ceil(10 / 750));
    expect(b1.totalTokens).toBe(b1.systemTokens + b1.toolsTokens + b1.messagesTokens + b1.imagesTokens);
    // byRole stays TEXT-only (chars/4 by role) — images are their own line.
    expect(b1.messagesByRole).toEqual(b0.messagesByRole);
  });
});
