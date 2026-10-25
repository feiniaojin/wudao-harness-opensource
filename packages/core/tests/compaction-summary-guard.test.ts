// 调研引入弧 A（research-import-2026-10，prime-agent 压缩弧）——压缩质量
// 守卫包的确定性验收。验收清单即 prime 的事故清单：
//   A1（#3529）空/截断摘要拒绝 + 单次短重试：stop_reason 穷尽匹配——空白
//   但已计费的回复、试图调工具的「摘要」、被中止的碎片绝不进压缩行；
//   Length 截断重试一次（附更短指令），两次截断才落 truncated 标记。
//   A4（#3753/#3745）压缩通知累积泄漏防御：每次压缩重追加的通知封顶
//   200 条/4KB，与最新一份相同则跳过。
import { describe, it, expect } from "vitest";
import {
  guardSummaryReply,
  summaryStopReasonOf,
  SHORTER_SUMMARY_INSTRUCTION,
  SUMMARY_TRUNCATED_MARKER,
  COMPACT_NOTICE_MAX_ENTRIES,
  COMPACT_NOTICE_MAX_TOTAL_BYTES,
  compactNoticeReducer,
} from "../src/compaction-summary-guard.js";
import type { AssistantMessage } from "../src/types.js";

// ---------------------------------------------------------------------------
// A1 — guardSummaryReply：stop_reason 穷尽匹配（prime #3529 的验收清单）
// ---------------------------------------------------------------------------

describe("guardSummaryReply (A1, prime #3529)", () => {
  it("stop + non-empty text → accept", () => {
    expect(guardSummaryReply("the summary", "stop")).toEqual({ kind: "accept" });
  });

  it("tool_use → bail naming the stop reason (a tool-calling reply is not a summary)", () => {
    expect(guardSummaryReply("partial text", "tool_use")).toEqual({
      kind: "bail",
      reason: "stop_reason=tool_use",
    });
  });

  it("aborted → bail (a cancelled fragment must not replace the transcript)", () => {
    expect(guardSummaryReply("half a summary", "aborted")).toEqual({
      kind: "bail",
      reason: "stop_reason=aborted",
    });
  });

  it("error → bail (the provider-side failure shape)", () => {
    expect(guardSummaryReply("whatever", "error")).toEqual({
      kind: "bail",
      reason: "stop_reason=error",
    });
  });

  it("whitespace-only text bails for a clean stop (the blank-but-billed HTTP 200)", () => {
    expect(guardSummaryReply("  \n\t ", "stop")).toEqual({ kind: "bail", reason: "empty summary" });
  });

  it("empty text beats the length classification: empty + length bails, does NOT retry", () => {
    // prime #3529 ordering pin: the empty check runs after the stop-class
    // bails but BEFORE the truncated verdict — an empty length-stopped reply
    // is unusable, not retryable.
    expect(guardSummaryReply("", "length")).toEqual({ kind: "bail", reason: "empty summary" });
    expect(guardSummaryReply("   ", "length", { isRetry: true })).toEqual({
      kind: "bail",
      reason: "empty summary",
    });
  });

  it("length on the FIRST attempt → retry_shorter (exactly one retry, no loop)", () => {
    expect(guardSummaryReply("cut-off summary", "length")).toEqual({ kind: "retry_shorter" });
  });

  it("length on the RETRY → accept_truncated (the twice-capped reply still commits)", () => {
    expect(guardSummaryReply("shorter but still cut", "length", { isRetry: true })).toEqual({
      kind: "accept_truncated",
    });
  });

  it("the retry instruction and the truncation disclosure are pinned literals", () => {
    // 调用方的重试指令与落盘标记共用守卫域的单一真值点（prime 同词）。
    expect(SHORTER_SUMMARY_INSTRUCTION).toBe(
      "Your previous summary was cut off at the output limit. Write a shorter summary that fits: keep every required section and compress the detail.",
    );
    expect(SUMMARY_TRUNCATED_MARKER).toBe("[summary truncated: earlier detail may be missing]");
  });
});

describe("summaryStopReasonOf (A1 adapter: AssistantMessage → guard vocabulary)", () => {
  const msg = (fields: Partial<AssistantMessage>): AssistantMessage =>
    ({ role: "assistant", content: "s", ...fields }) as AssistantMessage;

  it("maps the OpenAI vocabulary and the interrupted flag", () => {
    expect(summaryStopReasonOf(msg({}))).toBe("stop"); // absent = unclassified, not failed
    expect(summaryStopReasonOf(msg({ stopReason: "stop" }))).toBe("stop");
    expect(summaryStopReasonOf(msg({ stopReason: "length" }))).toBe("length");
    expect(summaryStopReasonOf(msg({ stopReason: "tool_calls" }))).toBe("tool_use");
    expect(summaryStopReasonOf(msg({ interrupted: true }))).toBe("aborted");
    expect(summaryStopReasonOf(msg({ stopReason: "content_filter" }))).toBe("error");
    expect(summaryStopReasonOf(msg({ stopReason: "error" }))).toBe("error");
  });

  it("fail-closed on unknown vocabulary (a gateway coinage is unusable, never silently accepted)", () => {
    expect(summaryStopReasonOf(msg({ stopReason: "insufficient_system_resources" }))).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// A4 — compactNoticeReducer：累积封顶 + 与最新一份相同则跳过（prime #3753）
// ---------------------------------------------------------------------------

describe("compactNoticeReducer (A4, prime #3753/#3745)", () => {
  it("appends and accumulates notices oldest → newest", () => {
    const s1 = compactNoticeReducer([], "notice A");
    expect(s1).toEqual(["notice A"]);
    const s2 = compactNoticeReducer(s1, "notice B");
    expect(s2).toEqual(["notice A", "notice B"]);
  });

  it("skips an append identical to the NEWEST notice (returns the same state)", () => {
    const state: readonly string[] = ["old", "same"];
    expect(compactNoticeReducer(state, "same")).toBe(state); // same reference — nothing appended
    expect(compactNoticeReducer(state, "same")).toHaveLength(2);
  });

  it("an identical OLDER notice is NOT skipped — only the newest dedupes", () => {
    // 切点不动的压缩会保留旧副本；判重只对队尾（最新一份），重复的旧文本
    // 再出现仍是新事件（prime：与「最新一条还在上下文里的通知」比较）。
    expect(compactNoticeReducer(["same", "newer"], "same")).toEqual(["same", "newer", "same"]);
  });

  it("caps the log at 200 entries, evicting from the OLDEST side (newest survives)", () => {
    let state: readonly string[] = [];
    for (let i = 0; i < COMPACT_NOTICE_MAX_ENTRIES + 7; i += 1) {
      state = compactNoticeReducer(state, `notice ${i}`);
    }
    expect(state).toHaveLength(COMPACT_NOTICE_MAX_ENTRIES);
    // The oldest 7 were evicted; the newest is the last append.
    expect(state[0]).toBe("notice 7");
    expect(state[state.length - 1]).toBe(`notice ${COMPACT_NOTICE_MAX_ENTRIES + 6}`);
  });

  it("caps the log at 4KB of UTF-8 bytes, evicting oldest until it fits", () => {
    // 40-byte ASCII notices: 102 of them take 4096 bytes exactly; the 103rd
    // evicts from the head.
    const unit = "n".repeat(40);
    let state: readonly string[] = [];
    for (let i = 0; i < 103; i += 1) state = compactNoticeReducer(state, `${i.toString().padStart(3, "0")} ${unit}`.slice(0, 40));
    // 40 bytes × 102 = 4096 fits; 103 × 40 = 4120 > 4096 → one eviction.
    expect(state).toHaveLength(102);
    const total = state.reduce((n, t) => n + Buffer.byteLength(t), 0);
    expect(total).toBeLessThanOrEqual(COMPACT_NOTICE_MAX_TOTAL_BYTES);
  });

  it("counts UTF-8 bytes, not UTF-16 units: CJK notices hit the byte cap 3x sooner", () => {
    // 1365 个汉字 = 4095 UTF-8 bytes（每字 3 字节）——一条就几乎占满预算；
    // 若按 UTF-16 单元计数则只有 1365「字节」，封顶形同虚设。
    let state: readonly string[] = [];
    const cjkNotice = (tag: string) => `${tag} ${"语".repeat(1365)}`; // 3×1365 + tag > 4096 alone
    state = compactNoticeReducer(state, cjkNotice("a"));
    state = compactNoticeReducer(state, cjkNotice("b"));
    // 单条自身超预算也保留（队尾永不驱逐——prime「第一个名字永远列出」），
    // 但绝不再叠加：状态里始终只有最新那一条。
    expect(state).toEqual([cjkNotice("b")]);
  });

  it("a single oversized notice survives alone (the newest is never evicted)", () => {
    const huge = "x".repeat(COMPACT_NOTICE_MAX_TOTAL_BYTES * 3);
    expect(compactNoticeReducer([], huge)).toEqual([huge]);
    expect(compactNoticeReducer(["older"], huge)).toEqual([huge]);
  });
});
