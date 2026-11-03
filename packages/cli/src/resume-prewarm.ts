// 128-2（codex 3f4668da20 引进，变体）— resume 暖前缀。
//
// 问题：长会话空闲后用户再说话，首 token 延迟 = 连接建立 + 路由 + 全量
// 历史组装 + 服务端前缀缓存（若已被逐出）重建。空闲时间是免费资源，应该
// 提前花掉。
//
// 机制（codex 的 generate:false prepared response 是 OpenAI 私有 WS 协议，
// 国产兼容端点没有——引进的是机制不是协议）：resume 落定的那一刻，后台
// fire-and-forget 发一次 max_tokens:1 的同前缀请求，把 provider 的前缀
// 缓存（重）建。用户的下一条真实请求的前缀（system+tools+历史）与它
// 字节共享（M24 单一 canonical serializer 保证），命中已暖的缓存。
//
// 成本诚实（数学）：缓存已暖时 prewarm 输入按 cache-read 计费（~1/10 价）
// + 1 个输出 token——近乎免费；缓存已冷时 prewarm 付一次全价输入，但真
// 实请求本来也要付这次（且付完即暖，真实请求的前缀段变 cache-read）——
// 净省。usage 照常入账（querySource="prewarm" 溯源——goal 计量的
// querySource 过滤纪律天然把它排除在任务预算外，账面仍可见）。
//
// 边界（诚实）：只挂交互 resume（用户读历史的时间窗）；continue 车道
// （交棒后立即起跑）与 origin spawn 车道（子进程首动作就是真实请求）无
// 空闲窗可利用，不挂。失败静默（.catch 吞——预热失败绝不断会话）。
import type { ModelClient } from "@wudao-org/core";

/** The prewarm lane's query-source marker（title 车道同族）。 */
export const RESUME_PREWARM_QUERY_SOURCE = "prewarm";

/** Family-pattern kill switch（缺省开）。 */
export const RESUME_PREWARM_DISABLE_ENV = "WUDAO_DISABLE_RESUME_PREWARM";

export function resumePrewarmDisabled(env: NodeJS.ProcessEnv = {}): boolean {
  return (env[RESUME_PREWARM_DISABLE_ENV] ?? "").trim() === "1";
}

/** Fire ONE max_tokens:1 same-prefix request to warm the provider's prefix
 *  cache. Fire-and-forget: failures are swallowed (a failed prewarm must
 *  never break the session), and the caller never awaits it. */
export function fireResumePrewarm(
  model: ModelClient,
  input: {
    readonly systemPrompt: string;
    readonly tools: readonly import("@wudao-org/core").Tool[];
    readonly messages: readonly import("@wudao-org/core").AgentMessage[];
  },
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (resumePrewarmDisabled(env)) return;
  // Nothing resumed (empty history) = nothing to warm beyond a fresh session's
  // own first request — skip (the interactive resume face always has history).
  if (input.messages.length === 0) return;
  void model
    .generate({
      systemPrompt: input.systemPrompt,
      tools: [...input.tools],
      messages: [...input.messages],
      maxTokens: 1,
      querySource: RESUME_PREWARM_QUERY_SOURCE,
    })
    .catch(() => {
      // Silent by design (the module doc): a cold provider stays cold; the
      // real request pays exactly what it would have paid without prewarm.
    });
}
