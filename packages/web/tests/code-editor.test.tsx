// @vitest-environment jsdom
// 高亮/编辑 spec §4 —— CodeEditor: overlay 双层同步（textarea 值 ↔ 高亮层
// 文本）、Tab 两格、Esc 干净门、保存/放弃按钮态、冲突条两出口、滚动三联动。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CodeEditor } from "../src/components/CodeEditor.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
const mount = (el: React.ReactElement): HTMLElement => {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root?.render(el); });
  return container;
};
const rerender = (el: React.ReactElement): void => {
  act(() => { root?.render(el); });
};
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

/** React 18 受控 textarea 的原生改值惯例。 */
const setType = (ta: HTMLTextAreaElement, value: string): void => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(ta, value);
    ta.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const key = (ta: HTMLTextAreaElement, k: string): void => {
  act(() => { ta.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })); });
};

const fns = () => ({ onChange: vi.fn(), onSave: vi.fn(), onOverwrite: vi.fn(), onReopen: vi.fn(), onDiscard: vi.fn() });

const el = (value: string, dirty: boolean, h: ReturnType<typeof fns>, extra: Partial<Parameters<typeof CodeEditor>[0]> = {}) => (
  <CodeEditor
    path="src/a.ts"
    value={value}
    language="ts"
    dirty={dirty}
    saving={false}
    conflict={null}
    {...h}
    {...extra}
  />
);

describe("CodeEditor overlay（高亮 spec §4）", () => {
  it("双层同步：值渲染进高亮层，token span 存在；onChange 收新值后重渲染高亮层", () => {
    const h = fns();
    const c = mount(el("const a = 1;", false, h));
    const ta = c.querySelector("textarea.editor-ta") as HTMLTextAreaElement;
    const hl = c.querySelector("pre.editor-hl") as HTMLPreElement;
    expect(ta.value).toBe("const a = 1;");
    expect(hl.querySelector(".tok-key")?.textContent).toBe("const");
    setType(ta, "let a = 2;");
    expect(h.onChange).toHaveBeenCalledWith("let a = 2;");
    rerender(el("let a = 2;", true, h));
    expect((c.querySelector("pre.editor-hl") as HTMLPreElement).querySelector(".tok-key")?.textContent).toBe("let");
  });

  it("Tab 在光标处插两格（默认动作被拦）", () => {
    const h = fns();
    const c = mount(el("ab", false, h));
    const ta = c.querySelector("textarea.editor-ta") as HTMLTextAreaElement;
    act(() => { ta.setSelectionRange(1, 1); });
    const evt = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => { ta.dispatchEvent(evt); });
    expect(evt.defaultPrevented).toBe(true);
    expect(h.onChange).toHaveBeenCalledWith("a  b");
  });

  it("Esc 干净态退出；脏态忽略（离开脏文件必须点放弃）", () => {
    const hClean = fns();
    const c1 = mount(el("x", false, hClean));
    key(c1.querySelector("textarea.editor-ta") as HTMLTextAreaElement, "Escape");
    expect(hClean.onDiscard).toHaveBeenCalledTimes(1);
    const hDirty = fns();
    const c2 = mount(el("x", true, hDirty));
    key(c2.querySelector("textarea.editor-ta") as HTMLTextAreaElement, "Escape");
    expect(hDirty.onDiscard).not.toHaveBeenCalled();
  });

  it("保存按钮：干净或保存中禁用；点击触发 onSave", () => {
    const h = fns();
    const c = mount(el("x", false, h));
    const save = c.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    rerender(el("xy", true, h));
    const save2 = c.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(save2.disabled).toBe(false);
    act(() => { save2.click(); });
    expect(h.onSave).toHaveBeenCalledTimes(1);
    rerender(el("xy", true, h, { saving: true }));
    expect((c.querySelectorAll("button")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("冲突条：两出口回调；conflict null 时整条不渲染", () => {
    const h = fns();
    const c = mount(el("x", true, h, { conflict: "disk-truth" }));
    expect(c.querySelector(".fv-conflict")).not.toBeNull();
    const btns = c.querySelectorAll(".fv-conflict button");
    act(() => { (btns[0] as HTMLButtonElement).click(); });
    expect(h.onReopen).toHaveBeenCalledWith("disk-truth");
    act(() => { (btns[1] as HTMLButtonElement).click(); });
    expect(h.onOverwrite).toHaveBeenCalledTimes(1);
    rerender(el("x", true, h, { conflict: null }));
    expect(c.querySelector(".fv-conflict")).toBeNull();
  });

  it("滚动三联动：textarea 滚动驱动高亮层与 gutter", () => {
    const h = fns();
    const c = mount(el("l1\nl2\nl3\nl4\nl5", false, h));
    const ta = c.querySelector("textarea.editor-ta") as HTMLTextAreaElement;
    const hl = c.querySelector("pre.editor-hl") as HTMLPreElement;
    const gutter = c.querySelector(".editor-gutter") as HTMLDivElement;
    act(() => {
      ta.scrollTop = 16;
      ta.scrollLeft = 4;
      ta.dispatchEvent(new Event("scroll"));
    });
    expect(hl.scrollTop).toBe(16);
    expect(hl.scrollLeft).toBe(4);
    expect(gutter.scrollTop).toBe(16);
  });
});
