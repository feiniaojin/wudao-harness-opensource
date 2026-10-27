// Workflow script schema: parse + validate a workflow JSON file.
// Validation is exhaustive — every offending step id + reason is reported in
// one pass, so users fix the whole file at once instead of whack-a-mole.

export interface WorkflowExpect {
  readonly toolUsed?: string;
  readonly outputContains?: string;
}

export interface WorkflowStep {
  readonly id: string;
  readonly prompt: string;
  // Whitelist for this step. Default (absent) = the read-only tool set.
  readonly allowTools?: readonly string[];
  readonly maxTurns?: number;
  readonly expect?: WorkflowExpect;
}

export interface Workflow {
  readonly name?: string;
  readonly steps: readonly WorkflowStep[];
}

export type WorkflowParseResult =
  | { valid: true; workflow: Workflow }
  | { valid: false; errors: string[] };

// Default step scope when allowTools is absent: read-only exploration only.
export const DEFAULT_STEP_TOOLS: readonly string[] = ["read_file", "glob", "grep"];

const STEP_ID_RE = /^[a-z0-9-]+$/;
// {{step.<id>.output}} — no inner whitespace, exactly this shape.
const STEP_REF_RE = /\{\{step\.([a-z0-9-]+)\.output\}\}/g;

export function extractStepRefs(prompt: string): string[] {
  return [...prompt.matchAll(STEP_REF_RE)].map((m) => m[1] ?? "");
}

// Substitute {{step.<id>.output}} with the recorded finalText of that step.
// References are validated up-front by parseWorkflow; a missing output here
// substitutes an explicit marker rather than throwing (the journal is truth).
export function substituteStepRefs(prompt: string, outputs: ReadonlyMap<string, string>): string {
  return prompt.replace(STEP_REF_RE, (_all, id: string) => outputs.get(id) ?? `{{step.${id}.output unavailable}}`);
}

export function parseWorkflow(text: string): WorkflowParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { valid: false, errors: [`invalid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ["workflow must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];

  for (const key of Object.keys(obj)) {
    if (key !== "name" && key !== "steps") errors.push(`unknown key "${key}" (allowed: name, steps)`);
  }
  if (obj.name !== undefined && typeof obj.name !== "string") {
    errors.push("name must be a string");
  }
  if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
    errors.push("steps must be a non-empty array");
    return { valid: false, errors };
  }

  const seen = new Set<string>();
  const steps: WorkflowStep[] = [];

  obj.steps.forEach((entry: unknown, index: number) => {
    if (typeof entry !== "object" || entry === null) {
      errors.push(`steps[${index}]: must be an object`);
      return;
    }
    const step = entry as Record<string, unknown>;
    const rawId = typeof step.id === "string" ? step.id : undefined;
    const id = rawId !== undefined && STEP_ID_RE.test(rawId) ? rawId : undefined;
    // Label with the raw id (even when invalid) so errors point at the offender.
    const label = rawId !== undefined && rawId.length > 0 ? `"${rawId}"` : `steps[${index}]`;

    // Duplicate detection keys on the raw id (even if otherwise invalid):
    // "BAD" + "BAD" is both a bad id AND a duplicate.
    const dupKey = rawId !== undefined && rawId.length > 0 ? rawId : undefined;
    if (id === undefined) {
      errors.push(`step ${label}: id must be a non-empty string matching [a-z0-9-]`);
    }
    if (dupKey !== undefined) {
      if (seen.has(dupKey)) errors.push(`step ${label}: duplicate step id "${dupKey}"`);
      else seen.add(dupKey);
    }

    for (const key of Object.keys(step)) {
      if (key !== "id" && key !== "prompt" && key !== "allowTools" && key !== "maxTurns" && key !== "expect") {
        errors.push(`step ${label}: unknown key "${key}" (allowed: id, prompt, allowTools, maxTurns, expect)`);
      }
    }

    if (typeof step.prompt !== "string" || step.prompt.length === 0) {
      errors.push(`step ${label}: prompt must be a non-empty string`);
    }

    if (step.allowTools !== undefined) {
      if (!Array.isArray(step.allowTools) || step.allowTools.some((t) => typeof t !== "string" || t.length === 0)) {
        errors.push(`step ${label}: allowTools must be an array of non-empty tool names`);
      }
    }

    if (step.maxTurns !== undefined) {
      if (typeof step.maxTurns !== "number" || !Number.isInteger(step.maxTurns) || step.maxTurns < 1) {
        errors.push(`step ${label}: maxTurns must be an integer >= 1`);
      }
    }

    if (step.expect !== undefined) {
      if (typeof step.expect !== "object" || step.expect === null || Array.isArray(step.expect)) {
        errors.push(`step ${label}: expect must be an object`);
      } else {
        const expect = step.expect as Record<string, unknown>;
        for (const key of Object.keys(expect)) {
          if (key !== "toolUsed" && key !== "outputContains") {
            errors.push(`step ${label}: unknown expect key "${key}" (allowed: toolUsed, outputContains)`);
          }
        }
        for (const key of ["toolUsed", "outputContains"] as const) {
          const v = expect[key];
          if (v !== undefined && (typeof v !== "string" || v.length === 0)) {
            errors.push(`step ${label}: expect.${key} must be a non-empty string`);
          }
        }
      }
    }

    // Variable refs must point to an EARLIER step (already in `seen` and not
    // this step itself): forward/self references are rejected up-front.
    if (typeof step.prompt === "string") {
      for (const ref of extractStepRefs(step.prompt)) {
        if (ref === id) {
          errors.push(`step ${label}: prompt references {{step.${ref}.output}} — a step cannot reference itself`);
        } else if (!seen.has(ref)) {
          errors.push(`step ${label}: prompt references {{step.${ref}.output}} which is not an earlier step`);
        }
      }
    }

    // Only well-formed steps are collected; any error short-circuits the
    // return below, so dropping malformed entries here is safe.
    if (id !== undefined && typeof step.prompt === "string" && step.prompt.length > 0) {
      steps.push({
        id,
        prompt: step.prompt,
        ...(Array.isArray(step.allowTools) ? { allowTools: step.allowTools as string[] } : {}),
        ...(typeof step.maxTurns === "number" ? { maxTurns: step.maxTurns } : {}),
        ...(typeof step.expect === "object" && step.expect !== null ? { expect: step.expect as WorkflowExpect } : {}),
      });
    }
  });

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true, workflow: { ...(typeof obj.name === "string" ? { name: obj.name } : {}), steps } };
}
