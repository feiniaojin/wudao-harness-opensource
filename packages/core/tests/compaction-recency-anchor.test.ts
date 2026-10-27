// 113-B1（prime-agent #2385 形）— 压缩摘要的 kept-tail recency anchor：
//   ① 摘要请求的尾指令织入最新 kept-tail assistant 文本（<recent-state-anchor>，
//      截 500 字），replay 前缀字节零改（M24——缓存代价声明为 0）；
//   ② compact 边界后的 summary message 追加常量权威行「保留的消息权威于本摘要」
//      （边界新内容，零缓存牵涉）；kept tail 本身字节零改（assembleTier2 的
//      retainedTail 契约逐字节钉住）；
//   ③ 无锚/空尾 = 状态quo 字节（指令与消息逐字节等于旧形态）。
import { describe, it, expect } from "vitest";
import {
  tier2Compact,
  dualTier2Compact,
  staticTier2Compact,
  summarizeSpan,
  SUMMARY_MARKER,
  recencyAnchorOf,
  summaryAuthorityLine,
  SUMMARY_AUTHORITY_LINE,
  RECENCY_ANCHOR_CAP_CHARS,
} from "../src/compaction.js";
import type { ModelClient, ModelInput } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

const STATUS_QUO_INSTRUCTION =
  "Summarize the conversation above for continuation (max 300 words, preserving key facts, decisions, file paths, and open tasks). Always mention: the current in-progress todo item and the files currently being edited.";

/** A model that records every ModelInput and answers one fixed body. */
function recordingModel(answer = "SUMMARY-BODY"): { model: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  return {
    inputs,
    model: {
      async generate(input: ModelInput) {
        inputs.push(input);
        return { role: "assistant", content: answer };
      },
    },
  };
}

describe("113-B1 — recencyAnchorOf / summaryAuthorityLine（纯层）", () => {
  it("picks the LATEST kept-tail assistant text; toolCalls-only and non-assistant messages never anchor", () => {
    const tail: AgentMessage[] = [
      { role: "assistant", content: "older state" },
      { role: "user", content: "a question" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      { role: "tool", toolCallId: "c1", name: "shell", content: "output" },
      { role: "assistant", content: "the build is green now" },
    ];
    expect(recencyAnchorOf(tail)).toBe("the build is green now");
    // Latest-first scan: an older assistant never wins over a newer one.
    expect(recencyAnchorOf(tail.slice(0, 2))).toBe("older state");
    // Whitespace-only assistants are skipped; no assistant at all → undefined.
    expect(recencyAnchorOf([{ role: "user", content: "only" }, { role: "assistant", content: "   " }])).toBeUndefined();
    expect(recencyAnchorOf([{ role: "user", content: "only" }])).toBeUndefined();
    expect(recencyAnchorOf([])).toBeUndefined();
  });

  it("caps the anchor at RECENCY_ANCHOR_CAP_CHARS (~500), cutting at a line boundary when one exists", () => {
    const multiLine = `line one\n${"z".repeat(RECENCY_ANCHOR_CAP_CHARS + 200)}`;
    const capped = recencyAnchorOf([{ role: "assistant", content: multiLine }]);
    // The first line fits whole under the cap — the boundary cut keeps it.
    expect(capped).toBe("line one");
    const oneLine = recencyAnchorOf([{ role: "assistant", content: "x".repeat(RECENCY_ANCHOR_CAP_CHARS + 50) }]);
    expect(oneLine!.length).toBe(RECENCY_ANCHOR_CAP_CHARS);
  });

  it("the authority line rides iff the boundary retained messages (an empty tail would make it a lie)", () => {
    expect(summaryAuthorityLine(0)).toBe("");
    expect(summaryAuthorityLine(1)).toBe(`\n${SUMMARY_AUTHORITY_LINE}`);
    expect(summaryAuthorityLine(5)).toBe(`\n${SUMMARY_AUTHORITY_LINE}`);
  });
});

describe("113-B1 — summarizeSpan：锚骑尾指令位，replay 前缀字节零改", () => {
  const span: AgentMessage[] = [
    { role: "user", content: "do things " + "x".repeat(100) },
    { role: "assistant", content: "did part of it" },
    { role: "user", content: "continue" },
  ];

  it("weaves the anchor into the TAIL instruction; the replayed prefix above it is untouched", async () => {
    const rec = recordingModel();
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: span, recencyAnchor: "the build is green now" }, rec.model);
    expect(rec.inputs).toHaveLength(1);
    const got = rec.inputs[0]!;
    // The replayed prefix: the span's messages, byte-identical, then ONE
    // trailing instruction that carries the anchor.
    expect(got.messages.slice(0, -1)).toEqual(span);
    const instruction = got.messages[got.messages.length - 1]!;
    expect(instruction.role).toBe("user");
    expect(String(instruction.content)).toContain("<recent-state-anchor>");
    expect(String(instruction.content)).toContain("the build is green now");
    expect(String(instruction.content).startsWith(STATUS_QUO_INSTRUCTION)).toBe(true);
  });

  it("absent anchor leaves the instruction byte-identical to the status quo (M58 §C#2 律)", async () => {
    const rec = recordingModel();
    await summarizeSpan({ systemPrompt: "s", tools: [], messages: span }, rec.model);
    const instruction = rec.inputs[0]!.messages.at(-1)!;
    expect(String(instruction.content)).toBe(STATUS_QUO_INSTRUCTION);
  });
});

describe("113-B1 — tier2Compact：锚注入 + 权威行 + kept tail 字节零改", () => {
  // A fat span (past the digest caps) so the LLM lane runs; a keep-recent
  // tail with TWO assistants so latest-wins is provable on the wire.
  const fat = "y".repeat(900);
  const messages: AgentMessage[] = [
    { role: "user", content: `task ${fat}` },
    { role: "assistant", content: `old span answer ${fat}` },
    { role: "user", content: "next" },
    { role: "assistant", content: "mid tail state" },
    { role: "user", content: "more" },
    { role: "assistant", content: "the build is green now" },
  ];

  it("derives the anchor from the LATEST kept-tail assistant and injects it into the summary request", async () => {
    const rec = recordingModel();
    const out = await tier2Compact(messages, rec.model, { keepRecent: 3, zeroLlmDigest: false });
    expect(out).not.toBeNull();
    expect(rec.inputs).toHaveLength(1);
    const instruction = String(rec.inputs[0]!.messages.at(-1)!.content);
    expect(instruction).toContain("<recent-state-anchor>");
    expect(instruction).toContain("the build is green now");
    expect(instruction).not.toContain("mid tail state"); // LATEST wins, older tail state stays out
  });

  it("the summary message carries the authority line; the kept tail survives byte-for-byte", async () => {
    const rec = recordingModel();
    const out = await tier2Compact(messages, rec.model, { keepRecent: 3, zeroLlmDigest: false });
    expect(out!.summaryMessage.content).toContain(SUMMARY_AUTHORITY_LINE);
    const tail = messages.slice(3);
    // The retained tail is the ORIGINAL bytes — JSON equality on every message.
    expect(out!.retainedTail).toEqual(tail);
    expect(out!.messages.slice(-tail.length)).toEqual(tail);
  });

  it("the zero-LLM digest path makes no model call, carries the authority line, and no anchor anywhere", async () => {
    const thin: AgentMessage[] = [
      { role: "user", content: "small task" },
      { role: "assistant", content: "small answer" },
      { role: "user", content: "follow-up" },
      { role: "assistant", content: "kept fresh state" },
    ];
    const rec = recordingModel();
    const out = await tier2Compact(thin, rec.model, { keepRecent: 2 });
    expect(out).not.toBeNull();
    expect(rec.inputs).toHaveLength(0); // digest lane — zero model calls, no anchor to inject
    expect(out!.summaryMessage.content).toContain(SUMMARY_AUTHORITY_LINE);
    expect(out!.summaryMessage.content).not.toContain("<recent-state-anchor>");
  });

  it("the static fallback family carries the authority line too (down-provider path)", () => {
    const out = staticTier2Compact(messages, { keepRecent: 3 });
    expect(out).not.toBeNull();
    expect(out!.summaryMessage.content).toContain(SUMMARY_AUTHORITY_LINE);
  });
});

describe("113-B1 — dualTier2Compact：双半各带同一 kept-tail 锚 + 权威行", () => {
  const big = "y".repeat(4000);
  const call = (id: string): AgentMessage => ({ role: "assistant", content: "", toolCalls: [{ id, name: "read_file", arguments: {} }] });
  const result = (id: string, content: string): AgentMessage => ({ role: "tool", toolCallId: id, name: "read_file", content });
  const turn: AgentMessage[] = [
    { role: "user", content: "do the huge thing" },
    call("c0"),
    result("c0", big),
    call("c1"),
    result("c1", big),
    { role: "assistant", content: "working" },
    { role: "user", content: "final tail" },
    { role: "assistant", content: "the build is green now" },
  ];

  it("both halves weave the ONE kept-tail anchor; the merged message carries the authority line; kept bytes untouched", async () => {
    const rec = recordingModel();
    const out = await dualTier2Compact(turn, rec.model, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(out).not.toBeNull();
    // Two summarize calls (history + turn prefix), each instruction anchored.
    expect(rec.inputs).toHaveLength(2);
    for (const input of rec.inputs) {
      const instruction = String(input.messages.at(-1)!.content);
      expect(instruction).toContain("<recent-state-anchor>");
      expect(instruction).toContain("the build is green now");
    }
    // The merged summary message declares the kept messages authoritative.
    expect(out!.summaryMessage.content).toContain(SUMMARY_AUTHORITY_LINE);
    // The kept tail survives verbatim (kept here = the trailing assistant).
    expect(out!.retainedTail).toEqual([turn[turn.length - 1]!]);
    expect(out!.messages.at(-1)).toEqual(turn[turn.length - 1]!);
    expect(out!.messages.filter((m) => m.content.startsWith(SUMMARY_MARKER))).toHaveLength(1);
  });

  it("a user-only kept tail (no assistant text) rides the authority line with NO anchor — status-quo instruction bytes", async () => {
    const userTailTurn: AgentMessage[] = [
      { role: "user", content: "do the huge thing" },
      call("c0"),
      result("c0", big),
      call("c1"),
      result("c1", big),
      { role: "assistant", content: "working" },
      { role: "user", content: "final tail" },
    ];
    const rec = recordingModel();
    const out = await dualTier2Compact(userTailTurn, rec.model, { keepRecent: 2, turnPrefixChars: 9000 });
    expect(out).not.toBeNull();
    expect(rec.inputs).toHaveLength(2);
    for (const input of rec.inputs) {
      expect(String(input.messages.at(-1)!.content)).toBe(STATUS_QUO_INSTRUCTION + `\nFocus on: do the huge thing`);
    }
    expect(out!.summaryMessage.content).toContain(SUMMARY_AUTHORITY_LINE);
  });
});
