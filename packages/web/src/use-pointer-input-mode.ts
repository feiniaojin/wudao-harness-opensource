// use-pointer-input-mode — ω99-312 (#456 second reopen, 0.3.87): the app
// tracks its own input context so the focus ring follows the USER's actual
// modality, not WebKit's guess. The what-input idiom: a pointerdown stamps
// html.input-pointer, a real keydown clears it, and the stylesheet gates the
// ring OFF while the stamp holds (styles.css `html.input-pointer
// :focus-visible`). Why this exists: #456 survived TWO renderer-side fixes —
// 0.3.83's `:focus:not(:focus-visible) {outline:none}` and 0.3.86's ω99-306
// deferred refocus — because WKWebView classifies a script .focus() as
// keyboard-VISIBLE whenever the recent input context is a pointer, no matter
// how many tasks later it fires; the heuristic does not expire the way a
// gesture task does. The only renderer-proof seam is to stop asking the
// engine ":focus-visible?" and track the context ourselves. Tab clears the
// stamp BEFORE focus moves, so the keyboard ring (ω99-297 contract) returns
// the moment the user actually touches the keyboard — the suppression is
// scoped to genuine pointer-only stretches of interaction.
import { useEffect } from "react";

/** The class the stylesheet's ring gate keys on. */
export const POINTER_INPUT_CLASS = "input-pointer";

/** Track the input context on <html>: stamped while the user is riding the
 *  pointer, cleared the instant any keydown lands (a mouse click never fires
 *  keydown; an IME composition does, which is keyboard use — correct to
 *  clear). Mounted once by App; jsdom-safe (classList is universal). */
export function usePointerInputMode(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(POINTER_INPUT_CLASS); // never inherit a stale stamp
    const onPointerDown = (): void => {
      root.classList.add(POINTER_INPUT_CLASS);
    };
    const onKeyDown = (): void => {
      root.classList.remove(POINTER_INPUT_CLASS);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      root.classList.remove(POINTER_INPUT_CLASS);
    };
  }, []);
}
