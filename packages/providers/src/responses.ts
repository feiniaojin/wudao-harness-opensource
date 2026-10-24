// packages/providers/src/responses.ts — OpenAI Responses 协议适配器（spec §5，codex 原生）
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, ModelUsage } from "@wudao/core";
import { UnsupportedContentError, offloadRequestFiles } from "@wudao/core";
import { createKeyPool, cooldownClassForStatus } from "./key-pool.js";
import { createRatePauseWindow, DEFAULT_RATE_PAUSE_MS, type RatePauseWindow } from "./rate-pause.js";
import type { KeyPool } from "./key-pool.js";
import type { ProviderConfig } from "./config.js";
import { validatedInputEffort, effectiveReasoningEffort } from "./config.js";
import type { ProviderOptions } from "./openai-compatible.js";
import { applyWirePersona, mergeBodyOverlay } from "./persona/apply.js";
import { gatewayExtraHeaders } from "./header-validation.js";
import type { PersonaRuntime } from "./persona/runtime.js";
import { ProviderHttpError, isContextLengthFailure, parseContextLimitBody, ContextLengthError } from "./openai-compatible.js";
// OOM 上限（r1a task 2）：与 openai 引擎同一常量、同一截断方向（逐字照抄其用法，
// 不自创第二语义）——只截断响应侧本地解析缓冲，永不触碰请求构造/序列化。
import { capAccumulated } from "./openai-compatible.js";
// 加固移植（r8 §4.1）：共享梯子 + M58 §B idle 看门狗 —— 与 openai 引擎同一套部件，
// 零新分类逻辑（本适配器抛的 ProviderHttpError 消息本就匹配梯子的 regex）。
// ω99-315：看门狗双档化的共享部件在 stream-idle.ts。
import {
  withRetry,
  withRetryStream,
  TruncatedStreamError,
  type RetryLadderOptions,
} from "./openai-compatible.js";
import { resolveStreamIdleBudget, type StreamIdleRuntime } from "./stream-idle.js";
// r1a Task 3：共享的 M62 §7 有序模型 fallback 链装饰器（同一链、同一语义）。
import { withModelFallback } from "./model-fallback.js";
import type { StreamingModelClient } from "./model-fallback.js";
// r1a Task 4：429 Retry-After 解析（只读响应头，与 openai 引擎同一解析器）。
import { parseRetryAfterMs } from "./retry-after.js";
import { tryQuotaParkError } from "./quota-park.js";
import { readErrorBody } from "./error-body.js";
import { sseDataLines } from "./anthropic.js";

function responsesUrl(baseURL: string): string {
  return baseURL.endsWith("/v1") ? `${baseURL}/responses` : `${baseURL}/v1/responses`;
}

type InputItem = Record<string, unknown>;

/** Messages → Responses input items：user/assistant 文本保持 role 形状，assistant 的
 *  tool_calls 与 tool 结果翻成 function_call / function_call_output 项。 */
function toResponsesInput(messages: readonly AgentMessage[]): InputItem[] {
  const out: InputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ role: "user", content: m.content });
    else if (m.role === "assistant") {
      if (m.content !== "") out.push({ role: "assistant", content: m.content });
      for (const tc of m.toolCalls ?? []) out.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.arguments) });
    } else {
      out.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    }
  }
  return out;
}

// R2 T1 — fail-closed images gate. toResponsesInput emits role/text and
// function_call items ONLY: an AgentMessage.images block riding the input
// would be silently DROPPED by the converter (live data loss, not a
// degradation). Same M79 typed family as the openai engine's
// assertImagesSupported, with a structural reason: switching MODELS can
// never fix it (the wire itself carries no image parts), so the model-
// fallback chain correctly leaves it alone. Fires in the request builder —
// BEFORE any network call, before a single image byte is read; postResponses
// (shared by generate and stream) builds through here.
function assertNoImages(wire: string, input: ModelInput): void {
  for (const m of input.messages) {
    const imgs = (m as { images?: unknown }).images;
    if (Array.isArray(imgs) && imgs.length > 0) {
      throw new UnsupportedContentError(
        "wire-no-images",
        `the "${wire}" wire does not carry image blocks — switch wire (openai-chat) or drop the images (images are never silently dropped)`,
      );
    }
  }
}

function buildResponsesRequestBody(config: ProviderConfig, input: ModelInput): Record<string, unknown> {
  assertNoImages("responses", input);
  // ω99-55: FILE blocks project to handle text before the wire converter
  // (same request-build point the images gate sits at — no provider receives
  // file bytes; text rides every wire, so unlike images there is nothing to
  // refuse). Identity when nothing rides files: byte-identical bodies.
  const messages = offloadRequestFiles(input.messages);
  // R2 T2 — effort → reasoning: { effort } (the responses API's native
  // same-name enum), the value passed through verbatim. "none" has no enum
  // member on this wire → no field (provider default). The key appears ONLY
  // when an effort is explicit (prefix-cache red line: absent effort =
  // byte-identical body).
  const effort = effectiveReasoningEffort(input, config);
  return {
    model: config.model,
    instructions: input.systemPrompt,
    input: toResponsesInput(messages),
    tools: input.tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: false })),
    ...(effort !== undefined && effort !== "none" ? { reasoning: { effort } } : {}),
  };
}

function parseToolCallArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || raw === "") return {};
  // OOM fix：字符串参数先过共享上限（同一常量、同一 in-band 标记）——解析输入与
  // _unparsed 兜底都有界；截断+标记不再是合法 JSON 时落 _unparsed（照抄 openai
  // 引擎"截断后解析失败走既有兜底"的用法）。
  const capped = capAccumulated(raw);
  try { return JSON.parse(capped) as Record<string, unknown>; } catch { return { _unparsed: capped }; }
}

/** 聚合 output 数组（generate 的 payload.output，或流上收集的 done items）为一条
 *  AssistantMessage：message→text、reasoning→reasoning、function_call→toolCalls。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromResponsesOutput(output: any): AssistantMessage {
  const items: any[] = Array.isArray(output) ? output : [];
  // OOM fix：output_text / summary 的逐项拼接是本适配器的 text/reasoning 累积点
  // （generate 与 stream 的 done 聚合共用这里）——完成态累积器走 capAccumulated。
  const text = capAccumulated(items.filter((i) => i?.type === "message").map((i) => (Array.isArray(i.content) ? i.content.filter((c: any) => c?.type === "output_text").map((c: any) => c.text ?? "").join("") : "")).join(""));
  const reasoning = capAccumulated(items.filter((i) => i?.type === "reasoning").map((i) => (Array.isArray(i.summary) ? i.summary.map((s: any) => s?.text ?? "").join("") : "")).join(""));
  const toolCalls = items.filter((i) => i?.type === "function_call").map((i) => ({ id: String(i.call_id), name: String(i.name), arguments: parseToolCallArgs(i.arguments) }));
  return {
    role: "assistant",
    content: text,
    ...(reasoning !== "" ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    stopReason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function responsesUsage(payload: any, durationMs: number): ModelUsage {
  const inputTokens = payload?.usage?.input_tokens ?? 0;
  const cached = payload?.usage?.input_tokens_details?.cached_tokens ?? 0;
  return { promptTokens: inputTokens, cacheHitTokens: cached, cacheMissTokens: Math.max(0, inputTokens - cached), completionTokens: payload?.usage?.output_tokens ?? 0, durationMs };
}

/** 发请求 + 统一错误路径（generate/stream 共用）。persona 在 fetch 入口逐调用读取
 *  （不在工厂期缓存）；overlay 走 mergeBodyOverlay（base 键序保持，overlay 追加其后），
 *  stream 标志最后叠加、适配器始终拥有它。 */
async function postResponses(config: ProviderConfig, input: ModelInput, doFetch: typeof fetch, keyPool: KeyPool, ratePause: RatePauseWindow, persona: PersonaRuntime | undefined, stream: boolean): Promise<Response> {
  const wire = applyWirePersona(persona, "responses", config.provider);
  const base = buildResponsesRequestBody(config, input);
  const body = { ...(wire?.bodyOverlay !== undefined ? mergeBodyOverlay(base, wire.bodyOverlay) : base), ...(stream ? { stream: true } : {}) };
  const apiKey = keyPool.select();
  const res = await doFetch(responsesUrl(config.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      // ω99-64: registry card headers (per-provider baseline) spread after
      // adapter auth and before persona wire.headers — adapter auth >
      // persona > registry. gatewayExtraHeaders skips the full
      // FORBIDDEN_HEADER_KEYS set (14 keys — single source
      // header-validation.ts, ω99-69) so auth stays structurally the key
      // pool's.
      ...gatewayExtraHeaders(config.extraHeaders),
      ...(wire?.headers ?? {}),
    },
    body: JSON.stringify(body),
    signal: input.signal,
  });
  if (!res.ok) {
    // 夜移 007: status-classed cooldowns — auth (401/403) cools LONG, rate
    // (429) keeps 60s, provider-side statuses never touch the key.
    const cooldownClass = cooldownClassForStatus(res.status);
    if (cooldownClass !== null) keyPool.markCooldown(apiKey, cooldownClass);
    const text = await readErrorBody(res);  // 波次 8 #42: 有界错误体读取
    // M58 §A（与 anthropic.ts 同序）：429 冷却 → 溢出分类 → 通用 ProviderHttpError。
    // loop 的 compact-once-retry 只认 err.name === "ContextLengthError"（core 的
    // isContextLengthError），裸 ProviderHttpError 对它不透明。
    if (isContextLengthFailure(res.status, text)) {
      throw new ContextLengthError(res.status, text, parseContextLimitBody(text, input.maxTokens ?? config.maxTokens));
    }
    // 构造器实参以真实签名为准：which/status/body（与 anthropic.ts 的错误路径同构）。
    // r1a Task 4：响应头的 Retry-After 随错误携带（只读响应头；generate/stream
    // 共用本发请求函数，一处接线两路生效）。
    // 波次 7 #37：同一 deadline 也设置 provider 级暂停窗（仅当键池无备键可换时）。
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (res.status === 429 && keyPool.snapshot().available === 0) {
      ratePause.trip(retryAfterMs ?? DEFAULT_RATE_PAUSE_MS);
    }
    // 113-B3: 账户级配额 429 在通用错误之前分类（一处接线，generate/stream
    // 两路生效——与 anthropic/openai 引擎同位同门）。
    const quotaPark = tryQuotaParkError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model });
    if (quotaPark !== undefined) throw quotaPark;
    throw new ProviderHttpError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model }); // v7 γ4: 失败腿的 provider/model 身份（结构化字段+消息尾）
  }
  // 波次 7 #37：2xx 证明暂停已过期（一处清窗，两路生效）。
  ratePause.clear();
  return res;
}

async function generateResponsesOnce(config: ProviderConfig, input: ModelInput, doFetch: typeof fetch, keyPool: KeyPool, ratePause: RatePauseWindow, persona: PersonaRuntime | undefined): Promise<AssistantMessage> {
  const startedAt = Date.now();
  const res = await postResponses(config, input, doFetch, keyPool, ratePause, persona, false);
  // res.json() 在本 lib 下类型为 {}；payload?.output 需要显式 any（同 anthropic.ts 的宽松解析）。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload: any = await res.json();
  input.onUsage?.(responsesUsage(payload, Date.now() - startedAt));
  return fromResponsesOutput(payload?.output);
}

async function* streamResponsesOnce(config: ProviderConfig, input: ModelInput, doFetch: typeof fetch, keyPool: KeyPool, ratePause: RatePauseWindow, persona: PersonaRuntime | undefined, streamIdle: StreamIdleRuntime): AsyncGenerator<ModelStreamEvent> {
  const startedAt = Date.now();
  const res = await postResponses(config, input, doFetch, keyPool, ratePause, persona, true);
  const items: unknown[] = [];
  let finalUsage: unknown;
  // ω99-44: terminal tracking + attribution chars — EOF with sawTerminal=false
  // is a cut, not a completion (see isResponsesStreamTerminal below).
  let sawTerminal = false;
  let sawChars = 0;
  // M58 §B / ω99-315 双档 idle 看门狗随共享的 sseDataLines（见 anthropic.ts）。
  for await (const data of sseDataLines(res, input.signal, streamIdle)) {
    sawChars += data.length;
    let ev: any;
    try { ev = JSON.parse(data); } catch { continue; }
    if (isResponsesStreamTerminal(ev)) sawTerminal = true;
    if (ev?.type === "response.output_text.delta" && typeof ev.delta === "string") {
      yield { type: "text_delta", text: ev.delta };
    } else if (ev?.type === "response.reasoning_summary_text.delta" && typeof ev.delta === "string") {
      yield { type: "reasoning_delta", text: ev.delta };
    } else if (ev?.type === "response.output_item.done" && ev?.item) {
      items.push(ev.item);
    } else if (ev?.type === "response.completed") {
      finalUsage = ev.response?.usage;
      // 兜底：没有 output_item.done 的实现仍能从 completed 的整体 output 聚合。
      if (Array.isArray(ev.response?.output) && items.length === 0) items.push(...ev.response.output);
    }
  }
  // ω99-44 (pi ebc374490): EOF without a terminal lifecycle event = the stream
  // was cut. No synthetic done, no fabricated usage — the typed error walks the
  // ladder as retryable transport (same seam/streamOnce semantics).
  if (!sawTerminal) throw new TruncatedStreamError("responses", sawChars);
  input.onUsage?.(responsesUsage({ usage: finalUsage }, Date.now() - startedAt));
  yield { type: "done", message: fromResponsesOutput(items) };
}

/** ω99-44: the Responses wire's terminal lifecycle events — completed /
 *  failed / incomplete all prove the server FINISHED speaking (a cut stream
 *  carries none of them). Only response.completed carries usage/aggregation;
 *  the failure forms keep their existing partial-done handling — this
 *  predicate decides "was the stream cut", never "did it succeed".
 *  Per-adapter on purpose (see isAnthropicStreamTerminal). */
function isResponsesStreamTerminal(ev: { type?: unknown }): boolean {
  return ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.incomplete";
}

export function createResponsesProvider(config: ProviderConfig, options: ProviderOptions = {}): ModelClient {
  const doFetch = options.fetch ?? fetch;
  const keyPool = options.keyPool ?? createKeyPool(config.apiKeys ?? [config.apiKey]);
  // 波次 7 #37 (CodeWhale C1)：provider 级 429 暂停窗（同 openai-compatible 引擎）。
  const ratePause = options.ratePauseWindow ?? createRatePauseWindow();
  const persona = options.personaRuntime;
  // 加固移植（r8 §4.1）：梯子与看门狗选项此前被忽略 —— 现在与 openai 引擎同解析
  // （工厂期一次）：onRetry 合并进梯子选项。ω99-315：idle 预算双档化（soft 90s
  // warn / hard 300s abort；legacy 选项与 env 仍是 hard 档覆盖），同一
  // resolveStreamIdleBudget。
  const retry: RetryLadderOptions = {
    ...options.retry,
    ...(options.onRetry !== undefined ? { onRetry: options.onRetry } : {}),
    // 121 项 1：容量观察者同 onRetry 一并合并进梯子选项。
    ...(options.onOverload !== undefined ? { onOverload: options.onOverload } : {}),
  };
  const streamIdle: StreamIdleRuntime = {
    ...resolveStreamIdleBudget({
      softMs: options.streamIdleSoftMs,
      hardMs: options.streamIdleHardMs,
      legacyTimeoutMs: options.streamIdleTimeoutMs,
    }),
    ...(options.onStreamIdleWarning !== undefined ? { onSoftWarning: options.onStreamIdleWarning } : {}),
  };
  // r1a Task 3：responses 适配器经共享装饰器获得模型 fallback 能力 —— 与
  // openai 引擎同一链、同一语义（config.fallbackModels，过滤与主模型相同的
  // 项；sticky streak=2；key-class/abort/上下文溢出永不 fallback）。本工厂
  // 只提供「一个模型的一条腿」：共享梯子在腿内，请求构造/序列化零改动。
  const legClient = (cfg: ProviderConfig): StreamingModelClient => ({
    modelId: cfg.model,
    // 共享梯子包两条路径（M26 P11）；querySource 从 ModelInput 穿进梯子选项
    // （M70 §3：后台来源不重试 overload，照抄 openai-compatible 引擎的接法）。
    async generate(input: ModelInput) {
      // R2 T2 (M58 §C, engine parity): junk per-input effort fails fast
      // BEFORE the ladder — parse errors are never retried, never on the wire.
      const validated = validatedInputEffort(input);
      // 波次 7 #37：腿入口门 —— 并发请求在此等暂停窗；发起者的梯子重试在腿内，不门。
      await ratePause.wait(input.signal);
      return withRetry(() => generateResponsesOnce(cfg, validated, doFetch, keyPool, ratePause, persona), { ...retry, querySource: input.querySource });
    },
    async *stream(input: ModelInput) {
      const validated = validatedInputEffort(input);
      // 波次 7 #37：同 generate 的入口门（首 delta 之前）。
      await ratePause.wait(input.signal);
      yield* withRetryStream(() => streamResponsesOnce(cfg, validated, doFetch, keyPool, ratePause, persona, streamIdle), { ...retry, querySource: input.querySource });
    },
  });
  return withModelFallback(legClient, config);
}
