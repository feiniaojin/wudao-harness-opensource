import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createShellTool, looksInteractive } from "../src/tools/shell.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// win32: a bare .mjs cannot be exec'd (no interpreter association) — the
// dockerPath option carries the two-word `node <entry>` form there (the
// product's splitJsBin understands it; posix uses the bare path).
const FAKE_DOCKER = process.platform === "win32"
  ? `${process.execPath} ${join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs")}`
  : join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs");

// Run one command through a fake-docker-backed sandboxed tool; returns the
// tool result plus every argv the fake docker saw (probe included).
async function runSandboxed(opts: {
  command: string;
  mode?: string;
  out?: string;
  err?: string;
  exit?: string;
  timeoutMs?: number;
  image?: string;
}): Promise<{ result: { content: string; isError?: boolean }; invocations: string[][] }> {
  const log = join(root, "docker.log");
  await writeFile(log, "");
  const prevEnv = { ...process.env };
  if (opts.mode) process.env.FAKE_DOCKER_MODE = opts.mode; else delete process.env.FAKE_DOCKER_MODE;
  if (opts.out) process.env.FAKE_DOCKER_OUT = opts.out; else delete process.env.FAKE_DOCKER_OUT;
  if (opts.err) process.env.FAKE_DOCKER_ERR = opts.err; else delete process.env.FAKE_DOCKER_ERR;
  if (opts.exit) process.env.FAKE_DOCKER_EXIT = opts.exit; else delete process.env.FAKE_DOCKER_EXIT;
  process.env.FAKE_DOCKER_LOG = log;
  try {
    const tool = createShellTool({
      workspaceRoot: root,
      timeoutMs: opts.timeoutMs,
      sandbox: { dockerPath: FAKE_DOCKER, ...(opts.image ? { image: opts.image } : {}) },
    });
    const result = await tool.execute({ command: opts.command });
    const invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
    return { result: { content: result.content, isError: result.isError }, invocations };
  } finally {
    process.env = prevEnv;
  }
}

describe("shell", () => {
  it("runs a command and returns stdout", async () => {
    const tool = createShellTool({ workspaceRoot: root });
    const res = await tool.execute({ command: "node -e \"process.stdout.write('hi')\"" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("hi");
  });
  it("flags a non-zero exit as isError", async () => {
    const tool = createShellTool({ workspaceRoot: root });
    const res = await tool.execute({ command: "node -e \"process.exit(3)\"" });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/exit 3/);
  });
  it("runs with cwd = workspaceRoot", async () => {
    const tool = createShellTool({ workspaceRoot: root });
    const res = await tool.execute({ command: "node -e \"process.stdout.write(process.cwd())\"" });
    expect(res.content).toContain(root);
  });
  it("scrubs WUDAO_API_KEY from the child env", async () => {
    const prev = process.env.WUDAO_API_KEY;
    process.env.WUDAO_API_KEY = "should-not-leak";
    try {
      const tool = createShellTool({ workspaceRoot: root });
      const res = await tool.execute({ command: "node -e \"process.stdout.write(process.env.WUDAO_API_KEY || 'NONE')\"" });
      expect(res.content).toContain("NONE");
      expect(res.content).not.toContain("should-not-leak");
    } finally {
      if (prev === undefined) delete process.env.WUDAO_API_KEY; else process.env.WUDAO_API_KEY = prev;
    }
  });
  it("scrubs credential-shaped env vars from the child environment", async () => {
    const prev = { ...process.env };
    process.env.MY_SERVICE_API_KEY = "leak-me";
    process.env.GITHUB_TOKEN = "leak-me";
    process.env.DB_PASSWORD = "leak-me";
    process.env.SESSION_SECRET = "leak-me";
    process.env.AWS_SECRET_ACCESS_KEY = "leak-me";
    process.env.WUDAO_SOMETHING = "leak-me";
    process.env.SAFE_VAR = "keep-me";
    try {
      const tool = createShellTool({ workspaceRoot: root });
      const res = await tool.execute({ command: "printenv" });
      expect(res.content).not.toContain("leak-me");
      expect(res.content).not.toContain("MY_SERVICE_API_KEY");
      expect(res.content).not.toContain("GITHUB_TOKEN");
      expect(res.content).not.toContain("AWS_SECRET_ACCESS_KEY");
      expect(res.content).toContain("SAFE_VAR"); // non-credential vars survive
    } finally {
      process.env = prev;
    }
  }, 15_000);
  it("labels a timeout kill with [timeout after Ns]", async () => {
    const tool = createShellTool({ workspaceRoot: root, timeoutMs: 100 });
    const res = await tool.execute({ command: "sleep 5" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("[timeout after 0.1s]");
  });

  // 波次 8 #43 (hermes kill_process_tree): exec()'s timeout kills ONLY the
  // direct child (the `sh -c` shell) — a backgrounded grandchild is reparented
  // and keeps running (writing, holding locks, eating the port). The fix kills
  // the whole PROCESS GROUP on POSIX. Witness: the command leaves its
  // grandchild's pid in a file; after the timeout kill, that pid must be gone.
  (process.platform === "win32" ? it.skip : it)(
    "timeout kills the process GROUP — a backgrounded grandchild dies with the shell",
    { timeout: 15_000 } as const,
    async () => {
      const pidFile = join(root, "grandchild.pid");
      const tool = createShellTool({ workspaceRoot: root, timeoutMs: 400 });
      const res = await tool.execute({
        command: `sleep 999 & echo $! > ${pidFile}; sleep 999`,
      });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("[timeout after 0.4s]");
      // give the group TERM a beat to land, then prove the grandchild is gone
      // (ESRCH from signal 0 — on the old direct-child kill it survived).
      await new Promise((r) => setTimeout(r, 400));
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isFinite(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  // 借鉴弧 δ (penguin 367ab084): the detached lane's stop path. The per-call
  // signal fires the SAME group TERM→KILL escalation as the timeout, but a
  // stop must never wear the timeout label — its own [stopped by user]
  // receipt lands instead, and the whole group (grandchild included) dies.
  (process.platform === "win32" ? it.skip : it)(
    "an aborted per-call signal kills the group and labels [stopped by user] — never a timeout",
    { timeout: 15_000 } as const,
    async () => {
      const pidFile = join(root, "detach-grandchild.pid");
      const tool = createShellTool({ workspaceRoot: root, timeoutMs: 60_000 });
      const ac = new AbortController();
      const execP = tool.execute({
        command: `sleep 999 & echo $! > ${pidFile}; sleep 999`,
      }, undefined, ac.signal);
      await new Promise((r) => setTimeout(r, 300)); // let the group form
      ac.abort();
      const res = await execP;
      expect(res.isError).toBe(true);
      expect(res.content).toContain("[stopped by user]");
      expect(res.content).not.toContain("[timeout");
      await new Promise((r) => setTimeout(r, 400)); // TERM→(escalation)→gone
      const pid = Number((await readFile(pidFile, "utf8")).trim());
      expect(Number.isFinite(pid)).toBe(true);
      expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("looksInteractive: deterministic matrix (no process spawned)", () => {
    expect(looksInteractive("sudo rm x")).toBe(true);
    expect(looksInteractive("passwd")).toBe(true);
    expect(looksInteractive("create-next-app my-app")).toBe(true);
    expect(looksInteractive("npx create-vite my-app")).toBe(true);
    expect(looksInteractive("npm create astro@latest")).toBe(true);
    expect(looksInteractive("yarn create react-app x")).toBe(true);
    expect(looksInteractive("npm init")).toBe(true);
    expect(looksInteractive("npm init -y")).toBe(false);
    expect(looksInteractive("npm init --yes")).toBe(false);
    expect(looksInteractive("rm -i f")).toBe(true);
    expect(looksInteractive("rm -if f")).toBe(true);
    expect(looksInteractive("rm -rf f")).toBe(false);
    expect(looksInteractive("git status")).toBe(false);
    expect(looksInteractive("npm install")).toBe(false);
    expect(looksInteractive("")).toBe(false);
  });

  // `npm init` genuinely hangs: init-package-json's readline prompts fire
  // even on a non-TTY stdin (exec never writes the pipe) — the command burns
  // its whole timeout, exactly the shape the hint exists for.
  (process.platform === "win32" ? it.skip : it)(
    "timeout on an interactive-looking command carries the non-interactive hint",
    { timeout: 15_000 } as const,
    async () => {
      const tool = createShellTool({ workspaceRoot: root, timeoutMs: 100 });
      const res = await tool.execute({ command: "npm init" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("likely waiting for interactive input");
      expect(res.content).toContain("[timeout after 0.1s");
    },
  );

  it("timeout on a non-interactive command keeps the bare label (zero-change pin)", { timeout: 15_000 } as const, async () => {
    const tool = createShellTool({ workspaceRoot: root, timeoutMs: 100 });
    const res = await tool.execute({ command: "sleep 5" });
    expect(res.content).not.toContain("interactive input");
  });
  it("says 'command not found or not executable' on spawn ENOENT", async () => {
    const tool = createShellTool({ workspaceRoot: root });
    const res = await tool.execute({ command: "definitely-not-a-real-cmd-xyz" });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("command not found or not executable");
  });
});

describe("shell sandbox", () => {
  it("builds the containerized argv (mount, network, workdir, entrypoint, sh -c)", async () => {
    const { result, invocations } = await runSandboxed({ command: "node -v" });
    expect(result.isError).toBeFalsy();
    // First invocation is the cached availability probe.
    expect(invocations[0]).toEqual(["version", "--format", "{{.Server.Version}}"]);
    expect(invocations[1]).toEqual([
      "run", "--rm", "-i",
      "--network", "none",
      "--memory", "512m",
      "--cpus", "1",
      "-v", `${root}:/workspace`,
      "-w", "/workspace",
      "--entrypoint", "sh",
      "node:22-alpine",
      "-c", "node -v",
    ]);
  });

  it("honors a custom image", async () => {
    const { invocations } = await runSandboxed({ command: "node -v", image: "node:20-alpine" });
    expect(invocations[1]?.[15]).toBe("node:20-alpine");
  });

  it("denies every run when the Docker probe fails — never falls back to host execution", async () => {
    const log = join(root, "docker.log");
    await writeFile(log, "");
    const prevEnv = { ...process.env };
    process.env.FAKE_DOCKER_MODE = "probe-fail";
    process.env.FAKE_DOCKER_LOG = log;
    try {
      const tool = createShellTool({ workspaceRoot: root, sandbox: { dockerPath: FAKE_DOCKER } });
      const res = await tool.execute({ command: "node -v" });
      expect(res.isError).toBe(true);
      expect(res.content).toMatch(/^shell failed: sandbox required but Docker is unavailable \(.+\)$/);
      // The failure is cached: a second run is denied even though the fake
      // daemon has since "recovered", and no `docker run` ever happened.
      process.env.FAKE_DOCKER_MODE = "probe-ok";
      const res2 = await tool.execute({ command: "node -v" });
      expect(res2.isError).toBe(true);
      expect(res2.content).toMatch(/sandbox required but Docker is unavailable/);
      const invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
      expect(invocations).toHaveLength(1); // only the probe — the command was NEVER executed
    } finally {
      process.env = prevEnv;
    }
  });

  it("passes through container stdout, stderr, and exit code", async () => {
    const { result } = await runSandboxed({ command: "node -v", out: "hello-from-container", err: "warn-on-stderr", exit: "3" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("hello-from-container");
    expect(result.content).toContain("warn-on-stderr");
    expect(result.content).toMatch(/\[exit 3\]/);
  });

  it("labels a timeout kill inside the sandbox with [timeout after Ns]", async () => {
    const { result } = await runSandboxed({ command: "node -v", mode: "stall", timeoutMs: 200 });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("[timeout after 0.2s]");
  }, 10_000);

  it("labels a non-SIGTERM signal kill with [killed by SIGxxx]", async () => {
    const { result } = await runSandboxed({ command: "node -v", mode: "selfkill" });
    expect(result.isError).toBe(true);
    // win32 has no signal semantics: a hard self-kill surfaces as exit 1
    // (TerminateProcess), never err.signal — the SIGxxx label is posix-only.
    if (process.platform === "win32") {
      expect(result.content).toContain("[exit 1]");
    } else {
      expect(result.content).toContain("[killed by SIGKILL]");
    }
  });
});
