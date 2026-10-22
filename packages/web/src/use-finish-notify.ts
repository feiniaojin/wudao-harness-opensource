// M76-ux2 §4 — the agent-finish notification（自 App.tsx 外提，多 driver 弧
// C 的行数抵扣：行为逐字节等价）。A busy→idle transition while the window is
// HIDDEN (the user switched away mid-run) tells them the run landed: the
// Tauri notification when the desktop shell injected the global, else a
// document.title flash (3 alternations @300ms, then the session title
// restored). The ARM is a ref, so the notification fires ONCE per busy→idle
// transition — an idle→idle frame, a reconnect's initial state, and a visible
// window never notify; a new busy re-arms.
// 多 driver 弧 C：本钩子只盯 MAIN 车道的 busy→idle（副车道 v1 无 live 收尾
// 面——lanes 快照只有 busy 位，无 finish 事件语义；车道收尾通知留给后续弧）。
import { useCallback, useEffect, useRef } from "react";
import { FINISH_TITLE, tauriNotifyFinish, windowUnfocused } from "./components/app-panels.js";

export function useFinishNotify(busy: boolean, sessionId: string | null): void {
  const finishArmedRef = useRef(false);
  const flashTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashTitle = useCallback((): void => {
    const normal = document.title; // the session title the flash must restore
    let toggles = 0;
    flashTimer.current = setInterval(() => {
      toggles += 1;
      document.title = toggles % 2 === 1 ? FINISH_TITLE : normal;
      if (toggles >= 6) {
        // 3 alternations done — settle on the session title.
        if (flashTimer.current !== null) clearInterval(flashTimer.current);
        flashTimer.current = null;
        document.title = normal;
      }
    }, 300);
  }, []);
  useEffect(() => {
    if (busy) {
      finishArmedRef.current = true;
      return;
    }
    if (!finishArmedRef.current) return;
    finishArmedRef.current = false;
    // ui-review-r3 P5: the notify condition widens past document.hidden — a
    // VISIBLE-but-unfocused window merits the same ping (the user is in
    // another app, watching this tab finish from beside it).
    if (document.hidden || (document.visibilityState === "visible" && windowUnfocused())) {
      // A2: tauriNotifyFinish settles async — only a resolved FALSE flashes
      // (no bridge, or a rejected plugin call).
      void tauriNotifyFinish().then((ok) => {
        if (!ok) flashTitle();
      });
    }
    return () => {
      // A NEW transition (or unmount) cancels a flash in flight and puts
      // the session title back — the tab never strands on the ✅ title.
      if (flashTimer.current !== null) {
        clearInterval(flashTimer.current);
        flashTimer.current = null;
        document.title = "悟道Harness";
      }
    };
  }, [busy, flashTitle, sessionId]);
}
