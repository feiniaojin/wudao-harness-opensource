// ω-2b (I1-a / I1-b) — the observation plumbing at the provider boundary:
//   parseContextLimitBody  the trusted-parse of classified overflow bodies
//                          (DeepSeek prose + the JSON spelling; zhipu and
//                          junk stay opaque),
//   observed stamping      ContextLengthError carries the parsed pair (both
//                          paths: generate + stream),
//   ModelInput.maxTokens   the per-request completion cap reaches the body's
//                          max_tokens and NOTHING else in the request changes
//                          (byte-diff), overriding ProviderConfig.maxTokens.
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  parseContextLimitBody,
  resolveProviderConfig,
  resolveWindowMode,
} from "../src/index.js";
import type { ModelInput } from "@wudao/core";

const jsonRes = (status: number, body: unknown): Response =>
  ({ ok: status === 200, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }) as unknown as Response;

const DEEPSEEK_PROSE =
  "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens (109549 in the messages, 96 in the completion). Please reduce the length of the messages.";

describe("parseContextLimitBody — trusted parses only (ω-2b I1-a)", () => {
  it("DeepSeek prose with a carried max_tokens: requested decomposes into prompt + completion", () => {
    expect(parseContextLimitBody(DEEPSEEK_PROSE, 8192)).toEqual({ promptTokens: 109645 - 8192, windowTokens: 65536 });
  });

  it("DeepSeek prose without max_tokens: the whole requested figure is the (conservative) prompt", () => {
    expect(parseContextLimitBody(DEEPSEEK_PROSE)).toEqual({ promptTokens: 109645, windowTokens: 65536 });
    expect(parseContextLimitBody(DEEPSEEK_PROSE, undefined)).toEqual({ promptTokens: 109645, windowTokens: 65536 });
  });

  it("a requested figure at or below the carried cap cannot go non-positive: the raw figure stands", () => {
    expect(parseContextLimitBody(DEEPSEEK_PROSE, 200000)).toEqual({ promptTokens: 109645, windowTokens: 65536 });
  });

  it("the JSON spelling (input_tokens + context_limit) parses to the same pair shape", () => {
    expect(parseContextLimitBody('{"error":{"message":"context length exceeded","input_tokens":50000,"context_limit":65536}}'))
      .toEqual({ promptTokens: 50000, windowTokens: 65536 });
  });

  it("120-b B2: the GLM/vLLM spelling parses the input figure as-is — maxTokens plays no decomposition role", () => {
    // vLLM's "input length" counts prompt tokens only (no completion budget
    // folded in), so the figure is promptTokens regardless of any carried
    // cap — unlike the DeepSeek prose's "you requested" decomposition.
    expect(parseContextLimitBody("Input length 1048826 exceeds the maximum length 1048566"))
      .toEqual({ promptTokens: 1048826, windowTokens: 1048566 });
    expect(parseContextLimitBody("Input length 12345 exceeds the maximum length 8192.", 4096))
      .toEqual({ promptTokens: 12345, windowTokens: 8192 });
  });

  it("120-b B2: equal/inverted/numberless GLM spellings stay opaque", () => {
    expect(parseContextLimitBody("Input length 8192 exceeds the maximum length 8192")).toBeUndefined();
    expect(parseContextLimitBody("Input length 100 exceeds the maximum length 8192")).toBeUndefined();
    expect(parseContextLimitBody("Input length is too long")).toBeUndefined();
  });

  it("zhipu bodies carry no numbers — they stay opaque", () => {
    expect(parseContextLimitBody('{"error":{"code":"1214","message":"messages parameter is invalid. Prompt too long"}}')).toBeUndefined();
    expect(parseContextLimitBody('{"error":{"code":"1214","message":"messages 参数非法。 Prompt 超长"}}')).toBeUndefined();
  });

  it("junk, numberless, and empty bodies stay opaque", () => {
    expect(parseContextLimitBody("payload too large")).toBeUndefined();
    expect(parseContextLimitBody("This model's maximum context length is 8192 tokens.")).toBeUndefined();
    expect(parseContextLimitBody("")).toBeUndefined();
    expect(parseContextLimitBody("The input content exceeds the model's maximum context length.")).toBeUndefined();
  });

  it("non-numeric prose captures never produce an observation", () => {
    expect(parseContextLimitBody("maximum context length is NaN tokens. However, you requested abc tokens")).toBeUndefined();
  });
});

describe("ContextLengthError.observed stamping (ω-2b I1-a)", () => {
  it("generate: a 413 with the DeepSeek prose carries the parsed pair (no cap carried)", async () => {
    const fetch = (async () => jsonRes(413, { error: { message: DEEPSEEK_PROSE } })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] }))
      .rejects.toMatchObject({ name: "ContextLengthError", observed: { promptTokens: 109645, windowTokens: 65536 } });
  });

  it("generate: a config max_tokens decomposes the requested figure", async () => {
    const fetch = (async () => jsonRes(400, { error: { message: DEEPSEEK_PROSE } })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", maxTokens: 4096 },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] }))
      .rejects.toMatchObject({ name: "ContextLengthError", observed: { promptTokens: 109645 - 4096, windowTokens: 65536 } });
  });

  it("generate: a per-INPUT cap beats the config's for the decomposition", async () => {
    const fetch = (async () => jsonRes(400, { error: { message: DEEPSEEK_PROSE } })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", maxTokens: 4096 },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [], maxTokens: 1024 }))
      .rejects.toMatchObject({ name: "ContextLengthError", observed: { promptTokens: 109645 - 1024, windowTokens: 65536 } });
  });

  it("generate: a numberless 413 classifies but stays opaque", async () => {
    const fetch = (async () => jsonRes(413, "payload too large")) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    const err = await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as { name?: string }).name).toBe("ContextLengthError");
    expect((err as { observed?: unknown }).observed).toBeUndefined();
  });

  it("stream: the same stamping rides the streaming path", async () => {
    const fetch = (async () => jsonRes(413, { error: { message: DEEPSEEK_PROSE } })) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    const gen = model.stream!({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
    await expect(gen.next()).rejects.toMatchObject({ name: "ContextLengthError", observed: { promptTokens: 109645, windowTokens: 65536 } });
  });
});

describe("ModelInput.maxTokens — the cache-neutral knob (ω-2b I1-b)", () => {
  const okBody = { choices: [{ message: { role: "assistant", content: "ok" } }] };
  const INPUT: ModelInput = { systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] };

  async function bodiesFor(input: ModelInput, config: { maxTokens?: number } = {}): Promise<Record<string, unknown>> {
    const seen: Record<string, unknown>[] = [];
    const fetch = (async (_url: unknown, init: { body: string }) => {
      seen.push(JSON.parse(init.body));
      return jsonRes(200, okBody);
    }) as unknown as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", ...config },
      { fetch, retry: { maxRetries: 0 } },
    );
    await model.generate(input);
    expect(seen).toHaveLength(1);
    return seen[0]!;
  }

  it("absent everywhere: no max_tokens key on the wire (status-quo bytes)", async () => {
    const body = await bodiesFor(INPUT);
    expect("max_tokens" in body).toBe(false);
  });

  it("a per-input cap adds max_tokens and NOTHING else in the request changes (byte-diff)", async () => {
    const [plain, capped] = await Promise.all([
      bodiesFor(INPUT),
      bodiesFor({ ...INPUT, maxTokens: 15808 }),
    ]);
    expect(plain["max_tokens"]).toBeUndefined();
    expect(capped["max_tokens"]).toBe(15808);
    // Byte-diff discipline: delete the one key and the rest is identical.
    const { max_tokens: _drop, ...cappedRest } = capped;
    expect(cappedRest).toEqual(plain);
  });

  it("a per-input cap overrides the config's for that one call", async () => {
    const body = await bodiesFor({ ...INPUT, maxTokens: 1234 }, { maxTokens: 4096 });
    expect(body["max_tokens"]).toBe(1234);
  });

  it("a config-only cap keeps its M45 behavior (key present, value = config's)", async () => {
    const body = await bodiesFor(INPUT, { maxTokens: 4096 });
    expect(body["max_tokens"]).toBe(4096);
  });
});

describe("windowMode profile pin (ω-2b I1-c)", () => {
  it("deepseek is shared; uncharacterized profiles and hand-built configs stay unknown", () => {
    expect(resolveWindowMode({ apiKey: "k", baseURL: "https://api.deepseek.com", model: "m", provider: "deepseek" })).toBe("shared");
    expect(resolveWindowMode({ apiKey: "k", baseURL: "https://open.bigmodel.cn/api/paas/v4", model: "m", provider: "glm" })).toBe("unknown");
    expect(resolveWindowMode({ apiKey: "k", baseURL: "https://x/v1", model: "m" })).toBe("unknown");
    expect(resolveWindowMode({ apiKey: "k", baseURL: "https://x/v1", model: "m", windowMode: "independent" })).toBe("independent");
  });

  it("resolveProviderConfigResult threads the deepseek pin onto the config", () => {
    const config = resolveProviderConfig({ WUDAO_API_KEY: "k" }, {});
    expect(config).not.toBeNull();
    expect(config?.windowMode).toBe("shared");
  });
});
