// 借鉴弧 δ（v7 第三梯队，digest-b 候选 C3 / the upstream harness 367ab084 思想）—
// 运行中工具调用转后台（mid-flight detach）。
//
// 在位者只有两态：发起时后台（M30 task 工具的 background spawn——形态在
// 发起那一刻就定死）与 abort 杀（loop 的 abortRace 输掉 → ABORTED_UNKNOWN
// 合成、承诺被弃）。缺的是第三态：一个正在前台执行的工具调用（长构建/
// 子 agent 任务）想转后台继续跑、当前对话不被卡死。
//
// the upstream harness 的机制（detachSignal 与 stop signal 分离 + collectUntil 并集收集
// 窗）在 wudao 的落法：
//   • 请求车道 = 一个极小的 per-run 事件盒（ToolDetachHub）。用户手势 →
//     hub.request(callId)；loop 为每个在飞调用把 hub 事件折进执行赛跑
//     （与 abortRace 并列的第三条腿——detach 是「不再等待」，绝不是
//     「打断」：执行承诺原样活着，永不因 detach 被取消）。
//   • 赛跑被 detach 赢走 → 该调用以 BACKGROUNDED_TOOL_RESULT 合成收口
//     （历史配对不破），执行承诺经 onDetachedCall 交给消费者收集；
//     本批其余调用照常落定，run 在轮界以 backgrounded 终态收口（模型
//     不再被调用——用户要的是拿回对话，不是再烧一轮生成）。
//   • 结果到达 → 走既有后台结果车道（ω-4a monitor 同族缝：steering 低
//     优先 drain 轮尾并入 + 空闲 poll 开新轮），纯后缀追加。
//
// 诚实边界（typed）：
//   • interruptBehavior:"block" 族不可 detach——「取消本身就是危险」的
//     契约比「移到后台」强，请求在车道口 typed 拒，loop 侧干脆不武装
//     （防御纵深：block 工具不进 abort 赛跑，同样不进 detach 赛跑）。
//   • 用户显式停止（interrupt）时后台任务一并停（用户意图优先）：每
//     个调用带 per-call AbortController 线进 execute 的可选第三参——
//     只有 detach 出去的控制器会被 abort（正常路径/普通 abort 绝不
//     触碰，现有中止语义逐字节不变）；shell 族把 abort 接到进程组
//     TERM→KILL。不支持信号的执行（沙箱 docker CLI 等）在弧记档声明。
//   • 被转后台的调用保留自己的 deadline 语义（timeoutMs 原样 ticking）：
//     后台不是永生，超时结果照实并入。
//
// M24 声明：合成收口是批内原生位置的一条 tool_result（配对其 tool_use，
// 纯追加）；后台结果并入走 steering 车道的 user 消息（轮尾追加）——与
// ω-4a monitor 完全同律，零历史改写、零 system prompt 变更、前缀字节
// 不动。下一次模型调用的冷转预期=前缀暖+新尾（monitor 教义原样）。
import type { ToolCall, ToolResultMessage } from "./types.js";

/** The model-facing synthetic that answers a detached call: the execution is
 *  STILL RUNNING — this is not an error and not an abort. Paired with its
 *  tool_use (append-only), same family as ABORTED_UNKNOWN_TOOL_RESULT. */
export const BACKGROUNDED_TOOL_RESULT =
  "[已转后台] 工具仍在后台执行，本轮不再等待——结果完成后会作为后续消息并入对话；可先继续其他工作，或等并入通知后再下结论，不要盲目重发同一调用";

/** One detached execution handed to the consumer (the loop no longer awaits
 *  it): the call's identity, the per-call controller (the ONLY stop path —
 *  abort it to kill the background task; never abort it for anything else),
 *  and the still-running promise of the fully-normalized outcome (the same
 *  {message, provenance} shape the race would have awaited — schema checks
 *  and shaping already ride inside it; it never rejects). */
export interface DetachedCall {
  readonly call: ToolCall;
  readonly controller: AbortController;
  readonly result: Promise<{ readonly message: ToolResultMessage; readonly provenance?: string }>;
}

/** The loop-facing port (LoopOptions.toolDetach): a per-run event box. The
 *  consumer (driver lane) owns the writer; the loop subscribes once per run. */
export interface ToolDetachPort {
  onRequest(listener: (callId: string) => void): () => void;
}

/** The writer face the surfaces call on the user's gesture. Dumb on purpose:
 *  detachability verdicts live with the caller (it knows busyTools + tool
 *  metadata); the loop ignores requests it cannot honor (block tools never
 *  arm a race — the request just parks until the run ends). */
export interface ToolDetachHub extends ToolDetachPort {
  request(callId: string): void;
}

export function createToolDetachHub(): ToolDetachHub {
  const listeners = new Set<(callId: string) => void>();
  return {
    onRequest(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    request(callId) {
      for (const cb of [...listeners]) cb(callId);
    },
  };
}

/** The follow-up injection (a steering-lane user message) carrying the landed
 *  background result. Pure; the consumer truncates to its own tail budget.
 *  `summary` is the surface's one-line call summary (may be empty). */
export function formatDetachedResultInjection(toolName: string, summary: string, result: string): string {
  const head = summary === "" ? toolName : `${toolName}(${summary})`;
  return `[后台工具完成] ${head}\n${result}`;
}

/** The idle-seam/human notice when a background task lands (the monitor 👁
 *  family's detach sibling). Pure. */
export const DETACH_LANDING_NOTICE_PREFIX = "🔄 后台工具完成";
