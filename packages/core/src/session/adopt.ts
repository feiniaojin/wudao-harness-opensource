// ω99-58 (pi C8 mechanism, wudao placement): adopting an EXTERNALLY-HELD
// session transcript — an entries array from a database / server / mirror —
// into a SessionStore as a CONTINUABLE session. Replaying through append()
// cannot do this: the branch-tree choreography (uuid/parentUuid links, fork
// turns, interleave with model-state entries) would have to be reproduced
// call-by-call, and junk rows would have to be pre-filtered by every caller.
// Adoption is one store-layer primitive instead:
//
//  - IDS ARE NEVER RE-MINTED: every adopted entry is written through
//    store.appendEntries as given — the store's canonical serializer is the
//    only transform, so uuid/parentUuid chains ride byte-identically.
//  - ISOLATE-AND-CONTINUE (pi's _loadEntries throws on a bad row): rows the
//    store's own validator rejects are skipped and COUNTED in a receipt —
//    the same tolerant posture as load()'s lastLoadSkipped, made observable
//    at write time so evals/server callers can report adoption quality.
//  - NEVER OVERWRITES (pi's COPYFILE_EXCL file-import law, made assertable
//    at the store layer): adopting into an id the store already lists is a
//    typed SessionAdoptConflictError — the caller mints a fresh v7 id.
//  - FORMAT-MARKER COMPOSITION (ω99-47): an external transcript may carry
//    its own wudao_meta header (position 0 — the read-side law). A header
//    this build supports (version ≤ SUPPORTED_FORMAT_VERSION) is transport
//    framing: stripped, never adopted as data, the store re-stamps its own
//    byte-pinned current marker at first write (pi's no-header branch —
//    "synthesize current version header"; the ≤-supported with-header
//    branch is the same thing, because this format is additive and the
//    no-op "migration" IS stamping current). A header naming a NEWER
//    version composes with the write gate the only lawful way: adoption
//    refuses with UnsupportedSessionFormatException BEFORE anything is
//    written — re-stamping v1 over a v2 claim is exactly the silent
//    corruption the gate exists to prevent, and preserving the foreign
//    marker at line 1 is unreachable through the store's own first-write
//    law (writeEntry stamps the pinned marker on every fresh file).
//
// Concurrency: every write rides the store's own serialized queue — the
// whole valid batch in ONE awaited slot (ω99-80; was one appendEntry per
// entry), in order; no new lock (brief §1.4). The existence check is
// list()-based and advisory under a race, like every other read-then-write
// on this store. The read path is untouched.
import type { SessionEntry, SessionStore } from "./store.js";
import { isValidSessionEntry } from "./validate.js";
import { SUPPORTED_FORMAT_VERSION, isFormatMarker, UnsupportedSessionFormatException } from "./format-version.js";

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** Typed refusal: adoption never overwrites an existing session id (the
 *  store-layer analog of pi's COPYFILE_EXCL import guard). The caller picks
 *  a fresh id itself — newSessionId() is the minter; retry-with-suffix is a
 *  consumer policy, not a store law. */
export class SessionAdoptConflictError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string) {
    super(
      `cannot adopt into session "${sessionId}": the id already exists `
        + `(adoption never overwrites — mint a fresh id with newSessionId() and adopt there)`,
    );
    this.name = "SessionAdoptConflictError";
    this.sessionId = sessionId;
  }
}

/** The adoption receipt: what one call adopted and what it isolated. The
 *  skipped counter is the write-time twin of the store's lastLoadSkipped
 *  probe — same counting law (structurally invalid shapes and unknown entry
 *  types), surfaced so the caller can report adoption quality; a stripped
 *  supported header is framing, not a skip. */
export interface SessionAdoptReceipt {
  readonly sessionId: string;
  readonly adopted: number;
  readonly skipped: number;
}

/** The format version an external transcript's header claims, when its
 *  FIRST entry is a well-formed wudao_meta marker (only position 0 is
 *  header-position — the same law the read path applies to line 1). */
function claimedHeaderVersion(entry: unknown): number | undefined {
  if (!isFormatMarker(entry)) return undefined;
  return (entry as { data: { formatVersion: number } }).data.formatVersion;
}

/** Adopt an externally-held transcript into `store` under `sessionId` as a
 *  continuable session. Entries are untrusted input (validate.ts's law for
 *  on-disk JSONL applies verbatim to off-store transcripts): valid entries
 *  are written in order, invalid ones are isolated and counted. */
export async function adoptSessionEntries(
  store: SessionStore,
  sessionId: string,
  entries: readonly unknown[],
): Promise<SessionAdoptReceipt> {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  if (sessionId.startsWith("side-")) {
    throw new Error(`session id "${sessionId}" invalid: the side- prefix is reserved for child sidechains`);
  }
  // NEVER OVERWRITES: an id the store lists is an existing session (a jsonl
  // file lists however empty; a memory key holds however many lines). list()
  // is the probe BECAUSE it never touches the skip counter — a load* view
  // would reset lastLoadSkipped as an observable side effect.
  if ((await store.list()).includes(sessionId)) throw new SessionAdoptConflictError(sessionId);
  let body: readonly unknown[] = entries;
  const headerVersion = claimedHeaderVersion(entries[0]);
  if (headerVersion !== undefined) {
    if (headerVersion > SUPPORTED_FORMAT_VERSION) throw new UnsupportedSessionFormatException(headerVersion);
    body = entries.slice(1);
  }
  // ω99-80: the valid rows ride ONE store batch slot — O(filesize+N) instead
  // of N whole-file reads. Same receipt law as the per-entry loop this
  // replaced: junk is counted (never thrown), valid rows land in order, and
  // the product is byte-identical (pinned: the batch is the plural of the
  // store's single write path). An all-junk body writes nothing — the loop's
  // zero-appendEntry observable, kept by appendEntries' empty-batch no-op.
  const valid: SessionEntry[] = [];
  let skipped = 0;
  for (const entry of body) {
    if (isValidSessionEntry(entry)) valid.push(entry);
    else skipped += 1; // isolate-and-continue: count, never throw
  }
  if (valid.length > 0) await store.appendEntries(sessionId, valid);
  return { sessionId, adopted: valid.length, skipped };
}
