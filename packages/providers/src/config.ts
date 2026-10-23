// Provider profiles + env/flag resolution. All profiles share the same
// OpenAI-compatible engine (openai-compatible.ts); a profile only fixes the
// default baseUrl / default model and the reasoning format matrix entry
// (format + thinkingLevelMap + supportsReasoningEffort).

import type { LayerFlags, ProtocolId } from "./persona/types.js";
import { PROTOCOL_IDS } from "./persona/schema.js";
import { parsePersonaSpec } from "./persona/runtime.js";
import type { EffectiveProfile, ProviderModelEntry } from "./registry.js";
import type { ModelInput } from "@wudao/core";

/** The closed set of profiles compiled into the binary. The registry
 *  (registry.ts) layers user overlays on top of these and adds custom
 *  OpenAI-compatible providers — `ProviderName` is the OPEN spelling that
 *  covers both. */
export type BuiltinProviderName =
  | "deepseek"
  | "glm"
  | "qwen"
  | "wudao"
  | "anthropic"
  | "kimi"
  | "minimax"
  | "glm-code"
  | "kimi-code"
  | "minimax-code";

/** Widened (provider management R2): any provider id — builtin or a registry
 *  custom. Code that indexes PROVIDER_PROFILES must narrow with
 *  `isBuiltinProviderName` (or annotate `BuiltinProviderName`). */
export type ProviderName = string;

export type ReasoningEffort = "low" | "medium" | "high" | "max" | "none";

// M28 reasoning-format matrix (pi-verified shapes): one enum value fixes BOTH
// sides of the wire — the request fields an effort maps onto and which
// response field carries the reasoning text. New OpenAI-compatible endpoints
// plug in by selecting a format, not by editing the SSE parser.
export type ReasoningFormat =
  | "none"
  | "deepseek"
  | "zai"
  | "qwen"
  | "qwen-chat-template"
  | "openrouter"
  | "together"
  | "baseten";

export const REASONING_FORMATS: readonly ReasoningFormat[] = [
  "none",
  "deepseek",
  "zai",
  "qwen",
  "qwen-chat-template",
  "openrouter",
  "together",
  "baseten",
];

export interface ProviderProfile {
  readonly label: string;
  /** Profile default; absent for `wudao` (OpenAI-compatible endpoint, must be configured). */
  readonly defaultBaseUrl?: string;
  readonly defaultModel: string;
  /** When true, resolution fails (with a friendly reason) unless an explicit baseUrl is set. */
  readonly requiresBaseUrl?: boolean;
  /** Which matrix entry shapes the reasoning fields; defaults to `deepseek`. */
  readonly reasoningFormat?: ReasoningFormat;
  /** effort → native level mapping (null = the level is unsupported on this endpoint). */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  /** Whether the endpoint takes a top-level `reasoning_effort` rider alongside
   *  the format's envelope. Pinned per profile; unpinned profiles sniff the baseUrl. */
  readonly supportsReasoningEffort?: boolean;
  /** M48 §2: this provider's finishes are known to come back reasoning-only
   *  (reasoning present, content and tool_calls empty) — the degenerate shape
   *  the terminal-repair pair handles with one frozen replay. Default true on
   *  the deepseek / zai-format profiles, false elsewhere. */
  readonly acceptsReasoningOnlyFinish?: boolean;
  /** 夜移 022: this endpoint is known to omit reasoning on VALID
   *  thinking-enabled tool turns (Reasonix reasoning_replay_policy.go: zhipu
   *  does; replay is only owed when the turn actually carried reasoning).
   *  Such a turn is the provider's legitimate shape, not a malformed one —
   *  the missing-reasoning terminal repair skips it. Default false. */
  readonly omitsReasoningOnToolTurns?: boolean;
  /** ω99-39: this endpoint DISCARDS client-sent `reasoning_content` — the
   *  replay contract's bytes are never counted and never join cache
   *  matching, so serializing them is pure waste and silently defeats the
   *  user's WUDAO_REASONING_REPLAY intent. A probe-verified FACT (not a
   *  doc transcription — ω99-33 §5.2: billing face P2−P1=0 / P4−P3=0 AND
   *  cache face, 7-leg live probe, DeepSeek v4-flash), pinned ONLY where
   *  both proofs exist: deepseek today. GLM/Qwen/wudao are unprobed and
   *  MUST stay unpinned (byte-identical). Caps the user's intent at the
   *  resolution seam (see capClientReasoningReplay) — not a new knob. */
  readonly dropsClientReasoningReplay?: boolean;
  /** ω-2b (I1-c): how this endpoint counts the context window against a
   *  request. "shared" — prompt and completion draw on ONE window (DeepSeek:
   *  a prompt at 63% can still 400 because max_tokens pushed the total over);
   *  "independent" — separate prompt/completion budgets; "unknown" (default)
   *  — not characterized. Gates ONLY the loop's proactive admission clip
   *  (the reactive clip-retry is trusted-parse-gated, not profile-gated). */
  readonly windowMode?: WindowMode;
  /** 0.3.12: the wire (protocol) this profile speaks NATIVELY — the builtin
   *  anthropic id carries "anthropic" so selecting it needs no WUDAO_WIRE.
   *  Resolution: selection.wire > env WUDAO_WIRE > profile.wire (an explicit
   *  override must still beat the profile's native protocol). */
  readonly wire?: ProtocolId;
  /** Coding-plan gateways (glm-code / kimi-code / minimax-code): the
   *  endpoint prefers `Authorization: Bearer` auth (Kimi/MiniMax official
   *  docs set ANTHROPIC_AUTH_TOKEN). When true the anthropic-wire adapter
   *  ADDS the bearer header alongside x-api-key (both accepted; dual-send
   *  is the widest compatibility face). Absent = the historical header set,
   *  byte-identical — the real anthropic builtin must never pin this. */
  readonly bearerAuth?: boolean;
  /** P0-4 (96 队列): the provider's documented wallet-balance endpoint (GET,
   *  Bearer-authed). Only deepseek pins one today; every other profile stays
   *  undefined — NO documented balance API means the readout is silently
   *  omitted (graceful omission is the design, not a debt — Reasonix
   *  discipline). A user overlay/custom may set its own. */
  readonly balanceUrl?: string;
  /** ω99-64 (controller ruling): the endpoint's transport-layer extra request
   *  headers — a gateway-fronting fact of the SAME class as baseUrl /
   *  wire / balanceUrl, folded through the effectiveProfiles overlay merge
   *  (an overlay's row beats the builtin; builtins carry none today).
   *  resolveProviderConfigResult copies it onto ProviderConfig.extraHeaders;
   *  FORBIDDEN keys (auth/transport-control, persona/schema single source)
   *  refuse the row at the registry seam — the adapter owns auth. NOT
   *  binding-chain data: unlike `persona` this IS a profile fact. The
   *  2026-08-24 reg-headers stance ("deliberately never an EffectiveProfile
   *  fact") is REVERSED by this arc — headers are endpoint transport facts. */
  readonly headers?: Readonly<Record<string, string>>;
  /** 反馈① 收口 (2026-08-29 夜): per-model context windows for the builtin
   *  catalog. A pin exists ONLY where the number comes from the provider's
   *  own docs — a wrong pin (late autocompact → provider 413) is worse than
   *  the env fallback, so uncataloged names keep falling through. A user
   *  overlay's models list REPLACES the builtin one wholesale (registry
   *  semantics; see effectiveProfiles). */
  readonly models?: readonly ProviderModelEntry[];
  /** Profile-level window default. No builtin pins this today: every
   *  doc-verified pin is per-model because the provider lines mix window
   *  sizes (glm-4.6 204_800 vs glm-4.5 128K on the same profile). */
  readonly defaultContextLength?: number;
  /** 取证弧 0921（polyglot 三败题根因）: completion cap the anthropic-wire
   *  adapter should send when nothing explicit does. Pinned ONLY where
   *  live-verified (glm-code 16384/32768 both probe-accepted 2026-09-21);
   * absent = the adapter's conservative 4096 default, byte-identical
   *  history. Root cause this kills: glm-5.3 burns 4096 tokens on pure
   *  reasoning before the first tool call → stop:length → zero output
   *  (polyglot paasio 0/25 deterministic death; 49 length-stops across 8
   *  forensics runs). Per-call maxTokens still wins at the adapter's
   *  input ?? config seam. */
  readonly defaultMaxTokens?: number;
  /** 取证弧 0921: the output-limit ladder's continuation tier — HIGHER than
   *  defaultMaxTokens when both are set (same value would no-op: escalation
   *  fires only on cap-free requests, and the registry cap rides config,
   *  so equal tiers cancel). Loop 夜移 013's contract: "supply it from the
   *  provider profile, never a magic 64k". Absent = no escalation. */
  readonly outputEscalateTo?: number;
}

/** The ω-2b window-semantics union, named (registry/UserProviderConfig reuses it). */
export type WindowMode = "shared" | "independent" | "unknown";

export const PROVIDER_PROFILES: Readonly<Record<BuiltinProviderName, ProviderProfile>> = {
  deepseek: {
    label: "deepseek",
    defaultBaseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-v4-flash",
    reasoningFormat: "deepseek",
    acceptsReasoningOnlyFinish: true,
    windowMode: "shared",
    // ω99-39: the ONLY probe-backed pin (ω99-33 §5.2 — billing + cache both
    // inert for client-sent reasoning_content). Until another endpoint gets
    // its own probe, this stays deepseek-only.
    dropsClientReasoningReplay: true,
    // P0-4 (96 队列): api-docs.deepseek.com's wallet-balance endpoint — the
    // one builtin with a documented GET /user/balance.
    balanceUrl: "https://api.deepseek.com/user/balance",
    // 反馈① 收口 (2026-08-29 夜): api-docs.deepseek.com/quick_start/pricing
    // lists ONE CONTEXT LENGTH row — 1M — for the whole v4 line. "1M" is
    // read literally as 1_000_000 (conservative vs 1_048_576: autocompact
    // fires a hair earlier, never later). The discontinued legacy aliases
    // (deepseek-chat/reasoner, 128K-era) stay uncataloged → env fallback.
    models: [
      { name: "deepseek-v4-flash", contextLength: 1_000_000 },
      { name: "deepseek-v4-pro", contextLength: 1_000_000 },
      { name: "deepseek-v4-flash-vision-exp", contextLength: 1_000_000 },
    ],
  },
  // glm (zai format): the M16 `thinking:{type}` transform now lives in the
  // matrix — the zai envelope plus a thinkingLevelMap folding each effort
  // onto enabled/disabled. bigmodel.cn takes no reasoning_effort rider.
  glm: {
    label: "glm",
    defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
    defaultModel: "glm-4.6",
    reasoningFormat: "zai",
    thinkingLevelMap: { low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" },
    supportsReasoningEffort: false,
    acceptsReasoningOnlyFinish: true,
    // 夜移 022: bigmodel endpoints may legitimately omit reasoning on
    // thinking-enabled tool turns (Reasonix reasoning_replay_policy.go:13-24).
    omitsReasoningOnToolTurns: true,
    // 反馈① 收口 (2026-08-29 夜): docs.z.ai/guides/llm/glm-4.6 — 200K
    // (= 204_800) context. Per-model, NOT a provider default: glm-4.5 and
    // older are 128K, a profile-level 204_800 would over-window them.
    models: [{ name: "glm-4.6", contextLength: 204_800 }],
  },
  // qwen (dashscope compatible-mode): enable_thinking only, no rider. The
  // reasoning-only degenerate finish is not a known qwen shape — repair off.
  qwen: {
    label: "qwen",
    defaultBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultModel: "qwen3-max",
    reasoningFormat: "qwen",
    supportsReasoningEffort: false,
    acceptsReasoningOnlyFinish: false,
    // 反馈① 收口 (2026-08-29 夜): help.aliyun.com/en/model-studio/
    // model-qwen3-max — 262_144 context (258_048 max input). The qwen
    // catalog is huge and window-varying; only the doc-verified default
    // model is pinned.
    models: [{ name: "qwen3-max", contextLength: 262_144 }],
  },
  wudao: { label: "wudao", defaultBaseUrl: undefined, defaultModel: "wudao-preview", requiresBaseUrl: true, reasoningFormat: "deepseek", acceptsReasoningOnlyFinish: true },
  // anthropic (0.3.12): the messages-protocol builtin — the adapter itself
  // (anthropic.ts) predates the profile; this entry is what makes it
  // SELECTABLE as a first-class provider (settings cards, /provider switch,
  // --provider). x-api-key + anthropic-version headers live in the adapter;
  // thinking rides the effort→budget_tokens map (no reasoningFormat
  // envelope); the window is independent (max_tokens is a completion-only
  // budget, unlike deepseek's shared window).
  anthropic: {
    label: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    defaultModel: "claude-sonnet-5",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    windowMode: "independent",
    wire: "anthropic",
  },
  // ── 按量平台 API（0.3.30 两套拆分） ──────────────────────────────────
  // kimi 与 minimax 的按 token 计费端点——与各自的 *-code 订阅网关成对：
  // 同一厂商，两条计费路，用户按持有的是 API key 还是订阅来选。
  kimi: {
    label: "kimi",
    defaultBaseUrl: "https://api.moonshot.cn/anthropic",
    defaultModel: "kimi-k3",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    windowMode: "independent",
    wire: "anthropic",
    bearerAuth: true,
    // platform.kimi.com/docs/guide/a reference harness-kimi AUTO_COMPACT_WINDOW
    // table, verbatim numbers. kimi-k2.6 has NO documented window — left
    // unpinned (a wrong pin fires autocompact late → 413; env fallback is
    // safer). Known edge: kimi-k2.7-code demands explicit thinking — effort
    // none (no thinking block sent) 400s on it; the default kimi-k3 is
    // unconstrained.
    models: [
      { name: "kimi-k3", contextLength: 1_048_576 },
      { name: "kimi-k2.7-code", contextLength: 262_144 },
      { name: "kimi-k2.7-code-highspeed", contextLength: 262_144 },
      { name: "kimi-k2.6" },
    ],
  },
  minimax: {
    label: "minimax",
    defaultBaseUrl: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M3",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    // 平台 API（按量）走 OpenAI chat 线（wire 省略 = openai-chat，与
    // deepseek/glm/qwen 的按量条目同构）。窗口数未在按量文档核实——不钉
    // （错钉比漏钉危险：晚 autocompact → 413）。
    models: [{ name: "MiniMax-M3" }],
  },
  // ── Coding-plan gateways (0.3.26 弧；0.3.30 kimi-code 指向订阅端) ────
  // 智谱 GLM Coding Plan / Kimi Coding Plan / MiniMax Token Plan — three
  // Anthropic-messages mirrors of the SAME shape as the anthropic builtin
  // (adapter URL joins base + /v1/messages; thinking rides the
  // effort→budget_tokens map; independent window). glm-code/minimax-code
  // auth via ANTHROPIC_AUTH_TOKEN so the adapter dual-sends Authorization:
  // Bearer; kimi-code's official config uses ANTHROPIC_API_KEY — x-api-key
  // only, no bearerAuth flag.
  "glm-code": {
    label: "glm-code",
    defaultBaseUrl: "https://open.bigmodel.cn/api/anthropic",
    defaultModel: "glm-5.3",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    windowMode: "independent",
    wire: "anthropic",
    bearerAuth: true,
    // 取证弧 0921: probe-verified completion tiers (16384 base / 32768
    // escalation) — kills the 4096-default reasoning-exhaustion death.
    defaultMaxTokens: 16_384,
    outputEscalateTo: 32_768,
    // docs.bigmodel.cn/cn/coding-plan/quick-start: both cataloged models
    // are 1M context (official model cards).
    models: [
      { name: "glm-5.3", contextLength: 1_000_000 },
      { name: "glm-5.3-flash", contextLength: 1_000_000 },
    ],
  },
  // Kimi Coding Plan 订阅网关（0.3.30 重指向）：官方 Claude Code 接入页
  // 的订阅路径——api.kimi.com/coding，模型 k3-256k、窗口 262144（用户
  // settings.json 的 AUTO_COMPACT_WINDOW 原数）。鉴权按官方配置走
  // ANTHROPIC_API_KEY（x-api-key only——省略 bearerAuth，与 glm-code/
  // minimax-code 的 AUTH_TOKEN 双发不同）。按量平台 API 见上方 `kimi`。
  "kimi-code": {
    label: "kimi-code",
    defaultBaseUrl: "https://api.kimi.com/coding",
    defaultModel: "k3-256k",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    windowMode: "independent",
    wire: "anthropic",
    models: [{ name: "k3-256k", contextLength: 262_144 }],
  },
  "minimax-code": {
    label: "minimax-code",
    defaultBaseUrl: "https://api.minimaxi.com/anthropic",
    defaultModel: "MiniMax-M3",
    reasoningFormat: "none",
    acceptsReasoningOnlyFinish: false,
    windowMode: "independent",
    wire: "anthropic",
    bearerAuth: true,
    // platform.minimaxi.com/docs/token-plan/other-tools: M3 up to 1M.
    models: [{ name: "MiniMax-M3", contextLength: 1_000_000 }],
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDER_PROFILES) as readonly BuiltinProviderName[];

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "max", "none"];

// M47 §1 (B1): the reasoning-replay contract. The harness STORES
// AssistantMessage.reasoning end-to-end, but whether it rides back OUT on the
// wire is a per-provider decision (CLAUDE.md §4.4): domestic reasoning models
// expect historical reasoning_content on tool-call turns; others regenerate.
//   never (default) — status quo, nothing replayed (byte-identical requests);
//   toolCallTurns  — ONLY assistant messages carrying tool_calls;
//   always         — every assistant message that has reasoning.
export type ReasoningReplay = "never" | "toolCallTurns" | "always";

export const REASONING_REPLAYS: readonly ReasoningReplay[] = ["never", "toolCallTurns", "always"];

/** Parse/fail-fast the replay value (WUDAO_REASONING_REPLAY). */
export function parseReasoningReplay(v: string): ReasoningReplay {
  if (!(REASONING_REPLAYS as readonly string[]).includes(v)) {
    throw new Error(`invalid reasoning replay "${v}" (expected one of: ${REASONING_REPLAYS.join(", ")})`);
  }
  return v as ReasoningReplay;
}

/** Narrow to the compiled-in four (pure, compile-time table). Providers-internal
 *  and evals use this; the registry adds customs on top at the CLI layer. */
export function isBuiltinProviderName(v: string): v is BuiltinProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(v);
}

/** Historical spelling of `isBuiltinProviderName` — retained for existing
 *  consumers (cli, evals). Still narrows to the builtin union. */
export function isProviderName(v: string): v is BuiltinProviderName {
  return isBuiltinProviderName(v);
}

/** Everything the engine needs to shape reasoning fields for one request. */
export interface ReasoningRequestContext {
  readonly format: ReasoningFormat;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  readonly supportsReasoningEffort: boolean;
}

/** Response fields that may carry reasoning text, format-preferred first. */
export function reasoningResponseFields(format: ReasoningFormat): readonly string[] {
  switch (format) {
    case "openrouter":
    case "together":
      return ["reasoning", "reasoning_content", "thinking"];
    default:
      // deepseek / zai / qwen / qwen-chat-template / baseten / none all favor
      // the domestic spelling, with the other two as fallbacks.
      return ["reasoning_content", "reasoning", "thinking"];
  }
}

/** First present reasoning field on a message/delta object, else undefined. */
export function pickReasoning(fields: readonly string[], source: Record<string, unknown>): string | undefined {
  for (const f of fields) {
    const v = source[f];
    if (typeof v === "string" && v !== "") return v;
  }
  return undefined;
}

/** Native level for an effort under a map: the mapped value, the effort
 *  itself when unmapped, or null when the map explicitly unsupports it. */
function nativeLevel(
  effort: ReasoningEffort,
  map?: Readonly<Record<string, string | null>>,
): string | null {
  const mapped = map?.[effort];
  return mapped === undefined ? effort : mapped;
}

/** The ONE request-side implementation of the matrix (M16's per-profile
 *  transforms folded in; single point, no scattered ifs). Pure: returns only
 *  the extra fields to merge into the chat-completions body; never called
 *  when no effort is configured. */
export function reasoningFormatBody(
  ctx: ReasoningRequestContext,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const level = nativeLevel(effort, ctx.thinkingLevelMap);
  const enable = effort !== "none";
  // The reasoning_effort rider: only formats whose envelope leaves the effort
  // VALUE unstated, and only endpoints that accept the field.
  const rider = (): Record<string, unknown> =>
    ctx.supportsReasoningEffort && level !== null ? { reasoning_effort: level } : {};
  switch (ctx.format) {
    case "none":
      return {};
    case "deepseek":
      return level === null ? {} : { reasoning_effort: level };
    case "zai": {
      if (level === null) return {};
      const mapped = ctx.thinkingLevelMap?.[effort];
      const type = mapped !== undefined ? mapped : enable ? "enabled" : "disabled";
      return { thinking: { type }, ...rider() };
    }
    case "qwen":
      return { enable_thinking: enable, ...rider() };
    case "qwen-chat-template":
      return { chat_template_kwargs: { enable_thinking: enable, preserve_thinking: true } };
    case "openrouter":
      return level === null ? {} : { reasoning: { effort: level } };
    case "together":
      return { reasoning: { enabled: enable }, ...rider() };
    case "baseten":
      return { chat_template_args: { enable_thinking: enable }, ...rider() };
  }
}

/** ω99-42: the repair body a mandatory-reasoning rejection re-sends with —
 *  the matrix's EXPLICIT enable, at the medium default level (hermes' own
 *  default reasoning effort; every format in the tree can express it), with
 *  the thinkingLevelMap deliberately STRIPPED: the map is exactly what folds
 *  low/medium onto "disabled", so a mapped repair would resend the very
 *  disable the endpoint just rejected. `{}` for the "none" format — that
 *  wire cannot express reasoning, the repair is impossible, and the
 *  rejection stays terminal. Pure: returns only the extra fields to merge
 *  into the chat-completions body (same contract as reasoningFormatBody). */
export function mandatoryRepairReasoningBody(ctx: ReasoningRequestContext): Record<string, unknown> {
  return reasoningFormatBody({ format: ctx.format, supportsReasoningEffort: ctx.supportsReasoningEffort }, "medium");
}

/** Resolve the reasoning request context for a config: explicit config fields
 *  beat the selected profile's defaults; unpinned rider gates sniff the baseUrl. */
export function resolveReasoningContext(config: ProviderConfig): ReasoningRequestContext {
  const profile = config.provider !== undefined && isProviderName(config.provider)
    ? PROVIDER_PROFILES[config.provider]
    : undefined;
  const map = config.thinkingLevelMap ?? profile?.thinkingLevelMap;
  return {
    format: config.reasoningFormat ?? profile?.reasoningFormat ?? "deepseek",
    ...(map !== undefined ? { thinkingLevelMap: map } : {}),
    supportsReasoningEffort: config.supportsReasoningEffort
      ?? profile?.supportsReasoningEffort
      ?? supportsReasoningEffort(config.baseURL),
  };
}

/** URL sniff (custom baseUrls): does this endpoint take a top-level
 *  `reasoning_effort`? Mirrors pi's detection — the domestic and gateway
 *  endpoints known to reject the field say false, everything else true. */
export function supportsReasoningEffort(baseURL: string): boolean {
  const url = baseURL.toLowerCase();
  const reject = [
    "api.z.ai",
    "open.bigmodel.cn",
    "api.together.ai",
    "api.together.xyz",
    "api.moonshot.",
    "api.x.ai",
    "integrate.api.nvidia.com",
    "api.ant-ling.com",
    "gateway.ai.cloudflare.com",
  ];
  return !reject.some((h) => url.includes(h));
}

// Validate a reasoning-effort value; throws on junk so typos fail fast at
// resolution time instead of silently shaping requests.
export function parseReasoningEffort(v: string): ReasoningEffort {
  if (!(REASONING_EFFORTS as readonly string[]).includes(v)) {
    throw new Error(`invalid reasoning effort "${v}" (expected one of: ${REASONING_EFFORTS.join(", ")})`);
  }
  return v as ReasoningEffort;
}

// R2 T2 — the wire adapters' (anthropic/responses) effort plumbing, the same
// contract the openai engine applies internally (M58 §C). Exported from the
// module (not the package index): these are adapter-internal seams.
/** Validate a per-input reasoning effort ONCE at the adapter's public
 *  boundary, BEFORE the retry ladder — the fail-fast parse error must never
 *  walk the ladder (junk can never succeed on retry). The parsed value rides
 *  the returned input; absent/empty = the input unchanged (the config's own
 *  effort applies). */
export function validatedInputEffort(input: ModelInput): ModelInput {
  if (input.reasoningEffort === undefined || input.reasoningEffort === "") return input;
  return { ...input, reasoningEffort: parseReasoningEffort(input.reasoningEffort) };
}

/** The request's EFFECTIVE reasoning effort — a per-input effort (already
 *  validated at the adapter boundary) overrides the config's own; absent
 *  both = undefined (no effort field on the wire — byte-identical status
 *  quo, the prefix-cache red line). */
export function effectiveReasoningEffort(
  input: Pick<ModelInput, "reasoningEffort">,
  config: ProviderConfig,
): ReasoningEffort | undefined {
  return input.reasoningEffort !== undefined && input.reasoningEffort !== ""
    ? (input.reasoningEffort as ReasoningEffort)
    : config.reasoningEffort;
}

// Same fail-fast contract for the format matrix.
export function parseReasoningFormat(v: string): ReasoningFormat {
  if (!(REASONING_FORMATS as readonly string[]).includes(v)) {
    throw new Error(`invalid reasoning format "${v}" (expected one of: ${REASONING_FORMATS.join(", ")})`);
  }
  return v as ReasoningFormat;
}

// Persona Phase B (design 93 §4.2-1): the wire (protocol) a config speaks —
// which adapter createProvider dispatches to. Fail-fast on junk values so a
// typo'd WUDAO_WIRE dies at selection time, not as a silent openai request.
export function parseWire(v: string): ProtocolId {
  if (!(PROTOCOL_IDS as readonly string[]).includes(v)) {
    throw new Error(`invalid wire "${v}" (expected one of: ${PROTOCOL_IDS.join(", ")})`);
  }
  return v as ProtocolId;
}

export interface ProviderConfig {
  readonly apiKey: string;
  /** M56 §1: the multi-key pool (primary first, deduped). `apiKey` is always
   *  `apiKeys[0]` — single-key configs keep the historical one-element shape
   *  and the engine rotates over whatever is here when more keys exist. */
  readonly apiKeys?: readonly string[];
  readonly baseURL: string;
  readonly model: string;
  /** Selected profile; always set by resolveProviderConfig, optional for hand-built configs. */
  readonly provider?: ProviderName;
  /** Set only when an effort is configured — absent means no extra request field. */
  readonly reasoningEffort?: ReasoningEffort;
  /** ω99-42: the config's `reasoningEffort: "none"` is a CODE default (a
   *  cheap-call policy — e.g. the sidecar classifier's config), not a user
   *  pin. A mandatory-reasoning endpoint's 400 is then repairable (one retry
   *  with reasoning enabled). Absent = the effort is user-pinned, and an
   *  explicit "none" is never silently rewritten — the rejection surfaces
   *  typed, with guidance, unrepaired. */
  readonly softReasoningNone?: boolean;
  /** Matrix entry; resolved from the profile when hand-built configs omit it. */
  readonly reasoningFormat?: ReasoningFormat;
  /** 夜移 011: peel a turn-initial in-band `<think>…</think>` block out of
   *  the content stream into reasoning (the vLLM chat-template CoT lane).
   *  Default: derived from the format (`qwen-chat-template` on, everything
   *  else off) — see resolveSplitInbandThinking. */
  readonly splitInbandThinking?: boolean;
  /** effort → native level mapping; resolved from the profile when omitted. */
  readonly thinkingLevelMap?: Readonly<Record<string, string | null>>;
  /** Explicit rider gate; defaults to the profile pin, then the baseUrl sniff. */
  readonly supportsReasoningEffort?: boolean;
  /** M45: hard completion cap sent as `max_tokens` — set for budget-critical
   *  side calls (the auto-mode sidecar classifier); absent = no field on the
   *  wire (the main loop's requests stay byte-identical). */
  readonly maxTokens?: number;
  /** M47 §1: when AssistantMessage.reasoning is serialized back out as
   *  `reasoning_content` (never | toolCallTurns | always; default never =
   *  byte-identical status quo). Set via WUDAO_REASONING_REPLAY. */
  readonly reasoningReplay?: ReasoningReplay;
  /** M48 §2: terminal-shape repair gate — resolved from the profile when the
   *  hand-built config omits it (deepseek/glm/wudao true, qwen false). */
  readonly acceptsReasoningOnlyFinish?: boolean;
  /** 夜移 022: legitimate reasoning omission on tool turns — explicit beats
   *  the profile (glm true), default false. Gates ONLY the
   *  missing-reasoning repair; the reasoning-only shape keeps its own flag. */
  readonly omitsReasoningOnToolTurns?: boolean;
  /** M62 §7: ordered model fallback chain (same provider/key pool). After
   *  the primary's retry ladder exhausts with a MODEL-class failure (5xx /
   *  overload / 404 / transport — never key-class 401/403, never abort or
   *  context overflow), the call retries on the next name in order; the
   *  usage receipt annotates fallbackModel/fallbackFrom. Orthogonal to the
   *  M56 key pool (model failure ≠ credential failure). */
  readonly fallbackModels?: readonly string[];
  /** M79 §3: explicit per-model input-modality pin (e.g. a custom
   *  OpenAI-compatible endpoint fronting a vision model). Beats the model
   *  catalog (models.ts); absent → the catalog's verdict, uncataloged →
   *  text-only (fail-closed — images then fail with UNSUPPORTED_CONTENT
   *  before any network call). Capability is exact model metadata, never a
   *  provider-level fact. */
  readonly inputModalities?: readonly ("text" | "image")[];
  /** ω-2b (I1-c): the profile's window semantics, resolved from it when a
   *  hand-built config omits the field (deepseek = shared; everything else
   *  unknown). The CLI threads it into the loop's compaction options, where
   *  it gates the proactive admission clip ONLY. */
  readonly windowMode?: WindowMode;
  /** Persona Phase B (design 93 §4.2-1): the protocol this config speaks —
   *  createProvider dispatches on it ("anthropic" → the messages adapter,
   *  "responses" → the responses adapter, absent → the historical
   *  openai-compatible engine, byte-identical). ORTHOGONAL to the vendor
   *  profile (no fourth profile dimension): resolution is
   *  selection.wire > env WUDAO_WIRE > absent. */
  readonly wire?: ProtocolId;
  /** Coding-plan gateways: the anthropic-wire adapter dual-sends
   *  `authorization: Bearer` alongside x-api-key when true. Folded from the
   *  profile like windowMode; absent on every historical config. */
  readonly bearerAuth?: boolean;
  /** P0-4 (96 队列): the provider's wallet-balance endpoint, folded from the
   *  profile exactly like bearerAuth. Absent = no balance face (the /cost all
   *  readout silently omits the provider). Never consumed by request
   *  construction — the balance fetch is an offline-side call. */
  readonly balanceUrl?: string;
  /** ω99-64: the provider card's extra request headers (the registry row's
   *  `headers` column, folded through the effective profile) — the last mile
   *  of the enterprise-gateway column 92 §3.4-1 reserved. The adapters
   *  spread them AFTER their own auth headers and BEFORE persona
   *  wire.headers: priority adapter auth > persona (per-request persona
   *  override) > registry (per-provider baseline). The seam defensively
   *  skips the full FORBIDDEN_HEADER_KEYS set (14 keys — single source
   *  header-validation.ts, ω99-69), a superset of the reserved credential
   *  keys (gatewayExtraHeaders — hand-built configs bypass the registry
   *  validator; the registry refuses them at save AND load). Absent =
   *  nothing on the wire, byte-identical; an empty {} spreads to nothing. */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Persona fallback (spec §6): data-only. CLI resolves the registry and
   *  constructs PersonaRuntime from this at startup. */
  readonly persona?: { readonly id: string; readonly layers?: Partial<LayerFlags> };
}

// Explicit selection (CLI flags), taking precedence over WUDAO_PROVIDER /
// WUDAO_REASONING_EFFORT / WUDAO_REASONING_FORMAT / WUDAO_WIRE.
export interface ProviderSelection {
  readonly provider?: string;
  readonly reasoningEffort?: string;
  /** R3-T002 深测弧：显式 --model 旗标（最高优先，越过 env 钉——仓库树
   *  .env 的 WUDAO_MODEL 不再劫持 --provider 切换）。空串=未选。 */
  readonly model?: string;
  /** R3-T002（续）：枚举面的豁免标记。目录哨兵只对「用户/环境钉的模型 ×
   *  所选 provider」这种可证伪配对设防；矩阵扫描类调用方（goal 的
   *  cheapestMatrixModel、workflow 的 routePreflight）逐个 provider 试解，
   *  env 模型与某成员目录不合=跳过该成员，不是致命错。置 true 关哨兵。 */
  readonly allowEnvModelMismatch?: true;
  /** Phase B: the wire leg of the selection chain (see ProviderConfig.wire). */
  readonly wire?: string;
}

export type ProviderConfigResult =
  | { readonly ok: true; readonly config: ProviderConfig }
  | { readonly ok: false; readonly reason: string };

export const NO_KEY_REASON = "no API key found";

/** M56 §1: the key POOL from env — `WUDAO_API_KEYS` (comma-separated) riding
 *  alongside the historical single `WUDAO_API_KEY` (or `OPENAI_API_KEY`
 *  fallback). The single key stays the PRIMARY (first), the comma list adds
 *  the rest, everything deduped order-preserving. Empty when no key at all —
 *  `resolveProviderConfigResult` keeps failing with NO_KEY_REASON. */
export function parseApiKeyPool(env: NodeJS.ProcessEnv): string[] {
  const pool: string[] = [];
  const push = (raw: string | undefined): void => {
    for (const part of (raw ?? "").split(",")) {
      const key = part.trim();
      if (key !== "" && !pool.includes(key)) pool.push(key);
    }
  };
  push(env.WUDAO_API_KEY ?? env.OPENAI_API_KEY);
  push(env.WUDAO_API_KEYS);
  return pool;
}

// M63 §B — the credentials-file fallback seam. Provider ids → API keys (the
// CLI's ~/.wudao/.credentials.yaml map). Resolution order is FIXED and
// documented: ENV WINS — the WUDAO_API_KEY / OPENAI_API_KEY / WUDAO_API_KEYS
// pool is consulted first, and ONLY when it is empty does the selected
// provider's credentials-file entry fill in. A CI env key must never be
// silently shadowed by a stale on-disk entry.
export type CredentialsMap = Readonly<Record<string, string>>;

// Resolve provider config from env + explicit selection. Fails (ok:false) with
// a human-readable reason when no API key is present or the profile requires a
// baseUrl that was not provided — so callers can fall back to guidance instead
// of crashing. Throws on unknown provider names / invalid effort or format values.
// The optional `providers` map (provider management R2) is the effective view
// from the registry (builtins ⊕ overlays ⊕ customs): a selected id that hits
// it resolves against that profile — a custom provider builds on its registry
// baseUrl, a builtin overlay rides the compiled-in defaults. Absent map =
// the historical builtin-only behavior, byte for byte.
export function resolveProviderConfigResult(
  env: NodeJS.ProcessEnv = process.env,
  selection: ProviderSelection = {},
  credentials?: CredentialsMap,
  providers?: ReadonlyMap<string, EffectiveProfile>,
): ProviderConfigResult {
  const nameRaw = selection.provider ?? env.WUDAO_PROVIDER;
  let provider: ProviderName = "deepseek";
  if (nameRaw !== undefined && nameRaw !== "") {
    if (!isProviderName(nameRaw) && providers?.get(nameRaw) === undefined) {
      throw new Error(
        `unknown provider "${nameRaw}" (expected one of: ${PROVIDER_NAMES.join(", ")}, `
          + `or a custom provider from the registry (~/.wudao/providers.json))`,
      );
    }
    provider = nameRaw;
  }

  // M56 §1: keys resolve as a POOL (single key = one-element pool). M63 §B:
  // an empty env pool falls back to the credentials map's entry for the
  // SELECTED provider (env wins — see the seam comment above). The file key
  // becomes a one-element pool, preserving the historical shape. Registry ids
  // resolve keys the same way (the credentials file accepts any ID_RE id).
  let apiKeys = parseApiKeyPool(env);
  if (apiKeys.length === 0 && credentials !== undefined) {
    const fileKey = (credentials[provider] ?? "").trim();
    if (fileKey !== "") apiKeys = [fileKey];
  }
  const apiKey = apiKeys[0];

  // The registry's effective view wins when present (it already folds the
  // builtin base for overlays); otherwise the compiled-in profile.
  const registered = providers?.get(provider);
  let profile: ProviderProfile | undefined = registered
    ?? (isProviderName(provider) ? PROVIDER_PROFILES[provider] : undefined);
  if (profile === undefined) {
    // Unreachable — the unknown-provider guard above threw for exactly this
    // shape — but fail loudly rather than guess a profile if that breaks.
    throw new Error(`unknown provider "${provider}"`);
  }

  if (!apiKey) return { ok: false, reason: NO_KEY_REASON };

  const baseURL = env.WUDAO_BASE_URL ?? env.OPENAI_BASE_URL;
  if (baseURL === undefined && profile.requiresBaseUrl) {
    // R-M3 (T1 review): requiresBaseUrl demands an EXPLICIT url — the env
    // override, or one the REGISTRY itself supplied (a custom's baseUrl, an
    // overlay's own baseUrl). The builtin's compiled-in defaultBaseUrl must
    // NOT satisfy an overlay's requiresBaseUrl (the whole point of the flag:
    // "route me anywhere except the vendor default"). Same refusal shape as
    // the historical wudao case; absent a registry the behavior is unchanged.
    const builtinDefault = isProviderName(provider) ? PROVIDER_PROFILES[provider].defaultBaseUrl : undefined;
    const registrySupplied = profile.defaultBaseUrl !== undefined && profile.defaultBaseUrl !== builtinDefault;
    if (!registrySupplied) {
      return { ok: false, reason: `${provider} provider needs WUDAO_BASE_URL` };
    }
  }

  // R3-T002 深测弧：模型来源三档（旗标 > env > profile 缺省）——哨兵只对
  // 前两档设防（用户/环境钉的），profile 缺省永远合法。
  const modelSource: "flag" | "env" | "profile" =
    selection.model !== undefined && selection.model !== "" ? "flag"
    : env.WUDAO_MODEL !== undefined && env.WUDAO_MODEL !== "" || env.OPENAI_MODEL !== undefined && env.OPENAI_MODEL !== "" ? "env"
    : "profile";
  const model = modelSource === "flag" ? (selection.model ?? "")
    : modelSource === "env" ? (env.WUDAO_MODEL ?? env.OPENAI_MODEL ?? "")
    : (profile.defaultModel ?? "");
  // R-M2 (T1 review): a CUSTOM provider saved without defaultModel and without
  // models resolves "" here — fail fast at selection time, naming the fix.
  // (Saving that shape stays allowed; only running it refuses.) Builtins never
  // hit this (their defaultModel is a non-empty constant).
  if (model === "" && registered?.custom === true) {
    throw new Error(
      `custom provider "${provider}" has no model to run — set "defaultModel" or add a "models" list to its entry in ~/.wudao/providers.json (or set WUDAO_MODEL)`,
    );
  }

  // R3-T002 深测弧（永续迭代）：环境钉的模型静默覆盖所选 provider 的目录
  // 缺省——实证形态：仓库树里某层 .env 带 WUDAO_MODEL=deepseek-v4-flash
  // （CLI 从 cwd 向上自动加载），`--provider glm-code` 于是拼出
  // glm-code · deepseek-v4-flash，到厂商端点必然 404，报错零归因。可证
  // 伪的组合在选型时刻就拒绝、点名冲突与修法：模型确实来自 env、所选
  // provider 的目录非空且不含它、且 base URL 没有 env 网关覆盖（网关可
  // 路由任意模型名——config.test.ts 的网关钉守住这条豁免）。目录空的自
  // 定义 provider（私有网关常见形）不设防；profile 缺省模型永远合法。
  const catalog: readonly { readonly name: string }[] =
    registered?.models ?? (isProviderName(provider) ? PROVIDER_PROFILES[provider].models : []) ?? [];
  if (
    selection.allowEnvModelMismatch !== true &&
    modelSource !== "profile" &&
    model !== undefined &&
    model !== "" &&
    catalog.length > 0 &&
    !catalog.some((m) => m.name === model) &&
    baseURL === undefined
  ) {
    const source = modelSource === "flag" ? "--model" : env.WUDAO_MODEL !== undefined ? "WUDAO_MODEL" : "OPENAI_MODEL";
    throw new Error(
      `model "${model}" (from ${source}) is not offered by provider "${provider}" (catalog: ${catalog.map((m) => m.name).join(", ")}) — pick a catalog model, fix the env var (check a parent directory's .env), or set WUDAO_BASE_URL to a gateway that serves this model`,
    );
  }

  const effortRaw = selection.reasoningEffort ?? env.WUDAO_REASONING_EFFORT;
  const reasoningEffort = effortRaw !== undefined && effortRaw !== "" ? parseReasoningEffort(effortRaw) : undefined;

  const formatRaw = env.WUDAO_REASONING_FORMAT;
  const reasoningFormat = formatRaw !== undefined && formatRaw !== "" ? parseReasoningFormat(formatRaw) : undefined;

  const replayRaw = env.WUDAO_REASONING_REPLAY;
  const replayParsed = replayRaw !== undefined && replayRaw !== "" ? parseReasoningReplay(replayRaw) : undefined;
  // ω99-39 (案 A, T0-rulled): the probe-verified drop fact caps the intent
  // HERE, at the one assembly seam every downstream face reads — the wire
  // serialization, the replayedReasoningTokens forensics, and the
  // terminalRepairKind ladder all see the same "never" (case B's wire-only
  // suppression would leave the forensics claiming bytes the wire never
  // sent). The parse above still throws on junk FIRST (fail-fast red line).
  const reasoningReplay = capClientReasoningReplay(profile, replayParsed);

  // Phase B: selection.wire > env WUDAO_WIRE > the profile's native wire
  // (0.3.12: the anthropic builtin carries its protocol — selecting it needs
  // no WUDAO_WIRE; an explicit override still beats the profile) > absent
  // (the default "openai-chat" materializes at createProvider dispatch,
  // keeping the wire-absent config byte-identical to the historical shape).
  const wireRaw = selection.wire ?? env.WUDAO_WIRE ?? profile.wire;
  const wire = wireRaw !== undefined && wireRaw !== "" ? parseWire(wireRaw) : undefined;

  // WUDAO_PERSONA parsing: <id> or <id>:layers[,layers...] format
  let persona: ProviderConfig["persona"] = undefined;
  const personaSpec = env.WUDAO_PERSONA?.trim();
  if (personaSpec !== undefined && personaSpec !== "") {
    const parsed = parsePersonaSpec(personaSpec);
    if (!parsed.ok) {
      return { ok: false, reason: `invalid WUDAO_PERSONA: ${parsed.error}` };
    }
    persona =
      parsed.layers === undefined ? { id: parsed.id } : { id: parsed.id, layers: parsed.layers };
  }

  const resolvedBase = baseURL ?? profile.defaultBaseUrl ?? "";
  const supports = profile.supportsReasoningEffort ?? supportsReasoningEffort(resolvedBase);

  return {
    ok: true,
    config: {
      apiKey,
      apiKeys,
      baseURL: resolvedBase,
      model,
      provider,
      reasoningEffort,
      ...(reasoningFormat !== undefined
        ? { reasoningFormat }
        : registered !== undefined && registered.reasoningFormat !== undefined
          // Registry leg: the effective profile's format rides the config when
          // env doesn't override — custom ids have no compiled-in profile for
          // resolveReasoningContext to fall back on, and a builtin overlay must
          // beat the compiled-in pin. Without a registry the field stays
          // env-only (byte-identical historical behavior).
          ? { reasoningFormat: registered.reasoningFormat }
          : {}),
      ...(reasoningReplay !== undefined ? { reasoningReplay } : {}),
      ...(profile.thinkingLevelMap !== undefined ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
      supportsReasoningEffort: supports,
      // M48 §2: the reasoning-only repair gate is a profile fact (the shape
      // is a known deepseek/zai degenerate finish) — explicit beats profile.
      acceptsReasoningOnlyFinish: profile.acceptsReasoningOnlyFinish ?? false,
      // 夜移 022: the tool-turn reasoning-omission fact rides the resolved
      // config the same way (glm omits legitimately; default false).
      omitsReasoningOnToolTurns: profile.omitsReasoningOnToolTurns ?? false,
      // ω-2b (I1-c): the window semantics ride the resolved config (deepseek
      // = shared; the others stay unknown until characterized).
      ...(profile.windowMode !== undefined ? { windowMode: profile.windowMode } : {}),
      ...(wire !== undefined ? { wire } : {}),
      ...(profile.bearerAuth !== undefined ? { bearerAuth: profile.bearerAuth } : {}),
      // 取证弧 0921: the profile's completion cap rides the resolved config
      // (same fold pattern as bearerAuth; absent = unset, per-call explicit
      // maxTokens still wins at the adapter's input ?? config seam).
      ...(profile.defaultMaxTokens !== undefined ? { maxTokens: profile.defaultMaxTokens } : {}),
      // P0-4 (96 队列): the wallet-balance endpoint rides the resolved config
      // (the same fold pattern as bearerAuth).
      ...(profile.balanceUrl !== undefined ? { balanceUrl: profile.balanceUrl } : {}),
      // ω99-64: the profile's transport-layer header baseline rides the
      // resolved config (the registry row's `headers` column) — undefined
      // passes through as undefined: an unconfigured card changes nothing.
      ...(profile.headers !== undefined ? { extraHeaders: profile.headers } : {}),
      ...(persona !== undefined ? { persona } : {}),
    },
  };
}

/** M48 §2: the reasoning-only repair gate for the engine — explicit config
 *  field, then the selected profile's default, then false. */
export function acceptsReasoningOnlyFinish(config: ProviderConfig): boolean {
  if (config.acceptsReasoningOnlyFinish !== undefined) return config.acceptsReasoningOnlyFinish;
  if (config.provider !== undefined && isProviderName(config.provider)) {
    return PROVIDER_PROFILES[config.provider].acceptsReasoningOnlyFinish ?? false;
  }
  return false;
}

/** 夜移 022: the tool-turn reasoning-omission gate for terminal repair —
 *  the same three-step ladder as acceptsReasoningOnlyFinish (explicit config
 *  field, then the selected profile's default, then false). */
export function omitsReasoningOnToolTurns(config: ProviderConfig): boolean {
  if (config.omitsReasoningOnToolTurns !== undefined) return config.omitsReasoningOnToolTurns;
  if (config.provider !== undefined && isProviderName(config.provider)) {
    return PROVIDER_PROFILES[config.provider].omitsReasoningOnToolTurns ?? false;
  }
  return false;
}

/** 取证弧 0921: the output-limit ladder's escalateTo from the profile (loop
 *  夜移 013's contract: "supply it from the provider profile, never a magic
 *  64k"). Undefined = the ladder runs nudge-only, byte-identical history. */
export function outputLimitEscalateFor(provider: string | undefined): number | undefined {
  if (provider === undefined || !isProviderName(provider)) return undefined;
  return PROVIDER_PROFILES[provider].outputEscalateTo;
}

// ω99-39 — the once-per-process stderr tell. Providers has no warn/notice
// precedent (checked: no console.*/stderr anywhere in the package), so the
// pre-authorized fallback channel applies: ONE line at provider resolution,
// deduped process-wide (resolution runs several times per boot — run.ts,
// preflight, doctor — and must never spam). Tests re-arm the guard with
// vi.resetModules + dynamic import (a fresh module instance), so no
// test-only reset hook is exported.
let replayShutoffNoticeShown = false;
function noticeReasoningReplayShutoff(replay: ReasoningReplay, label: string): void {
  if (replayShutoffNoticeShown) return;
  replayShutoffNoticeShown = true;
  process.stderr.write(
    `wudao: WUDAO_REASONING_REPLAY=${replay} is forced to "never" on ${label} — probe-verified (ω99-33): this endpoint drops client-sent reasoning_content (uncounted, cache-inert); replaying it would only waste bytes\n`,
  );
}

/** ω99-39: cap a configured reasoning replay by the provider's probe-verified
 *  drop fact. The profile fact is an UPPER BOUND on the user's intent, not a
 *  new knob: `never` and absent pass through untouched (nothing to cap), an
 *  unmarked profile passes everything through byte-identically, and only a
 *  drops-marked endpoint forces toolCallTurns/always down to "never" — with
 *  the one-line stderr tell above (the honest chain: silent ineffectiveness
 *  → explicit shutoff + why). Pure; the notice is the only side effect. */
export function capClientReasoningReplay(
  profile: Pick<ProviderProfile, "dropsClientReasoningReplay" | "label"> | undefined,
  replay: ReasoningReplay | undefined,
): ReasoningReplay | undefined {
  if (replay === undefined || replay === "never") return replay;
  if (profile?.dropsClientReasoningReplay !== true) return replay;
  noticeReasoningReplayShutoff(replay, profile.label);
  return "never";
}

/** ω-2b (I1-c): the window semantics for the loop's admission clip — explicit
 *  config field, then the selected profile's pin, then "unknown" (the clip
 *  stays off until the endpoint is characterized). */
export function resolveWindowMode(config: ProviderConfig): WindowMode {
  if (config.windowMode !== undefined) return config.windowMode;
  if (config.provider !== undefined && isProviderName(config.provider)) {
    return PROVIDER_PROFILES[config.provider].windowMode ?? "unknown";
  }
  return "unknown";
}

// Convenience wrapper: null when resolution failed (any reason).
export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  selection: ProviderSelection = {},
): ProviderConfig | null {
  const r = resolveProviderConfigResult(env, selection);
  return r.ok ? r.config : null;
}
