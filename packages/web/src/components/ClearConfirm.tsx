// ClearConfirm — the /clear y/N confirmation, the web mirror of the TUI's
// ClearConfirm (single-shot, y clears / n keeps). ui-review-r2 C1: the
// confirmed clear is no longer view-only — App's performClear routes it
// through the driver's /clear submit (fresh conversation) and only falls
// back to the local view wipe when the wire cannot take it. The saved
// session file always stays on disk for /resume.
// ui-review-r2 I3: Enter maps to KEEP (the safe action) and no button is
// autofocused — the dialog owns focus, so a reflex Enter/Space cannot
// destroy the conversation.
import { useEffect, useRef } from "react";
import { useFocusReturn } from "../use-focus-return.js";
import { Icon } from "./Icon.js";

export function ClearConfirm({ onChoose }: { onChoose: (yes: boolean) => void }): React.JSX.Element {
  const resolved = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  // UI-5 INFO-2: the focus-return sweep — whatever opened the confirm (the
  // typed /clear or the + lane) gets its focus back on resolution.
  useFocusReturn();
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const choose = (yes: boolean): void => {
    if (resolved.current) return;
    resolved.current = true;
    onChoose(yes);
  };
  return (
    <div className="scrim">
      <div
        className="modal-card pop-in"
        role="dialog"
        aria-label="清空历史"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "y" || e.key === "Y") {
            e.preventDefault();
            choose(true);
          } else if (e.key === "n" || e.key === "N" || e.key === "Enter" || e.key === "Escape") {
            e.preventDefault();
            choose(false);
          }
        }}
      >
        {/* 116 弧 C：🗑 → trash-2 细线字形（danger 语义色——需确认徽标位）。 */}
        <h3><Icon name="trash-2" size={14} className="ic-danger" /> 清空历史 —— 清空当前会话？</h3>
        <div className="muted">(y 清空当前会话并开始新对话 · n 保留 — 已保存的会话仍在磁盘,/resume 可恢复)</div>
        <div className="btnrow">
          <button type="button" className="wudao danger" onClick={() => choose(true)}>
            清空
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            保留 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}
