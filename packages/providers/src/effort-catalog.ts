// ω99-245: #4 — 角色化推理能力目录（数据层）。每模型族 → 支持的 effort 档
// 集合 + 是否 reasoning 模型（reasoning_content 有无）。纯查表：族默认从
// PROVIDER_PROFILES 推导（单一事实源——目录永不与矩阵漂移），模型级钉只落在
// 有出处的文档事实上；registry 的 `efforts` 覆盖列整卡替换（fail-closed 但
// 可逃生：用户新模型/目录过时不被卡死）。未知 provider/模型返回 undefined
// = 降级「未验证」，绝不阻塞。
import { PROVIDER_PROFILES, REASONING_EFFORTS, isBuiltinProviderName } from "./config.js";
import type { ProviderProfile, ReasoningEffort, ReasoningFormat } from "./config.js";
import type { EffectiveProfile } from "./registry.js";

/** The catalog's slice of a profile: what the derived family set and the
 *  reasoning flag read. EffectiveProfile satisfies it structurally; a bare
 *  compiled-in ProviderProfile does too (no `efforts` on builtins). */
type CatalogProfile = Pick<ProviderProfile, "thinkingLevelMap" | "reasoningFormat"> & {
  readonly efforts?: readonly ReasoningEffort[];
};

/** 流式 reasoning_content 的推理格式（openai 线族——deepseek/zai/qwen 系）。
 *  format "none"（anthropic wire 的 thinking 块线与无推理端点）没有
 *  reasoning_content。 */
const REASONING_CONTENT_FORMATS: ReadonlySet<ReasoningFormat> = new Set([
  "deepseek",
  "zai",
  "qwen",
  "qwen-chat-template",
  "openrouter",
  "together",
  "baseten",
]);

/** 模型级 effort 钉：只钉有平台文档出处的限制（kimi-k2.7-code 家族——
 *  platform.kimi.com/docs/guide/the upstream format-kimi：该模型必须显式 thinking，
 *  effort none（不发 thinking 块）会被端点 400）。键序：provider → model →
 *  完整支持集合。 */
export const MODEL_EFFORT_PINS: Readonly<
  Record<string, Readonly<Record<string, readonly ReasoningEffort[]>>>
> = {
  kimi: {
    "kimi-k2.7-code": ["low", "medium", "high", "max"],
    "kimi-k2.7-code-highspeed": ["low", "medium", "high", "max"],
  },
};

/** Resolve the profile view for a provider id: the effective (registry) view
 *  first, then the compiled-in builtin. undefined = unknown provider. */
function profileFor(
  provider: string | undefined,
  profiles?: ReadonlyMap<string, EffectiveProfile>,
): CatalogProfile | undefined {
  if (provider === undefined || provider === "") return undefined;
  const registered = profiles?.get(provider);
  if (registered !== undefined) return registered;
  return isBuiltinProviderName(provider) ? PROVIDER_PROFILES[provider] : undefined;
}

/** 族默认支持集：全五档减去 thinkingLevelMap 显式钉为 null（不支持）的档。
 *  折叠（glm 的 enabled/disabled、qwen 的布尔）不是不支持——引擎每档都可
 *  表达，目录照收。 */
function familyEfforts(profile: CatalogProfile): readonly ReasoningEffort[] {
  const map = profile.thinkingLevelMap;
  if (map === undefined) return REASONING_EFFORTS;
  return REASONING_EFFORTS.filter((e) => map[e] !== null);
}

/** The supported effort set for a (provider, model) pair, or undefined when
 *  the provider is unknown (custom-without-row, blank) — the caller degrades
 *  to「未验证」, never blocks. Precedence: registry `efforts` override
 *  (wholesale, beats model pins) > model pin > derived family set. Pure. */
export function supportedEfforts(
  provider: string | undefined,
  model: string,
  profiles?: ReadonlyMap<string, EffectiveProfile>,
): readonly ReasoningEffort[] | undefined {
  const profile = profileFor(provider, profiles);
  if (profile === undefined) return undefined;
  if (profile.efforts !== undefined) return profile.efforts;
  const pinned = MODEL_EFFORT_PINS[provider ?? ""]?.[model];
  if (pinned !== undefined) return pinned;
  return familyEfforts(profile);
}

/** Does this family's wire carry streaming reasoning_content? true for the
 *  openai-wire reasoning formats; false for format "none" (anthropic-wire
 *  thinking blocks / no reasoning lane). undefined = unknown provider. Pure. */
export function reasoningContentStreams(
  provider: string | undefined,
  profiles?: ReadonlyMap<string, EffectiveProfile>,
): boolean | undefined {
  const profile = profileFor(provider, profiles);
  if (profile === undefined) return undefined;
  return REASONING_CONTENT_FORMATS.has(profile.reasoningFormat ?? "none");
}
