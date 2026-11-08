// @vitest-environment jsdom
// ω99-309 — IME 组合守卫全覆盖。ω99-151 已把组合期守卫铺进 composer
// （InputBox）与 App 级搜索输入，但 web 面上还有一批文本输入在组合期
// （中文/日文 IME 确认候选词的 Enter、取消候选的 Esc）会误触发提交/关
// 闭——中文产品的主输入法交互正确性缺口。两类病灶：
//   A 类（输入自持 Enter/Esc）：SessionSidebar 重命名、PlanReview 改
//      意见、AskUserCards 自由文本、宠物聊天 textarea 与划词追问
//      input——组合期 Enter 误提交 / Esc 误关。
//   B 类（卡级 Esc 吃掉卡内任何输入的组合态）：ModelConfigModal、
//      ProviderTab/PersonaPanel 的 pvd 详情卡、SettingsPage 页根、
//      Wizard overlay——组合期 Esc 关卡丢稿。
// 修法全复用 ime-guard.ts（ω99-151 窄接口纯函数：Safari 假 Enter 的
// 100ms 时间窗兜底在内），A 类逐输入挂守卫，B 类卡级 composition 冒泡
// 监听 + Esc 判定前 imeSwallows。本件三拍断言（组合期 Enter 不提交 →
// compositionend 后 100ms 窗内裸 Enter 不提交〔Safari 假 Enter 形〕→
// 窗后真 Enter 提交）+ B 类源级 census 门（惯用法在场钉，305 范式）。
// 假时钟：100ms 窗的推进必须确定性（Date.now 被 vitest fake timers 接管）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SessionSidebar } from "../src/components/SessionSidebar.js";
import { AskUserCards } from "../src/components/AskUserCards.js";
import { PlanReview } from "../src/components/PlanReview.js";
import { Bubble } from "../src/pet/Bubble.js";
import { WUDAO_PET_SELECTION_SUBMIT_EVENT } from "../src/pet/selection.js";
import { tauriEmitEvent, tauriInvokeCommand } from "../src/tauri-invoke.js";
import type { SessionRow } from "../src/protocol.js";
import type { BubbleProps } from "../src/pet/Bubble.js";
import type { PetSelection } from "../src/pet/selection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
}));
const emitMock = vi.mocked(tauriEmitEvent);

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(el);
  });
  return container;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** Set a controlled input/textarea's value the React way (native setter +
 *  input event — the repo's no-testing-library idiom). */
function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** composition 事件（React 合成监听骑原生注册，bubbles 必需）。 */
function compStart(el: Element): void {
  act(() => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
}
function compEnd(el: Element): void {
  act(() => {
    el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });
}

/** keydown。isComposing 之外 imeSwallows 还看 st.composing / endedAt 窗，
 *  三拍的第 1/2 拍不依赖 jsdom 是否传播 isComposing（结构性冗余）。 */
function press(el: Element, key: string, isComposing = false): void {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, isComposing }));
  });
}

/** 越过 100ms Safari 假 Enter 窗——真 Enter 拍的确定性推进。 */
function pastImeWindow(): void {
  act(() => {
    vi.advanceTimersByTime(150);
  });
}

describe("ω99-309 A 类 — 输入自持 Enter/Esc 的组合期守卫", () => {
  it("SessionSidebar 重命名：组合期/假 Enter 窗内不提交，真 Enter 提交；组合期 Esc 不弃稿", async () => {
    const row = (over: Partial<SessionRow> & { id: string }): SessionRow => ({
      mtime: new Date(Date.now() - 60_000).toISOString(), messages: 2,
      firstUser: "工作会话", model: "deepseek-v4-flash", ...over,
    });
    const rename = vi.fn();
    const container = mount(
      <SessionSidebar
        client={{ sessions: () => Promise.resolve([row({ id: "s1" })]) }}
        activeSessionId={null}
        onResume={() => {}}
        onNewChat={() => {}}
        onOpenSearch={() => {}}
        onRenameSession={rename}
      />,
    );
    await act(async () => {}); // flush the sessions promise
    act(() => {
      (container.querySelector("button.sb-rename") as HTMLButtonElement).click();
    });
    const input = container.querySelector("input.sb-rename-in") as HTMLInputElement;
    expect(input).not.toBeNull();
    typeInto(input, "新名字");
    // 第 1 拍：组合期 Enter（确认候选词的那下）不得提交。
    compStart(input);
    press(input, "Enter", true);
    expect(rename).not.toHaveBeenCalled();
    expect(container.querySelector("input.sb-rename-in")).not.toBeNull(); // 还在编辑
    // 第 2 拍：compositionend 后立即裸 Enter（Safari 假 Enter——确认组合的
    // Enter 在 compositionend 之后才到且 isComposing=false）不得提交。
    compEnd(input);
    press(input, "Enter");
    expect(rename).not.toHaveBeenCalled();
    // 组合期 Esc 不弃稿（取消候选词 ≠ 取消重命名）。
    compStart(input);
    press(input, "Escape", true);
    expect(container.querySelector("input.sb-rename-in")).not.toBeNull();
    compEnd(input);
    // 第 3 拍：窗后真 Enter 提交，值如实。
    pastImeWindow();
    press(input, "Enter");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(rename).toHaveBeenCalledWith("s1", "新名字");
  });

  it("AskUserCards 自由文本：三拍 Enter 守卫；组合期 Esc 不解散（Esc 在卡级，吃输入冒泡的组合态）", () => {
    const answer = vi.fn();
    const dismiss = vi.fn();
    const container = mount(<AskUserCards question="用哪个方案？" onAnswer={answer} onDismiss={dismiss} />);
    const input = container.querySelector(".modal-card input.wudao-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    typeInto(input, "方案一");
    compStart(input);
    press(input, "Enter", true);
    compEnd(input);
    press(input, "Enter");
    expect(answer).not.toHaveBeenCalled();
    // 组合期 Esc 冒泡到卡级不得解散——解散=丢掉打到一半的候选稿。
    compStart(input);
    press(input, "Escape", true);
    expect(dismiss).not.toHaveBeenCalled();
    compEnd(input);
    pastImeWindow();
    press(input, "Enter");
    expect(answer).toHaveBeenCalledTimes(1);
    expect(answer).toHaveBeenCalledWith("方案一");
  });

  it("PlanReview 改意见：三拍 Enter 守卫；组合期 Esc 不退出编辑", () => {
    const submit = vi.fn();
    const container = mount(<PlanReview plan="1. 做 A\n2. 做 B" busy={false} onSubmit={submit} />);
    const reviseBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.startsWith("改")) as HTMLButtonElement;
    act(() => {
      reviseBtn.click();
    });
    const input = container.querySelector(".btnrow input.wudao-input") as HTMLInputElement;
    expect(input).not.toBeNull();
    typeInto(input, "先做 B");
    compStart(input);
    press(input, "Enter", true);
    compEnd(input);
    press(input, "Enter");
    expect(submit).not.toHaveBeenCalled();
    compStart(input);
    press(input, "Escape", true);
    expect(container.querySelector(".btnrow input.wudao-input")).not.toBeNull(); // 编辑未退
    compEnd(input);
    pastImeWindow();
    press(input, "Enter");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith("改 先做 B");
  });
});

describe("ω99-309 宠物域 — 聊天与划词追问的组合期守卫", () => {
  const baseProps = (over: Partial<BubbleProps>): BubbleProps => ({
    inputOpen: false, answerTail: "", waitingUser: false, onInputClose: vi.fn(),
    delivery: null, onDeliveryClose: vi.fn(), ask: null, selection: null,
    onSelectionClose: vi.fn(), busyNarration: null, workKind: null, transcript: [],
    onPetTurn: vi.fn(), livePending: false, ...over,
  });

  it("聊天 textarea：三拍 Enter 守卫；组合期 Esc 不关窗", () => {
    const petTurn = vi.fn();
    const closed = vi.fn();
    const container = mount(<Bubble {...baseProps({ inputOpen: true, onPetTurn: petTurn, onInputClose: closed })} />);
    const ta = container.querySelector("textarea[data-bubble-input]") as HTMLTextAreaElement;
    expect(ta).not.toBeNull();
    typeInto(ta, "在吗");
    compStart(ta);
    press(ta, "Enter", true);
    compEnd(ta);
    press(ta, "Enter");
    expect(petTurn).not.toHaveBeenCalled();
    compStart(ta);
    press(ta, "Escape", true);
    expect(closed).not.toHaveBeenCalled();
    compEnd(ta);
    pastImeWindow();
    press(ta, "Enter");
    expect(petTurn).toHaveBeenCalledTimes(1); // digest 后的 q 行文本
    // 窗后裸 Esc 才关窗。
    press(ta, "Escape");
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("划词追问 input：三拍 Enter 守卫（submit 事件也不发）", () => {
    const petTurn = vi.fn();
    const selection: PetSelection = { text: "选中的一段话", truncated: false, granted: true };
    const container = mount(<Bubble {...baseProps({ selection, onPetTurn: petTurn })} />);
    const input = container.querySelector("input[data-selection-question]") as HTMLInputElement;
    expect(input).not.toBeNull();
    typeInto(input, "啥意思");
    compStart(input);
    press(input, "Enter", true);
    compEnd(input);
    press(input, "Enter");
    expect(petTurn).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalledWith(WUDAO_PET_SELECTION_SUBMIT_EVENT, expect.anything());
    pastImeWindow();
    press(input, "Enter");
    expect(petTurn).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(WUDAO_PET_SELECTION_SUBMIT_EVENT, expect.objectContaining({ text: expect.stringContaining("选中的一段话") }));
  });
});

describe("ω99-309 B 类 census — 卡级 Esc 的组合守卫惯用法在场（源级门）", () => {
  // 行为机制已由 A 类端到端证明（同一 ime-guard 纯函数 + 同一接线形）；
  // B 类五卡 mount 较重（WudaoClient/Wizard 全链），按 305 先例钉源级
  // 惯用法在场：卡级 onCompositionStart/End（吃卡内全部输入的组合冒泡）
  // + Esc 判定前 imeSwallows。
  const src = (rel: string): string => readFileSync(join(process.cwd(), rel), "utf8");

  it.each([
    "src/components/ModelConfigModal.tsx",
    "src/components/ProviderTab.tsx",
    "src/components/PersonaPanel.tsx",
    "src/components/SettingsPage.tsx",
    "src/components/Wizard.tsx",
    "src/components/AskUserCards.tsx", // 卡级 Esc（自由文本输入的组合态冒泡到卡）
  ])("%s — imeSwallows + 卡级 composition 监听在场", (rel) => {
    const s = src(rel);
    expect(s.includes("imeSwallows("), `${rel} 缺 imeSwallows 守卫`).toBe(true);
    expect(s.includes("onCompositionStart"), `${rel} 缺卡级 onCompositionStart`).toBe(true);
    expect(s.includes("onCompositionEnd"), `${rel} 缺卡级 onCompositionEnd`).toBe(true);
  });

  it.each([
    "src/components/SessionSidebar.tsx",
    "src/components/PlanReview.tsx",
    "src/pet/Bubble.tsx",
  ])("%s — 输入级 imeSwallows 在场", (rel) => {
    expect(src(rel).includes("imeSwallows("), `${rel} 缺 imeSwallows 守卫`).toBe(true);
  });
});
