// ω99-136 — the vision capability on the snapshot layer (RED first):
// CollectedElement.bbox (CSS pixels) renders into the element line as
// @[x,y,w,h], the collector script gathers getBoundingClientRect for every
// ref'd element, the 12k budget discipline is UNCHANGED (bbox chars are spent
// from the same budget → over budget shrinks the element list from e1 with
// refs still consecutive), and old payloads without bbox render byte-identical
// to the pre-vision shape (shape compatibility — the zero-drift pin).
import { describe, it, expect } from "vitest";
import { COLLECT_SCRIPT, formatSnapshot, MAX_SNAPSHOT_CHARS } from "../src/snapshot.js";
import type { CollectedPage, ElementBbox } from "../src/snapshot.js";

const page = (over: Partial<CollectedPage> = {}): CollectedPage => ({
  url: "https://example.test/app",
  title: "App",
  text: "canvas-y app shell.\nTools on the right.",
  elements: [],
  ...over,
});

const B1: ElementBbox = { x: 32, y: 144, width: 120, height: 24 };
const B2: ElementBbox = { x: 12.5, y: 300.25, width: 60, height: 30 };

describe("formatSnapshot × bbox (CSS-pixel geometry in the model-facing line)", () => {
  it("renders each collected bbox as @[x,y,w,h] with the exact four numbers", () => {
    const { text, refs } = formatSnapshot(page({
      elements: [
        { ref: "e1", tag: "a", text: "Guide", href: "/guide", bbox: B1 },
        { ref: "e2", tag: "button", text: "Go", bbox: B2 },
      ],
    }));
    expect(text).toContain('@[32,144,120,24]');
    // fractional CSS pixels survive unrounded — honest raw reporting
    expect(text).toContain('@[12.5,300.25,60,30]');
    // the ref map is unchanged by geometry: still one entry per visible line
    expect(refs.size).toBe(2);
    expect(refs.get("e1")?.selector).toBe('[data-wudao-ref="e1"]');
  });

  it("shape compatibility: elements WITHOUT bbox render with no @ segment (pre-vision shape intact)", () => {
    const legacy = formatSnapshot(page({
      elements: [
        { ref: "e1", tag: "a", text: "Guide", href: "/guide" },
        { ref: "e2", tag: "input", text: "", type: "text", placeholder: "q" },
      ],
    }));
    expect(legacy.text).not.toContain("@[");
    expect(legacy.text).toContain('- e1 [a] "Guide" → /guide');
  });
});

describe("budget discipline × bbox (12k unchanged — cut elements, never the discipline)", () => {
  const mk = (i: number, bbox?: ElementBbox) => ({
    ref: `e${i + 1}`,
    tag: "a",
    text: `link ${i + 1}`,
    href: `/${i + 1}`,
    ...(bbox !== undefined ? { bbox } : {}),
  });
  const many = (bbox?: ElementBbox): CollectedPage =>
    page({ text: "small", elements: Array.from({ length: 900 }, (_, i) => mk(i, bbox)) });

  it("bbox chars spend budget: fewer element lines fit than without bbox", () => {
    const withBbox = formatSnapshot(many({ x: 8, y: 16, width: 120, height: 24 }));
    const noBbox = formatSnapshot(many());
    expect(withBbox.text).toContain("snapshot truncated");
    expect(noBbox.text).toContain("snapshot truncated");
    expect(withBbox.text.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS + 200);
    expect(withBbox.refs.size).toBeLessThan(900);
    // the pin: geometry is not free — strictly fewer refs survive WITH bbox
    expect(withBbox.refs.size).toBeLessThan(noBbox.refs.size);
    // only refs whose line survived are promised, and each is visible in text
    for (const ref of withBbox.refs.keys()) expect(withBbox.text).toContain(ref);
  });

  it("the surviving list stays a consecutive e1..eN prefix in document order", () => {
    const { refs } = formatSnapshot(many({ x: 100, y: 200, width: 300, height: 40 }));
    const keys = [...refs.keys()];
    expect(keys.length).toBeGreaterThan(0);
    keys.forEach((k, i) => expect(k).toBe(`e${i + 1}`));
  });
});

describe("COLLECT_SCRIPT × bbox (in-page contract)", () => {
  it("gathers getBoundingClientRect x/y/width/height onto out.bbox for every ref'd element", () => {
    expect(COLLECT_SCRIPT).toContain("const r = el.getBoundingClientRect();");
    expect(COLLECT_SCRIPT).toContain("out.bbox = { x: r.x, y: r.y, width: r.width, height: r.height };");
    // still an evaluate-able expression (unchanged contract shape)
    expect(COLLECT_SCRIPT.trim().startsWith("(() =>")).toBe(true);
    expect(COLLECT_SCRIPT.trim().endsWith("})()")).toBe(true);
  });
});
