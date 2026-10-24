// packages/providers/src/anthropic.ts — Anthropic messages 协议适配器（spec §5）
import type { AgentMessage, AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, ModelUsage } from "@wudao/core";
import { UnsupportedContentError, offloadRequestFiles, probeModelClient, truncateSafe } from "@wudao/core";
import { createKeyPool, cooldownClassForStatus } from "./key-pool.js";
import { createRatePauseWindow, DEFAULT_RATE_PAUSE_MS, type RatePauseWindow } from "./rate-pause.js";
import type { KeyPool } from "./key-pool.js";
import type { ProviderConfig } from "./config.js";
import { validatedInputEffort, effectiveReasoningEffort, type ReasoningEffort } from "./config.js";
import type { ProviderOptions } from "./openai-compatible.js";
import { applyWirePersona, mergeBodyOverlay } from "./persona/apply.js";
import { gatewayExtraHeaders } from "./header-validation.js";
import type { PersonaRuntime } from "./persona/runtime.js";
import { ProviderHttpError, isContextLengthFailure, parseContextLimitBody } from "./openai-compatible.js";
// OOM 上限（r1a task 2）：与 openai 引擎同一常量、同一截断方向（逐字照抄其用法，
// 不自创第二语义）——只截断响应侧本地解析缓冲，永不触碰请求构造/序列化。
import { MAX_ACCUM_CHARS, TRUNCATED_MARK, capAccumulated } from "./openai-compatible.js";
import { ContextLengthError } from "./openai-compatible.js";
// 加固移植（r8 §4.1）：共享梯子 + M58 §B idle 看门狗 —— 与 openai 引擎同一套部件，
// 零新分类逻辑（本适配器抛的 ProviderHttpError 消息本就匹配梯子的 regex）。
// ω99-315：看门狗双档化（soft warn / hard abort）的共享部件在 stream-idle.ts。
import {
  withRetry,
  withRetryStream,
  StreamOverflowError,
  TruncatedStreamError,
  type RetryLadderOptions,
} from "./openai-compatible.js";
import { createStreamIdleGuard, resolveStreamIdleBudget, type StreamIdleRuntime } from "./stream-idle.js";
// r1a Task 3：共享的 M62 §7 有序模型 fallback 链装饰器（同一链、同一语义）。
import { withModelFallback } from "./model-fallback.js";
import type { StreamingModelClient } from "./model-fallback.js";
// r1a Task 4：429 Retry-After 解析（只读响应头，与 openai 引擎同一解析器）。
import { parseRetryAfterMs } from "./retry-after.js";
import { tryQuotaParkError } from "./quota-park.js";
import { readErrorBody } from "./error-body.js";
// ω-1a：name-as-id 会话历史出站时剥离 `#n` 去重后缀（真 toolu_* id 恒为 no-op）。
import { restoreToolCallIds, restoreToolCallId } from "./tool-call-ids.js";
// wire-r2 follow-up ①：显式 maxTokens 与 thinking budget 冲突的类型化错误
// （定义在包内类型化错误的家 model-failure.ts —— 零包内依赖，无环）。
import { MaxTokensThinkingBudgetConflictError } from "./model-failure.js";

/** 0.3.26 coding-plan gateways (bearerAuth profile flag): dual-send
 *  `authorization: Bearer` alongside x-api-key — Kimi/MiniMax official docs
 *  auth via ANTHROPIC_AUTH_TOKEN, zhipu accepts x-api-key; both headers
 *  together are the widest compatibility face. Without the flag the header
 *  set is byte-identical to the historical one (real anthropic builtin). */
function anthropicAuthHeaders(config: ProviderConfig, apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    ...(config.bearerAuth === true ? { authorization: `Bearer ${apiKey}` } : {}),
  };
}

function messagesUrl(baseURL: string): string {
  return baseURL.endsWith("/v1") ? `${baseURL}/messages` : `${baseURL}/v1/messages`;
}

interface WireBlock { readonly type: string; readonly [k: string]: unknown }

/** 同角色相邻块合并（anthropic 交替约束）；tool 结果挂 user 角色 tool_result 块。 */
function toAnthropicMessages(messages: readonly AgentMessage[]): { role: "user" | "assistant"; content: WireBlock[] }[] {
  const out: { role: "user" | "assistant"; content: WireBlock[] }[] = [];
  const push = (role: "user" | "assistant", blocks: readonly WireBlock[]): void => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "assistant") {
      const blocks: WireBlock[] = [];
      if (m.content !== "") blocks.push({ type: "text", text: m.content });
      // ω-1a：出站还原 provider 原生 id（name-as-id 会话历史的 `#n` 后缀）。
      for (const tc of restoreToolCallIds(m.toolCalls ?? [])) blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      push("assistant", blocks);
    } else {
      // ω-1a：tool_result 的 tool_use_id 与上方 tool_use 同步剥离。
      push("user", [{ type: "tool_result", tool_use_id: restoreToolCallId(m.toolCallId, m.name), content: m.content, is_error: m.isError === true }]);
    }
  }
  return out;
}

// R2 T1 — fail-closed images gate. toAnthropicMessages emits text/tool_use/
// tool_result blocks ONLY: an AgentMessage.images block riding the input
// would be silently DROPPED by the converter (live data loss, not a
// degradation). Same M79 typed family as the openai engine's
// assertImagesSupported, with a structural reason: switching MODELS can
// never fix it (the wire itself carries no image blocks), so the model-
// fallback chain correctly leaves it alone. Fires in the request builder —
// BEFORE any network call, before a single image byte is read, generate and
// stream alike (both paths build through here). Never retried (see
// isRetryableProviderError's UnsupportedContentError arm).
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

// R2 T2 — effort → thinking budget_tokens on the anthropic messages wire.
// The floor 1024 is the API's documented minimum; max 32768 is the
// conservative cross-model ceiling documented for budget-capable models
// (32K). "none" maps to NO thinking field: the anthropic way to disable
// thinking is omission. The key appears ONLY when an effort is explicit
// (prefix-cache red line: absent effort = byte-identical body).
const THINKING_BUDGET_TOKENS: Readonly<Record<Exclude<ReasoningEffort, "none">, number>> = {
  low: 1024,
  medium: 2048,
  high: 8192,
  max: 32768,
};

// wire-r2 follow-up ① — the fail-closed narrowing of the T2 raise above:
// an EXPLICIT cap (input.maxTokens or config.maxTokens — either is a value
// the caller chose) sitting at/below the thinking budget is no longer
// silently rewritten to budget+1024; it throws the typed conflict instead.
// Only the adapter's own implicit default cap keeps the historic raise.
// Runs BEFORE the retry ladder (validatedInputEffort's spot — a
// deterministic config conflict never sleeps, never hits the wire) on both
// request paths; isModelFallbackEligible keeps it off the model-fallback
// chain (a sibling model re-hits the identical conflict).
function assertExplicitMaxTokensAboveBudget(config: ProviderConfig, input: ModelInput): void {
  const effort = effectiveReasoningEffort(input, config);
  if (effort === undefined || effort === "none") return;
  const budget = THINKING_BUDGET_TOKENS[effort];
  const explicit = input.maxTokens ?? config.maxTokens;
  if (explicit !== undefined && explicit <= budget) {
    // conflict-origin: `explicit` resolves input-first (input.maxTokens ??
    // config.maxTokens — a caller-chosen per-request cap wins), so the
    // marker asks ONE question: does the PERSISTENT config cap ALSO sit
    // at/below the budget (config alone re-conflicts)? Two marked shapes:
    // (a) no input cap — explicit IS config; nothing to drop, every resend
    // re-conflicts. (b) input cap ≤ budget with config ≤ budget too —
    // dropping the input clip exposes the conflicting config cap; a
    // clip-dropped compact resend resolves back to config.maxTokens and
    // re-conflicts before the wire. In both, no core recovery helps, so the
    // conflict carries the marker and core skips the futile compact ladder
    // (the one clip-retained corner where compact could physically serve is
    // ruled fail-closed BY POLICY at the loop's routing comments — masking a
    // deterministic config error is worse than the speculative recovery).
    // Unmarked (key absent): only the input cap conflicts (config absent or
    // above budget) — dropping the clip leaves a servable cap, so core may
    // route its ladder. Request bytes are untouched (error path only; the
    // fail-closed gate itself is byte-identical).
    const configCapAlsoConflicts = config.maxTokens !== undefined && config.maxTokens <= budget;
    throw new MaxTokensThinkingBudgetConflictError(explicit, budget, configCapAlsoConflicts);
  }
}

function buildAnthropicRequestBody(config: ProviderConfig, input: ModelInput): Record<string, unknown> {
  assertNoImages("anthropic", input);
  // ω99-55: FILE blocks project to handle text before the wire converter
  // (same request-build point the images gate sits at — no provider receives
  // file bytes; text rides every wire, so unlike images there is nothing to
  // refuse). Identity when nothing rides files: byte-identical bodies.
  const messages = offloadRequestFiles(input.messages);
  const effort = effectiveReasoningEffort(input, config);
  const budget = effort !== undefined && effort !== "none" ? THINKING_BUDGET_TOKENS[effort] : undefined;
  let maxTokens = input.maxTokens ?? config.maxTokens ?? 4096;
  // The API structurally requires max_tokens > thinking.budget_tokens — a
  // cap at/below the budget can never be served (guaranteed 400), so it is
  // raised to budget + 1024 headroom. Fires only when an effort is explicit
  // (same gate as the thinking key itself; absent effort = untouched cap).
  // wire-r2 follow-up ①: EXPLICIT caps at/below the budget were already
  // rejected before the ladder (assertExplicitMaxTokensAboveBudget), so in
  // practice this raise now fires only for the adapter's implicit default —
  // kept as the builder's own safety net, byte-identical to the status quo.
  if (budget !== undefined && maxTokens <= budget) maxTokens = budget + 1024;
  return {
    model: config.model,
    max_tokens: maxTokens,
    system: input.systemPrompt,
    messages: toAnthropicMessages(messages),
    tools: input.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
    ...(budget !== undefined ? { thinking: { type: "enabled", budget_tokens: budget } } : {}),
  };
}

const STOP_REASON_MAP: Readonly<Record<string, string>> = { end_turn: "stop", tool_use: "tool_calls", max_tokens: "length", stop_sequence: "stop" };

function mapStopReason(stop: unknown): string | undefined {
  return typeof stop === "string" ? (STOP_REASON_MAP[stop] ?? stop) : undefined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fromAnthropicResponse(payload: any): AssistantMessage {
  const blocks: any[] = Array.isArray(payload?.content) ? payload.content : [];
  // OOM fix：块拼接是本路径的累积点 —— 完成态累积器走 capAccumulated（同一常量、
  // 同一 in-band 标记）。tool_use 的 input 在本协议里到达时已是解析后的对象，
  // 无字符串累积点可套（见任务报告的证伪说明）。
  const text = capAccumulated(blocks.filter((b) => b?.type === "text").map((b: any) => b.text ?? "").join(""));
  const reasoning = capAccumulated(blocks.filter((b) => b?.type === "thinking").map((b: any) => b.thinking ?? "").join(""));
  const toolCalls = blocks
    .filter((b) => b?.type === "tool_use")
    .map((b: any) => ({ id: String(b.id), name: String(b.name), arguments: (b.input ?? {}) as Record<string, unknown> }));
  return {
    role: "assistant",
    content: text,
    ...(reasoning !== "" ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(mapStopReason(payload?.stop_reason) !== undefined ? { stopReason: mapStopReason(payload?.stop_reason) } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anthropicUsage(payload: any, durationMs: number): ModelUsage {
  // 基准×探针弧修平：anthropic 协议的 usage 三分（input_tokens +
  // cache_creation_input_tokens + cache_read_input_tokens）。此前漏
  // cache_creation —— 网关把大头 prompt 走 cache 写入时报账严重偏低
  // （GLM 实证 12 调用只记 878 入向）。口径：promptTokens=三分总和（整张
  // 提示词账单）；cacheHit=read；miss=总-read（cache 写入轮=M24 语义的
  // 冷转，计 miss）。
  const inputTokens = typeof payload?.usage?.input_tokens === "number" ? payload.usage.input_tokens : 0;
  const cacheCreate = typeof payload?.usage?.cache_creation_input_tokens === "number" ? payload.usage.cache_creation_input_tokens : 0;
  const cacheRead = typeof payload?.usage?.cache_read_input_tokens === "number" ? payload.usage.cache_read_input_tokens : 0;
  const outputTokens = typeof payload?.usage?.output_tokens === "number" ? payload.usage.output_tokens : 0;
  const promptTotal = inputTokens + cacheCreate + cacheRead;
  return {
    promptTokens: promptTotal, cacheHitTokens: cacheRead, cacheMissTokens: Math.max(0, promptTotal - cacheRead),
    completionTokens: outputTokens, durationMs,
  };
}

async function generateAnthropicOnce(config: ProviderConfig, input: ModelInput, doFetch: typeof fetch, keyPool: KeyPool, ratePause: RatePauseWindow, persona: PersonaRuntime | undefined): Promise<AssistantMessage> {
  const wire = applyWirePersona(persona, "anthropic", config.provider);
  const base = buildAnthropicRequestBody(config, input);
  const body = wire?.bodyOverlay !== undefined ? mergeBodyOverlay(base, wire.bodyOverlay) : base;
  const apiKey = keyPool.select();
  const startedAt = Date.now();
  const res = await doFetch(messagesUrl(config.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...anthropicAuthHeaders(config, apiKey),
      // ω99-64: registry card headers (per-provider baseline) spread after
      // adapter auth and before persona wire.headers — adapter auth >
      // persona > registry. gatewayExtraHeaders skips the full
      // FORBIDDEN_HEADER_KEYS set (14 keys — single source
      // header-validation.ts, ω99-69) so auth stays structurally the key
      // pool's (auth lands BEFORE these spreads; an unfiltered key would
      // silently replace it).
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
    // M58 §A: classify context-length failures (413/prompt_too_long) into ContextLengthError
    // so loop's compact-once-retry can trigger via isContextLengthError (err.name === "ContextLengthError")
    if (isContextLengthFailure(res.status, text)) {
      throw new ContextLengthError(res.status, text, parseContextLimitBody(text, input.maxTokens ?? config.maxTokens));
    }
    // 与 openai-compatible generateOnce 的错误路径同构：ProviderHttpError + 状态与响应体
    // （构造器实参以真实签名为准：which/status/body；overload 标志由构造器自算）。
    // r1a Task 4：响应头的 Retry-After 随错误携带（只读响应头）。
    // 波次 7 #37：同一 deadline 也设置 provider 级暂停窗（仅当键池无备键可换时）。
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (res.status === 429 && keyPool.snapshot().available === 0) {
      ratePause.trip(retryAfterMs ?? DEFAULT_RATE_PAUSE_MS);
    }
    // 113-B3: 账户级配额 429（带可解析重置时刻）在通用错误之前分类——类型化
    // QuotaParkError（与 openai 引擎同位同门，见 generateOnce）。
    const quotaPark = tryQuotaParkError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model });
    if (quotaPark !== undefined) throw quotaPark;
    throw new ProviderHttpError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model }); // v7 γ4: 失败腿的 provider/model 身份（结构化字段+消息尾）
  }
  // 波次 7 #37：2xx 证明暂停已过期（同 openai-compatible generateOnce）。
  ratePause.clear();
  const payload = await res.json();
  input.onUsage?.(anthropicUsage(payload, Date.now() - startedAt));
  return fromAnthropicResponse(payload);
}

/** SSE data: 行流（跨 chunk 缓冲，事件以空行分隔）。
 * 加固移植（r8 §4.1）：M58 §B idle 看门狗与 openai 引擎同形。ω99-315 双档化：
 * 共享 guard（stream-idle.ts）——只在读挂起（活跃流式）时武装，每次 read 解决
 * 即重置计时器；soft 档超时只发一次 onSoftWarning（不取消、不产生模型请求）；
 * hard 档超时先 reject 后 cancel（Node 在 reader.cancel() 内同步解决挂起的
 * read 为 done:true，race 必须采纳类型化错误而非 cancel 的 done）。抛出的
 * StreamIdleError 走调用方的重试梯子（重试字节相同，前缀缓存不受影响）；
 * 用户 abort 仍以 AbortError 浮出（永不重试）。idle 预算缺省/为 0 = 不武装。
 * r1b（B 组）：行缓冲上限 —— 持续发字节但永不出现事件边界的活跃流会让 buf
 * 无界增长（idle 看门狗管不住：read 一直有数据）。buf 超过 MAX_ACCUM_CHARS 时
 * 抛 StreamOverflowError，fail-loud 不截断（SSE 行中段截断会制造垃圾事件）；
 * 梯子把它按可重试传输类分类（照 StreamIdleError 的接线）。 */
export async function* sseDataLines(res: Response, signal?: AbortSignal, idle?: StreamIdleRuntime): AsyncGenerator<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // M58 §B / ω99-315 — the dual-tier stream idle watchdog (stream-idle.ts),
  // shape-mirroring the openai engine: soft warns once per silent gap, hard
  // aborts with the enriched typed error and races the pending read.
  const idleGuard = createStreamIdleGuard(idle ?? { softMs: 0, hardMs: 0 }, {
    ...(idle?.onSoftWarning !== undefined ? { onSoftWarning: idle.onSoftWarning } : {}),
    cancel: () => void reader.cancel().catch(() => {}),
  });
  // 124b 项 1（codex instant_interrupt）：显式 abort 面。undici 在 fetch
  // signal 触发时会拒绝挂起的 body read（既有中止语义依赖于此），但代理
  // 可以握住连接越过 abort——本地 reader.cancel() 让挂起读【立刻】解阻塞
  // （cancel 语义把挂起 read 解决为 done:true）。标志位随后把这次「EOF」
  // 翻译回 AbortError：不做这一步的话 cancel 形态会被当 EOF → 无终止语义
  // → TruncatedStreamError → 梯子重试一个用户刚要求中断的请求。signal 已
  // 触发时 reclassifyTransportAbort 原样放行 AbortError（永不重试）。
  let signalAborted = signal?.aborted === true;
  const onAbort = (): void => {
    signalAborted = true;
    void reader.cancel().catch(() => {});
  };
  if (signal !== undefined && !signal.aborted) signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      idleGuard.arm();
      const { done, value } = await idleGuard.race(reader.read());
      if (signalAborted) {
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      if (done) {
        // ω99-44 (pi 64eeb82a4): EOF is a frame terminator — flush the decoder
        // (multi-byte tails), then terminate a non-blank residual with the
        // event separator so the FINAL event missing its trailing "\n\n" is
        // still emitted (it was previously left in buf and silently dropped).
        // 残尾判界: the residual must still be a complete JSON data line — a
        // half-JSON tail falls to the consumer's JSON.parse discard; an EOF
        // that never saw terminal semantics throws there (TruncatedStreamError).
        buf += decoder.decode();
        buf = buf.trim() !== "" ? buf + "\n\n" : "";
      } else {
        buf += decoder.decode(value, { stream: true });
        // ω99-315: payload arrived — the silent gap is over; both tiers reset.
        idleGuard.chunk(value.byteLength);
      }
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of chunk.split("\n")) {
          // 0.3.35: SSE spec — after the field colon ONE optional leading space
          // is stripped. Real Anthropic sends `data: {…}`; some anthropic-wire
          // gateways (kimi api.kimi.com/coding) send `data:{…}`. The strict
          // `"data: "` prefix matched only the former and silently dropped
          // every event of the latter — a completed-but-empty stream.
          if (line.startsWith("data:")) yield line.slice("data:".length).replace(/^ /, "");
        }
        idx = buf.indexOf("\n\n");
      }
      // ω99-44: the done-flush above drained the buffer through the normal
      // event loop — exit only AFTER processing (previously `if (done) break`
      // sat before the decode, so the residual event never got this far).
      if (done) break;
      // r1b: cap the residual (unterminated) event prefix — a live stream
      // that never emits an event boundary ("\n\n") would grow `buf` without
      // bound, past any idle watchdog (every read resolves on time). Checked
      // AFTER this read's complete events are consumed, so an abort that
      // follows delivered deltas is never replayed (first-delta rule). Fail
      // LOUD, never truncate (a sliced SSE event would fabricate garbage
      // downstream events); the ladder classifies it exactly like
      // StreamIdleError — retryable transport, byte-identical replay.
      if (buf.length > MAX_ACCUM_CHARS) {
        void reader.cancel().catch(() => {});
        throw new StreamOverflowError(MAX_ACCUM_CHARS);
      }
    }
  } finally {
    if (signal !== undefined) signal.removeEventListener("abort", onAbort);
    idleGuard.dispose();
    reader.releaseLock();
  }
}

interface OpenToolUse { id: string; name: string; json: string }

/** ω99-44: the anthropic wire's terminal semantics — a message_stop event, or
 *  a message_delta carrying a stop_reason (the stop_reason-bearing delta is
 *  itself the finish signal: a proxy cutting right after it loses nothing the
 *  loop keys on, so it must NOT count as a truncation). Per-adapter on
 *  purpose — the openai/responses predicates live next to their own
 *  consumers; no shared one-size-fits-all. */
function isAnthropicStreamTerminal(ev: { type?: unknown; delta?: { stop_reason?: unknown } }): boolean {
  return ev.type === "message_stop" || (ev.type === "message_delta" && ev.delta?.stop_reason !== undefined);
}

async function* streamAnthropicOnce(config: ProviderConfig, input: ModelInput, doFetch: typeof fetch, keyPool: KeyPool, ratePause: RatePauseWindow, persona: PersonaRuntime | undefined, streamIdle: StreamIdleRuntime): AsyncGenerator<ModelStreamEvent> {
  const wire = applyWirePersona(persona, "anthropic", config.provider);
  const base = { ...buildAnthropicRequestBody(config, input), stream: true };
  const body = wire?.bodyOverlay !== undefined ? mergeBodyOverlay(base, wire.bodyOverlay) : base;
  const apiKey = keyPool.select();
  const startedAt = Date.now();
  const res = await doFetch(messagesUrl(config.baseURL), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...anthropicAuthHeaders(config, apiKey),
      // ω99-64: registry card headers (per-provider baseline) spread after
      // adapter auth and before persona wire.headers — adapter auth >
      // persona > registry. gatewayExtraHeaders skips the full
      // FORBIDDEN_HEADER_KEYS set (14 keys — single source
      // header-validation.ts, ω99-69) so auth stays structurally the key
      // pool's (auth lands BEFORE these spreads; an unfiltered key would
      // silently replace it).
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
    // M58 §A: classify context-length failures (413/prompt_too_long) into ContextLengthError
    // so loop's compact-once-retry can trigger via isContextLengthError (err.name === "ContextLengthError")
    if (isContextLengthFailure(res.status, text)) {
      throw new ContextLengthError(res.status, text, parseContextLimitBody(text, input.maxTokens ?? config.maxTokens));
    }
    // 波次 7 #37：同 generateAnthropicOnce 的 Retry-After + 暂停窗接线。
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (res.status === 429 && keyPool.snapshot().available === 0) {
      ratePause.trip(retryAfterMs ?? DEFAULT_RATE_PAUSE_MS);
    }
    // 113-B3: 流式路径同款配额分类（见上方 generate 位点）。
    const quotaPark = tryQuotaParkError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model });
    if (quotaPark !== undefined) throw quotaPark;
    throw new ProviderHttpError("request", res.status, text, retryAfterMs, { provider: config.provider, model: config.model }); // v7 γ4: 失败腿的 provider/model 身份（结构化字段+消息尾）
  }
  // 波次 7 #37：2xx 证明暂停已过期。
  ratePause.clear();
  let text = "";
  let reasoning = "";
  let usageIn = 0, usageCacheCreate = 0, usageCacheRead = 0, usageOut = 0;
  let stop: unknown;
  // ω99-44: terminal tracking (message_stop | stop_reason-bearing delta) and
  // attribution chars — EOF with sawTerminal=false is a cut, not a completion.
  let sawTerminal = false;
  let sawChars = 0;
  const blocks = new Map<number, { kind: "text" | "thinking" | "tool_use"; tool?: OpenToolUse }>();
  // OOM fix（openai-compatible 同语义）：累积器一旦越过上限即冻结 —— 该通道后续
  // delta 直接丢弃（下游消费者从 yield 出的 delta 自行累积，只封最终消息封不住
  // 它们），最终消息携带截断标记。
  let textCapped = false;
  let reasoningCapped = false;
  const cappedJson = new Set<number>();
  for await (const data of sseDataLines(res, input.signal, streamIdle)) {
    sawChars += data.length;
    let ev: any;
    try { ev = JSON.parse(data); } catch { continue; }
    if (isAnthropicStreamTerminal(ev)) sawTerminal = true;
    if (ev?.type === "message_start") {
      usageIn = ev.message?.usage?.input_tokens ?? 0;
      // 基准×探针弧修平：三分记账（见 anthropicUsage 注释）——cache 写入
      // 此前被整块丢弃，流式路径同样报账偏低。
      usageCacheCreate = ev.message?.usage?.cache_creation_input_tokens ?? 0;
      usageCacheRead = ev.message?.usage?.cache_read_input_tokens ?? 0;
    } else if (ev?.type === "content_block_start") {
      const cb = ev.content_block ?? {};
      blocks.set(ev.index, { kind: cb.type === "tool_use" ? "tool_use" : cb.type === "thinking" ? "thinking" : "text", ...(cb.type === "tool_use" ? { tool: { id: String(cb.id), name: String(cb.name), json: "" } } : {}) });
    } else if (ev?.type === "content_block_delta") {
      const d = ev.delta ?? {};
      const blk = blocks.get(ev.index);
      if (d.type === "text_delta") {
        if (!textCapped) {
          text += d.text ?? "";
          if (text.length > MAX_ACCUM_CHARS) {
            text = truncateSafe(text, MAX_ACCUM_CHARS); // 113-A4：累积帽代理对安全
            textCapped = true;
          }
          yield { type: "text_delta", text: String(d.text ?? "") };
        }
      } else if (d.type === "thinking_delta") {
        if (!reasoningCapped) {
          reasoning += d.thinking ?? "";
          if (reasoning.length > MAX_ACCUM_CHARS) {
            reasoning = truncateSafe(reasoning, MAX_ACCUM_CHARS); // 113-A4
            reasoningCapped = true;
          }
          yield { type: "reasoning_delta", text: String(d.thinking ?? "") };
        }
      } else if (d.type === "input_json_delta" && blk?.tool) {
        if (!cappedJson.has(ev.index)) {
          blk.tool.json += d.partial_json ?? "";
          if (blk.tool.json.length > MAX_ACCUM_CHARS) {
            blk.tool.json = truncateSafe(blk.tool.json, MAX_ACCUM_CHARS); // 113-A4
            cappedJson.add(ev.index);
          }
        }
      }
    } else if (ev?.type === "message_delta") {
      if (ev.delta?.stop_reason !== undefined) stop = ev.delta.stop_reason;
      if (typeof ev.usage?.output_tokens === "number") usageOut = ev.usage.output_tokens;
    } else if (ev?.type === "message_stop") {
      break;
    }
  }
  // ω99-44 (pi ebc374490): EOF without terminal semantics = the stream was
  // cut. No synthetic done, no fabricated usage — the typed error walks the
  // ladder as retryable transport (pre-first-delta replays byte-identically;
  // a post-delta cut propagates to the loop untouched).
  if (!sawTerminal) throw new TruncatedStreamError("anthropic", sawChars);
  input.onUsage?.({
    promptTokens: usageIn + usageCacheCreate + usageCacheRead,
    cacheHitTokens: usageCacheRead,
    cacheMissTokens: Math.max(0, usageIn + usageCacheCreate),
    completionTokens: usageOut, durationMs: Date.now() - startedAt,
  });
  const toolCalls = [...blocks.entries()].filter(([, b]) => b.tool).map(([idx, b]) => {
    const t = b.tool!;
    // 冻结的工具参数在解析前拼上标记（照抄 openai 引擎的 cappedArgs 用法）；
    // 截断+标记不再是合法 JSON → 落进本适配器既有的 _unparsed 兜底（有界、带标记）。
    const json = cappedJson.has(idx) ? t.json + TRUNCATED_MARK : t.json;
    let args: Record<string, unknown> = {};
    try { args = json === "" ? {} : JSON.parse(json); } catch { args = { _unparsed: json }; }
    return { id: t.id, name: t.name, arguments: args };
  });
  const message: AssistantMessage = {
    role: "assistant",
    content: textCapped ? text + TRUNCATED_MARK : text,
    ...(reasoning !== "" ? { reasoning: reasoningCapped ? reasoning + TRUNCATED_MARK : reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(mapStopReason(stop) !== undefined ? { stopReason: mapStopReason(stop) } : {}),
  };
  yield { type: "done", message };
}

/** 基准×探针弧：传输层 abort 归一。用户中止（input.signal 已触发）原样
 *  透传 AbortError（梯子永不重试——语义不变）；反之（信号未触发却收到
 *  AbortError）= 网关/连接层切断的传输形态（GLM 实证：建连后 ~4s 零字节
 *  断开，12/79 次、恰非 429——无状态码无错误体）——包成
 *  TruncatedStreamError 归可重试运输类：首 delta 前重放=字节同一（M24 暖
 *  前缀），梯子自愈，不再仰赖 loop 级恢复臂兜底。 */
function reclassifyTransportAbort(err: unknown, input: ModelInput): unknown {
  if (err instanceof Error && err.name === "AbortError" && input.signal?.aborted !== true) {
    return new TruncatedStreamError("anthropic", 0);
  }
  return err;
}

async function* reclassifyAbortStream(gen: AsyncGenerator<ModelStreamEvent>, input: ModelInput): AsyncGenerator<ModelStreamEvent> {
  try {
    for await (const ev of gen) yield ev;
  } catch (err) {
    throw reclassifyTransportAbort(err, input);
  }
}

export function createAnthropicProvider(config: ProviderConfig, options: ProviderOptions = {}): ModelClient {
  const doFetch = options.fetch ?? fetch;
  const keyPool = options.keyPool ?? createKeyPool(config.apiKeys ?? [config.apiKey]);
  // 波次 7 #37 (CodeWhale C1)：provider 级 429 暂停窗（同 openai-compatible 引擎）。
  const ratePause = options.ratePauseWindow ?? createRatePauseWindow();
  const persona = options.personaRuntime;
  // 加固移植（r8 §4.1）：梯子与看门狗选项此前被忽略 —— 现在与 openai 引擎同解析
  // （工厂期一次）：onRetry 合并进梯子选项。ω99-315：idle 预算双档化
  // （soft 90s warn / hard 300s abort；legacy 选项与 env 仍是 hard 档覆盖），
  // 与 openai 引擎同一 resolveStreamIdleBudget。
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
  // r1a Task 3：anthropic 适配器经共享装饰器获得模型 fallback 能力 —— 与
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
      // wire-r2 follow-up ①: an explicit maxTokens conflicting with the
      // thinking budget fails closed BEFORE the ladder, same spot.
      assertExplicitMaxTokensAboveBudget(cfg, validated);
      // 波次 7 #37：腿入口门 —— 并发请求在此等暂停窗；发起者的梯子重试在腿内，不门。
      await ratePause.wait(input.signal);
      return withRetry(
        () => generateAnthropicOnce(cfg, validated, doFetch, keyPool, ratePause, persona)
          .catch((err: unknown) => { throw reclassifyTransportAbort(err, validated); }),
        { ...retry, querySource: input.querySource },
      );
    },
    async *stream(input: ModelInput) {
      const validated = validatedInputEffort(input);
      assertExplicitMaxTokensAboveBudget(cfg, validated);
      // 波次 7 #37：同 generate 的入口门（首 delta 之前）。
      await ratePause.wait(input.signal);
      yield* withRetryStream(() => reclassifyAbortStream(
        streamAnthropicOnce(cfg, validated, doFetch, keyPool, ratePause, persona, streamIdle),
        validated,
      ), { ...retry, querySource: input.querySource });
    },
  });
  // PB-1 探针缝（模型面，基准×探针弧修平）：anthropic 线与 openai 工厂同款
  // ——工厂返回处装饰记 model.call（tokens/缓存/重试/时延）。此前只挂了
  // openai-compatible，anthropic 线（glm/kimi/minimax 等 wire:"anthropic"）
  // 模型遥测整面缺席（基准跑分器实证 model.call 零事件）。探针关=原对象。
  return probeModelClient(withModelFallback(legClient, config));
}
