// ω99-130 — `-h/--help` and `-V/--version` short-circuit coverage.
// Pure-function pins: the four spellings, the LEADING-flag-only window (a
// --help inside the prompt is a prompt word — the dogfood bug's inverse), the
// end-of-options `--` contract (post-`--` --help stays a prompt word,
// semantics unchanged), value-flag composition, subcommand non-hijack
// (`wudao plugin --help` keeps the plugin subcommand's own help), and the
// deliberate non-extension of the single-dash long-form quirk.
// Subprocess smoke: the four forms against the BUILT entrypoint (spawn
// precedent: m58-fork-cli.test.ts / dispatch-wiring.test.ts — the repo gate
// runs `pnpm build` before tests). No WUDAO_E2E gate: unlike the e2e spawns,
// these children print and exit BEFORE any settings read or model session,
// so they cost one node boot each, never a CLI boot.
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHelpVersionFlags, CLI_USAGE_TEXT } from "../src/args.js";
import { VERSION } from "../src/version.js";

describe("parseHelpVersionFlags (ω99-130)", () => {
  it("the four spellings: -h/--help → help, -V/--version → version", () => {
    expect(parseHelpVersionFlags(["-h"])).toBe("help");
    expect(parseHelpVersionFlags(["--help"])).toBe("help");
    expect(parseHelpVersionFlags(["-V"])).toBe("version");
    expect(parseHelpVersionFlags(["--version"])).toBe("version");
  });

  it("default: no flags → undefined (bare argv never short-circuits)", () => {
    expect(parseHelpVersionFlags([])).toBeUndefined();
    expect(parseHelpVersionFlags(["hello"])).toBeUndefined();
  });

  it("LEADING flags only — a --help after a prompt word is a prompt word", () => {
    expect(parseHelpVersionFlags(["fix", "--help"])).toBeUndefined();
    expect(parseHelpVersionFlags(["explain", "--version", "now"])).toBeUndefined();
    expect(parseHelpVersionFlags(["fix", "the", "-h", "flag"])).toBeUndefined();
  });

  it("a subcommand word ends the window — subcommand --help is NOT hijacked", () => {
    expect(parseHelpVersionFlags(["plugin", "--help"])).toBeUndefined();
    expect(parseHelpVersionFlags(["workflow", "-h"])).toBeUndefined();
    expect(parseHelpVersionFlags(["sessions", "search", "--help"])).toBeUndefined();
  });

  it("post-`--` --help stays a prompt word (design pin: `wudao -- --help` unchanged)", () => {
    expect(parseHelpVersionFlags(["--", "--help"])).toBeUndefined();
    expect(parseHelpVersionFlags(["--", "-V"])).toBeUndefined();
    expect(parseHelpVersionFlags(["--resume", "x", "--", "--help"])).toBeUndefined();
  });

  it("a LEADING --help before `--` still wins (split is the identity without it)", () => {
    expect(parseHelpVersionFlags(["-h", "--", "--version"])).toBe("help");
  });

  it("leading flags compose: value-taking flags step over their value", () => {
    expect(parseHelpVersionFlags(["--provider", "deepseek", "--help"])).toBe("help");
    expect(parseHelpVersionFlags(["--image", "a.png", "-V"])).toBe("version");
    expect(parseHelpVersionFlags(["--provider=deepseek", "-h"])).toBe("help");
  });

  it("a flag-looking value occupies the value slot — `--resume --help` is NOT help", () => {
    // Same convention as the other window scans: the token after a value
    // flag belongs to that flag, whatever it looks like.
    expect(parseHelpVersionFlags(["--resume", "--help"])).toBeUndefined();
    expect(parseHelpVersionFlags(["--name=--help"])).toBeUndefined();
  });

  it("first hit wins when both flags appear", () => {
    expect(parseHelpVersionFlags(["--help", "--version"])).toBe("help");
    expect(parseHelpVersionFlags(["--version", "--help"])).toBe("version");
  });

  it("single-dash long forms (-help/-version) are deliberately NOT accepted", () => {
    // The repo's -resume/-plan quirk is not extended: short forms exist, and
    // every added spelling is one more way to collide with prompt words.
    expect(parseHelpVersionFlags(["-help"])).toBeUndefined();
    expect(parseHelpVersionFlags(["-version"])).toBeUndefined();
  });
});

describe("CLI_USAGE_TEXT sanity (ω99-130)", () => {
  it("every line ≤100 chars (the brief's line budget)", () => {
    for (const line of CLI_USAGE_TEXT.split("\n")) {
      expect(line.length, `line too long (${line.length}): ${line}`).toBeLessThanOrEqual(100);
    }
  });

  it("ends with the no-key demo tip; names the help/version flags", () => {
    expect(CLI_USAGE_TEXT.trimEnd().endsWith("无 key 试用：pnpm demo")).toBe(true);
    expect(CLI_USAGE_TEXT).toContain("-h, --help");
    expect(CLI_USAGE_TEXT).toContain("-V, --version");
  });

  it("contains no `model:` line — the help text itself stays model-free", () => {
    expect(CLI_USAGE_TEXT).not.toContain("model:");
  });

  it("honest inventory: the brief's audited flags and entries are all present", () => {
    // mode flags / sandbox / session flags / ablation family / workflow / ui.
    for (const token of [
      "--plan", "--ask", "--auto", "--sandbox",
      "--resume", "--continue", "--list-sessions", "--fork-session",
      "--no-verify", "wudao workflow", "wudao ui",
    ]) {
      expect(CLI_USAGE_TEXT, `usage text missing: ${token}`).toContain(token);
    }
  });
});

// --- subprocess smoke -------------------------------------------------------
// The four forms against the built entrypoint: exit 0, the right bytes on
// stdout, and ZERO model session (a booting run prints a `model: …` line —
// its absence is the no-model-call receipt).

const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

interface CliResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Spawn the built entry with an isolated env (temp global home, temp cwd, no
 *  key/endpoint anywhere) — nothing real can be reached even if a regression
 *  turns the short-circuit into a run. SIGKILL after 15s: a bug must not hang
 *  the suite. */
function runCli(args: readonly string[]): Promise<CliResult> {
  const cwd = mkdtempSync(join(tmpdir(), "wudao-hv-"));
  const globalHome = mkdtempSync(join(tmpdir(), "wudao-hv-home-"));
  return new Promise((resolve, reject) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      WUDAO_GLOBAL_HOME: globalHome,
      NO_COLOR: "1",
    };
    for (const k of ["WUDAO_API_KEY", "OPENAI_API_KEY", "WUDAO_BASE_URL", "WUDAO_MODEL"]) delete env[k];
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      resolve({ code, stdout, stderr });
    });
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    killer.unref?.();
    child.on("close", () => clearTimeout(killer));
  });
}

describe("ω99-130 smoke: the built entrypoint prints and exits (no model session)", () => {
  it("--help and -h: exit 0, usage key lines on stdout, no `model:` line", async () => {
    for (const flag of ["--help", "-h"]) {
      const r = await runCli([flag]);
      expect(r.code, `${flag} exit code`).toBe(0);
      expect(r.stdout, `${flag} usage header`).toContain("wudao-harness v");
      expect(r.stdout, `${flag} help flag line`).toContain("-h, --help");
      expect(r.stdout, `${flag} version flag line`).toContain("-V, --version");
      expect(r.stdout, `${flag} no-key tip`).toContain("无 key 试用：pnpm demo");
      expect(r.stdout, `${flag} must not boot a model session`).not.toContain("model:");
    }
  }, 20_000);

  it("--version and -V: exit 0, exactly the version.ts version, no `model:` line", async () => {
    for (const flag of ["--version", "-V"]) {
      const r = await runCli([flag]);
      expect(r.code, `${flag} exit code`).toBe(0);
      expect(r.stdout.trim(), `${flag} prints the version.ts version`).toBe(VERSION);
      expect(r.stdout, `${flag} must not boot a model session`).not.toContain("model:");
    }
  }, 20_000);
});
