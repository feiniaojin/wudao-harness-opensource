// Task 8 hotfix — two defects found installing the 0.2.1 package:
//   (a) packages/cli/src/version.ts hand-maintained VERSION drifted from
//       package.json (the banner printed v0.2.0 on a 0.2.1 install). The
//       test pins the constant to the package version so the drift can
//       never ship silently again.
//   (b) bare `wudao` with NO key dead-ended on a notice ("没有提供api key，
//       启动都启动不了"). On a TTY the interactive entry now prints the
//       notice, then one readline question — Enter re-enters main() AS
//       `wudao ui` (the SAME in-process dispatch the subcommand uses), whose
//       boot plan launches the first-run wizard. Ctrl+C / EOF keeps today's
//       notice-and-exit. Non-TTY stdin (piped/headless/CI) keeps today's
//       exact behavior — a question there would hang the pipe.
//
// The CLI cases never import src/index.js at top level (module eval runs
// main()); each case installs argv/env/cwd/TTY FIRST, then vi.resetModules()
// + dynamic-import so main() boots exactly once under our conditions. The
// wizard entry is asserted by mocking ../src/ui.js — runUi is the ui
// dispatch's terminal call, so reaching it proves the fallback rode the real
// `wudao ui` code path in-process (no child process).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { stdin, stdout } from "node:process";
import { VERSION } from "../src/version.js";

const { runUiCalls, rlSeam } = vi.hoisted(() => ({
  runUiCalls: [] as Array<Record<string, unknown>>,
  rlSeam: { instances: [] as Array<{ write: (s: string) => void }> },
}));

vi.mock("../src/ui.js", () => ({
  runUi: async (props: Record<string, unknown>) => {
    runUiCalls.push(props);
  },
  parseUiPort: () => undefined,
}));

vi.mock("node:readline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:readline")>();
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    createInterface: (options: Record<string, unknown>) => {
      // Deterministic TTY stand-in: a vitest worker's REAL stdin sits at EOF —
      // its 'close' event would answer the question "EOF" before the test can
      // feed Enter. Swap in a never-ending input stream (the isTTY gate in
      // index.ts stays the real one); the test then drives the interface via
      // rl.write(), the same entry typed bytes take.
      const rl = actual.createInterface({ ...options, input: new PassThrough() });
      rlSeam.instances.push(rl);
      return rl;
    },
  };
});

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(what: string, cond: () => boolean, ms = 10000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await wait(25);
  }
}

// (a) -----------------------------------------------------------------------
describe("task-8 (a): VERSION constant tracks packages/cli/package.json", () => {
  it("version.ts VERSION === package.json version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version); // literal pin removed 0.2.2: equality alone catches the drift
  });
});

// (b) + (c) -----------------------------------------------------------------
describe("task-8 (b/c): bare `wudao` with no API key", () => {
  let root: string;
  let home: string;
  let origCwd: string;
  let origArgv: string[];
  let origIsTTY: boolean | undefined;
  const savedEnv: Record<string, string | undefined> = {};
  const touchedEnv = [
    "WUDAO_API_KEY", "WUDAO_API_KEYS", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "WUDAO_PROVIDER", "WUDAO_BASE_URL", "WUDAO_MODEL", "OPENAI_MODEL",
    "WUDAO_GLOBAL_HOME",
  ] as const;
  let writes: string[] = [];
  const output = (): string => writes.join("");

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "nokey-cli-"));
    home = await mkdtemp(join(tmpdir(), "nokey-home-"));
    origCwd = process.cwd();
    origArgv = [...process.argv];
    process.chdir(root); // empty workspace: no .env, no settings, no sessions
    for (const k of touchedEnv) {
      savedEnv[k] = process.env[k];
      if (k !== "WUDAO_GLOBAL_HOME") delete process.env[k];
    }
    process.env.WUDAO_GLOBAL_HOME = home; // no .credentials.yaml / providers.json
    // Bare `wudao` — argv[2] absent skips every subcommand dispatch.
    process.argv = [origArgv[0], "wudao"];
    writes = [];
    vi.spyOn(stdout, "write").mockImplementation(((chunk: unknown): boolean => {
      const s = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      writes.push(s);
      return true;
    }) as typeof stdout.write);
    runUiCalls.length = 0;
    rlSeam.instances.length = 0;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    process.argv = origArgv;
    for (const k of touchedEnv) {
      const v = savedEnv[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    Object.defineProperty(stdin, "isTTY", { value: origIsTTY, configurable: true });
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const setStdinTty = (tty: boolean): void => {
    origIsTTY = (stdin as { isTTY?: boolean }).isTTY;
    Object.defineProperty(stdin, "isTTY", { value: tty, configurable: true });
  };

  it("(c) non-TTY stdin: notice + exit — no prompt, no hang", async () => {
    setStdinTty(false);
    const dataListenersBefore = stdin.listenerCount("data");
    vi.resetModules();
    await import("../src/index.js"); // module eval boots main() under our argv/env
    await waitFor("the no-key notice", () => output().includes("No API key found"));
    await wait(300); // a stray prompt would have landed by now if the branch regressed
    expect(output()).not.toContain("按回车启动新手向导");
    expect(runUiCalls.length).toBe(0); // nothing launched
    expect(stdin.listenerCount("data")).toBe(dataListenersBefore); // no readline attached
  }, 30000);

  it("(b) TTY stdin: notice + question; Enter boots the wizard in-process (runUi)", async () => {
    setStdinTty(true);
    vi.resetModules();
    await import("../src/index.js");
    await waitFor("the wizard question", () => output().includes("按回车启动新手向导"));
    expect(output()).toContain("No API key found");
    expect(runUiCalls.length).toBe(0); // still parked on the question
    // Enter: one line through the interface the site created.
    const rl = rlSeam.instances[rlSeam.instances.length - 1];
    expect(rl).toBeDefined();
    rl.write("\n");
    await waitFor("runUi (the first-run wizard boot)", () => runUiCalls.length === 1);
  }, 30000);
});
