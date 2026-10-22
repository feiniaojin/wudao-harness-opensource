import { describe, it, expect } from "vitest";
import { createRatePauseWindow, DEFAULT_RATE_PAUSE_MS } from "../src/rate-pause.js";
import { RETRY_AFTER_FAIL_CAP_MS } from "../src/retry-after.js";
import { createOpenAICompatibleProvider, createAnthropicProvider, createResponsesProvider } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

// 波次 7 #37 (the reference harness C1): the provider-level 429 pause window. The key pool
// (M56) handles the KEY dimension — a 429 cools that key for everyone. The
// remaining gap is the PROVIDER dimension under concurrency: with one key (or
// all keys cooling), every concurrent request still enters its own retry
// ladder and hammers a provider that just said "stop" — the subagent-fanout
// self-harm. The window: ONE 429 (observed while the pool has no healthy key
// to rotate to) pauses the provider for every LATER request entry, which wait
// the window out in 250ms slices; the originator's own ladder retries are NOT
// gated (a transient 429 recovers on its normal backoff — today's behavior);
// any success clears the window (a recovered blip never stalls the fleet).

const CFG: ProviderConfig = { apiKey: "a", baseURL: "https://x/v1", model: "m" };
const ANTHROPIC_CFG = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

function res(status: number, body: unknown, headers?: Record<string, string>): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

const OK = () => res(200, { choices: [{ message: { role: "assistant", content: "ok" } }] });

/** Fake time + a window riding it: every window sleep advances the clock by
 *  exactly the asked slice, so wait() loops terminate deterministically and
 *  the slice sizes are recorded for assertions. */
function fakeTimeWindow(startMs = 0) {
  let clock = startMs;
  const slices: number[] = [];
  const window = createRatePauseWindow({
    now: () => clock,
    sleep: async (ms: number) => {
      slices.push(ms);
      clock += ms;
    },
  });
  return { clock: () => clock, slices, window };
}

describe("createRatePauseWindow — pure semantics", () => {
  it("idle window: wait() is a no-op and until() is 0", async () => {
    const { window, slices } = fakeTimeWindow();
    expect(window.until()).toBe(0);
    await window.wait();
    expect(slices).toEqual([]);
  });

  it("a tripped window is waited out in ≤250ms slices summing to the pause", async () => {
    const { window, slices, clock } = fakeTimeWindow(1_000);
    window.trip(5_000);
    expect(window.until()).toBe(6_000);
    await window.wait();
    expect(clock()).toBe(6_000);
    expect(slices.length).toBeGreaterThan(1);
    expect(Math.max(...slices)).toBeLessThanOrEqual(250);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(5_000);
  });

  it("trip extends, never shortens", () => {
    const { window } = fakeTimeWindow(1_000);
    window.trip(10_000);
    window.trip(1_000);
    expect(window.until()).toBe(11_000);
  });

  it("trip is capped at RETRY_AFTER_FAIL_CAP_MS (60s) — same ceiling as the ladder's Retry-After trust", () => {
    const { window } = fakeTimeWindow(1_000);
    window.trip(120_000);
    expect(window.until()).toBe(1_000 + RETRY_AFTER_FAIL_CAP_MS);
  });

  it("clear() resets an active window to idle", async () => {
    const { window, slices } = fakeTimeWindow();
    window.trip(60_000);
    window.clear();
    expect(window.until()).toBe(0);
    await window.wait();
    expect(slices).toEqual([]);
  });

  it("a pre-aborted signal rejects immediately with AbortError, zero sleeps", async () => {
    const { window, slices } = fakeTimeWindow();
    window.trip(60_000);
    const c = new AbortController();
    c.abort();
    await expect(window.wait(c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(slices).toEqual([]);
  });

  it("an abort fired mid-wait breaks the slice loop with AbortError", async () => {
    let clock = 0;
    const c = new AbortController();
    const window = createRatePauseWindow({
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
        if (clock >= 500) c.abort(); // mid-wait, window still has ~59.5s left
      },
    });
    window.trip(60_000);
    await expect(window.wait(c.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(clock).toBeLessThan(60_000);
  });
});

describe("provider integration (openai-compatible)", () => {
  it("a 429 with the pool exhausted (single key) trips the window — held after the ladder gave up", async () => {
    const { window } = fakeTimeWindow();
    let n = 0;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: (async () => {
        n += 1;
        return res(429, { error: { message: "rate limited" } });
      }) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 1, baseDelayMs: 1, sleep: async () => {} },
    });
    await expect(model.generate(INPUT)).rejects.toThrow(/429/);
    expect(n).toBe(2); // the originator's ladder ran to exhaustion, ungated
    expect(window.until()).toBeGreaterThan(0); // …and left the provider paused
  });

  it("a concurrent later request defers at entry until the window lapses, then succeeds — and its success clears it", async () => {
    const { window, clock } = fakeTimeWindow();
    const fetchClock: number[] = [];
    let n = 0;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: (async () => {
        n += 1;
        fetchClock.push(clock());
        return n <= 2 ? res(429, { error: { message: "rate limited" } }) : OK();
      }) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 1, baseDelayMs: 1, sleep: async () => {} },
    });
    // Request A: 429, 429 → ladder exhausted, window tripped at the FIRST 429.
    await expect(model.generate(INPUT)).rejects.toThrow(/429/);
    expect(window.until()).toBeGreaterThan(0);
    // Request B (the concurrent subagent shape): gated at entry, first fetch
    // only after the window lapsed.
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(fetchClock).toHaveLength(3);
    expect(fetchClock[2]).toBeGreaterThanOrEqual(window.until() === 0 ? DEFAULT_RATE_PAUSE_MS : window.until());
    expect(window.until()).toBe(0); // B's success cleared the stale pause
  });

  it("a transient 429 that the originator's own ladder recovers from never leaves a pause (success clears)", async () => {
    const { window, slices } = fakeTimeWindow();
    let n = 0;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: (async () => {
        n += 1;
        return n === 1 ? res(429, { error: { message: "rate limited" } }) : OK();
      }) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(window.until()).toBe(0); // tripped at attempt 1, cleared at attempt 2's 200
    // …and the very next request enters immediately (no gate, no slices).
    const msg2 = await model.generate(INPUT);
    expect(msg2.content).toBe("ok");
    expect(slices).toEqual([]);
  });

  it("multi-key with a healthy spare: 429 rotates (no trip) — today's pool semantics preserved", async () => {
    const { window, slices } = fakeTimeWindow();
    const auths: string[] = [];
    let n = 0;
    const model = createOpenAICompatibleProvider({ ...CFG, apiKeys: ["a", "b"] }, {
      fetch: (async (_url: string, init: RequestInit) => {
        auths.push(String((init.headers as Record<string, string>)["authorization"]));
        n += 1;
        return n === 1 ? res(429, { error: { message: "rate limited" } }) : OK();
      }) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} },
    });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(auths).toEqual(["Bearer a", "Bearer b"]); // rotated, not paused
    expect(window.until()).toBe(0);
    expect(slices).toEqual([]);
  });

  it("a 429's Retry-After becomes the window's deadline (bounded by the cap)", async () => {
    const { window } = fakeTimeWindow(1_000);
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: (async () => res(429, { error: { message: "rate limited" } }, { "retry-after": "2" })) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 0 },
    });
    await expect(model.generate(INPUT)).rejects.toThrow(/429/);
    expect(window.until()).toBe(3_000); // 1_000 + Retry-After 2s
  });

  it("the streaming path gates the same way (entry before the first delta)", async () => {
    const { window, clock } = fakeTimeWindow();
    const enc = new TextEncoder();
    let n = 0;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch: (async () => {
        n += 1;
        if (n === 1) return res(429, { error: { message: "rate limited" } });
        const events = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");
        return {
          ok: true,
          status: 200,
          body: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(enc.encode(events));
              c.close();
            },
          }),
        } as unknown as Response;
      }) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 0 },
    });
    // Request A: 429 with no retries → window tripped.
    await expect(async () => {
      for await (const _ev of model.stream!(INPUT)) { /* drain */ }
    }).rejects.toThrow(/429/);
    expect(window.until()).toBeGreaterThan(0);
    // Request B: gated, then streams the 200.
    const out: string[] = [];
    const startedAt = clock();
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") out.push(ev.text);
    }
    expect(out.join("")).toBe("hi");
    expect(n).toBe(2);
    expect(clock()).toBeGreaterThan(startedAt); // real slices were waited
  });
});

describe("protocol parity (anthropic / responses)", () => {
  it("anthropic: a terminal 429 on a single key trips the shared window", async () => {
    const { window } = fakeTimeWindow();
    const model = createAnthropicProvider(ANTHROPIC_CFG, {
      fetch: (async () => res(429, { error: { message: "rate limited" } })) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 0 },
    });
    await expect(model.generate(INPUT)).rejects.toThrow(/429/);
    expect(window.until()).toBeGreaterThan(0);
  });

  it("responses: a terminal 429 on a single key trips the shared window", async () => {
    const { window } = fakeTimeWindow();
    const model = createResponsesProvider(CFG, {
      fetch: (async () => res(429, { error: { message: "rate limited" } })) as typeof fetch,
      ratePauseWindow: window,
      retry: { maxRetries: 0 },
    });
    await expect(model.generate(INPUT)).rejects.toThrow(/429/);
    expect(window.until()).toBeGreaterThan(0);
  });
});
