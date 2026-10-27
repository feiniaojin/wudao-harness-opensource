// 借鉴弧 ζ1（Reasonix durable tool recovery 蒸馏）——「未知结果」合成串的
// 叶子判别模块。v7 收货合并裁决：四枚常量的单一物理定义点=loop-synthetics.ts
//（δ 顺带拆分的超集模块）；本模块从它转发并定义 pending-actions 所需的
// UNKNOWN_OUTCOME_TOOL_RESULTS 集（两模块皆零 loop 依赖，无环）。
export {
  TRUNCATED_TOOL_CALL_RESULT,
  ABORTED_UNKNOWN_TOOL_RESULT,
  ABORTED_NOT_STARTED_TOOL_RESULT,
  PERSIST_FAILED_TOOL_RESULT,
} from "./loop-synthetics.js";
import {
  TRUNCATED_TOOL_CALL_RESULT,
  ABORTED_UNKNOWN_TOOL_RESULT,
  ABORTED_NOT_STARTED_TOOL_RESULT,
  PERSIST_FAILED_TOOL_RESULT,
} from "./loop-synthetics.js";

export const UNKNOWN_OUTCOME_TOOL_RESULTS: ReadonlySet<string> = new Set([
  "[session resumed: previous tool result unavailable]",
  ABORTED_UNKNOWN_TOOL_RESULT,
]);
