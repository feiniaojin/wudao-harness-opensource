// ω-4d (import-queue item 17) — login-shell env snapshot, RUNTIME half of the
// §5 matrix (design 61, cases 11-17): the cli's maybeLoginShellEnv provider
// (gating, capture shape, single-flight, failure caching, caps) and the
// buildToolSet wiring. Every spawn is a fake; no real login shell, no rc
// files, no network. The pure core half (cases 1-10) lives in
// packages/core/tests/shell-snapshot.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AssistantMessage, ModelClient, ModelInput, PermissionDecision, Tool } from "@wudao/core";
import { buildLoginShellCaptureScript, LOGIN_SHELL_SNAPSHOT_MAX_BYTES } from "@wudao/core";
import { maybeLoginShellEnv, type SpawnShellFn, type SpawnShellChild } from "../src/shell-snapshot.js";
import { buildToolSet } from "../src/tools.js";

const execFile = promisify(execFileCb);

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "snap-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

// A fake spawn result: stdout resolves with the scripted dump; kill records.
const fakeChild = (stdout: string): SpawnShellChild => ({ stdout: Promise.resolve(stdout), kill: () => {} });
const neverChild = (): SpawnShellChild => ({ stdout: new Promise<string>(() => {}), kill: () => {} });

const ZSH_ENV: NodeJS.ProcessEnv = { SHELL: "/bin/zsh", HOME: "/home/u", PATH: "/usr/bin:/bin" };

describe("§5 case 11 — maybeLoginShellEnv gating (decided at construction, zero spawns)", () => {
  it("ablation / $SHELL unset / $SHELL empty / unsupported shell → undefined, spawn count 0", () => {
    const spawnShell = vi.fn();
    const cases: readonly NodeJS.ProcessEnv[] = [
      { WUDAO_NO_LOGIN_SHELL: "1", SHELL: "/bin/zsh" },
      {}, // SHELL unset
      { SHELL: "" },
      { SHELL: "/usr/bin/fish" },
    ];
    for (const env of cases) {
      const provider = maybeLoginShellEnv(join(root, "ws"), {
        env,
        spawnShell: spawnShell as unknown as SpawnShellFn,
        warn: () => {},
      });
      expect(provider, JSON.stringify(env)).toBeUndefined();
    }
    expect(spawnShell).not.toHaveBeenCalled();
  });
});

describe("§5 case 12 — capture shape", () => {
  it("spawns $SHELL -c <kind script> with cwd = workspaceRoot and the scrubbed env", async () => {
    const seen: { cmd: string; args: readonly string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const provider = maybeLoginShellEnv(join(root, "ws"), {
      env: { ...ZSH_ENV, FAKE_API_KEY: "child-must-not-see" },
      spawnShell: (cmd, args, opts): SpawnShellChild => {
        seen.push({ cmd, args, cwd: opts.cwd, env: opts.env });
        return fakeChild("noise line\n\0A=1\0PATH=/snap/bin\0");
      },
      warn: () => {},
    });
    expect(provider).toBeDefined();
    const snap = await provider!();
    expect(snap).toEqual({ A: "1", PATH: "/snap/bin" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.cmd).toBe("/bin/zsh");
    expect(seen[0]!.args).toEqual(["-c", buildLoginShellCaptureScript("zsh")]);
    expect(seen[0]!.cwd).toBe(join(root, "ws"));
    // The capture child starts from the SCRUBBED env: credentials the terminal
    // wouldn't see stay hidden from the rc files; HOME survives for ~ resolution.
    expect(seen[0]!.env.FAKE_API_KEY).toBeUndefined();
    expect(seen[0]!.env.HOME).toBe("/home/u");
  });
});

describe("§5 case 13 — single-flight (the OnceCell semantics)", () => {
  it("two concurrent provider() calls share ONE spawn and the same parsed map", async () => {
    let spawns = 0;
    let release!: (v: string) => void;
    const provider = maybeLoginShellEnv(join(root, "ws"), {
      env: { SHELL: "/bin/bash" },
      spawnShell: (): SpawnShellChild => {
        spawns += 1;
        return { stdout: new Promise<string>((r) => { release = r; }), kill: () => {} };
      },
      warn: () => {},
    });
    const p1 = provider!();
    const p2 = provider!();
    release("noise\0X=9\0");
    const [a, b] = await Promise.all([p1, p2]);
    expect(spawns).toBe(1);
    expect(a).toEqual({ X: "9" });
    expect(b).toEqual({ X: "9" });
  });
});

describe("§5 case 14 — failure caching + warn-once + timeout", () => {
  type Mode = "spawn-throws" | "stdout-rejects" | "no-nul" | "oversize";
  const expectCachedFailure = async (mode: Mode): Promise<void> => {
    let spawns = 0;
    const warns: string[] = [];
    const overCap = "n\0K=" + "a".repeat(LOGIN_SHELL_SNAPSHOT_MAX_BYTES);
    const provider = maybeLoginShellEnv(join(root, "ws"), {
      env: ZSH_ENV,
      spawnShell: (): SpawnShellChild => {
        spawns += 1;
        if (mode === "spawn-throws") throw new Error("spawn ENOENT");
        if (mode === "stdout-rejects") return { stdout: Promise.reject(new Error("exit 3")), kill: () => {} };
        if (mode === "no-nul") return fakeChild("garbage without a marker");
        return fakeChild(overCap);
      },
      warn: (line) => warns.push(line),
    });
    await expect(provider!()).resolves.toBeUndefined();
    await expect(provider!()).resolves.toBeUndefined(); // failure stays cached — no retry
    expect(spawns).toBe(1);
    expect(warns).toHaveLength(1); // exactly one warn line per provider instance
    expect(warns[0]).toMatch(/login-shell|snapshot/i);
  };
  it("spawn error / non-zero exit / no NUL / over-cap output → undefined, cached, one warn", async () => {
    await expectCachedFailure("spawn-throws");
    await expectCachedFailure("stdout-rejects");
    await expectCachedFailure("no-nul");
    await expectCachedFailure("oversize");
  });
  it("timeout path: an injected small timeoutMs kills the never-resolving child and resolves undefined (no dangling handle)", async () => {
    let killed = false;
    let spawns = 0;
    const warns: string[] = [];
    const provider = maybeLoginShellEnv(join(root, "ws"), {
      env: ZSH_ENV,
      timeoutMs: 25,
      spawnShell: (): SpawnShellChild => {
        spawns += 1;
        return { stdout: neverChild().stdout, kill: () => { killed = true; } };
      },
      warn: (line) => warns.push(line),
    });
    await expect(provider!()).resolves.toBeUndefined();
    expect(killed).toBe(true);
    await expect(provider!()).resolves.toBeUndefined();
    expect(spawns).toBe(1);
    expect(warns).toHaveLength(1);
  });
});

describe("§5 case 15 — output cap", () => {
  it("stdout at EXACTLY the cap parses; cap+1 bytes → undefined", async () => {
    const cap = LOGIN_SHELL_SNAPSHOT_MAX_BYTES;
    const prefix = "n\0K=";
    const atCap = prefix + "a".repeat(cap - prefix.length);
    expect(Buffer.byteLength(atCap, "utf8")).toBe(cap);
    const over = prefix + "a".repeat(cap - prefix.length + 1);
    expect(Buffer.byteLength(over, "utf8")).toBe(cap + 1);
    const mk = (out: string) => maybeLoginShellEnv(join(root, "ws"), {
      env: ZSH_ENV,
      spawnShell: (): SpawnShellChild => fakeChild(out),
      warn: () => {},
    })!;
    await expect(mk(atCap)()).resolves.toEqual({ K: atCap.slice(prefix.length) });
    await expect(mk(over)()).resolves.toBeUndefined();
  });
});

// ---- §5 case 16 — buildToolSet wiring (top-level AND worktree children) ----

function recordingModel(responses: readonly AssistantMessage[]): ModelClient & { inputs: ModelInput[] } {
  const inputs: ModelInput[] = [];
  let i = 0;
  return {
    inputs,
    async generate(input: ModelInput): Promise<AssistantMessage> {
      inputs.push({ ...input, messages: [...input.messages], tools: [...input.tools] });
      const r = responses[i];
      i += 1;
      if (!r) throw new Error("scripted responses exhausted");
      return r;
    },
  };
}
const allowAll = async (): Promise<PermissionDecision> => ({ behavior: "allow" });
const toolByName = (tools: readonly Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not in set`);
  return t;
};

// A git repo with a worktree role whose child set is built by buildToolSet's
// internal childToolsFor — the seam case 16 must prove the provider rides.
async function gitRepoWithRole(roleId: string): Promise<void> {
  const git = (...args: string[]): ReturnType<typeof execFile> => execFile("git", ["-C", root, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "t");
  await writeFile(join(root, "marker.txt"), "init\n");
  await git("add", "marker.txt");
  await git("commit", "-q", "-m", "init");
  await mkdir(join(root, ".wudao", "agents"), { recursive: true });
  await writeFile(join(root, ".wudao", "agents", `${roleId}.json`), JSON.stringify({
    description: "snapshot wiring child",
    worktree: true,
    toolNames: ["shell"],
  }));
}

describe("§5 case 16 — buildToolSet threads loginShellEnv to the top-level AND child shell", () => {
  it("both resolve through the same provider; the merged var is visible in both outputs", async () => {
    await gitRepoWithRole("snapchild");
    let calls = 0;
    const provider = () => { calls += 1; return Promise.resolve({ SNAP_WIRE_VAL: "wired-9f3" }); };
    const tools = buildToolSet({
      workspaceRoot: root,
      model: recordingModel([]),
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      agents: { runId: "snap-run" },
      loginShellEnv: provider,
    });
    // Top level.
    const top = await toolByName(tools, "shell").execute({ command: 'printf %s "$SNAP_WIRE_VAL"' });
    expect(top.isError).toBeFalsy();
    expect(top.content).toContain("wired-9f3");
    expect(calls).toBe(1);
    // Worktree child: the child model scripts one shell call, then ends.
    const childModel = recordingModel([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "shell", arguments: { command: 'printf %s "$SNAP_WIRE_VAL"' } }] },
      { role: "assistant", content: "child done" },
    ]);
    const tools2 = buildToolSet({
      workspaceRoot: root,
      model: childModel,
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
      agents: { runId: "snap-run-2" },
      loginShellEnv: provider,
    });
    const task = await toolByName(tools2, "task").execute({ description: "d", prompt: "p", role: "snapchild" });
    expect(task.isError).toBeFalsy();
    // The child's shell resolved the SAME provider seam (second call).
    expect(calls).toBe(2);
    // And the merged var actually reached the child's exec env (the tool
    // result rides the child's second model input).
    expect(JSON.stringify(childModel.inputs[1]?.messages)).toContain("wired-9f3");
    expect(childModel.inputs[0]?.tools.map((t) => t.name)).toContain("shell");
  }, 30_000);

  it("loginShellEnv absent → no provider exists to call; shell behaves exactly as before", async () => {
    const tools = buildToolSet({
      workspaceRoot: root,
      model: recordingModel([]),
      canUseTool: allowAll,
      contextWindowTokens: 64_000,
    });
    const res = await toolByName(tools, "shell").execute({ command: 'printf %s "${SNAP_WIRE_VAL:-unset}"' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("unset");
  });
});

describe("§5 case 17 — ablation end-to-end (the real, non-injected maybeLoginShellEnv)", () => {
  it("suite invariant: the test environment presets WUDAO_NO_LOGIN_SHELL=1 — the no-real-shell guard setup-global-home.ts installs (pin it; the preset is otherwise the only thing keeping every live-frontend test in this process from spawning the developer's real login shell)", () => {
    expect(process.env.WUDAO_NO_LOGIN_SHELL).toBe("1");
  });

  it("WUDAO_NO_LOGIN_SHELL=1 in the real process env → undefined, so the frontend one-liner spreads nothing; deleting it restores the provider (lazily — no spawn either way)", () => {
    const prevNo = process.env.WUDAO_NO_LOGIN_SHELL;
    const prevShell = process.env.SHELL;
    process.env.SHELL = "/bin/zsh";
    try {
      process.env.WUDAO_NO_LOGIN_SHELL = "1";
      expect(maybeLoginShellEnv(process.cwd())).toBeUndefined();
      // The kill switch — nothing else — is what gated: without it the same
      // real call returns a provider. Construction is spawn-free (lazy), so
      // this stays deterministic and touches no real login shell.
      delete process.env.WUDAO_NO_LOGIN_SHELL;
      expect(maybeLoginShellEnv(process.cwd())).toBeDefined();
    } finally {
      if (prevNo === undefined) delete process.env.WUDAO_NO_LOGIN_SHELL; else process.env.WUDAO_NO_LOGIN_SHELL = prevNo;
      if (prevShell === undefined) delete process.env.SHELL; else process.env.SHELL = prevShell;
    }
  });
});
