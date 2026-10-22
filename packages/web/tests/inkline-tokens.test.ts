import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// tokens v2 — 墨线地基（spec §1.1-1.3/1.6）：字号五档/间距/动效/圆角四档齐备，
// 旧 pill|card|chip 圆角与 shadow 令牌退役。纯文本断言（CSSOM 断言在 tokens.test.ts）。
const css = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");

describe("inkline tokens v2", () => {
  it("has the 5-step type scale + line-heights", () => {
    for (const v of ["--fs-caption:11px", "--fs-ui:12.5px", "--fs-body:14px",
      "--fs-title:16px", "--fs-head:20px", "--lh-body:1.55"]) {
      expect(css).toContain(v);
    }
  });
  it("has the spacing grid, motion tokens, and the 119 radius scale (3 tiers + bubble)", () => {
    // 119 用户反馈修正（0.4.2「会话区直角/会话框圆角不统一」）：圆角收敛为
    // 单一 scale——sm 6（chip/小件/徽标）、md 8（卡片/工具卡/输入条）、
    // lg 12（浮层）+ bubble 8（气泡语义档，与 md 同值）。旧四档里的
    // --radius-pill(22px) 退役（胶囊帽与 6/8/12 语言不搭，「不统一」感主源）。
    for (const v of ["--sp-1:4px", "--sp-8:32px", "--dur-fast:120ms", "--dur-med:180ms",
      "--dur-slow:240ms", "--ease:cubic-bezier(.2,.8,.2,1)",
      "--radius-sm:6px", "--radius-md:8px", "--radius-lg:12px"]) {
      expect(css).toContain(v);
    }
    // 119：气泡改 8px 均匀角（旧 16px 16px 4px 16px 复合角与卡片族不搭）。
    expect(css).toContain("--radius-bubble: 8px");
    // 退役档零出现（防复活；注释里的历史叙述允许——定义形态才算）。
    expect(css).not.toMatch(/--radius-pill:\s*22px/);
  });
  // 116 弧 A：单档重投影 --shadow-2 退役（廉价感 TOP5 #2），elevation 三件套
  // 接位——0.5px 发丝描边画进 box-shadow + 两层 .02~.05 柔光（the upstream format配方）。
  // re-pin 到精确值（不是删断言）：三档双主题都定义；旧名零出现（防复活）。
  it("elevation trio replaces the retired single heavy shadow (116 弧 A)", () => {
    expect(css).not.toMatch(/--radius-(card|chip)/);
    expect(css).not.toContain("--radius-composer");
    expect(css).not.toContain("--shadow-2");
    expect(css).toContain("--elev-1: 0 0 0 .5px rgba(255,255,255,.09), 0 2px 6px 0 rgba(0,0,0,.05), 0 0 12px 0 rgba(0,0,0,.02)");
    expect(css).toContain("--elev-2: 0 0 0 .5px rgba(255,255,255,.11), 0 4px 16px 0 rgba(0,0,0,.05), 0 0 24px 0 rgba(0,0,0,.03)");
    expect(css).toContain("--elev-3: 0 0 0 .5px rgba(255,255,255,.13), 0 8px 24px 0 rgba(0,0,0,.05), 0 0 40px 0 rgba(0,0,0,.04)");
    expect(css).toContain("--elev-1: 0 0 0 .5px rgba(0,0,0,.09), 0 2px 6px 0 rgba(0,0,0,.04), 0 0 12px 0 rgba(0,0,0,.02)");
    expect(css).toContain("--elev-2: 0 0 0 .5px rgba(0,0,0,.11), 0 4px 16px 0 rgba(0,0,0,.05), 0 0 24px 0 rgba(0,0,0,.03)");
    expect(css).toContain("--elev-3: 0 0 0 .5px rgba(0,0,0,.13), 0 8px 24px 0 rgba(0,0,0,.05), 0 0 40px 0 rgba(0,0,0,.04)");
    // 描边与柔光可拆（composer focus 环 = accent 环 + 柔光，不带回边框）。
    expect(css).toContain("--elev-2-soft: 0 4px 16px 0 rgba(0,0,0,.05), 0 0 24px 0 rgba(0,0,0,.03)");
  });

  // 116 弧 A：发丝线三档（黑白 alpha 叠层）接管全部中性边框；实色线退役。
  it("hairline tiers are alpha overlays in both themes; the solid line tokens are gone", () => {
    expect(css).not.toContain("--line:");
    expect(css).not.toContain("--line-2:");
    expect(css).toContain("--hair-1: rgba(255,255,255,.07); --hair-2: rgba(255,255,255,.13); --hair-3: rgba(255,255,255,.22);");
    expect(css).toContain("--hair-1: rgba(0,0,0,.08); --hair-2: rgba(0,0,0,.14); --hair-3: rgba(0,0,0,.22);");
    expect(css).toContain("--hover: rgba(255,255,255,.08);");
    expect(css).toContain("--hover: rgba(0,0,0,.05);");
  });
  it("the frozen semantic palette rides the 116 弧 A cool-gray ladder", () => {
    // 116 弧 A: 表面三阶迁冷灰（B−R 3~5，层间 HSL-L 步进 3~5）——语义色
    // （ok/warn/danger/accent）逐值未动，风险面由 tokens-contrast 的六组合
    // 门钉死。阶梯算值与全套对比度证明见 scripts/arc116-ladder.mjs。
    for (const v of [
      "--bg: #141519; --surface: #1C1D21; --surface-2: #25262A", // dark
      "--bg: #F5F6F8; --surface: #FFFFFF; --surface-2: #EEF0F3", // light
      "--accent: #12A874", "--danger: #F87171",
    ]) {
      expect(css).toContain(v);
    }
  });
});
