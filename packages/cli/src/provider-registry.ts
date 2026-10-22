// Provider management (Task 2) — the CLI's ONE read-side seam over the
// runtime provider registry (~/.wudao/providers.json, providers package).
// Every gate/window that used to hardcode the builtin member table resolves
// through here instead: builtins ⊕ overlays ⊕ customs in one effective view.
//
// Process-level memo: the registry is machine-global and immutable during a
// run (the settings page's write ops invalidate in Task 3), so the DEFAULT
// path is read from disk exactly once per process — every consumer (boot,
// /model, /provider, the settings matrix, plugin shorthands, subagent model
// overrides) shares that single read. An EXPLICIT path bypasses the memo and
// reads fresh: that is the test seam (tmp homes) and the reload primitive.
//
// Fault posture mirrors readProviderRegistrySync: a missing/malformed file
// never blocks boot — the builtins always cover everything, and the invalid
// rows ride out for the settings page to badge (fail-visible, never silent).
import { defaultProviderRegistryPath, effectiveProfiles, readProviderRegistrySync, resolveContextWindowTokens } from "@wudao/providers";
import type { EffectiveProfile, RegistryLoadResult } from "@wudao/providers";
import type { CachePricing } from "@wudao/core";
import { resolveRunCachePricing } from "./commands/cost.js";
import { resolveAutoCompactSettings } from "./misc-config.js";

const cache = new Map<string, RegistryLoadResult>();

/** Read + validate the registry once per path. `path` omitted → the process's
 *  default location (WUDAO_GLOBAL_HOME-aware), memoized; an explicit path
 *  reads fresh every call (tests / the future reload seam). */
export function loadProviderRegistry(path?: string): RegistryLoadResult {
  const file = path ?? defaultProviderRegistryPath();
  if (path !== undefined) return readProviderRegistrySync(file);
  let hit = cache.get(file);
  if (hit === undefined) {
    hit = readProviderRegistrySync(file);
    cache.set(file, hit);
  }
  return hit;
}

/** The effective profile view (builtins ⊕ overlays ⊕ customs) the CLI's
 *  gates consume — `profiles.has(id)` is the widened "known provider" test
 *  everywhere a hardcoded member table used to sit. */
export function loadEffectiveProfiles(path?: string): ReadonlyMap<string, EffectiveProfile> {
  return effectiveProfiles(loadProviderRegistry(path).entries);
}

/** 借鉴弧 B1（the upstream project C1）：会话级压缩经济学定价——catalog pin > WUDAO_PRICE
 *  env > 保守缺省（来源类型化；零用户配置面）。env+registry 内联，三个前端
 *  调用点（index/repl/driver）一行接线。 */
export function resolveSessionCachePricing(provider: string | undefined, model: string | undefined): CachePricing {
  return resolveRunCachePricing({ provider, model, env: process.env, profiles: loadEffectiveProfiles() });
}

/** Drop the memo (tests that rewrite the file under the SAME home). */
export function resetProviderRegistryCacheForTests(): void {
  cache.clear();
}

/** Provider management §5 (T2-review I2): the settings page's registry WRITE
 *  ops call this on their success branch — the next read re-reads disk, so
 *  the SAME `wudao ui` process sees the new registry in its next
 *  settingsStatus matrix / settingsListModels probe / gate read. No TTL, no
 *  periodic refresh: the hook fires exactly on the save/delete write paths,
 *  so a failed write never disturbs a cached-good view. */
export function invalidateProviderRegistryCache(): void {
  cache.clear();
}

/** Provider management §7 — the window chain every build point shares: the
 *  per-model resolution (registry contextLength → provider default → the
 *  pre-resolved env value) feeds resolveAutoCompactSettings through its
 *  envWindowTokens parameter (call shape, knob precedence, and clamp all
 *  unchanged — an explicit autoCompactWindow still wins over every model).
 *  `profiles` omitted → the process's effective view (the one shared read). */
export function resolveSessionWindowTokens(args: {
  readonly effective: Readonly<Record<string, unknown>> | undefined;
  readonly envWindowTokens: number;
  readonly provider: string | undefined;
  readonly model: string;
  readonly profiles?: ReadonlyMap<string, EffectiveProfile>;
}): number {
  return resolveAutoCompactSettings(
    args.effective,
    resolveContextWindowTokens(args.profiles ?? loadEffectiveProfiles(), args.provider ?? "", args.model, args.envWindowTokens),
  ).windowTokens;
}
