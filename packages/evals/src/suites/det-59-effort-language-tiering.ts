// det-59-effort-language-tiering — the deterministic behavior pins for the
// 2026-08-28 user-feedback arc 推理档三级配置 + 语言 chip (S1-S5, spec
// docs/superpowers/specs/2026-08-28-effort-tiering-language-chip-design.md).
// The arc landed with unit tests in its own packages; this suite pays the
// det-44-style debt the same way det-57/det-58 did for the night ports —
// the chain behaviors pinned at the harness boundary inside the release-eval
// matrix, so a regression in any seam fails the release evals, not just a
// package test someone might not run. Zero network, zero real-home reads
// (the one process.env touch is saved and restored, det-53's pattern):
//
//   ① effort three-tier chain   foldEffortChain's priority matrix (pin >
//      binding > global > absent) including the two edge semantics the UI
//      depends on: binding null = explicit DON'T-SEND (not follow-global),
//      blank pin = no pin; and the registry column's three states via
//      readProviderEffortBinding (bound / key-absent / forced null) against
//      a seeded providers.json in a tmp home.
//   ② language double-knob fold resolveLanguagePreference's chain (ablation
//      > session > settings > env > auto) per knob — the S3/S4 fold every
//      frontend's chip reads.
//   ③ the live session lane +    setLanguage lands on the very next submit's
//      settingsStatus overlay      ModelInput (session > env by construction);
//      withSettingsOps then mirrors the pair onto settingsStatus().language
//      (the web gateStatus) AND overlays the session-effective effort onto
//      current.effort — the S5 fix: current.effort was env-only before, so a
//      mid-session /effort high would have surfaced (and persisted) the stale
//      env tier.
import { mkdir, mkdtemp } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScriptedModel, type ModelClient, type ModelInput } from "@wudao-org/core";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import { withSettingsOps } from "wudao-harness/driver/settings-ops";
import { readProviderEffortBinding } from "wudao-harness/driver/provider-registry-ops";
import { foldEffortChain } from "wudao-harness/commands/model";
import { LANGUAGE_BLOCK_ZH, resolveLanguagePreference } from "wudao-harness/language";
import { summarizeToolCall } from "wudao-harness/log";
import type { EvalDefinition } from "../runner.js";

export interface EffortLanguageTieringEvidence {
  readonly root: string;
  // ① the effort three-tier chain (S1/S2)
  readonly foldPinned: string | undefined;
  readonly foldBound: string | undefined;
  readonly foldForcedNone: string | undefined;
  readonly foldGlobal: string | undefined;
  readonly foldBlankPin: string | undefined;
  readonly readBound: string | null | undefined;
  readonly readAbsent: string | null | undefined;
  readonly readForcedNull: string | null | undefined;
  // ② the language double-knob fold (S3/S4)
  readonly langSessionReply: string;
  readonly langStoredReply: string;
  readonly langEnvReasoning: string;
  readonly langAblated: readonly string[];
  // ③ the live session lane + the settingsStatus overlay (S4/S5)
  readonly sessionTailHasBlock: boolean;
  readonly overlayLanguage: unknown;
  readonly effortEnvTier: string | undefined;
  readonly effortSessionTier: string | undefined;
}

/** A scripted model that records every ModelInput — the language blocks ride
 *  the per-submit seam, so the wire input (not state.messages) is the
 *  authoritative view (the S4 seam's own test discipline). */
function recordingModel(inputs: ModelInput[]): ModelClient {
  const scripted = createScriptedModel([{ role: "assistant", content: "ok" }]);
  return {
    async generate(input: ModelInput) {
      inputs.push(input);
      return scripted.generate(input);
    },
  };
}

export const det59Eval: EvalDefinition<{ readonly root: string }, EffortLanguageTieringEvidence> = {
  name: "det-59-effort-language-tiering",
  kind: "deterministic",
  async setup() {
    return { root: await mkdtemp(join(tmpdir(), "det59-tier-")) };
  },
  async run(ctx) {
    // ① — the pure chain fold + the registry column's three states.
    const foldPinned = foldEffortChain("low", "high", "max");
    const foldBound = foldEffortChain(undefined, "high", "max");
    const foldForcedNone = foldEffortChain(undefined, null, "max");
    const foldGlobal = foldEffortChain(undefined, undefined, "max");
    const foldBlankPin = foldEffortChain("", "high", "max");
    const home = join(ctx.root, "home");
    await mkdir(home, { recursive: true });
    writeFileSync(
      join(home, "providers.json"),
      JSON.stringify({
        version: 1,
        providers: {
          ds: { baseUrl: "https://a.test", defaultModel: "m", effort: "high" },
          bare: { baseUrl: "https://b.test", defaultModel: "m" },
          off: { baseUrl: "https://c.test", defaultModel: "m", effort: null },
        },
      }, null, 2),
      "utf8",
    );
    const regEnv = { WUDAO_GLOBAL_HOME: home };
    const readBound = readProviderEffortBinding("ds", regEnv);
    const readAbsent = readProviderEffortBinding("bare", regEnv);
    const readForcedNull = readProviderEffortBinding("off", regEnv);

    // ② — the language fold's priority chain (both knobs independently).
    const langSessionReply = resolveLanguagePreference(
      { WUDAO_LANGUAGE_BLOCK: "off" },
      { reply: "off" },
      { reply: "on" },
    ).reply; // session > settings AND env
    const langStoredReply = resolveLanguagePreference(
      { WUDAO_LANGUAGE_BLOCK: "off" },
      { reply: "on" },
      undefined,
    ).reply; // settings > env
    const langEnvReasoning = resolveLanguagePreference(
      { WUDAO_REASONING_LANGUAGE: "zh" },
      undefined,
      undefined,
    ).reasoning; // env fallback when nothing above it
    const ablated = resolveLanguagePreference(
      { WUDAO_NO_LANGUAGE: "1" },
      { reply: "on", reasoning: "zh" },
      { reply: "on", reasoning: "en" },
    );
    const langAblated = [ablated.reply, ablated.reasoning]; // the kill switch outranks EVERY tier

    // ③ — the live session lane + the gateStatus overlay.
    const inputs: ModelInput[] = [];
    const driver = createAgentDriver({
      model: recordingModel(inputs),
      tools: [],
      systemPrompt: "s",
      summarize: summarizeToolCall,
      workspaceRoot: ctx.root,
      onPermissionAsk: async () => ({ kind: "allow" as const }),
    });
    const notices = () => driver.getHistory().filter((e) => e.kind === "notice").length;
    const waitNotices = async (before: number): Promise<void> => {
      for (let i = 0; i < 200 && notices() <= before; i += 1) await new Promise((r) => setTimeout(r, 10));
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 200 && !driver.getHistory().some((e) => e.kind === "assistant"); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    driver.setLanguage({ reply: "on" });
    driver.submit("plain english prompt"); // auto would stay quiet — the session tier emits
    await settle();
    const lastUser = inputs[inputs.length - 1]?.messages
      .filter((m) => m.role === "user" && typeof m.content === "string")
      .map((m) => (m as { content: string }).content);
    const sessionTailHasBlock = lastUser != null && lastUser.some((t) => t.includes(LANGUAGE_BLOCK_ZH));

    const ws = join(ctx.root, "ws");
    await mkdir(ws, { recursive: true });
    const port = withSettingsOps(driver, {
      env: { WUDAO_GLOBAL_HOME: home, WUDAO_REASONING_EFFORT: "low" },
      workspaceRoot: ws,
    });
    // The port type marks the settings ops optional (older drivers) — the
    // wrapper makes their absence fail loudly instead of type-lying, and the
    // awaited payload arrives as unknown (the server's broad port face).
    const status = async (): Promise<{
      readonly current: { readonly effort?: string };
      readonly language?: { readonly reply?: unknown; readonly reasoning?: unknown };
    }> => {
      const fn = port.settingsStatus;
      if (fn === undefined) throw new Error("det-59: the wrapped port lacks settingsStatus");
      return (await fn()) as {
        readonly current: { readonly effort?: string };
        readonly language?: { readonly reply?: unknown; readonly reasoning?: unknown };
      };
    };
    const overlayLanguage = (await status()).language;
    const effortEnvTier = (await status()).current.effort;
    const before = notices();
    driver.submit("/effort high");
    await waitNotices(before);
    const effortSessionTier = (await status()).current.effort;
    driver.dispose();

    return {
      root: ctx.root,
      foldPinned, foldBound, foldForcedNone, foldGlobal, foldBlankPin,
      readBound, readAbsent, readForcedNull,
      langSessionReply, langStoredReply, langEnvReasoning, langAblated,
      sessionTailHasBlock, overlayLanguage, effortEnvTier, effortSessionTier,
    };
  },
  assertions(e) {
    const errs: string[] = [];
    const need = (ok: boolean, msg: string) => { if (!ok) errs.push(msg); };

    // ① the fold: pin > binding > global > absent, with the two edge semantics.
    need(e.foldPinned === "low", `① the pin must outrank binding and global (got ${JSON.stringify(e.foldPinned)})`);
    need(e.foldBound === "high", `① a bound level must beat the global default (got ${JSON.stringify(e.foldBound)})`);
    need(e.foldForcedNone === undefined, `① binding null is an explicit DON'T-SEND, not follow-global (got ${JSON.stringify(e.foldForcedNone)})`);
    need(e.foldGlobal === "max", `① an absent binding falls to the global (got ${JSON.stringify(e.foldGlobal)})`);
    need(e.foldBlankPin === "high", `① a blank pin is no pin — the binding speaks (got ${JSON.stringify(e.foldBlankPin)})`);
    need(e.readBound === "high", `① the registry column reads a bound level (got ${JSON.stringify(e.readBound)})`);
    need(e.readAbsent === undefined, `① a key-absent row follows the global (got ${JSON.stringify(e.readAbsent)})`);
    need(e.readForcedNull === null, `① an explicit null row forces don't-send (got ${JSON.stringify(e.readForcedNull)})`);

    // ② the language chain: ablation > session > settings > env > auto.
    need(e.langSessionReply === "on", `② the session tier must beat settings AND env (got ${JSON.stringify(e.langSessionReply)})`);
    need(e.langStoredReply === "on", `② stored settings must beat env (got ${JSON.stringify(e.langStoredReply)})`);
    need(e.langEnvReasoning === "zh", `② env is the fallback tier (got ${JSON.stringify(e.langEnvReasoning)})`);
    need(
      e.langAblated.length === 2 && e.langAblated[0] === "off" && e.langAblated[1] === "off",
      `② WUDAO_NO_LANGUAGE=1 must ablate BOTH knobs past every tier (got ${JSON.stringify(e.langAblated)})`,
    );

    // ③ the session lane lands on the wire; the overlay mirrors both live tiers.
    need(e.sessionTailHasBlock, `③ setLanguage must land the block on the NEXT submit's ModelInput (session > auto)`);
    need(
      typeof e.overlayLanguage === "object" && e.overlayLanguage !== null &&
        (e.overlayLanguage as { reply?: unknown }).reply === "on" &&
        (e.overlayLanguage as { reasoning?: unknown }).reasoning === "auto",
      `③ settingsStatus().language must mirror the session-effective pair (got ${JSON.stringify(e.overlayLanguage)})`,
    );
    need(e.effortEnvTier === "low", `③ current.effort reads the env tier before any session pick (got ${JSON.stringify(e.effortEnvTier)})`);
    need(e.effortSessionTier === "high", `③ a mid-session /effort must win on the wire overlay — the S5 stale-value fix (got ${JSON.stringify(e.effortSessionTier)})`);

    return errs;
  },
};
