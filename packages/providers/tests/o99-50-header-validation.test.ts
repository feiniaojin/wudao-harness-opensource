// packages/providers/tests/o99-50-header-validation.test.ts
// ω99-50 — provider 自定义 header 的加载期/保存期校验（dsh 候选 9 形 + wudao 裁定）。
// 验收映射（brief §2）：
//   §2.1 坏 header 载入期拒 → "load-time named rejection"（fetch 零调用）
//   §2.2 好 header 零变化   → "byte parity"（对拍 init.headers：auth 前、persona 后）
//   §2.4 保留名警告         → "reserved-credential warning"（stderr 一进程恰一行，行为零变化）
//   §2.5 5 触点全覆盖       → openai generate+stream / anthropic generate+stream / responses generate
//   §2.3 schema 面          → "schema face"（工作区 JSON 加载红；savePersonaDefinition 同校验器）
//   providers 卡片保存期面  → cli 包 provider-registry-ops.test.ts（settingsSaveProvider）
// 零真网络：所有 fetch 均为捕获桩。
import { describe, it, expect, vi, afterEach } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createResponsesProvider } from "../src/responses.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import { validatePersonaDefinition } from "../src/persona/schema.js";
import type { PersonaDefinition } from "../src/persona/types.js";

const NL = "\n";
const cfg = { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "deepseek" };
const INPUT = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hi" }],
  tools: [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {} } }],
};

/** 同一张坏/好 header 表铺满三个协议——每个 adapter 各自的 wire 都要过同一校验。 */
function personaOf(id: string, headers: Record<string, string>): PersonaDefinition {
  return {
    id, displayName: id,
    source: { kind: "workspace-source", provenance: "test", pinnedVersion: "1" },
    headers: { "openai-chat": headers, anthropic: headers, responses: headers },
  };
}

function capturingFetch(cap: Array<{ url: string; init: RequestInit }>, res: () => unknown): typeof fetch {
  return (async (url: any, init: any) => {
    cap.push({ url, init });
    return { ok: true, status: 200, json: async () => res() };
  }) as typeof fetch;
}
const openaiOk = () => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
const anthropicOk = () => ({ content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } });
const responsesOk = () => ({ output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }], usage: { input_tokens: 1, output_tokens: 1 } });

async function drainStream(model: { stream?: (i: unknown) => AsyncIterable<unknown> }, input: unknown): Promise<void> {
  for await (const _ev of model.stream!(input)) void _ev;
}

afterEach(() => { vi.restoreAllMocks(); });

describe("ω99-50 §2.1/§2.5 load-time named rejection (fetch never reached)", () => {
  const shapes: Array<[string, Record<string, string>, RegExp]> = [
    ["newline value", { "x-bad": `a${NL}b` }, /provider "deepseek".*header "x-bad" cannot be sent[\s\S]*invalid header value/],
    ["illegal field name", { "x bad": "v" }, /provider "deepseek".*header "x bad" cannot be sent.*invalid header name/],
    ["non-byte (CJK) value", { "x-bad": "你好" }, /provider "deepseek".*header "x-bad" cannot be sent.*ByteString/],
  ];
  for (const [label, headers, errRe] of shapes) {
    it(`openai generate: ${label}`, async () => {
      const rt = createPersonaRuntime(resolvePersona(personaOf("bad-hdr", headers)));
      const fetchMustNotRun = vi.fn(() => { throw new Error("fetch must not be reached"); });
      const model = createOpenAICompatibleProvider(cfg as any, { fetch: fetchMustNotRun as any, personaRuntime: rt });
      await expect(model.generate(INPUT as any)).rejects.toThrow(errRe);
      expect(fetchMustNotRun).not.toHaveBeenCalled();
    });
  }
  it("openai stream (2nd touchpoint): newline value → same named throw", async () => {
    const rt = createPersonaRuntime(resolvePersona(personaOf("bad-hdr", { "x-bad": `a${NL}b` })));
    const fetchMustNotRun = vi.fn(() => { throw new Error("fetch must not be reached"); });
    const model = createOpenAICompatibleProvider(cfg as any, { fetch: fetchMustNotRun as any, personaRuntime: rt });
    await expect(drainStream(model, INPUT)).rejects.toThrow(/header "x-bad" cannot be sent/);
    expect(fetchMustNotRun).not.toHaveBeenCalled();
  });
  it("anthropic generate + stream (touchpoints 3/4): newline value → named throw naming the wire", async () => {
    const rt = createPersonaRuntime(resolvePersona(personaOf("bad-hdr", { "x-bad": `a${NL}b` })));
    const fetchMustNotRun = vi.fn(() => { throw new Error("fetch must not be reached"); });
    const g = createAnthropicProvider(cfg as any, { fetch: fetchMustNotRun as any, personaRuntime: rt });
    await expect(g.generate(INPUT as any)).rejects.toThrow(/provider "deepseek".*header "x-bad" cannot be sent/);
    await expect(drainStream(g, INPUT)).rejects.toThrow(/header "x-bad" cannot be sent/);
    expect(fetchMustNotRun).not.toHaveBeenCalled();
  });
  it("responses generate (5th touchpoint): illegal field name → named throw", async () => {
    const rt = createPersonaRuntime(resolvePersona(personaOf("bad-hdr", { "x bad": "v" })));
    const fetchMustNotRun = vi.fn(() => { throw new Error("fetch must not be reached"); });
    const model = createResponsesProvider(cfg as any, { fetch: fetchMustNotRun as any, personaRuntime: rt });
    await expect(model.generate(INPUT as any)).rejects.toThrow(/provider "deepseek".*header "x bad" cannot be sent/);
    expect(fetchMustNotRun).not.toHaveBeenCalled();
  });
});

describe("ω99-50 §2.2 byte parity — valid headers ride unchanged", () => {
  const good = personaOf("good", { "x-app": "wudao-test", "x-token": "t0" });
  it("openai: persona keys append after auth; base bytes identical to the no-persona capture", async () => {
    const base: Array<{ url: string; init: RequestInit }> = [];
    const withP: Array<{ url: string; init: RequestInit }> = [];
    await createOpenAICompatibleProvider(cfg as any, { fetch: capturingFetch(base, openaiOk) as any }).generate(INPUT as any);
    await createOpenAICompatibleProvider(cfg as any, { fetch: capturingFetch(withP, openaiOk) as any, personaRuntime: createPersonaRuntime(resolvePersona(good)) }).generate(INPUT as any);
    expect(withP[0].init.body).toBe(base[0].init.body);
    expect(Object.keys(withP[0].init.headers as object)).toEqual([...Object.keys(base[0].init.headers as object), "x-app", "x-token"]);
    expect((withP[0].init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });
  it("anthropic: x-api-key/anthropic-version stay ahead of persona keys; body identical", async () => {
    const base: Array<{ url: string; init: RequestInit }> = [];
    const withP: Array<{ url: string; init: RequestInit }> = [];
    await createAnthropicProvider(cfg as any, { fetch: capturingFetch(base, anthropicOk) as any }).generate(INPUT as any);
    await createAnthropicProvider(cfg as any, { fetch: capturingFetch(withP, anthropicOk) as any, personaRuntime: createPersonaRuntime(resolvePersona(good)) }).generate(INPUT as any);
    expect(withP[0].init.body).toBe(base[0].init.body);
    expect(Object.keys(withP[0].init.headers as object)).toEqual([...Object.keys(base[0].init.headers as object), "x-app", "x-token"]);
  });
  it("responses: authorization stays ahead of persona keys; body identical", async () => {
    const base: Array<{ url: string; init: RequestInit }> = [];
    const withP: Array<{ url: string; init: RequestInit }> = [];
    await createResponsesProvider(cfg as any, { fetch: capturingFetch(base, responsesOk) as any }).generate(INPUT as any);
    await createResponsesProvider(cfg as any, { fetch: capturingFetch(withP, responsesOk) as any, personaRuntime: createPersonaRuntime(resolvePersona(good)) }).generate(INPUT as any);
    expect(withP[0].init.body).toBe(base[0].init.body);
    expect(Object.keys(withP[0].init.headers as object)).toEqual([...Object.keys(base[0].init.headers as object), "x-app", "x-token"]);
  });
});

describe("ω99-50 §2.4 reserved-credential header warning (visibility only — drop is the status quo)", () => {
  it("authorization in persona headers → exactly one stderr line per process; key-pool auth still rides intact", async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cap: Array<{ url: string; init: RequestInit }> = [];
    const rt = mod.createPersonaRuntime(mod.resolvePersona(personaOf("auth-p", { authorization: "Bearer gateway-token" })));
    const model = mod.createOpenAICompatibleProvider(cfg as any, { fetch: capturingFetch(cap, openaiOk) as any, personaRuntime: rt });
    await model.generate(INPUT as any);
    await model.generate(INPUT as any); // 同进程第二次：不再警告
    const lines = err.mock.calls.map((c) => String(c[0])).filter((s) => s.includes("authorization"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatch(/provider "deepseek"/);
    expect(lines[0]).toMatch(/authorization/);
    expect(lines[0]).toMatch(/ignored/);
    expect((cap[0].init.headers as Record<string, string>)["authorization"]).toBe("Bearer k"); // 覆盖未发生（现状：跳过）——行为零变化
    expect((cap[1].init.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
  });
  it("no reserved names → zero stderr output, request unaffected", async () => {
    vi.resetModules();
    const mod = await import("../src/index.js");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const cap: Array<{ url: string; init: RequestInit }> = [];
    const rt = mod.createPersonaRuntime(mod.resolvePersona(personaOf("clean", { "x-app": "ok" })));
    const model = mod.createOpenAICompatibleProvider(cfg as any, { fetch: capturingFetch(cap, openaiOk) as any, personaRuntime: rt });
    await model.generate(INPUT as any);
    expect(err).not.toHaveBeenCalled();
    expect((cap[0].init.headers as Record<string, string>)["x-app"]).toBe("ok");
  });
});

describe("ω99-50 §2.3 schema face — workspace load red (persona save rides the same validator)", () => {
  it("newline value → named schema error", () => {
    const v = validatePersonaDefinition(personaOf("bad-nl", { "x-bad": `a${NL}b` }) as unknown);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/x-bad.*cannot ride the wire/);
  });
  it("illegal field name → named schema error", () => {
    const v = validatePersonaDefinition(personaOf("bad-name", { "x bad": "v" }) as unknown);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/x bad.*cannot ride the wire/);
  });
});
