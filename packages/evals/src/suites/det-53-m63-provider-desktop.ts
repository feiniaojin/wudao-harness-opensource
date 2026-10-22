// M63 det-53 — provider switching + desktop-friendly UI: the cross-batch
// acceptance at the LOGIC seams the evals package can reach (real driver,
// real resolvers, real settings ops — no reimplementations):
//
//   §A  /provider semantics through the real AgentDriver: idle rebuild +
//       provider_change entry + the colder-than-model cache receipt; busy
//       parks (build + entry deferred to run settle); mid-stream refuses;
//       same-provider no-op; missing-key refusal; the model/provider dual
//       switch; the turn_usage cold stamp through the real cache-tracking
//       wrapper; provider_change folds into the resumed model state.
//   §B  credentials precedence through resolveProviderConfigResult + the
//       real buildRunPlan (env wins; the file fills the SELECTED provider
//       when the pool is empty); the credentials file itself (0600, counts
//       only, atomic merge); settingsSet writes the GLOBAL tier, refuses
//       introduced escalations (the M1 diff-write) and preserves hand-
//       written ones verbatim; the test-connection classifier's 人话 states.
//   §C  the readiness join matrix + the ui boot plan (real / file / wizard /
//       exit); the wizard placeholder reads as ABSENT in resolution; the
//       same-provider completion switch (the §A↔§C carve-out) end-to-end;
//       the browse-only run refusal with the 去配置 wording;
//       wizard.completedVersion round-trips through the real readers.
//   §D  the ui.defaultMode tri-state through the real layered read (null →
//       "treated as advanced" by the consumer); mode toggle persistence via
//       settingsSet; the C↔D contract — the wizard's completion writes land
//       ui.defaultMode=simple next to wizard.completedVersion in ONE record.
//
// NOT here (lives in the packages that own the DOM/WS boundary, cited for
// the report): stripSecrets recursion (packages/server tests — the eval
// runner has no WS client), the Wizard gate/version re-show comparison and
// the SimpleMode cards (packages/web jsdom tests), the ShieldSelector tier
// mapping (packages/web), and the picker row enablement (web ModelPicker +
// cli m57-model-picker tests).
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createJsonlSessionStore,
  createReadFileTool,
  createScriptedModel,
  type AssistantMessage,
  type ModelClient,
  type ModelInput,
  type ModelUsage,
  type Tool,
} from "@wudao/core";
import { PROVIDER_PROFILES, resolveProviderConfigResult } from "@wudao/providers";
import type { BuiltinProviderName, ProviderConfig, ProviderName } from "@wudao/providers";
import { createAgentDriver } from "wudao-harness/driver/agent-driver";
import type { AgentDriver } from "wudao-harness/driver/agent-driver";
import { summarizeToolCall } from "wudao-harness/log";
import { asMutableConfig } from "wudao-harness/commands/model";
import {
  applyProviderConfig,
  PROVIDER_SWITCH_CACHE_NOTE,
  PROVIDER_SWITCH_COLD_ATTRIBUTION,
  resolveProviderSwitch,
} from "wudao-harness/commands/provider";
import { createCacheTrackingModel } from "wudao-harness/cache";
import {
  credentialsFileStatus,
  readCredentialsFile,
  saveProviderKey,
  WIZARD_PLACEHOLDER_KEY,
  writeCredentialsFile,
} from "wudao-harness/credentials";
import { buildProviderMatrix, createSettingsOps, settingsReadiness } from "wudao-harness/driver/settings-ops";
import { buildRunPlan, buildUiBootPlan, lastModelState } from "wudao-harness/run";
import { globalSettingsPath, loadLayeredSettings, readGlobalSettings, saveGlobalSettings } from "wudao-harness/settings-layer";
import type { EvalDefinition } from "../runner.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** A controlled env for every resolver lane — never the machine's. */
const CLEAN_ENV = (home: string): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

function noticesOf(driver: AgentDriver): string {
  return driver.getHistory().map((e) => (e.kind === "notice" ? e.text : "")).join("\n");
}

function errorsOf(driver: AgentDriver): string[] {
  return driver.getHistory().filter((e) => e.kind === "error").map((e) => (e.kind === "error" ? e.text : ""));
}

async function readJsonl(ws: string, sessionId: string): Promise<string> {
  return readFile(join(ws, ".wudao", "sessions", `${sessionId}.jsonl`), "utf8").catch(() => "");
}

/** Poll the session JSONL until it carries the marker (entries land async). */
async function untilJsonl(ws: string, sessionId: string, marker: string): Promise<string> {
  let text = "";
  for (let i = 0; i < 300 && !text.includes(marker); i += 1) {
    text = await readJsonl(ws, sessionId);
    if (!text.includes(marker)) await wait();
  }
  return text;
}

/** A live config shape (what every frontend's mutable holder carries). */
function liveConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    apiKey: "sk-live",
    apiKeys: ["sk-live"],
    baseURL: PROVIDER_PROFILES.deepseek!.defaultBaseUrl ?? "https://api.deepseek.com",
    model: PROVIDER_PROFILES.deepseek!.defaultModel,
    provider: "deepseek",
    reasoningEffort: "high",
    ...over,
  };
}

/** A model that reports usage once per call (scripted models never do). */
function usageModel(answer: string): ModelClient & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate(input: ModelInput): Promise<AssistantMessage> {
      calls += 1;
      input.onUsage?.({ promptTokens: 100, cacheHitTokens: 0, cacheMissTokens: 100 });
      return { role: "assistant", content: answer };
    },
  };
}

function makeDriver(model: ModelClient, opts: Partial<Parameters<typeof createAgentDriver>[0]> = {}): AgentDriver {
  return createAgentDriver({
    systemPrompt: "s",
    summarize: summarizeToolCall,
    model,
    tools: [createReadFileTool({ workspaceRoot: process.cwd() })],
    ...opts,
  });
}

/** The env keys every provider-resolution lane must not inherit. */
const ENV_KEYS_TO_PIN = [
  "WUDAO_API_KEY",
  "WUDAO_API_KEYS",
  "OPENAI_API_KEY",
  "WUDAO_BASE_URL",
  "OPENAI_BASE_URL",
  "WUDAO_PROVIDER",
  "WUDAO_MODEL",
  "OPENAI_MODEL",
  "WUDAO_REASONING_EFFORT",
  "WUDAO_REASONING_FORMAT",
  "WUDAO_REASONING_REPLAY",
] as const;

interface Det53Evidence {
  // §A — the switch semantics (real driver, real resolver halves).
  readonly switchIdle: {
    readonly built: string;
    readonly appliedNotice: boolean;
    readonly cacheNoteExact: boolean;
    readonly cacheNoteWording: boolean;
    readonly entryNamesBothSides: boolean;
    readonly statusProvider: string;
    readonly nextRunServedBy: string;
  };
  readonly coldReceipt: { readonly firstStamped: boolean; readonly attributionWording: boolean; readonly secondClean: boolean };
  readonly switchBusy: {
    readonly queuedNotice: boolean;
    readonly deferredBuild: boolean;
    readonly noEarlyEntry: boolean;
    readonly settleNotice: boolean;
    readonly settleEntry: boolean;
    readonly statusProvider: string;
  };
  readonly switchMidStream: { readonly refused: boolean; readonly nothingResolved: boolean; readonly nothingBuilt: boolean; readonly noEntry: boolean };
  readonly switchRefusals: { readonly sameProviderNoOp: boolean; readonly missingKeyNamesFix: boolean; readonly unknownListsMatrix: boolean; readonly noEntry: boolean };
  readonly dualSwitch: { readonly provider: string; readonly model: string; readonly providerChangeEntries: number };
  readonly resumeFold: { readonly provider: string | undefined; readonly model: string | undefined };
  // §A↔§C — the placeholder carve-out + the browse-only guard.
  readonly carveOut: { readonly builtWithSavedKey: string; readonly appliedNotice: boolean; readonly entry: boolean; readonly firstPromptServedBy: string };
  readonly browseGuard: { readonly refused: boolean; readonly namesWizardPath: boolean; readonly zeroModelCalls: boolean; readonly notBusy: boolean };
  // §B — credentials + settings.
  readonly credentialsPrecedence: {
    readonly envWins: string;
    readonly fileFills: string;
    readonly fileNeverShadowsEnv: string;
    readonly noKeyAnywhere: string;
    readonly runPlanFileKey: string;
    readonly runPlanRealFileBoot: string;
  };
  readonly credentialsFile: { readonly mode0600: boolean; readonly roundTrip: boolean; readonly countsOnly: boolean; readonly mergePreserves: boolean; readonly saveReplySecretFree: boolean };
  readonly settingsSet: {
    readonly persistsSimple: string | null | undefined;
    readonly invalidModeRefused: string | undefined;
    readonly unknownKeyRefused: string | undefined;
    readonly introducedEscalationRefused: string | undefined;
    readonly handWrittenEscalationSurvives: boolean;
    readonly envKeyNote: boolean;
  };
  readonly testConnection: { readonly ok: string; readonly auth: string; readonly network: string; readonly model404: string; readonly model400Body: string };
  // §C — readiness + the boot matrix.
  readonly bootMatrix: {
    readonly envKeyReal: boolean;
    readonly fileSubstitutionNotice: string | undefined;
    readonly wizardBoot: boolean;
    readonly placeholderShape: boolean;
    readonly exitNamesWizard: boolean;
  };
  readonly readiness: { readonly anyReady: boolean; readonly noneReady: boolean; readonly endpointGate: boolean; readonly versionRoundTrip: readonly [number, number] };
  // §D — the mode tri-state + persistence.
  readonly modeTriState: { readonly absent: string | null; readonly simple: string | null; readonly advanced: string | null; readonly garbage: string | null };
  readonly modePersist: { readonly afterSimple: string | null; readonly afterAdvanced: string | null; readonly singleNode: boolean };
  readonly wizardContract: { readonly defaultMode: string | null; readonly completedVersion: number };
}

export const det53Eval: EvalDefinition<string, Det53Evidence> = {
  name: "det-53-m63-provider-desktop",
  kind: "deterministic",
  setup: async (tmplDir) => {
    await mkdir(tmplDir, { recursive: true });
    return tmplDir;
  },
  run: async (root) => {
    // Pin the global tier (settings + credentials) and strip every provider
    // env var — the resolver lanes must never inherit the machine's config.
    const globalHome = join(root, "global-home");
    const emptyHome = join(root, "empty-home");
    const ws = await mkdtemp(join(root, "ws-"));
    await mkdir(globalHome, { recursive: true });
    await mkdir(emptyHome, { recursive: true });
    const prev: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS_TO_PIN) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    const prevGlobalHome = process.env.WUDAO_GLOBAL_HOME;
    const prevHome = process.env.HOME;
    process.env.WUDAO_GLOBAL_HOME = globalHome;
    process.env.HOME = emptyHome;

    try {
      const ds = PROVIDER_PROFILES.deepseek!;
      const glm = PROVIDER_PROFILES.glm!;
      const qwen = PROVIDER_PROFILES.qwen!;

      // ============================================================= §A idle
      const live1 = asMutableConfig(liveConfig());
      const log1 = { resolve: [] as string[], builds: [] as string[] };
      const replacement = usageModel("glm-answer");
      const driver1 = makeDriver(createScriptedModel([{ role: "assistant", content: "before" }]), {
        workspaceRoot: ws,
        sessionId: "wudao-det53-a1",
        sessionMeta: { provider: "deepseek", model: ds.defaultModel },
        // The dual-switch lane's within-glm target must be in the matrix.
        availableModels: [
          { provider: "deepseek", model: ds.defaultModel, source: "profile" },
          { provider: "glm", model: glm.defaultModel, source: "profile" },
          { provider: "glm", model: "glm-4.7-air", source: "env" },
        ],
        onProviderSwitch: {
          resolve: (target: string) => {
            log1.resolve.push(target);
            return resolveProviderSwitch({ target, env: CLEAN_ENV(globalHome), current: live1 });
          },
          build: (config: ProviderConfig) => {
            log1.builds.push(`${config.provider}/${config.model}`);
            applyProviderConfig(live1, config);
            return replacement;
          },
        },
      });
      driver1.submit("/provider glm");
      await until(() => log1.builds.length === 1, "idle switch builds");
      const jsonl1 = await untilJsonl(ws, "wudao-det53-a1", "provider_change");
      let nextRunServedBy = "";
      // The NEXT run reads the rebuilt client (the switch really swapped it).
      driver1.submit("hello on the new endpoint");
      await until(() => driver1.getHistory().some((e) => e.kind === "assistant" && e.text === "glm-answer"), "replacement client answered");
      nextRunServedBy = "glm-answer";
      const switchIdle = {
        built: log1.builds[0] ?? "(none)",
        appliedNotice: noticesOf(driver1).includes("—— 已记录（provider_change 条目）并应用；下一轮的请求即生效"), // ω99-166f-iii: 钉随源演进
        cacheNoteExact: noticesOf(driver1).includes(PROVIDER_SWITCH_CACHE_NOTE),
        cacheNoteWording:
          PROVIDER_SWITCH_CACHE_NOTE.includes("切供应商后缓存完全变冷")
          && PROVIDER_SWITCH_CACHE_NOTE.includes("全部历史")
          && PROVIDER_SWITCH_CACHE_NOTE.includes("比切模型更冷"),
        entryNamesBothSides:
          jsonl1.includes("\"type\":\"provider_change\"") && jsonl1.includes("\"provider\":\"glm\"") && jsonl1.includes("\"from\":\"deepseek\""),
        statusProvider: driver1.getStatus().model?.provider ?? "(none)",
        nextRunServedBy,
      };

      // The dual switch: /provider landed above; /model switches WITHIN glm.
      driver1.submit("/model glm-4.7-air");
      await until(() => driver1.getStatus().model?.label === "glm-4.7-air", "the within-provider model switch landed");
      const jsonl1b = await readJsonl(ws, "wudao-det53-a1");
      const dualSwitch = {
        provider: driver1.getStatus().model?.provider ?? "(none)",
        model: driver1.getStatus().model?.label ?? "(none)",
        providerChangeEntries: (jsonl1b.match(/"type":"provider_change"/g) ?? []).length,
      };
      driver1.dispose();

      // ------------------------------------------------- §A the turn_usage stamp
      const received: ModelUsage[] = [];
      const wrapped = createCacheTrackingModel(usageModel("a"), {
        onUsage: (u) => received.push(u),
        coldFirstTurnAttribution: PROVIDER_SWITCH_COLD_ATTRIBUTION,
      });
      const miniInput: ModelInput = { systemPrompt: "s", messages: [], tools: [] };
      await wrapped.generate(miniInput);
      await wrapped.generate(miniInput);
      const coldReceipt = {
        firstStamped: received[0]?.coldTurnExpected === true && received[0]?.cacheBreakAttribution === PROVIDER_SWITCH_COLD_ATTRIBUTION,
        attributionWording:
          PROVIDER_SWITCH_COLD_ATTRIBUTION.includes("provider switched") && PROVIDER_SWITCH_COLD_ATTRIBUTION.includes("full history reprocessed"),
        secondClean: received[1]?.coldTurnExpected === undefined && received[1]?.cacheBreakAttribution === undefined,
      };

      // ============================================================= §A busy
      let releaseTool: (() => void) | undefined;
      const gateTool: Tool = {
        name: "gate_tool",
        description: "blocks until the test releases it",
        parameters: { type: "object", properties: {} },
        isReadOnly: () => true,
        execute: () =>
          new Promise((resolve) => {
            releaseTool = () => resolve({ content: "released" });
          }),
      };
      const live2 = asMutableConfig(liveConfig());
      const log2 = { resolve: [] as string[], builds: [] as string[] };
      const driver2 = makeDriver(
        createScriptedModel([
          { role: "assistant", content: "", toolCalls: [{ id: "g1", name: "gate_tool", arguments: {} }] },
          { role: "assistant", content: "settled" },
        ]),
        {
          workspaceRoot: ws,
          sessionId: "wudao-det53-a2",
          sessionMeta: { provider: "deepseek", model: ds.defaultModel },
          tools: [gateTool],
          onPermissionAsk: async () => ({ kind: "allow" }),
          onProviderSwitch: {
            resolve: (target: string) => {
              log2.resolve.push(target);
              return resolveProviderSwitch({ target, env: CLEAN_ENV(globalHome), current: live2 });
            },
            build: (config: ProviderConfig) => {
              log2.builds.push(`${config.provider}/${config.model}`);
              return usageModel("post-switch");
            },
          },
        },
      );
      driver2.submit("use the gate");
      await until(() => releaseTool !== undefined, "tool in flight (busy, between model calls)");
      driver2.submit("/provider qwen");
      await until(() => log2.resolve.length === 1, "resolve ran up front while parked");
      const earlyJsonl = await readJsonl(ws, "wudao-det53-a2");
      // Park-time facts: resolved, NOT built, nothing recorded.
      const earlyBuilds = log2.builds.length;
      releaseTool?.();
      await until(() => log2.builds.length === 1, "build at run settle");
      const settleNotice = noticesOf(driver2).includes(`供应商切换已在运行收束时落地——下一轮的请求走 qwen/${qwen.defaultModel}`); // ω99-166f-iii: 钉随源演进（f-ii #5 落地回执的断裂债，census 漏盘，见弧报告）
      const lateJsonl = await untilJsonl(ws, "wudao-det53-a2", "provider_change");
      const settleEntry = lateJsonl.includes("\"type\":\"provider_change\"") && lateJsonl.includes("\"from\":\"deepseek\"");
      const busyStatusProvider = driver2.getStatus().model?.provider ?? "(none)";
      const switchBusy = {
        queuedNotice: noticesOf(driver2).includes(`供应商 → qwen (${qwen.defaultModel}) —— 已排队；有运行在飞`), // ω99-166f-iii: 钉随源演进（f-ii #9 断裂债，census 漏盘）；ω99-311: 称谓产品级统一
        deferredBuild: earlyBuilds === 0,
        noEarlyEntry: !earlyJsonl.includes("provider_change"),
        settleNotice,
        settleEntry,
        statusProvider: busyStatusProvider,
      };
      driver2.dispose();

      // ======================================================= §A mid-stream
      let releaseModel: (() => void) | undefined;
      let entered = false;
      const streaming: ModelClient = {
        async generate(): Promise<AssistantMessage> {
          entered = true;
          await new Promise<void>((resolve) => {
            releaseModel = resolve;
          });
          return { role: "assistant", content: "late" };
        },
      };
      const live3 = asMutableConfig(liveConfig());
      const log3 = { resolve: [] as string[], builds: [] as string[] };
      const driver3 = makeDriver(streaming, {
        workspaceRoot: ws,
        sessionId: "wudao-det53-a3",
        sessionMeta: { provider: "deepseek", model: ds.defaultModel },
        onProviderSwitch: {
          resolve: (target: string) => {
            log3.resolve.push(target);
            return resolveProviderSwitch({ target, env: CLEAN_ENV(globalHome), current: live3 });
          },
          build: (config: ProviderConfig) => {
            log3.builds.push(`${config.provider}/${config.model}`);
            return usageModel("never");
          },
        },
      });
      driver3.submit("hold");
      await until(() => entered, "model call in flight");
      await wait(); // let the driver consume model_call_started
      driver3.submit("/provider glm");
      await wait();
      const midJsonl = await readJsonl(ws, "wudao-det53-a3");
      const switchMidStream = {
        refused: noticesOf(driver3).includes("运行中无法 /provider"),
        nothingResolved: log3.resolve.length === 0,
        nothingBuilt: log3.builds.length === 0,
        noEntry: !midJsonl.includes("provider_change"),
      };
      releaseModel?.();
      await until(() => driver3.getStatus().busy === false, "the parked run settled");
      driver3.dispose();

      // ======================================================== §A refusals
      const keyless = asMutableConfig(liveConfig({ apiKey: "", apiKeys: [] }));
      const log4 = { resolve: [] as string[], builds: [] as string[] };
      const driver4 = makeDriver(createScriptedModel([]), {
        workspaceRoot: ws,
        sessionId: "wudao-det53-a4",
        sessionMeta: { provider: "deepseek", model: ds.defaultModel },
        onProviderSwitch: {
          resolve: (target: string) => {
            log4.resolve.push(target);
            return resolveProviderSwitch({ target, env: CLEAN_ENV(globalHome), current: keyless });
          },
          build: (config: ProviderConfig) => {
            log4.builds.push(`${config.provider}/${config.model}`);
            return usageModel("never");
          },
        },
      });
      driver4.submit("/provider glm");
      await until(() => log4.resolve.length === 1, "keyless resolve ran");
      driver4.submit("/provider grok");
      driver4.submit("/provider deepseek");
      await wait();
      const refusedText = noticesOf(driver4);
      const refuseJsonl = await readJsonl(ws, "wudao-det53-a4");
      const switchRefusals = {
        sameProviderNoOp: refusedText.includes("（已在 deepseek 上"), // ω99-166f-iii: 钉随源演进（f-ii #15 断裂债，census 漏盘）
        missingKeyNamesFix:
          refusedText.includes("拒绝切换到 provider glm：no API key configured") && refusedText.includes("WUDAO_API_KEY"), // ω99-166f-iii: 钉随源演进（166c-iii #10 断裂债；r.error 插值仍英文，域外）
        unknownListsMatrix: refusedText.includes("unknown provider \"grok\"") && refusedText.includes("deepseek, glm, qwen, wudao"),
        noEntry: !refuseJsonl.includes("provider_change") && log4.builds.length === 0,
      };
      driver4.dispose();

      // ============================================ §A resume folds the entry
      // Session a2 ends in a PURE provider switch (no later model_change):
      // the fold must come from the provider_change entry alone.
      const store = createJsonlSessionStore(join(ws, ".wudao", "sessions"));
      const folded = lastModelState(await store.loadSessionEntries("wudao-det53-a2"));
      const resumeFold = { provider: folded.provider, model: folded.model };

      // ====================================== §A↔§C the completion carve-out
      const placeholderLive = asMutableConfig({
        apiKey: WIZARD_PLACEHOLDER_KEY,
        baseURL: ds.defaultBaseUrl ?? "https://api.deepseek.com",
        model: ds.defaultModel,
        provider: "deepseek",
      });
      const log5 = { resolve: [] as string[], builds: [] as string[] };
      const seeded = createScriptedModel([{ role: "assistant", content: "must never serve" }]);
      const rebuilt = usageModel("WIZARD-LIVE-OK");
      const driver5 = makeDriver(seeded, {
        workspaceRoot: ws,
        sessionId: "wudao-det53-c1",
        sessionMeta: { provider: "deepseek", model: ds.defaultModel },
        onProviderSwitch: {
          resolve: (target: string) => {
            log5.resolve.push(target);
            // The real completion path: the wizard just saved a deepseek key
            // to the credentials file — the file leg resolves it.
            return resolveProviderSwitch({
              target,
              env: CLEAN_ENV(globalHome),
              current: placeholderLive,
              credentials: { deepseek: "sk-wizard-ds" },
            });
          },
          build: (config: ProviderConfig) => {
            log5.builds.push(`${config.provider}/${config.apiKey}`);
            applyProviderConfig(placeholderLive, config);
            return rebuilt;
          },
          isPlaceholderLive: () => placeholderLive.apiKey === WIZARD_PLACEHOLDER_KEY,
        },
      });
      driver5.submit("/provider deepseek"); // SAME name — the carve-out path
      await until(() => log5.builds.length === 1, "the same-name switch resolves+rebuilds");
      let carveServedBy = "";
      driver5.submit("hello after the wizard");
      await until(
        () => driver5.getHistory().some((e) => e.kind === "assistant" && e.text === "WIZARD-LIVE-OK"),
        "the rebuilt client served the first prompt",
      );
      carveServedBy = rebuilt.calls === 1 ? "WIZARD-LIVE-OK" : `(calls=${rebuilt.calls})`;
      const carveJsonl = await untilJsonl(ws, "wudao-det53-c1", "provider_change");
      const carveOut = {
        builtWithSavedKey: log5.builds[0] ?? "(none)",
        appliedNotice: noticesOf(driver5).includes("—— 已记录（provider_change 条目）并应用"), // ω99-166f-iii: 钉随源演进（census 漏盘的 §C carve-out 孪生，见弧报告偏差节）
        entry: carveJsonl.includes("\"type\":\"provider_change\""),
        firstPromptServedBy: carveServedBy,
      };
      driver5.dispose();

      // The sentinel reads as ABSENT in resolution: a placeholder-only pool
      // is keyless (the sentinel can never ride a live request).
      const sentinelOnly = resolveProviderSwitch({
        target: "glm",
        env: CLEAN_ENV(globalHome),
        current: { apiKey: WIZARD_PLACEHOLDER_KEY, apiKeys: [WIZARD_PLACEHOLDER_KEY] },
      });
      if (sentinelOnly.ok || !sentinelOnly.error.includes("no API key configured")) {
        throw new Error(`the wizard placeholder must resolve as ABSENT, got ${JSON.stringify(sentinelOnly)}`);
      }

      // ============================================ §C the browse-only guard
      const guardLive = asMutableConfig({
        apiKey: WIZARD_PLACEHOLDER_KEY,
        baseURL: ds.defaultBaseUrl ?? "https://api.deepseek.com",
        model: ds.defaultModel,
        provider: "deepseek",
      });
      const guardSeeded = usageModel("must-not-serve");
      const driver6 = makeDriver(guardSeeded, {
        workspaceRoot: ws,
        sessionId: "wudao-det53-c2",
        sessionMeta: { provider: "deepseek", model: ds.defaultModel },
        onProviderSwitch: {
          resolve: (target: string) => resolveProviderSwitch({ target, env: CLEAN_ENV(globalHome), current: guardLive }),
          build: (config: ProviderConfig) => {
            applyProviderConfig(guardLive, config);
            return usageModel("never");
          },
          isPlaceholderLive: () => guardLive.apiKey === WIZARD_PLACEHOLDER_KEY,
        },
      });
      driver6.submit("hello there");
      await until(() => errorsOf(driver6).length === 1, "the browse-only refusal entry");
      const guardError = errorsOf(driver6)[0] ?? "";
      const browseGuard = {
        refused: guardError.includes("只读浏览模式"),
        namesWizardPath: guardError.includes("去配置") && guardError.includes("新手向导"),
        zeroModelCalls: guardSeeded.calls === 0,
        notBusy: driver6.getStatus().busy === false,
      };
      driver6.dispose();

      // ================================== §B credentials precedence (real seams)
      const envWins = resolveProviderConfigResult({ WUDAO_API_KEY: "sk-env" }, {}, { deepseek: "sk-file" });
      const fileFills = resolveProviderConfigResult(CLEAN_ENV(globalHome), { provider: "glm" }, { glm: "sk-file-glm" });
      const fileNeverShadows = resolveProviderConfigResult({ WUDAO_API_KEY: "sk-env" }, { provider: "glm" }, { glm: "sk-file-glm" });
      const noKeyAnywhere = resolveProviderConfigResult(CLEAN_ENV(globalHome), {}, {});
      const runPlanFile = buildRunPlan({ prompt: "p", env: CLEAN_ENV(globalHome), provider: "glm", credentials: { glm: "sk-plan-file" } });
      // The real FILE under the pinned global home feeds the real one-shot
      // loader (input.credentials absent → readCredentialsFileSync).
      await writeCredentialsFile({ deepseek: "sk-real-file" }, CLEAN_ENV(globalHome));
      const runPlanRealFile = buildRunPlan({ prompt: "p", env: CLEAN_ENV(globalHome) });
      const credentialsPrecedence = {
        envWins: envWins.ok ? envWins.config.apiKey : `(refused: ${envWins.reason})`,
        fileFills: fileFills.ok ? fileFills.config.apiKey : `(refused: ${fileFills.reason})`,
        fileNeverShadowsEnv: fileNeverShadows.ok ? fileNeverShadows.config.apiKey : `(refused: ${fileNeverShadows.reason})`,
        noKeyAnywhere: !noKeyAnywhere.ok ? noKeyAnywhere.reason : `(unexpectedly ok: ${noKeyAnywhere.config.apiKey})`,
        runPlanFileKey: runPlanFile.kind === "real" ? runPlanFile.config.apiKey : `(kind: ${runPlanFile.kind})`,
        runPlanRealFileBoot: runPlanRealFile.kind === "real" ? runPlanRealFile.config.apiKey : `(kind: ${runPlanRealFile.kind})`,
      };

      // =========================================== §B the credentials file itself
      await writeCredentialsFile({ deepseek: "sk-x", glm: "sk-y" }, CLEAN_ENV(globalHome));
      const fileWritten = await credentialsFileStatus(CLEAN_ENV(globalHome));
      const inode = await stat(fileWritten.path);
      const roundTrip = await readCredentialsFile(CLEAN_ENV(globalHome));
      const saved = await saveProviderKey("qwen", "sk-z", CLEAN_ENV(globalHome));
      const afterMerge = await readCredentialsFile(CLEAN_ENV(globalHome));
      const statusFace = await credentialsFileStatus(CLEAN_ENV(globalHome));
      const credentialsFile = {
        // win32: mode bits are not enforced (a 0600 create reads back 0666)
        // — the octal legs are posix-only; modeOk carries the platform truth.
        mode0600:
          (process.platform === "win32" || ((inode.mode & 0o777) === 0o600 && fileWritten.mode === "600")) &&
          statusFace.modeOk,
        roundTrip: roundTrip.deepseek === "sk-x" && roundTrip.glm === "sk-y",
        countsOnly: JSON.stringify(statusFace).includes('"keyCount":3') && !JSON.stringify(statusFace).includes("sk-"),
        mergePreserves: saved.keyCount === 3 && Object.keys(afterMerge).length === 3,
        saveReplySecretFree: !JSON.stringify(saved).includes("sk-"),
      };

      // ================================================== §B the settings ops
      const wsSettings = await mkdtemp(join(root, "ws-settings-"));
      const opsEnv = CLEAN_ENV(globalHome);
      const ops = createSettingsOps({ env: opsEnv, workspaceRoot: wsSettings });
      await ops.settingsSet("ui.defaultMode", "simple");
      const afterSimple = await ops.settingsStatus();
      // The M1 diff-write: a HAND-written escalation node in the global tier
      // (the exact scenario the review fix pinned — the user wrote slack by
      // hand; the writer only refuses keys IT introduces) survives a
      // preference write verbatim…
      await writeFile(
        globalSettingsPath(opsEnv),
        `${JSON.stringify({ slack: { enabled: true, allowUsers: ["ops"] } }, null, 2)}\n`,
        "utf8",
      );
      await ops.settingsSet("memoryEnabled", false);
      const recordWithEscalation = await readGlobalSettings(opsEnv);
      // …but this writer never INTRODUCES one (fresh record, autoMode new).
      const cleanHome2 = join(root, "global-home-2");
      await mkdir(cleanHome2, { recursive: true });
      let introduced: string | undefined;
      try {
        await saveGlobalSettings({ autoMode: true }, CLEAN_ENV(cleanHome2));
      } catch (err) {
        introduced = err instanceof Error ? err.message : String(err);
      }
      let invalidMode: string | undefined;
      try {
        await ops.settingsSet("ui.defaultMode", "bogus");
      } catch (err) {
        invalidMode = err instanceof Error ? err.message : String(err);
      }
      let unknownKey: string | undefined;
      try {
        await ops.settingsSet("protectedPaths", ["/etc"]);
      } catch (err) {
        unknownKey = err instanceof Error ? err.message : String(err);
      }
      const opsKeyed = createSettingsOps({ env: { ...opsEnv, WUDAO_API_KEY: "sk-env-live" }, workspaceRoot: wsSettings });
      const settingsSet = {
        persistsSimple: afterSimple.settings.uiDefaultMode,
        invalidModeRefused: invalidMode,
        unknownKeyRefused: unknownKey,
        introducedEscalationRefused: introduced,
        handWrittenEscalationSurvives:
          JSON.stringify(recordWithEscalation.slack) === JSON.stringify({ enabled: true, allowUsers: ["ops"] })
          && recordWithEscalation.memoryEnabled === false,
        envKeyNote: (await opsKeyed.settingsStatus()).envKey === true,
      };

      // ============================================ §B the test-connection states
      const fakeFetch = (status: number, body = ""): typeof fetch =>
        (async (): Promise<Response> => ({ ok: status < 400, status, text: async () => body }) as unknown as Response) as unknown as typeof fetch;
      const throwingFetch = (async (): Promise<never> => {
        throw new Error("fetch failed");
      }) as unknown as typeof fetch;
      const tcEnv = CLEAN_ENV(globalHome);
      const tcOf = (f: typeof fetch) => createSettingsOps({ env: tcEnv, workspaceRoot: wsSettings, testTimeoutMs: 500, fetchImpl: f });
      const okResult = await tcOf(fakeFetch(200)).settingsTestConnection("deepseek", { key: "sk-pasted" });
      const authResult = await tcOf(fakeFetch(401)).settingsTestConnection("deepseek", { key: "sk-pasted" });
      const netResult = await tcOf(throwingFetch).settingsTestConnection("deepseek", { key: "sk-pasted" });
      const modelResult = await tcOf(fakeFetch(404)).settingsTestConnection("deepseek", { key: "sk-pasted" });
      const sniffResult = await tcOf(fakeFetch(400, '{"error":"Model Not Exist"}')).settingsTestConnection("deepseek", { key: "sk-pasted" });
      // no-key: a fresh home (no credentials file) and nothing pasted/env.
      const tcHome2 = join(root, "tc-home-2");
      await mkdir(tcHome2, { recursive: true });
      const noKeyResult = await createSettingsOps({
        env: CLEAN_ENV(tcHome2),
        workspaceRoot: wsSettings,
        fetchImpl: fakeFetch(200),
      }).settingsTestConnection("qwen", {});
      if (noKeyResult.state !== "no-key" || !noKeyResult.message.includes("请先保存")) {
        throw new Error(`no-key test state wrong: ${JSON.stringify(noKeyResult)}`);
      }
      const testConnection = {
        ok: okResult.message,
        auth: authResult.message,
        network: netResult.message,
        model404: modelResult.message,
        model400Body: sniffResult.message,
      };

      // ================================================ §C the readiness join
      const matrixAnyReady = buildProviderMatrix({ WUDAO_API_KEY: "k" }, {});
      const matrixNone = buildProviderMatrix(CLEAN_ENV(globalHome), {});
      const matrixFile = buildProviderMatrix(CLEAN_ENV(globalHome), { glm: "sk-file-glm" });
      const matrixWudaoFile = buildProviderMatrix(CLEAN_ENV(globalHome), { wudao: "sk-wudao" });
      const wudaoCard = matrixWudaoFile.find((c) => c.provider === "wudao");
      const versionBefore = (await ops.settingsStatus()).settings.wizardCompletedVersion;
      await ops.settingsSet("wizard.completedVersion", 1);
      const versionAfter = (await ops.settingsStatus()).settings.wizardCompletedVersion;
      const readiness = {
        anyReady: settingsReadiness(matrixAnyReady) === true && matrixAnyReady[0]?.status === "ready",
        noneReady: settingsReadiness(matrixNone) === false && matrixNone.every((c) => c.status === "missing-key"),
        endpointGate: settingsReadiness(matrixFile) === true && settingsReadiness(matrixWudaoFile) === false && wudaoCard?.status === "missing-endpoint",
        versionRoundTrip: [versionBefore, versionAfter] as [number, number],
      };

      // ================================================== §C the boot matrix
      const bootEnvKey = buildUiBootPlan({ prompt: "p", env: { WUDAO_API_KEY: "sk-env" }, credentials: {} });
      const bootFile = buildUiBootPlan({ prompt: "p", env: CLEAN_ENV(globalHome), credentials: { glm: "sk-glm-file" } });
      const bootWizard = buildUiBootPlan({ prompt: "p", env: CLEAN_ENV(globalHome), credentials: {} });
      const bootExit = buildUiBootPlan({ prompt: "p", env: CLEAN_ENV(globalHome), provider: "wudao", credentials: {} });
      const ghost = resolveProviderConfigResult(CLEAN_ENV(globalHome), { provider: "deepseek" }, { deepseek: WIZARD_PLACEHOLDER_KEY });
      const bootMatrix = {
        envKeyReal: bootEnvKey.kind === "real",
        fileSubstitutionNotice: bootFile.kind === "real" ? bootFile.notice : `(kind: ${bootFile.kind})`,
        wizardBoot:
          bootWizard.kind === "wizard"
          && bootWizard.notice.includes("新手向导")
          && bootWizard.notice.includes("read-only browsing"),
        placeholderShape:
          bootWizard.kind === "wizard"
          && ghost.ok
          && bootWizard.config.apiKey === WIZARD_PLACEHOLDER_KEY
          && bootWizard.config.apiKeys === undefined
          && bootWizard.config.model === ghost.config.model
          && bootWizard.config.baseURL === ghost.config.baseURL,
        exitNamesWizard: bootExit.kind === "exit" && bootExit.message.includes("WUDAO_BASE_URL") && bootExit.message.includes("新手向导"),
      };

      // ================================== §D the mode tri-state + persistence
      const wsMode = await mkdtemp(join(root, "ws-mode-"));
      const modeHome = join(root, "mode-home-2");
      await mkdir(modeHome, { recursive: true });
      const modeEnv = CLEAN_ENV(modeHome);
      const modeOps = createSettingsOps({ env: modeEnv, workspaceRoot: wsMode });
      const layeredAbsent = await loadLayeredSettings(wsMode, () => {}, modeEnv);
      const triAbsent = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      await saveGlobalSettings({ ui: { defaultMode: "simple" } }, modeEnv);
      const triSimple = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      await saveGlobalSettings({ ui: { defaultMode: "advanced" } }, modeEnv);
      const triAdvanced = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      await saveGlobalSettings({ ui: { defaultMode: "turbo" } }, modeEnv);
      const triGarbage = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      if (layeredAbsent.effective["ui"] !== undefined) {
        throw new Error("the real layered read must report NO ui node when unset");
      }
      // The toggle persists through settingsSet — simple then advanced, ONE node.
      await modeOps.settingsSet("ui.defaultMode", "simple");
      const afterS = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      await modeOps.settingsSet("ui.defaultMode", "advanced");
      const afterA = (await modeOps.settingsStatus()).settings.uiDefaultMode;
      const uiNode = (await readGlobalSettings(modeEnv))["ui"] as Record<string, unknown> | undefined;
      const modeTriState = { absent: triAbsent, simple: triSimple, advanced: triAdvanced, garbage: triGarbage };
      const modePersist = {
        afterSimple: afterS,
        afterAdvanced: afterA,
        singleNode: uiNode !== undefined && uiNode.defaultMode === "advanced" && Object.keys(uiNode).length === 1,
      };
      // The C↔D contract: the wizard's completion writes land BOTH keys in
      // ONE global record — one settingsStatus read returns the pair.
      await modeOps.settingsSet("wizard.completedVersion", 1);
      await modeOps.settingsSet("ui.defaultMode", "simple");
      const contractStatus = await modeOps.settingsStatus();
      const wizardContract = {
        defaultMode: contractStatus.settings.uiDefaultMode,
        completedVersion: contractStatus.settings.wizardCompletedVersion,
      };

      return {
        switchIdle,
        coldReceipt,
        switchBusy,
        switchMidStream,
        switchRefusals,
        dualSwitch,
        resumeFold,
        carveOut,
        browseGuard,
        credentialsPrecedence,
        credentialsFile,
        settingsSet,
        testConnection,
        bootMatrix,
        readiness,
        modeTriState,
        modePersist,
        wizardContract,
      };
    } finally {
      // Restore the process env the eval mutated (the runner shares it).
      for (const k of ENV_KEYS_TO_PIN) {
        const v = prev[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (prevGlobalHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevGlobalHome;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await rm(ws, { recursive: true, force: true }).catch(() => {});
    }
  },
  assertions(e) {
    const errors: string[] = [];
    const need = (cond: boolean, what: string): void => {
      if (!cond) errors.push(what);
    };

    // ---------------------------------------------------------------- §A
    need(e.switchIdle.built === `glm/${PROVIDER_PROFILES.glm!.defaultModel}`, `§A idle: the switch must build the TARGET profile's client, got ${e.switchIdle.built}`);
    need(e.switchIdle.appliedNotice, "§A idle: the receipt must say recorded (provider_change entry) and applied");
    need(e.switchIdle.cacheNoteExact, "§A idle: the receipt must carry the exact FULLY-cold cache note");
    need(e.switchIdle.cacheNoteWording, "§A idle: the cache note must keep the colder-than-model wording (FULLY cold / ENTIRE history)");
    need(e.switchIdle.entryNamesBothSides, "§A idle: the JSONL provider_change entry must name both sides (provider glm, from deepseek)");
    need(e.switchIdle.statusProvider === "glm", `§A idle: the live identity must move to glm, got ${e.switchIdle.statusProvider}`);
    need(e.switchIdle.nextRunServedBy === "glm-answer", `§A idle: the next run must be served by the REBUILT client, got ${e.switchIdle.nextRunServedBy}`);
    need(e.coldReceipt.firstStamped, "§A receipt: the first usage after a switch must carry coldTurnExpected + the provider-switch attribution");
    need(e.coldReceipt.attributionWording, "§A receipt: the attribution must say the full history was reprocessed");
    need(e.coldReceipt.secondClean, "§A receipt: later turns must be clean (one stamp per switch)");
    need(e.switchBusy.queuedNotice, "§A busy: the switch must queue with the in-flight notice");
    need(e.switchBusy.deferredBuild, "§A busy: the build must be deferred while the run is in flight");
    need(e.switchBusy.noEarlyEntry, "§A busy: no provider_change entry before the build lands (entry-after-build)");
    need(e.switchBusy.settleNotice, "§A busy: the switch must land at run settle with the boundary notice");
    need(e.switchBusy.settleEntry, "§A busy: the entry must land at the settle");
    need(e.switchBusy.statusProvider === "qwen", `§A busy: the identity must move to qwen at settle, got ${e.switchBusy.statusProvider}`);
    need(e.switchMidStream.refused, "§A mid-stream: /provider must refuse while a response is streaming");
    need(e.switchMidStream.nothingResolved && e.switchMidStream.nothingBuilt, "§A mid-stream: the refusal must resolve and build nothing");
    need(e.switchMidStream.noEntry, "§A mid-stream: nothing may be recorded");
    need(e.switchRefusals.sameProviderNoOp, "§A refusals: a same-provider switch on a REAL key is the no-op");
    need(e.switchRefusals.missingKeyNamesFix, "§A refusals: the missing-key refusal must name WUDAO_API_KEY");
    need(e.switchRefusals.unknownListsMatrix, "§A refusals: an unknown provider must list the matrix");
    need(e.switchRefusals.noEntry, "§A refusals: a refused switch records nothing");
    need(e.dualSwitch.provider === "glm" && e.dualSwitch.model === "glm-4.7-air", `§A dual: after /provider glm + /model the identity must be glm/glm-4.7-air, got ${e.dualSwitch.provider}/${e.dualSwitch.model}`);
    need(e.dualSwitch.providerChangeEntries === 1, `§A dual: exactly ONE provider_change entry, got ${e.dualSwitch.providerChangeEntries}`);
    need(e.resumeFold.provider === "qwen" && e.resumeFold.model === PROVIDER_PROFILES.qwen!.defaultModel, `§A resume: lastModelState must fold the provider_change entry, got ${JSON.stringify(e.resumeFold)}`);

    // ------------------------------------------------------------ §A↔§C
    need(e.carveOut.builtWithSavedKey === "deepseek/sk-wizard-ds", `§C carve-out: the same-name switch must rebuild with the SAVED key, got ${e.carveOut.builtWithSavedKey}`);
    need(e.carveOut.appliedNotice, "§C carve-out: the same-name switch must record + apply (not the already-on no-op)");
    need(e.carveOut.entry, "§C carve-out: the completion switch writes its provider_change entry");
    need(e.carveOut.firstPromptServedBy === "WIZARD-LIVE-OK", `§C carve-out: the first prompt must run on the rebuilt client, got ${e.carveOut.firstPromptServedBy}`);
    need(e.browseGuard.refused, "§C guard: a prompt on the placeholder must be refused as 只读浏览模式");
    need(e.browseGuard.namesWizardPath, "§C guard: the refusal must name the way back (去配置 / 新手向导)");
    need(e.browseGuard.zeroModelCalls && e.browseGuard.notBusy, "§C guard: the refusal must issue zero model calls and start no run");

    // ---------------------------------------------------------------- §B
    need(e.credentialsPrecedence.envWins === "sk-env", `§B precedence: the env key must win over the file, got ${e.credentialsPrecedence.envWins}`);
    need(e.credentialsPrecedence.fileFills === "sk-file-glm", `§B precedence: the file key must fill the SELECTED provider when the pool is empty, got ${e.credentialsPrecedence.fileFills}`);
    need(e.credentialsPrecedence.fileNeverShadowsEnv === "sk-env", `§B precedence: the file must never shadow the env pool, got ${e.credentialsPrecedence.fileNeverShadowsEnv}`);
    need(e.credentialsPrecedence.noKeyAnywhere === "no API key found", `§B precedence: no key anywhere must refuse with the reason, got ${e.credentialsPrecedence.noKeyAnywhere}`);
    need(e.credentialsPrecedence.runPlanFileKey === "sk-plan-file", `§B loader: buildRunPlan must resolve the credentials-map key, got ${e.credentialsPrecedence.runPlanFileKey}`);
    need(e.credentialsPrecedence.runPlanRealFileBoot === "sk-real-file", `§B loader: the real ~/.wudao credentials file must feed the real boot, got ${e.credentialsPrecedence.runPlanRealFileBoot}`);
    need(e.credentialsFile.mode0600, "§B file: the credentials file must be 0600 (stat + status face)");
    need(e.credentialsFile.roundTrip, "§B file: the written map must round-trip through the reader");
    need(e.credentialsFile.countsOnly, "§B file: status surfaces must carry COUNTS only, never values");
    need(e.credentialsFile.mergePreserves, "§B file: saveProviderKey must merge into the existing map (3 keys)");
    need(e.credentialsFile.saveReplySecretFree, "§B file: the save reply must not carry the key back");
    need(e.settingsSet.persistsSimple === "simple", `§B settingsSet: ui.defaultMode=simple must persist through the real read, got ${JSON.stringify(e.settingsSet.persistsSimple)}`);
    need((e.settingsSet.invalidModeRefused ?? "").includes("ui.defaultMode must be"), `§B settingsSet: an invalid mode must be refused, got ${e.settingsSet.invalidModeRefused}`);
    need((e.settingsSet.unknownKeyRefused ?? "").includes("unknown settings key"), `§B settingsSet: an unknown key must be refused (the escalation allowlist), got ${e.settingsSet.unknownKeyRefused}`);
    need((e.settingsSet.introducedEscalationRefused ?? "").includes("提权键"), `§B settingsSet: the global writer must refuse INTRODUCED escalations, got ${e.settingsSet.introducedEscalationRefused}`); // ω99-183: 钉随源演进
    need(e.settingsSet.handWrittenEscalationSurvives, "§B settingsSet: a hand-written global escalation node must survive a preference write verbatim");
    need(e.settingsSet.envKeyNote, "§B settingsSet: the env-wins note flag must be true when the env pool is set");
    need(e.testConnection.ok === "连接成功", `§B test: ok state wording, got ${e.testConnection.ok}`);
    need(e.testConnection.auth.includes("Key 无效或无余额"), `§B test: 401 must say Key 无效或无余额, got ${e.testConnection.auth}`);
    need(e.testConnection.network.includes("网络不通"), `§B test: transport failure must say 网络不通, got ${e.testConnection.network}`);
    need(e.testConnection.model404.includes("模型名不存在"), `§B test: 404 must say 模型名不存在, got ${e.testConnection.model404}`);
    need(e.testConnection.model400Body.includes("模型名不存在"), `§B test: a 400 Model-Not-Exist body must sniff to 模型名不存在, got ${e.testConnection.model400Body}`);

    // ---------------------------------------------------------------- §C
    need(e.readiness.anyReady, "§C readiness: ANY ready provider must make the surface ready (the wizard never shows)");
    need(e.readiness.noneReady, "§C readiness: no keys anywhere must read not-ready");
    need(e.readiness.endpointGate, "§C readiness: a wudao file key without an endpoint must stay not-ready (missing-endpoint)");
    need(JSON.stringify(e.readiness.versionRoundTrip) === "[0,1]", `§C readiness: wizard.completedVersion must round-trip 0→1, got ${JSON.stringify(e.readiness.versionRoundTrip)}`);
    need(e.bootMatrix.envKeyReal, "§C boot: an env key boots real — the wizard is skipped whole");
    need((e.bootMatrix.fileSubstitutionNotice ?? "").includes("no key for the selected provider (deepseek) — booting glm"), `§C boot: a ready non-selected provider must boot with the substitution notice, got ${e.bootMatrix.fileSubstitutionNotice}`);
    need(e.bootMatrix.wizardBoot, "§C boot: nobody ready must boot the wizard placeholder with the browse notice");
    need(e.bootMatrix.placeholderShape, "§C boot: the placeholder config must be the resolver's own output shape (byte-identical fields)");
    need(e.bootMatrix.exitNamesWizard, "§C boot: the exit path must name WUDAO_BASE_URL and the wizard");

    // ---------------------------------------------------------------- §D
    need(e.modeTriState.absent === null, `§D tri-state: an unset ui.defaultMode must read null (the consumer treats it as advanced), got ${JSON.stringify(e.modeTriState.absent)}`);
    need(e.modeTriState.simple === "simple" && e.modeTriState.advanced === "advanced", `§D tri-state: explicit values must read through, got ${e.modeTriState.simple}/${e.modeTriState.advanced}`);
    need(e.modeTriState.garbage === null, `§D tri-state: a garbage value must fold to null, got ${JSON.stringify(e.modeTriState.garbage)}`);
    need(e.modePersist.afterSimple === "simple" && e.modePersist.afterAdvanced === "advanced", `§D persist: the mode toggle must persist through settingsSet, got ${e.modePersist.afterSimple}/${e.modePersist.afterAdvanced}`);
    need(e.modePersist.singleNode, "§D persist: the global record must keep ONE ui node with defaultMode");
    need(e.wizardContract.defaultMode === "simple" && e.wizardContract.completedVersion === 1, `§D contract: the wizard completion must land ui.defaultMode=simple next to completedVersion=1, got ${JSON.stringify(e.wizardContract)}`);
    return errors;
  },
  metrics(e) {
    return {
      providerSwitchLanes: 6,
      providerChangeEntriesObserved: e.dualSwitch.providerChangeEntries,
      bootLanes: 4,
      testConnectionStates: 5,
    };
  },
};
