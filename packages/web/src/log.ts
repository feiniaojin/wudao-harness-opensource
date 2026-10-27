// Small display helpers — web mirrors of the cli/src/log.ts functions the
// TUI surfaces reuse (token formatting, truncation) plus the two history
// echo rules that live in app.tsx (first-line user echo, reasoning head).
import { TODO_LINE_MARKS } from "./board.js";

/** `formatTokensK`: 1234 → "1.2k", 987 → "1k" (same rounding as the TUI). */
export function formatTokensK(n: number): string {
  // 129 弧（OpenHands 8784a5946 同款 bug）：≥999_950 时 k 路径会印出
  // "1000k"/"1050k"（无 M 档——DeepSeek V4 1M 窗下 StatusBar 真可命中）。
  // 阈值 999_950 = k 路径四舍五入到 1000.0k 的确切起点（n/100 进位边界）。
  if (n >= 999_950) return Math.round(n / 100_000) / 10 + "M";
  return Math.round(n / 100) / 10 + "k";
}

/** Character-cap with ellipsis (the TUI's truncate). */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** User echo: first line only, with an ellipsis marker when truncated. */
export function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  return idx === -1 ? text : `${text.slice(0, idx)} …`;
}

/** The board line marks (core TODO_LINE_MARKS mirror — see board.ts). */
export { TODO_LINE_MARKS };
