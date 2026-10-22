// Conversation-surface pure logic: the markdown block/inline grammar, the
// zero-dep highlighter, the diff hunk computation + context collapsing, the
// board line classification, and the display helpers.
import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/markdown.js";
import { highlightLine, languageFromPath } from "../src/highlight.js";
import { collapseContext, computeDiff, diffWords } from "../src/diff.js";
import { boardLineClass, TODO_LINE_MARKS } from "../src/board.js";
import { firstLine, formatTokensK, truncate } from "../src/log.js";

describe("markdown blocks (TUI grammar)", () => {
  it("splits fenced code with its language tag", () => {
    const blocks = parseBlocks("before\n```ts\nconst a = 1;\n```\nafter");
    expect(blocks).toEqual([
      { kind: "para", lines: ["before"] },
      { kind: "code", lang: "ts", lines: ["const a = 1;"] },
      { kind: "para", lines: ["after"] },
    ]);
  });

  it("headings, lists, quotes, paragraphs", () => {
    const blocks = parseBlocks("## Title\n- one\n- two\n> quoted\nplain");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "list", "quote", "para"]);
    expect(blocks[0]).toEqual({ kind: "heading", level: 2, text: "Title" });
    expect(blocks[1]).toEqual({ kind: "list", items: ["one", "two"] });
    expect(blocks[2]).toEqual({ kind: "quote", lines: ["quoted"] });
  });

  it("an unclosed fence still yields the code block (defensive)", () => {
    expect(parseBlocks("```js\nlet x")).toEqual([{ kind: "code", lang: "js", lines: ["let x"] }]);
  });

  it("inline: **bold** and `code` spans in order", () => {
    expect(parseInline("a **b** c `d` e")).toEqual([
      { text: "a " },
      { text: "b", bold: true },
      { text: " c " },
      { text: "d", code: true },
      { text: " e" },
    ]);
  });

  // ω99-155 — the third inline rule: [label](url) → an href span. 保守 v1：
  // label 不含 `]`、url 不含空白/右括号；不做裸 URL autolink、label 内不嵌
  // 套格式（MD_SYNTAX_RE 探针同步加了 `\[`——m72 的 getBlocks≡parseBlocks
  // oracle 管住探针改动不改输出）。
  it("inline: [label](url) → href span（ω99-155）", () => {
    expect(parseInline("a [文档](https://example.com/x) b")).toEqual([
      { text: "a " },
      { text: "文档", href: "https://example.com/x" },
      { text: " b" },
    ]);
  });

  it("inline 链接保守边界：arr[0] 不匹配、label 内嵌格式不解析、代码 span 优先于链接", () => {
    expect(parseInline("取 arr[0] 的首元素")).toEqual([{ text: "取 arr[0] 的首元素" }]);
    expect(parseInline("[**b**](https://example.com)")).toEqual([{ text: "**b**", href: "https://example.com" }]);
    expect(parseInline("`[a](https://example.com)`")).toEqual([{ text: "[a](https://example.com)", code: true }]);
  });
});

describe("highlighter (zero-dep)", () => {
  it("classifies keywords, strings, numbers, comments for c-like languages", () => {
    const toks = highlightLine("const x = \"hi\"; // note", "ts");
    expect(toks[0]).toEqual({ text: "const", cls: "tok-key" });
    expect(toks.find((t) => t.cls === "tok-str")?.text).toBe("\"hi\"");
    expect(toks.at(-1)).toEqual({ text: "// note", cls: "tok-com" });
    expect(toks.map((t) => t.text).join("")).toBe("const x = \"hi\"; // note");
  });

  it("a # inside a string is not a shell comment", () => {
    const toks = highlightLine("echo \"a # b\"", "bash");
    expect(toks.some((t) => t.cls === "tok-com")).toBe(false);
    expect(toks.some((t) => t.cls === "tok-str")).toBe(true);
  });

  it("call positions get the function color", () => {
    const toks = highlightLine("foo(bar)", "js");
    expect(toks[0]).toEqual({ text: "foo", cls: "tok-fn" });
  });

  it("unknown languages fall through to plain tokens", () => {
    expect(highlightLine("anything", "brainfuck")).toEqual([{ text: "anything" }]);
    expect(highlightLine("anything", undefined)).toEqual([{ text: "anything" }]);
  });

  it("python keywords classify under the # comment rule", () => {
    const toks = highlightLine("def main(): # entry", "python");
    expect(toks[0]).toEqual({ text: "def", cls: "tok-key" });
    expect(toks.at(-1)).toEqual({ text: "# entry", cls: "tok-com" });
  });
});

describe("highlighter: SQL / HTML / CSS families (高亮 spec §2)", () => {
  it("SQL: keywords case-insensitive; -- and /* */ comments; '' escape strings; ident( → fn", () => {
    const toks = highlightLine("SELECT name FROM users WHERE id = count(1)", "sql");
    expect(toks.find((t) => t.cls === "tok-key")?.text).toBe("SELECT");
    expect(toks.find((t) => t.text === "FROM")?.cls).toBe("tok-key");
    expect(toks.find((t) => t.text === "count")?.cls).toBe("tok-fn");
    expect(toks.find((t) => t.text === "1")?.cls).toBe("tok-num");
    expect(highlightLine("x = 1 -- trailing note", "sql").at(-1)).toEqual({ text: "-- trailing note", cls: "tok-com" });
    expect(highlightLine("/* one line */ SELECT 1", "sql").find((t) => t.cls === "tok-com")?.text).toBe("/* one line */");
    expect(highlightLine("/* unterminated runs to EOL", "sql").find((t) => t.cls === "tok-com")?.text).toBe("/* unterminated runs to EOL");
    expect(highlightLine("s = 'it''s'", "sql").find((t) => t.cls === "tok-str")?.text).toBe("'it''s'");
  });

  it("HTML/XML: tag names key, attribute names fn, quoted values str, comments, entities num", () => {
    const toks = highlightLine('<div class="box">a &amp; b</div>', "html");
    expect(toks.find((t) => t.text === "<div")?.cls).toBe("tok-key");
    expect(toks.find((t) => t.text === "class")?.cls).toBe("tok-fn");
    expect(toks.find((t) => t.text === '"box"')?.cls).toBe("tok-str");
    expect(toks.find((t) => t.text === "&amp;")?.cls).toBe("tok-num");
    expect(toks.find((t) => t.text === "</div>")?.cls).toBe("tok-key");
    expect(highlightLine("<!-- note -->", "html").at(-1)).toEqual({ text: "<!-- note -->", cls: "tok-com" });
  });

  it("CSS/SCSS: selector key, property fn, values/hex/$var num, comments, @directive key", () => {
    const toks = highlightLine(".sel { color: #fff; }", "css");
    expect(toks.find((t) => t.text === ".sel ")?.cls).toBe("tok-key");
    expect(toks.find((t) => t.text === "color")?.cls).toBe("tok-fn");
    expect(toks.find((t) => t.text === "#fff")?.cls).toBe("tok-num");
    expect(highlightLine("margin: 12px auto;", "css").find((t) => t.text === "margin")?.cls).toBe("tok-fn");
    expect(highlightLine("margin: 12px auto;", "css").find((t) => t.text === "12")?.cls).toBe("tok-num");
    expect(highlightLine("$primary: red;", "scss").find((t) => t.text === "$primary")?.cls).toBe("tok-num");
    expect(highlightLine("/* note */", "css").at(-1)).toEqual({ text: "/* note */", cls: "tok-com" });
    expect(highlightLine("@media (max-width: 600px) {", "css").find((t) => t.cls === "tok-key")?.text).toBe("@media ");
  });

  it("languageFromPath: lowercase final extension; dotfile/无扩展名/trailing dot → undefined", () => {
    expect(languageFromPath("src/db/USERS.SQL")).toBe("sql");
    expect(languageFromPath("a.vue")).toBe("vue");
    expect(languageFromPath(".gitignore")).toBeUndefined();
    expect(languageFromPath("dir/")).toBeUndefined();
    expect(languageFromPath("a.")).toBeUndefined();
    expect(languageFromPath("noext")).toBeUndefined();
  });

  it("clike 增补: php/m/mm/hpp/cc/hh 路由到 clike 家族", () => {
    expect(highlightLine("NSString *s = nil;", "m").find((t) => t.text === "nil")?.cls).toBe("tok-key");
    expect(highlightLine("echo $x;", "php").find((t) => t.cls !== undefined)).toBeUndefined();
  });
});

describe("diff", () => {
  it("marks only the changed middle; prefix/suffix are context", () => {
    const hunk = computeDiff("a\nb\nc\nd", "a\nX\nc\nd");
    expect(hunk).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "b" },
      { kind: "add", text: "X" },
      { kind: "ctx", text: "c" },
      { kind: "ctx", text: "d" },
    ]);
  });

  it("collapseContext keeps head/tail windows around the change", () => {
    const ctx: { kind: "ctx" | "add"; text: string }[] = [
      ...Array.from({ length: 12 }, (_, i): { kind: "ctx"; text: string } => ({ kind: "ctx", text: `a${i}` })),
      { kind: "add", text: "+new" },
      ...Array.from({ length: 12 }, (_, i): { kind: "ctx"; text: string } => ({ kind: "ctx", text: `b${i}` })),
    ];
    const out = collapseContext(ctx, 3);
    expect(out.filter((l) => l.kind === "gap")).toEqual([{ kind: "gap", count: 6 }, { kind: "gap", count: 6 }]);
    expect(out.length).toBe(3 + 1 + 3 + 1 + 3 + 1 + 3);
    // Short runs pass through untouched.
    expect(collapseContext([{ kind: "ctx", text: "x" }, { kind: "del", text: "-y" }], 3)).toEqual([
      { kind: "ctx", text: "x" },
      { kind: "del", text: "-y" },
    ]);
  });
});

// M63 §D — word-level intra-line highlight (research 35 #3): common token
// prefix/suffix stay quiet, the changed middle is marked, indentation (pure
// leading whitespace tokens) is never marked, and single-token middles get
// the character refinement so "userAge=32" vs "userAge=33" highlights "2"/"3".
describe("diffWords (M63 §D)", () => {
  it("identical lines produce one unmarked span per side", () => {
    const w = diffWords("same line", "same line");
    expect(w.old.every((s) => !s.changed)).toBe(true);
    expect(w.new.every((s) => !s.changed)).toBe(true);
  });

  it("marks only the changed word, keeping surrounding tokens and whitespace", () => {
    const w = diffWords("const total = price * qty;", "const subtotal = price * qty;");
    const changedOld = w.old.filter((s) => s.changed).map((s) => s.text).join("");
    const changedNew = w.new.filter((s) => s.changed).map((s) => s.text).join("");
    expect(changedOld).toBe("total");
    expect(changedNew).toBe("subtotal");
    // Spans concatenate back to the original line exactly.
    expect(w.old.map((s) => s.text).join("")).toBe("const total = price * qty;");
    expect(w.new.map((s) => s.text).join("")).toBe("const subtotal = price * qty;");
  });

  it("never marks indentation (leading whitespace is common prefix)", () => {
    const w = diffWords("    return x;", "    return y;");
    const changed = w.old.filter((s) => s.changed);
    expect(changed.map((s) => s.text).join("")).toBe("x"); // the ";" is common suffix
    expect(w.old.map((s) => s.text).join("")).toBe("    return x;");
  });

  it("single-token middles refine to the changed characters", () => {
    const w = diffWords("userAge=32", "userAge=33");
    expect(w.old.filter((s) => s.changed).map((s) => s.text).join("")).toBe("2");
    expect(w.new.filter((s) => s.changed).map((s) => s.text).join("")).toBe("3");
  });

  it("an empty character middle falls back to whole-token marking", () => {
    // "total" → "subtotal": the char trim would leave the old side empty —
    // word-level honesty marks both tokens whole instead.
    const w = diffWords("total = 1", "subtotal = 1");
    expect(w.old.filter((s) => s.changed).map((s) => s.text).join("")).toBe("total");
    expect(w.new.filter((s) => s.changed).map((s) => s.text).join("")).toBe("subtotal");
  });

  it("pure insertion marks only the new side", () => {
    const w = diffWords("", "added line");
    expect(w.old).toEqual([]);
    expect(w.new.some((s) => s.changed)).toBe(true);
  });
});

// M63 §D — the DiffView pairing RULE, as pure logic (the jsdom render
// assertion lives in simple-mode.test.tsx): a hunk that is exactly 1-del +
// 1-add has a counterpart line for word pairing; a multi-row run does not.
describe("the word-pairing rule (M63 §D)", () => {
  it("a 1-del+1-add hunk pairs: the changed words fall out of diffWords", () => {
    const hunk = computeDiff("a\n  const total = 1;\nc", "a\n  const subtotal = 1;\nc");
    expect(hunk).toEqual([
      { kind: "ctx", text: "a" },
      { kind: "del", text: "  const total = 1;" },
      { kind: "add", text: "  const subtotal = 1;" },
      { kind: "ctx", text: "c" },
    ]);
    const w = diffWords("  const total = 1;", "  const subtotal = 1;");
    expect(w.old.filter((s) => s.changed).map((s) => s.text).join("")).toBe("total");
    expect(w.new.filter((s) => s.changed).map((s) => s.text).join("")).toBe("subtotal");
  });

  it("a 2-del+1-add run has no counterpart line — the view keeps row-level marking", () => {
    const hunk = computeDiff("a\nx\ny\nz", "a\nw\nz");
    expect(hunk.filter((l) => l.kind === "del").length).toBe(2);
    expect(hunk.filter((l) => l.kind === "add").length).toBe(1);
  });
});

describe("board classification", () => {
  it("marks map to classes (core TODO_LINE_MARKS mirror)", () => {
    expect(boardLineClass(`${TODO_LINE_MARKS.done}ship it`)).toBe("done");
    expect(boardLineClass(`${TODO_LINE_MARKS.inProgress}wip`)).toBe("wip");
    expect(boardLineClass(`${TODO_LINE_MARKS.pending}later`)).toBe("todo");
    expect(boardLineClass("unmarked")).toBe("todo");
  });
});

describe("display helpers (TUI parity)", () => {
  it("formatTokensK rounds to tenths of a k", () => {
    expect(formatTokensK(1234)).toBe("1.2k");
    expect(formatTokensK(987)).toBe("1k");
    expect(formatTokensK(128000)).toBe("128k");
  });

  it("firstLine ellipsizes multi-line user echoes", () => {
    expect(firstLine("one\ntwo")).toBe("one …");
    expect(firstLine("one")).toBe("one");
  });

  it("truncate caps with an ellipsis", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("ab", 3)).toBe("ab");
  });
});
