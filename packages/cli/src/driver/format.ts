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
import type { LiveState } from "./types.js";

export const EMPTY_LIVE: LiveState = { reasoning: "", answer: "", busyTools: [] };
// ω99-63: the per-call bounded tail's char cap — a busy tool row's live-output
// payload keeps only the LAST 2000 chars (append concatenates then clips,
// snapshot replaces then clips): O(1) per row, LiveState never grows unbounded.
export const BUSY_TAIL_CAP_CHARS = 2000;
// ω99-32 T2: RESULT_PREVIEW_CHARS moved to log.ts (the headless frontends
// render the same-shaped preview line — one budget, no drift); it arrives
// via the log.js import above.
// Diff cap: a pathological existing file (or write payload) must not blow up
// the unified-diff render — old/new strings are truncated to this length.
export const DIFF_CAP_CHARS = 50_000;
// M30: how often the status bg counter re-aggregates registry.status(). The
// registry exposes no change notification; 400ms is well inside human
// perception for a secondary status line.
export const BG_STATUS_POLL_MS = 400;
// M61 §1: how often an armed scheduled fire is checked while idle. The
// runtime's tick (15s) dominates the latency in practice; this poll exists so
// a fire armed mid-tick lands promptly at the idle seam.
export const CRON_POLL_MS = 1_000;
// OOM fix: delta-driven status emissions are coalesced to at most one per
// window (10fps — the live text is a progress indicator, not typography).
export const DELTA_EMIT_INTERVAL_MS = 100;

export const str = (v: unknown): string => (typeof v === "string" ? v : "");

// Same shape core maps to the aborted terminal; a belt-and-braces check for
// AbortError-shaped throws escaping the loop (e.g. gen.return unwinding).
export const isAbortError = (err: unknown): boolean => err instanceof Error && err.name === "AbortError";

// Session ids are url-safe (store regex: [A-Za-z0-9_-]+) and sortable by name
// (same generator the TUI uses — the driver can start conversations on its
// own, e.g. the `wudao ui` frontend).
export function newSessionId(): string {
  return `wudao-${Date.now().toString(36)}-${randomUUID().split("-")[0]}`;
}
/** 0.3.6 反馈：meta_note 的人类预览清洗（doc 后半——前半注释见 fs-panels.ts 尾注）：
 * `↳ <system_note> <EXTREMELY_IMPORTANT> …`）。纯函数。
 * 0.3.7：collapse=true（默认）折叠空白成单行供预览截断；collapse=false
 * 只剥信封、保留换行——全文 detail 供展开视图。 */
export function notePreview(text: string, collapse = true): string {
  const stripped = text.replace(/<\/?system_note>/g, "").trim();
  if (collapse) return stripped.replace(/\s+/g, " ").trim();
  // detail 视图保留换行；信封剥除残留的 3+ 连续换行收敛为一个空行。
  return stripped.replace(/\n{3,}/g, "\n\n");
}

/** 0.3.15（用户需求：执行耗时可见）：毫秒 → 紧凑人读时长。纯函数，TUI/
 * web/一次性 CLI 共用同一格式：`<1s` / `2.3s`（一分钟内，一位小数）/
 * `3m07s`（一小时内）/ `1h04m`（以上）。 */
export function formatMs(ms: number): string {
  if (ms < 1_000) return "<1s";
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const total = Math.floor(s);
  if (total < 3_600) return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(total / 3_600)}h${String(Math.floor((total % 3_600) / 60)).padStart(2, "0")}m`;
}

/** 0.3.15：运行级耗时收据（run 的最后一条 history notice，也是 slack 摘要
 * footer 搬运的同一段文本）。`llmMs === null` = 没有任何 usage 行报告过
 * durationMs（脚本模型/未知网关）→ 模型段整体省略（omit-never-null，不
 * 拿 0 冒充）；0 次工具调用省略工具段（纯问答回合不刷噪音行）。 */
export function formatRunStats(totalMs: number, llmMs: number | null, toolMs: number, toolCalls: number, idleReconnects = 0, softIdleWarns = 0, cacheDebtTokens = 0): string {
  const parts = [`耗时 ${formatMs(totalMs)}`];
  if (llmMs !== null) parts.push(`模型 ${formatMs(llmMs)}`);
  if (toolCalls > 0) parts.push(`工具 ${formatMs(toolMs)} (${toolCalls} 次)`);
  // ω99-315：idleReconnects > 0 追加「断流重连 N 次」——本 run 里看门狗
  // 杀掉挂死流的次数（只数 idle 类；网络类恢复不刷屏）。缺省 0 = 老调用
  // 方字节不变。
  if (idleReconnects > 0) parts.push(`断流重连 ${idleReconnects} 次`);
  // ω99-320：softIdleWarns > 0 追加「等待较久 N 次」——本 run 所有流的软
  // 警告之和（慢≠断：与「断流重连」同一行分开看，网络健康一眼分清）。
  // 缺省 0 = 老调用方字节不变（omit-when-zero）。
  if (softIdleWarns > 0) parts.push(`等待较久 ${softIdleWarns} 次`);
  // 借鉴弧 B1（a reference project C1）：cacheDebtTokens > 0 追加「缓存债 ~N」——本
  // run 最近一次压缩立账、尚未被归档节省摊掉的前缀重建溢价（token 记
  // 账；回执之后的逐请求偿还在事件流里静默递减，这里如实显示最近回执
  // 值）。缺省 0 = 老调用方字节不变（omit-when-zero）。
  if (cacheDebtTokens > 0) {
    const debt = cacheDebtTokens >= 1000 ? `${Math.round(cacheDebtTokens / 100) / 10}k` : String(Math.round(cacheDebtTokens));
    parts.push(`缓存债 ${debt}`);
  }
  return parts.join(" · ");
}

/** ω99-320: the first soft-idle warn's gentle live notice — 收益语、不吓人
 * （90s 静默是推理模型的合法状态：先告知「还在等」，不动连接）。同一 run
 * 只发一次（后续软警告静默计数）。 */
export const SOFT_IDLE_WARN_NOTICE = "（等了好一会儿还没收到数据——多半是网络慢，仍在继续等）";

