// 113-B3 — the account-quota park classification: the glm-5.3 marathon body
// (429 + 使用上限 + 重置时刻), the English reset spellings, the Retry-After
// header fallback, and the iron negatives (a plain 429 with no reset info
// keeps the ordinary ladder path; ≤60s waits never park; non-429 statuses
// never classify). Plus the boundary behavior: the typed QuotaParkError is
// thrown BEFORE the generic ProviderHttpError, with zero ladder retries and
// zero model-fallback legs.
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  QuotaParkError,
  isQuotaParkFailure,
  isRetryableProviderError,
  parseQuotaResetAt,
  sniffQuotaBody,
  tryQuotaParkError,
} from "../src/index.js";
import { isModelFallbackEligible } from "../src/openai-compatible.js";
import { RETRY_AFTER_FAIL_CAP_MS } from "../src/retry-after.js";

// A fixed "now" so the absolute-parse assertions never touch the wall clock.
const NOW = Date.parse("2026-09-24T02:12:00"); // local time
const CN_RESET = "2026-09-24 05:30:32"; // ~3h18m after NOW

/** The real marathon recording shape (glm-5.3 账户级配额): the error body the
 *  ladder used to die on. */
const GLM_BODY = `[1308][已达到 5 小时的使用上限。您的限额将在 ${CN_RESET} 重置。]`;

describe("quota-park classification (113-B3)", () => {
  it("matches the real glm-5.3 marathon body", () => {
    expect(sniffQuotaBody(GLM_BODY)).toBe(true);
    expect(isQuotaParkFailure(429, GLM_BODY, undefined, NOW)).toBe(true);
  });

  it("parses the Chinese absolute reset wording (local wall clock)", () => {
    const at = parseQuotaResetAt(GLM_BODY, undefined, NOW);
    expect(at).toBeDefined();
    // Local-wall-clock semantics: the timestamp parses as-of the host's zone.
    expect(at!.getTime()).toBe(Date.parse(`${CN_RESET.replace(" ", "T")}`));
  });

  it("parses the English absolute wording (honoring an explicit zone)", () => {
    const at = parseQuotaResetAt("rate limit reached — resets at 2026-09-24T07:00:00Z", undefined, NOW);
    expect(at!.getTime()).toBe(Date.parse("2026-09-24T07:00:00Z"));
    const local = parseQuotaResetAt("usage limit exceeded, will reset on 2026-09-24 07:00:00", undefined, NOW);
    expect(local!.getTime()).toBe(Date.parse("2026-09-24T07:00:00"));
  });

  it("parses a body Reset-After seconds figure", () => {
    const at = parseQuotaResetAt('{"error":{"code":1308,"message":"quota exceeded","reset_after":5400}}', undefined, NOW);
    expect(at!.getTime()).toBe(NOW + 5_400_000);
  });

  it("falls back to the Retry-After header wait (already-parsed ms)", () => {
    const at = parseQuotaResetAt("429 Too Many Requests: quota exceeded", 3_600_000, NOW);
    expect(at!.getTime()).toBe(NOW + 3_600_000);
  });

  it("a plain 429 without any reset information never classifies", () => {
    expect(isQuotaParkFailure(429, "Too Many Requests", undefined, NOW)).toBe(false);
    // Even with the quota vocabulary — no parseable moment, no park.
    expect(isQuotaParkFailure(429, "quota exceeded, please slow down", undefined, NOW)).toBe(false);
  });

  it("a reset within the 60s fail cap never classifies (existing ladder semantics)", () => {
    // Body-relative seconds below/at the cap → the ladder owns it.
    expect(isQuotaParkFailure(429, "quota exceeded, Reset-After: 30", undefined, NOW)).toBe(false);
    expect(isQuotaParkFailure(429, "quota exceeded, Reset-After: 60", undefined, NOW)).toBe(false);
    // Header wait exactly at cap → still the ladder (the existing `>` rule).
    expect(isQuotaParkFailure(429, "rate limit", RETRY_AFTER_FAIL_CAP_MS, NOW)).toBe(false);
    // One second past the cap → park.
    expect(isQuotaParkFailure(429, "rate limit", RETRY_AFTER_FAIL_CAP_MS + 1_000, NOW)).toBe(true);
  });

  it("non-429 statuses never classify (the context-length family keeps its lane)", () => {
    expect(isQuotaParkFailure(413, GLM_BODY, undefined, NOW)).toBe(false);
    expect(isQuotaParkFailure(400, "usage limit exceeded", undefined, NOW)).toBe(false);
    expect(isQuotaParkFailure(500, "quota exceeded Reset-After: 3600", undefined, NOW)).toBe(false);
  });

  it("a reset instant already in the past does not park (server says: already reset)", () => {
    const past = "2026-09-24 02:00:00"; // 12min BEFORE NOW
    expect(isQuotaParkFailure(429, `已达到使用上限，将在 ${past} 重置`, undefined, NOW)).toBe(false);
  });

  it("tryQuotaParkError builds the typed error with resetAt + provider identity", () => {
    const err = tryQuotaParkError("request", 429, GLM_BODY, undefined, { provider: "glm", model: "glm-5.3" }, NOW);
    expect(err).toBeInstanceOf(QuotaParkError);
    expect(err!.name).toBe("QuotaParkError");
    expect(err!.provider).toBe("glm");
    expect(err!.model).toBe("glm-5.3");
    expect(err!.resetAt.getTime()).toBe(Date.parse(`${CN_RESET.replace(" ", "T")}`));
    // The message must NOT carry the transport prefix a message-regex consumer
    // could misread as a retryable status.
    expect(err!.message.startsWith("provider quota reached:")).toBe(true);
    expect(/^provider (?:request|stream) failed: \d{3}/.test(err!.message)).toBe(false);
    // A miss returns undefined (the caller falls through to ProviderHttpError).
    expect(tryQuotaParkError("request", 429, "Too Many Requests", undefined, {}, NOW)).toBeUndefined();
  });

  it("the ladder never retries it and the fallback chain never swaps legs for it", () => {
    const err = tryQuotaParkError("stream", 429, GLM_BODY, undefined, { provider: "glm" }, NOW)!;
    expect(isRetryableProviderError(err)).toBe(false);
    expect(isModelFallbackEligible(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Provider behavior — classify at the HTTP boundary, no retries, no fallback
// ---------------------------------------------------------------------------

const jsonRes = (status: number, body: unknown, headers?: Record<string, string>): Response =>
  ({
    ok: status === 200,
    status,
    headers: { get: (n: string) => headers?.[n.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  }) as unknown as Response;

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** The marathon body with a reset ~3h18m in the FUTURE (the boundary call
 *  reads the real wall clock — a canned past instant correctly declines to
 *  park, which is itself a pinned unit test above). Local wall clock, same
 *  as the real gateway reports. */
const futureReset = (msAhead: number): string => {
  const d = new Date(Date.now() + msAhead);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const resetAtOf = (wallClock: string): number => Date.parse(wallClock.replace(" ", "T"));

describe("provider quota-park behavior (113-B3)", () => {
  it("generate: the glm marathon body becomes QuotaParkError with zero retries", async () => {
    const reset = futureReset(3 * 3_600_000 + 18 * 60_000);
    const body = `[1308][已达到 5 小时的使用上限。您的限额将在 ${reset} 重置。]`;
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(429, body);
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "glm" },
      { fetch, retry: { maxRetries: 4, baseDelayMs: 1, sleep: async () => {} } },
    );
    const err = await model.generate(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaParkError);
    expect((err as QuotaParkError).provider).toBe("glm");
    expect((err as QuotaParkError).resetAt.getTime()).toBe(resetAtOf(reset));
    // No retry storm: one fetch total.
    expect(calls).toBe(1);
  });

  it("stream: the same classification on the streaming path (pre-delta)", async () => {
    const reset = futureReset(3 * 3_600_000 + 18 * 60_000);
    const body = `[1308][已达到 5 小时的使用上限。您的限额将在 ${reset} 重置。]`;
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(429, body);
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 4, baseDelayMs: 1, sleep: async () => {} } },
    );
    const gen = model.stream!(INPUT);
    await expect(gen.next()).rejects.toMatchObject({ name: "QuotaParkError" });
    expect(calls).toBe(1);
  });

  it("a >60s Retry-After header on a quota-flavored 429 parks too", async () => {
    const fetch = (async () => jsonRes(429, "rate limit reached, please retry later", { "retry-after": "3600" })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 4, baseDelayMs: 1, sleep: async () => {} } },
    );
    const err = await model.generate(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaParkError);
    // The parked instant is now+3600s (± a few ms of wall clock drift).
    const drift = Math.abs((err as QuotaParkError).resetAt.getTime() - (Date.now() + 3_600_000));
    expect(drift).toBeLessThan(5_000);
  });

  it("a short Retry-After (≤60s) keeps the ordinary ladder path — retries then ProviderHttpError", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const fetch = (async () => {
      calls += 1;
      return jsonRes(429, "rate limit reached, retry soon", { "retry-after": "0.05" });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async (ms: number) => { sleeps.push(ms); } } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ProviderHttpError", status: 429 });
    // The ladder walked its rungs honoring the exact Retry-After — the 60s-cap
    // semantics are untouched by the park classification.
    expect(calls).toBe(3);
    expect(sleeps).toEqual([50, 50]);
  });

  it("a 429 with NO quota vocabulary keeps the ordinary ladder path (no misclassification)", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(429, "Too Many Requests");
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ProviderHttpError", status: 429 });
    expect(calls).toBe(3);
  });

  it("the fallback chain does not swap legs on a QuotaParkError (account-scoped)", async () => {
    const body = `[1308][已达到 5 小时的使用上限。您的限额将在 ${futureReset(3 * 3_600_000)} 重置。]`;
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(429, body);
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "primary", fallbackModels: ["sibling"] },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "QuotaParkError" });
    // One fetch: neither a ladder rung nor a fallback leg re-issued.
    expect(calls).toBe(1);
  });
});
