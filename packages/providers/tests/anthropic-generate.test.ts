// packages/providers/tests/anthropic-generate.test.ts
import { describe, it, expect } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import type { PersonaDefinition } from "../src/persona/types.js";
import { ProviderHttpError, ContextLengthError } from "../src/openai-compatible.js";
import { createKeyPool, type KeyPool } from "../src/key-pool.js";

const cfg = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const ccPersona: PersonaDefinition = {
  id: "cc-test", displayName: "the upstream format",
  source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
  headers: { anthropic: { "anthropic-version": "2023-06-01", "user-agent": "wudao-harness/0.4.14 (external, cli)", "x-when": "{{iso8601}}" } },
  body: { anthropic: { max_tokens: 777, thinking: { type: "enabled", budget_tokens: 2048 } } },
};
const seeded = { sessionId: "s1", uuid: () => "u1", now: () => new Date("2026-08-23T00:00:00.000Z") };
const INPUT = {
  systemPrompt: "be brief",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: "", toolCalls: [{ id: "tu_1", name: "read_file", arguments: { path: "a" } }] },
    { role: "tool", toolCallId: "tu_1", name: "read_file", content: "file body", isError: false },
  ],
  tools: [{ name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } } } }],
};

function okFetch(payload: unknown, captured: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: any, init: any) => {
    captured.push({ url, init });
    return { ok: true, status: 200, json: async () => payload };
  }) as typeof fetch;
}

describe("anthropic generate — 传输层 abort 归一（基准×探针弧）", () => {
  it("信号未触发的 AbortError（网关零字节切断）→ TruncatedStreamError，梯子重试自愈", async () => {
    // 第一脚：fetch reject AbortError（模拟 GLM 网关建连 ~4s 零字节断开）；
    // 第二脚：正常应答。input.signal 缺席（=用户从未中止）→ 归一为可重试
    // 运输类，梯子重发成功——不再仰赖 loop 级恢复臂。
    let attempt = 0;
    const fetchAbortThenOk: typeof fetch = (async (_url: any, _init: any) => {
      attempt += 1;
      if (attempt === 1) {
        const abortErr = new Error("This operation was aborted");
        abortErr.name = "AbortError";
        throw abortErr;
      }
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "healed" }], stop_reason: "end_turn", usage: { input_tokens: 3, output_tokens: 2 } }) };
    }) as typeof fetch;
    const model = createAnthropicProvider(cfg, { fetch: fetchAbortThenOk });
    const msg = await model.generate({ ...INPUT });
    expect(msg.content).toBe("healed");
    expect(attempt).toBe(2); // 梯子确实重试了（旧分类：AbortError 永不重试→第 1 脚就抛）
  });
  it("用户中止（signal 已触发）的 AbortError 原样透传——永不重试语义不变", async () => {
    let attempt = 0;
    const ac = new AbortController();
    ac.abort(); // 用户真的按了停止——signal 已触发
    const fetchUserAbort: typeof fetch = (async (_url: any, _init: any) => {
      attempt += 1;
      const abortErr = new Error("This operation was aborted");
      abortErr.name = "AbortError";
      throw abortErr;
    }) as typeof fetch;
    const model = createAnthropicProvider(cfg, { fetch: fetchUserAbort });
    await expect(model.generate({ ...INPUT, signal: ac.signal })).rejects.toThrow(/aborted/i);
    expect(attempt).toBe(1); // 不重试——用户中止语义保持
  });
});

describe("anthropic generate", () => {
  it("posts x-api-key + version headers, persona headers/body applied, messages mapped to blocks", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(ccPersona), seeded);
    const model = createAnthropicProvider(cfg, { fetch: okFetch({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }, cap), personaRuntime: rt });
    await model.generate(INPUT as any);
    expect(cap[0].url).toBe("https://api.anthropic.com/v1/messages");
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["anthropic-version"]).toBe("2023-06-01");
    expect(h["user-agent"]).toBe("wudao-harness/0.4.14 (external, cli)");
    expect(h["x-when"]).toBe("2026-08-23T00:00:00.000Z");
    expect(h["authorization"]).toBeUndefined();
    const body = JSON.parse(cap[0].init.body as string);
    expect(body.system).toBe("be brief");
    expect(body.max_tokens).toBe(777); // persona body 覆写
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.tools[0]).toEqual({ name: "read_file", description: "d", input_schema: body.tools[0].input_schema });
    // 消息映射：assistant tool_use → 块；tool 结果 → user 角色 tool_result 块
    expect(body.messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a" } });
    expect(body.messages[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file body", is_error: false }] });
  });
  it("bearerAuth config (coding-plan gateways) dual-sends authorization: Bearer alongside x-api-key", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const model = createAnthropicProvider({ ...cfg, bearerAuth: true }, { fetch: okFetch({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }, cap) });
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["authorization"]).toBe("Bearer sk-an");
  });
  it("baseURL already ending in /v1 posts /v1/messages without doubling", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const model = createAnthropicProvider({ ...cfg, baseURL: "https://relay.example/v1" }, { fetch: okFetch({ content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, cap) });
    await model.generate({ systemPrompt: "s", messages: [{ role: "user", content: "x" }], tools: [] });
    expect(cap[0].url).toBe("https://relay.example/v1/messages");
  });
  it("parses text + tool_use + thinking blocks into AssistantMessage (stop_reason translated)", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const usages: any[] = [];
    const payload = {
      content: [
        { type: "thinking", thinking: "pondering" },
        { type: "text", text: "answer" },
        { type: "tool_use", id: "tu_9", name: "read_file", input: { path: "b" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 60 },
    };
    const model = createAnthropicProvider(cfg, { fetch: okFetch(payload, cap) });
    const msg = await model.generate({ ...INPUT, onUsage: (u: any) => usages.push(u) });
    expect(msg.content).toBe("answer");
    expect(msg.reasoning).toBe("pondering");
    expect(msg.toolCalls).toEqual([{ id: "tu_9", name: "read_file", arguments: { path: "b" } }]);
    expect(msg.stopReason).toBe("tool_calls"); // end_turn→stop, tool_use→tool_calls, max_tokens→length
    // 基准×探针弧随源演进：三分记账——promptTokens= input+creation+read
    // 总账单（fixture: 100+0+60=160），hit=read，miss=总-hit（=100）。
    expect(usages[0]).toMatchObject({ promptTokens: 160, cacheHitTokens: 60, cacheMissTokens: 100, completionTokens: 40 });
  });
  it("429 marks key cooldown and surfaces ProviderHttpError with status", async () => {
    const fail: typeof fetch = (async () => ({ ok: false, status: 429, text: async () => '{"type":"error","error":{"type":"rate_limit_error"}}' })) as typeof fetch;
    const pool = createKeyPool(["key1", "key2"]);
    // retry ladder off: this pins the SINGLE-ATTEMPT error path (cooldown +
    // classification); the ladder's own 429 retries live in anthropic-hardening.test.ts.
    const model = createAnthropicProvider(cfg, { fetch: fail, keyPool: pool, retry: { maxRetries: 0 } });
    const errorPromise = model.generate(INPUT as any);
    await expect(errorPromise).rejects.toThrow(ProviderHttpError);
    await expect(errorPromise).rejects.toMatchObject({ status: 429 });
    // Cooldown mark should have been called: snapshot should show 1 cooling key
    expect(pool.snapshot().cooling).toBe(1);
  });
  it("413 and prompt too long throw ContextLengthError for compact-once-retry", async () => {
    // Test 413 status
    const fail413: typeof fetch = (async () => ({ ok: false, status: 413, text: async () => "payload too large" })) as typeof fetch;
    const model413 = createAnthropicProvider(cfg, { fetch: fail413 });
    await expect(model413.generate(INPUT as any)).rejects.toThrow(ContextLengthError);
    await expect(model413.generate(INPUT as any)).rejects.toMatchObject({ name: "ContextLengthError", status: 413 });

    // Test 400 with "prompt too long" body
    const failBody: typeof fetch = (async () => ({ ok: false, status: 400, text: async () => "This model's maximum context length is 65536 tokens. However, you requested 109645 tokens." })) as typeof fetch;
    const modelBody = createAnthropicProvider(cfg, { fetch: failBody });
    await expect(modelBody.generate(INPUT as any)).rejects.toThrow(ContextLengthError);
    await expect(modelBody.generate(INPUT as any)).rejects.toMatchObject({ name: "ContextLengthError", status: 400 });
  });
});
