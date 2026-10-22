// ω-4d (import-queue item 17; design 61) — login-shell env snapshot, PURE
// module. Codex's shell_snapshot.rs techniques adapted to the env half only:
// per-shell rc preambles, a NUL marker separating rc stdout noise from the
// `/usr/bin/env -0` dump, the upstream project's output budget/timeout constants, and the
// snapshot-wins merge precedence. This module spawns NOTHING and reads NO
// process state — the spawn (and its scrubbed env) is injected by the cli
// runtime (packages/cli/src/shell-snapshot.ts), so every behavior here is
// testable with fixture NUL dumps alone.
//
// What is deliberately NOT here (design 61 §3.1): the state-script half
// (functions/setopts/aliases) and its chunked env-var transport — wudao's
// shell stays non-interactive `/bin/sh -c`, which sources no rc file,
// so capture-then-merge applies the rc exactly once by construction; the upstream project's
// `-lc`→`-pc`/`-fc` flag swap exists only because its exec re-runs the user's
// login shell. Ours never did.

/** Hard output budget for one capture (the upstream projectexec-server MAX_SNAPSHOT_BYTES). */
export const LOGIN_SHELL_SNAPSHOT_MAX_BYTES = 512 * 1024;
/** Hard wall-clock bound for one capture (the upstream projectSNAPSHOT_TIMEOUT). */
export const LOGIN_SHELL_SNAPSHOT_TIMEOUT_MS = 10_000;

/** The shells whose rc files wudao knows how to capture. Anything else
 *  (fish, powershell, cmd, …) → the feature is absent, behavior is
 *  byte-identical to the pre-ω-4d tool. */
export type LoginShellKind = "zsh" | "bash" | "sh";

/** Basename → kind, with versioned stems reduced (`zsh-5.9` → `zsh`) the way
 *  the upstream project's detect_shell_type recurses on file stems. Unsupported or empty →
 *  undefined. Pure: no fs, no env. */
export function loginShellKindFromPath(shellPath: string): LoginShellKind | undefined {
  const base = shellPath.split(/[\\/]/).pop() ?? "";
  if (base === "") return undefined;
  // Reduce version/decoration tails segment by segment (`zsh-5.9`, `bash-5`)
  // — the first dotted/dashed segment is the shell name.
  const first = base.split(/[-.]/)[0] ?? "";
  if (first === "zsh") return "zsh";
  if (first === "bash") return "bash";
  if (first === "sh") return "sh";
  return undefined;
}

/** The capture script for one shell kind: source the rc file(s) a login shell
 *  would have applied (the upstream projectparity: zsh → .zshrc — NOT .zprofile; bash →
 *  .bashrc — NOT .bash_profile, and only when BASH_ENV is unset so a
 *  BASH_ENV-sourced rc is not applied twice; sh → $ENV when set), then emit
 *  one NUL marker and the exported env NUL-delimited via `/usr/bin/env -0`.
 *
 *  Hardening (the upstream projectshell_snapshot.rs): the dump is invoked by ABSOLUTE path
 *  so an rc-defined function or PATH shim cannot shadow it; every other
 *  command word is a shell builtin (`[[`/`[`, `.`, `printf`). `env -0`
 *  unsupported or `/usr/bin/env` absent → non-zero exit → the runtime fails
 *  open to no snapshot. Pre-NUL stdout (motd, fortune, rc chatter) is noise
 *  the parser discards — it never reaches the model. */
export function buildLoginShellCaptureScript(kind: LoginShellKind): string {
  switch (kind) {
    case "zsh":
      return [
        'if [[ -n "$ZDOTDIR" ]]; then',
        '  rc="$ZDOTDIR/.zshrc"',
        "else",
        '  rc="$HOME/.zshrc"',
        "fi",
        '[[ -r "$rc" ]] && . "$rc"',
        "printf '\\0'",
        "/usr/bin/env -0",
        "",
      ].join("\n");
    case "bash":
      return [
        'if [ -z "$BASH_ENV" ] && [ -r "$HOME/.bashrc" ]; then',
        '  . "$HOME/.bashrc"',
        "fi",
        "printf '\\0'",
        "/usr/bin/env -0",
        "",
      ].join("\n");
    case "sh":
      return [
        'if [ -n "$ENV" ] && [ -r "$ENV" ]; then',
        '  . "$ENV"',
        "fi",
        "printf '\\0'",
        "/usr/bin/env -0",
        "",
      ].join("\n");
  }
}

/** Parse one capture's stdout: everything before the FIRST NUL byte is rc
 *  noise and is discarded; after it, entries split on NUL and then on the
 *  FIRST `=`. Names must match the shell-identifier shape the upstream project's awk filter
 *  uses (`/^[A-Za-z_][A-Za-z0-9_]*$/`); invalid names and empty tails are
 *  dropped. No NUL present, or nothing usable after it → undefined — the
 *  runtime fails open to NO snapshot, never a partial env.
 *
 *  This function does NOT scrub: parsing and policy are separate (the §5
 *  case-3 pin); exclusions and credential rules live in scrubSnapshotEnv. */
export function parseLoginShellEnvOutput(output: string): Readonly<Record<string, string>> | undefined {
  const marker = output.indexOf("\0");
  if (marker < 0) return undefined;
  const entries = output.slice(marker + 1).split("\0");
  const parsed: Record<string, string> = {};
  for (const entry of entries) {
    if (entry === "") continue; // trailing NUL / empty tail
    const eq = entry.indexOf("=");
    if (eq <= 0) continue; // no '=' (empty name or bare token)
    const name = entry.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    parsed[name] = entry.slice(eq + 1);
  }
  if (Object.keys(parsed).length === 0) return undefined;
  return parsed;
}

// Credential-shaped scrub rules — the SAME ones shell's scrubChildEnv
// applies to every harness-spawned child (`*API_KEY`/`*ACCESS_KEY`/
// `*TOKEN`/`*SECRET`/`*PASSWORD`/`*CREDENTIALS` suffixes, `WUDAO_*`/
// `OPENAI_*` prefixes). Defined ONCE here so the wall cannot drift between
// the two call sites: shell's process-env scrub delegates to this, the
// cli runtime scrubs the capture child's env with it, and scrubSnapshotEnv
// applies it to rc-exported values — a key exported in `.zshrc` is
// indistinguishable from one in the process env to a `printenv`-exfiltrating
// model, so both sides of the merge are scrubbed and the product is (the
// §5 case-4 "both directions" pin).
const SENSITIVE_SUFFIX = /(API_KEY|ACCESS_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS)$/i;
const SENSITIVE_PREFIX = /^(WUDAO_|OPENAI_)/;

/** The credential scrub over an arbitrary env record (scrubChildEnv's rules,
 *  parameterized — it reads no process state). Returns a fresh object. */
export function scrubChildEnvOf(env: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SENSITIVE_SUFFIX.test(k) || SENSITIVE_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Snapshot-only exclusions, ON TOP of the credential rules:
// - `PWD`/`OLDPWD` (the upstream projectEXCLUDED_EXPORT_VARS): stale cwd bookkeeping — the
//   exec sets its own cwd (workspaceRoot).
// - `BASH_ENV`/`ENV`/`ZDOTDIR`: interpreter RE-ENTRY hazards. Leaking them
//   into the child would make every subsequent non-interactive `sh -c`/bash
//   child source an rc file AGAIN — the exact double-sourcing the upstream project's
//   `-pc`/`-fc` flag swap exists to prevent; ours prevents it by dropping the
//   steering variables instead.
// - `_`: a capture artifact naming `/usr/bin/env` itself.
const SNAPSHOT_EXCLUDED_VARS = new Set(["PWD", "OLDPWD", "BASH_ENV", "ENV", "ZDOTDIR", "_"]);

/** Scrub one parsed snapshot to the vars a child may see: the exclusions
 *  above plus the credential rules (see scrubChildEnvOf). Fresh object. */
export function scrubSnapshotEnv(snapshot: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(snapshot)) {
    if (SNAPSHOT_EXCLUDED_VARS.has(k)) continue;
    if (SENSITIVE_SUFFIX.test(k) || SENSITIVE_PREFIX.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Merge the (already scrubbed) snapshot OVER the base env — the SNAPSHOT
 *  WINS (the upstream project's restore precedence: the snapshot extends the prepared env).
 *  Terminal fidelity is the definition: where the launch env and the rc env
 *  differ, the rc env is what the user's terminal would have. Future seam
 *  (not v1): per-request overrides would win over the snapshot, applied
 *  AFTER this merge. */
export function mergeLoginShellEnv(
  base: NodeJS.ProcessEnv,
  scrubbed: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  return { ...base, ...scrubbed };
}
