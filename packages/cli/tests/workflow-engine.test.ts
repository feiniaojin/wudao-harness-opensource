import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import {
  runScriptWorkflow,
  planFromWorkflow,
  runPlanWorkflow,
  type JsflowOptions,
} from "../src/workflow/engine.js";
import { journalFilePath, loadJournal, openJournal, readWorkflowState, workflowStatePath } from "../src/workflow/journal.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-engine-"));
  writeFileSync(join(root, "note.txt"), "the quick brown fox");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// Scripted model with per-call usage reporting (the M24 usage channel is the
// only way tokens flow out of a provider call).
function scriptedModel(
  script: readonly (AssistantMessage | Error)[],
  usage: { promptTokens: number; completionTokens: number } = { promptTokens: 100, completionTokens: 20 },
): { client: ModelClient; inputs: ModelInput[]; calls: number } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    get calls() { return i; },
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        const next = script[i];
        i += 1;
        if (next === undefined) throw new Error("scripted responses exhausted");
        if (next instanceof Error) throw next;
        input.onUsage?.({
          promptTokens: usage.promptTokens, cacheHitTokens: 0, cacheMissTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
        });
        return next;
      },
    },
  };
}

const say = (content: string): AssistantMessage => ({ role: "assistant", content });

/** Dispatches by the LAST user message's content — safe under parallelism,
 *  where generate() call order across tasks is scheduling-dependent. */
function keyedModel(
  map: Record<string, AssistantMessage | Error>,
  usage: { promptTokens: number; completionTokens: number } = { promptTokens: 100, completionTokens: 20 },
): { client: ModelClient; inputs: ModelInput[]; calls: number } {
  const inputs: ModelInput[] = [];
  let calls = 0;
  return {
    inputs,
    get calls() {
      return calls;
    },
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        calls += 1;
        const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
        const content = (lastUser as { content: string } | undefined)?.content ?? "";
        for (const [needle, response] of Object.entries(map)) {
          if (content.includes(needle)) {
            if (response instanceof Error) throw response;
            input.onUsage?.({
              promptTokens: usage.promptTokens, cacheHitTokens: 0, cacheMissTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
            });
            return response;
          }
        }
        throw new Error(`keyedModel: no scripted response for prompt "${content.slice(0, 60)}"`);
      },
    },
  };
}

function opts(model: ModelClient, over: Partial<JsflowOptions> = {}): JsflowOptions {
  const runId = over.workflowName ?? "test-run";
  return {
    workspaceRoot: root,
    model,
    journal: openJournal(journalFilePath(root, `wf-${runId}-${Math.random().toString(16).slice(2, 8)}`)),
    workflowName: runId,
    ...over,
  };
}

describe("runScriptWorkflow", () => {
  it("runs a 2-task script with JS data flow; journal entries keyed by content", async () => {
    const runId = `wf-two-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    const model = scriptedModel([say("ALPHA"), say("BETA")]);
    const result = await runScriptWorkflow(
      "const a = await task('produce alpha');\nconst b = await task('summarize ' + a.text);\nreturn [a.text, b.text];",
      { ...opts(model.client, { workflowName: "two-step" }), journal: openJournal(path) },
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual(["ALPHA", "BETA"]);
    expect(result.tasksTotal).toBe(2);
    expect(result.tasksOk).toBe(2);
    // The second prompt carries the first task's output.
    const secondUser = model.inputs[1]?.messages.find((m) => m.role === "user") as { content: string } | undefined;
    expect(secondUser?.content).toContain("summarize ALPHA");
    // Journal: task-finished entries in seq order, cost + keys present.
    const journal = loadJournal(path);
    expect(journal.tasks.map((t) => t.seq)).toEqual([0, 1]);
    expect(journal.tasks[0]?.cost).toEqual({ promptTokens: 100, completionTokens: 20 });
    expect(journal.tasks[0]?.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("retry-once: a first-attempt throw is retried; budget bills only the final ok", async () => {
    const model = scriptedModel([new Error("provider 503"), say("RECOVERED")], { promptTokens: 60, completionTokens: 10 });
    const result = await runScriptWorkflow(
      "const r = await task('flaky');\nreturn { ok: r.ok, remaining: budget.remaining };",
      opts(model.client, { workflowName: "retry" }),
    );
    expect(model.calls).toBe(2);
    expect(result.returnValue).toEqual({ ok: true, remaining: 500_000 - 70 });
  });

  it("retry can be disabled per task (retry: 0 → single attempt)", async () => {
    const model = scriptedModel([new Error("boom")]);
    const result = await runScriptWorkflow(
      "const r = await task('p', { retry: 0 });\nreturn r.ok;",
      opts(model.client, { workflowName: "noretry" }),
    );
    expect(model.calls).toBe(1);
    expect(result.returnValue).toBe(false);
  });

  it("task-threw: exhausted retries degrade to a failed task result; the script keeps going", async () => {
    const model = scriptedModel([new Error("one"), new Error("two"), say("later")]);
    const result = await runScriptWorkflow(
      "const bad = await task('p');\nconst good = await task('q');\nreturn [bad.ok, bad.failure.category, good.text];",
      opts(model.client, { workflowName: "throws" }),
    );
    expect(result.ok).toBe(true); // the script decided how to handle it
    expect(result.returnValue).toEqual([false, "task-threw", "later"]);
  });

  it("no-structured-output: schema requested, prose returned", async () => {
    const model = scriptedModel([say("I will not use JSON, sorry.")]);
    const result = await runScriptWorkflow(
      "const r = await task('extract', { retry: 0, responseSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } });\nreturn r.ok ? 'ok' : r.failure.category;",
      opts(model.client, { workflowName: "noschema" }),
    );
    expect(result.returnValue).toBe("no-structured-output");
  });

  it("invalid-structured-output: JSON present but wrong shape", async () => {
    const model = scriptedModel([say('```json\n{"n": "not a number"}\n```')]);
    const result = await runScriptWorkflow(
      "const r = await task('extract', { retry: 0, responseSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } });\nreturn r.ok ? 'ok' : r.failure.category;",
      opts(model.client, { workflowName: "badschema" }),
    );
    expect(result.returnValue).toBe("invalid-structured-output");
  });

  it("structured output happy path: parsed data returned + journaled", async () => {
    const model = scriptedModel([say('prose\n```json\n{"n": 42}\n```')]);
    const path = journalFilePath(root, `wf-happy-${Math.random().toString(16).slice(2, 8)}`);
    const result = await runScriptWorkflow(
      "const r = await task('extract', { retry: 0, responseSchema: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } });\nreturn r.data;",
      { ...opts(model.client, { workflowName: "happy" }), journal: openJournal(path) },
    );
    expect(result.returnValue).toEqual({ n: 42 });
    expect(loadJournal(path).tasks[0]?.data).toEqual({ n: 42 });
  });

  it("verify-failed: a failing scorer fails the task (after retry)", async () => {
    const model = scriptedModel([say("no marker here"), say("still no marker")]);
    const result = await runScriptWorkflow(
      "const r = await task('p', { verify: [{ regexMatch: { pattern: 'MARKER' } }] });\nreturn r.ok ? 'ok' : r.failure.category;",
      opts(model.client, { workflowName: "verify" }),
    );
    expect(model.calls).toBe(2); // default retry once
    expect(result.returnValue).toBe("verify-failed");
  });

  it("verify pass receipts ride on the result", async () => {
    const model = scriptedModel([say("has MARKER inside")]);
    const result = await runScriptWorkflow(
      "const r = await task('p', { verify: [{ regexMatch: { pattern: 'MARKER' } }] });\nreturn r.verify?.map(v => v.status);",
      opts(model.client, { workflowName: "verifypass" }),
    );
    expect(result.returnValue).toEqual(["pass"]);
  });

  it("budget-exhausted fails the RUN (category budget-exhausted), state.json status failed", async () => {
    const model = keyedModel({ t0: say("a"), t1: say("b"), t2: say("c") }, { promptTokens: 60, completionTokens: 0 });
    const runId = `wf-budget-${Math.random().toString(16).slice(2, 8)}`;
    const result = await runScriptWorkflow(
      "for (let i = 0; i < 3; i++) { await task('t' + i); }\nreturn 'never';",
      { ...opts(model.client, { workflowName: "budget" }), journal: openJournal(journalFilePath(root, runId)), budgetTokens: 100 },
    );
    expect(result.ok).toBe(false);
    expect(result.failure?.category).toBe("budget-exhausted");
    expect(result.tasksOk).toBe(2); // t0 + t1 charge 60 each → spent 120 ≥ 100 at t2
    const state = readWorkflowState(workflowStatePath(root, runId));
    expect(state).toMatchObject({ status: "failed", tasksOk: 2 });
    expect(state?.failure?.category).toBe("budget-exhausted");
  });

  it("aborted: never retried, zero model calls when already aborted", async () => {
    const model = scriptedModel([say("x")]);
    const controller = new AbortController();
    controller.abort();
    const result = await runScriptWorkflow(
      "const r = await task('p');\nreturn r.ok ? 'ok' : r.failure.category;",
      { ...opts(model.client, { workflowName: "abort" }), signal: controller.signal },
    );
    expect(model.calls).toBe(0);
    expect(result.returnValue).toBe("aborted");
  });

  it("an AbortError from the model classifies aborted and is not retried", async () => {
    const abortError = Object.assign(new Error("aborted by user"), { name: "AbortError" });
    const model = scriptedModel([abortError, say("should not happen")]);
    const result = await runScriptWorkflow(
      "const r = await task('p');\nreturn r.ok ? 'ok' : r.failure.category;",
      opts(model.client, { workflowName: "abort2" }),
    );
    expect(model.calls).toBe(1);
    expect(result.returnValue).toBe("aborted");
  });

  it("loop-until-budget: the script reads budget.remaining to stop early", async () => {
    const model = scriptedModel([say("1"), say("2"), say("3"), say("4")], { promptTokens: 50, completionTokens: 0 });
    const result = await runScriptWorkflow(
      "const out = [];\nwhile (budget.remaining >= 50) { out.push((await task('t' + out.length)).text); }\nreturn out;",
      opts(model.client, { workflowName: "loop", budgetTokens: 150 }),
    );
    expect(result.returnValue).toEqual(["1", "2", "3"]); // 3 × 50 = 150 spent → loop exits
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Replay / resume / edit-point truncation
// ---------------------------------------------------------------------------

describe("journal replay", () => {
  it("resume: matched keys replay with ZERO model calls; the rest re-run", async () => {
    const runId = `wf-resume-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    // First run: task0 ok, task1 fails verification.
    const first = scriptedModel([say("ONE"), say("nothing to see here")]);
    const r1 = await runScriptWorkflow(
      "const a = await task('first');\nconst b = await task('second', { verify: [{ regexMatch: { pattern: 'MARKER' } }], retry: 0 });\nreturn a.text;",
      { ...opts(first.client, { workflowName: "resume" }), journal: openJournal(path) },
    );
    expect(r1.ok).toBe(true); // script handled the failed task itself

    // Resume: replay task0 + task1's final ok entry; only the third call runs.
    const second = scriptedModel([say("has MARKER")]);
    const r2 = await runScriptWorkflow(
      "const a = await task('first');\nconst b = await task('second', { verify: [{ regexMatch: { pattern: 'MARKER' } }], retry: 0 });\nreturn [a.text, b.text];",
      {
        ...opts(second.client, { workflowName: "resume" }),
        journal: openJournal(path),
        resumeTasks: loadJournal(path).tasks,
      },
    );
    expect(second.calls).toBe(1); // only the diverged/failed task re-ran
    expect(r2.tasksReplayed).toBe(1);
    expect(r2.returnValue).toEqual(["ONE", "has MARKER"]);
  });

  it("resume across a FAILED task: the gap re-runs, downstream ok entries still replay (no truncation)", async () => {
    const runId = `wf-gap-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    // First run: A ok (seq0), B fails verification (seq1), C ok (seq2) — the
    // script treats a failed task as a value and keeps going.
    const script =
      "const a = await task('task A');\n" +
      "const b = await task('task B', { verify: [{ regexMatch: { pattern: 'MARKER' } }], retry: 0 });\n" +
      "const c = await task('task C');\n" +
      "return [a.text, b.ok, c.text];";
    const first = keyedModel({ "task A": say("A-OUT"), "task B": say("no marker"), "task C": say("C-OUT") });
    const r1 = await runScriptWorkflow(script, { ...opts(first.client, { workflowName: "gap" }), journal: openJournal(path) });
    expect(r1.returnValue).toEqual(["A-OUT", false, "C-OUT"]);
    expect(loadJournal(path).tasks.map((t) => t.seq)).toEqual([0, 2]); // seq1 failed → not replayable

    // Resume with B fixed: A and C MUST come from the journal (a later-seq ok
    // entry behind a failed slot is a FAILURE GAP, not an edit point) — only
    // B re-runs and the journal is NOT truncated.
    const second = keyedModel({ "task B": say("has MARKER") });
    const events: string[] = [];
    const r2 = await runScriptWorkflow(script, {
      ...opts(second.client, { workflowName: "gap" }),
      journal: openJournal(path),
      resumeTasks: loadJournal(path).tasks,
      onEvent: (e) => {
        if (e.type === "journal-truncated") events.push(`truncated@${e.atSeq}`);
      },
    });
    expect(second.calls).toBe(1); // only the failed task re-ran
    expect(r2.tasksReplayed).toBe(2); // seq0 AND seq2 replayed
    expect(events).toEqual([]); // downstream cache untouched
    expect(r2.returnValue).toEqual(["A-OUT", true, "C-OUT"]);
    // The journal now holds ok entries for all three seqs; C's is the ORIGINAL.
    const after = loadJournal(path).tasks;
    expect(after.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(after[2]?.text).toBe("C-OUT");
  });

  it("label changes never fork a replay (label is not part of the key)", async () => {
    const runId = `wf-label-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    const first = scriptedModel([say("X")]);
    await runScriptWorkflow("return (await task('p', { label: 'before' })).text;", {
      ...opts(first.client, { workflowName: "labels" }), journal: openJournal(path),
    });
    const second = scriptedModel([]);
    const r2 = await runScriptWorkflow("return (await task('p', { label: 'renamed' })).text;", {
      ...opts(second.client, { workflowName: "labels" }), journal: openJournal(path), resumeTasks: loadJournal(path).tasks,
    });
    expect(second.calls).toBe(0);
    expect(r2.returnValue).toBe("X");
  });

  it("mid-script edit: matched prefix replays, everything from the edit point truncates and re-runs", async () => {
    const runId = `wf-edit-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    const first = scriptedModel([say("A"), say("B"), say("C")]);
    await runScriptWorkflow(
      "await task('one');\nawait task('two');\nawait task('three');\nreturn 1;",
      { ...opts(first.client, { workflowName: "edit" }), journal: openJournal(path) },
    );
    expect(loadJournal(path).tasks).toHaveLength(3);

    // Edit: the SECOND task's prompt changes. Tasks 2-3 must re-run.
    const second = scriptedModel([say("B2"), say("C2")]);
    const events: string[] = [];
    const r2 = await runScriptWorkflow(
      "await task('one');\nawait task('two EDITED');\nawait task('three');\nreturn 2;",
      {
        ...opts(second.client, { workflowName: "edit" }),
        journal: openJournal(path),
        resumeTasks: loadJournal(path).tasks,
        onEvent: (e) => {
          if (e.type === "journal-truncated") events.push(`truncated@${e.atSeq}`);
          if (e.type === "task-finished") events.push(`${e.label}:${e.replayed ? "replayed" : e.ok ? "ok" : "fail"}`);
        },
      },
    );
    // M11 #3（导入缓存）：编辑点的任务重跑（键变了），但编辑点之后**键
    // 没变的任务**（task('three') 的 prompt 未被编辑）从导入池复用——
    // 修前两个都重跑，修后只重跑编辑点那一个。
    expect(second.calls).toBe(1);
    expect(r2.tasksReplayed).toBe(2); // 前缀 one + 导入 three
    expect(events).toContain("truncated@1");
    expect(events).toContain("task-1:replayed");
    // The journal now holds [one(replayed), two'(new), three(imported)] —
    // task three's prompt didn't change, so its old result "C" is imported
    // (M11 #3's value: post-edit tasks with unchanged keys skip re-execution).
    const after = loadJournal(path).tasks;
    expect(after).toHaveLength(3);
    expect(after.map((t) => t.seq)).toEqual([0, 1, 2]);
    expect(after[1]?.text).toBe("B2");
    expect(after[2]?.text).toBe("C"); // imported from the old run (not "C2")
  });

  it("a cached structured output that no longer matches the current schema is a divergence (re-run)", async () => {
    const runId = `wf-stale-${Math.random().toString(16).slice(2, 8)}`;
    const path = journalFilePath(root, runId);
    const schemaA = { type: "object" as const, required: ["n"], properties: { n: { type: "number" as const } } };
    const first = scriptedModel([say('```json\n{"n": 1}\n```')]);
    await runScriptWorkflow(
      "return (await task('p', { responseSchema: args.schema, retry: 0 })).data;",
      { ...opts(first.client, { workflowName: "stale" }), journal: openJournal(path), args: { schema: schemaA } },
    );
    // TIGHTEN the schema and resume: the cached {n:1} no longer validates.
    const schemaB = { type: "object" as const, required: ["n", "s"], properties: { n: { type: "number" as const }, s: { type: "string" as const } } };
    const second = scriptedModel([say('```json\n{"n": 1, "s": "x"}\n```')]);
    const r2 = await runScriptWorkflow(
      "return (await task('p', { responseSchema: args.schema, retry: 0 })).data;",
      {
        ...opts(second.client, { workflowName: "stale" }), journal: openJournal(path),
        resumeTasks: loadJournal(path).tasks, args: { schema: schemaB },
      },
    );
    expect(second.calls).toBe(1); // cache invalidated, re-ran
    expect(r2.returnValue).toEqual({ n: 1, s: "x" });
  });
});

// ---------------------------------------------------------------------------
// parallel / sub-workflows / plan
// ---------------------------------------------------------------------------

describe("composition", () => {
  it("parallel fan-out: results in slot order, a failed task → null + failures", async () => {
    const model = keyedModel({ "a-needle": say("r1"), "b-needle": new Error("die"), "c-needle": say("r3") });
    const result = await runScriptWorkflow(
      "const fan = await parallel([\n" +
        "  () => task('a-needle', { retry: 0 }),\n" +
        "  () => task('b-needle', { retry: 0 }),\n" +
        "  () => task('c-needle', { retry: 0 }),\n" +
        "]);\n" +
        "return { texts: fan.results.map(r => r && r.text), failures: fan.failures.map(f => f.category) };",
      opts(model.client, { workflowName: "fanout" }),
    );
    expect(result.returnValue).toEqual({ texts: ["r1", null, "r3"], failures: ["task-threw"] });
    expect(result.tasksTotal).toBe(3);
    expect(result.tasksOk).toBe(2);
  });

  it("sub-workflow: child shares seq/budget/journal; args reach the child; nesting is refused", async () => {
    const runId = `wf-sub-${Math.random().toString(16).slice(2, 8)}`;
    writeFileSync(join(root, "child.js"), "const r = await task('child of ' + args.who, { label: 'child-task' });\nreturn r.text;");
    writeFileSync(join(root, "grandchild.js"), "await workflow('child', { who: 'x' });\nreturn 1;");
    const path = journalFilePath(root, runId);
    const model = scriptedModel([say("CHILD-OUT"), say("PARENT-OUT")]);
    const result = await runScriptWorkflow(
      "const child = await workflow('child', { who: 'parent' });\nconst own = await task('parent own');\nreturn [child, own.text];",
      { ...opts(model.client, { workflowName: "sub" }), journal: openJournal(path), scriptPath: join(root, "main.js"), workflowName: "sub" },
    );
    expect(result.returnValue).toEqual(["CHILD-OUT", "PARENT-OUT"]);
    const childUser = model.inputs[0]?.messages.find((m) => m.role === "user") as { content: string } | undefined;
    expect(childUser?.content).toBe("child of parent");
    // The child's task and the parent's own task share one seq space.
    expect(loadJournal(path).tasks.map((t) => t.seq)).toEqual([0, 1]);

    // One level max: a child that calls workflow() fails the run.
    const nested = scriptedModel([]);
    const r2 = await runScriptWorkflow("await workflow('grandchild', {});", {
      ...opts(nested.client, { workflowName: "sub2" }),
      scriptPath: join(root, "main.js"),
    });
    expect(r2.ok).toBe(false);
    expect(r2.failure?.category).toBe("task-threw");
    expect(r2.failure?.message).toMatch(/nest/);
  });

  it("planFromWorkflow + runPlanWorkflow: M22 semantics (sequential, stop at first failed step)", async () => {
    const model = scriptedModel([say("S1"), say("i skipped the tool")]);
    const plan = planFromWorkflow("json-flow", [
      { id: "one", prompt: "p1" },
      { id: "two", prompt: "p2 {{step.one.output}}", expect: { toolUsed: "read_file" } },
      { id: "three", prompt: "never" },
    ]);
    const result = await runPlanWorkflow(plan, opts(model.client, { workflowName: "json-flow" }));
    expect(result.ok).toBe(false);
    expect(result.failure?.category).toBe("verify-failed");
    expect(model.calls).toBe(2); // step three never ran
    expect(result.tasksTotal).toBe(2);
  });

  it("state.json records totals and cost for a completed run", async () => {
    const runId = `wf-state-${Math.random().toString(16).slice(2, 8)}`;
    const model = scriptedModel([say("1"), say("2")]);
    await runScriptWorkflow("await task('a');\nawait task('b');\nreturn 0;", {
      ...opts(model.client, { workflowName: "state" }), journal: openJournal(journalFilePath(root, runId)),
    });
    const state = readWorkflowState(workflowStatePath(root, runId));
    expect(state).toMatchObject({
      schemaVersion: 1, runId, workflow: "state", status: "completed",
      tasksTotal: 2, tasksOk: 2, cost: { promptTokens: 200, completionTokens: 40 },
    });
  });
});

// ---------------------------------------------------------------------------
// M56 §4 — no-evidence success = 0.5 partial, never a pass (workflow side):
// a task with passing scorers is evidence "verified"; a task with NO scorers
// (or only skip/transport/verifier receipts) succeeds as "partial", and the
// run counts tasksPartial.
// ---------------------------------------------------------------------------
describe("task evidence (M56 §4)", () => {
  it("a task without scorers succeeds as PARTIAL (never a full pass)", async () => {
    const model = scriptedModel([say("done")]);
    const result = await runScriptWorkflow(
      "const a = await task('do it');\nreturn a.evidence;",
      opts(model.client, { workflowName: "evid-none" }),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe("partial");
    expect(result.tasksPartial).toBe(1);
    expect(result.tasksOk).toBe(1);
  });

  it("a task with a passing scorer is VERIFIED", async () => {
    const model = scriptedModel([say("verified output")]);
    const result = await runScriptWorkflow(
      "const a = await task('do it', { verify: [{ regexMatch: { pattern: 'verified' } }] });\nreturn a.evidence;",
      opts(model.client, { workflowName: "evid-pass" }),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toBe("verified");
    expect(result.tasksPartial).toBe(0);
  });

  it("transport/verifier receipts do not fail the task — but leave it PARTIAL", async () => {
    const model = scriptedModel([say("fine")]);
    const result = await runScriptWorkflow(
      "const a = await task('do it', { verify: ["
        + "{ regexMatch: { pattern: '([unclosed' } }," // verifier fault
        + "{ exitCode: { command: 'sh -c \"exit 0\"' } }" // a real pass
        + "] });\nreturn [a.ok, a.evidence, a.verify.map(r => r.status).join(',')];",
      opts(model.client, { workflowName: "evid-faults" }),
    );
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual([true, "verified", "verifier,pass"]);
  });

  it("a fail receipt still fails the task (evidence rules never weaken verification)", async () => {
    const model = scriptedModel([say("no match here"), say("retry still no")]);
    const result = await runScriptWorkflow(
      "const a = await task('do it', { verify: [{ regexMatch: { pattern: 'MISSING-NEVER' } }] });\nreturn [a.ok, a.failure.category];",
      opts(model.client, { workflowName: "evid-fail" }),
    );
    // A JS script survives a failed task (it sees the failure in the result);
    // the TASK failed on the fail receipt with the verify-failed category.
    expect(result.returnValue).toEqual([false, "verify-failed"]);
    expect(result.tasksOk).toBe(0);
    expect(result.tasksPartial).toBe(0);
  });
});
