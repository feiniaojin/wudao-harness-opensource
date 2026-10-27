// @vitest-environment jsdom
// ω99-290 — 0.3.78 宠物窗零像素回归的确定性钉。根因（真 WKWebView 104×84
// 视口实测 getBoundingClientRect）：T9 的 .pet-poke-layer 包装层不带几何
// 规则 → .pet-figure{height:100%} 对 auto 高度父级解析回 auto，其唯一子
// .pet-sprite-img 是 position:absolute（不贡献流内高度）→ figure 与层全塌
// 成 0 高 → img 改以 0 高 figure 的 bottom:0 锚定，整体被顶出窗顶（0.3.77
// img y=13.4 在窗内正常绘制；0.3.78 塌陷后 y=-82.6 全在窗外 → 全透明零
// 像素）。高视口浏览器（Safari 人工验证）与无布局引擎的 jsdom（278 的
// 「垫层零演进」DOM 断言）都测不出——本件把「根→img 的每个流内祖先必须
// 有确定高度」钉成 CSS 契约。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { decl } from "./css-test-utils.js";
import "../src/pet/pet.css";

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203 两证）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};

/** 选择器规则体（`{`…首个 `}`）——单层规则块专用。 */
const ruleBody = (css: string, selector: string): string => {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`selector not found: ${selector}`);
  const open = css.indexOf("{", at);
  return css.slice(open, css.indexOf("}", open));
};

describe("ω99-290 宠物精灵几何链（0.3.78 零像素回归钉）", () => {
  const css = readSrc("pet/pet.css");

  it("修复体：.pet-poke-layer 满格几何规则在场（源级 + CSSOM 双证）", () => {
    const body = ruleBody(css, ".pet-poke-layer {");
    expect(body).toContain("width: 100%");
    expect(body).toContain("height: 100%");
    // CSSOM：规则真解析进了样式表（不是只躺在源码字符串里）
    expect(decl(".pet-poke-layer", "width")).toBe("100%");
    expect(decl(".pet-poke-layer", "height")).toBe("100%");
  });

  it("不变量：根→img 的每个流内祖先都有确定高度（塌陷不再可能）", () => {
    // 根：定高 + fixed（几何链的锚点端）
    expect(decl(".pet-root", "position")).toBe("fixed");
    expect(decl(".pet-root", "height")).toBe("96px");
    // 垫层与 figure：满格百分比（各自父级确定 → 链确定）
    expect(decl(".pet-poke-layer", "height")).toBe("100%");
    expect(decl(".pet-figure", "height")).toBe("100%");
    expect(decl(".pet-figure", "width")).toBe("100%");
    // img：absolute + 底锚（塌陷时把精灵顶出窗的正是这两行——锚定端
    // 保留 0.3.77 语义，靠父链确定而非改锚）
    expect(decl(".pet-sprite-img", "position")).toBe("absolute");
    expect(decl(".pet-sprite-img", "bottom")).toBe("0"); // CSSOM 序列化无单位零
    expect(decl(".pet-sprite-img", "width")).toBe("96px");
  });

  it("回归镜：278 的 [data-poked] 动画规则与几何规则各归其位（同选择器两规则不互吞）", () => {
    const anim = ruleBody(css, ".pet-poke-layer[data-poked]");
    expect(anim).toContain("pet-squash 0.6s");
    expect(anim).not.toContain("height"); // 动画块不带几何——几何在 .pet-poke-layer 本体
    const geo = ruleBody(css, ".pet-poke-layer {");
    expect(geo).not.toContain("animation"); // 几何块不带动画
  });
});
