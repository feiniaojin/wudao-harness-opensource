// M58 §C#5 — --fork-session: `wudao --resume <id> --fork-session` copies the
// session JSONL to a fresh id and resumes the NEW id; the original file is
// never opened for write, so its bytes cannot change. The copy is a raw
// byte-copy (not a re-serialization): uuid/parentUuid links, M28 model-state
// entries, M33 session_name, M52 compact boundaries, and the M53
// active_branch markers all ride over exactly as recorded — the fork starts
// as a byte-identical twin whose future appends diverge onto their own file.
//
// 120-a A3 (a reference harness #6483 形) — the fork ALSO inherits the parent's
// file-history lineage (the M37 per-session time machine under
// .wudao/history/<sessionId>/): without inheritance the fresh id's /rewind
// starts EMPTY and every pre-fork snapshot becomes an orphan the branch can
// never select. Inheritance is a shallow CATALOG copy only — index.jsonl is
// copied into the fork's own history dir, and the copied lines keep their
// ABSOLUTE snapshot paths pointing at the parent's blob files (reference-
// style zero-copy: no snapshot payload is rewritten, no parent byte moves).
// The fork's own new records land in its own dir; the parent's catalog and
// payloads are untouched (no pollution in either direction).
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { newSessionId } from "@wudao/core";

/** Fresh fork id — the core UUIDv7 factory, same seam as every other
 *  session id (ω99-54; there was never a `fork-` prefix convention — the
 *  doc comment pinned "same url-safe shape the CLI's other session ids
 *  use", and v7 keeps that: store-legal, url-safe, and now
 *  time-sortable). A fork is a session CREATED at fork time, so it
 *  rightfully opens in the v7 epoch of list()'s ordering law. */
export function newForkSessionId(): string {
  return newSessionId();
}

/** Review fix (MINOR 2): how many auto-generated ids to try before giving up
 *  (each is 32 bits of hex; the target dir holding this many live collisions
 *  is already pathological). */
const MAX_ID_ATTEMPTS = 8;

export interface ForkSessionResult {
  readonly sourceId: string;
  readonly newId: string;
  /** Copied byte count (the source file's size). */
  readonly bytes: number;
  /** 120-a A3: file-history steps inherited from the parent's catalog
   * (0 = the parent had no lineage, or the inheritance failed fail-open —
   * both keep the pre-arc behavior of an empty fork history). */
  readonly lineageSteps: number;
}

/** 120-a A3 — inherit the parent's file-history catalog: shallow-copy
 * `history/<sourceId>/index.jsonl` → `history/<newId>/index.jsonl`
 * (reference-style zero-copy — see the module header). Returns the number
 * of parseable steps inherited; 0 when the parent has no catalog. Fail-open
 * everywhere: a lineage failure never fails the fork itself. */
async function inheritFileHistoryLineage(historyRoot: string, sourceId: string, newId: string): Promise<number> {
  try {
    let text: string;
    try {
      text = await readFile(join(historyRoot, sourceId, "index.jsonl"), "utf8");
    } catch {
      return 0; // no parent lineage (the source session made no recorded writes)
    }
    let steps = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        if (typeof (JSON.parse(trimmed) as { seq?: unknown }).seq === "number") steps += 1;
      } catch {
        /* corrupt lines ride along uncounted — the load side skips them too */
      }
    }
    if (steps === 0) return 0;
    await mkdir(join(historyRoot, newId), { recursive: true });
    await copyFile(join(historyRoot, sourceId, "index.jsonl"), join(historyRoot, newId, "index.jsonl"));
    return steps;
  } catch {
    return 0; // fail-open: the fork proceeds with an empty time machine (status quo ante)
  }
}

/** Pick the fork's target id. An EXPLICIT id must be free — a collision
 *  throws (the caller asked for that session by name; silently picking
 *  another would fork to the wrong place). An AUTO id regenerates until it
 *  names no existing file (and never the source itself). */
function pickTargetId(
  sessionsDir: string,
  sourceId: string,
  explicitId: string | undefined,
  generateId: () => string,
): string {
  const taken = (id: string): boolean => id === sourceId || existsSync(join(sessionsDir, `${id}.jsonl`));
  if (explicitId !== undefined) {
    if (taken(explicitId)) {
      throw new Error(`cannot fork: session "${explicitId}" already exists under ${sessionsDir}`);
    }
    return explicitId;
  }
  for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt += 1) {
    const id = generateId();
    if (!taken(id)) return id;
  }
  throw new Error(`cannot fork: no free session id after ${MAX_ID_ATTEMPTS} attempts under ${sessionsDir}`);
}

/** Copy `<sessionsDir>/<sourceId>.jsonl` to `<sessionsDir>/<newId>.jsonl`
 *  (byte-for-byte) and return the fork facts. Throws a clean error when the
 *  source session file does not exist, or when the target id is taken (see
 *  pickTargetId). `generateId` is a test seam for the collision path. */
export async function forkSessionFile(
  sessionsDir: string,
  sourceId: string,
  newId?: string,
  generateId: () => string = newForkSessionId,
  opts: { readonly historyRoot?: string } = {},
): Promise<ForkSessionResult> {
  const source = join(sessionsDir, `${sourceId}.jsonl`);
  let bytes: number;
  try {
    bytes = (await stat(source)).size;
  } catch {
    throw new Error(`cannot fork: no session file for "${sourceId}" under ${sessionsDir}`);
  }
  // Exists-check + copyFile is check-then-act: two CONCURRENT forks of the
  // same session racing on the same generated id could still collide — the
  // single-user CLI accepts that (same posture as the history rotation).
  const targetId = pickTargetId(sessionsDir, sourceId, newId, generateId);
  await mkdir(sessionsDir, { recursive: true });
  await copyFile(source, join(sessionsDir, `${targetId}.jsonl`));
  // 120-a A3: the fork's time machine inherits the parent's catalog —
  // shallow copy, reference-style payloads, fail-open. The history root
  // defaults to the .wudao convention (sibling of the sessions dir);
  // opts.historyRoot overrides for non-standard layouts.
  const historyRoot = opts.historyRoot ?? join(dirname(sessionsDir), "history");
  const lineageSteps = await inheritFileHistoryLineage(historyRoot, sourceId, targetId);
  return { sourceId, newId: targetId, bytes, lineageSteps };
}
