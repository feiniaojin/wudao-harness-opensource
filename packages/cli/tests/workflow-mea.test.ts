// ω-4c (MEA workflow template) — deterministic acceptance tests, design §5.
// No network, no real model: the keyedModel dispatcher answers by prompt
// needle, gates run through exitCode specs with an injected spawnShell whose
// Nth call scripts the round's outcome, and time enters via JsflowOptions.now.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ModelClient, ModelInput } from "@wudao-org/core";
import {
  advanceMeaState,
  buildAuditorPrompt,
  buildExecutorPrompt,
  buildManagerPrompt,
  clampTurns,
  initialMeaState,
  parseMeaGoal,
  priorChargedSpend,
  recoverMeaState,
  runMeaWorkflow,
  type MeaGoal,
  type MeaRoundRecord,
  type MeaState,
} from "../src/workflow/mea.js";
import { formatBudgetAdvisory, taskSystemSection, type JsflowEvent, type JsflowOptions } from "../src/workflow/engine.js";
import {
  journalFilePath,
  loadJournal,
  openJournal,
  readWorkflowState,
  workflowStatePath,
  type JournalRecord,
} from "../src/workflow/journal.js";
import { parseWorkflowArgs, workflowMain } from "../src/workflow/cli.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wf-mea-"));
  writeFileSync(join(root, "fixture.txt"), "scorer fixture\n");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Harness (the workflow-engine.test.ts shapes: keyedModel dispatch + injected
// spawnShell for exitCode gates + journal-backed run options)
// ---------------------------------------------------------------------------

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
        throw new Error(`keyedModel: no scripted response for prompt "${content.slice(0, 80)}"`);
      },
    },
  };
}

/** Positional scripted model (sequential flows where two calls share a needle:
 *  the executor's tool-call turn and its final answer). */
function seqModel(
  script: readonly (AssistantMessage | Error)[],
  usage: { promptTokens: number; completionTokens: number } = { promptTokens: 100, completionTokens: 20 },
): { client: ModelClient; inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    client: {
      async generate(input: ModelInput): Promise<AssistantMessage> {
        inputs.push(input);
        const next = script[i];
        i += 1;
        if (next === undefined) throw new Error("seqModel: scripted responses exhausted");
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

const fenced = (obj: Record<string, unknown>): AssistantMessage => ({
  role: "assistant",
  content: "Here is the decision:\n```json\n" + JSON.stringify(obj) + "\n```",
});
const say = (content: string): AssistantMessage => ({ role: "assistant", content });
const subtaskAnswer = (title: string, instructions: string, turnBudget?: number): AssistantMessage =>
  fenced({ action: "subtask", title, instructions, ...(turnBudget !== undefined ? { turnBudget } : {}), rationale: "next bounded step" });
const doneAnswer = (rationale: string): AssistantMessage => fenced({ action: "done", rationale });
const auditorAnswer = (diagnosis: string, recoveryHint?: string): AssistantMessage =>
  fenced({ diagnosis, ...(recoveryHint !== undefined ? { recoveryHint } : {}) });

/** Injected spawnShell: the Nth call returns scripts[N] (default exit 0). */
function scriptedShell(scripts: readonly { code: number; timedOut?: boolean }[]): {
  calls: string[];
  fn: (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }>;
} {
  const calls: string[] = [];
  let i = 0;
  return {
    calls,
    fn: async (_command: string, _cwd: string, _timeoutMs: number) => {
      calls.push(_command);
      const s = scripts[i];
      i += 1;
      if (s === undefined) return { code: 0, timedOut: false };
      if (s.timedOut) return { code: null, timedOut: true };
      return { code: s.code, timedOut: false };
    },
  };
}

function meaGoalJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "test-mea",
    goal: "Make the fixture green.",
    gates: [
      { id: "gate-a", exitCode: { command: "check a" } },
      { id: "gate-b", exitCode: { command: "check b" } },
    ],
    ...over,
  });
}

function parseGoalOrThrow(text: string): MeaGoal {
  const parsed = parseMeaGoal(text);
  if (!parsed.valid) throw new Error(`bad test goal: ${parsed.errors.join("; ")}`);
  return parsed.goal;
}

interface MeaOpts {
  readonly runId: string;
  readonly model: ModelClient;
  readonly shell?: { fn: (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }> };
  readonly taskModels?: ReadonlyMap<string, ModelClient>;
  readonly resumeState?: MeaState;
  readonly budgetTokens?: number;
  readonly canUseTool?: JsflowOptions["canUseTool"];
  readonly maxRounds?: number;
}

function meaOpts(o: MeaOpts): JsflowOptions & Parameters<typeof runMeaWorkflow>[1] {
  return {
    workspaceRoot: root,
    model: o.model,
    journal: openJournal(journalFilePath(root, o.runId)),
    workflowName: "test-mea",
    ...(o.shell !== undefined ? { gateSpawnShell: o.shell.fn } : {}),
    ...(o.taskModels !== undefined ? { taskModels: o.taskModels } : {}),
    ...(o.resumeState !== undefined ? { resumeState: o.resumeState } : {}),
    ...(o.budgetTokens !== undefined ? { budgetTokens: o.budgetTokens } : {}),
    ...(o.canUseTool !== undefined ? { canUseTool: o.canUseTool } : {}),
  };
}

const journalLines = (runId: string): number =>
  readFileSync(journalFilePath(root, runId), "utf8").split("\n").filter((l) => l.trim().length > 0).length;

const meaRoundLogs = (runId: string): { round: number; state: MeaState }[] =>
  loadJournal(journalFilePath(root, runId)).records
    .filter((r): r is Extract<JournalRecord, { type: "log" }> => r.type === "log")
    .map((r) => JSON.parse(r.message) as { meaRound?: { round: number; state: MeaState } })
    .filter((m) => m.meaRound !== undefined)
    .map((m) => ({ round: m.meaRound!.round, state: m.meaRound!.state }));

const userPromptOf = (input: ModelInput): string => {
  const lastUser = [...input.messages].reverse().find((m) => m.role === "user");
  return (lastUser as { content: string } | undefined)?.content ?? "";
};

// ---------------------------------------------------------------------------
// 1. parseMeaGoal (the parseWorkflow discipline: exhaustive, one pass)
// ---------------------------------------------------------------------------

describe("parseMeaGoal", () => {
  it("parses a minimal valid goal and applies the documented defaults", () => {
    const parsed = parseMeaGoal(JSON.stringify({ goal: "g", gates: [{ id: "a", exitCode: { command: "true" } }] }));
    expect(parsed.valid).toBe(true);
    if (parsed.valid) {
      expect(parsed.goal.goal).toBe("g");
      expect(parsed.goal.maxRounds).toBe(5);
      expect(parsed.goal.maxSubtaskTurns).toBe(12);
      expect(parsed.goal.gates).toHaveLength(1);
      expect(parsed.goal.gates[0]?.spec).toEqual({ exitCode: { command: "true" } });
    }
  });

  it("lists every validation error in one pass (kitchen-sink bad document)", () => {
    const bad = {
      name: 5,
      goal: "",
      maxRounds: 99,
      maxSubtaskTurns: 0,
      executorTools: [1, "ok"],
      unknownKey: true,
      gates: [
        { id: "BAD ID", exitCode: { command: "x" } },
        { id: "dup" },
        { id: "dup", fileExists: { path: "f" } },
        { id: "ok-gate", bogus: {} },
      ],
    };
    const parsed = parseMeaGoal(JSON.stringify(bad));
    expect(parsed.valid).toBe(false);
    if (!parsed.valid) {
      const joined = parsed.errors.join("\n");
      expect(joined).toContain("goal");
      expect(joined).toContain("name must be a non-empty string");
      expect(joined).toContain("maxRounds");
      expect(joined).toContain("maxSubtaskTurns");
      expect(joined).toContain("executorTools");
      expect(joined).toContain('unknown key "unknownKey"');
      expect(joined).toContain("BAD ID");
      expect(joined).toContain("duplicate gate id");
      expect(joined).toContain("exactly one");
      expect(joined).toContain('unknown key "bogus"');
      expect(parsed.errors.length).toBeGreaterThanOrEqual(10);
    }
  });

  it("rejects: empty gates, unknown VerifySpec kind, invalid JSON, non-string executorTools", () => {
    expect(parseMeaGoal(JSON.stringify({ goal: "g", gates: [] })).valid).toBe(false);
    const weird = parseMeaGoal(JSON.stringify({ goal: "g", gates: [{ id: "x", weirdKind: {} }] }));
    expect(weird.valid).toBe(false);
    if (!weird.valid) expect(weird.errors.join("")).toContain("exactly one");
    expect(parseMeaGoal("{not json").valid).toBe(false);
    const tools = parseMeaGoal(JSON.stringify({ goal: "g", gates: [{ id: "x", exitCode: { command: "c" } }], auditorTools: "read_file" }));
    expect(tools.valid).toBe(false);
    if (!tools.valid) expect(tools.errors.join("")).toContain("auditorTools");
  });
});

// ---------------------------------------------------------------------------
// 2. formatBudgetAdvisory (pure; the three BAVT phase words)
// ---------------------------------------------------------------------------

describe("formatBudgetAdvisory", () => {
  const b = (total: number, spent: number) => ({ total, spent, remaining: Math.max(0, total - spent) });

  it("broad early, focus late: the three phase words at the right remaining fractions", () => {
    expect(formatBudgetAdvisory(b(500_000, 120_000))).toContain("ample: broad exploration is affordable");
    expect(formatBudgetAdvisory(b(500_000, 300_000))).toContain("moderate: begin narrowing to the promising directions");
    expect(formatBudgetAdvisory(b(500_000, 460_000))).toContain("tight: focus on the most promising direction; stop exploring broadly");
  });

  it("boundaries exact: 0.60 remaining → moderate, 0.25 remaining → tight", () => {
    expect(formatBudgetAdvisory({ total: 500, spent: 200, remaining: 300 })).toContain("moderate:");
    expect(formatBudgetAdvisory({ total: 400, spent: 300, remaining: 100 })).toContain("tight:");
  });

  it("turn-budget line present iff maxTurns set; pure (same inputs → same string)", () => {
    const without = formatBudgetAdvisory(b(1000, 200));
    expect(without).not.toContain("Turn budget");
    const with8 = formatBudgetAdvisory(b(1000, 200), 8);
    expect(with8).toContain("Turn budget for this task: 8.");
    expect(formatBudgetAdvisory(b(1000, 200), 8)).toBe(with8);
    expect(formatBudgetAdvisory(b(1000, 200))).toBe(without);
    expect(formatBudgetAdvisory(b(1000, 200))).toContain("200/1.0k tokens spent");
    expect(formatBudgetAdvisory(b(1000, 200))).toContain("80% remaining");
  });
});

// ---------------------------------------------------------------------------
// 3. taskSystemSection (the M22-equivalence guard)
// ---------------------------------------------------------------------------

describe("taskSystemSection advisory parameter", () => {
  const TODAY = `\n\n# Workflow step\nYou are executing step "s1" of deterministic workflow "wf". Complete exactly this step's task, then finish with a short final answer.\nTools allowed in this step: read_file, grep.`;

  it("undefined advisory → byte-identical to today's section (frozen snapshot)", () => {
    expect(taskSystemSection("s1", "wf", ["read_file", "grep"], undefined, undefined)).toBe(TODAY);
    expect(taskSystemSection("s1", "wf", ["read_file", "grep"], undefined)).toBe(TODAY);
  });

  it("advisory renders as the trailing line; byte-identical across equal calls", () => {
    const withSchema = taskSystemSection("s1", "wf", ["read_file"], { type: "object", required: ["a"] }, undefined);
    expect(withSchema.startsWith(TODAY.replace(", grep", ""))).toBe(true);
    expect(withSchema).toContain("CRITICAL: your final answer must be ONLY a fenced");
    const a = taskSystemSection("s1", "wf", ["read_file", "grep"], undefined, "ADVISORY-LINE");
    expect(a).toBe(TODAY + "\nADVISORY-LINE");
    expect(taskSystemSection("s1", "wf", ["read_file", "grep"], undefined, "ADVISORY-LINE")).toBe(a);
  });
});

// ---------------------------------------------------------------------------
// 4. advanceMeaState (the pure transition)
// ---------------------------------------------------------------------------

describe("advanceMeaState", () => {
  const s0 = initialMeaState("Make the fixture green.");
  const gate = (id: string, status: "pass" | "fail", detail?: string) => ({ id, status, ...(detail !== undefined ? { detail } : {}) });
  const record = (over: Partial<MeaRoundRecord> & { round: number }): MeaRoundRecord => ({
    subtask: "t",
    gateResults: [],
    executorOutcome: "ok",
    ...over,
  });

  it("initial state shape", () => {
    expect(s0).toEqual({
      schemaVersion: 1, goal: "Make the fixture green.", round: 0, gateMatrix: [],
      failures: [], managerMisfires: 0, done: false,
    });
  });

  it("(a) a newly-passing gate enters gateMatrix as pass; (b) a previously-passing gate that now fails is demoted and the regression is recorded as failure evidence", () => {
    const r1 = advanceMeaState(s0, record({ round: 1, gateResults: [gate("gate-a", "pass", "exit 0"), gate("gate-b", "fail", "exit 1, expected 0")] }));
    expect(r1.round).toBe(1);
    expect(r1.gateMatrix.map((g) => `${g.id}:${g.status}`)).toEqual(["gate-a:pass", "gate-b:fail"]);
    expect(r1.failures).toHaveLength(1);
    const r2 = advanceMeaState(r1, record({ round: 2, gateResults: [gate("gate-a", "fail", "exit 1, expected 0"), gate("gate-b", "pass", "exit 0")] }));
    expect(r2.gateMatrix.map((g) => `${g.id}:${g.status}`)).toEqual(["gate-a:fail", "gate-b:pass"]); // demoted
    expect(r2.failures).toHaveLength(2);
    expect(r2.failures[1]?.failingGates.map((g) => g.id)).toContain("gate-a"); // regression recorded
  });

  it("(c) executor-ok-with-failing-gates records evidence WITHOUT touching verification (matrix = gate results only)", () => {
    const r = advanceMeaState(s0, record({ round: 1, executorOutcome: "ok", gateResults: [gate("gate-a", "fail", "exit 1")] }));
    expect(r.failures[0]?.executorOutcome).toBe("ok");
    expect(r.gateMatrix).toEqual([gate("gate-a", "fail", "exit 1")]);
    expect(r.done).toBe(false);
  });

  it("(d) pure: same inputs → deep-equal outputs; inputs never mutated", () => {
    const rec = record({ round: 1, gateResults: [gate("gate-a", "fail")], diagnosis: "d", recoveryHint: "h" });
    const a = advanceMeaState(s0, rec);
    const b = advanceMeaState(structuredClone(s0), structuredClone(rec));
    expect(a).toEqual(b);
    expect(s0).toEqual(initialMeaState("Make the fixture green."));
    expect(Object.isFrozen(a.gateMatrix)).toBe(true);
  });

  it("(e) failure list trims to the newest 20 deterministically; entries capped at 4000 chars", () => {
    let s = s0;
    for (let i = 1; i <= 25; i += 1) {
      s = advanceMeaState(s, record({ round: i, gateResults: [gate("gate-a", "fail")], diagnosis: "x".repeat(9000) }));
    }
    expect(s.failures).toHaveLength(20);
    expect(s.failures[0]?.round).toBe(6); // oldest dropped
    for (const f of s.failures) {
      expect(JSON.stringify(f).length).toBeLessThanOrEqual(4000);
    }
  });

  it("managerDeclaredDone sets done; misfire count carries through the record", () => {
    const r = advanceMeaState(s0, record({ round: 1, gateResults: [gate("gate-a", "pass")], managerDeclaredDone: true, managerMisfires: 1 }));
    expect(r.done).toBe(true);
    expect(r.managerMisfires).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. clampTurns
// ---------------------------------------------------------------------------

describe("clampTurns", () => {
  it("999 → cap; 0/-3/junk → 1 + note; in-range passes through", () => {
    expect(clampTurns(999, 12)).toEqual({ turns: 12, note: expect.stringContaining("12") });
    expect(clampTurns(0, 12).turns).toBe(1);
    expect(clampTurns(0, 12).note).toBeDefined();
    expect(clampTurns(-3, 12).turns).toBe(1);
    expect(clampTurns(-3, 12).note).toBeDefined();
    expect(clampTurns("many", 12).turns).toBe(1);
    expect(clampTurns(undefined, 12).turns).toBe(1);
    expect(clampTurns(5, 12)).toEqual({ turns: 5 });
  });
});

// ---------------------------------------------------------------------------
// 6. Prompt builders (needles + content + byte stability)
// ---------------------------------------------------------------------------

describe("MEA prompt builders", () => {
  const goal = parseGoalOrThrow(meaGoalJson());
  const state = advanceMeaState(
    initialMeaState(goal.goal),
    {
      round: 1, subtask: "Fix the parser", gateResults: [
        { id: "gate-a", status: "pass", detail: "exit 0" },
        { id: "gate-b", status: "fail", detail: "exit 1, expected 0" },
      ],
      executorOutcome: "ok", diagnosis: "the config is stale", recoveryHint: "delete the stale entry",
    },
  );
  const budget = { total: 500_000, spent: 120_000, remaining: 380_000 };

  it("manager prompt: goal, gate matrix, failure evidence, budget + phase word, turn cap; needle leads; byte-stable", () => {
    const p = buildManagerPrompt(state, goal, budget);
    expect(p.startsWith("[MEA manager]")).toBe(true);
    expect(p).toContain("Make the fixture green.");
    expect(p).toContain("- gate-b: FAIL (exit 1, expected 0)");
    expect(p).toContain("[round 1]");
    expect(p).toContain("the config is stale");
    expect(p).toContain("Budget: 120.0k/500.0k tokens spent · 76% remaining — ample: broad exploration is affordable");
    expect(p).toContain("Per-subtask turn budget cap: 12 turns");
    expect(buildManagerPrompt(state, goal, budget)).toBe(p);
    // fresh state renders the no-evaluation-yet arms
    const fresh = buildManagerPrompt(initialMeaState(goal.goal), goal, budget);
    expect(fresh).toContain("no evaluation yet");
  });

  it("executor prompt: needle leads; bounded subtask + goal; turn budget; byte-stable", () => {
    const p = buildExecutorPrompt(goal, { title: "Fix the parser", instructions: "Edit src/parser.ts to accept empty input." }, 1, 5);
    expect(p.startsWith("[MEA executor]")).toBe(true);
    expect(p).toContain("Fix the parser");
    expect(p).toContain("Edit src/parser.ts to accept empty input.");
    expect(p).toContain("Make the fixture green.");
    expect(p).toContain("Turn budget: 5 turns");
    expect(buildExecutorPrompt(goal, { title: "Fix the parser", instructions: "Edit src/parser.ts to accept empty input." }, 1, 5)).toBe(p);
  });

  it("auditor prompt: needle leads; receipts + executor report; advisory-only framing; byte-stable", () => {
    const p = buildAuditorPrompt(goal, "Fix the parser", "ok", "I edited the parser.", [
      { id: "gate-b", status: "fail", detail: "exit 1, expected 0" },
    ], 1);
    expect(p.startsWith("[MEA auditor]")).toBe(true);
    expect(p).toContain("[MEA auditor] round 1");
    expect(p).toContain("gate-b: FAIL");
    expect(p).toContain("I edited the parser.");
    expect(p).toContain("flaky or real");
    expect(buildAuditorPrompt(goal, "Fix the parser", "ok", "I edited the parser.", [{ id: "gate-b", status: "fail", detail: "exit 1, expected 0" }], 1)).toBe(p);
  });
});

// ---------------------------------------------------------------------------
// 7. Happy path: two rounds, no auditor calls
// ---------------------------------------------------------------------------

describe("MEA engine integration", () => {
  it("7. happy path over two rounds: digest, auditor only on the failing round, journal logs, mea-round events", async () => {
    const runId = "wf-mea-happy";
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
      "[MEA auditor] round 1": auditorAnswer("gate-b still fails"),
      "[MEA manager] round 2/5": subtaskAnswer("Add regression test", "Add a test for empty input.", 4),
      "[MEA executor] round 2": say("added the test"),
    });
    const shell = scriptedShell([{ code: 0 }, { code: 1 }, { code: 0 }, { code: 0 }]);
    const events: JsflowEvent[] = [];
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), {
      ...meaOpts({ runId, model: model.client, shell }),
      onEvent: (e) => events.push(e),
    });
    expect(result.ok).toBe(true);
    expect(result.returnValue).toEqual({
      gates: "2/2", rounds: 2,
      cost: { promptTokens: 500, completionTokens: 100 },
      verified: ["gate-a", "gate-b"],
    });
    // 2× manager + 2× executor + 1 auditor (round 1's failing gate; round 2
    // passes — success needs no narrative, so exactly one auditor task).
    expect(result.tasksTotal).toBe(5);
    expect(result.tasksOk).toBe(5);
    expect(model.inputs.filter((i) => userPromptOf(i).includes("[MEA auditor] round 1"))).toHaveLength(1);
    expect(model.inputs.some((i) => userPromptOf(i).includes("[MEA auditor] round 2"))).toBe(false);
    expect(shell.calls).toEqual(["check a", "check b", "check a", "check b"]);
    const rounds = meaRoundLogs(runId);
    expect(rounds.map((r) => r.round)).toEqual([1, 2]);
    expect(rounds[1]?.state.gateMatrix.every((g) => g.status === "pass")).toBe(true);
    const roundEvents = events.filter((e): e is Extract<JsflowEvent, { type: "mea-round" }> => e.type === "mea-round");
    expect(roundEvents.map((e) => [e.round, e.gatesPassing, e.gatesTotal, e.subtask])).toEqual([
      [1, 1, 2, "Fix the parser"],
      [2, 2, 2, "Add regression test"],
    ]);
    expect(loadJournal(journalFilePath(root, runId)).records[0]).toMatchObject({ type: "run-started", engine: "mea" });
    // round-2 manager saw the round-1 failing gate + evidence
    const manager2 = model.inputs.find((i) => userPromptOf(i).includes("[MEA manager] round 2/5"));
    expect(manager2).toBeDefined();
    expect(userPromptOf(manager2!)).toContain("gate-b: FAIL");
    expect(userPromptOf(manager2!)).toContain("[round 1]");
  });

  it("8. the invariant: the model cannot approve its own done (round-2 declaration with gates still failing)", async () => {
    const runId = "wf-mea-done-invariant";
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
      "[MEA auditor] round 1": auditorAnswer("the config is stale"),
      "[MEA manager] round 2/5": doneAnswer("everything is fixed"),
    });
    const shell = scriptedShell([{ code: 1 }, { code: 0 }]); // gate-a fails in round 1
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId, model: model.client, shell }));
    expect(result.ok).toBe(false);
    expect(result.returnValue).toBeUndefined();
    expect(result.failure?.category).toBe("verify-failed");
    expect(result.failure?.message).toContain("manager declared done");
    expect(result.failure?.message).toContain("gate-a");
    expect(shell.calls).toHaveLength(2); // receipts reused — no extra gate run
    expect(readWorkflowState(workflowStatePath(root, runId))?.status).toBe("failed");
  });

  it("8b. done declared at round 1 (no evaluation yet) evaluates the gates once and fails honestly", async () => {
    const model = keyedModel({ "[MEA manager] round 1/5": doneAnswer("all done") });
    const shell = scriptedShell([{ code: 1 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId: "wf-mea-done-r1", model: model.client, shell }));
    expect(result.ok).toBe(false);
    expect(result.failure?.category).toBe("verify-failed");
    expect(result.failure?.message).toContain("gate-a");
    expect(shell.calls).toHaveLength(2);
  });

  it("9. executor failure ≠ run failure: evidence recorded, loop continues, run still terminates ok (gate-b is a shell-free fileExists gate on the temp fixture)", async () => {
    const runId = "wf-mea-execfail";
    // ω-4c M5: file existence is verified by the fileExists scorer (Node fs,
    // scorers.ts existsSync) against the temp fixture — the design §5 harness
    // line "fileExists gates against temp fixtures". Only gate-a rides the
    // injected shell; round 2's executor really writes the file with the
    // write_file tool, so the pass is a genuine fs observation.
    const goal = parseGoalOrThrow(meaGoalJson({
      gates: [
        { id: "gate-a", exitCode: { command: "check a" } },
        { id: "gate-b", fileExists: { path: "made.txt" } },
      ],
      executorTools: ["write_file"],
    }));
    const model = seqModel([
      subtaskAnswer("Create the artifact", "Write made.txt with write_file.", 6), // r1 manager
      new Error("provider blew up"),                                             // r1 executor
      auditorAnswer("nothing changed on disk"),                                  // r1 auditor
      subtaskAnswer("Retry the write", "Write made.txt with write_file again.", 6), // r2 manager
      { role: "assistant", content: "writing now", toolCalls: [{ id: "tc9", name: "write_file", arguments: { path: "made.txt", content: "made\n" } }] }, // r2 executor turn 1
      say("wrote made.txt"),                                                     // r2 executor final answer
    ]);
    const shell = scriptedShell([{ code: 1 }, { code: 0 }]); // gate-a only: r1 fail, r2 pass
    const result = await runMeaWorkflow(goal, meaOpts({ runId, model: model.client, shell }));
    expect(result.ok).toBe(true);
    expect(result.returnValue).toMatchObject({ gates: "2/2", rounds: 2 });
    // The existence gate never touched the shell: exactly the two gate-a runs.
    expect(shell.calls).toEqual(["check a", "check a"]);
    // And it observed the real filesystem both ways: absent in round 1…
    const rounds = meaRoundLogs(runId);
    expect(rounds[0]?.state.gateMatrix.map((g) => [g.id, g.status, g.detail])).toEqual([
      ["gate-a", "fail", "exit 1, expected 0"],
      ["gate-b", "fail", "made.txt"],
    ]);
    expect(rounds[0]?.state.failures[0]?.executorOutcome).toBe("failed");
    const manager2 = model.inputs.find((i) => userPromptOf(i).includes("[MEA manager] round 2/5"));
    expect(userPromptOf(manager2!)).toContain("executor failed");
    // …present after the round-2 executor's write (the fs check that passed).
    expect(existsSync(join(root, "made.txt"))).toBe(true);
  });

  it("9b. the max_turns variant: an executor that never finishes caps out at its turn budget — task-threw with the max_turns terminal, still not a run failure", async () => {
    const runId = "wf-mea-maxturns";
    // The executor ignores the loop's final-turn nudge and tool-calls on every
    // turn — deterministic cap-out (turnBudget 2 → exactly 2 model turns).
    const defiantToolCall: AssistantMessage = {
      role: "assistant", content: "checking the fixture first",
      toolCalls: [{ id: "tc-mt", name: "read_file", arguments: { path: "fixture.txt" } }],
    };
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 2), // turnBudget 2
      "[MEA executor] round 1": defiantToolCall,
      "[system note: turn limit reached": defiantToolCall, // the nudge turn — still a tool call
      "[MEA auditor] round 1": auditorAnswer("the executor ran out of turns before touching the parser"),
      "[MEA manager] round 2/5": subtaskAnswer("Retry with ample turns", "Edit src/parser.ts again.", 6),
      "[MEA executor] round 2": say("applied the edit this time"),
    });
    const shell = scriptedShell([{ code: 1 }, { code: 0 }, { code: 0 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId, model: model.client, shell }));
    expect(result.ok).toBe(true);
    expect(result.returnValue).toMatchObject({ gates: "2/2", rounds: 2 });
    // The cap was actually enforced: exactly 2 generates inside the executor task.
    expect(
      model.inputs.filter((i) => i.messages.some((m) => m.role === "user" && m.content.includes("[MEA executor] round 1"))),
    ).toHaveLength(2);
    // The failure is the max_turns TERMINAL surfaced through classifyAttempt.
    const failed = loadJournal(journalFilePath(root, runId)).records.find(
      (r): r is Extract<JournalRecord, { type: "task-failed" }> =>
        r.type === "task-failed" && (r.label ?? "") === "round-1-executor",
    );
    expect(failed).toBeDefined();
    expect(failed?.category).toBe("task-threw");
    expect(failed?.message).toContain('terminal "max_turns"');
    // Recovery, not failure: evidence recorded, next manager told, run ok.
    const rounds = meaRoundLogs(runId);
    expect(rounds[0]?.state.failures[0]?.executorOutcome).toBe("failed");
    const manager2 = model.inputs.find((i) => userPromptOf(i).includes("[MEA manager] round 2/5"));
    expect(userPromptOf(manager2!)).toContain("executor failed");
  });

  it("9c. gate statuses pass through from the scorer verbatim: jsonPath with no structured output lands as SKIP (the only skip source)", async () => {
    const runId = "wf-mea-skip";
    // Shell-free gate set: a jsonPath gate over an executor with no
    // responseSchema → "no structured output to inspect" → status "skip"
    // straight from evaluateVerifySpecs (scorers.ts), never a remapping.
    const goal = parseGoalOrThrow(meaGoalJson({ gates: [{ id: "jp", jsonPath: { path: "fixed.files" } }], maxRounds: 1 }));
    const model = keyedModel({
      "[MEA manager] round 1/1": subtaskAnswer("Report files", "List the changed files as json.", 6),
      "[MEA executor] round 1": say("just prose, no fenced json at all"),
      "[MEA auditor] round 1": auditorAnswer("the executor produced no structured output to inspect"),
    });
    const result = await runMeaWorkflow(goal, meaOpts({ runId, model: model.client }));
    expect(result.ok).toBe(false); // skip is not pass → maxRounds exhausted
    const rounds = meaRoundLogs(runId);
    expect(rounds[0]?.state.gateMatrix).toEqual([{ id: "jp", status: "skip", detail: "no structured output to inspect" }]);
    expect(result.failure?.message).toContain("jp (skip: no structured output to inspect)");
  });

  it("10. auditor routing: the auditor task hits taskModels.get('mea-auditor'); its diagnosis is evidence, never verification", async () => {
    const runId = "wf-mea-auditor";
    const auditorModel = keyedModel({ "[MEA auditor]": auditorAnswer("the config is stale", "delete the stale entry") });
    const mainModel = keyedModel({
      "[MEA manager] round 1/1": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
    });
    const shell = scriptedShell([{ code: 1 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson({ maxRounds: 1 })), {
      ...meaOpts({ runId, model: mainModel.client, shell, taskModels: new Map([["mea-auditor", auditorModel.client]]) }),
    });
    expect(result.ok).toBe(false); // maxRounds exhausted with gates failing
    expect(result.failure?.category).toBe("verify-failed");
    expect(result.failure?.message).toContain("the config is stale"); // last diagnosis in the failure
    expect(auditorModel.calls).toBe(1);
    expect(userPromptOf(auditorModel.inputs[0]!)).toContain("[MEA auditor] round 1");
    expect(mainModel.inputs.some((i) => userPromptOf(i).includes("[MEA auditor]"))).toBe(false);
    const rounds = meaRoundLogs(runId);
    expect(rounds[0]?.state.failures[0]?.diagnosis).toBe("the config is stale");
    expect(rounds[0]?.state.failures[0]?.recoveryHint).toBe("delete the stale entry");
    expect(rounds[0]?.state.gateMatrix.map((g) => g.status)).toEqual(["fail", "pass"]); // diagnosis never mutates verification
  });

  it("11a. budget: exhaustion at the next task admission is a fatal run failure through MEA", async () => {
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
      // NO auditor response: the auditor task must never reach the model —
      // its admission hits assertCanSpend first (240 ≥ 130).
    });
    const shell = scriptedShell([{ code: 1 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId: "wf-mea-budget", model: model.client, shell, budgetTokens: 130 }));
    expect(result.ok).toBe(false);
    expect(result.failure?.category).toBe("budget-exhausted");
    expect(model.calls).toBe(2);
  });

  it("11b+11c. budget advisory: manager's turnBudget 999 clamps to the cap; the phase word tracks spend", async () => {
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix everything", "Edit everything.", 999),
      "[MEA executor] round 1": say("applied the edit"),
    });
    const shell = scriptedShell([{ code: 0 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId: "wf-mea-clamp", model: model.client, shell }));
    expect(result.ok).toBe(true);
    const execInput = model.inputs.find((i) => userPromptOf(i).includes("[MEA executor] round 1"));
    expect(execInput).toBeDefined();
    expect(userPromptOf(execInput!)).toContain("Turn budget: 12 turns"); // clamped in the prompt
    expect(execInput!.systemPrompt).toContain("Turn budget for this task: 12."); // clamped into maxTurns → advisory
    expect(execInput!.systemPrompt).toContain("Budget: 120/500.0k tokens spent · 100% remaining — ample");
  });

  it("11c-2. tight phase: a large manager spend flips the executor advisory to focus mode", async () => {
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix everything", "Edit everything.", 6),
      "[MEA executor] round 1": say("applied the edit"),
    }, { promptTokens: 400_000, completionTokens: 50_000 });
    const shell = scriptedShell([{ code: 0 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId: "wf-mea-tight", model: model.client, shell }));
    expect(result.ok).toBe(true);
    const execInput = model.inputs.find((i) => userPromptOf(i).includes("[MEA executor] round 1"));
    expect(execInput!.systemPrompt).toContain("10% remaining — tight: focus on the most promising direction");
  });

  it("12. manager misfires: one corrective re-ask recovers; the bound is 2", async () => {
    const runId = "wf-mea-misfire-ok";
    const model = keyedModel({
      // CORRECTION must come first: the re-ask prompt contains BOTH needles.
      "CORRECTION:": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA manager] round 1/5": fenced({ action: "subtask", instructions: "no title" }), // schema-valid, semantically broken
      "[MEA executor] round 1": say("applied the edit"),
    });
    const shell = scriptedShell([{ code: 0 }, { code: 0 }]);
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId, model: model.client, shell }));
    expect(result.ok).toBe(true);
    expect(result.tasksTotal).toBe(3); // manager + corrective re-ask + executor
    expect(meaRoundLogs(runId)[0]?.state.managerMisfires).toBe(1);

    const model2 = keyedModel({
      "CORRECTION:": fenced({ action: "subtask", title: "", instructions: "empty title" }), // second misfire
      "[MEA manager] round 1/5": fenced({ action: "subtask", instructions: "still no title" }),
    });
    const result2 = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId: "wf-mea-misfire-fail", model: model2.client, shell: scriptedShell([]) }));
    expect(result2.ok).toBe(false);
    expect(result2.failure?.category).toBe("verify-failed");
    expect(result2.failure?.message).toContain("manager-contract");
  });

  it("13. resume = state continuation: no task replay, zero truncation, prior spend carried", async () => {
    const runId = "wf-mea-resume";
    const goal = parseGoalOrThrow(meaGoalJson()); // maxRounds 5
    const run1Model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
      "[MEA auditor] round 1": auditorAnswer("the config is stale"),
    });
    const shell1 = scriptedShell([{ code: 1 }, { code: 0 }]);
    // Run 1 dies of budget exhaustion right before round 2's manager task.
    const run1 = await runMeaWorkflow(goal, meaOpts({ runId, model: run1Model.client, shell: shell1, budgetTokens: 360 }));
    expect(run1.ok).toBe(false);
    expect(run1.failure?.category).toBe("budget-exhausted");
    const records1 = loadJournal(journalFilePath(root, runId)).records;
    const lines1 = journalLines(runId);
    expect(priorChargedSpend(records1)).toBe(360); // 3 ok tasks × 120
    const recovered = recoverMeaState(records1);
    expect(recovered?.round).toBe(1);
    expect(recovered?.failures[0]?.failingGates[0]?.id).toBe("gate-a");

    const run2Model = keyedModel({
      "[MEA manager] round 2/5": subtaskAnswer("Delete stale config", "Remove the stale entry.", 4),
      "[MEA executor] round 2": say("removed the entry"),
    });
    const events: JsflowEvent[] = [];
    const run2 = await runMeaWorkflow(goal, {
      ...meaOpts({ runId, model: run2Model.client, shell: scriptedShell([{ code: 0 }, { code: 0 }]), resumeState: recovered, budgetTokens: 500_000 - 360 }),
      onEvent: (e) => events.push(e),
    });
    expect(run2.ok).toBe(true);
    expect(run2.tasksReplayed).toBe(0); // ZERO task replay attempts
    expect(events.some((e) => e.type === "journal-truncated")).toBe(false); // the §3.5 footgun pin
    expect(journalLines(runId)).toBeGreaterThan(lines1); // append-only: strictly grows
    const manager2 = run2Model.inputs.find((i) => userPromptOf(i).includes("[MEA manager] round 2/5"));
    expect(userPromptOf(manager2!)).toContain("gate-a: FAIL");
    expect(userPromptOf(manager2!)).toContain("[round 1]");
    // prior spend carried: 120 of the 499_640-token resumed budget already spent
    const exec2 = run2Model.inputs.find((i) => userPromptOf(i).includes("[MEA executor] round 2"));
    expect(exec2!.systemPrompt).toContain("Budget: 120/499.6k tokens spent");
    expect(run2.returnValue).toMatchObject({ gates: "2/2", rounds: 2 });
  });

  it("14a-0. a force-passed resumeTasks list never arms the engine's replay cursor (the field is structurally absent from MeaRunOptions; JS callers cannot induce replay)", async () => {
    const runId = "wf-mea-no-replay";
    // Seed a mea journal whose single ok task entry CANNOT match this run's
    // first task key — exactly what a misuse of the engine's resumeTasks
    // would look like from the JS side.
    const j = openJournal(journalFilePath(root, runId));
    await j.append({ type: "run-started", runId, workflow: "test-mea", startedAt: "2026-01-01T00:00:00.000Z", engine: "mea" });
    await j.append({
      type: "task-finished", seq: 0, key: "stale-key", prompt: "old prompt", ok: true,
      text: "old text", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, endedAt: "2026-01-01T00:00:00.000Z",
    });
    const stale = loadJournal(journalFilePath(root, runId)).tasks;
    expect(stale).toHaveLength(1);
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
    });
    const events: JsflowEvent[] = [];
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), {
      ...meaOpts({ runId, model: model.client, shell: scriptedShell([{ code: 0 }, { code: 0 }]) }),
      // Force the field through the type: pre-fix it flows into the engine's
      // replay list; post-fix the runtime strip drops it.
      resumeTasks: stale,
      onEvent: (e) => events.push(e),
    } as Parameters<typeof runMeaWorkflow>[1]);
    expect(result.ok).toBe(true);
    expect(result.tasksReplayed).toBe(0);
    expect(result.tasksOk).toBe(2); // manager + executor ran FRESH (no cached hit)
    expect(model.calls).toBe(2);
    expect(events.some((e) => e.type === "journal-truncated")).toBe(false); // the §3.5 footgun pin
  });

  it("14a. workflow run --resume refuses on a MEA journal with the mea pointer", async () => {
    const runId = "wf-mea-guard";
    const model = keyedModel({
      "[MEA manager] round 1/1": subtaskAnswer("Fix the parser", "Edit.", 6),
      "[MEA executor] round 1": say("done"),
      "[MEA auditor] round 1": auditorAnswer("stale"),
    });
    const r = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson({ maxRounds: 1 })), meaOpts({ runId, model: model.client, shell: scriptedShell([{ code: 1 }, { code: 0 }]) }));
    expect(r.ok).toBe(false);
    const jsFile = join(root, "f.js");
    writeFileSync(jsFile, "return 1;\n");
    const lines: string[] = [];
    const code = await workflowMain(["run", "--resume", runId, jsFile], {
      cwd: root, env: { WUDAO_API_KEY: "sk-test", WUDAO_BASE_URL: "https://example.test", WUDAO_MODEL: "test-model" },
      out: (s) => lines.push(s), buildModel: () => { throw new Error("no model may be built"); },
    });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("wudao workflow mea");
  });

  it("14b. resume with priorSpent ≥ total refuses with the budget message", async () => {
    const runId = "wf-mea-guard-budget";
    const model = keyedModel({
      "[MEA manager] round 1/1": subtaskAnswer("Fix", "Edit.", 6),
      "[MEA executor] round 1": say("done"),
      "[MEA auditor] round 1": auditorAnswer("stale"),
    });
    const r = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson({ maxRounds: 1 })), meaOpts({ runId, model: model.client, shell: scriptedShell([{ code: 1 }, { code: 0 }]) }));
    expect(r.ok).toBe(false);
    expect(priorChargedSpend(loadJournal(journalFilePath(root, runId)).records)).toBe(360);
    const goalFile = join(root, "goal.json");
    writeFileSync(goalFile, meaGoalJson());
    const lines: string[] = [];
    const code = await workflowMain(["mea", goalFile, "--resume", runId, "--budget-tokens", "300"], {
      cwd: root, env: { WUDAO_API_KEY: "sk-test" }, out: (s) => lines.push(s),
      buildModel: () => { throw new Error("no model may be built"); },
    });
    expect(code).toBe(1);
    expect(lines.join("")).toContain("increase --budget-tokens");
  });

  it("14c. a journal with run-started engine:'mea' but no meaRound records resumes from round 0 cleanly", async () => {
    expect(recoverMeaState([{ type: "run-started", runId: "x", workflow: "y", startedAt: "2026-01-01T00:00:00.000Z", engine: "mea" }])).toBeUndefined();
    expect(recoverMeaState([{ type: "log", message: JSON.stringify({ meaRound: { round: 3, state: initialMeaState("g") } }) }])?.round ?? 0).toBe(0);
    const runId = "wf-mea-fresh";
    await openJournal(journalFilePath(root, runId)).append({ type: "run-started", runId, workflow: "test-mea", startedAt: "2026-01-01T00:00:00.000Z", engine: "mea" });
    const model = keyedModel({
      "[MEA manager] round 1/5": subtaskAnswer("Fix the parser", "Edit src/parser.ts.", 6),
      "[MEA executor] round 1": say("applied the edit"),
    });
    const result = await runMeaWorkflow(parseGoalOrThrow(meaGoalJson()), meaOpts({ runId, model: model.client, shell: scriptedShell([{ code: 0 }, { code: 0 }]) }));
    expect(result.ok).toBe(true);
    expect(result.returnValue).toMatchObject({ rounds: 1, gates: "2/2" });
  });

  it("14d. mea --resume on a NON-MEA journal refuses by journal kind with the run-path pointer", async () => {
    const goalFile = join(root, "goal.json");
    writeFileSync(goalFile, meaGoalJson());
    for (const [runId, engine] of [["wf-js-journal", "js"], ["wf-legacy-journal", undefined]] as const) {
      await openJournal(journalFilePath(root, runId)).append({
        type: "run-started", runId, workflow: "f.js", startedAt: "2026-01-01T00:00:00.000Z",
        ...(engine !== undefined ? { engine } : {}),
      });
      const lines: string[] = [];
      const code = await workflowMain(["mea", goalFile, "--resume", runId], {
        cwd: root, env: { WUDAO_API_KEY: "sk-test" }, out: (s) => lines.push(s),
        buildModel: () => { throw new Error("no model may be built"); },
      });
      expect(code, runId).toBe(1);
      const joined = lines.join("");
      expect(joined, runId).toContain("not a MEA journal");
      expect(joined, runId).toContain(`wudao workflow run <file> --resume ${runId}`);
    }
  });

  it("15. kill switch: WUDAO_MEA_DISABLE=1 refuses with exit 2 and no model client", async () => {
    const goalFile = join(root, "goal.json");
    writeFileSync(goalFile, meaGoalJson());
    const lines: string[] = [];
    const code = await workflowMain(["mea", goalFile], {
      cwd: root, env: { WUDAO_API_KEY: "sk-test", WUDAO_MEA_DISABLE: "1" }, out: (s) => lines.push(s),
      buildModel: () => { throw new Error("no model may be built"); },
    });
    expect(code).toBe(2);
    expect(lines.join("")).toContain("WUDAO_MEA_DISABLE");
  });

  it("16. CLI parsing: mea usage errors, flags, and the permission gate deny surfaces without a hang", async () => {
    expect(parseWorkflowArgs(["mea"])?.kind).toBe("usage");
    expect(parseWorkflowArgs(["mea", "g.json", "--bogus"])?.kind).toBe("usage");
    expect(parseWorkflowArgs(["mea", "g.json", "--args", "{}"])?.kind).toBe("usage");
    expect(parseWorkflowArgs(["mea", "g.json", "--resume", "r1", "--budget-tokens", "100", "--auto"]))
      .toEqual({ kind: "mea", file: "g.json", resumeId: "r1", budgetTokens: 100 });
    expect(parseWorkflowArgs(["mea", "g.json"])).toEqual({ kind: "mea", file: "g.json" });

    const lines: string[] = [];
    expect(await workflowMain(["mea"], { cwd: root, env: { WUDAO_API_KEY: "sk-test" }, out: (s) => lines.push(s) })).toBe(2);
    expect(lines.join("")).toContain("用法"); // ω99-166e-ii: 钉演进（workflow USAGE 全块中文化）

    // Permission gate: without --auto the shell executor task is denied
    // (workspace auto-allows file edits, but a command is outside the
    // workspace class and a scripted run has no human to prompt); the deny
    // reason lands in the transcript (task failure evidence), no hang.
    const goalFile = join(root, "goal-write.json");
    writeFileSync(goalFile, meaGoalJson({ executorTools: ["read_file", "shell"], maxRounds: 1 }));
    const model = seqModel([
      subtaskAnswer("Write the fixture", "Write fixture.txt.", 6),
      { role: "assistant", content: "writing now", toolCalls: [{ id: "tc1", name: "shell", arguments: { command: "touch out.txt" } }] },
      say("I could not write the file"),
      auditorAnswer("write denied"),
    ]);
    const code = await workflowMain(["mea", goalFile], {
      cwd: root, env: { WUDAO_API_KEY: "sk-test" }, out: () => {},
      buildModel: () => model.client,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(code).toBe(1); // maxRounds 1 with gates failing → run FAILED (terminated, no hang)
    const deniedTurn = model.inputs.find((i) =>
      i.messages.some((m) => m.role === "tool" && m.content.includes("permission denied: workflow runs cannot prompt")));
    expect(deniedTurn).toBeDefined();
    expect(existsSync(join(root, "out.txt"))).toBe(false); // the write never happened
  });

  it("goal-file validation errors are listed exhaustively at the CLI (exit 2)", async () => {
    const goalFile = join(root, "bad-goal.json");
    writeFileSync(goalFile, JSON.stringify({ goal: "", gates: [], maxRounds: 0, nope: 1 }));
    const lines: string[] = [];
    const code = await workflowMain(["mea", goalFile], {
      cwd: root, env: { WUDAO_API_KEY: "sk-test" }, out: (s) => lines.push(s),
      buildModel: () => { throw new Error("no model may be built"); },
    });
    expect(code).toBe(2);
    const joined = lines.join("");
    expect(joined).toContain("goal");
    expect(joined).toContain("gates");
    expect(joined).toContain("maxRounds");
    expect(joined).toContain("nope");
  });
});
