// M71 §1 — engine round-trip tests, fully keyless: a SYNTHETIC upstream
// (canned SSE served through the same fetch boundary the real provider uses)
// stands in for the model. Capture → write fixture → load → replay must
// diverge on NOTHING; any deliberate mutation of prompt assembly must be
// caught and named. No network, no key, no committed fixtures involved.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createReadFileTool, type Tool } from "@wudao-org/core";
import {
  runSnapshotScenario,
  writeSnapshotFixture,
  loadSnapshotFixtureDir,
  replaySnapshotScenario,
  scanFixtureForMarker,
  rewriteResponseText,
  sanitizeConfig,
  type CapturedRun,
  type SnapshotFixture,
  type SnapshotScenario,
} from "../src/snapshot/engine.js";
import { INJECTION_MARKER } from "../src/snapshot/normalize.js";

// --- canned SSE shapes (the wire format the real endpoint streams) ----------
// One script entry = ONE POST = one complete stream: content frame(s), then
// the usage-only trailing chunk, then [DONE]. The usage chunk must ride the
// SAME stream as the content (that is what stream_options.include_usage
// actually sends): serving it as its own POST hands the loop a blank final
// answer, which since 夜移 024 correctly triggers the empty-final nudge and
// changes the call count this suite pins.
function sseToolCall(id: string, name: string, args: Record<string, unknown>): string {
  const delta = { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] };
  return `data: ${JSON.stringify(delta)}\n\n`;
}
function sseFinalAnswer(text: string): string {
  const delta = { choices: [{ delta: { content: text } }] };
  return `data: ${JSON.stringify(delta)}\n\n`;
}
function sseUsage(): string {
  // The usage-only trailing chunk (stream_options.include_usage) — exercises
  // the provider's usage parsing on the replay path too.
  return `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 432, completion_tokens: 12, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 332 } })}\n\n`;
}
const withDone = (...frames: string[]): string => `${frames.join("")}data: [DONE]\n\n`;

const SYNTH_SCRIPT = [
  withDone(sseToolCall("synth-c1", "read_file", { path: "notes.txt" }), sseUsage()),
  withDone(sseFinalAnswer("The codeword is SYNTH-CODEWORD-9."), sseUsage()),
  withDone(sseFinalAnswer("RESUME-OK"), sseUsage()),
];

/** A fake endpoint: serves the script in order, one payload per POST. */
function scriptedUpstream(script: readonly string[]): typeof fetch {
  let i = 0;
  return (async (_url: RequestInfo | URL, _init?: RequestInit) => {
    const text = script[i];
    i += 1;
    if (text === undefined) throw new Error("synthetic upstream exhausted");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
}

const SYNTH_CONFIG = { apiKey: "synthetic-key", baseURL: "http://synthetic.test", model: "synthetic-model" };

function synthScenario(overrides: Partial<Pick<SnapshotScenario, "name" | "sessionId">> & { systemPromptSuffix?: string; toolTweak?: boolean } = {}): SnapshotScenario {
  return {
    name: overrides.name ?? "synth-roundtrip",
    sessionId: overrides.sessionId ?? "synth1",
    async setup(workspaceRoot) {
      const tools: Tool[] = [createReadFileTool({ workspaceRoot })];
      return {
        systemPrompt: "You are a synthetic snapshot agent." + (overrides.systemPromptSuffix ?? ""),
        userPrompt: "Read notes.txt and tell me the codeword.",
        // A tweaked tool description simulates a prompt-assembly regression.
        tools: overrides.toolTweak
          ? [{ ...tools[0], description: `${tools[0].description} (regressed)` }]
          : tools,
        resumePrompt: "Reply with exactly: RESUME-OK",
      };
    },
  };
}

describe("snapshot engine (synthetic, keyless)", () => {
  let fixtureDir: string;
  let fixture: SnapshotFixture;
  let captured: CapturedRun;

  beforeAll(async () => {
    // 1. capture against the synthetic upstream (the "record" mechanics,
    //    minus the network) and commit the fixture to a temp dir.
    const scenario = synthScenario();
    captured = await runSnapshotScenario(scenario, { config: SYNTH_CONFIG, upstreamFetch: scriptedUpstream(SYNTH_SCRIPT) });
    fixtureDir = join(await mkdtemp(join(tmpdir(), "wudao-snap-synth-")), "fixture");
    await writeSnapshotFixture(captured, SYNTH_CONFIG, fixtureDir);
    fixture = await loadSnapshotFixtureDir(fixtureDir);
  });

  afterAll(async () => {
    await rm(dirname(fixtureDir), { recursive: true, force: true }).catch(() => {});
  });

  it("captures the two phases: 2 phase-1 model calls + 1 resume call", () => {
    expect(captured.prompts.length).toBe(3);
    expect(captured.requests.length).toBe(3);
    expect(captured.transcript.filter((t) => t.kind === "terminal" && t.phase === 1)).toHaveLength(1);
    expect(captured.transcript.filter((t) => t.kind === "terminal" && t.phase === 2)).toHaveLength(1);
  });

  it("mounts the marker in the persisted session but leaks nowhere", () => {
    // The canary IS in the session JSONL (persistence-only entry)…
    expect(JSON.stringify(captured.session)).toContain(INJECTION_MARKER);
    // …and NOWHERE in any assembled request or canonical prompt bytes.
    expect(captured.markerLeaks).toEqual([]);
    expect(scanFixtureForMarker(fixture)).toEqual([]);
  });

  it("persists phase-1 messages, the marker entry, then phase-2 messages, in order", () => {
    const kinds = captured.session.map((e) => {
      const rec = e as Record<string, unknown>;
      return rec.type === "local_notice" ? "MARKER" : String(rec.role);
    });
    expect(kinds).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "MARKER",
      "user",
      "assistant",
    ]);
    // ω99-84: this exact shape is also the ω99-47 transport-framing pin — the
    // session file's line 1 carries the soft format marker
    // ({"type":"wudao_meta","data":{"formatVersion":1}}), which the engine's
    // session view must strip like every platform read path does (core
    // o99-47-session-version-gate A2: a marked file reads identically to an
    // unmarked one). A marker leaking into the view shows up here as an extra
    // first kind "undefined"; pin it by name so the failure names the law.
    expect(
      captured.session.some((e) => (e as Record<string, unknown>).type === "wudao_meta"),
    ).toBe(false);
  });

  it("replays keylessly with zero divergence (round-trip invariant)", async () => {
    const { errors } = await replaySnapshotScenario(synthScenario(), fixture);
    expect(errors, errors.join("\n---\n")).toEqual([]);
  });

  it("detects a system-prompt assembly regression and names the diverging prompt call", async () => {
    const { errors } = await replaySnapshotScenario(
      synthScenario({ systemPromptSuffix: " EXTRA ASSEMBLY BYTES." }),
      fixture,
    );
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("prompts[0]");
  });

  it("detects a tool-serialization regression (description bytes leak into every request)", async () => {
    const { errors } = await replaySnapshotScenario(synthScenario({ toolTweak: true }), fixture);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.startsWith("prompts["))).toBe(true);
  });

  it("flags a scenario that now makes more model calls than were recorded", async () => {
    // Exhaust the fixture on purpose: 2 fixture prompts, a 3-call scenario.
    const truncated: SnapshotFixture = { ...fixture, prompts: fixture.prompts.slice(0, 2) };
    const { errors } = await replaySnapshotScenario(synthScenario(), truncated);
    expect(errors.join("\n")).toMatch(/prompts: 3 model calls != recorded 2/);
  });

  it("reports the leak when an assembly path actually emits the marker", async () => {
    // Simulated leak: the marker mounted INTO the system prompt (exactly the
    // bug class M71 §2 exists to catch).
    const leaked = await runSnapshotScenario(synthScenario({ systemPromptSuffix: ` ${INJECTION_MARKER}` }), {
      config: SYNTH_CONFIG,
      upstreamFetch: scriptedUpstream(SYNTH_SCRIPT),
    });
    expect(leaked.markerLeaks.length).toBeGreaterThan(0);
    expect(leaked.markerLeaks.join("\n")).toContain("model call 0");
    // And replay surfaces the leak as a hard error, before any byte diff.
    const leakedFixture: SnapshotFixture = { ...fixture, prompts: leaked.prompts, requests: leaked.requests };
    const { errors } = await replaySnapshotScenario(synthScenario({ systemPromptSuffix: ` ${INJECTION_MARKER}` }), leakedFixture);
    expect(errors.some((e) => e.includes("marker"))).toBe(true);
  });

  it("rewrites recorded absolute workspace paths to the replaying run's root", () => {
    // Real recordings hit this: the model embeds the absolute working
    // directory into tool-call arguments; those bytes ride the recorded
    // responses verbatim and must point at the replay workspace.
    const from = "/var/folders/aa/wudao-snap-snap03-RECORD";
    const to = "/var/folders/bb/wudao-snap-snap03-REPLAY";
    const payload = `data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"{\\"path\\":\\"${from}/big.txt\\"}"}}]}}]}\n\n`;
    const out = rewriteResponseText(payload, from, to);
    expect(out).toContain(`${to}/big.txt`);
    expect(out).not.toContain(from);
    // Idempotence guards: identical roots and empty roots are no-ops.
    expect(rewriteResponseText(payload, from, from)).toBe(payload);
    expect(rewriteResponseText(payload, "", to)).toBe(payload);
  });

  it("stores the recording workspace root in the fixture", () => {
    expect(fixture.recordWorkspaceRoot).toBe(captured.workspaceRoot);
    expect(fixture.recordWorkspaceRoot).not.toBe("");
  });

  it("writes NO credential material into fixtures, even if the caller passes keys (F1)", async () => {
    // The resolver returns apiKey AND the M56 apiKeys pool; the engine must
    // strip both regardless of what the caller hands it.
    // Synthetic credential stand-ins — deliberately NOT key-shaped (no sk-
    // prefix) so no secret scanner ever trips on this file.
    const leaky = { ...SYNTH_CONFIG, apiKey: "leaky-single-key", apiKeys: ["leaky-pool-key-a", "leaky-pool-key-b"] };
    const dir = join(dirname(fixtureDir), "leaky-fixture");
    await writeSnapshotFixture(captured, leaky, dir);
    const written = JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "requests.json"), "utf8"));
    expect(written.config.apiKey).toBeUndefined();
    expect(written.config.apiKeys).toBeUndefined();
    expect(JSON.stringify(written)).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
    // sanitizeConfig itself: copies, drops exactly the credential fields
    // (SYNTH_CONFIG's own apiKey goes too — sanitized is keyless, period).
    expect(sanitizeConfig(leaky)).toEqual({ baseURL: "http://synthetic.test", model: "synthetic-model" });
    expect(sanitizeConfig(SYNTH_CONFIG)).toEqual({ baseURL: "http://synthetic.test", model: "synthetic-model" });
    expect(leaky.apiKeys).toBeDefined(); // the input was not mutated
  });

  it("replay diffs request headers and names the diverging call (F2)", async () => {
    const mutated: SnapshotFixture = {
      ...fixture,
      requests: fixture.requests.map((r, i) =>
        i === 0
          ? { ...r, headers: { ...r.headers, "content-type": "application/vnd-mutated" } }
          : r,
      ),
    };
    const { errors } = await replaySnapshotScenario(synthScenario(), mutated);
    expect(errors.some((e) => e.startsWith("requests[0].headers"))).toBe(true);
  });

  it("replay ignores the authorization header value and a lingering apiKeys pool (F1/F2)", async () => {
    // A stale fixture carrying a redacted-authorization difference AND a
    // leftover credential pool must neither fail the diff nor engage the
    // pool — replay always authenticates with the dummy key only.
    const stale: SnapshotFixture = {
      ...fixture,
      config: { ...fixture.config, apiKeys: ["stale-pool-key"] },
      requests: fixture.requests.map((r) => ({
        ...r,
        headers: { ...r.headers, authorization: "Bearer something-else" },
      })),
    };
    const { errors } = await replaySnapshotScenario(synthScenario(), stale);
    expect(errors, errors.join("\n---\n")).toEqual([]);
  });
});
