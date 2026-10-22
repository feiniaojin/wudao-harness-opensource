// 128-4（the upstream projectde 引进）— deferred 工具目录的 names-first 预算。
//
// 问题：deferred 工具不进请求的 tools 数组，模型对它们的存在性认知全部
// 来自 load_tools 元工具描述里的目录。今天的目录（每工具一行 name+110字
// 摘要）无预算——builtin-tools + MCP 上量后，长描述会先把预算吃光，排在
// 后面的名字直接不可见：工具存在性信息被描述细节挤掉（模型「不知道有
// 这个工具」比「不知道它怎么用」严重得多）。
//
// 机制（the upstream project形）：names-first 分配——
//   ① 每个工具先保一行「- name:」+一句一行的最小摘要（存在的最小信息量）
//   ② 名字全保后剩余预算按字符轮转分给更长描述
//   ③ 名字本身超预算 → 整行省略 + omission notice（「另有 N 个未列出」——
//      省略必须显式告知，绝不静默）
//   ④ 截断在 UTF-8 字符边界（113-A4 代理对安全同律）
//   ⑤ 字节稳定：目录不变则字节不变（前缀缓存不变量——catalog 是请求
//      bytes 的一部分）
import { truncateSafe } from "./text-truncate.js";
import type { Tool } from "./tool.js";
import { deferSummary } from "./defer.js";

/** The catalog's total byte budget（the upstream project同值 4KiB）。 */
export const DEFERRED_CATALOG_BUDGET_BYTES = 4 * 1024;

/** One tool's minimal existence line: `- name: one-liner` (the one-liner is
 *  the SAME first-sentence summary deferSummary produces — the minimal
 *  per-tool unit, phase A guarantees exactly this much for every name). */

/** Pure: the budgeted catalog text. Names-first allocation; deterministic
 *  (same input → same bytes every time — the prefix-cache law). */
export function renderDeferredCatalog(
  tools: readonly Tool[],
  budgetBytes: number = DEFERRED_CATALOG_BUDGET_BYTES,
): string {
  if (tools.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  const omitted: string[] = [];
  // Phase A — every name + minimal one-liner, in order; a name that cannot
  // fit is OMITTED (never a half-line) and counted for the notice.
  const minLines = tools.map((t) => `- ${t.name}: ${deferSummary(t.description)}`);
  const noticeHead = "…另有 ";
  const reserveForNotice = 64; // a byte reserve so the notice itself always fits
  for (let i = 0; i < minLines.length; i += 1) {
    const line = minLines[i]!;
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (used + cost > budgetBytes - reserveForNotice) {
      omitted.push(tools[i]!.name);
      continue;
    }
    lines.push(line);
    used += cost;
  }
  if (omitted.length > 0) {
    let notice = `${noticeHead}${omitted.length} 个未列出（${omitted.slice(0, 5).join(", ")}${omitted.length > 5 ? "…" : ""}）——预算内放不下`;
    // Notice 自身也守预算：超了逐个减少点名名字直到放下（计数永不丢）。
    while (Buffer.byteLength(notice, "utf8") > reserveForNotice && notice.includes(",")) {
      const cutAt = notice.lastIndexOf(",");
      notice = notice.slice(0, cutAt).replace(/[，…]\s*$/, "") + "…）——预算内放不下";
    }
    lines.push(notice);
  }
  return lines.join("\n");
}

/** Build the load_tools meta-tool description over the budgeted catalog. */
export function buildBudgetedLoadToolsDescription(deferred: readonly Tool[]): string {
  const catalog = renderDeferredCatalog(deferred);
  return (
    "Load deferred tools into your toolset on demand. Deferred tools (not yet in your tool list):\n" +
    `${catalog}\n` +
    'Call ONCE with the subset you need, e.g. {"names":["task"]} — their full definitions join your tool list from your NEXT turn. ' +
    "One load per run: the toolset freezes afterwards, so ask for everything you will need."
  );
}
