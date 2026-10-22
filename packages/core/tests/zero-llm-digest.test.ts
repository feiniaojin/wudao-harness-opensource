import { describe, it, expect } from "vitest";
import {
  tier2Compact,
  digestibleSpan,
  SUMMARY_MARKER,
  SUMMARY_END_MARKER,
  TODO_BOARD_PREFIX,
  parseTodoBoard,
  type AgentMessage,
} from "../src/index.js";
import { digestSummary, DIGEST_ASSISTANT_TEXT_CAP_CHARS, DIGEST_USER_TEXT_CAP_CHARS } from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";

// 波次 7 #38 (OH C2): the zero-LLM digest front stage of tier-2 compaction.
// OH's deterministic on-disk digest lets a compaction skip the LLM summary
// call when the deterministic form is SUFFICIENT. Wudao's tier-2 already has
// deterministic riders (task line ω-5b, file ledger 夜移030, board restore
// M23, skill reinjection M58 §C#11) and a zero-LLM STATIC FALLBACK — but the
// fallback only fires when the LLM call FAILS; the LLM is always attempted
// first. The port: a conservative SUFFICIENCY GATE — when the span's
// narrative is thin (both its user text and assistant text under small caps)
// there is nothing for a 300-word LLM summary to preserve that the digest
// (original-request quote + role counts + task line + ledger + board) does
// not already carry — so tier-2 skips the model call entirely. Any span over
// the caps keeps today's LLM path, byte-identical (zero-change witness).

const thinSpan: AgentMessage[] = [
  { role: "user", content: "fix the login bug" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "/w/src/a.ts" } }] },
  { role: "tool", toolCallId: "c1", name: "read_file", content: "file body" },
  { role: "assistant", content: "read it" },
  { role: "user", content: "next" },
];

/** A model that FAILS the test if the digest path ever leaks a call to it —
 *  the zero-LLM witness. */
const neverCallModel = () => {
  const m = createScriptedModel([]);
  return {
    async generate() {
      throw new Error("digest path must not call the model");
    },
    get calls() { return 0; },
    ...m,
  };
};

describe("digestibleSpan — the sufficiency gate (pure)", () => {
  it("a thin span (tool traffic, tiny texts) is digestible", () => {
    expect(digestibleSpan(thinSpan)).toBe(true);
  });
  it("assistant narrative over the cap is NOT digestible (facts to lose)", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "x".repeat(DIGEST_ASSISTANT_TEXT_CAP_CHARS + 1) },
      { role: "user", content: "next" },
    ];
    expect(digestibleSpan(span)).toBe(false);
  });
  it("user text over the cap is NOT digestible (beyond the quoted anchor)", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "y".repeat(DIGEST_USER_TEXT_CAP_CHARS + 1) },
      { role: "assistant", content: "ok" },
      { role: "user", content: "next" },
    ];
    expect(digestibleSpan(span)).toBe(false);
  });
  it("no non-empty user message → NOT digestible (no anchor to quote)", () => {
    const span: AgentMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: {} }] },
    ];
    expect(digestibleSpan(span)).toBe(false);
  });
  it("exactly at both caps is still digestible (boundary inclusive)", () => {
    const span: AgentMessage[] = [
      // "next" rides INSIDE the user budget — the totals land exactly on caps.
      { role: "user", content: "u".repeat(DIGEST_USER_TEXT_CAP_CHARS - 4) },
      { role: "assistant", content: "a".repeat(DIGEST_ASSISTANT_TEXT_CAP_CHARS) },
      { role: "user", content: "next" },
    ];
    expect(digestibleSpan(span)).toBe(true);
  });
});

describe("digestSummary — the deterministic body (pure)", () => {
  it("carries the span size, the original request, and role counts", () => {
    const body = digestSummary(thinSpan);
    expect(body).toContain("5 messages");
    expect(body).toContain("fix the login bug");
    expect(body).toContain("Deterministic context digest");
  });
});

describe("tier2Compact — the zero-LLM front stage", () => {
  it("a digestible span compacts with ZERO model calls (throwing-model witness)", async () => {
    const result = await tier2Compact(thinSpan, neverCallModel(), { keepRecent: 3 });
    expect(result).not.toBeNull();
    const summary = result!.messages[0]!;
    expect(summary.role).toBe("user");
    expect(summary.content.startsWith(SUMMARY_MARKER)).toBe(true);
    // The task line rides between marker and body (ω-5b seam, both paths).
    expect(summary.content).toContain("Task: fix the login bug");
    expect(summary.content).toContain("Deterministic context digest");
    expect(summary.content).toContain(SUMMARY_END_MARKER);
    expect(summary.content).toContain("task subagents");
    // The kept tail survives verbatim (shared assembly).
    expect(result!.messages.some((m) => m.content === "read it")).toBe(true);
  });

  it("zeroLlmDigest:false restores the always-LLM path (operator escape)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "SUMMARY-TEXT" }]);
    const result = await tier2Compact(thinSpan, model, { keepRecent: 3, zeroLlmDigest: false });
    expect(result!.messages[0]!.content).toContain("SUMMARY-TEXT");
    expect(result!.messages[0]!.content).not.toContain("Deterministic context digest");
  });

  it("a narrative span keeps today's LLM path (zero-change witness)", async () => {
    const dense: AgentMessage[] = [
      { role: "user", content: "task 1 " + "x".repeat(2000) },
      { role: "assistant", content: "answer 1 " + "y".repeat(2000) },
      { role: "user", content: "recent" },
      { role: "assistant", content: "answer 2" },
    ];
    const model = createScriptedModel([{ role: "assistant", content: "SUMMARY-TEXT" }]);
    const result = await tier2Compact(dense, model, { keepRecent: 1 });
    expect(result!.messages[0]!.content).toContain("SUMMARY-TEXT");
    expect(result!.messages[0]!.content).not.toContain("Deterministic context digest");
  });

  it("the deterministic riders ride the digest path too: board restore + file ledger", async () => {
    const board = "[todo board 1/2 done]\n☑ read the file\n◐ write the fix";
    const msgs: AgentMessage[] = [
      { role: "user", content: "do the task" },
      { role: "assistant", content: "", toolCalls: [{ id: "b1", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "b1", name: "todo_write", content: board },
      { role: "assistant", content: "", toolCalls: [
        { id: "c2", name: "read_file", arguments: { path: "/w/src/a.ts" } },
        { id: "c3", name: "write_file", arguments: { path: "/w/src/b.ts" } },
      ] },
      { role: "tool", toolCallId: "c2", name: "read_file", content: "a-body" },
      { role: "tool", toolCallId: "c3", name: "write_file", content: "wrote" },
      { role: "assistant", content: "done" },
      { role: "user", content: "recent" },
    ];
    const result = await tier2Compact(msgs, neverCallModel(), { keepRecent: 1 });
    expect(result).not.toBeNull();
    // File ledger tags ride the digest summary (夜移030 seam).
    const summary = result!.messages[0]!.content;
    expect(summary).toContain("<read-files>");
    expect(summary).toContain("/w/src/a.ts");
    expect(summary).toContain("<modified-files>");
    expect(summary).toContain("/w/src/b.ts");
    // The board is mechanically restored right after the summary (M23 §2).
    const restored = result!.messages[1]!;
    expect(restored.content.startsWith(`${TODO_BOARD_PREFIX} 1/2 done](restored)`)).toBe(true);
    expect(parseTodoBoard(restored.content)?.incomplete).toBe(1);
  });
});
