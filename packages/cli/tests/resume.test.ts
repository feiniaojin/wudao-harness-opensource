// M25 §A1: resumeEntries — the pure AgentMessage[] → HistoryEntry[] projection
// behind the TUI's resumed view. The resumed view is an INDEX, not a replay:
// tool turns fold to one line, marker/system messages drop, a divider heads it.
import { describe, it, expect } from "vitest";
import type { AgentMessage } from "@wudao-org/core";
import { resumeEntries } from "../src/tui/resume.js";

const SESSION = "wudao-mfoobar-abcdef12";

const u = (content: string): AgentMessage => ({ role: "user", content });
const a = (content: string): AgentMessage => ({ role: "assistant", content });
const toolTurn = (
  calls: { id: string; name: string; arguments?: Record<string, unknown> }[],
  results: string[],
): AgentMessage[] => [
  {
    role: "assistant",
    content: "",
    toolCalls: calls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments ?? {} })),
  },
  ...results.map((content, i) => ({
    role: "tool" as const,
    toolCallId: calls[i]?.id ?? "c",
    name: calls[i]?.name ?? "tool",
    content,
  })),
];

describe("resumeEntries", () => {
  it("empty history → no entries (no divider for a fresh session)", () => {
    expect(resumeEntries([], SESSION)).toEqual([]);
  });

  it("heads the list with a divider: resumed <id8> · N messages", () => {
    const messages = [u("hi"), a("hello")];
    const entries = resumeEntries(messages, SESSION);
    expect(entries[0]).toEqual({ kind: "divider", text: "已恢复 wudao-mf · 2 条消息" }); // ω99-172: 钉随源演进（漏判钉——brief §二未列，全量红集定位）
    expect(entries).toHaveLength(3);
  });

  it("maps plain user and assistant messages 1:1", () => {
    const entries = resumeEntries([u("fix the bug"), a("fixed it")], SESSION);
    expect(entries.slice(1)).toEqual([
      { kind: "user", text: "fix the bug" },
      { kind: "assistant", text: "fixed it" },
    ]);
  });

  // M79b: a user turn's image refs survive the projection (the web's resumed
  // bubbles re-render from the pointers); a text-only turn stays keyless.
  it("projects a user turn's image refs; text-only turns omit the field", () => {
    const block = { kind: "image" as const, ref: { attachmentId: "att-1", mediaType: "image/png", byteLength: 3 } };
    const messages: AgentMessage[] = [
      { role: "user", content: "see this", images: [block] },
      { role: "user", content: "no image" },
    ];
    const entries = resumeEntries(messages, SESSION);
    expect(entries.slice(1)).toEqual([
      { kind: "user", text: "see this", images: [block] },
      { kind: "user", text: "no image" },
    ]);
  });

  it("folds a tool turn into ONE entry: first tool name, n-tool summary, last-result 全文（审计完整性：数据层不再截断）", () => {
    const longResult = "R".repeat(200);
    const messages: AgentMessage[] = [
      u("go"),
      ...toolTurn(
        [
          { id: "c1", name: "read_file", arguments: { path: "a" } },
          { id: "c2", name: "grep", arguments: { pattern: "b" } },
          { id: "c3", name: "read_file", arguments: { path: "c" } },
        ],
        ["result-a", "result-b", longResult],
      ),
      a("done"),
    ];
    const entries = resumeEntries(messages, SESSION);
    expect(entries).toHaveLength(4); // divider + user + ONE folded tool + assistant
    expect(entries[2]).toEqual({
      kind: "tool",
      name: "read_file",
      summary: "3 个工具：read_file,grep,read_file", // ω99-176: 钉随源演进
      resultPreview: "R".repeat(200), // 审计完整性（09-16）：resume 重建带全文——显示层（web 卡 8/50 行帽/TUI 单行截断）做披露
    });
    expect(entries[3]).toEqual({ kind: "assistant", text: "done" });
  });

  it("folds consecutive multi-call turns separately (one entry per turn)", () => {
    const messages: AgentMessage[] = [
      u("go"),
      ...toolTurn([{ id: "c1", name: "read_file" }], ["first result"]),
      ...toolTurn([{ id: "c2", name: "grep" }], ["second result"]),
      a("done"),
    ];
    const entries = resumeEntries(messages, SESSION).slice(1);
    expect(entries.filter((e) => e.kind === "tool")).toEqual([
      { kind: "tool", name: "read_file", summary: "1 个工具：read_file", resultPreview: "first result" }, // ω99-176: 钉随源演进
      { kind: "tool", name: "grep", summary: "1 个工具：grep", resultPreview: "second result" },
    ]);
  });

  it("renders a standalone todo_write turn as a board entry (existing renderer)", () => {
    const board = "[todo board 2/3 done]\n☑ read the spec\n☑ write the code\n◐ verify it";
    const messages: AgentMessage[] = [
      u("plan it"),
      ...toolTurn([{ id: "c1", name: "todo_write" }], [board]),
      a("planned"),
    ];
    const entries = resumeEntries(messages, SESSION);
    expect(entries).toContainEqual({
      kind: "board",
      done: 2,
      total: 3,
      lines: ["☑ read the spec", "☑ write the code", "◐ verify it"],
    });
    expect(entries.some((e) => e.kind === "tool")).toBe(false);
  });

  it("skips [system note:], [compacted summary], and restored [todo board user markers", () => {
    const messages: AgentMessage[] = [
      u("[system note: todo board has 1 incomplete item(s) — continue working]"),
      u("[compacted summary] The user asked to fix auth…\n[system note: context was compacted to fit]"),
      u("[todo board 2/3 done](restored)\n☑ read the spec\n◐ verify it"),
      u("real prompt"),
      a("real answer"),
    ];
    const entries = resumeEntries(messages, SESSION);
    expect(entries.slice(1)).toEqual([
      { kind: "user", text: "real prompt" },
      { kind: "assistant", text: "real answer" },
    ]);
  });

  it("orphan tool results (no call in view) fold into nothing", () => {
    const messages: AgentMessage[] = [
      { role: "tool", toolCallId: "orphan", name: "read_file", content: "stray" },
      a("answer"),
    ];
    const entries = resumeEntries(messages, SESSION);
    expect(entries.slice(1)).toEqual([{ kind: "assistant", text: "answer" }]);
  });

  // 用户报障（0.5.5）：点开历史会话看不到 thinking —— JSONL 里存了
  // （0.3.8 起 append-only），但 resume 投影整字段丢弃，UI 的 ReasoningBlock
  // 拿不到值。同形状透传，空串/缺席不产生噪音字段。
  it("carries reasoning from the persisted message into the history entry", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "修个 bug" },
      { role: "assistant", content: "修好了", reasoning: "先看日志，再定位到竞态…" },
      { role: "assistant", content: "无思考的一轮" },
    ];
    const entries = resumeEntries(messages, SESSION)
      .slice(1) // 跳过 "已恢复…" divider
      .filter((e) => e.kind === "assistant");
    expect(entries[0]).toEqual({
      kind: "assistant",
      text: "修好了",
      reasoning: "先看日志，再定位到竞态…",
    });
    // 缺席者零噪音：不产生 reasoning 键（老 JSONL / 非推理模型）。
    expect(entries[1]).toEqual({ kind: "assistant", text: "无思考的一轮" });
    expect("reasoning" in (entries[1] as object)).toBe(false);
  });
});
