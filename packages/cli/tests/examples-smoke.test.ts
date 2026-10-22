// M40 §3 — examples smoke: every file under examples/ is loadable by the
// REAL loaders (extensions via dynamic import through loadExtensions, the
// demo plugin via loadPlugins) and registers the surface its README
// promises. Guards the examples against rot: a stale example fails CI.
import { describe, it, expect } from "vitest";
import { mkdtemp, cp, mkdir, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../src/extensions/loader.js";
import { loadPlugins, collectPluginAgents } from "../src/plugins.js";
import { loadRoleProfiles } from "../src/agents/index.js";

const EXAMPLES_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "examples");

describe("examples/ (M40) load through the real loaders", () => {
  it("examples/extensions/*.mjs all load and register their advertised surface", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-examples-ext-"));
    await mkdir(join(ws, ".wudao", "extensions"), { recursive: true });
    const files = (await readdir(join(EXAMPLES_ROOT, "extensions"))).filter((f) => f.endsWith(".mjs")).sort();
    expect(files.length).toBeGreaterThanOrEqual(3); // 01-echo, 02-guard, 03-session-notes
    await cp(join(EXAMPLES_ROOT, "extensions"), join(ws, ".wudao", "extensions"), { recursive: true });
    const warnings: string[] = [];
    const rt = await loadExtensions(ws, { warn: (m) => void warnings.push(m) });
    // Every example loaded (no import/factory failures).
    expect(rt.names.sort()).toEqual(files.map((f) => f.replace(/\.mjs$/, "")).sort());
    expect(warnings).toEqual([]);
    // The advertised surfaces.
    expect(rt.tools.map((t) => t.name).sort()).toEqual(["ext_echo", "ext_session_notes"]);
    expect(rt.commands.map((c) => c.name).sort()).toEqual(["ext-hello", "note"]);
    expect(rt.hooks).toBeDefined(); // 02-guard's interceptors + 03's run_stop
    // The guard actually blocks a destructive command (interceptor live).
    const block = await rt.hooks!.onPreToolUse!("shell", { command: "rm -rf /tmp/somewhere" });
    expect(block).toEqual({ block: true, reason: expect.stringContaining("02-guard") });
    // And lets a harmless one through.
    expect(await rt.hooks!.onPreToolUse!("shell", { command: "ls -la" })).toBeUndefined();
    // 01's echo tool executes end to end.
    const echo = rt.tools.find((t) => t.name === "ext_echo")!;
    const out = await echo.execute({ value: "hi" });
    expect(out.content).toContain("echo: hi");
  });

  it("examples/plugins/demo loads as a --plugin mount: skill + command + two translated agents", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-examples-plugin-"));
    const warnings: string[] = [];
    const plugins = loadPlugins(ws, [join(EXAMPLES_ROOT, "plugins", "demo")], (m) => void warnings.push(m));
    expect(warnings).toEqual([]);
    expect(plugins.length).toBe(1);
    const p = plugins[0]!;
    expect(p.name).toBe("demo");
    expect(p.source).toBe("flag");
    expect(p.skills.map((s) => s.name)).toEqual(["release-checklist"]);
    expect(p.commands.map((c) => c.name)).toEqual(["verify"]);
    // Both agents translate: tools mapped through the the upstream formataliases, doc-writer
    // carries the deepseek provider pin.
    const agents = p.agents.map((a) => a.profile);
    expect(agents.map((a) => a.id).sort()).toEqual(["doc-writer", "ticket-triage"]);
    const triage = agents.find((a) => a.id === "ticket-triage")!;
    expect(triage.toolNames).toEqual(["read_file", "grep", "glob"]);
    expect(triage.systemPrompt).toContain("ticket triage specialist");
    const writer = agents.find((a) => a.id === "doc-writer")!;
    expect(writer.provider).toBe("deepseek");
    expect(writer.toolNames).toContain("write_file");
    // And the collected layer lands in a roster query.
    const layer = collectPluginAgents(plugins);
    const roster = await loadRoleProfiles(ws, { pluginAgents: layer });
    expect(roster.profiles.get("ticket-triage")?.description).toContain("Triage bug reports");
    expect(roster.shadowed).toEqual([]);
  });

  it("examples/agents/*.json are valid roster profiles", async () => {
    const ws = await mkdtemp(join(tmpdir(), "wudao-examples-roles-"));
    await mkdir(join(ws, ".wudao", "agents"), { recursive: true });
    await cp(join(EXAMPLES_ROOT, "agents"), join(ws, ".wudao", "agents"), { recursive: true });
    const warnings: string[] = [];
    const roster = await loadRoleProfiles(ws, { onWarning: (m) => void warnings.push(m) });
    expect(warnings).toEqual([]);
    expect(roster.profiles.get("explorer")?.toolNames).toEqual(["read_file", "glob", "grep"]);
    const reviewer = roster.profiles.get("reviewer");
    expect(reviewer?.frozen).toBe(true);
    expect(reviewer?.model).toBe("deepseek-chat");
    // The example README is in the copied dir but is not a profile — skipped
    // by extension, so no warnings and exactly the two roles above.
    expect([...roster.profiles.keys()].filter((k) => k === "explorer" || k === "reviewer").length).toBe(2);
    // The README index exists and names both files.
    const readme = await readFile(join(EXAMPLES_ROOT, "agents", "README.md"), "utf8");
    expect(readme).toContain("explorer.json");
    expect(readme).toContain("reviewer.json");
  });
});
