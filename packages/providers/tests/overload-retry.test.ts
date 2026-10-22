// M47 §7 (A6) — 429 overload body-sniffing. Z.AI / Zhipu (bigmodel) express
// whole-fleet overload as HTTP 429 with a recognizable body. Those failures
// classify as `overload`: SAME key (never rotate), backoff doubling capped at
// 32s, and the retry observability names the class. A plain 429 without a
// signature stays the generic rate-limit ladder (500ms base).
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  sniffOverloadBody,
  isOverloadError,
  ProviderHttpError,
  type RetryObserver,
} from "../src/index.js";

// Deterministic jitter: random()=0.5 → factor exactly 1 (scheduled waits).
const NO_JITTER = { random: () => 0.5 } as const;
const SLEEP = { sleep: async (): Promise<void> => {} } as const;

const ZHIPU_BUSY = JSON.stringify({ error: { code: "1301", message: "当前集团内部忙，请稍后重试" } });
const ZAI_OVERLOADED = JSON.stringify({ error: { code: 429, message: "The server is overloaded, please try again later." } });

describe("sniffOverloadBody", () => {
  it("recognizes the z.ai / zhipu / bigmodel overload signatures", () => {
    expect(sniffOverloadBody(ZHIPU_BUSY)).toBe(true); // code 1301 (zhipu busy)
    expect(sniffOverloadBody('{"error":{"code":1301,"msg":"busy"}}')).toBe(true); // numeric code spelling
    expect(sniffOverloadBody(ZAI_OVERLOADED)).toBe(true); // "overloaded"
    expect(sniffOverloadBody("当前集团内部忙")).toBe(true);
    expect(sniffOverloadBody("服务器繁忙，请稍后重试")).toBe(true);
  });

  it("a plain rate-limit body is NOT overload", () => {
    expect(sniffOverloadBody("rate limited")).toBe(false);
    expect(sniffOverloadBody('{"error":{"message":"Too Many Requests"}}')).toBe(false);
    expect(sniffOverloadBody("")).toBe(false);
    expect(sniffOverloadBody('{"usage":{"prompt_tokens":1301}}')).toBe(false); // counts must not trip the JSON-coded signature
  });
});

/** A fetch script: each entry is either a failure (status+body) or an SSE body. */
function scriptedFetch(
  script: ReadonlyArray<{ status: number; body: string } | { sse: string }>,
  seen: { headers: Record<string, string>[]; bodies: string[] } = { headers: [], bodies: [] },
): typeof fetch {
  let i = 0;
  const doFetch: typeof fetch = async (_url, init) => {
    seen.bodies.push(String(init?.body));
    seen.headers.push((init?.headers ?? {}) as Record<string, string>);
    const step = script[i];
    i += 1;
    if (step === undefined) throw new Error("scripted fetch responses exhausted");
    if ("status" in step) return new Response(step.body, { status: step.status });
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(step.sse));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return doFetch;
}

const SSE_DONE = "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n";

describe("overload branch on the retry ladder", () => {
  it("429 + overload body retries with the overload class: doubled waits from 2s, same key, identical bytes", async () => {
    const seen = { headers: [] as Record<string, string>[], bodies: [] as string[] };
    const fetch = scriptedFetch(
      [
        { status: 429, body: ZHIPU_BUSY },
        { status: 429, body: ZAI_OVERLOADED },
        { sse: SSE_DONE },
      ],
      seen,
    );
    const retryLog: Array<{ n: number; delayMs: number; reason: string }> = [];
    const onRetry: RetryObserver = (n, delayMs, reason) => void retryLog.push({ n, delayMs, reason });
    const provider = createOpenAICompatibleProvider(
      { apiKey: "same-key", baseURL: "http://provider.test", model: "m" },
      { fetch, onRetry, retry: { ...SLEEP, ...NO_JITTER } },
    );
    const events = [];
    for await (const ev of provider.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "hi" }] })) events.push(ev);
    expect(events.at(-1)).toMatchObject({ type: "done" });
    // The class is named and the waits double from the 2s overload base.
    expect(retryLog.map((r) => r.reason)).toEqual(["overload", "overload"]);
    expect(retryLog.map((r) => r.delayMs)).toEqual([2000, 4000]);
    // SAME key, never rotate: every attempt carries the identical auth header…
    expect(new Set(seen.headers.map((h) => h.authorization))).toEqual(new Set(["Bearer same-key"]));
    // …and the identical request bytes (cache-friendly replay).
    expect(new Set(seen.bodies).size).toBe(1);
  });

  it("overload waits keep doubling but cap at 32s", async () => {
    const seen = { headers: [] as Record<string, string>[], bodies: [] as string[] };
    const fetch = scriptedFetch(
      Array.from({ length: 9 }, () => ({ status: 429, body: ZHIPU_BUSY })), // 1 + 8 retries
      seen,
    );
    const delays: number[] = [];
    const provider = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "http://provider.test", model: "m" },
      { fetch, onRetry: (_n, delayMs) => void delays.push(delayMs), retry: { ...SLEEP, ...NO_JITTER, maxRetries: 8 } },
    );
    await expect(
      provider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/provider request failed: 429/);
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 32000, 32000, 32000]);
  });

  it("a signature without 429 is NOT overload (only the 429+signature pair classifies)", async () => {
    const seen = { headers: [] as Record<string, string>[], bodies: [] as string[] };
    const fetch = scriptedFetch([{ status: 500, body: ZAI_OVERLOADED }, { sse: SSE_DONE }], seen);
    const retryLog: Array<{ n: number; delayMs: number; reason: string }> = [];
    const provider = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "http://provider.test", model: "m" },
      { fetch, onRetry: (n, delayMs, reason) => void retryLog.push({ n, delayMs, reason }), retry: { ...SLEEP, ...NO_JITTER } },
    );
    for await (const _ of provider.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    expect(retryLog.map((r) => r.reason)).toEqual(["500"]);
    expect(retryLog[0]?.delayMs).toBe(500);
  });

  it("a plain 429 keeps the generic 500ms ladder with reason \"429\"", async () => {
    const seen = { headers: [] as Record<string, string>[], bodies: [] as string[] };
    const fetch = scriptedFetch([{ status: 429, body: "rate limited" }, { sse: SSE_DONE }], seen);
    const retryLog: Array<{ n: number; delayMs: number; reason: string }> = [];
    const provider = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "http://provider.test", model: "m" },
      { fetch, onRetry: (n, delayMs, reason) => void retryLog.push({ n, delayMs, reason }), retry: { ...SLEEP, ...NO_JITTER } },
    );
    for await (const _ of provider.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    expect(retryLog).toEqual([{ n: 1, delayMs: 500, reason: "429" }]);
  });
});

describe("ProviderHttpError classification surface", () => {
  it("carries status/body and the overload flag; message keeps the pinned format", () => {
    const err = new ProviderHttpError("request", 429, ZHIPU_BUSY);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(429);
    expect(err.overload).toBe(true);
    expect(isOverloadError(err)).toBe(true);
    expect(err.message).toBe(`provider request failed: 429 ${ZHIPU_BUSY}`);
    expect(isOverloadError(new Error("provider request failed: 429 rate limited"))).toBe(false);
    expect(isOverloadError(new ProviderHttpError("stream", 429, "rate limited"))).toBe(false);
    expect(isOverloadError(new ProviderHttpError("request", 500, ZAI_OVERLOADED))).toBe(false);
  });
});
