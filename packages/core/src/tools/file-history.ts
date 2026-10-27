// M37 §2 — harness-side file-change snapshots. Every SUCCESSFUL write_file /
// edit first records the target's PRE-write state under
// <workspaceRoot>/.wudao/history/<sessionId>/:
//   * the old bytes at `<seq>-<basename>` (only when the file existed),
//   * one append-only index line (seq/file/op/existed/mtimeMs/hash/at) in
//     index.jsonl.
// rewindTo(n) restores the workspace to BEFORE step n by undoing every step
// >= n in REVERSE order (an undone create deletes the file) and truncating
// the index — the next write continues at seq n, so the listed history is
// always live. The recorder is deliberately fail-open for the WRITE path (a
// snapshot failure never blocks a write; that step just has no rewind), and
// fail-closed for the REWIND path (a missing snapshot is an error, never a
// silent skip).
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { hashContent } from "./read-state.js";

/** The tool that produced a step. */
export type FileHistoryOp = "write_file" | "edit";

export interface FileHistoryEntry {
  readonly seq: number;
  /** Absolute path of the written file. */
  readonly file: string;
  readonly op: FileHistoryOp;
  /** false → the write CREATED the file (no snapshot; rewind deletes it). */
  readonly existed: boolean;
  /** Snapshot path (set only when existed). */
  readonly snapshot?: string;
  /** Pre-write mtimeMs (0 for creates). */
  readonly mtimeMs: number;
  /** Pre-write content hash (empty for creates). */
  readonly hash: string;
  /** ISO timestamp of the record. */
  readonly at: string;
}

export interface FileHistory {
  /** Record the pre-write state of one file; returns the step's seq. */
  record(absPath: string, existed: boolean, content: string | undefined, mtimeMs: number, op: FileHistoryOp): Promise<number>;
  /** All recorded steps, in order (loads the persisted index on first use —
   *  a resumed session sees its earlier steps). */
  list(): Promise<readonly FileHistoryEntry[]>;
  /** Undo steps >= n in reverse order (workspace = state before step n) and
   *  truncate the index. Returns the undone entries in APPLIED order.
   *  Throws when step n does not exist or a snapshot is missing. */
  rewindTo(n: number): Promise<readonly FileHistoryEntry[]>;
}

interface IndexLine extends FileHistoryEntry {}

const INDEX_NAME = "index.jsonl";

export function createFileHistory(dir: string): FileHistory {
  // Lazy state: loaded from the persisted index on first use, then kept in
  // memory (record/list/rewind all run through it). `entries` is the truth
  // after the first load; `nextSeq` continues past the last line.
  let entries: readonly IndexLine[] | undefined;
  let nextSeq = 1;

  const load = async (): Promise<readonly IndexLine[]> => {
    if (entries !== undefined) return entries;
    let text: string;
    try {
      text = await readFile(join(dir, INDEX_NAME), "utf8");
    } catch {
      entries = [];
      return entries;
    }
    const out: IndexLine[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        if (
          typeof parsed["seq"] === "number" && typeof parsed["file"] === "string" &&
          (parsed["op"] === "write_file" || parsed["op"] === "edit") && typeof parsed["existed"] === "boolean"
        ) {
          out.push({
            seq: parsed["seq"],
            file: parsed["file"],
            op: parsed["op"],
            existed: parsed["existed"],
            ...(typeof parsed["snapshot"] === "string" ? { snapshot: parsed["snapshot"] } : {}),
            mtimeMs: typeof parsed["mtimeMs"] === "number" ? parsed["mtimeMs"] : 0,
            hash: typeof parsed["hash"] === "string" ? parsed["hash"] : "",
            at: typeof parsed["at"] === "string" ? parsed["at"] : "",
          });
        }
      } catch {
        // skip a corrupt line rather than aborting the history
      }
    }
    nextSeq = (out[out.length - 1]?.seq ?? 0) + 1;
    entries = out;
    return entries;
  };

  return {
    async record(absPath, existed, content, mtimeMs, op) {
      const all = await load();
      const seq = nextSeq;
      const entry: IndexLine = existed
        ? {
            seq,
            file: absPath,
            op,
            existed: true,
            snapshot: join(dir, `${seq}-${basename(absPath)}`),
            mtimeMs,
            hash: hashContent(content ?? ""),
            at: new Date().toISOString(),
          }
        : { seq, file: absPath, op, existed: false, mtimeMs: 0, hash: "", at: new Date().toISOString() };
      if (existed) {
        await mkdir(dir, { recursive: true });
        await writeFile(entry.snapshot as string, content ?? "", "utf8");
      }
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, INDEX_NAME), `${JSON.stringify(entry)}\n`);
      entries = [...all, entry];
      nextSeq = seq + 1;
      return seq;
    },

    async list() {
      return load();
    },

    async rewindTo(n) {
      const all = await load();
      const idx = all.findIndex((e) => e.seq === n);
      if (idx === -1) {
        const last = all[all.length - 1]?.seq ?? 0;
        throw new Error(`no step ${n} to rewind to (recorded steps: ${all.length === 0 ? "none" : `1..${last}`})`);
      }
      const undone = all.slice(idx).reverse();
      for (const e of undone) {
        if (e.existed) {
          let content: string | undefined;
          if (e.snapshot !== undefined) content = await readFile(e.snapshot, "utf8").catch(() => undefined);
          if (content === undefined) {
            throw new Error(`snapshot missing for step ${e.seq} (${e.snapshot ?? "no snapshot path"}) — cannot rewind`);
          }
          await writeFile(e.file, content, "utf8");
        } else {
          await rm(e.file, { force: true });
        }
      }
      // Truncate the index to the surviving steps: the listed history stays
      // live and the next write reuses seq n.
      const kept = all.slice(0, idx);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, INDEX_NAME),
        kept.map((e) => JSON.stringify(e)).join("\n") + (kept.length > 0 ? "\n" : ""),
        "utf8",
      );
      entries = kept;
      nextSeq = n;
      return undone;
    },
  };
}
