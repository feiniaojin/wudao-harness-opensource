// Eval runner: a deliberately tiny interface. One type + one runner — evals are
// scripts, not a framework. Every eval gets its own temp directory (the
// "template dir" it may fill with fixtures); the runner owns its lifecycle.
//
// ω-5a I18: thrown errors get a FAILURE CLASS (timeout/provider/harness —
// never guessed as "assertion"), results carry their 1-based trial index
// (the --runs numbering), and failing trials (or WUDAO_EVAL_KEEP=1) leave a
// receipt directory before the workspace is cleaned up.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReceipt, preserveReceipt, pruneReceipts, DEFAULT_RECEIPT_KEEP } from "./receipts.js";

export type EvalKind = "deterministic" | "live";

/** An eval definition. setup fills a fresh temp dir and returns a context;
 *  run drives the harness (loop, tools, sessions, ...) and returns evidence;
 *  assertions inspects the evidence and returns error strings — empty = pass;
 *  metrics (optional) extracts numeric measurements for the JSON report. */
export interface EvalDefinition<C = unknown, E = unknown> {
  readonly name: string;
  readonly kind: EvalKind;
  /** When set and returning a reason string, the eval is skipped (setup is NOT
   *  called). Used by live suites when no API key is present. */
  readonly skip?: () => string | undefined;
  setup(tmplDir: string): Promise<C>;
  run(ctx: C): Promise<E>;
  assertions(evidence: E): string[];
  /** M24: numeric evidence (cache hit rates, …) rolled into last.json. */
  metrics?(evidence: E): Record<string, number>;
}

/** ω-5a I18 — the failure taxonomy. "assertion" is never classified from a
 *  thrown error's shape: only non-empty assertions() output earns it. */
export type EvalFailureClass = "assertion" | "timeout" | "provider" | "harness";

/** Classify a THROWN error (setup/run/timeout rejections). Pure, pinned on
 *  message/error-shape fixtures. Conservative mapping:
 *    withTimeout rejections (the `eval "<name>" timed out after` prefix) → "timeout"
 *    network/provider vocabulary (ECONNREFUSED/ENOTFOUND/ETIMEDOUT, a 401/
 *    403/429 or 5xx status property, the codes with status context in the
 *    message, "API key", "rate limit", the ContextLengthError family) →
 *    "provider"
 *    any other throw → "harness" (fail-closed: unknown infra faults are
 *    never "assertion", and ambiguous phrasing scores as a REAL failure —
 *    never the reverse). */
export function classifyEvalFailure(err: unknown): Exclude<EvalFailureClass, "assertion"> {
  const message = err instanceof Error ? err.message : String(err);
  if (/^eval ".*" timed out after \d+ms$/.test(message)) return "timeout";
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (typeof status === "number" && (status === 401 || status === 403 || status === 429 || (status >= 500 && status <= 599))) {
    return "provider";
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT/.test(message)) return "provider";
  // Review M6 (fix round): bare status numbers read as content too easily
  // ("expected 429 items", "got 500 files") — a message-level status code
  // only counts with transport context around it (the `status` property
  // path above needs none).
  if (/\b(?:status(?:\s+code)?|http|error(?:\s+code)?)\s*[: ]\s*(?:401|403|429|5\d{2})\b/i.test(message)) return "provider";
  if (/\b5xx\b/.test(message)) return "provider";
  if (/api key|rate limit/i.test(message)) return "provider";
  const name = err instanceof Error ? err.name : "";
  if (/ContextLengthError|maximum context length/i.test(`${name} ${message}`)) return "provider";
  return "harness";
}

export interface EvalResult {
  readonly name: string;
  readonly kind: EvalKind;
  readonly status: "pass" | "fail" | "skip";
  /** Assertion errors, or the thrown setup/run error message. Empty on pass/skip. */
  readonly errors: readonly string[];
  readonly skipReason?: string;
  /** ω-5a I18: 1-based trial index within the invocation (--runs N numbers
   *  the repeats; single-run invocations carry 1). */
  readonly trial: number;
  readonly durationMs: number;
  /** Extracted measurements (present when the definition provides metrics). */
  readonly metrics?: Record<string, number>;
  /** ω-5a I18: present iff status === "fail" — the failure class. */
  readonly failureClass?: EvalFailureClass;
}

export interface RunEvalOptions {
  /** Root for per-eval temp dirs (default: os.tmpdir()). */
  readonly tmpRoot?: string;
  /** Hard wall-clock cap per eval. Default: 120s deterministic / 600s live. A
   *  hung eval (e.g. a live model call that never settles) fails instead of
   *  stalling `pnpm eval` forever. */
  readonly timeoutMs?: number;
  /** ω-5a I18: 1-based trial index (threads the --runs numbering through
   *  runAllEvals). Default 1. */
  readonly trial?: number;
  /** ω-5a I18: receipt preservation root — failing trials (and, under
   *  WUDAO_EVAL_KEEP=1, passing ones too) move their workspace plus a
   *  receipt.json under outRoot/<iso>-<name>-t<trial>/ before cleanup,
   *  pruned to the last DEFAULT_RECEIPT_KEEP. */
  readonly receipts?: { readonly outRoot: string };
}

function evalTimeoutMs(def: EvalDefinition, options: RunEvalOptions): number {
  if (options.timeoutMs !== undefined) return options.timeoutMs;
  return def.kind === "live" ? 600_000 : 120_000;
}

/** Race a promise against a timer. On timeout the error names the eval so the
 *  report shows which one hung. */
function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      // unref: when the raced eval wins, the pending timer must not keep the
      // process alive for the full timeout (was: ~10min linger after results).
      const t = setTimeout(() => reject(new Error(`eval "${name}" timed out after ${ms}ms`)), ms);
      t.unref?.();
    }),
  ]);
}

export async function runEval<C, E>(
  def: EvalDefinition<C, E>,
  options: RunEvalOptions = {},
): Promise<EvalResult> {
  const trial = options.trial ?? 1;
  const started = Date.now();
  const skipReason = def.skip?.();
  if (skipReason !== undefined) {
    return { name: def.name, kind: def.kind, status: "skip", errors: [], skipReason, trial, durationMs: 0 };
  }

  const prefix = `wudao-eval-${def.name.replace(/[^A-Za-z0-9_-]/g, "_")}-`;
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), prefix));
  let outcome: EvalResult | undefined;
  let evidence: E | undefined;
  try {
    const budget = evalTimeoutMs(def, options);
    const ctx = await withTimeout(def.setup(dir), budget, def.name);
    evidence = await withTimeout(def.run(ctx), budget, def.name);
    const errors = def.assertions(evidence);
    outcome = {
      name: def.name,
      kind: def.kind,
      status: errors.length === 0 ? "pass" : "fail",
      errors,
      trial,
      durationMs: Date.now() - started,
      ...(def.metrics ? { metrics: def.metrics(evidence) } : {}),
      ...(errors.length > 0 ? { failureClass: "assertion" as const } : {}),
    };
  } catch (err) {
    outcome = {
      name: def.name,
      kind: def.kind,
      status: "fail",
      errors: [err instanceof Error ? err.message : String(err)],
      trial,
      durationMs: Date.now() - started,
      failureClass: classifyEvalFailure(err),
    };
  } finally {
    // ω-5a I18: the receipt outlives the workspace — failing trials always,
    // passing ones under WUDAO_EVAL_KEEP=1. Receipt failures never change
    // the eval's own outcome.
    if (options.receipts !== undefined && outcome !== undefined && (outcome.status === "fail" || process.env.WUDAO_EVAL_KEEP === "1")) {
      try {
        await preserveReceipt(
          dir,
          buildReceipt(def.name, trial, {
            ...(evidence !== undefined && typeof evidence === "object" ? (evidence as object) : {}),
            kind: def.kind,
            status: outcome.status,
            ...(outcome.failureClass !== undefined ? { failureClass: outcome.failureClass } : {}),
            errors: outcome.errors,
            durationMs: outcome.durationMs,
            ...(outcome.metrics !== undefined ? { metrics: outcome.metrics } : {}),
          }),
          options.receipts.outRoot,
        );
        await pruneReceipts(options.receipts.outRoot, DEFAULT_RECEIPT_KEEP);
      } catch {
        // best-effort evidence trail only
      }
    }
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return outcome;
}

/** Any concrete eval definition (setup/run/assertions instantiated). */
export type AnyEvalDefinition = EvalDefinition<any, any>;

/** Run definitions sequentially (deterministic order, isolated temp dirs).
 *  A failing eval never stops the ones after it. `options.trial` threads the
 *  caller's run numbering (ω-5a I18). */
export async function runAllEvals(
  defs: readonly AnyEvalDefinition[],
  options: RunEvalOptions = {},
): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  for (const def of defs) {
    results.push(await runEval(def, options));
  }
  return results;
}
