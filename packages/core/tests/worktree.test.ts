import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChildWorktree, removeChildWorktree } from "../src/agents/worktree.js";

const execFile = promisify(execFileCb);

let main: string;
let warnings: string[];

beforeEach(async () => {
  main = await mkdtemp(join(tmpdir(), "wt-"));
  warnings = [];
  await git(main, ["init"]);
  await git(main, ["config", "user.email", "test@example.com"]);
  await git(main, ["config", "user.name", "test"]);
  await writeFile(join(main, "README.md"), "seed\n");
  await git(main, ["add", "."]);
  await git(main, ["commit", "-m", "init"]);
});
afterEach(async () => {
  await rm(main, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return stdout;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const warn = (m: string) => warnings.push(m);

describe("createChildWorktree", () => {
  it("creates .wudao/wt/<run>/<role>-<n> on branch wudao/<run>/<role>-<n>, incrementing n", async () => {
    const first = await createChildWorktree(main, "run1", "coder", { onWarning: warn });
    expect(first).toBeDefined();
    expect(first!.path).toBe(join(main, ".wudao", "wt", "run1", "coder-1"));
    expect(first!.branch).toBe("wudao/run1/coder-1");
    expect(await exists(first!.path)).toBe(true);
    expect((await git(main, ["branch", "--list", "wudao/run1/coder-1"])).trim()).toContain("wudao/run1/coder-1");

    const second = await createChildWorktree(main, "run1", "coder", { onWarning: warn });
    expect(second!.path.endsWith("coder-2")).toBe(true);
    expect(second!.branch).toBe("wudao/run1/coder-2");

    // A different role starts at its own 1.
    const reviewer = await createChildWorktree(main, "run1", "adversarial-reviewer", { onWarning: warn });
    expect(reviewer!.path.endsWith("adversarial-reviewer-1")).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("sanitizes runId/roleSlug for branch and directory names", async () => {
    const wt = await createChildWorktree(main, "my run/1", "code er", { onWarning: warn });
    expect(wt!.branch).toBe("wudao/my-run-1/code-er-1");
    expect(wt!.path).toContain(join(".wudao", "wt", "my-run-1", "code-er-1"));
  });

  it("degrades to undefined + warning when the workspace has no git repo (fail-open)", async () => {
    const plain = await mkdtemp(join(tmpdir(), "nogit-"));
    try {
      const wt = await createChildWorktree(plain, "run", "coder", { onWarning: warn });
      expect(wt).toBeUndefined();
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("git");
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });

  it("degrades to undefined + warning when git fails (e.g. branch already exists)", async () => {
    // Pre-create the branch the worktree would take, forcing `add -b` to fail.
    await git(main, ["branch", "wudao/run9/coder-1"]);
    const wt = await createChildWorktree(main, "run9", "coder", { onWarning: warn });
    expect(wt).toBeUndefined();
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("coder-1");
  });
});

describe("removeChildWorktree", () => {
  it("removes a merged worktree and deletes its branch with -d", async () => {
    const wt = await createChildWorktree(main, "run1", "coder", { onWarning: warn });
    // Touch nothing → branch points at the same commit as HEAD → -d succeeds.
    const cleanup = await removeChildWorktree(wt!.path, { onWarning: warn });
    expect(cleanup.removed).toBe(true);
    expect(cleanup.branch).toBe("wudao/run1/coder-1");
    expect(cleanup.branchDeleted).toBe(true);
    expect(await exists(wt!.path)).toBe(false);
    expect((await git(main, ["branch", "--list", "wudao/run1/coder-1"])).trim()).toBe("");
    expect(warnings).toEqual([]);
  });

  it("NEVER force-deletes an unmerged branch: leaves it and reports why", async () => {
    const wt = await createChildWorktree(main, "run2", "coder", { onWarning: warn });
    await writeFile(join(wt!.path, "work.txt"), "child change\n");
    await git(wt!.path, ["add", "."]);
    await git(wt!.path, ["commit", "-m", "child work"]);
    const cleanup = await removeChildWorktree(wt!.path, { onWarning: warn });
    expect(cleanup.removed).toBe(true); // clean tree → worktree removed
    expect(cleanup.branchDeleted).toBe(false); // unmerged → -d refuses
    expect(cleanup.reason).toBeTruthy();
    // The branch SURVIVES (never -D) so the work is recoverable.
    expect((await git(main, ["branch", "--list", "wudao/run2/coder-1"])).trim()).toContain("wudao/run2/coder-1");
  });

  it("refuses to remove a dirty worktree and reports it", async () => {
    const wt = await createChildWorktree(main, "run3", "coder", { onWarning: warn });
    await writeFile(join(wt!.path, "dirty.txt"), "uncommitted\n");
    const cleanup = await removeChildWorktree(wt!.path, { onWarning: warn });
    expect(cleanup.removed).toBe(false);
    expect(cleanup.branchDeleted).toBe(false);
    expect(cleanup.reason).toBeTruthy();
    expect(await exists(wt!.path)).toBe(true);
    expect((await git(main, ["branch", "--list", "wudao/run3/coder-1"])).trim()).toContain("wudao/run3/coder-1");
  });

  it("reports cleanly for a path that is not a worktree", async () => {
    const cleanup = await removeChildWorktree(join(main, "not-a-worktree"), { onWarning: warn });
    expect(cleanup.removed).toBe(false);
    expect(cleanup.reason).toBeTruthy();
  });

  it("never collides with a live sibling after a cleanup (max suffix + 1)", async () => {
    const a = await createChildWorktree(main, "run4", "coder", { onWarning: warn });
    const b = await createChildWorktree(main, "run4", "coder", { onWarning: warn });
    expect(a!.branch).toBe("wudao/run4/coder-1");
    expect(b!.branch).toBe("wudao/run4/coder-2");
    await removeChildWorktree(a!.path, { onWarning: warn }); // frees coder-1's dir
    const again = await createChildWorktree(main, "run4", "coder", { onWarning: warn });
    // coder-2 is LIVE: the next child must take a fresh slot, not reuse 2.
    expect(again!.branch).toBe("wudao/run4/coder-3");
    const siblings = await readdir(join(main, ".wudao", "wt", "run4"));
    expect(siblings.sort()).toEqual(["coder-2", "coder-3"]);
    expect(warnings).toEqual([]);
  });
});
