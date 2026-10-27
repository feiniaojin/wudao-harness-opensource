// AskUserCards — the ask_user option cards, the web mirror of the TUI's
// AskUserPrompt (cli/src/tui/ask-user.tsx): a numbered card list (click or
// 1..N picks the label), a free-text answer line when the question has no
// options, and a dismiss that resolves as "the agent decides itself".
// ui-review-r2 I5: the dismiss affordances are REAL — Escape (at the modal
// level, so it works from the cards AND the free-text input, which bubbles)
// and a scrim click both dismiss.
//
// 借鉴弧 α1（Codex rust-v0.154.0 中途内联问答）: the v1.1 seam landed —
// `wudao ui` wires ask_user through the ask lane (driver/ask-user-park.ts),
// the state frame carries `pendingAskUser`, and the card renders INLINE in
// the chat column (the `inline` prop — the settings-trial r7 permission-card
// precedent: no scrim, conversation stays visible, composer stays alive).
import { useEffect, useRef, useState } from "react";
import { useFocusReturn } from "../use-focus-return.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";
import { Icon } from "./Icon.js";

export interface AskUserOption {
  readonly label: string;
  readonly description?: string;
}

export function AskUserCards({ question, options, onAnswer, onDismiss, inline = false }: {
  question: string;
  options?: readonly AskUserOption[];
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
  /** 借鉴弧 α1 — render as an inline chat-column card (.ask-card, the
   *  permission card's slot sibling: no scrim, conversation visible, composer
   * alive) instead of the scrim modal. Default stays the modal family. */
  inline?: boolean;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const hasOptions = options !== undefined && options.length > 0;
  // UI-5 INFO-2: the free-text input's focus steal moved OFF the autoFocus
  // attribute into an effect declared AFTER useFocusReturn — autoFocus runs
  // during the DOM commit (before any effect), so the hook would have
  // captured the input itself and the return would be a dead focus() on a
  // detached node. The effect order restores the FileSearch idiom: capture
  // the trigger, then steal, then hand back on unmount. In the options mode
  // nothing steals, and the cleanup still pulls focus off the clicked card
  // back to the trigger instead of dropping to <body>.
  useFocusReturn();
  const inputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // ω99-309: 自由文本输入的组合态。Enter 守卫在输入级（target 相先于卡跑）；
  // Esc 的家在卡级，所以卡再挂一份 composition 冒泡监听——输入里取消候选
  // 的 Esc 冒上来不得解散整卡（=丢掉打到一半的回答稿）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  useEffect(() => {
    // ω99-305: the family focus-pull. Free-text steals into the input (the
    // UI-5 INFO-2 order above); the OPTIONS mode previously stole nothing —
    // focus stayed on the trigger under the scrim, so the card's Esc and the
    // 1-9 hotkeys (both element-level, on nodes inside the card) never fired.
    // The card takes focus as the fallback — the .modal-card family's own
    // idiom (ref + tabIndex -1 + focus on open).
    if (hasOptions) cardRef.current?.focus();
    else inputRef.current?.focus();
  }, []);
  const card = (
      <div
        className={inline ? "ask-card" : "modal-card pop-in"}
        role="dialog"
        aria-label="agent question"
        ref={cardRef}
        tabIndex={-1}
        onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
        onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
        onKeyDown={(e) => {
          /* ω99-309: 组合期 IME 拥有键盘——Esc 是取消候选词，不是解散。 */
          if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
          if (e.key !== "Escape") return;
          e.preventDefault();
          onDismiss();
        }}
      >
        <h3><Icon name="circle-help" size={14} /> {question}</h3>
        {hasOptions ? (
          <div
            className="optioncards"
            onKeyDown={(e) => {
              if (!/^[1-9]$/.test(e.key)) return;
              const n = Number(e.key);
              const opt = options?.[n - 1];
              if (opt !== undefined) {
                e.preventDefault();
                onAnswer(opt.label);
              }
            }}
          >
            {options?.map((opt, i) => (
              <button
                key={i}
                type="button"
                className="optioncard"
                onClick={() => onAnswer(opt.label)}
              >
                {`${i + 1}) ${opt.label}`}
                {opt.description !== undefined && opt.description !== "" ? (
                  <span className="desc">{` — ${opt.description}`}</span>
                ) : null}
              </button>
            ))}
            <div className="muted">{`(按 1-${options?.length} 选择 · Esc 取消并让 agent 自行决定)`}</div>
          </div>
        ) : (
          <>
            <input
              ref={inputRef}
              className="wudao-input"
              style={{ width: "100%" }}
              value={text}
              placeholder="输入回答…"
              onChange={(e) => setText(e.target.value)}
              onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
              onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
              onKeyDown={(e) => {
                /* ω99-309: 组合期 Enter 是确认候选词，不是提交回答。 */
                if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  onAnswer(text.trim());
                }
              }}
            />
            <div className="muted">(Enter 发送 · Esc 取消并让 agent 自行决定)</div>
          </>
        )}
        <div className="btnrow">
          <button type="button" className="wudao" onClick={onDismiss}>
            Esc — 让 agent 自行决定
          </button>
        </div>
      </div>
  );
  // 借鉴弧 α1: the inline shape returns the card bare (its own .ask-card
  // chrome, chat-column placement); the modal family keeps the scrim.
  if (inline) return card;
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) onDismiss(); // the scrim, not the modal
      }}
    >
      {card}
    </div>
  );
}
