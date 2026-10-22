// M34 §3 — tier-0 clear compaction: BEFORE microcompact, the oldest tool
// results past keepRecent whose content exceeds 30k chars are replaced with
// the deterministic "[Old tool result content cleared]" marker — no summary,
// pure oldest-largest, pairing-safe (the message stays, only content
// shrinks). When clearing alone brings the occupancy back under the
// threshold, no dearer tier fires (compact event tier: 0).
import { describe, it, expect } from "vitest";
import { clearTier, CLEARED_MARKER, CLEAR_TIER_MIN_CHARS, estimateTokens } from "../src/compaction.js";
import { toolResultRef } from "../src/tools/session-result.js";

/** ω-2b (I3): the cleared shape = marker + pointer line naming the exact
 * (toolCallId, original bytes) pair the recovery tool pages back. */
const clearedShape = (id: string, original: string): string =>
  `${CLEARED_MARKER}\nfull original retained in this session; recover with session_result(tool_call_id="${id}", result_ref="${toolResultRef(id, original)}")`;
import { runAgentLoop } from "../src/loop.js";
import { createScriptedModel } from "../src/model-client.js";
import type { AgentMessage, AgentState, LoopEvent, Terminal } from "../src/index.js";

const toolMsg = (id: string, content: string): AgentMessage => ({
  role: "tool",
  toolCallId: id,
  name: "read_file",
  content,
});
const callMsg = (...ids: string[]): AgentMessage => ({
  role: "assistant",
  content: "",
  toolCalls: ids.map((id) => ({ id, name: "read_file", arguments: { path: "x" } })),
});

const big = (n: number): string => "x".repeat(n);

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

describe("clearTier (pure)", () => {
  it("clears ONLY old (>keepRecent) tool results over 30k chars, oldest first", () => {
    const messages: AgentMessage[] = [
      callMsg("a"),
      toolMsg("a", big(CLEAR_TIER_MIN_CHARS + 10)), // old + huge → cleared
      { role: "user", content: big(CLEAR_TIER_MIN_CHARS + 10) }, // not a tool result
      callMsg("b"),
      toolMsg("b", big(500)), // old but small → kept
      callMsg("c", "d"),
      toolMsg("c", big(CLEAR_TIER_MIN_CHARS + 10)), // recent (keepRecent 2)
      toolMsg("d", big(20)), // recent
      // ω-3b hand-check: c/d used to end the list unseen — their clearing was
      // the over-stub the stub floor closes. A responding text assistant marks
      // them SEEN, so the age/size filtering this test pins stays exercised.
      { role: "assistant", content: "got c and d" },
    ];
    const { messages: out, cleared } = clearTier(messages, { keepRecent: 2 });
    // M52: the raw cutoff landed ON toolMsg("c")'s run — a result whose call
    // (index 5) already sits in the span. The aligned boundary pulls the
    // straddlers into the candidate region, so BOTH huge results clear.
    expect(cleared).toBe(2);
    expect(out[1]).toEqual(toolMsg("a", clearedShape("a", big(CLEAR_TIER_MIN_CHARS + 10))));
    // Everything else is untouched, pairing intact (same length, same ids).
    expect(out).toHaveLength(messages.length);
    expect(out[4]).toEqual(toolMsg("b", big(500)));
    expect(out[6]).toEqual(toolMsg("c", clearedShape("c", big(CLEAR_TIER_MIN_CHARS + 10))));
    expect(out[7]).toEqual(toolMsg("d", big(20)));
  });

  it("stops as soon as the estimate fits fitsTokens (oldest-largest order)", () => {
    const messages: AgentMessage[] = [
      callMsg("a", "b"),
      toolMsg("a", big(CLEAR_TIER_MIN_CHARS + 1)),
      toolMsg("b", big(CLEAR_TIER_MIN_CHARS + 1)),
      // ω-3b hand-check: a/b were terminal and unseen (their clearing was the
      // over-stub). A responding assistant makes them seen again.
      { role: "assistant", content: "ack" },
    ];
    const one = estimateTokens("", [], [callMsg("a", "b"), toolMsg("a", clearedShape("a", big(CLEAR_TIER_MIN_CHARS + 1))), toolMsg("b", big(CLEAR_TIER_MIN_CHARS + 1)), { role: "assistant", content: "ack" }]);
    const { messages: out, cleared } = clearTier(messages, { keepRecent: 0, fitsTokens: one });
    expect(cleared).toBe(1);
    expect(out[1]).toEqual(toolMsg("a", clearedShape("a", big(CLEAR_TIER_MIN_CHARS + 1))));
    expect(out[2]).toEqual(toolMsg("b", big(CLEAR_TIER_MIN_CHARS + 1)));
  });

  it("is idempotent — a cleared marker is short, so a second pass clears nothing", () => {
    // ω-3b hand-check: the old shape ended at the unseen result (nothing was
    // clearable); a responding assistant keeps the clearing real.
    const first = clearTier([callMsg("a"), toolMsg("a", big(CLEAR_TIER_MIN_CHARS + 1)), { role: "assistant", content: "ack" }], { keepRecent: 0 });
    expect(first.cleared).toBe(1);
    const second = clearTier(first.messages, { keepRecent: 0 });
    expect(second.cleared).toBe(0);
    expect(second.messages).toEqual(first.messages);
  });

  it("clears nothing when everything is inside keepRecent", () => {
    const messages = [callMsg("a"), toolMsg("a", big(CLEAR_TIER_MIN_CHARS + 1))];
    const r = clearTier(messages, { keepRecent: 6 });
    expect(r.cleared).toBe(0);
    expect(r.messages).toEqual(messages);
  });
});

describe("tier 0 in the loop (before microcompact)", () => {
  const hugeHistory = (): AgentMessage[] => [
    { role: "user", content: "read the big file three times" },
    callMsg("r0"),
    toolMsg("r0", big(60_000)), // ~15k tokens — tier-0 fodder
    callMsg("r1"),
    toolMsg("r1", big(60_000)),
    callMsg("r2"),
    toolMsg("r2", big(2_000)), // recent AND small — never touched
    { role: "user", content: "continue" },
  ];

  it("a threshold-edge overflow clears (tier 0) and skips tier 1 entirely", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "", toolCalls: [{ id: "r3", name: "read_file", arguments: { path: "x" } }] },
      { role: "assistant", content: "cleared and done" },
    ]);
    const state: AgentState = {
      systemPrompt: "s",
      messages: hugeHistory(),
      tools: [],
      status: "idle",
    };
    // window 19000 → threshold 15200. Occupancy ≈ 30.5k ≥ threshold + 8192 →
    // immediate. Clearing the two oldest huge results (~30k tokens) fits back
    // under 15200 → tier 0 short-circuits tiers 1 and 2. minChars 1000 means
    // tier 1 WOULD have stubbed them had it run — the absence of any
    // "[compacted" stub proves it never did.
    const { events, terminal } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { verify: false },
      compaction: { contextWindowTokens: 19000, keepRecent: 2, minChars: 1000 },
    }));
    expect(terminal.reason).toBe("completed");
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.tier).toBe(0);
    expect(compacted[0]?.afterTokens).toBeLessThan(compacted[0]?.beforeTokens ?? Infinity);
    // Deterministic clear marker in the rebuilt history; NO tier-1 stubs.
    const cleared = state.messages.filter((m) => m.role === "tool" && m.content.startsWith(CLEARED_MARKER));
    expect(cleared).toHaveLength(2);
    expect(state.messages.some((m) => m.content.includes("[compacted"))).toBe(false);
    // Pairing-safe: every tool_call still has its tool result.
    const ids = new Set(state.messages.filter((m) => m.role === "tool").map((m) => (m as { toolCallId: string }).toolCallId));
    for (const m of state.messages) {
      if (m.role === "assistant" && m.toolCalls) {
        for (const c of m.toolCalls) expect(ids.has(c.id)).toBe(true);
      }
    }
  });

  it("falls through to the dearer tier when clearing cannot fit the threshold", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "S" },
      { role: "assistant", content: "summarized and done" },
    ]);
    // Big NON-tool content dominates: clearing tool results cannot fit.
    const bigText = big(4000);
    const state: AgentState = {
      systemPrompt: "s",
      messages: [
        { role: "user", content: bigText },
        { role: "assistant", content: bigText },
        callMsg("r0"),
        toolMsg("r0", big(60_000)),
        { role: "user", content: bigText },
        { role: "assistant", content: bigText },
        { role: "user", content: bigText },
        { role: "assistant", content: bigText },
      ],
      tools: [],
      status: "idle",
    };
    const { events } = await drain(runAgentLoop(state, model, {
      maxTurns: 4,
      gates: { verify: false },
      compaction: { contextWindowTokens: 3000, keepRecent: 2, minChars: 1000 },
    }));
    const compacted = events.filter((e): e is Extract<LoopEvent, { type: "compacted" }> => e.type === "compacted");
    expect(compacted.length).toBeGreaterThanOrEqual(1);
    expect(compacted.every((c) => c.tier !== 0)).toBe(true);
    expect(state.messages[0]?.content.startsWith("[compacted summary]")).toBe(true);
  });
});
