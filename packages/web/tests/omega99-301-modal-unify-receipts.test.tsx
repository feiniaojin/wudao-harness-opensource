// @vitest-environment jsdom
// ω99-301 — 弹层家族统一收据（v5 弧7，M16）。T14 当年留了遗民：ClearConfirm/
// App 新对话 confirm 走 legacy .overlay/.modal，ChangesPanel/ComputerActionsPanel/
// PersonaPanel/ModelConfigModal/Wizard Esc-confirm 混用两套词汇。本弧七点全数
// re-shell 到唯一家族 .scrim > .modal-card.pop-in，legacy 规则对整体退役删除
// ——弹层一套词汇、一条宽度纪律（480px 卡帽；宽卡走 .mcm 620px 先例覆写）。
// 宽度 delta 入档：confirm 卡 640→480（家族标准），两面板 640→620（宽卡
// idiom）；动效零变（.modal 的 pop 内联与 .pop-in 同一 keyframe 同参）。
// Wizard 的 Esc 确认骑 .scrim.wizard-confirm（z 阶梯 wizard+1 覆写保留）。
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import "../src/styles.css";
import { ClearConfirm } from "../src/components/ClearConfirm.js";
import { mount, unmount } from "./css-test-utils.js";
import { decl } from "./css-test-utils.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(unmount);

describe("ω99-301 弹层家族统一收据", () => {
  it("CSSOM: legacy .overlay/.modal 规则零残留——弹层只说一套词汇", () => {
    const legacy: string[] = [];
    for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
      for (const rule of [...sheet.cssRules]) {
        if (!(rule instanceof CSSStyleRule)) continue;
        // Standalone .modal/.overlay tokens only — .modal-card/.pvd-overlay
        // etc. are the living family (substring-safe, dot-anchored).
        if (/(^|[\s,])\.modal([\s,:{.]|$)/.test(rule.selectorText)) legacy.push(rule.selectorText);
        if (/(^|[\s,])\.overlay([\s,:{.]|$)/.test(rule.selectorText)) legacy.push(rule.selectorText);
      }
    }
    expect(legacy).toEqual([]);
  });

  it("家族契约钉：scrim 携 per-theme token + z 阶梯；卡帽 480px；宽卡 620px idiom", () => {
    expect(decl(".scrim", "background")).toBe("var(--overlay)");
    expect(decl(".scrim", "z-index")).toBe("var(--z-modal)");
    expect(decl(".scrim", "padding")).toBe("var(--sp-4)");
    expect(decl(".modal-card", "max-width")).toBe("480px");
    expect(decl(".modal-card", "border-radius")).toBe("var(--radius-lg)");
    // 宽卡覆写（.mcm 先例）：两面板不被 480 基帽挤窄。
    expect(decl(".modal-card.changes-panel", "max-width")).toBe("620px");
    expect(decl(".modal-card.computer-panel", "max-width")).toBe("620px");
    expect(decl(".modal-card.mcm", "max-width")).toBe("620px");
    // Wizard 的 Esc 确认：家族 scrim + wizard 阶梯覆写（坐在向导大overlay 之上）。
    expect(decl(".scrim.wizard-confirm", "z-index")).toBe("calc(var(--z-wizard) + 1)");
  });

  it("DOM: ClearConfirm 骑 .scrim > .modal-card.pop-in[role=dialog]；无 .overlay/.modal 节点（防还魂）", () => {
    let chose: boolean | null = null;
    const c = mount(<ClearConfirm onChoose={(yes) => (chose = yes)} />);
    const card = c.querySelector(".scrim > .modal-card.pop-in") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("清空历史");
    expect(c.querySelector(".overlay")).toBeNull();
    expect(c.querySelector(".modal")).toBeNull();
    expect(c.querySelectorAll(".modal-card").length).toBe(1);
    // 家族缝完整：h3 + .muted（.modal-card h3/.muted 孪生在位）+ .btnrow。
    expect(card.querySelector("h3")?.textContent).toContain("清空历史");
    expect(card.querySelector(".muted")).not.toBeNull();
    expect(card.querySelector(".btnrow .wudao.danger")?.textContent).toContain("清空");
    // 键盘契约零变：Enter 走安全路（保留）。
    act(() => {
      card.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(chose).toBe(false);
  });

  it("动效零变：.pop-in 与被退役的 .modal 内联同参（med 档 + 统一缓动）", () => {
    expect(decl(".pop-in", "animation")).toBe("pop var(--dur-med) var(--ease)");
    expect(decl(".scrim", "animation")).toBe("fade var(--dur-med) var(--ease)");
  });
});
