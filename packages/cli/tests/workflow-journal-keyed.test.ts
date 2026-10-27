import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskKey,
  loadJournal,
  openJournal,
  journalFilePath,
  truncateTaskJournal,
  workflowStatePath,
  writeWorkflowState,
  readWorkflowState,
  listWorkflowStates,
  gcWorkflowRuns,
  type WorkflowRunState,
} from "../src/workflow/journal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-journal29-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("taskKey (content addressing)", () => {
  it("key = sha256(prompt + canonical opts); label is NOT part of the key", () => {
    const a = taskKey("prompt-a", { label: "one", allowTools: ["read_file", "grep"], maxTurns: 4 });
    const b = taskKey("prompt-a", { label: "TOTALLY-DIFFERENT", allowTools: ["read_file", "grep"], maxTurns: 4 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("option key ORDER does not matter (canonical serialization)", () => {
    const a = taskKey("p", { allowTools: ["read_file"], maxTurns: 2 });
    const b = taskKey("p", { maxTurns: 2, allowTools: ["read_file"] });
    expect(a).toBe(b);
  });
  it("a different prompt / different options → different key", () => {
    expect(taskKey("p1", {})).not.toBe(taskKey("p2", {}));
    expect(taskKey("p", { maxTurns: 2 })).not.toBe(taskKey("p", { maxTurns: 3 }));
    expect(taskKey("p", { allowTools: ["read_file"] })).not.toBe(taskKey("p", { allowTools: ["grep"] }));
  });
  it("responseSchema/verify/retry participate; nested keys are order-insensitive", () => {
    const schema1 = { type: "object" as const, required: ["a"], properties: { a: { type: "number" as const } } };
    const schema2 = { properties: { a: { type: "number" as const } }, required: ["a"], type: "object" as const };
    expect(taskKey("p", { responseSchema: schema1 })).toBe(taskKey("p", { responseSchema: schema2 }));
    expect(taskKey("p", { retry: 0 })).not.toBe(taskKey("p", {}));
  });
});

describe("keyed journal load + seq reorder", () => {
  it("tasks come back sorted by seq even when appended in completion order", async () => {
    const path = journalFilePath(dir, "wf-x");
    const j = openJournal(path);
    await j.append({ type: "run-started", runId: "wf-x", workflow: "w", startedAt: "t0", engine: "js" });
    // Parallel completion order: seq 1 finishes FIRST (appended first).
    await j.append({ type: "task-finished", seq: 1, key: "k1", prompt: "p1", ok: true, text: "r1", toolsUsed: [], cost: { promptTokens: 10, completionTokens: 2 }, endedAt: "t1" });
    await j.append({ type: "task-finished", seq: 0, key: "k0", prompt: "p0", ok: true, text: "r0", toolsUsed: [], cost: { promptTokens: 20, completionTokens: 4 }, endedAt: "t2" });
    await j.append({ type: "task-finished", seq: 2, key: "k2", prompt: "p2", ok: true, text: "r2", toolsUsed: [], cost: { promptTokens: 30, completionTokens: 6 }, endedAt: "t3" });
    await j.append({ type: "log", message: "hi" });
    await j.append({ type: "run-finished", ok: true });

    const loaded = loadJournal(path);
    expect(loaded.records).toHaveLength(6);
    expect(loaded.tasks.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(loaded.tasks[0]).toMatchObject({ key: "k0", text: "r0" });
    expect(loaded.tasks.map((t) => t.cost.promptTokens)).toEqual([20, 10, 30]);
    // The legacy resume map (old step records) stays empty but present.
    expect(loaded.finishedOk.size).toBe(0);
  });

  it("verify receipts and structured data round-trip on the entry", async () => {
    const path = journalFilePath(dir, "wf-y");
    const j = openJournal(path);
    await j.append({
      type: "task-finished", seq: 0, key: "k", prompt: "p", ok: true, text: '```json\n{"n":1}\n```',
      data: { n: 1 }, toolsUsed: ["grep"],
      cost: { promptTokens: 5, completionTokens: 1 },
      verify: [{ kind: "regexMatch", status: "pass" }], endedAt: "t",
    });
    const loaded = loadJournal(path);
    expect(loaded.tasks[0]?.data).toEqual({ n: 1 });
    expect(loaded.tasks[0]?.verify).toEqual([{ kind: "regexMatch", status: "pass" }]);
  });

  it("M22 legacy records still load (mixed journals keep working)", async () => {
    const path = journalFilePath(dir, "wf-old");
    const j = openJournal(path);
    await j.append({ type: "run-started", runId: "wf-old", workflow: "w", startedAt: "t0" });
    await j.append({ type: "step-started", id: "s1" });
    await j.append({ type: "step-finished", id: "s1", ok: true, finalText: "x", toolsUsed: [], endedAt: "t1" });
    await j.append({ type: "task-finished", seq: 0, key: "k0", prompt: "p", ok: true, text: "y", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "t2" });
    const loaded = loadJournal(path);
    expect(loaded.finishedOk.get("s1")?.finalText).toBe("x"); // legacy map intact
    expect(loaded.tasks.map((t) => t.key)).toEqual(["k0"]);   // keyed entries intact
  });
});

describe("truncateTaskJournal (edit-point truncation)", () => {
  it("drops every task record whose seq is NOT kept; run markers and logs stay", async () => {
    const path = journalFilePath(dir, "wf-t");
    const j = openJournal(path);
    await j.append({ type: "run-started", runId: "wf-t", workflow: "w", startedAt: "t0" });
    await j.append({ type: "task-started", seq: 0, key: "k0" });
    await j.append({ type: "task-finished", seq: 0, key: "k0", prompt: "p0", ok: true, text: "r0", toolsUsed: [], cost: { promptTokens: 1, completionTokens: 1 }, endedAt: "t1" });
    await j.append({ type: "log", message: "keep me" });
    await j.append({ type: "task-started", seq: 1, key: "k1" });
    await j.append({ type: "task-finished", seq: 1, key: "k1", prompt: "p1", ok: true, text: "r1", toolsUsed: [], cost: { promptTokens: 1, completionTokens: 1 }, endedAt: "t2" });
    await j.append({ type: "task-failed", seq: 2, key: "k2", label: "t2", category: "verify-failed", message: "no", endedAt: "t3" });
    await j.append({ type: "run-finished", ok: false });

    await truncateTaskJournal(path, new Set([0]));

    const after = loadJournal(path);
    expect(after.tasks.map((t) => t.seq)).toEqual([0]);
    expect(after.records.some((r) => r.type === "log")).toBe(true);
    expect(after.records.some((r) => r.type === "run-started")).toBe(true);
    expect(after.records.some((r) => r.type === "run-finished")).toBe(true);
    expect(after.records.some((r) => r.type === "task-failed")).toBe(false);
  });

  it("keeps everything for an empty drop set of nothing (all seqs kept)", async () => {
    const path = journalFilePath(dir, "wf-t2");
    const j = openJournal(path);
    await j.append({ type: "task-finished", seq: 0, key: "k0", prompt: "p", ok: true, text: "r", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "t" });
    await truncateTaskJournal(path, new Set([0]));
    expect(loadJournal(path).tasks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// state.json — terminal run snapshots (atomic write, tolerant read, GC)
// ---------------------------------------------------------------------------

const state = (runId: string, over: Partial<WorkflowRunState> = {}): WorkflowRunState => ({
  schemaVersion: 1,
  runId,
  workflow: "demo",
  status: "completed",
  startedAt: "2026-08-16T00:00:00.000Z",
  finishedAt: "2026-08-16T00:01:00.000Z",
  tasksTotal: 2,
  tasksOk: 2,
  tasksReplayed: 0,
  cost: { promptTokens: 100, completionTokens: 20 },
  ...over,
});

describe("workflow state.json", () => {
  it("round-trips through an atomic write (no tmp file left behind)", async () => {
    await writeWorkflowState(dir, state("wf-a"));
    const p = workflowStatePath(dir, "wf-a");
    expect(readWorkflowState(p)).toMatchObject({ runId: "wf-a", status: "completed", schemaVersion: 1 });
    expect(readdirSync(join(dir, ".wudao", "workflows")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("tolerant read: missing file → undefined; corrupt file → undefined", async () => {
    expect(readWorkflowState(join(dir, "nope.state.json"))).toBeUndefined();
    const wfDir = join(dir, ".wudao", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "wf-bad.state.json"), "{corrupt");
    expect(readWorkflowState(join(wfDir, "wf-bad.state.json"))).toBeUndefined();
  });

  it("lists newest-first and skips corrupt state files", async () => {
    await writeWorkflowState(dir, state("wf-1"));
    await writeWorkflowState(dir, state("wf-2"));
    await writeWorkflowState(dir, state("wf-3"));
    const wfDir = join(dir, ".wudao", "workflows");
    writeFileSync(join(wfDir, "wf-bad.state.json"), "{corrupt");
    const listed = listWorkflowStates(dir);
    expect(listed.map((s) => s.runId)).toEqual(["wf-3", "wf-2", "wf-1"]);
  });

  it("empty workspace lists nothing without creating anything", () => {
    expect(listWorkflowStates(dir)).toEqual([]);
    expect(existsSync(join(dir, ".wudao"))).toBe(false); // reading never creates files
  });
});

describe("gcWorkflowRuns (50-run GC)", () => {
  it("keeps the newest 50 runs and prunes the oldest (journal + state files)", async () => {
    const ids = Array.from({ length: 52 }, (_, i) => `wf-${String(i).padStart(3, "0")}`);
    for (const id of ids) {
      await writeWorkflowState(dir, state(id));
      const j = openJournal(journalFilePath(dir, id));
      await j.append({ type: "run-started", runId: id, workflow: "w", startedAt: "t" });
    }
    await gcWorkflowRuns(dir, 50);
    const remaining = listWorkflowStates(dir).map((s) => s.runId);
    expect(remaining).toHaveLength(50);
    expect(remaining).not.toContain("wf-000");
    expect(remaining).not.toContain("wf-001");
    expect(remaining).toContain("wf-002");
    const wfDir = join(dir, ".wudao", "workflows");
    expect(readdirSync(wfDir).some((f) => f.startsWith("wf-000."))).toBe(false);
  });

  it("orphans (journal without state) are pruned FIRST", async () => {
    // 49 complete runs + 2 orphans → GC prunes orphans, keeps all complete runs.
    for (let i = 0; i < 49; i++) {
      const id = `wf-${String(i).padStart(3, "0")}`;
      await writeWorkflowState(dir, state(id));
      await openJournal(journalFilePath(dir, id)).append({ type: "run-started", runId: id, workflow: "w", startedAt: "t" });
    }
    for (const orphan of ["wf-orphan-1", "wf-orphan-2"]) {
      await openJournal(journalFilePath(dir, orphan)).append({ type: "run-started", runId: orphan, workflow: "w", startedAt: "t" });
    }
    await gcWorkflowRuns(dir, 50);
    const wfDir = join(dir, ".wudao", "workflows");
    expect(readdirSync(wfDir).some((f) => f.startsWith("wf-orphan"))).toBe(false);
    expect(listWorkflowStates(dir)).toHaveLength(49);
  });
});
