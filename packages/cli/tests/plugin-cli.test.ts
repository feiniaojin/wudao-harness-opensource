// cc-plugins B1 — the /plugin slash face and `wudao plugin` CLI over the A1/A2
// marketplace engine. One grammar, two frontends: pluginMain (exit codes +
// text or --json) and runPluginSlashCommand (Chinese notices, the busy guard,
// the post-install rescan). Fixtures are LOCAL market directories (the copier
// path — no git, no network); every op runs against an isolated global home.
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginMain, runPluginSlashCommand, tokenizeArgs } from "../src/commands/plugins-command.js";
import { isBuiltinCommandName } from "../src/plugins.js";
import { parseReplCommand } from "../src/repl.js";
import { listSlashCommands } from "../src/slash-commands.js";
import { buildTool, createScriptedModel } from "@wudao/core";
import { createAgentDriver } from "../src/driver/agent-driver.js";
import { summarizeToolCall } from "../src/log.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function tmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

function homeEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, WUDAO_GLOBAL_HOME: home };
}

/** A no-op rescan seam that RECORDS its calls (the spy the brief asks for —
 * the real rescanExtensions reads the process's real global home, which a
 * test must never do). */
function rescanRecorder(): { rescan: () => Promise<{ skills: number; plugins: number; hooks: number }>; count: () => number } {
  let calls = 0;
  return {
    rescan: async () => {
      calls += 1;
      return { skills: 7, plugins: 3, hooks: 2 };
    },
    count: () => calls,
  };
}

const SKILL_MD = "---\nname: greet\ndescription: Greet a user warmly\n---\n\n# Greet\n\nAlways say hello.\n";
const COMMAND_MD = "---\ndescription: Say hello to someone\n---\n\nSay hello to $ARGUMENTS (first token: $0).";

function writePlugin(dir: string, manifest: Record<string, unknown>): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

/** A local-dir market fixture: `alpha` carries every asset class (skills 1 ·
 * commands 1 · hooks 1 · MCP 1 — the install notice's numbers and its
 * MCP-restart line), `beta` is a bare manifest (no MCP → no restart line). */
function makeLocalMarket(dir: string, name = "m"): string {
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name,
      description: `the ${name} market`,
      plugins: [
        { name: "alpha", source: "./plugins/alpha", description: "full fixture", version: "1.0.0" },
        { name: "beta", source: "./plugins/beta" },
      ],
    }),
    "utf8",
  );
  const alpha = join(dir, "plugins", "alpha");
  writePlugin(alpha, { name: "alpha", version: "1.0.0", description: "full fixture" });
  mkdirSync(join(alpha, "skills", "greet"), { recursive: true });
  writeFileSync(join(alpha, "skills", "greet", "SKILL.md"), SKILL_MD, "utf8");
  mkdirSync(join(alpha, "commands"), { recursive: true });
  writeFileSync(join(alpha, "commands", "hello.md"), COMMAND_MD, "utf8");
  writeFileSync(join(alpha, ".mcp.json"), JSON.stringify({ mcpServers: { "alpha-srv": { command: "echo" } } }), "utf8");
  mkdirSync(join(alpha, "hooks"), { recursive: true });
  writeFileSync(join(alpha, "hooks", "hooks.json"), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo hook" }] }] } }), "utf8");
  writePlugin(join(dir, "plugins", "beta"), { name: "beta" });
  return dir;
}

/** Isolated home + workspace + the added market — the standard B1 test bed. */
function bed(): {
  home: string;
  ws: string;
  env: NodeJS.ProcessEnv;
  market: string;
  cleanup: () => void;
} {
  const home = mkdtempSync(join(tmpdir(), "plugin-cli-home-"));
  const ws = mkdtempSync(join(tmpdir(), "plugin-cli-ws-"));
  const market = makeLocalMarket(mkdtempSync(join(tmpdir(), "plugin-cli-market-")));
  const env = homeEnv(home);
  const cleanup = (): void => {
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    rmSync(market, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  return { home, ws, env, market, cleanup };
}

/** pluginMain with the isolated env + an out collector + the rescan spy. */
function cli(b: { env: NodeJS.ProcessEnv; ws: string }, argv: readonly string[], rescan?: () => Promise<{ skills: number; plugins: number; hooks: number }>): Promise<{ code: number; text: string; json: () => unknown }> {
  const out: string[] = [];
  const p = pluginMain(argv, { cwd: b.ws, env: b.env, out: (s) => out.push(s), ...(rescan !== undefined ? { rescan } : {}) });
  return p.then((code) => ({
    code,
    text: out.join(""),
    json: () => JSON.parse(out.join("")),
  }));
}

/** The slash face over the same bed. */
function slash(
  b: { env: NodeJS.ProcessEnv; ws: string },
  args: string,
  opts: { busy?: boolean; rescan?: () => Promise<{ skills: number; plugins: number; hooks: number }> } = {},
): Promise<string> {
  return runPluginSlashCommand({ args, cwd: b.ws, env: b.env, ...(opts.busy !== undefined ? { busy: opts.busy } : {}), ...(opts.rescan !== undefined ? { rescan: opts.rescan } : {}) });
}

/** Installed-registry rows (the engine's own reader — the independent eye). */
function installedRows(b: { env: NodeJS.ProcessEnv }): unknown[] {
  const path = join(b.env["WUDAO_GLOBAL_HOME"] as string, "plugins", "installed.json");
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")) as unknown[];
}

// ---------------------------------------------------------------------------
// CLI — usage
// ---------------------------------------------------------------------------

describe("wudao plugin — usage", () => {
  it("bare / no subcommand → usage, exit 2", async () => {
    const b = bed();
    try {
      const r = await cli(b, []);
      expect(r.code).toBe(2);
      expect(r.text).toContain("用法"); // ω99-166e-ii: 钉演进（回执头词中文化，brief 二之"plugins 头无钉"实有此泛子串钉）
    } finally {
      b.cleanup();
    }
  });

  it("unknown subcommand → usage naming it, exit 2", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["frobnicate"]);
      expect(r.code).toBe(2);
      expect(r.text).toContain("用法"); // ω99-166e-ii: 钉演进（回执头词中文化，brief 二之"plugins 头无钉"实有此泛子串钉）
      expect(r.text).toContain("frobnicate");
    } finally {
      b.cleanup();
    }
  });

  it("list with extra positional → usage, exit 2", async () => {
    const b = bed();
    try {
      expect((await cli(b, ["list", "extra"])).code).toBe(2);
    } finally {
      b.cleanup();
    }
  });

  it("install without <name>@<market> → usage, exit 2", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["install", "alpha"]);
      expect(r.code).toBe(2);
      expect(r.text).toContain("<name>@<market>");
    } finally {
      b.cleanup();
    }
  });

  it("install with a bad --scope → usage, exit 2", async () => {
    const b = bed();
    try {
      expect((await cli(b, ["install", "alpha@m", "--scope", "bogus"])).code).toBe(2);
    } finally {
      b.cleanup();
    }
  });

  it("unknown flag → usage naming it, exit 2; --help prints usage with exit 0", async () => {
    const b = bed();
    try {
      const bad = await cli(b, ["list", "--wat"]);
      expect(bad.code).toBe(2);
      expect(bad.text).toContain("--wat");
      const help = await cli(b, ["--help"]);
      expect(help.code).toBe(0);
      expect(help.text).toContain("用法"); // ω99-166e-ii: 钉演进（回执头词中文化，brief 二之"plugins 头无钉"实有此泛子串钉）
    } finally {
      b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI — marketplace add / list / update / remove
// ---------------------------------------------------------------------------

describe("wudao plugin marketplace — add / list / update / remove", () => {
  it("add <local dir> → exit 0, 中文 notice, registry materialized", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["marketplace", "add", b.market]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("市场已添加");
      expect(r.text).toContain("m");
      expect(r.text).toContain("2 个插件可安装");
      const registry = JSON.parse(readFileSync(join(b.home, "marketplaces.json"), "utf8")) as { name: string }[];
      expect(registry.map((e) => e.name)).toEqual(["m"]);
    } finally {
      b.cleanup();
    }
  });

  it("add --json → the MarketplaceInfo + plugin counts as one JSON object", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["marketplace", "add", b.market, "--json"]);
      expect(r.code).toBe(0);
      const payload = r.json() as { market: { name: string; addedAt: string }; plugins: number };
      expect(payload.market.name).toBe("m");
      expect(typeof payload.market.addedAt).toBe("string");
      expect(payload.plugins).toBe(2);
    } finally {
      b.cleanup();
    }
  });

  it("add with an unparseable source → exit 1, ⚠️ text", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["marketplace", "add", join(b.ws, "no-such-dir")]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("⚠️");
    } finally {
      b.cleanup();
    }
  });

  it("add without a source → usage, exit 2", async () => {
    const b = bed();
    try {
      expect((await cli(b, ["marketplace", "add"])).code).toBe(2);
    } finally {
      b.cleanup();
    }
  });

  it("list shows the added market; --json carries the array", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const r = await cli(b, ["marketplace", "list"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("m");
      expect(r.text).toContain("the m market");
      const j = await cli(b, ["marketplace", "list", "--json"]);
      const payload = j.json() as { marketplaces: { name: string; source: string }[] };
      expect(payload.marketplaces.map((e) => e.name)).toEqual(["m"]);
      expect(payload.marketplaces[0]?.source).toBe(b.market);
    } finally {
      b.cleanup();
    }
  });

  it("bare list with no markets → friendly empty line, exit 0", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["marketplace", "list"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("无已注册市场");
    } finally {
      b.cleanup();
    }
  });

  it("update <name> refreshes; bare update does every market; unknown → exit 1", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const one = await cli(b, ["marketplace", "update", "m"]);
      expect(one.code).toBe(0);
      expect(one.text).toContain("市场已更新");
      expect(one.text).toContain("m");
      const all = await cli(b, ["marketplace", "update"]);
      expect(all.code).toBe(0);
      expect(all.text).toContain("m");
      const none = await cli(b, ["marketplace", "update", "nope"]);
      expect(none.code).toBe(1);
      expect(none.text).toContain("⚠️");
    } finally {
      b.cleanup();
    }
  });

  it("remove unregisters (no installed plugins → no cascade)", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const r = await cli(b, ["marketplace", "remove", "m"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("市场已移除");
      const registry = JSON.parse(readFileSync(join(b.home, "marketplaces.json"), "utf8")) as unknown[];
      expect(registry).toEqual([]);
    } finally {
      b.cleanup();
    }
  });

  it("add never rescans (config-only op)", async () => {
    const b = bed();
    try {
      const rec = rescanRecorder();
      await cli(b, ["marketplace", "add", b.market], rec.rescan);
      expect(rec.count()).toBe(0);
    } finally {
      b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI — install / uninstall / enable / disable
// ---------------------------------------------------------------------------

describe("wudao plugin — install / uninstall / enable / disable", () => {
  it("install <name>@<market> (default user) → dir + registry + 中文 notice with counts + rescan", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const rec = rescanRecorder();
      const r = await cli(b, ["install", "alpha@m"], rec.rescan);
      expect(r.code).toBe(0);
      expect(existsSync(join(b.home, "plugins", "alpha", ".claude-plugin", "plugin.json"))).toBe(true);
      expect(installedRows(b)).toEqual([
        expect.objectContaining({ name: "alpha", market: "m", scope: "user", version: "1.0.0" }),
      ]);
      expect(r.text).toContain("已安装 alpha@m");
      expect(r.text).toContain("user 作用域");
      expect(r.text).toContain("技能 1");
      expect(r.text).toContain("命令 1");
      expect(r.text).toContain("MCP 1");
      expect(rec.count()).toBe(1);
    } finally {
      b.cleanup();
    }
  });

  it("the install notice carries A3's deferred copy: MCP servers apply after restart (only when the plugin declares some)", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const alpha = await cli(b, ["install", "alpha@m"]);
      expect(alpha.text).toContain("重启");
      expect(alpha.text).toContain("MCP");
      const beta = await cli(b, ["install", "beta@m"]);
      expect(beta.code).toBe(0);
      expect(beta.text).not.toContain("重启");
    } finally {
      b.cleanup();
    }
  });

  it("install --scope project → the workspace root, root recorded", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const r = await cli(b, ["install", "alpha@m", "--scope", "project"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("project 作用域");
      expect(existsSync(join(b.ws, ".wudao", "plugins", "alpha", ".claude-plugin", "plugin.json"))).toBe(true);
      expect(installedRows(b)).toEqual([
        expect.objectContaining({ name: "alpha", market: "m", scope: "project", root: realpathSync(b.ws) }),
      ]);
    } finally {
      b.cleanup();
    }
  });

  it("install --json → {id, scope, dir, detail, rescan}", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      const rec = rescanRecorder();
      const r = await cli(b, ["install", "alpha@m", "--json"], rec.rescan);
      expect(r.code).toBe(0);
      const payload = r.json() as {
        id: string;
        scope: string;
        dir: string;
        detail: { skills: number; commands: number; agents: number; hooks: number; mcp: number };
        rescan: { skills: number };
      };
      expect(payload.id).toBe("alpha@m");
      expect(payload.scope).toBe("user");
      expect(payload.dir).toBe(join(b.home, "plugins", "alpha"));
      expect(payload.detail).toEqual({ skills: 1, commands: 1, agents: 0, hooks: 1, mcp:1 });
      expect(payload.rescan).toEqual({ skills: 7, plugins: 3, hooks: 2 });
    } finally {
      b.cleanup();
    }
  });

  it("duplicate install → exit 1 (already-exists); unknown market/plugin → exit 1", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      await cli(b, ["install", "alpha@m"]);
      const dup = await cli(b, ["install", "alpha@m"]);
      expect(dup.code).toBe(1);
      expect(dup.text).toContain("⚠️");
      const noMarket = await cli(b, ["install", "alpha@nosuch"]);
      expect(noMarket.code).toBe(1);
      expect(noMarket.text).toContain("⚠️");
      await cli(b, ["install", "beta@m"]);
      const noPlugin = await cli(b, ["install", "gamma@m"]);
      expect(noPlugin.code).toBe(1);
    } finally {
      b.cleanup();
    }
  });

  it("uninstall removes dir + record + rescans", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      await cli(b, ["install", "alpha@m"]);
      const rec = rescanRecorder();
      const r = await cli(b, ["uninstall", "alpha@m"], rec.rescan);
      expect(r.code).toBe(0);
      expect(r.text).toContain("已卸载 alpha@m");
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(false);
      expect(installedRows(b)).toEqual([]);
      expect(rec.count()).toBe(1);
    } finally {
      b.cleanup();
    }
  });

  it("disable → registry row off + rescan; enable → back on; both notices 中文", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      await cli(b, ["install", "alpha@m"]);
      const rec = rescanRecorder();
      const off = await cli(b, ["disable", "alpha@m"], rec.rescan);
      expect(off.code).toBe(0);
      expect(off.text).toContain("已停用 alpha@m");
      expect(rec.count()).toBe(1);
      const listOff = await cli(b, ["list", "--json"]);
      expect((listOff.json() as { installed: { id: string; enabled: boolean }[] }).installed).toEqual([
        expect.objectContaining({ id: "alpha@m", enabled: false }),
      ]);
      const on = await cli(b, ["enable", "alpha@m"], rec.rescan);
      expect(on.code).toBe(0);
      expect(on.text).toContain("已启用 alpha@m");
      expect(rec.count()).toBe(2);
      const listOn = await cli(b, ["list", "--json"]);
      expect((listOn.json() as { installed: { enabled: boolean }[] }).installed[0]?.enabled).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("enable of an unknown id → exit 1 with the engine's typed error", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["enable", "alpha@nope"]);
      expect(r.code).toBe(1);
      expect(r.text).toContain("⚠️");
    } finally {
      b.cleanup();
    }
  });

  it("marketplace remove cascades: uninstalls the plugins it installed", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      await cli(b, ["install", "alpha@m"]);
      await cli(b, ["install", "beta@m"]);
      const rec = rescanRecorder();
      const r = await cli(b, ["marketplace", "remove", "m"], rec.rescan);
      expect(r.code).toBe(0);
      expect(r.text).toContain("市场已移除");
      expect(r.text).toContain("连带卸载");
      expect(r.text).toContain("alpha");
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(false);
      expect(existsSync(join(b.home, "plugins", "beta"))).toBe(false);
      expect(installedRows(b)).toEqual([]);
      expect(rec.count()).toBe(1);
    } finally {
      b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// CLI — list (installed registry + the loaded/discovery view)
// ---------------------------------------------------------------------------

describe("wudao plugin list — installed + loaded", () => {
  it("empty home → exit 0, empty-state text in both sections", async () => {
    const b = bed();
    try {
      const r = await cli(b, ["list"]);
      expect(r.code).toBe(0);
      expect(r.text).toContain("无已安装插件");
      expect(r.text).toContain("no plugins");
      const j = await cli(b, ["list", "--json"]);
      expect(j.json()).toEqual({ installed: [], loaded: [] });
    } finally {
      b.cleanup();
    }
  });

  it("after install: the installed row AND the loaded mapping both show it; disable hides it from the loaded view only", async () => {
    const b = bed();
    try {
      await cli(b, ["marketplace", "add", b.market]);
      await cli(b, ["install", "alpha@m"]);
      const r = await cli(b, ["list"]);
      expect(r.text).toContain("alpha@m");
      expect(r.text).toContain("alpha");
      const j = await cli(b, ["list", "--json"]) as unknown as { json: () => { installed: unknown[]; loaded: { name: string; skills: number; commands: number; mcp: number; hooks: number }[] } };
      const payload = j.json();
      expect(payload.installed.length).toBe(1);
      expect(payload.loaded.map((p) => p.name)).toEqual(["alpha"]);
      expect(payload.loaded[0]).toEqual(expect.objectContaining({ name: "alpha", skills: 1, commands: 1, mcp: 1, hooks: 1 }));
      await cli(b, ["disable", "alpha@m"]);
      const off = await cli(b, ["list"]);
      expect(off.text).toContain("alpha@m"); // the registry row stays
      const offJ = (await cli(b, ["list", "--json"])).json() as { installed: unknown[]; loaded: { name: string }[] };
      expect(offJ.installed.length).toBe(1);
      expect(offJ.loaded).toEqual([]); // discovery filters the disabled plugin
    } finally {
      b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Slash face — notices, busy guard, rescan
// ---------------------------------------------------------------------------

describe("/plugin — runPluginSlashCommand", () => {
  it("bare /plugin → the usage notice", async () => {
    const b = bed();
    try {
      const text = await slash(b, "");
      expect(text).toContain("用法"); // ω99-166e-ii: 钉演进（回执头词中文化，brief 二之"plugins 头无钉"实有此泛子串钉）
      expect(text).toContain("install");
      expect(text).toContain("marketplace");
    } finally {
      b.cleanup();
    }
  });

  it("/plugin list → 中文 sections; --json in-session degrades to the text list", async () => {
    const b = bed();
    try {
      const text = await slash(b, "list");
      expect(text).toContain("已安装");
      expect(text).toContain("已加载");
      const flagged = await slash(b, "list --json");
      expect(flagged).toContain("已安装");
    } finally {
      b.cleanup();
    }
  });

  it("/plugin marketplace add <本地夹具> → 中文 notice, engine ran", async () => {
    const b = bed();
    try {
      const text = await slash(b, `marketplace add ${b.market}`);
      expect(text).toContain("市场已添加");
      expect(text).toContain("m");
      expect(existsSync(join(b.home, "marketplaces.json"))).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("/plugin install x@m --scope user → 中文 receipt + rescan + MCP-restart note", async () => {
    const b = bed();
    try {
      await slash(b, `marketplace add ${b.market}`);
      const rec = rescanRecorder();
      const text = await slash(b, "install alpha@m --scope user", { rescan: rec.rescan });
      expect(text).toContain("已安装 alpha@m");
      expect(text).toContain("user 作用域");
      expect(text).toContain("技能 1");
      expect(text).toContain("重启");
      expect(text).toContain("已热重扫");
      expect(rec.count()).toBe(1);
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("a plugin without MCP servers gets no restart note", async () => {
    const b = bed();
    try {
      await slash(b, `marketplace add ${b.market}`);
      const text = await slash(b, "install beta@m");
      expect(text).toContain("已安装 beta@m");
      expect(text).not.toContain("重启");
    } finally {
      b.cleanup();
    }
  });

  it("busy: marketplace remove refuses with the 「运行中无法」family and touches nothing", async () => {
    const b = bed();
    try {
      await slash(b, `marketplace add ${b.market}`);
      await slash(b, "install alpha@m");
      const text = await slash(b, "marketplace remove m", { busy: true });
      expect(text).toBe("⚠️ 运行中无法 /plugin marketplace remove（任务进行中）");
      expect(existsSync(join(b.home, "marketplaces.json"))).toBe(true);
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("busy: uninstall refuses the same way", async () => {
    const b = bed();
    try {
      await slash(b, `marketplace add ${b.market}`);
      await slash(b, "install alpha@m");
      const text = await slash(b, "uninstall alpha@m", { busy: true });
      expect(text).toBe("⚠️ 运行中无法 /plugin uninstall（任务进行中）");
      expect(existsSync(join(b.home, "plugins", "alpha"))).toBe(true);
    } finally {
      b.cleanup();
    }
  });

  it("busy: install / list / enable / disable are busy-safe (config-only) and still run", async () => {
    const b = bed();
    try {
      await slash(b, `marketplace add ${b.market}`);
      await slash(b, "install alpha@m");
      const listed = await slash(b, "list", { busy: true });
      expect(listed).toContain("已安装");
      const rec = rescanRecorder();
      const off = await slash(b, "disable alpha@m", { busy: true, rescan: rec.rescan });
      expect(off).toContain("已停用 alpha@m");
      const on = await slash(b, "enable alpha@m", { busy: true, rescan: rec.rescan });
      expect(on).toContain("已启用 alpha@m");
      expect(rec.count()).toBe(2);
      const installed = await slash(b, "install beta@m", { busy: true });
      expect(installed).toContain("已安装 beta@m");
    } finally {
      b.cleanup();
    }
  });

  it("engine failures surface as ⚠️ notices, never throws", async () => {
    const b = bed();
    try {
      const text = await slash(b, "install alpha@nosuch");
      expect(text).toContain("⚠️");
      const usage = await slash(b, "install alpha");
      expect(usage).toContain("用法"); // ω99-166e-ii: 钉演进（回执头词中文化，brief 二之"plugins 头无钉"实有此泛子串钉）
    } finally {
      b.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Routing — parse, registry listing, driver wiring
// ---------------------------------------------------------------------------

describe("/plugin routing", () => {
  it("parseReplCommand: /plugin and /plugin <args> → {kind:'plugin'}; /pluginx and /plugins stay prompts", () => {
    expect(parseReplCommand("/plugin")).toEqual({ kind: "plugin", args: "" });
    expect(parseReplCommand("/plugin install alpha@m --scope user")).toEqual({ kind: "plugin", args: "install alpha@m --scope user" });
    expect(parseReplCommand("  /plugin   marketplace list  ")).toEqual({ kind: "plugin", args: "marketplace list" });
    expect(parseReplCommand("/pluginx")).toEqual({ kind: "prompt", text: "/pluginx" });
    expect(parseReplCommand("/plugins")).toEqual({ kind: "prompt", text: "/plugins" });
  });

  it("builtins win: /plugin routes builtin even when a plugin registers a command of that name", () => {
    expect(parseReplCommand("/plugin list", ["plugin"])).toEqual({ kind: "plugin", args: "list" });
    expect(isBuiltinCommandName("plugin")).toBe(true);
  });

  it("listSlashCommands carries the builtin /plugin entry", () => {
    const cmd = listSlashCommands({}).find((c) => c.name === "plugin");
    expect(cmd).toBeDefined();
    expect(cmd?.source).toBe("builtin");
    expect(cmd?.description).toContain("install");
  });

  it("the driver routes /plugin to the notice channel (busy refusal mid-run)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "plugin-cli-drv-"));
    try {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const gated = buildTool({
        name: "read_file",
        description: "gated read",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
        execute: async () => {
          await gate;
          return { content: "GATED" };
        },
      });
      const model = createScriptedModel([
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
        { role: "assistant", content: "DONE" },
      ]);
      const driver = createAgentDriver({ model, tools: [gated], systemPrompt: "s", summarize: summarizeToolCall, workspaceRoot: ws });
      driver.submit("go");
      await new Promise((r) => setTimeout(r, 30));
      expect(driver.getStatus().busy).toBe(true);

      driver.submit("/plugin marketplace remove m");
      await new Promise((r) => setTimeout(r, 30));
      const refusal = driver.getHistory().find((e) => e.kind === "notice");
      expect(refusal).toMatchObject({ kind: "notice", text: "⚠️ 运行中无法 /plugin marketplace remove（任务进行中）" });

      driver.submit("/plugin uninstall alpha@m");
      await new Promise((r) => setTimeout(r, 30));
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text === "⚠️ 运行中无法 /plugin uninstall（任务进行中）")).toBe(true);

      release();
      await new Promise((r) => setTimeout(r, 30));
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the driver routes idle /plugin to the usage notice, /plugin list to the inventory notice", async () => {
    const ws = mkdtempSync(join(tmpdir(), "plugin-cli-drv2-"));
    try {
      const model = createScriptedModel([{ role: "assistant", content: "DONE" }]);
      const driver = createAgentDriver({ model, tools: [], systemPrompt: "s", summarize: summarizeToolCall, workspaceRoot: ws });
      driver.submit("/plugin");
      await new Promise((r) => setTimeout(r, 30));
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("用法"))).toBe(true); // ω99-166e-ii: 钉演进（同上）
      driver.submit("/plugin list");
      await new Promise((r) => setTimeout(r, 60));
      expect(driver.getHistory().some((e) => e.kind === "notice" && e.text.includes("已安装"))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

// ---------------------------------------------------------------------------
// tokenizeArgs — quote-aware slash tokenization (E3 · B1 minor)
// ---------------------------------------------------------------------------

describe("tokenizeArgs — quote-aware slash tokenization", () => {
  it("quoted whitespace stays inside ONE token; unquoted splits (file:///a b/c)", () => {
    expect(tokenizeArgs('marketplace add "file:///a b/c"')).toEqual(["marketplace", "add", "file:///a b/c"]);
    expect(tokenizeArgs("marketplace add 'file:///a b/c'")).toEqual(["marketplace", "add", "file:///a b/c"]);
    expect(tokenizeArgs("marketplace add file:///a b/c")).toEqual(["marketplace", "add", "file:///a", "b/c"]);
  });

  it("a fully-quoted empty string is one EMPTY token; an unclosed quote runs to end-of-line (lenient, shell-like)", () => {
    expect(tokenizeArgs("''")).toEqual([""]);
    expect(tokenizeArgs('""')).toEqual([""]);
    expect(tokenizeArgs("'abc")).toEqual(["abc"]);
    expect(tokenizeArgs('install "a b')).toEqual(["install", "a b"]);
  });

  it("empty/whitespace-only input keeps the old trim semantics → []; CJK needs no quotes", () => {
    expect(tokenizeArgs("")).toEqual([]);
    expect(tokenizeArgs("   ")).toEqual([]);
    expect(tokenizeArgs("安装 alpha@m")).toEqual(["安装", "alpha@m"]);
    expect(tokenizeArgs("  list\t--json  ")).toEqual(["list", "--json"]);
  });

  it("/plugin marketplace add \"<path with space>\" → the engine sees the bare path (no literal quotes)", async () => {
    const b = bed();
    // A market whose directory name carries a space — the case the naive
    // whitespace split corrupted into a quoted, nonexistent source.
    const market = makeLocalMarket(join(mkdtempSync(join(tmpdir(), "plugin-cli-sp-")), "mar ket"), "m");
    try {
      const text = await slash(b, `marketplace add "${market}"`);
      expect(text).toContain("市场已添加");
      const reg = JSON.parse(readFileSync(join(b.home, "marketplaces.json"), "utf8")) as { source: string }[];
      expect(reg).toHaveLength(1);
      expect(reg[0]!.source).toBe(market); // the space survived, the quotes did not
    } finally {
      b.cleanup();
      rmSync(join(market, ".."), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
