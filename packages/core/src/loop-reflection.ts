// ω-4b — the loop-safety reflection fork: ONE direct challenger model call
// at the run's SECOND loop verdict, before the forced abort (import-queue
// item 14; dao-code's cache-reusing reflection economics, per report 39 §9).
//
// The challenger is a verdict, not a worker: a single `model.generate()` —
// no loop, no nesting, no re-execution of the flagged call — whose request
// is the run's context plus one trailing user message, with the run's
// byte-identical system prompt and tools segment, so the provider's prefix
// cache makes the second opinion cost only its own increment (the M24 B2
// fork construction rule, borrowed from subagent.ts's shareContext branch
// without calling into it).
//
// Fail-closed is the spine: runReflectionFork NEVER throws — every failure
// (provider error, timeout, context overflow, marker-less answer, a
// recoverable verdict with no directive) maps to "unavailable", which
// adjudicates as "the original verdict stands → abort now". The /goal
// evaluator is the precedent (goal.ts: its failure must not block a stop;
// this failure must not block an abort).
//
// This module imports only types.js, model-client.js, tool.js and
// loop-safety.js — never loop.ts (loop.ts imports THIS; no cycle).

import type { AgentMessage } from "./types.js";
import type { ModelClient, ModelUsage } from "./model-client.js";
import { truncateSafe } from "./text-truncate.js";
import type { ModelToolDefinition } from "./tool.js";
import type { LoopKind, LoopSafetyTurn } from "./loop-safety.js";

/** The challenger's adjudication. "unavailable" is every failure mode —
 *  the original abort semantics win. */
export interface ReflectionVerdict {
  readonly outcome: "recoverable" | "stuck" | "unavailable";
  /** ≤600 chars, from the challenger's answer. */
  readonly rationale?: string;
  /** ≤400 chars; required when outcome === "recoverable" (a directive-less
   *  recoverable parses as undefined → unavailable → abort, fail-closed). */
  readonly directive?: string;
}

/** LoopOptions.reflection — absent = the feature is OFF (byte-identical loop
 *  behavior; the CLI wiring layer enables it). */
export interface ReflectionOptions {
  /** Wall ceiling for the one challenger call. Default 45 s — generous for
   *  reasoning-model first tokens, a hard ceiling against hangs. */
  readonly timeoutMs?: number;
}

export const REFLECTION_DEFAULT_TIMEOUT_MS = 45_000;

/** The fail-closed allowlist: exactly the detector kinds whose evidence is a
 *  concrete failing ACTION whose replacement a directive can name.
 *  `no_answer` (a gate/hook-configuration mismatch the model cannot repair)
 *  and any future kind abort exactly as today. */
export const REFLECTION_KINDS: ReadonlySet<LoopKind> = new Set([
  "identical_calls",
  "failure_streak",
  "edit_repeat",
]);

/** The background QuerySource tag: not in the provider ladder's foreground
 *  allowlist, so overload-class failures bail fast instead of retrying —
 *  zero provider edits (openai-compatible.ts keys on the string). */
export const REFLECTION_QUERY_SOURCE = "loop-reflector";

// ---------------------------------------------------------------------------
// The activity digest (pure, capped)
// ---------------------------------------------------------------------------

export const DIGEST_MAX_LINES = 24;
export const DIGEST_LINE_CHARS = 120;
export const DIGEST_TOTAL_CHARS = 2000;
const DIGEST_TRUNCATED_MARKER = "… (older activity truncated)";

/** JSON with recursively sorted object keys — the same canonical shape as
 *  loop-safety's fingerprints, so argument order never changes a line. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function capChars(text: string, max: number): string {
  return text.length > max ? `${truncateSafe(text, max - 1)}…` : text; // 113-A4：反射摘要帽代理对安全
}

/** One line per call (`name(args) → ok|error`) or `(no tools) "<preview>"`
 *  for answer turns, newest last. The newest DIGEST_MAX_LINES lines, each
 *  capped at DIGEST_LINE_CHARS, total capped at DIGEST_TOTAL_CHARS with the
 *  truncation marker — the argPreview/transcriptDigest shaping discipline.
 *  Pure over the turn list. */
export function windowDigest(turns: readonly LoopSafetyTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    if (t.calls.length > 0) {
      for (const c of t.calls) {
        const args = capChars(canonicalJson(c.args), 60);
        lines.push(capChars(`${c.name}(${args}) → ${c.isError ? "error" : "ok"}`, DIGEST_LINE_CHARS));
      }
    } else if (t.answer !== undefined) {
      lines.push(capChars(`(no tools) "${capChars(t.answer, 60)}"`, DIGEST_LINE_CHARS));
    }
  }
  let truncated = lines.length > DIGEST_MAX_LINES;
  let kept = lines.slice(-DIGEST_MAX_LINES);
  // Total-char budget (the marker included): drop OLDEST lines first.
  while (kept.length > 1 && (truncated ? `${DIGEST_TRUNCATED_MARKER}\n${kept.join("\n")}` : kept.join("\n")).length > DIGEST_TOTAL_CHARS) {
    kept = kept.slice(1);
    truncated = true;
  }
  return truncated ? `${DIGEST_TRUNCATED_MARKER}\n${kept.join("\n")}` : kept.join("\n");
}

// ---------------------------------------------------------------------------
// The instruction + the parser (the prompt seam, deterministic)
// ---------------------------------------------------------------------------

/** The defining prefix of the challenger's trailing user message. */
export const CHALLENGER_PREFIX = "[loop-safety challenger]";

/** The challenger's one user-role instruction. Deterministic — no
 *  timestamps, no run-ids — so repeated forks over the same state build the
 *  same bytes (prefix-cache discipline). */
export function buildChallengerInstruction(evidence: string, digest: string): string {
  return [
    `${CHALLENGER_PREFIX} The harness's loop detector has fired its SECOND verdict on this run:`,
    `  ${evidence}`,
    `Recent activity (newest last):`,
    `  ${digest}`,
    `You are the challenger in a fail-safe adjudication: one more verdict aborts this run. Judge independently — using the full conversation above — whether the run is genuinely stuck (no realistic change of approach remains) or recoverable (a concrete different next action plausibly breaks the pattern). Answer with exactly one verdict line first, then at most 3 lines:`,
    `VERDICT: stuck — the run cannot realistically recover; abort it`,
    `VERDICT: recoverable — a concrete different approach exists`,
    `DIRECTIVE: <one imperative sentence to the run's agent, naming the different approach> (required when recoverable)`,
    `Do not propose new work beyond escaping the loop. Do not judge style — judge recoverability.`,
  ].join("\n");
}

const VERDICT_RE = /VERDICT:\s*(stuck|recoverable)\b/i;
const DIRECTIVE_RE = /^DIRECTIVE:\s*(.+)$/im;

/** Parse the challenger's answer (the parseGoalVerdict mirror). Undefined =
 *  no usable verdict (marker-less, empty, or a directive-less recoverable) —
 *  the caller adjudicates that as "unavailable" (fail-closed). */
export function parseReflectionVerdict(text: string): ReflectionVerdict | undefined {
  if (text.trim() === "") return undefined;
  const m = VERDICT_RE.exec(text);
  if (m === null) return undefined;
  const outcome = (m[1] ?? "").toLowerCase() as "stuck" | "recoverable";
  // Rationale: the same-line remainder + the ≤3 following non-empty lines,
  // excluding any VERDICT/DIRECTIVE marker lines.
  const rest = text.slice((m.index ?? 0) + m[0].length).trim().replace(/^[\s—–:-]+/, "");
  const following = rest
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !VERDICT_RE.test(l) && !DIRECTIVE_RE.test(l))
    .slice(0, 3)
    .join(" ");
  const rationale = capChars(following, 600);
  const dm = DIRECTIVE_RE.exec(text);
  const directive = dm === null ? undefined : capChars((dm[1] ?? "").trim(), 400);
  if (outcome === "recoverable" && (directive === undefined || directive.trim() === "")) return undefined;
  return {
    outcome,
    ...(rationale !== "" ? { rationale } : {}),
    ...(directive !== undefined && directive.trim() !== "" ? { directive } : {}),
  };
}

// ---------------------------------------------------------------------------
// The fork — one generate call, never throws
// ---------------------------------------------------------------------------

/** Everything the fork needs; the loop supplies it at the verdict boundary. */
export interface ReflectionForkContext {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly evidence: string;
  readonly digest: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs: number;
  /** Observer: receives the challenger's usage row stamped
   *  `reflectionTokens = promptTokens + completionTokens` (the fork's own
   *  receipt column; its cacheHitTokens is the live prefix-share measure). */
  readonly onUsage?: (usage: ModelUsage) => void;
}

/** Run the challenger: ONE `model.generate()` whose request is
 *  `parent's context + strict suffix` (verbatim system prompt, byte-identical
 *  tools table, `[...messages, instruction]` — a copy, state is never
 *  mutated). The linked controller forwards the parent signal AND enforces
 *  the wall timeout (cleared in finally — no dangling handle). NEVER throws:
 *  every failure returns {outcome:"unavailable"}. The answer's
 *  `reasoning`/`tool_calls` are parsed never, executed never — a one-shot
 *  verdict call has no successor to replay anything to. */
export async function runReflectionFork(
  model: ModelClient,
  ctx: ReflectionForkContext,
): Promise<ReflectionVerdict> {
  const controller = new AbortController();
  const forwardAbort = (): void => { if (ctx.signal?.aborted) controller.abort(); };
  forwardAbort();
  ctx.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const answer = await model.generate({
      systemPrompt: ctx.systemPrompt,
      messages: [...ctx.messages, { role: "user", content: buildChallengerInstruction(ctx.evidence, ctx.digest) }],
      tools: ctx.tools,
      signal: controller.signal,
      // reasoningEffort deliberately omitted: absent = the provider
      // config's own effort — byte-identical to the run's own calls.
      querySource: REFLECTION_QUERY_SOURCE,
      onUsage: (u) => {
        ctx.onUsage?.({ ...u, reflectionTokens: u.promptTokens + (u.completionTokens ?? 0) });
      },
    });
    return parseReflectionVerdict(answer.content) ?? { outcome: "unavailable" };
  } catch {
    return { outcome: "unavailable" };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", forwardAbort);
  }
}
