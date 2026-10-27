// 128-4（codex 0f9a731ade 引进）— deferred 目录 names-first 预算收据。
// 存在性优先于描述：预算内每个名字必有一行；名字放不下=显式 omission
// notice；字节稳定；UTF-8 安全。
import { describe, expect, it } from "vitest";
import { buildTool, type Tool } from "../src/index.js";
import { renderDeferredCatalog, DEFERRED_CATALOG_BUDGET_BYTES } from "../src/defer-catalog.js";

const tool = (name: string, description: string): Tool =>
  buildTool({
    name,
    description,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute() {
      return { content: "ok" };
    },
  });

describe("128-4 — names-first 预算分配", () => {
  it("常规规模（≤4 工具）：全量在场，无省略——现状零漂移", () => {
    const tools = [
      tool("task", "Spawn a focused subagent. Give it a complete brief."),
      tool("agent_await", "Await background agents. Collect their results."),
    ];
    const text = renderDeferredCatalog(tools);
    expect(text).toContain("- task: Spawn a focused subagent.");
    expect(text).toContain("- agent_await: Await background agents.");
    expect(text).not.toContain("未列出");
  });

  it("病态规模 A（20 工具×长描述）：20 个名字全在，描述被压到一句", () => {
    const tools = Array.from({ length: 20 }, (_, i) =>
      tool(`mcp_tool_${String(i + 1)}`, `Tool number ${String(i + 1)}. ` + "very long description ".repeat(120)),
    );
    const text = renderDeferredCatalog(tools);
    // 存在性铁律：每个名字都在（预算 4KiB 放得下 20 行最小行）。
    for (const t of tools) expect(text).toContain(t.name);
    // 但长描述被压：没有一行超过最小行的量级。
    for (const line of text.split("\n")) expect(Buffer.byteLength(line, "utf8")).toBeLessThan(220);
  });

  it("病态规模 B（500 工具）：预算只放得下部分名字 → 显式 omission notice（绝不静默）", () => {
    const tools = Array.from({ length: 500 }, (_, i) => tool(`srv${String(i + 1)}_action`, `Does action ${String(i + 1)}. Quick.`));
    const text = renderDeferredCatalog(tools);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(DEFERRED_CATALOG_BUDGET_BYTES);
    expect(text).toMatch(/…另有 \d+ 个未列出/);
    // 省略行点名至少一个名字（可发现的下一步；点名数在预算内自适应——
    // 压到单名也是诚实的）。
    const omitted = /未列出（([^)]+)）/.exec(text)?.[1] ?? "";
    expect(omitted).toMatch(/^srv\d+_action/);
  });

  it("字节稳定：同一输入两次渲染逐字节相等（前缀缓存不变量）", () => {
    const tools = Array.from({ length: 30 }, (_, i) => tool(`t${String(i)}`, `Description ${String(i)}. ${"x".repeat(300)}`));
    expect(renderDeferredCatalog(tools)).toBe(renderDeferredCatalog(tools));
  });

  it("CJK 安全：中文描述截断不劈代理对", () => {
    const tools = Array.from({ length: 40 }, (_, i) => tool(`中文工具${String(i)}`, `第 ${String(i)} 号工具。` + "很长的中文描述".repeat(200)));
    const text = renderDeferredCatalog(tools);
    expect(text).toContain("中文工具0");
    // 无替换字符（截断劈对的病征）。
    expect(text).not.toContain("�");
  });
});
