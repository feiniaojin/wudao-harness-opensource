// M58 §A — context-overflow classification (the 413 reactive layer's
// provider half): the vendor body vocabulary (DeepSeek/GLM/Qwen/vanilla
// OpenAI real message shapes), the 413/400/500 status gate, and the iron
// rule that the retry ladder NEVER retries a classified overflow (the loop
// reacts instead — compact once, retry once).
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  ContextLengthError,
  isContextLengthFailure,
  sniffContextLengthBody,
  isRetryableProviderError,
  matchContextLimitInputLength,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Classification — representative real bodies per vendor
// ---------------------------------------------------------------------------

/** (vendor, status, body, expected) — every sample is a real wording. */
const SAMPLES: readonly [string, number, string, boolean][] = [
  // DeepSeek (400, the OpenAI-style wording DeepSeek documents verbatim).
  ["deepseek 400", 400, '{"error":{"message":"This model\'s maximum context length is 65536 tokens. However, you requested 109645 tokens (109549 in the messages, 96 in the completion). Please reduce the length of the messages.","type":"invalid_request_error"}}', true],
  // vanilla OpenAI (400, same family of wording).
  ["openai 400", 400, "This model's maximum context length is 4097 tokens. However, you requested 100000 tokens. Please reduce the length of the messages.", true],
  // Qwen / DashScope (400): the Model-Studio wording.
  ["qwen 400", 400, "The input content (including conversation history and code context) exceeds the model's maximum context length.", true],
  // GLM / bigmodel 1214 (400) — Chinese body.
  ["glm 400 中文", 400, '{"error":{"code":"1214","message":"messages 参数非法。 Prompt 超长"}}', true],
  // GLM / bigmodel 1214 (400) — English docs wording.
  ["glm 400 english", 400, '{"error":{"code":"1214","message":"messages parameter is invalid. Prompt too long"}}', true],
  // 120-b B2 (Reasonix #10770) — the GLM/vLLM/SiliconFlow input-length
  // spelling: no "context length" vocabulary, numbers + N>M required.
  ["glm/vllm 400 input-length", 400, "Input length 1048826 exceeds the maximum length 1048566", true],
  ["glm/vllm 400 input-length context variant", 400, "input length 50000 exceeds the maximum context length 32768", true],
  ["glm/vllm 400 input-length equal pair stays opaque", 400, "Input length 8192 exceeds the maximum length 8192", false],
  ["glm/vllm 400 input-length inverted pair stays opaque", 400, "Input length 100 exceeds the maximum length 8192", false],
  ["glm/vllm 400 input-length numberless near-miss", 400, "Input length is too long", false],
  // Generic gateways that fold the same complaint into a 500.
  ["500 with vocabulary", 500, "internal error: context length exceeded for this conversation", true],
  // HTTP 413 classifies regardless of the body's wording.
  ["413 any body", 413, "payload too large", true],
  ["413 vendor body", 413, "This model's maximum context length is 65536 tokens.", true],
  // Negatives: same statuses, different complaints.
  ["400 invalid model", 400, '{"error":{"message":"The model `nope` does not exist","type":"invalid_request_error"}}', false],
  ["500 overload-flavored", 500, "The server is overloaded — try again", false],
  ["429 rate limited", 429, "This model\'s maximum context length is 65536 tokens.", false],
  // 413-adjacent statuses with the vocabulary still classify ONLY on 413/400/500.
  ["503 with vocabulary", 503, "upstream says context length exceeded", false],
];

describe("context-length classification (M58 §A)", () => {
  for (const [label, status, body, expected] of SAMPLES) {
    it(`classifies ${label}`, () => {
      expect(isContextLengthFailure(status, body)).toBe(expected);
    });
  }

  it("sniffs the body independently of the status", () => {
    expect(sniffContextLengthBody("maximum context length is 65536")).toBe(true);
    expect(sniffContextLengthBody("Prompt 超长")).toBe(true);
    expect(sniffContextLengthBody("rate limited")).toBe(false);
  });

  it("carries the port-contract duck type (name + status + body)", () => {
    const err = new ContextLengthError(413, "payload too large");
    expect(err.name).toBe("ContextLengthError");
    expect(err.status).toBe(413);
    expect(err.body).toBe("payload too large");
    expect(err.message).toContain("413");
  });

  it("the retry ladder never retries a classified overflow (even a 500)", () => {
    expect(isRetryableProviderError(new ContextLengthError(500, "context length exceeded"))).toBe(false);
    expect(isRetryableProviderError(new ContextLengthError(413, ""))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 120-b B2 (Reasonix #10770) — the GLM/vLLM "input length N exceeds the
// maximum length M" family. The hole: the wording carries NO "context length"
// vocabulary, so every pinned signature missed it and the 400 surfaced as a
// generic "Malformed request" — the reactive compact layer never ran. The
// strictness invariant comes verbatim from Reasonix: the input figure must
// EXCEED the maximum; equal or smaller pairs stay unclassified/OPAQUE.
// ---------------------------------------------------------------------------

describe("GLM/vLLM input-length spelling (120-b B2)", () => {
  it("matches the field variants (Reasonix verbatim, trailing period, context spelling, JSON-wrapped, uppercase)", () => {
    // Reasonix #10770 verbatim (400): 1048826 > 1048566 by 260 tokens.
    expect(matchContextLimitInputLength("Input length 1048826 exceeds the maximum length 1048566"))
      .toEqual({ inputTokens: 1048826, maximumLength: 1048566 });
    // The task-pinned variant with a trailing period.
    expect(matchContextLimitInputLength("Input length 12345 exceeds the maximum length 8192."))
      .toEqual({ inputTokens: 12345, maximumLength: 8192 });
    // The "maximum context length" spelling, lowercase.
    expect(matchContextLimitInputLength("input length 50000 exceeds the maximum context length 32768"))
      .toEqual({ inputTokens: 50000, maximumLength: 32768 });
    // JSON-wrapped (error.message envelope), with trailing prose.
    expect(matchContextLimitInputLength('{"error":{"message":"Input length 12345 exceeds the maximum length 8192. Please reduce the input.","type":"invalid_request_error"}}'))
      .toEqual({ inputTokens: 12345, maximumLength: 8192 });
    // Case-insensitive across the whole spelling.
    expect(matchContextLimitInputLength("INPUT LENGTH 12345 EXCEEDS THE MAXIMUM LENGTH 8192"))
      .toEqual({ inputTokens: 12345, maximumLength: 8192 });
  });

  it("near-misses stay unclassified: numberless, equal, inverted", () => {
    // Numberless — must NOT hit the new signature (nothing here hits the
    // pinned vocabulary either, so the 400 stays a plain 400).
    expect(matchContextLimitInputLength("Input length is too long")).toBeUndefined();
    expect(sniffContextLengthBody("Input length is too long")).toBe(false);
    // Strictness invariant: N must EXCEED M — equal and smaller stay OPAQUE
    // even though the words say "exceeds".
    expect(matchContextLimitInputLength("Input length 8192 exceeds the maximum length 8192")).toBeUndefined();
    expect(matchContextLimitInputLength("Input length 100 exceeds the maximum length 8192")).toBeUndefined();
    expect(sniffContextLengthBody("Input length 8192 exceeds the maximum length 8192")).toBe(false);
    // One number only is not the pair.
    expect(matchContextLimitInputLength("Input length 12345 is too long")).toBeUndefined();
    expect(matchContextLimitInputLength("the maximum length 8192 was exceeded")).toBeUndefined();
  });

  it("generate: a 400 with the GLM/vLLM body becomes ContextLengthError with the observed pair, no ladder retries", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(400, { error: { message: "Input length 12345 exceeds the maximum length 8192." } });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} } },
    );
    // vLLM's input figure counts prompt tokens only — it IS the observation,
    // regardless of any completion cap the request carried.
    await expect(model.generate(INPUT)).rejects.toMatchObject({
      name: "ContextLengthError",
      status: 400,
      observed: { promptTokens: 12345, windowTokens: 8192 },
    });
    expect(calls).toBe(1);
  });

  it("generate: an equal-pair body worded like an overflow stays a plain ProviderHttpError", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(400, { error: { message: "Input length 8192 exceeds the maximum length 8192" } });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ProviderHttpError", status: 400 });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Provider behavior — classify at the HTTP boundary, no ladder retries
// ---------------------------------------------------------------------------


const jsonRes = (status: number, body: unknown): Response =>
  ({ ok: status === 200, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) }) as unknown as Response;

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("provider context-length behavior (M58 §A)", () => {
  it("generate: a 500 whose body matches the vocabulary becomes ContextLengthError and is NOT retried", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(500, { error: { message: "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens." } });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 3, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ContextLengthError" });
    // One fetch total — the ladder skipped the class entirely (a 500 without
    // the vocabulary would have retried).
    expect(calls).toBe(1);
  });

  it("generate: a plain 413 classifies with any body", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(413, "payload too large");
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ContextLengthError", status: 413 });
    expect(calls).toBe(1);
  });

  it("generate: a 400 WITHOUT the vocabulary keeps the ProviderHttpError semantics (no retry, plain 400)", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(400, { error: { message: "invalid model" } });
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    await expect(model.generate(INPUT)).rejects.toMatchObject({ name: "ProviderHttpError", status: 400 });
    expect(calls).toBe(1);
  });

  it("stream: a 413 on the streaming path becomes ContextLengthError too", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return jsonRes(413, "This model's maximum context length is 8192 tokens.");
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 2, baseDelayMs: 1, sleep: async () => {} } },
    );
    const gen = model.stream!(INPUT);
    await expect(gen.next()).rejects.toMatchObject({ name: "ContextLengthError" });
    expect(calls).toBe(1);
  });

  it("the thrown error satisfies the core port duck type", async () => {
    const fetch = (async () => jsonRes(413, "payload too large")) as typeof fetch;
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m" },
      { fetch, retry: { maxRetries: 0 } },
    );
    const err = await model.generate(INPUT).catch((e: unknown) => e);
    // The recognizer core owns keys on `name` alone (no shared class import).
    expect(err instanceof Error && err.name === "ContextLengthError").toBe(true);
    expect((err as ContextLengthError).status).toBe(413);
  });
});
