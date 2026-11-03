// ω99-4c — lint/test 反射回路 (aider's reflected_message, wudao wiring).
//
// After an edit/write lands, run the configured lint; when a run that edited
// files tries to stop, run the configured test. Failing output is fed back to
// the model — lint via onPostToolUse's M62 additionalContext channel (a
// <system_note> projected at the NEXT model call, cache-safe, history clean),
// test via onRunStop's {block:true,reason} (one more turn with the output as
// the reason; the loop's stall guard caps continuation spirals). The note's
// "harness 已运行 <cmd>（不要自己再跑）" wording steers the model away from
// re-running the command itself.
//
// Negative rulings (documented, deliberately NOT ported from aider):
//   1. NO system-prompt change — the injected note already tells the model
//      the harness ran the command; touching prompt.ts over one sentence is
//      not worth a prefix-cache break (§4 prefix byte stability).
//   2. NO interactive "Attempt to fix?" confirm — headless entry + auto
//      discipline: configured = reflect automatically; maxRounds is the cap.
//   3. NO auto_commit — git belongs to git-safety's existing semantics.
//
// Command execution follows the M19 hooks-config bridge contract: execFile,
// NO shell (quote-aware tokenizer), cwd=workspaceRoot, timeout, scrubbed env.
// Everything fails OPEN — reflection is a bonus, never a gate: timeout /
// spawn failure / any internal error resolves to void (lint) or "allow"
// (test). Default OFF: no `reflect` node (or WUDAO_REFLECT=off) → no hooks
// mounted, byte-zero change. Command values never reach the warn sink.
import { truncateSafe, truncateTailSafe } from "@wudao-org/core"; // 113-A4
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { AgentHooks, AgentState } from "@wudao-org/core";
import { resolveWorkspacePath } from "@wudao-org/core";
import { composeAgentHooks, tokenizeCommand } from "./hooks-config.js";
import { loadLayeredSettings } from "./settings-layer.js";

// ---------------------------------------------------------------------------
// Settings + loader (long-task-config's contract)
// ---------------------------------------------------------------------------

export interface ReflectSettings {
  /** Lint after edit/write lands. `${file}` in the command is replaced with
   *  the workspace-relative path (one run per file); without it the command
   *  runs ONCE per tool batch on the first triggering file. */
  readonly lint?: { readonly command: string; readonly timeoutMs?: number };
  /** Test at run stop (only when this run edited/wrote a workspace file). */
  readonly test?: { readonly command: string; readonly timeoutMs?: number };
  /** Reflection round cap per run; lint and test count SEPARATELY. */
  readonly maxRounds: number;
}

/** The assembled runtime — `hooks` is what the loop seams consume. */
export interface ReflectRuntime {
  readonly hooks: AgentHooks;
  /** Diagnostics/config identity only — NEVER logged (red line). */
  readonly lintCommand?: string;
  readonly testCommand?: string;
}

export const DEFAULT_REFLECT_ROUNDS = 2;
const DEFAULT_LINT_TIMEOUT_MS = 30_000;
const DEFAULT_TEST_TIMEOUT_MS = 180_000;

export type ReflectWarn = (message: string) => void;

function defaultWarn(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Parse one command node (lint|test): {command, timeoutMs?}. Undefined =
 *  not configured / rejected (warned) — never fatal. */
function parseCommandNode(
  value: unknown,
  warn: ReflectWarn,
  label: "lint" | "test",
): { readonly command: string; readonly timeoutMs?: number } | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warn(`⚠️ .wudao/settings.json: reflect.${label} must be an object; ${label} reflection disabled`);
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "command" && k !== "timeoutMs");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown reflect.${label} key(s) ignored: ${unknown.join(", ")}`);
  }
  const rawCommand = record["command"];
  const commandOk = typeof rawCommand === "string" && rawCommand.trim() !== "";
  if (!commandOk && rawCommand !== undefined) {
    warn(`⚠️ .wudao/settings.json: reflect.${label}.command must be a non-empty string; ${label} reflection disabled`);
  }
  // Per-field fallback: validate timeoutMs even when the command was
  // rejected, so every wrong field gets its own warning.
  const rawTimeout = record["timeoutMs"];
  const okTimeout = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0;
  if (rawTimeout !== undefined && !okTimeout) {
    warn(`⚠️ .wudao/settings.json: reflect.${label}.timeoutMs must be a positive number; default applied`);
  }
  if (!commandOk) return undefined;
  return { command: rawCommand as string, ...(okTimeout ? { timeoutMs: rawTimeout as number } : {}) };
}

/** Load the `reflect` node. Undefined = feature OFF (missing/empty node,
 *  neither command configured, or WUDAO_REFLECT=off). */
export async function loadReflectSettings(
  workspaceRoot: string,
  warn: ReflectWarn = defaultWarn,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ReflectSettings | undefined> {
  if ((env["WUDAO_REFLECT"] ?? "").trim() === "off") return undefined;
  const layered = await loadLayeredSettings(workspaceRoot, warn, env);
  const node = layered.effective["reflect"];
  if (node === undefined) return undefined;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    warn('⚠️ .wudao/settings.json: "reflect" must be an object; reflect disabled');
    return undefined;
  }
  const record = node as Record<string, unknown>;
  const unknown = Object.keys(record).filter((k) => k !== "lint" && k !== "test" && k !== "maxRounds");
  if (unknown.length > 0) {
    warn(`⚠️ .wudao/settings.json: unknown reflect key(s) ignored: ${unknown.join(", ")}`);
  }
  const lint = parseCommandNode(record["lint"], warn, "lint");
  const test = parseCommandNode(record["test"], warn, "test");
  let maxRounds = DEFAULT_REFLECT_ROUNDS;
  const rawRounds = record["maxRounds"];
  if (rawRounds !== undefined) {
    if (typeof rawRounds === "number" && Number.isInteger(rawRounds) && rawRounds > 0) maxRounds = rawRounds;
    else warn(`⚠️ .wudao/settings.json: reflect.maxRounds must be a positive integer; default (${DEFAULT_REFLECT_ROUNDS}) applied`);
  }
  // No commands → nothing to reflect; maxRounds alone is meaningless.
  if (lint === undefined && test === undefined) return undefined;
  return { ...(lint !== undefined ? { lint } : {}), ...(test !== undefined ? { test } : {}), maxRounds };
}

// ---------------------------------------------------------------------------
// The exec seam (M19 bridge contract: execFile, no shell, cwd, timeout)
// ---------------------------------------------------------------------------

export interface ReflectRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** One command execution. Undefined = timeout / spawn failure / internal
 *  error — the fail-open resolution at every call site. */
export type ReflectExec = (
  file: string,
  args: readonly string[],
  opts: { readonly cwd: string; readonly timeoutMs: number },
) => Promise<ReflectRun | undefined>;

const MAX_REFLECT_OUTPUT_BYTES = 1_000_000; // hooks-config parity

// Same scrub as the M19 bridge (shell's discipline): credential-shaped
// env vars never reach a reflect subprocess. Duplicated here so this module
// never churns hooks-config's exports.
const SENSITIVE_SUFFIX = /(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i;
const SENSITIVE_PREFIX = /^(WUDAO_|OPENAI_)/;

function reflectScrubbedEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_SUFFIX.test(k) || SENSITIVE_PREFIX.test(k)) continue;
    childEnv[k] = v;
  }
  return childEnv;
}

/** The default exec backend. Warnings NEVER carry the command value (the
 *  ω99-4c red line) — only the kind label and the error class/duration. */
export function createDefaultReflectExec(label: "lint" | "test", warn: ReflectWarn = defaultWarn): ReflectExec {
  return (file, args, opts) =>
    new Promise<ReflectRun | undefined>((resolveRun) => {
      const settle = (run: ReflectRun | undefined): void => resolveRun(run);
      try {
        execFile(
          file,
          [...args],
          { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: MAX_REFLECT_OUTPUT_BYTES, encoding: "utf8", env: reflectScrubbedEnv(), windowsHide: true },
          (err, stdout, stderr) => {
            const out = typeof stdout === "string" ? stdout : "";
            const errOut = typeof stderr === "string" ? stderr : "";
            if (err) {
              const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
              const timedOut = e.killed === true && (e.signal === "SIGTERM" || /timed out/i.test(e.message));
              if (timedOut) {
                warn(`⚠️ [reflect:${label}] command timed out after ${opts.timeoutMs}ms; continuing`);
                settle(undefined);
                return;
              }
              if (typeof e.code === "number") {
                settle({ code: e.code, stdout: out, stderr: errOut });
                return;
              }
              warn(`⚠️ [reflect:${label}] command failed to start (${e.code ?? e.name ?? "unknown"}); continuing`);
              settle(undefined);
              return;
            }
            settle({ code: 0, stdout: out, stderr: errOut });
          },
        );
      } catch (e) {
        warn(`⚠️ [reflect:${label}] command failed to start (${(e as NodeJS.ErrnoException).code ?? (e as Error).name}); continuing`);
        settle(undefined);
      }
    });
}

/** Tokenize + exec one command string. Empty argv → undefined (skipped). */
async function runReflectCommand(
  command: string,
  workspaceRoot: string,
  timeoutMs: number,
  exec: ReflectExec,
): Promise<ReflectRun | undefined> {
  const argv = tokenizeCommand(command);
  const file = argv[0];
  if (file === undefined || file === "") return undefined;
  return exec(file, argv.slice(1), { cwd: workspaceRoot, timeoutMs });
}

// ---------------------------------------------------------------------------
// Output shaping + note wording
// ---------------------------------------------------------------------------

export const REFLECT_OUTPUT_CAP_CHARS = 6_000;
const REFLECT_OUTPUT_HEAD = 4_000;
const REFLECT_OUTPUT_TAIL = 2_000;
const REFLECT_TRUNCATION_MARK = "…(truncated)…";

/** Cap merged command output: head 4000 + mark + tail 2000 (the brief's
 *  exact budget). Short text passes through unchanged. */
export function capReflectOutput(text: string): string {
  if (text.length <= REFLECT_OUTPUT_CAP_CHARS) return text;
  return truncateSafe(text, REFLECT_OUTPUT_HEAD) + REFLECT_TRUNCATION_MARK + truncateTailSafe(text, REFLECT_OUTPUT_TAIL);
}

function mergedOutput(run: ReflectRun): string {
  return [run.stdout, run.stderr].filter((s) => s !== "").join("\n");
}

// ---------------------------------------------------------------------------
// Runtime builder
// ---------------------------------------------------------------------------

export interface ReflectBuildOpts {
  readonly workspaceRoot: string;
  readonly warn?: ReflectWarn;
  /** Test seam — the scripted fake execFile. Defaults to the execFile
   *  backend (one labeled instance per command kind). */
  readonly exec?: ReflectExec;
}

/** Assemble the reflect hooks. Undefined = OFF (no settings / no commands) —
 *  callers thread undefined and their hook wiring stays byte-identical. */
export function buildReflectRuntime(
  settings: ReflectSettings | undefined,
  opts: ReflectBuildOpts,
): ReflectRuntime | undefined {
  if (settings === undefined) return undefined;
  const lint = settings.lint;
  const test = settings.test;
  if (lint === undefined && test === undefined) return undefined;
  const { workspaceRoot } = opts;
  const warn = opts.warn ?? defaultWarn;
  const lintExec = opts.exec ?? createDefaultReflectExec("lint", warn);
  const testExec = opts.exec ?? createDefaultReflectExec("test", warn);
  const lintTimeoutMs = lint?.timeoutMs ?? DEFAULT_LINT_TIMEOUT_MS;
  const testTimeoutMs = test?.timeoutMs ?? DEFAULT_TEST_TIMEOUT_MS;
  const maxRounds = settings.maxRounds;
  // resolveWorkspacePath anchors its result at the REAL root, so the
  // rel-path anchor must be realpath'd too — a symlinked workspaceRoot
  // (/var → /private/var on macOS) would otherwise yield ../../ garbage.
  let rootAbs = resolve(workspaceRoot);
  try {
    rootAbs = realpathSync(workspaceRoot);
  } catch {
    /* keep the lexical root */
  }

  // Per-process mutable state. Per-RUN counters (lint injections, test
  // blocks, the cap warning) reset at onRunStart; the batch dedup state
  // resets at onPostToolBatch; hasEditedFiles survives batch boundaries
  // (the brief's sticky simplification) and resets at run start.
  const state = {
    lintedInBatch: new Set<string>(),
    batchLintRan: false,
    hasEditedFiles: false,
    lintInjections: 0,
    testBlocks: 0,
    testCapWarned: false,
  };

  const hooks: AgentHooks = {
    onRunStart: async (_state: AgentState): Promise<void> => {
      state.lintedInBatch.clear();
      state.batchLintRan = false;
      state.hasEditedFiles = false;
      state.lintInjections = 0;
      state.testBlocks = 0;
      state.testCapWarned = false;
    },
    // The lint trigger face. Also the edit/write landing sensor for test
    // reflection (the M62 seam carries no isError flag; a failed edit call
    // arms the run too — the round caps bound the cost of that generosity).
    onPostToolUse: async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<void | string> => {
      try {
        if (toolName !== "edit" && toolName !== "write_file") return undefined;
        const rawPath = typeof input["path"] === "string"
          ? input["path"]
          : typeof input["file_path"] === "string"
            ? input["file_path"]
            : undefined;
        if (rawPath === undefined || rawPath === "") return undefined;
        const resolved = await resolveWorkspacePath(workspaceRoot, rawPath);
        if (!resolved.ok) return undefined; // outside the workspace → skip
        const rel = relative(rootAbs, resolved.absPath);
        if (rel === "") return undefined;
        if (test !== undefined) state.hasEditedFiles = true;
        if (lint === undefined) return undefined;
        if (state.lintInjections >= maxRounds) return undefined; // silent round cap
        const hasFileToken = lint.command.includes("${file}");
        if (hasFileToken) {
          if (state.lintedInBatch.has(rel)) return undefined;
          state.lintedInBatch.add(rel);
        } else {
          if (state.batchLintRan) return undefined;
          state.batchLintRan = true;
        }
        const cmd = hasFileToken ? lint.command.replaceAll("${file}", rel) : lint.command;
        const run = await runReflectCommand(cmd, workspaceRoot, lintTimeoutMs, lintExec);
        if (run === undefined) return undefined; // fail-open
        if (run.code === 0) return undefined; // clean → no note
        state.lintInjections += 1;
        return `[reflect:lint] harness 已对 ${rel} 运行 \`${cmd}\`（不要自己再跑），发现以下问题，请在继续前修复：\n${capReflectOutput(mergedOutput(run))}`;
      } catch {
        return undefined; // fail-open — never break the tool batch
      }
    },
    // Pure state reset (observer usage): the batch landed, re-arm dedup.
    onPostToolBatch: async (): Promise<"allow"> => {
      state.lintedInBatch.clear();
      state.batchLintRan = false;
      return "allow";
    },
    // The test reflection: block the stop ONCE per failing test round and
    // feed the output back as the reason. Everything but a real failing run
    // resolves "allow" (fail-open); the round cap eventually lets the run
    // stop even with red tests (one warning, command value never logged).
    onRunStop: async (_state: AgentState): Promise<import("@wudao-org/core").StopHookDecision> => {
      try {
        if (test === undefined) return "allow";
        if (!state.hasEditedFiles) return "allow";
        if (state.testBlocks >= maxRounds) {
          if (!state.testCapWarned) {
            state.testCapWarned = true;
            warn(`⚠️ [reflect:test] round cap (${maxRounds}) reached — allowing the stop; tests may still be failing`);
          }
          return "allow";
        }
        const run = await runReflectCommand(test.command, workspaceRoot, testTimeoutMs, testExec);
        if (run === undefined) return "allow"; // fail-open
        if (run.code === 0) return "allow";
        state.testBlocks += 1;
        return {
          block: true,
          reason: `[reflect:test] harness 已运行 \`${test.command}\`（不要自己再跑），发现以下问题，请在继续前修复：\n${capReflectOutput(mergedOutput(run))}`,
        };
      } catch {
        return "allow"; // fail-open
      }
    },
  };

  return {
    hooks,
    ...(lint !== undefined ? { lintCommand: lint.command } : {}),
    ...(test !== undefined ? { testCommand: test.command } : {}),
  };
}

// ---------------------------------------------------------------------------
// Composition + the process-level loader seam
// ---------------------------------------------------------------------------

/** Compose reflect INNERMOST (last-consulted): composeAgentHooks semantics
 *  mean a non-allow from the existing chain wins and reflect's onRunStop is
 *  never even consulted — a user/skill/goal hook's "continue" (allow) always
 *  outranks the reflection's block; reflect may block only when everything
 *  else allowed. Reflect undefined → base returned UNCHANGED (byte-zero). */
export function composeReflectHooks(
  base: AgentHooks | undefined,
  reflect: ReflectRuntime | undefined,
): AgentHooks | undefined {
  if (reflect === undefined) return base;
  return composeAgentHooks(base, reflect.hooks);
}

/** The process-level singleton: the loop seams (repl / driver / headless)
 *  all resolve reflection through ONE lazy load — the first caller's root
 *  wins and the settings read happens once per process (boot-root frozen;
 *  a rescan does not rebuild it — reflect is a boot const like
 *  writeVerify). A rejected load degrades to OFF (fail-open). */
let reflectRuntimeCache: Promise<ReflectRuntime | undefined> | undefined;

export function reflectRuntimeFor(
  workspaceRoot: string,
  opts: { readonly warn?: ReflectWarn; readonly env?: NodeJS.ProcessEnv } = {},
): Promise<ReflectRuntime | undefined> {
  if (reflectRuntimeCache === undefined) {
    reflectRuntimeCache = loadReflectSettings(workspaceRoot, opts.warn ?? (() => {}), opts.env)
      .then((settings) => buildReflectRuntime(settings, { workspaceRoot, ...(opts.warn !== undefined ? { warn: opts.warn } : {}) }))
      .catch((err: unknown): undefined => {
        (opts.warn ?? defaultWarn)(`⚠️ [reflect] disabled: initialization failed (${err instanceof Error ? err.name : "unknown"})`);
        return undefined;
      });
  }
  return reflectRuntimeCache;
}

/** Test seam — drop the memoized runtime (a new root/env takes effect). */
export function resetReflectRuntimeCache(): void {
  reflectRuntimeCache = undefined;
}
