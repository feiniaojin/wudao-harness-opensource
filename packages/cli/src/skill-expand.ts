// cc-plugins D2 — the unified invocation-time preprocessor for skills (and,
// through expandCommandTemplate, plugin commands): textual substitutions and
// dynamic shell injection, applied to a body BEFORE it becomes a user turn.
//
// Two stages, one law each:
//
//   expandSubstitutions — PURE. $ARGUMENTS / $ARGUMENTS[N] / $N (0-based,
//     real Claude Code semantics) / a declared $name (positional mapping,
//     argumentSubstitution.ts:111) / ${CLAUDE_SESSION_ID} /
//     ${CLAUDE_SKILL_DIR} / ${CLAUDE_PROJECT_DIR}, with \$ escaping to a
//     literal dollar. A single scanner walk: substituted VALUES are never
//     rescanned (an argument containing "$ARGUMENTS" injects literally).
//
//   expandInjections — the `!`cmd`` (line start / after whitespace) and
//     ```! fenced-block dynamic injections: executed and inlined before the
//     model sees the body, ONE pass over the ORIGINAL text — command output
//     is data, never re-evaluated (promptShellExecution.ts:49-56).
//
// The exec seam: createSkillInjectionExec wires the trust tiers (spec §D —
// personal-tier and user-scope-plugin sources run free; everything else goes
// through the session's NORMAL shell permission pipeline, so an `a`
// answer remembers the approval for the session via the pipeline's own
// session allowlist) and runs the command on the shell shell boundary
// (same cwd/timeout, scrubbed env + the two skill vars).
import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scrubChildEnv, type PermissionDecision } from "@wudao/core";

/** The trust label D1's loader stamps; re-declared structurally so this
 *  module stays import-cycle-free (skills.ts imports HERE for real). */
type SkillOriginLike = "project" | "personal" | "plugin";

/** One skill's invocation context for the substitution pass. */
export interface SkillSubstitutionCtx {
  /** The raw invocation args ("/name <args>" tail), verbatim. */
  readonly args: string;
  /** The skill's own directory (${CLAUDE_SKILL_DIR} — lets bundled scripts
   *  be referenced from the body). */
  readonly skillDir: string;
  /** The agent's working root (${CLAUDE_PROJECT_DIR}). */
  readonly projectDir: string;
  /** The session id (${CLAUDE_SESSION_ID}). */
  readonly sessionId: string;
  /** Declared argument names (frontmatter `arguments:`) — `$name` maps
   *  POSITIONALLY onto the parsed args, exactly CC's mapping. */
  readonly argsDecl?: readonly string[];
}

// ---------------------------------------------------------------------------
// The argument tokenizer — shell-style, quoted multi-word aware
// ---------------------------------------------------------------------------

/** Parse an invocation args string into positional words: whitespace-split
 *  with single/double-quoted multi-word spans kept whole and backslash
 *  escapes honored inside double quotes. `$KEY` tokens survive literally
 *  (args are data, not shell — CC's tryParseShellCommand posture). An
 *  UNBALANCED quote degrades to a plain whitespace split (never throws). */
export function parseSkillArgs(args: string): string[] {
  const text = args.trim();
  if (text === "") return [];
  const out: string[] = [];
  let cur = "";
  let haveTok = false;
  let i = 0;
  let quote: '"' | "'" | undefined;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (quote === "'") {
      // single quotes: fully literal, no escapes
      if (ch === "'") {
        quote = undefined;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = undefined;
        i += 1;
        continue;
      }
      if (ch === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        cur += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      haveTok = true; // an empty quoted string is still a token ("")
      i += 1;
      continue;
    }
    if (ch === "\\" && text[i + 1] !== undefined && !/\s/.test(text[i + 1] ?? "")) {
      cur += text[i + 1] ?? "";
      haveTok = true;
      i += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      if (haveTok || cur !== "") out.push(cur);
      cur = "";
      haveTok = false;
      i += 1;
      continue;
    }
    cur += ch;
    haveTok = true;
    i += 1;
  }
  if (quote !== undefined) return text.split(/\s+/).filter((w) => w !== ""); // unbalanced → plain split
  if (haveTok || cur !== "") out.push(cur);
  return out;
}

/** Windows-path normalization for the dir variables (CC normalizes
 *  backslashes to forward slashes so shell commands don't read them as
 *  escapes); a no-op on posix. */
function toShellPath(p: string): string {
  return process.platform === "win32" ? p.replace(/\\/g, "/") : p;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/** Valid declared names: non-empty and not purely numeric (a numeric name
 *  would collide with the $N shorthand — argumentSubstitution.ts:57). */
function validArgNames(argsDecl: readonly string[] | undefined): readonly string[] {
  return (argsDecl ?? []).filter((n) => n.trim() !== "" && !/^\d+$/.test(n));
}

/** Apply the full substitution set in ONE scanner pass. Substituted values
 *  are appended to the output and never looked at again — a value that
 *  itself contains `$ARGUMENTS` lands literally. `\$` escapes to a literal
 *  dollar anywhere in the body. */
export function expandSubstitutions(body: string, ctx: SkillSubstitutionCtx): string {
  const parsed = parseSkillArgs(ctx.args);
  // Longest-first so $filename is tried before $file at the same position.
  const names = [...validArgNames(ctx.argsDecl)].sort((a, b) => b.length - a.length);
  const skillDir = toShellPath(ctx.skillDir);
  const projectDir = toShellPath(ctx.projectDir);
  let out = "";
  let i = 0;
  while (i < body.length) {
    const ch = body[i] ?? "";
    // \$ → literal $, shielding whatever follows from every rule below.
    if (ch === "\\" && body[i + 1] === "$") {
      out += "$";
      i += 2;
      continue;
    }
    if (ch === "$") {
      // ${...} dir/session variables (longest names first is irrelevant —
      // distinct literals; check each explicitly).
      if (body.startsWith("${CLAUDE_SESSION_ID}", i)) {
        out += ctx.sessionId;
        i += "${CLAUDE_SESSION_ID}".length;
        continue;
      }
      if (body.startsWith("${CLAUDE_SKILL_DIR}", i)) {
        out += skillDir;
        i += "${CLAUDE_SKILL_DIR}".length;
        continue;
      }
      if (body.startsWith("${CLAUDE_PROJECT_DIR}", i)) {
        out += projectDir;
        i += "${CLAUDE_PROJECT_DIR}".length;
        continue;
      }
      // $ARGUMENTS[N] — 0-based indexed (CC semantics).
      if (body.startsWith("$ARGUMENTS[", i)) {
        const m = /^\$ARGUMENTS\[(\d+)\]/.exec(body.slice(i));
        if (m !== null) {
          out += parsed[Number(m[1])] ?? "";
          i += m[0].length;
          continue;
        }
      }
      // $N — the 0-based shorthand; NOT followed by a word char (so $1x stays).
      if (/^\$\d/.test(body.slice(i))) {
        const m = /^\$(\d+)/.exec(body.slice(i));
        if (m !== null && !isWordChar(body[i + m[0].length])) {
          out += parsed[Number(m[1])] ?? "";
          i += m[0].length;
          continue;
        }
      }
      // $name — declared argument at this position's index (CC mapping).
      let matched = false;
      for (const name of names) {
        if (!body.startsWith(`$${name}`, i)) continue;
        const after = body[i + 1 + name.length];
        if (isWordChar(after) || after === "[") continue; // $fileXxx / $file[ not a $file use
        out += parsed[validArgNames(ctx.argsDecl).indexOf(name)] ?? "";
        i += 1 + name.length;
        matched = true;
        break;
      }
      if (matched) continue;
      // $ARGUMENTS — the whole (trimmed) arg string. CC substitutes the raw
      // string; wudao trims the edges (the slash parser's tail whitespace is
      // never meaningful, and every pre-D2 pin expects the trimmed form).
      if (body.startsWith("$ARGUMENTS", i)) {
        out += ctx.args.trim();
        i += "$ARGUMENTS".length;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dynamic injection — !`cmd` and ```! fenced blocks
// ---------------------------------------------------------------------------

// Real-CC patterns (promptShellExecution.ts:49-56): the inline form requires
// line start or whitespace before the bang (no mid-word matches); the fence
// form is a ```! block.
const BLOCK_PATTERN = /```!\s*\n?([\s\S]*?)\n?```/g;
const INLINE_PATTERN = /(?<=^|\s)!`([^`]+)`/gm;

/** The disabled-mode placeholder (CC's disableSkillShellExecution posture:
 *  nothing executes; the command stays visible so the reader knows what was
 *  withheld). */
export function skillInjectionDisabledPlaceholder(command: string): string {
  return `[skill shell execution disabled: ${command}]`;
}

/** Cheap gate: does this body carry ANY injection syntax? (Frontends use it
 *  to keep the no-injection path fully synchronous.) */
export function bodyIncludesInjection(body: string): boolean {
  if (body.includes("```!")) return true;
  if (!body.includes("!`")) return false;
  INLINE_PATTERN.lastIndex = 0;
  return INLINE_PATTERN.test(body);
}

interface InjectionMatch {
  readonly start: number;
  readonly end: number;
  readonly whole: string;
  readonly command: string;
}

/** Collect every injection match over the ORIGINAL body (both forms), sorted
 *  by position, dropping any match that starts inside an earlier one — a
 *  fenced block swallows the inline spans within it. */
function collectInjections(body: string): readonly InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  BLOCK_PATTERN.lastIndex = 0;
  for (const m of body.matchAll(BLOCK_PATTERN)) {
    matches.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, whole: m[0], command: (m[1] ?? "").trim() });
  }
  if (body.includes("!`")) {
    INLINE_PATTERN.lastIndex = 0;
    for (const m of body.matchAll(INLINE_PATTERN)) {
      matches.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, whole: m[0], command: (m[1] ?? "").trim() });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: InjectionMatch[] = [];
  let lastEnd = 0;
  for (const m of matches) {
    if (m.start < lastEnd) continue; // inside the previous (kept) match
    out.push(m);
    lastEnd = m.end;
  }
  return out;
}

/** Execute every dynamic injection and inline its output. ONE pass: the
 *  matches are collected from the ORIGINAL body and spliced in positionally —
 *  output text is never scanned, so an echoed `` !`…` `` lands as literal
 *  data. Commands run in DOCUMENT ORDER (sequential — deterministic approval
 *  order; CC's Promise.all has no ordering guarantee to preserve). An empty
 *  (whitespace-only) command stays verbatim. `disabled` replaces each span
 *  with a placeholder naming the command, executing nothing. A rejected
 *  `exec` propagates — CC's fail-loud posture (a denied/broken injection
 *  fails the invocation rather than silently degrading). */
export async function expandInjections(
  body: string,
  execFn: (cmd: string) => Promise<string>,
  opts?: { readonly disabled?: boolean },
): Promise<string> {
  const matches = collectInjections(body);
  if (matches.length === 0) return body;
  let out = "";
  let lastEnd = 0;
  for (const m of matches) {
    out += body.slice(lastEnd, m.start);
    if (m.command === "") {
      out += m.whole; // whitespace-only command — not an injection
    } else if (opts?.disabled === true) {
      out += skillInjectionDisabledPlaceholder(m.command);
    } else {
      out += await execFn(m.command);
    }
    lastEnd = m.end;
  }
  out += body.slice(lastEnd);
  return out;
}

// ---------------------------------------------------------------------------
// The shell boundary (shell parity)
// ---------------------------------------------------------------------------

/** Run one injection command on the shell shell boundary: `sh -c`
 *  under the workspace root, the shell default 30s timeout, the
 *  credential-scrubbed env plus CLAUDE_SKILL_DIR / CLAUDE_PROJECT_DIR (the
 *  spec's env seam — bundled scripts read them). Output shaping: stdout
 *  trimmed, stderr labeled, a non-zero exit labeled (a failing injection is
 *  DATA the model should see, not a reason to kill the invocation — the
 *  permission DENY is the hard stop). */
export function runSkillInjectionCommand(
  command: string,
  opts: {
    readonly cwd: string;
    readonly timeoutMs?: number;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<string> {
  // win32: skill injections are authored as POSIX sh (`echo $VAR`, `a; b`) —
  // exec's ComSpec default rejects that grammar. Use the discovered Git sh
  // when present (same policy as shell's host path); cmd.exe stands
  // only on machines without Git.
  const shellOpt = process.platform === "win32" ? { ...hostShShell() } : {};
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 1_048_576,
        // windowsHide: no console window for children of the console-less
        // desktop sidecar (closing one would kill the injection command).
        windowsHide: true,
        env: { ...scrubChildEnv(), ...(opts.env ?? {}) },
        ...shellOpt,
      },
      (err, stdout, stderr) => {
        const parts = [String(stdout).trim()];
        const errText = String(stderr).trim();
        if (errText !== "") parts.push(`[stderr] ${errText}`);
        const exit = err === null || err === undefined ? 0 : ((err as { code?: number | string }).code ?? 1);
        if (exit !== 0) {
          parts.push(exit === "ENOENT" ? "[command not found or not executable]" : `[exit ${exit}]`);
        }
        resolve(parts.filter((p) => p !== "").join("\n"));
      },
    );
  });
}

/** win32 Git-sh discovery for the injection exec (mirrors core's
 *  shell hostShell policy; duplicated because cli must not import
 *  core's private helper). */
let cachedInjSh: string | undefined | null;
function hostShShell(): { shell: string } | Record<string, never> {
  if (cachedInjSh === null) return {};
  if (cachedInjSh !== undefined) return { shell: cachedInjSh };
  const candidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
    join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "usr", "bin", "sh.exe"),
    join(process.env.LocalAppData ?? "", "Programs", "Git", "usr", "bin", "sh.exe"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedInjSh = c;
      return { shell: c };
    }
  }
  cachedInjSh = null;
  return {};
}

// ---------------------------------------------------------------------------
// The trust-tiered exec seam
// ---------------------------------------------------------------------------

/** The permission-pipeline seam: the SAME (toolName, input) → decision
 *  contract the session's tool gate implements (REPL baseCanUseTool; the
 *  driver's composed gate). */
export type SkillInjectionDecide = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<PermissionDecision> | PermissionDecision;

export interface SkillInjectionExecDeps {
  /** D1's trust label. Absent reads as "project" — the conservative tier. */
  readonly origin?: SkillOriginLike;
  /** A plugin skill's install scope: user-scope (and flag mounts) are
   *  user trust decisions and run free; project-scope prompts. */
  readonly pluginScope?: "project" | "user" | "flag";
  readonly workspaceRoot: string;
  /** The dir variables for the child env (the text-level substitution
   *  already happened; this is the ENV seam). */
  readonly skillDir?: string;
  readonly projectDir?: string;
  /** shell parity: 30s default. */
  readonly timeoutMs?: number;
  /** The session's permission gate. Absent on an untrusted origin is
   *  fail-closed: every command denies (a frontend with no gate has no
   *  business silently executing plugin shell). */
  readonly decide?: SkillInjectionDecide;
  /** Injection seam for tests / alternate runners. Defaults to the
   *  shell shell boundary. */
  readonly run?: (cmd: string, opts: { cwd: string; timeoutMs?: number; env?: Readonly<Record<string, string>> }) => Promise<string>;
}

/** Is this source TRUSTED for approval-free injection execution? (spec §D:
 *  personal-tier and user-scope sources — the user's own content or their
 *  own install decision; a `--plugin` flag mount is the most explicit user
 *  choice there is.) Everything else — project-tier skills, project-scope
 *  plugins, a missing label — goes through the normal pipeline. */
export function skillInjectionTrusted(origin: SkillOriginLike | undefined, pluginScope: "project" | "user" | "flag" | undefined): boolean {
  if (origin === "personal") return true;
  if (origin === "plugin") return pluginScope === "user" || pluginScope === "flag";
  return false;
}

/** Build the `(cmd) => Promise<string>` exec expandInjections consumes:
 *  trusted sources run directly; everything else is decided through the
 *  session's shell pipeline FIRST (the same gate, the same y/a/N ask,
 *  the same session-allowlist remembering — an `a` answer covers the rest of
 *  the session because the PIPELINE records it, not this seam). A deny
 *  throws, and the command never runs. */
export function createSkillInjectionExec(deps: SkillInjectionExecDeps): (cmd: string) => Promise<string> {
  const run = deps.run ?? runSkillInjectionCommand;
  const env: Record<string, string> = {
    ...(deps.skillDir !== undefined ? { CLAUDE_SKILL_DIR: deps.skillDir } : {}),
    ...(deps.projectDir !== undefined ? { CLAUDE_PROJECT_DIR: deps.projectDir } : {}),
  };
  return async (cmd: string): Promise<string> => {
    if (!skillInjectionTrusted(deps.origin, deps.pluginScope)) {
      if (deps.decide === undefined) {
        throw new Error(`skill injection denied: no permission gate available (${cmd})`);
      }
      const decision = await deps.decide("shell", { command: cmd });
      if (decision.behavior !== "allow") {
        throw new Error(`skill injection denied: ${decision.reason ?? "permission denied"} (${cmd})`);
      }
    }
    return run(cmd, {
      cwd: deps.workspaceRoot,
      ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
    });
  };
}
