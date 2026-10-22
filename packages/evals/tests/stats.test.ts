// M51 §1 — statistics unit tests: every constant pinned against
// hand-computed values (t-table, SE, Pass^k, paired deltas, run aggregation).
import { describe, it, expect } from "vitest";
import { summarize, pairedDelta, aggregateRuns } from "../src/stats.js";
import type { EvalResult } from "../src/runner.js";

describe("summarize", () => {
  it("computes mean/SE/95% CI (t approximation) for [1,0,1,1]", () => {
    const s = summarize([1, 0, 1, 1]);
    expect(s.runs).toBe(4);
    expect(s.mean).toBeCloseTo(0.75, 10);
    // sample sd = 0.5 → SE = 0.5/√4 = 0.25
    expect(s.se).toBeCloseTo(0.25, 10);
    // df=3 → t=3.182 → 0.75 ± 0.7955, bounds clamped to [0,1] for rate metric
    expect(s.ci95).not.toBeNull();
    expect(s.ci95!.low).toBe(0); // clamped from -0.0455
    expect(s.ci95!.high).toBe(1); // clamped from 1.5455
  });

  it("computes Pass^k = 1-(1-p)^k for k=1..3", () => {
    const s = summarize([1, 0, 1, 1]);
    expect(s.passK.k1).toBeCloseTo(0.75, 10);
    expect(s.passK.k2).toBeCloseTo(0.9375, 10);
    expect(s.passK.k3).toBeCloseTo(0.984375, 10);
  });

  it("n=1 → no CI, SE 0, Pass^k degenerates to the single outcome", () => {
    const s = summarize([1]);
    expect(s.runs).toBe(1);
    expect(s.mean).toBe(1);
    expect(s.se).toBe(0);
    expect(s.ci95).toBeNull();
    expect(s.passK).toEqual({ k1: 1, k2: 1, k3: 1 });
  });

  it("empty input → zeroed summary, no CI", () => {
    const s = summarize([]);
    expect(s.runs).toBe(0);
    expect(s.mean).toBe(0);
    expect(s.ci95).toBeNull();
    expect(s.passK.k1).toBe(0);
  });

  it("all-pass → SE 0, CI collapses onto 1.0", () => {
    const s = summarize([1, 1, 1]);
    expect(s.se).toBe(0);
    expect(s.ci95!.low).toBeCloseTo(1, 10);
    expect(s.ci95!.high).toBeCloseTo(1, 10);
    expect(s.passK.k3).toBeCloseTo(1, 10);
  });

  it("honors the nominal runs option (reported run count)", () => {
    // A suite that ran 3 times but produced 2 usable results still reports
    // the nominal run count for the stats node.
    const s = summarize([1, 0], { runs: 3 });
    expect(s.runs).toBe(3);
    expect(s.mean).toBeCloseTo(0.5, 10);
  });
});

describe("pairedDelta", () => {
  it("computes the paired mean delta with a t CI", () => {
    const d = pairedDelta([3, 5, 7], [2, 5, 9]);
    expect(d.n).toBe(3);
    // diffs [1, 0, -2] → mean −1/3
    expect(d.meanDelta).toBeCloseTo(-1 / 3, 10);
    // diffs [1,0,-2] around mean −1/3: squares 16/9+1/9+25/9 → var 7/3, SE = √7/3
    expect(d.se).toBeCloseTo(Math.sqrt(7) / 3, 10);
    expect(d.ci95!.low).toBeCloseTo(-1 / 3 - 4.303 * Math.sqrt(7) / 3, 6);
    expect(d.ci95!.high).toBeCloseTo(-1 / 3 + 4.303 * Math.sqrt(7) / 3, 6);
  });

  it("n=1 → no CI; mismatched lengths throw", () => {
    expect(pairedDelta([1], [0]).ci95).toBeNull();
    expect(() => pairedDelta([1, 2], [1])).toThrow(/length mismatch/);
  });
});

describe("aggregateRuns", () => {
  const r = (name: string, kind: EvalResult["kind"], status: EvalResult["status"], extra: Partial<EvalResult> = {}): EvalResult =>
    ({ name, kind, status, errors: [], durationMs: 1, trial: 1, ...extra });

  it("aggregates per-suite pass rates across runs", () => {
    const stats = aggregateRuns([
      [r("det-a", "deterministic", "pass"), r("det-b", "deterministic", "fail")],
      [r("det-a", "deterministic", "pass"), r("det-b", "deterministic", "pass")],
    ]);
    expect(stats.runs).toBe(2);
    expect(stats.suites).toHaveLength(2);
    const a = stats.suites.find((s) => s.name === "det-a")!;
    expect(a.passes).toBe(2);
    expect(a.passRate.mean).toBeCloseTo(1, 10);
    expect(a.nonDeterministic).toBe(false);
    const b = stats.suites.find((s) => s.name === "det-b")!;
    expect(b.passes).toBe(1);
    expect(b.passRate.mean).toBeCloseTo(0.5, 10);
    // deterministic suite flipping status across runs = NON-DETERMINISTIC
    expect(b.nonDeterministic).toBe(true);
    expect(stats.nonDeterministic).toEqual(["det-b"]);
    // overall: per-run pass fraction over all suites → [0.5, 1.0] → mean 0.75
    expect(stats.overall.mean).toBeCloseTo(0.75, 10);
  });

  it("live suites never get the NON-DETERMINISTIC flag (variance is expected)", () => {
    const stats = aggregateRuns([
      [r("live-x", "live", "pass")],
      [r("live-x", "live", "fail")],
    ]);
    expect(stats.suites[0]!.nonDeterministic).toBe(false);
    expect(stats.nonDeterministic).toEqual([]);
  });

  it("ω-5a I18: infra failures (provider/timeout) are excluded from scoring and counted", () => {
    const stats = aggregateRuns([
      [r("live-x", "live", "pass")],
      [r("live-x", "live", "fail", { failureClass: "provider", errors: ["getaddrinfo ENOTFOUND"] })],
      [r("live-x", "live", "fail", { failureClass: "assertion", errors: ["missed keyword"] })],
    ]);
    const s = stats.suites.find((x) => x.name === "live-x")!;
    expect(s.passes).toBe(1);
    expect(s.runs).toBe(2);
    expect(s.infraExcluded).toBe(1);
    expect(s.passRate.mean).toBeCloseTo(0.5, 10); // over the 2 scored runs
    expect(s.sampleError).toBe("missed keyword"); // infra rows are not the sample
    // A provider flake in a det suite does not flag NON-DETERMINISTIC.
    const det = aggregateRuns([
      [r("det-y", "deterministic", "pass")],
      [r("det-y", "deterministic", "fail", { failureClass: "timeout" })],
    ]);
    expect(det.suites[0]!.nonDeterministic).toBe(false);
    expect(det.suites[0]!.infraExcluded).toBe(1);
    // The overall line scores the same exclusion.
    expect(stats.overall.mean).toBeCloseTo(0.5, 10);
  });

  it("skips score no observation: the pass rate covers scored runs only, all-skip reads unknown", () => {
    const stats = aggregateRuns([
      [r("live-s", "live", "skip"), r("det-s", "deterministic", "skip")],
      [r("live-s", "live", "skip"), r("det-s", "deterministic", "pass")],
    ]);
    const live = stats.suites.find((s) => s.name === "live-s")!;
    expect(live.runs).toBe(0);
    expect(live.passes).toBe(0);
    expect(live.passRate.mean).toBe(0);
    expect(live.passRate.ci95).toBeNull();
    const det = stats.suites.find((s) => s.name === "det-s")!;
    expect(det.runs).toBe(1);
    expect(det.passRate.mean).toBeCloseTo(1, 10);
    // skip→pass still counts as a status flip for a det suite
    expect(det.nonDeterministic).toBe(true);
  });
});
