// M32 §2 — external-change diff construction + the bounded mtime probe.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, utimes, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadStateTable, hashContent, createReadFileTool } from "@wudao-org/core";
import { buildFileChangedNote, buildFileChangedNoSnapshotNote, createExternalChangeProber, unifiedDiffBody, NOTE_CAP_BYTES } from "../src/file-changes.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ws-"));
});
afterEach(async () => { await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

const T0 = new Date("2024-01-01T00:00:00Z");
const T1 = new Date("2024-01-02T00:00:00Z");
const touch = (path: string, when: Date): Promise<void> => utimes(path, when, when);

describe("unifiedDiffBody", () => {
  it("renders a single-line change as one hunk with context", () => {
    const hunks = unifiedDiffBody("a\nb\nc\n", "a\nB\nc\n");
    expect(hunks).toEqual(["@@ -1,3 +1,3 @@\n a\n-b\n+B\n c"]);
  });
  it("renders a pure insertion with a zero-count old range", () => {
    const hunks = unifiedDiffBody("a\nb\n", "a\nX\nb\n");
    expect(hunks).toEqual(["@@ -1,2 +1,3 @@\n a\n+X\n b"]);
  });
  it("splits distant changes into separate hunks", () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = "line 2 CHANGED";
    newLines[17] = "line 18 CHANGED";
    const hunks = unifiedDiffBody(oldLines.join("\n") + "\n", newLines.join("\n") + "\n");
    expect(hunks.length).toBe(2);
    expect(hunks[0]).toContain("@@ -1,5 +1,5 @@");
    expect(hunks[1]).toContain("@@ -15,6 +15,6 @@");
  });
});

describe("buildFileChangedNote", () => {
  it("wraps header + hunks in the file_changed envelope", () => {
    const note = buildFileChangedNote("src/a.ts", "const x = 1;\n", "const x = 2;\n");
    expect(note.startsWith('<file_changed path="src/a.ts">')).toBe(true);
    expect(note.endsWith("</file_changed>")).toBe(true);
    expect(note).toContain("--- a/src/a.ts");
    expect(note).toContain("+++ b/src/a.ts");
    expect(note).toContain("-const x = 1;");
    expect(note).toContain("+const x = 2;");
  });
  it("caps the note at 8KB with a truncation marker", () => {
    const big = (v: string): string => Array.from({ length: 800 }, (_, i) => `${v} payload line number ${i} with plenty of bytes`).join("\n") + "\n";
    const note = buildFileChangedNote("big.txt", big("old"), big("new"));
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(NOTE_CAP_BYTES + 128);
    expect(note).toContain("diff truncated at 8KB");
    expect(note).toContain("-old payload line number 0");
    expect(note.endsWith("</file_changed>")).toBe(true);
  });
});

describe("buildFileChangedNoSnapshotNote", () => {
  it("degrades to a re-read hint + current head", () => {
    const note = buildFileChangedNoSnapshotNote("b.txt", Array.from({ length: 40 }, (_, i) => `l${i}`).join("\n"));
    expect(note).toContain('<file_changed path="b.txt">');
    expect(note).toContain("snapshot not retained");
    expect(note).toContain("1→ l0");
    expect(note).toContain("20→ l19");
    expect(note).not.toContain("21→");
  });
});

describe("createExternalChangeProber", () => {
  it("notes an externally changed file and refreshes the table", async () => {
    const readState = createReadStateTable();
    const p = join(root, "a.txt");
    await writeFile(p, "l1\nl2\n", "utf8");
    await touch(p, T0);
    const read = createReadFileTool({ workspaceRoot: root, readState });
    await read.execute({ path: "a.txt" });
    // External edit + a later mtime.
    await writeFile(p, "l1 CHANGED\nl2\n", "utf8");
    await touch(p, T1);
    const notes: string[] = [];
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain('<file_changed path="a.txt">');
    expect(notes[0]).toContain("-l1");
    expect(notes[0]).toContain("+l1 CHANGED");
    // Table refreshed: the new version counts as read; a second probe is quiet.
    const key = await realpath(p);
    expect(readState.get(key)?.content).toBe("l1 CHANGED\nl2\n");
    expect(readState.get(key)?.mtimeMs).toBe(T1.getTime());
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(1);
  });
  it("probes at most maxFiles per round, round-robin across rounds", async () => {
    const readState = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState });
    for (let i = 1; i <= 7; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `v1-${i}\n`, "utf8");
      await touch(join(root, `f${i}.txt`), T0);
      await read.execute({ path: `f${i}.txt` });
    }
    for (let i = 1; i <= 7; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `v2-${i}\n`, "utf8");
      await touch(join(root, `f${i}.txt`), T1);
    }
    const notes: string[] = [];
    const prober = createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) });
    await prober.probe();
    expect(notes.length).toBe(5);
    await prober.probe();
    expect(notes.length).toBe(7);
    await prober.probe();
    expect(notes.length).toBe(7); // everything refreshed — nothing left to report
  });
  it("stops early when the budget is spent (checked between files)", async () => {
    const readState = createReadStateTable();
    const read = createReadFileTool({ workspaceRoot: root, readState });
    for (let i = 1; i <= 4; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `v1-${i}\n`, "utf8");
      await touch(join(root, `f${i}.txt`), T0);
      await read.execute({ path: `f${i}.txt` });
    }
    for (let i = 1; i <= 4; i += 1) {
      await writeFile(join(root, `f${i}.txt`), `v2-${i}\n`, "utf8");
      await touch(join(root, `f${i}.txt`), T1);
    }
    const notes: string[] = [];
    let ticks = 0;
    const clock = (): number => {
      ticks += 25; // every budget check sees 25ms elapsed (> the 20ms budget)
      return ticks;
    };
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t), now: clock, budgetMs: 20 }).probe();
    expect(notes.length).toBe(1); // one file always gets its turn, then the budget cuts in
  });
  it("a touch without content change refreshes mtime but sends no note", async () => {
    const readState = createReadStateTable();
    const p = join(root, "a.txt");
    await writeFile(p, "stable\n", "utf8");
    await touch(p, T0);
    await createReadFileTool({ workspaceRoot: root, readState }).execute({ path: "a.txt" });
    await touch(p, T1); // mtime moved, bytes identical
    const notes: string[] = [];
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(0);
    const key = await realpath(p);
    expect(readState.get(key)?.mtimeMs).toBe(T1.getTime());
  });
  it("a vanished file is dropped from the table without a note", async () => {
    const readState = createReadStateTable();
    const p = join(root, "gone.txt");
    await writeFile(p, "bye\n", "utf8");
    await createReadFileTool({ workspaceRoot: root, readState }).execute({ path: "gone.txt" });
    const key = await realpath(p);
    await rm(p);
    const notes: string[] = [];
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(0);
    expect(readState.get(key)).toBeUndefined();
  });
  it("entries without a snapshot degrade to the no-snapshot note", async () => {
    const readState = createReadStateTable();
    const p = join(root, "big.txt");
    await writeFile(p, "v1\n", "utf8");
    const key = await realpath(p);
    await touch(p, T0);
    readState.record(key, { contentHash: hashContent("v1\n"), mtimeMs: T0.getTime(), lineCount: 1 });
    await writeFile(p, "v2\n", "utf8");
    await touch(p, T1);
    const notes: string[] = [];
    await createExternalChangeProber({ readState, workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("snapshot not retained");
    expect(notes[0]).toContain("1→ v2");
    expect(readState.get(key)?.content).toBe("v2\n");
  });
  it("an empty table is a no-op", async () => {
    const notes: string[] = [];
    await createExternalChangeProber({ readState: createReadStateTable(), workspaceRoot: root, push: (t) => notes.push(t) }).probe();
    expect(notes.length).toBe(0);
  });
});
