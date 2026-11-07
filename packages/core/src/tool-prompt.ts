// 长程弧 §1 — 工具自述 → Tool usage 节（pi snippet+guidelines / dsh per-tool
// SECTION 形，wudao 的取法见 Tool.promptSnippet 的注释）。
//
// 病根：prompt.ts 里的 TOOL_USAGE_SECTION 是一段硬写死的文本，提到 10 个
// 工具；仓里实际有 36 个。web_search / web_fetch / python_kernel / notebook /
// notes / search_history / ask_user / ctx_inspect 等 26 个工具在系统提示词里
// 完全不存在——模型只能从 schema description 推断它们该在什么时候用，而
// description 是调用契约（参数/返回），不是使用策略。
//
// 修法不是把 26 条补进那个字符串（下次加工具又要记得改），而是让工具自己
// 声明、由渲染器按「本次会话真实挂载的工具集」生成。工具增删 → 提示词自动
// 跟随，零人工同步。
//
// 三条不变量：
//   1. **确定性排序**：按工具名 code-unit 升序（不依赖注册顺序，locale 无关）
//      ——同样的工具集必须渲染出同样的字节，否则前缀缓存在不同启动间抖动。
//   2. **缺席静默**：不声明 promptSnippet 的工具整条不出现（不是空行、不是
//      占位）——MCP/第三方工具没有声明时提示词与今天字节一致。
//   3. **空集零字节**：一个声明都没有 → 返回 ""，调用方的提示词与改造前
//      逐字节相同（老会话的热前缀不受影响）。

import type { Tool } from "./tool.js";

/** 渲染出来的节头。调用方把它当作 section 常量的一部分。 */
export const TOOL_GUIDE_HEADING = "# Tool usage";

/** 一条工具声明（从 Tool 上摘出来的纯数据，便于测试与确定性比较）。 */
export interface ToolPromptEntry {
  readonly name: string;
  readonly snippet: string;
  readonly guidelines: readonly string[];
}

/** 从工具集摘出声明（跳过缺席者），按名升序。纯函数。 */
export function collectToolPromptEntries(tools: readonly Tool[]): ToolPromptEntry[] {
  const entries: ToolPromptEntry[] = [];
  for (const tool of tools) {
    const snippet = tool.promptSnippet;
    if (snippet === undefined || snippet.length === 0) continue;
    // 2026-11-07：延后加载的工具不进指南。它们不在请求的 tools 数组里——模型
    // 看到描述也调不了（调了就是 unknown tool），而 load_tools 的目录本来就有
    // 它们的描述。此前 docs 家族 17 个工具在指南里白占 ~1.5KB 前缀字节，
    // 还诱导模型调用一个未挂载的工具。
    if (tool.shouldDefer?.() === true) continue;
    entries.push({
      name: tool.name,
      snippet,
      guidelines: tool.promptGuidelines ?? [],
    });
  }
  // Code-unit comparison — locale-independent, so the order is identical on
  // every machine (dsh's compareNames rule, same reason).
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}

/** 渲染成一节。无声明 → ""（零字节，调用方拼进去等于没拼）。 */
export function renderToolGuideSection(tools: readonly Tool[]): string {
  const entries = collectToolPromptEntries(tools);
  if (entries.length === 0) return "";
  const lines: string[] = [TOOL_GUIDE_HEADING];
  for (const e of entries) {
    lines.push(`- ${e.name}: ${e.snippet}`);
    for (const g of e.guidelines) lines.push(`  - ${g}`);
  }
  return lines.join("\n");
}
