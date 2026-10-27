import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createReadFileTool } from "../src/tools/read-file.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("read_file tool", () => {
  it("reads a file as utf-8 text", async () => {
    const tool = createReadFileTool();
    const path = join(here, "fixtures", "sample.txt");
    const res = await tool.execute({ path });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("the quick brown fox");
  });

  it("returns an error result for a missing file (does not throw)", async () => {
    const tool = createReadFileTool();
    const res = await tool.execute({ path: join(here, "fixtures", "does-not-exist.txt") });
    expect(res.isError).toBe(true);
  });

  it("is a read-only tool", () => {
    const tool = createReadFileTool();
    expect(tool.isReadOnly?.({ path: "x" })).toBe(true);
  });
});

describe("read_file workspace confinement", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("rejects an absolute path outside the root", async () => {
    const tool = createReadFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: join(tmpdir(), "outside.txt") });
    expect(res.isError).toBe(true);
    expect(res.content).toContain("escapes workspace");
  });

  it("reads a relative path inside the root", async () => {
    await writeFile(join(root, "inside.txt"), "confined content");
    const tool = createReadFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "inside.txt" });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("confined content");
  });

  it("reads an absolute path inside the root", async () => {
    await writeFile(join(root, "abs.txt"), "abs content");
    const tool = createReadFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: join(root, "abs.txt") });
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain("abs content");
  });

  it("denies an existing symlink inside the root pointing outside", async () => {
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    try {
      await writeFile(join(outside, "secret.txt"), "stolen");
      await symlink(join(outside, "secret.txt"), join(root, "leak.txt"));
      const tool = createReadFileTool({ workspaceRoot: root });
      const res = await tool.execute({ path: "leak.txt" });
      expect(res.isError).toBe(true);
      expect(res.content).toContain("escapes workspace");
      expect(res.content).not.toContain("stolen");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads a plain file inside the root while an outside file with the same name exists", async () => {
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    try {
      await writeFile(join(root, "real.txt"), "in-root");
      await writeFile(join(outside, "real.txt"), "outside");
      const tool = createReadFileTool({ workspaceRoot: root });
      const res = await tool.execute({ path: "real.txt" });
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain("in-root");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
