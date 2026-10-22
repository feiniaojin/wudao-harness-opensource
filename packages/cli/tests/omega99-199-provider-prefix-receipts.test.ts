// ω99-199 receipts — provider 词前缀族收口 + one-shot 横幅 + /model //effort
// 列表头 + purge 交互提示中文化（10 面；195/194 池矿弧）。
// 值侧记号原样：${v.name}/${providerChoice}/${card.provider} 插值、
// (${...model}) 括号 join、modelLabel 输出全不动；尾语原样（缓存注记、
// borrowedKeyPoolNote、半角括号现状）；token 保留（→、—、/、/status、
// /effort、WUDAO_MODEL、[y/N]、.wudao/trash raw 路径）。
// A 形态正钉（175/191/195 src 钉范式，readFileSync 定位）；B 反向旧形
// 逐面文件归零（195 B1 同法）。运行时宿主钉（m63/settings-ops/ui/
// persona-wiring 四 cli 测试 + web provider-detail/settings-page/
// ui-review-r3 + evals det-53/deterministic）已随源演进，不在本文件。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const webSrcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), "utf8");

describe("ω99-199 — provider 前缀族/横幅/列表头/purge 交互：A 形态正钉", () => {
  it("A1 repl /provider 回执：中文前缀与客户端重建尾段共存在场（166f-ii 同法源钉）", () => {
    const r = srcOf("repl.ts");
    expect(r).toContain("供应商 → ${v.name} (${r.config.model}) —— 客户端已重建，下一个请求即生效（/status 显示新标签）"); // ω99-311: 称谓产品级统一
  });

  it("A2 index one-shot 横幅：`模型：` 段与 repl 启动横幅同词（195 #1 姊妹面）", () => {
    const i = srcOf("index.ts");
    expect(i).toContain("模型：${modelLabel(config)}\\n");
  });

  it("A3 model.ts 两列表头：模型矩阵头 + 推理力度头（/effort token 在场）", () => {
    const m = srcOf("commands/model.ts");
    expect(m).toContain("模型（profile 矩阵 + 注册表 + WUDAO_MODEL；/model <名称|编号> 切换——下一轮生效）：");
    expect(m).toContain("推理力度（${REASONING_EFFORTS.join(\" | \")}；/effort <级别|编号> 切换——下一轮生效）：");
  });

  it("A4 index purge 交互：confirm 行 + 取消行源钉（[y/N] 与 .wudao/trash token 保留）", () => {
    const i = srcOf("index.ts");
    expect(i).toContain("将 ${plan.entries.length} 个文件（${(plan.totalBytes / 1024).toFixed(1)} KB）移入 .wudao/trash？[y/N] ");
    expect(i).toContain("（已取消清除——未写入任何内容）");
  });
});

describe("ω99-199 — B 反向：旧形逐面文件归零", () => {
  it("B1 六面文件旧形归零（切换前缀/横幅英文头/列表英文 prose/purge 英文交互）", () => {
    const repl = srcOf("repl.ts");
    expect(repl).not.toContain("provider → ");
    const driver = srcOf("driver/agent-driver.ts");
    expect(driver).not.toContain("provider → ");
    const model = srcOf("commands/model.ts");
    expect(model).not.toContain("takes effect next turn");
    const index = srcOf("index.ts");
    expect(index).not.toContain("file(s)");
    expect(index).not.toContain("purge cancelled");
    expect(index).not.toContain("`model: ${");
    const wizard = webSrcOf("components/Wizard.tsx");
    expect(wizard).not.toContain("provider → ");
    const detail = webSrcOf("components/ProviderDetail.tsx");
    expect(detail).not.toContain("provider → ");
  });
});
