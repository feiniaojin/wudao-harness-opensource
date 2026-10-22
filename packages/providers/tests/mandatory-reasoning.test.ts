// ω99-42 — the typed mandatory-reasoning rejection (hermes f6bd1633f7 +
// 63279301bc, wudao layering). A reasoning-mandatory route (GLM-5.3 via
// Nous/OpenRouter, kimi-k2.7-code-style deployments) answers a request that
// disabled thinking with HTTP 400. The six acceptance lanes:
//   ① typed classification (repairable flavor / terminal flavor, no fallback)
//   ② repair retry — exactly one, reasoning enabled, messages bytes identical
//   ③ explicit user "none": zero repair, guidance surfaces
//   ④ one-shot pre-arm after a verified repair
//   ⑤ negative controls (other 400 shapes unchanged)
//   ⑥ the repair consumes the shared ladder budget
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  isRetryableProviderError,
  ProviderHttpError,
  ContextLengthError,
  // ω99-42 additions
  ReasoningMandatoryError,
  isMandatoryReasoningRejection,
  MANDATORY_REASONING_BODY_SIGNATURES,
  mandatoryRepairReasoningBody,
  type ProviderConfig,
  type RetryObserver,
} from "../src/index.js";
// The fallback predicate is a module face (not a package-index export — its
// consumers are the protocol factories).
import { isModelFallbackEligible } from "../src/openai-compatible.js";

/** The RECORDED mandatory-400 body (hermes f6bd1633f7, live on the Nous
 * Portal / OpenRouter z-ai/glm-5.3 route): HTTP 400 + this message. ω99-42
 * T0: no Nous/OpenRouter credential exists in this environment (auth 401s
 * before body validation — probes in the arc report), so the hermes live
 * recording is the fixture of record. */
const HERMES_MANDATORY_400 = JSON.stringify({
  error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled", code: 400 },
});

const OK_JSON = { choices: [{ message: { role: "assistant", content: "ok" } }] };
const OK_SSE = ["data: " + JSON.stringify({ choices: [{ delta: { content: "ok" } }] }) + "\n\n", "data: [DONE]\n\n"];

interface CallScript {
  readonly status?: number;
  readonly text?: string;
  readonly ok?: boolean;
  readonly sse?: string[];
}

/** Fake fetch playing a script, one entry per call, recording every body. */
function scriptedFetch(script: readonly CallScript[]): { fetch: typeof fetch; calls: () => number; bodies: () => string[] } {
  let n = 0;
  const bodies: string[] = [];
  const doFetch = (async (_url: unknown, init: unknown) => {
    bodies.push(String((init as { body?: unknown })?.body));
    const step = script[n];
    n += 1;
    if (step === undefined) throw new Error("scripted fetch exhausted");
    if (step.ok) return { ok: true, status: 200, json: async () => OK_JSON };
    if (step.sse) {
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of step.sse!) c.enqueue(enc.encode(chunk));
          c.close();
        },
      });
      return { ok: true, status: 200, body };
    }
    return { ok: false, status: step.status, text: async () => step.text ?? "" };
  }) as typeof fetch;
  return { fetch: doFetch, calls: () => n, bodies: () => bodies };
}

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant ladder (deterministic waits); observable retry log. */
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;

function recordedRetries(): { onRetry: RetryObserver; reasons: () => string[] } {
  const log: string[] = [];
  return { onRetry: (_n, _d, reason) => void log.push(reason), reasons: () => log };
}

/** The messages segment of a posted body, re-serialized canonically — the
 * byte-pin for the "two requests carry identical messages" invariant (the
 * repair may touch ONLY the request-level reasoning fields). */
function messagesOf(body: string): string {
  return JSON.stringify(JSON.parse(body).messages);
}

function reasoningOf(body: string): unknown {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  const { model: _m, messages: _msg, tools: _t, tool_choice: _tc, max_tokens: _mt, stream: _s, stream_options: _so, ...rest } = parsed;
  return rest;
}

/** qwen profile (enable_thinking lane, rider pinned off by the profile). */
const QWEN: ProviderConfig = {
  provider: "qwen",
  model: "qwen3-max",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "k",
};

/** glm profile (zai format; the thinkingLevelMap folds low/medium→disabled). */
const GLM: ProviderConfig = {
  provider: "glm",
  model: "glm-4.6",
  baseURL: "https://open.bigmodel.cn/api/paas/v4",
  apiKey: "k",
};

/** deepseek profile (reasoning_effort lane; accepts disabled thinking — the
 * 200-live-probed non-mandatory control). */
const DEEPSEEK: ProviderConfig = {
  provider: "deepseek",
  model: "deepseek-v4-flash",
  baseURL: "https://api.deepseek.com",
  apiKey: "k",
};

// ---------------------------------------------------------------------------
// Matcher + repair body — pure units
// ---------------------------------------------------------------------------

describe("isMandatoryReasoningRejection — conservative 400 + body vocabulary", () => {
  it("matches the recorded Nous/OpenRouter body (hermes fixture of record)", () => {
    expect(isMandatoryReasoningRejection(400, HERMES_MANDATORY_400)).toBe(true);
  });

  it("matches case variants and the sibling spellings", () => {
    expect(isMandatoryReasoningRejection(400, "reasoning is mandatory for this endpoint")).toBe(true);
    expect(isMandatoryReasoningRejection(400, "Thinking is mandatory")).toBe(true);
    expect(isMandatoryReasoningRejection(400, "Reasoning is required")).toBe(true);
  });

  it("status-gated: only 400 classifies (5xx/429 carrying the same text keep their existing paths)", () => {
    expect(isMandatoryReasoningRejection(500, HERMES_MANDATORY_400)).toBe(false);
    expect(isMandatoryReasoningRejection(429, HERMES_MANDATORY_400)).toBe(false);
  });

  it("body-gated: unrelated 400 vocabulary never matches", () => {
    expect(isMandatoryReasoningRejection(400, "invalid_request_error: unknown parameter")).toBe(false);
    expect(isMandatoryReasoningRejection(400, "This model's maximum context length is 65536 tokens")).toBe(false);
    expect(isMandatoryReasoningRejection(400, "")).toBe(false);
  });

  it("per-provider override: the caller may tighten or extend the signatures", () => {
    expect(isMandatoryReasoningRejection(400, "Custom gateway demands thought", [/demands thought/])).toBe(true);
    expect(isMandatoryReasoningRejection(400, HERMES_MANDATORY_400, [/demands thought/])).toBe(false);
    expect(MANDATORY_REASONING_BODY_SIGNATURES.length).toBeGreaterThan(0);
  });
});

describe("mandatoryRepairReasoningBody — the format's explicit enable (map-stripped, medium)", () => {
  const bare = (format: ProviderConfig["reasoningFormat"]): ProviderConfig => ({ ...DEEPSEEK, reasoningFormat: format });

  it("qwen: {enable_thinking: true} (rider off per profile)", () => {
    expect(mandatoryRepairReasoningBody({ format: "qwen", supportsReasoningEffort: false })).toEqual({ enable_thinking: true });
  });

  it("zai: {thinking: {type: \"enabled\"}} even under a map that folds medium→disabled", () => {
    const glmMap = { low: "disabled", medium: "disabled", high: "enabled", max: "enabled", none: "disabled" };
    expect(mandatoryRepairReasoningBody({ format: "zai", thinkingLevelMap: glmMap, supportsReasoningEffort: false })).toEqual({ thinking: { type: "enabled" } });
  });

  it("deepseek: {reasoning_effort: \"medium\"} (hermes' own default effort)", () => {
    expect(mandatoryRepairReasoningBody({ format: "deepseek", supportsReasoningEffort: true })).toEqual({ reasoning_effort: "medium" });
  });

  it("openrouter/together/baseten/qwen-chat-template express enablement in their own shapes", () => {
    expect(mandatoryRepairReasoningBody({ format: "openrouter", supportsReasoningEffort: false })).toEqual({ reasoning: { effort: "medium" } });
    expect(mandatoryRepairReasoningBody({ format: "together", supportsReasoningEffort: false })).toEqual({ reasoning: { enabled: true } });
    expect(mandatoryRepairReasoningBody({ format: "baseten", supportsReasoningEffort: false })).toEqual({ chat_template_args: { enable_thinking: true } });
    expect(mandatoryRepairReasoningBody({ format: "qwen-chat-template", supportsReasoningEffort: false })).toEqual({ chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } });
  });

  it("the \"none\" format cannot express reasoning — the repair body is empty (repair impossible)", () => {
    expect(mandatoryRepairReasoningBody({ format: "none", supportsReasoningEffort: false })).toEqual({});
    expect(bare("none")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// ① typed classification + ③ explicit user "none" (terminal, guidance)
// ---------------------------------------------------------------------------

describe("ω99-42 ①/③ — the typed face and the explicit-none pin", () => {
  it("① recorded body + explicit config none → ReasoningMandatoryError, attribution {provider, effortSent}, NOT retried, NOT fallback-eligible", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }]);
    const model = createOpenAICompatibleProvider({ ...QWEN, reasoningEffort: "none" }, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 4 } });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    const typed = err as ReasoningMandatoryError;
    expect(typed.name).toBe("ReasoningMandatoryError");
    expect(typed.provider).toBe("qwen");
    expect(typed.effortSent).toBe("none");
    expect(typed.repairable).toBe(false);
    expect(isRetryableProviderError(typed)).toBe(false);
    expect(isModelFallbackEligible(typed)).toBe(false);
    // ③ zero repair retries — the single fetch IS the whole call.
    expect(sf.calls()).toBe(1);
    // ③ the message carries the actionable guidance.
    expect(typed.message).toMatch(/requires reasoning/);
    expect(typed.message).toMatch(/none/);
    expect(typed.message).toMatch(/endpoint/);
  });

  it("① per-input explicit none is the same pin (no silent rewrite of the caller's effort)", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 4 } });
    const err = await model.generate({ ...INPUT, reasoningEffort: "none" }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    expect((err as ReasoningMandatoryError).repairable).toBe(false);
    expect(sf.calls()).toBe(1);
  });

  it("① the repairable flavor IS ladder-retryable but never fallback-eligible (classified from a budget-less call)", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 0 } });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    expect((err as ReasoningMandatoryError).repairable).toBe(true);
    expect((err as ReasoningMandatoryError).effortSent).toBeUndefined();
    expect(isRetryableProviderError(err)).toBe(true);
    expect(isModelFallbackEligible(err)).toBe(false);
  });

  it("① generic 4xx zero change: a neutral 400 stays ProviderHttpError (single fetch, not retried, not typed)", async () => {
    const sf = scriptedFetch([{ status: 400, text: "invalid_request_error: unknown parameter 'x'" }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 4 } });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(err).not.toBeInstanceOf(ReasoningMandatoryError);
    expect(isRetryableProviderError(err)).toBe(false);
    expect(sf.calls()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ② repair retry — exactly one, reasoning enabled, messages bytes identical
// ---------------------------------------------------------------------------

describe("ω99-42 ② — the cache-key-preserving repair retry", () => {
  it("default-sourced effort (no reasoning field sent) + mandatory-400 → one repair retry; messages byte-identical; reasoning enabled on the second wire", async () => {
    const rr = recordedRetries();
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, onRetry: rr.onRetry } });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    // exactly one repair retry
    expect(sf.calls()).toBe(2);
    expect(rr.reasons()).toEqual(["reasoning-mandatory"]);
    // first wire carried NO reasoning field (default effort); second carries enable_thinking: true
    expect(reasoningOf(sf.bodies()[0])).toEqual({});
    expect(reasoningOf(sf.bodies()[1])).toEqual({ enable_thinking: true });
    // M24: the messages serialization is byte-identical across the repair
    expect(messagesOf(sf.bodies()[0])).toBe(messagesOf(sf.bodies()[1]));
    expect(messagesOf(sf.bodies()[0])).toBe(JSON.stringify([{ role: "system", content: "s" }, { role: "user", content: "hi" }]));
  });

  it("map-folded disable (glm effort low → thinking disabled) is repairable: user asked for low, not none", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider({ ...GLM, reasoningEffort: "low" }, { fetch: sf.fetch, retry: INSTANT });
    await model.generate(INPUT);
    expect(sf.calls()).toBe(2);
    expect(reasoningOf(sf.bodies()[0])).toEqual({ thinking: { type: "disabled" } });
    expect(reasoningOf(sf.bodies()[1])).toEqual({ thinking: { type: "enabled" } });
    expect(messagesOf(sf.bodies()[0])).toBe(messagesOf(sf.bodies()[1]));
  });

  it("code-defaulted none (softReasoningNone — the sidecar classifier's config) is repairable", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider({ ...QWEN, reasoningEffort: "none", softReasoningNone: true }, { fetch: sf.fetch, retry: INSTANT });
    await model.generate(INPUT);
    expect(sf.calls()).toBe(2);
    expect(reasoningOf(sf.bodies()[0])).toEqual({ enable_thinking: false });
    expect(reasoningOf(sf.bodies()[1])).toEqual({ enable_thinking: true });
    expect(messagesOf(sf.bodies()[0])).toBe(messagesOf(sf.bodies()[1]));
  });

  it("stream lane: the repair replays before the first delta with reasoning enabled", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { sse: OK_SSE }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: INSTANT });
    const events: string[] = [];
    for await (const ev of model.stream(INPUT)) {
      if (ev.type === "done") events.push(ev.message.content);
    }
    expect(events).toEqual(["ok"]);
    expect(sf.calls()).toBe(2);
    expect(reasoningOf(sf.bodies()[0])).toEqual({});
    expect(reasoningOf(sf.bodies()[1])).toEqual({ enable_thinking: true });
    expect(messagesOf(sf.bodies()[0])).toBe(messagesOf(sf.bodies()[1]));
  });
});

// ---------------------------------------------------------------------------
// ④ one-shot pre-arm (session memory, not persisted)
// ---------------------------------------------------------------------------

describe("ω99-42 ④ — pre-armed after a verified repair", () => {
  it("the next request carries reasoning directly — no 400 round-trip; the observer fires once", async () => {
    let armed = 0;
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { ok: true }, { ok: true }]);
    const model = createOpenAICompatibleProvider(QWEN, {
      fetch: sf.fetch,
      retry: INSTANT,
      onMandatoryRepairApplied: () => { armed += 1; },
    });
    await model.generate(INPUT);
    expect(armed).toBe(1);
    await model.generate(INPUT);
    // call 2: pre-armed — a direct hit, no mandatory-400 first
    expect(sf.calls()).toBe(3);
    expect(reasoningOf(sf.bodies()[2])).toEqual({ enable_thinking: true });
    expect(armed).toBe(1);
  });

  it("an unverified repair (second 400) never arms the flag and stops exactly at one repair", async () => {
    let armed = 0;
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }, { status: 400, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider(QWEN, {
      fetch: sf.fetch,
      retry: { ...INSTANT, maxRetries: 4 },
      onMandatoryRepairApplied: () => { armed += 1; },
    });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    expect((err as ReasoningMandatoryError).repairable).toBe(false);
    // the repaired retry 400'd again → terminal; nothing further
    expect(sf.calls()).toBe(2);
    expect(armed).toBe(0);
    expect(reasoningOf(sf.bodies()[1])).toEqual({ enable_thinking: true });
  });
});

// ---------------------------------------------------------------------------
// ⑤ negative controls + ⑥ the shared ladder budget
// ---------------------------------------------------------------------------

describe("ω99-42 ⑤ — non-mandatory shapes keep every existing behavior", () => {
  it("a context-length 400 still classifies ContextLengthError (order: context-length first)", async () => {
    const sf = scriptedFetch([{ status: 400, text: "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens" }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: INSTANT });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ContextLengthError);
    expect(sf.calls()).toBe(1);
  });

  it("a 500 carrying the mandatory text keeps the generic retryable transport path (status gate)", async () => {
    const sf = scriptedFetch([{ status: 500, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: INSTANT });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(sf.calls()).toBe(2);
  });

  it("non-mandatory path bytes: a healthy request with effort configured is byte-identical to pre-ω99-42", async () => {
    const sf = scriptedFetch([{ ok: true }]);
    const model = createOpenAICompatibleProvider({ ...GLM, reasoningEffort: "high" }, { fetch: sf.fetch });
    await model.generate(INPUT);
    const body = JSON.parse(sf.bodies()[0]) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["model", "messages", "tools", "tool_choice", "thinking"]);
    expect(body["thinking"]).toEqual({ type: "enabled" });
    expect(body["max_tokens"]).toBeUndefined();
  });
});

describe("ω99-42 ⑥ — the repair consumes the shared per-turn ladder budget", () => {
  it("maxRetries=0: no budget → no repair, the repairable typed error surfaces after ONE fetch", async () => {
    const sf = scriptedFetch([{ status: 400, text: HERMES_MANDATORY_400 }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 0 } });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    expect((err as ReasoningMandatoryError).repairable).toBe(true);
    expect(sf.calls()).toBe(1);
  });

  it("a prior transport retry exhausts the shared budget: the repair does NOT run", async () => {
    const sf = scriptedFetch([{ status: 429, text: "rate limited" }, { status: 400, text: HERMES_MANDATORY_400 }, { ok: true }]);
    const model = createOpenAICompatibleProvider(QWEN, { fetch: sf.fetch, retry: { ...INSTANT, maxRetries: 1 } });
    const err = await model.generate(INPUT).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ReasoningMandatoryError);
    // the 429 consumed the only slot; the mandatory rejection surfaced unrepaired
    expect(sf.calls()).toBe(2);
    expect(reasoningOf(sf.bodies()[1])).toEqual({});
  });
});


