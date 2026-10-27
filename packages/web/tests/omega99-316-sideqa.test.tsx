// ω99-316 — /btw 侧问的 web 面：「顺便问」chip 双态入口 + 旁路问答气泡 +
// 一键转正。chip 状态内置 InputBox（busy/idle 同一入口：armed 后下一条
// submit 走 onSideAsk，绕过 queue/steer lane——旁路的全部意义就是不打断）；
// 回答渲染为标记气泡（不占主对话 run 结构）；「转入主线」把问答对格式化
// 为一条消息走现有 steering/send 通道（零新协议）。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import { SideQaLane, formatSidePromoteMessage, type SideQa } from "../src/components/SideQaLane.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  document.body.innerHTML = "";
});

const BASE = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn(),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

function type(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const proto = el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("InputBox 顺便问 chip (ω99-316)", () => {
  it("renders only when onSideAsk exists; clicking arms it (aria-pressed), clicking again disarms", () => {
    const onSideAsk = vi.fn();
    const c = mount(<InputBox {...BASE} onSideAsk={onSideAsk} />);
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.sideqa")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain("顺便问");
    expect(chip.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      chip.click();
    });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    act(() => {
      chip.click();
    });
    expect(chip.getAttribute("aria-pressed")).toBe("false");

    const c2 = mount(<InputBox {...BASE} />);
    expect(c2.querySelector(".composer-tools .chip.sideqa")).toBeNull();
  });

  it("armed: the next text submit routes to onSideAsk (NOT onSubmit) and disarms", () => {
    const onSideAsk = vi.fn();
    const c = mount(<InputBox {...BASE} onSideAsk={onSideAsk} />);
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.sideqa")!;
    act(() => {
      chip.click();
    });
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    act(() => {
      type(input, "这个报错什么意思？");
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSideAsk).toHaveBeenCalledTimes(1);
    expect(onSideAsk).toHaveBeenCalledWith("这个报错什么意思？");
    expect(BASE.onSubmit).not.toHaveBeenCalled();
    // disarmed after use — the NEXT submit goes back to the main lane.
    act(() => {
      type(input, "主线下一条");
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(BASE.onSubmit).toHaveBeenCalledTimes(1);
    expect(chip.getAttribute("aria-pressed")).toBe("false");
  });

  it("works while busy: armed submit still routes to onSideAsk (the whole point — no interruption)", () => {
    const onSideAsk = vi.fn();
    const c = mount(<InputBox {...BASE} busy onSideAsk={onSideAsk} />);
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.sideqa")!;
    act(() => {
      chip.click();
    });
    const input = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    act(() => {
      type(input, "现在怎么样了？");
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(onSideAsk).toHaveBeenCalledWith("现在怎么样了？");
  });
});

describe("SideQaLane 旁路问答气泡 + 转正 (ω99-316 超越点 1)", () => {
  const qa: SideQa = { id: "sq1", question: "这个报错什么意思？", answer: "旁答：是路径不存在。", rounds: 1 };

  it("renders the marked bubble: 旁路问答 label, question, answer, rounds; NOT part of the main run structure", () => {
    const c = mount(<SideQaLane qas={[qa]} onPromote={vi.fn()} />);
    const bubble = c.querySelector("[data-sideqa]")!;
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toContain("旁路问答");
    expect(bubble.textContent).toContain("这个报错什么意思？");
    expect(bubble.textContent).toContain("是路径不存在");
    expect(c.querySelectorAll("[data-sideqa]").length).toBe(1);
  });

  it("转入主线 button fires onPromote with the qa entry (the App layer routes it through the existing send lane)", () => {
    const onPromote = vi.fn();
    const c = mount(<SideQaLane qas={[qa]} onPromote={onPromote} />);
    const btn = c.querySelector<HTMLButtonElement>("[data-sideqa] button.sideqa-promote")!;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("转入主线");
    act(() => {
      btn.click();
    });
    expect(onPromote).toHaveBeenCalledTimes(1);
    expect(onPromote).toHaveBeenCalledWith(qa);
  });

  it("formatSidePromoteMessage: the Q/A pair formats as ONE message for the existing steering/send channel", () => {
    const msg = formatSidePromoteMessage(qa);
    expect(typeof msg).toBe("string");
    expect(msg).toContain("这个报错什么意思？");
    expect(msg).toContain("是路径不存在");
    expect(msg.split("\n").length).toBeGreaterThanOrEqual(2);
  });
});
