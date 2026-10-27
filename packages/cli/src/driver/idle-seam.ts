// 拆分运动（借鉴弧 δ 顺带件，file-size 棘轮「把压力推向拆分」）：driver 的
// 空闲轮询缝五胞胎外提为一家。cron（M61 §1）/peer（M64-A §A）/childMail
// （ω99-57）/monitor（ω-4a）/detach（弧 δ）的 poll+start+stop 三件完全同形：
// 同一持有谓词（busy/interrupted/compactionAbort/active/disposed——ω99-45 的
// 压缩持有含在内）、同一 drain-then-startRun 语义、同一 unref'd 定时器、同一
// 「timer 已在则 no-op」的 start 守卫。逐字节搬家：各缝的 notice 文案、启动
// 条件（车道存在与否/refusal）、drain 源全部原样作为参数——行为零变化。
//
// 124 项 1（dsh b6775f6d4f 教训核对，121 §5「唤醒链无默认上限」不变量）—
// ours-not-theirs 注记：dsh 的后台完成通知链曾带 maxConsecutiveWakes=3 的
// 默认唤醒预算，预算耗尽后「第 4 个通知不再唤醒、会话死到用户敲键」（issue
// #641 实证），回滚才改为 opt-in。wudao 的对应唤醒面=本缝（五条 idle seam
// 的 drain→landed），设计上**没有任何唤醒计数/预算**：poll 是无界次数的区间
// 轮询，注入队列是无界 FIFO，唤醒只被 hold 谓词暂时扣住（busy/压缩窗/前端
// 不活跃/dispose——全是暂态或终态，解除即恢复 drain）。家族里仅有的三个有界
// 计数器全部以「通知 + 休止态 + 显式手动重开口」收尾，绝不静默停摆：
//   • quota-park 唤醒重排上限 QUOTA_PARK_REARM_CAP=5（agent-driver 的
//     handleQuotaWake——耗尽即 ⚠️ 通知 + 停止自动重试，会话停在 parked
//     休止态而非忙等）；
//   • 同会话停泊上限 QUOTA_PARK_MAX_PER_SESSION=8（第 9 次放弃=error 终态
//     + 如实归因行）；
//   • schedules 连败熔断 SCHEDULE_BREAKER_FAILURES=3（⚠️ 通知 + 自动暂停
//     + /schedule unpause 重开）。
// 不变量（后续维护者必守）：给本缝或任何后台完成唤醒链加「连续唤醒上限」
// 之前，先读 121 §5——任何预算耗尽路径必须以用户可见通知 + 可恢复休止态
// 收尾，永不许「不通知、不再唤醒、干等到用户敲键」的 dsh 形态。钉子测试：
// detach-lane.test.ts 的「N 连续落定全唤醒」+ quota-park.test.ts 的重排
// 耗尽钉。
export interface IdleSeamDeps {
  /** The interval (unref'd — the seam never keeps the process alive). */
  readonly intervalMs: number;
  /** The family's ONE hold predicate (identical across the five seams). */
  readonly held: () => boolean;
  /** The arm condition — false keeps the timer off (the lane's runtime is
   *  absent, or refused). Evaluated in start() only, like the originals. */
  readonly armable: () => boolean;
  /** One pending injection, or undefined (each seam's own drain source). */
  readonly drain: () => string | undefined;
  /** Fire the landed injection (each seam's own notice line + startRun). */
  readonly landed: (text: string) => void;
}

export interface IdleSeam {
  /** The tick body (held → return; drained → landed). Also callable directly. */
  poll(): void;
  /** Arm the unref'd timer (no-op when already armed or not armable). */
  start(): void;
  /** Disarm (idempotent). */
  stop(): void;
}

export function createIdleSeam(deps: IdleSeamDeps): IdleSeam {
  let timer: ReturnType<typeof setInterval> | null = null;
  const seam: IdleSeam = {
    poll: () => {
      if (deps.held()) return;
      const text = deps.drain();
      if (text !== undefined) deps.landed(text);
    },
    start: () => {
      if (timer !== null || !deps.armable()) return;
      timer = setInterval(() => seam.poll(), deps.intervalMs);
      timer.unref?.();
    },
    stop: () => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    },
  };
  return seam;
}

/** The idle-seam family's status-poll cousin (M30's bg-count poll, moved here
 *  in the same 拆分运动): same unref'd-timer discipline, but it samples a
 *  derived status and reports CHANGES instead of draining injections.
 *  onChange fires only on change (the original emit-only-on-change law);
 *  get() is the old closure state's read face. */
export interface BgStatus {
  readonly active: number;
  readonly spawned: number;
}

export interface StatusPoll {
  poll(): void;
  start(): void;
  stop(): void;
  /** The latest sample (zeros before the first poll — the old initial state). */
  get(): BgStatus;
}

export function createStatusPoll(deps: {
  readonly intervalMs: number;
  readonly armable: () => boolean;
  /** The derived sample, or undefined when the source is absent this tick. */
  readonly sample: () => BgStatus | undefined;
  /** Fires after a CHANGED sample lands (the caller's emit). */
  readonly onChange: () => void;
}): StatusPoll {
  let timer: ReturnType<typeof setInterval> | null = null;
  let latest: BgStatus = { active: 0, spawned: 0 };
  const poll = (): void => {
    const next = deps.sample();
    if (next === undefined) return;
    if (next.active === latest.active && next.spawned === latest.spawned) return;
    latest = next;
    deps.onChange();
  };
  const start = (): void => {
    if (timer !== null || !deps.armable()) return;
    poll();
    timer = setInterval(poll, deps.intervalMs);
    timer.unref?.();
  };
  const stop = (): void => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };
  return { poll, start, stop, get: () => latest };
}
