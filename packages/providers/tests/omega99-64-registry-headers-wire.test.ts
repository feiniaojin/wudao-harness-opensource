// ω99-64 — registry headers 上 wire（50 停泊债收口）。
//
// 验收映射（brief §4）：
//  §4.1 wire 上真到 —— A 组：三协议 fake fetch（anthropic / openai-chat /
//         responses；anthropic 与 openai 各钉 generate+stream 双触点）。
//  §4.2 优先级     —— B 组：persona 覆盖 registry；仅 registry；不同键都发。
//  §4.3 FORBIDDEN  —— D 组：authorization 保存/加载期 fail-visible 拒（typed
//         reason）；E 组：adapter 自持 auth 在 wire 上不被覆盖。
//  §4.4 字节不变   —— F 组：未配置/空 {} 时 header 集与历史逐键相等。
//  折叠链          —— C 组：effectiveProfiles overlay 折叠 +
//         resolveProviderConfigResult 抄送（undefined 透传 undefined）。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenAICompatibleProvider,
  createAnthropicProvider,
  createResponsesProvider,
  effectiveProfiles,
  validateUserProviderEntry,
  readProviderRegistrySync,
  resolveProviderConfigResult,
  type UserProviderConfig,
} from "../src/index.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import type { PersonaDefinition } from "../src/persona/types.js";

/* eslint-disable @typescript-eslint/no-explicit-any */

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
const OAI = { apiKey: "k", baseURL: "https://x/v1", model: "m" };
const AN = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const RS = { apiKey: "sk-oai", baseURL: "https://api.openai.com/v1", model: "gpt-5.3-codex" };

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
const AN_SSE = [
  JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } }),
  JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
  JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }),
  JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }),
  JSON.stringify({ type: "message_stop" }),
];

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "omega99-64-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("ω99-64 §4.1 A — registry headers reach the wire (three protocols, 5 touchpoints)", () => {
  it("openai-chat generate: X-Gw/x-trace ride after Bearer auth; content-type untouched", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "X-Gw": "a", "x-trace": "t1" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["content-type"]).toBe("application/json");
    expect(h["X-Gw"]).toBe("a");
    expect(h["x-trace"]).toBe("t1");
  });

  it("openai-chat stream (touchpoint 2): the streaming path rides them too", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "X-Gw": "a" } },
      { fetch: sseFetch(OAI_SSE, cap) },
    );
    const evs: unknown[] = [];
    for await (const ev of model.stream!(INPUT as any)) evs.push(ev);
    expect(evs.length).toBeGreaterThan(0);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["X-Gw"]).toBe("a");
  });

  it("anthropic generate: X-Gw rides after x-api-key", async () => {
    const cap: Cap = [];
    const model = createAnthropicProvider(
      { ...AN, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["content-type"]).toBe("application/json");
    expect(h["X-Gw"]).toBe("a");
  });

  it("anthropic stream (touchpoint 4): the streaming path rides them too", async () => {
    const cap: Cap = [];
    const model = createAnthropicProvider(
      { ...AN, extraHeaders: { "X-Gw": "a" } },
      { fetch: sseFetch(AN_SSE, cap) },
    );
    const evs: unknown[] = [];
    for await (const ev of model.stream!(INPUT as any)) evs.push(ev);
    expect(evs.length).toBeGreaterThan(0);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["X-Gw"]).toBe("a");
  });

  it("responses (shared post): X-Gw rides after Bearer auth", async () => {
    const cap: Cap = [];
    const model = createResponsesProvider(
      { ...RS, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer sk-oai");
    expect(h["content-type"]).toBe("application/json");
    expect(h["X-Gw"]).toBe("a");
  });
});

describe("ω99-64 §4.2 B — priority: adapter auth > persona wire.headers > registry extraHeaders", () => {
  const seeded = { sessionId: "s1", uuid: () => "u1", now: () => new Date("2026-09-01T00:00:00.000Z") };
  const gwPersona: PersonaDefinition = {
    id: "gw-test", displayName: "GW",
    source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
    headers: { "openai-chat": { "X-Gw": "b" } },
  };
  const diffPersona: PersonaDefinition = { ...gwPersona, headers: { "openai-chat": { "x-who": "persona" } } };

  it("same key in both sources → the persona value wins (b, not a)", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap), personaRuntime: createPersonaRuntime(resolvePersona(gwPersona), seeded) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["X-Gw"]).toBe("b");
    expect(h["authorization"]).toBe("Bearer k");
  });

  it("registry only → the registry value rides (a)", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) },
    );
    await model.generate(INPUT as any);
    expect((cap[0].init.headers as Record<string, string>)["X-Gw"]).toBe("a");
  });

  it("different keys in both sources → both ride (non-conflicting merge)", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap), personaRuntime: createPersonaRuntime(resolvePersona(diffPersona), seeded) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["X-Gw"]).toBe("a");
    expect(h["x-who"]).toBe("persona");
  });
});

describe("ω99-64 §3.2/§3.3 C — the fold: row → EffectiveProfile.headers → config.extraHeaders", () => {
  const profiles = effectiveProfiles(new Map<string, UserProviderConfig>([
    ["deepseek", { headers: { "X-Gw": "a" } }],
    ["my-gw", { baseUrl: "https://gw.example/v1", defaultModel: "m-x", headers: { "x-trace": "t" } }],
  ]));

  it("overlay fold: an overlay's headers ride the EffectiveProfile; bare builtins carry none", () => {
    expect(profiles.get("deepseek")?.headers).toEqual({ "X-Gw": "a" });
    expect(profiles.get("qwen")?.headers).toBeUndefined();
  });

  it("custom fold: a custom row's headers ride its own profile", () => {
    expect(profiles.get("my-gw")?.headers).toEqual({ "x-trace": "t" });
  });

  it("resolve: the selected profile's headers copy onto config.extraHeaders; absent stays undefined", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "deepseek" }, undefined, profiles);
    if (!r.ok) throw new Error("expected ok");
    expect(r.config.extraHeaders).toEqual({ "X-Gw": "a" });
    const bare = resolveProviderConfigResult({ WUDAO_API_KEY: "k" }, { provider: "qwen" }, undefined, profiles);
    if (!bare.ok) throw new Error("expected ok");
    expect(bare.config.extraHeaders).toBeUndefined();
  });
});

describe("ω99-64 §4.3 D — FORBIDDEN keys refuse the row fail-visible (save AND load)", () => {
  it("validate: authorization (any case) / x-api-key / content-type refuse, naming the key", () => {
    const bad: Array<[string, string]> = [
      ["Authorization", "Bearer x"], ["authorization", "Bearer x"],
      ["X-API-KEY", "k"], ["content-type", "text/plain"], ["Host", "evil.example"],
    ];
    for (const [k, v] of bad) {
      const r = validateUserProviderEntry("gw", { baseUrl: "https://gw.example/v1", headers: { [k]: v } });
      expect(r.ok, `key "${k}" must refuse`).toBe(false);
      if (!r.ok) {
        expect(r.reason).toContain("forbidden");
        expect(r.reason).toContain(k.toLowerCase());
      }
    }
  });

  it("validate: a clean map still passes (the guard rejects only the forbidden set)", () => {
    const r = validateUserProviderEntry("gw", { baseUrl: "https://gw.example/v1", headers: { "X-Gw": "a" } });
    expect(r.ok).toBe(true);
  });

  it("load: an on-disk row with Authorization lands in the invalid list, never in entries", () => {
    const file = join(dir, "providers.json");
    writeFileSync(file, JSON.stringify({
      version: 1,
      providers: {
        gw: { baseUrl: "https://gw.example/v1", headers: { Authorization: "Bearer x" } },
        ok2: { baseUrl: "https://ok.example/v1", headers: { "X-Gw": "a" } },
      },
    }));
    const res = readProviderRegistrySync(file);
    expect(res.entries.has("gw")).toBe(false);
    expect(res.invalid.some((i) => i.id === "gw" && i.reason.includes("forbidden"))).toBe(true);
    expect(res.entries.has("ok2")).toBe(true);
  });
});

describe("ω99-64 §4.3 E — adapter-owned auth is never overridden on the wire", () => {
  it("anthropic bearerAuth: a configured row rides alongside intact x-api-key + authorization", async () => {
    const cap: Cap = [];
    const model = createAnthropicProvider(
      { ...AN, bearerAuth: true, extraHeaders: { "X-Gw": "a" } },
      { fetch: okFetch({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, cap) },
    );
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["authorization"]).toBe("Bearer sk-an");
    expect(h["X-Gw"]).toBe("a");
  });

  it("hand-built config naming authorization: the defensive skip keeps the key pool's auth", async () => {
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

describe("ω99-64 §4.4 F — unconfigured = the historical header set, key for key", () => {
  it("openai generate without extraHeaders/persona → exactly {content-type, authorization}", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(OAI, { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) });
    await model.generate(INPUT as any);
    expect(cap[0].init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer k" });
  });

  it("empty {} extraHeaders spreads to nothing (no-op row)", async () => {
    const cap: Cap = [];
    const model = createOpenAICompatibleProvider(
      { ...OAI, extraHeaders: {} },
      { fetch: okFetch({ choices: [{ message: { role: "assistant", content: "ok" } }] }, cap) },
    );
    await model.generate(INPUT as any);
    expect(cap[0].init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer k" });
  });
});
