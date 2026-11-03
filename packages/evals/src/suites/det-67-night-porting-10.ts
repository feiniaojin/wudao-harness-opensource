// det-67-night-porting-10 — the deterministic behavior pins for 夜移 022
// (GLM legitimate reasoning omission on tool turns:
// omitsReasoningOnToolTurns). The feature landed with providers unit tests
// (terminal-repair.test.ts) + the cli switch-lane pins (m63); this suite
// pays the det-44-style debt the same way det-57..det-66 did — the behavior
// pinned inside the release-eval matrix through PUBLIC exports, so a
// regression fails the release evals. Zero network, zero real-home reads.
//
//   ① flag plumbing   the profile fact (glm true, deepseek absent), the
//                     resolver threading, and the helper ladder (explicit >
//                     profile > false — both directions of the override);
//   ② generate lane   a reasoning-less tool turn on the glm profile does NOT
//                     frozen-replay (1 request, no repair event, the tool
//                     call settles as-is) — and the contrast: explicit false
//                     on the same shape replays byte-identically once;
//   ③ stream lane     the same gate at the done seam (1 request);
//   ④ negative space  the flag does NOT license the reasoning-only shape —
//                     glm still freeze-replays that degenerate finish
//                     (acceptsReasoningOnlyFinish keeps its own authority);
//   ⑤ switch lane     resolveProviderSwitch re-derives the flag from the
//                     TARGET profile and applyProviderConfig removes a
//                     stale glm-era `true` onto deepseek (explicit beats
//                     profile — a stale true would wrongly suppress the
//                     repair on the next provider).
import { createOpenAICompatibleProvider, PROVIDER_PROFILES, resolveProviderConfigResult, omitsReasoningOnToolTurns, type ProviderConfig } from "@wudao-org/providers";
import { resolveProviderSwitch, applyProviderConfig } from "wudao-harness/commands/provider";
import type { MutableProviderConfig } from "wudao-harness/commands/model";
import type { EvalDefinition } from "../runner.js";

export interface NightPorting10Evidence {
  // ① flag plumbing
  readonly profileFact: boolean;
  readonly resolverThreaded: boolean;
  readonly helperLadder: boolean;
  // ② generate lane
  readonly glmNoReplay: boolean;
  readonly contrastExplicitFalse: boolean;
  // ③ stream lane
  readonly streamNoReplay: boolean;
  // ④ negative space
  readonly reasoningOnlyStillRepairs: boolean;
  // ⑤ switch lane
  readonly switchReDerives: boolean;
  readonly staleFlagRemoved: boolean;
}

/** A scripted non-streaming fetch: `messages[i]` answers call i; captures
 *  every request body verbatim (for the byte-identity contrast). */
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

/** SSE body lines for one streamed message shape. */
function sse(message: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta: message }] })}\n\ndata: [DONE]\n\n`;
}

function sseFetch(frames: string[]): { fetch: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let call = 0;
  const doFetch = async (_url: unknown, init?: { body?: unknown }) => {
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
  return { fetch: doFetch as unknown as typeof fetch, bodies };
}

const baseInput = {
  systemPrompt: "s",
  tools: [],
  messages: [{ role: "user" as const, content: "go" }],
};

const toolCallMessage = { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] };
const toolCallWithReasoning = { ...toolCallMessage, reasoning_content: "plan first" };

/** The resolver-threaded glm config (profile default omits = true), with the
 *  replay contract forced on — what a real glm session runs. */
function glmConfig(extra: Partial<ProviderConfig> = {}): ProviderConfig {
  const result = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" });
  const resolved = result.ok ? result.config : { apiKey: "k", baseURL: "http://provider.test", model: "glm-4.6", provider: "glm" as const };
  return { ...resolved, reasoningReplay: "toolCallTurns", ...extra };
}

export const det67Eval: EvalDefinition<Record<string, never>, NightPorting10Evidence> = {
  name: "det-67-night-porting-10",
  kind: "deterministic",
  async setup() {
    return {};
  },
  async run(): Promise<NightPorting10Evidence> {
    // ① flag plumbing — profile fact, resolver threading, helper ladder.
    const profileFact = PROVIDER_PROFILES.glm.omitsReasoningOnToolTurns === true
      && PROVIDER_PROFILES.deepseek.omitsReasoningOnToolTurns === undefined;
    const resolvedGlmResult = resolveProviderConfigResult({ WUDAO_API_KEY: "k", WUDAO_PROVIDER: "glm" });
    const resolvedGlm = resolvedGlmResult.ok ? resolvedGlmResult.config : undefined;
    const resolverThreaded = resolvedGlm?.omitsReasoningOnToolTurns === true;
    const helperLadder = resolvedGlm !== undefined && omitsReasoningOnToolTurns(resolvedGlm) === true
      && omitsReasoningOnToolTurns(glmConfig({ omitsReasoningOnToolTurns: false })) === false
      && omitsReasoningOnToolTurns({ apiKey: "k", baseURL: "http://p.test", model: "m" }) === false;

    // ② generate lane — glm profile: a reasoning-less tool turn settles as-is.
    const repairs: string[] = [];
    const lane1 = scriptedFetch([toolCallMessage]);
    const p1 = createOpenAICompatibleProvider(glmConfig(), { fetch: lane1.fetch });
    const m1 = await p1.generate({ ...baseInput, onTerminalRepair: (k) => repairs.push(k) });
    const glmNoReplay = m1.toolCalls?.length === 1 && m1.reasoning === undefined
      && repairs.length === 0 && lane1.bodies.length === 1;

    // ② contrast — explicit false beats the profile: one frozen byte-identical replay.
    const repairs2: string[] = [];
    const lane2 = scriptedFetch([toolCallMessage, toolCallWithReasoning]);
    const p2 = createOpenAICompatibleProvider(glmConfig({ omitsReasoningOnToolTurns: false }), { fetch: lane2.fetch });
    const m2 = await p2.generate({ ...baseInput, onTerminalRepair: (k) => repairs2.push(k) });
    const contrastExplicitFalse = m2.reasoning === "plan first"
      && repairs2.length === 1 && repairs2[0] === "missing-reasoning"
      && lane2.bodies.length === 2 && lane2.bodies[1] === lane2.bodies[0];

    // ③ stream lane — the same gate at the done seam.
    const repairs3: string[] = [];
    const lane3 = sseFetch([
      sse({ tool_calls: [{ index: 0, id: "c1", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] }),
    ]);
    const p3 = createOpenAICompatibleProvider(glmConfig(), { fetch: lane3.fetch });
    const events: Array<{ type: string; message?: { toolCalls?: unknown[] } }> = [];
    for await (const ev of p3.stream!({ ...baseInput, onTerminalRepair: (k) => repairs3.push(k) })) {
      events.push(ev as { type: string; message?: { toolCalls?: unknown[] } });
    }
    const done = events.find((e) => e.type === "done");
    const streamNoReplay = done?.message?.toolCalls?.length === 1
      && repairs3.length === 0 && lane3.bodies.length === 1;

    // ④ negative space — reasoning-only still repairs on glm.
    const repairs4: string[] = [];
    const lane4 = scriptedFetch([
      { role: "assistant", content: "", reasoning_content: "thinking only" },
      { role: "assistant", content: "RECOVERED" },
    ]);
    const p4 = createOpenAICompatibleProvider(glmConfig(), { fetch: lane4.fetch });
    const m4 = await p4.generate({ ...baseInput, onTerminalRepair: (k) => repairs4.push(k) });
    const reasoningOnlyStillRepairs = m4.content === "RECOVERED"
      && repairs4.length === 1 && repairs4[0] === "reasoning-only" && lane4.bodies.length === 2;

    // ⑤ switch lane — the flag is re-derived from the TARGET profile, and a
    // stale glm-era true does not survive a switch back to deepseek.
    const live = {
      apiKey: "sk-live",
      apiKeys: ["sk-live"],
      baseURL: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4.6",
      provider: "glm",
      omitsReasoningOnToolTurns: true,
    } as MutableProviderConfig;
    const switchBack = resolveProviderSwitch({ target: "deepseek", env: {}, current: live });
    const switchReDerives = switchBack.ok && switchBack.config.omitsReasoningOnToolTurns === false;
    if (switchBack.ok) applyProviderConfig(live, switchBack.config);
    const staleFlagRemoved = live.omitsReasoningOnToolTurns === false && live.provider === "deepseek";

    return {
      profileFact, resolverThreaded, helperLadder,
      glmNoReplay, contrastExplicitFalse,
      streamNoReplay,
      reasoningOnlyStillRepairs,
      switchReDerives, staleFlagRemoved,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    need(e.profileFact, "① the glm profile must carry omitsReasoningOnToolTurns=true (deepseek absent)");
    need(e.resolverThreaded, "① the resolver must thread the profile default into the resolved config");
    need(e.helperLadder, "① the helper ladder must be explicit > profile > false, both override directions");
    need(e.glmNoReplay, "② a reasoning-less tool turn on the glm profile must settle as-is (1 request, no repair)");
    need(e.contrastExplicitFalse, "② explicit false must beat the profile: one frozen byte-identical replay");
    need(e.streamNoReplay, "③ the stream done seam must apply the same gate (1 request, tool call intact)");
    need(e.reasoningOnlyStillRepairs, "④ the flag must NOT license the reasoning-only shape (glm still repairs it)");
    need(e.switchReDerives, "⑤ resolveProviderSwitch must re-derive the flag from the TARGET profile");
    need(e.staleFlagRemoved, "⑤ a stale glm-era true must be removed by the switch onto deepseek");

    return errs;
  },
};
