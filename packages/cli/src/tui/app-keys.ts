// 拆分运动 C：从 app.tsx 原样外提的应用级按键处理器（useInput 的函数体——
// 模式循环、忙时中断/退出、双 Esc /rewind 窗口）。显式依赖对象。
import { bindingMatches, DOUBLE_ESC_WINDOW_MS } from "./keybindings.js";
import type { InkKeyLike, ResolvedKeybindings } from "./keybindings.js";
import { cycleMode, modeLabel } from "../permission.js";
import type { AgentRegistry } from "../agents/index.js";
import type { UseAgentResult } from "./use-agent.js";
import type { PendingAsk, PendingAskUser } from "./app-panels.js";

/** The key handler's explicit dependency slice. */
export interface KeyDeps {
  readonly api: UseAgentResult;
  readonly apiRef: { readonly current: UseAgentResult | null };
  readonly ask: PendingAsk | null;
  readonly askUserPending: PendingAskUser | null;
  readonly clearPending: boolean;
  readonly findQuery: string | null;
  readonly keybindings: ResolvedKeybindings;
  readonly agentsRegistry: AgentRegistry;
  readonly exit: () => void;
  readonly menuOpenRef: { current: boolean };
  readonly escPressedAtRef: { current: number };
  readonly escResetTimerRef: { current: ReturnType<typeof setTimeout> | null };
}

export function handleAppKey(K: KeyDeps, input: string, key: InkKeyLike): void {
  if (K.ask || K.askUserPending || K.clearPending || K.findQuery !== null) return;
  if (bindingMatches(K.keybindings["app.cycle-mode"], input, key)) {
    const next = cycleMode(K.api.getMode());
    K.api.setMode(next);
    K.api.notify(`模式 → ${modeLabel(next)}`); // ω99-175: #1（枚举字面 accept/K.ask/auto/plan/workspace 为 wire 层，保留）
    return;
  }
  if (bindingMatches(K.keybindings["app.exit"], input, key)) {
    if (K.api.busy) {
      K.api.interrupt();
      void K.agentsRegistry.abortAll();
    } else K.exit();
    return;
  }
  if (bindingMatches(K.keybindings["app.abort"], input, key)) {
    // Busy (or an idle /compact in flight — ω99-45, the driver's isIdle):
    // single Esc = interrupt (the detector is NOT armed here — a second
    // press while still busy must abort again, never rewind). An idle
    // compaction MUST take this branch too: Esc aborts the summarizer
    // instead of arming the double-Esc /rewind window, which would rewind
    // straight through the compaction's rewrite of state.messages.
    if (K.api.busy || !K.api.driver.isIdle()) {
      K.escPressedAtRef.current = 0;
      K.api.interrupt();
      void K.agentsRegistry.abortAll();
      return;
    }
    // Idle, but the suggestion menu was open at press time: that Esc
    // dismissed the menu (TextInput consumed it) — it was not a free
    // press, and the double-Esc detector must not arm on it.
    if (K.menuOpenRef.current) return;
    // Idle: arm/complete the double-press window (400ms).
    const now = Date.now();
    if (K.escPressedAtRef.current !== 0 && now - K.escPressedAtRef.current <= DOUBLE_ESC_WINDOW_MS) {
      K.escPressedAtRef.current = 0;
      if (K.escResetTimerRef.current !== null) {
        clearTimeout(K.escResetTimerRef.current);
        K.escResetTimerRef.current = null;
      }
      void K.apiRef.current?.driver.rewind("last").catch(() => {});
      return;
    }
    K.escPressedAtRef.current = now;
    if (K.escResetTimerRef.current !== null) clearTimeout(K.escResetTimerRef.current);
    const timer = setTimeout(() => {
      K.escPressedAtRef.current = 0;
      K.escResetTimerRef.current = null;
    }, DOUBLE_ESC_WINDOW_MS);
    timer.unref?.();
    K.escResetTimerRef.current = timer;
  }
}
