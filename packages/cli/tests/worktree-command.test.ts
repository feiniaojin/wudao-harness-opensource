// P1-7 (96 队列) — /worktree: the parse grammar + the PURE worktree halves.
// The command family routes through the four-wiring (slash-commands, the
// REPL parse, the driver case, the REPL branch); these tests pin the parse
// layer and the command module's pure halves: enter creates branch+directory
// via core's createChildWorktree (the CLI adapter — core's signature is
// untouched, 子 agent 用法零扰动), a non-git root refuses, remove is blocked
// by uncommitted/untracked changes (CC 同款防丢), keep leaves the tree, and
// the worktree_enter/worktree_exit entries ride the PINNED session root's
// JSONL as generic entries (provider_change 同款纪律).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao-org/core";
import { parseReplCommand } from "../src/repl.js";
import {
  WORKTREE_USAGE,
  enterMainWorktree,
  formatWorktreeStatus,
  recordWorktreeEntry,
  removeMainWorktree,
  worktreeRemoveBlocked,
} from "../src/commands/worktree.js";
import { createPermissionSettingsWatcher } from "../src/permission.js";

const execFile = promisify(execFileCb);
const git = (cwd: string, ...args: string[]): Promise<{ stdout: string }> =>
  execFile("git", [...args], { cwd, encoding: "utf8" });

let repo: string;
let plain: string;
let home: string;
let savedHome: string | undefined;

const exists = async (p: string): Promise<boolean> =>
  (await stat(p).catch(() => undefined)) !== undefined;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "wudao-wt-repo-"));
  plain = await mkdtemp(join(tmpdir(), "wudao-wt-plain-"));
  home = await mkdtemp(join(tmpdir(), "wudao-wt-home-"));
  await writeFile(join(repo, "a.txt"), "A\n", "utf8");
  await git(repo, "init", "-q");
  await git(repo, "add", "a.txt");
  await git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
  savedHome = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = home;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedHome;
  await rm(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(plain, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Parse grammar — the /trust precedent (prefix-neighbor discipline:
// "/worktreex" stays a plain prompt; the family takes raw args, the runner
// validates the exact forms).
// ---------------------------------------------------------------------------
describe("parseReplCommand — /worktree family", () => {
  it("routes the family and keeps prefix-neighbors as prompts", () => {
    expect(parseReplCommand("/worktree")).toEqual({ kind: "worktree", args: "" });
    expect(parseReplCommand("/worktree enter")).toEqual({ kind: "worktree", args: "enter" });
    expect(parseReplCommand("/worktree enter fix-x")).toEqual({ kind: "worktree", args: "enter fix-x" });
    expect(parseReplCommand("/worktree exit keep")).toEqual({ kind: "worktree", args: "exit keep" });
    expect(parseReplCommand("/worktree exit remove")).toEqual({ kind: "worktree", args: "exit remove" });
    expect(parseReplCommand("/worktree exit")).toEqual({ kind: "worktree", args: "exit" });
    // Prefix-neighbor: no space → not the family.
    expect(parseReplCommand("/worktreex")).toEqual({ kind: "prompt", text: "/worktreex" });
    expect(parseReplCommand("/worktrees enter")).toEqual({ kind: "prompt", text: "/worktrees enter" });
  });
});

// ---------------------------------------------------------------------------
// enterMainWorktree — the CLI adapter over core's createChildWorktree.
// ---------------------------------------------------------------------------
describe("enterMainWorktree", () => {
  it("creates the worktree under .wudao/wt/main/ on a new wudao/main/<name>-N branch at HEAD, with the checkout inside", async () => {
    const r = await enterMainWorktree(repo, "fix-x");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.worktree.branch).toBe("wudao/main/fix-x-1");
    // git's toplevel is the CANONICAL spelling (macOS /var → /private/var).
    const top = await realpath(repo);
    expect(r.worktree.path).toBe(join(top, ".wudao", "wt", "main", "fix-x-1"));
    await expect(exists(r.worktree.path)).resolves.toBe(true);
    await expect(exists(join(r.worktree.path, "a.txt"))).resolves.toBe(true);
    const branches = (await git(repo, "branch", "--list", "wudao/main/fix-x-1")).stdout;
    expect(branches).toContain("wudao/main/fix-x-1");
    expect(r.worktree.name).toBe("fix-x");
  });

  it("sanitizes an unsafe name into the branch vocabulary and bases the worktree on the git toplevel from a subdirectory", async () => {
    await mkdir(join(repo, "sub"), { recursive: true });
    const r = await enterMainWorktree(join(repo, "sub"), "café 中文");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // slugify collapses everything outside [A-Za-z0-9._-]; the tree still
    // lands under the REPO's .wudao/wt/main (the canonical toplevel), not
    // the subdir's.
    const top = await realpath(repo);
    expect(r.worktree.path.startsWith(join(top, ".wudao", "wt", "main"))).toBe(true);
    expect(r.worktree.branch).toMatch(/^wudao\/main\/caf-\d+$/);
  });

  it("refuses a non-git root with a clear error (hard constraint 3)", async () => {
    const r = await enterMainWorktree(plain, "x");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("不是 git 仓库"); // ω99-166c-iv: 表外同族钉演进（wt:71 非 git 门中文化连带）。
  });

  it("refuses an empty name — the auto name is the DRIVER's derivation (session-linked), not the module's", async () => {
    const r = await enterMainWorktree(repo, "");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("用法"); // ω99-166e-ii: 钉演进（空名回执中文化）
  });
});

// ---------------------------------------------------------------------------
// The anti-loss guard (red line 2) + exit cleanup.
// ---------------------------------------------------------------------------
describe("worktreeRemoveBlocked / removeMainWorktree", () => {
  it("clean tree → not blocked; remove deletes the tree and the branch", async () => {
    const enter = await enterMainWorktree(repo, "clean");
    if (!enter.ok) throw new Error(enter.error);
    await expect(worktreeRemoveBlocked(enter.worktree.path)).resolves.toEqual({ blocked: false });
    const cleanup = await removeMainWorktree(enter.worktree.path);
    expect(cleanup.removed).toBe(true);
    expect(cleanup.branchDeleted).toBe(true);
    await expect(exists(enter.worktree.path)).resolves.toBe(false);
    expect((await git(repo, "branch", "--list", enter.worktree.branch)).stdout.trim()).toBe("");
  });

  it("uncommitted (untracked) change → blocked with a reason naming keep (red line 2)", async () => {
    const enter = await enterMainWorktree(repo, "dirty");
    if (!enter.ok) throw new Error(enter.error);
    await writeFile(join(enter.worktree.path, "untracked.txt"), "u\n", "utf8");
    const verdict = await worktreeRemoveBlocked(enter.worktree.path);
    expect(verdict.blocked).toBe(true);
    if (verdict.blocked) expect(verdict.reason).toContain("keep");
    // The tree is still there — nothing was destroyed.
    await expect(exists(join(enter.worktree.path, "untracked.txt"))).resolves.toBe(true);
  });

  it("modified tracked file → blocked too; committing clears the block", async () => {
    const enter = await enterMainWorktree(repo, "mod");
    if (!enter.ok) throw new Error(enter.error);
    await writeFile(join(enter.worktree.path, "a.txt"), "A2\n", "utf8");
    await expect(worktreeRemoveBlocked(enter.worktree.path)).resolves.toEqual({
      blocked: true,
      reason: expect.stringContaining("keep"),
    });
    await git(enter.worktree.path, "add", "a.txt");
    await git(enter.worktree.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "wip");
    await expect(worktreeRemoveBlocked(enter.worktree.path)).resolves.toEqual({ blocked: false });
    // The branch now carries an unmerged commit — removal deletes the tree
    // but the branch is LEFT (git branch -d refuses, never -D: CC 同款防丢).
    const cleanup = await removeMainWorktree(enter.worktree.path);
    expect(cleanup.removed).toBe(true);
    expect(cleanup.branchDeleted).toBe(false);
    expect((await git(repo, "branch", "--list", enter.worktree.branch)).stdout).toContain(enter.worktree.branch);
  });
});

// ---------------------------------------------------------------------------
// Session entries — generic {type, data} lines in the PINNED session root.
// ---------------------------------------------------------------------------
describe("recordWorktreeEntry", () => {
  it("writes worktree_enter/worktree_exit as generic entries under the given root's sessions dir", async () => {
    const sid = "wt-entry-1";
    await recordWorktreeEntry({
      workspaceRoot: repo,
      sessionId: sid,
      kind: "worktree_enter",
      data: { name: "fix-x", path: join(repo, ".wudao", "wt", "main", "fix-x-1"), branch: "wudao/main/fix-x-1" },
    });
    await recordWorktreeEntry({
      workspaceRoot: repo,
      sessionId: sid,
      kind: "worktree_exit",
      data: { name: "fix-x", mode: "keep" },
    });
    const store = createJsonlSessionStore(join(repo, ".wudao", "sessions"));
    const entries = await store.loadSessionEntries(sid);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ type: "worktree_enter", data: { name: "fix-x", branch: "wudao/main/fix-x-1" } });
    expect(entries[1]).toMatchObject({ type: "worktree_exit", data: { mode: "keep" } });
    // Raw line check: both shapes parse as JSON lines in the one file.
    const raw = await readFile(join(repo, ".wudao", "sessions", `${sid}.jsonl`), "utf8");
    expect(raw).toContain('"worktree_enter"');
    expect(raw).toContain('"worktree_exit"');
  });
});

// ---------------------------------------------------------------------------
// Bare status text + usage.
// ---------------------------------------------------------------------------
describe("formatWorktreeStatus / WORKTREE_USAGE", () => {
  it("active shows path/branch/entered-at; absent says so and carries usage", () => {
    const active = formatWorktreeStatus(
      { name: "fix-x", path: "/tmp/r/.wudao/wt/main/fix-x-1", branch: "wudao/main/fix-x-1", enteredAt: "2026-08-30T00:00:00.000Z", sessionRoot: "/tmp/r" },
      null,
    );
    expect(active).toContain("fix-x");
    expect(active).toContain("wudao/main/fix-x-1");
    expect(active).toContain("/tmp/r/.wudao/wt/main/fix-x-1");
    expect(active).toContain("2026-08-30T00:00:00.000Z");
    // The pinned-root line: persistence stays at the ORIGINAL root.
    expect(active).toContain("/tmp/r");

    expect(formatWorktreeStatus(null, null)).toContain("不在 worktree 中"); // ω99-166c-iv: 表外同族钉演进（formatWorktreeStatus :136 status 面随 wd:357 强制收口）。
    expect(formatWorktreeStatus(null, "entering worktree fix-x (queued: lands at the next turn boundary)")).toContain("queued");

    expect(WORKTREE_USAGE).toContain("/worktree enter");
    expect(WORKTREE_USAGE).toContain("/worktree exit keep");
    expect(WORKTREE_USAGE).toContain("/worktree exit remove");
  });
});

// ---------------------------------------------------------------------------
// Hard constraint 5 — workspace-tier permission rules interpret by the
// OPERATION root: the settings watcher's root is a live getter.
// ---------------------------------------------------------------------------
describe("createPermissionSettingsWatcher — live root getter", () => {
  it("project-tier rules follow the root getter: a flip re-loads the OTHER root's rules", async () => {
    const repoB = await mkdtemp(join(tmpdir(), "wudao-wt-repoB-"));
    try {
      await mkdir(join(repo, ".wudao"), { recursive: true });
      await mkdir(join(repoB, ".wudao"), { recursive: true });
      await writeFile(join(repo, ".wudao", "settings.json"), JSON.stringify({ permissions: { allow: ["shell(make *)"] } }), "utf8");
      await writeFile(join(repoB, ".wudao", "settings.json"), JSON.stringify({ permissions: { allow: ["shell(bazel *)"] } }), "utf8");

      let liveRoot = repo;
      const watcher = createPermissionSettingsWatcher(repo, undefined, { root: () => liveRoot, revalidateMs: 0 });
      const atA = await watcher.get();
      expect(atA.allow).toContain("shell(make *)");

      liveRoot = repoB; // the operation root switched (e.g. /worktree enter)
      const atB = await watcher.get();
      expect(atB.allow).toContain("shell(bazel *)");
      expect(atB.allow).not.toContain("shell(make *)");
    } finally {
      await rm(repoB, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("no root getter keeps today's behavior (the boot root, byte-stable default)", async () => {
    await mkdir(join(repo, ".wudao"), { recursive: true });
    await writeFile(join(repo, ".wudao", "settings.json"), JSON.stringify({ permissions: { ask: ["write_file"] } }), "utf8");
    const watcher = createPermissionSettingsWatcher(repo, undefined, { revalidateMs: 0 });
    const s = await watcher.get();
    expect(s.ask).toEqual(["write_file"]);
  });
});
