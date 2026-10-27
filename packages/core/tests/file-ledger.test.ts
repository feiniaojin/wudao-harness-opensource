// 夜移 030 — the file-operations ledger riding tier-2 compaction summaries
// (pi compaction/utils.ts port). When a span is summarized away the model
// otherwise loses its file footprint: it re-reads files (full tokens + fresh
// cache-miss bytes) and forgets which files it already edited. The ledger is
// MECHANICAL — extracted from the span's assistant toolCall blocks, never
// LLM-dependent — and survives N successive compactions by re-parsing the
// tags out of the prior frozen summary (wudao delta: state-free re-derivation
// where pi persists a details field on the session entry).
import { describe, it, expect } from "vitest";
import {
  extractFileOps,
  parseFileOpsFromSummary,
  mergeFileOps,
  formatFileOperations,
  FILE_LEDGER_CAP,
  tier2Compact,
  staticTier2Compact,
  dualTier2Compact,
  SUMMARY_MARKER,
  SUMMARY_END_MARKER,
} from "../src/compaction.js";
import { createScriptedModel } from "../src/model-client.js";
import type { ModelClient } from "../src/model-client.js";
import type { AgentMessage } from "../src/types.js";

const tc = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
const user = (content: string): AgentMessage => ({ role: "user", content });
const asstCalls = (...calls: ReturnType<typeof tc>[]): AgentMessage => ({ role: "assistant", content: "", toolCalls: calls });
const toolMsg = (id: string, name: string, content: string): AgentMessage => ({ role: "tool", toolCallId: id, name, content });
const asstText = (content: string): AgentMessage => ({ role: "assistant", content });

/** A scripted model answering `text` to every call (dual compacts ask twice). */
const alwaysModel = (text: string): ModelClient => {
  const scripted = createScriptedModel([
    { role: "assistant", content: text },
    { role: "assistant", content: text },
  ]);
  return { generate: (input) => scripted.generate(input) };
};

// A span whose assistant tool calls read src/a.ts and edit src/b.ts.
const fileOpsSpan = (): AgentMessage[] => [
  user("do things " + "x".repeat(200)),
  asstCalls(tc("c1", "read_file", { path: "src/a.ts" })),
  toolMsg("c1", "read_file", "content of a"),
  asstText("ok"),
  user("now edit " + "y".repeat(200)),
  asstCalls(tc("c2", "edit", { path: "src/b.ts", old_string: "a", new_string: "b" })),
  toolMsg("c2", "edit", "ok"),
  asstText("done"),
  user("latest"),
];

describe("夜移 030 extractFileOps", () => {
  it("classifies read_file→read, write_file/edit→modified, and nothing else", () => {
    const span: AgentMessage[] = [
      asstCalls(
        tc("a", "read_file", { path: "r.ts" }),
        tc("b", "write_file", { path: "w.ts", content: "x" }),
        tc("c", "edit", { path: "e.ts", old_string: "a", new_string: "b" }),
        // same `path` arg shape, wrong tools — must NOT count
        tc("d", "grep", { path: "g.ts", pattern: "x" }),
        tc("e", "task", { path: "t.ts" }),
        // non-string / empty paths — must NOT count
        tc("f", "read_file", { path: 42 }),
        tc("g", "read_file", { offset: 1 }),
        tc("h", "write_file", { path: "", content: "x" }),
      ),
      user("a plain user message"),
      toolMsg("a", "read_file", "result"),
    ];
    expect(extractFileOps(span)).toEqual({ read: ["r.ts"], modified: ["w.ts", "e.ts"] });
  });

  it("modified wins over read regardless of order", () => {
    const readThenEdit = extractFileOps([
      asstCalls(tc("a", "read_file", { path: "f.ts" })),
      asstCalls(tc("b", "edit", { path: "f.ts", old_string: "a", new_string: "b" })),
    ]);
    expect(readThenEdit).toEqual({ read: [], modified: ["f.ts"] });
    const writeThenRead = extractFileOps([
      asstCalls(tc("a", "write_file", { path: "f.ts", content: "x" })),
      asstCalls(tc("b", "read_file", { path: "f.ts" })),
    ]);
    expect(writeThenRead).toEqual({ read: [], modified: ["f.ts"] });
  });

  it("bumps recency on re-touch (a,b,a → [b,a])", () => {
    const ops = extractFileOps([
      asstCalls(tc("a", "read_file", { path: "a.ts" })),
      asstCalls(tc("b", "read_file", { path: "b.ts" })),
      asstCalls(tc("c", "read_file", { path: "a.ts" })),
    ]);
    expect(ops.read).toEqual(["b.ts", "a.ts"]);
  });
});

describe("夜移 030 parseFileOpsFromSummary", () => {
  it("round-trips formatFileOperations output", () => {
    const formatted = formatFileOperations(["a.ts", "b.ts"], ["c.ts"]);
    expect(formatted).toBe("\n\n<read-files>\na.ts\nb.ts\n</read-files>\n\n<modified-files>\nc.ts\n</modified-files>");
    expect(parseFileOpsFromSummary(`${SUMMARY_MARKER} body${formatted}\n${SUMMARY_END_MARKER}`)).toEqual({
      read: ["a.ts", "b.ts"],
      modified: ["c.ts"],
    });
  });

  it("returns undefined without tags; ignores torn tags; takes the LAST block on duplicates; strips the cap-omission line", () => {
    expect(parseFileOpsFromSummary(`${SUMMARY_MARKER} plain summary`)).toBeUndefined();
    expect(parseFileOpsFromSummary("<read-files>\na.ts\n")).toBeUndefined(); // no close tag (LLM echo)
    const dupes = "<read-files>\nold1.ts\n</read-files>\n<read-files>\nnew1.ts\n</read-files>";
    expect(parseFileOpsFromSummary(dupes)?.read).toEqual(["new1.ts"]);
    const capped = "<read-files>\n[... 10 older files omitted]\nf10.ts\n</read-files>";
    expect(parseFileOpsFromSummary(capped)?.read).toEqual(["f10.ts"]);
  });
});

describe("夜移 030 mergeFileOps + formatFileOperations", () => {
  it("merges prior + span with recency bump; a prior read promoted by a span edit leaves the read list", () => {
    const prior = { read: ["old.ts", "keep.ts"], modified: ["done.ts"] };
    const next = { read: ["new.ts"], modified: ["old.ts"] };
    expect(mergeFileOps(prior, next)).toEqual({
      read: ["keep.ts", "new.ts"],
      modified: ["done.ts", "old.ts"],
    });
  });

  it("caps at FILE_LEDGER_CAP with an omission line as the block's first content line", () => {
    expect(FILE_LEDGER_CAP).toBeGreaterThan(0);
    const many = Array.from({ length: FILE_LEDGER_CAP + 10 }, (_, i) => `f${String(i).padStart(2, "0")}.ts`);
    const merged = mergeFileOps(undefined, { read: many, modified: [] });
    const formatted = formatFileOperations(merged.read, merged.modified);
    // formatted = "\n\n<read-files>\n[... N omitted]\nf10.ts…" — the leading
    // "\n\n" split yields two empty strings, so the tag opens at index 2.
    const lines = formatted.split("\n");
    expect(lines[2]).toBe("<read-files>");
    expect(lines[3]).toBe(`[... 10 older files omitted]`);
    expect(lines[4]).toBe(`f10.ts`);
    expect(lines[lines.length - 2]).toBe(`f${String(FILE_LEDGER_CAP + 9).padStart(2, "0")}.ts`);
    // the cap survives a round-trip: the re-parsed ledger is the capped list
    expect(parseFileOpsFromSummary(`x${formatted}`).read).toHaveLength(FILE_LEDGER_CAP);
  });

  it("empty ledger formats to empty string (status-quo bytes)", () => {
    expect(formatFileOperations([], [])).toBe("");
    expect(formatFileOperations(["a.ts"], [])).toBe("\n\n<read-files>\na.ts\n</read-files>");
  });
});

describe("夜移 030 tier-2 integration", () => {
  it("tier2Compact appends both blocks after the system note, before the end marker", async () => {
    const result = await tier2Compact(fileOpsSpan(), alwaysModel("SUM"), { keepRecent: 1 });
    expect(result).not.toBeNull();
    const content = result!.summaryMessage.content;
    expect(content).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(content).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
    const noteIdx = content.indexOf("[system note:");
    const readIdx = content.indexOf("<read-files>");
    const endIdx = content.indexOf(SUMMARY_END_MARKER);
    expect(noteIdx).toBeGreaterThan(-1);
    expect(readIdx).toBeGreaterThan(noteIdx);
    expect(readIdx).toBeLessThan(endIdx);
  });

  it("tier2Compact is deterministic across runs with the same scripted model", async () => {
    const a = await tier2Compact(fileOpsSpan(), alwaysModel("SUM"), { keepRecent: 1 });
    const b = await tier2Compact(fileOpsSpan(), alwaysModel("SUM"), { keepRecent: 1 });
    expect(a!.summaryMessage.content).toBe(b!.summaryMessage.content);
  });

  it("status-quo pin: a span with no file ops and no prior tags emits no tag blocks", async () => {
    const span: AgentMessage[] = [
      user("plain " + "x".repeat(200)),
      asstText("answer"),
      user("plain2 " + "y".repeat(200)),
      asstText("answer2"),
      user("latest"),
    ];
    const result = await tier2Compact(span, alwaysModel("SUM"), { keepRecent: 1 });
    expect(result).not.toBeNull();
    expect(result!.summaryMessage.content).not.toContain("<read-files>");
    expect(result!.summaryMessage.content).not.toContain("<modified-files>");
  });

  it("chained compaction: the prior summary's tags merge with the new span's ops, no duplication", async () => {
    const first = await tier2Compact(fileOpsSpan(), alwaysModel("S1"), { keepRecent: 1 });
    expect(first).not.toBeNull();
    const grown: AgentMessage[] = [
      ...first!.messages,
      user("phase 2 " + "z".repeat(2000)),
      asstCalls(tc("c3", "read_file", { path: "src/c.ts" })),
      toolMsg("c3", "read_file", "c"),
      asstText("ok2"),
      user("tail"),
    ];
    const second = await tier2Compact(grown, alwaysModel("S2"), { keepRecent: 1 });
    expect(second).not.toBeNull();
    const content = second!.summaryMessage.content;
    // the running ledger: a.ts (prior read) + c.ts (span read) in one block, each exactly once
    expect(content).toContain("<read-files>\nsrc/a.ts\nsrc/c.ts\n</read-files>");
    expect(content).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
    expect(content.split("src/a.ts").length - 1).toBe(1);
  });

  it("a prior read the span goes on to edit is promoted to modified at the next boundary", async () => {
    const priorSummary: AgentMessage = {
      role: "user",
      content: `${SUMMARY_MARKER} Task: t\nprior body\n[system note: context was compacted to fit — delegate any remaining exploration to task subagents and answer from their reports]\n\n<read-files>\nold.ts\n</read-files>\n${SUMMARY_END_MARKER}`,
    };
    const messages: AgentMessage[] = [
      priorSummary,
      user("pad " + "p".repeat(200)),
      asstCalls(tc("e1", "edit", { path: "old.ts", old_string: "a", new_string: "b" })),
      toolMsg("e1", "edit", "ok"),
      asstText("done"),
      user("tail"),
    ];
    const result = await tier2Compact(messages, alwaysModel("S"), { keepRecent: 1 });
    expect(result).not.toBeNull();
    const content = result!.summaryMessage.content;
    expect(content).toContain("<modified-files>\nold.ts\n</modified-files>");
    expect(content).not.toContain("<read-files>");
  });

  it("staticTier2Compact carries the same ledger (zero-LLM path)", () => {
    const result = staticTier2Compact(fileOpsSpan(), { keepRecent: 1 });
    expect(result).not.toBeNull();
    const content = result!.summaryMessage.content;
    expect(content).toContain("<read-files>\nsrc/a.ts\n</read-files>");
    expect(content).toContain("<modified-files>\nsrc/b.ts\n</modified-files>");
    expect(content.indexOf("<read-files>")).toBeGreaterThan(content.indexOf("[system note:"));
  });

  it("dualTier2Compact merges history + turn-prefix ops in recency order", async () => {
    const messages: AgentMessage[] = [
      user("big task " + "x".repeat(100)),
      asstCalls(tc("d1", "read_file", { path: "x1.ts" })),
      toolMsg("d1", "read_file", "one"),
      asstCalls(tc("d2", "read_file", { path: "x2.ts" })),
      toolMsg("d2", "read_file", "two"),
      asstText("all done"),
    ];
    const result = await dualTier2Compact(messages, alwaysModel("D"), { keepRecent: 1, turnPrefixChars: 10 });
    expect(result).not.toBeNull();
    const content = result!.summaryMessage.content;
    expect(content).toContain("<read-files>\nx1.ts\nx2.ts\n</read-files>");
    expect(content.indexOf("<read-files>")).toBeLessThan(content.indexOf(SUMMARY_END_MARKER));
  });
});
