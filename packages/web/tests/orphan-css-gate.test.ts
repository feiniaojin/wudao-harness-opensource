// DESIGN-SYSTEM P4 — 孤儿 CSS 门：styles/ 中定义的类选择器若在全部
// ts/tsx 源与测试中零引用（模板字面量/动态拼接也算引用——全文本匹配），
// 即为死 CSS。现状基线 = 零孤儿（2026-10-28 扫描：13 候选经复核全为
// 注释里的退役记录与前缀伪影）。前缀豁免（is-/has-/pet-/mk- 状态与
// pet 域）与三位以下短名豁免（grep 噪声）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const here = join(import.meta.dirname, "..");
const stylesDir = join(here, "src", "styles");

function cssClassNames(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(stylesDir)) {
    if (!f.endsWith(".css")) continue;
    const raw = readFileSync(join(stylesDir, f), "utf8");
    // strip comments first — retired-class mentions in prose are not definitions
    const noComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of noComments.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
      out.add(m[1]!);
    }
  }
  return out;
}

function sourceBlob(): string {
  let out = "";
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|mjs)$/.test(e.name) && !e.name.endsWith(".d.ts")) out += readFileSync(p, "utf8");
    }
  };
  walk(join(here, "src"));
  walk(join(here, "tests"));
  return out;
}

describe("DESIGN-SYSTEM P4: 孤儿 CSS 门", () => {
  it("styles/ 定义的类在源码/测试中零引用的数为 0（死 CSS 防回潮）", () => {
    const defined = cssClassNames();
    const blob = sourceBlob();
    const EXCLUDE = /^(is-|has-|pet-|mk-)/;
    const orphans = [...defined].filter(
      (c) => c.length > 3 && !EXCLUDE.test(c) && !blob.includes(c),
    );
    // 源码里 className 模板/拼接都可能引用——全文本 includes 已是最宽
    // 判定；仍零命中 = 真孤儿。基线为空；新孤儿按「删规则或接组件」二选一。
    expect(orphans, `死 CSS 类（全源零引用）: ${orphans.join(", ")}`).toEqual([]);
  });
});
