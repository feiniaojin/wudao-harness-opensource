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

// —— App 模块级常量/小函数族外提（ω99 拆分运动：纯移动段外提；原文件 re-export 门面）——
export const FALLBACK_FRONTEND_NOTE =
  "(该命令由插件/扩展实现 —— WS 协议 v1 无法在此展开；请使用 TUI 或 /help)";

/** M74-ide §3: the tree-top's workspace label placeholder. workspace-ux B1:
 *  the connect-time agentRootStatus resolves the real panel root (basename
 *  label, full-path tooltip); until that reply — or forever on an old server
 *  without the op — the generic 工作区 stands in. */
export const WORKSPACE_LABEL = "工作区";

/** M74-ide §3 (spec §1): a narrow window starts with the left panel
 *  auto-collapsed. Module-level so the useState initializer and the resize
 *  listener share one threshold (<900px). */
export const isNarrowWindow = (): boolean => typeof window !== "undefined" && window.innerWidth < 900;

// R6 quickwin (the upstream tips pattern) — the advanced/Buddy composer's idle
// placeholder rotates ONCE PER SESSION through short feature hints (reusing
// existing feature copy). A module-level cursor advanced once per App MOUNT
// picks the tip: one page load = one stable placeholder (a per-INPUTBOX
// counter would rotate mid-session — the composer unmounts for every
// ask/modal), and the pick happens in the useState initializer so re-renders
// never re-roll it. The simple composer's novice wording is deliberate and
// stays fixed.
export const COMPOSER_TIPS: readonly string[] = [
  "描述任务，或 /help 查看命令",
  "@ 可引用文件",
  "拖入图片直接发送",
  "shift+tab 切换权限档",
];
export let composerTipCursor = 0;

/** 0.3.13: ONE receipt voice for BOTH mode paths (shield pick + shift+tab
 *  cycle), in the the upstream formatvocabulary — ask/accept/auto/plan are the words, the
 *  paren keeps the one-line Chinese semantics (accept is the default and
 *  names the sensitive classes that still ask: 命令/网络/MCP; 0.3.14 adds
 *  plan's read-only 探查 wording). */
export function modeReceipt(mode: ShieldMode): string {
  return mode === "ask"
    ? "ask(每个工具执行前都会确认)"
    : mode === "workspace"
      ? "accept(默认:工作区内读写与只读命令放行,其余命令/网络/MCP 仍确认)"
      : mode === "auto"
        ? "auto(全自动:全部放行,不再询问)"
        : "plan(只读探查:只放行读取与只读命令;完成方案后切回 accept/auto 执行)";
}

/** The session's tip — one advance per App mount, cycling the list. */
export function nextComposerTip(): string {
  const tip = COMPOSER_TIPS[composerTipCursor % COMPOSER_TIPS.length] ?? COMPOSER_TIPS[0]!;
  composerTipCursor += 1;
  return tip;
}

/** M78-buddy §1 (spec §1): the Buddy shell's own narrow threshold (<700px)
 *  starts the session sidebar auto-collapsed — the two-panel layout keeps
 *  the conversation the majority share at phone widths. */
export const isBuddyNarrowWindow = (): boolean => typeof window !== "undefined" && window.innerWidth < 700;

/** M78-buddy §1 (spec §1): the Buddy sidebar's fixed width (no drag handle —
 *  a list of one-line rows has no reflow to protect). */
export const BUDDY_SIDE_W = 260;

/** M74-ide §3 (spec §1): the drag clamp — never under 180px, never past 40%
 *  of the window (the center panel keeps the majority share at every size).
 *  ui-review-r3 I3: the floor is a named constant — the drag, the keyboard
 *  twin, and the separator's aria-valuemin all say the same number. */
export const PANEL_W_MIN = 180;
export const panelWMax = (): number => Math.floor(window.innerWidth * 0.4);

export function clampPanelWidth(w: number): number {
  return Math.min(Math.max(w, PANEL_W_MIN), panelWMax());
}

// ui-review-r5 I3: the scroll-to-bottom seam moved to use-jump-bottom.tsx so
// every chat shell (advanced, Buddy, 简洁) rides one rule; prefersReducedMotion
// moved with it (the seam's one programmatic smooth scroll) — re-exported
// here for import stability.
export { prefersReducedMotion } from "../use-jump-bottom.js";
import { JumpBottomButton, useJumpBottom } from "../use-jump-bottom.js";
import { usePointerInputMode } from "../use-pointer-input-mode.js";

/** M74-ide §3 (spec §1) → 2026-08-26 §3.3 rebalance: the side panels'
 *  default widths — tree 240→220, chat 400→360, buying the read-only viewer
 *  the 1fr remainder (高级模式预览为主). The useState initializers and the
 *  M76-ux2 §5 double-click reset share one number each (the center column
 *  has no default: it is the 1fr remainder, never reset). */
export const TREE_W_DEFAULT = 220;
export const CHAT_W_DEFAULT = 360;
/** 2026-08-26 §3.3 — the 审查专注 (review-focus) rail: entering narrows
 *  chat to 320px so the viewer dominates; exit restores the snapshot. */
export const REVIEW_CHAT_W = 320;

/** M75-ux2 §3: one center-panel tab — the workspace-relative path, its last
 *  segment (the strip's label), and the dir flag (which viewer mode the tab
 *  renders in). */
export interface ViewerTab {
  readonly path: string;
  readonly name: string;
  readonly isDir: boolean;
}

/** M75-ux2 §3 (spec): the strip caps at 10 tabs — past the cap a new tab
 *  evicts the oldest NON-active one and the notice names it (ω99-153: the
 *  tab on screen never silently gives way). */
export const MAX_TABS = 10;

/** The strip label: the path's last non-empty segment (the root dir itself
 *  stands in when the path has none). */
export function pathName(path: string): string {
  return path.split("/").filter((p) => p !== "").slice(-1)[0] ?? path;
}

/** M76-ux2 §1: a workspace-MUTATING tool entry — the agent-refresh watcher's
 *  class of interest (its summary is the target path, in tree-relative
 *  form, which is exactly what the marker set stores). */
export function isWriteTool(e: HistoryEntry): e is Extract<HistoryEntry, { kind: "tool" }> {
  return e.kind === "tool" && (e.name === "write_file" || e.name === "edit_file");
}

/** M75-ux3 §6: the palette's result cap — a listing walk can hand the
 *  palette thousands of rows; 50 is a full screen of choices and the cap
 *  keeps the DOM (and the per-char highlight spans) bounded. */
export const SEARCH_RESULTS_CAP = 50;

/** ui-review-r3 P3: the ranked cap — a scored query caps at 20 (the
 *  unfiltered listing keeps the 50-row SEARCH_RESULTS_CAP; ranking earns
 *  the tighter screen). The ranking itself lives in file-fuzzy.ts (夜移 019:
 *  real the upstream's file-index paradigms — smart-case, bitmap pre-reject, fused
 *  nucleo-style scoring — plus wudao's kept basename-class separation). */
export const SEARCH_MATCHED_CAP = 20;

/** ui-review-r3 P6: pair each CODE POINT with whether its UTF-16 start is a
 *  hit — file-fuzzy's scan rides indexOf (UTF-16), the render spreads code
 *  points, and an astral char (a surrogate pair) between the match and the
 *  hit shifted every highlight after it. This is the one place the two
 *  units meet. */
export function pathCharsWithHits(path: string, hits: ReadonlySet<number>): readonly { readonly ch: string; readonly hit: boolean }[] {
  const out: { ch: string; hit: boolean }[] = [];
  let at = 0;
  for (const ch of path) {
    out.push({ ch, hit: hits.has(at) });
    at += ch.length; // astral chars span two UTF-16 units
  }
  return out;
}

/** ui-review-r3 I7: the local-notice cap — past 50 the OLDEST drop (the
 *  newest always stays). */
export const MAX_LOCAL_NOTICES = 50;

/** ui-review-r3 I7: the consecutive-duplicate fold's suffix shape ("text
 *  ×N"). The count rides the TEXT here because the local list is folded at
 *  append time (r7 I3's view-side fold in HistoryList covers whole-history
 *  runs; this one keeps the LOCAL list itself bounded); no caller text
 *  legitimately ends in the suffix. */
export const NOTICE_FOLD_RE = /^(.*) ×(\d+)$/;

/** 0.3.4 反馈（切模式通知钉底）：a view-local notice rides WITH its moment —
 *  the cursor records the server-history length at append time, and the merge
 *  (mergeLocalNotes) interleaves the notice at that position in the flow. The
 *  old concat-at-the-end pinned every notice below ALL later messages forever
 *  (three mode switches stacked three permanent rows at the column's bottom). */
export interface LocalNote {
  readonly text: string;
  /** history.length when the notice landed — renders after that many server
   *  entries (before the entry that arrived next). */
  readonly after: number;
  /* ω99-276（续，标记见上）③ — 系统消息只属于它落地时的那个视图代（用户令
   * 09-11「系统消息只打到当前激活的会话中，切换会话之后就应该清理了」）：
   * historyEpoch 是视图代的代序号（每次 reset:true 重放——resume/clear/重连
   * ——都 +1）。可选字段：旧测试的双字段字面量仍类型合法（它们不经受代换，
   * mergeLocalNotes 也不读它）；App 的 notify 恒盖戳，代换 effect 按它清除。 */
  readonly epoch?: number;
}

/** ui-review-r3 I7: append a notice, folding CONSECUTIVE duplicates into one
 *  「text ×N」 row (a looping failure no longer floods the transcript) and
 *  capping the list at MAX_LOCAL_NOTICES. Non-consecutive repeats stack
 *  normally — only a run of the same text folds. */
export function appendNotice(notes: readonly LocalNote[], text: string, after: number, epoch?: number): readonly LocalNote[] {
  const last = notes[notes.length - 1];
  if (last !== undefined) {
    const folded = NOTICE_FOLD_RE.exec(last.text);
    const base = folded !== null ? (folded[1] ?? "") : last.text;
    if (base === text) {
      const count = folded !== null ? Number(folded[2] ?? "1") + 1 : 2;
      /* ω99-276（续，标记见上）— 折叠行继承被折叠者的视图代（×N 行的出生
         时刻是第一次落地，不是最近一次重复）。 */
      return [...notes.slice(0, -1), { text: `${base} ×${count}`, after, epoch: last.epoch }];
    }
  }
  const next: readonly LocalNote[] = [...notes, { text, after, epoch }];
  return next.length > MAX_LOCAL_NOTICES ? next.slice(next.length - MAX_LOCAL_NOTICES) : next;
}

/** Interleave the view-local notes into the server history at their cursor
 *  positions — a notice renders where it HAPPENED, like a message (0.3.4
 *  反馈). A replay that SHRANK the history (reset:true — resume/clear/
 *  reconnect) parks the overflow at the end: append order is preserved, and
 *  a notice never precedes messages that were already on screen when it
 *  landed. */
export function mergeLocalNotes(history: readonly HistoryEntry[], notes: readonly LocalNote[]): readonly HistoryEntry[] {
  if (notes.length === 0) return history;
  const out: HistoryEntry[] = [];
  let ni = 0;
  for (let hi = 0; hi < history.length; hi++) {
    // notes whose cursor sits at/below this index landed BEFORE this entry
    while (ni < notes.length) {
      const n = notes[ni];
      if (n === undefined || n.after > hi) break;
      out.push({ kind: "notice", text: n.text });
      ni += 1;
    }
    const entry = history[hi];
    if (entry !== undefined) out.push(entry);
  }
  for (; ni < notes.length; ni++) {
    const n = notes[ni];
    if (n !== undefined) out.push({ kind: "notice", text: n.text });
  }
  return out;
}

/** ui-review-r3 P2: the persisted layout slice — ONE versioned localStorage
 *  key. Widths re-clamp on hydrate (a narrower window since the save must
 *  not restore an over-wide panel); tab paths hydrate unvalidated (v1
 *  cannot check existence without a fetch) and any whose read later
 *  rejects drops silently (FileViewer's onReadFailed). The shell MODE is
 *  deliberately absent — settings' ui.defaultMode already persists it. */
export const UI_LAYOUT_KEY = "wudao.ui.v1";

export interface PersistedLayout {
  readonly treeW: number;
  readonly chatW: number;
  readonly leftCollapsed: boolean;
  readonly centerCollapsed: boolean;
  readonly rightCollapsed: boolean;
  readonly buddyCollapsed: boolean;
  readonly tabs: readonly { readonly path: string; readonly isDir: boolean }[];
  readonly activeTabIndex: number;
}

/** Read the slice; ANY malformed payload (corrupt JSON, wrong shape, a
 *  blocked storage) reads as empty — the defaults stand, never a crash. */
export function readPersistedLayout(): Partial<PersistedLayout> {
  try {
    const raw = window.localStorage.getItem(UI_LAYOUT_KEY);
    if (raw === null) return {};
    const v = JSON.parse(raw) as Partial<PersistedLayout>;
    return typeof v === "object" && v !== null ? v : {};
  } catch {
    return {};
  }
}

/** The hydrated tab strip: well-formed rows only (a string path, the dir
 *  flag), MAX_TABS-bounded — names re-derive (pathName), never trusted from
 *  storage. Pure so both the tabs and the active-index initializers agree. */
export function hydrateTabs(saved: Partial<PersistedLayout>): readonly ViewerTab[] {
  if (!Array.isArray(saved.tabs)) return [];
  return saved.tabs
    .filter((t): t is { path: string; isDir: boolean } =>
      typeof t === "object" && t !== null && typeof t.path === "string" && t.path !== "" && typeof t.isDir === "boolean")
    .slice(0, MAX_TABS)
    .map((t) => ({ path: t.path, name: pathName(t.path), isDir: t.isDir }));
}

/** M75-ux3 §6 — the Ctrl+P file-search palette: fuzzy (subsequence) search
 *  over the paths the tree has ALREADY loaded (the App's knownPaths ref,
 *  fed by FileTree's onPathsChange) — frontend-only by design, so an
 *  unexpanded dir's files are simply absent until the tree fetches them.
 *  ↑/↓ walk the results, Enter/click opens, Esc or a scrim click closes;
 *  the matched characters highlight. The geometry is spec-pinned: a fixed
 *  scrim, the 400px pop hanging from the top fifth. */
export function FileSearch({ getAllKnownPaths, onOpenPath, onClose }: {
  /** Read the tree's loaded-path index at compute time (a ref read, so a
   *  background refresh between queries is picked up on the next key). */
  getAllKnownPaths(): readonly string[];
  onOpenPath(path: string): void;
  onClose(): void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  // ω99-151: IME 组合态——组合期搜索框的 ↑↓/Enter/Esc 让位给候选条。
  const imeRef = useRef<ImeGuardState>({ composing: false, endedAt: 0 });
  // 夜移 019: the palette's path index — built ASYNC over the tree's loaded
  // paths (time-chunked, so a huge tree never blocks a keystroke), keyed by
  // the paths ARRAY REFERENCE getAllKnownPaths() hands back: a background
  // tree refresh swaps the array and the next key rebuilds. Small trees
  // finish synchronously inside the first call (a chunk boundary never hits
  // under 256 paths), so first results land on the same render; large trees
  // become queryable after their first chunk — readyTick re-renders as the
  // ready prefix grows, answering BEFORE the build finishes (real the upstream's
  // queryable-prefix paradigm).
  const [readyTick, setReadyTick] = useState(0);
  const indexRef = useRef<{ source: readonly string[] | null; build: AsyncPathIndexBuild } | null>(null);
  const ensureIndex = (): AsyncPathIndexBuild => {
    const paths = getAllKnownPaths();
    const cur = indexRef.current;
    if (cur !== null && cur.source === paths) return cur.build;
    const build = buildPathIndexAsync(paths);
    indexRef.current = { source: paths, build };
    // A build that already finished synchronously (small trees never hit a
    // chunk boundary) needs no tick — attaching one would only fire a stray
    // post-render setState. Only an in-progress build re-renders as its
    // ready prefix grows.
    if (build.readyCount() < paths.length) {
      void build.queryable.then(() => setReadyTick((t) => t + 1));
      void build.done.then(() => setReadyTick((t) => t + 1));
    }
    return build;
  };
  // UI-5 C9 姊妹: the results listbox's id namespace — rows get stable ids so
  // aria-activedescendant can point at the highlighted row (SRs announce the
  // ↑/↓ moves; the input keeps DOM focus). useId scopes to the palette
  // instance, so no collision with the session picker's rows.
  const listId = useId();
  // ui-review-r1 I1: capture the trigger BEFORE this component's own focus
  // effect runs (hooks fire in declaration order — declared after, it would
  // capture the palette's own input). Esc / scrim / pick land focus back on
  // the trigger; the palette never strands keyboard users at <body>.
  useFocusReturn();
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const results = useMemo(() => {
    const q = query.trim();
    if (q === "") {
      return getAllKnownPaths().slice(0, SEARCH_RESULTS_CAP).map((path) => ({ path, hits: new Set<number>() }));
    }
    // ui-review-r3 P3 lineage + 夜移 019: every match ranked (not
    // first-50-in-path-order) by file-fuzzy's smart-case fused scoring —
    // HIGHER is better, ties by path asc; the module pre-ranks, so no
    // component-side sort. readyTick re-runs this as the async build's
    // ready prefix grows.
    return searchPathIndex(ensureIndex().index, q, SEARCH_MATCHED_CAP);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- readyTick is the async build's re-render signal; ensureIndex/getAllKnownPaths read live refs at compute time by design.
  }, [query, readyTick]);

  const onQuery = (text: string): void => {
    setQuery(text);
    setSel(0); // every new query resets the cursor to the first row
  };
  return (
    <div className="search-scrim" onClick={onClose}>
      <div className="search-pop" role="dialog" aria-label="文件搜索" onClick={(e) => e.stopPropagation()}>
        {/* ui-review-r4 I4: the SessionPicker header idiom — the palette's
            ↑↓/Enter/Esc contract was invisible until you already knew it. */}
        <div className="session-head">文件搜索 — ↑↓ 选择 · Enter 打开 · Esc 关闭</div>
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          placeholder="搜索文件…"
          aria-label="搜索文件"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          // ω99-151: 组合起止落进守卫状态（Safari 的假 Enter 靠 endedAt 时间窗兜）。
          onCompositionStart={() => { imeRef.current = imeStart(imeRef.current); }}
          onCompositionEnd={() => { imeRef.current = imeEnd(imeRef.current, Date.now()); }}
          onKeyDown={(e) => {
            /* ω99-151: 组合期 IME 拥有键盘——Enter 是确认候选，不是打开文件。 */
            if (imeSwallows(e.nativeEvent, imeRef.current, Date.now())) return;
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
              return;
            }
            if (e.key === "Enter") {
              e.preventDefault();
              const row = results[sel];
              if (row !== undefined) onOpenPath(row.path);
            }
          }}
        />
        <div
          className="search-results"
          role="listbox"
          aria-activedescendant={results[sel] !== undefined ? `${listId}-opt-${sel}` : undefined}
        >
          {results.length === 0 ? (
            <div className="search-empty">无匹配文件</div>
          ) : (
            results.map((r, i) => (
              <div
                key={r.path}
                id={`${listId}-opt-${i}`}
                className={`search-item${i === sel ? " sel" : ""}`}
                role="option"
                aria-selected={i === sel}
                data-path={r.path}
                onClick={() => onOpenPath(r.path)}
              >
                {pathCharsWithHits(r.path, r.hits).map(({ ch, hit }, ci) =>
                  hit ? (
                    <span key={ci} className="hit">
                      {ch}
                    </span>
                  ) : (
                    <span key={ci}>{ch}</span>
                  ),
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

/** M76-ux2 §3: the picker's row cap — the spec's 时间倒序前 20 条 (the picker
 *  sorts newest-first itself; see `shown` — the sessions op delivers
 *  mtime-ASC, per store.list()'s --continue contract). */
