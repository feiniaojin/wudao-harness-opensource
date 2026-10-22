// M32 §1 — per-session read-freshness table. One table per session, shared by
// read_file (records what it saw), edit/write_file (fail-closed freshness gate
// + post-write refresh). The table is plain in-memory state: core stays
// zero-dependency, and the CLI owns creating ONE table per session and handing
// it to every factory (tools + the external-change prober, M32 §2).
import { createHash } from "node:crypto";

/** What the session last saw of a file. The freshness gate compares mtime (and,
 *  when the tool already holds the bytes, the content hash) against this. */
export interface ReadStateEntry {
  /** sha256 of the file content at record time (first 16 hex chars). */
  readonly contentHash: string;
  /** mtimeMs from fs.stat at record time — the primary freshness signal. */
  readonly mtimeMs: number;
  /** Line count of the recorded content (read_file's line convention). */
  readonly lineCount: number;
  /** Content snapshot at record time — the external-change prober's diff
   *  base (M32 §2). Absent for files past SNAPSHOT_CAP_BYTES (hash-only). */
  readonly content?: string;
}

export interface ReadStateTable {
  /** Record (or refresh) what the session last saw for a file. */
  record(absPath: string, entry: ReadStateEntry): void;
  /** The last-seen entry, or undefined when the session never read the file. */
  get(absPath: string): ReadStateEntry | undefined;
  /** All entries, keyed by absolute path, in record order (probe order). */
  entries(): ReadonlyMap<string, ReadStateEntry>;
  /** Drop an entry (e.g. the file vanished). */
  delete(absPath: string): void;
}

/** Snapshot retention cap: read_file already materializes the whole file to
 *  window it, so retaining what it read adds no new peak — but a pathological
 *  file should not squat in session memory forever. Past the cap the entry
 *  keeps hash/mtime/lineCount and the prober degrades to a re-read hint. */
export const SNAPSHOT_CAP_BYTES = 512 * 1024;

/** Stable short content hash (first 16 hex chars of sha256). */
export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** Line count with read_file's convention: a trailing newline does not open a
 *  new (empty) line — "a\nb\n" is 2 lines, "" is 0. */
export function countLines(content: string): number {
  if (content === "") return 0;
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts.length;
}

export function createReadStateTable(): ReadStateTable {
  const table = new Map<string, ReadStateEntry>();
  return {
    record(absPath, entry) {
      table.set(absPath, entry);
    },
    get(absPath) {
      return table.get(absPath);
    },
    entries() {
      return table;
    },
    delete(absPath) {
      table.delete(absPath);
    },
  };
}

/** Build an entry from observed state (called by read_file and by
 *  edit/write_file after they mutate the file). Content past the snapshot cap
 *  is dropped (hash-only entry). */
export function readStateEntry(content: string, mtimeMs: number): ReadStateEntry {
  const keep = Buffer.byteLength(content, "utf8") <= SNAPSHOT_CAP_BYTES;
  return {
    contentHash: hashContent(content),
    mtimeMs,
    lineCount: countLines(content),
    ...(keep ? { content } : {}),
  };
}

/** The fail-closed freshness verdict for a file the session has read.
 *  Returns undefined when fresh (or never read / no table); otherwise the
 *  error text the calling tool should surface verbatim.
 *
 *  mtime is the primary signal (spec: mtime ≠ recorded → refuse). When the
 *  caller already holds the current content (edit does — it must read to
 *  edit), the hash is compared as well: a same-mtime rewrite (editor write in
 *  the same millisecond, cp -p) must not slip through. write_file checks
 *  mtime only — it never needs the old bytes. */
export function freshnessError(
  readState: ReadStateTable | undefined,
  absPath: string,
  currentMtimeMs: number,
  currentContent?: string,
): string | undefined {
  const entry = readState?.get(absPath);
  if (entry === undefined) return undefined;
  if (currentMtimeMs !== entry.mtimeMs) {
    return `file changed since your last read — re-read it (mtime ${entry.mtimeMs} → ${currentMtimeMs})`;
  }
  if (currentContent !== undefined && hashContent(currentContent) !== entry.contentHash) {
    return `file changed since your last read — re-read it (content differs from what you saw)`;
  }
  return undefined;
}
