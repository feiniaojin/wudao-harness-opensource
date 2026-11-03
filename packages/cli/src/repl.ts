import { truncateSafe } from "@wudao-org/core"; // 113-A4
import { join, relative } from "node:path";
import * as readline from "node:readline/promises";
import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { randomUUID } from "node:crypto";
// ω99-35: the headless (non-TTY) input batcher — the non-TTY rl wiring's
// bracketed-paste equivalent (blank-line terminator + idle window).
import { createHeadlessLineBatcher } from "./headless-batch.js";
import { runAgentLoop, createJsonlSessionStore, createTaskTool, createAskUserTool, createCronTools, createMonitorTools, repairOrphanedToolCalls, manualCompact, compactionRetentionFor, resolveWorkspacePath, toModelToolDefinition, nodeKey, renderBranchTree, replaceSystemPrompt, newSessionId, type AgentHooks, type AgentMessage, type AgentState, type LoopEvent, type LoopGates, type ModelClient, type ReadStateTable } from "@wudao-org/core";
import { buildContextReport, formatContextReport } from "./context-report.js";
import { formatProbeReport, parseProbeArgs, getDefaultProbeBus } from "./probe.js";
import type { ProviderConfig, ProtocolId, ResolvedPersona } from "@wudao-org/providers";
import { createProvider, createLiveKeyPool, loadPersonaRegistry, createPersonaRuntime, withPersona, applyWirePersona } from "@wudao-org/providers";
import { createFileAttachmentStore } from "@wudao-org/core";
import { CostRegistry } from "./commands/cost.js";
import { parseLogLevel, summarizeToolCall, truncate, truncateMultiline, formatCompactedLine, modelLabel, LEVEL_ORDER, RESULT_PREVIEW_CHARS, type LogLevel } from "./log.js";
import { renderTurnDiff } from "./turn-diff-render.js";
import type { PermissionDecision } from "@wudao-org/core";
import { decideRichPermission, modeFromArgv, modeLabel, cycleMode, parseAskAnswer, createSessionAllowlist, createPermissionSettingsWatcher, applyAskAnswer, recordAskRules, protectedSettingsFile, withSidecarLayer, livePermissionRequestHook, toolMetaResolverFor, immuneAskCeiling } from "./permission.js";
import { SESSION_END_BUDGET_MS } from "./hooks-config.js";
import { composeReflectHooks, reflectRuntimeFor } from "./reflect-config.js";
import { resolveGenericShapingRuntime } from "./output-config.js";
import type { SidecarEscalation } from "./permission.js";
import type { Sidecar } from "./sidecar.js";
import type { Mode } from "./permission.js";
import { listSlashCommands, slashCompleter, formatSlashHelp } from "./slash-commands.js";
import { formatAskUserPrompt, mapAskUserLine } from "./ask-user-line.js";
import { expandMentions } from "./mentions.js";
import { formatLanguageStatus, resolveLanguageArgument, resolveLanguagePreference } from "./language.js";
// ω99-65 — the file-edits approval gate (deslop) on the REPL lane: the SAME
// approval-gate.ts module the driver's run gate enforces (ω99-56). A gate
// whose existence depends on the frontend is a fail-closed hole — the plain
// REPL drives the loop itself, so it arms/enforces/disarms through this one
// shared module, never a second gate logic.
import { approvalGatedCall, approvalReceiptMatches, createApprovalGateState, markHumanSettled, humanSettledThisCall, recordApprovalReceipt } from "./approval-gate.js";
import { buildSystemPrompt } from "./prompt.js";
import { buildExpandedSkillMessage, createSkillReadClassifier, findNonPluginSkill, findPluginSkill, findSkill, formatSkillError, isSkillPruned } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
import { getContextRules, createContextRuleMatcher } from "./rules.js";
import { buildPluginCommandMessage, formatPluginCommandError, isBuiltinCommandName } from "./plugins.js";
import type { PluginCommand } from "./plugins.js";
import { registerExtensionSwapSink, rescanExtensionsAt, takePendingBundleColdAttribution } from "./extension-state.js";
import { createBreakLineGuard, createCacheTrackingModel, formatUsageLine } from "./cache.js";
import { createExternalChangeProber } from "./file-changes.js";
import { buildPlanPrompt, buildPlanRevisionPrompt, buildPlanExecutionPrompt, parsePlanReviewInput, planModeDenied, createTodoBoardSource, PLAN_REVIEW_HINT, appendPlanApprovalTrace } from "./plan.js";
import { parseRewindTarget, formatRewindList, formatRewindTurnList, applyRewind } from "./rewind.js";
// ω99-32 T1: the clear_boundary seal (the M80 entry shape, shared with the
// driver path — no new entry type).
import { appendSessionEntry, buildClearBoundaryEntry } from "./session-entry.js";
import { gitRiskAskWarning } from "./git-safety.js";
import { runExtensionCommand } from "./extensions/dispatch.js";
import type { ExtensionCommand } from "./extensions/api.js";
import { createMemoryRuntime, runMemoryCommand, surfacePendingReview, runRefineCommand, refineAutoRuntimeFor, observeAutoRefineOnHooks } from "./memory/index.js";
// M-Memory 弧第二半 — 长期记忆：首轮注入缝 + rescan 保尾 + /memory 新动词 +
// 会话终了沉淀（runtime 单例由 index.ts 的 REPL 装配写入）。
import { longtermMemoryRuntimeFor, runLongtermMemoryVerb } from "./longterm-memory.js";
import { spawnBackgroundReview, REVIEW_MIN_TOOL_CALLS } from "./memory/review.js";
// ω-4f (design 84): Dream consolidation — stage 2 (ledger→curated ledger).
import { spawnDreamRun } from "./memory/dream.js";
import { runSessionSearch } from "./session-search.js";
// ω99-29 T1: the REPL's persistence selection — the SAME channel the TUI and
// one-shot paths use (projection markers never persist; identity base).
import { selectMessagesToPersist } from "./persist.js";
// 夜移 014: the /btw side-question lane's shared envelope/marker (same
// module the driver fork uses — both lanes fork with identical bytes).
// ω99-316 (/btw 侧问): the detached side-question engine — same family as
// the driver's lane (the envelope/querySource stamps live inside it).
import { runSideQuestion } from "./side-question.js";
import { createTaintTracker, argsCarryTaint } from "./taint.js";
// ω99-132 — REPL/one-shot deliverable file card: the SAME extractor the
// driver lands (ω99-125) and the SAME pure formatters the TUI card renders
// with (ω99-131) — one derivation across both front-ends, never a second
// copy. file-card.tsx is a pure ink component module (no side effects), so
// the REPL may import its helpers safely.
import { extractFileReceipt } from "./driver/file-receipt.js";
import { fileIconOf, formatKb } from "./tui/file-card.js";
import { formatStatusReport } from "./commands/status.js";
import { formatCostReport, usageTotalsFromStats } from "./commands/cost.js";
// P0-4 (96 队列): the cross-session wallet ledger (/cost all + exit flush).
import { aggregateCostLedger, readCostLedger, renderWalletReport, fetchWalletBalance } from "./commands/wallet.js";
import type { WalletBalanceOutcome } from "./commands/wallet.js";
import { renameSession, validateSessionName } from "./commands/rename.js";
import { runDiffCommand } from "./commands/diff.js";
import { runConfigCommand } from "./commands/config.js";
import { buildInitPrompt, extractInitDraft, formatInitPreview, applyInitDraft, hasExistingAgentsMd } from "./commands/init.js";
import { availableModels, formatModelList, formatEffortList, resolveModelArgument, resolveEffortArgument, recordModelSwitch, applyModelSelection, asMutableConfig, MODEL_SWITCH_CACHE_NOTE } from "./commands/model.js";
// M63 §A: the /provider switch (shared machinery; the client rebuild below).
// 0.3.32c kimi-401: keyRefreshPending/borrowedKeyPoolNote ride the same module.
import { validateProviderName, providerRows, formatProviderList, recordProviderChange, resolveProviderSwitch, applyProviderConfig, keyRefreshPending, configRefreshPending, borrowedKeyPoolNote, PROVIDER_SWITCH_CACHE_NOTE, PROVIDER_SWITCH_COLD_ATTRIBUTION } from "./commands/provider.js";
// Provider management §7: the compaction window follows the LIVE config.
import { resolveSessionWindowTokens, loadEffectiveProfiles, resolveSessionCachePricing } from "./provider-registry.js";
// 0.3.32c kimi-401: the credentials-file snapshot rides /provider's resolve.
import { readCredentialsFileSync } from "./credentials.js";
// 2026-08-23 persona 层：/persona 纯函数层（Task 12）+ 全局 tier 根（注册表）。
import { parsePersonaArgument, resolvePersonaSwitch, resolveBootstrapPersona, resolveActivePersona, personaSwitchBreaksCache, recordPersonaChange, formatPersonaList, PERSONA_SWITCH_CACHE_NOTE } from "./commands/persona.js";
// SDD 2026-08-23 persona Task 4 — the real chain reads for the bootstrap
// (binding card + global default; the env leg is config.persona above).
import { readProviderPersonaBinding } from "./driver/provider-registry-ops.js";
import { readGlobalDefaultPersonaId } from "./driver/settings-ops.js";
import { loadLayeredSettings, resolveGlobalHome } from "./settings-layer.js";
// ω99-315: the stream idle watchdog budget (settings → ProviderOptions).
import { loadStreamSettings, streamIdleProviderOptions } from "./stream-idle-config.js";
// 125 项 1：预留感知触发线的 misc 旋钮 + 装配缝（dsh resolveCompactSpec 形）。
import { compactionSettingsFromNode, compactionThresholdFields } from "./misc-config.js";
// P2-15 (96 队列 #15): the OTel export runtime (events-seam observer; absent
// telemetry settings ⇒ undefined ⇒ zero egress, zero hot allocations).
import { createTelemetryRuntimeFromSettings } from "./telemetry/telemetry.js";
import { runPermissionsCommand, persistAllowRule } from "./commands/permissions.js";
import { exportEntriesFromMessages, prepareExport, writeExportFile } from "./commands/export.js";
import { collectUncommittedDiff, buildReviewPrompt, hasReviewableContent, formatNoDiffNotice, createGitFn } from "./commands/review.js";
import { runMcpStatusCommand } from "./commands/mcp-status.js";
import { runMcpAuthCommand } from "./commands/mcp-auth.js";
import { runAgentsCommand } from "./commands/agents-roster.js";
import { validateAddDirPath, buildAddedDirEntry, formatAddDirNotice, formatAddedDirsList, ADDED_DIR_TYPE } from "./commands/add-dir.js";
import { formatDoctorReport, type DoctorInput } from "./commands/doctor.js";
import { buildTaskRows, formatTasksReport } from "./commands/tasks.js";
import { VERSION, maxTurns } from "./version.js";
import { isFeatureAblated, parseSessionNameFlag, parseSandboxFlags } from "./args.js";
import { askDigestPrefix } from "./ask-evidence.js";
import { appendPromptHistory, loadPromptHistory } from "./prompt-history.js";
import { parseBangCommand, runBangCommand, formatBangEcho, buildBangContextPrefix } from "./bang.js";
import { createGitStatusProber } from "./git-status-note.js";
import { getCompactInstructionsRider } from "./project-context.js";
// M61 §1: the in-session scheduler runtime (fire-on-idle via steering).
import { createCronRuntime, type CronRuntime } from "./cron.js";
// ω-4a: the monitor runtime (monitor tools + steering-lane event delivery).
import { createMonitorRuntime, type MonitorRuntime } from "./monitor.js";
// M64-A §A: peer messaging (list_agents/send_message over the UDS inbox).
import { createPeerTools } from "./peer/tools.js";
import { createPeerRuntime, readPeerDialogExpiry, sidecarMessageReview, type PeerRuntime } from "./peer/runtime.js";
import { createLoopController, createScheduleWakeupTool, type LoopController } from "./commands/loop.js";
// cc-plugins B1: the /plugin command face (same engine as `wudao plugin`).
import { runPluginSlashCommand } from "./commands/plugins-command.js";
// P1-5 (96 队列): /trust — the workspace trust gate's command face.
import { runTrustCommand } from "./commands/trust.js";
// P2-13 (96 队列 #13): /constitution — the user constitution's command face.
import { runConstitutionCommand } from "./commands/constitution.js";
// P1-7 (96 队列): /worktree — the isolated-worktree usage text (the plain
// REPL hosts no driver, so its branch answers with usage + the pointer).
import { WORKTREE_USAGE } from "./commands/worktree.js";
import { createGoalController, parseGoalCommand, buildEvaluatorModel, type GoalController } from "./goal.js";
// ω99-15: the mission campaign face (ledger + DAG + resume over
// .wudao/mission.json; the controller restores at creation).
import {
  createMissionController,
  createMissionTools,
  parseMissionCommand,
  type MissionController,
} from "./mission.js";
import { parseScheduleCommand, loadSchedulesStore, formatDurableList } from "./schedules.js";

export type ReplCommand =
  | { kind: "prompt"; text: string }
  | { kind: "skill"; name: string; args: string }
  | { kind: "pluginCommand"; name: string; args: string }
  | { kind: "extensionCommand"; name: string; args: string }
  | { kind: "exit" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "resume" }
  | { kind: "plan"; goal: string }
  // M61 §2: /loop [interval] [prompt] — the recurring-work loop (raw args;
  // the controller parses interval/bare/dynamic).
  | { kind: "loop"; args: string }
  // M61 §3: /goal <condition> | bare status | clear aliases.
  | { kind: "goal"; args: string }
  // ω99-15: /mission <objective> | bare status | clear aliases — the task
  // campaign's human face (start/inspect/abandon; the model drives tasks
  // through the mission_* tool quartet).
  | { kind: "mission"; args: string }
  // M61 §4: /schedule — the durable task group.
  | { kind: "schedule"; args: string }
  | { kind: "rewind"; args: string }
  | { kind: "memory"; args: string }
  /** ω99-3a: /refine [instructions] | rollback <refineId> — the Continual
   *  Harness session refiner (needs the session model + live trajectory). */
  | { kind: "refine"; args: string }
  | { kind: "search"; query: string }
  /** ω99-62: /find <query> — the TUI's in-transcript overlay, parsed into
   *  the shared union so the NON-TUI frontends degrade deterministically
   *  (one local notice, zero model calls) instead of paying the
   *  unknown-slash round trip. The TUI is unaffected: app.tsx intercepts
   *  /find BEFORE this parse, so the overlay still owns the line there
   *  (test-pinned priority). Bare /find parses with an empty query (the
   *  TUI's own semantics). */
  | { kind: "find"; query: string }
  /** 夜移 014: /btw <question> — the cache-shared side question. Rides the
   *  session's prefix bytes (system + history + tools identical; the question
   *  is a pure suffix), answers without interrupting an in-flight run, and
   *  the answer never enters the main history. */
  | { kind: "btw"; question: string }
  | { kind: "compact"; focus?: string }
  | { kind: "context" }
  | { kind: "probe"; args: string }
  /** M53 §1: /edit [<n>] — list recent user messages, or arm message n for
   *  editing (the text returns to the input; resubmit branches). */
  | { kind: "edit"; n?: number; raw: string }
  /** M53 §1: /tree — ASCII branch topology of the session. */
  | { kind: "tree" }
  /** M53 §1: /switch [<n>] — list branches, or make branch n active. */
  | { kind: "switch"; n?: number; raw: string }
  // M55 §A: the command-parity pack (routed by the driver in the TUI/Web;
  // the REPL runs the same command modules directly below).
  | { kind: "init" }
  | { kind: "status" }
  /** P0-4 (96 队列): bare /cost keeps the session view; `/cost all` widens
   *  to the cross-session wallet ledger + provider balance. */
  | { kind: "cost"; scope?: "all" }
  | { kind: "rename"; name: string }
  | { kind: "diff" }
  | { kind: "config"; args: string }
  // M55 §B: the medium-command pack.
  | { kind: "model"; name: string }
  | { kind: "effort"; level: string }
  // M63 §A: /provider [name] — the in-session provider switch.
  | { kind: "provider"; name: string }
  // 2026-08-23 persona 层：/persona [<id> [--headers-only|--with-prompt]] | --off。
  | { kind: "persona"; rest: string }
  | { kind: "permissions"; args: string }
  // 推理档三级配置 S4: /language [reply|reasoning <mode>] — the session
  // language lane (双旋钮; bare = status). The DRIVER surfaces (web/TUI)
  // own the mutable tier; the plain REPL has no transient blocks (env/
  // settings only) and answers with the folded status instead.
  | { kind: "language"; args: string }
  | { kind: "export"; file: string }
  | { kind: "review"; focus: string }
  | { kind: "securityReview"; focus: string }
  // P2-16b（96 队列 #16）: /mcp [auth|unauth <server>] — bare = status（M55
  // §B11 原语义），auth/unauth 是 OAuth 流的人触发面（raw args——runner
  // 校验精确形；"/mcpx" 仍是 prompt，prefix-neighbor 纪律）。
  | { kind: "mcp"; args: string }
  | { kind: "agents" }
  // M55 §C: the command-parity finale pack.
  | { kind: "addDir"; path: string }
  | { kind: "doctor" }
  | { kind: "tasks" }
  // cc-plugins B1: /plugin <sub> [args] — the plugin/marketplace command
  // face (same engine as `wudao plugin`; raw args — the runner parses).
  | { kind: "plugin"; args: string }
  // P1-5 (96 队列): /trust [accept|revoke] — the workspace trust gate's
  // face (bare = status; raw args — the runner validates the exact forms).
  | { kind: "trust"; args: string }
  // P1-7 (96 队列): /worktree [enter [name]|exit keep|exit remove] — the
  // main session's isolated worktree (raw args — the driver's case owns the
  // semantics and validates the exact forms).
  | { kind: "worktree"; args: string }
  // P2-13 (96 队列 #13): /constitution [show|approve <n>|reject <n>] — the
  //  user constitution's human face (exact-match grammar; the runner
  //  validates the forms again — /trust discipline).
  | { kind: "constitution"; args: string }
  | { kind: "noop" };

/** ω99-62: the non-TUI degradation copy for /find — ONE text shared by both
 *  routing seams (the REPL chain branch below and the driver's routedSubmit
 *  arm) so every frontend answers byte-identically: what the command is,
 *  where it lives, and the cross-session pointer for the same need. */
import {
  FIND_TUI_ONLY_NOTICE,
  ReplStateHandle,
  SubagentCostSink,
  buildPlanExecutionBranchLink,
  createProgrammaticSubmitGate,
  createTurnSerializer,
  formatReplEditList,
  formatResumeLine,
  parseReplCommand,
  replEditTargets,
} from "./repl-commands.js";
export {
  FIND_TUI_ONLY_NOTICE,
  parseReplCommand,
  replEditTargets,
  formatReplEditList,
  formatResumeLine,
  appendPlanExecutionWrapper,
  buildPlanExecutionBranchLink,
  createProgrammaticSubmitGate,
  createTurnSerializer,
  createSubagentCostSink,
} from "./repl-commands.js";


// —— REPL 命令解析与纯工具族外提（re-export 门面 + 内部使用导入）——
export async function runRepl(opts: {
  readonly config: ProviderConfig;
  readonly workspaceRoot: string;
  readonly buildTools: (model: ModelClient, stateHandle: ReplStateHandle) => readonly import("@wudao-org/core").Tool[];
  readonly contextWindowTokens: number;
  /** Provider management §7: the per-model window resolver (registry
   *  contextLength → provider default → env; settings-knob-aware when the
   *  boot passes its layered view, as index.ts does). /model and /provider
   *  switches re-resolve through it at their turn boundaries — switching the
   *  model switches the window. Absent → the knob-less chain, and the static
   *  boot value stays (the pre-§7 behavior for direct callers/tests). */
  readonly resolveWindowTokens?: (provider: string | undefined, model: string) => number;
  /** Final-review C1 test seam: the REPL's process streams. Defaults are
   *  node:process stdin/stdout (production behavior, byte-identical to
   *  pre-change); tests inject a PassThrough pair to drive the loop and
   *  capture output (the provider-fetch precedent — openai-compatible.ts
   *  options.fetch). */
  readonly stdin?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
  readonly stdout?: NodeJS.WritableStream & { readonly isTTY?: boolean };
  /** ω99-35: the headless (non-TTY) batch window in ms — a TEST seam only
   *  (the stdin/stdout precedent): production keeps the hard 150ms constant;
   *  there is deliberately no env/settings surface for it. */
  readonly headlessBatchWindowMs?: number;
  /** M62 §7: the auto-compaction master switch (false → the loop runs
   *  without compaction; manual /compact still works). */
  readonly compactionEnabled?: boolean;
  /** .wudao/settings.json-configured hooks (M19); forwarded to the loop.
   *  M63-A: the REPL also fires onSessionStart itself at its own boundaries
   *  (it drives the loop directly — no AgentDriver to fire them). */
  readonly hooks?: AgentHooks;
  /** M63-A: the startup SessionStart source ("fork" for --fork-session;
   *  absent → derived from resumeHistory: present = "resume", empty = "startup"). */
  readonly sessionStartSource?: import("@wudao-org/core").SessionStartSource;
  /** M63-C §3: the asyncRewake sink holder — the REPL drives the loop directly (no steering lane); wakes render as notices. */
  readonly rewakeSink?: { current?: (message: string) => void };
  /** M63-C R1: the fire-runtime view (the REPL's own hook compiles are
   *  startup-static; the view exists for parity) + the prompt_id box. */
  readonly hookRuntime?: { readonly getMode?: () => string; readonly common?: () => Record<string, unknown>; readonly mcp?: import("./hooks-config.js").HookMcpSeam; readonly rewake?: (message: string) => void };
  readonly promptIdBox?: { current?: string };
  /** M63-C R1 follow-up: the live session id box (see agent-driver options). */
  readonly sessionIdBox?: { current?: string };
  readonly hookWarnSink?: { current?: (message: string) => void };
  /** ω99-92 (86 顾虑②收口): the session's live-effort box — the same shape as
   *  AgentDriverOptions.effortLiveBox (the 86 five-segment path). The caller
   *  (index.ts) hands the SAME instance to its buildTools' buildToolSet; the
   *  REPL arms it once for the session's life (see the arm beside liveConfig's
   *  creation — the REPL's live source is the session-live config, not a
   *  run-scoped snapshot). Absent → no key, byte-identical spawns. */
  readonly effortLiveBox?: { get?: () => string | undefined };
  /** 125 项 2（codex get_context_remaining 形）：水位线查询工具的触发线晚绑
   *  盒（effortLiveBox 同款形状）——调用方（index.ts）把 SAME 实例交进自己的
   *  buildTools 闭包（buildToolSet 的 contextRemaining 缝读它），runRepl 在
   *  liveConfig/windowRef 就绪后武装。缺省 → 工具读 buildTools 侧的 boot 兜底。 */
  readonly compactionThresholdLiveBox?: {
    get?: () => {
      readonly windowTokens: number;
      readonly thresholdRatio?: number;
      readonly headroomTokens?: number;
      readonly outputReserveTokens?: number;
    };
  };
  /** MCP tools (also threaded through buildTools by the caller); drives the
   *  trailing MCP section of the system prompt. */
  readonly extraTools?: readonly import("@wudao-org/core").Tool[];
  /** M23 long-task stop gates, resolved by the caller from settings + env. */
  readonly gates?: LoopGates;
  /** M23 turn fuse (env/longTask-resolved). Falls back to maxTurns(). */
  readonly maxTurns?: number;
  /** M25 §A2: resumed history (same resolveSession source as the TUI); seeds
   *  state.messages and prints a one-line resume summary at startup. */
  readonly resumeHistory?: readonly AgentMessage[];
  /** Session id of the resumed history (resume line only — the REPL keeps no
   *  session store of its own). */
  readonly sessionId?: string;
  /** ω99-32 T1: /clear rotated the persistence identity (M80 parity) — the
   *  boot-bound seams that captured the boot id (the terminal audit sink, the
   *  extension session binding) rebind to the fresh segment here. Absent →
   *  nothing rebinds (tests/direct callers). */
  readonly onSessionRotated?: (from: string, to: string) => void;
  /** M27 skills loaded by the caller: drive the prompt tail manifest (only
   *  when a read tool is present) and `/skill:name` resolution. */
  readonly skills?: readonly LoadedSkill[];
  /** M36 plugin slash commands loaded by the caller: `/<name> args` expands
   *  the template and submits it through the normal prompt path. */
  readonly pluginCommands?: readonly PluginCommand[];
  /** M39 extension slash commands loaded by the caller: `/<name> args` runs
   *  the extension handler (ctx.submit queues one user turn; plugin and
   *  builtin names always win over these). */
  readonly extensionCommands?: readonly ExtensionCommand[];
  /** M32: the session's read-state table (the SAME instance the caller's
   *  buildTools wired into read_file/edit/write_file). Present → every model
   *  call probes it and injects <file_changed> notes via the MetaNote
   *  channel; absent → no probing (the freshness gate still works inside the
   *  tool set's own table). */
  readonly readState?: ReadStateTable;
  /** M37 §2: the session's file history (the SAME instance the caller's
   *  buildTools wired into write_file/edit) — drives /rewind. Absent → /rewind
   *  answers that history is unavailable (snapshots were never recorded). */
  readonly fileHistory?: import("@wudao-org/core").FileHistory;
  /** M45: the session's sidecar (built by the caller from the resolved
   *  runtime settings). Present → auto-mode write/exec calls classify before
   *  the allow; high verdicts escalate the rl.question ask with the reason;
   *  a non-TTY denies fail-closed. Absent → the pre-M45 gate unchanged. */
  readonly sidecar?: Sidecar;
  /** 夜移 032 stage-2: the session's net-change tracker (the SAME instance
   *  the caller's buildTools wired into write_file/edit). The REPL owns its
   *  own run boundary (it drives the loop directly): reset at each turn
   *  start, preview-line receipt at settle — before the cache summary. */
  readonly turnDiff?: import("@wudao-org/core").TurnDiffTracker;
  /** M49 §2: the session's background-agent registry (the one the caller's
   *  buildTools wired into the task tool). Present → successful ≥3-tool-call
   *  turns spawn the background memory-review fork. */
  readonly agentsRegistry?: import("./agents/index.js").AgentRegistry;
  /** M55 §B12: the plugin agent layer (the task tool's roster middle tier;
   *  /agents lists it with provenance). */
  readonly pluginAgents?: readonly import("@wudao-org/core").RosterPluginAgent[];
  /** M55 §C2: paths for /doctor checks (optional — commands work without them). */
  readonly settingsPath?: string;
  /** ω99-8: bind the caller's subagent cost sink to THIS REPL's cost registry
   *  at its creation — children's usage rows land as provider="subagent"
   *  (/cost + the exit ledger flush see fleet spend). */
  readonly subagentUsageSink?: SubagentCostSink;
  readonly mcpConfigPath?: string;
  readonly sessionDir?: string;
  readonly wudaoDir?: string;
  readonly evalDir?: string;
  /** M59 §3: the web doctor node (search provider state) — /doctor renders
   *  the web checks from it. */
  readonly webDoctor?: import("./commands/doctor.js").WebDoctorInput;
  /** P1-5 (96 队列): boot-time notices printed to stdout at startup (below
   *  the banner/resume line) — index.ts passes the workspace-trust
   *  suppression notice when the gate is active. Absent = no boot notices
   *  (byte-stable for every existing caller/test). */
  readonly bootNotices?: readonly string[];
  /** P1-5 (96 队列): the workspace-trust gate's live getter (trust.ts's
   *  effectiveSuppressed) feeding the permission settings watcher — absent
   *  = no gate (index.ts passes it, pinned false by --trust-workspace). */
  readonly trustSuppressed?: () => boolean;
}): Promise<void> {
  // Final-review C1 test seam — see the opts declaration. Everything below
  // reads these locals, so an injected pair owns the whole session.
  const stdin = opts.stdin ?? defaultStdin;
  const stdout = opts.stdout ?? defaultStdout;
  const argv = process.argv;
  const level = parseLogLevel(argv, process.env);
  const ge = (l: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[l];
  // M42 §3: the mode is RUNTIME state — shift+tab cycles it (the gate below
  // reads the mutable ref at every tool call, never the startup snapshot).
  const modeRef: { mode: Mode } = { mode: modeFromArgv(argv) };

  // M24: the tracked model is what the loop AND every subagent see — usage
  // accounting stays session-wide, and a miss spike gets attributed (B3).
  // M55 §B7: the provider is built over the LIVE config — a /model //effort
  // switch mutates its fields and the next request carries them (the client
  // identity, the cache stats, and every tool closure stay valid).
  // M56 §1: one key pool per session (round-robin + 429 cooldown) shared by
  // every request this REPL makes; M56 §3: one cost registry per session
  // (/cost $ + unpriced≠free note).
  const liveConfig = asMutableConfig(opts.config);
  // ω99-92 (86 顾虑②收口，裁决 b「配置即事实」): arm the live-effort box — the
  // LAST frontend wiring of the ω99-86 five-segment path (the driver arms per
  // run; the TUI joined in 87; the REPL drives its loop directly, so every
  // task spawn here WAS the idle lane — the receipt reported the boot baseline
  // while the child's requests actually ran at liveConfig's CURRENT effort,
  // the providers reading config fields per request — openai-compatible.ts
  // effectiveReasoningEffort's else-arm). The REPL's live source is the
  // SESSION-live config (not a run-scoped snapshot: /effort only lands between
  // turns, so session-long and per-turn arming are observably identical), and
  // the getter reads at SPAWN time — the 79/86 late-read discipline. An
  // idle-period spawn (none exists today — the REPL only executes tools inside
  // its own turn) reads the same session-live truth, never a stale boot string.
  if (opts.effortLiveBox !== undefined) {
    opts.effortLiveBox.get = () => liveConfig.reasoningEffort;
  }
  // 2026-08-31 minimax-401 弧 — LIVE pool over the ONE mutable holder (same
  // fix as session-engine): /provider below syncs liveConfig via
  // applyProviderConfig and buildModel rebuilds over it; a boot-snapshot
  // pool kept authenticating with the BOOT provider's key after a switch
  // (adapters treat an explicit pool as authoritative) → 401.
  const keyPool = createLiveKeyPool(() => liveConfig.apiKeys ?? [liveConfig.apiKey]);
  // ω99-42: session-level holder for the mandatory-reasoning repair flag —
  // the provider fires onMandatoryRepairApplied once per client instance; a
  // /provider or /model switch rebuilds the client, so the HOLDER (not the
  // flag) is what /status reads. In-process only, never persisted.
  const mandatoryRepairArmed = { current: false };
  const costRegistry = new CostRegistry(process.env);
  // ω99-8: seat the caller's subagent cost sink on this registry (children
  // only run after the REPL starts, so the bind precedes the first record).
  opts.subagentUsageSink?.bind(costRegistry);
  // P2-15 (96 队列 #15): the OTel runtime over the same seams the engine
  // wires — events observed from the loop's stream below (observer only),
  // usage from the cost registry's rows (read-only差量), sessionEnd at the
  // REPL's exit seam. Absent telemetry settings ⇒ undefined ⇒ zero egress.
  const telemetry = createTelemetryRuntimeFromSettings(
    (await loadLayeredSettings(opts.workspaceRoot, () => {}, process.env)).effective["telemetry"],
    {
      sessionId: opts.sessionId ?? "repl",
      liveIdentity: () => ({ model: liveConfig.model, provider: liveConfig.provider }),
      costRows: () => costRegistry.rows,
      log: (line) => stdout.write(`⚠️ ${line}\n`),
    },
  );
  // M79 §2: the workspace attachment store is the provider's image seam — a
  // resumed session whose turns carry image refs resolves them here (the
  // inputModalities gate still refuses text-only models pre-IO).
  const attachments = createFileAttachmentStore(opts.workspaceRoot);
  // ω99-315: the dual-tier idle watchdog budget (settings → ProviderOptions).
  const streamIdleOpts = streamIdleProviderOptions(await loadStreamSettings(opts.workspaceRoot));
  // 125 项 1（dsh resolveCompactSpec 形）— 预留感知触发线的 misc 旋钮（boot
  // 一次读；窗口语义/请求帽在每次 run 从 liveConfig 重读——/model //provider
  // 切换自然生效）。
  const compactionSettings = compactionSettingsFromNode(
    (await loadLayeredSettings(opts.workspaceRoot, () => {}, process.env)).effective["compaction"],
    (line) => stdout.write(`${line}\n`),
  );
  // 125 项 2（codex get_context_remaining 形）：水位线查询工具的触发线晚绑盒
  // （effortLiveBox 同款纪律）——index.ts 的 buildTools 闭包把盒交进
  // buildToolSet，runRepl 在此武装：live 窗口（/model //provider 切换时
  // windowRef 跟随）+ live config 的 ratio/headroom/reserve（项 1 装配缝）。
  // 武装前（buildTools 先于 runRepl 构造）工具读调用方的 boot 兜底值。
  if (opts.compactionThresholdLiveBox !== undefined) {
    opts.compactionThresholdLiveBox.get = () => ({
      windowTokens: windowRef.current,
      ...compactionThresholdFields(liveConfig, compactionSettings),
    });
  }
  // 2026-08-23 persona 层：注册表三级合并（内置→~/.wudao→工作区），兜底 =
  // config.persona（WUDAO_PERSONA 解析产物）。坏注册表文件/坏兜底 id 都是
  // 启动警告 + 裸客户端，不崩 REPL；运行期切换走 /persona 的 fail-closed。
  const personaRegistryLoaded = await loadPersonaRegistry({
    globalDir: join(resolveGlobalHome(), "personas"),
    workspaceDir: join(opts.workspaceRoot, ".wudao", "personas"),
  });
  for (const e of personaRegistryLoaded.errors) stdout.write(`⚠️ persona 文件已跳过：${e}\n`); // ω99-166b: #1 散面中文化（file skipped→文件已跳过，全角冒号；e 插值原样）。
  const personaRegistry = personaRegistryLoaded;
  const personaBootstrap = resolveBootstrapPersona(personaRegistry, liveConfig);
  if (!personaBootstrap.ok) stdout.write(`⚠️ ${personaBootstrap.error}\n`);
  // SDD 2026-08-23 persona Task 4 — the bootstrap walks the FULL chain (spec
  // §1): env(config.persona) > provider binding > global default > none. With
  // no binding and no default the resolution degenerates to the env leg —
  // byte-identical to the bare bootstrap the repl tests pin. Stale binding /
  // default ids warn + fall through (resolve-time fail-closed, spec §6), a
  // bad id never blocks the REPL.
  const personaEnv = personaBootstrap.ok ? personaBootstrap.resolved : null;
  const personaActive = resolveActivePersona(personaRegistry, {
    envPersona: personaEnv,
    // A provider-less config can carry no binding ("" keys no card).
    bindingId: readProviderPersonaBinding(liveConfig.provider ?? ""),
    defaultId: readGlobalDefaultPersonaId(),
  });
  if (personaActive.warning !== undefined) stdout.write(`⚠️ ${personaActive.warning}\n`);
  // C1 (final review): the runtime slots must be wired at construction —
  // builtins define {{sessionId}} headers under openai-chat (the default
  // wire; Phase B can route the same runtime onto anthropic/responses), and
  // an empty slot made resolveTemplate throw on EVERY subsequent model call
  // (a generic Error the retry ladder then burned before surfacing). Same
  // fallback as the cron/monitor runtimes.
  const personaRuntime = createPersonaRuntime(personaActive.resolved, {
    sessionId: opts.sessionId ?? "repl",
  });
  // withPersona 在 cache tracker 之内：tracker 的前缀断言看我们的规范输入
  // （稳定视图）；persona 造成的 wire 断裂由 session 记录归因（spec §4 层3）。
  // Provider management §7: the compaction window is a REF over the LIVE
  // config — built from the boot value (the caller already resolved it
  // knob-aware) and re-resolved whenever /model or /provider moves the
  // provider/model pair. The per-turn compaction options and /context read
  // the ref, so the window follows the model without a rebuild.
  const envWindowNumber = Number(process.env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000;
  const windowFor = opts.resolveWindowTokens
    ?? ((provider: string | undefined, model: string): number =>
      resolveSessionWindowTokens({ effective: undefined, envWindowTokens: envWindowNumber, provider, model }));
  const windowRef: { current: number } = { current: opts.contextWindowTokens };
  // ω99-13: the /goal controller is created further down (it needs the model),
  // but the usage observer below is the model wrapper's — a late-bound box
  // lets the --budget metering ride the SAME seam the cost registry does.
  const replGoalBox: { current?: GoalController } = {};
  // ω99-28 T3 — one cache event per line: the streaming deltas write without
  // a trailing newline, so the break channel guards its own line starts (the
  // campaign's ⚠️ lines stuck to thinking-text tails and escaped two
  // line-anchored censuses). The delta branches feed the guard below.
  const breakGuard = createBreakLineGuard((s) => stdout.write(s));
  const buildModel = (cold?: string) =>
    createCacheTrackingModel(
      withPersona(createProvider(liveConfig, {
        keyPool,
        attachments,
        personaRuntime,
        // ω99-42: the repair-verified edge feeds the /status holder (the
        // flag itself stays in the provider instance — this is the surface).
        onMandatoryRepairApplied: () => { mandatoryRepairArmed.current = true; },
        ...streamIdleOpts,
      }), personaRuntime),
      {
        onBreak: (warning) => breakGuard.breakLine(warning),
        // ω99-24 B: a reasoned bundle rescan (rescanExtensionsAt) parks its
        // M24 attribution at the seam — the next main-call usage row declares
        // itself cold-and-expected with it. Live poll, so /provider rebuilds
        // inherit the same declaration.
        pendingColdAttribution: takePendingBundleColdAttribution,
        // ω99-8b: same-client child calls arrive stamped querySource="subagent"
        // — skip them HERE (the task tool's ω99-8 forwarder owns the subagent
        // row, so the child counts exactly once). Other tags/untagged still record.
        onUsage: (u, _s, _w, src) => {
          if (src === "subagent") return;
          // ω99-13: --budget metering — recordMainUsage's own ω99-8b partition
          // drops the evaluator's rows; subagent rows are already gone above.
          replGoalBox.current?.recordMainUsage(u, src);
          costRegistry.record({ model: liveConfig.model, provider: liveConfig.provider, usage: u });
        },
        ...(cold !== undefined ? { coldFirstTurnAttribution: cold } : {}),
      },
    );
  const model = buildModel();
  // M63 §A: the provider switch rebuilds the client — this holder is what
  // the turn loop reads (the REPL is sequential, so every line IS a turn
  // boundary; the /provider branch below swaps it between turns).
  const modelRef = { current: model };

  // Spread into a mutable copy: buildTools returns readonly Tool[] (runRepl
  // treats the caller's array as immutable), but AgentState.tools is Tool[].
  // The state handle lets the caller's probe/fork closures see the state
  // once it exists (tools are built first).
  const stateHandle: ReplStateHandle = {};
  const tools = [...opts.buildTools(model, stateHandle)];
  const hasMcpTools = (opts.extraTools ?? []).some((t) => t.name.startsWith("mcp__"));
  // Skills manifest only when the model can act on it (a read tool exists).
  const hasReadTool = tools.some((t) => t.name === "read_file");
  // ω99-241: #4 — the computer strategy section rides the prompt iff the
  // session's tool set carries the computer octet (session-static, like
  // hasMcpTools — the REPL's rescan below reuses this same flag).
  // computer_click probes the octet: it mounts as a unit (tools.ts,
  // zero-config top-level only).
  const hasComputerTools = tools.some((t) => t.name === "computer_click");
  // cc-plugins A3: the extension surfaces the rescan swaps live (boot consts
  // become one mutable box — every read below goes through it, so a rescan
  // lands between turns without restarting).
  const live: {
    skills: readonly LoadedSkill[];
    pluginCommands: readonly PluginCommand[];
    hooks: AgentHooks | undefined;
  } = {
    skills: hasReadTool ? (opts.skills ?? []) : [],
    pluginCommands: opts.pluginCommands ?? [],
    hooks: opts.hooks,
  };

  // M42 §2: the slash-command registry drives readline's Tab completer — the
  // REPL's simple version of the TUI suggestion menu (list on ambiguity,
  // inline completion on a single hit). Rebuilt on every extension swap.
  let slashCommands = listSlashCommands({
    skills: live.skills,
    pluginCommands: live.pluginCommands,
    extensionCommands: opts.extensionCommands ?? [],
  });

  // M58 §C#10: preload readline's native ↑ history with this project's
  // cross-session prompts (newest last — the direction the walk starts at).
  // A read failure degrades to the usual empty history, never fatal.
  const priorPrompts = await loadPromptHistory(opts.workspaceRoot).catch(() => [] as readonly string[]);

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    completer: (line: string) => slashCompleter(line, slashCommands),
    // M44 §2: readline's native ↑/↓ history — explicitly sized to match the
    // TUI's 100-entry cap with adjacent duplicates collapsed (no-ops when
    // the streams are not a terminal pair; history itself is readline's).
    historySize: 100,
    removeHistoryDuplicates: true,
    ...(priorPrompts.length > 0 ? { history: [...priorPrompts] } : {}),
  });

  // 夜移 034 stage-3 (SIGINT natural exit): the wake every question rides.
  // A pending rl.question's promise NEVER settles once the interface closes
  // (probed: no resolve, no reject) — that is why the idle-SIGINT branch
  // used to blast out with process.exit, which skipped stdio drain,
  // main()'s finally (the guard-lane flush), the session-end hook, and the
  // close-event cleanup. The wake resolves "" — fail-closed in every dialog
  // parser here (parseAskAnswer → deny, the peer hold → deny, ask_user → an
  // empty answer) — and the main loop's head check turns it into the same
  // natural exit /exit takes. rl stays open until runRepl's tail so a
  // mid-dialog wake can never strand on a closed interface.
  let sigintExitRequested = false;
  let resolveSigintExit: () => void = () => {};
  const sigintExit = new Promise<null>((resolve) => {
    resolveSigintExit = () => {
      sigintExitRequested = true;
      resolve(null);
    };
  });
  const rawQuestion = rl.question.bind(rl);
  rl.question = (query: string): Promise<string> =>
    Promise.race([rawQuestion(query), sigintExit.then(() => "")]);

  // M34 §1: ask_user rides the TOP-LEVEL set only (appended outside the pool
  // the task tool draws child sets from). The REPL asks through rl.question —
  // options print as a numbered list and a bare in-range number picks that
  // label. Non-TTY leaves the seam unwired: fail-closed error result, the
  // model decides itself.
  tools.push(
    stdin.isTTY === true
      ? createAskUserTool({
          askUser: async (question, options) =>
            mapAskUserLine(await rl.question(formatAskUserPrompt(question, options)), options),
        })
      : createAskUserTool({}),
  );

  // M61 §1: the scheduler trio rides the top-level set (session-scoped,
  // registered at startup — the tool-list prefix stays byte-stable). The
  // runtime refuses to nothing here: disabled/symlink yields an inert runtime
  // whose tools answer with the refusal.
  const cronRuntime: CronRuntime = await createCronRuntime({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId ?? "repl",
    onWarn: (line) => stdout.write(`${line}\n`),
  });
  // ω-4a: the monitor runtime — same posture as the scheduler trio (inert
  // runtime keeps the tools for the fail-closed refusal). Watches are
  // in-memory session state; the close seam below reaps the children.
  const monitorRuntime: MonitorRuntime = createMonitorRuntime({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId ?? "repl",
    env: process.env,
    spillDir: join(opts.workspaceRoot, ".wudao", "spill", opts.sessionId ?? "repl"),
    onWarn: (line) => stdout.write(`${line}\n`),
  });
  // M64-A §A: the peer-messaging runtime — same posture as the scheduler
  // trio (inert runtime keeps the tools for the fail-closed refusal). The
  // receiver tier reads the live mode; holds surface as rl.question dialogs
  // (the REPL's established approval rail) with dialogExpiry as backstop.
  // M64-A fix: the REPL's sidecar (when the caller built one) reviews
  // inbound peer text before delivery; peerDialogExpiry honors the setting.
  const replDialogExpiry = await readPeerDialogExpiry(opts.workspaceRoot);
  const peerRuntime: PeerRuntime = await createPeerRuntime({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId ?? "repl",
    ...(parseSessionNameFlag(process.argv.slice(2)) !== undefined ? { name: parseSessionNameFlag(process.argv.slice(2)) } : {}),
    ...(parseSandboxFlags(process.argv.slice(2), process.env).enabled ? { sandboxed: true } : {}),
    env: process.env,
    tier: () => (modeRef.mode === "auto" ? "bypass" : "normal"),
    ...(opts.sidecar !== undefined ? { reviewMessage: sidecarMessageReview(opts.sidecar) } : {}),
    ...(replDialogExpiry !== undefined ? { dialogExpiryMs: replDialogExpiry } : {}),
    notify: (line) => stdout.write(`${line}\n`),
  });
  if (peerRuntime.approvalSink !== undefined) {
    peerRuntime.approvalSink.current = async (held): Promise<boolean> => {
      // ω99-158: peer 消息询问中文化（键道 y/yes 原样；冒号/问号全角，legend 原样）。
      const answer = await rl.question(`🔑 允许来自 ${held.from} 的 peer 消息（tier ${held.tier}）：${held.preview}？ [y/N] `);
      const trimmed = answer.trim().toLowerCase();
      return trimmed === "y" || trimmed === "yes";
    };
  }
  tools.push(...createPeerTools(peerRuntime));
  tools.push(...createCronTools({
    workspaceRoot: opts.workspaceRoot,
    sessionId: opts.sessionId ?? "repl",
    table: cronRuntime.table(),
    env: process.env,
  }));
  // ω-4a: the monitor trio — top-level only, fixed position beside the cron
  // trio; the tail confinement delegate is core's resolver, kind=command
  // refuses under the REPL's own sandbox posture.
  tools.push(...createMonitorTools({
    registry: monitorRuntime.registry(),
    confinePath: (p) => resolveWorkspacePath(opts.workspaceRoot, p),
    ...(monitorRuntime.refusal !== undefined ? { refusal: monitorRuntime.refusal } : {}),
    ...(parseSandboxFlags(process.argv.slice(2), process.env).enabled ? { sandbox: true } : {}),
  }));
  // M61 §2: the dynamic /loop's self-scheduling tool. The controller is
  // created below (after runTurn exists); the box is the late-bound seam.
  const replLoopBox: { current?: LoopController } = {};
  tools.push(createScheduleWakeupTool(() => replLoopBox.current));
  // ω99-15: the mission quartet — same late-bound track (the controller is
  // created further down once the notice channel is wired; the tools answer
  // a loud refusal until then).
  const replMissionBox: { current?: MissionController } = {};
  tools.push(...createMissionTools(() => replMissionBox.current));

  const state: AgentState = {
    systemPrompt: buildSystemPrompt(opts.workspaceRoot, hasMcpTools, live.skills, peerRuntime.refusal === undefined, hasComputerTools),
    messages: opts.resumeHistory ? [...opts.resumeHistory] : [],
    tools,
    status: "idle",
  };
  stateHandle.state = state;

  // ω99-29 T1 — the REPL's main-conversation persistence seam. ω99-26's
  // campaign proved the gap: the REPL drove 117 model calls with zero
  // main-conversation persistence (only meta stubs) while the TUI and
  // one-shot paths carried the full M5 discipline. This block ports the
  // session-engine.ts seams to the REPL's own lifecycle (it drives the loop
  // directly — no AgentDriver exists to fire them):
  //   · the store is the SAME root the boot's resolveSession read from
  //     (index.ts hands the resolved sessionId), so appends land on the JSONL
  //     the other frontends write;
  //   · persistBase is identity-seeded from resumeHistory (selectMessagesTo
  //     Persist's base — same function, same projection-marker filters);
  //   · earlyUserPersist is the in-flight user append the later seams await
  //     first, so the user line always lands before the run's tail (the
  //     store has no internal cross-append ordering otherwise).
  const replPersistStore = createJsonlSessionStore(join(opts.workspaceRoot, ".wudao", "sessions"));
  const persistBase: AgentMessage[] = opts.resumeHistory ? [...opts.resumeHistory] : [];
  // ω99-32 T1: the live persistence identity. /clear rotates it (M80 parity:
  // the pre-clear id is sealed by one clear_boundary, the conversation
  // continues on a fresh segment id) — every persistence seam below reads the
  // BOX, never the boot-time opts.sessionId, so post-clear turns land on the
  // new segment.
  const sessionBox: { current: string } = { current: opts.sessionId ?? "repl" };
  const persistSid = (): string => sessionBox.current;
  let earlyUserPersist: Promise<void> = Promise.resolve();
  const persistNotice = (err: unknown): void => {
    stdout.write(`⚠️ 会话落盘失败 (${err instanceof Error ? err.message : String(err)})——对话仍在内存中继续\n`); // ω99-166b: #2 散面中文化（err 三元原样；em-dash→中文破折号）。
  };
  // 夜移 017 discipline, REPL form: the user's own turn persists BEFORE the
  // first model call — a crash mid-run must never lose the one message the
  // user cannot regenerate. The persistBase reservation is SYNCHRONOUS (a
  // fast model can settle the whole run before an async reserve's append —
  // the identity dedup below then re-appends); the append's failure path
  // un-reserves so the run-complete tail retries.
  const persistUserTurn = (m: AgentMessage): void => {
    persistBase.push(m);
    earlyUserPersist = replPersistStore.append(persistSid(), m).catch((err) => {
      const i = persistBase.indexOf(m);
      if (i >= 0) persistBase.splice(i, 1);
      persistNotice(err);
    });
  };
  // 波次8 #45 + run-complete, REPL form: everything selectMessagesToPersist
  // picks from the given messages, appended in order against the identity
  // base. Used as the loop's onBeforeToolDispatch barrier (a rejection fails
  // the tool batch CLOSED inside core — nothing executes) and at the turn's
  // settle seam (the driver's onRunComplete equivalent).
  const persistOrderedPrefix = async (messages: readonly AgentMessage[]): Promise<void> => {
    await earlyUserPersist;
    const toPersist = selectMessagesToPersist(messages, persistBase);
    for (const m of toPersist) {
      await replPersistStore.append(persistSid(), m);
      persistBase.push(m);
    }
  };
  const persistRunTail = async (): Promise<void> => {
    try {
      await persistOrderedPrefix(state.messages);
    } catch (err) {
      persistNotice(err);
    }
  };

  // cc-plugins A3: rescanExtensions() reaches this REPL through the swap
  // sink. The REPL is sequential (one line = one turn), so a rescan can only
  // ever land BETWEEN turns — never mid-run. The prompt rebuild keeps the
  // cache invariant: only the trailing <available_skills> manifest moves
  // (hasMcpTools/hasReadTool are session-static tool-set facts).
  const unregisterExtensionSwap = registerExtensionSwapSink((fresh) => {
    live.skills = hasReadTool ? fresh.skills : [];
    live.pluginCommands = fresh.pluginCommands;
    live.hooks = fresh.hooks;
    slashCommands = listSlashCommands({
      skills: live.skills,
      pluginCommands: live.pluginCommands,
      extensionCommands: opts.extensionCommands ?? [],
    });
    // ω99-28 T1 — the rebuild passes the SAME session-static peer flag the
    // boot prompt used (the state's construction above); the default-false
    // 3-arg call dropped the "# Peer messaging" tail on every rescan — the
    // campaign's undeclared turn-3 header break (18.4k).
    // M-Memory 弧第二半：appendTo 保尾——rescan 重建后的 prompt 尾部仍带冻结
    // 的 <long-term-memory> 块（boot 注入与 rescan 两位点字节一致）。
    const lts = longtermMemoryRuntimeFor();
    const rebuiltPrompt = buildSystemPrompt(opts.workspaceRoot, hasMcpTools, live.skills, peerRuntime.refusal === undefined, hasComputerTools);
    replaceSystemPrompt(state, lts === undefined ? rebuiltPrompt : lts.appendTo(rebuiltPrompt));
  });

  // M63-A: the REPL drives the loop directly (no AgentDriver), so it fires
  // the session-surface events itself. Startup: explicit source wins ("fork"),
  // else derived from the seed history. Isolated like every observer hook.
  // cc-plugins E4: the returned additionalContext parks on the MetaNote
  // projection (declared here, ahead of the probers that also feed it, so
  // the startup fire at the bottom of setup can push) — it reaches the next
  // model call, never the persisted history.
  const metaNotes: string[] = [];
  const fireSessionStart = (source: import("@wudao-org/core").SessionStartSource): void => {
    void (async () => {
      try {
        const ctx = await live.hooks?.onSessionStart?.(source, { sessionId: sessionBox.current });
        if (typeof ctx === "string" && ctx !== "") metaNotes.push(ctx);
      } catch {
        /* observer isolation */
      }
    })();
  };
  // M63-B R1 fix (6): the SessionEnd counterpart — same isolation, and the
  // SHARED budget deadline created at the firing site (every composed layer
  // consumes the one window).
  const fireSessionEnd = (source: import("@wudao-org/core").SessionEndSource): void => {
    void (async () => {
      try {
        await live.hooks?.onSessionEnd?.(source, {
          sessionId: sessionBox.current,
          budgetEndsAt: Date.now() + SESSION_END_BUDGET_MS,
        });
      } catch {
        /* observer isolation */
      }
      // ω99-36: the in-process session boundary settles a dangling SHELL
      // mission (stale terminal snapshot in its archive) — /exit, EOF, SIGINT
      // and /clear all pass through this one funnel, so the settlement rides
      // it too. Fire-and-forget like the hook above: settlement must never
      // take the exit path down (the pending fs write keeps the loop alive
      // until it lands; the receipt is ignored — a NON-empty campaign is
      // never settled, resume is the feature).
      try {
        await replMissionBox.current?.settleAtSessionBoundary();
      } catch {
        /* observer isolation */
      }
    })();
  };
  fireSessionStart(opts.sessionStartSource ?? (opts.resumeHistory !== undefined && opts.resumeHistory.length > 0 ? "resume" : "startup"));
  // M63-C: asyncRewake sinks render as notices (no driver steering lane here).
  if (opts.rewakeSink !== undefined) {
    opts.rewakeSink.current = (message: string): void => {
      stdout.write(`\x1b[2m↳ hook wake: ${message}\x1b[0m\n`);
    };
  }

  // Approvals go through rl.question (NOT a raw stdin listener) so readline's
  // internal line-buffering stays coherent with the main "wudao> " prompt loop.
  // M33 §1: the y/a/N menu (`a` records a session allowlist rule, `n <reason>`
  // denies with the reason fed back to the model), layered (deny-first) over
  // the hot-reloaded .wudao/settings.json rules and the session allowlist.
  // Security fix: a runtime-policy write (settings/mcp.json) prompts plain
  // [y/N] naming the file — `a` is degraded to allow-once, never a rule.
  // Fail-closed: with no TTY there is nobody to ask — deny rather than allow.
  const sessionAllowlist = createSessionAllowlist();
  // ω99-65 — the file-edits approval gate (deslop), REPL lane: armed at
  // /skill:<name> invocation when the frontmatter declares
  // `approval-gate: file-edits`, disarmed by /clear — the same lifecycle the
  // driver's run gate carries (56), through the same approval-gate.ts state.
  // The receipts land in askHuman below (the ONE ask seam this lane has —
  // static asks, sidecar escalations and the gate flip all route through
  // it), so they can never drift from what the human actually granted.
  const approvalGate = createApprovalGateState();
  const armApprovalGate = (skill: LoadedSkill): void => {
    if (skill.approvalGate !== "file-edits" || approvalGate.armed) return;
    approvalGate.armed = true;
    stdout.write("🚧 审批门已布防（file-edits）——未获本会话批准的路径上 edit/write_file 将先询问；/clear 解除\n\n"); // ω99-166b: #3 散面中文化（全角括号=横幅含内嵌子句；分号全角）。
  };
  const disarmApprovalGate = (why: string): void => {
    if (!approvalGate.armed) return;
    approvalGate.armed = false;
    approvalGate.receipts.clear();
    approvalGate.humanSettled = null; // ω99-70: the per-call marker dies with the posture
    stdout.write(`🚧 审批门已解除 (${why})\n\n`); // ω99-166b: #4 散面中文化（disarmed→已解除；why 插值原样）。
  };
  // P1-5: the trust gate rides the settings watcher when the boot passed the
  // live getter (absent = no gate — the byte-stable default for direct
  // callers/tests).
  const settingsWatcher = createPermissionSettingsWatcher(opts.workspaceRoot, (line) => stdout.write(`${line}\n`), opts.trustSuppressed === undefined ? {} : { trustSuppressed: opts.trustSuppressed });
  const staticDecide = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | "ask"> =>
    decideRichPermission({
      // Live mode: a mid-run shift+tab takes effect on the next tool call.
      mode: modeRef.mode,
      toolName,
      input,
      session: sessionAllowlist,
      settings: await settingsWatcher.get(),
    });

  // The human ask (static "ask" decisions and sidecar escalations alike):
  // TTY → the y/a/N menu (M45: the sidecar reason rides the question as
  // `🔑 (sidecar: <reason>)`); non-TTY → fail-closed deny.
  const askHuman = async (toolName: string, input: Record<string, unknown>, esc: SidecarEscalation): Promise<PermissionDecision> => {
    if (stdin.isTTY !== true) {
      // ω99-158: 非交互拒中文化（REPL askHuman，与 permission.ts #8 同形）。
      stdout.write(`🔑 非交互输入 — 正在拒绝 ${toolName}\n`);
      return {
        behavior: "deny",
        reason: esc.circuitOpen
          ? "sidecar circuit-open"
          : esc.reason !== undefined
            ? `sidecar: ${esc.reason}`
            : "non-interactive",
      };
    }
    const summary = summarizeToolCall(toolName, input);
    const settingsFile = protectedSettingsFile(toolName, input);
    // M37 §3: a high-risk git shell upgrades the ask with a warning
    // block (informational — the pipeline still decides).
    const gitWarning = gitRiskAskWarning(toolName, input, opts.workspaceRoot);
    const sidecarNote = esc.circuitOpen
      ? `🛡 sidecar 连续拒绝 ${opts.sidecar?.consecutiveHighs() ?? 0} 次,已切换人工确认\n`
      : esc.reason !== undefined
        ? `🔑 (sidecar: ${esc.reason})\n`
        : "";
    // ω99-158: askApprove 孪生随源中文化（与 permission.ts #6 同形；行尾空格保留）。
    const question = settingsFile === undefined
      ? `🔑 允许 ${toolName}${summary ? "：" + truncate(summary, 100) : ""}？ [y/a/p/N] `
      : `🔑 允许 ${toolName}：策略文件 ${settingsFile}${summary && summary !== settingsFile ? ` (${truncate(summary, 100)})` : ""}？ [y/N] `;
    // ω-4e: the asker digest (child-originated asks only — undefined keeps
    // `full` byte-identical to today). First block, before the git
    // warning/sidecar lines.
    const digest = askDigestPrefix();
    const full = `${digest !== undefined ? `${digest}\n` : ""}${gitWarning !== undefined ? `${gitWarning}\n` : ""}${sidecarNote}${question}`;
    const parsed = parseAskAnswer(await rl.question(full));
    // ω99-65: the approval gate's receipt — recorded from the SAME parsed
    // answer the session rule below derives from (askHuman is this lane's
    // one ask seam, the twin of the driver's askPermission recording), so
    // the gate's receipt store and the pipeline's session allowlist can
    // never drift apart.
    recordApprovalReceipt(approvalGate, parsed, toolName, input);
    // ω99-70: this call is now human-settled — when this ask was a sidecar
    // escalation INSIDE layeredDecide, the gate block's flip must not
    // re-ask the decision the human just made (identity-keyed per call).
    markHumanSettled(approvalGate, toolName, input);
    const { decision, sessionRule, persistentRule } = applyAskAnswer(parsed, toolName, input);
    // 夜移 009: shared recording seam — a session-only rule's receipt rides
    // stdout next to the persistent receipt below it.
    const sessionNote = recordAskRules(sessionAllowlist, { sessionRule, persistentRule });
    if (sessionNote !== null) stdout.write(`${sessionNote}\n`);
    // 0.3.14 #1: `p` also persists the rule into the project tier (same lane
    // /permissions uses) — the receipt prints once the write lands.
    if (persistentRule !== null) {
      void persistAllowRule(opts.workspaceRoot, persistentRule).then(
        (receipt) => stdout.write(`${receipt}\n`),
        (err) => stdout.write(`permissions：always-rule 写入失败（${String(err)}）——本会话规则仍然生效\n`), // ω99-166d-ii: #15（permissions 写失败回执中文化；字节孪生 permission.ts :1487 在域外文件，转 166e 记账）
      );
    }
    return decision;
  };

  // M45: with a sidecar, the layer sits between the static rules and the
  // allow (auto mode only); a sidecar escalation resolves inside the layer,
  // and a static "ask" still falls to the human. M49 §4: the taint probe
  // marks args embedding user-file / MCP content [untrusted] for the
  // classifier.
  // M63-A: the PermissionRequest hook layer wraps the WHOLE remaining
  // pipeline — static rules inside, the sidecar layer as the no-opinion
  // fall-through (the mandated order: after deny rules, before the sidecar).
  const taint = createTaintTracker();
  const sidecarLayer = opts.sidecar !== undefined
    ? withSidecarLayer(
        {
          sidecar: opts.sidecar,
          getMode: () => modeRef.mode,
          escalate: askHuman,
          receipt: (line) => stdout.write(`${line}\n`),
          taintProbe: (_toolName, input) => argsCarryTaint(taint, input),
          // M51 §3: tool_flags + the custom verdict-cache equivalence, read
          // from the session's tool set (built above at line ~215).
          toolMeta: toolMetaResolverFor(() => tools),
          // ω99-27 T2: the operator exemption lane over the hot-reloaded
          // permission settings (same watcher the static rules read).
          sidecarExemptRules: async () => (await settingsWatcher.get()).sidecarExempt,
        },
        staticDecide,
      )
    : undefined;
  // cc-plugins A3 review fix (LOW): the hook layer reads `live.hooks` at
  // DECISION time — a rescan's swapped onPermissionRequest reaches the very
  // next permission decision (withPermissionRequestHook alone would freeze
  // the boot hook until restart; the TUI gets the same freshness from its
  // useMemo keyed on liveHooks + the setOptions refresh).
  const layeredDecide = livePermissionRequestHook(() => live.hooks?.onPermissionRequest, () => modeRef.mode, staticDecide, {
    sidecarPresent: opts.sidecar !== undefined,
    // ω99-21: the immune-ask ceiling — a hook allow never clears the three
    // bypass-immune ask layers (same predicate every gate composes).
    immuneAsk: immuneAskCeiling(() => settingsWatcher.get()),
    ...(sidecarLayer !== undefined ? { classify: sidecarLayer } : {}),
  });
  const baseCanUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
    const d = await layeredDecide(toolName, input);
    return d !== "ask" ? d : askHuman(toolName, input, { circuitOpen: false });
  };

  // M37 §1: plan runs layer the read-only whitelist BEFORE the normal gate
  // (the whitelist is strictest); normal runs pass through unchanged.
  // ω99-65 — the file-edits approval gate (deslop) rides the SAME position
  // the driver's run gate enforces it (the loop's canUseTool): while armed,
  // an edit-class call WITHOUT a receipt for this exact tool+path never
  // silently passes. The static/sidecar/hook layer (layeredDecide — the same
  // withPermissionRequestHook composition the driver frontends consult)
  // runs first: its deny and ask outcomes stand (narrowing composes, the
  // gate never widens), only its receipt-less ALLOWS flip to the human ask.
  // A recorded receipt (the `a`/`p` answer's path-scoped rule, recorded in
  // askHuman above) falls through to the normal path, where the pipeline's
  // own session layer honors it — no re-ask.
  // ω99-70 — the flip targets SILENT allows only: an ask resolved INSIDE
  // layeredDecide (the sidecar high-risk escalation routes through the same
  // askHuman seam) marked the call human-settled; the human's own allow
  // stands instead of being re-asked.
  const canUseTool = (plan: boolean) =>
    async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision> => {
      if (plan) {
        const denied = planModeDenied(toolName);
        if (denied) return denied;
      }
      if (approvalGate.armed && approvalGatedCall(toolName) && !approvalReceiptMatches(approvalGate.receipts, toolName, input)) {
        const d = await layeredDecide(toolName, input);
        if (d !== "ask" && d.behavior === "deny") return d;
        if (d !== "ask" && d.behavior === "allow" && humanSettledThisCall(approvalGate, input)) return d;
        return askHuman(toolName, input, { circuitOpen: false });
      }
      return baseCanUseTool(toolName, input);
    };

  // ω99-164: A1 REPL 启动横幅中文化。
  stdout.write("交互模式 — /help 查看命令 · /exit 退出\n");
  stdout.write(`wudao v${VERSION} · 模型：${modelLabel(opts.config)} · 模式：${modeLabel(modeRef.mode)}\n`); // ω99-190: #4; ω99-195: #1（model: 前缀段中文化；模式： 段零触）
  // M25 §A2: a resumed session announces itself in one line (no replay).
  if (opts.resumeHistory && opts.resumeHistory.length > 0) {
    stdout.write(`${formatResumeLine(opts.sessionId ?? "", opts.resumeHistory)}\n`);
  }
  // M49 §1: the memory runtime — refresh the recall pool and surface any
  // pending-review suggestions once (the "next session" confirmation).
  const memoryRuntime = createMemoryRuntime(opts.workspaceRoot);
  await memoryRuntime.refresh();
  const pending = await surfacePendingReview(opts.workspaceRoot);
  if (pending !== undefined) stdout.write(`${pending}\n`);
  // P1-5: boot notices (the workspace-trust suppression notice when active).
  for (const notice of opts.bootNotices ?? []) stdout.write(`${notice}\n`);
  stdout.write("\n");

  // M42 §3: shift+tab (reverse-tab) cycles the runtime permission mode — the
  // same binding the TUI registers as app.cycle-mode. readline's terminal
  // keypress parser maps \x1b[Z to { name: "tab", shift: true }; the raw
  // sequence check covers parsers that hand the bytes through instead. Only
  // wired on a real terminal pair (keypress emission needs rl.terminal).
  const onKeypress = (_str: string, key?: { readonly name?: string; readonly shift?: boolean; readonly sequence?: string }): void => {
    const isReverseTab = key !== undefined &&
      ((key.name === "tab" && key.shift === true) || key.sequence === "\x1b[Z");
    if (!isReverseTab) return;
    modeRef.mode = cycleMode(modeRef.mode);
    // M64-A fix: the peer registry tier follows the live mode (the runtime's
    // classification closure already reads modeRef).
    void peerRuntime.setTier(modeRef.mode === "auto" ? "bypass" : "normal").catch(() => {});
    const label = modeLabel(modeRef.mode);
    if (activeGen !== null) {
      // Mid-run: the notice interleaves with the streaming output; no prompt
      // is pending to redraw.
      stdout.write(`\n模式 → ${label}\n`); // ω99-190: #5
      return;
    }
    // Idle at the prompt: clear the pending line, print the notice, restore
    // the prompt + whatever the user had typed (rl.prompt redraws rl.line).
    stdout.write("\r\x1b[K");
    stdout.write(`模式 → ${label}\n`); // ω99-190: #6
    rl.prompt();
  };
  const keypressWired = stdin.isTTY === true && stdout.isTTY === true;
  if (keypressWired) stdin.on("keypress", onKeypress);

  // M32 §2/§3: the external-change prober rides every model call; its
  // <file_changed> notes go through the MetaNote queue (last tool_result
  // tail, projection-only — the in-memory history stays clean).
  // (metaNotes itself is declared up with fireSessionStart — cc-plugins E4 —
  // so the startup fire can push its SessionStart context before the probers
  // attach here.)
  // M62 §1: the gated context-rule matcher (undefined when there are none).
  const replGated = getContextRules(opts.workspaceRoot).gated;
  const replRuleMatcher = replGated.length > 0 ? createContextRuleMatcher(opts.workspaceRoot, replGated) : undefined;
  // M58 §C#2: the session's standing compact-instructions rider (the WUDAO.md/
  // AGENTS.md `## Compact Instructions` section, parsed once at session start
  // through the memoized project-context loader) rides EVERY compaction call.
  const compactInstructionsRider = getCompactInstructionsRider(opts.workspaceRoot);
  const prober = opts.readState !== undefined
    ? createExternalChangeProber({ readState: opts.readState, workspaceRoot: opts.workspaceRoot, push: (t) => metaNotes.push(t) })
    : undefined;
  // M58 §C#8 (batch-B wiring of C's prober): the <git_status> block rides the
  // SAME MetaNote queue — session start (the first model call's probe) plus
  // on fingerprint change (HEAD sha / branch / entry count), recomputed at
  // turn boundaries via beforeModelCall below. Projection-only: the stable
  // prompt prefix never carries it. Fail-open (git failure = no note).
  const gitProber = createGitStatusProber({ workspaceRoot: opts.workspaceRoot, push: (t) => metaNotes.push(t) });
  // M37 §2: the session's file history — the SAME instance the caller's
  // buildTools wired into write_file/edit (one source of truth for /rewind).
  const fileHistory = opts.fileHistory;

  // Report 95 R3 — the mid-turn input FIFO. Readline delivers a stdin line to
  // the pending rl.question when one exists (the prompt itself, an ask_user or
  // permission dialog); with NO question pending — a running turn, or a (ω99-166d-ii 表外-1：措辞随 #12 暂存回执中文化同族清零)
  // command's await window — the "line" event had no consumer and the input
  // was silently DROPPED. The handler below parks such lines in ONE FIFO
  // (single list, no 'now'-priority preemption — the dsh steer/followUp
  // split waits until the REPL grows a consumption lane); the main loop
  // replays them FIFO-first after the turn settles, through the SAME parsing
  // path as a typed line (commands, mentions, the submitTurn chain). Parked
  // lines never inject the RUNNING turn — that is the driver's steering lane.
  const pendingLines: string[] = [];
  // Ctrl+C during an in-flight turn interrupts the generation: abort the run's
  // AbortSignal first (rejects the in-flight fetch / loses the tool race, so
  // even a hung call settles immediately), then gen.return as belt-and-braces.
  // Ctrl+C at the idle prompt exits. Registered on BOTH process and the
  // readline interface: while the rl prompt is pending, readline captures ^C
  // in raw mode and emits its own "SIGINT" event instead of a process signal.
  let activeGen: AsyncGenerator<LoopEvent, unknown, unknown> | null = null;
  let activeAbort: AbortController | null = null;
  let interrupted = false;
  // ω99-45: the /compact summarizer's cancellation controller — non-null only
  // while a manual compaction is in flight. ^C aborts it at the same cancel
  // point that stops a run (an idle /compact has no activeGen, so the branch
  // below would otherwise not reach it); the natural-exit wake then leaves
  // the loop-head check instead of awaiting a dead compaction to the end.
  let compactAbort: AbortController | null = null;
  // ω99-316 (/btw 侧问): the REPL lane's accumulated side turns — each /btw
  // re-clones the latest state.messages and appends these after it (the
  // per-round re-clone contract; REPL-local, never persisted, never
  // state-visible).
  let replSideTurns: AgentMessage[] = [];
  const onSigint = (): void => {
    // M61 §2: Esc/^C clears /loop's PENDING wakeups only (explicit scheduled
    // tasks stay armed).
    const cleared = replLoopBox.current?.clearPendingOnEsc() ?? 0;
    if (cleared > 0) stdout.write(`⏹ /loop：已清除 ${cleared} 个待唤醒任务（显式定时任务不受影响）\n`); // ω99-166f-iii: #19-孪生（repl 的 Esc 清唤醒回执，随 driver #19 演进）
    // ω99-45: an in-flight /compact rides the same cancel point — before the
    // activeGen branch (a manual compaction runs with NO generator alive).
    compactAbort?.abort();
    if (activeGen) {
      interrupted = true;
      // Report 95 R3 (pi's "the queue never orphans" rule, editor-less form):
      // an interrupted turn CLEARS the parked-input FIFO — the abort rejects
      // the turn, so its typed-while-busy lines go with it; no orphan replay
      // at the next prompt.
      const parkedCleared = pendingLines.length;
      if (parkedCleared > 0) stdout.write(`⏹ 已清空 ${parkedCleared} 条排队输入\n`); // ω99-191: #6
      pendingLines.length = 0;
      activeAbort?.abort();
      void activeGen.return(undefined as never);
    } else {
      // 夜移 034 stage-3: wake the natural exit (the question wrapper above
      // races sigintExit; the loop-head check lands the break) instead of
      // process.exit — Node drains stdio on the natural return and the
      // session-end hook fires on the same seam /exit uses. No rl.close()
      // here: close happens once at runRepl's tail, so a mid-dialog wake
      // never strands on a closed interface.
      resolveSigintExit();
    }
  };
  process.on("SIGINT", onSigint);
  rl.on("SIGINT", onSigint);

  // Report 95 R3 — the mid-turn input park (registered once, outside the main
  // loop). This fires ONLY when no rl.question is pending (readline routes a
  // line to a pending question instead of emitting "line"), i.e. exactly the
  // windows where the line used to be dropped. The handler body is UNCHANGED
  // by ω99-35: the batcher below parks its flushed batches through this same
  // function, so a parked batch replays through the identical parsing path.
  const onParkedLine = (line: string): void => {
    pendingLines.push(line);
    stdout.write("⏸ 输入已暂存（本轮运行中）\n"); // ω99-166d-ii: #12（⏸ 暂存回执中文化）
  };
  // ω99-35 — the headless (non-TTY) input batcher. A piped stdin is BATCH
  // semantics misused as line semantics: every line became its own user turn,
  // so an injected multi-line task fragmented across turns (the model read
  // line 1 as the whole task and self-created a mission). The batcher wraps
  // the non-TTY rl wiring ONLY — TTY keeps the byte-identical line path
  // below. Standalone command/shell lines: a line that routes as a command
  // (command-table hit) or a `!` shell line when the batch is EMPTY submits
  // immediately, single-line; after content it is an interior line of the
  // message and rides with the batch (the TUI's whole-text routing).
  const headlessBatch = stdin.isTTY === true
    ? undefined
    : createHeadlessLineBatcher({
        ...(opts.headlessBatchWindowMs !== undefined ? { windowMs: opts.headlessBatchWindowMs } : {}),
        isImmediate: (line) => {
          if (parseBangCommand(line) !== undefined) return true;
          const kind = parseReplCommand(line, live.pluginCommands.map((c) => c.name), (opts.extensionCommands ?? []).map((c) => c.name), live.skills).kind;
          return kind !== "prompt" && kind !== "noop";
        },
        onPark: (batch) => onParkedLine(batch),
        write: (text) => stdout.write(text),
      });
  // The ONE line listener: TTY → the old per-line park; non-TTY → every raw
  // line enters the batcher (the idle acquire below is the batcher's take(),
  // never rl.question, so readline never swallows a line into an internal
  // question and "line" stays the single authoritative stdin source).
  const onStdinLine: (line: string) => void = headlessBatch !== undefined ? (line) => headlessBatch.push(line) : onParkedLine;
  rl.on("line", onStdinLine);

  // One agent turn (user message already composed). Isolated per turn: an
  // API/network/loop error must not kill the whole session — report it and
  // re-prompt. `plan` (M37 §1) layers the read-only whitelist onto the
  // permission gate and the plan gate onto the stop gates for THIS run only.
  const runTurn = async (turnText: string, plan: boolean, branchLink?: { readonly uuid: string; readonly parentUuid?: string }): Promise<void> => {
    // M63-C R1 (§2 prompt_id): one id per submitted prompt (REPL path).
    if (opts.promptIdBox !== undefined) opts.promptIdBox.current = randomUUID();
    // M49 §2: this turn's review-trigger facts (tool-call count + success).
    let turnToolCalls = 0;
    let turnOk = true;
    // M45 §1.5 run boundary: each submitted prompt is a fresh run — the
    // sidecar's consecutive-rejection count (and cache) resets here, exactly
    // like the driver frontends' submit-time resetRun. The REPL drives the
    // loop directly, so it owns this seam itself. 夜移 032 stage-2: the net-
    // change ledger resets on the same boundary (the driver frontends' reset
    // lives in their submit; here it is this line).
    opts.sidecar?.resetRun();
    opts.turnDiff?.resetRun();
    try {
      interrupted = false;
      // M53 §1: a branched turn carries its node link (uuid + the cut-point
      // parent) — persistence-only metadata, never serialized to the provider.
      const userTurnMessage: AgentMessage = {
        role: "user",
        content: turnText,
        ...(branchLink !== undefined
          ? { uuid: branchLink.uuid, ...(branchLink.parentUuid !== undefined ? { parentUuid: branchLink.parentUuid } : {}) }
          : {}),
      };
      state.messages.push(userTurnMessage);
      // ω99-29 T1: the onUserTurn-equivalent seam — the user's own turn hits
      // the JSONL before the first model call of THIS run (the engine's
      // early-user discipline; see persistUserTurn above).
      persistUserTurn(userTurnMessage);
      // M-Memory 弧第二半：首轮召回注入缝（幂等——冻结后零操作；REPL 直接驱动
      // loop 无 driver onRunStart，此处即「首轮前」唯一合法时机；追加语义 =
      // 前缀字节不动，注入块进本 run 第一个请求）。
      longtermMemoryRuntimeFor()?.injectAtFirstRun(state);
      // M49 §1: bounded auto-recall rides this turn's FIRST model call via
      // the MetaNote queue (projection-only — state.messages stays clean).
      const recallNote = memoryRuntime.recall(turnText);
      if (recallNote !== undefined) metaNotes.push(recallNote);
      let streamed = false;
      // Per-turn AbortController: the signal reaches provider fetches and
      // tool races, so SIGINT settles a hung call instead of waiting it out.
      const ac = new AbortController();
      // ω-2b (I2-a): the retention exclude set (compactionExempt tools keep
      // their old results through the cheap tiers; undefined = status quo).
      const retention = compactionRetentionFor(tools);
      // ω-1b: the loop-level generic large-result backstop — same session
      // spill anchor the monitor runtime uses (read_file exempt in core).
      const genericShaping = resolveGenericShapingRuntime(
        join(opts.workspaceRoot, ".wudao", "spill", opts.sessionId ?? "repl"),
        process.env,
      );
      // ω99-4c: lint/test 反射回路 — 进程级单例；未配置 reflect 节 =
      // undefined = hooks 原样（字节零变化）。
      const reflect = await reflectRuntimeFor(opts.workspaceRoot);
      // ω99-7: auto-refine 触发层 — 进程级单例；未配置 refine.auto（默认 OFF）
      // = undefined = hooks 原样（字节零变化）。receipt 走 stdout notice，不注入对话。
      const autoRefine = await refineAutoRuntimeFor(opts.workspaceRoot, {
        onNotice: (text) => { stdout.write(`${text}\n`); },
      });
      const gen = runAgentLoop(state, modelRef.current, {
        maxTurns: opts.maxTurns ?? maxTurns(),
        gates: plan ? { ...(opts.gates ?? {}), plan: true } : opts.gates,
        // M53 §5: the --no-loop-safety ablation seam.
        ...(isFeatureAblated("loop-safety") ? { loopSafety: false } : {}),
        ...(genericShaping !== undefined ? { genericResultShaping: genericShaping } : {}),
        // ω-4b: the reflection fork at second loop verdicts (core default
        // OFF; the REPL wiring opts in; --no-loop-reflection ablates).
        ...(isFeatureAblated("loop-reflection") ? {} : { reflection: {} }),
        canUseTool: canUseTool(plan),
        // ω99-29 T1: the pre-dispatch durability barrier (core-native; the
        // engine's onBeforeToolDispatch shape) — the ordered prefix (the user
        // turn + this tool-carrying assistant) lands on the JSONL BEFORE any
        // gate/execution runs, so a crash mid-tool leaves a durable unmatched
        // tool_use (resume's repair answers it with the UNKNOWN-outcome text).
        // A rejected append fails the batch CLOSED inside core — nothing
        // executes. Projection markers never persist (selectMessagesToPersist).
        onBeforeToolDispatch: persistOrderedPrefix,
        // M62 §7: autoCompactEnabled:false runs the loop WITHOUT compaction
        // (manual /compact still works — it calls the compactor directly).
        ...(opts.compactionEnabled === false
          ? {}
          : {
              compaction: {
                contextWindowTokens: windowRef.current,
                // 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线 ——
                // 平比帽（ratio×window）永远在；outputReserveTokens 在场
                // （已画像窗口语义 + 请求帽已知）时触发线收紧到
                // min(ratio×window, window − reserve − headroom)。每次 run 从
                // liveConfig 重读（/model //provider 切换自然生效）。
                ...compactionThresholdFields(liveConfig, compactionSettings),
                // 借鉴弧 B1（a reference project C1）：压缩经济学定价（catalog > env > 缺省；
                // 每次 run 重解析，/provider 切换自然生效）。
                cachePricing: resolveSessionCachePricing(liveConfig.provider, liveConfig.model),
                classifySkillRead: createSkillReadClassifier(live.skills),
                ...(compactInstructionsRider !== undefined ? { compactInstructions: compactInstructionsRider } : {}),
                // M58 §C#12: the LIVE config's effort (a settled /model //effort
                // switch counts) rides the tier-2 summary requests.
                ...(liveConfig.reasoningEffort !== undefined ? { reasoningEffort: liveConfig.reasoningEffort } : {}),
                // ω-2b (I1-c): the live config's window semantics (a settled
                // /model provider switch counts) gate the admission clip.
                ...(liveConfig.windowMode !== undefined ? { windowMode: liveConfig.windowMode } : {}),
                // ω-2b (I2-a): the retention exclude set (compactionExempt
                // tools keep their old results through the cheap tiers).
                ...(retention !== undefined ? { retention } : {}),
              },
            }),
        signal: ac.signal,
        // M61 §3: the goal evaluator composes at the stop-hook position
        // (user-configured hook first; its block wins).
        // ω99-4c: reflect composes INNERMOST (last-consulted) — the user
        // hook's and the goal evaluator's stop semantics outrank the
        // reflection's block; reflect may block only when both allowed.
        // ω99-7: auto-refine composes OUTERMOST as a pure OBSERVER — the
        // existing chain (user hook → goal evaluator → reflect) decides the
        // stop; only an actually-stopping run can trigger a refine.
        hooks: observeAutoRefineOnHooks(composeReflectHooks(replGoal !== undefined
          ? {
              ...live.hooks,
              onRunStop: async (stopState) => {
                let user: import("@wudao-org/core").StopHookDecision = "allow";
                try { user = (await live.hooks?.onRunStop?.(stopState)) ?? "allow"; } catch { user = "allow"; }
                if (typeof user === "object") return user;
                return replGoal.onStop(stopState);
              },
            }
          : live.hooks, reflect), autoRefine, () => modelRef.current),
        // M58 §C#8: external-change probe + the git-status fingerprint, both
        // at turn boundaries (beforeModelCall), both projection-only.
        beforeModelCall: async () => {
          if (prober !== undefined) await prober.probe();
          await gitProber.probe();
        },
        // M61 §1: scheduled fires ride the steering channel — drained between
        // turns, before the model input is built (turn-tail append).
        // M64-A §A: accepted peer messages ride the same lane, after cron.
        // ω-4a: monitor events ride the same lane, after peer deliveries.
        steering: { take: () => cronRuntime.takeInjection() ?? peerRuntime.takeInjection() ?? monitorRuntime.takeInjection() },
        metaNotes: { take: () => metaNotes.shift() },
        // M62 §1: path-gated context rules (absent when the workspace has none).
        ...(replRuleMatcher !== undefined ? { contextRules: { match: replRuleMatcher } } : {}),
      });
      // ω99-132: tool_call_finished carries only toolCallId (core loop.ts's
      // event shape), but the file card's name gate needs the tool NAME —
      // resolve it from the started event. runTurn scope: a call's started
      // and finished always pair inside one turn's event stream, so a
      // per-turn Map can neither leak ids into later turns nor alias a
      // reused id (a module-level Map that missed a delete could).
      const toolNamesById = new Map<string, string>();
      activeGen = gen;
      activeAbort = ac;
      try {
        for await (const event of gen) {
          // P2-15: the OTel observer rides the event stream (self-isolated —
          // it reads only the allowlisted turn/tool fields, never deltas).
          telemetry?.observe(event);
          if (event.type === "reasoning_delta") {
            // feed the EXACT bytes written — the trailing reset escape decides
            // whether the log line is truly closed, not the text alone.
            if (ge("info")) { const chunk = `\x1b[2m${event.text}\x1b[0m`; stdout.write(chunk); breakGuard.feed(chunk); }
          } else if (event.type === "assistant_delta") {
            if (ge("info")) { stdout.write(event.text); breakGuard.feed(event.text); streamed = true; }
          } else if (event.type === "usage" && ge("info")) {
            stdout.write(`  ${formatUsageLine(event.usage)}\n`);
          } else if (event.type === "model_call_finished" && event.hasToolCalls && ge("info")) {
            stdout.write(`\n← 模型（${event.toolCallCount} 个工具调用）\n`); // ω99-188: #6
          } else if (event.type === "tool_call_started" && ge("info")) {
            // ω99-132: register the name now — finished events never carry
            // one (the card below resolves it from this Map).
            toolNamesById.set(event.toolCallId, event.toolName);
            const s = summarizeToolCall(event.toolName, event.input);
            stdout.write(`🔧 ${event.toolName}${s ? ": " + truncate(s, 120) : ""}\n`);
          } else if (event.type === "tool_call_finished") {
            turnToolCalls += 1;
            // ω99-132: resolve + retire the started name (the Map stays
            // bounded by in-flight calls; a finished-without-started miss is
            // undefined → no card, the preview line renders — fail-safe).
            const startedName = toolNamesById.get(event.toolCallId);
            toolNamesById.delete(event.toolCallId);
            // M49 §4: taint-track the finished result (WeakMap side channel
            // over the message the loop just pushed).
            for (let i = state.messages.length - 1; i >= 0; i -= 1) {
              const m = state.messages[i];
              if (m !== undefined && m.role === "tool" && m.toolCallId === event.toolCallId) {
                taint.record(m, event.provenance);
                break;
              }
            }
            // ω99-29 T2: multi-line bodies keep their line structure (the
            // continuation indent aligns under the ↳ payload); truncate()'s
            // whitespace collapse stays the one-line-preview tool it is.
            // ω99-132: debug stays UNTOUCHED and keeps the full body INSTEAD
            // of the card — debug is the 看全文 lane; the file card is the
            // info-level experience layer (the same no-double-render rule
            // the preview line already follows).
            if (ge("debug")) stdout.write(`    ↳ ${event.isError ? "[error] " : ""}${truncateMultiline(event.result, 400).replace(/\n/g, "\n      ")}\n`);
            // ω99-32 T2: the info-level single-line preview — TUI transcript
            // parity (tui/app.tsx:365's `  ↳ [error] <preview>` dim line, the
            // same RESULT_PREVIEW_CHARS budget the driver feeds the TUI's
            // entry.resultPreview). The default level can finally SEE each
            // tool result's one-line shape — the ω99-26 campaign's
            // deterministic grep acceptance no longer needs --debug. Debug
            // prints the full multi-line body INSTEAD (no double render).
            // An empty result stays silent unless it errored (the TUI's own
            // hide-empty rule).
            // ω99-132: a name-gated deliverable receipt (the ω99-125
            // extractor) renders the three-line file card INSTEAD of that
            // preview — the REPL twin of the TUI's ω99-131 card, same copy
            // (icon/KB via the TUI module's own pure helpers): the raw
            // receipt JSON is screen pollution and never said where the file
            // is or how to open it. The card rides the preview line's own
            // convention — written, never fed to breakGuard (the guard
            // tracks only streamed model text). Every other result (not
            // gated, no receipt shape, or isError) keeps the exact line
            // below — the zero-drift pin.
            else if (ge("info")) {
              const receipt = startedName !== undefined && !event.isError ? extractFileReceipt(startedName, event.result) : undefined;
              if (receipt !== undefined) {
                // raw result = 中文句 + "\n" + JSON by construction — the
                // first non-empty line IS the sentence (no `{` cut, unlike
                // the TUI's collapsed preview; the 131 pin: the gated
                // family's sentences never contain a brace).
                const sentence = event.result.split("\n").find((l) => l.trim() !== "") ?? "";
                stdout.write(`\x1b[36m  ▣ ${fileIconOf(receipt.name)} ${receipt.name}（${formatKb(receipt.bytes)}）\x1b[0m\n`);
                stdout.write(`\x1b[2m  ${sentence}\x1b[0m\n`);
                stdout.write(`\x1b[2m  位置：${receipt.path}　打开：open "${receipt.name}"\x1b[0m\n`);
              } else {
                const preview = truncate(event.result, RESULT_PREVIEW_CHARS);
                if (preview !== "" || event.isError) stdout.write(`\x1b[2m  ↳ ${event.isError ? "[error] " : ""}${preview}\x1b[0m\n`);
              }
            }
          } else if (event.type === "compacted") {
            // ω99-29 T1: the tier-2 summary marker persists AT EVENT TIME —
            // the engine's onCompacted discipline (append-only stays
            // authoritative; selectMessagesToPersist later skips it by its
            // SUMMARY_MARKER filter, so exactly one line). The in-memory
            // state.messages copy is a projection — disk is the record.
            // Level-independent: persistence never rides the render gate
            // (the old comment's "nothing to persist" was true before this
            // seam existed; the REPL now owns the same store the boot's
            // resolveSession read from).
            if (event.summaryMessage !== undefined) {
              replPersistStore.append(persistSid(), event.summaryMessage).catch(persistNotice);
            }
            if (ge("info")) {
              stdout.write(`${formatCompactedLine(event.tier, event.trigger, event.beforeTokens, event.afterTokens)}\n`);
              // M63-B (A-round a): the session continues across an AUTO
              // compaction boundary — the SessionStart face fires here (the
              // REPL drives the loop directly; the driver fires its own).
              fireSessionStart("compact");
            }
          } else if (event.type === "compact_deferred" && ge("info")) {
            // M63-B (A-round a): a PreCompact hook deferred this compaction.
            stdout.write(`\x1b[2m⏸ 压缩已推迟：${truncate(event.reason, 120)}\x1b[0m\n`); // ω99-166f-iii: #7-孪生（repl 事件回执）
          } else if (event.type === "prompt_blocked") {
            // M63-B (A-round b): the user-channel notice for a blocked prompt.
            stdout.write(`⛔ 提示词被钩子拦截：${truncate(event.reason, 80)}\n`); // ω99-166f-iii: #6-孪生（repl 事件回执；o99-32:235 钉读此处）
          } else if (event.type === "meta_note" && ge("info")) {
            // M32: a system note (e.g. a <file_changed> diff) rode the last
            // tool_result tail — the model saw the full payload.
            stdout.write(`\x1b[2m↳ ${truncate(event.text, 120)}\x1b[0m\n`);
          } else if (event.type === "defer_loaded" && ge("info")) {
            // M35 §1: the run's one load_tools call applied.
            stdout.write(`\x1b[2m↳ 工具已加载：${event.names.join(", ")}（一次性工具集变更）\x1b[0m\n`); // ω99-166f-iii: #1-孪生（repl defer_loaded 回执）
          } else if (event.type === "context_rule_loaded" && ge("info")) {
            // M62 §1: a gated rule's body entered the history after a matching read.
            stdout.write(`\x1b[2m↳ 规则已加载：${event.source}\x1b[0m\n`); // ω99-176 走查小刀：词表与 index.ts:2081 孪生归一（166f-iii 旧译「已加载」裸形→补宾语+冒号，对齐 repl:1904「工具已加载：」句式）
          } else if (event.type === "reflection_fork" && ge("info")) {
            // ω-4b: the loop-safety challenger settled — one-line notice (the
            // adjudication's durable JSONL entry stays the driver front-ends'
            // lane; the REPL renders it here).
            const tail = event.directive !== undefined
              ? event.directive
              : event.rationale !== undefined
                ? event.rationale
                : "";
            stdout.write(`\x1b[2m↳ 循环安全挑战者：${event.outcome}${tail !== "" ? ` —— ${truncate(tail, 80)}` : ""}\x1b[0m\n`); // ω99-176: #6
          }
        }
      } finally {
        activeGen = null;
        activeAbort = null;
        // M61 §2: each settled turn re-arms the /loop's next wakeup.
        void replLoopBox.current?.onRunEnd();
        // M61 §3: the stall guard (the REPL drives the loop via for-await and
        // cannot see the terminal — onRunEnd infers the stall from the last
        // not-yet verdict).
        replGoal?.onRunEnd({});
      }
      if (interrupted) {
        // Session consistency (same rule as the error turn): an aborted turn
        // appends a synthetic assistant reply so the history never ends on a
        // user message (the next prompt would create two consecutive user
        // messages, which providers reject).
        turnOk = false;
        state.messages.push({ role: "assistant", content: "(interrupted)" });
        // Repair toolCalls orphaned by a tool-phase abort (provider-legal
        // sequence for the next turn — same rule as session load).
        state.messages = repairOrphanedToolCalls(state.messages);
        stdout.write("\n⚠️ 已中断\n"); // ω99-166b: #5 散面中文化（interrupted→已中断；单 \n 原样）。
      }
      else if (streamed) stdout.write("\n");
      else {
        const last = state.messages.at(-1);
        if (last?.role === "assistant") stdout.write(`${last.content}\n`);
      }
      // 夜移 032 stage-2: the turn's net file-change receipt — same settle
      // seam as the driver frontends' notice (preview line, dim; full git
      // diff stays in the tracker — the readline REPL shows the one line).
      // Ungated: partial writes are evidence, not debug trivia; ok / 中断 /
      // 出错 turns all land here (the settle is shared).
      if (opts.turnDiff !== undefined) {
        const netFiles = opts.turnDiff.files();
        if (netFiles.length > 0) {
          const netRender = renderTurnDiff(netFiles, (p) => relative(opts.workspaceRoot, p));
          stdout.write(`\x1b[2m${netRender.text}\x1b[0m\n`);
        }
      }
      // M24 per-turn summary (session-cumulative weighted hit rate).
      const cacheSummary = model.stats.summaryLine();
      if (cacheSummary && ge("info")) stdout.write(`${cacheSummary}\n`);
      stdout.write("\n");
      // M37 §1: a finished plan run leaves its artifact under review — the
      // latest board is the plan; a board-less plan run just reports that.
      if (plan) {
        const board = todoSource.current(state.messages);
        if (board !== undefined) {
          stdout.write(`${board}\n${PLAN_REVIEW_HINT}\n\n`);
          planBoard = board;
        } else {
          stdout.write("（plan 运行未产出看板——无可审查；/plan <goal> 重试）\n\n"); // ω99-166d-ii: #1（plan 无看板回执中文化）
          planBoard = null;
        }
      }
    } catch (err) {
      turnOk = false;
      if (interrupted || (err instanceof Error && err.name === "AbortError")) {
        // Abort-shaped throw (belt-and-braces path): same bookkeeping as the
        // interrupted terminal above — never surfaced as a turn error.
        state.messages.push({ role: "assistant", content: "(interrupted)" });
        stdout.write("\n⚠️ 已中断\n\n"); // ω99-166b: #6 散面中文化（尾 \n 差异保留）。
      } else {
        // A failed turn still appends a synthetic assistant reply so the history
        // never ends on a user message (the next prompt would otherwise create
        // two consecutive user messages, which providers reject).
        state.messages.push({ role: "assistant", content: `(error: ${err instanceof Error ? err.message : String(err)})` });
        stdout.write(`\n⚠️ 错误：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166b: #7 散面中文化（error:→错误：全角冒号；err 三元原样）。
      }
    }
    // ω99-29 T1: the onRunComplete-equivalent seam — the turn's tail pass.
    // One choke point covers every ending (the normal for-await fall-through,
    // the interrupted terminal above, and the catch's error terminals — all
    // three paths reach here with state.messages final). AWAITED, not
    // fire-and-forget: the turn serializer holds the next turn until runTurn
    // resolves, so the await makes "run N's tail on disk before turn N+1's
    // user line" a hard ordering guarantee (the engine's fire-and-forget
    // relies on the driver's submit sequencing; the REPL owns it here).
    // Failures warn (persistNotice) — persistence must not kill the session.
    await persistRunTail();
    // M49 §1: the turn may have written memories — refresh the recall pool.
    void memoryRuntime.refresh();
    // M49 §2: the background review fork — a successful ≥3-tool-call turn
    // spawns the shareContext reviewer; the 🧠 receipt prints on settle.
    if (turnOk && turnToolCalls >= REVIEW_MIN_TOOL_CALLS && opts.agentsRegistry !== undefined) {
      void spawnBackgroundReview({
        workspaceRoot: opts.workspaceRoot,
        model: modelRef.current,
        registry: opts.agentsRegistry,
        systemPrompt: state.systemPrompt,
        messages: state.messages,
        tools: state.tools,
        onReceipt: (line) => stdout.write(`${line}\n`),
      });
    }
    // ω-4f (design 84 §3(f)): Dream memory consolidation — the SAME
    // turn-settle seam, immediately after the review fork. Due-gated inside
    // the spawn (kill switch / ≥8 unprocessed / 30-min interval /
    // single-flight); the 🧠 receipt prints on settle, the review's channel.
    if (turnOk && opts.agentsRegistry !== undefined) {
      void spawnDreamRun({
        workspaceRoot: opts.workspaceRoot,
        model: modelRef.current,
        registry: opts.agentsRegistry,
        onReceipt: (line) => stdout.write(`${line}\n`),
      });
    }
    // F1 item 3: the settling turn drains one parked programmatic submit (the
    // fire-on-idle mirror — a wake parked while this turn ran starts now).
    programmaticSubmitGate.settleDrain();
  };

  // Report 95 R1: admission is ONE entry point now — every turn submit (the
  // interactive call sites below, the gate's fire-and-forget run, the settle
  // drain) enters the chain, so a submit landing in an expand window
  // (activeGen still null while a turn is about to start) queues behind it
  // instead of racing it. runTurn itself is unchanged: only the door changed.
  const { submitTurn } = createTurnSerializer(
    runTurn,
    (text) => stdout.write(`⏸ 已排队（本轮运行中）：${truncate(text.split("\n")[0] ?? "", 80)}\n`), // ω99-166d-ii: #13（⏸ 排队回执中文化）
  );

  // F1 item 3: the busy-guard over the programmatic seams. Busy = a turn in
  // flight (activeGen — the same fact the M61 cronPoll fire-on-idle guard
  // reads). The park notice is one line; the payload waits for the tail drain
  // above (a skipped wake would be LOST — the runtime queue already handed
  // it over at the cronPoll take).
  const programmaticSubmitGate = createProgrammaticSubmitGate(
    (text) => { void submitTurn(text, false); },
    () => activeGen !== null,
    (text) => stdout.write(`⏸ 已暂存（本轮运行中）：${truncate(text.split("\n")[0] ?? "", 80)}\n`), // ω99-166d-ii: #14（⏸ 程序化暂存回执中文化）
  );

  // M37 §1: the plan board awaiting review (null = none). `ok` executes it,
  // `改 <意见>` re-runs plan mode with the feedback; other input stays a normal
  // prompt and the board remains under review.
  let planBoard: string | null = null;
  // ω99-51 (session projection seam): the todo domain source this REPL's
  // plan-review seam reads (byte-equal to the retired lastTodoBoard
  // backscan; docs/research/106-*.md). One source per REPL session.
  const todoSource = createTodoBoardSource();
  // M53 §1: an armed /edit — the index into state.messages where the next
  // submitted prompt branches (null = normal linear turn).
  let pendingEditIndex: number | null = null;
  // M55 §A3: wall-clock origin for /cost (the REPL's session start).
  const replStart = Date.now();
  // M55 §A1: the /init draft awaiting confirmation (null = none); `ok`
  // writes it, any other input stays a normal prompt (the draft keeps waiting).
  let replInitDraft: string | null = null;
  // M55 §B9: a parked /export overwrite (null = none); `ok` writes it, any
  // other input cancels (same convention as the /init draft).
  let replExportPending: { readonly path: string; readonly content: string } | null = null;
  // M55 §C1: added workspace directories for the session (live set, not persisted).
  const replAddedDirs: string[] = [];
  // M58 §C#12: a pending bang capture — the command+output context block the
  // NEXT submitted prompt carries (consumed on the first real prompt).
  let replBangContext: string | null = null;
  // M61 §3: the REPL /goal controller — its evaluator rides the run-stop
  // hook position (composed into runTurn's loop options), entries persist to
  // the session store, verdicts print as they land.
  // ω99-29: the goal entries ride the SAME store instance the conversation
  // seam owns (one write queue per root — goal entries and messages land
  // strictly in issue order).
  const replGoalStore = replPersistStore;
  const replGoal = opts.workspaceRoot !== undefined
    ? createGoalController({
        workspaceRoot: opts.workspaceRoot,
        sessionId: () => opts.sessionId ?? "repl",
        getMessages: () => state.messages,
        // M61 review fix: matrix-cheap resolution like the driver/headless
        // (fallback = the live session model at effort=low inside the
        // controller), plus the skip-while-background rule.
        evaluator: buildEvaluatorModel(model, {
          provider: liveConfig.provider,
          model: liveConfig.model,
        }, process.env),
        backgroundBusy: () => (opts.agentsRegistry?.status() ?? []).some((b) => b.status === "queued" || b.status === "running"),
        appendEntry: async (entry) => {
          await replGoalStore.appendEntry(opts.sessionId ?? "repl", entry);
        },
        notify: (text) => stdout.write(`${text}\n`),
        env: process.env,
      })
    : undefined;
  // ω99-13: hand the controller to the model wrapper's usage observer above
  // (the --budget metering seam).
  replGoalBox.current = replGoal;

  // ω99-15: the mission campaign controller — restores the workspace's
  // active mission at creation (doing→todo + notice through the same stdout
  // notice channel the goal uses).
  replMissionBox.current = opts.workspaceRoot !== undefined
    ? await createMissionController({
        workspaceRoot: opts.workspaceRoot,
        notify: (text) => stdout.write(`${text}\n`),
        // ω99-18: bundle mount/unmount rides the EXISTING cache-aware swap
        // seam (sink fan-out + busy-run parking + prefix invariants all
        // inherited; swap sink/replaceExtensions/buildSystemPrompt untouched).
        // ω99-24 B: the TYPED reason rides along so the seam can declare the
        // cost on the next usage row.
        onBundlesChanged: async (reason) => {
          await rescanExtensionsAt(opts.workspaceRoot!, reason);
        },
      })
    : undefined;

  // M61 §2: the /loop controller (submit goes through runTurn; each settled
  // turn re-arms the next wakeup from runTurn's finally).
  replLoopBox.current = createLoopController({
    cron: cronRuntime,
    workspaceRoot: opts.workspaceRoot,
    skills: live.skills,
    // F1 item 3: /loop rounds go through the busy-guard — a round submitted
    // while another turn is in flight parks and runs at its settle (the M61
    // driver's submitCore parks a busy submit the same way).
    submit: (prompt) => {
      programmaticSubmitGate.submit(prompt);
    },
    notify: (text) => stdout.write(`${text}\n`),
  });

  try {
    // M61 §1: fire-on-idle — a scheduled task that armed while no turn is in
    // flight submits itself here. rl.write feeds the readline line buffer, so
    // the pending (or next) `wudao> ` question receives it as a normal input
    // line: the same parsing, mentions and turn machinery as a human line.
    // Newlines collapse (one input line); the steering drain carries the
    // verbatim multi-line form for mid-turn fires.
    const cronPoll = setInterval(() => {
      if (activeGen !== null) return;
      const injection = cronRuntime.takeInjection() ?? peerRuntime.takeInjection() ?? monitorRuntime.takeInjection();
      if (injection === undefined) return;
      const icon = injection.startsWith("[peer message") ? "📬" : injection.startsWith("[monitor") ? "👁" : "⏰";
      stdout.write(`${icon} ${truncateSafe(injection.split("\n")[0] ?? "", 80)}\n`);
      if (injection.startsWith("[monitor")) {
        // F5 (review 57): a monitor wake is the hardened multi-line wrapper —
        // hand it to the turn machinery VERBATIM (the /loop controller's
        // programmatic submit shape), never the newline-flattening rl.write
        // path cron/peer use (their payloads are line-shaped).
        // F1 item 3: through the busy-guard — the top-of-poll activeGen check
        // and this take are one synchronous tick, but a turn that started in
        // between (or the /loop seam) must park, never run concurrently.
        programmaticSubmitGate.submit(injection);
        return;
      }
      rl.write(`${injection.replace(/\n/g, " ")}\n`);
    }, 1_000);
    cronPoll.unref?.();
    rl.on("close", () => {
      // ω99-35: EOF on the piped stdin — flush the in-flight batch through
      // the normal delivery (it still becomes its turn), then arm the exit
      // sentinel for the next idle acquire. TTY sessions never route here
      // with a batch in flight (the batcher does not exist on that path).
      headlessBatch?.notifyClose();
      clearInterval(cronPoll);
      cronRuntime.stop();
      // ω-4a: reap watched children + close watchers before the process exits.
      monitorRuntime.stop();
      // M64-A §A: close the inbox + unregister before the process exits.
      void peerRuntime.stop();
    });

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // 夜移 034 stage-3: the SIGINT wake lands here — the SAME natural exit
      // /exit takes (session-end hook + handler cleanup + Node's stdio
      // drain on the return). Checked at the head so a wake that fires
      // mid-command-await (or resolves a parked-dialog "" through the deny
      // parsers) exits on the next pass instead of spinning on no-ops.
      if (sigintExitRequested) {
        fireSessionEnd("exit");
        break;
      }
      // Report 95 R3: parked lines replay FIRST, in FIFO order — a line
      // parked mid-turn becomes the next turn's input through this same
      // parsing path (commands, mentions, the submitTurn chain), never a
      // lost byte. No `wudao> ` prompt prints for a replay: the line is
      // already in hand.
      const parked = pendingLines.shift();
      let line: string;
      if (parked !== undefined) {
        line = parked;
      } else if (headlessBatch !== undefined) {
        // ω99-35: the non-TTY idle acquire — the batcher's take() (prompt
        // printed there, byte-identical to rl.question's query write) racing
        // the SIGINT wake exactly like the wrapped rl.question does. `null`
        // is the EOF-drained sentinel: the in-flight batch was flushed and
        // consumed, so the session ends through the same seam /exit takes.
        const got = await Promise.race([headlessBatch.take("wudao> "), sigintExit.then(() => "")]);
        if (got === null) {
          fireSessionEnd("exit");
          break;
        }
        line = got;
      } else {
        line = await rl.question("wudao> ");
      }
      // M58 §C#12: `!cmd` — a user-initiated shell line (no permission gate:
      // the human typed it, same trust class as their terminal). Echo the
      // capped capture; park it as the next prompt's context prefix.
      const bang = parseBangCommand(line);
      if (bang !== undefined) {
        const r = await runBangCommand(bang);
        stdout.write(`${formatBangEcho(r)}\n\n`);
        replBangContext = buildBangContextPrefix(r);
        continue;
      }
      const cmd = parseReplCommand(line, live.pluginCommands.map((c) => c.name), (opts.extensionCommands ?? []).map((c) => c.name), live.skills);
      // M63-B R1 fix (6): /exit ends the session (the REPL's own seam).
      if (cmd.kind === "exit") {
        fireSessionEnd("exit");
        break;
      }
      if (cmd.kind === "noop") continue;
      if (cmd.kind === "help") {
        // M42 §4: /help renders from the same listSlashCommands source the
        // Tab completer and the TUI menu use, closing with keys + live mode.
        stdout.write(`${formatSlashHelp(slashCommands, {
          mode: modeLabel(modeRef.mode),
          frontend: "repl",
          // ω99-161: 键位图例描述词中文化（键名 token Enter/Tab/shift+tab 原样）。
          keysLine: "Enter 发送 · Tab 补全 /命令 · shift+tab 切换模式",
        })}\n\n`);
        continue;
      }
      // M33 §3: the picker is a TUI feature (the readline REPL keeps no session
      // store); steer the user to the flag path instead.
      if (cmd.kind === "resume") {
        stdout.write("（会话选择器仅 TUI 有；重启用 wudao --resume <id> 或 --continue）\n\n"); // ω99-166d-ii: #2（会话选择器回执中文化）
        continue;
      }
      if (cmd.kind === "clear") {
        // M42 §4: y/N confirmation before wiping (防误清). Non-TTY keeps the
        // old behavior — there is nobody to confirm with.
        // ω99-159: 确认文案中文化（行尾空格保留——readline 惯例；y/n 分支与
        // parseAskAnswer 语义零动，[y/N] legend 原样）。
        const confirmed = stdin.isTTY !== true
          ? true
          : parseAskAnswer(await rl.question("清空历史？ [y/N] ")).kind !== "deny";
        if (!confirmed) {
          // ω99-161: 拒绝回执中文化（与 TUI 侧 notify 同串；\n\n 后缀原样）。
          stdout.write("(已取消清空)\n\n");
          continue;
        }
        // ω99-32 T1: the routed /clear rotates the session identity (driver
        // M80 parity — the ONE persistence-layer contract every frontend
        // honors). The PRE-clear id's JSONL is sealed by exactly one
        // clear_boundary (append-only: the old bytes never move, the boundary
        // lands on the tail), and every later persistence seam (user turn /
        // pre-dispatch barrier / run tail / compacted summaries) reads the
        // rotated box so the conversation continues on the fresh segment.
        // Chained AFTER earlyUserPersist so a still-settling user append can
        // never land behind the seal; the reassigned earlyUserPersist makes
        // the next turn's barrier serialize after the seal too. In-memory
        // behavior is unchanged (the wipe + the M63-A fires below).
        const clearedSid = sessionBox.current;
        // ω99-54: rotated ids come from the core UUIDv7 factory — same seam
        // as the CLI's other session ids (time-sortable in list()).
        const nextSid = newSessionId();
        earlyUserPersist = earlyUserPersist
          .then(() => appendSessionEntry(replPersistStore, clearedSid, buildClearBoundaryEntry(nextSid)))
          .catch(persistNotice);
        sessionBox.current = nextSid;
        // The boot-bound seams rebind to the fresh segment (index.ts wires
        // the terminal audit sink + the extension session binding).
        opts.onSessionRotated?.(clearedSid, nextSid);
        // ω99-34: the cache wrapper's diff state is pre-clear context too —
        // without this reset the fresh session's first call diffs its small
        // prefix against the OLD session's tail request and misreports
        // `⚠️ cache break at user message (turn 0)` (campaign :1709). The
        // reset is explicit notification, never path inference; the first
        // post-clear call instead names its cold start: one
        // `ℹ️ expected: session-rotation (cold start)` line. Stats stay
        // cumulative (the summary ledger spans rotations).
        modelRef.current.rotate();
        // The fresh segment's JSONL is empty — its identity-dedup base starts
        // empty with it (the cleared messages are gone from memory too).
        persistBase.length = 0;
        state.messages = [];
        planBoard = null;
        // ω99-65: /clear also ends the approval-gate posture (a fresh session
        // starts unarmed — the same /clear disarm the driver carries).
        disarmApprovalGate("/clear");
        // ω99-73: and the session allowlist dies with the boundary too — the
        // finer-grained `a` receipts must not outlive the posture the gate's
        // disarm just ended (M63-A session semantics made mechanical; `p`
        // rules live in .wudao/settings.json and are untouched here).
        sessionAllowlist.clear();
        // M63-A: /clear is a session boundary (the REPL's own — no driver).
        fireSessionStart("clear");
        // M63-B R1 fix (6): the cleared session ENDS here.
        fireSessionEnd("clear");
        // ω99-161: 清空回执中文化（与 web /clear 回执同串「历史已清空」）。
        stdout.write("(历史已清空)\n\n");
        continue;
      }
      // M61 §2: /loop [interval] [prompt] — fixed / dynamic / stop.
      if (cmd.kind === "loop") {
        const controller = replLoopBox.current;
        if (controller === undefined) {
          stdout.write("（无调度器——/loop 需要 cron 运行时）\n\n"); // ω99-166d-ii: #3（无调度器回执中文化）
        } else {
          try {
            stdout.write(`${await controller.command(cmd.args)}\n\n`);
          } catch (err) {
            stdout.write(`⚠️ /loop 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #1 failed 回执中文化（failed:→失败：全角冒号；斜杠 token/err 插值/\n\n 原样）。
          }
        }
        continue;
      }
      // M61 §3: /goal <condition> | status | clear.
      if (cmd.kind === "prompt") replGoal?.onUserPrompt();
      if (cmd.kind === "goal") {
        const goal = replGoal;
        if (goal === undefined) {
          stdout.write("（此 REPL 无 goal 界面——/goal 需要 run-stop 钩子位）\n\n"); // ω99-166d-ii: #4（无 goal 界面回执中文化）
        } else {
          const parsed = parseGoalCommand(cmd.args);
          try {
            if (parsed.kind === "status") stdout.write(`${goal.status()}\n\n`);
            else if (parsed.kind === "clear") stdout.write(`${goal.clear()}\n\n`);
            else if (parsed.kind === "usage") stdout.write(`${parsed.message}\n\n`);
            else {
              // M61 review fix: gate the follow-up turn on the SET's notice —
              // a failed set (hooks disabled, >4000 chars, trust gate) must
              // not submit the condition as a plain prompt.
              const notice = await goal.set(parsed.condition, { gate: parsed.gate, budgetTokens: parsed.budgetTokens });
              stdout.write(`${notice}\n\n`);
              if (!notice.startsWith("⚠️")) await submitTurn(parsed.condition, false);
            }
          } catch (err) {
            stdout.write(`⚠️ /goal 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #2 failed 回执中文化。
          }
        }
        continue;
      }
      // ω99-15: /mission <objective> | bare status | clear aliases — the
      // task campaign's human face (auto semantics: clear abandons
      // directly, no confirmation round).
      if (cmd.kind === "mission") {
        const mission = replMissionBox.current;
        if (mission === undefined) {
          stdout.write("（此 REPL 无任务战役界面——/mission 需要工作区根）\n\n"); // ω99-166d-ii: #5（无任务战役界面回执中文化）
        } else {
          const parsed = parseMissionCommand(cmd.args);
          try {
            if (parsed.kind === "status") stdout.write(`${mission.status()}\n\n`);
            else if (parsed.kind === "clear") stdout.write(`${await mission.abandon()}\n\n`);
            else stdout.write(`${await mission.start(parsed.objective)}\n\n`);
          } catch (err) {
            stdout.write(`⚠️ /mission 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #3 failed 回执中文化。
          }
        }
        continue;
      }
      // M61 §4: /schedule — the durable task group. The REPL has no resident
      // daemon (spawning headless runs is the `wudao ui` host's job), so it
      // renders the store read-only and points add/rm at the host (ω99-5a:
      // pause/unpause/run too — every non-list verb falls here).
      if (cmd.kind === "schedule") {
        const parsed = parseScheduleCommand(cmd.args);
        if (parsed.kind === "bad") {
          // ω99-164: A2 usage 前缀中文化；ω99-166d-i: 缝A — parsed.error 自带 用法： 头（schedules.ts 模块串），拆包裹防双头。
          stdout.write(`${parsed.error}\n\n`);
        } else if (parsed.kind === "list") {
          try {
            const store = await loadSchedulesStore({ workspaceRoot: opts.workspaceRoot });
            stdout.write(`${formatDurableList(store.tasks)}\n\n`);
          } catch (err) {
            stdout.write(`⚠️ ${err instanceof Error ? err.message : String(err)}\n\n`);
          }
        } else {
          stdout.write("（durable 任务由 `wudao ui` 常驻宿主运行——启动它来增删/暂停/执行；/schedule list 在此读存储）\n\n"); // ω99-166d-ii: #6（durable 宿主指引中文化）
        }
        continue;
      }
      // M49 §1: /memory [list|del <id>|ok <id>] — the memory store's command
      // face (same engine the driver-level command uses).
      // M-Memory 弧第二半：新动词面（search/save/forget/list/refresh/on/off）
      // 先走长期记忆；旧动词（del/ok/edit/dream）回落 M49 原面。
      if (cmd.kind === "memory") {
        try {
          const lts = longtermMemoryRuntimeFor();
          const ltsText = lts === undefined
            ? undefined
            : await runLongtermMemoryVerb({ workspaceRoot: opts.workspaceRoot, verbArgs: cmd.args, runtime: lts, state });
          if (ltsText !== undefined) {
            stdout.write(`${ltsText}\n\n`);
            continue;
          }
          // ω-4f: the dream verb needs the session model + registry (other
          // verbs ignore it; a registry-less session gets the usage line).
          stdout.write(`${await runMemoryCommand(
            opts.workspaceRoot,
            cmd.args,
            opts.agentsRegistry !== undefined ? { model: modelRef.current, registry: opts.agentsRegistry } : undefined,
          )}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ memory 命令失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #4 failed 回执中文化（command→命令）。
        }
        continue;
      }
      // ω99-3a: /refine — the Continual Harness session refiner. Threads the
      // session model + live trajectory (the /btw lane's modelRef pattern;
      // the dream verb's ctx-optional shape lives inside runRefineCommand
      // for the frontends that have no resident model).
      if (cmd.kind === "refine") {
        try {
          stdout.write(`${await runRefineCommand(
            opts.workspaceRoot,
            cmd.args,
            { model: modelRef.current, messages: state.messages },
          )}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ refine 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #5 failed 回执中文化。
        }
        continue;
      }
      // M49 §3: /search <query> — session search across .wudao/sessions
      // (same engine as `wudao sessions search`).
      if (cmd.kind === "search") {
        try {
          stdout.write(`${await runSessionSearch(opts.workspaceRoot, cmd.query)}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ search 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #6 failed 回执中文化。
        }
        continue;
      }
      // ω99-62: /find — the TUI overlay's graceful degradation, REPL lane.
      // The readline REPL owns no overlay surface, so the line answers with
      // the shared degradation copy (dsh's front-end capability discipline:
      // a command unsupported HERE gets deterministic local feedback, never
      // a wasted model round trip). Works mid-run for free — nothing starts.
      // The headless batcher's isImmediate probe (createHeadlessLineBatcher)
      // sees the new kind as a command, so a piped /find line submits
      // single-line instead of riding a batch — same as every other command.
      if (cmd.kind === "find") {
        stdout.write(`${FIND_TUI_ONLY_NOTICE}\n\n`);
        continue;
      }
      // 夜移 014 → ω99-316: /btw — the cache-shared side question, REPL
      // lane. Same engine family as the driver case (side-question.ts): a
      // detached clone through runSideQuestion — same-table freeze (tools
      // declared byte-identical, execute frozen), maxTurns=3, snapshot
      // sanitized — riding state's prefix bytes. Works mid-run, and the
      // answer prints without ever entering state.messages. REPL lane: no
      // effort stamp (the provider config's own level rides), and prior side
      // turns accumulate locally for the re-clone contract.
      if (cmd.kind === "btw") {
        if (cmd.question === "") {
          stdout.write("用法：/btw <问题> — 不打断主任务，借用会话缓存前缀旁路提问\n\n");
          continue;
        }
        const model = modelRef.current;
        const snapshot = [...state.messages];
        const tools = [...state.tools];
        const systemPrompt = state.systemPrompt;
        const priorTurns = [...replSideTurns];
        void runSideQuestion({ question: cmd.question, systemPrompt, messages: snapshot, priorTurns, tools, model })
          .then((result) => {
            replSideTurns = [...replSideTurns, ...result.turns];
            stdout.write(result.answer === "" ? "💬（旁问没有产生回答——请换个问法直接提问）\n\n" : `💬 ${result.answer}\n\n`);
          })
          .catch((err) => {
            stdout.write(`⚠️ 旁问失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-205: #1
          });
        continue;
      }
      // M52 §1: /compact — manual compaction now (reason manual; occupancy
      // irrelevant). ω99-29: the frozen summary persists below (onCompacted
      // seam). M58 §C#2: focus suffix + standing compact instructions ride tier-2.
      if (cmd.kind === "compact") {
        // ω99-45: the compaction's own cancellation controller — created
        // synchronously, cleared at settle (the driver's /compact contract).
        const compaction = new AbortController();
        compactAbort = compaction;
        try {
          const reads = new Map<string, { name: string; path: string }>();
          const classifier = createSkillReadClassifier(live.skills);
          for (const m of state.messages) {
            if (m.role !== "assistant" || !m.toolCalls) continue;
            for (const tc of m.toolCalls) {
              const read = classifier(tc.name, tc.arguments as Record<string, unknown>);
              if (read !== undefined) reads.set(tc.id, read);
            }
          }
          // M63-A: the manual PreCompact gate (defer skips this /compact) and
          // the PostCompact observer after it lands (the driver's same contract).
          const manualPreHook = live.hooks?.onPreCompact;
          if (manualPreHook !== undefined) {
            let manualPre: import("@wudao-org/core").PreCompactDecision = "compact";
            try {
              manualPre = (await manualPreHook(state.messages, "manual")) ?? "compact";
            } catch {
              manualPre = "compact";
            }
            if (typeof manualPre === "object" && manualPre.defer) {
              stdout.write(`（压缩已推迟：${manualPre.reason ?? "preCompact 钩子推迟"}）\n\n`); // ω99-166f-iii: #8-孪生（repl 手动压缩 preCompact 回执）
              continue;
            }
          }
          const out = await manualCompact(
            { systemPrompt: state.systemPrompt, tools: state.tools.map(toModelToolDefinition), messages: state.messages, model: modelRef.current, signal: compaction.signal },
            {
              keepRecent: 6,
              systemPrompt: state.systemPrompt,
              tools: state.tools.map(toModelToolDefinition),
              skillReads: reads,
              ...(cmd.focus !== undefined ? { focus: cmd.focus } : {}),
              ...(compactInstructionsRider !== undefined ? { compactInstructions: compactInstructionsRider } : {}),
              ...(liveConfig.reasoningEffort !== undefined ? { reasoningEffort: liveConfig.reasoningEffort } : {}),
            },
          );
          if (out === null) {
            stdout.write("（无可压缩——无 span、无双分区、无大块可清）\n\n"); // ω99-166d-ii: #7（无可压缩回执中文化）
            continue;
          }
          state.messages = out.messages;
          // ω99-29 T1: the manual compact's frozen summary persists here (same
          // onCompacted seam as the driver's /compact; SUMMARY_MARKER-once filter).
          if (out.summaryMessage !== undefined) {
            replPersistStore.append(persistSid(), out.summaryMessage).catch(persistNotice);
          }
          // ω99-7: a manual /compact is the same checkpoint signal as an auto
          // one (the pre-compaction trajectory just became the refine window)
          // — the memoized singleton, so this is the same runtime the run
          // seam uses; OFF stays a no-op.
          (await refineAutoRuntimeFor(opts.workspaceRoot))?.noteCompacted();
          try {
            await live.hooks?.onPostCompact?.(state.messages, "manual");
            fireSessionStart("compact");
          } catch {
            /* observer isolation */
          }
          stdout.write(`${formatCompactedLine(out.tier, "manual", out.beforeTokens, out.afterTokens)}\n\n`);
        } catch (err) {
          // ω99-45: a cancelled compaction is a CANCEL, not a provider failure
          // — no boundary landed, the history is untouched.
          stdout.write(
            compaction.signal.aborted
              ? `⚠️ compact 已中止——未写入边界\n\n` // ω99-166b: #8 散面中文化（166a #7 遗留的 aborted 臂；em-dash→中文破折号）。
              : `⚠️ compact 失败：${err instanceof Error ? err.message : String(err)}\n\n`, // ω99-166a: #7 failed 臂中文化（:2555 aborted 散面刻意不触）。
          );
        } finally {
          // ω99-45: the controller dies at settle — a later ^C targets runs only.
          if (compactAbort === compaction) compactAbort = null;
        }
        continue;
      }
      // M52 §3: /context — the occupancy report over the REAL projection (compact boundary → clear → microcompact, then counting).
      if (cmd.kind === "context") {
        stdout.write(`${formatContextReport(buildContextReport({
          systemPrompt: state.systemPrompt,
          tools: state.tools,
          messages: state.messages,
          contextWindowTokens: windowRef.current,
        }))}\n\n`);
        continue;
      }
      // PB-2: /probe — 探针遥测直读查询（零模型调用；/context 同款即时面）。
      if (cmd.kind === "probe") {
        stdout.write(`${formatProbeReport(getDefaultProbeBus(), parseProbeArgs(cmd.args))}\n\n`);
        continue;
      }
      // M55 §A2: /status — the offline one-pager (the REPL keeps no live
      // context watermark; that line reports not-measured here).
      if (cmd.kind === "status") {
        stdout.write(`${formatStatusReport({
          version: VERSION,
          provider: liveConfig.provider,
          model: liveConfig.model,
          mode: modeLabel(modeRef.mode),
          sessionId: opts.sessionId ?? "",
          ctx: null,
          keys: keyPool.snapshot(),
          ...(mandatoryRepairArmed.current ? { reasoningMandatoryPreArmed: true } : {}),
          surfaces: {
            skills: live.skills.length,
            plugins: live.pluginCommands.length,
            extensions: (opts.extensionCommands ?? []).length,
            mcp: (opts.extraTools ?? []).filter((t) => t.name.startsWith("mcp__")).length,
            tools: tools.length,
          },
        })}\n\n`);
        continue;
      }
      // M55 §A3: /cost — session usage totals from the cache-tracking model
      // (the same stats the per-turn cache line prints). M56 §3: the registry
      // adds the $ line + the unpriced-model note. P0-4 (96 队列): `/cost all`
      // swaps in the cross-session wallet view — the ledger renders first,
      // then the lazy balance fetch appends its line (three states; a failure
      // is one line, an unconfigured provider is silent).
      if (cmd.kind === "cost") {
        if (cmd.scope === "all") {
          const agg = aggregateCostLedger(readCostLedger(opts.workspaceRoot));
          let balance: WalletBalanceOutcome | undefined;
          try {
            balance = await fetchWalletBalance({ provider: liveConfig.provider, apiKey: liveConfig.apiKey });
          } catch (err) {
            balance = { balanceError: err instanceof Error ? err.message : String(err) };
          }
          stdout.write(`${renderWalletReport(agg, balance ?? {})}\n\n`);
          continue;
        }
        stdout.write(`${formatCostReport(usageTotalsFromStats(model.stats), { startedAt: replStart, cost: costRegistry.summary() })}\n\n`);
        continue;
      }
      // M55 §A4: /rename <name> — append a fresh session_name entry (the
      // store is append-only; the last entry wins on read).
      if (cmd.kind === "rename") {
        const v = validateSessionName(cmd.name);
        if (!v.ok) {
          stdout.write(`${v.error}\n\n`);
          continue;
        }
        if ((opts.sessionId ?? "") === "") {
          stdout.write("（rename 不可用——此 REPL 会话无会话 id）\n\n"); // ω99-166d-ii: #8（rename 无会话 id 回执中文化）
          continue;
        }
        try {
          const r = await renameSession({ workspaceRoot: opts.workspaceRoot, sessionId: opts.sessionId as string, name: v.name });
          stdout.write(`${r.notice}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ rename 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #8 failed 回执中文化。
        }
        continue;
      }
      // M55 §A5: /diff — git uncommitted + the session file journal.
      if (cmd.kind === "diff") {
        try {
          stdout.write(`${await runDiffCommand({
            workspaceRoot: opts.workspaceRoot,
            ...(fileHistory !== undefined ? { fileHistory } : {}),
          })}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ diff 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #9 failed 回执中文化。
        }
        continue;
      }
      // M55 §A6 + M62 §3: /config — the effective-settings view; `set local
      // <k> <v>` writes the local tier (auto-gitignored on first write).
      if (cmd.kind === "config") {
        try {
          stdout.write(`${await runConfigCommand({ workspaceRoot: opts.workspaceRoot, args: cmd.args })}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ config 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #10 failed 回执中文化。
        }
        continue;
      }
      // 2026-08-23 persona 层 — /persona：切换是 PersonaRuntime.current 的字段
      // 替换，次轮模型调用生效（/model 先例）；无 client 重建、无 key 池变动。
      if (cmd.kind === "persona") {
        const arg = parsePersonaArgument(cmd.rest);
        // PersonaArgument 的 error 变体没有 kind 字段（Task 12 类型）——
        // `in` 判别是该联合上唯一的窄化写法（`.ok` 在 kind 变体上不存在）。
        if ("error" in arg) { stdout.write(`${arg.error}\n\n`); continue; }
        if (arg.kind === "list") {
          stdout.write(`${formatPersonaList(personaRegistry, personaRuntime.current?.definition.id ?? null)}\n\n`);
          continue;
        }
        // Phase B: the mismatch note checks the protocol the LIVE wire speaks
        // (the construction seam dispatches on liveConfig.wire — the REPL is
        // no longer openai-chat-only). Call AFTER personaRuntime.current is
        // assigned: applyWirePersona reads the runtime's current persona.
        const liveProtocol: ProtocolId = liveConfig.wire ?? "openai-chat";
        const mismatchNoteFor = (p: ResolvedPersona | null): string => {
          if (p === null) return "";
          const wireDefined = applyWirePersona(personaRuntime, liveProtocol) !== null;
          return (p.layers.headers || p.layers.body) && !wireDefined
            ? `\n注：此 persona 未定义 ${liveProtocol} 的 headers/body——这里只有 prompt 层生效` // ω99-166f-ii: #17
            : "";
        };
        const old = personaRuntime.current;
        if (arg.kind === "off") {
          // --off = 回 provider 兜底（config.persona/WUDAO_PERSONA），不是强制 null。
          const back = resolveBootstrapPersona(personaRegistry, liveConfig);
          if (!back.ok) { stdout.write(`⚠️ ${back.error}\n\n`); continue; }
          personaRuntime.current = back.resolved;
          const cold = personaSwitchBreaksCache(old, back.resolved);
          if ((opts.sessionId ?? "") !== "") {
            try {
              await recordPersonaChange({
                workspaceRoot: opts.workspaceRoot, sessionId: opts.sessionId as string,
                to: { id: back.resolved?.definition.id ?? null, layers: back.resolved?.layers ?? { headers: false, body: false, prompt: false } },
                ...(old !== null ? { from: { id: old.definition.id } } : {}),
                coldTurnExpected: cold,
              });
            } catch (err) { stdout.write(`⚠️ persona 切换记录未写入：${err instanceof Error ? err.message : String(err)}\n`); } // ω99-166b: #9 散面中文化（bootstrap 回退臂；单 \n 原样）。
          }
          // followup minor ③: the --off fallback prints the SAME protocol-
          // mismatch note as an explicit switch — a bootstrap persona that
          // defines nothing on the live wire was previously reinstated
          // silently (the "[headers+body]" implication bug, on the fallback).
          stdout.write(`persona → ${back.resolved?.definition.id ?? "off (bare client)"} —— 下一个请求即生效${mismatchNoteFor(back.resolved)}${cold ? `\n${PERSONA_SWITCH_CACHE_NOTE}` : ""}\n\n`); // ω99-166f-ii: #18
          continue;
        }
        const v = resolvePersonaSwitch(personaRegistry, arg.id, arg.flag);
        if (!v.ok) { stdout.write(`${v.error}\n\n`); continue; } // fail-closed：runtime.current 未动
        personaRuntime.current = v.resolved;
        const cold = personaSwitchBreaksCache(old, v.resolved);
        if ((opts.sessionId ?? "") !== "") {
          try {
            await recordPersonaChange({
              workspaceRoot: opts.workspaceRoot, sessionId: opts.sessionId as string,
              to: { id: v.resolved.definition.id, layers: v.resolved.layers },
              ...(old !== null ? { from: { id: old.definition.id } } : {}),
              coldTurnExpected: cold,
            });
          } catch (err) { stdout.write(`⚠️ persona 切换记录未写入：${err instanceof Error ? err.message : String(err)}\n\n`); } // ω99-166b: #10 散面中文化（显式切换臂；尾 \n 差异保留）。
        }
        const on = (["headers", "body", "prompt"] as const).filter((k) => v.resolved.layers[k]).join("+");
        // I1 (final review): layers flagged on but nothing defined for the
        // protocol the LIVE wire speaks — the wire is byte-unchanged; say so
        // instead of letting "[headers+body]" imply a wire effect. Phase B
        // made the protocol dynamic (liveConfig.wire, see mismatchNoteFor).
        const mismatchNote = mismatchNoteFor(v.resolved);
        stdout.write(`persona → ${v.resolved.definition.id} [${on}] —— 下一个请求即生效${mismatchNote}${cold ? `\n${PERSONA_SWITCH_CACHE_NOTE}` : ""}\n\n`); // ω99-166f-ii: #19
        continue;
      }
      // M55 §B7: /model [name] — the switchable matrix (profile defaults +
      // WUDAO_MODEL); a switch mutates the live provider config so the NEXT
      // request carries it, and records the M28 model_change entry.
      if (cmd.kind === "model") {
        const list = availableModels();
        if (cmd.name === "") {
          stdout.write(`${formatModelList(list, { provider: liveConfig.provider, model: liveConfig.model })}\n\n`);
          continue;
        }
        // M57 §2: NAME or NUMBER (the printed ordinal). Same-endpoint
        // switches only (baseURL + key are provider-bound).
        const v = resolveModelArgument(list, cmd.name, { provider: liveConfig.provider });
        if (!v.ok) {
          stdout.write(`${v.error}\n\n`);
          continue;
        }
        applyModelSelection(liveConfig, { model: v.choice.model, provider: v.choice.provider });
        // §7: switching the model switches the window (per-model chain).
        windowRef.current = windowFor(liveConfig.provider, liveConfig.model);
        if ((opts.sessionId ?? "") !== "") {
          try {
            await recordModelSwitch({
              workspaceRoot: opts.workspaceRoot,
              sessionId: opts.sessionId as string,
              selection: { model: v.choice.model, provider: v.choice.provider },
            });
          } catch (err) {
            stdout.write(`⚠️ 模型切换记录未写入：${err instanceof Error ? err.message : String(err)}\n`); // ω99-166b: #11 散面中文化（model→模型）。
          }
        }
        // M58 §C#13: a MODEL switch changes the provider cache namespace — say
        // the next turn is cold (an effort switch never gets this line).
        stdout.write(`模型 → ${v.choice.provider}/${v.choice.model} —— 下一个请求即生效（/status 显示新标签）\n${MODEL_SWITCH_CACHE_NOTE}\n\n`); // ω99-166f-iii: #21; ω99-195: 面表外收口（166fiii 记号裁定 supersede——切换通知统一「模型 → 」，§零同屏不一致根因行；结尾 \n\n 保留）
        continue;
      }
      // M55 §B7: /effort [level] — the reasoning-effort switch (same live
      // config mutation + thinking_level_change entry).
      if (cmd.kind === "effort") {
        if (cmd.level === "") {
          stdout.write(`${formatEffortList(liveConfig.reasoningEffort ?? "off")}\n\n`);
          continue;
        }
        const v = resolveEffortArgument(cmd.level);
        if (!v.ok) {
          stdout.write(`${v.error}\n\n`);
          continue;
        }
        applyModelSelection(liveConfig, { effort: v.level });
        if ((opts.sessionId ?? "") !== "") {
          try {
            await recordModelSwitch({ workspaceRoot: opts.workspaceRoot, sessionId: opts.sessionId as string, selection: { effort: v.level } });
          } catch (err) {
            stdout.write(`⚠️ effort 档位切换记录未写入：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166b: #12 散面中文化（effort token 保留+档位补义）。
          }
        }
        stdout.write(`effort → ${v.level} —— 下一个请求即生效\n\n`); // ω99-166f-iii: #22（`effort → x` 路由记号原样）
        continue;
      }
      // 推理档三级配置 S4: /language — the session language lane. The
      // DRIVER surfaces (web/Ink TUI) home the mutable tier and land blocks
      // on the wire; the plain REPL drives the loop without the transient
      // blocks (M47 §2 / 夜移 012 never rode this path), so the REPL answers
      // with the folded status + the honest pointer instead of pretending.
      if (cmd.kind === "language") {
        const folded = resolveLanguagePreference();
        if (cmd.args === "") {
          stdout.write(`${formatLanguageStatus(folded)}\n  （本 REPL 无语言块注入——env/settings 即生效；wudao ui / TUI 里 /language 为会话级覆盖）\n\n`);
          continue;
        }
        const v = resolveLanguageArgument(cmd.args);
        if (!v.ok) {
          stdout.write(`⚠️ ${v.error}\n\n`);
          continue;
        }
        stdout.write(`⚠️ /language 会话覆盖只在 wudao ui / TUI 会话生效——本 REPL 的语言由 env（WUDAO_LANGUAGE_BLOCK / WUDAO_REASONING_LANGUAGE）与 settings 决定，当前折叠：reply=${folded.reply} reasoning=${folded.reasoning}\n\n`);
        continue;
      }
      // M63 §A: /provider [name] — bare lists the profile matrix with status
      // dots; a switch validates UP FRONT (unknown name / missing key /
      // missing endpoint → the fix named), then rebuilds the provider client
      // over the live config and records the provider_change entry. The REPL
      // is sequential — every line is a turn boundary, so the rebuild is
      // always at one; the mid-stream guard the interactive driver needs
      // cannot fire here (a turn fully settles before the next line runs).
      if (cmd.kind === "provider") {
        // 0.3.32c kimi-401: the credentials snapshot rides EVERY resolve
        // (the file-key legs are dead code without it — a saved target key
        // never displaced the borrowed pool → 401; same note as the
        // driver/TUI seams). resolveProviderSwitch's 0.3.32c note.
        const resolve = (name: string): import("./commands/provider.js").ProviderSwitchResult =>
          resolveProviderSwitch({ target: name, env: process.env, current: liveConfig, credentials: readCredentialsFileSync() });
        if (cmd.name === "") {
          stdout.write(`${formatProviderList(providerRows(process.env, resolve), liveConfig.provider)}\n\n`);
          continue;
        }
        const v = validateProviderName(cmd.name);
        if (!v.ok) {
          stdout.write(`${v.error}\n\n`);
          continue;
        }
        // 0.3.32c: a same-name switch is REAL when the credentials file now
        // holds a key the live pool lacks (a settings key save this session
        // has not picked up) — re-resolve swaps it in. 2026-08-31
        // config-drift: REAL also when a fresh resolve would change the
        // connection (the registry row was rewritten under us — endpoint/
        // wire). (No model preserve here: the receipt below names the model
        // the switch landed on.)
        const sameNameDrift =
          v.name === liveConfig.provider &&
          (() => {
            if (keyRefreshPending(liveConfig, readCredentialsFileSync())) return true;
            const r = resolve(v.name);
            return configRefreshPending(liveConfig, r.ok ? r.config : undefined);
          })();
        if (v.name === liveConfig.provider && !sameNameDrift) {
          // ω99-166f-ii: #15 孪生（控制器走查补刀：brief 漏盘本行）。
          stdout.write(`（已在 ${v.name} 上——/model 在其内切换模型；/provider <name> 换端点）\n\n`);
          continue;
        }
        const from = liveConfig.provider;
        const r = resolve(v.name);
        if (!r.ok) {
          stdout.write(`⚠️ 拒绝切换到 provider ${v.name}：${r.error}\n\n`); // ω99-166b: #13 散面中文化（refused 前移为动词拒绝；v.name/r.error 插值原样）。
          continue;
        }
        applyProviderConfig(liveConfig, r.config);
        // §7: the provider switch lands a new endpoint AND (usually) a new
        // model — re-resolve the window before the rebuild.
        windowRef.current = windowFor(liveConfig.provider, liveConfig.model);
        // 2026-08-23 persona 层：重建走 buildModel — personaRuntime 闭包在内，
        // provider 切换与 persona 是正交两轴（spec §2），重建不丢当前 persona。
        modelRef.current = buildModel(PROVIDER_SWITCH_COLD_ATTRIBUTION);
        if ((opts.sessionId ?? "") !== "") {
          try {
            await recordProviderChange({
              workspaceRoot: opts.workspaceRoot,
              sessionId: opts.sessionId as string,
              to: v.name,
              model: r.config.model,
              ...(from !== undefined ? { from } : {}),
            });
          } catch (err) {
            stdout.write(`⚠️ provider 切换记录未写入：${err instanceof Error ? err.message : String(err)}\n`); // ω99-166b: #14 散面中文化（provider token 保留）。
          }
        }
        // M63 §A: the receipt must say this is COLDER than a model switch —
        // a new endpoint re-processes the whole session history, not one prompt.
        stdout.write(`供应商 → ${v.name} (${r.config.model}) —— 客户端已重建，下一个请求即生效（/status 显示新标签）\n${PROVIDER_SWITCH_CACHE_NOTE}${r.borrowedKeyPool === true ? borrowedKeyPoolNote(v.name) : ""}\n\n`); // ω99-166f-ii: #20 // ω99-199: #1 // ω99-311: 称谓产品级统一（随 web 310）
        continue;
      }
      // M55 §B8: /permissions — view / add / remove the settings rules
      // (hot-reloads at the next gate; immunity-touching rules refused).
      if (cmd.kind === "permissions") {
        try {
          stdout.write(`${await runPermissionsCommand({ workspaceRoot: opts.workspaceRoot, args: cmd.args })}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ permissions 命令失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #11 failed 回执中文化（command→命令）。
        }
        continue;
      }
      // M55 §B9: /export [file] — the session as markdown (turns + tool
      // summaries; the REPL has no board channel). An existing target parks
      // the render behind `ok`.
      if (cmd.kind === "export") {
        if ((opts.sessionId ?? "") === "") {
          stdout.write("（export 不可用——此 REPL 会话无会话 id）\n\n"); // ω99-166d-ii: #9（export 无会话 id 回执中文化）
          continue;
        }
        try {
          const r = await prepareExport({
            workspaceRoot: opts.workspaceRoot,
            sessionId: opts.sessionId as string,
            fileArg: cmd.file,
            entries: exportEntriesFromMessages(state.messages, summarizeToolCall),
            model: liveConfig.model,
          });
          if (r.kind === "ok") {
            replExportPending = null;
            stdout.write(`已导出会话 ${(opts.sessionId as string).slice(0, 8)} → ${r.path}（${r.content.length} 字节）\n\n`); // ω99-166f-iii: #13-孪生（repl /export 回执）
          } else {
            replExportPending = { path: r.path, content: r.content };
            stdout.write(`${r.hint}\n\n`);
          }
        } catch (err) {
          stdout.write(`⚠️ export 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #12 failed 回执中文化。
        }
        continue;
      }
      // M55 §A1: /init — the guided AGENTS.md bootstrap. The turn runs with
      // normal gates (the prompt forbids writes; a stray write would surface
      // as a permission ask); the draft waits for `ok` at the prompt.
      if (cmd.kind === "init") {
        const hasExisting = hasExistingAgentsMd(opts.workspaceRoot);
        await submitTurn(buildInitPrompt({ workspaceRoot: opts.workspaceRoot, hasExisting }), false);
        const last = state.messages.at(-1);
        const draft = last !== undefined && last.role === "assistant" ? extractInitDraft(last.content) : undefined;
        if (draft === undefined) {
          replInitDraft = null;
          stdout.write("（/init 未产出 <agents-md-draft> 块——无可写入；/init 重试）\n\n"); // ω99-166d-ii: #10（/init 无草稿回执中文化；=driver #16 逐字孪生）
        } else {
          replInitDraft = draft;
          stdout.write(`${formatInitPreview({ draft, hasExisting })}\n\n`);
        }
        continue;
      }
      // M55 §A1: a pending /init draft consumes an approval exactly like a
      // plan board (`ok`); any other input stays a normal prompt and the
      // draft keeps waiting.
      if (cmd.kind === "prompt" && replInitDraft !== null && parsePlanReviewInput(cmd.text)?.kind === "approve") {
        const draft = replInitDraft;
        replInitDraft = null;
        try {
          const r = await applyInitDraft({ workspaceRoot: opts.workspaceRoot, draft });
          stdout.write(`${r.notice}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ /init 写入失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #13 failed 回执中文化（write→写入）。
        }
        continue;
      }
      // M55 §B10: /review and /security-review — the uncommitted diff goes
      // in as a review-request user message (the security variant pins the
      // checklist); nothing reviewable → a notice, no run.
      if (cmd.kind === "review" || cmd.kind === "securityReview") {
        const security = cmd.kind === "securityReview";
        try {
          const diff = await collectUncommittedDiff(createGitFn(opts.workspaceRoot));
          if (!diff.repo) {
            stdout.write(`（${security ? "安全审查" : "审查"}不可用——不是 git 仓库）\n\n`); // ω99-166c-iv: #23（=driver :5123 逐字孪生，车道对齐）
            continue;
          }
          if (!hasReviewableContent(diff)) {
            stdout.write(`${formatNoDiffNotice(opts.workspaceRoot)}\n\n`);
            continue;
          }
          await submitTurn(buildReviewPrompt({ diff, security, focus: cmd.focus }), false);
        } catch (err) {
          stdout.write(`⚠️ review 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #14 failed 回执中文化。
        }
        continue;
      }
      // M55 §B11: /mcp — server status from the loaded runtime.
      // P2-16b: "/mcp auth|unauth <server>" routes to the OAuth runner
      // (fire-and-forget — the flow waits up to 5 minutes on a human in a
      // browser; the URL prints via the log sink the moment it is built).
      if (cmd.kind === "mcp") {
        if (cmd.args === "") {
          stdout.write(`${runMcpStatusCommand({ workspaceRoot: opts.workspaceRoot, toolNames: tools.map((t) => t.name) })}\n\n`);
          continue;
        }
        void runMcpAuthCommand({
          args: cmd.args,
          workspaceRoot: opts.workspaceRoot,
          deps: { log: (line) => { stdout.write(`${line}\n`); } },
        })
          .then((text) => { stdout.write(`${text}\n\n`); })
          .catch((err) => { stdout.write(`⚠️ /mcp 失败：${err instanceof Error ? err.message : String(err)}\n\n`); }); // ω99-166a: #15 failed 回执中文化（catch 内联写法）。
        continue;
      }
      // M55 §B12: /agents — the roster listing with provenance + pins.
      if (cmd.kind === "agents") {
        try {
          stdout.write(`${await runAgentsCommand({ workspaceRoot: opts.workspaceRoot, pluginAgents: opts.pluginAgents })}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ agents 列表失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #16 failed 回执中文化（listing→列表）。
        }
        continue;
      }
      // cc-plugins B1: /plugin — the plugin/marketplace command face (the
      // same engine `wudao plugin` drives; notices 中文). Busy: only the two
      // directory-deleting ops refuse (the runner's guard); a successful
      // mutating op hot-rescans this REPL's extension surfaces (A3 swap sink).
      if (cmd.kind === "plugin") {
        try {
          const text = await runPluginSlashCommand({ args: cmd.args, cwd: opts.workspaceRoot, busy: activeGen !== null });
          stdout.write(`${text}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ /plugin 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #17 failed 回执中文化。
        }
        continue;
      }
      // P1-5 (96 队列): /trust — the workspace trust gate's face (status /
      // accept / revoke; the mutating verbs hot-rescan through the runner,
      // and this REPL's swap sink lands the fresh skills/manifest).
      if (cmd.kind === "trust") {
        try {
          const text = await runTrustCommand({ args: cmd.args, cwd: opts.workspaceRoot });
          stdout.write(`${text}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ /trust 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #18 failed 回执中文化。
        }
        continue;
      }
      // P1-7 (96 队列): /worktree — the main session's isolated worktree.
      // The full switch (operation root + extension face + permission
      // workspace) lives in the DRIVER's case (wudao ui / TUI / Slack); this
      // plain REPL drives the loop with a boot-fixed tool root and cannot
      // re-root it mid-session — the /language precedent: answer with usage
      // + the honest pointer instead of pretending.
      if (cmd.kind === "worktree") {
        stdout.write(`${WORKTREE_USAGE}\n⚠️ /worktree 切换只在 driver 会话（wudao ui / TUI）生效——本 REPL 的工具根在启动时固定；worktree 命令族请在 driver 前端使用\n\n`);
        continue;
      }
      // P2-13 (96 队列 #13): /constitution — the user constitution's face
      // (status / show / approve / reject over ~/.wudao/constitution*).
      // Config-only, busy-safe (the /trust precedent): the writes never
      // touch a run's files; approvals load into the prompt on the next
      // session start (the runner's receipt says so).
      if (cmd.kind === "constitution") {
        try {
          const text = await runConstitutionCommand({ args: cmd.args });
          stdout.write(`${text}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ /constitution 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #19 failed 回执中文化。
        }
        continue;
      }
      // M55 §C1: /add-dir <path> — add a workspace directory.
      if (cmd.kind === "addDir") {
        const input = cmd.path.trim();
        if (input === "") {
          // ω99-164: A3 /add-dir usage 中文化。
          stdout.write("用法：/add-dir <path>\n\n");
          continue;
        }
        const validation = validateAddDirPath({
          input,
          cwd: process.cwd(),
          existingPaths: replAddedDirs,
        });
        if (!validation.ok) {
          stdout.write(`${validation.error}\n\n`);
          continue;
        }
        replAddedDirs.push(validation.absPath);
        // NOTE: The REPL does not persist session entries (only the TUI/driver does).
        // For the REPL, we just show the notice without recording the entry.
        stdout.write(`${formatAddDirNotice({ absPath: validation.absPath, count: replAddedDirs.length })}\n\n`);
        continue;
      }
      // M55 §C2: /doctor — health check.
      if (cmd.kind === "doctor") {
        const doctorInput: DoctorInput = {
          cwd: process.cwd(),
          nodeVersion: process.version.slice(1),
          requiredNode: ">=22",
          providerKey: liveConfig.apiKey,
          settingsPath: opts.settingsPath,
          mcpConfigPath: opts.mcpConfigPath,
          sessionDir: opts.sessionDir,
          wudaoDir: opts.wudaoDir,
          evalDir: opts.evalDir,
          // M59 §3: web checks (search guidance; fetch always-on).
          ...(opts.webDoctor !== undefined ? { web: opts.webDoctor } : {}),
        };
        stdout.write(`${formatDoctorReport(doctorInput)}\n\n`);
        continue;
      }
      // M55 §C3: /tasks — background agent listing.
      if (cmd.kind === "tasks") {
        try {
          const snapshot = opts.agentsRegistry?.status();
          if (snapshot) {
            const rows = buildTaskRows(snapshot);
            stdout.write(`${formatTasksReport(rows)}\n\n`);
          } else {
            // ω99-164: A4 /tasks 无注册表回执中文化。
            stdout.write("tasks: 后台 agent 注册表不可用\n\n");
          }
        } catch (err) {
          stdout.write(`⚠️ tasks 列表失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #20 failed 回执中文化（listing→列表）。
        }
        continue;
      }
      // M55 §B9: a pending /export overwrite consumes the same `ok`; any
      // other input cancels it and falls through as a normal prompt.
      if (cmd.kind === "prompt" && replExportPending !== null) {
        if (parsePlanReviewInput(cmd.text)?.kind === "approve") {
          const pending = replExportPending;
          replExportPending = null;
          try {
            await writeExportFile(pending.path, pending.content);
            stdout.write(`exported → ${pending.path} (确认后已覆写)\n\n`); // ω99-166b: #15 成功回执英文残面中文化（exported→/覆写子句；pending.path 插值原样）。
          } catch (err) {
            stdout.write(`⚠️ /export 写入失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #21 failed 回执中文化（write→写入）。
          }
          continue;
        }
        replExportPending = null;
        stdout.write("（export 已取消——目标文件未动）\n\n"); // ω99-166d-ii: #11（export 取消回执中文化）
      }
      // M37 §1: /plan <goal> — a read-only plan run; the produced board waits
      // for review at the prompt.
      if (cmd.kind === "plan") {
        if (cmd.goal === "") {
          // ω99-164: A5 /plan usage 中文化（162 A 族 plan 同词表）。
          stdout.write("用法：/plan <goal> — 先只读规划，回 ok 才执行 · 改 <意见> 可修订\n\n");
          continue;
        }
        planBoard = null;
        await submitTurn(buildPlanPrompt(cmd.goal), true);
        continue;
      }
      // M53 §1: /edit [<n>] — list recent user messages, or arm one for
      // editing: the text goes back into the readline buffer (editable), and
      // the NEXT submitted prompt branches from that message's parent.
      if (cmd.kind === "edit") {
        if (activeGen !== null) {
          stdout.write("⚠️ 运行中无法 /edit（任务进行中）\n\n"); // ω99-166b: #16 散面中文化（镜像 driver :3803 既有中文款）。
          continue;
        }
        if (cmd.n === undefined) {
          stdout.write(`${formatReplEditList(replEditTargets(state.messages))}\n\n`);
          continue;
        }
        const target = replEditTargets(state.messages).find((t) => t.n === cmd.n);
        if (target === undefined) {
          // ω99-164: A6 /edit 越界 usage 中文化。
          stdout.write(`用法：/edit <n> — 没有第 ${cmd.n} 条消息（裸 /edit 列出可选消息，1 = 最近一条）\n\n`);
          continue;
        }
        pendingEditIndex = target.index;
        // ω99-164: A15（控制器 B2 增补） /edit 成功回执中文化——与 #6 同命令流 4 行之下。
        stdout.write(`✎ 已把第 ${cmd.n} 条消息放回输入——重发(改或不改)即从其父节点开分叉\n`);
        rl.write(target.text);
        continue;
      }
      // M53 §1: /tree — the ASCII topology of the in-memory chain (the REPL
      // keeps no session store; abandoned branches are a TUI/UI feature).
      if (cmd.kind === "tree") {
        const leaf = [...state.messages].reverse().find((m) => m.role === "user");
        stdout.write(`${renderBranchTree(state.messages, leaf !== undefined ? nodeKey(leaf) : null)}\n\n`);
        continue;
      }
      // M53 §1: /switch — needs the session JSONL (the other branches are not
      // in memory here); steer to the TUI.
      if (cmd.kind === "switch") {
        // ω99-164: A16（控制器 B2 增补） /switch 引导回执中文化——与 #10「REPL 仅内存保留历史」同词表。
        stdout.write("(切换分支需要会话存储——用 TUI (wudao) 或 wudao ui；REPL 仅内存保留历史)\n\n");
        continue;
      }
      // M37 §2: /rewind [n|last] — list the session's file changes or roll the
      // workspace back to before a step. History stays; read-state entries for
      // the touched files drop; the model learns via the MetaNote queue.
      // P2-10 (96 队列): the `turn` sub-grammar rewinds the CONVERSATION —
      // list the chain's recent user messages, or swap the in-memory chain to
      // before message n. No file journal needed (and this frontend keeps no
      // session store, so the rewound tail is not reachable here — the TUI
      // keeps it on the tree).
      if (cmd.kind === "rewind") {
        const rewindParsed = parseRewindTarget(cmd.args);
        if (rewindParsed.kind === "turn-list" || rewindParsed.kind === "turn") {
          const targets = replEditTargets(state.messages);
          if (rewindParsed.kind === "turn-list") {
            stdout.write(`${formatRewindTurnList(targets)}\n\n`);
            continue;
          }
          const chosen = targets.find((t) => t.n === rewindParsed.n);
          if (chosen === undefined) {
            // ω99-164: A7 /rewind turn 越界 usage 中文化。
            stdout.write(`用法：/rewind turn <n> — 没有第 ${rewindParsed.n} 条消息（裸 /rewind turn 列出可选消息，1 = 最近一条）\n\n`);
            continue;
          }
          state.messages = state.messages.slice(0, chosen.index);
          pendingEditIndex = null; // a fresh cut disarms an armed /edit
          planBoard = null;
          // ω99-164: A10 /rewind turn 成功回执中文化（插值表达式原样）。
          stdout.write(`↩ 已回退到第 ${rewindParsed.n} 条消息之前（"${truncateSafe(chosen.text.split("\n")[0] ?? "", 60)}"）—— 活跃链上余 ${state.messages.length} 条（REPL 仅内存保留历史；TUI 把回退轮留在分支树上）\n\n`);
          continue;
        }
        if (!fileHistory) {
          // ω99-164: A11 /rewind 无文件历史回执中文化。
          stdout.write("(文件历史不可用——本会话未记录快照)\n\n");
          continue;
        }
        const target = rewindParsed;
        if (target.kind === "bad") {
          // ω99-164: A8/A9 /rewind 无法识别参数 usage 中文化（三元两臂）。
          stdout.write(
            /^turn\b/i.test(target.raw)
              ? `用法：/rewind turn [<n>] — 无法识别 "${target.raw}"（裸 /rewind turn 列出消息清单）\n\n`
              : `用法：/rewind [<n>|last] — 无法识别 "${target.raw}"\n\n`,
          );
          continue;
        }
        try {
          if (target.kind === "list") {
            stdout.write(`${formatRewindList(await fileHistory.list(), opts.workspaceRoot)}\n\n`);
            continue;
          }
          const entries = await fileHistory.list();
          if (entries.length === 0) {
            // ω99-164: A12 /rewind 空步清单回执中文化（与 B15 逐字同）。
            stdout.write("(本会话未记录文件改动——没有可回退的内容)\n\n");
            continue;
          }
          const n = target.kind === "last" ? (entries[entries.length - 1]?.seq ?? 0) : target.n;
          const { summary } = await applyRewind(fileHistory, n, {
            workspaceRoot: opts.workspaceRoot,
            ...(opts.readState !== undefined ? { readState: opts.readState } : {}),
            pushMetaNote: (t) => metaNotes.push(t),
          });
          stdout.write(`${summary}\n\n`);
        } catch (err) {
          stdout.write(`⚠️ rewind 失败：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166a: #22 failed 回执中文化。
        }
        continue;
      }
      // M27 /skill:name: resolve against the loaded skills; the expansion is
      // submitted as an ordinary user turn (so onPromptSubmit hooks see it
      // like any prompt). Unknown name → list what IS loaded and re-prompt.
      let turnText: string;
      if (cmd.kind === "skill") {
        const skill = findSkill(live.skills, cmd.name);
        if (!skill) {
          stdout.write(`${formatSkillError(cmd.name, live.skills)}\n\n`);
          continue;
        }
        // ω99-65: the invocation is the trigger — a `approval-gate:
        // file-edits` skill arms the per-path edit approval posture HERE (the
        // same position the driver arms it at; the gate holds even if the
        // expansion below fails — a human-approval posture is fail-closed).
        armApprovalGate(skill);
        // cc-plugins D2: invocation-time preprocessing — substitutions always,
        // `!`cmd`/```! dynamic injections executed under the trust tiers and
        // the session's OWN permission gate (personal / user-scope sources run
        // free; project-tier skills and project-scope plugins go through the
        // same y/a/N ask a shell tool call would — an `a` answer covers
        // the session via the pipeline's allowlist). A denied or failed
        // injection fails the invocation loud (nothing is submitted).
        try {
          turnText = await buildExpandedSkillMessage(skill, cmd.args, {
            sessionId: opts.sessionId,
            workspaceRoot: opts.workspaceRoot,
            decide: baseCanUseTool,
            prunedFromContext: isSkillPruned(state.messages, skill.name),
          });
        } catch (err) {
          stdout.write(`⚠️ 技能 ${skill.name}：${err instanceof Error ? err.message : String(err)}\n\n`); // ω99-166b: #17 散面中文化（skill→技能，全角冒号；skill.name/err 三元原样）。
          continue;
        }
      } else if (cmd.kind === "pluginCommand") {
        // M36: expand the plugin command template and submit it as an ordinary
        // user turn (same pipeline as /skill: — onPromptSubmit hooks see it).
        const pluginCmd = live.pluginCommands.find((c) => c.name === cmd.name);
        if (!pluginCmd) {
          stdout.write(`${formatPluginCommandError(cmd.name, live.pluginCommands)}\n\n`);
          continue;
        }
        turnText = buildPluginCommandMessage(pluginCmd, cmd.args);
      } else if (cmd.kind === "extensionCommand") {
        // M39: run the extension's handler in isolation, then submit whatever
        // it ctx.submit-ed as an ordinary user turn (same pipeline as /skill:).
        const extCmd = (opts.extensionCommands ?? []).find((c) => c.name === cmd.name);
        if (!extCmd) {
          stdout.write(`⚠️ 无扩展命令 "/${cmd.name}"\n\n`); // ω99-166b: #18 散面中文化（no→无；引号与 cmd.name 插值原样）。
          continue;
        }
        const submitted = await runExtensionCommand(extCmd, cmd.args, {
          notice: (t) => stdout.write(`\x1b[2m${t}\x1b[0m\n`),
          warn: (m) => stdout.write(`⚠️ ${m}\n`),
        });
        stdout.write("\n");
        if (submitted !== undefined) await submitTurn(submitted, false);
        continue;
      } else if (planBoard !== null) {
        // M37 §1: review-time input while a plan board is pending. `ok` (or a
        // short confirmation) executes the board with NORMAL tools; `改 <意见>`
        // runs another read-only plan round; anything else falls through to a
        // normal prompt and the board stays under review.
        const review = parsePlanReviewInput(cmd.text);
        if (review?.kind === "approve") {
          const board = planBoard;
          planBoard = null;
          // 审批痕: the raw confirmation word lands verbatim as a genuine
          // user message BEFORE the wrapper. M24: pushed at the approval
          // moment — a turn boundary, before the execution run starts, never
          // mid-run. I1 follow-up: the wrapper joins the chain under the
          // trace (runTurn already carries this uuid/parentUuid push shape
          // for any branched turn via its 3rd param branchLink).
          appendPlanApprovalTrace(state.messages, cmd.text);
          await submitTurn(buildPlanExecutionPrompt(board), false, buildPlanExecutionBranchLink(state.messages));
          continue;
        }
        if (review?.kind === "revise") {
          await submitTurn(buildPlanRevisionPrompt(review.feedback), true);
          continue;
        }
        const mention = await expandMentions(cmd.text, opts.workspaceRoot);
        for (const n of mention.notices) stdout.write(`\x1b[2m${n}\x1b[0m\n`);
        turnText = mention.text;
      } else {
        // M34 §2: expand @<path> mentions in the raw prompt BEFORE it enters
        // the conversation (read_file constraints + the <file> envelope).
        // Notices print dim; skill envelopes expand no further (a SKILL.md's
        // own @tokens are its author's, not this user's input).
        const mention = await expandMentions(cmd.text, opts.workspaceRoot);
        for (const n of mention.notices) stdout.write(`\x1b[2m${n}\x1b[0m\n`);
        turnText = mention.text;
      }
      // M58 §C#10: a REAL user prompt (every approval/envelope path above
      // has `continue`d by here) lands in the global cross-session history.
      if (cmd.kind === "prompt") void appendPromptHistory(cmd.text, opts.workspaceRoot).catch(() => {});
      // M58 §C#12: a pending bang capture prefixes this prompt (the user's
      // own text is already mention-expanded into turnText at this point).
      if (replBangContext !== null) {
        turnText = `${replBangContext}\n\n${turnText}`;
        replBangContext = null;
      }
      // M53 §1: consume an armed /edit — cut the chain back to the edited
      // message's parent and link this turn there (a branch, not a rewrite).
      let branchLink: { readonly uuid: string; readonly parentUuid?: string } | undefined;
      if (pendingEditIndex !== null) {
        const cut = Math.max(0, Math.min(pendingEditIndex, state.messages.length));
        state.messages = state.messages.slice(0, cut);
        pendingEditIndex = null;
        planBoard = null;
        const parentKey = state.messages.length > 0 ? nodeKey(state.messages[state.messages.length - 1] as AgentMessage) : undefined;
        branchLink = { uuid: randomUUID(), ...(parentKey !== undefined ? { parentUuid: parentKey } : {}) };
        stdout.write(`⑂ branched — ${cut} messages kept on the active chain (the old turns stay in the session tree)\n`);
      }
      await submitTurn(turnText, false, branchLink);
    }
  } finally {
    // P0-4 (96 队列): best-effort wallet-ledger flush at the REPL's exit seam
    // (the finally covers /exit, SIGINT's natural exit, and a thrown error).
    // Sync fs — the process may not outlive queued writes. A missing session
    // id skips the flush (rows without an owning session are unattributable);
    // a failed flush is swallowed (telemetry never blocks teardown).
    if ((opts.sessionId ?? "") !== "") {
      try {
        costRegistry.flushToLedger(opts.workspaceRoot, opts.sessionId as string);
      } catch {
        /* best-effort */
      }
    }
    // P2-15 (96 队列 #15): sessionEnd 强制 flush the OTel exporter — same
    // best-effort posture as the wallet flush above (the runtime's own await
    // cap bounds the wait; a failed export is one ⚠️ line, never a blocker).
    try {
      await telemetry?.close();
    } catch {
      /* best-effort — telemetry never blocks teardown */
    }
    // M-Memory 弧第二半：REPL 会话终了确定性沉淀（保守 lesson 提炼，静默；
    // best-effort 同 wallet flush——失败绝不阻塞 teardown）。
    try {
      const ltsRt = longtermMemoryRuntimeFor();
      if (ltsRt !== undefined) await ltsRt.captureAtSessionEnd({ sessionId: persistSid(), messages: state.messages }).catch(() => {});
    } catch {
      /* best-effort */
    }
    process.off("SIGINT", onSigint);
    rl.off("SIGINT", onSigint);
    rl.off("line", onStdinLine);
    if (keypressWired) stdin.off("keypress", onKeypress);
    unregisterExtensionSwap(); // A3: the session is over — no more swaps land here
  }
  rl.close();
}
