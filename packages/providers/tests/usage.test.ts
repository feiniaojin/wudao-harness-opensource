// M24 usage channel + canonical prompt serializer.
// - onUsage is the ONLY usage channel: generate's return type and
//   AssistantMessage stay untouched; streaming and non-streaming both report
//   through the callback (streaming via stream_options.include_usage).
// - prompt_cache_hit_tokens and prompt_tokens_details.cached_tokens are two
//   wire spellings of the same quantity (the upstream formatrule): prefer details, fall back,
//   NEVER sum — the counts stay disjoint (hit + miss = promptTokens).
// - serializePrompt: fixed-key canonical bytes; same input twice → same bytes;
//   semantically identical input built with shuffled key insertion → same
//   bytes; append-only history growth → byte-prefix growth.
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider, serializePrompt } from "../src/index.js";
import type { ModelInput, ModelUsage } from "@wudao/core";

const CFG = { apiKey: "k", baseURL: "https://x/v1", model: "m" };

function jsonFetch(payload: () => unknown): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  const doFetch = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => payload(),
    };
  }) as typeof fetch;
  return { fetch: doFetch, bodies };
}

function sse(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

describe("usage channel (non-streaming)", () => {
  it("reports prompt_cache_hit_tokens spelling via onUsage, disjoint counts", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 7, prompt_cache_hit_tokens: 800 },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    const msg = await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      onUsage: (u) => seen.push(u),
    });
    expect(seen).toEqual([{ promptTokens: 1000, cacheHitTokens: 800, cacheMissTokens: 200, completionTokens: 7, cacheWriteTokens: 200, model: "m", durationMs: expect.any(Number) }]);
    // The message itself is unchanged — onUsage is a pure observer.
    expect(msg.content).toBe("ok");
    expect((msg as { usage?: unknown }).usage).toBeUndefined();
  });

  it("reports prompt_tokens_details.cached_tokens spelling via onUsage", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 500, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 450 } },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([{ promptTokens: 500, cacheHitTokens: 450, cacheMissTokens: 50, completionTokens: 3, cacheWriteTokens: 50, model: "m", durationMs: expect.any(Number) }]);
  });

  it("does not double-count when BOTH fields are present (disjoint merge)", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 400, prompt_cache_hit_tokens: 300, prompt_tokens_details: { cached_tokens: 300 } },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen[0]?.cacheHitTokens).toBe(300);
    expect(seen[0]?.cacheMissTokens).toBe(100);
  });

  it("clamps negative miss when hit exceeds prompt_tokens", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 120 },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen[0]?.cacheMissTokens).toBe(0);
  });

  it("stays silent when the response carries no usage", async () => {
    const { fetch } = jsonFetch(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([]);
  });
});

describe("usage channel (streaming)", () => {
  it("adds stream_options.include_usage and parses the trailing usage chunk", async () => {
    const bodies: string[] = [];
    const doFetch = (async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return {
        ok: true,
        status: 200,
        body: sse([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":2000,"prompt_cache_hit_tokens":1900}}\n\n',
          "data: [DONE]\n\n",
        ]),
      };
    }) as typeof fetch;
    const model = createOpenAICompatibleProvider(CFG, { fetch: doFetch });
    const seen: ModelUsage[] = [];
    let done: unknown;
    for await (const ev of model.stream!({
      systemPrompt: "s",
      messages: [{ role: "user", content: "u" }],
      tools: [],
      onUsage: (u) => seen.push(u),
    })) {
      if (ev.type === "done") done = ev.message;
    }
    const body = JSON.parse(bodies[0] ?? "{}") as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(seen).toEqual([{ promptTokens: 2000, cacheHitTokens: 1900, cacheMissTokens: 100, completionTokens: 0, cacheWriteTokens: 100, model: "m", durationMs: expect.any(Number) }]);
    expect((done as { content: string }).content).toBe("Hi");
  });

  it("streaming body bytes are the non-streaming body bytes plus the appended keys", async () => {
    // The prefix-cache property, pinned at the wire level: switching a request
    // from non-streaming to streaming only APPENDS `stream` + `stream_options`
    // after the pinned key sequence — the shared prefix bytes stay identical.
    const streams: string[] = [];
    const genBodies: string[] = [];
    const mkFetch = (sink: string[]): typeof fetch => (async (_url: string, init: RequestInit) => {
      sink.push(String(init.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
        body: sse(["data: [DONE]\n\n"]),
      };
    }) as typeof fetch;
    const input: ModelInput = { systemPrompt: "s", messages: [{ role: "user", content: "u" }], tools: [] };
    await createOpenAICompatibleProvider(CFG, { fetch: mkFetch(genBodies) }).generate(input);
    for await (const _ev of createOpenAICompatibleProvider(CFG, { fetch: mkFetch(streams) }).stream!(input)) {
      // drain
    }
    const genBody = genBodies[0] ?? "";
    const streamBody = streams[0] ?? "";
    expect(streamBody.startsWith(genBody.slice(0, -1))).toBe(true);
    expect(streamBody.endsWith(',"stream":true,"stream_options":{"include_usage":true}}')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M56 §2 — turn_usage receipts (the upstream format AGENT_RUNTIME turn_usage): one
// receipt per model call, optional fields OMITTED when unknown (never null,
// never zero-backfilled), durationMs always measured around the attempt.
// ---------------------------------------------------------------------------
describe("turn_usage receipts", () => {
  it("DeepSeek's explicit miss spelling feeds miss AND cache-write (miss ≈ write)", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 9, prompt_cache_hit_tokens: 700, prompt_cache_miss_tokens: 300 },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen[0]).toMatchObject({ cacheMissTokens: 300, cacheWriteTokens: 300 });
  });

  it("reasoning_tokens (completion details spelling) surfaces as reasoningTokens", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok", reasoning_content: "think" } }],
      usage: { prompt_tokens: 10, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 32 } },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen[0]?.reasoningTokens).toBe(32);
  });

  it("no cache fields on the wire → cacheWriteTokens stays OMITTED (unknown ≠ 0)", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 100, completion_tokens: 5 },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(seen[0] && "cacheWriteTokens" in seen[0]).toBe(false);
    expect(seen[0] && "reasoningTokens" in seen[0]).toBe(false);
    // Omit-never-null discipline: no field anywhere is null.
    for (const v of Object.values(seen[0] ?? {})) expect(v).not.toBeNull();
  });

  it("durationMs is always present and non-negative (generate + stream)", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }));
    const model = createOpenAICompatibleProvider(CFG, { fetch });
    const seen: ModelUsage[] = [];
    await model.generate({ systemPrompt: "s", messages: [], tools: [], onUsage: (u) => seen.push(u) });
    expect(typeof seen[0]?.durationMs).toBe("number");
    expect((seen[0]?.durationMs ?? -1)).toBeGreaterThanOrEqual(0);

    const doFetch = (async () => ({
      ok: true,
      status: 200,
      body: sse([
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const streamed: ModelUsage[] = [];
    for await (const _ev of createOpenAICompatibleProvider(CFG, { fetch: doFetch }).stream!({
      systemPrompt: "s", messages: [], tools: [], onUsage: (u) => streamed.push(u),
    })) {
      // drain
    }
    expect(typeof streamed[0]?.durationMs).toBe("number");
  });

  it("replayed historical reasoning is estimated as reasoningReplayTokens (replay contract ON)", async () => {
    const { fetch } = jsonFetch(() => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    const replayCfg = { ...CFG, reasoningReplay: "toolCallTurns" as const };
    const history = [
      { role: "user" as const, content: "u" },
      {
        role: "assistant" as const,
        content: "",
        reasoning: "思考过程", // 4 CJK chars ≈ 4 tokens
        toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }],
      },
      { role: "tool" as const, toolCallId: "c1", name: "read_file", content: "d" },
    ];
    const seen: ModelUsage[] = [];
    await createOpenAICompatibleProvider(replayCfg, { fetch }).generate({
      systemPrompt: "s", messages: history, tools: [], onUsage: (u) => seen.push(u),
    });
    // No usage on the wire → no receipt at all (the whole event is skipped
    // when the provider reports no usage).
    expect(seen).toEqual([]);

    const priced = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }));
    await createOpenAICompatibleProvider(replayCfg, { fetch: priced.fetch }).generate({
      systemPrompt: "s", messages: history, tools: [], onUsage: (u) => seen.push(u),
    });
    expect(seen[0]?.reasoningReplayTokens).toBe(4);
  });

  it("replay OFF (never) never fabricates reasoningReplayTokens", async () => {
    const { fetch } = jsonFetch(() => ({
      choices: [{ message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 1 },
    }));
    const seen: ModelUsage[] = [];
    await createOpenAICompatibleProvider(CFG, { fetch }).generate({
      systemPrompt: "s",
      messages: [{ role: "assistant", content: "", reasoning: "思考过程", toolCalls: [{ id: "c1", name: "t", arguments: {} }] }],
      tools: [],
      onUsage: (u) => seen.push(u),
    });
    expect(seen[0] && "reasoningReplayTokens" in seen[0]).toBe(false);
  });
});

describe("serializePrompt", () => {
  const baseInput: ModelInput = {
    systemPrompt: "sys",
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "data" },
    ],
    tools: [
      { name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
    ],
  };

  it("is byte-identical for the same input rebuilt as new objects", () => {
    const rebuild = (): ModelInput => JSON.parse(JSON.stringify(baseInput));
    expect(serializePrompt(rebuild())).toBe(serializePrompt(rebuild()));
  });

  it("ignores the input's key insertion order (canonical keys)", () => {
    // parameters built in reverse key order; tool-call arguments too.
    const shuffled: ModelInput = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              arguments: { path: "a.txt" },
              name: "read_file",
              id: "c1",
            },
          ],
        },
        { content: "data", name: "read_file", toolCallId: "c1", role: "tool" },
      ],
      tools: [
        {
          description: "d",
          name: "read_file",
          parameters: {
            additionalProperties: false,
            required: ["path"],
            properties: { path: { type: "string" } },
            type: "object",
          },
        },
      ],
    };
    expect(serializePrompt(shuffled)).toBe(serializePrompt(baseInput));
  });

  it("grows byte-prefix-only when the history grows append-only", () => {
    const before = serializePrompt(baseInput);
    const grown: ModelInput = {
      ...baseInput,
      messages: [...baseInput.messages, { role: "user", content: "next turn" }],
    };
    const after = serializePrompt(grown);
    expect(after.startsWith(before)).toBe(true);
    expect(after.length).toBeGreaterThan(before.length);
  });

  it("diverges when the stable header (system/tools) changes", () => {
    const changed: ModelInput = { ...baseInput, systemPrompt: "sys2" };
    expect(serializePrompt(changed).startsWith(serializePrompt(baseInput))).toBe(false);
  });

  it("puts the stable header (system + tools) before the messages", () => {
    const lines = serializePrompt(baseInput).split("\n").filter((l) => l.length > 0);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({ role: "system", content: "sys" });
    expect(JSON.parse(lines[1] ?? "{}").function.name).toBe("read_file");
    expect(lines).toHaveLength(5); // system + 1 tool + 3 messages
    const last = JSON.parse(lines[4] ?? "{}");
    expect(last).toEqual({ role: "tool", tool_call_id: "c1", content: "data" });
  });

  it("never serializes assistant reasoning back to the provider", () => {
    const input: ModelInput = {
      systemPrompt: "s",
      messages: [{ role: "assistant", content: "a", reasoning: "secret thoughts" }],
      tools: [],
    };
    expect(serializePrompt(input)).not.toContain("secret thoughts");
    expect(serializePrompt(input)).not.toContain("reasoning");
  });
});
