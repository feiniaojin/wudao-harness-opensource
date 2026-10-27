// ω-5a I18 — `pnpm eval --compare <a.json> <b.json>`: the A/B doctrine made
// a tool. pairedDelta existed as pure math with no consumer; --compare pairs
// two report JSONs by (name, trial), drops trials infra-excluded on EITHER
// side (a provider flake is not evidence about the change under test — the
// dropped pairs print as infra-excluded, never silently), scores pass=1 /
// fail=0 per remaining pair, and prints each suite's paired-delta CI with a
// verdict that refuses to call a CI-crossing-zero delta an improvement.
// Pure formatting + pure math — the CLI reads the files.
import type { ReportJson } from "./report.js";
import { pairedDelta, type PairedDelta } from "./stats.js";

type ReportRow = ReportJson["results"][number];

/** Infra rows (provider/timeout classes) carry no signal about the change
 *  under test — same predicate as aggregateRuns. */
function isInfraRow(r: ReportRow): boolean {
  return r.status === "fail" && (r.failureClass === "provider" || r.failureClass === "timeout");
}

export type CompareVerdict = "improvement" | "regression" | "tie" | "no-pairs";

export interface SuiteCompare {
  readonly name: string;
  readonly kind: string;
  /** Trials present on both sides with a pass/fail status. */
  readonly pairsTotal: number;
  /** Trials dropped because EITHER side was infra-excluded. */
  readonly infraExcluded: number;
  /** Trials the delta was computed over. */
  readonly pairsUsed: number;
  readonly delta: PairedDelta;
  readonly verdict: CompareVerdict;
}

export interface CompareResult {
  readonly a: string;
  readonly b: string;
  readonly suites: readonly SuiteCompare[];
}

const score = (r: ReportRow): number => (r.status === "pass" ? 1 : 0);

/** Pair two report JSONs by (name, trial) and compute the per-suite paired
 *  delta (first minus second). Pure; old reports without a trial field
 *  degrade to trial 1. */
export function compareReports(a: ReportJson, b: ReportJson): CompareResult {
  const index = (rows: readonly ReportRow[]): Map<string, Map<number, ReportRow>> => {
    const m = new Map<string, Map<number, ReportRow>>();
    for (const r of rows) {
      if (r.status !== "pass" && r.status !== "fail") continue; // skips pair nothing
      let byTrial = m.get(r.name);
      if (byTrial === undefined) {
        byTrial = new Map<number, ReportRow>();
        m.set(r.name, byTrial);
      }
      byTrial.set(r.trial ?? 1, r);
    }
    return m;
  };
  const idxA = index(a.results);
  const idxB = index(b.results);
  // Suite order: first appearance across A then B, deterministic.
  const order: string[] = [];
  const kinds = new Map<string, string>();
  for (const r of [...a.results, ...b.results]) {
    if (!kinds.has(r.name)) {
      kinds.set(r.name, r.kind);
      order.push(r.name);
    }
  }
  const suites: SuiteCompare[] = order.map((name) => {
    let pairsTotal = 0;
    let infraExcluded = 0;
    const aScores: number[] = [];
    const bScores: number[] = [];
    const byTrialA = idxA.get(name);
    if (byTrialA !== undefined) {
      for (const [trial, ra] of byTrialA) {
        const rb = idxB.get(name)?.get(trial);
        if (rb === undefined) continue;
        pairsTotal += 1;
        if (isInfraRow(ra) || isInfraRow(rb)) {
          infraExcluded += 1;
          continue;
        }
        aScores.push(score(ra));
        bScores.push(score(rb));
      }
    }
    const delta = pairedDelta(aScores, bScores);
    const verdict: CompareVerdict = delta.n === 0
      ? "no-pairs"
      : delta.ci95 !== null && delta.ci95.low > 0
        ? "improvement"
        : delta.ci95 !== null && delta.ci95.high < 0
          ? "regression"
          : "tie";
    return { name, kind: kinds.get(name) ?? "unknown", pairsTotal, infraExcluded, pairsUsed: delta.n, delta, verdict };
  });
  return { a: "a", b: "b", suites };
}

const fmt3 = (x: number): string => String(Math.round(x * 1000) / 1000);

const VERDICT_TEXT: Readonly<Record<CompareVerdict, string>> = {
  improvement: "improvement",
  regression: "regression",
  tie: "TIE — one-trial tie does not establish improvement",
  "no-pairs": "no paired trials",
};

/** The `--compare` stdout block: one line per suite with the paired delta,
 *  its CI and the verdict. Exit code stays 0 — observational, like
 *  --workloop. */
export function formatCompare(result: CompareResult, labels?: { readonly a?: string; readonly b?: string }): string {
  const a = labels?.a ?? result.a;
  const b = labels?.b ?? result.b;
  const lines = [`-- compare ${a} vs ${b} (delta = first − second) --`];
  for (const s of result.suites) {
    const ci = s.delta.ci95 === null ? "CI95 n/a" : `CI95 [${fmt3(s.delta.ci95.low)}, ${fmt3(s.delta.ci95.high)}]`;
    const infra = s.infraExcluded > 0 ? ` infra-excluded ${s.infraExcluded}` : "";
    const symbol = s.verdict === "improvement" ? "✅" : s.verdict === "regression" ? "❌" : s.verdict === "tie" ? "➖" : "⚠️";
    const delta = s.pairsUsed === 0 ? "delta n/a" : `delta ${s.delta.meanDelta >= 0 ? "+" : ""}${fmt3(s.delta.meanDelta)}`;
    lines.push(`${symbol} ${s.name} pairs ${s.pairsUsed}${infra} ${delta} ${ci} — ${VERDICT_TEXT[s.verdict]}`);
  }
  return lines.join("\n");
}
