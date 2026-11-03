// 拆分运动 C：从 openai-compatible.ts 原样外提的单次 HTTP 执行引擎域
//（generateOnce/streamOnce、ω99-42 分类、M70 §4 自修复重试、safeText）。
// 依赖方向：engine → wire/messages/images/json-arguments/retry-ladder（无环）。
import type { AssistantMessage, ModelInput, ModelStreamEvent, ModelUsage, ToolCall } from "@wudao-org/core";
import { truncateSafe } from "@wudao-org/core";
import type { ProviderConfig } from "./config.js";
import {
  mandatoryRepairReasoningBody,
  pickReasoning,
  reasoningFormatBody,
  reasoningResponseFields,
  resolveReasoningContext,
} from "./config.js";
import type { PersonaRuntime } from "./persona/runtime.js";
import { applyWirePersona, mergeBodyOverlay } from "./persona/apply.js";
import { gatewayExtraHeaders } from "./header-validation.js";
import { cooldownClassForStatus } from "./key-pool.js";
import type { KeyPool } from "./key-pool.js";
import { DEFAULT_RATE_PAUSE_MS, type RatePauseWindow } from "./rate-pause.js";
import { createStreamIdleGuard, type StreamIdleRuntime } from "./stream-idle.js";
import { InbandThinkSplitter, resolveSplitInbandThinking } from "./split-inband-thinking.js";
import { dedupeToolCallIds } from "./tool-call-ids.js";
import { parseRetryAfterMs } from "./retry-after.js";
import { readErrorBody } from "./error-body.js";
import { tryQuotaParkError } from "./quota-park.js";
import { ProviderHttpError, ReasoningMandatoryError, isMandatoryReasoningRejection } from "./model-failure.js";
import { MAX_ACCUM_CHARS, TRUNCATED_MARK, canonicalJson, capAccumulated } from "./openai-messages.js";
import { parseToolCallArguments } from "./json-arguments.js";
import {
  armMandatoryReasoningFlag,
  buildOpenAIRequestBody,
  effectiveReasoningEffort,
  enrichUsage,
  replayedReasoningTokens,
  toModelUsage,
  type ChatCompletionResponse,
  type MandatoryReasoningCall,
  type WireUsage,
} from "./openai-wire.js";
import type { ImageRequestContext } from "./openai-images.js";
import {
  StreamOverflowError,
  TruncatedStreamError,
  classifyContextLength,
  isContextLengthFailure,
  isMaxTokensOverflow400,
  parseMaxTokensOverflow,
  selfRepairMaxTokensValue,
} from "./retry-ladder.js";

/** One non-streaming attempt — the body the retry ladder calls. */
async function generateOnce(
  config: ProviderConfig,
  input: ModelInput,
  doFetch: typeof fetch,
  keyPool: KeyPool,
  ratePause: RatePauseWindow,
  imageCtx: ImageRequestContext,
  persona: PersonaRuntime | undefined,
  mr: MandatoryReasoningCall,
): Promise<AssistantMessage> {
  const wire = applyWirePersona(persona, "openai-chat", config.provider);
  const body = await buildOpenAIRequestBody(config, input, imageCtx, mr);
  const finalBody = wire?.bodyOverlay !== undefined ? mergeBodyOverlay(body, wire.bodyOverlay) : body;
  const apiKey = keyPool.select();
  const startedAt = Date.now();
  const res = await doFetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
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
    body: JSON.stringify(finalBody),
    signal: input.signal,
  });

  if (!res.ok) {
    // 夜移 007: status-classed cooldowns — auth (401/403) cools LONG, rate
    // (429) keeps 60s, provider-side statuses never touch the key.
    const cooldownClass = cooldownClassForStatus(res.status);
    if (cooldownClass !== null) keyPool.markCooldown(apiKey, cooldownClass);
    const detail = await safeText(res);
    // M58 §A: classify the overflow BEFORE the generic HTTP error — the retry
    // ladder must never retry it (an oversized prompt cannot succeed on
    // retry); the loop reacts instead (compact once, retry once). ω-2b: the
    // trusted-parse observation rides the typed error when the body has one.
    if (isContextLengthFailure(res.status, detail)) throw classifyContextLength(res.status, detail, config, input);
    // ω99-42: the mandatory-reasoning rejection classifies BEFORE the generic
    // HTTP error (hermes matches it ahead of request-validation in
    // _classify_400) — typed, attributed, and repairable only when the
    // disable on the wire was not the user's explicit "none".
    if (isMandatoryReasoningRejection(res.status, detail)) {
      throw classifyMandatoryRejection("request", res.status, detail, config, input, mr);
    }
    // r1a Task 4: the response's Retry-After rides the typed error (headers
    // only — the request bytes never see this). 波次 7 #37: the same deadline
    // also pauses the PROVIDER for later request entries — but only when the
    // pool has no spare to rotate to (multi-key rotation is the cheaper cure).
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (res.status === 429 && keyPool.snapshot().available === 0) {
      ratePause.trip(retryAfterMs ?? DEFAULT_RATE_PAUSE_MS);
    }
    // 113-B3: an account-level quota 429 with a parseable reset moment
    // classifies BEFORE the generic error — the typed QuotaParkError (the
    // CLI parks the run until reset instead of dying on the >60s hard stop).
    // All four gates live in isQuotaParkFailure; a miss keeps today's path.
    const quotaPark = tryQuotaParkError("request", res.status, detail, retryAfterMs, { provider: config.provider, model: config.model });
    if (quotaPark !== undefined) throw quotaPark;
    throw new ProviderHttpError("request", res.status, detail, retryAfterMs, { provider: config.provider, model: config.model }); // v7 γ4: 失败腿的 provider/model 身份（结构化字段+消息尾）
  }
  // 波次 7 #37: a 2xx proves any active pause stale — the next concurrent
  // entry is immediate (a recovered transient blip never stalls the fleet).
  ratePause.clear();
  // ω99-42: a SERVED request that ran under the repair arms the per-client
  // flag — every later request of this client is pre-armed (no 400 first).
  if (mr.body !== undefined) armMandatoryReasoningFlag(mr.flag);

  const json = (await res.json()) as ChatCompletionResponse;
  const choice = json.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("provider response missing choices[0].message");
  }
  if (json.usage) {
    // M70 §2: stamp the answering model's identity on the usage row (the
    // loop's usage-anchor guard (a) keys on it).
    input.onUsage?.(enrichUsage({ ...toModelUsage(json.usage), model: config.model }, Date.now() - startedAt, replayedReasoningTokens(input.messages, config.reasoningReplay ?? "never")));
  }

  // ω-1a: name-as-id endpoints echo the function name as the id — parallel
  // same-name calls in this message would collide downstream (loop pairing /
  // JSONL / outbound history), so the parsed list is deduped here.
  const toolCalls: ToolCall[] | undefined = message.tool_calls
    ? dedupeToolCallIds(message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: parseToolCallArguments(capAccumulated(tc.function.arguments)),
      })))
    : undefined;

  // M28: the reasoning field name comes from the format matrix
  // (reasoning_content / reasoning / thinking) — a new endpoint selects a
  // format, the response sniffing follows.
  const fieldReasoning = pickReasoning(reasoningResponseFields(resolveReasoningContext(config).format), message) ?? "";
  let reasoning = capAccumulated(fieldReasoning);
  // 夜移 011: no reasoning FIELD but an in-band lane → peel the think block
  // out of content in one shot (field wins when both exist — a provider
  // reporting reasoning properly never needs the peel).
  let content = capAccumulated(message.content ?? "");
  if (fieldReasoning === "" && content !== "" && resolveSplitInbandThinking(config)) {
    const splitter = new InbandThinkSplitter();
    const a = splitter.push(content);
    const b = splitter.finish();
    reasoning = capAccumulated((a.reasoning ?? "") + (b.reasoning ?? ""));
    content = capAccumulated((a.content ?? "") + (b.content ?? ""));
  }

  return {
    role: "assistant",
    content,
    toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
    reasoning: reasoning || undefined,
    // M70 §1: the finish reason rides the message — the loop's truncated
    // tool-call guard keys on "length" (cut mid-arguments). Review F1: falsy
    // (null/empty) finish_reason values are skipped, not stored — the field
    // stays OMITTED, per the omit-never-null discipline.
    ...(choice?.finish_reason ? { stopReason: choice.finish_reason } : {}),
  };
}

/** ω99-44: the openai wire's terminal signal, chunk form — any choice
 *  carrying a truthy finish_reason. ([DONE] is the other signal, checked at
 *  the data-string level before the parse.) Some gateways end WITHOUT [DONE]
 *  but always stamp the final chunk with finish_reason — either proves the
 *  stream was not cut. Per-adapter on purpose: the anthropic/responses
 *  predicates live next to their own consumers — no shared one-size-fits-all
 *  (falsy nulls on intermediate chunks never count, mirroring the
 *  finishReason assignment below). */
function isOpenAiStreamTerminal(chunk: { choices?: Array<{ finish_reason?: string }> }): boolean {
  return chunk.choices?.some((c) => Boolean(c.finish_reason)) ?? false;
}

/** One streaming attempt — the generator the retry ladder calls. */
export async function* streamOnce(
  config: ProviderConfig,
  input: ModelInput,
  doFetch: typeof fetch,
  keyPool: KeyPool,
  ratePause: RatePauseWindow,
  streamIdle: StreamIdleRuntime,
  imageCtx: ImageRequestContext,
  persona: PersonaRuntime | undefined,
  mr: MandatoryReasoningCall,
): AsyncGenerator<ModelStreamEvent> {
  const wire = applyWirePersona(persona, "openai-chat", config.provider);
  // stream_options rides AFTER the pinned key sequence, so the streaming
  // body's bytes are the non-streaming body's bytes plus two appended keys
  // — the prompt token stream itself is unchanged (cache-safe).
  const body = { ...(wire?.bodyOverlay !== undefined ? mergeBodyOverlay(await buildOpenAIRequestBody(config, input, imageCtx, mr), wire.bodyOverlay) : await buildOpenAIRequestBody(config, input, imageCtx, mr)), stream: true, stream_options: { include_usage: true } };
  const apiKey = keyPool.select();
  const startedAt = Date.now();
  const res = await doFetch(`${config.baseURL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
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
    const detail = await safeText(res);
    // M58 §A: same classification on the streaming path (see generateOnce).
    // ω-2b: same trusted-parse observation stamping.
    if (isContextLengthFailure(res.status, detail)) throw classifyContextLength(res.status, detail, config, input);
    // ω99-42: same mandatory-reasoning classification on the streaming path
    // (see generateOnce) — the repair replays before the first delta.
    if (isMandatoryReasoningRejection(res.status, detail)) {
      throw classifyMandatoryRejection("stream", res.status, detail, config, input, mr);
    }
    // r1a Task 4 + 波次 7 #37: same Retry-After + provider-pause wiring as
    // generateOnce (see there).
    const retryAfterMs = parseRetryAfterMs(res.headers);
    if (res.status === 429 && keyPool.snapshot().available === 0) {
      ratePause.trip(retryAfterMs ?? DEFAULT_RATE_PAUSE_MS);
    }
    // 113-B3: same quota classification on the streaming path (see
    // generateOnce) — the wake probe typically rides this path.
    const quotaPark = tryQuotaParkError("stream", res.status, detail, retryAfterMs, { provider: config.provider, model: config.model });
    if (quotaPark !== undefined) throw quotaPark;
    throw new ProviderHttpError("stream", res.status, detail, retryAfterMs, { provider: config.provider, model: config.model }); // v7 γ4: 失败腿的 provider/model 身份（结构化字段+消息尾）
  }
  // 波次 7 #37: a 2xx proves any active pause stale (see generateOnce).
  ratePause.clear();
  // ω99-42: headers-OK on a repaired request = the route served the enabled
  // shape — arm the per-client pre-arm flag (see generateOnce).
  if (mr.body !== undefined) armMandatoryReasoningFlag(mr.flag);

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage: ModelUsage | undefined;
  // M70 §1: the stream's finish_reason (it rides the final content chunk,
  // before the optional usage-only chunk) — surfaced on the done message so
  // the loop's truncated tool-call guard can key on "length".
  let finishReason: string | undefined;
  // OOM fix: once an accumulator passes the cap it is frozen — later deltas
  // for THAT channel are dropped (downstream consumers accumulate from the
  // yielded deltas, so capping only the final message would not bound them)
  // and the final message carries the truncation marker.
  let contentCapped = false;
  let reasoningCapped = false;
  const cappedArgs = new Set<number>();
  const toolCalls = new Map<number, { id: string; name: string; args: string }>();
  // M28: reasoning deltas sniff the format's field order — no per-endpoint
  // SSE parser edits for new reasoning field spellings.
  const reasoningFields = reasoningResponseFields(resolveReasoningContext(config).format);
  // ω99-44: terminal tracking — did this stream ever speak finish/stop
  // semantics? ([DONE] marker, or any chunk carrying finish_reason — some
  // gateways end WITHOUT [DONE] but always stamp the final chunk.) EOF with
  // sawTerminal=false is a cut, not a completion (see TruncatedStreamError).
  let sawTerminal = false;
  // ω99-44: attribution — wire bytes that arrived before the EOF.
  let sawBytes = 0;
  // 夜移 011: the in-band <think> peel (vLLM chat-template lanes inline CoT
  // into content). Null on every format that reports reasoning properly.
  const inbandSplitter = resolveSplitInbandThinking(config) ? new InbandThinkSplitter() : undefined;
  // M58 §B / ω99-315 — the dual-tier stream idle watchdog (stream-idle.ts).
  // Armed only while a read is PENDING (active streaming): every resolved read
  // re-arms the timers, a SOFT lapse fires onSoftWarning once (never cancels,
  // never a model request — long reasoning silences are legal), a HARD lapse
  // cancels the body — tearing down the HTTP download, the fetch's own abort —
  // and raises the enriched typed StreamIdleError, which walks the existing
  // retry ladder (the retried request re-serializes the same input →
  // byte-identical body, so the prefix cache is untouched). The user's abort
  // signal stays untouched: a USER abort surfaces as AbortError (never
  // retried); only idle-timeout aborts retry.
  const idleGuard = createStreamIdleGuard(streamIdle, {
    ...(streamIdle.onSoftWarning !== undefined ? { onSoftWarning: streamIdle.onSoftWarning } : {}),
    cancel: () => void reader.cancel().catch(() => {}),
  });
  // 124b 项 1（codex instant_interrupt）：显式 abort 面（同 anthropic 的
  // sseDataLines）——本地 cancel 立刻解阻塞挂起读，标志位把 cancel 的
  // done:true 形态翻译回 AbortError（否则会走 TruncatedStreamError 被
  // 梯子当可重试运输类重放一个刚被用户中断的请求）。signal 已触发时
  // reclassifyTransportAbort 同族逻辑原样放行 AbortError（永不重试）。
  let signalAborted = input.signal?.aborted === true;
  const onAbort = (): void => {
    signalAborted = true;
    void reader.cancel().catch(() => {});
  };
  if (input.signal !== undefined && !input.signal.aborted) input.signal.addEventListener("abort", onAbort, { once: true });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      idleGuard.arm();
      const { done, value } = await idleGuard.race(reader.read());
      if (signalAborted) {
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
      if (done) {
        // ω99-44 (pi 64eeb82a4): EOF is a frame terminator — flush the decoder
        // (multi-byte tails), then terminate a non-blank residual so the final
        // `data:` line WITHOUT its trailing newline is still parsed (it was
        // previously dropped on the floor). 残尾判界: the residual must still
        // parse as a complete JSON line — a half-JSON tail falls to the
        // JSON.parse discard below; an EOF that never saw terminal semantics
        // throws after the loop regardless.
        buf += decoder.decode();
        buf = buf.trim() !== "" ? buf + "\n" : "";
      } else {
        buf += decoder.decode(value, { stream: true });
        sawBytes += value.byteLength;
        // ω99-315: payload arrived — the silent gap is over; both tiers reset.
        idleGuard.chunk(value.byteLength);
      }
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (data === "") continue;
        // ω99-44: [DONE] is one of the two openai terminal signals (the other
        // is a finish_reason-bearing chunk, checked post-parse below).
        if (data === "[DONE]") {
          sawTerminal = true;
          continue;
        }
        let chunk: {
          usage?: WireUsage;
          choices?: Array<{
            finish_reason?: string;
            delta?: {
              content?: string;
              reasoning_content?: string;
              reasoning?: string;
              thinking?: string;
              tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
            };
          }>;
        };
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        // ω99-44: the chunk-form terminal signal (see isOpenAiStreamTerminal).
        if (isOpenAiStreamTerminal(chunk)) sawTerminal = true;
        // The usage-only trailing chunk (stream_options.include_usage) has an
        // empty choices array — parse it BEFORE the delta guard skips it.
        if (chunk.usage) {
          usage = toModelUsage(chunk.usage);
        }
        const choice = chunk.choices?.[0];
        // M70 review F1: OpenAI SSE chunks carry "finish_reason":null on every
        // intermediate chunk — skip falsy values so a null never lands on the
        // done message (omit-never-null, M56) and a trailing null after a real
        // "length" can never disarm the truncated-tool-call guard.
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        const reasoningDelta = pickReasoning(reasoningFields, delta as Record<string, unknown>);
        if (reasoningDelta) {
          if (!reasoningCapped) {
            reasoning += reasoningDelta;
            if (reasoning.length > MAX_ACCUM_CHARS) {
              reasoning = truncateSafe(reasoning, MAX_ACCUM_CHARS); // 113-A4：累积帽代理对安全
              reasoningCapped = true;
            }
            yield { type: "reasoning_delta", text: reasoningDelta };
          }
        }
        if (delta.content) {
          if (!contentCapped) {
            // 夜移 011: content deltas pass through the in-band peel when the
            // lane is on — a think block's bytes reclassify as reasoning
            // (their own accumulator + events); everything after the block
            // flows on as content. Lane off (every well-behaved format) →
            // byte-identical to the historical path.
            if (inbandSplitter !== undefined) {
              const out = inbandSplitter.push(delta.content);
              if (out.reasoning !== undefined && !reasoningCapped) {
                reasoning += out.reasoning;
                if (reasoning.length > MAX_ACCUM_CHARS) {
                  reasoning = truncateSafe(reasoning, MAX_ACCUM_CHARS); // 113-A4：累积帽代理对安全
                  reasoningCapped = true;
                }
                yield { type: "reasoning_delta", text: out.reasoning };
              }
              if (out.content !== undefined) {
                content += out.content;
                if (content.length > MAX_ACCUM_CHARS) {
                  content = truncateSafe(content, MAX_ACCUM_CHARS); // 113-A4
                  contentCapped = true;
                }
                yield { type: "text_delta", text: out.content };
              }
            } else {
              content += delta.content;
              if (content.length > MAX_ACCUM_CHARS) {
                content = truncateSafe(content, MAX_ACCUM_CHARS); // 113-A4
                contentCapped = true;
              }
              yield { type: "text_delta", text: delta.content };
            }
          }
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index ?? 0;
            const acc = toolCalls.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name = tc.function.name;
            if (tc.function?.arguments && !cappedArgs.has(idx)) {
              acc.args += tc.function.arguments;
              if (acc.args.length > MAX_ACCUM_CHARS) {
                acc.args = truncateSafe(acc.args, MAX_ACCUM_CHARS); // 113-A4
                cappedArgs.add(idx);
              }
            }
            toolCalls.set(idx, acc);
          }
        }
      }
      // ω99-44: the done-flush above drained the residual through the normal
      // line loop — exit only AFTER processing (previously `if (done) break`
      // sat before the decode, so the unterminated final line never got here).
      if (done) break;
      // r1b: cap the residual (unterminated) line — an active stream that
      // never emits a "\n" would grow `buf` without bound, a hole the idle
      // watchdog cannot catch (every read resolves on time). Checked AFTER
      // this read's complete lines are consumed, so an abort that follows
      // delivered deltas is never replayed (first-delta rule). Fail LOUD,
      // never truncate: a sliced SSE line would fabricate garbage events.
      if (buf.length > MAX_ACCUM_CHARS) {
        void reader.cancel().catch(() => {});
        throw new StreamOverflowError(MAX_ACCUM_CHARS);
      }
    }
  } finally {
    if (input.signal !== undefined) input.signal.removeEventListener("abort", onAbort);
    idleGuard.dispose();
  }

  // ω99-44 (pi ebc374490): EOF without terminal semantics = the stream was
  // cut (proxy EOF, connection drop). Fail LOUD with the typed error — never
  // a synthetic done, never fabricated usage: finish_reason loss blinds the
  // M70 stop-reason guard, usage loss kills the metering row. The ladder
  // classifies it as retryable transport (the pre-first-delta replay is
  // byte-identical, prefix-cache safe; a post-delta cut propagates).
  if (!sawTerminal) throw new TruncatedStreamError("openai-compatible", sawBytes);

  // ω-1a: same dedupe as the non-streaming path, applied once the delta
  //  fragments have aggregated into complete calls (ids may ride only the
  //  first fragment per index — the aggregate is what must be unique).
  const calls = dedupeToolCallIds(
    [...toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, v]) => ({
        id: v.id,
        name: v.name,
        arguments: parseToolCallArguments(cappedArgs.has(idx) ? v.args + TRUNCATED_MARK : v.args),
      })),
  );
  // 夜移 011: stream-end flush — an unterminated think block's held tail
  // (including a dangling close-tag prefix) lands as reasoning; a seeking-held
  // partial open tag lands as content. The accumulators below pick both up.
  if (inbandSplitter !== undefined) {
    const tail = inbandSplitter.finish();
    if (tail.reasoning !== undefined && !reasoningCapped) reasoning += tail.reasoning;
    if (tail.content !== undefined && !contentCapped) content += tail.content;
  }
  if (usage !== undefined) {
    // M70 §2: stamp the answering model's identity on the usage row (see
    // generateOnce).
    input.onUsage?.(enrichUsage({ ...usage, model: config.model }, Date.now() - startedAt, replayedReasoningTokens(input.messages, config.reasoningReplay ?? "never")));
  }
  yield {
    type: "done",
    message: {
      role: "assistant",
      content: contentCapped ? content + TRUNCATED_MARK : content,
      toolCalls: calls.length > 0 ? calls : undefined,
      reasoning: reasoning ? (reasoningCapped ? reasoning + TRUNCATED_MARK : reasoning) : undefined,
      ...(finishReason !== undefined ? { stopReason: finishReason } : {}),
    },
  };
}

/** ω99-42: classify one matched mandatory-reasoning rejection. The repair
 *  verdict (hermes 63279301bc, wudao's two-row table):
 *    repairable — the effective "none"/disabled on the wire was NOT the
 *      user's explicit pin (default-sourced effort — no field sent; a
 *      thinkingLevelMap fold; or `softReasoningNone`, the code-defaulted
 *      none of cheap side-calls), no repair ran yet in this call, the format
 *      CAN express enablement, and the repair body actually differs from
 *      what was sent. Arms `mr` so the ladder's next attempt re-sends with
 *      reasoning enabled (messages bytes untouched — prefix cache safe).
 *    terminal — otherwise: the typed error surfaces with guidance and never
 *      retries, never falls back, never compresses. */
function classifyMandatoryRejection(
  which: "request" | "stream",
  status: number,
  detail: string,
  config: ProviderConfig,
  input: ModelInput,
  mr: MandatoryReasoningCall,
): ReasoningMandatoryError {
  const ctx = resolveReasoningContext(config);
  const effort = effectiveReasoningEffort(input, config);
  const sent = mr.body ?? (effort !== undefined ? reasoningFormatBody(ctx, effort) : {});
  const repairBody = mandatoryRepairReasoningBody(ctx);
  const repairable =
    // The explicit user "none" is a pin, never silently rewritten.
    (effort !== "none" || config.softReasoningNone === true)
    // Exactly one repair per call (a second rejection means the enable
    // shape itself failed — more retries are a dead ladder).
    && mr.body === undefined
    // The wire format must be able to say "reasoning on".
    && Object.keys(repairBody).length > 0
    // Already-enabled bytes: a repair would resend the identical request.
    && canonicalJson(repairBody) !== canonicalJson(sent);
  if (repairable) mr.body = repairBody;
  return new ReasoningMandatoryError(which, status, detail, config.provider ?? config.baseURL, effort, repairable);
}

/** One attempt + at most one max_tokens self-repair retry (non-streaming).
 * The retryContext records the applied override (single-shot by its
 * presence). Pure plumbing: the attempt receives the (possibly capped)
 * config. */
export async function generateOnceWithSelfRepair(
  config: ProviderConfig,
  input: ModelInput,
  doFetch: typeof fetch,
  keyPool: KeyPool,
  ratePause: RatePauseWindow,
  imageCtx: ImageRequestContext,
  retryContext: { maxTokensOverride?: number },
  persona: PersonaRuntime | undefined,
  mr: MandatoryReasoningCall,
): Promise<AssistantMessage> {
  try {
    return await generateOnce(config, input, doFetch, keyPool, ratePause, imageCtx, persona, mr);
  } catch (err) {
    // M70 §4: parseable max_tokens overflow → retry once with the reduced cap.
    if (!isMaxTokensOverflow400(err) || retryContext.maxTokensOverride !== undefined) throw err;
    retryContext.maxTokensOverride = selfRepairMaxTokensValue(parseMaxTokensOverflow(err.body)!);
    return generateOnce({ ...config, maxTokens: retryContext.maxTokensOverride }, input, doFetch, keyPool, ratePause, imageCtx, persona, mr);
  }
}

async function safeText(res: Response): Promise<string> {
  // 波次 8 #42 (hermes #24): bounded error-body read — byte cap + wall clock
  // + cancel-on-abandon, so a stalled or huge error body can neither hang the
  // request nor buffer unbounded. Never throws (the old catch contract).
  return readErrorBody(res);
}
