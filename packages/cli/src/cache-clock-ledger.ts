// 133 top1（"缓存时钟"弧的 CLI 面）— 从会话台账读缓存身份 + 组装冷缓存
// 到期决策 + 通知文案。
//
// 时钟源（零新增写入）：会话 JSONL 文件的 mtime（调用方 stat 传入）即
// "上次缓存承载请求"的时刻；身份源是台账里的 model_change /
// thinking_level_change 条目（最后一条胜）。分类/估价/offer 门全在 core
// 的 cache-clock.ts（纯函数，同函数双端复用）；本模块只做台账读取与
// 文案组装。
//
// M24 声明：零请求字节改动——纯决策点 + 通知，缓存代价为零。
// 与 128-2 resume 暖前缀的协同：offer 成立（冷 + 大前缀 + 过阈）时跳过
// 自动预热——用户可能选择轮转开窗，预热付的冷读会白烧；offer 不成立
// （大概率仍暖/前缀小/便宜）时照常预热。严格不劣于现状：offer 成立时
// 用户若照常继续，真实请求付的冷读与无预热时相同。
import type { SessionEntry } from "@wudao/core";
import {
  classifyCacheClock,
  estimateRewarm,
  coldCacheOffer,
  DEFAULT_CACHE_CLOCK_POLICY,
  type CacheClassification,
  type CacheClockPolicy,
  type CacheIdentity,
  type ColdCacheOffer,
  type RewarmEstimate,
} from "@wudao/core";

/** 台账侧的缓存身份。T003 N2/N11 语义：**逐行 last-wins，无跨行残留**——
 * model_change 行更新 model，且只在该行自带 provider 时更新 provider
 * （缺 provider 不继承更早行的值——残留会把 m2 配上旧 p1，与
 * cacheIdentityEqual 的"无证据不比对"配合防误报 identity_changed）；
 * provider_change 行自带 provider+model，同样按行更新（M63 §A 的
 * /provider 切换只写这一种行——不读它会漏掉整段身份变化）。没有
 * 任何 model 来源 → undefined（不比）。T002 F2：null/undefined 元素
 * 跳过（上游 store 过滤后不会出现；防御直接调用方）。 */
export function ledgerCacheIdentity(entries: readonly SessionEntry[]): CacheIdentity | undefined {
  let model: string | undefined;
  let provider: string | undefined;
  let effort: string | undefined;
  for (const e of entries) {
    if (e === null || typeof e !== "object" || "role" in e) continue;
    if (e.type === "model_change") {
      const m = e as { model?: unknown; provider?: unknown };
      if (typeof m.model === "string" && m.model !== "") model = m.model;
      // 逐行语义：provider 只来自本行；本行缺 → 清空（不残留旧值）。
      provider = typeof m.provider === "string" && m.provider !== "" ? m.provider : undefined;
    } else if (e.type === "provider_change") {
      const p = e as { provider?: unknown; model?: unknown };
      if (typeof p.provider === "string" && p.provider !== "") provider = p.provider;
      if (typeof p.model === "string" && p.model !== "") model = p.model;
    } else if (e.type === "thinking_level_change") {
      const t = e as { level?: unknown };
      if (typeof t.level === "string" && t.level !== "") effort = t.level;
    }
  }
  if (model === undefined) return undefined;
  return {
    model,
    ...(provider !== undefined ? { provider } : {}),
    ...(effort !== undefined ? { reasoningEffort: effort } : {}),
  };
}

export interface ColdCacheResumeDecision {
  readonly classification: CacheClassification;
  readonly estimate: RewarmEstimate | undefined;
  readonly offer: ColdCacheOffer;
  /** 渲染好的通知（无可报时 undefined）。 */
  readonly notice: string | undefined;
}

/** 闲置时长的口语化（<1h → 分钟；<48h → 小时一位小数；再上 → 天）。
 * T002 F6：分钟面 round 到 60 时进位到小时（3599s 是 "1.0 小时"，
 * 不是 "60 分钟"）。非有限输入回落 "未知"（渲染永不出现 NaN 字样）。 */
export function formatIdle(idleSeconds: number): string {
  if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return "未知时长";
  const minutes = Math.round(idleSeconds / 60);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  if (idleSeconds < 48 * 3600) return `${(idleSeconds / 3600).toFixed(1)} 小时`;
  return `${(idleSeconds / 86_400).toFixed(1)} 天`;
}

/** 美元口语化：≥$1 两位小数；以下三位有效（$0.0141 → "$0.014"）。 */
function formatUsd(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  const s = usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  return `$${s}`;
}

/** resume 位的一次性决策组装（纯；驱动位传入一切）。 */
export function coldCacheResumeDecision(input: {
  readonly entries: readonly SessionEntry[];
  /** 会话文件 mtime（ms）。undefined = 读不到 → age_unknown。 */
  readonly lastActivityMs: number | undefined;
  readonly nowMs: number;
  /** 本次进程接下来要用的模型身份（modelLive 形）。 */
  readonly currentIdentity: CacheIdentity | undefined;
  /** 前缀 token 估算（estimateTokens(systemPrompt, toolDefs, messages)）。 */
  readonly prefixTokens: number;
  /** 当前模型的目录价（缺 → 估价 undefined，offer 压 no-price）。 */
  readonly price: { readonly inputPerM: number; readonly cacheReadPerM: number } | undefined;
  readonly policy?: CacheClockPolicy;
}): ColdCacheResumeDecision {
  const policy = input.policy ?? DEFAULT_CACHE_CLOCK_POLICY;
  const classification = classifyCacheClock(
    input.nowMs,
    input.lastActivityMs,
    ledgerCacheIdentity(input.entries),
    input.currentIdentity,
    policy,
  );
  const estimate =
    input.price !== undefined
      ? estimateRewarm(input.prefixTokens, { inputPerM: input.price.inputPerM, cacheReadPerM: input.price.cacheReadPerM })
      : undefined;
  const offer = coldCacheOffer(classification, estimate, policy);
  return { classification, estimate, offer, notice: renderColdCacheNotice(classification, estimate, input.currentIdentity) };
}

/** 通知文案（对外文案写收益与选择，不写实现术语）。 */
export function renderColdCacheNotice(
  classification: CacheClassification,
  estimate: RewarmEstimate | undefined,
  currentIdentity: CacheIdentity | undefined,
): string | undefined {
  if (classification.reason === "identity_changed") {
    // T002 F5：provider 缺失时不渲染悬空斜杠（"/m1"），只显模型名。
    const to =
      currentIdentity !== undefined
        ? currentIdentity.provider !== undefined && currentIdentity.provider !== ""
          ? `${currentIdentity.provider}/${currentIdentity.model}`
          : currentIdentity.model
        : "新模型";
    return `🔁 模型或推理档与会话上次使用时不同（→ ${to}）：首个请求需重建缓存，属预期，无需操作。`;
  }
  if (classification.confidence === "warm") return undefined;
  if (classification.reason === "age_unknown") return undefined; // 没有时钟就没有可说的（不猜）
  // idle + (may_be_cold | expired)
  const idle = formatIdle(classification.idleSeconds);
  // T003 N1：畸形 estimate（core 路径产出不了——estimateRewarm 的 finite
  // 检保证；防御直接调用方）视同无价——走弱通知，绝不渲染 "$NaN"。
  if (estimate !== undefined && (!Number.isFinite(estimate.coldCostUsd) || !Number.isFinite(estimate.incrementalCostUsd))) {
    estimate = undefined;
  }
  if (estimate === undefined) {
    // 冷是诚实的，价是缺的——仍报闲置事实，不报价（无价不报）。
    return `🕐 会话已闲置 ${idle}，缓存可能需要重建——无需操作，直接继续即可。`;
  }
  return `🕐 会话已闲置 ${idle}，继续将重建缓存（约多付 ${formatUsd(estimate.incrementalCostUsd)}）——无需操作；若想轻装开局，可让助手归纳当前进展后开新窗口继续。`;
}
