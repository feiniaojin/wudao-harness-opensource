// use-jump-bottom — ui-review-r5 I3: the ONE scroll-to-bottom seam, shared by
// every chat shell (the advanced IDE column, its Buddy twin, and 简洁模式).
// M75-ux3 §9 pinned the contract: the column tail-follows only while the user
// rides the bottom; scrolling STRICTLY more than 200px up floats the 36px
// accent ↓ circle; clicking smooth-scrolls home (reduced-motion users get an
// instant jump — ui-review-r2 I6) and hides the button the moment it is used,
// not on scroll settle. Extracted from App so the simple shell rides the same
// rule instead of tail-following alone.
//
// 0.3.4 反馈（会话上下晃）: tail-follow USED to live in the shells as a
// render-time `atBottom` read — but render runs AFTER the DOM grew and
// BEFORE the follow scroll, so a fast streaming tick measures distance > 80,
// flips follow off, and the next tick flips it back on: the column wobbles.
// The stick now lives here as a REF updated ONLY by onScroll (real scroll
// events — the user's own scrolling, and the follow scroll itself landing at
// distance 0); content growth fires no scroll event, so a stuck column stays
// stuck across ticks, and the hook's own every-render effect keeps it glued
// to the bottom. Scrolling ≥ FOLLOW_BOTTOM_PX up disengages; riding back
// within the threshold re-engages (the ↓ click re-engages too — its scroll
// event lands at the bottom).
import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

/** The float threshold (px from the bottom) — strictly greater floats. */
export const JUMP_BOTTOM_PX = 200;

/** The tail-follow threshold (px from the bottom) — strictly less sticks.
 *  Deliberately tighter than JUMP_BOTTOM_PX: the ↓ circle may float while
 *  follow is still engaged, but never the reverse. */
export const FOLLOW_BOTTOM_PX = 80;

/** ui-review-r2 I6: the user's reduced-motion preference. jsdom (and old
 *  embedded webviews) ship no matchMedia — the try/catch keeps the helper
 *  false there, so the smooth scroll stands (the deterministic tests' seam)
 *  and nothing crashes. The stylesheet has the matching ONE media block.
 *  (Lives here since r5 — the seam's one programmatic smooth scroll and its
 *  helper moved together; App re-exports for import stability.) */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** The shared jump state machine over one chat column's ref. `onScroll` rides
 *  the column's onScroll (state, not a render-time read — the button must
 *  react to the user's scrolling alone); `jump` is the click handler; `show`
 *  gates the button. The follow effect is the hook's own (no deps — every
 *  render of the consumer), so a stuck column scrolls to the bottom each time
 *  content grows; the shells no longer carry their own tail-follow. */
export function useJumpBottom(chatRef: RefObject<HTMLDivElement | null>): {
  readonly onScroll: () => void;
  readonly jump: () => void;
  readonly show: boolean;
} {
  const [show, setShow] = useState(false);
  const stickRef = useRef(true); // at the bottom until the user says otherwise
  const onScroll = useCallback((): void => {
    const chat = chatRef.current;
    if (chat === null) return;
    const distance = chat.scrollHeight - chat.scrollTop - chat.clientHeight;
    stickRef.current = distance < FOLLOW_BOTTOM_PX;
    setShow(distance > JUMP_BOTTOM_PX);
  }, [chatRef]);
  useEffect(() => {
    const chat = chatRef.current;
    if (stickRef.current && chat !== null && typeof chat.scrollTo === "function") {
      chat.scrollTo({ top: chat.scrollHeight });
    }
  });
  const jump = useCallback((): void => {
    const chat = chatRef.current;
    if (chat === null) return;
    if (typeof chat.scrollTo === "function") {
      chat.scrollTo({ top: chat.scrollHeight, behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }
    setShow(false); // hidden the moment it is used, not on scroll settle
  }, [chatRef]);
  return { onScroll, jump, show };
}

/** The floating ↓ circle itself — one definition, three shells. The look is
 *  M75-ux3 §9's (styles.css: the 36px accent circle anchored to the shell). */
export function JumpBottomButton({ show, onJump }: {
  readonly show: boolean;
  readonly onJump: () => void;
}): React.JSX.Element | null {
  if (!show) return null;
  return (
    <button type="button" className="jump-bottom" aria-label="回到底部" title="回到底部" onClick={onJump}>
      ↓
    </button>
  );
}
