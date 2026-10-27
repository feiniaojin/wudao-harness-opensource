// M58 §C#8 — git status injection through the MetaNote channel. Pins the
// three contract legs: (1) the note content (branch/ahead-behind/capped
// porcelain summary), (2) the change detection (first probe = session start;
// fingerprint change = re-inject; unchanged = silence), (3) the HARD RULE —
// the block NEVER enters the stable system-prompt prefix (byte-identical
// before/after repo changes), and (4) the graceful no-op outside a repo.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGitStatusNote,
  collectGitStatus,
  createGitStatusProber,
  gitStatusFingerprint,
  MAX_STATUS_LINES,
  type GitStatusSnapshot,
} from "../src/git-status-note.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { resetProjectContextCacheForTests } from "../src/project-context.js";

const snap = (over: Partial<GitStatusSnapshot> = {}): GitStatusSnapshot => ({
  sha: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b",
  branchHeader: "main...origin/main [ahead 1]",
  entries: [" M a.ts"],
  ...over,
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "wudao-git-note-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@wudao.local");
  git(dir, "config", "user.name", "wudao test");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "seed");
  return dir;
}

describe("buildGitStatusNote (M58 §C#8)", () => {
  it("renders branch header, short HEAD, and the porcelain entries", () => {
    const note = buildGitStatusNote(snap());
    expect(note.startsWith("<git_status>\n")).toBe(true);
    expect(note.endsWith("\n</git_status>")).toBe(true);
    expect(note).toContain("branch: main...origin/main [ahead 1]");
    expect(note).toContain("HEAD: 1a2b3c4d");
    expect(note).toContain("uncommitted changes (1):");
    expect(note).toContain(" M a.ts");
  });

  it("clean tree renders the clean line, no entry block", () => {
    const note = buildGitStatusNote(snap({ entries: [] }));
    expect(note).toContain("working tree clean");
    expect(note).not.toContain("uncommitted changes");
  });

  it("caps entries at MAX_STATUS_LINES with an explicit omission line", () => {
    const entries = Array.from({ length: MAX_STATUS_LINES + 5 }, (_, i) => `?? f${i}.txt`);
    const note = buildGitStatusNote(snap({ entries }));
    const included = entries.filter((e) => note.includes(e));
    expect(included).toHaveLength(MAX_STATUS_LINES);
    expect(note).toContain("… +5 more");
    expect(note).toContain("`git status --porcelain`");
  });
});

describe("gitStatusFingerprint (cheap key)", () => {
  const base = snap();
  it("identical snapshots share the key", () => {
    expect(gitStatusFingerprint(base)).toBe(gitStatusFingerprint(snap()));
  });
  it("HEAD sha, branch header, and entry count each change it", () => {
    expect(gitStatusFingerprint(snap({ sha: "f".repeat(40) }))).not.toBe(gitStatusFingerprint(base));
    expect(gitStatusFingerprint(snap({ branchHeader: "main...origin/main" }))).not.toBe(gitStatusFingerprint(base));
    expect(gitStatusFingerprint(snap({ entries: [] }))).not.toBe(gitStatusFingerprint(base));
  });
});

describe("createGitStatusProber (contract, stubbed collect)", () => {
  it("first probe injects (session start); unchanged fingerprint stays silent; change re-injects", async () => {
    const pushed: string[] = [];
    let current = snap();
    const prober = createGitStatusProber({
      workspaceRoot: "/ws",
      push: (t) => pushed.push(t),
      collect: async () => current,
    });
    await prober.probe();
    expect(pushed).toHaveLength(1); // session start
    await prober.probe();
    expect(pushed).toHaveLength(1); // unchanged — no re-injection
    current = snap({ sha: "9".repeat(40) });
    await prober.probe();
    expect(pushed).toHaveLength(2); // fingerprint changed
    expect(pushed[1]).toContain("HEAD: 99999999");
  });

  it("a confirmed non-repo latches — no further collects", async () => {
    let calls = 0;
    const prober = createGitStatusProber({
      workspaceRoot: "/ws",
      push: () => {
        throw new Error("must not push outside a repo");
      },
      collect: async () => {
        calls += 1;
        return null;
      },
    });
    await prober.probe();
    await prober.probe();
    await prober.probe();
    expect(calls).toBe(1);
  });

  it("a transient failure retries at the next boundary and never throws", async () => {
    let healthy = false;
    const pushed: string[] = [];
    const prober = createGitStatusProber({
      workspaceRoot: "/ws",
      push: (t) => pushed.push(t),
      collect: async () => (healthy ? snap() : undefined),
    });
    await prober.probe(); // transient undefined — swallowed, not latched
    expect(pushed).toHaveLength(0);
    healthy = true;
    await prober.probe();
    expect(pushed).toHaveLength(1);
  });
});

describe("createGitStatusProber (real git)", () => {
  it("collects a committed repo: full sha, branch header, clean entries", async () => {
    const dir = makeRepo();
    const s = await collectGitStatus(dir);
    expect(s).not.toBeNull();
    expect(s?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(s?.branchHeader).toBe("main");
    expect(s?.entries).toEqual([]);
  });

  it("an unborn repo is still a repo: empty sha, 'No commits yet' header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-git-unborn-"));
    git(dir, "init", "-q", "-b", "main");
    const s = await collectGitStatus(dir);
    expect(s).not.toBeNull();
    expect(s?.sha).toBe("");
    expect(s?.branchHeader).toContain("No commits yet");
  });

  it("injects on start, on count change, on HEAD change — never in between; prefix stays byte-identical", async () => {
    const dir = makeRepo();
    const pushed: string[] = [];
    const prober = createGitStatusProber({ workspaceRoot: dir, push: (t) => pushed.push(t) });

    const promptBefore = buildSystemPrompt(dir);
    expect(promptBefore).not.toContain("git_status");

    await prober.probe(); // session start
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("branch: main");
    expect(pushed[0]).toContain("working tree clean");

    await prober.probe();
    expect(pushed).toHaveLength(1); // unchanged

    // untracked file → entry count 0 → 1
    writeFileSync(join(dir, "notes.txt"), "scratch\n");
    await prober.probe();
    expect(pushed).toHaveLength(2);
    expect(pushed[1]).toContain("?? notes.txt");

    await prober.probe();
    expect(pushed).toHaveLength(2); // same count, same sha, same branch

    // second commit → HEAD sha moves, tree clean again
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "second");
    await prober.probe();
    expect(pushed).toHaveLength(3);
    expect(pushed[2]).toContain("working tree clean");
    expect(pushed[2]).not.toBe(pushed[0]); // the new HEAD is in the note

    // HARD RULE: the stable prompt prefix is byte-identical across the whole
    // dance (fresh reads — the project-context memo is dropped both times).
    resetProjectContextCacheForTests();
    const promptAfter = buildSystemPrompt(dir);
    expect(promptAfter).toBe(promptBefore);
    expect(promptAfter).not.toContain("git_status");
  });

  it("graceful no-op outside a git repo (null + latch, never throws)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-git-norepo-"));
    const pushed: string[] = [];
    const prober = createGitStatusProber({ workspaceRoot: dir, push: (t) => pushed.push(t) });
    await expect(collectGitStatus(dir)).resolves.toBeNull();
    await prober.probe();
    await prober.probe();
    expect(pushed).toHaveLength(0);
  });
});
