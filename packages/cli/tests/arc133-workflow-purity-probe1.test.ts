// T006 audit probe harness. Runs against the BUILT dist (../dist/...) so the
// probe exercises the same bytes the CLI ships. All tests use scripted models
// — no provider key, no network.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  journalFilePath,
  loadJournal,
  openJournal,
  workflowIdentity,
  taskKey,
} from "../dist/workflow/journal.js";
import {
  runScriptWorkflow,
  WorkflowPurityError,
} from "../dist/workflow/engine.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "t006-probe-"));
  writeFileSync(join(root, "note.txt"), "x");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete (globalThis as { __drift?: string }).__drift;
  delete (globalThis as { __label?: string }).__label;
  delete (globalThis as { __wudaoDrift?: string }).__wudaoDrift;
});

function scriptedModel(script: ReadonlyArray<{ role: "assistant"; content: string }>) {
  let i = 0;
  return {
    get calls() { return i; },
    client: {
      async generate(): Promise<{ role: "assistant"; content: string }> {
        const next = script[i++];
        if (!next) throw new Error(`scripted model exhausted at call ${i}`);
        return next;
      },
    },
  };
}
const say = (c: string): { role: "assistant"; content: string } => ({ role: "assistant", content: c });

function baseOpts(model: unknown, p: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceRoot: root,
    model,
    journal: openJournal(p),
    workflowName: "probe",
    ...over,
  };
}

const path = (tag: string): string => join(root, `wf-${tag}.jsonl`);

// ============================================================================
// PART 1 — workflowIdentity hashing edge cases
// ============================================================================
describe("P1 workflowIdentity edge cases", () => {
  it("undefined vs {} argsHash differ (test already covers, sanity check)", () => {
    expect(workflowIdentity("x", undefined).argsHash).not.toBe(workflowIdentity("x", {}).argsHash);
  });

  it("key-order invariance (deep) — equal hashes regardless of key order", () => {
    const a = workflowIdentity("x", { a: 1, b: { c: 2, d: 3 }, e: [4, 5] });
    const b = workflowIdentity("x", { e: [4, 5], b: { d: 3, c: 2 }, a: 1 });
    expect(a.argsHash).toBe(b.argsHash);
  });

  it("T006 F3 修复后：NaN → 类型化错误点名路径（不再静默碰撞 null）", () => {
    expect(() => workflowIdentity("x", { a: Number.NaN })).toThrow(/args.a is NaN/);
  });

  it("T006 F3 修复后：Infinity → 类型化错误", () => {
    expect(() => workflowIdentity("x", { a: Number.POSITIVE_INFINITY })).toThrow(/Infinity/);
  });

  it("TRAP: BigInt throws JSON.stringify — workflowIdentity rejects", () => {
    expect(() => workflowIdentity("x", { a: 10n })).toThrow();
  });

  it("T006 F3 修复后：function 字段 → 类型化错误（不再静默丢弃碰撞 {}）", () => {
    expect(() => workflowIdentity("x", { a: () => 1 })).toThrow(/function/);
  });

  it("Date instance → ISO string — both Date(2024-01-01) hash equal regardless of instance", () => {
    const a = workflowIdentity("x", { at: new Date("2024-01-01T00:00:00Z") }).argsHash;
    const b = workflowIdentity("x", { at: new Date("2024-01-01T00:00:00Z") }).argsHash;
    expect(a).toBe(b);
  });

  it("CIRCULAR reference throws — workflowIdentity must reject, not crash silently", () => {
    const circ: Record<string, unknown> = { a: 1 };
    circ.self = circ;
    expect(() => workflowIdentity("x", circ)).toThrow();
  });

  it("Symbol-keyed fields silently dropped — collision with no-symbol version", () => {
    const withSym = workflowIdentity("x", { [Symbol("s")]: "x", a: 1 }).argsHash;
    const noSym = workflowIdentity("x", { a: 1 }).argsHash;
    expect(withSym).toBe(noSym);
  });

  it("ARRAY order is preserved (not sorted) — same elements different order hash unequal", () => {
    const a = workflowIdentity("x", { xs: [1, 2, 3] }).argsHash;
    const b = workflowIdentity("x", { xs: [3, 2, 1] }).argsHash;
    expect(a).not.toBe(b); // design intent: arrays are order-sensitive
  });
});

// ============================================================================
// PART 2 — purityArmed decision matrix (engine.ts:660-668)
// ============================================================================
const DRIFT_SCRIPT = "const a = await task('topic ' + globalThis.__drift); return a.text;";

describe("P2 purityArmed decision matrix", () => {
  it("A: identity set, resumeIdentity UNSET → drift truncates (not purity)", async () => {
    const p = path("A");
    (globalThis as { __drift?: string }).__drift = "alpha";
    const m1 = scriptedModel([say("a1")]);
    const id = workflowIdentity(DRIFT_SCRIPT, undefined);
    const r1 = await runScriptWorkflow(DRIFT_SCRIPT, baseOpts(m1.client, p, { identity: id }) as never);
    expect(r1.ok).toBe(true);
    const tasks = loadJournal(p).tasks;

    (globalThis as { __drift?: string }).__drift = "beta";
    const m2 = scriptedModel([say("b2")]);
    // resumeIdentity intentionally omitted → purityArmed=false → truncate
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      baseOpts(m2.client, p, { identity: id, resumeTasks: tasks }) as never,
    );
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
  });

  it("C: identity===resumeIdentity, resumeTasks=[] (EMPTY) → drift truncates (purity DISARMED by length)", async () => {
    const p = path("C");
    (globalThis as { __drift?: string }).__drift = "alpha";
    const m1 = scriptedModel([say("a1")]);
    const id = workflowIdentity(DRIFT_SCRIPT, undefined);
    await runScriptWorkflow(DRIFT_SCRIPT, baseOpts(m1.client, p, { identity: id }) as never);

    (globalThis as { __drift?: string }).__drift = "beta";
    const m2 = scriptedModel([say("b2")]);
    // resumeTasks:[] (explicit empty) — condition is `(opts.resumeTasks?.length ?? 0) > 0`
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      baseOpts(m2.client, p, { identity: id, resumeIdentity: id, resumeTasks: [] }) as never,
    );
    // DESIGN CALL: with empty resumeTasks, no replay → purity is disarmed.
    // Drift truncates the (empty anyway) prefix and re-runs.
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
  });

  it("D: identity===resumeIdentity, resumeTasks=[1] → purity THROWS (baseline)", async () => {
    const p = path("D");
    (globalThis as { __drift?: string }).__drift = "alpha";
    const m1 = scriptedModel([say("a1")]);
    const id = workflowIdentity(DRIFT_SCRIPT, undefined);
    await runScriptWorkflow(DRIFT_SCRIPT, baseOpts(m1.client, p, { identity: id }) as never);
    const tasks = loadJournal(p).tasks;

    (globalThis as { __drift?: string }).__drift = "beta";
    const m2 = scriptedModel([say("b2")]);
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      baseOpts(m2.client, p, { identity: id, resumeIdentity: id, resumeTasks: tasks }) as never,
    );
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
    expect(r2.failure?.message).toContain("call #1");
  });

  it("E: script identity mismatch (edit) → drift truncates (not purity)", async () => {
    const p = path("E");
    const m1 = scriptedModel([say("a1"), say("b1")]);
    const v1 = "const a = await task('first');\nconst b = await task('second');\nreturn [a.text, b.text];";
    const idV1 = workflowIdentity(v1, undefined);
    await runScriptWorkflow(v1, baseOpts(m1.client, p, { identity: idV1 }) as never);
    const tasks = loadJournal(p).tasks;

    const v2 = "const a = await task('first');\nconst b = await task('SECOND-EDITED');\nreturn [a.text, b.text];";
    const idV2 = workflowIdentity(v2, undefined);
    const m2 = scriptedModel([say("b2")]);
    const r2 = await runScriptWorkflow(v2, baseOpts(m2.client, p, { identity: idV2, resumeIdentity: idV1, resumeTasks: tasks }) as never);
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
    expect(r2.tasksReplayed).toBe(1);
  });

  it("F: argsHash mismatch only → drift truncates (not purity)", async () => {
    const p = path("F");
    const SCRIPT = "const a = await task('x', { label: globalThis.__label }); return a.text;";
    (globalThis as { __label?: string }).__label = "A";
    const m1 = scriptedModel([say("a1")]);
    const idA = workflowIdentity(SCRIPT, { label: "A" });
    await runScriptWorkflow(SCRIPT, baseOpts(m1.client, p, { identity: idA, args: { label: "A" } }) as never);
    const tasks = loadJournal(p).tasks;

    (globalThis as { __label?: string }).__label = "B";
    const m2 = scriptedModel([say("b2")]);
    const idB = workflowIdentity(SCRIPT, { label: "B" });
    const r2 = await runScriptWorkflow(
      SCRIPT,
      baseOpts(m2.client, p, { identity: idB, resumeIdentity: idA, resumeTasks: tasks, args: { label: "B" } }) as never,
    );
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
  });

  it("G: NO identity on either side (legacy call shape) → drift truncates (fail-open)", async () => {
    const p = path("G");
    const m1 = scriptedModel([say("a1")]);
    await runScriptWorkflow("const a = await task('first');\nreturn a.text;", baseOpts(m1.client, p) as never);
    const tasks = loadJournal(p).tasks;

    const m2 = scriptedModel([say("a2")]);
    const r2 = await runScriptWorkflow(
      "const a = await task('EDITED');\nreturn a.text;",
      baseOpts(m2.client, p, { resumeTasks: tasks }) as never,
    );
    expect(r2.ok).toBe(true);
    expect(r2.failure?.category).not.toBe("purity-violation");
  });

  it("H: identity===resumeIdentity but resumeIdentity is wrong object identity (hash strings match) → purityArmed=true", async () => {
    // identity and resumeIdentity are SEPARATE objects — only string hash values
    // are compared. The check is on .scriptHash/.argsHash, not on ===.
    const p = path("H");
    (globalThis as { __drift?: string }).__drift = "alpha";
    const m1 = scriptedModel([say("a1")]);
    const id = workflowIdentity(DRIFT_SCRIPT, undefined);
    await runScriptWorkflow(DRIFT_SCRIPT, baseOpts(m1.client, p, { identity: id }) as never);
    const tasks = loadJournal(p).tasks;

    (globalThis as { __drift?: string }).__drift = "beta";
    // Construct resumeIdentity as a FRESH object — same hash values
    // （T007 P1 后身份含 allowHash——手造对象须带全字段，否则=授予面变了→编辑语义）
    const resumeIdentity = { scriptHash: id.scriptHash, argsHash: id.argsHash, allowHash: id.allowHash };
    const m2 = scriptedModel([say("b2")]);
    const r2 = await runScriptWorkflow(
      DRIFT_SCRIPT,
      baseOpts(m2.client, p, { identity: id, resumeIdentity, resumeTasks: tasks }) as never,
    );
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("purity-violation");
  });
});
