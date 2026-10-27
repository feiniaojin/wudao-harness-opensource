// M64-visual §1 — the two-theme token system. Colors live in tokens.css as
// custom properties (dark default, [data-theme="light"] override,
// [data-accent] variants); documentElement.dataset.theme/accent are the
// runtime switches. This module owns the switches (read/apply) plus the
// localStorage mirrors that let main.tsx stamp the persisted look at FIRST
// PAINT (final-review F6) — before any WS reply lands. Inline colors ride
// the .tok-* classes (highlight.ts), not a token map.
import { tauriEmitEvent, tauriSetWindowTheme } from "./tauri-invoke.js";
import { WUDAO_PET_THEME_EVENT } from "./pet/pet-frame.js";

export type ThemeName = "light" | "dark";

/** Read the active theme; anything absent or unknown resolves to dark. */
export function readTheme(): ThemeName {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** Switch the theme by setting the data-theme attribute on <html> and
 *  writing the localStorage mirror (main.tsx's first-paint stamp reads it
 *  back on the next load — the two never disagree for long). */
export function applyTheme(t: ThemeName): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("wudao.ui.theme", t);
  // ω99-275: #8 — 切主题即广播宠物窗（用户令「主窗口切换主题，小精灵也要
  // 切换主题」）。同源 localStorage 只管 boot（宠物窗首帧读回）；live 切换走
  // Tauri 事件——WKWebView 跨 webview 的 storage 事件不可靠。单一缝=
  // applyTheme：boot 的 stampPersistedAppearance 与所有切换点都过这里。
  // browser → emit 降级 no-op（tauri-invoke 无桥语义，永不抛）。
  void tauriEmitEvent(WUDAO_PET_THEME_EVENT, { theme: t });
  // 117 玻璃化：窗口主题（=vibrancy 材质明暗）在同一缝拨齐——探针 P2 证
  // set_theme 当场翻材质，错位即「浅色页面压暗玻璃」。仅玻璃形态需要联动：
  // html.glass（主窗入口在 stampPersistedAppearance 之前 stamp，见
  // main.tsx）在场才拨——无玻璃 = 无材质可同步，还省一次桥调用；浏览器/
  // 宠物窗/未 stamp 的窗口零额外 invoke。
  if (document.documentElement.classList.contains("glass")) {
    void tauriSetWindowTheme(t);
  }
}

/** M64-visual §4: the accent channel — the three swappable accents
 * ([data-accent] in tokens.css; green is the factory default, spec §1). */
export type AccentName = "black" | "blue" | "green";

/** Read the active accent; absent or unknown resolves to green. */
export function readAccent(): AccentName {
  const a = document.documentElement.dataset.accent;
  return a === "black" || a === "blue" || a === "green" ? a : "green";
}

/** Switch the accent by setting the data-accent attribute on <html> and
 *  writing the localStorage mirror (applyTheme's twin). */
export function applyAccent(a: AccentName): void {
  document.documentElement.dataset.accent = a;
  localStorage.setItem("wudao.ui.accent", a);
}

// --- the first-paint stamp (final-review F6) ---
// The mirrors above are per-browser fast paths: the server's settingsStatus
// reply stays the source of truth and re-applies on land. Absent or unknown
// values resolve the factory dark/green, so a fresh browser never inherits
// a stale attribute from a previous session's flash.
function storedTheme(): ThemeName {
  return localStorage.getItem("wudao.ui.theme") === "light" ? "light" : "dark";
}

function storedAccent(): AccentName {
  const a = localStorage.getItem("wudao.ui.accent");
  return a === "black" || a === "blue" || a === "green" ? a : "green";
}

/** Stamp BOTH appearance attributes from the localStorage mirrors — the
 *  entry-point call (main.tsx), run before the first render, so a persisted
 *  light/blue user never flashes the factory dark/green while the first
 *  settingsStatus is in flight (which also kills the ledger's light-user
 *  dark-flash). */
export function stampPersistedAppearance(): void {
  applyTheme(storedTheme());
  applyAccent(storedAccent());
}

/** Horizontal rule glyph (dividers: `── text ──`). */
export const SEP = "─";
/** Segment separator for single-line composites (status bar). */
export const SEGMENT_SEP = " │ ";
