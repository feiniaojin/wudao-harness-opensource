// M58 §B — the stream idle watchdog: a silent stream (no chunk for
// streamIdleTimeoutMs) aborts the fetch and raises the typed StreamIdleError,
// which walks the EXISTING retry ladder. The timer resets on every chunk; a
// slow-but-progressing stream never trips it; a mid-stream stall after output
// has started is thrown (never replayed — the first-delta rule); a USER abort
// (AbortError) is never retried. The retried request is byte-identical (same
// ModelInput → same body), so the prefix cache is unaffected. The watchdog
// lives inside the provider's stream call only — tool execution, permission
// asks, and user interaction happen outside it and are structurally exempt.
import { describe, it, expect, afterEach } from "vitest";
import {
  createOpenAICompatibleProvider,
  StreamIdleError,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  defaultStreamIdleTimeoutMs,
  type RetryObserver,
} from "../src/index.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const CFG = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;

afterEach(() => {
  delete process.env.WUDAO_STREAM_IDLE_MS;
});

// ---------------------------------------------------------------------------
// Resolution: default 45s, option → env WUDAO_STREAM_IDLE_MS → default; 0 disables.
// ω99-315: the M58 45s single tier is retired — the HARD tier default is now
// 300_000 (soft 90_000 warns first; the dual-tier contract itself is pinned in
// stream-idle-dual.test.ts). The env override / 0-disables semantics below are
// unchanged.
// ---------------------------------------------------------------------------

describe("stream idle timeout resolution (M58 §B / ω99-315 hard tier)", () => {
  it("defaults to 300000 (the dual-tier hard budget; soft warns at 90s first)", () => {
    expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBe(300_000);
    expect(defaultStreamIdleTimeoutMs({})).toBe(300_000);
  });

  it("WUDAO_STREAM_IDLE_MS overrides; 0 disables; junk falls back", () => {
    expect(defaultStreamIdleTimeoutMs({ WUDAO_STREAM_IDLE_MS: "1200" })).toBe(1200);
    expect(defaultStreamIdleTimeoutMs({ WUDAO_STREAM_IDLE_MS: "0" })).toBe(0);
    expect(defaultStreamIdleTimeoutMs({ WUDAO_STREAM_IDLE_MS: "fast" })).toBe(300_000);
    expect(defaultStreamIdleTimeoutMs({ WUDAO_STREAM_IDLE_MS: "-5" })).toBe(300_000);
  });

  it("a garbage-large env value clamps to the setTimeout limit (never wraps to an immediate fire)", () => {
    // Node's setTimeout wraps past 2^31-1 ms into firing IMMEDIATELY — a
    // mistyped huge budget must degrade to "wait as long as possible".
    expect(defaultStreamIdleTimeoutMs({ WUDAO_STREAM_IDLE_MS: "9999999999999" })).toBe(2_147_483_647);
  });
});

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

/** A stream that NEVER resolves a read — the hung connection. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => {});
    },
  });
}

/** Chunks arriving every `gapMs` — slow but alive. */
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

/** One chunk, then silence — the stall lands strictly AFTER output started. */
function chunkThenStall(chunk: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let sent = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(enc.encode(chunk));
        return;
      }
      return new Promise<void>(() => {});
    },
  });
}

const sse = (text: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
const DONE_LINES = ["data: [DONE]\n\n"];

// ---------------------------------------------------------------------------
// Watchdog behavior through the provider
// ---------------------------------------------------------------------------

describe("stream idle watchdog (M58 §B)", () => {
  it("a silent stream aborts on idle and the ladder retry succeeds with a BYTE-IDENTICAL request", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: RequestInit) => {
      bodies.push(String(init.body));
      n += 1;
      return n === 1
        ? { ok: true, status: 200, body: stalledBody() }
        // ω99-44: the success body carries a terminal marker ([DONE]) — a
        // body that ends WITHOUT one is a truncation now (TruncatedStreamError),
        // not a normal completion (same convention as DONE_LINES below).
        : { ok: true, status: 200, body: spacedBody([sse("ok"), ...DONE_LINES], 1) };
    }) as typeof fetch;
    const retries: string[] = [];
    const onRetry: RetryObserver = (_n, _ms, reason) => void retries.push(reason);
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      onRetry,
      retry: { ...INSTANT, maxRetries: 2 },
      streamIdleTimeoutMs: 40,
    });
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
      else events.push(ev.type);
    }
    expect(events).toEqual(["ok", "done"]);
    // The retry rode the ladder and announced the idle reason.
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("stream idle");
    // Prefix-cache safety: the retried request is byte-for-byte the same body.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("the thrown error is the typed StreamIdleError and is retryable", () => {
    const err = new StreamIdleError(45_000);
    expect(err.name).toBe("StreamIdleError");
    expect(err.idleMs).toBe(45_000);
    expect(err.message).toContain("45000");
  });

  it("a slow-but-progressing stream (gap < threshold) never trips the watchdog", async () => {
    const fetch = (async () => ({
      ok: true,
      status: 200,
      body: spacedBody([sse("a"), sse("b"), sse("c"), ...DONE_LINES], 20),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 200 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("abc");
  });

  it("a stall AFTER output started is thrown, never replayed (first-delta rule)", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: chunkThenStall(sse("partial")) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 3 },
      streamIdleTimeoutMs: 40,
    });
    const gen = model.stream!(INPUT);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "text_delta", text: "partial" });
    // The stall lands mid-output: the watchdog fires, but the ladder does NOT
    // replay (the retry would duplicate the delivered delta).
    await expect(gen.next()).rejects.toMatchObject({ name: "StreamIdleError" });
    expect(calls).toBe(1);
  });

  it("a USER abort is never retried (only idle aborts are)", async () => {
    let calls = 0;
    const abortErr = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: erroringBody(abortErr) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, {
      fetch,
      retry: { ...INSTANT, maxRetries: 3 },
      streamIdleTimeoutMs: 40,
    });
    const gen = model.stream!(INPUT);
    await expect(gen.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("streamIdleTimeoutMs 0 disables the watchdog (a long silent stream waits)", async () => {
    // With the watchdog off, a 150ms-silent-then-alive stream completes; the
    // same stream with a 40ms budget would have aborted.
    const fetch = (async () => ({
      ok: true,
      status: 200,
      body: spacedBody([sse("late"), ...DONE_LINES], 150),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 0 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("late");
  });
});

/** A body that errors on first read. */
function erroringBody(error: Error): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(error);
    },
  });
}
