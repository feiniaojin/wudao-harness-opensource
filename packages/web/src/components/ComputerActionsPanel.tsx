// ω99-219: #2 — 电脑操作回望面板（托付闭环的 computer-use 半边，216 是
// 文件改动半边）：用户托付「帮我在备忘录记一条/把这张表整理了」离开，
// 回来只能在转录的工具卡堆里翻 computer.type/computer.click 混着
// read/write 噪音。本面把电脑操作八工具的 tool 条目聚成会话级回望：会话
// 头（总步数 + 轮数）+ 按轮分组的动作行（用户词短语——打开了/输入了/
// 点击/按键/截图——+ 连续同词折叠计数 + 错误样式 + 耗时）。数据源是消息
// 面 tool 条目（name/summary/isError/resultPreview/durationMs），resume
// 从 messages 重建——天然跨重启持久，与 216 的 UI 收据不同寿命。pre-219
// 老会话 summary 为空串：兜底行=工具名 + resultPreview 单行（诚实降级，
// 不猜动作内容）。纯展示组件——聚合纯函数 export 供 App 的 chip 与测试
// 共用；只读 UI 历史渲染，永不写 state.messages/system prompt（M24 零影响）。
import React, { useEffect, useRef } from "react";
import type { HistoryEntry } from "../protocol.js";
import { formatDur } from "../protocol.js";

/** 电脑操作十工具（212 六名 + 220 两名：scroll/drag + 247 观察员：
 *  screen.observe + 250 等待员：computer.wait——名集是本面板唯一的演进缝，
 *  新工具自动进回望；其余工具是另一条回望线，零贡献）。 */
const COMPUTER_TOOLS: ReadonlySet<string> = new Set([
  "screen.capture",
  "computer.type",
  "computer.key",
  "computer.click",
  "app.activate",
  "app.list",
  "computer.scroll",
  "computer.drag",
  "screen.observe",
  "computer.wait",
]);

/** One folded action row（连续同 (name, summary) 折叠——同词重复是噪音，
 *  不同输入各有各的回望行）。 */
export interface ComputerActionRow {
  readonly name: string;
  /** 动作对象（输入文本/键串/坐标/应用名；pre-219 老条目为空串）。 */
  readonly summary: string;
  /** 折叠组内任一次失败即为 true（错误看得见比折叠整齐重要）。 */
  readonly isError: boolean;
  /** 全组各条都携带耗时时的求和；有缺省则 undefined（不编造）。 */
  readonly durationMs: number | undefined;
  /** 连续同词条数（×N 徽标）。 */
  readonly count: number;
  /** 末条 resultPreview（老会话兜底行用；新会话动作行不展示）。 */
  readonly preview: string;
}

/** One run's actions as the panel groups it（user 消息边界一轮 = 一组）。 */
export interface ComputerActionsRun {
  readonly actions: readonly ComputerActionRow[];
}

/** The session-level aggregate（chip 与面板共用的形状）。 */
export interface ComputerActionsAggregate {
  /** 历史序的轮分组。 */
  readonly runs: readonly ComputerActionsRun[];
  /** 会话头计数 = 计入的 tool 条目数（不是折叠后的行数）。 */
  readonly totalSteps: number;
}

/** 聚合纯函数：电脑操作八工具的 tool 条目 → 轮分组 + 总步数。user 消息
 *  开新轮（首个 user 前的条目自成一轮）；轮内连续同 (name, summary)
 *  折叠计数。他工具/老 notice 零贡献。same input slice → same aggregate，
 *  纯函数供测试直钉。 */
export function aggregateComputerActions(history: readonly HistoryEntry[]): ComputerActionsAggregate {
  const runs: ComputerActionsRun[] = [];
  let actions: ComputerActionRow[] = [];
  let totalSteps = 0;
  let flush = (): void => {
    if (actions.length > 0) {
      runs.push({ actions });
      actions = [];
    }
  };
  for (const e of history) {
    if (e.kind === "user") {
      flush();
      continue;
    }
    if (e.kind !== "tool" || !COMPUTER_TOOLS.has(e.name)) continue;
    totalSteps++;
    const last = actions[actions.length - 1];
    if (last !== undefined && last.name === e.name && last.summary === e.summary) {
      // 折叠：计数+1；错误任一次即真；耗时全携带才求和（缺一条就不显）；
      // 兜底 preview 取末条（最新结果）。
      const dur = last.durationMs !== undefined && e.durationMs !== undefined
        ? last.durationMs + e.durationMs
        : undefined;
      actions[actions.length - 1] = {
        ...last,
        isError: last.isError || e.isError === true,
        durationMs: dur,
        count: last.count + 1,
        preview: e.resultPreview ?? "",
      };
      continue;
    }
    actions.push({
      name: e.name,
      summary: e.summary,
      isError: e.isError === true,
      durationMs: e.durationMs,
      count: 1,
      preview: e.resultPreview ?? "",
    });
  }
  flush();
  return { runs, totalSteps };
}

/** 动作行的用户词短语——回望读的是「干了什么」，零实现术语。ω99-220: #6 —
 *  scroll/drag 各加一行（对象=方向+像素量 / 起终点坐标，log.ts 单源）。
 *  ω99-247: #4 — observe 加一行（对象=应用名/前台窗口，log.ts 单源）。
 *  ω99-250: #4 — wait 加一行（对象=[eN]+期望，log.ts 单源）。 */
const ACTION_PHRASE: Readonly<Record<string, string>> = {
  "screen.capture": "截了一张全屏图",
  "computer.type": "输入了",
  "computer.key": "按键",
  "computer.click": "点击",
  "app.activate": "打开了",
  "app.list": "看了当前打开的应用",
  "computer.scroll": "滚动了",
  "computer.drag": "拖动了",
  "screen.observe": "观察了",
  "computer.wait": "等待了",
};

/** 短语后接 summary 展示的动作对象工具（无参工具的固定动作词已含全部
 *  信息——summary 的「全屏/列表」不再重复；observe 的对象词=「前台窗口」
 *  有信息量，随 ARG_TOOLS 展示；wait 的对象=[eN]+期望短语有信息量，同展）。 */
const ARG_TOOLS: ReadonlySet<string> = new Set(["computer.type", "computer.key", "computer.click", "app.activate", "computer.scroll", "computer.drag", "screen.observe", "computer.wait"]);

/** One action row. pre-219 空串 summary → 工具名兜底行 + resultPreview
 *  单行（老会话唯一可诚实的标识，不猜动作内容）。 */
function ActionRow({ row }: { readonly row: ComputerActionRow }): React.JSX.Element {
  const phrase = ACTION_PHRASE[row.name] ?? row.name;
  const hasSummary = row.summary !== "";
  return (
    <div className="cap-act" data-err={row.isError ? "true" : undefined}>
      <span className="cap-verb">{hasSummary ? phrase : row.name}</span>
      {hasSummary && ARG_TOOLS.has(row.name) ? <span className="cap-text">{row.summary}</span> : null}
      {row.count > 1 ? <span className="cap-badge">{`×${row.count}`}</span> : null}
      {row.durationMs !== undefined ? <span className="cap-dur">{`· ${formatDur(row.durationMs)}`}</span> : null}
      {!hasSummary && row.preview !== "" ? <div className="cap-preview">{row.preview}</div> : null}
    </div>
  );
}

/** The panel overlay（.scrim + .modal-card 家族惯例：Esc 收起、关闭钮常在）。
 *  Presentational——agg 由调用方聚合传入，开合状态也在调用方。 */
export function ComputerActionsPanel({ agg, onClose }: {
  readonly agg: ComputerActionsAggregate;
  onClose(): void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="scrim">
      <div
        className="modal-card pop-in computer-panel"
        role="dialog"
        aria-label="电脑操作"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3>电脑操作</h3>
        {/* 会话头：总步数（条目数）+ 轮数 */}
        <div className="cap-head muted">{`共电脑操作 ${agg.totalSteps} 步 · ${agg.runs.length} 轮`}</div>
        <div className="cap-runs">
          {agg.runs.map((run, i) => (
            <div className="cap-run" key={`${i}-${run.actions.length}`}>
              <div className="cap-run-h">{`第 ${i + 1} 轮 · ${run.actions.reduce((n, a) => n + a.count, 0)} 步`}</div>
              <div className="cap-acts">
                {run.actions.map((row, j) => (
                  <ActionRow key={`${row.name}-${j}`} row={row} />
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
