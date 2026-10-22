// 借鉴弧 δ（the upstream harness 367ab084 思想）— /bg：把一个正在前台执行的
// 工具调用转入后台（结果不再阻塞本轮；run 在轮界收口，落定结果稍后经
// 后台车道并入对话）。命令形状照 /recall 的先例（recall-core.ts）：TUI 自
// 有命令，在共享 parseReplCommand 之前拦截——不需要驱动路由臂
// （detachToolCall 是 driver 的方法面）。REPL 不做本命令的臂（同 /recall
// 的纪律：REPL 从不广播自己不路由的命令名）。
import type { SlashCommandInfo } from "../slash-commands.js";

export const BG_COMMAND_INFO: SlashCommandInfo = {
  name: "bg",
  description: "把在飞的工具调用转入后台（不杀——完成后自动并入对话）",
  args: "[n]",
  source: "builtin",
  sources: ["builtin"],
};

/** Parse a /bg line. Bare `/bg` → the driver picks the first detachable
 *  in-flight call; `/bg <n>` → the n-th busy row (1-based, the on-screen
 *  live.busyTools order). Prefix-neighbors and other lines return
 *  undefined. */
export function parseBgCommand(text: string): { readonly n?: number } | undefined {
  const trimmed = text.trim();
  if (trimmed === "/bg") return {};
  const m = /^\/bg (\d+)$/.exec(trimmed);
  if (m === null) return undefined;
  return { n: Number(m[1]) };
}
