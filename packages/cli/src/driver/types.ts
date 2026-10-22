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
export type HistoryEntry =
  /** M79b: user entries carry their turn's image refs (durable pointers, the
   *  same ImageBlock the submit took — never bytes; the web resolves them
   *  through attachmentGet). Optional: text-only turns and pre-M79 history
   *  omit it. ω99-55: `files` carries the turn's FileBlocks the same way
   *  (content-addressed pointers; the web renders name+size chips, the model
   *  sees only the request-build handle text). */
  | { kind: "user"; text: string; images?: readonly ImageBlock[]; files?: readonly FileBlock[] }
  | { kind: "assistant"; text: string; /** 0.3.8（用户反馈：think 过程要展示）：思考流。0.3.29（#302 分段）：多轮工具回合里每次模型调用的分段条目携带该调用窗口内的 reasoning 切片，落定条目只带最后一段——时间序与正文对齐。可选、append-only——只进 UI 历史，永不回写 state.messages（请求字节零变化）。 */ reasoning?: string; /** 0.3.15（用户需求：LLM 回复耗时展示）：本回合最后一次模型调用的 durationMs（usage 行携带，provider 实测墙钟——reasoning+正文全程）。可选、additive-only：脚本模型/未知网关不上报时缺省，老前端不受影响。 */ durationMs?: number; /** v7 γ3（Crush 0.93.1「Hyper 透明度」思想）：本轮实际服务模型回执——fallback 链换腿作答时该轮答案出自谁。usage 行的 fallbackModel/fallbackFrom 标注（M62 §7）驱动侧收拢到落定条目；omit-when-no-fallback（主模型作答=零噪音；与 provider 面板的「配置了什么」互补——这是「实际用了什么」）。可选、additive-only：只进 UI 历史与 settle 收据，永不进 state.messages/system prompt（M24 零影响）。 */ servedBy?: { readonly model: string; readonly from?: string } }
  | { kind: "tool"; name: string; summary: string; isError?: boolean; resultPreview?: string; /** ω-5b (I21): the per-call duration mirrored from the finished event (gate + execution). Absent on board-mapped results and pre-I21 history. */ durationMs?: number; /** ω99-125：交付物文件卡——make_xlsx/make_pptx/make_docx 收据的结构化一行由 driver 提取（名字门控，非通用嗅探；ω99-223 名单加 append_docx/append_pptx——门控住在 file-receipt.ts 的 FILE_RECEIPT_TOOLS 一处）；缺省=老历史/其他工具零变化。可选、append-only。 */ file?: { readonly path: string; readonly name: string; readonly bytes: number } }
  | { kind: "edit"; path: string; oldString: string; newString: string }
  // M23: a todo_write result renders as the checklist board (marks + counts).
  | { kind: "board"; done: number; total: number; lines: string[] }
  | { kind: "notice"; text: string; /** 0.3.7（0.3.6 反馈追修）：meta_note 全文（剥信封、保留换行）。可选、append-only——预览行截断/折叠丢信息时才携带，前端据此渲染展开。 */ detail?: string; /** 0.3.9（用户反馈：注入上下文不要系统消息样式）：meta_note 是模型可见的对话内容，置 true 时前端以回复卡形态（非居中胶囊）渲染。可选、append-only，老前端按胶囊渲染。 */ card?: boolean; /** 0.3.10（用户反馈：「系统注入」太笼统）：meta_note 的具体来源标注（如「SessionStart 钩子（startup）」「记忆召回」；同批多来源以「 + 」连接）。可选、append-only——老前端按「系统注入」回退渲染。 */ source?: string; /** ω99-216: #1（托付闭环·亲验改动）——回合净变更收据的轻摘要（相对路径/新建或修改/本轮写入次数），会话改动面板的聚合数据源。同 seam 同条件门落（netFiles 空则整条不落，维持现状）；before/after 全内容快照绝不入历史（detail 已有渲染后的 diff），「+M/−K 行」不结构化（不解析 diff 文本当数据）。可选、append-only——老历史/老前端零变化；只进 UI 历史永不进 state.messages 与 system prompt（M24 前缀缓存零影响）。 */ changes?: readonly { readonly path: string; readonly op: "created" | "modified"; readonly writes: number; /** ω99-288: #5 — 每文件 +M/−K 行数（settle 时从 diff hunk 数据层累计——216 裁定的演进说明：渲染层仍不当数据层，要数据走数据层；本弧在数据层补齐计数，分色只是排版）。可选、append-only——老历史缺省、老前端不读零变化。 */ readonly plus?: number; readonly minus?: number; /** ω99-314: 本轮开始前内容在快照仓里的指针（settle 时落 blob 成功才有；可恢复面的判据——改动面板据此渲染「恢复到这里」）。可选、append-only——老历史缺省、老前端不读零变化。 */ readonly beforeSha?: string; /** ω99-319: 命令级归因标记——该行的改动来自这条 shell 命令（命令原文的 200 字符帽截断），驱动 settle 时从 command_footprint 足迹 merge 进来（同 path 时 cmd 行 wins，op 用足迹 kind 映射；deleted 不进 changes——两态形状限制，完整记录走 command_footprint 条目）。收据门自本弧放宽：净足迹（shell 改动）非空也落——216 的「netFiles 空则整条不落」仅对无 shell 改动的轮继续成立。可选、append-only——老历史缺省、老前端不读零变化；只进 UI 历史永不进 state.messages 与 system prompt（M24 前缀缓存零影响）。 */ readonly cmd?: string }[] }
  // M25 contract: session-resume divider + non-message separators.
  | { kind: "divider"; text: string }
  | { kind: "error"; text: string };

export interface LiveState {
  reasoning: string;
  /** 0.3.8：reasoning 是否仍在流（reasoning_delta 置 true、assistant_delta
   * 置 false）——前端据此自动展开/收起思考块。可选：老客户端按收起渲染，
   * 行为与 0.3.7 一致。 */
  thinking?: boolean;
  answer: string;
  /** M45 §1.6: `gating` marks a busy tool whose sidecar check is in flight
   *  (the 🛡 检查中 badge source); it clears the moment the verdict lands.
   *  ω99-63 (additive-only): `callId` lands at tool_call_started (the one
   *  place the call's id is known) and `tail` carries the call's live-output
   *  bounded tail (append→append→snapshot-whole-replace, capped chars —
   *  never unbounded). */
  busyTools: { name: string; summary: string; gating?: boolean; callId?: string; tail?: string }[];
}

// Mode-rule gate layer: returns a final decision, or "ask" to surface the call
// to the human (decidePermission's tri-state). Same contract the TUI passes.
export type RuleGate = (
  toolName: string,
  input: Record<string, unknown>,
) => PermissionDecision | "ask" | Promise<PermissionDecision | "ask">;

/** A parked permission ask (driver-level asks only — when the frontend supplies
 *  `onPermissionAsk`, asks never park here). settingsFile/warning carry the
 *  same protected-file / git-risk decorations the TUI prompt renders;
 *  sidecar carries the M45 classifier reason when the ask is an escalation. */
export interface PendingPermission {
  readonly toolName: string;
  readonly summary: string;
  readonly input: Record<string, unknown>;
  readonly settingsFile?: string;
  readonly warning?: string;
  /** M45: the sidecar verdict reason / breaker state behind this ask — the
   *  prompt renders it as `🔑 (sidecar: <reason>)`. */
  readonly sidecar?: string;
  /** ω-4e: the asker digest lines when this ask is child-originated (who is
   *  asking + the latest genuine user instructions). Absent on top-level
   *  asks — the parked/web prompt then renders exactly as before. */
  readonly askDigest?: string;
  /** design 70: the advisory ask-reviewer's rendered line (child-originated
   *  risk-graded asks, feature armed, verdict landed) — rendered below the
   *  digest, above the warning/sidecar/question. Absent on every trigger
   *  miss and reviewer failure — the prompt then renders exactly as before.
   *  Informational only: the parked ask's decision semantics are unchanged. */
  readonly askReview?: string;
  /** ω99-318: the Unicode visual-spoofing inspection (zero-width / BiDi /
   *  homoglyph URL) computed at THIS seam — 源检验、边渲染: the core tables
   *  live in one place and the RESULT rides the frame (web renders badges
   *  without ever copying a codepoint table). Reveal-not-block: presence
   *  changes ZERO decision semantics — only what the human eye can see.
   *  Null (absent) on clean input — the frame then carries no new key. */
  readonly spoof?: SpoofInspection;
}

// M74-ide §1 — the file-panel data ops' payloads (PROTOCOL "fileTree" /
// "fileRead"; packages/web/src/protocol.ts hand-mirrors these shapes). They
// are DATA ops for the IDE panels, not agent tools: they never ride the
// permission pipeline — the handlers enforce workspace containment (the same
// resolveWorkspacePath as read_file) plus a sensitive-path list of their own.
/** One fileTree row. `size` is files-only; `hidden` marks dotfiles and the
 *  hidden list (.git, node_modules, .DS_Store, __pycache__, .env*, dist,
 *  target) — the CLIENT filters, the server just marks. */
export interface FileTreeEntry {
  readonly name: string;
  readonly type: "file" | "dir";
  readonly size?: number;
  readonly hidden?: boolean;
}

/** The fileTree reply: one directory level, dirs first alphabetically then
 *  files (code-unit order — locale compares vary by ICU). */
export interface FileTreeResult {
  readonly entries: readonly FileTreeEntry[];
}

/** The fileRead reply. `lines` is pre-truncation; `binary:true` means the
 *  content is intentionally "" (extension or NUL sniff) — absent otherwise. */
export interface FileReadResult {
  readonly content: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
  readonly lines: number;
  readonly language: string;
  readonly binary?: boolean;
}

/** 高亮/编辑 spec §3: the fileWrite result — written, or the conflict
 *  shape with the disk content's 100KB-capped prefix (nothing written). */
export type FileWriteResult = { readonly written: true } | { readonly conflict: true; readonly current: string };

/** ω99-314: fileRevert 的判决（PROTOCOL "fileRevert"）。ok:true 唯一成功形——
 *  stale:true = 守卫 3 的事实陈述（文件在快照之后被改过——回执/确认面明示，
 *  不拒）；false 四因：busy（活跃回合 409）/ evicted（快照已被清理）/
 *  bad-path（路径形状/逃逸/坏 sha）/ no-store（本 driver 无快照接线）。 */
export type FileRevertResult =
  | { readonly ok: true; readonly stale: boolean; readonly message: string }
  | { readonly ok: false; readonly reason: "busy" | "evicted" | "bad-path" | "no-store"; readonly message: string };

// ω99-258: #4 — 面一（branchLeaves/disarmEdit driver 方法）。
/** ω99-258: one switchable branch leaf — the web branch panel's row (the
 *  local mirror of core listBranchLeaves' BranchLeaf, which core does not
 *  export as a type; the fields are the M53 semantics verbatim). */
export interface BranchLeaf {
  /** 1-based switch index (file order of the leaf). */
  readonly n: number;
  readonly leafKey: string;
  /** The prompt of the turn where this branch diverges ("" for the trunk root). */
  readonly forkPreview: string;
  /** Total messages on the chain (turns + tool traffic). */
  readonly messageCount: number;
  /** True when this leaf's chain is the active chain. */
  readonly isCurrent: boolean;
}

/** ω99-260: #4 — 面一（memoryList/memoryDecide driver 方法）。one memory
 *  ledger row — the web memory faces' data (PROTOCOL "memoryList"). The
 *  store's own MemoryEntry VERBATIM (id/kind/content/scope/tags/created/
 *  hits/status/surfaced?/seq?/version? — the full field table; the WEB side
 *  keeps its own local mirror, the 258 BranchLeaf discipline). */
export type MemoryEntryMirror = MemoryEntry;

/** M76-ux2 §8 — the ctxInfo reply (PROTOCOL "ctxInfo"): the serialized
 *  prompt's per-section token estimates plus the free remainder against the
 *  context window. Same chars/4 accounting the ctx watermark uses
 *  (estimateTokensBreakdown over LIVE state), so the hover's parts can never
 *  disagree with the `ctx used/window` segment's occupancy measure. R5-I1:
 *  `imagesTokens` is the image estimate (0 when no message carries images). */
export interface CtxInfoResult {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messagesTokens: number;
  readonly imagesTokens: number;
  readonly availableTokens: number;
}

/** workspace-ux B1 — the panelRootSet reply (PROTOCOL "panelRootSet"): the
 *  root now in effect (identical to the argument on success — the caller's
 *  display source). */
export interface PanelRootSetResult {
  readonly root: string;
}

/** workspace-ux B1 — the agentRootStatus reply (PROTOCOL "agentRootStatus"):
 *  the dual-root snapshot. panelRoot is the file panel's VIEW root (moves
 *  only through panelRootSet); agentRoot is the session's workspace root
 *  (the tools' boundary — cwd when none was given). aligned is a plain
 *  string equality: true until a panelRootSet diverges them. */
export interface AgentRootStatusResult {
  readonly panelRoot: string;
  readonly agentRoot: string;
  readonly aligned: boolean;
}

/** workspace-ux B2 — the agentRootSwitch reply (PROTOCOL "agentRootSwitch"):
 *  `applied` = the switch landed NOW (idle); `queued` = a run was in flight,
 *  so it parks until the run's settle seam (the in-flight run keeps the OLD
 *  root throughout). Exactly one of the two is true. */
export interface AgentRootSwitchResult {
  readonly applied: boolean;
  readonly queued: boolean;
}

/** The status channel: a full, small snapshot rebuilt on every change. It must
 *  never contain the history (the history channel is append-only) — otherwise
 *  an assistant_delta per token would reship the whole transcript (O(n²)). */
export interface DriverStatus {
  readonly live: LiveState;
  readonly busy: boolean;
  /** Steering queue snapshot: submits while busy, drained before each model
   *  call (M18); a late steer auto-starts as a fresh run at run end. */
  readonly queued: readonly string[];
  /** M23: the last board's N/M; null before any board. */
  readonly boardProgress: { readonly done: number; readonly total: number } | null;
  /** M25 §A5: context watermark (occupancy vs window); null before the first
   *  model call of the session. M51 §4 (A8): `used` is null while the context
   *  is UNKNOWN — set when compaction rewrote the conversation and cleared
   *  only by the next REAL provider usage (the estimate would be a stale
   *  fiction over the rewritten history; the bar renders `ctx …/M`). */
  readonly ctxTokens: { readonly used: number | null; readonly window: number; readonly nearLimit: boolean } | null;
  /** M42 §3: the RUNTIME permission mode (shift+tab cycles it; the gate reads
   *  the live value at every tool call). */
  readonly mode: Mode;
  /** M24: session-cumulative cache hit percent (the resident `cache N%`
   *  segment); null before the first usage above the noise floor. */
  readonly cachePercent: number | null;
  /** M30: background-agent counts (active = queued|running, spawned = total). */
  readonly bg: { readonly active: number; readonly spawned: number };
  /** Driver-level parked permission ask (null when none / frontend-owned). */
  readonly pendingPermission: PendingPermission | null;
  /** M37 §1: the plan board awaiting review (null = none). `ok` executes it,
   *  `改 <意见>` re-runs plan mode; submit() routes both while this is set. */
  readonly planBoard: string | null;
  /** The conversation's current session id (rotates on loadHistory/resume). */
  readonly sessionId: string;
  /** M45: the sidecar's run state — classifier checks made this run and the
   *  breaker flag (the status-bar `sidecar N` / `🛡✕` segments). Null when
   *  this session has no sidecar (disabled, non-auto usage). */
  readonly sidecar: { readonly checks: number; readonly breakerOpen: boolean } | null;
  /** M57 §2: the model segment's data — the CURRENT identity (label +
   *  provider, from the live model state) and the switchable matrix (the
   *  structured form of the bare /model listing). Pure data: the web
   *  StatusBar renders it as the clickable model picker (click = submit
   *  `/model <name>`; M63 §A: cross-provider entries are clickable too and
   *  submit `/provider <name>`). Null when the frontend supplied no identity
   *  meta. */
  readonly model: {
    readonly label: string;
    readonly provider?: string;
    /** 推理档三级配置 S5: the session-effective effort (/effort's lane —
     *  modelLive's twin field; withSettingsOps overlays it onto
     *  settingsStatus.current.effort so the web's 强度 chip and its
     *  设为默认 footer follow mid-session picks). Absent when the session
     *  never picked and no boot meta carried one. */
    readonly effort?: string;
    readonly choices: readonly {
      readonly provider: string;
      readonly model: string;
      readonly source: string;
      /** Task 5: the choice's registered context window (when the registry
       *  catalogs one) — the UI's window placeholder. Absent = uncataloged
       *  (never 0 / null). */
      readonly contextLength?: number;
    }[];
  } | null;
  /** 推理档三级配置 S4: the session-effective language pair — the SAME fold
   *  the per-submit seam uses (gateStatus.language on the wire; the web's
   *  language chip renders it). */
  readonly language: { readonly reply: LanguageBlockMode; readonly reasoning: ReasoningLanguageMode };
  /** ω99-249: the live goal's face (objective + spent/budget + ledger
   *  progress) for the status strip; null when no goal is live (no
   *  budgeted mission task claimed) — old frontends ignore the field. */
  readonly goal: GoalWebSnapshot | null;
  /** ω99-253: the AGENT root's git branch (the workspace anchor's one
   *  property — which checkout the agent works in, one glance away).
   *  "HEAD" = a detached checkout shown honestly; null = non-repo / read
   *  failure / no workspaceRoot (the zero-render semantic — the chip and
   *  the TUI segment omit entirely, no placeholder). Cached: read once at
   *  boot and re-read at run-settle boundaries + agent-root switches,
   *  NEVER per status frame (emit does not spawn). */
  readonly gitBranch: string | null;
  /** ω99-255: #1 — the session's CURRENT name as the driver knows it: read
   *  once at boot/resume from the store (riding the existing receipt-replay
   *  load — zero extra file IO), set by the auto-title fork when its entry
   *  lands, and by /rename. The web sidebar bumps its refresh epoch when
   *  this CHANGES across frames — the auto-naming lane's missing trigger
   *  (onSessionRenamed stays the TUI lane). null = nameless / no store (a
   *  stub driver) / the pet lane (autoTitle:false never names). A pure
   *  cached read: buildStatus never touches the store. */
  readonly sessionName: string | null;
  /** ω99-268: #1 — the memory store's content signature (`count:pending:
   *  maxVersion` — the store's monotonic quantities projected over ONE
   *  load(); pending is the third term because confirm (decide-ok) moves
   *  NEITHER count NOR maxVersion — a two-term signature would miss a real
   *  write). NOT a display source (the list data rides the memoryList op
   *  unchanged) — it is a CHANGE SIGNAL: the web 管理记忆 panel and the boot
   *  待审卡 refetch when it CHANGES across frames. Knowledge lands at boot,
   *  run settle, and after each memory op closure (this process's own writes
   *  reflect immediately); between settles another window's write is an
   *  honest snapshot window (no polling). Absent = no workspaceRoot / the
   *  boot read not yet landed (zero signal — the field-omission face, 255's
   *  null discipline in optional form). A pure cached read: buildStatus
   *  never touches the store. */
  readonly memorySignature?: string;
  /** 113-B3: the quota-parked face — set when the last run ended PARKED
   *  (account-level 429 with a parsed reset moment; the driver scheduled a
   *  one-shot wake at reset+margin). Cleared when any run starts. Absent =
   *  not parked (old frontends ignore the field; omit-never-null). */
  readonly parked?: {
    readonly provider: string;
    /** ISO instant. */
    readonly resetAt: string;
    readonly attempt: number;
  };
}

/** SDD 2026-08-23 persona — the driver's persona seam (session-scoped). The
 *  frontend that owns persona state (the TUI/Web, mirroring what runRepl
 *  constructs for the readline REPL) injects the registry + runtime + the
 *  two live views the handler cannot know: `chain` re-reads the resolution
 *  chain sources at call time (env > binding > default — the /persona list
 *  provenance mark and --off's fallback walk it) and `wire` reports the
 *  protocol the LIVE wire speaks (the mismatch note checks the persona
 *  against it, not a hardcoded openai-chat). Absent → /persona answers with
 *  the degraded notice (back-compat: scripted tests, frontends without a
 *  persona surface). */
export interface DriverPersonaContext {
  readonly registry: PersonaRegistry;
  readonly runtime: PersonaRuntime;
  readonly chain: () => PersonaChainSources;
  readonly wire: () => ProtocolId;
  /** SDD 2026-08-23 persona Task 3: 清手动层（/persona 的会话内切换）——
   *  provider-switch 构造缝在链跟随之前调用。driver 在构造时把它装进
   *  context 对象（闭包私有 manual 标志；前端保持 context 对象身份稳定，
   *  setOptions 换入新对象时也会重装）。可选字段：脚本化测试可省略。 */
  clearManualLayer?: () => void;
}

export interface AgentDriverOptions {
  model: ModelClient;
  tools: Tool[];
  systemPrompt: string;
  canUseTool?: RuleGate;
  /** 125 项 1（the upstream projectnew_context 形）：模型侧轮转的端口盒——session-engine
   *  构造并传入，driver 把它接到 loop 的 contextRotation 端口。缺省=不接
   *  （new_context 工具 fail-absent，行为不变）。 */
  contextRotationBox?: import("@wudao/core").NewContextPortBox;
  /** 125 项 1：轮转事件的回调面——driver 在 compacted 事件的 trigger 为
   *  agent-rotation 时调用（session-engine 消费它落 context_rotation 条目）。 */
  onContextRotation?: (info: { window: number; rationale: string }) => void;
  /** ω99-320: the session's soft-warn slot (the SAME instance the frontend
   *  spread into every createProvider site as `onStreamIdleWarning:
   *  slot.forward`). The driver arms it at run start (count + first-warn
   *  notice) and clears it at the settle seam (a late callback lands
   *  nowhere, never in the next run). Absent (tests, unwired frontends) =
   *  zero behavior change — the provider's soft tier stays a pure no-op
   *  callback. Pure bypass: nothing here ever reaches ModelInput, the
   *  request bytes, state.messages or the system prompt (M24). */
  softWarnSlot?: SoftWarnSlot;
  /** ω99-248 — persist parked asks to the session JSONL's generic lane (the
   *  cross-restart recovery evidence; default true when a store/root exists).
   *  The pet lane passes false: its asks are lane-local (the lane's own card
   *  answers them; RECOVERY_EXCLUDED_SESSION_IDS keeps the lane out of
   *  recovery) and never enter the persistent face (车道隔离). */
  persistPermissionAsks?: boolean;
  maxTurns?: number;
  /** Seeds state.messages (resume): identities must match the caller's loaded
   *  history so identity-based persistence selection stays correct. */
  initialMessages?: AgentMessage[];
  /** Session id of the resumed history — heads the initial history as the
   *  `resumed <id8> · N messages` divider. A fresh id is generated otherwise. */
  sessionId?: string;
  /** 夜移 005 (the upstream formatsession-title): after the first successful run, upgrade the
   *  derived session name to an LLM title via one tiny background call
   *  (querySource "title", low reasoning, capped output — never in the main
   *  transcript, never touching prefix bytes). Tried once per driver
   *  lifetime; a manual /rename or existing llm title is respected.
   *  Requires workspaceRoot (the store is derived like recordActiveBranch).
   *  Absent = off (one-shot paths keep the M33 derived name). */
  autoTitle?: boolean;
  /** Forwarded to runAgentLoop (microcompact + tier-2 compaction thresholds). */
  compaction?: LoopOptions["compaction"];
  /** Forwarded to runAgentLoop — .wudao/settings.json-configured hooks (M19).
   *  M63-A: the same object now carries the session-surface events the DRIVER
   *  fires (onSessionStart/onNotification) and the permission pipeline
   *  consults (onPermissionRequest) — frontends thread one hook object. */
  hooks?: AgentHooks;
  /** M63-A: the SessionStart source at driver CREATION — explicit when the
   *  frontend knows it (--fork-session → "fork"); absent → derived from the
   *  seed (history present = "resume", empty = "startup"). Runtime boundaries
   *  (clear/resume/compact) fire their own sources regardless of this. */
  sessionStartSource?: SessionStartSource;
  /** P1-5 (96 队列): boot-time notices appended to history at construction
   *  (below the resume divider) — index.ts passes the workspace-trust
   *  suppression notice here when the gate is active. Absent = no boot
   *  notices (byte-stable for every existing caller/test). */
  bootNotices?: readonly string[];
  /** M63-B: the FileChanged watcher plan — literal filenames to watch, the
   *  hook-command fire seam, and how a change reaches the MODEL. The driver
   *  owns the watchers (started at creation, stopped at dispose) and pushes
   *  delivery through its own steering queue (turn-boundary append). */
  fileChangeWatch?: {
    readonly targets: readonly string[];
    readonly fire: (path: string) => void | Promise<void>;
    /** The steering text for a change; defaults to `[file_changed] <name>`. */
    readonly noteFor?: (path: string) => string;
  };
  /** M63-B: the skills-position ConfigChange consult — stat-polled by the
   *  driver (the settings positions ride the permission watcher instead).
   *  Blocking is advisory here (no reload consumer exists for skills). */
  configChangeSkills?: {
    readonly path: string;
    readonly decide: (position: "skills", path: string) => Promise<boolean> | boolean;
  };
  /** M63-C §3: the asyncRewake sink holder — the driver assigns the box's
   *  current to its SYSTEM steering lane, so a background hook's exit-2 wake
   *  reaches the next model call as a turn-boundary note (never auto-starts
   *  a run — the system lane's contract). */
  rewakeSink?: { current?: (message: string) => void };
  /** ω99-79: the session's subagent-delta box (the rewakeSink box shape — a
   *  single-slot object the caller owns). The driver ARMS box.sink at run
   *  start — one sink per run, the closure capturing THAT run's
   *  busyEntries/live, so every concurrent Task inside the run shares it
   *  (runs are strictly serial; the next run overwrites) — and CLEARS it at
   *  the run's finally seam (children have no tool_call_finished in the
   *  parent event stream: the run end is their only terminal, and a
   *  detached child's late deltas no-op on the cleared slot instead of
   *  writing phantom rows into the next run's live). Absent → no key, every
   *  existing run byte-identical. */
  subagentUpdateBox?: { sink?: (delta: IdentifiedOutputDelta) => void };
  /** ω99-86 (53 停泊债清偿): the session's live-effort box (the same
   *  single-slot shape). The driver ARMS box.get = () => modelLive.effort at
   *  run start — the getter reads the closure LATE, so a spawn INSIDE the
   *  run sees the level THIS run's requests carry (the run-start read, the
   *  same source as effortSent below) — and CLEARS it at the run's finally
   *  seam (79's discipline: an idle-period spawn after the run reads an
   *  unarmed slot and falls back to the session's own baseline — the
   *  documented degradation). The task tool guards undefined/""/"off" at the
   *  spawn site. Absent → no key, every existing run byte-identical. */
  effortLiveBox?: { get?: () => string | undefined };
  /** M63-C R1: the fire-runtime view (getMode/common/mcp/rewake) — the SAME
   *  boxes the session's configured hooks compiled with, so the
   *  skill-position overlay's compile is contract-complete (§2 common fields
   *  incl. prompt_id, `if` mode gating, mcp_tool entries, asyncRewake). */
  hookRuntime?: {
    readonly getMode?: () => string;
    readonly common?: () => Record<string, unknown>;
    readonly mcp?: import("../hooks-config.js").HookMcpSeam;
    readonly rewake?: (message: string) => void;
  };
  /** M63-C R1 (§2 prompt_id): a box the driver fills with a FRESH id per
   *  submitted prompt — every hook invocation of that run carries it in the
   *  common stdin fields. */
  promptIdBox?: { current?: string };
  // M63-C R1 follow-up: the LIVE session id box — the driver rotates the id
  // on clear/resume/fork, and hook payloads must carry the CURRENT id, not
  // the boot-time one (same contract as promptIdBox).
  sessionIdBox?: { current?: string };
  /** ω99-83: the session's mandatory-reasoning repair holder — the VERBATIM
   *  `{ current: boolean }` slot the frontend owns (repl.ts:861's literal
   *  shape). Write side: the frontend's model-construction point mounts the
   *  provider's onMandatoryRepairApplied onto it (repl.ts:946's twin — the
   *  driver constructs no model, so the FRONTEND bridges the seam). Read
   *  side: /status conditionally spreads it into formatStatusReport
   *  (commands/status.ts:69's form — the ω99-42 reasoning line surfaces only
   *  once the repair actually armed). In-process only, never persisted.
   *  Absent → no key, /status bytes identical. */
  mandatoryRepairArmed?: { current: boolean };
  // #48 (the upstream turn-lease slice): the cross-process session RUN lease.
  // Optional override for tests; the default is the memoized box for this
  // workspace's sessions root — every driver with a workspaceRoot is leased
  // with zero frontend wiring (read-only drivers without one run unleased).
  sessionLeases?: SessionLeaseBox;
  // R6-I1: the driver installs its appendHistory-notice sink here at
  // construction; index.ts's hook builds route warn()/systemMessage/
  // statusMessage through the box so hook output reaches the USER on every
  // frontend (not raw stderr).
  hookWarnSink?: { current?: (message: string) => void };
  /** workspace-ux B2: the switchable agent-root box, SHARED with the tool set
   *  (buildToolSet's agentRootBox — the builtin file tools and shell
   *  read the root through it at execution time) and, in production, with
   *  index.ts's hookWorkspaceRoot (the root hook payloads build their paths
   *  against). agentRootSwitch's apply point writes it; session-anchored
   *  seams (the store, spill, memory, settings writes) never read it. Absent
   *  → no external follower moves (the driver's own boundary points still
   *  switch). */
  agentRootBox?: { current: string };
  /** P1-7 (96 队列) — the /worktree switch's extension-rescan seam: what
   *  applyAgentRoot calls when a worktree enter/exit lands (the extension
   *  face follows the operation root, hard constraint 5). Default:
   *  extension-state's rescanExtensionsAt. Injectable so driver tests never
   *  touch the process's real extension runtime (the TrustRescanFn
   *  precedent). Absent external followers + absent seam → the default
   *  still rescans; a headless driver without an initialized runtime
   *  degrades to a fresh build at the new root (rescanExtensionsAt's own
   *  fallback — counts only, nothing to swap). */
  worktreeRescan?: (root: string) => Promise<{ readonly skills: number; readonly plugins: number; readonly hooks: number }>;
  /** ω99-253: the branch face's read seam (the TrustRescanFn injectable
   *  pattern) — what refreshGitBranch calls for the agent root's branch.
   *  Default: git-branch.ts's readGitBranch (one rev-parse spawn per read;
   *  never throws — null is the failure face). Injectable so driver tests
   *  script the read with ZERO real git in the test chain. Absent → the
   *  default; no workspaceRoot → the seam is never called at all. */
  gitBranchReader?: (cwd: string) => Promise<string | null>;
  /** M62 §1: forwarded to runAgentLoop — the path-gated context-rule matcher
   *  (built by createContextRuleMatcher; absent = no gated rules, zero cost). */
  contextRules?: LoopOptions["contextRules"];
  /** Forwarded to runAgentLoop — M23 long-task stop gates (todo/verify). */
  gates?: LoopOptions["gates"];
  /** Fired once when a run settles (complete, interrupted, or failed) with the
   *  final state.messages — the frontend persists the new tail from here. */
  onRunComplete?: (messages: readonly AgentMessage[]) => void;
  /** 夜移 017 (#31): fired synchronously at run start, right after the user's
   *  own turn lands in state.messages — BEFORE the first model call, and only
   *  for the real turn (the language/reasoning transient tails are model-
   *  facing projection that still persists at run-complete). The frontend
   *  appends this exact object to the session JSONL immediately, so a crash
   *  mid-run never loses the one un-regenerable message; identity-based
   *  selection then skips it at onRunComplete (no duplicate line). */
  onUserTurn?: (message: AgentMessage) => void;
  /** 波次 8 #45 (the upstream formatsession-checkpoint-policy): forwarded to runAgentLoop —
   *  the pre-dispatch durability barrier. Called once per tool-carrying turn
   *  (after the assistant(tool_use) lands, before gates/execution). The
   *  frontend makes the session record durable HERE (ordered-prefix append:
   *  user turn → each tool-carrying assistant + the still-unpersisted
   *  messages before it), so a crash mid-tool leaves a resumable trace:
   *  repairOrphanedToolCalls answers the durable unmatched call with the
   *  UNKNOWN-outcome text instead of the side effect vanishing untraceably.
   *  Rejection fails the batch closed inside the loop (nothing executes). */
  onBeforeToolDispatch?: LoopOptions["onBeforeToolDispatch"];
  /** M55 §C1: session store for recording added_dir entries. Optional — the driver
   *  works without it, just won't persist the entries. */
  sessionStore?: import("@wudao/core").SessionStore;
  /** Fired once when the AgentState is created, so the caller can hand the tool
   *  set's contextProbe / getForkContext closures a live reference. */
  onStateReady?: (state: AgentState) => void;
  /** Fired when tier-2 compaction freezes a summary marker — append it to the
   *  session JSONL immediately (append-only store stays authoritative). */
  onCompacted?: (summaryMessage: AgentMessage) => void;
  /** M52 §1: fired when a tier-2 compaction established a boundary — persist
   *  the compact_boundary session entry (appendEntry) so a resumed session's
   *  next compaction continues the chain from the recorded firstKeptEntryId.
   *  125 项 1/项 2: windowIndex (the rotation's window #) and worldState (the
   *  snapshot at the rotation) ride along as the entry's additive fields —
   *  absent on identity-less paths (pre-125 behavior). */
  onCompactBoundary?: (info: {
    readonly firstKeptEntryId: string;
    readonly reason: string;
    readonly tier: 0 | 1 | 2 | 3;
    readonly windowIndex?: number;
    readonly worldState?: import("@wudao/core").WorldState;
  }) => void;
  /** Fired when the run's one load_tools call applied (M35 §1/§2). */
  onDeferLoaded?: (names: readonly string[]) => void;
  /** ω-4b: fired when the loop-safety reflection fork settles at a run's
   *  second loop verdict — persist the loop_reflection session entry (the
   *  onDeferLoaded shape). Carries the adjudication outcome and, when the
   *  challenger call reported usage, its reflectionTokens-stamped row. */
  onLoopReflection?: (info: LoopReflectionEntryInfo) => void;
  /** cli log.ts summarizeToolCall. */
  summarize: (toolName: string, input: Record<string, unknown>) => string;
  /** When set, write_file calls diff against the current on-disk content
   *  (same containment rules as the real tool). Absent → preview behavior. */
  workspaceRoot?: string;
  /** M59 §3: the web doctor node (search provider state) — /doctor renders
   *  the web checks from it (routedSubmit is sync; the data rides in). */
  webDoctor?: import("../commands/doctor.js").WebDoctorInput;
  /** M32: the session's read-state table (the same instance the tool set
   *  uses). Present → each model call probes it for externally changed files
   *  and injects <file_changed> notes through the MetaNote channel. */
  readState?: ReadStateTable;
  /** 夜移 032 (the upstream projectturn-diff): the per-run net file-change ledger — the
   *  SAME instance the tool set records into. Reset at run start; the
   *  run-settle seam renders the receipt (preview text + full diff detail).
   *  Absent → no net-change notice, unchanged behavior. */
  turnDiff?: import("@wudao/core").TurnDiffTracker;
  /** 夜移 035 (the upstream projectturn_timing.rs): the run's phase recorder — threaded
   *  verbatim into the loop's options. Consumer-owned (created before the
   *  run; completed+read at the consumer's settle seam — complete is
   *  idempotent/memoized). Absent → the loop's hot path is untouched. */
  turnProfile?: import("@wudao/core").TurnProfileRecorder;
  /** 夜移 036 (the upstream projectrollout_budget.rs): the SESSION-tree token budget —
   *  one instance for the whole driver (root loop + every subagent share
   *  the accounting; subagents rebind the reminder threadId). Threaded as
   *  { budget, threadId: "root" }. Exhaustion ends runs through
   *  {reason:"session_budget_exhausted"} — sticky across later runs.
   *  Absent → unchanged behavior. */
  sessionBudget?: import("@wudao/core").SessionBudget;
  /** Frontend-owned permission ask (the TUI's PermissionPrompt). Present →
   *  asks route through it verbatim (zero TUI behavior change); absent → the
   *  ask parks as `status.pendingPermission` and `answerPermission` resolves
   *  it (the web/WS frontend's path). M45: the optional ctx carries the
   *  sidecar reason when the ask is a classifier escalation. */
  onPermissionAsk?: (
    toolName: string,
    summary: string,
    input: Record<string, unknown>,
    ctx?: { readonly sidecarReason?: string; readonly askDigest?: string; readonly askReview?: string; readonly spoof?: SpoofInspection },
  ) => Promise<AskAnswer>;
  /** 0.3.14 #1: the parked-ask answer's rule sink — called when a web
   *  session/always answer produces a rule (applyAskAnswer's own degradation
   *  already filtered protected writes). The owner records the session rule;
   *  `persist` additionally writes it into the project tier. Absent → scoped
   *  answers degrade to allow-once (the pre-0.3.14 web behavior). */
  onAskRule?: (rule: string, persist: boolean) => void;
  /** M42 §3: the initial runtime permission mode (argv-derived by callers). */
  mode?: Mode;
  /** M30: the session's background-agent registry (shared with the task tool).
   *  Present → its counts poll into `status.bg`. */
  agentsRegistry?: AgentRegistry;
  /** M43-A Task 3 — driver-executable slash commands. The loaded skills (the
   *  UNGATED list: /skill: routing is independent of the prompt-tail manifest,
   *  which the frontend builds with its own read-tool gate). */
  skills?: readonly LoadedSkill[];
  /** Registered plugin/extension command NAMES (parse routing only — their
   *  execution stays frontend-owned; the driver returns "frontend"). */
  pluginCommands?: readonly PluginCommand[];
  extensionCommands?: readonly { readonly name: string; readonly extension?: string }[];
  /** M37 §2: the session's file history (the SAME instance the tool set wires
   *  into write_file/edit) — drives the driver-level /rewind. */
  fileHistory?: FileHistory;
  /** ω99-314: 文件级时光机的快照仓——写前捕获（doc 写册的 onPreToolUse
   *  observer）+ settle 索引（file_snapshot 泛型条目随 217 收据批）+
   *  fileRevert（改动面板单文件恢复）的数据面。缺省 → 无快照、无索引、
   *  fileRevert typed 拒（旧行为边界）。 */
  snapshots?: SnapshotStore;
  /** Raw loop-event observation (debug/tools; the WS event channel). Fired for
   *  every LoopEvent before it is mapped to state. */
  onEvent?: (event: LoopEvent) => void;
  /** M45: the session's sidecar instance (the SAME one the frontend's gate
   *  layer classifies through). Present → its counters/breaker ride the
   *  status snapshot, and every run start resets its run state (§1.5 "run
   *  结束自然复位"). */
  sidecar?: Sidecar;
  /** M47 §2: the language transient block. "auto" (default; env
   *  WUDAO_LANGUAGE_BLOCK) appends the imperative `[language: respond in
   *  Chinese]` user message at the turn tail when the prompt is Chinese;
   *  "on" forces it; "off" disables. Pure append — no prefix bytes move. */
  languageBlock?: LanguageBlockMode;
  /** 夜移 012: the reasoning-language transient block — a second knob,
   *  separate from languageBlock. "auto" (default; env
   *  WUDAO_REASONING_LANGUAGE) rides the same Chinese detector and appends
   *  the imperative thinking-language directive at the turn tail; "zh"/"en"
   *  force; "off" disables (WUDAO_NO_LANGUAGE=1 ablates both blocks). */
  reasoningLanguage?: ReasoningLanguageMode;
  /** 推理档三级配置 S4: the session language tier's boot seed (per-knob
   *  optional — the session-engine folds settings>env here at boot; the
   *  driver re-folds env+session EVERY submit, so the WUDAO_NO_LANGUAGE
   *  ablation stays live and a mid-session settings write lands next boot).
   *  Both knobs optional: an unset knob falls through to the env leg. */
  languagePreference?: Partial<LanguagePreference>;
  /** M49 §1: bounded auto-recall at run start — returns the MetaNote payload
   *  for this prompt (undefined = nothing worth recalling). The note rides
   *  the run's FIRST model call through the MetaNote channel: the model sees
   *  it, the persisted conversation never gains a message. */
  memoryRecall?: (prompt: string) => string | undefined;
  /** M49 §2: after a successful run with ≥3 tool calls, spawn the background
   *  memory-review fork (shareContext, maxTurns 2, read tools + memory_write)
   *  through the session registry; the 🧠 receipt lands as a notice.
   *  Requires workspaceRoot + agentsRegistry; WUDAO_BG_REVIEW=off disables. */
  backgroundReview?: boolean;
  /** ω-5a I23: cold-cache pre-send consult — called at the top of every
   *  startRun (fresh prompts only, before the user message is pushed) with
   *  the current history length. A returned prediction appends the ❄️
   *  notice; the driver shows it AT MOST ONCE per session (the mute). The
   *  owner binds the identity (it knows the live provider config).
   *  Kill switch: --no-cold-cache-warning / WUDAO_NO_COLD_CACHE_WARNING. */
  coldCache?: {
    readonly preSend: (historyLength: number) => import("../cold-cache.js").ColdCachePrediction | undefined;
  };
  /** M53 §1: fired whenever the driver REPLACES the conversation wholesale
   *  (/switch branch swap, the routed /clear) — the frontend must reset its
   *  identity-based persistence base (loadedRef) or the next run would
   *  re-append the whole chain to the JSONL. */
  onHistoryReplaced?: (messages: readonly AgentMessage[], sessionId: string) => void;
  /** M80: fired when the ROUTED /clear (submit("/clear")) reset the
   *  conversation and rotated the session id — the frontend that owns the
   *  session store appends the clear_boundary entry to the PRE-clear id's
   *  JSONL (append-only: nothing is ever truncated; the marker documents
   *  where the conversation moved). The driver writes the same marker itself
   *  when it holds a sessionStore, so a frontend passes this only when its
   *  store is its own (the web session engine's arrangement). */
  onSessionCleared?: (info: { readonly fromSessionId: string; readonly toSessionId: string }) => void;
  /** M53 §3: identity meta the driver cannot know (model label, provider
   *  name, session name, CLI version) — snapshotForStatusline() folds it
   *  with the live status into the contract shape. M56 §1: `keys` adds the
   *  provider's key pool (the `keys n/m` segment; /status renders it too). */
  statusline?: {
    readonly model: string;
    readonly provider?: string;
    readonly sessionName?: string;
    readonly version: string;
    readonly keys?: { readonly snapshot: () => { readonly total: number; readonly available: number; readonly cooling: number } };
  };
  /** M56 §3: the session's cost registry. Present → /cost renders the `$`
   *  line (priced turns) and the unpriced-model note. The FRONTEND records
   *  rows (it owns the model identity); the driver only reads the summary. */
  costRegistry?: import("../commands/cost.js").CostRegistry;
  /** M55 §A2: display labels for the driver's /status one-pager (provider +
   *  model). The driver never knows the provider config; the frontend that
   *  built the model supplies the labels. Absent → "(unknown)". M55 §B7:
   *  `effort` joins the labels (the /effort current marker; /status renders
   *  it when set). */
  sessionMeta?: { readonly provider?: string; readonly model?: string; readonly effort?: string };
  /** M55 §A4: fired after a successful /rename so the frontend can refresh
   *  its session-name display (the TUI header; the /resume picker reads the
   *  store live and needs nothing). */
  onSessionRenamed?: (name: string) => void;
  /** M55 §B7: the switchable model list for /model (profile matrix + env).
   *  Absent → the module re-derives it from process.env (the same source
   *  resolveProviderConfig reads). */
  availableModels?: readonly ModelChoice[];
  /** M55 §B7: a /model or /effort switch landed (idle: applied now; while a
   *  run is in flight: applied at run settle). The frontend applies the
   *  selection to its LIVE provider config — the provider reads its config
   *  fields at request time, so the mutation is the switch: no client
   *  rebuild, cache stats and tool closures stay valid. This is also the
   *  header/statusline refresh hook. */
  onModelSwitch?: (selection: ModelSelection) => void;
  /** M63 §A: the provider-switch seam — the frontend owns provider
   *  construction. `resolve` derives the target config PURELY (no mutation: a
   *  switch parked behind a busy run must not touch the live provider that
   *  run is still using; errors refuse the switch up front, naming the fix).
   *  `build` constructs the replacement ModelClient and is called only at the
   *  apply point — idle now, or the parked switch landing at run settle — so
   *  every request of a run stays provider-consistent. Absent → /provider
   *  answers "unavailable" (frontends without a provider construction seam,
   *  e.g. scripted-model tests).
   *  M63 §C: `isPlaceholderLive` marks the wizard boot's placeholder config
   *  (apiKey = WIZARD_PLACEHOLDER_KEY). While it reports true, a same-name
   *  /provider is NOT the no-op it otherwise is (the session is not really
   *  ON that provider — no key has ever authenticated) and a prompt run is
   *  refused with the wizard pointer instead of surfacing a raw 401.
   *  0.3.32c kimi-401: `keyRefreshPending` marks the second same-name leg —
   *  the credentials file now holds a key the live pool does not (the
   *  settings page just saved it; the pool may be the T0 cross-provider
   *  fallback's mislabeled borrow). While either predicate is true, a
   *  same-name /provider re-resolves instead of the no-op. The seams must
   *  also pass a credentials snapshot on EVERY resolve — see
   *  resolveProviderSwitch's 0.3.32c note. */
  onProviderSwitch?: {
    readonly resolve: (target: string) => import("../commands/provider.js").ProviderSwitchResult;
    readonly build: (config: import("@wudao/providers").ProviderConfig) => ModelClient;
    readonly isPlaceholderLive?: () => boolean;
    readonly keyRefreshPending?: () => boolean;
    /** 2026-08-31 config-drift: a fresh resolve of the LIVE provider would
     * change the connection (endpoint/wire — the settings row save rewrote
     * the registry). While true, a same-name /provider re-resolves like the
     * key leg; see commands/provider.ts configRefreshPending. */
    readonly configRefreshPending?: () => boolean;
  };
  /** M55 §B12: the plugin agent layer for /agents (the roster's middle
   *  tier; the task tool loads the same list). */
  pluginAgents?: readonly RosterPluginAgent[];
  /** M61 §1: the session's scheduler runtime. Present → due scheduled tasks
   *  fire through the steering channel's LOW-priority lane (drained after
   *  the user queue, before every model call — between turns) and a pending
   *  fire auto-starts a run when the frontend is idle. Absent → no
   *  scheduling surface in this driver. */
  cron?: CronRuntime;
  /** M61 §2: the late-bound /loop controller box — the tool set's
   *  schedule_wakeup tool reads it; the driver fills it at creation. */
  loopBox?: { current?: LoopController };
  /** ω99-13b: the late-bound /goal controller box — the session engine's
   *  model wrapper reads it in onUsage to meter /goal --budget main-call
   *  tokens (repl/index wire the same seam on their own wrappers); the
   *  driver fills it when the controller is created below. */
  goalBox?: { current?: GoalController };
  /** ω99-19: the late-bound mission controller box — the /mission slash face
   *  below reads it at submit time; the session engine fills it at its tail
   *  (the SAME box the mission_* tool set reads — one ledger, two faces:
   *  user slash and model tool). Absent or unfilled → the loud pointer. */
  missionBox?: { current?: MissionController };
  /** ω99-249: the late-bound GoalState runtime box — the tool set's `goal`
   *  query tool reads it (buildToolSet's goalFace); the driver fills it with
   *  the runtime it creates below (goalBox's fill discipline). */
  goalRuntimeBox?: { current?: GoalRuntime };
  /** M61 §3: present → the driver runs its own /goal controller at the
   *  run-stop hook position (composed AFTER any user-configured stop hook).
   *  Absent → no /goal surface (tests, stub frontends). */
  goal?: boolean;
  /** M61 §4: the durable scheduling daemon (the `wudao ui` host passes its
   *  daemon here so /schedule routes to it; /doctor renders its line). */
  schedule?: ScheduleDaemon;
  /** M64-A §A: the session's peer-messaging runtime. Present → accepted
   *  inbound peer messages ride the steering channel's LOW-priority lane
   *  (after the user queue and the cron lane — same track as M61 scheduled
   *  work), a pending delivery auto-starts a run when the frontend is idle
   *  (空闲即新开 turn), the runtime's approval sink is bound to this driver's
   *  ask seam (the hold dialog shows sender + preview; dialogExpiry discards),
   *  and dispose stops the runtime (socket down, registry entry removed). */
  peer?: import("../peer/runtime.js").PeerRuntime;
  /** ω-4a: the session's monitor runtime. Present → watch events ride the
   *  steering channel's LOW-priority lane (after the user queue, cron, and
   *  peer — drained before every model call, so an event never interleaves a
   *  tool_use with its result), a pending event auto-starts a run when the
   *  frontend is idle (空闲即新开 turn), and dispose stops the runtime
   *  (children reaped, watchers closed). Run-level abort (Esc) does NOT touch
   *  watches — they are session-scoped; queued events drain at the next run's
   *  boundaries or auto-start one. */
  monitor?: MonitorRuntime;
  /** ω99-57: the parent-side child-mail lane. Present → child→parent
   *  messages (a subagent's mid-run message_parent send, formatted with the
   *  child's runtime-derived identity) ride the steering channel's
   *  LOW-priority lane BETWEEN peer and monitor (T0-2 ordering: user → cron
   *  → peer → child mail → monitor → system) — drained before every model
   *  call, at the run settle seam after peer, and a pending message
   *  auto-starts a run when the frontend is idle (空闲即新开 turn, the same
   *  wake the peer lane has). Absent → nothing drains or wakes (the lane
   *  itself lives in the task tool's wiring; frontends pass the SAME
   *  instance to both). */
  childMail?: import("../agents/child-mail.js").ChildMailLane;
  /** SDD 2026-08-23 persona: the /persona seam (registry + runtime + the
   *  chain/wire live views — see DriverPersonaContext). Present → /persona
   *  lists with provenance marks and switches the manual layer with the
   *  persona_change entry (reason "manual"/"off"); absent → the degraded
   *  notice. */
  persona?: DriverPersonaContext;
  /** M61 §3: test seam — an explicit evaluator (scripted models) instead of
   *  the matrix-cheap resolution over process.env. */
  evaluatorOverride?: import("../goal.js").EvaluatorModel;
}
