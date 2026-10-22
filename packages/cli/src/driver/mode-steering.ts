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
import { extractFileReceipt } from "./file-receipt.js";

// —— ω99-326a：自 agent-driver.ts 纯移动外提（类型/常量/纯函数；re-export 门面保公共面）——
// notice（UI 已有 modechip 示档，人不需重复提醒）。
/** ω99-233: 进 auto 的托付契约——boot 播种与 setMode 注入共用同一常量
 *  （文案逐字钉于弧 brief §二，执行者不造句）。 */
export const AUTO_MODE_CONTRACT =
  '<permission_mode mode="auto">用户已切换到自动模式——这是显式托付。后续动作无需逐项向用户确认：可逆、工作区内、常规风险的操作请自主决策并直接执行，完成后简要说明做了什么。只在三种情况停下来询问：(a) 可能造成不可恢复的数据丢失；(b) 需要触碰工作区之外的系统或真实凭据；(c) 任务目标存在会导向完全不同结果的歧义。</permission_mode>';

/** ω99-233: 出 auto 时目标档的确认姿态中文名（插值进退出声明；UI 的
 *  modeLabel 是英文姿态名，给模型的是语义名——映射逐字钉于弧 brief §二）。 */
export const MODE_STEERING_LABELS: Readonly<Record<Exclude<Mode, "auto">, string>> = {
  workspace: "工作区",
  ask: "逐项确认",
  plan: "只读规划",
};

/** ω99-233: 档位切换的模型侧引导文案（纯函数，导出供测试直钉六向矩阵）：
 *  非 auto→auto 返回托付契约；auto→非 auto 返回姿态恢复声明（档位 label
 *  插值）；其余切换（workspace↔ask↔plan 互切、同档重设）返回 null。 */
export function modeSteeringNote(next: Mode, prev: Mode): string | null {
  if (prev !== "auto" && next === "auto") return AUTO_MODE_CONTRACT;
  if (prev === "auto" && next !== "auto") {
    return `<permission_mode mode="${next}">已退出自动模式，确认姿态恢复（当前档位：${MODE_STEERING_LABELS[next]}）。请按当前档位的确认规则行事，不要再沿用自动模式的自主决策姿态。</permission_mode>`;
  }
  return null;
}

