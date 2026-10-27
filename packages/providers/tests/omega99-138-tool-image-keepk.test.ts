// ω99-138 — the keep-K request projection for TOOL-RESULT images (the M24
// compensation that ships BEFORE the feature): with 4 tool images in history
// only the most recent 3 become image_url parts; the oldest renders as the
// FIXED stub (literal-pinned) and its bytes are never resolved. USER images
// stay OUTSIDE the window (byte-for-byte M79 behavior). The modality gate
// itself is unchanged: a text model receiving tool-result images still fails
// closed with the typed UNSUPPORTED_CONTENT (the DEGRADATION lives upstream
// in the CLI's sink pre-check — the provider never silently degrades).
// ω99-244: #6 — 同形演进（K 2→3，brief N=3）：窗口缝/轮界时机/桩语义零变，
// 仅窗口宽一格——逐出例从 3 张改 4 张、桩字面 2→3 张；窗口内例（2 张）与
// 用户图例零改动（K=3 下 2 张仍在窗内=语义连续性直证）。
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

const ref = (id: string) => ({
  kind: "image" as const,
  attachmentId: id,
  mediaType: "image/png",
  byteLength: 3,
});

const visionConfig = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  apiKey: "k",
  baseURL: "https://x/v1",
  model: "glm-4v-plus",
  ...over,
});

function captureFetch(): { fetch: typeof fetch; bodies: Record<string, unknown>[]; calls: () => number } {
  const bodies: Record<string, unknown>[] = [];
  let n = 0;
  const fetch = (async (_url: string, init: RequestInit) => {
    n += 1;
    bodies.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }) };
  }) as unknown as typeof fetch;
  return { fetch, bodies, calls: () => n };
}

/** Three tool results, each carrying one image — the browser_see history
 *  shape (shot → look → shot → look → shot → look). */
const threeToolShots = [
  { role: "user" as const, content: "watch the page" },
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c1", name: "browser_see", arguments: {} }] },
  { role: "tool" as const, toolCallId: "c1", name: "browser_see", content: "shot 1", images: [{ kind: "image" as const, ref: ref("shot-1") }] },
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c2", name: "browser_see", arguments: {} }] },
  { role: "tool" as const, toolCallId: "c2", name: "browser_see", content: "shot 2", images: [{ kind: "image" as const, ref: ref("shot-2") }] },
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c3", name: "browser_see", arguments: {} }] },
  { role: "tool" as const, toolCallId: "c3", name: "browser_see", content: "shot 3", images: [{ kind: "image" as const, ref: ref("shot-3") }] },
];

/** ω99-244 — FOUR tool shots (K=3: the 4th landing slides the window; the
 *  oldest takes the stub). Same interleaved shape as threeToolShots. */
const fourToolShots = [
  { role: "assistant" as const, content: "", toolCalls: [{ id: "c4", name: "browser_see", arguments: {} }] },
  { role: "tool" as const, toolCallId: "c4", name: "browser_see", content: "shot 4", images: [{ kind: "image" as const, ref: ref("shot-4") }] },
];

/** All synthetic tool-image carriers of one request body, in wire order (a
 *  carrier follows EACH tool block — consecutive tool results share one). */
const carriersOf = (body: Record<string, unknown>): Record<string, unknown>[][] =>
  (body["messages"] as Record<string, unknown>[])
    .filter((m) => m["role"] === "user" && Array.isArray(m["content"]))
    .map((m) => m["content"] as Record<string, unknown>[])
    .filter((parts) => (parts[0] as { text?: string })?.text === "Attached image(s) from tool result:");

describe("ω99-138 keep-K: tool-result images keep a 3-image request window (ω99-244: K 2→3)", () => {
  it("4 tool images → the 3 newest ride as image_url; the oldest is the FIXED stub; its bytes never resolve", async () => {
    const cap = captureFetch();
    const resolved: string[] = [];
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: {
        resolveDataUrl: async (r) => { resolved.push(r.attachmentId); return `data:${r.mediaType};base64,${r.attachmentId}`; },
      },
    });
    await model.generate({ systemPrompt: "s", messages: [...threeToolShots, ...fourToolShots], tools: [] });
    // Each shot's carrier follows its own tool block (the interleaved
    // assistant tool-call turns flush between them) — four carriers.
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(4);
    expect(carriers[0]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "text", text: "[更早的截图已略：仅保留最近 3 张]" },
    ]);
    expect(carriers[1]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,shot-2" } },
    ]);
    expect(carriers[2]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,shot-3" } },
    ]);
    expect(carriers[3]).toEqual([
      { type: "text", text: "Attached image(s) from tool result:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,shot-4" } },
    ]);
    // The evicted image spent no bytes: only the kept window resolved.
    expect(resolved.sort()).toEqual(["shot-2", "shot-3", "shot-4"]);
  });

  it("2 tool images (within the window) → BOTH ride as image_url, no stub (M79 drift-free)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: async (r) => `data:${r.mediaType};base64,${r.attachmentId}` },
    });
    await model.generate({
      systemPrompt: "s",
      messages: threeToolShots.slice(0, 5), // two shots only
      tools: [],
    });
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(2);
    const imageUrls = carriers.flat().filter((p) => p["type"] === "image_url");
    expect(imageUrls).toHaveLength(2);
    expect(JSON.stringify(carriers)).not.toContain("更早的截图已略");
  });

  it("USER images are outside the window: 3 on one turn → all 3 ride, no stub (zero drift)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: async (r) => `data:${r.mediaType};base64,${r.attachmentId}` },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [{ role: "user", content: "three of mine", images: [{ kind: "image", ref: ref("u1") }, { kind: "image", ref: ref("u2") }, { kind: "image", ref: ref("u3") }] }],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    const parts = (msgs[1] as { content: Record<string, unknown>[] }).content;
    expect(parts.filter((p) => p.type === "image_url")).toHaveLength(3);
    expect(JSON.stringify(parts)).not.toContain("更早的截图已略");
  });

  it("user + tool images coexist: the window touches ONLY the tool ones", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig(), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: async (r) => `data:${r.mediaType};base64,${r.attachmentId}` },
    });
    await model.generate({
      systemPrompt: "s",
      messages: [
        { role: "user", content: "mine", images: [{ kind: "image", ref: ref("u1") }] },
        ...threeToolShots.slice(1), // the three-shot tool phase
        ...fourToolShots,           // ω99-244: the 4th shot slides the K=3 window
      ],
      tools: [],
    });
    const msgs = cap.bodies[0]!.messages as Record<string, unknown>[];
    const userParts = (msgs[1] as { content: Record<string, unknown>[] }).content;
    expect(userParts.filter((p) => p.type === "image_url")).toHaveLength(1); // u1 rides untouched
    const carriers = carriersOf(cap.bodies[0]!);
    expect(carriers).toHaveLength(4);
    expect(carriers.flat().filter((p) => p["type"] === "image_url")).toHaveLength(3); // shot-2, shot-3, shot-4
    expect(carriers.flat().some((p) => p["type"] === "text" && p["text"] === "[更早的截图已略：仅保留最近 3 张]")).toBe(true);
  });

  it("text model + tool-result image → the typed refusal is UNCHANGED (degradation lives upstream)", async () => {
    const cap = captureFetch();
    const model = createOpenAICompatibleProvider(visionConfig({ model: "deepseek-v4-flash" }), {
      fetch: cap.fetch,
      attachments: { resolveDataUrl: async (r) => `data:${r.mediaType};base64,${r.attachmentId}` },
    });
    await expect(model.generate({
      systemPrompt: "s",
      messages: threeToolShots.slice(0, 3), // one tool shot at a text model
      tools: [],
    })).rejects.toMatchObject({ name: "UnsupportedContentError", reason: "model-no-image-modality" });
    expect(cap.calls()).toBe(0); // pre-I/O, as ever
  });
});
