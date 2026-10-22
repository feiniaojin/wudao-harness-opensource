// The web input machine — the RULES of cli/src/tui/input-state.ts (M44)
// reused, adapted to a native textarea: the browser owns char-level editing
// and paste, so what is mirrored here is every decision rule the surface
// behavior depends on —
//
//   - submitted-prompt history: adjacent-deduped, capped at 100, pointer
//     over entries+1 slots, the live draft stashed on the way up and
//     restored on the way down, edits to a recalled entry discarded on move
//   - ↑ at the FIRST line / ↓ at the LAST line recall (single-line input
//     qualifies at both ends); mid rows of a multi-line buffer navigate
//   - Enter submits; `\` immediately left of the caret strips and splits
//     (the TUI's continuation sequence)
//
// The pure functions are verbatim ports; caret math maps the textarea's
// flat selectionStart onto the same {lines, row, col} shape.

/** Maximum remembered prompts (spec §2: ≤100). */
export const INPUT_HISTORY_MAX = 100;

export interface InputHistory {
  /** Submitted prompts, oldest first, adjacent-deduped. */
  readonly entries: readonly string[];
  /** Index of the recalled entry; `entries.length` = the live draft. */
  readonly pointer: number;
  /** The draft stashed when navigation left the live position (null = none). */
  readonly draft: string | null;
}

export function createInputHistory(): InputHistory {
  return { entries: [], pointer: 0, draft: null };
}

/** Record a submitted prompt: empty and adjacent-duplicate entries are
 *  skipped, the list is capped at INPUT_HISTORY_MAX (oldest dropped), and
 *  the pointer resets to the live position. */
export function submitToHistory(h: InputHistory, text: string): InputHistory {
  if (text === "" || h.entries[h.entries.length - 1] === text) {
    return { entries: h.entries, pointer: h.entries.length, draft: null };
  }
  const entries = [...h.entries, text];
  if (entries.length > INPUT_HISTORY_MAX) entries.splice(0, entries.length - INPUT_HISTORY_MAX);
  return { entries, pointer: entries.length, draft: null };
}

/** One step older. `current` (the whole buffer) is stashed when leaving the
 *  live draft; edits made to a recalled entry are NOT kept — moving on
 *  discards them, shell-style. Null at the oldest entry. */
export function recallOlder(h: InputHistory, current: string): InputHistory | null {
  if (h.pointer <= 0) return null;
  return {
    entries: h.entries,
    pointer: h.pointer - 1,
    draft: h.pointer === h.entries.length ? current : h.draft,
  };
}

/** One step newer. Null at the live position (nothing newer exists). */
export function recallNewer(h: InputHistory): InputHistory | null {
  if (h.pointer >= h.entries.length) return null;
  return { entries: h.entries, pointer: h.pointer + 1, draft: h.draft };
}

/** The buffer text the pointed-at slot shows: the entry, or the stashed
 *  draft once back at the live position. */
export function recalledText(h: InputHistory): string {
  return h.pointer < h.entries.length ? (h.entries[h.pointer] ?? "") : (h.draft ?? "");
}

// --- caret mapping (textarea selectionStart → {row, col}) -----------------

export interface CaretPos {
  readonly row: number;
  readonly col: number;
}

export function caretPos(value: string, selectionStart: number): CaretPos {
  const upto = value.slice(0, Math.max(0, Math.min(selectionStart, value.length)));
  const lines = upto.split("\n");
  return { row: lines.length - 1, col: (lines[lines.length - 1] ?? "").length };
}

/** The line the caret sits on (the slash menu's token source). */
export function caretLine(value: string, selectionStart: number): string {
  const { row } = caretPos(value, selectionStart);
  return value.split("\n")[row] ?? "";
}

// --- the Enter rule ---------------------------------------------------------

export type EnterAction =
  | { kind: "submit"; text: string }
  | { kind: "newline"; value: string; caret: number };

/** Bare Enter on the buffer: submit — UNLESS a `\` sits immediately left of
 *  the caret, which strips and splits (continuation). Shift+Enter never
 *  reaches here (the textarea's default newline). */
export function enterAction(value: string, selectionStart: number): EnterAction {
  const caret = Math.max(0, Math.min(selectionStart, value.length));
  if (caret > 0 && value[caret - 1] === "\\") {
    // The backslash at caret-1 is replaced by the newline, so the caret
    // lands right after it — same index it held.
    return { kind: "newline", value: value.slice(0, caret - 1) + "\n" + value.slice(caret), caret };
  }
  return { kind: "submit", text: value };
}
