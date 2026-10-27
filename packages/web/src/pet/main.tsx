// wudao pet — the pet window's entry (foundation ω99-97, sprite ω99-98,
// relay+bubble ω99-99). Deliberately NOT the main shell: no WudaoClient, no
// App, no styles.css — the main UI stays out of this window's JS module
// graph (and its memory; pet-root.test.tsx pins both). 119b 去廉价化：
// tokens.css 现在与主窗共享同一份（纯 CSS 零 JS 图影响——ω99-97 隔离的
// 实质是 JS 面；皮肤 chrome 从此消费 var(--*) 令牌，明暗随 data-theme
// 自动翻转）。pet.css below is the pet-window-only stylesheet, so nothing
// of the pet ever leaks into the main shell's bundle. The Rust navigation
// lands here with /pet.html?shell=desktop&view=pet#<token>; the fragment
// stays untouched — the Tauri event bus needs no auth (the ask rides the
// MAIN window's already-authenticated WS client, never a second one here).
//
// ω99-291 — 入口只做三件事：view stamp、theme boot stamp、挂载 PetApp。
// 组件体已拆为三件内聚域（0.3.78 零像素回归的教训——612 行单体里 7 个
// 事件域 + 指针层 + 渲染同文件碰撞）：
//   PetApp.tsx    — 状态核心（machine/frame/chat/awaiting/inputOpen/
//                   layout）+ 组合 + 渲染；
//   signals.ts    — 总线接线之家（listen/invoke 全在此——注册序契约：
//                   state 帧殿后）；
//   interaction.ts— 指针层（press/release/点击判定/戳一戳三态/回弹/wake
//                   nudge 的全部定时器）。
// 缝契约（omega99-291 钉）：本文件与 PetApp.tsx 对 ../tauri-invoke.js 零
// import；既有源级钉已同形迁移（278 ②→interaction/PetApp，275 ③→signals）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PetApp } from "./PetApp.js";
// 119b — 与主窗同一份 tokens.css（先于 pet.css：皮肤 chrome 消费 var(--*)；
// 纯 CSS，零 JS 模块图影响）。styles.css 仍不进本入口。
import "../tokens.css";
import "./pet.css";

// ?view=pet — stamp <html data-view> before first paint (the same pattern
// the main entry uses for ?shell=desktop), so state CSS can key selectors
// on it. Absent (plain browser tab) → no stamp.
const view = new URLSearchParams(window.location.search).get("view");
if (view !== null) document.documentElement.dataset.view = view;

// ω99-275: #10 — boot 主题 stamp：与主窗同源（sidecar 同 origin 共享
// localStorage），主窗 stampPersistedAppearance 写的 wudao.ui.theme 在这里
// 首帧前读回；缺省/坏值=dark（与主窗 :root 缺省一致的工厂暗色）。live
// 切换走 wudao-pet-theme 事件（signals 的 usePetThemeSignal）。119b：宠物
// chrome 已全令牌化，stamp 落 html[data-theme] 即整窗翻转。
try {
  document.documentElement.dataset.theme =
    localStorage.getItem("wudao.ui.theme") === "light" ? "light" : "dark";
} catch {
  document.documentElement.dataset.theme = "dark";
}

const mount = document.getElementById("pet-root") ?? document.body;
createRoot(mount).render(
  <StrictMode>
    <PetApp />
  </StrictMode>,
);
