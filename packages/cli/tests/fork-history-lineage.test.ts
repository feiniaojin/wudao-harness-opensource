// 120-a A3 (CodeWhale #6483 形) — the file time-machine's session-lineage
// invariant. Snapshots were bound to the minting session id: a fork mints a
// FRESH id, so its /rewind started empty and every pre-fork snapshot became
// an orphan the branch could never select. The fork seam now inherits the
// parent's catalog by REFERENCE (shallow index copy; the copied lines keep
// their absolute snapshot paths pointing at the parent's blob files — no
// payload rewrite, zero parent bytes moved).
//
// The ω99-314 store (content-addressed blobs + file_snapshot index rows in
// the session JSONL) needs no change — blobs are workspace-global and the
// rows ride the fork's byte-copy — but that property is PINNED here too
// (rows are never filtered by the `run` id).
import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileHistory } from "@wudao/core";
import type { FileHistory } from "@wudao/core";
import { forkSessionFile } from "../src/fork-session.js";
import { snapshotIndexFromEntries } from "../src/snapshots.js";

/** One workspace: sessions/ + history/ siblings (the .wudao layout). */
function workspace(): { root: string; sessionsDir: string; historyRoot: string } {
  const root = mkdtempSync(join(tmpdir(), "wudao-lineage-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  const historyRoot = join(root, "history");
  return { root, sessionsDir: join(root, "sessions"), historyRoot };
}

function writeSessionFile(sessionsDir: string, id: string): void {
  const lines = [
    JSON.stringify({ role: "user", content: "do the work", uuid: "u1" }),
    JSON.stringify({ role: "assistant", content: "done", parentUuid: "u1" }),
  ];
  writeFileSync(join(sessionsDir, `${id}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** A parent with two recorded steps over a.txt: v0 →(1) v1 →(2) v2. */
async function parentWithTwoSteps(
  root: string,
  historyRoot: string,
  id: string,
): Promise<FileHistory> {
  const a = join(root, "a.txt");
  const parent = createFileHistory(join(historyRoot, id));
  writeFileSync(a, "v0", "utf8");
  await parent.record(a, true, "v0", 0, "write_file");
  writeFileSync(a, "v1", "utf8");
  await parent.record(a, true, "v1", 0, "edit");
  writeFileSync(a, "v2", "utf8");
  return parent;
}

const cleanup = (root: string): void => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
};

describe("fork inherits the file-history lineage (120-a A3)", () => {
  it("the fork's /rewind sees the parent's steps and traverses the fork point (reference-style zero-copy)", async () => {
    const { root, sessionsDir, historyRoot } = workspace();
    try {
      const parent = await parentWithTwoSteps(root, historyRoot, "src1");
      writeSessionFile(sessionsDir, "src1");
      const fork = await forkSessionFile(sessionsDir, "src1");
      expect(fork.lineageSteps).toBe(2);
      // The fork's catalog lists the parent's steps…
      const forkHistory = createFileHistory(join(historyRoot, fork.newId));
      const listed = await forkHistory.list();
      expect(listed).toHaveLength(2);
      // …whose snapshot paths still point INTO the parent's dir (the copied
      // lines keep their absolute references — payloads were not copied).
      for (const e of listed) {
        expect(e.snapshot).toContain(join(historyRoot, "src1"));
      }
      expect(readdirSync(join(historyRoot, fork.newId))).toEqual(["index.jsonl"]);
      // Undo across the branch point: rewind to before step 1 restores the
      // pre-fork v0 content, reading the PARENT's snapshot blobs.
      await forkHistory.rewindTo(1);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v0");
      // The truncation hit the FORK's index only — the parent still sees 2.
      expect(await parent.list()).toHaveLength(2);
    } finally {
      cleanup(root);
    }
  });

  it("the fork's own new snapshots land in its own dir and never pollute the parent", async () => {
    const { root, sessionsDir, historyRoot } = workspace();
    try {
      const parent = await parentWithTwoSteps(root, historyRoot, "src2");
      writeSessionFile(sessionsDir, "src2");
      const parentIndexBefore = readFileSync(join(historyRoot, "src2", "index.jsonl"), "utf8");
      const parentDirBefore = readdirSync(join(historyRoot, "src2")).sort();
      const fork = await forkSessionFile(sessionsDir, "src2");
      const forkHistory = createFileHistory(join(historyRoot, fork.newId));
      const b = join(root, "b.txt");
      writeFileSync(b, "b-old", "utf8");
      await forkHistory.record(b, true, "b-old", 0, "write_file");
      writeFileSync(b, "b-new", "utf8");
      // Step 3 landed with its OWN payload in the fork's dir, seq continuing
      // past the inherited catalog.
      const listed = await forkHistory.list();
      expect(listed).toHaveLength(3);
      expect(listed[2]!.seq).toBe(3);
      expect(listed[2]!.snapshot).toContain(join(historyRoot, fork.newId));
      // The parent's catalog bytes and dir contents are byte-identical.
      expect(readFileSync(join(historyRoot, "src2", "index.jsonl"), "utf8")).toBe(parentIndexBefore);
      expect(readdirSync(join(historyRoot, "src2")).sort()).toEqual(parentDirBefore);
      expect(await parent.list()).toHaveLength(2);
    } finally {
      cleanup(root);
    }
  });

  it("the lineage survives a restart (a fresh handle over the same dirs still sees it and can rewind)", async () => {
    const { root, sessionsDir, historyRoot } = workspace();
    try {
      await parentWithTwoSteps(root, historyRoot, "src3");
      writeSessionFile(sessionsDir, "src3");
      const fork = await forkSessionFile(sessionsDir, "src3");
      const liveHandle = createFileHistory(join(historyRoot, fork.newId));
      const b = join(root, "b.txt");
      writeFileSync(b, "b-old", "utf8");
      await liveHandle.record(b, true, "b-old", 0, "write_file");
      writeFileSync(b, "b-new", "utf8");
      // "Restart": brand-new handles over the same on-disk catalogs.
      const restartedFork = createFileHistory(join(historyRoot, fork.newId));
      expect(await restartedFork.list()).toHaveLength(3);
      await restartedFork.rewindTo(3);
      expect(readFileSync(join(root, "b.txt"), "utf8")).toBe("b-old");
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v2");
      const restartedParent = createFileHistory(join(historyRoot, "src3"));
      expect(await restartedParent.list()).toHaveLength(2);
    } finally {
      cleanup(root);
    }
  });

  it("a parent with no lineage forks with 0 steps and no history dir materialized", async () => {
    const { root, sessionsDir, historyRoot } = workspace();
    try {
      writeSessionFile(sessionsDir, "src4");
      const fork = await forkSessionFile(sessionsDir, "src4");
      expect(fork.lineageSteps).toBe(0);
      expect(existsSync(join(historyRoot, fork.newId))).toBe(false);
      // The fork handle works normally from empty.
      const forkHistory = createFileHistory(join(historyRoot, fork.newId));
      expect(await forkHistory.list()).toEqual([]);
    } finally {
      cleanup(root);
    }
  });

  it("a parent rewind AFTER the fork truncates only the parent's catalog — the fork's inherited references stay intact", async () => {
    const { root, sessionsDir, historyRoot } = workspace();
    try {
      const parent = await parentWithTwoSteps(root, historyRoot, "src5");
      writeSessionFile(sessionsDir, "src5");
      const fork = await forkSessionFile(sessionsDir, "src5");
      // The parent rewinds past step 1 (its index truncates; snapshot FILES
      // are never deleted, so the fork's references still resolve).
      await parent.rewindTo(1);
      expect(await parent.list()).toHaveLength(0);
      writeFileSync(join(root, "a.txt"), "v2", "utf8"); // re-stage the fork's view
      const forkHistory = createFileHistory(join(historyRoot, fork.newId));
      expect(await forkHistory.list()).toHaveLength(2);
      await forkHistory.rewindTo(2);
      expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("v1");
    } finally {
      cleanup(root);
    }
  });

  it("ω99-314 pin: file_snapshot index rows ride the fork's byte-copy and are never filtered by the minting run id", async () => {
    const { root, sessionsDir } = workspace();
    try {
      // A source session carrying pre-fork file_snapshot rows (run = the
      // PARENT's id — the CodeWhale #6483 binding shape).
      const shaA = "a".repeat(64);
      const shaB = "b".repeat(64);
      const lines = [
        JSON.stringify({ role: "user", content: "make the deck", uuid: "u1" }),
        JSON.stringify({ type: "file_snapshot", data: { turn: 1, run: "src6", path: "deck.pptx", beforeSha: shaA, afterSha: shaB } }),
        JSON.stringify({ role: "assistant", content: "made it", parentUuid: "u1" }),
      ];
      writeFileSync(join(sessionsDir, "src6.jsonl"), `${lines.join("\n")}\n`, "utf8");
      const fork = await forkSessionFile(sessionsDir, "src6");
      const forkBytes = readFileSync(join(sessionsDir, `${fork.newId}.jsonl`), "utf8");
      // The rows survive the copy verbatim…
      expect(forkBytes).toBe(`${lines.join("\n")}\n`);
      // …and the reader side accepts rows whose run id differs from the
      // fork's new id (blobs are workspace-global; no per-run filtering).
      const rows = snapshotIndexFromEntries(lines.map((l) => JSON.parse(l) as never));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ turn: 1, run: "src6", path: "deck.pptx", beforeSha: shaA, afterSha: shaB });
    } finally {
      cleanup(root);
    }
  });
});
