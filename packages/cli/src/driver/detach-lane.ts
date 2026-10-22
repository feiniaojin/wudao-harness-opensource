// 借鉴弧 δ（v7 第三梯队，the upstream harness 367ab084 思想）— 运行中工具调用
// 转后台的 CLI 侧车道。core 的 loop 只管三腿赛跑与合成配对；本模块拥有
// 机制外的一切会话态：
//   • typed 裁决（detach()）：在请求口就拒掉不该转的工具——block 族
//     （interruptBehavior:"block"，取消本身就是危险，比移后台强）与
//     「没有在飞调用」（not_in_flight）。裁决材料=驱动面的 busyTools +
//     工具表（the upstream harness 的 409 not_detachable 对应件）。
//   • 收集登记（register()）：loop 的 onDetachedCall 把仍在跑的执行承诺
//     交到这里；落定时格式化为注入文本排队。结果注入走既有后台结果
//     车道——run 在飞时被 take() 在 monitor 之后 drain（轮尾并入，前缀
//     字节稳定），空闲时被 pollDetach 以新轮消费（ω-4a monitor 的姊妹
//     缝，M24 同律）。
//   • 一并停（stopAll()）：用户显式停止（Esc/interrupt/dispose）时 abort
//     每个在飞后台任务的 per-call controller（用户意图优先）——shell 族
//     收到的是进程组 TERM→KILL；已停任务落定的结果不再注入，只回执一行。
// 裁决的诚实窗口：帧到点击之间调用可能已自然落定——loop 会忽略该请求，
// 下一帧即真相（verdict 的 ok 是乐观的，行为不撒谎）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import {
  createToolDetachHub,
  formatDetachedResultInjection,
  type DetachedCall,
  type ToolDetachHub,
} from "@wudao/core";
import type { Tool } from "@wudao/core";

/** The landed-result tail budget riding the injection (monitor's inline
 *  payload discipline — the full output, when huge, already spilled by the
 *  tool's own M24 seam; the injection carries the actionable head). */
export const DETACH_RESULT_INJECTION_CHARS = 2000;

/** The history receipt when a detached call's batch closes (the driver's
 *  finished(backgrounded) event — the TRUTH-point receipt: the request may
 *  have lost to a natural settle, so the verdict itself never pre-writes
 *  history). Pure. */
export function backgroundedNotice(name: string | undefined, summary: string | undefined): string {
  const tool = name ?? "工具";
  const head = summary !== undefined && summary !== "" ? `${tool}(${truncateSafe(summary, 60)})` : tool;
  return `🔄 已转入后台：${head}——完成后自动并入对话`;
}

/** the upstream's 409 shape: the typed refusal at the request site. */
export type DetachVerdict =
  | { readonly kind: "ok"; readonly callId: string; readonly toolName: string }
  | { readonly kind: "refused"; readonly reason: "not_in_flight" | "not_detachable"; readonly toolName?: string };

export function describeDetachVerdict(v: DetachVerdict): string {
  switch (v.kind) {
    case "ok":
      return `🔄 已转入后台：${v.toolName}——完成后自动并入对话`;
    case "refused":
      if (v.reason === "not_detachable") return `⏳ ${v.toolName ?? "该工具"} 不可转后台（不可中断族——等待其结束，或 Esc 停止整个运行）`;
      return "（当前没有可转后台的在飞工具）";
  }
}

interface RunningTask {
  readonly toolName: string;
  readonly summary: string;
  readonly controller: AbortController;
  cancelled: boolean;
}

export interface DetachLane {
  /** The loop-options hub (thread as LoopOptions.toolDetach; the driver
   *  pairs it with its own onDetachedCall closure that resolves the call's
   *  display summary from the run's toolMeta before register()). */
  readonly loopOptions: { readonly toolDetach: ToolDetachHub };
  /** register a freshly-detached execution (summary = the surface's one-line
   *  call summary; the injection names the call for the model). */
  register(detached: DetachedCall, summary: string): void;
  /** The typed user face. `busyTools` is the driver's LIVE in-flight list
   *  ({name, callId?} rows); `tools` the session tool table (block-family
   *  lookup). callId undefined = the FIRST detachable row (the usual
   *  one-long-tool-run case). */
  detach(callId: string | undefined, busyTools: readonly { readonly name: string; readonly callId?: string }[], tools: readonly Tool[]): DetachVerdict;
  /** One pending landed-result injection, or undefined (steering drain +
   *  idle seam both pull here — the monitor queue's exact discipline). */
  takeInjection(): string | undefined;
  /** Abort every running background task (an explicit user stop — never a
   *  run boundary: the run closing is the whole point of detach). */
  stopAll(): void;
  /** Running (unsettled) background tasks — observability/telemetry face. */
  runningCount(): number;
}

export function createDetachLane(opts: {
  /** A history notice (the ⏹ receipt when a stopped task settles). */
  readonly onNotice: (text: string) => void;
  /** State-change ping (status refresh; never throws). */
  readonly onChange?: () => void;
}): DetachLane {
  const hub = createToolDetachHub();
  const running = new Map<string, RunningTask>(); // callId → task
  const queue: string[] = [];
  const detachableTool = (name: string, tools: readonly Tool[]): Tool | undefined =>
    tools.find((t) => t.name === name);

  const register = (detached: DetachedCall, summary: string): void => {
    const task: RunningTask = {
      toolName: detached.call.name,
      summary,
      controller: detached.controller,
      cancelled: false,
    };
    running.set(detached.call.id, task);
    opts.onChange?.();
    // The collector: the loop handed a promise that never rejects; its
    // normalized message IS the tool result the model would have seen.
    void detached.result.then((outcome) => {
      running.delete(detached.call.id);
      if (task.cancelled) {
        opts.onNotice(`⏹ 后台任务已按用户停止：${task.toolName}${task.summary !== "" ? `(${task.summary})` : ""}`);
        opts.onChange?.();
        return;
      }
      const content = outcome.message.content.length > DETACH_RESULT_INJECTION_CHARS
        ? `${truncateSafe(outcome.message.content, DETACH_RESULT_INJECTION_CHARS)}\n…(已截断，完整输出见工具自身的落盘回执)`
        : outcome.message.content;
      queue.push(formatDetachedResultInjection(task.toolName, task.summary, content));
      opts.onChange?.();
    });
  };

  return {
    loopOptions: {
      toolDetach: hub,
    },
    register,
    detach(callId, busyTools, tools) {
      const rows = busyTools.filter((t): t is { name: string; callId: string } => typeof t.callId === "string");
      let target: { name: string; callId: string } | undefined;
      if (callId !== undefined) {
        target = rows.find((t) => t.callId === callId);
        if (target === undefined) return { kind: "refused", reason: "not_in_flight" };
      } else {
        // Bare detach: the FIRST detachable row (rows without a callId are
        // pre-ω99-63 shapes; block-family rows are skipped for a later one).
        target = rows.find((t) => detachableTool(t.name, tools)?.interruptBehavior !== "block");
        if (target === undefined) {
          const anyRow = rows[0];
          if (anyRow !== undefined && detachableTool(anyRow.name, tools)?.interruptBehavior === "block") {
            return { kind: "refused", reason: "not_detachable", toolName: anyRow.name };
          }
          return { kind: "refused", reason: "not_in_flight" };
        }
      }
      const tool = detachableTool(target.name, tools);
      if (tool !== undefined && tool.interruptBehavior === "block") {
        return { kind: "refused", reason: "not_detachable", toolName: target.name };
      }
      hub.request(target.callId);
      return { kind: "ok", callId: target.callId, toolName: target.name };
    },
    takeInjection: () => queue.shift(),
    stopAll: () => {
      for (const task of running.values()) {
        task.cancelled = true;
        try { task.controller.abort(); } catch { /* already aborted */ }
      }
      opts.onChange?.();
    },
    runningCount: () => running.size,
  };
}
