// M47 §1 (B1) — the reasoning-replay contract. `reasoningReplay` picks when
// AssistantMessage.reasoning rides back out on the wire as
// `reasoning_content` (the DeepSeek-compatible request field):
//   never         (default) — byte-identical status quo, nothing replayed;
//   toolCallTurns — ONLY assistant messages carrying tool_calls;
//   always        — every assistant message that has reasoning.
// Byte discipline: the replayed bytes are the STORED bytes, verbatim.
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider, resolveProviderConfigResult } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

const TOOL_CALL = { id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } };

function historyInput(): Parameters<ReturnType<typeof createOpenAICompatibleProvider>["generate"]>[0] {
  return {
    systemPrompt: "s",
    tools: [],
    messages: [
      { role: "user", content: "do it" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }], reasoning: "THINK-BYTES-47" },
      { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
      { role: "assistant", content: "interim words", reasoning: "NON-TOOL REASONING" },
      { role: "user", content: "continue" },
    ],
  };
}

/** A fetch that captures the request body and answers a minimal completion.
 *  `cap.body` is read LIVE (the fetch swaps in the parsed object per call). */
function captureBody(): { fetch: typeof fetch; body: Record<string, unknown> } {
  const cap: { fetch?: typeof fetch; body: Record<string, unknown> } = { body: {} };
  cap.fetch = async (_url, init) => {
    cap.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { role: "assistant", content: "ok" } }] }),
    } as unknown as Response;
  };
  return cap as { fetch: typeof fetch; body: Record<string, unknown> };
}

function config(extra: Partial<ProviderConfig>): ProviderConfig {
  return { apiKey: "k", baseURL: "http://provider.test", model: "m", ...extra };
}

function wireMessages(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return (body.messages as Array<Record<string, unknown>>);
}

describe("reasoning replay — request wire shape", () => {
  it("never (default): no reasoning_content anywhere — byte-identical status quo", async () => {
    const cap = captureBody();
    const provider = createOpenAICompatibleProvider(config({}), { fetch: cap.fetch });
    await provider.generate(historyInput());
    const assistant = wireMessages(cap.body).filter((m) => m.role === "assistant");
    expect(assistant).toHaveLength(2);
    for (const m of assistant) expect("reasoning_content" in m).toBe(false);
    // The tool-call message keeps its pinned shape exactly.
    expect(assistant[0]).toEqual({ role: "assistant", content: "", tool_calls: [TOOL_CALL] });
  });

  it("toolCallTurns: replay rides ONLY the assistant message carrying tool_calls", async () => {
    const cap = captureBody();
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch: cap.fetch });
    await provider.generate(historyInput());
    const [toolTurn, textTurn] = wireMessages(cap.body).filter((m) => m.role === "assistant");
    expect(toolTurn?.reasoning_content).toBe("THINK-BYTES-47");
    expect(textTurn && "reasoning_content" in textTurn).toBe(false);
    // Key order: reasoning_content is appended AFTER the pinned fields, so the
    // replay never reshuffles the base message bytes.
    expect(Object.keys(toolTurn ?? {})).toEqual(["role", "content", "tool_calls", "reasoning_content"]);
  });

  it("always: every assistant message with reasoning is replayed", async () => {
    const cap = captureBody();
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "always" }), { fetch: cap.fetch });
    await provider.generate(historyInput());
    const [toolTurn, textTurn] = wireMessages(cap.body).filter((m) => m.role === "assistant");
    expect(toolTurn?.reasoning_content).toBe("THINK-BYTES-47");
    expect(textTurn?.reasoning_content).toBe("NON-TOOL REASONING");
  });

  it("an assistant message with no stored reasoning never gains the field", async () => {
    const cap = captureBody();
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "always" }), { fetch: cap.fetch });
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    expect(wireMessages(cap.body)[2]).toEqual({ role: "assistant", content: "hello" });
  });

  it("the streaming path posts the same replay shape as generate", async () => {
    const holder: { body: Record<string, unknown> } = { body: {} };
    const doFetch: typeof fetch = async (_url, init) => {
      holder.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n"));
          c.close();
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch: doFetch });
    const events = [];
    for await (const ev of provider.stream(historyInput())) events.push(ev);
    expect(events.at(-1)).toHaveProperty("type", "done");
    const toolTurn = wireMessages(holder.body).find((m) => m.role === "assistant" && "tool_calls" in m);
    expect(toolTurn?.reasoning_content).toBe("THINK-BYTES-47");
  });
});

// ω-2a GAP 2 — a client-capped reasoning tail (the 2M-char accumulator cap's
// in-band marker) is incomplete and NEVER replayed as complete on the wire.
describe("reasoning replay — capped tail is never replayed as complete (ω-2a)", () => {
  const CAP = 2_000_000;
  const MARK = "[truncated at 2M chars]";

  it("a tail capped by the accumulator never rides back out as reasoning_content", async () => {
    // Step 1: a degenerate 2M+-char reasoning response produces a capped, marked tail.
    const bigTail = "思".repeat(CAP + 1);
    const bigFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            reasoning_content: bigTail,
            tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a.txt\"}" } }],
          },
        }],
      }),
    })) as unknown as typeof fetch;
    const p1 = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch: bigFetch });
    const capped = await p1.generate({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] });
    expect(capped.reasoning?.endsWith(MARK)).toBe(true);

    // Step 2: the stored capped turn must not be replayed on a later request.
    const cap = captureBody();
    const usages: Array<Record<string, unknown>> = [];
    const p2 = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch: cap.fetch });
    await p2.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: capped.content, toolCalls: capped.toolCalls, reasoning: capped.reasoning },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
        { role: "user", content: "continue" },
      ],
      onUsage: (u) => usages.push(u as unknown as Record<string, unknown>),
    });
    const toolTurn = wireMessages(cap.body).find((m) => m.role === "assistant" && "tool_calls" in m);
    expect(toolTurn && "reasoning_content" in toolTurn).toBe(false); // never replayed as complete
    expect((toolTurn?.tool_calls as unknown[])).toHaveLength(1); // the turn itself stays wire-valid
    // Bytes never sent back out are never billed as replayed.
    expect(usages[0]?.reasoningReplayTokens).toBeUndefined();
  });

  it("a stored tail that merely CONTAINS the marker mid-string still replays verbatim", async () => {
    // Only a TAIL marker means client-capped — the check must not over-match.
    const cap = captureBody();
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch: cap.fetch });
    const stored = `thoughts ${MARK} and more`;
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }], reasoning: stored },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
        { role: "user", content: "continue" },
      ],
    });
    const toolTurn = wireMessages(cap.body).find((m) => m.role === "assistant" && "tool_calls" in m);
    expect(toolTurn?.reasoning_content).toBe(stored);
  });
});

describe("reasoning replay — resolution (WUDAO_REASONING_REPLAY)", () => {
  it("absent env → the key stays off the config (default never)", () => {
    const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k" });
    expect(r.ok && "reasoningReplay" in r.config).toBe(false);
  });

  // ω99-39: the mapping pins on an UNMARKED profile — deepseek caps
  // toolCallTurns/always to "never" (probe-verified drop; the o99-39 file
  // owns that family). The env→config contract itself is unchanged.
  it("env maps the three contract values (unmarked profile)", () => {
    for (const v of ["never", "toolCallTurns", "always"] as const) {
      const r = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm", WUDAO_REASONING_REPLAY: v });
      expect(r.ok ? r.config.reasoningReplay : undefined).toBe(v);
    }
  });

  it("empty string means absent; junk fails fast at resolution time", () => {
    const empty = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_REASONING_REPLAY: "" });
    expect(empty.ok && "reasoningReplay" in empty.config).toBe(false);
    expect(() => resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_REASONING_REPLAY: "sometimes" })).toThrow(/invalid reasoning replay/);
  });
});

// 夜移 011b — the CHAIN pin. The peel (夜移 011) and the replay contract
// (M47) each have their own tests, but the value proposition is the seam
// between them: CoT that arrives IN-BAND as turn-initial <think> in the
// content channel must end up on AssistantMessage.reasoning and ride back
// out as reasoning_content on the tool-call turn. Each half passing in
// isolation does not prove the bytes survive the round trip.
describe("reasoning replay — in-band peel chain (夜移 011b)", () => {
  it("stream-peeled CoT replays verbatim on the following tool-call turn", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const doFetch = (async (_url: unknown, init: { body?: string } | undefined) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) {
        // Turn 1 (streaming, qwen-chat-template lane): the think block is
        // in-band CONTENT straddling deltas, then a tool call in the same turn.
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"<think>IN"}}]}\n\n'));
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"NER</think>"}}]}\n\n'));
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]}}]}\n\n'));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      config({ reasoningFormat: "qwen-chat-template", reasoningReplay: "toolCallTurns" }),
      { fetch: doFetch },
    );

    // Turn 1: stream; keep the ASSEMBLED message (not hand-typed bytes).
    let doneMsg: { content: string; reasoning?: string; toolCalls?: Array<{ id: string; name: string; arguments: unknown }> } | undefined;
    for await (const ev of provider.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }] })) {
      if (ev.type === "done") doneMsg = ev.message as typeof doneMsg;
    }
    expect(bodies[0]?.stream).toBe(true);
    expect(doneMsg?.reasoning).toBe("INNER");
    expect(doneMsg?.content).toBe("");
    expect(doneMsg?.toolCalls?.[0]).toMatchObject({ id: "c1", name: "read_file" });
    // The peel also SPARES the missing-reasoning frozen replay: under
    // toolCallTurns a reasoning-less tool turn would have fired a second
    // stream request by now — exactly one request exists, the original.
    expect(bodies).toHaveLength(1);

    // Turn 2: the peeled message goes back into history verbatim.
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: doneMsg!.content, toolCalls: doneMsg!.toolCalls as { id: string; name: string; arguments: Record<string, unknown> }[], reasoning: doneMsg!.reasoning },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
        { role: "user", content: "continue" },
      ],
    });
    const toolTurn = wireMessages(bodies[1]!).find((m) => m.role === "assistant" && "tool_calls" in m);
    // The stored bytes — born in-band, peeled by 011 — replay verbatim.
    expect(toolTurn?.reasoning_content).toBe("INNER");
    expect((toolTurn?.tool_calls as Array<{ function: { name: string } }>)?.[0]?.function.name).toBe("read_file");
  });

  it("without the lane config the same stream leaves no reasoning to replay", async () => {
    // Control: identical wire traffic under a non-lane format peels nothing,
    // so a later replay request must show NO reasoning_content (the block
    // stays in content, untouched — 011's arm rule).
    const bodies: Array<Record<string, unknown>> = [];
    const doFetch = (async (_url: unknown, init: { body?: string } | undefined) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"<think>hidden</think>"}}]}\n\n'));
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{}"}}]}}]}\n\n'));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        });
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { role: "assistant", content: "done" } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const provider = createOpenAICompatibleProvider(
      config({ reasoningFormat: "deepseek", reasoningReplay: "always" }),
      { fetch: doFetch },
    );
    // reasoningEffort "none" is load-bearing: under a replay config a
    // reasoning-less tool turn otherwise triggers the missing-reasoning
    // frozen replay (a second stream fetch), which the none-effort request
    // legitimately suppresses — that branch is the model's no-reasoning shape.
    let doneMsg: { content: string; reasoning?: string; toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }> } | undefined;
    for await (const ev of provider.stream({ systemPrompt: "s", tools: [], messages: [{ role: "user", content: "go" }], reasoningEffort: "none" })) {
      if (ev.type === "done") doneMsg = ev.message as typeof doneMsg;
    }
    expect(doneMsg?.reasoning).toBeUndefined(); // nothing peeled
    expect(doneMsg?.content).toContain("<think>hidden</think>"); // block intact in content
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: doneMsg!.content, toolCalls: doneMsg!.toolCalls ?? [], reasoning: doneMsg!.reasoning },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
      ],
    });
    const assistantTurns = wireMessages(bodies[1]!).filter((m) => m.role === "assistant");
    for (const m of assistantTurns) expect("reasoning_content" in m).toBe(false);
  });
});
