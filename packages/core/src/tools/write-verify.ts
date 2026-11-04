// M46 §1 — write-verify feedback loop: after a SUCCESSFUL write_file/edit,
// run one per-extension syntax check on the written file and fold the outcome
// into the tool result. Feedback, never a veto: the write already landed, so
// a failed check is NOT isError — the structured error lines simply LEAD the
// result so the model sees "line N is broken" on its very next turn and can
// self-correct without a human round-trip.
//
// Checkers (per extension, everything else silently skips):
//   .json        → in-process JSON.parse
//   .js/.mjs/.cjs→ node --check
//   .ts/.tsx     → tsc --noEmit <file> — OPT-IN (writeVerify.tsTsc; default
//                  off because a single-file tsc run costs seconds, not ms)
//   .py          → python3 -m py_compile (when the binary exists)
//   .sh/.bash    → sh -n
//
// Budget: every spawned checker runs under a wall-clock cap (budgetMs,
// default 500ms). tsc is the documented slow lane and gets its own cap
// (tscBudgetMs, default 10s) — under the shared 500ms it could only ever
// time out, which would make the opt-in useless. A checker that overruns its
// budget is SKIPPED with a note (the write result still returns; the loop is
// never stalled). Missing binaries skip the same way. Checkers spawn via
// execFile with a cached existence probe — core stays zero-dep: the checkers
// are external binaries, not imports.
//
// Error shape: every failure normalizes to `file:line: message` lines
// (≤ MAX_VERIFY_ERRORS), one per distinct diagnostic, parsed from each
// checker's native stderr format. Absent inject config → callers get nothing:
// the feature is opt-in at the tool seam (cli injects; core default is off).
import { execFile } from "node:child_process";
import { realpathSync as realSync } from "node:fs";
import { truncateSafe } from "../text-truncate.js";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { splitJsBin } from "./js-bin.js";

/** Binary overrides — an injection seam for tests/evals (fake tsc, slow sh). */
export interface WriteVerifyBins {
  readonly node?: string;
  readonly tsc?: string;
  readonly python3?: string;
  readonly sh?: string;
}

/** Injected via tool options (the cli resolves settings.json + env into one). */
export interface WriteVerifyConfig {
  readonly enabled: boolean;
  /** Single-file `tsc --noEmit` for .ts/.tsx (default off — slow). */
  readonly tsTsc: boolean;
  /** Wall-clock budget per fast checker. Default 500ms. */
  readonly budgetMs?: number;
  /** tsc's own (slow-lane) budget. Default 10s. */
  readonly tscBudgetMs?: number;
  readonly bins?: WriteVerifyBins;
}

export const DEFAULT_WRITE_VERIFY: WriteVerifyConfig = { enabled: true, tsTsc: false };

/** Structured error lines are capped so one pathological file cannot flood
 *  the result (the model needs the first fixes, not all 500 of them). */
export const MAX_VERIFY_ERRORS = 10;

export type WriteVerifyOutcome =
  | { readonly status: "pass"; readonly checker: string }
  | { readonly status: "fail"; readonly checker: string; readonly errors: readonly string[] }
  | { readonly status: "skip"; readonly checker: string; readonly note?: string };

const DEFAULT_BUDGET_MS = 500;
const DEFAULT_TSC_BUDGET_MS = 10_000;
const PROBE_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Binary existence probe — cached per binary PATH for the process lifetime
// (success AND failure: a missing python3 must not re-probe every write).
// ---------------------------------------------------------------------------

const probeCache = new Map<string, Promise<boolean>>();

function probeBinary(bin: string, argv: readonly string[]): Promise<boolean> {
  const key = `${bin}\x00${argv.join(" ")}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  const { exe, prefix } = splitJsBin(bin);
  const p = new Promise<boolean>((resolve) => {
    execFile(exe, [...prefix, ...argv], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (err) => {
      resolve(err === null);
    });
  });
  probeCache.set(key, p);
  return p;
}

// ---------------------------------------------------------------------------
// One spawned checker run: fixed argv (never a shell), cwd at the file so
// `node --check` resolves the nearest package.json for module type, capped
// output, wall-clock timeout. Returns the exit code + stderr, or undefined
// for a skip (missing binary / timeout, note attached).
// ---------------------------------------------------------------------------

interface CheckRun {
  readonly code: number;
  /** Combined checker output (stdout + stderr): tsc prints diagnostics on
   *  stdout, the rest on stderr — parsers take the union. */
  readonly output: string;
}

function runChecker(args: {
  bin: string;
  binLabel: string;
  probeArgv: readonly string[];
  argv: readonly string[];
  absPath: string;
  budgetMs: number;
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<CheckRun | { skip: string }> {
  return probeBinary(args.bin, args.probeArgv).then((exists) => {
    if (!exists) return { skip: `${args.binLabel} not found` };
    const { exe, prefix } = splitJsBin(args.bin);
    return new Promise<CheckRun | { skip: string }>((resolve) => {
      execFile(
        exe,
        [...prefix, ...args.argv],
        {
          cwd: dirnameOf(args.absPath),
          timeout: args.budgetMs,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          ...(args.extraEnv !== undefined ? { env: { ...process.env, ...args.extraEnv } } : {}),
        },
        (err, stdout, stderr) => {
          if (err === null) {
            resolve({ code: 0, output: combined(stdout, stderr) });
            return;
          }
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
          if (e.killed === true || e.signal === "SIGTERM") {
            resolve({ skip: `${args.binLabel} timed out after ${args.budgetMs}ms` });
            return;
          }
          // A real checker failure carries a numeric exit code; anything else
          // (ENOENT racing the probe, spawn errors) skips rather than fails.
          if (typeof e.code !== "number") return resolve({ skip: `${args.binLabel} failed to run: ${e.message}` });
          resolve({ code: e.code, output: combined(stdout, stderr) });
        },
      );
    });
  });
}

/** stdout + stderr as one diagnostic stream. */
function combined(stdout: unknown, stderr: unknown): string {
  return `${String(stdout ?? "")}${String(stderr ?? "")}`;
}

function dirnameOf(p: string): string {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "." : p.slice(0, idx);
}

// ---------------------------------------------------------------------------
// Per-checker stderr → `file:line: message` extraction. Each parser targets
// its tool's native diagnostic format; matched paths are relativized to the
// workspace when they name the written file (the model addressed it by
// workspace-relative path, so should the feedback).
// ---------------------------------------------------------------------------

/** Workspace-relative display path for a diagnostic. Checkers may report the
 *  REAL path (children resolve symlinks — macOS tmp is /var → /private/var),
 *  so both the given root and its realpath are tried before giving up. */
function displayPath(matched: string, absPath: string, roots: readonly string[]): string {
  const normalized = matched.replace(/\\/g, "/");
  const candidates = new Set<string>([matched, normalized, absPath]);
  for (const root of roots) {
    for (const candidate of candidates) {
      if (candidate === undefined) continue;
      const rel = relative(root, candidate);
      if (rel !== "" && !rel.startsWith("..")) return rel;
    }
  }
  return matched;
}

/** node --check: `path/file.js:2` caret header, then `NameError: message`. */
function parseNodeCheck(stderr: string): { file: string; line: string; msg: string }[] {
  const lines = stderr.split("\n");
  const out: { file: string; line: string; msg: string }[] = [];
  let pending: { file: string; line: string } | undefined;
  for (const line of lines) {
    // CRLF-tolerant (win32 stderr): the trailing \r must not defeat the
    // header's $ anchor.
    const header = /^(.+?):(\d+)\s*\r?$/.exec(line);
    if (header !== null) {
      pending = { file: header[1] ?? "", line: header[2] ?? "1" };
      continue;
    }
    const errLine = /^([A-Za-z]*Error): (.*)\r?$/.exec(line.trim());
    if (errLine !== null && pending !== undefined) {
      out.push({ file: pending.file, line: pending.line, msg: `${errLine[1]}: ${errLine[2]}` });
      pending = undefined;
    }
  }
  return out;
}

/** tsc: `path/file.ts(12,5): error TS2322: message` — one line per error. */
function parseTsc(stderr: string): { file: string; line: string; msg: string }[] {
  const out: { file: string; line: string; msg: string }[] = [];
  for (const line of stderr.split("\n")) {
    const m = /^(\S.*?)\((\d+),\d+\): (error TS\d+: .*)\r?$/.exec(line.trim());
    if (m !== null) out.push({ file: m[1] ?? "", line: m[2] ?? "1", msg: m[3] ?? "" });
  }
  return out;
}

/** python3: `  File "path", line 2` header, then `SyntaxError: message`. */
function parsePython(stderr: string): { file: string; line: string; msg: string }[] {
  const out: { file: string; line: string; msg: string }[] = [];
  let pending: { file: string; line: string } | undefined;
  for (const line of stderr.split("\n")) {
    // CRLF-tolerant header: win32 stderr carries \r line endings.
    const header = /^\s*File "(.+?)", line (\d+)\s*\r?$/.exec(line);
    if (header !== null) {
      pending = { file: header[1] ?? "", line: header[2] ?? "1" };
      continue;
    }
    const errLine = /^\s*([A-Za-z]*Error): (.*)\r?$/.exec(line);
    if (errLine !== null && pending !== undefined) {
      out.push({ file: pending.file, line: pending.line, msg: `${errLine[1]}: ${errLine[2]}` });
      pending = undefined;
    }
  }
  return out;
}

/** sh -n (the repeat echo line is the same error):
 *  bash — `path: line 3: message`；dash（Debian 系 /bin/sh）— `path: 3: Syntax error: "(" unexpected`
 *  （无 "line" 词，消息以 Syntax error 起——只认这个形状，避免把任意 `path: n: …`
 *  输出误当诊断）。 */
function parseSh(stderr: string): { file: string; line: string; msg: string }[] {
  for (const line of stderr.split("\n")) {
    const t = line.trim();
    const m = /^(.+?): line (\d+): (.*)$/.exec(t) ?? /^(.+?): (\d+): (Syntax [Ee]rror.*)$/.exec(t);
    if (m !== null) return [{ file: m[1] ?? "", line: m[2] ?? "1", msg: m[3] ?? "" }];
  }
  return [];
}

/** JSON.parse: V8 message → line (from `(line N column M)` or byte position). */
function jsonErrorLine(message: string, content: string): string {
  const lc = /\(line (\d+) column \d+\)/.exec(message);
  if (lc !== null) return lc[1] ?? "1";
  const pos = /at position (\d+)/.exec(message);
  if (pos !== null) {
    const at = Number(pos[1]);
    if (Number.isFinite(at)) return String(content.slice(0, at).split("\n").length);
  }
  return "1";
}

// ---------------------------------------------------------------------------
// The verifier. Never throws — an unexpected internal error is a silent skip
// (feedback must not break the write path it decorates).
// ---------------------------------------------------------------------------

export async function verifyWrittenFile(args: {
  readonly absPath: string;
  readonly content: string;
  readonly workspaceRoot: string;
  readonly config: WriteVerifyConfig;
}): Promise<WriteVerifyOutcome> {
  try {
    const { absPath, content, config } = args;
    if (!config.enabled) return { status: "skip", checker: "off" };
    const roots = workspaceRoots(args.workspaceRoot);
    const ext = absPath.slice(absPath.lastIndexOf(".") + 1).toLowerCase();
    const budgetMs = config.budgetMs ?? DEFAULT_BUDGET_MS;
    const bins = config.bins ?? {};

    const fromParsed = (
      parsed: readonly { file: string; line: string; msg: string }[],
      checker: string,
      run: CheckRun,
    ): WriteVerifyOutcome => {
      if (run.code === 0 && parsed.length === 0) return { status: "pass", checker };
      const shown = parsed.length > 0
        ? parsed.slice(0, MAX_VERIFY_ERRORS).map((e) => `${displayPath(e.file, absPath, roots)}:${e.line}: ${e.msg}`)
        // Unparsed failure (a format drift, an exotic crash): still FAIL with
        // the checker's first stderr line — a checker that ran and exited
        // non-zero must never masquerade as a pass.
        : [`${displayPath(absPath, absPath, roots)}:1: ${checker} failed (exit ${run.code}): ${firstText(run.output)}`];
      return { status: "fail", checker, errors: shown };
    };

    if (ext === "json") {
      try {
        JSON.parse(content);
        return { status: "pass", checker: "json" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const line = jsonErrorLine(message, content);
        return { status: "fail", checker: "json", errors: [`${displayPath(absPath, absPath, roots)}:${line}: ${message}`] };
      }
    }

    if (ext === "js" || ext === "mjs" || ext === "cjs") {
      const run = await runChecker({
        bin: bins.node ?? "node",
        binLabel: "node --check",
        probeArgv: ["--version"],
        argv: ["--check", absPath],
        absPath,
        budgetMs,
      });
      if ("skip" in run) return { status: "skip", checker: "node --check", note: run.skip };
      if (run.code === 0) return { status: "pass", checker: "node --check" };
      return fromParsed(parseNodeCheck(run.output), "node --check", run);
    }

    if (ext === "ts" || ext === "tsx") {
      if (!config.tsTsc) return { status: "skip", checker: "tsc" }; // gated off — silent
      const run = await runChecker({
        bin: bins.tsc ?? "tsc",
        binLabel: "tsc",
        probeArgv: ["--version"],
        argv: ["--noEmit", absPath],
        absPath,
        budgetMs: config.tscBudgetMs ?? DEFAULT_TSC_BUDGET_MS,
      });
      if ("skip" in run) return { status: "skip", checker: "tsc", note: run.skip };
      if (run.code === 0) return { status: "pass", checker: "tsc" };
      return fromParsed(parseTsc(run.output), "tsc", run);
    }

    if (ext === "py") {
      const run = await runChecker({
        bin: bins.python3 ?? "python3",
        binLabel: "py_compile",
        probeArgv: ["--version"],
        argv: ["-m", "py_compile", absPath],
        absPath,
        budgetMs,
        // Keep __pycache__ out of the user's workspace: the compile cache
        // mirrors into a tmp tree instead of landing next to the source.
        extraEnv: { PYTHONPYCACHEPREFIX: joinTmp("wudao-verify-pyc") },
      });
      if ("skip" in run) return { status: "skip", checker: "py_compile", note: run.skip };
      if (run.code === 0) return { status: "pass", checker: "py_compile" };
      return fromParsed(parsePython(run.output), "py_compile", run);
    }

    if (ext === "sh" || ext === "bash") {
      const run = await runChecker({
        bin: bins.sh ?? "sh",
        binLabel: "sh -n",
        probeArgv: ["-c", "true"],
        argv: ["-n", absPath],
        absPath,
        budgetMs,
      });
      if ("skip" in run) return { status: "skip", checker: "sh -n", note: run.skip };
      if (run.code === 0) return { status: "pass", checker: "sh -n" };
      return fromParsed(parseSh(run.output), "sh -n", run);
    }

    return { status: "skip", checker: "none" }; // unknown extension — silent
  } catch {
    return { status: "skip", checker: "none" };
  }
}

/** The workspace root plus its realpath (best-effort) for path relativization. */
function workspaceRoots(workspaceRoot: string): readonly string[] {
  try {
    const real = realSync(workspaceRoot);
    return real === workspaceRoot ? [workspaceRoot] : [workspaceRoot, real];
  } catch {
    return [workspaceRoot];
  }
}

function joinTmp(dir: string): string {
  return `${tmpdir().replace(/\/+$/, "")}/${dir}`;
}

/** First non-empty stderr line, clamped — used only by the unparsed-failure
 *  fallback so a format drift still surfaces one readable line. */
function firstText(stderr: string): string {
  const first = stderr.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  return first.length > 200 ? `${truncateSafe(first, 200)}…` : first || "(no output)"; // 113-A4
}

// ---------------------------------------------------------------------------
// Result shaping — the single source for every receipt string (tests pin
// these byte-for-byte).
// ---------------------------------------------------------------------------

/** The receipt/skip marker line; "" when there is nothing to say. */
export function writeVerifyMarker(outcome: WriteVerifyOutcome): string {
  if (outcome.status === "pass") return `[verified: ${outcome.checker} ok]`;
  if (outcome.status === "fail") {
    const n = outcome.errors.length;
    return `[verified: ${outcome.checker} ${n} error${n === 1 ? "" : "s"}]`;
  }
  return outcome.note === undefined ? "" : `[verify skipped: ${outcome.note}]`;
}

/** Fold an outcome into a tool's success result. On failure the structured
 *  error lines LEAD (visibility), then the receipt, then the tool's own
 *  success text. Otherwise the marker appends. */
export function shapeVerifiedResult(base: string, outcome: WriteVerifyOutcome): string {
  const marker = writeVerifyMarker(outcome);
  if (outcome.status === "fail") {
    const shown = outcome.errors.slice(0, MAX_VERIFY_ERRORS);
    return `${shown.join("\n")}\n${marker}\n${base}`;
  }
  return marker === "" ? base : `${base}\n${marker}`;
}

// ---------------------------------------------------------------------------
// M51 §2 — diagnostic baseline-diff seam. write-verify answers "is this file
// still syntactically valid"; diagnostics answers "what did THIS edit newly
// break". The layer (implemented in the cli — core stays policy-free) captures
// a per-file BASELINE of diagnostic lines before the write lands, then diffs
// the post-write verify outcome against it: only NEW lines ride the result.
// Two layers, two labels — both feedback, never isError, never a veto.
// ---------------------------------------------------------------------------

/** Per-file cap on new-only diagnostic lines (a pathological edit must not
 *  flood the result — the model needs the first fixes, not all of them). */
export const MAX_NEW_DIAGNOSTICS_PER_FILE = 10;

/** Per-turn cap across files (the rolling window is the cli layer's). */
export const MAX_NEW_DIAGNOSTICS_PER_TURN = 30;

/** The injection seam the write/edit tools call around a successful write.
 *  `beforeWrite` runs BEFORE the bytes land (the baseline checkers read the
 *  on-disk pre-write state); `afterWrite` receives the M46 verify outcome of
 *  the written content and returns the NEW-only lines (already capped). */
export interface DiagnosticsLayer {
  beforeWrite(absPath: string): Promise<void>;
  afterWrite(event: {
    readonly absPath: string;
    readonly outcome: WriteVerifyOutcome;
  }): Promise<readonly string[]>;
}

/** The source-labeled section marker for new-only diagnostic lines. */
export function diagnosticsMarker(count: number): string {
  return `[diagnostics new: ${count}]`;
}

/** Append the diagnostics section after the (already verify-shaped) result.
 *  Empty input returns the base untouched — a clean write shows nothing. */
export function appendDiagnosticsLines(base: string, lines: readonly string[]): string {
  if (lines.length === 0) return base;
  return `${base}\n${diagnosticsMarker(lines.length)}\n${lines.join("\n")}`;
}
