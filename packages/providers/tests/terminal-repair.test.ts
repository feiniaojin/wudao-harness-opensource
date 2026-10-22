// M48 §2 — terminal-shape repair (Reasonix). Two degenerate finish shapes,
// one frozen byte-identical replay each, audited via ModelInput.onTerminalRepair:
//   reasoning-only   — reasoning present, content and tool_calls empty. On
//     providers that accept the shape (acceptsReasoningOnlyFinish, default
//     true on the deepseek/zai-format profiles) the finish does NOT end the
//     call: the same request is resent ONCE; a second degenerate finish
//     settles as-is.
//   missing-reasoning — a tool-call turn that carries no reasoning while the
//     replay contract is ON (toolCallTurns | always): one frozen replay.
import { describe, it, expect } from "vitest";
import { createOpenAICompatibleProvider, PROVIDER_PROFILES, resolveProviderConfigResult, omitsReasoningOnToolTurns } from "../src/index.js";
import type { ProviderConfig } from "../src/index.js";

function config(extra: Partial<ProviderConfig>): ProviderConfig {
  return { apiKey: "k", baseURL: "http://provider.test", model: "m", ...extra };
}

/** A scripted non-streaming fetch: `messages[i]` answers call i; captures
 *  every request body verbatim (for byte-identity assertions). */
function scriptedFetch(messages: Array<Record<string, unknown>>): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body));
    const message = messages[Math.min(call, messages.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    } as unknown as Response;
  };
  return { fetch: fetch as unknown as typeof fetch, bodies };
}

/** SSE body lines for one streamed message shape. */
function sse(message: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\ndata: [DONE]\n\n`;
}

function sseFetch(frames: string[]): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const fetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body));
    const frame = frames[Math.min(call, frames.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(frame));
          c.close();
        },
      }),
    } as unknown as Response;
  };
  return { fetch: fetch as unknown as typeof fetch, bodies };
}

const baseInput = {
  systemPrompt: "s",
  tools: [],
  messages: [{ role: "user" as const, content: "go" }],
};

// ---------------------------------------------------------------------------
// capability bit
// ---------------------------------------------------------------------------

describe("acceptsReasoningOnlyFinish — profile defaults", () => {
  it("deepseek / glm (zai) / wudao default true; qwen defaults false", () => {
    expect(PROVIDER_PROFILES.deepseek.acceptsReasoningOnlyFinish).toBe(true);
    expect(PROVIDER_PROFILES.glm.acceptsReasoningOnlyFinish).toBe(true);
    expect(PROVIDER_PROFILES.wudao.acceptsReasoningOnlyFinish).toBe(true);
    expect(PROVIDER_PROFILES.qwen.acceptsReasoningOnlyFinish).toBe(false);
  });

  it("resolveProviderConfig threads the profile default into the config", () => {
    const env = { WUDAO_API_KEY: "k" };
    const deepseek = resolveProviderConfigResult(env).config;
    expect(deepseek.acceptsReasoningOnlyFinish).toBe(true);
    const qwen = resolveProviderConfigResult({ ...env, WUDAO_PROVIDER: "qwen" }).config;
    expect(qwen.acceptsReasoningOnlyFinish).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generate: reasoning-only finish
// ---------------------------------------------------------------------------

describe("terminal repair — generate, reasoning-only finish", () => {
  it("replays the byte-identical request once and returns the recovered answer", async () => {
    const { fetch, bodies } = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "long thinking with no payload" },
      { role: "assistant", content: "THE REAL ANSWER" },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.content).toBe("THE REAL ANSWER");
    expect(repairs).toEqual(["reasoning-only"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]); // frozen replay: byte-identical
  });

  it("a second degenerate finish settles as-is (exactly one repair per call)", async () => {
    const { fetch, bodies } = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "still thinking" },
      { role: "assistant", content: "", reasoning_content: "still thinking again" },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.content).toBe("");
    expect(msg.reasoning).toBe("still thinking again");
    expect(repairs).toEqual(["reasoning-only"]);
    expect(bodies).toHaveLength(2);
  });

  it("no replay when the capability bit is off", async () => {
    const { fetch, bodies } = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "thinking" },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({}), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.content).toBe("");
    expect(msg.reasoning).toBe("thinking");
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it("a normal answer never triggers a repair", async () => {
    const { fetch, bodies } = scriptedFetch([{ role: "assistant", content: "fine" }]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(msg.content).toBe("fine");
    expect(bodies).toHaveLength(1);
  });

  it("an empty finish WITHOUT reasoning is not the reasoning-only shape", async () => {
    const { fetch, bodies } = scriptedFetch([{ role: "assistant", content: "" }]);
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// generate: missing-reasoning on a tool turn (replay contract on)
// ---------------------------------------------------------------------------

describe("terminal repair — generate, missing-reasoning tool turn", () => {
  const toolCallMessage = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };
  const toolCallWithReasoning = { ...toolCallMessage, reasoning_content: "plan first" };

  it("one frozen replay when the contract is toolCallTurns", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage, toolCallWithReasoning]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.reasoning).toBe("plan first");
    expect(repairs).toEqual(["missing-reasoning"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("no replay when the contract is never (default)", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage]);
    const provider = createOpenAICompatibleProvider(config({}), { fetch });
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(1);
  });

  it("no replay for a TEXT turn without reasoning (the contract only covers tool turns)", async () => {
    const { fetch, bodies } = scriptedFetch([{ role: "assistant", content: "plain text answer" }]);
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "always" }), { fetch });
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ω-2a GAP 1 — effort-aware gate (Reasonix 4de837d9a). A request actually sent
// with reasoning disabled (effective effort "none") legitimately produces tool
// turns WITHOUT reasoning: the empty-reasoning fallback applies — the turn
// settles as-is, no frozen replay on every tool turn.
// ---------------------------------------------------------------------------

describe("terminal repair — effort-aware missing-reasoning gate (ω-2a)", () => {
  const toolCallMessage = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };

  it("a none-effort REQUEST returning a reasoning-less tool turn does NOT replay", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch });
    const msg = await provider.generate({ ...baseInput, reasoningEffort: "none", onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.toolCalls).toHaveLength(1); // the valid tool call settles as-is
    expect(msg.reasoning).toBeUndefined();
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1); // no wasted frozen replay
  });

  it("a CONFIG-level effort 'none' gates the same way (the effective effort decides)", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns", reasoningEffort: "none" }), { fetch });
    await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it("a per-request effort BEATS a reasoning-enabled config (effective effort is request-level)", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage]);
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns", reasoningEffort: "high" }), { fetch });
    await provider.generate({ ...baseInput, reasoningEffort: "none" });
    expect(bodies).toHaveLength(1);
  });

  it("a none-effort STREAMING tool turn without reasoning does not replay", async () => {
    const { fetch, bodies } = sseFetch([
      sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] }),
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch });
    const events: Array<{ type: string; message?: { toolCalls?: unknown[] } }> = [];
    for await (const ev of provider.stream!({ ...baseInput, reasoningEffort: "none", onTerminalRepair: (k) => repairs.push(k) })) {
      events.push(ev as { type: string; message?: { toolCalls?: unknown[] } });
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.message?.toolCalls).toHaveLength(1);
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it("an explicit reasoning effort (high) still replays a reasoning-less tool turn — the gate is none-specific", async () => {
    const { fetch, bodies } = scriptedFetch([
      toolCallMessage,
      { ...toolCallMessage, reasoning_content: "plan first" },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch });
    const msg = await provider.generate({ ...baseInput, reasoningEffort: "high", onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.reasoning).toBe("plan first");
    expect(repairs).toEqual(["missing-reasoning"]);
    expect(bodies).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// ω-2a GAP 2 — capped ≠ complete (Reasonix 515026e11). A reasoning tail the
// CLIENT truncated at the 2M-char accumulator cap is incomplete: classified
// overflow (distinct from missing), never freeze-replayed, and never
// serialized back out as complete reasoning_content (wire shape pinned in
// reasoning-replay.test.ts).
// ---------------------------------------------------------------------------

describe("terminal repair — capped reasoning tail (ω-2a)", () => {
  const CAP = 2_000_000;
  const MARK = "[truncated at 2M chars]";

  it("a capped reasoning-only finish does NOT freeze-replay the incomplete tail", async () => {
    const { fetch, bodies } = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "想".repeat(CAP + 1) },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.reasoning?.endsWith(MARK)).toBe(true); // the marker stays in-band
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1); // fail closed: no frozen replay of an incomplete tail
  });

  it("a capped reasoning tool turn settles as-is — the valid tool call survives, no replay", async () => {
    const { fetch, bodies } = scriptedFetch([
      {
        role: "assistant",
        content: "",
        reasoning_content: "想".repeat(CAP + 1),
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }],
      },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ reasoningReplay: "toolCallTurns" }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.reasoning?.endsWith(MARK)).toBe(true);
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it("a capped reasoning-only STREAM does not freeze-replay at the done seam", async () => {
    const { fetch, bodies } = sseFetch([sse({ reasoning_content: "想".repeat(CAP + 1) })]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const events: Array<{ type: string; message?: { reasoning?: string } }> = [];
    for await (const ev of provider.stream!({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) })) {
      events.push(ev as { type: string; message?: { reasoning?: string } });
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.message?.reasoning?.endsWith(MARK)).toBe(true);
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// stream: same repair at the done seam
// ---------------------------------------------------------------------------

describe("terminal repair — stream", () => {
  it("reasoning-only stream replays once; the done message is the recovered one", async () => {
    const { fetch, bodies } = sseFetch([
      sse({ reasoning_content: "think" }),
      sse({ content: "RECOVERED" }),
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const events: Array<{ type: string; text?: string; message?: { content: string } }> = [];
    for await (const ev of provider.stream!({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) })) {
      events.push(ev as { type: string; text?: string; message?: { content: string } });
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.message?.content).toBe("RECOVERED");
    expect(repairs).toEqual(["reasoning-only"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("a healthy stream never repairs", async () => {
    const { fetch, bodies } = sseFetch([sse({ content: "ok" })]);
    const provider = createOpenAICompatibleProvider(config({ acceptsReasoningOnlyFinish: true }), { fetch });
    const events: Array<{ type: string }> = [];
    for await (const ev of provider.stream!(baseInput)) events.push(ev as { type: string });
    expect(events.filter((e) => e.type === "done")).toHaveLength(1);
    expect(bodies).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 夜移 022 — provider-legitimate reasoning omission on tool turns (GLM).
// Reasonix reasoning_replay_policy.go:13-24: zhipu may return a VALID
// thinking-enabled tool turn WITHOUT reasoning; replay is only required for
// turns that actually carried reasoning. wudao's flag mirrors the M48 §2
// capability-bit idiom: omitsReasoningOnToolTurns — explicit config > the
// selected profile's default > false; glm's builtin profile carries true.
// The missing-reasoning branch gains a THIRD independent no-replay reason,
// alongside ω-2a's effort-aware gate ("none"). The reasoning-only branch is
// NOT touched: that shape's authority stays acceptsReasoningOnlyFinish.
// ---------------------------------------------------------------------------

describe("terminal repair — omitsReasoningOnToolTurns (夜移 022, GLM)", () => {
  const toolCallMessage = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };
  const toolCallWithReasoning = { ...toolCallMessage, reasoning_content: "plan first" };

  /** The resolver-threaded glm config (profile default omits = true), with the
   *  replay contract forced on — exactly what a real glm session runs. */
  function glmConfig(extra: Partial<ProviderConfig> = {}): ProviderConfig {
    const resolved = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" }).config;
    return { ...resolved, reasoningReplay: "toolCallTurns", ...extra };
  }

  it("profile defaults: glm true; deepseek / qwen undefined (default false)", () => {
    expect(PROVIDER_PROFILES.glm.omitsReasoningOnToolTurns).toBe(true);
    expect(PROVIDER_PROFILES.deepseek.omitsReasoningOnToolTurns).toBeUndefined();
    expect(PROVIDER_PROFILES.qwen.omitsReasoningOnToolTurns).toBeUndefined();
  });

  it("resolver threads the profile default; the helper ladder is explicit > profile > false", () => {
    const glm = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" }).config;
    expect(glm.omitsReasoningOnToolTurns).toBe(true);
    expect(omitsReasoningOnToolTurns(glm)).toBe(true);
    // explicit false beats the profile default
    expect(omitsReasoningOnToolTurns(glmConfig({ omitsReasoningOnToolTurns: false }))).toBe(false);
    // no provider, no explicit field → false
    expect(omitsReasoningOnToolTurns(config({}))).toBe(false);
  });

  it("a reasoning-less tool turn on the glm profile does NOT replay (legitimate omission)", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(glmConfig(), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.toolCalls).toHaveLength(1); // the valid tool call settles as-is
    expect(msg.reasoning).toBeUndefined();
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1); // no wasted frozen replay on every tool turn
  });

  it("an explicit false overrides the glm profile — the frozen replay fires as before", async () => {
    const { fetch, bodies } = scriptedFetch([toolCallMessage, toolCallWithReasoning]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(glmConfig({ omitsReasoningOnToolTurns: false }), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.reasoning).toBe("plan first");
    expect(repairs).toEqual(["missing-reasoning"]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  });

  it("a reasoning-less STREAMING tool turn on the glm profile does not replay at the done seam", async () => {
    const { fetch, bodies } = sseFetch([
      sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] }),
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(glmConfig(), { fetch });
    const events: Array<{ type: string; message?: { toolCalls?: unknown[] } }> = [];
    for await (const ev of provider.stream!({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) })) {
      events.push(ev as { type: string; message?: { toolCalls?: unknown[] } });
    }
    const done = events.find((e) => e.type === "done");
    expect(done?.message?.toolCalls).toHaveLength(1);
    expect(repairs).toEqual([]);
    expect(bodies).toHaveLength(1);
  });

  it("the flag does NOT license the reasoning-only shape — glm still repairs that degenerate finish", async () => {
    const { fetch, bodies } = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "thinking only" },
      { role: "assistant", content: "RECOVERED" },
    ]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(glmConfig(), { fetch });
    const msg = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });

    expect(msg.content).toBe("RECOVERED");
    expect(repairs).toEqual(["reasoning-only"]);
    expect(bodies).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 夜移 023 — missing-reasoning session circuit (Reasonix warn-state adapted).
// The frozen replay is stateless today: during a sustained endpoint regression
// (every tool turn comes back reasoning-less) each turn burns TWO requests —
// the replay is proven useless and the next turn pays the same tax again. The
// circuit opens after a replay ALSO comes back missing; three consecutive
// healthy tool turns re-arm. Session-scoped, per provider leg.
// ---------------------------------------------------------------------------

describe("terminal repair — missing-reasoning session circuit (夜移 023)", () => {
  const circuitConfig = (extra: Partial<ProviderConfig> = {}): ProviderConfig => config({ reasoningReplay: "toolCallTurns", ...extra });
  const missingToolTurn = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };
  const healthyToolTurn = { ...missingToolTurn, reasoning_content: "plan first" };
  const plainAnswer = { role: "assistant", content: "answer" };

  it("A: sustained regression — the first failed replay opens the circuit, later turns settle with ONE fetch and no repair event", async () => {
    const { fetch, bodies } = scriptedFetch([missingToolTurn, missingToolTurn, missingToolTurn, missingToolTurn]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    const m1 = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies).toHaveLength(2);
    expect(repairs).toEqual(["missing-reasoning"]);
    expect(m1.reasoning).toBeUndefined();

    const before = bodies.length;
    const m2 = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies.length).toBe(before + 1);
    expect(m2.reasoning).toBeUndefined();

    const m3 = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies.length).toBe(before + 2);
    expect(m3.reasoning).toBeUndefined();

    expect(repairs).toEqual(["missing-reasoning"]);
    expect(bodies).toHaveLength(4);
  });

  it("B: three consecutive healthy tool turns re-arm the circuit — the next missing turn gets one fresh silent retry", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, missingToolTurn,           // call 1: replay also missing → opens
      healthyToolTurn, healthyToolTurn, healthyToolTurn, // calls 2-4: streak → re-arm
      missingToolTurn, healthyToolTurn,           // call 5: fresh retry, recovered
    ]);
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    await provider.generate(baseInput);
    expect(bodies).toHaveLength(2);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    const m4 = await provider.generate(baseInput);
    expect(bodies).toHaveLength(5);
    expect(m4.reasoning).toBe("plan first");

    const m5 = await provider.generate(baseInput);
    expect(bodies).toHaveLength(7);
    expect(m5.reasoning).toBe("plan first");
  });

  it("C: a suppressed missing observation resets the re-arm streak — intermittent regressions need three consecutive healthy turns again", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, missingToolTurn,   // call 1: opens
      healthyToolTurn, healthyToolTurn,   // calls 2-3: streak 2
      missingToolTurn,                    // call 4: suppressed (1 fetch), streak → 0
      healthyToolTurn, healthyToolTurn,   // calls 5-6: streak 2
      missingToolTurn,                    // call 7: STILL suppressed (1 fetch) — the pin
    ]);
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    await provider.generate(baseInput);
    expect(bodies).toHaveLength(2);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(5);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(8);
  });

  it("D (divergence pin): a RECOVERED replay does not open the circuit — the next missing turn still gets its retry", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, healthyToolTurn,   // call 1: retry recovers → circuit stays closed
      missingToolTurn, healthyToolTurn,   // call 2: missing again → retry again (the pin)
    ]);
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    const m1 = await provider.generate(baseInput);
    expect(m1.reasoning).toBe("plan first");
    expect(bodies).toHaveLength(2);

    const m2 = await provider.generate(baseInput);
    expect(m2.reasoning).toBe("plan first");
    expect(bodies).toHaveLength(4);
  });

  it("E: the same circuit applies at the STREAMING done seam — a sustained regression settles the second call with ONE fetch", async () => {
    const toolCallFrame = sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] });
    const { fetch, bodies } = sseFetch([toolCallFrame, toolCallFrame, toolCallFrame]);
    const repairs: string[] = [];
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    const drain = async () => {
      const events: Array<{ type: string; message?: { toolCalls?: unknown[]; reasoning?: unknown } }> = [];
      for await (const ev of provider.stream!({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) })) {
        events.push(ev as { type: string; message?: { toolCalls?: unknown[]; reasoning?: unknown } });
      }
      return events;
    };
    const done1 = (await drain()).find((e) => e.type === "done");
    expect(done1?.message?.toolCalls).toHaveLength(1);
    expect(bodies).toHaveLength(2);
    expect(repairs).toEqual(["missing-reasoning"]);

    const done2 = (await drain()).find((e) => e.type === "done");
    expect(done2?.message?.toolCalls).toHaveLength(1);
    expect(bodies).toHaveLength(3);
    expect(repairs).toEqual(["missing-reasoning"]);
  });

  it("F (negative space): an open circuit does NOT suppress the reasoning-only repair — that shape keeps its own authority", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, missingToolTurn, missingToolTurn, // call 1: opens; call 2: suppressed
      { role: "assistant", content: "", reasoning_content: "thinking only" },
      { role: "assistant", content: "RECOVERED" },      // call 3: reasoning-only still replays
    ]);
    const repairs: string[] = [];
    // acceptsReasoningOnlyFinish gates that repair lane (deepseek/zai default
    // true) — without it the shape is not a repair kind at all on this config.
    const provider = createOpenAICompatibleProvider(circuitConfig({ acceptsReasoningOnlyFinish: true }), { fetch });

    await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies).toHaveLength(2);
    await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies).toHaveLength(3);
    expect(repairs).toEqual(["missing-reasoning"]);

    const m3 = await provider.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    expect(bodies).toHaveLength(5);
    expect(m3.content).toBe("RECOVERED");
    expect(repairs).toEqual(["missing-reasoning", "reasoning-only"]);
  });

  it("G: plain-text answers do not count toward the re-arm streak", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, missingToolTurn,   // call 1: opens
      plainAnswer, plainAnswer,           // calls 2-3: not tool turns — not counted
      healthyToolTurn, healthyToolTurn,   // calls 4-5: streak 2
      missingToolTurn,                    // call 6: STILL suppressed (1 fetch) — the pin
    ]);
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    await provider.generate(baseInput);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(6);
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(7);
  });

  it("H: effort=none turns do not count toward the re-arm streak (the contract was not in force)", async () => {
    const { fetch, bodies } = scriptedFetch([
      missingToolTurn, missingToolTurn,   // call 1 (high effort default): opens
      missingToolTurn, missingToolTurn, missingToolTurn, // calls 2-4 at effort none: legitimate no-reasoning shape — not counted
      missingToolTurn,                    // call 5: STILL suppressed (1 fetch) — the pin
    ]);
    const provider = createOpenAICompatibleProvider(circuitConfig(), { fetch });

    await provider.generate(baseInput);
    expect(bodies).toHaveLength(2);
    const noneInput = { ...baseInput, reasoningEffort: "none" as const };
    await provider.generate(noneInput);
    await provider.generate(noneInput);
    await provider.generate(noneInput);
    expect(bodies).toHaveLength(5);
    await provider.generate(baseInput);
    expect(bodies).toHaveLength(6);
  });
});
