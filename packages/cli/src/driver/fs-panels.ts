// M43-A §1 — AgentDriver: the framework-agnostic frontend logic, extracted
// verbatim from tui/use-agent.ts. One driver owns one conversation: it drives
// the loop, maps events to HistoryEntry[] (the append-only channel), keeps a
// small full-snapshot status (the state channel — NEVER containing history,
// so a streaming delta cannot fan out O(history) payloads), parks permission
// asks, owns the runtime mode, and exposes the ops every frontend submits
// through. React (the TUI) is a useSyncExternalStore adapter over this class;
// the WS server (wudao ui) is another consumer.
import { truncateSafe } from "@wudao/core"; // 113-A4
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
import { str, DIFF_CAP_CHARS } from "./format.js";
import type { FileTreeEntry, FileTreeResult, FileReadResult, FileWriteResult } from "./types.js";

// Best-effort read of the file a write_file call is about to overwrite:
// existing content → render a diff instead of a "new file" preview.
// undefined (no workspaceRoot, path escape, ENOENT, read failure) → fall
// back to the current preview behavior. Never throws.
export async function readExistingForDiff(
  workspaceRoot: string | undefined,
  input: Record<string, unknown>,
): Promise<string | undefined> {
  const path = str(input.path);
  if (!workspaceRoot || !path) return undefined;
  try {
    const r = await resolveWorkspacePath(workspaceRoot, path);
    if (!r.ok) return undefined;
    return await readFile(r.absPath, "utf8");
  } catch {
    return undefined;
  }
}

// M74-ide §1 — the file-panel ops' shared machinery (pure halves; the driver
// methods below compose them with resolveWorkspacePath).
/** Tree names marked hidden beyond dotfiles (the CLIENT filters on the flag;
 *  the server only marks). */
export const HIDDEN_ENTRY_NAMES: ReadonlySet<string> = new Set(["node_modules", "__pycache__", "dist", "target"]);
/** fileRead caps: 1MB hard limit (over → truncated:true), 100KB prefix. */
export const FILE_READ_LIMIT_BYTES = 1024 * 1024;
export const FILE_READ_PREFIX_BYTES = 100 * 1024;
/** fileWrite caps (高亮/编辑 spec §3): 1MB content limit; the conflict
 *  reply's current prefix. */
export const FILE_WRITE_LIMIT_BYTES = 1024 * 1024;
export const FILE_WRITE_CURRENT_PREFIX_BYTES = 100 * 1024;
/** Extensions sniffed as binary without reading a byte. */
export const BINARY_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "gif", "pdf", "woff", "ico", "exe", "bin", "zip", "tar", "gz"]);
/** The language tokens the viewer highlights, keyed by lowercase extension;
 *  everything else reads as "text". */
export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", py: "python",
  md: "markdown", json: "json", yaml: "yaml", css: "css", html: "html",
  sh: "shell", rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp",
  h: "c", rb: "ruby", php: "php", sql: "sql", toml: "toml", xml: "xml",
};

export function isHiddenEntryName(name: string): boolean {
  return name.startsWith(".") || HIDDEN_ENTRY_NAMES.has(name);
}

/** True when the workspace-relative (posix-form) path is on the data panel's
 *  sensitive list: any .git/.ssh path segment, or a basename beginning
 *  .env/credentials. fileRead rejects these BEFORE the existence check — a
 *  probe of ".env exists?" is itself a leak; fileTree answers them with empty
 *  entries (spec §5 — stricter than the agent's read_file, which needs its
 *  paths for real work). */
export function isSensitiveRelPath(rel: string): boolean {
  const segments = rel.split(/[\\/]/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === ".git" || s === ".ssh")) return true;
  const base = segments[segments.length - 1] ?? "";
  return base.startsWith(".env") || base.startsWith("credentials");
}

/** The workspace-relative posix form of an already-resolved absPath. The root
 *  must be realpath'd too (resolveWorkspacePath returns the resolved absPath;
 *  on macOS a tmpdir workspace is a /var → /private/var symlink, and mixing
 *  the two forms would garble the relative path). */
export function relWithinWorkspace(rootReal: string, absPath: string): string {
  return relative(rootReal, absPath).split(sep).join("/");
}

// M74-ide §1: one directory level for the file panel. Hidden marking is
// advisory (the client filters); containment is NOT — resolveWorkspacePath
// is the same gate read_file uses, and sensitive directories answer empty.
export async function fileTreeListing(workspaceRoot: string, path: string): Promise<FileTreeResult> {
  const resolved = await resolveWorkspacePath(workspaceRoot, path);
  if (!resolved.ok) throw new Error(resolved.error);
  const rootReal = await realpath(workspaceRoot).catch(() => undefined);
  if (rootReal === undefined) return { entries: [] };
  const rel = relWithinWorkspace(rootReal, resolved.absPath);
  if (rel !== "" && isSensitiveRelPath(rel)) return { entries: [] };
  let dirents: import("node:fs").Dirent[];
  try {
    dirents = await readdir(resolved.absPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(code === "ENOTDIR" ? `not a directory: ${path}` : `no such directory: ${path}`);
  }
  const entries: FileTreeEntry[] = [];
  for (const d of dirents) {
    const hidden = isHiddenEntryName(d.name);
    const mark = hidden ? { hidden: true as const } : {};
    if (d.isDirectory()) {
      entries.push({ name: d.name, type: "dir", ...mark });
      continue;
    }
    // Symbolic links classify by target (a dir link expands; a broken one
    // still lists as a file). FIFOs/sockets are skipped — not tree content.
    const isLink = d.isSymbolicLink();
    if (!d.isFile() && !isLink) continue;
    const st = await stat(join(resolved.absPath, d.name)).catch(() => undefined);
    if (isLink && st?.isDirectory()) {
      entries.push({ name: d.name, type: "dir", ...mark });
      continue;
    }
    entries.push({ name: d.name, type: "file", ...(st?.isFile() === true ? { size: st.size } : {}), ...mark });
  }
  // Dirs first, then files — each alphabetical by code-unit order (the
  // deterministic cross-platform sort; locale compares vary by ICU build).
  entries.sort((a, b) =>
    a.type === b.type ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.type === "dir" ? -1 : 1,
  );
  return { entries };
}

// M74-ide §1: one file's read for the file panel — sensitive-path gate,
// binary sniff (extension or a NUL in the first 100 bytes), then a single
// sequential pass that counts newlines over ALL bytes (lines is
// pre-truncation) while keeping only the reply's prefix in memory.
export async function fileReadContent(workspaceRoot: string, path: string): Promise<FileReadResult> {
  const resolved = await resolveWorkspacePath(workspaceRoot, path);
  if (!resolved.ok) throw new Error(resolved.error);
  const rootReal = await realpath(workspaceRoot).catch(() => undefined);
  if (rootReal === undefined) throw new Error("workspace root not found");
  const rel = relWithinWorkspace(rootReal, resolved.absPath);
  if (isSensitiveRelPath(rel)) throw new Error("sensitive path");
  const st = await stat(resolved.absPath).catch(() => undefined);
  if (st === undefined) throw new Error(`no such file: ${path}`);
  if (!st.isFile()) throw new Error(`not a file: ${path}`);
  const totalBytes = st.size;
  const ext = extname(resolved.absPath).replace(/^\./, "").toLowerCase();
  const language = LANGUAGE_BY_EXTENSION[ext] ?? "text";
  if (BINARY_EXTENSIONS.has(ext)) {
    return { content: "", truncated: false, totalBytes, lines: 0, language, binary: true };
  }
  const fh = await open(resolved.absPath, "r");
  try {
    // Binary sniff: a NUL byte within the first 100 (spec §3).
    const sniffLen = Math.min(100, totalBytes);
    if (sniffLen > 0) {
      const sniff = Buffer.alloc(sniffLen);
      await fh.read(sniff, 0, sniffLen, 0);
      if (sniff.includes(0)) {
        return { content: "", truncated: false, totalBytes, lines: 0, language, binary: true };
      }
    }
    const truncated = totalBytes > FILE_READ_LIMIT_BYTES;
    const cap = truncated ? FILE_READ_PREFIX_BYTES : totalBytes;
    const content = Buffer.alloc(cap);
    let filled = 0;
    let newlines = 0;
    let last = -1;
    const chunk = Buffer.alloc(64 * 1024);
    let pos = 0;
    while (pos < totalBytes) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
      if (bytesRead === undefined || bytesRead <= 0) break;
      const take = Math.min(bytesRead, cap - filled);
      if (take > 0) {
        chunk.copy(content, filled, 0, take);
        filled += take;
      }
      for (let i = 0; i < bytesRead; i += 1) {
        const b = chunk[i]!;
        if (b === 0x0a) newlines += 1;
        last = b;
      }
      pos += bytesRead;
    }
    // A final unterminated line still counts; an empty file has zero lines.
    const lines = totalBytes === 0 ? 0 : newlines + (last === 0x0a ? 0 : 1);
    return { content: content.toString("utf8"), truncated, totalBytes, lines, language };
  } finally {
    await fh.close();
  }
}

// 高亮/编辑 spec §3: the viewer's save. User-hand edit — NOT a model
// action, no permission pipeline — but the READ side's guards all apply
// (containment, the sensitive list BEFORE existence, the size limit), then
// the base compare-and-swap and the same-dir tmp+rename atomic write. An
// ENOENT disk reads as "" (base "" creates the file).
export async function fileWriteContent(workspaceRoot: string, path: string, content: string, base: string): Promise<FileWriteResult> {
  const resolved = await resolveWorkspacePath(workspaceRoot, path);
  if (!resolved.ok) throw new Error(resolved.error);
  const rootReal = await realpath(workspaceRoot).catch(() => undefined);
  if (rootReal === undefined) throw new Error("workspace root not found");
  const rel = relWithinWorkspace(rootReal, resolved.absPath);
  if (isSensitiveRelPath(rel)) throw new Error("sensitive path");
  if (Buffer.byteLength(content, "utf8") > FILE_WRITE_LIMIT_BYTES) throw new Error("content exceeds 1MB limit");
  let disk: string;
  try {
    disk = await readFile(resolved.absPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") disk = "";
    else throw err;
  }
  if (disk !== base) {
    const current = Buffer.byteLength(disk, "utf8") > FILE_WRITE_CURRENT_PREFIX_BYTES
      ? Buffer.from(disk, "utf8").subarray(0, FILE_WRITE_CURRENT_PREFIX_BYTES).toString("utf8")
      : disk;
    return { conflict: true, current };
  }
  const tmp = join(dirname(resolved.absPath), `.${basename(resolved.absPath)}.wudao-${randomUUID()}.tmp`);
  await writeFile(tmp, content, "utf8");
  await rename(tmp, resolved.absPath);
  return { written: true };
}

export const capDiff = (s: string): string => (s.length > DIFF_CAP_CHARS ? truncateSafe(s, DIFF_CAP_CHARS) : s);

// workspace-ux B2 review: realpath-normalized same-root check — the switch's
// no-op test and the aligned flag share it (a symlinked pick of the SAME tree
// is not a switch, and raw strings can differ: macOS /var vs /private/var).
export async function sameAgentRoot(a: string, b: string): Promise<boolean> {
  const norm = (p: string): Promise<string> => realpath(p).catch(() => p);
  return (await norm(a)) === (await norm(b));
}

// The final answer = the trailing assistant message with no tool_use blocks
// (loop-exit signal). Scans from the tail so earlier tool-call turns are skipped.
export function lastAssistantAnswer(messages: readonly AgentMessage[]): AgentMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m && m.role === "assistant" && !(m.toolCalls && m.toolCalls.length > 0)) return m;
  }
  return undefined;
}

// （notePreview 的 doc 前半段随函数迁 format.ts——ω99-326a 切线在中缝，两半各自成文）
