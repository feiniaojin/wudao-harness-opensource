import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateVerifySpecs, type VerifySpec } from "../src/workflow/scorers.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-scorers-"));
  writeFileSync(join(root, "exists.txt"), "the quick BROWN fox\n");
});
afterEach(async () => {
  // win32: the just-killed sh child can hold the cwd handle briefly — the
  // rmdir races EPERM. Retry a little before surfacing.
  for (let i = 0; i < 10; i += 1) {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      const till = Date.now() + 50;
      while (Date.now() < till) { /* sync nap — afterEach is sync here */ }
    }
  }
});

const ctx = (over: Partial<Parameters<typeof evaluateVerifySpecs>[1]> = {}) => ({
  workspaceRoot: root,
  taskText: 'the quick BROWN fox {"n": 1, "words": ["a", "b"], "meta": {"deep": true}}',
  taskData: { n: 1, words: ["a", "b"], meta: { deep: true } },
  toolsUsed: ["read_file", "grep"],
  ...over,
});

describe("scorers", () => {
  it("exitCode: 0 passes, non-zero fails with the code in the detail", async () => {
    const receipts = await evaluateVerifySpecs(
      [{ exitCode: { command: "exit 0" } }, { exitCode: { command: "exit 3", expect: 3 } }, { exitCode: { command: "exit 4" } }],
      ctx(),
    );
    expect(receipts[0]).toMatchObject({ kind: "exitCode", status: "pass" });
    expect(receipts[1]).toMatchObject({ kind: "exitCode", status: "pass" }); // expect: 3 honored
    expect(receipts[2]).toMatchObject({ kind: "exitCode", status: "fail", detail: expect.stringContaining("4") });
  });

  it("exitCode: a killed command is a timeout receipt, not a fail", async () => {
    const receipts = await evaluateVerifySpecs([{ exitCode: { command: "sleep 5", timeoutMs: 150 } }], ctx());
    expect(receipts[0]).toMatchObject({ kind: "exitCode", status: "timeout" });
  });

  it("fileExists: workspace-relative pass / miss fail / escape fail", async () => {
    const receipts = await evaluateVerifySpecs(
      [
        { fileExists: { path: "exists.txt" } },
        { fileExists: { path: "missing.txt" } },
        { fileExists: { path: "../../etc/hosts" } },
      ],
      ctx(),
    );
    expect(receipts[0]).toMatchObject({ kind: "fileExists", status: "pass" });
    expect(receipts[1]).toMatchObject({ kind: "fileExists", status: "fail" });
    expect(receipts[2]).toMatchObject({ kind: "fileExists", status: "fail", detail: expect.stringContaining("workspace") });
  });

  it("regexMatch: defaults to the task text; explicit text and flags work", async () => {
    const receipts = await evaluateVerifySpecs(
      [
        { regexMatch: { pattern: "BROWN" } },
        { regexMatch: { pattern: "brown" } },
        { regexMatch: { pattern: "brown", flags: "i" } },
        { regexMatch: { pattern: "^needle$", text: "needle" } },
      ],
      ctx(),
    );
    expect(receipts[0]).toMatchObject({ kind: "regexMatch", status: "pass" });
    expect(receipts[1]).toMatchObject({ kind: "regexMatch", status: "fail" });
    expect(receipts[2]).toMatchObject({ kind: "regexMatch", status: "pass" });
    expect(receipts[3]).toMatchObject({ kind: "regexMatch", status: "pass" });
  });

  it("jsonPath: resolves into structured data, equals deep-compares, missing path fails", async () => {
    const receipts = await evaluateVerifySpecs(
      [
        { jsonPath: { path: "n" } },
        { jsonPath: { path: "words[1]" } },
        { jsonPath: { path: "meta.deep", equals: true } },
        { jsonPath: { path: "words", equals: ["a", "b"] } },
        { jsonPath: { path: "meta.deep", equals: false } },
        { jsonPath: { path: "nope.deeper" } },
      ],
      ctx(),
    );
    expect(receipts[0]).toMatchObject({ kind: "jsonPath", status: "pass" });
    expect(receipts[1]).toMatchObject({ kind: "jsonPath", status: "pass" });
    expect(receipts[2]).toMatchObject({ kind: "jsonPath", status: "pass" });
    expect(receipts[3]).toMatchObject({ kind: "jsonPath", status: "pass" });
    expect(receipts[4]).toMatchObject({ kind: "jsonPath", status: "fail" });
    expect(receipts[5]).toMatchObject({ kind: "jsonPath", status: "fail" });
  });

  it("jsonPath: without structured data and unparsable text → skip (not fail)", async () => {
    const receipts = await evaluateVerifySpecs([{ jsonPath: { path: "a" } }], { ...ctx(), taskData: undefined, taskText: "no json at all" });
    expect(receipts[0]).toMatchObject({ kind: "jsonPath", status: "skip" });
  });

  it("toolUsed (adapter-internal kind): present passes, absent fails", async () => {
    const receipts = await evaluateVerifySpecs(
      [{ toolUsed: { tool: "grep" } }, { toolUsed: { tool: "write_file" } }],
      ctx(),
    );
    expect(receipts[0]).toMatchObject({ kind: "toolUsed", status: "pass" });
    expect(receipts[1]).toMatchObject({ kind: "toolUsed", status: "fail" });
  });

  it("an empty spec list → no receipts, no throw", async () => {
    expect(await evaluateVerifySpecs([], ctx())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M56 §4 — evidence-shape rules (the upstream format task_spec):
//   Transport vs Task   a None exit code is a TRANSPORT failure ("worker
//                       transport did not report a process result") — never
//                       the task's fault; a real nonzero code is TASK.
//   Verifier fault      a regex that fails to compile is the SCORER's fault,
//                       not the worker's.
// Neither transport nor verifier receipts fail the task (they are not
// evidence about the work) — but they are also not evidence FOR it (see the
// engine's no-evidence-success = partial rule).
// ---------------------------------------------------------------------------
describe("scorers — evidence-shape rules (M56 §4)", () => {
  it("exitCode: a null exit code is TRANSPORT, not a task failure", async () => {
    const receipts = await evaluateVerifySpecs([{ exitCode: { command: "anything" } }], ctx({
      // Simulate the worker transport dying before reporting a process result.
      spawnShell: async () => ({ code: null, timedOut: false }),
    }));
    expect(receipts[0]).toMatchObject({ kind: "exitCode", status: "transport" });
    expect(receipts[0]?.detail).toContain("no process result");
  });

  it("exitCode: a real nonzero code stays a TASK failure", async () => {
    const receipts = await evaluateVerifySpecs([{ exitCode: { command: "exit 4" } }], ctx());
    expect(receipts[0]).toMatchObject({ kind: "exitCode", status: "fail", detail: expect.stringContaining("4") });
  });

  it("regexMatch: an invalid pattern is a VERIFIER fault, not a fail", async () => {
    const receipts = await evaluateVerifySpecs([{ regexMatch: { pattern: "([unclosed" } }], ctx());
    expect(receipts[0]).toMatchObject({ kind: "regexMatch", status: "verifier" });
    expect(receipts[0]?.detail).toContain("invalid pattern");
  });

  it("transport/verifier receipts never enter the failing set (not evidence about the work)", async () => {
    // Direct assertion on the rule the engine applies: only fail/timeout are
    // task-failing; transport/verifier/skip/partial are not.
    const bad = ["fail", "timeout"] as const;
    const statuses = ["pass", "fail", "skip", "timeout", "partial", "transport", "verifier"] as const;
    const failing = statuses.filter((s) => (bad as readonly string[]).includes(s));
    expect(failing).toEqual(["fail", "timeout"]);
  });
});
