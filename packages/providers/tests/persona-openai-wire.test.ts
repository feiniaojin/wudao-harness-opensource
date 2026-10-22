// packages/providers/tests/persona-openai-wire.test.ts
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import { withPersona } from "../src/persona/decorator.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import { BUILTIN_PERSONAS } from "../src/persona/builtins.js";
import type { PersonaDefinition } from "../src/persona/types.js";

const relayPersona: PersonaDefinition = {
  id: "test-relay", displayName: "Relay T",
  source: { kind: "workspace-source", provenance: "test", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-app": "wudao-test/{{sessionId}}", "x-when": "{{iso8601}}" } },
  body: { "openai-chat": { temperature: 0.123, reasoning: { effort: "high" } } },
};
const seeded = { sessionId: "s1", uuid: () => "u1", now: () => new Date("2026-08-23T00:00:00.000Z") };
const cfg = { apiKey: "k", baseURL: "https://x/v1", model: "m" };

function capturingFetch(captured: { url: string; init: RequestInit }[]): typeof fetch {
  return (async (url: any, init: any) => {
    captured.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  }) as typeof fetch;
}
const INPUT = {
  systemPrompt: "sys", messages: [{ role: "user", content: "hi" }] as const,
  tools: [{ name: "read_file", description: "d", parameters: { type: "object" as const, properties: {} } }],
};

describe("openai-compatible persona injection", () => {
  it("injects persona headers after auth and overlays whitelisted body keys (generate)", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(relayPersona), seeded);
    const model = createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(cap), personaRuntime: rt });
    await model.generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["authorization"]).toBe("Bearer k");
    expect(h["x-app"]).toBe("wudao-test/s1");
    expect(h["x-when"]).toBe("2026-08-23T00:00:00.000Z");
    const body = JSON.parse(cap[0].init.body as string);
    expect(body.temperature).toBe(0.123);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.model).toBe("m"); // base 键不受影响
  });
  it("undefined protocol for this persona (CC@openai-chat) = byte-identical request", async () => {
    const base: { url: string; init: RequestInit }[] = [];
    const pers: { url: string; init: RequestInit }[] = [];
    const cc = BUILTIN_PERSONAS.find((p) => p.id === "anthropic-cli");
    const rt = createPersonaRuntime(resolvePersona(cc!), seeded);
    await createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(base) }).generate(INPUT as any);
    await createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(pers), personaRuntime: rt }).generate(INPUT as any);
    expect(pers[0].init.body).toBe(base[0].init.body);
    expect(pers[0].init.headers).toEqual(base[0].init.headers);
  });
  // spec §10.1 (pinned by persona-schema.test.ts:79-95): an explicit override is
  // the COMPLETE enable set — {body:true} means only-body (headers off, body on),
  // NOT a per-key partial. {headers:false} alone would mask every layer off.
  it("body-only layer mask: no headers, body overlay still applied", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(relayPersona, { body: true }), seeded);
    await createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(cap), personaRuntime: rt }).generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-app"]).toBeUndefined();
    expect(JSON.parse(cap[0].init.body as string).temperature).toBe(0.123);
  });
  it("all-layers-off mask = baseline request", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(relayPersona, { headers: false, body: false, prompt: false }), seeded);
    await createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(cap), personaRuntime: rt }).generate(INPUT as any);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-app"]).toBeUndefined();
    expect(JSON.parse(cap[0].init.body as string).temperature).toBeUndefined();
  });
  it("stream path gets the same injection", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const sse = (async () => ({
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`));
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
          c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
    })) as unknown as typeof fetch;
    const rt = createPersonaRuntime(resolvePersona(relayPersona), seeded);
    const model = createOpenAICompatibleProvider(cfg, { fetch: (async (url: any, init: any) => { cap.push({ url, init }); return sse(); }) as typeof fetch, personaRuntime: rt });
    const events = [];
    for await (const ev of model.stream!(INPUT as any)) events.push(ev);
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-app"]).toBe("wudao-test/s1");
    expect(JSON.parse(cap[0].init.body as string).temperature).toBe(0.123);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  // -------------------------------------------------------------------------
  // SDD 2026-08-23 persona Task 3 — the null-current byte-identity pin.
  //
  // The TUI/session-engine construction seams wrap EVERY client in
  // withPersona(..., runtime) and pass the same runtime as the provider's
  // personaRuntime option — including the boot client, whose runtime.current
  // is null until the (async) registry load resolves. This pin asserts the
  // exact production shape at runtime.current === null: the wrapped client's
  // request bytes (url, method, headers, body) are IDENTICAL to the bare
  // client's, on both the generate and the stream path. If either layer ever
  // grows a null-current side effect (a default header, a body key, a JSON
  // formatting drift), this goes red before any cli wiring test can mask it.
  // -------------------------------------------------------------------------
  it("Task 3 pin: runtime.current === null — withPersona-wrapped client (personaRuntime wired) is byte-identical to the bare client (generate)", async () => {
    const base: { url: string; init: RequestInit }[] = [];
    const pers: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(null, seeded); // explicit null current — the boot shape
    await createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(base) }).generate(INPUT as any);
    await withPersona(
      createOpenAICompatibleProvider(cfg, { fetch: capturingFetch(pers), personaRuntime: rt }),
      rt,
    ).generate(INPUT as any);
    expect(pers[0].url).toBe(base[0].url);                                  // url byte-identical
    expect(pers[0].init.method).toBe(base[0].init.method);                  // method identical
    expect(pers[0].init.body).toBe(base[0].init.body);                      // body byte-for-byte
    expect(pers[0].init.headers).toEqual(base[0].init.headers);             // header set identical
    // 字节级 headers 断言：排序序列化后逐字节比较（toEqual 只比集合等价，
    // 这里再钉住序列化形态不漂移）。
    const sorted = (h: unknown): string => JSON.stringify(Object.entries(h as Record<string, string>).sort(([a], [b]) => (a < b ? -1 : 1)));
    expect(sorted(pers[0].init.headers)).toBe(sorted(base[0].init.headers));
  });
  it("Task 3 pin: the same null-current identity holds on the stream path", async () => {
    const base: { url: string; init: RequestInit }[] = [];
    const pers: { url: string; init: RequestInit }[] = [];
    const sseFor = (cap: { url: string; init: RequestInit }[]) => (async (url: any, init: any) => {
      cap.push({ url, init });
      return {
        ok: true, status: 200,
        body: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: { content: "hi" } }] })}\n\n`));
            c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: "x", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`));
            c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
      };
    }) as unknown as typeof fetch;
    const rt = createPersonaRuntime(null, seeded);
    const bare = createOpenAICompatibleProvider(cfg, { fetch: sseFor(base) });
    const wrapped = withPersona(createOpenAICompatibleProvider(cfg, { fetch: sseFor(pers), personaRuntime: rt }), rt);
    for await (const _ev of bare.stream!(INPUT as any)) void _ev;
    for await (const _ev of wrapped.stream!(INPUT as any)) void _ev;
    expect(pers[0].url).toBe(base[0].url);
    expect(pers[0].init.body).toBe(base[0].init.body);                      // body byte-for-byte
    expect(pers[0].init.headers).toEqual(base[0].init.headers);
  });
});
