// Deterministic workflow driver. Each step is one bounded agent run (fresh
// AgentState, whitelist-filtered tool set, per-step maxTurns); step results
// are asserted from the JOURNAL record, not from the model's word. The CCB
// ports/journal paradigm: determinism lives in the driver, the model just
// executes each port call.
import {
  runAgentLoop,
  type LoopEvent,
  type ModelClient,
  type PermissionDecision,
  type Terminal,
} from "@wudao-org/core";
import { basename } from "node:path";
import { buildToolSet } from "../tools.js";
import { buildSystemPrompt } from "../prompt.js";
import { DEFAULT_STEP_TOOLS, substituteStepRefs, type Workflow } from "./schema.js";
import type { JournalWriter, StepFinishedRecord } from "./journal.js";

export interface StepResult {
  readonly id: string;
  readonly ok: boolean;
  // true when the step was replayed from the journal (resume), not re-run.
  readonly skipped: boolean;
  readonly finalText: string;
  readonly toolsUsed: readonly string[];
  readonly error?: string;
}

export interface WorkflowRunResult {
  readonly ok: boolean;
  readonly results: readonly StepResult[];
}

export type StepEvent =
  | { type: "step-started"; id: string }
  | { type: "step-finished"; id: string; ok: boolean; skipped: boolean; toolsUsed: readonly string[]; error?: string };

export interface RunWorkflowOptions {
  readonly workspaceRoot: string;
  readonly model: ModelClient;
  readonly journal: JournalWriter;
  readonly workflowName: string;
  // Permission gate per CLI mode (capability≠policy: tools expose, this decides).
  readonly canUseTool?: (toolName: string, input: Record<string, unknown>) => Promise<PermissionDecision>;
  readonly contextWindowTokens?: number;
  // Steps already `step-finished ok` in the journal — skipped on resume.
  readonly resumeFrom?: ReadonlyMap<string, StepFinishedRecord>;
  readonly onStepEvent?: (e: StepEvent) => void;
}

// The subagent/task tool is NEVER available inside a workflow step: a
// deterministic script cannot allow the model to fan out unscoped agents.
const FORBIDDEN_STEP_TOOLS = new Set(["task"]);

const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });

export async function runWorkflow(workflow: Workflow, opts: RunWorkflowOptions): Promise<WorkflowRunResult> {
  const runId = basename(opts.journal.path).replace(/\.jsonl$/, "");
  const results: StepResult[] = [];
  const outputs = new Map<string, string>();
  // Seed substitution from the journal on resume so skipped steps feed later ones.
  for (const [id, record] of opts.resumeFrom ?? []) outputs.set(id, record.finalText);

  await opts.journal.append({
    type: "run-started",
    runId,
    workflow: opts.workflowName,
    startedAt: new Date().toISOString(),
  });

  for (const step of workflow.steps) {
    const resumeRecord = opts.resumeFrom?.get(step.id);
    if (resumeRecord) {
      const skipped: StepResult = {
        id: step.id, ok: true, skipped: true,
        finalText: resumeRecord.finalText, toolsUsed: resumeRecord.toolsUsed,
      };
      results.push(skipped);
      opts.onStepEvent?.({ type: "step-finished", id: step.id, ok: true, skipped: true, toolsUsed: resumeRecord.toolsUsed });
      continue;
    }

    opts.onStepEvent?.({ type: "step-started", id: step.id });
    await opts.journal.append({ type: "step-started", id: step.id });

    const allowed = new Set(step.allowTools ?? DEFAULT_STEP_TOOLS);
    const tools = buildToolSet({
      workspaceRoot: opts.workspaceRoot,
      model: opts.model,
      canUseTool: opts.canUseTool ?? allowAll,
      contextWindowTokens: opts.contextWindowTokens ?? 200000,
    }).filter((t) => allowed.has(t.name) && !FORBIDDEN_STEP_TOOLS.has(t.name));

    // Prompt-cache friendly: the base system prompt stays byte-stable, the
    // step scope is a trailing section.
    const allowedNames = tools.map((t) => t.name);
    const systemPrompt = buildSystemPrompt(opts.workspaceRoot) + `

# Workflow step
You are executing step "${step.id}" of deterministic workflow "${opts.workflowName}". Complete exactly this step's task, then finish with a short final answer.
Tools allowed in this step: ${allowedNames.join(", ")}.`;

    const prompt = substituteStepRefs(step.prompt, outputs);
    outputs.set(step.id, ""); // a step never reads its own output

    const state = {
      systemPrompt,
      messages: [{ role: "user" as const, content: prompt }],
      tools,
      status: "idle" as const,
    };

    const toolsUsed: string[] = [];
    const canUseTool = opts.canUseTool ?? allowAll;
    const gen = runAgentLoop(state, opts.model, {
      maxTurns: step.maxTurns ?? 8,
      canUseTool,
      compaction: { contextWindowTokens: opts.contextWindowTokens ?? 200000, reserveTokens: 16384 },
    });
    let terminal: Terminal | undefined;
    while (true) {
      const next = await gen.next();
      if (next.done) { terminal = next.value; break; }
      const event: LoopEvent = next.value;
      if (event.type === "tool_call_started" && !toolsUsed.includes(event.toolName)) {
        toolsUsed.push(event.toolName);
      }
    }

    // Assert from the record: terminal reason + expectations, never vibes.
    let error: string | undefined;
    if (!terminal || terminal.reason !== "completed") {
      error = `step ended with terminal "${terminal?.reason ?? "unknown"}" (no final answer)`;
    }
    const finalText = terminal?.reason === "completed" ? terminal.finalMessage?.content ?? "" : "";
    if (!error && step.expect?.toolUsed !== undefined && !toolsUsed.includes(step.expect.toolUsed)) {
      error = `expect.toolUsed "${step.expect.toolUsed}" not satisfied: tools used = [${toolsUsed.join(", ")}]`;
    }
    if (!error && step.expect?.outputContains !== undefined && !finalText.includes(step.expect.outputContains)) {
      error = `expect.outputContains not satisfied: final text does not contain "${step.expect.outputContains}"`;
    }

    const ok = error === undefined;
    if (ok) outputs.set(step.id, finalText);
    results.push({ id: step.id, ok, skipped: false, finalText, toolsUsed, ...(error !== undefined ? { error } : {}) });
    await opts.journal.append({
      type: "step-finished", id: step.id, ok, finalText, toolsUsed,
      endedAt: new Date().toISOString(),
    });
    opts.onStepEvent?.({ type: "step-finished", id: step.id, ok, skipped: false, toolsUsed, ...(error !== undefined ? { error } : {}) });

    if (!ok) {
      await opts.journal.append({ type: "run-finished", ok: false });
      return { ok: false, results };
    }
  }

  await opts.journal.append({ type: "run-finished", ok: true });
  return { ok: true, results };
}
