// @vitest-environment jsdom
// ω99-196 receipts — 桌面精灵两痛点修复（用户令 09-08）的行为面，先红后绿：
// A 组：stream（回答）是用户主动问出来的 → 永不自动淡出，✕ 用户主动关；
// B 组：窗口形态机 bubbleLayoutMode（compact/bubble/answer + answer 粘滞）；
// 渲染属性：data-bubble-held（held 阅读态的 CSS 钩子）。根因与修法见
// omega99-196-brief §零-§二。harness 沿 pet-bubble.test.tsx 的
// act + createRoot + native-event 范式（仓库无 @testing-library）。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Bubble, PET_BUBBLE_FADE_MS, PET_BUBBLE_LINGER_MS, bubbleLayoutMode } from "../src/pet/Bubble.js";
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
const petTurn = vi.fn(); // ω99-201: 新增必填 props（本 harness 零断言其行为）

function render(): void {
  act(() => {
    root.render(<Bubble {...props} />);
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  props = { inputOpen: false, answerTail: "", waitingUser: false, onInputClose: closed, delivery: null, onDeliveryClose: deliveryClosed, ask: null, selection: null, onSelectionClose: selectionClosed, busyNarration: null, workKind: null, transcript: [], onPetTurn: petTurn, livePending: false };
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
const closeBtn = (): HTMLElement | null => container.querySelector<HTMLElement>("[data-bubble-close]");
const clickClose = (): void => {
  act(() => {
    closeBtn()!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

describe("ω99-196 A stream（回答）用户主动关", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("A1 stream→idle：回答永不自动淡出（advance 10s 仍 shown、无 fading）", () => {
    props.answerTail = "回答全文";
    render();
    expect(state()).toBe("stream");
    props.answerTail = ""; // 回 idle（turn 结束帧清尾）
    render();
    expect(state()).toBe("stream"); // held 阅读态：内容原样保持
    act(() => {
      vi.advanceTimersByTime(10_000); // 任意时长——不止 2500ms
    });
    expect(bubble()).not.toBeNull();
    expect(bubble()?.hasAttribute("data-bubble-fading")).toBe(false);
  });

  it("A2 ✕ 在场（活流态+held 态）+ 点击即卸载（不发事件，纯本地关）", () => {
    props.answerTail = "流式正文";
    render();
    expect(closeBtn()).not.toBeNull(); // 活流态在场
    props.answerTail = ""; // turn 结束 → held 阅读态
    render();
    expect(closeBtn()).not.toBeNull(); // held 态仍在场
    clickClose();
    expect(bubble()).toBeNull(); // 点击后卸载
    expect(emitMock).not.toHaveBeenCalled(); // 关闭不发任何事件
  });

  it("A3 dismissedTail 抑制：✕ 关后同值不重现；空串复位；新值复现", () => {
    props.answerTail = "旧回答";
    render();
    clickClose();
    expect(bubble()).toBeNull();
    props.answerTail = "旧回答"; // 同值重放（tail 稳定期）
    render();
    expect(bubble()).toBeNull(); // 抑制：不复现
    props.answerTail = ""; // 空=复位 dismissal
    render();
    expect(bubble()).toBeNull();
    props.answerTail = "新回答"; // 新尾巴=新内容，复现
    render();
    expect(state()).toBe("stream");
    expect(bubble()?.textContent).toContain("新回答");
  });

  it("A4 hint/narration 仍 2500ms busy 瞬态淡出（别域回归钉）", () => {
    props.waitingUser = true;
    render();
    expect(state()).toBe("hint");
    props.waitingUser = false; // 瞬态结束
    render();
    expect(state()).toBe("hint"); // linger：内容保持
    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS - 1);
    });
    expect(bubble()).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_FADE_MS + 1);
    });
    expect(bubble()).toBeNull(); // 淡出后移除
    props.busyNarration = "正在打开网页…"; // narration 同族
    render();
    expect(state()).toBe("narration");
    props.busyNarration = null;
    render();
    act(() => {
      vi.advanceTimersByTime(PET_BUBBLE_LINGER_MS + PET_BUBBLE_FADE_MS);
    });
    expect(bubble()).toBeNull();
  });
});

describe("ω99-196 B 窗口形态机 bubbleLayoutMode（纯函数直测）", () => {
  it("B1 无显示=compact（content/held 全空；含被 ✕ 抑制的 stream；链断复位）", () => {
    expect(bubbleLayoutMode("compact", null, null, "")).toBe("compact");
    expect(bubbleLayoutMode("bubble", null, null, "")).toBe("compact");
    expect(bubbleLayoutMode("answer", null, null, "")).toBe("compact"); // 链断复位
    // ✕ 抑制后的 stream（text === dismissed）视同无显示
    expect(bubbleLayoutMode("answer", null, { kind: "stream", text: "X" }, "X")).toBe("compact");
  });

  it("B2 input/ask/selection/hint/narration/delivery=bubble", () => {
    // ω99-201: 钉随源演进（迷你聊天窗）——input 不再=bubble：chat 复合体
    // （transcript+textarea）需要阅读宽度，input 直映 answer（360×440）。
    expect(bubbleLayoutMode("compact", { kind: "input" }, { kind: "input" }, "")).toBe("answer");
    expect(bubbleLayoutMode("bubble", { kind: "input" }, { kind: "input" }, "")).toBe("answer");
    expect(bubbleLayoutMode("compact", { kind: "hint" }, { kind: "hint" }, "")).toBe("bubble");
    expect(bubbleLayoutMode("compact", { kind: "narration", text: "正在读页面…" }, { kind: "narration", text: "正在读页面…" }, "")).toBe("bubble");
    expect(bubbleLayoutMode("compact", { kind: "ask", ask: { toolName: "Bash", summary: "s", canAlways: false } }, { kind: "ask", ask: { toolName: "Bash", summary: "s", canAlways: false } }, "")).toBe("bubble");
    expect(bubbleLayoutMode("compact", { kind: "selection", selection: { text: "t", truncated: false, granted: true } }, { kind: "selection", selection: { text: "t", truncated: false, granted: true } }, "")).toBe("bubble");
    expect(bubbleLayoutMode("compact", { kind: "delivery", delivery: { taskId: "ab12cd34", promptDigest: "p", answerDigest: "" } }, { kind: "delivery", delivery: { taskId: "ab12cd34", promptDigest: "p", answerDigest: "" } }, "")).toBe("bubble");
  });

  it("B3 stream content=answer", () => {
    expect(bubbleLayoutMode("compact", { kind: "stream", text: "X" }, { kind: "stream", text: "X" }, "")).toBe("answer");
    expect(bubbleLayoutMode("bubble", { kind: "stream", text: "X" }, { kind: "stream", text: "X" }, "")).toBe("answer");
  });

  it("B4 held stream=answer（turn 结束后的阅读态）", () => {
    expect(bubbleLayoutMode("compact", null, { kind: "stream", text: "X" }, "")).toBe("answer");
    expect(bubbleLayoutMode("bubble", null, { kind: "stream", text: "X" }, "")).toBe("answer");
  });

  it("B5 answer 粘滞 + 链断复位：prev=answer 且仍有任何显示则保持 answer", () => {
    // narration 瞬态不能把 360 窗缩成 220 再弹回（形变抖动）
    expect(bubbleLayoutMode("answer", { kind: "narration", text: "正在读页面…" }, { kind: "narration", text: "正在读页面…" }, "")).toBe("answer");
    expect(bubbleLayoutMode("answer", { kind: "input" }, { kind: "input" }, "")).toBe("answer");
    expect(bubbleLayoutMode("answer", { kind: "hint" }, { kind: "hint" }, "")).toBe("answer");
    // 非 answer 起点不受粘滞
    expect(bubbleLayoutMode("bubble", { kind: "hint" }, { kind: "hint" }, "")).toBe("bubble");
    // 链断（全空）即复位 compact
    expect(bubbleLayoutMode("answer", null, null, "")).toBe("compact");
  });

  it("B6 接线钉：onLayoutMode 随形态变化上抛（stream→answer；✕ 关→compact；不变不上抛）", () => {
    const onLayout = vi.fn();
    props.onLayoutMode = onLayout;
    props.answerTail = "回答";
    render();
    expect(onLayout).toHaveBeenCalledTimes(1);
    expect(onLayout).toHaveBeenCalledWith("answer");
    props.answerTail = "";
    render(); // held 阅读态：仍 answer，不上抛
    expect(onLayout).toHaveBeenCalledTimes(1);
    clickClose();
    expect(onLayout).toHaveBeenCalledTimes(2);
    expect(onLayout).toHaveBeenCalledWith("compact"); // ✕ 关 → 窗口收回 compact
  });
});

describe("ω99-196 渲染属性（data-bubble-held）", () => {
  it("held 阅读态 stamp data-bubble-held；活流态（content 非 null）不 stamp", () => {
    props.answerTail = "流式正文";
    render();
    expect(bubble()?.hasAttribute("data-bubble-held")).toBe(false); // 活流态：底对齐最新行
    props.answerTail = "";
    render();
    expect(state()).toBe("stream");
    expect(bubble()?.hasAttribute("data-bubble-held")).toBe(true); // held：顶部对齐通读+滚动
  });
});
