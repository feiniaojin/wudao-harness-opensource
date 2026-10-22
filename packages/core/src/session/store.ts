import { readFile, appendFile, readdir, mkdir, stat, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "../types.js";
// ω99-54: the v7 id shape gate — list()'s partition between the legacy
// mtime tier and the zero-stat v7 string tier.
import { isSessionIdV7 } from "./id.js";
import { isValidAgentMessage, isValidSessionEntry } from "./validate.js";
// ω99-47: the session format gate — soft first-write marker + refuse-to-
// write a newer format version (extractFormatVersion/formatMarkerLine/
// UnsupportedSessionFormatException; see format-version.ts for the design).
import {
  SUPPORTED_FORMAT_VERSION,
  formatMarkerLine,
  extractFormatVersion,
  isFormatMarker,
  UnsupportedSessionFormatException,
} from "./format-version.js";

/** M28: model-state metadata rides the session JSONL as non-message entries —
 *  a model/provider switch or a thinking-level switch, recorded where it
 *  happened. Entries never reach the model; `load()` filters them out. */
export interface ModelChangeEntry {
  readonly type: "model_change";
  readonly model: string;
  readonly provider?: string;
  /** ISO timestamp of the switch. */
  readonly at: string;
}

export interface ThinkingLevelChangeEntry {
  readonly type: "thinking_level_change";
  readonly level: string;
}

/** M63 §A: a PROVIDER switch mid-session — the endpoint identity changed
 *  (baseURL + profile matrix), not just the model name. Same record-where-it-
 *  happened contract as model_change; the JSONL itself stays provider-agnostic
 *  (messages never change across a switch — each provider's request transform
 *  handles replay). */
export interface ProviderChangeEntry {
  readonly type: "provider_change";
  readonly provider: string;
  readonly model: string;
  /** The provider the session ran before the switch, when known. */
  readonly from?: string;
  /** ISO timestamp of the switch. */
  readonly at: string;
}

/** M33 §3: the session's human-facing short name, derived from the first user
 *  message (kebab-case, ≤6 words). Recorded once, never a message — load()
 *  filters it out like the model-state entries.
 *  夜移 005 (the upstream formatsession-title port): `source` names the writer — "derived"
 *  (M33 kebab fallback), "llm" (background title call upgrade), "manual"
 *  (user /rename). The store is append-only and the LAST name entry wins on
 *  read; auto-titling must respect manual renames, hence the tag. Optional
 *  and additive — old files read unchanged. */
export interface SessionNameEntry {
  readonly type: "session_name";
  readonly name: string;
  readonly source?: "derived" | "manual" | "llm";
}

/** M35 §2: a GENERIC non-message entry — any `{type, data}` shape rides the
 *  same JSONL without a store-schema change (first use: the CLI's
 *  `deferred_loaded` receipts). `data` must be present (it is what separates
 *  a well-formed generic entry from a junk line on load); its payload is the
 *  writer's contract, not the store's. Never a message — load() filters it. */
export interface GenericSessionEntry {
  readonly type: string;
  readonly data: unknown;
}

/** One JSONL line of a session file: a message, a model-state/name entry, or
 *  a generic {type, data} entry. */
export type SessionEntry = AgentMessage | ModelChangeEntry | ThinkingLevelChangeEntry | ProviderChangeEntry | SessionNameEntry | GenericSessionEntry;

export interface SessionStore {
  load(sessionId: string): Promise<AgentMessage[]>;
  /** All entries (messages + model-state/name/generic entries) in file
   *  order — the interleaving is the history; forks inherit entries by
   *  copying it. */
  loadSessionEntries(sessionId: string): Promise<SessionEntry[]>;
  append(sessionId: string, message: AgentMessage): Promise<void>;
  /** M35 §2: append a non-message entry — the typed model-state/name
   *  shapes or ANY generic `{type, data}`. Messages never ride this path
   *  for their content, but are accepted (they are entries too). */
  appendEntry(sessionId: string, entry: SessionEntry): Promise<void>;
  /** ω99-80: append MANY entries in ONE serialized write slot — the plural
   *  of appendEntry. Byte-law: one call with N entries leaves the file
   *  exactly as N appendEntry calls would (same first-write marker, same
   *  write gate, same torn-tail repair, same line bytes and order); the
   *  only difference is cost — ONE whole-file read instead of N
   *  (O(filesize+N), not O(N·filesize)). An empty batch writes nothing and
   *  creates no file: the observable of ZERO appendEntry calls. */
  appendEntries(sessionId: string, entries: readonly SessionEntry[]): Promise<void>;
  list(): Promise<string[]>;
  /** M30 §C: a child sidechain's transcript, stored in the SAME root as
   *  `side-<sideId>.jsonl`. Sidechains never appear in `list()` — they are
   *  continuations of a parent run, not top-level sessions. */
  loadSidechain(sideId: string): Promise<AgentMessage[]>;
  appendSidechain(sideId: string, message: AgentMessage): Promise<void>;
  /** ω99-43: the sidechain's ENTRY view — loadSidechainEntries' mirror for
   *  `side-<id>.jsonl`. The message-only `loadSidechain()` above keeps its
   *  return shape unchanged (old readers filter non-message entries out);
   *  consumers that need the interleaved entries (the CLI's durable child
   *  approval receipts) read through THIS variant. */
  loadSidechainEntries(sideId: string): Promise<SessionEntry[]>;
  /** ω99-43: append a non-message entry to a child sidechain (the
   *  sidechain twin of `appendEntry`) — e.g. an approval receipt riding the
   *  M35 §2 generic entry channel. Append-only, same write queue. */
  appendSidechainEntry(sideId: string, entry: SessionEntry): Promise<void>;
  /** ω99-47: how many entries the MOST RECENT load (any of the four load
   *  variants) on this store skipped — unknown entry types plus corrupt (unparseable)
   *  lines. The long-standing "skip what you don't recognize" posture made
   *  observable: silent data loss becomes countable. KNOWN non-message
   *  entries (model-state, receipts, the format marker) are an intentional
   *  filter in the message views and are NOT counted. Reset at the start of
   *  every load call; a store is not thread-safe state, this is a probe. */
  readonly lastLoadSkipped: number;
}

// ω99-279: #1 — SESSION_ID_RE 加 export（零行为改动）：会话 id 的形状门
// 单一事实源——cli 的回收站式删除纯层（session-delete.ts）在路径拼接前
// 用同一枚 RE 做 fail-closed 形状拒（防穿越是它的副产品：`../x` 过不了）。
export const SESSION_ID_RE = /^[A-Za-z0-9_-]+$/;

/** 夜移 031 (the upstream projectsession/jsonl/storage.ts port): a torn-tail verdict — the
 *  byte prefix the file should be healed to. `healTo` is always either ""
 *  or newline-terminated, so a subsequent append can never weld onto it. */
export interface TornTailVerdict {
  readonly healTo: string;
}

/** Diagnose a JSONL transcript for a torn tail. A crash mid-append can only
 *  damage the LAST line, so the file is healable iff the FIRST line whose
 *  JSON syntax is broken is also the LAST non-empty line — anything else is
 *  mid-file corruption, which this store deliberately does NOT rewrite
 *  (rewriting history would lie about what happened; the load-time skip
 *  keeps reading past it instead). A file whose every line parses but whose
 *  final "\n" was lost gets it back: the next appendFile would otherwise
 *  weld two entries onto one line, an unhealable mid-file break. */
export function analyzeTornTail(text: string): TornTailVerdict | undefined {
  if (text === "") return undefined;
  const lines = text.split("\n");
  let firstBad = -1;
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    if (trimmed === "") continue;
    lastNonEmpty = i;
    if (firstBad === -1) {
      try {
        JSON.parse(trimmed);
      } catch {
        firstBad = i;
      }
    }
  }
  if (firstBad !== -1) {
    if (firstBad !== lastNonEmpty) return undefined;
    // Byte offset of the torn line's start: sum of the preceding lines plus
    // their separators — everything before it is the prefix to keep.
    const offset = lines.slice(0, firstBad).reduce((n, l) => n + (l?.length ?? 0) + 1, 0);
    return { healTo: text.slice(0, offset) };
  }
  if (!text.endsWith("\n")) return { healTo: `${text}\n` };
  return undefined;
}

// Append-only JSONL, one file per session under rootDir. Each line = one
// JSON-encoded SessionEntry (messages before M28, plus model-state entries).
export function createJsonlSessionStore(rootDir: string): SessionStore {
  // mkdir is recursive-idempotent but still a syscall per call — once the root
  // exists, skip it for every subsequent append.
  let rootEnsured = false;
  // 夜移 031: every mutation of a session file goes through ONE promise tail
  // per store — concurrent writers (CLI + WS server + cron/monitor tools)
  // land strictly in issue order and never interleave inside a line. The
  // heal re-reads and re-verifies inside its queue slot, so an append that
  // lands between a load's read and its heal can't be lost to a stale
  // verdict (worst case it is rewritten behind the heal in the same slot).
  let tail: Promise<unknown> = Promise.resolve();
  function enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  let writeSeq = 0;
  function tempName(file: string): string {
    writeSeq += 1;
    return `${file}.tmp-${process.pid}-${writeSeq}`;
  }
  // ω99-47: the skip-contract counter — entries the most recent load*
  // dropped (unknown types + corrupt lines). See SessionStore.lastLoadSkipped.
  let lastLoadSkipped = 0;
  async function ensureRoot(): Promise<void> {
    if (!rootEnsured) {
      await mkdir(rootDir, { recursive: true });
      rootEnsured = true;
    }
  }
  /** Atomic publish: temp file in the SAME directory (rename stays on one
   *  volume), then rename over the target. */
  async function tempPublish(file: string, content: string): Promise<void> {
    const tmp = tempName(file);
    await writeFile(tmp, content, "utf8");
    await rename(tmp, file);
  }
  /** Read + heal-if-torn, INSIDE a queue slot so the verdict is never stale.
   *  Best-effort: a heal failure must not break the tail or the load that
   *  scheduled it (the parsed prefix is already a valid answer). */
  async function healSlot(file: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return; // nonexistent or unreadable — nothing to heal
    }
    const verdict = analyzeTornTail(text);
    if (verdict !== undefined) await tempPublish(file, verdict.healTo);
  }
  async function healQuietly(file: string): Promise<void> {
    try {
      await enqueue(() => healSlot(file));
    } catch {
      // healing is best-effort; the skip-on-load semantics still hold
    }
  }
  /** The single write path: never appends onto a torn tail. Fast path (the
   *  common case — healthy file, trailing newline intact) is appendFile as
   *  before; a torn tail or missing newline is repaired in the same slot by
   *  publishing prefix + new line atomically.
   *  ω99-47 adds two guards here, at the ONE point every mutation of a
   *  session/sidechain file passes through (inside the queue slot, so the
   *  verdict is race-safe like the torn-tail one):
   *  - WRITE GATE: a file whose wudao_meta marker names a format version
   *    newer than SUPPORTED_FORMAT_VERSION refuses writes — reads already
   *    returned its data unchanged, and appending onto bytes a newer build
   *    meant differently would corrupt them silently.
   *  - FIRST-WRITE MARKER: an empty/absent file gets the soft marker as
   *    line 1. ONLY there — an existing file is never retro-stamped
   *    (history is not rewritten), and a torn first line is still "existing
   *    content" (the heal path publishes prefix + line, no marker).
   *  ω99-80: the path is the PLURAL writeLines — one read + one gate + one
   *  verdict + one write for a whole batch of lines. writeEntry is its
   *  N=1 form, so the single-entry behavior (gate/torn-tail/heal/marker)
   *  is literally the same code, byte for byte; the batch form exists so
   *  bulk writers (adoptSessionEntries) pay O(filesize+N), not N× the
   *  whole-file read. BYTE LAW: one writeLines call with N lines leaves
   *  the file exactly as N writeEntry calls would — pinned by property
   *  test (omega99-80-batch-write.test.ts). */
  async function writeLines(file: string, lines: readonly string[]): Promise<void> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      text = "";
    }
    const fileVersion = extractFormatVersion(text);
    if (fileVersion !== undefined && fileVersion > SUPPORTED_FORMAT_VERSION) {
      throw new UnsupportedSessionFormatException(fileVersion);
    }
    const verdict = analyzeTornTail(text);
    const body = lines.join("");
    if (verdict === undefined) {
      await appendFile(file, text === "" ? formatMarkerLine() + body : body);
      return;
    }
    await tempPublish(file, verdict.healTo + body);
  }
  async function writeEntry(file: string, line: string): Promise<void> {
    await writeLines(file, [line]);
  }
  async function load(sessionId: string): Promise<AgentMessage[]> {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    lastLoadSkipped = 0;
    const file = join(rootDir, `${sessionId}.jsonl`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    await healQuietly(file);
    const out: AgentMessage[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isValidAgentMessage(parsed)) out.push(parsed);
        // ω99-47: a line that is NEITHER a message NOR any known entry
        // type is an unknown entry — the skip becomes countable. KNOWN
        // non-message entries (model-state, receipts, the format marker)
        // are this view's intentional filter and do not count.
        else if (!isValidSessionEntry(parsed)) lastLoadSkipped += 1;
        // else: skip a structurally invalid line (or a non-message entry)
        // rather than aborting the session
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
        // skip a corrupt line rather than aborting the session
      }
    }
    return out;
  }
  async function loadSessionEntries(sessionId: string): Promise<SessionEntry[]> {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    lastLoadSkipped = 0;
    const file = join(rootDir, `${sessionId}.jsonl`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    await healQuietly(file);
    const out: SessionEntry[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        // ω99-47: line 1 may be the format marker — TRANSPORT FRAMING, not
        // data. Stripped here (not counted, not returned) so a file this
        // build wrote reads identically to the same entries written by a
        // pre-ω99-47 build: zero observable read-path change.
        if (i === 0 && isFormatMarker(parsed)) continue;
        if (isValidSessionEntry(parsed)) out.push(parsed);
        // ω99-47: unknown entry type — skipped per the tolerant posture,
        // now counted (the contract, not a coincidence).
        else lastLoadSkipped += 1;
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
        // skip a corrupt line rather than aborting the session
      }
    }
    return out;
  }
  async function appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    // The `side-` filename prefix belongs to child sidechains (M30 §C);
    // a top-level session with that prefix would collide with
    // `side-<id>.jsonl`. Fail closed on write.
    if (sessionId.startsWith("side-")) throw new Error(`session id "${sessionId}" invalid: the side- prefix is reserved for child sidechains`);
    const file = join(rootDir, `${sessionId}.jsonl`);
    const line = `${JSON.stringify(entry)}\n`;
    await enqueue(async () => {
      await ensureRoot();
      await writeEntry(file, line);
    });
  }
  async function append(sessionId: string, message: AgentMessage): Promise<void> {
    await appendEntry(sessionId, message);
  }
  // ω99-80: the batch write seam — the whole batch rides ONE enqueue slot
  // (no second lock, no second queue), and inside that slot the plural
  // writeLines does one read + one gate + one verdict + one write. Entry
  // serialization happens OUTSIDE the slot, same as appendEntry's — the
  // canonical serializer is the only transform either path applies.
  async function appendEntries(sessionId: string, entries: readonly SessionEntry[]): Promise<void> {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    if (sessionId.startsWith("side-")) throw new Error(`session id "${sessionId}" invalid: the side- prefix is reserved for child sidechains`);
    if (entries.length === 0) return; // zero appendEntry calls' observable: no file, no write
    const file = join(rootDir, `${sessionId}.jsonl`);
    const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`);
    await enqueue(async () => {
      await ensureRoot();
      await writeLines(file, lines);
    });
  }
  async function loadSidechain(sideId: string): Promise<AgentMessage[]> {
    if (!SESSION_ID_RE.test(sideId)) throw new Error(`invalid sidechain id: ${sideId}`);
    lastLoadSkipped = 0;
    const file = join(rootDir, `side-${sideId}.jsonl`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    await healQuietly(file);
    const out: AgentMessage[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isValidAgentMessage(parsed)) out.push(parsed);
        // ω99-47 (same law as load): unknown entry types and corrupt lines
        // are skipped AND counted; known non-message entries are the
        // intentional filter and do not count.
        else if (!isValidSessionEntry(parsed)) lastLoadSkipped += 1;
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
        // skip a corrupt line rather than aborting the sidechain
      }
    }
    return out;
  }
  async function appendSidechain(sideId: string, message: AgentMessage): Promise<void> {
    await appendSidechainEntry(sideId, message);
  }
  // ω99-43: the sidechain entry twins — one write path (the same queue +
  // torn-tail repair as every other mutation), the entries view mirroring
  // loadSessionEntries for `side-<id>.jsonl`.
  async function loadSidechainEntries(sideId: string): Promise<SessionEntry[]> {
    if (!SESSION_ID_RE.test(sideId)) throw new Error(`invalid sidechain id: ${sideId}`);
    lastLoadSkipped = 0;
    const file = join(rootDir, `side-${sideId}.jsonl`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch {
      return [];
    }
    await healQuietly(file);
    const out: SessionEntry[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = (lines[i] ?? "").trim();
      if (!trimmed) continue;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        // ω99-47: line-1 marker strip — same transport-framing rule as
        // loadSessionEntries (side- files, one law).
        if (i === 0 && isFormatMarker(parsed)) continue;
        if (isValidSessionEntry(parsed)) out.push(parsed);
        // ω99-47 (same law as loadSessionEntries): unknown entry types are
        // skipped AND counted — one law for main chain and sidechains.
        else lastLoadSkipped += 1;
      } catch {
        lastLoadSkipped += 1; // corrupt line — same counter
        // skip a corrupt line rather than aborting the sidechain
      }
    }
    return out;
  }
  async function appendSidechainEntry(sideId: string, entry: SessionEntry): Promise<void> {
    if (!SESSION_ID_RE.test(sideId)) throw new Error(`invalid sidechain id: ${sideId}`);
    const file = join(rootDir, `side-${sideId}.jsonl`);
    const line = `${JSON.stringify(entry)}\n`;
    await enqueue(async () => {
      await ensureRoot();
      await writeEntry(file, line);
    });
  }
  async function list(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(rootDir);
    } catch {
      return [];
    }
    // ω99-54 — the THREE-TIER ordering law (was: one mtime sort over every
    // file, an N+1 stat per session just to answer "which is newest"):
    //   1. PARTITION by id shape: v7 (isSessionIdV7 — time-sortable) vs
    //      legacy (8-hex truncations and anything else ever written).
    //   2. Legacy tier: stat-mtime ascending (the old law, unchanged —
    //      legacy ids are NOT time-comparable, so mtime is the only order).
    //   3. v7 tier: id STRING ascending — the 48-bit unix-ms big-endian
    //      prefix plus the same-ms monotone counter make creation order
    //      lexicographic, so this tier costs ZERO stat calls.
    // EPOCH BOUNDARY LAW: every legacy id sorts before every v7 id. The
    // factory's adoption instant IS the epoch — no legacy id can be created
    // after it and no v7 id existed before it — so the boundary needs no
    // timestamp to prove; touching a legacy session later keeps it inside
    // the legacy tier (mtime only reorders WITHIN that tier).
    // CAVEAT (cross-process): two processes sharing a millisecond carry
    // independent counters and clocks — skewed hosts can even invert
    // sub-millisecond order across processes. Per-process same-ms creation
    // order is the guarantee; across milliseconds the timestamp dominates.
    // Sidechain files (`side-*.jsonl`) are child transcripts, not
    // sessions: excluded (unchanged). A missing root still returns [].
    const legacyIds: string[] = [];
    const v7: string[] = [];
    for (const n of names) {
      if (!n.endsWith(".jsonl") || n.startsWith("side-")) continue;
      const id = n.slice(0, -6);
      if (isSessionIdV7(id)) v7.push(id);
      else legacyIds.push(id);
    }
    const legacy = await Promise.all(
      legacyIds.map(async (id) => {
        try {
          const s = await stat(join(rootDir, `${id}.jsonl`));
          return { id, mtimeMs: s.mtimeMs };
        } catch {
          return { id, mtimeMs: 0 }; // raced away — sort it first, not last
        }
      }),
    );
    return [
      ...legacy.sort((a, b) => a.mtimeMs - b.mtimeMs).map((e) => e.id),
      ...v7.sort(),
    ];
  }
  // ω99-47: read-only probe — external writes to it throw (getter-only in
  // strict mode); only the load* functions move it.
  return {
    load,
    loadSessionEntries,
    append,
    appendEntry,
    appendEntries,
    list,
    loadSidechain,
    appendSidechain,
    loadSidechainEntries,
    appendSidechainEntry,
    get lastLoadSkipped() {
      return lastLoadSkipped;
    },
  };
}
