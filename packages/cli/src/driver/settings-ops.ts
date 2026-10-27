// M63 §B — the CLI-side settings/credentials handler behind the web
// settings page. Four ops (relayed by @wudao/server after the SAME
// first-frame auth as every other op):
//
//   settingsStatus        the provider-card matrix (status dots), the
//                         credentials-file COUNT, and the settings values —
//                         status payloads never carry key material;
//   settingsSaveKey       one provider key into ~/.wudao/.credentials.yaml
//                         (credentials.ts: atomic write + chmod 0600 every
//                         time). The reply is {provider, saved, keyCount} —
//                         the key NEVER travels back (the server strips any
//                         stray secret fields at the protocol boundary too);
//   settingsTestConnection one minimal chat/completions request (max_tokens
//                         1) through the target provider — explicit pasted
//                         key wins, then the env pool (selected provider
//                         only), then the credentials file — classified into
//                         the three human failure states;
//   settingsSet           one allowlisted personal preference into the GLOBAL
//                         settings tier (the 12 writable keys — ω99-237: #3
//                         truth fix; the unknown-key error at settingsSet's
//                         tail enumerates them verbatim: single source of
//                         truth, pinned by omega99-237-writable-keys-pin.
//                         History: ui.defaultMode, ui.theme, ui.accent,
//                         memoryEnabled, model.defaultModel,
//                         model.defaultEffort, wizard.completedVersion,
//                         persona.id — M63 §C; R6 quickwin adds the Ctrl+S
//                         pick defaults model.defaultModel /
//                         model.defaultEffort, applied by the `wudao ui` boot
//                         when no flag/env pins the field; persona-settings T5
//                         adds the global default persona id, "" clearing it;
//                         0.3.11 adds permissions.defaultMode — the persisted
//                         default permission tier the boot applies when no
//                         CLI flag pins the mode, global-tier only by the
//                         trust gate; ω99-234 adds language.reply /
//                         language.reasoning — the language chip's persisted
//                         knobs; ω99-236: #8 adds docSuite.enabled — the doc
//                         trio's opt-out mount gate, default true;
//                         ω99-287: #1 adds desktop.backgroundOnClose — the
//                         desktop's 关窗后台 toggle (L2 A 案), boolean,
//                         default false (Q1: 用户显式开), fail-closed read
//                         (absent/corrupt → false → the close fork keeps
//                         the old quit semantics); 122 项 2 adds
//                         schedules.launchAgent — the 定时任务离线唤起
//                         opt-in (LaunchAgent, macOS), boolean, default
//                         false, read LIVE by the schedule daemon's
//                         reconcile (≤ one tick, no restart).
// M63 §C additions: settingsStatus carries the readiness join (any provider
// ready = ready — the first-run wizard's gate) and the wizard's
// completedVersion marker (the versioned welcome notice).
// SDD 2026-08-23 persona Task 5 additions: settingsStatus also carries
// settings.personaId (the global default persona id), and the four persona
// ops (personaList/personaGet/personaSave/personaDelete — the web settings
// page's persona tab) ride this same handler module over the providers
// package's persona seam (registry + file helpers).
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  BUILTIN_PERSONAS,
  REASONING_EFFORTS,
  defaultProviderRegistryPath,
  deletePersonaDefinition,
  isProviderName,
  loadPersonaRegistry,
  parseApiKeyPool,
  parsePersonaSpec,
  personaIdsInDir,
  savePersonaDefinition,
  validatePersonaDefinition,
} from "@wudao/providers";
import { openMemoryStore, readMemoryFile } from "@wudao/core";
import type { EffectiveProfile, PersonaDefinition, ProviderName, ReasoningEffort } from "@wudao/providers";
import { resolveMemorySettings, resolveDocSuiteEnabled, schedulesSettingsFromNode } from "../misc-config.js";
import { resolveLanguagePreference } from "../language.js";
import { loadLayeredSettings, readGlobalDefaultPermissionMode, readGlobalSettings, readGlobalSettingsSync, resolveGlobalHome, saveGlobalSettings } from "../settings-layer.js";
import { credentialsFileStatus, readCredentialsFile, saveProviderKey } from "../credentials.js";
import { isHttpMcpServer, loadMcpTiers, ccMcpConfigPath, globalMcpConfigPath, mcpConfigPath } from "../mcp/config.js";
import { mcpRuntimeSnapshot } from "../mcp/tools.js";
import { redactUrl } from "../mcp/http.js";
import type { Mode } from "../permission.js";
import type { AgentDriver } from "./agent-driver.js";
// 小精灵会话弧 — 会话级 fork 复用 CLI --fork-session 的实现（字节复制 +
// 120-a A3 的 rewind lineage 继承），经 op 通道（resume 携 fork:true）暴露。
import { forkSessionFile } from "../fork-session.js";
import type { UiDriverPort } from "@wudao/server";
import { createAttachmentOps } from "./attachment-ops.js";
// cc-plugins C1 — the plugin-management ops ride the SAME A1/A2 marketplace
// engine the /plugin slash face and `wudao plugin` drive (one engine, three
// faces). Aliased: these ops own the marketplace-prefixed names on the port.
import {
  marketplacesDir,
  parseMarketSource,
  readMarketplaceFile,
  marketplaceAdd as engineMarketAdd,
  marketplaceList as engineMarketList,
  marketplaceRemove as engineMarketRemove,
  marketplaceUpdate as engineMarketUpdate,
  pluginEnable as engineSetEnabled,
  pluginInstall as engineInstall,
  pluginInstallSpec as engineInstallSpec,
  pluginListInstalled as engineListInstalled,
  pluginUninstall as engineUninstall,
  type InstallDetail,
  type InstalledPluginRow,
  type MarketplaceEntry,
  type MarketplaceInfo,
} from "../marketplace.js";
import { inspectPluginDir } from "../plugins.js";
import { rescanExtensions } from "../extension-state.js";
// Provider management: the matrix/gates resolve against the effective view
// (builtins ⊕ overlays ⊕ customs) — one memoized registry read per process.
import { loadProviderRegistry, loadEffectiveProfiles } from "../provider-registry.js";
// Provider management §5: the registry write ops + the /models probe
// (composed into withSettingsOps below). Module-cycle note: the ops file
// imports this module's classifier/message helpers — deferred (function-body)
// usage only, safe in both evaluation orders.
import { clearProviderPersonaBindings, createProviderRegistryOps, migrateKimiCodeSplit, providersBoundToPersona } from "./provider-registry-ops.js";

/** One provider card's data (the status dot source). No secrets. */
export interface ProviderCardStatus {
  readonly provider: ProviderName;
  readonly label: string;
  /** ready = key resolvable AND endpoint known; missing-key beats
   *  missing-endpoint when both are gone (the key is the usual blocker). */
  readonly status: "ready" | "missing-key" | "missing-endpoint";
  /** Where a resolvable key would come from (env pool = the SELECTED
   *  provider only; the file is per-provider). null = no key anywhere. */
  readonly keySource: "env" | "credentials" | null;
  /** The resolved baseURL (profile default, or the env override when this
   *  provider is the selected one); null when unresolvable (wudao sans URL). */
  readonly endpoint: string | null;
  readonly defaultModel: string;
  /** Provider management §5: the REGISTERED/compiled baseUrl (the edit
   *  form's prefill) — `endpoint` above stays the resolved URL (env override
   *  applied when this provider is the selected one). Absent when the
   *  profile has none (wudao). */
  readonly baseUrl?: string;
  /** 0.3.28 ②: the RAW registry overlay's baseUrl — the user's override on a
   *  BUILTIN, distinct from `baseUrl` above (the EFFECTIVE base: overlay ??
   *  compiled default). Absent = no overlay (the builtin runs its compiled
   *  default). The builtin edit form seeds its 端点 input from THIS field
   *  (empty = revert to the compiled default), so an un-overlaid builtin
   *  doesn't prefill with the compiled URL and silently pin it on save —
   *  the same seeding rule the three-state bindings use. */
  readonly registeredBaseUrl?: string;
  /** Registry facts the detail panel renders: user-registered (custom) vs
   *  compiled-in, and the model catalog with optional context windows. */
  readonly custom: boolean;
  readonly models: readonly { readonly name: string; readonly contextLength?: number }[];
  /** The provider-level context-window default (registry rows only). */
  readonly defaultContextLength?: number;
  /** 模型配置反馈 ① (2026-08-29): the RESOLVED inheritance tail — what an
   *  empty per-model window actually resolves to (defaultContextLength ??
   *  WUDAO_CONTEXT_WINDOW ?? 200000, the same chain resolveContextWindowTokens
   *  walks). Display truth for the edit form's 继承 hint: 「继承供应商默认」
   *  alone hid the number, and for un-overlaid builtins the number isn't a
   *  provider default at all but the global env tail. */
  readonly windowFallback?: number;
  /** T4b: the effective profile's reasoning format (the registry custom's
   *  registered one — customs materialize "none" when unset — or the
   *  builtin's compiled one; absent on invalid stub rows, which carry no
   *  profile). Display semantics for builtins; for customs the round-trip
   *  half — the web edit form's FULL save payload echoes it back (the
   *  server's custom save replaces the row wholesale). */
  readonly reasoningFormat?: string;
  /** 0.3.13 (#215): the protocol the row speaks (EffectiveProfile.wire —
   *  compiled-in for builtins, the registry column for customs). Absent =
   *  the dispatch default (openai-chat). The detail panel's 协议 row reads
   *  it: builtins show it FIXED (the profile owns it), customs seed their
   *  editable selector from it; both save payloads echo it back (the save
   *  REPLACES the registry row wholesale — an unechoed wire would die). */
  readonly wire?: string;
  /** Provider management §3 (fail-visible): the registry entry REFUSED to
   *  load (present only on invalid rows — the UI grays the row and badges
   *  the reason; it never becomes selectable). */
  readonly invalidReason?: string;
  /** SDD 2026-08-23 persona Task 5/T7 — the card's THREE-STATE persona
   *  binding (the registry row's `persona` column, the same rule
   *  readProviderPersonaBinding reads): ABSENT = follow the global default;
   *  a string = bound persona id; null = forced none. The edit form's FULL
   *  save payload echoes it back (the save REPLACES the registry row
   *  wholesale — an unechoed binding would be destroyed). */
  readonly persona?: string | null;
  /** 推理档三级配置 S2 (spec 2026-08-28 §1) — the card's THREE-STATE effort
   *  binding (the registry row's `effort` column, the same rule
   *  readProviderEffortBinding reads): ABSENT = follow the global default
   *  (settings model.defaultEffort); a string = bound level (a
   *  REASONING_EFFORTS member — "none" included, it is a wire value); null =
   *  explicit don't-send (the global never applies). The detail card's
   *  three-way selector seeds from it, and its FULL save payload echoes it
   *  back (the same wholesale-replace rule as persona/wire/headers). */
  readonly effort?: string | null;
}

/** The env-selected provider (same rule resolveProviderConfig applies).
 *  Provider management: any id in the effective view — a registry custom can
 *  be the env-selected provider exactly like a builtin. */
export function envSelectedProvider(env: NodeJS.ProcessEnv): string {
  const raw = (env.WUDAO_PROVIDER ?? "").trim();
  return raw !== "" && loadEffectiveProfiles().has(raw) ? raw : "deepseek";
}

/** Build the full card matrix over the effective view (builtins in matrix
 *  order, then registry customs), plus one GRAYED row per registry entry that
 *  refused to load (fail-visible — never silently dropped). Pure (env + the
 *  credentials map in). */
export function buildProviderMatrix(
  env: NodeJS.ProcessEnv,
  credentials: Readonly<Record<string, string>>,
): readonly ProviderCardStatus[] {
  const envPool = parseApiKeyPool(env);
  const selected = envSelectedProvider(env);
  const overrideBase = env.WUDAO_BASE_URL ?? env.OPENAI_BASE_URL;
  // SDD 2026-08-23 persona Task 5: the binding column rides the RAW registry
  // row (deliberately NOT part of EffectiveProfile — it is binding-chain
  // data). Explicit path ⇒ fresh disk read (readProviderPersonaBinding's
  // freshness rule): the matrix is the edit form's echo source, so a
  // hand-edited card between saves must surface here, not from a memo.
  // 推理档三级配置 S2: the effort binding column rides the same rows.
  const registryByProvider = loadProviderRegistry(defaultProviderRegistryPath(env)).entries;
  const cards: ProviderCardStatus[] = [...loadEffectiveProfiles().entries()].map(([provider, profile]) => {
    const endpoint = (provider === selected && overrideBase !== undefined ? overrideBase : undefined)
      ?? profile.defaultBaseUrl
      ?? null;
    const keySource: ProviderCardStatus["keySource"] =
      provider === selected && envPool.length > 0
        ? "env"
        : (credentials[provider] ?? "").trim() !== ""
          ? "credentials"
          : null;
    const status: ProviderCardStatus["status"] =
      keySource === null ? "missing-key" : endpoint === null ? "missing-endpoint" : "ready";
    // T5/T7: the binding column — emitted ONLY when the registry row carries
    // the key (undefined = key-absent = follow the global default; null is a
    // VALUE and must ride as null, never collapse to absent).
    const personaBinding = registryByProvider.get(provider)?.persona;
    // 推理档三级配置 S2: the effort column — the same three-state rule.
    const effortBinding = registryByProvider.get(provider)?.effort;
    // 0.3.28 ②: the RAW overlay's baseUrl (undefined = no overlay — the
    // builtin runs its compiled default; the effective `baseUrl` field above
    // stays the MERGED view for display).
    const registeredBaseUrl = registryByProvider.get(provider)?.baseUrl;
    return {
      provider,
      label: profile.label,
      status,
      keySource,
      endpoint,
      defaultModel: profile.defaultModel,
      ...(profile.defaultBaseUrl !== undefined ? { baseUrl: profile.defaultBaseUrl } : {}),
      ...(registeredBaseUrl !== undefined ? { registeredBaseUrl } : {}),
      custom: profile.custom,
      models: profile.models,
      ...(profile.defaultContextLength !== undefined ? { defaultContextLength: profile.defaultContextLength } : {}),
      // ① (2026-08-29): the resolved tail the edit form shows as the
      // inherited window — the provider default when set, else the env
      // global (the SAME expression index.ts/repl.ts feed
      // resolveContextWindowTokens, so the hint can never disagree with
      // what the runtime would actually use).
      windowFallback: profile.defaultContextLength ?? (Number(env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000),
      // T4b: map the effective profile's reasoning format onto the card (the
      // type is optional; every builtin and materialized custom carries one).
      ...(profile.reasoningFormat !== undefined ? { reasoningFormat: profile.reasoningFormat } : {}),
      // 0.3.13 (#215): the protocol column rides the card the same way.
      ...(profile.wire !== undefined ? { wire: profile.wire } : {}),
      ...(personaBinding !== undefined ? { persona: personaBinding } : {}),
      ...(effortBinding !== undefined ? { effort: effortBinding } : {}),
    };
  });
  for (const row of loadProviderRegistry().invalid) {
    cards.push({
      provider: row.id,
      label: row.id,
      status: "missing-key" as const,
      keySource: null,
      endpoint: null,
      defaultModel: "",
      custom: true,
      models: [],
      invalidReason: row.reason,
    });
  }
  return cards;
}

/** The settingsStatus payload (PROTOCOL "settingsStatus"). Count-only
 *  credentials; settings values for the page's toggles; the env-resolved
 *  identity for the default-model/effort pickers. */
export interface SettingsStatusPayload {
  readonly providers: readonly ProviderCardStatus[];
  readonly credentials: { readonly path: string; readonly keyCount: number };
  readonly settings: {
    readonly memoryEnabled: boolean;
    /** M63 §D: ui.defaultMode is a TRI-STATE on the wire — null = the key was
     *  never written (no wizard completed, no explicit pick). The web app
     *  treats null as "advanced" so existing users never flip to 简洁模式
     *  without having chosen it; the settings page highlights the same
     *  effective value. M78-buddy §4: "buddy" (the two-panel
     *  会话列表+对话 shell) joins the enumerated values. */
    readonly uiDefaultMode: "simple" | "buddy" | "advanced" | null;
    /** M64-visual §4: the theme channel — the SAME tri-state shape as
     *  uiDefaultMode. null = never written → the web app resolves dark (the
     *  factory default); an explicit "light"/"dark" rides the ◐ topbar toggle
     *  and the settings page's 外观 picker. */
    readonly uiTheme: "light" | "dark" | null;
    /** M64-visual §4: the accent channel (black/blue/green), tri-state like
     *  uiTheme. null = never written → the web app resolves green (the
     *  factory default; spec §1 绿为出厂默认). */
    readonly uiAccent: "black" | "blue" | "green" | null;
    /** M63 §C: the wizard copy version already completed (or skipped) —
     *  0 = never. A copy bump re-shows the wizard (DSH welcome-notice
     *  versioning); the readiness join beats it (a ready provider never
     *  sees the wizard at all). */
    readonly wizardCompletedVersion: number;
    /** SDD 2026-08-23 persona Task 5: the global default persona id (the
     *  persona tab's picker's current value — the LAST leg of the chain
     *  env > binding > default > none). null = never written / cleared. */
    readonly personaId: string | null;
    /** 0.3.11（用户反馈：权限档两入口 1:1 联动）：持久默认权限档（全局
     *  settings.json permissions.defaultMode，向导⑤/设置页写；新会话起步
     *  档，CLI 旗标更高）。null = never written → 起步 "workspace"。
     *  与实时档（status.mode）语义分开——设置页据此绑「默认」，不再镜像
     *  实时档。0.3.14 四档值：workspace（默认）/ask/auto/plan；旧持久值由
     *  readGlobalDefaultPermissionMode 读取时迁移。 */
    readonly permissionsDefaultMode: "workspace" | "ask" | "auto" | "plan" | null;
    /** 推理档三级配置 + 语言 chip S3 (spec 2026-08-28 §2): the RESOLVED
     *  language knobs (ablation > settings > env > auto — the boot fold, no
     *  session lane here: this is what the NEXT session would start at; the
     *  live session value rides gateStatus.language in S4). The web
     *  LanguageSelector marks this as the default row. */
    readonly languageReply: "auto" | "on" | "off";
    readonly languageReasoning: "auto" | "zh" | "en" | "off";
    /** ω99-236: the doc trio's RESOLVED mount gate (docSuite.enabled through
     *  the SAME layered read the boot folds — what the NEXT session starts
     *  at; default true, the web 插件 tab「内置」段's toggle initial value).
     *  Optional on the wire so older fixtures stay shape-compatible. */
    readonly docSuiteEnabled?: boolean;
    /** ω99-287（续，标记见上）: the desktop's 关窗后台 bit (L2 A 案,
     * desktop.backgroundOnClose through the same layered read). Default
     * false (Q1) — an absent/corrupt node never flips the close fork.
     * Optional on the wire so older fixtures stay shape-compatible. */
    readonly desktopBackgroundOnClose?: boolean;
    /** 122 项 2: the offline-wake opt-in (schedules.launchAgent through the
     * same layered fold; junk reads false = off). The 偏好 tab's toggle
     * initial value (desktop shell + macOS only). Optional on the wire so
     * older fixtures stay shape-compatible. */
    readonly schedulesLaunchAgent?: boolean;
    /** 122 项 2: the platform gate — LaunchAgents are macOS-only; false
     * hides the toggle instead of promising a wake the OS cannot deliver. */
    readonly schedulesLaunchAgentSupported?: boolean;
  };
  readonly current: {
    readonly provider: ProviderName;
    readonly model: string;
    readonly effort: string | undefined;
  };
  /** 推理档三级配置 + 语言 chip S4 (spec 2026-08-28 §4): the SESSION-
   *  effective language pair (the live /language lane — the same fold the
   *  next submit's transient blocks use), overlaid by withSettingsOps onto
   *  the stored-tier payload. settings.languageReply/Reasoning above stay
   *  the boot fold (what the NEXT session starts at); the web's
   *  gateStatus.language reads THIS field. */
  readonly language?: { readonly reply: "auto" | "on" | "off"; readonly reasoning: "auto" | "zh" | "en" | "off" };
  /** True when the env key pool is set — the page renders the env-wins note. */
  readonly envKey: boolean;
  /** M63 §C: the readiness join over the card matrix — any provider ready
   *  (key resolvable AND endpoint known) = ready. The first-run wizard's
   *  gate: ready → the wizard is skipped whole (research 35 #5). */
  readonly readiness: boolean;
  /** The switchable efforts (mirrors REASONING_EFFORTS; the page's picker). */
  readonly efforts: readonly string[];
  /** R6 quickwin: the Ctrl+S-persisted pick defaults (null = never written)
   *  — the settings page badges them; the boot applies them (run.ts). */
  readonly defaultModel: { readonly provider: ProviderName; readonly model: string } | null;
  readonly defaultEffort: string | null;
}

/** M63 §C — the readiness join: ANY ready provider makes the whole surface
 *  ready. Pure over the card matrix so the server payload, the web gate, and
 *  the tests share one rule (spec §C: 任一可用即整页跳过). */
export function settingsReadiness(cards: readonly ProviderCardStatus[]): boolean {
  return cards.some((c) => c.status === "ready");
}

/** SDD 2026-08-23 persona Task 4 — the GLOBAL default persona read (the
 *  settings.json `persona.id` node, the LAST leg of the chain env > binding >
 *  default > none, spec §1/§2). Read side only — the settingsSet allowlist
 *  write is Task 5. Tolerant by the uiTheme rule: an absent file/node, a
 *  blank id (Task 5's clear writes ""), or a corrupt node all read as
 *  undefined (the leg is simply off), never a throw, never a phantom id.
 *  Registry EXISTENCE is deliberately NOT checked here — resolve-time
 *  fail-closed lives in resolveActivePersona (stale default → warning +
 *  falls through), so the reader stays a dumb store read. */
export function readGlobalDefaultPersonaId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const node = readGlobalSettingsSync(env)["persona"];
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  const id = (node as Record<string, unknown>)["id"];
  return typeof id === "string" && id.trim() !== "" ? id : undefined;
}

/** SDD 2026-08-23 layer-selection Task 1 — one persona REFERENCE's persona id
 * (a persisted `id[:layers]` string → its bare id; a junk/hand-edited value
 * reads as itself). personaDelete's reference inventory matches BY ID so a
 * `alpha:headers` binding/default is still seen when `alpha` is deleted. */
export function personaReferenceId(raw: string): string {
  const parsed = parsePersonaSpec(raw);
  return parsed.ok ? parsed.id : raw;
}

// R6 quickwin (pi model-selector pattern) — the Ctrl+S-persisted pick
// defaults. The web pickers apply a pick session-scoped (Enter/click rides
// /model or /effort — next turn only); Ctrl/Cmd+S ALSO writes it here, and
// the `wudao ui` boot applies it when no explicit flag/env pins the field
// (run.ts's StoredModelDefaults — the read side that keeps「设为默认」
// honest). Global-tier personal preference, one `model` node.
/** The stored pick defaults, read from an effective settings record. Pure,
 *  null-safe: a missing/corrupt node reads as absence (the uiTheme rule). */
export interface StoredModelDefaults {
  /** {provider, model} — the boot applies it only when the stored provider
   *  matches the boot provider (a cross-provider row's default waits for
   *  that provider to be the selected one). */
  readonly model?: { readonly provider: ProviderName; readonly model: string };
  /** A matrix reasoning-effort level. */
  readonly effort?: ReasoningEffort;
}

/** Extract + validate the `model` node's pick defaults from a layered
 *  effective record. Corrupt values read as absent, never throw. Task 5: the
 *  provider gate widens to the registry's effective view (the same widening
 *  the settingsSet writer got) — a pick saved against a registry custom
 *  reads back instead of vanishing; `profiles` defaults to the process memo
 *  (the provider-registry.ts `args.profiles ?? loadEffectiveProfiles()`
 *  pattern) and stays overridable for tests. */
export function readStoredModelDefaults(
  effective: Readonly<Record<string, unknown>>,
  profiles: ReadonlyMap<string, EffectiveProfile> = loadEffectiveProfiles(),
): StoredModelDefaults {
  const node = effective["model"];
  if (typeof node !== "object" || node === null || Array.isArray(node)) return {};
  const record = node as Record<string, unknown>;
  const out: { model?: { provider: ProviderName; model: string }; effort?: ReasoningEffort } = {};
  const dm = record["defaultModel"];
  if (typeof dm === "object" && dm !== null && !Array.isArray(dm)) {
    const provider = (dm as Record<string, unknown>)["provider"];
    const model = (dm as Record<string, unknown>)["model"];
    if (
      typeof provider === "string" && (isProviderName(provider) || profiles.has(provider)) &&
      typeof model === "string" && model.trim() !== ""
    ) {
      out.model = { provider, model };
    }
  }
  const effort = record["defaultEffort"];
  if (typeof effort === "string") {
    const idx = (REASONING_EFFORTS as readonly string[]).indexOf(effort);
    if (idx >= 0) out.effort = REASONING_EFFORTS[idx];
  }
  return out;
}

// The three human failure states (spec §B/§C wording families) + the two
// precondition states and the generic HTTP bucket.
export type TestConnectionState =
  | "ok"
  | "auth" // 401/403 → Key 无效或无余额
  | "network" // timeout / refused / DNS → 网络不通
  | "model" // 404 or a model-not-found body → 模型名不存在
  | "no-key"
  | "no-endpoint"
  | "http"; // anything else

export interface TestConnectionResult {
  readonly ok: boolean;
  readonly state: TestConnectionState;
  readonly message: string;
}

export const TEST_MESSAGES: Readonly<Record<TestConnectionState, string>> = {
  ok: "连接成功",
  auth: "Key 无效或无余额——检查是否复制完整、账户是否有余额",
  network: "网络不通——检查网络或稍后再试",
  model: "模型名不存在——试试推荐模型",
  "no-key": "请先保存或粘贴 Key 再测试",
  "no-endpoint": "请先设置端点地址(WUDAO_BASE_URL)",
  http: "服务返回异常",
};

// 拆分运动（弧 δ 顺带件）：classifyTestResponse 纯分类器外提至
// test-response.ts（逐字节搬家；本行 re-export 维持既有公共面）。
export { classifyTestResponse } from "./test-response.js";
import { classifyTestResponse } from "./test-response.js";

// SDD 2026-08-23 persona Task 5 — the persona ops' reply shapes (mirrored by
// packages/web/src/protocol.ts; same mirror discipline as the plugin rows).
/** One personaList row: the three-tier source + the display layers label +
 *  the edit gate (ONLY global personas are editable — builtin fingerprints
 *  are pinned data, workspace files belong to the repo). */
export interface PersonaSummaryRow {
  readonly id: string;
  readonly displayName: string;
  readonly source: "builtin" | "global" | "workspace";
  /** The layer names the definition CARRIES content for, "+"-joined in
   *  headers/body/prompt order (content-based, not defaultLayers — the
   *  label answers "what does this persona do", not "what would apply"). */
  readonly layers: string;
  readonly editable: boolean;
}

export type PersonaSaveOutcome = { readonly ok: true } | { readonly ok: false; readonly errors: readonly string[] };

export type PersonaDeleteOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly references: { readonly providers: readonly string[]; readonly isGlobalDefault: boolean } };

export interface SettingsOpsDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly workspaceRoot: string;
  /** Fetch seam (tests inject a fake; default the global fetch). */
  readonly fetchImpl?: typeof fetch;
  /** Test-connection budget (default 10s). */
  readonly testTimeoutMs?: number;
  /** cc-plugins C1: the busy probe for the two directory-deleting plugin ops
   *  (uninstall, marketplace remove — a run's hooks may be executing from
   *  those dirs). Default: never busy (the headless op surface has no runs;
   *  withSettingsOps wires the live driver's probe). */
  readonly isBusy?: () => boolean;
  /** cc-plugins C1: the post-mutation hot-rescan seam (the B1 law: every op
   *  that changes what discovery maps rescans; add/update/list do not).
   *  Injectable so tests never read the process's real global home. */
  readonly rescan?: () => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }>;
}

export interface SettingsOps {
  settingsStatus(): Promise<SettingsStatusPayload>;
  settingsSaveKey(provider: string, key: string): Promise<{ readonly provider: string; readonly saved: boolean; readonly keyCount: number }>;
  settingsTestConnection(provider: string, opts?: { readonly key?: string; readonly model?: string }): Promise<TestConnectionResult>;
  settingsSet(key: string, value: unknown): Promise<{ readonly key: string; readonly saved: boolean }>;
  /** M75-ux1 §2: the workspace switcher's recents — read the list, or (with
   *  `add`) unshift + persist + read. No separate write op exists: the switch
   *  click adds through this same handler. */
  recentWorkspaces(add?: string): Promise<RecentWorkspacesPayload>;
  /** M77-workspace §1: same-window directory switch — starts a new UI session
   *  for the target directory and returns its URL. */
  switchWorkspace(path: string): Promise<{ readonly url: string }>;
  // cc-plugins C1 — the plugin-management ops (PROTOCOL "pluginList" …
  // "pluginDisable") over the A1/A2 marketplace engine. Engine failures
  // (typed MarketplaceError) reject as-is — the message is the contract the
  // three faces share.
  /** The install registry + enable state (the settings page's 已装 list).
   *  Registry-only: the session's `--plugin` adhoc mounts are process-local
   *  and deliberately not surfaced here. */
  pluginList(): Promise<{ readonly installed: readonly InstalledPluginRow[] }>;
  /** Every registered market plus its discover entries (the manifest rows
   *  with install-preview counts for local-dir sources). */
  pluginMarketList(): Promise<{ readonly marketplaces: readonly MarketplaceWithPlugins[] }>;
  /** Add a market (source grammar: owner/repo · git URL#ref · 本地目录 ·
   *  marketplace.json 路径). Never rescans (no discovery input moves). */
  pluginMarketAdd(source: string, name?: string): Promise<MarketplaceInfo>;
  /** Re-pull / re-copy one registered market. Never rescans. */
  pluginMarketUpdate(name: string): Promise<MarketplaceInfo>;
  /** Unregister + delete a market, cascading the uninstall of the plugins it
   *  installed. Busy (a run in flight) → refuses before any engine call. */
  pluginMarketRemove(name: string): Promise<{ readonly removedPlugins: readonly string[]; readonly warnings: readonly string[]; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  /** Install a market's plugin into a scope root; the reply carries the
   *  loader dry-run's InstallDetail (the 将安装 preview counts). */
  pluginInstall(name: string, market: string, scope: "user" | "project"): Promise<{ readonly dir: string; readonly detail: InstallDetail; readonly warnings: readonly string[]; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  /** 引导安装（guided-install 弧）：spec 三形态（本地路径 / GitHub 简写 / git
   *  URL）→ 浅克隆 → inspect → 零资产门 → 拷装；preview 只 inspect 不装。 */
  /** 长期记忆（M-Memory 新库 .wudao/memory/）：跨会话记忆条目列表。 */
  longtermMemoryList(): Promise<{ readonly entries: readonly { readonly id: string; readonly kind: string; readonly text: string; readonly tags: readonly string[]; readonly createdAt: string; readonly useCount: number }[] }>;
  /** 长期记忆：tombstone 删除（append-only 法律）。 */
  longtermMemoryForget(id: string): Promise<void>;
  pluginInstallSpec(spec: string, preview?: boolean): Promise<{ readonly preview: boolean; readonly name?: string; readonly dir?: string; readonly format?: string; readonly detail: { readonly skills: number; readonly commands: number; readonly agents: number; readonly hooks: number; readonly mcp: number }; readonly warnings: readonly string[]; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  /** Delete the install dir + registry record + enable key. Busy → refuses
   *  before any engine call (the /clear-family notice). */
  pluginUninstall(id: string): Promise<{ readonly id: string; readonly warnings: readonly string[]; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  /** Re-enable a disabled plugin (deletes the enabledPlugins key). */
  pluginEnable(id: string): Promise<{ readonly id: string; readonly enabled: true; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  /** Hide a plugin from discovery's mapping (registry record kept). */
  pluginDisable(id: string): Promise<{ readonly id: string; readonly enabled: false; readonly rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number } }>;
  // SDD 2026-08-23 persona Task 5 — the persona-management ops behind the web
  // settings page's persona tab (PROTOCOL "personaList" … "personaDelete").
  // Reads reject on an unknown id; personaSave refuses with the validator's
  // per-field error list (id collisions with builtin/workspace personas
  // included); personaDelete reports the referencing providers when the
  // persona is still bound — the second call with unbind:true clears the
  // bindings (cards back to key-absent + the global default cleared) and
  // lands.
  /** Every registered persona (builtin + global + workspace) with its tier
   *  source and edit gate. */
  personaList(): Promise<{ readonly personas: readonly PersonaSummaryRow[] }>;
  /** One persona's full definition (unknown id rejects). */
  personaGet(id: string): Promise<{ readonly definition: PersonaDefinition }>;
  /** Create/update one GLOBAL persona (~/.wudao/personas/<id>.json). */
  personaSave(definition: unknown): Promise<PersonaSaveOutcome>;
  /** Delete one global persona; the reference inventory when it is bound. */
  personaDelete(id: string, unbind?: boolean): Promise<PersonaDeleteOutcome>;
  // MCP visibility (2026-08-31 用户反馈「配置之后，根本不知道自己有什么
  // mcp」) — the settings page's MCP tab: every configured server across the
  // three tiers, with runtime status when the live bridge has one. Read-only;
  // secrets NEVER ride the wire (env/headers stay in the config files).
  /** All configured MCP servers (user + root .mcp.json + project tiers),
   *  effective-entry rows with tier source + replacement receipts. */
  mcpList(): Promise<McpListPayload>;
}

/** One mcpList row: the EFFECTIVE entry for a server name (which tier won
 *  the replacement chain). `command` is process-list-visible data only —
 *  stdio: command + args joined; http: the REDACTED url. env map and http
 *  headers NEVER appear here (they carry keys). */
export interface McpListServerRow {
  readonly name: string;
  readonly tier: "user" | "root" | "project";
  readonly transport: "stdio" | "http";
  readonly command: string;
  /** The earlier same-name tiers this entry replaced ([] when none). */
  readonly replaces: readonly ("user" | "root")[];
  /** Runtime lane (the live bridge's snapshot; false/0 = this session has
   *  not connected it — 延迟装载 included). */
  readonly connected: boolean;
  readonly tools: number;
  readonly failure?: string;
}

/** mcpList's reply. */
export interface McpListPayload {
  readonly servers: readonly McpListServerRow[];
  /** Per-tier load warnings (a malformed file names the tier — visible, not
   *  swallowed). */
  readonly warnings: readonly string[];
  /** The three config file paths (absolute; the settings page's hints). */
  readonly files: { readonly user: string; readonly root: string; readonly project: string };
}

/** The personaList `layers` label — pure. A layer counts when the definition
 *  CARRIES content for it (headers: any protocol map with ≥1 key; body: any
 *  overlay with ≥1 key; prompt: a system block or a toolNameMap). A persona
 *  carrying nothing (schema-legal: `headers:{}`) labels "none". */
export function personaLayersLabel(def: PersonaDefinition): string {
  const parts: string[] = [];
  const hasEntries = (m: unknown): boolean =>
    typeof m === "object" && m !== null && Object.keys(m).length > 0;
  if (Object.values(def.headers).some(hasEntries)) parts.push("headers");
  if (def.body !== undefined && Object.values(def.body).some(hasEntries)) parts.push("body");
  if (def.prompt !== undefined && (def.prompt.system !== undefined || hasEntries(def.prompt.toolNameMap))) parts.push("prompt");
  return parts.length > 0 ? parts.join("+") : "none";
}

// cc-plugins C1 — the pluginMarketList reply shapes (mirrored by
// packages/web/src/protocol.ts).
/** One discover entry: the market manifest's row plus the install-preview
 *  counts when the source resolves to a local directory (`null` for
 *  git-location sources — inspectable only by cloning). */
export interface MarketplacePluginEntryInfo {
  readonly name: string;
  readonly description?: string;
  readonly version?: string;
  readonly detail: InstallDetail | null;
}

/** One pluginMarketList row: the registry's market info plus its discover
 *  entries. A registered market whose materialization cannot be read (hand
 *  deleted / corrupt manifest) lists with `plugins: []` — the registry row
 *  is the truth and pluginMarketUpdate is the repair path. */
export interface MarketplaceWithPlugins extends MarketplaceInfo {
  readonly plugins: readonly MarketplacePluginEntryInfo[];
}

// cc-plugins C1 — the busy law (B1): the two ops that DELETE plugin
// directories a run's hooks may be executing from refuse while a run is in
// flight. The driver's /plugin slash path guards its own lane; the web
// client can call ops ANYTIME, so the op layer enforces the same
// 「⚠️ 运行中无法 …（任务进行中）」 family here — the refusal lands before
// any engine call, so nothing is touched.
const BUSY_PLUGIN_UNINSTALL = "⚠️ 运行中无法卸载插件（任务进行中）";
const BUSY_MARKET_REMOVE = "⚠️ 运行中无法移除市场（任务进行中）";

// M75-ux1 §2 — the recent-workspaces store (PROTOCOL "recentWorkspaces"). One
// WUDAO_GLOBAL_HOME-aware file (`<home>/recent-workspaces.json`, format
// `[{path, lastUsed}]`, JSON has no Date so lastUsed is an ISO string), max 5
// entries, most-recent-first.
/** One recent-workspace row. */
export interface RecentWorkspace {
  readonly path: string;
  readonly lastUsed: string;
}

/** The recentWorkspaces payload (PROTOCOL "recentWorkspaces"). */
export interface RecentWorkspacesPayload {
  readonly workspaces: readonly RecentWorkspace[];
}

/** Where the recents live (`<global home>/recent-workspaces.json`). */
export function recentWorkspacesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "recent-workspaces.json");
}

/** Keep only well-formed rows: an object with a non-blank string `path`
 *  (lastUsed coerces to "" when missing). A corrupt or foreign-shaped file
 *  degrades to [], never throws. */
function sanitizeRecentWorkspaces(raw: unknown): RecentWorkspace[] {
  if (!Array.isArray(raw)) return [];
  const out: RecentWorkspace[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const path = (item as Record<string, unknown>)["path"];
    const lastUsed = (item as Record<string, unknown>)["lastUsed"];
    if (typeof path !== "string" || path.trim() === "") continue;
    out.push({ path, lastUsed: typeof lastUsed === "string" ? lastUsed : "" });
  }
  return out;
}

/** The write-side discipline in one pure pass: drop blank paths, dedupe by
 *  path (first wins — the list is most-recent-first), cap at 5. */
export function trimRecentWorkspaces(rows: readonly RecentWorkspace[]): RecentWorkspace[] {
  const seen = new Set<string>();
  const out: RecentWorkspace[] = [];
  for (const row of rows) {
    const path = row.path.trim();
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    out.push({ ...row, path });
    if (out.length === 5) break;
  }
  return out;
}

/** workspace-ux B1: record one workspace pick into the recents file — the
 *  read-unshift-trim-persist pass `recentWorkspaces(add)` runs, split out so
 *  the driver's panelRootSet writes through the SAME discipline (one policy:
 *  the file's shape, cap, and atomic tmp+rename write live here, never at a
 *  second site). Returns the persisted rows. */
export async function recordRecentWorkspace(path: string, env: NodeJS.ProcessEnv = process.env): Promise<RecentWorkspace[]> {
  const file = recentWorkspacesPath(env);
  let rows: RecentWorkspace[] = [];
  try {
    rows = sanitizeRecentWorkspaces(JSON.parse(await readFile(file, "utf8")));
  } catch {
    // ENOENT or a corrupt file — an empty list, never an error.
  }
  rows = trimRecentWorkspaces([{ path, lastUsed: new Date().toISOString() }, ...rows]);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(rows, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
  return rows;
}

export function createSettingsOps(deps: SettingsOpsDeps): SettingsOps {
  const env = () => deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.testTimeoutMs ?? 10_000;
  const busy = () => deps.isBusy?.() === true;

  const bad = (state: TestConnectionState): TestConnectionResult => ({ ok: false, state, message: TEST_MESSAGES[state] });

  // SDD 2026-08-23 persona Task 5 — the three-tier registry reads the persona
  // ops share. Same dir resolution the REPL boot uses (repl.ts:
  // join(resolveGlobalHome(), "personas") / <ws>/.wudao/personas) — one rule,
  // two sites, no drift.
  const globalPersonaDir = (): string => join(resolveGlobalHome(env()), "personas");
  const workspacePersonaDir = (): string => join(deps.workspaceRoot, ".wudao", "personas");
  const personaRegistry = () =>
    loadPersonaRegistry({ globalDir: globalPersonaDir(), workspaceDir: workspacePersonaDir() });

  // cc-plugins C1 — the plugin-engine deps factory: one PER CALL (the web
  // client may fire ops concurrently — a shared collector would interleave
  // two ops' warnings), with engine warnings collected into the reply
  // instead of stderr (the web caller must SEE them) and the workspace a
  // project-scope install acts on.
  const engDeps = (): { deps: { env: NodeJS.ProcessEnv; workspaceRoot: string; warn: (m: string) => void }; warns: () => readonly string[] } => {
    const lines: string[] = [];
    return {
      deps: { env: env(), workspaceRoot: deps.workspaceRoot, warn: (m: string) => lines.push(m) },
      warns: () => lines,
    };
  };
  /** The install-class ops' rescan receipt (the B1 law: every op that
   *  changes what discovery maps rescans). Counts on success; a ⚠️ warning
   *  on failure — the op already succeeded, so an isolated rescan failure
   *  must not look like a failed op. */
  const rescanReceipt = async (): Promise<{ rescan?: { readonly skills: number; readonly plugins: number; readonly hooks: number }; warning?: string }> => {
    try {
      return { rescan: await (deps.rescan ?? rescanExtensions)() };
    } catch (err) {
      return { warning: `⚠️ 热重扫失败：${err instanceof Error ? err.message : String(err)}（操作已生效；重启后完全一致）` };
    }
  };

  return {
    async settingsStatus(): Promise<SettingsStatusPayload> {
      const e = env();
      const credentials = await readCredentialsFile(e);
      const file = await credentialsFileStatus(e);
      // memoryEnabled resolves through the SAME layered reader the session
      // uses (project tiers can still win — the toggle writes the global
      // default; the receipt says "next session").
      const layered = await loadLayeredSettings(deps.workspaceRoot, () => {}, e);
      const memory = resolveMemorySettings(deps.workspaceRoot, layered.effective);
      const ui = layered.effective["ui"];
      const rawMode = typeof ui === "object" && ui !== null && !Array.isArray(ui)
        ? (ui as Record<string, unknown>)["defaultMode"]
        : undefined;
      // M78-buddy §4: "buddy" reads through the same layered ui node — a
      // corrupted/unknown stored value reads as absent (null), exactly the
      // simple/advanced rule.
      const uiMode = rawMode === "advanced"
        ? "advanced"
        : rawMode === "simple"
          ? "simple"
          : rawMode === "buddy"
            ? "buddy"
            : null;
      // M64-visual §4: theme/accent resolve through the same layered ui node,
      // validated at the reader (a corrupted stored value reads as absent —
      // exactly the uiDefaultMode rule).
      const uiRecord = typeof ui === "object" && ui !== null && !Array.isArray(ui)
        ? (ui as Record<string, unknown>)
        : {};
      const rawTheme = uiRecord["theme"];
      const uiTheme = rawTheme === "light" || rawTheme === "dark" ? rawTheme : null;
      const rawAccent = uiRecord["accent"];
      const uiAccent = rawAccent === "black" || rawAccent === "blue" || rawAccent === "green" ? rawAccent : null;
      // M63 §C: the wizard's version marker rides the same layered read (the
      // settingsSet writer targets the GLOBAL tier; a project tier could
      // still pin it — effective wins, same as uiDefaultMode).
      const wizard = layered.effective["wizard"];
      const wizardVersionRaw = typeof wizard === "object" && wizard !== null && !Array.isArray(wizard)
        ? (wizard as Record<string, unknown>)["completedVersion"]
        : undefined;
      const wizardCompletedVersion = typeof wizardVersionRaw === "number" && Number.isFinite(wizardVersionRaw) && wizardVersionRaw >= 0
        ? wizardVersionRaw
        : 0;
      const selected = envSelectedProvider(e);
      // 推理档三级配置 + 语言 chip S3: the resolved language knobs — the same
      // fold the boot will apply (settings node > env > auto; ablation kills
      // all). Reader-side tolerant: a corrupt node reads as absent.
      const languageNode = layered.effective["language"];
      const language = resolveLanguagePreference(
        e,
        typeof languageNode === "object" && languageNode !== null && !Array.isArray(languageNode)
          ? (languageNode as { reply?: unknown; reasoning?: unknown })
          : undefined,
      );
      // R-M4 (T2 review M4): a modelless custom being the selected provider
      // must not surface a bare "" — the placeholder names the state for the
      // settings page (the invalid/modelless badges carry the fix story);
      // builtins always resolve a non-empty default, so only customs land here.
      const model = e.WUDAO_MODEL?.trim() || e.OPENAI_MODEL?.trim() || loadEffectiveProfiles().get(selected)?.defaultModel || "（未设置）";
      const effortRaw = e.WUDAO_REASONING_EFFORT?.trim();
      const providers = buildProviderMatrix(e, credentials);
      const stored = readStoredModelDefaults(layered.effective);
      return {
        providers,
        credentials: { path: file.path, keyCount: file.keyCount },
        settings: {
          memoryEnabled: memory.enabled,
          uiDefaultMode: uiMode,
          wizardCompletedVersion,
          uiTheme,
          uiAccent,
          personaId: readGlobalDefaultPersonaId(e) ?? null,
          // 0.3.11: GLOBAL-tier read only — mirrors the ui boot's read (the
          // engine ignores a project tier's permissions node entirely; the
          // selector must show what the NEXT session will actually start at).
          permissionsDefaultMode: readGlobalDefaultPermissionMode(readGlobalSettingsSync(e)) ?? null,
          languageReply: language.reply,
          languageReasoning: language.reasoning,
          // ω99-236: the doc trio's gate — the same layered fold the boot
          // applies (the toggle shows what the NEXT session starts at).
          docSuiteEnabled: resolveDocSuiteEnabled(layered.effective),
          // ω99-287（续，标记见上）: the desktop's 关窗后台 bit — the same
          // layered fold, tolerant like uiTheme (an absent/corrupt node
          // reads false, fail-closed to the old quit-on-close semantics;
          // the web close bridge reads this bit when the red X is clicked).
          desktopBackgroundOnClose:
            layered.effective["desktop"] instanceof Object &&
            !Array.isArray(layered.effective["desktop"]) &&
            (layered.effective["desktop"] as Record<string, unknown>)["backgroundOnClose"] === true,
          // 122 项 2 — the offline-wake opt-in (schedules.launchAgent through
          // the same layered fold; tolerant read, junk → false = off) + the
          // platform gate (LaunchAgents are macOS-only; the toggle hides
          // elsewhere instead of promising a wake the OS cannot deliver).
          schedulesLaunchAgent: schedulesSettingsFromNode(layered.effective["schedules"]).launchAgent,
          schedulesLaunchAgentSupported: process.platform === "darwin",
        },
        current: {
          provider: selected,
          model,
          effort: effortRaw !== "" && effortRaw !== undefined ? effortRaw : undefined,
        },
        envKey: parseApiKeyPool(e).length > 0,
        readiness: settingsReadiness(providers),
        efforts: [...REASONING_EFFORTS],
        defaultModel: stored.model ?? null,
        defaultEffort: stored.effort ?? null,
      };
    },

    async settingsSaveKey(provider, key) {
      const id = provider.trim();
      // Provider management: builtin ∪ registry ids may hold a key (the
      // credentials file already accepts any ID_RE id — this was the only
      // gate keeping customs out).
      if (!loadEffectiveProfiles().has(id)) {
        throw new Error(`unknown provider "${id}" (the matrix: ${[...loadEffectiveProfiles().keys()].join(", ")})`);
      }
      const saved = await saveProviderKey(id, key, env());
      // Status only — the key never rides back (server strips stray fields too).
      return { provider: id, saved: true, keyCount: saved.keyCount };
    },

    async settingsTestConnection(provider, opts) {
      const e = env();
      const id = provider.trim();
      // Provider management: same widened gate — a registry custom tests
      // against its registry endpoint. The 64_000 probe window elsewhere in
      // this op is deliberately untouched (a probe is window-independent).
      const profile = loadEffectiveProfiles().get(id);
      if (profile === undefined) {
        throw new Error(`unknown provider "${id}" (the matrix: ${[...loadEffectiveProfiles().keys()].join(", ")})`);
      }
      const selected = envSelectedProvider(e);
      // Key resolution: pasted key → env pool (when testing the selected
      // provider — that is whose key the env carries) → the credentials file.
      const pasted = opts?.key?.trim() ?? "";
      const envPool = parseApiKeyPool(e);
      const fileKey = (await readCredentialsFile(e))[id]?.trim() ?? "";
      const key = pasted !== ""
        ? pasted
        : id === selected && envPool.length > 0
          ? (envPool[0] ?? "")
          : fileKey;
      if (key === "") return bad("no-key");
      const endpoint = (id === selected ? (e.WUDAO_BASE_URL ?? e.OPENAI_BASE_URL) : undefined)
        ?? profile.defaultBaseUrl
        ?? null;
      if (endpoint === null) return bad("no-endpoint");
      const model = opts?.model?.trim() || (id === selected ? (e.WUDAO_MODEL?.trim() || e.OPENAI_MODEL?.trim()) : "") || profile.defaultModel;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // 0.3.28 ③: wire-aware probe — the same rule settingsListModels
        // applied in 0.3.26 (provider-registry-ops.ts): anthropic-wire
        // providers (glm-code/kimi-code/minimax-code…) speak POST
        // {base}/v1/messages with x-api-key (+ dual Bearer when their
        // bearerAuth pin says so), NOT OpenAI /chat/completions. Probing the
        // openai path against them 404s, which classifyTestResponse reports
        // as a MODEL problem (「模型名不存在」) — exactly the misroute the
        // user hit. OpenAI wire stays byte-identical.
        const anthropicWire = profile.wire === "anthropic";
        const probeUrl = anthropicWire
          ? `${endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`}/messages`
          : `${endpoint}/chat/completions`;
        const headers = anthropicWire
          ? {
              "content-type": "application/json",
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              ...(profile.bearerAuth === true ? { authorization: `Bearer ${key}` } : {}),
            }
          : { "content-type": "application/json", authorization: `Bearer ${key}` };
        const res = await doFetch(probeUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
          signal: controller.signal,
        });
        const body = await res.text().catch(() => "");
        if (res.ok) return { ok: true, state: "ok", message: TEST_MESSAGES.ok };
        const state = classifyTestResponse(res.status, body);
        return { ok: false, state, message: state === "http" ? `${TEST_MESSAGES.http} (HTTP ${res.status})` : TEST_MESSAGES[state] };
      } catch {
        // Abort = our budget; everything else (ECONNREFUSED, ENOTFOUND,
        // fetch failed) is the same novice-facing "cannot reach" state.
        return bad("network");
      } finally {
        clearTimeout(timer);
      }
    },

    async settingsSet(key, value) {
      const e = env();
      const record = await readGlobalSettings(e);
      // M64-visual §4: the ui-node keys MERGE (a theme write never drops the
      // stored defaultMode, and vice versa) — one helper, three callers.
      const mergeUi = (patch: Record<string, unknown>): void => {
        const ui = typeof record["ui"] === "object" && record["ui"] !== null && !Array.isArray(record["ui"])
          ? { ...(record["ui"] as Record<string, unknown>) }
          : {};
        record["ui"] = { ...ui, ...patch };
      };
      // R6 quickwin: the model node merges the same way (a defaultModel write
      // never drops the stored defaultEffort, and vice versa).
      const mergeModel = (patch: Record<string, unknown>): void => {
        const model = typeof record["model"] === "object" && record["model"] !== null && !Array.isArray(record["model"])
          ? { ...(record["model"] as Record<string, unknown>) }
          : {};
        record["model"] = { ...model, ...patch };
      };
      // SDD 2026-08-23 persona Task 5: the persona node merges like ui/model
      // (only `id` lives there today; the merge keeps future keys safe).
      const personaNode = (): Record<string, unknown> =>
        typeof record["persona"] === "object" && record["persona"] !== null && !Array.isArray(record["persona"])
          ? { ...(record["persona"] as Record<string, unknown>) }
          : {};
      // 推理档三级配置 + 语言 chip S3 (spec 2026-08-28 §2): the language node
      // merges like ui/model — a reply write never drops the stored reasoning
      // key, and vice versa (the persona.id pattern).
      const mergeLanguage = (patch: Record<string, unknown>): void => {
        const language = typeof record["language"] === "object" && record["language"] !== null && !Array.isArray(record["language"])
          ? { ...(record["language"] as Record<string, unknown>) }
          : {};
        record["language"] = { ...language, ...patch };
      };
      if (key === "ui.defaultMode") {
        // M78-buddy §4: the allowlist gains "buddy" (the two-panel shell) —
        // everything else still refuses.
        if (value !== "simple" && value !== "buddy" && value !== "advanced") {
          throw new Error('ui.defaultMode must be "simple" | "buddy" | "advanced"');
        }
        mergeUi({ defaultMode: value });
      } else if (key === "ui.theme") {
        // M64-visual §4: the writer mirrors ui.defaultMode's shape — only the
        // enumerated non-null values are writable (absence lives on the read
        // side as null, never written as a value).
        if (value !== "light" && value !== "dark") {
          throw new Error('ui.theme must be "light" | "dark"');
        }
        mergeUi({ theme: value });
      } else if (key === "ui.accent") {
        if (value !== "black" && value !== "blue" && value !== "green") {
          throw new Error('ui.accent must be "black" | "blue" | "green"');
        }
        mergeUi({ accent: value });
      } else if (key === "memoryEnabled") {
        if (typeof value !== "boolean") throw new Error("memoryEnabled must be a boolean");
        record["memoryEnabled"] = value;
      } else if (key === "model.defaultModel") {
        // R6 quickwin: {provider, model} — the provider-qualified pair (the
        // boot applies it only when the stored provider is the selected one).
        // Task 5: the provider gate widens to the registry's effective view —
        // a custom provider's model may be the persisted default (the same
        // widening settingsSaveKey/settingsTestConnection got).
        const v = value as { provider?: unknown; model?: unknown };
        if (
          typeof value !== "object" || value === null || Array.isArray(value) ||
          typeof v.provider !== "string" || !(isProviderName(v.provider) || loadEffectiveProfiles().has(v.provider)) ||
          typeof v.model !== "string" || v.model.trim() === ""
        ) {
          throw new Error('model.defaultModel must be { provider, model } with a known provider and a non-blank model');
        }
        mergeModel({ defaultModel: value });
      } else if (key === "model.defaultEffort") {
        if (typeof value !== "string" || !(REASONING_EFFORTS as readonly string[]).includes(value)) {
          throw new Error(`model.defaultEffort must be one of: ${REASONING_EFFORTS.join(", ")}`);
        }
        mergeModel({ defaultEffort: value });
      } else if (key === "wizard.completedVersion") {
        // M63 §C: the versioned welcome notice — completed/skipped marks the
        // copy version seen; bumping the wizard's copy re-shows it.
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new Error("wizard.completedVersion must be a non-negative integer");
        }
        const wizard = typeof record["wizard"] === "object" && record["wizard"] !== null && !Array.isArray(record["wizard"])
          ? { ...(record["wizard"] as Record<string, unknown>) }
          : {};
        record["wizard"] = { ...wizard, completedVersion: value };
      } else if (key === "persona.id") {
        // SDD 2026-08-23 persona Task 5: the global default persona (the
        // chain's LAST leg, spec §1/§2). Value = a registry-EXISTING persona
        // id (any tier — a default may pin a builtin) or "" to clear; the
        // clear is KEY-ABSENT (the ui.theme rule: absence lives on the read
        // side, never written as a value).
        // Layer-selection Task 1: the value may carry the `<id>:layers`
        // qualifier (parsePersonaSpec shape, `+`/`,` joined) — stored VERBATIM
        // (readGlobalDefaultPersonaId → resolveActivePersona parses it back);
        // plain ids round-trip byte-identical.
        if (typeof value !== "string") {
          throw new Error('persona.id must be a persona id string, or "" to clear');
        }
        const id = value.trim();
        if (id === "") {
          const next = personaNode();
          delete next["id"];
          if (Object.keys(next).length > 0) record["persona"] = next;
          else delete record["persona"];
        } else {
          const parsed = parsePersonaSpec(id);
          if (!parsed.ok) {
            throw new Error(`persona.id must be <id> or <id>:headers|body|prompt ("+"/","-joined), or "" to clear — ${parsed.error}`);
          }
          const registry = await personaRegistry();
          if (!registry.personas.some((p) => p.id === parsed.id)) {
            throw new Error(`persona.id must be an existing persona id (unknown: "${parsed.id}")`);
          }
          record["persona"] = { ...personaNode(), id };
        }
      } else if (key === "permissions.defaultMode") {
        // 0.3.11（用户反馈：权限档两入口 1:1 联动）：持久默认权限档——新
        // 会话起步档（CLI 旗标更高）。0.3.14 四档值（workspace/ask/auto/
        // plan；旧值写入被拒——读取侧有迁移，写入侧保持新值集）。Whole-node
        // merge so sibling permissions keys (the cross-tier allow/deny rule
        // lists) never drop (the persona.id pattern); the cloneable tiers'
        // defaultMode sub-key is gated in sanitizeUntrustedTier — the boot
        // reads the GLOBAL tier only.
        if (value !== "workspace" && value !== "ask" && value !== "auto" && value !== "plan") {
          throw new Error('permissions.defaultMode must be "workspace" | "ask" | "auto" | "plan"');
        }
        const node = typeof record["permissions"] === "object" && record["permissions"] !== null && !Array.isArray(record["permissions"])
          ? { ...(record["permissions"] as Record<string, unknown>) }
          : {};
        record["permissions"] = { ...node, defaultMode: value };
      } else if (key === "language.reply") {
        // 推理档三级配置 + 语言 chip S3 (spec §2): the REPLY knob —
        // LanguageBlockMode. "auto" is a REAL value here (explicit 默认=自动
        // pins auto above the env leg — see resolveLanguagePreference);
        // absence lives on the read side, never written as a value.
        if (value !== "auto" && value !== "on" && value !== "off") {
          throw new Error('language.reply must be "auto" | "on" | "off"');
        }
        mergeLanguage({ reply: value });
      } else if (key === "language.reasoning") {
        // The REASONING knob — ReasoningLanguageMode (夜移 012's dual-knob
        // split: thinking text language, independent of the answer language).
        if (value !== "auto" && value !== "zh" && value !== "en" && value !== "off") {
          throw new Error('language.reasoning must be "auto" | "zh" | "en" | "off"');
        }
        mergeLanguage({ reasoning: value });
      } else if (key === "docSuite.enabled") {
        // ω99-236: the doc trio's opt-out mount gate (09-09 用户指令 ①——三件
        // 套插件化的设置页开关写位). Boolean only; whole-node merge so sibling
        // docSuite keys never drop (the persona.id pattern). Off takes effect
        // on the NEXT session (no mid-session removal — M24; see doc-suite.ts).
        if (typeof value !== "boolean") throw new Error("docSuite.enabled must be a boolean");
        const node = typeof record["docSuite"] === "object" && record["docSuite"] !== null && !Array.isArray(record["docSuite"])
          ? { ...(record["docSuite"] as Record<string, unknown>) }
          : {};
        record["docSuite"] = { ...node, enabled: value };
      } else if (key === "desktop.backgroundOnClose") {
        // ω99-287（续，标记见上）: the desktop's 关窗后台 toggle (L2 A 案).
        // Boolean only; whole-node merge so sibling desktop keys never drop
        // (the docSuite.enabled pattern). Off is the factory default — the
        // write only ever lands after an explicit user toggle.
        if (typeof value !== "boolean") throw new Error("desktop.backgroundOnClose must be a boolean");
        const desktop = typeof record["desktop"] === "object" && record["desktop"] !== null && !Array.isArray(record["desktop"])
          ? { ...(record["desktop"] as Record<string, unknown>) }
          : {};
        record["desktop"] = { ...desktop, backgroundOnClose: value };
      } else if (key === "schedules.launchAgent") {
        // 122 项 2 — 定时任务离线唤起（LaunchAgent opt-in，fail-closed 家
        // 族）。Boolean only; whole-node merge so the sibling
        // schedules.sleepGuardMs never drops (the docSuite.enabled pattern).
        // False is the factory default. The daemon's reconcile re-reads this
        // LIVE (≤ one tick) — no restart needed for either direction; the
        // plist under ~/Library/LaunchAgents/ follows within the same tick.
        if (typeof value !== "boolean") throw new Error("schedules.launchAgent must be a boolean");
        const schedulesNode = typeof record["schedules"] === "object" && record["schedules"] !== null && !Array.isArray(record["schedules"])
          ? { ...(record["schedules"] as Record<string, unknown>) }
          : {};
        record["schedules"] = { ...schedulesNode, launchAgent: value };
      } else {
        throw new Error(`unknown settings key "${key}" (writable: ui.defaultMode, ui.theme, ui.accent, memoryEnabled, model.defaultModel, model.defaultEffort, wizard.completedVersion, persona.id, permissions.defaultMode, language.reply, language.reasoning, docSuite.enabled, desktop.backgroundOnClose, schedules.launchAgent)`);
      }
      await saveGlobalSettings(record, e);
      return { key, saved: true };
    },

    // M75-ux1 §2: the recents — read `<home>/recent-workspaces.json`; with
    // `add`, the recordRecentWorkspace pass first. A missing or corrupt file
    // reads as the empty list; a blank add is a read.
    async recentWorkspaces(add?: string): Promise<RecentWorkspacesPayload> {
      if (add === undefined || add.trim() === "") {
        try {
          return { workspaces: sanitizeRecentWorkspaces(JSON.parse(await readFile(recentWorkspacesPath(env()), "utf8"))) };
        } catch {
          // ENOENT or a corrupt file — an empty list, never an error.
          return { workspaces: [] };
        }
      }
      return { workspaces: await recordRecentWorkspace(add, env()) };
    },
    /** M77-workspace §1: same-window directory switch — starts a new UI
     *  session (new server on a new port) for the target directory and
     *  returns its URL; the client navigates there (window.location.href).
     *  Lazy imports break the settings-ops ↔ ui circular dep. */
    switchWorkspace: async (path: string): Promise<{ url: string }> => {
      const s = await stat(path).catch(() => null);
      if (s === null || !s.isDirectory()) throw new Error(`not a directory: ${path}`);
      // Lazy: ui.ts imports from driver/ which imports settings-ops — a
      // top-level import here would cycle at module-init time.
      const { startUiSession } = await import("../ui.js");
      const { resolveProviderConfig } = await import("@wudao/providers");
      const env = process.env as unknown as Record<string, string>;
      const resolved = resolveProviderConfig(env);
      if (resolved === null) throw new Error("no provider configured — set a key in settings first");
      const contextWindowTokens = 64_000; // same default as the CLI's --context-window
      const session = await startUiSession({
        config: resolved,
        workspaceRoot: path,
        contextWindowTokens,
        announce: false,
        openBrowser: false,
      });
      return { url: session.server.url };
    },

    // cc-plugins C1 — the plugin-management ops (PROTOCOL "pluginList" …
    // "pluginDisable"). One engine, three faces: these run the SAME
    // marketplace.ts functions as /plugin and `wudao plugin`.
    pluginList: async () => ({
      installed: await engineListInstalled({ env: env(), workspaceRoot: deps.workspaceRoot }),
    }),

    pluginMarketList: async () => {
      const e = env();
      const markets = await engineMarketList({ env: e });
      return { marketplaces: markets.map((m) => ({ ...m, plugins: marketEntries(m.name, e, deps.workspaceRoot) })) };
    },

    pluginMarketAdd: async (source, name) => engineMarketAdd(source, name !== undefined ? { name } : {}, { env: env() }),

    pluginMarketUpdate: async (name) => engineMarketUpdate(name, { env: env() }),

    pluginMarketRemove: async (name) => {
      // Busy law: the cascade deletes plugin dirs a run's hooks may be
      // executing from — refuse BEFORE any engine call.
      if (busy()) throw new Error(BUSY_MARKET_REMOVE);
      const d = engDeps();
      const { removedPlugins } = await engineMarketRemove(name, d.deps);
      const receipt = await rescanReceipt();
      return {
        removedPlugins,
        warnings: [...d.warns(), ...(receipt.warning !== undefined ? [receipt.warning] : [])],
        ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}),
      };
    },

    longtermMemoryList: async () => {
      const entries = await readMemoryFile(join(deps.workspaceRoot, ".wudao", "memory", "memory.jsonl"));
      return { entries: entries.map((e) => ({ id: e.id, kind: e.kind, text: e.text, tags: [...e.tags], createdAt: e.createdAt, useCount: e.useCount })) };
    },

    longtermMemoryForget: async (id) => {
      await openMemoryStore(join(deps.workspaceRoot, ".wudao", "memory")).forget(id);
    },

    pluginInstallSpec: async (spec, preview) => {
      const d = engDeps();
      if (preview === true) {
        const r = await engineInstallSpec(spec, { preview: true }, d.deps);
        return { preview: true, ...(r.name !== undefined ? { name: r.name } : {}), detail: r.detail, warnings: [...d.warns()] };
      }
      const { dir, name, format, detail } = await engineInstallSpec(spec, {}, d.deps);
      const receipt = await rescanReceipt();
      return {
        preview: false,
        dir,
        name,
        ...(format !== undefined ? { format } : {}),
        detail,
        warnings: [...d.warns(), ...(receipt.warning !== undefined ? [receipt.warning] : [])],
        ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}),
      };
    },

    pluginInstall: async (name, market, scope) => {
      // The scope grammar is validated HERE too (fail-closed for direct
      // callers): the engine would happily write under a bogus scope root.
      if (scope !== "user" && scope !== "project") {
        throw new Error(`pluginInstall scope must be "user" | "project" — got ${JSON.stringify(scope)}`);
      }
      const d = engDeps();
      const { dir, detail } = await engineInstall(name, market, scope, d.deps);
      const receipt = await rescanReceipt();
      return {
        dir,
        detail,
        warnings: [...d.warns(), ...(receipt.warning !== undefined ? [receipt.warning] : [])],
        ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}),
      };
    },

    pluginUninstall: async (id) => {
      // Busy law: same refusal, before any engine call.
      if (busy()) throw new Error(BUSY_PLUGIN_UNINSTALL);
      const d = engDeps();
      await engineUninstall(id, d.deps);
      const receipt = await rescanReceipt();
      return {
        id,
        warnings: [...d.warns(), ...(receipt.warning !== undefined ? [receipt.warning] : [])],
        ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}),
      };
    },

    pluginEnable: async (id) => {
      await engineSetEnabled(id, true, engDeps().deps);
      const receipt = await rescanReceipt();
      return { id, enabled: true, ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}) } as const;
    },

    pluginDisable: async (id) => {
      await engineSetEnabled(id, false, engDeps().deps);
      const receipt = await rescanReceipt();
      return { id, enabled: false, ...(receipt.rescan !== undefined ? { rescan: receipt.rescan } : {}) } as const;
    },

    // SDD 2026-08-23 persona Task 5 — the persona ops (PROTOCOL "personaList"
    // … "personaDelete"). Reads over the three-tier merged registry; writes
    // land ONLY in the global tier (the editable surface — workspace files
    // belong to the repo, builtin fingerprints are pinned data).
    personaList: async () => {
      const registry = await personaRegistry();
      const globalIds = await personaIdsInDir(globalPersonaDir());
      const workspaceIds = await personaIdsInDir(workspacePersonaDir());
      const personas = registry.personas.map((p) => {
        const source: PersonaSummaryRow["source"] = workspaceIds.has(p.id) ? "workspace" : globalIds.has(p.id) ? "global" : "builtin";
        return { id: p.id, displayName: p.displayName, source, layers: personaLayersLabel(p), editable: source === "global" };
      });
      return { personas };
    },

    personaGet: async (id: string) => {
      const registry = await personaRegistry();
      const definition = registry.personas.find((p) => p.id === id);
      if (definition === undefined) throw new Error(`unknown persona "${id}"`);
      return { definition };
    },

    personaSave: async (definition: unknown): Promise<PersonaSaveOutcome> => {
      // Validate FIRST (fail-closed — an invalid definition never reaches
      // the collision rules or the disk), then the tier-collision rules,
      // then the write. A GLOBAL persona with the same id is the UPDATE
      // path, not a collision.
      const v = validatePersonaDefinition(definition);
      if (!v.ok) return { ok: false, errors: v.error.split("; ") };
      if (BUILTIN_PERSONAS.some((b) => b.id === v.persona.id)) {
        return { ok: false, errors: [`id: "${v.persona.id}" 是内置 persona——内置指纹是钉定数据（doc90），设置页不可覆盖`] };
      }
      if ((await personaIdsInDir(workspacePersonaDir())).has(v.persona.id)) {
        return { ok: false, errors: [`id: "${v.persona.id}" 是工作区 persona（<workspace>/.wudao/personas/）——工作区文件由仓库持有，请在文件系统中修改`] };
      }
      const saved = await savePersonaDefinition(globalPersonaDir(), v.persona);
      if (!saved.ok) return { ok: false, errors: saved.errors };
      return { ok: true };
    },

    personaDelete: async (id: string, unbind?: boolean): Promise<PersonaDeleteOutcome> => {
      const trimmed = id.trim();
      if (trimmed === "") throw new Error("personaDelete needs a persona id");
      if (BUILTIN_PERSONAS.some((b) => b.id === trimmed)) {
        throw new Error(`"${trimmed}" 是内置 persona，不可删除`);
      }
      if ((await personaIdsInDir(workspacePersonaDir())).has(trimmed)) {
        throw new Error(`"${trimmed}" 是工作区 persona（<workspace>/.wudao/personas/），请在文件系统中删除`);
      }
      if (!(await personaIdsInDir(globalPersonaDir())).has(trimmed)) {
        throw new Error(`unknown persona "${trimmed}"`);
      }
      // The reference inventory: bound provider cards + the global default.
      // ok:false ALWAYS carries `references` (the wire contract — the panel's
      // confirm card reads them unconditionally); the error-shaped refusals
      // above are the exceptions that never reach the card.
      const e = env();
      const providers = providersBoundToPersona(trimmed, e);
      // Layer-selection Task 1: the stored default may be `id:layers` — match
      // by its bare id (personaReferenceId), so a qualified default is still
      // inventoried + unbound when the persona is deleted.
      const storedDefault = readGlobalDefaultPersonaId(e);
      const isGlobalDefault = storedDefault !== undefined && personaReferenceId(storedDefault) === trimmed;
      if ((providers.length > 0 || isGlobalDefault) && unbind !== true) {
        return { ok: false, references: { providers, isGlobalDefault } };
      }
      // Unbind (or nothing to unbind): cards back to key-absent, the global
      // default cleared, then the file itself.
      if (providers.length > 0) await clearProviderPersonaBindings(trimmed, e);
      if (isGlobalDefault) {
        const record = await readGlobalSettings(e);
        const node = typeof record["persona"] === "object" && record["persona"] !== null && !Array.isArray(record["persona"])
          ? { ...(record["persona"] as Record<string, unknown>) }
          : null;
        const nodeId = node !== null && typeof node["id"] === "string" ? node["id"] as string : undefined;
        if (nodeId !== undefined && node !== null && personaReferenceId(nodeId) === trimmed) {
          delete node["id"];
          if (Object.keys(node).length > 0) record["persona"] = node;
          else delete record["persona"];
          await saveGlobalSettings(record, e);
        }
      }
      await deletePersonaDefinition(globalPersonaDir(), trimmed);
      return { ok: true };
    },

    // MCP visibility — one read over the three tiers, effective-entry rows
    // (the same replacement chain loadMcpConfig folds; kept SEPARATE here so
    // each row names its tier). The runtime lane is the bridge's process-
    // global snapshot: absent server = this session hasn't connected it yet
    // (延迟装载 included) — surfaced as 未连接, never as an error.
    mcpList: async (): Promise<McpListPayload> => {
      const warnings: string[] = [];
      const tiers = loadMcpTiers(deps.workspaceRoot, (m) => warnings.push(m));
      const runtime = mcpRuntimeSnapshot();
      const servers: McpListServerRow[] = [];
      const emit = (tier: "user" | "root" | "project"): void => {
        const earlier: readonly ("user" | "root")[] = tier === "project" ? ["user", "root"] : tier === "root" ? ["user"] : [];
        for (const [name, entry] of Object.entries(tiers[tier])) {
          if (servers.some((s) => s.name === name)) continue; // a MORE specific tier already emitted this name
          const replaces = earlier.filter((t) => Object.prototype.hasOwnProperty.call(tiers[t], name));
          const info = runtime.get(name);
          servers.push({
            name,
            tier,
            transport: isHttpMcpServer(entry) ? "http" : "stdio",
            command: isHttpMcpServer(entry)
              ? redactUrl(entry.url)
              : [entry.command, ...(entry.args ?? [])].join(" "),
            replaces,
            connected: info?.connected === true,
            tools: info?.tools ?? 0,
            ...(info?.failure !== undefined ? { failure: info.failure } : {}),
          });
        }
      };
      // MOST-SPECIFIC FIRST (project → root → user): the first emit of a
      // name is its EFFECTIVE tier (the replacement chain's winner); earlier
      // tiers' same-name entries never emit.
      emit("project");
      emit("root");
      emit("user");
      return {
        servers,
        warnings,
        files: {
          user: globalMcpConfigPath(env()),
          root: ccMcpConfigPath(deps.workspaceRoot),
          project: mcpConfigPath(deps.workspaceRoot),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// cc-plugins C1 — the pluginMarketList discover entries (pure over the
// materialized market trees; no engine mutation)
// ---------------------------------------------------------------------------

/** The market's discover rows: the manifest entries plus the loader dry-run
 *  counts for local-dir sources. Sync by design — the manifests and plugin
 *  dirs are already on disk; a read failure degrades to `[]` (the registry
 *  row still lists; pluginMarketUpdate is the repair path). */
function marketEntries(name: string, e: NodeJS.ProcessEnv, workspaceRoot: string): readonly MarketplacePluginEntryInfo[] {
  let file;
  try {
    file = readMarketplaceFile(join(marketplacesDir(e), name));
  } catch {
    return [];
  }
  return file.plugins.map((entry) => ({
    name: entry.name,
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.version !== undefined ? { version: entry.version } : {}),
    detail: entryDetail(entry, join(marketplacesDir(e), name), workspaceRoot),
  }));
}

/** Install-preview counts for one entry. Local sources resolve against the
 *  MARKET root (the engine's install-side rule — a relative source must stay
 *  inside the market; a `../` escape is not inspectable → null); git-location
 *  sources would need a clone → null. Uses parseMarketSource for the git
 *  classification only — the path resolution here is the market-rooted one. */
function entryDetail(entry: MarketplaceEntry, marketDir: string, workspaceRoot: string): InstallDetail | null {
  const parsed = parseMarketSource(entry.source);
  if (parsed?.kind === "github" || parsed?.kind === "git") return null;
  const expanded = entry.source.startsWith("~") ? join(homedir(), entry.source.slice(1)) : entry.source;
  const abs = isAbsolute(expanded) ? expanded : resolve(marketDir, expanded);
  if (!isAbsolute(expanded)) {
    const rel = relative(marketDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  }
  return inspectPluginDir(abs, workspaceRoot)?.detail ?? null;
}

/** Explicit delegation wrapper: the AgentDriver (a class instance — a spread
 *  would drop its prototype methods) plus the settings ops, satisfying the
 *  server's structural UiDriverPort. The compiler forces every port method
 *  to be delegated; ops stay driver-independent (testable without one). */
export function withSettingsOps(driver: AgentDriver, deps: SettingsOpsDeps): UiDriverPort {
  // 0.3.30 两套拆分：settings/registry 层的唯一漏斗——CLI REPL 与桌面
  // server 的注入 driver 都从这里过，kimi-code → kimi 的一次性迁移在此
  // 先行（fail-open，永不阻塞）。
  migrateKimiCodeSplit(deps.env ?? process.env);
  // cc-plugins C1: the mounted port probes the LIVE driver for busy (the
  // web client can call ops anytime — the slash path's guard is not the only
  // gate). An explicitly injected probe still wins (tests).
  const ops = createSettingsOps({ ...deps, ...(deps.isBusy === undefined ? { isBusy: () => driver.getStatus().busy === true } : {}) });
  // Provider management §5: the registry write ops + the /models probe ride
  // the same wrapped port (their handlers live in provider-registry-ops.ts —
  // the registry's read/write seam, not the credentials/settings seam above).
  const registryOps = createProviderRegistryOps(deps);
  // M79 §4: the attachment ops over the workspace's .wudao/attachments store
  // (admission limits live in the store itself — one policy, one layout,
  // shared with the CLI's --image flag).
  const attachments = createAttachmentOps({ workspaceRoot: deps.workspaceRoot });
  return {
    subscribe: (cb) => driver.subscribe(cb),
    getStatus: () => driver.getStatus(),
    getHistory: () => driver.getHistory(),
    onHistory: (cb) => driver.onHistory(cb),
    onLoopEvent: (cb) => driver.onLoopEvent(cb),
    // M79 §5: the port carries transport-typed images (unknown[]); the server
    // shape-validated them and the driver's routedSubmit re-validates every
    // block (isValidImageBlock) before anything moves — the cast is the
    // boundary translation, not trust.
    submit: (text, opts) => driver.submit(text, opts as Parameters<AgentDriver["submit"]>[1]),
    interrupt: () => driver.interrupt(),
    // 借鉴弧 δ（penguin 367ab084）— the mid-flight detach face over the port
    // (both faces ride this wrapper: the CLI REPL's injected driver and the
    // desktop server's). Verbatim verdict relay; the typed refusals are the
    // web busy-row button's disable/reply surface.
    detachToolCall: (callId?: string) => driver.detachToolCall(callId),
    // The server validated the string against its configured mode set (the
    // wudao ui host passes the CLI's full four) — the port boundary carries
    // it as a bare string, the driver takes the union.
    setMode: (mode) => driver.setMode(mode as Mode),
    // 0.3.14 #1: scope (session/always) rides through — the driver applies
    // the rule semantics; the port type below widens to match.
    answerPermission: (allow, reason, scope) => driver.answerPermission(allow, reason, scope),
    listSlashCommands: () => driver.listSlashCommands(),
    sessions: () => driver.sessions(),
    // ω99-277: #4 — 弹框全文搜索转发（port 上 OPTIONAL，真实车道永在：
    // AgentDriver 的实现直通，桌面 server 由此挂上）。
    searchSessions: (q) => driver.searchSessions(q),
    // ω99-279: #5 — 回收站式删除转发（同 277 #4 形：port 上 OPTIONAL，真实
    // 车道永在——AgentDriver 的实现直通，桌面 server 由此挂上）。
    deleteSession: (id) => driver.deleteSession(id),
    // ω99-283: #7 — 回收站面转发（同 279 #5 形：port 上 OPTIONAL，真实车道
    // 永在——AgentDriver 的 trashSessions/restoreSession 直通，桌面 server
    // 由此挂上；漏了这条转发，server 会误答 not supported 而车道死路）。
    trashSessions: () => driver.trashSessions(),
    restoreSession: (id) => driver.restoreSession(id),
    // ω99-286: #3 — 断点续跑转发（283 #7 同款缝：port 上 OPTIONAL，真实
    // 车道永在——AgentDriver 的 continueSession 直通，桌面 server 由此挂上；
    // 漏了这条转发，server 会误答 not supported 而续跑车道死路——283 #7
    // 教训重演）。
    continueSession: (id) => driver.continueSession(id),
    // 小精灵会话弧 — 会话级 fork（server 的 resume 携 fork:true 时调用）：
    // forkSessionFile 字节复制源会话到全新 id（原会话永不以写模式打开），
    // 再把本 driver resume 到副本上（fork+resume 两段合一，一次回执）。
    // busy 拒（主车道换血不能打断运行中的回合——老 server resume 的 UI
    // busy 门同判据，这里是服务端底线）；源不存在/不可读拒 not_found
    // （回执联合镜像见 ports.ts 的 forkSession 注释）。
    forkSession: async (id: string): Promise<unknown> => {
      if (driver.getStatus().busy) return { ok: false, reason: "busy" };
      let fork: { readonly newId: string };
      try {
        fork = await forkSessionFile(join(deps.workspaceRoot, ".wudao", "sessions"), id);
      } catch {
        return { ok: false, reason: "not_found" };
      }
      const outcome = await driver.resume(fork.newId);
      return outcome.ok ? { ok: true, forkedId: fork.newId } : outcome;
    },
    resume: (id) => driver.resume(id),
    rewind: (target) => driver.rewind(target),
    beginEdit: (n) => driver.beginEdit(n),
    tree: () => driver.tree(),
    switchBranch: (n) => driver.switchBranch(n),
    // 推理档三级配置 S4: overlay the session-effective language pair onto
    // the stored-tier payload — the web's gateStatus.language reads this.
    // S5: the SAME overlay carries the session-effective EFFORT (the base's
    // current.effort is the env/boot tier; the web's 强度 chip and its
    // 设为默认 footer must follow mid-session /effort picks).
    settingsStatus: async () => {
      const base = await ops.settingsStatus();
      const live = driver.getEffort();
      return {
        ...base,
        ...(live !== undefined ? { current: { ...base.current, effort: live } } : {}),
        language: driver.getLanguage(),
      };
    },
    // 0.3.32c kimi-401: a key saved for the LIVE provider must reach the
    // RUNNING session — the file write alone leaves the live pool carrying
    // whatever the last switch resolved (the reported trap: switch-to-kimi
    // before any kimi key existed → the cross-provider fallback borrowed the
    // boot provider's key → 401; saving the key in settings then retried
    // against the stale live config — the same 401, forever). The
    // settingsSaveProvider → refreshStatus pattern, one lane deeper: when
    // the save names the current provider AND a re-resolve would change
    // something (placeholder completion or a pool-lacking file key), submit
    // the same-name /provider — the funnel's guard/parking/entry/notice
    // machinery applies the saved key without a restart, keeping the
    // session's model. `void`: the op's receipt is the save itself; the
    // switch lands its own notice.
    settingsSaveKey: async (provider, key) => {
      const out = await ops.settingsSaveKey(provider, key);
      const id = provider.trim();
      if (out.saved && driver.getStatus().model?.provider === id && driver.providerRefreshPending()) {
        void driver.submit(`/provider ${id}`);
      }
      return out;
    },
    settingsTestConnection: ops.settingsTestConnection,
    settingsSet: ops.settingsSet,
    // Provider management §5 — the registry ops on the same port. A LANDED
    // registry write re-emits the status snapshot: the op already invalidated
    // this process's registry memo (I2), but without a rebuild+broadcast the
    // web's model matrix (status.model.choices — push-only, rebuilt on driver
    // emits) stays stale until the next unrelated run event (用户反馈
    // 2026-08-29: 保存供应商模型后模型下拉不出现新模型). Failure branches
    // refresh nothing — a failed write never disturbs a cached-good view.
    settingsSaveProvider: async (id, config) => {
      const out = await registryOps.settingsSaveProvider(id, config);
      if (out.ok) driver.refreshStatus();
      // 2026-08-31 config-drift (用户反馈: 配置完成后会话应直接读最新配置,
      // 无需手动重切): a row save for the LIVE provider that changed the
      // CONNECTION (endpoint/wire — models-only saves don't) hot-refreshes
      // the running session through the same-name /provider funnel: park when
      // busy, land at settle, entry + notices ride along. providerRefreshPending
      // re-resolves as the drift probe; false (no connection change) submits
      // nothing.
      if (out.ok && driver.getStatus().model?.provider === id && driver.providerRefreshPending()) {
        void driver.submit(`/provider ${id}`);
      }
      return out;
    },
    settingsDeleteProvider: async (id) => {
      const out = await registryOps.settingsDeleteProvider(id);
      if (out.ok) driver.refreshStatus();
      return out;
    },
    settingsListModels: registryOps.settingsListModels,
    // M75-ux1 §2: the workspace switcher's recents op rides the same port.
    recentWorkspaces: (add) => ops.recentWorkspaces(add),
    // MCP visibility — the settings page's MCP tab (same op surface; the
    // createSettingsOps read needs no live-driver overlay).
    mcpList: () => ops.mcpList(),
    // M77-workspace §1: same-window directory switch.
    switchWorkspace: (path) => ops.switchWorkspace(path),
    // M74-ide §1: the file-panel data ops ride the same wrapped port (the
    // driver implements them over its live panelRoot — workspace-ux B1 —
    // not the settings deps' workspaceRoot, which only feeds the settings
    // reads).
    fileTree: (path) => driver.fileTree(path),
    fileRead: (path) => driver.fileRead(path),
    fileWrite: (path, content, base) => driver.fileWrite(path, content, base),
    // workspace-ux B1: the panel-root ops — driver state (panelRoot lives in
    // the driver next to fileTree/fileRead's resolution); the recents write
    // inside panelRootSet goes through recordRecentWorkspace above.
    panelRootSet: (path) => driver.panelRootSet(path),
    agentRootStatus: () => driver.agentRootStatus(),
    // workspace-ux B2: the agent-root switch (the confirm-card action) — the
    // driver owns the switchable root, the busy queue, and the notice/note.
    agentRootSwitch: (path) => driver.agentRootSwitch(path),
    // M76-ux2 §8: the ctx hover's breakdown rides the same wrapped port.
    ctxInfo: () => driver.ctxInfo(),
    // M79 §4: the attachment ops ride the same wrapped port. The get-ref
    // arrives transport-typed (kind optional on this direction — the id trio
    // is what the store keys on); normalized here.
    attachmentSave: (inputs) => attachments.attachmentSave(inputs),
    attachmentGet: (ref) => attachments.attachmentGet({ kind: "image", ...ref }),
    // ω99-55: the file lane rides the same wrapped port (one attachment
    // domain, two lanes — the composer saves files BEFORE submit).
    fileSave: (inputs) => attachments.fileSave(inputs),
    // cc-plugins C1 — the plugin-management ops ride the same wrapped port
    // (the marketplace engine + the busy probe live in the ops object).
    pluginList: ops.pluginList,
    pluginMarketList: ops.pluginMarketList,
    pluginMarketAdd: ops.pluginMarketAdd,
    pluginMarketUpdate: ops.pluginMarketUpdate,
    pluginMarketRemove: ops.pluginMarketRemove,
    pluginInstall: ops.pluginInstall,
    pluginUninstall: ops.pluginUninstall,
    pluginEnable: ops.pluginEnable,
    pluginDisable: ops.pluginDisable,
    // SDD 2026-08-23 persona Task 5 — the persona ops ride the same wrapped
    // port (PROTOCOL "personaList" … "personaDelete"; the handler + the
    // three-tier dir resolution live in the ops object above).
    personaList: ops.personaList,
    personaGet: ops.personaGet,
    personaSave: ops.personaSave,
    personaDelete: ops.personaDelete,
  };
}
