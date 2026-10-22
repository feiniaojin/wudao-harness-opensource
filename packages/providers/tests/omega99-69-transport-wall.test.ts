// ω99-69 — hand-built 面 transport 键全集拦（64 停泊 C1 收口：FORBIDDEN 下沉单源）。
//
// 验收映射（brief §2/§3）：
//  §2.1 单源  —— G0：集合定义唯一下沉 header-validation.ts，persona/schema.ts
//        re-export 保 ABI（同一 Set 对象，registry/apply 的既有 import 面零 diff）。
//  §2.2 跳过集 —— G1：gatewayExtraHeaders 的跳过集 == FORBIDDEN 全集（14 键，
//        大小写不敏感），不再 auth-only。
//  §2.4 行为面 —— G2：hand-built config 带任一 FORBIDDEN transport 键
//        （content-type/host）→ 从"静默覆盖适配器头"变"静默跳过"（wire 上
//        适配器 JSON content-type 赢；host 永不上 wire）。
//  §2.5 零回归 —— G4：auth 键跳过行为不回退（64 E 组语义）；64 的 18 例电池
//        零 diff 零回归（omega99-64-registry-headers-wire.test.ts 不改）。
// RED 设计：G0 经 namespace 访问（base 上 header-validation 无此导出名 →
//        undefined ≠ Set，红而不炸模块加载）；G1-G3 在 base 上 auth-only 跳过
//        集/content-type 覆盖会断言失败。
import { describe, it, expect } from "vitest";
import * as hv from "../src/header-validation.js";
import { FORBIDDEN_HEADER_KEYS as SCHEMA_FORBIDDEN } from "../src/persona/schema.js";
import { createOpenAICompatibleProvider, createAnthropicProvider } from "../src/index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const OAI = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const AN = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };

type Cap = { url: string; init: RequestInit }[];

function okFetch(payload: unknown, cap?: Cap): typeof fetch {
  return (async (url: any, init: any) => {
    cap?.push({ url, init });
    return { ok: true, status: 200, json: async () => payload };
  }) as typeof fetch;
}

function sseFetch(lines: readonly string[], cap?: Cap): typeof fetch {
  return (async (url: any, init: any) => {
    cap?.push({ url, init });
    const body = lines.map((l) => `data: ${l}\n\n`).join("");
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(body)); c.close(); },
      }),
    };
  }) as typeof fetch;
}

const OAI_SSE = [
  JSON.stringify({ choices: [{ delta: { content: "ok" } }] }),
  JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
  JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }),
  "[DONE]",
];

describe("ω99-69 §2.1 G0 — FORBIDDEN single source: sunk into header-validation, schema re-exports it", () => {
  it("header-validation.js exports FORBIDDEN_HEADER_KEYS and it IS schema's Set (re-export, not a copy)", () => {
    const sunk = (hv as any).FORBIDDEN_HEADER_KEYS as ReadonlySet<string> | undefined;
    expect(sunk).toBeDefined();
    expect(sunk).toBe(SCHEMA_FORBIDDEN);
  });
});

describe("ω99-69 §2.2 G1 — the skip set IS the full FORBIDDEN wall (14 keys, case-insensitive)", () => {
  it("gatewayExtraHeaders drops every FORBIDDEN key (mixed case included), passes the rest untouched", () => {
    const extra: Record<string, string> = { "X-Ok": "keep", "x-trace": "t" };
    for (const k of SCHEMA_FORBIDDEN) extra[k === "content-type" ? "Content-Type" : k] = "x";
    expect(hv.gatewayExtraHeaders(extra)).toEqual({ "X-Ok": "keep", "x-trace": "t" });
  });

  it("undefined stays {} and empty {} stays {} (64's F-group byte contract)", () => {
    expect(hv.gatewayExtraHeaders(undefined)).toEqual({});
    expect(hv.gatewayExtraHeaders({})).toEqual({});
  });
});

describe("ω99-69 §2.4 G2 — wire: hand-built transport keys never override the adapter's own", () => {
  it("openai generate: content-type/host skipped — adapter JSON content-type rides, host never lands, X-Gw rides", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "content-type": "text/plain", host: "evil.example", "X-Gw": "a" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["host"]).toBeUndefined();
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["X-Gw"]).toBe("a");
  });

  it("anthropic generate: content-type skipped (application/json intact) and x-api-key stays the key pool's", async () => {
    const cap: Cap = [];
    const model = createAnthropicProvider(
      { ...AN, extraHeaders: { "content-type": "text/csv", "x-api-key": "evil" } },
      { fetch: okFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["x-api-key"]).toBe("sk-an");
  });

  it("openai stream touchpoint: the same skip holds on the streaming path", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "content-type": "text/plain", "X-Gw": "a" } },
      { fetch: sseFetch(OAI_SSE, cap) },
    );
    const evs: unknown[] = [];
    for await (const ev of model.stream!(INPUT as any)) evs.push(ev);
    expect(evs.length).toBeGreaterThan(0);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["content-type"]).toBe("application/json");
    expect(h["X-Gw"]).toBe("a");
  });
});

describe("ω99-69 §2.5 G4 — no regression: the auth-key skip (64's E semantics) still holds", () => {
  it("hand-built authorization: the defensive skip keeps the key pool's auth", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { authorization: "Bearer evil", "X-Gw": "a" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["X-Gw"]).toBe("a");
  });
});
