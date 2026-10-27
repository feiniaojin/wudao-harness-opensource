// packages/providers/src/model-fallback.ts — M62 §7 有序模型 fallback 链（r1a
// Task 3 从 openai-compatible.ts 工厂原样抽出，三工厂共用）。
//
// 模型故障 ≠ 凭据故障：本链与 M56 key 池正交（池在同一个模型内轮换 key；
// 链在梯子放弃后换模型）。语义与抽出前的 openai 工厂逐字段等价：
//   - 主模型自己的重试梯子耗尽且错误 fallback-ELIGIBLE（模型类：5xx/overload/
//     404/transport —— 不是 key 类 401/403、不是 abort、不是上下文溢出）后，
//     调用改试链中下一个配置的模型；
//   - 主模型连续失败 2 次后（sticky streak=2），后续调用直接从第一个 fallback
//     开始（一次失败下轮仍先试主模型）；只有主模型成功才清零 streak；
//   - fallback 调用的 usage receipt 打标注（fallbackModel + fallbackFrom），
//     /cost 与轮 receipt 能显示；M70 §2：fallback 行以 FALLBACK 的名字应答 ——
//     loop 的 usage-anchor 守卫看到模型切换即弃锚。
// 红线：fallback 只在失败路径生效，请求序列化零触碰（前缀缓存字节稳定）——
// 换模型只换 leg 配置，绝不改写请求字节。
import type { AssistantMessage, ModelClient, ModelInput, ModelStreamEvent, ModelUsage } from "@wudao/core";
import type { ProviderConfig } from "./config.js";
// r1b A1: 判定从 openai-compatible 下沉到 model-failure —— 消除
// openai-compatible ↔ model-fallback 的 import 环（语义零变，同一函数体）。
import { isModelFallbackEligible } from "./model-failure.js";

/** Consecutive primary failures after which the chain skips straight to the
 *  first fallback ("连续失败" — one blip retries the primary next call). */
const FALLBACK_PIN_STREAK = 2;

/** One protocol adapter's per-model leg client: the shared retry ladder rides
 *  INSIDE each leg — the chain swaps the model only after a leg's ladder gave
 *  up. Both paths required (all three protocol adapters ship generate+stream). */
export interface StreamingModelClient extends ModelClient {
  stream(input: ModelInput): AsyncGenerator<ModelStreamEvent>;
}

/** The seam each factory provides: build one leg for one (model-swapped)
 *  config. `config.fallbackModels` stays the single configuration surface —
 *  the decorator never invents a second one. */
export type ModelClientFactory = (config: ProviderConfig) => StreamingModelClient;

/** Wrap one protocol adapter's per-model leg factory with the ordered
 *  model-fallback chain. Zero `fallbackModels` = a one-leg chain: the wrapper
 *  is pass-through shape (same error, one extra async frame, no behavior
 *  change). */
export function withModelFallback(
  makeClient: ModelClientFactory,
  config: ProviderConfig,
): StreamingModelClient {
  // 有序链：主模型 + fallbackModels（过滤与主模型相同的项，与抽出前同款）。
  // 各 leg 共享同一 key 池/梯子选项 —— 池在模型内换 key，链在梯子放弃后换模型。
  const fallbacks: readonly string[] = (config.fallbackModels ?? []).filter((m) => m !== config.model);
  const chain: readonly { readonly client: StreamingModelClient; readonly model: string; readonly primary: boolean }[] = [
    { client: makeClient(config), model: config.model, primary: true },
    ...fallbacks.map((m) => ({ client: makeClient({ ...config, model: m }), model: m, primary: false })),
  ];
  let primaryFailStreak = 0;
  const annotateUsage = (input: ModelInput, from: string, to: string): ModelInput => ({
    ...input,
    onUsage: input.onUsage === undefined
      ? undefined
      // M70 §2: a failover row answers under the FALLBACK's name — the loop's
      // usage-anchor guard (a) sees the model switch and drops the anchor.
      : (u: ModelUsage) => input.onUsage?.({ ...u, model: to, fallbackModel: to, fallbackFrom: from }),
  });

  return {
    // M70 §2: the client's primary model identity (the loop's usage-anchor
    // guards compare it against the answering model on each usage row).
    modelId: config.model,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      const startAt = primaryFailStreak >= FALLBACK_PIN_STREAK ? Math.min(1, chain.length - 1) : 0;
      let lastErr: unknown;
      for (let i = startAt; i < chain.length; i += 1) {
        const leg = chain[i]!;
        const callInput = !leg.primary ? annotateUsage(input, config.model, leg.model) : input;
        try {
          const out = await leg.client.generate(callInput);
          if (leg.primary) primaryFailStreak = 0;
          return out;
        } catch (err) {
          if (!isModelFallbackEligible(err)) throw err;
          if (leg.primary) primaryFailStreak += 1;
          lastErr = err;
        }
      }
      throw lastErr;
    },

    // M62 §7: the stream path mirrors generate; a fallback is only possible
    // BEFORE the first yielded delta (a post-delta break is rethrown —
    // replaying would duplicate output). The done message is always the last
    // attempt's.
    async *stream(input: ModelInput): AsyncGenerator<ModelStreamEvent> {
      const startAt = primaryFailStreak >= FALLBACK_PIN_STREAK ? Math.min(1, chain.length - 1) : 0;
      let lastErr: unknown;
      for (let i = startAt; i < chain.length; i += 1) {
        const leg = chain[i]!;
        const callInput = !leg.primary ? annotateUsage(input, config.model, leg.model) : input;
        let produced = false;
        try {
          for await (const ev of leg.client.stream(callInput)) {
            if (ev.type === "reasoning_delta" || ev.type === "text_delta") produced = true;
            yield ev;
          }
          if (leg.primary) primaryFailStreak = 0;
          return;
        } catch (err) {
          if (produced || !isModelFallbackEligible(err)) throw err;
          if (leg.primary) primaryFailStreak += 1;
          lastErr = err;
        }
      }
      throw lastErr;
    },
  };
}
