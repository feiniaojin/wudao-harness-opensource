// R2 T1 — fail-closed images gate on the anthropic / responses wires.
// Before this gate, AgentMessage.images riding input on those wires was
// silently DROPPED by the message converters (toAnthropicMessages /
// toResponsesInput keep the text only) — a data-loss bug, not a degradation.
// The gate reuses the M79 typed family (UnsupportedContentError) with a new
// structural reason: any image block in the input refuses the request BEFORE
// any network call (fail-closed — never dropped, never degraded, never
// truncated), with the wire name and the recovery in the message.
import { describe, it, expect } from "vitest";
import { UnsupportedContentError } from "@wudao/core";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createResponsesProvider } from "../src/responses.js";

const imgRef = { kind: "image" as const, attachmentId: "att-1", mediaType: "image/png", byteLength: 100 };
const inputWithImages = {
  systemPrompt: "s",
  messages: [{ role: "user" as const, content: "look at this", images: [imgRef] }],
  tools: [],
};
// Tool results may carry images on the openai wire; on these wires they are
// refused identically (the gate is role-agnostic: the wires carry no image
// blocks at all).
const inputWithToolImages = {
  systemPrompt: "s",
  messages: [
    { role: "user" as const, content: "go" },
    { role: "assistant" as const, content: "", toolCalls: [{ id: "tu_1", name: "read_file", arguments: {} }] },
    { role: "tool" as const, toolCallId: "tu_1", name: "read_file", content: "body", images: [imgRef] },
  ],
  tools: [],
};

/** A fetch that must NEVER be reached: the gate fires before any network I/O
 *  (and before a single image byte is read). */
function neverFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const f = (async () => {
    n += 1;
    throw new Error("fetch must not be reached when the images gate refuses the request");
  }) as typeof fetch;
  return { fetch: f, calls: () => n };
}

/** Drain a stream to surface the generator's rejection. */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ev of gen) {
    // drain
  }
}

describe("anthropic wire — images are fail-closed, never silently dropped", () => {
  it("generate(): image-bearing input throws UnsupportedContentError (wire named, no fetch)", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(model.generate(inputWithImages as never)).rejects.toThrow(UnsupportedContentError);
    await expect(model.generate(inputWithImages as never)).rejects.toMatchObject({
      name: "UnsupportedContentError",
      reason: "wire-no-images",
    });
    await expect(model.generate(inputWithImages as never)).rejects.toThrow(/anthropic/);
    expect(nf.calls()).toBe(0);
  });

  it("stream(): same typed refusal on the streaming path", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(drain(model.stream!(inputWithImages as never))).rejects.toMatchObject({
      name: "UnsupportedContentError",
      reason: "wire-no-images",
    });
    expect(nf.calls()).toBe(0);
  });

  it("images riding a tool result are refused identically", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(model.generate(inputWithToolImages as never)).rejects.toMatchObject({ reason: "wire-no-images" });
    expect(nf.calls()).toBe(0);
  });
});

describe("responses wire — images are fail-closed, never silently dropped", () => {
  it("generate(): image-bearing input throws UnsupportedContentError (wire named, no fetch)", async () => {
    const nf = neverFetch();
    const model = createResponsesProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(model.generate(inputWithImages as never)).rejects.toThrow(UnsupportedContentError);
    await expect(model.generate(inputWithImages as never)).rejects.toMatchObject({
      name: "UnsupportedContentError",
      reason: "wire-no-images",
    });
    await expect(model.generate(inputWithImages as never)).rejects.toThrow(/responses/);
    expect(nf.calls()).toBe(0);
  });

  it("stream(): same typed refusal on the streaming path", async () => {
    const nf = neverFetch();
    const model = createResponsesProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(drain(model.stream!(inputWithImages as never))).rejects.toMatchObject({
      name: "UnsupportedContentError",
      reason: "wire-no-images",
    });
    expect(nf.calls()).toBe(0);
  });

  it("images riding a tool result are refused identically", async () => {
    const nf = neverFetch();
    const model = createResponsesProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: nf.fetch });
    await expect(model.generate(inputWithToolImages as never)).rejects.toMatchObject({ reason: "wire-no-images" });
    expect(nf.calls()).toBe(0);
  });
});

describe("no-image input is untouched (an empty images array is not images)", () => {
  it("anthropic: empty images array still posts", async () => {
    let n = 0;
    const okFetch = (async () => {
      n += 1;
      return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "done" }] }) };
    }) as typeof fetch;
    const model = createAnthropicProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: okFetch });
    const input = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi", images: [] }], tools: [] };
    await model.generate(input as never);
    expect(n).toBe(1);
  });

  it("responses: empty images array still posts", async () => {
    let n = 0;
    const okFetch = (async () => {
      n += 1;
      return { ok: true, status: 200, json: async () => ({ output: [] }) };
    }) as typeof fetch;
    const model = createResponsesProvider({ apiKey: "k", baseURL: "https://x", model: "m" }, { fetch: okFetch });
    const input = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi", images: [] }], tools: [] };
    await model.generate(input as never);
    expect(n).toBe(1);
  });
});
