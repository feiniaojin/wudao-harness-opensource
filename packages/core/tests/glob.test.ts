import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGlobTool } from "../src/tools/glob.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "a.ts"), "x");
  await writeFile(join(root, "src", "b.js"), "x");
  await writeFile(join(root, "README.md"), "x");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("glob", () => {
  it("matches **/*.ts", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "**/*.ts" });
    expect(res.content).toContain("src/a.ts");
    expect(res.content).not.toContain("b.js");
  });
  it("reports no matches cleanly", async () => {
    const res = await createGlobTool({ workspaceRoot: root }).execute({ pattern: "**/*.zig" });
    expect(res.content).toBe("(no matches)");
  });
});
