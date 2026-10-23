// ω99-313 — the structured-calendar scheduling pure layer's deterministic
// acceptance: computeNextRun (at/every/weekly, LOCAL timezone Date math),
// dueSchedules, and the missed-fire catch-up semantics (one fire per gap,
// nextRun recomputed from NOW after the catch-up — the nanobot paradigm).
// Fixtures are pure values; the tmpdir store tests live in the daemon file.
import { describe, it, expect } from "vitest";
import {
  computeNextRun,
  dueSchedules,
  applyMissedFire,
  describeScheduleHuman,
  SCHEDULE_MIN_INTERVAL_MS,
} from "../src/schedules.js";

// A fixed local Monday: 2026-09-14 is a Monday.
const MON = new Date("2026-09-14T08:00:00").getTime();
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "aaaaaaaa",
  prompt: "p",
  workspace: "/w",
  createdFrom: "t",
  createdAt: MON,
  ...over,
});

describe("ω99-313 computeNextRun — at（本地时区一次性）", () => {
  it("future at → the at timestamp itself", () => {
    expect(computeNextRun({ type: "at", at: MON + 5 * MIN }, MON)).toBe(MON + 5 * MIN);
  });
  it("past/equal at → undefined (one-shot is gone; creation refuses the past)", () => {
    expect(computeNextRun({ type: "at", at: MON - 1 }, MON)).toBeUndefined();
    expect(computeNextRun({ type: "at", at: MON }, MON)).toBeUndefined();
  });
});

describe("ω99-313 computeNextRun — every（间隔循环）", () => {
  it("strictly after `from`: from + intervalMs", () => {
    expect(computeNextRun({ type: "every", intervalMs: 10 * MIN }, MON)).toBe(MON + 10 * MIN);
    expect(computeNextRun({ type: "every", intervalMs: 10 * MIN }, MON + 3 * MIN)).toBe(MON + 13 * MIN);
  });
});

describe("ω99-313 computeNextRun — weekly（本地时区周循环）", () => {
  it("same weekday, later time → today at HH:MM", () => {
    // Monday 08:00, weekly Mon 09:00 → today 09:00.
    expect(computeNextRun({ type: "weekly", weekdays: [1], time: "09:00" }, MON)).toBe(
      new Date("2026-09-14T09:00:00").getTime(),
    );
  });
  it("same weekday, earlier time → the NEXT matching weekday", () => {
    // Monday 08:00, weekly Mon 07:00 → next Monday 07:00.
    expect(computeNextRun({ type: "weekly", weekdays: [1], time: "07:00" }, MON)).toBe(
      new Date("2026-09-21T07:00:00").getTime(),
    );
  });
  it("multiple weekdays pick the soonest match (Mon+Wed from Monday 10:00 → Wednesday)", () => {
    expect(computeNextRun({ type: "weekly", weekdays: [1, 3], time: "09:00" }, new Date("2026-09-14T10:00:00").getTime())).toBe(
      new Date("2026-09-16T09:00:00").getTime(),
    );
  });
  it("wraps the week (Friday → next Monday) and honors Sunday=0", () => {
    const FRI = new Date("2026-09-18T10:00:00").getTime();
    expect(computeNextRun({ type: "weekly", weekdays: [0, 1], time: "09:00" }, FRI)).toBe(
      new Date("2026-09-20T09:00:00").getTime(), // Sunday 2026-09-20
    );
  });
});

describe("ω99-313 dueSchedules — the due filter", () => {
  it("due = nextRunAt <= now AND enabled AND not paused; others filtered", () => {
    const now = MON + 10 * MIN;
    const entries = [
      base({ id: "due00001", nextRunAt: MON + 5 * MIN }),
      base({ id: "future01", nextRunAt: MON + 30 * MIN }),
      base({ id: "paused01", nextRunAt: MON + 5 * MIN, paused: true }),
      base({ id: "off00001", nextRunAt: MON + 5 * MIN, enabled: false }),
      base({ id: "legacy001" }), // no materialized nextRunAt → not due here
    ];
    const due = dueSchedules(entries, now);
    expect(due.map((t) => t.id)).toEqual(["due00001"]);
  });
});

describe("ω99-313 applyMissedFire — 缺火只补一次 + nextRun 从 now 重算", () => {
  it("a task that came due while away fires ONCE: nextRunAt clamps to now (not per missed occurrence)", () => {
    const now = MON + 5 * DAY; // 5 days late on a 1-hour cadence = ~120 missed occurrences
    const { entries, missedIds } = applyMissedFire(
      [base({ id: "missed01", nextRunAt: MON + MIN })],
      now,
    );
    expect(missedIds).toEqual(["missed01"]);
    expect(entries[0]!.nextRunAt).toBe(now); // ONE catch-up fire, at boot
  });
  it("after the catch-up fire, nextRun recomputes from the fire time (now), not the stale schedule", () => {
    const now = MON + 5 * DAY;
    const firedAt = now; // the daemon fires the catch-up immediately at boot
    const next = computeNextRun({ type: "every", intervalMs: 60 * MIN }, firedAt);
    expect(next).toBe(now + 60 * MIN);
  });
  it("not-due and legacy entries pass through untouched", () => {
    const now = MON + 10 * MIN;
    const future = base({ id: "future01", nextRunAt: MON + DAY });
    const legacy = base({ id: "legacy001", lastFiredAt: MON - DAY });
    const { entries, missedIds } = applyMissedFire([future, legacy], now);
    expect(missedIds).toEqual([]);
    expect(entries[0]).toBe(future);
    expect(entries[1]).toBe(legacy);
  });
  it("disabled/paused entries are never catch-up candidates", () => {
    const now = MON + DAY;
    const { missedIds } = applyMissedFire(
      [
        base({ id: "off00001", nextRunAt: MON, enabled: false }),
        base({ id: "paused01", nextRunAt: MON, paused: true }),
      ],
      now,
    );
    expect(missedIds).toEqual([]);
  });
});

describe("ω99-313 describeScheduleHuman — 人话触发器文案", () => {
  it("weekly: 每周一 09:00 形（无 cron 内部词）", () => {
    const text = describeScheduleHuman({ type: "weekly", weekdays: [1], time: "09:00" });
    expect(text).toContain("每周一");
    expect(text).toContain("09:00");
    expect(text).not.toMatch(/cron|\*/);
  });
  it("weekly multi-day: 每周一、周三 09:00", () => {
    expect(describeScheduleHuman({ type: "weekly", weekdays: [1, 3], time: "09:00" })).toBe("每周一、周三 09:00");
  });
  it("every: 每 N 分钟 / 每 N 小时", () => {
    expect(describeScheduleHuman({ type: "every", intervalMs: 15 * MIN })).toBe("每 15 分钟");
    expect(describeScheduleHuman({ type: "every", intervalMs: 2 * 60 * MIN })).toBe("每 2 小时");
  });
  it("at: 本地时间一次（M月D日 HH:mm）", () => {
    expect(describeScheduleHuman({ type: "at", at: new Date("2026-09-15T09:00:00").getTime() })).toBe("9月15日 09:00 一次");
  });
});

describe("ω99-313 SCHEDULE_MIN_INTERVAL_MS — the every-cadence floor", () => {
  it("is one minute (the daemon tick's resolution)", () => {
    expect(SCHEDULE_MIN_INTERVAL_MS).toBe(60_000);
  });
});
