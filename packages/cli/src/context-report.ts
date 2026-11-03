// M52 §3 — /context: the occupancy report over the REAL projection pipeline
// (compact boundary → tier-0 clear → microcompact run FIRST, then counting),
// so the numbers match what the next model call would actually send. Pure —
// the driver, the REPL, and tests all share it. Breakdown dimensions: by
// segment/role (core occupancyBreakdown), per MCP server (tool results), and
// per system-prompt section (heading-split).
import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { applySummaryMarkers, clearTier, microcompact, occupancyBreakdown, toModelToolDefinition } from "@wudao-org/core";
import type { AgentMessage, OccupancyBreakdown, Tool } from "@wudao-org/core";

export interface ContextReportInput {
  readonly systemPrompt: string;
  readonly tools: readonly Tool[];
  readonly messages: readonly AgentMessage[];
  readonly contextWindowTokens: number;
  /** keepRecent for the projection tiers (default 6, the loop's default). */
  readonly keepRecent?: number;
  /** microcompact minChars (default the tool's own). */
  readonly minChars?: number;
}

export interface ContextReport {
  readonly breakdown: OccupancyBreakdown;
  /** Tool-result tokens grouped by source: `builtin` or the MCP server name
   *  (mcp__<server>__<tool>); descending, token counts are chars/4. */
  readonly bySource: readonly { readonly source: string; readonly tokens: number; readonly results: number }[];
  /** System-prompt tokens per `#`/`##` heading section (in prompt order). */
  readonly byPromptSection: readonly { readonly section: string; readonly tokens: number }[];
  readonly used: number;
  readonly window: number;
  readonly pct: number;
  readonly nearLimit: boolean;
  readonly projectedMessageCount: number;
}

const messageTokens = (m: AgentMessage): number =>
  Math.ceil(
    (m.content.length +
      (m.role === "assistant" && m.toolCalls
        ? m.toolCalls.reduce((n, tc) => n + JSON.stringify(tc.arguments).length, 0)
        : m.role === "tool"
          ? m.name.length
          : 0)) / 4,
  );

/** Build the /context report over the real projection. Pure. */
export function buildContextReport(input: ContextReportInput): ContextReport {
  const keepRecent = input.keepRecent ?? 6;
  const toolDefs = input.tools.map(toModelToolDefinition);
  // The real pipeline, in loop order: compact boundary (chain-aware summary
  // projection) → tier-0 clear → microcompact. Counting happens on the
  // RESULT, never on the raw history.
  const projected = microcompact(
    clearTier(applySummaryMarkers(input.messages, { chain: true }), { keepRecent }).messages,
    { keepRecent, ...(input.minChars !== undefined ? { minChars: input.minChars } : {}) },
  );
  const breakdown = occupancyBreakdown(input.systemPrompt, toolDefs, projected);

  // Tool results by source: builtin tools vs each MCP server.
  const source = new Map<string, { tokens: number; results: number }>();
  for (const m of projected) {
    if (m.role !== "tool") continue;
    const name = m.name;
    const bucket = name.startsWith("mcp__") ? `mcp__${name.split("__")[1] ?? "unknown"}` : "builtin";
    const cur = source.get(bucket) ?? { tokens: 0, results: 0 };
    source.set(bucket, { tokens: cur.tokens + messageTokens(m), results: cur.results + 1 });
  }
  const bySource = [...source.entries()]
    .map(([s, v]) => ({ source: s, tokens: v.tokens, results: v.results }))
    .sort((a, b) => b.tokens - a.tokens || a.source.localeCompare(b.source));

  // System prompt by heading section (# / ## lines head a section; the text
  // before the first heading is the preamble).
  const sections: { section: string; tokens: number }[] = [];
  {
    const lines = input.systemPrompt.split("\n");
    let current = "(preamble)";
    let chars = 0;
    const flush = (): void => {
      if (chars > 0 || sections.length === 0) sections.push({ section: current, tokens: Math.ceil(chars / 4) });
    };
    for (const line of lines) {
      const heading = /^(#{1,2} .*)$/.exec(line.trim());
      if (heading !== null) {
        flush();
        current = heading[1] ?? current;
        chars = line.length + 1;
        continue;
      }
      chars += line.length + 1;
    }
    flush();
  }

  const used = breakdown.totalTokens;
  const window = input.contextWindowTokens;
  const pct = window > 0 ? Math.round((used / window) * 100) : 0;
  return {
    breakdown,
    bySource,
    byPromptSection: sections,
    used,
    window,
    pct,
    nearLimit: used >= 0.8 * window,
    projectedMessageCount: projected.length,
  };
}

const fmt = (n: number): string => n.toLocaleString("en-US");

/** The human-facing /context text (driver notice / REPL stdout). */
export function formatContextReport(r: ContextReport): string {
  const lines = [
    `context: ${fmt(r.used)} / ${fmt(r.window)} tokens (${r.pct}%)${r.nearLimit ? " — near the 80% compaction threshold" : ""}`,
    // R5-I1: the images segment rides along ONLY when images exist — text-only
    // sessions render the exact pre-R5-I1 bytes.
    `segments: system ${fmt(r.breakdown.systemTokens)} · tools ${fmt(r.breakdown.toolsTokens)} · messages ${fmt(r.breakdown.messagesTokens)}${r.breakdown.imageCount > 0 ? ` · images ~${fmt(r.breakdown.imagesTokens)} (${r.breakdown.imageCount})` : ""} (${r.breakdown.messageCount} of ${r.projectedMessageCount} projected messages)`,
    `messages: user ${fmt(r.breakdown.messagesByRole.user)} · assistant ${fmt(r.breakdown.messagesByRole.assistant)} · tool ${fmt(r.breakdown.messagesByRole.tool)}`,
    `compaction: ${r.breakdown.compaction.summaries} summary · ${r.breakdown.compaction.stubbed} stubbed · ${r.breakdown.compaction.cleared} cleared · ${r.breakdown.compaction.skillPruned} pruned skill reads`,
  ];
  if (r.bySource.length > 0) {
    lines.push("tool results by source:");
    for (const s of r.bySource) lines.push(`  ${s.source.padEnd(24)} ${fmt(s.tokens).padStart(7)} (${s.results})`);
  }
  if (r.byPromptSection.length > 0) {
    lines.push("system prompt by section:");
    for (const s of r.byPromptSection) lines.push(`  ${truncateSafe(s.section, 34).padEnd(36)} ${fmt(s.tokens).padStart(7)}`);
  }
  lines.push("(projection: compact boundary → clear → microcompact — what the next model call sends)");
  return lines.join("\n");
}
