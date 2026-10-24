// M43-A §1 — AgentDriver: the framework-agnostic frontend logic, extracted
// verbatim from tui/use-agent.ts. One driver owns one conversation: it drives
// the loop, maps events to HistoryEntry[] (the append-only channel), keeps a
// small full-snapshot status (the state channel — NEVER containing history,
// so a streaming delta cannot fan out O(history) payloads), parks permission
// asks, owns the runtime mode, and exposes the ops every frontend submits
// through. React (the TUI) is a useSyncExternalStore adapter over this class;
// the WS server (wudao ui) is another consumer.
import { open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { runAgentLoop, resolveWorkspacePath, repairOrphanedToolCalls, parseTodoBoard, estimateTokens, estimateTokensBreakdown, toModelToolDefinition, createJsonlSessionStore, applySummaryMarkers, manualCompact, compactionRetentionFor, branchSummaryNote, chainForTurn, commonPrefixLength, forkPredatesCompaction, listBranchLeaves, nodeKey, renderBranchTree, activeBranchLeafKey, resumeChain, SUMMARY_MARKER, replaceSystemPrompt, sessionLeaseBoxFor, SESSION_ID_RE, readStateEntry, inspectToolInput } from "@wudao/core"
import type { AgentHooks, AgentMessage, AgentState, FileHistory, IdentifiedOutputDelta, LoopEvent, LoopOptions, ModelClient, NotificationKind, PermissionDecision, ReadStateTable, SessionLeaseBox, SessionStartSource, Terminal, Tool, ImageBlock, FileBlock, SpoofInspection } from "@wudao/core";
import { isValidImageBlock, isValidFileBlock } from "@wudao/core";
import { renderTurnDiff } from "../turn-diff-render.js";
import { truncate, formatCompactedLine, modelLabel, RESULT_PREVIEW_CHARS } from "../log.js";
// ω99-41: streaming deltas accumulate in chunk buffers (linear) and fold into
// `live` only at the observation seams — see the block beside the `live` decl.
import { createTextBuffer } from "../stream-text.js";
import { createFileChangeWatcher } from "../file-change.js";
import { resolveGenericShapingRuntime } from "../output-config.js";
// 夜移 028: the refCounted caffeinate holder's driver-side guard — one sync
// line at every busy/pendingPermission transition below.
import { createSleepGuard } from "../prevent-sleep.js";
import { SESSION_END_BUDGET_MS, buildConfiguredHooks, composeAgentHooks } from "../hooks-config.js";
import { composeReflectHooks, reflectRuntimeFor } from "../reflect-config.js";
import { languageBlockFor, resolveLanguageBlockMode, reasoningBlockFor, resolveReasoningLanguageMode, resolveLanguagePreference, resolveLanguageArgument, formatLanguageStatus, type LanguageBlockMode, type ReasoningLanguageMode, type LanguagePreference } from "../language.js";
import { createExternalChangeProber, type ExternalChangeProber } from "../file-changes.js";
// ω99-314: 文件级时光机——content-addressed 快照仓纯层（写前捕获 observer +
// settle 索引 + fileRevert 的数据面）。
import { withSnapshotCapture, snapshotIndexFromEntries, latestAfterShaByPath, sha256Hex, type SnapshotStore, type FileSnapshotRow } from "../snapshots.js";
// ω99-319（Bash/命令级改动归因）: shell 前后指纹扫描的 observer + 足迹形状
// ——settle 缝把足迹 merge 进 changes（cmd 归因标记）+ command_footprint 泛型
// 条目；读侧回放（changes[].cmd 的 resume 重建）在 resume.ts 的白名单。
import { withCommandFootprint, type CommandFootprint } from "../cmd-footprint.js";
import { buildPlanPrompt, planModeDenied, buildPlanRevisionPrompt, buildPlanExecutionPrompt, parsePlanReviewInput, createTodoBoardSource, PLAN_REVIEW_HINT, appendPlanApprovalTrace } from "../plan.js";
import { askAnswerToDecision, applyAskAnswer, protectedSettingsFile, modeLabel, type AskAnswer, type Mode } from "../permission.js";
import { readGlobalSettings, saveGlobalSettings } from "../settings-layer.js";
// ω99-56 — the file-edits approval gate (deslop): a pure helper module over
// the permission pipeline's own receipt machinery (see approval-gate.ts).
import { approvalGatedCall, approvalReceiptMatches, createApprovalGateState, markHumanSettled, humanSettledThisCall, recordApprovalReceipt } from "../approval-gate.js";
import { askDigestPrefix } from "../ask-evidence.js";
import { askReviewIntro } from "../ask-reviewer.js";
import type { Sidecar } from "../sidecar.js";
import { gitRiskAskWarning } from "../git-safety.js";
import { resumeEntries, receiptNoticesFromEntries } from "../tui/resume.js";
import { parseReplCommand, FIND_TUI_ONLY_NOTICE } from "../repl.js";
import { listSlashCommands } from "../slash-commands.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import { expandMentions } from "../mentions.js";
import { parseRewindTarget, formatRewindList, formatRewindTurnList, applyRewind } from "../rewind.js";
import { buildExpandedSkillMessage, buildSubstitutedSkillMessage, createSkillReadClassifier, findSkill, formatSkillError, isSkillPruned, skillBodyNeedsInjection } from "../skills.js";
import type { LoadedSkill } from "../skills.js";
import type { PluginCommand } from "../plugins.js";
import { collectSessionRows, defaultSessionListFilter, isErrorTail, isUnfinishedTail, sessionNameSource } from "../session-list.js";
// ω99-277: #2 — 会话全文搜索纯层（切换会话弹框的搜索车道；searchSessions 的引擎）。
import { searchSessionFiles, type SessionSearchHit } from "./session-search.js";
// ω99-279: #4 — 回收站式删除纯层（切换会话弹框的清理车道；deleteSession 的引擎）。
import { deleteSessionFile, sessionLeaseAlive, restoreSessionFile, listTrashedSessions, type SessionDeleteResult, type SessionRestoreResult } from "./session-delete.js";
// 夜移 005: the background title call's pure helpers.
import { buildTitleRequest, sanitizeTitle, TITLE_QUERY_SOURCE } from "../session-title.js";
import { buildPermissionAskEntry, buildPermissionSettledEntry } from "./permission-ledger.js";
// The away-recap pure layer (the title lane's read-only cousin).
import type { RecapPayload } from "../session-recap.js";
import {
  RECAP_MIN_NEW_MESSAGES,
  RECAP_QUERY_SOURCE,
  buildRecapRequest,
  composeRecapStats,
  countNewMessages,
  sanitizeRecap,
} from "../session-recap.js";
// 夜移 014: the /btw side-question lane's shared envelope/marker (the REPL
// lane imports the same module — both frontends fork with identical bytes).
// ω99-316 (/btw 侧问): the detached side-question engine — clone, freeze,
// stamp, run (maxTurns=3), never touching this session's state/JSONL/store.
// (The envelope/querySource/maxTokens constants moved into the engine —
// ../btw.js stays the single source both lanes share.)
import { runSideQuestion, type SideQuestionRunResult, type SideQuestionResult } from "../side-question.js";
import type { SessionRow } from "../session-list.js";
import type { AgentRegistry } from "../agents/index.js";
import { runMemoryCommand } from "../memory/commands.js";
// ω99-260: 面一 — the memory faces' data seam: the PHYSICAL store handle (the
// memory_write tool's own anchor, session-engine :1210's store — management
// stays usable even when recall is off; openSessionMemoryStore is NOT used
// here by ruling: memoryEnabled 关闭≠面板锁死).
import { openMemoryStore } from "../memory/store.js";
import type { MemoryEntry } from "../memory/store.js";
import { runRefineCommand } from "../memory/refine.js";
import { refineAutoRuntimeFor, observeAutoRefineOnHooks } from "../memory/auto-refine.js";
import { spawnBackgroundReview, REVIEW_MIN_TOOL_CALLS, neuterWriteTools } from "../memory/review.js";
// ω-4f (design 84): Dream consolidation — stage 2 (ledger→curated ledger).
import { spawnDreamRun } from "../memory/dream.js";
import { runSessionSearch } from "../session-search.js";
import { createTaintTracker, argsCarryTaint } from "../taint.js";
import { buildContextReport, formatContextReport } from "../context-report.js";
import { buildStatuslineSnapshot } from "../statusline.js";
// ω99-253 (see git-branch.ts for the cost discipline and null semantics).
import { readGitBranch } from "../git-branch.js";
import type { StatuslineSnapshot } from "../statusline.js";
import { isFeatureAblated } from "../args.js";
import { buildActiveBranchEntry, buildClearBoundaryEntry, buildRewindTurnEntry } from "../session-entry.js";
import type { LoopReflectionEntryInfo } from "../session-entry.js";
import { formatStatusReport } from "../commands/status.js";
import { formatCostReport, recordUsage, emptyUsageTotals } from "../commands/cost.js";
// P0-4 (96 队列): the cross-session wallet ledger (/cost all + sessionEnd flush).
import { aggregateCostLedger, readCostLedger, renderWalletReport, fetchWalletBalance } from "../commands/wallet.js";
import type { WalletBalanceOutcome } from "../commands/wallet.js";
import { renameSession, validateSessionName } from "../commands/rename.js";
import { runDiffCommand } from "../commands/diff.js";
import { runConfigCommand } from "../commands/config.js";
import { buildInitPrompt, extractInitDraft, formatInitPreview, applyInitDraft, hasExistingAgentsMd } from "../commands/init.js";
import { availableModels, formatModelList, formatEffortList, resolveModelArgument, resolveEffortArgument, recordModelSwitch, applyModelSelection, asMutableConfig, sameProviderModels, MODEL_SWITCH_CACHE_NOTE } from "../commands/model.js";
import type { ModelChoice, ModelSelection } from "../commands/model.js";
// M63 §A: the /provider command's shared machinery (pure halves; the client
// rebuild reaches the frontend through the onProviderSwitch seam below).
import { validateProviderName, providerRows, formatProviderList, recordProviderChange, envOnlyProviderResolver, borrowedKeyPoolNote, PROVIDER_SWITCH_CACHE_NOTE } from "../commands/provider.js";
import type { BuiltinProviderName, ProviderName } from "@wudao/providers";
// SDD 2026-08-23 persona: the /persona command's pure layer (parse → resolve
// → apply → record) — the driver's handler is a thin shell over it, exactly
// like the REPL's (repl.ts ~1668), with appendHistory notices for output.
import {
  parsePersonaArgument, resolvePersonaSwitch, resolveActivePersona,
  personaSwitchBreaksCache, recordPersonaChange, formatPersonaList, PERSONA_SWITCH_CACHE_NOTE,
} from "../commands/persona.js";
import type { PersonaChainSources } from "../commands/persona.js";
import { applyWirePersona, resolveContextWindowTokens } from "@wudao/providers";
import { loadEffectiveProfiles } from "../provider-registry.js";
import type { PersonaRegistry, PersonaRuntime, ResolvedPersona, ProtocolId } from "@wudao/providers";
// ω99-320: the session's soft-warn slot (run-scoped accounting + live notice).
import type { SoftWarnSlot } from "../soft-warn-tracker.js";
import { runPermissionsCommand } from "../commands/permissions.js";
// cc-plugins B1: the /plugin command face (same engine as `wudao plugin`).
import { runPluginSlashCommand } from "../commands/plugins-command.js";
// P1-5 (96 队列): /trust — the workspace trust gate's command face.
import { runTrustCommand } from "../commands/trust.js";
import { runConstitutionCommand } from "../commands/constitution.js";
// P1-7 (96 队列): /worktree — the main session's isolated worktree (the
// pure halves: adapter over core's createChildWorktree/removeChildWorktree,
// the remove guard, the status/usage text, the generic session entries).
import {
  WORKTREE_USAGE,
  enterMainWorktree,
  formatWorktreeStatus,
  recordWorktreeEntry,
  removeMainWorktree,
  worktreeRemoveBlocked,
  type WorktreeEntryData,
} from "../commands/worktree.js";
// P1-7: the extension face's rescan at the switched operation root.
import { rescanExtensionsAt } from "../extension-state.js";
import { exportEntriesFromHistory, prepareExport, writeExportFile } from "../commands/export.js";
import { collectUncommittedDiff, buildReviewPrompt, hasReviewableContent, formatNoDiffNotice, createGitFn } from "../commands/review.js";
import { runMcpStatusCommand } from "../commands/mcp-status.js";
import { runMcpAuthCommand } from "../commands/mcp-auth.js";
import { runAgentsCommand } from "../commands/agents-roster.js";
import { validateAddDirPath, buildAddedDirEntry, formatAddDirNotice, ADDED_DIR_TYPE } from "../commands/add-dir.js";
import { formatDoctorReport, type DoctorInput } from "../commands/doctor.js";
import { buildTaskRows, formatTasksReport } from "../commands/tasks.js";
import type { RosterPluginAgent } from "@wudao/core";
import { VERSION } from "../version.js";
import { getCompactInstructionsRider } from "../project-context.js";
// workspace-ux B1: the recents write behind panelRootSet (settings-ops owns
// the store; its AgentDriver/UiDriverPort imports are type-only, so this
// runtime import cannot cycle back).
import { recordRecentWorkspace } from "./settings-ops.js";
// M61 §1: the in-session scheduler runtime (cron tools + fire-on-idle).
import type { CronRuntime } from "../cron.js";
// ω-4a: the monitor runtime (monitor tools + steering-lane event delivery).
import type { MonitorRuntime } from "../monitor.js";
// M61 §2: the /loop controller (+ its schedule_wakeup tool seam).
import { createLoopController } from "../commands/loop.js";
import type { LoopController } from "../commands/loop.js";
// M61 §3: the /goal controller (the blocking prompt-based Stop hook).
import { createGoalController, buildEvaluatorModel, parseGoalCommand } from "../goal.js";
import type { GoalController } from "../goal.js";
// ω99-19: the mission campaign's shared slash parse (the driver reuses the
// REPL's exact grammar — status/clear aliases/start — zero re-parsing).
import { parseMissionCommand } from "../mission.js";
import type { MissionController } from "../mission.js";
// ω99-249: #6 — the model-side GoalState runtime — the budgeted goal derived from
// the mission ledger (injection/settlement/查询 all live in goal-runtime.ts).
import { createGoalRuntime } from "../goal-runtime.js";
import type { GoalRuntime, GoalWebSnapshot } from "../goal-runtime.js";
// M61 §4: the durable scheduling daemon (hosted by `wudao ui`).
import {
  parseScheduleCommand,
  loadSchedulesStore,
  scheduleRowsOf,
  lastRunsOf,
  SCHEDULES_SESSION_ID,
  type ScheduleLastRun,
  type ScheduleActionResult,
} from "../schedules.js";
import type { ScheduleDaemon, ScheduleListRow } from "../schedules.js";
// 永续 v6 wave2（reef C1）：门控自改进面的回执形状（提案仓 improve/store）。
import type { ImprovementFaceResult } from "../improve/store.js";
import { extractFileReceipt } from "./file-receipt.js";

// —— ω99-326a：自 agent-driver.ts 纯移动外提（类型/常量/纯函数；re-export 门面保公共面）——
import type {
  HistoryEntry, LiveState, DriverStatus, AgentDriverOptions, DriverPersonaContext, BranchLeaf,
  MemoryEntryMirror, FileTreeResult, FileReadResult, FileWriteResult, FileRevertResult,
  CtxInfoResult, PanelRootSetResult, AgentRootStatusResult, AgentRootSwitchResult,
} from "./types.js";
/** The driver's public face (what submit() did with a line). Frontends use it
 *  to decide their own follow-up UI (e.g. skip naming a session for a review
 *  input consumed as plan approval). */
export type SubmitOutcome =
  | "started"
  | "steered"
  | "notice"
  | "noop"
  /** M80: the driver executed /clear itself — the conversation state is
   *  wiped, the session id rotated to a fresh segment, and the empty history
   *  reset frame (reset:true) already reached subscribers. The calling
   *  frontend renders nothing: the reset frame owns the view. */
  | "cleared"
  /** A frontend-owned command (/help, /resume, /exit, plugin and extension
   *  commands) — the driver did nothing; the calling frontend renders it. */
  | "frontend";

/** cc-plugins A3 — one hot-rescan swap (what rescanExtensions() hands the
 *  driver through a frontend sink). Every field optional; present fields
 *  replace their option-slot twins, and `systemPrompt` additionally replaces
 *  state.systemPrompt (setOptions can NEVER land a new prompt: the loop reads
 *  STATE, and opts.systemPrompt is only read at driver creation). Busy runs
 *  park the swap — it lands at run settle, like a queued /model switch — so
 *  an in-flight run's requests keep their prompt bytes. */
export interface DriverExtensionSwap {
  readonly skills?: readonly LoadedSkill[];
  readonly pluginCommands?: readonly PluginCommand[];
  readonly pluginAgents?: readonly RosterPluginAgent[];
  readonly hooks?: AgentHooks;
  readonly systemPrompt?: string;
}

// ω99-225: #1 — resume 的判决从会撒谎的布尔升级为带因三态：0.3.59 验装回执
// 里「点历史会话 → (会话不存在 —— 可能已被删除)」是谎话——会话存在，是被
// 另一进程占用（孤儿 sidecar 持活租约）。占用与不存在在协议层可区分后，
// 前端文案从猜变成知道（server/web 各持结构镜像，见 UiDriverPort/protocol）。
/** The resume verdict: adopted (`ok`), truly absent from the store
 *  (`not_found` — no recorded entries, or no session domain at all), or held
 *  by another live process (`occupied` — the lease holder's pid rides along
 *  so the caller's refusal can name the window to close). */
export type ResumeOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "not_found" }
  | { readonly ok: false; readonly reason: "occupied"; readonly holderPid: number };

export interface AgentDriver {
  /** Subscribe to status-channel changes. Returns the unsubscribe. */
  subscribe(cb: () => void): () => void;
  /** Subscribe to history changes. Append-only during a run: the callback
   *  receives the newly appended batch (entries land exactly once; a
   *  reconnect replays via getHistory()). On a whole-history replacement
   *  (clear / loadHistory) the callback receives the FULL new list with
   *  `reset: true` — subscribers replace, not append. */
  onHistory(cb: (entries: readonly HistoryEntry[], reset: boolean) => void): () => void;
  /** Subscribe to the raw LoopEvent stream (debug/tools). */
  onLoopEvent(cb: (event: LoopEvent) => void): () => void;
  /** The current status snapshot (referentially stable until the next change). */
  getStatus(): DriverStatus;
  /** Rebuild + rebroadcast the status snapshot with NO state change — for ops
   *  that mutate shared disk state out-of-band (the provider registry writes):
   *  buildStatus re-reads the already-invalidated registry memo, so the next
   *  state push carries the fresh model matrix. A failed write never calls
   *  this (the I2 discipline: no refresh without a landed change). */
  refreshStatus(): void;
  /** 推理档三级配置 S4: mutate the session language tier (/language's
   *  programmatic twin — the web's language chip lands here). Per-knob:
   *  an unset knob keeps its current fold. Emits so status subscribers
   *  see the new pair. */
  setLanguage(pref: Partial<LanguagePreference>): void;
  /** The session-effective language fold (getStatus().language's source). */
  getLanguage(): LanguagePreference;
  /** 推理档三级配置 S5: the session-effective effort (modelLive's field —
   *  withSettingsOps overlays it onto settingsStatus.current.effort; unlike
   *  getStatus().model.effort it reads even when the model block is null,
   *  i.e. no identity meta was ever supplied). Undefined when the session
   *  never picked. */
  getEffort(): string | undefined;
  /** 0.3.32c kimi-401: would a same-name /provider re-resolve change
   *  anything? True when the live config is the wizard placeholder (M63 §C
   *  completion) or the credentials file holds a key the live pool lacks
   *  (a settings key save the running session has not picked up). The
   *  settings lane's key-save hot-refresh gates on it. */
  keyRefreshPending(): boolean;
  /** 2026-08-31 config-drift: the union of every same-name refresh leg —
   *  placeholder completion, key drift (keyRefreshPending), and endpoint/wire
   *  drift (configRefreshPending — the settings row save rewrote the
   *  registry). The settings lanes' hot-refresh wrappers gate on this; a save
   *  that would change the live connection lands without a manual
   *  re-switch. */
  providerRefreshPending(): boolean;
  /** The full history (append-only; the reference changes only on append,
   *  clear, or loadHistory). */
  getHistory(): readonly HistoryEntry[];
  getMode(): Mode;
  getSessionId(): string;
  /** Keep the driver's latest opts (the React adapter refreshes them every
   *  render; a run reads model/gates/hooks at ITS start). */
  setOptions(opts: AgentDriverOptions): void;
  /** cc-plugins A3: land a rescanExtensions() swap — option-slot fields plus
   *  the rebuilt system prompt. Idle → immediate; busy → parked to run
   *  settle (the in-flight run keeps its prompt/hooks bytes). */
  replaceExtensions(ext: DriverExtensionSwap): void;
  /** 夜移 018 (延迟预取 wudao 适配): append late-arriving tools (deferred
   *  MCP load — the boot never waits on server handshakes). Idle →
   *  immediate append + receipt; busy → parked to run settle (the
   *  in-flight request keeps its tool bytes; the NEXT run carries them).
   *  Empty input is a no-op. */
  addTools(tools: readonly Tool[]): void;
  /** The AgentState (runtime-mutable; shared with the tool set's probe/fork
   *  closures). Undefined never happens — the state is created eagerly. */
  readonly state: AgentState;
  /** SDD 2026-08-23 persona: the injected persona seam (registry + runtime +
   *  chain/wire views), read live through setOptions — the same
   *  session-scoped context /persona switches through. Undefined when the
   *  frontend supplied none (the degraded-notice path). */
  readonly persona?: DriverPersonaContext;
  /** Submit one input line — the full routing seam (M43-A Task 3).
   *  Driver-executable commands (/plan, /skill:name, /rewind) and @-mention
   *  expansion run here; a plain prompt (and a plan-review `ok` / `改 …` while
   *  a board is pending) starts or steers the run. Busy → parks as a steering
   *  item (the loop drains it before the next model call; a late one
   *  auto-starts at run end). `expand: false` submits a pre-built envelope
   *  verbatim (skill/plugin invocations — their own @tokens are their
   *  author's, not this user's). */
  submit(text: string, opts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly ImageBlock[]; readonly files?: readonly FileBlock[] }): SubmitOutcome;
  /** Interrupt the in-flight run (abort the fetch/tool race, then unwind).
   *  ω99-45: the SAME cancel point now also aborts an in-flight /compact
   *  summarizer — a manual compaction runs while "not busy", so this is the
   *  one funnel every frontend (TUI Esc / WS interrupt / headless signal)
   *  already reaches. An aborted compaction writes no boundary.
   *  借鉴弧 δ (penguin 367ab084): the SAME funnel now also stops background
   *  (detached) tool tasks — an explicit user stop outranks a background run
   *  (用户意图优先); the per-call controllers get the abort, shell groups
   *  get TERM→KILL. */
  interrupt(): void;
  /** 借鉴弧 δ（penguin 367ab084 思想）— move ONE in-flight tool call to the
   *  background: its result stops blocking the turn, the run closes at the
   *  turn boundary (Terminal.backgrounded — the conversation comes back),
   *  and the landed result merges later through the monitor-sibling lane.
   *  Typed refusals: "not_detachable" (the interruptBehavior:"block" family
   *  — cancellation itself is the hazard there) and "not_in_flight" (no
   *  busy row matches). Bare call = the FIRST detachable busy row. The
   *  verdict is optimistic by necessity (the call may finish naturally
   *  between the click and the loop's race — the next frame is the truth). */
  detachToolCall(callId?: string): import("./detach-lane.js").DetachVerdict;
  /** ω99-45: the single "session settled" predicate — no run active (a model
   *  call, busy tools, and provider retries all ride the run's lifetime), no
   *  in-flight compaction, no queued steering/follow-up, no pending monitor
   *  events. Idle-sensitive callers (a second /compact, the TUI's idle-Esc
   *  branches) read this instead of re-deriving their own condition — the
   *  ad-hoc busy-checks kept missing the compaction/queue/monitor
   *  dimensions. Read-only; no option, no subscription. */
  isIdle(): boolean;
  /** List every slash command this driver knows (the suggestion menu / help
   *  data face; UI-presentational commands render in each frontend). */
  listSlashCommands(): readonly SlashCommandInfo[];
  /** The /resume picker's data face: recent session rows (oldest-first, the
   *  store's order). Empty when no workspaceRoot was given. */
  sessions(): Promise<readonly SessionRow[]>;
  /** ω99-277 — 全文搜索所有会话的可见正文（切换会话弹框的搜索车道）：
   *  命中行带会话身份 + 问/答 + ±30 字摘要；与 sessions() 同一会话集与
   *  worktree 过滤语义；空 q / 无 workspace → []。只读。 */
  searchSessions(q: string): Promise<readonly SessionSearchHit[]>;
  /** ω99-313 — 定时任务与提醒的读面（web schedulesList op 的数据源）：
   *  store 只读扫描（人话触发器 + 下跑时间 + 状态位 + 会话绑定——侧栏的
   *  ⏰ 标记按 sessionId join）。refused（kill switch/symlink）→ []（面
   *  隐藏，非致命）。只读。 */
  schedulesList(): Promise<readonly ScheduleListRow[]>;
  /** ω99-317 — 定时任务管理面的写面三件（web 管理面板的动作落点）：
   *  全部路由 o.schedule（进程内守护是调度存储的唯一所有者——绕过它直写
   *  store 会被守护的下一次 persist 覆盖）。setEnabled=false/true 即
   *  pause/unpause（unpause 兼任熔断重开，313 语义零动）；remove 删的是
   *  .wudao 调度条目，绝不触碰用户文件；runNow 带 busy 守卫与显式熔断
   *  复位旗。回执联合 {ok,message}——message 是守护中文回执原样中继。 */
  schedulesSetEnabled(id: string, enabled: boolean): Promise<ScheduleActionResult>;
  schedulesRemove(id: string): Promise<ScheduleActionResult>;
  schedulesRunNow(id: string, opts?: { readonly resetBreaker?: boolean }): Promise<ScheduleActionResult>;
  /** ω99-279（续，标记见上）— 回收站式删除一个会话（切换会话弹框的清理车道）：原子
   *  rename 进 sessions 目录的 .trash/ 子目录（可恢复，绝不 rm），对
   *  sessions()/searchSessions() 双隐身。deleted:false 三因：invalid-id
   *  形状拒（路径拼接前的 fail-closed 门）/ not-found 收敛（重放安全）/
   *  active 活跃保护拒（当前主会话与活跃 pet 车道，不碰磁盘）。 */
  deleteSession(id: string): Promise<SessionDeleteResult>;
  /** ω99-283: #2 — 回收站列表与恢复（切换会话弹框的回收站面，
   *  279「可恢复」的通路闭合）：trashSessions 是 .trash 的唯一读方
   *  （mtime 降序帽 20，SessionRow 同形）；restoreSession 把回收件
   *  link+unlink 搬回活区——link 原子 no-overwrite，目标已在不覆盖
   *  （target-exists 拒，活区字节零变）。恢复永不破坏：无 guardIds。 */
  trashSessions(): Promise<readonly SessionRow[]>;
  restoreSession(id: string): Promise<SessionRestoreResult>;
  /** Load a session by id: same projection the startup resume uses (entries →
   *  messages → summary markers → orphan repair), adopted as the conversation.
   * Returns the ω99-225 verdict: `ok`, `not_found` (no recorded entries / no
   * session domain / unreadable file), or `occupied` with the live lease
   * holder's pid — never a bare boolean that conflates the two refusals. */
  resume(id: string): Promise<ResumeOutcome>;
  /** ω99-286: #2 — 断点续跑（durable runs L1）：把「没跑完的会话」原样续跑。
   *  会话不存在 / 形状拒（SESSION_ID_RE + side- 前缀，fail-closed）→
   *  started:false；存在 → 载入（复用 resume 载入链，孤儿修补照跑；本进程
   *  已持有该会话则免重载）→ 尾部不是未完成形状（isUnfinishedTail）→
   *  started:false 不空转（零模型调用）；是 → 启动 run 包装但**不 append
   *  用户消息、不 onUserTurn**（历史尾部 user/tool_result 即模型输入尾——
   *  不注引导语，前缀字节稳定），完成后照常 settle/持久。busy / 手动
   *  compact 进行中 → false（续跑无停泊车道）。guardIds 不涉及（纯启动，
   *  非删除面——租约由 run 包装照常持有）。
   *  ω99-289: #2 — 失败尾接进同一台机器：尾部是合成
   *  "(error: …)" 错误尾（isErrorTail）时**先全门后变异**——前驱必须是
   *  中断形（isUnfinishedTail(slice(0,-1))；settled 前驱是构造上不可达
   *  的防御形状 → 拒跑且 state 零动，fail-closed），过门后内存 pop 合成
   *  错误（/edit 分支臂同款 history 重建块）再 startRun continueRun：从
   *  失败点续跑，跑成的不丢。append-only 日志一字不动——合成错误条目
   *  留在旧支（分支不是删除：重试轮首条新消息 parentUuid 链失败点前驱，
   *  下次 resume 走最新链，旧错误支孤儿在树）。 */
  /** 127 项 3（F2）— started:false 的加性成因（driver 填，调用方可忽略）：
   *  "busy"（宿主占用/压缩窗）、"not_found"（会话不可读/不存在）、"settled"
   *  （尾部已完成——绑定语义的既有回落，不是失败）、"shape"（id 形状拒/无
   *  workspaceRoot）。消费方：schedules 的绑定降级披露（settled 不算拒绝）。
   *  字面与 schedules.ts 的 ScheduleContinueRefusal 同一集合（结构兼容，
   *  不 import——contract 不依赖 schedules）。 */
  continueSession(id: string): Promise<{ readonly started: boolean; readonly refused?: "busy" | "not_found" | "settled" | "shape" }>;
  /** /rewind's engine: list (`"list"` → the formatted list lands as a notice,
   *  returns it), or roll back to before step n / the last one. Returns the
   *  notice text; rejects propagate to the caller. */
  rewind(target: number | "last" | "list"): Promise<string>;
  /** M53 §1: the recent user messages, 1 = most recent (the /edit listing). */
  listEditTargets(): readonly { readonly n: number; readonly text: string }[];
  /** M53 §1: arm message n for editing — records the branch point (the
   *  message's parent) and returns its text so the frontend can put it back
   *  in the input. The NEXT plain submit branches from there. Undefined when
   *  n is out of range (or a run is in flight). */
  beginEdit(n: number): string | undefined;
  /** M53 §1: the ASCII branch topology notice (/tree). Reads the session
   *  JSONL when a workspace is configured (the abandoned branches live
   *  there); the in-memory chain otherwise. */
  tree(): Promise<string>;
  /** M53 §1: /switch — undefined lists the branches (the notice lands in the
   *  history, returns it); a number swaps the active chain to that branch. */
  switchBranch(n?: number): Promise<string>;
  /** ω99-258: the structured branch leaf table — the same JSONL read path as
   *  tree()/switchBranch() (allMessagesForTree), returning core's leaf list
   *  verbatim (forkPreview/messageCount/isCurrent) for the web branch panel.
   *  Read-only, busy-safe, fetched on demand — never a status frame. */
  branchLeaves(): Promise<readonly BranchLeaf[]>;
  /** ω99-258: void a pending /edit arm (the web banner's 取消). Idempotent —
   *  always true; the next plain submit goes to the mainline again. */
  disarmEdit(): boolean;
  /** ω99-260: the full memory ledger (PROTOCOL "memoryList") — the physical
   *  store's load() passed through STRUCTURED (file order, active+pending,
   *  every field mirrored; the web faces render, never parse TUI text). No
   *  workspace → {entries:[]} (the panel's empty state, the card's hide).
   *  永续 v6 弧 A（reef C3）：blocked = 被拦学习输入计数（凭据值/指令注入
   *  形状，未入库）——记忆管理面/审批面的「已拦 N 条」数据源；0 = 零渲染。
   *  Read-only, busy-safe, fetched on demand — never a status frame. */
  memoryList(): Promise<{ readonly entries: readonly MemoryEntryMirror[]; readonly blocked: number }>;
  /** ω99-260: decide one pending memory (PROTOCOL "memoryDecide") — ok =
   *  confirm (pending→active), del = remove the line. store.confirm/remove
   *  are the SINGLE source (the /memory ok|del twins); the reply is the
   *  structured {ok, message} verdict, never rendered command text. */
  memoryDecide(id: string, action: "ok" | "del"): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** ω99-264: #1 — rewrite one memory entry's content (PROTOCOL "memoryEdit") —
   *  store.update + a CONDITIONAL store.confirm: an ACTIVE entry returns to
   *  active (the user's own 改写 press is the authorization chain's end — no
   *  re-review), a PENDING entry stays pending (an edit never decides for
   *  the user). A content-equal replay short-circuits BEFORE the store
   *  (vault convergence: a bare update is v+1 per call, so the second replay
   *  must never write). tags/hits ride update verbatim; the reply is the
   *  structured {ok, message} verdict. */
  memoryEdit(id: string, content: string): Promise<{ readonly ok: boolean; readonly message: string }>;
  /** 永续 v6 wave2（reef C1）：门控自改进面（PROTOCOL "improvementFace"）——
   *  失败指纹 persisting 触发的改进提案，两道人工门（list 拉全部记录卡；
   *  consent=同意生成[第一道]、ignore=忽略触发、activate=激活规则[第二道]、
   *  reject=驳回留档、undo=撤销已激活）。决策幂等收敛（重放/二次点击走
   *  「可能已处理过」MISS 形——与 memoryDecide 同律）。Read（list）never
   *  vaulted；五个决策是写副作用，VAULTED（恰好一次）。 */
  improvementFace(action: "list" | "consent" | "ignore" | "activate" | "reject" | "undo", id?: string): Promise<ImprovementFaceResult>;
  /** The away recap: what landed in THIS session's history
   *  since the viewer's mark (an index into the history channel the web
   *  mirrors 1:1). Read-only bypass — no history/state.messages writes, no
   *  permission pipeline, runnable mid-run (the btw lane's law). Returns
   *  stats (counted from structured history, never model-made) plus, when a
   *  narrative is possible, one tiny background model call through the title
   *  seam (own system prompt, zero shared prefix bytes, querySource "recap");
   *  any model failure degrades to stats-only (honest, never fabricated).
   *  Undefined = zero action: session mismatch, stale/invalid mark, below
   *  the ≥3-new-messages gate, or nothing assistant-shaped to summarize. */
  recap(sessionId: string, sinceMark: number, sinceTs?: number): Promise<RecapPayload | undefined>;
  /** ω99-316: /btw 侧问（PROTOCOL "sideQuestion"）— 主任务跑着时旁路问一
   *  句、不写回主会话。detached loop：克隆请求时刻的主投影（半截消息净化
   *  掉）构造独立 State 跑 core runAgentLoop（maxTurns=3），同表封禁（工具
   *  声明字节同一、execute 全部冻结）+ <side_question> 信封 + reasoning_effort
   *  同传。绝不触碰 session AgentState/JSONL/store（M24）；每轮重克隆最新主
   *  投影、早前侧问轮次追加其后。sessionId 比对 closure 会话（不匹配拒——
   *  旁路 fork 的是这个会话的前缀，不是任意会话的）。空文本拒。 */
  sideQuestion(sessionId: string, text: string): Promise<SideQuestionResult>;
  /** M74-ide §1: the file panel's directory listing (PROTOCOL "fileTree") —
   *  one level of the workspace-relative directory ("" = root), dirs first
   *  alphabetically then files, dotfiles + the hidden list marked hidden:true
   *  (the CLIENT filters). Data-panel op: no permission pipeline, but the
   *  same workspace containment as read_file; sensitive directories (.git,
   *  .ssh, .env*, credentials*) answer with empty entries (spec §5). */
  fileTree(path: string): Promise<FileTreeResult>;
  /** M74-ide §1: the file panel's read (PROTOCOL "fileRead") — UTF-8 content
   *  with the 1MB limit / 100KB prefix, extension-derived language, and
   *  binary sniffing. STRICTER than the agent's read_file: sensitive paths
   *  (anything inside .git or .ssh, and .env/credentials-prefixed names, at
   *  any depth) reject with "sensitive path" — the data panel must not read
   *  key material. */
  fileRead(path: string): Promise<FileReadResult>;
  /** 高亮/编辑 spec §3: the viewer's save (PROTOCOL "fileWrite") — see
   *  fileWriteContent for the guard order and the CAS semantics. */
  fileWrite(path: string, content: string, base: string): Promise<FileWriteResult>;
  /** ω99-314: 文件级时光机——把指定文件恢复到指定快照（PROTOCOL
   *  "fileRevert"，改动面板「恢复到这里」的引擎）。守卫序（CodeWhale
   *  钉死答案）：①活跃回合 busy 拒（286 同判据）；②pre-restore 安全快照
   *  （恢复前旧内容再落一份——恢复本身可撤销）；③哈希核验：当前文件 sha ≠
   *  索引最新 afterSha（用户手改过）→ 不拒但 stale:true 回执明示；④blob
   *  缺席（LRU 淘汰/删仓）→ typed 拒「快照已被清理」。写入走原子写
   *  （tmp+rename）。 */
  fileRevert(path: string, sha: string): Promise<FileRevertResult>;
  /** workspace-ux B1: switch the file panel's view root (PROTOCOL
   *  "panelRootSet") — stat-validated exists-and-directory, then panelRoot
   *  moves and the pick lands in the recents file (the same store the
   *  recentWorkspaces op reads). NEVER touches the agent root or the
   *  session: busy-safe by design, it is only a view root (the run keeps
   *  its own footing). */
  panelRootSet(path: string): Promise<PanelRootSetResult>;
  /** workspace-ux B1: the dual-root snapshot (PROTOCOL "agentRootStatus") —
   *  panelRoot (the view) vs agentRoot (the LIVE workspaceRoot, cwd
   *  fallback) and whether they still agree. */
  agentRootStatus(): Promise<AgentRootStatusResult>;
  /** workspace-ux B2: switch the agent's workspace root (PROTOCOL
   *  "agentRootSwitch") — the confirm-card action behind panelRootSet. Idle →
   *  applies NOW ({applied:true}); busy → parks until the run's settle seam
   *  ({queued:true} — the in-flight run keeps the OLD root throughout).
   *  Landing = the driver's switchable root (the builtin file tools'
   *  boundary, shell's cwd — through agentRootBox — plus the FileChanged
   *  watchers and this driver's file-shaped reads) + a history notice + a
   *  `<workspace_changed>` MetaNote on the next first model call. The system
   *  prompt, the session id, and every .wudao anchor are NEVER touched. */
  agentRootSwitch(path: string): Promise<AgentRootSwitchResult>;
  /** M76-ux2 §8: the ctx hover's breakdown (PROTOCOL "ctxInfo") — the
   *  serialized prompt's section estimates (system / tool schemas / messages)
   *  plus availableTokens against the configured context window. Read-only
   *  data op over LIVE state: no permission pipeline, no snapshot caching —
   *  the reply always reflects what the NEXT model call would serialize. */
  ctxInfo(): Promise<CtxInfoResult>;
  /** M53 §3: the statusline JSON contract's single data source — a pure
   *  fold of the live status snapshot + the caller's identity meta. */
  snapshotForStatusline(): StatuslineSnapshot;
  /** Fresh session: empty history/messages, dropped steering queue, reset
   *  watermarks, cleared plan review. Does NOT rotate the session id
   *  (frontends own that display/persistence identity — see setSessionId).
   *  The ROUTED /clear (submit("/clear"), M80) is the driver-owned variant:
   *  the same wipe PLUS the fresh-segment id rotation, the clear_boundary
   *  marker on the old id's JSONL, and the onSessionCleared /
   *  onHistoryReplaced seams — frontends that submit "/clear" verbatim (the
   *  web, Slack) get the whole clear from the driver alone. */
  clear(): void;
  /** Rotate the session id (the /clear + fresh-id convention). */
  setSessionId(sessionId: string): void;
  /** Swap the whole conversation (the /resume picker's load): seeds
   *  state.messages, resets the rendered history to the resumed index
   *  projection, zeroes the watermarks, and adopts the session id. */
  loadHistory(messages: readonly AgentMessage[], sessionId: string): void;
  /** Append a notice entry to the history (help text, feedback lines). */
  notify(text: string): void;
  /** Queue a system-class note for the MODEL (MetaNote channel; the persisted
   *  history stays clean). Used by /rewind's files-rewound notice. */
  pushMetaNote(text: string): void;
  /** M42 §3: set the runtime permission mode — the next tool call's gate sees
   *  it (never a startup snapshot). */
  setMode(mode: Mode): void;
  /** Park a permission ask through the SAME suspension the run gate uses —
   *  the seam a frontend's secondary gates (e.g. the task tool's subagent
   *  gate) surface their "ask" decisions with. Resolved by answerPermission
   *  (or a deny on interrupt). M45: ctx.sidecarReason rides the parked ask
   *  (sidecar escalations surface their reason in the prompt). */
  ask(toolName: string, input: Record<string, unknown>, ctx?: { readonly sidecarReason?: string }): Promise<PermissionDecision>;
  /** Resolve a parked permission ask (driver-level asks only). Returns false
   *  when nothing is parked. `allow` runs the tool; a deny feeds the reason
   *  back to the model as the tool result. 0.3.14 #1: `scope` carries the
   *  web menu's session/always answer (absent = allow once); the rule lands
   *  through the onAskRule sink when the owner wired one. */
  answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): boolean;
  /** 借鉴弧 α2（CC 2.1.269 思想）— recall ONE still-queued steering message.
   *  CAS semantics: removes `queue[index]` iff it still equals `text` (both
   *  from the same status frame); an entry already consumed by the loop's
   *  mid-run drain (or started as the settle follow-up run) is gone from the
   *  array → false. User lane only — the system/cron/peer lanes are not the
   *  user's words and are never recallable. Before-flush recall costs zero
   *  tokens and zero history bytes (M24-clean). */
  recallSteer(index: number, text: string): boolean;
  /** 借鉴弧 ζ2（Amp Restack 思想）— /restack 的数据缝：读当前会话 JSONL
   *  的命令级归因（ω99-319 条目），把它与工作区未提交改动重组成干净的提
   *  交序列计划。`"preview"` 只出预览通知；`"apply"` 按预览执行（只 git
   *  add 显式列出的文件、带 pathspec 提交、绝不 force；未归因文件诚实报
   *  告并跳过；有已暂存改动或运行中一律拒做）。通知走 history 通道。 */
  restack(mode: "preview" | "apply"): void;
  /** M63-B: park a system-authored steering text (FileChanged delivery) —
   *  the same queue user steers use; drained before the next model call. */
  steer(text: string): void;
  /** M24: the frontend's cache-tracking model reports the session-cumulative
   *  hit percent here (rendered in the status bar / web status line). */
  setCachePercent(percent: number | null): void;
  /** M45 §1.6: toggle the 🛡 检查中 badge on every busyTools entry named
   *  toolName — the sidecar layer calls this around each classifier check so
   *  the display shows the gate in flight without waiting on it. Also the
   *  status-snapshot poke when verdict counters change. */
  setGating(toolName: string, on: boolean): void;
  /** M49 §4: the taint probe — returns the source when the given tool
   *  arguments embed taint-tracked content (user-file / MCP bytes seen in
   *  this session's tool results). The sidecar layer feeds the verdict into
   *  the classifier input's [untrusted] note. */
  taintProbe(input: Record<string, unknown>): string | undefined;
  /** React-lifecycle seam (the adapter's mount effect): inactive suppresses
   *  emissions and aborts the in-flight run — the mirror of the hook's unmount
   *  cleanup, so a late tool resolution can neither notify a dead tree nor
   *  leak an unhandled rejection. */
  setActive(active: boolean): void;
  /** Permanent teardown: stop the bg poll. */
  dispose(): void;
}

// ω99-233: #1 — auto 档模型侧引导：permission_mode MetaNote（用户四指令 ③
// 「开了auto模式，还是反复询问用户的问题」的模型侧病根）。226 把权限层 auto
// 真化（静态层放行 + sidecar 审计），但模型侧零引导——buildSystemPrompt 无
// mode 参且 session 冻结（session-engine 一次性传入 createAgentDriver），
// setMode 此前只设变量+emit+peer tier，模型不知道托付已发生，仍在回复里反
// 复向用户提问。本弧把模式语义对模型一等公民化（超越点，写此存照）：档位不
// 只是权限管线参数，也是行动契约——进 auto = 显式托付（自主决策 + 三例外停
// 问边界 (a)(b)(c)）；出 auto = 姿态恢复声明。行业对照（CC permission
// modes）模型侧同样盲，本设计超越该盲区。信封走 <workspace_changed> 同款
// MetaNote（随下次首个模型调用冲刷、投影面零持久化——append-only 单次注入，
// M24 缓存零代价）；两个触发点全覆盖：boot 播种（session 以 auto 起步，见
// metaNotes 声明处的播种）+ setMode 注入（运行中切换，web/TUI cycle 都汇
// controls.setMode 单点）。其余档间互切不注入（权限面自明 + PLAN_DENY_REASON
// 已自解释，v1 不扩）；两形只进 MetaNotes（模型可见），不进 appendHistory
