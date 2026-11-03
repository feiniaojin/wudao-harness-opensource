// M63 §A — /provider: the in-session PROVIDER switch. A model switch keeps
// the endpoint (baseURL + key + matrix); a provider switch changes the
// ENDPOINT IDENTITY, so the client must be REBUILT from the target profile —
// mutating the live config object in place is not enough (the engine
// precomputes its fallback chain at construction, and the reasoning matrix is
// profile-bound). This module owns the pure halves every frontend shares:
// target-config derivation, the status dots for the bare listing, the session
// entry, and the cache-cost receipts. The client rebuild itself stays
// frontend-owned (config resolution order differs per frontend) and is
// reached through the driver's onProviderSwitch seam.
import { join } from "node:path";
import { PROVIDER_PROFILES, parseApiKeyPool, supportsReasoningEffort, isBuiltinProviderName, parseWire, parseReasoningReplay, capClientReasoningReplay } from "@wudao-org/providers";
import type { BuiltinProviderName, EffectiveProfile, ProviderConfig, ProviderName, ReasoningReplay } from "@wudao-org/providers";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { ProviderChangeEntry } from "@wudao-org/core";
import { availableModels, foldEffortChain, validateEffort } from "./model.js";
import type { MutableProviderConfig } from "./model.js";
// M63 §C: the wizard boot's stand-in key — never a usable credential (the
// constant lives in the credentials leaf module).
import { WIZARD_PLACEHOLDER_KEY } from "../credentials.js";
import { loadEffectiveProfiles } from "../provider-registry.js";
import { readProviderEffortBinding } from "../driver/provider-registry-ops.js";
import { readStoredModelDefaults } from "../driver/settings-ops.js";
import { readGlobalSettingsSync } from "../settings-layer.js";

export const PROVIDER_NAMES: readonly BuiltinProviderName[] = Object.keys(PROVIDER_PROFILES) as readonly BuiltinProviderName[];

export type ProviderValidation =
  | { readonly ok: true; readonly name: ProviderName }
  | { readonly ok: false; readonly error: string };

/** Validate a user-supplied provider name against the effective view:
 *  builtin ∪ registry ids (provider management §4 — a custom provider from
 *  ~/.wudao/providers.json switches in-session exactly like a builtin).
 *  Registry ids are exact; a case-insensitive hit on a BUILTIN keeps the
 *  historical tolerance (/provider DeepSeek → deepseek). */
export function validateProviderName(raw: string): ProviderValidation {
  const name = raw.trim();
  const profiles = loadEffectiveProfiles();
  if (name === "") return { ok: false, error: "用法：/provider [name]——裸命令列出各 provider 及其状态" }; // ω99-166d-i: #21
  if (profiles.has(name)) return { ok: true, name };
  const lowered = name.toLowerCase();
  if (isBuiltinProviderName(lowered)) return { ok: true, name: lowered };
  return {
    ok: false,
    error: `unknown provider "${name}" — providers: ${[...profiles.keys()].join(", ")} (bare /provider lists them)`,
  };
}

export type ProviderSwitchResult =
  | {
      readonly ok: true;
      readonly config: ProviderConfig;
      /** 0.3.32c kimi-401: the switch found NO key of the target's own
       *  (live pool empty of target keys, no env pool, no file key) and rode
       *  the session's EXISTING pool across the endpoint change (the
       *  one-gateway pattern). When the two endpoints disagree on
       *  credentials this is the 401 the user sees — the landing surfaces
       *  append borrowedKeyPoolNote() so the fix is named on the spot. */
      readonly borrowedKeyPool?: boolean;
    }
  | {
      readonly ok: false;
      readonly error: string;
      /** Structured refusal reason (drives the listing's status dot).
       *  M3 (review round 1): "unknown" is its own reason — an id that is
       *  neither builtin nor registered is not a key problem. */
      readonly reason: "missing-key" | "needs-endpoint" | "needs-model" | "unknown";
    };

/** The model a switch to `provider` would land on: the ENV override when its
 *  /model-matrix entry rides that provider (the matrix scoping rule — the
 *  override belongs to its WUDAO_PROVIDER owner; note a --provider RESTART
 *  resolves WUDAO_MODEL globally, so the two lanes can legitimately differ),
 *  else the profile default. Provider management: `provider` is any id in
 *  the effective view; a custom saved without defaultModel/models lands ""
 *  and the switch REFUSES (the R-M2 selection-time guard, mirrored here). */
export function switchTargetModel(provider: string, env: NodeJS.ProcessEnv): string {
  const envChoice = availableModels(env).find((c) => c.source === "env" && c.provider === provider);
  if (envChoice !== undefined) return envChoice.model;
  return loadEffectiveProfiles().get(provider)?.defaultModel ?? "";
}

/** Derive the target config for a provider switch — PURE (no mutation: a
 *  switch parked behind a busy run must not touch the live provider that run
 *  is still using). Carried from the current config: the key pool (batch A
 *  has one pool for every provider) and the session's effort/replay prefs.
 *  NOT carried: the M62 fallbackModel chain — it is same-provider scoped
 *  (model names are endpoint-bound; a deepseek fallback name on the glm
 *  endpoint is a guaranteed 404 walk). Dropped, not an error.
 *  M63 §C: `credentials` extends the key chain — live pool → env pool → the
 *  target provider's credentials-file key (env wins, same precedence as
 *  boot). The wizard's just-saved key switches the live session through this
 *  leg without a restart.
 *  Provider management §4: the target resolves against the EFFECTIVE view
 *  (builtins ⊕ overlays ⊕ customs) — a registry custom builds on its
 *  registry baseUrl/matrix, an overlay rides the compiled-in builtin. */
export function resolveProviderSwitch(input: {
  readonly target: string;
  readonly env: NodeJS.ProcessEnv;
  readonly current: Pick<ProviderConfig, "apiKey" | "apiKeys" | "reasoningEffort" | "reasoningReplay" | "wire" | "provider">;
  readonly credentials?: Readonly<Record<string, string>>;
}): ProviderSwitchResult {
  const profile: EffectiveProfile | undefined = loadEffectiveProfiles().get(input.target);
  if (profile === undefined) {
    return {
      ok: false,
      reason: "unknown",
      error: `unknown provider "${input.target}" — providers: ${[...loadEffectiveProfiles().keys()].join(", ")} (registry customs come from ~/.wudao/providers.json)`,
    };
  }
  // Keys: the session's live pool first (it is what the running provider
  // authenticated with), then the env pool, then the credentials file. The
  // wizard boot's placeholder key reads as ABSENT — a switch off the
  // browse-only session resolves a real key, never carries the sentinel.
  const pool = [...(input.current.apiKeys ?? [input.current.apiKey])].filter((k) => k !== "" && k !== WIZARD_PLACEHOLDER_KEY);
  // 0.3.31b kimi-404: a CROSS-provider switch prefers the TARGET's own
  // credentials-file key — the old live-pool-first order sent the boot
  // provider's key to the new endpoint (a .env-pinned deepseek key hit
  // api.kimi.com → 401 even with the endpoint fixed). Same-provider
  // switches keep the live pool first: the authenticated keys ARE the
  // target's, and a stale file key must not displace them.
  // 0.3.32c kimi-401: the file legs only fire when the caller passes a
  // credentials SNAPSHOT — and the seams must pass it on EVERY resolve, not
  // a missing-key retry (1b84537 shipped the cross-provider preference
  // gated on `credentials`, but the seams' first resolve never passed it:
  // a target with a saved file key still borrowed the old pool and 401'd
  // forever — the retry only ran when pool AND env were empty). The
  // same-provider refresh leg: an explicit snapshot carrying a key the live
  // pool does NOT hold is newer by construction (the settings page just
  // saved it) — it outranks a pool the T0 cross-provider fallback may have
  // filled with the OLD provider's key. The pool keeps its order when the
  // file key is already one of it (rotation preserved).
  const fileKey = input.credentials !== undefined ? (input.credentials[input.target] ?? "").trim() : "";
  const crossProvider = input.current.provider !== input.target;
  const fileKeyPreferred =
    fileKey !== "" && (crossProvider || keyRefreshPending(input.current, input.credentials ?? {}));
  let keys = fileKeyPreferred ? [fileKey] : pool.length > 0 ? pool : parseApiKeyPool(input.env);
  if (keys.length === 0 && fileKey !== "") keys = [fileKey];
  const borrowedKeyPool = crossProvider && fileKey === "" && pool.length > 0;
  if (keys.length === 0) {
    return { ok: false, reason: "missing-key", error: `no API key configured — set WUDAO_API_KEY (or OPENAI_API_KEY), or save a ${input.target} key in "wudao ui", then /provider ${input.target}` };
  }
  const apiKey = keys[0] as string;
  // R-M2 mirror: a custom saved without defaultModel and without models has
  // nothing to run — refuse naming the fix (the id stays selectable).
  const model = switchTargetModel(input.target, input.env);
  if (model === "") {
    return {
      ok: false,
      reason: "needs-model",
      error: `custom provider "${input.target}" has no model to run — set "defaultModel" or add a "models" list to its entry in ~/.wudao/providers.json, or set WUDAO_MODEL`,
    };
  }
  // Endpoint — 0.3.31b kimi-404: at a MID-SESSION switch the TARGET's
  // profile default is the target's endpoint truth and OUTRANKS the
  // process-global env pins. The old env-first order let a workspace
  // .env's WUDAO_BASE_URL=api.deepseek.com override the kimi-code pin:
  // the switch relabeled the session while the endpoint stayed put, and
  // (with the 0.3.31 wire fix correctly pinning anthropic) the request
  // went to api.deepseek.com/v1/messages with model k3-256k → 404. Env
  // keeps its two legitimate roles: serving a target with NO profile
  // default (`wudao` must be configured) and satisfying an overlay's
  // requiresBaseUrl (R-M3 — the compiled-in builtin default must not).
  // The BOOT stays env-first (a --provider restart is an explicit
  // env-honoring act) — the asymmetry is deliberate.
  const envBase = input.env.WUDAO_BASE_URL ?? input.env.OPENAI_BASE_URL;
  const builtinDefault = isBuiltinProviderName(input.target) ? PROVIDER_PROFILES[input.target].defaultBaseUrl : undefined;
  const registrySupplied = profile.defaultBaseUrl !== undefined && profile.defaultBaseUrl !== builtinDefault;
  if (profile.requiresBaseUrl === true && envBase === undefined && !registrySupplied) {
    return { ok: false, reason: "needs-endpoint", error: `the ${input.target} profile has no default endpoint — set WUDAO_BASE_URL, then /provider ${input.target}` };
  }
  const baseURL = profile.requiresBaseUrl === true ? (registrySupplied ? profile.defaultBaseUrl : envBase) : (profile.defaultBaseUrl ?? envBase);
  if (baseURL === undefined || baseURL === "") {
    return { ok: false, reason: "needs-endpoint", error: `the ${input.target} profile has no default endpoint — set WUDAO_BASE_URL, then /provider ${input.target}` };
  }
  // 推理档三级配置 S2 (spec 2026-08-28 §1) — the switch RE-DERIVES effort
  // from the TARGET's chain (env pin > the target's registry binding > the
  // settings global default) instead of carrying the old endpoint's value
  // across. The sticky carry was the behavior the 2026-08-28 feedback
  // surfaced; 切到哪家电就带哪家配的档, and a post-switch /effort re-overrides.
  // The env leg validates here (a junk WUDAO_REASONING_EFFORT already failed
  // the boot visible-first; folded as absent rather than double-erroring).
  const envEffortRaw = (input.env.WUDAO_REASONING_EFFORT ?? "").trim();
  const envEffort = envEffortRaw === "" ? undefined : validateEffort(envEffortRaw);
  const effort = foldEffortChain(
    envEffort !== undefined && envEffort.ok ? envEffort.level : undefined,
    readProviderEffortBinding(input.target, input.env),
    readStoredModelDefaults(readGlobalSettingsSync(input.env)).effort,
  );
  // 0.3.31 kimi-400 弧 — the wire legs (selection > env > the TARGET
  // profile's pin; see the config spread below for the full rationale).
  // The old profile's id is only needed to detect a stale fold: a
  // current.wire equal to its pin was folded AT BOOT, not chosen.
  const oldProfile = input.current.provider !== undefined ? loadEffectiveProfiles().get(input.current.provider) : undefined;
  const userWire =
    input.current.wire !== undefined && input.current.wire !== oldProfile?.wire ? input.current.wire : undefined;
  const envWireRaw = (input.env.WUDAO_WIRE ?? "").trim();
  const envWire = envWireRaw === "" ? undefined : parseWire(envWireRaw);
  const wire = userWire ?? envWire ?? profile.wire;
  // ω99-39: the replay contract re-derives from ENV first (the only source of
  // replay intent — no /replay command, no settings field), then the carried
  // value, then the TARGET profile's probe-verified drop fact caps it. Without
  // the env leg, a deepseek boot's capped "never" would carry onto glm and
  // erase intent there (an unmarked provider's wire must stay byte-identical);
  // without the cap, a glm boot's toolCallTurns would land on deepseek and
  // re-import the waste this arc shuts off. Junk env folds as absent — the
  // boot already failed visibly on it (the effort leg's same rule).
  const envReplayRaw = (input.env.WUDAO_REASONING_REPLAY ?? "").trim();
  let envReplay: ReasoningReplay | undefined;
  if (envReplayRaw !== "") {
    try {
      envReplay = parseReasoningReplay(envReplayRaw);
    } catch {
      envReplay = undefined;
    }
  }
  const reasoningReplay = capClientReasoningReplay(profile, envReplay ?? input.current.reasoningReplay);
  return {
    ok: true,
    config: {
      apiKey,
      apiKeys: keys,
      baseURL,
      model,
      provider: input.target,
      // 推理档三级配置 S2: re-derived above — see the effort fold comment.
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      ...(reasoningReplay !== undefined ? { reasoningReplay } : {}),
      // 0.3.31 kimi-400 弧: the wire re-derives from the TARGET's chain
      // (boot parity: selection > env > profile.wire). Phase B's plain
      // carry predates the 0.3.30 plan-gateway split — the builtin
      // profiles now PIN their wire (kimi-code = anthropic), and the carry
      // missed the profile leg BOTH ways: deepseek (unset) → kimi-code
      // sent openai-shaped bytes to the anthropic endpoint; kimi-code
      // (anthropic fold) → deepseek dragged the fold into an openai
      // endpoint. Provenance without a marker: a current.wire that EQUALS
      // the old profile's native pin is a boot FOLD (drops in favor of the
      // target's chain); one that differs is a genuine user selection
      // (carries, and outranks env — the boot chain's selection > env).
      ...(wire !== undefined ? { wire } : {}),
      // The reasoning matrix is re-derived from the TARGET profile (the
      // current provider's format/map would shape the wrong request fields).
      reasoningFormat: profile.reasoningFormat,
      ...(profile.thinkingLevelMap !== undefined ? { thinkingLevelMap: profile.thinkingLevelMap } : {}),
      supportsReasoningEffort: profile.supportsReasoningEffort ?? supportsReasoningEffort(baseURL),
      acceptsReasoningOnlyFinish: profile.acceptsReasoningOnlyFinish ?? false,
      // 夜移 022: the tool-turn omission fact is re-derived from the TARGET
      // profile — carried stale, a glm-era `true` would wrongly suppress the
      // missing-reasoning repair on deepseek (explicit beats profile).
      omitsReasoningOnToolTurns: profile.omitsReasoningOnToolTurns ?? false,
    },
    ...(borrowedKeyPool ? { borrowedKeyPool: true } : {}),
  };
}

/** 0.3.32c kimi-401: does the live config's key pool NOT contain the
 *  CURRENT provider's freshly-read credentials-file key? True means the
 *  file is newer than the pool by construction (the settings page just
 *  saved it): a same-name /provider re-resolve picks it up (the
 *  fileKeyPreferred leg above) and the driver's same-name carve-out treats
 *  the switch as real. False for an empty pool (the placeholder path
 *  resolves env-first, as at boot) and when the file key is already one of
 *  the pool (rotation order preserved). */
export function keyRefreshPending(
  current: Pick<ProviderConfig, "apiKey" | "apiKeys" | "provider">,
  credentials: Readonly<Record<string, string>>,
): boolean {
  if (current.provider === undefined) return false;
  const pool = [...(current.apiKeys ?? [current.apiKey])].filter((k) => k !== "" && k !== WIZARD_PLACEHOLDER_KEY);
  const fileKey = (credentials[current.provider] ?? "").trim();
  return fileKey !== "" && pool.length > 0 && !pool.includes(fileKey);
}

/** 2026-08-31 config-drift: would a fresh resolve of the live provider change
 *  a CONNECTION-relevant field (endpoint or wire)? The settings row save
 *  lane (settingsSaveProvider — baseUrl/models in the registry overlay)
 *  rewrote the row; without a pending check the running session keeps the
 *  endpoint it last resolved until a manual re-switch or restart. `fresh` is
 *  what the seam's resolve returns for the SAME provider right now; absent
 *  (the resolve refused) means no refresh fires — the manual /provider would
 *  surface the error with its fix. Key drift is a SEPARATE leg
 *  (keyRefreshPending): the two compare different fields and a save may trip
 *  either or both. */
export function configRefreshPending(
  current: Pick<ProviderConfig, "baseURL" | "wire">,
  fresh: Pick<ProviderConfig, "baseURL" | "wire"> | undefined,
): boolean {
  if (fresh === undefined) return false;
  return fresh.baseURL !== current.baseURL || fresh.wire !== current.wire;
}

/** 0.3.32c kimi-401: the borrow receipt — a cross-provider switch that
 *  found no key of its own rode the session's existing pool across the
 *  endpoint change. Every landing surface (the driver's switch notice, the
 *  REPL's receipt) appends it, naming the immediate fix: save the target's
 *  key in settings — the 0.3.32c hot-refresh applies it without a restart. */
export function borrowedKeyPoolNote(provider: string): string {
  return `\n  ⚠️ 没有 ${provider} 的独立密钥——沿用当前会话的密钥池；若新端点报 401，在「设置」保存 ${provider} 的 Key（保存后立即生效，无需重启）`;
}

/** Sync a mutable live config to the switched config IN PLACE (field-by-field
 *  assignment including optional-field REMOVAL — a stale glm thinkingLevelMap
 *  on a deepseek config would shape wrong request bytes). Used by the
 *  frontends' build seams so per-request config readers (cost rows, /status)
 *  follow the switch without a closure going stale. */
export function applyProviderConfig(target: MutableProviderConfig, next: ProviderConfig): void {
  target.apiKey = next.apiKey;
  target.apiKeys = next.apiKeys !== undefined ? [...next.apiKeys] : undefined;
  target.baseURL = next.baseURL;
  target.model = next.model;
  target.provider = next.provider;
  target.reasoningEffort = next.reasoningEffort;
  target.reasoningFormat = next.reasoningFormat;
  target.thinkingLevelMap = next.thinkingLevelMap;
  target.supportsReasoningEffort = next.supportsReasoningEffort;
  target.maxTokens = next.maxTokens;
  target.reasoningReplay = next.reasoningReplay;
  target.acceptsReasoningOnlyFinish = next.acceptsReasoningOnlyFinish;
  target.omitsReasoningOnToolTurns = next.omitsReasoningOnToolTurns; // 夜移 022: omission fact follows the switch
  target.windowMode = next.windowMode; // ω-2b: the profile's window semantics follow the switch
  target.wire = next.wire; // Phase B: the protocol follows the switch (orthogonal — carried, never vendor-derived)
  target.fallbackModels = undefined; // provider-bound chain — see resolveProviderSwitch
}

/** Append the provider_change entry to the session JSONL (append-only; the
 *  entry marks WHERE in the history the endpoint changed). */
export async function recordProviderChange(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly to: ProviderName;
  readonly model: string;
  readonly from?: string;
  readonly now?: Date;
}): Promise<void> {
  const store = createJsonlSessionStore(join(args.workspaceRoot, ".wudao", "sessions"));
  const entry: ProviderChangeEntry = {
    type: "provider_change",
    provider: args.to,
    model: args.model,
    ...(args.from !== undefined && args.from !== "" ? { from: args.from } : {}),
    at: (args.now ?? new Date()).toISOString(),
  };
  await store.appendEntry(args.sessionId, entry);
}

// ---------------------------------------------------------------------------
// The bare /provider listing — one row per profile with a status dot.
// ---------------------------------------------------------------------------

export type ProviderDot = "configured" | "missing-key" | "needs-endpoint" | "needs-model" | "unknown";

export interface ProviderRow {
  readonly name: ProviderName;
  /** The model a switch would land on (the matrix entry for this provider). */
  readonly model: string;
  readonly dot: ProviderDot;
  /** The not-configured reason (absent when configured). */
  readonly detail?: string;
}

/** The status of every profile: would a switch to it resolve RIGHT NOW? The
 *  resolver is the same one a switch would use — the frontend's seam when it
 *  exists (its `current` config is the key-pool truth), the module's own
 *  env-only resolution otherwise — so the dots can never disagree with what
 *  `/provider <name>` would actually do. Provider management: the rows come
 *  from the effective view — builtins first, then registry customs. */
export function providerRows(
  env: NodeJS.ProcessEnv,
  resolve: (name: string) => ProviderSwitchResult,
): readonly ProviderRow[] {
  return [...loadEffectiveProfiles().keys()].map((name) => {
    const r = resolve(name);
    if (r.ok) return { name, model: r.config.model, dot: "configured" as const };
    return { name, model: switchTargetModel(name, env), dot: r.reason, detail: r.error };
  });
}

/** The env-only resolver (no live config): what a frontend without a session
 *  provider (or a scripted-model test) would answer. */
export function envOnlyProviderResolver(env: NodeJS.ProcessEnv): (name: string) => ProviderSwitchResult {
  const empty = { apiKey: "", apiKeys: undefined, reasoningEffort: undefined, reasoningReplay: undefined, provider: undefined, wire: undefined } as const;
  return (name) => resolveProviderSwitch({ target: name, env, current: empty });
}

const DOT: Readonly<Record<ProviderDot, string>> = {
  "configured": "●",
  "missing-key": "○",
  "needs-endpoint": "○",
  "needs-model": "○",
  "unknown": "○",
};

/** Bare /provider: the profile matrix with status dots, the current provider
 *  marked, and the cache-cost warning that distinguishes this switch from a
 *  model switch (a new endpoint re-processes the WHOLE session history). */
export function formatProviderList(rows: readonly ProviderRow[], current: string | undefined): string {
  const lines = [`供应商（profile 矩阵；/provider <名称> 在下一轮边界切换）：`]; // ω99-200: #2；ω99-311: 称谓产品级统一（随 web 310）
  for (const [i, r] of rows.entries()) {
    const isCurrent = current !== undefined && current !== "" && current === r.name;
    const detail = r.detail !== undefined ? `  (${r.detail})` : "";
    lines.push(
      `  ${i + 1}. ${DOT[r.dot]} ${r.name} · ${r.model}${isCurrent ? "  ← current" : ""}${detail}`,
    );
  }
  lines.push("  ● ready to switch · ○ not configured (reason inline)");
  lines.push("  switching re-processes this session's ENTIRE history on the new endpoint — colder than a model switch");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The receipts.
// ---------------------------------------------------------------------------

/** M63 §A: the history-notice line after a successful provider switch. A
 *  model switch changes the provider's cache namespace (one prompt re-feed);
 *  a PROVIDER switch is a whole new cache namespace — the next request
 *  re-fees every message this session ever sent. The notice must say it is
 *  colder than a model switch, not reuse that wording. */
export const PROVIDER_SWITCH_CACHE_NOTE =
  "❄️ 切供应商后缓存完全变冷——新端点即新缓存命名空间：下一个请求将重新处理本会话的全部历史（比切模型更冷，后者只对单个提示词重新计费）"; // ω99-166f-ii: #23

/** The turn_usage receipt attribution for the first call on the new endpoint
 *  (rides ModelUsage.cacheBreakAttribution via the cache-tracking wrapper's
 *  coldFirstTurnAttribution — the M58 §A pair, provider-switch flavored). */
export const PROVIDER_SWITCH_COLD_ATTRIBUTION = "provider switched — full history reprocessed";
