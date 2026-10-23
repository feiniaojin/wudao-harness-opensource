// ω-4d (import-queue item 17) — login-shell env snapshot, CORE half of the §5
// matrix (design 61, cases 1-10): the pure shell-snapshot module and its
// integration with shell's host path via a fixture provider. All cases
// are deterministic — fixture NUL dumps and a fake docker script only; no real
// login shell is spawned (the runtime half, cases 11-17, lives in
// packages/cli/tests/shell-snapshot.test.ts).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loginShellKindFromPath,
  buildLoginShellCaptureScript,
  parseLoginShellEnvOutput,
  scrubSnapshotEnv,
  mergeLoginShellEnv,
  scrubChildEnvOf,
  LOGIN_SHELL_SNAPSHOT_MAX_BYTES,
} from "../src/tools/shell-snapshot.js";
import { createShellTool, scrubChildEnv } from "../src/tools/shell.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

// win32: a bare .mjs cannot be exec'd — the dockerPath option carries the
// two-word `node <entry>` form there (the product's splitJsBin handles it).
const FAKE_DOCKER = process.platform === "win32"
  ? `${process.execPath} ${join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs")}`
  : join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-docker.mjs");

// §5 fixture vocabulary: rc stdout noise, the NUL marker, then NUL-delimited
// env pairs exactly as `/usr/bin/env -0` emits them.
const FIXTURE_DUMP = "rc noise line\n\x00K=V\x00PATH=/snap/bin:/usr/bin:/bin\x00PWD=/old\x00FOO_API_KEY=x\x00";

const shellSnapshot = (snapshot: Record<string, string>) => (): Promise<Readonly<Record<string, string>> | undefined> =>
  Promise.resolve(snapshot);

describe("§5 case 1 — loginShellKindFromPath", () => {
  it("maps plain basenames to kinds", () => {
    expect(loginShellKindFromPath("/bin/zsh")).toBe("zsh");
    expect(loginShellKindFromPath("/usr/local/bin/bash")).toBe("bash");
    expect(loginShellKindFromPath("/bin/sh")).toBe("sh");
  });
  it("reduces versioned stems (codex detect_shell_type's file-stem recursion)", () => {
    expect(loginShellKindFromPath("/opt/zsh-5.9/bin/zsh-5.9")).toBe("zsh");
    expect(loginShellKindFromPath("/usr/bin/bash-5.2")).toBe("bash");
  });
  it("returns undefined for unsupported shells and empty paths (feature absent, byte-identical behavior)", () => {
    expect(loginShellKindFromPath("/usr/bin/fish")).toBeUndefined();
    expect(loginShellKindFromPath("pwsh")).toBeUndefined();
    expect(loginShellKindFromPath("cmd")).toBeUndefined();
    expect(loginShellKindFromPath("")).toBeUndefined();
  });
});

describe("§5 case 2 — buildLoginShellCaptureScript", () => {
  it("zsh: sources $ZDOTDIR/.zshrc else $HOME/.zshrc behind a readability guard", () => {
    const s = buildLoginShellCaptureScript("zsh");
    expect(s).toContain('[[ -n "$ZDOTDIR" ]]');
    expect(s).toContain('"$ZDOTDIR/.zshrc"');
    expect(s).toContain('"$HOME/.zshrc"');
    expect(s).toContain('[[ -r "$rc" ]]');
    expect(s).toContain('. "$rc"');
  });
  it("bash: sources ~/.bashrc only when BASH_ENV is unset and the file is readable", () => {
    const s = buildLoginShellCaptureScript("bash");
    expect(s).toContain('[ -z "$BASH_ENV" ]');
    expect(s).toContain('[ -r "$HOME/.bashrc" ]');
    expect(s).toContain('. "$HOME/.bashrc"');
  });
  it("sh: sources $ENV when set and readable", () => {
    const s = buildLoginShellCaptureScript("sh");
    expect(s).toContain('[ -n "$ENV" ]');
    expect(s).toContain('[ -r "$ENV" ]');
    expect(s).toContain('. "$ENV"');
  });
  it("every variant emits the NUL marker and dumps env via the ABSOLUTE /usr/bin/env -0", () => {
    for (const kind of ["zsh", "bash", "sh"] as const) {
      const s = buildLoginShellCaptureScript(kind);
      expect(s).toContain("printf '\\0'");
      expect(s).toContain("/usr/bin/env -0");
    }
  });
  it("uses no PATH-resolved command word an rc alias/function could shadow (builtin allowlist)", () => {
    // codex hardening: `/usr/bin/env` by absolute path; everything else must be
    // a keyword/builtin. Tokenize command segments and check each command word.
    const KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "!"]);
    const BUILTINS = new Set(["[[", "[", ".", "source", "printf", "test", "true", "false"]);
    for (const kind of ["zsh", "bash", "sh"] as const) {
      const script = buildLoginShellCaptureScript(kind);
      const segments = script.split(/[\n;]|&&|\|\|/g).map((s) => s.trim()).filter((s) => s.length > 0);
      expect(segments.length).toBeGreaterThan(0);
      for (const seg of segments) {
        const words = seg.split(/\s+/);
        let i = 0;
        while (i < words.length && KEYWORDS.has(words[i] ?? "")) i += 1;
        const cmd = words[i];
        if (cmd === undefined || cmd === "") continue; // keyword-only segment (then/else/fi)
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(cmd)) continue; // variable assignment
        expect(BUILTINS.has(cmd) || cmd.startsWith("/"), `${kind}: command word "${cmd}" must be a builtin or absolute path`).toBe(true);
      }
    }
  });
});

describe("§5 case 3 — parseLoginShellEnvOutput", () => {
  it("drops pre-NUL rc noise and parses entries (the parser does NOT scrub — separation of concerns)", () => {
    const parsed = parseLoginShellEnvOutput(FIXTURE_DUMP);
    expect(parsed).toBeDefined();
    expect(parsed?.PATH).toBe("/snap/bin:/usr/bin:/bin");
    expect(parsed?.K).toBe("V");
    expect(parsed?.PWD).toBe("/old"); // exclusions are scrubSnapshotEnv's job, not the parser's
    expect(parsed?.FOO_API_KEY).toBe("x"); // credential rules too — see scrubSnapshotEnv
    expect(parsed?.["rc noise line"]).toBeUndefined();
  });
  it("splits values on the FIRST '=' (values may contain '=')", () => {
    const parsed = parseLoginShellEnvOutput("noise\x00EQA=a=b\x00");
    expect(parsed).toEqual({ EQA: "a=b" });
  });
  it("filters invalid names (9bad, a-b, empty) and empty tails", () => {
    const parsed = parseLoginShellEnvOutput("n\x00GOOD=1\x009bad=x\x00a-b=x\x00=no-name\x00");
    expect(parsed).toEqual({ GOOD: "1" });
  });
  it("no NUL → undefined; NUL with nothing usable after it → undefined (fail-open, never a partial env)", () => {
    expect(parseLoginShellEnvOutput("no marker at all")).toBeUndefined();
    expect(parseLoginShellEnvOutput("noise\x00")).toBeUndefined();
    expect(parseLoginShellEnvOutput("noise\x009bad=x\x00a-b=y\x00")).toBeUndefined();
  });
});

describe("§5 case 4 — scrubSnapshotEnv + mergeLoginShellEnv composition", () => {
  it("snapshot side: drops PWD/OLDPWD/BASH_ENV/ENV/ZDOTDIR/_ and credential-shaped names", () => {
    const scrubbed = scrubSnapshotEnv({
      PWD: "/old", OLDPWD: "/older", BASH_ENV: "/rc/bash-env", ENV: "/rc/env", ZDOTDIR: "/rc/zdot", _: "/usr/bin/env",
      FOO_API_KEY: "x", GITHUB_TOKEN: "t", WUDAO_X: "1", OPENAI_API_KEY: "k",
      PATH: "/snap/bin", KEEP: "yes",
    });
    expect(Object.keys(scrubbed).sort()).toEqual(["KEEP", "PATH"]);
  });
  it("merged env keeps the rc PATH (snapshot wins) and NO excluded/credential var, from BOTH directions", () => {
    // Direction 1: the secrets/exclusions ride the SNAPSHOT.
    const snapshot = parseLoginShellEnvOutput(FIXTURE_DUMP) ?? {};
    // Direction 2: the secrets ride the BASE (which the real path runs through
    // scrubChildEnv — exercised here through the pure form over a raw record).
    const rawBase: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin",
      WUDAO_X: "base-secret",
      OPENAI_API_KEY: "base-secret",
      MY_TOKEN: "base-secret",
      KEEP: "yes",
    };
    const base = scrubChildEnvOf(rawBase);
    const merged = mergeLoginShellEnv(base, scrubSnapshotEnv(snapshot));
    expect(merged.PATH).toBe("/snap/bin:/usr/bin:/bin"); // snapshot wins — terminal fidelity
    expect(merged.KEEP).toBe("yes");
    for (const k of ["PWD", "OLDPWD", "BASH_ENV", "ENV", "ZDOTDIR", "_", "FOO_API_KEY", "WUDAO_X", "OPENAI_API_KEY", "MY_TOKEN"]) {
      expect(merged).not.toHaveProperty(k);
    }
  });
  it("mergeLoginShellEnv(base, {}) deep-equals base (empty snapshot is a no-op)", () => {
    const base = scrubChildEnvOf({ PATH: "/usr/bin:/bin", HOME: "/h" });
    expect(mergeLoginShellEnv(base, {})).toEqual(base);
  });
});

describe("§5 cases 5-7 — shell host path with a fixture provider", () => {
  it("case 5: the snapshot env reaches the host sh -c child (merged, not replaced)", async () => {
    const tool = createShellTool({
      workspaceRoot: root,
      loginShellEnv: shellSnapshot({ SNAP_TEST_VAL: "snap-visible-9f3", PATH: process.env.PATH ?? "/usr/bin:/bin" }),
    });
    const res = await tool.execute({ command: 'printf %s "$SNAP_TEST_VAL"' });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("snap-visible-9f3");
  });
  it("case 5: a binary reachable ONLY via the snapshot PATH resolves (the proven gap: rc-added PATH segments)", async () => {
    const binDir = join(root, "snapbin");
    await mkdir(binDir);
    const fake = join(binDir, "wudao-snap-probe");
    await writeFile(fake, "#!/bin/sh\necho from-snapshot-path\n");
    await chmod(fake, 0o755);
    const tool = createShellTool({
      workspaceRoot: root,
      loginShellEnv: shellSnapshot({ PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}` }),
    });
    const res = await tool.execute({ command: "wudao-snap-probe" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("from-snapshot-path");
  });
  it("case 6: ONE execute calls the provider at most once; a second execute calls it again (memoization is the PROVIDER's contract — the tool stays stateless) and produces a byte-identical result; a WUDAO_-prefixed snapshot var never reaches the child", async () => {
    let calls = 0;
    const provider = () => { calls += 1; return Promise.resolve({ SNAP_TEST_VAL: "stable-val", WUDAO_SNAP_TEST: "must-not-leak" }); };
    const tool = createShellTool({ workspaceRoot: root, loginShellEnv: provider });
    const r1 = await tool.execute({ command: 'printf %s "$SNAP_TEST_VAL"' });
    expect(calls).toBe(1);
    const r2 = await tool.execute({ command: 'printf %s "$SNAP_TEST_VAL"' });
    expect(calls).toBe(2);
    expect(r2.content).toBe(r1.content);
    const r3 = await tool.execute({ command: 'printf %s "${WUDAO_SNAP_TEST:-unset}"' });
    expect(r3.content).toContain("unset");
    expect(r3.content).not.toContain("must-not-leak");
  });
  it("case 7: a throwing or undefined provider fails open — byte-identical to the provider-absent run, exit 0", async () => {
    const command = "node -e \"process.stdout.write('stable-output')\"";
    const plain = createShellTool({ workspaceRoot: root });
    const throwing = createShellTool({ workspaceRoot: root, loginShellEnv: () => Promise.reject(new Error("capture boom")) });
    const absent = createShellTool({ workspaceRoot: root, loginShellEnv: () => Promise.resolve(undefined) });
    const a = await plain.execute({ command });
    const b = await throwing.execute({ command });
    const c = await absent.execute({ command });
    expect(b.isError).toBeFalsy();
    expect(c.isError).toBeFalsy();
    expect(b.content).toBe(a.content);
    expect(c.content).toBe(a.content);
  });
});

describe("§5 case 8 — provider absent: pre-change env behavior (golden)", () => {
  it("the child env is exactly the scrubbed process env (printenv parity with scrubChildEnv)", async () => {
    const prev = { ...process.env };
    process.env.SNAP_PARITY_KEEP = "keep-me";
    process.env.SNAP_PARITY_TOKEN = "drop-me";
    try {
      // The golden: what scrubChildEnv() keeps, printenv shows — and nothing else.
      expect(scrubChildEnv().SNAP_PARITY_KEEP).toBe("keep-me");
      expect(scrubChildEnv().SNAP_PARITY_TOKEN).toBeUndefined();
      const tool = createShellTool({ workspaceRoot: root });
      // NOTE: printenv exits 1 when ANY requested var is unset on some
      // platforms (GNU coreutils — Git Bash on win32) and 0 on others
      // (BSD/macOS); the PARITY contract is the printed values, so query
      // each var separately and never assert the exit code.
      const keep = await tool.execute({ command: "printenv SNAP_PARITY_KEEP" });
      const drop = await tool.execute({ command: "printenv SNAP_PARITY_TOKEN" });
      expect(keep.content).toContain("keep-me");
      expect(drop.content).not.toContain("drop-me");
    } finally {
      process.env = prev;
    }
  });
});

describe("§5 case 9 — sandbox short-circuit precedes the snapshot", () => {
  it("with sandbox set the provider is NEVER invoked (call count 0); the docker argv carries the user command verbatim and no snapshot artifact", async () => {
    let calls = 0;
    const log = join(root, "docker.log");
    await writeFile(log, "");
    const prevEnv = { ...process.env };
    process.env.FAKE_DOCKER_LOG = log;
    try {
      const tool = createShellTool({
        workspaceRoot: root,
        sandbox: { dockerPath: FAKE_DOCKER },
        loginShellEnv: () => { calls += 1; return Promise.resolve({ SNAP_TEST_VAL: "snap-should-not-ride" }); },
      });
      const res = await tool.execute({ command: "printf hello-sandbox" });
      expect(res.isError).toBeFalsy();
      expect(calls).toBe(0);
      const invocations = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]);
      const run = invocations.find((a) => a.includes("run"));
      expect(run).toBeDefined();
      expect(run?.[run.length - 2]).toBe("-c");
      expect(run?.[run.length - 1]).toBe("printf hello-sandbox");
      expect(JSON.stringify(invocations)).not.toContain("SNAP_TEST_VAL");
      expect(JSON.stringify(invocations)).not.toContain("snap-should-not-ride");
    } finally {
      process.env = prevEnv;
    }
  });
});

describe("§5 case 10 — exclusions end-to-end through a real /bin/sh child", () => {
  it("snapshot-carried PWD/OLDPWD/BASH_ENV/ENV/ZDOTDIR/_ values never reach the child env", async () => {
    const tool = createShellTool({
      workspaceRoot: root,
      loginShellEnv: shellSnapshot({
        PWD: "/snap-pwd-value",
        OLDPWD: "/snap-oldpwd-value",
        BASH_ENV: "/snap/bash-env-value",
        ENV: "/snap/env-value",
        ZDOTDIR: "/snap/zdotdir-value",
        _: "/snap/underscore-value",
      }),
    });
    const res = await tool.execute({
      command: 'printf "%s %s %s %s %s %s" "$PWD" "$OLDPWD" "$BASH_ENV" "$ENV" "$ZDOTDIR" "$_"',
    });
    expect(res.isError).toBeFalsy();
    for (const value of ["/snap-pwd-value", "/snap-oldpwd-value", "/snap/bash-env-value", "/snap/env-value", "/snap/zdotdir-value", "/snap/underscore-value"]) {
      expect(res.content).not.toContain(value);
    }
  });
});

describe("constants", () => {
  it("carries codex's caps (512 KiB output budget)", () => {
    expect(LOGIN_SHELL_SNAPSHOT_MAX_BYTES).toBe(512 * 1024);
  });
});
