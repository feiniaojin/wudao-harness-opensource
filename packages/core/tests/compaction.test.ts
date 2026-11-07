import { describe, it, expect } from "vitest";
import {
  estimateTokens, estimateTokensBreakdown, microcompact, COMPACTION_STUB_PREFIX,
  summarizeSpan, tier2Compact, applySummaryMarkers, SUMMARY_MARKER,
  capToLineBoundary, CJK_TOKENS_PER_CHAR, NON_CJK_CHARS_PER_TOKEN,
  emergencyDrop, EMERGENCY_DROP_PREFIX,
} from "../src/compaction.js";
import { IMAGE_TOKEN_ESTIMATE, estimateImageTokens } from "../src/attachments.js";
import type { ImageBlock } from "../src/attachments.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import { TODO_BOARD_PREFIX, parseTodoBoard } from "../src/tools/todo.js";
import type { AgentMessage } from "../src/types.js";

describe("estimateTokens", () => {
  it("is roughly chars/4 including tool schemas", () => {
    const tools = [{ name: "t", description: "abcd", parameters: { type: "object", properties: {} } }];
    const n = estimateTokens("sys", tools, [{ role: "user", content: "hi" }]);
    expect(n).toBeGreaterThan(0);
  });
  it("grows with message content", () => {
    const small = estimateTokens("s", [], [{ role: "user", content: "a" }]);
    const big = estimateTokens("s", [], [{ role: "user", content: "a".repeat(4000) }]);
    expect(big).toBeGreaterThan(small);
  });

  // ω-1 — script awareness: CJK text runs ≈1 token per char on the wudao
  // target models, so the flat chars/4 ratio under-counted Chinese-first
  // payloads 2–4× and delayed compaction past the real budget. The table is
  // built from the exported constants — no magic numbers.
  it("ω-1: counts CJK at ~1 token per char, non-CJK at chars/4, mixed as the sum", () => {
    const cjk9 = "语言模型上下文管理"; // exactly 9 Han chars
    const table: readonly { readonly name: string; readonly text: string; readonly want: number }[] = [
      { name: "pure ASCII keeps the legacy estimate", text: "a".repeat(40), want: Math.ceil(40 / NON_CJK_CHARS_PER_TOKEN) },
      { name: "pure CJK counts ~1 token per char", text: cjk9, want: 9 * CJK_TOKENS_PER_CHAR },
      { name: "mixed is the sum of its script parts", text: cjk9 + "a".repeat(40), want: 9 * CJK_TOKENS_PER_CHAR + Math.ceil(40 / NON_CJK_CHARS_PER_TOKEN) },
      { name: "astral-plane CJK (ext-B pairs) count once per code point", text: "𠮷".repeat(4), want: 4 * CJK_TOKENS_PER_CHAR },
    ];
    for (const c of table) {
      expect(estimateTokens("", [], [{ role: "user", content: c.text }]), c.name).toBe(c.want);
    }
  });

  it("ω-1: counts CJK across the same fields messageCharLength sums (tool name, tool result content, toolCall arguments)", () => {
    const cjkTool = estimateTokens("", [], [
      { role: "tool", toolCallId: "c0", name: "读取文件", content: "内容" }, // 4 + 2 = 6 CJK chars
    ]);
    expect(cjkTool).toBe(6 * CJK_TOKENS_PER_CHAR);
    const cjkArgs = estimateTokens("", [], [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { 路径: "值值值值值值值值" } }] }, // 2 + 8 = 10 CJK chars
    ]);
    // The serialized arguments carry non-CJK JSON scaffolding ({}":) too —
    // counted at chars/4 alongside the CJK code points.
    const argsUnits = JSON.stringify({ 路径: "值值值值值值值值" }).length;
    expect(cjkArgs).toBe(Math.ceil(10 * CJK_TOKENS_PER_CHAR + (argsUnits - 10) / NON_CJK_CHARS_PER_TOKEN));
    const cjkSystem = estimateTokens("系统", [], []); // 2 CJK chars
    expect(cjkSystem).toBe(2 * CJK_TOKENS_PER_CHAR);
    const cjkToolDef = estimateTokens("", [{ name: "t", description: "描述", parameters: { type: "object", properties: {} } }], []); // ≥2 CJK chars
    expect(cjkToolDef).toBeGreaterThanOrEqual(2 * CJK_TOKENS_PER_CHAR);
  });

  it("ω-1: the breakdown stays estimateTokens verbatim for CJK payloads", () => {
    const system = "语".repeat(400);
    const messages: AgentMessage[] = [
      { role: "user", content: "文".repeat(1200) },
      { role: "tool", toolCallId: "c0", name: "读取", content: "果".repeat(800) },
    ];
    const b = estimateTokensBreakdown(system, [], messages);
    expect(b.total).toBe(estimateTokens(system, [], messages));
    expect(b.total).toBe((400 + 1200 + 800 + 2) * CJK_TOKENS_PER_CHAR);
  });
});

// M76-ux2 §8 — the per-section estimates behind the StatusBar ctx hover
// (ctxInfo op): same chars/4 accounting as estimateTokens, split by prompt
// section. `total` is the COMBINED ceil (estimateTokens verbatim) so the
// hover's parts never disagree with the ctx watermark's occupancy measure;
// the per-section ceils can differ from it by rounding only.
describe("estimateTokensBreakdown (M76-ux2 §8)", () => {
  it("empty sections estimate to zero; the total matches estimateTokens", () => {
    const b = estimateTokensBreakdown("", [], []);
    expect(b).toEqual({ systemTokens: 0, toolsTokens: 0, messagesTokens: 0, imagesTokens: 0, total: 0 });
    expect(b.total).toBe(estimateTokens("", [], []));
  });

  it("splits by section at chars/4: system, tool schemas, message content", () => {
    const tools = [{ name: "t", description: "abcd", parameters: { type: "object", properties: {} } }];
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(4000) },
      // assistant tool_calls + tool results count their serialized parts too
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "a".repeat(400) } }] },
      { role: "tool", toolCallId: "c0", name: "read_file", content: "y".repeat(8000) },
    ];
    const b = estimateTokensBreakdown("s".repeat(400), tools, messages);
    expect(b.systemTokens).toBe(100);
    // message chars = user content + serialized toolCall arguments + tool
    // result content + the tool result's name
    const msgChars = 4000 + JSON.stringify({ path: "a".repeat(400) }).length + 8000 + "read_file".length;
    expect(b.messagesTokens).toBe(Math.ceil(msgChars / 4));
    expect(b.toolsTokens).toBe(Math.ceil(JSON.stringify(tools[0]).length / 4));
    expect(b.toolsTokens).toBeGreaterThan(0);
    expect(b.total).toBe(estimateTokens("s".repeat(400), tools, messages));
  });

  it("per-section ceils sum to the total when every section is char-aligned", () => {
    const b = estimateTokensBreakdown("a".repeat(400), [], [{ role: "user", content: "b".repeat(800) }]);
    expect(b.systemTokens + b.toolsTokens + b.messagesTokens).toBe(b.total);
  });
});

// ---------------------------------------------------------------------------
// R5-I1 — images count toward the token estimates. Image blocks ride
// `m.images` (durable refs; `ref.byteLength` is the decoded byte count) and
// used to contribute ZERO: nine images could hold the ctx bar at "ctx 12%"
// while the real prompt flirted with the window. The estimate is pure
// arithmetic over byteLength — the bytes are never read — so it stays
// deterministic, and text-only inputs estimate byte-identically to before.
// ---------------------------------------------------------------------------

const imgBlock = (byteLength: number): ImageBlock => ({
  kind: "image",
  ref: { kind: "image", attachmentId: "00000000-0000-4000-8000-000000000000", mediaType: "image/png", byteLength },
});

describe("estimateImageTokens (R5-I1)", () => {
  it("is the flat base plus a byte-scaled term (ceil, never reads bytes)", () => {
    expect(IMAGE_TOKEN_ESTIMATE.base).toBe(85);
    expect(IMAGE_TOKEN_ESTIMATE.bytesPerToken).toBe(750);
    expect(estimateImageTokens(0)).toBe(85);
    expect(estimateImageTokens(750)).toBe(86);
    expect(estimateImageTokens(751)).toBe(87); // ceil, not round
    expect(estimateImageTokens(1_048_576)).toBe(85 + 1399); // ~1 MiB screenshot
  });
});

describe("estimateTokens with images (R5-I1)", () => {
  it("counts every image rider on user AND tool messages", () => {
    const textOnly = estimateTokens("s", [], [
      { role: "user", content: "look" },
      { role: "tool", toolCallId: "c0", name: "shot", content: "r" },
    ]);
    const withImages = estimateTokens("s", [], [
      { role: "user", content: "look", images: [imgBlock(2_200_000)] },
      { role: "tool", toolCallId: "c0", name: "shot", content: "r", images: [imgBlock(1500), imgBlock(1500)] },
    ]);
    const imageTerm = estimateImageTokens(2_200_000) + 2 * estimateImageTokens(1500);
    expect(withImages).toBe(textOnly + imageTerm);
  });

  it("nine ~2 MiB images move the estimate by their full term (the R5-I1 finding)", () => {
    const nine: AgentMessage[] = Array.from({ length: 9 }, () => ({
      role: "user" as const,
      content: "shot",
      images: [imgBlock(2_200_000)],
    }));
    const stripped: AgentMessage[] = nine.map((m) => ({ role: m.role, content: m.content }));
    const textOnly = estimateTokens("s", [], stripped);
    expect(estimateTokens("s", [], nine)).toBe(textOnly + 9 * estimateImageTokens(2_200_000));
    // Honest pressure: 9 × (85 + ceil(2.2M/750)) ≈ 27k tokens — ~42% of a
    // 64k window on its own, where the pre-fix estimate contributed nothing.
    expect(9 * estimateImageTokens(2_200_000)).toBeGreaterThan(25_000);
  });

  it("TEXT-ONLY PARITY PIN: byte-identical to the pre-R5-I1 chars/4 formula", () => {
    const tools = [{ name: "t", description: "abcd", parameters: { type: "object", properties: {} } }];
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(4000) },
      { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "a".repeat(40) } }] },
      { role: "tool", toolCallId: "c0", name: "read_file", content: "y".repeat(8000) },
      { role: "assistant", content: "done" },
    ];
    // The pre-R5-I1 estimator, inline: chars/4 over system + serialized
    // tools + message chars. Images added a strict +0 term, so text-only
    // outputs must equal this exactly — no drift for existing sessions.
    const msgChars = messages.reduce(
      (n, m) =>
        n + m.content.length +
        (m.role === "assistant" && m.toolCalls
          ? m.toolCalls.reduce((a, tc) => a + JSON.stringify(tc.arguments).length, 0)
          : m.role === "tool"
            ? m.name.length
            : 0),
      0,
    );
    const toolChars = tools.reduce((n, t) => n + JSON.stringify(t).length, 0);
    const pre = Math.ceil((("s".repeat(400)).length + toolChars + msgChars) / 4);
    expect(estimateTokens("s".repeat(400), tools, messages)).toBe(pre);
    const b = estimateTokensBreakdown("s".repeat(400), tools, messages);
    expect(b.imagesTokens).toBe(0);
    expect(b.total).toBe(pre);
  });
});

describe("estimateTokensBreakdown with images (R5-I1)", () => {
  it("adds the images dimension; total stays estimateTokens verbatim", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "x".repeat(400), images: [imgBlock(75_000)] },
    ];
    const b = estimateTokensBreakdown("s", [], messages);
    expect(b.imagesTokens).toBe(estimateImageTokens(75_000));
    expect(b.messagesTokens).toBe(100); // text chars/4 unchanged by riders
    expect(b.total).toBe(estimateTokens("s", [], messages));
    expect(b.total).toBe(b.systemTokens + b.messagesTokens + b.imagesTokens);
  });

  it("reports imagesTokens 0 (not undefined) when no message carries images", () => {
    const b = estimateTokensBreakdown("s", [], [{ role: "user", content: "hi" }]);
    expect(b.imagesTokens).toBe(0);
    expect(b.total).toBe(estimateTokens("s", [], [{ role: "user", content: "hi" }]));
  });
});

describe("microcompact", () => {
  const big = "x".repeat(2000);
  const base: AgentMessage[] = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", toolCalls: [{ id: "c0", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "c0", name: "read_file", content: big },
  ];

  it("stubs an old, large tool result", () => {
    // ω-3b hand-check: `base` ends at the unseen result (its assistant is the
    // last message) — stubbing it was the over-stub the floor closes. A
    // responding text assistant makes the result SEEN and keeps this pin
    // about the stub itself (shape/length/pairing) exercised.
    const msgs: AgentMessage[] = [...base, { role: "assistant", content: "done" }];
    const out = microcompact(msgs, { keepRecent: 0, minChars: 1000 });
    const r = out[2];
    expect(r?.role).toBe("tool");
    if (r.role === "tool") {
      expect(r.content.startsWith(COMPACTION_STUB_PREFIX)).toBe(true);
      expect(r.content.length).toBeLessThan(big.length);
      expect(r.toolCallId).toBe("c0"); // pairing preserved
    }
  });

  it("keeps recent messages verbatim (within keepRecent)", () => {
    // M52: keepRecent 2 protects the call+result pair at the tail; keepRecent 1
    // would split the pair at the boundary — the aligned cutoff pulls the
    // straddling result into the stubbable span instead (see m52 tests).
    const out = microcompact(base, { keepRecent: 2, minChars: 1000 });
    expect(out[2]).toBe(base[2]); // the tool result is within the pair-safe window → untouched
  });

  it("does not stub small results", () => {
    const small: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "t", content: "tiny" },
    ];
    const out = microcompact(small, { keepRecent: 0, minChars: 1000 });
    expect(out[2]).toEqual(small[2]);
  });

  it("is idempotent (re-stubbing is a no-op)", () => {
    // ω-3b hand-check: same seen-shape repair as above — without the ack the
    // first pass stubs nothing and the idempotence pin runs vacuously.
    const msgs: AgentMessage[] = [...base, { role: "assistant", content: "done" }];
    const once = microcompact(msgs, { keepRecent: 0, minChars: 1000 });
    const twice = microcompact(once, { keepRecent: 0, minChars: 1000 });
    expect(twice).toEqual(once);
  });

  it("preserves the matching tool_call (pairing intact)", () => {
    // ω-3b hand-check: same seen-shape repair (see "stubs an old, large").
    const msgs: AgentMessage[] = [...base, { role: "assistant", content: "done" }];
    const out = microcompact(msgs, { keepRecent: 0, minChars: 1000 });
    const call = out[1];
    expect(call?.role).toBe("assistant");
    if (call.role === "assistant") expect(call.toolCalls?.[0]?.id).toBe("c0");
  });
});

describe("summarizeSpan", () => {
  const replay = (messages: AgentMessage[]) => ({ systemPrompt: "s", tools: [], messages });
  it("asks the model for a summary of the span", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "  the summary  " }]);
    const out = await summarizeSpan(replay([{ role: "user", content: "do things" }]), model);
    expect(out).toBe("the summary");
  });
  it("falls back to a placeholder when the model returns empty", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "   " }]);
    const out = await summarizeSpan(replay([{ role: "user", content: "do things" }]), model);
    expect(out).toBe("(empty summary)");
  });
});

describe("tier2Compact", () => {
  const big = "x".repeat(2000);
  const base: AgentMessage[] = [
    { role: "user", content: "task 1 " + big },
    { role: "assistant", content: "answer 1 " + big },
    { role: "user", content: "task 2" },
  ];
  it("summarizes the old span into one frozen message, keeps recent", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "SUMMARY-TEXT" }]);
    // ω-3b hand-check: `base` ended at the second user message, so the span
    // would have swallowed the LAST assistant — the floor now keeps it
    // verbatim. A trailing ack assistant restores the intended shape (span
    // [U, A, U] summarized, everything from the last assistant kept recent).
    const msgs: AgentMessage[] = [...base, { role: "assistant", content: "answer 2" }];
    const result = await tier2Compact(msgs, model, { keepRecent: 1 });
    expect(result).not.toBeNull();
    // ω-5b (I22) re-record: the derived task line rides between the marker
    // and the LLM body (span's first user message capped at 200 chars).
    expect(result!.messages[0]?.content).toContain(`${SUMMARY_MARKER} Task: task 1 ${"x".repeat(193)}\nSUMMARY-TEXT`);
    expect(result!.messages[0]?.content).toContain("task subagents"); // wrap-up note rides the summary
    expect(result!.messages[1]?.content).toBe("answer 2");
    expect(result!.messages).toHaveLength(2);
    expect(result!.summaryMessage.content).toContain("SUMMARY-TEXT");
  });
  it("returns null when nothing compactable (all summarized)", async () => {
    const model = createScriptedModel([]);
    const all: AgentMessage[] = [{ role: "user", content: `${SUMMARY_MARKER} old` }, { role: "user", content: "new" }];
    expect(await tier2Compact(all, model, { keepRecent: 1 })).toBeNull();
  });
  it("returns null when everything is within keepRecent", async () => {
    const model = createScriptedModel([]);
    expect(await tier2Compact([{ role: "user", content: "only" }], model, { keepRecent: 6 })).toBeNull();
  });
  it("does not split a tool_call from its result (pairing-safe boundary)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const msgs: AgentMessage[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "data" },
      // ω-3b hand-check: the pair used to end the list unseen — summarizing
      // it was the over-stub the floor closes. The ack makes it SEEN; the
      // M52 walk (raw cutoff ON the result) is still exercised below.
      { role: "assistant", content: "read the data" },
      { role: "user", content: "next" },
    ];
    // 波次 7 #38: the span is thin, so the digest gate would skip the LLM —
    // but this test asserts the scripted model's summary text ("S").
    const result = await tier2Compact(msgs, model, { keepRecent: 3, zeroLlmDigest: false });
    // cutoff would start at the `tool` message → advanced past it → the pair is summarized together
    const kept = result!.messages.slice(1);
    expect(kept.some((m) => m.role === "tool")).toBe(false);
    expect(result!.messages[0]?.content).toContain("S");
  });
});

describe("tier2Compact — deterministic todo-board re-injection (M23 §2)", () => {
  const boardContent = "[todo board 2/4 done]\n☑ read workspace.ts\n☑ add helper\n◐ symlink tests\n☐ deny test";
  // A board tool result deep in the compacted span (NOT in keepRecent).
  // ω-3b hand-check: the board result used to end the exchange unseen —
  // spanning it was the over-stub the floor closes. The ack assistant makes
  // the board SEEN so the span still covers it.
  const withBoard: AgentMessage[] = [
    { role: "user", content: "task 1 " + "x".repeat(2000) },
    { role: "assistant", content: "", toolCalls: [{ id: "c9", name: "todo_write", arguments: {} }] },
    { role: "tool", toolCallId: "c9", name: "todo_write", content: boardContent },
    { role: "assistant", content: "board updated" },
    { role: "user", content: "recent task" },
  ];

  it("mechanically re-injects the last board as a user message right after the summary", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "SUMMARY-TEXT" }]);
    const result = await tier2Compact(withBoard, model, { keepRecent: 1 });
    expect(result).not.toBeNull();
    const [summary, restored] = result!.messages;
    expect(summary?.content.startsWith(SUMMARY_MARKER)).toBe(true);
    // user role (avoids orphan tool_call), first line carries (restored)
    expect(restored?.role).toBe("user");
    expect(restored?.content.startsWith(`${TODO_BOARD_PREFIX} 2/4 done](restored)`)).toBe(true);
    // The item lines ride along VERBATIM (byte-identical continuation).
    const firstNl = boardContent.indexOf("\n");
    expect(restored?.content.slice(restored!.content.indexOf("\n") + 1)).toBe(boardContent.slice(firstNl + 1));
    // Still parseable by the single recognizer.
    const parsed = parseTodoBoard(restored!.content);
    expect(parsed?.incomplete).toBe(2);
  });

  it("picks the LAST board in the span when several exist", async () => {
    const newer = "[todo board 1/1 done]\n☑ everything";
    const msgs: AgentMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "a", name: "todo_write", content: boardContent },
      { role: "assistant", content: "", toolCalls: [{ id: "b", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "b", name: "todo_write", content: newer },
      // ω-3b hand-check: ack so the SECOND board is seen and span-covered.
      { role: "assistant", content: "done with boards" },
      { role: "user", content: "recent" },
    ];
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const result = await tier2Compact(msgs, model, { keepRecent: 1 });
    expect(result!.messages[1]?.content.startsWith(`${TODO_BOARD_PREFIX} 1/1 done](restored)`)).toBe(true);
  });

  it("no board in the span → behavior unchanged (no restored message)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const base: AgentMessage[] = [
      { role: "user", content: "task 1 " + "x".repeat(2000) },
      { role: "assistant", content: "answer 1" },
      { role: "user", content: "recent" },
    ];
    const result = await tier2Compact(base, model, { keepRecent: 1 });
    expect(result).not.toBeNull();
    // ω-3b: the floor keeps the LAST assistant verbatim, so the kept region
    // is [answer 1, recent] (the old shape had no assistant and no span at
    // all — floor 0 means nothing stubbable).
    expect(result!.messages).toHaveLength(3); // summary + kept recent pair, nothing else
    expect(result!.messages[1]?.content).toBe("answer 1");
    expect(result!.messages[2]?.content).toBe("recent");
    expect(result!.messages.some((m) => m.content.includes("(restored)"))).toBe(false);
  });

  it("board in the KEPT region is left alone (no duplicate injection)", async () => {
    const model = createScriptedModel([{ role: "assistant", content: "S" }]);
    const msgs: AgentMessage[] = [
      { role: "user", content: "old " + "x".repeat(2000) },
      { role: "user", content: "mid" },
      // ω-3b hand-check: the board used to be an ORPHAN result ending the
      // list (no assistant at all — floor 0, nothing compactable). Give the
      // board its caller plus an ack; keepRecent 4 keeps the pair out of the
      // span so the board stays in the KEPT region, as this test pins.
      { role: "assistant", content: "", toolCalls: [{ id: "k", name: "todo_write", arguments: {} }] },
      { role: "tool", toolCallId: "k", name: "todo_write", content: boardContent },
      { role: "assistant", content: "ack" },
      { role: "user", content: "tail" },
    ];
    const result = await tier2Compact(msgs, model, { keepRecent: 4 });
    // The board itself is a kept message — verbatim, not re-wrapped.
    expect(result!.messages[2]?.content).toBe(boardContent);
    expect(result!.messages.some((m) => m.content.includes("(restored)"))).toBe(false);
  });

  it("is idempotent: compacting a history that already contains a restored board does not duplicate it", async () => {
    const model = createScriptedModel([
      { role: "assistant", content: "S1" },
      { role: "assistant", content: "S2" },
    ]);
    const first = await tier2Compact(withBoard, model, { keepRecent: 1 });
    expect(first).not.toBeNull();
    // Grow the history so the previous result (summary + restored board) now
    // falls inside the next compactable span.
    const grown: AgentMessage[] = [...first!.messages, { role: "user", content: "more " + "y".repeat(2000) }, { role: "user", content: "latest" }];
    const second = await tier2Compact(grown, model, { keepRecent: 1 });
    expect(second).not.toBeNull();
    const boardMessages = second!.messages.filter((m) => m.content.startsWith(TODO_BOARD_PREFIX));
    expect(boardMessages).toHaveLength(1); // exactly one board, the fresh restored copy
    expect(boardMessages[0]?.content.includes("(restored)")).toBe(true);
  });

  it("the summarizer prompt demands the in-progress item and edited files", async () => {
    const seen: ModelInput[] = [];
    const scripted = createScriptedModel([{ role: "assistant", content: "S" }]);
    const model: ModelClient = {
      generate: async (input: ModelInput) => {
        seen.push(input);
        return scripted.generate(input);
      },
    };
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "history" }] }, model);
    const prompt = JSON.stringify(seen[0]?.messages);
    // 2026-11-06 质量弧：模板换成结构化 8 段后，「当前进行项 / 正在改的文件」
    // 由第 5、6 段承载（原来的单句要求已并入模板）。
    expect(prompt).toContain("5. Pending Tasks");
    expect(prompt).toContain("6. Current Work");
  });
});

describe("capToLineBoundary", () => {
  it("backs off to the last newline when the cap cuts mid-line", () => {
    // 24000 chars total; the char at index 23999 is mid-line (no newline nearby).
    const line = "a".repeat(100); // 101 chars per line including \n
    const text = Array.from({ length: 240 }, () => line).join("\n"); // 240*100 + 239 = 24239 chars
    const out = capToLineBoundary(text, 24000);
    expect(out.length).toBeLessThan(24000);
    expect(out.endsWith("\n")).toBe(true);
    // No partial trailing line: every line in the output is exactly 100 chars
    // (the trailing "" after the final \n is dropped by slice(0, -1)).
    for (const l of out.split("\n").slice(0, -1)) expect(l.length).toBe(100);
  });
  it("returns text shorter than the cap unchanged", () => {
    const text = "short\ntext\n";
    expect(capToLineBoundary(text, 24000)).toBe(text);
  });
  it("returns exactly-cap text unchanged", () => {
    const text = "x".repeat(24000);
    expect(capToLineBoundary(text, 24000)).toBe(text);
  });
});

describe("applySummaryMarkers", () => {
  it("resets history at a marker", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: `${SUMMARY_MARKER} s1` },
      { role: "user", content: "new1" },
    ];
    expect(applySummaryMarkers(msgs).map((m) => m.content)).toEqual([`${SUMMARY_MARKER} s1`, "new1"]);
  });
  it("chains: a later marker supersedes", () => {
    const msgs: AgentMessage[] = [
      { role: "user", content: "old" },
      { role: "user", content: `${SUMMARY_MARKER} s1` },
      { role: "user", content: "mid" },
      { role: "user", content: `${SUMMARY_MARKER} s2` },
      { role: "user", content: "new" },
    ];
    expect(applySummaryMarkers(msgs).map((m) => m.content)).toEqual([`${SUMMARY_MARKER} s2`, "new"]);
  });
  it("no markers → unchanged", () => {
    const msgs: AgentMessage[] = [{ role: "user", content: "a" }, { role: "assistant", content: "b" }];
    expect(applySummaryMarkers(msgs)).toEqual(msgs);
  });
});

// ω-2b emergency-drop role gate (carry ticket from doc 40, line 109) — the
// pure tier's idempotence check used to short-circuit on ANY message whose
// content starts with EMERGENCY_DROP_PREFIX, so an assistant turn that merely
// QUOTED the marker (e.g. in reasoning or mid-conversation echo) silently
// disarmed the ladder's one-shot bound on the next retry. The gate must be
// `role === "user"` (matching emergencyPinned's pattern at line 490-491);
// only the count-marker we ourselves spliced is the real disarm signal.
describe("emergencyDrop — idempotence role gate (ω-2b carry)", () => {
  const base: AgentMessage[] = [
    { role: "user", content: "task head" },
    { role: "user", content: "u1 " + "x".repeat(2_000) },
    { role: "assistant", content: "a1 " + "y".repeat(4) },
    { role: "user", content: "u2 " + "x".repeat(2_000) },
    { role: "assistant", content: "a2 " + "y".repeat(4) },
    { role: "user", content: "tail" },
  ];
  // keepRecent: 2 keeps the droppable region [1, cutoff) non-empty for these
  // short fixtures (default 6 would keep everything on a 7-message list and
  // cutoff would clamp to 1 — the `cutoff <= 1` null path, not the gate).
  const opts = { fitsTokens: Number.POSITIVE_INFINITY, systemPrompt: "s", tools: [], keepRecent: 2 };

  it("a user-spliced EMERGENCY_DROP_PREFIX marker still disarms (regression guard)", () => {
    // The genuine marker — role === "user" — IS the ladder's one-shot bound.
    const spliced = [
      ...base,
      { role: "user", content: `${EMERGENCY_DROP_PREFIX} 4 oldest messages were removed to fit the context window]` },
    ] satisfies AgentMessage[];
    expect(emergencyDrop(spliced, opts)).toBeNull();
  });

  it("an assistant turn that merely QUOTES the marker prefix does NOT disarm the ladder", () => {
    // Two-part assertion (per ticket):
    // (a) WITH both user + assistant marker messages present, the user marker
    //     wins — the gate still trips, the result is null (existing contract).
    const userMarker: AgentMessage = {
      role: "user",
      content: `${EMERGENCY_DROP_PREFIX} 4 oldest messages were removed to fit the context window]`,
    };
    const assistantEcho: AgentMessage = {
      role: "assistant",
      // Assistant reproduces the marker verbatim AT THE START of its turn
      // (e.g. echoing the count-marker back while summarizing what happened).
      // The startswith predicate trips on this; ONLY the role gate separates
      // it from the genuine user-spliced marker — pre-fix, the bare
      // `startsWith(EMERGENCY_DROP_PREFIX)` predicate disarmed the ladder
      // here and the next retry silently went no-op.
      content: `${EMERGENCY_DROP_PREFIX} 4 oldest messages were removed to fit the context window] …or so the transcript says.`,
    };
    const bothPresent = [...base, userMarker, assistantEcho];
    expect(emergencyDrop(bothPresent, opts)).toBeNull();

    // (b) WITH ONLY the assistant quote present (no genuine user marker), the
    //     ladder must still ATTEMPT the drop — i.e. NOT short-circuit. Before
    //     the fix this returned null and defeated the one-shot bound on retry.
    const onlyAssistantQuote: AgentMessage[] = [...base, assistantEcho];
    const res = emergencyDrop(onlyAssistantQuote, opts);
    expect(res).not.toBeNull();
    // The drop produced exactly one USER-role count-marker (the spliced one) —
    // the producer-side invariant. The assistant echo itself legitimately
    // survives in the kept tail (it is content, not a marker); only counting
    // role-gated markers separates the two.
    const markers = res!.messages.filter((m) => m.role === "user" && m.content.startsWith(EMERGENCY_DROP_PREFIX));
    expect(markers).toHaveLength(1);
    expect(res!.messages).toContainEqual(assistantEcho);
  });

  it("a TOOL-role echo of the marker prefix does NOT disarm the ladder either (#104 review Minor 1)", () => {
    // The gate's contract is `role === "user"` — not "any non-assistant
    // role". A tool result can legitimately lead with the count-marker head
    // (e.g. a grep/read of the session file echoing a pasted marker): that
    // is runtime content, not the ladder's disarm signal. A regression that
    // widened the gate to `m.role !== "assistant"` would re-arm the silent
    // no-op bug through the tool channel — only an equality gate on role
    // (user only) separates the two, which is why this mirrors the (b) shape.
    const toolEcho: AgentMessage = {
      role: "tool",
      toolCallId: "call-tool-echo",
      name: "read_file",
      content: `${EMERGENCY_DROP_PREFIX} 4 oldest messages were removed to fit the context window — the full history remains in the session file]`,
    };
    // Only the tool echo present (no genuine user marker) — the ladder must
    // still ATTEMPT the drop, NOT short-circuit.
    const onlyToolEcho: AgentMessage[] = [...base, toolEcho];
    const res = emergencyDrop(onlyToolEcho, opts);
    expect(res).not.toBeNull();
    // Exactly one USER-role count-marker spliced; the tool echo itself
    // survives in the kept tail (it is content, not a marker).
    const markers = res!.messages.filter((m) => m.role === "user" && m.content.startsWith(EMERGENCY_DROP_PREFIX));
    expect(markers).toHaveLength(1);
    expect(res!.messages).toContainEqual(toolEcho);
  });
});
