// LanguageSelector — the 语言 chip (spec 2026-08-28 §5, the S5
// surface of the S3/S4 chains). EffortSelector's dropdown mechanics verbatim
// (.pop + .menu + .mi/.on, outside pointerdown closes refocus:false, Esc
// closes and refocuses), widened to the 双旋钮: TWO groups in one menu —
// 回答 (auto|on|off) and 思考 (auto|zh|en|off). A row click is a SESSION
// pick (the caller submits /language — next-turn effect, the S4 lane); each
// group's 设为默认 footer persists that knob's session-effective value to
// the global settings tier (settingsSet language.reply / language.reasoning —
// the S3 lane, a NEW session's boot fold). The chip label follows 回答
// (auto → the generic 语言); .sel marks ANY deviating knob.
// ω99-234: #4 — 复用宣言：the chip's home moved off the composer to the
// settings page's 偏好 tab (频率分层归位——低频偏好进设置页，composer 只留
// 高频旋钮)；the component body is reused VERBATIM (zero change) — in the
// settings mount both the rows and the footer write the caller's lane.
import { useEffect, useRef, useState } from "react";
import type { LanguageKnob } from "../protocol.js";
import { IconGlobe } from "./icons.js";

type ReplyMode = "auto" | "on" | "off";
type ReasoningMode = "auto" | "zh" | "en" | "off";

export interface LanguagePair {
  readonly reply: ReplyMode;
  readonly reasoning: ReasoningMode;
}

const REPLY_ROWS: readonly { readonly mode: ReplyMode; readonly label: string }[] = [
  { mode: "auto", label: "自动" },
  { mode: "on", label: "中文" },
  { mode: "off", label: "不限" },
];

const REASONING_ROWS: readonly { readonly mode: ReasoningMode; readonly label: string }[] = [
  { mode: "auto", label: "自动" },
  { mode: "zh", label: "中文" },
  { mode: "en", label: "EN" },
  { mode: "off", label: "不限" },
];

const replyLabel = (mode: ReplyMode): string => REPLY_ROWS.find((r) => r.mode === mode)?.label ?? "语言";

export function LanguageSelector({
  value,
  disabled = false,
  onPick,
  onPersistDefault,
}: {
  /** The session-effective pair (gateStatus.language — the S4 fold). */
  readonly value: LanguagePair | null;
  readonly disabled?: boolean;
  /** A row click: the SESSION pick (the caller submits the /language line). */
  readonly onPick: (knob: LanguageKnob, mode: string) => void;
  /** A group footer: persist that knob's CURRENT session value as the
   *  default (the caller owns the settingsSet write; absent = no footers). */
  readonly onPersistDefault?: (knob: LanguageKnob) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  const close = (refocus = true): void => {
    setOpen(false);
    // #456 reopen: focus() from INSIDE the click task reads as focus-visible
    // to WKWebView (its gesture-task heuristic) — the keyboard ring paints
    // outside the pill after every mouse pick, and the 0.3.83 :not() patch
    // can't reach this branch. Deferring one task past the gesture keeps
    // focus on the trigger without the ring — the same timing the modal
    // family's passive focus effects ride (the in-app discriminator). The
    // body guard keeps the late focus from stealing a target the user
    // already moved on to; Esc keeps its ring (keyboard feedback, correct).
    if (refocus) {
      setTimeout(() => {
        if (document.activeElement === document.body) chipRef.current?.focus();
      }, 0);
    }
  };

  // An outside pointerdown closes without committing.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event): void => {
      if (popRef.current !== null && !popRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const v = value ?? { reply: "auto" as const, reasoning: "auto" as const };
  const deviates = v.reply !== "auto" || v.reasoning !== "auto";

  return (
    <div
      className="pop"
      ref={popRef}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        type="button"
        ref={chipRef}
        className={`chip lang${deviates ? " sel" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`回答:${replyLabel(v.reply)} 思考:${REASONING_ROWS.find((r) => r.mode === v.reasoning)?.label ?? "自动"} — 会话内切换,下一轮生效`}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <IconGlobe size={14} />
        {v.reply === "auto" ? "语言" : replyLabel(v.reply)}
        <span className="caret" aria-hidden={true}>▾</span>
      </button>
      {open ? (
        <div className="menu lang-menu" role="menu" aria-label="语言">
          <div className="lang-head">{"回答"}</div>
          {REPLY_ROWS.map((r) => (
            <button
              key={r.mode}
              type="button"
              role="menuitemradio"
              aria-checked={r.mode === v.reply}
              className={`mi${r.mode === v.reply ? " on" : ""}`}
              data-knob="reply"
              data-mode={r.mode}
              onClick={() => {
                onPick("reply", r.mode);
                close();
              }}
            >
              <span className="mlabel">{r.label}</span>
            </button>
          ))}
          {onPersistDefault !== undefined ? (
            <button
              type="button"
              className="mf"
              data-persist="reply"
              title="把当前回答语言存为全局默认(新会话起步值)"
              onClick={() => {
                onPersistDefault("reply");
                close();
              }}
            >
              {"设为默认"}
            </button>
          ) : null}
          <div className="lang-head">{"思考"}</div>
          {REASONING_ROWS.map((r) => (
            <button
              key={r.mode}
              type="button"
              role="menuitemradio"
              aria-checked={r.mode === v.reasoning}
              className={`mi${r.mode === v.reasoning ? " on" : ""}`}
              data-knob="reasoning"
              data-mode={r.mode}
              onClick={() => {
                onPick("reasoning", r.mode);
                close();
              }}
            >
              <span className="mlabel">{r.label}</span>
            </button>
          ))}
          {onPersistDefault !== undefined ? (
            <button
              type="button"
              className="mf"
              data-persist="reasoning"
              title="把当前思考语言存为全局默认(新会话起步值)"
              onClick={() => {
                onPersistDefault("reasoning");
                close();
              }}
            >
              {"设为默认"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
