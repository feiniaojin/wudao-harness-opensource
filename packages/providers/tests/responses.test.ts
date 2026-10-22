// packages/providers/tests/responses.test.ts — OpenAI Responses 协议适配器（spec §5，codex 原生）
import { describe, it, expect } from "vitest";
import { createResponsesProvider } from "../src/responses.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import type { PersonaDefinition } from "../src/persona/types.js";
import { ProviderHttpError, ContextLengthError } from "../src/openai-compatible.js";
import { createKeyPool } from "../src/key-pool.js";

const cfg = { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-codex" };
const codexPersona: PersonaDefinition = {
  id: "codex-test", displayName: "Codex",
  source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
  headers: { responses: { originator: "wudao_harness", session_id: "{{sessionId}}" } },
  body: { responses: { store: false, reasoning: { effort: "high" } } },
};
const seeded = { sessionId: "sess-9", uuid: () => "u1", now: () => new Date("2026-08-23T00:00:00.000Z") };
const INPUT = {
  systemPrompt: "be terse",
  messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: "need file", toolCalls: [{ id: "fc_1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "fc_1", name: "read_file", content: "BODY" },
  ],
  tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: {} } }],
};

function jsonFetch(payload: unknown, captured: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: any, init: any) => { captured.push({ url, init }); return { ok: true, status: 200, json: async () => payload }; }) as typeof fetch;
}
function sseFetch(lines: string[], captured?: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: any, init: any) => {
    captured?.push({ url, init });
    const enc = new TextEncoder();
    return { ok: true, status: 200, body: new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`)); c.close(); } }) };
  }) as typeof fetch;
}
const EV = (o: unknown) => JSON.stringify(o);

describe("responses adapter", () => {
  it("generate: instructions/input items/tools + codex persona headers/body", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(codexPersona), seeded);
    const payload = { output: [
      { type: "reasoning", summary: [{ type: "summary_text", text: "think" }] },
      { type: "message", content: [{ type: "output_text", text: "ok done" }] },
      { type: "function_call", call_id: "fc_2", name: "read_file", arguments: '{"path":"b"}' },
    ], usage: { input_tokens: 20, output_tokens: 6, input_tokens_details: { cached_tokens: 8 } } };
    const model = createResponsesProvider(cfg, { fetch: jsonFetch(payload, cap), personaRuntime: rt });
    const msg = await model.generate(INPUT as any);
    expect(cap[0].url).toBe("https://api.openai.com/v1/responses");
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer sk-oai");
    expect(h["originator"]).toBe("wudao_harness");
    expect(h["session_id"]).toBe("sess-9");
    const body = JSON.parse(cap[0].init.body as string);
    expect(body.instructions).toBe("be terse");
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "read_file" });
    // input items：user 文本、assistant 文本、function_call、function_call_output
    expect(body.input[0]).toEqual({ role: "user", content: "go" });
    expect(body.input[1]).toEqual({ role: "assistant", content: "need file" });
    expect(body.input[2]).toEqual({ type: "function_call", call_id: "fc_1", name: "read_file", arguments: '{"path":"a"}' });
    expect(body.input[3]).toEqual({ type: "function_call_output", call_id: "fc_1", output: "BODY" });
    // 响应解析
    expect(msg.content).toBe("ok done");
    expect(msg.reasoning).toBe("think");
    expect(msg.toolCalls).toEqual([{ id: "fc_2", name: "read_file", arguments: { path: "b" } }]);
    expect(msg.stopReason).toBe("tool_calls");
  });
  it("generate without function calls maps stopReason stop; usage anchor fires", async () => {
    const usages: any[] = [];
    const payload = { output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }], usage: { input_tokens: 5, output_tokens: 2 } };
    const model = createResponsesProvider(cfg, { fetch: jsonFetch(payload, []) });
    const msg = await model.generate({ ...INPUT, onUsage: (u: any) => usages.push(u) });
    expect(msg.stopReason).toBe("stop");
    expect(msg.toolCalls).toBeUndefined();
    expect(usages[0]).toMatchObject({ promptTokens: 5, cacheHitTokens: 0, cacheMissTokens: 5, completionTokens: 2 });
  });
  it("stream: text deltas live, function_call aggregated from output_item.done, done from response.completed", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(codexPersona), seeded);
    const model = createResponsesProvider(cfg, {
      fetch: sseFetch([
        EV({ type: "response.created", response: {} }),
        EV({ type: "response.output_text.delta", delta: "he" }),
        EV({ type: "response.output_text.delta", delta: "y" }),
        EV({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "hey" }] } }),
        EV({ type: "response.output_item.done", item: { type: "function_call", call_id: "fc_3", name: "read_file", arguments: '{"path":"c"}' } }),
        EV({ type: "response.completed", response: { usage: { input_tokens: 9, output_tokens: 3 } } }),
      ], cap),
      personaRuntime: rt,
    });
    const kinds: string[] = [];
    let done: any;
    for await (const ev of model.stream!(INPUT as any)) { kinds.push(ev.type); if (ev.type === "done") done = ev.message; }
    expect(kinds.filter((k) => k === "done").length).toBe(1);
    expect(kinds.slice(0, 2)).toEqual(["text_delta", "text_delta"]);
    expect(done.content).toBe("hey");
    expect(done.toolCalls).toEqual([{ id: "fc_3", name: "read_file", arguments: { path: "c" } }]);
    expect(cap.length).toBe(1);
    expect(JSON.parse(cap[0].init.body as string).stream).toBe(true);
  });
  it("baseURL without /v1 suffix still lands on /v1/responses; non-2xx throws", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const model = createResponsesProvider({ ...cfg, baseURL: "https://relay.example" }, { fetch: jsonFetch({ output: [] }, cap) });
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [] });
    expect(cap[0].url).toBe("https://relay.example/v1/responses");
    const bad: typeof fetch = (async () => ({ ok: false, status: 429, text: async () => '{"error":{"type":"rate_limit"}}' })) as typeof fetch;
    // retry ladder off: single-attempt error path (the ladder lives in responses-hardening.test.ts).
    await expect(createResponsesProvider(cfg, { fetch: bad, retry: { maxRetries: 0 } }).generate(INPUT as any)).rejects.toThrow();
  });
  it("generate: 429 marks key cooldown and surfaces ProviderHttpError with status", async () => {
    const fail: typeof fetch = (async () => ({ ok: false, status: 429, text: async () => '{"error":{"type":"rate_limit"}}' })) as typeof fetch;
    const pool = createKeyPool(["key1", "key2"]);
    // retry ladder off: this pins the SINGLE-ATTEMPT error path (cooldown +
    // classification); the ladder's own 429 retries live in responses-hardening.test.ts.
    const model = createResponsesProvider(cfg, { fetch: fail, keyPool: pool, retry: { maxRetries: 0 } });
    const errorPromise = model.generate(INPUT as any);
    await expect(errorPromise).rejects.toThrow(ProviderHttpError);
    await expect(errorPromise).rejects.toMatchObject({ status: 429 });
    // Cooldown mark should have been called: snapshot should show 1 cooling key
    expect(pool.snapshot().cooling).toBe(1);
  });
  it("generate: 413 and prompt too long throw ContextLengthError for compact-once-retry", async () => {
    const fail413: typeof fetch = (async () => ({ ok: false, status: 413, text: async () => "payload too large" })) as typeof fetch;
    const model413 = createResponsesProvider(cfg, { fetch: fail413 });
    await expect(model413.generate(INPUT as any)).rejects.toThrow(ContextLengthError);
    await expect(model413.generate(INPUT as any)).rejects.toMatchObject({ name: "ContextLengthError", status: 413 });

    const failBody: typeof fetch = (async () => ({ ok: false, status: 400, text: async () => "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens." })) as typeof fetch;
    const modelBody = createResponsesProvider(cfg, { fetch: failBody });
    await expect(modelBody.generate(INPUT as any)).rejects.toThrow(ContextLengthError);
    await expect(modelBody.generate(INPUT as any)).rejects.toMatchObject({ name: "ContextLengthError", status: 400 });
  });
  it("stream: 429 marks key cooldown and surfaces ProviderHttpError with status", async () => {
    const fail: typeof fetch = (async () => ({ ok: false, status: 429, text: async () => '{"error":{"type":"rate_limit"}}' })) as typeof fetch;
    const pool = createKeyPool(["key1", "key2"]);
    // retry ladder off: single-attempt error path (see above).
    const model = createResponsesProvider(cfg, { fetch: fail, keyPool: pool, retry: { maxRetries: 0 } });
    const firstNext = model.stream!(INPUT as any).next();
    await expect(firstNext).rejects.toThrow(ProviderHttpError);
    await expect(firstNext).rejects.toMatchObject({ name: "ProviderHttpError", status: 429 });
    expect(pool.snapshot().cooling).toBe(1);
  });
  it("stream: 413 and prompt too long throw ContextLengthError for compact-once-retry", async () => {
    const fail413: typeof fetch = (async () => ({ ok: false, status: 413, text: async () => "payload too large" })) as typeof fetch;
    const model413 = createResponsesProvider(cfg, { fetch: fail413 });
    await expect(model413.stream!(INPUT as any).next()).rejects.toThrow(ContextLengthError);
    await expect(model413.stream!(INPUT as any).next()).rejects.toMatchObject({ name: "ContextLengthError", status: 413 });

    const failBody: typeof fetch = (async () => ({ ok: false, status: 400, text: async () => "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens." })) as typeof fetch;
    const modelBody = createResponsesProvider(cfg, { fetch: failBody });
    await expect(modelBody.stream!(INPUT as any).next()).rejects.toThrow(ContextLengthError);
    await expect(modelBody.stream!(INPUT as any).next()).rejects.toMatchObject({ name: "ContextLengthError", status: 400 });
  });
});
