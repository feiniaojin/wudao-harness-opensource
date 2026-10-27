// use-focus-return — ui-review-r1 I1: overlays must hand focus BACK to the
// element that opened them. Every overlay (FileSearch, SessionPicker,
// ContextMenu) steals focus on open (its input/pop autofocus); before this,
// closing dropped focus to <body>, stranding keyboard users at the document
// root. The trigger is captured on MOUNT (before the overlay's own focus
// effect can move it); the optional chains keep a detached or unfocusable
// trigger a no-op — the drop degrades to the old behavior, never a crash.
import { useEffect } from "react";

export function useFocusReturn(): void {
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      prev?.focus?.();
    };
  }, []);
}
