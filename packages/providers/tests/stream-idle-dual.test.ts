// ω99-315 — 流式看门狗双档化（soft warn + hard abort）。M58 §B 的单档
// 看门狗（45s 硬超时）演进为两档：
//   soft  缺省 90s（streamIdleSoftMs / settings stream.idleSoftMs）——只发
//         onStreamIdleWarning 回调，绝不取消、绝不产生额外模型请求（推理
//         模型长静默是合法的，先警示）；
//   hard  缺省 300s（streamIdleHardMs / settings stream.idleHardMs，legacy
//         streamIdleTimeoutMs / WUDAO_STREAM_IDLE_MS 继续作为 hard 覆盖）——
//         abort 控制器并抛富化的 StreamIdleError（idleMs / bytes /
//         softWarns 时间线），走既有重试梯子。
// 分类退避表：StreamIdle → 0 延迟直接重发（挂死不是服务端过载）；429 →
// Retry-After；5xx → 指数退避。全部假 timers，无真实长等待。
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  backoffDelayMs,
  DEFAULT_STREAM_IDLE_SOFT_MS,
  DEFAULT_STREAM_IDLE_HARD_MS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  resolveStreamIdleBudget,
  StreamIdleError,
  type RetryObserver,
} from "../src/index.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const CFG = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const ACFG = { apiKey: "k", baseURL: "https://a/v1", model: "m", wire: "anthropic" as const };
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;
const SOFT = 90_000;
const HARD = 300_000;

afterEach(() => {
  vi.useRealTimers();
  delete process.env.WUDAO_STREAM_IDLE_MS;
});

/** A stream that NEVER resolves a read — the hung connection. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  });
}

/** All chunks enqueued synchronously — completes without any timer. */
function instantBody(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
}

/** Chunks arriving every `gapMs` — a slow-but-alive stream (needs the fake
 *  clock advanced to progress). */
function spacedBody(chunks: readonly string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      await new Promise((r) => setTimeout(r, gapMs));
      controller.enqueue(enc.encode(chunks[i++] ?? ""));
    },
  });
}

const sse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const DONE = "data: [DONE]\n\n";

/** Park a promise with its rejection handler attached IMMEDIATELY — the
 *  watchdog rejects inside advanceTimersByTimeAsync, and a handler attached
 *  only at assertion time leaves an unhandled-rejection window. */
function parked<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

// ---------------------------------------------------------------------------
// Resolution: defaults / settings-shaped options / legacy override / env
// ---------------------------------------------------------------------------

describe("dual-tier idle budget resolution (ω99-315)", () => {
  it("defaults: soft 90s, hard 300s (the M58 45s single tier is retired)", () => {
    expect(DEFAULT_STREAM_IDLE_SOFT_MS).toBe(90_000);
    expect(DEFAULT_STREAM_IDLE_HARD_MS).toBe(300_000);
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(DEFAULT_STREAM_IDLE_HARD_MS);
    expect(resolveStreamIdleBudget({}, {})).toEqual({ softMs: 90_000, hardMs: 300_000 });
  });

  it("per-key overrides; legacy streamIdleTimeoutMs / WUDAO_STREAM_IDLE_MS stay hard-tier overrides", () => {
    expect(resolveStreamIdleBudget({ softMs: 5_000 })).toEqual({ softMs: 5_000, hardMs: 300_000 });
    expect(resolveStreamIdleBudget({ hardMs: 5_000 })).toEqual({ softMs: 90_000, hardMs: 5_000 });
    expect(resolveStreamIdleBudget({ legacyTimeoutMs: 5_000 })).toEqual({ softMs: 90_000, hardMs: 5_000 });
    expect(resolveStreamIdleBudget({ legacyTimeoutMs: 5_000, hardMs: 7_000 })).toEqual({ softMs: 90_000, hardMs: 7_000 });
    expect(resolveStreamIdleBudget({}, { WUDAO_STREAM_IDLE_MS: "7000" })).toEqual({ softMs: 90_000, hardMs: 7_000 });
  });

  it("0 disables its tier; legacy 0 disables BOTH (M58 compat); garbage-large clamps", () => {
    expect(resolveStreamIdleBudget({ softMs: 0 })).toEqual({ softMs: 0, hardMs: 300_000 });
    expect(resolveStreamIdleBudget({ hardMs: 0 })).toEqual({ softMs: 90_000, hardMs: 0 });
    // The M58 escape hatch (`0 disables the watchdog`) must keep its meaning.
    expect(resolveStreamIdleBudget({ legacyTimeoutMs: 0 })).toEqual({ softMs: 0, hardMs: 0 });
    const clamped = resolveStreamIdleBudget({ hardMs: 9_999_999_999_999 });
    expect(clamped.hardMs).toBe(MAX_STREAM_IDLE_TIMEOUT_MS);
  });
});

// ---------------------------------------------------------------------------
// Bodies: soft warn / hard abort / gap anchoring / drip immunity
// ---------------------------------------------------------------------------

describe("soft tier: warn only, never cancels (ω99-315)", () => {
  it("a silent stream warns at soft without aborting; no extra model request fires", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: stalledBody() };
    }) as typeof fetch;
    const warnings: unknown[] = [];
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 0 },
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const gen = model.stream!(INPUT);
    const first = gen.next();
    await vi.advanceTimersByTimeAsync(SOFT);
    expect(warnings).toEqual([{ idleMs: SOFT, bytesSoFar: 0, softWarns: [SOFT] }]);
    // soft did NOT cancel: still exactly one request, and the stream read is
    // still pending (probe: only a 0ms timer can win the race).
    expect(calls).toBe(1);
    const probe = Promise.race([first.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 0))]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await probe).toBe("pending");
    // Clean up: advance to hard (the typed abort settles the generator).
    const settled = parked(first);
    await vi.advanceTimersByTimeAsync(HARD - SOFT + 1);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ name: "StreamIdleError" });
  });

  it("the hard abort is enriched: idleMs / received bytes / soft-warning timeline", async () => {
    vi.useFakeTimers();
    const fetch = (async () => ({ ok: true, status: 200, body: stalledBody() })) as typeof fetch;
    const warnings: unknown[] = [];
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 0 },
      streamIdleSoftMs: 1_000,
      streamIdleHardMs: 5_000,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const gen = model.stream!(INPUT);
    const settled = parked(gen.next());
    await vi.advanceTimersByTimeAsync(5_001);
    // soft fired exactly ONCE in the gap (no re-warn every softMs), at t=1000.
    expect(warnings.map((w) => (w as { softWarns: readonly number[] }).softWarns)).toEqual([[1_000]]);
    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    const err = outcome.error as StreamIdleError;
    expect(err).toBeInstanceOf(StreamIdleError);
    expect(err.name).toBe("StreamIdleError");
    expect(err.idleMs).toBe(5_000);
    expect(err.bytes).toBe(0);
    expect(err.softWarns).toEqual([1_000]);
  });

  it("hard is anchored to the GAP start — a soft wake never slides the deadline", async () => {
    vi.useFakeTimers();
    const fetch = (async () => ({ ok: true, status: 200, body: stalledBody() })) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 0 },
      streamIdleSoftMs: 1_000,
      streamIdleHardMs: 3_000,
    });
    const gen = model.stream!(INPUT);
    const attempt = parked(gen.next());
    await vi.advanceTimersByTimeAsync(1_000); // soft wakes the guard's own clock
    await vi.advanceTimersByTimeAsync(1_999); // 2999ms into the gap — still alive
    // NOT yet aborted at soft+hard-1: the pending read means no rejection raced.
    const pending = Promise.race([attempt.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 0))]);
    await vi.advanceTimersByTimeAsync(0);
    expect(await pending).toBe("pending");
    await vi.advanceTimersByTimeAsync(1); // exactly 3000ms since the gap opened
    const outcome = await attempt;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ name: "StreamIdleError", idleMs: 3_000 });
  });

  it("a slow-but-progressing stream (gap < soft) never warns and completes", async () => {
    vi.useFakeTimers();
    const fetch = (async () => ({
      ok: true,
      status: 200,
      body: spacedBody([sse("a"), sse("b"), sse("c"), DONE], 60_000),
    })) as typeof fetch;
    const warnings: unknown[] = [];
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: INSTANT,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const drain = (async () => {
      let text = "";
      for await (const ev of model.stream!(INPUT)) {
        if (ev.type === "text_delta") text += ev.text;
      }
      return text;
    })();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 1);
    expect(await drain).toBe("abc");
    expect(warnings).toEqual([]);
  });

  it("each new gap re-arms soft — the timeline accumulates across gaps", async () => {
    vi.useFakeTimers();
    // One chunk at t=2500, then the connection hangs forever: gap 1 warns at
    // 1000; gap 2 (from the chunk) warns at 3500 and hard-aborts at 5500.
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (sent) return new Promise<void>(() => {}); // the post-chunk hang
        sent = true;
        await new Promise((r) => setTimeout(r, 2_500));
        controller.enqueue(enc.encode(sse("x")));
      },
    });
    const fetch = (async () => ({ ok: true, status: 200, body })) as typeof fetch;
    const warnings: { softWarns: readonly number[]; bytesSoFar: number }[] = [];
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 0 },
      streamIdleSoftMs: 1_000,
      streamIdleHardMs: 3_000,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const gen = model.stream!(INPUT);
    const first = gen.next();
    await vi.advanceTimersByTimeAsync(2_500); // the chunk lands, gap 1's soft warned at t=1000
    expect((await first).value).toMatchObject({ type: "text_delta", text: "x" });
    const attempt = parked(gen.next()); // now inside the silent second gap
    await vi.advanceTimersByTimeAsync(3_501); // to t=6001: soft at 3500, hard at 5500
    const outcome = await attempt;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({ name: "StreamIdleError" });
    const err = outcome.error as StreamIdleError;
    expect(err.softWarns).toEqual([1_000, 3_500]);
    expect(err.bytes).toBeGreaterThan(0); // the t=2500 chunk was received
    expect(warnings).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Hard tier through the ladder: direct resend (0-delay) + byte identity
// ---------------------------------------------------------------------------

describe("idle recovery through the ladder (ω99-315)", () => {
  it("hard idle abort → typed error rides the ladder → retry delay is ZERO (direct resend), body byte-identical", async () => {
    vi.useFakeTimers();
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: RequestInit) => {
      n += 1;
      bodies.push(String(init.body));
      return n === 1
        ? { ok: true, status: 200, body: stalledBody() }
        : { ok: true, status: 200, body: instantBody([sse("ok"), DONE]) };
    }) as typeof fetch;
    const retries: Array<{ ms: number; reason: string }> = [];
    const onRetry: RetryObserver = (_n, ms, reason) => retries.push({ ms, reason });
    const warnings: unknown[] = [];
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      onRetry,
      retry: { ...INSTANT, maxRetries: 2 },
      streamIdleSoftMs: 1_000,
      streamIdleHardMs: 2_000,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const text = (async () => {
      let t = "";
      for await (const ev of model.stream!(INPUT)) {
        if (ev.type === "text_delta") t += ev.text;
      }
      return t;
    })();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(await text).toBe("ok");
    // The soft warn produced NO extra model request — the resend came from the
    // hard abort only.
    expect(n).toBe(2);
    expect(warnings).toHaveLength(1);
    // Classification backoff: idle is not server overload — no backoff wait.
    expect(retries).toHaveLength(1);
    expect(retries[0]!.ms).toBe(0);
    expect(retries[0]!.reason).toContain("stream idle");
    // M24 prefix-cache safety: the resent request is byte-for-byte identical.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("429 keeps honoring Retry-After (the classification table is untouched)", async () => {
    const delays: number[] = [];
    const onRetry: RetryObserver = (_n, ms) => delays.push(ms);
    let n = 0;
    const fetch = (async () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 429, headers: new Headers({ "retry-after": "2" }), body: null, text: async () => "rate" }
        : { ok: true, status: 200, body: instantBody([DONE]) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 1 } });
    for await (const _ev of model.stream!(INPUT)) { /* drain */ }
    expect(delays).toEqual([2_000]);
  });

  it("5xx keeps the exponential rung (idle is the ONLY zero-delay class)", async () => {
    const delays: number[] = [];
    const onRetry: RetryObserver = (_n, ms) => delays.push(ms);
    let n = 0;
    const fetch = (async () => {
      n += 1;
      return n === 1
        ? { ok: false, status: 502, headers: new Headers(), body: null, text: async () => "bad gateway" }
        : { ok: true, status: 200, body: instantBody([DONE]) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      onRetry,
      retry: { ...INSTANT, maxRetries: 1, random: () => 0.5 },
    });
    for await (const _ev of model.stream!(INPUT)) { /* drain */ }
    expect(delays).toEqual([backoffDelayMs(0, { random: () => 0.5 })]);
    expect(delays[0]).toBeGreaterThan(0);
  });

  it("legacy streamIdleTimeoutMs 0 keeps meaning: BOTH tiers off (M58 escape hatch)", async () => {
    vi.useFakeTimers();
    const warnings: unknown[] = [];
    const fetch = (async () => ({
      ok: true,
      status: 200,
      body: spacedBody([sse("late"), DONE], 150),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: INSTANT,
      streamIdleTimeoutMs: 0,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const drain = (async () => {
      let t = "";
      for await (const ev of model.stream!(INPUT)) {
        if (ev.type === "text_delta") t += ev.text;
      }
      return t;
    })();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await drain).toBe("late");
    expect(warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The shared sseDataLines watchdog (anthropic + responses wires)
// ---------------------------------------------------------------------------

describe("anthropic wire: dual tier through the shared sseDataLines (ω99-315)", () => {
  it("soft warns, hard aborts enriched — same budget semantics on the anthropic wire", async () => {
    vi.useFakeTimers();
    const fetch = (async () => ({ ok: true, status: 200, body: stalledBody() })) as typeof fetch;
    const warnings: unknown[] = [];
    const model = createAnthropicProvider(ACFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 0 },
      streamIdleSoftMs: 1_000,
      streamIdleHardMs: 4_000,
      onStreamIdleWarning: (w) => warnings.push(w),
    });
    const gen = model.stream!(INPUT);
    const attempt = parked(gen.next());
    await vi.advanceTimersByTimeAsync(4_001);
    expect(warnings).toEqual([{ idleMs: 1_000, bytesSoFar: 0, softWarns: [1_000] }]);
    const outcome = await attempt;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toMatchObject({
      name: "StreamIdleError",
      idleMs: 4_000,
      bytes: 0,
    });
  });
});
