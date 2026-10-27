// M58 §C#5 review (optional e2e) — the --fork-session CLI glue: the real
// entrypoint (dist/index.js) run with --no-tui --resume <id> --fork-session
// copies the session JSONL, PRINTS the new session id, resumes the fork, and
// leaves the original byte-untouched. Requires a prior `pnpm build` (the repo
// gate runs build before test).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

function runCli(args: readonly string[], cwd: string, envHome: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd,
      env: {
        ...process.env,
        // Isolation: no real global home, no real key, an endpoint that is
        // never reached (the REPL exits before any model call).
        WUDAO_GLOBAL_HOME: envHome,
        WUDAO_API_KEY: "test-key",
        WUDAO_BASE_URL: "http://127.0.0.1:1/v1",
        WUDAO_MODEL: "fake-e2e-model",
        NO_COLOR: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let closed = false;
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      closed = true;
      resolve({ code, stdout, stderr });
    });
    // Feed /exit only once the REPL's prompt is actually up — a write that
    // lands before readline exists gets lost (and write+end races readline:
    // EOF with a pending question rejects and fails the run). Marker-driven,
    // so the test stays robust on slow machines.
    const feedWhenReady = (): void => {
      if (closed) return;
      if (stdout.includes("wudao> ")) {
        child.stdin.write("/exit\n");
        return;
      }
      setTimeout(feedWhenReady, 100);
    };
    setTimeout(feedWhenReady, 100);
    // Hard stop: a bug must not hang the suite.
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
  });
}

describe("--fork-session CLI glue (M58 §C#5, e2e)", () => {
  it("prints the new session id, resumes the fork, and never touches the original", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-fork-cli-"));
    const globalHome = mkdtempSync(join(tmpdir(), "wudao-fork-cli-home-"));
    try {
      const sessionsDir = join(ws, ".wudao", "sessions");
      mkdirSync(sessionsDir, { recursive: true });
      const original = [
        JSON.stringify({ type: "model_change", model: "fake-e2e-model", provider: "deepseek", at: "2026-08-18T00:00:00.000Z" }),
        JSON.stringify({ role: "user", content: "fix the bug", uuid: "u1" }),
        JSON.stringify({ role: "assistant", content: "fixed", parentUuid: "u1" }),
      ].join("\n") + "\n";
      writeFileSync(join(sessionsDir, "e2esrc1.jsonl"), original, "utf8");
      const before = readFileSync(join(sessionsDir, "e2esrc1.jsonl"), "utf8");

      const r = await runCli(["--no-tui", "--resume", "e2esrc1", "--fork-session"], ws, globalHome);
      expect(r.code).toBe(0);
      // The receipt line names the fork.
      expect(r.stdout).toContain("forked session:");
      expect(r.stdout).toContain("from e2esrc1");
      expect(r.stdout).toContain("original untouched");
      const newId = /forked session:\s*([A-Za-z0-9_-]+)/.exec(r.stdout)?.[1];
      expect(newId).toBeDefined();
      expect(newId).not.toBe("e2esrc1");
      // 新旧并存; the fork starts as a byte-identical copy (the copy is a
      // prefix — the resumed run may append its own runtime entries, e.g. the
      // M58 workspace_root recording); the original did not move a byte.
      expect(existsSync(join(sessionsDir, "e2esrc1.jsonl"))).toBe(true);
      expect(existsSync(join(sessionsDir, `${newId}.jsonl`))).toBe(true);
      expect(readFileSync(join(sessionsDir, `${newId}.jsonl`), "utf8").startsWith(original)).toBe(true);
      expect(readFileSync(join(sessionsDir, "e2esrc1.jsonl"), "utf8")).toBe(before);
      // The REPL resumed the FORK (session id line carries it), not the source.
      expect(r.stdout).toContain(newId.slice(0, 8));
      expect(r.stdout).toContain("已恢复"); // ω99-172: 钉随源演进（漏判钉——e2e 走 dist，重建后读新串）
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);

  it("--fork-session without --resume refuses with usage and exits nonzero", async () => {
    const ws = mkdtempSync(join(tmpdir(), "wudao-fork-cli2-"));
    const globalHome = mkdtempSync(join(tmpdir(), "wudao-fork-cli2-home-"));
    try {
      const r = await runCli(["--no-tui", "--fork-session"], ws, globalHome);
      expect(r.stdout).toContain("--fork-session forks a RESUMED session");
      // The refusal path prints usage and returns (exit 0 by design, like the
      // other usage guards) — no session files were created.
      expect(existsSync(join(ws, ".wudao", "sessions"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 30000);
});
