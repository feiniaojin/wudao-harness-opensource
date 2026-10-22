// 夜移 032 — the per-run net file-change ledger (the upstream projectturn_diff_tracker.rs
// port). Five sequential edits to one file today leave five receipts and no
// answer to "what did THIS run actually change?" — the tracker keeps the
// the upstream projectbaseline/current algebra: per file, the FIRST write's pre-state is
// the baseline and the LAST write's bytes are the current, so the run's net
// diff is one before→after pair no matter how many writes landed. Scope v1:
// write_file/edit at the top-level session (child sidechains and bookkeeping
// workspaces excluded — the deliberate divergence from the upstream project's multi-
// environment merge); shell mutations are outside (M32's prober owns
// external change observation).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTurnDiffTracker } from "../src/turn-diff.js";

describe("夜移 032 turn-diff tracker", () => {
  it("keeps the FIRST write's pre-state as baseline and the LAST write's bytes as current", () => {
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "one", "two");
    t.record("/w/a.ts", "two", "three");
    t.record("/w/a.ts", "three", "four");
    const files = t.files();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "/w/a.ts", before: "one", after: "four", writes: 3 });
  });

  it("classifies a file whose first write was a create as created (baseline stays undefined)", () => {
    const t = createTurnDiffTracker();
    t.record("/w/new.ts", undefined, "v1");
    t.record("/w/new.ts", "v1", "v2");
    const f = t.files()[0];
    expect(f?.before).toBeUndefined();
    expect(f?.after).toBe("v2");
    expect(f?.op).toBe("created");
    expect(f?.writes).toBe(2);
  });

  it("modified classification for an existing file's first write", () => {
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "old", "new");
    expect(t.files()[0]?.op).toBe("modified");
  });

  it("resetRun clears the ledger for the next run", () => {
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "old", "new");
    t.resetRun();
    expect(t.files()).toHaveLength(0);
    // and the next run's baseline is fresh (the previous run's result is the
    // new baseline, not carried over)
    t.record("/w/a.ts", "new", "newer");
    expect(t.files()[0]).toMatchObject({ before: "new", after: "newer", writes: 1 });
  });

  it("files() is sorted by path (deterministic — no insertion-order leak)", () => {
    const t = createTurnDiffTracker();
    t.record("/w/z.ts", "a", "b");
    t.record("/w/a.ts", "a", "b");
    t.record("/w/m.ts", "a", "b");
    expect(t.files().map((f) => f.path)).toEqual(["/w/a.ts", "/w/m.ts", "/w/z.ts"]);
  });

  it("distinct paths accumulate independently", () => {
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "a", "b");
    t.record("/w/b.ts", undefined, "x");
    t.record("/w/a.ts", "b", "c");
    const byPath = new Map(t.files().map((f) => [f.path, f]));
    expect(byPath.get("/w/a.ts")).toMatchObject({ before: "a", after: "c", writes: 2 });
    expect(byPath.get("/w/b.ts")).toMatchObject({ before: undefined, after: "x", writes: 1, op: "created" });
  });

  it("an identical-net write (before === after) is still listed — the evidence that a run rewrote bytes to the same content", () => {
    const t = createTurnDiffTracker();
    t.record("/w/a.ts", "same", "same");
    const f = t.files()[0];
    expect(f?.before).toBe("same");
    expect(f?.after).toBe("same");
    expect(f?.writes).toBe(1);
  });
});

// —— tool seams: write_file / edit report committed mutations ——

import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteFileTool } from "../src/tools/write-file.js";
import { createEditTool } from "../src/tools/edit.js";
import type { Tool } from "../src/tool.js";

let wsRoot: string;
const exec = async (tool: Tool, args: Record<string, unknown>) => {
  const r = await tool.execute(args, { toolCallId: "t", abort: new AbortController().signal } as Parameters<Tool["execute"]>[1]);
  return r;
};

describe("夜移 032 tool seams", () => {
  beforeEach(async () => { wsRoot = await mkdtemp(join(tmpdir(), "td-")); });
  afterEach(async () => { await rm(wsRoot, { recursive: true, force: true }); });

  it("write_file records a create (before undefined) and an overwrite (pre-state baseline)", async () => {
    const t = createTurnDiffTracker();
    const w = createWriteFileTool({ workspaceRoot: wsRoot, turnDiff: t });
    await exec(w, { path: "a.ts", content: "v1" });
    await exec(w, { path: "a.ts", content: "v2" });
    const f = t.files()[0];
    expect(f).toMatchObject({ op: "created", before: undefined, after: "v2", writes: 2 });
  });

  it("edit records the pre-edit bytes as baseline and the post-edit bytes as current", async () => {
    const t = createTurnDiffTracker();
    await writeFile(join(wsRoot, "b.ts"), "line1\n", "utf8");
    const e = createEditTool({ workspaceRoot: wsRoot, turnDiff: t });
    const r = await exec(e, { path: "b.ts", old_string: "line1", new_string: "line2" });
    expect(r.isError).toBeFalsy();
    const f = t.files()[0];
    expect(f).toMatchObject({ op: "modified", before: "line1\n", after: "line2\n", writes: 1 });
  });

  it("a FAILED edit (no match) records nothing — only committed writes are evidence", async () => {
    const t = createTurnDiffTracker();
    await writeFile(join(wsRoot, "c.ts"), "keep\n", "utf8");
    const e = createEditTool({ workspaceRoot: wsRoot, turnDiff: t });
    const r = await exec(e, { path: "c.ts", old_string: "absent", new_string: "x" });
    expect(r.isError).toBe(true);
    expect(t.files()).toHaveLength(0);
  });

  it("an overwrite whose pre-read fails is skipped, not falsely classified as a create", async () => {
    const t = createTurnDiffTracker();
    const w = createWriteFileTool({ workspaceRoot: wsRoot, turnDiff: t });
    // make the target a directory: stat succeeds (exists) but readFile fails
    await mkdir(join(wsRoot, "odd"));
    const r = await exec(w, { path: "odd", content: "x" });
    expect(r.isError).toBe(true); // writeFile onto a directory fails
    expect(t.files()).toHaveLength(0);
  });

  it("the same run's write_file + edit on one path collapse to one net entry", async () => {
    const t = createTurnDiffTracker();
    const w = createWriteFileTool({ workspaceRoot: wsRoot, turnDiff: t });
    await exec(w, { path: "d.ts", content: "one\n" });
    const e = createEditTool({ workspaceRoot: wsRoot, turnDiff: t });
    await exec(e, { path: "d.ts", old_string: "one", new_string: "two" });
    const f = t.files();
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ op: "created", before: undefined, after: "two\n", writes: 2 });
  });
});
