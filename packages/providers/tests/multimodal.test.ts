// M79 §2/§3 — image-bearing requests through the OpenAI-compatible engine:
// wire parts (image_url with the TRANSIENT data URL), the inputModalities
// gate (both pre-I/O branches — no fetch is ever issued), the uncataloged
// text-only default, tool-result images buffering into ONE synthetic user
// message, oldest-first offload (omitted bytes never resolved), the
// byte-identical text-only golden, and the canonical serializer's durable
// ref form (spec invariants 1/2/3/4 at the provider boundary).
import { describe, it, expect } from "vitest";
import type { AgentMessage, ModelInput } from "@wudao/core";
import {
  createOpenAICompatibleProvider,
  serializePrompt,
  modelInputModalities,
  resolveInputModalities,
  modelAcceptsImages,
  assertImagesSupported,
  TOOL_IMAGE_NOTE,
} from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

const ref = (id: string, bytes: number) => ({
  kind: "image" as const,
  attachmentId: id,
  mediaType: "image/png",
  byteLength: bytes,
});

const visionConfig = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: "k",
  baseURL: "https://x/v1",
  model: "glm-4v-plus",
  ...over,
});

/** A capture fetch: records every posted body, counts every call. */
function captureFetch(): { fetch: typeof fetch; bodies: Record<string, unknown>[]; calls: () => number } {
  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    n += 1;
    bodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    };
  }) as unknown as typeof fetch;
  return { fetch, bodies, calls: () => n };
}

const resolverOver = (ids: string[]) => async (r: { attachmentId: string; mediaType: string }) => {
  ids.push(r.attachmentId);
  return `data:${r.mediaType};base64,${r.attachmentId}`;
};

describe("modelInputModalities — capability is exact model metadata", () => {
  it("known vision entries and families resolve text+image", () => {
    for (const m of ["glm-4v", "glm-4v-plus", "glm-4v-flash", "glm-4.1v-thinking-plus", "glm-4.5v", "qwen-vl-plus", "qwen-vl-max", "qwen2-vl-7b-instruct", "qwen2.5-vl-72b-instruct", "qwen3-vl-plus"]) {
      expect(modelInputModalities(m)).toEqual(["text", "image"]);
    }
  });
  it("uncataloged and text models default to text-only", () => {
    for (const m of ["deepseek-v4-flash", "glm-4.6", "qwen3-max", "wudao-preview", "some-unknown-model"]) {
      expect(modelInputModalities(m)).toEqual(["text"]);
    }
  });
  it("an explicit config pin beats the catalog in both directions", () => {
    expect(resolveInputModalities({ model: "deepseek-v4-flash", inputModalities: ["text", "image"] })).toEqual(["text", "image"]);
    expect(resolveInputModalities({ model: "glm-4v" })).toEqual(["text", "image"]);
    expect(modelAcceptsImages({ model: "deepseek-v4-flash" })).toBe(false);
    expect(modelAcceptsImages({ model: "qwen3-vl-plus" })).toBe(true);
  });
});

describe("wire shaping — image_url parts, transient data URLs", () => {
  it("a user turn with images becomes content parts (text then image_url)", async () => {
    const cap = captureFetch();
    const resolved: string[] = [];
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver(resolved) },
    });
    await model.generate({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "what is this?", images: [{ kind: "image", ref: ref("id-1", 3) }] }],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "system", content: "sys" });
    expect(msgs[1]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "what is this?" },
        { type: "image_url", image_url: { url: "data:image/png;base64,id-1" } },
      ],
    });
    expect(resolved).toEqual(["id-1"]);
  });

  it("a text-only request keeps the compact string content (byte-identical pre-M79 shape)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), { fetch: cap.fetch });
    await model.generate({
      systemPrompt: "sys",
      messages: [{ role: "user", content: "plain" }, { role: "assistant", content: "answer" }],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    expect(msgs[1]).toEqual({ role: "user", content: "plain" });
    expect(JSON.stringify(msgs[1])).toBe('{"role":"user","content":"plain"}');
  });
});

describe("the inputModalities gate (pre-I/O, typed, fail-closed)", () => {
  const imageInput: ModelInput = {
    systemPrompt: "s",
    messages: [{ role: "user", content: "x", images: [{ kind: "image", ref: ref("id-1", 3) }] }],
    tools: [],
  };

  it("images to a model without the image modality → UNSUPPORTED_CONTENT, zero fetches", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig({ model: "deepseek-v4-flash" }), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    await expect(model.generate(imageInput)).rejects.toMatchObject({
      name: "UnsupportedContentError",
      code: "UNSUPPORTED_CONTENT",
      reason: "model-no-image-modality",
    });
    expect(cap.calls()).toBe(0);
  });

  it("ImageBlock in assistant history → UNSUPPORTED_CONTENT (role branch), zero fetches", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    const assistantWithImages = {
      role: "assistant",
      content: "a",
      images: [{ kind: "image", ref: ref("id-9", 3) }],
    } as unknown as AgentMessage;
    await expect(model.generate({
      ...imageInput,
      messages: [{ role: "user", content: "x" }, assistantWithImages],
    })).rejects.toMatchObject({ reason: "image-in-unsupported-role" });
    expect(cap.calls()).toBe(0);
  });

  it("no attachment resolver assembled → UNSUPPORTED_CONTENT (no-attachment-store)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), { fetch: cap.fetch });
    await expect(model.generate(imageInput)).rejects.toMatchObject({ reason: "no-attachment-store" });
    expect(cap.calls()).toBe(0);
  });

  it("the pure gate helper rejects before I/O for a text-only model", () => {
    expect(() => assertImagesSupported(imageInput, ["text"])).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_CONTENT", reason: "model-no-image-modality" }),
    );
    expect(() => assertImagesSupported(imageInput, ["text", "image"])).not.toThrow();
  });
});

describe("tool-result images buffer into ONE following synthetic user message", () => {
  it("consecutive tool images ride one user message with the fixed prefix", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shot", arguments: {} }] },
        { role: "tool", toolCallId: "c1", name: "shot", content: "", images: [{ kind: "image", ref: ref("t1", 3) }] },
        { role: "tool", toolCallId: "c1", name: "shot", content: "done", images: [{ kind: "image", ref: ref("t2", 3) }] },
        { role: "assistant", content: "seen" },
      ],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    // system, user, assistant(tool_calls), tool, tool, SYNTHETIC user, assistant
    expect(msgs).toHaveLength(7);
    expect(msgs[3]).toMatchObject({ role: "tool", content: "(see attached image)" }); // empty text → the fallback
    expect(msgs[4]).toMatchObject({ role: "tool", content: "done" }); // non-empty text stays verbatim
    const synthetic = msgs[5] as { role: string; content: Record<string, unknown>[] };
    expect(synthetic.role).toBe("user");
    expect(synthetic.content[0]).toEqual({ type: "text", text: TOOL_IMAGE_NOTE });
    expect(synthetic.content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,t1" } });
    expect(synthetic.content[2]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,t2" } });
  });

  it("trailing tool images still flush at the end of the history", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "look" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shot", arguments: {} }] },
        { role: "tool", toolCallId: "c1", name: "shot", content: "x", images: [{ kind: "image", ref: ref("t9", 3) }] },
      ],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(5);
    expect((msgs[4] as { role: string }).role).toBe("user");
  });
});

describe("oldest-first offload at the request boundary", () => {
  it("over budget → the OLDEST image becomes a fixed placeholder; its bytes never resolved", async () => {
    const cap = captureFetch();
    const resolved: string[] = [];
    // Three 3-byte images (base64 4 each); budget 10 admits only the two newest.
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      maxRequestImageBytes: 10,
      attachments: { resolveDataUrl: resolverOver(resolved) },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{
        role: "user",
        content: "three images",
        images: [
          { kind: "image", ref: ref("old", 3) },
          { kind: "image", ref: ref("mid", 3) },
          { kind: "image", ref: ref("new", 3) },
        ],
      }],
      tools: [],
    });
    const parts = (cap.bodies[0]!.messages as Record<string, unknown>[])[1]!.content as Record<string, unknown>[];
    expect(parts[0]).toEqual({ type: "text", text: "three images" });
    expect(parts[1]).toEqual({ type: "text", text: "[image omitted: old]" });
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect([...resolved].sort()).toEqual(["mid", "new"]); // the omitted ref was never resolved
  });

  it("under budget everything rides — no placeholders", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{
        role: "user",
        content: "two images",
        images: [{ kind: "image", ref: ref("a", 3) }, { kind: "image", ref: ref("b", 3) }],
      }],
      tools: [],
    });
    const parts = (cap.bodies[0]!.messages as Record<string, unknown>[])[1]!.content as Record<string, unknown>[];
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(2);
    expect(parts.some((p) => p.type === "text" && String(p.text).startsWith("[image omitted"))).toBe(false);
  });

  it("the streaming path emits the same image parts", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, body: sse } as unknown as Response;
    }) as unknown as typeof fetch;
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch,
      attachments: { resolveDataUrl: resolverOver([]) },
    });
    const events: string[] = [];
    for await (const ev of model.stream!({
      systemPrompt: "s",
      messages: [{ role: "user", content: "stream", images: [{ kind: "image", ref: ref("s1", 3) }] }],
      tools: [],
    })) {
      if (ev.type === "text_delta") events.push(ev.text);
    }
    expect(events.join("")).toBe("hi");
    const msgs = bodies[0]!.messages as Record<string, unknown>[];
    expect((msgs[1]!.content as Record<string, unknown>[])[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,s1" },
    });
  });
});

describe("canonical serialization (M24 invariant 2 — text-only bytes unchanged)", () => {
  const tool = { name: "read_file", description: "d", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };

  it("a text-only session's serialization is byte-identical to the pre-M79 layout", () => {
    const input: ModelInput = {
      systemPrompt: "sys",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }] },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "FILE" },
        { role: "assistant", content: "done" },
      ],
      tools: [tool],
    };
    // The golden layout: one canonical JSON line per segment, "\n"-terminated,
    // recursively key-sorted. Pinned EXACTLY (spec invariant 2).
    expect(serializePrompt(input)).toBe(
      '{"content":"sys","role":"system"}\n' +
      '{"function":{"description":"d","name":"read_file","parameters":{"properties":{"path":{"type":"string"}},"required":["path"],"type":"object"}},"type":"function"}\n' +
      '{"content":"hi","role":"user"}\n' +
      '{"content":"","role":"assistant","tool_calls":[{"function":{"arguments":"{\\"path\\":\\"a.txt\\"}","name":"read_file"},"id":"c1","type":"function"}]}\n' +
      '{"content":"FILE","role":"tool","tool_call_id":"c1"}\n' +
      '{"content":"done","role":"assistant"}\n',
    );
  });

  it("image-bearing turns pin their durable REFS (no data URL ever appears)", () => {
    const out = serializePrompt({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "look", images: [{ kind: "image", ref: ref("id-1", 3) }] },
        { role: "tool", toolCallId: "c1", name: "shot", content: "x", images: [{ kind: "image", ref: ref("id-2", 3) }] },
      ],
      tools: [],
    });
    expect(out).not.toContain("data:image");
    expect(out).not.toContain("base64");
    expect(out).toContain('"attachmentId":"id-1"');
    expect(out).toContain('"attachmentId":"id-2"');
    // The frozen header (system line) keeps its exact pre-M79 bytes ahead of
    // any image-bearing tail.
    const textOnly = serializePrompt({ systemPrompt: "s", messages: [{ role: "user", content: "look" }], tools: [] });
    expect(out.startsWith(textOnly.slice(0, textOnly.indexOf('{"content":"look"')))).toBe(true);
  });

  it("deterministic: two builds of the same image-bearing input are byte-equal", () => {
    const input: ModelInput = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "x", images: [{ kind: "image", ref: ref("a", 9) }, { kind: "image", ref: ref("b", 6) }] }],
      tools: [tool],
    };
    expect(serializePrompt(input)).toBe(serializePrompt(input));
  });
});
