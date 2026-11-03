// 135 §5.3 — `observeRun`：把一个 loop 的 AsyncGenerator 原样转发，旁路累积时刻。
//
// 关键契约（由测试钉死）：
//   · **逐事件透传**：消费者看到的对象与内层产出的**同一引用**（不是拷贝）；
//     因此 observe 开关不改变任何下游可见字节。
//   · **返回值逐位透传**：Terminal 原样返回。
//   · **消费侧失败被隔离**：投影/导出抛错 → 打一条 warn 计数，事件照常转发。
//   · **结算时机**：内层正常结束 / 抛错 / 被消费者提前 return()，都在 finally 里
//     结算一次（且只结算一次）。
//   · 关闭（未传 opts 或 sink）时返回**原 generator**（同一引用）——构造层面零开销，
//     与 probe.ts 的纪律一致。

import type { LoopEvent } from "../loop.js";
import type { Terminal } from "../types.js";
import { projectTrace, type TimedLoopEvent, type TraceRun } from "./projection.js";
import type { ContentMode } from "./attrs.js";

export interface ObserveRunOptions {
  /** 会话身份（进 traceId 种子）。 */
  readonly sessionId?: string;
  /** 内容策略。缺省 hash。 */
  readonly contentMode?: ContentMode;
  readonly homeDir?: string;
  /** 时钟注入（测试用）。缺省 Date.now。 */
  readonly now?: () => number;
  /** 结算回调：收到完整 TraceRun。抛错被吞（不影响运行）。 */
  readonly onSettled: (run: TraceRun) => void;
  /** 观测自身的失败计数（可选，供 /probe 类读面）。 */
  readonly onError?: (error: unknown) => void;
}

/** 观察一个 run：返回的 generator 在内层结束时结算一次 TraceRun。 */
export function observeRun(
  gen: AsyncGenerator<LoopEvent, Terminal>,
  opts: ObserveRunOptions | undefined,
): AsyncGenerator<LoopEvent, Terminal> {
  if (opts === undefined) return gen;
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const events: TimedLoopEvent[] = [];
  let settled = false;

  const settle = (terminal?: Terminal): void => {
    if (settled) return;
    settled = true;
    try {
      const run = projectTrace(events, {
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
        ...(opts.contentMode !== undefined ? { contentMode: opts.contentMode } : {}),
        ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
        runStartedAtMs: startedAt,
        ...(terminal !== undefined ? { terminal } : {}),
      });
      opts.onSettled(run);
    } catch (err) {
      try {
        opts.onError?.(err);
      } catch {
        /* 观测的观测也失败——到此为止，运行继续。 */
      }
    }
  };

  // .next()/.return()/.throw() 三者都必须转发给内层——消费者用
  // `run.return()` 提前关闭（driver 的 detach 路径）时，内层 loop 自己的
  // 清理（finally、租约释放、session 收尾）必须照跑。少了这条转发，
  // 包装层就成了"吞掉 return"的黑洞。
  return (async function* observed(): AsyncGenerator<LoopEvent, Terminal> {
    let terminal: Terminal | undefined;
    try {
      while (true) {
        const step = await gen.next();
        if (step.done === true) {
          terminal = step.value;
          return step.value;
        }
        // 记录时刻 + 事件，然后**原样**转发同一个对象。
        events.push({ at: now(), event: step.value });
        try {
          yield step.value;
        } catch (err) {
          // 消费者向生成器 throw：按 for-await 语义转进内层。
          await gen.throw(err as Error);
          return undefined as never;
        }
      }
    } finally {
      settle(terminal);
      // 无论正常结束、抛错还是被 return()：内层都收到一次 return（幂等）。
      try {
        await gen.return(undefined as never);
      } catch {
        /* 内层清理失败不影响已在 finally 里完成的结算。 */
      }
    }
  })();
}
