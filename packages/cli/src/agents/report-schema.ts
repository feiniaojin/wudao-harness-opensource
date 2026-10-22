// M30-β — reportSchema (spec §B "回执契约"): a background worker's final
// report is validated against the schema the SPAWNING call carried. The
// worker side (grace-round enforcement) is M30-α; β's job is the spawn-time
// gate — the schema argument itself must be a legal M29 JSON-Schema subset
// BEFORE any agent starts (fail-closed: a junk schema is a caller error, not
// a worker failure).
//
// ω99-5b §B: the structured finishing tool. A schema'd spawn's child gains a
// `final_output` tool whose PARAMETERS are the report schema verbatim — the
// provider shapes the call's arguments against it (the upstream project final_output parity:
// tool-args JSON is far more reliable than free text), and execute re-checks
// through the M29 subset validator. Side-effect-free by construction.
import { buildTool } from "@wudao/core";
import type { Tool, ToolParameterSchema } from "@wudao/core";
import { validateJsonSchemaSubset } from "../workflow/structured-output.js";
import type { JsonSchemaType, JsonSchemaSubset } from "../workflow/structured-output.js";

export const FINAL_OUTPUT_TOOL_NAME = "final_output";

/** The deterministic success receipt (tests pin these exact bytes). */
export const FINAL_OUTPUT_OK = "final output recorded ✓ — end your turn now (no more tool calls)";

export function createFinalOutputTool(schema: JsonSchemaSubset): Tool {
  return buildTool({
    name: FINAL_OUTPUT_TOOL_NAME,
    description: "Submit the final structured report for this task as JSON; after calling it, do not call any more tools.",
    // The report schema rides the wire VERBATIM (provider-side argument
    // shaping is the whole point). The loop's own flat-primitive argument
    // validator understands the common flat subset; deep validation is
    // execute's job below — the tool never depends on the loop's check.
    parameters: schema as unknown as ToolParameterSchema,
    async execute(args) {
      const errors = validateJsonSchemaSubset(args, schema);
      if (errors.length > 0) {
        return {
          content: `report contract violations: ${errors.join("; ")} — fix and call final_output again`,
          isError: true,
        };
      }
      return { content: FINAL_OUTPUT_OK };
    },
    // Pure by construction: no disk, no writes, no world.
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isDestructive: () => false,
    isOpenWorld: () => false,
  });
}

const TYPES: readonly string[] = ["object", "array", "string", "number", "integer", "boolean", "null"];

export type ReportSchemaParse =
  | { readonly ok: true; readonly schema: JsonSchemaSubset }
  | { readonly ok: false; readonly error: string };

function nodeErrors(schema: unknown, path: string): string[] {
  const errors: string[] = [];
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return [`${path}: schema node must be an object`];
  }
  const rec = schema as Record<string, unknown>;
  if (rec.type !== undefined && (typeof rec.type !== "string" || !TYPES.includes(rec.type))) {
    errors.push(`${path}.type: expected one of ${TYPES.join("|")}`);
  }
  if (rec.required !== undefined && (!Array.isArray(rec.required) || rec.required.some((r) => typeof r !== "string"))) {
    errors.push(`${path}.required: expected an array of strings`);
  }
  if (rec.properties !== undefined) {
    if (typeof rec.properties !== "object" || rec.properties === null || Array.isArray(rec.properties)) {
      errors.push(`${path}.properties: expected an object`);
    } else {
      for (const [name, sub] of Object.entries(rec.properties)) {
        errors.push(...nodeErrors(sub, `${path}.properties.${name}`));
      }
    }
  }
  if (rec.items !== undefined) errors.push(...nodeErrors(rec.items, `${path}.items`));
  if (rec.enum !== undefined && !Array.isArray(rec.enum)) errors.push(`${path}.enum: expected an array`);
  return errors;
}

/** Parse + structurally validate the task tool's `reportSchema` argument.
 *  Accepts the schema directly as an object, or JSON-encoded as a string
 *  (the wire parameter is string-typed). Rejects non-object ROOT schemas —
 *  a worker report is an object. */
export function parseReportSchema(raw: unknown): ReportSchemaParse {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return { ok: false, error: "reportSchema must be a JSON object (or a JSON-encoded string); the value did not parse" };
    }
  }
  const errors = nodeErrors(value, "$");
  if (errors.length > 0) return { ok: false, error: `reportSchema is not a legal schema subset: ${errors.join("; ")}` };
  const rec = value as Record<string, unknown>;
  if (rec.type !== undefined && rec.type !== "object") {
    return { ok: false, error: `reportSchema root must be type "object" (got "${String(rec.type)}")` };
  }
  return { ok: true, schema: value as JsonSchemaSubset };
}
