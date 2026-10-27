import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newRunId,
  journalFilePath,
  openJournal,
  loadJournal,
  type JournalRecord,
} from "../src/workflow/journal.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-journal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("newRunId", () => {
  it("formats as wf-<timestamp>-<rand> with distinct randoms for the same instant", () => {
    const now = new Date("2026-08-15T10:15:30.000Z");
    const a = newRunId(now);
    const b = newRunId(now);
    expect(a).toMatch(/^wf-20260815T101530Z-[0-9a-f]+$/);
    expect(b).toMatch(/^wf-20260815T101530Z-[0-9a-f]+$/);
    expect(a).not.toBe(b);
  });
});

describe("journal append/load round-trip", () => {
  it("creates the .wudao/workflows dir on first append and writes one JSON per line", async () => {
    const runId = newRunId();
    const path = journalFilePath(dir, runId);
    const journal = openJournal(path);
    const started: JournalRecord = { type: "run-started", runId, workflow: "demo", startedAt: new Date().toISOString() };
    await journal.append(started);
    expect(existsSync(join(dir, ".wudao", "workflows"))).toBe(true);

    await journal.append({ type: "step-started", id: "s1" });
    await journal.append({ type: "step-finished", id: "s1", ok: true, finalText: "done", toolsUsed: ["read_file", "read_file", "grep"], endedAt: new Date().toISOString() });
    await journal.append({ type: "step-started", id: "s2" });
    await journal.append({ type: "step-finished", id: "s2", ok: false, finalText: "", toolsUsed: [], endedAt: new Date().toISOString() });
    await journal.append({ type: "run-finished", ok: false });

    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(6);
    expect(JSON.parse(lines[0]!)).toEqual(started);
    const finished = JSON.parse(lines[2]!);
    expect(finished).toMatchObject({ type: "step-finished", id: "s1", ok: true, finalText: "done" });
    // toolsUsed preserved verbatim (dedup is the runner's job, not the journal's)
    expect(finished.toolsUsed).toEqual(["read_file", "read_file", "grep"]);
  });

  it("loadJournal returns every record and the ok-step map for resume", async () => {
    const path = journalFilePath(dir, newRunId());
    const journal = openJournal(path);
    await journal.append({ type: "run-started", runId: "r", workflow: "w", startedAt: "t0" });
    await journal.append({ type: "step-started", id: "s1" });
    await journal.append({ type: "step-finished", id: "s1", ok: true, finalText: "out1", toolsUsed: ["read_file"], endedAt: "t1" });
    await journal.append({ type: "step-started", id: "s2" });
    await journal.append({ type: "step-finished", id: "s2", ok: true, finalText: "out2", toolsUsed: [], endedAt: "t2" });
    await journal.append({ type: "step-started", id: "s3" });
    await journal.append({ type: "step-finished", id: "s3", ok: false, finalText: "", toolsUsed: [], endedAt: "t3" });

    const loaded = loadJournal(path);
    expect(loaded.records).toHaveLength(7);
    expect([...loaded.finishedOk.keys()].sort()).toEqual(["s1", "s2"]);
    expect(loaded.finishedOk.get("s1")?.finalText).toBe("out1");
    expect(loaded.finishedOk.has("s3")).toBe(false);
  });

  it("loadJournal on a missing file returns empty (caller decides if that is an error)", () => {
    const loaded = loadJournal(join(dir, "nope.jsonl"));
    expect(loaded.records).toEqual([]);
    expect(loaded.finishedOk.size).toBe(0);
  });

  it("resume listing after a truncated run: only steps BEFORE the failure are listed", async () => {
    // Simulate a crash: journal has s1 ok, s2 started-but-never-finished.
    const path = journalFilePath(dir, newRunId());
    const journal = openJournal(path);
    await journal.append({ type: "run-started", runId: "r", workflow: "w", startedAt: "t0" });
    await journal.append({ type: "step-started", id: "s1" });
    await journal.append({ type: "step-finished", id: "s1", ok: true, finalText: "out1", toolsUsed: [], endedAt: "t1" });
    await journal.append({ type: "step-started", id: "s2" });

    const loaded = loadJournal(path);
    expect([...loaded.finishedOk.keys()]).toEqual(["s1"]);
    // A resumed run appends AFTER the truncated s2 record — journal stays append-only.
    await journal.append({ type: "step-started", id: "s2" });
    const again = loadJournal(path);
    expect(again.records).toHaveLength(5);
    expect(again.finishedOk.get("s1")?.finalText).toBe("out1");
  });

  it("skips blank trailing lines (crash mid-write)", async () => {
    const path = journalFilePath(dir, newRunId());
    mkdirSync(join(dir, ".wudao", "workflows"), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: "run-started", runId: "r", workflow: "w", startedAt: "t0" }) + "\n\n");
    const loaded = loadJournal(path);
    expect(loaded.records).toHaveLength(1);
  });
});
