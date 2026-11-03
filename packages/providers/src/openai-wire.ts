// 拆分运动 C：从 openai-compatible.ts 原样外提的 wire 格式域
//（ω99-42 mandatory-reasoning 修复运行时、响应 wire 类型与 usage 映射、
// 请求体装配 toOpenAIRequest/assembleOpenAIBody/buildOpenAIRequestBody）。
import type { ModelInput, ModelUsage } from "@wudao-org/core";
import { offloadRequestFiles } from "@wudao-org/core";
import type { ProviderConfig, ReasoningEffort, ReasoningReplay } from "./config.js";
import { mandatoryRepairReasoningBody, reasoningFormatBody, resolveReasoningContext } from "./config.js";
import { isCappedReasoning, toOpenAIMessage } from "./openai-messages.js";
import { inputHasImages, imageWireMessages, type ImageRequestContext } from "./openai-images.js";

// ---------------------------------------------------------------------------
// ω99-42 — the mandatory-reasoning repair runtime. hermes f6bd1633f7/63279301bc
// shape, wudao layering:
//   flag  per-CLIENT (factory closure, shared by every fallback leg — the
//         capability is endpoint-scoped): set only after a repaired request
//         was SERVED (2xx); from then on every request of this client is
//         pre-armed (reasoning fields built enabled, no 400 round-trip first).
//         In-process only, never persisted — hermes' root cause was exactly a
//         per-process capability cache going stale, so the flag lives and dies
//         with the process (restart re-probes the endpoint).
//   call  per-CALL (created in the leg method, shared by every ladder attempt
//         of that one public call): carries the repair body once a repairable
//         rejection classified. The repair retry RIDES the existing ladder
//         (consumes one of its slots — shared per-turn budget, no new retry
//         machinery); the body build swaps ONLY the request-level reasoning
//         fields, so the messages serialization — the prompt-prefix bytes the
//         provider cache keys on — is byte-identical across the repair.
// ---------------------------------------------------------------------------
export interface MandatoryReasoningFlag {
  applied: boolean;
  onApplied?: () => void;
}

export interface MandatoryReasoningCall {
  readonly flag: MandatoryReasoningFlag;
  /** The repair body once armed (per call); undefined until a repairable
   *  rejection classified or the client came pre-armed. */
  body?: Record<string, unknown>;
}

/** Create the per-call runtime; a pre-armed client starts with the repair
 *  body already set (the leg's own config shapes it). */
export function createMandatoryReasoningCall(flag: MandatoryReasoningFlag, config: ProviderConfig): MandatoryReasoningCall {
  return flag.applied
    ? { flag, body: mandatoryRepairReasoningBody(resolveReasoningContext(config)) }
    : { flag };
}

/** Arm the client flag (idempotent) after a repaired request was served. */
export function armMandatoryReasoningFlag(flag: MandatoryReasoningFlag): void {
  if (flag.applied) return;
  flag.applied = true;
  flag.onApplied?.();
}

/** The request's EFFECTIVE reasoning effort — a per-input effort (already
 *  parsed once at the public boundary) overrides the config's own. The single
 *  source both the request body and the ω-2a repair gates read, so a gate can
 *  never disagree with the bytes that actually went out. */
export function effectiveReasoningEffort(input: Pick<ModelInput, "reasoningEffort">, config: ProviderConfig): ReasoningEffort | undefined {
  return input.reasoningEffort !== undefined && input.reasoningEffort !== ""
    ? (input.reasoningEffort as ReasoningEffort)
    : config.reasoningEffort;
}

export interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message: {
      role: string;
      content?: string;
      // OpenAI ignores reasoning fields; domestic providers return them under
      // several spellings. The format matrix picks which one to read; we
      // surface it on AssistantMessage.reasoning but never send it back.
      reasoning_content?: string;
      reasoning?: string;
      thinking?: string;
      tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: WireUsage;
}

/** Wire usage shapes across OpenAI-compatible servers. */
export interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  /** DeepSeek spelling. `prompt_tokens` INCLUDES these hits. */
  prompt_cache_hit_tokens?: number;
  /** DeepSeek spelling of the miss count (the tokens this call wrote to / paid
   *  uncached input for). */
  prompt_cache_miss_tokens?: number;
  /** Explicit cache-write spelling (endpoints that report it separately). */
  prompt_cache_write_tokens?: number;
  /** OpenAI spelling of the same quantities. */
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  /** Flat reasoning spelling some gateways use instead of the details object. */
  reasoning_tokens?: number;
}

/** Disjoint-count mapping (dsh rule): `prompt_tokens` includes cache hits, and
 *  the two wire spellings report the SAME quantity — prefer details, fall back
 *  to the flat field, never sum them (no double counting). Miss = the rest
 *  (DeepSeek's explicit miss spelling wins when present).
 *
 *  M56 §2 (turn_usage, omit-never-null): `cacheWriteTokens` is set only when
 *  the wire actually reported a cache split — on DeepSeek-style endpoints
 *  every miss is written, so cache-write ≈ miss; `reasoningTokens` rides the
 *  completion details spelling when the endpoint reports it. Everything
 *  unknown stays OMITTED (never null, never zero-backfilled). */
export function toModelUsage(u: WireUsage): ModelUsage {
  const promptTokens = u.prompt_tokens ?? 0;
  const hit = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  const miss = u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - hit);
  const cacheReported =
    u.prompt_cache_hit_tokens !== undefined
    || u.prompt_cache_miss_tokens !== undefined
    || u.prompt_cache_write_tokens !== undefined
    || u.prompt_tokens_details?.cached_tokens !== undefined;
  const write = u.prompt_cache_write_tokens ?? (cacheReported ? miss : undefined);
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens;
  return {
    promptTokens,
    cacheHitTokens: hit,
    cacheMissTokens: miss,
    completionTokens: u.completion_tokens ?? 0, // M29: workflow budgets bill prompt + completion
    ...(write !== undefined && write > 0 ? { cacheWriteTokens: write } : {}),
    ...(reasoning !== undefined && reasoning > 0 ? { reasoningTokens: reasoning } : {}),
  };
}

/** M56 §2: the receipt's client-side extras — the wall duration measured
 *  around the attempt (always set; a reference harness's duration_ms-always rule) and
 *  the replayed-reasoning estimate (only when the replay contract sent bytes
 *  back out). */
export function enrichUsage(usage: ModelUsage, durationMs: number, replayTokens: number): ModelUsage {
  return {
    ...usage,
    durationMs: Math.max(0, Math.round(durationMs)),
    ...(replayTokens > 0 ? { reasoningReplayTokens: replayTokens } : {}),
  };
}

/** Client-side estimate of the reasoning tokens sent BACK to the model this
 *  call (the M47 replay contract): CJK chars ≈ 1 token, ~4 others per token.
 *  An estimate by construction — no endpoint reports it. */
export function replayedReasoningTokens(messages: readonly ModelInput["messages"][number][], replay: ReasoningReplay): number {
  if (replay === "never") return 0;
  let cjk = 0;
  let other = 0;
  for (const m of messages) {
    if (m.role !== "assistant" || m.reasoning === undefined) continue;
    if (replay === "toolCallTurns" && (m.toolCalls === undefined || m.toolCalls.length === 0)) continue;
    // ω-2a: a capped tail never rides back out — never billed as replayed.
    if (isCappedReasoning(m.reasoning)) continue;
    for (const ch of m.reasoning) {
      if (ch >= "一" && ch <= "鿿") cjk += 1;
      else other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

function toOpenAIRequest(config: ProviderConfig, input: ModelInput, mr: MandatoryReasoningCall) {
  const messages = [
    { role: "system", content: input.systemPrompt },
    ...input.messages.map((m) => toOpenAIMessage(m, config.reasoningReplay ?? "never")),
  ];
  return assembleOpenAIBody(config, input, messages, mr.body);
}

/** The request tail shared by both build paths: tools, then the
 *  reasoning-effort matrix fields, then the optional completion cap. Key
 *  insertion order is load-bearing (the wire bytes) — unchanged by M79.
 *  ω99-42: `repairBody` (the mandatory-reasoning repair, when armed) merges
 *  AFTER the effort fields — same keys, new values, so the repaired body
 *  differs from the rejected one only in the request-level reasoning
 *  fields; the messages (the prefix-cache key material) are byte-identical. */
function assembleOpenAIBody(config: ProviderConfig, input: ModelInput, messages: unknown[], repairBody?: Record<string, unknown>): Record<string, unknown> {
  const tools = input.tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  const body: Record<string, unknown> = { model: config.model, messages, tools, tool_choice: "auto" };
  // Reasoning-effort fields are appended only when configured — the default
  // request stays byte-identical (prefix-cache friendly). The single matrix
  // implementation shapes them (M16's per-profile transforms live here now).
  // M58 §C: the per-INPUT effort was already parsed once at the public
  // boundary (validatedInputEffort); ω-2a routes both this and the repair
  // gates through effectiveReasoningEffort so they can never disagree.
  const effort = effectiveReasoningEffort(input, config);
  if (effort !== undefined) {
    Object.assign(body, reasoningFormatBody(resolveReasoningContext(config), effort));
  }
  if (repairBody !== undefined) {
    Object.assign(body, repairBody);
  }
  // M45: a configured completion cap rides last (budget-critical side calls
  // only; the main loop never sets it). ω-2b (I1-b): a per-INPUT cap overrides
  // the config's for this one call (the reasoningEffort override pattern) —
  // max_tokens is a sampling parameter, never prompt bytes, so the swap is
  // prefix-cache-neutral by construction.
  const maxTokens = input.maxTokens ?? config.maxTokens;
  if (maxTokens !== undefined) {
    body["max_tokens"] = maxTokens;
  }
  return body;
}

/** The one request body builder (M79): the pre-M79 byte-identical
 *  construction when no images ride the input, the image walk above when
 *  they do. ω99-42: threads the mandatory-reasoning repair body through.
 *  ω99-55: FILE blocks project to handle text FIRST (dsh LlmRuntime parity
 *  — no wire ever receives file bytes); the projection is the identity when
 *  nothing rides files, so text/image request bytes are untouched. */
export async function buildOpenAIRequestBody(
  config: ProviderConfig,
  input: ModelInput,
  imageCtx: ImageRequestContext,
  mr: MandatoryReasoningCall,
): Promise<Record<string, unknown>> {
  const projectedMessages = offloadRequestFiles(input.messages);
  const projected: ModelInput = projectedMessages === input.messages ? input : { ...input, messages: projectedMessages };
  if (!inputHasImages(projected)) return toOpenAIRequest(config, projected, mr);
  const messages = await imageWireMessages(config, projected, imageCtx);
  return assembleOpenAIBody(config, projected, messages, mr.body);
}
