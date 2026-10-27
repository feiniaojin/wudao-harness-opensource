// responses-hardening.test.ts — the openai engine's hardening ported to the
// OpenAI Responses adapter (r8 §4.1): the shared retry ladder wraps generate
// (withRetry) and stream (withRetryStream), and the stream path carries the
// M58 §B idle watchdog (timer reset on every chunk; a silent stream aborts
// with the typed StreamIdleError, which itself walks the ladder). ZERO new
// classification: the adapter's ProviderHttpError messages already match the
// ladder's regex, so these tests pin the WRAPPING only.
import { describe, it, expect } from "vitest";
import { createResponsesProvider } from "../src/responses.js";
import { BackgroundOverloadError, type RetryObserver } from "../src/openai-compatible.js";

const CFG = { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-codex" };
const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant, deterministic ladder knobs (mirror retry.test.ts). */
const INSTANT = { sleep: async (): Promise<void> => {}, random: () => 0.5 } as const;

function recordedRetries(): { onRetry: RetryObserver; log: Array<{ n: number; delayMs: number; reason: string }> } {
  const log: Array<{ n: number; delayMs: number; reason: string }> = [];
  return { onRetry: (n, delayMs, reason) => void log.push({ n, delayMs, reason }), log };
}

// ---------------------------------------------------------------------------
// Fetch fixtures (responses shapes)
// ---------------------------------------------------------------------------

const OK_PAYLOAD = { output: [{ type: "message", content: [{ type: "output_text", text: "RETRY-SENTINEL" }] }] };

function okFetch(payload: unknown = OK_PAYLOAD): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as typeof fetch;
}

/** A healthy Responses SSE stream as one ReadableStream body. */
function responsesSseBody(lines: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
}

const GOOD_SSE = [
  JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
  JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 }, output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] } }),
];

/** Wire-form the SSE lines (data: prefix + blank-line separator). */
const sseWire = (lines: readonly string[]): string[] => lines.map((l) => `data: ${l}\n\n`);

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
}

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

/** An ok SSE fetch over pre-wired data lines (mirror of the anthropic file's sseFetch). */
function sseFetchLike(lines: readonly string[]): typeof fetch {
  return (async () => ({ ok: true, status: 200, body: responsesSseBody(lines) })) as typeof fetch;
}

// ---------------------------------------------------------------------------
// Retry ladder — generate
// ---------------------------------------------------------------------------

describe("responses retry ladder (generate)", () => {
  for (const status of [429, 500, 502, 503, 529]) {
    it(`retries HTTP ${status} and succeeds on the next attempt`, async () => {
      let n = 0;
      const fetch = (async () => { n += 1; return n === 1 ? { ok: false, status, text: async () => "transient" } : { ok: true, status: 200, json: async () => OK_PAYLOAD }; }) as typeof fetch;
      const { onRetry, log } = recordedRetries();
      const model = createResponsesProvider(CFG, { fetch, onRetry, retry: INSTANT });
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
      const model = createResponsesProvider(CFG, { fetch, onRetry, retry: INSTANT });
      await expect(model.generate(INPUT)).rejects.toThrow(new RegExp(`\\b${status}\\b`));
      expect(n).toBe(1);
      expect(log).toEqual([]);
    });
  }

  it("gives up after maxRetries and throws the last error", async () => {
    let n = 0;
    const fetch = (async () => { n += 1; return { ok: false, status: 503, text: async () => "down" }; }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createResponsesProvider(CFG, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } });
    await expect(model.generate(INPUT)).rejects.toThrow(/503/);
    expect(n).toBe(3); // 1 attempt + 2 retries
    expect(log.map((r) => r.n)).toEqual([1, 2]);
  });

  it("threads querySource: a background overload bails immediately (BackgroundOverloadError)", async () => {
    let n = 0;
    let waited = 0;
    const fetch = (async () => { n += 1; return { ok: false, status: 429, text: async () => "The server is overloaded — try again later" }; }) as typeof fetch;
    const model = createResponsesProvider(CFG, { fetch, retry: { ...INSTANT, sleep: async () => { waited += 1; } } });
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

describe("responses retry ladder (stream)", () => {
  it("retries a 429 before any delta and delivers the second attempt's events once", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: any) => {
      n += 1;
      bodies.push(String(init.body));
      if (n === 1) return { ok: false, status: 429, text: async () => '{"error":{"type":"rate_limit"}}' };
      return { ok: true, status: 200, body: responsesSseBody(GOOD_SSE) };
    }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createResponsesProvider(CFG, { fetch, onRetry, retry: INSTANT });
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

describe("responses stream idle watchdog", () => {
  it("a silent stream aborts on idle and the ladder retry succeeds with a BYTE-IDENTICAL request", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetch = (async (_url: unknown, init: any) => {
      n += 1;
      bodies.push(String(init.body));
      return { ok: true, status: 200, body: n === 1 ? stalledBody() : responsesSseBody(GOOD_SSE) };
    }) as typeof fetch;
    const { onRetry, log } = recordedRetries();
    const model = createResponsesProvider(CFG, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 }, streamIdleTimeoutMs: 40 });
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
    const model = createResponsesProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 200 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("ok");
  });

  it("a stall AFTER output started is thrown (StreamIdleError), never replayed (first-delta rule)", async () => {
    let calls = 0;
    const chunk = `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "partial" })}\n\n`;
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: chunkThenStall(chunk) };
    }) as typeof fetch;
    const model = createResponsesProvider(CFG, { fetch, retry: { ...INSTANT, maxRetries: 3 }, streamIdleTimeoutMs: 40 });
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
    const model = createResponsesProvider(CFG, { fetch, retry: INSTANT, streamIdleTimeoutMs: 0 });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Per-response accumulation caps (OOM fix, r1a task 2). Same semantics as the
// openai engine's caps (openai-compatible.ts): the adapter's accumulation
// points — fromResponsesOutput's joined output_text/summary text and the
// function_call arguments string — are capped at 2M chars with the in-band
// truncation marker. fromResponsesOutput is the shared assembly for BOTH the
// non-streaming payload and the stream's collected done items, so capping it
// covers both paths.
// ---------------------------------------------------------------------------

describe("responses per-response accumulation caps (OOM fix)", () => {
  const CAP = 2_000_000;
  const MARK = "[truncated at 2M chars]";

  it("caps non-streaming output text, reasoning summary, and tool arguments at 2M chars", async () => {
    const payload = {
      output: [
        { type: "message", content: [{ type: "output_text", text: "c".repeat(CAP + 100_000) }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "r".repeat(CAP + 100_000) }] },
        // Valid JSON when whole — the cap (slice + marker) makes it unparseable,
        // so the _unparsed fallback must carry the CAPPED tail, not the raw one.
        { type: "function_call", call_id: "c1", name: "write_file", arguments: `{"x":"${"v".repeat(CAP + 100_000)}"}` },
      ],
    };
    const fetch = (async () => ({ ok: true, status: 200, json: async () => payload })) as typeof fetch;
    const model = createResponsesProvider(CFG, { fetch });
    const msg = await model.generate(INPUT);
    expect(msg.content.length).toBe(CAP + MARK.length);
    expect(msg.content.endsWith(MARK)).toBe(true);
    expect(msg.reasoning?.length).toBe(CAP + MARK.length);
    expect(msg.reasoning?.endsWith(MARK)).toBe(true);
    expect(msg.toolCalls?.[0]?.name).toBe("write_file");
    const unparsed = (msg.toolCalls?.[0]?.arguments as { _unparsed: string })._unparsed;
    expect(unparsed.length).toBe(CAP + MARK.length);
    expect(unparsed.endsWith(MARK)).toBe(true);
  });

  it("caps the streamed done items at 2M chars and keeps processing later events", async () => {
    const lines: string[] = [
      JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
      JSON.stringify({ type: "response.reasoning_summary_text.delta", delta: "ok" }),
      // The huge assembled items (the adapter's actual accumulation — it
      // collects output_item.done items, not the deltas).
      JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "c".repeat(CAP + 100_000) }] } }),
      JSON.stringify({ type: "response.output_item.done", item: { type: "reasoning", summary: [{ type: "summary_text", text: "r".repeat(CAP + 100_000) }] } }),
      // Post-cap events still processed: a later well-formed item + completion.
      JSON.stringify({ type: "response.output_item.done", item: { type: "function_call", call_id: "c9", name: "read_file", arguments: "{}" } }),
      JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }),
    ];
    const model = createResponsesProvider(CFG, { fetch: sseFetchLike(lines) });
    let done: any;
    let doneCount = 0;
    let usage: unknown;
    for await (const ev of model.stream!({ ...INPUT, onUsage: (u: unknown) => void (usage = u) })) {
      if (ev.type === "done") {
        doneCount += 1;
        done = ev.message;
      }
    }
    expect(done.content.length).toBe(CAP + MARK.length);
    expect(done.content.endsWith(MARK)).toBe(true);
    expect(done.reasoning.length).toBe(CAP + MARK.length);
    expect(done.reasoning.endsWith(MARK)).toBe(true);
    expect(done.toolCalls[0].name).toBe("read_file"); // the later item was processed after the caps
    expect(doneCount).toBe(1); // the stream finished normally — no throw, no hang
    expect(usage).toMatchObject({ promptTokens: 3, completionTokens: 1 }); // response.completed processed too
  });
});
