// v7 借鉴弧 γ4（digest-a 候选 3 搭车件，源 pi 0c7bb7c5c「identify
// Responses error providers」）——ProviderHttpError 的 provider/model 身份
// RED 件：多 provider 一张 OpenAI 兼容面，泛型「provider request failed:
// 500 …」把多家混成一族指纹。钉：结构化字段落位、消息尾的身份（钉前缀
// 逐字节不动——锚定正则消费者照常）、无身份构造的字节等价（omit-never-
// null）、retry 分类不受身份干扰、adapter 真错误路径带身份（anthropic
// 429 一例，openai-engine/responses 同一构造器参数面）。
import { describe, it, expect } from "vitest";
import { ProviderHttpError } from "../src/model-failure.js";
import { isRetryableProviderError } from "../src/retry-ladder.js";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createKeyPool } from "../src/key-pool.js";

describe("v7 γ4 纯构造——身份字段与消息尾", () => {
  it("带身份：provider/model 落结构化字段；消息尾追加 provider（前缀逐字节不动）", () => {
    const e = new ProviderHttpError("request", 500, "boom", undefined, { provider: "deepseek", model: "deepseek-v4" });
    expect(e.provider).toBe("deepseek");
    expect(e.model).toBe("deepseek-v4");
    expect(e.message).toBe("provider request failed: 500 boom — deepseek");
    expect(e.message.startsWith("provider request failed: 500 ")).toBe(true); // 锚定前缀消费面（retryReason/isRetryable 的 ^provider…: (\d{3})）
  });
  it("无身份：消息与实例形状字节等价（键整缺席，非 null）", () => {
    const legacy = new ProviderHttpError("request", 429, "limited");
    expect(legacy.message).toBe("provider request failed: 429 limited");
    expect("provider" in legacy).toBe(false);
    expect("model" in legacy).toBe(false);
    expect(JSON.stringify({ status: legacy.status, body: legacy.body })).toBe('{"status":429,"body":"limited"}');
  });
  it("空串 provider 视同无身份（不产「— 」空尾）", () => {
    const e = new ProviderHttpError("stream", 502, "bad gateway", 1_000, { provider: "", model: "m" });
    expect(e.message).toBe("provider stream failed: 502 bad gateway");
    expect(e.provider).toBeUndefined();
    expect(e.model).toBe("m"); // model 照落（腿身份的一半也是身份）
  });
});

describe("v7 γ4 分类兼容——身份不扰 retry/fallback 判定", () => {
  it("isRetryableProviderError：带身份的 500/429 照旧可重试，401/403 照旧不可", () => {
    const id = { provider: "glm", model: "glm-5.3" };
    expect(isRetryableProviderError(new ProviderHttpError("request", 500, "boom", undefined, id))).toBe(true);
    expect(isRetryableProviderError(new ProviderHttpError("stream", 429, "rate limited", 500, id))).toBe(true);
    expect(isRetryableProviderError(new ProviderHttpError("request", 401, "no key", undefined, id))).toBe(false);
  });
  it("身份尾不伪造 529（mentions 兜面——provider 名不含数字）", () => {
    const e = new ProviderHttpError("request", 500, "upstream error", undefined, { provider: "deepseek" });
    expect(isRetryableProviderError(e)).toBe(true); // 若尾被误读成 529 语义会改变分类——钉住现状
  });
});

describe("v7 γ4 adapter 错误路径——真构造点带身份（anthropic 例）", () => {
  const INPUT = {
    systemPrompt: "s",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };
  it("429 错误携带 config 的 provider/model（结构化 + 消息尾）", async () => {
    const fail: typeof fetch = (async () => ({ ok: false, status: 429, text: async () => '{"type":"error","error":{"type":"rate_limit_error"}}' })) as typeof fetch;
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5", provider: "wudao" },
      { fetch: fail, keyPool: createKeyPool(["key1"]), retry: { maxRetries: 0 } },
    );
    const caught = await model.generate(INPUT as never).catch((e: unknown) => e as ProviderHttpError);
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect((caught as ProviderHttpError).provider).toBe("wudao");
    expect((caught as ProviderHttpError).model).toBe("claude-sonnet-5");
    expect((caught as ProviderHttpError).message.endsWith("— wudao")).toBe(true);
  });
  it("config 无 provider（裸 baseURL 腿）→ 无身份，消息保持泛型旧形（无可归因者不臆造）", async () => {
    const fail: typeof fetch = (async () => ({ ok: false, status: 500, text: async () => "boom" })) as typeof fetch;
    const model = createAnthropicProvider(
      { apiKey: "k", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" },
      { fetch: fail, keyPool: createKeyPool(["key1"]), retry: { maxRetries: 0 } },
    );
    const caught = await model.generate(INPUT as never).catch((e: unknown) => e as ProviderHttpError);
    expect(caught).toBeInstanceOf(ProviderHttpError);
    expect((caught as ProviderHttpError).provider).toBeUndefined();
    expect((caught as ProviderHttpError).message).toBe("provider request failed: 500 boom");
  });
});
