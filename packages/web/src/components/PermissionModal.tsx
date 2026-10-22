// PermissionModal — the y/a/N ask, the web mirror of the TUI's
// PermissionPrompt (cli/src/tui/permission.tsx): y = allow once, a = allow
// for this session, n = deny with an optional typed reason that flows back
// to the model. A settingsFile ask (a runtime-policy write) degrades to
// plain y/N — no session whitelisting; the git-risk warning and the M45
// sidecar reason render above the menu. Keyboard: y/a/n or the buttons;
// Esc denies without a reason. Single-shot per parked ask.
// ui-review-r2 I3: Enter maps to DENY (the safe action), the dialog itself
// owns focus on open (no button autofocus — a reflex Enter/Space must never
// land on the allow button), and Space cannot natively click anything while
// the container is the focused element.
//
// settings-trial r7: the ask renders as an INLINE conversation card (the
// AgentRootCard slot's sibling in the chatColumn, above the composer) — no
// scrim, no centered modal, the conversation stays visible and scrollable
// while the ask pends. Presentation-only: the shell swap changed no answer
// semantics. The component keeps its name (the ask's identity across App,
// the tests, and this file); it is a dialog by role, not by chrome.
//
// 0.3.14 #1: answerPermission now carries a scope — `a` (session) and `p`
// (always, persisted into the project tier's allow list through the
// /permissions lane) record REAL rules server-side; the v1 gap (an `a` that
// answered allow-once while labeling itself "this session") is closed.
import { useEffect, useRef, useState } from "react";
import type { PendingPermission } from "../protocol.js";
import { useFocusReturn } from "../use-focus-return.js";
// ui-parity C: the mono command block reuses the simple approval card's one
// line of "what exactly will run" — one derivation, both shells.
import { approvalCommandText } from "./SimpleApprovalCard.js";
import { SpoofReveal } from "./SpoofReveal.js";
import { Icon } from "./Icon.js";

export type PermissionAnswer = { allow: boolean; reason?: string; scope?: "session" | "always" };

export function PermissionModal({ ask, onChoose }: {
  ask: PendingPermission;
  onChoose: (answer: PermissionAnswer) => void;
}): React.JSX.Element {
  const [reason, setReason] = useState<string | null>(null);
  const resolved = useRef(false);
  const reasonRef = useRef<HTMLInputElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // ui-parity C: the ask's command wall (collapsed, whitespace-flattened) —
  // the same one-line derivation the simple approval card renders.
  const command = approvalCommandText(ask.input);

  const choose = (answer: PermissionAnswer): void => {
    if (resolved.current) return;
    resolved.current = true;
    onChoose(answer);
  };

  // UI-5 INFO-2: the focus-return sweep — this card mounts INLINE in the
  // chat column (the composer stays alive), so the ask steals focus from
  // wherever the user was typing and must hand it BACK when it resolves.
  // Declared BEFORE the steal effect below (hooks fire in order — after it,
  // the capture would read the card itself).
  useFocusReturn();
  useEffect(() => {
    if (reason !== null) reasonRef.current?.focus();
    else modalRef.current?.focus();
  }, [reason]);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (reason !== null) return; // the reason input owns its keys
    if (e.key === "y" || e.key === "Y") {
      e.preventDefault();
      choose({ allow: true });
    } else if ((e.key === "a" || e.key === "A") && ask.settingsFile === undefined) {
      e.preventDefault();
      choose({ allow: true, scope: "session" });
    } else if ((e.key === "p" || e.key === "P") && ask.settingsFile === undefined) {
      e.preventDefault();
      choose({ allow: true, scope: "always" });
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      setReason("");
    } else if (e.key === "Escape" || e.key === "Enter") {
      // I3: both reflex keys resolve DENY — the highest-stakes dialog must
      // fail closed on an accidental keypress (a bare Enter must never grant
      // a tool).
      e.preventDefault();
      choose({ allow: false });
    }
  };

  return (
    <div
      className="permission-card"
      role="dialog"
      aria-label="permission ask"
      ref={modalRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/* ui-parity C: the mockup .approval tokens — the amber strip label,
          then a scroll region (.pc-scroll) carrying the headline + hints +
          the mono command wall, and the pill .btnrow OUTSIDE it so the
          answers stay reachable no matter how long the summary grows. The
          answer lane (y/a/n/Esc/Enter=deny, the focus contract) is the
          shell swap's frozen semantics — this is presentation only. */}
      <div className="strip">
        {/* 116 弧 C：⏳/🔑 emoji 退役 → Icon 细线字形（warn 色随 .strip/.warn 继承）。 */}
        <Icon name="hourglass" size={13} /> 等待你的批准
      </div>
      {reason === null ? (
        <>
          <div className="pc-scroll">
            {ask.warning !== undefined ? <div className="warn">{ask.warning}</div> : null}
            {ask.sidecar !== undefined ? (
              <div className="warn">
                <Icon name="key" size={12} /> {`(sidecar: ${ask.sidecar})`}
              </div>
            ) : null}
            <h3>
              {ask.settingsFile !== undefined ? (
                <>
                  {/* ω99-154: 标题中文化——策略文件变体的问句说中文，全角冒号/问号与 152 键道说明行基调一致 */}
                  <Icon name="key" size={14} /> 允许 {ask.toolName}：<span className="warn">策略文件 {ask.settingsFile}</span>
                  {ask.summary && ask.summary !== ask.settingsFile ? ` (${ask.summary})` : ""}？
                </>
              ) : (
                // ω99-154: 标题中文化——常规变体同款
                <><Icon name="key" size={14} /> 允许 {ask.toolName}{ask.summary ? `：${ask.summary}` : ""}？</>
              )}
            </h3>
            <div className="muted">
              {ask.settingsFile !== undefined
                ? "y 仅本次 · n 拒绝（可填理由） · 策略文件无会话/持久选项"
                : "y 仅本次 · a 本会话 · p 总是（写入 .wudao/settings.json） · n 拒绝（可填理由）"}
            </div>
            {command !== "" ? <code className="cmd">{command}</code> : null}
            {/* ω99-318: the visual-spoof reveal — the SAME shared component
                the simple card renders (ui-parity C), after the command wall
                inside .pc-scroll. Null on clean asks (DOM unchanged). */}
            <SpoofReveal spoof={ask.spoof} />
          </div>
          <div className="btnrow">
            <button type="button" className="wudao primary" onClick={() => choose({ allow: true })}>
              {/* ω99-154: 键钮中文化——与上方中文键道说明行同一套词（y 仅本次），字母前缀保留为 keydown 可见助记 */}
              y — 仅本次
            </button>
            {ask.settingsFile === undefined ? (
              <>
                <button type="button" className="wudao" onClick={() => choose({ allow: true, scope: "session" })}>
                  {/* ω99-154: 键钮中文化（a 本会话，与说明行用词一致） */}
                  a — 本会话
                </button>
                <button type="button" className="wudao" onClick={() => choose({ allow: true, scope: "always" })}>
                  {/* ω99-154: 键钮中文化（p 总是，与说明行用词一致） */}
                  p — 总是
                </button>
              </>
            ) : null}
            <button type="button" className="wudao danger" onClick={() => setReason("")}>
              {/* ω99-154: 键钮中文化（n 拒绝…，省略号保留） */}
              n — 拒绝…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="pc-scroll">
            {/* ω99-154: 理由视图标题中文化 */}
            <h3><Icon name="key" size={14} /> {`拒绝 ${ask.toolName} — 理由（可选）`}</h3>
          </div>
          <input
            ref={reasonRef}
            className="wudao-input"
            style={{ width: "100%" }}
            value={reason}
            /* ω99-152: 理由去哪了说清楚——用户知道写了会被模型看到 */
            placeholder="理由（会回传给模型）"
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const trimmed = reason.trim();
                choose(trimmed === "" ? { allow: false } : { allow: false, reason: trimmed });
              } else if (e.key === "Escape") {
                e.preventDefault();
                choose({ allow: false });
              }
            }}
          />
          <div className="btnrow">
            <button type="button" className="wudao danger" onClick={() => {
              const trimmed = reason.trim();
              choose(trimmed === "" ? { allow: false } : { allow: false, reason: trimmed });
            }}>
              {/* ω99-154: 确认钮中文化（拒绝 ⏎，⏎ 键注记保留）；116 弧 C：
                  ⏎ emoji 位换 corner-down-left 细线键帽形（键道说明行同律）。 */}
              拒绝 <Icon name="corner-down-left" size={11} />
            </button>
            <button type="button" className="wudao" onClick={() => choose({ allow: false })}>
              {/* ω99-152: 中文动作 + (Esc) 注记，与「保留 (Esc)」同款 */}
              不带理由拒绝 (Esc)
            </button>
          </div>
        </>
      )}
    </div>
  );
}
