// ω99-30 (F) — glob pattern-as-intent: an explicitly named dot directory in
// the pattern is reachable; implicit traversal never enters dot dirs; .git
// is hard-excluded (never reachable, matching the permission pipeline's
// immune-protected posture); node_modules stays unconditionally hidden; the
// walker's default face (absent/empty allowlist) is byte-for-byte today's.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobTool } from "../src/tools/glob.js";
import { listWorkspaceFiles } from "../src/tools/workspace.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
  // The ω99-26 live shape: a mounted mission bundle the model NAMED
  // explicitly and glob answered "(no matches)" to.
  await mkdir(join(root, ".wudao", "mission-bundles", "migration", "skills"), { recursive: true });
  await writeFile(join(root, ".wudao", "mission-bundles", "migration", "skills", "x.md"), "skill body");
  await writeFile(join(root, ".wudao", "mission.json"), "{}");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main");
  await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(join(root, "node_modules", "pkg", "i.js"), "x");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "x");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("ω99-30 T2 — glob pattern-as-intent (explicit dot-dir reachability)", () => {
  it("① an explicitly named dot path is reachable (the ω99-26 lie, fixed)", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: ".wudao/mission-bundles/**/*" });
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain(".wudao/mission-bundles/migration/skills/x.md");
    // Non-recursive direct child of a named dot dir too.
    const direct = await createGlobTool({ workspaceRoot: root }).execute({ pattern: ".wudao/*" });
    expect(direct.content).toContain(".wudao/mission.json");
  });

  it("② implicit traversal never enters dot dirs — **/* hides .wudao/.git/node_modules", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "**/*" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).not.toContain(".wudao");
    expect(res.content).not.toContain(".git");
    expect(res.content).not.toContain("node_modules");
  });

  it("③ .git is NEVER reachable, even when named explicitly", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: ".git/**" });
    expect(res.content).toBe("(no matches)");
  });

  it("④ node_modules stays hidden even when named explicitly", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "node_modules/**/*" });
    expect(res.content).toBe("(no matches)");
  });

  it("⑤ the walker's default face is unchanged (absent/empty allowlist identical)", async () => {
    const absent = await listWorkspaceFiles(root);
    const explicitUndef = await listWorkspaceFiles(root, undefined);
    const emptySet = await listWorkspaceFiles(root, new Set());
    expect(absent).toEqual(explicitUndef);
    expect(absent).toEqual(emptySet);
    expect(absent).toEqual(["src/a.ts"]); // no dot entries, no node_modules
    // And a pattern with no dot segments behaves exactly as today.
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "src/**/*.ts" });
    expect(res.content).toBe("src/a.ts");
  });
});
