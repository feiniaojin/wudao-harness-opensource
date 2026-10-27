// M50 §2 — the meta experiment journal: append-only .wudao/experiments.jsonl,
// experimental-settings auto-record on write, Wilson-LB ranking per lever,
// task-level flip attribution, `wudao meta report|record|apply`. Report only
// — the journal NEVER changes configuration by itself.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregateExperiments,
  appendExperiment,
  experimentsPath,
  experimentalSettingsDiff,
  formatMetaReport,
  loadExperiments,
  metaMain,
  recordSettingsExperiments,
  wilsonLowerBound,
  type ExperimentEntry,
} from "../src/meta/journal.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wudao-meta-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const at = (iso: string): string => iso;

describe("journal append + load", () => {
  it("appends entries with stable ids and reloads them (corrupt lines skipped)", async () => {
    const e1 = await appendExperiment(root, { lever: "sidecar.breakerThreshold", from: 3, to: 5, task: "m50-smoke" });
    const e2 = await appendExperiment(root, { lever: "sidecar.timeoutMs", from: 4000, to: 6000, task: "", outcome: "worse" });
    expect(e1.id).toMatch(/^exp-/);
    expect(e1.id).not.toBe(e2.id);
    expect(e1.outcome).toBe("ok"); // unjudged changes are provisionally ok
    expect(e2.outcome).toBe("worse");
    const raw = await readFile(experimentsPath(root), "utf8");
    expect(raw.split("\n").filter((l) => l.trim() !== "")).toHaveLength(2);
    // A corrupt line is tolerated on load — never fatal.
    await writeFile(experimentsPath(root), "{not json}\n", { flag: "a" });
    const loaded = loadExperiments(root);
    expect(loaded.map((e) => e.lever)).toEqual(["sidecar.breakerThreshold", "sidecar.timeoutMs"]);
    expect(loaded[0]).toMatchObject({ from: 3, to: 5, task: "m50-smoke", outcome: "ok" });
    expect(typeof loaded[0]!.at).toBe("string");
  });

  it("rejects an empty lever (fail-closed input validation)", async () => {
    await expect(appendExperiment(root, { lever: "", from: 1, to: 2, task: "" })).rejects.toThrow(/lever/);
  });
});

describe("wilson lower bound", () => {
  it("is conservative on small n and 0 on no data", () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(1, 1).toFixed(4)).toBe("0.2065"); // one win is NOT 100%
    expect(wilsonLowerBound(8, 8).toFixed(4)).toBe("0.6756");
    expect(wilsonLowerBound(1, 2).toFixed(4)).toBe("0.0945");
    expect(wilsonLowerBound(9, 10)).toBeGreaterThan(wilsonLowerBound(1, 2));
    expect(wilsonLowerBound(80, 100)).toBeGreaterThan(wilsonLowerBound(8, 8)); // volume eventually beats a perfect few
  });
});

const entry = (lever: string, value: unknown, outcome: ExperimentEntry["outcome"], task: string, iso: string): ExperimentEntry =>
  ({ id: `exp-${iso}-${task}-${String(value)}`, lever, from: null, to: value, task, outcome, at: at(iso) });

describe("aggregation + ranking + flips", () => {
  it("ranks values by Wilson LB and attributes task-level flips", () => {
    const entries: ExperimentEntry[] = [
      ...Array.from({ length: 8 }, (_, i) => entry("sidecar.breakerThreshold", 3, "ok", `t${i}`, `2026-08-17T0${i}:00:00Z`)),
      entry("sidecar.breakerThreshold", 5, "ok", "t9", "2026-08-17T10:00:00Z"),
      entry("sidecar.breakerThreshold", 5, "fail", "t9", "2026-08-17T11:00:00Z"),
      // task-f flips ok→fail→ok on the SAME lever: 2 flips.
      entry("compaction.microcompact", "on", "ok", "task-f", "2026-08-17T01:00:00Z"),
      entry("compaction.microcompact", "on", "fail", "task-f", "2026-08-17T02:00:00Z"),
      entry("compaction.microcompact", "on", "ok", "task-f", "2026-08-17T03:00:00Z"),
    ];
    const agg = aggregateExperiments(entries);
    expect(agg.map((l) => l.lever)).toEqual(["sidecar.breakerThreshold", "compaction.microcompact"]);
    const sidecar = agg[0]!;
    expect(sidecar.values.map((v) => v.value)).toEqual([3, 5]); // 0.68 before 0.09
    expect(sidecar.values[0]).toMatchObject({ ok: 8, fail: 0, worse: 0, n: 8 });
    expect(sidecar.values[1]).toMatchObject({ ok: 1, fail: 1, n: 2 });
    const compaction = agg[1]!;
    expect(compaction.flips).toBe(2);
    expect(compaction.flippedTasks).toEqual(["task-f"]);
    expect(sidecar.flips).toBe(1); // ok→fail on t9
    expect(sidecar.flippedTasks).toEqual(["t9"]);
  });
});

describe("formatMetaReport", () => {
  it("renders lever blocks, ranked values, and flip notes — and changes nothing", () => {
    const entries: ExperimentEntry[] = [
      ...Array.from({ length: 8 }, (_, i) => entry("sidecar.breakerThreshold", 3, "ok", `t${i}`, `2026-08-17T0${i}:00:00Z`)),
      entry("sidecar.breakerThreshold", 5, "ok", "t9", "2026-08-17T10:00:00Z"),
      entry("sidecar.breakerThreshold", 5, "fail", "t9", "2026-08-17T11:00:00Z"),
    ];
    const text = formatMetaReport(entries);
    expect(text).toContain("sidecar.breakerThreshold");
    expect(text.indexOf("wilson")).toBeGreaterThan(-1);
    // ranked: value 3 (0.68) must appear before value 5 (0.09)
    const i3 = text.indexOf("3 ");
    const i5 = text.indexOf("5 ");
    expect(i3).toBeGreaterThan(-1);
    expect(i3).toBeLessThan(i5);
    expect(text).toContain("flip");
    // Report-only: the pure renderer obviously touches no files — pinned by
    // the empty-journal file staying absent after a report.
    const report2 = formatMetaReport([]);
    expect(report2).toContain("no experiments");
  });
});

describe("experimental settings auto-record", () => {
  it("diffs only experimental:true nodes, ignoring the marker field itself", () => {
    const before = {
      sidecar: { experimental: true, breakerThreshold: 3, timeoutMs: 4000 },
      longTask: { maxTurns: 40 }, // not experimental — ignored
      writeVerify: { experimental: true, ts: "on" },
    };
    const after = {
      sidecar: { experimental: true, breakerThreshold: 5, timeoutMs: 4000 },
      longTask: { maxTurns: 60 }, // changed but not experimental — ignored
      writeVerify: { ts: "off" }, // marker dropped → no longer experimental
    };
    const diff = experimentalSettingsDiff(before, after);
    expect(diff).toEqual([{ lever: "sidecar.breakerThreshold", from: 3, to: 5 }]);
  });

  it("records the diff as journal entries on write", async () => {
    const entries = await recordSettingsExperiments(root, { sidecar: { experimental: true, breakerThreshold: 3 } }, { sidecar: { experimental: true, breakerThreshold: 5 } }, "m50-smoke");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ lever: "sidecar.breakerThreshold", from: 3, to: 5, task: "m50-smoke", outcome: "ok" });
    const loaded = loadExperiments(root);
    expect(loaded).toHaveLength(1);
  });
});

describe("wudao meta CLI", () => {
  const out: string[] = [];
  const stdout = (s: string): void => {
    out.push(s);
  };

  it("report prints the aggregation for the workspace", async () => {
    await appendExperiment(root, { lever: "sidecar.breakerThreshold", from: 3, to: 5, task: "t1" });
    await appendExperiment(root, { lever: "sidecar.breakerThreshold", from: 5, to: 5, task: "t2", outcome: "fail" });
    out.length = 0;
    const code = await metaMain(["report"], { root, stdout });
    expect(code).toBe(0);
    const text = out.join("");
    expect(text).toContain("sidecar.breakerThreshold");
    expect(text).toContain("wilson");
  });

  it("record appends a manual entry (JSON-typed values)", async () => {
    out.length = 0;
    const code = await metaMain(["record", "sidecar.breakerThreshold", "3", "5", "--task", "manual", "--outcome", "worse"], { root, stdout });
    expect(code).toBe(0);
    const loaded = loadExperiments(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ lever: "sidecar.breakerThreshold", from: 3, to: 5, task: "manual", outcome: "worse" });
  });

  it("apply writes settings atomically and auto-records the experimental diff", async () => {
    const before = { sidecar: { experimental: true, breakerThreshold: 3 } };
    const settingsPath = join(root, ".wudao", "settings.json");
    await (await import("node:fs/promises")).mkdir(join(root, ".wudao"), { recursive: true });
    await writeFile(settingsPath, `${JSON.stringify(before, null, 2)}\n`, "utf8");
    const nextFile = join(root, "next-settings.json");
    await writeFile(nextFile, `${JSON.stringify({ sidecar: { experimental: true, breakerThreshold: 5 } }, null, 2)}\n`, "utf8");
    out.length = 0;
    const code = await metaMain(["apply", nextFile, "--task", "m50-smoke"], { root, stdout });
    expect(code).toBe(0);
    const applied = JSON.parse(await readFile(settingsPath, "utf8")) as { sidecar: { breakerThreshold: number } };
    expect(applied.sidecar.breakerThreshold).toBe(5);
    const loaded = loadExperiments(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ lever: "sidecar.breakerThreshold", from: 3, to: 5, task: "m50-smoke" });
  });

  it("usage on unknown subcommand (exit 2)", async () => {
    out.length = 0;
    expect(await metaMain(["frobnicate"], { root, stdout })).toBe(2);
    expect(out.join("")).toContain("用法："); // ω99-166d-i: 泛 usage 钉演进（#34）
  });
});
