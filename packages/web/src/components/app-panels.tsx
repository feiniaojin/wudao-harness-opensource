// App — the wudao ui shell (full M43-B surface). Composition only; every
// rule lives in the mirror modules (protocol client, input machine, slash
// helpers, frontend-commands router). Layout: header, reconnect banner,
// conversation column (history + local notes + plan review + live area,
// tail-followed), the input area (steering-capable), the status bar, and
// the modal layer (permission ask, /resume picker, /clear confirm).
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { HistoryEntry, SessionRow, SessionSearchHit, SettingsStatus, WudaoClient, ImageAttachmentRefWire, FileBlockWire, ScheduleListRow } from "../protocol.js";
import { cycleMode, modeLabel, MAX_RECONNECT_ATTEMPTS, modelPickCommand, providerEffortSavePayload } from "../protocol.js";
// M64-visual §4: the theme/accent channel — applyTheme/readTheme (Task 1) +
// the accent twin; the ui.theme/ui.accent settings keys persist the pick.
import { applyAccent, applyTheme, readAccent, readTheme, type ThemeName } from "../theme.js";
import { matrixReady, wizardShouldShow } from "../wizard.js";
import { useUi } from "../use-ui.js";
// ω99-213: #4 — the away-recap trigger + banner card (chat-top, no modal).
import { useRecap } from "../use-recap.js";
import { RecapBanner } from "./RecapBanner.js";
// ω99-242: #10 — the recovered session's reconciliation line (chat-top under
// the recap banner): 已验证完成 X / 待续 Y，counted server-side, zero fabrication.
import { useRecoveryBanner, RecoveryBanner, MorningBanner, awaitingNotificationOf } from "./RecoveryBanner.js";
// (ω99-218 #4 续) the model selector's 「最近使用」 per-viewer store imports —
// the state + snapshot-driven write point live by the recap hook below.
import { readRecent, touchRecent, writeRecent } from "../recent-models-store.js";
import type { RecentModel } from "../recent-models-store.js";
import type { SlashCommandInfo } from "../slash.js";
import { formatSlashHelp } from "../slash.js";
import { parseFrontendCommand } from "../frontend-commands.js";
import { buildPathIndexAsync, searchPathIndex, type AsyncPathIndexBuild } from "../file-fuzzy.js";
import { HistoryList, historyKey } from "./HistoryList.js";
import { ArmedBranchBanner, BranchBar } from "./BranchPanel.js";
// ω99-260: the boot pending-memory card (the review gate's desktop handle).
import { MemoryReviewCard } from "./MemoryReviewCard.js";
import { LiveArea } from "./LiveArea.js";
import { StatusBar } from "./StatusBar.js";
import { InputBox } from "./InputBox.js";
// ω99-316 (/btw 侧问): the「顺便问」lane — marked bubbles above the composer
// (never part of the transcript's run structure) + the promote formatter.
import { SideQaLane, formatSidePromoteMessage, type SideQa } from "./SideQaLane.js";
import { PermissionModal } from "./PermissionModal.js";
// workspace-ux B3: the agent-root confirm card (a pick's follow-up ask).
import { AgentRootCard } from "./AgentRootCard.js";
import { ResumePicker } from "./ResumePicker.js";
import { ClearConfirm } from "./ClearConfirm.js";
import { PlanReview } from "./PlanReview.js";
// M63 §B: the settings page (provider cards / credentials / preferences).
import { SettingsPage } from "./SettingsPage.js";
// M63 §C: the first-run wizard (full-viewport takeover when nothing is ready).
import { Wizard } from "./Wizard.js";
// M63 §D: the 简洁模式 shell — same driver state, novice projection.
import { SimpleMode } from "./SimpleMode.js";
import type { ShieldMode } from "./ShieldSelector.js";
// M74-ide §3: the advanced shell's data panels — the lazy file tree (left)
// and the read-only viewer (center). The structural FileOpsClient port means
// the WudaoClient satisfies both with zero adapter code.
import { FileTree } from "./FileTree.js";
import { FileViewer } from "./FileViewer.js";
// M78-buddy §2: the Buddy 模式 left panel — the sessions op's rows as a
// switchable conversation list (structural SessionsClient port).
// ω99-178: #1 — 弹框行改吃侧栏的可读标题三函数（name → firstUser 16 字梯
// → id8 兜底）与日期分组，两处历史入口同一套词表。
import { SessionSidebar, sessionTitle, sessionTitleTip, sessionGroup } from "./SessionSidebar.js";
// ω99-251 — 点名标题走侧栏的标题梯子（name → firstUser 16 字 → id8），
// 但 App 函数体内已有同名 topbar memo（下方 const sessionTitle）遮蔽模块
// 绑定——别名导入拿梯子函数。
import { sessionTitle as sessionTitleLadder } from "./SessionSidebar.js";
// ω99-216: #4 — 会话改动面板：携带 changes 轻摘要的净变更收据聚成一处
// 总览（chip 计数=去重文件数、点击开 overlay 面板）。聚合纯函数与组件同
// 住 ChangesPanel（面板是纯展示层）。数据只在 UI 历史里——与模型上下文
// 无关，M24 前缀缓存零影响。
import { ChangesPanel, aggregateSessionChanges } from "./ChangesPanel.js";
// ω99-219: #3 — 电脑操作回望面板：电脑操作工具的 tool 条目聚成会话级回望
// （chip 计数=总步数、点击开 overlay 面板）。聚合纯函数与组件同住
// ComputerActionsPanel（面板是纯展示层）。数据源是消息面 tool 条目
// （resume 重建即回）——只读渲染，与模型上下文无关，M24 零影响。
import { ComputerActionsPanel, aggregateComputerActions } from "./ComputerActionsPanel.js";
// ω99-317 — 定时任务管理面板：「定时 N」chip 的行快照聚成看/停/试跑闭环
// （0.3.89 发了 313 调度引擎，本弧补管理面）。聚合纯函数与组件同住
// SchedulesPanel（面板是纯展示层——动作 op 与回执在 App 缝）。数据源是
// .wudao 调度存储的读面 op——只读渲染，与模型上下文无关。
import { SchedulesPanel, schedulesPanelModel } from "./SchedulesPanel.js";
// ui-review-r1: I1 focus return, I5 the shared empty hero, P3 the topbar /
// tab-strip icon glyphs.
import { useFocusReturn } from "../use-focus-return.js";
import { EmptyHero } from "./EmptyHero.js";
import { WorkspaceChip } from "./WorkspaceChip.js";
import { isConversationEmpty } from "./SimpleMode.js";
// M79b §3: the history-image source — the deep, memoized HistoryItem tree
// resolves attachment refs through this context instead of threaded props.
import { AttachmentSource } from "./AttachmentImages.js";
import { admitFiles, admitFileBatch, createDraft, createFileDraft, releaseDraft } from "../attachments.js";
import type { ComposerImageDraft, ComposerImageInput, ComposerFileDraft, ComposerFileInput } from "../attachments.js";
// r5 P4: the attachmentSend failure notices' Chinese admission mapping.
import { attachmentSendErrorText, fileSendErrorText } from "../attachments.js";
// ui-review-r2 P5: the formerly-dead glyphs find their slots — IconPlus (the
// + new-chat), IconClose (the tab ×), IconFileText (a file tab's glyph,
// IconFolder's twin for dir tabs).
import { IconSessions, IconSettings, IconTheme, IconFolder, IconPlus, IconClose, IconFileText, IconSpinner, IconPanelLeft, IconTrash } from "./icons.js";
// workspace-ux A2: the ONE seam for desktop-plugin calls (directory dialog /
// finish notification / window drag) — no caller hand-rolls a `__TAURI__`
// optional-chain again; an absent or throwing bridge reads as null/false.
import { resolveTauriInvoke, tauriListenEvent, tauriNotify, tauriPickDirectory, tauriStartDrag, tauriToggleMaximize } from "../tauri-invoke.js";
import { WUDAO_SCREENSHOT_EVENT, screenshotFileFromPayload } from "../screenshot-ask.js";
// ω99-119: 拖文件即起草 — the React-外 drop mount (main.tsx) stages its
// drafts into the module sink; this side registers the App half of the
// bridge (parked files merge + fileSeed arm, the 116 screenshot mirror).
import { setPetDropStageSink } from "../pet-drop.js";
// ω99-151: IME 组合期键盘守卫的 A 层（纯函数）——两个 picker 的 onKeyDown
// 顶置接线（组合确认=误开文件/误切会话）。
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";

// —— App 面板纯函数/常量族外提二分（ω99 拆分运动）——
export const SESSION_PICKER_CAP = 20;

/** M76-ux2 §3: the preview's char cap — a session's message summary is a
 *  one-glance identifier, not prose; past 50 it ellipsizes. */
export const SESSION_PREVIEW_CAP = 50;

/** M76-ux2 §3: a row's preview — the session's NAME (when the driver named
 *  it) or its first user message, the closest v1 stand-in for "最后一条消息
 *  摘要" (protocol v1's row carries no last-message field), 50-char cap. */
export function sessionPreview(r: SessionRow): string {
  const raw = r.name !== undefined && r.name !== "" ? r.name : r.firstUser !== "" ? r.firstUser : "(空会话)";
  return raw.length > SESSION_PREVIEW_CAP ? `${raw.slice(0, SESSION_PREVIEW_CAP)}…` : raw;
}

/** M76-ux2 §3: the relative-time ladder (刚刚 / N分钟前 / N小时前 / N天前,
 *  then the ISO date) — the rows are mtime-desc so the ladder only ever
 *  walks one way down the list. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 30 * 24 * 60 * 60_000) return `${Math.floor(diff / 86_400_000)}天前`;
  return iso.slice(0, 10);
}

/** M76-ux2 §3 — the 📋 topbar entry's session picker: the FileSearch
 *  geometry (fixed scrim, the 400px pop at the top fifth — the same CSS
 *  classes) over the sessions op's rows. Each row is the id8 + a 50-char
 *  message preview + the relative mtime; ↑/↓ walk, Enter resumes through
 *  the caller's pick seam (the App routes it onto client.resume), Esc or
 *  a scrim click closes. Rows arrive ASYNC (null while loading).
 * ω99-277: #6 — 顶部查询框：输入即全文搜索所有会话内容（onSearch 车道；
 * IME 组合期不发、组合完一次补发；stale 守卫只渲染最新查询的应答）。
 * 空查询时列表/分组/导航/加载态与升级前逐字节一致。
 * ω99-279: #8 — 回收站式删除车道：行悬停 🗑 → 行内确认（删除这个会话？
 * [删除][取消]，同一时刻至多一行）→ onDelete op。activeId 行（当前打开
 * 的会话）不渲染删除钮——UI 侧第一道防护（driver 的 guardIds 是第二道，
 * 双保险）。onDelete 缺席（旧调用方/单元挂载）整条删除车道隐藏，行为
 * 逐字节回 277。键盘：选中行 Del 进确认、Enter=确认、Esc 分层（确认态
 * 先 consumed 复原，非确认态才关弹框）。
 * ω99-283: #5 — 回收站面：列表底部「回收站 (N)」入口（N 来自打开时
 * trashRows）→ 回收站视图（行复用会话行形态：title 梯+相对时间+预览；
 * 每行「恢复」钮）→ onRestore op。恢复成功（resolve true）视图回主列
 * 表；拒答留在回收站视图（toast 已由 App 给）。Esc 在回收站视图=返回
 * 主列表（不关弹框）。trashRows null（取数中/旧 server 车道缺席）或
 * onRestore 缺席 → 入口隐藏，行为逐字节回 279。
 * ω99-284: #1 — 回收站键盘面（三面同构收口）：↑↓ 选择（clamp 无环绕，
 * 同主列表范式）· Enter 恢复（复用恢复钮的 onRestore 调用形）· Esc 返回
 * 列表；行补 id 锚/sel 类/aria-selected，listbox 的 aria-activedescendant
 * 三态化（回收站态跟 trashSel）；空回收站 ↑↓/Enter no-op；进面光标复位
 * 顶行（入口钮同点）。 */
export function SessionPicker({ rows, onPick, onClose, onSearch, activeId = null, onDelete, trashRows = null, onRestore }: {
  rows: readonly SessionRow[] | null;
  onPick(id: string): void;
  onClose(): void;
  onSearch(q: string): Promise<readonly SessionSearchHit[]>;
  /** ω99-279（续，标记见上）：该行是当前打开的会话 → 无删除钮（undefined ≡ null = 无当前）。 */
  activeId?: string | null;
  /** ω99-279（续，标记见上）：删除确认后的 op 车道；resolve true=已删（搜索态重跑查询），
   * false=拒（toast 已由 App 给）。缺席 = 无删除车道（回归安全默认）。 */
  onDelete?: (id: string) => Promise<boolean>;
  /** ω99-283（续，标记见上）：回收站行集（null = 取数中/车道缺席 → 入口隐藏；
   * 空数组 = 回收站空——入口照显 (0)，点了见空态）。 */
  trashRows?: readonly SessionRow[] | null;
  /** ω99-283（续，标记见上）：恢复的 op 车道；resolve true=已恢复（视图回主列表），
   * false=拒（toast 已由 App 给，视图留在回收站）。缺席 = 无回收站面（回归安全默认）。 */
  onRestore?: (id: string) => Promise<boolean>;
}): React.JSX.Element {
  const [sel, setSel] = useState(0);
  const [q, setQ] = useState("");
  // null = 无查询（列表态）或查询已发未回应答（搜索中…）。
  const [hits, setHits] = useState<readonly SessionSearchHit[] | null>(null);
  // stale 守卫：本地递增 seq，慢应答迟到（seq 已旧）即丢。
  const searchSeq = useRef(0);
  const qRef = useRef<HTMLInputElement>(null);
  // ω99-151: IME 组合态——组合期列表的 ↑↓/Enter/Esc 让位，查询也不发
  // （拼音打到一半不搜；组合完 onCompositionEnd 补发一次）。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  // ω99-279（续，标记见上）— 行内确认态：key=行键（列表 r.id；命中行
  // `${sessionId}-${i}`——两会话各命中多行时不串行），id=要删的会话。
  // 单槽 state 天然保证「同一时刻至多一行确认」。null=无确认。
  const [confirm, setConfirm] = useState<{ key: string; id: string } | null>(null);
  // ω99-283（续，标记见上）— 回收站视图态：false=主列表/搜索面（279 全语
  // 义），true=回收站面（行渲染复用、恢复钮、Esc=返回不关弹框）。组件随
  // 弹框关闭卸载，状态自然复位。
  const [trashView, setTrashView] = useState(false);
  // ω99-284（续，标记见上）— 回收站面光标（↑↓ 行走；Enter 恢复的对象行）。
  // 进面复位 0（入口钮与 setTrashView(true) 同点）；trashRows 变化 clamp。
  const [trashSel, setTrashSel] = useState(0);
  // UI-5 C9 姊妹: the rows' id namespace for aria-activedescendant (the pop
  // keeps DOM focus; SRs follow the pointed row). Scoped by useId.
  const listId = useId();
  // ui-review-r1 I1: BEFORE the pop's focus effect (same declaration-order
  // rule as FileSearch) — the 📋 trigger gets its focus back on close.
  useFocusReturn();
  useEffect(() => {
    qRef.current?.focus();
  }, []);
  useEffect(() => {
    setSel(0); // every (re)load of the rows resets the cursor to the top row
  }, [rows]);
  const searching = q.trim() !== "";
  useEffect(() => {
    setSel(0); // 查询态的选项集换了，光标回顶
  }, [q, hits]);
  // ω99-284（续，标记见上）— 回收站行集变化时 clamp 光标：恢复成功后视图
  // 即回主列表（主流程不靠这里），这是防御——行集缩短时光标不悬在越界位。
  useEffect(() => {
    setTrashSel((s) => Math.min(s, Math.max(0, (trashRows ?? []).length - 1)));
  }, [trashRows]);
  // 输入即查（无 debounce v1）：空查询回列表态；非空走 onSearch，未回
  // 前渲染「搜索中…」。拒答按空处理（诚实空态，不造数据）。
  const runSearch = (text: string): void => {
    const query = text.trim();
    const seq = ++searchSeq.current;
    setSel(0);
    setConfirm(null); // ω99-279（续，标记见上）：选项集换了，行内确认随之复原
    if (query === "") {
      setHits(null);
      return;
    }
    setHits(null);
    onSearch(query).then(
      (r) => { if (searchSeq.current === seq) setHits(r); },
      () => { if (searchSeq.current === seq) setHits([]); },
    );
  };
  // The sessions op returns mtime-ASC (store.list() sorts oldest-first for
  // --continue; nothing in driver/server flips it — the TUI's /resume picker
  // .slice(-10).reverse()s on top). 时间倒序 is the picker's own job: sort
  // newest-first, THEN cap. Slicing the wire order showed the 20 OLDEST.
  const shown =
    rows
      ?.slice()
      .sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
      .slice(0, SESSION_PICKER_CAP) ?? null;
  // ω99-178: #3 — 日期分组：shown 已 mtime-desc，分组标签只在变更时出现
  // （同侧栏的连续段逻辑，SessionSidebar :191-197 的镜像）。
  let lastG = "";
  // ω99-279（续，标记见上）— 确认删除的发射口：先清确认态再发 op；应答
  // deleted=true 时重跑当前查询（列表态 q="" 即回列表，行集由 App 的
  // sessionsEpoch 重发接管；搜索态同 q 重扫——删了就搜不到）。
  const doDelete = (id: string): void => {
    setConfirm(null);
    void onDelete?.(id).then((ok) => {
      if (ok) runSearch(q);
    });
  };
  // 选中行的 {key,id}（确认态键盘的寻址面；两态各自取，越界=null）。
  const selEntry = searching
    ? hits !== null && hits[sel] !== undefined
      ? { key: `${hits[sel]!.sessionId}-${sel}`, id: hits[sel]!.sessionId }
      : null
    : shown !== null && shown[sel] !== undefined
      ? { key: shown[sel]!.id, id: shown[sel]!.id }
      : null;
  const onKeyDown = (e: React.KeyboardEvent): void => {
    /* ω99-151: 组合期 IME 拥有键盘——Enter 是确认候选，不是切换会话。 */
    if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
    // ω99-283（续，标记见上）：Esc 分层最外层——回收站视图 Esc=返回主列表
    // （不关弹框）。
    // ω99-284（续，标记见上）：回收站面升到三面同构键盘契约——↑↓ 选择
    // （clamp 无环绕，同主列表范式）· Enter 恢复（行在场时复用恢复钮的
    // onRestore 调用形）；空行集 ↑↓/Enter no-op（clamp 到 -1 再渲染
    // undefined 行是错形）；其余键仍吞掉（回收站面独占键盘）。
    if (trashView) {
      if (e.key === "Escape") {
        e.preventDefault();
        setTrashView(false);
        return;
      }
      const tRows = trashRows ?? [];
      if (tRows.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setTrashSel((s) => Math.min(s + 1, tRows.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setTrashSel((s) => Math.max(s - 1, 0));
          return;
        }
        if (e.key === "Enter") {
          e.preventDefault();
          const r = tRows[trashSel];
          if (r !== undefined) {
            void onRestore?.(r.id).then((ok) => {
              if (ok) setTrashView(false); // 成功 → 视图回主列表（同恢复钮车道）
            });
          }
          return;
        }
      }
      return;
    }
    // ω99-279（续，标记见上）：Esc 分层——确认态先 consumed（行内复原），非确认态才关弹框
    // （ui-review-r3 I6 的「加载中也能关」语义在非确认态保持不变）。
    if (e.key === "Escape") {
      e.preventDefault();
      if (confirm !== null) {
        setConfirm(null);
        return;
      }
      onClose();
      return;
    }
    // ω99-279（续，标记见上）：Del（向前删除键）进确认态。preventDefault 收编查询框的
    // 前向删字（palette 对方向键的同款收编；Backspace 不收——打字高频）。
    if (
      e.key === "Delete" && onDelete !== undefined && selEntry !== null && selEntry.id !== activeId
    ) {
      e.preventDefault();
      setConfirm(selEntry);
      return;
    }
    // 查询态的选项集是 hits（未回=0 项不可导航）；列表态是 shown。
    if (searching) {
      if (hits === null) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => Math.min(s + 1, hits.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => Math.max(s - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // 选中行正处确认态 → Enter=确认删除（不是恢复）。
        if (confirm !== null && selEntry !== null && confirm.key === selEntry.key) {
          doDelete(confirm.id);
          return;
        }
        const h = hits[sel];
        if (h !== undefined) onPick(h.sessionId);
      }
      return;
    }
    if (shown === null) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, shown.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (confirm !== null && selEntry !== null && confirm.key === selEntry.key) {
        doDelete(confirm.id);
        return;
      }
      const row = shown[sel];
      if (row !== undefined) onPick(row.id);
    }
  };
  return (
    <div className="search-scrim" onClick={onClose}>
      <div
        className="search-pop"
        role="dialog"
        aria-label="会话列表"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        // ω99-151: 组合起止落进守卫状态（组合事件从输入框冒泡可达）。
        onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
        onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
        onKeyDown={onKeyDown}
      >
        {/* ω99-283（续，标记见上）：回收站视图换头（契约行同款——让面语义可见）。 */}
        <div className="session-head">
          {trashView
            ? "回收站 — ↑↓ 选择 · Enter 恢复 · Esc 返回列表" /* ω99-284（续，标记见上）：键盘契约文案（三面同构） */
            : searching
              ? "全文搜索 — ↑↓ 选择 · Enter 恢复 · Esc 关闭"
              : "切换会话 — ↑↓ 选择 · Enter 恢复 · Esc 关闭"}
        </div>
        {/* ω99-283（续，标记见上）：回收站视图藏搜索框（搜索是主列表的面）。 */}
        {!trashView ? (
          <input
            ref={qRef}
            className="session-q"
            type="text"
            placeholder="搜索所有会话内容…"
            aria-label="搜索所有会话内容"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              // 组合期不发（imeRef 已由 compositionstart 置位；组合的最后
              // 一次 change 在 compositionend 前抵达）。
              if (!imeRef.current.composing) runSearch(e.target.value);
            }}
            onCompositionEnd={(e) => {
              imeRef.current = imeEnd(imeRef.current, Date.now());
              runSearch((e.target as HTMLInputElement).value);
            }}
          />
        ) : null}
        <div
          className="search-results session-results" // ω99-178: #4 — 修饰类：弹框专用 max-height（基础 .search-results 零触，FileSearch 共用）
          role="listbox"
          aria-label={trashView ? "回收站列表" : undefined}
          aria-activedescendant={
            trashView
              ? // ω99-284（续，标记见上）：回收站态跟 trashSel（行集空/光标越界 → 无锚）。
                (trashRows ?? [])[trashSel] !== undefined
                ? `${listId}-opt-${trashSel}`
                : undefined
              : (searching ? hits !== null && hits[sel] !== undefined : shown !== null && shown[sel] !== undefined)
                ? `${listId}-opt-${sel}`
                : undefined
          }
        >
          {/* ω99-283（续，标记见上）：回收站视图——行渲染复用会话行形态（title
              梯+相对时间+预览），每行「恢复」钮；行体不可点（回收件不能直接
              进入——先恢复）。空回收站诚实空态。 */}
          {trashView ? (
            trashRows === null || trashRows.length === 0 ? (
              <div className="search-empty">回收站是空的</div>
            ) : (
              trashRows.map((r, i) => (
                <div
                  key={r.id}
                  // ω99-284（续，标记见上）：id 锚/sel 类/aria-selected——主列表与
                  // 搜索命中行同款（aria-activedescendant 的指向面 + 键盘选中可见）。
                  id={`${listId}-opt-${i}`}
                  className={`search-item session-item${i === trashSel ? " sel" : ""}`}
                  role="option"
                  aria-selected={i === trashSel}
                  data-id={r.id}
                  title={sessionTitleTip(r)}
                >
                  <div className="session-row1">
                    <span className="session-title">{sessionTitle(r)}</span>
                    <span className="session-time">{relTime(r.mtime)}</span>
                    <button
                      className="session-restore wudao"
                      aria-label="恢复这个会话"
                      title="恢复这个会话"
                      onClick={(e) => {
                        e.stopPropagation();
                        void onRestore?.(r.id).then((ok) => {
                          if (ok) setTrashView(false); // 成功 → 视图回主列表（失败留在回收站，toast 已由 App 给）
                        });
                      }}
                    >恢复</button>
                  </div>
                  <div className="session-preview">{sessionPreview(r)}</div>
                </div>
              ))
            )
          ) : searching ? (
            hits === null ? (
              <div className="search-empty">搜索中…</div>
            ) : hits.length === 0 ? (
              <div className="search-empty">没有找到相关内容</div>
            ) : (
              hits.map((h, i) => {
                const hitKey = `${h.sessionId}-${i}`;
                return (
                <div
                  key={hitKey}
                  id={`${listId}-opt-${i}`}
                  className={`search-item session-item${i === sel ? " sel" : ""}${confirm?.key === hitKey ? " session-confirm" : ""}`}
                  role="option"
                  aria-selected={i === sel}
                  data-id={h.sessionId}
                  title={sessionTitleTip(searchHitRow(h))}
                  // ω99-279（续，标记见上）：确认行点行体=复原；普通行照旧恢复。
                  onClick={() => (confirm?.key === hitKey ? setConfirm(null) : onPick(h.sessionId))}
                >
                  {confirm?.key === hitKey ? (
                    <div className="session-row1">
                      <span className="session-title">删除这个会话？</span>
                      <SessionConfirmActions id={h.sessionId} onConfirm={doDelete} onCancel={() => setConfirm(null)} />
                    </div>
                  ) : (
                    <>
                      <div className="session-row1">
                        <span className="session-title">{sessionTitle(searchHitRow(h))}</span>
                        <span className={`session-kind${h.kind === "assistant" ? " ans" : ""}`}>{h.kind === "user" ? "问" : "答"}</span>
                        <span className="session-time">{relTime(h.mtime)}</span>
                        {onDelete !== undefined && h.sessionId !== activeId ? (
                          <SessionDelButton rowKey={hitKey} id={h.sessionId} onArm={setConfirm} />
                        ) : null}
                      </div>
                      <div className="session-preview">{highlightSnippet(h.snippet, q.trim())}</div>
                    </>
                  )}
                </div>
                );
              })
            )
          ) : shown === null ? (
            <div className="search-empty">加载中…</div>
          ) : shown.length === 0 ? (
            <div className="search-empty">暂无会话</div>
          ) : (
            shown.map((r, i) => {
              const g = sessionGroup(r.mtime);
              const head =
                g !== lastG ? (
                  <div className="session-pg" role="presentation" key={`${r.id}-g`}>{g}</div>
                ) : null;
              lastG = g;
              return (
                <Fragment key={r.id}>
                  {head}
                  <div
                    id={`${listId}-opt-${i}`}
                    className={`search-item session-item${i === sel ? " sel" : ""}${confirm?.key === r.id ? " session-confirm" : ""}`}
                    role="option"
                    aria-selected={i === sel}
                    data-id={r.id}
                    // ω99-178: #2 — 悬停读完整首行（sessionTitleTip 截 120），主行
                    // 的 16 字梯截断在 tooltip 里补全；空会话兜 id8。
                    title={sessionTitleTip(r)}
                    // ω99-279（续，标记见上）：确认行点行体=复原；普通行照旧恢复。
                    onClick={() => (confirm?.key === r.id ? setConfirm(null) : onPick(r.id))}
                  >
                    {confirm?.key === r.id ? (
                      <div className="session-row1">
                        <span className="session-title">删除这个会话？</span>
                        <SessionConfirmActions id={r.id} onConfirm={doDelete} onCancel={() => setConfirm(null)} />
                      </div>
                    ) : (
                      <>
                        <div className="session-row1">
                          {/* ω99-286（续，标记见上）— 未完成小标（title 梯前）：
                              session-kind 既有 chip 面（搜索行「问/答」同款类，
                              零新 CSS）；undefined/false 无标（旧 server 行容忍）。 */}
                          {r.unfinished === true ? <span className="session-kind">未完成</span> : null}
                          <span className="session-title">{sessionTitle(r)}</span>
                          <span className="session-time">{relTime(r.mtime)}</span>
                          {onDelete !== undefined && r.id !== activeId ? (
                            <SessionDelButton rowKey={r.id} id={r.id} onArm={setConfirm} />
                          ) : null}
                        </div>
                        <div className="session-preview">{sessionPreview(r)}</div>
                      </>
                    )}
                  </div>
                </Fragment>
              );
            })
          )}
        </div>
        {/* ω99-283（续，标记见上）— 弹框底部行：主列表态显「回收站 (N)」入口
            （N=当前回收件数；车道缺席（trashRows null / onRestore 缺席）整行
            隐藏——回归 279 面）；回收站态显「← 返回会话列表」。按钮复用全局
            wudao 令牌面（零新 CSS 文件）。搜索态不显（入口属于列表底）。 */}
        {trashView ? (
          <div className="btnrow">
            <button className="wudao" onClick={() => setTrashView(false)}>← 返回会话列表</button>
          </div>
        ) : !searching && trashRows !== null && onRestore !== undefined ? (
          <div className="btnrow">
            <button
              className="session-trash-link wudao"
              onClick={() => {
                setConfirm(null); // 进回收站前复原行内确认（单态面）
                setTrashSel(0); // ω99-284（续，标记见上）：进面光标复位顶行（与 setTrashView(true) 同点）
                setTrashView(true);
              }}
            >回收站 ({trashRows.length})</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** ω99-277（续，标记见上）— a hit's title-row shim: SessionSearchHit → the
 * SessionRow shape sessionTitle/sessionTitleTip read (name:"" 折叠为 absent，
 * firstUser/mtime 同义直通；id8 三级回退由既有梯自带). */
export function searchHitRow(h: SessionSearchHit): SessionRow {
  return {
    id: h.sessionId,
    mtime: h.mtime,
    messages: 0,
    firstUser: h.firstUser,
    model: "",
    ...(h.name !== "" ? { name: h.name } : {}),
  };
}

/** ω99-279（续，标记见上）— 行悬停删除钮（列表行与搜索命中行共用）：
 * stopPropagation（行体点击是恢复）；真机 :hover/.sel 显形，jsdom 用
 * class 断言。rowKey 是确认态的行键（命中行 ≠ sessionId）。 */
export function SessionDelButton({ rowKey, id, onArm }: {
  rowKey: string;
  id: string;
  onArm(entry: { key: string; id: string }): void;
}): React.JSX.Element {
  return (
    <button
      className="session-del"
      aria-label="删除这个会话"
      title="删除这个会话"
      onClick={(e) => {
        e.stopPropagation();
        onArm({ key: rowKey, id });
      }}
    ><IconTrash size={12} /></button>
  );
}

/** ω99-279（续，标记见上）— 行内确认动作对：[删除]（危险色复用 --danger，
 * 零新色系）+ [取消]；各 stopPropagation（确认行行体点击=复原）。 */
export function SessionConfirmActions({ id, onConfirm, onCancel }: {
  id: string;
  onConfirm(id: string): void;
  onCancel(): void;
}): React.JSX.Element {
  return (
    <span className="session-confirm-actions">
      <button
        className="session-del-ok"
        onClick={(e) => {
          e.stopPropagation();
          onConfirm(id);
        }}
      >删除</button>
      <button
        className="session-del-cancel"
        onClick={(e) => {
          e.stopPropagation();
          onCancel();
        }}
      >取消</button>
    </span>
  );
}

/** ω99-277（续，标记见上）— the snippet with the matched term highlighted
 * (case-insensitive find, original casing kept; no match → plain text — the
 * ellipsis sides still read). */
export function highlightSnippet(snippet: string, q: string): React.JSX.Element {
  if (q === "") return <>{snippet}</>;
  const i = snippet.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{snippet}</>;
  return (
    <>
      {snippet.slice(0, i)}
      <span className="session-hit-mark">{snippet.slice(i, i + q.length)}</span>
      {snippet.slice(i + q.length)}
    </>
  );
}

/** M76-ux2 §4: the finish notification's title (both paths carry it — the
 *  desktop notification body and the browser-tab flash). */
export const FINISH_TITLE = "✅ 悟道Harness — 任务完成";

/** M76-ux2 §4 (workspace-ux A2): the DESKTOP path — the notification plugin
 *  through the shared tauriInvoke seam (three-tier resolve, see
 *  ../tauri-invoke.ts). true = the plugin took it; false = no bridge OR the
 *  invoke threw — an async upgrade over the old fire-and-forget: a rejected
 *  notify now lands on the caller's title flash, so the user ALWAYS learns
 *  the run landed, never an unhandled rejection. */
export async function tauriNotifyFinish(): Promise<boolean> {
  return tauriNotify(FINISH_TITLE);
}

/** ui-review-r3 P5: is the window VISIBLE but unfocused (the user is in
 *  another app — the run's tab sits exposed on a second screen)? A missing
 *  hasFocus (old embedded webviews) reads FOCUSED: the extra arm degrades
 *  to the old hidden-only behavior, never over-notifies. */
export function windowUnfocused(): boolean {
  try {
    return typeof document.hasFocus === "function" ? !document.hasFocus() : false;
  } catch {
    return false;
  }
}

/** 推理档三级配置 S5: the current provider's display label for the
 *  EffortSelector footer (「设为 {label} 默认」). Undefined hides the footer
 *  (card not found / no live provider — the footer's pin has no row). */
export const providerCardLabel = (gate: SettingsStatus | null, provider: string | undefined): string | undefined => {
  if (gate === null || provider === undefined || provider === "") return undefined;
  // providers 是可选字段（老 driver / 最小 payload 不带 —— 同调用点 efforts ?? [] 的惯例）
  const card = (gate.providers ?? []).find((p) => p.provider === provider);
  return card !== undefined ? card.label : undefined;
};

// —— 借鉴弧 α2 顺带拆分（文件行数棓轮「把压力推向拆分」）：App 的新对话确认卡外提至此（ClearConfirm 的家族位）。行为逐字节一致（纯搬家）。
export function NewChatConfirm({ onChoose }: { onChoose: (yes: boolean) => void }): React.JSX.Element {
  const resolved = useRef(false);
  const ref = useRef<HTMLDivElement>(null);
  // UI-5 INFO-2: the focus-return sweep — the + trigger gets its focus back
  // when the confirm resolves (declared BEFORE the steal effect, per the
  // FileSearch declaration-order rule).
  useFocusReturn();
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
        className="modal-card pop-in"
        role="dialog"
        aria-label="新对话"
        ref={ref}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Enter") {
            e.preventDefault();
            choose(false);
          }
        }}
      >
        <h3>清空当前对话？</h3>
        <div className="muted">未保存的工作保留在磁盘</div>
        <div className="btnrow">
          <button type="button" className="wudao danger" onClick={() => choose(true)}>
            确认
          </button>
          <button type="button" className="wudao" onClick={() => choose(false)}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
