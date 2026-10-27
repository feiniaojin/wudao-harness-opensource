// M56 §5 — route preflight (a reference harness crates/workflow/fleet_preflight.rs).
// Everything that must be true for a spawn/step is frozen and checked WHERE
// THE RUN IS ADMITTED, not discovered at the first API call:
//   provider configured  the provider profile resolves (name, baseUrl);
//   key present          the key POOL is non-empty, or the selected
//                        provider's credentials-file entry (M63 §B review
//                        R1) — decided locally from configuration, no live
//                        probe ("a preflight that hits the network would
//                        spend money and leak the fact of the run before the
//                        operator's gates have even been evaluated");
//   model in profile     the model is one the provider's switchable set
//                        actually contains (profile defaults + the env
//                        override — exactly what resolveProviderConfig would
//                        pick from, so admission never contradicts routing);
//   budget remaining     the shared budget has tokens left BEFORE any spend.
// All pure values: env + numbers + the credentials file in, refusals out.
// Failures refuse fast with clear reasons; the engine turns a refusal into
// a preflight-refused task failure with ZERO model calls.
import { parseApiKeyPool, resolveProviderConfigResult } from "@wudao/providers";
import type { EffectiveProfile, ProviderSelection } from "@wudao/providers";
import { availableModels } from "../commands/model.js";
// Review R1 (M63 §B): the credentials-file fallback — admission must pass
// for file-only-key users exactly like routing does.
import { readCredentialsFileSync } from "../credentials.js";
import { envSelectedProvider } from "../driver/settings-ops.js";

export type PreflightCheckId = "provider" | "key" | "model" | "budget";

export interface RoutePreflightCheck {
  readonly id: PreflightCheckId;
  readonly ok: boolean;
  readonly detail: string;
}

export interface RoutePreflightResult {
  readonly ok: boolean;
  /** One clear reason per failing check (empty = admitted). */
  readonly refusals: readonly string[];
  readonly checks: readonly RoutePreflightCheck[];
  /** The canonical wire model the spawn must use (resolved, not the file's
   *  spelling) — undefined when the route itself did not resolve. */
  readonly model: string | undefined;
  readonly provider: string | undefined;
}

export interface RoutePreflightInput {
  readonly env?: NodeJS.ProcessEnv;
  /** Explicit provider selection (CLI flags), like resolveProviderConfig. */
  readonly selection?: ProviderSelection;
  /** The model the spawn would use; default = the resolved config's model. */
  readonly model?: string;
  /** M62 §7: the ordered fallbackModel chain from settings — an unlisted
   *  primary with a switchable fallback still routes. */
  readonly fallbackModels?: readonly string[];
  /** Budget tokens remaining right now (admission-time snapshot). */
  readonly budgetRemaining: number;
  /** Budget total (display only in the refusal reason). */
  readonly budgetTotal?: number;
  /** Provider management (T5 / R-W1): the registry's effective view, threaded
   *  by the workflow path so the provider check resolves a registry custom
   *  exactly as the run's own resolution did (the run.ts threading). Absent =
   *  builtin-only, byte-identical historical behavior. */
  readonly providers?: ReadonlyMap<string, EffectiveProfile>;
}

/** Check a route at admission. Local-only: env + numbers, no clock/fs/network. */
export function routePreflight(input: RoutePreflightInput): RoutePreflightResult {
  const env = input.env ?? process.env;
  const checks: RoutePreflightCheck[] = [];

  // Review R1 (M63 §B): the credentials file joins resolution as the
  // fallback key source (env still wins) — one read, both key checks.
  const credentials = readCredentialsFileSync(env);

  // 1) provider configured (unknown names/baseUrl gaps refuse, never throw).
  let model: string | undefined;
  let provider: string | undefined;
  let resolvedOk = false;
  try {
    // R3-T002：目录哨兵在此豁免——本函数自己的 model 检查 + fallback 链是
    // 更细的守门（不可用主模型→拒绝或走链路由，M62 fix M2 语义），解析层
    // 的哨兵若先抛会抢走链路由的机会。
    const resolved = resolveProviderConfigResult(env, { ...(input.selection ?? {}), allowEnvModelMismatch: true }, credentials, input.providers);
    if (resolved.ok) {
      resolvedOk = true;
      model = input.model ?? resolved.config.model;
      provider = resolved.config.provider;
      checks.push({ id: "provider", ok: true, detail: `${provider} · ${resolved.config.baseURL}` });
    } else {
      checks.push({ id: "provider", ok: false, detail: resolved.reason });
    }
  } catch (err) {
    checks.push({ id: "provider", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  // 2) key present (the env POOL, or the selected provider's credentials-file
  //    entry — the same source resolution just used, so admission never
  //    contradicts routing for a file-only-key user).
  const pool = parseApiKeyPool(env);
  const fileKey = (credentials[envSelectedProvider(env)] ?? "").trim() !== "";
  checks.push({
    id: "key",
    ok: pool.length > 0 || fileKey,
    detail: pool.length > 0
      ? `${pool.length} key(s) in the pool`
      : fileKey
        ? "key: credentials file"
        : "no API key present (WUDAO_API_KEY / WUDAO_API_KEYS, or ~/.wudao/.credentials.yaml)",
  });

  // 3) model in profile: only decidable when the route resolved.
  //    M62 §7 (route preflight × fallbackModel): an unlisted primary is no
  //    longer an automatic refusal when the configured fallback chain
  //    contains at least one switchable model — the run CAN route (it will
  //    fail over on the first model-class error). Refusal only when neither
  //    the primary nor any fallback is in the profile set.
  if (resolvedOk && model !== undefined && provider !== undefined) {
    const switchable = availableModels(env).filter((c) => c.provider === provider);
    const known = switchable.some((c) => c.model === model);
    if (known) {
      checks.push({ id: "model", ok: true, detail: `${model} is in the ${provider} profile set` });
    } else {
      const fallbackOk = (input.fallbackModels ?? []).find((m) => switchable.some((c) => c.model === m));
      checks.push({
        id: "model",
        ok: fallbackOk !== undefined,
        detail: fallbackOk !== undefined
          ? `model "${model}" is not in the ${provider} profile set, but the fallback chain routes via "${fallbackOk}"`
          : `model "${model}" is not in the ${provider} profile set (switchable: ${switchable.map((c) => c.model).join(", ")})`,
      });
    }
  } else {
    checks.push({ id: "model", ok: true, detail: "not evaluated (provider unresolved)" });
  }

  // 4) budget remaining.
  checks.push({
    id: "budget",
    ok: input.budgetRemaining > 0,
    detail: input.budgetRemaining > 0
      ? `${input.budgetRemaining} tokens remaining`
      : `budget exhausted (${input.budgetRemaining} of ${input.budgetTotal ?? "?"} tokens remaining) — refusing before any spend`,
  });

  const refusals = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  return { ok: refusals.length === 0, refusals, checks, model, provider };
}
