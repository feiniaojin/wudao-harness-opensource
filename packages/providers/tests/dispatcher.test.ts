// dispatcher.test.ts — Persona Phase B wire routing (design 93 §4.2-2/3):
// `createProvider(config, options)` is the CLI's single construction seam —
// `switch (config.wire)` over the three protocol adapters, unknown wire
// values throw (the upstream project`apiFor` precedent), and the absent field means the
// historical openai-compatible engine BYTE-IDENTICALLY. Also pins:
//   - the wire resolution chain in resolveProviderConfigResult
//     (selection.wire > env WUDAO_WIRE > absent = openai-chat default),
//   - Phase A hardening still green THROUGH the routed path (429×2 → success
//     ladder + the M58 §B idle watchdog on both non-openai adapters).
import { describe, it, expect } from "vitest";
import { createProvider, resolveProviderConfigResult } from "../src/index.js";
import type { ProviderConfig } from "../src/config.js";
import { StreamIdleError, type RetryObserver } from "../src/openai-compatible.js";

const CFG = { apiKey: "sk-dispatch", baseURL: "https://dispatch.invalid/v1", model: "dispatch-model" } as const;
const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

/** Instant, deterministic ladder knobs (mirror retry.test.ts). */
const INSTANT = { sleep: async (): Promise<void> => {}, random: () => 0.5 } as const;

interface WireCall { readonly url: string; readonly headers: Record<string, string>; readonly body: string }

function recordedRetries(): { onRetry: RetryObserver; log: Array<{ n: number; delayMs: number; reason: string }> } {
  const log: Array<{ n: number; delayMs: number; reason: string }> = [];
  return { onRetry: (n, delayMs, reason) => void log.push({ n, delayMs, reason }), log };
}

/** Capture the request, reply with a non-streaming JSON payload (generate). */
function jsonFetch(payload: unknown, sink: WireCall[]): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    sink.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) }, body: String(init?.body) });
    return { ok: true, status: 200, json: async () => payload } as unknown as Response;
  }) as typeof fetch;
}

const ANTHROPIC_OK = { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" };
const RESPONSES_OK = { output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] };
const OPENAI_OK = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

// ---------------------------------------------------------------------------
// The dispatch table — three routes + the fail-closed default
// ---------------------------------------------------------------------------

describe("createProvider — wire dispatch (Phase B)", () => {
  it("wire absent → the openai-compatible engine (byte-identical default route)", async () => {
    const sink: WireCall[] = [];
    const model = createProvider(CFG, { fetch: jsonFetch(OPENAI_OK, sink) });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(sink[0]?.url).toBe("https://dispatch.invalid/v1/chat/completions");
  });

  it('wire "openai-chat" explicit → the same engine, same endpoint', async () => {
    const sink: WireCall[] = [];
    const model = createProvider({ ...CFG, wire: "openai-chat" }, { fetch: jsonFetch(OPENAI_OK, sink) });
    await model.generate(INPUT);
    expect(sink[0]?.url).toBe("https://dispatch.invalid/v1/chat/completions");
  });

  it('wire "anthropic" → the anthropic adapter: /messages + anthropic request shape', async () => {
    const sink: WireCall[] = [];
    const model = createProvider({ ...CFG, wire: "anthropic" }, { fetch: jsonFetch(ANTHROPIC_OK, sink) });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(sink[0]?.url).toBe("https://dispatch.invalid/v1/messages");
    // The anthropic auth shape (never the bearer header).
    expect(sink[0]?.headers["x-api-key"]).toBe("sk-dispatch");
    expect(sink[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sink[0]?.headers["authorization"]).toBeUndefined();
    // Request-body shape (spec §5): model/max_tokens/system/messages/tools.
    const body = JSON.parse(sink[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "dispatch-model",
      max_tokens: 4096,
      system: "s",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [],
    });
  });

  it('wire "responses" → the responses adapter: /responses + responses request shape', async () => {
    const sink: WireCall[] = [];
    const model = createProvider({ ...CFG, wire: "responses" }, { fetch: jsonFetch(RESPONSES_OK, sink) });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(sink[0]?.url).toBe("https://dispatch.invalid/v1/responses");
    expect(sink[0]?.headers["authorization"]).toBe("Bearer sk-dispatch");
    const body = JSON.parse(sink[0]!.body) as Record<string, unknown>;
    expect(body).toEqual({
      model: "dispatch-model",
      instructions: "s",
      input: [{ role: "user", content: "hi" }],
      tools: [],
    });
  });

  it("unknown wire throws at construction (the upstream project apiFor precedent — fail fast, name the valid values)", () => {
    const bogus = { ...CFG, wire: "grpc" } as unknown as ProviderConfig;
    expect(() => createProvider(bogus)).toThrow(
      'unknown wire "grpc" (expected one of: openai-chat, anthropic, responses)',
    );
  });

  it("modelId rides the config (every route)", async () => {
    expect(createProvider(CFG, { fetch: jsonFetch(OPENAI_OK, []) }).modelId).toBe("dispatch-model");
    expect(createProvider({ ...CFG, wire: "anthropic" }, { fetch: jsonFetch(ANTHROPIC_OK, []) }).modelId).toBe("dispatch-model");
  });
});

// ---------------------------------------------------------------------------
// The wire resolution chain — selection.wire > env WUDAO_WIRE > absent
// ---------------------------------------------------------------------------

describe("wire resolution (resolveProviderConfigResult, Phase B)", () => {
  const ENV = { WUDAO_API_KEY: "sk-x" };

  it("absent selection/env → the wire field stays ABSENT (openai-chat materializes at dispatch)", () => {
    const r = resolveProviderConfigResult({ ...ENV }, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect("wire" in r.config && r.config.wire !== undefined).toBe(false);
  });

  it("env WUDAO_WIRE=anthropic → wire rides the config", () => {
    const r = resolveProviderConfigResult({ ...ENV, WUDAO_WIRE: "anthropic" }, {});
    expect(r.ok && r.config.wire).toBe("anthropic");
  });

  it("selection.wire beats env WUDAO_WIRE", () => {
    const r = resolveProviderConfigResult({ ...ENV, WUDAO_WIRE: "anthropic" }, { wire: "responses" });
    expect(r.ok && r.config.wire).toBe("responses");
  });

  it("junk wire fails fast at resolution (same contract as parseReasoningEffort)", () => {
    expect(() => resolveProviderConfigResult({ ...ENV, WUDAO_WIRE: "carrier-pigeon" }, {})).toThrow(
      'invalid wire "carrier-pigeon" (expected one of: openai-chat, anthropic, responses)',
    );
    expect(() => resolveProviderConfigResult({ ...ENV }, { wire: "nope" })).toThrow(
      'invalid wire "nope" (expected one of: openai-chat, anthropic, responses)',
    );
  });
});

// ---------------------------------------------------------------------------
// Phase A hardening THROUGH the routed path (brief acceptance ③) — the
// ladder + idle watchdog wrap the adapters inside createProvider too.
// ---------------------------------------------------------------------------

function statusThenOk(statuses: readonly number[], okPayload: unknown): typeof fetch {
  let i = 0;
  return (async () => {
    const s = statuses[i++] ?? 200;
    if (s === 200) return { ok: true, status: 200, json: async () => okPayload } as unknown as Response;
    return { ok: false, status: s, text: async () => `http ${s}` } as unknown as Response;
  }) as typeof fetch;
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull() { return new Promise<void>(() => {}); } });
}

describe("routed hardening — the Phase A ladder + watchdog via createProvider", () => {
  for (const wire of ["anthropic", "responses"] as const) {
    const okPayload = wire === "anthropic" ? ANTHROPIC_OK : RESPONSES_OK;

    it(`wire=${wire}: 429×2 → 200 walks the ladder and succeeds (generate)`, async () => {
      const { onRetry, log } = recordedRetries();
      const model = createProvider({ ...CFG, wire }, { fetch: statusThenOk([429, 429], okPayload), retry: { ...INSTANT, maxRetries: 3, onRetry } });
      const msg = await model.generate(INPUT);
      expect(msg.content).toBe("ok");
      expect(log.map((e) => e.reason)).toEqual(["429", "429"]);
    });

    it(`wire=${wire}: a stalled stream raises StreamIdleError through the routed path`, async () => {
      const fetch = (async () => ({ ok: true, status: 200, body: stalledBody() })) as unknown as typeof fetch;
      const model = createProvider({ ...CFG, wire }, { fetch, retry: { ...INSTANT, maxRetries: 0 }, streamIdleTimeoutMs: 25 });
      let saw: unknown;
      try {
        for await (const _ev of model.stream(INPUT)) void _ev;
      } catch (err) {
        saw = err;
      }
      expect((saw as Error | undefined)?.name).toBe("StreamIdleError");
      expect(saw).toBeInstanceOf(StreamIdleError);
    });
  }
});
