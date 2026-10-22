// packages/providers/tests/model-fallback.test.ts — r1a Task 3（M62 §7 链抽取）。
// 装饰器单测（scripted legs，无 HTTP）+ 三工厂接线 pin（scripted fetch）。
// 语义逐字段照 openai 工厂抽出前的行为：sticky streak=2、eligible 判据、
// usage receipt 标注（fallbackModel/fallbackFrom）、流式 produced 守卫。
import { describe, it, expect } from "vitest";
import type { AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, ModelUsage } from "@wudao/core";
import { withModelFallback } from "../src/model-fallback.js";
import { ContextLengthError, ProviderHttpError, createOpenAICompatibleProvider } from "../src/openai-compatible.js";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createResponsesProvider } from "../src/responses.js";
import type { ProviderConfig } from "../src/config.js";

const INPUT = (onUsage?: (u: ModelUsage) => void): ModelInput => ({
  systemPrompt: "s",
  messages: [{ role: "user", content: "go" }],
  tools: [],
  ...(onUsage !== undefined ? { onUsage } : {}),
});

/** A failing leg answer every scripted test can reuse. */
const HTTP_500 = (): ProviderHttpError => new ProviderHttpError("request", 500, "boom");

describe("withModelFallback decorator (scripted legs)", () => {
  it("generate: eligible primary failure falls back to the next model; usage receipt annotated; primary identity kept", async () => {
    const calls: string[] = [];
    const rows: ModelUsage[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(input: ModelInput): Promise<AssistantMessage> {
        calls.push(cfg.model);
        if (cfg.model === "primary") throw HTTP_500();
        input.onUsage?.({ promptTokens: 3, cacheHitTokens: 0, cacheMissTokens: 3, completionTokens: 2 });
        return { role: "assistant", content: `from ${cfg.model}` };
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    expect(client.modelId).toBe("primary");
    const out = await client.generate(INPUT((u) => rows.push(u)));
    expect(out.content).toBe("from fb1");
    expect(calls).toEqual(["primary", "fb1"]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "fb1", fallbackModel: "fb1", fallbackFrom: "primary", promptTokens: 3, completionTokens: 2 });
  });

  it("generate: sticky — one blip retries the primary next call; two consecutive failures pin to the first fallback", async () => {
    const calls: string[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        calls.push(cfg.model);
        if (cfg.model === "primary") throw new ProviderHttpError("request", 503, "overloaded");
        return { role: "assistant", content: "ok" };
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1", "fb2"] } as ProviderConfig);
    await client.generate(INPUT()); // primary fail → fb1 ok (streak 1)
    await client.generate(INPUT()); // still starts at primary (one blip) → fail → fb1 ok (streak 2)
    const before = calls.length;
    await client.generate(INPUT()); // streak ≥ 2 → skips straight to fb1
    expect(calls).toEqual(["primary", "fb1", "primary", "fb1", "fb1"]);
    expect(calls.slice(before)).toEqual(["fb1"]);
  });

  it("generate: a primary success resets the streak", async () => {
    const calls: string[] = [];
    let primaryFails = true;
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        calls.push(cfg.model);
        if (cfg.model === "primary" && primaryFails) throw HTTP_500();
        return { role: "assistant", content: "ok" };
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    await client.generate(INPUT()); // streak 1
    primaryFails = false;
    await client.generate(INPUT()); // primary succeeds → streak 0
    primaryFails = true;
    await client.generate(INPUT()); // starts at primary again → streak 1
    const before = calls.length;
    await client.generate(INPUT()); // streak 1 < 2 → starts at primary again
    expect(calls.slice(before)).toEqual(["primary", "fb1"]);
  });

  it("generate: key-class (401) failures never fall back — the original error is rethrown", async () => {
    const calls: string[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        calls.push(cfg.model);
        if (cfg.model === "primary") throw new ProviderHttpError("request", 401, "unauthorized");
        return { role: "assistant", content: "ok" };
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    const err = await client.generate(INPUT()).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(calls).toEqual(["primary"]);
  });

  it("generate: aborts and context-overflow failures are rethrown untouched", async () => {
    const abort = new Error("The operation was aborted");
    abort.name = "AbortError";
    for (const fail of [abort, new ContextLengthError(413, "prompt too long")]) {
      const calls: string[] = [];
      const client = withModelFallback((cfg) => ({
        modelId: cfg.model,
        async generate(): Promise<AssistantMessage> {
          calls.push(cfg.model);
          if (cfg.model === "primary") throw fail;
          return { role: "assistant", content: "ok" };
        },
        async *stream(): AsyncGenerator<ModelStreamEvent> {
          throw new Error("unused in this test");
        },
      }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
      const err = await client.generate(INPUT()).then(() => undefined, (e: unknown) => e);
      expect(err).toBe(fail);
      expect(calls).toEqual(["primary"]);
    }
  });

  it("generate: every leg failing eligible throws the LAST leg's error", async () => {
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        throw new ProviderHttpError("request", 500, `leg-${cfg.model}`);
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1", "fb2"] } as ProviderConfig);
    const err = await client.generate(INPUT()).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).body).toBe("leg-fb2");
  });

  it("generate: fallback entries equal to the primary model are filtered out", async () => {
    const calls: string[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        calls.push(cfg.model);
        if (cfg.model === "m") throw HTTP_500();
        return { role: "assistant", content: "ok" };
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        throw new Error("unused in this test");
      },
    }), { apiKey: "k", baseURL: "http://x", model: "m", fallbackModels: ["m", "fb"] } as ProviderConfig);
    await client.generate(INPUT());
    expect(calls).toEqual(["m", "fb"]);
  });

  it("stream: eligible failure before the first delta falls back; usage receipt annotated", async () => {
    const calls: string[] = [];
    const rows: ModelUsage[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        throw new Error("unused in this test");
      },
      async *stream(input: ModelInput): AsyncGenerator<ModelStreamEvent> {
        calls.push(cfg.model);
        if (cfg.model === "primary") throw new ProviderHttpError("stream", 500, "boom");
        yield { type: "reasoning_delta", text: "think" };
        yield { type: "text_delta", text: "hi" };
        input.onUsage?.({ promptTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1, completionTokens: 1 });
        yield { type: "done", message: { role: "assistant", content: "hi" } };
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    const events: string[] = [];
    for await (const ev of client.stream(INPUT((u) => rows.push(u)))) events.push(ev.type);
    expect(events).toEqual(["reasoning_delta", "text_delta", "done"]);
    expect(calls).toEqual(["primary", "fb1"]);
    expect(rows[0]).toMatchObject({ model: "fb1", fallbackModel: "fb1", fallbackFrom: "primary" });
  });

  it("stream: a failure AFTER the first delta is rethrown — no fallback (a replay would duplicate output)", async () => {
    const calls: string[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        throw new Error("unused in this test");
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        calls.push(cfg.model);
        if (cfg.model === "primary") {
          yield { type: "text_delta", text: "partial" };
          throw new ProviderHttpError("stream", 500, "mid-stream break");
        }
        yield { type: "done", message: { role: "assistant", content: "ok" } };
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    const seen: string[] = [];
    const err = await (async () => {
      for await (const ev of client.stream(INPUT())) seen.push(ev.type);
    })().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).body).toBe("mid-stream break");
    expect(seen).toEqual(["text_delta"]);
    expect(calls).toEqual(["primary"]);
  });

  it("stream: sticky after two consecutive primary failures", async () => {
    const calls: string[] = [];
    const client = withModelFallback((cfg) => ({
      modelId: cfg.model,
      async generate(): Promise<AssistantMessage> {
        throw new Error("unused in this test");
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        calls.push(cfg.model);
        if (cfg.model === "primary") throw new ProviderHttpError("stream", 500, "boom");
        yield { type: "done", message: { role: "assistant", content: "ok" } };
      },
    }), { apiKey: "k", baseURL: "http://x", model: "primary", fallbackModels: ["fb1"] } as ProviderConfig);
    const drain = async (): Promise<void> => {
      for await (const _ev of client.stream(INPUT())) { /* drain */ }
    };
    await drain();
    await drain();
    const before = calls.length;
    await drain();
    expect(calls.slice(before)).toEqual(["fb1"]);
  });
});

// ---------------------------------------------------------------------------
// Factory wiring pins — the decorator is the ONE chain implementation all three
// protocol adapters route through (openai: extraction equivalence; anthropic/
// responses: the new capability's existence proof).
// ---------------------------------------------------------------------------

const NO_SLEEP = { sleep: async (): Promise<void> => {}, maxRetries: 0 };

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(`data: ${l}\n\n`));
      controller.close();
    },
  });
}

describe("factory wiring — openai-compatible (extraction equivalence)", () => {
  it("the chain switches models end-to-end, annotates the receipt, and pins sticky + key-class semantics", async () => {
    const requested: string[] = [];
    const rows: ModelUsage[] = [];
    const fetchByModel = (statusFor: (m: string) => number): typeof fetch =>
      (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        requested.push(body.model);
        if (statusFor(body.model) !== 200) return { ok: false, status: statusFor(body.model), text: async () => "boom" };
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { role: "assistant", content: `from ${body.model}` } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        };
      }) as typeof fetch;
    const config = { apiKey: "k", baseURL: "http://fb.test", model: "primary", fallbackModels: ["fb1", "fb2"] };
    const provider = createOpenAICompatibleProvider(config, {
      fetch: fetchByModel((m) => (m === "primary" || m === "fb1" ? 500 : 200)),
      retry: NO_SLEEP,
    });
    const out = await provider.generate({
      systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }],
      onUsage: (u) => rows.push(u),
    });
    expect(out.content).toBe("from fb2");
    expect(requested).toEqual(["primary", "fb1", "fb2"]);
    expect(rows[0]).toMatchObject({ model: "fb2", fallbackModel: "fb2", fallbackFrom: "primary" });
    // Sticky: two consecutive primary failures → the next call starts at fb1.
    await provider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "again" }] });
    const before = requested.length;
    await provider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "third" }] });
    expect(requested.slice(before)).toEqual(["fb1", "fb2"]);
    // Key-class (401) NEVER falls back.
    const keyRequested: string[] = [];
    const keyProvider = createOpenAICompatibleProvider(config, {
      fetch: (async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        keyRequested.push(body.model);
        return { ok: false, status: 401, text: async () => "unauthorized" };
      }) as typeof fetch,
      retry: NO_SLEEP,
    });
    const keyErr = await keyProvider.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] })
      .then(() => undefined, (e: unknown) => e);
    expect(keyErr).toBeInstanceOf(ProviderHttpError);
    expect((keyErr as ProviderHttpError).status).toBe(401);
    expect(keyRequested).toEqual(["primary"]);
  });

  it("stream falls back on an eligible pre-delta failure", async () => {
    const requested: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      requested.push(body.model);
      if (body.model === "primary") return { ok: false, status: 500, text: async () => "boom" };
      return {
        ok: true,
        status: 200,
        body: sseBody([
          '{"choices":[{"delta":{"content":"sa"}}]}',
          '{"choices":[{"delta":{"content":"ved"}}]}',
          '[DONE]',
        ]),
      };
    }) as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "http://fb.test", model: "primary", fallbackModels: ["fb1"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const text: string[] = [];
    let done: AssistantMessage | undefined;
    for await (const ev of provider.stream!({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] })) {
      if (ev.type === "text_delta") text.push(ev.text);
      else if (ev.type === "done") done = ev.message;
    }
    expect(requested).toEqual(["primary", "fb1"]);
    expect(text.join("")).toBe("saved");
    expect(done?.content).toBe("saved");
  });
});

describe("factory wiring — anthropic (new capability pin)", () => {
  const anthropicOk = (model: string) => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: "text", text: `from ${model}` }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  });

  it("fallbackModels now drive the chain: 5xx on the primary → answered by the fallback, receipt annotated", async () => {
    const models: string[] = [];
    const rows: ModelUsage[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "claude-primary") return { ok: false, status: 500, text: async () => "overloaded" };
      return anthropicOk(body.model);
    }) as typeof fetch;
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://anth.test", model: "claude-primary", fallbackModels: ["claude-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], onUsage: (u) => rows.push(u) });
    expect(msg.content).toBe("from claude-fb");
    expect(models).toEqual(["claude-primary", "claude-fb"]);
    expect(rows[0]).toMatchObject({ model: "claude-fb", fallbackModel: "claude-fb", fallbackFrom: "claude-primary", promptTokens: 3, completionTokens: 2 });
  });

  it("key-class 401 on the anthropic path never falls back", async () => {
    const models: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      return { ok: false, status: 401, text: async () => "unauthorized" };
    }) as typeof fetch;
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://anth.test", model: "claude-primary", fallbackModels: ["claude-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const err = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [] })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(models).toEqual(["claude-primary"]);
  });

  it("stream: pre-delta 500 on the primary → the fallback streams to done, receipt annotated", async () => {
    const models: string[] = [];
    const rows: ModelUsage[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "claude-primary") return { ok: false, status: 500, text: async () => "overloaded" };
      return {
        ok: true,
        status: 200,
        body: sseBody([
          '{"type":"message_start","message":{"usage":{"input_tokens":3,"output_tokens":0}}}',
          '{"type":"content_block_start","index":1,"content_block":{"type":"text"}}',
          '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"sa"}}',
          '{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"ved"}}',
          '{"type":"content_block_stop","index":1}',
          '{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
          '{"type":"message_stop"}',
        ]),
      };
    }) as typeof fetch;
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://anth.test", model: "claude-primary", fallbackModels: ["claude-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const text: string[] = [];
    let done: AssistantMessage | undefined;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], onUsage: (u) => rows.push(u) })) {
      if (ev.type === "text_delta") text.push(ev.text);
      else if (ev.type === "done") done = ev.message;
    }
    expect(models).toEqual(["claude-primary", "claude-fb"]);
    expect(text.join("")).toBe("saved");
    expect(done?.content).toBe("saved");
    expect(rows[0]).toMatchObject({ model: "claude-fb", fallbackModel: "claude-fb", fallbackFrom: "claude-primary", promptTokens: 3, completionTokens: 2 });
  });
});

describe("factory wiring — responses (new capability pin)", () => {
  it("fallbackModels now drive the chain (generate): 503 on the primary → answered by the fallback, receipt annotated", async () => {
    const models: string[] = [];
    const rows: ModelUsage[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "gpt-primary") return { ok: false, status: 503, text: async () => "unavailable" };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          output: [{ type: "message", content: [{ type: "output_text", text: `from ${body.model}` }] }],
          usage: { input_tokens: 4, output_tokens: 2 },
        }),
      };
    }) as typeof fetch;
    const model = createResponsesProvider(
      { apiKey: "k", baseURL: "https://resp.test/v1", model: "gpt-primary", fallbackModels: ["gpt-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const msg = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [], onUsage: (u) => rows.push(u) });
    expect(msg.content).toBe("from gpt-fb");
    expect(models).toEqual(["gpt-primary", "gpt-fb"]);
    expect(rows[0]).toMatchObject({ model: "gpt-fb", fallbackModel: "gpt-fb", fallbackFrom: "gpt-primary", promptTokens: 4 });
  });

  it("fallbackModels now drive the chain (stream): pre-delta 500 on the primary → the fallback streams to done", async () => {
    const models: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      if (body.model === "gpt-primary") return { ok: false, status: 500, text: async () => "boom" };
      return {
        ok: true,
        status: 200,
        body: sseBody([
          '{"type":"response.output_text.delta","delta":"hi"}',
          '{"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1},"output":[]}}',
        ]),
      };
    }) as typeof fetch;
    const model = createResponsesProvider(
      { apiKey: "k", baseURL: "https://resp.test/v1", model: "gpt-primary", fallbackModels: ["gpt-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const text: string[] = [];
    let done: AssistantMessage | undefined;
    for await (const ev of model.stream!({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [] })) {
      if (ev.type === "text_delta") text.push(ev.text);
      else if (ev.type === "done") done = ev.message;
    }
    expect(models).toEqual(["gpt-primary", "gpt-fb"]);
    expect(text.join("")).toBe("hi");
    expect(done?.content).toBe("");
  });

  it("key-class 401 on the responses path never falls back", async () => {
    const models: string[] = [];
    const fakeFetch = (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      models.push(body.model);
      return { ok: false, status: 401, text: async () => "unauthorized" };
    }) as typeof fetch;
    const model = createResponsesProvider(
      { apiKey: "k", baseURL: "https://resp.test/v1", model: "gpt-primary", fallbackModels: ["gpt-fb"] },
      { fetch: fakeFetch, retry: NO_SLEEP },
    );
    const err = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [] })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
    expect(models).toEqual(["gpt-primary"]);
  });
});
