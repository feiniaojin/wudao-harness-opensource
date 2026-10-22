// Table + JSON reporting for the eval CLI.
import type { EvalResult } from "./runner.js";
import type { RunsStats } from "./stats.js";

const SYMBOLS: Record<EvalResult["status"], string> = {
  pass: "✅",
  fail: "❌",
  skip: "⏭",
};

/** One line per eval: symbol, name, and (for fail/skip) the first detail line. */
export function formatTable(results: readonly EvalResult[]): string {
  const rows = results.map((r) => {
    const detail = r.status === "fail"
      ? ` — ${r.errors[0] ?? "(no detail)"}`
      : r.status === "skip"
        ? ` — skipped: ${r.skipReason ?? "(no reason)"}`
        : "";
    return `${SYMBOLS[r.status]} ${r.name}${detail}`;
  });
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;
  const summary = `${passed} passed, ${failed} failed, ${skipped} skipped`;
  return [...rows, "", summary].join("\n");
}

/** Any failure (deterministic OR live) fails the run; skips do not. */
export function evalExitCode(results: readonly EvalResult[]): number {
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

// ---------------------------------------------------------------------------
// M51 §1 — `--runs N` statistics surface
// ---------------------------------------------------------------------------

/** Hard ceiling on --runs: repeated live suites cost real money; a typo must
 *  not turn `--runs 30` into thirty full live passes. */
export const MAX_RUNS = 20;

/** Parse `--runs N` / `--runs=N` from argv. Returns the run count, or
 *  `{invalid}` for a missing/malformed/out-of-range value (fail-closed: the
 *  CLI prints the reason and exits non-zero instead of guessing). */
export function parseRunsArg(argv: readonly string[]): number | { readonly invalid: true; readonly reason: string } {
  const idx = argv.indexOf("--runs");
  const eq = argv.find((a) => a.startsWith("--runs="));
  if (idx === -1 && eq === undefined) return 1;
  const raw = idx !== -1 ? (argv[idx + 1] ?? "") : (eq as string).slice("--runs=".length);
  if (!/^\d+$/.test(raw.trim())) {
    return { invalid: true, reason: `--runs expects an integer (got "${raw}")` };
  }
  const n = Number(raw.trim());
  if (n < 1 || n > MAX_RUNS) {
    return { invalid: true, reason: `--runs must be between 1 and ${MAX_RUNS} (got ${n})` };
  }
  return n;
}

const fmt3 = (x: number): string => String(Math.round(x * 1000) / 1000);

/** The `-- statistics (N runs) --` stdout section: one line per suite with
 *  pass count, 95% CI and Pass^1/2/3; deterministic suites whose status
 *  flipped across runs are flagged NON-DETERMINISTIC; a suite with failures
 *  appends its worst run's first error line (same budget as formatTable). */
export function formatStatsSection(stats: RunsStats): string {
  const lines: string[] = [`-- statistics (${stats.runs} run${stats.runs === 1 ? "" : "s"}) --`];
  for (const s of stats.suites) {
    const ci = s.passRate.ci95 === null
      ? "CI95 n/a"
      : `CI95 [${fmt3(s.passRate.ci95.low)}, ${fmt3(s.passRate.ci95.high)}]`;
    const pk = s.passRate.passK;
    const flag = s.nonDeterministic ? " NON-DETERMINISTIC" : "";
    const symbol = s.runs === 0 ? "⏭" : s.passes === s.runs ? "✅" : "❌";
    // ω-5a I18: infra-excluded counts print — never silently dropped pairs.
    const infra = s.infraExcluded > 0 ? ` infra-excluded ${s.infraExcluded}` : "";
    lines.push(
      `${symbol} ${s.name} ${s.passes}/${s.runs}${infra} ${ci} Pass^1 ${fmt3(pk.k1)} Pass^2 ${fmt3(pk.k2)} Pass^3 ${fmt3(pk.k3)}${flag}`,
    );
    if (s.sampleError !== undefined) lines.push(`   ${s.sampleError.split("\n")[0] ?? ""}`);
  }
  if (stats.nonDeterministic.length > 0) {
    lines.push("");
    lines.push(`⚠️ NON-DETERMINISTIC (deterministic suites must be idempotent): ${stats.nonDeterministic.join(", ")}`);
  }
  const oc = stats.overall.ci95 === null
    ? "CI95 n/a"
    : `CI95 [${fmt3(stats.overall.ci95.low)}, ${fmt3(stats.overall.ci95.high)}]`;
  lines.push("");
  lines.push(`overall ${fmt3(stats.overall.mean)} ${oc} · Pass^1 ${fmt3(stats.overall.passK.k1)} · Pass^2 ${fmt3(stats.overall.passK.k2)} · Pass^3 ${fmt3(stats.overall.passK.k3)}`);
  return lines.join("\n");
}

export interface ReportJson {
  readonly timestamp: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  /** M24: aggregate cache picture (from suites that report hitRatePct). */
  readonly cache?: { readonly hitRatePct: number; readonly modelCalls: number };
  /** M51 §1: across-run statistics — present only for multi-run invocations
   *  (`--runs N`, N>1): per-suite pass rate/CI/Pass^k, the overall line, and
   *  the NON-DETERMINISTIC flag list (det suites that flipped status). */
  readonly stats?: RunsStats;
  readonly results: readonly {
    readonly name: string;
    readonly kind: string;
    readonly status: string;
    readonly errors: readonly string[];
    readonly skipReason?: string;
    readonly durationMs: number;
    readonly metrics?: Record<string, number>;
    /** ω-5a I18: 1-based trial index within the invocation. */
    readonly trial: number;
    /** ω-5a I18: present iff status === "fail". */
    readonly failureClass?: string;
  }[];
}

export function toReportJson(
  results: readonly EvalResult[],
  opts?: { readonly stats?: RunsStats },
): ReportJson {
  const withHit = results.filter((r) => r.metrics?.hitRatePct !== undefined);
  const modelCalls = withHit.reduce((n, r) => n + (r.metrics?.modelCalls ?? 0), 0);
  const weighted = withHit.reduce((n, r) => n + (r.metrics?.hitRatePct ?? 0) * (r.metrics?.modelCalls ?? 0), 0);
  return {
    timestamp: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.status === "pass").length,
    failed: results.filter((r) => r.status === "fail").length,
    skipped: results.filter((r) => r.status === "skip").length,
    ...(modelCalls > 0 ? { cache: { hitRatePct: Math.round((weighted / modelCalls) * 10) / 10, modelCalls } } : {}),
    ...(opts?.stats !== undefined ? { stats: opts.stats } : {}),
    results: results.map((r) => ({
      name: r.name,
      kind: r.kind,
      status: r.status,
      errors: [...r.errors],
      ...(r.skipReason !== undefined ? { skipReason: r.skipReason } : {}),
      durationMs: r.durationMs,
      ...(r.metrics && Object.keys(r.metrics).length > 0 ? { metrics: r.metrics } : {}),
      trial: r.trial,
      ...(r.failureClass !== undefined ? { failureClass: r.failureClass } : {}),
    })),
  };
}
