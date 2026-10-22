import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGrepTool } from "../src/tools/grep.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); await writeFile(join(root, "f.txt"), "alpha\nbeta\nGAMMA\ndelta"); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("grep", () => {
  it("returns matching lines with path:line", async () => {
    const res = await createGrepTool({ workspaceRoot: root }).execute({ pattern: "beta" });
    expect(res.content).toContain("f.txt:2: beta");
  });
  it("is case-sensitive", async () => {
    const res = await createGrepTool({ workspaceRoot: root }).execute({ pattern: "gamma" });
    expect(res.content).toBe("(no matches)"); // 'GAMMA' != 'gamma'
  });
  it("reports no matches cleanly", async () => {
    const res = await createGrepTool({ workspaceRoot: root }).execute({ pattern: "zzz" });
    expect(res.content).toBe("(no matches)");
  });
  it("returns matches sorted by path then line number", async () => {
    // Create files b.txt (line 2 hit, line 3 hit) and a.txt (line 3 hit)
    await writeFile(join(root, "b.txt"), "skip\nmatch-b2\nmatch-b1\n");
    await writeFile(join(root, "a.txt"), "skip\nskip\nmatch-a3\n");
    const res = await createGrepTool({ workspaceRoot: root }).execute({ pattern: "match" });
    const lines = res.content.split("\n");
    expect(lines.length).toBe(3);
    expect(lines[0].startsWith("a.txt:3:")).toBe(true);
    expect(lines[1].startsWith("b.txt:2:")).toBe(true);
    expect(lines[2].startsWith("b.txt:3:")).toBe(true);
  });
});
