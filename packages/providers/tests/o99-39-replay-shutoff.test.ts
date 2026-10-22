// ω99-39 — per-provider reasoning-replay shutoff. Probe fact (ω99-33 §5.2,
// 7-leg live probe, DeepSeek v4-flash): client-sent `reasoning_content` is
// completely uncounted and cache-inert on DeepSeek — serializing replay
// bytes is pure waste and silently defeats the user's WUDAO_REASONING_REPLAY
// intent. The profile fact `dropsClientReasoningReplay` (deepseek only —
// GLM/Qwen/wudao are UNPROBED and must stay byte-identical) forces the
// effective replay to never at the config resolution seam, with one stderr
// line telling the user why. Evidence citations point at the brief §0; no
// live probe is re-run here (zero network discipline).
import { describe, it, expect, vi, afterEach } from "vitest";
import type { ProviderConfig } from "../src/index.js";

type ProvidersModule = typeof import("../src/index.js");

/** Fresh module registry so the once-per-process notice guard starts ARMED
 *  in every test (vi.resetModules + dynamic import = a new config.ts
 *  instance). All resolution-derived helpers come from this one instance. */
async function freshModule(): Promise<ProvidersModule> {
  vi.resetModules();
  return await import("../src/index.js");
}

const HISTORY = [
  { role: "user", content: "do it" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }], reasoning: "THINK-BYTES-39" },
  { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
  { role: "user", content: "continue" },
] as unknown as Parameters<ReturnType<ProvidersModule["createOpenAICompatibleProvider"]>["generate"]>[0]["messages"];

function inputOf(mod: ProvidersModule, onUsage?: (u: unknown) => void): Parameters<ReturnType<ProvidersModule["createOpenAICompatibleProvider"]>["generate"]>[0] {
  return { systemPrompt: "s", tools: [], messages: HISTORY, ...(onUsage ? { onUsage } : {}) };
}

/** A fetch capturing the request body; answers a minimal completion. */
function captureFetch(usages?: Array<Record<string, unknown>>): { fetch: typeof fetch; bodies: Array<Record<string, unknown>> } {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: unknown, init: { body?: string } | undefined) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: "ok" } }],
        ...(usages ? { usage: { prompt_tokens: 5, completion_tokens: 1 } } : {}),
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetch, bodies };
}

const assistantTurns = (body: Record<string, unknown>): Array<Record<string, unknown>> =>
  (body.messages as Array<Record<string, unknown>>).filter((m) => m.role === "assistant");

function spyStderr(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("o99-39 — deepseek shutoff at the resolution seam", () => {
  it("RED-① deepseek + WUDAO_REASONING_REPLAY=toolCallTurns → the wire carries NO reasoning_content", async () => {
    const mod = await freshModule();
    const r = mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "toolCallTurns" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.reasoningReplay).toBe("never"); // the profile fact caps intent
    const cap = captureFetch();
    const provider = mod.createOpenAICompatibleProvider(r.config, { fetch: cap.fetch });
    await provider.generate(inputOf(mod));
    const toolTurn = assistantTurns(cap.bodies[0]!).find((m) => "tool_calls" in m);
    expect(toolTurn && "reasoning_content" in toolTurn).toBe(false); // probe-verified drop — no wasted bytes
  });

  it("RED-② a shutoff notice rides stderr, exactly one line, once per process", async () => {
    const mod = await freshModule();
    const err = spyStderr();
    const env = { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "toolCallTurns" } as NodeJS.ProcessEnv;
    const r1 = mod.resolveProviderConfigResult(env);
    const r2 = mod.resolveProviderConfigResult(env); // a second resolution in the same process
    expect(r1.ok && r2.ok).toBe(true);
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("WUDAO_REASONING_REPLAY"));
    expect(lines).toHaveLength(1); // honest tell: present, and never spammy
    expect(lines[0]).toContain("never");
  });

  it("the forensic receipt agrees with the wire: no reasoningReplayTokens on deepseek", async () => {
    const mod = await freshModule();
    spyStderr();
    const r = mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "toolCallTurns" });
    if (!r.ok) return;
    const usages: Array<Record<string, unknown>> = [];
    const cap = captureFetch(usages);
    const provider = mod.createOpenAICompatibleProvider(r.config, { fetch: cap.fetch });
    await provider.generate(inputOf(mod, (u) => usages.push(u as Record<string, unknown>)));
    expect(usages[0]?.reasoningReplayTokens).toBeUndefined(); // 0 sent = 0 billed (case A: one config field, both faces agree)
  });

  it("no notice without an explicit replay≠never (absent env / explicit never / junk-throws keep their shapes)", async () => {
    const mod = await freshModule();
    const err = spyStderr();
    expect(mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek" }).ok).toBe(true);
    expect(mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "never" }).ok).toBe(true);
    expect(() => mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "sometimes" })).toThrow(/invalid reasoning replay/);
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("WUDAO_REASONING_REPLAY"))).toHaveLength(0);
  });

  it("a client-capped tail settles as-is under the capped replay — no frozen second request", async () => {
    // T0 equivalence pin: pre-ω99-39 the capped tail classified "overflow"
    // (settle-as-is); post-normalization it falls to undefined — the caller's
    // treatment is identical either way. One request, marker stays in-band.
    const mod = await freshModule();
    spyStderr();
    const r = mod.resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "deepseek", WUDAO_REASONING_REPLAY: "toolCallTurns" });
    if (!r.ok) return;
    const cap = captureFetch();
    const provider = mod.createOpenAICompatibleProvider(r.config, { fetch: cap.fetch });
    const capped = "思".repeat(2_000_001);
    await provider.generate({
      systemPrompt: "s",
      tools: [],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a.txt" } }], reasoning: capped },
        { role: "tool", toolCallId: "c1", name: "read_file", content: "file a" },
        { role: "user", content: "continue" },
      ] as unknown as Parameters<ReturnType<ProvidersModule["createOpenAICompatibleProvider"]>["generate"]>[0]["messages"],
    });
    expect(cap.bodies).toHaveLength(1); // no repair replay fired
  });
});

describe("o99-39 — unprobed providers stay byte-identical (red line)", () => {
  const UNMARKED = [
    { id: "glm", url: undefined },
    { id: "qwen", url: undefined },
    { id: "wudao", url: "http://wudao.test" },
    { id: "anthropic", url: undefined },
  ] as const;

  it("resolution passes the replay contract through untouched on every unmarked profile", async () => {
    const mod = await freshModule();
    const err = spyStderr();
    for (const p of UNMARKED) {
      const r = mod.resolveProviderConfigResult({
        WUDAO_API_KEY: "k",
        WUDAO_PROVIDER: p.id,
        ...(p.url ? { WUDAO_BASE_URL: p.url } : {}),
        WUDAO_REASONING_REPLAY: "toolCallTurns",
      });
      expect(r.ok, p.id).toBe(true);
      if (r.ok) expect(r.config.reasoningReplay, p.id).toBe("toolCallTurns"); // no profile fact to cap
    }
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("WUDAO_REASONING_REPLAY"))).toHaveLength(0);
  });

  it("the openai-wire unmarked profiles still replay verbatim on the wire", async () => {
    const mod = await freshModule();
    spyStderr();
    for (const id of ["glm", "qwen", "wudao"] as const) {
      const r = mod.resolveProviderConfigResult({
        WUDAO_API_KEY: "k",
        WUDAO_PROVIDER: id,
        ...(id === "wudao" ? { WUDAO_BASE_URL: "http://wudao.test" } : {}),
        WUDAO_REASONING_REPLAY: "toolCallTurns",
      });
      if (!r.ok) continue;
      const cap = captureFetch();
      const provider = mod.createOpenAICompatibleProvider(r.config, { fetch: cap.fetch });
      await provider.generate(inputOf(mod));
      const toolTurn = assistantTurns(cap.bodies[0]!).find((m) => "tool_calls" in m);
      expect(toolTurn?.reasoning_content, id).toBe("THINK-BYTES-39"); // M47 bytes untouched
    }
  });

  it("a hand-built config keeps its explicit replay (the cap lives at resolution, not the engine)", async () => {
    const mod = await freshModule();
    const cap = captureFetch();
    const handBuilt: ProviderConfig = { apiKey: "k", baseURL: "http://provider.test", model: "m", provider: "deepseek", reasoningReplay: "toolCallTurns" };
    const provider = mod.createOpenAICompatibleProvider(handBuilt, { fetch: cap.fetch });
    await provider.generate(inputOf(mod));
    const toolTurn = assistantTurns(cap.bodies[0]!).find((m) => "tool_calls" in m);
    expect(toolTurn?.reasoning_content).toBe("THINK-BYTES-39"); // engine unchanged — only the seam caps
  });

  it("a registry custom provider is untouched by the builtin fact (no probe, no cap)", async () => {
    const mod = await freshModule();
    const err = spyStderr();
    // The builtin pin never reaches a custom: UserProviderConfig cannot carry
    // the field (sanitized on read) and effectiveProfiles builds customs
    // without it — the cap stays a probe-backed builtin fact, not a knob.
    const customs = new Map();
    customs.set("my-gateway", {
      baseUrl: "http://gw.test/v1",
      defaultModel: "gw-model",
    });
    const profiles = mod.effectiveProfiles(customs);
    const r = mod.resolveProviderConfigResult(
      { WUDAO_API_KEY: "k", WUDAO_PROVIDER: "my-gateway", WUDAO_REASONING_REPLAY: "always" },
      {},
      undefined,
      profiles,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.config.reasoningReplay).toBe("always"); // intent verbatim on a custom
    expect(err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("WUDAO_REASONING_REPLAY"))).toHaveLength(0);
  });
});
