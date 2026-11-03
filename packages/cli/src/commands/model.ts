// M55 §B7 — /model + /effort: the mid-session switch. The MODEL LIST comes
// from the provider profile matrix (each profile's default model) plus the
// env override (WUDAO_MODEL/OPENAI_MODEL) — exactly what resolveProviderConfig
// would pick from, so the menu never advertises an unresolvable model. A
// switch writes the M28 session entries (model_change / thinking_level_change
// — the JSONL IS the record of which model produced the transcript) and hands
// the selection to the frontend through the onModelSwitch seam: the provider
// reads its config FIELDS at request time, so mutating the live config object
// switches the NEXT request without rebuilding the client (identity-stable —
// cache stats and every tool closure over the model stay valid).
import { join } from "node:path";
import { REASONING_EFFORTS, isBuiltinProviderName } from "@wudao-org/providers";
import type { ProviderConfig, ProviderName, ReasoningEffort } from "@wudao-org/providers";
import { createJsonlSessionStore } from "@wudao-org/core";
import type { ModelChangeEntry, SessionEntry, ThinkingLevelChangeEntry } from "@wudao-org/core";
import { loadEffectiveProfiles } from "../provider-registry.js";

/** One selectable model: the profile it belongs to and where it came from. */
export interface ModelChoice {
  readonly provider: ProviderName;
  readonly model: string;
  readonly source: "profile" | "env" | "registry";
  /** Provider management §7: the model's registered context window (when the
   *  registry catalogs one) — the /models listing shows it and the window
   *  chain threads it into every build point. */
  readonly contextLength?: number;
}

/** The switchable set: the effective profile view's defaults (builtins first,
 *  then registry customs) + every registered per-model catalog entry + the
 *  env override (WUDAO_MODEL / OPENAI_MODEL). The env entry rides the
 *  WUDAO_PROVIDER owner — builtin or registry custom, or the default profile
 *  when unset/unregistered, the same rule resolveProviderConfig applies — so
 *  dedup by provider+model keeps the list clean. Invalid registry entries
 *  never reach the view (fail-visible ≠ selectable). */
export function availableModels(env: NodeJS.ProcessEnv = process.env): readonly ModelChoice[] {
  const profiles = loadEffectiveProfiles();
  const out: ModelChoice[] = [];
  const seen = new Set<string>();
  const push = (
    provider: string,
    model: string,
    source: ModelChoice["source"],
    profile: {
      readonly models: readonly { readonly name: string; readonly contextLength?: number }[];
      readonly defaultContextLength?: number;
    },
  ): void => {
    const key = `${provider}/${model}`;
    if (model === "" || seen.has(key)) return;
    seen.add(key);
    // T4b (T5-review M1): the per-model catalog entry first, then the
    // provider-level default — an uncataloged model on a provider with a
    // registered defaultContextLength still gets its window (the picker's
    // placeholder otherwise under-reports the session window).
    const contextLength = profile.models.find((m) => m.name === model)?.contextLength ?? profile.defaultContextLength;
    out.push({ provider, model, source, ...(contextLength !== undefined ? { contextLength } : {}) });
  };
  // Map order = builtins (compiled-in order) then registry customs — the same
  // order the /provider listing and the settings matrix render.
  for (const [id, profile] of profiles) {
    push(id, profile.defaultModel, isBuiltinProviderName(id) ? "profile" : "registry", profile);
    for (const m of profile.models) push(id, m.name, "registry", profile);
  }
  const envModel = (env.WUDAO_MODEL ?? env.OPENAI_MODEL ?? "").trim();
  if (envModel !== "") {
    const raw = (env.WUDAO_PROVIDER ?? "").trim();
    const provider: ProviderName = raw !== "" && profiles.has(raw) ? raw : "deepseek";
    const key = `${provider}/${envModel}`;
    if (!seen.has(key)) {
      out.push({ provider, model: envModel, source: "env" });
      seen.add(key);
    }
  }
  return out;
}

export type ModelValidation =
  | { readonly ok: true; readonly choice: ModelChoice }
  | { readonly ok: false; readonly error: string };

/** The switchable subset for one provider: a mid-session switch keeps the
 *  endpoint (baseURL + API key are provider-bound — swapping them without
 *  the matching key would just break the next request), so only models of
 *  the CURRENT provider switch in-session; everything else needs a restart
 *  with --provider / WUDAO_PROVIDER. */
export function sameProviderModels(list: readonly ModelChoice[], provider: string | undefined): readonly ModelChoice[] {
  if (provider === undefined || provider === "") return list;
  return list.filter((c) => c.provider === provider);
}

/** Validate a user-supplied model name against the switchable set. Accepts
 *  the bare model id or a `provider/model` qualified form. */
export function validateModelChoice(list: readonly ModelChoice[], raw: string): ModelValidation {
  const name = raw.trim();
  if (name === "") return { ok: false, error: "用法：/model [name]——裸命令列出可切换的模型" }; // ω99-166d-i: #27
  const slash = name.indexOf("/");
  const candidates = slash === -1
    ? list.filter((c) => c.model === name)
    : list.filter((c) => `${c.provider}/${c.model}` === name);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: `unknown or cross-provider model "${name}" — switchable in-session: ${list.map((c) => c.model).join(", ")} (other providers switch with /provider <name> — the endpoint changes, so the cache goes fully cold)`,
    };
  }
  // Same model under several providers: a qualified form disambiguates; the
  // bare form takes the first (profile order).
  for (const c of candidates) return { ok: true, choice: c };
  return { ok: false, error: "unreachable" };
}

/** M57 §2 — one step resolution for a /model argument: a NAME (validated
 *  against the current provider's switchable subset, as before) or a NUMBER
 *  — the 1-based ordinal of the FULL list the bare /model listing prints
 *  (same order), so "the 2nd line on screen" is /model 2. A numeric pick of
 *  a FOREIGN-provider entry explains the restart requirement instead of
 *  silently failing. */
export function resolveModelArgument(
  list: readonly ModelChoice[],
  raw: string,
  current: { readonly provider?: string },
): ModelValidation {
  const name = raw.trim();
  if (name === "") return { ok: false, error: "用法：/model [name|number]——裸命令列出可切换的模型" }; // ω99-166d-i: #28
  if (/^\d+$/.test(name)) {
    const ordinal = Number(name);
    const entry = list[ordinal - 1];
    if (entry === undefined) {
      return { ok: false, error: `/model ${name}: no entry ${ordinal} — the list has ${list.length} (bare /model prints them)` };
    }
    if (current.provider !== undefined && current.provider !== "" && current.provider !== entry.provider) {
      return {
        ok: false,
        error: `/model ${name} is ${entry.provider}/${entry.model} — cross-provider switches go through /provider ${entry.provider} (the endpoint changes; the switch lands at the next turn boundary)`,
      };
    }
    return { ok: true, choice: entry };
  }
  return validateModelChoice(sameProviderModels(list, current.provider), name);
}

/** M57 §2 — /effort accepts a NUMBER too: the 1-based ordinal over the
 *  matrix levels in printed order. */
export function resolveEffortArgument(raw: string): EffortValidation {
  const name = raw.trim();
  if (/^\d+$/.test(name)) {
    const ordinal = Number(name);
    const level = REASONING_EFFORTS[ordinal - 1];
    if (level === undefined) {
      return { ok: false, error: `/effort ${name}: no level ${ordinal} — levels: ${REASONING_EFFORTS.join(" | ")}` };
    }
    return { ok: true, level };
  }
  return validateEffort(name);
}

export type EffortValidation =
  | { readonly ok: true; readonly level: ReasoningEffort }
  | { readonly ok: false; readonly error: string };

/** Validate a reasoning-effort level against the matrix enum (exact, like
 *  parseReasoningEffort — the request field is case-sensitive). */
export function validateEffort(raw: string): EffortValidation {
  const level = raw.trim();
  if ((REASONING_EFFORTS as readonly string[]).includes(level)) {
    return { ok: true, level: level as ReasoningEffort };
  }
  return { ok: false, error: `unknown effort "${level}" — levels: ${REASONING_EFFORTS.join(" | ")} (none disables reasoning)` };
}

/** A switch the frontend must apply to its live provider config. */
export interface ModelSelection {
  readonly model?: string;
  readonly provider?: ProviderName;
  readonly effort?: ReasoningEffort;
}

/** The config the provider closes over, minus the readonly modifiers. The
 *  provider reads its FIELDS at request time, so field mutation is the
 *  switch — one client identity, next-turn effect, no closure goes stale. */
export type MutableProviderConfig = { -readonly [K in keyof ProviderConfig]: ProviderConfig[K] };

export function asMutableConfig(config: ProviderConfig): MutableProviderConfig {
  return { ...config };
}

/** Apply a selection to the live config object (mutates in place). */
export function applyModelSelection(config: MutableProviderConfig, sel: ModelSelection): void {
  if (sel.model !== undefined) config.model = sel.model;
  if (sel.provider !== undefined) config.provider = sel.provider;
  if (sel.effort !== undefined) config.reasoningEffort = sel.effort;
}

/** The M28 entries for a switch, in record order (model first, then effort —
 *  the same order modelStateDivergence emits at run boundaries). */
export function modelSwitchEntries(sel: ModelSelection, now: Date = new Date()): readonly SessionEntry[] {
  const out: SessionEntry[] = [];
  if (sel.model !== undefined) {
    const entry: ModelChangeEntry = {
      type: "model_change",
      model: sel.model,
      ...(sel.provider !== undefined ? { provider: sel.provider } : {}),
      at: now.toISOString(),
    };
    out.push(entry);
  }
  if (sel.effort !== undefined) {
    const effort: ThinkingLevelChangeEntry = { type: "thinking_level_change", level: sel.effort };
    out.push(effort);
  }
  return out;
}

/** Append the switch entries to the session JSONL (append-only store; the
 *  entries mark WHERE in the history the switch happened). */
export async function recordModelSwitch(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly selection: ModelSelection;
  readonly now?: Date;
}): Promise<void> {
  const store = createJsonlSessionStore(join(args.workspaceRoot, ".wudao", "sessions"));
  for (const entry of modelSwitchEntries(args.selection, args.now)) {
    await store.appendEntry(args.sessionId, entry);
  }
}

/** M58 §C#13: the cache-cost receipt line appended after a successful MODEL
 *  switch — a different model is a different provider cache namespace, so
 *  the next turn is cold no matter how warm this one was. Effort switches do
 *  NOT carry it: OpenAI-compatible request prefixes don't vary with
 *  reasoning effort, so claiming a cold turn there would be a lie. */
export const MODEL_SWITCH_CACHE_NOTE =
  "❄️ 切模型后下一轮缓存变冷——切模型会更换供应商的缓存命名空间（下一个请求对整个提示词重新计费）"; // ω99-166f-ii: #24

/** Bare /model: the switchable matrix with the current one marked. Foreign-
 *  provider entries point at /provider (M63 §A made the endpoint switch
 *  in-session; the /model lane stays same-provider — a provider switch swaps
 *  baseURL + matrix, not just the model name).
 *  M57 §2: entries carry their 1-based ordinal — `/model 2` picks the 2nd
 *  line (the number and the name are the same selection). */
export function formatModelList(list: readonly ModelChoice[], current: { readonly provider?: string; readonly model?: string }): string {
  const lines = ["模型（profile 矩阵 + 注册表 + WUDAO_MODEL；/model <名称|编号> 切换——下一轮生效）："]; // ω99-199: #7
  if (list.length === 0) lines.push("  (none resolved)");
  for (const [i, c] of list.entries()) {
    const isCurrent = current.model === c.model && (current.provider === undefined || current.provider === c.provider);
    const foreign = current.provider !== undefined && current.provider !== "" && current.provider !== c.provider;
    lines.push(
      `  ${i + 1}. ${c.provider}/${c.model}${c.source === "env" ? " (env)" : ""}${isCurrent ? "  ← current" : ""}${foreign ? `  (switch providers with /provider ${c.provider})` : ""}`,
    );
  }
  return lines.join("\n");
}

/** 推理档三级配置 S2 (spec 2026-08-28 §1) — the effort chain fold shared by
 *  the boot and every provider switch: flag/env pin > the registry binding >
 *  the settings global default > the model default (undefined = send
 *  nothing). `binding` is the THREE-STATE registry column: key-absent =
 *  follow the global; a string = the bound level; null = explicit
 *  don't-send — and null BLOCKS the global (a provider that cannot take
 *  reasoning_effort must not inherit one). Pure; the callers own the reads
 *  AND the validation: the pin arrives through the env/flag validation
 *  (validateEffort / the boot resolver), the binding through the registry's
 *  load-time row validation (S1 rejects a non-member effort fail-visibly) —
 *  so the casts below only restate guarantees enforced upstream. */
export function foldEffortChain(
  pinned: string | undefined,
  binding: string | null | undefined,
  globalDefault: ReasoningEffort | undefined,
): ReasoningEffort | undefined {
  if (pinned !== undefined && pinned !== "") return pinned as ReasoningEffort;
  if (binding !== undefined) return (binding ?? undefined) as ReasoningEffort | undefined;
  return globalDefault;
}

/** Bare /effort: the matrix levels with the current one marked (M57 §2:
 *  numbered like /model — `/effort 2` picks the 2nd level). */
export function formatEffortList(current: string | undefined): string {
  const lines = [`推理力度（${REASONING_EFFORTS.join(" | ")}；/effort <级别|编号> 切换——下一轮生效）：`]; // ω99-199: #8
  for (const [i, level] of REASONING_EFFORTS.entries()) {
    lines.push(`  ${i + 1}. ${level}${(current ?? "off") === level ? "  ← current" : ""}`);
  }
  lines.push("  (none disables reasoning; the provider matrix maps each level onto its native field)");
  return lines.join("\n");
}
