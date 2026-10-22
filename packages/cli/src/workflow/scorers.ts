// M29 §1 — deterministic scorers (the upstream format §3.3): exitCode / fileExists /
// regexMatch / jsonPath evaluated AFTER a task run, each producing a
// pass/fail/skip/timeout receipt. They never call the model — a scorer is the
// cheap, replayable half of verification. (`toolUsed` is the fifth, internal
// kind used by the M22 JSON adapter to keep `expect.toolUsed` semantics.)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { extractStructuredOutput, canonicalJson } from "./structured-output.js";
import type { VerifyReceipt } from "./vm.js";

export interface ExitCodeSpec {
  readonly command: string;
  /** Expected exit code (default 0). */
  readonly expect?: number;
  readonly timeoutMs?: number;
}
export interface FileExistsSpec {
  /** Path inside the workspace (relative or absolute-within); escapes fail. */
  readonly path: string;
}
export interface RegexMatchSpec {
  readonly pattern: string;
  readonly flags?: string;
  /** Defaults to the task's final text. */
  readonly text?: string;
}
export interface JsonPathSpec {
  /** Dotted/bracketed path into the structured output: `meta.words[0]`. */
  readonly path: string;
  /** When set, the resolved value must deep-equal this. */
  readonly equals?: unknown;
}
export interface ToolUsedSpec {
  readonly tool: string;
}

export type VerifySpec =
  | { readonly exitCode: ExitCodeSpec }
  | { readonly fileExists: FileExistsSpec }
  | { readonly regexMatch: RegexMatchSpec }
  | { readonly jsonPath: JsonPathSpec }
  | { readonly toolUsed: ToolUsedSpec };

export interface VerifyContext {
  readonly workspaceRoot: string;
  /** The task's final text. */
  readonly taskText: string;
  /** The task's validated structured output (absent when none was requested). */
  readonly taskData?: unknown;
  readonly toolsUsed: readonly string[];
  /** Test seam: the shell runner an exitCode spec uses (default: spawn). */
  readonly spawnShell?: (command: string, cwd: string, timeoutMs: number) => Promise<{ code: number | null; timedOut: boolean }>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** win32 Git-sh discovery for verify-command execution (mirrors core's
 *  shell hostShell policy). Null once probed and absent. */
let cachedVerifySh: string | undefined | null;
function windowsShForVerify(): string | undefined {
  if (cachedVerifySh === null) return undefined;
  if (cachedVerifySh !== undefined) return cachedVerifySh;
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "usr", "bin", "sh.exe"),
    join(process.env.LocalAppData ?? "", "Programs", "Git", "usr", "bin", "sh.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedVerifySh = c;
      return c;
    }
  }
  cachedVerifySh = null;
  return undefined;
}

function runShell(command: string, cwd: string, timeoutMs: number): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    // win32: /bin/sh does not exist — Git Bash's sh interprets the POSIX
    // verify commands; without one the receipt reads transport (code null).
    const sh = process.platform === "win32" ? windowsShForVerify() : "/bin/sh";
    if (sh === undefined) {
      resolveRun({ code: null, timedOut: false });
      return;
    }
    const child = spawn(sh, ["-c", command], { cwd, stdio: "ignore", windowsHide: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, timedOut });
    });
    child.on("error", () => {
      clearTimeout(timer);
      // M56 §4: the transport died before reporting a process result — code
      // None, NOT a synthetic 127 (a made-up code would masquerade as a task
      // failure the worker never had).
      resolveRun({ code: null, timedOut });
    });
  });
}

/** Resolve a scorer path inside the workspace; escaping paths fail closed. */
function confinedPath(root: string, rel: string): { ok: true; abs: string } | { ok: false; message: string } {
  const abs = isAbsolute(rel) ? rel : resolve(root, rel);
  const rootAbs = resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) {
    return { ok: false, message: `path escapes the workspace: ${rel}` };
  }
  return { ok: true, abs };
}

/** Resolve a `a.b[0].c` style path against a parsed JSON value. */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((t) => t.length > 0);
  let current: unknown = root;
  for (const token of tokens) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

export async function evaluateVerifySpecs(
  specs: readonly VerifySpec[],
  ctx: VerifyContext,
): Promise<readonly VerifyReceipt[]> {
  const receipts: VerifyReceipt[] = [];
  for (const spec of specs) {
    if ("exitCode" in spec) {
      const s = spec.exitCode;
      const expect = s.expect ?? 0;
      const { code, timedOut } = await (ctx.spawnShell ?? runShell)(s.command, ctx.workspaceRoot, s.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      if (timedOut) {
        receipts.push({ kind: "exitCode", status: "timeout", detail: `command timed out after ${s.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` });
      } else if (code === null) {
        // M56 §4 (Transport vs Task): no process result is a TRANSPORT
        // failure — the worker transport broke, the task never ran to a
        // verdict. Never counted against the task.
        receipts.push({ kind: "exitCode", status: "transport", detail: "no process result (worker transport did not report an exit code)" });
      } else if (code === expect) {
        receipts.push({ kind: "exitCode", status: "pass", detail: `exit ${code}` });
      } else {
        receipts.push({ kind: "exitCode", status: "fail", detail: `exit ${code}, expected ${expect}` });
      }
    } else if ("fileExists" in spec) {
      const s = spec.fileExists;
      const resolved = confinedPath(ctx.workspaceRoot, s.path);
      if (!resolved.ok) {
        receipts.push({ kind: "fileExists", status: "fail", detail: resolved.message });
      } else {
        receipts.push({
          kind: "fileExists",
          status: existsSync(resolved.abs) ? "pass" : "fail",
          detail: s.path,
        });
      }
    } else if ("regexMatch" in spec) {
      const s = spec.regexMatch;
      const text = s.text ?? ctx.taskText;
      let matched = false;
      let detail = s.pattern;
      let verifierFault: string | undefined;
      try {
        matched = new RegExp(s.pattern, s.flags ?? "").test(text);
      } catch (err) {
        // M56 §4: a pattern that does not compile is the SCORER's fault, not
        // the worker's — a verifier failure, never a task failure.
        verifierFault = `invalid pattern: ${err instanceof Error ? err.message : String(err)}`;
        detail = verifierFault;
      }
      receipts.push({
        kind: "regexMatch",
        status: verifierFault !== undefined ? "verifier" : matched ? "pass" : "fail",
        detail,
      });
    } else if ("jsonPath" in spec) {
      const s = spec.jsonPath;
      let data = ctx.taskData;
      if (data === undefined) {
        const extracted = extractStructuredOutput(ctx.taskText);
        if (extracted.ok) data = extracted.value;
      }
      if (data === undefined) {
        receipts.push({ kind: "jsonPath", status: "skip", detail: "no structured output to inspect" });
        continue;
      }
      const value = resolveJsonPath(data, s.path);
      if (value === undefined) {
        receipts.push({ kind: "jsonPath", status: "fail", detail: `${s.path} resolved to nothing` });
      } else if (s.equals !== undefined) {
        const equals = canonicalJson(value) === canonicalJson(s.equals);
        receipts.push({ kind: "jsonPath", status: equals ? "pass" : "fail", detail: `${s.path} = ${canonicalJson(value)}${equals ? "" : `, expected ${canonicalJson(s.equals)}`}` });
      } else {
        receipts.push({ kind: "jsonPath", status: "pass", detail: `${s.path} = ${canonicalJson(value)}` });
      }
    } else if ("toolUsed" in spec) {
      const s = spec.toolUsed;
      const used = ctx.toolsUsed.includes(s.tool);
      receipts.push({
        kind: "toolUsed",
        status: used ? "pass" : "fail",
        detail: used ? s.tool : `${s.tool} not called (used: [${ctx.toolsUsed.join(", ")}])`,
      });
    } else {
      receipts.push({ kind: "unknown", status: "skip", detail: "unrecognized verify spec" });
    }
  }
  return receipts;
}
