// M37 §3 — Bash git safety: static, token-based detection of high-risk git
// commands (inside a git repo) that upgrades the permission ASK text with an
// explicit warning. Detection is deliberately prefix/flag-shaped (spec: 误报可
// 接受、漏报靠白名单收敛) and never blocks anything.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGitRisk, formatGitRiskWarning, isInsideGitRepo, gitRiskAskWarning } from "../src/git-safety.js";

describe("detectGitRisk — high-risk prefixes (spec §3)", () => {
  it("flags the five spec-listed commands", () => {
    expect(detectGitRisk("git reset --hard")?.label).toContain("git reset --hard");
    expect(detectGitRisk("git clean -fd")?.label).toContain("git clean");
    expect(detectGitRisk("git push --force")?.label).toContain("git push --force");
    expect(detectGitRisk("git checkout -- .")?.label).toContain("git checkout");
    expect(detectGitRisk("git branch -D feature-x")?.label).toContain("git branch -D");
  });

  it("each rule carries a concrete risk sentence", () => {
    for (const cmd of ["git reset --hard", "git clean -fd", "git push --force", "git checkout -- .", "git branch -D x"]) {
      const risk = detectGitRisk(cmd);
      expect(risk).toBeDefined();
      expect(risk?.risk.length ?? 0).toBeGreaterThan(10);
    }
  });
});

describe("detectGitRisk — argument positions", () => {
  it("risky flag after other args (git reset --hard HEAD~1, git push origin main --force)", () => {
    expect(detectGitRisk("git reset --hard HEAD~1")?.label).toContain("reset");
    expect(detectGitRisk("git push origin main --force")?.label).toContain("push");
  });
  it("global options before the subcommand (git -C /repo reset --hard)", () => {
    expect(detectGitRisk("git -C /some/repo reset --hard")?.label).toContain("reset");
    expect(detectGitRisk("git --no-pager branch -D x")?.label).toContain("branch");
  });
  it("combined/permuted short flags (git clean -df, -f -d, -xfd)", () => {
    expect(detectGitRisk("git clean -df")).toBeDefined();
    expect(detectGitRisk("git clean -f -d")).toBeDefined();
    expect(detectGitRisk("git clean -xfd")).toBeDefined();
  });
  it("second command in a pipeline/sequence (git status && git reset --hard)", () => {
    expect(detectGitRisk("git status && git reset --hard")?.label).toContain("reset");
    expect(detectGitRisk("echo hi; git push --force origin main")?.label).toContain("push");
  });
  it("bare git checkout . (no --) is destructive too", () => {
    expect(detectGitRisk("git checkout .")?.label).toContain("checkout");
  });
});

describe("detectGitRisk — case sensitivity (别名大小写)", () => {
  it("branch -d (lowercase) is the SAFE delete — not flagged", () => {
    expect(detectGitRisk("git branch -d merged-branch")).toBeUndefined();
  });
  it("branch -D (uppercase) force-deletes — flagged; also inside a combined flag", () => {
    expect(detectGitRisk("git branch -D unmerged")).toBeDefined();
    expect(detectGitRisk("git branch -vD unmerged")).toBeDefined();
  });
});

describe("detectGitRisk — negatives (safe commands never warn)", () => {
  it("everyday git commands stay clean", () => {
    for (const cmd of [
      "git status",
      "git diff --stat",
      "git log --oneline -5",
      "git reset --soft HEAD~1",
      "git reset HEAD~1",
      "git branch -d merged",
      "git branch feature-x",
      "git push origin main",
      "git checkout -b feat/x",
      "git checkout main",
      "git clean -n",
      "git add -A && git commit -m x",
    ]) {
      expect(detectGitRisk(cmd), cmd).toBeUndefined();
    }
  });
  it("non-git commands stay clean", () => {
    for (const cmd of ["ls -la", "npm test", "rm -rf node_modules", "echo 'git'"]) {
      expect(detectGitRisk(cmd), cmd).toBeUndefined();
    }
  });
  it("empty/whitespace command", () => {
    expect(detectGitRisk("")).toBeUndefined();
    expect(detectGitRisk("   ")).toBeUndefined();
  });
});

describe("isInsideGitRepo", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wudao-git-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("false outside a repo, true at the repo root, true in a subdirectory (walk-up)", () => {
    expect(isInsideGitRepo(dir)).toBe(false);
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(isInsideGitRepo(dir)).toBe(true);
    mkdirSync(join(dir, "deep", "nested"), { recursive: true });
    expect(isInsideGitRepo(join(dir, "deep", "nested"))).toBe(true);
  });
});

describe("formatGitRiskWarning + gitRiskAskWarning (ask-site glue)", () => {
  it("the warning names the command, the label, and the risk", () => {
    const w = formatGitRiskWarning(detectGitRisk("git reset --hard HEAD~1")!, "git reset --hard HEAD~1");
    expect(w).toContain("git reset --hard HEAD~1");
    expect(w).toContain("git reset --hard");
    expect(w.toLowerCase()).toContain("discards");
  });
  it("only shell calls inside a git repo carry a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "wudao-git-"));
    try {
      const input = { command: "git reset --hard" };
      expect(gitRiskAskWarning("write_file", input, dir)).toBeUndefined();
      expect(gitRiskAskWarning("shell", { command: "ls" }, dir)).toBeUndefined();
      expect(gitRiskAskWarning("shell", input, dir)).toBeUndefined(); // not a repo
      mkdirSync(join(dir, ".git"), { recursive: true });
      expect(gitRiskAskWarning("shell", input, dir)).toBeDefined();
      expect(gitRiskAskWarning("shell", { command: "git status" }, dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
