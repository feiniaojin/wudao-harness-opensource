// wudao ui — entry. The shared secret rides the URL fragment
// (http://127.0.0.1:<port>/#<token>); it is read once here, sent as the
// first WS frame (auth), and never appears in any request line.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WudaoClient, tokenFromLocation, wsUrlFromLocation, shellFromLocation } from "./protocol.js";
import { App } from "./components/App.js";
import { mountPetRelay } from "./pet/relay.js";
import { mountPetDelivery } from "./pet/delivery.js";
import { mountPetDropFiles } from "./pet-drop.js";
import { stampPersistedAppearance } from "./theme.js";
import { tauriInvokeCommand, tauriListenEvent } from "./tauri-invoke.js";
// ω99-287: #2 — L2 关窗后台：主窗 close-requested 分叉（设置开 → hide 留驻
// 后台；关 → destroy 走既有退出路径）。仅 main 窗注册；浏览器 no-op。
import { mountBackgroundOnClose } from "./background-close.js";
import { normalizePetSkinId, WUDAO_PET_SKIN_EVENT } from "./pet/skin-ids.js";
import "./tokens.css";
import "./styles.css";

// M65-space §1: the desktop shell's mark — the Tauri navigation adds
// ?shell=desktop to the sidecar URL; stamping <html data-shell> here (before
// React mounts) keys the topbar's traffic-light inset at first paint, with
// no flash of the browser-tight 12px left.
const shell = shellFromLocation();
if (shell !== null) document.documentElement.dataset.shell = shell;

// 117 玻璃化：桌面壳的主窗 = vibrancy 玻璃形态（conf 侧 transparent +
// windowEffects sidebar，探针 117 真机定谳）——stamp html.glass 激活
// styles/05-glass.css 的门控层。与 data-shell 同一握手通道（?shell=desktop）
// 同点位 stamp：浏览器打开同一 URL = 无 glass 类 = 玻璃化之前的原样（天然
// 降级）。宠物窗不受影响——它加载 pet.html 的独立入口（pet/main.tsx），
// 本文件只在主壳页面执行。stamp 在 stampPersistedAppearance 之前：boot 的
// applyTheme 按玻璃门拨窗口主题（theme.ts 的 set_theme 联动），持久浅色
// 用户的第一 paint 材质就是浅的。
if (shell === "desktop") document.documentElement.classList.add("glass");

// M64-visual §1: dark is the default theme — and (final-review F6) BOTH the
// theme and the accent stamp on <html> up front, resolved from the
// localStorage mirrors (absent → the factory dark/green), so the token
// sheet's [data-theme]/[data-accent] keys apply from first paint — a
// persisted light/blue user never sees the factory look flash while the
// first settingsStatus reply is still in flight.
stampPersistedAppearance();

// ω99-275: #6 — 主窗 stamp 小精灵肤（<html data-pet-skin>）：助手消息头像
//（AssistantReply .sig-avatar）的 CSS 规则按该属性取当前肤 sheet。双通路
// 同 pet 窗：boot 读 get_pet_skin（Rust 持久值）+ 托盘换肤事件 live 跟随
//（注册表外 id 丢弃保持当前肤）。browser → 双降级无崩溃（tauri-invoke 的
// 无桥语义：invoke 解析 null、listen 解析 null，永不抛）。
void tauriInvokeCommand("get_pet_skin", {}).then((raw) => {
  document.documentElement.dataset.petSkin = normalizePetSkinId(raw);
});
void tauriListenEvent(WUDAO_PET_SKIN_EVENT, (payload) => {
  if (typeof payload !== "object" || payload === null) return;
  const skin = (payload as Record<string, unknown>).skin;
  if (typeof skin !== "string") return;
  const id = normalizePetSkinId(skin);
  if (id !== skin) return; // 注册表外 id → 丢弃（保持当前肤）
  document.documentElement.dataset.petSkin = id;
});

const token = tokenFromLocation();
const client = new WudaoClient({ url: wsUrlFromLocation(), token });
client.connect();

// ω99-99: the pet window's relay — this client is the ONLY WS connection
// (server is single-client); the pet gets its state over the Tauri event
// bus and its asks come back through client.submit. Browser → degrades to
// send-only, no crash. Unmount-less by design: it lives with the page.
mountPetRelay(client);

// ω99-104 (P1): drop-to-delegate — files dropped on the pet arrive as the
// pet-file-drop broadcast (Rust admits the paths into a TTL allowlist);
// this listener reads them back through the gated command and submits the
// task on the same single client. Browser → nothing to listen to, no crash.
mountPetDropFiles(client);

// ω99-287（续，标记见上）: 关窗后台分叉挂载 — 主窗的 close-requested 监听
// （同款 unmount-less、随页面生灭；关窗时经 settingsStatus 读当前设置位）。
// 注册失败/浏览器/非主窗 → 原生关闭语义保留，零影响。
mountBackgroundOnClose(client);

// ω99-105 (P1): delivery — the other half of the trust loop. When a
// scheduled task's turn finishes (busy falling edge), its digest rides the
// Tauri event bus to the pet's delivery bubble (the click path back into
// this window is the pet-open-main event the Rust shell listens for).
// Signal event, fire-and-forget; browser → emit is a no-op, no crash.
mountPetDelivery(client);

const root = createRoot(document.getElementById("root") ?? document.body);
root.render(
  <StrictMode>
    <App client={client} />
  </StrictMode>,
);
