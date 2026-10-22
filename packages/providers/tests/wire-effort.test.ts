// R2 T2 — reasoningEffort mapping on the anthropic / responses wires.
// ModelInput.reasoningEffort (per-request, M58 §C) and the config's own
// reasoningEffort were both IGNORED by these adapters: the effort never
// reached the wire. Now:
//   anthropic  effort → thinking: { type: "enabled", budget_tokens } with
//              the budget table (low 1024 / medium 2048 / high 8192 /
//              max 32768; floor 1024 is the API's documented minimum).
//              max_tokens is raised to budget+1024 when the resolved cap
//              would sit at or below the budget — the API structurally
//              requires max_tokens > budget_tokens, so an unbumped body can
//              never be served. wire-r2 follow-up ① narrows this: the raise
//              survives ONLY for the adapter's own implicit default cap; an
//              EXPLICIT maxTokens (input or config) at/below the budget now
//              fails closed with MaxTokensThinkingBudgetConflictError.
//   responses  effort → reasoning: { effort } (the native same-name enum).
//   none       → no field on either wire (anthropic omits `thinking` to
//              disable it; responses has no "none" enum member).
//   absent     → NO new key, byte-identical status quo (prefix-cache red
//              line: the keys appear only when an effort is explicit).
// Junk input effort fails fast BEFORE the retry ladder (the engine's
// validatedInputEffort contract) — never retried, never on the wire.
import { describe, it, expect } from "vitest";
import { createAnthropicProvider } from "../src/anthropic.js";
import { createResponsesProvider } from "../src/responses.js";
import { MaxTokensThinkingBudgetConflictError } from "../src/index.js";
import { isModelFallbackEligible } from "../src/model-failure.js";
// conflict-origin: the marker field name's single source is the core port
// constant — the class stamps under this computed name (seam pin below).
import { CONFIG_CAP_ALSO_CONFLICTS_FIELD } from "@wudao/core";

/** A fetch that must never run — a fail-closed request-construction gate
 *  fires before any network byte. */
function neverFetch(): { fetch: typeof fetch; calls: () => number } {
  let n = 0;
  const f = (async () => {
    n += 1;
    throw new Error("fetch must not be reached");
  }) as typeof fetch;
  return { fetch: f, calls: () => n };
}

const AN = { apiKey: "k", baseURL: "https://x", model: "claude-sonnet-5" };
const RS = { apiKey: "k", baseURL: "https://x/v1", model: "gpt-5.3-the upstream project" };
const INPUT = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi" }], tools: [] };

function genFetch(captured: Record<string, unknown>[], payload: unknown): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)));
    return { ok: true, status: 200, json: async () => payload };
  }) as typeof fetch;
}

async function anthropicBody(input: Record<string, unknown> = {}, config = AN): Promise<Record<string, unknown>> {
  const cap: Record<string, unknown>[] = [];
  const model = createAnthropicProvider(config, { fetch: genFetch(cap, { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }) });
  await model.generate({ ...INPUT, ...input } as never);
  return cap[0];
}

async function responsesBody(input: Record<string, unknown> = {}, config = RS): Promise<Record<string, unknown>> {
  const cap: Record<string, unknown>[] = [];
  const model = createResponsesProvider(config, { fetch: genFetch(cap, { output: [] }) });
  await model.generate({ ...INPUT, ...input } as never);
  return cap[0];
}

function sseFetch(captured: Record<string, unknown>[], lines: string[]): typeof fetch {
  return (async (_url: unknown, init: RequestInit) => {
    captured.push(JSON.parse(String(init.body)));
    const enc = new TextEncoder();
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({ start(c) { for (const l of lines) c.enqueue(enc.encode(`data: ${l}\n\n`)); c.close(); } }),
    };
  }) as typeof fetch;
}

describe("anthropic wire — effort → thinking budget_tokens", () => {
  it("input effort=high maps thinking:{enabled, 8192} and raises max_tokens above the budget", async () => {
    const body = await anthropicBody({ reasoningEffort: "high" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    // Default cap 4096 would sit BELOW the 8192 budget — the API requires
    // max_tokens > budget_tokens, so the cap is raised (budget + 1024).
    expect(body.max_tokens).toBe(9216);
  });

  it("effort=low maps budget 1024 (the API floor) and leaves the default cap untouched", async () => {
    const body = await anthropicBody({ reasoningEffort: "low" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.max_tokens).toBe(4096);
  });

  it("config effort applies when the input carries none (medium → 2048)", async () => {
    const body = await anthropicBody({}, { ...AN, reasoningEffort: "medium" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
    expect(body.max_tokens).toBe(4096);
  });

  it("input effort OVERRIDES the config effort (engine's M58 §C semantics)", async () => {
    const body = await anthropicBody({ reasoningEffort: "high" }, { ...AN, reasoningEffort: "low" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
  });

  it("effort=max maps budget 32768 and raises max_tokens accordingly", async () => {
    const body = await anthropicBody({ reasoningEffort: "max" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 32768 });
    expect(body.max_tokens).toBe(33792);
  });

  it("no effort anywhere = no thinking key, byte-identical default body", async () => {
    const body = await anthropicBody();
    expect(Object.keys(body)).toEqual(["model", "max_tokens", "system", "messages", "tools"]);
    expect("thinking" in body).toBe(false);
    expect(body.max_tokens).toBe(4096);
  });

  it("effort=none = no thinking key (anthropic omits the field to disable thinking)", async () => {
    const body = await anthropicBody({ reasoningEffort: "none" });
    expect("thinking" in body).toBe(false);
    expect(body.max_tokens).toBe(4096);
  });

  it("an explicit maxTokens above the budget is respected verbatim", async () => {
    const body = await anthropicBody({ reasoningEffort: "low", maxTokens: 2000 });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(body.max_tokens).toBe(2000);
  });

  it("an explicit maxTokens at/below the budget FAILS CLOSED (wire-r2 follow-up ①: a chosen cap is never silently rewritten)", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider(AN, { fetch: nf.fetch });
    await expect(model.generate({ ...INPUT, reasoningEffort: "high", maxTokens: 2000 } as never)).rejects.toThrow(
      MaxTokensThinkingBudgetConflictError,
    );
    expect(nf.calls()).toBe(0);
  });

  it("stream path carries the same thinking mapping (plus stream:true)", async () => {
    const cap: Record<string, unknown>[] = [];
    const model = createAnthropicProvider(AN, { fetch: sseFetch(cap, [JSON.stringify({ type: "message_stop" })]) });
    for await (const _ev of model.stream!({ ...INPUT, reasoningEffort: "high" } as never)) {
      // drain
    }
    expect(cap[0].thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(cap[0].stream).toBe(true);
  });
});

// wire-r2 follow-up ① — the fail-closed narrowing. An EXPLICIT maxTokens
// (input.maxTokens OR config.maxTokens — either is a cap someone chose)
// sitting at/below the thinking budget implied by reasoningEffort used to
// be silently raised to budget+1024; silently rewriting a value the caller
// set is the fail-closed tension the wire-r2 review flagged. It now throws
// the typed MaxTokensThinkingBudgetConflictError BEFORE the retry ladder
// (validatedInputEffort's spot: a deterministic config conflict never
// sleeps, never hits the wire) and is never model-fallback-eligible
// (switching models re-hits the identical conflict). The adapter's own
// IMPLICIT default cap keeps the historic raise — pinned below.
describe("explicit maxTokens × thinking budget — fail-closed narrowing (wire-r2 follow-up ①)", () => {
  it("explicit maxTokens=2048 + effort=high (budget 8192) throws the typed error carrying all three values — never fetches", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider(AN, { fetch: nf.fetch });
    let err: unknown;
    try {
      await model.generate({ ...INPUT, reasoningEffort: "high", maxTokens: 2048 } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MaxTokensThinkingBudgetConflictError);
    const typed = err as MaxTokensThinkingBudgetConflictError;
    expect(typed.maxTokens).toBe(2048);
    expect(typed.budgetTokens).toBe(8192);
    // The message carries the three values: the explicit cap, the budget,
    // and the fix ("raise maxTokens … or lower reasoningEffort").
    expect(typed.message).toContain("2048");
    expect(typed.message).toContain("8192");
    expect(typed.message).toMatch(/raise maxTokens above the thinking budget or lower reasoningEffort/);
    expect(nf.calls()).toBe(0);
  });

  // F1 (clip-conflict): the string seam — core's loop duck-types THIS code to
  // route computed-cap conflicts (the admission clip / the clip-retry's
  // physical) into the reactive compact ladder instead of hard-failing. The
  // stamp itself is the core-owned constant; pinning the LITERAL here is what
  // makes a rename of that constant loud (core's routing would silently stop
  // matching the stamp otherwise).
  it("carries the stable cross-package code stamp core duck-types (F1 seam pin)", () => {
    const err = new MaxTokensThinkingBudgetConflictError(2048, 8192);
    expect(err.code).toBe("MAXTOKENS_THINKING_BUDGET_CONFLICT");
  });

  it("explicit maxTokens=16384 + effort=high is served verbatim (budget < cap — no conflict)", async () => {
    const body = await anthropicBody({ reasoningEffort: "high", maxTokens: 16384 });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBe(16384);
  });

  it("implicit default cap (no maxTokens anywhere) + effort=high KEEPS the historic raise — regression pin", async () => {
    const body = await anthropicBody({ reasoningEffort: "high" });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8192 });
    expect(body.max_tokens).toBe(9216); // 8192 + 1024, byte-for-byte the pre-narrowing behavior
  });

  it("the stream path fails closed identically (both request paths share the gate)", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider(AN, { fetch: nf.fetch });
    const it = model.stream!({ ...INPUT, reasoningEffort: "high", maxTokens: 2048 } as never)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toThrow(MaxTokensThinkingBudgetConflictError);
    expect(nf.calls()).toBe(0);
  });

  it("an explicit cap from the CONFIG is equally explicit (input absent, config.maxTokens at/below budget)", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider({ ...AN, maxTokens: 2048 }, { fetch: nf.fetch });
    await expect(model.generate({ ...INPUT, reasoningEffort: "high" } as never)).rejects.toThrow(
      MaxTokensThinkingBudgetConflictError,
    );
    expect(nf.calls()).toBe(0);
  });

  it("the conflict is never model-fallback-eligible (a sibling model hits the identical conflict)", () => {
    expect(isModelFallbackEligible(new MaxTokensThinkingBudgetConflictError(2048, 8192))).toBe(false);
  });
});

// conflict-origin — the config-cap marker on the typed conflict. The gate
// knows whether the caller-chosen PERSISTENT cap (config.maxTokens — the cap
// that survives clip-dropping AND compaction) also sits at/below the
// thinking budget; when it does, core's reactive compact ladder is
// pre-doomed (the post-compact resend's cap resolves back to the config cap
// and re-conflicts before the wire), so the conflict carries a marker and
// the loop skips the futile compact on it. The field NAME is core-owned
// (CONFIG_CAP_ALSO_CONFLICTS_FIELD) — the class declares its field under
// that computed name; the literal is pinned HERE so a value drift of the
// core constant goes loud on this side too (core pins it in model-client).
describe("conflict-origin — config.maxTokens also-conflicting marker", () => {
  /** Capture the typed conflict off a generate that must fail pre-wire. */
  async function conflictError(input: Record<string, unknown>, config = AN): Promise<MaxTokensThinkingBudgetConflictError> {
    const nf = neverFetch();
    const model = createAnthropicProvider(config, { fetch: nf.fetch });
    try {
      await model.generate({ ...INPUT, ...input } as never);
    } catch (e) {
      return e as MaxTokensThinkingBudgetConflictError;
    }
    throw new Error("the conflict gate did not throw");
  }

  it("config.maxTokens at/below the budget stamps the marker TRUE (input carries no cap)", async () => {
    const err = await conflictError({ reasoningEffort: "high" }, { ...AN, maxTokens: 2048 });
    expect(err).toBeInstanceOf(MaxTokensThinkingBudgetConflictError);
    // Present and literally true — via the core-owned field name AND the
    // pinned literal (the field name's single source is core).
    expect(err[CONFIG_CAP_ALSO_CONFLICTS_FIELD]).toBe(true);
    expect("configCapAlsoConflicts" in err).toBe(true);
  });

  it("the double-cap corner (conflicting input cap AND conflicting config cap) stamps TRUE — the marker core's skip reads", async () => {
    // input.maxTokens 2000 (core's admission clip shape) conflicts; the
    // persistent config cap 2048 ALSO sits below the 8192 budget — the
    // corner where dropping the clip + compacting is pre-doomed.
    const err = await conflictError({ reasoningEffort: "high", maxTokens: 2000 }, { ...AN, maxTokens: 2048 });
    expect(err.maxTokens).toBe(2000); // the explicit cap that conflicted
    expect(err[CONFIG_CAP_ALSO_CONFLICTS_FIELD]).toBe(true);
  });

  it("config.maxTokens ABSENT (input cap conflicts alone) stamps NOTHING — byte-equivalent unmarked shape", async () => {
    const err = await conflictError({ reasoningEffort: "high", maxTokens: 2048 });
    expect(err).toBeInstanceOf(MaxTokensThinkingBudgetConflictError);
    expect(err[CONFIG_CAP_ALSO_CONFLICTS_FIELD]).toBeUndefined();
    expect("configCapAlsoConflicts" in err).toBe(false);
  });

  it("config.maxTokens set but ABOVE the budget stamps NOTHING (only the input cap conflicts)", async () => {
    const err = await conflictError({ reasoningEffort: "high", maxTokens: 2048 }, { ...AN, maxTokens: 16384 });
    expect(err).toBeInstanceOf(MaxTokensThinkingBudgetConflictError);
    expect("configCapAlsoConflicts" in err).toBe(false);
  });

  it("field-name seam pin — the class field exists under the core constant's name, literal-pinned", () => {
    const marked = new MaxTokensThinkingBudgetConflictError(2048, 8192, true);
    expect(marked[CONFIG_CAP_ALSO_CONFLICTS_FIELD]).toBe(true);
    expect("configCapAlsoConflicts" in marked).toBe(true);
    // Pre-existing 2-arg constructions stay byte-identical: the key is
    // entirely ABSENT when the marker is false (omit-never-null).
    const unmarked = new MaxTokensThinkingBudgetConflictError(2048, 8192);
    expect("configCapAlsoConflicts" in unmarked).toBe(false);
  });
});

describe("responses wire — effort → reasoning effort", () => {
  it("input effort=high maps reasoning:{effort:'high'}", async () => {
    const body = await responsesBody({ reasoningEffort: "high" });
    expect(body.reasoning).toEqual({ effort: "high" });
  });

  it("config effort applies when the input carries none (input-override semantics shared)", async () => {
    const body = await responsesBody({ reasoningEffort: "low" }, { ...RS, reasoningEffort: "medium" });
    expect(body.reasoning).toEqual({ effort: "low" });
    const cfgOnly = await responsesBody({}, { ...RS, reasoningEffort: "medium" });
    expect(cfgOnly.reasoning).toEqual({ effort: "medium" });
  });

  it("no effort anywhere = no reasoning key, byte-identical default body", async () => {
    const body = await responsesBody();
    expect(Object.keys(body)).toEqual(["model", "instructions", "input", "tools"]);
    expect("reasoning" in body).toBe(false);
  });

  it("effort=none = no reasoning key (no such enum member on the wire)", async () => {
    const body = await responsesBody({ reasoningEffort: "none" });
    expect("reasoning" in body).toBe(false);
  });

  it("stream path carries the same reasoning mapping (plus stream:true)", async () => {
    const cap: Record<string, unknown>[] = [];
    const model = createResponsesProvider(RS, {
      fetch: sseFetch(cap, [JSON.stringify({ type: "response.completed", response: { usage: {}, output: [] } })]),
    });
    for await (const _ev of model.stream!({ ...INPUT, reasoningEffort: "high" } as never)) {
      // drain
    }
    expect(cap[0].reasoning).toEqual({ effort: "high" });
    expect(cap[0].stream).toBe(true);
  });
});

describe("junk input effort fails fast (never walks the ladder, never hits the wire)", () => {
  it("anthropic: throws the parse error and never fetches", async () => {
    const nf = neverFetch();
    const model = createAnthropicProvider(AN, { fetch: nf.fetch });
    await expect(model.generate({ ...INPUT, reasoningEffort: "ultra" } as never)).rejects.toThrow(/invalid reasoning effort "ultra"/);
    expect(nf.calls()).toBe(0);
  });

  it("responses: throws the parse error and never fetches", async () => {
    const nf = neverFetch();
    const model = createResponsesProvider(RS, { fetch: nf.fetch });
    await expect(model.generate({ ...INPUT, reasoningEffort: "ultra" } as never)).rejects.toThrow(/invalid reasoning effort "ultra"/);
    expect(nf.calls()).toBe(0);
  });
});
