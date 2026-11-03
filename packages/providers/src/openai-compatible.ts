import type { AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, TerminalRepairKind } from "@wudao-org/core";
import { DEFAULT_MAX_REQUEST_IMAGE_BYTES, probeModelClient } from "@wudao-org/core";
import type { ProviderConfig } from "./config.js";
import { acceptsReasoningOnlyFinish, omitsReasoningOnToolTurns, parseReasoningEffort } from "./config.js";
import type { PersonaRuntime } from "./persona/runtime.js";
// 夜移 023: the session-scoped missing-reasoning circuit (Reasonix warn-state).
import { createMissingReasoningCircuit } from "./missing-reasoning-circuit.js";
import type { MissingReasoningCircuit } from "./missing-reasoning-circuit.js";
import { createKeyPool } from "./key-pool.js";
import type { KeyPool } from "./key-pool.js";
import { createRatePauseWindow, type RatePauseWindow } from "./rate-pause.js";
// r1a Task 3: the M62 §7 ordered model-fallback chain, extracted from this
// factory and shared by all three protocol factories.
import { withModelFallback } from "./model-fallback.js";
import type { StreamingModelClient } from "./model-fallback.js";
// ω99-315: the dual-tier idle watchdog (soft warn / hard abort) — shared with
// the anthropic/responses sseDataLines. See stream-idle.ts for the contract.
import { resolveStreamIdleBudget, type StreamIdleRuntime, type StreamIdleWarningInfo } from "./stream-idle.js";
// 拆分运动 C：域文件外提后本模块保留工厂 + 终局修复 seam；下面逐名 import
// 域件、再逐名 re-export 保公共面（anthropic/responses/tests/index 零演进）。
import { isCappedReasoning } from "./openai-messages.js";
import type { ImageRequestContext } from "./openai-images.js";
import { createMandatoryReasoningCall, effectiveReasoningEffort } from "./openai-wire.js";
import type { MandatoryReasoningCall, MandatoryReasoningFlag } from "./openai-wire.js";
import { generateOnceWithSelfRepair, streamOnce } from "./openai-engine.js";
import { isMaxTokensOverflow400, parseMaxTokensOverflow, selfRepairMaxTokensValue, withRetry, withRetryStream } from "./retry-ladder.js";
import type { AttachmentResolver } from "./openai-images.js";
import type { RetryLadderOptions, RetryObserver } from "./retry-ladder.js";
// r1b A1: the typed failure classes + the model-failure predicates now live in
// model-failure.ts (breaking the openai-compatible ↔ model-fallback import
// cycle). Re-exported 1:1 below — every existing importer (anthropic/responses/
// tests/index) is unchanged, and the class definitions stay unique so every
// instanceof keeps its exact semantics.
export {
  OVERLOAD_BODY_SIGNATURES,
  sniffOverloadBody,
  ProviderHttpError,
  ContextLengthError,
  BackgroundOverloadError,
  isKeyClassFailure,
  isModelFallbackEligible,
  // ω99-42: the typed mandatory-reasoning rejection (hermes f6bd1633f7).
  ReasoningMandatoryError,
  isMandatoryReasoningRejection,
  MANDATORY_REASONING_BODY_SIGNATURES,
} from "./model-failure.js";
// 拆分运动 C 门面：外提域件的公共面 1:1 re-export（类型走 export type——
// isolatedModules）。
export {
  withRetry,
  withRetryStream,
  isRetryableProviderError,
  isNetworkClassFailure,
  backoffDelayMs,
  defaultMaxRetries,
  overloadBackoffDelayMs,
  isOverloadError,
  CONTEXT_LENGTH_BODY_SIGNATURES,
  CONTEXT_LIMIT_INPUT_LENGTH_RE,
  matchContextLimitInputLength,
  sniffContextLengthBody,
  isContextLengthFailure,
  parseContextLimitBody,
  parseMaxTokensOverflow,
  selfRepairMaxTokensValue,
  FOREGROUND_QUERY_SOURCES,
  isOverloadClassFailure,
  DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER,
  DEFAULT_NETWORK_GRACE_MAX_DELAY_MS,
  StreamOverflowError,
  TruncatedStreamError,
} from "./retry-ladder.js";
export type { RetryObserver, RetryLadderOptions } from "./retry-ladder.js";
// 113-B3 — the account-quota park domain (identification + the typed error).
export {
  QUOTA_BODY_SIGNATURES,
  sniffQuotaBody,
  parseQuotaResetAt,
  isQuotaParkFailure,
  tryQuotaParkError,
  QuotaParkError,
} from "./quota-park.js";
export { MAX_ACCUM_CHARS, TRUNCATED_MARK, capAccumulated, isCappedReasoning, serializePrompt } from "./openai-messages.js";
export { TOOL_IMAGE_NOTE, assertImagesSupported } from "./openai-images.js";
export type { AttachmentResolver } from "./openai-images.js";
export { parseToolCallArguments } from "./json-arguments.js";

export interface ProviderOptions {
  // Injectable for tests; defaults to global fetch (Node 18+).
  readonly fetch?: typeof fetch;
  /** Retry-ladder observability: fires before every retry wait, so the loop /
   *  CLI can render e.g. `↻ retry 1 (429) in 0.5s`. */
  readonly onRetry?: RetryObserver;
  /** 121 项 1: capacity observer — fires on every overload-class failure the
   *  ladder sees (429/503/529/overload body), merged into the ladder options
   *  like onRetry. The CLI routes it to the subagent AIMD gate's onThrottle. */
  readonly onOverload?: () => void;
  /** Ladder overrides (tests/evals inject sleep, maxRetries, ...). */
  readonly retry?: RetryLadderOptions;
  /** M56 §1: the multi-key pool. When absent, one is built from the config
   *  (`apiKeys` when set, else the single `apiKey`) — pass one in to observe
   *  cooldowns from /status and the statusline (`keys n/m`). */
  readonly keyPool?: KeyPool;
  /** 波次 7 #37 (a reference harness C1): the provider-level 429 pause window. Built
   *  per factory when absent; inject one to share a single window across
   *  factories/tests behind one endpoint. */
  readonly ratePauseWindow?: RatePauseWindow;
  /** M58 §B: stream idle watchdog, ms. While a response is streaming, no
   *  chunk for this long → abort the fetch and raise StreamIdleError (which
   *  walks the existing retry ladder). ω99-315: this is the HARD tier's
   *  override (env WUDAO_STREAM_IDLE_MS is its env twin); 0 still disables
   *  the whole watchdog (both tiers — the M58 escape hatch). Only armed
   *  during active streaming — never during tool execution, permission
   *  asks, or user interaction (those happen outside the stream call). */
  readonly streamIdleTimeoutMs?: number;
  /** ω99-315: soft tier, ms (default 90_000; settings key stream.idleSoftMs).
   *  A silent gap past it fires onStreamIdleWarning ONCE — never cancels,
   *  never issues a model request. 0 disables the warning. */
  readonly streamIdleSoftMs?: number;
  /** ω99-315: hard tier, ms (default 300_000; settings key stream.idleHardMs;
   *  legacy streamIdleTimeoutMs / WUDAO_STREAM_IDLE_MS override it). A silent
   *  gap past it aborts the download and raises the enriched StreamIdleError.
   *  0 disables the abort. */
  readonly streamIdleHardMs?: number;
  /** ω99-315: the soft tier's warn hook (at most once per silent gap). Pure
   *  observation — a warning never cancels the stream and never produces a
   *  model request; front-ends may render "still thinking, Ns silent". */
  readonly onStreamIdleWarning?: (info: StreamIdleWarningInfo) => void;
  /** M79 §2: the transient image-resolution seam. A request whose history
   *  carries ImageBlocks resolves each surviving ref to a `data:` URL HERE —
   *  bytes never enter the session log, and the data URL exists only for
   *  this one request build. Without a resolver, any image-bearing input
   *  fails closed with UNSUPPORTED_CONTENT (no-attachment-store) before any
   *  network call. */
  readonly attachments?: AttachmentResolver;
  /** M79 §2: cumulative base64 budget for one request's images (default
   *  20MiB). Over budget → oldest images offload to fixed text
   *  placeholders, deterministically; the omitted bytes are never read. */
  readonly maxRequestImageBytes?: number;
  /** persona 层1/2 的运行时（逐调用读取；undefined = 无 persona，字节不变）。 */
  readonly personaRuntime?: PersonaRuntime;
  /** ω99-42: fires ONCE when the mandatory-reasoning repair is first VERIFIED
   *  (a repaired request came back 2xx) — the observable edge of the
   *  per-client pre-arm flag (status/diagnostics surfaces wire this; the
   *  ladder's onRetry line covers the retry itself). */
  readonly onMandatoryRepairApplied?: () => void;
}

export function createOpenAICompatibleProvider(config: ProviderConfig, options: ProviderOptions = {}): ModelClient {
  const doFetch = options.fetch ?? fetch;
  const retry: RetryLadderOptions = {
    ...options.retry,
    ...(options.onRetry !== undefined ? { onRetry: options.onRetry } : {}),
    // 121 项 1: the capacity observer rides the same options fragment.
    ...(options.onOverload !== undefined ? { onOverload: options.onOverload } : {}),
  };
  // M56 §1: key selection is per REQUEST (each HTTP attempt), round-robin
  // with per-key cooldown. The key rides only the Authorization header — the
  // body bytes (and the prefix cache) never see it.
  const keyPool = options.keyPool ?? createKeyPool(config.apiKeys ?? [config.apiKey]);
  // 波次 7 #37 (a reference harness C1): the provider-level 429 pause window — one per
  // factory closure, shared across every leg and every concurrent request of
  // this provider instance (keyPool topology). The pool answers "rotate to a
  // spare key"; the window answers "the provider itself said stop" (single
  // key, or every key cooling): LATER request entries wait it out in 250ms
  // slices, the originator's own ladder retries stay ungated (a transient 429
  // keeps today's fast-recovery behavior), and any 2xx clears it.
  const ratePause = options.ratePauseWindow ?? createRatePauseWindow();
  // M58 §B / ω99-315: the dual-tier budget, resolved once at construction
  // (option → legacy option/env → default) and clamped to the setTimeout
  // limit (a wrap-beyond-2^31-1 value would fire instantly).
  const streamIdle: StreamIdleRuntime = {
    ...resolveStreamIdleBudget({
      softMs: options.streamIdleSoftMs,
      hardMs: options.streamIdleHardMs,
      legacyTimeoutMs: options.streamIdleTimeoutMs,
    }),
    ...(options.onStreamIdleWarning !== undefined ? { onSoftWarning: options.onStreamIdleWarning } : {}),
  };
  // M79 §2: the image request context — the transient data-URL resolver and
  // the cumulative base64 budget. Absent resolver = image inputs fail closed
  // (no silent drop, no provider-level capability guessing).
  const imageCtx: ImageRequestContext = {
    budgetBytes: options.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    ...(options.attachments !== undefined ? { resolver: options.attachments } : {}),
  };
  // ω99-42: the per-client mandatory-reasoning flag — in-process, endpoint-
  // scoped, armed only by a VERIFIED repair (see the ω99-42 block comment in
  // openai-wire.ts, where the runtime now lives).
  const mandatoryFlag: MandatoryReasoningFlag = {
    applied: false,
    ...(options.onMandatoryRepairApplied !== undefined ? { onApplied: options.onMandatoryRepairApplied } : {}),
  };

  // M62 §7 — the ordered model-fallback chain now lives in withModelFallback
  // (r1a Task 3 extraction; shared by all three protocol factories). This
  // factory provides ONE leg: a single model's generate/stream with the
  // shared retry ladder INSIDE (the chain swaps the model after a leg's
  // ladder gave up — model failure ≠ credential failure; the M56 key pool
  // stays orthogonal, rotating keys INSIDE one model).
  const legClient = (cfg: ProviderConfig): StreamingModelClient => {
    // 夜移 023: one circuit per leg (≈ Reasonix's per-config fingerprint,
    // session-scoped) — a missing-reasoning regression on the primary model
    // does not suppress the fallback leg's retries.
    const circuit = createMissingReasoningCircuit();
    return {
    // M70 §2: the leg's model identity (the decorator keeps the chain's
    // PRIMARY identity on the returned client).
    modelId: cfg.model,
    // The retry ladder (M26 P11) wraps BOTH paths: transient transport and
    // listed-status failures are retried with exponential backoff; aborts and
    // argument errors surface immediately. The M48 §2 terminal-shape repair
    // rides INSIDE one ladder attempt: a successful-but-degenerate response
    // (not an error) gets one frozen byte-identical replay.
    async generate(input: ModelInput): Promise<AssistantMessage> {
      // 波次 7 #37: the leg entry gate — a concurrent request defers here
      // while the provider is rate-paused (abort-aware); the ladder retries
      // INSIDE one leg call stay ungated (transient-blip recovery unchanged).
      // M70 §3: the call's QuerySource rides the ladder options (a
      // background source never retries an overload).
      await ratePause.wait(input.signal);
      // ω99-42: one repair runtime per public call — it survives every ladder
      // attempt of THIS call (the repair retry re-enters with the body armed).
      const mr = createMandatoryReasoningCall(mandatoryFlag, cfg);
      return withRetry(() => generateWithRepair(cfg, input, doFetch, keyPool, ratePause, imageCtx, options.personaRuntime, circuit, mr), { ...retry, querySource: input.querySource });
    },
    async *stream(input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      // 波次 7 #37: same entry gate as generate (before the first delta).
      await ratePause.wait(input.signal);
      // ω99-42: same per-call repair runtime as generate (see there).
      const mr = createMandatoryReasoningCall(mandatoryFlag, cfg);
      // SSE streaming: posts the same request with stream:true and parses
      // Server-Sent Events. reasoning_content and text deltas are yielded
      // live; tool_call fragments are accumulated across deltas and emitted
      // in the final "done" message. Retries only BEFORE the first delta — a
      // break after output has started is thrown to the loop (never
      // replayed) so no output is duplicated. The M48 §2 repair applies at
      // the done seam; the done message is always the last attempt's.
      // M70 §3: the call's QuerySource rides the ladder options (see generate).
      yield* withRetryStream(() => streamWithRepair(cfg, input, doFetch, keyPool, ratePause, streamIdle, imageCtx, options.personaRuntime, circuit, mr), { ...retry, querySource: input.querySource });
    },
    };
  };
  const chained = withModelFallback(legClient, config);

  // PB-1 探针缝（模型面）：工厂返回处装饰 ModelClient 记 model.call 探针
  //（探针关 WUDAO_PROBE≠on = 原对象原引用返回，provider 本体零改动）。
  return probeModelClient({
    // M70 §2: the client's primary model identity (the loop's usage-anchor
    // guards compare it against the answering model on each usage row).
    modelId: config.model,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      // M58 §C: validate a per-input reasoning effort ONCE, at the public
      // boundary — fail-fast OUTSIDE the ladder AND the fallback chain (junk
      // can never succeed on a sibling model either).
      return chained.generate(validatedInputEffort(input));
    },
    async *stream(input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      yield* chained.stream(validatedInputEffort(input));
    },
  });
}

/** M58 §C: validate a per-input reasoning effort ONCE, before the retry
 *  ladder — the fail-fast parse error must never walk the ladder (junk can
 *  never succeed on retry). The PARSED value rides the returned input, so
 *  toOpenAIRequest never re-parses. Absent/empty = the input unchanged (the
 *  config's own effort applies). */
function validatedInputEffort(input: ModelInput): ModelInput {
  if (input.reasoningEffort === undefined || input.reasoningEffort === "") return input;
  return { ...input, reasoningEffort: parseReasoningEffort(input.reasoningEffort) };
}

// ---------------------------------------------------------------------------
// M48 §2 — terminal-shape repair (Reasonix pair). Two degenerate finishes:
//   reasoning-only    reasoning present, content and tool_calls empty — the
//                     endpoint thought inside its reasoning budget and never
//                     produced an answer. On providers that accept the shape
//                     (acceptsReasoningOnlyFinish: deepseek/zai profiles)
//                     the finish does NOT end the call.
//   missing-reasoning a tool-call turn carrying no reasoning while the replay
//                     contract is ON — the turn the contract expects to
//                     replay later is malformed on arrival. ω-2a: gated on
//                     the request's effective effort (none = legitimate
//                     no-reasoning shape, no replay) and never fired for a
//                     client-capped tail (that classifies overflow instead).
//   overflow  (ω-2a)  a reasoning tail the CLIENT truncated at the 2M-char
//                     accumulator cap — incomplete, so it is never
//                     freeze-replayed and never replayed as complete on the
//                     wire; the message settles as-is with the marker
//                     in-band (the most conservative branch of this idiom).
// Repair = ONE frozen replay: the same config + same input serialize to the
// same body bytes, resent once, audited through ModelInput.onTerminalRepair
// BEFORE the resend. A second degenerate finish settles as-is (the response
// is returned untouched — the loop's stop semantics decide what happens).
// ---------------------------------------------------------------------------

/** Which repair (if any) a finished assistant message needs. Pure; `input` is
 *  the request the message answered (ω-2a: the decision is request-level — a
 *  reasoning-less tool turn from a none-effort request is the model's
 *  legitimate no-reasoning shape, not a malformed turn). The return widens
 *  core's TerminalRepairKind with the providers-local "overflow"
 *  classification — it never reaches onTerminalRepair (the audit vocabulary
 *  is core's); the caller fail-closes instead of replaying. */
export function terminalRepairKind(
  msg: AssistantMessage,
  config: ProviderConfig,
  input: Pick<ModelInput, "reasoningEffort"> = {},
): TerminalRepairKind | "overflow" | undefined {
  const hasToolCalls = (msg.toolCalls?.length ?? 0) > 0;
  const capped = isCappedReasoning(msg.reasoning);
  // ω-2a: overflow ≠ missing — a client-capped tail is incomplete, so it is
  // never a healthy replayable tail (Reasonix reasoning_replay.go:61-69).
  if (capped && (config.reasoningReplay === "always" || (config.reasoningReplay === "toolCallTurns" && hasToolCalls))) {
    return "overflow";
  }
  if (
    !hasToolCalls
    // A capped tail is not the "thought inside its budget" shape — an
    // incomplete tail is never freeze-replayed (ω-2a).
    && !capped
    && msg.content === ""
    && msg.reasoning !== undefined
    && msg.reasoning !== ""
    && acceptsReasoningOnlyFinish(config)
  ) {
    return "reasoning-only";
  }
  if (
    hasToolCalls
    && msg.reasoning === undefined
    && (config.reasoningReplay === "toolCallTurns" || config.reasoningReplay === "always")
    // Reasonix 4de837d9a: the replay requirement is effort-aware — reasoning
    // explicitly disabled means a reasoning-less tool turn takes the
    // empty-reasoning fallback (continue, no replay) instead of a wasted
    // frozen re-request on every tool turn.
    && effectiveReasoningEffort(input, config) !== "none"
    // 夜移 022 (Reasonix reasoning_replay_policy.go): some endpoints (zhipu)
    // legitimately omit reasoning on VALID thinking-enabled tool turns — a
    // provider fact, independent of the effort gate above. Replaying would
    // resend the same request for the same shape on every tool turn.
    && !omitsReasoningOnToolTurns(config)
  ) {
    return "missing-reasoning";
  }
  return undefined;
}

/** 夜移 023: a healthy tool-call turn under the replay contract — the shape
 *  whose three-consecutive streak re-arms the missing-reasoning circuit.
 *  Same envelope as the missing-reasoning branch above (contract on, effort
 *  ≠ none, no provider-legitimate omission), with reasoning PRESENT, non-empty
 *  and not client-capped. Plain answers, effort=none turns and omits-flag
 *  endpoints never count — the contract was not in force for them. */
function healthyToolTurnUnderContract(
  msg: AssistantMessage,
  config: ProviderConfig,
  input: Pick<ModelInput, "reasoningEffort">,
): boolean {
  return (msg.toolCalls?.length ?? 0) > 0
    && msg.reasoning !== undefined
    && msg.reasoning !== ""
    && !isCappedReasoning(msg.reasoning)
    && (config.reasoningReplay === "toolCallTurns" || config.reasoningReplay === "always")
    && effectiveReasoningEffort(input, config) !== "none"
    && !omitsReasoningOnToolTurns(config);
}

/** One attempt + at most one frozen replay (non-streaming). M70 §4: the
 * max_tokens self-repair wraps each attempt (a parseable overflow 400 retries
 * once with the reduced cap — see generateOnceWithSelfRepair). */
async function generateWithRepair(
  config: ProviderConfig,
  input: ModelInput,
  doFetch: typeof fetch,
  keyPool: KeyPool,
  ratePause: RatePauseWindow,
  imageCtx: ImageRequestContext,
  persona: PersonaRuntime | undefined,
  circuit: MissingReasoningCircuit,
  mr: MandatoryReasoningCall,
): Promise<AssistantMessage> {
  // M70 §4: the shared retry context — at most one self-repair per call.
  const retryContext: { maxTokensOverride?: number } = {};
  const first = await generateOnceWithSelfRepair(config, input, doFetch, keyPool, ratePause, imageCtx, retryContext, persona, mr);
  const kind = terminalRepairKind(first, config, input);
  // ω-2a: overflow settles as-is (the idiom's most conservative branch — same
  // as a second degenerate finish): no frozen replay of an incomplete tail,
  // the marker stays in-band, and the wire replay refuses the tail later.
  // 夜移 023: a clean healthy tool turn under the replay contract is the one
  // observation a no-repair settle makes (feeds the re-arm streak; a no-op
  // while the circuit is closed).
  if (kind === undefined || kind === "overflow") {
    if (kind === undefined && healthyToolTurnUnderContract(first, config, input)) circuit.noteHealthyToolTurn();
    return first;
  }
  // 夜移 023: the circuit-open settle — a sustained regression settles as-is
  // WITHOUT the frozen replay (one request per turn, not two); the observed
  // regression resets the re-arm streak (an intermittent regression must not
  // re-arm on a sparse streak).
  if (kind === "missing-reasoning" && !circuit.allowsRetry()) {
    circuit.noteSuppressedMissing();
    return first;
  }
  input.onTerminalRepair?.(kind);
  // Frozen replay: same input and the config the SUCCESSFUL leg ran under —
  // review F2: when that leg was self-repaired, the override is part of its
  // bytes, so the replay re-applies it (byte-identical; a recurring 400 on
  // the original cap could not re-repair — the repair is single-shot).
  const replayConfig = retryContext.maxTokensOverride !== undefined
    ? { ...config, maxTokens: retryContext.maxTokensOverride }
    : config;
  const settled = await generateOnceWithSelfRepair(replayConfig, input, doFetch, keyPool, ratePause, imageCtx, retryContext, persona, mr);
  // 夜移 023: the replay's own finish decides the window — a replay that ALSO
  // comes back reasoning-less OPENS the circuit (remediation proven useless
  // for this regression); a healthy recovery keeps full protection (the
  // recorded divergence from Reasonix — wudao has no history projection to
  // fall back on, so a working replay is never suppressed).
  if (kind === "missing-reasoning" && terminalRepairKind(settled, config, input) === "missing-reasoning") {
    circuit.noteFailedReplay();
  } else if (healthyToolTurnUnderContract(settled, config, input)) {
    circuit.noteHealthyToolTurn();
  }
  return settled;
}

/** One attempt + at most one frozen replay (streaming). The first attempt's
 *  deltas are already downstream; the replay's events follow them, and its
 *  done message is authoritative. */
async function* streamWithRepair(
  config: ProviderConfig,
  input: ModelInput,
  doFetch: typeof fetch,
  keyPool: KeyPool,
  ratePause: RatePauseWindow,
  streamIdle: StreamIdleRuntime,
  imageCtx: ImageRequestContext,
  persona: PersonaRuntime | undefined,
  circuit: MissingReasoningCircuit,
  mr: MandatoryReasoningCall,
): AsyncGenerator<ModelStreamEvent> {
  // M70 §4: the shared retry context — at most one self-repair per call. A
  // parseable overflow 400 fails BEFORE any event is yielded (the fetch never
  // streams), so the repaired attempt restarts cleanly.
  const retryContext: { maxTokensOverride?: number } = {};
  const onceWithSelfRepair = async function* (cfg: ProviderConfig): AsyncGenerator<ModelStreamEvent> {
    try {
      yield* streamOnce(cfg, input, doFetch, keyPool, ratePause, streamIdle, imageCtx, persona, mr);
    } catch (err) {
      if (!isMaxTokensOverflow400(err) || retryContext.maxTokensOverride !== undefined) throw err;
      retryContext.maxTokensOverride = selfRepairMaxTokensValue(parseMaxTokensOverflow(err.body)!);
      yield* streamOnce({ ...cfg, maxTokens: retryContext.maxTokensOverride }, input, doFetch, keyPool, ratePause, streamIdle, imageCtx, persona, mr);
    }
  };
  let done: AssistantMessage | undefined;
  for await (const ev of onceWithSelfRepair(config)) {
    if (ev.type === "done") done = ev.message;
    else yield ev;
  }
  if (done === undefined) return;
  const kind = terminalRepairKind(done, config, input);
  // ω-2a: overflow settles as-is — the streamed deltas and the marker stay,
  // and the incomplete tail is never re-sent (see generateWithRepair).
  // 夜移 023: same seam as the non-streaming lane — a healthy tool turn
  // feeds the re-arm streak; an open circuit suppresses the missing-reasoning
  // replay (the first attempt's done is authoritative, one request).
  if (kind === undefined || kind === "overflow") {
    if (kind === undefined && healthyToolTurnUnderContract(done, config, input)) circuit.noteHealthyToolTurn();
    yield { type: "done", message: done };
    return;
  }
  if (kind === "missing-reasoning" && !circuit.allowsRetry()) {
    circuit.noteSuppressedMissing();
    yield { type: "done", message: done };
    return;
  }
  input.onTerminalRepair?.(kind);
  // Frozen replay: the second attempt's events (deltas + its done message)
  // stream after the first attempt's — the last done is authoritative.
  // Review F2: re-apply the self-repair override when the successful leg ran
  // under it (byte-identical to that leg; see generateWithRepair).
  // 夜移 023: the replay's own finish decides the circuit window (see
  // generateWithRepair) — every event still streams through in order.
  let replayDone: AssistantMessage | undefined;
  for await (const ev of onceWithSelfRepair(
    retryContext.maxTokensOverride !== undefined ? { ...config, maxTokens: retryContext.maxTokensOverride } : config,
  )) {
    if (ev.type === "done") replayDone = ev.message;
    yield ev;
  }
  if (replayDone !== undefined) {
    if (kind === "missing-reasoning" && terminalRepairKind(replayDone, config, input) === "missing-reasoning") {
      circuit.noteFailedReplay();
    } else if (healthyToolTurnUnderContract(replayDone, config, input)) {
      circuit.noteHealthyToolTurn();
    }
  }
}

// ---------------------------------------------------------------------------
// M58 §B — the stream idle watchdog. A model stream that goes silent (proxy
// dropped the connection, endpoint hung mid-generation) used to hang the run
// forever. While a response is streaming, no chunk for the hard budget aborts
// the fetch and raises the typed StreamIdleError, which walks the EXISTING
// retry ladder. The retried request re-serializes the same ModelInput →
// byte-identical body, so the model/prefix cache never sees a difference. The
// timers reset on every chunk and are armed only during active streaming —
// tool execution, permission asks, and user interaction happen OUTSIDE the
// stream call and are never timed.
// ω99-315: the single 45s tier became DUAL (soft warn 90s / hard abort 300s);
// the constants, the typed error, and the shared guard live in stream-idle.ts
// (this module re-exports the legacy surface below).
// ---------------------------------------------------------------------------

export {
  DEFAULT_STREAM_IDLE_SOFT_MS,
  DEFAULT_STREAM_IDLE_HARD_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  defaultStreamIdleTimeoutMs,
  resolveStreamIdleBudget,
  StreamIdleError,
} from "./stream-idle.js";
export type { StreamIdleBudget, StreamIdleRuntime, StreamIdleWarningInfo } from "./stream-idle.js";
