// @vitest-environment jsdom
// ω99-300 — 令牌扫尾收据（v5 弧6）。styles.css 全表令牌化收口：
// M2 字号字面（12.5px→--fs-ui 61 处、11px→--fs-caption）归零；M3 间距
// 「全分量皆令牌才转」100 处（4px 6px 类混血留字面=有意的非栅格例外）；
// M8 line-height 1.55 归队 --lh-body（1.45/1.5/1.6/1.65 是有意 one-off
// 布局值，不动）。池项订正：M1 pill 双写=不存在（--radius-pill 恰在
// tokens.css 定义一次，styles.css 只消费）；M6 synthetic 11.5px=不存在。
// 钉法：全 CSSOM 扫描（挂载真表后逐规则读声明）——字面残余零、间距
// 混血零、pill 单源。
import { describe, expect, it } from "vitest";
import "../src/styles.css";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FlatRule {
  selector: string;
  props: Record<string, string>;
}
const flatRules = (): FlatRule[] => {
  const out: FlatRule[] = [];
  for (const sheet of document.styleSheets) {
    const rules = [...(sheet.cssRules ?? [])];
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        // jsdom's cssstyle lacks .item() — enumerate via cssText (the
        // flow-visual red-discipline seam's own precedent).
        const props: Record<string, string> = {};
        for (const d of rule.style.cssText.split(";")) {
          const idx = d.indexOf(":");
          if (idx <= 0) continue;
          props[d.slice(0, idx).trim()] = d.slice(idx + 1).trim();
        }
        out.push({ selector: rule.selectorText, props });
      }
    }
  }
  return out;
};

const SP_PROPS = /^(padding|margin|gap|row-gap|column-gap|padding-(top|right|bottom|left)|margin-(top|right|bottom|left))$/;

describe("ω99-300 令牌扫尾收据", () => {
  it("M2: 字号字面归零——全表无 12.5px/11px 档的裸 font-size 声明（五档皆 var 形）", () => {
    const offenders = flatRules()
      .filter((r) => r.props["font-size"] === "12.5px" || r.props["font-size"] === "11px")
      .map((r) => `${r.selector}: ${r.props["font-size"]}`);
    expect(offenders).toEqual([]);
  });

  it("M3: 混血白名单 census——token×字面并存仅限先在的 1px 光学发丝线族（新混血即红）；calc 表达式豁免（令牌导出非混血）", () => {
    const offenders = flatRules()
      .flatMap((r) =>
        Object.entries(r.props)
          .filter(([p]) => SP_PROPS.test(p))
          .filter(([, v]) => !v.includes("calc("))
          .filter(([, v]) => /var\(--sp-/.test(v) && /[0-9]px/.test(v))
          .map(([p, v]) => `${r.selector} ${p}: ${v}`),
      )
      .sort();
    // 1px 竖向是 12px 级小钮的光学发丝线，不在 sp 栅格（同 10px 14px 气泡
    // 垫的白名单家族）；本弧前已是半令牌形态，census 钉死集合防新增。
    // （.mcm-opt 的 4px 分量已在弧内补全为 var(--sp-1)——全令牌，不入册。）
    // ω99-317（0.3.91 gate 清偿随源入册）：schedules 面板 .sch-act/.sch-badge
    // 两名——1px 竖向发丝线同族（.sch-act 原 2px 破栅格，已修为 1px 发丝形）。
    expect(offenders).toEqual([
      ".fv-selchip padding: 1px var(--sp-1)",
      ".provider-card button.card-apply padding: 1px var(--sp-3)",
      ".provider-detail .model-row .model-use padding: 1px var(--sp-2)",
      ".sb-i .sb-act, .sb-arch-i .sb-act padding: 1px var(--sp-1)",
      ".sb-i .sb-rename padding: 1px var(--sp-1)",
      ".sch-act padding: 1px var(--sp-2)",
      ".sch-badge padding: 1px var(--sp-2)",
      ".search-pop .session-item .session-del padding: 1px var(--sp-1)",
    ]);
  });

  it("M3: 无可转残余——任何 var/calc-free 的间距声明不再有「全分量皆 0/栅格值」的组合（纯 0 声明无 sp-0 令牌、本就极简，不算残余）", () => {
    const SP_LITERALS = new Set(["0", "4px", "8px", "12px", "16px", "20px", "24px", "32px"]);
    const offenders = flatRules()
      .flatMap((r) =>
        Object.entries(r.props)
          .filter(([p]) => SP_PROPS.test(p))
          .filter(([, v]) => !v.includes("var(") && !v.includes("calc(") && !v.includes("-"))
          .filter(([, v]) => {
            const parts = v.trim().split(/\s+/);
            return parts.some((c) => c !== "0") && parts.every((c) => SP_LITERALS.has(c));
          })
          .map(([p, v]) => `${r.selector} ${p}: ${v}`),
      );
    expect(offenders).toEqual([]);
  });

  it("M8: line-height 1.55 归队——裸 1.55 声明零（one-off 1.45/1.5/1.6/1.65 不在此弧）", () => {
    const offenders = flatRules()
      .filter((r) => r.props["line-height"] === "1.55")
      .map((r) => `${r.selector}: ${r.props["line-height"]}`);
    expect(offenders).toEqual([]);
    // 归队后的 var 形至少在场一次（--lh-body 唯一 1.55 值源）。
    const bodyLh = flatRules().some((r) => r.props["line-height"] === "var(--lh-body)");
    expect(bodyLh).toBe(true);
  });

  it("M1 (订正): --radius-pill 单源——styles.css 全表零定义，只在 tokens.css", () => {
    const defs = flatRules().filter((r) => "--radius-pill" in r.props);
    expect(defs).toEqual([]); // styles.css 不定义（tokens.css:42 是唯一源；gate B 同法）
  });

  it("M6 (订正): synthetic 11.5px 档不存在——全表无该字面（池项过期，验尸归档）", () => {
    const offenders = flatRules()
      .filter((r) => Object.values(r.props).some((v) => v === "11.5px"))
      .map((r) => r.selector);
    expect(offenders).toEqual([]);
  });
});
