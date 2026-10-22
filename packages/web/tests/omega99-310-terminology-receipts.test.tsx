// ω99-310 — 供应商术语统一（读屏文案轴）：web 面内部两名并存的收据。
// 走查判词：71 处「供应商」（设置 tab 名、pvd 卡头、删除回执、搜索
// aria-label、全部 title 提示）vs 4 处「服务商」（/provider 切换回执族：
// App pickModel / Wizard 完成 / ProviderDetail 模型行 / ProviderTab 应用
// 钮）——同一概念两个名字，简洁标准下收口为面内主导词「供应商」。
// CLI TUI 面自有一套词族（agent-driver/repl/status/provider 命令，ω99-199
// 统一的是回执族词形），面内自成体系不在本门辖内；其自身的 供应商/服务商
// 混用（13 vs ~6）留池注记待 CLI 精修弧。
// 门 A：web src 全树（.ts/.tsx）「服务商」归零——新回执永远不 再引入第二
// 称谓；门 B：四个切换回执站点「供应商 → ${...}」正钉在场（防误删回执本
// 身）；门 C：设置面称谓锚（SETTINGS_TABS 的 tab 名 + 搜索 aria-label）。
// 源读取走 omega99-200 的 URL 惯用法（本文件无 jsdom pragma——306 教训
// 只辖 pragma 件）。
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
const srcOf = (rel: string): string => readFileSync(`${srcRoot}/${rel}`, "utf8");

/** 全树 .ts/.tsx 清单（recursive readdir，Node ≥20 惯用法）。 */
const allSourceFiles = (): string[] =>
  readdirSync(srcRoot, { recursive: true })
    .map((p) => String(p))
    .filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));

describe("ω99-310 — 供应商术语统一：census 门", () => {
  it("A web src 全树「服务商」归零（两名并存绝不再生）", () => {
    const offenders = allSourceFiles().filter((p) => srcOf(p).includes("服务商"));
    expect(offenders).toEqual([]); // 失败时列出文件名，直接定位
  });

  it("B 四个 /provider 切换回执站点「供应商 → ${...}」在场（回执本体不丢）", () => {
    expect(srcOf("components/App.tsx")).toContain("供应商 → ${provider}");
    expect(srcOf("components/Wizard.tsx")).toContain("供应商 → ${providerChoice}");
    expect(srcOf("components/ProviderDetail.tsx")).toContain("供应商 → ${card.provider}");
    expect(srcOf("components/ProviderTab.tsx")).toContain("供应商 → ${c.provider}");
  });

  it("C 设置面称谓锚：tab 名 + 搜索 aria-label 用同一词", () => {
    const page = srcOf("components/SettingsPage.tsx");
    expect(page).toContain('{ id: "provider", label: "供应商" }');
    const tab = srcOf("components/ProviderTab.tsx");
    expect(tab).toContain('aria-label="搜索供应商"');
  });
});
