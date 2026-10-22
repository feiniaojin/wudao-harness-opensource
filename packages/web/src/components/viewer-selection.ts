// ω99-148 — the A layer under FileViewer's 选中修改: pure DOM-derived
// helpers for turning a live Selection over the read-only code lines into
// a prefilled edit ask. Zero React, zero editor library — line numbers
// come off the data-line attrs the renderer already computes (i+1), the
// text off Selection.toString() (the browser's own word, user-select:none
// gutters excluded by it). Component wiring lives in FileViewer.tsx.

/** The read-side payload the chip rides: normalized line span + the
 *  cleaned quote. first/last are 1-based inclusive. */
export interface SelectionLines {
  first: number;
  last: number;
  text: string;
}

/** Resolve the .viewer-line[data-line] a node lives on, walking
 *  parentElement up through the container. NaN / out-of-bounds digits and
 *  nodes with no data-line ancestor before the container → null. */
export function lineNumberOf(node: Node | null, container: HTMLElement): number | null {
  let el: HTMLElement | null = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el !== null) {
    // ω99-148: the container itself carries no line — walking onto it (or
    // past it) means the node never sat on a data-line INSIDE the viewer.
    if (el === container) return null;
    const raw = el.getAttribute("data-line");
    if (raw !== null) {
      const n = Number(raw);
      return Number.isFinite(n) && n >= 1 ? n : null;
    }
    el = el.parentElement;
  }
  return null;
}

/** Read a Selection into {first, last, text}: BOTH endpoints must resolve
 *  to lines inside the container (either outside → null); first=min,
 *  last=max (drags run both directions); the text is
 *  Selection.toString() with per-line trailing whitespace stripped and
 *  the whole trimmed — an empty result is no selection. */
export function readSelection(container: HTMLElement, sel: Selection | null): SelectionLines | null {
  if (sel === null) return null;
  const a = lineNumberOf(sel.anchorNode, container);
  const f = lineNumberOf(sel.focusNode, container);
  if (a === null || f === null) return null;
  // ω99-148: 逐行去行尾空白、整体 trim — line-end padding picked up by
  // the drag never reaches the ask.
  const text = sel
    .toString()
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .trim();
  if (text === "") return null;
  return { first: Math.min(a, f), last: Math.max(a, f), text };
}

/** The prefilled ask template — the fence quotes the (cleaned) selection;
 *  the line range stays real even when the quote elides (file line counts
 *  are facts, omission lives only in the citation). */
export function buildEditAsk(path: string, first: number, last: number, text: string): string {
  // ω99-148: 单行不带连字符 (第 7 行, not 第 7-7 行).
  const range = first === last ? `第 ${first} 行` : `第 ${first}-${last} 行`;
  // ω99-148: 超 3000 字符 → 首 1400 + 中略 + 尾 1400.
  const quote = text.length > 3000 ? `${text.slice(0, 1400)}\n…（中略）\n${text.slice(-1400)}` : text;
  return `请修改 ${path} ${range}：\n\n\`\`\`\n${quote}\n\`\`\`\n\n我的要求：`;
}
