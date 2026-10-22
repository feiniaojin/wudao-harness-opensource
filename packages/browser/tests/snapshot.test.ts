// ω99-112 — snapshot layer (RED first): ref assignment stability, the
// model-facing text format, the 12000-char budget with an honest truncation
// tail note, ref validation, and the in-page collector script's contract.
import { describe, it, expect } from "vitest";
import {
  COLLECT_SCRIPT,
  formatSnapshot,
  refSelector,
  validRef,
  MAX_SNAPSHOT_CHARS,
} from "../src/snapshot.js";
import type { CollectedPage } from "../src/snapshot.js";

const page = (over: Partial<CollectedPage> = {}): CollectedPage => ({
  url: "https://example.test/docs",
  title: "Docs",
  text: "Welcome to the docs.\nRead the guide.",
  elements: [
    { ref: "e1", tag: "a", text: "Guide", href: "/guide" },
    { ref: "e2", tag: "button", text: "Search" },
    { ref: "e3", tag: "input", text: "", type: "text", placeholder: "query" },
  ],
  ...over,
});

describe("formatSnapshot", () => {
  it("renders url/title, the text outline, and the ref-addressed element list in order", () => {
    const { text, refs } = formatSnapshot(page());
    expect(text).toContain("https://example.test/docs");
    expect(text).toContain("Docs");
    expect(text).toContain("Welcome to the docs.");
    const i1 = text.indexOf("e1");
    const i2 = text.indexOf("e2");
    const i3 = text.indexOf("e3");
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(text).toContain("Guide");
    expect(text).toContain("/guide");
    expect(text).toContain('[input type=text placeholder="query"]');
    expect(refs.get("e1")?.selector).toBe(refSelector("e1"));
    expect(refs.get("e1")?.desc).toContain("Guide");
    expect(refs.size).toBe(3);
  });

  it("truncates oversized page text at the budget and appends the honest tail note", () => {
    const big = "x".repeat(50_000);
    const { text } = formatSnapshot(page({ text: big }));
    expect(text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 200);
    expect(text).toContain("snapshot truncated");
    expect(text.endsWith("]")).toBe(true);
  });

  it("keeps the element list when text fits, and truncates the LIST when it alone exceeds the budget", () => {
    const many = Array.from({ length: 900 }, (_, i) => ({ ref: `e${i + 1}`, tag: "a", text: `link ${i + 1}`, href: `/${i + 1}` }));
    const { text, refs } = formatSnapshot(page({ text: "small", elements: many }));
    expect(text).toContain("snapshot truncated");
    expect(text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 200);
    expect(refs.size).toBeLessThan(900);
    // refs only cover what the model can still see — never a stale promise
    for (const ref of refs.keys()) expect(text).toContain(ref);
  });

  it("empty element list is honest, not an error", () => {
    const { text, refs } = formatSnapshot(page({ elements: [] }));
    expect(text).toContain("no clickable elements");
    expect(refs.size).toBe(0);
  });

  it("ω99-114: refs carry the input's type facet — \"password\" arms the typing gate, absent stays absent", () => {
    const { refs } = formatSnapshot(page({
      elements: [
        { ref: "e1", tag: "input", text: "", type: "password" },
        { ref: "e2", tag: "input", text: "", type: "text" },
        { ref: "e3", tag: "input", text: "" }, // type not collected → unknown, NOT password
      ],
    }));
    expect(refs.get("e1")?.type).toBe("password");
    expect(refs.get("e2")?.type).toBe("text");
    expect(refs.get("e3")?.type).toBeUndefined();
  });
});

describe("ref plumbing", () => {
  it("refSelector quotes the ref into the data attribute selector", () => {
    expect(refSelector("e7")).toBe('[data-wudao-ref="e7"]');
  });
  it("validRef accepts e1..eN only", () => {
    expect(validRef("e1")).toBe(true);
    expect(validRef("e12")).toBe(true);
    expect(validRef("e123")).toBe(true);
    expect(validRef("e0")).toBe(false);
    expect(validRef("e")).toBe(false);
    expect(validRef("x1")).toBe(false);
    expect(validRef("")).toBe(false);
    expect(validRef("e1 ")).toBe(false);
    expect(validRef("E1")).toBe(false);
  });
});

describe("COLLECT_SCRIPT (in-page contract)", () => {
  it("tags elements with data-wudao-ref, filters invisible ones, caps the list, and returns the page payload", () => {
    expect(COLLECT_SCRIPT).toContain('data-wudao-ref');
    expect(COLLECT_SCRIPT).toContain("getBoundingClientRect");
    expect(COLLECT_SCRIPT).toContain("visibility");
    expect(COLLECT_SCRIPT).toContain("slice(0, 200)");
    expect(COLLECT_SCRIPT).toContain("location.href");
    expect(COLLECT_SCRIPT).toContain("innerText");
    // an expression (not a statement) — page.evaluate runs it as such
    expect(COLLECT_SCRIPT.trim().startsWith("(() =>")).toBe(true);
    expect(COLLECT_SCRIPT.trim().endsWith("})()")).toBe(true);
  });
});
