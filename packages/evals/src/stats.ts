// M51 §1 — eval run statistics (book Ch6): mean / SE / 95% CI (t
// approximation) / Pass^k over repeated runs, plus paired deltas for A/B
// comparisons and the per-suite aggregation the `--runs N` report carries.
// Pure math, zero deps, never throws (aggregateRuns over empty input is a
// zeroed node). Every constant is pinned by tests against hand-computed
// values — treat this file as the single source for eval statistics.
import type { EvalResult } from "./runner.js";

/** A symmetric 95% confidence interval on the mean. */
export interface Ci95 {
  readonly low: number;
  readonly high: number;
}

/** Two-sided 95% t critical values for df = 1..30 (df > 30 → normal 1.96).
 *  Hand-checked against the standard t-table; stats tests pin df=2/3 rows. */
const T95: readonly number[] = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
  2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
  2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042,
];

function t95(df: number): number {
  return df >= 1 && df <= 30 ? (T95[df - 1] as number) : 1.96;
}

/** Mean / sample-variance-based SE / t CI over a numeric sample.
 *  n ≤ 1 → SE 0 and no CI (a single observation carries no dispersion). */
function meanSeCi(xs: readonly number[]): { mean: number; se: number; ci95: Ci95 | null } {
  const n = xs.length;
  if (n === 0) return { mean: 0, se: 0, ci95: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { mean, se: 0, ci95: null };
  const variance = xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1);
  const se = Math.sqrt(variance / n);
  const half = t95(n - 1) * se;
  return { mean, se, ci95: { low: mean - half, high: mean + half } };
}

/** Pass^k estimates: the probability that at least ONE of k independent runs
 *  passes, under the observed pass-rate estimate p̂ — 1 − (1 − p̂)^k. */
export interface PassK {
  readonly k1: number;
  readonly k2: number;
  readonly k3: number;
}

function passKEstimates(mean: number): PassK {
  const p = Math.min(1, Math.max(0, mean)); // clamp: the formula needs a rate
  return { k1: p, k2: 1 - (1 - p) ** 2, k3: 1 - (1 - p) ** 3 };
}

/** One summarized measurement (per-suite pass rate, overall rate, …). */
export interface RunStats {
  /** Observations behind the summary (per-run outcomes). */
  readonly runs: number;
  readonly mean: number;
  readonly se: number;
  readonly ci95: Ci95 | null;
  readonly passK: PassK;
}

/** Summarize per-run outcomes (1 = pass, 0 = not) into mean / SE / 95% CI /
 *  Pass^k. `opts.runs` overrides the REPORTED run count when a suite produced
 *  fewer usable observations than the nominal run count (e.g. a crash). */
export function summarize(results: readonly number[], opts?: { readonly runs?: number }): RunStats {
  const { mean, se, ci95 } = meanSeCi(results);
  // Clamp CI bounds to [0, 1] for rate metrics (bounded samples)
  const clampedCi95 = ci95
    ? { low: Math.max(0, ci95.low), high: Math.min(1, ci95.high) }
    : null;
  return { runs: opts?.runs ?? results.length, mean, se, ci95: clampedCi95, passK: passKEstimates(mean) };
}

/** Paired difference a − b with its own t CI (A/B run comparison). */
export interface PairedDelta {
  readonly n: number;
  readonly meanDelta: number;
  readonly se: number;
  readonly ci95: Ci95 | null;
}

/** Paired delta over aligned run vectors. Mismatched lengths throw — paired
 *  statistics over misaligned vectors would silently lie. */
export function pairedDelta(a: readonly number[], b: readonly number[]): PairedDelta {
  if (a.length !== b.length) {
    throw new Error(`pairedDelta: length mismatch (${a.length} vs ${b.length})`);
  }
  const diffs = a.map((x, i) => x - (b[i] as number));
  const { mean, se, ci95 } = meanSeCi(diffs);
  return { n: diffs.length, meanDelta: mean, se, ci95 };
}

// ---------------------------------------------------------------------------
// Run aggregation (the `--runs N` report node)
// ---------------------------------------------------------------------------

/** One suite's across-run picture. */
export interface EvalRunStat {
  readonly name: string;
  readonly kind: string;
  /** Passing runs. */
  readonly passes: number;
  /** Runs that produced a result (every run). */
  readonly runs: number;
  /** ω-5a I18: runs excluded from scoring as infra failures (provider/
   *  timeout classes) — reported beside passes/runs, never silently
   *  dropped. */
  readonly infraExcluded: number;
  /** The pass-rate summary (mean = pass rate, CI, Pass^k). */
  readonly passRate: RunStats;
  /** DETERMINISTIC suite whose status differed across runs — caught
   *  non-determinism (live variance is expected and never flagged). */
  readonly nonDeterministic: boolean;
  /** First error line of the first failing run (undefined when all passed).
   *  Surfaced in the stats section — same one-line budget as formatTable. */
  readonly sampleError?: string;
}

/** The whole `--runs` report node. */
export interface RunsStats {
  readonly runs: number;
  /** Suites in first-run order. */
  readonly suites: readonly EvalRunStat[];
  /** Per-run pass fraction across every suite, summarized. */
  readonly overall: RunStats;
  /** Names of NON-DETERMINISTIC deterministic suites. */
  readonly nonDeterministic: readonly string[];
}

/** pass=1 / fail=0 scoring (skips score no observation — see below). */
const STATUS_ORDER: Readonly<Record<string, number>> = { pass: 1, fail: 0 };

/** ω-5a I18: an infra failure — a thrown timeout/provider error, NOT an
 *  assertion miss. Infra rows carry no signal about the change under test,
 *  so aggregateRuns excludes them from scoring (counting them instead). */
export function isInfraFailure(r: EvalResult): boolean {
  return r.status === "fail" && (r.failureClass === "provider" || r.failureClass === "timeout");
}

/** Aggregate N complete result lists (one per run) into the stats node.
 *  Suites are keyed by name in first-run order; a suite missing from a later
 *  run counts as a non-pass for that run. ω-5a I18: provider/timeout rows
 *  are infra-excluded — counted beside passes/runs, never scored. */
export function aggregateRuns(runs: readonly (readonly EvalResult[])[]): RunsStats {
  const order: string[] = [];
  const byName = new Map<string, { kind: string }>();
  for (const results of runs) {
    for (const r of results) {
      if (!byName.has(r.name)) {
        byName.set(r.name, { kind: r.kind });
        order.push(r.name);
      }
    }
  }
  const suites: EvalRunStat[] = order.map((name) => {
    const entry = byName.get(name)!;
    const rows = runs.map((results) => results.find((r) => r.name === name));
    const infraExcluded = rows.filter((r) => r !== undefined && isInfraFailure(r)).length;
    const scoredRows = rows.filter((r) => r !== undefined && (r.status === "pass" || r.status === "fail") && !isInfraFailure(r));
    const scored = scoredRows.map((r) => (r as EvalResult).status);
    const passes = scored.filter((s) => s === "pass").length;
    // Uniformity ignores infra rows (a provider flake is not non-determinism).
    const nonInfraStatuses = rows
      .filter((r) => !(r !== undefined && isInfraFailure(r)))
      .map((r) => r?.status ?? "missing");
    const uniform = nonInfraStatuses.every((s) => s === nonInfraStatuses[0]);
    const firstFail = rows.find((r) => r !== undefined && r.status === "fail" && !isInfraFailure(r))
      ?? rows.find((r) => r !== undefined && r.status === "fail");
    return {
      name,
      kind: entry.kind,
      passes,
      runs: scored.length,
      infraExcluded,
      // A suite skipped in every run (live without a key) scores no runs —
      // mean 0 with no CI reads as "unknown", not as "failed".
      passRate: summarize(scored.map((s) => STATUS_ORDER[s] ?? 0)),
      nonDeterministic: entry.kind === "deterministic" && !uniform,
      ...(firstFail !== undefined && firstFail.errors.length > 0 ? { sampleError: firstFail.errors[0] } : {}),
    };
  });
  const overall = summarize(
    runs
      .map((results) => {
        const scored = results.filter((r) => (r.status === "pass" || r.status === "fail") && !isInfraFailure(r));
        return scored.length === 0 ? undefined : scored.filter((r) => r.status === "pass").length / scored.length;
      })
      // ω-5a I18: a run whose every row was skipped or infra-excluded carries
      // no observation — contributing a fake 0 would let provider flakes drag
      // the overall line down (the exact noise this exclusion exists to drop).
      .filter((x): x is number => x !== undefined),
  );
  return {
    runs: runs.length,
    suites,
    overall,
    nonDeterministic: suites.filter((s) => s.nonDeterministic).map((s) => s.name),
  };
}
