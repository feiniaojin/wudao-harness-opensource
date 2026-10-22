// ω-4d (import-queue item 17; design 61 §3.2) — login-shell env snapshot,
// CLI runtime: the ONLY process-touching piece. maybeLoginShellEnv decides at
// construction (kill switch / $SHELL / supported kind — zero cost when the
// feature is absent) and otherwise returns a memoized provider:
//   - LAZY: nothing spawns until the first host-path shell asks;
//   - SINGLE-FLIGHT: concurrent callers share one spawn (the upstream project's OnceCell);
//   - FAILURE-CACHED: a spawn error, non-zero exit, timeout, over-cap
//     (>512 KiB) or unparseable output resolves undefined FOR THE REST OF
//     THE SESSION (never retried) with one warn line — worst case is 10 s
//     once, then today's behavior forever (no retry storm);
//   - SCRUBBED: the capture child starts from the credential-scrubbed env
//     (HOME survives, so rc resolution works; rc files never see harness
//     credentials the terminal wouldn't);
//   - TRANSPORT-ONLY: pre-NUL rc stdout is discarded by the parser and
//     stderr is dropped — the snapshot never reaches the model as text.
//
// Trust boundary (design 61 §3.4): rc files are the operator's own trust
// tier — the capture sources the user's own $ZDOTDIR/$HOME rc exactly as a
// terminal would. Nothing model-reachable steers it: $SHELL/$ZDOTDIR come
// from the launching context and the project settings tier cannot inject env
// ("env" is in PROJECT_FORBIDDEN_KEYS).
import { spawn } from "node:child_process";
import {
  applyEgressChildEnv,
  buildLoginShellCaptureScript,
  loginShellKindFromPath,
  parseLoginShellEnvOutput,
  scrubChildEnvOf,
  LOGIN_SHELL_SNAPSHOT_MAX_BYTES,
  LOGIN_SHELL_SNAPSHOT_TIMEOUT_MS,
} from "@wudao/core";
import { isFeatureAblated } from "./args.js";

/** What a spawned capture child exposes to the runtime: its stdout (utf8)
 *  and a kill switch. Injectable so every §5 case runs against a fake — no
 *  real login shell, deterministic. */
export interface SpawnShellChild {
  readonly stdout: Promise<string>;
  readonly kill: () => void;
}

export type SpawnShellFn = (
  shellPath: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) => SpawnShellChild;

/** Test/injection seams. `env` defaults to the process env (also what the
 *  ablation check reads); `timeoutMs` defaults to the the upstream project10 s bound
 *  (shrinkable for the §5 timeout case). */
export interface ShellSnapshotDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly spawnShell?: SpawnShellFn;
  readonly warn?: (line: string) => void;
  readonly timeoutMs?: number;
}

// One-line-ify an unknown error for a warn line (multi-line messages would
// leak into log shaping).
const errMsg = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).replace(/\s+/g, " ").trim();

// The real capture spawn: $SHELL -c <script>, cwd pinned to the workspace
// root, stdout piped, stderr ignored, killed with SIGKILL on timeout (the upstream project// kills on drop). Non-zero exit and spawn errors surface as a rejection.
const defaultSpawnShell: SpawnShellFn = (shellPath, args, options) => {
  const child = spawn(shellPath, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const chunks: Buffer[] = [];
  let settled = false;
  const stdout = new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`login-shell capture exited with code ${String(code)}`));
    });
  });
  return { stdout, kill: () => { child.kill("SIGKILL"); } };
};

/** Build the session's login-shell snapshot provider. Returns undefined —
 *  the feature entirely absent, no provider, no lazy resolution — when the
 *  kill switch is on (WUDAO_NO_LOGIN_SHELL=1 / --no-login-shell), $SHELL is
 *  unset/empty, or the shell kind is unsupported (fish/pwsh/cmd/…). Callers
 *  spread the result into buildToolSet beside their spillDir lines; the
 *  frontends' one-liners then contribute nothing. */
export function maybeLoginShellEnv(
  workspaceRoot: string,
  deps: ShellSnapshotDeps = {},
): (() => Promise<Readonly<Record<string, string>> | undefined>) | undefined {
  const env = deps.env ?? process.env;
  if (isFeatureAblated("login-shell", env)) return undefined;
  const shellPath = typeof env.SHELL === "string" ? env.SHELL : "";
  if (shellPath === "") return undefined;
  const kind = loginShellKindFromPath(shellPath);
  if (kind === undefined) return undefined;
  const spawnShell = deps.spawnShell ?? defaultSpawnShell;
  const warn = deps.warn ?? ((): void => {});
  const timeoutMs = deps.timeoutMs ?? LOGIN_SHELL_SNAPSHOT_TIMEOUT_MS;
  const script = buildLoginShellCaptureScript(kind);
  // Exactly one warn line per PROVIDER instance, across every failure and
  // every subsequent (cached-undefined) call.
  let warned = false;
  const warnOnce = (line: string): void => {
    if (warned) return;
    warned = true;
    warn(line);
  };
  // Single-flight + failure cache: the promise is stored and never rebuilt —
  // concurrent callers share one spawn; a failed capture stays failed.
  let memo: Promise<Readonly<Record<string, string>> | undefined> | undefined;
  return () => (memo ??= new Promise((resolve) => {
    let child: SpawnShellChild;
    try {
      // ω99-46: the capture child gets the same single proxy-env boundary as
      // every other harness spawn (applyEgressChildEnv over the pure scrub);
      // no active policy = byte-identical to the pre-ω99-46 env.
      child = spawnShell(shellPath, ["-c", script], { cwd: workspaceRoot, env: applyEgressChildEnv(scrubChildEnvOf(env)) });
    } catch (err) {
      warnOnce(`login-shell snapshot unavailable (${errMsg(err)}); falling back to the process env for this session`);
      resolve(undefined);
      return;
    }
    const timer: NodeJS.Timeout = setTimeout(() => {
      try { child.kill(); } catch { /* already gone — the close event races the kill */ }
      warnOnce(`login-shell snapshot timed out after ${timeoutMs}ms; falling back to the process env for this session`);
      resolve(undefined);
    }, timeoutMs);
    child.stdout.then(
      (output) => {
        clearTimeout(timer);
        if (Buffer.byteLength(output, "utf8") > LOGIN_SHELL_SNAPSHOT_MAX_BYTES) {
          warnOnce(`login-shell snapshot exceeded ${LOGIN_SHELL_SNAPSHOT_MAX_BYTES} bytes; falling back to the process env for this session`);
          resolve(undefined);
          return;
        }
        const parsed = parseLoginShellEnvOutput(output);
        if (parsed === undefined) {
          warnOnce("login-shell snapshot output was unparseable; falling back to the process env for this session");
          resolve(undefined);
          return;
        }
        resolve(parsed);
      },
      (err) => {
        clearTimeout(timer);
        warnOnce(`login-shell snapshot failed (${errMsg(err)}); falling back to the process env for this session`);
        resolve(undefined);
      },
    );
  }));
}
