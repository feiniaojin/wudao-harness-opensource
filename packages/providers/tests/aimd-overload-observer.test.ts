// 121 项 1（CodeWhale 498490680 形）— the retry ladder's capacity observer
// (onOverload): fires on EVERY overload-class failure the catch classifies
// (429/503/529/overload body), on every arm — ladder retry, background bail,
// and rethrow past the cap — for both generate and stream. Pure observation:
// firing must not change any ladder decision (delays, attempt counts, and
// terminal errors stay byte-equal to the observer-less run). The Provider
// Options fragment threads it through all three factories' ladder merges.
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  BackgroundOverloadError,
  withRetry,
  withRetryStream,
} from "../src/index.js";
import { ProviderHttpError } from "../src/model-failure.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

const textRes = (status: number, body: string): Response =>
  ({ ok: status === 200, status, json: async () => JSON.parse(body), text: async () => body }) as unknown as Response;

const OK = () => textRes(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
const OVERLOADED = () => textRes(429, "The server is overloaded — try again later");
const BAD_REQUEST = () => textRes(400, JSON.stringify({ error: { message: "messages[0] is invalid" } }));

/** fetch that answers from a scripted list of Responses (last one repeats). */
function scriptedFetch(list: Response[]): { fetch: typeof fetch; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (async () => {
      const r = list[Math.min(calls, list.length - 1)]!;
      calls += 1;
      return r;
    }) as typeof fetch,
  };
}

const NO_WAIT = { sleep: async () => {}, random: () => 0.5 };

describe("withRetry/withRetryStream onOverload (121 项 1)", () => {
  it("fires once per overload-class ATTEMPT — an absorbed cascade of 3 reports 3", async () => {
    let fired = 0;
    await withRetry(
      async () => {
        throw new ProviderHttpError("request", 429, "The server is overloaded");
      },
      { ...NO_WAIT, maxRetries: 5, onOverload: () => { fired += 1; } },
    ).catch(() => {});
    expect(fired).toBe(6); // first attempt + 5 retries, all overload-class
  });

  it("does not fire for non-overload failures (a 400 says nothing about capacity)", async () => {
    let fired = 0;
    await withRetry(
      async () => {
        throw new ProviderHttpError("request", 400, "messages[0] is invalid");
      },
      { ...NO_WAIT, maxRetries: 2, onOverload: () => { fired += 1; } },
    ).catch(() => {});
    expect(fired).toBe(0);
  });

  it("fires on the background bail arm too (the observation precedes every decision)", async () => {
    let fired = 0;
    const err = await withRetry(
      async () => {
        throw new ProviderHttpError("request", 503, "overloaded");
      },
      { ...NO_WAIT, querySource: "summarizer", onOverload: () => { fired += 1; } },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundOverloadError);
    expect(fired).toBe(1);
  });

  it("the stream path fires pre-delta and post-delta alike (pre-delta retries here)", async () => {
    let fired = 0;
    let calls = 0;
    // A FRESH generator per attempt (a thrown generator is closed — the
    // ladder's fn seam must be callable repeatedly, as the factories' are).
    const attempt = () => (async function* () {
      calls += 1;
      throw new ProviderHttpError("stream", 529, "the model is overloaded");
    })();
    const err = await (async () => {
      try {
        for await (const _ev of withRetryStream(attempt, { ...NO_WAIT, maxRetries: 1, onOverload: () => { fired += 1; } })) {
          void _ev;
        }
        return undefined;
      } catch (e) { return e; }
    })();
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(calls).toBe(2); // one retry happened
    expect(fired).toBe(2); // both overload observations reported
  });

  it("observation is inert: the same cascade runs byte-equal without the observer", async () => {
    const a = scriptedFetch([OVERLOADED(), OK()]);
    const withObs = await createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: a.fetch, retry: { ...NO_WAIT, maxRetries: 3 }, onOverload: () => {} },
    ).generate(INPUT);
    const b = scriptedFetch([OVERLOADED(), OK()]);
    const without = await createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: b.fetch, retry: { ...NO_WAIT, maxRetries: 3 } },
    ).generate(INPUT);
    expect(withObs.content).toBe(without.content);
    expect(a.calls()).toBe(b.calls()).toBe(2);
  });
});

describe("ProviderOptions.onOverload threading (121 项 1)", () => {
  it("createOpenAICompatibleProvider: the factory merges onOverload into the ladder — a 429→200 cascade reports once", async () => {
    const f = scriptedFetch([OVERLOADED(), OK()]);
    let fired = 0;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { ...NO_WAIT }, onOverload: () => { fired += 1; } },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(fired).toBe(1);
    expect(f.calls()).toBe(2);
  });

  it("a 400 never reports; the count stays 0 through the whole failed ladder", async () => {
    const f = scriptedFetch([BAD_REQUEST()]);
    let fired = 0;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { ...NO_WAIT, maxRetries: 2 }, onOverload: () => { fired += 1; } },
    );
    await model.generate(INPUT).catch(() => {});
    expect(fired).toBe(0);
  });

  it("createAnthropicProvider: the same fragment threads (its ladder merge is identical)", async () => {
    let fired = 0;
    const f = scriptedFetch([
      textRes(429, JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "overloaded" } })),
      textRes(200, JSON.stringify({ content: [{ type: "text", text: "ok" }] })),
    ]);
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: f.fetch, retry: { ...NO_WAIT }, onOverload: () => { fired += 1; } },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(fired).toBe(1);
  });
});
