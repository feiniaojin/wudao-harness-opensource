// M70 §1 (provider half) — finish_reason capture: both the blocking and the
// streaming path surface choices[0].finish_reason on the final
// AssistantMessage.stopReason, so the loop's truncated tool-call guard can key
// on "length" (the token limit cut the generation mid-arguments).
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";

const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

const jsonRes = (status: number, body: unknown): Response =>
  ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function sseBody(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe("finish_reason capture (M70 §1)", () => {
  it("generate: surfaces finish_reason on the returned message", async () => {
    const fakeFetch = (async () =>
      jsonRes(200, {
        choices: [{
          message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: '{"path": "src/a' } }] },
          finish_reason: "length",
        }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const msg = await model.generate(INPUT);
    expect(msg.stopReason).toBe("length");
    // The salvage-parsed partial arguments ride along — the loop's guard, not
    // the provider, decides never to execute them.
    expect(msg.toolCalls).toHaveLength(1);
  });

  it("generate: omits stopReason when the endpoint sends none", async () => {
    const fakeFetch = (async () =>
      jsonRes(200, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    const msg = await model.generate(INPUT);
    expect(msg.stopReason).toBe("stop");
  });

  it("stream: carries the final chunk's finish_reason onto the done message", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: { stopReason?: string; content: string } | undefined;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done?.content).toBe("par");
    expect(done?.stopReason).toBe("length");
  });

  it("stream: a tool-call stream truncated mid-arguments carries stopReason length", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_file","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": \\"src/a"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: { stopReason?: string; toolCalls?: { arguments: Record<string, unknown> }[] } | undefined;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done?.stopReason).toBe("length");
    expect(done?.toolCalls).toHaveLength(1);
  });

  // M70 review F1 — OpenAI SSE chunks carry "finish_reason":null on every
  // intermediate chunk; a null must NEVER overwrite (or land as) the done
  // message's stopReason: null !== undefined would violate the omit-never-null
  // M56 discipline, and a trailing null after a real "length" would silently
  // disarm the truncated-tool-call guard.
  it("review F1: intermediate finish_reason:null chunks are skipped — the real length survives", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"par"},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: { stopReason?: string; content: string } | undefined;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done?.content).toBe("par");
    expect(done?.stopReason).toBe("length");
  });

  it("review F1: a TRAILING null after a real length never disarms the guard", async () => {
    const fakeFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: fakeFetch });
    let done: { stopReason?: string } | undefined;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    expect(done?.stopReason).toBe("length");
  });

  it("review F1: an all-null stream leaves stopReason OMITTED (never null), both paths", async () => {
    const sseFetch = (async () => ({
      ok: true,
      status: 200,
      body: sseBody([
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    })) as typeof fetch;
    const model = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: sseFetch });
    let done: { stopReason?: string } | undefined;
    for await (const ev of model.stream!(INPUT)) {
      if (ev.type === "done") done = ev.message;
    }
    expect("stopReason" in (done ?? {})).toBe(false);
    expect(done?.stopReason ?? undefined).toBeUndefined();

    const jsonFetch = (async () =>
      jsonRes(200, { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: null }] })) as typeof fetch;
    const model2 = createOpenAICompatibleProvider({ apiKey: "k", baseURL: "https://x/v1", model: "m" }, { fetch: jsonFetch });
    const msg = await model2.generate(INPUT);
    expect("stopReason" in msg).toBe(false);
  });
});
