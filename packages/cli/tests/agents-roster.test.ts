// M30 roster tests against core's roster loader (spec §A): builtin roles,
// workspace profiles, shadowing, and fail-closed profile validation. Core
// semantics: the loaded map LAYERS builtins under workspace files (so it
// always carries the builtins), shadowing is reported per profile with the
// shadowing file, and invalid files degrade to onWarning messages.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILTIN_ROLES, loadRoleProfiles, resolveRole, roleToolNames } from "../src/agents/index.js";
import { ORCHESTRATION_TOOL_NAMES } from "../src/agents/contract.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "roster-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

describe("BUILTIN_ROLES", () => {
  it("carries the six M30 roles", () => {
    expect([...BUILTIN_ROLES.keys()].sort()).toEqual([
      "adversarial-reviewer",
      "coder",
      "consultant",
      "fork",
      "general-purpose",
      "manager",
    ]);
  });

  it("manager dispatches (no write tools) and never edits; consultant defaults to high effort", () => {
    const manager = BUILTIN_ROLES.get("manager");
    expect(manager?.toolNames).not.toContain("write_file");
    expect(manager?.toolNames).not.toContain("edit");
    expect(manager?.description.toLowerCase()).toContain("dispatch");
    const consultant = BUILTIN_ROLES.get("consultant");
    expect(consultant?.reasoningEffort).toBe("high");
    expect(consultant?.toolNames).toEqual(["read_file", "glob", "grep"]);
  });
});

describe("loadRoleProfiles (workspace roster)", () => {
  it("missing roster dir → just the builtins, no shadowing", async () => {
    const r = await loadRoleProfiles(root);
    expect(r.profiles.size).toBe(BUILTIN_ROLES.size);
    expect(r.shadowed).toEqual([]);
    expect(r.profiles.get("coder")?.id).toBe("coder");
  });

  it("loads workspace profiles over the builtins and reports shadowing with the file", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "explorer.json"), JSON.stringify({
      description: "explore broadly",
      systemPrompt: "WORKSPACE-EXPLORER",
      toolNames: ["read_file", "glob"],
    }));
    await writeFile(join(root, ".wudao", "agents", "coder.json"), JSON.stringify({
      description: "workspace coder override",
      systemPrompt: "WORKSPACE-CODER",
    }));
    const r = await loadRoleProfiles(root);
    // A shadow REPLACES its builtin (no new key): builtins + explorer only.
    expect(r.profiles.size).toBe(BUILTIN_ROLES.size + 1);
    expect(r.shadowed).toEqual([{ id: "coder", by: ".wudao/agents/coder.json" }]);
    // Workspace wins over builtin (discovery order: builtin < workspace).
    expect(resolveRole(r, "coder")?.systemPrompt).toBe("WORKSPACE-CODER");
    expect(resolveRole(r, "explorer")?.systemPrompt).toBe("WORKSPACE-EXPLORER");
    // Untouched builtins still resolve.
    expect(resolveRole(r, "consultant")?.reasoningEffort).toBe("high");
    expect(resolveRole(r, "nope")).toBeUndefined();
  });

  it("malformed or invalid profile files degrade to warnings, never throw", async () => {
    await mkdir(join(root, ".wudao", "agents"), { recursive: true });
    await writeFile(join(root, ".wudao", "agents", "broken.json"), "{ not json");
    await writeFile(join(root, ".wudao", "agents", "nodesc.json"), JSON.stringify({ toolNames: ["read_file"] }));
    await writeFile(join(root, ".wudao", "agents", "badturns.json"), JSON.stringify({ description: "x", maxTurns: 0 }));
    const warnings: string[] = [];
    const r = await loadRoleProfiles(root, { onWarning: (m) => warnings.push(m) });
    expect(r.profiles.has("broken")).toBe(false);
    expect(r.profiles.has("nodesc")).toBe(false);
    expect(r.profiles.has("badturns")).toBe(false);
    expect(warnings).toHaveLength(3);
    expect(warnings.some((w) => w.includes("broken.json"))).toBe(true);
    expect(warnings.some((w) => w.includes("description"))).toBe(true);
  });
});

describe("roleToolNames (child isolation)", () => {
  it("never hands a child the orchestration tools, even when a profile lists them", () => {
    const sneaky = {
      id: "sneaky",
      description: "d",
      toolNames: ["read_file", "task", "agent_await", "agent_cancel", "agent_status", "write_file"],
    };
    expect(roleToolNames(sneaky, ORCHESTRATION_TOOL_NAMES)).toEqual(["read_file", "write_file"]);
  });

  it("profiles without toolNames get the read-only default set (M49: + memory_search)", () => {
    expect(roleToolNames({ id: "r", description: "d" }, ORCHESTRATION_TOOL_NAMES)).toEqual(["read_file", "glob", "grep", "memory_search"]);
  });
});
