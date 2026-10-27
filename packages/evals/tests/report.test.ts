import { describe, it, expect } from "vitest";
import { formatTable, evalExitCode, toReportJson, formatStatsSection, parseRunsArg } from "../src/report.js";
import { aggregateRuns } from "../src/stats.js";
import type { EvalResult } from "../src/runner.js";

function result(partial: Partial<EvalResult>): EvalResult {
  return {
    name: "x",
    kind: "deterministic",
    status: "pass",
    errors: [],
    durationMs: 1,
    trial: 1,
    ...partial,
  };
}

describe("formatTable", () => {
  it("renders pass/fail/skip rows with the first failure detail line only", () => {
    const table = formatTable([
      result({ name: "det-01-read-file-answer" }),
      result({ name: "det-05-permission-ask", status: "fail", errors: ["first line of failure", "second line"] }),
      result({ name: "live-01-read-summary", kind: "live", status: "skip", skipReason: "no API key found" }),
    ]);
    const lines = table.split("\n");
    expect(lines.some((l) => l.includes("✅") && l.includes("det-01-read-file-answer"))).toBe(true);
    expect(lines.some((l) => l.includes("❌") && l.includes("det-05-permission-ask") && l.includes("first line of failure"))).toBe(true);
    expect(table).not.toContain("second line");
    expect(lines.some((l) => l.includes("⏭") && l.includes("live-01-read-summary") && l.includes("no API key found"))).toBe(true);
  });

  it("renders a summary line with pass/fail/skip counts", () => {
    const table = formatTable([
      result({ name: "a" }),
      result({ name: "b", status: "fail", errors: ["nope"] }),
      result({ name: "c", kind: "live", status: "skip", skipReason: "no key" }),
    ]);
    expect(table).toContain("1 passed");
    expect(table).toContain("1 failed");
    expect(table).toContain("1 skipped");
  });
});

describe("evalExitCode", () => {
  it("is 0 when everything passes or skips", () => {
    expect(evalExitCode([
      result({ name: "a" }),
      result({ name: "b", kind: "live", status: "skip", skipReason: "no key" }),
    ])).toBe(0);
  });

  it("is 1 on ANY failure — deterministic or live", () => {
    expect(evalExitCode([result({ name: "a" }), result({ name: "b", status: "fail", errors: ["x"] })])).toBe(1);
    expect(evalExitCode([result({ name: "l", kind: "live", status: "fail", errors: ["x"] })])).toBe(1);
  });
});

describe("toReportJson", () => {
  it("produces a stable JSON-friendly report with counts and per-eval entries", () => {
    const json = toReportJson([
      result({ name: "a", durationMs: 5 }),
      result({ name: "l", kind: "live", status: "skip", skipReason: "no API key found", durationMs: 0 }),
    ]);
    expect(json.total).toBe(2);
    expect(json.passed).toBe(1);
    expect(json.failed).toBe(0);
    expect(json.skipped).toBe(1);
    expect(json.results[0]).toMatchObject({ name: "a", status: "pass" });
    expect(json.results[1]).toMatchObject({ name: "l", status: "skip", skipReason: "no API key found" });
    expect(typeof json.timestamp).toBe("string");
    // ω-5a I18: every row carries its trial; failureClass rides fails only.
    expect(json.results[0]).toMatchObject({ trial: 1 });
    expect("failureClass" in json.results[0]!).toBe(false);
    const failed = toReportJson([result({ name: "f", status: "fail", errors: ["x"], trial: 4, failureClass: "provider" })]);
    expect(failed.results[0]).toMatchObject({ trial: 4, failureClass: "provider" });
    // must be JSON-serializable
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// M51 §1 — runs statistics surface
// ---------------------------------------------------------------------------

describe("parseRunsArg", () => {
  it("defaults to 1 with no flag", () => {
    expect(parseRunsArg([])).toBe(1);
  });

  it("reads --runs N and --runs=N", () => {
    expect(parseRunsArg(["--runs", "3"])).toBe(3);
    expect(parseRunsArg(["--runs=5"])).toBe(5);
  });

  it("rejects non-positive / non-integer values (fail-closed to the default with a reason)", () => {
    expect(parseRunsArg(["--runs", "0"])).toMatchObject({ invalid: true });
    expect(parseRunsArg(["--runs", "-2"])).toMatchObject({ invalid: true });
    expect(parseRunsArg(["--runs", "2.5"])).toMatchObject({ invalid: true });
    expect(parseRunsArg(["--runs", "abc"])).toMatchObject({ invalid: true });
  });

  it("caps the run count (a typo must not run 10000 live suites)", () => {
    expect(parseRunsArg(["--runs", "999"])).toMatchObject({ invalid: true });
  });
});

describe("formatStatsSection", () => {
  const r = (name: string, kind: string, status: string, errors: string[] = []): EvalResult =>
    result({ name, kind: kind as EvalResult["kind"], status: status as EvalResult["status"], errors });

  it("renders per-suite pass counts, CI and Pass^k, and flags NON-DETERMINISTIC det suites", () => {
    const section = formatStatsSection(aggregateRuns([
      [r("det-a", "deterministic", "pass"), r("det-b", "deterministic", "pass")],
      [r("det-a", "deterministic", "pass"), r("det-b", "deterministic", "fail", ["boom line 1", "more"])],
      [r("det-a", "deterministic", "pass"), r("det-b", "deterministic", "pass")],
    ]));
    expect(section).toContain("-- statistics (3 runs) --");
    expect(section).toContain("det-a 3/3");
    expect(section).toContain("det-b 2/3");
    expect(section).toContain("NON-DETERMINISTIC");
    expect(section).toContain("CI95");
    expect(section).toContain("Pass^2");
    // a failing suite surfaces its worst run's first error line
    expect(section).toContain("boom line 1");
    expect(section).not.toContain("more");
  });
});

describe("toReportJson stats node", () => {
  it("carries the stats section only when provided", () => {
    const plain = toReportJson([result({ name: "a" })]);
    expect("stats" in plain).toBe(false);
    const stats = aggregateRuns([
      [result({ name: "a" })],
      [result({ name: "a", status: "fail", errors: ["x"] })],
    ]);
    const json = toReportJson([result({ name: "a" })], { stats });
    expect(json.stats).toBeDefined();
    expect(json.stats!.runs).toBe(2);
    expect(json.stats!.nonDeterministic).toEqual(["a"]);
    expect(json.stats!.suites[0]!.passRate.mean).toBeCloseTo(0.5, 10);
    expect(json.stats!.overall.mean).toBeCloseTo(0.5, 10);
    expect(() => JSON.stringify(json)).not.toThrow();
  });
});
