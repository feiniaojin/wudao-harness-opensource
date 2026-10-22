// ResumePicker — the /resume selector, the web mirror of the TUI's numbered
// notice-list pick (app.tsx's resumePicker state): rows from the sessions
// op, click (or 1..N) loads via the resume op, which replays the session as
// a history reset. Cancel returns to the input.
// ui-review-r2 I5: the cancel affordances are REAL — Escape and a scrim
// click close (the old button label promised an Esc it never wired).
import { useEffect, useRef } from "react";
import type { SessionRow } from "../protocol.js";
import { useFocusReturn } from "../use-focus-return.js";

function formatMtime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
}

export function ResumePicker({ rows, onPick, onCancel }: {
  rows: readonly SessionRow[];
  onPick: (id: string) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // UI-5 INFO-2: the focus-return sweep — the composer the /resume command
  // came from gets its focus back on pick/cancel.
  useFocusReturn();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel(); // the scrim, not the modal
      }}
    >
      <div className="modal-card pop-in" role="dialog" aria-label="恢复会话" ref={ref} tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
            return;
          }
          if (!/^[1-9]$/.test(e.key)) return;
          const row = rows[Number(e.key) - 1];
          if (row !== undefined) {
            e.preventDefault();
            onPick(row.id);
          }
        }}
      >
        <h3>选择要恢复的会话</h3>
        {/* tokfinish §7 (批1 review M2 单行歧义): the weak scope note — data
            source read before writing it. The sessions op (agent-driver's
            sessions()) lists <workspaceRoot>/.wudao/sessions filtered to
            sessions whose recorded workspace_root matches THIS worktree
            (M58 §C#7 — the same filter the TUI picker and --list-sessions
            default to), so a session remembered from ANOTHER workspace is
            not missing/broken — it is out of this list's scope by design.
            The row-level 「暂无会话」 fallback (no name, no first message)
            stays as-is; the M2 rename to 「空会话」 remains copy-batch
            material, not this batch's scope. */}
        <div className="muted">仅列出记录在当前工作区的会话</div>
        <div className="picker">
          {rows.map((r, i) => (
            <button key={r.id} type="button" className="pickrow" onClick={() => onPick(r.id)}>
              <span className="rank">{`${i + 1})`}</span>
              <span>{r.id.slice(0, 8)}</span>
              <span className="meta">{formatMtime(r.mtime)}</span>
              <span className="meta">{`${r.messages} 条消息`}</span>
              <span>{r.name ?? (r.firstUser !== "" ? r.firstUser : "暂无会话")}</span>
            </button>
          ))}
        </div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={onCancel}>取消 (Esc)</button>
        </div>
      </div>
    </div>
  );
}
