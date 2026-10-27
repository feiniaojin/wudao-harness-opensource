// ω99-200 receipts — provider 词族尾面收口（ProviderTab 应用回显前缀 +
// /provider 裸列表头 + App 切换失败 error 尾）：3 面，199 池矿尾环。
// 值侧/尾语/token 原样：${c.provider} 插值、半角括号现状、「下一轮起切换
// 端点,历史将全部重新处理(缓存全冷)」尾、profile 矩阵 token、`← current`
// 标记、e.message 插值全不动；#2 的「下一轮边界」语义保留——provider 切换
// 在轮界生效，与 model 的下一轮有别（199 #7 同胞形）。
// A 形态正钉（199 receipts 同法源钉，readFileSync 定位）；B 反向旧形逐面
// 文件归零（199 B1 同法，error 面取本面独有的插值定形）。运行时宿主钉
// （provider-tab.test 与 m63 两处）已随源演进，不在本文件。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const webSrcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const cliSrcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../cli/src/${rel}`, import.meta.url)), "utf8");

describe("ω99-200 — provider 词族尾面：A 形态正钉", () => {
  it("A1 ProviderTab 应用回显：中文前缀与缓存全冷尾段共存在场（199 receipts 同法源钉）", () => {
    const tab = webSrcOf("components/ProviderTab.tsx");
    // ω99-310: 回执称谓随设置面统一为「供应商」（tab 名/卡头/删除回执同词）。
    expect(tab).toContain("供应商 → ${c.provider}");
    expect(tab).toContain("— 下一轮起切换端点,历史将全部重新处理(缓存全冷)");
  });

  it("A2 provider.ts 裸列表头：中文头串 + `← current` 标记存活（m659 同族断言法，源钉文件面）", () => {
    const p = cliSrcOf("commands/provider.ts");
    // ω99-311: CLI 列表头称谓产品级统一（随 web 310）。
    expect(p).toContain("供应商（profile 矩阵；/provider <名称> 在下一轮边界切换）：");
    expect(p).toContain("← current");
  });

  it("A3 App 切换失败 error 尾：中文失败形在场，195 #8 邻行同锁", () => {
    const app = webSrcOf("components/App.tsx");
    expect(app).toContain("} 失败：${");
    expect(app).toContain("模型 → ${model} — 下一轮生效");
  });
});

describe("ω99-200 — B 反向：旧形逐面文件归零", () => {
  it("B1 三面文件旧形归零（回显英文前缀/裸列表英文头/error 英文尾——尾取本面插值定形）", () => {
    const tab = webSrcOf("components/ProviderTab.tsx");
    expect(tab).not.toContain("provider → ");
    const p = cliSrcOf("commands/provider.ts");
    expect(p).not.toContain("providers (profile matrix");
    const app = webSrcOf("components/App.tsx");
    expect(app).not.toContain("} failed: ${");
  });
});
