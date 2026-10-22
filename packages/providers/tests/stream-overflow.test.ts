// r1b (B group) — the SSE line-buffer cap. A live stream that keeps delivering
// bytes but NEVER a line/event boundary grows the line buffer without bound —
// the idle watchdog cannot catch it (every read resolves on time, the stream
// never goes quiet). The buffer is capped at MAX_ACCUM_CHARS in the shared
// sseDataLines (anthropic + responses) AND the openai engine's inline loop
// (the three isomorphic SSE consumers): fail LOUD with the typed
// StreamOverflowError — never truncate (a sliced SSE line would fabricate
// garbage events). The error walks the same retry ladder as StreamIdleError
// (transient transport class): the replay is byte-identical, the prefix cache
// is unaffected; a USER abort still never retries.
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createResponsesProvider,
  StreamOverflowError,
  isRetryableProviderError,
  type RetryObserver,
} from "../src/index.js";
import { MAX_ACCUM_CHARS } from "../src/openai-compatible.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const INSTANT = { sleep: async (): Promise<void> => {}, random: (): number => 0.5 } as const;

const CFG_OAI = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const CFG_AN = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const CFG_RS = { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-the upstream project" };

/** Bytes with NO line/event boundary — the unbounded-buffer poison. Finite
 *  (cap + 50%) so a MISSING guard fails an assertion instead of hanging the
 *  run; small chunks so the buffer crosses the cap mid-stream, across reads. */
function boundarylessBody(): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const chunk = "x".repeat(256 * 1024);
  const total = MAX_ACCUM_CHARS + Math.floor(MAX_ACCUM_CHARS / 2);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const n = Math.min(chunk.length, total - sent);
      sent += n;
      controller.enqueue(enc.encode(chunk.slice(0, n)));
    },
  });
}

/** A well-formed small-SSE body (the healthy second attempt / normal path). */
function okBody(lines: readonly string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`));
      c.close();
    },
  });
}

const OK_OAI = okBody([
  JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
  "[DONE]",
]);
const OK_AN = okBody([
  JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
  JSON.stringify({ type: "message_stop" }),
]);
const OK_RS = okBody([
  JSON.stringify({ type: "response.output_text.delta", delta: "ok" }),
  JSON.stringify({ type: "response.completed", response: { usage: { input_tokens: 3, output_tokens: 1 } } }),
]);

/** The shared poison-then-OK script: first call boundaryless, then healthy. */
function poisonThenOkFetch(ok: ReadableStream<Uint8Array>): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let n = 0;
  const doFetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    n += 1;
    return { ok: true, status: 200, body: n === 1 ? boundarylessBody() : ok };
  }) as typeof fetch;
  return { fetch: doFetch, bodies };
}

describe("sse line-buffer overflow cap (r1b)", () => {
  it("openai engine: a boundaryless live stream aborts with the typed error; the ladder replay succeeds byte-identically", async () => {
    const { fetch, bodies } = poisonThenOkFetch(OK_OAI);
    const retries: string[] = [];
    const onRetry: RetryObserver = (_n, _ms, reason) => void retries.push(reason);
    const model = createOpenAICompatibleProvider(CFG_OAI, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } });
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
      else events.push(ev.type);
    }
    expect(events).toEqual(["ok", "done"]);
    // The abort rode the ladder and announced the overflow reason.
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("sse line buffer");
    // Prefix-cache safety: the replayed request is byte-for-byte the same body.
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("anthropic adapter (shared sseDataLines): same abort + byte-identical replay", async () => {
    const { fetch, bodies } = poisonThenOkFetch(OK_AN);
    const retries: string[] = [];
    const onRetry: RetryObserver = (_n, _ms, reason) => void retries.push(reason);
    const model = createAnthropicProvider(CFG_AN, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } });
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
      else events.push(ev.type);
    }
    expect(events).toEqual(["ok", "done"]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("sse line buffer");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("responses adapter (shared sseDataLines): same abort + byte-identical replay", async () => {
    const { fetch, bodies } = poisonThenOkFetch(OK_RS);
    const retries: string[] = [];
    const onRetry: RetryObserver = (_n, _ms, reason) => void retries.push(reason);
    const model = createResponsesProvider(CFG_RS, { fetch, onRetry, retry: { ...INSTANT, maxRetries: 2 } });
    const events: string[] = [];
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") events.push(ev.text);
      else events.push(ev.type);
    }
    expect(events).toEqual(["ok", "done"]);
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("sse line buffer");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("with the ladder spent (maxRetries 0) the typed error surfaces as-is", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return { ok: true, status: 200, body: boundarylessBody() };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG_OAI, { fetch, retry: { ...INSTANT, maxRetries: 0 } });
    await expect(
      (async () => {
        for await (const _ev of model.stream!(INPUT)) {
          // drain
        }
      })(),
    ).rejects.toMatchObject({ name: "StreamOverflowError" });
    expect(calls).toBe(1);
  });

  it("the thrown error is the typed StreamOverflowError and is retryable (the StreamIdleError ladder family)", () => {
    const err = new StreamOverflowError(MAX_ACCUM_CHARS);
    expect(err.name).toBe("StreamOverflowError");
    expect(err.maxChars).toBe(MAX_ACCUM_CHARS);
    expect(err.message).toContain("2000000");
    // Same ladder classification as StreamIdleError: transient transport class.
    expect(isRetryableProviderError(err)).toBe(true);
  });

  it("normal short-line streams are unaffected (multi-read, well-formed)", async () => {
    const enc = new TextEncoder();
    const lines = [
      JSON.stringify({ choices: [{ delta: { content: "a" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "b" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "c" } }] }),
      "[DONE]",
    ];
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= lines.length) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(`data: ${lines[i++]}\n\n`));
      },
    });
    const fetch = (async () => ({ ok: true, status: 200, body })) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG_OAI, { fetch, retry: INSTANT });
    let text = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") text += ev.text;
    }
    expect(text).toBe("abc");
  });
});
