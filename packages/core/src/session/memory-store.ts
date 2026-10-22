// ω99-52 (the upstream projectC5 method, wudao contract): the in-memory SessionStore — the
// conformance suite's second backend and the seed for subagent/evals
// in-process sessions. Not a toy: entries are stored as SERIALIZED lines and
// re-validated on read through the same validators as the JSONL load paths
// (a JS caller can push junk through a cast — the skip contract counts it,
// and callers never observe store-internal object aliases); writes serialize
// through one microtask tail per store (the Map-domain twin of the JSONL
// store's promise tail, 夜移 031) so concurrent writers land strictly in
// issue order; sidechains live in a separate Map domain list() never sees;
// and list() orders by LAST write (delete + re-insert), matching the JSONL
// backend's mtime-ascending sort. No byte face: without files, torn tails
// and foreign format versions are not expressible — the conformance suite's
// byteFace/leaseFace capability declaration skips those faces here.
import type { AgentMessage } from "../types.js";
import { isValidAgentMessage, isValidSessionEntry } from "./validate.js";
import type { SessionEntry, SessionStore } from "./store.js";

/** The in-memory SessionStore. An alias for now: the value factory joins the
 *  package-root exports when a consumer (subagent in-process sessions, evals
 *  replay) needs it — ω99-52 keeps the root export surface type-only. */
export type MemorySessionStore = SessionStore;

const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** ω99-58: seed sessions for the in-memory store — externally-held
 *  transcripts (evals replay seeds, subagent in-process sessions) keyed by
 *  the session id they adopt under. Record form is the ergonomic literal;
 *  Map form is the exactness form (no prototype-key edge cases, arbitrary
 *  id strings). Entries are UNTRUSTED input, same law as adoption. */
export type MemorySessionSeedEntries =
  | ReadonlyMap<string, readonly unknown[]>
  | Readonly<Record<string, readonly unknown[]>>;

export function createMemorySessionStore(seedEntries?: MemorySessionSeedEntries): SessionStore {
  // Two domains, one per filename namespace: `<id>` vs `side-<id>`. A
  // top-level session and a sidechain may share a bare id without colliding
  // — the law the JSONL filenames encode on disk.
  const sessions = new Map<string, string[]>();
  // ω99-58 SEEDING: pre-populate top-level sessions from externally-held
  // transcripts. Same law as adoptSessionEntries (pinned equivalent by
  // test): each seed's entries ride the store's own validator — junk is
  // filtered, never thrown — are serialized through the same canonical line
  // form as appendEntry, and land in seed order; a session with no valid
  // entries is not created (the jsonl twin: no file). The skip RECEIPT
  // lives on the adopt path — seeding is the convenience face for callers
  // that do not need adoption accounting.
  if (seedEntries !== undefined) {
    const pairs = seedEntries instanceof Map ? [...seedEntries.entries()] : Object.entries(seedEntries);
    for (const [id, entries] of pairs) {
      if (!SESSION_ID_RE.test(id)) throw new Error(`invalid session id: ${id}`);
      if (id.startsWith("side-")) {
        throw new Error(`session id "${id}" invalid: the side- prefix is reserved for child sidechains`);
      }
      const lines: string[] = [];
      for (const entry of entries) {
        if (isValidSessionEntry(entry)) lines.push(`${JSON.stringify(entry)}\n`);
      }
      if (lines.length > 0) sessions.set(id, lines);
    }
  }
  const sidechains = new Map<string, string[]>();
  let lastLoadSkipped = 0;
  // One promise tail per store: enqueued writers land strictly in issue
  // order (the jobs are synchronous Map ops; the tail is the ordering law).
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue(job: () => void): Promise<void> {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  function appendLine(map: Map<string, string[]>, key: string, line: string, what: string, sideReserved: boolean): Promise<void> {
    if (!SESSION_ID_RE.test(key)) throw new Error(`invalid ${what}: ${key}`);
    if (sideReserved && key.startsWith("side-")) {
      throw new Error(`session id "${key}" invalid: the side- prefix is reserved for child sidechains`);
    }
    return enqueue(() => {
      const lines = map.get(key);
      if (lines === undefined) {
        map.set(key, [line]);
        return;
      }
      lines.push(line);
      // LAST-WRITE recency for list(): re-inserting the key moves it to the
      // Map's end, so iteration order mirrors the JSONL backend's
      // mtime-ascending sort (a touched old session becomes most recent).
      map.delete(key);
      map.set(key, lines);
    });
  }
  /** ω99-80: the plural of appendLine — N lines in ONE tail slot (the Map
   *  domain's batch seam twin; same law as the JSONL backend's
   *  appendEntries). An empty batch is the observable of zero calls: no
   *  session is created. */
  function appendLines(map: Map<string, string[]>, key: string, lines: readonly string[], what: string, sideReserved: boolean): Promise<void> {
    if (!SESSION_ID_RE.test(key)) throw new Error(`invalid ${what}: ${key}`);
    if (sideReserved && key.startsWith("side-")) {
      throw new Error(`session id "${key}" invalid: the side- prefix is reserved for child sidechains`);
    }
    if (lines.length === 0) return Promise.resolve();
    return enqueue(() => {
      const lines0 = map.get(key);
      if (lines0 === undefined) {
        map.set(key, [...lines]);
        return;
      }
      lines0.push(...lines);
      // LAST-WRITE recency for list() — same law as appendLine.
      map.delete(key);
      map.set(key, lines0);
    });
  }
  /** The message view: valid messages in line order, junk skipped+counted —
   *  the same loop shape as the JSONL load paths (validation on read). */
  function messageView(map: Map<string, string[]>, key: string, what: string): Promise<AgentMessage[]> {
    if (!SESSION_ID_RE.test(key)) throw new Error(`invalid ${what}: ${key}`);
    lastLoadSkipped = 0;
    const out: AgentMessage[] = [];
    for (const line of map.get(key) ?? []) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isValidAgentMessage(parsed)) out.push(parsed);
        else if (!isValidSessionEntry(parsed)) lastLoadSkipped += 1;
        // else: a known non-message entry — this view's intentional filter.
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
      }
    }
    return Promise.resolve(out);
  }
  /** The entry view: every valid entry in line order, junk skipped+counted. */
  function entryView(map: Map<string, string[]>, key: string, what: string): Promise<SessionEntry[]> {
    if (!SESSION_ID_RE.test(key)) throw new Error(`invalid ${what}: ${key}`);
    lastLoadSkipped = 0;
    const out: SessionEntry[] = [];
    for (const line of map.get(key) ?? []) {
      try {
        const parsed: unknown = JSON.parse(line);
        if (isValidSessionEntry(parsed)) out.push(parsed);
        else lastLoadSkipped += 1;
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
      }
    }
    return Promise.resolve(out);
  }
  return {
    // async wrappers so validation throws surface as REJECTIONS, exactly like
    // the JSONL backend's async functions (a sync throw is an observable
    // contract difference for `await expect(...).rejects` callers).
    load: async (id) => messageView(sessions, id, "session id"),
    loadSessionEntries: async (id) => entryView(sessions, id, "session id"),
    append: async (id, message) => appendLine(sessions, id, `${JSON.stringify(message)}\n`, "session id", true),
    appendEntry: async (id, entry) => appendLine(sessions, id, `${JSON.stringify(entry)}\n`, "session id", true),
    appendEntries: async (id, entries) => appendLines(
      sessions,
      id,
      entries.map((entry) => `${JSON.stringify(entry)}\n`),
      "session id",
      true,
    ),
    list: async () => [...sessions.keys()],
    loadSidechain: async (id) => messageView(sidechains, id, "sidechain id"),
    appendSidechain: async (id, message) => appendLine(sidechains, id, `${JSON.stringify(message)}\n`, "sidechain id", false),
    loadSidechainEntries: async (id) => entryView(sidechains, id, "sidechain id"),
    appendSidechainEntry: async (id, entry) => appendLine(sidechains, id, `${JSON.stringify(entry)}\n`, "sidechain id", false),
    get lastLoadSkipped() {
      return lastLoadSkipped;
    },
  };
}
