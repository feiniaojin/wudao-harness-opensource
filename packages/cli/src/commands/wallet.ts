// P0-4 (96 队列) — the cross-session spend ledger + the /cost all wallet
// face. cost.ts keeps the per-session CostRegistry (priced/unpriced split,
// env price table); this module is the PERSISTENT half: `.wudao/costs.jsonl`
// (append-only JSONL, one row per session × model × priced-ness, flushed at
// the sessionEnd boundary), the aggregate fold behind `/cost all`, the report
// renderer, and the provider wallet-balance fetch (three states: unconfigured
// → silently omitted / failure → one line / success → one line per currency).
// The unpriced ≠ free discipline is inherited verbatim: an all-unpriced fold
// is costUsd null, never a fake $0; balance amounts are the API's strings —
// money never enters a float here.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchProviderBalance } from "@wudao/providers";
import type { ProviderBalance } from "@wudao/providers";
import { parseApiKeyPool } from "@wudao/providers";
import { loadEffectiveProfiles } from "../provider-registry.js";
import { readCredentialsFileSync } from "../credentials.js";

/** One persisted ledger row: a session's per-(model, priced-ness) fold.
 *  `costUsd: null` = unpriced (missing spend, NOT free — cost.ts semantics). */
export interface CostLedgerRow {
  readonly ts: string; // ISO — the flush time
  readonly sessionId: string;
  readonly model: string;
  readonly provider?: string;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly costUsd: number | null;
}

/** The ledger's home: <root>/.wudao/costs.jsonl (append-only JSONL). */
export function costLedgerPath(root: string): string {
  return join(root, ".wudao", "costs.jsonl");
}

/** Append one row. SYNC fs on purpose — the flush rides the sessionEnd/exit
 *  seam, where queued async writes are unreliable (process may exit first). */
export function appendCostLedgerRow(root: string, row: CostLedgerRow): void {
  mkdirSync(join(root, ".wudao"), { recursive: true });
  appendFileSync(costLedgerPath(root), `${JSON.stringify(row)}\n`, "utf8");
}

/** Read the ledger, fault-tolerant by contract: a missing file is empty, a
 *  corrupt/half-written line is SKIPPED (hand edits and torn writes must never
 *  break the read side), and parsed rows are sanitized to the row shape so a
 *  hand-mangled field cannot poison the aggregate with NaN. Never throws. */
export function readCostLedger(root: string): CostLedgerRow[] {
  let text: string;
  try {
    text = readFileSync(costLedgerPath(root), "utf8");
  } catch {
    return []; // missing/unreadable — nothing spent on record here
  }
  const rows: CostLedgerRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue; // 坏行跳过不抛
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const o = parsed as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    rows.push({
      ts: typeof o.ts === "string" ? o.ts : "",
      sessionId: typeof o.sessionId === "string" ? o.sessionId : "",
      model: typeof o.model === "string" ? o.model : "",
      ...(typeof o.provider === "string" ? { provider: o.provider } : {}),
      calls: num(o.calls),
      promptTokens: num(o.promptTokens),
      completionTokens: num(o.completionTokens),
      cacheHitTokens: num(o.cacheHitTokens),
      cacheMissTokens: num(o.cacheMissTokens),
      costUsd: typeof o.costUsd === "number" && Number.isFinite(o.costUsd) ? o.costUsd : null,
    });
  }
  return rows;
}

/** One model's fold (the model line of the report). `costUsd` is the PRICED
 *  sum only; `unpricedCalls` carries the rest — the two never blend. */
export interface LedgerModelAggregate {
  readonly model: string;
  readonly calls: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly costUsd: number;
  readonly unpricedCalls: number;
}

/** The whole-ledger fold behind `/cost all`. `costUsd` is null when NOTHING
 *  could be priced (never a fake $0); models aggregate by MODEL id (provider
 *  rides the rows but is not a fold key — display granularity is enough). */
export interface LedgerAggregate {
  readonly models: readonly LedgerModelAggregate[];
  /** The raw row count (report label "ledger rows") — sessions fold to rows,
   *  rows fold to calls; the two differ once a row carries calls > 1. */
  readonly rows: number;
  readonly calls: number;
  readonly costUsd: number | null;
  readonly unpricedCalls: number;
}

export function aggregateCostLedger(rows: readonly CostLedgerRow[]): LedgerAggregate {
  const byModel = new Map<string, { model: string; calls: number; promptTokens: number; completionTokens: number; costUsd: number; unpricedCalls: number }>();
  let calls = 0;
  let unpricedCalls = 0;
  let costSum = 0;
  let anyPriced = false;
  for (const row of rows) {
    calls += row.calls;
    const entry = byModel.get(row.model) ?? {
      model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, unpricedCalls: 0,
    };
    entry.calls += row.calls;
    entry.promptTokens += row.promptTokens;
    entry.completionTokens += row.completionTokens;
    if (row.costUsd === null) {
      unpricedCalls += row.calls;
      entry.unpricedCalls += row.calls;
    } else {
      anyPriced = true;
      costSum += row.costUsd;
      entry.costUsd += row.costUsd;
    }
    byModel.set(row.model, entry);
  }
  return { models: [...byModel.values()], rows: rows.length, calls, costUsd: anyPriced ? costSum : null, unpricedCalls };
}

// Same formatters as cost.ts's kib/usd (本地同源复制 — importing them back
// would make cost.ts ⇄ wallet.ts circular; the implementations are frozen
// twins and both files note the pairing).
function kib(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}
function usd(v: number): string {
  return v >= 1 ? v.toFixed(2) : v.toFixed(6);
}

/** The `/cost all` report (notice-rendered, the /cost session view's English
 *  style). Ledger lines render FIRST; the balance section rides LAST and only
 *  when the caller has data for it (three states — omitted / error / success):
 *  a balance problem can never block the ledger above it. */
export function renderWalletReport(
  agg: LedgerAggregate,
  opts?: { readonly balance?: ProviderBalance | undefined; readonly balanceError?: string },
): string {
  const lines = [
    "费用（全部会话）：", // ω99-186: #1
    `  台账 ${agg.rows} 行（${agg.models.length} 个模型）`, // ω99-186: #2
  ];
  for (const m of agg.models) {
    const segs = [
      `${m.calls} 次调用`, // ω99-186: #3
      `${kib(m.promptTokens)} 输入`, // ω99-186: #4
      `${kib(m.completionTokens)} 输出`, // ω99-186: #5
    ];
    if (m.calls - m.unpricedCalls > 0) segs.push(`$${usd(m.costUsd)}`);
    if (m.unpricedCalls > 0) segs.push(`${m.unpricedCalls} 次未计价调用`); // ω99-186: #6
    lines.push(`  ${m.model}: ${segs.join(" · ")}`);
  }
  if (agg.calls > 0) {
    const total = agg.costUsd === null ? "无" : `$${usd(agg.costUsd)}`; // ω99-186: #7（仅 "none" 字面）
    lines.push(`  合计（已计价）：${total}${agg.unpricedCalls > 0 ? ` · 未计价 ${agg.unpricedCalls} 次调用——未计价 ≠ 免费` : ""}`); // ω99-186: #8（行内两处同改）
  }
  // Balance: success → one line per currency; failure → ONE line, first line
  // of the message; nothing supplied → the whole section is omitted.
  if (opts?.balance !== undefined) {
    for (const info of opts.balance.infos) {
      lines.push(
        `  余额：${info.currency} ${info.totalBalance}（赠送 ${info.grantedBalance} · 充值 ${info.toppedUpBalance}）· ${opts.balance.available ? "可用" : "不可用"}`, // ω99-186: #9（行内三元两态同改）
      );
    }
  } else if (opts?.balanceError !== undefined) {
    lines.push(`  余额：不可用（${opts.balanceError.split("\n")[0] ?? ""}）`); // ω99-186: #10（插值原样）
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The provider balance fetch (lazy, on `/cost all`): resolve the CURRENT
// provider's balanceUrl through the registry's effective view (builtin pin ⊕
// overlay ⊕ custom — a mid-session /provider switch is covered because this
// reads the live view, not the boot config), then fetch. Returns undefined =
// NOT CONFIGURED (silent omit, never an error); a fetch failure lands in
// balanceError (one report line); a success lands in balance.
// ---------------------------------------------------------------------------

/** What the balance face produced: `balance` XOR `balanceError`; an undefined
 *  RESULT (not an undefined field) means "no balance face — omit silently". */
export interface WalletBalanceOutcome {
  readonly balance?: ProviderBalance;
  readonly balanceError?: string;
}

/** Resolve + fetch the provider's wallet balance. Never throws: every failure
 *  folds into `balanceError` so /cost all's ledger rendering can't be blocked. */
export async function fetchWalletBalance(args: {
  readonly provider?: string;
  /** The live session key when the caller owns the config (the REPL); absent
   *  → env pool → the credentials file's entry for the provider. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WalletBalanceOutcome | undefined> {
  const provider = args.provider?.trim();
  if (provider === undefined || provider === "") return undefined;
  let balanceUrl: string | undefined;
  try {
    balanceUrl = loadEffectiveProfiles().get(provider)?.balanceUrl;
  } catch {
    return undefined; // a registry read failure is the omit state, not a wall of text
  }
  if (balanceUrl === undefined || balanceUrl === "") return undefined;
  const env = args.env ?? process.env;
  const apiKey = args.apiKey ?? parseApiKeyPool(env)[0] ?? (readCredentialsFileSync(env)[provider] ?? "").trim();
  try {
    const balance = await fetchProviderBalance(
      { balanceUrl, ...(apiKey !== "" ? { apiKey } : {}) },
      { ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}), ...(args.fetchImpl !== undefined ? { fetchImpl: args.fetchImpl } : {}) },
    );
    return balance === undefined ? undefined : { balance };
  } catch (err) {
    return { balanceError: err instanceof Error ? err.message : String(err) };
  }
}
