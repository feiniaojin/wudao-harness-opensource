// ω99-46 — provider egress acceptance (brief §2.2 provider arm): a provider
// built with NO injected fetch (the production default — `options.fetch ??
// fetch`) routes through the globally installed egress dispatcher, and a
// proxy-side failure fails fast with the typed attribution in the cause
// chain. The stub factory is the SAME one the core egress suites use
// (tests/helpers/egress-stub.ts there — the shared §1.6 base).
import { afterEach, describe, expect, it } from "vitest";
import { installEgressProxy, findProxyEgressCause, ProxyEgressError, resolveEgressPolicy } from "@wudao/core";
import { createOpenAICompatibleProvider, isRetryableProviderError } from "../src/openai-compatible.js";
import { startHttpProxyStub } from "../../core/tests/helpers/egress-stub.js";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop!()?.();
});

const CHAT_COMPLETION = {
  id: "chatcmpl-stub",
  object: "chat.completion",
  created: 1_700_000_000,
  model: "stub-model",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "PROXYED-HELLO", reasoning_content: "thinking via proxy" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
};

describe("provider default-fetch egress (§2.2)", () => {
  it("a provider request with NO injected fetch goes through the installed proxy stub and parses", async () => {
    const stub = await startHttpProxyStub();
    stub.responseBody = JSON.stringify(CHAT_COMPLETION);
    stub.appendUrl = false;
    const r = await installEgressProxy(
      resolveEgressPolicy(
        { HTTP_PROXY: `http://127.0.0.1:${stub.port}` },
      ),
    );
    disposers.push(r.dispose);

    const provider = createOpenAICompatibleProvider({
      provider: "openai-compatible",
      baseURL: "http://example.test/v1",
      apiKey: "sk-stub",
      model: "stub-model",
    });
    const message = await provider.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
    expect(message.content).toBe("PROXYED-HELLO");
    expect(message.reasoning).toBe("thinking via proxy");
    // The provider's POST reached the proxy in absolute-URI form.
    expect(stub.requests).toEqual(["POST http://example.test/v1/chat/completions"]);
    await stub.close();
  });

  it("a dead proxy fails fast: one attempt, ProxyEgressError in the cause chain (§2.6/§1.5)", async () => {
    const stub = await startHttpProxyStub();
    const port = stub.port;
    await stub.close(); // deterministic ECONNREFUSED to the proxy
    const r = await installEgressProxy(
      resolveEgressPolicy({ HTTP_PROXY: `http://127.0.0.1:${port}` }),
    );
    disposers.push(r.dispose);

    const provider = createOpenAICompatibleProvider({
      provider: "openai-compatible",
      baseURL: "http://example.test/v1",
      apiKey: "sk-stub",
      model: "stub-model",
    });
    const startedAt = Date.now();
    await expect(provider.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] })).rejects.toThrow();
    // Fail fast: the ladder did not burn its backoff slots (4 retries ×
    // growing waits would take seconds).
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    const err = await provider.generate({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] }).then(
      () => undefined,
      (e: unknown) => e,
    );
    const attributed = findProxyEgressCause(err);
    expect(attributed).toBeInstanceOf(ProxyEgressError);
    expect(attributed?.stage).toBe("unreachable");
    expect(attributed?.message).toContain(`127.0.0.1:${port}`);
  });
});

describe("retry classification recognizes the typed egress failure", () => {
  it("a ProxyEgressError (top-level or in the cause chain) is NOT retryable; ordinary transport still is", () => {
    const attributed = new ProxyEgressError("unreachable", "http://p:1", new Error("ECONNREFUSED"));
    expect(isRetryableProviderError(attributed)).toBe(false);
    const wrapped = new TypeError("fetch failed", { cause: new Error("wrap", { cause: attributed }) });
    expect(isRetryableProviderError(wrapped)).toBe(false);
    expect(isRetryableProviderError(new TypeError("fetch failed", { cause: new Error("socket hang up") }))).toBe(true);
  });
});
