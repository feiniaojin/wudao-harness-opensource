// M57 fix-round — review REQUEST_CHANGES items, pinned:
//   IMPORTANT 1: /permissions mutations write the PROJECT tier only (never
//                the union — no global leak into the repo, no stale copies);
//                removing a global-tier rule writes NOTHING and names the
//                rule's home file; the view shows the union with per-rule
//                tier attribution.
//   MINOR 4:     permissions nodes parse PER TIER — a type-confused node in
//                one tier drops only that tier (global guards survive a
//                project `"permissions": []`).
//   NIT 7:       hooks-loader unknown-key warnings are per-tier and skip the
//                keys the global tier legitimately owns (env).
//   MINOR 5:     /agents attributes global-tier roles as "global" (not
//                "builtin") and the header reads builtin < plugin < global <
//                workspace.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPermissionsCommand } from "../src/commands/permissions.js";
import { loadPermissionSettings, loadPermissionTiers, createPermissionSettingsWatcher } from "../src/permission.js";
import { loadHooksSettings } from "../src/hooks-config.js";
import { runAgentsCommand } from "../src/commands/agents-roster.js";

let globalHome: string;
let savedEnv: string | undefined;

beforeEach(async () => {
  globalHome = await mkdtemp(join(tmpdir(), "wudao-fix-g-"));
  savedEnv = process.env.WUDAO_GLOBAL_HOME;
  process.env.WUDAO_GLOBAL_HOME = globalHome;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env.WUDAO_GLOBAL_HOME;
  else process.env.WUDAO_GLOBAL_HOME = savedEnv;
  await rm(globalHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function mkProject(settings?: Record<string, unknown>): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), "wudao-fix-ws-"));
  await mkdir(join(ws, ".wudao"), { recursive: true });
  if (settings !== undefined) {
    await writeFile(join(ws, ".wudao", "settings.json"), JSON.stringify(settings, null, 2), "utf8");
  }
  return ws;
}

async function writeGlobal(settings: Record<string, unknown>): Promise<void> {
  await writeFile(join(globalHome, "settings.json"), JSON.stringify(settings, null, 2), "utf8");
}

async function readProject(ws: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(ws, ".wudao", "settings.json"), "utf8")) as Record<string, unknown>;
}

describe("IMPORTANT 1 — /permissions writes the project tier only", () => {
  beforeEach(async () => {
    await writeGlobal({ permissions: { allow: ["shell:echo global-ok"], deny: ["shell:rm"] } });
  });

  it("add writes ONLY the project lists — the global tier never lands in the project file", async () => {
    const ws = await mkProject({ hooks: { onRunStop: [] }, permissions: { allow: ["read_file"] } });
    try {
      const notice = await runPermissionsCommand({ workspaceRoot: ws, args: "add allow shell:git status" });
      expect(notice).toContain("added allow rule \"shell:git status\"");
      expect(notice).toContain("written to .wudao/settings.json");
      const onDisk = await readProject(ws);
      // project lists only: the pre-existing project rule + the new one.
      expect(onDisk.permissions).toEqual({ allow: ["read_file", "shell:git status"], deny: [], ask: [] }); // ω99-27: raw disk node — sidecarExempt key stays ABSENT when empty
      // the global tier's rules are NOT copied into the committable file
      expect(JSON.stringify(onDisk)).not.toContain("global-ok");
      expect(JSON.stringify(onDisk)).not.toContain('"shell:rm"');
      // other top-level keys survive the write
      expect(onDisk.hooks).toEqual({ onRunStop: [] });
      // the gate still sees the UNION (watcher = the gate's source)
      const viaWatcher = await createPermissionSettingsWatcher(ws, undefined, { revalidateMs: 0 }).get();
      expect(viaWatcher.allow).toEqual(["shell:echo global-ok", "read_file", "shell:git status"]);
      expect(viaWatcher.deny).toEqual(["shell:rm"]);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("remove of a GLOBAL-tier rule writes nothing and names the rule's home (no false receipt)", async () => {
    const ws = await mkProject({ permissions: { allow: ["read_file"] } });
    try {
      const before = await readFile(join(ws, ".wudao", "settings.json"), "utf8");
      const notice = await runPermissionsCommand({ workspaceRoot: ws, args: "remove deny shell:rm" });
      expect(notice).toContain("cannot remove");
      expect(notice).toContain("GLOBAL tier");
      expect(notice).toContain(join(globalHome, "settings.json"));
      expect(notice).not.toContain("removed deny rule");
      // byte-identical project file — nothing was written
      expect(await readFile(join(ws, ".wudao", "settings.json"), "utf8")).toBe(before);
      // and the rule is still live at the gate
      const gate = await createPermissionSettingsWatcher(ws, undefined, { revalidateMs: 0 }).get();
      expect(gate.deny).toContain("shell:rm");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("remove of a PROJECT-tier rule still writes (and leaves the global tier out of the file)", async () => {
    const ws = await mkProject({ permissions: { allow: ["read_file"] } });
    try {
      const notice = await runPermissionsCommand({ workspaceRoot: ws, args: "remove allow read_file" });
      expect(notice).toContain("removed allow rule \"read_file\"");
      expect((await readProject(ws)).permissions).toEqual({ allow: [], deny: [], ask: [] }); // ω99-27: raw disk node — no sidecarExempt key when empty
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("the bare view shows the UNION with per-rule tier attribution", async () => {
    const ws = await mkProject({ permissions: { allow: ["read_file", "shell:echo global-ok"], deny: [] } });
    try {
      const view = await runPermissionsCommand({ workspaceRoot: ws, args: "" });
      expect(view).toContain("union of");
      expect(view).toContain(join(globalHome, "settings.json"));
      // attribution: global-only → (global); project-only → (project); both → (global+project)
      expect(view).toContain("shell:rm  (global)");
      expect(view).toContain("read_file  (project)");
      expect(view).toContain("shell:echo global-ok  (global+project)");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("MINOR 4 — permissions nodes parse per tier (type-confusion containment)", () => {
  it('a project `"permissions": []` cannot erase the global tier\'s guards', async () => {
    await writeGlobal({ permissions: { deny: ["shell:rm"], ask: ["write_file"] } });
    const ws = await mkProject({ permissions: [] });
    try {
      const warns: string[] = [];
      const settings = await loadPermissionSettings(ws, (m) => warns.push(m));
      expect(settings.deny).toEqual(["shell:rm"]);
      expect(settings.ask).toEqual(["write_file"]);
      // the warning names the offending TIER's file (the project one)
      expect(warns.some((w) => w.includes(join(ws, ".wudao", "settings.json")) && w.includes("must be an object"))).toBe(true);
      expect(warns.some((w) => w.includes(globalHome))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("a malformed GLOBAL tier drops only the global rules (project survives, warning names it)", async () => {
    await writeGlobal({ permissions: "nope" });
    const ws = await mkProject({ permissions: { allow: ["read_file"] } });
    try {
      const warns: string[] = [];
      const settings = await loadPermissionSettings(ws, (m) => warns.push(m));
      expect(settings).toEqual({ allow: ["read_file"], deny: [], ask: [], sidecarExempt: [] });
      expect(warns.some((w) => w.includes(join(globalHome, "settings.json")))).toBe(true);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  it("loadPermissionTiers exposes the three faces (global / project / effective union)", async () => {
    await writeGlobal({ permissions: { deny: ["shell:rm"] } });
    const ws = await mkProject({ permissions: { deny: ["shell:rm"], allow: ["read_file"] } });
    try {
      const tiers = await loadPermissionTiers(ws);
      expect(tiers.global.deny).toEqual(["shell:rm"]);
      expect(tiers.project).toEqual({ allow: ["read_file"], deny: ["shell:rm"], ask: [], sidecarExempt: [] });
      expect(tiers.effective.deny).toEqual(["shell:rm"]); // deduped union
      expect(tiers.effective.allow).toEqual(["read_file"]);
      expect(tiers.globalHome).toBe(globalHome);
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("NIT 7 — hooks-loader unknown-key warnings are per-tier, global-owned keys silent", () => {
  it("a global-tier env key never warns; genuinely unknown keys warn tier-tagged", async () => {
    await writeGlobal({ env: { WUDAO_NOTE: "x" }, banana: 1, hooks: { onRunStop: [{ command: "echo global-hook" }] } });
    const ws = await mkProject({ banana2: 2, hooks: { onRunStop: [{ command: "echo project-hook" }] } });
    try {
      const warns: string[] = [];
      const settings = await loadHooksSettings(ws, (m) => warns.push(m));
      // the union of hook lists still applies (distinct entries; identical
      // entries across tiers dedup — the concat-dedup merge rule)
      expect(settings.onRunStop).toEqual([{ command: "echo global-hook" }, { command: "echo project-hook" }]);
      const joined = warns.join("\n");
      expect(joined).not.toContain("env"); // reserved key: silent
      expect(joined).toContain("banana2"); // project unknown → project-tagged warning
      expect(joined).toContain(".wudao/settings.json");
      expect(joined).toContain("banana");
      expect(joined).toContain("全局 settings"); // global unknown → tier-tagged；ω99-207 钉随源演进（三层头词面中文化，census 漏网披露同弧演进）
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("MINOR 5 — /agents attributes global-tier roles as global", () => {
  it("a global-only role lands in the global section, never mislabeled builtin", async () => {
    await mkdir(join(globalHome, "agents"), { recursive: true });
    await writeFile(join(globalHome, "agents", "reviewer.json"), JSON.stringify({ description: "global reviewer" }), "utf8");
    const ws = await mkProject();
    try {
      const report = await runAgentsCommand({ workspaceRoot: ws });
      expect(report).toContain("builtin < plugin < global < workspace");
      expect(report).toMatch(/1 global/);
      // ω99-181: 钉随源演进——section 头全角冒号（face #8），边界标记同步。
      const globalSection = report.slice(report.indexOf("global："), report.indexOf("workspace："));
      expect(globalSection).toContain("reviewer");
      expect(globalSection).toContain("global reviewer");
      // the builtin section must NOT list the global role (the builtin
      // "adversarial-reviewer" contains the substring — match the entry line)
      const builtinSection = report.slice(report.indexOf("builtin："), report.indexOf("plugin："));
      expect(builtinSection).not.toContain("\n  reviewer —");
    } finally {
      await rm(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
