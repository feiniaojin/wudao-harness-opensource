// @wudao/providers — concrete ModelClient adapters. Depends on @wudao/core (the port).
export {
  createOpenAICompatibleProvider,
  serializePrompt,
  withRetry,
  withRetryStream,
  isRetryableProviderError,
  backoffDelayMs,
  defaultMaxRetries,
  // M47 §7: overload classification + branch.
  ProviderHttpError,
  OVERLOAD_BODY_SIGNATURES,
  sniffOverloadBody,
  isOverloadError,
  overloadBackoffDelayMs,
  // M58 §A: context-overflow classification (413 reactive layer).
  ContextLengthError,
  CONTEXT_LENGTH_BODY_SIGNATURES,
  // 120-b B2: the GLM/vLLM strict spelling (classify + trusted-parse, N>M).
  CONTEXT_LIMIT_INPUT_LENGTH_RE,
  matchContextLimitInputLength,
  sniffContextLengthBody,
  isContextLengthFailure,
  // M58 §B / ω99-315: the dual-tier stream idle watchdog (soft warn / hard
  //  abort; the shared guard, budget resolver, and constants live in
  //  stream-idle.ts and are re-exported through openai-compatible.ts).
  StreamIdleError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  defaultStreamIdleTimeoutMs,
  DEFAULT_STREAM_IDLE_SOFT_MS,
  DEFAULT_STREAM_IDLE_HARD_MS,
  resolveStreamIdleBudget,
  type StreamIdleBudget,
  type StreamIdleRuntime,
  type StreamIdleWarningInfo,
  // r1b: the SSE line-buffer overflow cap (same ladder family as StreamIdleError).
  StreamOverflowError,
  // ω99-44: the typed EOF-without-terminal abort (same ladder family — a clean
  // EOF that never spoke finish/stop semantics is a cut, never a completion).
  TruncatedStreamError,
  // M70 §3: the foreground-only retry allowlist (background overload = bail).
  FOREGROUND_QUERY_SOURCES,
  isOverloadClassFailure,
  // 124 项 2: network-outage grace window classifier + default knobs.
  isNetworkClassFailure,
  DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER,
  DEFAULT_NETWORK_GRACE_MAX_DELAY_MS,
  BackgroundOverloadError,
  // M70 §4: max_tokens overflow self-repair (parseable 400 → retry once).
  parseMaxTokensOverflow,
  selfRepairMaxTokensValue,
  // ω-2b (I1-a): the trusted context-limit body parse (classified overflow
  // bodies → the observed {promptTokens, windowTokens} pair).
  parseContextLimitBody,
  // M48 §2: terminal-shape repair (one frozen replay per degenerate finish).
  terminalRepairKind,
  // ω99-42: the typed mandatory-reasoning rejection (hermes f6bd1633f7 +
  // 63279301bc) — matcher + signatures alongside the class.
  ReasoningMandatoryError,
  isMandatoryReasoningRejection,
  MANDATORY_REASONING_BODY_SIGNATURES,
  // M79 §2: the pre-I/O image capability/role gate + the tool-image note.
  assertImagesSupported,
  TOOL_IMAGE_NOTE,
  // 113-B3: the account-quota park domain — identification, the trusted
  // reset parse, and the typed QuotaParkError (the CLI parks on it).
  QUOTA_BODY_SIGNATURES,
  sniffQuotaBody,
  parseQuotaResetAt,
  isQuotaParkFailure,
  tryQuotaParkError,
  QuotaParkError,
} from "./openai-compatible.js";
// Persona adapters (Task 4 / Task 9)
export { createAnthropicProvider } from "./anthropic.js";
export { createResponsesProvider } from "./responses.js";
// r1a Task 3 (M62 §7): the ordered model-fallback chain, extracted from the
// openai factory and shared by all three protocol factories.
export { withModelFallback } from "./model-fallback.js";
export type { ModelClientFactory, StreamingModelClient } from "./model-fallback.js";
// wire-r2 follow-up ①: typed fail-closed conflict — the anthropic adapter
// throws it when an explicit maxTokens (input or config) sits at/below the
// thinking budget implied by reasoningEffort; the adapter's implicit default
// cap keeps the historic budget+1024 raise.
export { MaxTokensThinkingBudgetConflictError } from "./model-failure.js";
// r1a Task 4: 429 Retry-After parsing — the retryAfterMs source the shared
// ladder honors (deadline wait within the 60s fail cap).
export { parseRetryAfterMs, RETRY_AFTER_FAIL_CAP_MS } from "./retry-after.js";
export type { RetryAfterHeadersLike } from "./retry-after.js";
// 波次 8 #42 (hermes #24): bounded error-body read — byte cap + wall clock +
// cancel-on-abandon, so a stalled or huge error body can neither hang the
// request nor buffer unbounded.
export { readErrorBody, ERROR_BODY_MAX_BYTES, ERROR_BODY_DEADLINE_MS } from "./error-body.js";
export type { ReadErrorBodyOptions } from "./error-body.js";
// Persona Phase B (design 93 §4.2-2): the single construction seam — dispatches
// on config.wire to the protocol adapter (absent = openai-compatible engine).
export { createProvider } from "./dispatcher.js";
export type { ProviderOptions, RetryLadderOptions, RetryObserver, AttachmentResolver } from "./openai-compatible.js";
// M79 §3 — per-model input-modality metadata (catalog + resolution).
export {
  modelInputModalities,
  resolveInputModalities,
  modelAcceptsImages,
} from "./models.js";
export type { InputModality, ModelDescriptor } from "./models.js";
export {
  PROVIDER_PROFILES,
  REASONING_EFFORTS,
  REASONING_FORMATS,
  REASONING_REPLAYS,
  NO_KEY_REASON,
  parseApiKeyPool,
  isProviderName,
  // Provider management R2: the closed builtin table narrows separately from
  // the widened ProviderName alias.
  isBuiltinProviderName,
  parseReasoningEffort,
  parseReasoningFormat,
  parseReasoningReplay,
  // ω99-39: the probe-verified replay cap — shared by the resolution seam
  // and the CLI's provider-switch carry lane (one rule, both config faces).
  capClientReasoningReplay,
  parseWire,
  reasoningFormatBody,
  // ω99-42: the repair body a mandatory-reasoning rejection re-sends with
  // (the matrix's explicit enable, map-stripped, medium default level).
  mandatoryRepairReasoningBody,
  reasoningResponseFields,
  pickReasoning,
  resolveReasoningContext,
  supportsReasoningEffort,
  resolveProviderConfig,
  resolveProviderConfigResult,
  // M48 §2: the reasoning-only repair gate (profile-resolved).
  acceptsReasoningOnlyFinish,
  // 夜移 022: the tool-turn reasoning-omission fact (profile-resolved).
  omitsReasoningOnToolTurns,
  // 取证弧 0921: the output-limit ladder's escalation tier (profile-resolved).
  outputLimitEscalateFor,
  // ω-2b (I1-c): the profile's window semantics (gates the admission clip).
  resolveWindowMode,
} from "./config.js";
// 夜移 011: the in-band <think> peel (vLLM chat-template lanes inline CoT
// into content; the splitter routes a turn-initial block into reasoning).
export { InbandThinkSplitter, resolveSplitInbandThinking } from "./split-inband-thinking.js";
export type { SplitOutput } from "./split-inband-thinking.js";
export type {
  ProviderConfig,
  ProviderConfigResult,
  ProviderName,
  BuiltinProviderName,
  ProviderProfile,
  ProviderSelection,
  ReasoningEffort,
  ReasoningFormat,
  ReasoningReplay,
  ReasoningRequestContext,
  WindowMode,
  // M63 §B: the credentials-file fallback map (env wins; see config.ts).
  CredentialsMap,
} from "./config.js";
// Provider management §3/§7 — the runtime provider registry.
export {
  defaultProviderRegistryPath,
  readProviderRegistrySync,
  writeProviderRegistrySync,
  effectiveProfiles,
  validateUserProviderEntry,
  resolveContextWindowTokens,
} from "./registry.js";
export type {
  ProviderModelEntry,
  UserProviderConfig,
  ProviderRegistryFile,
  RegistryLoadResult,
  EffectiveProfile,
} from "./registry.js";
// 借鉴弧 B1（a reference project C1）— 价目面：目录 schema + 缓存经济学 ratio 的自动推导
//（catalog pin > WUDAO_PRICE env > 保守缺省，来源类型化；不暴露为用户配置）。
export { deriveCachePricing, isModelPrices, catalogPricesFor } from "./pricing.js";
export type { ModelPrices, PriceSource } from "./pricing.js";
// ω99-245: #6 — the reasoning capability catalog (data layer of the effort
// preflight): family/model → supported effort set + reasoning_content flag.
export {
  supportedEfforts,
  reasoningContentStreams,
  MODEL_EFFORT_PINS,
} from "./effort-catalog.js";
// P0-4 (96 队列) — the wallet-balance face (DeepSeek GET /user/balance;
// unconfigured → undefined, never an error; amounts stay the API's strings).
export { fetchProviderBalance, BALANCE_TIMEOUT_MS } from "./balance.js";
export type { BalanceInfo, ProviderBalance } from "./balance.js";
// M56 §1: the multi-key pool (round-robin + per-key 429 cooldown).
// createLiveKeyPool (2026-08-31 minimax-401 弧): the config-deriving twin
// the session engine wires over its mutable config holder.
export {
  createKeyPool,
  createLiveKeyPool,
  keyPoolFromEnv,
  cooldownClassForStatus,
  DEFAULT_KEY_COOLDOWN_MS,
  DEFAULT_AUTH_COOLDOWN_MS,
} from "./key-pool.js";
export type { KeyPool, KeyPoolOptions, KeyPoolSnapshot, CooldownClass } from "./key-pool.js";
// 波次 7 #37 (a reference harness C1)：provider 级 429 暂停窗 —— 三协议工厂同享、可注入。
export { createRatePauseWindow, DEFAULT_RATE_PAUSE_MS, RATE_PAUSE_SLICE_MS } from "./rate-pause.js";
export type { RatePauseWindow, RatePauseOptions } from "./rate-pause.js";
// Persona layer exports (Task 5 / Task 6 / Task 7 / Task 8 / Task 9 / Task 11)
export { validatePersonaDefinition, effectiveLayers, BODY_WHITELIST, PROTOCOL_IDS } from "./persona/schema.js";
export { loadPersonaRegistry, lookupPersona } from "./persona/registry.js";
export type { PersonaRegistry } from "./persona/registry.js";
// SDD 2026-08-23 persona Task 5 — the CRUD file helpers (spec §7: same
// package as loadPersonaRegistry). The cli persona ops call these against
// the global personas dir; savePersonaDefinition is the ONE write path.
export { savePersonaDefinition, deletePersonaDefinition, personaIdsInDir } from "./persona/files.js";
export { BUILTIN_PERSONAS } from "./persona/builtins.js";
export { createPersonaRuntime, resolvePersona, parsePersonaSpec } from "./persona/runtime.js";
export type { PersonaRuntime, PersonaRuntimeSlots } from "./persona/runtime.js";
export { applyWirePersona, mergeBodyOverlay, resolveTemplate, resolvePersonaHeaders } from "./persona/apply.js";
export type { WirePersona } from "./persona/apply.js";
export { withPersona } from "./persona/decorator.js";
export type {
  ProtocolId,
  LayerFlags,
  PersonaDefinition,
  ResolvedPersona,
  PromptStyle,
  SystemStyle,
  BodyStyleOverlay,
  PersonaSource,
} from "./persona/types.js";

export const PACKAGE_NAME = "@wudao/providers";
