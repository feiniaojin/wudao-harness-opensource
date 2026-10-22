// SimpleApprovalCard — M63 §D (research 35 #1): the permission ask does NOT
// open a modal in 简洁模式; it takes over the input area with an amber strip.
// M64-visual §2 restyles it onto the token classes: a warn-tinted card
// (`.approval`) with the amber `.strip`, the model's own justification as
// the one-line `.why` (the ask's summary is the headline), the exact command
// in the mono `.cmd` block — the card's ONLY scroll region — and 拒绝 /
// 允许一次 right-aligned in `.btns` OUTSIDE that region, so they stay
// reachable no matter how long the command grows. Two buttons only: a
// novice never needs a session-allowlist concept. Single-flight is the
// PARENT's job: the card renders `busy` (the answer op in flight) and
// re-arms on a rejected op (review LOW — a dropped answer must stay
// answerable, not lock silently).
//
// UI-3 C2: the alertdialog's focus/keyboard contract, aligned with the
// advanced PermissionModal (ui-review-r2 I3): the card OWNS focus on open
// (the composer it replaces unmounts — without this, focus falls to <body>
// and a novice must blind-Tab through the topbar), and the keys follow the
// fail-closed rule: Esc AND Enter deny (a reflex keypress must never grant
// a tool). y = 允许一次, n = 拒绝 — the novice card has no session concept,
// so `a` is deliberately NOT mapped (a shortcut that lies about its
// semantics is worse than a missing one). No button is autofocused.
import { useEffect, useRef } from "react";
import type { PendingPermission } from "../protocol.js";
import type { PermissionAnswer } from "./PermissionModal.js";
import { SpoofReveal } from "./SpoofReveal.js";
import { Icon } from "./Icon.js";

/** The one line of "what exactly will run" — the command when there is one,
 *  else the url / path, else the compact JSON of the whole input. Rendered
 *  as TEXT inside <code> (React escapes it — nothing from the model ever
 *  becomes markup), whitespace-collapsed and capped. */
export function approvalCommandText(input: Record<string, unknown>): string {
  for (const key of ["command", "url", "path", "pattern", "query"] as const) {
    const v = input[key];
    if (typeof v === "string" && v.trim() !== "") return collapse(v);
  }
  try {
    return collapse(JSON.stringify(input) ?? "");
  } catch {
    return "";
  }
}

function collapse(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

export function SimpleApprovalCard({ ask, busy = false, onChoose }: {
  ask: PendingPermission;
  /** The answer op is in flight — both buttons stand down; a rejection
   *  clears it and the card is answerable again. */
  busy?: boolean;
  onChoose: (answer: PermissionAnswer) => void;
}): React.JSX.Element {
  const choose = (answer: PermissionAnswer): void => {
    if (busy) return;
    onChoose(answer);
  };
  const cardRef = useRef<HTMLDivElement>(null);
  // C2: focus lands ON the card the moment the takeover mounts — the
  // composer is gone, so nothing else would hold it.
  // UI-5 INFO-2 — the RELEASE contract, pinned here deliberately (no
  // useFocusReturn): this card swaps the composer in SimpleMode's ternary,
  // so at takeover React deletes the composer's DOM (the focused textarea
  // leaves the document and activeElement falls to <body>) BEFORE any
  // effect could capture it — a useFocusReturn here would record <body> and
  // its cleanup would be a dead focus() on a non-focusable node. The REAL
  // mechanism on release: the composer REMOUNTS and InputBox's mount effect
  // (InputBox.tsx — `ref.current?.focus()` on mount) hands focus to the new
  // textarea. That is a contract, not a coincidence: the pinned test
  // (ui5-focus-return suite) asserts focus lands on the composer after the
  // ask clears — changing either the ternary swap or InputBox's mount focus
  // breaks it and forces this comment to be revisited.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (busy) return; // the answer op owns the wire; keys stand down with the buttons
    if (e.key === "y" || e.key === "Y") {
      e.preventDefault();
      choose({ allow: true });
    } else if (e.key === "n" || e.key === "N") {
      e.preventDefault();
      choose({ allow: false });
    } else if (e.key === "Escape" || e.key === "Enter") {
      // The PermissionModal I3 rule: both reflex keys resolve DENY — the
      // highest-stakes card must fail closed on an accidental keypress.
      e.preventDefault();
      choose({ allow: false });
    }
  };
  const command = approvalCommandText(ask.input);
  return (
    <div
      className="approval"
      role="alertdialog"
      aria-label="权限请求"
      ref={cardRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {/* 116 弧 C：⏳ emoji → hourglass 细线字形（warn 色随 .strip 继承）。 */}
      <div className="strip"><Icon name="hourglass" size={13} /> {`等待你的批准 —— 模型请求使用 ${ask.toolName}`}</div>
      {/* The scroll region: everything the ask can pad with (justification,
          warning lines, command wall) lives inside .ap-scroll so a long ask
          scrolls here instead of pushing the card past the viewport cap
          (styles.css .approval) — the same contract .permission-card's
          .pc-scroll carries in the advanced shell. */}
      <div className="ap-scroll">
        {/* The headline IS the model's justification for this call. */}
        <div className="why">{ask.summary !== "" ? ask.summary : `请求执行 ${ask.toolName}`}</div>
        {ask.warning !== undefined ? <div className="warn">{ask.warning}</div> : null}
        {ask.sidecar !== undefined ? <div className="sidecar">{`风险提示:${ask.sidecar}`}</div> : null}
        {ask.settingsFile !== undefined ? (
          <div className="sidecar">{`涉及运行时策略文件:${ask.settingsFile}`}</div>
        ) : null}
        {command !== "" ? <code className="cmd">{command}</code> : null}
        {/* ω99-318: the visual-spoof reveal — after the command wall, inside
            the scroll region; null on clean asks (DOM unchanged). */}
        <SpoofReveal spoof={ask.spoof} />
      </div>
      {/* The buttons are OUTSIDE .cmd (the scroll region) — reachable even
          with a wall of command text above. */}
      <div className="btns">
        <button type="button" className="deny" disabled={busy} onClick={() => choose({ allow: false })}>
          {busy ? "发送中…" : "拒绝"}
        </button>
        <button type="button" className="allow" disabled={busy} onClick={() => choose({ allow: true })}>
          {busy ? "发送中…" : "允许一次"}
        </button>
      </div>
    </div>
  );
}
