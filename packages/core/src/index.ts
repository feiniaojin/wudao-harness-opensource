// @wudao/core — agent harness runtime.
// Public API surface for M1. Subsystems (hooks, events bus, context compiler,
// session, providers) are added in later milestones and re-exported here.

export { runAgentLoop, STOP_BLOCK_CAP, PERSIST_FAILED_TOOL_RESULT, isZeroOutputOverflow, TURN_RECOVERY_NOTE, MAX_TURN_RECOVERY_ATTEMPTS, classifyTurnRetryError } from "./loop.js";
// 借鉴弧 δ（penguin-harness 367ab084 思想）— 运行中工具调用转后台。
export { BACKGROUNDED_TOOL_RESULT, formatDetachedResultInjection, DETACH_LANDING_NOTICE_PREFIX, createToolDetachHub } from "./detach.js";
export type { ToolDetachPort, ToolDetachHub, DetachedCall } from "./detach.js";
export type { TurnRetryClass, RecoveryLeg } from "./loop.js";
export type { LoopEvent, LoopOptions, PermissionDecision, AgentHooks, LoopGates, StopHookDecision, SessionStartSource, NotificationKind, PostToolBatchCall, PostToolBatchDecision, PreCompactDecision, TaskHookDecision, SubagentStopDecision, TeammateIdleDecision, ConfigChangePosition, ConfigChangeDecision, InstructionsLoadedSource, SessionEndSource, StopFailureKind, PreToolUseDecision, StreamPreemptChannel } from "./loop.js";
// M48 §1 — the loop-safety net: pure detectors (identical-call frequency
// dominance, same-tool failure streak, same-file same-old_string edit repeat,
// NO_ANSWER paraphrase runs) consumed by the loop at turn boundaries.
export {
  callFingerprint, canonicalJson,
} from "./loop-safety.js";

// 弧 C（research-import-2026-10，nanobot turn_continuation）— 预算切片续
// 跑：maxTurns 从 run 终点变为切片边界的判定/构造纯函数面（loop 接线见
// loop.ts；显示层用 isInternalContinuation 过滤内部续跑消息）。
export {
  shouldFinalizeOnLimit, lastStopReasonOf, internalContinuationMessage, isInternalContinuation,
  iterationLimitContextBlock, continuationMarkerEntry, CONTINUATION_SLICE_CAP,
} from "./turn-slicing.js";
export type { ContinuationMarkerEntry, FinalizeOnLimitInput, FinalizeOnLimitVerdict } from "./turn-slicing.js";

// ω-4b — the loop-safety reflection fork: ONE direct challenger model call
// at the run's second loop verdict (prefix-shared with the run's own
// requests; "recoverable" stays the abort once, everything else fails
// closed to today's abort).
export {
  parseReflectionVerdict, CHALLENGER_PREFIX,
  REFLECTION_DEFAULT_TIMEOUT_MS,
} from "./loop-reflection.js";

// 夜移 035 — turn phase timing (codex turn_timing.rs): opt-in six-bucket
// latency forensics for a run (see turn-profile.ts).
export { createTurnProfileRecorder } from "./turn-profile.js";
export type { TurnProfileRecorder } from "./turn-profile.js";
// 夜移 036 (codex rollout_budget.rs): the session-tree token budget — shared
// accounting across the root loop and every subagent, weighted units (cached
// input free), threshold reminders per {thread, window}, sticky exhaustion.
export { createSessionBudget } from "./session-budget.js";
export type { SessionBudget } from "./session-budget.js";

export { createScriptedModel } from "./model-client.js";
// 120-a A2 (CodeWhale #6540 形): the summary-call prefix-freeze contract —
// the pure comparator every summary/review-class call's test pins through.
export { summaryPrefixDrift } from "./model-client.js";
export type { PrefixFreezeContract } from "./model-client.js";
export type { ModelClient, ModelInput, ModelStreamEvent, ModelUsage, TerminalRepairKind } from "./model-client.js";
// M58 §A: the context-overflow duck type recognized at the ModelClient port
// (providers stamp it; the loop reacts — compact once, retry once).
export { isContextLengthError } from "./model-client.js";
// 113-B3: the account-quota park duck type at the same port (providers stamp
// it; the loop excludes it from ω99-9 recovery — the HOST parks the run).
export { isQuotaParkError } from "./model-client.js";
export type { QuotaParkErrorShape } from "./model-client.js";
// F1 (clip-conflict): the computed-cap/thinking-budget conflict duck type at
// the same port (providers stamp the code; the loop routes computed-cap
// conflicts into the reactive compact ladder — see model-client.ts).
export { MAX_TOKENS_THINKING_BUDGET_CONFLICT_CODE } from "./model-client.js";
// conflict-origin: the config-cap-conflict marker at the same port — the
// provider stamps it when the persistent config cap ALSO conflicts, and the
// loop skips the pre-doomed compact ladder on it.
export { hasConfigCapConflict, CONFIG_CAP_ALSO_CONFLICTS_FIELD } from "./model-client.js";

export { buildTool, validateToolArguments, toModelToolDefinition } from "./tool.js";
// M52 §3 — the model-visible context occupancy tool.
export { createCtxInspectTool } from "./tools/ctx-inspect.js";
// 125 项 2（codex get_context_remaining 形）— 上下文水位线查询工具（只读；
// 与 ctx_inspect 同缝的 occupancy + 项 1 预留感知触发线的查询面）。
export { createContextRemainingTool } from "./tools/context-remaining.js";
export type { ContextRemainingSnapshot } from "./tools/context-remaining.js";
// ω-2b (I3) — session paged tool-result recovery: the read-only paging tool
// + the pure paging/ref helpers the compaction markers embed.
export {
  createSessionResultTool, toolResultRef,
} from "./tools/session-result.js";
export type { SessionResultLoader } from "./tools/session-result.js";
// 121 挖掘 TOP5 #1 — the model-side retrieval surface over COMPACTED history:
// the read-only keyword search over the session's conversation ledger (user/
// assistant text + assistant reasoning), plus the pure search the CLI corpus
// builder feeds (scope all/recent over the compaction boundary).
export {
  createSearchHistoryTool, searchHistory, historySearchSnippet,
  SEARCH_HISTORY_LIMIT_DEFAULT, SEARCH_HISTORY_LIMIT_MAX, SEARCH_HISTORY_SNIPPET_CONTEXT,
} from "./tools/search-history.js";
export type {
  HistorySearchLoader, HistorySearchCorpus, HistorySearchEntry, HistorySearchHit,
} from "./tools/search-history.js";
// 121 §1 续章 — the model-side PROACTIVE-SAVE surface over long-task
// knowledge: note_write + note_read over plain markdown files under
// <workspace>/.wudao/notes/<sessionId>/ (append-only, tag-indexed, 按需读取
// — the files never enter model context by themselves), plus the pure
// naming/parsing/listing helpers the tests and the CLI mount share.
export {
  createNotesTools,
  noteSlugOf, noteTimestampName, noteFileName, parseNoteFileName,
  noteFileBody, parseNoteBody, listNotes,
  NOTE_CONTENT_MAX_CHARS, NOTES_LIMIT_DEFAULT, NOTES_LIMIT_MAX,
  NOTES_READ_TOTAL_MAX_CHARS, NOTE_SLUG_MAX_CHARS,
} from "./tools/notes.js";
export type { NotesToolOptions, NoteRecord, NoteListHeader } from "./tools/notes.js";
// 127 项 1（docs/research/127-cross-session-chaining.md）— the cross-session
// chain handoff tool: continue_task writes a baton file (plain markdown under
// .wudao/task-chain/<task_id>.md — 状态+指针, never a new JSON store) and
// schedules ONE at one-shot on the origin-resume lane through the daemon's
// add face (single-host law). Idempotent (one chain, one pending fire),
// capped (3 active chains per workspace), fail-closed on every door.
export {
  createContinueTaskTool,
  taskChainBatonDir, taskChainBatonPath, taskChainHeaderLine, parseTaskChainHeader,
  taskChainHistoryLine, parseTaskChainHistory, renderTaskChainBaton,
  continueTaskPrompt, continueTaskContextHint, continueTaskPromptMatch,
  TASK_CHAIN_ID_RE, HANDOFF_MAX_CHARS,
  CONTINUE_TASK_DEFAULT_DELAY_SECONDS, CONTINUE_TASK_MAX_DELAY_SECONDS,
  CONTINUE_TASK_ACTIVE_CHAIN_CAP, CONTINUE_TASK_CREATED_FROM,
} from "./tools/continue-task.js";
export type {
  ContinueTaskToolOptions, ContinueTaskScheduleFace, ContinueTaskScheduleInput,
  ContinueTaskPendingRow, TaskChainHeader, TaskChainBaton, TaskChainStatus,
} from "./tools/continue-task.js";
// 125 项 1（codex new_context 形）— the model-side context-rotation tool: the
// model asks for a fresh window (rationale + optional must-keep preserve);
// the loop's late-bound port fires the tier-2 rotation boundary inside the
// tool's execute (honest receipt + window number), and the per-session budget
// (≤ AGENT_ROTATION_CAP) rides the generic session lane's context_rotation
// entries — the GoalState budget family's counter twin.
export {
  createNewContextTool,
  NEW_CONTEXT_TOOL_NAME, AGENT_ROTATION_CAP,
  NEW_CONTEXT_RATIONALE_MAX_CHARS, NEW_CONTEXT_PRESERVE_MAX_CHARS,
  CONTEXT_ROTATION_ENTRY_TYPE, buildContextRotationEntry, parseContextRotationData, countContextRotations,
  validateNewContextArgs, newContextReceipt, newContextRefusal,
} from "./tools/new-context.js";
export type {
  AgentRotationRequest, AgentRotationOutcome, AgentRotationRefusalCode,
  NewContextPort, NewContextPortBox, ContextRotationEntryData,
} from "./tools/new-context.js";
export type {
  Tool, ToolDef, ToolParameter, ToolParameterSchema,
  ToolUpdateFn, IdentifiedOutputDelta,
} from "./tool.js";

export { createReadFileTool, readTextWindow } from "./tools/read-file.js";
export { resolveWorkspacePath } from "./tools/workspace.js";

// M34 §1 — ask_user: the model asking the human one question mid-run. The
// tool is interaction-free; frontends inject the askUser seam (TUI inline
// numbered options, REPL/one-shot line prompt; absent → fail-closed error).
export { createAskUserTool, ASK_USER_TIMEOUT_MS } from "./tools/ask-user.js";
export type { AskUserOption } from "./tools/ask-user.js";
export { createWriteFileTool } from "./tools/write-file.js";
export { createEditTool } from "./tools/edit.js";
export { createShellTool, scrubChildEnv } from "./tools/shell.js";

// ω-4d — login-shell env snapshot (import-queue item 17): the pure half
// (rc-preamble capture scripts, NUL parser, env scrub, snapshot-wins merge).
// The spawn lives in the cli runtime (packages/cli/src/shell-snapshot.ts);
// core stays I/O-free and injectable-only.
export {
  loginShellKindFromPath,
  buildLoginShellCaptureScript,
  parseLoginShellEnvOutput,
  scrubChildEnvOf,
  LOGIN_SHELL_SNAPSHOT_MAX_BYTES,
  LOGIN_SHELL_SNAPSHOT_TIMEOUT_MS,
} from "./tools/shell-snapshot.js";

// ω99-46 — egress proxy policy + install (dsh startup mechanism + socks5
// first-class + typed attribution). The policy half is pure (object-literal
// testable); the install half owns undici's global dispatcher and is the ONLY
// place in the workspace allowed to call setGlobalDispatcher or construct a
// ProxyAgent/socks dispatcher (the tests/egress-regression-pin grep gate).
export {
  resolveEgressPolicy,
  findProxyEgressCause,
  ProxyEgressError,
} from "./net/egress-policy.js";
export type { EgressSettingsInput } from "./net/egress-policy.js";
export { installEgressProxy, applyEgressChildEnv } from "./net/egress.js";

// ω-4e — reviewer authorization evidence (the Guardian pattern, import-queue
// item 15): the bounded role-preserving root-conversation excerpt (classify
// via the frozen synthetic-marker registry → filter → last-8 → single-point
// truncation → per-line role-prefixed render), the terminal ask digest, and
// the queued ask-tier reviewer's ModelInput construction site (tools: [] —
// MCP isolation by construction; byte-stable system prompt).
export {
  classifyAuthzMessage,
  AUTHZ_SYNTHETIC_MARKERS,
  buildAuthzExcerpt,
  renderAuthzExcerpt,
  renderAskDigest,
} from "./authz-evidence.js";
export type { AuthzExcerpt, AskerInfo } from "./authz-evidence.js";

// M50 §1 — run_script: PTC (programmatic tool calling). The model writes a
// JS program batching its tool calls over a file-RPC channel in a sandboxed
// child; ONLY the program's stdout (≤50KB) enters the conversation. Every
// call() re-enters the permission gate per call (the caller injects its
// loop's canUseTool as `gate`, contextProbe precedent).
export { createRunScriptTool } from "./tools/run-script.js";

// 114 取证弧 — python_kernel: 持久 Python kernel（会话内跨调用的计算状态
// 车道）。file-RPC 协议复用 run_script（roles 互换：父写 cell-<n>.py，
// kernel exec 后回写 cell-<n>.json）；变量/imports 驻留；stdout 帽 +
// truncateSafe；idle 回收（缺省 15min，settings pythonKernel.idleTimeoutMs
// 可调）+ 孤儿保护（stdin-EOF 看护）+ 进程退出钩；工具带 stop() 面挂
// driver dispose。裸工厂（缺省帽/超时）即完整功能面；两个常量供 cli 的
// settings 默认值与 tmp-sweep 前缀做单一真值点（RunScriptOptions 同款：
// 类型走深路径，不进 barrel）。
export {
  createPythonKernelTool,
  PYTHON_KERNEL_DEFAULT_IDLE_TIMEOUT_MS,
  PYTHON_KERNEL_TMP_PREFIX,
} from "./tools/python-kernel.js";

// M46 §1 — write-verify feedback loop: post-write/edit syntax receipts
// (per-extension checker, feedback not veto; config injected via tool options).
export {
  verifyWrittenFile,
  MAX_NEW_DIAGNOSTICS_PER_FILE, MAX_NEW_DIAGNOSTICS_PER_TURN,
} from "./tools/write-verify.js";
export type { WriteVerifyConfig, WriteVerifyOutcome, DiagnosticsLayer } from "./tools/write-verify.js";

// M46 §2 — long-output head/tail shaping for shell (+ spill link).
export { DEFAULT_LONG_OUTPUT } from "./tools/long-output.js";
export type { LongOutputConfig } from "./tools/long-output.js";

export { DEFAULT_GENERIC_RESULT_CONFIG } from "./tools/generic-result.js";
export type { GenericResultShaping } from "./tools/generic-result.js";

// 借鉴弧 C1（SoL-Pi C3）— evidence-preserving log slimming: the verified
// cheap-tier first-read for oversized diagnostic logs. The seam is shell.ts's
// finish() (spill/M46 相邻处); every gate failure fails open to the exact
// pre-C1 bytes. Feature is opt-in at the wiring layer (default OFF).
export {
  DEFAULT_LOG_SLIMMING,
  LOG_SLIMMING_SYSTEM_PROMPT,
  isDiagnosticCommand,
  looksLikeSecret,
  hasFailureSignal,
  parseReceipt,
  verifyReceipt,
  renderReceipt,
  slimToolLog,
} from "./tools/log-slimming.js";
export type {
  LogSlimmingConfig,
  LogSlimmingPorts,
  ParsedReceipt,
  VerifiedEvidence,
  ReceiptProvenance,
  SlimOutcome,
} from "./tools/log-slimming.js";

// M37 §2 — file-history snapshots: every successful write_file/edit records
// the target's pre-write state under .wudao/history/<session>/ so /rewind can
// restore the workspace to before any step (reverse-order rollback).
export { createFileHistory } from "./tools/file-history.js";
// 夜移 032 (codex turn-diff): the per-run net file-change ledger — pure
// baseline/current aggregation (first write's pre-state vs last write's
// bytes) + the receipt preview line.
export { createTurnDiffTracker, formatTurnDiffPreview } from "./turn-diff.js";
export type { TurnDiffTracker, TurnDiffFile } from "./turn-diff.js";
export type { FileHistory, FileHistoryEntry } from "./tools/file-history.js";
export { createGlobTool, globToRegex } from "./tools/glob.js";
export { createGrepTool } from "./tools/grep.js";
// P0-2（96 队列 #2）共享输出帽 — glob/grep 之外的有界清单渲染（如 cli 的
// MCP resources 面）复用同一条截断纪律：整行截断 + 诚实的截断标记。
export { capOutputLines } from "./tools/output-caps.js";

// M59 — web tools. web_fetch is zero-config/always-on with the SSRF matrix
// inside; web_search exists only when the cli configured a provider. The
// guard/classifier/matcher helpers are exported so the permission layer and
// the tests share ONE definition of the rules.
export {
  createWebFetchTool, classifyAddress, domainMatchesAllowlist,
  WEB_FETCH_MAX_BYTES,
} from "./tools/web-fetch.js";
export type { WebFetchOptions, DnsLookup } from "./tools/web-fetch.js";
export {
  createWebSearchTool, parseSearchHits, formatSearchResults, capSearchOutput,
  endpointGuardReason, isIpLiteralHost,
  WEB_SEARCH_MAX_QUERY_CHARS,
} from "./tools/web-search.js";
export type { WebSearchConfig, WebSearchProvider } from "./tools/web-search.js";

// M32 §1 — per-session read-freshness table (read_file records; edit/write
// gate fail-closed; the external-change prober diffs against the snapshot).
export { createReadStateTable, hashContent, readStateEntry } from "./tools/read-state.js";
export type { ReadStateTable } from "./tools/read-state.js";

export type {
  AgentMessage, UserMessage, AssistantMessage, ToolResultMessage, ToolCall, ToolResult,
  Terminal, Continue,
} from "./types.js";

// M79 §1 — the attachment domain: durable ImageAttachmentRefs (the only
// image shape that persists or crosses a wire), the AttachmentStore port +
// file-backed implementation (workspace .wudao/attachments, fail-closed
// admission BEFORE any write), the offload planner, and the typed
// admission/capability errors.
export {
  createFileAttachmentStore,
  offloadRequestImages, base64EncodedLength, imageOffloadPlaceholder,
  isValidImageBlock,
  estimateImageTokens,
  DEFAULT_MAX_IMAGES, DEFAULT_MAX_REQUEST_IMAGE_BYTES,
  AttachmentAdmissionError, UnsupportedContentError,
  offloadRequestFiles,
  fileVisibleRelPath, isValidFileBlock,
  DEFAULT_MAX_FILES, DEFAULT_MAX_REQUEST_FILE_BYTES,
} from "./attachments.js";
export type {
  ImageAttachmentRef, ImageBlock, ImageSaveInput, AttachmentStore, AttachmentLimits,
  FileBlock, FileSaveInput, FileLimits,
} from "./attachments.js";

export type { AgentState } from "./state.js";
export { replaceSystemPrompt } from "./state.js";

// ω99-279: #2 — SESSION_ID_RE 随 store 既有 export 面放出（删除纯层的
// 形状门单一事实源，别本地抄正则；store.ts 本体零行为改动）。
export { createJsonlSessionStore, analyzeTornTail, SESSION_ID_RE } from "./session/store.js";
// ω99-54: the UUIDv7 session id factory + shape gate — time-sortable ids
// are what let store.list() order the v7 tier with a plain string sort
// (zero stat). The clock seam (createSessionIdFactory) pins milliseconds
// in tests; newSessionId is the per-process production singleton.
export { newSessionId } from "./session/id.js";
// ω99-47: the session file format gate — soft first-write marker (a
// wudao_meta generic entry) + refuse-to-write a newer format version +
// the skip-contract counter on the store. Exported constants, NOT config:
// no env var or settings surface ever moves the supported version.
export { isFormatMarker } from "./session/format-version.js";
// #48: the cross-process session RUN lease (hermes#4 turn-lease slice).
export { sessionLeaseBoxFor } from "./session/lease.js";
export type { SessionLeaseBox } from "./session/lease.js";
// 多 driver 并发弧 A — the multi-slot lease box (N concurrent lanes, each
// pinned to its own session id; explicit per-id release; per-lane views for
// the engine's no-arg release contract). Single-slot behavior unchanged.
export { createMultiSlotLeaseBox } from "./session/lease.js";
export type { MultiSlotSessionLeaseBox } from "./session/lease.js";
export type { SessionStore, SessionEntry, ModelChangeEntry, ThinkingLevelChangeEntry, ProviderChangeEntry, GenericSessionEntry } from "./session/store.js";
// ω99-249: #3 — the model-side GoalState — a budgeted goal object that stays
// alive across turns, riding the M35 §2 generic lane as `goal_state` rows
// (append-only; the derivation-from-mission wiring lives in the CLI).
export {
  GOAL_STATE_ENTRY_TYPE,
  GOAL_OBJECTIVE_MAX_CHARS,
  GOAL_TRANSITIONS,
  buildGoalStateEntry,
  parseGoalStateData,
  replayGoalStates,
  canTransitionGoal,
  isLiveGoalStatus,
  goalUsageDeltaOf,
  goalTokensTotal,
  goalRemainingTokens,
  GOAL_NEAR_BUDGET_FRACTION,
  goalNearBudgetRemaining,
  applyGoalSettlement,
  safePauseSuggestion,
  goalObjectiveOf,
  goalStatusLine,
  goalBudgetNote,
  goalQueryText,
  goalStatusLabel,
} from "./goal-state.js";
export type { GoalStatus, LiveGoalStatus, GoalTokensSplit, GoalStateData, GoalPauseSuggestionTask } from "./goal-state.js";
export { isValidAgentMessage, repairOrphanedToolCalls } from "./session/validate.js";
export { UNAVAILABLE_TOOL_RESULT } from "./session/validate.js";
// 借鉴弧 ζ1（Reasonix 蒸馏）——未决工具动作的崩溃事实面：稳定动作身份 +
// 未决记录尾注（riders 通道）+ 陈旧写拒绝门。合成结果常量外提的物理定义
// 点在 tool-result-synthetics.ts（loop.ts re-export 保持既有 import 面）。
export {
  TRUNCATED_TOOL_CALL_RESULT,
  ABORTED_UNKNOWN_TOOL_RESULT,
  ABORTED_NOT_STARTED_TOOL_RESULT,
  UNKNOWN_OUTCOME_TOOL_RESULTS,
} from "./tool-result-synthetics.js";
export {
  PENDING_ACTIONS_TAG,
  PENDING_ACTIONS_CAP,
  STALE_PENDING_WRITE_RESULT,
  canonicalArguments,
  argumentFingerprint,
  normalizePathArg,
  pendingActionLine,
  formatPendingActions,
  parsePendingActionsFromSummary,
  pendingLedgerOf,
  pendingActionsSection,
  createPendingWriteGate,
} from "./pending-actions.js";
export type { PendingWriteEntry, PendingWriteGate, WriteActionTool } from "./pending-actions.js";
// ω99-51: the session projection seam — defineProjection (pure domain unit)
// + createProjectionDriver (feed/reset/snapshot/subscribe, two Object.is
// gates) + the first registered unit, the todo fold (the plan-review board,
// byte-equal to the retired backscan). Constitution:
// docs/research/106-session-projection-constitution.md.
export { createProjectionDriver } from "./session/projection.js";
export { todoProjection } from "./session/todo-projection.js";
// M53 §1/§2: session branching — the pure tree algebra (uuid/parentUuid
// chains, /tree rendering, /switch leaf listing) + the branch-summary digest.
// M53 review fix: active_branch session-entry reading + branch-aware resume.
export {
  nodeKey,
  chainForTurn,
  renderBranchTree,
  listBranchLeaves,
  commonPrefixLength,
  forkPredatesCompaction,
  branchSummaryNote,
  ACTIVE_BRANCH_ENTRY_TYPE,
  activeBranchLeafKey,
  resumeChain,
} from "./session/branch.js";
export type { ActiveBranchData } from "./session/branch.js";

export {
  estimateTokens, microcompact, COMPACTION_STUB_PREFIX,
  // M76-ux2 §8 — the per-section split behind the ctx hover (ctxInfo op).
  estimateTokensBreakdown,
  summarizeSpan, tier2Compact, applySummaryMarkers, SUMMARY_MARKER,
  SUMMARY_END_MARKER,
  staticTier2Compact,
  // 波次 7 #38 (OH C2) — zero-LLM digest front stage of tier-2.
  digestibleSpan,
  // M48 §3 — ghost-skill markers: canonical pruned-skill replacement text.
  SKILL_PRUNED_PREFIX, formatSkillPrunedMarker, parseSkillPrunedMarker,
  // M58 §C#11 — hybrid skill reinjection: the most recent distinct invoked
  // skill's body comes back (head-capped) at the compact boundary.
  SKILL_REINJECTED_PREFIX,
  // M58 §C#3 — the compaction thrash breaker's typed failure.
  CompactionThrashError,
  clearTier, CLEARED_MARKER,
  // ω-2b (I2-a) — per-tool retention targeting on the cheap tiers.
  matchesRetention, compactionRetentionFor,
  // ω-2b (I2-b) — the emergency truncate tier (reactive-corner only).
  emergencyDrop, EMERGENCY_DROP_PREFIX,
  // M52 §1 — compaction correctness: shared aligned cutoff, dual merged
  // summary, chained spans, manual compact, occupancy breakdown.
  alignedCutoff, dualSummaryPartition, manualCompact,
  messageEntryId, occupancyBreakdown,
  // ω-3b — the unseen-tool-result stub floor: the last-assistant index no
  // routine tier may stub/clear/summarize past, and the clamped boundary
  // (min with the M52 walk) the four routine seams share.
  stubFloor, floorCutoff,
  // 夜移 030 — the file-operations ledger riding tier-2 summaries (pi):
  // mechanical extraction + cross-compaction re-parse + capped tag blocks.
  extractFileOps, parseFileOpsFromSummary, mergeFileOps, formatFileOperations,
  FILE_LEDGER_READ_TAG, FILE_LEDGER_MODIFIED_TAG, FILE_LEDGER_CAP,
  // 125 项 2 — the cumulative changed-file set behind a chain (the
  // WorldState snapshot's changedFiles source).
  cumulativeModifiedFiles,
  // 波次 7 #39 (OH B1) — the verified-work carryover + plan-mode restatement.
  formatVerifiedWork,
  // 113-B1（prime-agent #2385 形）— the kept-tail recency anchor riding the
  // tier-2 summary instruction + the summary message's authority line.
  recencyAnchorOf, summaryAuthorityLine, SUMMARY_AUTHORITY_LINE, RECENCY_ANCHOR_CAP_CHARS,
  // 125 项 1/项 2（codex 窗口链/WorldState）— the rotation identity chain +
  // the world-diff pure functions riding tier-2 summary headers.
  windowIdentityLine, windowIdentitySection, windowId,
  worldStateDiff, worldDiffSection, WORLD_DIFF_CAP_CHARS,
  activeToolsOf, ACTIVE_TOOLS_CAP, parseWorldStateData,
} from "./compaction.js";
export type { OccupancyBreakdown } from "./compaction.js";
export type { WindowIdentity, WorldState } from "./window-chain.js";
// 借鉴弧 B1/B2（SoL-Pi C1/C2）— 压缩经济学决策层的类型面 + 缺省 ratio 常量
//（providers 的推导链与 core 的 tracker 共用同一缺省——单一真值点）。其余
// 运行面（tracker/常量）走 compaction.ts 域门面与 core 内部直连，不进 barrel
//（ω99-96 钉的面纪律：表面增长要可辩护——外部消费者只需要事件与配置的
// 类型）。
export { DEFAULT_CACHE_WRITE_READ_RATIO } from "./compaction-economics.js";
export type {
  CachePricing, CacheRatioSource, CompactionEconomicsDecision,
  CompactionEconomicsReason, CompactionEconomicsReport, EconomicsDecideInput,
} from "./compaction-economics.js";
// 125 项 1（dsh resolveCompactSpec 形）— 预留感知触发线的单一真值点：loop 的
// effectiveThreshold 与 CLI 的 context_remaining 工具/装配缝共用；常量是
// misc-config 家族 compaction.thresholdRatio/headroomTokens 的缺省锚。
export {
  resolveCompactionThresholdTokens, resolveOutputReserveTokens,
  DEFAULT_COMPACTION_THRESHOLD_RATIO, DEFAULT_COMPACTION_HEADROOM_TOKENS,
  COMPACTION_THRESHOLD_FLOOR_TOKENS,
} from "./compaction-threshold.js";
export type { CompactionThresholdSpec, CompactionWindowMode } from "./compaction-threshold.js";
// 调研引入弧 B（2026-10 spec research-import）：缓存感知压缩调度的纯函数
// 面——B1 前缀指纹信任门（usagePrefixFingerprint/shouldTrustUsage/
// thresholdDecision）、B2 触发耦合 cache-clock（compactionOpportunity）、
// B3 未读大结果降级（degradePendingReads）。cli 的空闲 autocompact 触发点
// 消费 B2；表面增长声明：+9 值（函数 6 + 常量 3）+ 4 类型。
export {
  usagePrefixFingerprint, shouldTrustUsage, thresholdDecision, compactionOpportunity,
  degradePendingReads, formatPendingReadDowngrade,
  DEFAULT_CACHE_DYING_SOFT_RATIO, PENDING_READ_DOWNGRADE_PREFIX, DEFAULT_PENDING_READ_TOOL_NAMES,
} from "./compaction-usage.js";
export type {
  UsageEvidence, ThresholdDecision, CompactionOpportunityDecision, PendingReadDowngrade,
} from "./compaction-usage.js";

export { runSubagent, BUILTIN_SUBAGENT_TYPES } from "./subagent.js";
export type {
  ForkContext,
  ChildSessionOptions, ParentMailSink,
} from "./subagent.js";
// 124b 项 1（codex instant_interrupt）——流抢占通道（loop 的 streamPreempt
// 选项面；驱动侧 request() 即时中断在飞模型流）。loop.ts 已 re-export 类
// 型；这里补工厂的公共面。
export { createStreamPreemptChannel } from "./stream-preempt.js";

// ω99-57 — child→parent mail: the global message_parent tool + the ambient
// scope runSubagent enters for attributed children (the model-visible face is
// identical for parent and child; the sender is runtime-derived).
export {
  createParentMessageTool, formatMailText,
  PARENT_MESSAGE_TOOL_NAME, MAIL_CONTENT_MAX_CHARS, MAIL_NO_EDGE_ERROR,
} from "./agents/mail.js";

// ω99-60 — parent→child steer: the global message_child tool (registry-bound
// at the tools-assembly site; the attribution is composed by the registry,
// never by the model) + the per-child mailbox face the registry owns.
export {
  createMessageChildTool, createSteerMailbox, formatSteerText,
  CHILD_MESSAGE_TOOL_NAME, STEER_FROM_PARENT_PREFIX, STEER_NO_EDGE_ERROR,
} from "./agents/steer.js";
export type { SteerRegistry } from "./agents/steer.js";

// ω99-66 — the message-plane constitution types (the six-dimension contract
// the three channels declare against; docs/research/107; the cap single-source
// rides the ω99-57 export above). Pure additive — conformance is test-side.
export {
  describeMessagePlane, checkMessagePlaneInvariants,
} from "./agents/message-plane.js";
export type {
  MessagePlane,
} from "./agents/message-plane.js";

// M30 §A — role roster: file-backed profiles layered over builtins.
export {
  BUILTIN_ROLES, loadRoleProfiles, toSubagentType, intersectToolNames,
} from "./agents/roster.js";
export type {
  AgentRoleProfile, ShadowedProfile, LoadedRoster, RosterPluginAgent,
} from "./agents/roster.js";

// M30 §B — background agent registry (engine-level mechanics).
export { createAgentRegistry } from "./agents/registry.js";
export type {
  AgentRegistry, AgentRegistryOptions, AgentSpawnSpec, AgentRunStatus, AgentStatusInfo,
  RegistryResult, AwaitSpec, SubsetSchema, ReportValidator,
} from "./agents/registry.js";
// 121 项 1 — AIMD rate-adaptive concurrency gate (the registry's optional
// live-admission face; in-memory by design, see the module head).
export { AimdGate } from "./agents/aimd.js";
export type { ConcurrencyGate, AimdGateOptions } from "./agents/aimd.js";

// M30 §D — per-child git worktree isolation (fail-open).
export { createChildWorktree, removeChildWorktree } from "./agents/worktree.js";
export type { ChildWorktree, WorktreeCleanup } from "./agents/worktree.js";

// M31 §1 — write-scope declarations (pure matching/narrowing/intersection).
export {
  isWriteScopeDeclaration, isWriteScopeEmpty, formatWriteScope,
  pathInWriteScope, narrowWriteScope,
} from "./agents/write-scope.js";
export type { WriteScopeDeclaration } from "./agents/write-scope.js";

// M30 §E — Runner/Middleware seam (library surface; CLI consumes later).
export { pipe } from "./runner.js";

export { createTaskTool, subagentDenialNotice, SUBAGENT_DENIAL_CONTRACT_PREFIX } from "./tools/task.js";

export { createTodoTool, TODO_BOARD_PREFIX, TODO_LINE_MARKS, parseTodoBoard } from "./tools/todo.js";
export { createCriticReviewTool, CRITIC_QUERY_SOURCE, parseCriticVerdict } from "./tools/critic-review.js";
export type { CriticBoardSnapshot, CriticGap, CriticReviewOptions } from "./tools/critic-review.js";
// 夜移 026: bounded, abort-aware temporal wait (Strands vended_tools/sleep).
export { createSleepTool, SLEEP_DEFAULT_MAX_SECONDS } from "./tools/sleep.js";
// 夜移 027: compaction-safe session scratchpad (Strands strands-ts notebook,
// disk-backed under .wudao/notebooks/).
export { createNotebookTool, NOTEBOOK_MAX_CHARS } from "./tools/notebook.js";

// M61 §1 — the in-session scheduler (vixie-cron subset, deterministic jitter,
// no-catch-up fire semantics, the .wudao/cron.json store, the tool trio).
export {
  parseCronExpr, cronMatches, nextCronTime,
  hashFraction, recurringLateJitterMs, oneshotEarlyJitterMs,
  nextScheduledTime, nextFire, isOneShotTask,
  newCronTaskId, cronDisabled, loadCronStore, createCronTools, formatScheduledInjection,
  CronStoreRefusedError,
  CRON_TASK_CAP_PER_SESSION, CRON_EXPIRY_MS,
} from "./scheduler.js";
export type {
  CronTask, CronTaskSchedule,
} from "./scheduler.js";

// ω-4a — the monitor watch over the steering channel: pure evaluator
// (keyword/lines/silence once-only latches + the terminal mapper), the
// injection-hardened formatter, the capped FIFO event queue, and the
// monitor_start/monitor_list/monitor_stop/monitor_read tool quartet
// (夜移 020 added the on-demand incremental read).
export {
  newMonitorId, monitorDisabled, initialWatchState, advanceWatch, endWatch,
  terminalEvent, formatMonitorInjection,
  createMonitorTools,
  EMPTY_MONITOR_QUEUE, monitorQueuePush, monitorQueueTake,
  MONITOR_DISABLE_ENV, MONITOR_MAX_WATCHES_PER_SESSION,
  MONITOR_TTL_DEFAULT_MS,
  MONITOR_RING_BYTES, MONITOR_INLINE_PAYLOAD_CHARS,
} from "./tools/monitor.js";
export type {
  MonitorWatch, MonitorEvent,
  MonitorTerminalReason, MonitorStartInput, MonitorRegistry, MonitorWatchState,
} from "./tools/monitor.js";

// ω99-318 — 审批面 Unicode 视觉欺骗防线：纯函数表（危险码点/同形折叠）+
// 帧载荷构造器。显形不拦截（无门语义）；码点表单一事实源在此，web/TUI
// 只随帧渲染，绝不复制表。
export {
  inspectText,
  inspectUrl,
  inspectToolInput,
  foldConfusables,
  URL_ARG_KEYS,
  formatSpoofLine,
} from "./unicode-security.js";
export type {
  UnicodeIssue,
  UnicodeIssueCategory,
  UrlInspection,
  UrlInspectionResult,
  SpoofInspection,
} from "./unicode-security.js";

// PB-1 — 探针基础设施：core 层探针总线 + 标准化遥测格式（五类 ProbeEvent /
// 环形缓冲 / 订阅面 / 统计面）。barrel 只放外部消费者需要的面：格式与总线
//（5 名）+ 总开关三件（PROBE_ENV/probeEnabled——boot 接线层的单一真值点，
// MONITOR_DISABLE_ENV 同款先例）+ probeModelClient（providers 工厂缝的挂载
// 点）。其余挂载件（probeTools/probeAgentLoop/startSystemProbes）由 core/
// providers 内部缝直接 import，不进 barrel——表面增长可辩护（ω99-96 纪律）。
export type { ProbeEvent, ProbeCategory, ProbeBus } from "./probe.js";
export type { ProbeBusStatsEntry } from "./probe.js";
export { createProbeBus, probeBus, probeEnabled, probeModelClient, probeModelRetry, PROBE_ENV } from "./probe.js";

// 113-A4 — UTF-16 代理对安全截断原语（全仓唯一文本截断入口，dsh 4ef97b92a9
// 引进裁决）。barrel 放出两件（头帽/尾帽）供 cli/slack/providers 收编位点
// 使用；core 内部经相对路径 import。表面增长声明：+2（truncateSafe/
// truncateTailSafe），barrel-surface 钉随本提交再生。
export { truncateSafe, truncateTailSafe } from "./text-truncate.js";

// 133 top1（deepagents 64dccb060 引进）— 冷缓存到期决策点的纯函数基座
// （时钟 + 身份 + 分类 + 重暖估价 + offer 门）。barrel 放出全件（cli 的
// 台账面与未来的桌面位同函数复用）；表面增长声明：+9 函数/常量、+5 类型，
// barrel-surface 钉随本提交再生。
export {
  cacheIdentityEqual,
  classifyCacheClock,
  estimateRewarm,
  coldCacheOffer,
  DEFAULT_CACHE_CLOCK_POLICY,
} from "./cache-clock.js";
export type {
  CacheIdentity,
  ColdReason,
  CacheConfidence,
  CacheClockPolicy,
  CacheClassification,
  RewarmEstimate,
  ColdCacheOffer,
} from "./cache-clock.js";

// 133 #4（ZCode collection-planner 引进，轻量形）— todo 板生成器治理四闸
// （frontier 帽/新完成门槛+首扩豁免/轮数帽/无增长熔断→显式封盘）。barrel
// 放出全件（goal 续跑缝与测试复用）；表面增长声明：+8 函数/常量、+4 类型。
export {
  TODO_GENERATOR_DEFAULT_POLICY,
  INITIAL_TODO_GENERATOR_STATE,
  censusFromBoard,
  checkTodoExpansion,
  settleExpansionRound,
  armExpansionRound,
  todoExpansionDirective,
  todoExhaustionNote,
} from "./todo-generator.js";
export type {
  TodoGeneratorPolicy,
  TodoBoardCensus,
  TodoGeneratorState,
  TodoExhaustionReason,
  TodoExpansionGate,
} from "./todo-generator.js";

// M-Memory 弧 — 长期记忆库（core 纯库）：per-root memory.jsonl（append-only
// + tombstone forget + 内容哈希去重即 useCount 强化 + 词面门槛检索 + 字节
// 稳定的 <long-term-memory> 注入渲染）。cli 层的装配（工具三件套 / boot
// 召回注入 / /memory 动词 / 会话终了沉淀）在 packages/cli/src/longterm-memory.ts。
// 表面增长声明：+4 函数/常量、+5 类型，barrel-surface 钉随本提交再生。
export { openMemoryStore, readMemoryFile, memoryId, MEMORY_KINDS } from "./memory.js";
export type { MemoryEntry, MemoryKind, MemoryStore, MemorySaveInput, MemorySearchOptions } from "./memory.js";

export const PACKAGE_NAME = "@wudao/core";
