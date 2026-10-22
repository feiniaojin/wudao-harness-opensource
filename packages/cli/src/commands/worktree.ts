// P1-7 (96 队列) — /worktree: the main session's isolated worktree. core's
// createChildWorktree/removeChildWorktree (M30, the child-agent machinery)
// are the engine — this module is the CLI ADAPTER, so core's signatures and
// the child-agent usage stay byte-identical. Mapping: a main-session
// worktree is `runId="main"`, `roleSlug=<name>` — directory
// `<toplevel>/.wudao/wt/main/<name>-<n>`, branch `wudao/main/<name>-<n>`,
// sharing the child worktrees' ONE namespace (no parallel .wudao/worktrees
// tree to interleave with `git worktree list`).
//
// The discipline (the /provider template): the switch is a TURN-BOUNDARY op
// — enter/exit park behind a busy run and land at its settle. Persistence is
// NEVER switched: sessions/exports/costs stay pinned to the session root
// (red line 1) — only the OPERATION root (tool cwd / permission workspace /
// extension face) moves. remove is fail-closed twice over: an explicit
// uncommitted-changes guard here, and core's never-`-D` branch deletion.
import { execFile as execFileCb } from "node:child_process";
import { hardenedGitArgs } from "../git-hardened.js";
import { promisify } from "node:util";
import { join } from "node:path";
import { createJsonlSessionStore, createChildWorktree, removeChildWorktree } from "@wudao/core";
import type { WorktreeCleanup } from "@wudao/core";

const execFile = promisify(execFileCb);

const GIT_TIMEOUT_MS = 30_000;

/** The landed worktree the driver tracks (bare /worktree's status face). */
export interface MainWorktree {
  /** Absolute path of the worktree (the switched operation root). */
  readonly path: string;
  /** The branch checked out there (`wudao/main/<name>-<n>`). */
  readonly branch: string;
  /** The user-facing name (the sanitized slug). */
  readonly name: string;
}

export type MainWorktreeEnter =
  | { readonly ok: true; readonly worktree: MainWorktree }
  | { readonly ok: false; readonly error: string };

async function runGit(cwd: string, args: string[]): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  try {
    const { stdout } = await execFile("git", hardenedGitArgs(args), { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true });
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The git toplevel containing `cwd` (undefined = no enclosing repository —
 *  hard constraint 3's gate). Sessions often start in a subdirectory; the
 *  worktree must hang off the REPO's .wudao, not the subdir's. */
export async function resolveGitToplevel(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!r.ok) return undefined;
  const top = r.stdout.trim();
  return top === "" ? undefined : top;
}

/** Enter: create the worktree (new branch at HEAD) under the repo's
 *  `.wudao/wt/main/`. `<name>` is required non-empty — the AUTO name
 *  (`session-<id8>`) is the driver's derivation (it owns the session id).
 *  A git failure (e.g. the branch already exists from a kept worktree with
 *  the same slug) surfaces as a typed error naming the fix. */
export async function enterMainWorktree(cwd: string, name: string): Promise<MainWorktreeEnter> {
  const trimmed = name.trim();
  if (trimmed === "") {
    return { ok: false, error: "用法：/worktree enter <name> —— 此处必须给名字（裸 /worktree enter 是 driver 的自动命名形态）" }; // ω99-166e-ii: #2
  }
  const toplevel = await resolveGitToplevel(cwd);
  if (toplevel === undefined) {
    return { ok: false, error: `不是 git 仓库（任何父目录也不是）：${cwd}——/worktree 需要 git 仓库才能建分支` }; // ω99-166c-iv: #11
  }
  // The adapter leg: core's createChildWorktree(toplevel, "main", name).
  // onWarning is swallowed — a failed creation returns undefined and the
  // error below names the branch-collision fix (the common case).
  const created = await createChildWorktree(toplevel, "main", trimmed, { onWarning: () => {} });
  if (created === undefined) {
    return {
      ok: false,
      error: `git worktree add 失败："${trimmed}"（常见原因：分支 wudao/main/${trimmed}-<n> 已因保留的 worktree 存在）——换个名字，或先 git worktree prune / 删除旧分支`, // ω99-174: #1
    };
  }
  return { ok: true, worktree: { path: created.path, branch: created.branch, name: trimmed } };
}

/** The remove guard (red line 2, the upstream format同款防丢): ANY uncommitted change —
 *  modified, staged, or untracked — blocks `/worktree exit remove`. The
 *  refusal names keep; `git worktree remove` would refuse too, but this
 *  check says WHY before anything is attempted. */
export async function worktreeRemoveBlocked(path: string): Promise<{ readonly blocked: false } | { readonly blocked: true; readonly reason: string }> {
  const r = await runGit(path, ["status", "--porcelain"]);
  if (!r.ok) {
    // Unreadable git state: refuse to remove (fail-closed — keep is lossless).
    return { blocked: true, reason: `无法读取 worktree 的 git 状态（${firstLine(r.error)}）——/worktree exit keep 后手动删除` }; // ω99-174: #2
  }
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { blocked: false };
  const preview = lines.slice(0, 3).map((l) => l.trim()).join(", ");
  return {
    blocked: true,
    reason: `worktree 中有未提交变更（${lines.length} 个路径：${preview}${lines.length > 3 ? "，…" : ""}）——/worktree exit keep 会保留树和分支；请先 commit 或 stash 再 remove`, // ω99-166c-iv: #12（复数三元在中文下无义，删除——唯一模板简化点）
  };
}

/** Exit remove: delegate to core's removeChildWorktree (git worktree remove
 *  + branch -d, NEVER -D — an unmerged branch is left and reported, so the
 *  work is always recoverable). */
export function removeMainWorktree(path: string): Promise<WorktreeCleanup> {
  return removeChildWorktree(path, { onWarning: () => {} });
}

function firstLine(text: string): string {
  return text.split("\n")[0]?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// The bare /worktree status + usage.
// ---------------------------------------------------------------------------

export interface WorktreeStatusView {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  /** ISO timestamp of the enter. */
  readonly enteredAt: string;
  /** The pinned session root — shown so the pin is visible, not implicit. */
  readonly sessionRoot: string;
}

/** Bare /worktree text. `active` null + `pending` null → "not in a worktree"
 *  + usage; a `pending` line (a queued enter/exit) always heads the text. */
export function formatWorktreeStatus(active: WorktreeStatusView | null, pending: string | null): string {
  const lines: string[] = [];
  if (pending !== null) lines.push(`⏳ ${pending}`);
  if (active === null) {
    lines.push("不在 worktree 中"); // ω99-166c-iv: 表外同族——wd:357 钉演进强制收口（status 面，brief「恰 2 面」之外的域内最小演进）
    lines.push(WORKTREE_USAGE);
    return lines.join("\n");
  }
  lines.push(`🌳 在 worktree ${active.name} 中（分支 ${active.branch}）`); // ω99-174: #3（词表与 166f-i「已进入 worktree …（分支 …）」归一）
  lines.push(`  路径：${active.path}`); // ω99-174: #4
  lines.push(`  进入时间：${active.enteredAt}`); // ω99-174: #5
  lines.push(`  会话/持久化锚定在：${active.sessionRoot}（会话 · 导出 · 成本永不迁移）`); // ω99-174: #6
  lines.push(WORKTREE_USAGE);
  return lines.join("\n");
}

export const WORKTREE_USAGE = [
  "用法：/worktree —— 主会话的隔离 worktree",
  "  /worktree enter [name]   创建并在轮界切换（省略名时自动命名）",
  "  /worktree exit keep      切回主树；worktree 与分支保留",
  "  /worktree exit remove    切回主树并删除（有未提交改动时拒绝）",
].join("\n"); // ω99-166e-ii: #3

// ---------------------------------------------------------------------------
// Session entries — generic {type, data} lines (provider_change 同款: they
// ride the JSONL where the switch happened; loadSessionEntries surfaces them
// to every resume/tooling reader). ALWAYS written to the PINNED session root.
// ---------------------------------------------------------------------------

export interface WorktreeEntryData {
  readonly name: string;
  readonly path: string;
  readonly branch: string;
  /** exit only: keep | remove. */
  readonly mode?: "keep" | "remove";
  /** exit remove only: the cleanup outcome (removed/branchDeleted/reason). */
  readonly cleanup?: { readonly removed: boolean; readonly branchDeleted: boolean; readonly reason?: string };
  /** ISO timestamp. */
  readonly at: string;
}

/** Append a worktree_enter / worktree_exit entry. `workspaceRoot` is the
 *  SESSION anchor — the driver passes its pinned o.workspaceRoot, NEVER the
 *  worktree (red line 1). */
export async function recordWorktreeEntry(args: {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly kind: "worktree_enter" | "worktree_exit";
  readonly data: Omit<WorktreeEntryData, "at">;
  readonly now?: Date;
}): Promise<void> {
  const store = createJsonlSessionStore(join(args.workspaceRoot, ".wudao", "sessions"));
  await store.appendEntry(args.sessionId, {
    type: args.kind,
    data: { ...args.data, at: (args.now ?? new Date()).toISOString() },
  });
}
