// 夜移 027 — notebook 会话内草稿板 (Strands strands-ts notebook, disk-backed).
// The model's working memory: intermediate findings, plan drafts,
// observations to fold into the final answer — WITHOUT polluting the
// user's tree (write_file rides the permission pipeline) or the context
// (compaction stubs old tool results). Disk-backed under .wudao/notebooks
// (the plan.md convention): survives resume, survives compaction,
// user-inspectable. The disk changes the threat model Strands did not
// have — names become paths, so the charset is validated fail-closed.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNotebookTool, NOTEBOOK_MAX_CHARS } from "../src/tools/notebook.js";

let root: string;
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "wudao-notebook-"));
  dir = join(root, ".wudao", "notebooks");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const tool = () => createNotebookTool({ workspaceRoot: root });

describe("notebook tool (夜移 027)", () => {
  it("A: names outside the charset are refused fail-closed (path escape)", async () => {
    const t = tool();
    for (const bad of ["../escape", "a/b", "/abs", "", ".", "..", "a b", "名字", "x".repeat(65)]) {
      const created = await t.execute({ mode: "create", name: bad });
      expect(created.isError, `name ${JSON.stringify(bad)} must be refused`).toBe(true);
    }
    // A valid name still works — the refusal is the charset, not the mode.
    const ok = await t.execute({ mode: "create", name: "draft-1.md" });
    expect(ok.isError).toBeUndefined();
  });

  it("B: create → list → read round trip", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "notes", newStr: "line one\nline two" });
    const list = await t.execute({ mode: "list" });
    expect(list.content).toContain("notes");
    expect(list.content).toContain("2 lines");
    const read = await t.execute({ mode: "read", name: "notes" });
    expect(read.content).toBe("line one\nline two");
  });

  it("C: append joins with a newline when the tail lacks one", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "first" });
    await t.execute({ mode: "append", name: "n", newStr: "second" });
    const read = await t.execute({ mode: "read", name: "n" });
    expect(read.content).toBe("first\nsecond");
    // …and does not double the newline when the tail already ends with one.
    await t.execute({ mode: "append", name: "n", newStr: "third\n" });
    await t.execute({ mode: "append", name: "n", newStr: "fourth" });
    expect((await t.execute({ mode: "read", name: "n" })).content).toBe("first\nsecond\nthird\nfourth");
  });

  it("D: append/write to a notebook that does not exist is an error", async () => {
    const t = tool();
    const r = await t.execute({ mode: "append", name: "ghost", newStr: "x" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("ghost");
  });

  it("E: replace swaps the FIRST occurrence and never interprets $ patterns", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "alpha beta alpha" });
    const r = await t.execute({ mode: "replace", name: "n", oldStr: "alpha", newStr: "$&X" });
    expect(r.isError).toBeUndefined();
    expect((await t.execute({ mode: "read", name: "n" })).content).toBe("$&X beta alpha");
  });

  it("F: replace with a missing oldStr is an error", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "content" });
    const r = await t.execute({ mode: "replace", name: "n", oldStr: "nope", newStr: "y" });
    expect(r.isError).toBe(true);
    expect((await t.execute({ mode: "read", name: "n" })).content).toBe("content");
  });

  it("G: clear empties the notebook; the file stays listable", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "to be cleared" });
    const r = await t.execute({ mode: "clear", name: "n" });
    expect(r.isError).toBeUndefined();
    const read = await t.execute({ mode: "read", name: "n" });
    expect(read.content).toContain("empty");
    const list = await t.execute({ mode: "list" });
    expect(list.content).toContain("n");
  });

  it("H: an append that would exceed the cap is refused with the cap named; content unchanged", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "x".repeat(NOTEBOOK_MAX_CHARS - 5) });
    const over = await t.execute({ mode: "append", name: "n", newStr: "yyyyyyyyyy" });
    expect(over.isError).toBe(true);
    expect(over.content).toContain(String(NOTEBOOK_MAX_CHARS));
    const read = await t.execute({ mode: "read", name: "n" });
    expect(read.content.length).toBe(NOTEBOOK_MAX_CHARS - 5);
  });

  it("I: risk annotations — writable, not concurrency-safe, not open-world, destructive on create/clear", () => {
    const t = tool();
    expect(t.isReadOnly?.({ mode: "read" })).toBe(false);
    expect(t.isConcurrencySafe?.({ mode: "append" })).toBe(false);
    expect(t.isOpenWorld?.({ mode: "append" })).toBe(false);
    expect(t.isDestructive?.({ mode: "clear" })).toBe(true);
    expect(t.isDestructive?.({ mode: "create" })).toBe(true);
    expect(t.isDestructive?.({ mode: "append" })).toBe(false);
  });

  it("J: create REPLACES existing content (Strands semantic)", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "old draft" });
    await t.execute({ mode: "create", name: "n", newStr: "fresh draft" });
    expect((await t.execute({ mode: "read", name: "n" })).content).toBe("fresh draft");
  });

  it("K: reading a never-created notebook is an error; an empty one says so", async () => {
    const t = tool();
    const ghost = await t.execute({ mode: "read", name: "ghost" });
    expect(ghost.isError).toBe(true);
    await t.execute({ mode: "create", name: "blank" });
    const empty = await t.execute({ mode: "read", name: "blank" });
    expect(empty.isError).toBeUndefined();
    expect(empty.content).toContain("empty");
  });

  it("L: list with no notebooks yet says so (no implicit default notebook)", async () => {
    const t = tool();
    const list = await t.execute({ mode: "list" });
    expect(list.isError).toBeUndefined();
    expect(list.content).toContain("No notebooks");
    // And no notebook files materialized on disk.
    const entries = await readdir(dir).catch(() => [] as string[]);
    expect(entries).toEqual([]);
  });

  it("M: the notebook lands on disk as a plain file the user can inspect", async () => {
    const t = tool();
    await t.execute({ mode: "create", name: "n", newStr: "on disk" });
    const raw = await readFile(join(dir, "n.md"), "utf8");
    expect(raw).toBe("on disk");
  });
});
