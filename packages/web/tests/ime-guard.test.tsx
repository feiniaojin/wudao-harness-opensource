// @vitest-environment jsdom
// ω99-151 — IME 组合期键盘守卫（RED-first）。A 层 ime-guard.ts 的确定性
// 矩阵（窄接口：事件只取 isComposing/keyCode，测试传普通对象；时间窗传
// 显式 now）+ InputBox 接线钉（vi 假钟钉死 Date.now：组合结束后 50ms 的
// Safari 假 Enter 必吞、走满 100ms 的真 Enter 必放）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "../src/components/ime-guard.js";

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

/** 既有套同款的原型 setter 打字（绕过 React 受控 value 的只读护栏）。 */
const type = (el: HTMLTextAreaElement | HTMLInputElement, text: string): void => {
  const proto =
    el instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
};

/** keydown：isComposing/keyCode 走 KeyboardEventInit（jsdom 亲证支持）。 */
const key = (el: HTMLElement, k: string, isComposing = false): void => {
  el.dispatchEvent(
    new KeyboardEvent("keydown", { key: k, isComposing, bubbles: true, cancelable: true }),
  );
};

/** 组合事件（onCompositionStart/End 是 React 标准回调；jsdom 有构造器）。 */
const compose = (el: HTMLElement, phase: "compositionstart" | "compositionend"): void => {
  el.dispatchEvent(new CompositionEvent(phase, { bubbles: true }));
};

const ST0: ImeGuardState = { composing: false, endedAt: 0 };

describe("ω99-151 ime-guard 纯函数层", () => {
  it("事件自证组合（isComposing=true / keyCode=229）→ 吞，与状态无关", () => {
    expect(imeSwallows({ isComposing: true, keyCode: 13 }, ST0, 1_000)).toBe(true);
    expect(imeSwallows({ isComposing: false, keyCode: 229 }, ST0, 1_000)).toBe(true);
  });

  it("状态 composing=true → 吞（compositionend 未到，事件旗标可能缺失）", () => {
    expect(imeSwallows({ isComposing: false, keyCode: 13 }, imeStart(ST0), 1_000)).toBe(true);
  });

  it("imeStart/imeEnd 不可变更新；endedAt=0 表示从未组合", () => {
    const started = imeStart(ST0);
    expect(started).toEqual({ composing: true, endedAt: 0 });
    expect(ST0).toEqual({ composing: false, endedAt: 0 }); // 原状态不被改写
    const ended = imeEnd(started, 5_000);
    expect(ended).toEqual({ composing: false, endedAt: 5_000 });
    expect(started).toEqual({ composing: true, endedAt: 0 }); // 不可变：start 不被 end 改
  });

  it("组合结束后 <100ms → 吞（Safari compositionend 后的假 Enter 窗）", () => {
    expect(imeSwallows({ isComposing: false, keyCode: 13 }, { composing: false, endedAt: 5_000 }, 5_099)).toBe(true);
  });

  it("组合结束后 ≥100ms → 放行；从未组合 → 放行", () => {
    expect(imeSwallows({ isComposing: false, keyCode: 13 }, { composing: false, endedAt: 5_000 }, 5_100)).toBe(false);
    expect(imeSwallows({ isComposing: false, keyCode: 13 }, ST0, 999_999)).toBe(false);
  });
});

const BASE = {
  busy: false,
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn().mockResolvedValue(true),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

describe("ω99-151 InputBox 接线（假钟钉死 Date.now）", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-07T08:00:00Z"));
  });
  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("组合中 Enter（isComposing=true）→ 不提交、缓冲不动；组合结束 1s 后的 Enter 恢复提交", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BASE} onSubmit={onSubmit} />);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    act(() => {
      type(ta, "nihao");
      compose(ta, "compositionstart");
      key(ta, "Enter", true);
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ta.value).toBe("nihao"); // 半成品不出门
    // 组合结束（+1s，已出 100ms 窗）后的真 Enter 恢复提交——吞的是组合，不是输入面。
    vi.setSystemTime(new Date("2026-09-07T08:00:01Z"));
    act(() => {
      compose(ta, "compositionend");
    });
    vi.setSystemTime(new Date("2026-09-07T08:00:02Z"));
    act(() => {
      key(ta, "Enter");
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith("nihao");
  });

  it("compositionend 后 50ms 的假 Enter（isComposing=false）→ 不提交（Safari/WKWebView 窗）", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BASE} onSubmit={onSubmit} />);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    act(() => {
      type(ta, "nihao");
      compose(ta, "compositionstart");
      compose(ta, "compositionend"); // endedAt=08:00:00
    });
    // Safari 怪癖：确认组合的那次 Enter 在 compositionend 之后才到且旗标
    // 已清——只查 isComposing 必漏，靠 endedAt 时间窗兜住。
    vi.setSystemTime(new Date("2026-09-07T08:00:00.050Z"));
    act(() => {
      key(ta, "Enter");
    });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(ta.value).toBe("nihao");
  });

  it("compositionend 后走满 100ms 的 Enter → 正常提交", () => {
    const onSubmit = vi.fn().mockResolvedValue(true);
    const c = mount(<InputBox {...BASE} onSubmit={onSubmit} />);
    const ta = c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;
    act(() => {
      type(ta, "你好");
      compose(ta, "compositionstart");
      compose(ta, "compositionend");
    });
    vi.setSystemTime(new Date("2026-09-07T08:00:00.100Z")); // 恰 100ms：窗已关
    act(() => {
      key(ta, "Enter");
    });
    expect(onSubmit).toHaveBeenCalledWith("你好");
  });
  // ω99-203: #5 — 吩咐加颗小框 it 随常用吩咐行整族退役（前 8 it 主 textarea IME 全留）。
});
