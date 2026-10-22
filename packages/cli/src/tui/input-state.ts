// Pure multi-line input key-handling state machine — no React, no Ink.
// Consumed by input.tsx (Ink useInput maps its `key` booleans into KeyInfo)
// and unit-testable in isolation. All transitions return a new InputState
// (immutable); submit is signalled by returning `{ submit }` instead.

export interface InputState {
  /** Current buffer, one entry per logical line (always at least one). */
  lines: string[];
  /** Active line the cursor sits on. */
  row: number;
  /** Cursor column within the active line, 0..lines[row].length (M44 §1). */
  col: number;
}

export type KeyInfo = {
  /** Printable text to insert (may be >1 char on paste). */
  input?: string;
  leftArrow?: boolean;
  rightArrow?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  backspace?: boolean;
  delete?: boolean;
  home?: boolean;
  end?: boolean;
  esc?: boolean;
};

export function createInputState(): InputState {
  return { lines: [""], row: 0, col: 0 };
}

export type HandleKeyResult = InputState | { submit: string };

export function isSubmit(r: HandleKeyResult): r is { submit: string } {
  return "submit" in r;
}

// --- M44 §2 — submitted-prompt history -------------------------------------
// A pure list the frontend owns: recall swaps the whole buffer for the
// pointed-at entry (cursor at its end); the live draft is stashed when
// navigation leaves the newest position and restored on the way back down.
// Recall triggering (↑ at the first row / ↓ at the last row; single-line
// input qualifies at both ends) lives in the component, which knows the
// buffer shape; these functions only move the pointer.

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

/** One step older. `current` (the whole buffer, joined) is stashed when
 *  leaving the live draft; edits made to a recalled entry are NOT kept —
 *  moving on discards them, shell-style. Null at the oldest entry. */
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

/** An input state holding `text` with the cursor at its end — the shape a
 *  history recall installs (multi-line entries round-trip through "\n"). */
export function inputStateFromText(text: string): InputState {
  const lines = text.split("\n");
  const row = lines.length - 1;
  return { lines, row, col: (lines[row] ?? "").length };
}

/**
 * Apply one key event to the state.
 *
 * - typing inserts at `[row][col]` (M44 §1; append when col is at EOL)
 * - an input chunk containing `\n` (paste) splits at the cursor: the first
 *   fragment is inserted at col, the remaining fragments become new lines
 *   after it, the text right of the cursor lands at the end of the last
 *   fragment, and the cursor sits after the last fragment
 * - other control characters are stripped per-char (a chunk is never dropped
 *   whole because one char is a control char)
 * - `\` + Enter: a backslash immediately LEFT of the cursor strips it and
 *   splits the line at the cursor (row+1, col 0)
 * - bare Enter returns `{ submit: lines.join("\n") }` ("" when empty —
 *   callers decide whether to ignore empty submits)
 * - Backspace deletes `[col-1]` (joining to the previous row, cursor at the
 *   join point, when col=0 and row>0); Delete removes `[col]` (joining the
 *   next row into the current one when the cursor is at EOL)
 * - ←/→ move within the current line (clamped); Home/End go to line
 *   start/end; ↑/↓ move the row, clamping col to the target line's length
 * - Esc is a no-op
 */

// Control chars (C0 + DEL) stripped from typed/pasted input. `\n` is handled
// by the paste rule before this filter runs.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
export function handleKey(state: InputState, key: KeyInfo): HandleKeyResult {
  const row = state.row;
  const line = state.lines[row] ?? "";
  // Defensive clamp: states built elsewhere (or after a row move) may carry a
  // col past the line's end.
  const col = Math.min(Math.max(state.col, 0), line.length);

  if (key.return) {
    if (col > 0 && line[col - 1] === "\\") {
      const lines = state.lines.slice();
      lines[row] = line.slice(0, col - 1);
      lines.splice(row + 1, 0, line.slice(col));
      return { lines, row: row + 1, col: 0 };
    }
    return { submit: state.lines.join("\n") };
  }

  if (key.backspace) {
    if (col > 0) {
      const lines = state.lines.slice();
      lines[row] = line.slice(0, col - 1) + line.slice(col);
      return { lines, row, col: col - 1 };
    }
    if (row > 0) {
      const prev = state.lines[row - 1] ?? "";
      const lines = state.lines.filter((_, i) => i !== row);
      lines[row - 1] = prev + line;
      return { lines, row: row - 1, col: prev.length };
    }
    return state;
  }

  if (key.delete) {
    if (col < line.length) {
      const lines = state.lines.slice();
      lines[row] = line.slice(0, col) + line.slice(col + 1);
      return { lines, row, col };
    }
    if (row < state.lines.length - 1) {
      const next = state.lines[row + 1] ?? "";
      const lines = state.lines.filter((_, i) => i !== row + 1);
      lines[row] = line + next;
      return { lines, row, col };
    }
    return state;
  }

  if (key.upArrow) {
    return row > 0
      ? { ...state, row: row - 1, col: Math.min(col, (state.lines[row - 1] ?? "").length) }
      : state;
  }
  if (key.downArrow) {
    return row < state.lines.length - 1
      ? { ...state, row: row + 1, col: Math.min(col, (state.lines[row + 1] ?? "").length) }
      : state;
  }

  if (key.leftArrow) {
    return col > 0 ? { ...state, col: col - 1 } : state;
  }
  if (key.rightArrow) {
    return col < line.length ? { ...state, col: col + 1 } : state;
  }
  if (key.home) {
    return col === 0 ? state : { ...state, col: 0 };
  }
  if (key.end) {
    return col === line.length ? state : { ...state, col: line.length };
  }
  if (key.esc) {
    return state;
  }

  const text = key.input ?? "";
  if (text === "") {
    return state;
  }

  // Paste: split on \n first — the paste rule runs before the control-char
  // filter. Remaining control chars inside each fragment are stripped
  // per-char (e.g. the \r of a CRLF pair); empty fragments stay as (empty)
  // pasted lines.
  if (text.includes("\n")) {
    const fragments = text.split("\n").map((f) => f.replace(CONTROL_CHARS, ""));
    const lines = state.lines.slice();
    const after = line.slice(col);
    lines[row] = line.slice(0, col) + (fragments[0] ?? "");
    for (let i = 1; i < fragments.length; i++) {
      lines.splice(row + i, 0, fragments[i] ?? "");
    }
    const last = row + fragments.length - 1;
    lines[last] = (lines[last] ?? "") + after;
    return { lines, row: last, col: (fragments[fragments.length - 1] ?? "").length };
  }

  const filtered = text.replace(CONTROL_CHARS, "");
  if (filtered === "") {
    return state;
  }
  const lines = state.lines.slice();
  lines[row] = line.slice(0, col) + filtered + line.slice(col);
  return { ...state, lines, col: col + filtered.length };
}
