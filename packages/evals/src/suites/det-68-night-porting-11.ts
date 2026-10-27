// det-68-night-porting-11 — the deterministic behavior pins for 夜移 023
// (missing-reasoning session circuit, Reasonix reasoning_warn_state.go
// adapted). The feature landed with providers unit tests
// (terminal-repair.test.ts); this suite pays the det-44-style debt the same
// way det-57..det-67 did — the behavior pinned inside the release-eval
// matrix through PUBLIC exports, so a regression fails the release evals.
// Zero network, zero real-home reads.
//
//   ① suppression      a sustained regression (every tool turn
//                       reasoning-less): the FIRST failed replay opens the
//                       circuit — later turns settle with ONE request and no
//                       repair event (the replay tax stops);
//   ② re-arm           three consecutive healthy tool turns close the
//                       incident — the next missing turn gets one fresh
//                       silent retry that settles healthy;
//   ③ negative space   an open circuit does NOT suppress the reasoning-only
//                       repair — that shape keeps its own authority (the
//                       circuit governs ONLY the missing-reasoning retry);
//   ④ divergence pin   a RECOVERED replay does not open the circuit — the
//                       next missing turn still gets its retry (the recorded
//                       Reasonix divergence: wudao lacks history projection,
//                       so a working replay is never suppressed);
//   ⑤ per-leg pin      one circuit per model leg — a primary-leg regression
//                       does not suppress the fallback leg's retry (a 500
//                       walks the M62 chain; the fallback leg's missing
//                       turn still replays and recovers).
import { createOpenAICompatibleProvider, type ProviderConfig } from "@wudao/providers";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting11Evidence {
  // ① sustained-regression suppression
  readonly suppressedAfterFailedReplay: boolean;
  // ② three-consecutive-healthy re-arm
  readonly reArmsAfterThreeHealthy: boolean;
  // ③ negative space: reasoning-only repair unaffected
  readonly reasoningOnlyUnaffected: boolean;
  // ④ divergence: a recovered replay keeps full protection
  readonly recoveredReplayKeepsRetry: boolean;
  // ⑤ per-leg isolation through the fallback chain
  readonly perLegIsolation: boolean;
}

/** The replay contract ON (what a real reasoning-model session runs). */
function circuitConfig(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { apiKey: "k", baseURL: "http://provider.test", model: "m", reasoningReplay: "toolCallTurns", ...extra };
}

/** A scripted non-streaming fetch: `messages[i]` answers call i, capturing
 *  every request body (for the fetch-count assertions). */
function scriptedFetch(messages: Array<Record<string, unknown>>): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const doFetch = async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body));
    const message = messages[Math.min(call, messages.length - 1)];
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 1 } }),
    } as unknown as Response;
  };
  return { fetch: doFetch as unknown as typeof fetch, bodies };
}

const baseInput = {
  systemPrompt: "s",
  tools: [],
  messages: [{ role: "user" as const, content: "go" }],
};

const missingToolTurn = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };
const healthyToolTurn = { ...missingToolTurn, reasoning_content: "plan first" };

export const det68Eval: EvalDefinition<Record<string, never>, NightPorting11Evidence> = {
  name: "det-68-night-porting-11",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run(): Promise<NightPorting11Evidence> {
    // ① sustained regression — the failed replay opens the circuit, later
    // turns settle with ONE request and no further repair events.
    const repairs1: string[] = [];
    const lane1 = scriptedFetch([missingToolTurn, missingToolTurn, missingToolTurn, missingToolTurn]);
    const p1 = createOpenAICompatibleProvider(circuitConfig(), { fetch: lane1.fetch });
    const m1 = await p1.generate({ ...baseInput, onTerminalRepair: (k) => repairs1.push(k) });
    const oneOpens = lane1.bodies.length === 2 && repairs1.length === 1 && repairs1[0] === "missing-reasoning" && m1.reasoning === undefined;
    await p1.generate({ ...baseInput, onTerminalRepair: (k) => repairs1.push(k) });
    await p1.generate({ ...baseInput, onTerminalRepair: (k) => repairs1.push(k) });
    const suppressedAfterFailedReplay = oneOpens && lane1.bodies.length === 4 && repairs1.length === 1;

    // ② re-arm — three consecutive healthy tool turns close the incident;
    // the next missing turn gets one fresh silent retry that settles healthy.
    const repairs2: string[] = [];
    const lane2 = scriptedFetch([
      missingToolTurn, missingToolTurn,                                     // call 1: opens
      healthyToolTurn, healthyToolTurn, healthyToolTurn,                    // calls 2-4: streak → re-arm
      missingToolTurn, healthyToolTurn,                                     // call 5: fresh retry, recovered
    ]);
    const p2 = createOpenAICompatibleProvider(circuitConfig(), { fetch: lane2.fetch });
    await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    const m5 = await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    const reArmsAfterThreeHealthy = lane2.bodies.length === 7 && m5.reasoning === "plan first" && repairs2.length === 2;

    // ③ negative space — the open circuit does not license skipping the
    // reasoning-only repair (its own authority; deepseek/zai default true).
    const repairs3: string[] = [];
    const lane3 = scriptedFetch([
      missingToolTurn, missingToolTurn, missingToolTurn, // call 1: opens; call 2: suppressed
      { role: "assistant", content: "", reasoning_content: "thinking only" },
      { role: "assistant", content: "RECOVERED" },      // call 3: reasoning-only still replays
    ]);
    const p3 = createOpenAICompatibleProvider(circuitConfig({ acceptsReasoningOnlyFinish: true }), { fetch: lane3.fetch });
    await p3.generate({ ...baseInput, onTerminalRepair: (k) => repairs3.push(k) });
    await p3.generate({ ...baseInput, onTerminalRepair: (k) => repairs3.push(k) });
    const m3 = await p3.generate({ ...baseInput, onTerminalRepair: (k) => repairs3.push(k) });
    const reasoningOnlyUnaffected = m3.content === "RECOVERED"
      && repairs3.length === 2 && repairs3[1] === "reasoning-only" && lane3.bodies.length === 5;

    // ④ divergence pin — a recovered replay keeps the circuit CLOSED: the
    // very next missing turn still gets its frozen retry (Reasonix would
    // spend the incident budget on the first observation; wudao cannot —
    // there is no history projection to fall back on).
    const lane4 = scriptedFetch([
      missingToolTurn, healthyToolTurn,   // call 1: retry recovers → stays closed
      missingToolTurn, healthyToolTurn,   // call 2: missing again → retries again
    ]);
    const p4 = createOpenAICompatibleProvider(circuitConfig(), { fetch: lane4.fetch });
    const r1 = await p4.generate(baseInput);
    const r2 = await p4.generate(baseInput);
    const recoveredReplayKeepsRetry = r1.reasoning === "plan first" && r2.reasoning === "plan first" && lane4.bodies.length === 4;

    // ⑤ per-leg isolation — a primary-leg regression (open circuit) does not
    // suppress the fallback leg's retry: a 500 walks the M62 chain (fast
    // ladder, no sleeps) and the fallback leg's missing turn still replays.
    const perModel: Record<string, Array<Record<string, unknown> | "500">> = {
      primary: [missingToolTurn, missingToolTurn, "500"],
      secondary: [missingToolTurn, healthyToolTurn],
    };
    const counts: Record<string, number> = { primary: 0, secondary: 0 };
    const legFetch = async (_url: unknown, init?: { body?: unknown }) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      counts[body.model] = (counts[body.model] ?? 0) + 1;
      const script = perModel[body.model]!;
      const step = script[Math.min(counts[body.model]! - 1, script.length - 1)]!;
      if (step === "500") return { ok: false, status: 500, text: async () => "boom" } as unknown as Response;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: step }], usage: { prompt_tokens: 10, completion_tokens: 1 } }),
      } as unknown as Response;
    };
    const p5 = createOpenAICompatibleProvider(
      circuitConfig({ model: "primary", fallbackModels: ["secondary"] }),
      { fetch: legFetch as unknown as typeof fetch, retry: { sleep: async () => {}, maxRetries: 0 } },
    );
    await p5.generate(baseInput); // turn 1: primary missing → replay missing → primary circuit OPENS
    const f2 = await p5.generate(baseInput); // turn 2: primary 500 → walk → secondary missing → its OWN retry recovers
    const perLegIsolation = f2.reasoning === "plan first" && counts.secondary === 2 && counts.primary === 3;

    return {
      suppressedAfterFailedReplay,
      reArmsAfterThreeHealthy,
      reasoningOnlyUnaffected,
      recoveredReplayKeepsRetry,
      perLegIsolation,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.suppressedAfterFailedReplay, "① a sustained regression must open the circuit: first turn 2 requests + repair event, later turns 1 request each, no further events");
    need(e.reArmsAfterThreeHealthy, "② three consecutive healthy tool turns must re-arm: the next missing turn retries once and settles healthy");
    need(e.reasoningOnlyUnaffected, "③ an open circuit must NOT suppress the reasoning-only repair (its own authority)");
    need(e.recoveredReplayKeepsRetry, "④ a recovered replay must keep the circuit closed: the next missing turn still retries (the Reasonix divergence)");
    need(e.perLegIsolation, "⑤ one circuit per leg: a primary-leg regression must not suppress the fallback leg's retry");

    return errs;
  },
};
