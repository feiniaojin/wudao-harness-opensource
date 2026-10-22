// anthropic-hardening.test.ts — the openai engine's hardening ported to the
// anthropic adapter (r8 §4.1): the shared retry ladder wraps generate
// (withRetry) and stream (withRetryStream), and the stream path carries the
// M58 §B idle watchdog (timer reset on every chunk; a silent stream aborts
// with the typed StreamIdleError, which itself walks the ladder). ZERO new
// classification: the adapter's ProviderHttpError messages already match the
// ladder's regex, so these tests pin the WRAPPING only.
import { describe, it, expect } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import { BackgroundOverloadError, type RetryObserver } from "../src/openai-compatible.js";

const CFG = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant, deterministic ladder knobs (mirror retry.test.ts). */
const INSTANT = { sleep: async (): Promise<void> => {}, random: () => 0.5 } as const;

function recordedRetries(): { onRetry: RetryObserver; log: Array<{ n: number; delayMs: number; reason: string }> } {
  const log: Array<{ n: number; delayMs: number; reason: string }> = [];
  return { onRetry: (n, delayMs, reason) => void log.push({ n, delayMs, reason }), log };
}

// ---------------------------------------------------------------------------
// Fetch fixtures (anthropic shapes)
// ---------------------------------------------------------------------------

const OK_PAYLOAD = { content: [{ type: "text", text: "RETRY-SENTINEL" }], stop_reason: "end_turn" };

function okFetch(payload: unknown = OK_PAYLOAD): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as typeof fetch;
}

function statusFetch(status: number, text: string): typeof fetch {
  return (async () => ({ ok: false, status, text: async () => text })) as typeof fetch;
}

/** A healthy anthropic SSE stream as one ReadableStream body. */
function anthropicSseBody(lines: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
}

const GOOD_SSE = [
  JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
  JSON.stringify({ type: "message_stop" }),
];

/** Wire-form the SSE lines (data: prefix + blank-line separator). */
const sseWire = (lines: readonly string[]): string[] => lines.map((l) => `data: ${l}\n\n`);

function sseFetch(lines: readonly string[], bodies?: string[]): typeof fetch {
  return (async (_url: unknown, init: any) => {
    bodies?.push(String(init.body));
    return { ok: true, status: 200, body: anthropicSseBody(lines) };
  }) as typeof fetch;
}

/** A stream that NEVER resolves a read — the hung connection. */
function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
}

/** Chunks arriving every `gapMs` — slow but alive. */
function spacedBody(chunks: readonly string[], gapMs: number): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= chunks.length) { controller.close(); return; }
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
      if (!sent) { sent = true; controller.enqueue(enc.encode(chunk)); return; }
      return new Promise<void>(() => {});
    },
  });
}

// ---------------------------------------------------------------------------
// Retry ladder — generate
// ---------------------------------------------------------------------------

describe("anthropic retry ladder (generate)", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    it(`retries HTTP ${status} and succeeds on the next attempt`, async () => {
      let n = 0;
      const fetch = (async () => { n += 1; return n === 1 ? statusFetch(status, "transient")() : okFetch()(); }) as typeof fetch;
      const { onRetry, log } = recordedRetries();
      const model = createAnthropicProvider(CFG, { fetch, onRetry, retry: INSTANT });
      const msg = await model.generate(INPUT);
      expect(msg.content).toBe("RETRY-SENTINEL");
      expect(n).toBe(2);
      expect(log).toEqual([{ n: 1, delayMs: 500, reason: String(status) }]);
    });
  }

  for (const status of [400, 401, 404, 422]) {
    it(`does NOT retry HTTP ${status} (argument/client errors surface at once)`, async () => {
      let n = 0;
      const fetch = (async () => { n += 1; return { ok: false, status, text: async () => "bad request" }; }) as typeof fetch;
      const { onRetry, log } = recordedRetries();
      const model = createAnthropicProvider(CFG, { fetch, onRetry, retry: INSTANT });
      await expect(model.generate(INPUT)).rejects.toThrow(new RegExp(`\\b${status}\\b`));
      expect(n).toBe(1);
      expect(log).toEqual([]);
    });
  }

  it("gives up after maxRetries and throws the last error", async () => {
    let n = 0;
    const fetch = (async () => { n += 1; return { ok: false, status: 503, text: async () => "down" }; }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createAnthropicProvider(CFG, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } });
    await expect(model.generate(INPUT)).rejects.toThrow(/503/);
    expect(n).toBe(3); // 1 attempt + 2 retries
    expect(log.map((r) => r.n)).toEqual([1, 2]);
  });

  it("threads querySource: a background overload bails immediately (BackgroundOverloadError)", async () => {
    let n = 0;
    let waited = 0;
    const fetch = (async () => { n += 1; return { ok: false, status: 429, text: async () => "The server is overloaded — try again later" }; }) as typeof fetch;
    const model = createAnthropicProvider(CFG, { fetch, retry: { ...INSTANT, sleep: async () => { waited += 1; } } });
    const err = await model.generate({ ...INPUT, querySource: "summarizer" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackgroundOverloadError);
    expect((err as BackgroundOverloadError).source).toBe("summarizer");
    expect(n).toBe(1); // no re-issue
    expect(waited).toBe(0); // no wait
  });
});

// ---------------------------------------------------------------------------
// Retry ladder — stream (only before the first delta)
// ---------------------------------------------------------------------------

describe("anthropic retry ladder (stream)", () => {
  it("retries a 429 before any delta and delivers the second attempt's events once", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: any) => {
      n += 1;
      bodies.push(String(init.body));
      if (n === 1) return { ok: false, status: 429, text: async () => '{"type":"error"}' };
      return { ok: true, status: 200, body: anthropicSseBody(GOOD_SSE) };
    }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createAnthropicProvider(CFG, { fetch, onRetry, retry: INSTANT });
    const events: string[] = [];
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      events.push(ev.type);
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("ok");
    expect(events.filter((k) => k === "done")).toHaveLength(1); // exactly one done — no duplicated replay
    expect(n).toBe(2);
    expect(log).toEqual([{ n: 1, delayMs: 500, reason: "429" }]);
    expect(bodies[1]).toBe(bodies[0]); // byte-identical replay (prefix-cache safe)
  });
});

// ---------------------------------------------------------------------------
// Stream idle watchdog (M58 §B, ported shape)
// ---------------------------------------------------------------------------

describe("anthropic stream idle watchdog", () => {
  it("a silent stream aborts on idle and the ladder retry succeeds with a BYTE-IDENTICAL request", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: any) => {
      n += 1;
      bodies.push(String(init.body));
      return { ok: true, status: 200, body: n === 1 ? stalledBody() : anthropicSseBody(GOOD_SSE) };
    }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createAnthropicProvider(CFG, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 }, streamIdleTimeoutMs: 40 });
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) events.push(ev.type);
    expect(events).toEqual(["text_delta", "done"]);
    expect(log).toHaveLength(1);
    expect(log[0]?.reason).toContain("stream idle");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]); // prefix-cache safe
  });

  it("a slow-but-progressing stream (gap < threshold) never trips the watchdog", async () => {
    const body = spacedBody(sseWire(GOOD_SSE), 20);
    const fetch = (async () => ({ ok: true, status: 200, body })) as typeof fetch;
    const model = createAnthropicProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 200 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("ok");
  });

  it("a stall AFTER output started is thrown (StreamIdleError), never replayed (first-delta rule)", async () => {
    let calls = 0;
    const chunk = `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } })}\n\n`;
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: chunkThenStall(chunk) };
    }) as typeof fetch;
    const model = createAnthropicProvider(CFG, { fetch, retry: { ...INSTANT, maxRetries: 3 }, streamIdleTimeoutMs: 40 });
    const gen = model.stream!(INPUT);
    const first = await gen.next();
    expect(first.done).toBe(false);
    expect(first.value).toMatchObject({ type: "text_delta", text: "partial" });
    await expect(gen.next()).rejects.toMatchObject({ name: "StreamIdleError" });
    expect(calls).toBe(1); // the ladder did NOT replay — the delta was already delivered
  });

  it("streamIdleTimeoutMs 0 disables the watchdog (a long silent-then-alive stream completes)", async () => {
    const body = spacedBody(sseWire(GOOD_SSE), 150);
    const fetch = (async () => ({ ok: true, status: 200, body })) as typeof fetch;
    const model = createAnthropicProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 0 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Per-response accumulation caps (OOM fix, r1a task 2). Same semantics as the
// openai engine's caps (openai-compatible.ts): every text/reasoning/tool-json
// accumulator is capped at 2M chars with the in-band truncation marker; on the
// stream path a channel that passes the cap FREEZES (later deltas for that
// channel are dropped — downstream consumers accumulate from the yielded
// deltas) and the done message carries the marker.
// ---------------------------------------------------------------------------

describe("anthropic per-response accumulation caps (OOM fix)", () => {
  const CAP = 2_000_000;
  const MARK = "[truncated at 2M chars]";

  it("caps non-streaming joined text/thinking blocks at 2M chars", async () => {
    const payload = {
      content: [
        { type: "text", text: "c".repeat(CAP + 100_000) },
        { type: "thinking", thinking: "r".repeat(CAP + 100_000) },
      ],
      stop_reason: "end_turn",
    };
    const model = createAnthropicProvider(CFG, { fetch: okFetch(payload) });
    const msg = await model.generate(INPUT);
    expect(msg.content.length).toBe(CAP + MARK.length);
    expect(msg.content.endsWith(MARK)).toBe(true);
    expect(msg.reasoning?.length).toBe(CAP + MARK.length);
    expect(msg.reasoning?.endsWith(MARK)).toBe(true);
  });

  it("caps streamed text at 2M, freezes the channel, and keeps processing later events", async () => {
    const piece = "a".repeat(100_000); // 25 deltas → 2.5M chars total
    const lines: string[] = [
      JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 3 } } }),
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
    ];
    for (let i = 0; i < 25; i += 1) {
      lines.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }));
    }
    // Post-freeze delta for the SAME channel (dropped) and later events that
    // must still be processed (message_delta/message_stop → done).
    lines.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "AFTER" } }));
    lines.push(JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }));
    lines.push(JSON.stringify({ type: "message_stop" }));
    const model = createAnthropicProvider(CFG, { fetch: sseFetch(lines) });
    let yielded = 0;
    let sawAfter = false;
    let done: any;
    let doneCount = 0;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") {
        yielded += ev.text.length;
        if (ev.text === "AFTER") sawAfter = true;
      } else if (ev.type === "done") {
        doneCount += 1;
        done = ev.message;
      }
    }
    // The crossing delta is yielded in full before the channel freezes — the
    // delta stream overshoots by at most one delta (bounded); the accumulator
    // and the final message never exceed the cap. (openai-compatible idiom.)
    expect(yielded).toBeLessThanOrEqual(CAP + piece.length);
    expect(sawAfter).toBe(false); // frozen channel drops later text deltas
    expect(done.content.length).toBe(CAP + MARK.length);
    expect(done.content.endsWith(MARK)).toBe(true);
    expect(doneCount).toBe(1); // the stream finished normally — no throw, no hang
    expect(done.stopReason).toBe("stop"); // post-freeze message_delta was processed
  });

  it("caps streamed thinking at 2M and freezes the reasoning channel", async () => {
    const piece = "推".repeat(100_000); // 25 deltas → 2.5M chars total
    const lines: string[] = [
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
    ];
    for (let i = 0; i < 25; i += 1) {
      lines.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: piece } }));
    }
    lines.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "AFTER" } }));
    lines.push(JSON.stringify({ type: "message_stop" }));
    const model = createAnthropicProvider(CFG, { fetch: sseFetch(lines) });
    let sawAfter = false;
    let done: any;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "reasoning_delta" && ev.text === "AFTER") sawAfter = true;
      else if (ev.type === "done") done = ev.message;
    }
    expect(sawAfter).toBe(false);
    expect(done.reasoning.length).toBe(CAP + MARK.length);
    expect(done.reasoning.endsWith(MARK)).toBe(true);
    expect(done.content).toBe("");
  });

  it("caps accumulated tool-use JSON at 2M chars (_unparsed carries the capped tail)", async () => {
    // Valid JSON when WHOLE (the responses-side twin shape, r1b A3): the
    // premise is that ONLY the cap's slice + marker breaks parseability — so
    // the causality "truncated ⇒ not JSON ⇒ _unparsed" is really exercised.
    const whole = `{"x":"${"v".repeat(CAP + 100_000)}"}`;
    expect(() => JSON.parse(whole)).not.toThrow();
    const lines: string[] = [
      JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "write_file" } }),
    ];
    // 600k-char fragments → 4 fragments → crosses the cap mid-string.
    for (let i = 0; i < whole.length; i += 600_000) {
      lines.push(JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: whole.slice(i, i + 600_000) } }));
    }
    lines.push(JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" } }));
    lines.push(JSON.stringify({ type: "message_stop" }));
    const model = createAnthropicProvider(CFG, { fetch: sseFetch(lines) });
    let done: any;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    // Truncated + marker is no longer valid JSON — the adapter's documented
    // _unparsed fallback keeps the call inspectable instead of crashing the
    // stream, and the fallback string itself is capped (bounded).
    expect(done.toolCalls[0].name).toBe("write_file");
    expect(done.toolCalls[0].arguments._unparsed.length).toBe(CAP + MARK.length);
    expect(done.toolCalls[0].arguments._unparsed.endsWith(MARK)).toBe(true);
    expect(done.stopReason).toBe("tool_calls"); // post-cap events were processed
  });
});
