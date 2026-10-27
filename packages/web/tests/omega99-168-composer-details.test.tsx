// @vitest-environment jsdom
// ω99-168 — composer 首启/运行中细节（UI 自审弧）：
// ① busy placeholder fallback 中文化——App 只传 idlePlaceholder（轮换
//    tip），busy 臂长期走 InputBox 自带 fallback，改前生产可见英文
//    "steer the running agent… (⏳ on send)"。
// ② idle fallback 同步中文（生产被 App 覆盖，但直挂测试/未来调用方
//    不该再拿到英文缺省）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";

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
beforeEach(() => {
  localStorage.clear();
});

const BASE = {
  mode: "workspace" as const,
  commands: [],
  connected: true,
  onSubmit: vi.fn().mockResolvedValue(true),
  onInterrupt: vi.fn(),
  onShield: vi.fn(),
  onCycleMode: vi.fn(),
};

const flush = async (n = 2): Promise<void> => {
  for (let i = 0; i < n; i += 1) {
    await act(async () => {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    });
  }
};

const textareaOf = (c: HTMLElement): HTMLTextAreaElement =>
  c.querySelector("textarea.wudao-input") as HTMLTextAreaElement;

describe("ω99-168 — composer 细节（placeholder fallback 中文化）", () => { // ω99-203: #4 — 0 颗带字 pill 两 it 随常用吩咐行整族退役，describe 标题去半句
  it("busy 臂 fallback 为中文（生产可见臂——App 不传 busyPlaceholder）", async () => {
    const c = mount(<InputBox {...BASE} busy={true} />);
    await flush();
    expect(textareaOf(c).placeholder).toBe("它在忙，可继续打字插话（发送「排队」）");
    // 负钉：旧英文 fallback 归零。
    expect(textareaOf(c).placeholder).not.toContain("steer the running");
  });

  it("idle 臂 fallback 为中文（直挂/未来调用方的缺省不再是英文）", async () => {
    const c = mount(<InputBox {...BASE} busy={false} />);
    await flush();
    expect(textareaOf(c).placeholder).toBe("吩咐悟道——/ 选命令，@ 引用文件");
    expect(textareaOf(c).placeholder).not.toContain("ask wudao");
  });

  it("idle 臂仍尊重传入的 idlePlaceholder（App 轮换 tip 优先于 fallback）", async () => {
    const c = mount(<InputBox {...BASE} busy={false} idlePlaceholder="描述任务，或 /help 查看命令" />);
    await flush();
    expect(textareaOf(c).placeholder).toBe("描述任务，或 /help 查看命令");
  });
});
