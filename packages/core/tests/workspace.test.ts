import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspacePath } from "../src/tools/workspace.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("resolveWorkspacePath", () => {
  it("accepts a relative path inside the root", async () => {
    const r = await resolveWorkspacePath(root, "a.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(join(await realpath(root), "a.txt"));
  });
  it("accepts an absolute path inside the root", async () => {
    const r = await resolveWorkspacePath(root, join(root, "a.txt"));
    expect(r.ok).toBe(true);
  });
  it("rejects a parent escape via ..", async () => {
    const r = await resolveWorkspacePath(root, "../evil.txt");
    expect(r.ok).toBe(false);
  });
  it("rejects an absolute path outside the root", async () => {
    const r = await resolveWorkspacePath(root, join(tmpdir(), "evil.txt"));
    expect(r.ok).toBe(false);
  });
  it("denies a new file under a symlinked directory that escapes the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    await symlink(outside, join(root, "link"));
    const res = await resolveWorkspacePath(root, "link/newfile.txt"); // file does NOT exist yet
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("escapes workspace");
  });
  it("denies an existing file under a symlinked directory that escapes the root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    await writeFile(join(outside, "existing.txt"), "x");
    await symlink(outside, join(root, "link"));
    const res = await resolveWorkspacePath(root, "link/existing.txt");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("escapes workspace");
  });
  it("accepts a new file under a normal (non-symlinked) directory", async () => {
    await mkdir(join(root, "sub"));
    const r = await resolveWorkspacePath(root, "sub/newfile.txt");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absPath).toBe(join(await realpath(root), "sub", "newfile.txt"));
  });
  it("denies a dangling symlink component (symlink whose target does not exist)", async () => {
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    // Create a dangling symlink: target doesn't exist → safeRealpath throws ENOENT
    await symlink(join(outside, "stolen.txt"), join(root, "dangfile"));
    const res = await resolveWorkspacePath(root, "dangfile");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("escapes workspace");
  });
  it("denies a symlink to outside when root has trailing separator", async () => {
    // Create a file outside the workspace
    const outside = await mkdtemp(join(tmpdir(), "out-"));
    await writeFile(join(outside, "external.txt"), "external content");
    // Create a symlink inside root pointing to the external file
    await symlink(join(outside, "external.txt"), join(root, "leak.txt"));
    // Call with root that has trailing separator - this is the bypass vector
    const res = await resolveWorkspacePath(root + "/", "leak.txt");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("escapes workspace");
  });
});
