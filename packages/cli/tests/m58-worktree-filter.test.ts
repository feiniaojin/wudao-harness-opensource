// M58 §C#7 — the /resume worktree filter: sessions record their
// workspaceRoot (generic entry, append-only, last-wins); inside a git
// worktree the session lists default to that worktree's sessions, --all
// lifts the filter, and unattributed (pre-M58) sessions stay visible.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonlSessionStore } from "@wudao/core";
import type { SessionEntry } from "@wudao/core";
import {
  buildWorkspaceRootEntry,
  recordedWorkspaceRoot,
  ensureWorkspaceRootEntry,
  collectSessionRows,
  isInsideWorktree,
  defaultSessionListFilter,
  WORKSPACE_ROOT_ENTRY_TYPE,
} from "../src/session-list.js";

function tmpSessions(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "wudao-wtf-"));
  mkdirSync(join(dir, "sessions"), { recursive: true });
  return { dir: join(dir, "sessions"), cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** A session file with one user message + optional extra entries. */
async function seedSession(sessionsDir: string, id: string, extras: SessionEntry[] = []): Promise<void> {
  const store = createJsonlSessionStore(sessionsDir);
  await store.append(id, { role: "user", content: `prompt for ${id}` });
  for (const e of extras) await store.appendEntry(id, e);
}

// ---------------------------------------------------------------------------
// The workspace_root entry
// ---------------------------------------------------------------------------

describe("workspace_root entry (M58 §C#7)", () => {
  it("builds and reads back (last recording wins; malformed skipped)", () => {
    const entry = buildWorkspaceRootEntry("/wt/root-a");
    expect(entry.type).toBe(WORKSPACE_ROOT_ENTRY_TYPE);
    const entries: SessionEntry[] = [
      { role: "user", content: "hi" },
      entry,
      { type: WORKSPACE_ROOT_ENTRY_TYPE, data: { root: 42 } }, // malformed
      { type: WORKSPACE_ROOT_ENTRY_TYPE, data: { root: "" } }, // empty
      buildWorkspaceRootEntry("/wt/root-b"),
    ];
    expect(recordedWorkspaceRoot(entries)).toBe("/wt/root-b");
    expect(recordedWorkspaceRoot([{ role: "user", content: "hi" }])).toBeUndefined();
  });

  it("ensureWorkspaceRootEntry appends once, and re-points when the session moves (append-only)", async () => {
    const { dir, cleanup } = tmpSessions();
    try {
      const store = createJsonlSessionStore(dir);
      await seedSession(dir, "s1");
      await ensureWorkspaceRootEntry(store, "s1", "/wt/a");
      await ensureWorkspaceRootEntry(store, "s1", "/wt/a"); // no-op
      let entries = await store.loadSessionEntries("s1");
      expect(entries.filter((e) => !("role" in e) && e.type === WORKSPACE_ROOT_ENTRY_TYPE)).toHaveLength(1);
      await ensureWorkspaceRootEntry(store, "s1", "/wt/b"); // moved → fresh append
      entries = await store.loadSessionEntries("s1");
      expect(recordedWorkspaceRoot(entries)).toBe("/wt/b");
      expect(entries.filter((e) => !("role" in e) && e.type === WORKSPACE_ROOT_ENTRY_TYPE)).toHaveLength(2);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// The list filter
// ---------------------------------------------------------------------------

describe("collectSessionRows — filterWorkspaceRoot", () => {
  it("hides foreign-root sessions; keeps matching and unattributed ones; no filter lists everything", async () => {
    const { dir, cleanup } = tmpSessions();
    try {
      await seedSession(dir, "here", [buildWorkspaceRootEntry("/wt/here")]);
      await seedSession(dir, "there", [buildWorkspaceRootEntry("/wt/there")]);
      await seedSession(dir, "legacy"); // pre-M58 session: no recording
      const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
      expect(ids(await collectSessionRows(dir))).toEqual(["here", "legacy", "there"]);
      expect(ids(await collectSessionRows(dir, { filterWorkspaceRoot: "/wt/here" }))).toEqual(["here", "legacy"]);
      expect(ids(await collectSessionRows(dir, { filterWorkspaceRoot: "/wt/there" }))).toEqual(["legacy", "there"]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Worktree detection
// ---------------------------------------------------------------------------

describe("isInsideWorktree", () => {
  it("a .worktrees path git cannot probe falls back to the path heuristic", async () => {
    // Nonexistent directory → the rev-parse probe fails → heuristic fallback.
    expect(await isInsideWorktree(join("/repo", ".worktrees", "m58-b"))).toBe(true);
  });
  it("NIT 1: a plain git repo under a .worktrees-named parent is NOT a worktree (the probe outranks the path shape)", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-notwt2-"));
    try {
      // An ordinary standalone repo whose path merely contains ".worktrees".
      const repo = join(root, ".worktrees", "plain");
      execFileSync("git", ["init", "-q", repo], { stdio: "ignore" });
      expect(await isInsideWorktree(repo)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);
  it("a plain directory / non-repo is not a worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-notwt-"));
    try {
      expect(await isInsideWorktree(dir)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  it("a real linked git worktree is detected; the main checkout is not", async () => {
    const root = mkdtempSync(join(tmpdir(), "wudao-gitwt-"));
    try {
      const main = join(root, "main");
      const wt = join(root, "wt-tree");
      const git = (args: string[]): void => execFileSync("git", args, { cwd: main, stdio: "ignore" });
      execFileSync("git", ["init", main], { stdio: "ignore" });
      git(["config", "user.email", "test@example.com"]);
      git(["config", "user.name", "test"]);
      writeFileSync(join(main, "f.txt"), "x\n", "utf8");
      git(["add", "."]);
      git(["commit", "-m", "init", "--allow-empty"]);
      execFileSync("git", ["-C", main, "worktree", "add", wt, "-b", "wt"], { stdio: "ignore" });
      expect(await isInsideWorktree(wt)).toBe(true);
      expect(await isInsideWorktree(main)).toBe(false);
    } finally {
      // Drop the worktree link before rmSync so git's metadata goes too.
      try {
        execFileSync("git", ["-C", join(root, "main"), "worktree", "prune", "--force"], { stdio: "ignore" });
      } catch {
        // best effort only
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);
});

describe("defaultSessionListFilter", () => {
  it("a non-worktree cwd → no filter; a worktree cwd → the cwd; --all lifts it (exec-relative argv)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-df-"));
    try {
      expect(await defaultSessionListFilter(dir, [])).toBeUndefined();
      // .worktrees path → the cwd itself is the filter; --all lifts it.
      const wt = join(dir, ".worktrees", "b");
      expect(await defaultSessionListFilter(wt, [])).toBe(wt);
      expect(await defaultSessionListFilter(wt, ["--all"])).toBeUndefined();
      expect(await defaultSessionListFilter(wt, ["-all"])).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  it("NIT 2: a PROMPT word --all never lifts the filter (leading-flag window only)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-df2-"));
    try {
      const wt = join(dir, ".worktrees", "b");
      // The first non-flag token ends the flag window — "--all" is a word.
      expect(await defaultSessionListFilter(wt, ["explain", "--all", "the", "flags"])).toBe(wt);
      // Leading flags still compose: a value flag's value is stepped over.
      expect(await defaultSessionListFilter(wt, ["--resume", "abc", "--all"])).toBeUndefined();
      expect(await defaultSessionListFilter(wt, ["--resume", "--all"])).toBe(wt); // "--all" consumed as the value
      // M58-D review fix: --log-level is value-taking — the window must step
      // over its level and still reach a following --all.
      expect(await defaultSessionListFilter(wt, ["--log-level", "debug", "--all"])).toBeUndefined();
      expect(await defaultSessionListFilter(wt, ["--log-level", "debug"])).toBe(wt);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
