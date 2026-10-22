// ω-4c — the MEA workflow template (Manage–Execute–Audit), book ch10 /
// report 38 §0 row 5. A third program kind over the M29 engine: one round =
// three fresh-context tasks + one deterministic gate pass.
//
//   Manage  — the manager task reads the verified task state (goal, latest
//             gate matrix, failure-evidence log, budget) and proposes the
//             next BOUNDED subtask (or declares done).
//   Execute — the executor task runs that subtask in a fresh context with a
//             manager-proposed, engine-clamped turn budget. Its self-report
//             is never verification.
//   Audit   — AUTHORITY is `evaluateVerifySpecs` over the human-authored goal
//             gates (model-free, replayable — the model roles can read the
//             gates but never write them); ANALYSIS is an advisory auditor
//             task that turns receipts into locatable repair conditions.
//
// The invariant, by construction (book ch10:214): the model may propose "done"
// but cannot approve it — the only path to an ok run is deterministic
// receipts. Executor failures are NOT run failures; they are next-round
// recovery input (ch10:220).
import { truncateSafe } from "@wudao/core"; // 113-A4
import { DEFAULT_STEP_TOOLS } from "./schema.js";
import type { BudgetView, TaskResult } from "./vm.js";
import type { JournalRecord } from "./journal.js";
import { evaluateVerifySpecs, type VerifyContext, type VerifySpec } from "./scorers.js";
import type { JsonSchemaSubset } from "./structured-output.js";
import {
  formatBudgetAdvisory,
  PlanStepFailure,
  runProgramWorkflow,
  type JsflowOptions,
  type JsflowRunResult,
} from "./engine.js";

// ---------------------------------------------------------------------------
// §3.7 Defaults + bounds
// ---------------------------------------------------------------------------

export const MEA_MAX_ROUNDS_DEFAULT = 5;
export const MEA_MAX_ROUNDS_MIN = 1;
export const MEA_MAX_ROUNDS_MAX = 50;
export const MEA_MAX_SUBTASK_TURNS_DEFAULT = 12;
export const MEA_MAX_SUBTASK_TURNS_MIN = 1;
export const MEA_MAX_SUBTASK_TURNS_MAX = 64;
/** Failure-evidence log: newest 20 entries (book ch10:222 — keep the loop finite). */
export const MEA_FAILURE_EVIDENCE_CAP = 20;
/** Deterministic per-entry char cap for failure evidence. */
export const MEA_FAILURE_EVIDENCE_MAX_CHARS = 4000;
/** Schema-valid-but-semantically-broken manager outputs: re-ask once, fail at 2. */
export const MEA_MANAGER_MISFIRE_BOUND = 2;
/** The TaskOptions.model label the CLI routes to the cheap auditor client. */
export const MEA_AUDITOR_MODEL_LABEL = "mea-auditor";
/** Kill switch (the scheduler cronDisabled posture). */
export const MEA_DISABLE_ENV = "WUDAO_MEA_DISABLE";

// ---------------------------------------------------------------------------
// §3.2 The task-state document + the goal file
// ---------------------------------------------------------------------------

export type MeaGateStatusKind = "pass" | "fail" | "skip" | "timeout" | "transport" | "verifier";

export interface MeaGateStatus {
  readonly id: string;
  readonly status: MeaGateStatusKind;
  readonly detail?: string;
}

export interface MeaFailureEvidence {
  readonly round: number;
  readonly subtask: string;
  readonly failingGates: readonly MeaGateStatus[];
  readonly executorOutcome: "ok" | "failed";
  readonly diagnosis?: string;
  readonly recoveryHint?: string;
}

export interface MeaState {
  readonly schemaVersion: 1;
  readonly goal: string;
  /** Completed rounds. */
  readonly round: number;
  /** The LATEST full gate evaluation — verified progress IS its passing region. */
  readonly gateMatrix: readonly MeaGateStatus[];
  readonly failures: readonly MeaFailureEvidence[];
  readonly managerMisfires: number;
  readonly done: boolean;
}

export interface MeaGate {
  readonly id: string;
  readonly spec: VerifySpec;
}

export interface MeaGoal {
  readonly name?: string;
  readonly goal: string;
  readonly maxRounds: number;
  readonly maxSubtaskTurns: number;
  /** Declared POLICY — intersected with buildToolSet and stripped of `task`. */
  readonly executorTools?: readonly string[];
  readonly auditorTools?: readonly string[];
  readonly gates: readonly MeaGate[];
}

export type MeaParseResult = { valid: true; goal: MeaGoal } | { valid: false; errors: string[] };

const GATE_ID_RE = /^[a-z0-9-]+$/;
const GATE_SPEC_KINDS = ["exitCode", "fileExists", "regexMatch", "jsonPath", "toolUsed"] as const;

/** Exhaustive pure validator (the parseWorkflow discipline: every offending
 *  field + reason in ONE pass, so users fix the whole file at once). */
export function parseMeaGoal(text: string): MeaParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ["MEA goal must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(obj)) {
    if (!["name", "goal", "maxRounds", "maxSubtaskTurns", "executorTools", "auditorTools", "gates"].includes(key)) {
      errors.push(`unknown key "${key}" (allowed: name, goal, maxRounds, maxSubtaskTurns, executorTools, auditorTools, gates)`);
    }
  }
  if (obj.name !== undefined && (typeof obj.name !== "string" || obj.name.length === 0)) {
    errors.push("name must be a non-empty string");
  }
  if (typeof obj.goal !== "string" || obj.goal.trim().length === 0) {
    errors.push("goal is required (a non-empty string describing the end state the gates verify)");
  }
  const intInRange = (v: unknown, min: number, max: number): boolean =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
  if (obj.maxRounds !== undefined && !intInRange(obj.maxRounds, MEA_MAX_ROUNDS_MIN, MEA_MAX_ROUNDS_MAX)) {
    errors.push(`maxRounds must be an integer between ${MEA_MAX_ROUNDS_MIN} and ${MEA_MAX_ROUNDS_MAX}`);
  }
  if (obj.maxSubtaskTurns !== undefined && !intInRange(obj.maxSubtaskTurns, MEA_MAX_SUBTASK_TURNS_MIN, MEA_MAX_SUBTASK_TURNS_MAX)) {
    errors.push(`maxSubtaskTurns must be an integer between ${MEA_MAX_SUBTASK_TURNS_MIN} and ${MEA_MAX_SUBTASK_TURNS_MAX}`);
  }
  for (const field of ["executorTools", "auditorTools"] as const) {
    const v = obj[field];
    if (v !== undefined && (!Array.isArray(v) || v.some((t) => typeof t !== "string" || t.length === 0))) {
      errors.push(`${field} must be an array of non-empty tool names`);
    }
  }

  if (!Array.isArray(obj.gates) || obj.gates.length === 0) {
    errors.push("gates must be a non-empty array — the deterministic gate set IS the audit authority (a vacuous MEA goal is rejected)");
    return { valid: false, errors };
  }

  const seen = new Set<string>();
  const gates: MeaGate[] = [];
  for (const entry of obj.gates) {
    if (typeof entry !== "object" || entry === null) {
      errors.push("gates[i]: must be an object");
      continue;
    }
    const gate = entry as Record<string, unknown>;
    const rawId = typeof gate.id === "string" && gate.id.length > 0 ? gate.id : undefined;
    const label = rawId !== undefined ? `"${rawId}"` : `gates[${obj.gates.indexOf(entry)}]`;
    if (rawId === undefined || !GATE_ID_RE.test(rawId)) {
      errors.push(`gate ${label}: id must be a non-empty string matching [a-z0-9-]+`);
    } else if (seen.has(rawId)) {
      errors.push(`gate ${label}: duplicate gate id "${rawId}"`);
    } else {
      seen.add(rawId);
    }
    const specKinds = GATE_SPEC_KINDS.filter((k) => gate[k] !== undefined);
    for (const key of Object.keys(gate)) {
      if (key !== "id" && !GATE_SPEC_KINDS.includes(key as (typeof GATE_SPEC_KINDS)[number])) {
        errors.push(`gate ${label}: unknown key "${key}" (allowed: id, ${GATE_SPEC_KINDS.join(", ")})`);
      }
    }
    if (specKinds.length !== 1) {
      errors.push(`gate ${label}: must carry exactly one of ${GATE_SPEC_KINDS.join(", ")}`);
      continue;
    }
    const kind = specKinds[0];
    if (kind === undefined) continue; // unreachable after the length check; satisfies index-access typing
    const spec = gate[kind] as Record<string, unknown>;
    const specErrors = validateGateSpec(kind, spec);
    for (const e of specErrors) errors.push(`gate ${label}: ${e}`);
    if (specErrors.length === 0 && rawId !== undefined && GATE_ID_RE.test(rawId)) {
      gates.push({ id: rawId, spec: { [kind]: spec } as unknown as VerifySpec });
    }
  }

  if (errors.length > 0) return { valid: false, errors };
  return {
    valid: true,
    goal: {
      ...(typeof obj.name === "string" && obj.name.length > 0 ? { name: obj.name } : {}),
      goal: obj.goal as string,
      maxRounds: (obj.maxRounds as number | undefined) ?? MEA_MAX_ROUNDS_DEFAULT,
      maxSubtaskTurns: (obj.maxSubtaskTurns as number | undefined) ?? MEA_MAX_SUBTASK_TURNS_DEFAULT,
      ...(Array.isArray(obj.executorTools) ? { executorTools: obj.executorTools as string[] } : {}),
      ...(Array.isArray(obj.auditorTools) ? { auditorTools: obj.auditorTools as string[] } : {}),
      gates,
    },
  };
}

function validateGateSpec(kind: string, spec: unknown): string[] {
  const errors: string[] = [];
  if (typeof spec !== "object" || spec === null) {
    return [`${kind} must be an object`];
  }
  const s = spec as Record<string, unknown>;
  const nonEmptyString = (v: unknown): boolean => typeof v === "string" && v.length > 0;
  if (kind === "exitCode") {
    if (!nonEmptyString(s.command)) errors.push("exitCode.command must be a non-empty string");
    if (s.expect !== undefined && (typeof s.expect !== "number" || !Number.isInteger(s.expect))) {
      errors.push("exitCode.expect must be an integer");
    }
    if (s.timeoutMs !== undefined && (typeof s.timeoutMs !== "number" || !Number.isInteger(s.timeoutMs) || s.timeoutMs < 1)) {
      errors.push("exitCode.timeoutMs must be a positive integer");
    }
  } else if (kind === "fileExists") {
    if (!nonEmptyString(s.path)) errors.push("fileExists.path must be a non-empty string");
  } else if (kind === "regexMatch") {
    if (!nonEmptyString(s.pattern)) errors.push("regexMatch.pattern must be a non-empty string");
    if (s.flags !== undefined && typeof s.flags !== "string") errors.push("regexMatch.flags must be a string");
    if (s.text !== undefined && typeof s.text !== "string") errors.push("regexMatch.text must be a string");
  } else if (kind === "jsonPath") {
    if (!nonEmptyString(s.path)) errors.push("jsonPath.path must be a non-empty string");
  } else if (kind === "toolUsed") {
    if (!nonEmptyString(s.tool)) errors.push("toolUsed.tool must be a non-empty string");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// §3.1 The manager/auditor response contracts
// ---------------------------------------------------------------------------

export const MANAGER_SCHEMA: JsonSchemaSubset = {
  type: "object",
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["subtask", "done"] },
    title: { type: "string" },
    instructions: { type: "string" },
    turnBudget: { type: "integer" },
    rationale: { type: "string" },
  },
};

export const AUDITOR_SCHEMA: JsonSchemaSubset = {
  type: "object",
  required: ["diagnosis"],
  properties: {
    diagnosis: { type: "string" },
    recoveryHint: { type: "string" },
  },
};

export type ManagerDecision =
  | { readonly action: "subtask"; readonly title: string; readonly instructions: string; readonly turnBudget?: number }
  | { readonly action: "done" };

/** Semantic layer the subset validator cannot express (conditionals): a
 *  subtask without title/instructions, or a done without rationale, is a
 *  MISFIRE — bounded re-ask, then a manager-contract run failure. */
function validateManagerDecision(data: unknown): { ok: true; value: ManagerDecision } | { ok: false; reason: string } {
  const d = data as Record<string, unknown>;
  if (d.action === "subtask") {
    const title = typeof d.title === "string" ? d.title.trim() : "";
    const instructions = typeof d.instructions === "string" ? d.instructions.trim() : "";
    if (title.length === 0) return { ok: false, reason: "action \"subtask\" requires a non-empty title" };
    if (instructions.length === 0) return { ok: false, reason: "action \"subtask\" requires non-empty instructions" };
    return {
      ok: true,
      value: {
        action: "subtask", title, instructions,
        ...(typeof d.turnBudget === "number" && Number.isFinite(d.turnBudget) ? { turnBudget: d.turnBudget } : {}),
      },
    };
  }
  const rationale = typeof d.rationale === "string" ? d.rationale.trim() : "";
  if (rationale.length === 0) return { ok: false, reason: "action \"done\" requires a non-empty rationale" };
  return { ok: true, value: { action: "done" } };
}

// ---------------------------------------------------------------------------
// Prompt builders — byte-stable (no clocks, no randomness), needle-led
// ---------------------------------------------------------------------------

const renderStatus = (s: MeaGateStatus): string =>
  `  - ${s.id}: ${s.status.toUpperCase()}${s.detail !== undefined ? ` (${s.detail})` : ""}`;

function renderMatrix(matrix: readonly MeaGateStatus[]): string {
  if (matrix.length === 0) return "  (no evaluation yet — this is round 1)";
  return matrix.map(renderStatus).join("\n");
}

function renderFailures(failures: readonly MeaFailureEvidence[]): string {
  if (failures.length === 0) return "  (none yet)";
  return failures.map((f) => {
    const failing = f.failingGates.map((g) => `${g.id} (${g.status}${g.detail !== undefined ? `: ${g.detail}` : ""})`).join(", ");
    const lines = [`  [round ${f.round}] subtask "${f.subtask}" executor ${f.executorOutcome} — failing gates: ${failing}`];
    if (f.diagnosis !== undefined) lines.push(`    diagnosis: ${f.diagnosis}`);
    if (f.recoveryHint !== undefined) lines.push(`    recovery hint: ${f.recoveryHint}`);
    return lines.join("\n");
  }).join("\n");
}

export function buildManagerPrompt(state: MeaState, goal: MeaGoal, budget: BudgetView): string {
  const round = state.round + 1;
  return `[MEA manager] round ${round}/${goal.maxRounds} — workflow "${goal.name ?? "mea"}"

Goal: ${state.goal}

Gate matrix (latest deterministic evaluation — the only authority on progress):
${renderMatrix(state.gateMatrix)}

Failure evidence (newest last — each failure is next-round recovery input):
${renderFailures(state.failures)}

Rounds completed: ${state.round} of ${goal.maxRounds} (${Math.max(0, goal.maxRounds - state.round)} remaining).
${formatBudgetAdvisory(budget)}
Per-subtask turn budget cap: ${goal.maxSubtaskTurns} turns.

You are the Manager. Decide the SINGLE next bounded subtask toward the goal, selected from the verified gate matrix and the failure evidence above — never from an executor's self-report. Reply with ONLY a fenced json block, one of:
{"action":"subtask","title":"<short title>","instructions":"<bounded, concrete instructions>","turnBudget":<integer 1-${goal.maxSubtaskTurns}>,"rationale":"<why this is the right next step>"}
{"action":"done","rationale":"<why the goal is met>"}
Allocate fewer turns to mechanical subtasks and ample turns to complex ones; when the budget allows, instruct the executor to plan before acting. A turnBudget above ${goal.maxSubtaskTurns} is clamped. Only declare "done" when the gate matrix above shows every gate passing.`;
}

export function buildExecutorPrompt(
  goal: MeaGoal,
  subtask: { readonly title: string; readonly instructions: string },
  round: number,
  turns: number,
): string {
  return `[MEA executor] round ${round} — subtask "${subtask.title}"

Goal (context): ${goal.goal}

Subtask: "${subtask.title}"
Instructions:
${subtask.instructions}

Turn budget: ${turns} turns. Plan before acting when the budget allows.
Complete exactly this subtask in the workspace, then finish with a short final answer describing what you did. Your report is input for the auditor — it is never treated as verification.`;
}

export function buildAuditorPrompt(
  goal: MeaGoal,
  subtaskTitle: string,
  executorOutcome: "ok" | "failed",
  executorReport: string,
  gateStatuses: readonly MeaGateStatus[],
  round: number,
): string {
  return `[MEA auditor] round ${round} — advisory failure analysis for "${subtaskTitle}"

Goal: ${goal.goal}
Subtask executed: "${subtaskTitle}"
Executor outcome: ${executorOutcome}
Executor report (self-claimed, NOT verification):
${executorReport.length === 0 ? "(no report — the executor failed)" : executorReport}

Gate receipts (deterministic, authoritative):
${gateStatuses.filter((g) => g.status !== "pass").map(renderStatus).join("\n")}

You are the Auditor (advisory only — you can never mark work verified and can never change the gates). Using your read-only tools for independent evidence, diagnose why the failing gates fail and whether each failure looks flaky or real. Reply with ONLY a fenced json block:
{"diagnosis":"<what is actually broken, grounded in evidence you collected>","recoveryHint":"<the locatable repair condition for the next subtask>"}`;
}

// ---------------------------------------------------------------------------
// §3.2 The pure transition
// ---------------------------------------------------------------------------

export interface MeaRoundRecord {
  readonly round: number;
  readonly subtask: string;
  readonly gateResults: readonly MeaGateStatus[];
  readonly executorOutcome: "ok" | "failed";
  readonly diagnosis?: string;
  readonly recoveryHint?: string;
  readonly managerDeclaredDone?: boolean;
  readonly managerMisfires?: number;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** Deterministic trim to ≤4000 chars: cut the longest free-text field
 *  (diagnosis / recoveryHint) just enough, with a visible marker — structured
 *  fields are never dropped or reordered. */
function trimEvidence(entry: MeaFailureEvidence): MeaFailureEvidence {
  let e = entry;
  const marker = "…[trimmed]";
  for (let guard = 0; guard < 100 && JSON.stringify(e).length > MEA_FAILURE_EVIDENCE_MAX_CHARS; guard += 1) {
    const fields = (["diagnosis", "recoveryHint"] as const).filter((f): f is "diagnosis" | "recoveryHint" => e[f] !== undefined);
    if (fields.length === 0) break;
    const field = fields.reduce((a, b) => ((e[a] ?? "").length >= (e[b] ?? "").length ? a : b));
    const v = e[field] as string;
    const over = JSON.stringify(e).length - MEA_FAILURE_EVIDENCE_MAX_CHARS;
    const keep = Math.max(0, v.length - over - marker.length);
    const next = `${truncateSafe(v, keep)}${marker}`;
    if (next.length >= v.length) break; // nothing left to cut
    e = { ...e, [field]: next };
  }
  return e;
}

export function initialMeaState(goalText: string): MeaState {
  return deepFreeze({
    schemaVersion: 1 as const,
    goal: goalText,
    round: 0,
    gateMatrix: [],
    failures: [],
    managerMisfires: 0,
    done: false,
  });
}

/** Pure: deep-freezes its inputs, returns a NEW frozen state. The matrix is
 *  REPLACED by this round's latest evaluation (a gate that passed in round 2
 *  and fails in round 3 is demoted — regression detection is free); failures
 *  append (newest-20 cap, ≤4000 chars each); the executor's self-report
 *  appears nowhere in it. */
export function advanceMeaState(state: MeaState, record: MeaRoundRecord): MeaState {
  deepFreeze(state);
  deepFreeze(record);
  const failing = record.gateResults.filter((g) => g.status !== "pass");
  let failures = state.failures;
  if (failing.length > 0) {
    const entry: MeaFailureEvidence = trimEvidence({
      round: record.round,
      subtask: record.subtask,
      failingGates: failing,
      executorOutcome: record.executorOutcome,
      ...(record.diagnosis !== undefined ? { diagnosis: record.diagnosis } : {}),
      ...(record.recoveryHint !== undefined ? { recoveryHint: record.recoveryHint } : {}),
    });
    failures = [...state.failures, entry].slice(-MEA_FAILURE_EVIDENCE_CAP);
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    goal: state.goal,
    round: record.round,
    gateMatrix: record.gateResults,
    failures,
    managerMisfires: record.managerMisfires ?? state.managerMisfires,
    done: record.managerDeclaredDone === true,
  });
}

// ---------------------------------------------------------------------------
// §3.1 Manager-proposed turn budgets: clamp-over-refuse (the cap already
// bounds the blast radius — the task-tool.ts:367 pattern)
// ---------------------------------------------------------------------------

export function clampTurns(proposed: unknown, cap: number): { turns: number; note?: string } {
  const n = typeof proposed === "number" && Number.isFinite(proposed) ? Math.floor(proposed) : NaN;
  if (!Number.isFinite(n) || n < 1) {
    return { turns: 1, note: `invalid turnBudget ${JSON.stringify(proposed) ?? "undefined"} — clamped to 1` };
  }
  if (n > cap) {
    return { turns: cap, note: `turnBudget ${n} above the cap — clamped to ${cap}` };
  }
  return { turns: n };
}

// ---------------------------------------------------------------------------
// §3.5 Resume: state continuation, not task replay
// ---------------------------------------------------------------------------

/** Recover the LAST meaRound state from a journal's records; undefined when
 *  the run crashed before round 1 (resume then starts cleanly at round 0). */
export function recoverMeaState(records: readonly JournalRecord[]): MeaState | undefined {
  let found: MeaState | undefined;
  for (const record of records) {
    if (record.type !== "log") continue;
    let parsed: { meaRound?: { state?: MeaState } };
    try {
      parsed = JSON.parse(record.message) as { meaRound?: { state?: MeaState } };
    } catch {
      continue;
    }
    const state = parsed.meaRound?.state;
    if (
      typeof state === "object" && state !== null &&
      state.schemaVersion === 1 && typeof state.round === "number" && Array.isArray(state.gateMatrix)
    ) {
      found = state;
    }
  }
  return found;
}

/** Prior charged spend: the sum over ok task entries — the same accounting
 *  the budget itself charges (final ok attempts only). */
export function priorChargedSpend(records: readonly JournalRecord[]): number {
  let spent = 0;
  for (const record of records) {
    if (record.type === "task-finished" && record.ok) {
      spent += record.cost.promptTokens + record.cost.completionTokens;
    }
  }
  return spent;
}

// ---------------------------------------------------------------------------
// §3.1 The program
// ---------------------------------------------------------------------------

export interface MeaRunOptions extends Omit<JsflowOptions, "resumeTasks"> {
  /** State recovered from the journal being resumed (state continuation —
   *  resumeTasks is deliberately NOT accepted here; see §3.5). */
  readonly resumeState?: MeaState;
  /** Test seam forwarded to gate evaluation (the scorers.ts spawnShell). */
  readonly gateSpawnShell?: VerifyContext["spawnShell"];
}

const failingMessage = (gates: readonly MeaGateStatus[]): string =>
  gates.map((g) => `${g.id} (${g.status}${g.detail !== undefined ? `: ${g.detail}` : ""})`).join("; ");

function allPass(gates: readonly MeaGateStatus[]): boolean {
  return gates.length > 0 && gates.every((g) => g.status === "pass");
}

async function evaluateGates(
  goal: MeaGoal,
  opts: MeaRunOptions,
  exec: TaskResult,
): Promise<readonly MeaGateStatus[]> {
  const receipts = await evaluateVerifySpecs(goal.gates.map((g) => g.spec), {
    workspaceRoot: opts.workspaceRoot,
    taskText: exec.ok ? exec.text : "",
    toolsUsed: exec.toolsUsed,
    ...(opts.gateSpawnShell !== undefined ? { spawnShell: opts.gateSpawnShell } : {}),
  });
  return receipts.map((r, i) => ({
    id: goal.gates[i]?.id ?? `gate-${i}`,
    // ω-4c review M4: the former `r.status === "partial" ? "skip" : …` arm was
    // dead — evaluateVerifySpecs never emits "partial" (that VerifyStatus
    // member serves the TASK-evidence layer, vm.ts). Gate statuses pass
    // through from the scorer verbatim; the cast only narrows off the
    // unreachable member.
    status: r.status as MeaGateStatusKind,
    ...(r.detail !== undefined ? { detail: r.detail } : {}),
  }));
}

const MANAGER_CORRECTION = (reason: string): string =>
  `\n\nCORRECTION: your previous reply was valid JSON but semantically incomplete — ${reason}. Reply again with a single fenced json block carrying every required field.`;

export function runMeaWorkflow(goal: MeaGoal, opts: MeaRunOptions): Promise<JsflowRunResult> {
  // §3.5: MEA resumes by STATE continuation. The engine's task-replay list
  // is structurally absent from MeaRunOptions (the Omit above) AND stripped
  // at runtime — a JS caller forcing `resumeTasks` through must not be able
  // to arm the replay cursor (a key mismatch would truncate the audit
  // journal instead of continuing the rounds).
  const { resumeState, resumeTasks: forcedReplay, ...engineOpts } = opts as MeaRunOptions & { resumeTasks?: unknown };
  void forcedReplay;
  const emit = opts.onEvent;
  return runProgramWorkflow(async (p) => {
    let state = resumeState ?? initialMeaState(goal.goal);
    const cost = { promptTokens: 0, completionTokens: 0 };
    const addCost = (c: { readonly promptTokens: number; readonly completionTokens: number }): void => {
      cost.promptTokens += c.promptTokens;
      cost.completionTokens += c.completionTokens;
    };

    for (;;) {
      const round = state.round + 1;

      // Round admission: exhausted rounds with gates failing is a run failure
      // carrying the matrix + the last diagnosis (budget exhaustion is the
      // engine's own fatal assertCanSpend at the next task admission).
      if (state.round >= goal.maxRounds) {
        const failing = state.gateMatrix.filter((g) => g.status !== "pass");
        const last = state.failures[state.failures.length - 1];
        throw new PlanStepFailure({
          category: "verify-failed",
          message:
            `maxRounds (${goal.maxRounds}) exhausted with ${state.gateMatrix.length - failing.length}/${state.gateMatrix.length} gates passing` +
            (failing.length > 0 ? `: ${failingMessage(failing)}` : "") +
            (last?.diagnosis !== undefined ? `; last diagnosis: ${last.diagnosis}` : ""),
        });
      }

      // --- 1. Manage -------------------------------------------------------
      const managerPrompt = buildManagerPrompt(state, goal, p.budget);
      const managerOpts = {
        allowTools: DEFAULT_STEP_TOOLS,
        responseSchema: MANAGER_SCHEMA,
        retry: 1,
        label: `round-${round}-manager`,
      };
      let manager = await p.task(managerPrompt, managerOpts);
      addCost(manager.cost);
      if (!manager.ok) throw new PlanStepFailure(manager.failure);
      let decision = validateManagerDecision(manager.data);
      let misfires = state.managerMisfires;
      if (!decision.ok) {
        misfires += 1;
        if (misfires >= MEA_MANAGER_MISFIRE_BOUND) {
          throw new PlanStepFailure({
            category: "verify-failed",
            message: `manager-contract: ${decision.reason} (${misfires} misfires — the manager cannot produce a valid decision)`,
          });
        }
        const reask = await p.task(managerPrompt + MANAGER_CORRECTION(decision.reason), { ...managerOpts, label: `round-${round}-manager-reask` });
        addCost(reask.cost);
        if (!reask.ok) throw new PlanStepFailure(reask.failure);
        decision = validateManagerDecision(reask.data);
        if (!decision.ok) {
          misfires += 1;
          throw new PlanStepFailure({
            category: "verify-failed",
            message: `manager-contract: ${decision.reason} (${misfires} misfires — the manager cannot produce a valid decision)`,
          });
        }
      }

      if (decision.value.action === "done") {
        // The invariant (book ch10:214): a done declaration is IGNORED as
        // authority. Reuse the latest receipts (they just ran); when no
        // evaluation exists yet (round-1 done), evaluate once so the verdict
        // is receipts, never vacuous.
        let gates = state.gateMatrix;
        if (gates.length === 0) {
          gates = await evaluateGates(goal, opts, { ok: false, text: "", toolsUsed: [], cost: { promptTokens: 0, completionTokens: 0 }, failure: { category: "verify-failed", message: "no executor ran" } });
        }
        state = advanceMeaState(state, {
          round, subtask: "", gateResults: gates, executorOutcome: "ok", managerDeclaredDone: true,
          ...(misfires !== state.managerMisfires ? { managerMisfires: misfires } : {}),
        });
        await p.log({ meaRound: { round, subtask: "", declaredDone: true, budgetSpent: p.budget.spent, state } });
        emit?.({ type: "mea-round", round, gatesPassing: gates.filter((g) => g.status === "pass").length, gatesTotal: gates.length });
        if (allPass(gates)) {
          return { gates: `${gates.filter((g) => g.status === "pass").length}/${gates.length}`, rounds: state.round, cost, verified: gates.filter((g) => g.status === "pass").map((g) => g.id) };
        }
        throw new PlanStepFailure({
          category: "verify-failed",
          message: `manager declared done but ${gates.filter((g) => g.status !== "pass").length}/${gates.length} gates fail: ${failingMessage(gates.filter((g) => g.status !== "pass"))}`,
        });
      }

      // --- 2. Execute ------------------------------------------------------
      const subtask = decision.value;
      const { turns, note } = clampTurns(subtask.turnBudget, goal.maxSubtaskTurns);
      const exec = await p.task(buildExecutorPrompt(goal, subtask, round, turns), {
        ...(goal.executorTools !== undefined ? { allowTools: goal.executorTools } : {}),
        maxTurns: turns,
        retry: 0, // recovery in MEA is replanning with evidence, not blind re-runs
        label: `round-${round}-executor`,
      });
      addCost(exec.cost);

      // --- 3. Audit: authority tier (model-free, every gate re-run) --------
      const gateStatuses = await evaluateGates(goal, opts, exec);
      const passing = gateStatuses.filter((g) => g.status === "pass").length;

      // --- 4. Audit: analysis tier (advisory; only when something fails) ---
      let diagnosis: string | undefined;
      let recoveryHint: string | undefined;
      if (passing < gateStatuses.length) {
        const auditor = await p.task(
          buildAuditorPrompt(goal, subtask.title, exec.ok ? "ok" : "failed", exec.ok ? exec.text : "", gateStatuses, round),
          {
            allowTools: [...new Set([...DEFAULT_STEP_TOOLS, ...(goal.auditorTools ?? [])])],
            responseSchema: AUDITOR_SCHEMA,
            retry: 1,
            label: `round-${round}-auditor`,
            model: MEA_AUDITOR_MODEL_LABEL,
          },
        );
        addCost(auditor.cost);
        if (auditor.ok) {
          const data = auditor.data as { diagnosis?: unknown; recoveryHint?: unknown } | undefined;
          if (typeof data?.diagnosis === "string" && data.diagnosis.length > 0) diagnosis = data.diagnosis;
          if (typeof data?.recoveryHint === "string" && data.recoveryHint.length > 0) recoveryHint = data.recoveryHint;
        } else {
          diagnosis = `auditor task failed (${auditor.failure.category}: ${auditor.failure.message})`;
        }
      }

      // --- 5. Advance state, journal the round, emit the event -------------
      state = advanceMeaState(state, {
        round,
        subtask: subtask.title,
        gateResults: gateStatuses,
        executorOutcome: exec.ok ? "ok" : "failed",
        ...(diagnosis !== undefined ? { diagnosis } : {}),
        ...(recoveryHint !== undefined ? { recoveryHint } : {}),
        ...(misfires !== state.managerMisfires ? { managerMisfires: misfires } : {}),
      });
      await p.log({
        meaRound: {
          round, subtask: subtask.title, gateResults: gateStatuses, budgetSpent: p.budget.spent,
          ...(note !== undefined ? { turnsClamped: note } : {}),
          state,
        },
      });
      emit?.({ type: "mea-round", round, gatesPassing: passing, gatesTotal: gateStatuses.length, subtask: subtask.title });

      if (allPass(gateStatuses)) {
        return { gates: `${passing}/${gateStatuses.length}`, rounds: state.round, cost, verified: gateStatuses.filter((g) => g.status === "pass").map((g) => g.id) };
      }
      // else: the loop continues — failure is next-round input (ch10:220)
    }
  }, { ...engineOpts, budgetAdvisory: true }, "mea");
}
