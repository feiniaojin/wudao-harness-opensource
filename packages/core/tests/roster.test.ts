import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_ROLES,
  loadRoleProfiles,
  toSubagentType,
  intersectToolNames,
} from "../src/agents/roster.js";
import { BUILTIN_SUBAGENT_TYPES } from "../src/subagent.js";

let root: string;
let warnings: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "roster-"));
  warnings = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeRole(name: string, body: unknown): Promise<void> {
  await mkdir(join(root, ".wudao", "agents"), { recursive: true });
  await writeFile(join(root, ".wudao", "agents", name), typeof body === "string" ? body : JSON.stringify(body));
}

describe("BUILTIN_ROLES", () => {
  it("migrates the three M9 subagent types with byte-identical prompts and tools", () => {
    for (const id of ["general-purpose", "coder", "fork"]) {
      const role = BUILTIN_ROLES[id]!;
      const legacy = BUILTIN_SUBAGENT_TYPES[id]!;
      expect(role.id).toBe(id);
      expect(role.description).toBe(legacy.description);
      expect(role.systemPrompt).toBe(legacy.systemPrompt);
      expect(role.toolNames).toEqual(legacy.toolNames);
    }
  });

  it("keeps the legacy export as a compatible alias covering the builtins", () => {
    for (const id of Object.keys(BUILTIN_ROLES)) {
      expect(BUILTIN_SUBAGENT_TYPES[id]).toBeDefined();
      expect(BUILTIN_SUBAGENT_TYPES[id]!.name).toBe(id);
    }
  });

  it("adds manager, adversarial-reviewer, and consultant doctrine profiles", () => {
    expect(Object.keys(BUILTIN_ROLES)).toEqual(
      expect.arrayContaining(["manager", "adversarial-reviewer", "consultant"]),
    );
    const consultant = BUILTIN_ROLES["consultant"]!;
    expect(consultant.reasoningEffort).toBe("high");
    expect(consultant.description.length).toBeGreaterThan(10);
    // Doctrine prompts are substantive, not placeholders.
    for (const id of ["manager", "adversarial-reviewer", "consultant"]) {
      expect(BUILTIN_ROLES[id]!.systemPrompt!.length).toBeGreaterThan(80);
    }
    // Manager dispatches; adversarial-reviewer and consultant are read-only.
    expect(BUILTIN_ROLES["manager"]!.toolNames).toContain("task");
    expect(BUILTIN_ROLES["adversarial-reviewer"]!.toolNames).not.toContain("write_file");
    expect(BUILTIN_ROLES["consultant"]!.toolNames).not.toContain("write_file");
  });
});

describe("loadRoleProfiles", () => {
  it("returns all builtins when the workspace has no .wudao/agents dir", async () => {
    const { profiles, shadowed } = await loadRoleProfiles(root);
    expect(shadowed).toEqual([]);
    expect(profiles.size).toBe(Object.keys(BUILTIN_ROLES).length);
    expect(profiles.get("coder")!.systemPrompt).toBe(BUILTIN_ROLES["coder"]!.systemPrompt);
  });

  it("loads a workspace role and lets it shadow a builtin (recorded)", async () => {
    await writeRole("general-purpose.json", {
      description: "workspace-flavored researcher",
      systemPrompt: "WS-PROMPT",
      toolNames: ["read_file"],
      maxTurns: 7,
      frozen: true,
      worktree: true,
    });
    const { profiles, shadowed } = await loadRoleProfiles(root);
    const role = profiles.get("general-purpose")!;
    expect(role.systemPrompt).toBe("WS-PROMPT");
    expect(role.toolNames).toEqual(["read_file"]);
    expect(role.maxTurns).toBe(7);
    expect(role.frozen).toBe(true);
    expect(role.worktree).toBe(true);
    expect(shadowed).toEqual([{ id: "general-purpose", by: ".wudao/agents/general-purpose.json" }]);
  });

  it("skips a corrupt file with a warning instead of crashing (warn-not-crash)", async () => {
    await writeRole("broken.json", "{not json");
    await writeRole("good.json", { description: "fine", systemPrompt: "ok" });
    const { profiles, shadowed } = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    expect(profiles.has("good")).toBe(true);
    expect(profiles.has("broken")).toBe(false);
    expect(shadowed).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("broken.json");
  });

  it("skips files missing the required description or with wrong field types", async () => {
    await writeRole("nodesc.json", { systemPrompt: "no description" });
    await writeRole("badturns.json", { description: "x", maxTurns: "many" });
    await writeRole("badtools.json", { description: "x", toolNames: ["read_file", 5] });
    await writeRole("badsandbox.json", { description: "x", sandbox: "yes" });
    await writeRole("notjson.txt", { description: "ignored by extension" });
    const { profiles } = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    for (const id of ["nodesc", "badturns", "badtools", "badsandbox", "notjson"]) {
      expect(profiles.has(id)).toBe(false);
    }
    expect(warnings.length).toBe(4);
  });

  it("ignores unknown extra keys (forward compatible)", async () => {
    await writeRole("future.json", { description: "x", futureField: { nested: true } });
    const { profiles } = await loadRoleProfiles(root);
    expect(profiles.has("future")).toBe(true);
  });

  // M31 §1: writeScope + allowShell role fields.
  it("loads writeScope and allowShell declarations", async () => {
    await writeRole("scoped.json", {
      description: "writes only its package",
      writeScope: { roots: ["packages/a/"], exactFiles: ["pkg.json"] },
      allowShell: true,
    });
    const { profiles } = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    const role = profiles.get("scoped")!;
    expect(role.writeScope).toEqual({ roots: ["packages/a/"], exactFiles: ["pkg.json"] });
    expect(role.allowShell).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("skips roles with malformed writeScope or non-boolean allowShell", async () => {
    await writeRole("badscope1.json", { description: "x", writeScope: { roots: "src/" } });
    await writeRole("badscope2.json", { description: "x", writeScope: { roots: ["a", 3] } });
    await writeRole("badscope3.json", { description: "x", writeScope: ["/abs"] });
    await writeRole("badshell.json", { description: "x", allowShell: "always" });
    await writeRole("good.json", { description: "x", writeScope: {} });
    const { profiles } = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    for (const id of ["badscope1", "badscope2", "badscope3", "badshell"]) {
      expect(profiles.has(id)).toBe(false);
    }
    expect(profiles.has("good")).toBe(true); // empty declaration = "writes nowhere"
    expect(warnings.length).toBe(4);
  });

  // M40 §2: the plugin agent layer — builtin < plugin < workspace.
  it("slots plugin agents between builtins and workspace files, chaining receipts", async () => {
    // A plugin agent with a BUILTIN id (replaces it), a plugin agent with a
    // fresh id, and a workspace file reclaiming the builtin id from the plugin.
    await writeRole("coder.json", { description: "the workspace's own coder", systemPrompt: "WS-CODER" });
    const { profiles, shadowed } = await loadRoleProfiles(root, {
      onWarning: (m) => warnings.push(m),
      pluginAgents: [
        { profile: { id: "coder", description: "plugin coder", systemPrompt: "PLUGIN-CODER" }, source: "plugin demo: agents/coder.md" },
        { profile: { id: "guardian", description: "plugin-only role", systemPrompt: "PLUGIN-GUARDIAN" }, source: "plugin demo: agents/guardian.md" },
      ],
    });
    // Workspace wins the coder slot; the plugin-only role lands.
    expect(profiles.get("coder")!.systemPrompt).toBe("WS-CODER");
    expect(profiles.get("guardian")!.systemPrompt).toBe("PLUGIN-GUARDIAN");
    // Receipts chain in layer order: builtin→plugin, then plugin→workspace.
    expect(shadowed).toEqual([
      { id: "coder", by: "plugin demo: agents/coder.md" },
      { id: "coder", by: ".wudao/agents/coder.json" },
    ]);
    expect(warnings).toEqual([]);
  });

  it("applies plugin agents even when the workspace has no .wudao/agents dir", async () => {
    const { profiles, shadowed } = await loadRoleProfiles(root, {
      pluginAgents: [
        { profile: { id: "reviewer", description: "plugin reviewer", systemPrompt: "PLUGIN-REVIEWER" }, source: "plugin demo: agents/reviewer.md" },
      ],
    });
    expect(profiles.get("reviewer")!.systemPrompt).toBe("PLUGIN-REVIEWER");
    expect(shadowed).toEqual([]); // fresh id — nothing was shadowed
  });

  it("a plugin agent shadowing a builtin records the receipt and replaces it", async () => {
    const { profiles, shadowed } = await loadRoleProfiles(root, {
      pluginAgents: [
        { profile: { id: "coder", description: "plugin coder", systemPrompt: "PLUGIN-CODER" }, source: "plugin demo: agents/coder.md" },
      ],
    });
    expect(profiles.get("coder")!.systemPrompt).toBe("PLUGIN-CODER");
    expect(profiles.size).toBe(Object.keys(BUILTIN_ROLES).length); // replaced, not appended
    expect(shadowed).toEqual([{ id: "coder", by: "plugin demo: agents/coder.md" }]);
  });

  it("skips a plugin agent with an invalid role id (warn-not-crash)", async () => {
    const { profiles, shadowed } = await loadRoleProfiles(root, {
      onWarning: (m) => warnings.push(m),
      pluginAgents: [
        { profile: { id: "not a valid id!", description: "x" }, source: "plugin demo: agents/bad.md" },
      ],
    });
    expect(profiles.has("not a valid id!")).toBe(false);
    expect(shadowed).toEqual([]);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("bad.md");
  });
});

describe("toSubagentType", () => {
  it("adapts a profile, defaulting prompt and tools when absent", () => {
    const t = toSubagentType({ id: "minimal", description: "d" });
    expect(t.name).toBe("minimal");
    expect(t.toolNames).toEqual([]);
    expect(t.systemPrompt.length).toBeGreaterThan(10);
    expect(toSubagentType(BUILTIN_ROLES["coder"]!).systemPrompt).toBe(BUILTIN_ROLES["coder"]!.systemPrompt);
  });
});

describe("intersectToolNames", () => {
  it("keeps requested order and drops unavailable tools", () => {
    expect(intersectToolNames(["grep", "edit", "read_file"], ["read_file", "grep", "todo_write"]))
      .toEqual(["grep", "read_file"]);
  });
});
