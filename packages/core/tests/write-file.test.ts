import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteFileTool } from "../src/tools/write-file.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ws-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("write_file", () => {
  it("writes content to a file inside the workspace", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "out.txt", content: "hello" });
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(root, "out.txt"), "utf8")).toBe("hello");
  });
  it("is not read-only", () => {
    expect(createWriteFileTool({ workspaceRoot: root }).isReadOnly?.({ path: "a", content: "" })).toBe(false);
  });
  it("rejects a path that escapes the workspace", async () => {
    const tool = createWriteFileTool({ workspaceRoot: root });
    const res = await tool.execute({ path: "../evil.txt", content: "x" });
    expect(res.isError).toBe(true);
  });
});
