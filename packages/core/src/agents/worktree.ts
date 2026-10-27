// M30 §D — per-child git worktree isolation. A role profile with
// `worktree: true` runs its children in `.wudao/wt/<runId>/<role>-<n>` on
// branch `wudao/<runId>/<role>-<n>`, so concurrent writers never share a
// working tree. Every failure is FAIL-OPEN: no git repo, or a git error,
// means the child simply stays in the main workspace (with a warning) —
// isolation is an optimization, not a precondition for dispatch.
//
// Cleanup uses `git worktree remove` + `git branch -d` and NEVER `-D`: an
// unmerged branch is left in place and reported, so a child's work is always
// recoverable.

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;

export interface ChildWorktree {
  /** Absolute path of the child's working tree (the child's workspaceRoot). */
  readonly path: string;
  /** The branch checked out there (`wudao/<run>/<role>-<n>`). */
  readonly branch: string;
}

export interface WorktreeOptions {
  /** Warning channel for every fail-open degradation. */
  readonly onWarning?: (message: string) => void;
}

export interface WorktreeCleanup {
  /** True iff `git worktree remove` succeeded. */
  readonly removed: boolean;
  /** The branch that was checked out in the worktree, when discoverable. */
  readonly branch?: string;
  /** True iff `git branch -d` deleted the branch (never forced). */
  readonly branchDeleted: boolean;
  /** Why full cleanup did not happen (unmerged branch left, dirty tree, …). */
  readonly reason?: string;
}

const warn = (options: WorktreeOptions | undefined, message: string): void => {
  (options?.onWarning ?? ((m: string) => console.warn(`[worktree] ${m}`)))(message);
};

// Branch names and directory segments share one sanitized vocabulary:
// anything outside [A-Za-z0-9._-] collapses to "-".
function slugify(part: string): string {
  const slug = part.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "x";
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFile("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
    return { ok: true, stdout };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}

async function isGitWorkspace(root: string): Promise<boolean> {
  // A repo's `.git` may be a directory (normal) or a file (linked worktree).
  try {
    const s = await stat(join(root, ".git"));
    return s.isFile() || s.isDirectory();
  } catch {
    return false;
  }
}

/** Create a child worktree under `.wudao/wt/<runId>/<role>-<n>`. `<n>` is
 *  derived from the existing siblings of that role in this run, so ids stay
 *  deterministic without hidden state. Returns undefined (with a warning)
 *  when the workspace has no git repo or git fails — the caller then runs
 *  the child in the main workspace. */
export async function createChildWorktree(
  workspaceRoot: string,
  runId: string,
  roleSlug: string,
  options: WorktreeOptions = {},
): Promise<ChildWorktree | undefined> {
  if (!(await isGitWorkspace(workspaceRoot))) {
    warn(options, `no git repository at ${workspaceRoot} — child stays in the main workspace (worktree isolation unavailable)`);
    return undefined;
  }
  const run = slugify(runId);
  const role = slugify(roleSlug);
  const runDir = join(workspaceRoot, ".wudao", "wt", run);

  // <n> = highest existing suffix + 1 (NOT count+1): a cleaned-up slot frees
  // its number, but a LIVE sibling must never be collided with.
  let n = 1;
  try {
    const siblings = await readdir(runDir);
    for (const name of siblings) {
      const match = name.match(new RegExp(`^${escapeRe(role)}-(\\d+)$`));
      if (match) n = Math.max(n, Number(match[1]) + 1);
    }
  } catch {
    // No run dir yet → n stays 1.
  }

  const suffix = `${role}-${n}`;
  const path = join(runDir, suffix);
  const branch = `wudao/${run}/${suffix}`;

  // execFile arg-array: git is spawned directly, never through a shell, so
  // no path/branch string can be re-interpreted as shell syntax.
  const result = await runGit(workspaceRoot, ["worktree", "add", "-b", branch, path]);
  if (!result.ok) {
    warn(options, `git worktree add failed for ${branch} (${firstLine(result.error)}) — child stays in the main workspace`);
    return undefined;
  }
  return { path: resolve(path), branch };
}

/** Remove a child worktree and delete its branch — `git worktree remove` +
 *  `git branch -d`, NEVER `-D`. An unmerged (or dirty-tree) cleanup leaves
 *  the branch/worktree in place and reports why; the child's work is never
 *  destroyed. */
export async function removeChildWorktree(
  path: string,
  options: WorktreeOptions = {},
): Promise<WorktreeCleanup> {
  // Discover the checked-out branch and the main repo root BEFORE removing
  // anything — after removal both are gone with the directory.
  const branchResult = await runGit(path, ["branch", "--show-current"]);
  const branch = branchResult.ok ? branchResult.stdout.trim() : undefined;
  const commonDir = await runGit(path, ["rev-parse", "--git-common-dir"]);
  if (!commonDir.ok) {
    const reason = `not a git worktree: ${firstLine(commonDir.error)}`;
    warn(options, `worktree cleanup skipped — ${reason}`);
    return { removed: false, branch, branchDeleted: false, reason };
  }
  const mainRoot = dirname(resolve(path, commonDir.stdout.trim()));

  const remove = await runGit(mainRoot, ["worktree", "remove", path]);
  if (!remove.ok) {
    const reason = `git worktree remove failed: ${firstLine(remove.error)}`;
    warn(options, reason);
    return { removed: false, branch, branchDeleted: false, reason };
  }

  if (branch === undefined || branch === "") {
    return { removed: true, branch: branch || undefined, branchDeleted: true };
  }
  const del = await runGit(mainRoot, ["branch", "-d", branch]);
  if (!del.ok) {
    // Deliberately NOT -D: the branch holds the child's (unmerged) work.
    // Leave it and report — a human decides whether it is disposable.
    const reason = `unmerged branch ${branch} left in place (git branch -d refused: ${firstLine(del.error)})`;
    warn(options, reason);
    return { removed: true, branch, branchDeleted: false, reason };
  }
  return { removed: true, branch, branchDeleted: true };
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
