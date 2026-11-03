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
import { resolveSessionWindowTokens } from "./provider-registry.js";
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

import type { ReplCommand } from "./repl.js";

// —— REPL 命令解析与纯工具族外提（ω99 拆分运动：纯移动段外提；原文件 re-export 门面）——
export const FIND_TUI_ONLY_NOTICE =
  "/find 是 TUI 界面命令（当前转录内查找）。跨会话搜索用 /search <query>。";

/** Parse one REPL input line. `pluginCommandNames` (M36) lists the loaded
 *  plugin commands and `extensionCommandNames` (M39) the extension-registered
 *  ones: a line `/<name> args` whose name is registered routes to the owning
 *  surface — plugins are checked FIRST (builtin > plugin > extension); every
 *  OTHER slash-looking line keeps its old behavior (builtin → command,
 *  unknown → plain prompt to the model). The loaders already refuse to
 *  register builtin/colliding names; the isBuiltinCommandName guard here is
 *  defense in depth. cc-plugins D3: the `skills` arg drives the slash parse
 *  order `builtin > /<name> (workspace/personal) > /<plugin>:<skill> >
 *  /skill:<name> (legacy alias)`. */
export function parseReplCommand(
  line: string,
  pluginCommandNames: readonly string[] = [],
  extensionCommandNames: readonly string[] = [],
  skills: readonly LoadedSkill[] = [],
): ReplCommand {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "noop" };
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed === "/clear") return { kind: "clear" };
  if (trimmed === "/help" || trimmed === "/?") return { kind: "help" };
  // M33 §3: bare /resume opens the TUI session picker (args ignored — the
  // picker is numeric, so "/resume 3" is not a direct load).
  if (trimmed === "/resume" || trimmed.startsWith("/resume ")) return { kind: "resume" };
  // M37 §1: /plan <goal> — a read-only plan run whose output board awaits
  // review (ok / 改 <意见>). Bare /plan yields an empty goal so the runtime
  // can answer with usage; "/planx" must stay a plain prompt.
  if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
    return { kind: "plan", goal: trimmed.slice("/plan".length).trim() };
  }
  // M61 §2: /loop — fixed interval, dynamic self-pacing, or stop.
  if (trimmed === "/loop" || trimmed.startsWith("/loop ")) {
    return { kind: "loop", args: trimmed.slice("/loop".length).trim() };
  }
  // M61 §3: /goal — set/status/clear the condition-driven goal.
  if (trimmed === "/goal" || trimmed.startsWith("/goal ")) {
    return { kind: "goal", args: trimmed.slice("/goal".length).trim() };
  }
  // ω99-15: /mission — start/status/clear the task campaign (prefix-neighbor
  // discipline: /missionX stays a prompt).
  if (trimmed === "/mission" || trimmed.startsWith("/mission ")) {
    return { kind: "mission", args: trimmed.slice("/mission".length).trim() };
  }
  // M61 §4: /schedule — the durable task group.
  if (trimmed === "/schedule" || trimmed.startsWith("/schedule ")) {
    return { kind: "schedule", args: trimmed.slice("/schedule".length).trim() };
  }
  // M37 §2: /rewind [n|last] — list/rollback the session's file changes.
  // P2-10 (96 队列): the `turn [n]` sub-grammar (conversation档) rides the
  // same arg channel — parseRewindTarget owns the grammar.
  if (trimmed === "/rewind" || trimmed.startsWith("/rewind ")) {
    return { kind: "rewind", args: trimmed.slice("/rewind".length).trim() };
  }
  // M49 §1: /memory [list|del <id>|ok <id>] — the memory store's face.
  if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
    return { kind: "memory", args: trimmed.slice("/memory".length).trim() };
  }
  // ω99-3a: /refine [instructions]|rollback <refineId> — the session refiner.
  // Prefix-neighbor discipline: "/refinex" stays a plain prompt.
  if (trimmed === "/refine" || trimmed.startsWith("/refine ")) {
    return { kind: "refine", args: trimmed.slice("/refine".length).trim() };
  }
  // M49 §3: /search <query> — CJK-aware search across .wudao/sessions.
  if (trimmed === "/search" || trimmed.startsWith("/search ")) {
    return { kind: "search", query: trimmed.slice("/search".length).trim() };
  }
  // ω99-62: /find — the TUI overlay's shared parse, byte-same judgment as
  // find-core's parseFindCommand (bare or `/find ` prefix, query trimmed;
  // "/findx" and "/finder" stay plain prompts — prefix-neighbor discipline).
  // Builtin placement: parsed BEFORE the skill/plugin/extension lookups, so
  // a registered name "find" can never shadow it (the TUI already
  // intercepts pre-parse; every other frontend routes here).
  if (trimmed === "/find" || trimmed.startsWith("/find ")) {
    return { kind: "find", query: trimmed.slice("/find".length).trim() };
  }
  // 夜移 014: /btw <question> — side question on the session's cached prefix.
  // Bare /btw parses too (the driver answers it with a usage notice).
  if (trimmed === "/btw" || trimmed.startsWith("/btw ")) {
    return { kind: "btw", question: trimmed.slice("/btw".length).trim() };
  }
  // M52 §1: /compact — manual compaction now (reason manual). M58 §C#2: the
  // optional `focus <query>` suffix (rest-of-line after the literal `focus `)
  // weaves "summarize with attention to <query>" into the tier-2 summary
  // instruction. Anything else after /compact stays unrecognized (today's
  // behavior); a bare `focus` with no query is a plain /compact.
  if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
    const rest = trimmed.slice("/compact".length).trim();
    if (rest === "") return { kind: "compact" };
    if (rest === "focus" || rest.startsWith("focus ")) {
      const focus = rest.slice("focus".length).trim();
      return focus === "" ? { kind: "compact" } : { kind: "compact", focus };
    }
  }
  // M52 §3: /context — occupancy breakdown over the real projection.
  if (trimmed === "/context") return { kind: "context" };
  // PB-2（探针基础设施弧）— /probe [cat] [N] | stats：直读查询面（raw args；
  // probe.ts 的 parseProbeArgs 负责语法，坏语法→用法回执而非 prompt）。
  if (trimmed === "/probe" || trimmed.startsWith("/probe ")) {
    return { kind: "probe", args: trimmed.slice("/probe".length).trim() };
  }
  // M53 §1: /edit [<n>] — the numeric arg picks a message to edit (arms a
  // branch); anything else lists the recent user messages.
  if (trimmed === "/edit" || trimmed.startsWith("/edit ")) {
    const raw = trimmed.slice("/edit".length).trim();
    const n = /^(\d+)$/.exec(raw);
    return { kind: "edit", ...(n !== null ? { n: Number(n[1]) } : {}), raw };
  }
  // M53 §1: /tree — the ASCII branch topology (no args).
  if (trimmed === "/tree") return { kind: "tree" };
  // M53 §1: /switch [<n>] — list branches or switch to branch n.
  if (trimmed === "/switch" || trimmed.startsWith("/switch ")) {
    const raw = trimmed.slice("/switch".length).trim();
    const n = /^(\d+)$/.exec(raw);
    return { kind: "switch", ...(n !== null ? { n: Number(n[1]) } : {}), raw };
  }
  // M55 §A: the command-parity pack. Arg-taking commands accept the
  // space-separated form; "/renamex" stays a plain prompt.
  if (trimmed === "/init") return { kind: "init" };
  if (trimmed === "/status") return { kind: "status" };
  // P0-4 (96 队列): exact-match grammar — bare /cost keeps the session view,
  // `/cost all` widens to the cross-session ledger; any other suffix (and the
  // prefix-neighbor /costx) stays a plain prompt, today's behavior.
  if (trimmed === "/cost") return { kind: "cost" };
  if (trimmed === "/cost all") return { kind: "cost", scope: "all" };
  if (trimmed === "/rename" || trimmed.startsWith("/rename ")) {
    return { kind: "rename", name: trimmed.slice("/rename".length).trim() };
  }
  if (trimmed === "/diff") return { kind: "diff" };
  // M62 §3: /config [set local <key> <value>] — the report plus the one
  // writer (local tier; first write auto-gitignores).
  if (trimmed === "/config" || trimmed.startsWith("/config ")) {
    return { kind: "config", args: trimmed.slice("/config".length).trim() };
  }
  // M55 §B: the medium-command pack — same space-separated arg convention.
  if (trimmed === "/model" || trimmed.startsWith("/model ")) {
    return { kind: "model", name: trimmed.slice("/model".length).trim() };
  }
  if (trimmed === "/effort" || trimmed.startsWith("/effort ")) {
    return { kind: "effort", level: trimmed.slice("/effort".length).trim() };
  }
  // M63 §A: /provider — the in-session provider switch.
  if (trimmed === "/provider" || trimmed.startsWith("/provider ")) {
    return { kind: "provider", name: trimmed.slice("/provider".length).trim() };
  }
  // 2026-08-23 persona 层：/persona — the client-fingerprint switch. "/personax"
  // must stay a plain prompt (prefix-neighbor discipline, /plan precedent).
  if (trimmed === "/persona" || trimmed.startsWith("/persona ")) {
    return { kind: "persona", rest: trimmed.slice("/persona".length).trim() };
  }
  if (trimmed === "/permissions" || trimmed.startsWith("/permissions ")) {
    return { kind: "permissions", args: trimmed.slice("/permissions".length).trim() };
  }
  // 推理档三级配置 S4: /language — the session language lane's parse (the
  // shared grammar; "/languagex" stays a prompt — prefix-neighbor discipline).
  if (trimmed === "/language" || trimmed.startsWith("/language ")) {
    return { kind: "language", args: trimmed.slice("/language".length).trim() };
  }
  if (trimmed === "/export" || trimmed.startsWith("/export ")) {
    return { kind: "export", file: trimmed.slice("/export".length).trim() };
  }
  if (trimmed === "/review" || trimmed.startsWith("/review ")) {
    return { kind: "review", focus: trimmed.slice("/review".length).trim() };
  }
  if (trimmed === "/security-review" || trimmed.startsWith("/security-review ")) {
    return { kind: "securityReview", focus: trimmed.slice("/security-review".length).trim() };
  }
  if (trimmed === "/mcp" || trimmed.startsWith("/mcp ")) {
    return { kind: "mcp", args: trimmed.slice("/mcp".length).trim() };
  }
  if (trimmed === "/agents") return { kind: "agents" };
  // M55 §C: the command-parity finale pack.
  if (trimmed === "/add-dir" || trimmed.startsWith("/add-dir ")) {
    return { kind: "addDir", path: trimmed.slice("/add-dir".length).trim() };
  }
  if (trimmed === "/doctor") return { kind: "doctor" };
  if (trimmed === "/tasks") return { kind: "tasks" };
  // cc-plugins B1: /plugin <sub> [args] — the plugin/marketplace command
  // face. "/pluginx" and "/plugins" must stay plain prompts (or a registered
  // plugin command of their own name).
  if (trimmed === "/plugin" || trimmed.startsWith("/plugin ")) {
    return { kind: "plugin", args: trimmed.slice("/plugin".length).trim() };
  }
  // P1-5 (96 队列): /trust [accept|revoke] — the workspace trust gate's
  // face. Exact-match grammar (the /cost all precedent): bare, "accept",
  // "revoke" route; any other suffix (and the prefix-neighbor "/trustx")
  // stays a plain prompt.
  if (trimmed === "/trust") return { kind: "trust", args: "" };
  if (trimmed === "/trust accept") return { kind: "trust", args: "accept" };
  if (trimmed === "/trust revoke") return { kind: "trust", args: "revoke" };
  // P1-7 (96 队列): /worktree family — prefix match ("/worktreex" stays a
  // plain prompt, the prefix-neighbor discipline); raw args ride through,
  // the driver's case validates the exact forms (enter/exit keep|remove).
  if (trimmed === "/worktree" || trimmed.startsWith("/worktree ")) {
    return { kind: "worktree", args: trimmed.slice("/worktree".length).trim() };
  }
  // P2-13 (96 队列 #13): /constitution — the user constitution's human
  // face. Exact-match grammar (the /trust precedent): bare status, "show",
  // "approve <n>", "reject <n>"; any other suffix (and the prefix-neighbor
  // "/constitutionx") stays a plain prompt.
  if (trimmed === "/constitution") return { kind: "constitution", args: "" };
  if (trimmed === "/constitution show") return { kind: "constitution", args: "show" };
  {
    const m = /^\/constitution (approve|reject) (\d+)$/.exec(trimmed);
    if (m !== null) return { kind: "constitution", args: `${m[1]} ${m[2]}` };
  }
  // cc-plugins D3 — the three slash-command invocation forms for skills.
  // Builtin checks above already won. The order:
  //   1) /<name>             workspace/personal skill (no plugin)
  //   2) /<plugin>:<skill>   plugin skill under namespace
  //   3) /skill:<name>       legacy alias for /<name>
  // We only attempt (1)/(2) when the line starts with `/` and is not the
  // legacy `/skill:…` form (already routed by the branch below). Both
  // lookups are pure and read-only; no execution here. The `case "skill"`
  // handler in the driver (and here in the REPL) keeps doing the real work.
  if (trimmed.startsWith("/") && skills.length > 0) {
    const ws = trimmed.search(/\s/);
    const head = ws === -1 ? trimmed.slice(1) : trimmed.slice(1, ws);
    const rest = ws === -1 ? "" : trimmed.slice(ws + 1).trim();
    if (head.length > 0) {
      // /<plugin>:<skill> — namespace split on the FIRST colon (plugin names
      // never contain `:`; skill names may but only inside an explicitly
      // registered plugin namespace lookup).
      const colon = head.indexOf(":");
      if (colon !== -1) {
        const pluginName = head.slice(0, colon);
        const skillName = head.slice(colon + 1);
        const pluginSkill = findPluginSkill(skills, pluginName, skillName);
        if (pluginSkill !== undefined) {
          return { kind: "skill", name: skillName, args: rest };
        }
        // Namespace miss falls through — a misspelled /superpowers:foo with
        // no match is a plain prompt (NOT a skill-name notice; the parse is
        // ambiguous on its own).
      } else {
        // /<name> — workspace/personal skill only.
        const skill = findNonPluginSkill(skills, head);
        if (skill !== undefined) {
          return { kind: "skill", name: head, args: rest };
        }
      }
    }
  }
  // M27 `/skill:name [args]`: the legacy alias kept for back-compat. Bare
  // `/skill` / `/skill:` yield an empty name so the runtime answers with
  // the available-skills listing.
  if (trimmed === "/skill" || trimmed.startsWith("/skill:")) {
    const body = trimmed.startsWith("/skill:") ? trimmed.slice("/skill:".length) : "";
    const ws = body.search(/\s/);
    return {
      kind: "skill",
      name: ws === -1 ? body : body.slice(0, ws),
      args: ws === -1 ? "" : body.slice(ws + 1).trim(),
    };
  }
  // M36 plugin commands, then M39 extension commands: only names the caller
  // registered — the parser stays pure and unknown /word lines remain plain
  // prompts. Builtin names never route here (the loaders skip them; this is
  // defense in depth).
  if ((pluginCommandNames.length > 0 || extensionCommandNames.length > 0) && trimmed.startsWith("/")) {
    const ws = trimmed.search(/\s/);
    const name = ws === -1 ? trimmed.slice(1) : trimmed.slice(1, ws);
    if (isBuiltinCommandName(name)) return { kind: "prompt", text: line };
    if (pluginCommandNames.includes(name)) {
      return {
        kind: "pluginCommand",
        name,
        args: ws === -1 ? "" : trimmed.slice(ws + 1).trim(),
      };
    }
    if (extensionCommandNames.includes(name)) {
      return {
        kind: "extensionCommand",
        name,
        args: ws === -1 ? "" : trimmed.slice(ws + 1).trim(),
      };
    }
  }
  return { kind: "prompt", text: line };
}

/** Handle runRepl fills with its AgentState after building tools — the
 *  buildTools callback's probe/fork closures read through it at execution
 *  time (tools exist before the state does). */
export interface ReplStateHandle {
  state?: import("@wudao-org/core").AgentState;
}

/** M53 §1: the /edit listing — plain user prompts of the chain, 1 = most
 *  recent (machinery messages starting with "[" are excluded). */
export interface ReplEditTarget { readonly n: number; readonly index: number; readonly text: string }
export function replEditTargets(messages: readonly AgentMessage[]): readonly ReplEditTarget[] {
  const out: ReplEditTarget[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m === undefined || m.role !== "user") continue;
    if (m.content.startsWith("[")) continue;
    out.push({ n: out.length + 1, index: i, text: m.content });
  }
  return out;
}
export function formatReplEditList(targets: readonly ReplEditTarget[]): string {
  if (targets.length === 0) return "(还没有可编辑的消息)"; // ω99-164: A13 空清单回执中文化。
  // ω99-164: A14 /edit 清单头中文化（rows 模板逐字保留）。
  return `最近消息（1 = 最近一条；/edit <n> 把它放回输入——重发即开分叉）：\n${targets.map((t) => `  ${t.n}. ${truncateSafe(t.text.split("\n")[0] ?? "", 80)}`).join("\n")}`;
}

/** M25 §A2: the REPL's one-line startup resume summary — id, message count,
 *  and the last assistant's opening (no full replay). */
export function formatResumeLine(sessionId: string, messages: readonly AgentMessage[]): string {
  let last: AgentMessage | undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "assistant") {
      last = m;
      break;
    }
  }
  const lastText = last ? truncate(last.content, 60) || "…" : "…";
  return `已恢复 ${sessionId}（${messages.length} 条消息；最近：${lastText}）`; // ω99-172: #8
}

/** I1 follow-up — wrapper-side counterpart to plan.ts `appendPlanApprovalTrace`:
 *  pushes the `<plan-approved>` wrapper with a fresh uuid linked at the chain
 *  predecessor's nodeKey (the trace just pushed by `appendPlanApprovalTrace`).
 *  Same canonical turn-node shape as the trace and as the driver
 *  `agent-driver.ts submitCore` push. The one-shot plan flow (`index.ts:1617`)
 *  uses this directly; the REPL plan-approval path (`repl.ts:1930`) uses
 *  `buildPlanExecutionBranchLink` to feed `runTurn`'s 3rd-param branchLink
 *  (runTurn itself carries the same uuid/parentUuid push shape for any
 *  branched turn). */
export function appendPlanExecutionWrapper(messages: AgentMessage[], content: string): void {
  const parentKey = messages.length > 0 ? nodeKey(messages[messages.length - 1] as AgentMessage) : undefined;
  messages.push({
    role: "user",
    content,
    uuid: randomUUID(),
    ...(parentKey !== undefined ? { parentUuid: parentKey } : {}),
  });
}

/** I1 follow-up — the branchLink-only flavor of `appendPlanExecutionWrapper`:
 *  returns the `{ uuid, parentUuid? }` link object that `repl.ts runTurn`
 *  consumes as its 3rd param. The wrapper push itself happens inside runTurn
 *  (which already carries this uuid/parentUuid push shape for any branched
 *  turn — see runTurn body at ~:905). Minted fresh, linked at the trace's
 *  nodeKey (the trace is now `messages[messages.length - 1]`). */
export function buildPlanExecutionBranchLink(messages: readonly AgentMessage[]): { readonly uuid: string; readonly parentUuid?: string } {
  const parentKey = messages.length > 0 ? nodeKey(messages[messages.length - 1] as AgentMessage) : undefined;
  return { uuid: randomUUID(), ...(parentKey !== undefined ? { parentUuid: parentKey } : {}) };
}

// F1 item 3 (83) — the programmatic-submit busy-guard. The REPL's fire-and-
// forget submits (monitor wakes at the cronPoll seam, /loop rounds through the
// loop controller's submit) must never start a CONCURRENT runTurn: the shared
// turn state (state.messages, activeGen/activeAbort, the /loop re-arm) is
// single-owner. Mirrors the M61 driver semantics (submitCore parks a busy
// submit in its steering queue): busy → park in a FIFO drained at the
// settling turn's tail, with a one-line park notice — never a dropped or
// concurrent run. Interactive user submits keep their own path (the main loop
// awaits runTurn; unchanged). Report 95 R1: both paths now enter through the
// submitTurn admission chain first — this gate parks when a turn has STARTED,
// the chain queues when one is about to start or in flight.
export interface ProgrammaticSubmitGate {
  /** One programmatic submit. "started" — idle, the turn runs now;
   *  "parked" — a turn is in flight, the payload waits in the FIFO. */
  submit(text: string): "started" | "parked";
  /** The settling turn's drain seam: starts the next parked submit, if any. */
  settleDrain(): void;
  /** The parked payloads, in arrival order (test view). */
  parked(): readonly string[];
}

export function createProgrammaticSubmitGate(
  run: (text: string) => void,
  isBusy: () => boolean,
  onPark?: (text: string) => void,
): ProgrammaticSubmitGate {
  const queue: string[] = [];
  return {
    submit(text) {
      if (isBusy()) {
        queue.push(text);
        onPark?.(text);
        return "parked";
      }
      run(text);
      return "started";
    },
    settleDrain() {
      const next = queue.shift();
      if (next === undefined) return;
      // Report 95 R2: re-check isBusy() between shift and run — if a submit
      // slipped in and a turn is (again) in flight, park the payload back at
      // the HEAD (FIFO priority kept) instead of racing a second run.
      // Belt-and-braces: R1's submitTurn chain already serializes the REPL.
      if (isBusy()) {
        queue.unshift(next);
        return;
      }
      run(next);
    },
    parked: () => [...queue],
  };
}

// Report 95 R1 — the turn-admission chain. The REPL used to serialize its
// turns purely by the main loop's `await runTurn` side effect, but every
// interactive path runs awaits BEFORE runTurn starts (mention expansion, bang
// commands, plan/plugin/extension handling), and in that window activeGen is
// still null while a turn is "about to start" — a programmatic submit landing
// there (a monitor wake through the gate, a /loop first round) raced the
// interactive turn into two concurrent runTurns over the single-owner turn
// state (state.messages, activeGen/activeAbort, the /loop re-arm). The chain
// collapses admission to one entry point — real CC's "reserve before the
// first await" discipline (QueryGuard) in plain-REPL form: entering the chain
// reserves the slot synchronously, so a submit arriving while a turn is
// queued or in flight queues with a one-line notice instead of racing. The
// chain swallows errors to stay alive (each caller still sees its own turn's
// rejection through the returned promise). Complements the F1 gate: the gate
// parks when a turn has STARTED, the chain queues when a turn is
// about-to-start or in flight.
export interface TurnSerializer {
  /** Submit one turn. The slot is reserved synchronously — before the first
   *  await; a submit while a turn is queued/in flight reports through
   *  onQueued and waits its turn. Resolves/rejects with THIS turn's outcome. */
  submitTurn(text: string, plan: boolean, branchLink?: { readonly uuid: string; readonly parentUuid?: string }): Promise<void>;
}

export function createTurnSerializer(
  runTurn: (text: string, plan: boolean, branchLink?: { readonly uuid: string; readonly parentUuid?: string }) => Promise<void>,
  onQueued?: (text: string) => void,
): TurnSerializer {
  // One serial chain: every source (the interactive awaits, the gate's
  // fire-and-forget run, the settle drain) lines up on the same tail — one
  // runTurn at a time, in submission order.
  let turnChain: Promise<void> = Promise.resolve();
  let turnInFlight = false;
  return {
    submitTurn(text, plan, branchLink) {
      if (turnInFlight) onQueued?.(text);
      turnInFlight = true; // sync reserve — BEFORE the first await (the CC discipline)
      const run = turnChain.then(() => {
        // Re-assert at turn start: the previous turn's reset and this start
        // are adjacent microtasks, and turnInFlight must stay true across them.
        turnInFlight = true;
        return runTurn(text, plan, branchLink);
      });
      turnChain = run.then(() => {}, () => {}); // swallow: one failed turn never breaks the chain
      void turnChain.then(() => { turnInFlight = false; });
      return run;
    },
  };
}

/** ω99-8: the REPL's subagent cost sink — the caller's buildTools wires the
 *  task tool's onSubagentUsage into this box BEFORE runRepl creates its
 *  CostRegistry (the replReviewerBox pattern: cross-scope late binding).
 *  bind() seats the registry at its creation; records before the bind are
 *  no-ops (nothing to account into — in practice the bind always precedes
 *  the first child). */
export interface SubagentCostSink {
  readonly bind: (registry: CostRegistry) => void;
  readonly record: (info: { readonly model: string; readonly usage: import("@wudao-org/core").ModelUsage }) => void;
}

/** Build the sink box (index.ts constructs it beside its buildTools call and
 *  hands BOTH the same instance). Every record lands as provider="subagent"
 *  keyed by the answering model — the driver's wiring, same shape. */
export function createSubagentCostSink(): SubagentCostSink {
  let registry: CostRegistry | undefined;
  return {
    bind: (r) => { registry = r; },
    record: (info) => { registry?.record({ model: info.model, provider: "subagent", usage: info.usage }); },
  };
}

