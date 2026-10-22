// 借鉴弧 α2（the upstream format2.1.269 思想）— /recall：撤回一条排队中尚未被读取的
// steering 消息。TUI 的命令形状照 /find 的先例（find-core.ts）：TUI 自有命
// 令，在共享 parseReplCommand 之前拦截——命令并集喂驱动的穷举 switch，本特
// 性不需要驱动臂（recallSteer 是 driver 的方法面，不是 submit 路由）。REPL
// 不做本命令的臂（REPL 无用户 steering 队列——直驱 loop，busy 期输入随轮
// 携带；打 /recall 只会当普通提示词，而 REPL 从不广播这个命令名）。
import type { SlashCommandInfo } from "../slash-commands.js";

export const RECALL_COMMAND_INFO: SlashCommandInfo = {
  name: "recall",
  description: "撤回排队中还没被读取的消息（运行中发错话趁早收回）",
  args: "[n]",
  source: "builtin",
  sources: ["builtin"],
};

/** Parse a /recall line. Bare `/recall` → last (the most recent — the likeliest
 *  mistake); `/recall <n>` → the n-th on-screen entry (1-based). Prefix-
 *  neighbors and other lines return undefined. */
export function parseRecallCommand(text: string): { n: number | "last" } | undefined {
  const trimmed = text.trim();
  if (trimmed === "/recall") return { n: "last" };
  const m = /^\/recall (\d+)$/.exec(trimmed);
  if (m === null) return undefined;
  return { n: Number(m[1]) };
}

/** Resolve the recall target against the LIVE queue snapshot (pure): returns
 *  the {index, text} CAS pair for the driver's face, or the refusal notice.
 *  n is 1-based (the on-screen order); the queue read must be the same frame
 *  the numbers came from — the driver's CAS re-validates at click time. */
export function recallTargetOf(
  queued: readonly string[],
  n: number | "last",
): { readonly index: number; readonly text: string } | { readonly refusal: string } {
  if (queued.length === 0) {
    return { refusal: "没有可撤回的排队消息（/recall 只管运行中排队的输入）" };
  }
  const idx = n === "last" ? queued.length - 1 : n - 1;
  const text = queued[idx];
  if (text === undefined) {
    return { refusal: `没有第 ${n} 条排队消息（当前共 ${queued.length} 条，1 = 最早）` };
  }
  return { index: idx, text };
}
