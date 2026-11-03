// M37 §2 — /rewind CLI side: target parsing, the listing format, and
// applyRewind's side effects (restore + read-state invalidation + MetaNote).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHistory, createReadStateTable } from "@wudao-org/core";
import { parseRewindTarget, formatRewindList, formatRewindTurnList, applyRewind, buildFilesRewoundNote, displayPath } from "../src/rewind.js";
import { parseReplCommand } from "../src/repl.js";

let dir: string;
let ws: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-rewind-"));
  ws = join(dir, "ws");
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("parseRewindTarget", () => {
  it("bare / empty → list", () => {
    expect(parseRewindTarget("")).toEqual({ kind: "list" });
    expect(parseRewindTarget("   ")).toEqual({ kind: "list" });
  });
  it("last (case-insensitive) → last", () => {
    expect(parseRewindTarget("last")).toEqual({ kind: "last" });
    expect(parseRewindTarget(" LAST ")).toEqual({ kind: "last" });
  });
  it("digits → step n", () => {
    expect(parseRewindTarget("2")).toEqual({ kind: "step", n: 2 });
    expect(parseRewindTarget(" 12 ")).toEqual({ kind: "step", n: 12 });
  });
  it("anything else → bad", () => {
    expect(parseRewindTarget("two")).toEqual({ kind: "bad", raw: "two" });
    expect(parseRewindTarget("1x")).toEqual({ kind: "bad", raw: "1x" });
  });
  // P2-10 (96 队列): the conversation档 sub-grammar.
  it("turn (case-insensitive) → turn-list", () => {
    expect(parseRewindTarget("turn")).toEqual({ kind: "turn-list" });
    expect(parseRewindTarget(" TURN ")).toEqual({ kind: "turn-list" });
  });
  it("turn <digits> → turn n", () => {
    expect(parseRewindTarget("turn 2")).toEqual({ kind: "turn", n: 2 });
    expect(parseRewindTarget(" Turn  12 ")).toEqual({ kind: "turn", n: 12 });
  });
  it("turn <junk> stays bad (the driver answers with the turn usage hint)", () => {
    expect(parseRewindTarget("turn garbage")).toEqual({ kind: "bad", raw: "turn garbage" });
    expect(parseRewindTarget("turn -1")).toEqual({ kind: "bad", raw: "turn -1" });
    expect(parseRewindTarget("turns")).toEqual({ kind: "bad", raw: "turns" });
    expect(parseRewindTarget("turn 2x")).toEqual({ kind: "bad", raw: "turn 2x" });
  });
  it("the legacy three forms are unchanged (byte-stable)", () => {
    expect(parseRewindTarget("")).toEqual({ kind: "list" });
    expect(parseRewindTarget("3")).toEqual({ kind: "step", n: 3 });
    expect(parseRewindTarget("LAST")).toEqual({ kind: "last" });
  });
});

describe("formatRewindTurnList (P2-10)", () => {
  // ω99-164: 用例名与断言串随源演进（:64 头中文化；163 改名先例）。
  it("the /edit-isomorphic face: 1 = 最近一条, first line capped at 80", () => {
    const text = formatRewindTurnList([
      { n: 1, text: "latest\nsecond line" },
      { n: 2, text: "x".repeat(120) },
    ]);
    expect(text).toContain("1 = 最近一条");
    // ω99-164: `/rewind turn <n>` 字面保留（新串保留字面）——零演进钉。
    expect(text).toContain("/rewind turn <n>");
    expect(text).toContain("  1. latest");
    expect(text).toContain(`  2. ${"x".repeat(80)}`);
    expect(text).not.toContain(`  2. ${"x".repeat(81)}`);
  });
  it("empty → explicit nothing-to-rewind line", () => {
    // ω99-164: 空清单钉随源演进（B18 中文化）。
    expect(formatRewindTurnList([])).toContain("没有可回退的内容");
  });
});

describe("parseReplCommand /rewind (routing)", () => {
  it("/rewind, /rewind <n>, /rewind last all route to rewind with raw args", () => {
    expect(parseReplCommand("/rewind")).toEqual({ kind: "rewind", args: "" });
    expect(parseReplCommand("/rewind 2")).toEqual({ kind: "rewind", args: "2" });
    expect(parseReplCommand("/rewind last")).toEqual({ kind: "rewind", args: "last" });
    // P2-10: the turn forms ride the same arg channel (parse in rewind.ts).
    expect(parseReplCommand("/rewind turn")).toEqual({ kind: "rewind", args: "turn" });
    expect(parseReplCommand("/rewind turn 2")).toEqual({ kind: "rewind", args: "turn 2" });
  });
  it("/rewindx and /rewinder stay plain prompts", () => {
    expect(parseReplCommand("/rewindex")).toEqual({ kind: "prompt", text: "/rewindex" });
    expect(parseReplCommand("/rewinder hi")).toEqual({ kind: "prompt", text: "/rewinder hi" });
  });
  it("builtins win: a registered plugin command named rewind never routes to the plugin", () => {
    expect(parseReplCommand("/rewind last", ["rewind"])).toEqual({ kind: "rewind", args: "last" });
  });
});

describe("formatRewindList", () => {
  it("empty → explicit nothing-to-rewind line", () => {
    // ω99-164: 空清单钉随源演进（B15 中文化）。
    expect(formatRewindList([], ws)).toContain("没有可回退的内容");
  });
  it("one line per step: seq, op, workspace-relative path", () => {
    const entries = [
      { seq: 1, file: join(ws, "src", "a.ts"), op: "write_file" as const, existed: true, mtimeMs: 1, hash: "h", at: "2026-08-17T10:11:12.000Z" },
      { seq: 2, file: join(ws, "b.md"), op: "edit" as const, existed: true, mtimeMs: 2, hash: "h", at: "2026-08-17T10:12:13.000Z" },
    ];
    const text = formatRewindList(entries, ws);
    const lines = text.split("\n");
    expect(lines[1]).toContain("1");
    expect(lines[1]).toContain("write_file");
    expect(lines[1]).toContain(join("src", "a.ts")); // platform separator
    expect(lines[2]).toContain("2");
    expect(lines[2]).toContain("edit");
    expect(lines[2]).toContain("b.md");
    expect(text).toContain("/rewind last");
  });
  it("displayPath keeps outside-workspace files absolute", () => {
    const outside = join(dir, "elsewhere", "x.txt");
    expect(displayPath({ seq: 1, file: outside, op: "write_file", existed: true, mtimeMs: 0, hash: "", at: "" }, ws)).toBe(outside);
  });
});

describe("applyRewind", () => {
  it("restores the workspace, invalidates read-state entries, and queues the MetaNote", async () => {
    const a = join(ws, "a.txt");
    const b = join(ws, "b.txt");
    await writeFile(a, "a-v1\n", "utf8");
    const h = createFileHistory(join(ws, ".wudao", "history", "s1"));
    await h.record(a, true, "a-v1\n", 1, "write_file");
    await writeFile(a, "a-v2\n", "utf8");
    await h.record(a, true, "a-v2\n", 2, "write_file");
    await writeFile(a, "a-v3\n", "utf8");
    await h.record(b, false, undefined, 0, "write_file");
    await writeFile(b, "b-v1\n", "utf8");

    const readState = createReadStateTable();
    readState.record(a, { contentHash: "x", mtimeMs: 9, lineCount: 1 });
    readState.record(b, { contentHash: "y", mtimeMs: 9, lineCount: 1 });
    const notes: string[] = [];

    const { summary } = await applyRewind(h, 2, { workspaceRoot: ws, readState, pushMetaNote: (t) => notes.push(t) });
    expect(await readFile(a, "utf8")).toBe("a-v2\n");
    expect(existsSync(b)).toBe(false);
    expect(readState.get(a)).toBeUndefined(); // read-state invalidated
    expect(readState.get(b)).toBeUndefined();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('<files_rewound to_step="2">');
    expect(notes[0]).toContain("a.txt");
    expect(notes[0]).toContain("re-read");
    // ω99-164: summary 钉随源演进（B20 中文化）。
    expect(summary).toContain("第 2 步");
    expect(summary).toContain("a.txt");
  });

  it("buildFilesRewoundNote lists the files once even when a step repeated a file", () => {
    const note = buildFilesRewoundNote(3, ["a.ts", "a.ts", "b.ts"]);
    expect(note.match(/a\.ts/g)?.length).toBe(1);
    expect(note).toContain("b.ts");
  });
});
