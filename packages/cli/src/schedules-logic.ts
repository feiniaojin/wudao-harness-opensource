// ω99 拆分运动 弧 B：schedules 纯调度逻辑外提（下次触发计算/结构化日程判定/
// due 判定/漏火处置/人读描述——原 schedules.ts 模块级段逐字保留；schedules.ts
// re-export 门面保公共面）。
import { nextFire, parseCronExpr } from "@wudao/core";
import type { CronTask } from "@wudao/core";
import type { DurableSchedule, DurableTask, StructuredSchedule } from "./schedules-model.js";
import { DEFER_IDLE_MAX_MINUTES, DEFER_IDLE_MIN_MINUTES, SCHEDULE_MIN_INTERVAL_MS, SCHEDULE_MISS_RETRY_DELAY_MS, validWeekdays, validTimeOfDay } from "./schedules-model.js";

/** The next effective fire for a durable task, or undefined when nothing is
 *  pending (a fired `at`, or an unmatchable cron). No catch-up: due-ness is
 *  computed from lastFiredAt ?? createdAt, so missed occurrences collapse. */
export function durableNextFire(task: DurableTask, now: number): number | undefined {
  // ω99-5a: a paused task has nothing pending — tick's due filter (which
  // routes through here) skips it naturally.
  if (task.paused === true) return undefined;
  // 借鉴弧 ε — event 触发没有「下次」概念（due-ness 由信号驱动，不
  // 由钟）——任何 fire 推导对它一律 undefined。
  if (task.schedule.type === "event") return undefined;
  // 131 弧 — idle 族的「下次」= 物化 nextRunAt（最早可火时刻；真火资格
  // 在 daemon 的空闲判定——这里只答钟面问题）。
  if (task.schedule.type === "idle") {
    return task.nextRunAt ?? task.createdAt + task.schedule.idleMinutes * 60_000;
  }
  // ω99-313: the structured variants (every/weekly) have their own fire math
  // in the pure layer — the stand-in below only speaks core's legacy
  // cron/at schedule shape. Same no-catch-up anchor as the docstring:
  // lastFiredAt ?? createdAt.
  if (task.schedule.type === "every" || task.schedule.type === "weekly") {
    return computeNextRun(task.schedule, task.lastFiredAt ?? task.createdAt);
  }
  if (task.schedule.type === "cron" && !parseCronExpr(task.schedule.expr).ok) return undefined;
  // A stand-in CronTask: expiresAt MAX keeps recurring semantics alive
  // forever (the §1 7-day expiry is session-task-only) and satisfies core's
  // isOneShotTask discrimination (`at` schedules self-delete on fire).
  const standIn: CronTask = {
    id: task.id,
    sessionId: "durable",
    prompt: task.prompt,
    schedule: task.schedule,
    createdAt: task.createdAt,
    ...(task.schedule.type === "cron" ? { expiresAt: Number.MAX_SAFE_INTEGER } : {}),
    ...(task.lastFiredAt !== undefined ? { lastFiredAt: task.lastFiredAt } : {}),
  };
  return nextFire(standIn, now)?.fireAt;
}

// ---------------------------------------------------------------------------
// ω99-313 — the structured-calendar pure layer: computeNextRun (LOCAL
// timezone Date math, zero third-party deps), dueSchedules, applyMissedFire
// (the missed-fire catch-up: ONE fire per gap — a task that came due while
// the app was away fires once on the next boot, never once per missed
// occurrence; after the catch-up the next run recomputes from NOW).
// ---------------------------------------------------------------------------

/** The every-cadence floor: the daemon ticks at a coarser resolution than
 *  this, and a tighter loop would spin the in-flight guard. */

/** Validate one structured trigger for CREATION (the store normalizer is the
 *  softer load-side twin). Returns the error text, or undefined when valid. */
export function structuredScheduleError(s: DurableSchedule): string | undefined {
  if (s.type === "every") {
    if (!Number.isInteger(s.intervalMs) || s.intervalMs < SCHEDULE_MIN_INTERVAL_MS) {
      return `间隔至少 ${Math.round(SCHEDULE_MIN_INTERVAL_MS / 60_000)} 分钟`;
    }
    return undefined;
  }
  if (s.type === "weekly") {
    if (!validWeekdays(s.weekdays)) return "星期取值 0-6（0=周日），至少一天";
    if (!validTimeOfDay(s.time)) return "时间形如 09:00（24 小时制）";
    return undefined;
  }
  // 131 弧 — idle 创建门：整数分钟，夹产品窗 [5,120]（越界值门口夹，不拒）。
  if (s.type === "idle") {
    if (!Number.isInteger(s.idleMinutes)) return "空闲等待分钟须为整数";
    return undefined;
  }
  return undefined;
}

/** Is this schedule one of the ω99-313 structured forms? (at/every/weekly —
 *  `at` predates 313 but shares the materialized-nextRunAt bookkeeping.) */
export function isStructuredSchedule(s: DurableSchedule): s is StructuredSchedule {
  return s.type === "at" || s.type === "every" || s.type === "weekly";
}

/** The next occurrence of a structured trigger STRICTLY AFTER `from`, in the
 *  LOCAL timezone (Date arithmetic — no third-party date library). Pure.
 *
 *  The structured family carries NO deterministic jitter (the M61 jitter
 *  exists for the cron-expression stampede; a hand-picked 「每周一 9 点」
 *  fires at its written time — that IS the product promise). */
export function computeNextRun(trigger: StructuredSchedule, from: number): number | undefined {
  switch (trigger.type) {
    case "at":
      return trigger.at > from ? trigger.at : undefined;
    case "every":
      return from + trigger.intervalMs;
    case "weekly": {
      // Scan the next 8 local days (a full week + the same weekday's second
      // chance); the FIRST candidate strictly after `from` wins.
      const [h, m] = trigger.time.split(":").map(Number) as [number, number];
      const start = new Date(from);
      start.setSeconds(0, 0);
      for (let offset = 0; offset <= 8; offset += 1) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset, h, m, 0, 0);
        if (day.getTime() > from && trigger.weekdays.includes(day.getDay())) return day.getTime();
      }
      return undefined;
    }
  }
}

/** The entries due at `now`: materialized nextRunAt passed, enabled, not
 *  paused. Legacy rows (no nextRunAt) are NOT due here — their due-ness
 *  lives on the durableNextFire derivation. Pure. */
export function dueSchedules(entries: readonly DurableTask[], now: number): readonly DurableTask[] {
  return entries.filter(
    (t) => t.enabled !== false && t.paused !== true && t.nextRunAt !== undefined && now >= t.nextRunAt,
  );
}

export interface MissedFireOutcome {
  /** The normalized table — due-while-away rows carry nextRunAt = now (they
   *  fire ONCE immediately; the fire then recomputes from the fire time). */
  readonly entries: readonly DurableTask[];
  /** The ids that came due while away (the boot catch-up set). */
  readonly missedIds: readonly string[];
}

/** The missed-fire catch-up (nanobot paradigm): everything that came due
 *  while the app was not running fires ONCE on the next boot — never once
 *  per missed occurrence. Pure: it CLAMPS stale nextRunAt values to `now`;
 *  the daemon's post-fire bookkeeping recomputes from the actual fire time,
 *  which is what collapses N missed occurrences into one. */
export function applyMissedFire(entries: readonly DurableTask[], now: number): MissedFireOutcome {
  const missedIds: string[] = [];
  const next = entries.map((t) => {
    if (t.enabled === false || t.paused === true || t.nextRunAt === undefined) return t;
    if (t.nextRunAt > now) return t;
    // A fired one-shot lingering in its snooze window is NOT a missed fire
    // (nextRunAt cleared; snoozeUntil governs) — the guard above already
    // skips it via nextRunAt === undefined.
    missedIds.push(t.id);
    return { ...t, nextRunAt: now };
  });
  return { entries: next, missedIds };
}

/** 借鉴弧 α3（hermes 思想）— 漏火补跑的武装判定（纯函数）：一次 cron fire
 *  失败后，是否给这个任务武装一次 missRetryAt。四门全过才武装：
 *   1. 仅 recurring（`at` 一次性任务失败即失败——没有「下一个自然周期」可
 *      期待，补跑会复活一个已自删的语义）；
 *   2. 没有awaiting中的补跑（不叠堆——missRetryAt 已在场即弃）；
 *   3. 任务活着（未暂停、未熔断停用）；
 *   4. 补跑时刻严格早于下一个自然 fire（hermes「不晚于 next_run_at」——
 *      自然周期都到了，补跑没有意义，只添乱）。
 *  输入的 task 应是 advanceAfterFire 之后的表内现行值（nextRunAt/lastFiredAt
 *  已前进），fireAt 是刚消耗的那次 fire 的时刻。 */
export function armMissRetry(
  task: DurableTask,
  fireAt: number,
  now: number,
  delayMs: number = SCHEDULE_MISS_RETRY_DELAY_MS,
): number | undefined {
  if (task.schedule.type === "at") return undefined;
  // 131 弧 — idle 同为一次性（失败即失败，没有可期待的自然周期）。
  if (task.schedule.type === "idle") return undefined;
  // 借鉴弧 ε — event 触发不武装补跑（「漏火补跑语义不适用」：信号是瞬态
  // 事实，没有可期待的自然周期；调用侧本就只对 cron fire 武装，这里是
  // 纯层的同语义双保险——nextFireOf(event) 恒 undefined 会让四门里的
  // 「早于自然 fire」门形同虚设，故在门口直拒）。
  if (task.schedule.type === "event") return undefined;
  if (task.missRetryAt !== undefined) return undefined;
  if (task.paused === true || task.enabled === false) return undefined;
  const retryAt = fireAt + delayMs;
  if (retryAt <= now) return undefined; // 已过期（延迟配置畸形或时钟跳变）——不补
  const natural = nextFireOf(task, now);
  if (natural !== undefined && retryAt >= natural) return undefined;
  return retryAt;
}

/** The 人话 trigger text for the list/UI faces (「每周一 9 点」 style — no
 *  cron internals, no JSONL vocabulary; the benefit-language law). */
export function describeScheduleHuman(s: DurableSchedule, now: () => number = Date.now): string {
  switch (s.type) {
    case "cron":
      return s.expr; // the legacy rows keep their raw expr (their author wrote it)
    case "at": {
      const d = new Date(s.at);
      return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 一次`;
    }
    case "every": {
      if (s.intervalMs % (60 * 60_000) === 0) return `每 ${s.intervalMs / (60 * 60_000)} 小时`;
      return `每 ${Math.round(s.intervalMs / 60_000)} 分钟`;
    }
    case "weekly": {
      const names = ["日", "一", "二", "三", "四", "五", "六"];
      const days = [...new Set(s.weekdays)].sort((a, b) => a - b).map((d) => `周${names[d]}`).join("、");
      return `每${days} ${s.time}`;
    }
    // 借鉴弧 ε — 事件触发的人话形（收益语：盯什么信号，不说机制词）。
    case "event":
      return s.source.kind === "file" ? `当「${s.source.path}」变化时` : "当收到 webhook 信号时";
    // 131 弧 — 闲时触发的人话形。
    case "idle":
      return `空闲 ≥${String(s.idleMinutes)} 分钟后一次`;
  }
}

/** The unified next-fire read for ONE task (pure): a materialized nextRunAt
 *  wins (the ω99-313 structured family); every/weekly rows missing one
 *  back-fill from their anchor; everything else (cron, pre-313 `at`) keeps
 *  the durableNextFire derivation — the legacy bytes stay legacy. */
export function nextFireOf(t: DurableTask, at: number): number | undefined {
  if (t.paused === true || t.enabled === false) return undefined;
  // 借鉴弧 ε — event 行永不物化 nextRunAt（fire 数学与它无关）。
  if (t.schedule.type === "event") return undefined;
  if (t.nextRunAt !== undefined) return t.nextRunAt;
  if (t.schedule.type === "every" || t.schedule.type === "weekly") {
    return computeNextRun(t.schedule, t.lastFiredAt ?? t.createdAt);
  }
  return durableNextFire(t, at);
}
