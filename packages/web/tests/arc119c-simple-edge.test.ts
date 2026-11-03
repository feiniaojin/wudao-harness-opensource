// arc119c — 极简模式贴边（用户指令 09-26：「极简模式根本不需要两侧空白的
// 填充区域，窗口两侧边界应该贴近会话流和输入框两侧」）。
// 收据四钉：simple 门下 .chat/.composer 撤 content-max 居中帽、审批/权限卡
// 跟流同宽贴边、buddy/advanced 的自适应中列原样保留（零回归锚）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stylesPieceFiles } from "./styles-source.js";

const SRC = join(import.meta.dirname, "../src/styles");
const readPiece = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const COMPOSER = readPiece("20-composer.css");
const ACTIVITY = readPiece("30-activity.css");
const BASE = readPiece("00-base.css");

describe("arc119c 极简模式贴边", () => {
  it("① simple 门下 .chat/.composer 撤居中帽 + 会话流圆角容器", () => {
    // ca7e348a 根治形：max-width/margin 归零外再补 width:100%（三次修补的
    // 终态）——钉随之演进（含注释里的形状说明）。
    expect(COMPOSER).toMatch(/\.simple \.chat \{ max-width: none; margin: 0; width: 100%; \}/);
    expect(COMPOSER).toMatch(/\.simple \.composer \{ max-width: none; margin: 0; width: 100%; margin-top: var\(--sp-3\); \}/);
    // 09-27 根治：base .chat 已有圆角+同宽（inputarea 侧 padding 已撤）
    expect(BASE).toMatch(/\.chat \{[\s\S]*?border-radius: var\(--radius-md\);[\s\S]*?\}/);
  });

  it("② 审批/权限卡在 simple 门下跟流同宽贴边", () => {
    expect(ACTIVITY).toMatch(/\.simple \.approval \{\s*width: calc\(100% - 2\.5rem\);\s*margin-left: var\(--sp-2\);\s*margin-right: var\(--sp-2\);/);
    expect(ACTIVITY).toMatch(/\.simple \.permission-card \{\s*width: calc\(100% - 2\.5rem\);\s*margin-left: var\(--sp-2\);\s*margin-right: var\(--sp-2\);/);
  });

  it("③ buddy/advanced 的自适应中列原样（.chat/.composer 基线帽不动）", () => {
    // 基线规则仍在（无 .simple 前缀的原始形）
    expect(BASE).toMatch(/\.chat \{\s*max-width: calc\(var\(--content-max\) \+ 32px\);/);
    expect(COMPOSER).toMatch(/\.composer \{\s*max-width: calc\(var\(--content-max\) \+ 32px\);/);
    // tokens 的 clamp 值不动（116b 收据的锚继续有效）
    const tokens = readFileSync(join(SRC, "../tokens.css"), "utf8");
    expect(tokens).toContain("--content-max: clamp(680px, 64%, 920px)");
  });

  it("④ 全部 piece 文件在（styles-source 孤儿检查沿 116 纪律）", () => {
    expect(stylesPieceFiles.length).toBeGreaterThanOrEqual(12);
  });
});
