// M43-A §1 — AgentDriver: the framework-agnostic frontend logic, extracted
// verbatim from tui/use-agent.ts. One driver owns one conversation: it drives
// the loop, maps events to HistoryEntry[] (the append-only channel), keeps a
// small full-snapshot status (the state channel — NEVER containing history,
// so a streaming delta cannot fan out O(history) payloads), parks permission
// asks, owns the runtime mode, and exposes the ops every frontend submits
// through. React (the TUI) is a useSyncExternalStore adapter over this class;
// the WS server (wudao ui) is another consumer.
import { truncateSafe, truncateTailSafe } from "@wudao/core"; // 113-A4
import { open, readFile, readdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { runAgentLoop, resolveWorkspacePath, repairOrphanedToolCalls, parseTodoBoard, estimateTokens, estimateTokensBreakdown, toModelToolDefinition, createJsonlSessionStore, applySummaryMarkers, manualCompact, compactionRetentionFor, branchSummaryNote, chainForTurn, commonPrefixLength, forkPredatesCompaction, listBranchLeaves, nodeKey, renderBranchTree, activeBranchLeafKey, resumeChain, SUMMARY_MARKER, replaceSystemPrompt, sessionLeaseBoxFor, SESSION_ID_RE, readStateEntry, inspectToolInput, isValidImageBlock, isValidFileBlock, clearTier, isQuotaParkError, createStreamPreemptChannel, microcompact, cumulativeModifiedFiles, activeToolsOf, worldStateDiff, goalTokensTotal } from "@wudao/core"
import type { AgentHooks, AgentMessage, AgentState, FileHistory, IdentifiedOutputDelta, LoopEvent, LoopOptions, ModelClient, NotificationKind, PermissionDecision, ReadStateTable, SessionLeaseBox, SessionStartSource, Terminal, Tool, ImageBlock, FileBlock, SpoofInspection, RosterPluginAgent, StreamPreemptChannel, WorldState } from "@wudao/core";
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
import { resumeEntries, resumeEntriesAnchored, receiptAnchorsFromEntries, receiptNoticesFromEntries } from "../tui/resume.js";
import type { ReceiptAnchor } from "../tui/resume.js";
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
import { fireResumePrewarm } from "../resume-prewarm.js";
import { runRestack } from "../restack.js";
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
// M-Memory 弧第二半 — /memory 新动词面（长期记忆；旧动词回落上方 M49 面）。
import { longtermMemoryRuntimeFor, runLongtermMemoryVerb } from "../longterm-memory.js";
// ω99-260: 面一 — the memory faces' data seam: the PHYSICAL store handle (the
// memory_write tool's own anchor, session-engine :1210's store — management
// stays usable even when recall is off; openSessionMemoryStore is NOT used
// here by ruling: memoryEnabled 关闭≠面板锁死).
import { openMemoryStore } from "../memory/store.js";
import { createMemorySignatureTracker } from "./memory-signature.js";
import type { MemoryEntry } from "../memory/store.js";
import { blockedLearningCountAt } from "../memory/guard.js"; // 永续 v6 弧 A：被拦学习输入计数（memoryList.blocked）
import { runRefineCommand } from "../memory/refine.js";
import { refineAutoRuntimeFor, observeAutoRefineOnHooks } from "../memory/auto-refine.js";
import { spawnBackgroundReview, REVIEW_MIN_TOOL_CALLS, neuterWriteTools } from "../memory/review.js";
// ω-4f (design 84): Dream consolidation — stage 2 (ledger→curated ledger).
import { spawnDreamRun } from "../memory/dream.js";
// 永续 v6 wave2（reef C1）：门控自改进——触发器（收束缝）+ 提案/决策面。
import { maybeOfferImprovements } from "../improve/trigger.js";
import { listImprovements, readImprovement, writeImprovement, withStatus, toImprovementWire, activateImprovement, undoImprovement, type ImprovementFaceResult } from "../improve/store.js";
import { consentToGenerate } from "../improve/propose.js";
import { runSessionSearch } from "../session-search.js";
import { createTaintTracker, argsCarryTaint } from "../taint.js";
import { buildContextReport, formatContextReport } from "../context-report.js";
// PB-2（探针基础设施弧）— /probe 的读面渲染（进程内 bus 单例，与 REPL 同源）。
import { formatProbeReport, parseProbeArgs, getDefaultProbeBus } from "../probe.js";
import { buildStatuslineSnapshot } from "../statusline.js";
// ω99-253 (see git-branch.ts for the cost discipline and null semantics).
import { readGitBranch } from "../git-branch.js";
import type { StatuslineSnapshot } from "../statusline.js";
import { isFeatureAblated } from "../args.js";
import { buildActiveBranchEntry, buildClearBoundaryEntry, buildRewindTurnEntry, windowChainFromEntries } from "../session-entry.js";
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
import { applyWirePersona, outputLimitEscalateFor, resolveContextWindowTokens, catalogPricesFor } from "@wudao/providers";
import { loadEffectiveProfiles, resolveSessionCachePricing } from "../provider-registry.js";
import { coldCacheResumeDecision } from "../cache-clock-ledger.js";
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
import { VERSION } from "../version.js";
import { getCompactInstructionsRider } from "../project-context.js";
// workspace-ux B1: the recents write behind panelRootSet (settings-ops owns
// the store; its AgentDriver/UiDriverPort imports are type-only, so this
// runtime import cannot cycle back).
import { recordRecentWorkspace } from "./settings-ops.js";
// M61 §1: the in-session scheduler runtime (cron tools + fire-on-idle).
import type { CronRuntime } from "../cron.js";
// 113-B3 — the quota-park policy件 (constants, the JSONL attribution row,
// the wake-injection codec, the user-facing copy). Behavior wiring below.
import {
  QUOTA_PARK_MAX_PER_SESSION,
  QUOTA_PARK_REARM_CAP,
  QUOTA_PARK_REARM_MS,
  QUOTA_PARK_RESET_HORIZON_MS,
  QUOTA_PARK_WAKE_MARGIN_MS,
  countQuotaParkEntries,
  formatQuotaGiveUpNotice,
  formatQuotaParkNotice,
  quotaParkEntry,
  quotaWakeOf,
  quotaWakePrompt,
} from "./quota-park.js";
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
import { createGoalRuntime, GOAL_BUDGET_SALVAGE_PROMPT } from "../goal-runtime.js";
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
import { extractFileReceipt } from "./file-receipt.js";
// v7 γ2——运行终态留名：成因词表（回执行 + 指纹账）。
import { interruptedNotice, describeRunEndCause, type RunEndCause } from "../run-end-cause.js";
import { appendFailureEvent, buildObservedEvent, failureFingerprintPath } from "../failure-fingerprints.js";

// —— ω99-326a 模块拆分桥（re-export 门面：importer 与测试的既有路径零演进）——
export type {
  HistoryEntry, LiveState, RuleGate, PendingPermission, FileTreeEntry, FileTreeResult,
  FileReadResult, FileWriteResult, FileRevertResult, BranchLeaf, MemoryEntryMirror,
  CtxInfoResult, PanelRootSetResult, AgentRootStatusResult, AgentRootSwitchResult,
  DriverStatus, DriverPersonaContext, AgentDriverOptions,
} from "./types.js";
export type { SubmitOutcome, DriverExtensionSwap, ResumeOutcome, AgentDriver } from "./contract.js";
export { notePreview, formatMs, formatRunStats } from "./format.js";
export { modeSteeringNote } from "./mode-steering.js";
import type {
  HistoryEntry, LiveState, RuleGate, PendingPermission, FileTreeEntry, FileTreeResult, MemoryEntryMirror,
  FileReadResult, FileWriteResult, FileRevertResult, BranchLeaf, CtxInfoResult,
  PanelRootSetResult, AgentRootStatusResult, AgentRootSwitchResult, DriverStatus,
  DriverPersonaContext, AgentDriverOptions,
} from "./types.js";
import type { SubmitOutcome, DriverExtensionSwap, ResumeOutcome, AgentDriver } from "./contract.js";
import {
  EMPTY_LIVE, BUSY_TAIL_CAP_CHARS, DIFF_CAP_CHARS, BG_STATUS_POLL_MS, CRON_POLL_MS,
  DELTA_EMIT_INTERVAL_MS, str, isAbortError, newSessionId, SOFT_IDLE_WARN_NOTICE,
  notePreview, formatMs, formatRunStats,
} from "./format.js";
import {
  readExistingForDiff, HIDDEN_ENTRY_NAMES, FILE_READ_LIMIT_BYTES, FILE_READ_PREFIX_BYTES,
  FILE_WRITE_LIMIT_BYTES, FILE_WRITE_CURRENT_PREFIX_BYTES, BINARY_EXTENSIONS, LANGUAGE_BY_EXTENSION,
  isHiddenEntryName, isSensitiveRelPath, relWithinWorkspace, fileTreeListing, fileReadContent,
  fileWriteContent, capDiff, sameAgentRoot, lastAssistantAnswer,
} from "./fs-panels.js";
import { AUTO_MODE_CONTRACT, modeSteeringNote } from "./mode-steering.js";
// 借鉴弧 δ（penguin-harness 367ab084 思想）— 运行中工具调用转后台的车道。
import { createDetachLane, describeDetachVerdict, backgroundedNotice, type DetachVerdict } from "./detach-lane.js";
// 124b 项 1：流抢占的旁路审计（不进会话 JSONL/模型所见——见该件头注）。
import { appendStreamPreemptAudit } from "./stream-preempt-audit.js";
// 拆分运动（弧 δ 顺带件）：五条同形空闲轮询缝（cron/peer/monitor/childMail/
// detach）的公共工厂。
import { createIdleSeam, createStatusPoll } from "./idle-seam.js";

export function createAgentDriver(opts: AgentDriverOptions): AgentDriver {
  // Runtime-mutable truth (the hook's refs). The snapshot objects handed out
  // are rebuilt only on emit, so subscribers can use reference equality.
  let live: LiveState = EMPTY_LIVE;
  // #302 (0.3.29): how far into live.reasoning has already ridden a committed
  // history entry (flushed segments carry their call-window slice; the run-end
  // reply carries the rest). Reset with `live` at each submit.
  let reasoningMark = 0;
  // ω99-41: streaming text accumulates in chunk buffers (O(1) per delta) and
  // folds into `live` only at observation seams — emit()/flushAssistantSegment()
  // materialize before any read; the epoch resets below wipe buffer+live in
  // pairs. The old per-delta full-string spread (answer/reasoning + ev.text)
  // rebuilt the whole string (and the object) on every token: quadratic churn
  // on long replies, while live's observers only ever sample it at (throttled)
  // emit time.
  const answerBuf = createTextBuffer();
  const reasoningBuf = createTextBuffer();
  let pendingThinking: boolean | undefined; // undefined = no delta since the last fold
  // materialize：把缓冲一次性 fold 进 live。所有 live 文本读点之前必须先跑。
  const materializePending = (): void => {
    const a = answerBuf.takeJoined();
    const r = reasoningBuf.takeJoined();
    if (a === "" && r === "" && pendingThinking === undefined) return;
    live = {
      ...live,
      ...(a !== "" ? { answer: live.answer + a } : {}),
      ...(r !== "" ? { reasoning: live.reasoning + r } : {}),
      ...(pendingThinking !== undefined ? { thinking: pendingThinking } : {}),
    };
    pendingThinking = undefined;
  };
  // #302: assistant messages whose prose already landed in history as an
  // interleaved segment — dedupes the multi-tool / deferred re-emit paths.
  const committedAssistantSegments = new WeakSet<AgentMessage>();
  let busy = false;
  // ω99-314: 快照目录（守卫 3 的比对基准）——每文件最新 afterSha，按文件序
  // last-wins。settle 时随索引行更新；resume/boot/loadHistory 从持久
  // file_snapshot 条目重建（snapshotIndexFromEntries → latestAfterShaByPath）。
  // key = 与收据行同形的 workspace 相对路径（posix 分隔）。
  const snapshotCatalog = new Map<string, string>();
  /** ω99-314: 目录的重建入口（三处回放缝共用）——条目读侧纯函数 + 文件序
   *  last-wins 覆盖（后到的恢复/settle 记录天然盖过旧的）。 */
  const rebuildSnapshotCatalog = (entries: readonly import("@wudao/core").SessionEntry[]): void => {
    const next = latestAfterShaByPath(snapshotIndexFromEntries(entries));
    if (next.size === 0 && snapshotCatalog.size === 0) return;
    for (const [k, v] of next) snapshotCatalog.set(k, v);
  };
  // ω99-249: the GoalState runtime's LATE-BOUND view — the runtime itself is
  // created near the driver tail (it needs sessionStore/sessionId seams that
  // only exist there), but buildStatus snapshots on every emit from the
  // factory prefix on, so the status reads through this ref (goalBox's
  // discipline, inverted). webSnapshot is a PURE read — no transitions.
  const goalRuntimeRef: { current?: GoalRuntime } = {};
  // 夜移 005: the auto-title attempt fires at most once per driver lifetime
  // (success OR failure — no retry loops on a background best-effort).
  let titleTried = false;
  let queued: string[] = [];
  let boardProgress: { done: number; total: number } | null = null;
  let ctxTokens: { used: number | null; window: number; nearLimit: boolean } | null = null;
  let cachePercent: number | null = null;
  let pendingPermission: PendingPermission | null = null;
  // 夜移 028 (CCB preventSleep): hold a macOS power assertion exactly while
  // the driver is ACTIVELY working — `busy && pendingPermission === null`.
  // A run parked on a human permission dialog does NOT hold it (dialogs sit
  // for hours; sleep prevention is for unattended runs). The guard composes
  // across every driver in this process via the shared refCounted
  // controller; release is debounced so the settle→queue-drain seam between
  // back-to-back runs never churns the assertion. The default singleton is
  // env-gated off for the test environment.
  const powerGuard = createSleepGuard();
  // M37 §1: the plan board awaiting review + the flag marking the run that
  // will produce it (consumed at its completion seam).
  let planBoard: string | null = null;
  let planRun = false;
  // ω99-51 (session projection seam): the todo domain's shared source — the
  // plan-review seam below reads it INSTEAD of the lastTodoBoard backscan
  // (byte-equal by construction; docs/research/106-*.md). Fed live at every
  // tool_call_finished; array-reference resync covers load/rewind/compaction
  // replacement/branch switch without further wiring.
  const todoSource = createTodoBoardSource();
  // workspace-ux B1: the file panel's VIEW root. Starts at the agent root
  // (opts.workspaceRoot, cwd when absent) and moves ONLY through panelRootSet
  // — deliberately decoupled from o.workspaceRoot so the panel can re-root
  // without disturbing the session (the agent tools, shell cwd, and the
  // session store keep reading o.workspaceRoot; the agent-root switch is B2's
  // own op). fileTree/fileRead resolve every path against this root.
  let panelRoot = opts.workspaceRoot ?? process.cwd();
  // workspace-ux B2: the agent's SWITCHABLE workspace root — what the builtin
  // file tools resolve against, where shell runs, and what this
  // driver's file-shaped reads (diff previews, git-risk warnings, /init's
  // AGENTS.md probe) use. Starts at opts.workspaceRoot (cwd when absent) and
  // moves ONLY through agentRootSwitch — idle immediately, busy at the run's
  // settle seam (see pendingAgentRoot). o.workspaceRoot stays the SESSION
  // anchor (the JSONL store, spill, settings/memory writes) — the workspace
  // root is not a session concept, so the switch never touches any of those.
  let agentWorkspaceRoot = opts.workspaceRoot ?? process.cwd();
  // ω99-253: #3 — the branch face's cached read (declared with the
  // workspace-root family it belongs to). The VALUE rides DriverStatus
  // verbatim; the read itself runs at exactly three seams — boot (below,
  // once), the run-settle boundary, and applyAgentRoot (an idle/parked
  // agent-root switch moves the root the branch describes). Fire-and-forget
  // with a monotonic seq (last-issued read wins; an out-of-order landing is
  // dropped); a value CHANGE re-emits, an unchanged re-read stays quiet; a
  // failure resolves null and never throws into the main chain. The emit
  // path itself NEVER spawns — buildStatus only reads this variable.
  let gitBranch: string | null = null;
  let gitBranchSeq = 0;
  const refreshGitBranch = (): void => {
    // The root gate: a stub driver without a workspaceRoot reads nothing
    // (zero spawns in tests/headless lanes); the read follows the LIVE
    // agent root — the same root the 224 workspace anchor shows.
    if (o.workspaceRoot === undefined) return;
    const seq = ++gitBranchSeq;
    void gitBranchReader(agentWorkspaceRoot).then(
      (name) => {
        if (seq !== gitBranchSeq) return; // superseded by a later read
        if (name === gitBranch) return; // unchanged — no frame
        gitBranch = name;
        emit();
      },
      () => {
        if (seq !== gitBranchSeq) return;
        if (gitBranch === null) return;
        gitBranch = null; // a failed re-read degrades to the null face
        emit();
      },
    );
  };
  const gitBranchReader = opts.gitBranchReader ?? readGitBranch;
  // The session name's cached face (the same discipline as the branch read
  // above: the VALUE rides DriverStatus verbatim; the emit path only ever
  // reads the variable). Knowledge lands at: the boot/resume read (inside
  // the receipt-replay IIFE below — the SAME loadSessionEntries, zero extra
  // file IO), the auto-title fork (its appendEntry landed → the title IS the
  // newest truth), /rename's landing, and any wholesale swap / id rotation
  // (the name belongs to the session id — a swap or clear never carries the
  // old session's name over). A monotonic seq keeps the last knowledge
  // standing: a superseded read lands silently, and every direct write
  // invalidates in-flight reads. Unchanged values never re-emit.
  let sessionName: string | null = null;
  let sessionNameSeq = 0;
  const setSessionNameCached = (name: string | null): void => {
    sessionNameSeq += 1; // direct knowledge — supersedes any in-flight read
    if (name === sessionName) return; // unchanged — no frame
    sessionName = name;
    emit();
  };
  const refreshSessionName = (): void => {
    if (sessionStore === undefined && o.workspaceRoot === undefined) return; // no store — nothing to read
    const seq = ++sessionNameSeq;
    const id = sessionId;
    void (async () => {
      try {
        const store = sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions"));
        const named = sessionNameSource(await store.loadSessionEntries(id));
        if (seq !== sessionNameSeq) return; // superseded by newer knowledge
        setSessionNameCached(named === undefined ? null : named.name);
      } catch {
        /* best-effort — a failed read keeps the current face */
      }
    })();
  };
  let mode: Mode = opts.mode ?? "workspace";
  let sessionId = opts.sessionId ?? newSessionId();
  // 125 项 1/项 2（codex 窗口链/WorldState 差分）— the session's window-chain
  // bookkeeping, rebuilt from the session entries at boot/resume (the
  // windowChainFromEntries 同族读取) and advanced at every compact boundary
  // this process lands. windowBoundaryCount = compact_boundary rows so far
  // (the next rotation opens at count+1, even for pre-125 rows that carry no
  // windowIndex — the count IS the chain); lastWorldSnapshot = the last
  // boundary's world snapshot (the next rotation's diff baseline; undefined
  // until a boundary carried one).
  let windowBoundaryCount = 0;
  let lastWorldSnapshot: WorldState | undefined;
  /** 125 项 2: the driver-side WorldState extractor — the mechanical face the
   *  spec pins (GoalState + 文件台账 + 活跃工具), a pure read of the live
   *  goal runtime and the message chain. Called at rotation time (auto: the
   *  loop's snapshot callback; manual: the /compact path) so the snapshot
   *  describes the window being CLOSED. */
  const worldStateSnapshot = (): WorldState => {
    const goal = goalRuntimeRef.current?.snapshot();
    return {
      ...(goal !== undefined
        ? {
            goalSummary: goal.objective.length > 80 ? `${truncateSafe(goal.objective, 79)}…` : goal.objective,
            goalBudgetUsed: goalTokensTotal(goal.tokensUsed),
          }
        : {}),
      changedFiles: cumulativeModifiedFiles(state.messages),
      activeTools: activeToolsOf(state.messages),
    };
  };
  // Every id change routes through here so the optional hook box never goes stale.
  const setSessionId = (id: string): void => {
    sessionId = id;
    if (sessionIdBox !== undefined) sessionIdBox.current = id;
    // #48: the lease follows the id (/clear's fresh id, a fork's new id) —
    // the old session's lock is released so another process may take it.
    sessionLeases?.rotate(id);
    // ω99-316: side turns are session-scoped — a new session's side lane
    // starts clean (prior side turns from the old session never ride into
    // the new one's /btw projections).
    sideTurns = [];
    // 125 项 1/项 2: the window chain is session-scoped — a fresh id starts a
    // fresh chain (resume() rebuilds from the adopted session's entries right
    // after its loadHistoryFn swap below).
    windowBoundaryCount = 0;
    lastWorldSnapshot = undefined;
  };
  let lastPromptTokens = 0;
  let active = true;
  let disposed = false;
  // M55 §A3 (/cost): session-cumulative usage folded from every `usage`
  // LoopEvent, plus the wall-clock origin (driver creation = session start).
  let usageTotals = emptyUsageTotals();
  const startedAt = Date.now();
  // M58 §C#2: the session's standing compact-instructions rider — the WUDAO.md/
  // AGENTS.md `## Compact Instructions` section, parsed ONCE at session start
  // (driver creation) through the memoized project-context loader and woven
  // into EVERY tier-2 summary instruction this session: the loop's auto/
  // boundary/reactive compactions (loopOptions below) and the manual
  // /compact path alike. undefined = no section anywhere → status quo.
  const compactInstructionsRider = opts.workspaceRoot !== undefined ? getCompactInstructionsRider(opts.workspaceRoot) : undefined;
  // M55 §A1 (/init): the flag marking the run whose answer carries the
  // AGENTS.md draft, and the parked draft awaiting `ok` (the plan-review
  // convention — preview first, no write without confirmation).
  let initRun = false;
  let initDraft: { readonly content: string; readonly hasExisting: boolean } | null = null;
  // M51 §4 (A8): true from a compaction event until the next real usage —
  // the estimate must not repaint a number over the unknown window.
  let ctxUnknown = false;
  // M53 §1: an armed /edit — the index into state.messages where the branch
  // cuts (messages before it stay; the edited turn and everything after it
  // remain on the tree in the JSONL, but leave the active chain). The NEXT
  // plain submit consumes it (startRun), any swap/clear disarms it.
  let pendingEditCut: number | null = null;
  // P2-10 (96 队列): /rewind turn's window marker — the node key of the cut
  // parent while the active chain sits rewound to a mid-tree PREFIX (before
  // the next submit). In this window the chain does not end at a file leaf,
  // so the greatest-chain resolution used for /tree marking and /switch's
  // isCurrent would swallow the abandoned tail back into "current" — both
  // surfaces therefore switch to their window faces. The next submit (or any
  // swap/resume) clears it.
  let rewoundCutKey: string | null = null;
  // M55 §B7 (/model, /effort): the live model-state overlay (switches land
  // here so /status and the bare listings reflect them even before the
  // frontend's setOptions refresh arrives), and a switch parked while a run
  // is in flight — applied at run settle, so it takes effect NEXT turn, never
  // mid-run (a run's requests must stay provider-consistent).
  let modelLive: { provider?: string; model?: string; effort?: string } = { ...opts.sessionMeta };
  let pendingModelApply: ModelSelection | null = null;
  // ω99-316 (/btw 侧问): the side lane's accumulated transcript — each side
  // round re-clones the LATEST main projection and appends these prior side
  // turns after it (per-round re-clone: the side lane always sees the
  // freshest main context). Reset with the session (setSessionId) — side
  // turns are session-scoped, never persisted, never main-visible.
  let sideTurns: AgentMessage[] = [];
  // Side runs serialize on this chain — two concurrent /btw submissions must
  // not interleave their snapshots (each still clones the main state at ITS
  // submit time; the chain only orders the detached loops themselves).
  let sideLane: Promise<unknown> = Promise.resolve();
  const enqueueSideQuestion = (question: string): Promise<SideQuestionRunResult> => {
    // Atomic MAIN snapshot at submit time — the honest edge: a mid-run answer
    // being streamed (assistant pushed, tool results pending) is sanitized
    // OUT of the projection, never half-included.
    const systemPrompt = state.systemPrompt;
    const messages = [...state.messages];
    const tools = [...state.tools];
    const model = o.model;
    const effort = modelLive.effort;
    const start = (): Promise<SideQuestionRunResult> =>
      // priorTurns read at RUN START (the chain serializes: every earlier
      // round's turns have landed by then) — NOT at enqueue, so a queued
      // follow-up still sees the round that preceded it.
      runSideQuestion({
        question,
        systemPrompt,
        messages,
        priorTurns: [...sideTurns],
        tools,
        model,
        ...(effort !== undefined && effort !== "" ? { reasoningEffort: effort } : {}),
      });
    const p = sideLane.then(start, start);
    // Land this round's turns INSIDE the chain (before the promise the
    // caller awaits resolves) — the next queued round's priorTurns read at
    // start is therefore monotonic.
    const run = p.then((result) => {
      sideTurns = [...sideTurns, ...result.turns];
      return result;
    });
    sideLane = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  // 推理档三级配置 S4 (/language): the session language tier — modelLive's
  // twin. /language (or setLanguage) mutates it per-knob; the per-submit
  // seam re-folds resolveLanguagePreference(env, undefined, languageLive)
  // so the spec chain (ablation > session > settings/env) holds on EVERY
  // request, and getStatus/withSettingsOps surface the fold
  // (gateStatus.language on the wire).
  let languageLive: Partial<LanguagePreference> = { ...opts.languagePreference };
  const languageFold = (): LanguagePreference => resolveLanguagePreference(process.env, undefined, languageLive);
  // M63 §A: a provider switch parked behind a busy run — the resolved target
  // config awaits the run's settle (the next turn boundary); `build` runs
  // there, never mid-run, and the entry write rides the same success gate
  // (a build that throws at settle leaves the JSONL untouched). `modelInFlight`
  // is the mid-stream guard: a switch submitted while a model call is
  // STREAMING is refused outright (spec §A 流式中禁止), not queued — except
  // the 0.3.33 same-name key refresh (settings-originated, endpoint-
  // preserving), which parks like any busy-run switch and lands at settle.
  let pendingProviderApply: {
    readonly config: import("@wudao/providers").ProviderConfig;
    readonly provider: string;
    readonly model: string;
    readonly from?: string;
    readonly writeEntry: () => void;
  } | null = null;
  let modelInFlight = false;
  // cc-plugins A3: an extension rescan parked behind a busy run — applied at
  // run settle (never mid-run: an in-flight run's requests keep their prompt
  // and hook bytes). Successive parks merge, later fields winning.
  let pendingExtSwap: DriverExtensionSwap | null = null;
  // 夜移 018 (延迟预取 wudao 适配): late-arriving tools (deferred MCP load)
  // parked behind a busy run — appended at run settle, order-preserved.
  // Same discipline as pendingExtSwap: the in-flight request's tool bytes
  // are frozen for the run's lifetime (the within-run M24 invariant).
  let pendingTools: Tool[] = [];
  const landTools = (list: readonly Tool[], atSettle: boolean): void => {
    if (list.length === 0) return;
    state.tools = [...state.tools, ...list];
    o = { ...o, tools: [...o.tools, ...list] };
    appendHistory({
      kind: "notice",
      text: `↳ 工具已加载：${list.map((t) => t.name).join(", ")}（一次性工具集变更${atSettle ? " —— 运行收束时落地；下一轮带上它们" : ""}）`, // ω99-166f-iii: #1
    });
  };
  const applyExtSwap = (ext: DriverExtensionSwap): void => {
    o = {
      ...o,
      ...(ext.skills !== undefined ? { skills: ext.skills } : {}),
      ...(ext.pluginCommands !== undefined ? { pluginCommands: ext.pluginCommands } : {}),
      ...(ext.pluginAgents !== undefined ? { pluginAgents: ext.pluginAgents } : {}),
      ...(ext.hooks !== undefined ? { hooks: ext.hooks } : {}),
    };
    // setOptions can never land a prompt: the loop reads STATE. The swap is
    // the ONE seam that may rewrite it (idle, or at run settle) — through
    // core's sanctioned rewriter, which documents the tail-only contract.
    if (ext.systemPrompt !== undefined) replaceSystemPrompt(state, ext.systemPrompt);
  };
  // workspace-ux B2: an agent-root switch parked behind a busy run — the
  // validated path awaits the run's settle seam (the same turn boundary the
  // parked /model and /provider switches land at), then applyAgentRoot runs
  // BEFORE the follow-up drain so the next run starts on the new root. Last
  // write wins; an interrupted run still settles it (the user's confirmed
  // switch must not silently vanish).
  // P1-7 (96 队列): the slot is now {path, extRescan} — agentRootSwitch parks
  // {extRescan:false} (byte-stable); a /worktree enter/exit parks
  // {extRescan:true} so the extension face rescans at the switched root.
  let pendingAgentRoot: { readonly path: string; readonly extRescan: boolean } | null = null;
  // P1-7 (96 队列): the session's main worktree (/worktree enter/exit). The
  // OPERATION root switches through the SAME applyAgentRoot seam above; the
  // SESSION anchor (o.workspaceRoot — every persistent write) NEVER moves
  // (red line 1). `activeWorktree` is the LANDED state; `pendingWorktreeOp`
  // is the bookkeeping parked behind a busy run (flips at the settle seam,
  // with the parked root switch). prevRoot is the root to switch BACK to on
  // exit — captured at enter time, immune to later re-roots.
  let activeWorktree: { readonly path: string; readonly branch: string; readonly name: string; readonly enteredAt: string; readonly prevRoot: string } | null = null;
  let pendingWorktreeOp:
    | { readonly kind: "enter"; readonly wt: { readonly path: string; readonly branch: string; readonly name: string }; readonly prevRoot: string }
    | { readonly kind: "exit-keep"; readonly wt: { readonly path: string; readonly branch: string; readonly name: string; readonly enteredAt: string }; readonly prevRoot: string }
    | null = null;
  // True from an enter's SYNC prologue until its async body resolves — the
  // git creation window where activeWorktree is still null but a second
  // enter must already be refused (no nesting through the async gap).
  let worktreeOpInFlight = false;
  // M55 §B9 (/export): a render parked because the target file exists — `ok`
  // overwrites, anything else cancels (the /init confirmation convention).
  let pendingExport: { readonly path: string; readonly content: string } | null = null;
  // M55 §C1 (/add-dir): live set of added workspace directories (not persisted in driver).
  const addedDirs: string[] = [];
  // M55 §C1: session store for recording added_dir entries (only if provided).
  const sessionStore = opts.sessionStore;

  const state: AgentState = {
    systemPrompt: opts.systemPrompt,
    messages: opts.initialMessages ? [...opts.initialMessages] : [],
    tools: opts.tools,
    status: "idle",
  };
  // M24: the tool set's probe/fork closures read through this handle at
  // execution time; fire once so the caller can wire it up.
  opts.onStateReady?.(state);

  let o = opts;
  // The memory store's content-signature face — the 253/255 cached-read
  // discipline, extracted to memory-signature.ts (the 借鉴弧 α2 rider: the
  // file-size ratchet pushes toward extraction). The tracker owns the seq +
  // the store read; the VALUE rides DriverStatus through memorySig.current().
  const memorySig = createMemorySignatureTracker({
    workspaceRoot: opts.workspaceRoot,
    emit: () => emit(), // late-bound — emit is declared below (TDZ-safe through the arrow); opts (not the mutable o) — the root never swaps
    openStore: openMemoryStore,
  });


  // SDD 2026-08-23 persona: the MANUAL layer's engagement flag (spec §1's
  // top layer — a session-local /persona <id> switch). The persona itself
  // lives in the injected runtime's current; this only answers "did this
  // session switch manually?" for the /persona list's provenance mark
  // ([manual] beats the chain marks) — --off clears it and falls back to
  // the resolution chain (env > binding > default).
  let personaManualLayerOn = false;
  // Task 3: the provider-switch seam (frontend-owned) clears the manual
  // layer through THIS slot — the flag is private to the driver closure, so
  // the driver installs the clearer onto the injected context object (both
  // at creation and on every setOptions swap that brings a bare context).
  const wirePersonaClearer = (ctx: DriverPersonaContext): void => {
    if (ctx.clearManualLayer === undefined) ctx.clearManualLayer = () => { personaManualLayerOn = false; };
  };
  if (o.persona !== undefined) wirePersonaClearer(o.persona);
  // submit() is sync, so a persona_change record is fired un-awaited — two
  // rapid switches would race their appendFile writes and could persist OUT
  // OF ORDER (the REPL awaits each record before reading the next line, so
  // it never has this problem). Serialize the writes: each record lands
  // after the previous one settles, keeping the JSONL order = switch order.
  let personaRecordChain: Promise<void> = Promise.resolve();

  // M63-A: the session-surface hook fires — one helper per surface so every
  // boundary uses the same isolation (observer semantics: a throwing or slow
  // hook never blocks the driver action that fired it; the promise is voided).
  const sessionStartHook = (source: SessionStartSource): void => {
    void (async () => {
      try {
        // cc-plugins E4 (final-review I1): the returned additionalContext
        // parks on the MetaNote projection (declared below with the prober;
        // every fire site runs after the factory body, so the closure ref is
        // safe) — it reaches the next model call, never persisted history.
        const ctx = await o.hooks?.onSessionStart?.(source, { sessionId });
        if (typeof ctx === "string" && ctx !== "") metaNotes.push({ text: ctx, source: `SessionStart 钩子（${source}）` });
      } catch {
        /* observer isolation */
      }
    })();
  };
  const notificationHook = (kind: NotificationKind): void => {
    void (async () => {
      try {
        await o.hooks?.onNotification?.(kind, { sessionId });
      } catch {
        /* observer isolation */
      }
    })();
  };
  // M63-B: the SessionEnd fire — always VOIDED (the 1.5s shared budget at the
  // bridge bounds it; teardown/clear never waits on hooks).
  const sessionEndHook = (source: import("@wudao/core").SessionEndSource): void => {
    // R1 fix: the deadline is created HERE — every composed layer (config,
    // plugins, extensions) shares this one budget instead of each minting
    // its own 1.5s window.
    const info = { sessionId, budgetEndsAt: Date.now() + SESSION_END_BUDGET_MS };
    void (async () => {
      try {
        await o.hooks?.onSessionEnd?.(source, info);
      } catch {
        /* observer isolation */
      }
    })();
    // P0-4 (96 队列): fold the session's cost rows into the cross-session
    // wallet ledger. SYNC fs (async at the teardown boundary is unreliable);
    // the registry's own flushed flag makes the repeated fires (clear /
    // resume / exit) a no-op. Telemetry — a failed flush is a notice, never a
    // teardown blocker.
    try {
      if (o.workspaceRoot !== undefined && o.costRegistry !== undefined) {
        o.costRegistry.flushToLedger(o.workspaceRoot, sessionId);
      }
    } catch (err) {
      try {
        appendHistory({ kind: "notice", text: `⚠️ cost 台账落盘失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #1 failed 回执中文化（ledger flush→台账落盘；err 三元原样）。
      } catch {
        /* appendHistory itself unavailable — nothing more to do */
      }
    }
  };
  const stopFailureHook = (kind: import("@wudao/core").StopFailureKind, message: string): void => {
    void (async () => {
      try {
        await o.hooks?.onStopFailure?.(kind, { message, sessionId });
      } catch {
        /* observer isolation */
      }
    })();
  };
  // M63-C §3: the skill-position overlay — frontmatter hooks armed at
  // invocation, in effect for the session's REMAINDER, cleared by /clear and
  // by compaction (the spec's position semantics). Entries accumulate per
  // event across invocations; the compiled overlay composes OVER the
  // session's configured hooks for every run.
  const skillHookEntries = new Map<string, readonly unknown[]>();
  let skillHooksCompiled: import("@wudao/core").AgentHooks | undefined;
  const armSkillHooks = (skill: import("../skills.js").LoadedSkill): void => {
    if (skill.hooks === undefined) return;
    for (const [event, entries] of Object.entries(skill.hooks)) {
      if (!Array.isArray(entries)) continue;
      skillHookEntries.set(event, [...(skillHookEntries.get(event) ?? []), ...entries]);
    }
    try {
      const settings = Object.fromEntries([...skillHookEntries.entries()]) as never;
      skillHooksCompiled = buildConfiguredHooks(settings, {
        // workspace-ux B2: the overlay's hooks run where the agent runs —
        // the SWITCHABLE root (cwd fallback is identical to the old shape).
        workspaceRoot: agentWorkspaceRoot,
        // M63-C R1: the FULL fire runtime — the overlay's payloads carry the
        // §2 common fields (incl. the live prompt_id), `if` gates on the
        // session mode, mcp_tool entries work, asyncRewake reaches the lane.
        ...(skillFireRuntime?.getMode !== undefined ? { getMode: skillFireRuntime.getMode } : {}),
        ...(skillFireRuntime?.common !== undefined ? { common: skillFireRuntime.common } : {}),
        ...(skillFireRuntime?.mcp !== undefined ? { mcp: skillFireRuntime.mcp } : {}),
        ...(skillFireRuntime?.rewake !== undefined ? { rewake: skillFireRuntime.rewake } : {}),
        // R6-I1: the overlay's warn output rides the history notice channel.
        warn: (m) => appendHistory({ kind: "notice", text: m }),
      }) ?? undefined;
      appendHistory({ kind: "notice", text: `🪝 技能钩子已挂载（${[...skillHookEntries.keys()].join(", ")}）——会话级，/clear 或压缩后卸载` }); // ω99-166f-iii: #2
    } catch {
      /* a broken frontmatter hooks node never blocks the skill itself */
    }
  };
  const clearSkillHooks = (why: string): void => {
    if (skillHookEntries.size === 0) return;
    skillHookEntries.clear();
    skillHooksCompiled = undefined;
    appendHistory({ kind: "notice", text: `🪝 技能钩子已卸载（${why}）` }); // ω99-166f-iii: #3
  };
  // ω99-56 — the file-edits approval gate (deslop): armed at /skill:<name>
  // invocation when the frontmatter declares `approval-gate: file-edits`,
  // disarmed by /clear. Deliberate divergence from the skill-hooks position:
  // COMPACTION does NOT clear it — a human-approval posture is fail-closed
  // state and must survive context loss (the hooks overlay is advisory; this
  // gate guards deletions). Re-invoking the skill re-arms idempotently.
  const approvalGate = createApprovalGateState();
  const armApprovalGate = (skill: import("../skills.js").LoadedSkill): void => {
    if (skill.approvalGate !== "file-edits" || approvalGate.armed) return;
    approvalGate.armed = true;
    appendHistory({
      kind: "notice",
      text: "🚧 审批门已布防（file-edits）——未获本会话批准的路径上 edit/write_file 将先询问；/clear 解除", // ω99-166c-iii: #1
    });
  };
  const disarmApprovalGate = (why: string): void => {
    if (!approvalGate.armed) return;
    approvalGate.armed = false;
    approvalGate.receipts.clear();
    approvalGate.humanSettled = null; // ω99-70: the per-call marker dies with the posture
    appendHistory({ kind: "notice", text: `🚧 审批门已解除 (${why})` }); // ω99-166c-iii: #2
  };
  const instructionsLoadedHook = (source: import("@wudao/core").InstructionsLoadedSource): void => {
    void (async () => {
      try {
        await o.hooks?.onInstructionsLoaded?.(source, {});
      } catch {
        /* observer isolation */
      }
    })();
  };
  let history: HistoryEntry[] =
    o.initialMessages && o.initialMessages.length > 0 ? resumeEntries(o.initialMessages, sessionId) : [];
  // P1-5: boot notices land BELOW the resume divider (they describe THIS
  // process's boot, not the resumed conversation's past).
  for (const notice of o.bootNotices ?? []) {
    history = [...history, { kind: "notice", text: notice }];
  }
  // 118（回合收据归位）的嫁接输入，在 arming 时捕获（boot 读在飞时 `o` 可能
  // 被 setOptions 整体换掉——捕获对不随后动）：bootMessages = 本次 boot 的
  // 消息链；bootBaseLen = divider+折叠基座的长度（嫁接边界）；bootPrefix =
  // 前缀同一性快照（竞态守卫用它判「自 arming 以来 history 是否只发生过纯
  // 追加」——appendHistory 保前缀元素身份，整表重建换新对象必败）。
  const bootMessages = o.initialMessages;
  const bootBaseLen = history.length - (o.bootNotices?.length ?? 0);
  const bootPrefix = history;
  let historyOut: readonly HistoryEntry[] = history;
  let statusSnapshot: DriverStatus | null = null;

  // 113-B3 — quota park state. Declared ABOVE buildStatus: the status pollers
  // fire emit() synchronously during construction (bgPoll/cron seam start),
  // so a later declaration would be a TDZ read. The behavioral helpers live
  // down at the cron seams (their closures only run post-construction).
  let quotaParks = 0; // restored from the JSONL at boot/resume (the file IS the durable count)
  // 125 项 1 — the session's spent MODEL-side rotations (the same durable-count
  // discipline as quotaParks: the JSONL's context_rotation entries ARE the
  // count). Restored in the boot replay below; incremented at the compacted
  // event's consume; read at every startRun (LoopOptions.contextRotation).
  let agentRotationsUsed = 0;
  let parked: { readonly provider: string; readonly resetAt: string; readonly attempt: number } | null = null;
  // Late-bound: continueSession lives on the finished driver object (declared
  // far below); the wake seams close over this slot and read it at fire time.
  let continueParkedSession: ((id: string) => Promise<{ readonly started: boolean }>) | undefined;
  // 113-B3: refused-wake re-arms per parked id (bounded; see handleQuotaWake).
  const quotaWakeRearms = new Map<string, number>();

  const statusListeners = new Set<() => void>();
  const historyListeners = new Set<(entries: readonly HistoryEntry[], reset: boolean) => void>();
  const eventListeners = new Set<(event: LoopEvent) => void>();

  const buildStatus = (): DriverStatus => ({
    live,
    busy,
    queued: [...queued],
    boardProgress,
    ctxTokens,
    mode,
    cachePercent,
    bg: bgPoll.get(),
    pendingPermission,
    planBoard,
    sessionId,
    // M45: read live from the sidecar instance (the same one the gate layer
    // classifies through) — every setGating poke rebuilds this snapshot.
    sidecar: o.sidecar !== undefined ? { checks: o.sidecar.checks(), breakerOpen: o.sidecar.breakerOpen() } : null,
    // M57 §2: the picker's data — identity from the live model state, list
    // from the same source /model reads. Absent identity meta → null (the
    // web simply hides the clickable segment).
    model:
      modelLive.model === undefined && o.statusline === undefined
        ? null
        : {
            label: modelLive.model ?? o.statusline?.model ?? "unset",
            // The live switch state first; the frontend's statusline meta is
            // the fallback until the first switch rewrites modelLive.
            ...(modelLive.provider !== undefined || o.statusline?.provider !== undefined
              ? { provider: modelLive.provider ?? o.statusline?.provider }
              : {}),
            // S5: the session-effective effort rides the same block (absent
            // when neither a switch nor boot meta set one — the env tier
            // stays settingsStatus's to report).
            ...(modelLive.effort !== undefined && modelLive.effort !== ""
              ? { effort: modelLive.effort }
              : {}),
            choices: (o.availableModels ?? availableModels()).map((c) => ({
              provider: c.provider,
              model: c.model,
              source: c.source,
              // Task 5: the registry-cataloged window rides the choice (absent
              // when uncataloged — the field is optional end to end).
              ...(c.contextLength !== undefined ? { contextLength: c.contextLength } : {}),
            })),
          },
    // S4: the session-effective language fold — the same value the next
    // submit's transient blocks use.
    language: languageFold(),
    // ω99-249: the live goal's face (pure read; null when no goal is live).
    goal: goalRuntimeRef.current?.webSnapshot() ?? null,
    // ω99-253: the cached branch (a pure variable read — emit never spawns;
    // null until the boot read lands, then whatever the last read said).
    gitBranch,
    // The cached session name (same pure-variable read — the store is never
    // touched here; null until some knowledge seam lands a name).
    sessionName,
    // The cached memory-store signature (the same pure-variable read — the
    // store is never touched here; absent until some knowledge seam lands a
    // value, and forever on a storeless stub driver).
    ...(memorySig.current() !== undefined ? { memorySignature: memorySig.current() } : {}),
    // 113-B3: the quota-parked face (absent = not parked; a run start clears).
    ...(parked !== null ? { parked } : {}),
  });

  const emit = (): void => {
    // ω99-41: every observer samples live through this seam — fold the pending
    // delta window first so the broadcast snapshot always carries the full
    // accumulated text (byte parity with the old synchronous accumulation).
    materializePending();
    if (!active || disposed) return;
    statusSnapshot = buildStatus();
    for (const cb of [...statusListeners]) cb();
  };

  const appendHistory = (...entries: HistoryEntry[]): void => {
    if (entries.length === 0) return;
    if (!active || disposed) return;
    history = [...history, ...entries];
    historyOut = history;
    const batch = [...entries];
    for (const cb of [...historyListeners]) cb(batch, false);
  };

  // #302 (0.3.29): flush the just-finished model call's prose as its own
  // history entry, so text and tools interleave chronologically in the
  // transcript — previously every segment of a tool-heavy turn pooled into
  // ONE reply pinned under the tool stream ("模型只回答一次"). Fires at the
  // top of every tool phase (the first tool_call_started of a call); later
  // tools of the same call are WeakSet no-ops. Reads state.messages, not
  // live.answer, so non-streaming providers segment identically; live.answer
  // resets so the live card only ever shows the CURRENT call's streaming
  // text and the run-end commit sees just the final segment. A prose-less
  // pure-tool-call turn commits nothing (no empty cards).
  const flushAssistantSegment = (): void => {
    // ω99-41: the cursor below slices the FULL reasoning and the emptiness
    // check reads the fresh answer — fold the pending delta window first.
    materializePending();
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const m = state.messages[i];
      if (m === undefined || m.role !== "assistant") continue;
      if (committedAssistantSegments.has(m)) return;
      committedAssistantSegments.add(m);
      if (m.content !== "") {
        const segmentReasoning =
          live.reasoning.length > reasoningMark ? live.reasoning.slice(reasoningMark) : "";
        appendHistory({
          kind: "assistant",
          text: m.content,
          ...(segmentReasoning !== "" ? { reasoning: segmentReasoning } : {}),
        });
      }
      // #454 (0.3.83 报障「思考过程一直在会话最底部不断追加」): the live
      // reasoning card mirrors the CURRENT call only — the same discipline
      // the answer line below already follows. #302 advanced the mark but
      // never cleared the VIEW buffer, so ReasoningBlock accumulated the
      // whole run (「思考过程 · N 字」 climbing across ~70 tool calls). Reset
      // buffer AND mark together: the run-end slice reads below then read
      // slice(0) of a buffer holding just this call's segment —
      // byte-identical to the old slice(mark) of the run-long text.
      reasoningMark = 0;
      if (live.reasoning !== "" || live.answer !== "") {
        live = { ...live, reasoning: "", answer: "" };
      }
      return;
    }
  };

  // Whole-history replacement (clear / loadHistory): notify with the full new
  // list + reset flag so live subscribers replace instead of appending.
  const resetHistory = (): void => {
    if (!active || disposed) return;
    const full = [...history];
    for (const cb of [...historyListeners]) cb(full, true);
  };

  // (ω99-217 #1 续 → 118 修复) boot resume: initialMessages 只重建了消息
  // 索引——已持久化的 settle 收据从会话文件 best-effort 回放。118 起回放
  // 不再尾部追加（报障「打开历史会话时回合收据全堆在最底部」）：收据按
  // 文件序锚定（receiptAnchorsFromEntries）后经 resumeEntriesAnchored 一次
  // 重建交错基座——每枚收据落在其锚点消息的视图条目之后、下一回合之前，
  // 经 resetHistory 整表重发（/clear、loadHistory、/rewind 同款既有机制：
  // server 中继 reset 帧、TUI useSyncExternalStore 全量换表）。boot notices
  // 仅在确有收据可插时浮到 divider 正下方（保持「最前」：先于一切收据，
  // 收据描述重启前的过去、归位到各自回合下方）；无收据 → 零动作，老文件
  // 逐字节不变。竞态守卫（IIFE 是 fire-and-forget）：落地时以 bootPrefix
  // 做前缀同一性校验——只放行「自 arming 以来仅纯追加」的 history（新 run
  // 的条目全在尾部，插入边界全落在 boot 前缀内部，天然不被打断/错位）；
  // 期间发生过整表重建（/clear、resume/loadHistory 换会话、/rewind、/edit
  // 分支）则身份必败 → 弃置收据（其描述的视图已被换掉；重建路径自身本就
  // 不回放收据，弃置与现状一致）。无条目/无文件 → 零回放，新启动行为不
  // 变；workspaceRoot 缺失（stub 驱动）不读盘。（IIFE 排在 appendHistory/
  // resetHistory 声明之后——同步前缀里的引用先于声明就是 TDZ；首个 await
  // 之后的引用本无此问题，tsc 的 CFA 不区分两者。）
  if (
    bootMessages !== undefined
    && bootMessages.length > 0
    && (sessionStore !== undefined || o.workspaceRoot !== undefined)
  ) {
    void (async () => {
      try {
        const store = sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions"));
        const entries = await store.loadSessionEntries(sessionId);
        // 快照边界钳制 + 活尾去重：读的是「现在」的文件，重建的是「boot 时」
        // 的消息链。①锚点消息数超出 bootMessages.length 的收据属于读盘期间
        // 新落的 run（其视图条目已在活尾部），回放进旧基座既错位又重复，弃；
        // ②读跨越了完整 run 的极端形（宿主消息行晚于收据行落盘——3403 注释
        // 的既有宿主时序）里新收据仍锚在旧消息数上：本进程 run 的 UI 收据已
        // 在活尾部，按 notice.text 对尾段去重（收据无跨边界稳定 id，文本是
        // 诚实上限——同文老收据被误弃属化妆级损失，远好于重复/错位）。
        const tailNoticeTexts = new Set(
          history.slice(bootPrefix.length)
            .filter((e): e is Extract<HistoryEntry, { kind: "notice" }> => e.kind === "notice")
            .map((e) => e.text),
        );
        const anchors = receiptAnchorsFromEntries(entries).filter(
          (a) => a.afterMessageIndex <= bootMessages.length && !tailNoticeTexts.has(a.notice.text),
        );
        if (
          anchors.length > 0
          && history.length >= bootPrefix.length
          && bootPrefix.every((e, i) => history[i] === e)
        ) {
          // 前缀完好（仅纯追加）：divider 头 + 浮前的 boot notices + 交错
          // 基座（resumeEntriesAnchored 自带 divider，slice(1) 去重）+ 尾部
          // 原样（boot notices 之后的一切——含读盘期间用户已开跑的新 run）。
          const interleaved = resumeEntriesAnchored(bootMessages, sessionId, anchors);
          history = [
            bootPrefix[0]!,
            ...bootPrefix.slice(bootBaseLen),
            ...interleaved.slice(1),
            ...history.slice(bootPrefix.length),
          ];
          historyOut = history;
          resetHistory();
        }
        // The resumed session's name rides the SAME read (zero extra file
        // IO): the status face carries it from the first post-boot frame —
        // no run, no user action. A nameless file stays null, quietly.
        const named = sessionNameSource(entries);
        if (named !== undefined) setSessionNameCached(named.name);
        // 113-B3: the quota-park counter restores from the same read — the
        // JSONL IS the durable count (a restart mid-window keeps the bound).
        quotaParks = countQuotaParkEntries(entries);
        // 125 项 1/项 2: the window chain restores from the same read —
        // boundary count (the chain, pre-125 rows included) + the last
        // boundary's world snapshot (the diff baseline). Same await-boundary
        // note as goalRuntime below.
        {
          const chain = windowChainFromEntries(entries);
          windowBoundaryCount = chain.boundaryCount;
          lastWorldSnapshot = chain.lastWorldState;
        }
        // ω99-249: the live goal restores from the same file (counters kept;
        // the ledger 随动 reconciles at the next run boundary). This
        // reference sits AFTER the first await — see the TDZ note above.
        goalRuntime?.restoreFromEntries(entries);
        // ω99-314: the snapshot catalog restores from the same read (file
        // order; the guard-3 baseline survives restarts).
        rebuildSnapshotCatalog(entries);
      } catch {
        /* best-effort replay — an unreadable store reads as zero */
      }
    })();
  }

  // Steering queue (M18): texts submitted while a run is in flight. Drained by
  // the loop before each model call; whatever survives run end (a steer that
  // landed too late) is auto-started as a fresh run.
  const queueRef: { current: string[] } = { current: [] };
  // 124b 项 1（codex instant_interrupt）：在飞运行的流抢占通道——run 内创
  // 建（startRun），run 的 finally 缝清除。submitCore 的 busy 臂停车文本后
  // 调 request()：正在流式的模型调用立即中断（模型调用之间的 request 打
  // 在陈旧控制器上，无害空操作——那种提交照旧在轮界 drain 落地）。
  const streamPreemptRef: { current?: StreamPreemptChannel } = {};
  // M63-B R1 fix: SYSTEM-authored steering texts (the FileChanged delivery)
  // live in their OWN lane. The user queue's run-settle fallback auto-starts
  // a follow-up run from leftover entries — a file change must NEVER launch a
  // run — so the system lane is drained ONLY by the loop's mid-run take();
  // leftover system notes wait for the next run's first model call.
  const systemSteerQueue: string[] = [];
  // ω-5a I23: the cold-cache notice fired once per session (the mute — the
  // consult itself may run every startRun; only the NOTICE is one-shot).
  let coldCacheWarned = false;
  let coldWindowCleared = false; // 研究弧A#1：TTL 冷窗 tier-0 免费清理，每个冷窗一次

  // M32 §2/§3: the external-change prober + its MetaNote queue. One per
  // session (the round-robin cursor persists across runs); absent opts
  // (stub-tool tests) → no probing, and the queue stays an always-empty no-op.
  // 0.3.10（用户反馈：「系统注入」太笼统，要标明是什么钩子）：每条注记
  // 随入队携带来源标签。loop 把一批注记并成一个 payload、每个模型调用只
  // yield 一个 meta_note 事件（非一注一事件），故来源在 take() 时记入
  // takenNoteSources，事件到达时整批收割（splice 清空，杜绝跨批泄漏）。
  // loop 内部注入（safety notes / 工具钩子上下文）不经此队列、无来源 →
  // 前端按「系统注入」回退。信封与投影字节零变化（标签只进 UI 历史）。
  const metaNotes: { text: string; source: string }[] = [];
  const takenNoteSources: string[] = [];
  // 121 §4（a reference harness budget death salvage）— the ONE-SHOT wrap-up round armed
  // at the settle that crossed the goal's budget, fired at the settle seam's
  // system-injection lane (before cron/peer/child-mail: a dying goal outranks
  // scheduled work). Cleared by ANY startRun — whichever run comes next, its
  // onRunStart injects the budget note (goalBudgetNote), so the directive
  // reaches the model exactly once; the salvage lane only guarantees a run
  // happens at all when nothing else would. The salvage run's own settle
  // reports no NEW crossing (already budget_limited), so nothing re-arms:
  // bounded at one wrap-up round per crossing, never a loop.
  let pendingBudgetSalvage = false;
  // ω99-233 boot 播种：session 以 auto 起步（opts.mode ← settings
  // defaultPermissionMode，即上文 `opts.mode ?? "workspace"` 初值）时播种同一
  // 「进 auto」契约常量——首问即带契约，无需等切换；resume 到 auto 档会话
  // 同享（resume 重建 driver 时 opts.mode 即该档——行为正确非边界）。
  // /clear 随队列一起清（M80 pre-clear 纪律：排队注记是 pre-clear 上下文）。
  if (mode === "auto") metaNotes.push({ text: AUTO_MODE_CONTRACT, source: "权限档位" });
  const prober: ExternalChangeProber | null =
    opts.readState !== undefined && opts.workspaceRoot !== undefined
      ? createExternalChangeProber({
          readState: opts.readState,
          workspaceRoot: opts.workspaceRoot,
          push: (text) => metaNotes.push({ text, source: "文件变更探测" }),
        })
      : null;

  let gen: AsyncGenerator<LoopEvent, Terminal> | null = null;
  let abort: AbortController | null = null;
  let interrupted = false;
  // v7 γ2——关窗中止旗：setActive(false) 在 run 在飞时置位（与 abort 同点）。
  // 消费循环可能因 gen.return() 先到 done 而不走 !active 断流分支，此旗是
  // settle 侧可靠的成因来源（每轮 run 起点复位）。
  let shutdownInterrupted = false;
  // ω99-45: the manual /compact's cancellation controller. Non-null exactly
  // while a compaction is in flight (created in the /compact case, cleared at
  // its settle); interrupt()/setActive(false) abort it alongside the run's
  // own controller. The loop's AUTO compaction needs no twin here — it
  // already rides the run's signal (LoopOptions.signal → tier2Compact).
  let compactionAbort: AbortController | null = null;

  // ω99-45: the ONE "session settled" predicate (the isIdle() method's body).
  // The run dimensions (model call, busy tools, provider retries) all ride
  // `busy`'s lifetime — modelInFlight/busyTools are kept explicit per the
  // state-bit enumeration; the compaction, queue, and monitor dimensions are
  // the ones the old ad-hoc conditions kept missing.
  const sessionIdle = (): boolean =>
    !busy
    && !modelInFlight
    && live.busyTools.length === 0
    && queueRef.current.length === 0
    && compactionAbort === null
    && (o.monitor?.pending().length ?? 0) === 0;

  // A parked permission ask suspends the loop's gate (core does not race
  // canUseTool against the abort signal), so interrupt/detach must resolve it
  // as a deny or the run would hang forever. Denied → the loop sees the
  // already-aborted signal right after the gate and returns its aborted
  // terminal promptly.
  const denyPendingAsk = (): void => {
    // ω99-252 — the interrupted settle moves ABOVE the park check: an interrupt
    // while a FRONTEND dialog is in flight (onPermissionAsk pending, nothing
    // parked) must not leave the ask's evidence line as a phantom "still
    // waiting" marker either (会话终局形：interrupted). A hard crash before any
    // cleanup is exactly the standing line the morning observe reads.
    if (parkedAskSession !== null) {
      askLedger(buildPermissionSettledEntry(parkedAskSession, "interrupted", Date.now()), parkedAskSession);
      parkedAskSession = null;
    }
    const resolve = pendingResolve;
    if (resolve === null || pendingPermission === null) return;
    pendingPermission = null;
    pendingResolve = null;
    powerGuard.sync(busy && pendingPermission === null);
    resolve({ kind: "deny", reason: "interrupted" });
  };

  // M30: bg-count polling — the registry exposes no change notification, so
  // status() is re-aggregated on an interval (emit only on change).
  // M49 §4: the session's taint tracker — tool results carrying user-file /
  // MCP bytes get a WeakMap taint bit (never serialized), Pass/Forward
  // re-packaging inherits it, and the sidecar probe reads it.
  const taint = createTaintTracker();
  // M30: bg-count polling — the registry exposes no change notification, so
  // status() is re-aggregated on an interval (emit only on change). The
  // status-poll twin of the idle seams (idle-seam.ts); get() is the old
  // closure state's getStatus face.
  const bgPoll = createStatusPoll({
    intervalMs: BG_STATUS_POLL_MS,
    armable: () => o.agentsRegistry !== undefined,
    sample: () => {
      if (o.agentsRegistry === undefined) return undefined;
      const all = o.agentsRegistry.status();
      return {
        active: all.filter((s) => s.status === "queued" || s.status === "running").length,
        spawned: all.length,
      };
    },
    onChange: () => emit(),
  });
  bgPoll.start();

  // The idle-seam family (idle-seam.ts): the five same-shaped poll lanes —
  // cron (M61 §1), peer (M64-A §A), monitor (ω-4a), childMail (ω99-57), and
  // the δ detach lane below — share ONE factory (held predicate, drain
  // source, landed handler, unref'd timer). The shared hold predicate is the
  // ω99-45 compaction hold exactly: a run, an interrupt, a compaction, an
  // inactive frontend, or dispose parks every seam. 拆分运动（弧 δ 顺带件）：
  // 五胞胎外提为一家，逐字节同行为（各缝的 notice 文案/drain 源原样参数化）。
  const idleHeld = (): boolean => busy || interrupted || compactionAbort !== null || !active || disposed;
  // M61 §1: the fire-on-idle seam. A scheduled task that armed while the
  // session was idle (no run to drain it) starts its run HERE — one fire,
  // never once per missed occurrence (the runtime dedupes by task). The
  // runtime's own tick (15s) decides due-ness; this poll only drains what is
  // already armed.
  // 113-B3 — quota park behavior: the cron wake decoder + the wake handler.
  // A model call that throws the typed QuotaParkError ends the run PARKED
  // (the error arm below): the session JSONL gets one quota_park attribution
  // row (M35 §2 generic lane — never model-visible, M24 前缀零影响), the user
  // gets one Chinese notice carrying the reset moment, and a one-shot `at`
  // task is registered on the scheduler at resetAt+30s whose prompt is a
  // machine marker the drain seams below decode back into "continue THAT
  // session" (continueSession 断口续跑 — 既有暖前缀重放，无需特化). If the
  // process exits before the wake, the scheduler's durable store + startup
  // tick + foreign-task adoption fire the same marker into whatever process
  // is live then — the parked session resumes there. (The state slots above:
  // quotaParks / parked / continueParkedSession.)
  const handleQuotaWake = (id: string): void => {
    void (async () => {
      const outcome = await continueParkedSession?.(id).catch(() => undefined);
      if (outcome?.started === true) {
        quotaWakeRearms.delete(id);
        return;
      }
      // The wake was consumed (the one-shot self-deleted on take) but the
      // resume was refused — busy / a compaction window / an unreadable
      // session. Losing it would strand the parked session forever: re-arm a
      // short one-shot (+2min) so the wake retries, with an honest notice.
      // BOUNDED (≤5 re-arms per id): a resume that keeps failing is telling
      // us something — stop the churn and say so (the tail-anchored decode
      // makes a marker hijack rare; this cap makes it harmless).
      const rearms = (quotaWakeRearms.get(id) ?? 0) + 1;
      if (rearms > QUOTA_PARK_REARM_CAP) {
        appendHistory({ kind: "notice", text: `⚠️ 配额唤醒多次无法续跑（已重试 ${QUOTA_PARK_REARM_CAP} 次）——已停止自动重试，请在配额恢复后手动继续该会话` });
        emit();
        return;
      }
      quotaWakeRearms.set(id, rearms);
      appendHistory({ kind: "notice", text: `⏰ 配额唤醒暂不可续（会话忙或不可读）——${Math.round(QUOTA_PARK_REARM_MS / 60_000)} 分钟后自动重试` });
      try {
        await o.cron?.createTask({ prompt: quotaWakePrompt(id), schedule: { type: "at", at: Date.now() + QUOTA_PARK_REARM_MS } });
      } catch {
        appendHistory({ kind: "notice", text: "⚠️ 配额唤醒重排失败——请在配额恢复后手动继续该会话" });
      }
      emit();
    })();
  };
  /** The cron drain wrapper every seam uses: ordinary scheduled injections
   *  pass through; a quota-wake marker is consumed HERE (continueSession on
   *  the parked session) and returns undefined — never a steer, never a
   *  startRun prompt (the marker must never reach the model). */
  const drainCronInjection = (): string | undefined => {
    const scheduled = o.cron?.takeInjection();
    if (scheduled === undefined) return undefined;
    const wake = quotaWakeOf(scheduled);
    if (wake === undefined) return scheduled;
    handleQuotaWake(wake);
    return undefined;
  };
  const cronSeam = createIdleSeam({
    intervalMs: CRON_POLL_MS,
    held: idleHeld,
    armable: () => o.cron !== undefined,
    drain: () => drainCronInjection(),
    landed: (scheduled) => {
      appendHistory({ kind: "notice", text: `⏰ ${truncate(scheduled, 80)}` });
      startRun(scheduled, false);
    },
  });
  cronSeam.start();
  // M64-A §A: the peer-delivery idle seam — same track as cron (空闲即新开
  // turn). Accepted messages drain through the steering lane mid-run; when
  // the frontend is idle this poll starts the fresh turn.
  const peerSeam = createIdleSeam({
    intervalMs: CRON_POLL_MS,
    held: idleHeld,
    armable: () => o.peer !== undefined && o.peer.refusal === undefined,
    drain: () => o.peer?.takeInjection(),
    landed: (delivered) => {
      appendHistory({ kind: "notice", text: `📬 ${truncate(delivered.split("\n")[0] ?? "", 80)}` });
      startRun(delivered, false);
    },
  });
  peerSeam.start();
  // ω-4a: the monitor-event idle seam — same track as cron/peer (空闲即新开
  // turn). Events drain through the steering lane mid-run; when the frontend
  // is idle this poll starts the fresh turn. The guard deliberately does NOT
  // use sessionIdle() — pending monitor events are this seam's own work
  // (draining them is its purpose), so a full isIdle gate would never open.
  const monitorSeam = createIdleSeam({
    intervalMs: CRON_POLL_MS,
    held: idleHeld,
    armable: () => o.monitor !== undefined && o.monitor.refusal === undefined,
    drain: () => o.monitor?.takeInjection(),
    landed: (watched) => {
      appendHistory({ kind: "notice", text: `👁 ${truncate(watched.split("\n")[0] ?? "", 80)}` });
      startRun(watched, false);
    },
  });
  monitorSeam.start();
  // ω99-57: the child-mail idle seam — same track as cron/peer/monitor (空闲
  // 即新开 turn). A background child's message sent while the frontend is
  // idle starts the fresh turn here (an awaited foreground child never needs
  // it: its messages drain inside the parent's open run). First line of the
  // formatted text is the human notice.
  const childMailSeam = createIdleSeam({
    intervalMs: CRON_POLL_MS,
    held: idleHeld,
    armable: () => o.childMail !== undefined,
    drain: () => o.childMail?.take(),
    landed: (childMailText) => {
      appendHistory({ kind: "notice", text: `📨 ${truncate(childMailText.split("\n")[0] ?? "", 80)}` });
      startRun(childMailText, false);
    },
  });
  childMailSeam.start();

  // 弧 δ — the detach lane (session-scoped; rationale: detach-lane.ts).
  const detachLane = createDetachLane({
    onNotice: (text) => { appendHistory({ kind: "notice", text }); emit(); },
    onChange: () => emit(),
  });
  const detachSeam = createIdleSeam({
    intervalMs: CRON_POLL_MS,
    held: idleHeld,
    armable: () => true,
    drain: () => detachLane.takeInjection(),
    landed: (landed) => {
      appendHistory({ kind: "notice", text: `🔄 ${truncate(landed.split("\n")[0] ?? "", 80)}` });
      startRun(landed, false);
    },
  });
  detachSeam.start();

  // 123-5 — 空闲清理的锚：上次 run 收束时刻（settle 刷新；空闲计时从此起算）。
  let lastSettleAt = Date.now();
  /** 123-5 — idle microcompact 的空闲门槛（zcode 同值 60min）。 */
  const IDLE_MICROCOMPACT_AFTER_MS = 60 * 60_000;
  // 123-5（zcode off-peak 家族同源思想引进）— the idle microcompact pass:
  // 空闲 ≥60 分钟时对旧工具结果跑 tier-0/1 清理（纯变换零 LLM）——用户
  // 永远不为「清理旧上下文」等待：等待发生在他们离开的时候。不走五胞胎
  // seam（它们的 armable 只在 start 时评估一次——时间依赖的门永不开），
  // 自持 unref'd 定时器同纪律：poll 内查 held/kill switch/门槛，变化才
  // 有回执，无变化零噪音，landed 不开 run（维护不是输入）。压缩仍在请求
  // 路径上有自己的阈值线——这里是旁路免费档。
  {
    const idleCompactTimer = setInterval(() => {
      if (idleHeld() || !sessionIdle()) return;
      if (process.env.WUDAO_DISABLE_IDLE_MICROCOMPACT === "1") return;
      if (state.messages.length === 0 || Date.now() - lastSettleAt < IDLE_MICROCOMPACT_AFTER_MS) return;
      const toolDefs = state.tools.map(toModelToolDefinition);
      const before = estimateTokens(state.systemPrompt, toolDefs, state.messages);
      const compacted = microcompact(state.messages, { retention: compactionRetentionFor(o.tools) });
      if (compacted.length === state.messages.length && compacted.every((m, i) => m === state.messages[i])) {
        lastSettleAt = Date.now(); // nothing aged past the bar — quiet, re-arm the window
        return;
      }
      state.messages = compacted;
      const after = estimateTokens(state.systemPrompt, toolDefs, state.messages);
      ctxUnknown = true;
      emit();
      appendHistory({
        kind: "notice",
        text: `♻️ 空闲清理：你离开期间清掉了过期的旧工具结果（~${before.toLocaleString("en-US")} → ~${after.toLocaleString("en-US")} tokens）——上下文更轻，无需等待`,
      });
      lastSettleAt = Date.now(); // re-arm: another hour of quiet before the next pass
    }, CRON_POLL_MS);
    idleCompactTimer.unref?.();
  }

  // Driver-level permission ask: park the question and suspend the gate until
  // answerPermission resolves it (the frontend-less path; the TUI passes
  // onPermissionAsk and never parks here).
  let pendingResolve: ((answer: AskAnswer) => void) | null = null;
  // ω99-248: #5 — the parked ask's PERSISTENT evidence (面一): parking appends
  // a permission_ask line to the session JSONL's M35 §2 generic lane (the 217
  // receipts' seam); resolving APPENDS a settle line — the ask line's bytes
  // never move (append-only). The record carries only sessionId/toolName/
  // summary/question/at — never input/env/keys (安全纪律); the full input
  // already rides the transcript's pre-dispatch tool-call message. Best-effort
  // like the 217 receipts: a failed persist must not break the ask seam. M24:
  // generic entries never reach state.messages/system prompt — zero cache cost.
  let askLedgerStore: import("@wudao/core").SessionStore | null | undefined;
  const askLedger = (entry: import("@wudao/core").SessionEntry, parkedSessionId?: string): void => {
    if (o.persistPermissionAsks === false) return; // the pet lane's isolation opt-out
    const sid = parkedSessionId ?? sessionId;
    if (askLedgerStore === undefined) {
      askLedgerStore = sessionStore ?? (o.workspaceRoot !== undefined
        ? createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"))
        : null);
    }
    if (askLedgerStore === null) return; // in-memory driver (m58 posture) — nothing to persist
    askLedgerStore.appendEntry(sid, entry).catch(() => { /* ω99-248: best-effort — the UI ask already parked */ });
  };
  // Which session file the standing ask line landed in (the settle append must
  // answer THAT line even if the live id rotated while parked).
  let parkedAskSession: string | null = null;
  const askPermission = async (
    toolName: string,
    input: Record<string, unknown>,
    ctx?: { readonly sidecarReason?: string },
    /** M64-A: an explicit summary override (the peer-hold approval dialog —
     *  not a tool call, so o.summarize has nothing to say about it). */
    summaryOverride?: string,
  ): Promise<PermissionDecision> => {
    const summary = summaryOverride ?? o.summarize(toolName, input);
    // ω-4e: the asker digest when this ask is child-originated (undefined on
    // top-level asks — both ask paths below then behave byte-identically).
    const digest = askDigestPrefix();
    // M63-A: the waiting-for-input notification fires at the ask seam — both
    // the parked path and the frontend relay path.
    notificationHook("permission");
    // design 70 §3.2: the advisory ask-reviewer sits AFTER the whole
    // deterministic pipeline (this ask only fires because every rule fell
    // through to the human) and BEFORE the prompt renders — a decoration on
    // the ask, never a 6th permission layer. The live model is passed (no
    // captured client — a /model switch cannot strand a stale reviewer).
    // Fail-closed: undefined → both ask paths below render byte-identically.
    const review = await askReviewIntro(o.model, toolName, input, {
      receipt: (line) => appendHistory({ kind: "notice", text: line }),
    });
    // ω99-318: the visual-spoofing inspection — computed BEFORE the lane fork
    // so BOTH lanes (frontend callback + parked) carry the same payload; the
    // JSONL ask line above/below is five-field pinned and stays untouched.
    // Pure + capped (walk 64 strings / depth 4 / head+tail 2000cp windows /
    // 8-issue + 8-url caps) — zero hazard on the ask path. Reveal-not-block:
    // the answer semantics are byte-identical with or without this payload.
    const spoof = inspectToolInput(input);
    const askCtx = digest !== undefined || review !== undefined || spoof !== null
      ? {
          ...ctx,
          ...(digest !== undefined ? { askDigest: digest } : {}),
          ...(review !== undefined ? { askReview: review } : {}),
          ...(spoof !== null ? { spoof } : {}),
        }
      : ctx;
    // ω99-252: #2 — the evidence lane is lane-complete (车道全化): the ask line
    // lands BEFORE the lane fork — evidence is the FACT of asking («正在问»),
    // not a UI state. Whether the ask parks (frontend-less) or rides the
    // frontend's onPermissionAsk callback (the Ink prompt / the pet card / a
    // Slack relay), the session JSONL carries the same five-field line, so a
    // crash mid-dialog leaves the same morning evidence in every lane. Each
    // lane settles at its own closing seam: the parked lane at
    // answerPermission / denyPendingAsk; the callback lane right after the
    // awaited answer below (a frontend answer does NOT pass through
    // answerPermission — 侦察结论).
    parkedAskSession = sessionId;
    askLedger(buildPermissionAskEntry(sessionId, toolName, summary, Date.now()));
    if (o.onPermissionAsk) {
      const answer = await o.onPermissionAsk(toolName, summary, input, askCtx);
      // The callback lane's settle (ω99-252): the dialog resolved — append the
      // outcome line. A crash before this point leaves the standing ask line
      // (the morning evidence); an interrupt that already settled clears
      // parkedAskSession, so a LATE answer after it adds no second line.
      if (parkedAskSession !== null) {
        askLedger(buildPermissionSettledEntry(parkedAskSession, answer.kind, Date.now()), parkedAskSession);
        parkedAskSession = null;
      }
      // ω99-56: the approval gate's receipt — recorded from the SAME answer
      // the frontend records its own session rule from (askPermission is the
      // one seam both ask paths share), so the two can never drift.
      recordApprovalReceipt(approvalGate, answer, toolName, input);
      // ω99-70: this call is now human-settled — when this ask was an
      // escalation INSIDE o.canUseTool, the run gate's flip must not re-ask
      // the decision the human just made (identity-keyed per call).
      markHumanSettled(approvalGate, toolName, input);
      return askAnswerToDecision(answer);
    }
    return await new Promise<PermissionDecision>((resolve) => {
      const settingsFile = o.workspaceRoot !== undefined ? protectedSettingsFile(toolName, input) : undefined;
      // workspace-ux B2: the git-risk boundary judges from the LIVE agent
      // root (the tree the pending write would touch), not the boot root.
      const warning = o.workspaceRoot !== undefined ? gitRiskAskWarning(toolName, input, agentWorkspaceRoot) : undefined;
      const sidecar = ctx?.sidecarReason;
      pendingPermission = {
        toolName,
        summary,
        input,
        ...(settingsFile !== undefined ? { settingsFile } : {}),
        ...(warning !== undefined ? { warning } : {}),
        ...(sidecar !== undefined ? { sidecar } : {}),
        ...(digest !== undefined ? { askDigest: digest } : {}),
        ...(review !== undefined ? { askReview: review } : {}),
        ...(spoof !== null ? { spoof } : {}),
      };
      pendingResolve = (answer: AskAnswer): void => {
        recordApprovalReceipt(approvalGate, answer, toolName, input); // ω99-56
        markHumanSettled(approvalGate, toolName, input); // ω99-70 (per-call; see above)
        resolve(askAnswerToDecision(answer));
      };
      // ω99-248 — the ask's persistent evidence line already landed ABOVE the
      // lane fork (ω99-252); this lane's settle appends later at
      // answerPermission / denyPendingAsk — never a rewrite of the ask line.
      // 夜移 028: the ask parks the run on a human — drop the power
      // assertion (debounced; a quick answer re-arms inside the window).
      powerGuard.sync(busy && pendingPermission === null);
      emit();
    });
  };

  // cc-plugins D2: the skill-injection decide — the SAME composition the run
  // gate below uses (the plan/init read-only whitelist when either is armed,
  // the frontend's mode rules via o.canUseTool, then the ask seam: the TUI's
  // prompt, a parked pendingPermission, or the web frontend's relay). An `a`
  // answer records a shell session rule through the normal
  // askRelay/applyAskAnswer path, so "first execution prompts, the rest of
  // the session remembers" is the PIPELINE's own behavior — this seam adds
  // no caching of its own.
  const decideSkillInjection = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    if (initRun || planRun) {
      const denied = planModeDenied(toolName);
      if (denied) return denied;
    }
    if (o.canUseTool) {
      const d = await o.canUseTool(toolName, input);
      if (d && typeof d !== "string") return d;
    }
    return askPermission(toolName, input);
  };

  // M64-A §A: the peer-hold approval dialog. A held inbound message surfaces
  // through the SAME ask seam a tool ask uses (the TUI/web/Slack prompts all
  // render it; headless frontends park it as pendingPermission). The dialog
  // names the sender + preview; an unanswered dialog dies at dialogExpiry
  // (the runtime's timer — a late answer to an expired hold is a no-op). The
  // waiting-for-input notification reuses the permission kind (M63-A seam —
  // no new hook events).
  if (o.peer !== undefined) {
    o.peer.approvalSink.current = async (held): Promise<boolean> => {
      const decision = await askPermission(
        "peer_message",
        { from: held.from, preview: held.preview },
        undefined,
        `peer message from ${held.from} (tier ${held.tier}): ${held.preview}`,
      );
      return decision.behavior === "allow";
    };
  }

  // The run body, started by submit() for a fresh prompt and re-started from
  // the completion seam for each queued follow-up. `plan` (M37 §1) flips this
  // run into plan mode (read-only whitelist + plan stop gate).
  // ω99-286（续，标记见上）— `mode.continueRun` is the 断点续跑 form: the SAME
  // wrapper minus the user turn (no append, no onUserTurn 落盘 — the historical
  // tail user/tool_result IS the model input tail; 不注引导语，前缀字节稳定).
  const startRun = (text: string, plan: boolean, images?: readonly ImageBlock[], files?: readonly FileBlock[], mode?: { readonly continueRun?: boolean }): void => {
    // #48 (hermes#4 turn-lease slice): the run gate. The RUN is where this
    // process becomes a run-writer for `sessionId` — the cross-process lease
    // must be held before the first model call. Sync fast-path: a session
    // this box already saw refused (a failed resume, a refused run) rejects
    // the submit BEFORE the user message is even built — no write at all.
    const heldNow = sessionLeases?.heldNow(sessionId);
    if (heldNow !== undefined) {
      appendHistory({ kind: "notice", text: `⚠️ 会话 ${sessionId} 正被进程 ${heldNow.pid} 占用 — 该会话已在另一处运行,本次输入未执行` });
      emit();
      return;
    }
    const leaseGate = sessionLeases === undefined ? undefined : sessionLeases.acquire(sessionId);
    busy = true;
    // 121 §4: any run start delivers the budget note itself (onRunStart
    // injects goalBudgetNote while the goal is budget_limited), so the armed
    // salvage round is moot — a user submit or a racing system injection
    // wins the "last answer opportunity" instead, exactly once either way.
    pendingBudgetSalvage = false;
    // 113-B3: a new run ends any parked face (the wake fired, or the user
    // typed — either way the session is being driven again; a re-park below
    // re-arms the face with a fresh attempt).
    parked = null;
    powerGuard.sync(busy && pendingPermission === null);
    interrupted = false;
    shutdownInterrupted = false; // v7 γ2：上一轮的关窗旗不漏进本轮
    // M63-C R1 (§2 prompt_id): one id per submitted prompt — the run's
    // hook invocations all carry it through the common stdin fields.
    if (promptIdBox !== undefined) promptIdBox.current = randomUUID();
    // M45 §1.5: the breaker's consecutive-rejection counter is per-RUN state —
    // a fresh submit starts from zero (run end naturally resets it).
    o.sidecar?.resetRun();
    state.status = "running";
    // ω-5a I23: consult the cold-cache predictor BEFORE the user message is
    // pushed (fresh prompts only — startRun is busy-guarded upstream). The
    // consult runs every startRun; the NOTICE is one-shot per session (the
    // mute). Human-facing only — nothing model-visible changes. Kill-switch
    // gated (--no-cold-cache-warning).
    if (!isFeatureAblated("cold-cache-warning") && o.coldCache !== undefined) {
      const cold = o.coldCache.preSend(state.messages.length);
      if (cold !== undefined && !coldCacheWarned) {
        coldCacheWarned = true;
        appendHistory({ kind: "notice", text: `❄️ 缓存可能已冷（${cold.reason}）——约 ${cold.reprocessTokens} token 需重新处理（${cold.confidence}）` }); // ω99-166f-iii: #4（reason/confidence 插值原样）
      }
      // 研究弧A#1（TTL 冷窗免费清理，超越 CC timeBasedMC）：冷预测
      // confidence=expired 且 reason=idle 时，前缀重写已不可避免——此刻
      // 做 tier-0 清除的边际缓存代价为零（debt-free window）。超越点：
      // ①per-provider 政策表（COLD_CACHE_POLICIES 文档化窗口，不硬编码
      // 60min）；②只做 tier-0（清除旧大工具结果，无摘要调用零延迟）；
      // ③每个冷窗一次（idle 后首 run）；④冷转预期收据（notice 带归因）。
      // identity_changed 不触发——那是换模型（旧工具结果可能是新模型
      // 还需要的上下文），与 idle 的「同一对话隔夜回来」语义不同。
      if (
        cold !== undefined && cold.confidence === "expired" && cold.reason === "idle" &&
        !coldWindowCleared && state.messages.length > 0
      ) {
        const cleared = clearTier(state.messages, {
          keepRecent: o.compaction?.keepRecent,
          // 冷窗=免费：缺省 fitsTokens=全清（fits 语义是「estimate 装得下就停」——
          // 设 ∞ 反而零清除，直传缺省才是「清所有够旧的大结果」）。
        });
        if (cleared.cleared > 0) {
          state.messages = cleared.messages;
          coldWindowCleared = true;
          appendHistory({ kind: "notice", text: `❄️ 冷窗免费清理：TTL 已过（idle ${Math.round(cold.idleSeconds / 60)}min），清除 ${cleared.cleared} 条旧工具结果——零边际缓存代价（前缀重写本来就要发生）` });
        }
      }
    }
    // ω99-286（续，标记见上）— 断点续跑模式跳过整个用户回合段：/edit 分支
    // （续跑不是分支事件，arm 留给下一个 plain submit）、user turn 构建与
    // push、夜移 017 落盘（续跑没有新消息——历史尾部的 user/tool_result 已
    // 在盘上，那条「不可再生消息」早已耐久）、记忆召回 / 语言块 / 推理语言块
    // （全是 per-turn 派生，无新 turn 无对象）、history 的 user 行。state
    // 尾部即模型输入尾（字节原样——不注引导语）。run 的其余一切（租约门、
    // busy/状态翻转、缓冲复位、loop、settle/持久）与普通 run 逐字节同路。
    // P2-10 (ω99-286 hoist): a run is a turn — a /rewind turn window closes at
    // its top in BOTH modes (a continue turn starts from the current tail just
    // the same; leaving the window open would mis-scope the next /rewind).
    rewoundCutKey = null;
    if (mode?.continueRun !== true) {
      // M53 §1: an armed /edit branches HERE — cut the active chain back to the
      // edited message's parent (the old turns stay on the tree via the JSONL;
      // the rendered history is rebuilt from the surviving prefix), then link
      // the new user message's parentUuid at the cut so resume walks the branch.
      let branchedThisRun = false;
      if (pendingEditCut !== null) {
        const cut = Math.max(0, Math.min(pendingEditCut, state.messages.length));
        pendingEditCut = null;
        branchedThisRun = true;
        state.messages = state.messages.slice(0, cut);
        history = resumeEntries(state.messages, sessionId);
        historyOut = history;
        resetHistory();
        boardProgress = null;
        planBoard = null;
      }
      // M53 §1: every user message the driver pushes carries its node link —
      // linear turns point at the chain predecessor (identity: uuid when the
      // predecessor has one, else its entry-id fingerprint), a branched turn at
      // the cut point. Persistence-only metadata; provider bytes are unaffected.
      const parentKey = state.messages.length > 0 ? nodeKey(state.messages[state.messages.length - 1] as AgentMessage) : undefined;
      const turnUuid = randomUUID();
      const userTurn: AgentMessage = {
        role: "user",
        content: text,
        uuid: turnUuid,
        ...(parentKey !== undefined ? { parentUuid: parentKey } : {}),
        // M79 §5: durable image refs ride the user turn (never bytes; the
        // provider resolves the transient data URL at request build).
        ...(images !== undefined && images.length > 0 ? { images } : {}),
        // ω99-55: content-addressed file blocks ride the same turn (bytes stay
        // in the store; request build projects handle text).
        ...(files !== undefined && files.length > 0 ? { files } : {}),
      };
      state.messages.push(userTurn);
      // 夜移 017 (#31): the user's turn is durable the moment it exists — a
      // crash mid-run must never lose the one message the user cannot
      // regenerate. Fired before anything else on the path (recall note,
      // transient tails, first model call) so even a crash between here and
      // the model is covered; the identity dedup at onRunComplete keeps the
      // JSONL single-line.
      o.onUserTurn?.(userTurn);
      // M53 review fix: a branch cut changes WHICH chain is active — record it
      // so a restart resumes the branch, never the flattened file.
      if (branchedThisRun) recordActiveBranch(turnUuid);
      // M49 §1: bounded auto-recall rides the run's FIRST model call through
      // the MetaNote queue (projection-only — the conversation stays clean).
      const recallNote = o.memoryRecall?.(text);
      if (recallNote !== undefined) metaNotes.push({ text: recallNote, source: "记忆召回" });
      // M47 §2: the language transient block — appended AFTER the user prompt
      // (turn tail, pure append: every earlier byte keeps its position, so the
      // prefix cache stays warm). It rides state.messages into persistence and
      // the task tool's inheritance check; no history entry (model-facing only).
      const languageBlock = languageBlockFor(text, o.languageBlock ?? languageFold().reply);
      let transientTailUuid = turnUuid;
      if (languageBlock !== undefined) {
        const blockUuid = randomUUID();
        state.messages.push({ role: "user", content: languageBlock, uuid: blockUuid, parentUuid: turnUuid });
        transientTailUuid = blockUuid;
      }
      // 夜移 012: the reasoning-language block rides the same turn tail (pure
      // append after the response block — prefix bytes never move). Same
      // persistence path and the same inheritance scan the task tool reads.
      const reasoningBlock = reasoningBlockFor(text, o.reasoningLanguage ?? languageFold().reasoning);
      if (reasoningBlock !== undefined) {
        state.messages.push({ role: "user", content: reasoningBlock, uuid: randomUUID(), parentUuid: transientTailUuid });
      }
      // M79b: the durable refs ride the HISTORY entry too — the surfaces (web
      // history bubbles) need the pointer to re-render the image; bytes still
      // never enter the log.
      appendHistory({ kind: "user", text, ...(images !== undefined && images.length > 0 ? { images } : {}), ...(files !== undefined && files.length > 0 ? { files } : {}) });
    }
    live = { ...EMPTY_LIVE, busyTools: [] };
    // ω99-41: epoch reset — buffer and live wipe as a pair (the old text never
    // folds into the new epoch's live; same erasure the live reset performs).
    answerBuf.reset();
    reasoningBuf.reset();
    pendingThinking = undefined;
    // #302: the run-end reasoning slice starts from zero each submit.
    reasoningMark = 0;
    emit();

    void (async () => {
      // #48: the awaited half of the run gate — a fresh refusal (first
      // encounter with a foreign-held session) aborts the run here, before
      // the loop, the model, or any tool side effect. The user message
      // above already landed in THIS driver's history (a single
      // line-atomic append; the run — the thing that corrupts — never
      // starts). The refusal caches in the box, so the NEXT submit refuses
      // synchronously, before even that.
      if (leaseGate !== undefined) {
        // #48: an INFRASTRUCTURE failure (the sessions root is unusable —
        // ENOTDIR on a broken .wudao, EACCES, …) is not a holder conflict:
        // nobody can hold a lease over an unwritable root. Degrade OPEN
        // with one honest notice; letting it reject would kill this run
        // IIFE as an unhandled rejection (the run dies silently, busy
        // never resets). A LIVE foreign holder below stays fail-closed.
        let r: Awaited<ReturnType<SessionLeaseBox["acquire"]>> | undefined;
        try {
          r = await leaseGate;
        } catch (err) {
          appendHistory({ kind: "notice", text: `⚠️ 会话租约不可用（${err instanceof Error ? err.message : String(err)}）— 本次运行无跨进程占用保护` });
          emit();
        }
        if (r !== undefined && !r.ok) {
          appendHistory({ kind: "notice", text: `⚠️ 会话 ${sessionId} 正被进程 ${r.holder.pid} 占用 — 该会话已在另一处运行,本次输入未执行` });
          state.status = "idle";
          busy = false;
          powerGuard.sync(busy && pendingPermission === null);
          emit();
          return;
        }
      }
      // Permission gate: mode-style rules (opts.canUseTool) run first and
      // short-circuit on allow/deny; only ask-shaped decisions reach the ask.
      // M37 §1: in plan mode the read-only whitelist runs BEFORE everything —
      // an out-of-whitelist call never reaches the ask.
      const gate: LoopOptions["canUseTool"] = async (toolName, input) => {
        // M55 §A1: an /init run shares the plan-mode read-only whitelist (the
        // draft flow never writes — the harness writes AFTER confirmation).
        if (plan || initRun) {
          const denied = planModeDenied(toolName);
          if (denied) return denied;
        }
        // ω99-56 — the file-edits approval gate (deslop). While armed, an
        // edit-class call WITHOUT a receipt for this exact tool+path never
        // silently passes: the frontend gate still runs first (its deny and
        // ask outcomes stand — narrowing composes, and auto-mode's sidecar
        // path is consulted exactly as before), but its silent ALLOWS flip
        // to the human ask. A recorded receipt (the `a`/`p` answer's
        // path-scoped session rule) falls through to the normal path below,
        // where the pipeline's own session layer honors it — no re-ask.
        // Subagent children use the frontend's subagent gate, not this run
        // gate: v1 covers the main line (the deslop skill says so too).
        // ω99-70 — the flip targets SILENT allows only: an ask resolved
        // INSIDE o.canUseTool (the TUI's sidecar escalation routes through
        // driver.ask → this askPermission) marked the call human-settled;
        // the human's own allow stands instead of being re-asked.
        if (approvalGate.armed && approvalGatedCall(toolName) && !approvalReceiptMatches(approvalGate.receipts, toolName, input)) {
          if (o.canUseTool) {
            const d = await o.canUseTool(toolName, input);
            if (d && typeof d !== "string" && d.behavior === "deny") return d;
            if (d && typeof d !== "string" && d.behavior === "allow" && humanSettledThisCall(approvalGate, input)) return d;
          }
          return askPermission(toolName, input);
        }
        if (o.canUseTool) {
          const d = await o.canUseTool(toolName, input);
          if (d && typeof d !== "string") return d;
        }
        return askPermission(toolName, input);
      };

      // Per-run AbortController: the signal travels into the loop → provider
      // fetches and tool races, so interrupt() settles hung calls in
      // milliseconds (gen.return alone waits out the current await).
      const ac = new AbortController();
      abort = ac;
      // 124b 项 1：本 run 的流抢占通道——用户 busy-submit 即时中断在飞模型
      // 流（Esc 的运行中止语义不变；两路 signal 在 loop 内合成）。工具执
      // 行与压缩不接该通道：抢占永不打断它们。
      const preemptChannel = createStreamPreemptChannel();
      streamPreemptRef.current = preemptChannel;
      // The steering seam: mid-run submits ride this take() into the loop,
      // which drains it before every model call and appends each text as a
      // plain user message (next generation sees it). A steer that lands after
      // the final model call's drain is still in the queue at run end → the
      // finally seam below auto-starts it as a fresh run (M14 fallback).
      const take = (): string | undefined => {
        const next = queueRef.current.shift();
        if (next !== undefined) {
          queued = [...queueRef.current];
          emit();
          return next;
        }
        // M61 §1: the steering channel's LOW-priority lane — due scheduled
        // tasks ride the same between-turns drain, strictly after the human's
        // items. A pure turn-tail append: the request prefix never moves.
        // 113-B3: quota-wake markers are consumed by the wrapper (resume the
        // parked session), never steered into the live run.
        const scheduled = drainCronInjection();
        if (scheduled !== undefined) return scheduled;
        // M64-A §A: peer deliveries ride the SAME low-priority lane, after
        // scheduled work — read between tool calls mid-turn (never interrupts
        // a running tool; the loop calls take() before each model call).
        const peer = o.peer?.takeInjection();
        if (peer !== undefined) return peer;
        // ω99-57: child→parent mail rides the same lane, after peer and
        // before monitor (T0-2) — a message sent during an awaited task tool
        // lands here and the parent's NEXT model call reads it, before it
        // acts on the settlement (the loop drains the whole queue).
        const childMailText = o.childMail?.take();
        if (childMailText !== undefined) return childMailText;
        // ω-4a: monitor events ride the same lane, after peer deliveries —
        // they occurred during the previous batch and append after its tool
        // results, before this model call (the turn-tail safe point).
        const monitored = o.monitor?.takeInjection();
        if (monitored !== undefined) return monitored;
        // 弧 δ: a landed background result rides the same lane, after monitor
        // (turn-tail append; M24 — the injection is a user message).
        const landedDetach = detachLane.takeInjection();
        if (landedDetach !== undefined) return landedDetach;
        // M63-B (R1 fix): the system lane (FileChanged notes) — mid-run only.
        // Nothing else drains it: a leftover note waits for the next run's
        // first model call instead of launching one.
        return systemSteerQueue.shift() ?? undefined;
      };
      // M61 §3: the goal evaluator composes at the STOP hook position — the
      // user-configured hook runs FIRST (its block wins), then the goal's.
      // M63-C §3: the skill-position overlay composes over the configured
      // hooks (its onRunStop, if any, runs before the goal's evaluator).
      const overlayStop = (state: AgentState): Promise<import("@wudao/core").StopHookDecision> => {
        const base = skillHooksCompiled?.onRunStop;
        if (base === undefined) return Promise.resolve("allow");
        return (async () => {
          try {
            const d = await base(state);
            if (typeof d === "object") return d;
            return "allow";
          } catch {
            return "allow";
          }
        })();
      };
      const composedStop = goalController !== undefined
        ? async (state: AgentState): Promise<import("@wudao/core").StopHookDecision> => {
            let user: import("@wudao/core").StopHookDecision = "allow";
            try { user = (await o.hooks?.onRunStop?.(state)) ?? "allow"; } catch { user = "allow"; }
            if (typeof user === "object") return user; // both shapes block
            const overlaid = await overlayStop(state);
            if (typeof overlaid === "object") return overlaid;
            return goalController.onStop(state);
          }
        : o.hooks?.onRunStop !== undefined || skillHooksCompiled?.onRunStop !== undefined
          ? async (state: AgentState): Promise<import("@wudao/core").StopHookDecision> => {
              try {
                const d = await o.hooks?.onRunStop?.(state);
                if (typeof d === "object") return d;
              } catch {
                /* degrade to the overlay */
              }
              return overlayStop(state);
            }
          : undefined;
      // ω-2b (I2-a): the CLI-built retention exclude set — every tool that
      // declared compactionExempt keeps its old results through the cheap
      // compaction tiers. Computed once per run from the CURRENT tool set.
      const retention = compactionRetentionFor(o.tools);
      // ω-1b: the loop-level generic large-result backstop. The spill anchor
      // follows o.workspaceRoot — the SESSION anchor the store/spill/settings
      // writes already read (NOT agentWorkspaceRoot, which the B2 switch can
      // move mid-session). Absent anchor → backstop off (resolver contract).
      const genericShaping = resolveGenericShapingRuntime(
        o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao", "spill", sessionId) : undefined,
        process.env,
      );
      // ω99-4c: lint/test 反射回路 — edit/write 落盘后自动 lint、run 收尾自动
      // test，失败输出回喂模型。进程级单例（boot root 冻结）；未配置 reflect
      // 节 = undefined = hooks 原样（字节零变化）。
      const reflect = o.workspaceRoot !== undefined ? await reflectRuntimeFor(o.workspaceRoot) : undefined;
      // ω99-7: auto-refine 触发层 — 进程级单例；未配置 refine.auto（默认
      // OFF）= undefined = hooks 原样。receipt 走 history notice（不注入对话）。
      const autoRefine = o.workspaceRoot !== undefined
        ? await refineAutoRuntimeFor(o.workspaceRoot, { onNotice: (text) => { appendHistory({ kind: "notice", text }); } })
        : undefined;
      // ω99-319: run 级命令足迹队列（sideTurns 同族纪律）——withCommandFootprint
      // observer 在 hooks 链收，settle 缝消费（changes[].cmd merge +
      // command_footprint 泛型条目 + 快照目录播种）。run 结束即弃（跨 run 零
      // 串扰——每条足迹的归因窗口只在各自命令的 pre/post 配对里）。
      const cmdFootprints: CommandFootprint[] = [];
      const run = runAgentLoop(state, o.model, {
        maxTurns: o.maxTurns,
        // 取证弧 0921（polyglot 三败题根因）: the output-limit ladder ran
        // nudge-only in the product path — escalateTo existed in core, was
        // passed by nothing, so a length-stop retried at the SAME 4096 cap
        // until exhaustion. Supply the profile's continuation tier (undefined
        // on unpinned providers ≡ the absent-object default: nudges, no
        // escalation — byte-identical). Cap-raising fires only on cap-free
        // requests (admission clips keep ownership).
        outputLimitRecovery: { escalateTo: outputLimitEscalateFor(modelLive.provider) },
        gates: plan ? { ...(o.gates ?? {}), plan: true } : o.gates,
        // M53 §5: the --no-loop-safety ablation seam (core stays env-free).
        ...(isFeatureAblated("loop-safety") ? { loopSafety: false } : {}),
        ...(genericShaping !== undefined ? { genericResultShaping: genericShaping } : {}),
        // ω-4b: the reflection fork arms at second loop verdicts (core
        // default OFF — the CLI wiring is the opt-in layer); the
        // --no-loop-reflection ablation keeps it off.
        ...(isFeatureAblated("loop-reflection") ? {} : { reflection: {} }),
        canUseTool: gate,
        // M62 §7: compaction === undefined (autoCompactEnabled:false from the
        // frontends) reaches the loop as NO compaction — the old spread of
        // `...undefined` would have silently re-armed it with the default
        // window.
        ...(o.compaction !== undefined
          ? {
              compaction: {
                ...o.compaction,
                // 借鉴弧 B1：压缩经济学定价（catalog > env > 缺省；显式值优先）。
                ...(o.compaction.cachePricing === undefined ? { cachePricing: resolveSessionCachePricing(modelLive.provider, modelLive.model ?? o.model.modelId) } : {}),
                classifySkillRead: createSkillReadClassifier(o.skills ?? []),
                // ω-2b (I2-a): the retention exclude set (see `retention`
                // above — undefined = no exempt tool, status-quo options).
                ...(retention !== undefined ? { retention } : {}),
                // M58 §C#2: the standing rider reaches the loop's own compactions
                // (an explicit caller-provided compactInstructions still wins).
                ...(o.compaction.compactInstructions === undefined && compactInstructionsRider !== undefined
                  ? { compactInstructions: compactInstructionsRider }
                  : {}),
                // M58 §C#12: the session's CURRENT reasoning_effort rides every
                // tier-2 summary request (read at run start — settled /model //effort
                // switches count; an explicit caller value wins, same rule as the
                // rider).
                // ω99-245: #9 — THIS read is the effort window PIN (codex
                // session/reasoning_effort.rs 四转移的本地形态): ①变更=轮界
                // 事件（运行中 /effort 只停泊 pendingModelApply，收束才落地）；
                // ②本 read = 采样建 pin——run 内 modelLive 不再变，采样与压缩
                // 共用同一快照；③压缩只读快照绝不写状态（摘要失败走静态回退，
                // pin 与停泊双存活——R4 失败路径钉）；④收束落地后下一 run 重
                // 读 = 重建基线。空闲 /compact 读 live 值是正确面：无采样窗口
                // 打开，用户最新意图即基线（裁定见 omega99-245 报告 §一）。
                ...(o.compaction.reasoningEffort === undefined && modelLive.effort !== undefined && modelLive.effort !== ""
                  ? { reasoningEffort: modelLive.effort }
                  : {}),
                // 125 项 1（codex 窗口链）: the rotation identity — read at run
                // start (baseWindowCount = boundaries landed so far, this
                // process's or rebuilt from the entries at boot/resume); the
                // loop advances the index per in-run boundary. sessionKey =
                // the session id's short prefix (the chain is unique within
                // one session as sessionKey#N — no separate UUID needed).
                windowIdentity: {
                  sessionKey: sessionId.slice(0, 8),
                  baseWindowCount: windowBoundaryCount,
                },
                // 125 项 2（codex WorldState 差分）: the diff baseline (the
                // last boundary's snapshot; absent on a never-compacted
                // session → the first rotation injects no diff) + the
                // extractor the loop calls at each rotation. In-run chaining
                // is the loop's own (the second compaction diffs against the
                // first's snapshot, not this stale baseline).
                worldState: {
                  ...(lastWorldSnapshot !== undefined ? { previous: lastWorldSnapshot } : {}),
                  snapshot: worldStateSnapshot,
                },
              },
            }
          : {}),
        // 125 项 1：模型侧轮转端口——宿主盒（工具读同一实例）+ 会话已用额度
        // （boot 重放 + 本引擎事件自增；loop 在运行期装实现）。压缩关或盒缺
        // 席 = 不装（new_context 工具 fail-closed 或根本未注册）。
        ...(o.compaction !== undefined && o.contextRotationBox !== undefined
          ? { contextRotation: { port: o.contextRotationBox, rotationsUsed: agentRotationsUsed } }
          : {}),
        // ω99-53: the same CURRENT effort as the trail — every pushed
        // assistant message this run (final + interrupted partials) carries
        // it as persistence-only metadata, so cache-report can attribute an
        // effort-switch cold turn later. Same read-at-run-start rule and
        // same guard as the compaction thread above (empty = unset).
        ...(modelLive.effort !== undefined && modelLive.effort !== ""
          ? { effortSent: modelLive.effort }
          : {}),
        signal: ac.signal,
        // M63-C §3: the skill-position overlay composes OVER the configured
        // hooks for every run (armed at /skill invocation).
        hooks: (() => {
          const base = skillHooksCompiled !== undefined ? composeAgentHooks(o.hooks, skillHooksCompiled) : o.hooks;
          const withStop = composedStop !== undefined ? { ...base, onRunStop: composedStop } : base;
          // ω99-4c: reflect composes INNERMOST (last-consulted) — a
          // user/skill/goal stop decision outranks the reflection's block.
          // ω99-7: auto-refine composes OUTERMOST as a pure OBSERVER — the
          // chain above decides the stop; a refine may only follow a stop.
          // ω99-314: 快照写前捕获再叠一层 observe-only（先捕获后委托，永不
          // block/改写）——onPreToolUse 在 canUseTool 之前跑，bypass/auto 模式
          // 下捕获同样在场。路径按 LIVE agent root 解析（工具写哪照哪）。
          const reflected = observeAutoRefineOnHooks(composeReflectHooks(withStop, reflect), autoRefine, () => o.model);
          const captured = withSnapshotCapture(reflected, o.snapshots, () => o.agentRootBox?.current ?? o.workspaceRoot);
          // ω99-319: 命令足迹 observer 叠最外层（observe-only：shell 前后配对
          // 扫描，永不 block/改写；非 shell 零扫描零成本；after 内容播种走
          // 314 快照仓）。emit 进本 run 的 cmdFootprints 队列——M24：全程旁路
          // 模型可见面，产出只走 settle 的 appendEntries。
          return withCommandFootprint(captured, {
            ...(o.snapshots !== undefined ? { store: o.snapshots } : {}),
            liveRoot: () => o.agentRootBox?.current ?? o.workspaceRoot,
            emit: (fp) => { cmdFootprints.push(fp); },
          });
        })(),
        steering: { take },
        // 124b 项 1：流抢占通道（见 streamPreemptRef 的注释）——loop 拿它
        // 给每次模型调用换新 signal；AbortError 归类出抢占时被弃 partial
        // 走旁路审计（stream_preempted 事件），循环立即续跑注入新指令。
        streamPreempt: preemptChannel,
        // 弧 δ — the loop seam (TDZ discipline same as onToolUpdate: the
        // callback only fires after toolMeta exists).
        toolDetach: detachLane.loopOptions.toolDetach,
        onDetachedCall: (d) => {
          detachLane.register(d, toolMeta.get(d.call.id)?.summary ?? "");
        },
        // ω99-63: the run's identified-delta consumer — the loop enriches
        // every delta with its call's identity (core invariant, the ONE
        // execution point), so the driver only routes: match the busyTools
        // row by callId and fold a per-call bounded tail (append concatenates,
        // snapshot replaces the whole view; both clip to the LAST cap chars —
        // the row payload is O(1) bounded, LiveState never grows unbounded).
        // The field is assigned ON THE ELEMENT, never a rebuilt { ...t, tail }
        // — the finished/abort paths remove busy rows by OBJECT IDENTITY (the
        // setGating abort-review I1 rule); only the container refreshes, like
        // every other busyTools write. emit() fires per delta: the tool-side
        // publisher (ω99-49 AdaptivePublisher) already rate-limits the stream,
        // and getStatus() only refreshes through emit — the per-beat tail must
        // land in the snapshot immediately.
        onToolUpdate: (delta) => {
          const row = busyEntries.get(delta.toolCallId);
          if (row === undefined) return; // no busy row (finished/denied) — nothing to show
          const next = delta.kind === "append" ? (row.tail ?? "") + delta.text : delta.text;
          row.tail = next.length > BUSY_TAIL_CAP_CHARS ? truncateTailSafe(next, BUSY_TAIL_CAP_CHARS) : next;
          live = { ...live, busyTools: [...live.busyTools] };
          emit();
        },
        // ω99-68 (ω99-48 停泊债的 CLI 接线): the failed-attempt settlement
        // seam — when a streaming attempt dies mid-flight (non-abort), core
        // hands the COMPLETE log-only assistant_attempt entry HERE (the call
        // awaited before the rethrow, isolated by its own safeCall). The
        // driver owns the injected session store, so this is a verbatim
        // pass-through onto the M35 §2 generic lane: no field added, dropped,
        // or rewritten, no buildXxxEntry helper — the entry is not a message
        // and never re-enters the model-visible history (load() filters
        // generic entries). Threaded only when a store was supplied; abort
        // paths never fire it (core guards — the 夜移 001 interrupted twin
        // keeps its bytes instead). sessionId is read at call time (the
        // goalController appendEntry idiom), so a mid-run session rotation
        // still writes to the live id.
        ...(sessionStore !== undefined
          ? {
              appendAttemptEntry: (entry: Parameters<NonNullable<LoopOptions["appendAttemptEntry"]>>[0]) =>
                sessionStore.appendEntry(sessionId, entry),
            }
          : {}),
        // M62 §1: path-gated context rules (absent when the workspace has none).
        ...(o.contextRules !== undefined ? { contextRules: o.contextRules } : {}),
        // M32: external changes surface as <file_changed> MetaNotes riding the
        // last tool_result tail (projection-only — history stays clean).
        ...(prober !== null ? { beforeModelCall: () => prober.probe() } : {}),
        // 0.3.10：take() 记录被消费注记的来源——与 loop 合并后的 meta_note
        // 事件按批配对（事件到达时 splice 收割；单线程下 take 与 yield 间
        // 无交错）。返回类型仍是 string（loop 缝零改动）。
        metaNotes: {
          take: () => {
            const note = metaNotes.shift();
            if (note !== undefined) takenNoteSources.push(note.source);
            return note?.text;
          },
        },
        // 夜移 003（codex time_reminder）：周期性当前时间 grounding——run 首
        // 轮必注入、其后墙钟漂移 ≥30min 再注入；走 MetaNote 投影（前缀缓存
        // 安全、不落盘）。纯模型侧信息，人类侧 notice 过滤（见 meta_note）。
        timeReminder: { intervalMs: 30 * 60_000 },
        // 夜移 035 (codex turn_timing): the run's phase recorder, threaded
        // verbatim (consumer-owned — created before the run, completed+read
        // at the consumer's settle; complete is idempotent).
        ...(o.turnProfile !== undefined ? { turnProfile: o.turnProfile } : {}),
        // 波次 8 #45 (dsh #17): pre-dispatch durability barrier — threaded
        // straight through when the frontend supplies one.
        ...(o.onBeforeToolDispatch !== undefined ? { onBeforeToolDispatch: o.onBeforeToolDispatch } : {}),
        // 夜移 036: the driver owns the session-lifetime budget; the loop
        // pairs it with the root threadId (runSubagent rebinds per child).
        ...(o.sessionBudget !== undefined
          ? { sessionBudget: { budget: o.sessionBudget, threadId: "root" } }
          : {}),
      });
      gen = run;

      // M25 §A5: context watermark refresh — same occupancy measure the loop's
      // compaction trigger uses (max(estimate, last real prompt usage)), so
      // the status bar never disagrees with the compactor about "nearly full".
      // M51 §4 (A8): after a compaction the window is UNKNOWN until the next
      // real usage — keep `used: null` (the bar shows `ctx …/M`) instead of
      // repainting a stale estimate over the rewritten history.
      const updateCtxTokens = (fromUsage = false): void => {
        const window = o.compaction?.contextWindowTokens ?? 64_000;
        if (ctxUnknown && !fromUsage) {
          ctxTokens = { used: null, window, nearLimit: false };
          emit();
          return;
        }
        if (fromUsage) ctxUnknown = false;
        const toolDefs = state.tools.map(toModelToolDefinition);
        const used = Math.max(
          estimateTokens(state.systemPrompt, toolDefs, state.messages),
          lastPromptTokens,
        );
        ctxTokens = { used, window, nearLimit: used >= 0.8 * window };
        emit();
      };

      // Identity-keyed bookkeeping: started events stash name+summary keyed by
      // toolCallId (never leaked into public types); finished events build the
      // history entry from that stash. A diffShown flag marks calls whose diff
      // entry already landed in history at started — write_file overwrites
      // (existing file → new content) and every edit — so failures can be
      // surfaced at completion.
      const toolMeta = new Map<string, { name: string; summary: string; diffShown?: boolean }>();
      const busyEntries = new Map<string, { name: string; summary: string; callId?: string; tail?: string }>();
      // ω99-79: arm the subagent box for THIS run — the task tool's
      // loopOptions forward every child's identified delta (core ω99-76,
      // `sub:<childIdentity>:<rawId>`) onto box.sink. Rows key on the
      // childIdentity SEGMENT, never the full namespaced id: a child
      // switching raw tools (call_0 → call_1) keeps ONE row, its summary
      // tracking the latest toolName and its tail showing the latest tool's
      // bounded end. The row builds LAZILY on first delta (children never
      // produce a tool_call_started in the parent stream); the tail follows
      // the parent sink's exact discipline (append concatenates, snapshot
      // replaces, both clip to the LAST BUSY_TAIL_CAP_CHARS; the field lands
      // ON THE ELEMENT, only the container refreshes — the object-identity
      // removal rule). The sub: guard keeps this sink child-only: a
      // parent-shaped id is the loopOptions sink's traffic above, untouched.
      if (o.subagentUpdateBox !== undefined) {
        o.subagentUpdateBox.sink = (delta: IdentifiedOutputDelta): void => {
          if (!delta.toolCallId.startsWith("sub:")) return;
          const childIdentity = delta.toolCallId.split(":")[1];
          if (childIdentity === undefined || childIdentity === "") return;
          let row = busyEntries.get(childIdentity);
          if (row === undefined) {
            row = { name: "subagent", summary: delta.toolName, callId: childIdentity };
            busyEntries.set(childIdentity, row);
            live = { ...live, busyTools: [...live.busyTools, row] };
          }
          row.summary = delta.toolName;
          const next = delta.kind === "append" ? (row.tail ?? "") + delta.text : delta.text;
          row.tail = next.length > BUSY_TAIL_CAP_CHARS ? truncateTailSafe(next, BUSY_TAIL_CAP_CHARS) : next;
          live = { ...live, busyTools: [...live.busyTools] };
          emit();
        };
      }
      // ω99-86 (53 停泊债清偿): arm the live-effort box for THIS run — the
      // task tool's spawn site reads box.get() so every child dispatched
      // inside the run carries the SAME current effort level this run's own
      // requests/trail carry (modelLive.effort, read through the closure at
      // spawn time — a mid-run setter change stays live for later spawns of
      // the same run, exactly like the loopOptions seam above). Cleared at
      // the run's finally seam (below) so an idle-period spawn reads an
      // unarmed slot — the documented 79-style degradation.
      if (o.effortLiveBox !== undefined) {
        o.effortLiveBox.get = () => modelLive.effort;
      }
      // M49 §2: the run's review trigger facts — tool-call count and success
      // (interrupted / aborted / errored runs never spawn a review).
      let runToolCalls = 0;
      // ω99-315: the run's 断流重连 counter — only the idle class (a hung
      // connection the providers' dual-tier watchdog killed), folded into the
      // settle stats receipt. Network-class recoveries deliberately don't
      // count (they're ordinary transport retries, not watchdog kills).
      let runIdleReconnects = 0;
      // 借鉴弧 B1：本 run 的存量缓存债（最新经济学回执，run-stats 面）。
      let runCacheDebtTokens = 0;
      // ω99-320: the run's soft-idle-warn counter — the soft tier's pure
      // callback (315) finally surfaces: every warn of every stream this run
      // fired (multiple model calls accrue; the semantics are「本 run 所有流
      // 的所有软警告之和」, 如实不夸大——不是 N 次断流). The FIRST warn also
      // lands ONE gentle live notice (「还活着」——90s 静默期用户不再误判死机);
      // later warns count silently (notify 刷屏比静默更糟). Listener cleared
      // at the run's settle seam (迟来回调写不进下一个 run). Pure bypass: the
      // callback object never enters ModelInput/request bytes (M24).
      let softIdleWarns = 0;
      let softWarnNoticeSent = false;
      o.softWarnSlot?.setListener(() => {
        softIdleWarns += 1;
        if (softWarnNoticeSent) return;
        softWarnNoticeSent = true;
        appendHistory({ kind: "notice", text: SOFT_IDLE_WARN_NOTICE });
      });
      // 0.3.15（用户需求：执行耗时可见）：本 run 的墙钟记账。runStartMs 打在
      // run 体入口；llmMs 折算每条 usage 行的 durationMs（reflection/evaluator
      // 分叉也是真实模型耗时，计入），null = 尚无任何行上报（脚本模型——
      // 模型段按 omit-never-null 整体省略，不拿 0 冒充）；toolMs 折算每个
      // finished 调用的 I21 durationMs；lastCallMs 只跟 answering 模型自己的
      // 行（最终回复的自身生成耗时，落在 assistant 条目上）。
      const runStartMs = performance.now();
      // ω99-249: the goal's TURN-BOUNDARY injection — the short <goal_context>
      // status line rides the SAME MetaNote queue 233's mode steering uses
      // (drained by the loop's first model call, projected as a tail-side
      // suffix onto the last tool_result or a trailing user message; never
      // persisted, never in the system prompt — M24 prefix bytes zero-cost).
      // onRunStart also reconciles the ledger 随动 and materializes the goal
      // for a newly-claimed budgeted task; undefined = no goal, zero noise.
      const goalLine = goalRuntime?.onRunStart();
      if (goalLine !== undefined) metaNotes.push({ text: goalLine, source: "目标" });
      // ω99-249: the run's SPLIT usage accumulator — folded into the goal at
      // settle (input=promptTokens, output=completionTokens; every loop usage
      // row counts — the /goal --budget ω99-8b partition: subagent/evaluator
      // calls never reach the loop's usage events, so no extra filter here).
      const runGoalUsage = { input: 0, output: 0 };
      // 夜移 032: the run's net-change ledger starts empty — the previous
      // run's result is NOT carried over (its bytes are the new baseline).
      o.turnDiff?.resetRun();
      let llmMs: number | null = null;
      let toolMs = 0;
      let lastCallMs: number | undefined;
      let runOk = true;
      // v7 γ2——本轮的终态成因（取消/中止留名）：interrupted=true ⇒ user-abort
      // （该旗只有 interrupt() 置位）；detached/shutdownInterrupted/!active ⇒
      // shutdown（前端卸载/关窗的三条落点：事件断流、setActive 置旗、abort
      // 形 throw）；abort 形结束皆非 ⇒ null（成因不可知——绝不臆造，回执维
      // 持无括注旧形）。
      let runEndCause: RunEndCause | null = null;
      // v7 γ2——事件循环因 !active 断流（无 terminal 的中止）：见消费循环的
      // detach 分支。完成形 terminal 不置位（完成了就是完成了，不因事后的
      // deactivate 被改记成中止）。
      let detached = false;
      // v7 γ3——本轮实际服务模型回执：answering usage 行的 fallbackModel/
      // fallbackFrom 标注（M62 §7），最后一次换腿作答胜出（多轮回合的收尾
      // 调用是「本轮由谁答」）。主模型作答=undefined（omit-when-no-fallback，
      // 零噪音）。reflection 行不算（旁路判定不是作答）。
      let runServedBy: { readonly model: string; readonly from?: string } | undefined;
      // M61 §3: the settled terminal, visible to the finally seam (the goal
      // stall guard keys on stopBlockCapped).
      let settledTerminal: Terminal | undefined;
      // ω-4b: the fork's usage row (reflectionTokens-stamped) — parked here
      // so the reflection_fork event can stitch it into its session entry
      // (core emits the usage event immediately before reflection_fork).
      let lastReflectionUsage: import("@wudao/core").ModelUsage | undefined;

      // OOM fix: coalesce delta-driven status emissions. Deltas still
      // accumulate IN FULL — into the ω99-41 chunk buffers, folded into `live`
      // at the emit/materialize seam — and only emit() (the snapshot rebuild +
      // subscriber/render fan-out) is rate-limited to one per window, with a
      // trailing flush at the next non-delta event or run end so no state is
      // ever lost. At streaming rates a per-delta emit re-renders the TUI per
      // token and churns O(n²) accumulated-prefix strings through ink's render
      // caches.
      let deltaEmitTimer: ReturnType<typeof setTimeout> | null = null;
      const flushDeltaEmit = (): void => {
        if (deltaEmitTimer === null) return;
        clearTimeout(deltaEmitTimer);
        deltaEmitTimer = null;
        emit();
      };
      const scheduleDeltaEmit = (): void => {
        if (deltaEmitTimer !== null) return;
        deltaEmitTimer = setTimeout(() => {
          deltaEmitTimer = null;
          emit();
        }, DELTA_EMIT_INTERVAL_MS);
        deltaEmitTimer.unref?.();
      };

      // abort-honesty: a tool still in flight when the run aborts never gets
      // its tool_call_finished (core skips race-lost calls), so its outcome is
      // UNKNOWN — the write may or may not have landed. Mirror the C7-B
      // failure-entry form (kind:"error", same fields) so history never reads
      // as a silent success. Scans live.busyTools — the in-flight set, pruned
      // at tool_call_finished — NOT busyEntries, which retains every started
      // call for the whole run (finished ones included). One-shot flag: the
      // aborted-terminal path and the abort-shaped-throw path below are
      // structurally exclusive, but a settle that re-enters the catch (e.g. a
      // throwing history listener mid-append) must not duplicate entries.
      let abortOutcomeEntriesDone = false;
      const appendAbortOutcomeEntries = (): void => {
        if (abortOutcomeEntriesDone) return;
        abortOutcomeEntriesDone = true;
        for (const busy of live.busyTools) {
          appendHistory({
            kind: "error",
            text: `${busy.name} 失败：运行已中断——结果未知，请在磁盘核验`, // ω99-166c-i: #2 特款（无 ⚠️；interrupted 子句 em-dash→中文破折号；busy.name 插值原样）。
          });
        }
      };

      try {
        // Manual next() loop (not for-await): the generator's return value —
        // the Terminal — carries the "aborted" reason the bookkeeping below
        // keys off; for-await would discard it.
        let terminal: Terminal | undefined;
        for (;;) {
          const r = await run.next();
          if (r.done) {
            terminal = r.value;
            settledTerminal = terminal;
            break;
          }
          const ev = r.value;
          for (const cb of [...eventListeners]) cb(ev);
          o.onEvent?.(ev);
          if (!active) {
            // detached: stop consuming events (close like for-await would)
            // v7 γ2 — detach 是一种「中止」：没有 terminal 的断流，之前
            // 静默走完成结算（无回执、无孤儿修复）。置 detached 旗让下面的
            // interrupted 结算分支接管（关窗成因的回执落点）。
            detached = true;
            void run.return(undefined as never);
            break;
          }
          // Trailing flush: the first non-delta event settles any pending
          // delta window BEFORE its own transition renders (the snapshot the
          // subscriber sees at a tool/model boundary already carries every
          // accumulated delta).
          if (ev.type !== "reasoning_delta" && ev.type !== "assistant_delta") flushDeltaEmit();
          switch (ev.type) {
            case "turn_retried":
              // ω99-315: the run-stats 断流重连 counter keys on the structured
              // class — exactly reasonClass === "idle".
              if (ev.reasonClass === "idle") runIdleReconnects += 1;
              break;
            case "model_call_started":
              // M63 §A: a model call is in flight — /provider refuses while
              // this is set (mid-stream), queues only between calls.
              modelInFlight = true;
              updateCtxTokens();
              break;
            case "model_call_finished":
              modelInFlight = false;
              // Model-call boundaries: refresh the watermark from the current
              // state (pre-call estimate / post-call estimate with the reply).
              updateCtxTokens();
              break;
            case "usage":
              // 0.3.15: fold the row's wall clock into the run's model time
              // (every row — the reflection/evaluator forks are real spend);
              // the answering model's own rows also refresh the final reply's
              // generation stamp.
              if (ev.usage.durationMs !== undefined) {
                llmMs = (llmMs ?? 0) + ev.usage.durationMs;
                if (ev.usage.reflectionTokens === undefined) lastCallMs = ev.usage.durationMs;
              }
              // ω-4b: a side verdict's prompt size never anchors occupancy
              // (or clears the post-compaction unknown) — only the answering
              // model's own rows move the watermark; the row is parked for
              // the reflection_fork entry. /cost still folds it below (the
              // call is real spend).
              if (ev.usage.reflectionTokens !== undefined) {
                lastReflectionUsage = ev.usage;
              } else {
                // The provider's real prompt size beats the estimate — and it
                // is the only thing that clears the post-compaction unknown.
                lastPromptTokens = ev.usage.promptTokens;
                updateCtxTokens(true);
                // v7 γ3——作答行的换腿标注收拢（最后一答胜出）。
                if (ev.usage.fallbackModel !== undefined) {
                  runServedBy = {
                    model: ev.usage.fallbackModel,
                    ...(ev.usage.fallbackFrom !== undefined ? { from: ev.usage.fallbackFrom } : {}),
                  };
                } else {
                  runServedBy = undefined; // 主模型作答的后续调用清掉早前换腿——收尾调用是「本轮由谁答」
                }
              }
              // M55 §A3: fold into the session totals /cost renders.
              usageTotals = recordUsage(usageTotals, ev.usage);
              // ω99-249: the goal's SPLIT meter — per-row here, settled onto
              // the goal in ONE batch at the run boundary (onRunSettle).
              runGoalUsage.input += ev.usage.promptTokens;
              runGoalUsage.output += ev.usage.completionTokens ?? 0;
              break;

            case "reflection_fork": {
              // ω-4b: the loop-safety challenger settled — hand the
              // adjudication to the persistence seam (session-engine appends
              // the loop_reflection entry; front-ends that care render the
              // event itself).
              o.onLoopReflection?.({
                kind: ev.kind,
                evidence: ev.evidence,
                outcome: ev.outcome,
                ...(ev.rationale !== undefined ? { rationale: ev.rationale } : {}),
                ...(ev.directive !== undefined ? { directive: ev.directive } : {}),
                turn: ev.turn,
                ...(lastReflectionUsage !== undefined ? { usage: lastReflectionUsage } : {}),
              });
              lastReflectionUsage = undefined;
              break;
            }

            case "reasoning_delta":
              // ω99-41: buffer, don't rebuild — the fold happens at the next
              // observation seam (emit / flushAssistantSegment / run end).
              reasoningBuf.push(ev.text);
              pendingThinking = true;
              scheduleDeltaEmit();
              break;
            case "assistant_delta":
              // 0.3.8: the body stream opens — the thought is done talking.
              answerBuf.push(ev.text);
              pendingThinking = false;
              scheduleDeltaEmit();
              break;
            case "tool_call_started": {
              // #302: the call's prose is complete the moment its tool phase
              // opens — commit it ahead of the tool entries (chronological).
              flushAssistantSegment();
              const summary = o.summarize(ev.toolName, ev.input);
              // ω99-63: the call's id rides the row from the start (it is
              // known HERE) — the onToolUpdate consumer matches deltas onto
              // rows by this key; without it a delta cannot find its call.
              const busyTool = { name: ev.toolName, summary, callId: ev.toolCallId };
              busyEntries.set(ev.toolCallId, busyTool);
              live = { ...live, busyTools: [...live.busyTools, busyTool] };
              emit();
              // History entries must be complete when pushed: Ink 7's <Static>
              // renders each item once and never re-renders flushed items, so a
              // tool entry mutated later would never show its preview in a real
              // terminal. The in-flight phase is covered by live.busyTools; the
              // tool entry lands at tool_call_finished with the preview set.
              // Edit entries render entirely from the call input (never
              // mutated), so they can push here.
              if (ev.toolName === "edit") {
                appendHistory({
                  kind: "edit",
                  path: str(ev.input.path),
                  oldString: str(ev.input.old_string),
                  newString: str(ev.input.new_string),
                });
                // C7-B: the edit entry above is already immutable in history
                // (Ink <Static> renders once), so a failed or denied call can
                // only surface as a separate error entry at finished — the
                // write_file overwrite precedent below, mirrored. diffShown
                // routes finished there AND keeps the success path silent
                // (the diff already shown stands alone).
                toolMeta.set(ev.toolCallId, { name: ev.toolName, summary, diffShown: true });
              } else if (ev.toolName === "write_file") {
                // Overwriting an existing file renders as a diff (old on-disk
                // content → input.content) via the same DiffView entry. The
                // await resolves before tool_call_finished is consumed, so the
                // fallback (no file / read failure / no workspaceRoot) still
                // stashes toolMeta in time for the preview entry.
                // workspace-ux B2: the diff preview resolves from the LIVE
                // agent root — the same boundary write_file itself uses.
                const existing = await readExistingForDiff(agentWorkspaceRoot, ev.input);
                if (existing !== undefined) {
                  appendHistory({
                    kind: "edit",
                    path: str(ev.input.path),
                    oldString: capDiff(existing),
                    newString: capDiff(str(ev.input.content)),
                  });
                  // Mark that a diff was shown so errors can be surfaced at completion
                  toolMeta.set(ev.toolCallId, { name: ev.toolName, summary, diffShown: true });
                } else {
                  toolMeta.set(ev.toolCallId, { name: ev.toolName, summary });
                }
              } else {
                toolMeta.set(ev.toolCallId, { name: ev.toolName, summary });
              }
              break;
            }
            case "tool_call_finished": {
              runToolCalls += 1;
              // 弧 δ: the backgrounded close — the row converts to a receipt
              // notice (the truth-point receipt; the real result lands later
              // through the lane). No tool entry: nothing settled yet.
              if (ev.backgrounded === true) {
                const meta = toolMeta.get(ev.toolCallId);
                appendHistory({ kind: "notice", text: backgroundedNotice(meta?.name, meta?.summary) });
                const bt0 = busyEntries.get(ev.toolCallId);
                if (bt0) live = { ...live, busyTools: live.busyTools.filter((t) => t !== bt0) };
                emit();
                break;
              }
              // ω99-51: the projection seam's run-time inflow — the result
              // message is already on the chain here, so the todo fold sees
              // each board the moment it lands (subscribers get notified at
              // turn granularity without any consumer paying a rescan).
              todoSource.sync(state.messages);
              // 0.3.15: the I21 per-call wall clock folds into the run's tool
              // time (absent on the never-executed truncated-guard path).
              if (ev.durationMs !== undefined) toolMs += ev.durationMs;
              // M49 §4: record the finished result's provenance against the
              // message object the loop just pushed (WeakMap side channel —
              // verbatim re-packaging inherits the taint inside record()).
              for (let i = state.messages.length - 1; i >= 0; i -= 1) {
                const m = state.messages[i];
                if (m !== undefined && m.role === "tool" && m.toolCallId === ev.toolCallId) {
                  taint.record(m, ev.provenance);
                  break;
                }
              }
              // M23: a todo board result becomes a checklist entry (and feeds
              // the live progress indicator) instead of a plain tool preview.
              const board = parseTodoBoard(ev.result);
              if (board) {
                appendHistory({ kind: "board", done: board.done, total: board.total, lines: board.lines });
                boardProgress = { done: board.done, total: board.total };
                const bt0 = busyEntries.get(ev.toolCallId);
                if (bt0) {
                  live = { ...live, busyTools: live.busyTools.filter((t) => t !== bt0) };
                }
                emit();
                break;
              }
              const meta = toolMeta.get(ev.toolCallId);
              if (meta) {
                // If a diff entry was already shown for a call that failed (an
                // edit, or a write_file over an existing file), surface the
                // error as a separate entry. C7-B M1: core's edit/write_file
                // failure results already carry their own "<name> failed: "
                // prefix (core edit.ts / write-file.ts), so unconditionally
                // re-prepending ours doubled it ("edit failed: edit failed: …").
                // ω99-166d-ii: #27 — the receipt prefix itself goes Chinese
                // (c-i 遗留款); a result leading with the exact Chinese
                // template bytes passes through as-is (still truncated), and a
                // result leading with the legacy English self-prefix gets that
                // lead stripped and re-rendered so exactly ONE prefix shows
                // (the C7-B M1 invariant survives the swap; core keeps its
                // English bytes — those files sit outside this arc's
                // whitelist). The match is byte-exact — no case folding, no
                // fuzzy matching. Results without either prefix (gate denials,
                // stubs, other tools) keep getting the prefix prepended.
                if (meta.diffShown && ev.isError) {
                  const failurePrefix = `${meta.name} 失败：`;
                  const legacySelfPrefix = meta.name + " failed: ";
                  appendHistory({
                    kind: "error",
                    text: ev.result.startsWith(failurePrefix)
                      ? truncate(ev.result, RESULT_PREVIEW_CHARS)
                      : `${failurePrefix}${truncate(
                          ev.result.startsWith(legacySelfPrefix)
                            ? ev.result.slice(legacySelfPrefix.length)
                            : ev.result,
                          RESULT_PREVIEW_CHARS,
                        )}`,
                  });
                } else if (!meta.diffShown) {
                  // ω99-125: a deliverable receipt (make_xlsx/make_pptx/
                  // make_docx, name-gated) rides the entry as `file` for the
                  // web's file card.
                  // Errors never carry it (失败卡没有交付物可定位).
                  const file = ev.isError ? undefined : extractFileReceipt(meta.name, ev.result);
                  // Normal tool entry (no diff was shown)
                  appendHistory({
                    kind: "tool",
                    name: meta.name,
                    summary: meta.summary,
                    isError: ev.isError,
                    resultPreview: ev.result, // 审计完整性（09-16 用户令）：数据层带全文，显示层做披露（web 卡 8/50 行帽+TUI 单行截断）；truncate 只进展示缝不进数据
                    // ω-5b (I21): slow-tool telemetry rides the history receipt.
                    ...(ev.durationMs !== undefined ? { durationMs: ev.durationMs } : {}),
                    ...(file !== undefined ? { file } : {}),
                  });
                }
                // If diffShown && !isError, stay silent (diff already shown)
              }
              const bt = busyEntries.get(ev.toolCallId);
              if (bt) {
                live = { ...live, busyTools: live.busyTools.filter((t) => t !== bt) };
                emit();
              }
              break;
            }
            case "gate_injected": {
              // M23: a stop gate fired — the [system note: …] user message the
              // loop injected. Rendered as a (yellow) notice, never Markdown.
              appendHistory({ kind: "notice", text: ev.text });
              break;
            }
            case "defer_loaded": {
              // M35 §1: the run's one load_tools applied — the caller persists
              // a deferred_loaded entry (§2) and shows the count in the bar.
              // R6 quickwin (ui-review-r5 P2 follow-up): the pick also rides
              // history as a dim notice — the web/TUI render history, not the
              // onDeferLoaded seam (that one only reaches the session store).
              appendHistory({
                kind: "notice",
                text: `⏳ 延迟工具已加载：${ev.names.join(", ")}——定义下一轮并入工具列表（本次运行工具集已冻结）`, // ω99-166e-i: #5（延迟工具加载回执中文化；names 插值原样）
              });
              o.onDeferLoaded?.(ev.names);
              break;
            }
            case "context_rule_loaded": {
              // M62 §1: a gated rule's body entered the history after a
              // matching read — the spec's one-line notice.
              appendHistory({ kind: "notice", text: `已加载 ${ev.source}` }); // ω99-166f-iii: #5
              break;
            }
            case "steered": {
              // The loop consumed a mid-run steer (it is now a normal user
              // message in state.messages); surface the injection as a dim
              // notice so the user sees it took effect.
              // M63-A fix: a BLOCKED steer never entered history — say so,
              // naming the prompt gate's reason, or the user would think the
              // steer landed.
              appendHistory({
                kind: "notice",
                text: ev.blockedReason !== undefined
                  ? `↳ steering blocked by prompt hook (${truncate(ev.blockedReason, 60)}) — text dropped: ${truncate(ev.text, 40)}`
                  : `↳ steering applied: ${truncate(ev.text, 60)}`,
              });
              break;
            }
            case "stream_preempted": {
              // 124b 项 1（codex instant_interrupt）：在飞模型流被用户的
              // 新提交抢占——被弃 partial 已在 loop 侧彻底丢弃（不进转录/
              // JSONL/模型所见，M24），这里做三件事：
              //   (1) UI 保真：已流出的文本展示为一条助手条目（UI-only——
              //       用户看着它流出来，静默消失才是断崖）；
              //   (2) live 缓冲清零：被弃文本不得漏进后续段/收尾条目
              //       （flushAssistantSegment 读 state.messages，看不到被
              //       弃内容，不会自己清）；
              //   (3) 旁路审计 + 用户提示：量/时刻落 .wudao/logs/stream-
              //       preempt-audit.jsonl（不进会话 JSONL），notice 告知
              //       已中断且新指令正在处理。
              materializePending();
              if (live.answer !== "" || live.reasoning !== "") {
                appendHistory({
                  kind: "assistant",
                  text: live.answer,
                  ...(live.reasoning !== "" ? { reasoning: live.reasoning } : {}),
                });
                reasoningMark = 0;
                live = { ...live, reasoning: "", answer: "" };
                emit();
              }
              if (o.workspaceRoot !== undefined) {
                void appendStreamPreemptAudit(o.workspaceRoot, {
                  at: ev.preemptedAt,
                  turn: ev.turn,
                  droppedTextChars: ev.droppedTextChars,
                  droppedReasoningChars: ev.droppedReasoningChars,
                  ...(sessionId !== undefined ? { sessionId } : {}),
                }).catch(() => { /* 旁路审计 fire-and-forget：失败绝不打断运行 */ });
              }
              appendHistory({
                kind: "notice",
                text: `⚡ 已中断当前生成（${ev.droppedTextChars + ev.droppedReasoningChars} 字被弃）——正在处理你的新指令`,
              });
              break;
            }
            case "meta_note": {
              // M32: a system-class note (file_changed diff, …) was projected
              // for this model call. The model sees the full payload; the
              // human gets a preview. 0.3.6 反馈：预览剥掉 <system_note>
              // 投影包装（那是给模型的信封，不是给人看的），折叠空白成
              // 单行再截断。0.3.7：截断丢信息时携带全文 detail。0.3.9
              // （用户裁定）：注入上下文是模型可见的会话内容——卡片形态
              // 而非胶囊（胶囊专属 harness 内部状态，与模型上下文无关
              // 的才用胶囊）；↳ 前缀随胶囊形态退役。0.3.10（用户反馈：
              // 「系统注入」太笼统，要标明是什么钩子）：take() 时记录的
              // 来源整批收割——loop 把本批注记并成一个事件，多来源去重后
              // 以「 + 」连接；loop 内部注入（safety/hook 上下文）不经
              // 驱动队列、无来源 → 不带 source 字段，前端回退「系统注入」。
              // 夜移 003：时间提醒是纯模型侧 grounding——用户的时钟就在
              // 屏幕上，告知几点不是可操作信息。整批注记剥掉时间信封后
              // 为空 → 不发 notice；合并批次里则只剥时间、其余照常展示。
              const humanText = ev.text.replace(/<system_note>\s*\[current time: [^\]]*\]\s*<\/system_note>\n?/g, "");
              if (notePreview(humanText) === "") break;
              const sources = [...new Set(takenNoteSources.splice(0))];
              const full = notePreview(humanText, false);
              const line = truncate(notePreview(humanText), 100);
              appendHistory({
                kind: "notice",
                text: line,
                card: true,
                ...(sources.length > 0 ? { source: sources.join(" + ") } : {}),
                ...(full !== line ? { detail: full } : {}),
              });
              break;
            }
            case "prompt_blocked": {
              // M63-B: the user-channel notice for a submit-time prompt block
              // (the model sees the [prompt blocked] replacement instead).
              appendHistory({ kind: "notice", text: `⛔ 提示词被钩子拦截：${truncate(ev.reason, 80)}` }); // ω99-166f-iii: #6
              break;
            }
            case "compact_deferred": {
              // M63-A: a PreCompact hook deferred this compaction — one dim
              // notice so the user sees why the context stayed big.
              appendHistory({ kind: "notice", text: `⏸ 压缩已推迟：${ev.reason}` }); // ω99-166f-iii: #7
              if (ev.economics !== undefined) runCacheDebtTokens = ev.economics.carriedDebtTokens; // 借鉴弧 B1：回执采样
              break;
            }
            case "output_limit_recovery": {
              // 夜移 013 surfacing: without these notices a cut answer is
              // indistinguishable from a finished one in every frontend. The
              // nudge line is dim (the continuation streams right after); the
              // exhausted line is the ⚠️ incompleteness marker.
              appendHistory({
                kind: "notice",
                text: ev.kind === "nudge"
                  ? `✂️ 输出被截断，已请求从中断处继续${ev.maxTokens !== undefined ? `（输出上限提升至 ${ev.maxTokens}）` : ""}…`
                  : "⚠️ 输出被截断：续写次数用尽，回答可能不完整",
              });
              break;
            }
            case "empty_final_recovery": {
              // 夜移 024 surfacing (the 013 idiom): a blank final answer is
              // indistinguishable from a finished one without these lines.
              // The nudge line is dim (the retry streams right after); the
              // exhausted line is the ⚠️ emptiness marker.
              appendHistory({
                kind: "notice",
                text: ev.kind === "nudge"
                  ? "🕳 模型未给出可见回答，已要求重答…"
                  : "⚠️ 模型未给出可见回答：重答次数用尽，回答可能为空",
              });
              break;
            }
            case "compacted": {
              // M25 §A4: transparency — magnitudes, tier word, trigger word.
              appendHistory({
                kind: "notice",
                text: formatCompactedLine(ev.tier, ev.trigger, ev.beforeTokens, ev.afterTokens),
              });
              if (ev.economics !== undefined) runCacheDebtTokens = ev.economics.carriedDebtTokens; // 借鉴弧 B1：入账后的新债为现值
              // ω99-249: the live goal's lifetime compaction count — mid-turn
              // compaction + same-run continuation just counts (persisted on
              // the next settle row; prime's queue/rollback has no equivalent
              // here and none is invented).
              goalRuntime?.onCompacted();
              // M51 §4 (A8): the context just got rewritten — occupancy is
              // unknown until the next real usage. Show `ctx …/M`, not a
              // stale number.
              ctxUnknown = true;
              ctxTokens = { used: null, window: o.compaction?.contextWindowTokens ?? 64_000, nearLimit: false };
              emit();
              // M63-A: the session continues across a compaction boundary —
              // a SessionStart source the picker can hook.
              sessionStartHook("compact");
              // M63-C §3: compaction clears the skill-position scope.
              clearSkillHooks("compaction");
              // Tier-2 marker: persist immediately so the JSONL is authoritative
              // even if the run dies mid-flight (mirrors the one-shot CLI).
              if (ev.summaryMessage) o.onCompacted?.(ev.summaryMessage);
              // M52 §1: the boundary entry rides the same event — the session
              // records where the kept region began (chain continuation).
              // 125 项 1/项 2: the rotation's windowIndex + worldState ride the
              // entry (additive fields) and advance this process's chain
              // bookkeeping so the next run's baseWindowCount/diff baseline
              // are current without re-reading the file.
              if (ev.firstKeptEntryId !== undefined) {
                o.onCompactBoundary?.({
                  firstKeptEntryId: ev.firstKeptEntryId,
                  reason: ev.reason,
                  tier: ev.tier,
                  ...(ev.windowIndex !== undefined ? { windowIndex: ev.windowIndex } : {}),
                  ...(ev.worldState !== undefined ? { worldState: ev.worldState } : {}),
                });
                if (ev.windowIndex !== undefined) windowBoundaryCount = Math.max(windowBoundaryCount, ev.windowIndex);
                if (ev.worldState !== undefined) lastWorldSnapshot = ev.worldState;
              }
              // 125 项 1: an agent-initiated rotation — the budget counter ticks
              // HERE and the host seam persists the context_rotation JSONL row
              // (its durable half; resume replays the count from it).
              if (ev.agentRotation !== undefined) {
                agentRotationsUsed += 1;
                o.onContextRotation?.(ev.agentRotation);
              }
              break;
            }
            default:
              break;
          }
        }
        // ω99-41: a terminal landing inside the delta window leaves the tail
        // buffered — fold before the run-end reads of live.reasoning below (the
        // interrupted-partial and final-reply reasoning slices must stay
        // byte-identical to the old synchronous accumulation).
        materializePending();
        // Aborted runs (Esc/^C, or the loop's own abort terminal) get the same
        // session-consistency treatment as error turns: a synthetic assistant
        // reply keeps alternation provider-legal. 夜移 001 (dsh interrupted-
        // stream finalization): a mid-stream abort may ALREADY have committed
        // the delivered prefix as an `interrupted` assistant — then the
        // synthetic would stack a second assistant on the real one, so it is
        // skipped, and the transcript gets the REAL text (not just a notice).
        if (interrupted || terminal?.reason === "aborted" || detached || shutdownInterrupted) {
          runOk = false;
          runEndCause = interrupted ? "user-abort" : detached || shutdownInterrupted || !active ? "shutdown" : null;
          const tail = state.messages.at(-1);
          const committedPartial = tail?.role === "assistant" && tail.interrupted === true ? tail : undefined;
          if (tail?.role !== "assistant") {
            state.messages.push({ role: "assistant", content: "(interrupted)" });
          }
          if (committedPartial !== undefined) {
            appendHistory({
              kind: "assistant",
              text: committedPartial.content,
              // #302: only the reasoning that streamed since the last flushed
              // segment — earlier slices already ride their own entries.
              ...(live.reasoning.length > reasoningMark
                ? { reasoning: live.reasoning.slice(reasoningMark) }
                : {}),
            });
          }
          // An abort during the tool phase can leave the assistant toolCalls
          // without tool results — repair in place or the NEXT run's
          // ModelInput gets an illegal sequence (provider 400).
          state.messages = repairOrphanedToolCalls(state.messages);
          // abort-honesty: surface still-in-flight tools before the notice
          // (the notice stays last).
          appendAbortOutcomeEntries();
          // v7 γ2——中断留名：成因非用户手动（关窗/看门狗）时括注人话；用户
          // 手动停止维持 166c-ii 逐字节旧形（= repl :1940/:1981 逐字——用户
          // 刚按了停止，成因自明，括注是噪音）；成因不可知（null）也维持
          // 旧形（绝不臆造）。结构化成因恒入 run_end_receipt（下文 settle 块）。
          appendHistory({ kind: "notice", text: interruptedNotice(runEndCause) });
          // ω99-166c-ii: #1 interrupted 族中文化（= repl :1940/:1981 逐字）。
        } else {
          const finalMsg = lastAssistantAnswer(state.messages);
          if (finalMsg) {
            // 0.3.8: the turn's accumulated thought rides the committed reply
            // (UI history only — state.messages and request bytes untouched).
            // 0.3.29 (#302): intermediate segments already carried their own
            // call-window reasoning at each tool boundary — the final entry
            // takes only what streamed since the last boundary (single-call
            // turns: reasoningMark === 0, byte-identical to the old behavior).
            appendHistory({
              kind: "assistant",
              text: finalMsg.content,
              ...(live.reasoning.length > reasoningMark
                ? { reasoning: live.reasoning.slice(reasoningMark) }
                : {}),
              // 0.3.15: the reply's own generation time (the final answering
              // call's durationMs; absent when the provider never reported).
              ...(lastCallMs !== undefined ? { durationMs: lastCallMs } : {}),
              // v7 γ3——本轮实际服务模型回执（换腿作答才带；主模型=缺席
              // 零噪音）。UI 历史面，永不回写 state.messages（M24 零影响）。
              ...(runServedBy !== undefined ? { servedBy: runServedBy } : {}),
            });
          }
        }
      } catch (err) {
        if (interrupted || isAbortError(err)) {
          runOk = false;
          runEndCause = interrupted ? "user-abort" : detached || shutdownInterrupted || !active ? "shutdown" : null;
          // Abort-shaped throw (belt-and-braces path): same bookkeeping as the
          // aborted terminal above — never surfaced as a run error. 夜移 001:
          // skip the synthetic when the loop already committed a partial.
          if (state.messages.at(-1)?.role !== "assistant") {
            state.messages.push({ role: "assistant", content: "(interrupted)" });
          }
          state.messages = repairOrphanedToolCalls(state.messages);
          // abort-honesty: same in-flight surfacing as the aborted-terminal
          // path above (the one-shot helper guarantees exactly-once).
          appendAbortOutcomeEntries();
          // v7 γ2——孪生臂同款中断留名（见 aborted-terminal 路径注）。
          appendHistory({ kind: "notice", text: interruptedNotice(runEndCause) });
          // ω99-166c-ii: #2 interrupted 族中文化（孪生臂同款）。
        } else if (isQuotaParkError(err)) {
          // 113-B3（prime-agent #2375 形）— the account-quota park arm. The
          // run ends in the new PARKED terminal (not the ordinary failure):
          // one Chinese notice with the reset moment, one quota_park
          // attribution row on the M35 §2 generic lane (never model-visible),
          // and a one-shot wake at resetAt+30s on the M61 scheduler whose
          // marker the drain seams decode into continueSession on THIS
          // session. M24: state.messages is untouched — the user/tool tail a
          // quota 429 lands on IS the continue-able shape (isUnfinishedTail),
          // so the wake replays the warm prefix with zero synthetic messages.
          // Bounded: >8 cumulative parks per session, or a reset >24h out,
          // give up (the ordinary error terminal, honestly attributed).
          runOk = false;
          const provider = err.provider ?? "unknown";
          const attempt = quotaParks + 1;
          const horizonBreach = err.resetAt.getTime() - Date.now() > QUOTA_PARK_RESET_HORIZON_MS;
          const withinCap = attempt <= QUOTA_PARK_MAX_PER_SESSION;
          const parkStore = sessionStore !== undefined || o.workspaceRoot !== undefined
            ? (sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions")))
            : undefined;
          quotaParks = attempt; // the JSONL row below is the same count's durable half
          if (withinCap && !horizonBreach) {
            parked = { provider, resetAt: err.resetAt.toISOString(), attempt };
            // Parked ≠ failed: state.status keeps "running" (the finally seam
            // below resets it to idle) — the face is DriverStatus.parked.
            appendHistory({ kind: "notice", text: formatQuotaParkNotice({ provider, resetAt: err.resetAt, attempt }) });
            parkStore?.appendEntry(sessionId, quotaParkEntry({ provider, resetAt: err.resetAt.toISOString(), attempt }))
              .catch(() => { /* 217 best-effort law: a failed persist never breaks the settle seam */ });
            // The wake one-shot (resetAt+30s margin). A refused scheduler
            // (kill-switch env / symlinked store) degrades to an honest
            // manual-continue notice — the park itself stands.
            void o.cron?.createTask({ prompt: quotaWakePrompt(sessionId), schedule: { type: "at", at: err.resetAt.getTime() + QUOTA_PARK_WAKE_MARGIN_MS } })
              .then(() => undefined, () => {
                appendHistory({ kind: "notice", text: "⚠️ 无法注册自动唤醒（调度器不可用）——请在配额恢复后手动继续（提交任意消息即可续跑）" });
                emit();
              });
          } else {
            const reason = !withinCap ? "cap" as const : "horizon" as const;
            const giveUpText = formatQuotaGiveUpNotice({ provider, resetAt: err.resetAt, attempt, reason });
            parked = null;
            state.status = "error";
            appendHistory({ kind: "error", text: giveUpText });
            stopFailureHook("error", giveUpText);
            // isErrorTail shape ("(error: …" prefix) — a later manual
            // /continue still adopts the session (ω99-289 error arm).
            state.messages.push({ role: "assistant", content: `(error: ${giveUpText})` });
            parkStore?.appendEntry(sessionId, quotaParkEntry({ provider, resetAt: err.resetAt.toISOString(), attempt, gaveUp: true, reason }))
              .catch(() => { /* same best-effort law */ });
          }
        } else {
          // Error isolation (M12): report in the history and append a synthetic
          // assistant reply so it never ends on a user message.
          runOk = false;
          const msg = err instanceof Error ? err.message : String(err);
          state.status = "error";
          appendHistory({ kind: "error", text: msg });
          // M63-B: the failed-run observability face (kind = the error class).
          stopFailureHook(
            (err instanceof Error && err.name === "ContextLengthError") || (err instanceof Error && /context length|too big|413/i.test(err.message)) ? "context" : "error",
            msg,
          );
          state.messages.push({ role: "assistant", content: `(error: ${msg})` });
        }
      } finally {
        // Settle any pending delta window before the run-end state change —
        // the clearing emit below is the one subscribers see, and a stale
        // timer must not outlive the run.
        flushDeltaEmit();
        gen = null;
        abort = null;
        // ω99-79: disarm the subagent box at the run's own terminal (the
        // same finally that resets busyTools below — the sub rows ride that
        // reset, and the box must stop accepting: a detached child's late
        // deltas no-op on the cleared slot instead of writing phantom rows
        // into the NEXT run's live). Covers ok / interrupted / error /
        // inactive — every exit the seam settles.
        if (o.subagentUpdateBox !== undefined) o.subagentUpdateBox.sink = undefined;
        // ω99-320: the soft-warn slot's disarm — the run's own terminal (ok /
        // interrupted / error / inactive alike). The counter lives in the run
        // closure, so the settle stats below still read the full count (no
        // stream is alive here — nothing can fire between disarm and settle).
        // A late guard callback lands on the cleared slot (no-op), never in
        // the NEXT run's counts.
        o.softWarnSlot?.setListener(undefined);
        // ω99-86: the live-effort box's twin disarm — the run's own terminal
        // (ok / interrupted / error / inactive alike). A spawn AFTER the run
        // (idle dispatch) reads the cleared slot and falls back to the
        // session's own effort baseline, never a stale run's level.
        if (o.effortLiveBox !== undefined) o.effortLiveBox.get = undefined;
        // workspace-ux B2 race: busy=false is the driver's PUBLIC idle signal
        // — a peer that reads it (or submits on it) must never see the stale
        // agent root. The parked switch lands real-fs awaits deep in the seam
        // below, so the ACTIVE path clears busy only after it HAS landed
        // (right before the queue drain); the inactive path skips the seam
        // entirely (its parked switches are dropped), so it clears here.
        if (!active) busy = false;
        powerGuard.sync(busy && pendingPermission === null);
        // cc-plugins A3: an extension rescan parked while this run was in
        // flight lands HERE — the turn boundary. The settled run's requests
        // all carried the old prompt/hooks bytes; the NEXT run reads the new
        // ones (deliberate symmetry with pendingModelApply: an interrupted
        // run settles here too, so a queued rescan survives an Esc).
        if (pendingExtSwap !== null) {
          const swap = pendingExtSwap;
          pendingExtSwap = null;
          applyExtSwap(swap);
          if (active) appendHistory({ kind: "notice", text: "↻ 扩展重扫已在运行收束时落地——下一轮带上新的技能/插件/钩子" }); // ω99-166f-iii: #9
        }
        // 夜移 018: the late tools parked while this run was in flight land
        // HERE — the turn boundary (same symmetry as the ext swap above).
        if (pendingTools.length > 0) {
          const list = pendingTools;
          pendingTools = [];
          landTools(list, true);
        }
        // M63 §A: the mid-stream guard is per-run — an aborted call that
        // never reached model_call_finished must not wedge /provider closed.
        modelInFlight = false;
        if (state.status === "running") state.status = "idle";
        // v7 γ2——终态成因回执（a reference harness #6162 的 wudao 落点）：取消/中止的
        // run 在会话 JSONL 留「谁/什么结束了它」的结构化一行（含 user-abort
        // ——UI 括注是噪音，账面不缺席）；正常/失败结束缺席（omit-when-no-
        // cause，老读侧零感知）。resume/考古面据此回答「这轮为什么没了」。
        // 刻意住在 if (active) 泳道之外：关窗（shutdown）时下面的收据泳道整
        // 条被跳过——而关窗恰是这条回执存在的第一理由（早上考古的证据）。
        if (runEndCause !== null && (sessionStore !== undefined || o.workspaceRoot !== undefined)) {
          (sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions")))
            .appendEntries(sessionId, [{ type: "run_end_receipt", data: { cause: runEndCause, text: describeRunEndCause(runEndCause) } }])
            .catch(() => { /* 同 217 best-effort 律：UI 回执/账面落不下绝不破坏 settle */ });
        }
        // v7 γ2——「怎么结束」入指纹账（「怎么失败」的姊妹面）：仅 shutdown
        // 且有进行中 mission 时落（subject=mission objective，跨会话稳定可数
        // ——「这个目标第 N 次被关窗打断」）；user-abort 不落（deliberate，
        // 无追查价值——防污染词面守卫）；无 mission 不落（无稳定 subject，
        // 账面只剩噪音）。fire-and-forget：账落不下值一行 stderr，绝不挡
        // settle。
        if (runEndCause === "shutdown" && o.workspaceRoot !== undefined) {
          const objective = o.missionBox?.current?.snapshot()?.objective;
          if (objective !== undefined && objective !== "") {
            void appendFailureEvent(
              failureFingerprintPath(o.workspaceRoot),
              buildObservedEvent({
                subject: objective,
                stage: "run-end",
                cause: describeRunEndCause(runEndCause),
                at: new Date().toISOString(),
              }),
            ).catch((err: unknown) => {
              process.stderr.write(`wudao: 结束方式指纹落盘失败（继续，不影响运行结算）：${err instanceof Error ? err.message : String(err)}\n`);
            });
          }
        }
        if (active) {
          live = { reasoning: "", answer: "", busyTools: [] };
          // ω99-41: epoch reset — buffer and live wipe as a pair (flushDeltaEmit
          // above already folded the tail into the final broadcast).
          answerBuf.reset();
          reasoningBuf.reset();
          pendingThinking = undefined;
          emit();
          // M37 §1: a finished plan run leaves its artifact under review — the
          // latest board is the plan (a board-less plan run just says so).
          // ω99-51: read through the shared projection source — the seam's
          // snapshot, byte-equal to the retired backscan.
          if (planRun) {
            planRun = false;
            const board = todoSource.current(state.messages);
            planBoard = board ?? null;
            appendHistory({ kind: "notice", text: board !== undefined ? PLAN_REVIEW_HINT : "(规划运行未产出看板——没有可审内容；/plan <goal> 重试)" });
          }
          // M55 §A1: a finished /init run parks its draft for review. The
          // preview is the ONLY thing that lands before the user answers —
          // the file is still untouched (applyInitDraft runs on `ok`).
          if (initRun) {
            initRun = false;
            if (runOk) {
              const answer = lastAssistantAnswer(state.messages);
              const draft = answer !== undefined ? extractInitDraft(answer.content) : undefined;
              if (draft === undefined) {
                initDraft = null;
                appendHistory({ kind: "notice", text: "（/init 未产出 <agents-md-draft> 块——无可写入；/init 重试）" }); // ω99-166d-ii: #16（=repl #10 逐字孪生）
              } else {
                // workspace-ux B2: /init's overwrite probe reads the LIVE agent
                // root (that is where the draft would land).
                const hasExisting = o.workspaceRoot !== undefined && hasExistingAgentsMd(agentWorkspaceRoot);
                initDraft = { content: draft, hasExisting };
                appendHistory({ kind: "notice", text: formatInitPreview({ draft, hasExisting }) });
              }
            } else {
              initDraft = null;
            }
          }
          // 0.3.15（用户需求：任务整体执行时间统计）：run 落定的耗时收据——
          // total · 模型 · 工具 (次数)，作为本 run 的最后一条 history 条目，
          // ok / 中断 / 出错路径都会落（finally seam），slack 摘要 footer 搬运
          // 同一段文本。
          // 夜移 032 (codex turn-diff): the run's net file-change receipt —
          // one before→after pair per file no matter how many writes landed.
          // Preview rides the notice text; the full git-style diff rides the
          // detail (0.3.7 expandable notice). Same settle seam as the stats
          // receipt (ok / 中断 / 出错都落 — partial writes are evidence too).
          // ω99-217: #1 — 收据持久化：两枚 settle 收据同 seam 落进 session
          // JSONL 的 M35 §2 泛型车道（turn_diff_receipt / run_stats_receipt，
          // data=写者契约），resume/boot 时 receiptNoticesFromEntries 按文件
          // 序重建回 history——改动面板/胶囊/chip 重启后还在（216 的诚实边界
          // 「resume 重建索引后归零」就此闭环）。best-effort：落盘失败
          // fire-and-forget（UI 收据已落，绝不破坏 run）；只进 JSONL 永不进
          // state.messages/system prompt——load() 滤泛型=store 既有契约，M24
          // 前缀缓存零影响。sidechain（子 agent run）v1 不落（turn-diff
          // tracker 本就 parent-run 域）。
          const settledReceipts: import("@wudao/core").SessionEntry[] = [];
          if (process.env.WUDAO_G2_PROBE) console.log("G2: receipts block reached, cause=", runEndCause);
          // ω99-319: 命令足迹的 settle 面先行折叠——非 deleted 足迹文件 merge 进
          // 本轮 changes（同 path 时 cmd 行 wins，op 用足迹 kind）；deleted 只走
          // command_footprint 条目（changes 只有两态，不 merge——诚实形状）。
          // 首命令 wins（首触归因；后续命令的完整记录在各自的条目里）。
          const fpRows = new Map<string, { readonly cmd: string; readonly kind: "modified" | "created"; readonly afterSha?: string }>();
          for (const fp of cmdFootprints) {
            for (const f of fp.files) {
              if (f.kind === "deleted") continue;
              if (fpRows.has(f.path)) continue;
              fpRows.set(f.path, { cmd: fp.command, kind: f.kind, ...(f.afterSha !== undefined ? { afterSha: f.afterSha } : {}) });
            }
          }
          // turn = 与改动面板同序的轮号（计数基准 = 已落的携带非空 changes 的
          // notice 条数）——command_footprint 条目也用同一序（deleted-only 轮
          // 无 changes 收据，条目照落、序号取「本 run 若落收据将是第 N 轮」）。
          const turnOrdinal =
            history.filter((e) => e.kind === "notice" && e.changes !== undefined && e.changes.length > 0).length + 1;
          if (o.workspaceRoot !== undefined && ((o.turnDiff !== undefined && o.turnDiff.files().length > 0) || fpRows.size > 0)) {
            const root = o.workspaceRoot;
            const netFiles = o.turnDiff !== undefined ? o.turnDiff.files() : [];
            const netRender = renderTurnDiff(netFiles, (p) => relative(root, p));
            // ω99-314（文件级时光机）: settle 时的快照索引——before 内容
            // （turnDiff 内存里的本轮首写前状态）落 blob（fail-open，缺席=
            // 该行无 beforeSha、无恢复面）；afterSha 从内存内容可算（守卫 3
            // 的比对基准）。索引行 {turn,run,path,beforeSha,afterSha} 随同
            // 一批 settleReceipts 进 M35 §2 泛型车道（217 三缝范式）。
            const beforeShaByPath = new Map<string, string>();
            if (o.snapshots !== undefined) {
              for (const f of netFiles) {
                if (f.before === undefined) continue; // 新建——无旧可快照
                const rel = relative(root, f.path).split(sep).join("/");
                const blobSha = await o.snapshots.ensureBlob(f.before); // 幂等去重（写前捕获先行时此处多为 dedup 命中）
                if (blobSha !== null) beforeShaByPath.set(rel, blobSha);
              }
            }
            // ω99-216（托付闭环·亲验改动）: the light summary the changes
            // panel aggregates — same gate, same seam (see the type
            // comment): rel path / created-vs-modified / write count.
            // before/after 全内容快照 NEVER ride the entry——ω99-314 起
            // 行可带 beforeSha（blob 的仓内指针，可选、append-only：老
            // 收据缺省、老前端不读零变化）。
            // ω99-288（续，标记见上）: 每文件 +M/−K 行数随轻摘要过境——
            // renderTurnDiff 在数据层从 hunk 累计（与 netFiles 同序 zip），
            // 绝不解析已渲染的 detail 文本。
            // ω99-319: 足迹行 merge——被足迹覆盖的 turnDiff 行让位（cmd 行
            // wins），足迹行按首命令序连续追加（面板按 cmd 相邻分组）；足迹
            // 行的 beforeSha：与 turnDiff 重叠时用其内存 before（本轮首写前
            // 状态——有效回退点），纯足迹路径用快照目录的「最后已知内容」
            // （播种链：上一轮的 after 即本轮的 before——超越点②）。
            const netRelSet = new Set(netFiles.map((f) => relative(root, f.path).split(sep).join("/")));
            const changes: { path: string; op: "created" | "modified"; writes: number; plus?: number; minus?: number; beforeSha?: string; cmd?: string }[] = [];
            for (let i = 0; i < netFiles.length; i += 1) {
              const f = netFiles[i]!;
              const rel = relative(root, f.path).split(sep).join("/");
              if (fpRows.has(rel)) continue; // cmd 行 wins——足迹行替换（下方追加）
              const c = netRender.counts[i];
              const beforeSha = beforeShaByPath.get(rel);
              changes.push({
                path: relative(root, f.path),
                op: f.op,
                writes: f.writes,
                ...(c !== undefined ? { plus: c.plus, minus: c.minus } : {}),
                ...(beforeSha !== undefined ? { beforeSha } : {}),
              });
            }
            for (const [rel, row] of fpRows) {
              const beforeSha = netRelSet.has(rel) ? beforeShaByPath.get(rel) : snapshotCatalog.get(rel);
              changes.push({
                path: rel,
                op: row.kind,
                writes: 1,
                cmd: row.cmd,
                ...(beforeSha !== undefined ? { beforeSha } : {}),
              });
            }
            // ω99-319: shell-only 轮的收据文本（netFiles 空时 netRender.text 为
            // ""——给非空替代行；收益语，不写实现术语）。
            const receiptText =
              netFiles.length > 0 ? netRender.text : `命令改动 ${fpRows.size} 文件：${[...fpRows.keys()].join(" · ")}`;
            appendHistory({
              kind: "notice",
              text: receiptText,
              ...(netRender.detail !== "" ? { detail: netRender.detail } : {}),
              changes,
            });
            settledReceipts.push({ type: "turn_diff_receipt", data: { text: receiptText, ...(netRender.detail !== "" ? { detail: netRender.detail } : {}), changes } });
            // ω99-314（续）: file_snapshot 索引条目——一文件一行，随同一
            // 批 appendEntries 落（读侧 snapshotIndexFromEntries 按文件序
            // 重建目录）。目录（守卫 3 基准）同步更新；LRU 帽检查
            // fire-and-forget（仓只增 + 1GB 帽，慢路径绝不卡 settle）。
            for (const f of netFiles) {
              const rel = relative(root, f.path).split(sep).join("/");
              const beforeSha = beforeShaByPath.get(rel);
              if (beforeSha === undefined) continue;
              const afterSha = sha256Hex(f.after);
              snapshotCatalog.set(rel, afterSha);
              settledReceipts.push({
                type: "file_snapshot",
                data: { turn: turnOrdinal, run: sessionId, path: rel, beforeSha, afterSha },
              });
            }
            // ω99-319（续）: 纯足迹文件的播种——afterSha 在场才动目录（run 末
            // 真身以 turnDiff 为准的重叠路径已在上面循环处理，跳过）；before
            // 行只在目录已有「最后已知内容」时落（首见=诚实缺 beforeSha）。
            // 目录更新使「下一次任何改动都有前快照」（含 resume 重建——
            // file_snapshot 行过 snapshotIndexFromEntries 同一读侧）。
            for (const [rel, row] of fpRows) {
              if (row.afterSha === undefined || netRelSet.has(rel)) continue;
              const beforeSha = snapshotCatalog.get(rel);
              if (beforeSha !== undefined) {
                settledReceipts.push({
                  type: "file_snapshot",
                  data: { turn: turnOrdinal, run: sessionId, path: rel, beforeSha, afterSha: row.afterSha },
                });
              }
              snapshotCatalog.set(rel, row.afterSha);
            }
            if (o.snapshots !== undefined) void o.snapshots.enforceLruCap().catch(() => {});
          }
          // ω99-319（续）: command_footprint 条目——一条命令一条（含 deleted
          // 文件的完整记录），与 217/314 收据同一批 appendEntries（M35 §2 泛型
          // 车道，load() 滤泛型——M24 零影响）。deleted-only 轮无 changes 收据
          // 但条目照落（诚实记录在 JSONL，面板 v1 不显形——brief 面3 的 v1 边界）。
          for (const fp of cmdFootprints) {
            settledReceipts.push({
              type: "command_footprint",
              data: { turn: turnOrdinal, run: sessionId, command: fp.command, files: fp.files },
            });
          }
          // 0.3.82（0.3.81 凌乱反馈）: the retired per-call breaker receipts,
          // aggregated to ONE run-settle capsule — the count is sidecar state
          // (permission.ts notes each auto-allow), so the audit trail survives
          // the de-clutter. UI-ONLY by parity: the per-call receipts were
          // never persisted, so this one stays out of settledReceipts too.
          // (REPL prints its own aggregate at ITS settle — one-shot below.)
          if (o.sidecar !== undefined && o.sidecar.breakerAllows() > 0) {
            appendHistory({
              kind: "notice",
              text: `🛡 sidecar:熔断中 — 本轮共自动放行 ${o.sidecar.breakerAllows()} 次（未分类）`,
            });
          }
          const statsText = formatRunStats(performance.now() - runStartMs, llmMs, toolMs, runToolCalls, runIdleReconnects, softIdleWarns, runCacheDebtTokens);
          appendHistory({ kind: "notice", text: statsText });
          // ω99-315: the 217 receipt's additive extension — the idle count
          // rides the data payload (omit-when-zero keeps old-session bytes
          // identical; the validator tolerates the field both ways).
          // ω99-320: softIdleWarns rides the same additive lane (idleReconnects
          // 同形：>0 才带——「等待较久」与「断流重连」一条收据看全网络健康)。
          settledReceipts.push({
            type: "run_stats_receipt",
            data: {
              text: statsText,
              ...(runIdleReconnects > 0 ? { idleReconnects: runIdleReconnects } : {}),
              ...(softIdleWarns > 0 ? { softIdleWarns } : {}),
              ...(runCacheDebtTokens > 0 ? { cacheDebtTokens: runCacheDebtTokens } : {}),
              // v7 γ3——服务模型回执随收据持久（resume/考古面：跨会话也能
              // 答「那轮是谁答的」；315/320 同款 additive lane，缺席=旧读侧
              // 零感知）。
              ...(runServedBy !== undefined ? { servedBy: runServedBy } : {}),
            },
          });
          if (settledReceipts.length > 0 && (sessionStore !== undefined || o.workspaceRoot !== undefined)) {
            (sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions")))
              .appendEntries(sessionId, settledReceipts)
              .catch(() => { /* ω99-217: best-effort — the UI receipt already landed; a failed persist must not break the settle seam */ });
          }
          // ω99-249: the goal's RUN-BOUNDARY SETTLEMENT — adjacent to the 217
          // receipt batch (same seam family): the run's split usage + wall
          // time fold onto the live goal as ONE appended goal_state row, then
          // the ledger 随动 projects any mid-run mission_complete/fail. A
          // budget crossing pushes the safe-pause note onto the SAME metaNotes
          // queue (injected at the next model call — the in-flight run is
          // never killed; 轮界才生效). Entry appends are fire-and-forget
          // inside the runtime: a failed write never breaks the run chain.
          const goalSettle = goalRuntime?.onRunSettle({
            input: runGoalUsage.input,
            output: runGoalUsage.output,
            ms: performance.now() - runStartMs,
          });
          if (goalSettle !== undefined) {
            metaNotes.push({ text: goalSettle.budgetNote, source: "目标预算" });
            // 121 §4: budget death must not stop mid-air — arm the ONE
            // wrap-up round (the model's last answer opportunity; the note
            // above is its directive). Fired at the settle seam below.
            pendingBudgetSalvage = true;
          }
          // ω99-253: the branch face's RUN-BOUNDARY refresh — the run may have
          // checked out a branch (shell git checkout / the model's own
          // tool calls) or be about to land a parked agent-root switch below;
          // ONE read at the boundary, never per frame. Fire-and-forget: the
          // landing re-emits only when the value actually changed.
          refreshGitBranch();
          // The memory signature's RUN-BOUNDARY refresh (the settle seam the
          // web subscription keys on): another window's write — or this run's
          // own memory tools / Dream lane — becomes visible HERE, one read at
          // the boundary, never per frame (between settles is an honest
          // snapshot window — no polling by design).
          void memorySig.refresh();
          emit(); // the status face now carries the settled goal
          // 夜移 005 (dsh session-title): after the first successful run, upgrade
          // the derived session name to an LLM title — one tiny background call,
          // its own system prompt (zero shared prefix bytes with the session),
          // never in the main transcript. Fire-and-forget: any failure silently
          // keeps the derived name. A manual /rename or a prior llm title (or a
          // legacy untagged name) is respected — only "derived" upgrades.
          if (o.autoTitle === true && !titleTried && runOk && o.workspaceRoot !== undefined) {
            titleTried = true;
            void (async () => {
              try {
                const store = createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions"));
                const current = sessionNameSource(await store.loadSessionEntries(sessionId));
                if (current !== undefined && current.source !== "derived") return;
                const req = buildTitleRequest(state.messages);
                if (req === undefined) return;
                const reply = await o.model.generate({
                  systemPrompt: req.systemPrompt,
                  messages: [{ role: "user", content: req.user }],
                  tools: [],
                  reasoningEffort: "low",
                  maxTokens: 64,
                  querySource: TITLE_QUERY_SOURCE,
                });
                const title = sanitizeTitle(reply.content);
                if (title === undefined) return;
                await store.appendEntry(sessionId, { type: "session_name", name: title, source: "llm" });
                setSessionNameCached(title); // the entry landed — the status face follows (one frame)
                appendHistory({ kind: "notice", text: `🏷️ 已自动命名：${title}` }); // ω99-166f-ii: #1
                o.onSessionRenamed?.(title);
              } catch {
                // Fail-closed: the derived name stays, nothing surfaces.
              }
            })();
          }
          o.onRunComplete?.(state.messages);
          // M63-A: the run settled — the completion notification.
          notificationHook("idle");
          lastSettleAt = Date.now(); // 123-5 — 空闲清理的计时锚（每次收束重置）
          // M61 §2: each settled run re-arms the /loop's next wakeup
          // (fresh prompt; fire-on-idle — rounds never stack).
          void loopController?.onRunEnd();
          // M61 §3: the stall guard — a block-capped stop pauses evaluation
          // and KEEPS the goal; the next user prompt resumes it.
          goalController?.onRunEnd({ ...(settledTerminal?.stopBlockCapped !== undefined ? { stopBlockCapped: settledTerminal.stopBlockCapped } : {}) });
          // M49 §2: the background review fork — a successful run with ≥3
          // tool calls spawns a shareContext reviewer (maxTurns 2, read tools
          // + memory_write) through the session registry; the 🧠 receipt
          // lands as a notice when it settles. Disabled runs (kill switch),
          // failed/interrupted runs, and registry-less sessions skip it.
          if (
            o.backgroundReview === true
            && runOk
            && runToolCalls >= REVIEW_MIN_TOOL_CALLS
            && o.workspaceRoot !== undefined
            && o.agentsRegistry !== undefined
          ) {
            void spawnBackgroundReview({
              workspaceRoot: o.workspaceRoot,
              model: o.model,
              registry: o.agentsRegistry,
              systemPrompt: state.systemPrompt,
              messages: state.messages,
              tools: o.tools,
              onReceipt: (line) => appendHistory({ kind: "notice", text: line }),
            });
          }
          // ω-4f (design 84 §3(f)): Dream memory consolidation — the SAME
          // run-settle seam, immediately after the review fork (stage 2 of
          // the two-stage composition: fork = transcript→ledger, Dream =
          // ledger→curated ledger). All due-gates (kill switch, ≥8
          // unprocessed, 30-min interval, module single-flight) run INSIDE
          // the spawn — a not-due dream returns undefined before any child
          // exists, so this seam costs one store read on a quiet session.
          // Successful-settle gating mirrors the site's semantics minus the
          // review-specific bits (tool-call count / the backgroundReview
          // flag are transcript-review concerns; Dream's input is the
          // ledger, and WUDAO_DREAM is its own kill switch). The 🧠 receipt
          // lands as a notice when it settles — the review's channel.
          if (runOk && o.workspaceRoot !== undefined && o.agentsRegistry !== undefined) {
            void spawnDreamRun({
              workspaceRoot: o.workspaceRoot,
              model: o.model,
              registry: o.agentsRegistry,
              onReceipt: (line) => appendHistory({ kind: "notice", text: line }),
            });
          }
          // 永续 v6 wave2（reef C1）：门控自改进的触发器——与 Dream 同一收束
          // 缝（失败事件都在运行/调度里落账，收束是它们最近的可读点）。纯读
          // 台账 fold + 建 offered 记录 + 一条通知；两道人工门之前零模型调用
          // 零规则写入（kill switch WUDAO_IMPROVE=off；fail-open：坏台账静默）。
          if (runOk && o.workspaceRoot !== undefined) {
            void maybeOfferImprovements({
              workspaceRoot: o.workspaceRoot,
              onNotice: (line) => appendHistory({ kind: "notice", text: line }),
            });
          }
          // Steering fallback seam: whatever the loop never drained (a steer
          // submitted during/after the final model call, or an aborted run)
          // auto-starts as a fresh run — the M14 path (user entry is pushed at
          // START time, so history order stays conversational).
          // M55 §B7: a /model //effort switch parked while this run was in
          // flight lands HERE — the next run's first request carries it.
          if (pendingModelApply !== null) {
            const sel = pendingModelApply;
            pendingModelApply = null;
            // 0.3.31 re-check: the run may have grown the context past the
            // parked target — dropping the switch at the boundary beats a
            // guaranteed overflow on the next request. The submit-time entry
            // stands as the record of what was PARKED; this notice is the
            // visible drop.
            const settleGuard = contextSwitchGuard(selectionContextWindow(sel), `模型 → ${sel.provider ?? modelLive.provider}/${sel.model}`); // ω99-195: #2
            if (settleGuard.refuse !== null) {
              appendHistory({ kind: "notice", text: settleGuard.refuse });
              appendHistory({ kind: "notice", text: `（排队的模型切换在轮界被丢弃——会话保持 ${modelLive.provider ?? "当前供应商"}/${modelLive.model ?? "?"}）` }); // ω99-166f-ii: #2
            } else {
              if (sel.model !== undefined) modelLive = { ...modelLive, model: sel.model, ...(sel.provider !== undefined ? { provider: sel.provider } : {}) };
              if (sel.effort !== undefined) modelLive = { ...modelLive, effort: sel.effort };
              try {
                o.onModelSwitch?.(sel);
              } catch {
                // the entry is written; a frontend seam failure must not wedge the run end
              }
              appendHistory({ kind: "notice", text: `模型切换已在运行收束时落地——下一个请求即生效${settleGuard.note}` }); // ω99-166f-ii: #3
            }
          }
          // M63 §A: a provider switch parked while this run was in flight
          // lands HERE — the turn boundary (an aborted run settles here too:
          // deliberate symmetry with pendingModelApply — the user's queued
          // switch survives an interrupt). The client rebuild was deferred to
          // exactly this point, so the settled run's requests all stayed on
          // the old provider; the NEXT run reads the replacement client. A
          // build that throws drops the switch AND writes no entry (LOW 2).
          if (pendingProviderApply !== null) {
            const p = pendingProviderApply;
            pendingProviderApply = null;
            // 0.3.31 re-check (same rule as the parked model switch): a run
            // that outgrew the parked target drops the switch here — the
            // build never runs, so the entry never records (LOW 2 symmetry).
            const settleGuard = contextSwitchGuard(
              resolveContextWindowTokens(loadEffectiveProfiles(), p.provider, p.model, o.compaction?.contextWindowTokens ?? 64_000),
              `供应商 → ${p.provider}`, // ω99-199: #2；ω99-311: 称谓产品级统一（随 web 310）
            );
            if (settleGuard.refuse !== null) {
              appendHistory({ kind: "notice", text: settleGuard.refuse });
              appendHistory({ kind: "notice", text: `（排队的供应商切换在轮界被丢弃——会话留在 ${p.from ?? "当前供应商"}；未记录条目）` }); // ω99-166f-ii: #4
            } else {
              let next: ModelClient | undefined;
              try {
                next = o.onProviderSwitch?.build(p.config);
              } catch (err) {
                appendHistory({ kind: "notice", text: `⚠️ provider 切换到 ${p.provider} 失败：${err instanceof Error ? err.message : String(err)}——会话仍留在 ${p.from ?? "当前 provider"}（未记录切换）` }); // ω99-166c-iii: #3
              }
              if (next !== undefined) {
                o = { ...o, model: next };
                p.writeEntry();
                // 推理档三级配置 S2 — the same effort reset as the idle switch
                // (the parked config's reasoningEffort already carries the
                // re-derived chain; the overlay mirrors it, stale value dropped).
                const fromEffort = modelLive.effort;
                modelLive = { provider: p.provider, model: p.model, ...(p.config.reasoningEffort !== undefined ? { effort: p.config.reasoningEffort } : {}) };
                const effortNote = effortResetNote(fromEffort, modelLive.effort);
                emit();
                appendHistory({ kind: "notice", text: `供应商切换已在运行收束时落地——下一轮的请求走 ${p.provider}/${p.model}\n  （task 工具的子代理在下次会话前仍走原端点）${effortNote}${settleGuard.note}\n${PROVIDER_SWITCH_CACHE_NOTE}` }); // ω99-166f-ii: #5
              }
            }
          }
          // workspace-ux B2: an agent-root switch parked while this run was in
          // flight lands HERE — the turn boundary (an aborted run settles it
          // too: the user's confirmed switch survives an interrupt, the same
          // symmetry as the parked model/provider switches). It applies BEFORE
          // the follow-up drain below, so a queued steer's run starts on the
          // NEW root; the settled run's requests all stayed on the old one.
          // B2 review: a pending switch that ended up matching the live root
          // (the user switched back mid-run) lands SILENTLY — no notice, no
          // note, nothing moved.
          // M90 (d33a673 review follow-up): this segment is the seam's throw
          // surface between "run settled" and the busy flip — a throw inside
          // the landing (fs or a listener failure under the receipt) used to
          // skip the flip entirely, wedging busy=true forever: every later
          // submit parked. The finally flips busy on EVERY exit; the success
          // order is exactly the old one (the flip still waits for the parked
          // root to land, still precedes the drain), and the throw itself
          // escapes unwrapped — on that path nothing after the failure point
          // runs (no drain, no queued take), so the flip cannot race a peer
          // into a stale footing.
          try {
            if (pendingAgentRoot !== null) {
              const pendingRoot = pendingAgentRoot;
              pendingAgentRoot = null;
              if (!(await sameAgentRoot(pendingRoot.path, agentWorkspaceRoot))) {
                await applyAgentRoot(pendingRoot.path, pendingRoot.extRescan);
              }
              // P1-7 (96 队列): the /worktree op parked WITH this switch
              // settles its bookkeeping here — inside the same awaited seam,
              // BEFORE busy flips, so a peer reading idle sees the landed
              // state (the same atomicity the parked switch itself gets).
              // This runs even when the root itself was a same-root no-op
              // (the worktree bookkeeping is its own transition).
              if (pendingWorktreeOp !== null) {
                const op = pendingWorktreeOp;
                pendingWorktreeOp = null;
                if (op.kind === "enter") {
                  activeWorktree = { ...op.wt, enteredAt: new Date().toISOString(), prevRoot: op.prevRoot };
                  writeWorktreeEntry("worktree_enter", op.wt);
                  appendHistory({
                    kind: "notice",
                    text: `🌳 已进入 worktree ${op.wt.name}（分支 ${op.wt.branch}）——轮界生效\n  路径：${op.wt.path}\n  下一轮的工具在其中运行；会话 · 导出 · 成本仍留在原根`, // ω99-166f-i: #1
                  });
                } else {
                  activeWorktree = null;
                  writeWorktreeEntry("worktree_exit", { name: op.wt.name, path: op.wt.path, branch: op.wt.branch, mode: "keep" });
                  appendHistory({
                    kind: "notice",
                    text: `🌳 已退出 worktree ${op.wt.name}（keep）——轮界生效，树与分支保留在 ${op.wt.path}`, // ω99-166f-i: #2
                  });
                }
              }
            }
          } finally {
            // The parked switches have ALL landed (the root one awaited real
            // fs above: the box, the watchers, the receipt notice, and the
            // <workspace_changed> MetaNote). Only now is the driver externally
            // idle — from the next emit on, a peer's submit() starts on the
            // NEW root, and the drain below is synchronous through startRun,
            // so no peer can slip a run in between.
            // 124b 项 1：run 终结即解除抢占通道（之后到达的 request 是无
            // 害空操作；下一次 startRun 换新通道）。
            if (streamPreemptRef.current === preemptChannel) streamPreemptRef.current = undefined;
            busy = false;
            // 夜移 028: debounced release — the queue drain below may
            // synchronously startRun the next queued prompt, and that
            // re-acquire cancels the pending release (assertion continuity).
            powerGuard.sync(busy && pendingPermission === null);
          }
          const next = queueRef.current.shift();
          queued = [...queueRef.current];
          emit();
          // Report 95 R2: re-check busy AFTER the emit — the status fan-out
          // runs subscribers synchronously, so a frontend's submit() (or a
          // poller's startRun) can land INSIDE this settle window (busy=false
          // above → drain below) and flip busy back to true; an unconditional
          // startRun(next) would be a double run over the single-owner
          // state.messages. Park the payload back at the head — the racing
          // run's mid-run steering drain delivers it into that run's next
          // model call (its own settle drain, if the loop is already past
          // every drain).
          if (next !== undefined) {
            if (busy) {
              queueRef.current = [next, ...queueRef.current];
              queued = [...queueRef.current];
              emit();
            } else {
              startRun(next, false);
            }
          }
          // M61 §1: a scheduled task that armed during the run fires now —
          // one run, straight from the pending queue (no catch-up by count).
          // M64-A §A: an accepted peer message that armed during the run
          // rides the same settle seam, strictly after scheduled work.
          // Report 95 R2 follow-up: the same busy re-check as the drain
          // above — the idle emit already ran subscribers, so a racing
          // startRun may hold busy here, and the take is DESTRUCTIVE: guard
          // BEFORE it. The armed fire stays put; the racing run's
          // low-priority take lane delivers it before its next model call
          // (or the next pollCron/pollPeer tick / settle seam, once idle).
          else if (!busy) {
            // 121 §4（a reference harness budget death salvage）— the budget-dead goal's
            // wrap-up round, strictly BEFORE cron/peer/child-mail: the dying
            // goal's last answer outranks scheduled work. ONE round per
            // crossing (armed above at the crossing settle; cleared by any
            // run start, including this one). The persisted prompt is the
            // user-visible turn; the directive rides the budget note onto
            // this run's first model call (MetaNote projection).
            if (pendingBudgetSalvage) {
              pendingBudgetSalvage = false;
              appendHistory({ kind: "notice", text: "🪫 目标预算已耗尽——触发最后一次收尾回答（总结已完成/未完成/成果落盘）" });
              startRun(GOAL_BUDGET_SALVAGE_PROMPT, false);
            } else {
              const scheduled = drainCronInjection();
              if (scheduled !== undefined) {
                appendHistory({ kind: "notice", text: `⏰ ${truncate(scheduled, 80)}` });
                startRun(scheduled, false);
              } else {
                const peer = o.peer?.takeInjection();
                if (peer !== undefined) {
                  appendHistory({ kind: "notice", text: `📬 ${truncate(peer.split("\n")[0] ?? "", 80)}` });
                  startRun(peer, false);
                } else {
                  // ω99-57: child mail, strictly after peer (same order as the
                  // mid-run take lane above).
                  const childMailText = o.childMail?.take();
                  if (childMailText !== undefined) {
                    appendHistory({ kind: "notice", text: `📨 ${truncate(childMailText.split("\n")[0] ?? "", 80)}` });
                    startRun(childMailText, false);
                  }
                }
              }
            }
          }
        }
      }
    })();
  };

  // M53 review fix — record WHICH branch is active, as a session entry next
  // to the messages. The JSONL keeps trunk + abandoned + branch in file
  // order; without this marker a fresh load would flatten them into one
  // conversation. Fire-and-forget like the frontends' persistence; the load
  // path falls back to the linear-last chain when the leaf is not (yet) on
  // disk (a crash between this append and the turn's persistence).
  const recordActiveBranch = (leafKey: string): void => {
    if (o.workspaceRoot === undefined) return;
    createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"))
      .appendEntry(sessionId, buildActiveBranchEntry(leafKey))
      .catch(() => { /* best-effort: /tree //switch still work in-memory */ });
  };

  // ω99-289（续，标记见上）— 失败重试的分支重链缝（continueSession 错误臂
  // 的第三步）。/edit 分支的 fork 链接挂在新 user 回合的 parentUuid 上
  // （startRun 落盘）；continueRun 重试轮没有 user 回话，而 loop 自己 push
  // 的 assistant/tool 消息不带 uuid/链接——若无链接，重试轮在盘上线性尾随
  // 旧合成错误条目，下次 resume 会把它读回活动链（「孤儿在树」落空）。此缝
  // 一次性包装宿主持久化回调（onBeforeToolDispatch/onRunComplete——消息落
  // 盘的唯一通道，startRun 调用时读取 o 上的现值），在重试轮**第一条新消息
  // 持久化之前**给它盖 parentUuid=失败点前驱的 key：其后所有新消息线性尾随
  // 它，链走新支——旧错误条目孤儿在树（append-only 一字不动，重试=分支不
  // 是删除；连续重试每次链同一前驱，多条错误支并存）。守卫：①单发——首发
  // 即解除（o 重绑回原回调，model-swap 重绑同款先例）；②前缀完整性——
  // tier-2 压缩会把 state.messages 整体换血，前缀断则放弃盖链（退回旧行
  // 为，诚实保守）；③首条新消息必须尚无 parentUuid——plain submit 的 user
  // 回话自带链接（或空会话首条无前驱），绝不误盖。重试被租约拒绝等零回调
  // 场景由下一个 run 的首发安全收敛：形状不合即不盖、只解除。
  const armRetryLink = (): void => {
    if (o.onBeforeToolDispatch === undefined && o.onRunComplete === undefined) return; // 无持久化面：无盘可孤儿化
    const preRun = [...state.messages];
    if (preRun.length === 0) return;
    const predKey = nodeKey(preRun[preRun.length - 1] as AgentMessage);
    const origBefore = o.onBeforeToolDispatch;
    const origComplete = o.onRunComplete;
    const disarm = (): void => {
      o = {
        ...o,
        ...(origBefore !== undefined ? { onBeforeToolDispatch: origBefore } : {}),
        ...(origComplete !== undefined ? { onRunComplete: origComplete } : {}),
      };
    };
    const stamp = (messages: readonly AgentMessage[]): void => {
      disarm(); // 单发：无论命中与否，首发即解除
      if (messages.length < preRun.length) return;
      for (let i = 0; i < preRun.length; i += 1) if (messages[i] !== preRun[i]) return;
      const first = messages[preRun.length];
      if (first === undefined || first.parentUuid !== undefined) return;
      (messages as AgentMessage[])[preRun.length] = { ...first, parentUuid: predKey };
    };
    o = {
      ...o,
      ...(origBefore !== undefined
        ? {
            onBeforeToolDispatch: (messages: readonly AgentMessage[]) => {
              stamp(messages);
              return origBefore(messages);
            },
          }
        : {}),
      ...(origComplete !== undefined
        ? {
            onRunComplete: (messages: readonly AgentMessage[]) => {
              stamp(messages);
              origComplete(messages);
            },
          }
        : {}),
    };
  };

  // Shared by the public loadHistory() and resume() — the conversation swap.
  // (ω99-217 #1 续) receiptNotices: 已持久化 settle 收据的重建 notice（文件
  // 序），并入 resumeEntries 结果的尾端——resume() 用已载条目同步喂入（在
  // 「↪ 已恢复」notice 之前）；其余调用侧（loadHistory/switch）不喂则行为
  // 与改动前逐字节一致（零回放）。尾端并入是有意取舍：收据在 JSONL 里与
  // 消息交错的位置受宿主持久化时序影响（宿主尾部消息经 onRunComplete 异步
  // 落盘，可能晚于收据行），按邻接消息交错会把收据放回它概括的回答之前；
  // 尾端并入对三消费者（面板逐条 run 分组/胶囊/chip 计数）零语义损失。
  const loadHistoryFn = (messages: readonly AgentMessage[], id: string, receiptNotices: readonly HistoryEntry[] = [], anchors?: readonly ReceiptAnchor[]): void => {
    // M53 §1: a wholesale swap disarms any pending /edit — the branch point
    // belonged to the conversation being replaced. P2-10: it also ends any
    // rewind window — the adopted chain lands on a file leaf.
    pendingEditCut = null;
    rewoundCutKey = null;
    state.messages = [...messages];
    queueRef.current = [];
    queued = [];
    const resumedBase = messages.length > 0 ? resumeEntries(messages, id) : [];
    // 118 续修（09-27）：anchors 存在时走交错重建（收据回到各自回合下方），
    // 否则维持旧尾端并入（零回放调用侧行为不变）。
    history = anchors !== undefined && anchors.length > 0
      ? resumeEntriesAnchored(messages, id, anchors)
      : receiptNotices.length > 0 ? [...resumedBase, ...receiptNotices] : resumedBase;
    historyOut = history;
    resetHistory();
    // #48: route through setSessionId (as its own contract claims) — the
    // sessionIdBox AND the lease rotation both follow the adopted id (the
    // old bare assignment left the box stale on resume).
    setSessionId(id);
    // The adopted session's OWN name (a swap changed the conversation — the
    // previous session's name never survives it; a nameless id reads null).
    refreshSessionName();
    live = { reasoning: "", answer: "", busyTools: [] };
    // ω99-41: epoch reset — buffer and live wipe as a pair.
    answerBuf.reset();
    reasoningBuf.reset();
    pendingThinking = undefined;
    boardProgress = null;
    ctxTokens = null;
    lastPromptTokens = 0;
    emit();
    // M53 §1: the frontend's identity-based persistence base must follow the
    // swap (the reloaded chain is a NEW set of objects — without this the
    // next run would re-append the whole chain to the JSONL).
    o.onHistoryReplaced?.(state.messages, id);
    // M61 §1: the scheduler follows the adopted session — restore the
    // session's restorable tasks (unexpired recurring + un-fired one-shots).
    if (o.cron !== undefined) {
      o.cron.setSessionId(id);
      void o.cron.restoreOnResume().catch(() => {});
    }
    // 113-B3: a conversation swap resets the park counter (the adopted
    // session's own rows recount at resume(); a plain loadHistory swap has no
    // park history by construction) and clears any parked face.
    quotaParks = 0;
    parked = null;
  };

  const submitCore = (text: string, plan: boolean, images?: readonly ImageBlock[], files?: readonly FileBlock[]): SubmitOutcome => {
    // M61 §3: a user prompt resumes a stall-paused goal's evaluation.
    goalController?.onUserPrompt();
    if (busy) {
      // M53 §5: --no-steering disables the queue entirely — the submit is
      // refused with a notice instead of parking (the ablation's whole point:
      // measure runs that never see a mid-run injection).
      if (isFeatureAblated("steering")) {
        appendHistory({ kind: "notice", text: "⚠️ steering 已禁用（--no-steering）——请等待本轮运行结束" }); // ω99-166c-iv: #1
        return "notice";
      }
      // Single in-flight run: park the steer in the queue — the loop drains it
      // before the next model call (mid-run steering); if the run has already
      // passed its final drain, the completion seam starts it as a new run.
      // (A plan submission while busy steers the in-flight run as plain text —
      // plan mode is a property of the run, not of a parked steer.)
      queueRef.current = [...queueRef.current, text];
      queued = [...queueRef.current];
      emit();
      // 124b 项 1（codex instant_interrupt）：busy-submit 即时抢占在飞模型流
      // ——用户提交了新指令，排队等一个可能还有数分钟的长 reasoning 流是
      // 最差的 UX。request() 只中断当前模型调用（工具执行/压缩不受影响）；
      // 被弃 partial 由 loop 旁路审计（stream_preempted 事件），循环立即
      // 续跑并从 steering 队列取到刚停车的这条文本。模型调用之间的空窗
      // request() 是无害空操作（那种提交照旧在轮界落地）。
      streamPreemptRef.current?.request();
      return "steered";
    }
    // ω99-85 (45's parked debt): the fourth concurrency mouth — an idle
    // /compact in flight (busy=false, compactionAbort≠null). Falling through
    // to startRun lands the user turn INSIDE the compaction window:
    // manualCompact finishes from its entry snapshot and REPLACES
    // state.messages wholesale, wiping the turn from memory while its JSONL
    // line chains off a span the boundary just cut. Same law as the busy arm
    // above: attachments cannot park (their refs would strand across the
    // boundary — the routedSubmit busy refusals do not fire, busy is false),
    // a steering ablation refuses the park, text parks in the steering queue
    // for the /compact's settle drain — zero memory, zero disk until the
    // window closes. (A plan submission parks as plain text, the same plan-
    // flag loss the busy-steer arm accepts: plan mode is a property of the
    // run, not of a parked steer.)
    if (compactionAbort !== null) {
      if (images !== undefined || files !== undefined) {
        appendHistory({ kind: "notice", text: "⚠️ compact 进行中无法提交附件——请等其结束后再重新提交" }); // ω99-166c-iv: #3
        return "notice";
      }
      if (isFeatureAblated("steering")) {
        appendHistory({ kind: "notice", text: "⚠️ steering 已禁用（--no-steering）——请等待本轮运行结束" }); // ω99-166c-iv: #2
        return "notice";
      }
      queueRef.current = [...queueRef.current, text];
      queued = [...queueRef.current];
      emit();
      return "steered";
    }
    // M63 §C: the browse-only guard — the wizard boot's placeholder key must
    // never reach a provider (a run would surface a raw 401, the exact
    // cryptic failure the wizard exists to prevent). Refused BEFORE any
    // state changes, with the way back to configuration named. Commands
    // (/provider, /model, the settings ops) still work — the completion path
    // rides them.
    if (o.onProviderSwitch?.isPlaceholderLive?.() === true) {
      appendHistory({
        kind: "error",
        text: "尚未配置任何模型 Key(只读浏览模式)——无法开始对话。在 Web 界面点击「去配置」完成新手向导,或在设置页保存 Key 后重试",
      });
      return "notice";
    }
    startRun(text, plan, images, files);
    return "started";
  };

  // /rewind's engine — shared by the submit routing and the driver-level op.
  const rewindTo = async (target: number | "last" | "list"): Promise<string> => {
    const h = o.fileHistory;
    if (!h) {
      const text = "(文件历史不可用——本会话未记录快照)";
      appendHistory({ kind: "notice", text });
      return text;
    }
    if (target === "list") {
      const text = formatRewindList(await h.list(), o.workspaceRoot ?? "");
      appendHistory({ kind: "notice", text });
      return text;
    }
    const entries = await h.list();
    if (entries.length === 0) {
      const text = "(本会话未记录文件改动——没有可回退的内容)";
      appendHistory({ kind: "notice", text });
      return text;
    }
    const n = target === "last" ? (entries[entries.length - 1]?.seq ?? 0) : target;
    const { summary } = await applyRewind(h, n, {
      workspaceRoot: o.workspaceRoot ?? "",
      ...(o.readState !== undefined ? { readState: o.readState } : {}),
      pushMetaNote: (t) => metaNotes.push({ text: t, source: "回滚" }),
    });
    appendHistory({ kind: "notice", text: summary });
    return summary;
  };

  // P2-10 (96 队列) — /rewind turn: the conversation档. `turn` lists the
  // active chain's recent user messages (the /edit face); `turn <n>` swaps
  // the ACTIVE CHAIN to everything before message n — branch semantics,
  // never truncation: the rewound turns stay in the JSONL (visible via
  // /tree, reachable via /switch), the next submit links its parentUuid at
  // the cut, and the file journal is untouched (file restoration stays the
  // explicit /rewind <m> second step). The swap reuses the M53 /edit-cut
  // pattern — the surviving prefix keeps its objects, so the frontends'
  // identity-based persistence appends only what comes next.
  const rewindTurn = async (n?: number): Promise<string> => {
    if (n === undefined) {
      const text = formatRewindTurnList(editTargets());
      appendHistory({ kind: "notice", text });
      return text;
    }
    if (busy) {
      // The /switch discipline (field-verified): a chain swap mid-run is an
      // explicit refusal, never queued — the in-flight run owns state.messages.
      const text = "⚠️ 运行中无法 /rewind turn（任务进行中）";
      appendHistory({ kind: "notice", text });
      return text;
    }
    const target = editTargets().find((t) => t.n === n);
    if (target === undefined) {
      const text = `用法：/rewind turn <n>——没有第 ${n} 条消息（裸 /rewind turn 列出可选消息，1 = 最近一条）`;
      appendHistory({ kind: "notice", text });
      return text;
    }
    const before = state.messages.length;
    const cut = target.index;
    state.messages = state.messages.slice(0, cut);
    pendingEditCut = null; // a fresh cut disarms any armed /edit (its point sat on the abandoned tail)
    history = resumeEntries(state.messages, sessionId);
    historyOut = history;
    resetHistory();
    boardProgress = null;
    planBoard = null;
    ctxTokens = null; // the rewound chain is a different projection — the estimate restarts unknown
    rewoundCutKey =
      state.messages.length > 0 ? nodeKey(state.messages[state.messages.length - 1] as AgentMessage) : null;
    emit();
    // Persistence — both APPENDS; the rewound lines never leave the file:
    // the audit receipt, then the active-branch record (the swap's restart
    // story; the M53 /switch seam).
    if (o.workspaceRoot !== undefined) {
      createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"))
        .appendEntry(sessionId, buildRewindTurnEntry({ n, fromMessages: before, toMessages: state.messages.length }))
        .catch(() => { /* best-effort audit — the swap itself already succeeded */ });
    }
    if (rewoundCutKey !== null) recordActiveBranch(rewoundCutKey);
    const preview = truncateSafe(target.text.split("\n")[0] ?? "", 60);
    const text = `↩ 已回退到第 ${n} 条消息之前（"${preview}"）—— 活跃链上余 ${state.messages.length} 条；回退掉的轮次仍留在分支树上（/tree, /switch）`;
    appendHistory({ kind: "notice", text });
    return text;
  };

  // -------------------------------------------------------------------------
  // M53 §1 — session branching: /edit arming, /tree rendering, /switch swap.
  // -------------------------------------------------------------------------
  // The /edit listing: plain user prompts of the ACTIVE chain, 1 = most
  // recent. Machinery user messages (summary markers, [system note: …],
  // language blocks) all start with "[" and are excluded.
  interface EditTarget { readonly n: number; readonly index: number; readonly text: string }
  const editTargets = (): readonly EditTarget[] => {
    const out: EditTarget[] = [];
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const m = state.messages[i];
      if (m === undefined || m.role !== "user") continue;
      if (m.content.startsWith("[")) continue;
      out.push({ n: out.length + 1, index: i, text: m.content });
    }
    return out;
  };
  const formatEditList = (targets: readonly EditTarget[]): string =>
    targets.length === 0
      ? "(还没有可编辑的消息)"
      : `最近消息（1 = 最近一条；/edit <n> 把它放回输入——重发即开分叉）：\n${targets.map((t) => `  ${t.n}. ${truncateSafe(t.text.split("\n")[0] ?? "", 80)}`).join("\n")}`;
  const beginEditFn = (n: number): string | undefined => {
    if (busy) return undefined;
    const target = editTargets().find((t) => t.n === n);
    if (target === undefined) return undefined;
    pendingEditCut = target.index;
    return target.text;
  };

  // The tree source: the session JSONL when a workspace is configured (the
  // abandoned branches live there — in-memory state holds only the active
  // chain); the in-memory chain otherwise (stub-tool drivers, tests).
  const allMessagesForTree = async (): Promise<readonly AgentMessage[]> => {
    if (o.workspaceRoot !== undefined) {
      try {
        const store = createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"));
        const entries = await store.loadSessionEntries(sessionId);
        if (entries.length > 0) return entries.filter((e): e is AgentMessage => "role" in e);
      } catch {
        // unreadable store → the in-memory chain is the best view available
      }
    }
    return [...state.messages];
  };
  // The active chain's last user turn (turn key of /tree //switch marking).
  const currentLeafKey = (): string | null => {
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const m = state.messages[i];
      if (m !== undefined && m.role === "user") return nodeKey(m);
    }
    return null;
  };
  const treeText = async (): Promise<string> => {
    const all = await allMessagesForTree();
    // P2-10: in a /rewind turn window the active chain ends mid-tree (a
    // prefix, not a leaf) — the greatest-chain marking would swallow the
    // abandoned tail back into "current". Render unmarked and name the state.
    if (rewoundCutKey !== null) {
      return `会话树（已回退——活跃链从切点之前续接；/switch <n> 可切换）：\n${renderBranchTree(all, null)}`;
    }
    return `会话树（← = 活跃链；/edit <n> 开分叉，/switch <n> 切换）：\n${renderBranchTree(all, currentLeafKey())}`;
  };
  const switchBranchFn = async (n?: number): Promise<string> => {
    const all = await allMessagesForTree();
    const leaves = listBranchLeaves(all, currentLeafKey()).map((l) =>
      // P2-10: in a rewind window NO leaf is the active chain (it is a
      // prefix) — core's set-membership isCurrent would mark the abandoned
      // branch current AND make the switch-back a no-op refusal.
      rewoundCutKey !== null ? { ...l, isCurrent: false } : l,
    );
    if (leaves.length === 0) return "(还没有分支——本会话没有轮次)";
    if (n === undefined) {
      const lines = leaves.map((l) => `  ${l.n}.${l.isCurrent ? " *" : ""} ${l.forkPreview !== "" ? `分叉自 "${l.forkPreview}"` : "从头开始"} · ${l.messageCount} 条消息${l.isCurrent ? "（当前）" : ""}`);
      return `分支（/switch <n> 切换；* = 当前）：\n${lines.join("\n")}`;
    }
    const leaf = leaves.find((l) => l.n === n);
    if (leaf === undefined) return `用法：/switch [<n>]——没有分支 ${n}（选 1-${leaves.length}，或裸 /switch 列出）`;
    if (leaf.isCurrent) return `(分支 ${n} 已是活跃链)`;
    const chain = chainForTurn(all, leaf.leafKey);
    // M53 §2: when the fork predates the compaction boundary, the abandoned
    // branch's work since the fork is (partly) swallowed by the summary — a
    // plain swap would drop it entirely. Digest the span (16k, newest-first)
    // and inject it ONCE as the switching turn's leading context through the
    // MetaNote channel: the next model call sees it, the persisted history
    // never gains a message.
    let summaryNote = "";
    const fork = commonPrefixLength(state.messages, chain);
    if (fork > 0 && forkPredatesCompaction(state.messages, fork, SUMMARY_MARKER)) {
      summaryNote = branchSummaryNote(state.messages.slice(fork));
      if (summaryNote !== "") metaNotes.push({ text: summaryNote, source: "压缩摘要" });
    }
    // M53 review fix: the swap rebuilds the chain with the SAME load-time
    // projection resume uses — chained summary markers applied (pre-marker
    // bytes stay swallowed) and orphaned tool calls repaired — so switching
    // to a branch that compacted on its own never resurrects frozen bytes.
    // And the swap changes WHICH chain is active: record it so a restart
    // resumes the switched-to branch, never the flattened file.
    loadHistoryFn(repairOrphanedToolCalls(applySummaryMarkers(chain, { chain: true })), sessionId);
    recordActiveBranch(leaf.leafKey);
    return `⑂ switched to branch ${n} · ${chain.length} messages on the chain${summaryNote !== "" ? ` (branch-summary injected: ${summaryNote.length} chars)` : ""}`;
  };

  // ω99-258: the structured leaf table — switchBranchFn's data twin (same
  // read path, same P2-10 rewind-window mirror: no leaf is "current" while
  // the active chain is a rewound prefix), minus the notice formatting.
  const branchLeavesFn = async (): Promise<readonly BranchLeaf[]> => {
    const all = await allMessagesForTree();
    const leaves = listBranchLeaves(all, currentLeafKey());
    return rewoundCutKey !== null ? leaves.map((l) => ({ ...l, isCurrent: false })) : leaves;
  };
  // ω99-258: void a pending arm (the web banner's cancel). A wholesale chain
  // swap already disarms via loadHistoryFn; this is the banner's own door.
  const disarmEditFn = (): boolean => {
    pendingEditCut = null;
    return true;
  };

  // ω99-260: 面一 — the memory faces' data/decide closures. The PHYSICAL
  // store at o.workspaceRoot (the session anchor — the same root /memory and
  // memory_write use; NOT the switchable agentWorkspaceRoot, which moves the
  // tools' boundary but never any .wudao anchor). No workspace → the honest
  // empties: the panel's 空态, the card's hide, ok:false verdicts. Structured only — runMemoryCommand (TUI) never rides this path. 永续 v6 弧 A: blocked = 物理工作区拦截台账计数。
  const memoryListFn = async (): Promise<{ readonly entries: readonly MemoryEntryMirror[]; readonly blocked: number }> => {
    if (o.workspaceRoot === undefined) return { entries: [], blocked: 0 };
    return { entries: await openMemoryStore(o.workspaceRoot).load(), blocked: await blockedLearningCountAt(o.workspaceRoot).catch(() => 0) };
  };
  const memoryDecideFn = async (
    id: string,
    action: "ok" | "del",
  ): Promise<{ readonly ok: boolean; readonly message: string }> => {
    const MISS = "没有这条待审记忆（可能已处理过）";
    if (o.workspaceRoot === undefined) return { ok: false, message: MISS };
    const store = openMemoryStore(o.workspaceRoot);
    if (action === "ok") {
      return (await store.confirm(id)) ? { ok: true, message: "已确认一条记忆" } : { ok: false, message: MISS };
    }
    return (await store.remove(id)) ? { ok: true, message: "已删除一条记忆" } : { ok: false, message: MISS };
  };
  // ω99-264: the panel's 改写 closure — update + a CONDITIONAL confirm (the single-source stitch, zero new store verbs). Short-circuit FIRST: a
  // byte-equal content with the id present answers ok with ZERO writes (a bare update is NOT idempotent — v+1 per call — so the vault's mid-flap
  // replay must never reach the store; trim differences are REAL changes, no
  // fuzzy matching). update always lands pending (ω99-3a's law), so an ACTIVE
  // original gets confirm right back — the user's own key press is the human
  // gate's end, the entry never re-walks the LLM review door; a PENDING
  // original stays pending (the edit never decides for the user). tags are
  // NOT passed (update's absent-tags input preserves the original); hits
  // ride update verbatim. The store's own truth: update/confirm rewriteAll
  // the line in place — the JSONL line count never moves. 永续 v6 弧 A: a blocked rewrite (credential/injection-shaped) changes NOTHING.
  const memoryEditFn = async (
    id: string,
    content: string,
  ): Promise<{ readonly ok: boolean; readonly message: string }> => {
    const MISS = "没有这条记忆（可能已处理过）";
    if (o.workspaceRoot === undefined) return { ok: false, message: MISS };
    const store = openMemoryStore(o.workspaceRoot);
    const target = (await store.load()).find((e) => e.id === id);
    if (target === undefined) return { ok: false, message: MISS };
    const wasActive = target.status === "active";
    if (target.content === content) {
      // The vault-replay short-circuit: converged, zero writes.
      return { ok: true, message: wasActive ? "已改写一条记忆" : "已改写一条记忆（仍待你确认）" };
    }
    const updated = await store.update(id, { content });
    // 永续 v6 弧 A：被拦改写（凭据值/指令注入形状）——原条未动，与 MISS 分开说清。
    if (updated === "blocked") return { ok: false, message: "这条改写被拦下：内容含密钥值或指令注入形状，未入库（拦截清单可见）" };
    if (updated === undefined) return { ok: false, message: MISS }; // the line vanished mid-edit (removed elsewhere)
    if (wasActive) await store.confirm(id); // active → active（用户自己的授权链终点）
    return { ok: true, message: wasActive ? "已改写一条记忆" : "已改写一条记忆（仍待你确认）" };
  };

  // M53 §4: a `context: "fork"` skill runs its invocation in an ISOLATED fork
  // (read-only neutered tools, bounded turns) through the session registry —
  // the whole SKILL.md never enters the mainline; the fork's final answer
  // returns as a notice + a one-shot MetaNote the next model call sees.
  // Without a registry (stub-tool frontends) it degrades to the inline path
  // with a notice, never an error.
  // cc-plugins D2: the fork envelope gets the SUBSTITUTION pass only — the
  // child is a model context with no approval surface of its own, so
  // `!`cmd`` spans stay literal for it (the child's tools are neutered
  // read-only anyway; a fork-context injection seam belongs with D3's
  // invocation pass, not bolted on here).
  const runSkillFork = (skill: LoadedSkill, args: string): SubmitOutcome => {
    const registry = o.agentsRegistry;
    if (registry === undefined || o.workspaceRoot === undefined) {
      appendHistory({ kind: "notice", text: `(技能 ${skill.name} 请求分叉，但未配置后台 agent 注册表——改为内联运行)` });
      return submitCore(buildSubstitutedSkillMessage(skill, args, {
        sessionId,
        ...(o.workspaceRoot !== undefined ? { workspaceRoot: o.workspaceRoot } : {}),
        prunedFromContext: isSkillPruned(state.messages, skill.name),
      }), false);
    }
    const envelope = buildSubstitutedSkillMessage(skill, args, {
      sessionId,
      workspaceRoot: o.workspaceRoot,
    });
    try {
      const spawned = registry.spawn({
        model: o.model,
        allTools: neuterWriteTools(o.tools),
        role: {
          id: `skill-fork-${skill.name}`,
          description: `isolated skill fork (${skill.name})`,
          systemPrompt: state.systemPrompt,
          toolNames: [],
        },
        prompt: `${envelope}\n\n[system note: you are an isolated fork executing this skill — answer with the skill's result; your answer returns to the main conversation]`,
        forkFrom: { systemPrompt: state.systemPrompt, tools: neuterWriteTools(o.tools), messages: [] },
        maxTurns: 8,
        graceTools: [],
        onSettle: () => {},
      });
      appendHistory({ kind: "notice", text: `⑂ 技能 fork ${skill.name} 运行中（结果会回到这里）` }); // ω99-166f-iii: #10
      void spawned.done.then((result) => {
        const report = result.ok ? (result.report ?? "(fork finished with no report)") : `⚠️ skill fork 失败：${result.error ?? result.report}`; // ω99-166c-i: #3 failed 回执中文化（skill fork token 保留 ASCII；error??report 插值原样）。
        appendHistory({ kind: "notice", text: `⑂ 技能 fork ${skill.name}：${truncate(report, 400)}` }); // ω99-166f-iii: #11
        if (result.ok) metaNotes.push({ text: `[技能 ${skill.name} 在隔离 fork 中运行；结果如下]\n${report}`, source: `技能 fork · ${skill.name}` }); // ω99-166f-iii: #12（source 字段已中文原样）
      });
      return "notice";
    } catch (err) {
      appendHistory({ kind: "notice", text: `⚠️ skill fork 启动失败（${err instanceof Error ? err.message : String(err)}）——改为内联运行` }); // ω99-166c-iv: #4
      return submitCore(envelope, false);
    }
  };

  // 0.3.31 context-window guard (反馈 2026-08-30): a model/provider switch
  // may not land on a window smaller than the context the session already
  // carries — the next request would overflow with no recovery but a manual
  // rewind. The measure is the same occupancy the compactor triggers on
  // (ctxTokens.used = max(estimate, last real usage)); unknown (null, e.g.
  // right after a compaction) stays permissive — nothing proves overflow.
  // Over → REFUSED, naming /compact; a shrink that still fits → allowed
  // with the shrink noted (长窗→短窗提示). Pure: reads, returns lines.
  const contextSwitchGuard = (
    targetWindow: number | undefined,
    what: string,
  ): { readonly refuse: string | null; readonly note: string } => {
    const used = ctxTokens?.used ?? null;
    if (targetWindow === undefined || used === null) return { refuse: null, note: "" };
    if (used > targetWindow) {
      return {
        refuse: `⚠️ ${what} — 禁止切换：当前上下文已用约 ${used.toLocaleString("en-US")} tokens，超过目标模型窗口 ${targetWindow.toLocaleString("en-US")} — 先 /compact 压缩再切换，或改选更大窗口的模型`,
        note: "",
      };
    }
    const curWindow = ctxTokens?.window;
    if (curWindow !== undefined && targetWindow < curWindow) {
      return {
        refuse: null,
        note: `\n  (context window ${curWindow.toLocaleString("en-US")} → ${targetWindow.toLocaleString("en-US")} — 当前已用约 ${used.toLocaleString("en-US")} tokens，注意余量)`,
      };
    }
    return { refuse: null, note: "" };
  };

  /** The /model lane's target window: the matrix entry's cataloged
   *  contextLength (absent on uncataloged customs → undefined → guard
   *  permissive — nothing proves a shrink either). */
  const selectionContextWindow = (selection: ModelSelection): number | undefined =>
    selection.model === undefined
      ? undefined
      : (o.availableModels ?? availableModels()).find(
          (c) => c.model === selection.model && c.provider === (selection.provider ?? modelLive.provider),
        )?.contextLength;

  // M55 §B7 — the shared /model //effort switch path: record the M28 entries
  // (the JSONL is the transcript's model-state record), overlay the live
  // labels, and hand the selection to the frontend. Idle → applied now (the
  // NEXT request carries it); mid-run → parked for run settle so the in-flight
  // run's requests stay provider-consistent.
  const applyModelSwitch = (selection: ModelSelection, label: string): SubmitOutcome => {
    // M58 §C#13: the cache-cost note rides MODEL switches only (see the
    // constant's doc — effort prefixes don't move).
    const cacheNote = selection.model !== undefined ? `\n${MODEL_SWITCH_CACHE_NOTE}` : "";
    // 0.3.31: the context guard runs BEFORE the entry write — a refused
    // switch records nothing (the JSONL must never claim a switch that did
    // not land, the /provider funnel's rule).
    const guard = contextSwitchGuard(selectionContextWindow(selection), label);
    if (guard.refuse !== null) {
      appendHistory({ kind: "notice", text: guard.refuse });
      return "notice";
    }
    const finish = (): void => {
      if (selection.model !== undefined) modelLive = { ...modelLive, model: selection.model, ...(selection.provider !== undefined ? { provider: selection.provider } : {}) };
      if (selection.effort !== undefined) modelLive = { ...modelLive, effort: selection.effort };
      try {
        o.onModelSwitch?.(selection);
      } catch {
        // a frontend seam failure must not eat the switch — the entry is written
      }
      emit();
      appendHistory({ kind: "notice", text: `${label} —— 已记录（model_change 条目）并应用；下一个模型请求即生效${guard.note}${cacheNote}` }); // ω99-166f-ii: #6
    };
    if (o.workspaceRoot !== undefined) {
      void recordModelSwitch({ workspaceRoot: o.workspaceRoot, sessionId, selection })
        .catch((err) => {
          appendHistory({ kind: "notice", text: `⚠️ 模型切换记录未写入：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-iii: #4
        });
    }
    if (busy) {
      pendingModelApply = selection;
      appendHistory({ kind: "notice", text: `${label} —— 已记录；有运行在飞，切换在其收束时落地（下一轮）${guard.note}${cacheNote}` }); // ω99-166f-ii: #7
      return "notice";
    }
    finish();
    return "notice";
  };

  // M63 §A — the shared /provider switch path: build the replacement client,
  // and only on SUCCESS record the provider_change entry and swap the live
  // client. The JSONL must never claim a switch that did not land (review
  // LOW 2): a build that throws — now or at a parked switch's settle —
  // leaves the entry unwritten and the session on the old provider. Idle →
  // build + apply now (the NEXT run reads it); mid-run (tool phase / between
  // model calls) → the already-resolved config parks for run settle, and
  // `build` is deferred to exactly that boundary so the in-flight run's
  // requests stay on the old provider end-to-end. Mid-STREAM submissions
  // never reach here (refused in the routing below).
  const applyProviderSwitch = (
    config: import("@wudao/providers").ProviderConfig,
    provider: ProviderName,
    label: string,
    /** 0.3.32c kimi-401: an optional receipt line appended to BOTH the
     *  parked and the landing notice (the borrow warning today). */
    extra?: string,
  ): SubmitOutcome => {
    const from = modelLive.provider ?? o.statusline?.provider;
    const model = config.model;
    // 0.3.31 context guard: BEFORE the park/build — a refused switch never
    // parks, never builds, never records. The target's window comes from
    // the same resolver the compactor's window uses (profile catalog >
    // session-configured fallback).
    const guard = contextSwitchGuard(
      resolveContextWindowTokens(loadEffectiveProfiles(), provider, model, o.compaction?.contextWindowTokens ?? 64_000),
      label,
    );
    if (guard.refuse !== null) {
      appendHistory({ kind: "notice", text: guard.refuse });
      return "notice";
    }
    // Entry write AFTER a successful build (idle: below; parked: at settle).
    const writeEntry = (): void => {
      if (o.workspaceRoot === undefined) return;
      void recordProviderChange({ workspaceRoot: o.workspaceRoot, sessionId, to: provider, model, ...(from !== undefined ? { from } : {}) })
        .catch((err) => {
          appendHistory({ kind: "notice", text: `⚠️ provider 切换记录未写入：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-iii: #5
        });
    };
    if (busy) {
      // Last-wins: a second park replaces the first — the superseded switch
      // never builds, so it never records an entry (say so, visibly).
      if (pendingProviderApply !== null && pendingProviderApply.provider !== provider) {
        appendHistory({ kind: "notice", text: `（取代排队的到 ${pendingProviderApply.provider} 的切换——它永不构建，也不记录任何条目）` }); // ω99-166f-ii: #8
      }
      pendingProviderApply = { config, provider, model, from, writeEntry };
      appendHistory({ kind: "notice", text: `${label} —— 已排队；有运行在飞，切换在其收束时构建、落地并记录条目（下一轮界）${guard.note}\n${PROVIDER_SWITCH_CACHE_NOTE}${extra ?? ""}` }); // ω99-166f-ii: #9
      return "notice";
    }
    let client: ModelClient | undefined;
    try {
      client = o.onProviderSwitch?.build(config);
    } catch (err) {
      appendHistory({ kind: "notice", text: `⚠️ provider 切换到 ${provider} 失败：${err instanceof Error ? err.message : String(err)}——会话仍留在 ${from ?? "当前 provider"}（未记录切换）` }); // ω99-166c-i: #4 特款（动词前移款镜像 repl :2851；err 三元原样；全角括号收尾子句；m63:924 整句钉随改）。
      return "notice";
    }
    if (client === undefined) return "notice";
    o = { ...o, model: client };
    writeEntry();
    // 0.3.31: the shrink note rides the landing notice (same fold as /model).
    // 推理档三级配置 S2 (spec 2026-08-28 §1) — the switch RESETS the session
    // effort overlay to the new provider's re-derived chain value (the seam's
    // resolve already folded env pin > binding > global into
    // config.reasoningEffort). A pre-switch /effort override does NOT survive
    // the endpoint change — the intentional behavior change of this arc; a
    // post-switch /effort re-overrides. Fresh construction (not a spread):
    // the reset must also DROP a stale effort when the new chain is empty.
    const fromEffort = modelLive.effort;
    modelLive = { provider, model, ...(config.reasoningEffort !== undefined ? { effort: config.reasoningEffort } : {}) };
    const effortNote = effortResetNote(fromEffort, modelLive.effort);
    emit();
    appendHistory({ kind: "notice", text: `${label} —— 已记录（provider_change 条目）并应用；下一轮的请求即生效\n  （task 工具的子代理在下次会话前仍走原端点）${guard.note}${effortNote}\n${PROVIDER_SWITCH_CACHE_NOTE}${extra ?? ""}` }); // ω99-166f-ii: #10
    return "notice";
  };

  /** 推理档三级配置 S2 — the provider-switch effort reset line: emitted only
   *  when the switch MOVED the effective effort (a chain that lands where it
   *  stood says nothing new). "off" names the send-nothing state (binding
   *  null / empty chain), matching formatEffortList's off vocabulary. */
  const effortResetNote = (from: string | undefined, to: string | undefined): string =>
    (from ?? undefined) === (to ?? undefined)
      ? ""
      : `\n  (effort ${from ?? "off"} → ${to ?? "off"} — 供应商切换重置推理档为新供应商的配置（绑定 ?? 全局）；/effort 可再覆盖)`;

  // P1-7 (96 队列) — /worktree: the main session's isolated worktree. The
  // OPERATION root (tool cwd / permission workspace / extension face)
  // switches at the TURN BOUNDARY through the SAME applyAgentRoot seam the
  // TUI's agentRootSwitch uses; the SESSION anchor (o.workspaceRoot) never
  // moves — worktree_enter/worktree_exit entries and every persistent write
  // stay at the original repo (red line 1). The /provider discipline: enter
  // parks behind a busy run and lands at its settle; remove — destructive —
  // NEVER queues (refused while busy), and is refused again on uncommitted
  // changes (red line 2, CC 同款防丢).
  const writeWorktreeEntry = (kind: "worktree_enter" | "worktree_exit", data: Omit<WorktreeEntryData, "at">): void => {
    if (o.workspaceRoot === undefined) return; // no session root → nothing to pin to
    void recordWorktreeEntry({ workspaceRoot: o.workspaceRoot, sessionId, kind, data })
      .catch((err) => {
        appendHistory({ kind: "notice", text: `⚠️ worktree 切换记录未写入：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-iii: #6
      });
  };

  const worktreeStatusText = (): string =>
    formatWorktreeStatus(
      activeWorktree === null || o.workspaceRoot === undefined
        ? null
        : {
          name: activeWorktree.name,
          path: activeWorktree.path,
          branch: activeWorktree.branch,
          enteredAt: activeWorktree.enteredAt,
          sessionRoot: o.workspaceRoot,
        },
      pendingWorktreeOp === null
        ? null
        : pendingWorktreeOp.kind === "enter"
          ? `entering worktree ${pendingWorktreeOp.wt.name} (${pendingWorktreeOp.wt.branch}) — queued: lands at the next turn boundary`
          : `exiting worktree ${pendingWorktreeOp.wt.name} (keep) — queued: lands at the next turn boundary`,
    );

  /** enter: guards sync, git creation async. Idle → land now (with the
   *  busy re-check after the async gap — a run that started while git was
   *  working must not be re-rooted mid-run); busy → park to the settle. */
  const runWorktreeEnter = (nameRaw: string): void => {
    if (activeWorktree !== null) {
      appendHistory({ kind: "notice", text: `⚠️ 拒绝 /worktree enter：已在 worktree 中（${activeWorktree.name}，分支 ${activeWorktree.branch}）——请先 /worktree exit（不嵌套，CC 同款门）` }); // ω99-166c-iv: #5
      return;
    }
    if (pendingWorktreeOp !== null || worktreeOpInFlight) {
      appendHistory({ kind: "notice", text: "⚠️ 拒绝 /worktree enter：一次切换已排队到下一轮边界——/worktree 查看其状态" }); // ω99-166c-iv: #6
      return;
    }
    const name = nameRaw.trim() !== "" ? nameRaw.trim() : `session-${sessionId.slice(0, 8)}`;
    worktreeOpInFlight = true;
    void (async () => {
      try {
        // Base the worktree on the tree the agent currently works in (the
        // session root unless an agentRootSwitch moved it).
        const r = await enterMainWorktree(agentWorkspaceRoot, name);
        if (!r.ok) {
          appendHistory({ kind: "notice", text: `⚠️ /worktree enter 失败：${r.error}` }); // ω99-166c-i: #5 failed 回执中文化（/worktree enter 斜杠 token 原样；r.error 插值原样）。
          return;
        }
        const wt = r.worktree;
        const prevRoot = agentWorkspaceRoot;
        // The async gap could have started a run — never re-root mid-run
        // (red line 4): park instead.
        if (busy) {
          pendingAgentRoot = { path: wt.path, extRescan: true };
          pendingWorktreeOp = { kind: "enter", wt, prevRoot };
          appendHistory({
            kind: "notice",
            text: `🌳 worktree ${wt.branch} 已创建——有运行在飞，切换在其收束时落地（下一轮界）\n  路径：${wt.path}`, // ω99-166f-i: #3
          });
          emit();
          return;
        }
        // Bookkeeping BEFORE the landing: the guard must hold from the first
        // fs await of applyAgentRoot onward (a peer submit in the landing
        // window must see in-a-worktree, not create a sibling).
        activeWorktree = { ...wt, enteredAt: new Date().toISOString(), prevRoot };
        await applyAgentRoot(wt.path, true);
        writeWorktreeEntry("worktree_enter", wt);
        appendHistory({
          kind: "notice",
          text: `🌳 已进入 worktree ${wt.name}（分支 ${wt.branch}）\n  路径：${wt.path}\n  下一轮的工具在其中运行；会话 · 导出 · 成本仍留在原根`, // ω99-166f-i: #4
        });
      } finally {
        worktreeOpInFlight = false;
      }
    })();
  };

  /** exit keep|remove. keep while busy parks the switch back; remove is
   *  destructive and NEVER queues — refused while busy, refused again on
   *  uncommitted changes, and only then: root back FIRST, delete after. */
  const runWorktreeExit = (mode: "keep" | "remove"): void => {
    if (activeWorktree === null) {
      appendHistory({ kind: "notice", text: "⚠️ 拒绝 /worktree exit：当前不在 worktree 中——/worktree 查看会话状态" }); // ω99-166c-iv: #7
      return;
    }
    if (pendingWorktreeOp !== null || worktreeOpInFlight) {
      appendHistory({ kind: "notice", text: "⚠️ 拒绝 /worktree exit：一次切换已排队到下一轮边界" }); // ω99-166c-iv: #8
      return;
    }
    const wt = activeWorktree;
    if (busy) {
      if (mode === "remove") {
        appendHistory({ kind: "notice", text: "⚠️ 拒绝 /worktree exit remove：运行进行中（其工具可能仍在树中工作）——请等到轮边界后再 /worktree exit remove" }); // ω99-166c-iv: #9
        return;
      }
      pendingAgentRoot = { path: wt.prevRoot, extRescan: true };
      pendingWorktreeOp = { kind: "exit-keep", wt, prevRoot: wt.prevRoot };
      appendHistory({ kind: "notice", text: `🌳 /worktree exit keep 已排队——有运行在飞，切回在其收束时落地（下一轮界）` }); // ω99-166f-i: #5
      emit();
      return;
    }
    worktreeOpInFlight = true;
    void (async () => {
      try {
      // The async-gap re-check: a run that started since must not be
      // re-rooted (or have its tree deleted) mid-run.
      if (busy) {
        if (mode === "remove") {
          appendHistory({ kind: "notice", text: "⚠️ 拒绝 /worktree exit remove：一轮运行刚刚开始（其工具可能仍在树中工作）——请在其落定后重试" }); // ω99-166c-iv: #10
          return;
        }
        pendingAgentRoot = { path: wt.prevRoot, extRescan: true };
        pendingWorktreeOp = { kind: "exit-keep", wt, prevRoot: wt.prevRoot };
        appendHistory({ kind: "notice", text: "🌳 /worktree exit keep 已排队——运行刚起步，切回在其收束时落地（下一轮界）" }); // ω99-166f-i: #6
        emit();
        return;
      }
      if (mode === "remove") {
        const verdict = await worktreeRemoveBlocked(wt.path);
        if (verdict.blocked) {
          appendHistory({ kind: "notice", text: `⚠️ 拒绝 /worktree exit remove：${verdict.reason}` }); // ω99-166c-iv: #11
          emit();
          return;
        }
      }
      // Root back FIRST (the tools must never point into a deleted tree),
      // then the bookkeeping; removal runs last.
      await applyAgentRoot(wt.prevRoot, true);
      activeWorktree = null;
      if (mode === "keep") {
        writeWorktreeEntry("worktree_exit", { name: wt.name, path: wt.path, branch: wt.branch, mode: "keep" });
        appendHistory({ kind: "notice", text: `🌳 已退出 worktree ${wt.name}（keep）——树与分支保留在 ${wt.path}（分支 ${wt.branch}）` }); // ω99-166f-i: #7
        return;
      }
      const cleanup = await removeMainWorktree(wt.path);
      writeWorktreeEntry("worktree_exit", {
        name: wt.name,
        path: wt.path,
        branch: wt.branch,
        mode: "remove",
        cleanup: { removed: cleanup.removed, branchDeleted: cleanup.branchDeleted, ...(cleanup.reason !== undefined ? { reason: cleanup.reason } : {}) },
      });
      appendHistory({
        kind: "notice",
        text: cleanup.removed
          ? `🌳 已退出 worktree ${wt.name}（remove）——树已删除${cleanup.branchDeleted ? `，分支 ${wt.branch} 已删除` : `，分支 ${wt.branch} 保留（${cleanup.reason ?? "未合并"}——未破坏任何东西；可手动合并或删除）`}` // ω99-166f-i: #8
          : `🌳 已退出 worktree ${wt.name}——根已切回，但删除失败（${cleanup.reason ?? "未知"}）——树仍保留在 ${wt.path}`, // ω99-166f-i: #9
      });
      } finally {
        worktreeOpInFlight = false;
      }
    })();
  };

  // M80: the conversation wipe shared by the public clear() and the ROUTED
  // /clear (routedSubmit's case below). Everything session-scoped that lives
  // IN the driver resets: messages, the steering queue, the rendered history
  // (plus the reset frame to subscribers), the live overlays, the plan board,
  // and the ctx watermark. The armed /edit cut disarms here too — its branch
  // point belonged to the conversation being dropped (the documented
  // "any swap/clear disarms it" contract, now literally true on both paths).
  const clearConversation = (): void => {
    // M61 §3: /clear drops the goal with it (spec: /clear 连带清除).
    if (goalController !== undefined && goalController.active()) {
      appendHistory({ kind: "notice", text: goalController.clear("/clear") });
    }
    pendingEditCut = null;
    state.messages = [];
    queueRef.current = [];
    queued = [];
    // M80 review R1: the MetaNote queue is pre-clear context (a /rewind
    // files-rewound note, a /switch branch digest, a skill-fork result, the
    // memory-recall note, Slack thread context) — the loop drains the queue
    // into the next run's FIRST model call as <system_note> blocks, so a
    // queued note would ride into the "empty" post-clear conversation. Drain
    // it with the wipe; the external-change prober re-pushes on the next
    // actual change, the recall note re-derives from the next prompt.
    metaNotes.length = 0;
    // 0.3.10：已 take 未发火的来源随清除一起死（其注记已随回滚消亡）。
    takenNoteSources.length = 0;
    // M63-B R1: the system steering lane is pre-clear context as well.
    systemSteerQueue.length = 0;
    // M63-C §3: /clear ends the skill-position scope.
    clearSkillHooks("/clear");
    // ω99-56: /clear also ends the approval-gate posture (a fresh session
    // starts unarmed; compaction deliberately does NOT — fail-closed).
    disarmApprovalGate("/clear");
    history = [];
    historyOut = history;
    resetHistory();
    live = { reasoning: "", answer: "", busyTools: [] };
    // ω99-41: epoch reset — buffer and live wipe as a pair.
    answerBuf.reset();
    reasoningBuf.reset();
    pendingThinking = undefined;
    boardProgress = null;
    planBoard = null;
    planRun = false;
    // Fresh session: the watermark starts unmeasured, and a stale prompt-usage
    // number from the cleared context must not mask the next run's estimate.
    ctxTokens = null;
    lastPromptTokens = 0;
    emit();
    // M63-A: /clear is a session boundary — fired in the shared wipe so BOTH
    // the routed /clear (which then rotates the session id) and frontends
    // calling clear() directly see it exactly once.
    sessionStartHook("clear");
    // M63-B: the PREVIOUS session ends here (SessionEnd).
    sessionEndHook("clear");
  };

  // The routing seam (M43-A Task 3). Driver-executable commands and
  // @-mention expansion run HERE; UI-presentational commands return
  // "frontend" untouched. The parse names mirror parseReplCommand's routing
  // (builtin > plugin > extension), so both frontends agree on every line.
  const routedSubmit = (text: string, submitOpts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly ImageBlock[]; readonly files?: readonly FileBlock[] }): SubmitOutcome => {
    const expand = submitOpts?.expand !== false;
    // M79 §5: the submit envelope's optional images. Admission is fail-closed
    // BEFORE any routing side effect: junk blocks refuse with a notice, a
    // mid-run submit parks TEXT ONLY (an image steer is refused rather than
    // silently stripped — nothing may strand admitted attachments), and any
    // routed COMMAND refuses images (the command registry has no
    // `input.images` declaration slot yet — M80 TODO, dsh
    // CommandDefinition.input.images, research 40 §3).
    const images = submitOpts?.images !== undefined && submitOpts.images.length > 0 ? submitOpts.images : undefined;
    if (images !== undefined) {
      if (!images.every((b) => isValidImageBlock(b))) {
        appendHistory({ kind: "notice", text: "⚠️ 提交时图片块无效（应为 {kind:'image', ref:{attachmentId, mediaType, byteLength}}）——未提交任何内容" }); // ω99-166c-iv: #12
        return "notice";
      }
      if (busy) {
        appendHistory({ kind: "notice", text: "⚠️ 运行中无法提交图片——请等本轮结束后再重新提交" }); // ω99-166c-iv: #13
        return "notice";
      }
    }
    // ω99-55: the file lane, the same fail-closed law (junk blocks / a busy
    // run / a routed command each refuse with a notice — nothing strands).
    const files = submitOpts?.files !== undefined && submitOpts.files.length > 0 ? submitOpts.files : undefined;
    if (files !== undefined) {
      if (!files.every((b) => isValidFileBlock(b))) {
        appendHistory({ kind: "notice", text: "⚠️ 提交时文件块无效（应为 {kind:'file', name, bytes, attachmentId:'sha256:<hex>'}）——未提交任何内容" }); // ω99-166c-iv: #14
        return "notice";
      }
      if (busy) {
        appendHistory({ kind: "notice", text: "⚠️ 运行中无法提交文件——请等本轮结束后再重新提交" }); // ω99-166c-iv: #15
        return "notice";
      }
    }
    if (submitOpts?.plan === true) {
      // A pre-flagged plan submission (the /plan path below and the one-shot
      // seam): the envelope is already built — no re-parse, no expansion.
      return submitCore(text, true, images, files);
    }
    if (!expand) {
      // A pre-built envelope (plugin/extension invocation): verbatim.
      return submitCore(text, false, images, files);
    }
    const cmd = parseReplCommand(text, (o.pluginCommands ?? []).map((c) => c.name), (o.extensionCommands ?? []).map((c) => c.name), o.skills ?? []);
    // ui-review-r5 C1: an IMAGE-ONLY send (empty text + staged images) is a
    // PROMPT — parseReplCommand("") parses as noop, so the command-mismatch
    // refusal below would reject exactly what the web composer arms for
    // ("look at this screenshot"). Nothing to parse → straight to the core
    // submit path (the busy-steer/browse-guard/queueing arms live there).
    // ω99-55: a FILE-ONLY send arms the same way ("review this pdf").
    if ((images !== undefined && images.length > 0) || (files !== undefined && files.length > 0)) {
      if (text.trim() === "") {
        return submitCore(text, true, images, files);
      }
    }
    if ((images !== undefined || files !== undefined) && cmd.kind !== "prompt") {
      appendHistory({ kind: "notice", text: `⚠️ 附件无法随命令 "${text.split(/\s/)[0] ?? text}" 提交（尚无命令声明附件输入）——未提交任何内容` }); // ω99-166c-iv: #16
      return "notice";
    }
    switch (cmd.kind) {
      case "noop":
        return "noop";
      // M80: /clear — the driver-owned reset. The TUI/REPL intercept /clear
      // BEFORE submit (their frontends own the confirm flow and the id
      // rotation), so this arm runs only for frontends that submit the line
      // verbatim (web/WS, Slack, direct API consumers) — and for them THIS is
      // the whole clear: the conversation state is wiped so the NEXT model
      // request serializes an empty prompt (before M80 the "cleared" context
      // silently rode along), the session id rotates to a fresh segment, and
      // the boundary marker lands on the old id's JSONL. Why a fresh id
      // instead of a branch cut: core's resume projection is per-id linear
      // (resumeChain walks parentUuid from the recorded active_branch leaf;
      // an "empty leaf" is not representable — an empty leafKey is skipped
      // and the load falls back to the flattened file), so the segment id IS
      // the clear boundary; resume of the pre-clear id still reaches the old
      // content, untouched. Cache note (the M24 invariant): the next request
      // runs on a COLD prefix — expected and fine. A clear is a boundary, not
      // a cache violation: nothing rewrote history bytes anywhere; the
      // post-clear conversation starts a fresh JSONL and warms its own
      // prefix from turn one.
      case "clear": {
        if (busy) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /clear（任务进行中）" });
          return "notice";
        }
        const from = sessionId;
        clearConversation();
        setSessionId(newSessionId());
        // The fresh segment is nameless — the pre-clear session's name must
        // not ride the new id's status face.
        setSessionNameCached(null);
        // The scheduler's scope follows the rotation (the setSessionId
        // convention). Frontend-owned bindings (the extensions' session
        // channel, the file-history dir, the spill dir) stay on the pre-clear
        // instances — the web engine binds those per process lifetime, the
        // same as its resume path.
        o.cron?.setSessionId(sessionId);
        if (sessionStore !== undefined) {
          void sessionStore.appendEntry(from, buildClearBoundaryEntry(sessionId)).catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ clear 边界记录未写入：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-iii: #7
          });
        }
        o.onSessionCleared?.({ fromSessionId: from, toSessionId: sessionId });
        // The frontend's identity-based persistence base must follow the
        // wholesale replacement (same contract as /switch's loadHistory) —
        // with it, the next run persists only post-clear turns, under the
        // fresh segment id.
        o.onHistoryReplaced?.(state.messages, sessionId);
        emit();
        return "cleared";
      }
      case "exit":
      case "help":
      case "resume":
      case "pluginCommand":
      case "extensionCommand":
        // UI-presentational / frontend-owned — the caller renders it.
        return "frontend";
      // SDD 2026-08-23 persona 层：driver 级 /persona 处理器 — 与 REPL
      // 处理器（repl.ts ~1668）语义逐行对齐，stdout.write → appendHistory
      // notice。切换是 PersonaRuntime.current 的字段替换（次轮生效、无
      // client 重建——/model 先例）。frontend 注入 persona seam 后 TUI/Web
      // 的 /persona 在这里闭环；未注入 → 降级告知（back-compat）。
      case "persona": {
        const p = o.persona;
        if (p === undefined) {
          appendHistory({
            kind: "notice",
            text: "（此前端不支持切换 persona——未注入 persona 上下文，前端提供之前 persona 不可用；/persona 归 readline REPL 所有；如需预设，用 WUDAO_PERSONA=<id> 重启）",
          }); // ω99-166f-ii: #11
          return "notice";
        }
        const arg = parsePersonaArgument(cmd.rest);
        // PersonaArgument 的 error 变体没有 kind 字段（Task 12 类型）——
        // `in` 判别是该联合上唯一的窄化写法（`.ok` 在 kind 变体上不存在）。
        if ("error" in arg) {
          appendHistory({ kind: "notice", text: arg.error });
          return "notice";
        }
        if (arg.kind === "list") {
          // provenance 标注（controller ruling）：本会话手动层在 → [manual]；
          // 否则走解析链 provenance 映射 env→[env]、binding→[bound:<id>]、
          // default→[default]、none→无标（与 resolveActivePersona 同源）。
          const markForList = (): string | undefined => {
            if (personaManualLayerOn) return "manual";
            const chain = p.chain();
            const active = resolveActivePersona(p.registry, chain);
            if (active.provenance === "env") return "env";
            if (active.provenance === "binding") return `bound:${chain.bindingId as string}`;
            if (active.provenance === "default") return "default";
            return undefined;
          };
          appendHistory({ kind: "notice", text: formatPersonaList(p.registry, p.runtime.current?.definition.id ?? null, markForList()) });
          return "notice";
        }
        // Phase B 对齐：mismatch note 检查 LIVE wire 说的协议（frontend 的
        // 构造缝按 wire 分发——driver 不再假设 openai-chat-only）。调用点
        // 必须在 runtime.current 赋值之后：applyWirePersona 读 runtime 的
        // 当前 persona。
        const liveProtocol = p.wire();
        const mismatchNoteFor = (target: ResolvedPersona | null): string => {
          if (target === null) return "";
          const wireDefined = applyWirePersona(p.runtime, liveProtocol) !== null;
          return (target.layers.headers || target.layers.body) && !wireDefined
            ? `\n注：此 persona 未定义 ${liveProtocol} 的 headers/body——这里只有 prompt 层生效` // ω99-166f-ii: #12
            : "";
        };
        const oldPersona = p.runtime.current;
        const recordChange = (
          to: { id: string | null; layers: ResolvedPersona["layers"]; spec?: string },
          cold: boolean,
          reason: "manual" | "off",
        ): void => {
          if (o.workspaceRoot === undefined) return; // 无工作区 = 不落盘（/memory 同款边界）
          const write = async (): Promise<void> => {
            try {
              await recordPersonaChange({
                workspaceRoot: o.workspaceRoot as string,
                sessionId,
                to,
                ...(oldPersona !== null ? { from: { id: oldPersona.definition.id } } : {}),
                coldTurnExpected: cold,
                reason,
              });
            } catch (err) {
              appendHistory({ kind: "notice", text: `⚠️ persona 切换记录未写入：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-iii: #8
            }
          };
          personaRecordChain = personaRecordChain.then(write, write);
        };
        if (arg.kind === "off") {
          // --off = 清手动层、走解析链（env > binding > default；REPL 的
          // bootstrap 兜底在此泛化为全链），不是强制 null。链上坏
          // binding/default 落穿并带 warning——呈现，不吞。
          const back = resolveActivePersona(p.registry, p.chain());
          p.runtime.current = back.resolved;
          personaManualLayerOn = false;
          const cold = personaSwitchBreaksCache(oldPersona, back.resolved);
          recordChange(
            {
              id: back.resolved?.definition.id ?? null,
              layers: back.resolved?.layers ?? { headers: false, body: false, prompt: false },
              // Layer-selection Task 1: the effective qualified ref when the
              // re-walked chain lands on a qualified binding/default.
              ...(back.spec !== undefined ? { spec: back.spec } : {}),
            },
            cold,
            "off",
          );
          appendHistory({
            kind: "notice",
            text: `persona → ${back.resolved?.definition.id ?? "off (bare client)"} —— 下一个请求即生效${mismatchNoteFor(back.resolved)}${cold ? `\n${PERSONA_SWITCH_CACHE_NOTE}` : ""}${back.warning !== undefined ? `\n⚠️ ${back.warning}` : ""}`,
          }); // ω99-166f-ii: #13
          return "notice";
        }
        const v = resolvePersonaSwitch(p.registry, arg.id, arg.flag);
        if (!v.ok) {
          appendHistory({ kind: "notice", text: v.error });
          return "notice"; // fail-closed：runtime.current 未动
        }
        p.runtime.current = v.resolved;
        personaManualLayerOn = true;
        const cold = personaSwitchBreaksCache(oldPersona, v.resolved);
        recordChange({ id: v.resolved.definition.id, layers: v.resolved.layers }, cold, "manual");
        const on = (["headers", "body", "prompt"] as const).filter((k) => v.resolved.layers[k]).join("+");
        // I1 对齐（final review）：层标了开但 live wire 上什么都没定义——
        // wire 字节不变；直说，别让 "[headers+body]" 暗示了 wire 效果。
        const mismatchNote = mismatchNoteFor(v.resolved);
        appendHistory({
          kind: "notice",
          text: `persona → ${v.resolved.definition.id} [${on}] —— 下一个请求即生效${mismatchNote}${cold ? `\n${PERSONA_SWITCH_CACHE_NOTE}` : ""}`,
        }); // ω99-166f-ii: #14
        return "notice";
      }
      // M37 §2: /rewind [n|last] — list the session's recorded file changes,
      // or roll the workspace back to before a step (read-state entries for
      // the touched files drop; the model learns via the MetaNote queue).
      // P2-10 (96 队列): the `turn` sub-grammar adds the conversation档 —
      // `turn` lists (read-only, allowed mid-run like bare /switch), `turn <n>`
      // swaps the active chain (refused mid-run, the /switch discipline).
      // The file forms keep their exact busy/usage bytes.
      case "rewind": {
        const target = parseRewindTarget(cmd.args);
        if (busy && target.kind !== "turn-list") {
          appendHistory({
            kind: "notice",
            text:
              target.kind === "turn"
                ? "⚠️ 运行中无法 /rewind turn（任务进行中）"
                : "⚠️ 运行中无法 /rewind（任务进行中）",
          });
          return "notice";
        }
        if (target.kind === "bad") {
          appendHistory({
            kind: "notice",
            text: /^turn\b/i.test(target.raw)
              ? `用法：/rewind turn [<n>]——无法识别 "${target.raw}"（裸 /rewind turn 列出消息清单）`
              : `用法：/rewind [<n>|last]——无法识别 "${target.raw}"`,
          });
          return "notice";
        }
        if (target.kind === "turn-list" || target.kind === "turn") {
          void rewindTurn(target.kind === "turn" ? target.n : undefined).catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ rewind 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #6 failed 回执中文化（rewind token 保留 ASCII；err 三元原样）。
          });
          return "notice";
        }
        void rewindTo(target.kind === "list" ? "list" : target.kind === "last" ? "last" : target.n).catch((err) => {
          appendHistory({ kind: "notice", text: `⚠️ rewind 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #7 failed 回执中文化（rewind 孪生臂；err 三元原样）。
        });
        return "notice";
      }
      // M49 §1: /memory [list|del <id>|ok <id>] — the memory store's command
      // face (workspace-scoped; the store is .wudao/memory.jsonl).
      // M-Memory 弧第二半：新动词面（search/save/forget/list/refresh/on/off）
      // 先走长期记忆（.wudao/memory/memory.jsonl）；旧动词（del/ok/edit/dream）
      // 回落 M49 原面。
      case "memory": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（memory 不可用——无工作区）" }); // ω99-166d-ii: #17（括号 notice 族中文化）
          return "notice";
        }
        void (async () => {
          const lts = longtermMemoryRuntimeFor();
          const ltsText = lts === undefined
            ? undefined
            : await runLongtermMemoryVerb({ workspaceRoot: o.workspaceRoot as string, verbArgs: cmd.args, runtime: lts, state });
          if (ltsText !== undefined) return ltsText;
          return runMemoryCommand(
            o.workspaceRoot as string,
            cmd.args,
            // ω-4f: the dream verb's session model + registry (other verbs
            // ignore it; a registry-less session gets the usage line instead).
            o.agentsRegistry !== undefined ? { model: o.model, registry: o.agentsRegistry } : undefined,
          );
        })()
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ memory 命令失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #8 failed 回执中文化（command→命令；memory token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // ω99-3a: /refine [instructions]|rollback <refineId> — the Continual
      // Harness session refiner (the same engine the REPL lane runs). The
      // driver threads the session model + live trajectory; runRefineCommand
      // owns the pending/rollback discipline. Busy-safe like /memory: the
      // plan rides a one-shot prompt, the apply is store-only.
      case "refine": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（refine 不可用——无工作区）" }); // ω99-166d-ii: #18（括号 notice 族中文化）
          return "notice";
        }
        void runRefineCommand(o.workspaceRoot, cmd.args, { model: o.model, messages: state.messages })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ refine 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #9 failed 回执中文化（refine token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // ω99-62: /find — the TUI overlay's graceful degradation, driver lane.
      // One arm covers every frontend that submits through this routing
      // seam (web/desktop via `wudao ui`, Slack, direct API consumers); the
      // TUI never reaches here (app.tsx intercepts /find before its parse —
      // test-pinned), and the readline REPL answers the same bytes from its
      // own chain branch. A notice, not an error: the command is REAL, it
      // just lives on a surface this frontend doesn't have — the copy says
      // what it does and names the cross-session sibling (/search). Bare
      // /find answers the same shape (the copy carries the usage pointer);
      // works mid-run for free — nothing starts, no model call, no JSONL.
      case "find": {
        appendHistory({ kind: "notice", text: FIND_TUI_ONLY_NOTICE });
        return "notice";
      }
      // M49 §3: /search <query> — CJK-aware search across .wudao/sessions
      // (the same engine the `wudao sessions search` subcommand uses).
      case "search": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（search 不可用——无工作区）" }); // ω99-166d-ii: #19（括号 notice 族中文化）
          return "notice";
        }
        void runSessionSearch(o.workspaceRoot, cmd.query)
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ search 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #10 failed 回执中文化（search token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // 夜移 014 → ω99-316: /btw <question> — the cache-shared side question
      // (真 CC sideQuestion.ts 的 wudao 适配, now a DETACHED LOOP). The fork
      // rides the session's prefix bytes: systemPrompt, the full message
      // history, and the tool list are identical to the main run's (the
      // same-table freeze keeps the tool DECLARATIONS byte-identical while
      // execute returns a structured frozen error — an empty table would
      // evict the prefix cache), so the provider's prefix cache absorbs the
      // whole conversation and the side call costs only the suffix tokens.
      // The side run is a cloned State through core runAgentLoop with
      // maxTurns=3 (SIDE_QUESTION_MAX_TURNS) — never this session's
      // AgentState, never the JSONL, never the store. Works mid-run by
      // design — a side question that must wait for the run to finish is
      // not a side question; the snapshot is taken atomically at submit
      // time (mid-run half-messages are sanitized out — the honest edge:
      // an answer streamed but not yet committed is not in the snapshot).
      // The answer is a driver notice: visible in every frontend (one
      // wiring), never a state message, never persisted, never
      // model-visible.
      case "btw": {
        if (cmd.question === "") {
          appendHistory({ kind: "notice", text: "用法：/btw <问题> — 不打断主任务，借用会话缓存前缀旁路提问" }); // ω99-166d-i: #38
          return "notice";
        }
        void enqueueSideQuestion(cmd.question).then((result) => {
          appendHistory({
            kind: "notice",
            text: result.answer === "" ? "💬（旁问没有产生回答——请换个问法直接提问）" : `💬 ${result.answer}`,
          });
        })
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ 旁问失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-205: #2
          });
        return "notice";
      }
      // M52 §1: /compact — manual compaction NOW, regardless of occupancy.
      // The same tier pipeline minus the threshold gate; reason "manual" all
      // the way down (the notice line + the compact_boundary session entry).
      case "compact": {
        if (busy) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /compact（任务进行中）" });
          return "notice";
        }
        // ω99-45: compaction needs a SETTLED session — the isIdle gate. A
        // second /compact while one is in flight, or a not-yet-drained
        // queue/monitor backlog, would race this driver-level rewrite of
        // state.messages. (busy is checked first so its notice stays
        // byte-identical.)
        if (!sessionIdle()) {
          appendHistory({ kind: "notice", text: "⚠️ 会话未空闲，无法 /compact（压缩进行中或队列/monitor 未清）" });
          return "notice";
        }
        // ω99-45: the compaction's own cancellation controller — created
        // synchronously so isIdle sees the session busy immediately, aborted
        // by interrupt()/setActive(false) at the same cancel point the run
        // uses, cleared at the compaction's settle.
        const compactAbort = new AbortController();
        compactionAbort = compactAbort;
        void (async () => {
          try {
            const toolDefs = state.tools.map(toModelToolDefinition);
            // Rebuild the ghost-skill map over the existing messages (the
            // loop builds its own at execution time; manual compaction walks
            // the recorded calls instead).
            const classifier = createSkillReadClassifier(o.skills ?? []);
            const reads = new Map<string, { name: string; path: string }>();
            for (const m of state.messages) {
              if (m.role !== "assistant" || !m.toolCalls) continue;
              for (const tc of m.toolCalls) {
                const read = classifier(tc.name, tc.arguments as Record<string, unknown>);
                if (read !== undefined) reads.set(tc.id, read);
              }
            }
            // M63-A: the manual PreCompact gate — the hook sees trigger
            // "manual" and may DEFER this compaction (the same contract the
            // loop applies to its auto compactions). Zero extra awaits when
            // no hook is configured (timing-sensitive callers ride this path).
            const manualPreHook = o.hooks?.onPreCompact;
            if (manualPreHook !== undefined) {
              let manualPre: import("@wudao/core").PreCompactDecision = "compact";
              try {
                manualPre = (await manualPreHook(state.messages, "manual")) ?? "compact";
              } catch {
                manualPre = "compact";
              }
              if (typeof manualPre === "object" && manualPre.defer) {
                appendHistory({ kind: "notice", text: `⏸ 压缩已推迟：${manualPre.reason ?? "preCompact 钩子推迟"}` }); // ω99-166f-iii: #8（#7 孪生；fallback 串同步中文）
                return;
              }
            }
            // 125 项 1/项 2: the manual rotation's identity + world snapshot,
            // computed BEFORE manualCompact (the snapshot must describe the
            // window being closed — state.messages is replaced below). Index
            // = boundaries so far + 1; the diff baseline is the last boundary's
            // snapshot (undefined on a never-compacted session → no diff).
            const manualWindowIdentity = { index: windowBoundaryCount + 1, sessionKey: sessionId.slice(0, 8) };
            const manualWorldSnapshot = worldStateSnapshot();
            const manualWorldDiff =
              lastWorldSnapshot !== undefined ? worldStateDiff(lastWorldSnapshot, manualWorldSnapshot) : undefined;
            const out = await manualCompact(
              { systemPrompt: state.systemPrompt, tools: toolDefs, messages: state.messages, model: o.model, signal: compactAbort.signal },
              {
                keepRecent: o.compaction?.keepRecent ?? 6,
                systemPrompt: state.systemPrompt,
                tools: toolDefs,
                skillReads: reads,
                // M58 §C#2: the command's focus phrase + the session's standing
                // compact instructions ride the tier-2 summary instruction.
                ...(cmd.focus !== undefined ? { focus: cmd.focus } : {}),
                ...(o.compaction?.compactInstructions !== undefined || compactInstructionsRider !== undefined
                  ? { compactInstructions: o.compaction?.compactInstructions ?? compactInstructionsRider }
                  : {}),
                // M58 §C#12: the session's current reasoning_effort rides the
                // summary request (explicit caller value wins).
                ...(o.compaction?.reasoningEffort !== undefined
                  ? { reasoningEffort: o.compaction.reasoningEffort }
                  : modelLive.effort !== undefined && modelLive.effort !== ""
                    ? { reasoningEffort: modelLive.effort }
                    : {}),
                // #38: the digest front-stage switch forwards to the MANUAL
                // compact too (the loop's auto path already spreads it at the
                // runAgentLoop call — an escape must not silently stop working
                // the moment the user types /compact).
                ...(o.compaction?.zeroLlmDigest !== undefined ? { zeroLlmDigest: o.compaction.zeroLlmDigest } : {}),
                // 125 项 1/项 2: the rotation identity + world diff ride the
                // manual boundary's summary header (same seat as the loop's
                // auto compactions).
                windowIdentity: manualWindowIdentity,
                ...(manualWorldDiff !== undefined && manualWorldDiff !== "" ? { worldDiff: manualWorldDiff } : {}),
              },
            );
            if (out === null) {
              appendHistory({ kind: "notice", text: "（无可压缩——无 span、无双分区、无大块可清）" }); // ω99-166d-ii: #20（=repl #7 逐字孪生）
              return;
            }
            state.messages = out.messages;
            ctxUnknown = true;
            ctxTokens = { used: null, window: o.compaction?.contextWindowTokens ?? 64_000, nearLimit: false };
            emit();
            appendHistory({ kind: "notice", text: formatCompactedLine(out.tier, "manual", out.beforeTokens, out.afterTokens) });
            if (out.summaryMessage !== undefined) o.onCompacted?.(out.summaryMessage);
            if (out.firstKeptEntryId !== undefined) {
              // 125 项 1/项 2: the manual boundary carries the same additive
              // window fields (and advances the bookkeeping identically).
              o.onCompactBoundary?.({
                firstKeptEntryId: out.firstKeptEntryId,
                reason: "manual",
                tier: out.tier,
                windowIndex: manualWindowIdentity.index,
                worldState: manualWorldSnapshot,
              });
              windowBoundaryCount = Math.max(windowBoundaryCount, manualWindowIdentity.index);
              lastWorldSnapshot = manualWorldSnapshot;
            }
            // M63-A: the manual PostCompact observer + the compact boundary
            // as a SessionStart source (the session continues past it).
            // ω99-7: manual /compact arms the auto-refine compact trigger
            // too (the memoized singleton — OFF stays a no-op).
            if (o.workspaceRoot !== undefined) {
              (await refineAutoRuntimeFor(o.workspaceRoot))?.noteCompacted();
            }
            try {
              await o.hooks?.onPostCompact?.(state.messages, "manual");
            } catch {
              /* observer isolation */
            }
            sessionStartHook("compact");
            // M63-C §3: compaction clears the skill-position scope.
            clearSkillHooks("compaction");
          } catch (err) {
            // ω99-45: an aborted compaction is a CANCEL, not a failure — no
            // boundary landed, the history is untouched, and the notice says
            // so instead of crying provider error.
            appendHistory({
              kind: "notice",
              text: compactAbort.signal.aborted
                ? "⚠️ compact 已中止——未写入边界" // ω99-166c-iii: #9
                : `⚠️ compact 失败：${err instanceof Error ? err.message : String(err)}`, // ω99-166c-i: #11 failed 回执中文化（三元失败臂；:4886 aborted 散面不触=166c-ii 域）。
            });
          } finally {
            // ω99-45: the controller dies at settle — isIdle sees the session
            // quiet again. Identity-checked: only the OWNER clears (a guard
            // against an impossible overlap the isIdle gate above already
            // excludes).
            if (compactionAbort === compactAbort) {
              compactionAbort = null;
              // ω99-85: the settle drain — the twin of the run settle seam
              // (startRun's completion drain): a submit parked while the
              // compaction held the window runs NOW, as a fresh run on the
              // post-boundary chain (the abort path lands here too — an
              // Esc-cancelled compaction still owes the parked submit its
              // run; the user message is never dropped). Report 95 R2
              // discipline, verbatim: emit() runs subscribers
              // synchronously, so a racing submit/poller can flip busy back
              // to true inside this window — re-check AFTER the emit and
              // park the payload back at the head rather than double a run.
              // The low-priority lanes (cron/peer/childMail) deliberately do
              // NOT fire here, unlike the run settle's else-if: their
              // pollers' ω99-45 guards release the instant compactionAbort
              // cleared above and self-serve on their next tick — this
              // seam's only tenant is the parked submit.
              const next = queueRef.current.shift();
              if (next !== undefined) {
                queued = [...queueRef.current];
                emit();
                if (busy) {
                  queueRef.current = [next, ...queueRef.current];
                  queued = [...queueRef.current];
                  emit();
                } else {
                  startRun(next, false);
                }
              }
            }
          }
        })();
        return "notice";
      }
      // M52 §3: /context — the occupancy report over the REAL projection (compact boundary → clear → microcompact, then counting). The notice entry renders in every driver frontend (TUI + Web).
      case "context": {
        appendHistory({
          kind: "notice",
          text: formatContextReport(
            buildContextReport({
              systemPrompt: state.systemPrompt,
              tools: state.tools,
              messages: state.messages,
              contextWindowTokens: o.compaction?.contextWindowTokens ?? 64_000,
            }),
          ),
        });
        return "notice";
      }
      // M53 §1: /edit [<n>] — list the recent user messages, or arm message n
      // for editing. Frontends with an input box intercept the numeric form
      // BEFORE submit (driver.beginEdit); this path arms the branch for the rest.
      case "edit": {
        if (busy) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /edit（任务进行中）" });
          return "notice";
        }
        if (cmd.n === undefined) {
          appendHistory({ kind: "notice", text: formatEditList(editTargets()) });
          return "notice";
        }
        const text = beginEditFn(cmd.n);
        if (text === undefined) {
          appendHistory({ kind: "notice", text: `用法：/edit <n>——没有第 ${cmd.n} 条消息（裸 /edit 列出可选消息，1 = 最近一条）` });
          return "notice";
        }
        appendHistory({ kind: "notice", text: `✎ 已把第 ${cmd.n} 条消息放回输入——重发(改或不改)即从其父节点开分叉；原文：${truncate(text, 80)}` });
        return "notice";
      }
      // PB-2（探针基础设施弧）— /probe：探针遥测直读查询（读面 notice；busy
      // 安全——零模型调用，/context 同族；REPL 本地处理，此路覆盖 TUI/Web submit）。
      case "probe": {
        appendHistory({ kind: "notice", text: formatProbeReport(getDefaultProbeBus(), parseProbeArgs(cmd.args)) });
        return "notice";
      }
      // M53 §1: /tree — the ASCII branch topology (read-only; allowed while busy — reads the persisted tree, never the live run).
      case "tree": {
        void treeText()
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => appendHistory({ kind: "notice", text: `⚠️ tree 失败：${err instanceof Error ? err.message : String(err)}` })); // ω99-166c-i: #12 failed 回执中文化（tree token 保留 ASCII；err 三元原样）。
        return "notice";
      }
      // M53 §1: /switch [<n>] — list the branches, or swap the active chain.
      case "switch": {
        if (busy && cmd.n !== undefined) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /switch（任务进行中）" });
          return "notice";
        }
        void switchBranchFn(cmd.n)
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => appendHistory({ kind: "notice", text: `⚠️ switch 失败：${err instanceof Error ? err.message : String(err)}` })); // ω99-166c-i: #13 failed 回执中文化（switch token 保留 ASCII；err 三元原样）。
        return "notice";
      }
      // M55 §A2: /status — the offline one-pager from the driver's own live state (version/mode/session/ctx/watermark + the loaded surfaces).
      case "status": {
        // M55 §B7: the live overlay (initial sessionMeta + any /model //effort
        // switches) — /status shows what the NEXT request will carry.
        const meta = modelLive;
        const keySnapshot = o.statusline?.keys?.snapshot();
        appendHistory({
          kind: "notice",
          text: formatStatusReport({
            version: VERSION,
            provider: meta.provider,
            model: meta.model,
            mode: modeLabel(mode),
            sessionId,
            ctx: ctxTokens === null ? null : { used: ctxTokens.used, window: ctxTokens.window },
            ...(keySnapshot !== undefined ? { keys: keySnapshot } : {}),
            // ω99-83: the frontend's holder — 42's reasoning line on the
            // driver lanes, same conditional-spread form as the keys line.
            ...(o.mandatoryRepairArmed?.current ? { reasoningMandatoryPreArmed: true } : {}),
            surfaces: {
              skills: (o.skills ?? []).length,
              plugins: (o.pluginCommands ?? []).length,
              extensions: (o.extensionCommands ?? []).length,
              mcp: o.tools.filter((t) => t.name.startsWith("mcp__")).length,
              tools: o.tools.length,
            },
          }),
        });
        return "notice";
      }
      // M55 §A3: /cost — session totals folded from the usage events + the
      // wall clock since the driver was created. M56 §3: the registry summary
      // adds the $ line (priced) + the unpriced≠free note. P0-4 (96 队列):
      // `scope: "all"` swaps in the cross-session wallet view (.wudao/costs.jsonl)
      // — the ledger renders first, then the lazy balance fetch appends its line(s) (unconfigured → silent; failure → one line;
      // the ≤8s wait rides the command's async notice, never the submit path).
      case "cost": {
        if (cmd.scope === "all") {
          if (o.workspaceRoot === undefined) {
            appendHistory({ kind: "notice", text: "（cost 全景不可用——无工作区）" }); // ω99-166d-ii: #21（括号 notice 族中文化）
            return "notice";
          }
          const root = o.workspaceRoot;
          void (async () => {
            try {
              const agg = aggregateCostLedger(readCostLedger(root));
              let balance: WalletBalanceOutcome | undefined;
              try {
                balance = await fetchWalletBalance({ provider: modelLive.provider });
              } catch (err) {
                balance = { balanceError: err instanceof Error ? err.message : String(err) };
              }
              appendHistory({ kind: "notice", text: renderWalletReport(agg, balance ?? {}) });
            } catch (err) {
              appendHistory({ kind: "notice", text: `⚠️ cost all 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #14 failed 回执中文化（cost all 子命令 token 保留 ASCII；err 三元原样）。
            }
          })();
          return "notice";
        }
        const costSummary = o.costRegistry?.summary();
        appendHistory({
          kind: "notice",
          text: formatCostReport(usageTotals, { startedAt, ...(costSummary !== undefined ? { cost: costSummary } : {}) }),
        });
        return "notice";
      }
      // M55 §A4: /rename <name> — append a fresh session_name entry (the store is append-only; the last entry wins on read, so /resume and /search pick the new name up with no rewrite).
      case "rename": {
        const v = validateSessionName(cmd.name);
        if (!v.ok) {
          appendHistory({ kind: "notice", text: v.error });
          return "notice";
        }
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（rename 不可用——无工作区）" }); // ω99-166d-ii: #22（括号 notice 族中文化）
          return "notice";
        }
        void renameSession({ workspaceRoot: o.workspaceRoot, sessionId, name: v.name })
          .then((r) => {
            appendHistory({ kind: "notice", text: r.notice });
            setSessionNameCached(r.name); // the rename landed — the face follows
            o.onSessionRenamed?.(r.name);
            // M64-A §A: the peer registry follows the rename (list_agents /
            // send_message addressing picks the new name up immediately).
            void o.peer?.rename(r.name).catch(() => {});
          })
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ rename 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #15 failed 回执中文化（rename token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // M55 §A5: /diff — git uncommitted (porcelain + stat) plus this
      // session's per-turn file journal (the /rewind data face).
      case "diff": {
        void runDiffCommand({
          workspaceRoot: o.workspaceRoot ?? "",
          ...(o.fileHistory !== undefined ? { fileHistory: o.fileHistory } : {}),
        })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ diff 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #16 failed 回执中文化（diff token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // M55 §A6 + M62 §3: /config — the effective-settings view; `set local
      // <k> <v>` writes the local tier (auto-gitignored on first write).
      case "config": {
        void runConfigCommand({ workspaceRoot: o.workspaceRoot ?? "", args: cmd.args })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ config 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #17 failed 回执中文化（config token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // M55 §B10: /review and /security-review — template prompt commands
      // over the CURRENT UNCOMMITTED diff. The request lands as a user
      // message and the normal loop runs (the model reads what it needs);
      // the security variant pins the audit checklist. No diff (or not a
      // repo) → a notice, never an empty review run.
      case "review":
      case "securityReview": {
        if (busy) {
          appendHistory({ kind: "notice", text: `⚠️ 运行中无法 ${cmd.kind === "securityReview" ? "/security-review" : "/review"}` }); // ω99-166c-iv: #17
          return "notice";
        }
        const security = cmd.kind === "securityReview";
        const focus = cmd.focus;
        void (async () => {
          try {
            // P1-7: the review reads the tree the agent works in — the LIVE
            // operation root (a /worktree enter must review the worktree's
            // diff, not the original repo's).
            const diff = await collectUncommittedDiff(createGitFn(agentWorkspaceRoot));
            if (!diff.repo) {
              appendHistory({ kind: "notice", text: `（${security ? "安全审查" : "审查"}不可用——不是 git 仓库）` }); // ω99-166c-iv: #18
              return;
            }
            if (!hasReviewableContent(diff)) {
              appendHistory({ kind: "notice", text: formatNoDiffNotice(agentWorkspaceRoot) });
              return;
            }
            if (busy) {
              appendHistory({ kind: "notice", text: "⚠️ 收集 diff 期间一轮运行开始了——请重试审查" }); // ω99-166c-iv: #19
              return;
            }
            submitCore(buildReviewPrompt({ diff, security, focus }), false);
          } catch (err) {
            appendHistory({ kind: "notice", text: `⚠️ review 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #18 failed 回执中文化（review token 保留 ASCII；err 三元原样）。
          }
        })();
        return "notice";
      }
      // M55 §B11: /mcp — server status from the loaded runtime (config +
      // the session's mcp__ tool lane + the bridge's latency/counter
      // snapshot). Read-only; allowed while busy.
      // P2-16b: "/mcp auth|unauth <server>" routes to the OAuth runner
      // (fire-and-forget — the flow waits up to 5 minutes on a human in a
      // browser; the authorization URL lands as a notice the moment it is
      // built, via the log sink).
      case "mcp": {
        if (cmd.args !== "") {
          void runMcpAuthCommand({
            args: cmd.args,
            workspaceRoot: o.workspaceRoot ?? process.cwd(),
            deps: { log: (line) => { appendHistory({ kind: "notice", text: line }); } },
          })
            .then((text) => { appendHistory({ kind: "notice", text }); })
            .catch((err) => {
              appendHistory({ kind: "notice", text: `⚠️ /mcp 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #19 failed 回执中文化（/mcp 斜杠 token 原样；err 三元原样）。
            });
          return "notice";
        }
        appendHistory({ kind: "notice", text: runMcpStatusCommand({ workspaceRoot: o.workspaceRoot ?? "", toolNames: o.tools.map((t) => t.name) }) });
        return "notice";
      }
      // M55 §B12: /agents — the roster listing (builtin / plugin /
      // workspace, pin + write-scope summaries, shadowing receipts).
      case "agents": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（agents 不可用——无工作区）" }); // ω99-166d-ii: #23（括号 notice 族中文化）
          return "notice";
        }
        void runAgentsCommand({ workspaceRoot: o.workspaceRoot, pluginAgents: o.pluginAgents })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ agents 列表失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #20 failed 回执中文化（listing→列表；agents token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // cc-plugins B1: /plugin — the plugin/marketplace command face over the
      // A1/A2 engine (the same one `wudao plugin` drives; notices 中文).
      // Config-only ops run even while busy; the two directory-deleting ops
      // (uninstall, marketplace remove — cascade) refuse with the /clear
      // family notice inside the runner, BEFORE any engine call. A successful
      // mutating op hot-rescans (A3): skills/commands/agents/hooks swap in at
      // the turn boundary; plugin MCP servers stay boot-static (restart
      // applies them — the install notice says so).
      case "plugin": {
        void runPluginSlashCommand({ args: cmd.args, cwd: o.workspaceRoot ?? process.cwd(), busy })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ /plugin 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #21 failed 回执中文化（/plugin 斜杠 token 原样；err 三元原样）。
          });
        return "notice";
      }
      // P1-5 (96 队列): /trust — the workspace trust gate's face. Config-only
      // (reads/writes ~/.wudao/trust.json + the hot rescan), busy-safe like
      // /plugin's config ops; the runner never touches a run's files.
      case "trust": {
        void runTrustCommand({ args: cmd.args, cwd: o.workspaceRoot ?? process.cwd() })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ /trust 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #22 failed 回执中文化（/trust 斜杠 token 原样；err 三元原样）。
          });
        return "notice";
      }
      // P2-13 (96 队列 #13): /constitution — the user constitution's face
      // (status / show / approve / reject over ~/.wudao/constitution*).
      // Config-only, busy-safe like /trust: the writes never touch a run's
      // files; approvals load into the session-static prompt section on the
      // NEXT session start (the receipt says so).
      case "constitution": {
        void runConstitutionCommand({ args: cmd.args })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ /constitution 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #23 failed 回执中文化（/constitution 斜杠 token 原样；err 三元原样）。
          });
        return "notice";
      }
      // P1-7 (96 队列): /worktree — bare = status; enter [name] / exit
      // keep|remove run through the helpers above (turn-boundary switch,
      // session root pinned). Busy behavior: enter and exit-keep QUEUE to
      // the settle (the /provider discipline); exit-remove REFUSES.
      case "worktree": {
        const verb = cmd.args.trim();
        if (verb === "") {
          appendHistory({ kind: "notice", text: worktreeStatusText() });
          return "notice";
        }
        const ws = verb.search(/\s/);
        const head = ws === -1 ? verb : verb.slice(0, ws);
        const rest = ws === -1 ? "" : verb.slice(ws + 1).trim();
        if (head === "enter") {
          // The name may be multi-word/unsafe — core's slugify owns the
          // vocabulary; empty rest means the driver's auto name.
          runWorktreeEnter(rest);
          return "notice";
        }
        if (head === "exit" && (rest === "keep" || rest === "remove")) {
          runWorktreeExit(rest);
          return "notice";
        }
        appendHistory({ kind: "notice", text: WORKTREE_USAGE });
        return "notice";
      }
      // M55 §C1: /add-dir <path> — add a workspace directory.
      case "addDir": {
        const input = cmd.path.trim();
        if (input === "") {
          appendHistory({ kind: "notice", text: "用法：/add-dir <path>" });
          return "notice";
        }
        const validation = validateAddDirPath({
          input,
          cwd: o.workspaceRoot ?? process.cwd(),
          existingPaths: addedDirs,
        });
        if (!validation.ok) {
          appendHistory({ kind: "notice", text: validation.error });
          return "notice";
        }
        addedDirs.push(validation.absPath);
        // Record the session entry if we have a store
        if (sessionStore !== undefined) {
          const entry = buildAddedDirEntry(validation.absPath);
          void sessionStore.appendEntry(sessionId, entry).catch(() => {
            // ignore errors
          });
        }
        appendHistory({ kind: "notice", text: formatAddDirNotice({ absPath: validation.absPath, count: addedDirs.length }) });
        return "notice";
      }
      // M55 §C2: /doctor — health check.
      case "doctor": {
        // Extract API key from the model client if available
        const providerKey = (o.model as unknown as { apiKey?: string })?.apiKey;
        const doctorInput: DoctorInput = {
          cwd: o.workspaceRoot ?? process.cwd(),
          nodeVersion: process.version.slice(1),
          requiredNode: ">=22",
          providerKey,
          settingsPath: o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao", "settings.json") : undefined,
          mcpConfigPath: o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao", "mcp.json") : undefined,
          sessionDir: o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao", "sessions") : undefined,
          wudaoDir: o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao") : undefined,
          evalDir: o.workspaceRoot !== undefined ? join(o.workspaceRoot, ".wudao", "evals") : undefined,
          // M59 §3: web checks (search guidance; fetch always-on).
          ...(o.webDoctor !== undefined ? { web: o.webDoctor } : {}),
          // M61 §4: the durable daemon's status line.
          ...(o.schedule !== undefined ? { schedules: o.schedule.doctorLine() } : {}),
        };
        appendHistory({ kind: "notice", text: formatDoctorReport(doctorInput) });
        return "notice";
      }
      // M55 §C3: /tasks — background agent listing.
      case "tasks": {
        const snapshot = o.agentsRegistry?.status();
        if (snapshot) {
          const rows = buildTaskRows(snapshot);
          appendHistory({ kind: "notice", text: formatTasksReport(rows) });
        } else {
          appendHistory({ kind: "notice", text: "tasks: 后台 agent 注册表不可用" });
        }
        return "notice";
      }
      // M55 §B7: /model [name] — bare lists the switchable matrix (profile
      // defaults + WUDAO_MODEL); with an argument the switch writes the M28
      // model_change entry and reaches the provider through onModelSwitch
      // (idle → now; mid-run → parked for run settle; either way the NEXT
      // request carries the new model).
      case "model": {
        const list = o.availableModels ?? availableModels();
        if (cmd.name === "") {
          appendHistory({ kind: "notice", text: formatModelList(list, modelLive) });
          return "notice";
        }
        // M57 §2: the argument may be a NAME or a NUMBER (the 1-based
        // ordinal the listing prints). Same-endpoint switches only: baseURL
        // + API key are provider-bound, a cross-provider pick explains the
        // restart (resolveModelArgument carries the message).
        // 0.3.31 kimi-400: the guard's "current" falls back to the
        // statusline pair exactly like the /provider case below — an
        // unseeded modelLive alone left provider undefined, which fails
        // sameProviderModels OPEN (the full matrix) and a cross-provider
        // pick then relabeled config.provider without moving the endpoint.
        // Deliberately NO fail-closed refusal beyond this: a config with NO
        // provider (an anonymous custom endpoint) resolves against the full
        // matrix BY DESIGN — the §7 window catalog needs the relabel, and a
        // proxy endpoint serves whatever the user names.
        const currentProvider = modelLive.provider ?? o.statusline?.provider;
        const v = resolveModelArgument(list, cmd.name, { ...modelLive, ...(currentProvider !== undefined ? { provider: currentProvider } : {}) });
        if (!v.ok) {
          appendHistory({ kind: "notice", text: v.error });
          return "notice";
        }
        const selection: ModelSelection = { model: v.choice.model, provider: v.choice.provider };
        return applyModelSwitch(selection, `模型 → ${v.choice.provider}/${v.choice.model}`); // ω99-195: #3（中文尾 applyModelSwitch 组装零触）
      }
      // M63 §A: /provider [name] — bare lists the profile matrix with status
      // dots (configured / missing-key / needs-endpoint + the current one);
      // with an argument the switch validates UP FRONT (unknown profile,
      // missing key — refused immediately, naming the fix), then applies at
      // the turn boundary: idle → now; busy → parked for run settle;
      // mid-stream (a model call in flight) → refused for a REAL switch —
      // the 0.3.33 same-name key refresh is the carve-out (it parks too).
      case "provider": {
        const currentProvider = modelLive.provider ?? o.statusline?.provider;
        if (cmd.name === "") {
          const resolve = o.onProviderSwitch?.resolve ?? envOnlyProviderResolver(process.env);
          const text = formatProviderList(providerRows(process.env, resolve), currentProvider);
          appendHistory({
            kind: "notice",
            text: o.onProviderSwitch === undefined
              ? `${text}\n  (switching unavailable in this frontend — no provider construction seam)`
              : text,
          });
          return "notice";
        }
        const v = validateProviderName(cmd.name);
        if (!v.ok) {
          appendHistory({ kind: "notice", text: v.error });
          return "notice";
        }
        const seam = o.onProviderSwitch;
        // M63 §C carve-out: on the wizard boot's placeholder the session is
        // NOT really "on" its nominal provider (no key has ever
        // authenticated) — a same-name switch must resolve-then-rebuild like
        // any other, or the just-saved key never reaches the live config and
        // the first prompt calls the endpoint with the placeholder key (raw
        // 401). Only a genuinely keyed same-provider switch is the no-op.
        // 0.3.32c kimi-401: the second same-name leg — the credentials file
        // now holds a key the live pool lacks (the settings page just saved
        // it; the pool may be the T0 cross-provider fallback's mislabeled
        // borrow of the OLD provider's key). Re-resolve picks the saved key
        // up; without the leg the 401 persists until a restart.
        const sameNameRefresh =
          v.name === currentProvider && (seam?.keyRefreshPending?.() === true || seam?.configRefreshPending?.() === true);
        // 0.3.33 kimi-401 (second layer): the mid-stream refusal below is
        // spec §A for a REAL switch — never move the endpoint under a
        // streaming call. But the same-name KEY refresh is
        // settings-originated and endpoint-preserving, and its only trigger
        // (the settings page's one-shot submit) fires exactly when the user
        // saves — which is overwhelmingly mid-retry, i.e. mid-stream. The
        // one-shot died at this guard and the saved key never landed (every
        // later prompt kept the borrowed pool → 401 forever). The refresh
        // falls through to applyProviderSwitch, which PARKS it when busy and
        // lands the rebuild at run settle.
        if (modelInFlight && !sameNameRefresh) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /provider（任务进行中）" });
          return "notice";
        }
        if (v.name === currentProvider && seam?.isPlaceholderLive?.() !== true && !sameNameRefresh) {
          appendHistory({ kind: "notice", text: `（已在 ${v.name} 上——/model 在其内切换模型；/provider <name> 换端点）` }); // ω99-166f-ii: #15
          return "notice";
        }
        if (seam === undefined) {
          appendHistory({ kind: "notice", text: `（此前端不支持切换供应商——没有供应商构建接口；用 --provider ${v.name} 重启即可）` }); // ω99-166f-ii: #16
          return "notice";
        }
        const r = seam.resolve(v.name);
        if (!r.ok) {
          appendHistory({ kind: "notice", text: `⚠️ 拒绝切换到 provider ${v.name}：${r.error}` }); // ω99-166c-iii: #10
          return "notice";
        }
        // 0.3.32c: a same-name KEY refresh keeps the session's model — the
        // resolve lands the profile default, which would silently reset a
        // /model pick (kimi-for-coding → k3-256k) when only the key moved.
        // Kept only when the pick is still in the target's matrix.
        const config =
          sameNameRefresh &&
          modelLive.model !== undefined &&
          modelLive.model !== r.config.model &&
          (o.availableModels ?? availableModels()).some((c) => c.provider === v.name && c.model === modelLive.model)
            ? { ...r.config, model: modelLive.model }
            : r.config;
        return applyProviderSwitch(
          config,
          v.name,
          `供应商 → ${v.name} (${config.model})`, // ω99-199: #3；ω99-311: 称谓产品级统一（随 web 310）
          // 0.3.32c: a cross-provider switch that borrowed the session's key
          // pool (no target file key) names the 401 risk and the fix.
          r.borrowedKeyPool === true ? borrowedKeyPoolNote(v.name) : undefined,
        );
      }
      // M55 §B7: /effort [level] — the reasoning-effort switch (matrix levels
      // low|medium|high|max|none); thinking_level_change entry + the same
      // next-turn semantics as /model.
      case "effort": {
        if (cmd.level === "") {
          appendHistory({ kind: "notice", text: formatEffortList(modelLive.effort) });
          return "notice";
        }
        const v = resolveEffortArgument(cmd.level);
        if (!v.ok) {
          appendHistory({ kind: "notice", text: v.error });
          return "notice";
        }
        return applyModelSwitch({ effort: v.level }, `effort → ${v.level}`);
      }
      // 推理档三级配置 S4: /language [reply|reasoning <mode>] — the session
      // language lane (双旋钮; bare = status). modelLive's twin: the mutation
      // lands on languageLive NOW, the NEXT submit's transient blocks fold it
      // (session > env by construction; the ablation env stays live-checked).
      case "language": {
        if (cmd.args === "") {
          appendHistory({ kind: "notice", text: formatLanguageStatus(languageFold()) });
          return "notice";
        }
        const v = resolveLanguageArgument(cmd.args);
        if (!v.ok) {
          appendHistory({ kind: "notice", text: `⚠️ ${v.error}` });
          return "notice";
        }
        languageLive = { ...languageLive, ...v.pref };
        const knob = v.pref.reply !== undefined ? `reply → ${v.pref.reply}` : `reasoning → ${v.pref.reasoning}`;
        appendHistory({ kind: "notice", text: `language ${knob} — 会话级覆盖，下一轮生效（裸 /language 看当前双旋钮）` });
        return "notice";
      }
      // M55 §B8: /permissions — view / add / remove the settings.json
      // permission rules. The write rides the existing hot-reload (the
      // watcher re-reads on mtime); rules touching the settings-file immunity
      // layer are refused inside the command (hard rule).
      case "permissions": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（permissions 不可用——无工作区）" }); // ω99-166d-ii: #24（括号 notice 族中文化）
          return "notice";
        }
        void runPermissionsCommand({ workspaceRoot: o.workspaceRoot, args: cmd.args })
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ permissions 命令失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #24 failed 回执中文化（command→命令；permissions token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // M55 §B9: /export [file] — the session as markdown (default
      // .wudao/exports/<session>.md). An existing target is never overwritten
      // silently: the render parks and `ok` confirms.
      case "export": {
        if (o.workspaceRoot === undefined) {
          appendHistory({ kind: "notice", text: "（export 不可用——无工作区）" }); // ω99-166d-ii: #25（括号 notice 族中文化）
          return "notice";
        }
        const meta = modelLive;
        void prepareExport({
          workspaceRoot: o.workspaceRoot,
          sessionId,
          fileArg: cmd.file,
          entries: exportEntriesFromHistory(history),
          ...(meta.model !== undefined ? { model: meta.model } : {}),
        })
          .then((r) => {
            if (r.kind === "ok") {
              pendingExport = null;
              appendHistory({ kind: "notice", text: `已导出会话 ${sessionId.slice(0, 8)} → ${r.path}（${r.content.length} 字节）` }); // ω99-166f-iii: #13（→ ${r.path} 路径段保留箭头）
              return;
            }
            pendingExport = { path: r.path, content: r.content };
            appendHistory({ kind: "notice", text: r.hint });
          })
          .catch((err) => {
            appendHistory({ kind: "notice", text: `⚠️ export 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #25 failed 回执中文化（export token 保留 ASCII；err 三元原样）。
          });
        return "notice";
      }
      // M55 §A1: /init — a read-only scan run whose answer carries the
      // AGENTS.md draft; the completion seam parks it as a preview awaiting
      // `ok` (routed in "prompt" below). No file is touched in this run.
      case "init": {
        if (busy) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /init（任务进行中）" });
          return "notice";
        }
        initDraft = null;
        emit();
        initRun = true;
        // P1-7: /init's probe reads the LIVE operation root — a worktree
        // enter means the draft targets the worktree's tree.
        return submitCore(
          buildInitPrompt({ workspaceRoot: agentWorkspaceRoot, hasExisting: hasExistingAgentsMd(agentWorkspaceRoot) }),
          false,
        );
      }
      // M37 §1: /plan <goal> — a read-only plan run; the produced board waits
      // for review at the input (ok / 改 <意见>, routed below).
      case "plan": {
        if (busy) {
          appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /plan（任务进行中）" });
          return "notice";
        }
        if (cmd.goal === "") {
          appendHistory({ kind: "notice", text: "用法：/plan <goal>——先只读规划，回 ok 才执行 · 改 <意见> 可修订" });
          return "notice";
        }
        planBoard = null;
        emit();
        planRun = true;
        return submitCore(buildPlanPrompt(cmd.goal), true);
      }
      // M27 /skill:name: resolve against the loaded skills and submit the full
      // SKILL.md as a <skill> user message through the normal prompt path.
      // Unknown → listing notice.
      case "skill": {
        const skill = findSkill(o.skills ?? [], cmd.name);
        if (!skill) {
          appendHistory({ kind: "notice", text: formatSkillError(cmd.name, o.skills ?? []) });
          return "notice";
        }
        // M63-C §3: the skill's frontmatter hooks arm HERE — the invocation
        // is the position's trigger (both the fork and inline paths).
        armSkillHooks(skill);
        // ω99-56: a `approval-gate: file-edits` skill arms the per-path edit
        // approval posture at the same invocation trigger.
        armApprovalGate(skill);
        // M53 §4: `context: fork` executes in an isolated fork instead.
        if (skill.context === "fork") return runSkillFork(skill, cmd.args);
        // cc-plugins D2: invocation-time preprocessing. A body with NO
        // injection syntax stays fully synchronous (the pure substitution
        // pass) — the ordering contract of every pre-D2 skill submit is
        // unchanged. A body that wants dynamic injection goes async: each
        // `!`cmd` / ```! span executes under the trust tiers through
        // decideSkillInjection (the same gate a shell tool call hits);
        // a denial or a failed exec surfaces as a notice and NOTHING is
        // submitted (a half-expanded envelope must never reach the model).
        const expandOpts = {
          sessionId,
          ...(o.workspaceRoot !== undefined ? { workspaceRoot: o.workspaceRoot } : {}),
          prunedFromContext: isSkillPruned(state.messages, skill.name),
        };
        if (!skillBodyNeedsInjection(skill)) {
          return submitCore(buildSubstitutedSkillMessage(skill, cmd.args, expandOpts), false);
        }
        void (async () => {
          try {
            const text = await buildExpandedSkillMessage(skill, cmd.args, {
              ...expandOpts,
              decide: decideSkillInjection,
            });
            submitCore(text, false);
          } catch (err) {
            appendHistory({ kind: "notice", text: `⚠️ 技能 ${skill.name}：${err instanceof Error ? err.message : String(err)}` }); // ω99-166f-iii: #14
          }
        })();
        return "notice";
      }
      // M61 §3: /goal <condition> — set (replaces) + start; bare = status;
      // clear|stop|off|reset|none|cancel clears.
      case "goal": {
        if (goalController === undefined) {
          appendHistory({ kind: "notice", text: "(此会话无 goal 界面——/goal 在当前运行时不可用)" });
          return "notice";
        }
        void (async () => {
          const parsed = parseGoalCommand(cmd.args);
          try {
            if (parsed.kind === "status") {
              appendHistory({ kind: "notice", text: goalController.status() });
            } else if (parsed.kind === "clear") {
              appendHistory({ kind: "notice", text: goalController.clear() });
            } else if (parsed.kind === "usage") {
              // ω99-13: malformed --gate/--budget never starts a run.
              appendHistory({ kind: "notice", text: parsed.message });
            } else {
              const notice = await goalController.set(parsed.condition, { gate: parsed.gate, budgetTokens: parsed.budgetTokens });
              appendHistory({ kind: "notice", text: notice });
              // 设置即开局: the condition itself is the first turn's
              // instruction (submitted through the normal routing).
              if (!notice.startsWith("⚠️")) submitCore(parsed.condition, false);
            }
          } catch (err) {
            appendHistory({ kind: "notice", text: `⚠️ /goal 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #26 failed 回执中文化（/goal 斜杠 token 原样；err 三元原样）。
          }
        })();
        return "notice";
      }
      // ω99-19: /mission — the driver/desktop slash face, mirroring the
      // REPL's exact semantics (bare = status, clear aliases = abandon,
      // else = start) over the SAME late-bound box the mission_* tool set
      // reads: one ledger, two faces. No auto-run on start (the campaign's
      // first move is mission_plan's decomposition, not a turn).
      case "mission": {
        const mission = o.missionBox?.current;
        if (mission === undefined) {
          // ω99-165: D 族空面通知去术语化（B2 授权同弧收口，与 :5587/:5675 对仗）。
          appendHistory({ kind: "notice", text: "(此会话无任务战役界面——/mission 在当前运行时不可用)" });
          return "notice";
        }
        void (async () => {
          const parsed = parseMissionCommand(cmd.args);
          try {
            if (parsed.kind === "status") {
              appendHistory({ kind: "notice", text: mission.status() });
            } else if (parsed.kind === "clear") {
              appendHistory({ kind: "notice", text: await mission.abandon() });
            } else {
              appendHistory({ kind: "notice", text: await mission.start(parsed.objective) });
            }
          } catch (err) {
            appendHistory({ kind: "notice", text: `⚠️ /mission 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #27 failed 回执中文化（/mission 斜杠 token 原样；err 三元原样；m81:192 钉随改）。
          }
        })();
        return "notice";
      }
      // M61 §4: /schedule — the durable task group (list/add/rm +
      // ω99-5a pause/unpause/run, the goose daemon verbs).
      case "schedule": {
        const daemon = o.schedule;
        if (daemon === undefined) {
          appendHistory({ kind: "notice", text: "（durable 调度由 `wudao ui` 宿主承载——启动它管理 durable 任务；会话级调度是 cron_create/cron_list/cron_delete）" }); // ω99-166d-ii: #26（durable 宿主指引中文化）
          return "notice";
        }
        const parsed = parseScheduleCommand(cmd.args);
        void (async () => {
          try {
            if (parsed.kind === "list") {
              appendHistory({ kind: "notice", text: daemon.listText() });
            } else if (parsed.kind === "rm") {
              appendHistory({ kind: "notice", text: await daemon.rm(parsed.id) });
            } else if (parsed.kind === "add") {
              appendHistory({ kind: "notice", text: await daemon.add({ schedule: parsed.schedule, prompt: parsed.prompt, createdFrom: `/schedule (${sessionId.slice(0, 8)})`, ...(parsed.runtime !== undefined ? { runtime: parsed.runtime } : {}) }) });
            } else if (parsed.kind === "pause" || parsed.kind === "unpause" || parsed.kind === "run") {
              const text = parsed.kind === "pause" ? await daemon.pause(parsed.id)
                : parsed.kind === "unpause" ? await daemon.unpause(parsed.id)
                : await daemon.runNow(parsed.id);
              appendHistory({ kind: "notice", text });
            } else if (parsed.kind === "snooze") {
              // ω99-313: 提醒稍后再响（分钟缺省 = 该提醒自带的 snoozeMinutes）。
              appendHistory({ kind: "notice", text: await daemon.snooze(parsed.id, parsed.minutes) });
            } else if (parsed.kind === "webhook") {
              // 借鉴弧 ε: webhook 任务的触发地址回执（curl 一行，token 常驻任务上）。
              appendHistory({ kind: "notice", text: await daemon.webhookLine(parsed.id) });
            } else {
              appendHistory({ kind: "notice", text: parsed.error }); // ω99-166d-i: 缝B — parsed.error 自带 用法： 头，拆包裹防双头
            }
          } catch (err) {
            appendHistory({ kind: "notice", text: `⚠️ /schedule 失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #28 failed 回执中文化（/schedule 斜杠 token 原样；err 三元原样）。
          }
        })();
        return "notice";
      }
      // M61 §2: /loop [interval] [prompt] — fixed interval, dynamic
      // self-pacing (schedule_wakeup), stop, or status.
      case "loop": {
        if (loopController === undefined) {
          appendHistory({ kind: "notice", text: "(无调度器可用——检查 WUDAO_DISABLE_CRON 与 .wudao/cron.json)" });
          return "notice";
        }
        void loopController.command(cmd.args)
          .then((text) => appendHistory({ kind: "notice", text }))
          .catch((err) => appendHistory({ kind: "notice", text: `⚠️ /loop 失败：${err instanceof Error ? err.message : String(err)}` })); // ω99-166c-i: #29 failed 回执中文化（catch 内联；/loop 斜杠 token 原样；err 三元原样）。
        return "notice";
      }
      case "prompt": {
        // M37 §1: review-time input while a plan board is pending. `ok` (or a
        // short confirmation) executes the board with NORMAL tools; `改 <意见>`
        // runs another read-only plan round; anything else falls through to a
        // normal prompt and the board stays under review.
        if (planBoard !== null) {
          const review = parsePlanReviewInput(cmd.text);
          if (review?.kind === "approve") {
            const board = planBoard;
            planBoard = null;
            emit();
            // 审批痕: the raw confirmation word lands verbatim as a genuine
            // user message BEFORE the wrapper (submitCore's own push links at
            // it as the chain predecessor). M24: pushed at the approval
            // moment — a turn boundary, before the execution run starts,
            // never mid-run.
            appendPlanApprovalTrace(state.messages, cmd.text);
            return submitCore(buildPlanExecutionPrompt(board), false);
          }
          if (review?.kind === "revise") {
            planRun = true;
            return submitCore(buildPlanRevisionPrompt(review.feedback), true);
          }
        }
        // M55 §A1: a parked /init draft consumes an approval exactly like a
        // plan board (`ok` — the same PLAN_APPROVAL_WORDS); any other input
        // stays a normal prompt and the draft keeps waiting. THE WRITE: an
        // existing AGENTS.md gets a dated append, never an overwrite.
        if (initDraft !== null) {
          const review = parsePlanReviewInput(cmd.text);
          if (review?.kind === "approve") {
            const d = initDraft;
            initDraft = null;
            void applyInitDraft({ workspaceRoot: agentWorkspaceRoot, draft: d.content })
              .then((r) => appendHistory({ kind: "notice", text: r.notice }))
              .catch((err) => {
                appendHistory({ kind: "notice", text: `⚠️ /init 写入失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #30 failed 回执中文化（write→写入；/init 斜杠 token 原样；err 三元原样）。
              });
            return "notice";
          }
        }
        // M55 §B9: a parked /export overwrite confirmation — same `ok`
        // convention; any other input cancels (the render is dropped).
        if (pendingExport !== null) {
          const review = parsePlanReviewInput(cmd.text);
          if (review?.kind === "approve") {
            const pending = pendingExport;
            pendingExport = null;
            void writeExportFile(pending.path, pending.content)
              .then(() => appendHistory({ kind: "notice", text: `exported → ${pending.path} (确认后已覆写)` })) // ω99-166c-iii: #11
              .catch((err) => {
                appendHistory({ kind: "notice", text: `⚠️ /export 写入失败：${err instanceof Error ? err.message : String(err)}` }); // ω99-166c-i: #31 failed 回执中文化（write→写入；/export 斜杠 token 原样；err 三元原样）。
              });
            return "notice";
          }
          pendingExport = null;
          appendHistory({ kind: "notice", text: "（导出已取消——目标文件未改动）" }); // ω99-166f-iii: #15
          // fall through: the cancelling input is also a normal prompt
        }
        // M34 §2: expand @<path> mentions in the raw prompt BEFORE it enters
        // the conversation (read_file constraints + the <file> envelope).
        // Notices surface as dim lines; expansion must never block a prompt —
        // a failure falls back to the raw text. No workspaceRoot → verbatim.
        if (o.workspaceRoot === undefined) return submitCore(cmd.text, false, images, files);
        void (async () => {
          let expanded = cmd.text;
          try {
            const mention = await expandMentions(cmd.text, o.workspaceRoot as string);
            for (const n of mention.notices) appendHistory({ kind: "notice", text: n });
            expanded = mention.text;
          } catch {
            // fall back to the raw text
          }
          submitCore(expanded, false, images, files);
        })();
        return busy ? "steered" : "started";
      }
    }
  };

  /** M61 review fix: the registry label for an evaluator usage row — its own
   *  model name when the row carries one (the matrix-cheap client), else the
   *  session's model (the effort=low fallback). */
  const evaluatorLabelFor = (_u: import("@wudao/core").ModelUsage): string =>
    goalEvaluatorLabelRef.current ?? o.statusline?.model ?? "evaluator";
  const goalEvaluatorLabelRef: { current?: string } = {};

  // M61 §3: the goal controller — the evaluator runs at the stop-hook
  // position (cheapest matrix model, fallback = the session model at effort
  // low); its tokens fold into usageTotals' own evaluator column; entries
  // persist through the session store when the frontend supplied one.
  const goalController = o.goal === true && o.workspaceRoot !== undefined
    ? (() => {
        const evaluator = o.evaluatorOverride ?? buildEvaluatorModel(o.model, {
          provider: o.statusline?.provider,
          model: o.statusline?.model ?? "session",
        }, process.env);
        goalEvaluatorLabelRef.current = evaluator.label.split(" @ ")[0]!.split("/").pop();
        return createGoalController({
        workspaceRoot: o.workspaceRoot,
        sessionId: () => sessionId,
        getMessages: () => state.messages,
        evaluator,
        backgroundBusy: () => {
          const all = o.agentsRegistry?.status() ?? [];
          // 113-B2（prime-agent #2465 形）: the detach lane's live work holds
          // the goal round too — a /bg task still running means the very work
          // the goal would evaluate is in flight; a continuation now races the
          // completion notice (a burned round + the model may re-issue the
          // same long command). The hold is deterministic (zero model calls
          // in the verdict) and the recovery rides the lane's EXISTING settle
          // machinery: the landed result's startRun (detachSeam / steering
          // drain) starts the next run, whose stop seam re-evaluates the
          // goal — no new polling surface, user prompts are never gated.
          return all.some((b) => b.status === "queued" || b.status === "running")
            || detachLane.runningCount() > 0;
        },
        appendEntry: async (entry) => {
          if (sessionStore !== undefined) await sessionStore.appendEntry(sessionId, entry);
        },
        notify: (text) => appendHistory({ kind: "notice", text }),
        onEvaluatorUsage: (u) => {
          usageTotals = recordUsage(usageTotals, u);
          // M61 review fix: the cheap-matrix evaluator's $ is VISIBLE — its
          // rows reach the cost registry under the evaluator's own label
          // (priced when WUDAO_PRICE_<MODEL> covers it; otherwise the
          // unpriced≠free note counts it).
          o.costRegistry?.record({ model: evaluatorLabelFor(u), provider: "evaluator", usage: u });
          emit();
        },
        env: process.env,
        });
      })()
    : undefined;

  // M61 §2: the /loop controller, created after the routing seams exist so
  // its submit/notify closures land in the history. Bound to THIS driver's
  // cron runtime; the tool set's schedule_wakeup reads it through opts.loopBox.
  const loopController = o.cron !== undefined && o.workspaceRoot !== undefined
    ? createLoopController({
        cron: o.cron,
        workspaceRoot: o.workspaceRoot,
        skills: o.skills ?? [],
        env: process.env,
        submit: (prompt) => {
          void routedSubmit(prompt, { expand: false });
        },
        notify: (text) => appendHistory({ kind: "notice", text }),
      })
    : undefined;
  if (o.loopBox !== undefined && loopController !== undefined) o.loopBox.current = loopController;
  // ω99-13b: same late-bound fill for the /goal controller — the session
  //  engine's usage wrapper (opts.goalBox's creator) meters --budget through
  //  it. goalController above is already in scope (created before the loop
  //  controller).
  if (o.goalBox !== undefined && goalController !== undefined) o.goalBox.current = goalController;

  // ω99-249: the model-side GoalState runtime — the budgeted goal derived
  // from the mission ledger. Created inside the driver because it owns the
  // driver's seams (sessionStore + live sessionId + the late-bound
  // missionBox); every entry append is fire-and-forget (the 217 receipt law).
  // The run boundaries below drive it: onRunStart injects the short status
  // line through metaNotes (233's seam — tail-side projection, zero prefix
  // bytes), onRunSettle folds the run's split usage + wall time, onCompacted
  // counts the goal's lifetime compactions, webSnapshot feeds DriverStatus.
  const goalRuntime = o.missionBox !== undefined && (sessionStore !== undefined || o.workspaceRoot !== undefined)
    ? createGoalRuntime({
        appendEntry: (entry) =>
          (sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions"))).appendEntry(sessionId, entry),
        getMission: () => o.missionBox?.current?.snapshot(),
      })
    : undefined;
  if (goalRuntime !== undefined) goalRuntimeRef.current = goalRuntime;
  if (o.goalRuntimeBox !== undefined && goalRuntime !== undefined) o.goalRuntimeBox.current = goalRuntime;

  // M63-B: the FileChanged watchers — the driver owns them so delivery rides
  // its own steering queue. Started at creation, stopped at dispose. The
  // deliver closure reads the driver through a late-bound box (the object
  // literal below is not yet bound when the watchers are armed).
  const driverBox0: { current: AgentDriver | null } = { current: null };
  // M63-C R1: the fire-runtime view for the skill-position overlay compile.
  const skillFireRuntime = o.hookRuntime;
  // M63-C R1 (§2 prompt_id): minted per submit (see startRun).
  const promptIdBox = o.promptIdBox;
  const sessionIdBox = o.sessionIdBox;
  if (sessionIdBox !== undefined) sessionIdBox.current = sessionId;
  // #48: the lease box — explicit override or the root-memoized default.
  // Same instance the engine's boot acquire and index.ts's resolveSession
  // fail-fast landed on (the per-root memo is the whole point).
  const sessionLeases: SessionLeaseBox | undefined =
    o.sessionLeases ?? (opts.workspaceRoot !== undefined ? sessionLeaseBoxFor(join(opts.workspaceRoot, ".wudao", "sessions")) : undefined);
  // R6-I1: install the warn sink BEFORE any hook can fire.
  if (o.hookWarnSink !== undefined) o.hookWarnSink.current = (m) => appendHistory({ kind: "notice", text: m });
  // M63-C: bind the asyncRewake sink to the system steering lane.
  if (o.rewakeSink !== undefined) {
    o.rewakeSink.current = (message: string): void => {
      if (disposed || !active) return;
      systemSteerQueue.push(`[hook wake] ${message}`);
      emit();
    };
  }
  let fileWatchHandle: import("../file-change.js").FileChangeWatchHandle | null = null;
  // workspace-ux B2: the watcher set is compiled against the BOOT root at
  // creation and RE-armed against the live agent root by applyAgentRoot —
  // FileChanged matchers watch the tree the agent actually works in. The
  // boot-time guard keeps the no-root status quo (no o.workspaceRoot → no
  // watchers); a later switch to a real root arms them there.
  const armFileWatch = (root: string): void => {
    fileWatchHandle?.stop();
    fileWatchHandle = null;
    if (o.fileChangeWatch === undefined || o.fileChangeWatch.targets.length === 0) return;
    const noteFor = o.fileChangeWatch.noteFor ?? ((path: string) => `[file_changed] ${path}`);
    fileWatchHandle = createFileChangeWatcher(
      o.fileChangeWatch.targets,
      root,
      {
        fire: o.fileChangeWatch.fire,
        deliver: (path) => driverBox0.current?.steer(noteFor(path)),
      },
      (line) => appendHistory({ kind: "notice", text: line }),
    );
  };
  if (o.fileChangeWatch !== undefined && o.fileChangeWatch.targets.length > 0 && o.workspaceRoot !== undefined) {
    armFileWatch(o.workspaceRoot);
  }
  // workspace-ux B2: the switch's ONE landing point (idle via the op, busy via
  // the settle seam). Wholesale migration of the agent's footing, in order:
  // the switchable root variable, the shared box (the tool boundary +
  // hookWorkspaceRoot), the FileChanged watchers; then the human-visible
  // receipt (notice) and the model-visible one (<workspace_changed> MetaNote —
  // rides the next first model call; the system prompt and the persisted
  // conversation stay untouched, so the KV prefix survives the switch). The
  // recents record is best-effort, same discipline as panelRootSet. o.workspaceRoot
  // (the SESSION anchor) is deliberately NOT written.
  const agentRootBox = opts.agentRootBox;
  const applyAgentRoot = async (path: string, extRescan = false): Promise<void> => {
    agentWorkspaceRoot = path;
    if (agentRootBox !== undefined) agentRootBox.current = path;
    armFileWatch(agentWorkspaceRoot);
    // Best-effort (same discipline as panelRootSet): a failed recents write
    // must not fail the switch — but it is AWAITED so the op's receipt
    // implies the row landed (the switcher menu reads it right after).
    await recordRecentWorkspace(path).catch(() => undefined);
    appendHistory({ kind: "notice", text: `agent 工作目录已切换 → ${basename(path)} (${path})` });
    metaNotes.push({ text: `<workspace_changed path="${path}">`, source: "工作区变更" });
    // P1-7 (96 队列): a /worktree switch additionally re-roots the extension
    // face (hard constraint 5 — the same turn boundary as the root itself).
    // Same observer discipline as /trust's rescan: a failure degrades to a
    // notice, never fails the switch; the seam is injectable for tests.
    if (extRescan) {
      const rescan = o.worktreeRescan ?? rescanExtensionsAt;
      try {
        const counts = await rescan(path);
        appendHistory({ kind: "notice", text: `↻ 扩展面已在新根目录重扫——${counts.skills} 技能 · ${counts.plugins} 插件 · ${counts.hooks} 钩子` }); // ω99-166f-iii: #16
      } catch (err) {
        appendHistory({ kind: "notice", text: `⚠️ 在新根目录重扫扩展失败（${err instanceof Error ? err.message : String(err)}）——已加载的 skills/plugins/hooks 保持不变` }); // ω99-166c-iv: #20
      }
    }
    // ω99-253: the root moved — the branch face re-reads the NEW root here
    // (the ONE landing point of agent-root switches, idle and parked alike;
    // /worktree enter/exit rides the same seam, so its fresh checkout shows
    // its branch the moment the receipt lands).
    refreshGitBranch();
    emit();
  };
  // M63-B: the skills-position ConfigChange poll (advisory block — no reload
  // consumer). Same stat-key pattern as the permission watcher.
  let configSkillsTimer: ReturnType<typeof setInterval> | null = null;
  if (o.configChangeSkills !== undefined) {
    let skillsKey: string | null = null;
    let first = true;
    const poll = async (): Promise<void> => {
      let part: string;
      try {
        const st = await stat(o.configChangeSkills!.path);
        part = `${st.mtimeMs}:${st.size}`;
      } catch {
        part = "missing";
      }
      if (!first && skillsKey !== null && skillsKey !== part) {
        const allowed = await o.configChangeSkills!.decide("skills", o.configChangeSkills!.path);
        if (!allowed) {
          appendHistory({ kind: "notice", text: "⚙️ 技能目录变更被 configChange 钩子拦截——技能目录保持已加载状态" }); // ω99-166f-iii: #17
        } else {
          // M63-C: the consult structure now matches the settings positions
          // (block = veto). The APPLY side is deliberately restart-scoped: a
          // live skills reload would rewrite the system-prompt manifest and
          // break the prefix cache (the M62/M24 session-static doctrine) —
          // the receipt says so instead of silently half-applying.
          appendHistory({ kind: "notice", text: "⚙️ 技能已变更（configChange 钩子放行）——新增/移除的技能重启后生效（保前缀缓存稳定）" }); // ω99-166f-iii: #18
        }
        skillsKey = part; // consumed either way; a re-write re-fires
      } else if (first) {
        first = false;
        skillsKey = part;
      }
    };
    void poll();
    configSkillsTimer = setInterval(() => { void poll(); }, 1000);
    configSkillsTimer.unref?.();
  }

  // M63-A: the creation fire — the session's FIRST boundary. The source is
  // explicit when the frontend knows it (--fork-session), else derived from
  // the seed: history present = a boot resume, empty = a fresh startup.
  sessionStartHook(o.sessionStartSource ?? (opts.initialMessages !== undefined && opts.initialMessages.length > 0 ? "resume" : "startup"));
  // M63-B: the session's startup context load — the instructions face.
  instructionsLoadedHook("session_start");
  // ω99-253: the branch face's BOOT read — once per driver, fire-and-forget;
  // the landing re-emits when the value arrives (null stays null quietly:
  // a non-repo workspace never surfaces a face). Together with the settle
  // and root-switch refreshes this is the read's WHOLE life — emit paths
  // only ever read the cached variable.
  refreshGitBranch();
  // The memory signature's BOOT read (same discipline): the store read once
  // at creation (JSONL 小文件，读廉价) — absent until it lands, then the
  // cached value rides every frame.
  void memorySig.refresh();
  const driverObj: AgentDriver = {
    subscribe(cb: () => void): () => void {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    onHistory(cb: (entries: readonly HistoryEntry[], reset: boolean) => void): () => void {
      historyListeners.add(cb);
      return () => historyListeners.delete(cb);
    },
    onLoopEvent(cb: (event: LoopEvent) => void): () => void {
      eventListeners.add(cb);
      return () => eventListeners.delete(cb);
    },
    getStatus(): DriverStatus {
      if (statusSnapshot === null) statusSnapshot = buildStatus();
      // S4: the language fold is LIVE — the env leg (WUDAO_REASONING_LANGUAGE
      // etc.) can flip without a driver event, and the next submit re-folds
      // fresh; a memoized pair would disagree with the very request it
      // describes. Referential stability keeps holding while the pair is
      // unchanged (a new object ONLY on an actual fold change).
      const language = languageFold();
      if (statusSnapshot.language.reply !== language.reply || statusSnapshot.language.reasoning !== language.reasoning) {
        statusSnapshot = { ...statusSnapshot, language };
      }
      return statusSnapshot;
    },
    refreshStatus(): void {
      // setLanguage's mutate+emit minus the mutate: the snapshot re-derives
      // (buildStatus re-reads availableModels through the invalidated memo)
      // and every subscriber — the server's state push among them — refires.
      emit();
    },
    setLanguage(pref: Partial<LanguagePreference>): void {
      languageLive = { ...languageLive, ...pref };
      emit();
    },
    getLanguage(): LanguagePreference {
      return languageFold();
    },
    getEffort(): string | undefined {
      return modelLive.effort !== undefined && modelLive.effort !== "" ? modelLive.effort : undefined;
    },
    keyRefreshPending(): boolean {
      // 0.3.32c kimi-401: either same-name carve-out leg — the wizard
      // placeholder (M63 §C) or a credentials-file key the live pool lacks.
      return o.onProviderSwitch?.isPlaceholderLive?.() === true || o.onProviderSwitch?.keyRefreshPending?.() === true;
    },
    providerRefreshPending(): boolean {
      // 2026-08-31 config-drift: every same-name refresh leg — the key legs
      // (placeholder + file-key drift) plus the endpoint/wire drift a
      // settings row save introduces. Inlined rather than calling
      // keyRefreshPending() through `this`: the driver object is passed
      // around and its methods must not depend on the receiver.
      const seam = o.onProviderSwitch;
      return seam?.isPlaceholderLive?.() === true || seam?.keyRefreshPending?.() === true || seam?.configRefreshPending?.() === true;
    },
    getHistory(): readonly HistoryEntry[] {
      return historyOut;
    },
    getMode(): Mode {
      return mode;
    },
    getSessionId(): string {
      return sessionId;
    },
    setOptions(next: AgentDriverOptions): void {
      o = next;
      // Task 3: a swapped-in persona context object must carry the manual-
      // layer clearer too (frontends keep identity stable, but the driver
      // never depends on that).
      if (o.persona !== undefined) wirePersonaClearer(o.persona);
    },
    replaceExtensions(ext: DriverExtensionSwap): void {
      if (busy) {
        pendingExtSwap = pendingExtSwap === null ? ext : { ...pendingExtSwap, ...ext };
        return;
      }
      applyExtSwap(ext);
    },
    addTools(tools: readonly Tool[]): void {
      if (tools.length === 0) return;
      if (busy) {
        pendingTools = [...pendingTools, ...tools];
        return;
      }
      landTools(tools, false);
    },
    state,
    get persona(): DriverPersonaContext | undefined {
      return o.persona;
    },
    submit(text: string, submitOpts?: { readonly plan?: boolean; readonly expand?: boolean; readonly images?: readonly ImageBlock[]; readonly files?: readonly FileBlock[] }): SubmitOutcome {
      return routedSubmit(text, submitOpts);
    },
    isIdle(): boolean {
      return sessionIdle();
    },
    interrupt(): void {
      // M61 §2: Esc clears /loop's PENDING wakeups only — explicit scheduled
      // tasks stay armed (spec: Esc 只清 /loop 的 pending 唤醒).
      const cleared = loopController?.clearPendingOnEsc() ?? 0;
      if (cleared > 0) appendHistory({ kind: "notice", text: `⏹ /loop：已清除 ${cleared} 个待唤醒任务（显式定时任务不受影响）` }); // ω99-166f-iii: #19
      // ω99-45: an in-flight /compact rides HERE too — the same cancel point
      // as the run's abort, reached while !busy (a manual compaction runs
      // idle; the early return below used to make Esc a no-op against it).
      // Aborting cancels the summarizer's provider call; no boundary lands.
      compactionAbort?.abort();
      // 弧 δ: an explicit stop reaches the BACKGROUND tasks too (用户意图优
      // 先) — before the !busy early return.
      detachLane.stopAll();
      if (!busy) return;
      // M51 §3: an `interruptBehavior: "block"` tool is uninterruptible — Esc
      // surfaces the notice and the run waits for the tool to settle (the
      // loop never raced it against the abort signal). Any OTHER busy tool
      // interrupts normally.
      const blocking = live.busyTools
        .map((t) => o.tools.find((tool) => tool.name === t.name))
        .find((tool) => tool?.interruptBehavior === "block");
      if (blocking !== undefined) {
        appendHistory({ kind: "notice", text: `⏳ ${blocking.name} 不可中断——等待其结束（稍后再按 Esc）` }); // ω99-166e-i: #6（不可中断等待回执中文化；blocking.name 插值原样）
        return;
      }
      interrupted = true;
      // Abort first: the signal rejects the in-flight fetch / loses the tool
      // race, so the loop returns its aborted terminal promptly instead of
      // waiting out a hung await. gen.return is belt-and-braces for any path
      // the signal cannot reach. A parked permission ask suspends the gate
      // outside any signal race — deny it so the run can unwind.
      denyPendingAsk();
      abort?.abort();
      void gen?.return(undefined as never);
    },
    listSlashCommands(): readonly SlashCommandInfo[] {
      return listSlashCommands({
        skills: o.skills ?? [],
        pluginCommands: o.pluginCommands ?? [],
        extensionCommands: o.extensionCommands ?? [],
      });
    },
    async sessions(): Promise<readonly SessionRow[]> {
      if (o.workspaceRoot === undefined) return [];
      // M58 §C#7: the web picker shares the worktree filter (--all lifts).
      const filter = await defaultSessionListFilter(o.workspaceRoot);
      return collectSessionRows(
        join(o.workspaceRoot, ".wudao", "sessions"),
        filter !== undefined ? { filterWorkspaceRoot: filter } : {},
      );
    },
    // ω99-277（续，标记见上）— 弹框搜索车道：同一 sessions 目录、同一
    // worktree 过滤，q 预滤 + 只读扫描。
    async searchSessions(q: string): Promise<readonly SessionSearchHit[]> {
      if (o.workspaceRoot === undefined) return [];
      const filter = await defaultSessionListFilter(o.workspaceRoot);
      return searchSessionFiles(
        join(o.workspaceRoot, ".wudao", "sessions"),
        q.trim(),
        filter !== undefined ? { filterWorkspaceRoot: filter } : {},
      );
    },
    // ω99-313 — 定时任务与提醒的读面：store 只读扫描（REPL /schedule list
    // 同一事实源）；refused → []（web 面隐藏，不致命）。
    // ω99-317 — 读面加性补：join「上次运行」（schedules 会话日志的
    // schedule_run 条目，文件序最后一条胜）；无日志/无此 task 的条目 → null。
    async schedulesList(): Promise<readonly ScheduleListRow[]> {
      if (o.workspaceRoot === undefined) return [];
      try {
        const store = await loadSchedulesStore({ workspaceRoot: o.workspaceRoot });
        const rows = scheduleRowsOf(store.tasks);
        let runs = new Map<string, ScheduleLastRun>();
        try {
          const entries = await createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions")).loadSessionEntries(SCHEDULES_SESSION_ID);
          runs = lastRunsOf(entries);
        } catch {
          // no log yet (nothing ever ran) — every row's lastRun stays null
        }
        return rows.map((r) => ({ ...r, lastRun: runs.get(r.id) ?? null }));
      } catch {
        return [];
      }
    },
    // ω99-317 — 管理面写面三件：全部路由 o.schedule（守护是调度存储的唯一
    // 所有者）。回执判据 ok = !message.startsWith("⚠️")——与
    // createScheduleTools 的拒答判据同一事实源。无守护（headless/REPL 形
    // driver）→ {ok:false} 诚实指路 wudao ui（软降级，非异常）。
    async schedulesSetEnabled(id: string, enabled: boolean): Promise<ScheduleActionResult> {
      const daemon = o.schedule;
      if (daemon === undefined) return { ok: false, message: "⚠️ 本进程没有调度守护——请在 wudao ui 宿主里管理定时任务" };
      const message = enabled ? await daemon.unpause(id) : await daemon.pause(id);
      return { ok: !message.startsWith("⚠️"), message };
    },
    async schedulesRemove(id: string): Promise<ScheduleActionResult> {
      const daemon = o.schedule;
      if (daemon === undefined) return { ok: false, message: "⚠️ 本进程没有调度守护——请在 wudao ui 宿主里管理定时任务" };
      const message = await daemon.rm(id);
      return { ok: !message.startsWith("⚠️"), message };
    },
    async schedulesRunNow(id: string, opts?: { readonly resetBreaker?: boolean }): Promise<ScheduleActionResult> {
      const daemon = o.schedule;
      if (daemon === undefined) return { ok: false, message: "⚠️ 本进程没有调度守护——请在 wudao ui 宿主里管理定时任务" };
      const message = await daemon.runNow(id, opts);
      return { ok: !message.startsWith("⚠️"), message };
    },
    // ω99-279（续，标记见上）— 弹框清理车道：回收站式 rename 进 .trash/。
    // 纯层的三因拒答（invalid-id/not-found/active）原样回。
    // ω99-281: #2 — 守卫从进程内知识扩到跨进程 lease 事实：guardIds =
    // 当前主会话（闭包 sessionId，随 resume/clear/fork 走 setSessionId 轮换）
    // + 活跃 pet 车道 + 目标会话自己的 lease（.leases/<id>.json——他进程
    // resume 正在持，279 边界①：不守则 rename 后对方下一次 append 在原路径
    // 脏复活）。活性统一走 sessionLeaseAlive（pet 车道锁与 core lease 同
    // 载荷形，进程死了下次 boot 偷回；这里只读，绝不动 pet 车道本体）。
    async deleteSession(id: string): Promise<SessionDeleteResult> {
      if (o.workspaceRoot === undefined) return { deleted: false, reason: "not-found" };
      const sessionsRoot = join(o.workspaceRoot, ".wudao", "sessions");
      const guardIds = [sessionId];
      // "pet" 是 ui.ts PET_SESSION_ID / server PET_LANE_SESSION_ID 的本文件
      // 字面孪生（server :322 先例——跨层不 import，注释互指）。
      if (await sessionLeaseAlive(sessionsRoot, "pet")) guardIds.push("pet"); // 精灵会话正在写（本进程或他进程）
      if (await sessionLeaseAlive(sessionsRoot, id)) guardIds.push(id); // 他进程 resume 持有 → 不可删
      return deleteSessionFile(sessionsRoot, id, { guardIds });
    },
    // ω99-283（续，标记见上）— 回收站面：列表直通 listTrashedSessions；
    // 恢复直通 restoreSessionFile（无 guardIds——恢复永不破坏，占用由
    // target-exists 拒）。deleteSession 的守卫段零动（279/281 语义原样）。
    async trashSessions(): Promise<readonly SessionRow[]> {
      if (o.workspaceRoot === undefined) return [];
      return listTrashedSessions(join(o.workspaceRoot, ".wudao", "sessions"));
    },
    async restoreSession(id: string): Promise<SessionRestoreResult> {
      if (o.workspaceRoot === undefined) return { restored: false, reason: "not-found" };
      return restoreSessionFile(join(o.workspaceRoot, ".wudao", "sessions"), id);
    },
    async resume(id: string): Promise<ResumeOutcome> {
      if (o.workspaceRoot === undefined) return { ok: false, reason: "not_found" };
      try {
        const store = createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"));
        const entries = await store.loadSessionEntries(id);
        // An id with no recorded entries is not a session the store knows —
        // report not-found instead of adopting an empty conversation.
        if (entries.length === 0) return { ok: false, reason: "not_found" };
        // #48: adoption must OWN the lease before the swap — fail fast with
        // the holder named instead of adopting a session another process is
        // actively writing (the in-memory swap below would otherwise fork a
        // second writer against the same JSONL).
        if (sessionLeases !== undefined) {
          const r = await sessionLeases.acquire(id);
          if (!r.ok) {
            appendHistory({ kind: "notice", text: `⚠️ 会话 ${id} 正被进程 ${r.holder.pid} 占用 — 无法接管(该会话已在另一进程运行)` });
            // ω99-225: the refusal now carries its reason AND the holder's
            // pid — the caller can tell a busy session from a missing one
            // instead of guessing off a bare boolean.
            return { ok: false, reason: "occupied", holderPid: r.holder.pid };
          }
        }
        // M53 review fix: branch-aware — walk the chain the recorded
        // active_branch entry names (linear-last fallback when absent or
        // corrupt), exactly like the CLI's resolveSession.
        // M52 §1: chain-aware projection — keep from the FIRST summary marker
        // so every chained summary survives; the next compaction continues
        // after the last one instead of re-summarizing frozen bytes.
        const messages = repairOrphanedToolCalls(applySummaryMarkers(resumeChain(entries.filter((e): e is AgentMessage => "role" in e), activeBranchLeafKey(entries)), { chain: true }));
        // (ω99-217 #1 续 → 118 续修 09-27)：resume 路径也改锚定交错（此前
        // 尾端并入是收据堆底部的残余路径）。锚点从同批已载条目计算，经
        // loadHistoryFn 的第五参（anchors）传入交错重建。
        loadHistoryFn(messages, id, [], receiptAnchorsFromEntries(entries));
        // 09-17 用户报障修复：恢复会话时恢复最后的工作区——从消息链尾部扫
        // 描最后一条 <workspace_changed path="..."> MetaNote，agentRootBox 对
        // 齐（用户每次恢复后不用再手动切目录）。零 workspace_changed 条目=
        // 行为不变（默认工作区保持）。
        if (agentRootBox !== undefined) {
          for (let i = state.messages.length - 1; i >= 0; i -= 1) {
            const m = state.messages[i];
            if (m === undefined || m.role !== "user") continue;
            const wm = /<workspace_changed path="([^"]+)">/.exec(String(m.content));
            if (wm !== null) {
              agentRootBox.current = wm[1]!;
              break;
            }
          }
        }
        // M61 §3: a still-active goal restores on resume (counters reset).
        if (goalController !== undefined) goalController.restoreFromEntries(entries);
        // ω99-249: the live GoalState restores too (counters kept as
        // persisted; the mission ledger reconciles the status at the next
        // run boundary — honest resume, no counter fiction).
        goalRuntime?.restoreFromEntries(entries);
        // ω99-314: the snapshot catalog restores from the same read (the
        // adopt-then-revert flow keeps its guard-3 baseline).
        rebuildSnapshotCatalog(entries);
        // 113-B3: the adopted session's park counter restores from the same
        // read (loadHistoryFn's swap reset it; the file rows are the truth).
        quotaParks = countQuotaParkEntries(entries);
        // 125 项 1/项 2: the adopted session's window chain restores from the
        // same read — the resumed conversation continues the chain from the
        // entries (setSessionId's reset above cleared the old session's;
        // pre-125 boundary rows count, windowIndex or not).
        {
          const chain = windowChainFromEntries(entries);
          windowBoundaryCount = chain.boundaryCount;
          lastWorldSnapshot = chain.lastWorldState;
        }
        appendHistory({ kind: "notice", text: `↪ 已恢复 ${id.slice(0, 8)} · ${messages.length} 条消息` }); // ω99-166f-iii: #20
        // 133 top1（deepagents 64dccb060 形）— 缓存时钟决策点：会话文件的
        // mtime 即"上次缓存承载请求"的时刻；台账里最后一条 model_change/
        // thinking_level_change 是被缓存的身份；本进程接下来要用的身份是
        // modelLive。冷 + 前缀够大 + 估价过阈 → 一条信息性通知（轮转
        // offer）；身份变化 → 独立通知；暖/无记录 → 沉默。纯决策层，零
        // 请求字节改动（M24）。注册表/估算失败静默——时钟永不破坏 resume。
        // 与 128-2 预热的协同：offer 成立时用户可能轮转开窗，跳过自动预热
        // （预热的冷读会白烧）；不成立时照常预热。严格不劣于现状。
        let skipPrewarm = false;
        try {
          const lastActivityMs = await stat(join(o.workspaceRoot, ".wudao", "sessions", `${id}.jsonl`))
            .then((s) => s.mtimeMs)
            .catch(() => undefined);
          const catalogModels =
            modelLive.provider !== undefined ? loadEffectiveProfiles().get(modelLive.provider)?.models : undefined;
          const pinned = modelLive.model !== undefined ? catalogPricesFor(catalogModels, modelLive.model) : undefined;
          const decision = coldCacheResumeDecision({
            entries,
            lastActivityMs,
            nowMs: Date.now(),
            currentIdentity:
              modelLive.model !== undefined
                ? {
                    model: modelLive.model,
                    ...(modelLive.provider !== undefined ? { provider: modelLive.provider } : {}),
                    ...(modelLive.effort !== undefined ? { reasoningEffort: modelLive.effort } : {}),
                  }
                : undefined,
            prefixTokens: estimateTokens(state.systemPrompt, state.tools.map(toModelToolDefinition), state.messages),
            price:
              pinned !== undefined && pinned.inputPerM > 0 && pinned.cacheReadPerM >= 0
                ? { inputPerM: pinned.inputPerM, cacheReadPerM: pinned.cacheReadPerM }
                : undefined,
          });
          if (decision.notice !== undefined) appendHistory({ kind: "notice", text: decision.notice });
          skipPrewarm = decision.offer.offer;
        } catch {
          // The clock is advisory — any failure here leaves resume exactly as
          // it was (prewarm below still runs).
        }
        // 128-2（codex 形，变体）— the resume prewarm: the user is about to
        // READ the history (the idle window); one background max_tokens:1
        // same-prefix request re-warms the provider's prefix cache so their
        // next message rides warm bytes. Fire-and-forget, silent failure,
        // WUDAO_DISABLE_RESUME_PREWARM=1 family kill switch. 133 top1: skipped
        // when the cold-cache offer fired (pending rotation decision).
        if (!skipPrewarm) fireResumePrewarm(o.model, {
          systemPrompt: state.systemPrompt,
          tools: state.tools,
          messages: state.messages,
        });
        // M63-A: a runtime /resume adoption is a session boundary.
        sessionStartHook("resume");
        // M63-B: the adoption ENDED the previous session.
        sessionEndHook("resume");
        return { ok: true };
      } catch {
        // An unreadable/corrupt session file degrades to not-found for the
        // caller (same honest ceiling as the empty-entries arm above).
        return { ok: false, reason: "not_found" };
      }
    },
    rewind(target: number | "last" | "list"): Promise<string> {
      return rewindTo(target);
    },
    // ω99-286（续，标记见上）— 断口续跑的实现（接口注释是语义契约）。存在
    // 性 → 采纳（复用 resume 载入链；本进程已持有该 id 则免重载——装载即
    // 事实源）→ isUnfinishedTail 判据（settled 尾不空转，零模型调用）→
    // startRun 的 continueRun 形（同包装 minus 用户回合）。
    async continueSession(id: string): Promise<{ readonly started: boolean; readonly refused?: "busy" | "not_found" | "settled" | "shape" }> {
      if (o.workspaceRoot === undefined) return { started: false, refused: "shape" };
      // 形状门（fail-closed，路径拼接前；279 deleteSession 同款）：side- 前缀
      // 是副链文件，绝不当作主会话采纳。
      if (!SESSION_ID_RE.test(id) || id.startsWith("side-")) return { started: false, refused: "shape" };
      // 并发门：run / 手动 compact 进行中不双跑（续跑无停泊车道，诚实拒答）。
      if (busy || compactionAbort !== null) return { started: false, refused: "busy" };
      try {
        const store = sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions"));
        const entries = await store.loadSessionEntries(id);
        // 无条目 = store 不认识的 id（225 resume 同款诚实上限）。
        if (entries.length === 0) return { started: false, refused: "not_found" };
        // 采纳：非当前会话 → resume 载入链一字不差（租约 + 链投影 + 孤儿修补
        // + 收据回放 + hooks）；当前会话（web 流程先 resume 后点继续）已载，
        // 免重载——重载会重复 ↪ 通知并重置水印。
        if (id !== sessionId) {
          const outcome = await driverObj.resume(id);
          if (!outcome.ok) return { started: false, refused: "not_found" };
        }
        // 尾形判据：装载（修补）后的 state.messages 尾——settled 尾在此拒，
        // 一发模型调用都不花。ω99-289（续，标记见上）— 错误尾（合成
        // "(error: …)" assistant）接进同一道门：中断形或失败形，其一过关。
        const tailUnfinished = isUnfinishedTail(state.messages);
        if (!tailUnfinished && !isErrorTail(state.messages)) return { started: false, refused: "settled" };
        if (!tailUnfinished) {
          // ω99-289（续，标记见上）错误臂——先全门后变异：合成错误的前驱必须是中断形
          // （首腿败→user 尾；工具轮后败→tool_result 尾）。settled 前驱
          // （构造上不可达的防御形状）在此拒：state 一字未动，fail-closed。
          if (!isUnfinishedTail(state.messages.slice(0, -1))) return { started: false, refused: "settled" };
          // 过门后变异（全部在内存——append-only 日志一字不动，:3745 的
          // 合成错误条目留在盘上原支）。① pop：state 尾回到失败点前驱，
          // 模型输入尾即前驱（字节原样，不注引导语）。
          state.messages = state.messages.slice(0, -1);
          // ② /edit 分支臂同款重建块：history 全量重建（折叠工具轮——
          // 已接受行为）、board/plan 视图复位。
          history = resumeEntries(state.messages, sessionId);
          historyOut = history;
          resetHistory();
          boardProgress = null;
          planBoard = null;
          // ③ 分支重链：重试轮首条新消息 parentUuid 链失败点前驱（见
          // armRetryLink——旧错误支孤儿在树，重试不是删除）。
          armRetryLink();
        }
        startRun("", false, undefined, undefined, { continueRun: true });
        return { started: true };
      } catch {
        // 不可读/损坏的会话文件 → 诚实拒（225 resume 同款收敛）。
        return { started: false, refused: "not_found" };
      }
    },
    listEditTargets(): readonly { readonly n: number; readonly text: string }[] {
      return editTargets().map((t) => ({ n: t.n, text: t.text }));
    },
    beginEdit(n: number): string | undefined {
      return beginEditFn(n);
    },
    tree(): Promise<string> {
      return treeText();
    },
    async switchBranch(n?: number): Promise<string> {
      if (busy && n !== undefined) return "⚠️ 运行中无法切换分支"; // ω99-166c-iv: #21
      return switchBranchFn(n);
    },
    async branchLeaves(): Promise<readonly BranchLeaf[]> {
      return branchLeavesFn();
    },
    disarmEdit(): boolean {
      return disarmEditFn();
    },
    // ω99-260: 面一 wiring — the memory faces' read/decide seams（永续 v6 弧 A: blocked 计数随回执）.
    async memoryList(): Promise<{ readonly entries: readonly MemoryEntryMirror[]; readonly blocked: number }> {
      const r = await memoryListFn();
      // The panel's own fetch doubles as signature knowledge — the SAME load,
      // zero extra store IO (a panel opened after an external write therefore
      // carries a fresh signature too, not just fresh rows).
      if (o.workspaceRoot !== undefined) memorySig.setCached(memorySig.compute(r.entries));
      return r;
    },
    async memoryDecide(id: string, action: "ok" | "del"): Promise<{ readonly ok: boolean; readonly message: string }> {
      const r = await memoryDecideFn(id, action);
      // The write landed — the signature face follows NOW, not at next settle
      // (an ok:false verdict wrote nothing; no refresh — the face is still true).
      if (r.ok) await memorySig.refresh();
      return r;
    },
    // ω99-264: the panel's 改写 seam — the edit closure (short-circuit +
    // update + conditional confirm).
    async memoryEdit(id: string, content: string): Promise<{ readonly ok: boolean; readonly message: string }> {
      const r = await memoryEditFn(id, content);
      // Same landing discipline as the decide (the content-equal short-circuit
      // wrote nothing — the awaited read lands the SAME value, zero frames).
      if (r.ok) await memorySig.refresh();
      return r;
    },
    // 永续 v6 wave2（reef C1）：门控自改进面——管理面（设置→偏好→改进提案）
    // 的数据与决策缝。全部守卫在任何模型调用之前（consent 的门禁环境检查、
    // 状态门）；决策幂等收敛（MISS 形）；consent 的子代理/门禁异步落定时
    // 走 appendHistory notice（与触发通知同车道）。
    async improvementFace(action: "list" | "consent" | "ignore" | "activate" | "reject" | "undo", id?: string): Promise<ImprovementFaceResult> {
      const root = o.workspaceRoot;
      if (root === undefined) {
        return action === "list" ? { ok: true, message: "没有打开的工作区", records: [] } : { ok: false, message: "没有打开的工作区" };
      }
      if (action === "list") {
        return { ok: true, message: "", records: (await listImprovements(root)).map(toImprovementWire) };
      }
      if (id === undefined) return { ok: false, message: "缺少提案 id" };
      const MISS = "没有这条改进提案（可能已处理过）";
      const record = await readImprovement(root, id);
      if (record === undefined) return { ok: false, message: MISS };
      const now = new Date().toISOString();
      if (action === "consent") {
        if (o.agentsRegistry === undefined) return { ok: false, message: "本会话没有子代理注册表——无法生成提案" };
        return consentToGenerate({
          workspaceRoot: root,
          id,
          model: o.model,
          registry: o.agentsRegistry,
          onNotice: (line) => appendHistory({ kind: "notice", text: line }),
        });
      }
      if (action === "ignore") {
        const next = withStatus(record, "ignored", { decidedAt: now });
        if (next === undefined) return { ok: false, message: MISS };
        await writeImprovement(root, next);
        return { ok: true, message: "已忽略这个失败的改进触发（不再重复提醒）" };
      }
      if (action === "reject") {
        const next = withStatus(record, "rejected", { decidedAt: now });
        if (next === undefined) return { ok: false, message: MISS };
        await writeImprovement(root, next);
        return { ok: true, message: "已驳回该提案（留档——同一失败模式不会再自动提案）" };
      }
      if (action === "activate") {
        const r = await activateImprovement(root, record, now);
        if (!r.ok) return { ok: false, message: r.message };
        return { ok: true, message: `已激活该规则（${r.record.ruleFile ?? ""}）——下次会话生效` };
      }
      const r = await undoImprovement(root, record, now);
      return { ok: r.ok, message: r.message };
    },
    // ω99-213: #2 — the away recap op. All gates run BEFORE any model call,
    // so a non-qualifying return costs zero calls: session identity first
    // (the mark belongs to THIS conversation only), then the ≥3-new-messages
    // server-side twin of the web's dual gate (the client's away threshold is
    // client-local — only the viewer knows when it was last visible).
    // ω99-316: /btw 侧问的 server op 半边。全部守卫在任何模型调用之前
    // （recap 同款纪律）：会话比对 + 空文本拒。旁路 run 走 enqueueSideQuestion
    // （快照原子取请求时刻、轮间串行、每轮重克隆）；工具冻结意味着零副作用
    // 面，无需权限门。M24：旁路绝不写 session JSONL/store——这里的全部
    // 可观察效果就是返回值本身。
    async sideQuestion(id: string, text: string): Promise<SideQuestionResult> {
      if (id !== sessionId) throw new Error("旁问失败：会话不匹配（sideQuestion forks THIS session's prefix）");
      const question = text.trim();
      if (question === "") throw new Error("旁问失败：空文本");
      const result = await enqueueSideQuestion(question);
      return { answer: result.answer, rounds: result.rounds };
    },
    async recap(id: string, sinceMark: number, sinceTs?: number): Promise<RecapPayload | undefined> {
      // `id` shadows nothing — the closure's live session id IS `sessionId`.
      if (id !== sessionId) return undefined;
      if (!Number.isInteger(sinceMark) || sinceMark < 0 || sinceMark > history.length) return undefined;
      const slice = history.slice(sinceMark);
      if (countNewMessages(slice) < RECAP_MIN_NEW_MESSAGES) return undefined;
      const stats = { ...composeRecapStats(slice), sinceTs: sinceTs ?? null };
      const req = buildRecapRequest(slice);
      // No assistant-shaped content in the window: stats-only, no call.
      if (req === undefined) return { stats };
      try {
        const reply = await o.model.generate({
          systemPrompt: req.systemPrompt,
          messages: [{ role: "user", content: req.user }],
          tools: [],
          reasoningEffort: "low",
          maxTokens: 512,
          querySource: RECAP_QUERY_SOURCE,
        });
        const narrative = sanitizeRecap(reply.content);
        return narrative === undefined ? { stats } : { stats, narrative };
      } catch {
        // Fail-closed: the degraded stats-only card, nothing fabricated.
        return { stats };
      }
    },
    // M74-ide §1: the file-panel data ops. workspace-ux B1: both resolve
    // against panelRoot — the PANEL's view root, not the agent's workspace
    // root (it starts there but moves with panelRootSet). No root-shaped
    // branch remains: panelRoot always exists (cwd fallback), so the panel
    // always has something to list.
    async fileTree(path: string): Promise<FileTreeResult> {
      return fileTreeListing(panelRoot, path);
    },
    async fileRead(path: string): Promise<FileReadResult> {
      return fileReadContent(panelRoot, path);
    },
    async fileWrite(path: string, content: string, base: string): Promise<FileWriteResult> {
      return fileWriteContent(panelRoot, path, content, base);
    },
    // ω99-314（续，标记见上）— 文件级时光机：把指定文件恢复到指定快照。
    // 守卫序（接口注释是语义契约；blob 缺席检在 pre-restore 快照之前——
    // 一个恢复不出来的请求不必先动仓）。写入 tmp+rename 原子写；回执落
    // history notice（含守卫 3 的明示语）；目录与持久索引随恢复更新。
    async fileRevert(path: string, sha: string): Promise<FileRevertResult> {
      // ①活跃回合 409（286 同判据：run 或手动 compact 进行中不双跑不双写）。
      if (busy || compactionAbort !== null) {
        return { ok: false, reason: "busy", message: "任务正在跑，等它停下来再恢复" };
      }
      const store = o.snapshots;
      const root = o.workspaceRoot;
      if (store === undefined || root === undefined) {
        return { ok: false, reason: "no-store", message: "本会话未启用文件快照，无法恢复" };
      }
      // 形状门：sha 必须 64 位小写十六进制（fail-closed，解析路径前）。
      if (typeof path !== "string" || path === "" || !/^[0-9a-f]{64}$/.test(sha)) {
        return { ok: false, reason: "bad-path", message: "恢复请求的形状不对（路径或快照编号无效）" };
      }
      const resolved = await resolveWorkspacePath(root, path);
      if (!resolved.ok) {
        return { ok: false, reason: "bad-path", message: resolved.error };
      }
      // ④blob 缺席（LRU 淘汰/删仓）→ typed 拒；文件一字节未动。
      const blob = await store.readBlob(sha);
      if (blob === null) {
        return { ok: false, reason: "evicted", message: "快照已被清理，无法恢复" };
      }
      const rel = relWithinWorkspace(await realpath(root).catch(() => root), resolved.absPath);
      // ③哈希核验：当前内容 sha ≠ 目录里该文件最新 afterSha（含文件被删）
      // → 不拒，回执/判决明示（UI 确认面在 ask 侧，本 op 诚实报事实）。
      const current = await readFile(resolved.absPath, "utf8").catch(() => undefined);
      const latest = snapshotCatalog.get(rel);
      // 文件被删（current undefined）也算「被改过」——恢复会盖掉删除。
      const stale = latest !== undefined && (current === undefined || sha256Hex(current) !== latest);
      // ②pre-restore 安全快照——恢复本身可撤销（超越点①）：恢复前的旧内容
      // 再落一份（fail-open：快照尽力而为，双保险的另一半是 UI 的 ask 确认）。
      let preSha: string | null = null;
      if (current !== undefined) preSha = await store.ensureBlob(current);
      // 原子写（fileWriteContent 同款惯用法：同目录 tmp + rename）。
      const tmp = join(dirname(resolved.absPath), `.${basename(resolved.absPath)}.wudao-${randomUUID()}.tmp`);
      await writeFile(tmp, blob, "utf8");
      await rename(tmp, resolved.absPath);
      // 读状态刷新（同 write_file 写后纪律）：恢复内容计为已读，模型下一次
      // edit/write_file 不被「文件变了」的盲写门冤枉。
      if (o.readState?.get(resolved.absPath) !== undefined) {
        const after = await stat(resolved.absPath);
        o.readState.record(resolved.absPath, readStateEntry(blob, after.mtimeMs));
      }
      // 目录 + 持久索引随恢复更新（before=恢复前内容，after=恢复后内容；
      // 同一泛型车道 best-effort 落盘——resume 后守卫 3 基准照活）。
      snapshotCatalog.set(rel, sha);
      if (preSha !== null) {
        const turn = history.filter((e) => e.kind === "notice" && e.changes !== undefined && e.changes.length > 0).length + 1;
        void (sessionStore ?? createJsonlSessionStore(join(root, ".wudao", "sessions")))
          .appendEntries(sessionId, [{ type: "file_snapshot", data: { turn, run: sessionId, path: rel, beforeSha: preSha, afterSha: sha } }])
          .catch(() => { /* best-effort — the revert already landed */ });
      }
      const staleNote = stale ? "（文件在快照之后被改过，恢复已覆盖这些改动——覆盖前已再留一份快照）" : "";
      appendHistory({ kind: "notice", text: `↩ 已恢复 ${rel}——这一轮开始前它是这个样子${staleNote}` });
      emit();
      return { ok: true, stale, message: `已恢复 ${rel}${staleNote}` };
    },
    // workspace-ux B1: the panel-root ops. Validation mirrors
    // switchWorkspace's exists-and-directory gate with the two typed failure
    // states; the recents record is best-effort (a failed file write must not
    // fail the switch — the panel already moved, the menu just misses one
    // row). No busy guard BY DESIGN: the view root disrupts nothing the run
    // touches. emit() pokes the status channel so a live frontend re-reads;
    // panelRoot deliberately rides the op receipt, not the status snapshot.
    async panelRootSet(path: string): Promise<PanelRootSetResult> {
      const st = await stat(path).catch(() => undefined);
      if (st === undefined) throw new Error(`no such directory: ${path}`);
      if (!st.isDirectory()) throw new Error(`not a directory: ${path}`);
      panelRoot = path;
      await recordRecentWorkspace(path).catch(() => undefined);
      emit();
      return { root: panelRoot };
    },
    async agentRootStatus(): Promise<AgentRootStatusResult> {
      // workspace-ux B2: agentRoot is the SWITCHABLE root (agentRootSwitch's
      // variable — cwd fallback unchanged). aligned compares REALPATHS (raw
      // strings are stored/reported as given): a symlinked pick — macOS
      // tmpdir's /var vs /private/var — must not false-negative the flag.
      const norm = async (p: string): Promise<string> => realpath(p).catch(() => p);
      const [panelReal, agentReal] = await Promise.all([norm(panelRoot), norm(agentWorkspaceRoot)]);
      return { panelRoot, agentRoot: agentWorkspaceRoot, aligned: panelReal === agentReal };
    },
    // workspace-ux B2: the confirm-card action. Validation mirrors
    // panelRootSet's exists-and-directory gate (typed errors, nothing moves)
    // and runs BEFORE queueing, so the pending slot never holds a bad path.
    // Busy → park to the settle seam (the run keeps the old root throughout);
    // idle → land now. A switch whose end state already holds is a receipted
    // no-op (no notice, no note — the model would learn nothing new): idle
    // compares against the LIVE root; busy compares against the PENDING
    // switch first (last write wins — re-confirming the queued pick changes
    // nothing, and switching back to the live root supersedes the queue).
    async agentRootSwitch(path: string): Promise<AgentRootSwitchResult> {
      const st = await stat(path).catch(() => undefined);
      if (st === undefined) throw new Error(`no such directory: ${path}`);
      if (!st.isDirectory()) throw new Error(`not a directory: ${path}`);
      if (busy) {
        if (await sameAgentRoot(path, pendingAgentRoot?.path ?? agentWorkspaceRoot)) {
          return pendingAgentRoot !== null ? { applied: false, queued: true } : { applied: true, queued: false };
        }
        // P1-7: an explicit switch SUPERSEDES a queued /worktree op — last
        // write wins over the whole slot, so the worktree bookkeeping is
        // cancelled with a receipt (an enter's created directory is left in
        // place; an exit-keep leaves the session in the worktree).
        if (pendingWorktreeOp !== null) {
          const wasEnter = pendingWorktreeOp.kind === "enter";
          const name = pendingWorktreeOp.wt.name;
          pendingWorktreeOp = null;
          appendHistory({
            kind: "notice",
            text: `（排队的 /worktree ${wasEnter ? "enter" : "exit"}（${name}）已被本次根切换取代——从未落地${wasEnter ? "；已创建的 worktree 目录保留原处（git worktree list）" : "；会话仍留在 worktree 中"}）`, // ω99-166e-i: #7（/worktree 取代回执中文化；模板较长保持单行结构不变）
          });
        }
        pendingAgentRoot = { path, extRescan: false };
        return { applied: false, queued: true };
      }
      if (await sameAgentRoot(path, agentWorkspaceRoot)) return { applied: true, queued: false };
      await applyAgentRoot(path);
      return { applied: true, queued: false };
    },
    // M76-ux2 §8: the ctx hover's breakdown — estimateTokensBreakdown over
    // the SAME live state the watermark's updateCtxTokens reads (never a
    // cached snapshot), available clamped at zero so a post-compaction
    // estimate above the window cannot render a negative remainder.
    async ctxInfo(): Promise<CtxInfoResult> {
      const b = estimateTokensBreakdown(state.systemPrompt, state.tools.map(toModelToolDefinition), state.messages);
      const window = o.compaction?.contextWindowTokens ?? 64_000;
      return {
        systemTokens: b.systemTokens,
        toolsTokens: b.toolsTokens,
        messagesTokens: b.messagesTokens,
        imagesTokens: b.imagesTokens,
        availableTokens: Math.max(0, window - b.total),
      };
    },
    snapshotForStatusline(): StatuslineSnapshot {
      const meta = o.statusline ?? { model: "unset", version: "0" };
      return buildStatuslineSnapshot(buildStatus(), {
        // M63 §A: the live overlay wins over the frontend's static meta — a
        // provider switch repaints the model segment (label + provider) at
        // the switch itself, before any setOptions refresh arrives.
        model: modelLive.model !== undefined && modelLive.model !== ""
          ? modelLabel({ provider: modelLive.provider, model: modelLive.model })
          : meta.model,
        version: meta.version,
        ...(modelLive.provider !== undefined
          ? { provider: modelLive.provider }
          : meta.provider !== undefined
            ? { provider: meta.provider }
            : {}),
        ...(meta.sessionName !== undefined ? { sessionName: meta.sessionName } : {}),
        ...(meta.keys !== undefined ? { keys: meta.keys } : {}),
      });
    },
    clear(): void {
      // M80: the shared wipe (clearConversation above). Unlike the ROUTED
      // /clear this does NOT rotate the session id or write the boundary
      // marker — frontends calling clear() directly (the TUI) own the id
      // rotation themselves; the routed path is the driver-owned variant.
      clearConversation();
    },
    setSessionId(id: string): void {
      setSessionId(id);
      // M61 §1: the scheduler's scope follows the rotation.
      o.cron?.setSessionId(id);
      // The adopted id's own name (a fresh id reads nameless → null).
      refreshSessionName();
      emit();
    },
    loadHistory(messages: readonly AgentMessage[], id: string): void {
      loadHistoryFn(messages, id);
      // (ω99-217 #1 续 → 118 续修 09-27)：loadHistory picker 路径也改为锚定
      // 交错（此前尾端 appendHistory 是用户报障"收据全在底部"的残余路径——
      // 118 只修了 boot，切换会话的 loadHistory 仍走旧路）。读条目后用
      // receiptAnchorsFromEntries + resumeEntriesAnchored 重建交错历史，
      // resetHistory 整表帧覆盖（boot 修复同款机制）。
      if (sessionStore !== undefined || o.workspaceRoot !== undefined) {
        void (async () => {
          try {
            const store = sessionStore ?? createJsonlSessionStore(join(o.workspaceRoot as string, ".wudao", "sessions"));
            const entries = await store.loadSessionEntries(id);
            const anchors = receiptAnchorsFromEntries(entries);
            if (anchors.length > 0) {
              // 同 118 boot 修复：钳制到已建历史的消息数（读盘期间新消息
              // 不进交错基座），交错重建后整表帧
              const clamped = anchors.filter((a) => a.afterMessageIndex <= messages.length);
              if (clamped.length > 0) {
                history = resumeEntriesAnchored(messages, id, clamped);
                historyOut = history;
                resetHistory();
              }
            }
            // ω99-314: the picker's load rebuilds the snapshot catalog too
            // (same read, same file order).
            rebuildSnapshotCatalog(entries);
          } catch {
            /* best-effort replay — an unreadable store reads as zero */
          }
        })();
      }
      // M63-A: the /resume picker's adoption is a session boundary.
      sessionStartHook("resume");
      // M63-B: the adoption ENDED the previous session.
      sessionEndHook("resume");
    },
    notify(text: string): void {
      appendHistory({ kind: "notice", text });
    },
    pushMetaNote(text: string): void {
      metaNotes.push({ text, source: "系统通道" });
    },
    setMode(next: Mode): void {
      const prev = mode;
      mode = next;
      emit();
      // ω99-233: 进/出 auto 的模型侧引导（见 modeSteeringNote 注记）——
      // 追加语义（append-only、随下次首个模型调用单次冲刷），M24 零代价；
      // 不进 appendHistory notice（UI 已有 modechip 示档）。
      const note = modeSteeringNote(next, prev);
      if (note !== null) metaNotes.push({ text: note, source: "权限档位" });
      // M64-A fix: the peer tier follows the LIVE mode (the classification
      // matrix and the registry entry both) — shift+tab flips it for every
      // driver-based frontend.
      void o.peer?.setTier(next === "auto" ? "bypass" : "normal").catch(() => {});
      // 0.3.75 现场修复（自动模式反复询问）：档位切换此前只写内存——每个
      // 新会话从全局 defaultMode 重读（无该键则回落 workspace），用户选的
      // auto 一重启就丢，回来继续被问。切换即持久化到全局层
      // permissions.defaultMode（用户在 UI 的显式操作，与设置页同一条
      // saveGlobalSettings 通道，read-modify-write 保住全局层已有的其他键）；
      // 失败不回滚——本会话档位已生效，仅下次启动回落（与 peer tier 同为
      // best-effort）。
      void (async () => {
        try {
          const record = await readGlobalSettings();
          const perms =
            record["permissions"] !== undefined &&
            typeof record["permissions"] === "object" &&
            record["permissions"] !== null &&
            !Array.isArray(record["permissions"])
              ? (record["permissions"] as Record<string, unknown>)
              : {};
          await saveGlobalSettings({ ...record, permissions: { ...perms, defaultMode: next } });
        } catch {
          /* best-effort persistence — the in-session mode already applies */
        }
      })();
    },
    ask(toolName: string, input: Record<string, unknown>, ctx?: { readonly sidecarReason?: string }): Promise<PermissionDecision> {
      return askPermission(toolName, input, ctx);
    },
    // 借鉴弧 α2（CC 2.1.269 思想）— steering 未读撤回：CAS 删队列中一条仍未
    // 消费的排队消息（index 是状态帧快照里的下标，text 是同帧文本——两者仍
    // 逐字相符才删，防「帧到按钮点之间队列已被动过」的错杀；已被 loop 的
    // mid-run take() 或结算 drain 消费/开跑的条目天然不在数组里 → false）。
    // 只动 USER 队列：系统车道（FileChanged）与 cron/peer/childMail/monitor
    // 低优先车道不是用户的话，永不可撤。撤回发生在 flush 之前——连 token
    // 都不花（M24 零代价：既不进历史也不动前缀）。
    recallSteer(index: number, text: string): boolean {
      const q = queueRef.current;
      if (!Number.isInteger(index) || index < 0 || index >= q.length || q[index] !== text) return false;
      queueRef.current = q.filter((_, i) => i !== index);
      queued = [...queueRef.current];
      appendHistory({ kind: "notice", text: `↩ 已撤回排队消息:${truncate(text, 60)}` });
      emit();
      return true;
    },
    // 借鉴弧 ζ2（Amp Restack 思想）— /restack 的数据缝：会话归因条目 +
    // workspaceRoot 交给 restack.ts 纯层（拒绝面与安全律在那侧钉死）；
    // 运行中拒做（归因在 settle 缝落账）。
    restack(mode: "preview" | "apply"): void {
      void (async () => {
        try {
          const store = sessionStore ?? (o.workspaceRoot !== undefined ? createJsonlSessionStore(join(o.workspaceRoot, ".wudao", "sessions")) : undefined);
          if (busy) { appendHistory({ kind: "notice", text: "⚠️ 运行中无法 /restack——先等本轮收口（归因数据在运行落定时记录）" }); return; }
          if (store === undefined || o.workspaceRoot === undefined) { appendHistory({ kind: "notice", text: "（此会话无存储接线——/restack 在当前运行时不可用）" }); return; }
          appendHistory({ kind: "notice", text: await runRestack(mode, { cwd: o.workspaceRoot, loadEntries: () => store.loadSessionEntries(sessionId) }) });
        } catch (err) {
          appendHistory({ kind: "notice", text: `⚠️ /restack 失败：${err instanceof Error ? err.message : String(err)}` });
        }
      })();
    },

    // 弧 δ — the user face (full contract: contract.ts + detach-lane.ts).
    detachToolCall(callId?: string): DetachVerdict {
      const verdict = detachLane.detach(callId, live.busyTools, o.tools);
      emit();
      return verdict;
    },
    answerPermission(allow: boolean, reason?: string, scope?: "session" | "always"): boolean {
      const resolve = pendingResolve;
      if (resolve === null || pendingPermission === null) return false;
      const toolName = pendingPermission.toolName;
      const input = pendingPermission.input;
      // 0.3.14 #1: the web lane's scope — `a`/`p` synthesize the same answers
      // the local menus do; applyAskAnswer owns the protected-write
      // degradation centrally (allow-once, no rule).
      const answer: AskAnswer = !allow
        ? { kind: "deny", ...(reason !== undefined ? { reason } : {}) }
        : scope === "session"
          ? { kind: "session" }
          : scope === "always"
            ? { kind: "always" }
            : { kind: "allow" };
      // ω99-248 — the answer APPENDS the settle line (同意/拒绝——never a
      // rewrite of the ask line; the record's evidence loop closes here).
      if (parkedAskSession !== null) {
        askLedger(buildPermissionSettledEntry(parkedAskSession, answer.kind, Date.now()), parkedAskSession);
        parkedAskSession = null;
      }
      pendingPermission = null;
      pendingResolve = null;
      // 夜移 028: the human answered — work resumes, re-arm the assertion.
      powerGuard.sync(busy && pendingPermission === null);
      emit();
      if (allow && o.onAskRule !== undefined) {
        const { sessionRule, persistentRule } = applyAskAnswer(answer, toolName, input);
        // 夜移 009: exactly ONE dispatch per answer. `always` rides the
        // persist=true call alone — the sink's recordAskRules records the
        // session copy from it (a second (rule,false) dispatch would
        // double-record AND double-notify once sinks grew receipts).
        if (persistentRule !== null) o.onAskRule(persistentRule, true);
        else if (sessionRule !== null) o.onAskRule(sessionRule, false);
      }
      resolve(answer);
      return true;
    },
    /** M63-B (R1 fix): park a SYSTEM-authored steering text (the FileChanged
     *  delivery) in the SYSTEM lane — delivered by the loop's mid-run drain
     *  (turn-boundary append, prefix-stable), but NEVER auto-starting a run:
     *  the run-settle fallback reads only the USER queue. */
    steer(text: string): void {
      if (disposed || !active) return;
      systemSteerQueue.push(text);
      emit();
    },
    setCachePercent(percent: number | null): void {
      if (cachePercent === percent) return;
      cachePercent = percent;
      emit();
    },
    setGating(toolName: string, on: boolean): void {
      if (!active || disposed || !busy) return;
      const touches = live.busyTools.some((t) => t.name === toolName && t.gating !== on);
      if (!touches) return;
      live = {
        ...live,
        // abort-review I1: assign the badge flag ON THE ELEMENT — never
        // rebuild ({ ...t, gating }). The finished handler removes busy rows
        // by OBJECT IDENTITY (busyEntries.get(id) → filter(t !== bt)); a
        // rebuilt element escapes that filter, strands the completed tool in
        // busyTools, and the abort scan then files a bogus "outcome unknown"
        // entry for a call whose receipt already showed success. Containers
        // stay fresh like every other busyTools write; only the field moves.
        busyTools: live.busyTools.map((t) => {
          if (t.name === toolName && t.gating !== on) t.gating = on;
          return t;
        }),
      };
      emit();
    },
    taintProbe(input: Record<string, unknown>): string | undefined {
      return argsCarryTaint(taint, input);
    },
    setActive(next: boolean): void {
      if (active === next) return;
      active = next;
      if (!next) {
        // Abort the in-flight run's signal too: a hung fetch/tool settles from
        // the AbortError path even if the generator body never reaches a yield.
        // v7 γ2：在飞 run 的卸载=关窗中止——置旗给 settle 侧留名（gen.return
        // 可能先于 !active 断流分支到 done，旗是可靠来源）。
        if (busy) shutdownInterrupted = true;
        denyPendingAsk();
        abort?.abort();
        // ω99-45: the in-flight /compact's cancel point mirrors the run's —
        // an unmounting frontend must not leave a summarizer running.
        compactionAbort?.abort();
        void gen?.return(undefined as never);
        bgPoll.stop();
      } else {
        bgPoll.start();
      }
    },
    dispose(): void {
      disposed = true;
      // 夜移 028: this driver's hold ends here even if a transition was
      // missed (the guard is per-driver; the shared refCount keeps other
      // drivers' assertions alive).
      powerGuard.release();
      // M63-B: frontend shutdown ends the session (the bridge bounds all
      // SessionEnd commands to the shared 1.5s budget; the fire is voided so
      // teardown never waits).
      sessionEndHook("exit");
      bgPoll.stop();
      cronSeam.stop();
      fileWatchHandle?.stop();
      configSkillsTimer?.unref?.();
      if (configSkillsTimer !== null) clearTimeout(configSkillsTimer);
      peerSeam.stop();
      monitorSeam.stop();
      childMailSeam.stop();
      detachSeam.stop();
      // 弧 δ: teardown reaps the background tasks (the monitor-children
      // doctrine — resume never resurrects a lie).
      detachLane.stopAll();
      // ω-4a: the driver owns the monitor runtime's lifecycle — dispose reaps
      // every watched child and closes every watcher (idempotent).
      o.monitor?.stop();
      // M64-A §A: the driver owns the runtime's lifecycle — dispose closes
      // the inbox socket and unregisters the session (idempotent).
      void o.peer?.stop().catch(() => {});
      // 114 取证弧: tools that own a session-scoped child die with the
      // driver — any tool face carrying a FUNCTION stop() (python_kernel's
      // persistent kernel) is torn down here (bounded kill ladder inside,
      // idempotent; browser-runtime discipline: the kernel ALSO self-reaps on
      // idle and via the process-exit hook, so this is the eager
      // belt-and-braces). typeof-guarded: an extra-tools face carrying a
      // non-function `stop` field must never throw the teardown.
      for (const t of o.tools) {
        const stop = (t as { stop?: unknown }).stop;
        if (typeof stop === "function") stop();
      }
    },
  };
  driverBox0.current = driverObj;
  // 113-B3: the late-bound slot the wake seams read (continueSession lives on
  // the finished object above; the seams were created long before it).
  continueParkedSession = driverObj.continueSession;

  return driverObj;
}

