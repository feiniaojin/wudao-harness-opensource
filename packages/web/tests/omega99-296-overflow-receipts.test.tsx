// @vitest-environment jsdom
// ω99-296 — 溢出三修收据（v5 弧2）。三处同病：省略号「声明了但从不生
// 效」的静默失效 —— I1 模型胶囊把 text-overflow 写在 inline-flex 容器上
// （对 flex 项是死代码，只硬切）；I2 活动卡 file/tail 缺 min-width:0（min-
// content 地板让 ellipsis 永不触发）且 tail flex:none 不缩；I3 statusline
// goal 段是裸 span（条带硬切）。jsdom 不做布局，几何省略不可断言；钉的
// 是配方声明（CSSOM 解析真值）+ 胶囊 DOM 结构（label 有专属可缩项、
// title 兑现全名承诺）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { InputBox } from "../src/components/InputBox.js";
import "../src/styles.css";
import { decl } from "./css-test-utils.js";

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

describe("ω99-296 溢出三修收据", () => {
  it("I1: 模型胶囊的省略号活在 .chip-label 可缩项上（容器死代码已删）", () => {
    expect(decl(".chip.model .chip-label", "min-width")).toBe("0");
    expect(decl(".chip.model .chip-label", "overflow")).toBe("hidden");
    expect(decl(".chip.model .chip-label", "text-overflow")).toBe("ellipsis");
    expect(decl(".chip.model .caret", "flex")).toBe("none");
  });

  it("I1 (DOM): label 落在专属 flex 项，title 携带全名（12rem 帽下不丢读）", () => {
    const c = mount(
      <InputBox
        busy={false}
        mode="workspace"
        commands={[]}
        connected={true}
        onSubmit={vi.fn()}
        onInterrupt={vi.fn()}
        onShield={vi.fn()}
        onCycleMode={vi.fn()}
        modelLabel="deepseek-chat-v3.1-0125-preview"
        modelProvider="deepseek"
        modelChoices={[{ provider: "deepseek", model: "deepseek-chat-v3.1-0125-preview", source: "registry" }]}
        onPickModel={vi.fn()}
      />,
    );
    const chip = c.querySelector<HTMLButtonElement>(".composer-tools .chip.model")!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector(".chip-label")?.textContent).toBe("deepseek-chat-v3.1-0125-preview");
    expect(chip.querySelector(".caret")).not.toBeNull();
    expect(chip.title).toContain("deepseek-chat-v3.1-0125-preview");
  });

  it("I2: 活动卡 file/tail 补 min-width:0 地板 + ellipsis 三件套（tail 弃 flex:none）", () => {
    expect(decl(".act-file", "min-width")).toBe("0");
    expect(decl(".act-file", "text-overflow")).toBe("ellipsis");
    expect(decl(".act-tail", "min-width")).toBe("0");
    expect(decl(".act-tail", "white-space")).toBe("nowrap");
    expect(decl(".act-tail", "overflow")).toBe("hidden");
    expect(decl(".act-tail", "text-overflow")).toBe("ellipsis");
  });

  it("I3: statusline goal 段是唯一可缩段（三件套）", () => {
    expect(decl(".statusline .seg-goal", "min-width")).toBe("0");
    expect(decl(".statusline .seg-goal", "overflow")).toBe("hidden");
    expect(decl(".statusline .seg-goal", "text-overflow")).toBe("ellipsis");
  });
});
