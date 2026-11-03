// M19: configuration-driven hooks — `.wudao/settings.json` `hooks` section →
// command-style AgentHooks, so users can intercept/rewrite without code.
//
// Loader contract: missing/empty settings → {} (silent); malformed JSON or a
// structurally wrong `hooks` value → warning + {} (never fatal); unknown keys
// → warning listing them, recognized ones kept.
//
// Bridge contract (per plan): each hook command runs execFile-style (no shell;
// the command string is tokenized with quote awareness), cwd=workspaceRoot,
// scrubbed env (same pattern as shell), with the event payload on stdin.
// onPromptSubmit receives the RAW prompt text on stdin so trivial filters like
// `tr 'a-z' 'A-Z'` work; onRunStop receives a JSON summary object.
//
// Config convenience beats fail-closed here: hooks are user-authored
// extensions, not security boundaries, so timeouts and spawn errors degrade to
// allow/original with a warning (documented in README).
//
// ω99 file-size discipline arc A — this module is now the LOADER + FIRE
// BRIDGE + buildConfiguredHooks core; the extracted module-level segments live
// beside it and are re-exported below so the public face is unchanged:
//   hooks-config-types.ts    — settings types + canonical event registry
//   hooks-config-matcher.ts  — matcher compilation / entry filtering
//   hooks-config-exec.ts     — execFile bridge (env scrub, timeouts, sh
//                              fallback) + tokenizer + timing constants
//   hooks-config-parse.ts    — stdout-JSON decision parsers + watch targets
//   hooks-compose.ts         — AgentHooks layer composition (deny-only cap,
//                              two-layer sequential composer)
import { join } from "node:path";
import type {
  AgentHooks,
  AgentMessage,
  AgentState,
  ConfigChangePosition,
  InstructionsLoadedSource,
  NotificationKind,
  PermissionDecision,
  PostToolBatchCall,
  PostToolBatchDecision,
  PreCompactDecision,
  SessionEndSource,
  SessionStartSource,
  StopFailureKind,
  StopHookDecision,
  TaskHookDecision,
} from "@wudao-org/core";
import { loadLayeredSettings } from "./settings-layer.js";
import { CANONICAL_HOOK_EVENTS } from "./hooks-config-types.js";
import type { CanonicalHookEvent, HookCommandConfig, HooksSettings, HookWarn } from "./hooks-config-types.js";
import {
  DEFAULT_TIMEOUT_MS,
  PROMPT_HOOK_TIMEOUT_MS,
  SESSION_END_BUDGET_MS,
  runHookCommand,
  firstLine,
} from "./hooks-config-exec.js";
import type { HookRun } from "./hooks-config-exec.js";
import { compileHookList, applicableHooks } from "./hooks-config-matcher.js";
import type { CompiledHook } from "./hooks-config-matcher.js";
import {
  parseBlockJsonStop,
  parseBlockJsonLine,
  parseStopHookJson,
  parseDeferJson,
  parsePermissionDecisionJson,
  parseUpdatedInputJson,
  parseContinueFalseJson,
  parseTeammateContinueJson,
  parseAdditionalContext,
  capAdditionalContext,
} from "./hooks-config-parse.js";

// ---- facade re-exports (bodies moved ω99 arc A; public face unchanged) ----
export type { HookCommandConfig, HooksSettings, HookWarn, CanonicalHookEvent } from "./hooks-config-types.js";
export { CANONICAL_HOOK_EVENTS } from "./hooks-config-types.js";
export type { CompiledHookMatcher } from "./hooks-config-matcher.js";
export { compileHookMatcher } from "./hooks-config-matcher.js";
export {
  parseDeferJson,
  parsePermissionDecisionJson,
  parseUpdatedInputJson,
  parseContinueFalseJson,
  parseTeammateContinueJson,
  parseAdditionalContext,
  capAdditionalContext,
  MAX_ADDITIONAL_CONTEXT_CHARS,
  fileChangeTargets,
} from "./hooks-config-parse.js";
export { denyOnlyPermissionRequest, composeAgentHooks } from "./hooks-compose.js";
export { SESSION_END_BUDGET_MS, tokenizeCommand } from "./hooks-config-exec.js";
export { peerHookEnvBox } from "./peer/runtime.js";

// Config accepts the canonical keys plus the two short v1 aliases.
const KNOWN_EVENTS = [...CANONICAL_HOOK_EVENTS, "preToolUse", "postToolUse"] as const;
type KnownEvent = (typeof KNOWN_EVENTS)[number];

// Short config aliases → canonical AgentHooks event names.
const canonicalEvent = (key: KnownEvent): CanonicalHookEvent =>
  key === "preToolUse" ? "onPreToolUse" : key === "postToolUse" ? "onPostToolUse" : key;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

// ω99-22 P3 — the reload-noise memo for the unknown-key warnings below. The
// dogfood log reprinted the same "unknown top-level key(s) ignored" line on
// every hot reload of an UNCHANGED file (84 turns, the same global-settings
// line again and again). Per (workspace, tier) the loader remembers the last
// unknown-key SET: same set → quiet (pure reload), changed set → warn again
// so new signal (keys added OR gone) is never swallowed. Process-lifetime
// memory, no persistence — restarting the process re-warns once, by design.
const lastUnknownKeySets = new Map<string, ReadonlySet<string>>();

/** True when this slot's unknown-key set differs from the previous
 *  evaluation's set (and is non-empty) — i.e. the warning is new signal.
 *  Every evaluation records the current set, empty included: a file that
 *  fixes its keys and later re-breaks them the same way warns again. Slot
 *  keys carry the workspace/tier identity, so several workspaces in one
 *  process (server/desktop) never silence each other. */
function unknownKeysNewSinceLastLoad(slot: string, unknown: readonly string[]): boolean {
  const set = new Set(unknown);
  const prev = lastUnknownKeySets.get(slot);
  lastUnknownKeySets.set(slot, set);
  if (unknown.length === 0) return false;
  if (prev === undefined || prev.size !== set.size) return true;
  for (const k of set) if (!prev.has(k)) return true;
  return false;
}

/** ω99-22 test seam: the loader is otherwise warn-injected (pure-ish), so
 *  module state would serialize test cases — tests reset the memo to stay
 *  order-independent. */
export function resetSettingsWarnMemoForTests(): void {
  lastUnknownKeySets.clear();
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadHooksSettings(workspaceRoot: string, warn: HookWarn = defaultWarn, env: NodeJS.ProcessEnv = process.env, opts: { readonly suppressUntrustedProject?: boolean } = {}): Promise<HooksSettings> {
  // M61 §3: the kill switch — WUDAO_DISABLE_HOOKS=1 disables every configured
  // hook (and /goal's evaluator, which rides the same run-stop position).
  if ((env.WUDAO_DISABLE_HOOKS ?? "").trim() === "1") return {};
  // M57 §1: the two-tier reader (global ~/.wudao + project .wudao, deep-merge
  // with array concat-dedup — hook lists accumulate across tiers) owns the
  // file IO and JSON validation; this loader only parses the `hooks` node of
  // the EFFECTIVE record. P1-5: the trust-gate suppression is an EXPLICIT
  // caller param (extension-state passes trust.ts's effectiveSuppressed);
  // absent = no gate — existing callers keep today's bytes. (The env seam is
  // now threaded through — previously the advertised param was ignored for
  // the settings read; no existing caller passed one, so behavior is
  // byte-identical wherever env defaults to process.env.)
  const layered = await loadLayeredSettings(workspaceRoot, warn, env, { suppressUntrustedProject: opts.suppressUntrustedProject });
  const root = layered.effective;

  // "longTask" is a sibling config node owned by long-task-config.ts (M23);
  // "permissions" by permission.ts (M33 §1); "writeVerify"/"longOutput" by
  // output-config.ts (M46); "sidecar" by sidecar.ts (M45); "web" by
  // web-config.ts (M59); "slack" by @wudao-org/slack's settings loader (M60);
  // "env" is RESERVED by the settings-layer trust gate (global-tier env
  // injection, M57) — none belong to the hooks loader, but all are legit
  // top-level keys, not warnings. Fix-round M57: the check runs PER TIER
  // (tier-tagged) so a key only the GLOBAL tier owns never masquerades as a
  // project-file mistake. M62 §7 adds the misc keys (cleanup/softDelete
  // lifecycle, autoCompact*, claudeMdExcludes, memory*, mcp*, fallbackModel,
  // outputStyle, tools.defer) — legit top-level names, not warnings.
  const known = (k: string): boolean =>
    k === "hooks" || k === "longTask" || k === "permissions" || k === "writeVerify" || k === "longOutput" || k === "sidecar" || k === "web" || k === "slack" || k === "env"
    || k === "cleanupPeriodDays" || k === "softDeletePeriodDays"
    || k === "autoCompactWindow" || k === "autoCompactEnabled" || k === "claudeMdExcludes"
    || k === "memoryEnabled" || k === "memoryDirectory"
    || k === "mcpEnabled" || k === "mcpTimeouts"
    // P2-9（96 队列 #9）: the LSP tool's opt-in node (default off).
    // P2-12（96 队列 #12）: the PTY terminal tool's opt-in node (default off).
    || k === "lsp"
    || k === "terminal"
    || k === "fallbackModel" || k === "outputStyle" || k === "tools"
    // ω99-4c: the lint/test reflection node (reflect-config.ts owns it).
    || k === "reflect"
    // M64-A §A: peer-messaging inbound policy + the approval-dialog expiry.
    // P2-15 (96 队列 #15): the OTel export node (global-tier only; the trust
    // gate drops it from the cloneable tiers — default off, zero egress).
    || k === "peerInbound" || k === "peerDialogExpiry"
    || k === "telemetry";
  const projectUnknown = Object.keys(layered.project).filter((k) => !known(k));
  if (unknownKeysNewSinceLastLoad(`${workspaceRoot}|project`, projectUnknown)) {
    warn(`⚠️ .wudao/settings.json：未知的顶层键已忽略：${projectUnknown.join(", ")}`); // ω99-207: #1
  }
  // M62 §3: the local tier gets the same tier-tagged check.
  const localUnknown = Object.keys(layered.local).filter((k) => !known(k));
  if (unknownKeysNewSinceLastLoad(`${workspaceRoot}|local`, localUnknown)) {
    warn(`⚠️ .wudao/settings.local.json：未知的顶层键已忽略：${localUnknown.join(", ")}`);
  }
  const globalUnknown = Object.keys(layered.global).filter((k) => !known(k));
  if (unknownKeysNewSinceLastLoad(`${layered.globalHome}|global`, globalUnknown)) {
    warn(`⚠️ 全局 settings（${layered.globalHome}）：未知的顶层键已忽略：${globalUnknown.join(", ")}`);
  }

  const hooksValue = root["hooks"];
  if (hooksValue === undefined) return {};
  if (hooksValue === null || typeof hooksValue !== "object" || Array.isArray(hooksValue)) {
    warn("⚠️ settings：\"hooks\" 应为对象——hooks 已停用");
    return {};
  }

  const out: Partial<Record<CanonicalHookEvent, readonly HookCommandConfig[]>> = {};
  const unknownEvents: string[] = [];
  for (const [key, value] of Object.entries(hooksValue as Record<string, unknown>)) {
    if (!KNOWN_EVENTS.includes(key as KnownEvent)) {
      unknownEvents.push(key);
      continue;
    }
    const canonical = canonicalEvent(key as KnownEvent);
    const list = parseHookList(key, value, warn);
    if (list !== undefined) out[canonical] = list;
  }
  if (unknownEvents.length > 0) {
    warn(`⚠️ settings：未知的 hook 事件已忽略（v1 支持 ${KNOWN_EVENTS.join(", ")}）：${unknownEvents.join(", ")}`);
  }
  return out;
}

function parseHookList(event: string, value: unknown, warn: HookWarn): readonly HookCommandConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    warn(`⚠️ .wudao/settings.json：hooks.${event} 应为数组——已忽略`);
    return undefined;
  }
  const commands: HookCommandConfig[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      warn(`⚠️ .wudao/settings.json：hooks.${event} 条目应为对象——该条目已跳过`);
      continue;
    }
    const record = item as Record<string, unknown>;
    // M63-C §3: the mcp_tool backend — {type:"mcp_tool", server, tool, input}.
    if (record["type"] === "mcp_tool") {
      if (typeof record["server"] !== "string" || typeof record["tool"] !== "string" || record["server"] === "" || record["tool"] === "") {
        warn(`⚠️ .wudao/settings.json：hooks.${event} 的 mcp_tool 条目需要 {server, tool} 字符串——该条目已跳过`);
        continue;
      }
      commands.push({
        type: "mcp_tool",
        server: record["server"] as string,
        tool: record["tool"] as string,
        ...(record["input"] !== null && typeof record["input"] === "object" && !Array.isArray(record["input"]) ? { input: record["input"] as Record<string, unknown> } : {}),
        ...parseCommonEntryFields(record),
      });
      continue;
    }
    if (typeof record["command"] !== "string") {
      warn(`⚠️ .wudao/settings.json：hooks.${event} 条目应为 {"command": string} 或 {"type":"mcp_tool", server, tool}——该条目已跳过`);
      continue;
    }
    commands.push({ command: record["command"] as string, ...parseCommonEntryFields(record) });
  }
  return commands;
}

/** The per-hook fields shared by both backends (timeoutMs/matcher + the
 *  M63-C once/if/async/asyncRewake/statusMessage). */
function parseCommonEntryFields(record: Record<string, unknown>): Partial<HookCommandConfig> {
  const rawTimeout = record["timeoutMs"];
  const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;
  const rawMatcher = record["matcher"];
  const matcher = typeof rawMatcher === "string" && rawMatcher.trim() !== "" ? rawMatcher : undefined;
  const str = (key: string): string | undefined => {
    const v = record[key];
    return typeof v === "string" && v.trim() !== "" ? v : undefined;
  };
  return {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(matcher !== undefined ? { matcher } : {}),
    ...(record["once"] === true ? { once: true } : {}),
    ...(str("if") !== undefined ? { if: str("if") } : {}),
    ...(record["async"] === true ? { async: true } : {}),
    ...(record["asyncRewake"] === true ? { asyncRewake: true } : {}),
    ...(str("statusMessage") !== undefined ? { statusMessage: str("statusMessage") } : {}),
  };
}

// ---------------------------------------------------------------------------
// Bridge
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M63-C — the shared fire runner: per-hook fields (once/if/async/asyncRewake/
// statusMessage), the mcp_tool backend, the §2 common stdin fields, and the
// systemMessage/suppressOutput output contract.
// ---------------------------------------------------------------------------

/** M63-C R1: the fire-runtime view type the frontends thread (the same
 *  option subset buildConfiguredHooks takes minus workspaceRoot/warn). */
export type NonNeverRuntime = {
  readonly getMode?: () => string;
  readonly common?: () => Record<string, unknown>;
  readonly mcp?: HookMcpSeam;
  readonly rewake?: (message: string) => void;
};

/** The mcp_tool backend's call seam (the frontend's MCP runtime). */
export interface HookMcpSeam {
  /** Call the named server's tool; ok carries the tool's text content (it is
   *  what decision parsing sees, like command stdout); !ok is a transport
   *  failure (the non-zero-exit semantics of the command backend). */
  call(server: string, tool: string, input: Record<string, unknown>): Promise<{ readonly ok: boolean; readonly text?: string; readonly error?: string }>;
}

/** Resolve ${dotted.path} references in an mcp_tool input's STRING values
 *  against the event payload (numbers/booleans/objects pass through; an
 *  unresolvable reference stays literal — visible, not silently empty). */
export function resolveTemplateValue(value: unknown, payload: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z0-9_.]+)\}/g, (whole, path: string) => {
      let cursor: unknown = payload;
      for (const seg of path.split(".")) {
        if (cursor !== null && typeof cursor === "object" && seg in (cursor as Record<string, unknown>)) {
          cursor = (cursor as Record<string, unknown>)[seg];
        } else {
          return whole; // unresolvable — keep the literal reference
        }
      }
      return typeof cursor === "string" ? cursor : JSON.stringify(cursor);
    });
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = resolveTemplateValue(v, payload);
    return out;
  }
  return value;
}

async function runMcpHook(entry: CompiledHook, payload: string, rt: HookFireRuntime): Promise<HookRun | undefined> {
  const mcp = entry.mcp!;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  const input = resolveTemplateValue(mcp.input, parsed) as Record<string, unknown>;
  try {
    const r = await rt.mcp!.call(mcp.server, mcp.tool, input);
    if (r.ok) return { code: 0, stdout: r.text ?? "", reason: "" };
    return { code: 1, stdout: "", reason: r.error ?? `mcp server ${mcp.server} failed` };
  } catch (err) {
    rt.warn(`⚠️ mcp_tool hook ${mcp.server}/${mcp.tool} 失败：${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

interface HookFireRuntime {
  readonly workspaceRoot: string;
  readonly warn: HookWarn;
  readonly firedOnce: Set<string>;
  readonly getMode?: () => string;
  readonly common?: () => Record<string, unknown>;
  readonly mcp?: HookMcpSeam;
  readonly rewake?: (message: string) => void;
}

type HookFire = (entry: CompiledHook, payload: string | Record<string, unknown>, opts?: { readonly promptClass?: boolean }) => Promise<HookRun | undefined>;

function createHookRunner(rt: HookFireRuntime): HookFire {
  const exec = async (entry: CompiledHook, payload: string, promptClass: boolean): Promise<HookRun | undefined> => {
    if (entry.mcp !== undefined) {
      if (rt.mcp === undefined) return undefined; // no MCP runtime wired — inert
      return runMcpHook(entry, payload, rt);
    }
    if (entry.command === undefined) return undefined;
    return runHookCommand(
      {
        command: entry.command,
        ...(entry.timeoutMs !== undefined ? { timeoutMs: entry.timeoutMs } : {}),
        ...(entry.pluginRoot !== undefined ? { pluginRoot: entry.pluginRoot } : {}),
      },
      payload,
      rt.workspaceRoot,
      rt.warn,
      promptClass ? { defaultTimeoutMs: PROMPT_HOOK_TIMEOUT_MS } : undefined,
    );
  };
  return async (entry, payloadInput, fireOpts) => {
    // §3 `if`: the permission-mode gate (exact value or list).
    if (entry.modeIf !== undefined) {
      const mode = rt.getMode?.() ?? "default";
      if (!entry.modeIf.includes(mode)) return undefined;
    }
    // §3 `once`: first applicable firing only (identity = command/mcp spec).
    if (entry.once === true && entry.identity !== undefined) {
      if (rt.firedOnce.has(entry.identity)) return undefined;
      rt.firedOnce.add(entry.identity);
    }
    // §2 common stdin fields ride every JSON payload (the RAW-prompt contract
    // of onPromptSubmit is load-bearing and stays raw — string payloads are
    // passed through untouched).
    const payload = typeof payloadInput === "string"
      ? payloadInput
      : JSON.stringify({ ...(rt.common?.() ?? {}), ...payloadInput });
    // §3 `async`: fire in the background — the event never waits, the output
    // cannot contribute a decision; exit 2 + asyncRewake hands the hook's
    // first stdout line to the rewake sink (the steering lane).
    if (entry.isAsync === true) {
      void (async () => {
        if (entry.statusMessage !== undefined) rt.warn(`⏳ ${entry.statusMessage}`);
        // R1 fix: async entries keep their CLASS default (a prompt-class
        // async hook gets the 30s default, not 600s).
        const run = await exec(entry, payload, fireOpts?.promptClass === true);
        if (entry.asyncRewake === true && run !== undefined && run.code === 2) {
          const message = firstLineOfText(run.stdout) || `${entry.command ?? entry.mcp?.tool ?? "hook"} requests attention`;
          rt.rewake?.(message);
        }
      })();
      return undefined;
    }
    return exec(entry, payload, fireOpts?.promptClass === true);
  };
}

function firstLineOfText(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  const i = t.indexOf("\n");
  return (i === -1 ? t : t.slice(0, i)).trim();
}

/** §2 output fields: surface a hook's user-facing systemMessage (warn sink)
 *  unless the SAME JSON sets suppressOutput (the CC display-suppression
 *  semantics applied to the hook's own chatter). */
function surfaceHookOutput(stdout: string, warn: (message: string) => void): void {
  const text = stdout.trim();
  if (text === "" || !text.startsWith("{")) return;
  try {
    const parsed = JSON.parse(text) as { systemMessage?: unknown; suppressOutput?: unknown };
    if (parsed.suppressOutput === true) return;
    if (typeof parsed.systemMessage === "string" && parsed.systemMessage !== "") {
      warn(`💬 ${parsed.systemMessage}`);
    }
  } catch {
    /* not JSON — nothing to surface */
  }
}

/** workspace-ux B2 review — the §2 common stdin fields, ONE builder for both
 *  compile sites (the module-level fire-runtime view and main()'s
 *  buildConfiguredHooks call — previously two duplicated object literals).
 *  `transcriptRoot` is the BOOT root (the entry's real root, where the session
 *  JSONL store lives) and is passed EXPLICITLY so a caller cannot silently
 *  hand the live agent root: an agentRootSwitch moves the agent's footing,
 *  never the store, and a payload naming the new root's nonexistent
 *  `<root>/.wudao/sessions/<id>.jsonl` would defeat the field's purpose. */
export function hookCommonFields(input: {
  /** The live session id; absent → no session_id/transcript_path at all. */
  readonly sessionId?: string;
  readonly promptId?: string;
  readonly permissionMode: string;
  /** Skipped when undefined or "" (the entry config's spelling). */
  readonly effort?: string;
  readonly transcriptRoot: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.sessionId !== undefined) {
    out.session_id = input.sessionId;
    out.transcript_path = join(input.transcriptRoot, ".wudao", "sessions", `${input.sessionId}.jsonl`);
  }
  if (input.promptId !== undefined) out.prompt_id = input.promptId;
  out.permission_mode = input.permissionMode;
  if (input.effort !== undefined && input.effort !== "") out.effort = input.effort;
  return out;
}

export function buildConfiguredHooks(
  settings: HooksSettings,
  opts: {
    readonly workspaceRoot: string;
    readonly warn?: HookWarn;
    /** M63-C §3: the live permission mode (the `if` field's gate). */
    readonly getMode?: () => string;
    /** M63-C §2: the common stdin fields (prompt_id/transcript_path/
     *  permission_mode/effort/agent_id/agent_type) — merged into every JSON
     *  payload at fire time. */
    readonly common?: () => Record<string, unknown>;
    /** M63-C §3: the mcp_tool backend's call seam. */
    readonly mcp?: HookMcpSeam;
    /** M63-C §3: the asyncRewake sink (exit 2 → the steering lane). */
    readonly rewake?: (message: string) => void;
  },
): AgentHooks | undefined {
  const promptHooks = settings.onPromptSubmit ?? [];
  const stopHooks = settings.onRunStop ?? [];
  const preHooks = settings.onPreToolUse ?? [];
  const postHooks = settings.onPostToolUse ?? [];
  const sessionStartHooks = settings.onSessionStart ?? [];
  const preCompactHooks = settings.onPreCompact ?? [];
  const postCompactHooks = settings.onPostCompact ?? [];
  const permissionHooks = settings.onPermissionRequest ?? [];
  const notificationHooks = settings.onNotification ?? [];
  const failureHooks = settings.onPostToolUseFailure ?? [];
  const batchHooks = settings.onPostToolBatch ?? [];
  const taskCreatedHooks = settings.onTaskCreated ?? [];
  const taskCompletedHooks = settings.onTaskCompleted ?? [];
  const subStartHooks = settings.onSubagentStart ?? [];
  const subStopHooks = settings.onSubagentStop ?? [];
  const teammateIdleHooks = settings.onTeammateIdle ?? [];
  const fileChangedHooks = settings.onFileChanged ?? [];
  const configChangeHooks = settings.onConfigChange ?? [];
  const instructionsHooks = settings.onInstructionsLoaded ?? [];
  const sessionEndHooks = settings.onSessionEnd ?? [];
  const stopFailureHooks = settings.onStopFailure ?? [];
  if (
    promptHooks.length === 0 && stopHooks.length === 0 && preHooks.length === 0 && postHooks.length === 0
    && sessionStartHooks.length === 0 && preCompactHooks.length === 0 && postCompactHooks.length === 0
    && permissionHooks.length === 0 && notificationHooks.length === 0 && failureHooks.length === 0 && batchHooks.length === 0
    && taskCreatedHooks.length === 0 && taskCompletedHooks.length === 0 && subStartHooks.length === 0 && subStopHooks.length === 0
    && teammateIdleHooks.length === 0
    && fileChangedHooks.length === 0 && configChangeHooks.length === 0 && instructionsHooks.length === 0 && sessionEndHooks.length === 0
    && stopFailureHooks.length === 0
  ) return undefined;

  const { workspaceRoot } = opts;
  const warn = opts.warn ?? defaultWarn;
  const fire = createHookRunner({
    workspaceRoot,
    warn,
    firedOnce: new Set<string>(),
    ...(opts.getMode !== undefined ? { getMode: opts.getMode } : {}),
    ...(opts.common !== undefined ? { common: opts.common } : {}),
    ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}),
    ...(opts.rewake !== undefined ? { rewake: opts.rewake } : {}),
  });
  const hooks: AgentHooks = {};

  if (promptHooks.length > 0) {
    const compiled = compileHookList(promptHooks, warn, "promptHooks");
    hooks.onPromptSubmit = async (prompt: string): Promise<string | { block: true; reason: string }> => {
      let current = prompt;
      for (const cmd of applicableHooks(compiled, undefined)) {
        const run = await fire(cmd, current, { promptClass: true });
        if (run === undefined) continue; // timeout / spawn error → allow/original
        if (run.code !== 0) return { block: true, reason: run.reason };
        // M63-A §2: the JSON block spelling — stdout {"block":true,
        // "blockReason"|"reason"} blocks WITHOUT rewriting (plain non-JSON
        // stdout stays the M19 rewrite contract).
        const block = parseBlockJsonLine(run.stdout);
        if (block !== undefined) return block;
        const out = run.stdout.trim();
        if (out) current = out; // subsequent hooks receive the rewritten prompt
      }
      return current;
    };
  }

  if (stopHooks.length > 0) {
    // M61 §3: prompt-based Stop-hook contract — a hook may answer on stdout
    // with JSON: {"continue": false} blocks the stop (one more turn; optional
    // "reason"), anything else allows. The loop's block cap still bounds
    // no-tool continuation spirals.
    const compiled = compileHookList(stopHooks, warn, "stopHooks");
    hooks.onRunStop = async (state: AgentState): Promise<StopHookDecision> => {
      const base = stopPayload(state);
      for (const cmd of applicableHooks(compiled, undefined)) {
        const run = await fire(cmd, base, { promptClass: true });
        if (run === undefined) continue; // timeout / spawn error → allow
        if (run.code !== 0) return { block: true, reason: run.reason };
        const decision = parseStopHookJson(run.stdout);
        if (decision !== undefined) return decision;
      }
      return "allow";
    };
  }

  // M33 §2: interceptor semantics — a command blocks via a non-zero exit
  // (reason = stderr first line) OR a stdout first line of
  // {"block":true,"reason":…}. Plain/absent stdout means observe-only: the
  // tool call proceeds (output is never treated as a rewrite).
  if (preHooks.length > 0) {
    const compiled = compileHookList(preHooks, warn, "preHooks");
    hooks.onPreToolUse = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<import("@wudao-org/core").PreToolUseDecision> => {
      const base = { event: "preToolUse", tool: toolName, input };
      for (const cmd of applicableHooks(compiled, toolName)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → no block
        surfaceHookOutput(run.stdout, warn);
        if (run.code !== 0) return { block: true, reason: run.reason };
        const json = parseBlockJsonLine(run.stdout);
        if (json !== undefined) return json;
        // M63-C §2: the EXPLICIT rewrite contract — {"updatedInput":{…}}
        // replaces the call's arguments (validation and execution see the
        // rewritten input).
        const updated = parseUpdatedInputJson(run.stdout);
        if (updated !== undefined) return { updatedInput: updated };
      }
      return undefined;
    };
  }

  // M63-C §3: preToolUse/postToolUse now honor the tool-name matcher (the
  // CC dimension — the skill/subagent positions declare per-tool hooks; a
  // matcherless entry still fires for every tool).
  // M33 §2: observer semantics — commands run with the result payload on
  // stdin; exit codes and output are ignored (post hooks never block).
  // M62 §5 additionalContext: a hook exiting 0 whose stdout parses as
  // {"hookSpecificOutput":{"additionalContext":"…"}} contributes that string
  // as CONTEXT — the loop projects it at the next model call (suffix after
  // the last tool result, cache-safe). PLAIN stdout is NOT context (log
  // only, the pre-M62 behavior); exit≠0 is never parsed.
  if (postHooks.length > 0) {
    const compiled = compileHookList(postHooks, warn, "postHooks");
    hooks.onPostToolUse = async (toolName: string, input: Record<string, unknown>, result: string): Promise<void | string> => {
      const base = { event: "postToolUse", tool: toolName, input, result };
      let context = "";
      for (const cmd of applicableHooks(compiled, toolName)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → observe only
        surfaceHookOutput(run.stdout, warn);
        if (run.code !== 0) continue; // M62 §5: a failing hook never injects
        const ctx = parseAdditionalContext(run.stdout);
        if (ctx !== undefined) context = context === "" ? ctx : `${context}\n\n${ctx}`;
      }
      return context === "" ? undefined : capAdditionalContext(context);
    };
  }

  // -------------------------------------------------------------------------
  // M63-A batch A events
  // -------------------------------------------------------------------------

  // SessionStart (matcher: startup|resume|clear|compact|fork). cc-plugins E4:
  // CC's SessionStart is a CONTEXT hook — a command exiting 0 whose stdout
  // parses as {"hookSpecificOutput":{"additionalContext":"…"}} RETURNS that
  // string (the superpowers bootstrap's whole purpose); the driver parks it
  // on the MetaNote projection. Same house rules as M62 §5 postToolUse:
  // plain stdout is NOT context (log only), a failing hook never injects,
  // 8k cap, entries and layers chain with a blank line.
  if (sessionStartHooks.length > 0) {
    const compiled = compileHookList(sessionStartHooks, warn, "sessionStartHooks");
    hooks.onSessionStart = async (source: SessionStartSource, info: { readonly sessionId?: string }): Promise<void | string> => {
      const base = { event: "sessionStart", source, ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}) };
      let context = "";
      for (const cmd of applicableHooks(compiled, source)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → observe only
        surfaceHookOutput(run.stdout, warn);
        if (run.code !== 0) continue; // a failing hook never injects
        const ctx = parseAdditionalContext(run.stdout);
        if (ctx !== undefined) context = context === "" ? ctx : `${context}\n\n${ctx}`;
      }
      return context === "" ? undefined : capAdditionalContext(context);
    };
  }

  // PreCompact (matcher: manual|auto) — blocking in the DEFER direction.
  // {"defer":true[,"reason"]} on stdout, or a non-zero exit (reason = stderr
  // first line), defers THIS compaction. Timeout/spawn error → compact anyway.
  if (preCompactHooks.length > 0) {
    const compiled = compileHookList(preCompactHooks, warn, "preCompactHooks");
    hooks.onPreCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<PreCompactDecision> => {
      const base = { event: "preCompact", trigger, messageCount: messages.length };
      for (const cmd of applicableHooks(compiled, trigger)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → compact anyway
        if (run.code !== 0) return { defer: true, reason: run.reason !== "" ? run.reason : "deferred by preCompact hook" };
        const d = parseDeferJson(run.stdout);
        if (d !== undefined) return d;
      }
      return "compact";
    };
  }

  // PostCompact (matcher: manual|auto) — observer.
  if (postCompactHooks.length > 0) {
    const compiled = compileHookList(postCompactHooks, warn, "postCompactHooks");
    hooks.onPostCompact = async (messages: readonly AgentMessage[], trigger: "manual" | "auto"): Promise<void> => {
      const base = { event: "postCompact", trigger, messageCount: messages.length };
      for (const cmd of applicableHooks(compiled, trigger)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  // PermissionRequest (matcher: tool name) — the deterministic policy engine.
  // stdout {"decision":"allow"|"deny"[,"reason"]} answers the request; a
  // non-zero exit DENIES (a configured policy hook failing is fail-closed —
  // same posture as a blocking preToolUse). Timeout/spawn error → no opinion
  // (the pipeline continues; the M19 infra-failure posture).
  // ω99-21: a denyOnly entry's ALLOW is no opinion — hooks from agent-writable
  // sources may only narrow (deny), never authorize; the pipeline falls back
  // to its own decision (an ask stays an ask).
  if (permissionHooks.length > 0) {
    const compiled = compileHookList(permissionHooks, warn, "permissionHooks");
    hooks.onPermissionRequest = async (toolName: string, input: Record<string, unknown>): Promise<PermissionDecision | undefined> => {
      const base = { event: "permissionRequest", tool: toolName, input };
      for (const cmd of applicableHooks(compiled, toolName)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // infra failure → no opinion
        surfaceHookOutput(run.stdout, warn);
        if (run.code !== 0) return { behavior: "deny", ...(run.reason !== "" ? { reason: `permission hook: ${run.reason}` } : {}) };
        const d = parsePermissionDecisionJson(run.stdout);
        if (d === undefined) continue;
        if (d.behavior === "allow" && cmd.denyOnly === true) continue; // ω99-21: deny-only allow = no opinion
        return d;
      }
      return undefined;
    };
  }

  // Notification (matcher: permission|idle) — observer.
  if (notificationHooks.length > 0) {
    const compiled = compileHookList(notificationHooks, warn, "notificationHooks");
    hooks.onNotification = async (kind: NotificationKind, info: { readonly sessionId?: string }): Promise<void> => {
      const base = { event: "notification", kind, ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}) };
      for (const cmd of applicableHooks(compiled, kind)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  // PostToolUseFailure (matcher: tool name) — observer, the failure face.
  if (failureHooks.length > 0) {
    const compiled = compileHookList(failureHooks, warn, "failureHooks");
    hooks.onPostToolUseFailure = async (toolName: string, input: Record<string, unknown>, result: string): Promise<void> => {
      const base = { event: "postToolUseFailure", tool: toolName, input, result };
      for (const cmd of applicableHooks(compiled, toolName)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  // PostToolBatch (no matcher) — {"continue":false[,"reason"]} on stdout, or
  // a non-zero exit, ends the run at the batch boundary (the Stop-hook
  // spelling). Timeout/spawn error → allow.
  if (batchHooks.length > 0) {
    const compiled = compileHookList(batchHooks, warn, "batchHooks");
    hooks.onPostToolBatch = async (batch: readonly PostToolBatchCall[]): Promise<PostToolBatchDecision> => {
      const base = { event: "postToolBatch", calls: batch.map((c) => ({ tool: c.name, isError: c.isError })) };
      for (const cmd of applicableHooks(compiled, undefined)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → allow
        if (run.code !== 0) return { continue: false, ...(run.reason !== "" ? { reason: run.reason } : {}) };
        const d = parseContinueFalseJson(run.stdout);
        if (d !== undefined) return d;
      }
      return "allow";
    };
  }

  // -------------------------------------------------------------------------
  // M63-B batch B events
  // -------------------------------------------------------------------------

  // TaskCreated / TaskCompleted (no matcher) — {block[,blockReason]} on
  // stdout or a non-zero exit refuses the todo_write; timeout/spawn error
  // degrades to allow (fail-open — the M19 posture for gate hooks).
  const buildTaskHook = (
    list: readonly HookCommandConfig[],
  ): ((items: readonly string[], board: { readonly total: number; readonly done: number }) => Promise<TaskHookDecision>) | undefined => {
    if (list.length === 0) return undefined;
    const compiled = compileHookList(list, warn);
    return async (items, board) => {
      if (items.length === 0) return "allow";
      const base = { event: "taskTransition", items, board };
      for (const cmd of applicableHooks(compiled, undefined)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → allow
        if (run.code !== 0) return { block: true, ...(run.reason !== "" ? { reason: run.reason } : {}) };
        const block = parseBlockJsonLine(run.stdout);
        if (block !== undefined) return { block: true, reason: block.reason };
      }
      return "allow";
    };
  };
  const taskCreated = buildTaskHook(taskCreatedHooks);
  if (taskCreated !== undefined) hooks.onTaskCreated = taskCreated;
  const taskCompleted = buildTaskHook(taskCompletedHooks);
  if (taskCompleted !== undefined) hooks.onTaskCompleted = taskCompleted;

  // SubagentStart (matcher: agent type) — observer.
  if (subStartHooks.length > 0) {
    const compiled = compileHookList(subStartHooks, warn, "subStartHooks");
    hooks.onSubagentStart = async (agentType: string, info: { readonly sessionId?: string }): Promise<void> => {
      const base = { event: "subagentStart", agentType, ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}) };
      for (const cmd of applicableHooks(compiled, agentType)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  // SubagentStop (matcher: agent type) — {"continue":false} or {"block"} on
  // stdout, or a non-zero exit, keeps the child working one more turn (the
  // Stop contract; the child loop's block cap bounds it). Timeout/spawn
  // error → allow the stop.
  if (subStopHooks.length > 0) {
    const compiled = compileHookList(subStopHooks, warn, "subStopHooks");
    hooks.onSubagentStop = async (agentType: string): Promise<import("@wudao-org/core").SubagentStopDecision> => {
      const base = { event: "subagentStop", agentType };
      for (const cmd of applicableHooks(compiled, agentType)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → allow
        if (run.code !== 0) return { continue: false, ...(run.reason !== "" ? { reason: run.reason } : {}) };
        const d = parseContinueFalseJson(run.stdout) ?? parseBlockJsonStop(run.stdout);
        if (d !== undefined) return d;
      }
      return "allow";
    };
  }

  // TeammateIdle (matcher: teammate name) — M64-C §C. Exit 2 or
  // {"continue":true,"feedback"} continues the idle teammate with the
  // feedback; anything else → the teammate stays idle.
  if (teammateIdleHooks.length > 0) {
    const compiled = compileHookList(teammateIdleHooks, warn, "teammateIdleHooks");
    hooks.onTeammateIdle = async (agent: string, infoIn: { readonly error?: string } = {}): Promise<import("@wudao-org/core").TeammateIdleDecision> => {
      const base = { event: "teammateIdle", agent, ...(infoIn.error !== undefined ? { error: infoIn.error } : {}) };
      for (const cmd of applicableHooks(compiled, agent)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue; // timeout / spawn error → stays idle
        if (run.code === 2) {
          const feedback = firstLine(run.stdout) || run.reason || "teammate idle hook requests continuation";
          return { continue: true, feedback };
        }
        if (run.code !== 0) return { continue: false };
        const d = parseTeammateContinueJson(run.stdout);
        if (d !== undefined) return d;
      }
      return { continue: false };
    };
  }

  // FileChanged (matcher: literal filename) — observer. The watcher itself is
  // built from the plain matcher values (see fileChangeTargets); this
  // runner is what a detected change fires.
  if (fileChangedHooks.length > 0) {
    const compiled = compileHookList(fileChangedHooks, warn, "fileChangedHooks");
    hooks.onFileChanged = async (path: string): Promise<void> => {
      const base = { event: "fileChanged", path };
      for (const cmd of applicableHooks(compiled, path)) {
        const run = await fire(cmd, base);
        if (run !== undefined) surfaceHookOutput(run.stdout, warn);
      }
    };
  }

  // ConfigChange (matcher: user|project|local|skills) — {"block"} or a
  // non-zero exit VETOES the change at the consumer; timeout/spawn error →
  // allow (infra failure must not brick the hot reload).
  if (configChangeHooks.length > 0) {
    const compiled = compileHookList(configChangeHooks, warn, "configChangeHooks");
    hooks.onConfigChange = async (position: ConfigChangePosition, info: { readonly path?: string }): Promise<import("@wudao-org/core").ConfigChangeDecision> => {
      const base = { event: "configChange", position, ...(info.path !== undefined ? { path: info.path } : {}) };
      for (const cmd of applicableHooks(compiled, position)) {
        const run = await fire(cmd, base);
        if (run === undefined) continue;
        if (run.code !== 0) return { block: true, ...(run.reason !== "" ? { reason: run.reason } : {}) };
        const block = parseBlockJsonLine(run.stdout);
        if (block !== undefined) return { block: true, reason: block.reason };
      }
      return "allow";
    };
  }

  // InstructionsLoaded (matcher: the source word) — observer.
  if (instructionsHooks.length > 0) {
    const compiled = compileHookList(instructionsHooks, warn, "instructionsHooks");
    hooks.onInstructionsLoaded = async (source: InstructionsLoadedSource, info: { readonly detail?: string }): Promise<void> => {
      const base = { event: "instructionsLoaded", source, ...(info.detail !== undefined ? { detail: info.detail } : {}) };
      for (const cmd of applicableHooks(compiled, source)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  // SessionEnd (matcher: clear|resume|exit|other) — observer with the SHARED
  // 1.5s budget: every command's effective timeout is capped by the time
  // REMAINING in the window; the window's expiry kills whatever is still
  // running (execFile's timeout kill) and skips the rest.
  if (sessionEndHooks.length > 0) {
    const compiled = compileHookList(sessionEndHooks, warn, "sessionEndHooks");
    hooks.onSessionEnd = async (source: SessionEndSource, info: { readonly sessionId?: string; readonly budgetEndsAt?: number }): Promise<void> => {
      // R1 fix: ONE deadline per FIRING (threaded by the firing site through
      // every composed layer) — absent only for direct callers, who get their
      // own window.
      const deadline = info.budgetEndsAt ?? Date.now() + SESSION_END_BUDGET_MS;
      const base = { event: "sessionEnd", source, ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}) };
      for (const cmd of applicableHooks(compiled, source)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          warn(`⚠️ sessionEnd hook 预算（${SESSION_END_BUDGET_MS}ms）已耗尽——'${cmd.command}' 已跳过`);
          continue;
        }
        // The budget caps the entry's OWN timeout (a CompiledHook spread —
        // once/if/async already ran at applicableHooks/fire level).
        // R1: BOTH classes are bounded by the shared budget — async entries
        // too (a background execFile would otherwise hold process exit until
        // its own 600s timeout; the spread caps its kill at the deadline).
        const budgeted: CompiledHook = { ...cmd, timeoutMs: Math.min(cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS, remaining) };
        if (cmd.isAsync === true) {
          // Async: fire returns immediately (legitimate undefined) — no
          // budget warning here; the background kill is bounded above.
          await fire(budgeted, base);
          continue;
        }
        const run = await fire(budgeted, base);
        if (run === undefined) {
          // R1: honest cause split — undefined for a SYNC entry is a timeout
          // (runHookCommand already warned "timed out") or a spawn failure;
          // once/if skips never reach here (the runner filters before exec).
          warn(`⚠️ sessionEnd hook '${cmd.command}' 未完成（超时/启动失败）——共享 ${SESSION_END_BUDGET_MS}ms 预算继续`);
          continue;
        }
      }
    };
  }

  // StopFailure (matcher: context|error) — observer.
  if (stopFailureHooks.length > 0) {
    const compiled = compileHookList(stopFailureHooks, warn, "stopFailureHooks");
    hooks.onStopFailure = async (kind: StopFailureKind, info: { readonly message?: string; readonly sessionId?: string }): Promise<void> => {
      const base = { event: "stopFailure", kind, ...(info.message !== undefined ? { message: info.message } : {}), ...(info.sessionId !== undefined ? { sessionId: info.sessionId } : {}) };
      for (const cmd of applicableHooks(compiled, kind)) {
        await fire(cmd, base); // observer: outcome ignored
      }
    };
  }

  return hooks;
}

function stopPayload(state: AgentState): Record<string, unknown> {
  let lastAssistant: string | undefined;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const m = state.messages[i];
    if (m?.role === "assistant") {
      lastAssistant = m.content;
      break;
    }
  }
  return { event: "onRunStop", messageCount: state.messages.length, lastAssistant };
}
