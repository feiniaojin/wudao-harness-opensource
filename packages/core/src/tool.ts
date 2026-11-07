import type { ToolResult } from "./types.js";
import { truncateSafe, truncateTailSafe } from "./text-truncate.js";

// Minimal JSON-schema-like parameter shape (string | number | boolean for M1,
// array for list-shaped tools like todo_write — deep validation stays in the
// tool's execute, fail-closed). ω99-313 rider: `object` for structured
// arguments (the schedules' trigger calendar) — same contract as `items`:
// nested `properties` rides the wire for provider-side shaping only; core's
// validation/normalization stay top-level (v1), deep shape stays in execute.
export type ToolParameterType = "string" | "number" | "boolean" | "array" | "object";

export interface ToolParameter {
  readonly type: ToolParameterType;
  readonly description?: string;
  /** JSON-schema `items` for array parameters — serialized on the wire for
   *  provider-side argument shaping; not re-validated in core. */
  readonly items?: unknown;
  /** Nested JSON-schema `properties` for object parameters — same wire-only
   *  contract as `items`; not re-validated in core. */
  readonly properties?: Record<string, ToolParameter>;
  /** ω99-313 rider: JSON-schema `required` for object parameters — same
   *  wire-only contract as `properties`/`items`; not re-validated in core. */
  readonly required?: readonly string[];
  /** ω99-313 rider: JSON-schema `additionalProperties` for object params —
   *  same wire-only contract as the family above; not re-validated in core. */
  readonly additionalProperties?: boolean;
  /** M47 §6: known values. A case-folded string that matches EXACTLY ONE
   *  entry is normalized onto that entry's exact casing before validation. */
  readonly enum?: readonly string[];
}

export interface ToolParameterSchema {
  readonly type: "object";
  readonly properties: Record<string, ToolParameter>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

// The wire-format tool definition sent to a model.
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
}

// ω99-49 — the streaming-output delta protocol (two kinds, deliberately:
// pi's replace|append|slide|metadata collapses here). "append" is a pure
// tail extension of the consumer's view; "snapshot" REPLACES the view and
// carries the cumulative raw head bytes the sliding window has trimmed
// (pi's slide is the snapshot special case; its metadata rides the field).
// Consumers render with exactly two paths — append concatenates, snapshot
// substitutes — and never see anything else.
export type OutputDelta =
  | { readonly kind: "append"; readonly text: string }
  | { readonly kind: "snapshot"; readonly text: string; readonly droppedHeadBytes: number };

/** ω99-49: a tool's optional live-output consumer (shell's streaming
 *  face). Deltas are OBSERVER traffic: they never enter history, transcript,
 *  or the model-visible face (M24/append-only discipline untouched). */
export type ToolUpdateFn = (delta: OutputDelta) => void;

/** ω99-63: the IDENTIFIED delta a run-level consumer receives — the base
 *  OutputDelta plus the emitting call's identity. The identity is a LOOP-LEVEL
 *  INVARIANT: the loop's single executeToolCall point enriches every delta at
 *  the one place `call.id`/`call.name` are authoritative, so every tool and
 *  every caller gets the association for free (pi's shape — consumers
 *  capturing identity per call site — is deliberately NOT taken). Tool
 *  implementations never see this type: `execute(args, onUpdate?)` keeps the
 *  base ToolUpdateFn (zero changes on the tool side, base types untouched). */
export type IdentifiedOutputDelta = OutputDelta & {
  readonly toolCallId: string;
  readonly toolName: string;
};

/** ω99-63: the run-level consumer contract (LoopOptions.onToolUpdate). */
export type IdentifiedToolUpdateFn = (delta: IdentifiedOutputDelta) => void;

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameterSchema;
  /** ω99-49: the optional live-output channel. Absent (every pre-ω99-49
   *  caller and tool) → behavior is byte-identical to the single-parameter
   *  era; single-parameter execute implementations still satisfy the
   *  interface (optional parameter, zero breakage).
   *  借鉴弧 δ (penguin 367ab084): the optional per-call cancellation signal.
   *  Armed by the loop ONLY when a detach port exists, and aborted ONLY on
   *  the detached lane's stop path (an explicit user stop of a backgrounded
   *  task — 用户意图优先). Normal executions and ordinary aborts NEVER fire
   *  it: the abort race abandons the promise exactly as before. Absent →
   *  zero behavior change (every pre-δ tool ignores the extra argument). */
  execute(args: Record<string, unknown>, onUpdate?: ToolUpdateFn, signal?: AbortSignal): Promise<ToolResult>;
  // Risk annotations (M1 subset; expanded in later milestones).
  isReadOnly?(args: Record<string, unknown>): boolean;
  isConcurrencySafe?(args: Record<string, unknown>): boolean;
  /** M35 §1: lazy loading. A tool reporting true never enters a request's
   *  tools array — it hides behind the trailing `load_tools` meta-tool until
   *  the model asks for it (see defer.ts). Partition is fixed per run. */
  shouldDefer?(): boolean;
  /** ω-2b (I2-a): compaction retention — this tool's results are exempt from
   *  the CHEAP tiers (tier-0 clear, tier-1 microcompact): old results keep
   *  their full bytes instead of a stub/cleared marker. For tools whose old
   *  output is cheap to keep but expensive to lose (small high-value reads).
   *  The CLI wiring folds every exempt tool into the compaction retention
   *  exclude set once at startup; tier-2 span selection ignores it (YAGNI). */
  readonly compactionExempt?: boolean;
  /** M51 §3: interrupt semantics. "cancel" (default): Esc aborts the in-flight
   *  execution like any tool. "block": the tool is uninterruptible — an
   *  interrupt during its execution shows a "waiting for tool" notice and the
   *  run waits for it to settle (the loop never races it against the abort
   *  signal). Reserve for calls where cancellation itself is the hazard. */
  interruptBehavior?: "cancel" | "block";
  /** 夜移 002 (dsh guard/timeout-policy, hardened): opt-in execution
   *  deadline, armed by the loop's executor (not the tool) — the call is
   *  raced against a timer and a timeout returns a structured
   *  `[timeout after Nms]` error result instead of hanging the run. The
   *  underlying promise is NOT cancelled: it keeps running detached and its
   *  result is discarded (tools that can self-cancel, like shell,
   *  keep owning their own cancellation). Fail-open: absent = no deadline
   *  (legacy behavior). Exempt: interruptBehavior:"block" tools — "the run
   *  waits for it to settle" is the stronger contract and wins. */
  readonly timeoutMs?: number;
  /** M51 §3: DNA risk flags, consumer = the auto-mode sidecar classifier (the
   *  structured tool_flags field) and any policy layer. Argument-sensitive:
   *  shell is destructive per command. */
  isDestructive?(args: Record<string, unknown>): boolean;
  /** M51 §3: touches the world beyond the workspace filesystem (network,
   *  external services — MCP tools default true). */
  isOpenWorld?(args: Record<string, unknown>): boolean;
  /** M51 §3: custom equivalence for verdict/dedup caches — the sidecar's
   *  cache key becomes "equivalent, not byte-equal" (fixes the M49 Minor #5
   *  blind spot where insignificant argument differences re-classified). */
  inputsEquivalent?(a: Record<string, unknown>, b: Record<string, unknown>): boolean;
  /** M51 §3: JSON contract for results. Declared → every successful result is
   *  parsed and subset-validated; a violation is isError + an annotation line
   *  (never a silent repair). Absent → no check. */
  outputSchema?: ToolOutputSchema;
  /** ω99-30 (C): loop-safety cadence exemption — "this tool's repeated
   *  identical calls are polling semantics" (a mission state machine's
   *  designed next → work → complete rhythm) is part of the tool's
   *  self-description, same family as isReadOnly. The loop stamps it onto
   *  the turn's safety calls and ONLY the identical_calls lane filters on
   *  it; failure_streak / edit_repeat still judge an exempt tool — the
   *  exemption is for polling cadence, NOT failure immunity. Fail-closed:
   *  absent (or returning non-true) = counted exactly as today, and isError
   *  calls are never exempt. */
  loopExempt?(args: Record<string, unknown>): boolean;
  /** 长程弧 §1（pi「每工具自带 snippet+guidelines」/ dsh「per-tool SECTION」形）
   *  — 工具的提示词自述：一行做什么 + 若干条使用纪律。系统提示词按可用
   *  工具集收集这些声明渲染成 Tool usage 节，工具增删时提示词自动跟随，
   *  不再需要人在 prompt.ts 里同步一份硬写死的清单。
   *
   *  两条硬约束（wudao 与 pi/dsh 的差异）：
   *    1. **必须静态**：snippet/guidelines 是常量，不得含每次 run 变化的值
   *       （路径、时间、计数）。系统提示词是 memoized 前缀——每轮变一个字节
   *       就是一次前缀缓存全失效（M24）。需要用运行期值就写进工具 schema 的
   *       description（那本来每轮都在），不要写这里。
   *    2. **缺席即静默**：不声明的工具在 Tool usage 节里不出现。内置工具必须
   *       声明；第三方/MCP 工具可选（它们有 schema description 兜底）。
   *
   *  与 `description` 的边界：description 是给模型看的**调用契约**（参数语义、
   *  返回形状，随 schema 每轮下发）；promptSnippet 是给模型看的**使用策略**
   *  （什么时候该用它、别拿它做什么）。两者不重复。 */
  readonly promptSnippet?: string;
  /** 使用纪律（每条一句，渲染成 Tool usage 节下的缩进列表）。与 snippet
   *  分开的理由：小模型/长上下文下「一行是什么」和「多条怎么用」分开读
   *  比挤成一段更好召回；也对齐 pi 的 snippet+guidelines 两段式。 */
  readonly promptGuidelines?: readonly string[];
}

// ---------------------------------------------------------------------------
// M51 §3 — output schema (the M29 JSON-Schema SUBSET, core-side): type /
// required / properties / items / enum. The full JSON-Schema feature set is
// deliberately out of scope (spec: subset reuse, zero deps).
// ---------------------------------------------------------------------------

export type ToolOutputSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface ToolOutputSchema {
  readonly type?: ToolOutputSchemaType;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, ToolOutputSchema>>;
  readonly items?: ToolOutputSchema;
  readonly enum?: readonly unknown[];
}

const OUTPUT_TYPES: ReadonlySet<string> = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

/** Validate the SCHEMA itself (buildTool runs this once — a malformed schema
 *  is a developer error and must be loud at build time, not per result). */
export function assertValidToolOutputSchema(schema: ToolOutputSchema, path = "outputSchema"): void {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`${path}: must be an object`);
  }
  if (schema.type !== undefined && !OUTPUT_TYPES.has(schema.type)) {
    throw new Error(`${path}.type: unknown type "${String(schema.type)}"`);
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || schema.required.some((k) => typeof k !== "string")) {
      throw new Error(`${path}.required: must be a string array`);
    }
  }
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) {
    throw new Error(`${path}.enum: must be an array`);
  }
  if (schema.properties !== undefined) {
    if (typeof schema.properties !== "object" || schema.properties === null || Array.isArray(schema.properties)) {
      throw new Error(`${path}.properties: must be an object`);
    }
    for (const [name, sub] of Object.entries(schema.properties)) {
      if (sub === undefined || sub === null) throw new Error(`${path}.properties.${name}: must be a schema object`);
      assertValidToolOutputSchema(sub as ToolOutputSchema, `${path}.properties.${name}`);
    }
  }
  if (schema.items !== undefined) assertValidToolOutputSchema(schema.items, `${path}.items`);
}

function outputTypeMatches(value: unknown, expected: ToolOutputSchemaType): boolean {
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

function canonicalJsonForEquals(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonForEquals).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonForEquals((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateOutputAgainst(value: unknown, schema: ToolOutputSchema, path: string, errors: string[]): void {
  if (schema.type !== undefined && !outputTypeMatches(value, schema.type)) {
    errors.push(`${path}: expected ${schema.type}`);
    return; // a type mismatch makes deeper checks meaningless
  }
  if (schema.enum !== undefined) {
    const canonical = canonicalJsonForEquals(value);
    if (!schema.enum.some((candidate) => canonicalJsonForEquals(candidate) === canonical)) {
      errors.push(`${path}: value not in enum [${schema.enum.map((v) => (typeof v === "string" ? v : canonicalJsonForEquals(v))).join(",")}]`);
    }
  }
  if (schema.type === "object" || (schema.type === undefined && schema.properties !== undefined)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      for (const name of schema.required ?? []) {
        if (!(name in record)) errors.push(`${path}.${name}: missing required property`);
      }
      for (const [name, sub] of Object.entries(schema.properties ?? {})) {
        if (name in record) validateOutputAgainst(record[name], sub as ToolOutputSchema, `${path}.${name}`, errors);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => validateOutputAgainst(item, schema.items as ToolOutputSchema, `${path}[${i}]`, errors));
  }
}

export type ToolOutputCheck =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Check a tool RESULT text against its declared outputSchema: strict JSON
 *  parse, then subset validation. Never throws — parse/validation failures
 *  are the `{ok:false}` errors list. */
export function validateToolOutputResult(schema: ToolOutputSchema, resultText: string): ToolOutputCheck {
  let parsed: unknown;
  try {
    parsed = JSON.parse(resultText);
  } catch (err) {
    return { ok: false, errors: [`result is not valid JSON (${err instanceof Error ? err.message : String(err)})`] };
  }
  const errors: string[] = [];
  validateOutputAgainst(parsed, schema, "$", errors);
  return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors };
}

// Partial-in shape; buildTool fills the fail-closed defaults underneath.
export type ToolDef = Pick<Tool, "name" | "description" | "parameters" | "execute"> &
  Partial<Omit<Tool, "name" | "description" | "parameters" | "execute">>;

// Fail-closed: a stubbed tool without explicit overrides never looks safe —
// and M51 keeps the posture for the auditor-facing flags (unannotated =
// destructive + open-world, i.e. assume the worst until a tool says better).
export const TOOL_DEFAULTS: Pick<Tool, "isReadOnly" | "isConcurrencySafe" | "shouldDefer" | "interruptBehavior" | "isDestructive" | "isOpenWorld" | "loopExempt"> = {
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  shouldDefer: () => false,
  interruptBehavior: "cancel",
  isDestructive: () => true,
  isOpenWorld: () => true,
  // ω99-30: unannotated = counted (fail-closed — repeats stay suspect).
  loopExempt: () => false,
};

export function buildTool(def: ToolDef): Tool {
  if (def.outputSchema !== undefined) assertValidToolOutputSchema(def.outputSchema);
  return { ...TOOL_DEFAULTS, ...def };
}

export function toModelToolDefinition(tool: Tool): ModelToolDefinition {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

export type ValidationResult =
  | { valid: true; args: Record<string, unknown> }
  | { valid: false; error: string };

// M26 P3: LLM-friendly argument errors. The message is the recovery path —
// a model that can see WHAT is wrong, the expected type, the offending value
// (truncated), and a did-you-mean for typos fixes the call in one round
// instead of flailing. formatToolError is the pure renderer; the shapes below
// are the single source for every message (never hand-build these strings).
export type ToolArgumentError =
  | { kind: "missing"; toolName?: string; name: string; param: ToolParameter }
  | { kind: "unparsed"; toolName?: string; raw: string }
  | { kind: "type"; name: string; expected: ToolParameterType; value: unknown }
  | { kind: "unknown"; toolName?: string; name: string; known: readonly string[] }
  | { kind: "not-object"; toolName?: string; received: unknown };

/** Head/tail budget for values embedded in error messages: first 120 chars,
 *  a `…(N chars)… ` marker, last 40 — a long value is summarized, never
 *  dumped into the conversation. */
const VALUE_HEAD_CHARS = 120;
const VALUE_TAIL_CHARS = 40;
const SUGGEST_MAX_DISTANCE = 2;
const MAX_SUGGESTIONS = 3;

export function formatToolError(error: ToolArgumentError): string {
  switch (error.kind) {
    case "missing": {
      const where = error.toolName !== undefined ? ` for ${error.toolName}` : "";
      const hint = error.param.description !== undefined ? ` — ${error.param.description}` : "";
      return `missing required argument "${error.name}"${where} (expected: ${error.param.type}${hint})`;
    }
    case "type": {
      const article = error.expected === "array" ? "an" : "a";
      return `argument "${error.name}" must be ${article} ${error.expected} (got ${displayValue(error.value)}) — got: ${typeName(error.value)}`;
    }
    case "unknown": {
      const where = error.toolName !== undefined ? ` for ${error.toolName}` : "";
      return `unknown argument "${error.name}"${where}${didYouMean(error.name, error.known)}`;
    }
    case "not-object": {
      const where = error.toolName !== undefined ? ` for ${error.toolName}` : "";
      return `arguments${where} must be a JSON object — got: ${typeName(error.received)}`;
    }
    case "unparsed": {
      // 2026-11-06 Terminal-Bench 取证（headless-terminal）：上游把工具参数的
      // JSON 弄坏时（撕裂的 SSE 片段、被截断、字面控制字符），provider 三条线
      // 统一用 `{ _unparsed: <原文> }` 把它交下来——这是故意的可见约定。校验器
      // 此前不认识它，报的是 "missing required argument …"，模型据此去补一个
      // 本来就有的字段。真实原因是那段 JSON 没解析出来，必须直说。
      const where = error.toolName !== undefined ? ` for ${error.toolName}` : "";
      return `arguments${where} could not be parsed as JSON — the raw text arrived as ${truncateForError(error.raw)}. Re-send the call with valid JSON (check quoting/escaping).`;
    }
  }
}

function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function escapeForDisplay(text: string): string {
  return text.replace(/["\\\b\f\n\r\t]/g, (ch) => {
    switch (ch) {
      case '"': return '\\"';
      case "\\": return "\\\\";
      case "\b": return "\\b";
      case "\f": return "\\f";
      case "\n": return "\\n";
      case "\r": return "\\r";
      default: return "\\t";
    }
  });
}

function truncateForError(text: string, escape: (s: string) => string = (s) => s): string {
  if (text.length <= VALUE_HEAD_CHARS + VALUE_TAIL_CHARS) return escape(text);
  // 113-A4：错误预览的头尾帽代理对安全（参数校验错误是模型可见字节）。
  const head = truncateSafe(text, VALUE_HEAD_CHARS);
  const tail = truncateTailSafe(text, VALUE_TAIL_CHARS);
  return `${escape(head)}…(${text.length} chars)… ${escape(tail)}`;
}

function displayValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return `"${truncateForError(value, escapeForDisplay)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value); // circular structures etc. — never throw from an error formatter
  }
  return truncateForError(serialized);
}

/** Levenshtein distance, bailed early past the suggestion threshold. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > SUGGEST_MAX_DISTANCE) return SUGGEST_MAX_DISTANCE + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    prev = curr;
  }
  return prev[b.length]!;
}

/** 波次 7 #35: exported for the loop's unknown-TOOL lane (the argument
 *  validator's twin) — one suggestion matcher, no second dialect. */
export function didYouMean(name: string, known: readonly string[]): string {
  const candidates = known
    .filter((candidate) => candidate !== name)
    .map((candidate) => ({ candidate, distance: editDistance(name, candidate) }))
    .filter((c) => c.distance <= SUGGEST_MAX_DISTANCE)
    .sort((x, y) => x.distance - y.distance || (x.candidate < y.candidate ? -1 : 1))
    .slice(0, MAX_SUGGESTIONS);
  if (candidates.length === 0) return "";
  const list = candidates.map((c) => `"${c.candidate}"`).join(" or ");
  return ` — did you mean ${list}?`;
}

export function validateToolArguments(
  schema: ToolParameterSchema,
  input: unknown,
  toolName?: string,
): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { valid: false, error: formatToolError({ kind: "not-object", toolName, received: input }) };
  }
  const args = input as Record<string, unknown>;

  // 兜底形态只在「schema 本身没有 _unparsed 这个参数」时才算数——
  // 真有一个工具合法地叫这个参数时不得劫持它。
  const raw = args["_unparsed"];
  if (typeof raw === "string" && schema.properties["_unparsed"] === undefined && Object.keys(args).length === 1) {
    return { valid: false, error: formatToolError({ kind: "unparsed", toolName, raw }) };
  }

  for (const key of schema.required ?? []) {
    if (!(key in args)) {
      return {
        valid: false,
        error: formatToolError({
          kind: "missing",
          toolName,
          name: key,
          param: schema.properties[key] ?? { type: "string" },
        }),
      };
    }
  }

  for (const [key, value] of Object.entries(args)) {
    const param = schema.properties[key];
    if (!param) {
      if (schema.additionalProperties === false) {
        return {
          valid: false,
          error: formatToolError({
            kind: "unknown",
            toolName,
            name: key,
            known: Object.keys(schema.properties),
          }),
        };
      }
      continue;
    }
    if (!matchesType(value, param.type)) {
      return {
        valid: false,
        error: formatToolError({ kind: "type", name: key, expected: param.type, value }),
      };
    }
  }

  return { valid: true, args };
}

function matchesType(value: unknown, type: ToolParameterType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    // ω99-313 rider: a structured argument — plain object (an array is not
    // an object param; null is not either). Deep shape stays in execute.
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
}

// ---------------------------------------------------------------------------
// M47 §6 (A4): the tool-argument normalization layer.
//
// Models routinely emit ALMOST-right arguments — "true" for a boolean, "3" for
// a number, `"  \"a.txt\" "` for a path, "STRICT" for enum "strict". Before
// this layer every one of those failed validation and cost a full did-you-mean
// round trip. Normalization runs BETWEEN schema fetch and validation in the
// loop's dispatch, is schema-driven (the declared type is known), purely
// top-level (v1; no recursion into nested objects/arrays), and records what
// it changed so the result's first line is auditable:
//   `[args normalized: count,flag]`
// Fail-open: values it cannot fix are passed through untouched — the normal
// validation error (with did-you-mean) still answers them.
// ---------------------------------------------------------------------------

/** Keys that carry filesystem paths — trimmed and quote-stripped. */
function isPathParamName(name: string): boolean {
  return name === "file" || /path$/i.test(name);
}

/** Strip ONE layer of matching surrounding quotes ("…" or '…'). */
function stripWrappingQuotes(text: string): string {
  const m = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*')$/.exec(text);
  if (!m) return text;
  const inner = m[1]!.slice(1, -1);
  try {
    // A JSON-quoted string un-escapes cleanly; a bare '…' pair returns as-is.
    return m[1]![0] === '"' ? (JSON.parse(m[1]!) as string) : inner;
  } catch {
    return inner;
  }
}

/** Normalize a single value toward its declared parameter shape. Returns the
 *  normalized value, or undefined when nothing applied. Pure. */
function normalizeValue(key: string, param: ToolParameter, value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  // Enum case-fold: only a UNIQUE case-insensitive hit folds onto the exact
  // entry; zero or multiple hits stay untouched (validation/did-you-mean).
  if (param.enum !== undefined) {
    const folded = value.trim().toLowerCase();
    const hits = param.enum.filter((e) => e.toLowerCase() === folded);
    if (hits.length === 1 && hits[0] !== value) return hits[0];
    if (hits.length === 1) return undefined; // already exact
  }
  switch (param.type) {
    case "boolean": {
      const lower = value.trim().toLowerCase();
      if (lower === "true") return true;
      if (lower === "false") return false;
      return undefined;
    }
    case "number": {
      const trimmed = value.trim();
      return /^[+-]?(\d+(\.\d+)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed) ? Number(trimmed) : undefined;
    }
    case "string": {
      if (!isPathParamName(key)) return undefined;
      const stripped = stripWrappingQuotes(value.trim());
      return stripped !== value ? stripped : undefined;
    }
    default:
      return undefined;
  }
}

/** The normalized argument set + which top-level keys changed (sorted). Pure. */
export interface NormalizedArguments {
  readonly args: Record<string, unknown>;
  readonly normalized: readonly string[];
}

/** Schema-driven, top-level-only argument normalization (M47 §6). Never
 *  throws; unknown keys and unfixable values pass through untouched. */
export function normalizeToolArguments(
  schema: ToolParameterSchema,
  input: Record<string, unknown>,
): NormalizedArguments {
  const args: Record<string, unknown> = { ...input };
  const normalized: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const param = schema.properties[key];
    if (param === undefined) continue;
    const next = normalizeValue(key, param, value);
    if (next !== undefined) {
      args[key] = next;
      normalized.push(key);
    }
  }
  return { args, normalized: normalized.sort() };
}

/** The audit first line a normalized dispatch prepends to the tool result. */
export function formatArgsNormalizedLine(normalized: readonly string[]): string {
  return `[args normalized: ${normalized.join(",")}]`;
}
