// @vitest-environment jsdom
// ω99-302 — 死规则清点收据（v5 弧8）。全 token 死类清点（选择器头全列
// 提取，非仅行首 token——.model-chip, .effort-chip 复合行里的第二个选择器
// 旧清点法永远看不见）+ 孤儿令牌清点（tokens.css 22 唯一令牌零孤儿）+
// pet.css 全 token 清点（41 类零死）三轴清完，styles.css 四处死物退役：
// ① .effort-row 底座规则——其辩解注释（「EffortSelector 用它」）是谎，
// 组件实际乘坐 .pop/.chip/.menu；② .effort-chip——0.3.26 ① 删推理档
// strip 后复合选择器里的遗民（.model-chip 活着，Wizard 唯一渲染点）；
// ③ .model-chip:disabled——唯一渲染点从不 disabled；④ .statusline
// .seg-btn 三块——M57 可点模型段随 ω99-298 M14 状态栏模型/模式段退役而
// 死（components.test:849 的零节点墓碑钉为证）。活类零视觉变化。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import "../src/styles.css";

describe("ω99-302 死规则清点收据", () => {
  it("CSSOM: 四名死选择器零残留——.effort-row/.effort-chip/.seg-btn/.model-chip:disabled", () => {
    const dead: string[] = [];
    for (const sheet of [...document.styleSheets] as CSSStyleSheet[]) {
      for (const rule of [...sheet.cssRules]) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (/\.effort-row|\.effort-chip|\.seg-btn/.test(rule.selectorText)) dead.push(rule.selectorText);
        // :disabled 直钉（substring 形——.model-chip:hover:not(:disabled)
        // 是活规则，不含 "model-chip:disabled" 连续字面）。
        if (rule.selectorText.includes("model-chip:disabled")) dead.push(rule.selectorText);
      }
    }
    expect(dead).toEqual([]);
  });

  it("全表零字面：styles.css 文本不再出现 effort-row（规则与撒谎的辩解注释同灭）", () => {
    // jsdom rewrites import.meta.url — process.cwd() 是包根（ω99-169 范式）。
    const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(css.includes("effort-row")).toBe(false);
  });

  it("活类背书钉：被清点表证实的消费面仍有规则底座（防退役过界）", () => {
    const selectors = [...document.styleSheets]
      .flatMap((s) => [...(s as CSSStyleSheet).cssRules])
      .filter((r): r is CSSStyleRule => r instanceof CSSStyleRule)
      .map((r) => r.selectorText)
      .join("\n");
    // EffortSelector 的活类族（旧底座谎称的「使用者」真实词汇）。\n 属边界
    // （selectors 用换行 join，token 常居 selectorText 末位）。
    for (const c of ["pop", "chip", "caret", "menu", "mi", "mlabel", "mf"]) {
      expect(selectors, `.${c}`).toMatch(new RegExp(`\\.${c}([ .:,)\\n]|\\{|$)`));
    }
    // 条件修饰族：选中档 .chip.sel（复合组规）与 .pop .mi.on。
    expect(selectors).toMatch(/\.chip\.sel/);
    expect(selectors).toMatch(/\.pop \.mi\.on/);
    // statusline 活段（seg-btn 的活亲戚，一个不能少）。seg-ctx 除外——它是
    // 纯语义钩（样式全继承 .statusline 基座，测试以其为 DOM 锚），by-design
    // 无自有规则，不进背书钉。
    for (const c of ["seg-branch", "seg-goal", "seg-busy"]) {
      expect(selectors, `.${c}`).toMatch(new RegExp(`\\.${c}([ .:,)\\n]|\\{|$)`));
    }
    // Wizard 的 model-chip 复合底座仍在（shell-visual 另钉 font-family 值）。
    expect(selectors).toMatch(/(^|[\s,])\.model-chip([\s,:{.]|$)/);
  });
});
