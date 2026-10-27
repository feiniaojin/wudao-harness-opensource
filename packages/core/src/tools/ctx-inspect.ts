// M52 §3 — ctx_inspect: the model sees its own token budget for the first
// time. Read-only, zero side effects: it snapshots the CURRENT occupancy
// (system / tools / messages / compaction state / window) through the same
// estimateTokens math the compactor and the status bar use, so the model, the
// human, and the harness never disagree about "how full is the context".
import { buildTool } from "../tool.js";
import type { Tool } from "../tool.js";
import type { ModelToolDefinition } from "../tool.js";
import type { AgentMessage } from "../types.js";
import { occupancyBreakdown } from "../compaction.js";
import type { OccupancyBreakdown } from "../compaction.js";

/** The live seam the tool reads at execution time (late-bound — tools are
 *  built before the AgentState exists). */
export interface CtxInspectSnapshot {
  readonly systemPrompt: string;
  /** The tool defs as the provider sees them (defer-aware where wired). */
  readonly tools: readonly ModelToolDefinition[];
  readonly messages: readonly AgentMessage[];
  readonly contextWindowTokens: number;
  /** The provider's last REAL prompt size (usage.promptTokens), when known —
   *  beats the estimate the same way the loop's trigger does. */
  readonly lastUsagePromptTokens?: number;
}

export function createCtxInspectTool(getSnapshot: () => CtxInspectSnapshot): Tool {
  return buildTool({
    name: "ctx_inspect",
    description:
      "Inspect the current context occupancy: token breakdown by segment (system prompt, tool definitions, messages by role, images), compaction state (summaries/stubs/cleared markers), the context window, and remaining headroom. Read-only; use it before planning large reads or when a compaction just happened.",
    parameters: { type: "object", properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(): Promise<{ content: string }> {
      const s = getSnapshot();
      const b: OccupancyBreakdown = occupancyBreakdown(s.systemPrompt, s.tools, s.messages);
      const used = Math.max(b.totalTokens, s.lastUsagePromptTokens ?? 0);
      const window = s.contextWindowTokens;
      const pct = window > 0 ? Math.round((used / window) * 100) : 0;
      const lines = [
        `context occupancy: ${used} / ${window} tokens (${pct}%)`,
        `  system: ${b.systemTokens} · tools: ${b.toolsTokens} · messages: ${b.messagesTokens} (${b.messageCount} messages)`,
        // R5-I1: the image line rides along ONLY when images exist — text-only
        // sessions render the exact pre-R5-I1 bytes.
        ...(b.imageCount > 0
          ? [`  images: ~${b.imagesTokens} (${b.imageCount} image${b.imageCount === 1 ? "" : "s"}, est. — base + bytes/750 per image)`]
          : []),
        `  messages by role: user ${b.messagesByRole.user} · assistant ${b.messagesByRole.assistant} · tool ${b.messagesByRole.tool}`,
        `  compaction state: ${b.compaction.summaries} summary marker(s) · ${b.compaction.stubbed} stubbed · ${b.compaction.cleared} cleared · ${b.compaction.skillPruned} pruned skill reads`,
        `  headroom: ${Math.max(window - used, 0)} tokens${pct >= 80 ? " — at/over the 80% compaction threshold" : ""}`,
      ];
      return { content: lines.join("\n") };
    },
  });
}
