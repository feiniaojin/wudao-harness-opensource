// M37 §2 — file-history snapshots + /rewind. Every successful write_file/edit
// records the file's PRE-write state (snapshot file + index line) under
// .wudao/history/<session>/; rewindTo(n) restores the workspace to before
// step n by undoing steps >= n in reverse order (a create is undone by
// deleting the file).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHistory } from "../src/tools/file-history.js";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";
import { createReadStateTable } from "../src/tools/read-state.js";
import { resolveWorkspacePath } from "../src/tools/workspace.js";

let dir: string;
let ws: string;
let histDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "wudao-hist-"));
  ws = join(dir, "ws");
  histDir = join(ws, ".wudao", "history", "sess1");
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("createFileHistory (index + snapshots)", () => {
  it("record stores the pre-write snapshot as <seq>-<basename> and appends an index line with mtime+hash", async () => {
    const target = join(ws, "a.txt");
    await writeFile(target, "old-a\n", "utf8");
    const h = createFileHistory(histDir);
    const st = await stat(target);
    const seq = await h.record(target, true, "old-a\n", st.mtimeMs, "write_file");
    expect(seq).toBe(1);
    expect(await readFile(join(histDir, "1-a.txt"), "utf8")).toBe("old-a\n");
    const index = (await readFile(join(histDir, "index.jsonl"), "utf8")).trim().split("\n");
    expect(index).toHaveLength(1);
    const line = JSON.parse(index[0] ?? "") as Record<string, unknown>;
    expect(line["seq"]).toBe(1);
    expect(line["file"]).toBe(target);
    expect(line["op"]).toBe("write_file");
    expect(line["existed"]).toBe(true);
    expect(typeof line["mtimeMs"]).toBe("number");
    expect(line["hash"]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("a create records existed=false with NO snapshot file", async () => {
    const target = join(ws, "new.txt");
    const h = createFileHistory(histDir);
    await h.record(target, false, undefined, 0, "write_file");
    expect(existsSync(join(histDir, "1-new.txt"))).toBe(false);
    const entries = await h.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.existed).toBe(false);
  });

  it("seq is monotonic across records and list() returns them in order", async () => {
    const h = createFileHistory(histDir);
    expect(await h.record(join(ws, "a"), true, "x", 1, "edit")).toBe(1);
    expect(await h.record(join(ws, "b"), true, "y", 2, "write_file")).toBe(2);
    expect(await h.record(join(ws, "c"), false, undefined, 0, "write_file")).toBe(3);
    expect((await h.list()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("reopening the same dir sees the earlier entries (resume)", async () => {
    const target = join(ws, "a.txt");
    await writeFile(target, "v1\n", "utf8");
    const h1 = createFileHistory(histDir);
    await h1.record(target, true, "v1\n", 1, "write_file");
    const h2 = createFileHistory(histDir);
    expect(await h2.record(join(ws, "b"), false, undefined, 0, "write_file")).toBe(2);
    expect((await h2.list()).map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe("rewindTo", () => {
  it("three steps over two files, rewind to step 2 → state from before step 2 (steps 3 and 2 undone)", async () => {
    const a = join(ws, "a.txt");
    const b = join(ws, "b.txt");
    await writeFile(a, "a-v1\n", "utf8");
    const h = createFileHistory(histDir);
    // Step 1: a → v2. Step 2: a → v3. Step 3: create b.
    await h.record(a, true, "a-v1\n", 1, "write_file");
    await writeFile(a, "a-v2\n", "utf8");
    await h.record(a, true, "a-v2\n", 2, "edit");
    await writeFile(a, "a-v3\n", "utf8");
    await h.record(b, false, undefined, 0, "write_file");
    await writeFile(b, "b-v1\n", "utf8");

    const undone = await h.rewindTo(2);
    // Applied in REVERSE order: step 3 first (the create → deleted), then 2.
    expect(undone.map((e) => e.seq)).toEqual([3, 2]);
    expect(await readFile(a, "utf8")).toBe("a-v2\n"); // back to after step 1
    expect(existsSync(b)).toBe(false); // the create was undone
    // The index was truncated to steps < 2; the next write continues at 2.
    expect((await h.list()).map((e) => e.seq)).toEqual([1]);
    expect(await h.record(a, true, "a-v2\n", 9, "edit")).toBe(2);
  });

  it("rewind last = exactly the most recent step", async () => {
    const a = join(ws, "a.txt");
    await writeFile(a, "v1\n", "utf8");
    const h = createFileHistory(histDir);
    await h.record(a, true, "v1\n", 1, "write_file");
    await writeFile(a, "v2\n", "utf8");
    await h.record(a, true, "v2\n", 2, "write_file");
    await writeFile(a, "v3\n", "utf8");
    const undone = await h.rewindTo(2);
    expect(undone.map((e) => e.seq)).toEqual([2]);
    expect(await readFile(a, "utf8")).toBe("v2\n");
  });

  it("rewind to 1 undoes everything; rewind past the end is an error", async () => {
    const a = join(ws, "a.txt");
    await writeFile(a, "v1\n", "utf8");
    const h = createFileHistory(histDir);
    await h.record(a, true, "v1\n", 1, "write_file");
    await writeFile(a, "v2\n", "utf8");
    const undone = await h.rewindTo(1);
    expect(undone.map((e) => e.seq)).toEqual([1]);
    expect(await readFile(a, "utf8")).toBe("v1\n");
    await expect(h.rewindTo(1)).rejects.toThrow(/no step 1/i);
  });

  it("a missing snapshot fails closed (no silent skip)", async () => {
    const a = join(ws, "a.txt");
    await writeFile(a, "v1\n", "utf8");
    const h = createFileHistory(histDir);
    await h.record(a, true, "v1\n", 1, "write_file");
    await writeFile(a, "v2\n", "utf8");
    await rm(join(histDir, "1-a.txt"), { force: true });
    await expect(h.rewindTo(1)).rejects.toThrow(/snapshot/i);
  });
});

describe("write_file/edit integration (snapshot before the successful write)", () => {
  it("write_file snapshots the overwritten content; a CREATE records existed=false", async () => {
    const readState = createReadStateTable();
    const a = join(ws, "a.txt");
    await writeFile(a, "old\n", "utf8");
    const h = createFileHistory(histDir);
    const write = createWriteFileTool({ workspaceRoot: ws, ...(readState ? { readState } : {}), history: h });
    const r1 = await write.execute({ path: "a.txt", content: "new\n" });
    expect(r1.isError).not.toBe(true);
    const r2 = await write.execute({ path: "made.txt", content: "fresh\n" });
    expect(r2.isError).not.toBe(true);
    const entries = await h.list();
    expect(entries.map((e) => [e.seq, e.op, e.existed])).toEqual([[1, "write_file", true], [2, "write_file", false]]);
    expect(await readFile(join(histDir, "1-a.txt"), "utf8")).toBe("old\n");
  });

  it("edit snapshots the pre-edit content it already read", async () => {
    const readState = createReadStateTable();
    const a = join(ws, "a.txt");
    await writeFile(a, "alpha\nbeta\n", "utf8");
    const h = createFileHistory(histDir);
    const edit = createEditTool({ workspaceRoot: ws, readState, history: h });
    const r = await edit.execute({ path: "a.txt", old_string: "beta", new_string: "gamma" });
    expect(r.isError).not.toBe(true);
    expect(await readFile(join(histDir, "1-a.txt"), "utf8")).toBe("alpha\nbeta\n");
    expect((await h.list())[0]?.op).toBe("edit");
  });

  it("a FAILED write/edit (freshness refusal, bad match) records NOTHING", async () => {
    const readState = createReadStateTable();
    const a = join(ws, "a.txt");
    await writeFile(a, "stale\n", "utf8");
    const h = createFileHistory(histDir);
    // Simulate a read-state entry with an older mtime → freshness failure
    // (keyed by the RESOLVED path — the tools resolve symlinks).
    const resolved = await resolveWorkspacePath(ws, "a.txt");
    expect(resolved.ok).toBe(true);
    const key = resolved.ok ? resolved.absPath : a;
    readState.record(key, { contentHash: "x", mtimeMs: 1, lineCount: 1 });
    const write = createWriteFileTool({ workspaceRoot: ws, readState, history: h });
    const rw = await write.execute({ path: "a.txt", content: "nope\n" });
    expect(rw.isError).toBe(true);
    const edit = createEditTool({ workspaceRoot: ws, readState: createReadStateTable(), history: h });
    const re = await edit.execute({ path: "a.txt", old_string: "absent", new_string: "x" });
    expect(re.isError).toBe(true);
    expect(await h.list()).toHaveLength(0);
    expect(existsSync(histDir)).toBe(false); // nothing ever recorded → no dir created by the tools
  });
});
