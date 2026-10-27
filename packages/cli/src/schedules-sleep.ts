// 122 项 1 — 临火睡眠守卫（near-fire sleep guard）。缺口（用户令「一定能
// 唤起执行」）：prevent-sleep.ts 的 caffeinate -i 只在 agent run 活跃时持有；
// 等 fire 的间隙不持有 → Mac 在火前入睡 → 计时器冻结 → 火延迟到唤醒后（不是
// 用户要的「3 点准时」）。本模块补另一半：fire 临近时（缺省 10 分钟窗，可经
// settings 的 schedules.sleepGuardMs 配，0=关）守护持有一份 prevent-sleep
// 断言，火落（表前进）或任务删除/暂停后释放。
//
// 语义细节（测试钉死）：
// - 多任务取最近的 wake 时刻（min over nextFireOf + 武装中的 missRetryAt）；
//   paused/disabled 任务不参与（tick 对它本就免单——停用期间不欠新账）。
// - 已到期/过去的 wake 时刻也算「临火」：fire 正在发射或在途。cron 车道的
//   spawn run 结束前表不会前进（advanceAfterFire 在 run 之后 persist），所以
//   守卫自然把断言持满整个在途 run——恰好盖住「父进程释放→子进程 caffeinate
//   还没起」的引导缝；继续车道则交给宿主 driver 的 busy 守卫（refCount 叠加，
//   互不互斥）。
// - refCount 纪律：守卫只 acquire/release 自己那一票，绝不用 forceStop（那
//   会把同进程其它持有者——driver 的活跃 run 守卫——的断言一起拆了）。
// - 事件任务（file/webhook）无 wake 时刻：信号不因守门而更早到达，不参与。
//   应用完全关闭的场景是缺口 2（launchd LaunchAgent），见
//   docs/research/122-launchagent-design.md——本模块不解决也不假装解决。

import { defaultPreventSleep } from "./prevent-sleep.js";
import type { PreventSleepController } from "./prevent-sleep.js";
import { SCHEDULE_NEAR_FIRE_GUARD_MS } from "./schedules-model.js";
import type { DurableTask } from "./schedules-model.js";
import { nextFireOf } from "./schedules-logic.js";

/** The nearest moment this table owes a wake: min over every live task's
 *  next fire (nextFireOf — paused/disabled/event refused) and an armed
 *  missRetryAt (a bounded re-fire is as much a wake moment as a natural
 *  fire). Pure; exported for tests. */
export function nearestWakeAt(tasks: readonly DurableTask[], at: number): number | undefined {
  let nearest: number | undefined;
  for (const t of tasks) {
    // The explicit skip also gates missRetryAt below: tick WAIVES a paused/
    // disabled task's retry — a waived fire owes no wake.
    if (t.paused === true || t.enabled === false) continue;
    const fire = nextFireOf(t, at);
    if (fire !== undefined && (nearest === undefined || fire < nearest)) nearest = fire;
    const retry = t.missRetryAt;
    if (retry !== undefined && (nearest === undefined || retry < nearest)) nearest = retry;
  }
  return nearest;
}

export interface NearFireGuardOptions {
  /** Observable controller (tests inject a counting fake); default = the
   *  process-wide shared controller (env-gated off for the cli test env). */
  readonly controller?: PreventSleepController;
  /** The near-fire window in ms (0 disables the guard). Default
   *  SCHEDULE_NEAR_FIRE_GUARD_MS (10 min) — must comfortably exceed the
   *  daemon's tick cadence or the guard engages only at/after due-ness. */
  readonly nearFireMs?: number;
  /** The daemon's clock seam (same `now` the due-ness math uses). */
  readonly now: () => number;
}

export interface NearFireGuard {
  /** Idempotent derived-state sync over the LIVE table: (re)compute the
   *  nearest wake moment and acquire/release accordingly. Redundant calls
   *  no-op; the daemon calls it at every table mutation and every tick. */
  sync(tasks: readonly DurableTask[]): void;
  /** Drop this guard's hold (daemon stop). Only ever its own vote — other
   *  holders on the shared controller keep the assertion. */
  release(): void;
  /** Introspection for tests. */
  holding(): boolean;
}

export function createNearFireGuard(options: NearFireGuardOptions): NearFireGuard {
  const controller = options.controller ?? defaultPreventSleep();
  const nearFireMs = options.nearFireMs ?? SCHEDULE_NEAR_FIRE_GUARD_MS;
  const now = options.now;
  let held = false;
  return {
    sync(tasks) {
      if (nearFireMs <= 0) return;
      const at = now();
      const nearest = nearestWakeAt(tasks, at);
      // Inclusive window; a due/past moment counts (fire launching/in flight).
      const shouldHold = nearest !== undefined && nearest - at <= nearFireMs;
      if (shouldHold === held) return;
      held = shouldHold;
      if (shouldHold) controller.acquire();
      else controller.release();
    },
    release() {
      if (!held) return;
      held = false;
      controller.release();
    },
    holding() {
      return held;
    },
  };
}
