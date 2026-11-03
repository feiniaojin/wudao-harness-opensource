// Provider management Task 3 — the cli-side handler behind the three registry
// wire ops (design §5; relayed by @wudao-org/server after the same first-frame
// auth as every op):
//
//   settingsSaveProvider   validateUserProviderEntry → read-modify-write
//                          providers.json (atomic tmp+rename 0600, ONE id
//                          touched — sibling rows preserved verbatim,
//                          INCLUDING invalid ones: fail-visible rows are the
//                          user's data, a save of another provider must not
//                          eat them) → memo invalidation (I2: the SAME
//                          `wudao ui` session's next read sees the write —
//                          no restart, no TTL).
//   settingsDeleteProvider builtin ids refuse (the compiled profile always
//                          exists); customs leave the file + the memo; a
//                          stored model.defaultModel pointing at the deleted
//                          id falls back (the pick is dropped so the boot
//                          resolution owns the default again). Idempotent —
//                          an already-absent row is the goal state.
//   settingsListModels     GET ${endpoint}/models through SettingsOpsDeps'
//                          fetchImpl (a PROBE like testConnection — the
//                          providers package's ModelClient gains no GET
//                          capability): the same key ladder (pasted → env
//                          pool, selected provider only → the credentials
//                          file), the same 10s abort, and the same failure
//                          classification. Parses the OpenAI shape
//                          ({data:[{id}]}) and prefills each model's
//                          contextLength from context_length (the
//                          OpenRouter/models.dev shape) when it is a positive
//                          integer.
//
// KEY HYGIENE: API keys NEVER enter providers.json — a key-bearing config is
// REFUSED here (settingsSaveKey owns keys, into .credentials.yaml), and no
// reply carries key material (the server strips stray fields too).
//
// Module cycle note: this file imports runtime helpers (TEST_MESSAGES,
// classifyTestResponse, envSelectedProvider) from settings-ops.ts while
// settings-ops.ts imports this module's factory for withSettingsOps — every
// cross-use is inside function bodies (deferred), so both evaluation orders
// resolve (function declarations hoist; the consts are initialized long
// before any op runs). The lazy-import alternative (switchWorkspace's ui.ts
// cycle) is unnecessary at this distance.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  defaultProviderRegistryPath,
  isBuiltinProviderName,
  parseApiKeyPool,
  validateUserProviderEntry,
  writeProviderRegistrySync,
} from "@wudao-org/providers";
import type { ProviderModelEntry, UserProviderConfig } from "@wudao-org/providers";
import { readCredentialsFile, readCredentialsFileSync, writeCredentialsFileSync } from "../credentials.js";
import { readGlobalSettings, saveGlobalSettings } from "../settings-layer.js";
import { loadEffectiveProfiles, loadProviderRegistry, invalidateProviderRegistryCache } from "../provider-registry.js";
import { classifyTestResponse, envSelectedProvider, personaReferenceId, TEST_MESSAGES } from "./settings-ops.js";
import type { SettingsOpsDeps, TestConnectionState } from "./settings-ops.js";

/** The ops' reply shapes (mirrored by packages/web/src/protocol.ts). */
export type SaveProviderOutcome = { readonly ok: true; readonly provider: string } | { readonly ok: false; readonly error: string };
export type DeleteProviderOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };
export type ListModelsOutcome =
  | { readonly ok: true; readonly models: readonly ProviderModelEntry[] }
  | { readonly ok: false; readonly state: TestConnectionState; readonly message: string };

export interface ProviderRegistryOps {
  settingsSaveProvider(id: string, config: unknown): Promise<SaveProviderOutcome>;
  settingsDeleteProvider(id: string): Promise<DeleteProviderOutcome>;
  settingsListModels(provider: string, opts?: { readonly key?: string }): Promise<ListModelsOutcome>;
}

/** SDD 2026-08-23 persona Task 4 — the per-provider persona binding read (the
 *  provider card's THREE-STATE `persona` column in ~/.wudao/providers.json,
 *  the second leg of the chain env > binding > default > none, spec §1/§2):
 *
 *    undefined  no card, no key, or a blank provider id — follow the global
 *               default (the key-absent state is a CHOICE, distinct from null)
 *    "some-id"  bound — this persona rides the provider
 *    null       explicitly unbound — forced none, the default never applies
 *
 *  Reads the VALIDATED view (an invalid row already refuses at load —
 *  fail-visible in the settings matrix — so a junk persona value can never
 *  masquerade as a state here). Explicit path ⇒ fresh disk read per call:
 *  the binding is consulted at boot and at provider switches, where freshness
 *  beats the process memo (a hand-edited card between switches is honored).
 *  Never throws — a missing/malformed registry is the empty registry. */
export function readProviderPersonaBinding(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null | undefined {
  return loadProviderRegistry(defaultProviderRegistryPath(env)).entries.get(providerId)?.persona;
}

/** 推理档三级配置 S2 (spec 2026-08-28 §1) — the per-provider reasoning-effort
 *  binding read, the persona column's exact twin over the registry's `effort`
 *  key (the middle leg of the chain pin > binding > global > model default):
 *
 *    undefined  no card, no key, or a blank provider id — follow the global
 *               default (the key-absent state is a CHOICE, distinct from null)
 *    "high"…    bound — this level rides the provider ("none" included: it is
 *               a WIRE value, unlike null below)
 *    null       explicitly unbound — send NO reasoning_effort param at all
 *               (the global default never applies; distinct from "none")
 *
 *  Same contract as readProviderPersonaBinding: the VALIDATED view (a junk
 *  effort already refused the row at load — fail-visible), explicit path ⇒
 *  fresh disk read per call (boot and provider switches want freshness over
 *  the memo), never throws. */
export function readProviderEffortBinding(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null | undefined {
  return loadProviderRegistry(defaultProviderRegistryPath(env)).entries.get(providerId)?.effort;
}

/** SDD 2026-08-23 persona Task 5 — personaDelete's unbind half: strip the
 *  `persona` key from every registry card bound to the id (back to the
 *  KEY-ABSENT state — follow the global default again — not null, which is
 *  the different "forced none" choice). Read-modify-write over the RAW file
 *  (sibling rows preserved verbatim, invalid ones included — the save path's
 *  discipline); a row whose binding is NOT this id never moves (its own
 *  persona state, including explicit null, is the user's data). Returns
 *  whether any card was touched (false = nothing to unbind, no write). */
export async function clearProviderPersonaBindings(personaId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const path = defaultProviderRegistryPath(env);
  const providers = readRawProviders(path);
  let touched = false;
  for (const id of Object.keys(providers)) {
    const row = providers[id];
    // Layer-selection Task 1: bindings may carry the `id:layers` qualifier —
    // a row matches when its reference's BARE id is this persona
    // (personaReferenceId), so deleting `alpha` also unbinds `alpha:headers`.
    if (isPlainObject(row) && typeof row["persona"] === "string" && personaReferenceId(row["persona"]) === personaId) {
      const next = { ...row };
      delete next["persona"];
      providers[id] = next;
      touched = true;
    }
  }
  if (!touched) return false;
  try {
    writeProviderRegistrySync(path, { version: 1, providers: providers as Record<string, UserProviderConfig> });
  } catch (err) {
    throw new Error(`写入 providers.json 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  // I2: the write LANDED — this process's next registry read must see it.
  invalidateProviderRegistryCache();
  return true;
}

/** SDD 2026-08-23 persona Task 5 — personaDelete's reference scan: every
 *  registry card whose `persona` binding is the id (sorted, wire-stable —
 *  the confirm card's provider list). Reads the VALIDATED view: an invalid
 *  row never resolves at runtime, so it is not a live reference. */
export function providersBoundToPersona(personaId: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const entries = loadProviderRegistry(defaultProviderRegistryPath(env)).entries;
  const bound: string[] = [];
  // Layer-selection Task 1: qualified bindings (`id:layers`) match by bare id.
  for (const [id, cfg] of entries) {
    if (cfg.persona !== null && cfg.persona !== undefined && personaReferenceId(cfg.persona) === personaId) bound.push(id);
  }
  return bound.sort();
}

/** The spec's builtin-delete refusal (design §5, verbatim). */
const BUILTIN_DELETE_ERROR = "内置 provider 不可删除";

/** The key-bearing-config refusal: keys never persist in providers.json. */
const KEY_IN_CONFIG_ERROR = "API key 不能存入 providers.json——请使用「保存 Key」（settingsSaveKey，key 落在 .credentials.yaml）";

/** Key-named fields that must NEVER appear in registry config. Mirrors the
 *  server's SECRET_FIELDS list plus the credentials file's own naming. */
const KEY_FIELDS = ["key", "apiKey", "apiKeys", "keys"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the registry file RAW (unvalidated) for the modify half of the
 *  read-modify-write: preserving sibling rows verbatim — including entries
 *  the validator refuses — requires the original JSON, not the sanitized
 *  view readProviderRegistrySync returns. A missing/malformed file starts
 *  empty (the write repairs the structure; only its OWN id is at stake). */
function readRawProviders(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isPlainObject(parsed) && parsed["version"] === 1 && isPlainObject(parsed["providers"])) {
      return { ...parsed["providers"] };
    }
  } catch {
    // ENOENT or invalid JSON — an empty base (same posture as the read side).
  }
  return {};
}

/** 0.3.30 两套拆分的一次性迁移：kimi-code 重指向订阅网关（api.kimi.com/
 *  coding）后，把重指向**前**存下的「平台形状」数据挪到新的 kimi 条目，
 *  行为与 key 都不丢。判定是确定性的形状规则（baseUrl 钉在哪），不是时
 *  间戳——重指向前 kimi-code 的编译默认就是 moonshot 平台端，所以：
 *
 *    行钉 api.moonshot.cn，或行缺省          → 平台数据 → 挪到 kimi
 *    行钉 api.kimi.com 或第三方代理 URL      → 订阅/代理配置 → 一律不动
 *
 *  挪动本身保守：kimi 已有 key（或已有行）则不覆盖——用户已在新条目配好
 *  的数据优先，旧 kimi-code 数据原地保留（fail-visible，绝不删除用户数
 *  据）。一次性由注册表同目录的 .migrated-kimi-split-0.3.30 标记保证：迁
 *  移先、标记后——中途崩溃下次重试，且每一步幂等（重跑收敛到同一终态）。
 *  永不抛错：迁移失败不阻塞 boot。返回是否有数据被挪动。 */
export function migrateKimiCodeSplit(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const regPath = defaultProviderRegistryPath(env);
    const markerPath = join(dirname(regPath), ".migrated-kimi-split-0.3.30");
    if (existsSync(markerPath)) return false;
    const providers = readRawProviders(regPath);
    const row = providers["kimi-code"];
    const baseUrl =
      isPlainObject(row) && typeof row["baseUrl"] === "string" ? row["baseUrl"] : undefined;
    // 形状守卫：钉着订阅端或第三方代理的行是订阅/代理配置——标记后不动。
    if (baseUrl !== undefined && !baseUrl.includes("api.moonshot.cn")) {
      writeFileSync(markerPath, "", { mode: 0o600 });
      return false;
    }
    let touched = false;
    // ① 平台 key → kimi（kimi 已有 key 不覆盖）。
    const creds = readCredentialsFileSync(env);
    const platformKey = creds["kimi-code"] ?? "";
    if (platformKey !== "" && (creds["kimi"] ?? "") === "") {
      const next: Record<string, string> = { ...creds, kimi: platformKey };
      delete next["kimi-code"];
      writeCredentialsFileSync(next, env);
      touched = true;
    }
    // ② moonshot 钉定的 overlay 行整行改名 kimi（kimi 已有行不覆盖）；
    //    改名后 kimi-code 恢复编译默认——订阅网关。
    if (baseUrl !== undefined && providers["kimi"] === undefined) {
      const nextProviders = { ...providers };
      delete nextProviders["kimi-code"];
      nextProviders["kimi"] = row;
      writeProviderRegistrySync(regPath, {
        version: 1,
        providers: nextProviders as Record<string, UserProviderConfig>,
      });
      invalidateProviderRegistryCache();
      touched = true;
    }
    writeFileSync(markerPath, "", { mode: 0o600 });
    return touched;
  } catch {
    return false; // 迁移永不阻塞 boot；幂等步骤 + 无标记 = 下次重试
  }
}

export function createProviderRegistryOps(deps: SettingsOpsDeps): ProviderRegistryOps {
  const env = () => deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.testTimeoutMs ?? 10_000;

  return {
    async settingsSaveProvider(id, config): Promise<SaveProviderOutcome> {
      const trimmed = id.trim();
      if (trimmed === "") return { ok: false, error: "provider id 不能为空" };
      // The one rule validateUserProviderEntry cannot enforce: key fields
      // would be silently DROPPED by its sanitizer — refuse loudly instead,
      // so a pasted key is never mistaken for saved (settingsSaveKey owns it).
      if (isPlainObject(config)) {
        for (const field of KEY_FIELDS) {
          if (config[field] !== undefined) return { ok: false, error: KEY_IN_CONFIG_ERROR };
        }
      }
      const validated = validateUserProviderEntry(trimmed, config);
      if (!validated.ok) return { ok: false, error: validated.reason };
      const path = defaultProviderRegistryPath(env());
      const providers = readRawProviders(path);
      providers[trimmed] = validated.value;
      try {
        writeProviderRegistrySync(path, { version: 1, providers: providers as Record<string, UserProviderConfig> });
      } catch (err) {
        return { ok: false, error: `写入 providers.json 失败：${err instanceof Error ? err.message : String(err)}` };
      }
      // I2: the write LANDED — this process's next registry read must see it.
      invalidateProviderRegistryCache();
      return { ok: true, provider: trimmed };
    },

    async settingsDeleteProvider(id): Promise<DeleteProviderOutcome> {
      const trimmed = id.trim();
      if (trimmed === "") return { ok: false, error: "provider id 不能为空" };
      if (isBuiltinProviderName(trimmed)) return { ok: false, error: BUILTIN_DELETE_ERROR };
      const path = defaultProviderRegistryPath(env());
      const providers = readRawProviders(path);
      const present = providers[trimmed] !== undefined;
      if (present) {
        delete providers[trimmed];
        try {
          writeProviderRegistrySync(path, { version: 1, providers: providers as Record<string, UserProviderConfig> });
        } catch (err) {
          return { ok: false, error: `写入 providers.json 失败：${err instanceof Error ? err.message : String(err)}` };
        }
        // I2 + R-M5 (T3 review M1): the write LANDED — invalidate IMMEDIATELY,
        // BEFORE the settings fallback below (the save path's placement). A
        // throwing fallback used to reject the op before the invalidation ran,
        // leaving disk without the row but this process's memo (and the live
        // settings matrix) still showing it — a stale-matrix window.
        invalidateProviderRegistryCache();
      }
      // The stored pick may point at a provider that just vanished (deleting
      // the custom — or a hand-edited registry): drop it so the boot's default
      // resolution owns the default again (design §5's fallback). Runs on the
      // idempotent path too — an absent row with a dangling pick still heals.
      const e = env();
      const record = await readGlobalSettings(e);
      const modelNode = record["model"];
      if (isPlainObject(modelNode)) {
        const pick = modelNode["defaultModel"];
        if (isPlainObject(pick) && pick["provider"] === trimmed) {
          const next = { ...modelNode };
          delete next["defaultModel"];
          record["model"] = next;
          await saveGlobalSettings(record, e);
        }
      }
      return { ok: true };
    },

    async settingsListModels(provider, opts): Promise<ListModelsOutcome> {
      const e = env();
      const id = provider.trim();
      const profile = loadEffectiveProfiles().get(id);
      if (profile === undefined) {
        throw new Error(`unknown provider "${id}" (the matrix: ${[...loadEffectiveProfiles().keys()].join(", ")})`);
      }
      // The testConnection ladder, verbatim: pasted key → env pool (when the
      // target IS the selected provider — that is whose key the env carries)
      // → the credentials file.
      const selected = envSelectedProvider(e);
      const pasted = opts?.key?.trim() ?? "";
      const envPool = parseApiKeyPool(e);
      const fileKey = (await readCredentialsFile(e))[id]?.trim() ?? "";
      const key = pasted !== "" ? pasted : id === selected && envPool.length > 0 ? (envPool[0] ?? "") : fileKey;
      if (key === "") return { ok: false, state: "no-key", message: TEST_MESSAGES["no-key"] };
      const endpoint = (id === selected ? (e.WUDAO_BASE_URL ?? e.OPENAI_BASE_URL) : undefined) ?? profile.defaultBaseUrl ?? null;
      if (endpoint === null) return { ok: false, state: "no-endpoint", message: TEST_MESSAGES["no-endpoint"] };

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // 0.3.26: wire-aware probe. The anthropic wire follows the Anthropic
        // list-models convention (GET ${base}/v1/models, x-api-key +
        // anthropic-version; the coding-plan gateways dual-send Bearer via
        // their bearerAuth pin) — this also fixes the real anthropic builtin,
        // which 404'd on the openai-style /models probe. The openai wire
        // keeps the historical URL/headers byte-identical.
        const anthropicWire = profile.wire === "anthropic";
        const probeUrl = anthropicWire
          ? `${endpoint.endsWith("/v1") ? endpoint : `${endpoint}/v1`}/models`
          : `${endpoint}/models`;
        const headers = anthropicWire
          ? {
              "x-api-key": key,
              "anthropic-version": "2023-06-01",
              ...(profile.bearerAuth === true ? { authorization: `Bearer ${key}` } : {}),
            }
          : { authorization: `Bearer ${key}` };
        const res = await doFetch(probeUrl, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        const body = await res.text().catch(() => "");
        if (!res.ok) {
          // The testConnection state machine, reused as-is (§5): 401/403 →
          // auth, 404/400-model → model, everything else → the http bucket.
          const state = classifyTestResponse(res.status, body);
          return {
            ok: false,
            state,
            message: state === "http" ? `${TEST_MESSAGES.http} (HTTP ${res.status})` : TEST_MESSAGES[state],
          };
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return { ok: false, state: "http", message: `${TEST_MESSAGES.http}（/models 响应不是 JSON）` };
        }
        const data = isPlainObject(parsed) ? parsed["data"] : undefined;
        if (!Array.isArray(data)) {
          return { ok: false, state: "http", message: `${TEST_MESSAGES.http}（/models 响应缺少 data 数组）` };
        }
        const models: ProviderModelEntry[] = [];
        for (const row of data) {
          if (!isPlainObject(row)) continue;
          const name = row["id"];
          if (typeof name !== "string" || name === "") continue; // odd rows skip, never fail the list
          const cl = row["context_length"];
          if (typeof cl === "number" && Number.isInteger(cl) && cl > 0) models.push({ name, contextLength: cl });
          else models.push({ name });
        }
        return { ok: true, models };
      } catch {
        // Abort = our budget; refused/DNS/fetch-failed all read as the same
        // novice-facing "cannot reach" state (the testConnection posture).
        return { ok: false, state: "network", message: TEST_MESSAGES.network };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
