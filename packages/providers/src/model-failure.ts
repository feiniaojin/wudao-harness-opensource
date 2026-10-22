// packages/providers/src/model-failure.ts — r1b A1：模型故障判定与它们依赖的
// 类型化错误，从 openai-compatible.ts 原样抽出。
//
// 为什么独立成模块：r1a Task 3 把 withModelFallback 抽到 model-fallback.ts 后，
// model-fallback → openai-compatible（isModelFallbackEligible）→ model-fallback
// （withModelFallback）成了环。判定需要 openai-compatible 里的类型化错误类
// （instanceof 判据），所以连同这三个类（及其构造器依赖 sniffOverloadBody）
// 一起下沉到本模块 —— 依赖图变为无环：
//   model-failure（零包内依赖）← model-fallback ← openai-compatible（再 re-export）
// openai-compatible.ts 对这些名字逐名 re-export，既有导入方（anthropic/
// responses/测试/index）零改动；类的定义全仓唯一，instanceof 语义逐字节不变。
import { UnsupportedContentError, MAX_TOKENS_THINKING_BUDGET_CONFLICT_CODE, CONFIG_CAP_ALSO_CONFLICTS_FIELD } from "@wudao/core";
import type { ReasoningEffort } from "./config.js";

// ---------------------------------------------------------------------------
// M47 §7 (A6): 429 overload body-sniffing. Z.AI / Zhipu (bigmodel.cn) express
// WHOLE-FLEET overload as HTTP 429 with a recognizable body — not a per-key
// quota hit. Those failures classify as `overload`: the ladder backs off on the
// SAME key (never rotates — a fleet-wide signal says nothing about this
// key) with a longer doubling wait, capped at 32s.
// ---------------------------------------------------------------------------

/** The z.ai / zhipu / bigmodel overload vocabulary. The JSON-coded 1301 is
 *  anchored on the `code` key so ordinary numeric fields (token counts) can
 *  never trip it. */
export const OVERLOAD_BODY_SIGNATURES: readonly RegExp[] = [
  /"code"\s*:\s*"?(?:1301)"?/, // zhipu/bigmodel: 集团内部忙 (fleet busy)
  /overload/i, // z.ai: "The server is overloaded …"
  /server is busy/i,
  /当前集团内部忙/,
  /服务器繁忙/,
  /系统繁忙/,
  /负载已满/,
];

/** True when a 429 body carries a known overload signature. */
export function sniffOverloadBody(body: string): boolean {
  return OVERLOAD_BODY_SIGNATURES.some((re) => re.test(body));
}

/** The typed context-overflow failure (M58 §A). Stamped with the duck-type
 *  `name` the core port recognizes (core's isContextLengthError) — core stays
 *  provider-agnostic and never imports this class. ω-2b (I1-a): carries the
 *  trusted-parse observation when the body yielded one (parseContextLimitBody)
 *  — the loop's calibration + clip ladder read it. */
export class ContextLengthError extends Error {
  readonly status: number;
  readonly body: string;
  readonly observed?: { promptTokens: number; windowTokens: number };

  constructor(status: number, body: string, observed?: { promptTokens: number; windowTokens: number }) {
    super(`provider context length exceeded: ${status} ${body}`.trim());
    this.name = "ContextLengthError";
    this.status = status;
    this.body = body;
    this.observed = observed;
  }
}

/** The typed immediate-bail failure for a background query on overload. The
 *  original error rides `cause` (and its message) for diagnostics. */
export class BackgroundOverloadError extends Error {
  readonly source: string;

  constructor(source: string, original: unknown) {
    super(
      `background query '${source}' hit a provider overload — failing immediately instead of retrying ` +
        `(foreground-only retry policy: during a capacity cascade every retry amplifies gateway load and nobody is waiting on this result): ` +
        `${original instanceof Error ? original.message : String(original)}`,
    );
    this.name = "BackgroundOverloadError";
    this.source = source;
    // The base Error's own cause channel carries the original failure.
    this.cause = original;
  }
}

/** The typed provider HTTP failure. The message keeps the pinned
 *  `provider request|stream failed: <status> <body>` format, so every
 *  message-regex consumer (retryReason, tests, the CLI) keeps working.
 *  r1a Task 4: carries the server's Retry-After deadline (ms) when the
 *  response headers had one — OMITTED otherwise (omit-never-null), so the
 *  serialized shape of every pre-existing error is byte-identical.
 *  v7 γ4 (the upstream project0c7bb7c5c 思想，digest-a C3 搭车件): carries the failing leg's
 *  provider/model identity as STRUCTURED fields — wudao is multi-provider
 *  (悟道/DeepSeek/GLM/Qwen) on one OpenAI-compatible face, and a generic
 *  "provider request failed: 500 …" made every vendor one fingerprint family.
 *  The provider id also appends to the MESSAGE (suffix — the anchored
 *  prefix regexes `^provider (?:request|stream) failed: (\d{3})` in
 *  retryReason/isRetryableProviderError keep matching; the fingerprint's
 *  normalizeFailureCause masks numbers but provider ids are digit-free, so
 *  the attribution SURVIVES normalization — γ2's end-cause ledger groups by
 *  it). Omitted when the config carries no registry identity (a raw
 *  baseURL leg has nothing honest to attribute): byte-identical shape,
 *  identical message. */
export class ProviderHttpError extends Error {
  readonly status: number;
  readonly body: string;
  /** True iff status is 429 AND the body sniffs as overload. */
  readonly overload: boolean;
  /** r1a Task 4: the parsed retry-after / retry-after-ms wait, ms. The ladder
   *  waits EXACTLY this value (no jitter, no exponential) instead of its
   *  backoff; beyond RETRY_AFTER_FAIL_CAP_MS the ladder refuses to retry.
   *  `declare` (useDefineForClassFields): without a deadline the key is
   *  entirely ABSENT from the instance — the serialized shape of every
   *  pre-existing error stays byte-identical. */
  declare readonly retryAfterMs?: number;
  /** v7 γ4: the config's registry provider id (e.g. "deepseek"/"wudao") —
   *  ABSENT on identity-less constructions (omit-never-null). */
  declare readonly provider?: string;
  /** v7 γ4: the failing leg's model id (the fallback chain swaps it — the
   *  identity names the LEG, not the config default). ABSENT likewise. */
  declare readonly model?: string;

  constructor(
    which: "request" | "stream",
    status: number,
    body: string,
    retryAfterMs?: number,
    identity?: { readonly provider?: string; readonly model?: string },
  ) {
    // v7 γ4: identity rides the tail — the pinned prefix bytes are untouched
    // (every anchored-regex consumer and .toBe pin keeps working).
    const tail = identity?.provider !== undefined && identity.provider !== "" ? ` — ${identity.provider}` : "";
    super(`provider ${which} failed: ${status} ${body}${tail}`.trim());
    this.name = "ProviderHttpError";
    this.status = status;
    this.body = body;
    this.overload = status === 429 && sniffOverloadBody(body);
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
    if (identity?.provider !== undefined && identity.provider !== "") this.provider = identity.provider;
    if (identity?.model !== undefined && identity.model !== "") this.model = identity.model;
  }
}

/** wire-r2 follow-up ① — the typed request-construction conflict thrown by
 *  the anthropic adapter when an EXPLICIT maxTokens (input.maxTokens or
 *  config.maxTokens — either is a cap someone chose) sits at/below the
 *  thinking budget implied by reasoningEffort: the wire structurally
 *  requires max_tokens > thinking.budget_tokens, and silently raising a
 *  chosen cap (the pre-narrowing budget+1024 bump) was the fail-closed
 *  tension the wire-r2 review flagged. Only the adapter's own implicit
 *  default cap keeps the historic raise. Deterministic config conflict:
 *  thrown BEFORE the retry ladder (validatedInputEffort's spot — never
 *  sleeps, never hits the wire) and never model-fallback-eligible below
 *  (a sibling model re-hits the identical conflict). */
export class MaxTokensThinkingBudgetConflictError extends Error {
  /** F1 (clip-conflict): the stable cross-package stamp. Core's loop duck-
   *  types this string to route COMPUTED-cap conflicts (the ω-2b admission
   *  clip / the ladder's clip-retry physical — context-budget arithmetic, not
   *  a chosen cap) into the reactive compact ladder instead of hard-failing;
   *  core never imports this class. The literal's single source is the core
   *  port constant (imported here so a core rename changes the stamp and the
   *  providers pin goes loud, never silently unfixed). A caller-chosen
   *  config.maxTokens conflict keeps the fail-closed propagation on both
   *  sides of the seam. */
  readonly code = MAX_TOKENS_THINKING_BUDGET_CONFLICT_CODE;
  readonly maxTokens: number;
  readonly budgetTokens: number;
  /** conflict-origin: TRUE when the caller-chosen PERSISTENT cap
   *  (config.maxTokens) ALSO sits at/below the thinking budget — compaction
   *  can never produce a servable request then (the post-compact resend's
   *  cap resolves back to the config cap and re-conflicts before the wire),
   *  so core skips the reactive compact ladder and keeps this typed
   *  fail-closed propagation. The FIELD NAME's single source is the core
   *  port constant (the computed name below); `declare` keeps the key
   *  ENTIRELY ABSENT when false (omit-never-null — the serialized shape of
   *  every pre-existing error stays byte-identical), and core's
   *  hasConfigCapConflict duck-types it without importing this class. */
  declare readonly [CONFIG_CAP_ALSO_CONFLICTS_FIELD]?: true;

  constructor(maxTokens: number, budgetTokens: number, configCapAlsoConflicts = false) {
    super(
      `explicit maxTokens ${maxTokens} conflicts with thinking budget_tokens ${budgetTokens} ` +
        `(the anthropic wire requires max_tokens > budget_tokens, so this body can never be served) — ` +
        `raise maxTokens above the thinking budget or lower reasoningEffort`,
    );
    this.name = "MaxTokensThinkingBudgetConflictError";
    this.maxTokens = maxTokens;
    this.budgetTokens = budgetTokens;
    if (configCapAlsoConflicts) this[CONFIG_CAP_ALSO_CONFLICTS_FIELD] = true;
  }
}

/** Key-class failures (401/403) never fall back — those are the M56 key
 *  pool's domain (model故障 ≠ 凭据故障). */
export function isKeyClassFailure(err: unknown): boolean {
  return err instanceof ProviderHttpError && (err.status === 401 || err.status === 403);
}

// ---------------------------------------------------------------------------
// ω99-42 — the typed mandatory-reasoning rejection (the upstream f6bd1633f7 +
// 63279301bc, wudao layering). A reasoning-mandatory route (GLM-5.3 via
// Nous/OpenRouter, kimi-k2.7-code-style deployments) answers a request that
// disabled thinking with HTTP 400 "Reasoning is mandatory for this endpoint
// and cannot be disabled". Before this class that 400 surfaced as a generic
// 4xx — unidentifiable, unhealable, unattributable.
// ---------------------------------------------------------------------------

/** The mandatory-reasoning body vocabulary. The first pattern is the live
 *  recording from the upstream f6bd1633f7 (Nous Portal / OpenRouter z-ai/glm-5.3,
 * Sep 2026); the siblings are the same sentence family. Conservative on
 * purpose — the caller may override per provider (the `signatures` param of
 * {@link isMandatoryReasoningRejection}). */
export const MANDATORY_REASONING_BODY_SIGNATURES: readonly RegExp[] = [
  /reasoning is mandatory/i,
  /thinking is mandatory/i,
  /reasoning is required/i,
];

/** True iff the status/body pair is a mandatory-reasoning rejection: HTTP 400
 *  (the class the upstream matches in _classify_400; a 5xx/429 carrying the same
 *  text keeps its existing transport path) plus a body signature. `signatures`
 *  overrides the default vocabulary (per-provider calibration seam). */
export function isMandatoryReasoningRejection(
  status: number,
  body: string,
  signatures: readonly RegExp[] = MANDATORY_REASONING_BODY_SIGNATURES,
): boolean {
  return status === 400 && signatures.some((re) => re.test(body));
}

/** The typed mandatory-reasoning rejection. Two flavors, one class:
 *   repairable — the disable on the wire was NOT a user pin (default-sourced
 *     effort, a thinkingLevelMap fold, or a code-defaulted soft none): the
 *     retry ladder re-sends ONCE with reasoning enabled (messages bytes
 *     untouched — the reasoning fields are request-level sampling params, so
 *     the prefix cache key is preserved by construction; the wudao reading of
 *     the upstream 63279301bc's "same cache key").
 *   terminal — the disable WAS the user's explicit "none" (never silently
 *     rewritten), the repair already ran and failed, or the wire format
 *     cannot express enablement: the error surfaces with actionable guidance.
 *  Never walks the generic transport ladder as a 400, never compresses,
 *  never falls back to a sibling model (the rejection is route semantics,
 *  not model health). */
export class ReasoningMandatoryError extends Error {
  readonly status: number;
  readonly body: string;
  /** Attribution: the config's provider id (fallback baseURL) + the effort
   *  the rejected request actually carried. */
  readonly provider: string;
  declare readonly effortSent?: ReasoningEffort;
  readonly repairable: boolean;

  constructor(
    which: "request" | "stream",
    status: number,
    body: string,
    provider: string,
    effortSent: ReasoningEffort | undefined,
    repairable: boolean,
  ) {
    super(
      repairable
        ? `provider ${which} failed: ${status} ${body} — reasoning is mandatory on this endpoint; retrying with reasoning enabled (the disable was not user-configured)`.trim()
        : `provider ${which} failed: ${status} ${body} — this endpoint requires reasoning and cannot serve a request that disables it; switch the reasoning effort off "none" (e.g. /effort medium) or use an endpoint that accepts disabled thinking`.trim(),
    );
    this.name = "ReasoningMandatoryError";
    this.status = status;
    this.body = body;
    this.provider = provider;
    if (effortSent !== undefined) this.effortSent = effortSent;
    this.repairable = repairable;
  }
}

/** True when an error may trigger the model-fallback chain: model-class
 *  HTTP failures and transport errors — never aborts (user intent), never
 *  context overflow (a prompt that does not fit the primary will not fit a
 *  sibling either; the loop's reactive compaction owns that), never
 *  key-class failures. M79: an UnsupportedContentError is eligible ONLY in
 *  its model-capability form — falling back to a sibling that declares the
 *  image modality is the recovery; the structural forms (role violation,
 *  missing attachment store) can never succeed on another model. */
export function isModelFallbackEligible(err: unknown): boolean {
  if (err instanceof ProviderHttpError) return !isKeyClassFailure(err);
  if (err instanceof ContextLengthError) return false;
  // ω99-42: a mandatory-reasoning rejection is ROUTE semantics, not model
  // health — a sibling model on the same mandatory route re-hits the
  // identical 400 (and the repairable flavor already rode the ladder once).
  // The recovery is the typed guidance (or the repair), never a fallback.
  if (err instanceof ReasoningMandatoryError) return false;
  // 113-B3: an account-level quota window is PROVIDER-scoped — a sibling
  // model on the same capped account burns the same quota. The park lane
  // (the CLI's parked run + reset wake) owns the recovery, never a fallback.
  // Name-armed like HeaderValidationError below (no import edge to
  // quota-park.ts at model-failure's zero-dependency floor).
  if (err instanceof Error && err.name === "QuotaParkError") return false;
  // M70 §3: a background overload's immediate bail is final — re-issuing the
  // call on a sibling model is the same cascade amplification the allowlist
  // exists to stop.
  if (err instanceof BackgroundOverloadError) return false;
  // wire-r2 follow-up ①: an explicit maxTokens/thinking-budget conflict is
  // a deterministic config conflict — a sibling model hits the identical
  // body rejection. Never falls back.
  if (err instanceof MaxTokensThinkingBudgetConflictError) return false;
  // ω99-50: an unrepresentable persona header rides the config, not the
  // model — a sibling leg re-hits the identical named rejection. Never
  // falls back (name-armed: the class lives in header-validation.ts, no
  // import edge to model-failure's zero-dependency floor).
  if (err instanceof Error && err.name === "HeaderValidationError") return false;
  if (err instanceof UnsupportedContentError) return err.reason === "model-no-image-modality";
  if (err instanceof Error && err.name === "AbortError") return false;
  return err instanceof Error && err.name !== "AbortError" && !(err instanceof SyntaxError);
}
