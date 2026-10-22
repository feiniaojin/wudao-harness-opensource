// 125 项 2（the upstream projectget_context_remaining 形）— context_remaining：模型第一次
// 能「查」自己的上下文水位线。ctx_inspect（M52 §3）给占用明细；本工具给的是
// 决策面——还剩多少、离压缩线还有多少，长任务中模型据此主动外化/收尾。
//
// 数据源（与 ctx_inspect 同缝，零新状态）：occupancy = estimateTokens(
// systemPrompt, tools, messages)（压缩触发器同一套估算）；压缩线 =
// resolveCompactionThresholdTokens（125 项 1 的预留感知公式——窗口、
// thresholdRatio、headroomTokens、outputReserveTokens 全部从调用方线程进来，
// 本工具与 loop 的 effectiveThreshold 读同一条线，永不各执一词）。
//
// 不做常驻广播（水位线广播会碰前缀字节，M24）——模型按需查询：工具
// description 写清「长任务定期查；remaining 低于 20% 考虑外化到 note_write
// 或提前收尾」。只读、零副作用、不加 ask（READ_TOOLS 面）。
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { ModelToolDefinition } from "../tool.js";
import type { AgentMessage } from "../types.js";
import { estimateTokens } from "../compaction.js";
import {
  resolveCompactionThresholdTokens,
  type CompactionThresholdSpec,
} from "../compaction-threshold.js";

/** The live seam the tool reads at execution time (late-bound — tools are
 *  built before the AgentState exists; the same discipline as ctx_inspect). */
export interface ContextRemainingSnapshot {
  readonly systemPrompt: string;
  /** The tool defs as the provider sees them (defer-aware where wired). */
  readonly tools: readonly ModelToolDefinition[];
  readonly messages: readonly AgentMessage[];
  readonly contextWindowTokens: number;
  /** The provider's last REAL prompt size (usage.promptTokens), when known —
   *  beats the estimate the same way the loop's trigger does. */
  readonly lastUsagePromptTokens?: number;
  /** 125 项 1 的触发线输入（ratio/headroom/reserve 缺省走 core 常量）。 */
  readonly threshold?: Readonly<Partial<CompactionThresholdSpec>>;
}

export function createContextRemainingTool(getSnapshot: () => ContextRemainingSnapshot): Tool {
  return buildTool({
    name: "context_remaining",
    description:
      "查询当前上下文水位线（只读）：窗口总量、已用 promptTokens、剩余 remainingTokens 与剩余比例 remainingRatio、压缩触发线 compressionThreshold（已扣除输出预留——长输出配置下会早于 80% 平比）、距触发线还有多少 tokensUntilThreshold。在长任务中定期调用本工具检查水位：remainingRatio 低于 20% 时，把重要状态（结论/决定/未竟事项）用 note_write 外化保存，并考虑提前收尾——压缩会丢细节，外化不丢。无参数调用即可。",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
    async execute(): Promise<{ content: string }> {
      const s = getSnapshot();
      const used = Math.max(
        estimateTokens(s.systemPrompt, s.tools, s.messages),
        s.lastUsagePromptTokens ?? 0,
      );
      const window = s.contextWindowTokens;
      const threshold = resolveCompactionThresholdTokens({
        windowTokens: window,
        ...(s.threshold ?? {}),
      });
      const remainingTokens = Math.max(0, window - used);
      const remainingRatio = window > 0 ? used >= window ? 0 : 1 - used / window : 0;
      const tokensUntilThreshold = Math.max(0, threshold - used);
      const pct = (r: number): string => `${Math.round(r * 100)}%`;
      const lines = [
        `windowTokens: ${window}`,
        `promptTokens: ${used}`,
        `remainingTokens: ${remainingTokens} (remainingRatio: ${pct(remainingRatio)})`,
        `compressionThreshold: ${threshold} (tokensUntilThreshold: ${tokensUntilThreshold})`,
      ];
      // the upstream project的水位线广播语义收进工具本体：低于 20% 时给一条行动建议
      // （外化/收尾——advisory-only，同 GoalState 的只建议不强制纪律）。
      if (remainingRatio < 0.2) {
        lines.push(`⚠ 剩余已低于 20%：建议用 note_write 外化重要状态，并考虑提前收尾（建议，非强制）。`);
      }
      if (tokensUntilThreshold === 0) {
        lines.push(`⚠ 已到/越过压缩触发线：下一轮模型调用前会自动压缩——如有关键细节，现在就外化。`);
      }
      return { content: lines.join("\n") };
    },
  });
}
