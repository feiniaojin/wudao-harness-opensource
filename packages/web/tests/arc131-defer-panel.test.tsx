// 131 弧 B — web 面收据：defer（idle）行在定时面板的呈现。
// 下次格 = 「等空闲/等用户空闲」（不是日期）；trigger 人话直渲染
// describeScheduleHuman 的 idle 形；老 server 行（无 triggerKind）零变化。
import { describe, expect, it } from "vitest";
import { schedulesPanelModel } from "../src/components/SchedulesPanel.js";
import type { ScheduleListRow } from "../src/protocol.js";

const T0 = new Date("2026-09-29T12:00:00").getTime();
const base = (over: Partial<ScheduleListRow>): ScheduleListRow => ({
  id: "aaaaaaaa",
  kind: "task",
  prompt: "重构 utils 目录",
  trigger: "空闲 ≥15 分钟后一次",
  nextRunAt: null,
  enabled: true,
  paused: false,
  lastFiredAt: null,
  consecutiveFailures: 0,
  ...over,
} as ScheduleListRow);

describe("131 面板 — idle 行的呈现", () => {
  it("triggerKind=idle：下次格 = 等用户空闲（钟面已过最早时刻）/ 等空闲（未到）", () => {
    const rows = schedulesPanelModel(
      [
        base({ triggerKind: "idle", nextRunAt: T0 - 5 * 60_000 }),
        base({ id: "bbbbbbbb", triggerKind: "idle", nextRunAt: T0 + 30 * 60_000 }),
      ],
      null,
      () => T0,
    );
    expect(rows[0]!.nextText).toBe("等用户空闲"); // 最早可火时刻已过——真等空闲
    expect(rows[1]!.nextText).toBe("等空闲");
    expect(rows[0]!.trigger).toBe("空闲 ≥15 分钟后一次");
    expect(rows[0]!.triggerKind).toBe("idle");
  });

  it("老 server 行（无 triggerKind）照旧 calendar——零漂移", () => {
    const rows = schedulesPanelModel([base({ nextRunAt: T0 + 60_000 })], null, () => T0);
    expect(rows[0]!.triggerKind).toBe("calendar");
    expect(rows[0]!.nextText).toContain("9月29日");
  });
});
