// background-close — ω99-287: #2 — L2 后台运行 MVP（关窗不杀活，A 案路线 W）。
//
// macOS 用户「点红叉以为退了」是杀活最高频路径。本模块把主窗的关闭语义
// 反转为可选的「关窗即后台」：设置开 → prevent+hide（app 留驻，活继续跑，
// Safari/Discord 心智）；设置关（默认，Q1 裁定）→ 放行原生退出，走既有
// Destroyed→terminate→exit 路径（真 quit 语义原样）。
//
// 路线 W 的机制链（tauri 2.11.5 亲验，证据链见弧报告）：
//   1. 本页（sidecar origin，remote in ACL）以
//      plugin:event|listen(target={"kind":"Window","label":"main"}) 注册
//      tauri://close-requested —— manager/window.rs 的 CloseRequested 分支
//      只对窗名 target 的 JS 监听 api.prevent_close() 并把事件投回本窗；
//      Any 监听收得到但不挡默认关闭，所以 target 必须带窗名。
//   2. 监听在场 = 关闭已被 Rust 挡下 → 责任在本 handler：设置开 → hide；
//      否则（关/缺席/读失败）→ destroy（放行退出。NOT close——close 会再发
//      一次 CloseRequested，死循环；window/mod.rs :1793）。
//   3. 不变式：监听在场 ⇒ handler 必给出 hide 或 destroy 二者之一——hide
//      失败也回落 destroy，绝不让窗关不掉。设置读失败（server 不可达）→
//      destroy（fail-open 到旧行为：没有活可保护的场景，退出即诚实）。
//
// 作用域：仅 main 窗（__TAURI_INTERNALS__.metadata.currentWindow.label）。
// workspace-* 窗是伴生窗，保留原生关闭；pet 窗有自己的 Destroyed→hide
// 分叉（ω99-97 D4），不经本模块。浏览器 → 无桥 → 全 no-op，绝不抛。
// 桌面入口 main.tsx 挂载一次（unmount-less：随页面生灭，同 mountPetRelay）。

import { resolveTauriInvoke, tauriListenEvent } from "./tauri-invoke.js";

/** tauri 的主窗关闭请求事件（manager/window.rs WINDOW_CLOSE_REQUESTED_EVENT）。 */
export const CLOSE_REQUESTED_EVENT = "tauri://close-requested";

/** The main window's label — the only window whose close forks to background. */
const MAIN_WINDOW_LABEL = "main";

/** The close fork's two exits: hide = 留驻后台（活继续跑）；close = 放行退出。 */
export type BackgroundCloseDecision = "hide" | "close";

/** 纯决策：设置开 → "hide"；false / 缺席（老 server）/读失败 → "close"。
 * fail-closed——任何不确定都走旧语义（Q1 默认关）。 */
export function backgroundCloseDecision(setting: boolean | undefined): BackgroundCloseDecision {
  return setting === true ? "hide" : "close";
}

/** 本窗的 Tauri 窗名（__TAURI_INTERNALS__.metadata.currentWindow.label，
 * tauri 以初始化脚本注入）。非 Tauri 环境或 metadata 缺席 → null。 */
export function currentTauriWindowLabel(w: unknown = window): string | null {
  if (typeof w !== "object" || w === null) return null;
  const internals = (w as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  if (typeof internals !== "object" || internals === null) return null;
  const metadata = (internals as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  const label = (metadata as { currentWindow?: { label?: unknown } }).currentWindow?.label;
  return typeof label === "string" && label !== "" ? label : null;
}

/** 隐藏本窗（plugin:window|hide；无 label = 调用方所在窗，start_dragging 同
 * 约定）。非 Tauri / 拒绝 → false。 */
export async function tauriHideWindow(): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|hide");
    return true;
  } catch {
    return false;
  }
}

/** 销毁本窗（plugin:window|destroy）——设置关时的放行出口：绕过
 * close-requested 再发（close 会再问一次 → 死循环），直接落地既有
 * Destroyed→terminate→exit。非 Tauri / 拒绝 → false。 */
export async function tauriDestroyWindow(): Promise<boolean> {
  const invoke = resolveTauriInvoke();
  if (!invoke) return false;
  try {
    await invoke("plugin:window|destroy");
    return true;
  } catch {
    return false;
  }
}

/** 决策流的注入边（测试替身缝；生产边是上面的实函数）。 */
export interface BackgroundCloseDeps {
  /** 读当前设置位（settingsStatus 车道；拒绝 = server 不可达）。 */
  readonly readSetting: () => Promise<boolean | undefined>;
  readonly hide?: () => Promise<boolean>;
  readonly destroy?: () => Promise<boolean>;
}

/** 关窗请求的完整决策流（纯 over 注入边）："hidden" = 已转后台；
 * "closed" = 已放行退出。读失败 → close；hide 失败 → 仍 destroy
 * （不可关死窗不变式）。 */
export async function resolveBackgroundClose(deps: BackgroundCloseDeps): Promise<"hidden" | "closed"> {
  let setting: boolean | undefined;
  try {
    setting = await deps.readSetting();
  } catch {
    setting = undefined; // server 不可达——没有活可保护，走旧语义
  }
  if (backgroundCloseDecision(setting) === "hide") {
    if (await (deps.hide ?? tauriHideWindow)()) return "hidden";
  }
  await (deps.destroy ?? tauriDestroyWindow)();
  return "closed";
}

/** 决策位的最小读车道（settingsStatus.settings.desktopBackgroundOnClose；
 * 结构化最小面——WudaoClient 结构满足，测试替身零依赖）。 */
export interface BackgroundCloseClient {
  settingsStatus(): Promise<{ settings?: { desktopBackgroundOnClose?: boolean } | undefined } | unknown>;
}

/** 挂载：主窗的 close-requested 分叉（桌面入口调用一次）。浏览器 / 非 main
 * 窗 / 注册失败 → no-op（原生关闭语义保留）。unlisten-less：随页面生灭。 */
export function mountBackgroundOnClose(client: BackgroundCloseClient): void {
  const label = currentTauriWindowLabel();
  if (label !== MAIN_WINDOW_LABEL) return;
  void tauriListenEvent(
    CLOSE_REQUESTED_EVENT,
    () => {
      void resolveBackgroundClose({
        readSetting: async () => {
          const s = (await client.settingsStatus()) as { settings?: { desktopBackgroundOnClose?: boolean } } | null;
          return s?.settings?.desktopBackgroundOnClose;
        },
      });
    },
    { kind: "Window", label: MAIN_WINDOW_LABEL },
  );
}
