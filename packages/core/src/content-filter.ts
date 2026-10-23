// 133 #5（codex 8bd5a136ff 引进）— content_filter 终因的恢复指导。
//
// 问题：流被 content_filter 掐断时模型不知道自己被内容过滤挡了——重试只会
// 原样再撞一次墙（甚至换个格式试图绕过）。DeepSeek/GLM 系的敏感词过滤
// 是国产模型的现实刚需面；stopReason="content_filter" 在 types.ts 已持久
// 化但无任何分类处理——既不进 013 输出上限梯（"length" 专属），也不进
// failure_streak 恢复语义。
//
// 机制（codex 形）：stopReason==="content_filter" 时注入一条有界指导
// MetaNote（512 字节帽）——核心纪律：不当瞬时故障、**禁止**以重复尝试/
// 变格式/拆分/编码/工具/子代理/后续唤醒绕过、简述限制并给出许可的替代、
// 继续无关的授权工作。注入卫生：不复述被拦内容，只描述终因与替代路径。
//
// 挂载位：loop 的 length 梯之后、empty-final 之前（content_filter 是第三
// 类终因，与 013/M70 并列）。一次性注入（同 run 不重复注入——过滤是内容
// 信号不是瞬时故障，模型已被告知）；注入后走 completed 终态（不是
// output_limit——被拦是内容问题不是机械截断）。
import type { AgentMessage } from "./types.js";

/** 指导文本（512B 帽——codex 同值；中文定制+国产模型现实） */
export const CONTENT_FILTER_GUIDANCE = `[内容过滤] 你的回复被内容安全过滤拦下了。这不是网络故障,重试同样的内容只会再次被拦。
请遵守:1) 不要以重复、换格式、拆分、编码、用工具或子代理等方式绕过过滤;2) 简述你能完成的替代方案(换一个合规的表述角度继续任务);3) 如果当前话题无法继续,转到用户授权的其它工作上。`;

/** 指导是否已注入过（run 级一次性——模型已被告知，重复注入是噪音）。 */
export function shouldInjectContentFilterGuidance(
  finalAssistant: { stopReason?: string },
  alreadyInjected: boolean,
): boolean {
  return finalAssistant.stopReason === "content_filter" && !alreadyInjected;
}

/** 纯函数：注入后的新消息列表（append-only——末尾追加，前缀字节稳定）。 */
export function withContentFilterGuidance(messages: readonly AgentMessage[]): AgentMessage[] {
  return [...messages, { role: "user" as const, content: CONTENT_FILTER_GUIDANCE }];
}
