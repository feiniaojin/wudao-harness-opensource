// 长程弧 §1 守卫 — 工具自述的覆盖率棘轮。
//
// 为什么需要这条钉子：改造前 Tool usage 节是一个硬写死的字符串，只提了 10
// 个工具，而生产工具集有 49 个——39 个工具在提示词里完全不存在，模型不知道
// 它们可以用。改成「工具自己声明 promptSnippet」之后，风险反了过来：**新增
// 工具时忘记声明，它就会静默隐形**，而且没有任何现象能提示你。
//
// 所以这里钉住：生产 buildToolSet 产出的每一个工具都必须在渲染结果里出现。
// 新增工具忘了声明 → 这条红了，并在报错里点名是哪一个。
import { describe, it, expect } from "vitest";
import { buildToolSet } from "../src/tools.js";
import { collectToolPromptEntries, renderToolGuideSection } from "@wudao-org/core";

describe("工具自述覆盖率（长程弧 §1 棘轮）", () => {
  const tools = buildToolSet({ workspaceRoot: "/tmp/wudao-guide-coverage", model: "stub" } as never);

  it("生产工具集里每一个工具都声明了 promptSnippet（登记簿完整）", () => {
    // 棘轮盯的是**声明**，不是渲染——延后加载的工具不在指南里（见下一条），
    // 但必须已声明：任何一个会话都可能挂载它，忘了声明它在那个会话里就静默隐形。
    const declared = new Set(tools.filter((t) => t.promptSnippet !== undefined && t.promptSnippet.length > 0).map((t) => t.name));
    const missing = tools.map((t) => t.name).filter((n) => !declared.has(n));
    expect(missing, `这些工具没有 promptSnippet，挂载它们的会话里模型看不到它们：${missing.join(", ")}`).toEqual([]);
  });

  it("指南只渲染常驻面：延后加载的工具不出现（2026-11-07 能力一致性）", () => {
    const guideNames = new Set(collectToolPromptEntries(tools).map((e) => e.name));
    const deferred = tools.filter((t) => t.shouldDefer?.() === true).map((t) => t.name);
    for (const n of deferred) expect(guideNames.has(n), `${n} 已延后却仍在指南里`).toBe(false);
    const eager = tools.filter((t) => t.shouldDefer?.() !== true).map((t) => t.name);
    for (const n of eager) expect(guideNames.has(n), `${n} 常驻却不在指南里`).toBe(true);
  });

  it("渲染结果按名字排序、每个工具恰好一行，指南缩进挂在它下面", () => {
    const section = renderToolGuideSection(tools);
    const lines = section.split("\n");
    expect(lines[0]).toBe("# Tool usage");
    const names = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2, l.indexOf(":")));
    expect(names).toEqual([...names].sort());
    const eagerCount = tools.filter((t) => t.shouldDefer?.() !== true).length;
    expect(names.length).toBe(eagerCount);
    // 指南行只能出现在某个工具行之后，且必须缩进两格
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith("  - ")) expect(lines[i - 1].length).toBeGreaterThan(0);
      else if (lines[i].length > 0) expect(lines[i].startsWith("- ") || lines[i] === "# Tool usage").toBe(true);
    }
  });

  it("自述是静态字节：同一个工具集渲染两次逐字节相同（前缀缓存）", () => {
    expect(renderToolGuideSection(tools)).toBe(renderToolGuideSection(tools));
  });

  it("自述不进请求的 tools schema —— 它只属于 system prompt", async () => {
    const { toModelToolDefinition } = await import("@wudao-org/core");
    for (const t of tools) {
      const def = toModelToolDefinition(t) as Record<string, unknown>;
      expect(Object.keys(def).sort()).toEqual(["description", "name", "parameters"]);
    }
  });
});
