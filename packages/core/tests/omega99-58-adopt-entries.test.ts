// ω99-58 — acceptance tests: adopting an EXTERNALLY-HELD session transcript
// (an entries array from a database / server / mirror) into a SessionStore
// as a CONTINUABLE session (brief §2:
// .superpowers/sdd/2026-09-01-newref/omega99-58-adopt-entries-brief.md).
// The backend-agnostic laws (continuation, isolate-and-continue,
// no-overwrite, id guards) run over BOTH ω99-52 backends; the format-marker
// law is byte-face and runs JSONL-only, the same capability split as the
// conformance suite (memory has no byte face by construction).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../src/types.js";
import type { SessionStore } from "../src/session/store.js";
import { createJsonlSessionStore } from "../src/session/store.js";
import { createMemorySessionStore } from "../src/session/memory-store.js";
import { adoptSessionEntries, SessionAdoptConflictError } from "../src/session/adopt.js";
import { formatMarkerLine, UnsupportedSessionFormatException } from "../src/session/format-version.js";
import { activeBranchLeafKey, resumeChain } from "../src/session/branch.js";

// The external-transcript fixture: a uuid/parentUuid TRUNK, a FORK turn
// (u5 points back at u2, skipping live entries — the branch kind), a
// model-state entry, and an active_branch receipt — every entry KIND
// adoption must carry byte-identically.
const TRUNK: readonly AgentMessage[] = [
  { role: "user", content: "trunk turn 1", uuid: "u1" },
  { role: "assistant", content: "trunk answer 1", uuid: "u2", parentUuid: "u1" },
  { role: "user", content: "trunk turn 2", uuid: "u3", parentUuid: "u2" },
  { role: "assistant", content: "trunk answer 2", uuid: "u4", parentUuid: "u3" },
];
const FORK: readonly AgentMessage[] = [
  { role: "user", content: "branch turn (edited resubmit)", uuid: "u5", parentUuid: "u2" },
];
const MODEL_STATE = { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" };
const ACTIVE_BRANCH = { type: "active_branch", data: { leafKey: "u5" } };
const SEED: readonly unknown[] = [...TRUNK, ...FORK, MODEL_STATE, ACTIVE_BRANCH];
const SEED_MESSAGES: readonly AgentMessage[] = [...TRUNK, ...FORK];
const POST: AgentMessage = { role: "assistant", content: "post-adoption answer" };

interface BackendHandle {
  readonly store: SessionStore;
  readonly cleanup: () => Promise<void>;
}
type BackendFactory = () => Promise<BackendHandle> | BackendHandle;

const BACKENDS: readonly (readonly [string, BackendFactory])[] = [
  ["JSONL (filesystem)", async () => {
    const root = await mkdtemp(join(tmpdir(), "adopt58-jsonl-"));
    return { store: createJsonlSessionStore(root), cleanup: () => rm(root, { recursive: true, force: true }) };
  }],
  ["in-memory (Map)", () => ({ store: createMemorySessionStore(), cleanup: async () => {} })],
];

for (const [label, make] of BACKENDS) {
  describe(`adoptSessionEntries — ${label}`, () => {
    let store: SessionStore;
    let cleanup: () => Promise<void>;
    beforeEach(async () => {
      const handle = await make();
      store = handle.store;
      cleanup = handle.cleanup;
    });
    afterEach(async () => {
      await cleanup();
    });

    // Acceptance 1 — continuation: seed N entries (uuid/parentUuid chain +
    // a branch turn + entry kinds) → adopt → append ONE new entry → the
    // entry view returns N+1 in ORIGINAL order, the first N byte-identical
    // to the seed (same serialization bytes, ids never re-minted), and the
    // branch topology still resolves (resume walks the forked chain).
    it("adoption continues: N+1 entries in original order, first N byte-identical, branch intact", async () => {
      const receipt = await adoptSessionEntries(store, "adopted", SEED);
      expect(receipt).toEqual({ sessionId: "adopted", adopted: SEED.length, skipped: 0 });
      const entries = await store.loadSessionEntries("adopted");
      expect(entries).toEqual(SEED);
      expect(entries.map((e) => JSON.stringify(e))).toEqual(SEED.map((e) => JSON.stringify(e)));
      await store.appendEntry("adopted", POST);
      expect(await store.loadSessionEntries("adopted")).toEqual([...SEED, POST]);
      // branch continuation: the fork link and the recorded leaf survived —
      // resume walks the BRANCHED chain, not the flattened file order, and
      // the post-adoption answer CONTINUES that branch.
      expect(activeBranchLeafKey(entries)).toBe("u5");
      expect(resumeChain(await store.load("adopted"), "u5").map((m) => m.uuid ?? m.content))
        .toEqual(["u1", "u2", "u5", "post-adoption answer"]);
      expect(await store.load("adopted")).toEqual([...SEED_MESSAGES, POST]);
    });

    // Acceptance 2 — isolate-and-continue: junk rows (a corrupt line's
    // in-memory analog, unknown entry types, structurally invalid shapes)
    // are skipped AND counted in the receipt; the call never throws.
    it("junk rows are isolated and counted, valid rows adopted in place (no throw)", async () => {
      const receipt = await adoptSessionEntries(store, "iso", [
        TRUNK[0],
        "not json at all {{{",
        42,
        null,
        { type: "future_thing", payload: 1 }, // unknown entry type (no data)
        { role: "user" }, // structurally invalid message (no content)
        POST,
      ]);
      expect(receipt).toEqual({ sessionId: "iso", adopted: 2, skipped: 5 });
      expect(await store.loadSessionEntries("iso")).toEqual([TRUNK[0], POST]);
      expect(store.lastLoadSkipped).toBe(0); // adoption never touched the load-time probe
    });

    // Acceptance 4 — never overwrites: adopting into an id the store already
    // holds is a typed refusal (class name pinned), and the existing content
    // is untouched (pi's COPYFILE_EXCL, made assertable at the store layer).
    it("adopting into an existing id refuses with the typed conflict; content untouched", async () => {
      await adoptSessionEntries(store, "dup", SEED);
      const err = await adoptSessionEntries(store, "dup", [POST]).then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(SessionAdoptConflictError);
      expect((err as SessionAdoptConflictError).name).toBe("SessionAdoptConflictError");
      expect((err as SessionAdoptConflictError).sessionId).toBe("dup");
      expect(await store.loadSessionEntries("dup")).toEqual(SEED);
      // same law for a session created through the normal write path
      await store.append("pre", { role: "user", content: "first" });
      await expect(adoptSessionEntries(store, "pre", SEED)).rejects.toBeInstanceOf(SessionAdoptConflictError);
      expect(await store.load("pre")).toEqual([{ role: "user", content: "first" }]);
    });

    // The id guards mirror the store's own write path (fail closed).
    it("rejects an invalid session id and the reserved side- prefix before any write", async () => {
      await expect(adoptSessionEntries(store, "../evil", SEED)).rejects.toThrow(/invalid session id/);
      await expect(adoptSessionEntries(store, "side-x", SEED)).rejects.toThrow(/reserved/);
      expect(await store.list()).toEqual([]);
    });
  });
}

// ---------------------------------------------------------------------------
// The ω99-47 marker law, JSONL byte face only (memory has no byte face): the
// adoption PRODUCT is marker line 1 + entries body; a supported external
// header is stripped with the pinned marker re-stamped; a NEWER-version
// header composes with the write gate as a typed refusal before any write.
// ---------------------------------------------------------------------------
describe("adoptSessionEntries — JSONL byte face: ω99-47 marker law composition", () => {
  let root: string;
  let store: SessionStore;
  let cleanup: () => Promise<void>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "adopt58-mk-"));
    store = createJsonlSessionStore(root);
    cleanup = () => rm(root, { recursive: true, force: true });
  });
  afterEach(async () => {
    await cleanup();
  });

  it("adoption product = marker line 1 + entries body; load() reads it back normally", async () => {
    const receipt = await adoptSessionEntries(store, "mk", SEED);
    expect(receipt.adopted).toBe(SEED.length);
    const text = await readFile(join(root, "mk.jsonl"), "utf8");
    expect(text).toBe(formatMarkerLine() + SEED.map((e) => `${JSON.stringify(e)}\n`).join(""));
    expect(await store.load("mk")).toEqual([...SEED_MESSAGES]);
    expect(await store.loadSessionEntries("mk")).toEqual([...SEED]);
    expect(store.lastLoadSkipped).toBe(0);
  });

  it("a supported external header is stripped and the pinned marker re-stamped (byte-equal product)", async () => {
    // key order deliberately ≠ the pinned marker bytes — the store's own
    // first-write stamp must win, not the foreign serialization
    const foreignV1 = { data: { formatVersion: 1 }, type: "wudao_meta" };
    await adoptSessionEntries(store, "h1", SEED);
    await adoptSessionEntries(store, "h2", [foreignV1, ...SEED]);
    const t1 = await readFile(join(root, "h1.jsonl"), "utf8");
    const t2 = await readFile(join(root, "h2.jsonl"), "utf8");
    expect(t2).toBe(t1);
    expect(t2.startsWith(formatMarkerLine())).toBe(true);
    expect(await store.loadSessionEntries("h2")).toEqual([...SEED]); // header is framing, not data
  });

  it("write gate composes: a forged version-2 external header is refused with the gate's typed error, nothing written", async () => {
    const forgedV2 = { type: "wudao_meta", data: { formatVersion: 2 } };
    const err = await adoptSessionEntries(store, "v2s", [forgedV2, ...SEED]).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedSessionFormatException);
    expect((err as UnsupportedSessionFormatException).fileVersion).toBe(2);
    expect(await store.loadSessionEntries("v2s")).toEqual([]);
    expect(await store.load("v2s")).toEqual([]);
    expect(await store.list()).toEqual([]);
    // the refusal poisons nothing: the same store adopts a fresh id right after
    await adoptSessionEntries(store, "after", [POST]);
    expect(await store.load("after")).toEqual([POST]);
  });

  it("adopting into a pre-existing id leaves the file bytes untouched", async () => {
    await store.append("pre", { role: "user", content: "first" });
    const before = await readFile(join(root, "pre.jsonl"), "utf8");
    await expect(adoptSessionEntries(store, "pre", SEED)).rejects.toBeInstanceOf(SessionAdoptConflictError);
    expect(await readFile(join(root, "pre.jsonl"), "utf8")).toBe(before);
  });
});
