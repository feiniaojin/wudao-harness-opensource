// P0-1 (永续迭代) — per-turn prefix-cache WASTE attribution notice (the the upstream project// cache-stats port). Where cold-cache.ts predicts a cold prefix BEFORE a run
// starts (idle/identity rules, pre-send), this module attributes the waste
// AFTER the tokens were spent: the previous request's prompt SHOULD have been
// read from cache (it was in the previous turn's prompt — the M24 append-only
// invariant guarantees the bytes never moved), so whatever the provider
// re-billed instead of cache-reading is waste with a nameable cause.
//
// Semantics ported from the upstream project's core/cache-stats.ts (detectMiss):
//   missedTokens = min(prev.promptTokens, curr.promptTokens) - curr.cacheHit
//   (min: a shrinking prompt — a branch cut — only re-bills what it still
//   contains); misses at or below 1024 tokens are breakpoint-granularity
//   noise; a provider that never reports cache splits is silent (every turn
//   would otherwise read as a total miss); attribution precedence is
//   model-switch > idle≥TTL > plain miss (the upstream project's label order).
// Wudao adaptations (documented divergences):
//   - a coldTurnExpected row (a compaction / provider-switch prefix rewrite
//     — already receipted as `[cold: …]` in the usage line + the
//     context_window JSONL entry) is never waste here;
//   - the idle TTL is injectable: a provider with a DOCUMENTED window in
//     COLD_CACHE_POLICIES (DeepSeek: days, not minutes) uses it, everyone
//     else gets the upstream project's 5-minute default — wrong-window estimates erode trust
//     (the ω-5a I23 rule);
//   - notices are per-CAUSE deduped per session (≤3 per session) instead of
//     the upstream project's per-message transcript lines — a light hint, never a flood.
// Purely observational: nothing here touches request bytes (M24 untouched).
// No pricing table exists in this codebase, so the report carries tokens
// only (the optional missedCost field is reserved for when one lands).

/** Prompt-cache TTL for idle attribution (the upstream projectport; Anthropic default 5min).
 *  The wiring overrides this with a provider's documented window when one
 *  exists (DeepSeek: 3 days, read as the maximum bound). */
export const CACHE_TTL_MS = 5 * 60 * 1000;

/** Per-turn misses at or below this are cache breakpoint granularity noise. */
export const CACHE_WASTE_NOISE_FLOOR_TOKENS = 1024;

/** Why the prefix was re-billed. Precedence: model_changed > effort_changed >
 *  idle > miss (ω99-53 ruling: a model switch fully explains the miss on its
 *  own, and the effort value follows the provider config across a switch, so
 *  effort-first would systematically shadow model switches). coldTurnExpected
 *  outranks them all via the early return — an expected cold is receipted
 *  elsewhere, never waste. */
export type CacheWasteCause = "idle" | "model_changed" | "effort_changed" | "miss";

/** A counted cache waste on one model call (the upstream projectCacheMiss + a cause). */
export interface CacheWasteReport {
  /** Prompt tokens that were in the previous request's prompt but not read from cache. */
  readonly missedTokens: number;
  /** Milliseconds since the previous observed row (clamped at 0). */
  readonly idleMs: number;
  /** True when the model key changed relative to the previous row. */
  readonly modelChanged: boolean;
  /** ω99-53: true when both rows report an effort and the values differ.
   *  Present only on that shape (a one-sided effort never attributes). */
  readonly effortChanged?: boolean;
  /** ω99-53: the two efforts compared, present iff effortChanged. */
  readonly prevEffort?: string;
  /** ω99-53: see prevEffort. */
  readonly currEffort?: string;
  /** The attribution (model switch wins over idle, the upstream project's label order). */
  readonly cause: CacheWasteCause;
  /** Extra cost vs. a full cache hit; reserved (no pricing table yet). */
  readonly missedCost?: number;
}

/** One observed main-loop usage row, shaped for the pure core. `at` is the
 *  observation time (epoch ms); `modelKey` is the ANSWERING model's identity
 *  (provider/model — /model switches and failovers both move it). */
export interface CacheWasteTurn {
  readonly promptTokens: number;
  readonly cacheHitTokens: number;
  /** Present only when the wire actually reported a cache split — the
   *  "this provider does caching" signal (the the upstream projectreportedCache guard). */
  readonly cacheWriteTokens?: number;
  /** The row rode a freshly rewritten prefix (compaction / provider switch) —
   *  the cold turn is expected and receipted elsewhere. */
  readonly coldTurnExpected?: boolean;
  /** ω99-53: the reasoning effort THIS row ran at (the live provider config's
   *  level; the JSONL assistant trail is the same value's durable face).
   *  Absent = untracked — a one-sided comparison never attributes. */
  readonly effort?: string;
  readonly modelKey: string;
  readonly at: number;
}

/** What the monitor remembers between rows (the upstream projectPreviousRequest). */
export interface CacheWasteBaseline {
  readonly promptTokens: number;
  readonly modelKey: string;
  readonly at: number;
  /** Sticky: some row at or before the previous one reported cache activity. */
  readonly reportedCache: boolean;
  /** ω99-53: the previous row's effort, carried for the next comparison. */
  readonly effort?: string;
}

/** Did THIS row's wire spelling say anything about caching? */
function reportsCacheSplit(t: Pick<CacheWasteTurn, "cacheHitTokens" | "cacheWriteTokens">): boolean {
  return t.cacheHitTokens > 0 || t.cacheWriteTokens !== undefined;
}

/**
 * Attribute one turn's prefix re-billing against the previous request.
 * Returns null when nothing is counted: no baseline, a zero-prompt row, an
 * expected cold turn, a provider that never reports caching, or a miss at or
 * below the 1024-token noise floor.
 */
export function analyzeCacheWaste(
  prev: CacheWasteBaseline | undefined,
  curr: CacheWasteTurn,
  idleTtlMs: number = CACHE_TTL_MS,
): CacheWasteReport | null {
  if (prev === undefined) return null;
  if (curr.promptTokens <= 0) return null;
  // the upstream project's guard, inverted: a zero-cache row only counts when the wire (this
  // row, or some earlier one via the sticky baseline) has shown cache
  // splits — otherwise the provider just doesn't report caching.
  if (!reportsCacheSplit(curr) && !prev.reportedCache) return null;
  // An expected cold turn (compaction / provider-switch rewrite) is already
  // receipted; it is new prefix, not re-billed prefix.
  if (curr.coldTurnExpected === true) return null;

  const missedTokens = Math.min(prev.promptTokens, curr.promptTokens) - curr.cacheHitTokens;
  if (missedTokens <= CACHE_WASTE_NOISE_FLOOR_TOKENS) return null;

  const idleMs = Math.max(0, curr.at - prev.at);
  const modelChanged = curr.modelKey !== prev.modelKey;
  // ω99-53: an effort switch changed the request shape (and with it the
  // prefix-cache key) — countable only when BOTH rows report an effort; a
  // one-sided comparison (untracked turns, pre-upgrade sessions) stays on
  // the existing chain instead of guessing.
  const effortChanged = prev.effort !== undefined && curr.effort !== undefined && curr.effort !== prev.effort;
  const cause: CacheWasteCause = modelChanged
    ? "model_changed"
    : effortChanged
      ? "effort_changed"
      : idleMs >= idleTtlMs
        ? "idle"
        : "miss";
  return {
    missedTokens,
    idleMs,
    modelChanged,
    ...(effortChanged ? { effortChanged: true, prevEffort: prev.effort, currEffort: curr.effort } : {}),
    cause,
  };
}

/** The next baseline from an observed row (null on a zero-prompt row — keep
 *  the previous baseline; the upstream projectasPreviousRequest). `stickyReportedCache` is the
 *  OR of everything seen before this row. */
export function asCacheWasteBaseline(curr: CacheWasteTurn, stickyReportedCache: boolean): CacheWasteBaseline | null {
  if (curr.promptTokens <= 0) return null;
  return {
    promptTokens: curr.promptTokens,
    modelKey: curr.modelKey,
    at: curr.at,
    reportedCache: stickyReportedCache || reportsCacheSplit(curr),
    ...(curr.effort !== undefined ? { effort: curr.effort } : {}),
  };
}

/** Token magnitude for the notice: raw under 1k, k under 1M, M above. */
export function formatWasteTokens(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${Math.round(n / 100) / 10}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatIdleSpan(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)} 小时`;
  return `${(minutes / (24 * 60)).toFixed(1)} 天`;
}

/** The one-line Chinese notice (user-facing; the ❄️ cold-cache form). */
export function formatCacheWasteNotice(report: CacheWasteReport): string {
  const reBilled = `约 ${formatWasteTokens(report.missedTokens)} tokens 重新计费`;
  if (report.cause === "model_changed") return `🔁 模型切换后前缀缓存未命中 — ${reBilled}`;
  if (report.cause === "effort_changed") return `⚡ 推理档切换（${report.prevEffort ?? "?"} → ${report.currEffort ?? "?"}）后前缀缓存未命中 — ${reBilled}`;
  if (report.cause === "idle") return `⏳ 空闲 ${formatIdleSpan(report.idleMs)}后前缀缓存未命中 — ${reBilled}`;
  return `⚠️ 前缀缓存未命中（原因未明） — ${reBilled}`;
}

/** One per session (the session engine owns it): fed by the cache wrapper's
 *  per-turn channel (MAIN calls only — side calls ride other prefixes), it
 *  keeps the previous request's baseline and mutes per-CAUSE duplicates
 *  (each attribution class notifies at most once per session; a model-switch
 *  report can therefore only land on a switch row, and only the first one).
 *  The baseline advances through EVERY row — muting a notice never freezes
 *  the comparison point. */
export class CacheWasteMonitor {
  private baseline: CacheWasteBaseline | undefined;
  private readonly reportedCauses = new Set<CacheWasteCause>();

  constructor(private readonly idleTtlMs: number = CACHE_TTL_MS) {}

  /** Observe one main-call row; returns the report when it is the FIRST of
   *  its cause this session, else null (deduped or no waste). */
  noteUsage(curr: CacheWasteTurn): CacheWasteReport | null {
    const report = analyzeCacheWaste(this.baseline, curr, this.idleTtlMs);
    const baseline = asCacheWasteBaseline(curr, this.baseline?.reportedCache ?? false);
    if (baseline !== null) this.baseline = baseline;
    if (report === null || this.reportedCauses.has(report.cause)) return null;
    this.reportedCauses.add(report.cause);
    return report;
  }
}
