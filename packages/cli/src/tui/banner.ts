// M42 §1 — the TUI startup banner. Hand-drawn block-letter "W U D A O" glyph
// art as a character constant (zero dependencies, no figlet), followed by one
// identity line. Printed ONCE by the entrypoint before the first Ink frame
// (TUI only — the REPL/one-shot paths never call this), skipped for --quiet
// and non-TTY stdout, and degraded to a single line on narrow terminals.
// Pure module: every decision is unit-testable without a terminal.

/** Widest allowed banner line (spec: ≤72 columns). */
export const BANNER_MAX_COLS = 72;

/** Below this terminal width the art is replaced by the one-line banner
 *  (spec: columns < 76 → single-line fallback). 76 leaves headroom so the
 *  info line + a margin still fit under the art's budget. */
export const BANNER_MIN_COLS = 76;

// "W U D A O" in 6 rows of half-block letters, one space between letters,
// every row padded to the same width (48 columns — well under the budget).
export const BANNER_GLYPH_LINES: readonly string[] = [
  "██╗    ██╗ ██╗   ██╗ ██████╗   █████╗   ██████╗ ",
  "██║    ██║ ██║   ██║ ██╔══██╗ ██╔══██╗ ██╔═══██╗",
  "██║ █╗ ██║ ██║   ██║ ██║  ██║ ███████║ ██║   ██║",
  "██║███╗██║ ██║   ██║ ██║  ██║ ██╔══██║ ██║   ██║",
  "╚███╔███╔╝ ╚██████╔╝ ██████╔╝ ██║  ██║ ╚██████╔╝",
  " ╚══╝╚══╝   ╚═════╝  ╚═════╝  ╚═╝  ╚═╝  ╚═════╝ ",
];

export interface BannerInfo {
  readonly version: string;
  /** Header label of the active model (log.ts modelLabel — `provider · model`). */
  readonly model: string;
  /** First 8 chars of the session id. */
  readonly session8: string;
  /** Runtime permission mode label (accept / ask / auto / plan). */ // ω99-191: #3
  readonly mode: string;
}

export function bannerInfoLine(info: BannerInfo): string {
  return `悟道Harness v${info.version} · ${info.model} · ${info.session8} · 模式 ${info.mode}`; // ω99-190: #7；品牌弧 09-15：产品名前置
}

/** The narrow-terminal fallback: identity on one line under a small mark. */
export function bannerFallbackLine(info: BannerInfo): string {
  return `◆ WUDAO · ${bannerInfoLine(info)}`;
}

/** The banner's lines for the given terminal width: glyph art + blank +
 *  info line, or the single fallback line below BANNER_MIN_COLS columns.
 *  `columns === undefined` (no winsize available) renders the wide form. */
export function buildBanner(info: BannerInfo, columns: number | undefined): string[] {
  if (columns !== undefined && columns < BANNER_MIN_COLS) return [bannerFallbackLine(info)];
  return [...BANNER_GLYPH_LINES, "", bannerInfoLine(info)];
}

/** Print the banner through `write` (one write per line). Returns whether
 *  anything was printed — `quiet` and non-TTY stdout skip it entirely. */
export function printBanner(
  info: BannerInfo,
  env: { readonly columns?: number; readonly quiet?: boolean; readonly tty?: boolean },
  write: (text: string) => void,
): boolean {
  if (env.quiet === true || env.tty === false) return false;
  for (const line of [...buildBanner(info, env.columns), ""]) write(`${line}\n`);
  return true;
}
