// M55 §A3 — /cost: session totals from the accumulated usage events. The
// driver accumulates these from its LoopEvent stream (every `usage` event the
// provider reported); the REPL adapts the cache-tracking model's CacheStats
// via usageTotalsFromStats. Pure accumulation + formatting; the wall clock is
// injected so tests stay deterministic.
import type { CachePricing, ModelUsage } from "@wudao-org/core";
import { catalogPricesFor, deriveCachePricing, type ModelPrices } from "@wudao-org/providers";
import { formatCachePercent } from "../cache.js";
import type { CacheStats } from "../cache.js";
import { appendCostLedgerRow } from "./wallet.js";
import type { CostLedgerRow } from "./wallet.js";

/** Session-cumulative usage counters (immutable records; recordUsage folds). */
export interface SessionUsageTotals {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly calls: number;
  /** M61 §3: tokens spent by the /goal evaluator's calls — its own column in
   *  the turn_usage receipt (never folded into the agent's own totals). */
  readonly evaluatorTokens: number;
}

export function emptyUsageTotals(): SessionUsageTotals {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, calls: 0, evaluatorTokens: 0 };
}

/** Fold one provider usage report into the running totals. */
export function recordUsage(totals: SessionUsageTotals, usage: ModelUsage): SessionUsageTotals {
  // M61 review fix: an EVALUATOR row (the /goal transcript judgment) rides
  // ONLY its own column — it never folds into the shared calls/token/cache
  // totals. Each evaluator call is structurally cold (a fresh judge prompt),
  // so folding it would drag /cost's cache% — the M24 architectural metric —
  // and inflate the agent's own numbers.
  if (usage.evaluatorTokens !== undefined) {
    return { ...totals, evaluatorTokens: totals.evaluatorTokens + usage.evaluatorTokens };
  }
  return {
    promptTokens: totals.promptTokens + usage.promptTokens,
    completionTokens: totals.completionTokens + (usage.completionTokens ?? 0),
    cacheHitTokens: totals.cacheHitTokens + usage.cacheHitTokens,
    cacheMissTokens: totals.cacheMissTokens + usage.cacheMissTokens,
    calls: totals.calls + 1,
    evaluatorTokens: totals.evaluatorTokens,
  };
}

/** Adapt the REPL's cache-tracking model stats into the same totals shape. */
export function usageTotalsFromStats(stats: CacheStats): SessionUsageTotals {
  return {
    promptTokens: stats.promptTokens,
    completionTokens: stats.completionTokens,
    cacheHitTokens: stats.hitTokens,
    cacheMissTokens: Math.max(0, stats.promptTokens - stats.hitTokens),
    calls: stats.callCount,
    evaluatorTokens: 0,
  };
}

function kib(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** `4m 12s` / `38s` — wall duration since the session started. */
export function formatWallDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** The /cost report (notice-rendered). `-- ` before the session had any
 *  provider usage, matching the cache footer's noise convention.
 *  M56 §3: with a cost summary (the session's CostRegistry), priced turns
 *  render a `$` line and unpriced turns render the unpriced ≠ free note. */
export function formatCostReport(
  totals: SessionUsageTotals,
  opts: { readonly startedAt: number; readonly now?: () => number; readonly cost?: CostSummary },
): string {
  if (totals.calls === 0) {
    return `费用（本次会话）：尚无用量——首次模型调用后再执行 /cost`; // ω99-187: #1
  }
  const now = opts.now ?? Date.now;
  const lines = [
    "费用（本次会话）：", // ω99-187: #2
    `  模型调用：${totals.calls}`, // ω99-187: #3
    `  输入 tokens：${kib(totals.promptTokens)}（缓存命中 ${kib(totals.cacheHitTokens)} · 未命中 ${kib(totals.cacheMissTokens)} · 缓存 ${formatCachePercent(totals.cacheHitTokens, totals.promptTokens)}）`, // ω99-187: #4
    `  输出 tokens：${kib(totals.completionTokens)}`, // ω99-187: #5
    `  用时：${formatWallDuration(now() - opts.startedAt)}（自会话开始）`, // ω99-187: #6
  ];
  const cost = opts.cost;
  if (cost !== undefined && cost.calls > 0 && cost.costUsd !== null) {
    lines.push(`  花费：$${usd(cost.costUsd)}（${cost.pricedTurns}/${cost.calls} 轮已计价）`); // ω99-187: #7
  }
  if (cost !== undefined && cost.unpricedTurns > 0) {
    lines.push(
      `  未计价：${cost.unpricedTurns} 轮（模型 ${cost.unpricedModels.join(", ")}）——未计价 ≠ 免费（缺少花费数据；按每百万 tokens 美元设置 WUDAO_PRICE_<MODEL>=in,out,cacheRead,cacheWrite）`, // ω99-187: #8
    );
  }
  if (totals.evaluatorTokens > 0) {
    lines.push(`  评审：${kib(totals.evaluatorTokens)} tokens（/goal 转录判定）`); // ω99-187: #9
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// M56 §3 — the cost stack core (a reference harness cost_status, pragmatic v1).
//
// Per-session ledger of per-call rows; the price table comes from env
// WUDAO_PRICE_<MODEL> = "in,out,cacheRead,cacheWrite" (per-M-USD). The
// completeness rule is the whole point: a money-metered turn whose model has
// no price entry is UNPRICED, not free — the row is recorded with cost null,
// the summary counts it as missing spend, and /cost says so. Scope isolation
// is by construction: one registry per session; P0-4 (96 队列) adds the
// sessionEnd flush into the cross-session wallet ledger (wallet.ts).
// ---------------------------------------------------------------------------

/** Per-model price entry (per-M-USD: input, output, cache-read, cache-write). */
export interface PriceEntry {
  readonly inputPerM: number;
  readonly outputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM: number;
}

/** The env var a model's price lives under (non-alphanumerics fold to `_`). */
export function priceEnvName(model: string): string {
  return `WUDAO_PRICE_${model.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/** Parse "in,out,cacheRead,cacheWrite per-M-USD". Malformed lines are
 *  UNPRICED (undefined) — never guessed into a rate. */
export function parsePriceEntry(raw: string): PriceEntry | undefined {
  const parts = raw.split(",").map((p) => p.trim());
  if (parts.length !== 4) return undefined;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return undefined;
  return { inputPerM: nums[0]!, outputPerM: nums[1]!, cacheReadPerM: nums[2]!, cacheWritePerM: nums[3]! };
}

/** The env's price table. Keys are the env suffix lowercased
 *  (`WUDAO_PRICE_DEEPSEEK_V4_FLASH` → `deepseek_v4_flash`); lookups fold the
 *  model id with the SAME rule, so `-`/`.`/`_` all meet at one spelling. */
export function parsePriceTable(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, PriceEntry> {
  const table = new Map<string, PriceEntry>();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith("WUDAO_PRICE_") || value === undefined || value === "") continue;
    const entry = parsePriceEntry(value);
    if (entry === undefined) continue;
    table.set(key.slice("WUDAO_PRICE_".length).toLowerCase(), entry);
  }
  return table;
}

/** The price of a model under a table: exact id, else the folded form. */
function priceFor(table: ReadonlyMap<string, PriceEntry>, model: string): PriceEntry | undefined {
  return table.get(model) ?? table.get(model.toLowerCase().replace(/[^a-z0-9]/g, "_"));
}

// ---------------------------------------------------------------------------
// 借鉴弧 B1（a reference project C1）— 压缩经济学的定价解析。ratio 不手填（N7 负裁决的
// 正面侧）：catalog pin（registry models[].prices，文档核实才钉）>
// WUDAO_PRICE_<MODEL> env（/cost 的既有价目约定）> 保守缺省；来源类型化在
// ratioSource 上，不暴露为用户配置。纯函数。
// ---------------------------------------------------------------------------

/** 一个 run 的压缩经济学定价事实（driver 在 run 起点解析一次）。env 必传
 *  （纯函数——测试传 {}；driver 传 process.env）。 */
export function resolveRunCachePricing(input: {
  readonly provider?: string;
  readonly model?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly profiles?: ReadonlyMap<string, { readonly models: readonly { readonly name: string; readonly prices?: ModelPrices }[] }>;
}): CachePricing {
  const model = input.model?.trim();
  if (model === undefined || model === "") return deriveCachePricing({});
  const catalog = input.profiles?.get(input.provider ?? "")?.models;
  const envEntry = parsePriceTable(input.env);
  const priced = envEntry.size > 0 ? priceFor(envEntry, model) : undefined;
  return deriveCachePricing({
    ...(catalog !== undefined && catalog.length > 0 ? { catalog: catalogPricesFor(catalog, model) } : {}),
    ...(priced !== undefined ? { env: priced } : {}),
  });
}

/** Disjoint billing classes: (miss - write) at input, write at cache-write,
 *  hit at cache-read, completion at output — never summed twice. */
export function usageCostUsd(u: ModelUsage, price: PriceEntry): number {
  const write = u.cacheWriteTokens ?? 0;
  const inputBilled = Math.max(0, u.cacheMissTokens - write);
  const micro =
    inputBilled * price.inputPerM
    + u.cacheHitTokens * price.cacheReadPerM
    + write * price.cacheWritePerM
    + (u.completionTokens ?? 0) * price.outputPerM;
  return micro / 1e6;
}

/** One recorded call: who ran it and what it cost (null = unpriced). */
export interface CostRow {
  readonly model: string;
  readonly provider?: string;
  readonly usage: ModelUsage;
  readonly costUsd: number | null;
}

/** Session-cumulative cost + completeness (a reference harness's priced/unpriced split). */
export interface CostSummary {
  readonly calls: number;
  readonly pricedTurns: number;
  readonly unpricedTurns: number;
  /** Null when NOTHING could be priced (never a fake $0). */
  readonly costUsd: number | null;
  readonly unpricedModels: readonly string[];
}

/** The per-session ledger. Construct one per session (/new starts fresh);
 *  rows live only as long as the session does — EXCEPT the sessionEnd flush
 *  below, which folds them into the cross-session wallet ledger. */
export class CostRegistry {
  private readonly prices: ReadonlyMap<string, PriceEntry>;
  private readonly ledger: CostRow[] = [];
  /** P0-4: set by the first flushToLedger — sessionEnd can fire repeatedly
   *  (clear / resume / exit), and a second flush would double-account. */
  private flushed = false;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.prices = parsePriceTable(env);
  }

  /** Append one per-call row (the /cost $ line's source of truth). */
  record(row: { readonly model: string; readonly provider?: string; readonly usage: ModelUsage }): void {
    const price = priceFor(this.prices, row.model);
    this.ledger.push({
      model: row.model,
      ...(row.provider !== undefined ? { provider: row.provider } : {}),
      usage: row.usage,
      costUsd: price === undefined ? null : usageCostUsd(row.usage, price),
    });
  }

  get rows(): readonly CostRow[] {
    return this.ledger;
  }

  summary(): CostSummary {
    let pricedTurns = 0;
    let unpricedTurns = 0;
    let costUsd = 0;
    const unpricedModels = new Set<string>();
    let anyPriced = false;
    for (const row of this.ledger) {
      if (row.costUsd === null) {
        unpricedTurns += 1;
        unpricedModels.add(row.model);
      } else {
        pricedTurns += 1;
        anyPriced = true;
        costUsd += row.costUsd;
      }
    }
    return {
      calls: this.ledger.length,
      pricedTurns,
      unpricedTurns,
      costUsd: anyPriced ? costUsd : null,
      unpricedModels: [...unpricedModels],
    };
  }

  /** P0-4 (96 队列): fold the session's rows into the cross-session wallet
   *  ledger at `.wudao/costs.jsonl`. One row per (model, provider,
   *  priced-ness) — priced and unpriced rows NEVER share a line (the priced
   *  row carries the summed costUsd, the unpriced row carries costUsd null
   *  and its own call count). Returns the row count written. Idempotent: the
   *  first call wins, every later call returns 0 (sessionEndHook can fire
   *  repeatedly). An empty registry writes NOTHING (no file is created).
   *  Sync fs on purpose — the flush rides teardown/exit seams where queued
   *  async writes are unreliable. */
  flushToLedger(workspaceRoot: string, sessionId: string, now: () => Date = () => new Date()): number {
    if (this.flushed) return 0;
    this.flushed = true;
    if (this.ledger.length === 0) return 0;
    type Fold = {
      model: string; provider?: string; priced: boolean;
      calls: number; promptTokens: number; completionTokens: number;
      cacheHitTokens: number; cacheMissTokens: number; costUsd: number;
    };
    const folds = new Map<string, Fold>();
    for (const row of this.ledger) {
      const key = `${row.model} ${row.provider ?? ""} ${row.costUsd === null ? "u" : "p"}`;
      const fold = folds.get(key) ?? {
        model: row.model,
        ...(row.provider !== undefined ? { provider: row.provider } : {}),
        priced: row.costUsd !== null,
        calls: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, costUsd: 0,
      };
      fold.calls += 1;
      fold.promptTokens += row.usage.promptTokens;
      fold.completionTokens += row.usage.completionTokens ?? 0;
      fold.cacheHitTokens += row.usage.cacheHitTokens;
      fold.cacheMissTokens += row.usage.cacheMissTokens;
      if (row.costUsd !== null) fold.costUsd += row.costUsd;
      folds.set(key, fold);
    }
    const ts = now().toISOString();
    let written = 0;
    for (const fold of folds.values()) {
      const out: CostLedgerRow = {
        ts,
        sessionId,
        model: fold.model,
        ...(fold.provider !== undefined ? { provider: fold.provider } : {}),
        calls: fold.calls,
        promptTokens: fold.promptTokens,
        completionTokens: fold.completionTokens,
        cacheHitTokens: fold.cacheHitTokens,
        cacheMissTokens: fold.cacheMissTokens,
        costUsd: fold.priced ? fold.costUsd : null,
      };
      appendCostLedgerRow(workspaceRoot, out);
      written += 1;
    }
    return written;
  }
}

/** `$0.000776` — 2 decimals once costs reach a dollar, 6 below it. */
function usd(v: number): string {
  return v >= 1 ? v.toFixed(2) : v.toFixed(6);
}
