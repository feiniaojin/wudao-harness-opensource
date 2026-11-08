// App — the wudao ui shell (full M43-B surface). Composition only; every
// rule lives in the mirror modules (protocol client, input machine, slash
// helpers, frontend-commands router). Layout: header, reconnect banner,
// conversation column (history + local notes + plan review + live area,
// tail-followed), the input area (steering-capable), the status bar, and
// the modal layer (permission ask, /resume picker, /clear confirm).
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { HistoryEntry, SessionRow, SessionSearchHit, SettingsStatus, WudaoClient, ImageAttachmentRefWire, FileBlockWire, ScheduleListRow } from "../protocol.js";
import { cycleMode, modeLabel, MAX_RECONNECT_ATTEMPTS, modelPickCommand, providerEffortSavePayload } from "../protocol.js";
// 弧 δ — the busy-row detach op handler (module-level).
import { makeDetachHandler } from "../detach-op.js";
// M64-visual §4: the theme/accent channel — applyTheme/readTheme (Task 1) +
// the accent twin; the ui.theme/ui.accent settings keys persist the pick.
import { applyAccent, applyTheme, readAccent, readTheme, type ThemeName } from "../theme.js";
import { matrixReady, wizardShouldShow } from "../wizard.js";
import { useUi } from "../use-ui.js";
// 多 driver 并发弧 C — 车道视图层（视图派生/按会话分键的视图状态/侧栏徽标
// 集/点击三路决策）+ 两个外提钩子（行数抵扣，行为零变）。
import { useLaneView, useSessionViews, busySessionIdsOf, pickLaneRoute } from "../use-lane-view.js";
import { useFinishNotify } from "../use-finish-notify.js";
import { useAwaitingSessions } from "../use-awaiting-sessions.js";
// ω99-213: #4 — the away-recap trigger + banner card (chat-top, no modal).
import { useRecap } from "../use-recap.js";
import { RecapBanner } from "./RecapBanner.js";
// ω99-242: #10 — the recovered session's reconciliation line (chat-top under
// the recap banner): 已验证完成 X / 待续 Y，counted server-side, zero fabrication.
import { useRecoveryBanner, RecoveryBanner, MorningBanner } from "./RecoveryBanner.js";
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
import { AskUserCards } from "./AskUserCards.js";
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
import { Dashboard } from "./Dashboard.js";
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
// （ω99-251 的点名标题梯子 import 已随 use-awaiting-sessions 外提。）
import { SessionSidebar, sessionTitle, sessionTitleTip, sessionGroup } from "./SessionSidebar.js";
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
import { IconSessions, IconChart, IconSettings, IconTheme, IconFolder, IconPlus, IconClose, IconFileText, IconSpinner, IconPanelLeft, IconTrash } from "./icons.js";
// workspace-ux A2: the ONE seam for desktop-plugin calls (directory dialog /
// finish notification / window drag) — no caller hand-rolls a `__TAURI__`
// optional-chain again; an absent or throwing bridge reads as null/false.
import { resolveTauriInvoke, tauriListenEvent, tauriPickDirectory, tauriStartDrag, tauriToggleMaximize } from "../tauri-invoke.js";
import { WUDAO_SCREENSHOT_EVENT, screenshotFileFromPayload } from "../screenshot-ask.js";
// M85-final I-1 — 小精灵归档轮换的会话列表刷新信号（relay 发、App 收，经
// Tauri 事件总线的主窗自环；常量住 pet-frame.ts——wire contract 之家）。
import { WUDAO_PET_SESSIONS_REFRESH_EVENT } from "../pet/pet-frame.js";
// ω99-119: 拖文件即起草 — the React-外 drop mount (main.tsx) stages its
// drafts into the module sink; this side registers the App half of the
// bridge (parked files merge + fileSeed arm, the 116 screenshot mirror).
import { setPetDropStageSink } from "../pet-drop.js";
// ω99-151: IME 组合期键盘守卫的 A 层（纯函数）——两个 picker 的 onKeyDown
// 顶置接线（组合确认=误开文件/误切会话）。
import { imeEnd, imeStart, imeSwallows, type ImeGuardState } from "./ime-guard.js";
import { JumpBottomButton, useJumpBottom } from "../use-jump-bottom.js";
import { usePointerInputMode } from "../use-pointer-input-mode.js";

import {
  BUDDY_SIDE_W,
  CHAT_W_DEFAULT,
  COMPOSER_TIPS,
  FALLBACK_FRONTEND_NOTE,
  FileSearch,
  LocalNote,
  MAX_LOCAL_NOTICES,
  MAX_TABS,
  NOTICE_FOLD_RE,
  PANEL_W_MIN,
  REVIEW_CHAT_W,
  SEARCH_MATCHED_CAP,
  SEARCH_RESULTS_CAP,
  TREE_W_DEFAULT,
  UI_LAYOUT_KEY,
  WORKSPACE_LABEL,
  appendNotice,
  clampPanelWidth,
  composerTipCursor,
  hydrateTabs,
  isBuddyNarrowWindow,
  isNarrowWindow,
  isWriteTool,
  mergeLocalNotes,
  modeReceipt,
  nextComposerTip,
  panelWMax,
  pathCharsWithHits,
  pathName,
  readPersistedLayout,
  ViewerTab,
  PersistedLayout,
} from "./app-consts.js";
import {
  SESSION_PICKER_CAP,
  SESSION_PREVIEW_CAP,
  SessionConfirmActions,
  SessionDelButton,
  SessionPicker,
  highlightSnippet,
  providerCardLabel,
  relTime,
  searchHitRow,
  sessionPreview,
} from "./app-panels.js";
export { nextComposerTip, pathCharsWithHits, MAX_LOCAL_NOTICES, appendNotice, mergeLocalNotes, FileSearch } from "./app-consts.js";
export { SessionPicker } from "./app-panels.js";
import { NewChatConfirm } from "./app-panels.js";
export { NewChatConfirm };
export type { LocalNote } from "./app-consts.js";


// —— App 模块级常量/小函数族外提（re-export 门面 + 内部使用导入）——
export function App({ client }: { client: WudaoClient }): React.JSX.Element {
  const snap = useUi(client);
  const status = snap.status;
  // 多 driver 并发弧 C —— busy 从全局改 per-lane：主车道视图=既有 busy（老
  // server 恒此路，字节不变），副车道视图读 lanes 快照位。主车道自身的门
  // （收尾通知/settle 盯梢/parked 队列）用 mainBusy 不随视角漂移；视图状态按
  // 会话分键（A 车道的回执绝不落进 B 车道，recon §G1）。v1 边界：副车道无
  // 独立 mode/model/effort 面（chips 读写主车道——显示与作用一致）。
  const { view, setViewLane } = useLaneView(snap);
  const views = useSessionViews();
  const viewSlot = views.slot(view.key);
  const busy = view.busy;
  const mainBusy = status?.busy ?? false;
  const viewingMain = view.viewingMain;
  const viewRef = useRef(view); // notify 保持 [client] 稳定的 ref 对（view/views 每渲染重建）
  viewRef.current = view;
  const viewsRef = useRef(views);
  viewsRef.current = views;

  // The slash-command registry (the menu + /help data) — fetched from the
  // driver on every (re)connect (skills may have loaded since last time).
  const [commands, setCommands] = useState<readonly SlashCommandInfo[]>([]);
  // Ephemeral view-local notices (help text, mode receipts, feedback) —
  // they never enter the server history and a replay drops them. Each rides
  // a cursor (the history length at append) so the merge interleaves it at
  // its occurrence position instead of pinning it below later messages.
  // 弧 C：按会话分键（useSessionViews）——旧单数组 retired。
  const localNotes = viewSlot.notes;
  const [resumeRows, setResumeRows] = useState<readonly SessionRow[] | null>(null);
  /* 小精灵会话弧 — 选择器意图：resume（/resume 命令的既有面）| followup
   * （空态「从历史会话提问」的追问面——拣选走 fork 流）。同一份 rows/挂载
   * 点，两套文案两套 onPick 路由。 */
  const [resumeIntent, setResumeIntent] = useState<"resume" | "followup">("resume");
  const [clearPending, setClearPending] = useState(false);
  // M53 §1: an armed /edit — the driver's branch point is set; the original
  // text sits in the input for editing (nonce keys the buffer replacement).
  const [editDraft, setEditDraft] = useState<{ readonly text: string; readonly nonce: number } | null>(null);
  // M63 §B: the settings page — a full-area view swap (chat + input hide;
  // header/banner/status bar stay).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 139 — 探针仪表盘整页开关（settings-page 同款覆盖面）。
  const [dashboardOpen, setDashboardOpen] = useState(false);
  // M63 §C: the first-run wizard's gate — resolved ONCE from settingsStatus
  // (readiness join; a ready matrix never shows the wizard). "checking" until
  // the reply lands; a gate failure never blocks the app.
  const [wizardGate, setWizardGate] = useState<"checking" | "show" | "done">("checking");
  const [gateStatus, setGateStatus] = useState<SettingsStatus | null>(null);
  // M63 §D: the 简洁/高级 shell choice. Absent preference = ADVANCED — the
  // ui.defaultMode key is only written by an explicit pick or the first-run
  // wizard's completion, so existing users never flip to 简洁模式 unbidden.
  // M65-space §1: the topbar pill is gone — the settings page's 偏好 switch
  // is the only writer, so every settingsStatus reply re-applies the stored
  // preference (the next open picks it up).
  // M78-buddy §4: the pick is tri+1 — "buddy" (the two-panel 会话列表+对话
  // shell, spec §1) joins simple/advanced; null still resolves advanced.
  const [uiMode, setUiMode] = useState<"simple" | "buddy" | "advanced">("advanced");
  // R6 quickwin: this session's composer tip — picked ONCE per App mount
  // (the module cursor), stable for the session's every re-render.
  const [composerTip] = useState(nextComposerTip);
  // Final-review F5: once the theme button (IconTheme) is clicked in THIS tab, a (re)connecting
  // settingsStatus reply stops re-applying the persisted theme, so a flip
  // inside the first-fetch window survives the stale reply that was already
  // on the wire.
  const themeTouched = useRef(false);
  // ui-review-r4 I2: the accent twin of that guard — once a LOCAL accent pick
  // lands (the settings page's 外观 chips; set through onAccentPicked), a
  // stale settingsStatus reply must not stomp it back to the persisted
  // value. Same lifecycle as themeTouched: armed on the first local change,
  // never cleared.
  const accentTouched = useRef(false);
  const chatRef = useRef<HTMLDivElement>(null);
  // M74-ide §3: the IDE panels' App-level state. The collapse flags and the
  // px widths drive the grid's --tree-w/--mid-w/--chat-w vars; treeRefresh is
  // the tree's reload key (the manual ⟳ button and the agent-write watcher
  // both land here through the same prop); mentionArm is the @-linkage seam
  // into the composer.
  // M75-ux2 §3: the single selection is now a TAB STRIP — tabs[] +
  // activeTabIndex feed BOTH the tree's highlight and the viewer's fetch;
  // centerCollapsed zeroes the middle column (the ◂ button in the strip).
  // ui-review-r3 P2: the persisted layout hydrates ONCE per mount (the ref
  // keeps re-renders from re-reading storage); the persist effect below
  // writes it back on every change. A malformed payload read as {} — every
  // initializer below keeps its factory default.
  const savedLayoutRef = useRef<Partial<PersistedLayout> | null>(null);
  if (savedLayoutRef.current === null) savedLayoutRef.current = readPersistedLayout();
  const savedLayout = savedLayoutRef.current;
  const [tabs, setTabs] = useState<readonly ViewerTab[]>(() => hydrateTabs(savedLayout));
  const [activeTabIndex, setActiveTabIndex] = useState(() => {
    const n = hydrateTabs(savedLayout).length;
    return typeof savedLayout.activeTabIndex === "number"
      ? Math.min(Math.max(Math.trunc(savedLayout.activeTabIndex), 0), Math.max(n - 1, 0))
      : 0;
  });
  const [centerCollapsed, setCenterCollapsed] = useState<boolean>(() =>
    typeof savedLayout.centerCollapsed === "boolean" ? savedLayout.centerCollapsed : false);
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() =>
    typeof savedLayout.leftCollapsed === "boolean" ? savedLayout.leftCollapsed : isNarrowWindow());
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() =>
    typeof savedLayout.rightCollapsed === "boolean" ? savedLayout.rightCollapsed : false);
  const [treeW, setTreeW] = useState(() =>
    typeof savedLayout.treeW === "number" && Number.isFinite(savedLayout.treeW)
      ? clampPanelWidth(savedLayout.treeW) // re-clamped: a narrower window since the save never restores an over-wide panel
      : TREE_W_DEFAULT);
  const [chatW, setChatW] = useState(() =>
    typeof savedLayout.chatW === "number" && Number.isFinite(savedLayout.chatW) ? clampPanelWidth(savedLayout.chatW) : CHAT_W_DEFAULT);
  // 2026-08-26 spec §3.3 — 审查专注 (review focus): a TRANSIENT geometry
  // override for the advanced shell — the tree collapses through the SAME
  // leftCollapsed mechanism, chat narrows to the 320px rail, and the
  // read-only viewer takes the 1fr remainder (编写变审查，预览为主). Enter
  // snapshots {leftCollapsed, chatW}; exit restores the snapshot. It is
  // deliberately NOT a persisted flag: quitting mid-focus leaves the bare
  // (focus-time) geometry for the next launch — spec §3.3, accepted edge.
  const [reviewFocus, setReviewFocus] = useState(false);
  const reviewSnapshotRef = useRef<{ leftCollapsed: boolean; chatW: number } | null>(null);
  const enterReviewFocus = useCallback((): void => {
    reviewSnapshotRef.current = { leftCollapsed, chatW };
    setReviewFocus(true);
    setLeftCollapsed(true);
    setChatW(REVIEW_CHAT_W);
  }, [leftCollapsed, chatW]);
  const exitReviewFocus = useCallback((): void => {
    const snap = reviewSnapshotRef.current;
    setReviewFocus(false);
    if (snap !== null) {
      setLeftCollapsed(snap.leftCollapsed);
      setChatW(snap.chatW);
    }
    reviewSnapshotRef.current = null;
  }, []);
  const toggleReviewFocus = useCallback((): void => {
    if (reviewFocus) exitReviewFocus();
    else enterReviewFocus();
  }, [reviewFocus, enterReviewFocus, exitReviewFocus]);
  // Leaving the advanced shell (the settings mode chips) exits the focus —
  // the override is advanced-only geometry; simple/buddy never see it.
  useEffect(() => {
    if (uiMode !== "advanced") exitReviewFocus();
  }, [uiMode, exitReviewFocus]);
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [mentionArm, setMentionArm] = useState<{ readonly path: string; readonly nonce: number } | null>(null);
  // M75-ux3 §6: the Ctrl+P palette's open flag + the loaded-path index.
  // FileTree reports every loaded listing through onPathsChange and the
  // ref holds the live index — the palette reads it on open/type, so no
  // per-keystroke state churn rides through the App.
  const [searchOpen, setSearchOpen] = useState(false);
  const knownPathsRef = useRef<readonly string[]>([]);
  // M75-ux3 §10: the + new-chat button's pending confirm.
  const [newChatPending, setNewChatPending] = useState(false);
  // M76-ux2 §3: the 📋 session picker — the open flag plus the ASYNC rows
  // (null while the sessions op is in flight; the picker renders 加载中…
  // instead of an empty lie).
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [sessionRows, setSessionRows] = useState<readonly SessionRow[] | null>(null);
  // ω99-283（续，标记见上）— 弹框回收站面的行集 + 纪元（null = 取数中/车道
  // 缺席 → 入口隐藏；恢复成功 bump trashEpoch → 就地重取）。与 sessionRows
  // 同款快照语义。
  const [trashRows, setTrashRows] = useState<readonly SessionRow[] | null>(null);
  const [trashEpoch, setTrashEpoch] = useState(0);
  // ω99-216: the changes panel's open flag (the chip's count comes from the
  // memoized aggregate below — no separate state, the chip IS the aggregate).
  const [changesOpen, setChangesOpen] = useState(false);
  // (ω99-219 #3 续) the computer-actions panel's open flag（计数同走聚合 memo）。
  const [computerOpen, setComputerOpen] = useState(false);
  // ω99-317 — 定时任务管理面：行快照（null = 还没读到/车道缺席 → chip 隐藏，
  // 313 侧栏 ⏰ 数据车道同款静默缺省）+ 动作纪元（每个管理动作的回执 bump
  // → 就地重读，面板开着时行内状态即时翻新）+ 面板开合位。会话名 join 用
  // schedSessions（activeName 车道顺手存的全量行——零新增读节拍）。
  const [schedRows, setSchedRows] = useState<readonly ScheduleListRow[] | null>(null);
  const [schedSessions, setSchedSessions] = useState<readonly SessionRow[] | null>(null);
  const [schedEpoch, setSchedEpoch] = useState(0);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  // M78-buddy §1: the Buddy sidebar's collapse flag (the ◂ toggle + the
  // <700px auto-collapse below both land here; 0px collapses the grid's
  // left column, spec §1).
  // ω99-206: #1 — only a saved manual COLLAPSE restores; a saved expand
  // never re-squeezes a <700px start (the stored widths' hydrate re-clamp).
  const [buddyCollapsed, setBuddyCollapsed] = useState<boolean>(() =>
    savedLayout?.buddyCollapsed === true || isBuddyNarrowWindow());
  // workspace-ux B1: the file panel's VIEW root — the tree-top switcher's
  // label/tooltip source and the FileTree's remount key. Starts at the
  // placeholder (the connect-time agentRootStatus resolves the real root);
  // a pick moves it through panelRootSet's receipt. The touched ref keeps a
  // reconnect's status reply from clobbering a live pick — once the user
  // moved the panel, only the next pick moves it again.
  const [panelRoot, setPanelRoot] = useState(WORKSPACE_LABEL);
  const panelRootTouched = useRef(false);
  // workspace-ux B3: the agent root's display mirror + the transient confirm
  // card. The mirror ("" until the connect-time agentRootStatus resolves)
  // feeds the card's "仍为 <basename>" half and the 保持现状 notice; the card
  // itself is armed by a successful panelRootSet pick and answered exactly
  // once (切换 / 保持现状 / the queued switch's settle) — plain state, so a
  // reconnect, an ask takeover, or a mode swap can only re-render it, never
  // drop the decision.
  const [agentRoot, setAgentRoot] = useState("");
  // 138 续（2026-11-03 用户令「下拉列表给一个默认空间的选项」）：boot 根
  //（会话锚）的显示镜像——「默认空间」钉项的落点，切走后一键回默认。
  const [bootRoot, setBootRoot] = useState("");
  const [rootCard, setRootCard] = useState<{
    readonly panelRoot: string;
    readonly agentRoot: string;
    queued: boolean;
  } | null>(null);
  // ui-review-r2 I1: the composer buffer's App-side mirror. A REF, not
  // state — the buffer changes per keystroke and none of that churn may
  // re-render the shell; only two readers consume it: the parked-draft seed
  // below (restore after an ask/modal unmount) and the workspace-switch
  // guard (an unsent draft must not silently die with the page).
  const draftRef = useRef("");
  const onBufferChange = useCallback((text: string): void => {
    draftRef.current = text;
  }, []);
  // M79b (I1 parity): the image rail's App-side mirror — same ref-not-state
  // discipline. The composer parks its drafts here on unmount; the seed below
  // re-arms them into the next mount (staged images survive an ask takeover).
  // Ownership: while parked here, the blob URLs stay LIVE (the composer
  // skipped its revoke); a session-switch drop (below) releases them.
  const parkedImagesRef = useRef<readonly ComposerImageDraft[]>([]);
  const onImagesChange = useCallback((drafts: readonly ComposerImageDraft[]) => {
    parkedImagesRef.current = drafts;
  }, []);
  const [imageSeed, setImageSeed] = useState<{ readonly drafts: readonly ComposerImageDraft[]; readonly nonce: number } | null>(null);
  const onImageSeedApplied = useCallback((): void => {
    setImageSeed(null);
  }, []);
  // ω99-55: the file rail's park/seed pair (the image seam's discipline; no
  // blob URLs to release — the drafts are plain File holders).
  const parkedFilesRef = useRef<readonly ComposerFileDraft[]>([]);
  const onFilesChange = useCallback((drafts: readonly ComposerFileDraft[]) => {
    parkedFilesRef.current = drafts;
  }, []);
  const [fileSeed, setFileSeed] = useState<{ readonly drafts: readonly ComposerFileDraft[]; readonly nonce: number } | null>(null);
  const onFileSeedApplied = useCallback((): void => {
    setFileSeed(null);
  }, []);
  // I1: the seed armed on a hidden→visible composer transition. The
  // composers unmount whenever an ask / the resume picker / the clear
  // confirm / the settings page / a mode swap takes the input area, and the
  // draft lived in their local state — a permission ask popping mid-typing
  // ate the text. The remount re-arms the parked buffer through the SAME
  // draft seam /edit uses.
  const [seedDraft, setSeedDraft] = useState<{ readonly text: string; readonly nonce: number } | null>(null);

  // 0.3.4 反馈: the cursor rides the CLIENT's live snapshot (not a render-
  // time ref) — notify must stamp where/when the notice landed EVEN WHEN
  // CALLED IN THE SAME TICK as a view replacement: performClear's fresh
  // receipt calls clearView() (epoch bump) and then notify(); a render-time
  // ref would still hold the PRE-bump epoch and the receipt would die in the
  // generation-wipe effect below. client is referentially stable for the
  // App's lifetime, so [client] deps keep notify as stable as [] was.
  const notify = useCallback((text: string): void => {
    // ui-review-r3 I7: consecutive duplicates fold (×N) and the list caps at
    // 50 — an unattended loop no longer stacks the same row forever.
    // ω99-276（续，标记见上）③: the stamp is (length, epoch) — the note's
    // cursor AND its view generation (cleared on the next generation wipe).
    // 弧 C：戳在「正在看的车道」的视图代上（副车道=lanes[sid] 现值），绝不跨车道。
    const live = client.getSnapshot();
    const v = viewRef.current;
    const lane = v.sid !== null ? live.lanes?.[v.sid] : undefined;
    viewsRef.current.stampNote(
      v.key,
      text,
      lane !== undefined ? lane.history.length : live.history.length,
      lane !== undefined ? lane.historyEpoch : live.historyEpoch,
    );
  }, [client]);

  // ω99-150: 侧栏行内重命名 — the ✎ rides the SAME /rename lane the TUI
  // repl speaks (client.submit); once it lands, sessionsEpoch bumps so the
  // sidebar re-reads the store (web carries no rename push event —
  // onSessionRenamed is the TUI lane). Driver semantics are honest v1:
  // /rename renames the CURRENT session, so a non-current row's ✎ GUIDES
  // (controller small-knife: without this guard the driver silently renames
  // the LIVE session while the receipt confirms the wrong object — the
  // inline-guard form follows the onOpenSearch busy-refusal precedent).
  const [sessionsEpoch, setSessionsEpoch] = useState(0);
  const onRenameSession = useCallback(
    (id: string, name: string): void => {
      if (id !== (status?.sessionId ?? null)) {
        notify("命名只对当前打开的会话生效：先打开它再命名");
        return;
      }
      void client
        .submit(`/rename ${name}`)
        .then(() => {
          setSessionsEpoch((e) => e + 1);
          notify(`会话已命名：${name}`);
        })
        .catch((e: unknown) => notify(`⚠️ 命名失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-204: #1
    },
    [client, notify, status?.sessionId],
  );

  // ω99-279（续，标记见上）— 弹框回收站式删除的 op 车道：确认后发 sessionDelete，
  // 应答分叉诚实回执（用户语，零实现术语）。deleted=true → sessionsEpoch++
  // （弹框列表态与侧栏/顶栏的重读缝同源收敛）；resolve true 让弹框自行
  // 重跑搜索查询（搜索态）。拒答（active=正在使用 / not-found=已删过）不
  // 重发不 bump——列表本来就没变。
  const onDeleteSession = useCallback(
    (id: string): Promise<boolean> =>
      client.sessionDelete(id).then(
        (r) => {
          if (r.deleted) {
            setSessionsEpoch((e) => e + 1);
            notify("已删除会话");
            return true;
          }
          if (r.reason === "active") notify("会话正在使用中，暂不能删除");
          else notify("没有找到这个会话（可能已删除）");
          return false;
        },
        (e: unknown) => {
          notify(`⚠️ 删除失败：${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      ),
    [client, notify],
  );

  // ω99-283（续，标记见上）— 弹框回收站恢复的 op 车道：点「恢复」发
  // sessionRestore，应答分叉诚实回执（用户语，零实现术语）。restored=true
  // → 双重取（sessionsEpoch++：弹框列表态与侧栏重读；trashEpoch++：回收站
  // 行集重读）+ resolve true 让弹框视图回主列表。拒答（target-exists=已
  // 存在同名会话 / not-found=回收站里已没有）不 bump 不重发——盘没变。
  const onRestoreSession = useCallback(
    (id: string): Promise<boolean> =>
      client.sessionRestore(id).then(
        (r) => {
          if (r.restored) {
            setSessionsEpoch((e) => e + 1);
            setTrashEpoch((e) => e + 1);
            notify("已恢复，回到列表可继续");
            return true;
          }
          if (r.reason === "target-exists") notify("已存在同名会话");
          else notify("回收站里已没有这条");
          return false;
        },
        (e: unknown) => {
          notify(`⚠️ 恢复失败：${e instanceof Error ? e.message : String(e)}`);
          return false;
        },
      ),
    [client, notify],
  );

  // ω99-255: #3 — 自动命名的 web 车道：触发器即状态面。sessionName 不是
  // 展示源（侧栏行名走 store 重读）——它是变化信号：跨帧比对（ref 防自激），
  // 变化才 bump 既有 sessionsEpoch，侧栏/顶栏名走 ω99-150/156 的既有重读缝
  // 自然收敛（零新组件零新 fetch 逻辑零新 op）。首帧只记录不 bump（boot/
  // resume 的名字不产生多余重读）；老 server 无字段（undefined≡null）恒静默；
  // 值不变零 bump（值不变零帧同族纪律）。
  const sessionNameSeenRef = useRef<{ name: string | null; armed: boolean }>({ name: null, armed: false });
  useEffect(() => {
    const seen = sessionNameSeenRef.current;
    const name = status?.sessionName ?? null;
    if (!seen.armed) {
      sessionNameSeenRef.current = { name, armed: true }; // 首帧只记录
      return;
    }
    if (name === seen.name) return; // 值不变/缺场——静默
    sessionNameSeenRef.current = { name, armed: true };
    setSessionsEpoch((e) => e + 1);
  }, [status?.sessionName]);

  // M85-final I-1 — 小精灵归档轮换的主窗刷新信号（spec §1 语义 A 的呈现
  // 缺口补口）：petNewSession 归档回执非 null 时主车道 sessionName 不动、
  // pet 帧无变化信号——已打开的侧栏不会重取，「精灵 · …」归档行要等某次
  // 无关操作才出现。relay（main.tsx 挂载，同窗）在回执后广播
  // WUDAO_PET_SESSIONS_REFRESH_EVENT，此监听 bump 既有 sessionsEpoch——
  // 侧栏/弹框沿 ω99-150/156/255 的同一重读缝收敛（第五个触发者，同款
  // additive 接一枪：零新组件零新 fetch 逻辑零新 op）。浏览器（listen →
  // null）静默降级——桌面桥在场才有信号。
  useEffect(() => {
    let dead = false;
    let off: (() => void) | null = null;
    void tauriListenEvent(WUDAO_PET_SESSIONS_REFRESH_EVENT, () => {
      setSessionsEpoch((e) => e + 1);
    }).then((unlisten) => {
      if (dead) unlisten?.();
      else off = unlisten;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, []);

  // ω99-116 (P1): 截图快问 — the ⌥⌘S capture arrives as {data,mediaType}
  // on the Tauri event bus (Rust stays silent on Esc; the strict guard is
  // the second line of defense). Mint it into the composer's image rail
  // through the SAME parked-rail seam an ask/modal unmount uses
  // (imageSeed): the screenshot is a deletable DRAFT — 用户看得见、可删、
  // 配一句话发送。不抢焦点（110 划词同哲学——用户在哪就在哪，图在 rail
  // 里等下次聚焦）；截了不发=不存盘——mint 只造 blob-URL 草稿，
  // attachmentSave 是 submit-only（M79b 构造性语义）。镜像先行：即使
  // composer 未挂（ask/modal 占位），merged 也先进 parkedImagesRef，
  // 重挂时经 seed 双路径收敛到同一份。
  useEffect(() => {
    let dead = false;
    let off: (() => void) | null = null;
    void tauriListenEvent(WUDAO_SCREENSHOT_EVENT, (p) => {
      const file = screenshotFileFromPayload(p);
      if (file === null) return; // Esc 取消/畸形载荷——零草稿零报错
      const { accepted, notice } = admitFiles([file], parkedImagesRef.current);
      if (notice !== null) notify(notice);
      if (accepted.length === 0) return;
      const merged = [...parkedImagesRef.current, ...accepted.map((f) => createDraft(f))];
      parkedImagesRef.current = merged;
      setImageSeed((cur) => ({ drafts: merged, nonce: (cur?.nonce ?? 0) + 1 }));
    }).then((unlisten) => {
      if (dead) unlisten?.();
      else off = unlisten;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, [notify]);

  // ω99-119 (P1): 拖文件即起草 — the pet-drop mount (main.tsx, React 外)
  // ends its pipeline at the module sink; this effect registers the App
  // half: staged drafts re-admit against the LIVE parked rail (count/budget
  // — the pipeline's own pre-flight ran against an empty rail), merge into
  // parkedFilesRef and arm fileSeed (the composer adopts them into its file
  // rail + the intent chips row appears when the buffer is empty). The 116
  // screenshot mirror: 镜像先行（composer 未挂也先进 parked），主窗不抢
  // 焦点，拖了不发=不存盘（fileSave submit-only，随 composer 自有附件轨）。
  // 回执=chips 行本身（零新事件）；宠物 busy 帧语义随 submit 时机自然后移。
  useEffect(() => {
    setPetDropStageSink((drafts) => {
      const { accepted, notice } = admitFileBatch(
        drafts.map((d) => d.file),
        parkedFilesRef.current,
      );
      if (notice !== null) notify(notice);
      if (accepted.length === 0) return;
      const merged = [...parkedFilesRef.current, ...accepted.map((f) => createFileDraft(f))];
      parkedFilesRef.current = merged;
      setFileSeed((cur) => ({ drafts: merged, nonce: (cur?.nonce ?? 0) + 1 }));
    });
    return () => setPetDropStageSink(null);
  }, [notify]);

  useEffect(() => {
    if (snap.connection !== "connected") return;
    let cancelled = false;
    client
      .listSlashCommands()
      .then((rows) => {
        if (!cancelled) setCommands(rows);
      })
      .catch(() => { /* the menu simply stays empty; submits still work */ });
    return () => {
      cancelled = true;
    };
  }, [client, snap.connection]);

  // M64-visual §4: the factory theme is DARK — stamp it at mount (main.tsx
  // does the same at first paint); a runtime toggle from a previous mount
  // stays (readTheme resolves the live attribute). The accent's factory
  // default is green (spec §1).
  useEffect(() => {
    applyTheme(readTheme());
    applyAccent(readAccent());
  }, []);

  // M63 §C+§D: one settingsStatus fetch feeds BOTH the wizard gate (resolved
  // once per mount — a ready matrix never re-checks, so the wizard cannot pop
  // back up mid-session) and the 简洁/高级 shell resolution (every
  // reconnect). Declared AFTER the slash-commands effect so the first op on
  // the wire stays listSlashCommands (the tests' op[0] seam);
  // a failure keeps the advanced default and closes the gate (enhancement,
  // not a blocker).
  useEffect(() => {
    if (snap.connection !== "connected") return;
    let cancelled = false;
    client
      .settingsStatus()
      .then((s) => {
        if (cancelled) return;
        setGateStatus(s);
        setWizardGate((gate) =>
          gate === "checking"
            ? wizardShouldShow({ providers: s.providers, wizardCompletedVersion: s.settings.wizardCompletedVersion })
              ? "show"
              : "done"
            : gate,
        );
        setUiMode(s.settings.uiDefaultMode ?? "advanced");
        // M64-visual §4: the theme/accent tri-state — null resolves the
        // factory dark/green; an explicit value wins. The theme toggle PERSISTS
        // every flip, so a reconnect reply cannot stomp a live choice (only
        // a failed write reverts, below). F5: a flip BEFORE this reply lands
        // (themeTouched) skips the re-apply entirely — the click owns the
        // session, exactly like the uiMode guard above it. ui-review-r4 I2:
        // the accent pick gets the same guard (accentTouched) — it ran
        // unconditionally, so a blue pick raced by a stale reply reverted to
        // green.
        if (!themeTouched.current) applyTheme(s.settings.uiTheme ?? "dark");
        if (!accentTouched.current) applyAccent(s.settings.uiAccent ?? "green");
      })
      .catch(() => {
        if (!cancelled) {
          setWizardGate((gate) => (gate === "checking" ? "done" : gate));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, snap.connection]);

  const refreshGateStatus = useCallback((): void => {
    client
      .settingsStatus()
      .then(setGateStatus)
      .catch(() => { /* the banner decision keeps the last known matrix */ });
  }, [client]);

  // 模型 chip 下拉 (用户反馈 2026-08-28: 不要弹窗) — the pick rides the SAME
  // submission lanes the retired modal rode: same-provider rows submit /model
  // (live-config mutation + model_change entry), cross-provider rows submit
  // /provider (M63 §A: endpoint switch, provider_change entry, fully cold
  // cache). Pure frontend — the driver-side switch machinery is untouched.
  const pickModel = useCallback(
    (model: string, provider: string): void => {
      const line = modelPickCommand({ provider, model }, status?.model?.provider);
      const cross = line.startsWith("/provider");
      void client
        .submit(line)
        .then(() => notify(cross
          ? `供应商 → ${provider} — 历史在新端点重新处理，下一轮生效（缓存全冷）` // ω99-195: #7（provider 分支中文化——同一 notify 块的另一半）ω99-310: 称谓随设置面统一
          : `模型 → ${model} — 下一轮生效`)) // ω99-195: #8（前缀+尾语，与 Wizard/ProviderDetail 对齐）
        .catch((e: unknown) => notify(`⚠️ ${line.split(" ")[0]} 失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-200: #3
    },
    [client, notify, status],
  );
  // The ModelSelector footer — persists the SESSION's current model as the
  // boot default (model.defaultModel → the global settings tier; the boot
  // applies it when no flag/env pins the field). The R6 quickwin's Ctrl+S
  // lane, made visible as a menu row.
  const persistModelDefault = useCallback((): void => {
    const m = status?.model;
    if (m == null || m.label === "") return;
    const provider = m.provider ?? "deepseek";
    void client
      .settingsSet("model.defaultModel", { provider, model: m.label })
      .then(() => notify(`已设为默认:${provider}/${m.label} —— 下次启动 wudao ui 生效`))
      .catch((e: unknown) => notify(`⚠️ 默认模型保存失败：${e instanceof Error ? e.message : String(e)}`));
  }, [client, notify, status]);

  // ω99-234: the language chip's App lanes (pickLanguage/persistLanguageDefault)
  // RETIRED with the composer chip — the write lane moved into the 偏好 tab
  // (PreferencesTab's setLanguageDefault over the page's client/notify/refresh,
  // receipts riding the settings toast stack); the /language session command
  // stays typable as-is (protocol zero-touch).

  // The EffortSelector's 设为 {provider} 默认 footer — pins the SESSION's
  // current effort as this provider's registry binding. A FULL-echo
  // settingsSaveProvider (the wholesale-replace rule: providerEffortSavePayload
  // rebuilds the row from the wire card; a bare {effort} would eat it).
  const persistEffortProviderDefault = useCallback((): void => {
    const provider = status?.model?.provider;
    const level = gateStatus?.current?.effort;
    if (provider == null || provider === "" || level == null || level === "") {
      notify("⚠️ 当前会话没有生效的推理档,无法设为默认");
      return;
    }
    const card = (gateStatus?.providers ?? []).find((p) => p.provider === provider);
    if (card === undefined) {
      notify(`⚠️ 找不到供应商 ${provider} 的注册表卡片,无法保存`);
      return;
    }
    void client
      .settingsSaveProvider(provider, providerEffortSavePayload(card, level))
      .then((r) => {
        if (r.ok) {
          notify(`已设为 ${card.label} 默认推理档:${level} —— 新会话生效`);
          refreshGateStatus();
        } else notify(`⚠️ 保存失败：${r.error}`);
      })
      .catch((e: unknown) => notify(`⚠️ 保存失败：${e instanceof Error ? e.message : String(e)}`));
  }, [client, notify, status, gateStatus, refreshGateStatus]);

  // workspace-ux B1: resolve the file panel's view root on connect — the
  // switcher's label starts at the REAL root instead of the 工作区
  // placeholder. Runs on every reconnect too, but the touched ref keeps a
  // reply from resetting a root the user already moved with a pick (the
  // op-level truth is panelRootSet's receipt, not this snapshot). An old
  // server (no op) or a shapeless reply keeps the placeholder standing.
  // workspace-ux B3: the same reply also feeds the agent-root mirror (B3's
  // card copy + the 保持现状 notice) — that half is NOT behind the touched
  // ref: the agent root moves only through agentRootSwitch, never a pick.
  useEffect(() => {
    if (snap.connection !== "connected") return;
    let cancelled = false;
    client
      .agentRootStatus()
      .then((r) => {
        if (cancelled) return;
        if (typeof r?.agentRoot === "string" && r.agentRoot !== "") setAgentRoot(r.agentRoot);
        if (typeof r?.bootRoot === "string" && r.bootRoot !== "") setBootRoot(r.bootRoot);
        if (panelRootTouched.current) return;
        if (typeof r?.panelRoot === "string" && r.panelRoot !== "") setPanelRoot(r.panelRoot);
      })
      .catch(() => { /* placeholder stays — display-only */ });
    return () => {
      cancelled = true;
    };
  }, [client, snap.connection]);

  // workspace-ux B3: the queued switch's settle watcher. A busy 切换 parked
  // server-side lands at the run's settle seam — the web never learns that
  // as an event, so the card re-checks agentRootStatus on every IDLE status
  // frame while queued (the driver pokes the status channel when the seam
  // applies the root, so the very next frame carries the landing; a frame
  // racing the seam just reads not-aligned and waits for the next one). The
  // landing notice is the driver's (history channel) — this side only
  // refreshes the mirror and dismisses the card once the roots align.
  useEffect(() => {
    if (rootCard === null || !rootCard.queued) return;
    if (status === null || mainBusy) return; // parked while the run holds the old root（弧 C：主车道位，不随视角漂移）
    let cancelled = false;
    client
      .agentRootStatus()
      .then((r) => {
        if (cancelled) return;
        if (typeof r?.agentRoot === "string" && r.agentRoot !== "") setAgentRoot(r.agentRoot);
        if (typeof r?.bootRoot === "string" && r.bootRoot !== "") setBootRoot(r.bootRoot);
        if (r?.aligned === true) setRootCard(null);
      })
      .catch(() => { /* stay queued — the next status frame retries */ });
    return () => {
      cancelled = true;
    };
  }, [client, status, mainBusy, rootCard]);

  // M76-ux2 §3: the picker's data — fetch the session rows on OPEN (not on
  // mount: the list is a snapshot for one open, and a pick replays the
  // session right after). A failure closes the picker with a notice; the
  // rows reset to null (加载中…) on every reopen.
  // ω99-279（续，标记见上）— deps 加 sessionsEpoch：删除成功的纪元 bump 让
  // 开着的弹框就地重读（删了的行消失）；初始 epoch=0 不触发，boot op 序
  // （op[0] 契约缝）不动。
  useEffect(() => {
    if (!sessionPickerOpen) return;
    setSessionRows(null);
    let cancelled = false;
    client
      .sessions()
      .then((rows) => {
        if (!cancelled) setSessionRows(rows);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSessionPickerOpen(false);
        notify(`⚠️ 会话列表加载失败：${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionPickerOpen, notify, sessionsEpoch]);

  // ω99-283（续，标记见上）— 回收站行集：弹框打开时取（与 sessions 同款
  // 打开时快照语义；恢复成功的 trashEpoch bump 让开着的弹框就地重取）。
  // 旧 server 无该 op → 拒答静默（trashRows 留 null，回收站入口隐藏——
  // 回归安全默认，弹框逐字节回 279/277 面）。
  useEffect(() => {
    if (!sessionPickerOpen) return;
    setTrashRows(null);
    let cancelled = false;
    client
      .sessionTrashList()
      .then((rows) => {
        if (!cancelled) setTrashRows(rows);
      })
      .catch(() => {
        /* 旧 server 拒答 → 车道缺席，入口隐藏 */
      });
    return () => {
      cancelled = true;
    };
  }, [client, sessionPickerOpen, trashEpoch]);

  // ω99-156: the CURRENT session's name — the driver owns it (/rename lane,
  // 150). App reads it at the same epochs the sidebar re-reads the store, so
  // every identity surface (topbar + statusbar) converges to the name the
  // user gave, from any entry (boot / typed /resume / picker pick / rename).
  // A listing miss or failure fails OPEN to the heuristic lanes below —
  // identity surfaces never break on a listing problem.
  // Placement: the brief pinned this next to sessionsEpoch (:886), but an
  // op-sending effect declared there fires BEFORE the connection-gated
  // bootstrap ops in the authOk commit (connection flips on the first state
  // frame) and steals the documented op[0] seam (listSlashCommands — see the
  // settingsStatus effect's comment). Declared here — after every
  // connection-gated op effect, beside the picker's own sessions read — the
  // boot listing lands as op #4 and the seam stands.
  const [activeName, setActiveName] = useState<string | null>(null);
  // 小精灵会话弧 — 空态双入口的数据门（同一趟 sessions 读的第 4 个消费者：
  // activeName/schedSessions/行位之后顺手喂 hero——零新增 boot op、零新增读
  // 节拍，ω99-317「同一趟读顺手留给面板」同款范式；ui-review-r2 I8 的两次
  // mount 取数钉不动）。有可续会话才亮双入口；失败/空 → 零渲染（hero 字节
  // 同形）。
  const [heroRows, setHeroRows] = useState<readonly SessionRow[] | null>(null);
  // ω99-286: #6 — 断点续跑的「当前会话未完成」位：与 activeName 同一趟
  // sessions 读（零新增 boot op、零新增读节拍——255 W2 的「帧推送零多余
  // 重读」钉住 busy 帧不是读信号，deps 保持原样），同一批行里找自己的行读
  // unfinished（?? false：旧 server 的行无此字段，永不 arm——能力缺席=
  // 面隐藏）。节拍恰是 activeName 的（会话切换 / sessionsEpoch bump）。run
  // 收尾后行位可能陈旧——不在读侧补（那正是 255 钉死的零多余重读面），
  // 点击时 op 回执收敛：started:false → 「没有需要继续的任务」toast，按钮
  // 已随点击解除（arm 单发）。
  // ω99-289: #4 — arm 记 mode（报告实名：`{sid, mode}` 单对象形）：
  // unfinished（286 中断面，文案/回执零漂移）/ errored（失败面——行
  // errored ?? false 同款容忍，横幅与回执按 mode 分语）。两行位互斥（判据
  // 形状自身保证），同趟读零新增节拍。
  // 多 driver 并发（09-17 用户令）：断点续跑/失败重试横幅退役——continueArm
  // 武装态随横幅一起退役（弹框「未完成」chip 面不受影响，它读行字段自渲染）。
  useEffect(() => {
    const sid = status?.sessionId;
    if (sid === undefined) return;
    let cancelled = false;
    void client
      .sessions()
      .then((rows) => {
        if (cancelled) return;
        const row = rows.find((r) => r.id === sid);
        setActiveName(row !== undefined && row.name !== undefined && row.name !== "" ? row.name : null);
        // ω99-317: 同一趟读顺手把全量行留给定时任务面板的会话名 join——
        // 零新增读节拍（255 W2 的「零多余重读」钉），节拍恰是本车道的。
        if (!cancelled) setSchedSessions(rows);
        // 小精灵会话弧：同一趟读喂空态双入口的数据门（见 heroRows 声明注）。
        if (!cancelled) setHeroRows(rows);
      })
      .catch(() => {
        if (!cancelled) setActiveName(null);
        if (!cancelled) setSchedSessions(null);
        if (!cancelled) setHeroRows([]); // 失败=空（双入口静默隐藏，零报错面）
      });
    return () => {
      cancelled = true;
    };
  }, [client, status?.sessionId, sessionsEpoch]);

  // ω99-317 — 「定时 N」chip 的数据车道：schedulesList 的行快照。与 313 侧
  // 栏 ⏰ 标记的数据车道同节拍（会话切换 / sessionsEpoch bump 重读），外加
  // schedEpoch（管理动作回执 bump → 开着的面板就地翻新）。旧 server 无该
  // op 或读败 → null → chip 静默隐藏（313 同款缺省，绝不白屏）。
  useEffect(() => {
    let cancelled = false;
    client
      .schedulesList()
      .then((rows) => {
        if (!cancelled) setSchedRows(rows);
      })
      .catch(() => {
        if (!cancelled) setSchedRows(null);
      });
    return () => {
      cancelled = true;
    };
  }, [client, status?.sessionId, schedEpoch, sessionsEpoch]);

  // ω99-317 — 管理面三动作的公共收尾：守护中文回执原样 notify（ok/false 皆
  // 然——回执本身就是用户可读的判决），然后 bump 纪元就地重读行快照。传输
  // 层错误（掉线/旧 server）走 ⚠️ 前缀的失败通知。
  const schedActionDone = useCallback(
    (e: unknown): void => {
      notify(`⚠️ 定时任务操作没成功：${e instanceof Error ? e.message : String(e)}`);
    },
    [notify],
  );
  const onSchedToggle = useCallback(
    (id: string, enabled: boolean): void => {
      void client.schedulesSetEnabled(id, enabled).then(
        (r) => {
          notify(r.message);
          setSchedEpoch((e) => e + 1);
        },
        schedActionDone,
      );
    },
    [client, notify, schedActionDone],
  );
  const onSchedRemove = useCallback(
    (id: string): void => {
      void client.schedulesRemove(id).then(
        (r) => {
          notify(r.message);
          setSchedEpoch((e) => e + 1);
        },
        schedActionDone,
      );
    },
    [client, notify, schedActionDone],
  );
  const onSchedRun = useCallback(
    (id: string, resetBreaker: boolean): void => {
      void client.schedulesRunNow(id, resetBreaker ? { resetBreaker: true } : undefined).then(
        (r) => {
          notify(r.message);
          setSchedEpoch((e) => e + 1);
        },
        schedActionDone,
      );
    },
    [client, notify, schedActionDone],
  );

  // M72 §3: the history merge is memoized so streaming status frames (which
  // change neither snap.history nor localNotes) keep ONE identity down both
  // shells — HistoryList's grouping transform and its memoized rows bail
  // instead of rebuilding per delta. 0.3.4 反馈（切模式通知钉底）: localNotes
  // interleave at their cursor instead of concatenating at the end — a notice
  // renders where it happened, like a message.
  // ω99-276（续，标记见上）③ — 合并时刻先按视图代滤一遍：reset 帧与代清效
  // 应之间恰有一帧渲染（effect 在 commit 后才跑），不过滤的话旧代回执会在新
  // 会话转录尾部闪现一帧。状态修剪归下方 epoch 效应，这里保证「永远不渲染」。
  const history = useMemo(
    () => mergeLocalNotes(view.history, localNotes.filter((n) => n.epoch === view.historyEpoch)),
    [view.history, localNotes, view.historyEpoch],
  );

  // 0.3.82（0.3.81 凌乱反馈）: the ADVANCED face's edit entries ride the
  // shared EditCard now — a collapsed 「修改 <path>」 row that mounts at
  // tool-call START, so it needs the LIVE in-flight paths to spin the run
  // glyph honestly (the write landing flips the row to its ok glyph).
  // busyTools is a FRESH array on
  // every wire frame (each snapshot is a new JSON object), so the memo alone
  // would churn the Set identity per frame and re-render every memoized row;
  // the ref keeps the PREVIOUS Set when content is equal — the prop's
  // identity changes only when the running-edit set itself changed (the
  // forkBadgeKeys prop-for-memoized-list idiom).
  const runningEditPathsRef = useRef<ReadonlySet<string> | null>(null);
  const runningEditPaths: ReadonlySet<string> = useMemo(() => {
    const paths = new Set(
      (status?.live.busyTools ?? [])
        .filter((t) => t.name === "edit" || t.name === "write_file")
        .map((t) => t.summary),
    );
    const prev = runningEditPathsRef.current;
    if (prev !== null && prev.size === paths.size && [...paths].every((p) => prev.has(p))) return prev;
    runningEditPathsRef.current = paths;
    return paths;
  }, [status?.live.busyTools]);

  // -------------------------------------------------------------------------
  // ω99-258: #10 — 面三/面四接线（armed 态 + 徽标 + chip 节拍）。
  // ω99-258 — the branch face (桌面「从这里岔开」与分支切换)。M53 的分支能力
  // 早已在（arm/tree/switch 三 op）；这里只是第一公里的 UI 态：armed 横幅（原
  // 文已带回输入框，取消即解除 edit n:0）、岔轮 ⑂ 徽标（键 = historyKey，armed
  // submit 的 echo 落地即挂）、分支 chip 的重取节拍（fork 落地 / epoch 复位）。
  // SimpleMode/pet 车道零渲染——本块只喂共享 chatColumn（advanced/buddy）。
  // -------------------------------------------------------------------------
  /** The armed /edit — the branch point the NEXT plain submit forks from.
   *  弧 C：按会话分键（viewSlot）——视图切换不串台，回来仍在。 */
  const armedEdit = viewSlot.armedEdit;
  /** The branch bar's refetch clock (mount + fork-landed + history reset). */
  const [branchRefresh, setBranchRefresh] = useState(0);
  /** historyKeys of turns that entered on a branch (the ⑂ badge source).
   *  弧 C：同按会话分键（B 车道的行键绝不 badge 到 A 车道的转录上）。 */
  const forkBadgeKeys = viewSlot.forkBadges;
  /** null = idle; otherwise the armed submit's TEXT — the badge lands on the
   *  last user turn once it carries this text (order-immune: the server's
   *  echo append and the submit op's reply race, and either may land first;
   *  keying by the PRE-submit last-user anchor loses that race). */
  const forkEchoText = viewSlot.forkEcho;
  // Stale-closure guards for the submit seam (the onSubmitRef idiom).
  const armedEditRef = useRef<{ readonly n: number } | null>(null);
  armedEditRef.current = armedEdit;

  // A history REPLACEMENT (clear/resume/branch switch — reset:true bumps the
  // VIEWED lane's epoch) retires the armed banner (a wholesale swap disarms
  // the driver server-side), drops the badges (a replaced history re-keys rows
  // positionally — stale keys could misbadge an unrelated turn), and pokes
  // the branch bar's snapshot. It does NOT drop forkEchoText: the branch
  // flow's own cut lands as a reset BEFORE the echo turn appends.
  // 弧 C：同键同代才退役（视图切换≠换代，各键 armed 各自留存）。
  const retireGenRef = useRef<{ key: string; epoch: number } | null>(null);
  useEffect(() => {
    const prev = retireGenRef.current;
    if (prev !== null && prev.key === view.key && prev.epoch !== view.historyEpoch) {
      views.setArmedEdit(view.key, null);
      views.setForkBadges(view.key, new Set());
      setBranchRefresh((v) => v + 1);
    }
    retireGenRef.current = { key: view.key, epoch: view.historyEpoch };
  }, [view.key, view.historyEpoch, views]);

  /* ω99-276（续，标记见上）③ — 系统消息的代换清理（用户令 09-11「系统消息
     只打到当前激活的会话中，切换会话之后就应该清理了，展示会话的历史」）：
     historyEpoch 一跳 = 视图整体换代（resume 切会话 / clear 开新会话 / 重连
     重放都是 reset:true 重放）。旧代的 localNotes（模式切换回执、busy 拒令、
     命名回执…）在新会话的转录里是串台的杂物——曾经「停在末尾」地跨代存活，
     切几个会话就堆几层（用户看到的「一直都在，非常凌乱」）。清到只剩当前代：
     与重放同批落地的回执（clear 的「已开启新会话」——notify 读 live 快照，
     盖的就是新代戳）与重建后的服务端收据（resume 的「↪ 已恢复」append）都
     属于新会话的视图，不受影响。弧 C：同键同代才清（分键的另一面）。*/
  const wipeGenRef = useRef<{ key: string; epoch: number } | null>(null);
  useEffect(() => {
    const prev = wipeGenRef.current;
    if (prev !== null && prev.key === view.key && prev.epoch !== view.historyEpoch) {
      views.filterNotes(view.key, (n) => n.epoch === view.historyEpoch);
    }
    wipeGenRef.current = { key: view.key, epoch: view.historyEpoch };
  }, [view.key, view.historyEpoch, views]);

  // The branch turn's echo: badge the LAST user turn once its text is the
  // armed submit's (the echo turn; the old same-text turn it forked from is
  // never last once the echo lands — and before it lands, the last user turn
  // is the old text, so the wait is exact).
  useEffect(() => {
    if (forkEchoText === null) return;
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const e = history[i];
      if (e === undefined || e.kind !== "user") continue;
      if (e.text !== forkEchoText) return; // the echo has not landed yet
      const key = historyKey(e, i);
      views.setForkBadges(view.key, forkBadgeKeys.has(key) ? forkBadgeKeys : new Set([...forkBadgeKeys, key]));
      views.setForkEcho(view.key, null);
      return;
    }
  }, [history, forkEchoText, view.key, views, forkBadgeKeys]);

  /** The one arm seam, two doors (the hover 「从这里岔开」 and /edit <n>): arm
   *  the branch, land the original text back. 弧 C：分支面 v1 仅主车道（edit
   *  op 无 sid 路由——车道视图下诚实拒答）。 */
  const armFromTurn = useCallback(
    (n: number): void => {
      if (!viewingMain) {
        notify("⚠️ 岔开仅支持主车道（当前在副车道视图）");
        return;
      }
      if (busy) {
        notify("⚠️ 运行中无法岔开（任务进行中）");
        return;
      }
      void client
        .edit(n)
        .then((text) => {
          if (text === null) {
            notify(`无法从第 ${n} 轮岔开——没有这条消息`);
            return;
          }
          setEditDraft((cur) => ({ text, nonce: (cur?.nonce ?? 0) + 1 }));
          views.setArmedEdit(viewRef.current.key, { n });
        })
        .catch((e: unknown) => notify(`⚠️ 岔开失败：${e instanceof Error ? e.message : String(e)}`));
    },
    [busy, client, notify, viewingMain],
  );
  // Stable seam for the memoized HistoryItem rows (the onErrorAction idiom).
  const armFromTurnRef = useRef(armFromTurn);
  armFromTurnRef.current = armFromTurn;
  const onForkTurn = useCallback((n: number): void => {
    armFromTurnRef.current(n);
  }, []);

  /** The banner's 取消 — void the arm server-side (edit n:0); an old server's
   *  refusal keeps the banner up honestly (the arm survives, the next submit
   *  WOULD fork — better a standing banner than a silent surprise). */
  const cancelArmedEdit = useCallback((): void => {
    const armed = armedEditRef.current;
    void client
      .disarmEdit()
      .then(() => {
        views.setArmedEdit(viewRef.current.key, null);
      })
      .catch((e: unknown) => {
        notify(`⚠️ 解除岔开失败：${e instanceof Error ? e.message : String(e)}——下次发送仍将${armed !== null ? `从第 ${armed.n} 轮` : ""}开分支`);
      });
  }, [client, notify]);

  /** A submit took the turn — an armed submit just became the branch turn:
   *  retire the banner, arm the echo badge (keyed by the submitted TEXT —
   *  order-immune against the echo append), and poke the chip's snapshot. */
  const onTurnTook = useCallback((text: string): void => {
    if (armedEditRef.current === null) return;
    armedEditRef.current = null;
    viewsRef.current.setArmedEdit(viewRef.current.key, null);
    viewsRef.current.setForkEcho(viewRef.current.key, text);
    setBranchRefresh((v) => v + 1); // the chip's N/M moved to the new line
  }, []);

  // ω99-216: the session-changes aggregate — pure fold over the WIRE history
  // (localNotes never carry changes), memoized on the same identity contract
  // as the merge above: streaming status frames rebuild nothing. fileCount>0
  // is the chip's render gate (zero-changes history renders NO chip — the
  // append-only red line: history without the field is byte-identical).
  const changesAgg = useMemo(() => aggregateSessionChanges(view.history), [view.history]);

  // (ω99-219 #3 续) the computer-actions aggregate — same identity contract as
  // the changes memo above (WIRE history, streaming frames rebuild nothing).
  // totalSteps>0 is the chip's render gate: a history without computer-tool
  // entries renders NO chip (读写会话顶栏字节不变——append-only 红线)。
  const computerAgg = useMemo(() => aggregateComputerActions(view.history), [view.history]);

  // 4 — 回来摘要：per-viewer lastSeen（localStorage）+ visibilitychange
  // 双阈触发（≥10 分钟 且 ≥3 条新消息）→ recap op → 顶部横幅卡。读 WIRE 历史
  // （view.history——与 driver getHistory 索引一致，弧 C：被看车道；合并视图里的 localNotes 会
  // 挪位 mark）。声明在 connect 早退之前（hook 数不随连接态变）。
  const recap = useRecap({
    client,
    sessionId: view.sessionId,
    history: view.history,
    historyEpoch: view.historyEpoch,
  });

  // ω99-242 — 被恢复会话的对账行：当前会话在 server 协调器有记录才渲染
  //（null = 零渲染；老 server 拒答也是安静的零）。X/Y 是结构化数据数出的。
  // ω99-248 — 同一 fetch 再导出晨间「等你决定」行（权限挂起证据在行上才
  // 有；见 RecoveryBanner.morningLineOf）。
  const { line: recoveryLine, morning: recoveryMorning, awaiting: awaitingIds } = useRecoveryBanner(client, status?.sessionId, snap.historyEpoch);

  // ω99-251/254 — 全局发现性三件套（徽标集 / 欢迎面点名联表 / 系统级通知）
  // 外提为 useAwaitingSessions（多 driver 弧 C 的行数抵扣，行为零变）。
  const awaiting = useAwaitingSessions(client, awaitingIds);
  const awaitingNames = awaiting.names;
  const awaitingSet = awaiting.set;

  // ω99-218: #4 — 模型选择器「最近使用」：读 store 初始化 + 快照驱动写点。
  // effect 盯 LIVE status.model 的 {label, provider} 实变（不是 gateStatus —
  // 那份快照在模型切换后不刷新，会漏掉选择器/slash 输入/persona 路由的切换；
  // WS state 帧是唯一全切换面覆盖的信号）。上次已写对存 ref，快照变且 ≠ ref
  // 才 touch（失败 op 不产生快照变化就不记录——诚实写点）；boot 首观察即播种
  // 当前模型（首见=在用，列表从第一天自 populate）。写不回灌快照 = 零自激。
  const [recentModels, setRecentModels] = useState<readonly RecentModel[]>(readRecent);
  const recentModelsRef = useRef<readonly RecentModel[]>(recentModels);
  const lastTouchedModelRef = useRef<RecentModel | null>(null);
  useEffect(() => {
    const m = status?.model;
    if (m == null || m.label === "" || m.provider === undefined || m.provider === "") return;
    const entry: RecentModel = { provider: m.provider, model: m.label };
    const last = lastTouchedModelRef.current;
    if (last !== null && last.provider === entry.provider && last.model === entry.model) return;
    lastTouchedModelRef.current = entry;
    const next = writeRecent(touchRecent(recentModelsRef.current, entry));
    recentModelsRef.current = next;
    setRecentModels(next);
  }, [status?.model?.label, status?.model?.provider]);

  // M74-ide §3: agent refresh (spec §2) — watch the RAW driver history (the
  // merge below adds localNotes, which never carry tool entries) for NEW
  // write_file/edit_file tool entries and bump the tree's refresh key; the
  // tree re-fetches its root + expanded dirs while keeping the user's place.
  // The epoch guards the replay: the auth/reconnect/clear/resume history is
  // a REPLACEMENT (reset:true → historyEpoch bumps), so the mark RESEEDS
  // there instead of reading the replayed tail as fresh writes — only
  // entries that append WITHIN one epoch can bump the refresh.
  // M76-ux2 §1: the same watcher now also RECORDS the new writes' summaries
  // (the target paths) in the agent-modified set — FileTree marks those
  // rows with the accent bar until the user's manual ⟳ or a workspace
  // switch clears the set. The ref carries the mutable set; the KEY is the
  // state that makes each mutation visible (a ref alone never re-renders).
  const seenEpoch = useRef<number>(-1);
  const seenKey = useRef<string>("");
  const seenWrites = useRef(0);
  const agentModifiedRef = useRef<Set<string>>(new Set());
  const [agentModifiedKey, setAgentModifiedKey] = useState(0);
  useEffect(() => {
    const writeEntries = view.history.filter(isWriteTool);
    if (seenKey.current !== view.key || seenEpoch.current !== view.historyEpoch) {
      // A replay (or 弧 C's view switch) is a replacement, not news — reseed.
      seenKey.current = view.key;
      seenEpoch.current = view.historyEpoch;
      seenWrites.current = writeEntries.length;
      return;
    }
    if (writeEntries.length > seenWrites.current) {
      // The delta beyond the seen count is exactly what this frame added.
      for (const e of writeEntries.slice(seenWrites.current)) {
        if (e.summary !== "") agentModifiedRef.current.add(e.summary);
      }
      setAgentModifiedKey((k) => k + 1);
      setTreeRefresh((k) => k + 1);
    }
    seenWrites.current = Math.max(seenWrites.current, writeEntries.length); // a shrink resyncs, never bumps
  }, [view.history, view.historyEpoch, view.key]);

  // ui-review-r4 I3: the panels' reconnect refetch. The commands list and
  // settingsStatus re-fetch on snap.connection, but the tree caches key on
  // refreshKey (write-tool watcher only) and the viewer on [client,path,isDir]
  // — after a gave-up→重连 the panels kept rendering STALE pre-drop content
  // while the banner implied recovery. A reconnect's re-auth lands a
  // reset:true replay, which bumps historyEpoch (protocol.ts — verified), so
  // epoch moves are the reconnect signal (they also cover /clear and resume,
  // where a refetch is equally right: the workspace may have moved on). The
  // FIRST epoch change is the mount's own auth replay — the tree mounts
  // behind the settingsStatus gate and fetches fresh anyway, so only changes
  // AFTER that first one bump the refresh key.
  const epochWatch = useRef<{ at: number; changes: number } | null>(null);
  useEffect(() => {
    const w = epochWatch.current ?? (epochWatch.current = { at: view.historyEpoch, changes: 0 });
    if (w.at === view.historyEpoch) return;
    w.at = view.historyEpoch;
    w.changes += 1;
    if (w.changes > 1) setTreeRefresh((k) => k + 1);
  }, [view.historyEpoch]);

  // M76-ux2 §1: the marker set's TWO clears — the manual ⟳ (FileTree's
  // onManualRefresh) and a workspace switch. An AGENT-driven refresh never
  // clears: the marks exist to survive their own write's reload.
  const onClearAgentModified = useCallback((): void => {
    if (agentModifiedRef.current.size === 0) return;
    agentModifiedRef.current.clear();
    setAgentModifiedKey((k) => k + 1);
  }, []);

  // ui-review-r2 I1: the parked-draft seed. The input area hides when an
  // ask / the resume picker / the clear confirm / the settings page takes
  // the surface (and every mode swap replaces the composer COMPONENT); on
  // each such transition the parked buffer (draftRef) re-arms through the
  // SAME draft seam /edit uses, so the text the user was typing survives
  // the interruption. TUI parity: a confirmed /clear does NOT drop the
  // parked draft — only a real submit ever consumes the buffer.
  const inputHidden = settingsOpen || (status?.pendingPermission ?? null) !== null || resumeRows !== null || clearPending;
  const inputStateRef = useRef<{ hidden: boolean; mode: "simple" | "buddy" | "advanced"; session: string | null }>({ hidden: false, mode: "advanced", session: null });
  useEffect(() => {
    const prev = inputStateRef.current;
    const unhide = prev.hidden && !inputHidden;
    const swap = prev.mode !== uiMode;
    // 弧 C：分键到「正在看的会话」——A 会话的草稿不落进 B 会话的 composer。
    const sessionSwitched = prev.session !== view.sessionId;
    // r2-review MINOR: a parked draft must not ride a session SWITCH — text
    // typed against session A stays out of session B's fresh composer. The
    // /clear non-drop (TUI parity) is unchanged: same session, buffer kept.
    if (unhide && sessionSwitched) {
      draftRef.current = "";
      // M79b: staged images follow the same rule — and unlike text they hold
      // resources, so the drop RELEASES them (the parked URLs stay live only
      // while they can still be re-armed).
      for (const d of parkedImagesRef.current) releaseDraft(d);
      parkedImagesRef.current = [];
      // ω99-55: staged files drop the same way (no URLs to release).
      parkedFilesRef.current = [];
    } else {
      if ((unhide || swap) && draftRef.current.trim() !== "") {
        setSeedDraft((cur) => ({ text: draftRef.current, nonce: (cur?.nonce ?? 0) + 1 }));
      }
      // M79b: the parked rail re-arms through the same transition.
      if ((unhide || swap) && parkedImagesRef.current.length > 0) {
        setImageSeed((cur) => ({ drafts: parkedImagesRef.current, nonce: (cur?.nonce ?? 0) + 1 }));
      }
      // ω99-55: the file rail re-arms alongside.
      if ((unhide || swap) && parkedFilesRef.current.length > 0) {
        setFileSeed((cur) => ({ drafts: parkedFilesRef.current, nonce: (cur?.nonce ?? 0) + 1 }));
      }
    }
    inputStateRef.current = { hidden: inputHidden, mode: uiMode, session: view.sessionId };
  }, [inputHidden, uiMode, view.sessionId]);

  // M74-ide §3 (spec §1): <900px auto-collapses the LEFT panel — and only
  // on the DOWNWARD crossing, so a manual re-expand at a narrow width stands
  // (and a wide window's manual collapse survives unrelated resizes). The
  // initial narrow case resolves in the useState initializer.
  const prevNarrow = useRef<boolean>(isNarrowWindow());
  const prevBuddyNarrow = useRef<boolean>(isBuddyNarrowWindow());
  useEffect(() => {
    const onResize = (): void => {
      const narrow = isNarrowWindow();
      if (narrow && !prevNarrow.current) setLeftCollapsed(true);
      prevNarrow.current = narrow;
      // M78-buddy §1 (spec §1): <700px collapses the Buddy sidebar — the
      // same downward-only crossing rule (a manual re-expand at a narrow
      // width stands; a wide window's manual collapse survives).
      const buddyNarrow = isBuddyNarrowWindow();
      if (buddyNarrow && !prevBuddyNarrow.current) setBuddyCollapsed(true);
      prevBuddyNarrow.current = buddyNarrow;
      // ui-review-r4 P3: re-clamp BOTH stored widths — the clamp reads the
      // CURRENT window, so a tree dragged to 720px on a 1800px window stayed
      // 80% of a later 900px one (only the collapse crossings were handled).
      // State is set only when the clamped value actually differs, so an
      // unrelated resize never churns the persist effect. Widening never
      // grows a panel (the stored pick stands; the next drag re-sizes).
      setTreeW((w) => {
        const c = clampPanelWidth(w);
        return c !== w ? c : w;
      });
      setChatW((w) => {
        const c = clampPanelWidth(w);
        return c !== w ? c : w;
      });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ui-review-r3 P2: persist the layout slice on every change — ONE
  // versioned key (a shape change bumps the v1, old payloads read as
  // defaults). A blocked or full storage is a silent no-op: the layout just
  // doesn't survive the reload. The shell MODE is deliberately absent —
  // settings' ui.defaultMode already persists it (no duplication).
  useEffect(() => {
    try {
      window.localStorage.setItem(
        UI_LAYOUT_KEY,
        JSON.stringify({
          treeW,
          chatW,
          leftCollapsed,
          centerCollapsed,
          rightCollapsed,
          buddyCollapsed,
          tabs: tabs.map(({ path, isDir }) => ({ path, isDir })),
          activeTabIndex,
        } satisfies PersistedLayout),
      );
    } catch {
      /* quota/blocked storage — the defaults own the next mount */
    }
  }, [treeW, chatW, leftCollapsed, centerCollapsed, rightCollapsed, buddyCollapsed, tabs, activeTabIndex]);

  // M74-ide §3 + M75-ux2 §3: the tree → app wiring. A file/dir row click
  // opens (or activates) a CENTER TAB — the tree highlights the active
  // tab's path, the viewer renders it; the @ button arms the composer's
  // mention (the InputBox appends the trailing @token and reports back, the
  // same arm/apply discipline as the /edit draft).
  const activeTab: ViewerTab | null = tabs[activeTabIndex] ?? null;
  const openTab = (path: string, isDir: boolean): void => {
    const existing = tabs.findIndex((t) => t.path === path);
    if (existing >= 0) {
      setActiveTabIndex(existing); // §4: re-clicking a dir collapses the subtree, keeps the tab
      return;
    }
    // ω99-153: at cap, evict the OLDEST tab the user is not currently viewing
    // (the on-screen tab is sacred — an editor never silently closes the
    // visible buffer) and SAY which tab gave way (notify = the .notice-bub
    // lane the rename guidance rides).
    if (tabs.length >= MAX_TABS) {
      const evictIdx = activeTabIndex === 0 ? 1 : 0;
      const evicted = tabs[evictIdx];
      if (evicted !== undefined) {
        const next = tabs.filter((_, i) => i !== evictIdx).concat({ path, name: pathName(path), isDir });
        setTabs(next);
        setActiveTabIndex(next.length - 1);
        notify(`标签已满（${MAX_TABS} 个）：已关闭「${evicted.name}」`);
        return;
      }
    }
    const next: ViewerTab[] = [...tabs, { path, name: pathName(path), isDir }];
    setTabs(next);
    setActiveTabIndex(next.length - 1);
  };
  const closeTab = (index: number): void => {
    const next = tabs.filter((_, i) => i !== index);
    setTabs(next);
    setActiveTabIndex((cur) => {
      if (next.length === 0) return 0; // last close → the strip's [+] placeholder + empty viewer
      if (index < cur) return cur - 1; // a close left of the active shifts the strip
      if (index === cur) return Math.min(cur, next.length - 1); // activate the neighbor
      return cur;
    });
  };
  // 墨线 T11 (controller 补完): the viewer head's × — the SAME close the
  // tabbar's × rides (closeTab on the active index). Not one of the
  // viewer's fetch-effect keys, so a fresh identity per render is safe.
  const closeActiveTab = (): void => {
    if (activeTab !== null) closeTab(activeTabIndex);
  };
  const onTreeSelect = (path: string, isDir?: boolean): void => {
    openTab(path, isDir === true);
  };
  // ui-review-r3 P2: a persisted tab whose target no longer exists drops
  // when its read rejects (FileViewer's onReadFailed → closeTab's index
  // dance). The latest-ref keeps the callback identity STABLE — the viewer's
  // fetch effect keys on it — while the behavior stays current.
  const dropTabRef = useRef<(path: string) => void>(() => {});
  dropTabRef.current = (path: string): void => {
    const idx = tabs.findIndex((t) => t.path === path);
    if (idx >= 0) closeTab(idx);
  };
  const onTabReadFailed = useCallback((path: string): void => {
    dropTabRef.current(path);
  }, []);
  // 高亮 spec §2 落点 4: history chips open file tabs. The latest-ref keeps
  // the callback identity STABLE (HistoryList is React.memo — a fresh closure
  // per render would rebuild every row on each streaming frame); the
  // dropTabRef precedent two blocks up.
  const openFileRef = useRef<(path: string) => void>(() => {});
  openFileRef.current = (path: string): void => { openTab(path, false); };
  const onHistoryOpenFile = useCallback((path: string): void => { openFileRef.current(path); }, []);
  const onAtMention = useCallback((path: string): void => {
    setMentionArm((cur) => ({ path, nonce: (cur?.nonce ?? 0) + 1 }));
  }, []);
  const onMentionApplied = useCallback((): void => {
    setMentionArm(null);
  }, []);

  // M75-ux3 §6: the palette's index feed + open seam. onOpenPath lands on
  // the SAME tab strip a tree-row click drives (openTab — the palette opens
  // or activates a CENTER TAB); closing on open is the palette's own
  // discipline, not the opener's.
  const onKnownPaths = useCallback((paths: readonly string[]): void => {
    knownPathsRef.current = paths;
  }, []);
  const getAllKnownPaths = useCallback((): readonly string[] => knownPathsRef.current, []);
  const onOpenPath = (path: string): void => {
    setSearchOpen(false);
    openTab(path, false);
  };

  // M75-ux2 §3: the tab gestures are APP-level keys (registered here, not in
  // the composer): Ctrl+W closes the active tab, Ctrl+Tab / Ctrl+Shift+Tab
  // cycle (wrapping), Ctrl+1~9 jump to the Nth. Inert while the strip is
  // empty — the simple shell and a fresh mount share that no-op. The focus
  // refinements (§13: which keys the composer keeps) land with the global
  // shortcut registry; these three never collide with its set.
  // ui-review-r1 I4: CTRL-ONLY. The old ctrl||meta guard preventDefaulted
  // Cmd+W with a tab open — hijacking close-window on the macOS shell and
  // close-tab in browsers (Cmd+1~9 is the browser's own tab jump too); the
  // Cmd-combos stay the platform's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey) return;
      if (e.key === "w" || e.key === "W") {
        if (tabs.length === 0) return;
        e.preventDefault();
        closeTab(activeTabIndex);
        return;
      }
      if (e.key === "Tab") {
        if (tabs.length < 2) return;
        e.preventDefault();
        setActiveTabIndex((cur) => (cur + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length);
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (idx >= tabs.length) return;
        e.preventDefault();
        setActiveTabIndex(idx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabs, activeTabIndex]);

  // M75-ux3 §13 (subset) — the global chords, registered on window so they
  // fire with the composer focused too (the input never claims these
  // combos). Ctrl+P toggles the palette (§6); Ctrl+B toggles the left
  // panel; Ctrl+\ toggles the CENTER panel (Task 2's --mid-w collapse —
  // the state lives here now, the seam is wired); Cmd+, (Mac) / Ctrl+,
  // (elsewhere) opens settings. The palette's own input owns its keys
  // while focused — a chord typed THERE stays there, so Ctrl+P never
  // self-closes the palette it just focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey) return; // Alt-combos stay the platform's
      const t = e.target;
      // ui-review-r3 P4: swallow ONLY the palette-owning chord while the
      // palette's input holds focus — Ctrl+P there never re-toggles the
      // palette it just focused (Esc/arrows/typing are the input's own
      // keys already). Every OTHER chord (Ctrl+B, Ctrl+\, Cmd/Ctrl+,) now
      // reaches the global handler with the palette open, instead of dying
      // at the old blanket guard.
      if (
        t instanceof HTMLInputElement &&
        t.classList.contains("search-input") &&
        e.ctrlKey &&
        (e.key === "p" || e.key === "P")
      ) {
        return;
      }
      if (e.ctrlKey && (e.key === "p" || e.key === "P")) {
        e.preventDefault();
        setSearchOpen((v) => !v);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
        return;
      }
      if (e.ctrlKey && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        setLeftCollapsed((v) => !v);
        return;
      }
      // 2026-08-26 §3.3: Ctrl+Shift+\ toggles 审查专注 (review focus) —
      // matched on e.code, not e.key: US layouts give Shift+\ the key "|",
      // so the plain branch would never fire there (and on layouts where
      // e.key stays "\\" it would double-fire). The plain chord keeps a
      // !shiftKey guard so the two can never collide.
      if (e.ctrlKey && e.shiftKey && e.code === "Backslash") {
        e.preventDefault();
        toggleReviewFocus();
        return;
      }
      if (e.ctrlKey && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        setCenterCollapsed((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleReviewFocus]);

  // M74-ide §3 (spec §1): pointer-driven width resize. mousedown arms (the
  // start pointer + the start width); window-level mousemove recomputes the
  // clamped px value; mouseup releases. The width lives in React state and
  // reaches the grid through the inline --tree-w/--chat-w var, so CSS and
  // drag agree on one number.
  const beginPanelDrag = useCallback(
    (side: "left" | "right") => (e: React.MouseEvent): void => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = side === "left" ? treeW : chatW;
      const setW = side === "left" ? setTreeW : setChatW;
      const onMove = (ev: MouseEvent): void => {
        const delta = ev.clientX - startX;
        setW(clampPanelWidth(side === "left" ? startW + delta : startW - delta));
      };
      const onUp = (): void => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [treeW, chatW],
  );

  // M76-ux2 §5 (spec #19): double-click on a drag handle resets that side to
  // its spec default (left 220 / right 360 — the 2026-08-26 §3.3 rebalance) —
  // the drag keeps fine sizing, the dbl-click is the way back. The center
  // column never participates (no default width — it is the 1fr remainder).
  const resetPanelWidth = useCallback(
    (side: "left" | "right") => (): void => {
      if (side === "left") setTreeW(TREE_W_DEFAULT);
      else setChatW(CHAT_W_DEFAULT);
    },
    [],
  );

  // ui-review-r3 I3: the keyboard twin of the drag — ArrowLeft/ArrowRight
  // move the handle ±16px through the SAME clamp the drag (and the
  // double-click reset) ride; Home/End hit the clamp's floor/ceiling. The
  // arrows follow the HANDLE's facing (the right handle: → narrows — the
  // same mirrored delta a drag of that handle applies).
  const nudgePanelWidth = useCallback(
    (side: "left" | "right") => (e: React.KeyboardEvent): void => {
      const setW = side === "left" ? setTreeW : setChatW;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const toward = (e.key === "ArrowRight" ? 1 : -1) * (side === "left" ? 1 : -1);
        const cur = side === "left" ? treeW : chatW;
        setW(clampPanelWidth(cur + 16 * toward));
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        setW(clampPanelWidth(PANEL_W_MIN));
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        setW(clampPanelWidth(panelWMax()));
      }
    },
    [treeW, chatW],
  );

  // M75-ux3 §9 (ui-review-r5 I3: the shared seam): the chat's scroll
  // telemetry — onScroll tracks the distance from the bottom; STRICTLY more
  // than JUMP_BOTTOM_PX floats the ↓ button below. State (not a render-time
  // read) because the button must react to the user's scrolling alone, with
  // no re-render in between. 0.3.4 反馈（会话上下晃）: tail-follow moved INTO
  // the seam (stickRef, scroll-event-driven) — the local render-time
  // `atBottom` read raced streaming ticks and wobbled; see use-jump-bottom.
  const { onScroll: onChatScroll, jump: jumpToBottom, show: showJumpBottom } = useJumpBottom(chatRef);

  // ω99-312 (#456 second reopen): track the input context ourselves — the
  // pointer stamp gates the focus ring off; any keydown restores it. See
  // use-pointer-input-mode.ts for why both engine-side fixes (0.3.83's
  // :not(:focus-visible), 0.3.86's deferred refocus) could not outwait
  // WebKit's :focus-visible heuristic.
  usePointerInputMode();

  const onSubmit = useCallback(
    (text: string, images?: readonly ComposerImageInput[], files?: readonly ComposerFileInput[]): void | boolean | Promise<boolean> => {
      const hasImages = images !== undefined && images.length > 0;
      const hasFiles = files !== undefined && files.length > 0;
      if (resumeRows !== null) setResumeRows(null);
      const cmd = parseFrontendCommand(text);
      // M79b: a bare empty line stays the historical noop, but an image-only
      // turn (empty text + drafts) still sends — it rides as an empty-text
      // pass below. ω99-55: a file-only turn arms the same way.
      if (cmd.kind === "noop" && !hasImages && !hasFiles) return;
      const pass = cmd.kind === "pass" ? cmd : { kind: "pass" as const, text: "" };
      // M79b: the frontend-owned commands (exit/clear/help/resume/edit) take
      // no images — refuse BEFORE any upload, fail loud, keep the composer's
      // rail (false = the draft lease stays with the caller). Driver-routed
      // commands ride the pass below; the driver's own routing decides there.
      // ω99-55: files follow the same law.
      if ((hasImages || hasFiles) && cmd.kind !== "pass" && cmd.kind !== "noop") {
        notify(`⚠️ ${text.trim().split(/\s+/)[0] ?? "该命令"} 是界面命令,不支持附加图片或文件 —— 未发送`);
        return false;
      }
      if (cmd.kind === "exit") {
        client.close();
        return;
      }
      if (cmd.kind === "help") {
        notify(formatSlashHelp(commands, { mode: modeLabel(status?.mode ?? "workspace") }));
        return;
      }
      if (cmd.kind === "clear") {
        if (busy) {
          notify("⚠️ 运行中无法 /clear（任务进行中）");
          return;
        }
        setClearPending(true);
        return;
      }
      if (cmd.kind === "resume") {
        if (busy && !view.capable) {
          // r5 P1: the busy-refusal family is Chinese (r4 P2's /clear twin).
          // 弧 C：车道化 server 上开列表不再被 busy 拦（列表的拣选取走车道
          // 路由）；老 server 保留原门，字节不变。
          notify("⚠️ 运行中无法 /resume（任务进行中）");
          return;
        }
        void client
          .sessions()
          .then((rows) => {
            if (rows.length === 0) {
              notify("(暂无可恢复的会话)");
              return;
            }
            setResumeIntent("resume"); // 小精灵会话弧：/resume 命令面恒为恢复意图（followup 是空态入口专属）
            setResumeRows(rows);
          })
          .catch((e: unknown) => notify(`⚠️ /resume 失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-202: #2
        return;
      }
      // M53 §1: /edit <n> — arm the branch in the driver; the returned text
      // lands in the input for editing (resubmitting branches). ω99-258: ONE
      // arm seam, two doors — the hover 岔开 and the command share
      // armFromTurn, so both raise the armed banner.
      if (cmd.kind === "edit") {
        if (busy) {
          notify("⚠️ 运行中无法 /edit（任务进行中）");
          return;
        }
        armFromTurn(cmd.n);
        return;
      }
      // pass: the driver's routing seam owns it (/plan, /skill:…, /rewind,
      // plan review, @-mentions); the outcome word drives our follow-up.
      setEditDraft(null);
      if (!hasImages && !hasFiles) {
        // ui-review-r4 I1: the composer clears its buffer BEFORE this call
        // (the synchronous text-only handshake), so a FAILED send used to
        // silently destroy the composed text — the rejection only fired a
        // notice. On the failure paths the text re-arms through the seed
        // seam (nonce-bumped, so it lands even though the composer already
        // cleared): a REJECTED op (socket drop mid-flight → failPending, or
        // any server error) and a "notice"/"noop" outcome (the driver
        // refused it — run in flight, empty line — and already said why; the
        // image lease below keeps its drafts on exactly the same outcomes).
        // "started"/"steered" took the turn — cleared stays cleared.
        const rearm = (): void => {
          setSeedDraft((cur) => ({ text: pass.text, nonce: (cur?.nonce ?? 0) + 1 }));
        };
        void client
          .submit(pass.text, view.sid === null ? undefined : { sid: view.sid }) // 弧 C：车道视图的提交进对应车道
          .then((outcome) => {
            if (outcome === "frontend") notify(FALLBACK_FRONTEND_NOTE);
            else if (outcome === "notice" || outcome === "noop") rearm();
            else onTurnTook(pass.text); // ω99-258: started/steered — an armed submit became the branch turn
          })
          .catch((e: unknown) => {
            notify(`⚠️ submit 失败：${e instanceof Error ? e.message : String(e)}`); // ω99-202: #4
            rearm();
          });
        return;
      }
      // M79b: the image path — save the batch first (fail-closed admission in
      // the driver's store), then ride the returned refs on the submit
      // envelope's images field. Success (the run took the turn: started /
      // steered) releases the composer's drafts; notice/noop keep them — the
      // driver's own notice (refused command, run in flight) already said why
      // and the user resubmits once it clears. ω99-55: the file lane saves
      // through fileSave first, then both lanes ride the one submit envelope.
      return (async (): Promise<boolean> => {
        let imageBlocks: readonly { kind: "image"; ref: ImageAttachmentRefWire }[] | undefined;
        let fileBlocks: readonly FileBlockWire[] | undefined;
        try {
          imageBlocks = hasImages ? (await client.attachmentSave(images!)).map((ref) => ({ kind: "image" as const, ref })) : undefined;
        } catch (e: unknown) {
          // r5 P4: the store's admission failures (TOO_MANY_IMAGES /
          // IMAGES_TOO_LARGE) map to Chinese with the code in parens; every
          // other error passes through verbatim.
          notify(`⚠️ 图片发送失败：${attachmentSendErrorText(e instanceof Error ? e.message : String(e))}`);
          return false;
        }
        try {
          fileBlocks = hasFiles ? await client.fileSave(files!) : undefined;
        } catch (e: unknown) {
          notify(`⚠️ 文件发送失败：${fileSendErrorText(e instanceof Error ? e.message : String(e))}`);
          return false;
        }
        try {
          const outcome = await client.submit(pass.text, {
            ...(imageBlocks !== undefined && imageBlocks.length > 0 ? { images: imageBlocks } : {}),
            ...(fileBlocks !== undefined && fileBlocks.length > 0 ? { files: fileBlocks } : {}),
            ...(view.sid !== null ? { sid: view.sid } : {}), // 弧 C：车道视图的提交进对应车道
          });
          if (outcome === "frontend") notify(FALLBACK_FRONTEND_NOTE);
          const took = outcome === "started" || outcome === "steered";
          if (took) onTurnTook(pass.text); // ω99-258: the armed-submit branch turn rode this envelope too
          return took;
        } catch (e: unknown) {
          notify(`⚠️ submit 失败：${e instanceof Error ? e.message : String(e)}`); // ω99-202: #5
          return false;
        }
      })();
    },
    [client, commands, busy, notify, resumeRows, status?.mode, armFromTurn, onTurnTook, view.capable, view.sid],
  );

  const onInterrupt = useCallback((): void => {
    // 弧 C：车道视图打断对应车道（缺省=主车道，现有行为）。
    client.interrupt(view.sid === null ? undefined : view.sid).catch(() => { /* the banner/notice paths own failures */ });
  }, [client, view.sid]);

  // statecover B1: the advanced/buddy error entries' recovery lane rides the
  // SAME submit seam the composer uses — no new channel. The wrapper's
  // identity is STABLE (latest-ref, the dropTabRef idiom) so the memoized
  // HistoryItem rows (entry + this prop) still bail on streaming frames;
  // the behavior stays current through the ref.
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const onErrorAction = useCallback((text: string): void => {
    onSubmitRef.current(text);
  }, []);

  // M63 §D: the parked queue lives at APP level, not in SimpleMode — the
  // simple shell unmounts on every header-mode swap, settings-page swap, and
  // disconnect early-return, and a promise of "排队 · 下一轮处理" must
  // outlive all of them. The flush is the same rule as before: ONE parked
  // message per idle period (the guard resets only when a run actually
  // starts and ends again), and only while connected — offline the park
  // waits for the reconnect instead of popping into a dead socket.
  const [parked, setParked] = useState<readonly string[]>([]);
  const flushedThisIdleRef = useRef(false);
  const onPark = useCallback((text: string): void => {
    setParked((p) => [...p, text]);
  }, []);
  const onDropParked = useCallback((index: number): void => {
    setParked((p) => p.filter((_, i) => i !== index));
  }, []);
  useEffect(() => {
    if (snap.connection !== "connected") return;
    if (mainBusy) {
      flushedThisIdleRef.current = false;
      return;
    }
    if (!viewingMain) return; // 弧 C：parked 是主视图的队列——车道视图下不冲（冲了会把主视图的话发进副车道）
    if (parked.length === 0 || flushedThisIdleRef.current) return;
    const next = parked[0];
    if (next === undefined) return;
    flushedThisIdleRef.current = true;
    setParked((p) => p.slice(1));
    onSubmit(next);
  }, [snap.connection, mainBusy, viewingMain, parked, onSubmit]);

  // ω99-316 (/btw 侧问): the「顺便问」lane's bubbles — client-local ONLY
  // (the side answer never enters history/JSONL by contract; a reload or
  // session switch clears them naturally, and the explicit reset below
  // keeps a stale session's bubbles from riding a switch).
  // 弧 C：旁问问「正在看的会话」（op 自带 sessionId——车道视图下问该车道
  // 的会话，不串主车道）。
  const [sideQas, setSideQas] = useState<SideQa[]>([]);
  const sideSessionId = view.sessionId ?? undefined;
  useEffect(() => {
    setSideQas([]);
  }, [sideSessionId]);
  const askSideQuestion = useCallback(
    (text: string): void => {
      if (sideSessionId === undefined || sideSessionId === "") {
        notify("⚠️ 旁问需要已连接的会话");
        return;
      }
      const id = `sq-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      void client
        .sideQuestion(sideSessionId, text)
        .then((r) => {
          setSideQas((qas) => [...qas, { id, question: text, answer: r.answer, rounds: r.rounds }]);
        })
        .catch((e: unknown) => {
          // Old server / session mismatch / model failure — the err lands
          // in the bubble itself (the lane's own surface, not the global
          // notify stream: the question stays visible with its failure).
          setSideQas((qas) => [
            ...qas,
            { id, question: text, answer: `⚠️ 旁问失败：${e instanceof Error ? e.message : String(e)}`, rounds: 0 },
          ]);
        });
    },
    [client, sideSessionId, notify],
  );
  // ω99-316 超越点 1（一键转正）: the bubble's「转入主线」formats the Q/A pair
  // as ONE message and rides the EXISTING submit lane (busy → the driver's
  // steering queue; idle → direct send — zero new protocol; the bubble then
  // leaves the lane: its content has a durable home in the transcript).
  const promoteSideQa = useCallback(
    (qa: SideQa): void => {
      setSideQas((qas) => qas.filter((x) => x.id !== qa.id));
      onSubmit(formatSidePromoteMessage(qa));
    },
    [onSubmit],
  );

  // M63 §D: the simple approval card's buttons land here (same op the modal
  // uses — the two skins share one path). The PROMISE is the caller's lock:
  // resolved-true marks the ask answered; a rejection leaves the card
  // answerable (review LOW — the flag may no longer be set before the op
  // settles).
  const onAnswerPermission = useCallback((allow: boolean): Promise<boolean> => {
    return client.answerPermission(allow);
  }, [client]);

  // 借鉴弧 α2 — the queued steer's recall (the ⏳ line's ↩ button; a false
  // reply means the entry was already consumed — the frame refreshes and the
  // line is simply gone, no error toast: the outcome the user wanted).
  const onRecallSteer = useCallback((index: number, text: string): void => {
    void client.recallSteer(index, text).catch(() => { /* socket dropped — the frame will tell */ });
  }, [client]);
  const onDetachTool = useCallback(makeDetachHandler(client, notify), [client, notify]);
  // 借鉴弧 α1 — the simple face's ask card threading (the advanced column
  // renders its own above).
  const onAnswerAskUser = useCallback((answer?: string): Promise<boolean> => {
    return client.answerAskUser(answer);
  }, [client]);

  // M63 §D: the shield selector by the composer — the tier labels are the
  // novice wording for the runtime permission mode. 0.3.13 (task 214): both
  // mode paths (shield pick + shift+tab cycle) speak ONE receipt voice in
  // the user's directional framing — workspace is the DEFAULT tier, ask
  // the downgrade, auto the upgrade — and the workspace line names the
  // sensitive classes that still confirm (命令/网络/MCP).
  const onShield = useCallback((mode: ShieldMode): void => {
    client
      .setMode(mode)
      .then(() => notify(`权限档 → ${modeReceipt(mode)}`))
      .catch((e: unknown) => notify(`⚠️ 权限档切换失败：${e instanceof Error ? e.message : String(e)}`));
  }, [client, notify]);

  // M63 §D: the /edit draft seam. ω99-167: the hero chips are gone (user
  // order) — the FileViewer「改这段」chip is the remaining producer.
  const onPrefill = useCallback((text: string): void => {
    setEditDraft((cur) => ({ text, nonce: (cur?.nonce ?? 0) + 1 }));
  }, []);

  // Review NIT: the armed draft clears once a composer has APPLIED it —
  // otherwise any later composer remount (mode swap, ask takeover resolve)
  // would restore the stale text into a fresh buffer. ui-review-r2 I1: the
  // parked-draft seed clears with it (the same applied-once discipline).
  const onDraftApplied = useCallback((): void => {
    setEditDraft(null);
    setSeedDraft(null);
  }, []);

  const onCycleMode = useCallback((): void => {
    const next = cycleMode(status?.mode ?? "workspace");
    client
      .setMode(next)
      .then(() => notify(`权限档 → ${modeReceipt(next)}`))
      .catch((e: unknown) => notify(`⚠️ setMode 失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-202: #6
  }, [client, notify, status?.mode]);

  // workspace-ux B1: the switcher's pick intent — re-root the file PANEL
  // through panelRootSet. Instant and busy-safe BY DESIGN: the view root is
  // not the agent root, so the run, the draft, and the session all keep
  // their footing (the r2-I4 confirm gate existed because the old
  // switchWorkspace navigate killed the run and the draft — that premise is
  // gone, and the gate with it). The driver records the recents row itself,
  // so the wire carries the ONE op. The receipt's root drives the switcher
  // label and the tree remount; tabs/marks/palette paths die with the root
  // they were relative to.
  // 137（2026-11-02 用户报障「点击切换工作空间后没有真正切换过来」）：选
  // 目录 = 切工作区，不再分两步。原 B3 的确认卡把 agent 根留在旧目录，用
  // 户以为切了、agent 却在 ~/.wudao-desktop/workspace 里翻 Downloads——
  // 一次点击两个根一起动：agentRootSwitch 跟在 panelRootSet 后出线，idle
  // 立即生效；busy 由 driver 排队到本轮收束（不中途换根，红线的时序不
  // 变），排队态以通知说明。确认卡退役：不再 arm。
  const switchPanelRoot = useCallback(
    (path: string): void => {
      void client.panelRootSet(path).then(
        (r) => {
          const root = typeof r?.root === "string" && r.root !== "" ? r.root : path;
          panelRootTouched.current = true;
          setPanelRoot(root); // the receipt is the truth — a later status reply can't reset it
          setTabs([]); // viewer tabs name OLD-root-relative paths
          setActiveTabIndex(0);
          knownPathsRef.current = []; // the Ctrl+P index is root-relative too
          onClearAgentModified(); // M76-ux2 §1: the marks name old-root paths
          void client.agentRootSwitch(root).then(
            (sr) => {
              setAgentRoot(root); // local mirror; the status channel agrees on its next reply
              notify(sr?.applied === false
                ? `工作区切换已排队——当前任务结束后生效 → ${root}`
                : `工作区已切换（agent 工作目录已跟随）→ ${root}`);
            },
            (e) => {
              notify(`⚠️ agent 工作目录切换失败：${e instanceof Error ? e.message : String(e)}——文件面板已切到 ${root}`);
            },
          );
        },
        (e) => { notify(`⚠️ 切换失败：${e instanceof Error ? e.message : String(e)}`); },
      );
    },
    [client, notify, onClearAgentModified],
  );
  const onSwitchWorkspace = switchPanelRoot;
  const onOpenOtherWorkspace = useCallback((): void => {
    // workspace-ux A2: the dialog rides the shared tauriInvoke seam
    // (three-tier resolve). No bridge at all → the CLI notice; a null pick
    // (user cancelled / the dialog threw / an empty string — the seam already
    // normalizes all three) stays silent: same split as the old inline call.
    if (resolveTauriInvoke() === undefined) {
      notify("浏览器模式无法选择目录 — 请通过命令行启动 wudao ui --dir <path>");
      return;
    }
    void tauriPickDirectory().then((path) => {
      if (path === null) return; // user cancelled
      switchPanelRoot(path);
    });
  }, [notify, switchPanelRoot]);

  // workspace-ux B3: the card's 切换 agent 目录 answer — ALWAYS clickable
  // (run-busy is the OP's business: idle applies now, busy queues; only the
  // click's own op is single-flighted). The landing notice is the DRIVER's
  // (history channel) — the web adds no receipt copy for either outcome; a
  // rejection keeps the card armed and answerable with the error notice.
  const rootSwitchInFlight = useRef(false);
  const onAgentRootSwitch = useCallback((): void => {
    const cardNow = rootCard;
    if (cardNow === null || rootSwitchInFlight.current) return;
    rootSwitchInFlight.current = true;
    void client.agentRootSwitch(cardNow.panelRoot).then(
      (r) => {
        rootSwitchInFlight.current = false;
        if (r?.applied === true) {
          setAgentRoot(cardNow.panelRoot); // local mirror; the status channel agrees on its next reply
          setRootCard(null); // the driver's history notice is the receipt
        } else {
          setRootCard({ ...cardNow, queued: true }); // busy: park until the run's settle seam
        }
      },
      (e: unknown) => {
        rootSwitchInFlight.current = false;
        notify(`⚠️ 切换 agent 工作目录失败：${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }, [client, notify, rootCard]);

  // workspace-ux B3: the card's 保持现状 answer — the one outcome with a WEB
  // receipt (nothing moved server-side, so no driver notice exists to lean
  // on). The copy twins the driver's switch notice shape (basename + abs
  // path) so the two outcomes read as one pair.
  const onAgentRootKeep = useCallback((): void => {
    if (rootCard === null) return;
    const kept = rootCard.agentRoot;
    setRootCard(null);
    notify(kept !== "" ? `agent 工作目录保持不变 → ${pathName(kept)} (${kept})` : "agent 工作目录保持不变");
  }, [notify, rootCard]);

  // M65-space §1: the window title is the static 悟道 mark — the native bar
  // (desktop shell) and the browser tab both read document.title.
  useEffect(() => {
    document.title = "悟道Harness";
  }, [status?.sessionId]);

  // T9 墨线 + ω99-156: the topbar's session identity. The name the user GAVE
  // the session leads (the /rename lane, 150 — App's activeName read of the
  // sessions store above); an unnamed session, a listing miss, or a listing
  // failure falls open to the heuristic lanes: the FIRST user move's first
  // line (the mockup's crumb), then the 悟道 mark until that move exists.
  const sessionTitle = useMemo(() => {
    // 弧 C：车道视图不带主车道名（activeName 是主会话的 store 读）——标题梯
    // 子接管（车道行的名字在侧栏行上）。
    if (viewingMain && activeName !== null) return activeName; // ω99-156: 用户起的名优先
    for (const e of history) {
      if (e.kind !== "user") continue;
      const text = e.text;
      const nl = text.indexOf("\n");
      const line = (nl === -1 ? text : text.slice(0, nl)).trim();
      if (line !== "") return line;
    }
    return "悟道Harness";
  }, [viewingMain, activeName, history]);
  // T9 墨线: the run badge — the session's footprint as StatusBar reads it
  // (the same DriverStatus snapshot; ctx is the signal that gates the whole
  // segment, its omission convention included: no ctx reading → no badge, a
  // null node — never an empty span). The tools figure is the DISTINCT tool
  // names the session has used (a repeated read_file is still one tool).
  // ω99-298 (I7): the badge no longer repeats the ctx tail — the statusline's
  // seg-ctx is the strictly richer single home (window + ⚠ + hover breakdown);
  // ctx stays as the badge's liveness GATE, not its content.
  const toolsUsed = useMemo(
    () => new Set(history.flatMap((e) => (e.kind === "tool" ? [e.name] : []))).size,
    [history],
  );
  const tbRun =
    status !== null && status.ctxTokens !== null && status.ctxTokens.used !== null ? (
      <>
        <span className="ok">✓</span>
        {` ${toolsUsed} tools`}
      </>
    ) : null;

  // M76-ux2 §4: the agent-finish notification（外提 use-finish-notify，行为零变；弧 C 行数抵扣）。
  useFinishNotify(mainBusy, status?.sessionId ?? null);

  // M64-visual §4: the theme topbar button — optimistic flip persisted through
  // the ui.theme allowlist; a failed write reverts (the flip and its
  // persistence are one gesture).
  const onToggleTheme = useCallback((): void => {
    themeTouched.current = true; // F5: the reply still in flight must not stomp this flip
    const prev = readTheme();
    const next: ThemeName = prev === "dark" ? "light" : "dark";
    applyTheme(next);
    void client
      .settingsSet("ui.theme", next)
      .then(() => notify(`主题 → ${next === "dark" ? "暗色" : "浅色"}`))
      .catch((e: unknown) => {
        applyTheme(prev);
        notify(`⚠️ 主题切换未保存：${e instanceof Error ? e.message : String(e)}`);
      });
  }, [client, notify]);

  // M76-ux2 §7 — the menu bar's web-side plumbing. The native menu itself
  // is Rust-side (tauri::menu — tauri.conf has NO menu key in v2; the conf
  // only flips macOSPrivateApi for the bar area); a menu item's click
  // arrives as a "wudao:menu-action" DOM CustomEvent (detail = the action
  // id) — the bridge the Rust side / @tauri-apps/api listen() dispatches
  // onto. Each action routes onto an EXISTING seam: the + confirm, the settings
  // page, the Ctrl+B collapse, the theme toggle. Unknown ids no-op (the menu
  // grows Rust-side without a web change).
  useEffect(() => {
    const onMenuAction = (e: Event): void => {
      const action = (e as CustomEvent<string>).detail;
      if (action === "new-chat") setNewChatPending(true);
      else if (action === "settings") setSettingsOpen(true);
      else if (action === "toggle-left") setLeftCollapsed((v) => !v);
      else if (action === "toggle-theme") onToggleTheme();
    };
    window.addEventListener("wudao:menu-action", onMenuAction);
    return () => window.removeEventListener("wudao:menu-action", onMenuAction);
  }, [onToggleTheme]);

  // 多 driver 弧 C — 切会话不再阻塞：车道化 server 上切换是「视图动作」（主
  // 车道 busy 不再拦）。三路（pickLaneRoute）：主车道已持有→看主车道；某副
  // 车道已持有→看该车道（均零 op）；无人持有→resume {id, sid} 开新车道（车道
  // 的 reset 重放帧带同一 sid 收据化采纳）。拒答回退主视图。老 server（无
  // lanes）：保留原 busy 门 + 裸 resume 单车道路径，字节不变。
  const onPickSession = useCallback(
    (id: string) => {
      // 两路共用的判决分叉（ω99-225: #5 — occupied is actionable: name the
      // window to close or say wait; ok stays silent — the history frames
      // receipt the switch）。弧 C：车道路多一个拒答回退（回主视图）。
      const resumeNotify = (
        outcome: { readonly ok: true } | { readonly ok: false; readonly reason: "not_found" } | { readonly ok: false; readonly reason: "occupied"; readonly holderPid: number },
        onRefuse?: () => void,
      ): void => {
        if (outcome.ok) return;
        onRefuse?.();
        if (outcome.reason === "occupied") {
          notify(`⚠️ 会话正被另一个 wudao 进程（#${outcome.holderPid}）占用——请关闭旧窗口，或稍候重试`);
          return;
        }
        notify("(会话不存在 —— 可能已被删除)");
      };
      const resumeFailed = (e: unknown): void => notify(`⚠️ resume 失败：${e instanceof Error ? e.message : String(e)}`); // ω99-202: #7
      if (view.capable) {
        setResumeRows(null);
        const route = pickLaneRoute(status, snap.lanes, id);
        if (route.kind === "view-main") {
          setViewLane(null);
          return;
        }
        if (route.kind === "view-lane") {
          setViewLane(route.laneId);
          return;
        }
        const sid = route.laneId;
        setViewLane(sid); // 乐观切视角；lane 快照到位前 viewingMain 兜底渲染主车道
        const backToMain = (): void => setViewLane((cur) => (cur === sid ? null : cur)); // 拒答回主视图（已另点他行的视图不动）
        void client
          .resume(id, sid) // 车道的 reset 重放帧（同一 sid）收据化这次采纳
          .then((outcome) => resumeNotify(outcome, backToMain))
          .catch((e: unknown) => {
            backToMain();
            resumeFailed(e);
          });
        return;
      }
      // ui-review-r2 I2: the busy refusal the 📋 picker and the typed /resume
      // already apply at OPEN time — the sidebar row (and any picker that
      // outlived a run start) hits it here, at the seam every entry shares.
      if (busy) {
        notify("⚠️ 运行中无法 切换会话（任务进行中）");
        return;
      }
      setResumeRows(null);
      void client.resume(id).then(resumeNotify, resumeFailed);
    },
    [view.capable, status, snap.lanes, busy, client, notify, setViewLane],
  );

  // 多 driver 并发（09-17 用户令，0.4.1 收口）— 断点续跑/失败重试的 UI 面
  // 退役完结：横幅 JSX 早已撤（2444 区注释存档），此处再把发射口与武装态
  // 一并退役（fireContinue/onContinueRun/onRetryRun/continueArmFace/
  // retryLiveFace 原为横幅独占，无其他调用面=死代码）。协议层 sessionContinue
  // op 保留（服务面完整；UI 不再发射——用户令「全部让用户自己决定」，真停
  // 的会话用户发消息继续即可）。286/289 钉件随源演进为退役契约。

  // 弧 C — 侧栏「运行中」徽标集（主车道 busy 会话 + 每 busy 副车道的会话）；
  // undefined=老 server（无 lanes）→ 面隐藏，字节不变。
  const busySessionIds = useMemo(() => busySessionIdsOf(status, snap.lanes), [status, snap.lanes]);

  // 小精灵会话弧 — heroRows 的读面在 activeName 那一趟（零新增 boot op，见
  // 其声明注）；这里只派生「继续上次会话」的目标：mtime 最新的非 pet 行
  // （pet 会话活在精灵窗口，租约互斥不可恢复——235 行点击同判据；服务端序
  // 已按 mtime，客户端再排一次（侧栏同款防御性重排））。
  const heroLatest = useMemo(() => {
    const rows = [...(heroRows ?? [])].filter((r) => r.lane !== "pet");
    rows.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    return rows[0] ?? null;
  }, [heroRows]);

  // 小精灵会话弧 — 追问发射口：resumeFork（resume 的 fork 形 op——服务端字节
  // 复制原会话到全新 id 再 resume 副本，原会话永不改写）。成功后视图随主车
  // 道的 reset 帧自然切到副本；聚焦输入框（seed 语义=以当前 buffer 值重播+
  // focus——不打断未发送草稿），收据话术收益向（不露 fork/副本实现词）。
  // 老服务端（无该 op）→ 干净拒答 err → 失败 toast（入口不隐藏，桌面端捆绑
  // 当前 server 必有；独立旧 server 的降级面留此收据）。
  const onFollowUp = useCallback(
    (id: string) => {
      setResumeRows(null);
      void client.resumeFork(id).then(
        (outcome) => {
          if (outcome.ok) {
            setViewLane(null); // fork 永远落在主车道——视图切回主车道跟随副本
            notify("已基于这段对话开了新篇——直接输入你的问题，原对话保持不变");
            setSeedDraft((cur) => ({ text: draftRef.current, nonce: (cur?.nonce ?? 0) + 1 }));
            return;
          }
          if (outcome.reason === "busy") {
            notify("⚠️ 任务进行中——等它跑完再追问");
            return;
          }
          if (outcome.reason === "occupied") {
            notify(`⚠️ 会话正被另一个 wudao 进程（#${outcome.holderPid}）占用——请关闭旧窗口，或稍候重试`);
            return;
          }
          notify("(会话不存在 —— 可能已被删除)");
        },
        (e: unknown) => notify(`⚠️ 追问失败：${e instanceof Error ? e.message : String(e)}`),
      );
    },
    [client, notify, setViewLane],
  );

  // 小精灵会话弧 — 空态双入口：①继续上次会话=既有选中通路（onPickSession
  // 的 busy 门/占用回执原样复用）；②从历史会话提问=装载选择器（followup
  // 意图——拣选走 onFollowUp 的 fork 流）。装载失败/空列表各给安静回执。
  const onResumeLatest = useCallback((): void => {
    if (heroLatest !== null) onPickSession(heroLatest.id);
  }, [heroLatest, onPickSession]);
  const onAskFromHistory = useCallback((): void => {
    if (busy && !view.capable) {
      notify("⚠️ 运行中无法 切换会话（任务进行中）");
      return;
    }
    void client
      .sessions()
      .then((rows) => {
        if (rows.length === 0) {
          notify("(暂无可追问的会话)");
          return;
        }
        setResumeIntent("followup");
        setResumeRows(rows);
      })
      .catch((e: unknown) => notify(`⚠️ 打开会话列表失败：${e instanceof Error ? e.message : String(e)}`));
  }, [busy, view.capable, client, notify]);

  // ω99-276: #3 — buddy 侧栏「新对话」直通（用户令 09-11「开新会话就应该
  // 直接切到新的空的会话窗口，旧的会话随时通过历史会话切换恢复」）：不再
  // 走 ClearConfirm 的 清空/保留 二选一。onNewChat 移到 performClear 之后
  // 定义（引用其 fresh 档）；确认弹窗仍属于显式 /clear 与 simple/advanced
  // 顶栏 + 钮（ClearConfirm/NewChatConfirm 渲染块零改动）。

  // ui-review-r2 C1: the ONE clear path every confirm rides (typed /clear's
  // ClearConfirm, the + button's NewChatConfirm) — and, since ω99-276, the
  // buddy sidebar's 新对话 rides it DIRECTLY (fresh=true, no confirm).
  // The old typed-/clear arm wiped only the VIEW while the driver kept the
  // whole conversation — the next submit silently carried the "cleared"
  // context to the model. Now the confirm goes to the DRIVER through the
  // submit wire (a "frontend" outcome = the driver defers the render to us,
  // so the view wipe IS the clear; any other outcome leaves the view to the
  // driver's own history-reset frame), and the local clearView() fallback
  // covers only the wire that cannot take the op (offline / refused).
  // ω99-276（续，标记见上）— fresh=true 是「新对话」叙事档：/clear 在
  // driver 侧轮转 session id = 开出全新空会话，原会话文件不动、仍在侧栏
  // 列表随时切回——收据话术换成「已开启新会话…原会话已保留在列表」；
  // fresh=false（显式 /clear 确认路径）字面零漂移（components/
  // ui-review-r4 的收据钉在案）。
  const performClear = useCallback(
    (fresh = false): void => {
      const head = fresh ? "已开启新会话" : "历史已清空";
      const tail = fresh ? "原会话已保留在列表，随时点开切回" : "已保存的历史仍在磁盘，可 /resume 恢复";
      const wipeView = (receipt: string): void => {
        client.clearView();
        views.filterNotes(view.key, () => false);
        notify(receipt);
      };
      if (snap.connection !== "connected") {
        // 弧 C：clearView 只清主车道视图——车道视图离线时诚实拒答，不误清主视图。
        if (!viewingMain) {
          notify(`(${head} —— 离线且副车道无法本地清空；${tail})`);
          return;
        }
        wipeView(`(${head} —— 离线：仅视图；${tail})`);
        return;
      }
      void client.submit("/clear", view.sid === null ? undefined : { sid: view.sid }).then(
        (outcome) => {
          // M80 landed the driver's real /clear arm: "cleared" means the DRIVER
          // wiped the conversation and rotated the session id (its history
          // reset frame owns the view; the epoch re-seeds the watchers) — the
          // receipt says fresh session. "frontend" is the OLDER server's defer
          // (no driver arm existed): the view wipe IS the clear there, and the
          // receipt keeps the humbler view-reset wording.
          if (outcome === "cleared") {
            notify(`(${head} —— 全新会话；${tail})`);
          } else if (outcome === "frontend") {
            wipeView(`(${head} —— 仅重置视图；${tail})`);
          }
          // Any other outcome: the driver refused the clear itself (e.g. "notice"
          // — a run in flight) and its own notice already said why; the view
          // stays exactly as it is.
        },
        (e: unknown) => {
          wipeView(`(${head} —— /clear 未被接受: ${e instanceof Error ? e.message : String(e)}；仅视图)`);
        },
      );
    },
    [client, notify, snap.connection, views, view.key, view.sid, viewingMain],
  );

  // M78-buddy §2 → ω99-276 直通：busy 拒绝保留（措辞改新对话叙事）；确认
  // 弹窗环节退役——点按即 performClear(true)（/clear → driver 轮转 session
  // id = 直接切到新的空会话；旧会话留在列表可随时恢复）。
  const onNewChat = useCallback((): void => {
    // 多 driver 并发（09-17 用户令「运行中创建新会话不该调 /clear」）：
    // 主车道忙时开新车道（新 session id + resume 到该车道），/clear 只
    // 用于闲时从主车道原地轮转。老 server 保留旧 busy 门。
    if (busy && view.capable) {
      const newId = `wudao-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
      const sid = `L-${newId}`;
      setViewLane(sid);
      void client.resume(newId, sid).catch((e: unknown) => {
        setViewLane(null);
        notify(`⚠️ 新会话创建失败：${e instanceof Error ? e.message : String(e)}`);
      });
      return;
    }
    if (busy && !view.capable) {
      notify("⚠️ 任务进行中，稍后再开新对话");
      return;
    }
    performClear(true);
  }, [busy, notify, performClear, view.capable, client, setViewLane]);

  // M79b §3: the history-image resolve source — memoized on the two inputs
  // the generation guard cares about (client identity, session id); a status
  // frame that changes neither keeps the identity, so memoized rows bail.
  // Declared BEFORE the disconnect early-return below (hook count must not
  // depend on the connection state).
  // 弧 C：分键到正在看的会话（车道历史也是按会话成像）。
  const attachmentSource = useMemo(
    () => ({ client, sessionId: view.sessionId ?? "" }),
    [client, view.sessionId],
  );

  // 弧 C — 简洁模式的车道视图：live/planBoard/queued 是主车道内容，车道视图
  // 下掩空；busy 换车道位；pendingPermission 保留（停靠审批处处可答）。
  const simpleStatus =
    viewingMain || status === null
      ? status
      : { ...status, busy: view.busy, planBoard: null, queued: [], live: { reasoning: "", answer: "", busyTools: [] } };

  // statecover A4 — the pre-app connection screen, redesigned to the token
  // language (the old bare-text .connect strip was the app's most visible
  // never-designed face): a centered surface card with the 悟 logo, one of
  // three honest states, and the mono detail line (state token + close code)
  // kept reachable. connecting+authenticating share the spinner card (they
  // differ only in the meta token); auth-failed and closed get their own
  // copy and, for closed, the one actionable escape the state has — a page
  // reload. Presentation only: the F5 theme/reconnect interplay is untouched
  // (the settingsStatus effect below requires "connected"; the theme button
  // lives in the topbar this branch never renders).
  if (snap.connection !== "connected" && snap.connection !== "reconnecting" && snap.connection !== "gave-up") {
    const state = snap.connection;
    return (
      <div className="app">
        <div className="connect-shell">
          <div className="connect-card" role={state === "auth-failed" ? "alert" : "status"}>
            <div className="logo" aria-hidden={true} />
            {state === "auth-failed" ? (
              <>
                <div className="connect-title">认证失败</div>
                <div className="connect-msg err">Token 无效或已过期 —— 请重新打开启动时打印的 URL 完成认证</div>
              </>
            ) : state === "closed" ? (
              <>
                <div className="connect-title">连接已断开</div>
                {/* ω99-232: #2 — closed 卡出路句（同 #1 的死端口事实）：刷新
                    是本状态唯一的自救，但旧地址若已失效，刷新只在死 URL 上
                    循环——补一行从桌面应用重开会话的出路。标题与「刷新页面
                    重连」按钮保留（state-cover 钉）。 */}
                <div className="connect-msg">若刷新后仍连不上，请从 wudao 桌面应用重新打开会话（旧地址可能已失效）。</div>
                <button type="button" className="wudao action" onClick={() => window.location.reload()}>
                  刷新页面重连
                </button>
              </>
            ) : (
              <>
                <div className="connect-row">
                  <IconSpinner className="spin" />
                  <span className="connect-title">正在连接 wudao 服务…</span>
                </div>
                {/* ω99-232: #3 — connecting 卡 msg 去实现术语（user-facing
                    copy = benefits 规矩）：「sidecar」是 harness 内部词，
                    用户行动位在应用形态里——长停即重开应用（双形态弧 #1/#2
                    的同族句）。 */}
                <div className="connect-msg">若长时间停留在此，请重新打开 wudao 桌面应用。</div>
              </>
            )}
            <div className="connect-meta">{`wudao ui · ${state}${snap.lastClose !== null ? ` · close ${snap.lastClose.code}` : ""}`}</div>
          </div>
        </div>
      </div>
    );
  }

  const ask = status?.pendingPermission ?? null;
  // 借鉴弧 α1 — the parked ask_user clarification card (null on old servers).
  const pendingAsk = status?.pendingAskUser ?? null;
  const connected = snap.connection === "connected";

  // M78-buddy §3: the conversation column — the advanced shell's chat cell,
  // extracted so the Buddy 模式 right panel renders the SAME stack (spec §3:
  // HistoryList + InputBox; the IDE panels are what buddy drops, not the
  // chat). One element, two render sites, never both mounted at once.
  const chatColumn = (
    <>
      <div className="chat" ref={chatRef} onScroll={onChatScroll}>
        {/* ω99-258: the branch line — 转录头 chip「第 N/M 条线」+ 叶表面板
            （主入口裁定：转录头——岔开点都在下面的转录里，入口俯瞰它）；无数据/
            单线/老 server → 零渲染（零噪音门）。弧 C：分支面 v1 仅主车道。 */}
        {viewingMain ? <BranchBar client={client} refreshTick={branchRefresh} /> : null}
        {/* The away-recap banner: chat-top, no modal, no
            interruption; null payload = not mounted (zero render). */}
        {recap.payload !== null ? (
          <RecapBanner payload={recap.payload} now={Date.now()} onClose={recap.onDismiss} />
        ) : null}
        {/* ω99-248: #10 — the permission-blocked session's morning waiting
            line (the 等你决定 face; the re-floated ask's own card answers
            it). Priority over the reconciliation line: the user should ACT,
            not read the ledger, while the session waits on them. */
        /* ω99-242 — the recovered session's morning receipt — one line.
            弧 C：两行都是主会话的对账面（recoveryStatus 按 status.sessionId
            取行）——车道视图下不渲染，防串列。 */}
        {viewingMain && recoveryMorning !== null ? <MorningBanner line={recoveryMorning} /> : null}
        {viewingMain && recoveryMorning === null && recoveryLine !== null ? <RecoveryBanner line={recoveryLine} /> : null}
        {/* ω99-260: #10 — the boot pending-memory review card (chat-top banner
            family's LAST slot, below the 权限晨间行/恢复行 — those are the
            session's action/fact rows; the memory card is a deferrable
            trust face with its own 稍后). Coexists with ArmedBranchBanner
            (which renders ABOVE the composer — action state lives with the
            composer it steers; this is informational chat-top). Zero
            pending / old server / dismissed → zero render. SimpleMode/pet
            车道零渲染（它们不挂这份共享 chatColumn）。 */}
        {/* ω99-268: #5 — the store-signature change signal rides the App's
            live status down to the card (the panel takes it through the
            SettingsPage status prop's own channel) — the memory faces'
            refetch trigger, zero new App-level fetch logic. */}
        <MemoryReviewCard client={client} memorySignature={status?.memorySignature} />
        {/* ui-review-r1 I5: the empty hero rides the SHARED column so a
            fresh advanced/buddy session no longer shows a blank chat —
            exactly one render site per mode (SimpleMode keeps its own copy:
            it renders its own column and never mounts this one). */}
        {/* ω99-211: #3 — Buddy 进门欢迎态实证钉注（功能零改）：buddy 右栏挂的
            就是这份共享 chatColumn（下方 buddy-main 渲染处），进门时 boot 会话
            未物化（cli 半 sessionFresh 落盘延迟）⇒ history 空 ⇒ EmptyHero 在场；
            左侧无「启动即选中」逻辑——激活纯由 activeSessionId===r.id 驱动，boot
            id 无行可匹配 ⇒ 零高亮。receipts：
            packages/web/tests/omega99-211-buddy-entry.test.tsx。 */}
        {/* ω99-251 — 欢迎面点名行：boot 后（history 空=欢迎面在场）有会话
            在等你授权 → 点名一行，点名字走既有选中通路（onPickSession 的 busy
            拒答/占用提示原样）。无等待时 EmptyHero 字节同形（空数组不渲染点名
            行——组件内零噪音门）。 */}
        {isConversationEmpty(history) ? (
          <EmptyHero
            awaiting={awaitingNames}
            onOpenSession={onPickSession}
            /* 小精灵会话弧 — 空态双入口：有可续会话才接线（无历史/读取失败 →
               双 prop 缺席，hero 字节同形——251 点名行同款零噪音门）。 */
            {...(heroLatest !== null ? { onResumeLatest, onAskFromHistory } : {})}
          />
        ) : null}
        <HistoryList
          history={history}
          onAction={onErrorAction}
          onOpenFile={onHistoryOpenFile}
          /* ω99-258: the fork face — hover 岔开 (advanced/buddy 的共享列；SimpleMode
              与 pet 车道不挂此列，结构隔离零渲染) + 岔轮 ⑂ 徽标 (keys as a PROP —
              the memoized list re-renders on exactly the badge update). */
          onForkTurn={onForkTurn}
          forkBadgeKeys={forkBadgeKeys}
          /* 0.3.82: the shared EditCard's live in-flight flag — an
              IDENTITY-STABLE path set (content-equal frames keep the
              previous Set) so streaming frames re-render nothing unless the
              running-edit set itself changed. */
          runningEditPaths={runningEditPaths}
        />
        {viewingMain && status?.planBoard != null ? (
          <PlanReview plan={status.planBoard} busy={busy} onSubmit={onSubmit} />
        ) : null}
        {/* 弧 C：LiveArea 是主车道的 live 面（副车道 v1 无 live 数据——车道
            busy 由 composer 的 interrupt 位表达）。 */}
        {status !== null && viewingMain && busy && ask === null ? (
          <LiveArea live={status.live} queued={status.queued} onRecall={onRecallSteer} onDetachTool={onDetachTool} />
        ) : null}
      </div>
      <JumpBottomButton show={showJumpBottom} onJump={jumpToBottom} />
      {/* ω99-286（续，标记见上）— 断点续跑入口：恢复到「未完成」会话后，
          聊天区一条「继续跑上次没完成的任务」（armed-branch 同款行动横幅
          面——行动态与它引导的 composer 同住；旧 server 的行无 unfinished
          字段 → 永不 arm → 零渲染。SimpleMode/pet 车道不挂此列，零渲染）。 */}
      {/* ω99-289（续，标记见上）— 同一横幅槽一槽分语：errored 面（重启
          arm/live 错误卡同文案同发射口）「重试上次失败的任务」；unfinished
          面 286 文案逐字。旧 server 的行无两字段 → 两面都不渲染。 */}
      {/* 多 driver 并发（09-17 用户令）：断点续跑/失败重试横幅退役——任务在
          车道里继续跑，切回来看到的就是实时状态；真停了的会话用户自己发
          消息继续即可（横幅鸡肋且易误触）。 */}
      {/* ω99-258: the armed-branch banner — the branch point is picked, the
          original text is in the composer below; 取消 voids the arm. Action
          state belongs with the composer it steers (chat-top banners are
          informational; this one changes what the next send DOES). */}
      {armedEdit !== null ? <ArmedBranchBanner n={armedEdit.n} onCancel={cancelArmedEdit} /> : null}
      {/* workspace-ux B3: the agent-root confirm card — the permission-ask
          slot's form, ABOVE the composer and deliberately OUTSIDE its mount
          conditional: an ask / resume / clear takeover of the composer slot
          must never take the pending root decision with it. Dismissal is a
          decision (or a queued switch's settle), nothing else. */}
      {rootCard !== null ? (
        <AgentRootCard
          panelRoot={rootCard.panelRoot}
          agentRoot={rootCard.agentRoot}
          queued={rootCard.queued}
          onSwitch={onAgentRootSwitch}
          onKeep={onAgentRootKeep}
        />
      ) : null}
      {/* settings-trial r7: the permission ask renders INLINE — the
          agent-root card's slot sibling, ABOVE the composer (which already
          unmounts while the ask pends: the InputBox conditional below). No
          scrim, no root-level modal — the conversation stays visible and
          scrollable while the ask pends (this column is advanced + buddy's;
          SimpleMode keeps its own in-place approval card and never mounts
          this element). The answer lane is the old mount's, verbatim. */}
      {ask !== null ? (
        <PermissionModal
          ask={ask}
          onChoose={(answer) => {
            void client.answerPermission(answer.allow, answer.reason, answer.scope).catch(() => { /* parked ask resolved elsewhere */ });
          }}
        />
      ) : null}
      {/* 借鉴弧 α1（Codex 0.154 思想）— the parked ask_user clarification
          card: the permission card's slot sibling (a question, not a risk —
          accent-tinted, the AgentRootCard informational precedent). A chip
          pick or a typed answer resolves the tool and the run CONTINUES
          (nothing restarts); Esc/「让 agent 自行决定」dismissing resolves
          the tool as its decide-yourself error result. Permission asks
          outrank it when both somehow pend. */}
      {ask === null && pendingAsk !== null ? (
        <AskUserCards
          inline={true}
          question={pendingAsk.question}
          options={pendingAsk.options}
          onAnswer={(answer) => {
            void client.answerAskUser(answer).catch(() => { /* parked ask resolved elsewhere */ });
          }}
          onDismiss={() => {
            void client.answerAskUser().catch(() => { /* parked ask resolved elsewhere */ });
          }}
        />
      ) : null}
      {ask === null && resumeRows === null && !clearPending ? (
        // 工作区 chip（ω99-307 #457）：仅 buddy 模式挂 LEAD 槽。工作区切换
        // 此前只有两个家——极简 composer 的 WorkspaceChip 与高级模式 FileTree
        // 树顶切换器；buddy 丢 IDE 面板后三面皆无入口。高级面不传（树顶
        // 切换器是它唯一的家——ω99-298 单一交互家纪律），极简自有 SimpleMode
        // 的同款接线，byte 级不重不漏。onPick/onOpenOther 复用 App 级既有缝：
        // pick 只动文件面板根，AgentRootCard 在同一列内问 agent 是否跟随。
        <>
          {/* ω99-316 (/btw 侧问): the advanced column's side-QA lane —
              ABOVE the composer, OUTSIDE its mount semantics (an ask
              takeover keeps the bubbles; they are not composer state). */}
          <SideQaLane qas={sideQas} onPromote={promoteSideQa} />
          <InputBox
          busy={busy}
          mode={status?.mode ?? "workspace"}
          commands={commands}
          connected={connected}
          onSubmit={onSubmit}
          onInterrupt={onInterrupt}
          onShield={onShield}
          onCycleMode={onCycleMode}
          onDraftApplied={onDraftApplied}
          onMentionApplied={onMentionApplied}
          onBufferChange={onBufferChange}
          onImagesChange={onImagesChange}
          onImageSeedApplied={onImageSeedApplied}
          onFilesChange={onFilesChange}
          onFileSeedApplied={onFileSeedApplied}
          idlePlaceholder={composerTip}
          slashChip={true}
          // 输入框下方模型/强度 chips（spec 2026-08-28 §2.6）：模型走现有
          // ModelPicker 弹窗；强度提交 /effort 并刷新 settings 快照让 chip
          // 标签跟上（gateStatus 是 connect 时拉的，不刷会滞后一轮）。
          modelLabel={status?.model?.label ?? null}
          modelProvider={status?.model?.provider}
          modelChoices={status?.model?.choices}
          modelRecent={recentModels}
          onPickModel={pickModel}
          onPersistModelDefault={persistModelDefault}
          effort={gateStatus?.current?.effort ?? null}
          efforts={gateStatus != null ? [...(gateStatus.efforts ?? [])] : undefined}
          onPickEffort={(level) => {
            void client
              .submit(`/effort ${level}`)
              .then(() => {
                notify(`effort → ${level} — 下一轮生效`);
                refreshGateStatus();
              })
              .catch((e: unknown) => notify(`⚠️ /effort 失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-202: #8
          }}
          effortProviderLabel={providerCardLabel(gateStatus, status?.model?.provider)}
          onPersistEffortDefault={persistEffortProviderDefault}
          {...(uiMode === "buddy"
            ? {
                controlsLead: (
                  <WorkspaceChip
                    client={client}
                    root={panelRoot}
                  bootRoot={bootRoot !== "" ? bootRoot : undefined}
                    connected={connected}
                    onPick={onSwitchWorkspace}
                    onOpenOther={onOpenOtherWorkspace}
                    labelName={agentRoot !== "" ? pathName(agentRoot) : undefined}
                    labelPath={agentRoot !== "" ? agentRoot : undefined}
                  />
                ),
              }
            : {})}
          {...(editDraft !== null ? { draft: editDraft } : seedDraft !== null ? { draft: seedDraft } : {})}
          {...(imageSeed !== null ? { imageSeed } : {})}
          {...(fileSeed !== null ? { fileSeed } : {})}
          {...(mentionArm !== null ? { mention: mentionArm } : {})}
          onSideAsk={askSideQuestion}
        />
        </>
      ) : null}
    </>
  );

  return (
    <AttachmentSource.Provider value={attachmentSource}>
    <div className="app">
      {/* T9 墨线: the 34px topbar — the session's name + run badge live in
          the FLEXIBLE drag surface (the desktop shell's native traffic
          lights own the strip's left end; the browser keeps the tight
          inset), the IconTheme/IconSettings buttons at the right edge; the
          window mark still rides document.title and the 简洁/高级 switch
          lives only on the settings page (偏好). M75-ux1 §1: the strip is
          the window drag region — data-tauri-drag-region on the strip AND
          the spacer (Tauri v2 checks the mousedown TARGET, and the spacer IS
          the empty space; T9's name/badge spans carry it too — they ARE the
          surface now); the buttons stay SIBLINGS without the attribute, so
          they never drag. The css -webkit-app-region pair stays as the
          non-Tauri fallback. */}
      <div
        className="topbar"
        data-tauri-drag-region=""
        onMouseDown={(e) => {
          // M76-ux fix: data-tauri-drag-region alone may not fire on macOS
          // Overlay — this JS fallback calls the Tauri API directly. Only
          // when the TARGET is the drag surface (not a button child).
          // workspace-ux C1: detail===2 (the second click of a double-click)
          // toggles maximize IN THE SAME handler, not a DOM dblclick handler
          // — the drag session the first click starts can swallow the
          // dblclick event on macOS Overlay (Tauri core.js implements zoom
          // the same way, via mousedown detail).
          const t = e.target as HTMLElement;
          if (t.closest("button") === null) {
            if (e.detail === 2) {
              void tauriToggleMaximize();
              return;
            }
            // workspace-ux A2: the old __TAURI__.window.getCurrentWindow() read was dead code (spec A) — the plugin rides tauriStartDrag now.
            void tauriStartDrag();
          }
        }}
      >
        <span className="sp" data-tauri-drag-region="">
          <span className="tb-name" data-tauri-drag-region="" title={sessionTitle}>
            {sessionTitle}
          </span>
          {/* ui-sweep A (顶栏经济, mockup-space-v3): the run badge is
              advanced-speak telemetry (distinct-tools count + ctx watermark)
              — the 简洁 shell's window carries none of it; the context ring
              already lives in its composer. Advanced/buddy (power surfaces)
              keep the badge. */}
          {uiMode !== "simple" && tbRun !== null ? (
            <span className="tb-run" data-tauri-drag-region="">
              {tbRun}
            </span>
          ) : null}
        </span>
        {/* M75-ux3 §10: the + new-chat — confirm first (「清空当前对话？」),
            确认 rides performClear (C1); an icobtn sibling of the theme/settings pair so the
            drag region keeps its no-drag opt-outs. ui-review-r2 P5: the
            IconPlus glyph replaces the bare "+" text.
            ui-sweep A (顶栏经济): in the BUDDY shell these two leave the
            topbar — the session sidebar owns 新对话 and the session list
            outright, so the topbar copies were pure duplicates. The simple
            shell keeps both: it has no sidebar, so the topbar is their only
            home (必要钮); advanced is unchanged. */}
        {uiMode !== "buddy" ? (
          <button
            type="button"
            className="icobtn new-chat"
            aria-label="新对话"
            title="新对话(清空当前会话)"
            onClick={() => {
              // r2-review MINOR: the same busy refusal as the typed /clear —
              // the confirm's performClear now really wipes the view, so a
              // mid-run click must not sail through ungated.
              if (busy) {
                notify("⚠️ 运行中无法 /clear（任务进行中）");
                return;
              }
              setNewChatPending(true);
            }}
          >
            <IconPlus />
          </button>
        ) : null}
        {/* ω99-216: the 「改动 N 文件」chip — the changes panel's entry, in
            the 📋 neighborhood. Renders ONLY when the session's receipts
            carry changes (N>0): a zero-changes history (or a pre-ω99-216
            server's receipts without the field) renders no chip at all —
            the topbar is byte-identical for them. All-mode: 改动可见性 is
            session content, not advanced-speak telemetry (the run badge's
            ui-sweep A cut does not apply). */}
        {changesAgg.fileCount > 0 ? (
          <button
            type="button"
            className="tb-changes"
            aria-label="查看会话改动"
            title="本会话改了哪些文件"
            onClick={() => setChangesOpen(true)}
          >
            {`改动 ${changesAgg.fileCount} 文件`}
          </button>
        ) : null}
        {/* (ω99-219 #3 续) the 「电脑操作 N 步」chip — the computer-actions
            panel's entry, the 改动 chip's 邻居 (mechanically the 216 chip:
            same .tb-changes styling + .tb-computer identity class for tests).
            Renders ONLY when computer-tool entries exist (N>0): 读写会话零
            chip、顶栏字节不变。All-mode（同 216）：托付出去的操作可见性是
            会话内容，不是 advanced 遥测。数据跨重启持久（消息面 tool 条目
            resume 重建）。 */}
        {computerAgg.totalSteps > 0 ? (
          <button
            type="button"
            className="tb-changes tb-computer"
            aria-label="查看电脑操作"
            title="本会话在电脑上做了什么"
            onClick={() => setComputerOpen(true)}
          >
            {`电脑操作 ${computerAgg.totalSteps} 步`}
          </button>
        ) : null}
        {/* ω99-317: the 「定时 N」chip — the schedules panel's entry, the 改
            动/电脑 chips' 邻居（mechanically the same family: .tb-changes 视觉
            + .tb-sched 身份类）。Renders ONLY when durable schedules exist
            (N>0)：零任务/读败/旧 server → 零 chip，顶栏字节不变。All-mode
            （同 216）：定时任务的健康可见性不是 advanced 遥测——「到点自己
            醒」的信任就建立在随时能看见它在干嘛上。 */}
        {schedRows !== null && schedRows.length > 0 ? (
          <button
            type="button"
            className="tb-changes tb-sched"
            aria-label="查看定时任务"
            title="定时任务与提醒"
            onClick={() => setSchedulesOpen(true)}
          >
            {`定时 ${schedRows.length}`}
          </button>
        ) : null}
        {/* M76-ux2 §3: the 📋 session picker — the /resume command's
            visualized entry, between the + new-chat and the theme/settings pair; the
            same busy guard as the typed /resume (a mid-run switch would
            branch a live turn). */}
        {uiMode !== "buddy" ? (
          <button
            type="button"
            className="icobtn sessions"
            aria-label="会话列表"
            title="切换会话"
            onClick={() => {
              // 弧 C：车道化 server 上开列表不再被 busy 拦（拣选取走车道路
              // 由——切会话是视图动作）；老 server 字节不变。
              if (busy && !view.capable) {
                notify("⚠️ 运行中无法 切换会话（任务进行中）");
                return;
              }
              setSessionPickerOpen(true);
            }}
          >
            <IconSessions />
          </button>
        ) : null}
        {/* 2026-08-26 §3.3: 审查专注 — advanced-only transient geometry (the
            keyboard twin is Ctrl+Shift+\). aria-pressed carries the on/off
            state; the snapshot-restore semantics live in toggleReviewFocus. */}
        {uiMode === "advanced" ? (
          <button
            type="button"
            className="icobtn"
            aria-pressed={reviewFocus}
            aria-label="审查专注"
            title={reviewFocus ? "退出审查专注 (Ctrl+Shift+\\)" : "审查专注 (Ctrl+Shift+\\)"}
            onClick={toggleReviewFocus}
          >
            <IconPanelLeft />
          </button>
        ) : null}
        <button type="button" className="icobtn" aria-label="切换主题" title="切换主题(浅色/暗色)" onClick={onToggleTheme}>
          <IconTheme />
        </button>
        {/* 139：探针仪表盘（默认可观测面）——settings 同款整页覆盖。 */}
        <button type="button" className="icobtn" aria-label="监控" title="监控（探针仪表盘）" onClick={() => setDashboardOpen(true)}>
          <IconChart />
        </button>
        <button type="button" className="icobtn" aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}>
          <IconSettings />
        </button>
      </div>
      {/* M63 §C: the browse-only banner — the wizard was skipped (or its key
       *  removed) while the matrix stays not-ready. 去配置 re-opens the
       *  wizard manually (the version gate does not apply to a user click). */}
      {wizardGate !== "show" && gateStatus !== null && !matrixReady(gateStatus.providers) ? (
        <div className="no-key-banner" role="status">
          {"未配置任何模型 Key —— 当前为只读浏览模式"}
          <button type="button" className="wudao action" onClick={() => setWizardGate("show")}>
            去配置
          </button>
        </div>
      ) : null}
      {snap.connection === "reconnecting" ? (
        <div className="banner quiet" role="status">
          {/* ui-review-r4 P1: the reconnect banner joins the gave-up banner's
              Chinese (the two banners are one flow — an English/Chinese pair
              read as two different systems). `close ${code}` stays a status
              token. ui-parity B: the class gains .quiet — the transient
              notice demotes to the secondary mono strip (the amber band stays
              the gave-up banner's, which carries the manual action). */}
          连接断开{snap.lastClose !== null ? `(close ${snap.lastClose.code})` : ""} — 正在重连
          {snap.reconnectAttempt > 1 ? `(第 ${snap.reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS} 次)` : ""}… 重连后自动回放历史
        </div>
      ) : null}
      {snap.connection === "gave-up" ? (
        <div className="banner" role="alert">
          {/* ω99-232: #1 — gave-up 终态的形态诚实处方（超越点，09-09 真报障
              收口）：旧文案教「重启 `wudao ui`」——CLI 命令，桌面形态（主发行
              道）用户没有它；行业桌面连接横幅只给形态内可行动出路。新句 =
              (a) 点名重连已尽力（次数与 MAX_RECONNECT_ATTEMPTS 同源插值，不
              硬编码）；(b) 双形态出路——桌面窗口重启应用 / 浏览器标签从桌面
              应用重开会话，并点名「旧页面的地址可能已失效」（死端口事实：
              刷新在死 URL 上永远无效，正是报障根因句）；(c) 手动重连按钮
              保留（CLI 用户重启服务后点它即回，client.reconnect() 复位梯子
              行为零动）。不自动检测形态（一条文案双形态并列，§五诚实边界）。 */}
          {`连接已断开 — 已连续重连 ${MAX_RECONNECT_ATTEMPTS} 次未成功。在 wudao 桌面应用窗口里遇到时，重启应用即可；在浏览器标签里，请从 wudao 桌面应用重新打开会话（这个旧页面的地址可能已失效）。`}
          <button type="button" className="wudao action" onClick={() => client.reconnect()}>
            重连
          </button>
        </div>
      ) : null}
      {/* 139 — 探针仪表盘：整页覆盖（settings 同位；关页即停探针流）。 */}
      {dashboardOpen ? (
        <Dashboard client={client} status={status} connected={connected} onClose={() => setDashboardOpen(false)} />
      ) : null}
      {settingsOpen ? (
        <SettingsPage
          client={client}
          status={status}
          // final-review F1: the same ask state that mounts the inline
          // .permission-card — the settings page replaces that column, so a
          // parked ask needs the page's own persistent banner naming it.
          pendingAsk={ask !== null}
          onClose={() => {
            setSettingsOpen(false);
            // The settings page is the other surface where a key can land —
            // refresh the banner's matrix when it closes.
            refreshGateStatus();
          }}
          // ui-review-r2 I8: the 偏好 mode chips flip the LIVE shell the
          // moment the write lands (the old chips only persisted — the
          // shell sat stale until a reload). The full reload polish (panels
          // already mounted per-mode) still says 重载后完全生效.
          onModeApplied={(mode) => {
            setUiMode(mode);
            notify(`已切换到${mode === "simple" ? "简洁模式" : mode === "buddy" ? "Buddy 模式" : "高级模式"} — 重载后完全生效`);
          }}
          // ui-review-r4 I2: the local pick arms the stale-reply guard.
          onAccentPicked={() => {
            accentTouched.current = true;
          }}
          // ω99-234: #2 — the re-homed 语言 chip's value feed（迁移的挂载位
          // 搬家：composer 两挂载点停传三 props，设置页独苗收
          // gateStatus.language；旧服务端 null → 段隐藏）。The WRITE lane
          // lives inside the 偏好 tab (its settingsSet rides the page's
          // toasts — the App notify renders in the chat column this page
          // replaces, the receipt would be invisible).
          language={gateStatus?.language ?? null}
        />
      ) : uiMode === "simple" ? (
        // M63 §D: the novice projection — same snapshot, same submit path,
        // single-column layout with its own widgets (SimpleMode owns the
        // composition; the permission ask is answered in-place there, not by
        // the modal).
        // single-column layout with its own widgets (SimpleMode owns the
        <SimpleMode
          status={simpleStatus}
          history={history}
          connected={connected}
          commands={commands}
          onSubmit={onSubmit}
          onSideAsk={askSideQuestion}
          sideQas={sideQas}
          onPromoteSideQa={promoteSideQa}
          onInterrupt={onInterrupt}
          onCycleMode={onCycleMode}
          onAnswerPermission={onAnswerPermission}
          onRecallSteer={onRecallSteer}
          onDetachTool={onDetachTool}
          pendingAsk={pendingAsk}
          onAnswerAskUser={onAnswerAskUser}
          onShield={onShield}
          notify={notify}
          parked={parked}
          onPark={onPark}
          onDropParked={onDropParked}
          onDraftApplied={onDraftApplied}
          onBufferChange={onBufferChange}
          onImagesChange={onImagesChange}
          onImageSeedApplied={onImageSeedApplied}
          onFilesChange={onFilesChange}
          onFileSeedApplied={onFileSeedApplied}
          // 输入框下方模型/强度 chips（spec 2026-08-28 §2.6）：简洁线同款
          // 五连 prop（SimpleMode→SimpleComposer→InputBox 穿层）。
          modelLabel={status?.model?.label ?? null}
          modelProvider={status?.model?.provider}
          modelChoices={status?.model?.choices}
          modelRecent={recentModels}
          onPickModel={pickModel}
          onPersistModelDefault={persistModelDefault}
          effort={gateStatus?.current?.effort ?? null}
          efforts={gateStatus != null ? [...(gateStatus.efforts ?? [])] : undefined}
          onPickEffort={(level) => {
            void client
              .submit(`/effort ${level}`)
              .then(() => {
                notify(`effort → ${level} — 下一轮生效`);
                refreshGateStatus();
              })
              .catch((e: unknown) => notify(`⚠️ /effort 失败：${e instanceof Error ? e.message : String(e)}`)); // ω99-202: #9
          }}
          effortProviderLabel={providerCardLabel(gateStatus, status?.model?.provider)}
          onPersistEffortDefault={persistEffortProviderDefault}
          workspaceRoot={panelRoot}
          bootRoot={bootRoot !== "" ? bootRoot : undefined}
          onSwitchWorkspace={switchPanelRoot}
          onOpenOtherWorkspace={onOpenOtherWorkspace}
          rootCard={rootCard}
          onAgentRootSwitch={onAgentRootSwitch}
          onAgentRootKeep={onAgentRootKeep}
          fileOpsClient={client}
          {...(editDraft !== null ? { draft: editDraft } : seedDraft !== null ? { draft: seedDraft } : {})}
          {...(imageSeed !== null ? { imageSeed } : {})}
          {...(fileSeed !== null ? { fileSeed } : {})}
        />
      ) : uiMode === "buddy" ? (
        // M78-buddy §1 (spec §1): the Buddy 模式 two-panel grid — 260px
        // session sidebar / 1fr conversation, no IDE panels. The collapse
        // toggle rides the grid like the IDE's (◂ collapses to 0px, ▸ brings
        // it back; <700px starts collapsed). The right cell is the SAME
        // chat column the advanced shell renders (chatColumn above); the
        // StatusBar below stays (buddy keeps it — spec §3, unlike simple).
        <div
          className="buddy"
          style={{ "--buddy-w": buddyCollapsed ? "0px" : `${BUDDY_SIDE_W}px` } as React.CSSProperties}
        >
          <div className="buddy-cell buddy-left">
            {buddyCollapsed ? null : (
              <SessionSidebar
                client={client}
                activeSessionId={view.sessionId}
                onResume={onPickSession}
                onNewChat={onNewChat}
                /* M85 §3：onOpenSettings 随 sb-f 底部行一并退役——右上已有
                   配置入口（用户令：这行不需要）。 */
                /* T8 墨线 §3: the search row rides the topbar 📋 button's EXACT
                   lane (data flow frozen). 弧 C：车道化 server 上开列表不再被
                   busy 拦（拣选取走车道路由）；老 server 字节不变。 */
                onOpenSearch={() => {
                  if (busy && !view.capable) {
                    notify("⚠️ 运行中无法 切换会话（任务进行中）");
                    return;
                  }
                  setSessionPickerOpen(true);
                }}
                /* ω99-150: 行内重命名两参 — the ✎ 的 /rename 车道 + 重取 bump。 */
                onRenameSession={onRenameSession}
                sessionsEpoch={sessionsEpoch}
                /* ω99-251: 等待授权会话 id 集（recoveryStatus 轮询派生）——行挂
                   「等你授权」徽标，点击=既有 resume 通路。 */
                awaitingIds={awaitingSet}
                /* 弧 C — 「运行中」徽标集（主车道 busy 会话 + busy 副车道的会
                   话）；undefined=老 server → 面隐藏，字节不变。 */
                busySessionIds={busySessionIds}
                /* 小精灵会话弧 — 行内「追问」：fork 该会话进副本继续问（原会话
                   不动），与行点击的「恢复」并存。 */
                onFollowUp={onFollowUp}
                /* ω99-147: the five model props are gone with the footer's
                   ModelSelector — 模型切换归输入框下的 chips（双入口去重）. */
              />
            )}
          </div>
          <div className="buddy-cell buddy-main">{chatColumn}</div>
          <button
            type="button"
            className="ide-toggle buddy-toggle"
            aria-label={buddyCollapsed ? "展开会话列表" : "折叠会话列表"}
            title={buddyCollapsed ? "展开会话列表" : "折叠会话列表"}
            onClick={() => setBuddyCollapsed((v) => !v)}
          >
            {buddyCollapsed ? "▸" : "◂"}
          </button>
        </div>
      ) : (
        <>
          {/* M74-ide §3: the advanced shell is a Cursor-style three-panel grid
              (spec §1) — left file tree / center read-only viewer / right the
              EXISTING chat + composer flow (composition untouched, just
              wrapped in the third cell). The side widths ride the
              --tree-w/--chat-w vars (220px/360px — the 2026-08-26 §3.3
              rebalance; 审查专注 overrides transiently below); the boundary
              controls position off the SAME vars so one width drives
              everything: a 16px collapse toggle per side (▸/◂, sets the var
              to 0px and back, remembering the pre-collapse width) and a 4px
              col-resize handle per inner edge (absent while collapsed). */}
          <div
            className="ide"
            style={
              {
                "--tree-w": leftCollapsed ? "0px" : `${treeW}px`,
                "--mid-w": centerCollapsed ? "0px" : "1fr",
                "--chat-w": rightCollapsed ? "0px" : `${chatW}px`,
              } as React.CSSProperties
            }
          >
            <div className="ide-cell ide-left">
              {/* The data panels wait for the shell-preference round trip
                  (settingsStatus resolves the 简洁/高级 pick — the same gate
                  the wizard uses): a 简洁 user's connect must not mount the
                  tree and fire file ops for a shell that unmounts a tick
                  later (spec §7 — the simple shell renders none of this,
                  ops included). A server without the op rejects it, which
                  also resolves the gate; the viewer is op-free until a
                  selection exists, so only the tree needs the gate. */}
              {wizardGate !== "checking" ? (
                <FileTree
                  key={panelRoot}
                  client={client}
                  workspaceRoot={panelRoot}
                  bootRoot={bootRoot !== "" ? bootRoot : undefined}
                  selectedPath={activeTab?.path ?? null}
                  onSelect={onTreeSelect}
                  onAtMention={onAtMention}
                  refreshKey={treeRefresh}
                  onSwitchWorkspace={onSwitchWorkspace}
                  onOpenOtherWorkspace={onOpenOtherWorkspace}
                  onPathsChange={onKnownPaths}
                  modifiedPaths={agentModifiedRef.current}
                  modifiedKey={agentModifiedKey}
                  onManualRefresh={onClearAgentModified}
                />
              ) : null}
            </div>
            <div className="ide-cell ide-center">
              {/* M75-ux2 §3: the 32px tab strip — filename + × close per tab,
                  an accent underline on the active one, the [+] placeholder
                  when empty, and the ◂ collapse button at the right end
                  (hidden once the column is 0px; the absolute ▸ toggle on
                  the grid takes over so the collapse never strands). */}
              <div className="tabbar" role="tablist">
                {tabs.length === 0 ? (
                  <span className="tab-empty" title="从左侧选择文件打开标签">
                    +
                  </span>
                ) : (
                  tabs.map((t, i) => (
                    <div
                      key={t.path}
                      className={`tab${i === activeTabIndex ? " active" : ""}`}
                      data-path={t.path}
                      role="tab"
                      aria-selected={i === activeTabIndex}
                      title={t.path}
                      tabIndex={0}
                      // ui-review-r1 I3: the tab is a plain div with onClick —
                      // keyboard users could not reach it. Enter/Space (and
                      // Space's scroll default suppressed) ride the same
                      // activate path the click does.
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setActiveTabIndex(i);
                        }
                      }}
                      onClick={() => setActiveTabIndex(i)}
                    >
                      {t.isDir ? <IconFolder size={12} /> : <IconFileText size={12} />}
                      <span className="tname">{t.name}</span>
                      <button
                        type="button"
                        className="tclose"
                        aria-label={`关闭 ${t.name}`}
                        title={`关闭 ${t.name}`}
                        onClick={(ev) => {
                          ev.stopPropagation(); // close, not activate
                          closeTab(i);
                        }}
                      >
                        <IconClose size={12} />
                      </button>
                    </div>
                  ))
                )}
                {centerCollapsed ? null : (
                  <button
                    type="button"
                    className="tabbar-collapse"
                    aria-label="折叠中栏"
                    title="折叠中栏"
                    onClick={() => setCenterCollapsed(true)}
                  >
                    ◂
                  </button>
                )}
              </div>
              <FileViewer
                client={client}
                path={activeTab?.path ?? null}
                isDir={activeTab?.isDir ?? false}
                onOpenPath={openTab} /* M75-ux2 §8: breadcrumb dir clicks open dir tabs */
                onReadFailed={onTabReadFailed} /* ui-review-r3 P2: a stale persisted tab drops on its failed read */
                refreshEpoch={view.historyEpoch} /* ui-review-r4 I3: a reset replay refetches the open tab（弧 C：被看车道的重放） */
                onClose={closeActiveTab} /* 墨线 T11: the head's × rides the SAME closeTab the tabbar's × does */
                onPrefill={onPrefill} /* ω99-148: the viewer's「改这段」chip rides the /edit draft seam (M63 §D) */
              />
            </div>
            <div className="ide-cell ide-right">
              {/* M78-buddy §3: the conversation column lives once, above —
                  the Buddy shell renders the same element. */}
              {chatColumn}
            </div>
            <button
              type="button"
              className="ide-toggle"
              data-side="left"
              aria-label={leftCollapsed ? "展开文件树" : "折叠文件树"}
              title={leftCollapsed ? "展开文件树" : "折叠文件树"}
              onClick={() => setLeftCollapsed((v) => !v)}
            >
              {leftCollapsed ? "▸" : "◂"}
            </button>
            <button
              type="button"
              className="ide-toggle"
              data-side="right"
              aria-label={rightCollapsed ? "展开会话栏" : "折叠会话栏"}
              title={rightCollapsed ? "展开会话栏" : "折叠会话栏"}
              onClick={() => setRightCollapsed((v) => !v)}
            >
              {rightCollapsed ? "◂" : "▸"}
            </button>
            {/* M75-ux2 §3: the collapsed center's way back — the in-strip ◂
                went with the 0px column, so the ▸ toggle rides the grid. */}
            {centerCollapsed ? (
              <button
                type="button"
                className="ide-toggle"
                data-side="center"
                aria-label="展开中栏"
                title="展开中栏"
                onClick={() => setCenterCollapsed(false)}
              >
                ▸
              </button>
            ) : null}
            {leftCollapsed ? null : (
              <div
                className="ide-drag"
                data-side="left"
                role="separator"
                aria-orientation="vertical"
                aria-label="文件树宽度"
                title="拖动调整宽度 · 双击重置"
                // ui-review-r3 I3: the handle is a REAL separator — focusable
                // (the stylesheet's :focus-visible ring finally reaches it),
                // arrow/Home/End resize through the drag's own clamp, and the
                // value trio exposes the width to assistive tech.
                tabIndex={0}
                aria-valuemin={PANEL_W_MIN}
                aria-valuemax={panelWMax()}
                aria-valuenow={treeW}
                onKeyDown={nudgePanelWidth("left")}
                onMouseDown={beginPanelDrag("left")}
                onDoubleClick={resetPanelWidth("left")}
              />
            )}
            {rightCollapsed ? null : (
              <div
                className="ide-drag"
                data-side="right"
                role="separator"
                aria-orientation="vertical"
                aria-label="会话栏宽度"
                title="拖动调整宽度 · 双击重置"
                tabIndex={0}
                aria-valuemin={PANEL_W_MIN}
                aria-valuemax={panelWMax()}
                aria-valuenow={chatW}
                onKeyDown={nudgePanelWidth("right")}
                onMouseDown={beginPanelDrag("right")}
                onDoubleClick={resetPanelWidth("right")}
              />
            )}
          </div>
        </>
      )}
      {/* M65-space §2: the statusline is ADVANCED-only — the simple shell's
          window ends at the composer wrap (12px bottom inset); the driver
          state it carried stays reachable through the composer's context
          ring. M78-buddy §3: the Buddy shell KEEPS it (spec §3 — the
          two-panel layout is a power surface, not the novice projection). */}
      {uiMode !== "simple" ? (
        <StatusBar
          status={status}
          ctxInfo={() => client.ctxInfo()}
          stale={!connected}
          sessionName={activeName ?? undefined} /* ω99-156: the named-session head */
          /* ω99-224: #2 — the buddy variant's props: the view-state flag +
             the workspace trust anchor. workspaceName/Path read the AGENT
             root's B3 mirror (never the file panel's view root — a pick can
             move the panel independently of where the agent works); the
             basename is the glance, the full path is the hover. Advanced
             (buddy=false) renders byte-identically — the props ride unused. */
          buddy={uiMode === "buddy"}
          workspaceName={agentRoot !== "" ? pathName(agentRoot) : undefined}
          workspacePath={agentRoot !== "" ? agentRoot : undefined}
        />
      ) : null}
      {/* M75-ux3 §6: the Ctrl+P palette — above every other layer except
       *  the wizard; shell-agnostic (a 简洁 user simply has an empty index
       *  until the round's later tasks bring the panels there). */}
      {searchOpen ? (
        <FileSearch getAllKnownPaths={getAllKnownPaths} onOpenPath={onOpenPath} onClose={() => setSearchOpen(false)} />
      ) : null}
      {/* M76-ux2 §3: the 📋 picker — the same layer as the Ctrl+P palette;
       *  a pick closes and rides the /resume picker's EXISTING onPickSession
       *  (client.resume + the not-found notice path). */}
      {sessionPickerOpen ? (
        <SessionPicker
          rows={sessionRows}
          onPick={(id) => {
            setSessionPickerOpen(false);
            onPickSession(id);
          }}
          onClose={() => setSessionPickerOpen(false)}
          onSearch={(q) => client.sessionSearch(q)}
          activeId={view.sessionId}
          onDelete={onDeleteSession}
          trashRows={trashRows}
          onRestore={onRestoreSession}
        />
      ) : null}
      {/* ω99-216: the changes panel — the chip's overlay（Esc/关闭收起；
       *  agg 是活引用——面板开着时新一轮收据落地下次渲染即进面板）。
       *  ω99-314: onRevert——面板内确认后发 fileRevert op，回执（成功/拒答
       *  皆然）走 notify 收据面；刷新随 history 通道自然过境（agg 是活引
       *  用）。 */}
      {changesOpen ? (
        <ChangesPanel
          agg={changesAgg}
          onClose={() => setChangesOpen(false)}
          onRevert={(path, sha) => {
            void client.fileRevert(path, sha).then(
              (r) => notify(r.message),
              (err) => notify(`恢复没成功：${err instanceof Error ? err.message : String(err)}`),
            );
          }}
        />
      ) : null}
      {/* (ω99-219 #3 续) the computer-actions panel — the chip's overlay
       *  （Esc/关闭收起；agg 是活引用——面板开着时新一步落下即进面板）。 */}
      {computerOpen ? <ComputerActionsPanel agg={computerAgg} onClose={() => setComputerOpen(false)} /> : null}
      {/* ω99-317: the schedules panel — the chip's overlay（Esc/关闭收起）。
       *  行模型经 schedulesPanelModel 聚合（状态徽标/下次/上次/会话名 join）；
       *  三动作 op 与回执走 App 缝（onToggle/onRemove/onRun——回执 notify +
       *  纪元重读，面板开着时行内状态即时翻新）。 */}
      {schedulesOpen && schedRows !== null ? (
        <SchedulesPanel
          rows={schedulesPanelModel(schedRows, schedSessions)}
          onClose={() => setSchedulesOpen(false)}
          onToggle={onSchedToggle}
          onRemove={onSchedRemove}
          onRun={onSchedRun}
        />
      ) : null}
      {/* M65-space: the mode toggle lives in the settings page (偏好段).
          ui-review-r2 I8: the live apply point EXISTS now — SettingsPage's
          onModeApplied flips uiMode on the write's success (the theme
          toggle's optimistic pattern, minus the optimism: the flip waits
          for the persisted reply). */}
      {resumeRows !== null ? (
        /* 小精灵会话弧 — 同一挂载点两套意图：resume（/resume 命令）走既有
           onPickSession；followup（空态「从历史会话提问」）走 onFollowUp 的
           fork 流（选中的会话开副本继续问）。取消复位意图（下次 /resume 面
           恒为恢复语）。 */
        <ResumePicker
          rows={resumeRows}
          intent={resumeIntent}
          onPick={resumeIntent === "followup" ? onFollowUp : onPickSession}
          onCancel={() => {
            setResumeRows(null);
            setResumeIntent("resume");
          }}
        />
      ) : null}
      {/* ui-review-r2 C1: both confirms ride the SAME performClear — the
          typed /clear and the + button are one path now. */}
      {clearPending ? (
        <ClearConfirm
          onChoose={(yes) => {
            setClearPending(false);
            if (yes) performClear();
            else notify("(已取消清空)");
          }}
        />
      ) : null}
      {/* M75-ux3 §10: the + button's confirm — a 确认 rides performClear
       *  (C1: the unified /clear path); failures surface as a notice, not a
       *  silent drop. */}
      {newChatPending ? (
        <NewChatConfirm
          onChoose={(yes) => {
            setNewChatPending(false);
            if (yes) performClear();
          }}
        />
      ) : null}
      {/* ui-review-r2 P3: the ONE polite live region — the latest notice +
          the turn phase, so streaming phase changes and notify() receipts
          reach screen readers (visually hidden; the visual surfaces stay
          where they are). */}
      <div className="sr-only" aria-live="polite" role="status">
        {`${busy ? "生成中…" : "空闲"}${
          localNotes.length > 0 ? ` · ${(localNotes[localNotes.length - 1] as LocalNote).text}` : ""
        }`}
      </div>
      {/* M63 §C: the first-run wizard — a full-viewport takeover above every
       *  other layer; mounted only when the gate said not-ready + unseen. */}
      {wizardGate === "show" && gateStatus !== null ? (
        <Wizard
          client={client}
          status={status}
          settings={gateStatus}
          onDone={() => {
            setWizardGate("done");
            refreshGateStatus();
          }}
        />
      ) : null}
    </div>
    </AttachmentSource.Provider>
  );
}

/** M75-ux3 §10 — the new-chat confirm: the ClearConfirm idiom (single-shot,
 *  Esc cancels) with the round's 确认/取消 wording — the caller owns what a
 *  确认 actually does (ui-review-r2 C1: both the + button and the typed
 *  /clear now ride App's performClear — one path).
 *  ui-review-r1 I7: Enter takes the SAFE path, like ClearConfirm — the old
 *  确认-autofocus made a bare Enter immediately destroy the conversation
 *  (and no autoFocus at all now: the modal's own focus effect wins anyway,
 *  so the dialog keeps focus and the modal-level keys own the semantics). */
