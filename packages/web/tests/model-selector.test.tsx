// ModelSelector — the composer's 模型 chip (用户反馈 2026-08-28: 模型选择的
// 弹窗太丑,不要用弹窗,应该像强度和模式一样弹出一个类似下拉列表的选择框).
// EffortSelector's dropdown mechanics verbatim: .pop + .menu + .mi/.on,
// outside pointerdown closes (refocus:false), Esc closes and refocuses the
// chip, every reopen starts fresh. The rows ride the status snapshot's /model
// matrix (same-provider → /model, cross-provider → /provider — the pick
// carries the provider so the caller routes the lane); the right pane's
// footer 设为默认 persists the session's CURRENT model as the boot default
// (the R6 Ctrl+S lane, made visible — the digit-buffer/arrow hotkeys retired
// with the modal; the TUI keeps /model <n>).
//
// 2026-08-31 用户反馈第三报(模型太多,一级下拉超出屏幕)→ 收进两级;同日
// 第四报把两级「钻入」否了 —— 选了供应商后供应商不该消失,要像下拉列表的
// 联动一样:菜单是 ONE surface,左列 .mroot 供应商(常驻,当前供应商 .on +
// 模型数),右列 .mpane 联动焦点家的模型行;click 与 hover 都联动;focus 为
// null 自动跟随当前供应商(打开即见自己家的模型);Esc 一层即关;两栏各自
// max-height + overflow-y 内滚,条目再多只滚动。
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../src/styles.css";
import { stylesCss } from "./styles-source.js";
import { decl } from "./css-test-utils.js";
import { ModelSelector } from "../src/components/ModelSelector.js";

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

const CHOICES = [
  { provider: "deepseek", model: "deepseek-v4-flash", source: "profile" },
  { provider: "deepseek", model: "deepseek-v4-think", source: "profile" },
  // 同名模型挂多供应商（用户反馈 2026-08-28 第二条）：deepseek-v4-flash 在
  // siliconflow 也有 —— 联动两栏下各供应商各有该行,各带自己的 lane。
  { provider: "siliconflow", model: "deepseek-v4-flash", source: "profile" },
  { provider: "glm", model: "glm-5", source: "profile" },
  { provider: "openrouter", model: "kimi-k3", source: "env" },
];

const openMenu = (el: React.ReactElement): HTMLElement =>
  openMenuOf(mount(el));

const openMenuOf = (c: HTMLElement): HTMLElement => {
  act(() => {
    c.querySelector<HTMLButtonElement>("button.chip")!.click();
  });
  return c;
};

/** 联动:点左列供应商行(不选、不关),右栏换成该家的模型。 */
const linkTo = (c: HTMLElement, provider: string): void => {
  act(() => {
    c.querySelector<HTMLButtonElement>(`.mroot .mi.mprov[data-provider="${provider}"]`)!.click();
  });
};

/** 右栏当前组头(联动焦点是谁)。 */
const focusedGroup = (c: HTMLElement): string | null =>
  c.querySelector<HTMLElement>(".mpane .mgroup")?.textContent ?? null;

describe("ModelSelector (the composer's 模型 chip — 联动两栏 dropdown)", () => {
  it("shows the current model label on the chip", () => {
    const c = mount(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={vi.fn()} />,
    );
    expect(c.querySelector("button.chip")?.textContent).toContain("deepseek-v4-flash");
    expect(c.querySelector(".menu")).toBeNull(); // closed by default
  });

  it("ONE surface: provider column STAYS; the right pane auto-follows the CURRENT provider on open (供应商不消失,打开即见自己家的模型)", () => {
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={vi.fn()} />,
    );
    // 左列:首现序供应商行 + 模型数徽记(deepseek 2 个,同名 flash 不重复计)。
    const provs = c.querySelectorAll<HTMLElement>(".mroot .mi.mprov");
    expect([...provs].map((r) => r.getAttribute("data-provider"))).toEqual([
      "deepseek", "siliconflow", "glm", "openrouter",
    ]);
    expect(provs[0]?.textContent).toContain("2 个模型");
    expect(provs[2]?.textContent).toContain("1 个模型");
    // 右栏:auto-follow 当前供应商 —— deepseek 组头 + 2 行模型,当前模型行 .on。
    expect(focusedGroup(c)).toBe("deepseek");
    const rows = c.querySelectorAll<HTMLElement>(".mpane .mi[data-model]");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.getAttribute("data-provider")).toBe("deepseek");
    expect(rows[0]?.textContent).toContain("deepseek-v4-flash");
    expect(rows[0]?.textContent).not.toContain("deepseek/deepseek-v4-flash");
    const on = c.querySelector<HTMLElement>(".mpane .mi.on");
    expect(on?.getAttribute("aria-checked")).toBe("true");
    expect(on?.getAttribute("data-model")).toBe("deepseek-v4-flash");
    // 当前供应商行 .on + aria-checked(左列)。
    const provOn = c.querySelector<HTMLElement>(".mroot .mi.on");
    expect(provOn?.getAttribute("aria-checked")).toBe("true");
    expect(provOn?.getAttribute("data-provider")).toBe("deepseek");
  });

  it("LINKING: clicking (or hovering) a provider row swaps ONLY the right pane — the provider column never leaves, no navigation rows, no commit", () => {
    const onPick = vi.fn();
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={onPick} />,
    );
    linkTo(c, "glm");
    // 左列还在(4 行原样),右栏换成 glm 的 1 行。
    expect(c.querySelectorAll(".mroot .mi.mprov")).toHaveLength(4);
    expect(focusedGroup(c)).toBe("glm");
    expect(c.querySelectorAll(".mpane .mi[data-model]")).toHaveLength(1);
    expect(c.querySelector(".mpane .mi[data-model]")?.getAttribute("data-model")).toBe("glm-5");
    // 联动焦点行 .mfoc(非当前供应商时)。
    expect(c.querySelector<HTMLElement>('.mroot .mi.mprov[data-provider="glm"]')?.classList.contains("mfoc")).toBe(true);
    expect(c.querySelector<HTMLElement>('.mroot .mi.mprov[data-provider="deepseek"]')?.classList.contains("mfoc")).toBe(false);
    // 没有钻入时代的返回行 —— 没有层可回。
    expect(c.querySelector(".mi.mback")).toBeNull();
    // 再换一家:同样只动右栏;点供应商行本身不选不关。
    linkTo(c, "siliconflow");
    expect(c.querySelectorAll(".mroot .mi.mprov")).toHaveLength(4);
    expect(focusedGroup(c)).toBe("siliconflow");
    expect(c.querySelector(".menu")).not.toBeNull();
    expect(onPick).not.toHaveBeenCalled();
    // hover(级联联动的另一半):mouseover 到 openrouter 行,右栏跟着换。
    act(() => {
      c
        .querySelector<HTMLElement>('.mroot .mi.mprov[data-provider="openrouter"]')!
        .dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(focusedGroup(c)).toBe("openrouter");
    expect(c.querySelector(".mpane .mi[data-model]")?.getAttribute("data-model")).toBe("kimi-k3");
    // env 徽记随行(位置推不出的信息才配占位)。
    expect(c.querySelector<HTMLElement>('.mpane .mi[data-model="kimi-k3"]')?.textContent).toContain("env");
  });

  it("CSS 契约：联动两栏 + 双栏各自内滚防溢出 + 焦点行底色（当前供应商优先 accent）+ 钻入遗产已删", () => {
    // 菜单一行两栏(row flex),本体不滚(overflow hidden)——滚动权在两栏。
    expect(decl(".pop .menu.model-menu", "display")).toBe("flex");
    expect(decl(".pop .menu.model-menu", "flex-direction")).toBe("row");
    expect(decl(".pop .menu.model-menu", "overflow")).toBe("hidden");
    // 两栏:max-height + overflow-y —— bottom 锚定的菜单条目再多也只滚动。
    for (const pane of [".mroot", ".mpane"]) {
      expect(decl(`.pop .menu.model-menu ${pane}`, "max-height")).toBe("min(24rem, 60vh)");
      expect(decl(`.pop .menu.model-menu ${pane}`, "overflow-y")).toBe("auto");
    }
    // 结构边界:左列右缘发丝线。
    expect(decl(".pop .menu.model-menu .mroot", "border-right")).toBe("1px solid var(--hair-1)");
    // 组头排版区分 = 大写 + 字距 + 更暗的 text-3(.lang-head 家族);结构区分 =
    // 非首组上沿发丝线。:not() 规则 jsdom CSSOM 的 selectorText 归一化后
    // decl() 匹配不到 —— 分隔线钉原文(no-page-scroll 伪元素同款先例)。
    expect(decl(".pop .menu.model-menu .mgroup", "text-transform")).toBe("uppercase");
    expect(decl(".pop .menu.model-menu .mgroup", "color")).toBe("var(--text-3)");
    expect(stylesCss).toContain(".pop .menu.model-menu .mgroup:not(:first-child)");
    expect(stylesCss.slice(stylesCss.indexOf(".pop .menu.model-menu .mgroup:not(:first-child)"))).toMatch(/border-top:\s*1px solid var\(--hair-1\)/);
    // 供应商行名加重;联动焦点行 hover 级底色,但 .on(当前供应商)优先 ——
    // :not(.on) 是契约本身,钉原文。
    expect(decl(".pop .menu.model-menu .mi.mprov .mlabel", "font-weight")).toBe("600");
    expect(stylesCss).toContain(".pop .menu.model-menu .mi.mprov.mfoc:not(.on)");
    expect(stylesCss.slice(stylesCss.indexOf(".pop .menu.model-menu .mi.mprov.mfoc:not(.on)"))).toMatch(/background:\s*var\(--surface-2\)/);
    // 钻入时代的返回行样式已随行删除。
    expect(stylesCss).not.toContain(".mback");
  });

  it("same model under multiple providers: link the OTHER provider and its row picks with THAT provider (the lane router needs the pair)", () => {
    const onPick = vi.fn();
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={onPick} />,
    );
    linkTo(c, "siliconflow");
    act(() => {
      c.querySelector<HTMLButtonElement>('.mpane .mi[data-model="deepseek-v4-flash"][data-provider="siliconflow"]')!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("deepseek-v4-flash", "siliconflow");
    expect(c.querySelector(".menu")).toBeNull(); // closed after commit
  });

  it("clicking a model row picks with model AND provider (the caller routes /model vs /provider) and closes; the cross lane stays in the title", () => {
    const onPick = vi.fn();
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={onPick} />,
    );
    linkTo(c, "glm");
    // 2026-08-29 用户反馈:「端点」两字多余 —— 组头已按供应商定位,行内不再
    // 重复;跨供应商 lane 说明保留在行 title 悬浮提示(点击仍走 /provider,
    // onPick 的 (model, provider) 对不变)。
    expect(c.querySelector(".menu")?.textContent).not.toContain("端点");
    const glmRow = c.querySelector<HTMLElement>('.mpane .mi[data-provider="glm"]');
    expect(glmRow?.getAttribute("title")).toContain("/provider glm");
    act(() => {
      c.querySelector<HTMLButtonElement>(".mi[data-model=\"glm-5\"]")!.click();
    });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("glm-5", "glm");
    expect(c.querySelector(".menu")).toBeNull(); // closed after commit
  });

  it("unknown current provider falls back to the FIRST provider in the right pane (右栏永不空)", () => {
    const c = openMenuOf(
      mount(<ModelSelector label="m" provider="not-in-matrix" choices={CHOICES} onPick={vi.fn()} />),
    );
    expect(focusedGroup(c)).toBe("deepseek");
  });

  it("empty matrix renders the Chinese placeholder row", () => {
    const c = openMenuOf(
      mount(<ModelSelector label="m" provider="deepseek" choices={[]} onPick={vi.fn()} />),
    );
    expect(c.querySelector(".menu")?.textContent).toContain("暂无可切换的模型");
  });

  it("the 设为默认 footer lives in the RIGHT pane: absent without the prop; present with it (any linked provider), fires once and closes", () => {
    const bare = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={vi.fn()} />,
    );
    expect(bare.querySelector(".mi.foot")).toBeNull();

    const onPersistDefault = vi.fn();
    const c = openMenu(
      <ModelSelector
        label="deepseek-v4-flash"
        provider="deepseek"
        choices={CHOICES}
        onPick={vi.fn()}
        onPersistDefault={onPersistDefault}
      />,
    );
    const foot = c.querySelector<HTMLButtonElement>(".mpane .mi.foot");
    expect(foot).not.toBeNull();
    expect(foot!.textContent).toContain("设为默认");
    // 联动到别家 footer 仍在 —— 它 persists 会话当前模型,与浏览到的供应商无关。
    linkTo(c, "glm");
    expect(c.querySelector(".mpane .mi.foot")).not.toBeNull();
    act(() => {
      c.querySelector<HTMLButtonElement>(".mi.foot")!.click();
    });
    expect(onPersistDefault).toHaveBeenCalledTimes(1);
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("Esc closes and refocuses the chip (ONE surface — 一层即关); an outside pointerdown closes without stealing focus", async () => {
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={vi.fn()} />,
    );
    const chip = c.querySelector<HTMLButtonElement>("button.chip")!;
    expect(c.querySelector(".menu")).not.toBeNull();
    linkTo(c, "glm");
    // 联动态下 Esc 直接关 —— 没有第二层可回。#456 (ω99-306): the refocus
    // is deferred one task past the keypress — flush before asserting.
    act(() => {
      c
        .querySelector<HTMLDivElement>(".pop")!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(c.querySelector(".menu")).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(document.activeElement).toBe(chip);

    act(() => {
      chip.click();
    });
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    act(() => {
      outside.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    });
    expect(c.querySelector(".menu")).toBeNull();
  });

  it("reopening always resets to the AUTO focus (当前供应商), not the last linked one (联动态不跨开合)", () => {
    const c = openMenu(
      <ModelSelector label="deepseek-v4-flash" provider="deepseek" choices={CHOICES} onPick={vi.fn()} />,
    );
    linkTo(c, "glm");
    // 选完模型菜单已关;重新打开回到自动焦点(当前供应商),不是上次的 glm。
    act(() => {
      c.querySelector<HTMLButtonElement>('.mpane .mi[data-model="glm-5"]')!.click();
    });
    expect(c.querySelector(".menu")).toBeNull();
    act(() => {
      c.querySelector<HTMLButtonElement>("button.chip")!.click();
    });
    expect(focusedGroup(c)).toBe("deepseek");
    expect(c.querySelectorAll(".mroot .mi.mprov")).toHaveLength(4);
  });
});
