#!/usr/bin/env node
// @wudao/cli — entrypoint. `wudao "<prompt>"` runs the agent against a real model
// (when WUDAO_API_KEY/OPENAI_API_KEY is set); otherwise prints guidance.
// The FIRST import must stay the production-React pin (see react-prod.ts):
// it evaluates before `react` loads and picks its build.
import "./react-prod.js";
import { stdin, stdout } from "node:process";
import { join, dirname, relative } from "node:path";
import { runAgentLoop, createJsonlSessionStore, createReadStateTable, createFileHistory, createAskUserTool, applySummaryMarkers, repairOrphanedToolCalls, activeBranchLeafKey, resumeChain, compactionRetentionFor, newSessionId, cumulativeModifiedFiles, activeToolsOf, type AgentHooks, type AgentState, type AgentMessage, type AskUserOption, type PermissionDecision, type LoopEvent, type ModelClient, type Tool, sessionLeaseBoxFor } from "@wudao-org/core";
import { createProvider, modelAcceptsImages, type ProviderConfig } from "@wudao-org/providers";
import { createFileAttachmentStore, type ImageBlock } from "@wudao-org/core";
// 夜移 035 (codex turn_timing): the one-shot run's phase recorder (debug tier).
import { createTurnProfileRecorder } from "@wudao-org/core";
// 夜移 032 stage-2 (codex turn_diff_tracker): the one-shot run's net-change
// tracker — one instance for the whole command, shared by the tool set and
// both passes (reset per pass), rendered once at settle.
import { createTurnDiffTracker } from "@wudao-org/core";
// ω99-46: the process egress policy — installed once at boot so every
// default-fetch outbound path (providers, web_fetch) routes through it.
import { resolveEgressPolicy, installEgressProxy } from "@wudao-org/core";
import { readEgressSettings } from "./egress-config.js";
import { renderTurnDiff } from "./turn-diff-render.js";
import { buildRunPlan, buildUiBootPlan, formatOneShotResumeLine, lastModelState, recordModelState, type LastModelState } from "./run.js";
import { loadImageFiles } from "./driver/attachment-ops.js";
// SDD 2026-08-23 persona Task 4 — the production persona-chain reads (the TUI
// entry supplies them; the WudaoApp prop defaults stay test stubs).
import { readProviderPersonaBinding } from "./driver/provider-registry-ops.js";
import { readGlobalDefaultPersonaId } from "./driver/settings-ops.js";
// ω99-134: the one-shot's receipt card reuses the SAME extractor and icon/KB
// helpers as the REPL's ω99-132 card — one derivation, no twin copy.
import { extractFileReceipt } from "./driver/file-receipt.js";
import { fileIconOf, formatKb } from "./tui/file-card.js";
import { buildSystemPrompt } from "./prompt.js";
import { expandMentions } from "./mentions.js";


import { parseLogLevel, summarizeToolCall, truncate, truncateMultiline, promptFromArgv, modelLabel, LEVEL_ORDER, RESULT_PREVIEW_CHARS, type LogLevel } from "./log.js";
// 0.3.15: the one-shot run-stats receipt shares the driver's formatter (one
// format across every surface).
import { formatRunStats } from "./driver/agent-driver.js";
import { createCronRuntime } from "./cron.js";
// ω99-112: the controlled-browser runtime (six browser_* tools; zero-IO at
// construction, playwright-core loads only at first launch).
import { createBrowserRuntime } from "@wudao-org/browser";
// ω-4a: the monitor runtime (monitor tools + steering-lane event delivery).
import { createMonitorRuntime } from "./monitor.js";
import { createGoalController, buildEvaluatorModel, goalEvaluatorAvailable, parseGoalCommand, routeHeadlessGoalCommand, type GoalController } from "./goal.js";
import { parseSessionFlags, parseSandboxFlags, parseProviderFlags, parsePluginFlags, parsePlanFlag, parseForkSessionFlag, parseAblationFlags, applyAblationFlagsToEnv, isFeatureAblated, parseImageFlags, parseSessionNameFlag, splitEndOfOptions, subcommandArgv, parseTrustWorkspaceFlag, parseHelpVersionFlags, resolveAskOpening, CLI_USAGE_TEXT } from "./args.js";
// M64-A §A: the one-shot peer-messaging runtime (UDS inbox + registry).
import { createPeerRuntime, readPeerDialogExpiry, sidecarMessageReview } from "./peer/runtime.js";
import { buildPlanPrompt, buildPlanExecutionPrompt, createTodoBoardSource, planModeDenied, appendPlanApprovalTrace, planConfirmApproves } from "./plan.js";
import { modeFromArgv, modeLabel, resolveInitialMode, createPermissionGate, toolMetaResolverFor, loadPermissionSettings, decideRichPermission, createDurableAskTierGate } from "./permission.js";
import { loadSidecarSettings, resolveSidecarRuntime, createSidecarFromConfig, type Sidecar } from "./sidecar.js";
import { printBanner } from "./tui/banner.js";
import { createBreakLineGuard, createCacheTrackingModel, formatUsageLine } from "./cache.js";
import { runRepl, appendPlanExecutionWrapper, createSubagentCostSink } from "./repl.js";
import { selectMessagesToPersist } from "./persist.js";
import { buildToolSet, resolveDeferMode } from "./tools.js";
import { historySearchCorpus } from "./history-search.js";
import { maybeLoginShellEnv } from "./shell-snapshot.js";
import type { LongOutputConfig, WriteVerifyConfig } from "@wudao-org/core";
import { createExternalChangeProber } from "./file-changes.js";
import { createGitStatusProber } from "./git-status-note.js";
import { getCompactInstructionsRider } from "./project-context.js";
import { createProviderModelResolver, createSessionRegistry } from "./agents/index.js";
// ω99-57: the one-shot child-mail lane (task-tool sink + steering-take drain).
import { createChildMailLane } from "./agents/child-mail.js";
import { loadLongTaskSettings, resolveLongTaskRuntime, applyGatesAblation, type LongTaskRuntime } from "./long-task-config.js";
import { loadWriteVerifySettings, resolveWriteVerifyRuntime, loadLongOutputSettings, resolveLongOutputRuntime, resolveGenericShapingRuntime, loadLogSlimmingPortsForBoot } from "./output-config.js";
// ω99-315: stream.idleSoftMs / stream.idleHardMs (dual-tier idle watchdog).
import { loadStreamSettings, streamIdleProviderOptions } from "./stream-idle-config.js";
import { loadWebSettings, webSearchConfig } from "./web-config.js";
import type { WebToolsRuntime } from "./tools.js";
import type { WebDoctorInput } from "./commands/doctor.js";
import { runTui } from "./tui/app.js";
import { runUi, parseUiPort } from "./ui.js";
import { sweepStaleRpcDirs } from "./tmp-sweep.js";
import { workflowMain } from "./workflow/cli.js";
import { collectSessionRows, formatSessionTable, ensureSessionName, ensureWorkspaceRootEntry, defaultSessionListFilter } from "./session-list.js";
import { appendSessionEntry, buildDeferredLoadedEntry, buildCompactBoundaryEntry, buildLoopReflectionEntry } from "./session-entry.js";
import { appendRunStatsReceipt, persistNewMessages } from "./one-shot-settle.js";
import { createMemoryRuntime, surfacePendingReview, refineAutoRuntimeFor, observeAutoRefineOnHooks } from "./memory/index.js";
import { spawnBackgroundReview, REVIEW_MIN_TOOL_CALLS } from "./memory/review.js";
// ω-4f (design 84): Dream consolidation — stage 2 (ledger→curated ledger).
import { spawnDreamRun } from "./memory/dream.js";
import { createSessionSearchIndex, runSessionSearch } from "./session-search.js";
import { metaMain } from "./meta/journal.js";
import { formatStatuslineLine, statuslineFromWorkspace } from "./statusline.js";
import { askReviewIntro } from "./ask-reviewer.js";
import { createTaintTracker, argsCarryTaint } from "./taint.js";
import { loadMcpTools, closeMcpTools, bestEffortCloseMcpTools } from "./mcp/tools.js";
// P2-9（96 队列 #9）: the LSP tool face — settings-gated (lsp.enabled, default
// off), lazily spawned per workspace, appended at the tool-list tail exactly
// where MCP tools ride (the conditional-registration precedent).
import { lspToolsFor, closeLspTools, bestEffortCloseLspTools, setLspRuntimeEnabled } from "./lsp/tools.js";
// P2-12（96 队列 #12）: the persistent PTY terminal tool — settings-gated
// (terminal.enabled, default off) AND node-pty-load-gated (a missing native
// build warns once and registers nothing); appended at the tool-list tail
// after the lsp tool (same conditional-registration precedent). Sessions
// never resume across restarts (PTY state is not persistable — honest).
import { terminalToolsFor, closeTerminalTools, bestEffortCloseTerminalTools, setTerminalRuntimeEnabled, setTerminalHistorySink } from "./terminal/tools.js";
import { warmTerminalPty } from "./terminal/pty.js";
import { createSkillReadClassifier } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
import { collectPluginAgents, mergeMcpConfigs } from "./plugins.js";
import { pluginMain } from "./commands/plugins-command.js";
import { permsCommandMain } from "./commands/perms.js";
import { SCHEDULE_MODEL_UNREACHED_MARKER } from "./schedules-model.js";
import type { LoadedPlugin } from "./plugins.js";
import { buildExtensionState, attachBootExtensions, initExtensionRuntime, getExtensionState } from "./extension-state.js";
// P1-5 (96 队列): the workspace trust gate — decision store + status math.
import { formatTrustGateNotice, trustGateStatus } from "./trust.js";
import { loadExtensions } from "./extensions/loader.js";
import type { ExtensionRuntime } from "./extensions/api.js";
import { SESSION_END_BUDGET_MS, hookCommonFields } from "./hooks-config.js";
import { composeReflectHooks, reflectRuntimeFor } from "./reflect-config.js";
import { getContextRules, createContextRuleMatcher } from "./rules.js";
import { setSessionOutputStyle } from "./output-styles.js";
import { setProjectContextExcludes } from "./project-context.js";
import {
  parseClaudeMdExcludes,
  resolveAutoCompactSettings,
  resolveMemorySettings,
  resolveMcpEnabled,
  parseFallbackModels,
  readDeferModeSetting,
  resolveLspEnabled,
  resolveTerminalEnabled,
  resolveDocSuiteEnabled,
  loadPythonKernelSettings,
  // 125 项 1：预留感知触发线（dsh resolveCompactSpec 形）的旋钮 + 装配缝。
  compactionSettingsFromNode,
  compactionThresholdFields,
} from "./misc-config.js";
// ω99-236: the doc trio's roster module (十二面名册 + 使能门 runtime flag).
import { setDocSuiteRuntimeEnabled } from "./doc-suite.js";
import { loadLayeredSettings, readGlobalSettings } from "./settings-layer.js";
import { setupProbeAudit } from "./probe.js";
// Provider management §7: the per-model context-window chain (registry
// contextLength → provider default → env) feeds every build point below.
import { loadEffectiveProfiles, resolveSessionWindowTokens, resolveSessionCachePricing } from "./provider-registry.js";
// R6 quickwin: the Ctrl+S pick defaults read (the ui boot applies them).
import { readStoredModelDefaults } from "./driver/settings-ops.js";
import { setSessionDeferMode } from "./tools.js";
import { setSessionMemorySettings } from "./memory/index.js";
// M-Memory 弧第二半 — 长期记忆装配（REPL/one-shot 的 runtime + 工具换轨 +
// 首轮召回注入 + 会话终了沉淀）。
import { createLongtermMemoryRuntime, setLongtermMemoryRuntime } from "./longterm-memory.js";
import { parseMcpTimeouts } from "./mcp/tools.js";
import {
  runLifecycleSweep,
  resolveLifecycleSettings,
  buildPurgePlan,
  executePurge,
  formatSweepNotice,
  formatPurgePlan,
} from "./lifecycle.js";
import { VERSION } from "./version.js";
import { stdoutGuard } from "./output-guard.js";
import { diagLine } from "./answer-only-channel.js";
import { installSigtermExit } from "./signal-exit.js";

// Auto-load a .env file (from cwd, walking up to 5 parents) so the API key /
// baseURL / model don't need to be exported manually. Existing process.env wins.
import {
  setMcpRuntime,
  askFirstRunWizard,
  askUserLine,
  confirmLine,
  confirmLineRaw,
  hookCommon,
  hookMcpTools,
  hookPromptId,
  hookRewake,
  hookRuntimeView,
  hookSessionId,
  hookTranscriptRoot,
  hookWarn,
  hookWorkspaceRoot,
  loadEnvFile,
  loadMcpToolsFor,
  mcpWarn,
  modelUnreachedStampDue,
  newId,
  oneShotRunFacts,
  resolveSession,
  subagentEventHandler,
  trustGateBoot,
} from "./cli-main-helpers.js";

// —— main 前置纯/半纯工具族外提（re-export 门面 + 内部使用导入）——

async function main(): Promise<void> {
  loadEnvFile();
  // End-of-options `--` (pi precedent): the FIRST bare `--` ends flag
  // parsing — later tokens are prompt positionals, never flags. Splice argv
  // once HERE and normalize process.argv to the pre-`--` flag window so every
  // flag consumer in this entry AND the downstream re-reads (driver/session
  // engine, repl) all see the same flag-only argv; the raw argv stays for the
  // prompt below (promptFromArgv re-splits it). A second/later `--` is an
  // ordinary positional. Without a `--` the splice is the identity — zero
  // drift for every existing flag/prompt parse. (Mutation precedent: the
  // no-key wizard reentry below rewrites process.argv the same way.)
  const rawArgv = process.argv;
  process.argv = splitEndOfOptions(rawArgv).flagWindow;
  // ω99-130: `-h/--help` and `-V/--version` short-circuit — print and exit 0
  // BEFORE any settings read, banner, or model session (dogfood: `wudao
  // --help` used to send "--help" to the model as a one-shot prompt). Leading
  // flags only (parseHelpVersionFlags re-applies the end-of-options split and
  // the first-prompt-word stop), so a --help inside the prompt or after `--`
  // stays a prompt word, and a subcommand's own --help (`wudao plugin --help`)
  // keeps its subcommand handling. The fork-session early-return below is the
  // template. The version always comes from version.ts — never hardcoded.
  const helpVersion = parseHelpVersionFlags(process.argv.slice(2));
  if (helpVersion !== undefined) {
    process.stdout.write(helpVersion === "help" ? CLI_USAGE_TEXT : `${VERSION}\n`);
    return;
  }
  // 0.3.11: the boot chain (CLI flag > persisted permissions.defaultMode)
  // — the persisted default the settings page/wizard ⑤ writes.
  hookCommon.mode = resolveInitialMode(process.argv, process.env);
  // OOM-fix guardrail: best-effort sweep of stale run_script RPC dirs
  // (wudao-ptc-* older than 1h) leaked under the OS tmpdir by crashed runs.
  void sweepStaleRpcDirs();
  const argv = process.argv;
  // M53 §5: the ablation matrix — parsed once and bridged into the env before
  // ANY feature resolves (sidecar/write-verify/gates read the env below; the
  // deep seams check isFeatureAblated at their own construction time).
  // Review fix: the args AFTER the executable prefix, and only LEADING flags
  // count — a `--no-X` inside the one-shot prompt is a prompt word.
  applyAblationFlagsToEnv(parseAblationFlags(argv.slice(2)), process.env);
  // --sandbox / WUDAO_SANDBOX=1 (M21): containerized shell, fail-closed
  // when Docker is unavailable. Resolved once, threaded to every frontend.
  const sandbox = parseSandboxFlags(argv, process.env);
  const sandboxOpts = sandbox.enabled ? { sandbox: { ...(sandbox.image ? { image: sandbox.image } : {}) } } : undefined;

  // M58 §C#5: --fork-session forks a resumed session onto a fresh id — it is
  // only meaningful together with --resume <id> (a fresh session has nothing
  // to fork). Refuse early with usage instead of silently ignoring the flag.
  if (parseForkSessionFlag(argv) && parseSessionFlags(argv).resumeId === undefined) {
    process.stdout.write("--fork-session forks a RESUMED session: wudao --resume <id> --fork-session\n");
    return;
  }

  // `wudao workflow …` — deterministic workflow scripts, before prompt parsing
  // (a workflow file path would otherwise be swallowed into the prompt).
  // subcommandArgv (dashdash follow-up): argv is the pre-`--` window, so a
  // dispatch that consumes argv as data threads rawArgv + positionals —
  // `wudao workflow -- run x.wf` runs x.wf instead of "missing workflow file".
  if (argv[2] === "workflow") {
    const code = await workflowMain(subcommandArgv(rawArgv, 3));
    if (code !== 0) {
      await stdoutGuard.flushRawStdout();
      process.exit(code);
    }
    return;
  }

  // `wudao plugin …` — the plugin/marketplace command face (B1: list /
  // install / uninstall / enable / disable + marketplace add|list|update|
  // remove, --json for scripts; the /plugin slash command shares the engine).
  // Mirrors the workflow subcommand dispatch.
  if (argv[2] === "plugin") {
    const code = await pluginMain(subcommandArgv(rawArgv, 3));
    if (code !== 0) {
      await stdoutGuard.flushRawStdout();
      process.exit(code);
    }
    return;
  }

  // M52 §2: `wudao perms lint` — pure lint of the settings permissions node:
  // unreachable rules (shadowed by an earlier same-layer rule, killed by the
  // deny-first layering, or neutralized by a matching ask). Report-only — no
  // auto-fix; findings exit 1 so CI can gate on them. M58-C: linted over the
  // two-tier UNION with per-rule tier attribution — a finding names the file
  // that actually contains the rule (global ~/.wudao vs project .wudao).
  // 借鉴弧 α3 顺带拆分：本体迁 commands/perms.ts（行为逐字节一致），本处只留
  // 分发。perms 是 flag-only dispatch——读 flag 窗口（argv），不走 subcommandArgv
  // （args.ts 的既定契约）。
  if (argv[2] === "perms") {
    await permsCommandMain(argv.slice(3));
    return;
  }

  // M49 §3: `wudao sessions search <query>` — CJK-aware full-text search over
  // .wudao/sessions (the inverted index at .wudao/search-index.json rebuilds
  // itself when stale or corrupt; the TUI /search command shares the engine).
  if (argv[2] === "sessions" && argv[3] === "search") {
    // subcommandArgv (dashdash follow-up): the query must span the post-`--`
    // window — `wudao sessions search foo -- --bar` searches "foo --bar"
    // (transcripts quote bash commands; a bare `--` in the query is routine),
    // never silently truncating to "foo".
    const query = subcommandArgv(rawArgv, 4).join(" ").trim();
    if (query === "") {
      stdoutGuard.writeRawStdout("用法：wudao sessions search <query>\n"); // ω99-166d-i: #10
      return;
    }
    stdoutGuard.writeRawStdout(`${await runSessionSearch(process.cwd(), query)}\n`);
    return;
  }

  // M50 §2: `wudao meta …` — the experiment journal (report / record /
  // apply). Report only: the journal never changes configuration by itself.
  if (argv[2] === "meta") {
    const code = await metaMain(subcommandArgv(rawArgv, 3));
    if (code !== 0) {
      await stdoutGuard.flushRawStdout();
      process.exit(code);
    }
    return;
  }

  // M62 §2: `wudao purge [--dry-run] [--yes]` — clean the workspace's RUNTIME
  // data now (expired or not: sessions transcripts, spills, /rewind
  // snapshots, debug logs) into .wudao/trash (soft delete — recoverable for
  // the soft-delete window). Memory/config are never touched. --dry-run
  // prints the plan and writes ZERO bytes; --yes skips the y/N confirm.
  if (argv[2] === "purge") {
    const rest = argv.slice(3);
    const dryRun = rest.includes("--dry-run");
    const assumeYes = rest.includes("--yes");
    const junk = rest.filter((a) => a !== "--dry-run" && a !== "--yes");
    if (junk.length > 0) {
      stdoutGuard.writeRawStdout(`用法：wudao purge [--dry-run] [--yes]（无法识别：${junk.join(" ")}）\n`); // ω99-166d-i: #11
      await stdoutGuard.flushRawStdout();
      process.exit(1);
      return;
    }
    const plan = await buildPurgePlan(process.cwd());
    if (plan.entries.length === 0) {
      stdoutGuard.writeRawStdout("无可清除数据（.wudao 下没有可过期的运行时数据）\n"); // ω99-194: #6
      return;
    }
    stdoutGuard.writeRawStdout(`${formatPurgePlan(plan)}\n`);
    if (dryRun) {
      stdoutGuard.writeRawStdout("（试运行——未写入任何内容）\n"); // ω99-194: #7
      return;
    }
    if (!assumeYes) {
      // ω99-199: #9
      const ok = await confirmLine(`将 ${plan.entries.length} 个文件（${(plan.totalBytes / 1024).toFixed(1)} KB）移入 .wudao/trash？[y/N] `);
      if (!ok) {
        // ω99-199: #10
        stdoutGuard.writeRawStdout("（已取消清除——未写入任何内容）\n");
        return;
      }
    }
    const result = await executePurge(process.cwd(), plan);
    stdoutGuard.writeRawStdout(`已将 ${result.softDeleted.length} 个文件移入 .wudao/trash——软删除窗口内可恢复（softDeletePeriodDays，默认 7）\n`); // ω99-194: #8
    return;
  }

  // M53 §3: `wudao statusline [--json]` — the machine-readable state for a
  // user statusline script (newest session + env; no live driver exists in
  // this process — scripts poll, and debouncing is the consumer's job).
  if (argv[2] === "statusline") {
    const snapshot = await statuslineFromWorkspace(process.cwd(), process.env, VERSION);
    if (argv.includes("--json")) {
      stdoutGuard.writeRawStdout(`${JSON.stringify(snapshot, null, 2)}\n`);
    } else {
      stdoutGuard.writeRawStdout(`${formatStatuslineLine(snapshot)}\n`);
    }
    return;
  }

  // cc-plugins A3: the extension boot assembly lives in ONE re-entrant
  // builder — buildExtensionState(cwd, argv) — so rescanExtensions() can
  // re-run the EXACT same seams mid-session (plugins → commands/agents →
  // hooks → skills → merged MCP config) instead of a second, drifting copy.
  // M36 plugins: `.wudao/plugins/*` + `<globalHome>/plugins/*` + `--plugin`
  // mounts, warn-not-crash; their assets feed the existing seams. M19 hooks:
  // user settings + plugin hooks (mapped event names) + extension hooks,
  // composed config → plugins → extensions.
  const extensionWarn = mcpWarn;
  const extensionHookWarn = (m: string): void => { (hookWarn.current ?? ((x) => process.stderr.write(`${x}\n`)))(m); };
  // M63-C: the fire-runtime view handed to every (re)build — mode + the §2
  // common stdin fields + the mcp_tool backend + asyncRewake, all reading the
  // module-level live boxes so a rescan compiles against the SAME runtime.
  const extensionHookRuntime = {
    getMode: () => hookCommon.mode,
    common: hookRuntimeView.common,
    mcp: hookRuntimeView.mcp,
    rewake: hookRuntimeView.rewake,
  };
  // P1-5 (96 队列): the workspace trust gate — ONE live decision for the
  // boot cwd. fail-closed: trust-requiring project resources + no recorded
  // accept ⇒ the project-carried surface (skills roots, plugin scope,
  // settings allow/ask + hooks nodes) is suppressed everywhere below; the
  // USER global tiers are never touched. --trust-workspace pins the gate
  // open for THIS run (the headless escape hatch; nothing is written to
  // ~/.wudao/trust.json). The getter is LIVE so a mid-session /trust
  // accept|revoke + rescan re-evaluates it.
  const trustFlagOpen = parseTrustWorkspaceFlag(argv);
  const bootTrustStatus = trustGateStatus(process.cwd(), process.env);
  const trustSuppressedLive = (): boolean =>
    !trustFlagOpen && trustGateStatus(process.cwd(), process.env).effectiveSuppressed;
  const bootTrustNotice = !trustFlagOpen && bootTrustStatus.effectiveSuppressed
    ? formatTrustGateNotice(bootTrustStatus)
    : undefined;
  trustGateBoot.suppressed = trustSuppressedLive;
  if (bootTrustNotice !== undefined) trustGateBoot.notice = bootTrustNotice;
  let extState = await buildExtensionState(process.cwd(), argv, {
    warn: extensionWarn,
    hookWarn: extensionHookWarn,
    hookRuntime: extensionHookRuntime,
    trustSuppressed: trustSuppressedLive,
  });
  const { plugins, pluginCommands, pluginAgents } = extState;

  // M39 extensions: `.wudao/extensions/*.mjs` — CODE, loading is execution
  // (same trust class as hook commands; see the README trust model). Optional
  // like plugins; a broken extension warns and is skipped, never fatal. The
  // runtime rides the existing seams: AgentHooks (after the config hooks),
  // the tool array (ext_-prefixed, appended at the end), slash-command
  // routing (builtin/plugin names win), and the M35 session-entry channel.
  // A3: extensions are NOT rescanned (re-import would double-register their
  // state); their boot hooks object rides every rescan instead.
  const extensions = await loadExtensions(process.cwd(), {
    warn: mcpWarn,
    pluginCommandNames: pluginCommands.map((c) => c.name),
  });
  extState = attachBootExtensions(extState, extensions.hooks);
  // The live handoff: remember the assembly inputs so rescanExtensions()
  // re-runs this exact build, and park the state as the current one.
  initExtensionRuntime(process.cwd(), argv, extState, {
    warn: extensionWarn,
    hookWarn: extensionHookWarn,
    extensionsHooks: extensions.hooks,
    hookRuntime: extensionHookRuntime,
    trustSuppressed: trustSuppressedLive,
  });
  const hooks = extState.hooks;
  // M63-B: the FileChanged watch targets (the plain onFileChanged matchers)
  // and the skills root for the skills-position ConfigChange face.
  const fileWatchTargets = extState.fileWatchTargets;
  const configSkillsRoot = join(process.cwd(), ".wudao", "skills");

  // M62: session-static config surfaces, resolved ONCE here — BEFORE any
  // prompt is built (the memoized loaders freeze bytes from the first read).
  //   §7 claudeMdExcludes → which M54b context files the loader skips;
  //   §4 outputStyle     → the style whose body joins the prompt tail;
  //   §6 tools.defer     → auto|on|off for the defer candidates;
  //   §7 memory*/mcp*    → the memory store's switch/dir, the MCP master
  //                        switch + timeouts;
  //   §7 fallbackModel   → the ordered chain threaded into every provider
  //                        config the frontends build below.
  // All startup-only by design: a mid-session flip would shift prompt bytes
  // or tool-list bytes and break the provider prefix cache (restart to
  // apply changes).
  const m62Settings = await loadLayeredSettings(process.cwd(), mcpWarn);
  const m62Effective = m62Settings.effective;
  // ω99-46: the egress policy — resolved ONCE here (launch env + the
  // global-tier `network` node through the same layered read) and installed
  // BEFORE any provider or web_fetch request can go out. No proxy env and
  // no settings node → nothing installs (direct path byte-identical, the
  // red line). Rejected values warn; an install that cannot load its
  // transport warns and stays direct — never fatal (dsh contract).
  {
    const egressPolicy = resolveEgressPolicy(process.env, readEgressSettings(m62Effective, mcpWarn));
    for (const d of egressPolicy.diagnostics) mcpWarn(`⚠️ egress: ${d.message}`);
    if (egressPolicy.kind === "routed") {
      const installed = await installEgressProxy(egressPolicy);
      if (!installed.installed) {
        mcpWarn("⚠️ egress: a proxy policy is set but its dispatcher could not be installed — connecting directly");
      }
    }
  }
  setProjectContextExcludes(parseClaudeMdExcludes(m62Effective, mcpWarn));
  setSessionOutputStyle(typeof m62Effective["outputStyle"] === "string" && m62Effective["outputStyle"] !== "" ? m62Effective["outputStyle"] : undefined);
  // M62 §6: tools.defer default is "auto" — readDeferModeSetting returns
  // undefined for an absent/junk key (warning on junk), and resolveDeferMode
  // maps undefined → "auto" (the spec default; the legacy "on" fallback in
  // sessionDeferEnabled only fired because this resolution was skipped).
  // Env ablation (WUDAO_DEFER_TOOLS=off) wins inside resolveDeferMode too.
  setSessionDeferMode(resolveDeferMode(readDeferModeSetting(m62Effective["tools"])));
  setSessionMemorySettings(resolveMemorySettings(process.cwd(), m62Effective, mcpWarn));
  const mcpEnabled = resolveMcpEnabled(m62Effective, mcpWarn);
  const mcpTimeouts = parseMcpTimeouts(m62Effective["mcpTimeouts"]);
  setMcpRuntime({ enabled: mcpEnabled, timeouts: mcpTimeouts });
  // P2-9（96 队列 #9）: the LSP tool's opt-in gate — session-static like every
  // other tools-defining knob (a mid-session flip would shift tool-list bytes
  // and break the prefix cache; restart to apply). Default off = zero LSP
  // surface (no tool, no process — lspToolsFor returns []).
  setLspRuntimeEnabled(resolveLspEnabled(m62Effective, mcpWarn));
  // ω99-236: #7 — the doc trio's OPT-OUT gate (the lsp seam's default-flipped
  // twin: the Excel/Word/PPT twelve faces already ship on, so absence keeps
  // them mounted — 默认态字节零变). Session-static like every tools-defining
  // knob: off needs a restart to apply (no mid-session removal — a mid-session
  // flip would shift tool-list bytes and break the prefix cache); off = one
  // cross-version cold turn (the doc faces sit before the defer tail, their
  // removal moves the later tools — M24 declarative cache cost, declared in
  // doc-suite.ts).
  setDocSuiteRuntimeEnabled(resolveDocSuiteEnabled(m62Effective, mcpWarn));
  // P2-12（96 队列 #12）: the PTY terminal tool's TWO gates — the settings
  // opt-in AND a successful node-pty load (the native verdict must be settled
  // before any frontend builds tools; a missing build warns once via the
  // startup-notice channel and registers nothing, never fatal).
  const terminalEnabled = resolveTerminalEnabled(m62Effective, mcpWarn);
  if (terminalEnabled) await warmTerminalPty(mcpWarn);
  setTerminalRuntimeEnabled(terminalEnabled);
  const fallbackModelChain = parseFallbackModels(m62Effective, mcpWarn);
  // M62 §7: the auto-compaction window/switch + the fallback chain ride a
  // shared config decorator every frontend path applies below.
  const decorateConfig = (c: ProviderConfig): ProviderConfig =>
    fallbackModelChain.length > 0 ? { ...c, fallbackModels: fallbackModelChain } : c;
  // Provider management §7 — the per-model window chain replaces the bare env
  // read: the registry's per-model contextLength → provider default → env
  // value (WUDAO_CONTEXT_WINDOW ?? 200_000) feeds resolveAutoCompactSettings
  // through its envWindowTokens parameter — call shape, knob precedence, and
  // clamp untouched (an explicit autoCompactWindow still wins for every
  // model). bootProvider/bootModel mirror the resolver's selection rules so
  // the pre-config value matches what the frontends boot; each frontend below
  // re-resolves against its OWN boot config (the ui ready-substitution can
  // land a different provider), and the mid-session switch paths re-resolve
  // at their turn boundaries.
  const providerFlags = parseProviderFlags(argv);
  // R3-T002 续（默认 provider 键）：设置默认 pick（「设为默认」存的行）——
  // 无旗标/env 时 provider+model 一起生效；读一次全局层。
  const storedModelDefaults = await readStoredModelDefaults(await readGlobalSettings());
  const envWindowTokens = Number(process.env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000;
  const registryProfiles = loadEffectiveProfiles();
  const bootProviderRaw = (providerFlags.provider ?? process.env.WUDAO_PROVIDER ?? "").trim();
  const bootProvider = registryProfiles.has(bootProviderRaw) ? bootProviderRaw : "deepseek";
  const bootModel = process.env.WUDAO_MODEL?.trim() || process.env.OPENAI_MODEL?.trim()
    || registryProfiles.get(bootProvider)?.defaultModel || "";
  const sessionWindowTokensFor = (provider: string | undefined, model: string): number =>
    resolveSessionWindowTokens({ effective: m62Effective, envWindowTokens, provider, model });
  const sessionWindowFor = (c: ProviderConfig): number => sessionWindowTokensFor(c.provider, c.model);
  const autoCompact = resolveAutoCompactSettings(
    m62Effective,
    resolveSessionWindowTokens({ effective: m62Effective, envWindowTokens, provider: bootProvider, model: bootModel }),
    mcpWarn,
  );
  const contextWindowTokens = autoCompact.windowTokens;

  // M62 §2: the startup lifecycle sweep (after config load, cheap). Expired
  // runtime data (sessions transcripts / spills / rewind snapshots / debug
  // logs older than cleanupPeriodDays) moves into .wudao/trash; trash older
  // than softDeletePeriodDays hard-deletes. The resumed session's file is
  // protected so --resume/--continue never races the sweep.
  {
    const skip: string[] = [];
    const sessionFlags = parseSessionFlags(argv);
    const sessionsDir = join(process.cwd(), ".wudao", "sessions");
    if (sessionFlags.resumeId !== undefined) {
      skip.push(join(sessionsDir, `${sessionFlags.resumeId}.jsonl`));
    } else if (sessionFlags.cont) {
      try {
        const ids = await createJsonlSessionStore(sessionsDir).list();
        const last = ids[ids.length - 1];
        if (last !== undefined) skip.push(join(sessionsDir, `${last}.jsonl`));
      } catch {
        /* no sessions dir — nothing to protect */
      }
    }
    const sweep = await runLifecycleSweep(
      process.cwd(),
      resolveLifecycleSettings(m62Effective, mcpWarn),
      Date.now(),
      skip,
    );
    const notice = formatSweepNotice(sweep);
    if (notice !== "") process.stdout.write(`${notice}\n`);
  }

  // Long-task execution (M23): gates + turn fuse, resolved once from the
  // settings' longTask node + env, threaded into every entry path.
  const longTaskRaw: LongTaskRuntime = resolveLongTaskRuntime(await loadLongTaskSettings(process.cwd()), process.env);
  // M53 §5: --no-gates removes the M23 stop gates from every entry path.
  // Review fix: DISABLE them (todo/verify false, like WUDAO_LONG_TASK_GATES=off)
  // — `gates: undefined` was a no-op, the loop defaults it back to on.
  const longTask: LongTaskRuntime = applyGatesAblation(longTaskRaw);

  // M46: output feedback (write-verify receipts; long-output shaping) — resolved
  // once from settings + env and INJECTED into the core tools (core stays settings-free).
  const writeVerify = isFeatureAblated("verify")
    ? undefined
    : resolveWriteVerifyRuntime(await loadWriteVerifySettings(process.cwd()), process.env);
  const longOutput = resolveLongOutputRuntime(await loadLongOutputSettings(process.cwd()), process.env);
  // 114: the persistent python kernel's idle window is resolved INSIDE runReal
  // (beside its buildToolSet) and in the REPL branch (replPythonKernel) — the
  // two frontends that build full tool sets on this path.
  // ω99-315: the dual-tier stream idle watchdog budget (soft warn / hard
  // abort) — same Loader contract, injected via ProviderOptions at every
  // createProvider site (providers stay settings-unaware).
  const streamIdleOpts = streamIdleProviderOptions(await loadStreamSettings(process.cwd()));

  // M59 §3: the web runtime — search provider config (present → web_search
  // registers; absent → the tool stays out of the list, /doctor carries the
  // guidance), fetch caps, and the web.allowDomains pre-approval list for
  // the permission gate. Resolved ONCE from both settings tiers; fetch
  // itself is zero-config always-on.
  // 安全审计 2026-11 C3 — 未信任工作区的克隆层 web 节点整体抑制（外联
  // 预授权面：allowDomains/allowedPorts/search.endpoint）；/trust 后恢复。
  const webSettings = await loadWebSettings(process.cwd(), mcpWarn, { suppressUntrustedProject: trustSuppressedLive() });
  const webRuntime: WebToolsRuntime = {
    fetch: { maxChars: webSettings.fetch.maxChars, allowedPorts: webSettings.fetch.allowedPorts },
    ...(webSearchConfig(webSettings) !== undefined ? { search: webSearchConfig(webSettings)! } : {}),
  };
  const webAllow = webSettings.allowDomains.length > 0 ? webSettings.allowDomains : undefined;
  // ω99-112: the session's browser runtime for the REPL closure below (the
  // ui/TUI driver builds its own beside its scheduler; the one-shot path
  // builds its own beside runReal's scheduler). Zero-IO construction; the
  // kernel downloads/launches only when the model first opens a page.
  const browserRuntime = createBrowserRuntime();
  // M59 §3: the /doctor web node — the SAME startup-loaded state the tool
  // registry saw (what /doctor reports matches what is actually registered).
  const webDoctor: WebDoctorInput = { search: webSettings.search };

  // M45: sidecar resolution once per process (settings → env → flag); each
  // frontend builds its instance from its own provider config below.
  const sidecarRuntime = isFeatureAblated("sidecar")
    ? { enabled: false, settings: undefined } as const
    : resolveSidecarRuntime(await loadSidecarSettings(process.cwd(), mcpWarn), process.env, argv);
  const buildSidecar = (config: ProviderConfig): Sidecar | undefined =>
    sidecarRuntime.enabled ? createSidecarFromConfig(config, sidecarRuntime.settings as never) : undefined;

  // M27 skills (.agents/skills + .wudao/skills + the global tier, optional):
  // loaded once and threaded into every entry path — prompt tail manifest +
  // /skill:name resolution. Like MCP: optional, warn-not-crash. M36: plugin
  // skills are the FOURTH source. M58 §C#4: the settings overlay (both tiers
  // unioned) hides skills from the manifest while keeping /skill: working.
  // A3: the whole list comes from buildExtensionState — rescanExtensions()
  // rebuilds it and the frontends' swap sinks land it in the live session
  // (only the prompt's trailing <available_skills> manifest moves).
  const skills = extState.skills;

  // Best-effort MCP shutdown on hard exits (SIGINT paths call process.exit):
  // close()'s synchronous stdin-EOF still runs; the 2s wait/SIGTERM may not.
  // P2-9: the language server gets the same hard-exit sweep.
  const closeSidecars = (): void => { bestEffortCloseMcpTools(); bestEffortCloseLspTools(); bestEffortCloseTerminalTools(); }; // P2-12: PTY 同款 hard-exit sweep
  process.once("exit", closeSidecars);
  installSigtermExit({ cleanup: closeSidecars });

  if (parseSessionFlags(argv).list) {
    // M33 §3: the table — id · mtime · messages · first user message (50) ·
    // model · name. M58 §C#7: inside a worktree the default hides sessions
    // recorded under a different root; --all lifts the filter.
    const sessionsDir = join(process.cwd(), ".wudao", "sessions");
    const filter = await defaultSessionListFilter(process.cwd(), argv.slice(2));
    process.stdout.write(formatSessionTable(await collectSessionRows(sessionsDir, filter !== undefined ? { filterWorkspaceRoot: filter } : {})));
    return;
  }

  // Provider selection flags (--provider / --reasoning-effort) are parsed from
  // raw argv (hoisted above the §7 window resolution — the boot window needs
  // the boot provider); stripLogFlags below removes them (and their values)
  // from the prompt.

  // `wudao ui` — the localhost web frontend (M43-A): AgentDriver + WS server.
  // Same flag chain as the TUI path (buildRunPlan / resolveSession), minus
  // the prompt: the browser drives the session.
  if (argv[2] === "ui") {
    // M63 §C: the ui boot plan — a missing key no longer exits; the web UI
    // boots (a ready file-keyed provider, or the wizard's placeholder) and
    // the first-run wizard takes over when nothing is ready.
    // R6 quickwin: the Ctrl+S-persisted pick defaults (model.defaultModel /
    // model.defaultEffort) ride the boot when no flag/env pins the field —
    // the read side that makes the pickers'「设为默认」real.
    // 推理档三级配置 S2: passed UNCONDITIONALLY now — the boot's effort fold
    // (binding ?? global) runs inside applyStoredModelDefaults even when the
    // stored defaults are empty, because the registry binding tier must
    // apply with or without any stored pick.
    const boot = buildUiBootPlan({
      prompt: "",
      provider: providerFlags.provider,
      reasoningEffort: providerFlags.reasoningEffort,
      storedModelDefaults,
      ...(providerFlags.model !== undefined ? { model: providerFlags.model } : {}),
    });
    if (boot.kind === "exit") {
      process.stdout.write(`wudao-harness v${VERSION}\n\n${boot.message}\n`);
      return;
    }
    if (boot.notice !== undefined) process.stdout.write(`${boot.notice}\n`);
    // M62 §7: the fallbackModel chain rides the config every frontend uses.
    const decoratedConfig = decorateConfig(boot.config);
    const sessionsDir = join(process.cwd(), ".wudao", "sessions");
    const store = createJsonlSessionStore(sessionsDir);
    const { sessionId, history, lastModel, forked, fresh } = await resolveSession(argv, store, sessionsDir);
    // #48 (hermes#4 turn-lease slice): fail-fast — this process is about to
    // become the session's run-writer; a live foreign holder refuses the
    // boot outright (terminal `wudao --resume X` vs a desktop server on X).
    // Fresh ids acquire trivially; the boot lease rides the root-memoized
    // box the driver's run gate shares.
    {
      const bootBox = sessionLeaseBoxFor(sessionsDir);
      // #48: an INFRASTRUCTURE failure (unusable sessions root) is not a
      // holder conflict — nobody can hold a lease over an unwritable root,
      // so the boot degrades open with one stderr line instead of dying.
      let bootLease: Awaited<ReturnType<typeof bootBox.acquire>> | undefined;
      try {
        bootLease = await bootBox.acquire(sessionId);
      } catch (err) {
        process.stderr.write(`⚠️ 会话租约不可用（${err instanceof Error ? err.message : String(err)}）— 继续启动，本次运行无跨进程占用保护\n`);
      }
      if (bootLease?.ok === false) {
        process.stderr.write(
          `⚠️ 会话 ${sessionId} 正被进程 ${bootLease.holder.pid} 占用 — 该会话已在另一 wudao 进程运行;` +
            `若确认无进程在使用,删除 ${join(sessionsDir, ".leases", `${sessionId}.json`)} 后重试\n`,
        );
        await stdoutGuard.flushRawStdout();
        process.exit(1);
      }
    }
    hookCommon.sessionId = sessionId;
    hookWorkspaceRoot.current = process.cwd(); // R6-P2: payloads build transcript_path against the entry's real root
    hookTranscriptRoot.current = process.cwd(); // B2 review: anchor transcript_path to the BOOT root, not the live one
    hookCommon.effort = decoratedConfig.reasoningEffort;
    // ω99-211: #1 — a FRESH boot id writes NOTHING here (route A, 落盘延迟):
    // this boot bookkeeping is what materialized `.wudao/sessions/<id>.jsonl`
    // the moment the desktop opened — a zero-message row in every session
    // list on every entry. The engine defers the same entries (model_change +
    // workspace_root) to the FIRST user submit (sessionFresh below).
    // Resume/continue/fork ids keep the boot writes verbatim: they land on an
    // EXISTING file (divergence recording + the M58 cross-root re-point), so
    // nothing new materializes and their semantics are unchanged.
    if (!fresh) {
      // M28/M33: same model-state + name recording as the TUI startup.
      await recordModelState(store, sessionId, decoratedConfig, lastModel);
      if (history.length > 0) await ensureSessionName(store, sessionId);
      // M58 §C#7: record where this session runs (worktree filter data).
      await ensureWorkspaceRootEntry(store, sessionId, process.cwd());
    }
    // P2-12（96 队列 #12）: the terminal tool's audit entries ride this
    // session's JSONL (appendSessionEntry — worktree_enter 同款缝; a sink
    // absent = no entries, the embedder boundary).
    setTerminalHistorySink((entry) => { void appendSessionEntry(store, sessionId, entry).catch(() => {}); });
    // 夜移 018 (延迟预取 wudao 适配): same as the TUI boot — the MCP load
    // runs in the background; the ui server listens without the handshake
    // sum, and runUi feeds the driver when the tools resolve.
    const mcpReady = loadMcpToolsFor(process.cwd(), plugins);
    void mcpReady.then((tools) => { hookMcpTools.current = tools; }, () => { hookMcpTools.current = []; });
    const uiReadState = createReadStateTable();
    const uiPort = parseUiPort(argv);
    try {
      await runUi({
        config: decoratedConfig,
        workspaceRoot: process.cwd(),
        // P1-5: the trust gate's boot notice + the watcher's live getter.
        ...(bootTrustNotice !== undefined ? { bootNotices: [bootTrustNotice] } : {}),
        trustSuppressed: trustSuppressedLive,
        // §7: per-model window for THIS boot config (the ui boot may have
        // substituted a ready provider); the resolver rides along so the
        // session engine re-resolves on every /provider switch knob-aware.
        contextWindowTokens: sessionWindowFor(decoratedConfig),
        resolveWindowTokens: sessionWindowTokensFor,
        resumeHistory: history,
        sessionId,
        // ω99-211 — fresh boot → the engine defers disk materialization to
        // the first user submit (zero-empty-session entry).
        ...(fresh ? { sessionFresh: true } : {}),
        sidecar: buildSidecar(boot.config),
        // 夜移 018: MCP tools ride deferredTools (background load — the
        // desktop's time-to-UI skips the handshake sum); extensions stay
        // eager (local, fast). P2-9: the settings-gated lsp tool appends at
        // the tail (lazy spawn — construction is free).
        extraTools: [...extensions.tools, ...lspToolsFor(process.cwd()), ...terminalToolsFor(process.cwd())],
        deferredTools: mcpReady,
        ...(sandboxOpts ? { sandbox: sandboxOpts.sandbox } : {}),
        hooks,
        // M63-A: a --fork-session boot reports "fork" as the SessionStart source.
        ...(forked ? { sessionStartSource: "fork" as const } : {}),
        // M63-B: the FileChanged watchers + the skills ConfigChange face.
        fileChangeTargets: fileWatchTargets,
        configSkillsPath: configSkillsRoot,
        rewakeSink: hookRewake,
        hookRuntime: hookRuntimeView,
        promptIdBox: hookPromptId, sessionIdBox: hookSessionId, hookWarnSink: hookWarn,
        gates: longTask.gates,
        maxTurns: longTask.maxTurns,
        skills,
        pluginCommands,
        pluginAgents,
        extensions,
        readState: uiReadState,
        ...(writeVerify ? { writeVerify } : {}),
        ...(longOutput ? { longOutput } : {}),
        ...(uiPort !== undefined ? { port: uiPort } : {}),
        // M59 §3: web runtime + the domain pre-approval list.
        web: webRuntime,
        ...(webAllow !== undefined ? { webAllowDomains: webAllow } : {}),
        webDoctor,
        // --no-open: print the URL but skip the auto-launch (automation/smoke).
        openBrowser: !argv.includes("--no-open"),
        // ω99-235: #3 — mount the pet lane (the sprite's own isolated driver
        // session; ui.ts #2 owns the lane's construction).
        petLane: true,
      });
    } finally {
      await closeMcpTools();
      await closeLspTools(); // P2-9: the language server gets the same bounded drain
      await closeTerminalTools(); // P2-12: the PTY sessions get the same bounded drain
    }
    return;
  }

  // `wudao slack` — the Slack interface (M60): Bolt Socket Mode, no public
  // ingress. Every Slack thread maps to a NORMAL JSONL session through the
  // shared driver session engine (the same machinery `wudao ui` uses), so
  // /resume, the steering queue, and the whole permission pipeline apply
  // unchanged — the relay only swaps the ask's presentation surface.
  // --doctor runs the offline checks WITHOUT a model key. The package is an
  // optional frontend: the dynamic (variable-specifier) import keeps the
  // cold-tree build acyclic (slack imports cli's dist types) and a missing
  // install degrades to guidance instead of a crash.
  if (argv[2] === "slack") {
    type SlackModule = { slackMain: (props: Record<string, unknown> & { readonly argv: readonly string[] }) => Promise<number> };
    const spec = "@wudao-org/slack";
    let mod: SlackModule;
    try {
      mod = (await import(spec)) as SlackModule;
    } catch (err) {
      stdoutGuard.writeRawStdout(
        `@wudao-org/slack could not be loaded (${err instanceof Error ? err.message : String(err)}) — ` +
          `it ships as its own package; build/install packages/slack first\n`,
      );
      await stdoutGuard.flushRawStdout();
      process.exit(1);
    }
    if (argv.includes("--doctor")) {
      const doctorCode = await mod.slackMain({ workspaceRoot: process.cwd(), argv: argv.slice(3) });
      await stdoutGuard.flushRawStdout();
      process.exit(doctorCode);
    }
    const slackPlan = buildRunPlan({ prompt: "", provider: providerFlags.provider, reasoningEffort: providerFlags.reasoningEffort, ...(providerFlags.model !== undefined ? { model: providerFlags.model } : {}), ...(storedModelDefaults !== undefined && storedModelDefaults.model !== undefined ? { storedModelDefaults } : {}) });
    if (slackPlan.kind === "no-key") {
      process.stdout.write(
        slackPlan.reason
          ? `wudao-harness v${VERSION}\n\n${slackPlan.reason}\n`
          : `wudao-harness v${VERSION}\n\nNo API key found. Set WUDAO_API_KEY (or OPENAI_API_KEY), or run "wudao ui" and follow the first-run wizard (新手向导) to save a key, then rerun.\n`,
      );
      return;
    }
    const slackMcpTools = await loadMcpToolsFor(process.cwd(), plugins);
    hookMcpTools.current = slackMcpTools;
    try {
      const code = await mod.slackMain({
        argv: argv.slice(3),
        config: decorateConfig(slackPlan.config),
        workspaceRoot: process.cwd(),
        // §7: per-model window for the slack boot config.
        contextWindowTokens: sessionWindowFor(slackPlan.config),
        resolveWindowTokens: sessionWindowTokensFor,
        // M62 §7: the auto-compaction master switch.
        compactionEnabled: autoCompact.enabled,
        sidecar: buildSidecar(slackPlan.config),
        // P2-9: the settings-gated lsp tool rides the same tail.
        // P2-12: the settings-gated terminal tool rides the same tail (the
        // slack frontend holds no session store in this scope — its terminal
        // actions run without audit entries; the documented v1 boundary).
        extraTools: [...slackMcpTools, ...extensions.tools, ...lspToolsFor(process.cwd()), ...terminalToolsFor(process.cwd())],
        ...(sandboxOpts ? { sandbox: sandboxOpts.sandbox } : {}),
        hooks,
        gates: longTask.gates,
        maxTurns: longTask.maxTurns,
        skills,
        pluginCommands,
        pluginAgents,
        extensions,
        web: webRuntime,
        ...(webAllow !== undefined ? { webAllowDomains: webAllow } : {}),
        webDoctor,
        // F2 (review): write-verify + long-output ride the SAME settings as every entry path.
        ...(writeVerify ? { writeVerify } : {}),
        ...(longOutput ? { longOutput } : {}),
      });
      if (code !== 0) {
        await stdoutGuard.flushRawStdout();
        process.exit(code);
      }
    } finally {
      await closeMcpTools();
      await closeLspTools(); // P2-9: the language server gets the same bounded drain
      await closeTerminalTools(); // P2-12: the PTY sessions get the same bounded drain
    }
    return;
  }

  // The prompt: the pre-`--` flag window minus known flags, then every
  // post-`--` positional appended (the bare `--` itself never joins).
  // 小精灵会话弧 — 恢复即追问：--ask 配 --resume/--continue 时以追问问题
  // 替换 one-shot prompt（resolveSession 在 runReal 里完成 resume；问题即
  // 开场）。缺值/混用 fail-closed（打印后非零退出，绝不静默降级）。
  let prompt = promptFromArgv(rawArgv.slice(2));
  const askOpening = resolveAskOpening(argv, prompt);
  if (askOpening.error !== undefined) {
    process.stderr.write(`${askOpening.error}\n`);
    process.exit(1);
  }
  if (askOpening.kind === "question") prompt = askOpening.question ?? prompt;
  // M37 §1: --plan turns the one-shot prompt into a plan run (read-only
  // whitelist, board as the plan) followed — on a TTY — by the ok-to-execute
  // question. Without a prompt there is nothing to plan.
  const planFlag = parsePlanFlag(argv);
  if (planFlag && !prompt) {
    process.stdout.write("--plan needs a goal: wudao --plan \"<goal>\"\n");
    return;
  }

  // M79 §5: --image rides ONE-SHOT prompts only. Without a prompt the flag
  // would launch the interactive TUI/REPL with the images silently stripped
  // (stripLogFlags) and dropped — exactly the silent drop this milestone
  // forbids everywhere else. Refuse loudly, non-zero.
  if (parseImageFlags(argv).length > 0 && !prompt) {
    process.stderr.write("--image needs a one-shot prompt: wudao \"<prompt>\" --image <path>\n(interactive image input arrives with the web composer in M79b)\n");
    process.exit(1);
  }

  if (!prompt) {
    // Interactive mode: Ink TUI on a real terminal (default), readline REPL with
    // --no-tui, guidance otherwise.
    const plan = buildRunPlan({ prompt: "", provider: providerFlags.provider, reasoningEffort: providerFlags.reasoningEffort, ...(providerFlags.model !== undefined ? { model: providerFlags.model } : {}), ...(storedModelDefaults !== undefined && storedModelDefaults.model !== undefined ? { storedModelDefaults } : {}) });
    if (plan.kind === "no-key") {
      process.stdout.write(
        plan.reason
          ? `wudao-harness v${VERSION}\n\n${plan.reason}\n`
          : `wudao-harness v${VERSION}\n\nNo API key found. Set WUDAO_API_KEY (or OPENAI_API_KEY), or run "wudao ui" for the first-run wizard (新手向导); no-key demo: pnpm demo\n`,
      );
      // Task 8 fix 2: a bare no-key `wudao` no longer dead-ends. On a TTY one
      // Enter re-enters main() AS `wudao ui` — the SAME in-process dispatch
      // the subcommand uses (no child process), whose boot plan launches the
      // first-run wizard. Non-TTY stdin (piped/headless/CI) keeps today's
      // notice-and-exit: a question there would hang the pipe.
      if (stdin.isTTY === true && (await askFirstRunWizard()) === true) {
        process.argv = [...argv.slice(0, 2), "ui"];
        await main();
      }
      return;
    }
    const noTui = argv.includes("--no-tui");
    const isTty = stdin.isTTY === true && stdout.isTTY === true;
    if (!noTui && isTty) {
      // M62 §7: the fallbackModel chain rides the config every frontend uses.
      const decoratedConfig = decorateConfig(plan.config);
      const sessionsDir = join(process.cwd(), ".wudao", "sessions");
      const store = createJsonlSessionStore(sessionsDir);
      const { sessionId, history, lastModel, forked } = await resolveSession(argv, store, sessionsDir);
      // M63-C R1: ONE assignment, from the ADORNED config (the TUI runs
      // decorateConfig(plan.config) — the raw plan config can diverge).
        // #48 (hermes#4 turn-lease slice): fail-fast — this process is about to
      // become the session's run-writer; a live foreign holder refuses the
      // boot outright (terminal `wudao --resume X` vs a desktop server on X).
      // Fresh ids acquire trivially; the boot lease rides the root-memoized
      // box the driver's run gate shares.
      {
        const bootLease = await sessionLeaseBoxFor(sessionsDir).acquire(sessionId);
        if (!bootLease.ok) {
          process.stderr.write(
            `⚠️ 会话 ${sessionId} 正被进程 ${bootLease.holder.pid} 占用 — 该会话已在另一 wudao 进程运行;` +
              `若确认无进程在使用,删除 ${join(sessionsDir, ".leases", `${sessionId}.json`)} 后重试\n`,
          );
          process.exit(1);
        }
    }
    hookCommon.sessionId = sessionId;
      hookWorkspaceRoot.current = process.cwd(); // R6-P2: payloads build transcript_path against the entry's real root
      hookTranscriptRoot.current = process.cwd(); // B2 review: anchor transcript_path to the BOOT root, not the live one
      hookCommon.effort = decoratedConfig.reasoningEffort;
      // M28: record model-state divergence entries before this session's
      // messages land (fresh sessions record their initial model).
      // M33 §3: a resumed session also gets its name recorded once (a fresh
      // session is named by the TUI at its first user turn).
      await recordModelState(store, sessionId, decoratedConfig, lastModel);
      if (history.length > 0) await ensureSessionName(store, sessionId);
      // M58 §C#7: record where this session runs (worktree filter data).
      await ensureWorkspaceRootEntry(store, sessionId, process.cwd());
    // P2-12（96 队列 #12）: the terminal tool's audit entries ride this
    // session's JSONL (appendSessionEntry — worktree_enter 同款缝; a sink
    // absent = no entries, the embedder boundary).
    setTerminalHistorySink((entry) => { void appendSessionEntry(store, sessionId, entry).catch(() => {}); });
      // M42 §1: the startup banner — once, before the first Ink frame (TUI
      // only; --quiet and non-TTY stdout skip it; narrow terminals degrade to
      // the single-line form).
      printBanner(
        {
          version: VERSION,
          model: modelLabel(plan.config),
          session8: sessionId.slice(0, 8),
          mode: modeLabel(resolveInitialMode(argv, process.env)),
        },
        { columns: stdout.columns, quiet: argv.includes("--quiet"), tty: true },
        (text) => stdout.write(text),
      );
      // 夜移 018 (延迟预取 wudao 适配): MCP loads in the BACKGROUND — first
      // paint never waits on server handshakes. The tools land through the
      // app's deferredTools effect (the user's typing window; a run already
      // in flight parks them at its settle boundary).
      const mcpReady = loadMcpToolsFor(process.cwd(), plugins);
      void mcpReady.then((tools) => { hookMcpTools.current = tools; }, () => { hookMcpTools.current = []; });
      // M32: one read-state table per session — shared by the tool set and
      // (inside the TUI) the external-change prober.
      const tuiReadState = createReadStateTable();
      // M64-A §A: the TUI's peer-messaging runtime (inbox + registry + the
      // tools' seams). The TUI never disposes its driver, so the stop rides
      // the finally below (idempotent — a driver dispose would be a no-op
      // after it).
      const tuiSidecar = buildSidecar(plan.config);
      // M64-A fix: the TUI's tier follows the LIVE mode — the driver's
      // setMode calls peer.setTier on every cycle (the argv seed only covers
      // the boot instant). The spec's pre-delivery review and the
      // peerDialogExpiry setting ride the shared helpers.
      const tuiDialogExpiry = await readPeerDialogExpiry(process.cwd());
      const tuiPeer = await createPeerRuntime({
        workspaceRoot: process.cwd(),
        sessionId,
        ...(parseSessionNameFlag(argv) !== undefined ? { name: parseSessionNameFlag(argv) } : {}),
        env: process.env,
        ...(sandboxOpts ? { sandboxed: true } : {}),
        tier: () => (resolveInitialMode(argv, process.env) === "auto" ? "bypass" : "normal"),
        ...(tuiSidecar !== undefined ? { reviewMessage: sidecarMessageReview(tuiSidecar) } : {}),
        ...(tuiDialogExpiry !== undefined ? { dialogExpiryMs: tuiDialogExpiry } : {}),
        notify: (line) => process.stdout.write(`${line}\n`),
      });
      try {
        await runTui({
          config: decoratedConfig,
          workspaceRoot: process.cwd(),
          // ω99-315: the idle watchdog budget (loaded with the other boot
          // settings above — streamIdleOpts).
          streamIdle: streamIdleOpts,
          // P1-5: the trust gate's boot notice + the watcher's live getter.
          ...(bootTrustNotice !== undefined ? { bootNotices: [bootTrustNotice] } : {}),
          trustSuppressed: trustSuppressedLive,
          // §7: per-model window for the TUI boot config + the re-resolve
          // seam (I1: /model and /provider switches recompute knob-aware).
          contextWindowTokens: sessionWindowFor(decoratedConfig),
          resolveWindowTokens: sessionWindowTokensFor,
          // M62 §7: the auto-compaction master switch (false = the loop runs
          // without compaction; manual /compact still works).
          compactionEnabled: autoCompact.enabled,
          // 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线的 misc 旋钮
          // （boot 一次读；窗口语义/请求帽由 app-agent-opts 从 live config 重读）。
          compactionSettings: compactionSettingsFromNode(m62Effective["compaction"], mcpWarn),
          resumeHistory: history,
          sessionId,
          sidecar: tuiSidecar,
          // M39: extension tools ride the same extraTools tail as MCP tools
          // (parent-level only, never a child set, never deferred).
          // 夜移 018: MCP tools ride deferredTools instead (background load).
          // P2-9: the settings-gated lsp tool appends after them (list tail,
          // append-only; children never see it — same boundary as MCP).
          extraTools: [...extensions.tools, ...lspToolsFor(process.cwd()), ...terminalToolsFor(process.cwd())],
          deferredTools: mcpReady,
          ...(sandboxOpts ? { sandbox: sandboxOpts.sandbox } : {}),
          hooks,
          ...(forked ? { sessionStartSource: "fork" as const } : {}),
          fileChangeTargets: fileWatchTargets,
          configSkillsPath: configSkillsRoot,
          rewakeSink: hookRewake,
          hookRuntime: hookRuntimeView,
          promptIdBox: hookPromptId, sessionIdBox: hookSessionId, hookWarnSink: hookWarn,
          gates: longTask.gates,
          maxTurns: longTask.maxTurns,
          skills,
          pluginCommands,
          // M40: plugin agents → the TUI's tool set roster layer.
          pluginAgents,
          extensions,
          readState: tuiReadState,
          // M59 §3: web runtime + the domain pre-approval list.
          web: webRuntime,
          ...(webAllow !== undefined ? { webAllowDomains: webAllow } : {}),
          webDoctor,
          // M64-A §A: peer messaging rides the TUI like every other frontend.
          peer: tuiPeer,
          // SDD 2026-08-23 persona Task 4 — the REAL chain reads ride the
          // production entry (the app prop defaults stay test stubs).
          readProviderPersonaBinding,
          readGlobalDefaultPersonaId,
          // 0.3.11: the boot-resolved permission mode (flag > persisted
          // default) — the app prop default stays argv-only for hermetic
          // direct-construction tests.
          initialPermissionMode: resolveInitialMode(process.argv, process.env),
        });
      } finally {
        await tuiPeer.stop();
        await closeMcpTools();
        await closeLspTools(); // P2-9: the language server gets the same bounded drain
        await closeTerminalTools(); // P2-12: the PTY sessions get the same bounded drain
      }
      return;
    }
    if (!noTui) {
      process.stdout.write(`No prompt given and no interactive terminal detected.\nPass a prompt (wudao "<prompt>") or rerun with --no-tui for the readline REPL.\n`);
      return;
    }
    const replLevel = parseLogLevel(argv, process.env);
    const replGe = (l: LogLevel) => LEVEL_ORDER[replLevel] >= LEVEL_ORDER[l];
    const replMcpTools = await loadMcpToolsFor(process.cwd(), plugins);
    // M25 §A2: --no-tui resumes through the SAME resolveSession the TUI uses
    // (--resume/--continue), so both frontends see identical history.
    const replSessionsDir = join(process.cwd(), ".wudao", "sessions");
    const replStore = createJsonlSessionStore(replSessionsDir);
    const replSession = await resolveSession(argv, replStore, replSessionsDir);
    hookCommon.sessionId = replSession.sessionId;
    hookWorkspaceRoot.current = process.cwd(); // R6-P2: payloads build transcript_path against the entry's real root
    hookCommon.effort = decorateConfig(plan.config).reasoningEffort;
    // M28: same model-state recording as the one-shot/TUI paths.
    // M33 §3: record the resumed session's name once (same rule as the TUI).
    await recordModelState(replStore, replSession.sessionId, decorateConfig(plan.config), replSession.lastModel);
    if (replSession.history.length > 0) await ensureSessionName(replStore, replSession.sessionId);
    // M58 §C#7: record where this session runs (worktree filter data).
    await ensureWorkspaceRootEntry(replStore, replSession.sessionId, process.cwd());
    // Per-REPL-session spill dir (the REPL keeps no session store, but a
    // stable id still keeps one process's spills grouped).
    const replSpillDir = join(process.cwd(), ".wudao", "spill", `repl-${newId()}`);
    // ω-4d: one login-shell snapshot provider per REPL session (lazily
    // resolved on the first host-path shell; single-flight, failure
    // cached — see shell-snapshot.ts). undefined (kill switch / no $SHELL /
    // unsupported shell) contributes nothing below.
    const replLoginShellEnv = maybeLoginShellEnv(process.cwd());
    // M30: one background registry for the whole REPL session; leaving the
    // REPL cancels whatever is still in flight. Model overrides resolve
    // cache-tracked like the REPL's own model.
    const replRegistry = createSessionRegistry();
    // M80: resolver-built REPL children share the workspace attachment store
    // (runRepl keeps its own instance for the session model — same files).
    const replResolveModel = createProviderModelResolver({ wrap: (m) => createCacheTrackingModel(m), attachments: createFileAttachmentStore(process.cwd()) });
    // design 70 §4 Phase 2 — funnel-1 wiring for the REPL's buildTools gate.
    // Late-bound reviewer model (same shape as `toolsBox` below): the closure
    // reads `current` at ASK time so a capture-the-model-when-the-buildTools-
    // callback-fires race cannot strand a stale/null client reference. The
    // REPL's `/model` switch updates the live model — the box is written from
    // inside the buildTools callback when runRepl invokes it, matching the
    // M51 §3 toolsBox pattern (set once on tool-set construction; the gate's
    // askReview closure reads via the box).
    const replReviewerBox: { current?: ModelClient } = {};
    // ω99-92: the REPL's live-effort box — the caller owns the ONE instance
    // and hands BOTH sides the same object (the replReviewerBox pattern):
    // runRepl arms it over its liveConfig (the 86 five-segment path's last
    // frontend wiring — the REPL's spawns were the idle lane, reporting the
    // boot baseline while the child's requests ran at the live config's
    // effort), and the buildTools closure below threads it into buildToolSet
    // so the task tool's spawn site reads the session's LIVE level.
    const replEffortLiveBox: { get?: () => string | undefined } = {};
    // ω99-8: the subagent cost sink — buildTools (below) wires the task
    // tool's onSubagentUsage into this box BEFORE runRepl creates its
    // CostRegistry; runRepl binds the registry onto it at its creation (the
    // replReviewerBox pattern: cross-scope late binding).
    const subagentUsageSink = createSubagentCostSink();
    // M32: one read-state table for the whole REPL session — the tool set
    // (freshness gate) and the external-change prober share it.
    const replReadState = createReadStateTable();
    // M37 §2: one file history for the whole REPL session — write_file/edit
    // snapshot into it, /rewind reads it back.
    const replFileHistory = createFileHistory(join(process.cwd(), ".wudao", "history", replSession.sessionId));
    // ω99-32 T1: the REPL's LIVE persistence identity — /clear rotates it
    // (M80 parity). The boot-bound closures below (extension binding, the
    // terminal audit sink, the -2b paged tool-result recovery) read THIS box,
    // and onSessionRotated re-binds the binding-box seams to the fresh
    // segment. Known boundaries that deliberately stay on the boot id: the
    // file-history dir (/rewind's own home) and the peer/cron identity
    // surfaces (operator-facing continuity, not conversation persistence).
    const replSidLive = { current: replSession.sessionId };
    // M39: the REPL binds extensions to the same store resolveSession used
    // (model-state entries already ride it) so appendEntry/readEntries work;
    // tools and commands ride the same seams as the other frontends.
    extensions.bindSession(replStore, replSession.sessionId);
    // P2-9: the settings-gated lsp tool rides the same tail (append-only).
    // P2-12: the terminal tool rides the same tail (append-only) + its audit
    // entries ride the REPL session's JSONL.
    setTerminalHistorySink((entry) => { void appendSessionEntry(replStore, replSidLive.current, entry).catch(() => {}); });
    const replExtraTools: Tool[] = [...replMcpTools, ...extensions.tools, ...lspToolsFor(process.cwd()), ...terminalToolsFor(process.cwd())];
    // M45 review: ONE sidecar instance for the whole REPL session — the main gate (repl.ts) and the buildTools gate below share the classifier cache AND the breaker.
    const replSidecar = buildSidecar(plan.config);
    // PB-2（探针基础设施弧）— REPL 的探针审计装配（设置 probe.auditFile 驱动；缺省零 IO 零输出）。
    await setupProbeAudit({ workspaceRoot: process.cwd() });
    // 借鉴弧 C1：长日志瘦身端口（缺省关）。
    const replLogSlimming = await loadLogSlimmingPortsForBoot(decorateConfig(plan.config));
    // 114：REPL 会话的 python kernel idle 窗（settings pythonKernel）。
    const replPythonKernel = await loadPythonKernelSettings(process.cwd());
    // 夜移 032 stage-2: the REPL session's net-change tracker — ONE instance
    // shared by the buildTools closure below (write_file/edit record) and
    // runRepl's own opts (reset at each turn boundary, receipt at settle).
    const replTurnDiff = createTurnDiffTracker();
    // M62 §7 曾在此解析 M49 的 replMemoryStore；M-Memory 弧第二半起模型记忆
    // 工具面换轨长期记忆三件套（M49 的 memory_write/memory_search 不再挂载，
    // 回滚见下方 buildTools 缝注释）。
    // M-Memory 弧第二半 — REPL 的长期记忆 runtime（boot 召回注入走 runTurn
    // 首轮缝 + 会话终了沉淀；单例供 repl.ts 的注入/rescan 位点与 /memory
    // 命令道取用）。
    const replLtsMemory = await createLongtermMemoryRuntime({ workspaceRoot: process.cwd() });
    setLongtermMemoryRuntime(replLtsMemory);
    // §7: the REPL's per-model boot window (the tool set's defer gate and the
    // compaction trigger share it); the resolver rides along so /model and
    // /provider switches re-resolve at their turn boundaries.
    const replWindowTokens = sessionWindowFor(decorateConfig(plan.config));
    // 125 项 2（codex get_context_remaining 形）：水位线查询工具的触发线晚绑盒
    // + boot 兜底（replEffortLiveBox 同款：buildTools 闭包读，runRepl 武装）。
    const replCompactionThresholdBox: {
      get?: () => {
        readonly windowTokens: number;
        readonly thresholdRatio?: number;
        readonly headroomTokens?: number;
        readonly outputReserveTokens?: number;
      };
    } = {};
    const replBootConfig = decorateConfig(plan.config);
    const replBootCompactionSettings = compactionSettingsFromNode(m62Effective["compaction"], mcpWarn);
    try {
      await runRepl({
        config: decorateConfig(plan.config),
        workspaceRoot: process.cwd(),
        // P1-5: the trust gate's boot notice (stdout) + the live getter for
        // the REPL's permission settings watcher.
        ...(bootTrustNotice !== undefined ? { bootNotices: [bootTrustNotice] } : {}),
        trustSuppressed: trustSuppressedLive,
        resumeHistory: replSession.history,
        sessionId: replSession.sessionId,
        // ω99-32 T1: /clear rotated the id — the binding-box seams follow the
        // fresh segment (the terminal sink already reads the live box).
        onSessionRotated: (_from, to) => {
          replSidLive.current = to;
          extensions.bindSession(replStore, to);
        },
        sidecar: replSidecar,
        turnDiff: replTurnDiff,
        // ω99-92: the arming side — runRepl arms replEffortLiveBox.get over
        // its liveConfig (the same instance buildTools threads below).
        effortLiveBox: replEffortLiveBox,
        // 125 项 2: the arming side for the watermark tool's threshold seam
        // (runRepl arms it over liveConfig/windowRef once both exist).
        compactionThresholdLiveBox: replCompactionThresholdBox,
        // M55 §B12: the plugin agent layer (/agents provenance; the tool set
        // loads the same list).
        pluginAgents,
        buildTools: (model, stateHandle) => {
          // design 70 §4 Phase 2: capture the live REPL model into the late-
          // bound box before constructing the gate. The closure below reads
          // it at ASK time — the box pattern means the gate never captures a
          // snapshot (a `/model` switch before the first ask could otherwise
          // strand a stale client reference).
          replReviewerBox.current = model;
          return buildToolSet({
            workspaceRoot: process.cwd(),
            model,
            canUseTool: createPermissionGate(argv, replSidecar, undefined, undefined, webAllow, hooks?.onPermissionRequest, async (t, i) => {
              const m = replReviewerBox.current;
              return m === undefined ? Promise.resolve(undefined) : askReviewIntro(m, t, i);
            }, resolveInitialMode(argv, process.env), trustSuppressedLive),
          contextWindowTokens: replWindowTokens,
          turnDiff: replTurnDiff,
          onSubagentEvent: subagentEventHandler(replGe),
          // ω99-8: child usage rows → the sink → the REPL's cost registry.
          onSubagentUsage: (info) => subagentUsageSink.record(info),
          extraTools: replExtraTools,
          spillDir: replSpillDir,
          ...(replLoginShellEnv !== undefined ? { loginShellEnv: replLoginShellEnv } : {}),
          // ω-2b (I3): the paged tool-result recovery tool over the REPL
          // session's JSONL (newest-first; sidechains not searched).
          sessionResult: {
            load: async (toolCallId) =>
              (await replStore.load(replSidLive.current)).filter((m): m is import("@wudao-org/core").ToolResultMessage => m.role === "tool" && m.toolCallId === toolCallId),
          },
          // 121 挖掘 TOP5 #1: the conversation-history search over the LIVE
          // REPL session's JSONL (beside session_result — same family, same
          // pure bypass read; sidechains not searched).
          historySearch: {
            load: () => historySearchCorpus(replStore, replSidLive.current),
          },
          // 121 §1 续章: the persistent-notes pair over the LIVE REPL
          // session's .wudao/notes/<sid>/ directory (beside the retrieval
          // family; the sid follows session switches like the loaders above).
          notes: { sessionId: () => replSidLive.current },
          contextProbe: () => stateHandle.state?.messages ?? [],
          getForkContext: () => stateHandle.state,
          getSystemPrompt: () => stateHandle.state?.systemPrompt ?? "",
          // 125 项 2（codex get_context_remaining 形）：水位线查询工具——读
          // runRepl 武装的晚绑盒（live 窗口/config；replEffortLiveBox 同款），
          // 武装前（首 run 前）回落 boot 值。
          contextRemaining: {
            getThreshold: () => replCompactionThresholdBox.get?.() ?? {
              windowTokens: replWindowTokens,
              ...compactionThresholdFields(replBootConfig, replBootCompactionSettings),
            },
          },
          ...(sandboxOpts ? { sandbox: sandboxOpts.sandbox } : {}),
          readState: replReadState,
          history: replFileHistory,
          // M49 §1: the memory store rides the tool set (write+search at top
          // level; child sets draw memory_search only). M62 §7: session
          // settings (enabled/directory) honored via openSessionMemoryStore.
          // M-Memory 弧第二半：换轨长期记忆三件套（memory_search 同名互斥，
          // M49 两件不再挂载；回滚=换回 replMemoryStore 行）。
          ...(replLtsMemory.enabled ? { longtermMemory: { store: replLtsMemory.store } } : {}),
          ...(writeVerify ? { writeVerify } : {}),
          ...(longOutput ? { longOutput } : {}),
          ...(replLogSlimming !== undefined ? { logSlimming: replLogSlimming } : {}),
          // 114: the kernel's session knob (idle-reap window).
          pythonKernel: { idleTimeoutMs: replPythonKernel.idleTimeoutMs },
          // 夜移 029: the session's skills — threshold-gated discover_skills
          // (the manifest rider at the runRepl seam uses the same list).
          ...(skills.length > 0 ? { skills } : {}),
          web: webRuntime,
          // ω99-112: the browser sextet (fixed position after the web face,
          // before the scheduler trio; the runtime is the main-scope one).
          browser: browserRuntime,
          // ω99-92: the read side — the task tool's spawn site reads the box
          // runRepl armed (late-bound, the 79/86 discipline).
          effortLiveBox: replEffortLiveBox,
          agents: { registry: replRegistry, runId: replSession.sessionId, resolveModel: replResolveModel, defaultEffort: plan.config.reasoningEffort ?? "off", pluginAgents, ...(hooks !== undefined ? { hooks } : {}), hookRuntime: hookRuntimeView },
        });
      },
        contextWindowTokens: replWindowTokens,
        resolveWindowTokens: sessionWindowTokensFor,
        // M62 §7: the auto-compaction master switch.
        compactionEnabled: autoCompact.enabled,
        hooks,
        ...(replSession.forked ? { sessionStartSource: "fork" as const } : {}),
        rewakeSink: hookRewake,
        hookRuntime: hookRuntimeView,
        promptIdBox: hookPromptId, sessionIdBox: hookSessionId, hookWarnSink: hookWarn,
        extraTools: replExtraTools,
        gates: longTask.gates,
        maxTurns: longTask.maxTurns,
        skills,
        pluginCommands,
        extensionCommands: extensions.commands,
        readState: replReadState,
        fileHistory: replFileHistory,
        // M49 §2: the REPL spawns background reviews through the same
        // registry its task tool uses.
        agentsRegistry: replRegistry,
        // ω99-8: seat the subagent cost sink on the REPL's cost registry.
        subagentUsageSink,
        // M59 §3: the /doctor web node (search provider state).
        webDoctor,
        // M55 §C2: paths for /doctor checks.
        settingsPath: join(process.cwd(), ".wudao", "settings.json"),
        mcpConfigPath: join(process.cwd(), ".wudao", "mcp.json"),
        sessionDir: join(process.cwd(), ".wudao", "sessions"),
        wudaoDir: join(process.cwd(), ".wudao"),
        evalDir: join(process.cwd(), ".wudao", "evals"),
      });
    } finally {
      // Core's abortAll cancels every entry (registry-side settle is
      // synchronous); child runs observe the abort at their next checkpoint.
      replRegistry.abortAll();
      await closeMcpTools();
      await closeLspTools(); // P2-9: the language server gets the same bounded drain
      await closeTerminalTools(); // P2-12: the PTY sessions get the same bounded drain
    }
    return;
  }

  const plan = buildRunPlan({ prompt, provider: providerFlags.provider, reasoningEffort: providerFlags.reasoningEffort, ...(providerFlags.model !== undefined ? { model: providerFlags.model } : {}), ...(storedModelDefaults !== undefined && storedModelDefaults.model !== undefined ? { storedModelDefaults } : {}) });
  if (plan.kind === "no-key") {
    process.stdout.write(
      plan.reason
        ? `${plan.reason}\nSet WUDAO_BASE_URL (or pick another provider with --provider <name>), then rerun.\n`
        : `No API key found. Set WUDAO_API_KEY (or OPENAI_API_KEY), or run "wudao ui" and follow the first-run wizard (新手向导); optionally WUDAO_BASE_URL / WUDAO_MODEL, then rerun.\nFor a no-key demo: pnpm demo\n`,
    );
    return;
  }

  await runReal(plan.prompt, decorateConfig(plan.config), argv, sandboxOpts, hooks, longTask, plugins, skills, planFlag, extensions, buildSidecar(plan.config), writeVerify, longOutput, webRuntime, webAllow, autoCompact, streamIdleOpts);
}

async function runReal(prompt: string, config: ProviderConfig, argv: string[], sandboxOpts: { sandbox: { image?: string } } | undefined, hooks: AgentHooks | undefined, longTask: LongTaskRuntime | undefined, plugins: readonly LoadedPlugin[], skills?: readonly LoadedSkill[], planMode = false, extensions: ExtensionRuntime | undefined = undefined, sidecar: Sidecar | undefined = undefined, writeVerify: WriteVerifyConfig | undefined = undefined, longOutput: LongOutputConfig | undefined = undefined, web: WebToolsRuntime | undefined = undefined, webAllowDomains: readonly string[] | undefined = undefined, autoCompactRuntime: { readonly enabled: boolean; readonly windowTokens: number } | undefined = undefined, streamIdle: { streamIdleSoftMs: number; streamIdleHardMs: number } | undefined = undefined): Promise<void> {
  const level = parseLogLevel(argv, process.env);
  const ge = (l: LogLevel) => LEVEL_ORDER[level] >= LEVEL_ORDER[l];
  const workspaceRoot = process.cwd();
  // M79 §5: `--image <path>` (repeatable) — read + admit the files through
  // the workspace AttachmentStore BEFORE anything is persisted or started
  // (fail-closed: a bad path/type or an admission failure prints and exits
  // without creating a session). The blocks ride the first user turn as
  // durable refs; the provider gets the SAME store as its request-build
  // resolver.
  const attachments = createFileAttachmentStore(workspaceRoot);
  let imageBlocks: readonly ImageBlock[] = [];
  const imagePaths = parseImageFlags(argv);
  if (imagePaths.length > 0) {
    try {
      imageBlocks = await loadImageFiles(attachments, imagePaths);
    } catch (err) {
      process.stdout.write(`⚠️ --image: ${err instanceof Error ? err.message : String(err)}\n`);
      return;
    }
  }
  // M58 §C#2: the session's standing compact-instructions rider — the WUDAO.md/
  // AGENTS.md `## Compact Instructions` section, parsed once at session start
  // through the memoized project-context loader (project tier over global) and
  // woven into every tier-2 summary instruction this run.
  const compactInstructionsRider = getCompactInstructionsRider(workspaceRoot);
  // M62 §1: the gated context-rule matcher (undefined when there are none).
  const gatedRules = getContextRules(workspaceRoot).gated;
  const ruleMatcher = gatedRules.length > 0 ? createContextRuleMatcher(workspaceRoot, gatedRules) : undefined;

  // Resolve the session: --resume <id> rehydrates a known session; --continue
  // rehydrates the most recent session; otherwise start a fresh id.
  const sessionsDir = join(workspaceRoot, ".wudao", "sessions");
  const store = createJsonlSessionStore(sessionsDir);
  const { sessionId, history, lastModel, forked } = await resolveSession(argv, store, sessionsDir);
  hookCommon.sessionId = sessionId;
  hookWorkspaceRoot.current = process.cwd(); // R6-P2: payloads build transcript_path against the entry's real root
  hookCommon.effort = config.reasoningEffort;
  // M28: record model-state divergence entries BEFORE this run's messages —
  // a fresh session opens with its model metadata, a resume records only the
  // switches (provider/model → model_change, effort → thinking_level_change).
  // M33 §3: name the session from its first user message (this run's prompt
  // for a fresh session; the stored one on resume). Recorded once.
  await recordModelState(store, sessionId, config, lastModel);
  await ensureSessionName(store, sessionId, prompt);
  // M58 §C#7: record where this session runs (worktree filter data).
  await ensureWorkspaceRootEntry(store, sessionId, workspaceRoot);
  // PB-2（基准×探针弧修平）：one-shot 的探针审计装配——此前只接了 REPL
  // 分支，一次性 run 的探针事件只进进程内环形缓冲、随进程消亡（基准跑
  // 分器全走 one-shot，实证 auditFile 永不落盘）。同一驱动（设置
  // probe.auditFile；缺省零 IO 零输出），同一相对路径语义（按 cwd 解析）。
  await setupProbeAudit({ workspaceRoot: process.cwd() });

  // M34 §2: expand @<path> mentions BEFORE the prompt enters the conversation
  // (read_file's constraints: workspace confinement + the 2000-line/50KB
  // window, wrapped in <file path=…>). The session NAME keeps the raw prompt;
  // notices (missing files, escapes) print dim and never enter the history.
  const mention = await expandMentions(prompt, workspaceRoot);
  for (const n of mention.notices) process.stdout.write(`\x1b[2m${n}\x1b[0m\n`);

  // M49 §1: the memory runtime — refresh the recall pool, surface pending
  // review suggestions once (the "next session" confirmation), and preload
  // the run's recall note into the MetaNote queue (first model call).
  const memoryRuntime = createMemoryRuntime(workspaceRoot);
  await memoryRuntime.refresh();
  const pendingReview = await surfacePendingReview(workspaceRoot);
  if (pendingReview !== undefined) process.stdout.write(`${pendingReview}\n`);

  // M24: the tracked model is what the loop AND every subagent see — usage
  // accounting stays session-wide, and a miss spike gets attributed (B3).
  // ω99-13: the one-shot's /goal --budget metering rides the same wrapper's
  // usage observer — the headless controller is created later (it needs the
  // loop's state handle), so a late-bound box bridges the two.
  const headlessGoalBox: { current?: GoalController } = {};
  // ω99-28 T3 — one cache event per line: the -p renderer streams deltas
  // without a trailing newline, so the break channel guards its own line
  // starts (the delta branches below feed the guard).
  const breakGuard = createBreakLineGuard((s) => process.stdout.write(s));
  const model = createCacheTrackingModel(createProvider(config, { attachments, ...(streamIdle !== undefined ? { ...streamIdle } : {}) }), {
    onBreak: (warning) => breakGuard.breakLine(warning),
    // ω99-8b/ω99-13: subagent rows are dropped (the task tool's forwarder owns
    // them); recordMainUsage's own partition drops the evaluator's rows.
    onUsage: (u, _s, _w, src) => {
      if (src === "subagent") return;
      headlessGoalBox.current?.recordMainUsage(u, src);
    },
  });
  // design 70 §4 Phase 2 — funnel-1 wiring (one-shot side). Captured into
  // the late-bound box below alongside `toolsBox` (same shape as the REPL's
  // `replReviewerBox`); the closure in createPermissionGate below reads
  // through it at ASK time.
  const oneShotReviewerBox: { current?: ModelClient } = { current: model };
  // M30: the session's background registry + the task tool's model-override
  // resolver (role pins / caller overrides → cache-tracked child client).
  // Process exit cancels whatever is still in flight.
  // M40: plugin agents join the task tool's roster (builtin < plugin < workspace).
  const pluginAgents = collectPluginAgents(plugins, mcpWarn);
  const registry = createSessionRegistry();
  const resolveModel = createProviderModelResolver({
    wrap: (m) => createCacheTrackingModel(m, { onBreak: (warning) => breakGuard.breakLine(warning) }),
    // M80: resolver-built one-shot children share the session's attachment
    // store — image-bearing child history resolves instead of failing closed.
    attachments,
    // ω99-315: subagent children run under the same idle watchdog budget.
    ...(streamIdle !== undefined ? { streamIdle } : {}),
  });
  // 134：answer-only 只让**终答**走 stdout，诊断换到 stderr（见 answer-only-channel.ts）。
  const answerOnly = argv.includes("--answer-only");
  diagLine(`模型：${modelLabel(config)}\n`, answerOnly); // ω99-199: #6
  diagLine(`session: ${sessionId}\n`, answerOnly);
  // M25 §A3: announce a resumed session in one line (never replay the log).
  // M28: sessions with model-state entries show the last model + effort.
  if (history.length > 0) diagLine(`${formatOneShotResumeLine(sessionId, history.length, lastModel)}\n`, answerOnly);
  // M49 §4: the one-shot's taint tracker — read_file / MCP results get the
  // WeakMap taint bit; the sidecar layer classifies args embedding tracked
  // content as [untrusted].
  const taint = createTaintTracker();
  // M51 §3: the sidecar's tool-annotation resolver reads the tool set through
  // this late-bound box (the gate is built before the tools below).
  const toolsBox: { current?: readonly Tool[] } = {};
  // design 70 §4 Phase 2 — funnel-1 wiring comment placed next to `toolsBox`
  // (the matching late-bound getter shape). The reviewer model box itself is
  // declared above (right after `const model`) and its `.current` is set at
  // construction; the closure in createPermissionGate below reads it at ASK
  // time. Funnel-1 wiring for the one-shot buildToolSet child gate.
  // (one-shot reviewer model is fixed for the session — no `/model`, no
  // staleness — but the box pattern is kept for symmetry with the REPL.)
  // M64-A §A: the one-shot peer runtime's stopper — hoisted at function scope
  // so the finally (which also serves the early-return paths) can always see it.
  let stopPeer: (() => Promise<void>) | undefined;
  // ω-4a: same hoist for the monitor sweep (the runtime itself is declared
  // inside the try below; the finally must always see the stopper).
  let stopMonitor: (() => void) | undefined;
  const canUseTool = createPermissionGate(argv, sidecar, (toolName, input) => argsCarryTaint(taint, input), toolMetaResolverFor(() => toolsBox.current), webAllowDomains, hooks?.onPermissionRequest, async (t, i) => {
    const m = oneShotReviewerBox.current;
    return m === undefined ? Promise.resolve(undefined) : askReviewIntro(m, t, i);
  }, resolveInitialMode(argv, process.env), trustGateBoot.suppressed);
  // M62 §7: the auto-compaction window (autoCompactWindow, clamped) and
  // master switch from the session settings; absent → the env default and
  // compaction on (the pre-M62 behavior).
  // §7: the boot-resolved window (per-model — the one-shot's plan resolves
  // the same selection main() resolved the window against); the fallback (a
  // direct runReal caller without the runtime) runs the per-model chain with
  // no settings knob. Reading process.env fresh keeps direct callers env-live.
  const contextWindowTokens = autoCompactRuntime?.windowTokens
    ?? resolveSessionWindowTokens({
      effective: undefined,
      envWindowTokens: Number(process.env.WUDAO_CONTEXT_WINDOW ?? "200000") || 200000,
      provider: config.provider,
      model: config.model,
    });
  const compactionEnabled = autoCompactRuntime?.enabled ?? true;
  // 125 项 1（dsh resolveCompactSpec 形）— 预留感知触发线的 misc 旋钮
  // （compaction.thresholdRatio/headroomTokens；缺省 0.8/2048，reserve 缺席时
  // 平比字节不变）。one-shot 会话静态，boot 一次读（python kernel 同款纪律）。
  const oneShotCompactionSettings = compactionSettingsFromNode(
    (await loadLayeredSettings(workspaceRoot, () => {}, process.env)).effective["compaction"],
  );
  const mcpTools = await loadMcpToolsFor(workspaceRoot, plugins);
  // M39: extension entries ride this run's session JSONL (same store), and
  // extension tools join after the MCP tail of the tool array.
  extensions?.bindSession(store, sessionId);
  const extTools = extensions?.tools ?? [];
  // P1-5: the one-shot has no frontend history channel — the trust-gate
  // notice goes to stdout (the lifecycle-sweep precedent).
  if (trustGateBoot.notice !== undefined) process.stdout.write(`${trustGateBoot.notice}\n`);

  try {
    // M32: one read-state table for this run — read_file records what the
    // session saw, edit/write_file gate on it, and the external-change prober
    // diffs against it. Its <file_changed> notes ride the MetaNote queue
    // (last tool_result tail — projection-only, the JSONL stays clean).
    const readState = createReadStateTable();
    const metaNotes: string[] = [];
    const prober = createExternalChangeProber({ readState, workspaceRoot, push: (t) => metaNotes.push(t) });
    // M58 §C#8: the git status block rides the SAME MetaNote queue — session
    // start (first probe) + on fingerprint change (HEAD sha / branch / entry
    // count), recomputed at turn boundaries via beforeModelCall below.
    // Projection-only: the stable prompt prefix never carries it (the CC
    // coupling the spec §C#8 hard rule rejects — see git-status-note.ts).
    const gitProber = createGitStatusProber({ workspaceRoot, push: (t) => metaNotes.push(t) });
    // M49 §1: the run's bounded auto-recall rides the FIRST model call via
    // the MetaNote queue — projection-only, the JSONL stays clean.
    const recallNote = memoryRuntime.recall(mention.text);
    if (recallNote !== undefined) metaNotes.push(recallNote);
    // M62 §7 fix (review M1): memoryEnabled:false must leave the one-shot with
    // a ZERO memory surface — `openSessionMemoryStore(...) ?? openMemoryStore(...)`
    // reopened the DEFAULT store exactly when memory was disabled (the ?? fired
    // on the disabled undefined). Same conditional-spread shape as app.tsx/REPL.
    // M-Memory 弧第二半：换轨长期记忆三件套（memory_search 同名互斥，M49 两
    // 件不再挂载）；runtime 同时承载首轮召回注入与 run 终了沉淀。
    const oneShotLtsMemory = await createLongtermMemoryRuntime({ workspaceRoot });
    setLongtermMemoryRuntime(oneShotLtsMemory);
    // M37 §2: one-shot runs snapshot too (the history dir is keyed by session
    // id, so a resumed interactive session can /rewind them later).
    const fileHistory = createFileHistory(join(workspaceRoot, ".wudao", "history", sessionId));
    // M24 wiring: the probe/fork closures read the STATE (declared below) at
    // tool-execution time — long after both exist. Spill lands under the
    // session id, so concurrent runs never share files.
    // M61 §1: the one-shot scheduler surface — the cron trio registers for
    // parity (the tool-list prefix matches the interactive frontends) and
    // created tasks persist; fires need an idle seam, so a one-shot process
    // only ever LEAVES due work behind for the resumed session.
    const cronRuntime = await createCronRuntime({ workspaceRoot, sessionId });
    // ω99-112: the one-shot browser runtime — same posture as the scheduler
    // beside it (zero-IO construction; the process exit sweep below plus the
    // runtime's exit hook reap the window when the pass ends).
    const oneShotBrowserRuntime = createBrowserRuntime();
    // ω-4a: the one-shot monitor surface — the trio registers for parity (the
    // tool-list prefix matches the interactive frontends); events drain mid-
    // run through the steering take below, and the process exit sweep reaps
    // every watched child (watches die with the process by design).
    const monitorRuntime = createMonitorRuntime({
      workspaceRoot,
      sessionId,
      env: process.env,
      spillDir: join(workspaceRoot, ".wudao", "spill", sessionId),
    });
    stopMonitor = (): void => monitorRuntime.stop();
    // M64-A §A: the one-shot peer surface — the inbox registers (peers can
    // send TO a -p session; holds keep the same dialogExpiry), deliveries
    // drain through a steering take between tool calls, and the process
    // unregisters at exit. Non-interactive: an unanswered hold dies at
    // dialogExpiry (the spec's "-p 会话同样持有期限").
    const sessionNameFlag = parseSessionNameFlag(argv);
    const oneShotDialogExpiry = await readPeerDialogExpiry(workspaceRoot);
    const peerRuntime = await createPeerRuntime({
      workspaceRoot,
      sessionId,
      ...(sessionNameFlag !== undefined ? { name: sessionNameFlag } : {}),
      env: process.env,
      ...(sandboxOpts ? { sandboxed: true } : {}),
      tier: () => (resolveInitialMode(argv, process.env) === "auto" ? "bypass" : "normal"),
      // M64-A fix: the one-shot holds a sidecar in scope — inbound peer text
      // is reviewed before delivery here too (the spec's auto-tier rule),
      // and peerDialogExpiry applies to -p holds like everywhere else.
      ...(sidecar !== undefined ? { reviewMessage: sidecarMessageReview(sidecar) } : {}),
      ...(oneShotDialogExpiry !== undefined ? { dialogExpiryMs: oneShotDialogExpiry } : {}),
      notify: (line) => process.stdout.write(`${line}\n`),
    });
    stopPeer = (): Promise<void> => peerRuntime.stop();
    // ω-4d: the run's login-shell snapshot provider (one capture, lazily on
    // the first host-path shell; kill switch / no $SHELL → nothing).
    const loginShellEnv = maybeLoginShellEnv(workspaceRoot);
    // 夜移 032 stage-2: the run's net-change tracker — the same instance the
    // tool set records into and runPass renders at settle (the session-engine
    // sharing shape; the REPL branch below threads its own the same way).
    const turnDiff = createTurnDiffTracker();
    // P2-12: the terminal tool's audit entries ride this run's session JSONL.
    setTerminalHistorySink((entry) => { void appendSessionEntry(store, sessionId, entry).catch(() => {}); });
    // ω99-57: the one-shot child-mail lane — an awaited task child's mid-run
    // messages drain through the steering take below (peer → child mail →
    // monitor, the driver's lane order); the process exits after the pass, so
    // no idle wake exists here by design.
    const oneShotChildMail = createChildMailLane();
    // 125 项 1（codex new_context 形）：模型侧轮转端口盒——headless 同样
    // 接线（session-engine 同款；compaction 关=不注册工具）。
    const oneShotContextRotationBox: import("@wudao-org/core").NewContextPortBox = {};
    const tools = buildToolSet({
      workspaceRoot,
      model,
      turnDiff,
      ...(compactionEnabled ? { newContext: { portBox: oneShotContextRotationBox } } : {}),
      // ω99-8: the one-shot path keeps NO cost registry (no /cost, no exit
      // ledger flush) — subagent usage attribution is deliberately NOT wired
      // here (a seam with no consumer); the driver (session-engine) and the
      // REPL carry it.
      canUseTool,
      contextWindowTokens,
      onSubagentEvent: subagentEventHandler(ge),
      // P2-9: the settings-gated lsp tool appends after the MCP tail.
      // P2-12: the terminal tool appends after the MCP/lsp tail.
      extraTools: [...mcpTools, ...extTools, ...lspToolsFor(workspaceRoot), ...terminalToolsFor(workspaceRoot)],
      cron: { table: cronRuntime.table(), sessionId, env: process.env, runtime: cronRuntime },
      // ω-4a: the monitor trio (fixed position beside the cron trio; the
      // inert runtime keeps the trio for the fail-closed refusal).
      monitor: { registry: monitorRuntime.registry(), ...(monitorRuntime.refusal !== undefined ? { refusal: monitorRuntime.refusal } : {}) },
      // M64-A §A: list_agents + send_message (fixed position, fail-closed).
      peer: peerRuntime,
      // ω99-57: the child-mail lane (task-tool children deliver onto it).
      childMail: oneShotChildMail,
      // 夜移 029: the session's skills — threshold-gated discover_skills.
      ...(skills !== undefined && skills.length > 0 ? { skills } : {}),
      spillDir: join(workspaceRoot, ".wudao", "spill", sessionId),
      ...(loginShellEnv !== undefined ? { loginShellEnv } : {}),
      // ω-2b (I3): the paged tool-result recovery tool over THIS session's
      // JSONL (newest-first candidate scan; sidechains are not searched).
      sessionResult: {
        load: async (toolCallId) =>
          (await store.load(sessionId)).filter((m): m is import("@wudao-org/core").ToolResultMessage => m.role === "tool" && m.toolCallId === toolCallId),
      },
      // 121 挖掘 TOP5 #1: the conversation-history search over THIS one-shot
      // session's JSONL (beside session_result — same family, same pure
      // bypass read; sidechains not searched).
      historySearch: {
        load: () => historySearchCorpus(store, sessionId),
      },
      // 121 §1 续章: the persistent-notes pair over THIS one-shot session's
      // .wudao/notes/<sid>/ directory (beside the retrieval family).
      notes: { sessionId: () => sessionId },
      contextProbe: () => state.messages,
      getForkContext: () => state,
      getSystemPrompt: () => state.systemPrompt,
      // 125 项 2（codex get_context_remaining 形）：one-shot 会话静态——窗口/
      // 请求帽/设置都是 boot 定值（无 /model 切换面）。
      contextRemaining: {
        getThreshold: () => ({
          windowTokens: contextWindowTokens,
          ...compactionThresholdFields(config, oneShotCompactionSettings),
        }),
      },
      ...(sandboxOpts ? { sandbox: sandboxOpts.sandbox } : {}),
      readState,
      history: fileHistory,
      // M49 §1（换轨 M-Memory 弧第二半）: the memory store rides the tool set.
      // 长期记忆三件套（memory_save/memory_search/memory_forget）——M49 的
      // memory_write/memory_search 不再挂载（同名互斥）；enabled=false → 键
      // 整体缺席（零记忆面，M62 §7 同纪律）。
      ...(oneShotLtsMemory.enabled ? { longtermMemory: { store: oneShotLtsMemory.store } } : {}),
      ...(writeVerify ? { writeVerify } : {}),
      ...(longOutput ? { longOutput } : {}),
      logSlimming: await loadLogSlimmingPortsForBoot(config),
      // 114: the kernel's session knob (idle-reap window).
      pythonKernel: { idleTimeoutMs: (await loadPythonKernelSettings(process.cwd())).idleTimeoutMs },
      // M59 §3: the web runtime (fetch caps + optional search provider).
      ...(web !== undefined ? { web } : {}),
      // ω99-112: the browser sextet (fixed position after the web face,
      // before the scheduler trio — prefix stability).
      browser: oneShotBrowserRuntime,
      // ω99-138: the browser_see vision materials — the run's own attachment
      // store (the --image store; screenshots join the same .wudao/attachments
      // home) + the main model's image-modality verdict, read per call.
      browserVision: { store: attachments, modelAcceptsImages: () => modelAcceptsImages(config) },
      // ω99-212: screen_capture 的图片附件缝（与 browserVision 同库同纪律）。
      computerVision: { store: attachments, modelAcceptsImages: () => modelAcceptsImages(config) },
      agents: { registry, runId: sessionId, resolveModel, defaultEffort: config.reasoningEffort ?? "off", pluginAgents, ...(hooks !== undefined ? { hooks } : {}), hookRuntime: hookRuntimeView },
    });
    // M34 §1: ask_user rides the TOP-LEVEL set only (outside the child pool).
    // Interactive (TTY) runs get the line-prompt seam; a piped stdin leaves it
    // unwired — fail-closed error result, the model decides itself.
    tools.push(
      stdin.isTTY === true
        ? createAskUserTool({ askUser: (question, options) => askUserLine(question, options) })
        : createAskUserTool({}),
    );
    // M51 §3: hand the sidecar's annotation resolver the final tool array.
    toolsBox.current = tools;
    // M61 §4 (re-review info→do + ruling): a durable scheduled child
    // (WUDAO_SCHEDULE_RUN=1) runs at the ASK tier ONLY — persisted allow
    // rules (settings/session) and any global-tier bypass opt-in are NEVER
    // consulted. Read-only tools still bind to the DENY layer (settings deny
    // rules + tool.checkPermissions); only their ask layer is bypassed.
    const durableAskTier = process.env.WUDAO_SCHEDULE_RUN === "1";
    const durableSettings = durableAskTier ? loadPermissionSettings(workspaceRoot) : undefined;
    const durableTierGate: typeof canUseTool = durableAskTier
      ? createDurableAskTierGate({
          getTools: () => tools,
          staticDeny: async (toolName, input) => {
            const settings = await durableSettings;
            const d = decideRichPermission({ mode: "workspace", toolName, input, settings });
            return d !== "ask" && d.behavior === "deny" ? d : undefined;
          },
        })
      : canUseTool;
    // M61 §3: `-p "/goal <condition>"` — the condition itself becomes the
    // run's first-turn instruction (设置即开局). `/goal clear` (and aliases)
    // closes a restored goal instead of setting a literal "clear" condition.
    const goalPromptMatch = /^\/goal(?:\s+|$)/.exec(prompt);
    // I2: exec() returns a match object or NULL — never undefined. Comparing
    // against undefined armed a (chopped) goal for EVERY one-shot prompt.
    const headlessGoalCommand = goalPromptMatch !== null ? parseGoalCommand(prompt.slice("/goal".length).trim()) : undefined;
    const headlessGoalCondition = headlessGoalCommand !== undefined && headlessGoalCommand.kind === "set" ? headlessGoalCommand.condition : undefined;
    const state: AgentState = {
      // ω99-241: #5 — the computer strategy section rides the prompt iff the
      // one-shot tool set carries the computer octet (computer_click probes
      // it — mounts as a unit; same gate family as the read-tool skills
      // probe above).
      systemPrompt: buildSystemPrompt(workspaceRoot, mcpTools.length > 0, tools.some((t) => t.name === "read_file") ? (skills ?? []) : [], peerRuntime.refusal === undefined, tools.some((t) => t.name === "computer_click"), tools),
      messages: [...history, {
        role: "user",
        content: planMode
          ? buildPlanPrompt(mention.text)
          : headlessGoalCondition !== undefined
            ? headlessGoalCondition
            : mention.text,
        // M79 §5: the --image blocks ride the user turn (durable refs; the
        // provider resolves transient data URLs at request build).
        ...(imageBlocks.length > 0 ? { images: imageBlocks } : {}),
      }],
      tools,
      status: "idle",
    };
    // M-Memory 弧第二半：one-shot 的首轮召回注入——prompt 已在 messages 里
    // （首条真实用户消息即种子），构造后、首个模型调用前注入一次（幂等；
    // replaceSystemPrompt 的追加语义 = 前缀字节不动）。
    oneShotLtsMemory.injectAtFirstRun(state);
    // M63-A: the one-shot's single session boundary fires before the run
    // (source: fork > resume > startup — the same derivation the driver uses,
    // applied here because the one-shot drives the loop directly).
    {
      const source = forked ? "fork" : history.length > 0 ? "resume" : "startup";
      try {
        // cc-plugins E4: the returned additionalContext parks on the
        // MetaNote projection — it reaches the first model call, never the
        // persisted history.
        const ctx = await hooks?.onSessionStart?.(source, { sessionId });
        if (typeof ctx === "string" && ctx !== "") metaNotes.push(ctx);
      } catch {
        /* observer isolation */
      }
    }
    // M37 §1: one rendering pass over the loop. `plan` layers the read-only
    // whitelist onto the permission gate and the plan gate onto the stop gates
    // for this pass only.
    // M49 §2: the run's tool-call count (accumulated across the plan flow's
    // two passes) — the background review trigger's ≥3 gate.
    let toolCalls = 0;
    // ω99-315: the run's idle watchdog reconnects (see the turn_retried hook).
    let idleReconnects = 0;
    // 借鉴弧 B1：本 run 的存量缓存债（最新经济学回执采样）。
    let cacheDebtTokens = 0;
    // M61 §3: headless /goal — `-p "/goal <condition>"` runs to a verdict
    // terminal state (met/impossible), each evaluation printed as it lands.
    // The evaluator rides the stop-hook position exactly like interactive.
    const headlessGoal = headlessGoalCommand !== undefined
      ? createGoalController({
          workspaceRoot,
          sessionId: () => sessionId,
          getMessages: () => state.messages,
          evaluator: buildEvaluatorModel(model, { provider: config.provider, model: config.model }, process.env),
          backgroundBusy: () => registry.status().some((b) => b.status === "queued" || b.status === "running"),
          appendEntry: async (entry) => {
            await appendSessionEntry(store, sessionId, entry);
          },
          notify: (line) => process.stdout.write(`${line}\n`),
          env: process.env,
        })
      : undefined;
    // ω99-13: bridge the controller to the model wrapper's usage observer
    // above (the --budget metering seam).
    headlessGoalBox.current = headlessGoal;

    // 波次8 #45 (dsh session-checkpoint-policy): one index instance serves the
    // pre-dispatch barrier below AND the run-complete tail (one flush; creation
    // is side-effect-free — the file only lands at flush()).
    const searchIndex = createSessionSearchIndex(workspaceRoot);
    // R3-T001 深测弧：runPass 内武装的应急结算出口（见 runPass 内注释）。
    // 调用点 catch 调用；成功路径不触（happy-path 收尾在 2143 区原样）。
    let emergencySettle: ((err: unknown) => Promise<void>) | undefined;

    const runPass = async (plan: boolean): Promise<void> => {
    // 0.3.15（用户需求：执行耗时可见）：一次性 run 的墙钟记账（与 driver 的
    // 0.3.15 记账同一对 helper/同一格式）。模型段同样 omit-never-null——
    // 脚本模型/未知网关不上报 durationMs 就整体省略。
    const runStartMs = performance.now();
    let llmMs: number | null = null;
    let toolMs = 0;
    // 夜移 035 (codex turn_timing): the pass's phase recorder (threaded into
    // the loop only in the debug tier — zero overhead otherwise).
    const runProfile = createTurnProfileRecorder();
    // 夜移 032 stage-2: each pass is its own run — the plan pass and the
    // execution pass must not pool their ledgers (the driver's resetRun seam).
    turnDiff.resetRun();
    // ω-2b (I2-a): the CLI-built retention exclude set — every tool that
    // declared compactionExempt keeps its old results through the cheap
    // compaction tiers (undefined = no exempt tool, status-quo options).
    const retention = compactionRetentionFor(tools);
    // ω-1b: the loop-level generic large-result backstop — same session
    // spill anchor the one-shot tool set uses (read_file exempt in core).
    const genericShaping = resolveGenericShapingRuntime(
      join(workspaceRoot, ".wudao", "spill", sessionId),
      process.env,
    );
    // 波次8 #45 (dsh session-checkpoint-policy): the pre-dispatch durability
    // barrier — a tool-carrying assistant turn persists BEFORE any tool body
    // runs, so a crash mid-tool leaves a durable unmatched tool_use (the input
    // repairOrphanedToolCalls answers with the UNKNOWN-outcome text instead of
    // blindly re-issuing the write). One-shot has no earlyUserPersist — the
    // user line rides the initial messages array, so the first fire persists
    // user turn + tool-carrying assistant as one ordered prefix. Pushing into
    // `history` keeps the run-complete identity diff exact (no duplicate JSONL
    // lines; search indexing rides the same appends, flush stays run-end).
    // A rejected append fails CLOSED at the loop: PERSIST_FAILED synthetic,
    // no tool body, run survives.
    const persistBeforeToolDispatch = async (messages: readonly AgentMessage[]): Promise<void> => {
      const toPersist = selectMessagesToPersist(messages, history);
      for (const m of toPersist) {
        await store.append(sessionId, m);
        history.push(m);
        searchIndex.indexMessage(sessionId, m);
      }
    };
    // ω99-4c: lint/test 反射回路 — 进程级单例；未配置 reflect 节 =
    // undefined = hooks 原样（字节零变化）。
    const reflect = await reflectRuntimeFor(process.cwd());
    // ω99-7: auto-refine 触发层 — 进程级单例；未配置 refine.auto（默认 OFF）
    // = undefined = hooks 原样。The stop seam is AWAITED so the one-shot
    // process cannot exit mid-refine; the receipt lands on stdout.
    const autoRefine = await refineAutoRuntimeFor(process.cwd(), {
      onNotice: (text) => { process.stdout.write(`${text}\n`); },
    });
    // R3-T001 深测弧（永续迭代）：run 中途异常的应急结算——实证与形状见
    // one-shot-settle.ts 模块头。武装闭包（引用本 pass 统计局部），调用
    // 点 catch 触发：持久化新消息 → 落 aborted 收据 → rethrow 走 main 的
    // catch（stderr + exit 1 不变）。结算失败绝不改写原始异常。
    emergencySettle = async (err: unknown): Promise<void> => {
      await persistNewMessages({ store, sessionId, searchIndex, messages: state.messages, history });
      await appendRunStatsReceipt(store, sessionId, { runStartMs, llmMs, toolMs, toolCalls, idleReconnects, cacheDebtTokens }, { errName: err instanceof Error ? err.name : "Error" });
      // M-Memory 弧第二半：异常收尾同样沉淀（确定性提炼——run 中断不代表
      // 用户没给过纠正；失败静默不改写原始异常）。
      await oneShotLtsMemory.captureAtSessionEnd({ sessionId, messages: state.messages }).catch(() => {});
    };
    const gen = runAgentLoop(state, model, {
      maxTurns: longTask?.maxTurns,
      gates: plan ? { ...(longTask?.gates ?? {}), plan: true } : longTask?.gates,
      // M53 §5: the --no-loop-safety ablation seam.
      ...(isFeatureAblated("loop-safety") ? { loopSafety: false } : {}),
      ...(genericShaping !== undefined ? { genericResultShaping: genericShaping } : {}),
      // ω-4b: the reflection fork at second loop verdicts (core default OFF;
      // the one-shot wiring opts in; --no-loop-reflection ablates).
      ...(isFeatureAblated("loop-reflection") ? {} : { reflection: {} }),
      canUseTool: plan
        ? async (toolName: string, input: Record<string, unknown>) => planModeDenied(toolName) ?? durableTierGate(toolName, input)
        : durableTierGate,
      // 波次8 #45: the durability barrier rides every pass (plan pass fires it
      // too — a denied call still records its tool_use; the denial result
      // answers it at run-complete).
      onBeforeToolDispatch: persistBeforeToolDispatch,
      // M62 §7: autoCompactEnabled:false runs the loop WITHOUT compaction
      // (a 413 then surfaces the hard-overflow guidance immediately; manual
      // /compact still works — it calls the compactor directly).
      // 125 项 1（codex new_context 形）：模型侧轮转端口接线——顶层选项
      // （与 compaction 同级，不是嵌套）；同一个 oneShotContextRotationBox。
      ...(compactionEnabled ? { contextRotation: { port: oneShotContextRotationBox, rotationsUsed: 0 } } : {}),
      ...(compactionEnabled
        ? {
            compaction: {
              contextWindowTokens,
              // 125 项 1/项 2：窗口身份链 + WorldState 差分——嵌在 compaction
              // 里（loop 从 options.compaction.windowIdentity 读）。
              windowIdentity: { sessionKey: sessionId.slice(0, 8), baseWindowCount: 0 },
              worldState: {
                snapshot: () => ({
                  changedFiles: cumulativeModifiedFiles(state.messages),
                  activeTools: activeToolsOf(state.messages),
                }),
              },
              // 125 项 1（dsh resolveCompactSpec 形）：预留感知触发线 ——
              // ratio×window 的平比帽永远在；outputReserveTokens 在场（已画像
              // 窗口语义 + 请求帽已知）时收紧到
              // min(ratio×window, window − reserve − headroom)。
              ...compactionThresholdFields(config, oneShotCompactionSettings),
              // 借鉴弧 B1（a reference project C1）：压缩经济学定价（catalog > env > 缺省）。
              cachePricing: resolveSessionCachePricing(config.provider, config.model),
              classifySkillRead: createSkillReadClassifier(skills ?? []),
              // M58 §C#2: the session's standing compact-instructions rider (the
              // WUDAO.md/AGENTS.md `## Compact Instructions` section, parsed once at
              // session start via the memoized loader) reaches every tier-2 summary
              // the one-shot run triggers (auto/boundary/reactive alike).
              ...(compactInstructionsRider !== undefined ? { compactInstructions: compactInstructionsRider } : {}),
              // M58 §C#12: the session's reasoning_effort rides the tier-2 summary
              // requests (absent = the provider config's own effort).
              ...(config.reasoningEffort !== undefined ? { reasoningEffort: config.reasoningEffort } : {}),
              // ω-2b (I1-c): the provider profile's window semantics — gates the
              // proactive admission clip (deepseek = shared).
              ...(config.windowMode !== undefined ? { windowMode: config.windowMode } : {}),
              // ω-2b (I2-a): the retention exclude set (compactionExempt tools).
              ...(retention !== undefined ? { retention } : {}),
            },
          }
        : {}),
      // ω99-4c: reflect composes INNERMOST (last-consulted) — the user
      // hook's and the goal evaluator's stop semantics outrank the
      // reflection's block; reflect may block only when both allowed.
      // ω99-7: auto-refine composes OUTERMOST as a pure OBSERVER — the
      // existing chain decides the stop; a refine may only follow a stop.
      hooks: observeAutoRefineOnHooks(composeReflectHooks(headlessGoal !== undefined
        ? {
            ...hooks,
            onRunStop: async (stopState) => {
              let user: import("@wudao-org/core").StopHookDecision = "allow";
              try { user = (await hooks?.onRunStop?.(stopState)) ?? "allow"; } catch { user = "allow"; }
              if (typeof user === "object") return user;
              return headlessGoal.onStop(stopState);
            },
          }
        : hooks, reflect), autoRefine, () => model),
      beforeModelCall: async () => {
        await prober.probe();
        await gitProber.probe();
      },
      // M64-A §A: accepted peer messages drain between tool calls (the one
      // shot has no user steering queue — the peer lane is the whole seam).
      // ω-4a: monitor events ride the same lane, after peer deliveries.
      // ω99-57: child mail sits between peer and monitor (the driver's order)
      // — its lane always exists on the one-shot, so the take is always wired.
      steering: { take: () => peerRuntime.takeInjection() ?? oneShotChildMail.take() ?? monitorRuntime.takeInjection() },
      metaNotes: { take: () => metaNotes.shift() },
      // M62 §1: path-gated context rules (absent when the workspace has none).
      ...(ruleMatcher !== undefined ? { contextRules: { match: ruleMatcher } } : {}),
      // 夜移 035 (codex turn_timing): per-pass phase recorder — a fresh one
      // per runPass (plan pass and execution pass are separate runs; a
      // shared recorder would freeze at the first complete). Surfaced in the
      // debug tier right after the run-stats receipt.
      ...(ge("debug") ? { turnProfile: runProfile } : {}),
    });
    // M61 §3: the headless /goal settles — the stall guard keys on the
    // terminal (manual next() would be needed for the value; the last
    // not-yet verdict inference covers the for-await shape).
    const runSettled = (): void => {
      headlessGoal?.onRunEnd({});
    };
    let streamed = false;
    // ω99-134: one stream per runPass — started/finished pair inside the same
    // pass's event stream (132's runTurn scope rule), so the card's NAME
    // lookup can neither leak ids across passes nor alias a reused id.
    const toolNamesById = new Map<string, string>();
    // ω-4b: the fork's usage row (reflectionTokens-stamped), parked for the
    // reflection_fork entry (core emits the usage event first).
    let lastReflectionUsage: import("@wudao-org/core").ModelUsage | undefined;
    for await (const event of gen) {
      if (event.type === "reasoning_delta") {
        if (ge("info") && !answerOnly) { const chunk = `\x1b[2m${event.text}\x1b[0m`; stdoutGuard.writeRawStdout(chunk); breakGuard.feed(chunk); }
        oneShotRunFacts.reachedModel = true; // α3: reasoning bytes arrived = the model WAS reached (never stamped unreached)
      }
      if (event.type === "assistant_delta") {
        if (ge("info") && !answerOnly) { stdoutGuard.writeRawStdout(event.text); breakGuard.feed(event.text); }
        streamed = oneShotRunFacts.reachedModel = true;
        continue;
      }
      if (event.type === "turn_retried") {
        // ω99-315: the one-shot's 断流重连 counter — same rule as the driver
        // (only the watchdog's idle class; network-class recoveries don't).
        if (event.reasonClass === "idle") idleReconnects += 1;
      }
      // 借鉴弧 B1：经济学回执采样（compacted=入账后新债；deferred=现值）。
      if ((event.type === "compacted" || event.type === "compact_deferred") && event.economics !== undefined) cacheDebtTokens = event.economics.carriedDebtTokens;
      // 125 项 1/项 2（M52 §1）：one-shot 的 compact_boundary 持久化——
      // 轮转/压缩后把窗口序号+世界快照写进 session JSONL（driver 路径的
      // onCompactBoundary 等价面），供 resume 重建窗口链与差分基线。
      if (event.type === "compacted" && event.tier === 2) {
        void store.appendEntry(sessionId, {
          type: "compact_boundary",
          data: {
            firstKeptEntryId: event.firstKeptEntryId,
            reason: event.reason,
            tier: event.tier,
            ...(event.windowIndex !== undefined ? { windowIndex: event.windowIndex } : {}),
            ...(event.worldState !== undefined ? { worldState: event.worldState } : {}),
          },
        }).catch(() => {});
      }
      if (event.type === "usage") {
        // 0.3.15: fold the row's wall clock into the run's model time.
        if (event.usage.durationMs !== undefined) llmMs = (llmMs ?? 0) + event.usage.durationMs;
        if (event.usage.reflectionTokens !== undefined) lastReflectionUsage = event.usage;
        if (ge("info")) stdoutGuard.writeRawStdout(`  ${formatUsageLine(event.usage)}\n`);
      } else if (event.type === "model_call_finished" && event.hasToolCalls && ge("info") && !answerOnly) {
        stdoutGuard.writeRawStdout(`\n← 模型（${event.toolCallCount} 个工具调用）\n`); // ω99-188: #5
      } else if (event.type === "tool_call_started" && ge("info") && !answerOnly) {
        // ω99-134: register the name now — the finished card below resolves it
        // from this Map (finished events never carry a tool NAME).
        toolNamesById.set(event.toolCallId, event.toolName);
        const summary = summarizeToolCall(event.toolName, event.input);
        stdoutGuard.writeRawStdout(`🔧 ${event.toolName}${summary ? ": " + truncate(summary, 120) : ""}\n`);
        if (ge("debug")) stdoutGuard.writeRawStdout(`    输入：${JSON.stringify(event.input)}\n`); // ω99-188: #7
      } else if (event.type === "tool_call_finished") {
        toolCalls += 1;
        // 0.3.15: the I21 per-call wall clock folds into the run's tool time.
        if (event.durationMs !== undefined) toolMs += event.durationMs;
        // ω99-134: resolve + retire the started name (the Map stays bounded by
        // in-flight calls; a finished-without-started miss → no card, the
        // preview line renders — fail-safe).
        const startedName = toolNamesById.get(event.toolCallId);
        toolNamesById.delete(event.toolCallId);
        // M49 §4: taint-track the finished result (WeakMap side channel over
        // the message the loop just pushed).
        for (let i = state.messages.length - 1; i >= 0; i -= 1) {
          const m = state.messages[i];
          if (m !== undefined && m.role === "tool" && m.toolCallId === event.toolCallId) {
            taint.record(m, event.provenance);
            break;
          }
        }
        // ω99-29 T2: multi-line bodies keep their line structure (same fix as
        // the REPL's render — the two headless frontends share the defect).
        if (ge("debug")) process.stdout.write(`    ↳ ${event.isError ? "[error] " : ""}${truncateMultiline(event.result, 400).replace(/\n/g, "\n      ")}\n`);
        // ω99-32 T2: the info-level single-line preview — same shape, same
        // budget, same hide-empty rule as the REPL's render above (TUI
        // transcript parity; debug prints the full body instead).
        // ω99-134: a name-gated deliverable receipt (the ω99-125 extractor)
        // renders the SAME three-line card as the REPL's ω99-132 render —
        // verbatim copy, the four-frontend one-card rule (web 125 / TUI 131 /
        // REPL 132 / one-shot here) — INSTEAD of that preview line; every
        // other result (not gated, no receipt shape, or isError) keeps the
        // exact line below — the zero-drift pin.
        else if (ge("info")) {
          const receipt = startedName !== undefined && !event.isError ? extractFileReceipt(startedName, event.result) : undefined;
          if (receipt !== undefined) {
            // raw result = 中文句 + "\n" + JSON by construction — the first
            // non-empty line IS the sentence (no `{` cut; the 131 pin: the
            // gated family's sentences never contain a brace).
            const sentence = event.result.split("\n").find((l) => l.trim() !== "") ?? "";
            process.stdout.write(`\x1b[36m  ▣ ${fileIconOf(receipt.name)} ${receipt.name}（${formatKb(receipt.bytes)}）\x1b[0m\n`);
            process.stdout.write(`\x1b[2m  ${sentence}\x1b[0m\n`);
            process.stdout.write(`\x1b[2m  位置：${receipt.path}　打开：open "${receipt.name}"\x1b[0m\n`);
          } else {
            const preview = truncate(event.result, RESULT_PREVIEW_CHARS);
            if (preview !== "" || event.isError) process.stdout.write(`\x1b[2m  ↳ ${event.isError ? "[error] " : ""}${preview}\x1b[0m\n`);
          }
        }
      } else if (event.type === "meta_note" && ge("info")) {
        // M32: a system note (e.g. a <file_changed> diff) rode the last
        // tool_result tail of this call — the model saw the full payload.
        process.stdout.write(`\x1b[2m↳ ${truncate(event.text, 120)}\x1b[0m\n`);
      } else if (event.type === "defer_loaded") {
        // M35 §1: the run's one load_tools call applied — the deferred tools'
        // definitions ride every request from the next turn on. §2: the
        // receipt entry lands in the JSONL immediately (authoritative even if
        // the run dies mid-flight — same rule as compacted markers).
        await appendSessionEntry(store, sessionId, buildDeferredLoadedEntry(event.names)).catch(() => {});
        if (ge("info")) process.stdout.write(`\x1b[2m↳ 工具已加载：${event.names.join(", ")}（一次性工具集变更）\x1b[0m\n`); // ω99-172: #2（f-iii #1-孪生）
      } else if (event.type === "context_rule_loaded" && ge("info")) {
        // M62 §1: a gated rule's body entered the history after a matching read.
        process.stdout.write(`\x1b[2m↳ 规则已加载：${event.source}\x1b[0m\n`); // ω99-176: #4
      } else if (event.type === "reflection_fork") {
        // ω-4b: the loop-safety challenger settled — the audit entry lands in
        // the JSONL immediately (append-only authoritative; the directive's
        // durable record, the note itself being projection-only).
        await appendSessionEntry(store, sessionId, buildLoopReflectionEntry({
          kind: event.kind,
          evidence: event.evidence,
          outcome: event.outcome,
          ...(event.rationale !== undefined ? { rationale: event.rationale } : {}),
          ...(event.directive !== undefined ? { directive: event.directive } : {}),
          turn: event.turn,
          ...(lastReflectionUsage !== undefined ? { usage: lastReflectionUsage } : {}),
        })).catch(() => {});
        lastReflectionUsage = undefined;
        if (ge("info")) {
          const tail = event.directive !== undefined ? event.directive : event.rationale !== undefined ? event.rationale : "";
          process.stdout.write(`\x1b[2m↳ 循环安全挑战者：${event.outcome}${tail !== "" ? ` —— ${truncate(tail, 80)}` : ""}\x1b[0m\n`); // ω99-176: #5
        }
      } else if (event.type === "compact_deferred" && ge("info")) {
        // M63-B (A-round a): a PreCompact hook deferred this compaction.
        process.stdout.write(`\x1b[2m⏸ 压缩已推迟：${truncate(event.reason, 120)}\x1b[0m\n`); // ω99-172: #3（f-iii #7-孪生）
      } else if (event.type === "output_limit_recovery") {
        // 夜移 013 surfacing: the exhausted line is the incompleteness
        // marker (always shown, not info-gated); the nudge line is dim.
        process.stdout.write(
          event.kind === "nudge"
            ? `\x1b[2m✂️ 输出被截断，已请求从中断处继续${event.maxTokens !== undefined ? `（输出上限提升至 ${event.maxTokens}）` : ""}…\x1b[0m\n`
            : "⚠️ 输出被截断：续写次数用尽，回答可能不完整\n",
        );
      } else if (event.type === "empty_final_recovery") {
        // 夜移 024 surfacing (the 013 idiom): the exhausted line is the
        // emptiness marker; the nudge line is dim.
        process.stdout.write(
          event.kind === "nudge"
            ? "\x1b[2m🕳 模型未给出可见回答，已要求重答…\x1b[0m\n"
            : "⚠️ 模型未给出可见回答：重答次数用尽，回答可能为空\n",
        );
      } else if (event.type === "prompt_blocked") {
        // M63-B (A-round b): the user-channel notice for a blocked prompt.
        process.stdout.write(`⛔ 提示词被钩子拦截：${truncate(event.reason, 80)}\n`); // ω99-172: #4（f-iii #6-孪生）
      } else if (event.type === "compacted") {
        // Tier-2: persist the frozen summary marker immediately so the
        // append-only JSONL is authoritative even if the run dies mid-flight.
        // Persistence must not depend on the verbosity gate.
        // M63-B (A-round a): the session continues across the boundary — the
        // SessionStart face fires here (the one-shot drives the loop directly).
        try {
          const ctx = await hooks?.onSessionStart?.("compact", { sessionId });
          if (typeof ctx === "string" && ctx !== "") metaNotes.push(ctx);
        } catch {
          /* observer isolation */
        }
        if (event.summaryMessage) await store.append(sessionId, event.summaryMessage);
        // M52 §1: the boundary entry rides the same event — where the kept
        // region began (chain continuation after resume).
        if (event.firstKeptEntryId !== undefined) {
          await appendSessionEntry(store, sessionId, buildCompactBoundaryEntry({ firstKeptEntryId: event.firstKeptEntryId, reason: event.reason, tier: event.tier })).catch(() => {});
        }
        if (ge("info")) {
          // Rewriting the prefix invalidates the provider's cache for the
          // NEXT request — say so, so the hit-rate dip is expected, not scary.
          process.stdout.write(event.summaryMessage ? "♻️ compacted context (summarized) (cold turn expected)\n" : "♻️ compacted context (cold turn expected)\n");
        }
      }
    }
    runSettled();
    // M63-B R1 fix (6): the one-shot session ENDS with the run (process exit
    // follows) — the shared budget deadline is created here so every composed
    // layer consumes the one window.
    {
      const info = { sessionId, budgetEndsAt: Date.now() + SESSION_END_BUDGET_MS };
      try {
        await hooks?.onSessionEnd?.("exit", info);
      } catch {
        /* observer isolation */
      }
    }
    const last = state.messages.at(-1);
    if (answerOnly && last?.role === "assistant") {
      // 134：answer-only 模式——仅输出终答（无空行包裹，供脚本/benchmark 消费）。
      stdoutGuard.writeRawStdout(last.content + "\n");
    } else if (streamed && last?.role === "assistant") {
      stdoutGuard.writeRawStdout("\n");
    } else {
      stdoutGuard.writeRawStdout(`\n${last?.role === "assistant" ? last.content : "(no answer)"}\n`);
    }
    // 夜移 032 stage-2: the pass's net file-change receipt — the driver
    // settle seam's one-line twin (preview, dim; the full git diff rides the
    // tracker, not stdout). Same order as the driver: changes first, then
    // timing. Ungated: partial writes are evidence, not debug trivia; prints
    // only when the pass actually wrote.
    {
      const netFiles = turnDiff.files();
      if (netFiles.length > 0) {
        const netRender = renderTurnDiff(netFiles, (p) => relative(workspaceRoot, p));
        stdoutGuard.writeRawStdout(`\x1b[2m${netRender.text}\x1b[0m\n`);
      }
    }
    // 0.3.82（0.3.81 凌乱反馈）: the retired per-call breaker receipts,
    // aggregated to ONE settle line — the driver settle seam's UI capsule
    // twin (same text, same gate), dim like the receipts around it. Ungated:
    // the per-call receipts printed unconditionally, so the aggregate does
    // too; N=0 prints nothing.
    if (sidecar !== undefined && sidecar.breakerAllows() > 0) {
      stdoutGuard.writeRawStdout(`\x1b[2m🛡 sidecar:熔断中 — 本轮共自动放行 ${sidecar.breakerAllows()} 次（未分类）\x1b[0m\n`);
    }
    // 0.3.15（用户需求：任务整体执行时间统计）：一次性 run 的耗时收据——
    // 与 TUI/web 的 run-stats notice 同一格式，落在答案之后（info 档起见）。
    // R2 深测弧：落盘件复用 one-shot-settle（形状与纪律见模块头）；stdout
    // 打印仍 info 档门（数据层不受详略门）。
    {
      await appendRunStatsReceipt(store, sessionId, { runStartMs, llmMs, toolMs, toolCalls, idleReconnects, cacheDebtTokens }).catch(() => { /* ω99-217 同款：收据落盘失败绝不破坏 run 的收尾 */ });
      if (ge("info")) diagLine(`\x1b[2m${formatRunStats(performance.now() - runStartMs, llmMs, toolMs, toolCalls, idleReconnects, 0, cacheDebtTokens)}\x1b[0m\n`, answerOnly);
      // M-Memory 弧第二半：one-shot 的会话终了沉淀（确定性提炼，静默；AWAIT
      // ——one-shot 此后就是 process exit，fire-and-forget 会跟退出竞速丢条）。
      await oneShotLtsMemory.captureAtSessionEnd({ sessionId, messages: state.messages }).catch(() => {});
    }
    // 夜移 035 (codex turn_timing): the run's six-bucket phase split, debug
    // tier only — answers "where did the wall clock go" with the same
    // buckets codex's completion timeline reports (sampling / tools /
    // compaction / harness overhead). Buckets re-sum to totalMs.
    if (ge("debug")) {
      const tp = runProfile.complete();
      stdoutGuard.writeRawStdout(
        `\x1b[2m  phases ${tp.totalMs}ms = pre ${tp.beforeFirstSamplingMs} + sampling ${tp.samplingMs}`
          + ` (req ${tp.samplingRequestCount}${tp.samplingRetryCount > 0 ? `, retry ${tp.samplingRetryCount}` : ""})`
          + ` + tools ${tp.toolBlockingMs} + compact ${tp.compactionMs}`
          + ` + between ${tp.betweenSamplingOverheadMs} + tail ${tp.afterLastSamplingMs}\x1b[0m\n`,
      );
    }
    };
    // M61 §3 (re-review BLOCKER): the headless /goal routing runs for EVERY
    // command shape — set runs to a verdict; clear closes a restored goal;
    // bare status prints. The condition already rides the first user message.
    if (headlessGoal !== undefined && headlessGoalCommand !== undefined) {
      const routed = await routeHeadlessGoalCommand(headlessGoalCommand, {
        controller: headlessGoal,
        loadEntries: () => store.loadSessionEntries(sessionId),
        availability: () => goalEvaluatorAvailable(process.env, workspaceRoot),
      });
      stdoutGuard.writeRawStdout(`${routed.notice}\n`);
      if (routed.kind === "exit") return;
    }
    // ω99-51 (session projection seam): the todo domain source for the
    // one-shot plan flow — byte-equal to the retired lastTodoBoard backscan
    // (docs/research/106-*.md).
    const todoSource = createTodoBoardSource();
    // R3-T001 深测弧：中途异常也结算（已执行结果+aborted 收据+索引 flush）
    // ——见 runPass 内 emergencySettle 注释。结算本身 best-effort：失败不
    // 改写原始异常，rethrow 保 exit-1 语义。
    try {
      await runPass(planMode);
    } catch (err) {
      await emergencySettle?.(err).catch(() => {});
      throw err;
    }
    // M37 §1: the one-shot plan flow — plan pass, print the board, then (on a
    // TTY) offer the ok-to-execute pass with normal tools. A non-interactive
    // run stops at the plan.
    if (planMode) {
      const board = todoSource.current(state.messages);
      if (board === undefined) {
        process.stdout.write("（plan 运行未产出看板——无可审查）\n"); // ω99-166d-ii: #29（=repl #1 的 headless 孪生）
      } else {
        process.stdout.write(`\n${board}\n`);
        // 审批痕: capture the RAW trimmed line (its own bytes, case
        // preserved); empty/whitespace-only stays negative — confirmLine's
        // y/N semantics are unchanged.
        const approvalLine = stdin.isTTY === true ? await confirmLineRaw("execute this plan? [y/N] ") : "";
        const approved = planConfirmApproves(approvalLine);
        if (approved) {
          // M24: the trace push happens at the approval moment — a turn
          // boundary, BEFORE the execution run starts, never mid-run.
          appendPlanApprovalTrace(state.messages, approvalLine);
          // I1 follow-up: the wrapper joins the chain under the trace —
          // appendPlanExecutionWrapper mints a fresh uuid linked at the
          // trace's nodeKey (persistence-only metadata, M53 branched-turn
          // shape; never serialized to the provider).
          appendPlanExecutionWrapper(state.messages, buildPlanExecutionPrompt(board));
          // R3-T001 深测弧：执行 pass 同款异常结算（plan pass 已单独结算）。
          try {
            await runPass(false);
          } catch (err) {
            await emergencySettle?.(err).catch(() => {});
            throw err;
          }
        } else {
          process.stdout.write("(plan not executed)\n");
        }
      }
    }
    // M24 run summary: session-cumulative weighted hit rate.
    const cacheSummary = model.stats.summaryLine();
    if (cacheSummary && ge("info")) process.stdout.write(`${cacheSummary}\n`);

    // M49 §2: the background review fork — a successful ≥3-tool-call run
    // spawns the shareContext reviewer through the session registry. The
    // one-shot AWAITS it: the process (and registry.abortAll in the finally
    // below) ends with the run, so a fire-and-forget review would die midair.
    if (toolCalls >= REVIEW_MIN_TOOL_CALLS) {
      const review = await spawnBackgroundReview({
        workspaceRoot,
        model,
        registry,
        systemPrompt: state.systemPrompt,
        messages: state.messages,
        tools,
        onReceipt: (line) => process.stdout.write(`${line}\n`),
      });
      if (review !== undefined) await review.done;
    }

    // ω-4f (design 84 §3(f)): Dream memory consolidation — the same
    // run-settle seam, immediately after the review fork. The one-shot AWAITS
    // it for the same reason it awaits the review: the process (and
    // registry.abortAll in the finally below) ends with the run, so a
    // fire-and-forget dream would die midair. All due-gates run inside the
    // spawn; a not-due dream costs one store read.
    {
      const dream = await spawnDreamRun({
        workspaceRoot,
        model,
        registry,
        onReceipt: (line) => process.stdout.write(`${line}\n`),
      });
      if (dream !== undefined) await dream.done;
    }

    // Persist only the NEW messages: this turn's user prompt + whatever the loop
    // appended. Identity-based (not index-based) because tier-2 compaction
    // replaces state.messages wholesale; markers were persisted at event time.
    // M49 §3: each appended message also feeds the session search index
    // (incremental; one flush per run).
    const toPersist = selectMessagesToPersist(state.messages, history);
    for (const m of toPersist) {
      await store.append(sessionId, m);
      searchIndex.indexMessage(sessionId, m);
    }
    await searchIndex.flush().catch(() => {});
  } finally {
    // M30: the one-shot process ends here — cancel background agents the
    // model never collected (their reports cannot outlive the process).
    registry.abortAll();
    // M64-A §A: close the peer inbox + unregister before exit (the hoisted
    // stopper survives every early return inside the try).
    await stopPeer?.();
    // ω-4a: the process-exit sweep — reap every watched child and close every
    // watcher (in-memory watches die with the process by design).
    stopMonitor?.();
    await closeMcpTools();
    await closeLspTools(); // P2-9: the language server gets the same bounded drain
    await closeTerminalTools(); // P2-12: the PTY sessions get the same bounded drain
    // 夜移 034: the exit drain — Node does not flush stdio on exit, so a
    // piped slow consumer loses the buffered tail. The empty probe's
    // callback landing certifies every queued write reached the OS.
    await stdoutGuard.flushRawStdout();
  }
}

main().catch((err) => {
  process.stderr.write(`wudao: ${err instanceof Error ? err.message : String(err)}\n`);
  // 借鉴弧 α3 — the model-unreached stamp (transient-class death with ZERO
  // model bytes): the schedules daemon arms its bounded miss-retry on THIS
  // typed line only. Never parsed prose — a machine chapter.
  if (modelUnreachedStampDue(err)) process.stderr.write(`${SCHEDULE_MODEL_UNREACHED_MARKER}\n`);
  // vitest 工人进程里绝不 process.exit：m80 一类的接线测试会 module-eval 本
  // 入口钉构造点，晚到的异步清理拒绝可能在测试收卷后才落入此 catch——
  // 退进程被 vitest 记为「process.exit unexpectedly called」，全绿变红
  //（0.4.21 预检满载揭发）。测试环境只写 stderr，不夺 worker 的生存权；
  // 生产路径不变。
  if (process.env.VITEST) return;
  process.exit(1);
});
