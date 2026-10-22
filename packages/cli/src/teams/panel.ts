// M64-C §C — the in-process team panel's view model (pure; the Ink
// component renders it). Rows keep spawn order; a row IDLE for more than
// 30s hides; more than 3 visible rows collapse into a "+N more" summary
// (working and plan-pending rows NEVER hide — they are the live state).
import type { TeammateRow } from "./runtime.js";

/** Idle rows hide after this long without activity. */
export const TEAM_PANEL_IDLE_HIDE_MS = 30_000;
/** Past this many visible rows, the panel collapses. */
export const TEAM_PANEL_COLLAPSE_AFTER = 3;

export type PanelRow =
  | { readonly kind: "teammate"; readonly row: TeammateRow }
  | { readonly kind: "collapsed"; readonly hidden: number };

/** Derive the panel's rows. Pure. */
export function teammatePanelRows(
  teammates: readonly TeammateRow[],
  now: number,
  opts: { readonly idleHideMs?: number; readonly collapseAfter?: number } = {},
): readonly PanelRow[] {
  const idleHideMs = opts.idleHideMs ?? TEAM_PANEL_IDLE_HIDE_MS;
  const collapseAfter = opts.collapseAfter ?? TEAM_PANEL_COLLAPSE_AFTER;
  const visible: TeammateRow[] = [];
  let hidden = 0;
  for (const t of teammates) {
    const longIdle = t.status === "idle" && now - t.lastActivityAt >= idleHideMs;
    if (longIdle) {
      hidden += 1;
      continue;
    }
    visible.push(t);
  }
  if (visible.length > collapseAfter) {
    const shown = visible.slice(0, collapseAfter);
    const rows: PanelRow[] = shown.map((row) => ({ kind: "teammate", row }));
    rows.push({ kind: "collapsed", hidden: visible.length - collapseAfter + hidden });
    return rows;
  }
  const rows: PanelRow[] = visible.map((row) => ({ kind: "teammate", row }));
  return hidden > 0 ? [...rows, { kind: "collapsed", hidden }] : rows;
}

/** One row's label (the component and tests share it). */
export function formatTeammateRow(row: TeammateRow): string {
  const status = row.status === "plan-pending" ? "📋 方案" : row.status === "working" ? "⚙" : "·"; // ω99-170: #11（状态徽记；⚙/· 原样）
  return `${status} ${row.name} (${row.role})${row.lastError !== undefined ? ` ⚠ ${row.lastError}` : ""}`;
}
