import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { ModelClient } from "../model-client.js";
import type { LoopOptions, LoopEvent } from "../loop.js";
import { runSubagent, BUILTIN_SUBAGENT_TYPES } from "../subagent.js";
import type { ForkContext, SubagentRunInfo } from "../subagent.js";
import { truncateSafe } from "../text-truncate.js";

/**
 * 133 #6（the upstream projectce 形）— 子代理因否决墙终止时给父链的行为契约。
 * the upstream project的硬编码契约直译 + wudao 中文定制：通知父模型（1）子代理因何停
 * （连续被权限系统否决，evidence 点名工具与次数——注入卫生：不引用原始
 * 否决详情/参数），（2）在用户明确确认前不要重启此子代理或重试其被封锁
 * 的工作，（3）向用户报告并等待。有界（≤512B）。
 */
export const SUBAGENT_DENIAL_CONTRACT_PREFIX = "[子代理被权限熔断终止] ";

export function subagentDenialNotice(info: Pick<SubagentRunInfo, "loopEvidence">): string {
  // T005 F6：evidence 盖 256 字符帽（truncateSafe，UTF-16 代理对安全）——
  // 512B 契约对任意长的 loopEvidence 成立（10KB 证据不再击穿通知界）。
  // 被切过的 evidence 尾注省略号（父模型需要知道证据不完整）。
  const evidence =
    info.loopEvidence === undefined || info.loopEvidence === ""
      ? ""
      : info.loopEvidence.length > 256
        ? `${truncateSafe(info.loopEvidence, 255)}…`
        : info.loopEvidence;
  const paren = evidence !== "" ? `（${evidence}）` : "";
  return `${SUBAGENT_DENIAL_CONTRACT_PREFIX}该子代理因连续被权限系统否决而中止${paren}。在用户明确确认之前：不要重启此子代理，不要重试它被封锁的工作。请向用户报告此情况并等待确认。`;
}

export function createTaskTool(options: {
  readonly model: ModelClient;
  readonly allTools: readonly Tool[];
  /** The children's turn fuse is POLICY (M41) — state it; core keeps no
   *  default. (The CLI dispatches through its own task tool + registry,
   *  which resolve budgets from kernel-policy.) */
  readonly loopOptions: Omit<LoopOptions, "canUseTool" | "maxTurns"> & { readonly maxTurns: number };
  readonly canUseTool?: LoopOptions["canUseTool"];
  readonly onSubagentEvent?: (event: LoopEvent) => void;
  /** M24 B2: exposes the parent conversation so shareContext/fork children
   *  can replay it. Returning undefined (state not ready) → the fork request
   *  fails with a clear error; the isolated default is unaffected. */
  readonly getForkContext?: () => ForkContext | undefined;
}) {
  return buildTool({
    name: "task",
    description:
      "Launch a sub-agent for a focused task. Returns the sub-agent's final answer. subagent_type: 'general-purpose' (read-only, default), 'coder' (full tools), or 'fork' (shares THIS conversation's context and tools — warm-cache fan-out; pass shareContext:true to select). Default children are isolated; forks see everything you have said and done. " +
      "Example: {description: 'find failing tests', prompt: 'Run pnpm test and report each failing suite with its probable cause', subagent_type: 'coder'}. " +
      "Do NOT spawn a task for an answer already in your context, and do NOT fan out parallel children on the SAME question — one focused child per distinct question.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "A short (3-5 word) description of the task." },
        prompt: { type: "string", description: "The full prompt for the sub-agent." },
        subagent_type: { type: "string", description: "'general-purpose' (read-only), 'coder' (full tools), or 'fork'. Default: general-purpose." },
        shareContext: { type: "boolean", description: "true → fork mode: the child shares this conversation's context/tools (equivalent to subagent_type:'fork')." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    async execute({ description: _description, prompt, subagent_type, shareContext }) {
      const typeName = (subagent_type as string) || "general-purpose";
      const wantFork = shareContext === true || typeName === "fork";
      // 133 #6：终因盒——onResult 回执落盒，结果组装按终因选通知。
      let runInfo: SubagentRunInfo | undefined;
      const onResult = (info: SubagentRunInfo): void => {
        runInfo = info;
      };
      try {
        if (wantFork) {
          const forkFrom = options.getForkContext?.();
          if (!forkFrom) {
            return {
              content: "task failed: fork mode (shareContext / subagent_type 'fork') requires the caller to expose the parent conversation",
              isError: true,
            };
          }
          const answer = await runSubagent({
            model: options.model,
            allTools: options.allTools,
            subagentType: BUILTIN_SUBAGENT_TYPES["fork"]!,
            prompt: prompt as string,
            forkFrom,
            loopOptions: options.loopOptions,
            canUseTool: options.canUseTool,
            onEvent: options.onSubagentEvent,
            onResult,
          });
          // 133 #6：否决墙 → 父链收到行为契约（不是裸的半截回答）。
          if (runInfo?.denialCircuit === true) {
            return { content: `${subagentDenialNotice(runInfo)}\n（中止前的部分输出：）\n${answer}`, isError: true };
          }
          return { content: answer };
        }
        const subagentType = BUILTIN_SUBAGENT_TYPES[typeName] ?? BUILTIN_SUBAGENT_TYPES["general-purpose"]!;
        const answer = await runSubagent({
          model: options.model,
          allTools: options.allTools,
          subagentType,
          prompt: prompt as string,
          loopOptions: options.loopOptions,
          canUseTool: options.canUseTool,
          onEvent: options.onSubagentEvent,
          onResult,
        });
        if (runInfo?.denialCircuit === true) {
          return { content: `${subagentDenialNotice(runInfo)}\n（中止前的部分输出：）\n${answer}`, isError: true };
        }
        return { content: answer };
      } catch (err) {
        return { content: `subagent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}
