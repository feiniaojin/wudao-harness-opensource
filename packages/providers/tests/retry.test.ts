// M26 P11 — retry ladder: trigger matrix, backoff sequence, jitter bounds,
// AbortError short-circuit, stream first-delta rule.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOpenAICompatibleProvider,
  withRetry,
  withRetryStream,
  isRetryableProviderError,
  isNetworkClassFailure,
  backoffDelayMs,
  defaultMaxRetries,
  DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER,
  DEFAULT_NETWORK_GRACE_MAX_DELAY_MS,
  ProviderHttpError,
  type RetryObserver,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OK_JSON = { choices: [{ message: { role: "assistant", content: "RETRY-SENTINEL" } }] };

interface CallScript {
  readonly status?: number;
  readonly text?: string;
  /** Reject the fetch call itself (network failure). */
  readonly reject?: Error;
  /** 200 + JSON body (successful generate). */
  readonly ok?: boolean;
  /** 200 + SSE body (successful stream). */
  readonly sse?: string[];
  /** 200 + SSE body that yields chunks then errors (mid-stream break). */
  readonly sseThenError?: { chunks: string[]; error: Error };
  /** 200 + SSE body that errors before any data. */
  readonly sseImmediateError?: Error;
}

/** Fake fetch playing a script, one entry per call, counting every call. */
function scriptedFetch(script: readonly CallScript[]): { fetch: typeof fetch; calls: () => number; bodies: () => string[] } {
  let n = 0;
  const bodies: string[] = [];
  const doFetch = (async (_url: unknown, _init: unknown) => {
    bodies.push(String((_init as { body?: unknown })?.body));
    const step = script[n];
    n += 1;
    if (step === undefined) throw new Error("scripted fetch exhausted");
    if (step.reject) throw step.reject;
    if (step.ok) return { ok: true, status: 200, json: async () => OK_JSON };
    if (step.sse) return { ok: true, status: 200, body: sseBody(step.sse) };
    if (step.sseThenError) return { ok: true, status: 200, body: sseBodyThenError(step.sseThenError.chunks, step.sseThenError.error) };
    if (step.sseImmediateError) return { ok: true, status: 200, body: erroringBody(step.sseImmediateError) };
    return { ok: false, status: step.status, text: async () => step.text ?? "" };
  }) as typeof fetch;
  return { fetch: doFetch, calls: () => n, bodies: () => bodies };
}

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

function sseBodyThenError(chunks: string[], error: Error): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  // pull-based: chunk reads must complete BEFORE the error — erroring a
  // stream with queued chunks discards them, and we need the delta delivered
  // so the break lands strictly after the first yielded event.
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++] ?? ""));
      else controller.error(error);
    },
  });
}

function erroringBody(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant, deterministic ladder knobs for trigger-matrix tests. */
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;

function recordedRetries(): { onRetry: RetryObserver; log: Array<{ n: number; delayMs: number; reason: string }> } {
  const log: Array<{ n: number; delayMs: number; reason: string }> = [];
  return { onRetry: (n, delayMs, reason) => void log.push({ n, delayMs, reason }), log };
}

afterEach(() => {
  delete process.env.WUDAO_MAX_RETRIES;
});

// ---------------------------------------------------------------------------
// Trigger matrix — generate path
// ---------------------------------------------------------------------------

describe("retry trigger matrix (generate)", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    it(`retries HTTP ${status} and succeeds on the next attempt`, async () => {
      // M47 §7: the body stays neutral ("transient") — "overloaded" now means
      // something specific (the overload class changes reason/delay) and this
      // matrix pins the STATUS trigger only.
      const { fetch, calls } = scriptedFetch([{ status, text: "transient" }, { ok: true }]);
      const { onRetry, log } = recordedRetries();
      const model = createOpenAICompatibleProvider(
        { apiKey: "k", baseURL: "https://x/v1", model: "m" },
        { fetch, onRetry, retry: INSTANT },
      );
      const msg = await model.generate(INPUT);
      expect(msg.content).toBe("RETRY-SENTINEL");
      expect(calls()).toBe(2);
      expect(log).toEqual([{ n: 1, delayMs: 500, reason: String(status) }]);
    });
  }

  it("retries a network fetch rejection (non-abort)", async () => {
    const { fetch, calls } = scriptedFetch([
      { reject: new TypeError("fetch failed") },
      { ok: true },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("RETRY-SENTINEL");
    expect(calls()).toBe(2);
    expect(log.length).toBe(1);
    expect(log[0]?.reason).toBe("fetch failed");
  });

  it("retries 529 folded into the message string under an unlisted status", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 400, text: "upstream returned 529 overloaded" },
      { ok: true },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    await model.generate(INPUT);
    expect(calls()).toBe(2);
    expect(log.length).toBe(1);
  });

  for (const status of [400, 401, 404, 422]) {
    it(`does NOT retry HTTP ${status} (argument/client errors surface at once)`, async () => {
      const { fetch, calls } = scriptedFetch([{ status, text: "bad request" }]);
      const { onRetry, log } = recordedRetries();
      const model = createOpenAICompatibleProvider(
        { apiKey: "k", baseURL: "https://x/v1", model: "m" },
        { fetch, onRetry, retry: INSTANT },
      );
      await expect(model.generate(INPUT)).rejects.toThrow(new RegExp(`\\b${status}\\b`));
      expect(calls()).toBe(1);
      expect(log).toEqual([]);
    });
  }

  it("does not retry AbortError — it short-circuits the ladder", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { fetch, calls } = scriptedFetch([{ reject: abort }]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: { ...INSTANT, sleep: async () => { throw new Error("must not sleep on abort"); } } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toBe(1);
    expect(log).toEqual([]);
  });

  it("does not retry the semantic missing-message error", async () => {
    const badJson = { ok: true, status: 200, json: async () => ({}) };
    let n = 0;
    const fetch = (async () => {
      n += 1;
      return badJson;
    }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    await expect(model.generate(INPUT)).rejects.toThrow(/missing choices/);
    expect(n).toBe(1);
    expect(log).toEqual([]);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 503, text: "down" }, { status: 503, text: "down" }, { status: 503, text: "down" }]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } },
    );
    await expect(model.generate(INPUT)).rejects.toThrow(/503/);
    expect(calls()).toBe(3); // 1 attempt + 2 retries
    expect(log.map((r) => r.n)).toEqual([1, 2]);
  });

  // 133 #11（codex 5937592c07 核查项）——退避帽纪律：复位只许由成功或凭据
  // 变化触发，永不由到达上限触发。codex 的锯齿 bug 是"到帽→复位 attempt→
  // 又从 500ms 快试"。我们的梯结构免疫（attempt 是循环局部量、到帽 throw
  // 上抛），这枚钉防将来有人在梯内加"到帽复位"逻辑：失败串里 attempt 序号
  // 必须严格递增 1..N 且到帽终止（calls 数有界），延误序列（去抖动前的
  // scheduled 值）非降。核查面：withRetry/withRetryStream 双梯（两梯同构）。
  it("133 #11 — ladder discipline: attempt counter never resets at the cap (no sawtooth)", async () => {
    const { fetch, calls } = scriptedFetch(
      Array.from({ length: 8 }, () => ({ status: 503, text: "down" })),
    );
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: { ...INSTANT, maxRetries: 5, jitterRatio: 0 } },
    );
    await expect(model.generate(INPUT)).rejects.toThrow(/503/);
    // 到帽终止：1 次 + 5 重试，绝无第二次从 1 数起
    expect(calls()).toBe(6);
    expect(log.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    // 延误（jitter 关掉后的 scheduled 值）非降——复位会看见 4000 后回到 500
    const delays = log.map((r) => r.delayMs);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
  });
});

// ---------------------------------------------------------------------------
// Stream path — retry only before the first delta
// ---------------------------------------------------------------------------

describe("retry on the stream path", () => {
  const GOOD_SSE = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
    "data: [DONE]\n\n",
  ];

  it("retries a 429 before any delta and delivers the second attempt's events once", async () => {
    const { fetch, calls } = scriptedFetch([{ status: 429, text: "rate limited" }, { sse: GOOD_SSE }]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
    }
    expect(events.join("")).toBe("Hello");
    expect(calls()).toBe(2);
    expect(log).toEqual([{ n: 1, delayMs: 500, reason: "429" }]);
  });

  it("retries a stream that breaks before the first delta", async () => {
    const { fetch, calls } = scriptedFetch([
      { sseImmediateError: new TypeError("terminated") },
      { sse: GOOD_SSE },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
    }
    expect(events.join("")).toBe("Hello");
    expect(calls()).toBe(2);
    expect(log.length).toBe(1);
  });

  it("does NOT retry a break after the first delta — the error reaches the loop", async () => {
    const { fetch, calls } = scriptedFetch([
      { sseThenError: { chunks: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'], error: new TypeError("terminated mid-stream") } },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ev of model.stream!(INPUT)) {
          if (ev.type === "text_delta") seen.push(ev.text);
        }
      })(),
    ).rejects.toThrow(/terminated mid-stream/);
    // The already-delivered output was NOT replayed.
    expect(seen).toEqual(["partial"]);
    expect(calls()).toBe(1);
    expect(log).toEqual([]);
  });

  it("does not retry an aborted stream", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { fetch, calls } = scriptedFetch([{ sseImmediateError: abort }]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    await expect(
      (async () => {
        for await (const _ev of model.stream!(INPUT)) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls()).toBe(1);
    expect(log).toEqual([]);
  });

  // ω99-44 §2.2 — EOF truncation rides the EXISTING ladder (no new retry
  // machinery: TruncatedStreamError is classified transport-class and obeys
  // the first-delta rule like StreamIdleError).
  it("retries an EOF truncation BEFORE the first delta; the replayed request is byte-identical", async () => {
    // First call: a half event, then a CLEAN EOF — no terminal ever arrives.
    // Second call: the good body.
    const { fetch, calls, bodies } = scriptedFetch([
      { sse: ['data: {"choices":[{"delta":{"con'] },
      { sse: GOOD_SSE },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
    }
    expect(events.join("")).toBe("Hello");
    expect(calls()).toBe(2); // 1 cut attempt + 1 replay
    expect(log.length).toBe(1); // the ladder announced exactly one retry
    // Prefix-cache safety: the replay re-serialized the same input bytes.
    expect(bodies()[1]).toBe(bodies()[0]);
  });

  it("does NOT retry an EOF truncation after the first delta — the typed error reaches the loop", async () => {
    // A content delta is delivered, then a clean EOF with no [DONE] and no
    // finish_reason: the first-delta rule keeps the error propagation shape
    // (same as StreamIdleError) instead of replaying duplicated output.
    const { fetch, calls } = scriptedFetch([
      { sse: ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'] },
    ]);
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: INSTANT },
    );
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const ev of model.stream!(INPUT)) {
          if (ev.type === "text_delta") seen.push(ev.text);
        }
      })(),
    ).rejects.toMatchObject({ name: "TruncatedStreamError", provider: "openai-compatible" });
    expect(seen).toEqual(["partial"]); // already-delivered output, once
    expect(calls()).toBe(1);
    expect(log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Backoff schedule + jitter bounds
// ---------------------------------------------------------------------------

describe("backoffDelayMs", () => {
  it("is 500ms × 2ⁿ capped at 32s", () => {
    const mid = { random: (): number => 0.5 } as const; // jitter factor exactly 1
    expect(backoffDelayMs(0, mid)).toBe(500);
    expect(backoffDelayMs(1, mid)).toBe(1000);
    expect(backoffDelayMs(2, mid)).toBe(2000);
    expect(backoffDelayMs(3, mid)).toBe(4000);
    expect(backoffDelayMs(6, mid)).toBe(32_000); // 500 × 64 = cap
    expect(backoffDelayMs(10, mid)).toBe(32_000); // would be 512000 — capped
  });

  it("jitters within ±25% of the scheduled wait", () => {
    expect(backoffDelayMs(1, { random: () => 0 })).toBeCloseTo(750, 5);   // 1000 × 0.75
    expect(backoffDelayMs(1, { random: () => 1 })).toBeCloseTo(1250, 5); // 1000 × 1.25
    expect(backoffDelayMs(1, { jitterRatio: 0, random: () => 0 })).toBe(1000);
    // Default Math.random: sampled delays stay inside the bounds.
    for (let i = 0; i < 500; i += 1) {
      const d = backoffDelayMs(2); // scheduled 2000
      expect(d).toBeGreaterThanOrEqual(1500);
      expect(d).toBeLessThanOrEqual(2500);
    }
  });
});

describe("withRetry — real default sleep under fake timers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits 500, 1000, 2000, 4000 across the default 4 retries", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const onRetry = vi.fn();
    const p = withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts < 5) throw new Error("provider request failed: 429 rate limited");
        return "ok";
      },
      { random: () => 0.5, onRetry },
    );
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("ok");
    expect(attempts).toBe(5);
    expect(onRetry.mock.calls.map((c) => c[0])).toEqual([1, 2, 3, 4]);
    expect(onRetry.mock.calls.map((c) => c[1])).toEqual([500, 1000, 2000, 4000]);
    expect(onRetry.mock.calls.map((c) => c[2])).toEqual(["429", "429", "429", "429"]);
  });

  it("WUDAO_MAX_RETRIES bounds the ladder", async () => {
    process.env.WUDAO_MAX_RETRIES = "2";
    let attempts = 0;
    await expect(
      withRetry(
        async (): Promise<string> => {
          attempts += 1;
          throw new Error("provider request failed: 500 boom");
        },
        // Instant sleep: the env resolution is under test, not the waiting.
        { sleep: async (): Promise<void> => {} },
      ),
    ).rejects.toThrow(/500/);
    expect(attempts).toBe(3); // 1 attempt + 2 retries
  });

  it("WUDAO_MAX_RETRIES junk falls back to 4; 0 disables retries", () => {
    expect(defaultMaxRetries({})).toBe(4);
    expect(defaultMaxRetries({ WUDAO_MAX_RETRIES: "" })).toBe(4);
    expect(defaultMaxRetries({ WUDAO_MAX_RETRIES: "abc" })).toBe(4);
    expect(defaultMaxRetries({ WUDAO_MAX_RETRIES: "-1" })).toBe(4);
    expect(defaultMaxRetries({ WUDAO_MAX_RETRIES: "0" })).toBe(0);
    expect(defaultMaxRetries({ WUDAO_MAX_RETRIES: "7" })).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Classification unit checks
// ---------------------------------------------------------------------------

describe("isRetryableProviderError", () => {
  it("classifies the boundary cases", () => {
    const abort = Object.assign(new Error("whatever"), { name: "AbortError" });
    expect(isRetryableProviderError(abort)).toBe(false);
    expect(isRetryableProviderError(new Error("provider request failed: 429 rate limited"))).toBe(true);
    expect(isRetryableProviderError(new Error("provider stream failed: 503 unavailable"))).toBe(true);
    expect(isRetryableProviderError(new Error("provider request failed: 401 no key"))).toBe(false);
    expect(isRetryableProviderError(new Error("provider request failed: 400 upstream 529"))).toBe(true);
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableProviderError(new Error("provider response missing choices[0].message"))).toBe(false);
    expect(isRetryableProviderError("not an error")).toBe(false);
  });
});

describe("波次8 #44 (hermes #12): TLS certificate failures are deterministic — fail fast, never retry", () => {
  const certErr = (code: string): TypeError =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("unable to verify the first certificate"), { code }) });

  it("① cert-validation causes classify NOT retryable (top-level and nested cause)", () => {
    expect(isRetryableProviderError(certErr("UNABLE_TO_VERIFY_LEAF_SIGNATURE"))).toBe(false);
    expect(isRetryableProviderError(certErr("SELF_SIGNED_CERT_IN_CHAIN"))).toBe(false);
    expect(isRetryableProviderError(certErr("CERT_HAS_EXPIRED"))).toBe(false);
    expect(isRetryableProviderError(certErr("ERR_TLS_CERT_ALTNAME_INVALID"))).toBe(false);
    // nested: undici wraps twice (TypeError → cause Error → cause …)
    expect(isRetryableProviderError(new TypeError("fetch failed", { cause: certErr("DEPTH_ZERO_SELF_SIGNED_CERT") }))).toBe(false);
  });

  it("② transient transports stay retryable (ECONNRESET / ETIMEDOUT / ENOTFOUND / bare TypeError)", () => {
    const transport = (code: string): TypeError =>
      new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code }) });
    expect(isRetryableProviderError(transport("ECONNRESET"))).toBe(true);
    expect(isRetryableProviderError(transport("ETIMEDOUT"))).toBe(true);
    expect(isRetryableProviderError(transport("ENOTFOUND"))).toBe(true);
    expect(isRetryableProviderError(new TypeError("fetch failed"))).toBe(true);
  });

  it("③ the ladder burns ZERO retries on a cert failure (single attempt)", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const boom = certErr("UNABLE_TO_VERIFY_LEAF_SIGNATURE");
    await expect(withRetry(async () => { attempts += 1; throw boom; }, {
      maxRetries: 4,
      sleep: async (ms) => { sleeps.push(ms); },
    })).rejects.toThrow("fetch failed");
    expect(attempts).toBe(1);
    expect(sleeps).toHaveLength(0);
  });
});

describe("波次8 #46 (hermes #12): 5xx-wrapped request-validation failures are deterministic — never retry", () => {
  // The typed error carries `.body` (the real classification source); a bare
  // Error only embeds it in the message — both paths must classify.
  const httpErr = (status: number, body: string) => new ProviderHttpError("request", status, body);

  it("① a 5xx body carrying request-validation vocabulary classifies NOT retryable", () => {
    expect(isRetryableProviderError(httpErr(500, `{"error":{"type":"invalid_request_error","message":"Unknown parameter: 'foo'"}}`))).toBe(false);
    expect(isRetryableProviderError(httpErr(502, "Unrecognized request argument: tools"))).toBe(false);
    expect(isRetryableProviderError(httpErr(503, `{"error":{"code":"unknown_parameter","message":"bad"}}`))).toBe(false);
    expect(isRetryableProviderError(httpErr(500, "unsupported parameter: reasoning_effort"))).toBe(false);
    // the message-only degenerate path (non-typed error, body in the message)
    expect(isRetryableProviderError(new Error("provider request failed: 500 invalid_request_error: Unknown parameter"))).toBe(false);
  });

  it("② a genuinely-transient 5xx stays retryable (neutral body); the rate class is untouched", () => {
    expect(isRetryableProviderError(httpErr(500, "internal server error"))).toBe(true);
    expect(isRetryableProviderError(httpErr(502, "transient"))).toBe(true);
    expect(isRetryableProviderError(httpErr(429, `{"error":{"type":"invalid_request_error","message":"Unknown parameter"}}`))).toBe(true);
    // a 4xx with validation vocabulary was ALREADY non-retryable — witness
    expect(isRetryableProviderError(httpErr(404, "unknown parameter"))).toBe(false);
  });

  it("③ the ladder burns ZERO retries on a gateway-wrapped validation 500 (single fetch call)", async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 500, text: `{"error":{"type":"invalid_request_error","message":"Unknown parameter: 'temperature'"}}` },
    ]);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: INSTANT },
    );
    await expect(model.generate(INPUT)).rejects.toThrow(/invalid_request_error/);
    expect(calls()).toBe(1);
  });
});

describe("124 项 2 — the network-outage grace window (WiFi drop / router reboot / overnight loss)", () => {
  // Reusable transport wrappers (same shape as the cert / transient family
  // above): undici surfaces fetch rejects as TypeError("fetch failed") with
  // the real cause on .cause (often wrapped twice).
  const transport = (code: string): TypeError =>
    new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code }) });

  // The grace window is opt-in: with networkGrace.enabled unset/absent, the
  // ladder must keep its pre-grace byte-stable semantics for both network
  // and business-class failures.
  it("① off by default: a network-class failure still hits the base maxRetries (4)", async () => {
    const attempts: number[] = [];
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw transport("ECONNRESET"); }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
      }),
    ).rejects.toThrow("fetch failed");
    // 1 initial + 4 retries = 5 attempts (pre-grace behavior).
    expect(attempts).toHaveLength(5);
  });

  it("② off by default: business-class 500/429 NEVER enter the grace window", async () => {
    const attempts: number[] = [];
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw new ProviderHttpError("request", 503, "unavailable"); }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
      }),
    ).rejects.toThrow(/503/);
    expect(attempts).toHaveLength(5); // unchanged — 503 is business-class, never widened
  });

  it("③ on + network: maxRetries is multiplied by DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER", async () => {
    const attempts: number[] = [];
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw transport("ETIMEDOUT"); }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
        networkGrace: { enabled: true },
      }),
    ).rejects.toThrow("fetch failed");
    // base × multiplier + initial = 4 × 3 + 1 = 13 attempts
    expect(attempts).toHaveLength(4 * DEFAULT_NETWORK_GRACE_RETRY_MULTIPLIER + 1);
  });

  it("④ on + network: a single-wait cap of DEFAULT_NETWORK_GRACE_MAX_DELAY_MS is honored", () => {
    // backoffDelayMs with the grace cap: attempt N wait stays below the
    // grace ceiling even for a high-N retry (the pre-grace 32s cap would
    // have clipped it earlier).
    const high = 8; // beyond the pre-grace cap (32s / 500ms = ~6 rungs)
    const grace = backoffDelayMs(high, { maxDelayMsMs: DEFAULT_NETWORK_GRACE_MAX_DELAY_MS });
    expect(grace).toBeLessThanOrEqual(DEFAULT_NETWORK_GRACE_MAX_DELAY_MS);
    expect(grace).toBeGreaterThanOrEqual(0);
  });

  it("⑤ on + 4xx (business): the 4xx NEVER widens, even though grace is enabled", async () => {
    const attempts: number[] = [];
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw new ProviderHttpError("request", 400, "bad request"); }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
        networkGrace: { enabled: true },
      }),
    ).rejects.toThrow(/400/);
    expect(attempts).toHaveLength(1); // 400 is not retryable to begin with
  });

  it("⑥ onEnter fires once on the FIRST network-class failure; subsequent failures stay silent", async () => {
    const enters: number[] = [];
    const attempts: number[] = [];
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw transport("ENOTFOUND"); }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
        networkGrace: {
          enabled: true,
          onEnter: () => { enters.push(Date.now()); },
        },
      }),
    ).rejects.toThrow("fetch failed");
    expect(attempts.length).toBe(13);
    expect(enters).toHaveLength(1); // idempotent across the whole lifetime
  });

  it("⑦ mixed stream: a non-network failure between two network-class attempts still widens the ladder (network is the wider class)", async () => {
    const sequence: Array<"net" | "biz"> = ["net", "biz", "net", "biz", "net", "net", "net", "net", "net", "net", "net", "net", "net"];
    let i = 0;
    const attempts: number[] = [];
    await expect(
      withRetry(async () => {
        attempts.push(i);
        const kind = sequence[i] ?? "net";
        i += 1;
        if (kind === "net") throw transport("ECONNREFUSED");
        throw new ProviderHttpError("request", 503, "unavailable");
      }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
        networkGrace: { enabled: true },
      }),
    ).rejects.toThrow(/fetch failed|503/);
    // 13 attempts: the first network failure widens the cap, every 503
    // between networks keeps the wider cap (the EFFECTIVE cap was raised
    // once and stays raised for this lifetime).
    expect(attempts.length).toBe(13);
  });

  it("⑧ fatal TLS still short-circuits (deterministic, never enters the grace window)", async () => {
    const attempts: number[] = [];
    const certErr = new TypeError("fetch failed", { cause: Object.assign(new Error("unable to verify the first certificate"), { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }) });
    await expect(
      withRetry(async () => { attempts.push(Date.now()); throw certErr; }, {
        maxRetries: 4,
        sleep: async (ms) => { void ms; },
        networkGrace: { enabled: true },
      }),
    ).rejects.toThrow("fetch failed");
    expect(attempts).toHaveLength(1); // never retries, never widens
  });

  it("⑨ classifier pin: isNetworkClassFailure covers fetch/EAI/ECONN/socket-hang vocabulary", () => {
    expect(isNetworkClassFailure(new TypeError("fetch failed"))).toBe(true);
    expect(isNetworkClassFailure(transport("ECONNRESET"))).toBe(true);
    expect(isNetworkClassFailure(transport("ETIMEDOUT"))).toBe(true);
    expect(isNetworkClassFailure(transport("ENOTFOUND"))).toBe(true);
    expect(isNetworkClassFailure(transport("EAI_AGAIN"))).toBe(true);
    expect(isNetworkClassFailure(transport("ECONNREFUSED"))).toBe(true);
    expect(isNetworkClassFailure(new Error("socket hang up"))).toBe(true);
    expect(isNetworkClassFailure(new Error("network timeout"))).toBe(true);
    // Business-class never classifies as network.
    expect(isNetworkClassFailure(new ProviderHttpError("request", 429, "rate limited"))).toBe(false);
    expect(isNetworkClassFailure(new ProviderHttpError("request", 500, "boom"))).toBe(false);
    expect(isNetworkClassFailure(new ProviderHttpError("request", 503, "unavailable"))).toBe(false);
    // Deterministic typed failures never classify as network.
    const ctx = new (class extends Error { constructor() { super("ctx"); this.name = "ContextLengthError"; } })();
    expect(isNetworkClassFailure(ctx)).toBe(false);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isNetworkClassFailure(abort)).toBe(false);
  });

  it("⑩ withRetryStream: pre-delta network-class retry widens identically; post-delta rethrows untouched", async () => {
    let attempted = 0;
    const stream = async function* (): AsyncGenerator<unknown> {
      attempted += 1;
      // Pretend we yielded something already (post-delta path) only on attempt 2.
      if (attempted === 2) {
        yield { type: "delta" };
      }
      throw transport("ENETUNREACH");
    };
    const got: unknown[] = [];
    await expect((async () => {
      for await (const ev of withRetryStream(stream, { maxRetries: 4, sleep: async (ms) => { void ms; }, networkGrace: { enabled: true } })) {
        got.push(ev);
      }
    })()).rejects.toThrow("fetch failed");
    // Attempt 1: pre-delta network → retry. Attempt 2: yielded then network → post-delta rethrow.
    expect(attempted).toBe(2);
    expect(got).toHaveLength(1);
  });
});
