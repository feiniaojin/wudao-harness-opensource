// ω99-317 — 定时任务与提醒的管理面板（0.3.89 发了功能，本弧补「看/停/
// 试跑」闭环）：用户对「到点自己醒」的信任建立在「随时能看见它在干嘛」
// 上。面板行 = prompt 摘要 / 触发人话（313 结构化日历直渲染，复用行内
// trigger 字段——单一事实源，不做也不需要 cron 解析）/ 下次触发时间 /
// 上次结果（成功/失败/熔断，连败计数明示）/ 状态徽标（生效中/已暂停/
// 已停用熔断）/ 绑定会话名。动作三件：暂停恢复、立即试跑、删除——后两
// 者走家族确认弹框（.scrim>.modal-card，Esc 取消零 op）。熔断行的试跑 =
// 显式问「连败 N 次已熔断，仍要试跑？」（确认才带 resetBreaker 复位旗）。
// 纯展示组件——聚合纯函数 export 供 App 的 chip 与测试共用（216 范式）。
// 借鉴弧 ε：触发大类两分——calendar（看钟，下次格=日期）与 event（盯
// 信号，下次格=「等信号到达」，不带「下次」前缀）。triggerKind 加性缺省
// calendar，老 server 行零变化。
import React, { useEffect, useRef, useState } from "react";
import type { ScheduleListRow, SessionRow } from "../protocol.js";

/** One row as the panel renders it（聚合纯函数的输出形状）。 */
export interface SchedulePanelRow {
  readonly id: string;
  readonly kind: "task" | "reminder";
  /** prompt 摘要（≤80 字——面板行密度控制，不是数据层截断）。 */
  readonly promptText: string;
  /** 人话触发器（行字段直渲染——313 describeScheduleHuman 单一事实源）。 */
  readonly trigger: string;
  /** 借鉴弧 ε — 触发大类（event 行的「下次」格显示等信号，不带日期）；
   *  131 弧加 idle（「下次」格显示等空闲）。 */
  readonly triggerKind: "calendar" | "event" | "idle";
  readonly state: "active" | "paused" | "breaker";
  readonly stateText: string;
  /** 下次触发 cell（马上 · M月D日 HH:mm · 暂停/停用的收益语）。 */
  readonly nextText: string;
  /** 上次结果 cell（跑成了/没跑成/会话忙跳过了/连败 N 次已停用/还没跑过·响过/上次触发）。 */
  readonly lastText: string;
  /** 绑定会话名（sessions 行 join：name → firstUser 阶梯；null=未绑定/不 join）。 */
  readonly sessionName: string | null;
  /** 熔断态（试跑需过确认弹框 + resetBreaker 旗）。 */
  readonly breaker: boolean;
  /** 暂停态（toggle 按钮的现行方向）。 */
  readonly paused: boolean;
  /** 连败计数原值（熔断确认弹框的「连败 N 次」直引——不从文案反解析）。 */
  readonly failures: number;
}

/** 本地时区的 M月D日 HH:mm（面板 cell 的格式契约）。 */
function fmtCal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 聚合纯函数：ScheduleListRow[] → 面板行（状态/下次/上次/会话名的派生
 *  单一事实源——chip 计数直接用 rows.length，本函数管 cell 文案）。老
 *  server 行（无 317 加性字段）零崩：缺省即 null/0。same input → same
 *  output，纯函数供测试直钉。 */
export function schedulesPanelModel(
  rows: readonly ScheduleListRow[],
  sessions: readonly SessionRow[] | null,
  now: () => number = Date.now,
): readonly SchedulePanelRow[] {
  const nameOf = (id: string | undefined): string | null => {
    if (id === undefined || sessions === null) return null;
    const hit = sessions.find((s) => s.id === id);
    if (hit === undefined) return null;
    const label = hit.name?.trim() ?? "";
    return label !== "" ? label : hit.firstUser;
  };
  return rows.map((r) => {
    const paused = r.paused === true;
    const enabled = r.enabled !== false;
    const failures = r.consecutiveFailures ?? 0;
    const state: SchedulePanelRow["state"] = paused ? "paused" : enabled ? "active" : "breaker";
    const stateText = state === "paused" ? "已暂停" : state === "breaker" ? "已停用" : "生效中";
    const t = now();
    const isEvent = r.triggerKind === "event"; // 借鉴弧 ε：缺省 = calendar（老 server 行零变化）
    const isIdle = r.triggerKind === "idle"; // 131 弧：等空闲（钟面只是最早可火）
    let nextText: string;
    if (state === "paused") nextText = "已暂停——恢复后按计划继续";
    else if (state === "breaker") nextText = "已停用——恢复或试跑可重开";
    else if (isEvent) nextText = "等信号到达";
    else if (isIdle) nextText = r.nextRunAt !== null && r.nextRunAt !== undefined && r.nextRunAt <= t ? "等用户空闲" : "等空闲";
    else if (r.nextRunAt === null || r.nextRunAt === undefined) nextText = "无待跑";
    else nextText = r.nextRunAt <= t ? "马上" : fmtCal(r.nextRunAt);
    let lastText: string;
    if (state === "breaker") {
      lastText = `连败 ${failures} 次没跑成，已自动停用`;
    } else if (r.lastRun !== undefined && r.lastRun !== null) {
      // ω99-321: mode 先判——busy-skip 落账的 ok:true 只是「不失败」占位，
      // 先判 ok 会把跳过显示成「跑成了」。mode 缺席（老条目）零变化。
      const verdict = r.lastRun.mode === "skipped" ? "会话忙，跳过了" : r.lastRun.ok ? "跑成了" : "没跑成";
      lastText = `上次 ${fmtCal(r.lastRun.at)} ${verdict}`;
      if (failures > 0) lastText += `——已连败 ${failures} 次`;
    } else if (r.lastFiredAt !== undefined && r.lastFiredAt !== null) {
      // 321 起 busy-skip 也落运行日志；此回落留给老数据与未接线 appendRun
      // 的宿主——「上次触发」如实。
      lastText = `上次触发 ${fmtCal(r.lastFiredAt)}`;
    } else {
      lastText = r.kind === "reminder" ? "还没响过" : "还没跑过";
    }
    return {
      id: r.id,
      kind: r.kind,
      promptText: r.prompt.slice(0, 80),
      trigger: r.trigger,
      triggerKind: isEvent ? "event" : isIdle ? "idle" : "calendar",
      state,
      stateText,
      nextText,
      lastText,
      sessionName: nameOf(r.sessionId),
      breaker: state === "breaker",
      paused,
      failures,
    };
  });
}

/** ω99-317: 删除确认弹框（.scrim + .modal-card 家族；RevertConfirm 同款
 *  交互词汇）。只删 .wudao 里的调度条目（警示文案如实——不是用户文件，
 *  但删了就不再到点，收益语）。Esc/取消 = 不删零 op。 */
function RemoveConfirm({ promptText, onChoose }: {
  readonly promptText: string;
  onChoose(yes: boolean): void;
}): React.JSX.Element {
  const resolved = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const choose = (yes: boolean): void => {
    if (resolved.current) return;
    resolved.current = true;
    onChoose(yes);
  };
  return (
    <div className="scrim">
      <div
        className="modal-card pop-in remove-confirm"
        role="dialog"
        aria-label="删除定时任务"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "n" || e.key === "N" || e.key === "Enter") {
            e.preventDefault();
            choose(false);
          } else if (e.key === "y" || e.key === "Y") {
            e.preventDefault();
            choose(true);
          }
        }}
      >
        <h3>删除这条定时任务？</h3>
        <div className="muted">{promptText}</div>
        <div className="revert-warn">删除后它不会再到点跑——这是唯一入口，删了要重新设。</div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={() => choose(true)}>
            删除
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            取消 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

/** ω99-317: 熔断试跑确认弹框——「连败 N 次已熔断，仍要试跑？」（brief §2
 *  的显式问）。确认 = 带 resetBreaker 复位旗跑（复位计数 + 重新打开）；
 *  取消零 op。 */
function RunBreakerConfirm({ failures, promptText, onChoose }: {
  readonly failures: number;
  readonly promptText: string;
  onChoose(yes: boolean): void;
}): React.JSX.Element {
  const resolved = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  const choose = (yes: boolean): void => {
    if (resolved.current) return;
    resolved.current = true;
    onChoose(yes);
  };
  return (
    <div className="scrim">
      <div
        className="modal-card pop-in run-confirm"
        role="dialog"
        aria-label="试跑熔断任务"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "n" || e.key === "N" || e.key === "Enter") {
            e.preventDefault();
            choose(false);
          } else if (e.key === "y" || e.key === "Y") {
            e.preventDefault();
            choose(true);
          }
        }}
      >
        <h3>连败 {failures} 次已熔断，仍要试跑？</h3>
        <div className="muted">{promptText}</div>
        <div className="revert-warn">试跑前会清零连败计数并重新打开它——跑成跑不成都会如实告诉你。</div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={() => choose(true)}>
            试跑
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            取消 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

/** The panel overlay（.scrim + .modal-card 家族惯例：Esc 收起、关闭钮常在、
 *  focus on mount——ChangesPanel 范式）。动作 op 与回执在 App（onToggle/
 *  onRemove/onRun 缝），面板只管行渲染与确认交互。 */
export function SchedulesPanel({ rows, onClose, onToggle, onRemove, onRun }: {
  readonly rows: readonly SchedulePanelRow[];
  onClose(): void;
  /** 发 schedulesSetEnabled（App 缝：op + notify 回执 + 纪元 refetch）。 */
  onToggle(id: string, enabled: boolean): void;
  /** 发 schedulesRemove（面板内先过 RemoveConfirm）。 */
  onRemove(id: string): void;
  /** 发 schedulesRunNow（熔断行先过 RunBreakerConfirm，确认后带复位旗）。 */
  onRun(id: string, resetBreaker: boolean): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [pendingBreakerRun, setPendingBreakerRun] = useState<SchedulePanelRow | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
      <div className="scrim">
        <div
          className="modal-card pop-in schedules-panel"
          role="dialog"
          aria-label="定时任务"
          ref={ref}
          tabIndex={-1}
          onKeyDown={(e) => {
            // 确认弹框在场时 Esc 归它（不收面板）——279 的 Esc 分层。
            if (e.key === "Escape" && pendingRemove === null && pendingBreakerRun === null) {
              e.preventDefault();
              onClose();
            }
          }}
        >
          <h3>定时任务</h3>
          <div className="sch-head muted">{`共 ${rows.length} 条`}</div>
          <div className="sch-rows">
            {rows.length === 0 ? (
              <div className="muted">没有定时任务了</div>
            ) : (
              rows.map((r) => (
                <div className="sch-row" data-state={r.state} key={r.id}>
                  <div className="sch-main">
                    <span className="sch-prompt">{r.promptText}</span>
                    <span className="sch-badge sch-state" data-state={r.state}>{r.stateText}</span>
                  </div>
                  <div className="sch-meta">
                    <span className="sch-trig">{r.trigger}</span>
                    <span className="sch-next">{r.triggerKind === "event" ? r.nextText : `下次 ${r.nextText}`}</span>
                    <span className="sch-last" data-ok={r.lastText.includes("跑成了") || undefined}>{r.lastText}</span>
                    {r.sessionName !== null ? <span className="sch-session">{`绑定会话 ${r.sessionName}`}</span> : null}
                  </div>
                  <div className="sch-acts">
                    <button
                      type="button"
                      className="sch-act"
                      data-act="toggle"
                      onClick={() => onToggle(r.id, r.paused)}
                    >
                      {r.paused ? "恢复" : "暂停"}
                    </button>
                    <button
                      type="button"
                      className="sch-act"
                      data-act="run"
                      onClick={() => {
                        if (r.breaker) setPendingBreakerRun(r);
                        else onRun(r.id, false);
                      }}
                    >
                      试跑
                    </button>
                    <button
                      type="button"
                      className="sch-act sch-del"
                      data-act="remove"
                      onClick={() => setPendingRemove(r.id)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="btnrow">
            <button type="button" className="wudao" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
      {pendingRemove !== null ? (
        <RemoveConfirm
          promptText={rows.find((r) => r.id === pendingRemove)?.promptText ?? pendingRemove}
          onChoose={(yes) => {
            const id = pendingRemove;
            setPendingRemove(null);
            if (yes) onRemove(id);
          }}
        />
      ) : null}
      {pendingBreakerRun !== null ? (
        <RunBreakerConfirm
          failures={pendingBreakerRun.failures}
          promptText={pendingBreakerRun.promptText}
          onChoose={(yes) => {
            const r = pendingBreakerRun;
            setPendingBreakerRun(null);
            if (yes) onRun(r.id, true);
          }}
        />
      ) : null}
    </>
  );
}
