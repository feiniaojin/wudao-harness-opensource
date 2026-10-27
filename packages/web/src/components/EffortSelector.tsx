// EffortSelector — the composer's 推理强度 chip (spec 2026-08-28 §2.3).
// The ShieldSelector dropdown mechanics verbatim, minus the risk-confirm
// gate (an effort level carries no risk semantics): .pop + .menu + .mi/.on,
// outside pointerdown closes (refocus:false — the browser is already moving
// focus), Esc closes and refocuses the chip (the focused .mi unmounts),
// every reopen starts fresh. The rows come from the settings snapshot's
// `efforts` (provider capability list); a pick rides the caller's /effort
// submission — session-scoped, takes effect next turn.
import { useEffect, useRef, useState } from "react";
import { IconBolt } from "./icons.js";

export function EffortSelector({
  efforts,
  current,
  disabled = false,
  onPick,
  providerLabel,
  onPersistDefault,
}: {
  readonly efforts: readonly string[];
  readonly current: string | null;
  readonly disabled?: boolean;
  readonly onPick: (level: string) => void;
  /** S5: the 设为 {provider} 默认 footer — persists the SESSION's current
   *  effort as this provider's registry binding (the caller owns the
   *  settingsSaveProvider FULL-echo write; absent = no footer). */
  readonly providerLabel?: string;
  readonly onPersistDefault?: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  /** Closes the menu; on Esc the focused `.mi` unmounts, so focus returns
   *  to the chip instead of falling to <body>. An outside pointerdown
   *  passes `refocus: false` — yanking focus back would steal it from
   *  whatever the user clicked. */
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
        className={`chip${current !== null ? " sel" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="推理强度(会话内,下一轮生效)"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <IconBolt size={14} />
        {current ?? "强度"}
        <span className="caret" aria-hidden={true}>▾</span>
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="推理强度">
          {efforts.map((level) => {
            const selected = level === current;
            return (
              <button
                key={level}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`mi${selected ? " on" : ""}`}
                data-effort={level}
                onClick={() => {
                  onPick(level);
                  close();
                }}
              >
                <span className="mlabel">{level}</span>
              </button>
            );
          })}
          {onPersistDefault !== undefined && providerLabel !== undefined ? (
            <button
              type="button"
              className="mf"
              data-action="persist-effort-default"
              title="把当前强度存为该供应商的注册表绑定(覆盖跟随全局;模型不受影响)"
              onClick={() => {
                onPersistDefault();
                close();
              }}
            >
              {`设为 ${providerLabel} 默认`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
