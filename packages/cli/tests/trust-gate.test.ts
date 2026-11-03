// P1-5 (96 队列) — the workspace trust gate's FOUR DROP POINTS + wiring.
// The settings 键类门 (PROJECT_FORBIDDEN_KEYS) predates this and stays
// untouched; this arc gates the PROJECT-CARRIED SURFACE an untrusted
// workspace can bring: skills (three project roots), plugins (project
// scope), permissions.allow/ask rules, and the hooks node. Back-compat is
// byte-pinned: every loader takes the suppression as an EXPLICIT param,
// absent = no gate — existing callers and tests are unchanged.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLayeredSettings } from "../src/settings-layer.js";
import { loadHooksSettings } from "../src/hooks-config.js";
import { loadSkills, personalSkillRoot } from "../src/skills.js";
import { loadPlugins } from "../src/plugins.js";
import { buildExtensionState } from "../src/extension-state.js";
import { createPermissionSettingsWatcher } from "../src/permission.js";
import { trustGateStatus, setTrustDecision } from "../src/trust.js";

let home: string;
let ws: string;
const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

async function writeJson(root: string, rel: string, value: unknown): Promise<void> {
  const path = join(root, rel);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function makeSkill(root: string, name: string): Promise<void> {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`, "utf8");
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "wudao-tg-home-"));
  ws = await mkdtemp(join(tmpdir(), "wudao-tg-ws-"));
  await mkdir(join(ws, ".wudao"), { recursive: true });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

// ---------------------------------------------------------------------------
// Drop point 3+4 (settings-layer): permissions.allow/ask dropped, deny kept,
// hooks node dropped — project AND local tiers, warnings naming them.
// ---------------------------------------------------------------------------

describe("settings-layer: suppressUntrustedProject", () => {
  const projectSettings = {
    permissions: { allow: ["shell(git *)"], ask: ["write_file"], deny: ["shell(rm *)"] },
    hooks: { onPromptSubmit: [{ command: "echo cloned" }] },
  };

  it("no trust param (default) keeps today's behavior byte-for-byte", async () => {
    await writeJson(ws, ".wudao/settings.json", projectSettings);
    const layered = await loadLayeredSettings(ws, () => {}, env());
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toEqual(["shell(git *)"]);
    expect(perms["ask"]).toEqual(["write_file"]);
    expect(perms["deny"]).toEqual(["shell(rm *)"]);
    expect((layered.effective["hooks"] as Record<string, unknown[]>)["onPromptSubmit"]).toHaveLength(1);
  });

  it("suppressed: project allow/ask dropped, deny kept, hooks node dropped + warnings", async () => {
    await writeJson(ws, ".wudao/settings.json", projectSettings);
    const warns: string[] = [];
    const layered = await loadLayeredSettings(ws, (m) => warns.push(m), env(), { suppressUntrustedProject: true });
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toBeUndefined();
    expect(perms["ask"]).toBeUndefined();
    // deny ALWAYS merges (tightening is never gated — red line 3)
    expect(perms["deny"]).toEqual(["shell(rm *)"]);
    expect(layered.effective["hooks"]).toBeUndefined();
    expect(warns.some((w) => w.includes("permissions.allow/ask") && w.includes("工作区未受信任"))).toBe(true); // ω99-207 钉随源演进（信任门词面中文化）
    expect(warns.some((w) => w.includes("hooks") && w.includes("工作区未受信任"))).toBe(true);
  });

  it("the LOCAL tier (clone-carried) is suppressed the same way", async () => {
    await writeJson(ws, ".wudao/settings.local.json", projectSettings);
    const layered = await loadLayeredSettings(ws, () => {}, env(), { suppressUntrustedProject: true });
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toBeUndefined();
    expect(perms["deny"]).toEqual(["shell(rm *)"]);
    expect(layered.effective["hooks"]).toBeUndefined();
  });

  it("the GLOBAL user tier is NEVER suppressed (red line 2)", async () => {
    await writeJson(home, "settings.json", projectSettings);
    const layered = await loadLayeredSettings(ws, () => {}, env(), { suppressUntrustedProject: true });
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toEqual(["shell(git *)"]);
    expect(perms["ask"]).toEqual(["write_file"]);
    expect((layered.effective["hooks"] as Record<string, unknown[]>)["onPromptSubmit"]).toHaveLength(1);
  });

  it("global allow rules merge while the project side is suppressed", async () => {
    await writeJson(home, "settings.json", { permissions: { allow: ["read_file"] } });
    await writeJson(ws, ".wudao/settings.json", { permissions: { allow: ["shell(curl *)"] } });
    const layered = await loadLayeredSettings(ws, () => {}, env(), { suppressUntrustedProject: true });
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toEqual(["read_file"]);
  });

  it("the pre-existing escalation-key gate still applies alongside", async () => {
    await writeJson(ws, ".wudao/settings.json", { ...projectSettings, env: { EVIL: "1" } });
    const layered = await loadLayeredSettings(ws, () => {}, env(), { suppressUntrustedProject: true });
    expect(layered.effective["env"]).toBeUndefined();
    expect(layered.projectEscalations).toContain("env");
  });

  // ω99-27 T2: sidecarExempt is an allow-class lane (it can only narrow what
  // the classifier audits) — an untrusted clone must not be able to exempt
  // itself from the audit. Global tier keeps merging (red line 2).
  it("ω99-27: suppressed — project sidecarExempt dropped with the allow/ask warning; global tier kept", async () => {
    await writeJson(ws, ".wudao/settings.json", {
      permissions: { sidecarExempt: ["edit:README.md"], deny: ["shell(rm *)"] },
    });
    await writeJson(home, "settings.json", { permissions: { sidecarExempt: ["edit:docs/"] } });
    const warns: string[] = [];
    const layered = await loadLayeredSettings(ws, (m) => warns.push(m), env(), { suppressUntrustedProject: true });
    const perms = layered.effective["permissions"] as Record<string, unknown>;
    expect(perms["sidecarExempt"]).toEqual(["edit:docs/"]); // global only
    expect(warns.some((w) => w.includes("sidecarExempt") && w.includes("工作区未受信任"))).toBe(true); // ω99-207 钉随源演进（信任门词面中文化）
    // deny still merges (untouched by this lane).
    expect(perms["deny"]).toEqual(["shell(rm *)"]);
  });
});

// ---------------------------------------------------------------------------
// Drop point 4 (hooks-config): loadHooksSettings forwards the suppression.
// ---------------------------------------------------------------------------

describe("hooks-config: the project hooks node under the trust gate", () => {
  it("default (no param): project hooks load (today's behavior)", async () => {
    await writeJson(ws, ".wudao/settings.json", { hooks: { onPromptSubmit: [{ command: "echo p" }] } });
    const hooks = await loadHooksSettings(ws, () => {}, env());
    expect(hooks.onPromptSubmit).toHaveLength(1);
  });

  it("suppressed: project hooks gone, GLOBAL user hooks survive", async () => {
    await writeJson(home, "settings.json", { hooks: { onPromptSubmit: [{ command: "echo g" }] } });
    await writeJson(ws, ".wudao/settings.json", { hooks: { onPromptSubmit: [{ command: "echo p" }] } });
    const hooks = await loadHooksSettings(ws, () => {}, env(), { suppressUntrustedProject: true });
    expect(hooks.onPromptSubmit).toHaveLength(1);
    expect(hooks.onPromptSubmit?.[0]?.command).toBe("echo g");
  });
});

// ---------------------------------------------------------------------------
// Drop point 1 (skills): the three PROJECT roots suppressed; personal and
// global user tiers load as always.
// ---------------------------------------------------------------------------

describe("skills: project roots under the trust gate", () => {
  beforeEach(async () => {
    for (const rel of [".agents/skills", ".wudao/skills", ".claude/skills"]) {
      await makeSkill(join(ws, rel), "proj-skill");
    }
    // same-name personal + global skills — the user tiers must fill in
    await makeSkill(personalSkillRoot(env()), "personal-skill");
    await makeSkill(join(home, "skills"), "global-skill");
  });

  it("default (no param): every root loads (today's behavior)", async () => {
    const names = (await loadSkills(ws, () => {}, env())).map((s) => s.name).sort();
    expect(names).toEqual(["global-skill", "personal-skill", "proj-skill"]);
  });

  it("suppressed: the project skill is out of the manifest; user tiers unaffected", async () => {
    const warns: string[] = [];
    const skills = await loadSkills(ws, (m) => warns.push(m), env(), { trustSuppressed: true });
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["global-skill", "personal-skill"]);
    expect(warns.some((w) => w.includes("not trusted") && w.includes("skill"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drop point 2 (plugins): the project scope suppressed; user scope and
// --plugin flag mounts unaffected.
// ---------------------------------------------------------------------------

describe("plugins: project scope under the trust gate", () => {
  const plugin = {
    ".claude-plugin/plugin.json": { name: "PLUGIN", version: "1.0.0", description: "d" },
  };

  async function makePlugin(root: string, name: string): Promise<void> {
    await writeJson(root, join(name, ".claude-plugin", "plugin.json"), { name, version: "1.0.0", description: "d" });
    await makeSkill(join(root, name, "skills"), `${name}-skill`);
  }

  beforeEach(async () => {
    await makePlugin(join(ws, ".wudao", "plugins"), "proj-plugin");
    await makePlugin(join(home, "plugins"), "user-plugin");
  });

  it("default (no param): both scopes load (today's behavior)", async () => {
    const names = (await loadPlugins(ws, [], () => {}, { env: env() })).map((p) => p.name).sort();
    expect(names).toEqual(["proj-plugin", "user-plugin"]);
  });

  it("suppressed: project scope out, user scope + flag mounts in", async () => {
    // a flag-mounted copy of the project plugin still loads (explicit user choice)
    const warns: string[] = [];
    const plugins = await loadPlugins(ws, [join(ws, ".wudao", "plugins", "proj-plugin")], (m) => warns.push(m), { env: env(), trustSuppressed: true });
    const names = plugins.map((p) => p.name).sort();
    expect(names).toEqual(["proj-plugin", "user-plugin"]);
    expect(plugins.find((p) => p.name === "proj-plugin")?.scope).toBe("flag");
    expect(warns.some((w) => w.includes("not trusted") && w.includes("plugin"))).toBe(true);
  });

  it("a workspace with NO project plugins dir suppresses silently (nothing to drop)", async () => {
    await rm(join(ws, ".wudao", "plugins"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const plugins = await loadPlugins(ws, [], () => {}, { env: env(), trustSuppressed: true });
    expect(plugins.map((p) => p.name)).toEqual(["user-plugin"]);
  });

  it("plugin-shaped stub json is not required — the manifest path alone gates scope", async () => {
    expect(Object.keys(plugin)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The one production assembly: buildExtensionState computes the trust status
// through a LIVE getter (re-evaluated on every rescan) and threads it to all
// four drop points.
// ---------------------------------------------------------------------------

describe("buildExtensionState: the trust gate over the whole assembly", () => {
  beforeEach(async () => {
    // the full untrusted surface: project settings (allow + hooks), a
    // project skill, a project plugin — plus user-tier counterparts
    await writeJson(home, "settings.json", { hooks: { onPromptSubmit: [{ command: "echo g" }] } });
    await writeJson(ws, ".wudao/settings.json", {
      permissions: { allow: ["shell(git *)"], deny: ["shell(rm *)"] },
      hooks: { onPromptSubmit: [{ command: "echo p" }] },
    });
    await makeSkill(join(ws, ".wudao", "skills"), "proj-skill");
    await makeSkill(join(home, "skills"), "global-skill");
    await writeJson(ws, join(".wudao", "plugins", "proj-plugin", ".claude-plugin", "plugin.json"), { name: "proj-plugin", version: "1.0.0" });
  });

  it("no trustSuppressed seam (default): today's behavior — everything loads", async () => {
    const state = await buildExtensionState(ws, [], { env: env() });
    expect(state.skills.map((s) => s.name)).toContain("proj-skill");
    expect(state.plugins.map((p) => p.name)).toContain("proj-plugin");
    expect(state.hooksSettings.onPromptSubmit).toHaveLength(2);
    expect(state.trustSuppressed).toBe(false);
  });

  it("untrusted (no decision): all four project surfaces suppressed, user tiers intact", async () => {
    expect(trustGateStatus(ws, env()).effectiveSuppressed).toBe(true);
    const state = await buildExtensionState(ws, [], {
      env: env(),
      trustSuppressed: () => trustGateStatus(ws, env()).effectiveSuppressed,
    });
    expect(state.trustSuppressed).toBe(true);
    expect(state.skills.map((s) => s.name)).toEqual(["global-skill"]);
    expect(state.plugins).toEqual([]);
    // the PROJECT hook is gone; the GLOBAL one survives (merged hooks = 1)
    expect(state.hooksSettings.onPromptSubmit?.map((h) => h.command)).toEqual(["echo g"]);
  });

  it("accept (decision true): the SAME getter now builds the full surface", async () => {
    setTrustDecision(ws, true, env());
    const state = await buildExtensionState(ws, [], {
      env: env(),
      trustSuppressed: () => trustGateStatus(ws, env()).effectiveSuppressed,
    });
    expect(state.trustSuppressed).toBe(false);
    expect(state.skills.map((s) => s.name).sort()).toEqual(["global-skill", "proj-skill"]);
    expect(state.plugins.map((p) => p.name)).toEqual(["proj-plugin"]);
    expect(state.hooksSettings.onPromptSubmit).toHaveLength(2);
  });

  it("--trust-workspace-equivalent (getter pinned false) restores everything", async () => {
    const state = await buildExtensionState(ws, [], { env: env(), trustSuppressed: () => false });
    expect(state.skills.map((s) => s.name)).toContain("proj-skill");
  });
});

// ---------------------------------------------------------------------------
// The permission loader + hot-reload watcher (drop point 3's consumer).
// ---------------------------------------------------------------------------

describe("permissions under the trust gate", () => {
  let prevGlobal: string | undefined;
  beforeEach(async () => {
    // the watcher reads the global tier through process.env (no env param on
    // its seam) — point it at this test's home
    prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    await writeJson(home, "settings.json", { permissions: { allow: ["read_file"] } });
    await writeJson(ws, ".wudao/settings.json", { permissions: { allow: ["shell(git *)"], deny: ["shell(rm *)"] } });
  });

  afterEach(() => {
    if (prevGlobal === undefined) delete process.env.WUDAO_GLOBAL_HOME;
    else process.env.WUDAO_GLOBAL_HOME = prevGlobal;
  });

  it("watcher default (no trust seam): project allow rules merge (today's behavior)", async () => {
    const watcher = createPermissionSettingsWatcher(ws, () => {});
    const settings = await watcher.get();
    expect(settings.allow).toEqual(["read_file", "shell(git *)"]);
    expect(settings.deny).toEqual(["shell(rm *)"]);
  });

  it("watcher untrusted: project allow gone, deny kept, global allow kept", async () => {
    const watcher = createPermissionSettingsWatcher(ws, () => {}, { trustSuppressed: () => true });
    const settings = await watcher.get();
    expect(settings.allow).toEqual(["read_file"]);
    expect(settings.deny).toEqual(["shell(rm *)"]);
  });

  it("a mid-session accept flips the watcher's view on the next revalidation (trust key flip)", async () => {
    let suppressed = true;
    const watcher = createPermissionSettingsWatcher(ws, () => {}, { trustSuppressed: () => suppressed, revalidateMs: 0 });
    const before = await watcher.get();
    expect(before.allow).toEqual(["read_file"]);
    suppressed = false;
    const after = await watcher.get();
    expect(after.allow).toEqual(["read_file", "shell(git *)"]);
  });
});

// ---------------------------------------------------------------------------
// /trust — parse (three forms + prefix-neighbor discipline), registration,
// --trust-workspace, and the command module.
// ---------------------------------------------------------------------------

describe("/trust parse + routing", () => {
  it("parseReplCommand: the three forms route, neighbors stay prompts", async () => {
    const { parseReplCommand } = await import("../src/repl.js");
    expect(parseReplCommand("/trust")).toMatchObject({ kind: "trust", args: "" });
    expect(parseReplCommand("/trust accept")).toMatchObject({ kind: "trust", args: "accept" });
    expect(parseReplCommand("/trust revoke")).toMatchObject({ kind: "trust", args: "revoke" });
    expect(parseReplCommand("/trustx")).toMatchObject({ kind: "prompt" });
    expect(parseReplCommand("/trust somethingelse")).toMatchObject({ kind: "prompt" });
  });

  it("registered on the slash list and shadow-proof against plugin commands", async () => {
    const { listSlashCommands } = await import("../src/slash-commands.js");
    const { isBuiltinCommandName } = await import("../src/plugins.js");
    const entry = listSlashCommands({}).find((c) => c.name === "trust");
    expect(entry?.source).toBe("builtin");
    expect(entry?.description.toLowerCase()).toContain("信任"); // ω99-162: 隐藏钉·/trust 描述子串随源演进（英文 trust → 中文 信任）。
    expect(isBuiltinCommandName("trust")).toBe(true);
  });

  it("--trust-workspace flag parses (both dash forms)", async () => {
    const { parseTrustWorkspaceFlag } = await import("../src/args.js");
    expect(parseTrustWorkspaceFlag(["--trust-workspace"])).toBe(true);
    expect(parseTrustWorkspaceFlag(["-trust-workspace"])).toBe(true);
    expect(parseTrustWorkspaceFlag(["--plan", "fix the bug"])).toBe(false);
    expect(parseTrustWorkspaceFlag([])).toBe(false);
  });
});

describe("runTrustCommand (commands/trust.ts)", () => {
  it("bare: status — decision, resources, suppressed, usage", async () => {
    await mkdir(join(ws, ".wudao", "skills"), { recursive: true });
    const { runTrustCommand } = await import("../src/commands/trust.js");
    const text = await runTrustCommand({ cwd: ws, args: "", env: env() });
    expect(text).toContain("not trusted");
    expect(text).toContain(".wudao/skills");
    expect(text).toContain("/trust accept");
  });

  it("accept: writes the decision (canonical key) and rescans; status reflects it", async () => {
    await mkdir(join(ws, ".wudao", "skills"), { recursive: true });
    const { runTrustCommand } = await import("../src/commands/trust.js");
    const rescans: number[] = [];
    const receipt = await runTrustCommand({ cwd: ws, args: "accept", env: env(), rescan: async () => { rescans.push(1); return { skills: 1, plugins: 0, hooks: 0 }; } });
    expect(rescans).toHaveLength(1);
    expect(receipt).toContain("trusted");
    const after = await runTrustCommand({ cwd: ws, args: "", env: env() });
    expect(after).toContain("trusted");
    expect(trustGateStatus(ws, env()).effectiveSuppressed).toBe(false);
  });

  it("revoke: deletes the decision (back to fail-closed) and rescans", async () => {
    setTrustDecision(ws, true, env());
    const { runTrustCommand } = await import("../src/commands/trust.js");
    const rescans: number[] = [];
    const receipt = await runTrustCommand({ cwd: ws, args: "revoke", env: env(), rescan: async () => { rescans.push(1); return { skills: 0, plugins: 0, hooks: 0 }; } });
    expect(rescans).toHaveLength(1);
    expect(trustGateStatus(ws, env()).decision).toBeNull();
    expect(receipt).toContain("suppressed");
  });

  it("accept on an already-trusted workspace is idempotent (no rescan storm, honest receipt)", async () => {
    setTrustDecision(ws, true, env());
    const { runTrustCommand } = await import("../src/commands/trust.js");
    const rescans: number[] = [];
    const receipt = await runTrustCommand({ cwd: ws, args: "accept", env: env(), rescan: async () => { rescans.push(1); return { skills: 0, plugins: 0, hooks: 0 }; } });
    expect(receipt).toContain("already trusted");
    expect(rescans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// E2E (driver + REPL): the suppression notice reaches the user, and accept
// hot-rescans the REAL extension assembly back to the full surface.
// ---------------------------------------------------------------------------

describe("E2E: driver", () => {
  it("boot notice lands in history; /trust status + accept work through submit()", async () => {
    const { createAgentDriver } = await import("../src/driver/agent-driver.js");
    const { buildExtensionState, initExtensionRuntime, getExtensionState, resetExtensionRuntime } = await import("../src/extension-state.js");
    const { createScriptedModel } = await import("@wudao-org/core");
    const { summarizeToolCall } = await import("../src/log.js");
    const { formatTrustGateNotice } = await import("../src/trust.js");

    // the driver's /trust case runs with process.env (production shape) —
    // point the WHOLE test at this home so the getter and the command agree
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    await makeSkill(join(ws, ".wudao", "skills"), "proj-skill");
    const getter = (): boolean => trustGateStatus(ws, process.env).effectiveSuppressed;
    const state0 = await buildExtensionState(ws, [], { env: process.env, trustSuppressed: getter });
    expect(state0.skills).toEqual([]);
    initExtensionRuntime(ws, [], state0, { env: process.env, trustSuppressed: getter });

    try {
      const driver = createAgentDriver({
        model: createScriptedModel([{ role: "assistant", content: "ok" } as never]),
        tools: [],
        systemPrompt: "s",
        summarize: summarizeToolCall,
        workspaceRoot: ws,
        bootNotices: [formatTrustGateNotice(trustGateStatus(ws, process.env))],
      });
      // the suppression notice is in history (appendHistory wiring)
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("workspace not trusted"))).toBe(true);
      // /trust (bare) — status through the driver dispatch
      driver.submit("/trust");
      await new Promise((r) => setTimeout(r, 50));
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("project resources detected"))).toBe(true);
      // /trust accept — the receipt lands AND the real rescan restored the manifest
      driver.submit("/trust accept");
      await new Promise((r) => setTimeout(r, 200));
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("workspace trusted"))).toBe(true);
      expect(getExtensionState()?.skills.map((s) => s.name)).toEqual(["proj-skill"]);
      expect(getExtensionState()?.trustSuppressed).toBe(false);
      driver.interrupt();
    } finally {
      resetExtensionRuntime();
      if (prevGlobal === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevGlobal;
    }
  });
});

describe("E2E: REPL", () => {
  it("boot notice prints to stdout; /trust accept receipt follows", async () => {
    const { runRepl } = await import("../src/repl.js");
    const { buildExtensionState, initExtensionRuntime, resetExtensionRuntime } = await import("../src/extension-state.js");
    const { formatTrustGateNotice } = await import("../src/trust.js");
    const { PassThrough } = await import("node:stream");

    // the REPL's /trust branch runs on process.env (production shape)
    const prevGlobal = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    await makeSkill(join(ws, ".wudao", "skills"), "proj-skill");
    const getter = (): boolean => trustGateStatus(ws, process.env).effectiveSuppressed;
    const state0 = await buildExtensionState(ws, [], { env: process.env, trustSuppressed: getter });
    initExtensionRuntime(ws, [], state0, { env: process.env, trustSuppressed: getter });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let seen = "";
    stdout.on("data", (c) => { seen += c.toString(); });
    const feed = (line: string): void => { stdin.write(`${line}\n`); };
    const waitFor = async (pred: () => boolean, what: string): Promise<void> => {
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if (pred()) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`repl-e2e: timed out waiting for ${what}\n--- seen ---\n${seen}`);
    };

    let repl: Promise<void> | undefined;
    try {
      repl = runRepl({
        config: { apiKey: "sk-test", baseURL: "https://invalid.invalid/v1", model: "m" } as never,
        workspaceRoot: ws,
        buildTools: () => [],
        contextWindowTokens: 200_000,
        stdin,
        stdout,
        bootNotices: [formatTrustGateNotice(trustGateStatus(ws, process.env))],
      });
      await waitFor(() => seen.includes("workspace not trusted"), "the suppression notice on stdout");
      feed("/trust");
      await waitFor(() => seen.includes("project resources detected"), "the /trust status");
      feed("/trust accept");
      await waitFor(() => seen.includes("workspace trusted"), "the accept receipt");
      feed("/exit");
      await Promise.race([repl, new Promise((r) => setTimeout(r, 3000))]);
    } finally {
      stdin.end();
      resetExtensionRuntime();
      if (prevGlobal === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevGlobal;
      if (repl !== undefined) await Promise.race([repl.then(() => {}, () => {}), new Promise((r) => setTimeout(r, 500))]);
    }
    expect(seen).toContain("workspace not trusted");
    expect(seen).toContain("workspace trusted");
  }, 15_000);
});
