import type { ModelChangeEntry, SessionEntry, ThinkingLevelChangeEntry } from "@wudao/core";
import type { ProviderConfig } from "@wudao/providers";
import { resolveProviderConfigResult, NO_KEY_REASON } from "@wudao/providers";
import { modelLabel } from "./log.js";
// M63 §B: the credentials-file fallback (env wins — see @wudao/providers
// config.ts). The sync read keeps buildRunPlan synchronous; the home comes
// from the PROCESS env so tests isolate via WUDAO_GLOBAL_HOME exactly like
// every other global-tier reader.
import { readCredentialsFileSync, WIZARD_PLACEHOLDER_KEY } from "./credentials.js";
// Provider management §4: the boot resolves against the effective view
// (builtins ⊕ overlays ⊕ customs) — one memoized registry read per process.
import { loadEffectiveProfiles } from "./provider-registry.js";
// M63 §C: the `wudao ui` boot plan rides the SAME matrix the settings page
// renders (readiness join over the provider cards).
import { buildProviderMatrix } from "./driver/settings-ops.js";
import { readProviderEffortBinding } from "./driver/provider-registry-ops.js";
import { foldEffortChain } from "./commands/model.js";

export type RunPlan =
  | { kind: "no-key"; prompt: string; reason?: string }
  | { kind: "real"; prompt: string; config: ProviderConfig };

export interface BuildRunPlanInput {
  readonly prompt: string;
  readonly env?: NodeJS.ProcessEnv;
  /** `--provider` flag value; beats WUDAO_PROVIDER. */
  readonly provider?: string;
  /** `--reasoning-effort` flag value; beats WUDAO_REASONING_EFFORT. */
  readonly reasoningEffort?: string;
  /** R3-T002 深测弧：`--model` 旗标值；最高优先——越过 env 钉
   *  （WUDAO_MODEL/OPENAI_MODEL，含 .env 自动加载）与 profile 缺省。 */
  readonly model?: string;
  /** M63 §B: explicit credentials map (test seam). Absent → the credentials
   *  file under the process's WUDAO_GLOBAL_HOME is read as the fallback. */
  readonly credentials?: Readonly<Record<string, string>>;
  /** R6 quickwin: the Ctrl+S-persisted pick defaults (settings-ops'
   *  readStoredModelDefaults over the global tier — index.ts reads them so
   *  this builder stays pure/deterministic). The UI boot applies them when
   *  no explicit flag/env pins the field; a provider mismatch (the stored
   *  default came from another provider's row) leaves the model alone. */
  readonly storedModelDefaults?: import("./driver/settings-ops.js").StoredModelDefaults;
}

export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  // R3-T002 续（默认 provider 键）：无显式选择（旗标/env 都缺）时，设置
  // 存的默认 pick 连 provider 一起生效——「设为默认」此前只补模型（boot
  // provider 匹配才应用），provider 恒落 deepseek 缺省。优先序保持：
  // --provider > WUDAO_PROVIDER > 设置默认 > deepseek profile。
  const env = input.env ?? process.env;
  const defaultProvider =
    input.provider === undefined && (env.WUDAO_PROVIDER ?? "") === "" && input.storedModelDefaults?.model !== undefined
      ? input.storedModelDefaults.model.provider
      : undefined;
  const selection = {
    provider: input.provider ?? defaultProvider,
    reasoningEffort: input.reasoningEffort,
    ...(input.model !== undefined && input.model !== "" ? { model: input.model } : {}),
  };
  // Provider management: the effective view joins resolution — a registry
  // custom boot-configures from its own entry, an overlay rides the builtin.
  const profiles = loadEffectiveProfiles();
  let r = resolveProviderConfigResult(input.env, selection, undefined, profiles);
  if (!r.ok && r.reason === NO_KEY_REASON) {
    // M63 §B: no env key → try the credentials file for the SELECTED
    // provider (env wins; the file is a fallback only).
    const credentials = input.credentials ?? readCredentialsFileSync({ WUDAO_GLOBAL_HOME: process.env.WUDAO_GLOBAL_HOME });
    if (Object.keys(credentials).length > 0) {
      r = resolveProviderConfigResult(input.env, selection, credentials, profiles);
    }
  }
  if (!r.ok) {
    // The generic no-key failure keeps the existing guidance text; other
    // failures (e.g. wudao without a baseUrl) carry their specific reason.
    return { kind: "no-key", prompt: input.prompt, reason: r.reason === NO_KEY_REASON ? undefined : r.reason };
  }
  return { kind: "real", prompt: input.prompt, config: r.config };
}

// ---------------------------------------------------------------------------
// M63 §C — the `wudao ui` boot plan. The first-run wizard lives INSIDE the
// web UI, so the ui host must reach the browser even with no usable key —
// the readiness join decides which of the three boots happens:
//
//   real    a key resolves (env or the selected provider's file key), or —
//           nobody selected-resolves but SOME provider is ready: boot THAT
//           provider (matrix order; a notice names the substitution). The
//           wizard never shows on a ready surface.
//   wizard  nobody ready anywhere: boot a PLACEHOLDER config (the selected
//           provider's profile with a blank key — same shape a real boot
//           resolves, so a later /provider lands on identical bytes) and
//           let the web wizard take over (skippable = read-only browsing).
//   exit    not even a placeholder resolves (the selected provider is
//           wudao without WUDAO_BASE_URL and nothing else is ready): the
//           old guidance, now pointing at the wizard.
// ---------------------------------------------------------------------------

export type UiBootPlan =
  | { readonly kind: "real"; readonly config: ProviderConfig; readonly notice?: string }
  | { readonly kind: "wizard"; readonly config: ProviderConfig; readonly notice: string }
  | { readonly kind: "exit"; readonly message: string };

/** The wizard boot's stand-in key — the shared constant lives in
 *  credentials.ts (a leaf module) with its absent-everywhere contract. */

/** The selected provider for the boot plan (mirrors the resolver's rule:
 *  the --provider flag beats WUDAO_PROVIDER beats the stored pick default
 *  (R3-T002 续) beats deepseek). Takes the already-resolved env —
 *  `input.env` is undefined in production (index.ts omits it), so reading it
 *  here would miss WUDAO_PROVIDER in process.env.
 *  Provider management: any id in the effective view is selectable — a
 *  registry custom boots exactly like a builtin; everything else lands on
 *  the deepseek default. */
function bootSelectedProvider(input: BuildRunPlanInput, env: NodeJS.ProcessEnv): string {
  const fromSettings = (env.WUDAO_PROVIDER ?? "") === "" && input.storedModelDefaults?.model !== undefined
    ? input.storedModelDefaults.model.provider
    : undefined;
  const raw = (input.provider ?? env.WUDAO_PROVIDER ?? fromSettings ?? "").trim();
  return loadEffectiveProfiles().has(raw) ? raw : "deepseek";
}

export function buildUiBootPlan(input: BuildRunPlanInput): UiBootPlan {
  const env = input.env ?? process.env;
  // R6 quickwin: the Ctrl+S pick defaults fold into every config this boot
  // resolves (real / ready-substitution / wizard placeholder — the last one
  // because a later keyed boot of the same shape applies them too, keeping
  // the placeholder byte-identical to it). Pure: index.ts supplies the
  // already-read defaults; explicit flags/env always win.
  const applyDefaults = (config: ProviderConfig): ProviderConfig => applyStoredModelDefaults(config, env, input);
  const plan = buildRunPlan(input);
  if (plan.kind === "real") return { kind: "real", config: applyDefaults(plan.config) };

  // Nobody selected-resolves. Readiness join over the full matrix FIRST: a
  // ready provider anywhere boots for real (the wizard is skipped whole).
  const credentials = input.credentials ?? readCredentialsFileSync(env);
  const selected = bootSelectedProvider(input, env);
  const profiles = loadEffectiveProfiles();
  const matrix = buildProviderMatrix(env, credentials);
  const ready = matrix.find((c) => c.status === "ready" && c.provider === selected)
    ?? matrix.find((c) => c.status === "ready");
  if (ready !== undefined) {
    const r = resolveProviderConfigResult(env, { provider: ready.provider, reasoningEffort: input.reasoningEffort }, credentials, profiles);
    if (r.ok) {
      return {
        kind: "real",
        config: applyDefaults(r.config),
        notice: `no key for the selected provider (${selected}) — booting ${ready.provider} (key from the credentials file)`,
      };
    }
  }

  // Nobody ready: the wizard boot. The placeholder config is the resolver's
  // own output for the selected provider with a GHOST key, stand-in keyed —
  // every field (model, effort, reasoning matrix, endpoint) is then
  // byte-identical to what a keyed boot would produce, and the wizard's
  // later /provider rebuild replaces the whole config anyway.
  // R-M2: a selection-time THROW (a model-less registry custom) also lands
  // here as the exit plan — the boot never crashes on a registry mistake.
  let ghost: ReturnType<typeof resolveProviderConfigResult>;
  try {
    ghost = resolveProviderConfigResult(env, { provider: selected, reasoningEffort: input.reasoningEffort }, { [selected]: WIZARD_PLACEHOLDER_KEY }, profiles);
  } catch (err) {
    return {
      kind: "exit",
      message: `${err instanceof Error ? err.message : String(err)} Run "wudao ui --provider deepseek" (or fix the entry in ~/.wudao/providers.json) — the first-run wizard (新手向导) then walks you through saving a key.`,
    };
  }
  if (!ghost.ok) {
    // A structural refusal (e.g. wudao without WUDAO_BASE_URL) beats the
    // generic no-key line — name the actual fix.
    const reason = ghost.reason === NO_KEY_REASON ? (plan.reason ?? "No API key found.") : ghost.reason;
    return {
      kind: "exit",
      message: `${reason} Run "wudao ui --provider deepseek" (or set WUDAO_BASE_URL) — the first-run wizard (新手向导) then walks you through saving a key.`,
    };
  }
  return {
    kind: "wizard",
    config: { ...applyDefaults(ghost.config), apiKey: WIZARD_PLACEHOLDER_KEY, apiKeys: undefined },
    notice: `No API key found — the browser opens the first-run wizard (新手向导); skipping it enters read-only browsing (设置 always re-opens it).`,
  };
}

/** R6 quickwin — fold the stored pick defaults into a resolved config.
 *  Precedence per field: explicit env (WUDAO_MODEL/OPENAI_MODEL,
 *  WUDAO_REASONING_EFFORT) and the --reasoning-effort flag beat the stored
 *  value; the stored model additionally requires its provider to match the
 *  resolved provider. The resolver leaves reasoningEffort undefined exactly
 *  when no flag/env named one, so `undefined` is the "not pinned" signal. */
function applyStoredModelDefaults(
  config: ProviderConfig,
  env: NodeJS.ProcessEnv,
  input: BuildRunPlanInput,
): ProviderConfig {
  const d = input.storedModelDefaults;
  let out = config;
  if (d !== undefined &&
    d.model !== undefined &&
    d.model.provider === out.provider &&
    (env.WUDAO_MODEL ?? env.OPENAI_MODEL) === undefined &&
    input.model === undefined // R3-T002: 显式 --model 旗标也钉住此腿（旗标 > 存储缺省）
  ) {
    out = { ...out, model: d.model.model };
  }
  // 推理档三级配置 S2 (spec 2026-08-28 §1) — the effort leg is now the chain
  // fold: the boot provider's registry binding ?? the stored global, under
  // the same "not pinned" guard (a set reasoningEffort came from flag/env).
  // Runs even with NO stored defaults input — the binding is provider data,
  // not a ui preference, so a repl/tui boot honors it too (the global tier
  // stays ui-boot-scoped, exactly as the r6 quickwin shipped it).
  if (out.reasoningEffort === undefined) {
    const folded = foldEffortChain(undefined, readProviderEffortBinding(out.provider ?? "", env), d?.effort);
    if (folded !== undefined) out = { ...out, reasoningEffort: folded };
  }
  return out;
}

/** M25 §A3: the one-shot resume banner — printed after session resolution when
 *  the loaded history is non-empty. One line; the transcript is not replayed.
 *  M28: when the session carries model-state entries the line names the last
 *  model + effort instead of the message count (legacy sessions without
 *  entries keep the old shape). */
export function formatOneShotResumeLine(
  sessionId: string,
  messageCount: number,
  last?: LastModelState,
): string {
  if (last !== undefined && last.model !== undefined) {
    const label = modelLabel({ model: last.model, ...(last.provider !== undefined ? { provider: last.provider } : {}) });
    return `已恢复 ${sessionId} · 上次模型：${label}（推理档 ${last.effort ?? "off"}）`; // ω99-172: #6
  }
  return `已恢复 ${sessionId}（${messageCount} 条消息）`; // ω99-172: #7
}

// ---------------------------------------------------------------------------
// M28: model-state entries. The session file IS the record of which
// model/effort produced the transcript — derived from entries, never a side
// channel, so forks inherit it by copying the history.
// ---------------------------------------------------------------------------

/** The last recorded model + thinking level for a session (absent = none). */
export interface LastModelState {
  readonly model?: string;
  readonly provider?: string;
  /** Last recorded thinking level; "off" marks an explicit off transition. */
  readonly effort?: string;
}

/** Fold session entries into the last recorded model state. */
export function lastModelState(entries: readonly SessionEntry[]): LastModelState {
  let model: string | undefined;
  let provider: string | undefined;
  let effort: string | undefined;
  for (const e of entries) {
    if ("role" in e) continue; // messages carry no model state
    // M35 §2: generic {type, data} entries share the union — narrow by the
    // typed entry's own fields, not by type alone.
    if (e.type === "model_change" && "model" in e) {
      model = e.model;
      provider = e.provider;
    } else if (e.type === "provider_change" && "model" in e) {
      // M63 §A review: a provider switch IS a model-state transition — the
      // entry carries both sides (model + provider). Without this fold a
      // session whose last switch was /provider would resume with the
      // PRE-switch state, and the next boundary's divergence check would
      // write a spurious model_change for a switch that never happened.
      model = e.model;
      provider = e.provider;
    } else if (e.type === "thinking_level_change" && "level" in e) {
      effort = e.level;
    }
  }
  if (model === undefined && effort === undefined) return {};
  return { ...(model !== undefined ? { model, ...(provider !== undefined ? { provider } : {}) } : {}), ...(effort !== undefined ? { effort } : {}) };
}

/** The current run's model state, as the resolved provider config sees it. */
export interface CurrentModelState {
  readonly provider?: string;
  readonly model: string;
  readonly reasoningEffort?: string;
}

/** Entries to record when this run diverges from the last recorded state —
 *  appended BEFORE this run's messages, so the entry marks where the switch
 *  happened in the history. Empty result = nothing changed. */
export function modelStateDivergence(
  current: CurrentModelState,
  last: LastModelState,
  now: Date = new Date(),
): { modelChange?: ModelChangeEntry; effortChange?: ThinkingLevelChangeEntry } {
  const out: { modelChange?: ModelChangeEntry; effortChange?: ThinkingLevelChangeEntry } = {};
  const modelChanged =
    last.model === undefined
    || last.model !== current.model
    || last.provider !== current.provider;
  if (modelChanged) {
    out.modelChange = {
      type: "model_change",
      model: current.model,
      ...(current.provider !== undefined ? { provider: current.provider } : {}),
      at: now.toISOString(),
    };
  }
  const effortCur = current.reasoningEffort ?? "off";
  const effortLast = last.effort ?? "off";
  if (effortCur !== effortLast) {
    out.effortChange = { type: "thinking_level_change", level: effortCur };
  }
  return out;
}

/** Append the divergence entries for a run (fresh sessions record their
 *  initial model; resumed sessions record only what changed). Called before
 *  the loop starts, hence before any of this run's messages land. */
export async function recordModelState(
  store: { appendEntry(sessionId: string, entry: SessionEntry): Promise<void> },
  sessionId: string,
  config: ProviderConfig,
  last: LastModelState,
): Promise<void> {
  const div = modelStateDivergence(
    { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort },
    last,
  );
  if (div.modelChange !== undefined) await store.appendEntry(sessionId, div.modelChange);
  if (div.effortChange !== undefined) await store.appendEntry(sessionId, div.effortChange);
}
