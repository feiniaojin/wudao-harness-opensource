// @vitest-environment jsdom
// ω99-291 — 宠物域分层缝契约（0.3.78 零像素回归的重构收据，用户令
// 09-12「对相关代码进行重构，确保高内聚低耦合」）。main.tsx 曾是 612 行
// 单体：7 个事件域监听 + invoke/emit + 指针层 + 聊天态 + 渲染同文件——
// T9 在其中加戳一戳时与几何/渲染互相碰撞即成回归。拆分后四件各归其位：
//   main.tsx     = 入口（stamp + mount，pet.css 唯一导入点）
//   PetApp.tsx   = 状态核心 + 组合 + 渲染
//   signals.ts   = 总线接线之家（listen/invoke/emit）
//   interaction.ts = 指针层（直接操纵原语 + 定时器族）
// 本件钉缝（防再耦合）：① 入口与状态核心对 ../tauri-invoke.js 零 import
// （总线只准住在 signals；直接操纵只准住在 interaction）；② 信号 hook
// 调用序=总线注册序——usePetStateFrames 殿后（pet-root harness 取最末
// transformCallback 注册为 state handler 的契约）；③ 各 home 导出齐整；
// ④ 渲染面留痕（display 三态/poked/pet-expr 在 PetApp）。行为面由既有
// pet-root/pet-bubble 全套端到端守卫（它们 import 整个入口）。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203/290 三证）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};

describe("ω99-291 宠物域分层缝（高内聚低耦合同构钉）", () => {
  const entry = readSrc("pet/main.tsx");
  const petApp = readSrc("pet/PetApp.tsx");
  const signals = readSrc("pet/signals.ts");
  const interaction = readSrc("pet/interaction.ts");

  it("缝①：入口与状态核心对 tauri-invoke 零 import（总线/操纵各有其家）", () => {
    expect(entry).not.toContain('from "../tauri-invoke.js"');
    expect(petApp).not.toContain('from "../tauri-invoke.js"');
    expect(petApp).not.toContain("tauriListenEvent");
    expect(petApp).not.toContain("tauriInvokeCommand");
    // 总线接线只住 signals（listen 家 + invoke/emit 家）
    expect(signals).toContain('from "../tauri-invoke.js"');
    expect(signals).toContain("tauriListenEvent(WUDAO_PET_STATE_EVENT");
    // 直接操纵原语只住 interaction（拖窗/聚焦——不是事件总线）
    expect(interaction).toContain('from "../tauri-invoke.js"');
    expect(interaction).toContain("tauriStartDrag");
    expect(interaction).toContain("tauriFocusWindow");
    expect(interaction).not.toContain("tauriListenEvent");
  });

  it("缝②：信号 hook 调用序=注册序——usePetStateFrames 殿后（pet-root harness 契约）", () => {
    const last = petApp.indexOf("usePetStateFrames(");
    expect(last).toBeGreaterThan(-1);
    // 其余信号 hook 的调用全在其前——任何新信号插队到 state 帧之后都会
    // 抢走「最末 transformCallback 注册」，pet-root 的 stateHandler 即错。
    for (const h of ["usePetLayoutSync(", "usePetDeliverySignal()", "usePetSelectionSignal()", "usePetSkinSignal()", "usePetToastSignal(", "usePetHistorySignal()", "usePetThemeSignal()"]) {
      const at = petApp.indexOf(h);
      expect(at, `${h} 需在 PetApp 组合`).toBeGreaterThan(-1);
      expect(at, `${h} 必须在 usePetStateFrames 之前`).toBeLessThan(last);
    }
    // signals 文件内：state 帧的 listen 是该文件最后一个 tauriListenEvent 调用
    const stateListen = signals.lastIndexOf("tauriListenEvent(WUDAO_PET_STATE_EVENT");
    expect(stateListen).toBeGreaterThan(-1);
    expect(signals.indexOf("tauriListenEvent(WUDAO_PET_DELIVERY_EVENT")).toBeLessThan(stateListen);
  });

  it("缝③：各 home 的导出齐整（分层 API 面）", () => {
    for (const fn of [
      "export function usePetLayoutSync",
      "export function usePetDeliverySignal",
      "export function usePetSelectionSignal",
      "export function usePetSkinSignal",
      "export function usePetToastSignal",
      "export function usePetHistorySignal",
      "export function usePetThemeSignal",
      "export function usePetStateFrames",
      "export interface PetHistoryHandle",
      "export interface PetDeliveryHandle",
      "export interface PetSelectionHandle",
    ]) {
      expect(signals, `${fn} 在 signals`).toContain(fn);
    }
    for (const fn of [
      "export function useWakeNudge",
      "export function usePointerInteraction",
      "export interface PointerInteractionOptions",
      "export interface PointerInteraction",
    ]) {
      expect(interaction, `${fn} 在 interaction`).toContain(fn);
    }
    expect(petApp).toContain("export function PetApp()");
  });

  it("缝④：入口仍只做三件事（view stamp / theme boot stamp / mount）且 pet.css 唯一导入点不动", () => {
    expect(entry).toContain('dataset.view = view');
    expect(entry).toContain('localStorage.getItem("wudao.ui.theme") === "light" ? "light" : "dark"');
    expect(entry).toContain('import { PetApp } from "./PetApp.js";');
    expect(entry).toContain('import "./pet.css";');
    // 入口不再有组件体：状态机/监听/指针钩子全不在
    expect(entry).not.toContain("useState");
    expect(entry).not.toContain("useEffect");
  });
});
