// 夜移 003（2026-08-28 night porting）：从捕获的模型输入里剥掉 MetaNote 投影
// （时间提醒等 —— projection-only，不属于会话内容）。字节前缀缓存断言在比较
// 前先剥投影：真实不变量是「稳定历史字节相同 + 注入是纯后缀」，临时注记随
// 下一请求消失，不应参与前缀比较。
import type { AgentMessage } from "@wudao/core";

/** 整条 <system_note> user 消息删除；挂在 tool_result 尾部的信封后缀剥除。
 *  （与真实注记同乘一条 user 消息的合并批次不在此列——用到时另写。） */
export const stripProjectedNotes = (ms: readonly AgentMessage[]): AgentMessage[] =>
  ms
    .filter((m) => !(m.role === "user" && typeof m.content === "string" && m.content.startsWith("<system_note>")))
    .map((m) =>
      m.role === "tool" && typeof m.content === "string" && m.content.includes("<system_note>")
        ? ({ ...m, content: m.content.replace(/(\n?<system_note>[\s\S]*?<\/system_note>)+$/, "") } as AgentMessage)
        : m,
    );
