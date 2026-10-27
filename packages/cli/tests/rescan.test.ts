// cc-plugins A3 — the rescanExtensions hot-rescan seam. The boot extension
// assembly (plugins → commands/agents → hooks settings → skills → merged MCP
// config) is extracted into ONE re-entrant buildExtensionState(cwd, argv);
// rescanExtensions() re-runs it, swaps the live state box, and fans the fresh
// state out to every registered frontend sink (REPL/TUI/ui driver). The cache
// invariant under test: a rescan changes ONLY the trailing <available_skills>
// manifest — the prompt prefix (everything before the tail) stays byte-equal.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/prompt.js";
import { livePermissionRequestHook } from "../src/permission.js";
import type { PermissionRequestHookFn, StaticRuleDecide } from "../src/permission.js";
import { createScriptedModel } from "@wudao/core";
import type { AssistantMessage, AgentHooks, Tool } from "@wudao/core";
import { buildTool } from "@wudao/core";
import { summarizeToolCall } from "../src/log.js";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import {
  buildExtensionState,
  initExtensionRuntime,
  registerExtensionSwapSink,
  resetExtensionRuntime,
  rescanExtensions,
  type ExtensionState,
} from "../src/extension-state.js";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean | Promise<boolean>, what: string, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  await wait();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await wait();
  }
}

/** Strip the TRAILING <available_skills> manifest (the only section a rescan
 *  may touch). Absent section → unchanged (the no-skills baseline). */
function stripSkillsTail(prompt: string): string {
  return prompt.replace(/\n\n<available_skills>[\s\S]*\n<\/available_skills>$/, "");
}

const manifestLines = (prompt: string): number =>
  (prompt.match(/^- name: /gm) ?? []).length;

function stubReadTool(): Tool {
  return buildTool({
    name: "read_file",
    description: "stub read",
    parameters: { type: "object" as const, properties: {}, additionalProperties: false },
    execute: async () => ({ content: "CONTENT" }),
  });
}

interface Fixture {
  readonly ws: string;
  readonly env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

function tmpFixture(): Fixture {
  const ws = mkdtempSync(join(tmpdir(), "rescan-ws-"));
  const home = mkdtempSync(join(tmpdir(), "rescan-home-"));
  return {
    ws,
    env: { ...process.env, WUDAO_GLOBAL_HOME: home },
    cleanup: () => {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function writeSkill(ws: string, name: string, description = `the ${name} skill`): void {
  const dir = join(ws, ".wudao", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${name} body\n`, "utf8");
}

/** A minimal CC plugin under the project root: manifest + optional assets. */
function writePlugin(ws: string, dir: string, assets: { hooks?: boolean; mcp?: boolean; skill?: string }): string {
  const pluginDir = join(ws, ".wudao", "plugins", dir);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: dir, version: "1.0.0" }), "utf8");
  if (assets.hooks === true) {
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    writeFileSync(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { UserPromptSubmit: [{ type: "command", command: "echo plug" }] } }),
      "utf8",
    );
  }
  if (assets.mcp === true) {
    writeFileSync(join(pluginDir, ".mcp.json"), JSON.stringify({ mcpServers: { "plug-server": { command: "echo" } } }), "utf8");
  }
  if (assets.skill !== undefined) {
    mkdirSync(join(pluginDir, "skills", assets.skill), { recursive: true });
    writeFileSync(
      join(pluginDir, "skills", assets.skill, "SKILL.md"),
      `---\nname: ${assets.skill}\ndescription: plugin skill\n---\n\nbody\n`,
      "utf8",
    );
  }
  return pluginDir;
}

const quiet = (): void => {};

describe("A3: buildExtensionState — the re-entrant boot assembly", () => {
  let f: Fixture;
  beforeEach(() => {
    f = tmpFixture();
    resetExtensionRuntime();
  });
  afterEach(() => {
    resetExtensionRuntime();
    f.cleanup();
  });

  it("assembles every boot seam: plugins, commands, agents, hooks, skills, merged MCP config, counts", async () => {
    writePlugin(f.ws, "p1", { hooks: true, mcp: true, skill: "plug-skill" });
    writeSkill(f.ws, "ws-skill");
    const st = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    expect(st.plugins.map((p) => p.name)).toEqual(["p1"]);
    expect(st.pluginCommands).toEqual([]); // this fixture plugin declares none
    expect(st.pluginAgents).toEqual([]);
    // plugin hooks merged into the fire runtime (compiled, never executed here)
    expect(st.hooksSettings).toEqual({});
    expect((st.hooks?.onPromptSubmit as unknown) !== undefined).toBe(true);
    // skills: workspace first, then the plugin's (appendPluginSkills order)
    expect(st.skills.map((s) => s.name)).toEqual(["ws-skill", "plug-skill"]);
    expect(st.mcpConfig.servers["plug-server"]).toMatchObject({ command: "echo" });
    expect(st.counts).toEqual({ skills: 2, plugins: 1, hooks: 1 });
  });

  it("is deterministic: two runs over an unchanged workspace produce identical counts and skill lists", async () => {
    writeSkill(f.ws, "one");
    const a = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    const b = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    expect(a.counts).toEqual(b.counts);
    expect(a.skills.map((s) => s.name)).toEqual(b.skills.map((s) => s.name));
    expect(a.mcpConfig).toEqual(b.mcpConfig);
  });
});

describe("A3: rescanExtensions — counts + live swap", () => {
  let f: Fixture;
  beforeEach(() => {
    f = tmpFixture();
    resetExtensionRuntime();
  });
  afterEach(() => {
    resetExtensionRuntime();
    f.cleanup();
  });

  it("boot → rescan with nothing changed → identical counts, and the swap sink sees the same shape", async () => {
    writeSkill(f.ws, "one");
    const boot = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    initExtensionRuntime(f.ws, [], boot, { warn: quiet, env: f.env });
    const seen: ExtensionState[] = [];
    registerExtensionSwapSink((fresh) => seen.push(fresh));

    const counts = await rescanExtensions();
    expect(counts).toEqual(boot.counts);
    expect(counts).toEqual({ skills: 1, plugins: 0, hooks: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.counts).toEqual(boot.counts);
  });

  it("installing a skill then rescanning: the manifest tail grows by one line, the prompt prefix stays byte-equal", async () => {
    writeSkill(f.ws, "one");
    const boot = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    initExtensionRuntime(f.ws, [], boot, { warn: quiet, env: f.env });
    // the "session": a driver whose prompt was built from the boot skills
    const promptBefore = buildSystemPrompt(f.ws, false, boot.skills);
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [stubReadTool()],
      systemPrompt: promptBefore,
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    // the frontend sink, wired exactly like the real ones: swap skills and the
    // rebuilt prompt into the live driver
    registerExtensionSwapSink((fresh) =>
      driver.replaceExtensions({ skills: fresh.skills, systemPrompt: buildSystemPrompt(f.ws, false, fresh.skills) }),
    );

    writeSkill(f.ws, "two");
    const counts = await rescanExtensions();
    expect(counts.skills).toBe(2);

    const promptAfter = driver.state.systemPrompt;
    // THE cache invariant: only the trailing manifest changed
    expect(stripSkillsTail(promptBefore)).toBe(stripSkillsTail(promptAfter));
    // A3-review fold: pin the prefix against the canonical NO-SKILLS baseline
    // too — a systematic strip error (the regex eating prompt bytes when the
    // section is absent/misplaced) would cancel out in strip-vs-strip alone.
    const noSkills = buildSystemPrompt(f.ws, false, []);
    expect(stripSkillsTail(promptBefore)).toBe(noSkills);
    expect(stripSkillsTail(promptAfter)).toBe(noSkills);
    expect(promptAfter.startsWith(stripSkillsTail(promptBefore))).toBe(true);
    expect(manifestLines(promptAfter)).toBe(manifestLines(promptBefore) + 1);
    expect(promptAfter).toContain("- name: two");
    expect(promptBefore).not.toContain("- name: two");
    driver.dispose();
  });

  it("removing the skill again shrinks only the tail (prefix still byte-equal)", async () => {
    writeSkill(f.ws, "one");
    writeSkill(f.ws, "two");
    const boot = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    initExtensionRuntime(f.ws, [], boot, { warn: quiet, env: f.env });
    const promptBefore = buildSystemPrompt(f.ws, false, boot.skills);
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "ok" }]),
      tools: [stubReadTool()],
      systemPrompt: promptBefore,
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    registerExtensionSwapSink((fresh) =>
      driver.replaceExtensions({ skills: fresh.skills, systemPrompt: buildSystemPrompt(f.ws, false, fresh.skills) }),
    );

    rmSync(join(f.ws, ".wudao", "skills", "two"), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    const counts = await rescanExtensions();
    expect(counts.skills).toBe(1);
    const promptAfter = driver.state.systemPrompt;
    expect(stripSkillsTail(promptBefore)).toBe(stripSkillsTail(promptAfter));
    expect(manifestLines(promptAfter)).toBe(manifestLines(promptBefore) - 1);
    expect(promptAfter).not.toContain("- name: two");
    driver.dispose();
  });

  it("hooks and MCP changes hot-swap in the fresh state (the plugin's hook commands join, its MCP server merges)", async () => {
    const boot = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    initExtensionRuntime(f.ws, [], boot, { warn: quiet, env: f.env });
    expect(boot.counts).toEqual({ skills: 0, plugins: 0, hooks: 0 });
    expect(boot.mcpConfig.servers).toEqual({});

    writePlugin(f.ws, "p1", { hooks: true, mcp: true, skill: "plug-skill" });
    const counts = await rescanExtensions();
    expect(counts).toEqual({ skills: 1, plugins: 1, hooks: 1 });
    const live = await rescanExtensions(); // idempotent on a second pass
    expect(live).toEqual(counts);
  });

  it("a throwing sink is isolated: later sinks still receive the swap and the rescan still resolves", async () => {
    writeSkill(f.ws, "one");
    const boot = await buildExtensionState(f.ws, [], { warn: quiet, env: f.env });
    initExtensionRuntime(f.ws, [], boot, { warn: quiet, env: f.env });
    registerExtensionSwapSink(() => {
      throw new Error("sink blew up");
    });
    const seen: ExtensionState[] = [];
    registerExtensionSwapSink((fresh) => seen.push(fresh));

    const counts = await rescanExtensions();
    expect(counts.skills).toBe(1);
    expect(seen).toHaveLength(1);
  });

  it("unregistering stops delivery; a rescan before any boot returns fresh counts without firing sinks", async () => {
    // uninitialized: no live session — sinks must not fire
    resetExtensionRuntime();
    const seen: ExtensionState[] = [];
    const unregister = registerExtensionSwapSink((fresh) => seen.push(fresh));
    unregister();
    const counts = await rescanExtensions();
    expect(typeof counts.skills).toBe("number");
    expect(typeof counts.plugins).toBe("number");
    expect(typeof counts.hooks).toBe("number");
    expect(seen).toEqual([]);
  });
});

describe("A3: driver replaceExtensions — the option/prompt swap seam", () => {
  it("idle: skills/pluginCommands/hooks land in the option set AND state.systemPrompt; the next run reads the new hooks", async () => {
    const fired: string[] = [];
    const hooksA: AgentHooks = { onRunStop: async () => { fired.push("A"); } };
    const hooksB: AgentHooks = { onRunStop: async () => { fired.push("B"); } };
    const driver = createAgentDriver({
      model: createScriptedModel([{ role: "assistant", content: "done" }]),
      tools: [stubReadTool()],
      systemPrompt: "PROMPT-A",
      hooks: hooksA,
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    expect(driver.state.systemPrompt).toBe("PROMPT-A");

    driver.replaceExtensions({ hooks: hooksB, systemPrompt: "PROMPT-B", pluginCommands: [] });
    expect(driver.state.systemPrompt).toBe("PROMPT-B");

    driver.submit("go");
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(fired).toEqual(["B"]); // the run started AFTER the swap read hooksB
    driver.dispose();
  });

  it("busy: the swap parks and lands at run settle — the in-flight run keeps the old prompt", async () => {
    let release: (() => void) | undefined;
    const model = {
      generate: () =>
        new Promise<AssistantMessage>((res) => {
          release = () => res({ role: "assistant", content: "late" });
        }),
    };
    const driver = createAgentDriver({
      model,
      tools: [stubReadTool()],
      systemPrompt: "PROMPT-A",
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === true, "run to start");

    driver.replaceExtensions({ systemPrompt: "PROMPT-B" });
    expect(driver.state.systemPrompt).toBe("PROMPT-A"); // parked, not landed

    release?.();
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(driver.state.systemPrompt).toBe("PROMPT-B"); // landed at settle
    driver.dispose();
  });

  it("busy merges successive parked swaps; the later one wins on overlapping fields", async () => {
    let release: (() => void) | undefined;
    const model = {
      generate: () =>
        new Promise<AssistantMessage>((res) => {
          release = () => res({ role: "assistant", content: "late" });
        }),
    };
    const driver = createAgentDriver({
      model,
      tools: [stubReadTool()],
      systemPrompt: "PROMPT-A",
      summarize: summarizeToolCall,
      canUseTool: async () => ({ behavior: "allow" as const }),
    });
    driver.submit("go");
    await until(() => driver.getStatus().busy === true, "run to start");
    driver.replaceExtensions({ systemPrompt: "PROMPT-B" });
    driver.replaceExtensions({ systemPrompt: "PROMPT-C" });
    release?.();
    await until(() => driver.getStatus().busy === false, "run to finish");
    expect(driver.state.systemPrompt).toBe("PROMPT-C");
    driver.dispose();
  });
});

describe("A3: rescan through a symlinked workspace stays consistent with the real root", () => {
  it("boot via the alias, rescan via the same stored cwd — counts stable either way", async () => {
    const f = tmpFixture();
    const aliasParent = mkdtempSync(join(tmpdir(), "rescan-alias-"));
    try {
      resetExtensionRuntime();
      writeSkill(f.ws, "one");
      const alias = join(aliasParent, "ws");
      symlinkSync(f.ws, alias);
      const boot = await buildExtensionState(alias, [], { warn: quiet, env: f.env });
      initExtensionRuntime(alias, [], boot, { warn: quiet, env: f.env });
      const counts = await rescanExtensions();
      expect(counts).toEqual({ skills: 1, plugins: 0, hooks: 0 });
    } finally {
      resetExtensionRuntime();
      rmSync(aliasParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      f.cleanup();
    }
  });
});

// A3 review fix (LOW): the REPL's permission layer must read the LIVE
// onPermissionRequest — a rescan swaps hooks between turns, and a
// once-captured hook argument would freeze the boot hook until restart.
describe("A3 review fix: livePermissionRequestHook reads the hook per decision", () => {
  it("a swapped onPermissionRequest reaches the very next decision", async () => {
    const seen: string[] = [];
    let hook: PermissionRequestHookFn | undefined = async (toolName) => {
      seen.push(`boot:${toolName}`);
      return undefined; // no opinion → the pipeline continues
    };
    // ask-class static outcome (the literal tri-state string) → the hook
    // layer actually fires
    const staticDecide: StaticRuleDecide = async () => "ask";
    const gate = livePermissionRequestHook(() => hook, () => "default", staticDecide);

    expect(await gate("shell", { command: "ls" })).toBe("ask");
    expect(seen).toEqual(["boot:shell"]);

    // the rescan swap: a NEW hook reference lands in the live box
    hook = async (toolName) => {
      seen.push(`new:${toolName}`);
      return { behavior: "deny", reason: "policy" };
    };
    await expect(gate("shell", { command: "ls" })).resolves.toEqual({ behavior: "deny", reason: "policy" });
    expect(seen).toEqual(["boot:shell", "new:shell"]); // boot hook never fired again
  });

  it("no hook configured → the layer stays absent (static passthrough, nothing consulted)", async () => {
    let hook: PermissionRequestHookFn | undefined = undefined;
    const staticDecide: StaticRuleDecide = async () => "ask";
    const gate = livePermissionRequestHook(() => hook, () => "default", staticDecide);
    expect(await gate("read_file", {})).toBe("ask");
  });
});
