// 借鉴弧 B1（a reference project C1）— providers 的价目面：模型价格目录 schema + 缓存
// 经济学 ratio 的自动推导。
//
// 立场（对 a reference project 的 N7 负裁决的正面侧）：cacheWriteReadRatio 不做用户配置
// 项、不手填常量（他们的 12.5 抄 GPT-5.6 定价）。推导链：
//   catalog pin（registry 行的 models[].prices——用户 overlay，builtin 只有
//   文档核实的数字才钉）> WUDAO_PRICE_<MODEL> env（CLI /cost 的既有约定，
//   "in,out,cacheRead,cacheWrite" per-M-USD）> 保守缺省（core 的
//   DEFAULT_CACHE_WRITE_READ_RATIO，ratioSource:"default" 类型化标注）。
//
// ratio 语义：重读每 token 价格 ÷ 缓存命中每 token 价格。重读价取
// max(input, cacheWrite)：OpenAI/Anthropic 语义下 cacheWrite ≥ input（压缩后
// 重建前缀按 write 计价）；DeepSeek 语义下无独立 write 价、重建按 miss=input
// 计价（usageCostUsd 的 write=0 形）。cacheRead ≤ 0（免费缓存或坏行）推不出
// 比值——回落下一档，绝不除零。
import { DEFAULT_CACHE_WRITE_READ_RATIO, type CachePricing } from "@wudao-org/core";

/** 一条目录价格（per-M-USD）。input/cacheRead 是 ratio 的必需面；output/
 * cacheWrite 可选（/cost 全账面用，缺省按 0 计）。 */
export interface ModelPrices {
  /** cache miss 输入价（重读的 DeepSeek 形落点）。 */
  readonly inputPerM: number;
  /** 缓存命中价（每请求幸存前缀的持续成本）。 */
  readonly cacheReadPerM: number;
  readonly outputPerM?: number;
  /** 独立缓存写价（OpenAI/Anthropic 形；缺省 = 无独立写价）。 */
  readonly cacheWritePerM?: number;
}

/** registry/目录行的 fail-closed 形状校验：必需面在场且 finite ≥ 0，可选面
 * 在场时同样。坏行拒收（fail-visible），绝不猜成 rate。 */
export function isModelPrices(v: unknown): v is ModelPrices {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  const nonNeg = (x: unknown): boolean => typeof x === "number" && Number.isFinite(x) && x >= 0;
  if (!nonNeg(r.inputPerM) || !nonNeg(r.cacheReadPerM)) return false;
  if (r.outputPerM !== undefined && !nonNeg(r.outputPerM)) return false;
  if (r.cacheWritePerM !== undefined && !nonNeg(r.cacheWritePerM)) return false;
  return true;
}

/** 一档推导输入（与 CLI cost.ts 的 PriceEntry 结构同形——CLI 把已解析的 env
 * 行原样递进来，不重造解析器）。 */
export interface PriceSource {
  readonly inputPerM: number;
  readonly cacheReadPerM: number;
  readonly cacheWritePerM?: number;
}

/** 从一档价格推导 ratio。cacheRead > 0 时 = prefill/cacheRead；cacheRead = 0
 * 且 prefill > 0（免费缓存——DeepSeek 2024 真实存在过）时幸存前缀每请求
 * $0：归档节省为 0 而重建仍付费 → 永不经济（Infinity，窗口保护兜底）。
 * 两档推不出（全 0 / NaN）→ undefined（回落下一档）。 */
function ratioFrom(source: PriceSource): number | undefined {
  if (source.cacheReadPerM > 0) {
    const r = Math.max(source.inputPerM, source.cacheWritePerM ?? 0) / source.cacheReadPerM;
    return Number.isFinite(r) ? r : undefined;
  }
  const prefill = Math.max(source.inputPerM, source.cacheWritePerM ?? 0);
  return prefill > 0 ? Number.POSITIVE_INFINITY : undefined;
}

/** ratio 可用 = 有限非负，或显式 +Infinity（免费缓存的永不经济档）。 */
const usableRatio = (r: number | undefined): r is number =>
  r !== undefined && (Number.isFinite(r) || r === Number.POSITIVE_INFINITY) && r >= 0;

/**
 * 推导压缩经济学的定价事实。优先级 catalog > env > 保守缺省；每一档的来源
 * 都类型化在 ratioSource 上（"default" = 价目未知，决策面板可见）。
 * 纯函数。
 */
export function deriveCachePricing(input: {
  /** registry 目录 pin（effectiveProfiles 的 models[].prices）。 */
  readonly catalog?: ModelPrices;
  /** WUDAO_PRICE_<MODEL> env 行（调用方解析后递入）。 */
  readonly env?: PriceSource;
}): CachePricing {
  const fromCatalog = ratioFrom(input.catalog ?? { inputPerM: 0, cacheReadPerM: 0 });
  if (usableRatio(fromCatalog)) {
    return { cacheWriteReadRatio: fromCatalog, ratioSource: "catalog" };
  }
  const fromEnv = ratioFrom(input.env ?? { inputPerM: 0, cacheReadPerM: 0 });
  if (usableRatio(fromEnv)) {
    return { cacheWriteReadRatio: fromEnv, ratioSource: "env" };
  }
  return { cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO, ratioSource: "default" };
}

/** 在一个 effective profile 的目录里按模型名找价格 pin（精确名；目录缺该
 * 模型 = undefined）。纯。 */
export function catalogPricesFor(
  models: readonly { readonly name: string; readonly prices?: ModelPrices }[] | undefined,
  model: string,
): ModelPrices | undefined {
  if (models === undefined) return undefined;
  const entry = models.find((m) => m.name === model);
  return entry?.prices;
}
