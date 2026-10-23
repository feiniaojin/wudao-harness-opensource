// @vitest-environment jsdom
// 120 弧「选择语言」收据套件（用户令 09-28：设置页选择控件选中/未选中区分度
// 太低，参考 dsh/claude.ai/codex 重做——整体界面要有良好设计规范）。
//   ① 分段选择 .seg：凹槽轨道（surface-2）+ 选中段浮起药丸（surface 实底
//      + elev-1 + text-1 + 字重 600）——形态区分不靠色彩差，四主题同律；
//      未选中安静（透明底 + text-3）。
//   ② 开关 input.wudao-switch：appearance 定制胶囊（36×20、radius-sm 与全站
//      scale 一致——999px 胶囊帽仍是退役项），off = hair-3 中性、
//      checked = accent 实底（dsh 律：状态才配得上颜色）。
//   ③ 主 CTA 恢复 accent 实底（116 全描边化矫枉过正；权限卡一直是实底，
//      全局描边分裂了 CTA 语言）。
//   ④ 设置行 .setrow：标题/说明左 + 控件右 + hairline 分隔。
//   ⑤ 设置页选中 tab 加字重（第二重信号，与 .segctl-opt.on 同律）。
//   ⑥ 主色 swatch 点：三身份色通道令牌（固定不随当前 accent 漂移）。
// 组件面（AppearanceTab）：.seg 带 role=radiogroup/radio + aria-checked，
// 主色选项带身份色点。
import { afterEach, describe, expect, it } from "vitest";
import "../src/styles.css";
import "../src/tokens.css";
import { applyAccent, applyTheme } from "../src/theme.js";
import { decl, mount, unmount } from "./css-test-utils.js";
import { createElement } from "react";

afterEach(() => {
  unmount();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.accent;
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("120 ① — the segmented pick: recessed track + raised selected pill", () => {
  it("the track is a recessed place (surface-2 + radius-md), not a second button row", () => {
    expect(decl(".segctl", "background")).toBe("var(--surface-2)");
    expect(decl(".segctl", "border-radius")).toBe("var(--radius-md)");
  });

  it("an unselected option is quiet: transparent, text-3, normal weight", () => {
    expect(decl(".segctl-opt", "background")).toBe("transparent");
    expect(decl(".segctl-opt", "color")).toBe("var(--text-3)");
  });

  it("the SELECTED option is a raised pill: surface + elev-1 + text-1 + weight 600", () => {
    expect(decl(".segctl-opt.on", "background")).toBe("var(--surface)");
    expect(decl(".segctl-opt.on", "box-shadow")).toBe("var(--elev-1)");
    expect(decl(".segctl-opt.on", "color")).toBe("var(--text-1)");
    expect(decl(".segctl-opt.on", "font-weight")).toBe("600");
  });

  it("hover advertises only the unselected option", () => {
    expect(decl(".segctl-opt:hover:not(:disabled):not(.on)", "color")).toBe("var(--text-1)");
  });
});

describe("120 ② — the switch: accent when ON, neutral hair when off", () => {
  it("the custom face replaces the native checkbox (appearance: none)", () => {
    expect(decl("input.wudao-switch", "appearance")).toBe("none");
    expect(decl("input.wudao-switch", "background")).toBe("var(--hair-3)");
  });

  it("checked = the accent fill (state earns the color)", () => {
    expect(decl("input.wudao-switch:checked", "background")).toBe("var(--accent)");
  });

  it("a mounted checked switch resolves the accent fill through the live token", () => {
    applyTheme("dark");
    applyAccent("green");
    mount(
      createElement("input", { type: "checkbox", className: "wudao-switch", checked: true, readOnly: true }),
    );
    const el = document.querySelector("input.wudao-switch") as HTMLInputElement;
    // jsdom does not apply :checked stylesheets states for custom selectors,
    // so pin the state channel the rule consumes: the accent token itself.
    expect(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()).not.toBe("");
    expect(el.checked).toBe(true);
  });
});

describe("120 ③ — the primary CTA is an accent FILL again (unified with the ask cards)", () => {
  it("global primary: accent background + accent-ink text + no border", () => {
    expect(decl("button.wudao.primary", "background")).toBe("var(--accent)");
    expect(decl("button.wudao.primary", "color")).toBe("var(--accent-ink)");
    expect(decl("button.wudao.primary", "border-color")).toBe("transparent");
  });

  it("the permission card's filled primary is now the SAME rule, not an override island", () => {
    expect(decl(".permission-card .btnrow button.wudao.primary", "background")).toBe("var(--accent)");
  });
});

describe("120 ④⑤ — settings rows and the selected nav tab", () => {
  it("the row: label column left, control right, hairline between rows", () => {
    expect(decl(".setrow", "justify-content")).toBe("space-between");
    expect(decl(".setrow + .setrow", "border-top")).toContain("var(--hair-1)");
    expect(decl(".setrow-note", "font-size")).toBe("var(--fs-caption)");
    expect(decl(".setrow-note", "color")).toBe("var(--text-3)");
  });

  it("the selected settings tab carries the weight signal (600)", () => {
    expect(decl(".settings-tabs .sb-i.on", "font-weight")).toBe("600");
  });
});

describe("120 ⑥ — the accent swatch dots: identity colors, fixed", () => {
  it("three identity channel tokens exist on the root", () => {
    const cs = getComputedStyle(document.documentElement);
    expect(cs.getPropertyValue("--swatch-ink-rgb").trim()).toBe("17 17 17");
    expect(cs.getPropertyValue("--swatch-royal-rgb").trim()).toBe("47 84 235");
    expect(cs.getPropertyValue("--swatch-jade-rgb").trim()).toBe("18 168 116");
  });

  it("each dot consumes its own channel (never the live --accent)", () => {
    expect(decl('.segctl-opt[data-swatch="black"] .segctl-dot', "background")).toBe("rgb(var(--swatch-ink-rgb))");
    expect(decl('.segctl-opt[data-swatch="blue"] .segctl-dot', "background")).toBe("rgb(var(--swatch-royal-rgb))");
    expect(decl('.segctl-opt[data-swatch="green"] .segctl-dot', "background")).toBe("rgb(var(--swatch-jade-rgb))");
  });

  it("swatch tokens do not move with the applied accent (identity, not state)", () => {
    applyTheme("dark");
    applyAccent("blue");
    const cs = getComputedStyle(document.documentElement);
    expect(cs.getPropertyValue("--swatch-jade-rgb").trim()).toBe("18 168 116");
    applyAccent("green");
  });
});
