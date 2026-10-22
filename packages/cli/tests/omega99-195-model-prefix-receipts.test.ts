// ω99-195 receipts — model 词前缀族收口：切换通知统一中文前缀「模型 → 」（166fiii
// 记号裁定 supersede——同屏不一致「模式 → ask vs model → x/y」的收口弧）。
// 值侧记号原样：${provider}/${model} 插值、`/` join、modelLabel 输出全不动；
// repl 启动横幅 `模型：` 段、roster 段前缀 `模型 `、web StatusBar 段前缀
// `模型 `/`模式 `。A 形态正钉（175/191 src 钉范式 + roster 功能钉）；B 反向
// 归零（B2 渲染负查落 web tests/components.test.tsx——tsx 渲染面归 web 包内）。
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { roleSummary } from "../src/commands/agents-roster.js";

const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");
const webSrcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../web/src/${rel}`, import.meta.url)), "utf8");

describe("ω99-195 — model 词前缀族：A 形态正钉", () => {
  it("A1 repl 启动横幅：`模型：` 段与 `模式：` 段同串共存在场", () => {
    const s = srcOf("repl.ts");
    expect(s).toContain("wudao v${VERSION} · 模型：${modelLabel(opts.config)} · 模式：${modeLabel(modeRef.mode)}");
  });

  it("A2 roster roleSummary 满配：`模型 x/y/z` 逐字 + 已冻结/写入：同胞行共显", () => {
    const out = roleSummary({
      id: "code-reviewer",
      description: "d",
      frozen: true,
      provider: "kimi-code",
      model: "k3-256k",
      reasoningEffort: "high",
      writeScope: { roots: [], exactFiles: [] },
    });
    expect(out).toContain("模型 kimi-code/k3-256k/high");
    expect(out).toContain("已冻结"); // 181 弧中文同胞行
    expect(out).toContain("写入："); // 181 弧中文同胞行
  });

  it("A3 切换通知中文前缀源钉：driver 两面 + repl /model 回执前缀+尾邻接", () => {
    const d = srcOf("driver/agent-driver.ts");
    expect(d).toContain("`模型 → ${v.choice.provider}/${v.choice.model}`");
    expect(d).toContain("`模型 → ${sel.provider ?? modelLive.provider}/${sel.model}`");
    const r = srcOf("repl.ts");
    expect(r).toContain("模型 → ${v.choice.provider}/${v.choice.model} —— 下一个请求即生效（/status 显示新标签）");
  });
});

describe("ω99-195 — B 反向：五旧形逐文件归零", () => {
  it("B1 model: ${/model → /`model ${/`mode ${/takes effect next turn 在对应 src 归零", () => {
    const repl = srcOf("repl.ts");
    expect(repl).not.toContain("model: ${");
    expect(repl).not.toContain("model → ");
    const driver = srcOf("driver/agent-driver.ts");
    expect(driver).not.toContain("model → ");
    const roster = srcOf("commands/agents-roster.ts");
    expect(roster).not.toContain("`model ${");
    const bar = webSrcOf("components/StatusBar.tsx");
    expect(bar).not.toContain("`model ${");
    expect(bar).not.toContain("`mode ${");
    const app = webSrcOf("components/App.tsx");
    expect(app).not.toContain("model → ");
    expect(app).not.toContain("takes effect next turn");
    const wizard = webSrcOf("components/Wizard.tsx");
    expect(wizard).not.toContain("model → ");
    const detail = webSrcOf("components/ProviderDetail.tsx");
    expect(detail).not.toContain("model → ");
  });
});
