// @vitest-environment jsdom
// ω99-148 — the A layer, RED-first: the selection→ask pure functions
// (zero React). The component walks REAL DOM (line numbers off the
// data-line attrs the renderer already computes, text off
// Selection.toString()), so the tests build the exact .viewer-code
// skeleton by hand. A deterministic Selection stand-in pins anchor/focus
// as real nodes (the parentElement walk is the code under test) with
// toString() verbatim — jsdom's Range can't express a REVERSED
// anchor/focus pair and ignores user-select:none, so the browser's word
// is what readSelection takes and the fake speaks it.
import { afterEach, describe, expect, it } from "vitest";
import { buildEditAsk, lineNumberOf, readSelection } from "../src/components/viewer-selection.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** The .viewer-code skeleton FileViewer renders: per line a
 *  .viewer-line[data-line=N] > .viewer-gutter + .viewer-src Text node. */
const buildLines = (texts: string[]): { container: HTMLElement; src: HTMLSpanElement[] } => {
  const container = document.createElement("div");
  container.className = "viewer-code";
  const src = texts.map((t, i) => {
    const line = document.createElement("div");
    line.className = "viewer-line";
    line.dataset.line = String(i + 1);
    const gutter = document.createElement("span");
    gutter.className = "viewer-gutter";
    gutter.textContent = String(i + 1);
    const s = document.createElement("span");
    s.className = "viewer-src";
    s.textContent = t;
    line.append(gutter, s);
    container.append(line);
    return s;
  });
  return { container, src };
};

/** The Selection stand-in — anchorNode/focusNode are live nodes the walk
 *  resolves; toString() is pinned verbatim (see the header note). */
const fakeSel = (anchorNode: Node, focusNode: Node, text: string): Selection =>
  ({ anchorNode, focusNode, toString: () => text }) as unknown as Selection;

describe("lineNumberOf (ω99-148)", () => {
  it("resolves a src Text node to its .viewer-line[data-line], a gutter element too", () => {
    const { container, src } = buildLines(["aa", "bb", "cc"]);
    // The Text node inside .viewer-src (what a Selection anchors to).
    expect(lineNumberOf(src[2]?.firstChild ?? null, container)).toBe(3);
    // The gutter element itself sits on the same line element.
    expect(lineNumberOf(container.querySelectorAll(".viewer-gutter")[1] ?? null, container)).toBe(2);
    // The line element resolves its own number.
    expect(lineNumberOf(container.querySelectorAll(".viewer-line")[2] ?? null, container)).toBe(3);
  });

  it("null outside the container, or inside it with no data-line ancestor before the container", () => {
    const { container, src } = buildLines(["aa", "bb", "cc"]);
    const outsider = document.createElement("div");
    outsider.textContent = "elsewhere";
    document.body.append(outsider, container);
    // A node in a DIFFERENT tree — the walk must not reach a data-line.
    expect(lineNumberOf(outsider.firstChild, container)).toBeNull();
    // A bare child of the container (no .viewer-line wrapper).
    const bare = document.createElement("span");
    container.append(bare);
    expect(lineNumberOf(bare, container)).toBeNull();
    // The container itself carries no line.
    expect(lineNumberOf(container, container)).toBeNull();
  });

  it("null on NaN / out-of-bounds digits (line numbers are 1-based)", () => {
    const container = document.createElement("div");
    for (const bad of ["abc", "0", "-2", ""]) {
      const line = document.createElement("div");
      line.dataset.line = bad;
      container.append(line);
      expect(lineNumberOf(line, container)).toBeNull();
    }
  });
});

describe("readSelection (ω99-148)", () => {
  it("forward and REVERSED crossings both normalize to first=min, last=max", () => {
    const { container, src } = buildLines(["aa", "bb", "cc", "dd", "ee"]);
    const n3 = src[2]?.firstChild as Node;
    const n5 = src[4]?.firstChild as Node;
    // Forward: anchor 3 → focus 5.
    expect(readSelection(container, fakeSel(n3, n5, "cc\ndd\nee"))).toEqual({ first: 3, last: 5, text: "cc\ndd\nee" });
    // Reversed: anchor 5 → focus 3 — same normalized span.
    expect(readSelection(container, fakeSel(n5, n3, "cc\ndd\nee"))).toEqual({ first: 3, last: 5, text: "cc\ndd\nee" });
  });

  it("null when either endpoint sits outside the container, or the sel is null", () => {
    const { container, src } = buildLines(["aa", "bb"]);
    const outsider = document.createElement("div");
    outsider.textContent = "out";
    document.body.append(outsider);
    const n1 = src[0]?.firstChild as Node;
    expect(readSelection(container, fakeSel(outsider.firstChild as Node, n1, "x"))).toBeNull();
    expect(readSelection(container, fakeSel(n1, outsider.firstChild as Node, "x"))).toBeNull();
    expect(readSelection(container, null)).toBeNull();
  });

  it("strips per-line trailing whitespace then trims overall; empty → null", () => {
    const { container, src } = buildLines(["aa", "bb", "cc"]);
    const n1 = src[0]?.firstChild as Node;
    const n3 = src[2]?.firstChild as Node;
    // A drag that caught line-end padding on every line plus edge blank.
    expect(readSelection(container, fakeSel(n1, n3, "  aa  \n bb \n cc  "))).toEqual({ first: 1, last: 3, text: "aa\n bb\n cc" });
    // Whitespace-only content is no selection.
    expect(readSelection(container, fakeSel(n1, n3, "   \n  \n"))).toBeNull();
  });
});

describe("buildEditAsk (ω99-148)", () => {
  it("multi-line template: path + 第 first-last 行 + fenced snippet + 我的要求：", () => {
    expect(buildEditAsk("src/a.ts", 3, 5, "cc\ndd\nee")).toBe(
      "请修改 src/a.ts 第 3-5 行：\n\n```\ncc\ndd\nee\n```\n\n我的要求：",
    );
  });

  it("single-line form drops the hyphen: 第 N 行", () => {
    const out = buildEditAsk("a.txt", 7, 7, "only line");
    expect(out.startsWith("请修改 a.txt 第 7 行：")).toBe(true);
    expect(out).not.toContain("7-7");
    expect(out.endsWith("我的要求：")).toBe(true);
  });

  it("over 3000 chars the quote elides to head 1400 + …（中略） + tail 1400; the line range stays real", () => {
    const head = "H".repeat(1400);
    const tail = "T".repeat(1400);
    const mid = "M".repeat(300); // 3100 > 3000
    const out = buildEditAsk("big.ts", 2, 99, `${head}${mid}${tail}`);
    expect(out).toContain(`${head}\n…（中略）\n${tail}`);
    expect(out).not.toContain("M"); // the elided middle is gone
    expect(out).toContain("第 2-99 行"); // 省略只发生在引文里
    // At exactly 3000 the quote stays whole.
    const whole = buildEditAsk("edge.ts", 1, 2, "X".repeat(3000));
    expect(whole).toContain("X".repeat(3000));
    expect(whole).not.toContain("中略");
  });
});
