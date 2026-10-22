// ω99-112 — the ref-addressed page snapshot. The collector runs IN the page
// (COLLECT_SCRIPT, an expression page.evaluate can run): it tags every
// visible clickable element with a data-wudao-ref attribute (e1..eN, document
// order), and returns the URL/title, a text outline, and the element list.
// formatSnapshot (pure, Fake-testable) turns that payload into the
// model-facing text under a hard char budget, plus the ref→selector map the
// tools address clicks/types by. A NAVIGATION unloads the tagged DOM, so the
// runtime voids the map on any URL change — a stale ref is an honest error
// telling the model to re-snapshot, never a click into the wrong element.
import type { SnapshotRefEntry } from "./runtime.js";

/** Hard output budget for the model-facing snapshot (maxResultSizeChars
 *  spirit: bounded context, honest truncation note over silent loss). */
export const MAX_SNAPSHOT_CHARS = 12_000;

/** ω99-136 — an element's viewport rect in CSS PIXELS (getBoundingClientRect).
 *  Screenshot bytes (port.ts) are DEVICE pixels (CSS × devicePixelRatio): this
 *  arc reports both spaces honestly and does NOT convert — the single
 *  canonical coordinate layer is the next arc. */
export interface ElementBbox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface CollectedElement {
  readonly ref: string;
  readonly tag: string;
  readonly text: string;
  readonly href?: string;
  readonly value?: string;
  readonly placeholder?: string;
  readonly type?: string;
  readonly checked?: boolean;
  readonly disabled?: boolean;
  /** ω99-136: optional so OLD collected payloads (pre-vision snapshots) stay
   *  shape-compatible — absence means "geometry not collected", never 0,0. */
  readonly bbox?: ElementBbox;
}

export interface CollectedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly elements: readonly CollectedElement[];
}

/** The snapshot collector — a plain-ES EXPRESSION (an IIFE) the default port
 *  hands to page.evaluate. Deterministic, no external state: previous refs
 *  are wiped, visibility is geometry+style, the list caps at 200 elements. */
export const COLLECT_SCRIPT = `(() => {
  const clean = (s, n) => { const t = String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
  document.querySelectorAll("[data-wudao-ref]").forEach((el) => el.removeAttribute("data-wudao-ref"));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none";
  };
  const sel = 'a, button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [onclick]';
  const els = Array.from(document.querySelectorAll(sel)).filter(visible).slice(0, 200);
  const elements = els.map((el, i) => {
    const ref = "e" + (i + 1);
    el.setAttribute("data-wudao-ref", ref);
    const out = { ref: ref, tag: el.tagName.toLowerCase(), text: clean(el.getAttribute("aria-label") || el.textContent || el.value || "", 80) };
    // ω99-136: CSS-pixel viewport rect for the vision lane (see ElementBbox);
    // raw doubles, no rounding — coordinate-space decisions belong to the next arc.
    const r = el.getBoundingClientRect();
    out.bbox = { x: r.x, y: r.y, width: r.width, height: r.height };
    const href = el.getAttribute("href");
    if (el.tagName === "A" && href) out.href = clean(href, 100);
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT") {
      if (el.getAttribute("type")) out.type = el.getAttribute("type");
      if (el.getAttribute("placeholder")) out.placeholder = clean(el.getAttribute("placeholder"), 60);
      if (el.value !== undefined && el.value !== "") out.value = clean(el.value, 60);
      if (el.type === "checkbox" || el.type === "radio") out.checked = !!el.checked;
    }
    if (el.disabled) out.disabled = true;
    return out;
  });
  const text = document.body ? document.body.innerText : "";
  return { url: location.href, title: document.title, text: text.slice(0, 20000), elements: elements };
})()`;

export const refSelector = (ref: string): string => `[data-wudao-ref="${ref}"]`;

/** Tool-input validation: refs are exactly e<positive-digits>. */
export function validRef(ref: string): boolean {
  return /^e[1-9][0-9]{0,4}$/.test(ref);
}

const TRUNCATION_NOTE = "\n[snapshot truncated at the char budget — run browser_snapshot again after scrolling to see more]";

/** One element line: `- e1 [a] "Guide" → /guide` (+input/value facets).
 *  ω99-136: a collected bbox appends `@[x,y,w,h]` (CSS px) so the vision lane
 *  can correlate refs with pixels; the four numbers ride INSIDE the line, so
 *  their chars are spent from the same 12k budget — over budget shrinks the
 *  element list (fit check #3), never the discipline. */
export function elementLine(e: CollectedElement): string {
  const parts: string[] = [`- ${e.ref} [${e.tag}`];
  if (e.type !== undefined) parts.push(`type=${e.type}`);
  if (e.placeholder !== undefined) parts.push(`placeholder="${e.placeholder}"`);
  if (e.checked !== undefined) parts.push(e.checked ? "checked" : "unchecked");
  let line = parts.join(" ") + "]";
  if (e.text !== "") line += ` "${e.text}"`;
  if (e.value !== undefined) line += ` (value: ${e.value})`;
  if (e.href !== undefined) line += ` → ${e.href}`;
  if (e.bbox !== undefined) line += ` @[${e.bbox.x},${e.bbox.y},${e.bbox.width},${e.bbox.height}]`;
  if (e.disabled === true) line += " [disabled]";
  return line;
}

/** Pure: the model-facing snapshot text + the ref→selector map, under the
 *  hard budget. Priority when truncating: keep EVERY element line (the refs
 *  are the actionable surface) and cut the page text first; if the element
 *  list alone still exceeds the budget, cut lines and say so. The refs map
 *  only ever contains refs whose line SURVIVED — a ref the model cannot see
 *  is a stale promise we refuse to hand out. */
export function formatSnapshot(p: CollectedPage): { text: string; refs: Map<string, SnapshotRefEntry> } {
  const header = `# ${p.title}\n${p.url}\n`;
  const emptyNote = p.elements.length === 0 ? "no clickable elements on this page\n" : "";
  const elementLines = p.elements.map(elementLine);
  const listHead = "\n# Clickable elements (address by ref from browser_snapshot)\n";
  const refMapFor = (lines: readonly string[], els: readonly CollectedElement[]): Map<string, SnapshotRefEntry> => {
    const shown = new Set(lines.map((l) => /^- (e[1-9][0-9]{0,4}) /.exec(l)?.[1]).filter((x): x is string => x !== undefined));
    const m = new Map<string, SnapshotRefEntry>();
    for (const e of els) {
      if (shown.has(e.ref)) {
        // ω99-114: carry the type facet so tools.ts can refuse typing into
        // password fields (unknown type stays absent — never guessed).
        // ω99-139: carry the bbox too (browser_click_xy's hit-test source;
        // absent stays absent — never guessed).
        m.set(e.ref, { selector: refSelector(e.ref), desc: `${e.tag} "${e.text}"`, ...(e.type !== undefined ? { type: e.type } : {}), ...(e.bbox !== undefined ? { bbox: e.bbox } : {}) });
      }
    }
    return m;
  };
  // Fit check #1: everything fits — done.
  const full = `${header}\n# Page outline\n${p.text}\n${listHead}${elementLines.join("\n")}\n${emptyNote}`.replace(/\n{3,}/g, "\n\n");
  if (full.length <= MAX_SNAPSHOT_CHARS) {
    return { text: full, refs: refMapFor(elementLines, p.elements) };
  }
  // Fit check #2: keep all element lines, cut the page text.
  const listBlock = `${listHead}${elementLines.join("\n")}\n`;
  const textBudget = MAX_SNAPSHOT_CHARS - header.length - listBlock.length - TRUNCATION_NOTE.length - 16;
  if (textBudget > 200) {
    const text = `${header}\n# Page outline\n${p.text.slice(0, textBudget)}…\n${listBlock}${TRUNCATION_NOTE}`;
    return { text, refs: refMapFor(elementLines, p.elements) };
  }
  // Fit check #3: the element list alone is over budget — cut lines.
  const kept: string[] = [];
  let used = header.length + listHead.length + 24 /* outline remnant */;
  for (const line of elementLines) {
    if (used + line.length + 1 > MAX_SNAPSHOT_CHARS - TRUNCATION_NOTE.length) break;
    kept.push(line);
    used += line.length + 1;
  }
  const text = `${header}\n# Page outline\n${p.text.slice(0, Math.max(0, MAX_SNAPSHOT_CHARS - used - listHead.length - TRUNCATION_NOTE.length - 8))}…\n${listHead}${kept.join("\n")}${TRUNCATION_NOTE}`;
  return { text, refs: refMapFor(kept, p.elements) };
}
