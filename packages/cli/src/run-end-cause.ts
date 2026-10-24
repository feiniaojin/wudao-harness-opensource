// v7 借鉴弧 γ2（digest-a 候选 2，源 CodeWhale #6162「取消的 run 有回执」
// + #6118 的「Failed 带原因而非静默 Canceled」）——运行终态留名：取消/中止
// 的 run 记录「谁/什么结束了它」。
//
// 在位者缺口：mission 状态机的 abandoned/stale 枚举无因字段；schedules 的
// 超时 kill 无回执（SIGKILL 后只有 output 尾巴一行文本）；driver 的中断
// 统一收敛为「⚠️ 已中断」——用户 abort、窗口关闭、看门狗、定时超时在转录
// 里不可区分。用户早上看夜间任务没产出，分不清「被杀了」「没到点」还是
// 「跑挂了」。
//
// 本模块 = 终态成因的唯一词表家：稳定 ASCII 枚举（跨进程/跨版本可 grep、
// 可入指纹 subject）+ 中文人话（回执面）+ CodeWhale 正派边界——「legacy
// 无因记录降级为无 detail，绝不臆造」（describeRunEndCause 对缺席返回
// 空串，调用方以缺席=不加括注的形态消费，永不发明原因）。
//
// 与失败指纹的关系（「怎么结束」是「怎么失败」的姊妹面）：stage="run-end"
// 的观察事件入 failure-fingerprints.jsonl 同一账本（归一化/指纹/状态机复
// 用）；防污染守卫——终态成因不是失败：user-abort（用户在场且 deliberate）
// 只进回执不进指纹；shutdown/schedule-timeout 入指纹（夜里被关窗/被超时
// 杀是用户想追问的事），且 mission 状态行把它们与失败指纹分行呈现。
export type RunEndCause =
  | "user-abort" // 用户手动停止（Esc/^C → driver.interrupt()；/mission abandon 同语义）
  | "watchdog-abort" // 等待超时被看门狗中止（预留：driver 侧尚无此通路，勿臆造落点）
  | "shutdown" // 前端卸载/窗口关闭（driver.setActive(false) 的 abort）
  | "schedule-timeout" // 定时任务超时 kill（schedules.ts 的 SCHEDULE_RUN_TIMEOUT_MS）
  | "approval-deny"; // 等待授权被拒而结束（headless/定时 ASK tier 的 fail-closed deny）

/** 全集（词表钉——测试逐字遍历，新增成因必改这里+回执文案）。 */
export const RUN_END_CAUSES: readonly RunEndCause[] = [
  "user-abort",
  "watchdog-abort",
  "shutdown",
  "schedule-timeout",
  "approval-deny",
];

const RUN_END_CAUSE_SET: ReadonlySet<string> = new Set(RUN_END_CAUSES);

/** Tolerant guard（持久化读入/总线载荷用；坏值 false，绝不部分信任）。 */
export function isRunEndCause(v: unknown): v is RunEndCause {
  return typeof v === "string" && RUN_END_CAUSE_SET.has(v);
}

/** 成因 → 中文人话（回执括注，稳定文案钉于测试）。缺席（undefined/null/
 * 非法值）→ 空串：legacy 无因记录降级为无 detail，绝不臆造。 */
export function describeRunEndCause(cause: RunEndCause | undefined | null): string {
  switch (cause) {
    case "user-abort":
      return "你手动停止了这次运行";
    case "watchdog-abort":
      return "等待太久被看门狗中止";
    case "shutdown":
      return "窗口关闭时被结束";
    case "schedule-timeout":
      return "计划任务超时被终止";
    case "approval-deny":
      return "未获授权而结束";
    default:
      return ""; // legacy/未知：无因=无 detail（CodeWhale #6162 的正派边界）
  }
}

/** 中断回执行（driver 两臂共用）：「⚠️ 已中断」的逐字节旧形在两个情况下
 *  保持——成因缺席（不可知，绝不臆造）与用户手动停止（用户刚按了停止，
 *  「你手动停止了这次运行」是噪音，且 ω99-166c-ii 的 repl 逐字钉不动）。
 *  其余成因（关窗/看门狗/超时/授权拒）括注人话——那才是用户不知道的事。 */
export function interruptedNotice(cause: RunEndCause | null | undefined): string {
  if (cause === null || cause === undefined || cause === "user-abort") return "⚠️ 已中断";
  return `⚠️ 已中断（${describeRunEndCause(cause)}）`;
}
