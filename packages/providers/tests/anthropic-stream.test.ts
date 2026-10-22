// packages/providers/tests/anthropic-stream.test.ts
import { describe, it, expect } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createPersonaRuntime, resolvePersona } from "../src/persona/runtime.js";
import type { PersonaDefinition } from "../src/persona/types.js";

const cfg = { apiKey: "sk-an", baseURL: "https://api.anthropic.com", model: "claude-sonnet-5" };
const ccPersona: PersonaDefinition = {
  id: "cc-test", displayName: "CC",
  source: { kind: "workspace-source", provenance: "t", pinnedVersion: "1" },
  headers: { anthropic: { "anthropic-version": "2023-06-01", "user-agent": "claude-cli/2.1.0 (external, cli)" } },
};
const seeded = { sessionId: "s1", uuid: () => "u1", now: () => new Date("2026-08-23T00:00:00.000Z") };
const INPUT = { systemPrompt: "s", messages: [{ role: "user", content: "go" }], tools: [] };

function sseFetch(lines: string[], captured?: { url: string; init: RequestInit }[], sep = " "): typeof fetch {
  return (async (url: any, init: any) => {
    captured?.push({ url, init });
    const enc = new TextEncoder();
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          for (const l of lines) c.enqueue(enc.encode(`data:${sep}${l}\n\n`));
          c.close();
        },
      }),
    };
  }) as typeof fetch;
}
const EV = (o: unknown) => JSON.stringify(o);

describe("anthropic stream", () => {
  it("streams thinking/text deltas live and aggregates tool_use input_json_delta into done", async () => {
    const rt = createPersonaRuntime(resolvePersona(ccPersona), seeded);
    const model = createAnthropicProvider(cfg, {
      fetch: sseFetch([
        EV({ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } }),
        EV({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        EV({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pon" } }),
        EV({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "der" } }),
        EV({ type: "content_block_stop", index: 0 }),
        EV({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
        EV({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hel" } }),
        EV({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }),
        EV({ type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_2", name: "read_file" } }),
        EV({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"path":' } }),
        EV({ type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: ' "a"}' } }),
        EV({ type: "content_block_stop", index: 2 }),
        EV({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }),
        EV({ type: "message_stop" }),
      ]),
      personaRuntime: rt,
    });
    const kinds: string[] = [];
    let done: any;
    for await (const ev of model.stream!(INPUT as any)) { kinds.push(ev.type); if (ev.type === "done") done = ev.message; }
    expect(kinds.filter((k) => k === "done").length).toBe(1); // 恰好一个 done 收尾
    expect(kinds).toContain("reasoning_delta");
    expect(kinds).toContain("text_delta");
    expect(done.content).toBe("hello");
    expect(done.reasoning).toBe("ponder");
    expect(done.toolCalls).toEqual([{ id: "tu_2", name: "read_file", arguments: { path: "a" } }]);
    expect(done.stopReason).toBe("tool_calls");
  });
  it("0.3.35: no-space `data:` SSE lines (kimi gateway form) are parsed, not skipped", async () => {
    // SSE spec: after the field colon ONE optional leading space is stripped —
    // `data:{…}` (kimi api.kimi.com/coding) and `data: {…}` (real Anthropic)
    // are the same event. The strict `"data: "` prefix matched only the latter,
    // so every kimi data line was dropped → a completed-but-empty stream →
    // the driver's 空回复 nudge (user report 2026-08-31: kimi 有请求无返回).
    const model = createAnthropicProvider(cfg, {
      fetch: sseFetch([
        EV({ type: "message_start", message: { usage: { input_tokens: 12 } } }),
        EV({ type: "content_block_start", index: 0, content_block: { type: "thinking" } }),
        EV({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "pon" } }),
        EV({ type: "content_block_stop", index: 0 }),
        EV({ type: "content_block_start", index: 1, content_block: { type: "text" } }),
        EV({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hel" } }),
        EV({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "lo" } }),
        EV({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }),
        EV({ type: "message_stop" }),
      ], undefined, ""),
    });
    const kinds: string[] = [];
    let done: any;
    for await (const ev of model.stream!(INPUT as any)) { kinds.push(ev.type); if (ev.type === "done") done = ev.message; }
    expect(kinds).toContain("reasoning_delta");
    expect(kinds).toContain("text_delta");
    expect(done.content).toBe("hello");
    expect(done.reasoning).toBe("pon");
    expect(done.stopReason).toBe("stop");
  });
  it("carries persona headers on the streaming request", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const rt = createPersonaRuntime(resolvePersona(ccPersona), seeded);
    const model = createAnthropicProvider(cfg, { fetch: sseFetch([EV({ type: "message_start", message: { usage: { input_tokens: 1 } } }), EV({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }), EV({ type: "message_stop" })], cap), personaRuntime: rt });
    for await (const _ev of model.stream!(INPUT as any)) { /* drain */ }
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
    expect(JSON.parse(cap[0].init.body as string).stream).toBe(true);
  });
  it("bearerAuth config dual-sends authorization: Bearer on the streaming request too", async () => {
    const cap: { url: string; init: RequestInit }[] = [];
    const model = createAnthropicProvider({ ...cfg, bearerAuth: true }, { fetch: sseFetch([EV({ type: "message_start", message: { usage: { input_tokens: 1 } } }), EV({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }), EV({ type: "message_stop" })], cap) });
    for await (const _ev of model.stream!(INPUT as any)) { /* drain */ }
    const h = cap[0].init.headers as Record<string, string>;
    expect(h["x-api-key"]).toBe("sk-an");
    expect(h["authorization"]).toBe("Bearer sk-an");
  });
});
