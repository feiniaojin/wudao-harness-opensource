// @vitest-environment jsdom
// ω99-201 receipts — 桌面精灵迷你聊天窗（用户令 09-08 三需求），先红后绿：
// ①chat 开 = transcript（q 行 + a 格）+ textarea 同场（两锚同挂）；②发送 →
// onPetTurn 收 digest、textarea 清空、input 形态仍挂载（发送不收窗——需求
// 1/2 的构造性钉）；③末位 live && a==="" → 「思考中…」格；④关窗 +
// livePending=true → 独立 thinking 形态 + onLayoutMode("answer")；⑤主窗轮
// 不弹 thinking（D8 打扰纪律门）；⑥input 形态 onLayoutMode 首变 "answer"
// （196 演进钉：input 也映射 answer 窗）；⑦CSS 源钉（readFileSync 源钉法）。
// harness 沿 pet-bubble.test.tsx 的 act + createRoot + native-event 范式
// （仓库无 @testing-library）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readStyles } from "./styles-source.js";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Bubble } from "../src/pet/Bubble.js";
import { tauriEmitEvent, tauriInvokeCommand } from "../src/tauri-invoke.js";
import type { BubbleProps } from "../src/pet/Bubble.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../src/tauri-invoke.js", () => ({
  tauriEmitEvent: vi.fn(async () => false),
  tauriInvokeCommand: vi.fn(async () => null),
}));

const emitMock = vi.mocked(tauriEmitEvent);

let container: HTMLElement;
let root: Root;
let props: BubbleProps;
const closed = vi.fn();
const deliveryClosed = vi.fn();
const selectionClosed = vi.fn();
const petTurn = vi.fn();

function render(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = {
    inputOpen: false,
    answerTail: "",
    waitingUser: false,
    onInputClose: closed,
    delivery: null,
    onDeliveryClose: deliveryClosed,
    ask: null,
    selection: null,
    onSelectionClose: selectionClosed,
    busyNarration: null,
    workKind: null,
    transcript: [],
    onPetTurn: petTurn,
    livePending: false,
  };
  emitMock.mockClear();
  closed.mockClear();
  deliveryClosed.mockClear();
  selectionClosed.mockClear();
  petTurn.mockClear();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  document.body.innerHTML = "";
});

const bubble = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-bubble]");
const state = (): string | null | undefined => bubble()?.getAttribute("data-bubble-state");

function typeInto(ta: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ω99-201 chat 复合体（回答与输入同窗，需求 2）", () => {
  it("① chat 开 = transcript（q 行 + a 格）+ textarea 同场（两锚同挂）", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "上次的问题", a: "上次的回答", live: false }];
    render();
    expect(state()).toBe("input");
    const ts = container.querySelector<HTMLElement>("[data-bubble-transcript]");
    expect(ts).not.toBeNull();
    expect(ts?.textContent).toContain("上次的问题");
    expect(ts?.textContent).toContain("上次的回答");
    expect(container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")).not.toBeNull();
  });

  it("② 发送 → onPetTurn 收 digest（24 字+…）、textarea 清空、input 形态仍挂载（不收窗）", () => {
    props.inputOpen = true;
    render();
    const ta = container.querySelector<HTMLTextAreaElement>("textarea[data-bubble-input]")!;
    typeInto(ta, "这是一条超过二十四个字符的长问题需要截断成摘要显示在气泡里");
    act(() => {
      container.querySelector("[data-bubble-send]")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(petTurn).toHaveBeenCalledTimes(1);
    const d = petTurn.mock.calls[0]![0];
    expect(Array.from(d as string).length).toBe(25); // 24 字 + 省略号
    expect((d as string).endsWith("…")).toBe(true);
    expect(closed).not.toHaveBeenCalled(); // 发送不收窗（聊天窗语义）
    expect(state()).toBe("input"); // 聊天窗保持开
    expect(ta.value).toBe(""); // textarea 照旧清空
  });

  it("③ 末位 live && a===\"\" → 「思考中…」格在场（transcript 内）", () => {
    props.inputOpen = true;
    props.transcript = [{ q: "刚发的问题", a: "", live: true }];
    render();
    expect(bubble()?.textContent).toContain("思考中…");
    expect(container.querySelector<HTMLElement>(".pet-bubble-thinking")).not.toBeNull();
  });
});

describe("ω99-201 thinking 即时反馈（需求 1）", () => {
  it("④ 关窗 + livePending=true → 独立 thinking 形态（data-bubble-state=thinking）+ onLayoutMode(\"answer\")", () => {
    const onLayout = vi.fn();
    props.onLayoutMode = onLayout;
    props.livePending = true;
    render();
    expect(state()).toBe("thinking");
    expect(bubble()?.textContent).toContain("思考中…");
    expect(bubble()?.querySelector("[data-bubble-thinking]")).not.toBeNull();
    expect(onLayout).toHaveBeenCalledWith("answer");
  });

  it("⑤ 关窗 + livePending=false（主窗轮）+ busy 推理帧 → 无 thinking 形态（D8 门）", () => {
    props.livePending = false;
    props.busyNarration = null; // 推理期：无旁白、无尾——主窗轮不弹独立思考中
    props.answerTail = "";
    render();
    expect(container.querySelector('[data-bubble-state="thinking"]')).toBeNull();
    expect(bubble()).toBeNull(); // 既有呈现保持：主窗工作时宠物只有精灵动画
  });

  it("⑥ input 形态 onLayoutMode 首变 \"answer\"（196 演进钉：input 也映射 answer 窗）", () => {
    const onLayout = vi.fn();
    props.onLayoutMode = onLayout;
    props.inputOpen = true;
    render();
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onLayout).toHaveBeenCalledWith("answer");
  });
});

describe("ω99-201 CSS 源钉（readFileSync 源钉法）", () => {
  const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("⑦ pet.css：.pet-bubble-transcript + overflow-y:auto + webkit 滚动条；styles.css：buddy 两域滚动条", () => {
    const petCss = read("../src/pet/pet.css");
    expect(petCss).toContain(".pet-bubble-transcript");
    expect(petCss).toContain("overflow-y:auto");
    expect(petCss).toContain("::-webkit-scrollbar");
    const styles = readStyles();
    expect(styles).toContain(".buddy .sb-list::-webkit-scrollbar");
    expect(styles).toContain(".buddy .chat::-webkit-scrollbar");
  });
});
