// PlanReview — the plan board awaiting review (state.planBoard): the TUI
// answers `ok` (execute) or `改 <意见>` (revise) as plain inputs, which the
// driver routes while a board is parked. The web renders the same two
// affordances as buttons on the board card; the 改 box takes the revision
// note and submits `改 <note>`.
// UI-5 INFO-2: the revise input no longer rides autoFocus — the commit-time
// steal stranded focus on <body> after submit/Esc unmounted it (both shells
// render this card, so both shared the drop). The swap below is the
// FileSearch idiom at input granularity: the 改 button (the trigger) is
// refocused whenever the box closes, so the keyboard stays on the board.
import { useEffect, useRef, useState } from "react";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";
import { Icon } from "./Icon.js";

export function PlanReview({ plan, busy, onSubmit }: {
  plan: string;
  busy: boolean;
  onSubmit: (text: string) => void;
}): React.JSX.Element {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  const reviseBtnRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // ω99-309: 改意见输入的组合态——组合期 Enter 是确认候选（提交=把拼音半截
  // 当修改意见发给 agent），Esc 是取消候选（退出编辑=丢意见稿）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  const wasRevising = useRef(false);
  useEffect(() => {
    if (revising) {
      inputRef.current?.focus();
    } else if (wasRevising.current) {
      reviseBtnRef.current?.focus(); // the input just unmounted — hand the keys back to the 改 trigger
    }
    wasRevising.current = revising;
  }, [revising]);
  return (
    <div className="planboard">
      <div className="label"><Icon name="clipboard-list" size={13} /> plan — review before execution</div>
      <div className="body">{plan}</div>
      {revising ? (
        <div className="btnrow">
          <input
            ref={inputRef}
            className="wudao-input"
            style={{ flex: 1 }}
            value={note}
            placeholder="改 — what to change"
            onChange={(e) => setNote(e.target.value)}
            onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
            onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
            onKeyDown={(e) => {
              /* ω99-309: 组合期 IME 拥有键盘（ω99-151 同款守卫）。 */
              if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
              if (e.key === "Enter") {
                e.preventDefault();
                onSubmit(note.trim() === "" ? "改" : `改 ${note.trim()}`);
                setRevising(false);
                setNote("");
              } else if (e.key === "Escape") {
                e.preventDefault();
                setRevising(false);
              }
            }}
          />
          <button
            type="button"
            className="wudao"
            onClick={() => {
              onSubmit(note.trim() === "" ? "改" : `改 ${note.trim()}`);
              setRevising(false);
              setNote("");
            }}
          >
            revise ↵
          </button>
        </div>
      ) : (
        <div className="btnrow">
          <button type="button" className="wudao primary" disabled={busy} onClick={() => onSubmit("ok")}>
            ok — execute
          </button>
          {/* UI-5 INFO-2: this button is the revise input's TRIGGER — the
              effect above refocuses it when the input closes. */}
          <button type="button" className="wudao" disabled={busy} ref={reviseBtnRef} onClick={() => setRevising(true)}>
            改 — revise
          </button>
        </div>
      )}
    </div>
  );
}
