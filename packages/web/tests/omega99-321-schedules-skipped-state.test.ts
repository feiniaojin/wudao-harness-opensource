// ω99-321 — 上次结果第三态（busy-skip 落账后的渲染契约）：mode==="skipped"
// 先判（ok:true 只是「不失败」占位——不先判会把跳过显示成「跑成了」）；
// mode 缺席的老条目零变化（跑成了/没跑成照旧）；无 lastRun → 「上次触发」
// 回落照旧。纯函数直钉（schedulesPanelModel 是 cell 文案单一事实源——317
// 范式）。夹具零文件系统。
import { describe, it, expect } from "vitest";
import { schedulesPanelModel } from "../src/components/SchedulesPanel.js";
import type { ScheduleListRow } from "../src/protocol.js";

const T0 = new Date(2026, 8, 14, 8, 0).getTime(); // 2026-09-14 08:00 LOCAL
const MIN = 60_000;

/** 本地时区的 M月D日 HH:mm 参照（面板 cell 的格式契约）。 */
const fmtRef = (ts: number): string => {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
};

const sched = (over: Partial<ScheduleListRow> & { id: string }): ScheduleListRow => ({
  kind: "task",
  prompt: "每天 09:00 整理收件箱",
  trigger: "每天 09:00",
  nextRunAt: T0 + 60 * MIN,
  enabled: true,
  paused: false,
  ...over,
});

describe("ω99-321 — lastRun 第三态（mode 先判、ok 后判）", () => {
  const now = (): number => T0;

  it("mode=skipped（ok:true 占位）→ 会话忙，跳过了；绝不说「跑成了」", () => {
    const rows = schedulesPanelModel(
      [sched({ id: "skipped01", lastRun: { ok: true, at: T0 - 30 * MIN, mode: "skipped" } })],
      null,
      now,
    );
    expect(rows[0]!.lastText).toBe(`上次 ${fmtRef(T0 - 30 * MIN)} 会话忙，跳过了`);
    expect(rows[0]!.lastText).not.toContain("跑成了"); // ok:true 占位不得翻成「跑成了」
  });

  it("mode=continue 照旧「跑成了」；mode 缺席 ok:true（老 spawn 条目）零变化", () => {
    const rows = schedulesPanelModel(
      [
        sched({ id: "cont00001", lastRun: { ok: true, at: T0 - 5 * MIN, mode: "continue" } }),
        sched({ id: "legacy001", lastRun: { ok: true, at: T0 - 10 * MIN } }),
      ],
      null,
      now,
    );
    expect(rows[0]!.lastText).toContain("跑成了");
    expect(rows[0]!.lastText).toContain(fmtRef(T0 - 5 * MIN));
    expect(rows[1]!.lastText).toContain("跑成了"); // 老数据：无 mode 走原路
  });

  it("mode 缺席 ok:false → 没跑成（+连败后缀照旧叠加）", () => {
    const rows = schedulesPanelModel(
      [
        sched({ id: "fail00001", lastRun: { ok: false, at: T0 - 15 * MIN } }),
        sched({ id: "flaky0001", consecutiveFailures: 2, lastRun: { ok: false, at: T0 - 10 * MIN } }),
      ],
      null,
      now,
    );
    expect(rows[0]!.lastText).toContain("没跑成");
    expect(rows[1]!.lastText).toContain("没跑成");
    expect(rows[1]!.lastText).toContain("已连败 2 次"); // 后缀逻辑与第三态正交
  });

  it("无 lastRun → 「上次触发 …」回落照旧（busy-skip 前/未落账时代的行为）", () => {
    const rows = schedulesPanelModel(
      [sched({ id: "fired0001", lastFiredAt: T0 - 2 * MIN })],
      null,
      now,
    );
    expect(rows[0]!.lastText).toBe(`上次触发 ${fmtRef(T0 - 2 * MIN)}`);
  });
});
