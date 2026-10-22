// M29 §1 — structured output for workflow tasks: a hand-written JSON-Schema
// SUBSET validator (zero deps: type / required / properties / items / enum)
// plus robust JSON extraction from model text (fenced blocks first, then a
// brace-balanced scan). No syntax repair — repairing risks wrong edits inside
// strings (CCB claudeCodeBackend lesson); a violation is a step failure.

export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchemaSubset {
  readonly type?: JsonSchemaType;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchemaSubset>>;
  readonly items?: JsonSchemaSubset;
  readonly enum?: readonly unknown[];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // JSON has a single "number" family; integer-ness is a schema constraint
}

function typeMatches(value: unknown, expected: JsonSchemaType): boolean {
  switch (expected) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
  }
}

/** Canonical JSON with recursively sorted object keys — two JSON-equal values
 *  always produce the same string (enum + equals comparisons). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function jsonEquals(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Validate `value` against the schema subset; returns every violation with a
 *  JSON-path location (`$.tags[1]`). Empty array = valid. */
export function validateJsonSchemaSubset(
  value: unknown,
  schema: JsonSchemaSubset,
  path = "$",
): readonly string[] {
  const errors: string[] = [];
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
    return errors; // a type mismatch makes deeper checks meaningless
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => jsonEquals(candidate, value))) {
      errors.push(`${path}: value not in enum [${schema.enum.map((v) => (typeof v === "string" ? v : canonicalJson(v))).join(",")}]`);
    }
  }
  if (schema.type === "object" || (schema.type === undefined && schema.properties !== undefined)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const name of schema.required ?? []) {
        if (!(name in record)) errors.push(`${path}.${name}: missing required property`);
      }
      for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        if (name in record) {
          errors.push(...validateJsonSchemaSubset(record[name], sub, `${path}.${name}`));
        }
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => {
      errors.push(...validateJsonSchemaSubset(item, schema.items as JsonSchemaSubset, `${path}[${i}]`));
    });
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type ExtractionResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly reason: "none" };

const FENCED_RE = /```[a-zA-Z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g;

function tryParse(text: string): unknown | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** Top-level balanced spans ({...} or [...]), skipping braces inside strings. */
function balancedSpans(text: string): string[] {
  const spans: string[] = [];
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (stack.length === 0) start = i;
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const open = stack[stack.length - 1];
      if ((open === "{" && ch === "}") || (open === "[" && ch === "]")) {
        stack.pop();
        if (stack.length === 0 && start >= 0) {
          spans.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

/** Extract structured output from model text: fenced blocks first (the LAST
 *  one that parses — the final answer is the contract), then a brace-balanced
 *  scan (preferring objects over arrays). Scalars are never accepted. */
export function extractStructuredOutput(text: string): ExtractionResult {
  for (const match of [...text.matchAll(FENCED_RE)].reverse()) {
    const parsed = tryParse(match[1] ?? "");
    if (parsed !== undefined) return { ok: true, value: parsed };
  }
  const objects: unknown[] = [];
  const arrays: unknown[] = [];
  for (const span of balancedSpans(text)) {
    const parsed = tryParse(span);
    if (parsed === undefined) continue; // skip, never repair
    if (Array.isArray(parsed)) arrays.push(parsed);
    else objects.push(parsed);
  }
  if (objects.length > 0) return { ok: true, value: objects[objects.length - 1] };
  if (arrays.length > 0) return { ok: true, value: arrays[arrays.length - 1] };
  return { ok: false, reason: "none" };
}
