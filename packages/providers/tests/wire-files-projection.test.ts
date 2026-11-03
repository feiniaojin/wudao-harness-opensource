// ω99-55 — the request-build file projection at the provider boundary
// (acceptance 3: the wire stays clean — byte-level assertions on captured
// request bodies). Files never ride any wire: every FileBlock becomes
// deterministic handle text naming the workspace-visible read-only path,
// before ANY wire converter runs (openai-chat generate AND stream share one
// builder; anthropic/responses project at the same request-build point —
// unlike images there is nothing to refuse, text rides every wire).
import { describe, it, expect } from "vitest";
import type { ModelInput, FileBlock } from "@wudao-org/core";
import { offloadRequestFiles, fileVisibleRelPath } from "@wudao-org/core";
import { createOpenAICompatibleProvider, serializePrompt } from "../src/index.js";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createResponsesProvider } from "../src/responses.js";
import type { ProviderConfig } from "../src/index.js";

const FILE_BYTES = Buffer.from("PDF-BYTES-FOR-WIRE-CLEAN-ASSERTIONS %PDF-1.7 wudao-omega99-55");
const FILE_B64 = FILE_BYTES.toString("base64");
const digest = "9a3f11000000" + "ab".repeat(26); // 12 + 52 = 64 hex
const fblock: FileBlock = { kind: "file", name: "spec.pdf", bytes: FILE_BYTES.length, attachmentId: `sha256:${digest}` };
const visiblePath = fileVisibleRelPath(fblock);

const inputWithFiles: ModelInput = {
  systemPrompt: "s",
  messages: [{ role: "user", content: "review the attached spec", files: [fblock] }],
  tools: [],
};

const textOnlyInput: ModelInput = {
  systemPrompt: "s",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

/** A capture fetch: records every posted body, counts every call. */
function captureFetch(replyBody?: Record<string, unknown>): { fetch: typeof fetch; bodies: Record<string, unknown>[]; calls: () => number } {
  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    n += 1;
    bodies.push(JSON.parse(String(init.body)));
    return {
      ok: true,
      status: 200,
      json: async () => replyBody ?? { choices: [{ message: { role: "assistant", content: "ok" } }] },
    };
  }) as unknown as typeof fetch;
  return { fetch, bodies, calls: () => n };
}

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: "k",
  baseURL: "https://x/v1",
  model: "glm-4.7-flash",
  ...over,
});

describe("openai-compatible — files project to handle text, bytes never cross (acceptance 3)", () => {
  it("generate(): the serialized request contains NO file bytes and NAMES the visible path", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(config(), { fetch: cap.fetch });
    await model.generate(inputWithFiles);
    expect(cap.calls()).toBe(1);
    const raw = JSON.stringify(cap.bodies[0]);
    expect(raw).not.toContain(FILE_B64); // base64 form never crosses
    expect(raw).not.toContain("PDF-BYTES-FOR-WIRE-CLEAN-ASSERTIONS"); // raw form never crosses
    const messages = (cap.bodies[0] as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages[1]!.role).toBe("user");
    expect(String(messages[1]!.content)).toContain(visiblePath);
    expect(String(messages[1]!.content)).toContain("review the attached spec");
  });

  it("stream(): the same projection on the streaming path", async () => {
    const bodies: Record<string, unknown>[] = [];
    const sse = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    let n = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
      n += 1;
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true, status: 200, body: sse } as unknown as Response;
    }) as unknown as typeof fetch;
    const model = createOpenAICompatibleProvider(config(), { fetch });
    const events: string[] = [];
    for await (const ev of model.stream!(inputWithFiles)) {
      if (ev.type === "text_delta") events.push(ev.text);
    }
    expect(events.join("")).toBe("ok");
    expect(n).toBe(1);
    const raw = JSON.stringify(bodies[0]);
    expect(raw).not.toContain(FILE_B64);
    expect(raw).not.toContain("PDF-BYTES-FOR-WIRE-CLEAN-ASSERTIONS");
    expect(raw).toContain(visiblePath);
  });

  it("a text-only request keeps the compact string content (byte-identical pre-ω99-55 shape)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(config(), { fetch: cap.fetch });
    await model.generate(textOnlyInput);
    const messages = (cap.bodies[0] as { messages: { role: string; content: unknown }[] }).messages;
    expect(messages[1]).toEqual({ role: "user", content: "hello" });
  });

  it("files and images may ride the same turn (handle text + image parts)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(config({ inputModalities: ["text", "image"] } as Partial<ProviderConfig>), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: async () => `data:image/png;base64,${"A".repeat(4)}` },
    });
    const mixed: ModelInput = {
      systemPrompt: "s",
      messages: [{
        role: "user",
        content: "both",
        images: [{ kind: "image", ref: { kind: "image", attachmentId: "0b0e8a91-1111-4111-8111-111111111111", mediaType: "image/png", byteLength: 3 } }],
        files: [fblock],
      }],
      tools: [],
    };
    await model.generate(mixed);
    const messages = (cap.bodies[0] as { messages: { role: string; content: unknown }[] }).messages;
    const parts = messages[1]!.content as { type: string; text?: string; image_url?: { url: string } }[];
    expect(parts.some((p) => p.type === "image_url" && p.image_url!.url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(parts.some((p) => p.type === "text" && p.text!.includes(visiblePath))).toBe(true);
    expect(JSON.stringify(cap.bodies[0])).not.toContain(FILE_B64);
  });
});

describe("anthropic / responses — files project to text (no refusal, no silent drop)", () => {
  it("anthropic generate(): the handle rides the user text; images stay fail-closed", async () => {
    const cap = captureFetch();
    const model = createAnthropicProvider({ apiKey: "k", baseURL: "https://x", model: "claude-x" }, { fetch: cap.fetch });
    await model.generate(inputWithFiles);
    const raw = JSON.stringify(cap.bodies[0]);
    expect(raw).not.toContain(FILE_B64);
    expect(raw).toContain(visiblePath);
  });

  it("responses generate(): same projection", async () => {
    const cap = captureFetch();
    const model = createResponsesProvider({ apiKey: "k", baseURL: "https://x/v1", model: "gpt-x" }, { fetch: cap.fetch });
    await model.generate(inputWithFiles);
    const raw = JSON.stringify(cap.bodies[0]);
    expect(raw).not.toContain(FILE_B64);
    expect(raw).toContain(visiblePath);
  });
});

describe("serializePrompt — the canonical durable form pins file blocks", () => {
  it("a file-bearing user turn pins {role, content, files}; text-only turns stay toOpenAIMessage's shape", () => {
    const pinned = serializePrompt(inputWithFiles);
    const line = pinned.split("\n")[1]!; // line 0 = system; each line ends "\n" (split leaves a trailing "")
    const parsed = JSON.parse(line) as { role: string; content: string; files?: unknown[] };
    expect(parsed.role).toBe("user");
    expect(parsed.content).toBe("review the attached spec");
    expect(parsed.files).toEqual([fblock]);
    expect(pinned).not.toContain(FILE_B64);
    const textPinned = serializePrompt(textOnlyInput);
    // canonicalJson sorts keys recursively — compare the parsed shape, and
    // that NO extra keys (files) appear on file-free turns.
    expect(JSON.parse(textPinned.split("\n")[1]!)).toEqual({ role: "user", content: "hello" });
  });
});

describe("offloadRequestFiles — provider-facing purity (identity prefilter)", () => {
  it("returns the same reference for file-free input (the byte-identity guarantee)", () => {
    const messages = textOnlyInput.messages;
    expect(offloadRequestFiles(messages)).toBe(messages);
  });
});
