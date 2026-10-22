// tests/retry-after.test.ts — r1a Task 4: 429 Retry-After 尊重。
// (a) parseRetryAfterMs 解析矩阵：秒数 / HTTP-date（未来与过去）/ retry-after-ms /
//     头名大小写变体 / 缺失 / 畸形 → undefined / 超 60s 原值返回（上限裁决在
//     梯子，不在解析器）；
// (b) 梯子行为：retryAfterMs 存在 → 等待该值替代指数退避（仍消耗一个重试名额，
//     注入 sleep 断言实际等待值 + 默认 sleep 的 fake-timers 时长断言）；
//     >60_000 → 不重试原样抛；=60_000 → 重试；overload 分支被显式期限覆盖；
//     无 retryAfterMs 的既有指数行为逐字节不变；
// (c) 三适配器（openai-compatible / anthropic / responses）429 + retry-after 头
//     → 第二次成功的既有形状测试各一。
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createResponsesProvider,
  withRetry,
  withRetryStream,
  ProviderHttpError,
  parseRetryAfterMs,
  RETRY_AFTER_FAIL_CAP_MS,
  type RetryObserver,
} from "../src/index.js";

const FIXED_NOW = Date.UTC(2026, 7, 24, 12, 0, 0); // Mon, 24 Aug 2026 12:00:00 GMT

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant, deterministic ladder knobs (mirror retry.test.ts). */
const INSTANT = { sleep: async (): Promise<void> => {}, random: () => 0.5 } as const;

function recordedRetries(): { onRetry: RetryObserver; log: Array<{ n: number; delayMs: number; reason: string }> } {
  const log: Array<{ n: number; delayMs: number; reason: string }> = [];
  return { onRetry: (n, delayMs, reason) => void log.push({ n, delayMs, reason }), log };
}

/** Sleep that records every waited value — asserts the ladder's actual waits. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; calls: () => number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number): Promise<void> => { calls.push(ms); }, calls: () => calls };
}

/** A case-SENSITIVE duck-typed get — pins that the case-insensitivity is the
 *  parser's own probe matrix, not Headers.get's normalization. */
function exactCaseGet(headers: Record<string, string>): { get(name: string): string | null } {
  return { get: (name: string): string | null => (name in headers ? headers[name]! : null) };
}

// ---------------------------------------------------------------------------
// (a) parseRetryAfterMs — 解析矩阵
// ---------------------------------------------------------------------------

describe("parseRetryAfterMs — seconds and ms forms", () => {
  it("integer seconds → ms (0 is a valid immediate-retry signal)", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "5" }))).toBe(5000);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "0" }))).toBe(0);
  });

  it("fractional seconds → exact whole ms (no FP dust — aligned with the date form's rounding spirit)", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "1.5" }))).toBe(1500);
    // 0.5678 × 1000 = 567.8000000000001 in float64 — the raw product would
    // leak sub-ms dust into the ladder's sleep; round to the whole ms.
    expect(parseRetryAfterMs(new Headers({ "retry-after": "0.5678" }))).toBe(568);
  });

  it("the standard retry-after wins when both headers ride the response", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "5", "retry-after-ms": "9999" }))).toBe(5000);
  });

  it("values beyond 60s are returned AS-IS — the cap is the ladder's call", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after": "120" }))).toBe(120_000);
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "90000" }))).toBe(90_000);
    expect(RETRY_AFTER_FAIL_CAP_MS).toBe(60_000);
  });

  it("missing headers or an absent get → undefined", () => {
    expect(parseRetryAfterMs(new Headers({}))).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs(exactCaseGet({}))).toBeUndefined();
  });

  it("malformed values → undefined (fail closed)", () => {
    for (const junk of ["soon", "", "  ", "-5", "1e3", "0x10", "5s", "12.", "+5"]) {
      expect(parseRetryAfterMs(new Headers({ "retry-after": junk }))).toBeUndefined();
      expect(parseRetryAfterMs(new Headers({ "retry-after-ms": junk }))).toBeUndefined();
    }
  });
});

describe("parseRetryAfterMs — HTTP-date form", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a future HTTP-date → the ms until that instant", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    // Whole-second offset: toUTCString itself truncates sub-second precision,
    // so the date form is inherently second-granular.
    const future = new Date(FIXED_NOW + 3000).toUTCString();
    expect(future).toBe("Mon, 24 Aug 2026 12:00:03 GMT");
    expect(parseRetryAfterMs(new Headers({ "retry-after": future }))).toBe(3000);
  });

  it("a past HTTP-date → undefined (negative wait is fail-closed)", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    const past = new Date(FIXED_NOW - 60_000).toUTCString();
    expect(parseRetryAfterMs(new Headers({ "retry-after": past }))).toBeUndefined();
  });

  it("a junk date string → undefined", () => {
    vi.useFakeTimers({ now: FIXED_NOW });
    expect(parseRetryAfterMs(new Headers({ "retry-after": "Wed, 99 Foo 2026 99:99:99 GMT" }))).toBeUndefined();
  });
});

describe("parseRetryAfterMs — header-name case insensitivity", () => {
  it("real Headers spellings (any case) resolve", () => {
    expect(parseRetryAfterMs(new Headers({ "Retry-After": "5" }))).toBe(5000);
    expect(parseRetryAfterMs(new Headers({ "RETRY-AFTER": "5" }))).toBe(5000);
    expect(parseRetryAfterMs(new Headers({ "Retry-After-Ms": "1500" }))).toBe(1500);
  });

  it("a case-SENSITIVE get still resolves via the parser's own probe matrix", () => {
    expect(parseRetryAfterMs(exactCaseGet({ "Retry-After": "5" }))).toBe(5000);
    expect(parseRetryAfterMs(exactCaseGet({ "RETRY-AFTER": "7" }))).toBe(7000);
    expect(parseRetryAfterMs(exactCaseGet({ "retry-after-ms": "1500" }))).toBe(1500);
  });
});

// ---------------------------------------------------------------------------
// (b) 梯子行为 — retryAfterMs 替代指数退避；60s fail cap
// ---------------------------------------------------------------------------

describe("withRetry + retryAfterMs", () => {
  it("waits the server's retryAfterMs instead of the exponential backoff (still one ladder slot)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    const { onRetry, log } = recordedRetries();
    await withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts === 1) throw new ProviderHttpError("request", 429, "rate limited", 1200);
        return "ok";
      },
      { sleep, random: () => 0.5, onRetry },
    );
    expect(attempts).toBe(2);
    expect(slept()).toEqual([1200]);
    expect(log).toEqual([{ n: 1, delayMs: 1200, reason: "429" }]);
  });

  it("retryAfterMs beyond the fail cap (> 60_000) → NO retry, the original error is thrown as-is", async () => {
    const { sleep, calls: slept } = recordingSleep();
    const err = new ProviderHttpError("request", 429, "come back later", 60_001);
    let attempts = 0;
    const { onRetry, log } = recordedRetries();
    await expect(
      withRetry(
        async (): Promise<string> => {
          attempts += 1;
          throw err;
        },
        { sleep, random: () => 0.5, onRetry },
      ),
    ).rejects.toBe(err);
    expect(attempts).toBe(1);
    expect(slept()).toEqual([]);
    expect(log).toEqual([]);
  });

  it("retryAfterMs exactly 60_000 IS allowed (the cap is >, not >=)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    await withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts === 1) throw new ProviderHttpError("request", 429, "rate limited", 60_000);
        return "ok";
      },
      { sleep, random: () => 0.5 },
    );
    expect(attempts).toBe(2);
    expect(slept()).toEqual([60_000]);
  });

  it("an honored retryAfterMs still consumes a ladder slot (maxRetries bounds it)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    await expect(
      withRetry(
        async (): Promise<string> => {
          attempts += 1;
          throw new ProviderHttpError("request", 429, "limited", 800);
        },
        { sleep, maxRetries: 1 },
      ),
    ).rejects.toBeInstanceOf(ProviderHttpError);
    expect(attempts).toBe(2); // 1 attempt + the single honored retry
    expect(slept()).toEqual([800]); // one wait, then the ladder gave up
  });

  it("an explicit deadline overrides the overload branch's 2s base (reason stays 'overload')", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    const { onRetry, log } = recordedRetries();
    await withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts === 1) throw new ProviderHttpError("request", 429, "server is overloaded", 3000);
        return "ok";
      },
      { sleep, random: () => 0.5, onRetry },
    );
    expect(slept()).toEqual([3000]);
    expect(log).toEqual([{ n: 1, delayMs: 3000, reason: "overload" }]);
  });

  it("without retryAfterMs the exponential ladder is byte-identical (500ms first wait)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    await withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts === 1) throw new ProviderHttpError("request", 429, "rate limited");
        return "ok";
      },
      { sleep, random: () => 0.5 },
    );
    expect(slept()).toEqual([500]);
  });

  it("ProviderHttpError without a 4th argument keeps its serialized shape (no extra key)", () => {
    const err = new ProviderHttpError("request", 429, "limited");
    expect("retryAfterMs" in err).toBe(false);
    expect(err.message).toBe("provider request failed: 429 limited");
    const withMs = new ProviderHttpError("request", 429, "limited", 1200);
    expect(withMs.retryAfterMs).toBe(1200);
    expect(withMs.message).toBe("provider request failed: 429 limited");
  });
});

describe("withRetry + default sleep under fake timers (the actual waited duration)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits exactly the server's 2500ms deadline — not one tick less", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const p = withRetry(
      async (): Promise<string> => {
        attempts += 1;
        if (attempts === 1) throw new ProviderHttpError("request", 429, "limited", 2500);
        return "ok";
      },
      { random: () => 0.5 },
    );
    await vi.advanceTimersByTimeAsync(2499);
    expect(attempts).toBe(1); // still inside the server's deadline
    await vi.advanceTimersByTimeAsync(1);
    await expect(p).resolves.toBe("ok");
    expect(attempts).toBe(2);
  });
});

describe("withRetryStream + retryAfterMs", () => {
  it("waits the server's deadline before the replay (pre-delta)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    let attempts = 0;
    const attempt = async function* (): AsyncGenerator<string> {
      attempts += 1;
      if (attempts === 1) throw new ProviderHttpError("stream", 429, "rate limited", 1500);
      yield "ok";
    };
    const out: string[] = [];
    for await (const ev of withRetryStream(() => attempt(), { sleep, random: () => 0.5 })) out.push(ev);
    expect(out).toEqual(["ok"]);
    expect(attempts).toBe(2);
    expect(slept()).toEqual([1500]);
  });

  it("beyond the fail cap the stream error is rethrown untouched (no wait)", async () => {
    const { sleep, calls: slept } = recordingSleep();
    const err = new ProviderHttpError("stream", 429, "come back later", 61_000);
    const attempt = async function* (): AsyncGenerator<string> {
      throw err;
    };
    await expect(
      (async () => {
        for await (const _ev of withRetryStream(() => attempt(), { sleep })) {
          // drain
        }
      })(),
    ).rejects.toBe(err);
    expect(slept()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) 三适配器 — 429 + retry-after 头 → 第二次成功（既有形状各一）
// ---------------------------------------------------------------------------

/** The shared 429-then-OK fetch script: first call 429 with the header, then OK. */
function retryAfterThenOkFetch(okResponse: () => unknown): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const doFetch = (async () => {
    n += 1;
    if (n === 1) {
      return { ok: false, status: 429, headers: new Headers({ "retry-after": "2" }), text: async () => "rate limited" };
    }
    return okResponse();
  }) as typeof fetch;
  return { fetch: doFetch, calls: () => n };
}

describe("adapters honor the 429 retry-after header", () => {
  it("openai-compatible: waits the header's value, second attempt succeeds", async () => {
    const { fetch, calls } = retryAfterThenOkFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "RETRY-SENTINEL" } }] }),
    }));
    const { sleep, calls: slept } = recordingSleep();
    const { onRetry, log } = recordedRetries();
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, onRetry, retry: { ...INSTANT, sleep } },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("RETRY-SENTINEL");
    expect(calls()).toBe(2);
    expect(slept()).toEqual([2000]); // 2s header, NOT the 500ms exponential base
    expect(log).toEqual([{ n: 1, delayMs: 2000, reason: "429" }]);
  });

  it("anthropic: waits the header's value, second attempt succeeds", async () => {
    const { fetch, calls } = retryAfterThenOkFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: "text", text: "RETRY-SENTINEL" }], stop_reason: "end_turn" }),
    }));
    const { sleep, calls: slept } = recordingSleep();
    const { onRetry, log } = recordedRetries();
    const model = createAnthropicProvider(
      { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" },
      { fetch, onRetry, retry: { ...INSTANT, sleep } },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("RETRY-SENTINEL");
    expect(calls()).toBe(2);
    expect(slept()).toEqual([2000]);
    expect(log).toEqual([{ n: 1, delayMs: 2000, reason: "429" }]);
  });

  it("responses: waits the header's value, second attempt succeeds", async () => {
    const { fetch, calls } = retryAfterThenOkFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "RETRY-SENTINEL" }] }] }),
    }));
    const { sleep, calls: slept } = recordingSleep();
    const { onRetry, log } = recordedRetries();
    const model = createResponsesProvider(
      { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-codex" },
      { fetch, onRetry, retry: { ...INSTANT, sleep } },
    );
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("RETRY-SENTINEL");
    expect(calls()).toBe(2);
    expect(slept()).toEqual([2000]);
    expect(log).toEqual([{ n: 1, delayMs: 2000, reason: "429" }]);
  });
});
