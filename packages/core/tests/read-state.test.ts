// M32 §1 — the per-session read-state table and its consumers.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, utimes, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReadStateTable,
  hashContent,
  countLines,
  readStateEntry,
  freshnessError,
  SNAPSHOT_CAP_BYTES,
} from "../src/tools/read-state.js";
import { createReadFileTool } from "../src/tools/read-file.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
  await writeFile(join(root, "a.txt"), "l1\nl2\n", "utf8");
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const T0 = new Date("2024-01-01T00:00:00Z");
const T1 = new Date("2024-01-02T00:00:00Z");

/** resolveWorkspacePath keys the table by the REALPATH of the target (symlinks
 *  resolved — on macOS /var is /private/var), so tests must look entries up
 *  the same way the tools resolve them. */
const keyOf = (root: string, rel: string): Promise<string> => realpath(join(root, rel));

describe("read-state table", () => {
  it("records, gets, deletes entries", () => {
    const table = createReadStateTable();
    const entry = readStateEntry("x\n", 1234);
    table.record("/p/a.txt", entry);
    expect(table.get("/p/a.txt")).toEqual(entry);
    expect(table.get("/p/other")).toBeUndefined();
    table.delete("/p/a.txt");
    expect(table.get("/p/a.txt")).toBeUndefined();
  });
  it("entries() iterates in record order", () => {
    const table = createReadStateTable();
    table.record("/p/1", readStateEntry("a", 1));
    table.record("/p/2", readStateEntry("b", 2));
    expect([...table.entries().keys()]).toEqual(["/p/1", "/p/2"]);
  });
  it("countLines follows the read_file convention", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
  });
  it("hashContent is stable and short", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
    expect(hashContent("hello")).not.toBe(hashContent("hellp"));
    expect(hashContent("hello")).toMatch(/^[0-9a-f]{16}$/);
  });
  it("readStateEntry drops the snapshot past the cap but keeps the hash", () => {
    const big = "x".repeat(SNAPSHOT_CAP_BYTES + 1);
    const entry = readStateEntry(big, 1);
    expect(entry.content).toBeUndefined();
    expect(entry.contentHash).toBe(hashContent(big));
    expect(readStateEntry("small", 1).content).toBe("small");
  });
  it("freshnessError: undefined for never-read; stale on mtime drift; fresh on match", () => {
    const table = createReadStateTable();
    expect(freshnessError(table, "/p/a", 5)).toBeUndefined();
    table.record("/p/a", readStateEntry("c", 5));
    expect(freshnessError(table, "/p/a", 5)).toBeUndefined();
    expect(freshnessError(table, "/p/a", 5, "c")).toBeUndefined();
    const stale = freshnessError(table, "/p/a", 6);
    expect(stale).toContain("changed since your last read");
    expect(freshnessError(table, "/p/a", 5, "different")).toContain("changed since your last read");
  });
});

describe("read_file records the session's view", () => {
  it("a successful read records hash/mtime/lineCount/content", async () => {
    const table = createReadStateTable();
    await utimes(join(root, "a.txt"), T0, T0);
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    await read.execute({ path: "a.txt" });
    const entry = table.get(await keyOf(root, "a.txt"));
    expect(entry).toBeDefined();
    expect(entry?.lineCount).toBe(2);
    expect(entry?.content).toBe("l1\nl2\n");
    expect(entry?.contentHash).toBe(hashContent("l1\nl2\n"));
    expect(entry?.mtimeMs).toBe(T0.getTime());
  });
  it("windowed reads record the FULL file (the read observed all of it)", async () => {
    await writeFile(join(root, "big.txt"), Array.from({ length: 50 }, (_, i) => `l${i}`).join("\n"), "utf8");
    const table = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    await read.execute({ path: "big.txt", offset: 1, limit: 5 });
    const entry = table.get(await keyOf(root, "big.txt"));
    expect(entry?.lineCount).toBe(50);
  });
  it("failed reads record nothing", async () => {
    const table = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    const res = await read.execute({ path: "missing.txt" });
    expect(res.isError).toBe(true);
    expect(table.entries().size).toBe(0);
  });
  it("an elided re-read still refreshes the entry (the file was observed)", async () => {
    const table = createReadStateTable();
    const p = await keyOf(root, "a.txt");
    let inContext = "";
    const read = createReadFileTool({
      workspaceRoot: root,
      readState: table,
      contextProbe: () => [{ role: "tool" as const, toolCallId: "t", name: "read_file", content: inContext }],
    });
    const first = await read.execute({ path: "a.txt" });
    expect(first.isError).toBeFalsy();
    inContext = "l1\nl2\n";
    const elided = await read.execute({ path: "a.txt" });
    expect(elided.content).toContain("[elided]");
    expect(table.get(p)).toBeDefined();
  });
});

describe("write_file freshness gate", () => {
  it("refuses an overwrite after an external change, passes after a re-read", async () => {
    const table = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    const write = createWriteFileTool({ workspaceRoot: root, readState: table });
    await utimes(join(root, "a.txt"), T0, T0);
    await read.execute({ path: "a.txt" });
    await writeFile(join(root, "a.txt"), "external\n", "utf8");
    await utimes(join(root, "a.txt"), T1, T1);
    const refused = await write.execute({ path: "a.txt", content: "mine\n" });
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("changed since your last read");
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("external\n");
    await read.execute({ path: "a.txt" });
    const ok = await write.execute({ path: "a.txt", content: "mine\n" });
    expect(ok.isError).toBeFalsy();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("mine\n");
  });
  it("the written bytes refresh the entry — a following edit passes", async () => {
    const table = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    const write = createWriteFileTool({ workspaceRoot: root, readState: table });
    const edit = createEditTool({ workspaceRoot: root, readState: table });
    await read.execute({ path: "a.txt" });
    await write.execute({ path: "a.txt", content: "alpha beta\n" });
    const res = await edit.execute({ path: "a.txt", old_string: "beta", new_string: "BETA" });
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha BETA\n");
  });
  it("never-read targets are always writable (legacy first-write behavior)", async () => {
    const write = createWriteFileTool({ workspaceRoot: root, readState: createReadStateTable() });
    const res = await write.execute({ path: "fresh.txt", content: "new\n" });
    expect(res.isError).toBeFalsy();
  });
  it("a vanished target (ENOENT) is a plain create, not a staleness error", async () => {
    const table = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState: table });
    const write = createWriteFileTool({ workspaceRoot: root, readState: table });
    const rm2 = await import("node:fs/promises");
    await read.execute({ path: "a.txt" });
    await rm2.rm(join(root, "a.txt"));
    const res = await write.execute({ path: "a.txt", content: "recreated\n" });
    expect(res.isError).toBeFalsy();
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("recreated\n");
  });
});
