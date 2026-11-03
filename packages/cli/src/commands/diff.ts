// M55 §A5 — /diff: two change surfaces in one view.
//   1. git uncommitted: `git status --porcelain` (the file list) plus
//      `git diff --stat` / `git diff --cached --stat` (the magnitude lines).
//   2. the session's per-turn file changes from the rewind journal
//      (FileHistory — the same list /rewind renders; /rewind <n> undoes).
// execFile-style (no shell), cwd=workspaceRoot; a non-repo workspace is a
// first-class state, not an error. The git seam is injectable for tests.
import { execFile } from "node:child_process";
import { relative } from "node:path";
import type { FileHistory, FileHistoryEntry } from "@wudao-org/core";

/** One git invocation: resolves with stdout, rejects on a non-zero exit. */
export type GitFn = (args: readonly string[]) => Promise<string>;

const GIT_TIMEOUT_MS = 5_000;
const MAX_PORCELAIN_LINES = 50;

/** The real git seam (cwd = workspaceRoot, no shell, bounded wait). */
export function createGitFn(workspaceRoot: string): GitFn {
  return (args) =>
    new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        [...args],
        { cwd: workspaceRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (err !== null) {
            const message = stderr !== "" ? stderr : err.message;
            reject(new Error(message));
            return;
          }
          resolve(stdout);
        },
      );
    });
}

export interface GitUncommitted {
  /** false when the workspace is not inside a git repository. */
  readonly repo: boolean;
  readonly porcelain: readonly string[];
  /** `git diff --stat` body ("" when nothing unstaged). */
  readonly statUnstaged: string;
  /** `git diff --cached --stat` body ("" when nothing staged). */
  readonly statStaged: string;
  /** Set when a git invocation failed for a non-repo reason. */
  readonly error?: string;
}

/** Locale-independent repo probe: `rev-parse --is-inside-work-tree` exits
 *  non-zero outside a repository under EVERY git locale (message matching is
 *  not — a Chinese-locale git says 不是 git 仓库). Lives HERE (diff.ts) so
 *  both /diff and /review share one canonical probe; review.ts re-exports it
 *  for its existing importers. */
export async function insideWorkTree(git: GitFn): Promise<boolean> {
  try {
    return (await git(["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

/** Collect the git surface (never throws — failures land in `error`). Repo
 *  presence is decided by the structural probe above, never by stderr text
 *  (review fix: a Chinese-locale git misclassified non-repo as "git error"). */
export async function collectGitUncommitted(git: GitFn): Promise<GitUncommitted> {
  if (!(await insideWorkTree(git))) {
    return { repo: false, porcelain: [], statUnstaged: "", statStaged: "" };
  }
  try {
    const porcelain = (await git(["status", "--porcelain"]))
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l !== "");
    const [statUnstaged, statStaged] = await Promise.all([
      git(["diff", "--stat"]).then((s) => s.trim()).catch(() => ""),
      git(["diff", "--cached", "--stat"]).then((s) => s.trim()).catch(() => ""),
    ]);
    return { repo: true, porcelain, statUnstaged, statStaged };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { repo: true, porcelain: [], statUnstaged: "", statStaged: "", error: message };
  }
}

/** Workspace-relative display path (absolute when outside the root). */
function displayPath(file: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, file);
  return rel.startsWith("..") ? file : rel;
}

const SESSION_FILE_LIST_CAP = 12;

/** The /diff report (notice-rendered). Pure: git/journal data come in
 *  pre-collected so tests pin the shape without touching git. */
export function formatDiffReport(args: {
  readonly git: GitUncommitted;
  readonly sessionChanges: readonly FileHistoryEntry[];
  readonly workspaceRoot: string;
}): string {
  const lines: string[] = ["diff:"];
  // 1. git uncommitted.
  if (!args.git.repo) {
    lines.push("  git: (not a git repository)");
  } else if (args.git.error !== undefined) {
    lines.push(`  git: (git failed: ${args.git.error.split("\n")[0] ?? args.git.error})`);
  } else if (args.git.porcelain.length === 0) {
    lines.push("  git: (clean — no uncommitted changes)");
  } else {
    lines.push("  git (uncommitted):");
    const shown = args.git.porcelain.slice(0, MAX_PORCELAIN_LINES);
    for (const l of shown) lines.push(`    ${l}`);
    const more = args.git.porcelain.length - shown.length;
    if (more > 0) lines.push(`    (… ${more} more — git status for the full list)`);
    if (args.git.statUnstaged !== "") {
      lines.push("    -- diff --stat (unstaged) --");
      for (const l of args.git.statUnstaged.split("\n")) lines.push(`    ${l}`);
    }
    if (args.git.statStaged !== "") {
      lines.push("    -- diff --cached --stat (staged) --");
      for (const l of args.git.statStaged.split("\n")) lines.push(`    ${l}`);
    }
  }
  // 2. the session's file journal (the /rewind data face).
  if (args.sessionChanges.length === 0) {
    lines.push("  session files: (no file changes recorded this session)");
  } else {
    const files = [...new Set(args.sessionChanges.map((e) => displayPath(e.file, args.workspaceRoot)))];
    const shown = files.slice(0, SESSION_FILE_LIST_CAP);
    const more = files.length - shown.length;
    lines.push(
      `  session files: ${args.sessionChanges.length} step(s) across ${files.length} file(s) — ${shown.join(", ")}${more > 0 ? ` (… ${more} more)` : ""}`,
    );
    lines.push('    ("/rewind" lists the steps; "/rewind <n>" restores the state before step n)');
  }
  return lines.join("\n");
}

/** End-to-end /diff: real git + the session's file history (when wired). */
export async function runDiffCommand(args: {
  readonly workspaceRoot: string;
  readonly fileHistory?: FileHistory;
  readonly git?: GitFn;
}): Promise<string> {
  const git = await collectGitUncommitted(args.git ?? createGitFn(args.workspaceRoot));
  const sessionChanges = args.fileHistory !== undefined ? await args.fileHistory.list() : [];
  return formatDiffReport({ git, sessionChanges, workspaceRoot: args.workspaceRoot });
}
