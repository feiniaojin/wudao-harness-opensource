// M70 §4 (CC) — max_tokens overflow self-repair. A 400 whose body carries
// parseable input_tokens/context_limit numbers means the COMPLETION cap
// pushed the total over the window (the prompt itself fits): parse the
// numbers, set retryContext.maxTokensOverride = max(3000, contextLimit -
// inputTokens - 1000, thinkingBudget + 1), and retry ONCE with the reduced
// cap. Unparseable 400s keep the normal error path; a 400 matching the
// context-length vocabulary still classifies as ContextLengthError first
// (M58 §A — the loop compacts, the stronger remedy).
import { describe, it, expect } from "vitest";
import {
  createOpenAICompatibleProvider,
  parseMaxTokensOverflow,
  selfRepairMaxTokensValue,
  ProviderHttpError,
} from "../src/index.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

describe("parseMaxTokensOverflow (M70 §4)", () => {
  it("parses the anthropic-style prose wording", () => {
    // NOTE (review F3): in PRODUCTION this exact body matches the M58 §A
    // context-length vocabulary (/prompt too long/i) and classifies as
    // ContextLengthError BEFORE the self-repair ever sees it — the loop's
    // compact-and-retry owns that case. This test exercises the PURE parser
    // only; the provider-level tests below use bodies free of that vocabulary.
    expect(
      parseMaxTokensOverflow("prompt is too long: input_tokens: 60000 > max_tokens: 80000, total: 140000 > context_limit: 128000"),
    ).toEqual({ inputTokens: 60_000, contextLimit: 128_000 });
  });

  it("parses the JSON field spelling (maximum_context_length variant)", () => {
    expect(
      parseMaxTokensOverflow('{"error":{"message":"request too large","input_tokens":109645,"maximum_context_length":200000}}'),
    ).toEqual({ inputTokens: 109_645, contextLimit: 200_000 });
  });

  it("returns undefined without BOTH numbers", () => {
    expect(parseMaxTokensOverflow("input_tokens: 60000 but nothing else")).toBeUndefined();
    expect(parseMaxTokensOverflow("context_limit: 128000 only")).toBeUndefined();
    expect(parseMaxTokensOverflow("The model `nope` does not exist")).toBeUndefined();
    expect(parseMaxTokensOverflow("")).toBeUndefined();
  });
});

describe("selfRepairMaxTokensValue (M70 §4)", () => {
  it("headroom term wins when there is room", () => {
    expect(selfRepairMaxTokensValue({ inputTokens: 60_000, contextLimit: 128_000 })).toBe(67_000);
  });

  it("floors at 3000 when the headroom is gone", () => {
    expect(selfRepairMaxTokensValue({ inputTokens: 126_000, contextLimit: 128_000 })).toBe(3_000);
    expect(selfRepairMaxTokensValue({ inputTokens: 500_000, contextLimit: 128_000 })).toBe(3_000);
  });

  it("never undercuts the thinking budget + 1", () => {
    expect(selfRepairMaxTokensValue({ inputTokens: 126_000, contextLimit: 128_000 }, 5_000)).toBe(5_001);
  });
});

const textRes = (status: number, body: string): Response =>
  ({ ok: status === 200, status, json: async () => JSON.parse(body), text: async () => body }) as unknown as Response;

/** fetch script: the given responses in order; records every posted body. */
function scriptedFetch(responses: readonly (() => Response)[]): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  let i = 0;
  return {
    bodies,
    fetch: (async (_url: string, init: { body?: string }) => {
      bodies.push(init.body ? JSON.parse(init.body) : undefined);
      const res = responses[i];
      i += 1;
      if (!res) throw new Error("scripted fetch exhausted");
      return res();
    }) as typeof fetch,
  };
}

const OK = () => textRes(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] }));

// 400 carrying the numbers WITHOUT the context-length vocabulary (that
// vocabulary would classify as ContextLengthError — the loop's domain).
const REPAIRABLE_400 = () =>
  textRes(400, "request exceeds the model budget: input_tokens: 60000, context_limit: 128000");
const UNPARSEABLE_400 = () => textRes(400, '{"error":{"message":"The model `nope` does not exist"}}');

describe("max_tokens self-repair at the provider (M70 §4)", () => {
  it("generate: a parseable 400 retries ONCE with the reduced max_tokens override", async () => {
    const f = scriptedFetch([REPAIRABLE_400, OK]);
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: f.fetch });
    const msg = await model.generate(INPUT);
    expect(msg.content).toBe("ok");
    expect(f.bodies).toHaveLength(2);
    // First attempt carried NO cap; the retry carries the computed override.
    expect((f.bodies[0] as Record<string, unknown>)["max_tokens"]).toBeUndefined();
    expect((f.bodies[1] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
  });

  it("generate: an unparseable 400 keeps the normal error path (one fetch)", async () => {
    const f = scriptedFetch([UNPARSEABLE_400]);
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: f.fetch });
    const err = await model.generate(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(400);
    expect(f.bodies).toHaveLength(1);
  });

  it("generate: the self-repair is single-shot — a second 400 propagates", async () => {
    const f = scriptedFetch([REPAIRABLE_400, REPAIRABLE_400]);
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: f.fetch });
    const err = await model.generate(INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect(f.bodies).toHaveLength(2);
    expect((f.bodies[1] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
  });

  it("stream: the repair applies on the streaming path too", async () => {
    const sse = (finish: string) =>
      textRes(200, "unused") &&
      ({ ok: true, status: 200, text: async () => "", json: async () => ({}), body: sseBody([`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"${finish}"}]}\n\n`, "data: [DONE]\n\n"]) }) as unknown as Response;
    const f = scriptedFetch([REPAIRABLE_400, () => sse("stop")]);
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: f.fetch });
    let content = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") content += ev.text;
    }
    expect(content).toBe("ok");
    expect(f.bodies).toHaveLength(2);
    expect((f.bodies[1] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
  });

  // M70 review F2 — the terminal-repair frozen replay must carry the
  // self-repair cap. When the first leg self-repaired (retryContext.
  // maxTokensOverride set) and the REPAIRED response is degenerate (M48 §2
  // reasoning-only finish), the replay used to go out with the ORIGINAL
  // config — no longer byte-identical to the successful leg, and a recurring
  // 400 could not re-repair (single-shot), failing the call despite a good
  // response. The replay now re-applies the override.
  it("review F2 (generate): repair + degenerate finish → the frozen replay carries the override", async () => {
    // deepseek profile: acceptsReasoningOnlyFinish → the reasoning-only
    // finish triggers the M48 §2 frozen replay.
    const DEGENERATE = () =>
      textRes(200, JSON.stringify({ choices: [{ message: { role: "assistant", content: "", reasoning_content: "thinking…" }, finish_reason: "stop" }] }));
    const f = scriptedFetch([REPAIRABLE_400, DEGENERATE, OK]);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "deepseek" },
      { fetch: f.fetch },
    );
    const repairs: string[] = [];
    const msg = await model.generate({ ...INPUT, onTerminalRepair: (kind) => repairs.push(kind) });
    expect(msg.content).toBe("ok");
    expect(repairs).toEqual(["reasoning-only"]);
    expect(f.bodies).toHaveLength(3);
    // The repaired leg (2nd) AND the frozen replay (3rd) both carry the cap —
    // the replay is byte-identical to the SUCCESSFUL (self-repaired) leg.
    expect((f.bodies[1] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
    expect((f.bodies[2] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
  });

  it("review F2 (stream): same — the replay's posted body carries the override", async () => {
    // SSE whose done message is reasoning-only (content "", reasoning present)
    // under the deepseek profile → M48 §2 replay after the self-repaired leg.
    const DEGENERATE_SSE = () =>
      ({ ok: true, status: 200, text: async () => "", json: async () => ({}), body: sseBody([
        'data: {"choices":[{"delta":{"reasoning_content":"thinking…"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]) }) as unknown as Response;
    const OK_SSE = () =>
      ({ ok: true, status: 200, text: async () => "", json: async () => ({}), body: sseBody([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]) }) as unknown as Response;
    const f = scriptedFetch([REPAIRABLE_400, DEGENERATE_SSE, OK_SSE]);
    const model = createOpenAICompatibleProvider(
      { apiKey: "k", baseURL: "https://x/v1", model: "m", provider: "deepseek" },
      { fetch: f.fetch },
    );
    let content = "";
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "text_delta") content += ev.text;
    }
    expect(content).toBe("ok");
    expect(f.bodies).toHaveLength(3);
    expect((f.bodies[1] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
    expect((f.bodies[2] as Record<string, unknown>)["max_tokens"]).toBe(67_000);
  });
});

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}
