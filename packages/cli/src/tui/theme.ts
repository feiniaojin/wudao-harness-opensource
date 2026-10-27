// TUI theme (M25-B1) — the single source of color/spacing constants for every
// render component. Components must reference T / these constants and never
// scatter color literals, so a future palette swap is a one-file change.
/** Semantic palette (ink color names). */
export const T = {
  /** Prompts, spinners, inline code — the interactive accent. */
  accent: "cyan",
  /** Structural/quiet text: previews, hints, dividers. */
  dim: "gray",
  /** Success: diff adds, done board rows. */
  ok: "green",
  /** Warnings: notices, context near-limit marker. */
  warn: "yellow",
  /** Errors: failed tools, error entries, diff deletes. */
  err: "red",
  /** Todo board / diff header accent. */
  board: "magenta",
} as const;

/** Horizontal rule glyph (dividers: `── text ──`). */
export const SEP = "─";
/** Segment separator for single-line composites (status bar). */
export const SEGMENT_SEP = " │ ";
/** User-echo / input prompt glyph. */
export const PROMPT = "›";
/** Blank lines between Static history entries (turn rhythm, M25-B2). */
export const ENTRY_GAP_LINES = 1;
