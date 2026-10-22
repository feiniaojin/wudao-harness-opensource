// ShieldSelector — M63 §B's permission tier picker (research 35 #4, DSH
// PermissionSelect/RiskConfirmation), collapsed by M64-visual §2 into a
// 26px chip that opens a popup menu. The four tiers map onto the harness's
// runtime modes (0.3.14, 对齐 the upstream harness 词汇):
//
//   ask      每次询问   → mode "ask"        (每个工具执行前都确认 — safest)
//   accept   接受编辑   → mode "workspace"  (工作区内读写与只读命令类放行,
//                                           其余操作仍确认 — THE DEFAULT 档;
//                                           ≈ the upstream formatacceptEdits)
//   auto     全自动     → mode "auto"       (RISKY tier — confirm-gated;
//                                           ≈ the upstream formatbypassPermissions)
//   plan     只读探查   → mode "plan"       (READ-only exploration — reads
//                                           and safe read-only commands pass,
//                                           everything else denied with a
//                                           "finish the plan" reason; ≈ the upstream format//                                           plan mode)
//
// 0.3.13 (user trial feedback): the labels are the the upstream format-style English words
// (ask/accept/auto/plan) — NO emoji, no shield stack; the mode VALUES stay
// workspace/ask/auto/plan (persistence + the wire protocol are unchanged;
// only the display word for workspace is "accept").
//
// Menu order follows the cycle (ask → accept → auto → plan): the two
// interactive tiers first, then the gated risky tier, then the read-only
//探查 tail — plan reads as a "mode of work", not a safety level.
//
// The risky tier keeps its two-step gate in menu form: the first click arms
// an inline confirm state (the specific risk wording), the second commits;
// Esc or an outside click closes without change, and reopening starts
// un-armed. Re-selecting the tier the session is ALREADY in commits without
// the gate (dropping to a safer tier re-locks it).
import { useEffect, useRef, useState } from "react";

export type ShieldMode = "ask" | "workspace" | "auto" | "plan";

export interface ShieldTier {
  readonly mode: ShieldMode;
  readonly label: string;
  readonly hint: string;
  readonly risky: boolean;
}

/** The tier table (exported for tests + the hosts that mount the chip).
 *  0.3.13: the upstream formatvocabulary — the label IS the English word; the hints stay
 *  one-line Chinese, with accept named the default and its sensitive
 *  classes (命令/网络/MCP) still asking. 0.3.14: plan joins as the
 *  read-only 探查 tail. */
export const SHIELD_TIERS: readonly ShieldTier[] = [
  { mode: "ask", label: "ask", hint: "每次询问:每个工具执行前都会确认,最安全", risky: false },
  { mode: "workspace", label: "accept", hint: "默认·接受编辑:工作区内读写与只读命令(git status 等)放行;其余命令、网络、MCP 仍确认", risky: false },
  { mode: "auto", label: "auto", hint: "全自动:全部放行,不再询问", risky: true },
  { mode: "plan", label: "plan", hint: "只读探查:只允许读取与只读命令(git status 等);写文件/其余命令一律拒绝,完成方案后切回 accept/auto 执行", risky: false },
];

export const RISK_CONFIRM_TEXT = "我了解风险:完全访问会不经确认执行写入和命令";

/** The runtime mode → the selector's value (0.3.12: the mode set IS the
 *  tier set; anything unknown highlights the default workspace tier). */
export function shieldValueOf(mode: string): ShieldMode {
  return mode === "auto" ? "auto" : mode === "ask" ? "ask" : mode === "plan" ? "plan" : "workspace";
}

export function ShieldSelector({
  value,
  onChange,
  disabled = false,
  /** Menu direction. "up" (default): bottom-anchored, opens ABOVE the chip —
   *  the composer's posture (the chip sits at the viewport bottom, a downward
   *  menu runs off-screen — 用户反馈 2026-09-01: accept/ask 列表向下弹展示不全,
   *  应同模型/强度/语言 chip 向上). "down": opens below — for chips in
   *  mid-viewport surfaces (settings page / wizard), where upward is wrong. */
  direction = "up",
}: {
  value: ShieldMode;
  onChange: (mode: ShieldMode) => void;
  disabled?: boolean;
  direction?: "up" | "down";
}): React.JSX.Element {
  // M64-visual §2: the chip + controlled popup menu replace the permanent
  // tier row. `confirming` is the risky tier's armed state — menu-scoped,
  // reset by close, so a dismissed menu never leaves a stale arm behind.
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);

  /** Closes the menu; on Esc/commit the focused `.mi` unmounts, so focus
   *  returns to the chip instead of falling to <body> (review MEDIUM). An
   *  outside pointerdown passes `refocus: false` — the browser is already
   *  moving focus to whatever was clicked; yanking it back would steal it. */
  const close = (refocus = true): void => {
    setOpen(false);
    setConfirming(false);
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

  // value is a ShieldMode — always one of the three rows above.
  const current = SHIELD_TIERS.find((t) => t.mode === value) ?? SHIELD_TIERS[0]!;
  return (
    <div
      className={direction === "down" ? "pop down" : "pop"}
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
        className={`chip${value !== "workspace" ? " sel" : ""}`}
        data-mode={value}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="权限档(四档可选)"
        onClick={() => {
          setConfirming(false); // every open starts un-armed
          setOpen(!open);
        }}
      >
        {current.label}
        <span className="caret" aria-hidden={true}>▾</span>
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="权限档">
          {SHIELD_TIERS.map((tier) => {
            const selected = value === tier.mode;
            // Entering the risky tier needs the explicit confirm; staying in
            // it (a re-click of the current tier) does not.
            const gate = tier.risky && !selected;
            const armed = gate && confirming;
            return (
              <button
                key={tier.mode}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`mi${selected ? " on" : ""}`}
                data-mode={tier.mode}
                title={tier.hint}
                onClick={() => {
                  if (gate && !confirming) {
                    setConfirming(true); // first click: the inline confirm
                    return;
                  }
                  onChange(tier.mode);
                  close();
                }}
              >
                {armed ? (
                  <span className="confirm">{RISK_CONFIRM_TEXT}</span>
                ) : (
                  <span className="mlabel">{tier.label}</span>
                )}
                {tier.risky ? <span className="warned">{armed ? "再点一次确认" : "需确认"}</span> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
