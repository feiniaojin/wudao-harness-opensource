// ω-5a I18 — `--compare` (compareReports + formatCompare): pair by
// (name, trial), drop infra-excluded trials on either side (printing the
// count), and the verdict doctrine — a delta whose CI crosses 0 is a TIE,
// never an improvement. Pure; fixture report JSONs only.
import { describe, it, expect } from "vitest";
import { compareReports, formatCompare } from "../src/compare.js";
import type { ReportJson } from "../src/report.js";

type Row = ReportJson["results"][number];

const row = (name: string, trial: number, status: "pass" | "fail" | "skip", extra: Partial<Row> = {}): Row => ({
  name,
  kind: status === "skip" ? "live" : "deterministic",
  status,
  errors: [],
  durationMs: 1,
  trial,
  ...extra,
});

const report = (results: readonly Row[]): ReportJson =>
  ({ timestamp: "2026-08-22T00:00:00.000Z", total: results.length, passed: 0, failed: 0, skipped: 0, results });

describe("compareReports", () => {
  it("pairs by (name, trial) and scores pass=1/fail=0", () => {
    const a = report([
      row("det-a", 1, "pass"),
      row("det-a", 2, "fail"),
      row("det-a", 3, "pass"),
      row("live-b", 1, "pass"),
    ]);
    const b = report([
      row("det-a", 1, "fail"),
      row("det-a", 2, "fail"),
      row("det-a", 3, "pass"),
      row("live-b", 1, "fail"),
      row("det-c", 1, "pass"), // present on B only → no pairs
    ]);
    const r = compareReports(a, b);
    const detA = r.suites.find((s) => s.name === "det-a")!;
    expect(detA.pairsTotal).toBe(3);
    expect(detA.pairsUsed).toBe(3);
    // diffs [1, 0, 0] → mean 1/3
    expect(detA.delta.meanDelta).toBeCloseTo(1 / 3, 10);
    const detC = r.suites.find((s) => s.name === "det-c")!;
    expect(detC.pairsTotal).toBe(0);
    expect(detC.verdict).toBe("no-pairs");
  });

  it("drops pairs infra-excluded on EITHER side and counts them", () => {
    const a = report([
      row("live-x", 1, "fail", { failureClass: "provider" }), // infra on A
      row("live-x", 2, "pass"),
    ]);
    const b = report([
      row("live-x", 1, "pass"),
      row("live-x", 2, "fail", { failureClass: "timeout" }), // infra on B
    ]);
    const r = compareReports(a, b);
    const s = r.suites.find((x) => x.name === "live-x")!;
    expect(s.pairsTotal).toBe(2);
    expect(s.infraExcluded).toBe(2);
    expect(s.pairsUsed).toBe(0);
    expect(s.verdict).toBe("no-pairs");
  });

  it("skips do not pair", () => {
    const a = report([row("live-s", 1, "skip")]);
    const b = report([row("live-s", 1, "pass")]);
    const s = compareReports(a, b).suites[0]!;
    expect(s.pairsTotal).toBe(0);
    expect(s.verdict).toBe("no-pairs");
  });
});

describe("formatCompare (the --compare stdout block)", () => {
  it("n=3 consistent improvement → delta CI excludes 0 → improvement line", () => {
    const a = report([row("det-a", 1, "pass"), row("det-a", 2, "pass"), row("det-a", 3, "pass")]);
    const b = report([row("det-a", 1, "fail"), row("det-a", 2, "fail"), row("det-a", 3, "fail")]);
    const out = formatCompare(compareReports(a, b), { a: "a.json", b: "b.json" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("-- compare a.json vs b.json (delta = first − second) --");
    // diffs [1,1,1]: mean 1, SE 0 → CI [1, 1] — excludes 0.
    expect(lines[1]).toBe("✅ det-a pairs 3 delta +1 CI95 [1, 1] — improvement");
  });

  it("one trial each → CI n/a → the TIE line (one-trial tie is not improvement)", () => {
    const a = report([row("det-a", 1, "pass")]);
    const b = report([row("det-a", 1, "fail")]);
    const out = formatCompare(compareReports(a, b));
    expect(out.split("\n")[1]).toBe("➖ det-a pairs 1 delta +1 CI95 n/a — TIE — one-trial tie does not establish improvement");
  });

  it("an infra-excluded trial on side B drops the pair and the suite line says infra-excluded 1", () => {
    const a = report([row("live-x", 1, "pass"), row("live-x", 2, "pass")]);
    const b = report([
      row("live-x", 1, "fail", { failureClass: "provider" }),
      row("live-x", 2, "fail"),
    ]);
    const out = formatCompare(compareReports(a, b));
    expect(out.split("\n")[1]).toBe("➖ live-x pairs 1 infra-excluded 1 delta +1 CI95 n/a — TIE — one-trial tie does not establish improvement");
  });

  it("regression direction prints when the CI excludes 0 below", () => {
    const a = report([row("det-a", 1, "fail"), row("det-a", 2, "fail"), row("det-a", 3, "fail")]);
    const b = report([row("det-a", 1, "pass"), row("det-a", 2, "pass"), row("det-a", 3, "pass")]);
    const out = formatCompare(compareReports(a, b));
    expect(out.split("\n")[1]).toBe("❌ det-a pairs 3 delta -1 CI95 [-1, -1] — regression");
  });

  it("no paired trials prints the no-pairs line", () => {
    const only = report([row("det-z", 1, "pass")]);
    const b = report([row("det-c", 1, "pass")]);
    const out = formatCompare(compareReports(only, b));
    expect(out.split("\n")[1]).toBe("⚠️ det-z pairs 0 delta n/a CI95 n/a — no paired trials");
  });
});
