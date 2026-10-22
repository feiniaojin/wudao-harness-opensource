// ω99-253: #1 — the workspace's git branch, the status face's read seam.
// ONE `git rev-parse --abbrev-ref HEAD` per read: the branch name verbatim
// on a normal checkout, "HEAD" on a detached one (shown honestly — the
// chip says what git says), null on a non-repo / a missing binary / a
// failed or empty read (null is the ZERO-RENDER semantic: the web chip and
// the TUI segment omit entirely; a failure never throws into the caller).
//
// COST DISCIPLINE (this arc's own ruling, vs the the upstream formatstatusline family's
// per-frame shell calls): the caller caches — the driver reads ONCE at
// boot and re-reads at RUN-SETTLE boundaries + agent-root switches, NEVER
// per status frame (the status channel re-broadcasts far more often than
// the branch can honestly change). The runner is injectable so tests mock
// the spawn (zero real git in the test chain).
//
// Semantics notes (verified against real git):
// - unborn repo (git init, no commits): rev-parse --abbrev-ref HEAD fails
//   → null — the branch face appears once the first commit names the ref;
//   the MODEL-facing git-status note (git-status-note.ts) covers the
//   "No commits yet" wording on its own channel.
// - a linked worktree reports its own checked-out branch (worktrees share
//   nothing here — the read runs against the cwd the caller passes).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hardenedGitArgs } from "./git-hardened.js";

const execFileAsync = promisify(execFile);

/** Subprocess budget for one git call (fail-open on overrun — same bound as
 *  git-status-note.ts's probe). */
const GIT_TIMEOUT_MS = 5000;

/** One git call, the git-status-note contract (locale never parsed):
 *  - result: exit 0, stdout captured.
 *  - null: the git BINARY is missing (ENOENT) — nothing git-shaped here.
 *  - undefined: the command failed (exit ≠ 0 / timeout) — a non-repo among
 *    other things; the caller treats every failure as "no branch face". */
async function runGit(args: readonly string[], cwd: string): Promise<{ stdout: string } | null | undefined> {
  try {
    const { stdout } = await execFileAsync("git", hardenedGitArgs(args), {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout ?? "" };
  } catch (err) {
    if (err !== null && typeof err === "object" && (err as { code?: unknown }).code === "ENOENT") return null;
    return undefined;
  }
}

/** The injectable seam's shape (tests script it; the default spawns). */
export type GitBranchRunner = (args: readonly string[], cwd: string) => Promise<{ stdout: string } | null | undefined>;

/** Read the branch of the repo containing `cwd`.
 *  - the branch name ("main", "feat/x", …)
 *  - "HEAD" on a detached checkout (honest, verbatim)
 *  - null on a non-repo / missing binary / failed or empty read
 *  NEVER throws. */
export async function readGitBranch(cwd: string, run: GitBranchRunner = runGit): Promise<string | null> {
  let out: { stdout: string } | null | undefined;
  try {
    out = await run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  } catch {
    return null; // a throwing runner is a failed read, never a broken caller
  }
  if (out === null || out === undefined) return null;
  const name = out.stdout.trim();
  return name === "" ? null : name;
}
