import { exec, execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { truncateSafe } from "../text-truncate.js";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildTool } from "../tool.js";
import { needsLongOutputShaping, shapeLongOutput, type LongOutputConfig } from "./long-output.js";
import { slimToolLog, type LogSlimmingPorts } from "./log-slimming.js";
import { mergeLoginShellEnv, scrubChildEnvOf, scrubSnapshotEnv } from "./shell-snapshot.js";
import { splitJsBin } from "./js-bin.js";
// ω99-46: the proxy half of the child-env policy — ONE overlay function, so
// every harness-spawned child (shell, monitor, terminal, skill expand,
// the login-shell capture) sees the active egress policy through the same
// boundary instead of a second decision point.
import { applyEgressChildEnv } from "../net/egress.js";
// ω99-49: the streaming face — bounded sliding window + adaptive publisher.
import { OutputCapture } from "./output-capture.js";
import type { ToolUpdateFn } from "../tool.js";

// Containerized execution config (M21). When set, shell executes inside
// `docker run` instead of the host shell; if the Docker probe fails, every
// sandboxed run is DENIED — never a fallback to host execution (fail-closed).
export interface SandboxOptions {
  readonly image?: string;
  readonly dockerPath?: string;
}

const PROBE_TIMEOUT_MS = 5_000;

// The tool's contract is `sh -c` (posix quoting: single-quoted awk programs,
// \n escapes, `a && b`). Node's exec defaults to ComSpec (cmd.exe) on win32,
// which rejects that entire grammar. When a POSIX sh is discoverable (Git
// Bash's, the ubiquitous install), the host path uses it; without one,
// today's cmd.exe behavior stands (unchanged for machines without Git).
let cachedSh: string | undefined | null; // null = probed, not found
function hostShell(): { shell: string } | Record<string, never> {
  if (process.platform !== "win32") return {};
  if (cachedSh === null) return {};
  if (cachedSh !== undefined) return { shell: cachedSh };
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "usr", "bin", "sh.exe"),
    join(process.env.LocalAppData ?? "", "Programs", "Git", "usr", "bin", "sh.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedSh = c;
      return { shell: c };
    }
  }
  cachedSh = null;
  return {};
}

const strArg = (v: unknown): string => (typeof v === "string" ? v : "");

/** ω99-49: the terminal buffers' cap law, byte-identical to the pre-ω99-49
 *  append lambda (@f8882d4 run-command.ts:91-92) and exported for the
 *  differential acceptance pin (tests/o99-49-bounded-shell-output.test.ts).
 *  Head-kept, hard stop at maxBuffer — the exec()/execFile()-faithful cap
 *  that keeps the terminal ToolResult bytes unchanged.
 *  113-A4 行为修正声明：cap 收编为代理对安全的 truncateSafe——ASCII/BMP
 *  输入字节逐字节不变；只有 cap 劈在 emoji/CJK 扩展字符代理对中间时字节
 *  与历史不同，而旧字节是孤立代理项乱码（差分钉的 🎉 行随之改为钉“新
 *  法：无孤立代理项”，见该测试 §2.5 注释）。 */
export function capBuffer(prev: string, text: string, maxBuffer: number): string {
  return prev.length >= maxBuffer ? prev : truncateSafe(prev + text, maxBuffer);
}

// 波次 8 #43 (the upstream): exec()'s timeout kill reaches ONLY
// the direct child — the `sh -c` shell. Backgrounded grandchildren (`cmd &`,
// pipe tails, daemons) get reparented and keep running: writing files,
// holding locks, squatting the port. On POSIX the shell path spawns DETACHED
// (own process group, pgid = child pid); the timeout kill signals the
// NEGATIVE pid so the whole group dies — TERM first, then KILL after a 2s
// grace for TERM-immune stragglers (the escalation's SIGKILL surfaces as the
// honest `[killed by SIGKILL]` label, not a timeout label). Win32 (and any
// explicit shell override) keeps exec(): no process groups to signal there.
// Error shapes are exec()-faithful: null on success, {code} on nonzero exit,
// {killed:true, signal:"SIGTERM", code:null} on timeout — finish()'s exit /
// not-found / timeout labels key on exactly those.
// ω99-49: the optional onUpdate rides along as an ADDITIVE streaming face —
// every chunk feeds both the legacy terminal buffers (byte-identical law
// below) and the OutputCapture live window. Absent → the exact pre-ω99-49
// code path (no capture object is even constructed).
function execWithGroupKill(
  command: string,
  opts: { cwd?: string; timeout: number; maxBuffer: number; env: NodeJS.ProcessEnv; shell?: string },
  done: (err: Error | null, stdout: string, stderr: string) => void,
  onUpdate?: ToolUpdateFn,
  signal?: AbortSignal,
): void {
  if (process.platform === "win32" || opts.shell !== undefined) {
    // windowsHide: a console-subsystem child of a console-LESS parent (the
    // desktop sidecar) would otherwise get its own visible console window —
    // closing it kills the command mid-run. No-op in terminals (attached).
    exec(command, { windowsHide: true, ...opts }, done);
    return;
  }
  const child = spawn(command, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true, // own process group — the group kill hinges on this
    // stdin stays an open, never-written pipe: exec()'s exact posture (the
    // interactive-hang detection depends on prompt-waiting tools NOT seeing
    // an early EOF that /dev/null would give them).
    stdio: ["pipe", "pipe", "pipe"],
    shell: true, // POSIX: /bin/sh -c (what exec() does without opts.shell)
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  let killedByTimeout = false;
  // 弧 δ: the detached lane's stop path (an explicit user stop of a
  // backgrounded task — 用户意图优先). Same group-kill escalation as the
  // timeout (TERM, then KILL after the 2s grace) but its OWN flag: a stop
  // must never wear the timeout label.
  let stoppedBySignal = false;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  // ω99-49: the terminal buffers' byte law, extracted VERBATIM from the
  // pre-ω99-49 append lambda (@f8882d4 run-command.ts:91-92) and exported
  // for the differential pin — UTF-16-code-unit slice, head-kept, hard stop
  // at maxBuffer. This is the exec()/execFile() maxBuffer-faithful cap: the
  // process-level生死线 semantics (drop past the cap, never kill) unchanged.
  const capture = onUpdate === undefined ? undefined : new OutputCapture({ onUpdate });
  const append = (prev: string, chunk: Buffer): string =>
    prev.length >= opts.maxBuffer ? prev : capBuffer(prev, chunk.toString("utf8"), opts.maxBuffer);
  child.stdout?.on("data", (c: Buffer) => { stdout = append(stdout, c); capture?.push(c); });
  child.stderr?.on("data", (c: Buffer) => { stderr = append(stderr, c); capture?.push(c); });
  const timer = setTimeout(() => {
    killedByTimeout = true;
    // Signal the GROUP (-pid); ESRCH just means an earlier death won.
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
    escalation = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    }, 2_000);
  }, opts.timeout);
  // 弧 δ: abort → the same group TERM→KILL escalation, flagged as a stop.
  signal?.addEventListener("abort", () => {
    if (settled) return;
    stoppedBySignal = true;
    try { if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM"); } catch { /* group already gone */ }
    escalation = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
    }, 2_000);
  }, { once: true });
  const settle = (err: Error | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (escalation !== undefined) clearTimeout(escalation);
    capture?.finish(); // terminal forced flush BEFORE the result settles
    done(err, stdout, stderr);
  };
  child.on("error", (e) => settle(e as Error)); // spawn failure (ENOENT …)
  child.on("close", (code, signal) => {
    if (stoppedBySignal) {
      settle(Object.assign(new Error("Command stopped"), { killed: true, signal: signal ?? "SIGTERM", code: code ?? null, stopped: true }));
    } else if (killedByTimeout) {
      settle(Object.assign(new Error("Command timed out"), { killed: true, signal: signal ?? "SIGTERM", code: code ?? null }));
    } else if (code !== 0 && code !== null) {
      settle(Object.assign(new Error(`Command failed with exit code ${code}`), { killed: false, signal: null, code }));
    } else if (code === null) {
      // externally signalled (not our timeout) — surface the signal verbatim
      settle(Object.assign(new Error("Command killed"), { killed: signal !== null, signal: signal ?? undefined, code: null }));
    } else {
      settle(null);
    }
  });
}

// M51 §3 — the destructive-command classifier feeding shell's
// isDestructive annotation (and through it the sidecar's tool_flags). A
// conservative OR of well-known state-destroying shapes; matched against the
// FIRST token of any command segment (`;`/`&`/`|` separated) so `cat f; rm f`
// still trips. false = "not obviously destructive", never "safe".
const DESTRUCTIVE_FIRST_TOKEN =
  /(?:^|[;&|]\s*)(?:rm|rmdir|unlink|shred|dd|mkfs[\w.]*|fdisk|parted|truncate|mv|kill|pkill|killall|shutdown|reboot)\b/;
const DESTRUCTIVE_PATTERNS: readonly RegExp[] = [
  DESTRUCTIVE_FIRST_TOKEN,
  /\bgit\s+push\s+(?:.*\s)?(?:--force(?:-with-lease)?\b|-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b/,
  /\bgit\s+(?:checkout|restore)\s+--\s/,
  /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune))\b/,
  /\bnpm\s+publish\b/,
  /(?:^|[\s;])>\s*\S/, // output redirection truncates the target
];

/** Pure: does this command look destructive? Exported for tests. */
export function commandLooksDestructive(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((re) => re.test(command));
}

// 波次 7 #34 (OH B2) — interactive-hang detection. A model-driven shell has
// no human to answer prompts: a command that waits on stdin burns its whole
// timeout and reads as a generic timeout on retry. Deterministic head scan
// (false positives only add a hint line to the timeout label; false
// negatives merely miss one). Plain token split — the same first-token
// reading the destructive classifier uses.
const INTERACTIVE_HEADS = new Set(["sudo", "passwd", "create-next-app", "create-vite", "create-react-app", "create-expo-app"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Pure: does this command look like it will wait on interactive input?
 *  Exported for tests. */
export function looksInteractive(command: string): boolean {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? "";
  if (head === "") return false;
  if (INTERACTIVE_HEADS.has(head)) return true;
  if (PACKAGE_MANAGERS.has(head)) {
    const sub = tokens[1] ?? "";
    // `pm create X` always scaffolds through a prompt flow; `npm init`
    // prompts unless -y/--yes is present.
    if (sub === "create") return true;
    if (head === "npm" && sub === "init") return !(tokens.includes("-y") || tokens.includes("--yes"));
  }
  if (head === "npx") return /^create-/.test(tokens[1] ?? "");
  // Prompt flags on file operations: `-i` alone or bundled (`rm -if`).
  if (head === "rm" || head === "mv" || head === "cp") {
    return tokens.slice(1).some((t) => t === "-i" || ( /^-[a-zA-Z]+$/.test(t) && t.includes("i")));
  }
  return false;
}

/** Credential-shaped env scrub shared by every harness-spawned child (host
 *  shell, docker CLI, and — since M50 — the run_script PTC child). Returns a
 *  fresh env object: `*API_KEY`/`*ACCESS_KEY`/`*TOKEN`/`*SECRET`/`*PASSWORD`/
 *  `*CREDENTIALS` suffixes and `WUDAO_*`/`OPENAI_*` prefixes are dropped. */
export function scrubChildEnv(): NodeJS.ProcessEnv {
  // ω-4d: the rules live once, in the pure scrubChildEnvOf (shell-snapshot.ts),
  // so the process-env scrub and the login-shell snapshot cannot drift apart.
  // ω99-46: the proxy overlay rides the same boundary — applyEgressChildEnv
  // publishes the ACTIVE egress policy's names (HTTPS_PROXY/HTTP_PROXY/
  // NO_PROXY + NODE_USE_ENV_PROXY, withheld for values Node cannot parse).
  // No active policy = empty overlay = the env above, byte-identical.
  return applyEgressChildEnv(scrubChildEnvOf(process.env));
}

export function createShellTool(options: {
  workspaceRoot: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sandbox?: SandboxOptions;
  /** M24 spill: when set, output truncated past maxOutputBytes is written in
   *  FULL to `<spillDir>/<hash>.txt` and the result tail names the path.
   *  Absent → truncated output only (the pre-M24 behavior). Core stays
   *  session-unaware; the cli injects the per-session directory. */
  spillDir?: string;
  /** M46 §2: head/tail shaping for long outputs (lines OR bytes over
   *  threshold → head + omission marker + tail + guidance, with the FULL
   *  output spilled via the M24 seam). Needs a spillDir; absent config — or
   *  a failed spill — falls back to the byte-cap behavior. */
  longOutput?: LongOutputConfig;
  /** ω-4d: lazy login-shell env snapshot provider (one capture per session,
   *  rc-applied — the cli's maybeLoginShellEnv). Present → the HOST exec env
   *  is the scrubbed process env merged UNDER the scrubbed snapshot (rc wins
   *  — the fidelity definition); the provider never throws and memoizes its
   *  own failure (undefined forever after). Absent → the scrubbed process env
   *  alone, byte-identical to the pre-ω-4d tool (every eval/embedder site).
   *  NEVER consulted on the sandbox path — the docker branch returns before
   *  the await. Core stays session-unaware; the cli injects the provider. */
  readonly loginShellEnv?: () => Promise<Readonly<Record<string, string>> | undefined>;
  /** 借鉴弧 C1（the upstream project C3）：超长诊断日志的证据保全瘦身。缺省不注入 =
   *  行为与 pre-C1 字节相同。注入后：达到阈值的构建/测试日志先由最廉价
   *  档模型首读产出验证回执（原文照旧落盘归档）；任何一步不过都落回
   *  M46 头尾 shaping——主模型永远见不到未验证摘要（fail-open 教义）。
   *  M24 声明：回执替换头尾预览属入历史点处的一次性前缀影响，与 M46
   *  同类；首读模型的前缀与主路径完全分离。 */
  readonly logSlimming?: LogSlimmingPorts;
}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 65_536;
  const image = options.sandbox?.image ?? "node:22-alpine";
  const dockerPath = options.sandbox?.dockerPath ?? "docker";
  const spillDir = options.spillDir;
  const longOutput = options.longOutput;
  const logSlimming = options.logSlimming;

  // Availability probe, cached per tool instance (success AND failure — a
  // down daemon keeps denying rather than re-probing on every call).
  let probe: Promise<{ ok: true } | { ok: false; reason: string }> | undefined;
  // dockerPath may be the two-word `node <entry.mjs>` form (win32 embedders/
  // tests point at JS fake-dockers; see splitJsBin).
  const dockerExe = splitJsBin(dockerPath);
  const runProbe = (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    (probe ??= new Promise((resolve) => {
      execFile(dockerExe.exe, [...dockerExe.prefix, "version", "--format", "{{.Server.Version}}"], { timeout: PROBE_TIMEOUT_MS }, (err, _stdout, stderr) => {
        if (err !== null) {
          // Prefer the daemon's own stderr (e.g. "cannot connect to the Docker
          // daemon") over execFile's multi-line "Command failed: ..." wrapper;
          // collapse whitespace so the denial stays a single line.
          const detail = String(stderr ?? "").trim();
          const reason = (detail || err.message).replace(/\s+/g, " ").trim();
          resolve({ ok: false, reason });
        } else {
          resolve({ ok: true });
        }
      });
    }));

  // Scrub credential-shaped env vars so a model-issued `printenv` can't
  // exfiltrate keys. (The model can still `cat .env` — file-level protection
  // is a documented v1 limitation.) Applied to the host shell AND the docker
  // CLI itself; note the container env is whatever the image ships by default
  // — no `-e` flags are passed, so nothing from the host leaks INTO it.
  // Exported (M50) so run_script's child gets the identical hygiene.
  const scrubbedEnv = (): NodeJS.ProcessEnv => scrubChildEnv();

  // With spill enabled, let the child produce more than the inline cap so the
  // spilled file is genuinely the FULL output (16× the cap, ≥1MB). Without
  // spill the buffer matches the inline cap — the pre-M24 behavior.
  const execMaxBuffer = (): number => (spillDir ? Math.max(maxOutputBytes * 16, 1_048_576) : maxOutputBytes);

  // Spill the FULL raw output to disk (best-effort: a failed write just means
  // no path note — the truncated output still returns). Sync because finish()
  // runs inside exec callbacks; deterministic name = content hash, so
  // identical outputs share one file.
  const spill = (raw: string): string | undefined => {
    if (!spillDir) return undefined;
    try {
      mkdirSync(spillDir, { recursive: true });
      const name = `${createHash("sha256").update(raw).digest("hex").slice(0, 16)}.txt`;
      const path = join(spillDir, name);
      writeFileSync(path, raw, "utf8");
      return path;
    } catch {
      return undefined;
    }
  };

  // Shared result shaping: combined output (spilling the full text when the
  // cap bites), not-found note, exit/signal label. 借鉴弧 C1: async — the
  // evidence-preserving first-read may await ONE cheap-tier model call; every
  // other path through finish stays synchronous in practice (the promise
  // resolves immediately after the pure shaping work).
  const finish = async (command: string, err: unknown, stdout: string | Buffer, stderr: string | Buffer) => {
    const stdoutText = String(stdout);
    const stderrText = String(stderr);
    const raw = `${stdoutText}${stderrText ? (stdoutText ? "\n" : "") + stderrText : ""}`;
    // 借鉴弧 C1（the upstream project C3）：阈值门控混合——合格诊断日志先由廉价档模型
    // 首读。原文先照常落盘归档（同一 M24 spill 缝），回执替换头尾预览；
    // slimToolLog 内部任何一门不过（含预筛不发起调用）都返回 fallback，
    // 控制流落到下面的 M46 分支——字节与 pre-C1 相同（fail-open）。
    if (logSlimming !== undefined) {
      const archive = spill(raw);
      if (archive !== undefined) {
        const outcome = await slimToolLog({
          raw,
          command,
          observedFailed: exitCodeOf(err) !== 0,
          model: logSlimming.model,
          ...(logSlimming.config !== undefined ? { config: logSlimming.config } : {}),
          archivePath: archive,
        });
        logSlimming.onDecision?.({
          command,
          outcome: outcome.kind,
          ...(outcome.kind === "receipt" ? { savedChars: outcome.savedChars } : { reason: outcome.reason }),
        });
        if (outcome.kind === "receipt") {
          return {
            content: `$ ${command}\n${outcome.body}${notFoundNoteFor(err, stderrText, command)}\n${exitLabelFor(err, command)}`,
            isError: exitCodeOf(err) !== 0,
          };
        }
      }
    }
    // M46 §2: long outputs keep head + tail around an omission marker, with
    // the full text spilled for read_file paging. Only when the spill write
    // succeeds — otherwise fall through to the byte-cap path below (the
    // pre-M46 behavior is the documented fallback).
    if (longOutput !== undefined && needsLongOutputShaping(raw, longOutput)) {
      const path = spill(raw);
      const shaped = path === undefined ? undefined : shapeLongOutput({ raw, config: longOutput, spillPath: path });
      if (shaped !== undefined) {
        return { content: `$ ${command}\n${shaped}${notFoundNoteFor(err, stderrText, command)}\n${exitLabelFor(err, command)}`, isError: exitCodeOf(err) !== 0 };
      }
    }
    const truncated = raw.length > maxOutputBytes;
    const combined = truncated ? truncateSafe(raw, maxOutputBytes) : raw; // 113-A4
    const spillNote = truncated ? (() => {
      const path = spill(raw);
      return path === undefined ? "" : `\n(full output: ${path})`;
    })() : "";
    const notFoundNote = notFoundNoteFor(err, stderrText, command);
    const exitLabel = exitLabelFor(err, command);
    return { content: `$ ${command}\n${combined}${notFoundNote}${spillNote}\n${exitLabel}`, isError: exitCodeOf(err) !== 0 };
  };

  // Shared exit/signal/not-found labels (used by both the shaped and the
  // byte-cap result paths).
  const execErrOf = (err: unknown) => err as ({ code?: number | string; killed?: boolean; signal?: string } | null);
  // Legacy exit code semantics, byte-faithful: no error → 0; an error with
  // no code → 1; a code (even a string like ENOENT) interpolates verbatim.
  const exitCodeOf = (err: unknown): number | string => {
    if (err === null || err === undefined) return 0;
    return execErrOf(err)?.code ?? 1;
  };
  // The command runs via `sh -c` (host) or `docker … sh -c` (sandbox), so a
  // missing binary surfaces either as a direct spawn ENOENT (code ===
  // "ENOENT") or as the shell's exit 127.
  const notFoundNoteFor = (err: unknown, stderr?: unknown, command?: string): string => {
    if (err === null || err === undefined) return "";
    const code = execErrOf(err)?.code;
    if (code === "ENOENT" || code === 127) return "\ncommand not found or not executable";
    // win32 cmd.exe: an unknown command exits 1 with a LOCALIZED "not
    // recognized" message (GBK-mojibake by the time Node decoded it — never
    // match the text). The codepage-stable shape: stderr opens with the
    // first command word wrapped in single quotes.
    if (process.platform === "win32" && code === 1 && command !== undefined) {
      const text = String(stderr ?? "");
      if (text.startsWith(`'${command.split(" ")[0]}'`)) {
        return "\ncommand not found or not executable";
      }
    }
    return "";
  };
  // exec()/execFile() kill with SIGTERM on timeout (killed=true). A child
  // terminated by any OTHER signal carries err.signal but killed=false —
  // label the actual signal; the timeout label is reserved for SIGTERM kills.
  // 波次 7 #34 (OH B2): a timeout on an interactive-looking command carries
  // the non-interactive hint — without it a prompt-waiting burn reads as a
  // generic timeout and the model retries blind.
  const exitLabelFor = (err: unknown, command: string): string => {
    if (err === null || err === undefined) return "[exit 0]";
    const e = execErrOf(err);
    // 弧 δ: the detached lane's stop — its own label, never the timeout's.
    if ((e as { stopped?: boolean } | null)?.stopped === true) return "[stopped by user]";
    if (e?.signal !== null && e?.signal !== undefined && e?.signal !== "SIGTERM") return `[killed by ${e.signal}]`;
    if (e?.killed) {
      return looksInteractive(command)
        ? `[timeout after ${timeoutMs / 1000}s — likely waiting for interactive input; re-run with non-interactive flags (e.g. --yes / -y) or pre-supply every argument]`
        : `[timeout after ${timeoutMs / 1000}s]`;
    }
    return `[exit ${exitCodeOf(err)}]`;
  };

  return buildTool({
    name: "shell",
    description: "Run a shell command in the workspace. Returns combined stdout+stderr and the exit code.",
    // M51 §3: open-world (a shell can reach the network); destructive per
    // command — the conservative first-token/pattern scan below. false is NOT
    // "safe", it is "not obviously destructive" (the sidecar still classifies).
    isOpenWorld: () => true,
    isDestructive: (args) => commandLooksDestructive(strArg(args.command)),
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run." } },
      required: ["command"],
      additionalProperties: false,
    },
    // ω99-49: the optional live-output channel (loop-threaded, per-call).
    // Absent → every path below is byte-identical to the pre-ω99-49 tool.
    // Streaming exists on the POSIX host executor (the spawn branch of
    // execWithGroupKill, our own capture layer); the sandbox (execFile) and
    // win32/explicit-shell (exec) branches buffer inside Node and do not
    // stream — their terminal results still carry the full output, and the
    // loop seam is generic so any future capture layer plugs in here.
    async execute({ command }, onUpdate?: ToolUpdateFn, signal?: AbortSignal) {
      if (options.sandbox !== undefined) {
        const probed = await runProbe();
        if (!probed.ok) {
          return {
            content: `shell failed: sandbox required but Docker is unavailable (${probed.reason})`,
            isError: true,
          };
        }
        return new Promise((resolveP) => {
          // Arg-array invocation — the docker command itself is never wrapped
          // in a shell; the USER command goes to `sh -c` INSIDE the container.
          // No-network, capped memory/CPU, workspace mounted read-write at
          // /workspace (the container's working dir).
          // 弧 δ: the stop path is BEST-EFFORT here (SIGTERM to the docker
          // CLI — whether the container dies is Docker's call); the honest
          // label still marks a stop, never a timeout.
          let stopped = false;
          const cp = execFile(
            dockerExe.exe,
            [
              ...dockerExe.prefix,
              "run", "--rm", "-i",
              "--network", "none",
              "--memory", "512m",
              "--cpus", "1",
              "-v", `${options.workspaceRoot}:/workspace`,
              "-w", "/workspace",
              "--entrypoint", "sh",
              image,
              "-c", command as string,
            ],
            { timeout: timeoutMs, maxBuffer: execMaxBuffer(), env: scrubbedEnv() },
            (err, stdout, stderr) => {
              if (!stopped || err === null) {
                resolveP(finish(command as string, err, stdout, stderr));
                return;
              }
              resolveP(finish(command as string, Object.assign(err, { stopped: true }), stdout, stderr));
            },
          );
          signal?.addEventListener("abort", () => {
            if (stopped) return;
            stopped = true;
            try { cp.kill("SIGTERM"); } catch { /* already gone */ }
          }, { once: true });
        });
      }
      // ω-4d: lazily merge the login-shell snapshot (rc-applied env, one
      // capture per session — the provider memoizes; failure resolves
      // undefined and today's env stands). The sandbox branch above NEVER
      // consults the provider; both merge operands are scrubbed, so the
      // product is (§5 case 4's both-directions pin).
      const snapshot = options.sandbox === undefined && options.loginShellEnv !== undefined
        ? await options.loginShellEnv().catch(() => undefined)
        : undefined;
      const env = snapshot !== undefined
        ? mergeLoginShellEnv(scrubbedEnv(), scrubSnapshotEnv(snapshot))
        : scrubbedEnv();
      return new Promise((resolveP) => {
        // 波次 8 #43: group-kill executor (POSIX); win32/explicit-shell
        // callers fall back to exec() inside.
        execWithGroupKill(
          command as string,
          { cwd: options.workspaceRoot, timeout: timeoutMs, maxBuffer: execMaxBuffer(), env, ...hostShell() },
          (err, stdout, stderr) => {
            resolveP(finish(command as string, err, stdout, stderr));
          },
          onUpdate, // ω99-49: undefined on the exec() fallback branches (no-op)
          signal, // 弧 δ: the detached lane's stop path (host branch only — the exec() fallbacks ignore it)
        );
      });
    },
  });
}
