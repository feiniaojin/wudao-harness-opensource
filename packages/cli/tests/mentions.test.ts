// M34 §2 — @-mention expansion: @<relative path> in user input expands to
// the file's read window wrapped in <file path="…">…</file> BEFORE the text
// enters the conversation. Missing files keep the token + a dim notice;
// duplicates expand once; the read window is read_file's (2000 lines / 50KB).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandMentions, findMentionTokens } from "../src/mentions.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wudao-mentions-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("findMentionTokens", () => {
  it("collects word-boundary @tokens in order", () => {
    expect(findMentionTokens("look at @src/a.ts and @README.md please")).toEqual(["src/a.ts", "README.md"]);
  });

  it("ignores @ inside words (emails) and bare @", () => {
    expect(findMentionTokens("mail me a@b.com @@nope")).toEqual([]);
    expect(findMentionTokens("@")).toEqual([]);
  });

  it("starts at the beginning of the line too", () => {
    expect(findMentionTokens("@pkg.json")).toEqual(["pkg.json"]);
  });
});

describe("expandMentions", () => {
  it("expands an existing file into the <file> envelope, replacing the token", async () => {
    writeFileSync(join(root, "note.md"), "MENTION-SENTINEL-3401\n", "utf8");
    const r = await expandMentions("summarize @note.md quickly", root);
    expect(r.notices).toEqual([]);
    expect(r.text).toBe(`summarize <file path="note.md">\nMENTION-SENTINEL-3401\n</file> quickly`);
  });

  it("expands several mentions in order and dedupes repeats (expand once, keep later tokens)", async () => {
    writeFileSync(join(root, "a.txt"), "AAA\n", "utf8");
    writeFileSync(join(root, "b.txt"), "BBB\n", "utf8");
    const r = await expandMentions("@a.txt then @b.txt then @a.txt again", root);
    expect(r.text).toBe(
      `<file path="a.txt">\nAAA\n</file> then <file path="b.txt">\nBBB\n</file> then @a.txt again`,
    );
    expect(r.notices).toEqual([]);
  });

  it("keeps the token verbatim and reports a dim notice for a missing file", async () => {
    const r = await expandMentions("check @nope-does-not-exist.txt please", root);
    expect(r.text).toBe("check @nope-does-not-exist.txt please");
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("@nope-does-not-exist.txt");
    expect(r.notices[0]).toContain("not found");
  });

  it("keeps the token + notice on workspace escape", async () => {
    writeFileSync(join(root, "inside.txt"), "x\n", "utf8");
    const outside = mkdtempSync(join(tmpdir(), "wudao-mentions-out-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "SECRET\n", "utf8");
      const r = await expandMentions("read @../secret.txt", root);
      expect(r.text).toBe("read @../secret.txt");
      expect(r.notices.join(" ")).toContain("escapes workspace");
      expect(r.text).not.toContain("SECRET");
    } finally {
      rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("truncates at read_file's window: 2000 lines / 50KB, with the paging hint", async () => {
    // 2100 short lines — the line cap fires at 2000.
    writeFileSync(join(root, "long.txt"), `${"line\n".repeat(2100)}`, "utf8");
    const r = await expandMentions("@long.txt", root);
    expect(r.text).toContain('<file path="long.txt">');
    expect(r.text).toContain("100 more lines");
    expect(r.text).toContain("offset=2001");
    expect(r.text.endsWith("</file>")).toBe(true);
    // 2000 lines made it in; the last included line is line 2000.
    expect(r.text).toContain("line\n");
    expect(r.text.match(/\bline\b/g)?.length).toBe(2000);
  });

  it("leaves text without mentions byte-identical", async () => {
    const text = "just a normal prompt with an email a@b.com and @@nothing";
    const r = await expandMentions(text, root);
    expect(r.text).toBe(text);
    expect(r.notices).toEqual([]);
  });

  it("expands a file inside a subdirectory (relative path kept as written)", async () => {
    mkdirSync(join(root, "docs"), { recursive: true });
    writeFileSync(join(root, "docs", "guide.md"), "GUIDE-CONTENT\n", "utf8");
    const r = await expandMentions("use @docs/guide.md", root);
    expect(r.text).toBe(`use <file path="docs/guide.md">\nGUIDE-CONTENT\n</file>`);
  });
});
