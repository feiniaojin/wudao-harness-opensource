#!/usr/bin/env node
// @wudao/cli — entrypoint. `wudao "<prompt>"` runs the agent against a real model
// (when WUDAO_API_KEY/OPENAI_API_KEY is set); otherwise prints guidance.
// The FIRST import must stay the production-React pin (see react-prod.ts):
// it evaluates before `react` loads and picks its build.
import "./react-prod.js";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { join, dirname, relative } from "node:path";
import { runAgentLoop, createJsonlSessionStore, createReadStateTable, createFileHistory, createAskUserTool, applySummaryMarkers, repairOrphanedToolCalls, activeBranchLeafKey, resumeChain, compactionRetentionFor, newSessionId, classifyTurnRetryError, type AgentHooks, type AgentState, type AgentMessage, type AskUserOption, type PermissionDecision, type LoopEvent, type ModelClient, type Tool, sessionLeaseBoxFor } from "@wudao/core";
import { createProvider, modelAcceptsImages, type ProviderConfig } from "@wudao/providers";
import { createFileAttachmentStore, type ImageBlock } from "@wudao/core";
// 夜移 035 (the upstream projectturn_timing): the one-shot run's phase recorder (debug tier).
import { createTurnProfileRecorder } from "@wudao/core";
// 夜移 032 stage-2 (the upstream projectturn_diff_tracker): the one-shot run's net-change
// tracker — one instance for the whole command, shared by the tool set and
// both passes (reset per pass), rendered once at settle.
import { createTurnDiffTracker } from "@wudao/core";
// ω99-46: the process egress policy — installed once at boot so every
// default-fetch outbound path (providers, web_fetch) routes through it.
import { resolveEgressPolicy, installEgressProxy } from "@wudao/core";
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
import { createBrowserRuntime } from "@wudao/browser";
// ω-4a: the monitor runtime (monitor tools + steering-lane event delivery).
import { createMonitorRuntime } from "./monitor.js";
import { createGoalController, buildEvaluatorModel, goalEvaluatorAvailable, parseGoalCommand, routeHeadlessGoalCommand, type GoalController } from "./goal.js";
import { parseSessionFlags, parseSandboxFlags, parseProviderFlags, parsePluginFlags, parsePlanFlag, parseForkSessionFlag, parseAblationFlags, applyAblationFlagsToEnv, isFeatureAblated, parseImageFlags, parseSessionNameFlag, splitEndOfOptions, subcommandArgv, parseTrustWorkspaceFlag, parseHelpVersionFlags, CLI_USAGE_TEXT } from "./args.js";
// M64-A §A: the one-shot peer-messaging runtime (UDS inbox + registry).
import { createPeerRuntime, readPeerDialogExpiry, sidecarMessageReview } from "./peer/runtime.js";
import { forkSessionFile } from "./fork-session.js";
import { buildPlanPrompt, buildPlanExecutionPrompt, createTodoBoardSource, planModeDenied, appendPlanApprovalTrace, planConfirmApproves } from "./plan.js";
import { modeFromArgv, modeLabel, resolveInitialMode, createPermissionGate, toolMetaResolverFor, loadPermissionTiers, loadPermissionSettings, decideRichPermission, createDurableAskTierGate } from "./permission.js";
import { lintPermissionRules, formatLintReport } from "./perms-lint.js";
import { loadSidecarSettings, resolveSidecarRuntime, createSidecarFromConfig, type Sidecar } from "./sidecar.js";
import { printBanner } from "./tui/banner.js";
import { formatAskUserPrompt, mapAskUserLine } from "./ask-user-line.js";
import { createBreakLineGuard, createCacheTrackingModel, formatUsageLine } from "./cache.js";
import { runRepl, appendPlanExecutionWrapper, createSubagentCostSink } from "./repl.js";
import { selectMessagesToPersist } from "./persist.js";
import { buildToolSet, resolveDeferMode } from "./tools.js";
import { maybeLoginShellEnv } from "./shell-snapshot.js";
import type { LongOutputConfig, WriteVerifyConfig } from "@wudao/core";
import { createExternalChangeProber } from "./file-changes.js";
import { createGitStatusProber } from "./git-status-note.js";
import { getCompactInstructionsRider } from "./project-context.js";
import { createProviderModelResolver, createSessionRegistry } from "./agents/index.js";
// ω99-57: the one-shot child-mail lane (task-tool sink + steering-take drain).
import { createChildMailLane } from "./agents/child-mail.js";
import { loadLongTaskSettings, resolveLongTaskRuntime, applyGatesAblation, type LongTaskRuntime } from "./long-task-config.js";
import { loadWriteVerifySettings, resolveWriteVerifyRuntime, loadLongOutputSettings, resolveLongOutputRuntime, resolveGenericShapingRuntime } from "./output-config.js";
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
import { createMemoryRuntime, surfacePendingReview, refineAutoRuntimeFor, observeAutoRefineOnHooks } from "./memory/index.js";
import { spawnBackgroundReview, REVIEW_MIN_TOOL_CALLS } from "./memory/review.js";
// ω-4f (design 84): Dream consolidation — stage 2 (ledger→curated ledger).
import { spawnDreamRun } from "./memory/dream.js";
import { createSessionSearchIndex, runSessionSearch } from "./session-search.js";
import { metaMain } from "./meta/journal.js";
import { formatStatuslineLine, statuslineFromWorkspace } from "./statusline.js";
import { askReviewIntro } from "./ask-reviewer.js";
import { createTaintTracker, argsCarryTaint } from "./taint.js";
import { loadMcpConfig } from "./mcp/config.js";
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
  parseContextExcludes,
  resolveAutoCompactSettings,
  resolveMemorySettings,
  resolveMcpEnabled,
  parseFallbackModels,
  readDeferModeSetting,
  resolveLspEnabled,
  resolveTerminalEnabled,
  resolveDocSuiteEnabled,
} from "./misc-config.js";
// ω99-236: the doc trio's roster module (十二面名册 + 使能门 runtime flag).
import { setDocSuiteRuntimeEnabled } from "./doc-suite.js";
import { loadLayeredSettings, readGlobalSettings } from "./settings-layer.js";
// Provider management §7: the per-model context-window chain (registry
// contextLength → provider default → env) feeds every build point below.
import { loadEffectiveProfiles, resolveSessionWindowTokens } from "./provider-registry.js";
// R6 quickwin: the Ctrl+S pick defaults read (the ui boot applies them).
import { readStoredModelDefaults } from "./driver/settings-ops.js";
import { setSessionDeferMode } from "./tools.js";
import { openSessionMemoryStore, setSessionMemorySettings } from "./memory/index.js";
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

// Auto-load a .env file (from cwd, walking up to 5 parents) so the API key /
// baseURL / model don't need to be exported manually. Existing process.env wins.
// —— main 前置纯/半纯工具族外提（ω99 拆分运动：纯移动段外提；原文件 re-export 门面）——
export function loadEnvFile(): void {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    let text: string | undefined;
    try {
      text = readFileSync(candidate, "utf8");
    } catch {
      text = undefined;
    }
    if (text === undefined) {
      const parent = dirname(dir);
      if (parent === dir) return;
      dir = parent;
      continue;
    }
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
    return;
  }
}

// M34 §1: the one-shot ask_user seam — a raw-stdin line prompt (same
// mechanics as askApprove: this path keeps no readline interface). Options
// print as a numbered list; a bare in-range number picks that label.
export function askUserLine(question: string, options?: readonly AskUserOption[]): Promise<string> {
  if (stdin.isTTY !== true) return Promise.reject(new Error("no interactive user"));
  return new Promise((resolve) => {
    stdout.write(formatAskUserPrompt(question, options));
    const onData = (chunk: Buffer | string): void => {
      const line = String(chunk).split("\n")[0] ?? "";
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(mapAskUserLine(line, options));
    };
    process.stdin.once("data", onData);
    process.stdin.resume();
  });
}

// M37 §1: the one-shot --plan approval — a plain y/N line (same raw-stdin
// mechanics as askApprove; anything but y/yes declines).
// 审批痕: the raw-line reader beneath confirmLine — same mechanics minus the
// case-fold, so the plan flow can push the VERBATIM trimmed line the human
// typed. "" when not a TTY (confirmLine's fail-closed false) and for an
// empty/whitespace-only line (empty = negative; nothing is ever pushed).
export function confirmLineRaw(question: string): Promise<string> {
  if (stdin.isTTY !== true) return Promise.resolve("");
  return new Promise((resolve) => {
    stdout.write(question);
    const onData = (chunk: Buffer | string): void => {
      const line = String(chunk).split("\n")[0]?.trim() ?? "";
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(line);
    };
    process.stdin.once("data", onData);
    process.stdin.resume();
  });
}

export function confirmLine(question: string): Promise<boolean> {
  return confirmLineRaw(question).then(planConfirmApproves);
}

// ω99-54: a fresh session id — now the core UUIDv7 factory (time-sortable:
// list()'s v7 tier orders by id string, no stat). Same seam the spill dir
// naming below rides on.
export function newId(): string {
  return newSessionId();
}

// Debug-level subagent event renderer shared by both call sites.
export function subagentEventHandler(ge: (l: LogLevel) => boolean): (e: LoopEvent) => void {
  return (e: LoopEvent) => {
    if (!ge("debug")) return;
    // 夜移 034: the guarded lane — serialized + retry + callback-verified.
    if (e.type === "tool_call_started") stdoutGuard.writeRawStdout(`    └─ 🔧 ${e.toolName}\n`);
    else if (e.type === "assistant_delta") stdoutGuard.writeRawStdout(e.text);
  };
}

// MCP servers from .wudao/mcp.json (optional): config problems and dead
// servers warn on stderr; the run proceeds with whatever came up.
export function mcpWarn(msg: string): void {
  process.stderr.write(`⚠️ ${msg}\n`);
}

// M62 §7: the MCP master switch + timeouts (module-level because the
// loadMcpToolsFor helper below predates main()'s settings resolution — set
// once in main before any frontend loads tools).
let mcpRuntime: { enabled: boolean; timeouts: ReturnType<typeof parseMcpTimeouts> } = { enabled: true, timeouts: {} };
/** ω99 拆分运动修正：index 的 main() 经此写回现值——单绑定（双 let 会断开读写）。 */
export function setMcpRuntime(next: { enabled: boolean; timeouts: ReturnType<typeof parseMcpTimeouts> }): void { mcpRuntime = next; }

export async function loadMcpToolsFor(cwd: string, plugins: readonly LoadedPlugin[]): Promise<Tool[]> {
  // M62 §7: mcpEnabled:false → zero MCP surface (no config read, no spawn).
  if (!mcpRuntime.enabled) return [];
  // A3: the merged startup list (user mcp.json + plugin servers) is part of
  // the extension state — a rescan refreshes it in place. The pre-A3 merge
  // stays as the fallback for the (never-live) un-bootstrapped path.
  const config = getExtensionState()?.mcpConfig ?? mergeMcpConfigs(loadMcpConfig(cwd, mcpWarn), plugins, mcpWarn);
  return loadMcpTools(config, mcpWarn, mcpRuntime.timeouts);
}

// Resolve the session for interactive/one-shot runs: --resume <id> rehydrates a
// known session; --continue rehydrates the most recent; otherwise fresh id.
// applySummaryMarkers rebuilds the tier-2 summary prefix from the frozen marker
// lines in the JSONL, reproducing the exact in-memory shape the last run left
// behind (cache-stable across resume/continue). repairOrphanedToolCalls fixes
// history truncated between a tool_use and its tool_result (crash mid-run).
// M28: entries (model_change / thinking_level_change) ride the same JSONL —
// loadSessionEntries reads them, load() filters them out of the history, and
// the last recorded model state decides what this run diverges from.
export async function resolveSession(
  argv: string[],
  store: ReturnType<typeof createJsonlSessionStore>,
  sessionsDir: string,
): Promise<{ sessionId: string; history: AgentMessage[]; lastModel: LastModelState; forked: boolean; fresh: boolean }> {
  const { resumeId, cont } = parseSessionFlags(argv);
  const resolve = (id: string, entries: Awaited<ReturnType<typeof store.loadSessionEntries>>, forked = false) => {
    const messages = entries.filter((e): e is AgentMessage => "role" in e);
    return {
      sessionId: id,
      forked,
      fresh: false,
      // ω99-211 — only the fresh mint below is `fresh` (an id adopted
      // from disk is not, even when its entries are empty — a --continue of
      // a leftover empty file adopts that id; the boot bookkeeping then
      // writes onto the EXISTING file, materializing nothing new).
      // M53 review fix: branch-aware — the JSONL keeps trunk + abandoned +
      // branch in FILE order; a linear load would flatten them into one
      // conversation. Walk the chain the recorded active_branch entry names
      // (linear-last fallback when absent/corrupt), THEN project.
      // M52 §1: chain-aware projection — keep from the FIRST summary marker so
      // every chained summary survives; the next compaction continues after
      // the last one instead of re-summarizing frozen bytes.
      history: repairOrphanedToolCalls(applySummaryMarkers(resumeChain(messages, activeBranchLeafKey(entries)), { chain: true })),
      lastModel: lastModelState(entries),
    };
  };
  if (resumeId) {
    // M58 §C#5: --fork-session copies the JSONL to a fresh id and resumes the
    // FORK — the original file is never opened for write (byte-untouched);
    // the fork inherits every recorded entry (branches, boundaries, names).
    if (parseForkSessionFlag(argv)) {
      const fork = await forkSessionFile(sessionsDir, resumeId);
      // 120-a A3: the receipt names the inherited rewind lineage — the fork's
      // /rewind can traverse past the fork point (0 = the parent had none).
      stdoutGuard.writeRawStdout(
        `forked session: ${fork.newId} (from ${resumeId} · ${fork.bytes} bytes · original untouched · ${fork.lineageSteps} rewind steps inherited)\n`,
      );
      return resolve(fork.newId, await store.loadSessionEntries(fork.newId), true);
    }
    return resolve(resumeId, await store.loadSessionEntries(resumeId));
  }
  if (cont) {
    const ids = await store.list();
    const last = ids[ids.length - 1];
    if (last) return resolve(last, await store.loadSessionEntries(last));
  }
  return { sessionId: newId(), history: [], lastModel: {}, forked: false, fresh: true };
}

// M63-C: the hook fire runtime's shared context (module-level — the one-shot
// runReal populates the session fields after main() built the hooks object;
// the closures read through these boxes at fire time).
export const hookCommon: { sessionId?: string; mode: string; effort?: string } = { mode: "workspace" };
export const hookMcpTools: { current?: readonly Tool[] } = {};
export const hookRewake: { current?: (message: string) => void } = {};
// M63-C R1 (§2 prompt_id): the driver/REPL mint one id per submitted prompt.
export const hookPromptId: { current?: string } = {};
// M63-C R1 follow-up: the LIVE session id — the driver rotates it on
// clear/resume/fork and owns the truth; payloads prefer it over the
// boot-time hookCommon.sessionId (which goes stale after /clear).
export const hookSessionId: { current?: string } = {};
// R6-I1: the driver-installed warn sink — hook systemMessage/statusMessage/
// mcp_tool failures reach the user's history on every frontend.
export const hookWarn: { current?: (message: string) => void } = {};
// P1-5 (96 队列): the boot's trust-gate view — set once in main() after the
// flag/decision resolution; the one-shot's runReal (a separate function with
// a 17-positional-param signature already) reads the box instead of growing
// it. The default is the open gate (absent = no gate, hermetic tests).
export const trustGateBoot: { suppressed: () => boolean; notice?: string } = { suppressed: () => false };
// R6-P2: the workspace root hook payloads build paths against — the entry
// paths set it from their REAL root (a server launched from another cwd
// must not hand hooks a nonexistent transcript path); cwd is the fallback.
export const hookWorkspaceRoot: { current?: string } = {};
// B2 review fix: the BOOT root — the transcript file is anchored to where the
// process started; it does NOT follow an agentRootSwitch. The `hookWorkspaceRoot`
// above is the live hook payload root (follows agent switches); the
// transcript_path uses this one, never the live one. (fix: the 40fff2e merge
// mangled this to `{ current?: string } = {}`, which no longer type-checks
// against hookCommonFields' required `transcriptRoot: string` — f3aa20d's
// reviewed form is restored.)
export const hookTranscriptRoot: { current: string } = { current: process.cwd() };

// M63-C R1: the shared fire-runtime VIEW (module scope — runReal and the
// frontend paths all hand the SAME closures to their hook compiles).
export const hookRuntimeView: import("./hooks-config.js").NonNeverRuntime = {
  getMode: () => hookCommon.mode,
  common: () => hookCommonFields({
    sessionId: hookSessionId.current ?? hookCommon.sessionId,
    promptId: hookPromptId.current,
    permissionMode: hookCommon.mode,
    effort: hookCommon.effort,
    // B2 review: the BOOT root — never hookWorkspaceRoot (it follows an
    // agentRootSwitch; the transcript file does not move with it).
    transcriptRoot: hookTranscriptRoot.current,
  }),
  mcp: {
    call: async (server: string, tool: string, input: Record<string, unknown>) => {
      const all = hookMcpTools.current ?? [];
      const t = all.find((x) => x.name === `mcp__${server}__${tool}`);
      if (t === undefined) return { ok: false, error: `unknown mcp server/tool ${server}/${tool}` };
      const r = await t.execute(input);
      return r.isError === true ? { ok: false, error: r.content } : { ok: true, text: r.content };
    },
  },
  rewake: (message: string) => hookRewake.current?.(message),
};

/** No-key interactive fallback (task 8 fix 2): on a TTY, one readline
 *  question — Enter resolves true and the caller re-enters main() AS `wudao
 *  ui` (the same in-process dispatch the subcommand uses), whose boot plan
 *  launches the first-run wizard. Ctrl+C / EOF resolves false: today's
 *  notice-and-exit — the notice is already on screen by then. */
export function askFirstRunWizard(): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: stdin, output: stdout });
    let settled = false;
    const finish = (launch: boolean): void => {
      if (settled) return;
      settled = true;
      rl.close();
      resolve(launch);
    };
    rl.on("close", () => finish(false)); // EOF (Ctrl+D on a real terminal)
    rl.on("SIGINT", () => finish(false)); // Ctrl+C: keep today's exit
    rl.question("按回车启动新手向导 (wudao ui)，Ctrl+C 退出… ", () => finish(true));
  });
}

// 借鉴弧 α3（the upstream 思想）— 一次性运行的「模型零接触」回执。runReal 的事件
// 循环把任何 reasoning/assistant 增量的到达记进这个盒（一次进程一次运行）；
// main().catch 里死亡时若盒仍空且错误分类为瞬态 provider 错（429/5xx/
// network——classifyTurnRetryError 的瞬态词汇表），stderr 盖一章
// SCHEDULE_MODEL_UNREACHED_MARKER。章与调度无关（任何 -p 运行都盖）——它是
// 「本次运行零模型接触、零工具副作用」的诚实回执；schedules 守护只信这个
// 类型化章，用它武装漏火补跑（重跑零副作用可证）。
export const oneShotRunFacts: { reachedModel: boolean } = { reachedModel: false };

/** 死亡时刻的盖章判定：瞬态 provider 错 AND 模型零接触 → true（调用方据此
 *  盖章）。非瞬态（4xx 认证错等）不盖——那是配置问题，补跑只会重复失败；
 *  已有字节到达不盖——模型被接触过，重跑有重复计费面。 */
export function modelUnreachedStampDue(err: unknown): boolean {
  if (oneShotRunFacts.reachedModel) return false;
  const cls = classifyTurnRetryError(err);
  return cls === "429" || cls === "5xx" || cls === "network";
}
