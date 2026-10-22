// M57 §1 — global-tier discovery for the non-settings config surfaces:
// mcp.json per-server-name replacement, keybindings per-key override,
// skills (project wins on same name + source-annotated warning), and agent
// role profiles (global tier between plugins and the workspace files).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMcpConfig, globalMcpConfigPath } from "../src/mcp/config.js";
import { loadKeybindings } from "../src/tui/keybindings.js";
import { loadSkills, skillsPromptSection, findSkill } from "../src/skills.js";
import { loadRoleProfiles } from "@wudao/core";

let globalHome: string;
let savedEnv: string | undefined;

beforeEach(() => {
  globalHome = mkdtempSync(join(tmpdir(), "wudao-m57-g-"));
  savedEnv = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedEnv;
  rmSync(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function mkProject(): string {
  const ws = mkdtempSync(join(tmpdir(), "wudao-m57-ws-"));
  mkdirSync(join(ws, ".wudao"), { recursive: true });
  return ws;
}

describe("global mcp.json (per-server-name replacement)", () => {
  it("unions servers; a same-name project server REPLACES the global one", () => {
    writeFileSync(
      join(globalHome, "mcp.json"),
      JSON.stringify({ servers: { fetch: { command: "global-fetch" }, weather: { command: "weather" } } }),
      "utf8",
    );
    const ws = mkProject();
    writeFileSync(
      join(ws, ".wudao", "mcp.json"),
      JSON.stringify({ servers: { fetch: { command: "proj-fetch", args: ["--x"] } } }),
      "utf8",
    );
    const config = loadMcpConfig(ws);
    expect(Object.keys(config.servers).sort()).toEqual(["fetch", "weather"]);
    expect(config.servers["fetch"]).toEqual({ command: "proj-fetch", args: ["--x"] });
    expect(config.servers["weather"]).toEqual({ command: "weather" });
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("global-only tier applies in a fresh project with no local mcp.json", () => {
    writeFileSync(join(globalHome, "mcp.json"), JSON.stringify({ servers: { weather: { command: "weather" } } }), "utf8");
    const ws = mkProject();
    expect(loadMcpConfig(ws)).toEqual({ servers: { weather: { command: "weather" } } });
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("globalMcpConfigPath tracks WUDAO_GLOBAL_HOME; malformed global warns naming the file", () => {
    expect(globalMcpConfigPath()).toBe(join(globalHome, "mcp.json"));
    writeFileSync(join(globalHome, "mcp.json"), "{oops", "utf8");
    const warns: string[] = [];
    const ws = mkProject();
    expect(loadMcpConfig(ws, (m) => warns.push(m))).toEqual({ servers: {} });
    expect(warns.some((w) => w.includes("global mcp.json") && w.includes("not valid JSON"))).toBe(true);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("global keybindings.json (per-key override)", () => {
  it("global applies; project overrides per action key; both absent → defaults", async () => {
    writeFileSync(join(globalHome, "keybindings.json"), JSON.stringify({ "app.submit": "ctrl+s", "app.abort": "escape" }), "utf8");
    const ws = mkProject();
    const globalOnly = await loadKeybindings(ws);
    expect(globalOnly["app.submit"]).toEqual({ key: "s", ctrl: true });
    expect(globalOnly["app.abort"]).toEqual({ key: "escape" });
    writeFileSync(join(ws, ".wudao", "keybindings.json"), JSON.stringify({ "app.submit": "ctrl+d" }), "utf8");
    const layered = await loadKeybindings(ws);
    expect(layered["app.submit"]).toEqual({ key: "d", ctrl: true }); // project wins per key
    expect(layered["app.abort"]).toEqual({ key: "escape" }); // global key survives
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  it("malformed global tier warns and is skipped (project tier still applies)", async () => {
    writeFileSync(join(globalHome, "keybindings.json"), "{oops", "utf8");
    const warns: string[] = [];
    const ws = mkProject();
    writeFileSync(join(ws, ".wudao", "keybindings.json"), JSON.stringify({ "app.submit": "ctrl+d" }), "utf8");
    const kb = await loadKeybindings(ws, (w) => warns.push(w));
    expect(kb["app.submit"]).toEqual({ key: "d", ctrl: true });
    expect(warns.some((w) => w.includes("global keybindings.json") && w.includes("not valid JSON"))).toBe(true);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("global skills (project wins + source-annotated warning)", () => {
  function writeSkill(root: string, dir: string, name: string, description: string): void {
    const skillDir = join(root, dir, name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nbody ${name}\n`, "utf8");
  }

  it("a global skill loads in a fresh project; the manifest advertises the invocation", () => {
    writeSkill(globalHome, "skills", "deploy", "global deploy runbook");
    const ws = mkProject();
    const warns: string[] = [];
    const skills = loadSkills(ws, (m) => warns.push(m));
    expect(skills.map((s) => s.name)).toEqual(["deploy"]);
    expect(warns).toEqual([]);
    const section = skillsPromptSection(skills);
    expect(section).toContain("name: deploy — global deploy runbook");
    expect(section).toContain(`invoke: /skill:deploy`);
    expect(section).not.toContain(`path: ${join(globalHome, "skills", "deploy", "SKILL.md")}`);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("same-name project skill wins; the warning annotates both sources", () => {
    writeSkill(globalHome, "skills", "deploy", "global deploy runbook");
    const ws = mkProject();
    writeSkill(ws, ".wudao/skills", "deploy", "project deploy runbook");
    const warns: string[] = [];
    const skills = loadSkills(ws, (m) => warns.push(m));
    expect(findSkill(skills, "deploy")?.description).toBe("project deploy runbook");
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain("project wins");
    expect(warns[0]).toContain(join(ws, ".wudao", "skills", "deploy", "SKILL.md"));
    expect(warns[0]).toContain(join(globalHome, "skills", "deploy", "SKILL.md"));
    // workspace skills keep the read_file path form
    expect(skillsPromptSection(skills)).toContain(`path: .wudao/skills/deploy/SKILL.md`);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});

describe("global agents (roster layer builtin < plugin < global < workspace)", () => {
  it("a global profile loads; a same-name workspace file wins + receipts annotate both", async () => {
    mkdirSync(join(globalHome, "agents"), { recursive: true });
    writeFileSync(
      join(globalHome, "agents", "reviewer.json"),
      JSON.stringify({ description: "global reviewer" }),
      "utf8",
    );
    // fresh project: the global profile is present
    const ws = mkProject();
    const fresh = await loadRoleProfiles(ws, { globalAgentsDir: join(globalHome, "agents") });
    expect(fresh.profiles.get("reviewer")?.description).toBe("global reviewer");
    // same-name workspace file wins, both displacements receipted
    mkdirSync(join(ws, ".wudao", "agents"), { recursive: true });
    writeFileSync(
      join(ws, ".wudao", "agents", "reviewer.json"),
      JSON.stringify({ description: "project reviewer" }),
      "utf8",
    );
    const layered = await loadRoleProfiles(ws, { globalAgentsDir: join(globalHome, "agents") });
    expect(layered.profiles.get("reviewer")?.description).toBe("project reviewer");
    // The displacement receipt names the WINNING file's tier-annotated path
    // (the workspace file beat the global entry; the global entry itself
    // displaced nothing — no builtin had that id).
    const receipts = layered.shadowed.filter((s) => s.id === "reviewer").map((s) => s.by);
    expect(receipts).toEqual([".wudao/agents/reviewer.json"]);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a global profile shadowing a BUILTIN receipts the global tier's path", async () => {
    mkdirSync(join(globalHome, "agents"), { recursive: true });
    writeFileSync(
      join(globalHome, "agents", "coder.json"),
      JSON.stringify({ description: "my own coder" }),
      "utf8",
    );
    const ws = mkProject();
    const roster = await loadRoleProfiles(ws, { globalAgentsDir: join(globalHome, "agents") });
    expect(roster.profiles.get("coder")?.description).toBe("my own coder");
    expect(roster.shadowed.some((s) => s.id === "coder" && s.by === "global agents/coder.json")).toBe(true);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("no globalAgentsDir option → unchanged legacy behavior", async () => {
    mkdirSync(join(globalHome, "agents"), { recursive: true });
    writeFileSync(join(globalHome, "agents", "ghost.json"), JSON.stringify({ description: "never loads" }), "utf8");
    const ws = mkProject();
    const roster = await loadRoleProfiles(ws);
    expect(roster.profiles.has("ghost")).toBe(false);
    rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
});
