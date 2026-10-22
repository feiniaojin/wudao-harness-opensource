import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider, resolveProviderConfig } from "../src/index.js";

describe("resolveProviderConfig", () => {
  it("returns null without an API key", () => {
    expect(resolveProviderConfig({})).toBeNull();
  });
  it("reads WUDAO_* with OPENAI_* fallback", () => {
    const c = resolveProviderConfig({ WUDAO_API_KEY: "k", WUDAO_BASE_URL: "https://x/v1", WUDAO_MODEL: "wudao-1" });
    expect(c?.apiKey).toBe("k");
    expect(c?.model).toBe("wudao-1");
  });
  it("falls back to OPENAI_* key and deepseek profile defaults", () => {
    const c = resolveProviderConfig({ OPENAI_API_KEY: "ok" });
    expect(c?.apiKey).toBe("ok");
    expect(c?.baseURL).toBe("https://api.deepseek.com");
    expect(c?.model).toBe("deepseek-v4-flash");
  });
});

describe("createOpenAICompatibleProvider", () => {
  it("maps a chat completion response to an AssistantMessage", async () => {
    let posted: any = {};
    const fakeFetch = (async (url: string, init: any) => {
      posted = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                role: "assistant",
                content: "hello world",
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
                ],
              },
            },
          ],
        }),
      };
    }) as typeof fetch;

    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: fakeFetch },
    );
    const msg = await model.generate({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    });

    expect(posted.url).toBe("https://x/v1/chat/completions");
    const body = JSON.parse(posted.init.body);
    expect(body.model).toBe("m");
    expect(body.messages[0].role).toBe("system");
    expect(body.tools[0].function.name).toBe("read_file");
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBe("hello world");
    expect(msg.toolCalls?.[0]?.id).toBe("call_1");
    expect(msg.toolCalls?.[0]?.name).toBe("read_file");
    expect(msg.toolCalls?.[0]?.arguments).toEqual({ path: "a.txt" });
  });

  it("surfaces reasoning_content on the returned AssistantMessage", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "answer",
              reasoning_content: "thinking...",
            },
          },
        ],
      }),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: fakeFetch },
    );
    const msg = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(msg.content).toBe("answer");
    expect(msg.reasoning).toBe("thinking...");
  });

  it("does not send reasoning back to the provider (toOpenAIMessage unchanged)", async () => {
    let postedBody: any;
    const fakeFetch = (async (_url: string, init: any) => {
      postedBody = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: fakeFetch },
    );
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a", reasoning: "secret thoughts" },
      ],
      tools: [],
    });
    const assistant = postedBody.messages.find((m: any) => m.role === "assistant");
    expect(assistant.reasoning).toBeUndefined();
    expect(assistant.reasoning_content).toBeUndefined();
  });

  it("throws a clear error on a non-OK response", async () => {
    const fakeFetch = (async () => ({ ok: false, status: 401, text: async () => "unauthorized" })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    await expect(model.generate({ systemPrompt: "s", messages: [], tools: [] })).rejects.toThrow(/401/);
  });

  it("serializes a multi-turn history (assistant tool_calls + tool result)", async () => {
    let posted: any = {};
    const fakeFetch = (async (url: string, init: any) => {
      posted = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "ok" } }],
        }),
      };
    }) as typeof fetch;

    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: fakeFetch },
    );
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "u" },
        { role: "assistant", content: "a", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "x" } }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "data" },
      ],
      tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }],
    });

    const messages = JSON.parse(posted.init.body).messages;
    // system first
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("s");
    // user
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("u");
    // assistant with tool_calls; arguments must be the JSON STRING
    expect(messages[2].role).toBe("assistant");
    expect(messages[2].content).toBe("a");
    expect(messages[2].tool_calls[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"x"}' },
    });
    // tool result echoed back with tool_call_id
    expect(messages[3].role).toBe("tool");
    expect(messages[3].tool_call_id).toBe("c1");
    expect(messages[3].content).toBe("data");
  });
});

describe("createOpenAICompatibleProvider abort signal", () => {
  // An injected fetch that behaves like real fetch under abort: the returned
  // promise rejects with a name-only "AbortError" when the request signal fires.
  function abortingFetch(): { fetch: typeof fetch; receivedSignal: () => AbortSignal | undefined } {
    let seen: AbortSignal | undefined;
    const fakeFetch = (async (_url: string, init: any) => {
      seen = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
    }) as typeof fetch;
    return { fetch: fakeFetch, receivedSignal: () => seen };
  }

  const tick = () => new Promise<void>((r) => setTimeout(r, 10));

  it("generate: passes input.signal into fetch and rethrows AbortError unwrapped", async () => {
    const { fetch, receivedSignal } = abortingFetch();
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch });
    const controller = new AbortController();

    const p = model.generate({
      systemPrompt: "s",
      messages: [],
      tools: [],
      signal: controller.signal,
    });
    await tick();
    controller.abort();

    // The signal passed to generate must be the one fetch received.
    expect(receivedSignal()).toBe(controller.signal);
    expect(receivedSignal()?.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const err = await p.catch((e: any) => e);
    expect(err.message).not.toContain("provider request failed");
  });

  it("stream: passes input.signal into fetch; aborting mid-stream throws AbortError from the generator", async () => {
    // SSE body that stalls until the request signal aborts, then errors the
    // stream with AbortError — mirroring a real aborted fetch body reader.
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fakeFetch = (async (_url: string, init: any) => {
      requestSignal = init.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          init.signal.addEventListener(
            "abort",
            () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
            { once: true },
          );
        },
      });
      return { ok: true, status: 200, body };
    }) as typeof fetch;

    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const consume = async () => {
      for await (const _ev of model.stream!({ systemPrompt: "s", messages: [], tools: [], signal: controller.signal })) {
        // drain
      }
    };
    const p = consume();
    await tick();
    controller.abort();

    expect(requestSignal?.aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    const err = await p.catch((e: any) => e);
    expect(err.message).not.toContain("provider stream failed");
  });

  it("regression: without a signal, fetch receives no signal and requests still work", async () => {
    let receivedSignal: AbortSignal | undefined;
    const fakeFetch = (async (_url: string, init: any) => {
      receivedSignal = init.signal;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const msg = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(receivedSignal).toBeUndefined();
    expect(msg.content).toBe("ok");
  });
});

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("createOpenAICompatibleProvider streaming", () => {
  it("streams text deltas then a done message", async () => {
    let postedBody: any;
    const fakeFetch = (async (_url: string, init: any) => {
      postedBody = JSON.parse(init.body);
      return {
        ok: true, status: 200,
        body: sseBody([
          'data: {"choices":[{"delta":{"content":"Hel"}}]}\n',
          '\n',
          'data: {"choices":[{"delta":{"content":"lo"}}]}\n',
          '\n',
          'data: [DONE]\n\n',
        ]),
      };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const out: string[] = [];
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "text_delta") out.push(ev.text); else done = ev.message;
    }
    expect(postedBody.stream).toBe(true);
    expect(out.join("")).toBe("Hello");
    expect(done.content).toBe("Hello");
    expect(done.toolCalls).toBeUndefined();
  });

  it("streams reasoning deltas then accumulates reasoning on done", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"reasoning_content":"thin"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_content":"king"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const reasoning: string[] = [];
    const text: string[] = [];
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "reasoning_delta") reasoning.push(ev.text);
      else if (ev.type === "text_delta") text.push(ev.text);
      else done = ev.message;
    }
    expect(reasoning.join("")).toBe("thinking");
    expect(text.join("")).toBe("Hi");
    expect(done.content).toBe("Hi");
    expect(done.reasoning).toBe("thinking");
  });

  it("accumulates fragmented tool_calls across deltas", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.txt\\"}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done.toolCalls[0].id).toBe("c1");
    expect(done.toolCalls[0].name).toBe("read_file");
    expect(done.toolCalls[0].arguments).toEqual({ path: "a.txt" });
  });

  // 夜移 011 (Reasonix think.go): vLLM chat-template lanes inline CoT into the
  // CONTENT channel as a turn-initial <think>…</think> block. Under
  // qwen-chat-template (or an explicit splitInbandThinking) the stream peels
  // it into reasoning_delta events + AssistantMessage.reasoning, so the CoT
  // rides the reasoning-replay contract instead of polluting replayed content.
  it("夜移 011: qwen-chat-template streams peel an in-band think block into reasoning", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"<th"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ink>deliberate"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":" quietly</think>"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"Answer: 42"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen-chat-template" },
      { fetch: fakeFetch },
    );
    const reasoning: string[] = [];
    const text: string[] = [];
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "reasoning_delta") reasoning.push(ev.text);
      else if (ev.type === "text_delta") text.push(ev.text);
      else done = ev.message;
    }
    expect(reasoning.join("")).toBe("deliberate quietly");
    expect(text.join("")).toBe("Answer: 42");
    expect(done.content).toBe("Answer: 42");
    expect(done.reasoning).toBe("deliberate quietly");
  });

  it("夜移 011: an unterminated in-band think block finishes as reasoning", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"<think>cut off mid"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen-chat-template" },
      { fetch: fakeFetch },
    );
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done.content).toBe("");
    expect(done.reasoning).toBe("cut off mid");
  });

  it("夜移 011: formats without the lane never touch plain content", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"<think>prose about tags</think>ok"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "deepseek" },
      { fetch: fakeFetch },
    );
    const text: string[] = [];
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "text_delta") text.push(ev.text);
      else done = ev.message;
    }
    expect(text.join("")).toBe("<think>prose about tags</think>ok");
    expect(done.content).toBe("<think>prose about tags</think>ok");
    expect(done.reasoning).toBeUndefined();
  });

  it("夜移 011: non-streaming generate peels the same block", async () => {
    const fakeFetch = (async () => ({
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "<think>ponder</think>result" } }] }),
    })) as unknown as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningFormat: "qwen-chat-template" },
      { fetch: fakeFetch },
    );
    const msg = await model.generate({ systemPrompt: "s", messages: [], tools: [] });
    expect(msg.content).toBe("result");
    expect(msg.reasoning).toBe("ponder");
  });
});

// OOM fix: per-response accumulation caps. A degenerate endpoint (or an
// adversarial stream) can pump unbounded reasoning/content/argument bytes;
// every accumulator is capped at 2M chars with an explicit truncation marker
// so no downstream consumer (driver live state, history, persistence) can
// ever hold an unbounded per-response string.
describe("per-response accumulation caps (OOM fix)", () => {
  const CAP = 2_000_000;
  const MARK = "[truncated at 2M chars]";

  it("caps streamed reasoning at 2M chars and stops yielding deltas past the cap", async () => {
    const piece = "推".repeat(100_000); // 25 deltas → 2.5M chars total
    const chunks: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: piece } }] })}\n\n`);
    }
    chunks.push("data: [DONE]\n\n");
    const fakeFetch = (async () => ({ ok: true, status: 200, body: sseBody(chunks) })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let yielded = 0;
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "reasoning_delta") yielded += ev.text.length;
      else if (ev.type === "done") done = ev.message;
    }
    // The crossing delta is yielded in full before the channel freezes —
    // the delta stream overshoots by at most one delta (bounded); the
    // accumulator and the final message never exceed the cap.
    expect(yielded).toBeLessThanOrEqual(CAP + piece.length);
    expect(done.reasoning.length).toBeLessThanOrEqual(CAP + MARK.length);
    expect(done.reasoning.endsWith(MARK)).toBe(true);
  });

  it("caps streamed content at 2M chars with the truncation marker", async () => {
    const piece = "a".repeat(700_000); // 4 deltas → 2.8M chars total
    const chunks: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
    }
    chunks.push("data: [DONE]\n\n");
    const fakeFetch = (async () => ({ ok: true, status: 200, body: sseBody(chunks) })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let yielded = 0;
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "text_delta") yielded += ev.text.length;
      else if (ev.type === "done") done = ev.message;
    }
    expect(yielded).toBeLessThanOrEqual(CAP + piece.length);
    expect(done.content.length).toBeLessThanOrEqual(CAP + MARK.length);
    expect(done.content.endsWith(MARK)).toBe(true);
  });

  it("caps accumulated tool-call arguments at 2M chars (degenerate JSON falls back to {})", async () => {
    const piece = "x".repeat(600_000); // 5 fragments → 3M chars of arguments
    const chunks: string[] = ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":""}}]}}]}\n\n'];
    for (let i = 0; i < 5; i += 1) {
      chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] })}\n\n`);
    }
    chunks.push("data: [DONE]\n\n");
    const fakeFetch = (async () => ({ ok: true, status: 200, body: sseBody(chunks) })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: any;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [], tools: [] })) {
      if (ev.type === "done") done = ev.message;
    }
    // Truncated + marker is not valid JSON — the 波段 7 #33 repair ladder
    // finds no container to salvage and falls back to the siblings' VISIBLE
    // `_unparsed` convention (anthropic.ts / responses.ts): the call stays
    // dispatchable, and the failure is no longer a silent {}.
    expect(done.toolCalls[0].name).toBe("write_file");
    const salvaged = done.toolCalls[0].arguments as Record<string, unknown>;
    expect(typeof salvaged._unparsed === "string" && salvaged._unparsed.endsWith(MARK)).toBe(true);
  });

  it("caps non-streaming content and reasoning at 2M chars", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [
          {
            message: {
              role: "assistant",
              content: "c".repeat(CAP + 100_000),
              reasoning_content: "r".repeat(CAP + 100_000),
            },
          },
        ],
      }),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(msg.content.length).toBe(CAP + MARK.length);
    expect(msg.content.endsWith(MARK)).toBe(true);
    expect(msg.reasoning?.length).toBe(CAP + MARK.length);
    expect(msg.reasoning?.endsWith(MARK)).toBe(true);
  });
});

// M45: maxTokens rides as max_tokens for budget-critical side calls; absent
// config keeps the body byte-identical to the pre-M45 shape.
describe("maxTokens completion cap (M45)", () => {
  const okResponse = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
  })) as typeof fetch;

  it("sends max_tokens when configured", async () => {
    let body: any;
    const fakeFetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return okResponse();
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", reasoningEffort: "none", maxTokens: 256 },
      { fetch: fakeFetch },
    );
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect(body.max_tokens).toBe(256);
  });

  it("omits max_tokens when not configured", async () => {
    let body: any;
    const fakeFetch = (async (_url: string, init: any) => {
      body = JSON.parse(init.body);
      return okResponse();
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch: fakeFetch },
    );
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] });
    expect("max_tokens" in body).toBe(false);
  });
});
