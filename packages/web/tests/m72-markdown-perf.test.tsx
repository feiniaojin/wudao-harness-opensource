// @vitest-environment jsdom
// M72 §1/§2 — the render-performance milestone's behavior pins (research 38
// §1, the upstream's Markdown.tsx): the module-level lex LRU + syntax fast-path, and
// the streaming boundary advance. Pure logic asserts against the unchanged
// `parseBlocks` oracle (byte-identical rendering is the milestone contract:
// the cache/fast-path may only change WORK, never output); component asserts
// mount/remount through jsdom like the other component suites.
//
// The stats seam (`markdownCacheStats`/`resetMarkdownCache`) is the same
// observability the TUI's markdown module exports for its perf tests — the
// module-level cache is shared state, so every describe resets it.
import { beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { getBlocks, hasMarkdownSyntax, markdownCacheStats, parseBlocks, resetMarkdownCache } from "../src/markdown.js";
import { Markdown, stableBoundary, StreamingMarkdown } from "../src/markdown.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  resetMarkdownCache();
});

// A representative syntax-bearing document (every grammar branch).
const SYNTAX_DOC = "# Title\nsome **bold** and `code`\n\n```ts\nconst a = 1;\n```\n\n- one\n- two\n\n> quoted\n\nfinal para";

describe("M72 §1 hasMarkdownSyntax (the combined probe)", () => {
  it("plain text — including mid-line dashes — probes negative", () => {
    expect(hasMarkdownSyntax("just a plain sentence.")).toBe(false);
    expect(hasMarkdownSyntax("well-known costs, a mid-line dash is not a list")).toBe(false);
    expect(hasMarkdownSyntax("trailing dash")).toBe(false); // no space after the dash → not a list marker
  });

  it("every grammar marker probes positive", () => {
    expect(hasMarkdownSyntax("```js\nx")).toBe(true); // fence
    expect(hasMarkdownSyntax("## head")).toBe(true); // heading
    expect(hasMarkdownSyntax("- item")).toBe(true); // list (dash + space)
    expect(hasMarkdownSyntax("  * item")).toBe(true); // indented list
    expect(hasMarkdownSyntax("> quote")).toBe(true); // quote
    expect(hasMarkdownSyntax("see **bold**")).toBe(true); // bold
    expect(hasMarkdownSyntax("see `code`")).toBe(true); // inline code
    expect(hasMarkdownSyntax("| 检查项 | 结果 |")).toBe(true); // table pipe (2026-08-26 §3.2)
    expect(hasMarkdownSyntax("see [文档](https://x)")).toBe(true); // link bracket (ω99-155)
  });

  it("syntax beyond the 500-char sample window is still detected (byte-identical guard)", () => {
    const late = `${"x".repeat(600)}\n# late heading`;
    expect(hasMarkdownSyntax(late)).toBe(true);
    // And the fast path must NOT have swallowed it: getBlocks == parseBlocks.
    resetMarkdownCache();
    expect(getBlocks(late)).toEqual(parseBlocks(late));
  });
});

describe("M72 §1 fast path (plain text skips the lexer)", () => {
  it("produces exactly parseBlocks' output for syntax-free text", () => {
    const plain = "first para\nspans lines\n\nsecond para after a blank run\n\n\nthird";
    expect(getBlocks(plain)).toEqual(parseBlocks(plain));
    expect(getBlocks("single line")).toEqual([{ kind: "para", lines: ["single line"] }]);
    expect(getBlocks("")).toEqual([]);
    expect(getBlocks("   \n\n  ")).toEqual([]); // blank-only text yields no blocks — same as the parser
  });

  it("is counted and deliberately NOT cached", () => {
    getBlocks("plain one");
    getBlocks("plain one");
    getBlocks("plain two");
    const s = markdownCacheStats();
    expect(s.fastPathSkips).toBe(3); // one cheap rebuild per render, the upstream's "don't retain 4× content"
    expect(s.size).toBe(0);
    expect(s.lexRuns).toBe(0); // the block parser never ran
  });
});

describe("M72 §1 lex LRU (max 500, survives remounts)", () => {
  it("second getBlocks of the same syntax content is a cache hit; the parser ran once", () => {
    getBlocks(SYNTAX_DOC);
    expect(markdownCacheStats().lexRuns).toBe(1);
    const again = getBlocks(SYNTAX_DOC);
    expect(again).toEqual(parseBlocks(SYNTAX_DOC));
    const s = markdownCacheStats();
    expect(s.cacheHits).toBe(1);
    expect(s.lexRuns).toBe(1); // not re-lexed
  });

  it("an unmount→remount of Markdown hits the LRU (useMemo does not survive remounts)", () => {
    const containers = [0, 1].map(() => {
      const c = document.createElement("div");
      document.body.appendChild(c);
      return c;
    });
    const roots: Root[] = containers.map((c) => createRoot(c));
    act(() => roots[0]?.render(<Markdown source={SYNTAX_DOC} />));
    expect(markdownCacheStats().lexRuns).toBe(1);
    act(() => roots[0]?.unmount());
    act(() => roots[1]?.render(<Markdown source={SYNTAX_DOC} />));
    expect(markdownCacheStats().lexRuns).toBe(1); // remount re-lexed nothing
    expect(markdownCacheStats().cacheHits).toBe(1);
    act(() => roots[1]?.unmount());
    document.body.innerHTML = "";
  });

  it("renders identically cold and warm (the golden-render proxy)", () => {
    resetMarkdownCache();
    const cold = renderToStaticMarkup(<Markdown source={SYNTAX_DOC} />);
    const warm = renderToStaticMarkup(<Markdown source={SYNTAX_DOC} />);
    expect(warm).toBe(cold);
    expect(renderToStaticMarkup(<Markdown source="plain text\n\nmore" />)).toBe(
      renderToStaticMarkup(<Markdown source="plain text\n\nmore" />),
    );
  });

  it("evicts beyond 500 entries (oldest first)", () => {
    for (let i = 0; i < 501; i++) getBlocks(`# head ${i}\nbody ${i}`);
    expect(markdownCacheStats().size).toBe(500);
    // The first-inserted content was evicted → re-request re-lexes.
    getBlocks("# head 0\nbody 0");
    const s = markdownCacheStats();
    expect(s.cacheHits).toBe(0);
    expect(s.lexRuns).toBe(502); // 501 + the re-lex
  });

  it("an evicted entry rebuilds correctly on re-request (F2: pins eviction-rebuild)", () => {
    const a = getBlocks(SYNTAX_DOC);
    for (let i = 0; i < 600; i++) getBlocks(`# filler ${i}`); // pushes SYNTAX_DOC out at 500
    const b = getBlocks(SYNTAX_DOC);
    expect(b).toEqual(a);
    expect(b).toEqual(parseBlocks(SYNTAX_DOC));
  });
});

// M72 §2 — streaming boundary advance (the upstream formatStreamingMarkdown): each delta
// re-lexes only the unstable suffix; the stable prefix is committed once and
// never parsed again. `stableBoundary` is the pure seam rule; the component
// pins byte-identical output vs <Markdown> for the same complete text (the
// golden-render proxy) plus the per-delta work bound.
// 2026-08-26 §3.2 — GFM tables joined the grammar: the pipe is a probe
// marker (above), and the block shape itself pins here against the
// parseBlocks oracle. The doc case is the REAL model-output shape the spec
// cites: a heading immediately followed by the header row (no blank line).
describe("2026-08-26 table grammar (fast path parity)", () => {
  const md = "## ✅ 修复验证结果\n| 检查项 | 结果 |\n| --- | --- |\n| 构建 | 通过 ✅ |";
  it("parses header+delimiter+rows into one table block; cache ≡ lexer", () => {
    expect(parseBlocks(md)).toEqual([
      { kind: "heading", level: 2, text: "✅ 修复验证结果" },
      { kind: "table", header: ["检查项", "结果"], rows: [["构建", "通过 ✅"]] },
    ]);
    resetMarkdownCache();
    expect(getBlocks(md)).toEqual(parseBlocks(md));
  });
  it("a table can open right after prose (no blank line) and a bare delimiter-free pipe line stays a para", () => {
    expect(parseBlocks("结论如下\n| a | b |\n|---|---|\n| 1 | 2 |")).toEqual([
      { kind: "para", lines: ["结论如下"] },
      { kind: "table", header: ["a", "b"], rows: [["1", "2"]] },
    ]);
    expect(parseBlocks("a | b\nc | d")).toEqual([{ kind: "para", lines: ["a | b", "c | d"] }]);
  });
});

describe("M72 §2 stableBoundary (the pure seam rule)", () => {
  it("no blank line → no seam (nothing is provably final)", () => {
    expect(stableBoundary("one paragraph still growing")).toBe(0);
    expect(stableBoundary("line one\nline two")).toBe(0);
  });

  it("a blank line opens a seam right after the run's last blank line", () => {
    expect(stableBoundary("a\n\nb")).toBe(3); // after the blank line's newline
    expect(stableBoundary("a\n\n\nb")).toBe(4); // the whole blank run is consumed
    expect(stableBoundary("a\n\n")).toBe(3); // trailing blanks: seam at EOF
  });

  it("blank lines inside an open code fence are NOT seams", () => {
    expect(stableBoundary("a\n\n```ts\nx\n\nstill code")).toBe(3); // stops at the fence
    // A closed fence re-arms seams after it.
    expect(stableBoundary("a\n\n```ts\nx\n```\n\nb")).toBe(16);
  });

  it("the seam only advances under append-only growth (monotonicity)", () => {
    let text = "para\n\n";
    let last = 0;
    for (const delta of ["growing ", "text\n\n", "more ", "lines\n\n", "end"]) {
      text += delta;
      const seam = stableBoundary(text);
      expect(seam).toBeGreaterThanOrEqual(last);
      last = seam;
    }
  });
});

describe("M72 §2 StreamingMarkdown (byte-identical + suffix-only re-lex)", () => {
  const mount = (el: React.ReactElement): { root: Root; container: HTMLElement } => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(el));
    return { root, container };
  };

  it("renders exactly what <Markdown> renders for complete texts", () => {
    const cases = [
      SYNTAX_DOC,
      "plain answer\n\nclosing words",
      "```js\nlet x = 1;", // unclosed fence
      "para\n\n",
      "",
      "# only a heading",
      "| 检查项 | 结果 |\n| --- | --- |", // table header+delimiter, rows still streaming (2026-08-26)
      "| a |\n| --- |\n| 1 |\n| 2 |", // rows arriving mid-stream
    ];
    for (const source of cases) {
      expect(renderToStaticMarkup(<StreamingMarkdown source={source} />)).toBe(
        renderToStaticMarkup(<Markdown source={source} />),
      );
    }
  });

  it("per delta, only the unstable suffix re-lexes (O(tail), not O(full text))", () => {
    const { root, container } = mount(<StreamingMarkdown source={""} />);
    const first = "para one is quite long\n\npara **two** tail";
    act(() => root.render(<StreamingMarkdown source={first} />));
    const afterFirst = markdownCacheStats().lexChars;
    // Appending one char must re-lex ~the tail, never the whole message.
    act(() => root.render(<StreamingMarkdown source={`${first}x`} />));
    const delta1 = markdownCacheStats().lexChars - afterFirst;
    expect(delta1).toBeLessThanOrEqual("para **two** tailx".length);
    expect(delta1).toBeLessThan(`${first}x`.length);
    const afterSecond = markdownCacheStats().lexChars;
    act(() => root.render(<StreamingMarkdown source={`${first}xyz`} />));
    expect(markdownCacheStats().lexChars - afterSecond).toBeLessThanOrEqual("para **two** tailxyz".length);
    expect(container.querySelector(".md")?.textContent).toContain("two");
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("the committed prefix is never re-lexed across deltas", () => {
    const { root } = mount(<StreamingMarkdown source={""} />);
    const d1 = "# head\n\nbody **bold** text";
    act(() => root.render(<StreamingMarkdown source={d1} />));
    const lexRuns1 = markdownCacheStats().lexRuns;
    // Three more deltas on the tail: the committed "# head\n\n" chunk is lexed 0 more times.
    act(() => root.render(<StreamingMarkdown source={`${d1} more`} />));
    act(() => root.render(<StreamingMarkdown source={`${d1} more words`} />));
    act(() => root.render(<StreamingMarkdown source={`${d1} more words here`} />));
    // Each delta lexed exactly the growing tail once (3 tail lexes, 0 prefix lexes).
    expect(markdownCacheStats().lexRuns - lexRuns1).toBe(3);
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("a replacement (non-prefix) text resets the boundary, not the output", () => {
    const { root, container } = mount(<StreamingMarkdown source={""} />);
    act(() => root.render(<StreamingMarkdown source={"old turn\n\nold body **b**"} />));
    act(() => root.render(<StreamingMarkdown source={"completely different `code`"} />));
    expect(container.innerHTML).toBe(renderToStaticMarkup(<Markdown source="completely different `code`" />));
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("F1 regression: growth onto a source ending in a bare newline stays ONE para", () => {
    // "a\n".split("\n") yields a phantom trailing "" — the seam rule must not
    // treat it as a blank line, or every paragraph-wrap continuation splits
    // mid-stream (stable block "a" + tail "more text" = two paras; the oracle
    // emits one). Reviewer fuzzed this exact seam (96,000 growth steps).
    expect(stableBoundary("hello world\n")).toBe(0);
    const { root, container } = mount(<StreamingMarkdown source={""} />);
    const d1 = "hello world\n";
    act(() => root.render(<StreamingMarkdown source={d1} />));
    const d2 = "hello world\nmore text";
    act(() => root.render(<StreamingMarkdown source={d2} />));
    expect(container.querySelectorAll(".md-para")).toHaveLength(1); // NOT split
    expect(container.innerHTML).toBe(renderToStaticMarkup(<Markdown source={d2} />));
    // The bare-newline form keeps the no-seam answer across further growth.
    act(() => root.render(<StreamingMarkdown source={`${d2} and more`} />));
    expect(container.querySelectorAll(".md-para")).toHaveLength(1);
    act(() => root.unmount());
    document.body.innerHTML = "";
  });

  it("re-rendering the same source is idempotent (StrictMode double-render shape)", () => {
    const { root, container } = mount(<StreamingMarkdown source={""} />);
    const source = "a\n\nb **bold**\n\nc";
    act(() => root.render(<StreamingMarkdown source={source} />));
    const first = container.innerHTML;
    act(() => root.render(<StreamingMarkdown source={source} />));
    expect(container.innerHTML).toBe(first);
    expect(container.innerHTML).toBe(renderToStaticMarkup(<Markdown source={source} />));
    act(() => root.unmount());
    document.body.innerHTML = "";
  });
});
