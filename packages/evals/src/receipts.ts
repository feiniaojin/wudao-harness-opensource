// ω-5a I18 — per-trial eval receipts (the the upstream harness import): a failing
// trial used to vanish with its temp dir; the report kept status + error
// strings only. A receipt moves the trial's workspace OUT of tmp before the
// runner's cleanup and drops a receipt.json beside it with the joinable
// evidence: failure class, errors, duration, terminal reason, tool-call
// order, per-row usage. Duck-typed on the live evidence shape — missing
// fields are omitted, never fabricated; no env, no API keys, no workspace
// file contents ride the receipt (events carry tool RESULT text only via
// the already-capped previews the suites choose to keep).
import { mkdir, readdir, rename, rm, stat, writeFile, cp } from "node:fs/promises";
import { join } from "node:path";

/** How many receipt directories survive pruning (the last N by mtime). */
export const DEFAULT_RECEIPT_KEEP = 20;

export interface EvalReceipt {
  readonly name: string;
  readonly trial: number;
  readonly kind: string;
  readonly status: string;
  readonly failureClass?: string;
  readonly errors: readonly string[];
  readonly durationMs: number;
  readonly metrics?: Record<string, number>;
  /** terminal?.reason when the loop settled. */
  readonly terminalReason?: string;
  /** Tool names in order (started events). */
  readonly toolCalls: readonly string[];
  /** Per-row usage (the loop's usage events, in order). */
  readonly usage: readonly {
    readonly turn: number;
    readonly promptTokens: number;
    readonly cacheHitTokens: number;
    readonly cacheMissTokens: number;
  }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function numRecord(v: unknown): Record<string, number> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "number" && Number.isFinite(val)) out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build a receipt from duck-typed evidence: the runner merges the RESULT
 *  fields (kind/status/failureClass/errors/durationMs/metrics) over the
 *  eval's raw evidence (terminal/events) — anything absent is omitted,
 *  never fabricated. Pure. */
export function buildReceipt(name: string, trial: number, evidence: unknown): EvalReceipt {
  const e = isRecord(evidence) ? evidence : {};
  const terminal = isRecord(e.terminal) ? e.terminal : undefined;
  const events = Array.isArray(e.events) ? e.events : [];
  const toolCalls: string[] = [];
  const usage: { turn: number; promptTokens: number; cacheHitTokens: number; cacheMissTokens: number }[] = [];
  for (const ev of events) {
    if (!isRecord(ev)) continue;
    if (ev.type === "tool_call_started" && typeof ev.toolName === "string") toolCalls.push(ev.toolName);
    if (ev.type === "usage" && isRecord(ev.usage)) {
      const u = ev.usage;
      usage.push({
        turn: usage.length + 1,
        promptTokens: num(u.promptTokens),
        cacheHitTokens: num(u.cacheHitTokens),
        cacheMissTokens: num(u.cacheMissTokens),
      });
    }
  }
  const metrics = numRecord(e.metrics);
  return {
    name,
    trial,
    kind: typeof e.kind === "string" ? e.kind : "unknown",
    status: typeof e.status === "string" ? e.status : "unknown",
    ...(typeof e.failureClass === "string" ? { failureClass: e.failureClass } : {}),
    errors: Array.isArray(e.errors) ? e.errors.filter((x): x is string => typeof x === "string") : [],
    durationMs: num(e.durationMs),
    ...(metrics !== undefined ? { metrics } : {}),
    ...(terminal !== undefined && typeof terminal.reason === "string" ? { terminalReason: terminal.reason } : {}),
    toolCalls,
    usage,
  };
}

/** Move the trial's workspace to `<outRoot>/<iso>-<name>-t<trial>/` and write
 *  receipt.json inside it. Sync-free but crash-tolerant: rename first (EXDEV
 *  falls back to copy+remove — tmp and the workspace may cross devices).
 *  Returns the receipt directory path. */
export async function preserveReceipt(dir: string, receipt: EvalReceipt, outRoot: string): Promise<string> {
  await mkdir(outRoot, { recursive: true });
  const iso = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const safeName = receipt.name.replace(/[^A-Za-z0-9_-]/g, "_");
  const dest = join(outRoot, `${iso}-${safeName}-t${receipt.trial}`);
  try {
    await rename(dir, dest);
  } catch {
    await cp(dir, dest, { recursive: true });
    await rm(dir, { recursive: true, force: true });
  }
  await writeFile(join(dest, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return dest;
}

/** Keep the last `keep` receipt directories (mtime order, oldest removed
 *  first); returns how many were removed. Missing outRoot → 0. */
export async function pruneReceipts(outRoot: string, keep: number): Promise<number> {
  let entries;
  try {
    entries = await readdir(outRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  const dirs = entries.filter((d) => d.isDirectory());
  const stamped = await Promise.all(
    dirs.map(async (d) => ({ name: d.name, mtime: (await stat(join(outRoot, d.name))).mtimeMs })),
  );
  stamped.sort((a, b) => a.mtime - b.mtime);
  const excess = stamped.slice(0, Math.max(0, stamped.length - keep));
  for (const d of excess) {
    await rm(join(outRoot, d.name), { recursive: true, force: true });
  }
  return excess.length;
}
