// ω99-216: #3 — 会话改动面板（托付闭环「亲验改动」一步）：托付出去的
// 会话每轮 settle 在转录流里落一条净变更收据（0.3.7 可展开胶囊），但它是
// 埋在时间流里的——用户回来想看「这个会话到底动了哪些文件」要逐条翻找。
// 本面把携带 changes 轻摘要（HistoryChange）的收据聚成一处总览：会话头
// （路径去重文件数 + 轮数）+ 按轮分组的文件行（相对路径 + 新建/修改 ×N
// 徽标）+ 每轮可展开的全量 diff（detail 原文——等宽块内滚，截断标记照搬
// 不假装完整）。数据源是结构化 changes 字段，绝不解析 detail 文本（渲染
// 层不当数据层）；「+M/−K 行」不做（在 detail 文本里，解析它是把渲染当
// 数据）。纯展示组件——聚合纯函数 export 供 App 的 chip 与测试共用。
import React, { useEffect, useMemo, useRef, useState } from "react";
import type { HistoryChange, HistoryEntry } from "../protocol.js";
import { IconChevronDown, IconChevronRight } from "./icons.js";
// ω99-288: #2 — 改动明细精读面：detail 从等宽原文字墙升为分色渲染
// （DiffText，纯排版——数据仍走结构化 changes，216 裁定不变）；文件行徽标
// 补每文件 +M/−K（changes 的 optional plus/minus，数据层在 settle 算好过
// 境，渲染层零解析）；文件行点按展开并跳到该文件在明细里的头部（Q1 裁
// 定：文件头行加背景不做 sticky，跳转=scrollIntoView）。
import { DiffText, detailFileAnchors } from "./DiffText.js";

// ω99-314（文件级时光机）——「能看也能回」的那半边：文件行带「恢复到这里」
// （该轮 before 快照存在——changes 行的 beforeSha——才渲染，294 anchors 同款
// 条件范式；created 行与老收据零钮）。点击先过确认弹框（守卫 3 的警示
// 文案：覆盖之后的改动，恢复前自动再留一份快照——收益语，术语黑名单照旧，
// sha256/content-addressed 等词不上 UI），确认后才发 fileRevert op。op 与
// 回执在 App（onRevert 缝），面板只管条件渲染与确认交互。

// ω99-319（Bash/命令级改动归因）——「命令改了什么」看得见也回得了：带 cmd
// 的行渲染「命令改动」徽标（title=命令原文——数据不是文案）；同一命令的
// 足迹文件连续分组（组头「这条命令改了 N 个文件」+ tooltip=命令原文）；组头
// 「撤销这条命令的改动」=逐文件复用 fileRevert（零新协议，316 一键转正同款
// 先例），四守卫全在驱动侧 op 里；无 beforeSha 的文件（首次改动未播种）组钮
// 置灰 + 诚实提示。数据源=changes[].cmd 就地分组（v1 单数据源、零新读）；
// deleted 文件不进 changes（两态形状限制——完整记录在 JSONL 条目，面板 v1
// 不显形，brief 面3 的 v1 边界）。

/** One run's receipt as the panel groups it（历史序一轮 = 一组）。 */
export interface ChangesRun {
  readonly files: readonly HistoryChange[];
  /** The receipt's full diff, verbatim（undefined = 收据未带 detail）。 */
  readonly detail: string | undefined;
}

/** The session-level aggregate（chip 与面板共用的形状）。 */
export interface ChangesAggregate {
  /** 历史序的轮分组。 */
  readonly runs: readonly ChangesRun[];
  /** 会话头计数 = 路径去重后的文件数（同文件跨轮多次改计 1）。 */
  readonly fileCount: number;
}

/** 聚合纯函数：携带非空 changes 的 notice 条目 → 轮分组 + 去重文件数。
 *  老 history（无字段/空数组）零贡献——面板只对新落的收据显形，不回填
 *  （诚实边界）。same input slice → same aggregate，纯函数供测试直钉。 */
export function aggregateSessionChanges(history: readonly HistoryEntry[]): ChangesAggregate {
  const runs: ChangesRun[] = [];
  const paths = new Set<string>();
  for (const e of history) {
    if (e.kind !== "notice" || e.changes === undefined || e.changes.length === 0) continue;
    runs.push({ files: e.changes, detail: e.detail });
    for (const f of e.changes) paths.add(f.path);
  }
  return { runs, fileCount: paths.size };
}

// ---------------------------------------------------------------------------
// ω99-319: 命令归因的分组面（纯函数 + 渲染）
// ---------------------------------------------------------------------------

/** 轮内文件的一段：plain=普通行；cmd=同命令足迹文件的连续分组段。 */
export type RunSegment =
  | { readonly kind: "plain"; readonly file: HistoryChange }
  | { readonly kind: "cmd"; readonly cmd: string; readonly files: readonly HistoryChange[] };

/** 分组纯函数：同 cmd 的相邻行聚一段（被 plain 行隔断的同 cmd 另起一段——
 *  连续性是分组依据，不重排）；无 cmd 行原样。same input → same segments，
 *  纯函数供测试直钉。 */
export function groupRunFiles(files: readonly HistoryChange[]): readonly RunSegment[] {
  const out: RunSegment[] = [];
  for (const f of files) {
    if (f.cmd === undefined) {
      out.push({ kind: "plain", file: f });
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.kind === "cmd" && last.cmd === f.cmd) {
      out[out.length - 1] = { kind: "cmd", cmd: last.cmd, files: [...last.files, f] };
    } else {
      out.push({ kind: "cmd", cmd: f.cmd, files: [f] });
    }
  }
  return out;
}

/** ω99-288（续，标记见上）: the badge's +M/−K count parts — present only
 *  when the data layer computed them（settle 的 hunk 累计）；缺省或双零
 *  （identical-net）不显示行数——诚实降级，不发明数字。数字不是术语。 */
function countParts(f: HistoryChange): { readonly plus: number; readonly minus: number } | null {
  if (f.plus === undefined || f.minus === undefined) return null;
  if (f.plus <= 0 && f.minus <= 0) return null;
  return { plus: f.plus, minus: f.minus };
}

function anchorAbsentTitle(f: { plus?: number; minus?: number }): string {
  if (f.plus !== undefined && f.minus !== undefined && f.plus <= 0 && f.minus <= 0) {
    return "这一轮结束时，这个文件的内容没有变化";
  }
  return "这份文件的改动明细过长，明细中已省略——完整记录可用 /rewind 回看";
}

/** One file row's badge：新建/修改 ×N 基形 + 在场时的着色计数 span（+M 走
 *  --ok、−K 走 --danger——红色律的「diff 删除」正位）。 */
function ChangeBadge({ f }: { readonly f: HistoryChange }): React.JSX.Element {
  const parts = countParts(f);
  return (
    <span className="chg-badge" data-op={f.op}>
      {/* 用户词：新建 / 修改 ×N（写入次数）——零 diff 术语 */}
      {f.op === "created" ? "新建" : `修改 ×${f.writes}`}
      {parts !== null && parts.plus > 0 ? <span className="chg-cnt chg-cnt-plus">{` +${parts.plus}`}</span> : null}
      {parts !== null && parts.minus > 0 ? <span className="chg-cnt chg-cnt-minus">{` −${parts.minus}`}</span> : null}
    </span>
  );
}

/** ω99-314: 恢复确认弹框（.scrim + .modal-card 家族；ClearConfirm 同款交互
 *  词汇）。警示文案永远在场（守卫 3 的 UI 面）：不知道也不假装知道文件是否
 *  被改过——覆盖后果与双保险（确认 + 恢复前自动再留一份快照）如实说。
 *  Esc/取消 = 不恢复零 op。 */
function RevertConfirm({ path, onChoose }: {
  readonly path: string;
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
        className="modal-card pop-in revert-confirm"
        role="dialog"
        aria-label="恢复文件"
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
        <h3>↩ 恢复 {path}</h3>
        <div className="muted">这一轮开始前它是这个样子。</div>
        <div className="revert-warn">
          如果这一轮之后你又改过它，恢复会覆盖这些改动——覆盖前会自动再留一份快照，随时可以再恢复回来。
        </div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={() => choose(true)}>
            恢复
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            取消 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

/** ω99-319: 组级撤销确认弹框（.scrim + .modal-card 家族；RevertConfirm 同款
 *  交互词汇，文案按「整组」改写——多文件覆盖更需要确认）。警示文案永远在场；
 *  Esc/取消 = 零 op。 */
function GroupRevertConfirm({ count, onChoose }: {
  readonly count: number;
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
        className="modal-card pop-in revert-confirm"
        role="dialog"
        aria-label="撤销命令改动"
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
        <h3>↩ 撤销这条命令的改动</h3>
        <div className="muted">{`这条命令改了 ${count} 个文件，会把它们恢复到命令开始前的样子。`}</div>
        <div className="revert-warn">
          如果这之后你又改过其中某个文件，恢复会覆盖这些改动——覆盖前每个文件都会自动再留一份快照，随时可以再恢复回来。
        </div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={() => choose(true)}>
            撤销
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            取消 (Esc)
          </button>
        </div>
      </div>
    </div>
  );
}

/** 每轮一组：轮头（第 N 轮 · M 文件）+ 文件行 + 可展开的改动明细（detail
 *  分色渲染——ω99-288 从等宽原文字墙升为红绿分色 + 文件头分组，等宽与
 *  内滚块语义不变，截断标记照搬不假装完整；0.3.7 胶囊展开同款交互词
 *  汇：箭头 + 全文块）。文件行点按 = 展开并跳到该文件头（数据在
 *  changes，靶点是 DiffText 的 data-dtx-file 锚——渲染产物只当靶点不当
 *  数据）。ω99-314: 带恢复面的文件行加「恢复到这里」小钮（该轮 before
 *  快照在场才渲染——294 anchors 同款条件范式；点击只开确认，不发 op）。
 *  本地 state——历史条目不可变（NoticeBubble 同款）。 */
function RunGroup({ run, ordinal, onRevert, onGroupRevert }: {
  readonly run: ChangesRun;
  readonly ordinal: number;
  readonly onRevert?: (path: string, sha: string) => void;
  /** ω99-319: 组级撤销的直达 op 缝（组确认已在本组件内过，不经单文件弹框）。 */
  readonly onGroupRevert?: (path: string, sha: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  // ω99-319: 待确认的组撤销请求（null = 无弹框）。
  const [pendingGroup, setPendingGroup] = useState<{ readonly cmd: string; readonly files: readonly HistoryChange[] } | null>(null);
  const runRef = useRef<HTMLDivElement>(null);
  const hasDetail = run.detail !== undefined && run.detail.length > 0;
  // ω99-294: 文件行交互收紧为「有锚才行」——锚集合问 DiffText 的
  //  detailFileAnchors 要（方言解析单一事实源，不自己解析 detail，216 裁定
  //  不变）；无锚族（净零/截断丢块）降级非交互 div + 收益语 title。
  const anchors = useMemo(
    () => (hasDetail ? detailFileAnchors(run.detail ?? "") : new Set<string>()),
    [hasDetail, run.detail],
  );
  useEffect(() => {
    if (!open || jumpTo === null) return;
    const el = [...(runRef.current?.querySelectorAll<HTMLElement>("[data-dtx-file]") ?? [])].find(
      (n) => n.getAttribute("data-dtx-file") === jumpTo,
    );
    el?.scrollIntoView({ block: "start" });
    setJumpTo(null);
  }, [open, jumpTo]);
  const revertBtn = (f: HistoryChange): React.JSX.Element | null =>
    f.beforeSha !== undefined && onRevert !== undefined ? (
      <span
        className="chg-revert"
        role="button"
        tabIndex={0}
        data-path={f.path}
        title="这一轮开始前它是这个样子"
        aria-label={`恢复 ${f.path} 到这一轮开始前的样子`}
        onClick={() => onRevert(f.path, f.beforeSha!)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onRevert(f.path, f.beforeSha!);
          }
        }}
      >
        恢复到这里
      </span>
    ) : null;
  // ω99-319: 命令归因徽标（title=命令原文——数据面，不属术语文案）。
  const cmdBadge = (f: HistoryChange): React.JSX.Element | null =>
    f.cmd !== undefined ? (
      <span className="chg-cmd-badge" title={f.cmd}>
        命令改动
      </span>
    ) : null;
  // ω99-319: 单个文件行（wrap 承接行距；cmd 徽标与恢复钮是行本体的兄弟交互件）。
  const fileRow = (f: HistoryChange): React.JSX.Element => (
    // ω99-314: 行外再包一层 wrap——恢复钮与行本体是兄弟交互件（嵌套
    // 交互件是非法 HTML；stopPropagation 也不再需要）。
    <div className="chg-file-wrap" key={f.path}>
      {hasDetail && anchors.has(f.path) ? (
        <button
          type="button"
          className="chg-file"
          title={`在改动明细中定位 ${f.path}`}
          onClick={() => {
            setOpen(true);
            setJumpTo(f.path);
          }}
        >
          <span className="chg-path">{f.path}</span>
          <ChangeBadge f={f} />
        </button>
      ) : (
        <div className="chg-file" title={hasDetail ? anchorAbsentTitle(f) : undefined}>
          <span className="chg-path">{f.path}</span>
          <ChangeBadge f={f} />
        </div>
      )}
      {cmdBadge(f)}
      {revertBtn(f)}
    </div>
  );
  // ω99-319: 组级撤销钮——组内一枚可回退文件（beforeSha 在场）即可用；全部
  // 首改未播种则置灰 + 诚实提示（收益语）。确认后逐文件复用 fileRevert（行
  // 序；四守卫在驱动侧 op 里——busy/evicted 等拒答走 App 的回执面）。
  const groupUndoBtn = (seg: { readonly cmd: string; readonly files: readonly HistoryChange[] }): React.JSX.Element => {
    const revertibles = seg.files.filter((f) => f.beforeSha !== undefined);
    const allGray = revertibles.length === 0;
    return (
      <span
        className="chg-cmd-undo"
        role="button"
        tabIndex={0}
        aria-disabled={allGray ? "true" : undefined}
        title={allGray ? "首次改动暂无可恢复快照" : `撤销这条命令的改动（${revertibles.length} 个文件）`}
        aria-label={allGray ? "首次改动暂无可恢复快照" : `撤销这条命令改的 ${revertibles.length} 个文件`}
        onClick={() => {
          if (allGray || onGroupRevert === undefined) return;
          setPendingGroup({ cmd: seg.cmd, files: revertibles });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (allGray || onGroupRevert === undefined) return;
            setPendingGroup({ cmd: seg.cmd, files: revertibles });
          }
        }}
      >
        撤销这条命令的改动
      </span>
    );
  };
  return (
    <div className="chg-run" ref={runRef}>
      <div className="chg-run-h">{`第 ${ordinal} 轮 · ${run.files.length} 文件`}</div>
      <div className="chg-files">
        {/* ω99-319: 同命令的足迹文件连续分组（组头=归因叙事+组级撤销）；
            plain 行原样。 */}
        {groupRunFiles(run.files).map((seg, i) =>
          seg.kind === "plain" ? (
            fileRow(seg.file)
          ) : (
            <div className="chg-cmdgroup" key={`cmd-${i}-${seg.cmd.length}`}>
              <div className="chg-cmd-h" title={seg.cmd}>
                <span className="chg-cmd-label">{`这条命令改了 ${seg.files.length} 个文件`}</span>
                {groupUndoBtn(seg)}
              </div>
              {seg.files.map(fileRow)}
            </div>
          ),
        )}
      </div>
      {hasDetail ? (
        <button
          type="button"
          className="chg-exp"
          aria-expanded={open}
          aria-label={open ? `收起第 ${ordinal} 轮改动明细` : `展开第 ${ordinal} 轮改动明细`}
          onClick={() => setOpen(!open)}
        >
          <span>{open ? "收起改动明细" : "展开改动明细"}</span>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </button>
      ) : null}
      {open && hasDetail ? <DiffText detail={run.detail ?? ""} className="chg-detail" as="pre" /> : null}
      {pendingGroup !== null && onGroupRevert !== undefined ? (
        <GroupRevertConfirm
          count={pendingGroup.files.length}
          onChoose={(yes) => {
            const req = pendingGroup;
            setPendingGroup(null);
            if (yes) req.files.forEach((f) => onGroupRevert(f.path, f.beforeSha!));
          }}
        />
      ) : null}
    </div>
  );
}

/** The panel overlay（.scrim + .modal-card 家族惯例：Esc 收起、关闭钮常在）。
 *  Presentational——agg 由调用方聚合传入，开合状态也在调用方。ω99-314:
 *  onRevert（可选）在场时文件行的恢复钮渲染；确认弹框在面板内部（点行 →
 *  确认 → onRevert(path, sha)——op 与回执是 App 的事，面板管交互）。 */
export function ChangesPanel({ agg, onClose, onRevert }: {
  readonly agg: ChangesAggregate;
  onClose(): void;
  /** ω99-314: 发 fileRevert（App 缝：client op + notify 回执）。缺省 → 恢复
   *  钮零渲染（老 server 降级——beforeSha 本就只在新驱动起的收据里）。 */
  readonly onRevert?: (path: string, sha: string) => void;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  // ω99-314: 待确认的恢复请求（null = 无弹框）。
  const [pendingRevert, setPendingRevert] = useState<{ readonly path: string; readonly sha: string } | null>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <>
    <div className="scrim">
      <div
        className="modal-card pop-in changes-panel"
        role="dialog"
        aria-label="会话改动"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" && pendingRevert === null) {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <h3>会话改动</h3>
        {/* 会话头：去重文件数 + 轮数（同文件跨轮计 1） */}
        <div className="chg-head muted">{`共改动 ${agg.fileCount} 个文件 · ${agg.runs.length} 轮`}</div>
        <div className="chg-runs">
          {agg.runs.map((run, i) => (
            <RunGroup
              key={`${i}-${run.files.length}`}
              run={run}
              ordinal={i + 1}
              onRevert={onRevert !== undefined ? (path, sha) => setPendingRevert({ path, sha }) : undefined}
              /* ω99-319: 组级撤销的直达缝——组确认弹框已在 RunGroup 内过
               * （多文件覆盖一次确认即可），不再走单文件的 setPendingRevert
               * 二次拦截；直发 fileRevert（App 缝，逐文件行序）。 */
              onGroupRevert={onRevert}
            />
          ))}
        </div>
        <div className="btnrow">
          <button type="button" className="wudao" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
    {pendingRevert !== null && onRevert !== undefined ? (
      <RevertConfirm
        path={pendingRevert.path}
        onChoose={(yes) => {
          const req = pendingRevert;
          setPendingRevert(null);
          if (yes) onRevert(req.path, req.sha);
        }}
      />
    ) : null}
    </>
  );
}
