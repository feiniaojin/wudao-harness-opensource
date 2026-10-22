// ω99-205: #R — 全仓 warn 族半角冒号归零收口 receipts（cli 旁问族 3 面：
// repl.ts / driver/agent-driver.ts / commands/mcp-auth.ts，204 词表终章）。
// ① 正向源钉：旁问失败全角 ×2（repl stdout 形与 agent-driver notice 形各 1）
// 且 mcp-auth 失败全角在场；② 反向：cli src 半角 warn 族（X失败:/X未保存:/
// X错误:）递归归零（204 receipts 同款 readFileSync 直读法）；③ 全仓构造性钉：
// core/providers/server/browser/slack/evals/cli 七包 src 半角族=0 + web src
// X失败族=0 且半角「存…」串恰 1 = CodeEditor doc 注释（204 已钉豁免，本弧
// 复述全仓图景）+ apps/desktop src 亦 0；④ dist 反查：cli dist 旁问失败半角
// =0（构建后记数）。仅冒号字形换 + 删半角尾空格，⚠️/词面/插值零触。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

const countOf = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

// ②/③/④ 的扫描域：各包 src（及 cli dist）全部 .ts/.tsx/.cjs/.js/.mjs 递归收齐。
const walkSrc = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? walkSrc(`${dir}/${d.name}`)
      : /\.(ts|tsx|cjs|js|mjs)$/.test(d.name)
        ? [`${dir}/${d.name}`]
        : [],
  );

const pathOf = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

const pkgSrc = (name: string): string => pathOf(`../../${name}/src`);

const HALF_FAIL = "失败:";
const HALF_UNSAVED = "未保存:";
const HALF_ERROR = "错误:";

const halfFamilyOf = (root: string): number =>
  walkSrc(root).reduce((n, f) => {
    const s = readFileSync(f, "utf8");
    return n + countOf(s, HALF_FAIL) + countOf(s, HALF_UNSAVED) + countOf(s, HALF_ERROR);
  }, 0);

describe("ω99-205 — A 正向：3 面全角在场（源钉法）", () => {
  it("① 旁问失败全角 ×2（repl stdout 形与 agent-driver notice 形各 1）且 mcp-auth 失败全角在场", () => {
    expect(countOf(srcOf("repl.ts"), "旁问失败：${")).toBe(1);
    expect(countOf(srcOf("driver/agent-driver.ts"), "旁问失败：${")).toBe(1);
    expect(srcOf("commands/mcp-auth.ts")).toContain(
      "失败：${err instanceof Error ? err.message : String(err)}",
    );
  });
});

describe("ω99-205 — B 反向：cli 归零 + 全仓构造性 + dist", () => {
  it("② cli src 半角 warn 族递归归零（X失败:/X未保存:/X错误: = 0）", () => {
    expect(halfFamilyOf(pathOf("../src"))).toBe(0);
  });

  it("③ 全仓构造性钉：七包 src 半角族=0；web X失败族=0 且半角「存…」恰 1=CodeEditor 注释（204 豁免复述）；apps/desktop 亦 0", () => {
    for (const p of ["core", "providers", "server", "browser", "slack", "evals", "cli"]) {
      expect(halfFamilyOf(pkgSrc(p)), `${p} src 半角 warn 族应归零`).toBe(0);
    }
    const webRoot = pkgSrc("web");
    expect(halfFamilyOf(webRoot)).toBe(0);
    const webSaves = walkSrc(webRoot).reduce(
      (n, f) => n + countOf(readFileSync(f, "utf8"), "保存:"),
      0,
    );
    expect(webSaves).toBe(1);
    expect(readFileSync(pathOf("../../web/src/components/CodeEditor.tsx"), "utf8")).toContain(
      "/** 覆盖保存: 以 base",
    );
    expect(halfFamilyOf(pathOf("../../../apps/desktop/src"))).toBe(0);
  });

  it("④ cli dist 反查：旁问失败半角=0（构建后记数）", () => {
    const n = walkSrc(pathOf("../dist")).reduce(
      (m, f) => m + countOf(readFileSync(f, "utf8"), "旁问失败:"),
      0,
    );
    expect(n).toBe(0);
  });
});
