// ω99-212: #R — 权限失败引导卡 receipts。错误串→引导卡映射（cli 层的机器
// 标记 → web 只渲染）；重试按钮回调。零网络零 Tauri——纯渲染面。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import type { ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { computerPermGuideFor, ComputerPermGuide } from "../src/components/ComputerPermGuide.js";
import { HistoryItem } from "../src/components/HistoryList.js";
import type { HistoryEntry } from "../src/protocol.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: ReactElement): HTMLElement => {
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

// ---------------------------------------------------------------------------
// §6a 错误串 → 引导映射（纯函数）
// ---------------------------------------------------------------------------
describe("ω99-212 §6 — computerPermGuideFor 映射", () => {
  it("辅助功能标记（-1743 语义）→ accessibility 引导（系统设置路径文案）", () => {
    const g = computerPermGuideFor("computer.type: [wudao-perm:accessibility] 不允许辅助访问 (-1743)");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("accessibility");
    expect(g!.steps.some((s) => s.includes("辅助功能"))).toBe(true);
    expect(g!.retryText).not.toBe("");
  });

  it("屏幕录制标记（截屏空图语义）→ screen-recording 引导", () => {
    const g = computerPermGuideFor("screen.capture: [wudao-perm:screen-recording] 截屏为空");
    expect(g).not.toBeNull();
    expect(g!.kind).toBe("screen-recording");
    expect(g!.steps.some((s) => s.includes("屏幕录制"))).toBe(true);
  });

  it("普通错误 → null（不渲染引导卡）", () => {
    expect(computerPermGuideFor("普通失败：syntax error")).toBeNull();
    expect(computerPermGuideFor("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §6b 引导卡渲染 + 重试按钮回调
// ---------------------------------------------------------------------------
describe("ω99-212 §6 — ComputerPermGuide 渲染", () => {
  it("引导卡渲染步骤 + 重试按钮触发回调（带重试指令文本）", async () => {
    const onRetry = vi.fn();
    const c = mount(
      <ComputerPermGuide
        text={"computer.type 出错：[wudao-perm:accessibility] 不允许辅助访问 (-1743)"}
        onRetry={onRetry}
      />,
    );
    expect(c.textContent).toContain("辅助功能");
    const btn = c.querySelector<HTMLButtonElement>("button.perm-retry");
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
    const arg = onRetry.mock.calls[0]![0];
    expect(typeof arg).toBe("string");
    expect(arg.length).toBeGreaterThan(0);
  });

  it("无回调时只渲染步骤（无按钮）——降级诚实", () => {
    const c = mount(<ComputerPermGuide text={"[wudao-perm:screen-recording] 空"} />);
    expect(c.textContent).toContain("屏幕录制");
    expect(c.querySelector("button.perm-retry")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §6c 挂载点：HistoryItem 的错误工具卡内嵌引导
// ---------------------------------------------------------------------------
describe("ω99-212 §6 — HistoryItem 挂载", () => {
  const errEntry: HistoryEntry = {
    kind: "tool",
    name: "computer.type",
    summary: "",
    isError: true,
    resultPreview: "computer.type: [wudao-perm:accessibility] 不允许辅助访问 (-1743)",
  } as HistoryEntry;

  it("错误工具条目携带标记 → 引导卡渲染在结果行下", () => {
    const onAction = vi.fn();
    const c = mount(<HistoryItem entry={errEntry} onAction={onAction} />);
    expect(c.textContent).toContain("辅助功能");
    expect(c.querySelector("button.perm-retry")).not.toBeNull();
  });

  it("无标记的错误工具条目 → 不渲染引导卡（零面变化）", () => {
    const plain: HistoryEntry = { ...errEntry, resultPreview: "普通错误" } as HistoryEntry;
    const c = mount(<HistoryItem entry={plain} />);
    expect(c.querySelector(".perm-guide")).toBeNull();
  });
});
