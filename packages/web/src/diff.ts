// Inline diff computation — the web mirror of the TUI's cli/src/tui/diff.ts:
// old/new → ctx/del/add hunk. Common prefix and suffix lines become context;
// only the changed middle is marked — a minimal honest patch view without a
// full diff library. (The server already caps old/new at 50k chars.)
export type DiffLine = { kind: "ctx" | "del" | "add"; text: string };

/** A collapsed run's elision marker. `label` (when present) overrides the
 *  rendering text — the balanced preview (455 号报障) names its elided sides
 *  honestly (再 −N 行 / 再 +N 行); the plain context gaps leave it absent so
 *  DiffView renders the default ⋯ N 行未变 ⋯ phrasing (ω99-295 中文化 — the
 *  English string was the only inline English copy in the Chinese UI). */
export type DiffGap = { kind: "gap"; count: number; label?: string };

/** Any row a diff view renders — a line, or a gap marker. */
export type DiffRow = DiffLine | DiffGap;

/** M51 §4 (A7): wall-clock guard for the prefix/suffix scans — on overrun the
 *  diff degrades to the honest whole-replace hunk instead of hanging. */
export const DIFF_SCAN_BUDGET_MS = 5_000;

/** M51 §4 (A7): escape diff text for a String.replace REPLACEMENT slot
 *  ($-sequences are templates there). Views here use template literals; this
 *  is the contract helper for replace()-based consumers. */
export function escapeForReplace(text: string): string {
  return text.replace(/\$/g, "$$$$");
}

export function computeDiff(oldString: string, newString: string): DiffLine[] {
  const a = oldString.split("\n");
  const b = newString.split("\n");
  const deadline = Date.now() + DIFF_SCAN_BUDGET_MS;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    if ((start & 0xfff) === 0 && Date.now() > deadline) return wholeReplace(a, b);
    start++;
  }
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    if (((a.length - endA) & 0xfff) === 0 && Date.now() > deadline) return wholeReplace(a, b);
    endA--;
    endB--;
  }
  const out: DiffLine[] = [];
  for (let i = 0; i < start; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  for (let i = start; i <= endA; i++) out.push({ kind: "del", text: a[i] ?? "" });
  for (let i = start; i <= endB; i++) out.push({ kind: "add", text: b[i] ?? "" });
  for (let i = endA + 1; i < a.length; i++) out.push({ kind: "ctx", text: a[i] ?? "" });
  return out;
}

/** The degraded hunk: no context claim, one honest whole-file replacement. */
function wholeReplace(a: readonly string[], b: readonly string[]): DiffLine[] {
  return [
    ...a.map((text) => ({ kind: "del" as const, text })),
    ...b.map((text) => ({ kind: "add" as const, text })),
  ];
}

/** Context-line budget: long unchanged runs collapse to head/tail windows
 *  (the web's richer diff — the TUI shows everything, a browser column is
 *  narrower than a terminal's scrollback budget). */
export function collapseContext(hunk: DiffLine[], keep = 3): DiffRow[] {
  const out: DiffRow[] = [];
  let run: DiffLine[] = [];
  const flushRun = (): void => {
    if (run.length <= keep * 2) {
      out.push(...run);
    } else {
      out.push(...run.slice(0, keep), { kind: "gap", count: run.length - keep * 2 }, ...run.slice(run.length - keep));
    }
    run = [];
  };
  for (const l of hunk) {
    if (l.kind === "ctx") run.push(l);
    else {
      flushRun();
      out.push(l);
    }
  }
  flushRun();
  return out;
}

/** #455 (0.3.83 报障「很多 -号的行，+号的行没有看到」): the balanced two-sign
 *  preview. computeDiff emits EVERY deletion before the first addition (git's
 *  hunk order), so a folded diff window whose ceiling sat inside the del block
 *  read as "only deletions" — measured on the reported session, 19/27 edits
 *  had their whole `+` block below the fold. The preview keeps each side's
 *  head (perSide rows) and elides the rest with honest counted gap markers,
 *  so BOTH signs are visible without scrolling. Pure rows→rows; the caller
 *  decides when to use it (the card folds only hunks over its line cap). */
export function balancedDiffRows(rows: readonly DiffRow[], perSide: number): DiffRow[] {
  const side = (kind: "del" | "add", sign: string): DiffRow[] => {
    const lines = rows.filter((r): r is DiffLine => r.kind === kind);
    const head = lines.slice(0, perSide);
    const rest = lines.length - head.length;
    // rest counts the elided rows of THIS side only — the marker never
    // borrows the other side's count (the honest-total rule).
    return rest > 0 ? [...head, { kind: "gap", count: rest, label: `⋯ 再 ${sign}${rest} 行 ⋯` }] : head;
  };
  return [...side("del", "-"), ...side("add", "+")];
}

// ---------------------------------------------------------------------------
// M63 §D — word-level intra-line highlight (research 35 #3). Zero-dep on
// purpose: the package hand-rolls its line diff already, and the same
// philosophy (trim the common prefix/suffix, mark the middle) works at token
// granularity — whitespace tokens are kept so the concatenated spans
// reproduce the line EXACTLY, and leading whitespace (indentation) lands in
// the common prefix, so it is never marked (the pattern's 缩进不标 rule).
// ---------------------------------------------------------------------------

export interface WordSpan {
  readonly text: string;
  readonly changed: boolean;
}

/** Whitespace-preserving tokens: words and the runs between them. */
function tokenize(line: string): string[] {
  return line.split(/(\s+)/).filter((t) => t !== "");
}

const spans = (text: string, changed: boolean): WordSpan[] => (text === "" ? [] : [{ text, changed }]);

/** A single changed token per side. The refinement trims the common
 *  character prefix/suffix of the two tokens (so "userAge=32" vs
 *  "userAge=33" highlights only "2"/"3") — but when either side's middle
 *  comes out EMPTY (e.g. "total" vs "subtotal"), word-level highlighting is
 *  the honest view: both whole tokens are marked. The char offsets are
 *  computed once and shared by both sides, so the spans stay consistent. */
function changedPair(a: string, b: string): { readonly a: readonly WordSpan[]; readonly b: readonly WordSpan[] } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);
  if (aMid === "" || bMid === "") {
    return { a: spans(a, true), b: spans(b, true) };
  }
  return {
    a: [...spans(a.slice(0, p), false), ...spans(aMid, true), ...spans(a.slice(a.length - s), false)],
    b: [...spans(b.slice(0, p), false), ...spans(bMid, true), ...spans(b.slice(b.length - s), false)],
  };
}

/** Word-level intra-line diff: common token prefix/suffix stay unmarked, the
 *  middle tokens are marked changed. Identical lines produce one unmarked
 *  span per side. */
export function diffWords(oldLine: string, newLine: string): { readonly old: readonly WordSpan[]; readonly new: readonly WordSpan[] } {
  if (oldLine === newLine) return { old: spans(oldLine, false), new: spans(newLine, false) };
  const a = tokenize(oldLine);
  const b = tokenize(newLine);
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);
  // The character refinement only applies when both middles are one token
  // (mapping char offsets back onto token lists would over-split).
  const refined =
    aMid.length === 1 && bMid.length === 1 ? changedPair(aMid[0] ?? "", bMid[0] ?? "") : { a: spans(aMid.join(""), true), b: spans(bMid.join(""), true) };
  return {
    old: [...spans(a.slice(0, p).join(""), false), ...refined.a, ...spans(a.slice(a.length - s).join(""), false)],
    new: [...spans(b.slice(0, p).join(""), false), ...refined.b, ...spans(b.slice(b.length - s).join(""), false)],
  };
}
