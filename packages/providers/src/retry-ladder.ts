// 拆分运动 C：从 openai-compatible.ts 原样外提的重试梯子 + 失败分类域
//（M26 P11 梯子本体、M58 §A 上下文溢出分类、M70 §3/§4、梯子判定族）。
// 本模块零 openai-compatible 依赖（无环）；openai-compatible.ts 逐名 re-export
// 保公共面（anthropic/responses/tests/index 既有导入方零演进）。
import { findProxyEgressCause, probeModelRetry, truncateSafe } from "@wudao/core";
import type { ModelInput } from "@wudao/core";
import type { ProviderConfig } from "./config.js";
import { BackgroundOverloadError, ContextLengthError, ProviderHttpError } from "./model-failure.js";
import type { ReasoningMandatoryError } from "./model-failure.js";
import { RETRY_AFTER_FAIL_CAP_MS } from "./retry-after.js";

// ---------------------------------------------------------------------------
// Retry ladder (M26 P11).
//
// A tiny exponential-backoff ladder wrapped around every provider attempt
// (generate AND stream). Triggers: transport failures (fetch reject other
// than AbortError, truncated/SSE-breaking bodies) and the overloaded-status
// set 429/500/502/503/529 — 529 counted whether it arrives as the status or
// folded into the message string. Never triggers for other 4xx, AbortError,
// or argument errors (a 400 carrying the provider's complaint). Backoff is
// 500ms × 2ⁿ ± 25% jitter, capped at 32s, default 4 retries
// (WUDAO_MAX_RETRIES). Every retry announces itself through onRetry(n,
// delayMs, reason) so the loop/CLI can surface `↻ retry 1 (429) in 0.5s`.
// Streaming retries happen ONLY before the first yielded delta — replaying
// after partial output would duplicate it, so a post-delta break is thrown
// to the loop's error path instead.
// ---------------------------------------------------------------------------

/** Observability callback: attempt number (1-based), wait before it, why. */export type RetryObserver = (n: number, delayMs: number, reason: string) => void;

export interface RetryLadderOptions {
  /** Additional attempts after the first; default 4 (env WUDAO_MAX_RETRIES). */
  readonly maxRetries?: number;
  /** First wait, ms; default 500. */
  readonly baseDelayMs?: number;
  /** Wait cap, ms; default 32_000. */
  readonly maxDelayMs?: number;
  /** Jitter fraction around the scheduled wait; default 0.25 (±25%). */
  readonly jitterRatio?: number;
  /** Injectable randomness (tests); default Math.random. */
  readonly random?: () => number;
  /** Injectable sleep (tests); default setTimeout-based. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly onRetry?: RetryObserver;
  /** M47 §7: first wait for OVERLOAD-class failures, ms; default 2_000. The
   *  overload branch never rotates keys — same key, longer doubling ladder. */
  readonly overloadBaseDelayMs?: number;
  /** M70 §3: the call's QuerySource (threaded from ModelInput.querySource).
   *  A background source never retries an overload-class failure — it bails
   *  immediately with BackgroundOverloadError (see the allowlist block). */
  readonly querySource?: string;
  /** 121 项 1（a reference harness 498490680 形）— 容量观察者：catch 里判定为
   *  overload-class（isOverloadClassFailure：429/503/529/overload 体）时同
   *  步发射一次——无论该失败随后走重试、后台 bail 还是重抛。纯观察：绝不
   *  影响梯子自身的任何决策；部署层把它接到 AIMD 并发门的 onThrottle，
   *  429 就从「人肉调参」变成「容量信号」。每个 overload 尝试各发一次
   *  （同一次调用连续 4 个 429 = 4 次——每一次都是真实的容量证据）。 */
  readonly onOverload?: () => void;
  /** 124 项 2 — the network-outage grace window. When enabled, network-class
   *  failures (isNetworkClassFailure — fetch reject, DNS, socket hang up,
   *  network timeouts; NOT 4xx/5xx business errors) widen the ladder:
   *  effective retries = maxRetries × retryMultiplier (default ×3 = 12),
   *  single-wait cap bumps to maxDelayMsMs (default 5min). 4xx/5xx keep the
   *  exact pre-grace semantics. Opt-in; off by default. */
  readonly networkGrace?: {
    readonly enabled?: boolean;
    readonly retryMultiplier?: number;
    readonly maxDelayMsMs?: number;
    /** Fires the FIRST time a failure inside the grace window is classified
     *  as network-class — the UI seam for "网络似乎不稳定——正在耐心重试
     *  (最长 N 分钟)". One-shot per retry-lifetime (idempotent). */
    readonly onEnter?: () => void;
  };
}

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_OVERLOAD_BASE_DELAY_MS = 2_000;
const DEFAULT_MAX_DELAY_MS = 32_000;
const DEFAULT_JITTER_RATIO = 0.25;

// 124 项 2 — fatal TLS codes are referenced from the network-grace detector
// above; declare them here (used to be local to isRetryableProviderError —
// hoisted so the grace classifier can rely on the same set with one source
// of truth).
const FATAL_TLS_CODES: ReadonlySet<string> = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_CERTIFICATE_ALT_NAME_INVALID",
]);

// ---------------------------------------------------------------------------
// 124 项 2 — the network-outage grace window. The exponential ladder is tuned
// for transient blips (429/5xx micro-windows); a Wi-Fi drop / router reboot /
// late-night connectivity loss exceeds it and would let the run fail after
// ~32s × 4 = ~3min of dead time. The grace window ONLY widens the ladder
// for NETWORK-class failures (fetch reject / DNS / socket hang / TLS-not-fatal
// timeouts — undici surfaces all of these as TypeError("fetch failed") with
// the real cause on .cause); 4xx/5xx/business-5xx-validation errors keep
// the existing ladder unchanged. The window's wait is the same exponential
// shape (maxDelayMs bumped from 32s → 5min), the retry count is multiplied
// (default × 3 = 12); the onRetry / onOverload hooks fire as usual (the CLI
// notices remain byte-stable). Opt-in via retry.networkGrace.enabled so the
// default behavior never changes.
// ---------------------------------------------------------------------------

/** The transport-class failure predicates used by both isRetryableProviderError
 *  and the grace window's widener. A failure qualifies as NETWORK when:
 *   • it is NOT a ProviderHttpError (4xx/5xx are business-class and must NEVER
 *     enter the grace window),
 *   • it is not a typed ContextLengthError / QuotaParkError / fatal TLS /
 *     proxy-attributed / request-validation failure (deterministic),
 *   • it carries the fetch failure vocabulary (TypeError("fetch failed") and
 *     friends) — same family as the existing transport retry path.
 *  Pinned regex over the message AND the .cause chain (undici wraps twice:
 *     TypeError("fetch failed") → cause Error("socket hang up") → …);
 *  duck-typed cause-walking mirrors the fatal-TLS detector above. */
const NETWORK_FETCH_RE = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|network timeout/i;
const MAX_CAUSE_DEPTH = 4;

function hasFatalTlsCode(err: unknown): boolean {
  // Reuses the existing FATAL_TLS_CODES set (declared below in the file) by
  // walking the same depth-capped cause chain — a network fetch reject with
  // a fatal TLS cause is DETERMINISTIC, never worth the grace window.
  if (!(err instanceof Error)) return false;
  let cur: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    const code = (cur as { code?: unknown })?.code;
    if (typeof code === "string" && FATAL_TLS_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown })?.cause;
    if (cur === undefined || cur === null) return false;
  }
  return false;
}

/** True iff `err` looks like a transient network-class failure (NOT a
 *  business-class HTTP error and NOT a deterministic fetch failure). */
export function isNetworkClassFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Business-class HTTP errors never enter the grace window — a 4xx/5xx
  // body is the provider's answer, not the network's silence.
  if (err instanceof ProviderHttpError) return false;
  // Deterministic typed failures refuse to wait.
  if (err.name === "AbortError") return false;
  if (err.name === "ContextLengthError") return false;
  if (err.name === "QuotaParkError") return false;
  if (err.name === "ReasoningMandatoryError" && !(err as ReasoningMandatoryError).repairable) return false;
  if (err.name === "UnsupportedContentError") return false;
  if (err.name === "HeaderValidationError") return false;
  if (err.name === "ProxyEgressError" || findProxyEgressCause(err) !== undefined) return false;
  // Fatal TLS is deterministic on this endpoint.
  if (hasFatalTlsCode(err)) return false;
  // Walk the message AND cause chain (depth-capped like the TLS detector).
  let cur: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (cur instanceof Error && NETWORK_FETCH_RE.test(cur.message)) return true;
    cur = (cur as { cause?: unknown })?.cause;
    if (cur === undefined || cur === null) return false;
  }
  return false;
}

export const DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER = 3;
export const DEFAULT_NETWORK_GRACE_MAX_DELAY_MS = 5 * 60_000;

/** Statuses that mean "try again later", not "your request was wrong". */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 529]);

// ---------------------------------------------------------------------------
// M58 §A — context-overflow classification (413 reactive layer). Providers
// disagree on how they say "your prompt does not fit the window": HTTP 413,
// or a 400/500 whose body carries the context-length vocabulary. Every one
// of those is classified into the typed ContextLengthError (the duck-typed
// port contract documented on core's isContextLengthError) at the HTTP
// boundary, BEFORE the generic ProviderHttpError — so the retry ladder never
// retries an oversized prompt and the loop can react (compact, retry once).
// ---------------------------------------------------------------------------

/** The context-length body vocabulary, vendor-anchored. */
export const CONTEXT_LENGTH_BODY_SIGNATURES: readonly RegExp[] = [
  // The spec-pinned generic wording: "context length exceeded" and friends.
  // Covers OpenAI / DeepSeek / vLLM-hosted endpoints (400): "This model's
  // maximum context length is 65536 tokens. However, you requested 109645
  // tokens …" — and Qwen/DashScope: "The input content (including
  // conversation history and code context) exceeds the model's maximum
  // context length."
  /context length/i,
  // zhipu/bigmodel 1214 (400) — English docs wording: "… parameter is
  // invalid. Prompt too long"
  /prompt\s+too\s+long/i,
  // zhipu/bigmodel 1214 (400) — the Chinese body: "messages 参数非法。 Prompt 超长"
  /prompt\s*超长/i,
];

// 120-b B2 (Reasonix #10770) — the GLM/vLLM/SiliconFlow prose family. Live
// bodies say "Input length 1048826 exceeds the maximum length 1048566" (400):
// NO "context length" vocabulary anywhere, so every signature above misses it
// and the overflow fell through to a generic 400 "Malformed request" — the
// 413 reactive layer never ran. Deliberately NOT a CONTEXT_LENGTH_BODY_
// SIGNATURES entry: the family carries a strictness invariant a bare
// regex.test cannot express — the input figure must EXCEED the maximum
// (N > M). An equal-or-smaller pair worded like an overflow stays
// unclassified/OPAQUE (a body that says "exceeds" while its own numbers say
// otherwise must never trigger compact-and-retry). The matcher below drives
// BOTH halves, classification and trusted parse, under that one invariant.
/** "input length N exceeds [the] maximum [context] length M" — N and M are
 * literal token counts; the gap tolerators keep "the"/extra spaces; the
 * optional "context" admits the "maximum context length" spelling (which the
 * generic /context length/i signature already classifies — there the pair
 * only feeds the trusted parse). */
export const CONTEXT_LIMIT_INPUT_LENGTH_RE =
  /\binput\s+length\s+(\d+)\D{1,80}?exceeds\D{1,80}?maximum(?:\s+context)?\s+length\s+(\d+)\b/i;

/** The parsed (inputTokens, maximumLength) pair when the body carries the
 * GLM/vLLM spelling AND the strictness invariant holds (input > maximum,
 * both finite and positive); undefined for every near-miss — numberless
 * ("Input length is too long"), equal, or inverted pairs. */
export function matchContextLimitInputLength(
  body: string,
): { inputTokens: number; maximumLength: number } | undefined {
  const m = CONTEXT_LIMIT_INPUT_LENGTH_RE.exec(body);
  if (m === null) return undefined;
  const inputTokens = Number(m[1]);
  const maximumLength = Number(m[2]);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(maximumLength) || inputTokens <= 0 || maximumLength <= 0) {
    return undefined;
  }
  if (inputTokens <= maximumLength) return undefined; // strictness: N > M or OPAQUE
  return { inputTokens, maximumLength };
}

/** True when a response body carries a known context-length signature. */
export function sniffContextLengthBody(body: string): boolean {
  // The strict GLM/vLLM matcher joins the loose vocabulary table here — the
  // only place classification consults it (single source of truth for both
  // halves of the family).
  return CONTEXT_LENGTH_BODY_SIGNATURES.some((re) => re.test(body)) || matchContextLimitInputLength(body) !== undefined;
}

/** True iff the status/body pair means "the prompt does not fit the window":
 * HTTP 413 outright, or a 400/500 whose body carries the vocabulary above. */
export function isContextLengthFailure(status: number, body: string): boolean {
  return status === 413 || ((status === 400 || status === 500) && sniffContextLengthBody(body));
}

// ---------------------------------------------------------------------------
// ω-2b (I1-a) — the trusted context-limit body parse. A body that already
// CLASSIFIED as a context-length failure (the pinned signature regexes above)
// may carry the two numbers the loop needs to react precisely instead of
// compacting blind: the real window and the real requested size. Parse is
// deliberately conservative — only the pinned spellings below produce an
// observation, everything else (zhipu's numberless "Prompt too long" / "Prompt
// 超长", a bare 413 "payload too large", junk) stays OPAQUE (undefined) and the
// loop falls back to its char estimates.
// ---------------------------------------------------------------------------

/** The DeepSeek / vLLM / OpenAI prose pair: "This model's maximum context
 * length is 65536 tokens. However, you requested 109645 tokens …" — window
 * then total request (prompt + the max_tokens the request carried, or the
 * provider's auto-allocated completion budget when it carried none). */
const CONTEXT_LIMIT_PROSE_RE = /maximum context length is (\d+) tokens\D{0,120}?you requested (\d+) tokens/i;

/** Parse a classified context-length body for the observed (promptTokens,
 * windowTokens) pair. `maxTokens` is the completion cap THIS request carried
 * (the effective one — a per-input override beats the config's): the prose
 * "you requested M" counts prompt + completion, so the prompt is M − maxTokens
 * when a cap was sent; without one the provider auto-allocated a completion
 * budget and counted it against the request, so M itself is the conservative
 * prompt figure (over-counting is the safe direction for the clip ladder).
 * Undefined when either number is missing or unparseable — trusted-parse-only. */
export function parseContextLimitBody(
  body: string,
  maxTokens?: number,
): { promptTokens: number; windowTokens: number } | undefined {
  const prose = CONTEXT_LIMIT_PROSE_RE.exec(body);
  if (prose !== null) {
    const windowTokens = Number(prose[1]);
    const requested = Number(prose[2]);
    if (!Number.isFinite(windowTokens) || !Number.isFinite(requested) || windowTokens <= 0 || requested <= 0) {
      return undefined;
    }
    const promptTokens = maxTokens !== undefined && requested > maxTokens ? requested - maxTokens : requested;
    return { promptTokens, windowTokens };
  }
  // 120-b B2: the GLM/vLLM spelling — vLLM's "input length" counts PROMPT
  // tokens only (no completion budget folded in), so the figure is the
  // promptTokens observation as-is and the request's max_tokens cap plays no
  // decomposition role. windowTokens is the endpoint's configured maximum
  // model length.
  const glm = matchContextLimitInputLength(body);
  if (glm !== undefined) {
    return { promptTokens: glm.inputTokens, windowTokens: glm.maximumLength };
  }
  // The JSON/structured spelling: the same pair the max_tokens self-repair
  // parses (input_tokens + context_limit) — but here it rides a body that
  // already classified as context-length (the two vocabularies are disjoint
  // in practice; where they overlap, the numbers are the same truth).
  const parsed = parseMaxTokensOverflow(body);
  if (parsed === undefined) return undefined;
  return { promptTokens: parsed.inputTokens, windowTokens: parsed.contextLimit };
}

// ---------------------------------------------------------------------------
// M70 §4 (CC) — max_tokens overflow self-repair. A 400 whose body carries
// parseable input_tokens/context_limit numbers (WITHOUT the context-length
// vocabulary — that classifies as ContextLengthError and belongs to the
// loop's compact-and-retry) means the COMPLETION cap pushed the total over
// the window while the prompt itself fits: parse the numbers, set
// retryContext.maxTokensOverride, and retry ONCE with the reduced cap.
// ---------------------------------------------------------------------------

/** Prose + JSON spellings of the two numbers, across vendors. */
const INPUT_TOKENS_RE = /input_tokens\D{0,24}?(\d+)/i;
const CONTEXT_LIMIT_RE = /(?:context_limit|maximum_context_length|context_window|maximum_context_window)\D{0,24}?(\d+)/i;

/** Parse a 400 body for the (inputTokens, contextLimit) pair; undefined when
 * EITHER number is missing or unparseable. */
export function parseMaxTokensOverflow(body: string): { inputTokens: number; contextLimit: number } | undefined {
  const input = INPUT_TOKENS_RE.exec(body)?.[1];
  const limit = CONTEXT_LIMIT_RE.exec(body)?.[1];
  if (input === undefined || limit === undefined) return undefined;
  const inputTokens = Number(input);
  const contextLimit = Number(limit);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(contextLimit) || inputTokens <= 0 || contextLimit <= 0) return undefined;
  return { inputTokens, contextLimit };
}

/** The repaired completion cap: max(3000, contextLimit - inputTokens - 1000,
 * thinkingBudget + 1). No thinking budget is configured today (0 — the term
 * is CC's forward-looking floor: a thinking-capable model must keep at least
 * budget+1 tokens or the request fails for a different reason). */
export function selfRepairMaxTokensValue(
  parsed: { inputTokens: number; contextLimit: number },
  thinkingBudget = 0,
): number {
  return Math.max(3_000, parsed.contextLimit - parsed.inputTokens - 1_000, thinkingBudget + 1);
}

/** True when the error is a 400 the self-repair can parse (the retry-once
 * trigger; everything else keeps its existing path). */
export function isMaxTokensOverflow400(err: unknown): err is ProviderHttpError {
  return err instanceof ProviderHttpError && err.status === 400 && parseMaxTokensOverflow(err.body) !== undefined;
}

/** ω-2b (I1-a): classify + stamp in one step — the trusted-parse observation
 *  rides the typed error when the body carried the numbers. The effective
 *  completion cap (per-input maxTokens override beats the config's) decides
 *  how the prose figures decompose into a prompt size. */
export function classifyContextLength(
  status: number,
  detail: string,
  config: ProviderConfig,
  input: ModelInput,
): ContextLengthError {
  return new ContextLengthError(status, detail, parseContextLimitBody(detail, input.maxTokens ?? config.maxTokens));
}

// ---------------------------------------------------------------------------
// M70 §3 (CC) — the foreground-only retry allowlist. API calls are classified
// by whether a HUMAN is blocking on the result (ModelInput.querySource):
// sources in FOREGROUND_QUERY_SOURCES — and untagged calls, the backward-
// compatible default — walk the ordinary ladder on overload; every OTHER
// source (the compaction summarizer, the /goal evaluator, title generators)
// bails immediately with the typed BackgroundOverloadError. During a
// capacity cascade each background retry is 3-10x gateway amplification and
// the user never sees those failures — the cheapest highest-leverage place
// to shed load. Overload-SCOPED: background 500s and transport blips keep
// the ordinary ladder.
// ---------------------------------------------------------------------------

/** The QuerySource allow-set that may retry on overload. Untagged calls are
 *  foreground by default (every pre-M70 caller keeps today's behavior).
 *  ω99-8b: "subagent" joins — core's runSubagent stamps child calls, and the
 *  waiting parent (often blocking a human) is foreground; leaving the tag out
 *  would silently demote child overload failures to background bail-out, a
 *  behavior change beyond ω99-8b's cost-partitioning scope. */
export const FOREGROUND_QUERY_SOURCES: ReadonlySet<string> = new Set(["agent", "subagent"]);

/** True when the failure means "the gateway is out of capacity": the
 *  overload-status family (429 / 503 / 529, including a 529 folded into the
 *  message body) or a 429 whose body sniffs as fleet overload. */
export function isOverloadClassFailure(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError)) return false;
  return err.status === 429 || err.status === 503 || err.status === 529 || err.overload || /\b529\b/.test(err.message);
}

/** True when this (source, error) pair must NOT be retried: a background
 *  query hitting an overload-class failure. */
function isBackgroundNoRetry(querySource: string | undefined, err: unknown): boolean {
  return querySource !== undefined && !FOREGROUND_QUERY_SOURCES.has(querySource) && isOverloadClassFailure(err);
}

/** The typed SSE line-buffer overflow abort (r1b). A live stream that keeps
 *  delivering bytes but never emits a line/event boundary grows the line
 *  buffer without bound — a hole the idle watchdog cannot catch (every read
 *  resolves on time; the stream never goes quiet). Fail-loud, NEVER truncate:
 *  slicing an SSE line mid-event would fabricate garbage events downstream.
 *  Same ladder family as StreamIdleError: retryable transport class (the
 *  replay is byte-identical, the prefix cache is unaffected). */
export class StreamOverflowError extends Error {
  readonly maxChars: number;

  constructor(maxChars: number) {
    super(`sse line buffer exceeded ${maxChars} chars without an event boundary — stream overflow abort`);
    this.name = "StreamOverflowError";
    this.maxChars = maxChars;
  }
}

/** ω99-44 (pi ebc374490): the typed EOF-without-terminal abort. The stream
 *  ended CLEANLY (read → done, no transport error) but no finish/stop
 *  semantics ever arrived — byte-indistinguishable from a proxy EOF cut, so
 *  it fails LOUD instead of completing: a synthetic done would lose
 *  finish_reason (blinding the M70 stop-reason/truncated-tool-call guard),
 *  lose usage (the metering row), and feed empty completions into the
 *  zero-output heuristics. Attribution: which adapter's wire, and how many
 *  payload bytes arrived before the cut (the shared-sseDataLines consumers
 *  count decoded data-line chars — attribution granularity, not an exact
 *  wire count). Same ladder family as StreamIdleError/StreamOverflowError:
 *  retryable transport class — the pre-first-delta replay is byte-identical
 *  (prefix-cache safe); a post-delta cut propagates to the loop untouched
 *  (the ω99-9 midstream-recovery surface). */
export class TruncatedStreamError extends Error {
  readonly provider: string;
  readonly sawBytes: number;

  constructor(provider: string, sawBytes: number) {
    super(`stream ended without a terminal event (provider=${provider}, sawBytes=${sawBytes}) — truncated by the gateway or connection`);
    this.name = "TruncatedStreamError";
    this.provider = provider;
    this.sawBytes = sawBytes;
  }
}

/** Overload-class predicate for the ladder branch (and callers rendering
 *  retry state): true only for the 429+signature pair. */
export function isOverloadError(err: unknown): boolean {
  return err instanceof ProviderHttpError && err.overload;
}

/** WUDAO_MAX_RETRIES (integer ≥ 0); falls back to the default on junk. */
export function defaultMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.WUDAO_MAX_RETRIES;
  if (raw === undefined || raw === "") return DEFAULT_MAX_RETRIES;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_MAX_RETRIES;
}

/** Scheduled wait for the n-th retry (0-based): 500ms × 2ⁿ, capped, jittered. */
export function backoffDelayMs(attempt: number, opts: Pick<RetryLadderOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio" | "random"> = {}): number {
  const base = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const cap = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const jitterRatio = opts.jitterRatio ?? DEFAULT_JITTER_RATIO;
  const random = opts.random ?? Math.random;
  const scheduled = Math.min(base * 2 ** attempt, cap);
  return Math.max(0, scheduled * (1 + jitterRatio * (random() * 2 - 1)));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ω99-315: duck-typed StreamIdleError recognizer (name-keyed like every
 *  other ladder classification — the class lives in stream-idle.ts but the
 *  ladder treats it as a wire-level vocabulary, not a JS instanceof). */
function isStreamIdleError(err: unknown): boolean {
  return err instanceof Error && err.name === "StreamIdleError";
}

/** The provider's own failure vocabulary, compact enough for a status line.
 *  M47 §7: overload-class failures name their class ("overload") so the UI
 *  can say WHY the wait is long — everything else keeps the status word. */
function retryReason(err: unknown): string {
  if (isOverloadError(err)) return "overload";
  // ω99-42: the repair retry renders as its own reason, not a bare "400".
  if (err instanceof Error && err.name === "ReasoningMandatoryError") return "reasoning-mandatory";
  if (err instanceof Error) {
    const status = /^provider (?:request|stream) failed: (\d{3})/.exec(err.message)?.[1];
    if (status !== undefined) return status;
    return truncateSafe(err.message.split("\n")[0] ?? "", 80) || "error"; // 113-A4
  }
  return "error";
}

/** The overload branch's wait (M47 §7): same doubling/cap/jitter shape as the
 *  generic ladder, but from the 2s overload base — a fleet-wide signal earns a
 *  longer first pause than a per-key rate limit. Same key, never rotate. */
export function overloadBackoffDelayMs(
  attempt: number,
  opts: Pick<RetryLadderOptions, "overloadBaseDelayMs" | "baseDelayMs" | "maxDelayMs" | "jitterRatio" | "random"> = {},
): number {
  return backoffDelayMs(attempt, {
    baseDelayMs: opts.overloadBaseDelayMs ?? opts.baseDelayMs ?? DEFAULT_OVERLOAD_BASE_DELAY_MS,
    ...(opts.maxDelayMs !== undefined ? { maxDelayMs: opts.maxDelayMs } : {}),
    ...(opts.jitterRatio !== undefined ? { jitterRatio: opts.jitterRatio } : {}),
    ...(opts.random !== undefined ? { random: opts.random } : {}),
  });
}

/** Should this error walk the ladder? True for transport failures and the
 *  overloaded-status set; false for other 4xx, AbortError, context-length
 *  overflows (M58 §A — an oversized prompt can never succeed on retry), and
 *  semantic response-contract breaks (missing message shapes). */
/** Walk the `.cause` chain (bounded — cycles defensively impossible, but
 *  depth-capped anyway) for a fatal TLS code. */
function hasFatalTlsCause(err: unknown, depth = 0): boolean {
  if (!(err instanceof Error) || depth > 4) return false;
  if (FATAL_TLS_CODES.has((err as { code?: unknown }).code as string)) return true;
  return hasFatalTlsCause((err as { cause?: unknown }).cause, depth + 1);
}

/** 波次 8 #46 (hermes #12): the request-validation body vocabulary. */
const REQUEST_VALIDATION_BODY_SIGNATURES: readonly RegExp[] = [
  /unknown parameter/i,
  /unsupported parameter/i,
  /unrecognized request argument/i,
  /invalid_request_error/i,
  /unknown_parameter/i,
  /unsupported_parameter/i,
];

/** True when a failure body carries a known request-validation signature. */
function sniffRequestValidationBody(body: string): boolean {
  return REQUEST_VALIDATION_BODY_SIGNATURES.some((re) => re.test(body));
}

export function isRetryableProviderError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (err.name === "ContextLengthError") return false;
  // 113-B3: an account-level quota window is park material, not ladder
  // material — every rung would hammer an account the provider just said is
  // capped for hours. Named explicitly (same family as ContextLengthError)
  // so a future tightening of the fall-through below can never silently
  // re-classify it.
  if (err.name === "QuotaParkError") return false;
  // ω99-42: the typed mandatory-reasoning rejection rides the ladder ONLY in
  // its repairable flavor — the retry is the repair (re-send with reasoning
  // enabled, messages bytes untouched) and consumes one ladder slot. The
  // terminal flavor (explicit user "none" / repair already tried / a format
  // that cannot express enablement) fails fast like every deterministic 400.
  if (err.name === "ReasoningMandatoryError") return (err as ReasoningMandatoryError).repairable;
  // ω99-44: an EOF-without-terminal cut is transport-class — the replayed
  // request is byte-identical (prefix-cache safe). Named explicitly so a
  // future tightening of the fall-through below can never silently
  // de-classify it (same family as StreamIdleError/StreamOverflowError).
  if (err.name === "TruncatedStreamError") return true;
  // ω99-46: a proxy-attributed egress failure (typed ProxyEgressError in the
  // cause chain — the global dispatcher's attribution arm) is DETERMINISTIC
  // for this process: the ladder cannot heal a dead or refusing proxy, and
  // every retry would burn backoff to reach the same named host:port. Fail
  // fast with the attribution intact; the model-fallback chain (a different
  // endpoint through the same egress) still runs.
  if (err.name === "ProxyEgressError" || findProxyEgressCause(err) !== undefined) return false;
  // M79: a capability/role violation can never succeed on retry.
  if (err.name === "UnsupportedContentError") return false;
  // ω99-50: an unrepresentable persona header is deterministic — the same
  // bytes fail on every attempt. Fail fast (validatedInputEffort's M58 §C
  // discipline); the model-fallback chain skips it too (isModelFallbackEligible).
  if (err.name === "HeaderValidationError") return false;
  // 波次 8 #44 (hermes #12 ssl_cert_verification): a TLS certificate failure
  // is DETERMINISTIC — the same handshake replays the same verification
  // error, so retrying the same endpoint burns the whole ladder for nothing
  // (and, on proxies, every extra TLS handshake is another slow failure).
  // undici surfaces fetch rejects as TypeError("fetch failed") with the real
  // cause one or more `.cause` hops down. Fail fast; the model-fallback chain
  // (a DIFFERENT endpoint) is the correct escape, and it still runs.
  if (hasFatalTlsCause(err)) return false;
  // Some gateways fold 529 (overloaded) into the body instead of the status.
  const mentions529 = /\b529\b/.test(err.message);
  const status = /^provider (?:request|stream) failed: (\d{3})/.exec(err.message)?.[1];
  if (status !== undefined) {
    if (RETRYABLE_STATUSES.has(Number(status))) {
      // 波次 8 #46 (hermes #12): some OpenAI-compatible gateways return
      // DETERMINISTIC request-validation errors with a 5xx status — the
      // generic "5xx → retryable" rule then hammers the identical rejection
      // once per ladder slot. When the body carries one of these unambiguous
      // validation signals, the request is malformed and every retry gets
      // the same answer: fail fast. The model-fallback chain (a DIFFERENT
      // endpoint) is the correct escape, and it still runs. Hermes' proven
      // six patterns, verbatim family. (The context-length family never
      // reaches here: those classify into the typed ContextLengthError at
      // the HTTP boundary, which already returned false above.)
      if (Number(status) >= 500 && sniffRequestValidationBody(err instanceof ProviderHttpError ? err.body : err.message)) {
        return false;
      }
      return true;
    }
    return mentions529;
  }
  if (mentions529) return true;
  if (err.message.startsWith("provider response missing")) return false;
  // Everything else escaping the transport boundary: fetch rejects and
  // truncated/SSE-breaking bodies — transient by nature.
  return true;
}

/** The error's server deadline, if any (r1a Task 4). The ladder treats it as
 *  an explicit wait that REPLACES the exponential guess — exact value, no
 *  jitter — while still consuming one ladder slot per retry. */
function retryAfterMsOf(err: unknown): number | undefined {
  return err instanceof ProviderHttpError ? err.retryAfterMs : undefined;
}

/** Retry a promise-returning attempt on the ladder. M47 §7: overload-class
 *  failures take the overload branch (same key, longer doubling waits).
 *  M70 §3: a background QuerySource never retries an overload — it fails
 *  immediately with the typed reason (no wait, no re-issue).
 *  r1a Task 4: a server Retry-After beyond the fail cap (60s) is honored as a
 *  hard stop — no retry, the original error surfaces as-is; within it, the
 *  deadline replaces the backoff value (the wait source only — same sleep,
 *  same ladder slots, zero second time mechanism). */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryLadderOptions = {}): Promise<T> {
  const baseMaxRetries = opts.maxRetries ?? defaultMaxRetries();
  const sleep = opts.sleep ?? defaultSleep;
  // 124 项 2: per-failure effective cap. A network-class failure when the
  // grace window is enabled widens maxRetries × multiplier and lifts the
  // per-wait cap to maxDelayMsMs (default 5min). 4xx/5xx business errors
  // and deterministic typed failures always see the base cap — the network
  // test never silently broadens a 401 or 503 quota into a 5-minute wait.
  const graceEnabled = opts.networkGrace?.enabled === true;
  const graceMultiplier = opts.networkGrace?.retryMultiplier ?? DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER;
  const graceMaxDelayMs = opts.networkGrace?.maxDelayMsMs ?? DEFAULT_NETWORK_GRACE_MAX_DELAY_MS;
  let graceEntered = false;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      // 121 项 1: the capacity observer fires FIRST — every overload-class
      // observation is reported whatever the ladder then decides (retry,
      // background bail, or rethrow past the cap).
      if (isOverloadClassFailure(err)) opts.onOverload?.();
      // M70 §3: the foreground-only allowlist runs BEFORE the ladder.
      if (isBackgroundNoRetry(opts.querySource, err)) throw new BackgroundOverloadError(opts.querySource as string, err);
      // r1a Task 4: the server's explicit deadline beyond the fail cap — a
      // wait longer than a minute is the provider saying "stop", not "back
      // off". Exactly RETRY_AFTER_FAIL_CAP_MS is allowed (the check is >).
      const retryAfterMs = retryAfterMsOf(err);
      if (retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_FAIL_CAP_MS) throw err;
      if (!isRetryableProviderError(err)) throw err;
      // 124 项 2: network-class failures widen the ladder when grace is on;
      // 4xx/5xx/typed failures keep the base cap so their existing behavior
      // is byte-stable. The grace window fires onEnter on the FIRST observed
      // network failure in this lifetime (idempotent across attempts).
      const networkClass = graceEnabled && isNetworkClassFailure(err);
      if (networkClass && !graceEntered) {
        graceEntered = true;
        opts.networkGrace?.onEnter?.();
      }
      const effectiveMaxRetries = networkClass ? baseMaxRetries * graceMultiplier : baseMaxRetries;
      const effectiveMaxDelayMs = networkClass ? graceMaxDelayMs : opts.maxDelayMs;
      if (attempt >= effectiveMaxRetries) throw err;
      // ω99-315 classification backoff: an idle abort is NOT server overload —
      // the connection died, so the retry is a DIRECT resend (0 wait; the M24
      // byte-stable resent request rides the provider prefix cache and costs
      // ≈ incremental tokens — a backoff would only add dead time). 429 keeps
      // honoring Retry-After; 5xx/network keep the exponential rungs.
      const delayOpts: Pick<RetryLadderOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio" | "random" | "overloadBaseDelayMs"> =
        networkClass
          ? { baseDelayMs: opts.baseDelayMs, jitterRatio: opts.jitterRatio, random: opts.random, overloadBaseDelayMs: opts.overloadBaseDelayMs }
          : { baseDelayMs: opts.baseDelayMs, maxDelayMs: effectiveMaxDelayMs, jitterRatio: opts.jitterRatio, random: opts.random, overloadBaseDelayMs: opts.overloadBaseDelayMs };
      const delayMs = isStreamIdleError(err)
        ? 0
        : retryAfterMs ?? (isOverloadError(err) ? overloadBackoffDelayMs(attempt, delayOpts) : backoffDelayMs(attempt, delayOpts));
      opts.onRetry?.(attempt + 1, delayMs, retryReason(err));
      probeModelRetry({ attempt: attempt + 1, delayMs, reason: retryReason(err) });
      await sleep(delayMs);
    }
  }
}

/** Retry a generator-producing attempt — but ONLY until the first event has
 *  been yielded downstream. After that, an error is rethrown untouched: a
 *  replay would duplicate already-delivered output.
 *  r1a Task 4: same Retry-After semantics as withRetry (fail cap + the
 *  deadline replacing the backoff value; pre-delta retries only). */
export async function* withRetryStream<T>(
  fn: () => AsyncGenerator<T>,
  opts: RetryLadderOptions = {},
): AsyncGenerator<T> {
  const baseMaxRetries = opts.maxRetries ?? defaultMaxRetries();
  const sleep = opts.sleep ?? defaultSleep;
  // 124 项 2: same per-failure effective cap as withRetry — see the block
  // comment there. Stream-side widening keeps the byte-stable contract
  // (only pre-delta retries ever run; a post-delta break rethrows untouched).
  const graceEnabled = opts.networkGrace?.enabled === true;
  const graceMultiplier = opts.networkGrace?.retryMultiplier ?? DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER;
  const graceMaxDelayMs = opts.networkGrace?.maxDelayMsMs ?? DEFAULT_NETWORK_GRACE_MAX_DELAY_MS;
  let graceEntered = false;
  for (let attempt = 0; ; attempt += 1) {
    let produced = false;
    try {
      for await (const ev of fn()) {
        produced = true;
        yield ev;
      }
      return;
    } catch (err) {
      // 121 项 1: same capacity observer as withRetry — the FIRST statement
      // of the catch, so it fires for post-delta breaks too (the overload
      // observation is real capacity evidence even when the stream cannot be
      // replayed and must rethrow).
      if (isOverloadClassFailure(err)) opts.onOverload?.();
      // M70 §3: the foreground-only allowlist runs before the ladder — a
      // background overload never replays the stream.
      if (isBackgroundNoRetry(opts.querySource, err)) throw new BackgroundOverloadError(opts.querySource as string, err);
      // r1a Task 4: beyond the fail cap the stream error is rethrown
      // untouched (no wait) — same rule as withRetry.
      const retryAfterMs = retryAfterMsOf(err);
      if (retryAfterMs !== undefined && retryAfterMs > RETRY_AFTER_FAIL_CAP_MS) throw err;
      if (produced) throw err; // post-delta: rethrow untouched (no replay)
      if (!isRetryableProviderError(err)) throw err;
      // 124 项 2: same grace-widening logic as withRetry — the effective
      // retry cap here is the SAME effectiveMaxRetries (network-class widens
      // it; 4xx/5xx/deterministic failures stay on the base cap).
      const networkClass = graceEnabled && isNetworkClassFailure(err);
      if (networkClass && !graceEntered) {
        graceEntered = true;
        opts.networkGrace?.onEnter?.();
      }
      const effectiveMaxRetries = networkClass ? baseMaxRetries * graceMultiplier : baseMaxRetries;
      const effectiveMaxDelayMs = networkClass ? graceMaxDelayMs : opts.maxDelayMs;
      if (attempt < effectiveMaxRetries) {
        // ω99-315: same classification backoff as withRetry — idle resends
        // directly (0 wait), everything else keeps its ladder rung.
        const delayOpts: Pick<RetryLadderOptions, "baseDelayMs" | "maxDelayMs" | "jitterRatio" | "random" | "overloadBaseDelayMs"> =
          networkClass
            ? { baseDelayMs: opts.baseDelayMs, jitterRatio: opts.jitterRatio, random: opts.random, overloadBaseDelayMs: opts.overloadBaseDelayMs }
            : { baseDelayMs: opts.baseDelayMs, maxDelayMs: effectiveMaxDelayMs, jitterRatio: opts.jitterRatio, random: opts.random, overloadBaseDelayMs: opts.overloadBaseDelayMs };
        const delayMs = isStreamIdleError(err)
          ? 0
          : retryAfterMs ?? (isOverloadError(err) ? overloadBackoffDelayMs(attempt, delayOpts) : backoffDelayMs(attempt, delayOpts));
        opts.onRetry?.(attempt + 1, delayMs, retryReason(err));
        probeModelRetry({ attempt: attempt + 1, delayMs, reason: retryReason(err) });
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
}
