// M36: the upstream harness plugin compatibility — discovery (`.wudao/plugins/*/` +
// `<globalHome>/plugins/*/` (A2 user scope) + `--plugin <path>`), read-only
// asset mapping (skills / commands / mcp / hooks), warn+skip for unsupported
// assets, and the config merges the CLI feeds into its existing seams.
// Plugins are CONFIG packages: nothing here ever executes plugin code.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPlugins,
  appendPluginSkills,
  collectPluginCommands,
  collectPluginAgents,
  parseAgentFrontmatter,
  mergeMcpConfigs,
  mergeHooksSettings,
  expandCommandTemplate,
  buildPluginCommandMessage,
  formatPluginList,
  type PluginLoadDeps,
} from "../src/plugins.js";
import { pluginMain } from "../src/commands/plugins-command.js";
import { loadSkills } from "../src/skills.js";
import { loadMcpConfig } from "../src/mcp/config.js";
import { HOOK_EVENT_MAP } from "../src/plugins.js";
import { CANONICAL_HOOK_EVENTS } from "../src/hooks-config.js";

function tmpWs(): { ws: string; cleanup: () => void } {
  const ws = mkdtempSync(join(tmpdir(), "plugins-"));
  return { ws, cleanup: () => rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

// A2: discovery now also reads the USER root `<globalHome>/plugins/` and the
// global enabledPlugins filter — every legacy call below is pinned to an
// ISOLATED home so the developer's real ~/.wudao can never leak into a test.
const isolatedHome = mkdtempSync(join(tmpdir(), "plugins-home-"));
const ISOLATED_ENV: NodeJS.ProcessEnv = { ...process.env, WUDAO_GLOBAL_HOME: isolatedHome };
const ISOLATED: PluginLoadDeps = { env: ISOLATED_ENV };
afterAll(() => {
  rmSync(isolatedHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** loadPlugins against the isolated home (the pre-A2 call shape). */
function load(ws: string, extra: readonly string[] = [], warn: (m: string) => void = () => {}): ReturnType<typeof loadPlugins> {
  return loadPlugins(ws, extra, warn, ISOLATED);
}

/** Writes `<ws>/.wudao/plugins/<dir>/.claude-plugin/plugin.json`. Returns the
 *  plugin dir. */
function writePlugin(ws: string, dir: string, manifest: Record<string, unknown>): string {
  const pluginDir = join(ws, ".wudao", "plugins", dir);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  return pluginDir;
}

function writeAsset(pluginDir: string, rel: string, text: string): string {
  const p = join(pluginDir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text, "utf8");
  return p;
}

const SKILL_MD = "---\nname: greet\ndescription: Greet a user warmly\n---\n\n# Greet\n\nAlways say hello.\n";
const AGENT_MD = (frontmatter: string, body = "You are the plugin reviewer.\n") => `---\n${frontmatter}\n---\n\n${body}`;
const COMMAND_MD = "---\ndescription: Say hello to someone\n---\n\nSay hello to $ARGUMENTS (first token: $0).";

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

describe("loadPlugins: discovery", () => {
  it("no .wudao/plugins dir → zero plugins, zero warnings (no-plugin baseline pin)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      expect(load(ws, [], (m) => warnings.push(m))).toEqual([]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("discovers an installed plugin and maps its manifest + assets", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "fixture", { name: "fixture", version: "1.2.3", description: "a fixture" });
      writeAsset(dir, "skills/greet/SKILL.md", SKILL_MD);
      writeAsset(dir, "commands/hello.md", COMMAND_MD);
      writeAsset(dir, ".mcp.json", JSON.stringify({ mcpServers: { srv: { command: "echo" } } }));
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      expect(plugins.length).toBe(1);
      const p = plugins[0];
      expect(p?.name).toBe("fixture");
      expect(p?.version).toBe("1.2.3");
      expect(p?.description).toBe("a fixture");
      expect(p?.dir).toBe(dir);
      expect(p?.source).toBe("plugins-dir");
      expect(p?.skills.map((s) => s.name)).toEqual(["greet"]);
      expect(p?.commands.map((c) => c.name)).toEqual(["hello"]);
      expect(Object.keys(p?.mcpServers ?? {})).toEqual(["srv"]);
    } finally {
      cleanup();
    }
  });

  it("a plugins/ entry without .claude-plugin/plugin.json is warned + skipped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      mkdirSync(join(ws, ".wudao", "plugins", "not-a-plugin"), { recursive: true });
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("not-a-plugin");
      expect(warnings[0]).toContain("plugin.json");
    } finally {
      cleanup();
    }
  });

  it("malformed plugin.json / missing name → warned + skipped (never throws)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "bad-json", {});
      writeFileSync(join(dir, ".claude-plugin", "plugin.json"), "{ nope", "utf8");
      writePlugin(ws, "nameless", { version: "1.0.0" });
      expect(load(ws, [], (m) => warnings.push(m))).toEqual([]);
      expect(warnings.length).toBe(2);
      expect(warnings[0]).toContain("bad-json");
      expect(warnings[1]).toContain("nameless");
    } finally {
      cleanup();
    }
  });

  it("--plugin <path> mounts a one-shot plugin (flag source); missing path warns + skips", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const outside = mkdtempSync(join(tmpdir(), "plugin-outside-"));
      try {
        mkdirSync(join(outside, ".claude-plugin"), { recursive: true });
        writeFileSync(join(outside, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "flagged" }), "utf8");
        writeAsset(outside, "commands/flag.md", COMMAND_MD);
        // relative path resolves against the workspace root
        mkdirSync(join(ws, "vendor"), { recursive: true });
        const vendor = join(ws, "vendor", "vendored");
        mkdirSync(join(vendor, ".claude-plugin"), { recursive: true });
        writeFileSync(join(vendor, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "vendored" }), "utf8");
        const plugins = load(ws, [outside, "vendor/vendored", process.platform === "win32" ? "C:\\no\\such\\dir" : "/no/such/dir"], (m) => warnings.push(m));
        // flag mounts load in argv order, after any installed plugins
        expect(plugins.map((p) => p.name)).toEqual(["flagged", "vendored"]);
        expect(plugins.every((p) => p.source === "flag")).toBe(true);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain(process.platform === "win32" ? "C:\\no\\such\\dir" : "/no/such/dir");
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      cleanup();
    }
  });

  it("duplicate name (installed + flag) → first (plugins-dir) wins with a warning", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const installed = writePlugin(ws, "twin", { name: "twin" });
      const other = mkdtempSync(join(tmpdir(), "plugin-twin-"));
      try {
        mkdirSync(join(other, ".claude-plugin"), { recursive: true });
        writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "twin" }), "utf8");
        const plugins = load(ws, [other], (m) => warnings.push(m));
        expect(plugins.length).toBe(1);
        expect(plugins[0]?.dir).toBe(installed);
        expect(warnings.length).toBe(1);
        expect(warnings[0]).toContain("twin");
      } finally {
        rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      cleanup();
    }
  });

  it("unsupported assets (themes/, *.ts/js) are warned + skipped, never executed; agents/ translates (M40)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "kitchen-sink", { name: "kitchen-sink" });
      writeAsset(dir, "agents/reviewer.md", AGENT_MD("name: reviewer\ndescription: plugin reviewer"));
      writeAsset(dir, "themes/dark.json", "{}");
      writeAsset(dir, "helper.js", "console.log('never run')");
      writeAsset(dir, "extension.ts", "export {}; ");
      writeAsset(dir, ".claude-plugin/plugin.ts", "export {}; ");
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins.length).toBe(1);
      // agents/ is SUPPORTED now (M40): one translated agent, no agents warning.
      expect(plugins[0]!.agents.map((a) => a.profile.id)).toEqual(["reviewer"]);
      expect(warnings.some((w) => w.includes("agents/") && w.includes("not supported"))).toBe(false);
      expect(warnings.some((w) => w.includes("themes/"))).toBe(true);
      expect(warnings.some((w) => w.includes("helper.js"))).toBe(true);
      expect(warnings.some((w) => w.includes("extension.ts"))).toBe(true);
      expect(warnings.some((w) => w.includes("plugin.ts"))).toBe(true);
      // The warnings ride on the plugin itself too (plugin list shows them).
      expect((plugins[0]?.warnings.length ?? 0)).toBeGreaterThanOrEqual(4);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Skills mapping (fourth source feeding the same LoadedSkill list)
// ---------------------------------------------------------------------------

describe("plugin skills", () => {
  it("plugin skills are LoadedSkills tagged with the plugin name", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "skills/greet/SKILL.md", SKILL_MD);
      const [p] = load(ws);
      const skill = p?.skills[0];
      expect(skill?.name).toBe("greet");
      expect(skill?.description).toBe("Greet a user warmly");
      expect(skill?.plugin).toBe("p");
      expect(skill?.content).toBe(SKILL_MD);
      expect(skill?.filePath).toBe(join(dir, "skills", "greet", "SKILL.md"));
      expect(skill?.relPath).toBe(".wudao/plugins/p/skills/greet/SKILL.md");
    } finally {
      cleanup();
    }
  });

  it("appendPluginSkills: workspace skills win on name conflicts; plugin dups warn + skip", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      mkdirSync(join(ws, ".wudao", "skills", "greet"), { recursive: true });
      writeFileSync(join(ws, ".wudao", "skills", "greet", "SKILL.md"), "---\nname: greet\ndescription: workspace copy\n---\nbody", "utf8");
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "skills/greet/SKILL.md", SKILL_MD);
      writeAsset(dir, "skills/extra/SKILL.md", "---\nname: extra\ndescription: plugin only\n---\nbody");
      const base = loadSkills(ws);
      const merged = appendPluginSkills(base, load(ws), (m) => warnings.push(m));
      expect(merged.map((s) => s.name)).toEqual(["greet", "extra"]);
      expect(merged[0]?.description).toBe("workspace copy"); // workspace wins
      expect(merged[1]?.plugin).toBe("p");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("greet");
    } finally {
      cleanup();
    }
  });

  it("appendPluginSkills with no plugins → the list is returned unchanged", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const base = loadSkills(ws);
      expect(appendPluginSkills(base, [], (m) => { throw new Error(m); })).toBe(base);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

describe("plugin commands", () => {
  it("commands/*.md parse: stem = name, frontmatter description, body = template", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "commands/hello.md", COMMAND_MD);
      const [p] = load(ws);
      const cmd = p?.commands[0];
      expect(cmd?.name).toBe("hello");
      expect(cmd?.description).toBe("Say hello to someone");
      expect(cmd?.plugin).toBe("p");
      expect(cmd?.body).not.toContain("---");
      expect(cmd?.body).toContain("Say hello to $ARGUMENTS");
    } finally {
      cleanup();
    }
  });

  it("a command whose name collides with a builtin is warned + skipped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      // `skill:x.md` cannot exist on NTFS (a colon is the ADS separator —
      // the write lands as an alternate stream of a file named `skill`), so
      // the skill-prefix collision lane is posix-only; the six literal
      // builtin names cover the same warning path on win32.
      const colliding = process.platform === "win32"
        ? ["exit", "quit", "clear", "help", "resume", "skill"]
        : ["exit", "quit", "clear", "help", "resume", "skill", "skill:x"];
      for (const name of colliding) {
        writeAsset(dir, `commands/${name}.md`, COMMAND_MD);
      }
      writeAsset(dir, "commands/ok.md", COMMAND_MD);
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(p?.commands.map((c) => c.name)).toEqual(["ok"]);
      expect(warnings.length).toBe(colliding.length);
      for (const w of warnings) expect(w).toContain("builtin");
    } finally {
      cleanup();
    }
  });

  it("collectPluginCommands: cross-plugin dups warn + first plugin wins", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const a = writePlugin(ws, "a", { name: "aa" });
      const b = writePlugin(ws, "b", { name: "bb" });
      writeAsset(a, "commands/shared.md", COMMAND_MD);
      writeAsset(b, "commands/shared.md", COMMAND_MD);
      writeAsset(b, "commands/only-b.md", COMMAND_MD);
      const cmds = collectPluginCommands(load(ws), (m) => warnings.push(m));
      expect(cmds.map((c) => c.name)).toEqual(["shared", "only-b"]);
      expect(cmds[0]?.plugin).toBe("aa");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("shared");
    } finally {
      cleanup();
    }
  });
});

describe("expandCommandTemplate", () => {
  it("$ARGUMENTS expands to the whole trimmed arg string (inner spacing preserved)", () => {
    expect(expandCommandTemplate("run $ARGUMENTS now", " fix  the bug ")).toBe("run fix  the bug now");
  });
  it("$ARGUMENTS[N]/$N are 0-BASED positionals (the upstream format parity — the unified D2 expander); missing positions expand to empty", () => {
    expect(expandCommandTemplate("first=$0 second=$1 third=$2", "alpha beta")).toBe("first=alpha second=beta third=");
    expect(expandCommandTemplate("a=$ARGUMENTS[0] b=$ARGUMENTS[1]", "x y")).toBe("a=x b=y");
  });
  it("quoted multi-word args land as single positionals (the shared tokenizer)", () => {
    expect(expandCommandTemplate("hello $0 $1", "\"two words\" tail")).toBe("hello two words tail");
  });
  it("a body with no placeholders is returned unchanged (a lone $ stays)", () => {
    expect(expandCommandTemplate("just text and $5", "")).toBe("just text and ");
    expect(expandCommandTemplate("costs 5$ exactly", "x")).toBe("costs 5$ exactly");
  });
  it("\\$ escapes to a literal dollar (the unified expander's rule)", () => {
    expect(expandCommandTemplate("costs \\$5", "x")).toBe("costs $5");
  });
});

describe("buildPluginCommandMessage", () => {
  it("wraps the EXPANDED template in a named envelope (same pipeline as /skill:)", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "commands/hello.md", COMMAND_MD);
      const [p] = load(ws);
      const cmd = p?.commands[0];
      if (!cmd) throw new Error("command missing");
      expect(buildPluginCommandMessage(cmd, "Ada Lovelace")).toBe(
        `<plugin-command name="hello" args="Ada Lovelace">\nSay hello to Ada Lovelace (first token: Ada).\n</plugin-command>`,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// MCP merge (plugin .mcp.json / mcp.json → startup list, user precedence)
// ---------------------------------------------------------------------------

describe("plugin MCP config", () => {
  it("accepts the the upstream format mcpServers key and our servers key; .mcp.json wins over mcp.json", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, ".mcp.json", JSON.stringify({ mcpServers: { cc: { command: "node", args: ["cc.mjs"] } } }));
      writeAsset(dir, "mcp.json", JSON.stringify({ servers: { bare: { command: "echo" } } }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(Object.keys(p?.mcpServers ?? {})).toEqual(["cc"]);
      expect(p?.mcpServers["cc"]).toEqual({ command: "node", args: ["cc.mjs"] });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("mcp.json");
    } finally {
      cleanup();
    }
  });

  it("entries without a string command are warned + skipped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "mcp.json", JSON.stringify({ mcpServers: { bad: { args: ["x"] }, good: { command: "echo" } } }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(Object.keys(p?.mcpServers ?? {})).toEqual(["good"]);
      expect(warnings.some((w) => w.includes("bad"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("mergeMcpConfigs adds plugin servers; user config wins on name conflicts", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      mkdirSync(join(ws, ".wudao"), { recursive: true });
      writeFileSync(join(ws, ".wudao", "mcp.json"), JSON.stringify({ servers: { user: { command: "echo" }, shared: { command: "user-side" } } }), "utf8");
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "mcp.json", JSON.stringify({ mcpServers: { plug: { command: "echo" }, shared: { command: "plug-side" } } }));
      const merged = mergeMcpConfigs(loadMcpConfig(ws), load(ws), (m) => warnings.push(m));
      expect(Object.keys(merged.servers).sort()).toEqual(["plug", "shared", "user"]);
      expect(merged.servers["shared"]?.command).toBe("user-side");
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("shared");
      expect(warnings[0]).toContain("user");
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Hooks merge (hooks/hooks.json → our event names)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E1 — the the upstream formathook-event-name mapping, widened to the full 21-event canonical
// set (superpowers' SessionStart must compile onto our onSessionStart face).
// ---------------------------------------------------------------------------

/** The the upstream format→canonical vocabulary, pinned HERE as independent test data — not
 *  imported from the loader — so the matrix fails if either side drifts.
 *  (onTeammateIdle IS canonical since the M64 fleet merge but has NO the upstream format *  spelling — the loader excludes it from alias derivation, pinned in the
 *  matrix test below.) */
const CC_EVENT_NAMES: Readonly<Record<string, string>> = {
  UserPromptSubmit: "onPromptSubmit",
  Stop: "onRunStop",
  PreToolUse: "onPreToolUse",
  PostToolUse: "onPostToolUse",
  SessionStart: "onSessionStart",
  PreCompact: "onPreCompact",
  PostCompact: "onPostCompact",
  PermissionRequest: "onPermissionRequest",
  Notification: "onNotification",
  SubagentStart: "onSubagentStart",
  SubagentStop: "onSubagentStop",
  PostToolUseFailure: "onPostToolUseFailure",
  PostToolBatch: "onPostToolBatch",
  TaskCreated: "onTaskCreated",
  TaskCompleted: "onTaskCompleted",
  FileChanged: "onFileChanged",
  ConfigChange: "onConfigChange",
  InstructionsLoaded: "onInstructionsLoaded",
  SessionEnd: "onSessionEnd",
  StopFailure: "onStopFailure",
};

describe("plugin hooks", () => {
  it("HOOK_EVENT_MAP: every canonical key self-maps, every the upstream format name lands on its canonical, v1 aliases kept, no strays", () => {
    // canonical names are themselves accepted keys
    for (const event of CANONICAL_HOOK_EVENTS) {
      expect(HOOK_EVENT_MAP[event]).toBe(event);
    }
    // every the upstream formatspelling maps to its canonical face
    for (const [cc, canonical] of Object.entries(CC_EVENT_NAMES)) {
      expect(HOOK_EVENT_MAP[cc]).toBe(canonical);
    }
    // the two v1 short aliases still pass through
    expect(HOOK_EVENT_MAP["preToolUse"]).toBe("onPreToolUse");
    expect(HOOK_EVENT_MAP["postToolUse"]).toBe("onPostToolUse");
    // exactly the three families — no stray aliases
    const expectedKeys = [...new Set([...CANONICAL_HOOK_EVENTS, "preToolUse", "postToolUse", ...Object.keys(CC_EVENT_NAMES)])];
    expect(Object.keys(HOOK_EVENT_MAP).sort()).toEqual(expectedKeys.sort());
    // the wudao-specific canonical face grows no bogus "minus-on" the upstream formatalias
    expect("TeammateIdle" in HOOK_EVENT_MAP).toBe(false);
    expect(HOOK_EVENT_MAP["onTeammateIdle"]).toBe("onTeammateIdle");
  });

  it("round-trip: every the upstream format event name compiles onto its canonical face (the full event surface)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      const map: Record<string, unknown> = {};
      for (const [cc, canonical] of Object.entries(CC_EVENT_NAMES)) {
        map[cc] = [{ hooks: [{ type: "command", command: `cc-${canonical}` }] }];
      }
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({ hooks: map }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      for (const canonical of CANONICAL_HOOK_EVENTS) {
        // onTeammateIdle has no the upstream formatspelling (loader exclusion) — nothing was
        // written for it, so it stays undefined; every other face is covered.
        if (canonical === "onTeammateIdle") {
          expect(p?.hooks[canonical]).toBeUndefined();
          continue;
        }
        expect(p?.hooks[canonical]).toEqual([{ command: `cc-${canonical}`, pluginRoot: dir }]);
      }
    } finally {
      cleanup();
    }
  });

  it("round-trip: canonical names + the two v1 aliases pass through onto the same faces", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      const map: Record<string, unknown> = {};
      for (const canonical of CANONICAL_HOOK_EVENTS) {
        map[canonical] = [{ hooks: [{ type: "command", command: `can-${canonical}` }] }];
      }
      map["preToolUse"] = [{ hooks: [{ type: "command", command: "alias-preToolUse" }] }];
      map["postToolUse"] = [{ hooks: [{ type: "command", command: "alias-postToolUse" }] }];
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({ hooks: map }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      for (const canonical of CANONICAL_HOOK_EVENTS) {
        expect(p?.hooks[canonical]).toBeDefined();
      }
      // canonical key first (JSON insertion order), the alias appends behind it
      expect(p?.hooks.onPreToolUse?.map((h) => h.command)).toEqual(["can-onPreToolUse", "alias-preToolUse"]);
      expect(p?.hooks.onPostToolUse?.map((h) => h.command)).toEqual(["can-onPostToolUse", "alias-postToolUse"]);
    } finally {
      cleanup();
    }
  });

  it("superpowers shape: SessionStart group with matcher \"startup|resume\" compiles with the matcher preserved (same vocabulary our native onSessionStart matchers speak)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "superpowers", { name: "superpowers" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({
        hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "echo hi" }] }] },
      }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      expect(p?.hooks.onSessionStart).toEqual([{ command: "echo hi", matcher: "startup|resume", pluginRoot: dir }]);
    } finally {
      cleanup();
    }
  });

  // cc-plugins E4: every plugin hook entry carries pluginRoot (the install
  // dir) — the upstream's ${CLAUDE_PLUGIN_ROOT} convention depends on it at fire time.
  it("pluginRoot stamped: flat and group-nested entries both carry the plugin's install dir", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({
        hooks: {
          SessionStart: [{ hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start' }] }],
          UserPromptSubmit: [{ type: "command", command: "flat-cmd" }],
        },
      }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      expect(p?.hooks.onSessionStart?.map((h) => h.pluginRoot)).toEqual([dir]);
      expect(p?.hooks.onPromptSubmit?.map((h) => h.pluginRoot)).toEqual([dir]);
    } finally {
      cleanup();
    }
  });

  it("an unknown event name warns (pointing at the canonical names) + is skipped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({
        hooks: {
          TotallyMadeUp: [{ hooks: [{ type: "command", command: "never" }] }],
          SessionStart: [{ hooks: [{ type: "command", command: "kept" }] }],
        },
      }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(p?.hooks.onSessionStart).toEqual([{ command: "kept", pluginRoot: dir }]);
      expect(p?.hooks.onSessionEnd).toBeUndefined(); // the unknown event contributed nothing anywhere
      const warnText = warnings.find((w) => w.includes("TotallyMadeUp")) ?? "";
      expect(warnText).toContain("unknown hook event"); // ω99-207 census 复核：发射点在 plugins.ts（面表外，本弧零触），钉不演进
      // points at the FULL canonical set, not the stale 4-name list
      expect(warnText).toContain("onSessionStart");
      expect(warnText).toContain("onStopFailure");
    } finally {
      cleanup();
    }
  });

  it("group matcher passthrough leaves no-matcher entries untouched (no matcher key appears)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({
        hooks: {
          SessionStart: [
            { hooks: [{ type: "command", command: "bare-group" }] },
            { matcher: "startup", hooks: [{ type: "command", command: "matched" }] },
          ],
          UserPromptSubmit: [{ command: "flat-native", timeoutMs: 1500 }],
        },
      }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(warnings).toEqual([]);
      // bare group + our flat entry carry NO matcher; only the matcher group does
      expect(p?.hooks.onSessionStart).toEqual([{ command: "bare-group", pluginRoot: dir }, { command: "matched", matcher: "startup", pluginRoot: dir }]);
      expect(p?.hooks.onPromptSubmit).toEqual([{ command: "flat-native", timeoutMs: 1500, pluginRoot: dir }]);
    } finally {
      cleanup();
    }
  });

  it("our native event names and flat {command} entries pass through; non-command hook types warn + skip", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({
        hooks: {
          onPromptSubmit: [{ command: "native", timeoutMs: 2500 }],
          onPreToolUse: [{ hooks: [{ type: "http", url: "http://x" }, { type: "command", command: "kept" }] }],
        },
      }));
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(p?.hooks.onPromptSubmit).toEqual([{ command: "native", timeoutMs: 2500, pluginRoot: dir }]);
      expect(p?.hooks.onPreToolUse).toEqual([{ command: "kept", pluginRoot: dir }]);
      expect(warnings.some((w) => w.includes("http"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("mergeHooksSettings appends plugin commands AFTER the user's per event", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "plug-hook" }] }] } }));
      const merged = mergeHooksSettings({ onPromptSubmit: [{ command: "user-hook" }], onRunStop: [{ command: "user-stop" }] }, load(ws));
      expect(merged.onPromptSubmit?.map((h) => h.command)).toEqual(["user-hook", "plug-hook"]);
      expect(merged.onRunStop?.map((h) => h.command)).toEqual(["user-stop"]);
      expect(merged.onPreToolUse).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("a malformed hooks.json warns + contributes nothing (never throws)", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "p", { name: "p" });
      writeAsset(dir, "hooks/hooks.json", "{ nope");
      const [p] = load(ws, [], (m) => warnings.push(m));
      expect(p?.hooks).toEqual({});
      expect(warnings.some((w) => w.includes("hooks.json"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// `wudao plugin list`
// ---------------------------------------------------------------------------

describe("formatPluginList / pluginMain", () => {
  it("no plugins → friendly empty line, exit 0", async () => {
    const { ws, cleanup } = tmpWs();
    const out: string[] = [];
    try {
      expect(await pluginMain(["list"], { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s) })).toBe(0);
      expect(out.join("")).toContain("no plugins");
    } finally {
      cleanup();
    }
  });

  it("lists name / version / asset counts / warnings", async () => {
    const { ws, cleanup } = tmpWs();
    const out: string[] = [];
    try {
      const dir = writePlugin(ws, "fixture", { name: "fixture", version: "1.2.3", description: "d" });
      writeAsset(dir, "skills/greet/SKILL.md", SKILL_MD);
      writeAsset(dir, "commands/hello.md", COMMAND_MD);
      writeAsset(dir, "mcp.json", JSON.stringify({ mcpServers: { srv: { command: "echo" } } }));
      writeAsset(dir, "agents/reviewer.md", AGENT_MD("name: reviewer\ndescription: plugin reviewer"));
      expect(await pluginMain(["list"], { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s) })).toBe(0);
      const text = out.join("");
      expect(text).toContain("fixture");
      expect(text).toContain("1.2.3");
      expect(text).toContain("agents"); // M40: the agents asset column
      // and the pure formatter agrees
      const plugins = load(ws);
      expect(formatPluginList(plugins)).toContain("fixture");
      expect(formatPluginList(plugins)).toContain("1.2.3");
    } finally {
      cleanup();
    }
  });

  it("unknown subcommand / missing subcommand → usage, exit 2", async () => {
    const { ws, cleanup } = tmpWs();
    const out: string[] = [];
    try {
      expect(await pluginMain(["frobnicate"], { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s) })).toBe(2);
      expect(out.join("")).toContain("用法"); // ω99-166e-ii: 钉演进（plugins 用法头中文化）
      out.length = 0;
      expect(await pluginMain([], { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s) })).toBe(2);
      expect(out.join("")).toContain("用法"); // ω99-166e-ii: 钉演进（plugins 用法头中文化）
    } finally {
      cleanup();
    }
  });

  it("list ignores extra arguments (usage error)", async () => {
    const { ws, cleanup } = tmpWs();
    const out: string[] = [];
    try {
      expect(await pluginMain(["list", "extra"], { cwd: ws, env: ISOLATED_ENV, out: (s) => out.push(s) })).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("the fixture leaves nothing behind: listing is read-only", async () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "fixture", { name: "fixture" });
      await pluginMain(["list"], { cwd: ws, env: ISOLATED_ENV, out: () => {} });
      expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// M40 §2 — the upstream formatplugin agents/*.md translation. Frontmatter name/description/
// tools?/model? + body → AgentRoleProfile; tools map through the the upstream formatalias
// table (unknown names warn + drop); model pins only for known providers;
// unsupported frontmatter fields warn. Roster precedence: builtin < plugin <
// workspace (pinned in core's roster tests + the task-tool threading test).
// ---------------------------------------------------------------------------

describe("parseAgentFrontmatter", () => {
  it("reads name/description/tools/model and splits the body", () => {
    const fm = parseAgentFrontmatter(
      AGENT_MD('name: reviewer\ndescription: "Reviews diffs adversarially"\ntools: Read, Grep\ntoDaY: lunch', "PROMPT-BODY"),
    );
    expect(fm.name).toBe("reviewer");
    expect(fm.description).toBe("Reviews diffs adversarially");
    expect(fm.tools).toBe("Read, Grep");
    expect(fm.model).toBeUndefined();
    expect(fm.body).toBe("PROMPT-BODY");
    expect(fm.unknownFields).toEqual(["toDaY"]);
  });

  it("no frontmatter → whole text is the body, no fields", () => {
    const fm = parseAgentFrontmatter("Just a prompt body.\n");
    expect(fm.name).toBeUndefined();
    expect(fm.description).toBe("");
    expect(fm.body).toBe("Just a prompt body.\n");
    expect(fm.unknownFields).toEqual([]);
  });
});

describe("plugin agents translation", () => {
  it("agents/*.md become AgentRoleProfiles: id=name, systemPrompt=body, tools mapped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "demo", { name: "demo", version: "1.0.0" });
      writeAsset(
        dir,
        "agents/code-reviewer.md",
        AGENT_MD(
          "name: code-reviewer\ndescription: Reviews code changes line by line\ntools: Read, Grep, read_file",
          "You are a meticulous code reviewer.\nCite file paths.\n",
        ),
      );
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins.length).toBe(1);
      const agents = plugins[0]!.agents;
      expect(agents.length).toBe(1);
      const a = agents[0]!;
      expect(a.plugin).toBe("demo");
      expect(a.filePath).toBe(join(dir, "agents", "code-reviewer.md"));
      expect(a.profile.id).toBe("code-reviewer");
      expect(a.profile.description).toBe("Reviews code changes line by line");
      expect(a.profile.systemPrompt).toBe("You are a meticulous code reviewer.\nCite file paths.\n");
      // the upstream formataliases translate; native names pass through.
      expect(a.profile.toolNames).toEqual(["read_file", "grep", "read_file"]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("unknown tool names warn and are dropped", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "demo", { name: "demo" });
      writeAsset(
        dir,
        "agents/odd.md",
        AGENT_MD("name: odd\ndescription: odd tools\ntools: Bash, FusionReactor, grep"),
      );
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins[0]!.agents[0]!.profile.toolNames).toEqual(["shell", "grep"]);
      expect(warnings.some((w) => w.includes("FusionReactor") && w.includes("is unknown"))).toBe(true);
      // The warning names the agent file — separator as the platform spells it.
      expect(warnings.some((w) => w.includes("FusionReactor") && w.includes(join("agents", "odd.md")))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("model pins only for known providers: exact name → provider pin; prefixed → provider+model; else warn+ignore", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "demo", { name: "demo" });
      writeAsset(dir, "agents/pinned.md", AGENT_MD("name: pinned\ndescription: pinned model\ntools: grep\nmodel: glm-4.6"));
      writeAsset(dir, "agents/bare.md", AGENT_MD("name: bare\ndescription: bare provider\nmodel: deepseek"));
      writeAsset(dir, "agents/alien.md", AGENT_MD("name: alien\ndescription: unknown vendor\nmodel: sonnet"));
      const plugins = load(ws, [], (m) => warnings.push(m));
      const by = (id: string) => plugins[0]!.agents.find((a) => a.profile.id === id)!.profile;
      expect(by("pinned").provider).toBe("glm");
      expect(by("pinned").model).toBe("glm-4.6");
      expect(by("bare").provider).toBe("deepseek");
      expect(by("bare").model).toBeUndefined();
      expect(by("alien").provider).toBeUndefined();
      expect(by("alien").model).toBeUndefined();
      expect(warnings.some((w) => w.includes("sonnet") && w.includes("known provider"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("unsupported frontmatter fields are warned and listed", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "demo", { name: "demo" });
      writeAsset(
        dir,
        "agents/chatty.md",
        AGENT_MD("name: chatty\ndescription: extra fields\nwhenToUse: always\ncolor: purple"),
      );
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins[0]!.agents.length).toBe(1);
      const unsupported = warnings.filter((w) => w.includes("unsupported frontmatter"));
      expect(unsupported.length).toBe(1);
      expect(unsupported[0]).toContain("whenToUse");
      expect(unsupported[0]).toContain("color");
    } finally {
      cleanup();
    }
  });

  it("missing name or description skips the agent with a warning; duplicate ids first-win", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const dir = writePlugin(ws, "demo", { name: "demo" });
      writeAsset(dir, "agents/no-name.md", AGENT_MD("description: anonymous"));
      writeAsset(dir, "agents/no-desc.md", AGENT_MD("name: no-desc"));
      writeAsset(dir, "agents/dup.md", AGENT_MD("name: dup\ndescription: first"));
      writeAsset(dir, "agents/dup2.md", AGENT_MD("name: dup\ndescription: second"));
      const plugins = load(ws, [], (m) => warnings.push(m));
      expect(plugins[0]!.agents.map((a) => a.profile.id)).toEqual(["dup"]);
      expect(plugins[0]!.agents[0]!.profile.description).toBe("first");
      expect(warnings.some((w) => w.includes("no-name") && w.includes("name"))).toBe(true);
      expect(warnings.some((w) => w.includes("no-desc") && w.includes("description"))).toBe(true);
      expect(warnings.some((w) => w.includes("dup") && w.includes("already"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("agents/ is no longer an unsupported asset; plugin list counts agents", () => {
    const { ws, cleanup } = tmpWs();
    try {
      const dir = writePlugin(ws, "demo", { name: "demo", version: "2.0.0" });
      writeAsset(dir, "agents/one.md", AGENT_MD("name: one\ndescription: first"));
      writeAsset(dir, "agents/two.md", AGENT_MD("name: two\ndescription: second"));
      const plugins = load(ws, []);
      const listing = formatPluginList(plugins);
      const lines = listing.split("\n");
      const header = lines[0]!;
      const row = lines.find((l) => l.startsWith("demo"))!;
      // Column parse: the cell under the "agents" header is the count 2.
      const agentsCol = header.split(/\s+/).indexOf("agents");
      expect(agentsCol).toBeGreaterThan(0);
      expect(row.split(/\s+/)[agentsCol]).toBe("2");
      expect(plugins[0]!.agents.length).toBe(2);
    } finally {
      cleanup();
    }
  });
});

describe("collectPluginAgents (roster layer)", () => {
  it("collects {profile, source} roster entries; cross-plugin id conflicts first-win with a warning", () => {
    const { ws, cleanup } = tmpWs();
    const warnings: string[] = [];
    try {
      const a = writePlugin(ws, "alpha", { name: "alpha" });
      const b = writePlugin(ws, "beta", { name: "beta" });
      writeAsset(a, "agents/reviewer.md", AGENT_MD("name: reviewer\ndescription: alpha reviewer"));
      writeAsset(a, "agents/only-alpha.md", AGENT_MD("name: only-alpha\ndescription: alpha exclusive"));
      writeAsset(b, "agents/reviewer.md", AGENT_MD("name: reviewer\ndescription: beta reviewer"));
      const plugins = load(ws, [], (m) => warnings.push(m));
      const layer = collectPluginAgents(plugins, (m) => warnings.push(m));
      expect(layer.map((e) => e.profile.id).sort()).toEqual(["only-alpha", "reviewer"]);
      expect(layer.find((e) => e.profile.id === "reviewer")!.profile.description).toBe("alpha reviewer");
      expect(layer.find((e) => e.profile.id === "reviewer")!.source).toContain("alpha");
      expect(warnings.some((w) => w.includes("reviewer") && w.includes("beta"))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("no agents → empty layer (zero roster change)", () => {
    expect(collectPluginAgents([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// A2 — user-scope root + the enabledPlugins filter. Fixtures hand-write the
// install registry (`<globalHome>/plugins/installed.json`) and the global
// settings' enabledPlugins map; the install engine itself is pinned in
// marketplace.test.ts.
// ---------------------------------------------------------------------------

/** A per-test isolated home (a fresh one each time — several tests below
 *  WRITE settings.json / installed.json into it). */
function freshHome(): { home: string; env: NodeJS.ProcessEnv; deps: PluginLoadDeps; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "plugins-home-"));
  const env: NodeJS.ProcessEnv = { ...process.env, WUDAO_GLOBAL_HOME: home };
  return { home, env, deps: { env }, cleanup: () => rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function writeUserPlugin(home: string, dir: string, manifest: Record<string, unknown>): string {
  const pluginDir = join(home, "plugins", dir);
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  return pluginDir;
}

function writeInstalledRegistry(home: string, records: readonly unknown[]): string {
  const p = join(home, "plugins", "installed.json");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(records, null, 2), "utf8");
  return p;
}

describe("A2: user-scope root + enabledPlugins filter", () => {
  it("discovers <globalHome>/plugins/* AFTER .wudao/plugins; duplicate name → project wins with a warning", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    const warnings: string[] = [];
    try {
      const projectDir = writePlugin(ws, "twin", { name: "twin", version: "9.9.9" });
      writeUserPlugin(home, "twin", { name: "twin", version: "0.0.1" });
      writeUserPlugin(home, "useronly", { name: "useronly" });
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), deps);
      // project root first, user root second — the project twin wins
      expect(plugins.map((p) => p.name).sort()).toEqual(["twin", "useronly"]);
      expect(plugins.find((p) => p.name === "twin")?.dir).toBe(projectDir);
      expect(warnings.some((w) => w.includes("twin"))).toBe(true);
      expect(warnings.some((w) => w.includes("useronly"))).toBe(false);
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("installed.json (a plain file) in the user root is never treated as a plugin", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    const warnings: string[] = [];
    try {
      writeUserPlugin(home, "real", { name: "real" });
      writeInstalledRegistry(home, [{ name: "real", market: "m", scope: "user" }]);
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), deps);
      expect(plugins.map((p) => p.name)).toEqual(["real"]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("enabledPlugins[<name>@<market>] === false skips the plugin (user root)", () => {
    const { ws, cleanup } = tmpWs();
    const { home, env, deps, cleanup: cleanupHome } = freshHome();
    const warnings: string[] = [];
    try {
      writeUserPlugin(home, "off", { name: "off" });
      writeUserPlugin(home, "on", { name: "on" });
      writeInstalledRegistry(home, [
        { name: "off", market: "m1", scope: "user" },
        { name: "on", market: "m2", scope: "user" },
      ]);
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "off@m1": false, "on@m2": true } }), "utf8");
      expect(env["WUDAO_GLOBAL_HOME"]).toBeDefined();
      const plugins = loadPlugins(ws, [], (m) => warnings.push(m), deps);
      expect(plugins.map((p) => p.name)).toEqual(["on"]); // silently gone — the disable IS the intent
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("the filter matches project records by their root workspace — another workspace's disable never leaks", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    try {
      writePlugin(ws, "shared", { name: "shared" });
      writeInstalledRegistry(home, [
        { name: "shared", market: "m", scope: "project", root: "/definitely/another/workspace" },
      ]);
      writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "shared@m": false } }), "utf8");
      const plugins = loadPlugins(ws, [], () => {}, deps);
      expect(plugins.map((p) => p.name)).toEqual(["shared"]); // record is for ANOTHER workspace — not filtered here
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("a project record for THIS workspace disables the project-root plugin; --plugin mounts are never filtered", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    try {
      writePlugin(ws, "proj", { name: "proj" });
      const outside = mkdtempSync(join(tmpdir(), "plugin-adhoc-"));
      try {
        mkdirSync(join(outside, ".claude-plugin"), { recursive: true });
        writeFileSync(join(outside, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "adhoc" }), "utf8");
        writeInstalledRegistry(home, [{ name: "proj", market: "m", scope: "project", root: ws }]);
        writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "proj@m": false } }), "utf8");
        const plugins = loadPlugins(ws, [outside], () => {}, deps);
        expect(plugins.map((p) => p.name)).toEqual(["adhoc"]); // disabled project plugin skipped; the flag mount rides through
        expect(plugins[0]?.source).toBe("flag");
      } finally {
        rmSync(outside, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("a hand-placed dir with no registry record is never filtered; a corrupt installed.json warns once and filters nothing", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    const warnings: string[] = [];
    try {
      writeUserPlugin(home, "handmade", { name: "handmade" });
      writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: { "handmade@anywhere": false } }), "utf8");
      expect(loadPlugins(ws, [], (m) => warnings.push(m), deps).map((p) => p.name)).toEqual(["handmade"]);
      expect(warnings).toEqual([]);

      writeInstalledRegistry(home, "corrupt" as unknown as readonly unknown[]);
      writeFileSync(join(home, "plugins", "installed.json"), "{ broken", "utf8");
      const registryPath = join(home, "plugins", "installed.json");
      expect(readFileSync(registryPath, "utf8")).toBe("{ broken");
      const again = loadPlugins(ws, [], (m) => warnings.push(m), deps);
      expect(again.map((p) => p.name)).toEqual(["handmade"]); // discovery must not die on a corrupt registry
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("installed.json");
    } finally {
      cleanup();
      cleanupHome();
    }
  });

  it("a malformed settings.json or non-record enabledPlugins → no filtering, no crash", () => {
    const { ws, cleanup } = tmpWs();
    const { home, deps, cleanup: cleanupHome } = freshHome();
    const warnings: string[] = [];
    try {
      writeUserPlugin(home, "stillhere", { name: "stillhere" });
      writeInstalledRegistry(home, [{ name: "stillhere", market: "m", scope: "user" }]);
      writeFileSync(join(home, "settings.json"), JSON.stringify({ enabledPlugins: ["not", "a", "map"] }), "utf8");
      expect(loadPlugins(ws, [], (m) => warnings.push(m), deps).map((p) => p.name)).toEqual(["stillhere"]);
      writeFileSync(join(home, "settings.json"), "{ broken", "utf8");
      expect(loadPlugins(ws, [], (m) => warnings.push(m), deps).map((p) => p.name)).toEqual(["stillhere"]);
      expect(warnings).toEqual([]);
    } finally {
      cleanup();
      cleanupHome();
    }
  });
});
