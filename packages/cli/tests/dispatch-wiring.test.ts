// dispatch wiring — the REAL index.ts dispatch surface, exercised end-to-end
// through the built entrypoint (spawn precedent: m58-fork-cli.test.ts — the
// repo gate runs `pnpm build` before tests). The sub-main suites (perms-lint,
// session-search, workflow-cli, plugin-cli, meta journal) call the sub-mains
// DIRECTLY, so index.ts's argv routing — which subcommand runs, whether
// subcommandArgv threads the post-`--` window into the subcommand, and whether
// a prompt word is mistaken for a subcommand — had no regression net (the
// subcmd-dashdash review's Minor gap). These spawn cases pin exactly that
// wiring; every case asserts a real output signature, never just exit 0.
//
// The dispatch rule under test (src/index.ts main): a subcommand matches on
// the FIRST positional (process.argv[2], after the end-of-options split) —
// workflow / plugin / perms (argv[3] === "lint") / sessions (argv[3] ===
// "search") / meta / purge / statusline / ui / slack. EVERY other first word
// is the one-shot prompt path.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

// Spawn the real entry with an isolated env: a temp global home
// (WUDAO_GLOBAL_HOME is honored by every global-tier reader, including the
// credentials-file fallback inside buildRunPlan), no API key anywhere (the
// prompt case asserts the no-key one-shot guidance — a resolved key would
// attempt a real model call), NO_COLOR for byte-stable output.
function runCli(args: readonly string[], cwd: string, globalHome: string, timeoutMs = 20_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      WUDAO_GLOBAL_HOME: globalHome,
      NO_COLOR: "1",
    };
    for (const k of [
      "WUDAO_API_KEY", "OPENAI_API_KEY", "WUDAO_PROVIDER", "WUDAO_MODEL",
      "WUDAO_BASE_URL", "OPENAI_MODEL", "OPENAI_BASE_URL",
    ]) delete env[k];
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    // Hard stop: a dispatch bug that waits on stdin/network must fail THIS
    // case with diagnostics (timedOut marker), never hang the suite.
    const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    killer.unref?.();
    child.on("close", (code, signal) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, timedOut: signal === "SIGKILL" });
    });
  });
}

// Every assertion carries the child's own bytes — a dispatch failure is
// diagnosed from the spawn output, not a bare expectation diff.
function diag(r: CliResult): string {
  return `exit=${r.code}${r.timedOut ? " (SIGKILL: hit the spawn timeout)" : ""} stdout=${JSON.stringify(r.stdout)} stderr=${JSON.stringify(r.stderr)}`;
}

function tempDirs(prefix: string): { ws: string; home: string } {
  return {
    ws: mkdtempSync(join(tmpdir(), `${prefix}-ws-`)),
    home: mkdtempSync(join(tmpdir(), `${prefix}-home-`)),
  };
}

describe("index.ts dispatch wiring (spawned real entrypoint)", () => {
  it("routes argv[2]/argv[3] to the perms subcommand (lint report on empty tiers; usage + exit 1 on a bad sub-arg)", async () => {
    const { ws, home } = tempDirs("dispatch-perms");
    try {
      const lint = await runCli(["perms", "lint"], ws, home);
      expect(lint.timedOut, diag(lint)).toBe(false);
      expect(lint.code, diag(lint)).toBe(0);
      expect(lint.stdout, diag(lint)).toContain("permissions: no unreachable rules");
      // The lint branch ran — a fall-through to the prompt path would have
      // printed the no-key guidance instead.
      expect(lint.stdout, diag(lint)).not.toContain("No API key found");

      const bad = await runCli(["perms", "junk"], ws, home);
      expect(bad.timedOut, diag(bad)).toBe(false);
      expect(bad.code, diag(bad)).toBe(1);
      expect(bad.stdout, diag(bad)).toContain("用法：wudao perms lint"); // ω99-166d-i: 钉头串演进（#9）
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("threads the post-`--` window into the sessions-search query (`sessions search foo -- --bar` queries \"foo --bar\")", async () => {
    const { ws, home } = tempDirs("dispatch-search");
    try {
      // One seeded transcript whose only token matching the query lives in
      // the post-`--` half: the doc text carries no "foo" token. Broken
      // wiring — the dispatch slicing the pre-`--` flag window alone — would
      // query "foo" (no hit → the no-match line) or "" (the usage line);
      // correct wiring queries "foo --bar", whose "bar" token matches this
      // doc, and the hit excerpt echoes the doc's raw bytes (dashes intact).
      const sessionsDir = join(ws, ".wudao", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      writeFileSync(
        join(sessionsDir, "passthru1.jsonl"),
        `${JSON.stringify({ role: "user", content: "how to run grep with --bar flag", uuid: "u1" })}\n`,
        "utf8",
      );
      const r = await runCli(["sessions", "search", "foo", "--", "--bar"], ws, home);
      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      expect(r.stdout, diag(r)).toContain("[user] how to run grep with --bar flag");
      expect(r.stdout, diag(r)).not.toContain("(no sessions match");
      expect(r.stdout, diag(r)).not.toContain("用法：wudao sessions search"); // ω99-166d-i: 空洞负钉同步演进（#10 头换）
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);

  it("a top-level prompt word that is NOT a subcommand name reaches the one-shot prompt path (no dispatch hijack)", async () => {
    const { ws, home } = tempDirs("dispatch-prompt");
    try {
      // "refactor" hits none of the dispatched names (workflow/plugin/perms/
      // sessions/meta/purge/statusline/ui/slack), so the whole argv is a
      // prompt. With no key anywhere, the one-shot PROMPT branch prints its
      // guidance: a subcommand misdispatch would print that subcommand's
      // output instead, and the NO-PROMPT interactive branch prefixes a
      // version banner — both pinned negative here.
      const r = await runCli(["refactor", "the", "failing", "module"], ws, home);
      expect(r.timedOut, diag(r)).toBe(false);
      expect(r.code, diag(r)).toBe(0);
      expect(r.stdout, diag(r)).toContain("No API key found");
      // The one-shot prompt branch's trailer — pins that a NONEMPTY prompt
      // was parsed and dispatched (the no-prompt guidance lacks it).
      expect(r.stdout, diag(r)).toContain("For a no-key demo: pnpm demo");
      expect(r.stdout, diag(r)).not.toContain("wudao-harness v");
      expect(r.stdout, diag(r)).not.toContain("用法：wudao"); // ω99-166d-i: 空洞负钉同步演进（保判别力，头串换 用法：）
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30_000);
});
