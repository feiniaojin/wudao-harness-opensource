// Hook command execution bridge — module-level segment extracted from
// hooks-config.ts (ω99 file-size discipline arc A): the execFile runner
// (scrubbed env, timeouts, ENOEXEC→sh fallback, win32 Git-Bash discovery),
// the quote-aware tokenizer, and the shared timing constants.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookCommandConfig, HookWarn } from "./hooks-config-types.js";
import { peerHookEnvBox as livePeerHookEnv } from "./peer/runtime.js";

// M63-C §3: the DEFAULT hook timeout is 600s (CC parity); the two
// prompt-class events (onPromptSubmit/onRunStop — the prompt-based contracts)
// default to 30s. A per-entry timeoutMs always wins.
export const DEFAULT_TIMEOUT_MS = 600_000;
export const PROMPT_HOOK_TIMEOUT_MS = 30_000;
const MAX_HOOK_OUTPUT_BYTES = 1_000_000;

/** M63-B: the shared SessionEnd budget (spec §1: ALL SessionEnd hooks share
 *  1.5s; over-budget commands are killed). */
export const SESSION_END_BUDGET_MS = 1_500;

export interface HookRun {
  readonly code: number;
  readonly stdout: string;
  readonly reason: string; // stderr first line | "blocked by hook" — set for non-zero exits
}

/** cc-plugins E4: CC's plugin-hook convention — commands may reference the
 *  plugin's install dir as `${CLAUDE_PLUGIN_ROOT}` or bare
 *  `$CLAUDE_PLUGIN_ROOT`. execFile runs no shell, so the token is replaced
 *  textually before tokenization (braced form first so the bare pattern
 *  can't bite into its residue). */
function expandPluginRootTokens(command: string, pluginRoot: string): string {
  return command.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot).replaceAll("$CLAUDE_PLUGIN_ROOT", pluginRoot);
}

// Runs one hook command. Resolves undefined for non-blocking failures
// (timeout, spawn error, empty command) after emitting a warning.
export function runHookCommand(
  cmd: HookCommandConfig,
  payload: string,
  workspaceRoot: string,
  warn: HookWarn,
  opts?: { readonly defaultTimeoutMs?: number },
): Promise<HookRun | undefined> {
  const pluginRoot = cmd.pluginRoot;
  const command = pluginRoot !== undefined ? expandPluginRootTokens(cmd.command ?? "", pluginRoot) : cmd.command ?? "";
  const argv = tokenizeCommand(command);
  const file = argv[0];
  if (!file) {
    warn(`⚠️ hook 命令为空——已跳过`);
    return Promise.resolve(undefined);
  }
  const timeoutMs = cmd.timeoutMs ?? opts?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const env = pluginRoot !== undefined ? { ...scrubbedEnv(), CLAUDE_PLUGIN_ROOT: pluginRoot } : scrubbedEnv();

  return execHookArgv(argv, { payload, workspaceRoot, env, timeoutMs, cmd, warn }).then((first) => {
    if (first.outcome !== "enoexec") return first.run;
    // cc-plugins E4: shebang-less executable (execve ENOEXEC). Real CC runs
    // hooks via a shell, and POSIX shells fall back to interpreting such
    // files — superpowers' run-hook.cmd batch/shell polyglot relies on it.
    // Retry once with /bin/sh interpreting the same argv[0]. On win32 /bin/sh
    // does not exist — Git Bash's sh is the standing POSIX interpreter and
    // the ONLY way a .sh hook (the ecosystem's dominant hook form) can run;
    // without one the fallback path stays inert (first outcome stands).
    const sh = process.platform === "win32" ? windowsSh() : "/bin/sh";
    if (sh === undefined) return first.run;
    return execHookArgv([sh, ...argv], { payload, workspaceRoot, env, timeoutMs, cmd, warn }).then((second) => second.run);
  });
}

/** Cached Git-Bash sh.exe discovery (win32): hooks are authored as .sh —
 *  without a POSIX interpreter those hooks cannot execute at all. Null once
 *  probed and absent. */
let cachedWinSh: string | undefined | null;
function windowsSh(): string | undefined {
  if (cachedWinSh === null) return undefined;
  if (cachedWinSh !== undefined) return cachedWinSh;
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "usr", "bin", "sh.exe"),
    join(process.env.LocalAppData ?? "", "Programs", "Git", "usr", "bin", "sh.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedWinSh = c;
      return c;
    }
  }
  cachedWinSh = null;
  return undefined;
}

/** One execFile attempt. `outcome:"enoexec"` marks a shebang-less spawn
 *  failure so the caller can apply the /bin/sh fallback; every other
 *  non-blocking failure is already warned here and resolves `{run:undefined}`. */
function execHookArgv(
  argv: string[],
  ctx: { payload: string; workspaceRoot: string; env: NodeJS.ProcessEnv; timeoutMs: number; cmd: HookCommandConfig; warn: HookWarn },
): Promise<{ outcome: "run" | "enoexec"; run: HookRun | undefined }> {
  const { payload, workspaceRoot, env, timeoutMs, cmd, warn } = ctx;
  const file = argv[0];
  if (file === undefined) {
    warn(`⚠️ hook 命令为空——已跳过`);
    return Promise.resolve({ outcome: "run" as const, run: undefined });
  }
  return new Promise((resolveRun) => {
    // Node ≥24 throws ENOEXEC synchronously out of execFile (ENOENT still
    // arrives via the callback) — catch both spellings of the same fact.
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(
        file,
        argv.slice(1),
        { cwd: workspaceRoot, timeout: timeoutMs, maxBuffer: MAX_HOOK_OUTPUT_BYTES, encoding: "utf8", env, windowsHide: true },
        (err, stdout, stderr) => {
          const out = typeof stdout === "string" ? stdout : "";
          const errOut = typeof stderr === "string" ? stderr : "";
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
            const timedOut = e.killed === true && (e.signal === "SIGTERM" || /timed out/i.test(e.message));
            if (timedOut) {
              warn(`⚠️ hook '${cmd.command}' 超时（${timeoutMs}ms）——继续`);
              resolveRun({ outcome: "run", run: undefined });
              return;
            }
            if (e.code === "ENOEXEC" || e.code === "EFTYPE") {
              // EFTYPE is win32's ENOEXEC: the file is not a PE executable
              // (a .sh script) — the sh-interpretation fallback applies.
              resolveRun({ outcome: "enoexec", run: undefined });
              return;
            }
            if (typeof e.code === "number") {
              resolveRun({ outcome: "run", run: { code: e.code, stdout: out, reason: firstLine(errOut) || "blocked by hook" } });
              return;
            }
            warn(`⚠️ hook '${cmd.command}' 启动失败：${e.message}`);
            resolveRun({ outcome: "run", run: undefined });
            return;
          }
          resolveRun({ outcome: "run", run: { code: 0, stdout: out, reason: "" } });
        },
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOEXEC" || (e as NodeJS.ErrnoException).code === "EFTYPE") {
        resolveRun({ outcome: "enoexec", run: undefined });
      } else {
        warn(`⚠️ hook '${cmd.command}' 启动失败：${(e as Error).message}`);
        resolveRun({ outcome: "run", run: undefined });
      }
      return;
    }
    if (child.stdin) {
      child.stdin.on("error", () => {
        // Hook doesn't read stdin (e.g. `git diff --quiet`) → EPIPE is fine.
      });
      child.stdin.end(payload);
    }
  });
}

export function firstLine(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const idx = trimmed.indexOf("\n");
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).trim();
}

// Quote-aware whitespace tokenizer: `tr 'a-z' 'A-Z'` → ["tr", "a-z", "A-Z"].
// No shell metacharacter interpretation (no $VAR, no ;, no pipes) — the command
// names ONE executable with literal arguments.
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: '"' | "'" | undefined;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (current || hasToken) {
        tokens.push(current);
        current = "";
        hasToken = false;
      }
      continue;
    }
    current += ch;
  }
  if (current || hasToken) tokens.push(current);
  return tokens;
}

// Same scrub as shell: drop credential-shaped env vars so hook commands
// can't exfiltrate keys via printenv-style inspection of the child env.
const SENSITIVE_SUFFIX = /(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i;
const SENSITIVE_PREFIX = /^(WUDAO_|OPENAI_)/;

/** M64-A §A: the peer runtime's hook env (WUDAO_MSG_SOCKET / WUDAO_MSG_TOKEN
 *  — the session's inbox socket + the self-loopback token) lives in the peer
 *  package (runtime.ts assigns it at startup / clears it at stop); this file
 *  reads the same canonical box directly (hooks-config.js re-exports it so
 *  external wiring names one import site). The scrub below strips BOTH
 *  patterns (WUDAO_* prefix, *TOKEN suffix), so these are the ONLY
 *  deliberately re-added values: the spec hands exactly this pair to hook
 *  subprocesses, and a hook proving the token reaches its own session's
 *  inbox as a trusted-source (self) sender. */
function scrubbedEnv(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SENSITIVE_SUFFIX.test(k) || SENSITIVE_PREFIX.test(k)) continue;
    childEnv[k] = v;
  }
  for (const [k, v] of Object.entries(livePeerHookEnv.current ?? {})) childEnv[k] = v;
  return childEnv;
}
