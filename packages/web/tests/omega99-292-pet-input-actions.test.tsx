// @vitest-environment jsdom
// ω99-292 — 会话输入框按钮行收据（用户令 09-12「发送在最右边，取消按钮
// 稍微离远点，并且不要太显眼」）。旧形 [发送][取消] 紧贴 6px——取消占了
// flex-end 行的最右主操作位、与发送同尺寸同描边，喧宾夺主。新契约三点：
// ① 发送是行内最后一个子钮（= 最右）；② 行 gap 拉开（14px）；③ 取消是
// 低调文字钮（无边框 + 降透明度字，✕/fold 同范式）。
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { decl } from "./css-test-utils.js";
import "../src/pet/pet.css";

// jsdom 的 fs 锚用 process.cwd() 候选位（178/203/290 三证）。
const readSrc = (rel: string): string => {
  const hit = ["src", "packages/web/src"]
    .map((d) => `${process.cwd()}/${d}/${rel}`)
    .find((p) => existsSync(p));
  if (hit === undefined) throw new Error(`source not found: ${rel}`);
  return readFileSync(hit, "utf8");
};

describe("ω99-292 输入框按钮行（发送主位 + 取消退后）", () => {
  const css = readSrc("pet/pet.css");
  const bubble = readSrc("pet/Bubble.tsx");

  it("DOM 序：取消在前、发送殿后（flex-end 行的最右主操作位）", () => {
    const rowAt = bubble.indexOf('className="pet-bubble-input-row"');
    expect(rowAt).toBeGreaterThan(-1);
    const sendAt = bubble.indexOf('data-bubble-send', rowAt);
    const cancelAt = bubble.indexOf('data-bubble-cancel', rowAt);
    expect(cancelAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(cancelAt); // 发送在取消之后 = 最右
  });

  it("CSS：行 gap 拉开 + 取消是低调文字钮（源级 + CSSOM 双证）", () => {
    const rowAt = css.indexOf(".pet-bubble-input-row");
    const open = css.indexOf("{", rowAt);
    const rowBody = css.slice(open, css.indexOf("}", open));
    expect(rowBody).toContain("gap: 14px"); // 「稍微离远点」：6→14

    // 取消：无边框 + 低强调字（✕ 钮同值；119b 令牌形 --text-3）
    const cancelAt = css.indexOf(".pet-bubble-cancel {");
    const cOpen = css.indexOf("{", cancelAt);
    const cancelBody = css.slice(cOpen, css.indexOf("}", cOpen));
    expect(cancelBody).toContain("border: none");
    expect(cancelBody).toContain("color: var(--text-3)");
    expect(cancelBody).not.toContain("border: 1px"); // 描边墨按钮形态退役

    // CSSOM：规则真解析进了样式表（简写名直查——jsdom 不物化长手）
    expect(decl(".pet-bubble-input-row", "gap")).toBe("14px");
    expect(decl(".pet-bubble-cancel", "border")).toBe("none");
    expect(decl(".pet-bubble-cancel", "color")).toBe("var(--text-3)");
  });

  it("发送钮保持主操作姿态（实心绿不动——本令只降取消，不动发送；119b 品牌绿通道形）", () => {
    expect(decl(".pet-bubble-send", "background")).toBe("rgb(var(--pet-accent))");
    expect(decl(".pet-bubble-send", "color")).toBe("rgb(var(--pet-accent-ink))");
  });
});
