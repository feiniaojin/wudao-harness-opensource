import type { AgentMessage, AssistantMessage } from "./types.js";
import type { ModelToolDefinition } from "./tool.js";
// 120-a A2: the ONE canonical serializer — every prefix-freeze byte
// comparison goes through it (never a hand-rolled second key-ordering).
import { canonicalJson } from "./loop-safety.js";

/** Per-call prompt usage with DISJOINT cache counts: hit + miss = promptTokens.
 *  Wire spelling differences (prompt_cache_hit_tokens vs
 *  prompt_tokens_details.cached_tokens) are resolved at the provider boundary
 *  (prefer details, fall back, never sum) so consumers see one number.
 *  M29 adds optional `completionTokens` — set by providers whenever the wire
 *  reports it (workflow budgets/journals bill prompt + completion); older
 *  constructors may omit it and consumers must default it to 0.
 *
 *  M56 §2 (turn_usage receipts, the upstream format AGENT_RUNTIME): the optional
 *  receipt fields below follow the omit-never-null discipline — present when
 *  known, OMITTED when unknown, never null, never backfilled with zeros.
 *  `cacheWriteTokens` ≈ cacheMiss on cache-reporting endpoints (every DeepSeek
 *  miss is written); `reasoningReplayTokens` is a client-side estimate of the
 *  historical reasoning sent back out (M47 replay contract); `durationMs`
 *  measures the wall time around the attempt and is always set by the real
 *  provider (scripted models may omit it).
 *  M58 §A adds the cold-turn compensation pair: `coldTurnExpected` marks the
 *  FIRST call riding a freshly rewritten prefix (a compaction just replaced
 *  it — the cache hit is expected to be 0 and that is NOT a regression), and
 *  `cacheBreakAttribution` names WHY the prefix broke (the compaction
 *  trigger word). Omit-never-null discipline as everywhere else: absent on
 *  ordinary warm turns. */
export interface ModelUsage {
  readonly promptTokens: number;
  readonly cacheHitTokens: number;
  readonly cacheMissTokens: number;
  readonly completionTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly reasoningTokens?: number;
  readonly reasoningReplayTokens?: number;
  readonly durationMs?: number;
  /** M58 §A: this call's prefix was just rewritten by a compaction — a cold
   *  cache this turn is expected, not a hit-rate regression. */
  readonly coldTurnExpected?: true;
  /** M58 §A: WHY the prefix broke — the compaction trigger word ("reactive",
   *  "threshold", "boundary", "immediate"). */
  readonly cacheBreakAttribution?: string;
  /** M61 §3: this usage row is the /goal EVALUATOR's call (the small-model
   *  transcript judgment) — its own column in the turn_usage receipt, never
   *  mixed into the agent's own model calls. Set on the evaluator's usage
   *  only; omitted everywhere else. */
  readonly evaluatorTokens?: number;
  /** ω-4b: this usage row is the loop-safety REFLECTION fork's call (the
   *  one-shot challenger at the second loop verdict) — promptTokens +
   *  completionTokens of that single call. Unlike the evaluator the fork
   *  rides the SAME model and the run's warm prefix, so the row folds as a
   *  normal call; the stamp exists so occupancy/watermark consumers can
   *  exclude a side verdict's prompt size, and its cacheHitTokens is the
   *  live prefix-share measure. Set on the fork's usage only; omitted
   *  everywhere else. */
  readonly reflectionTokens?: number;
  /** M62 §7: this call ran on the FALLBACK model (the ordered
   *  fallbackModel chain) after the primary failed with a model-class
   *  error — the receipt annotation. */
  readonly fallbackModel?: string;
  /** M62 §7: the primary that failed over to the fallback. */
  readonly fallbackFrom?: string;
  /** M70 §2: the identity of the model that ANSWERED this call (the
   *  provider's config model, or the fallback's name on a failover row).
   *  The loop's usage-anchor guards compare it against the client's
   *  `modelId` — an anchor reported by a different model than the current
   *  one describes a tokenizer/window that no longer applies, and is
   *  dropped. Omitted when unknown (scripted models, odd gateways). */
  readonly model?: string;
}

// What core sends to a model for one generation call.
export interface ModelInput {
  readonly systemPrompt: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ModelToolDefinition[];
  // Cooperative cancellation. Providers pass it to fetch; absent = today's behavior.
  readonly signal?: AbortSignal;
  // M24 usage channel — the ONLY way usage flows out of a provider call.
  // Observer-only: called at most once per call, after the final usage is
  // known; it never changes the returned AssistantMessage (whose shape stays
  // cache-stable) and a throwing callback is the caller's bug, not a signal.
  readonly onUsage?: (usage: ModelUsage) => void;
  /** M48 §2: terminal-shape repair audit. When a provider repairs a degenerate
   *  finish (reasoning-only, or a missing-reasoning tool turn under the replay
   *  contract) by resending the frozen request once, it names the kind here —
   *  BEFORE the replay. Observer-only, at most once per call. */
  readonly onTerminalRepair?: (kind: TerminalRepairKind) => void;
  /** M58 §C: per-request reasoning-effort override (e.g. the tier-2 summary
   *  call passing the session's effort through). Absent = the provider
   *  config's own effort (the main loop's requests stay byte-identical). */
  readonly reasoningEffort?: string;
  /** M70 §3 (the upstream format): the QuerySource tag — WHO is waiting on this call.
   *  Foreground sources (and untagged calls, the backward-compatible
   *  default) may retry on overload; BACKGROUND sources ("summarizer" — the
   *  compaction summarizer, "evaluator" — the /goal judge, "title" ...)
   *  bail immediately on overload-class failures: during a capacity cascade
   *  each retry is 3-10x gateway amplification and no human ever sees those
   *  failures. The allowlist itself lives in the provider retry ladder. */
  readonly querySource?: string;
  /** ω-2b (I1-b): per-request completion cap, following the reasoningEffort
   *  override pattern — the provider maps it onto the body's `max_tokens`,
   *  overriding ProviderConfig.maxTokens for THIS one call. `max_tokens` is
   *  a sampling parameter, not prompt bytes: changing it never touches the
   *  prefix-cached prefix (M24 safe by construction). Absent = the provider
   *  config's own cap (request bytes unchanged). */
  readonly maxTokens?: number;
}

// ---------------------------------------------------------------------------
// M58 §A — the context-overflow error contract at the port.
//
// Core stays provider-agnostic (it never imports a concrete provider), so the
// recognizable shape of a provider-classified context-overflow error is a DUCK
// TYPE documented here and produced at the provider boundary. When a provider
// sees HTTP 413, or a 400/500 whose body matches the context-length
// vocabulary, it throws an Error shaped:
//   name === "ContextLengthError"    (the recognizer below keys on this alone)
//   .status?: number                 (the HTTP status, when there was one)
//   .body?: string                   (the raw provider body, for diagnostics)
// The provider retry ladder must NOT retry it — an oversized prompt can never
// succeed on retry — and the loop reacts instead: compact once, retry the
// model call once, hard-error if it still overflows (loop.ts M58 §A).
// ---------------------------------------------------------------------------

/** The duck-typed shape providers stamp onto classified overflow errors. */
export interface ContextLengthErrorShape {
  readonly name: "ContextLengthError";
  readonly status?: number;
  readonly body?: string;
  /** ω-2b (I1-a): the TRUSTED-PARSE observation a provider managed to extract
   *  from the error body — the real prompt size and the real window. Set ONLY
   *  from pinned-signature numeric parses (see the providers package's
   *  parseContextLimitBody); a body without parseable numbers stays opaque
   *  and the field stays absent. Consumers (the loop's calibration + window
   *  learning + the clip-retry ladder) must treat it as ground truth when
   *  present and fall back to estimates when absent. */
  readonly observed?: {
    readonly promptTokens: number;
    readonly windowTokens: number;
  };
}

/** Recognize a provider-classified context-overflow error (see the contract
 * above). Duck-typed on `name` so any provider package can produce the shape
 * without a shared runtime class. */
export function isContextLengthError(err: unknown): err is Error & ContextLengthErrorShape {
  return err instanceof Error && err.name === "ContextLengthError";
}

// ---------------------------------------------------------------------------
// 113-B3 — the account-quota park error contract at the port.
//
// Core stays provider-agnostic (it never imports the providers package), so a
// provider that classifies an ACCOUNT-LEVEL quota 429 (HTTP 429 + the quota
// vocabulary + a parseable reset moment + a wait beyond the retry ladder's
// 60s fail cap) throws an Error shaped:
//   name === "QuotaParkError"      (the recognizer below keys on this alone)
//   .resetAt: Date                 (the parsed reset instant)
//   .provider?: string             (the failing leg's provider identity)
// The provider retry ladder must NOT retry it (hours-long window), and the
// loop must NOT spend its ω99-9 midstream recovery on it — replaying against
// a capped account is the "don't panic, don't retry" posture the park
// exists for. The error propagates to the HOST (the CLI driver), which parks
// the run until resetAt and schedules a one-shot wake (resume). The loop
// itself adds no TerminalReason value: a model-call throw exits the loop as
// an exception by construction, so the parked outcome is decided at the
// driver, next to every other error terminal.
// ---------------------------------------------------------------------------

/** The duck-typed shape providers stamp onto classified quota errors. */
export interface QuotaParkErrorShape {
  readonly name: "QuotaParkError";
  readonly resetAt: Date;
  readonly provider?: string;
}

/** Recognize a provider-classified account-quota error (see the contract
 * above). Duck-typed on `name` so any provider package can produce the shape
 * without a shared runtime class. */
export function isQuotaParkError(err: unknown): err is Error & QuotaParkErrorShape {
  return err instanceof Error && err.name === "QuotaParkError";
}

// ---------------------------------------------------------------------------
// F1 (clip-conflict) — the computed-cap/thinking-budget conflict contract at
// the port.
//
// The anthropic wire structurally requires max_tokens > thinking.budget_tokens
// (the budget reasoningEffort implies), and the provider boundary fails
// closed — BEFORE the wire — when an EXPLICIT cap sits at/below that budget
// (wire-r2 follow-up ①). Core's COMPUTED completion caps are context-budget
// arithmetic, not choices: the ω-2b admission clip and the ladder's
// clip-retry `physical` are both `window − occupancy − reserve`, and under a
// high effort (budget up to 32K) an armed clip is at/below the budget by
// construction. That failure is RECOVERABLE by compaction — a shorter prompt
// raises the computed cap — so the loop routes it through the same reactive
// compact ladder as an overflow instead of rethrowing it as a hard failure.
// A conflict on a cap core did NOT compute (a caller-chosen config cap) is
// deterministic and un-compactable; it keeps its fail-closed propagation.
//
// Core stays provider-agnostic (it never imports the providers package), so
// the recognizable shape is the duck-typed `code` string stamped at the
// provider boundary. The LITERAL's single source is this constant (the port
// side); providers stamp it by importing this constant, and the providers
// test suite pins the literal so a rename cannot silently break the seam.
// ---------------------------------------------------------------------------

/** The duck-typed stamp on a computed-cap/thinking-budget conflict error
 * (see the contract above). SCREAMING_SNAKE to read as a wire-style code,
 * distinct from the Error-builtin `name` the overflow contract uses. */
export const MAX_TOKENS_THINKING_BUDGET_CONFLICT_CODE = "MAXTOKENS_THINKING_BUDGET_CONFLICT";

/** Recognize a provider-thrown computed-cap/thinking-budget conflict (see
 * the contract above). Duck-typed on `code` alone. */
export function isMaxTokensThinkingBudgetConflict(err: unknown): boolean {
  return err instanceof Error && (err as { code?: unknown }).code === MAX_TOKENS_THINKING_BUDGET_CONFLICT_CODE;
}

// ---------------------------------------------------------------------------
// conflict-origin — the config-cap-conflict marker at the same port.
//
// The provider's fail-closed gate knows MORE than the conflict's code alone:
// it knows whether the caller-chosen PERSISTENT cap (config.maxTokens — the
// cap that survives clip-dropping AND compaction) also sits at/below the
// thinking budget. When it does, the reactive compact ladder is pre-doomed:
// the post-compact resend's cap resolves back to that config cap and
// re-conflicts before the wire, so the full compact (a summarizer model
// call) is burned for nothing. The marker rides the SAME typed conflict the
// code seam above already carries; the loop reads it BEFORE routing and
// keeps the typed fail-closed propagation directly. Core stays
// provider-agnostic exactly as above — the FIELD NAME's single source is
// this constant (providers declare the class field under the computed name,
// so a value/name drift goes loud in the pin suites on BOTH sides, never
// silently unfixed). An error without the marker (absent or false) routes
// exactly as it did before the marker existed.
// ---------------------------------------------------------------------------

/** The duck-typed field name a provider stamps the config-cap-conflict
 *  marker under (see the contract above). */
export const CONFIG_CAP_ALSO_CONFLICTS_FIELD = "configCapAlsoConflicts";

/** True when a computed-cap/thinking-budget conflict error also carries the
 *  marker that the persistent config cap conflicts — the compact ladder
 *  cannot recover it, so the loop must not burn it. Duck-typed on the
 *  marker field alone, `=== true` (absent/false both read as no marker). */
export function hasConfigCapConflict(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as unknown as { readonly [key: string]: unknown })[CONFIG_CAP_ALSO_CONFLICTS_FIELD] === true
  );
}

/** The two degenerate finish shapes M48 §2 repairs (Reasonix pair). */
export type TerminalRepairKind = "reasoning-only" | "missing-reasoning";

// A streaming event emitted by ModelClient.stream. The loop prefers `stream`
// when present and forwards text_delta events live as `assistant_delta` and
// reasoning_delta events live as `reasoning_delta`. A stream MUST end with
// exactly one "done" carrying the authoritative final AssistantMessage (the
// aggregated text + any tool calls, and accumulated reasoning if any).
export type ModelStreamEvent =
  | { type: "reasoning_delta"; text: string }
  | { type: "text_delta"; text: string }
  | { type: "done"; message: AssistantMessage };

// The provider port owned by core. Adapters (OpenAI-compatible, Wudao, DeepSeek, ...)
// implement this at the HTTP boundary. Core never imports a concrete provider.
export interface ModelClient {
  generate(input: ModelInput): Promise<AssistantMessage>;
  // Optional streaming. When present, the loop uses it and emits assistant_delta
  // events. Absent on the deterministic scripted model, so tests/demos fall back
  // to generate and remain unchanged.
  stream?(input: ModelInput): AsyncGenerator<ModelStreamEvent>;
  /** M70 §2: the client's primary model identity (e.g. the provider config's
   *  model name). The loop's usage-anchor guard (a) compares it against the
   *  answering model on each usage row — a mid-stream model switch (the M62 §7
   *  fallback chain answers under a sibling name) invalidates the anchor.
   *  Optional: untagged clients keep the status-quo anchoring. */
  readonly modelId?: string;
}

// Deterministic, script-driven model for tests/demos (no network, no API key).
// Returns responses[i] on the i-th generate() call.
// 128-2: querySource==="prewarm" calls (the resume prewarm's discarded probe)
// never consume the script — they return a canned one-token reply instead,
// mirroring the real lane's throwaway semantics (a prewarm stealing the next
// scripted reply broke every resume-then-run test).
export function createScriptedModel(
  responses: readonly AssistantMessage[],
): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      if (input.querySource === "prewarm") {
        return { role: "assistant", content: "" };
      }
      const response = responses[calls];
      if (!response) {
        throw new Error("scripted responses exhausted");
      }
      calls += 1;
      return response;
    },
  };
}

// ---------------------------------------------------------------------------
// 120-a A2 (the upstream format #6540 形) — the summary-call prefix-freeze contract.
// A summary/review-class call is supposed to be "the parent turn's request
// bytes + a declared tail": same system prompt, same tool-table bytes, a
// leading slice of the parent's messages, and the session's reasoning tier.
// the upstream's live incident: a 219K-token compaction-summary call silently
// DROPPED its reasoning tier and hit 0% prefix cache — nothing red anywhere.
// This pure comparator is the contract's single enforcement point (the
// createScriptedModel family: test-support, zero runtime reach). A probe
// that observes live cache-hit drift is a LATER arc — this only pins shape.
// ---------------------------------------------------------------------------

/** What one family member promises about its request shape. */
export interface PrefixFreezeContract {
  /** The member's census name ("autocompact summarizer", "reflection
   *  challenger"…) — rides every drift line so the failure names WHO. */
  readonly label: string;
  /** How many TRAILING messages the member appends after the frozen prefix
   *  (the declared tail: the summary instruction, the challenger brief). */
  readonly tailCount: number;
  /** The session's declared reasoning effort — the tier BOTH the parent turn
   *  and the member's call must resolve to on the wire. The parent turn's
   *  ModelInput never carries the override (the provider config applies it
   *  there); the member's call carries it as ModelInput.reasoningEffort —
   *  so this field pins the CHILD's override, the exact spot the upstream format
   *  #6540 lost. Undefined = neither side declares (deliberate omission is
   *  itself part of the contract). */
  readonly expectedEffort?: string;
}

/** Pure diff: the fields where `child` drifted from the frozen
 * `parent prefix + declared tail` shape. Empty array = frozen. Every line
 * NAMES the drifted field (break attribution: which field, which message
 * index) so a red test reports the cause, not just the fact. Byte
 * comparisons go through the ONE canonical serializer (key-order stable). */
export function summaryPrefixDrift(
  parent: ModelInput,
  child: ModelInput,
  contract: PrefixFreezeContract,
): string[] {
  const drift: string[] = [];
  const { label, tailCount, expectedEffort } = contract;
  if (child.systemPrompt !== parent.systemPrompt) {
    drift.push(`systemPrompt: ${label} drifted from the parent turn's — the prefix cache is lost from byte 0`);
  }
  if (canonicalJson(child.tools) !== canonicalJson(parent.tools)) {
    drift.push(`tools: ${label} tool-table bytes differ from the parent turn's — the tool block sits above the message prefix, the whole cache is lost`);
  }
  const keptCount = child.messages.length - tailCount;
  if (keptCount < 1 || keptCount > parent.messages.length) {
    drift.push(
      `messages: ${label} carries ${child.messages.length} message(s) against ${tailCount} declared tail(s) and a ${parent.messages.length}-message parent — not a parent-prefix + declared-tail shape`,
    );
  } else {
    for (let i = 0; i < keptCount; i += 1) {
      if (canonicalJson(child.messages[i]) !== canonicalJson(parent.messages[i])) {
        drift.push(`messages[${i}]: ${label} replayed message #${i} differs from the parent turn's — the prefix cache is lost from message ${i}`);
        break;
      }
    }
  }
  const childEffort = child.reasoningEffort === "" ? undefined : child.reasoningEffort;
  if (childEffort !== expectedEffort) {
    drift.push(
      `reasoningEffort: ${label} carries ${JSON.stringify(childEffort ?? null)} where the session declares ${JSON.stringify(expectedEffort ?? null)} — request-param drift (the upstream format #6540: the dropped tier cost a 219K-token summary call its entire prefix cache)`,
    );
  }
  return drift;
}
