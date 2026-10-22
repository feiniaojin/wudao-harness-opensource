// ω99-58 — acceptance 5: the memory store's seedEntries param (ω99-52's
// factory, extended). The seed applies the SAME law as adoptSessionEntries —
// pinned here as an equivalence — so subagent (M9) in-process sessions and
// evals replay seeds get one adoption semantics across both backends. The
// adopt seam is imported lazily inside the tests that need the receipt path,
// keeping this file independently runnable against the seed face alone.
import { describe, it, expect } from "vitest";
import { createMemorySessionStore } from "../src/session/memory-store.js";

const TRUNK = [
  { role: "user" as const, content: "trunk turn 1", uuid: "u1" },
  { role: "assistant" as const, content: "trunk answer 1", uuid: "u2", parentUuid: "u1" },
  { role: "user" as const, content: "trunk turn 2", uuid: "u3", parentUuid: "u2" },
  { role: "assistant" as const, content: "trunk answer 2", uuid: "u4", parentUuid: "u3" },
];
const FORK = [
  { role: "user" as const, content: "branch turn (edited resubmit)", uuid: "u5", parentUuid: "u2" },
];
const MODEL_STATE = { type: "model_change", model: "glm-4.6", provider: "glm", at: "2026-09-05T00:00:00.000Z" };
const ACTIVE_BRANCH = { type: "active_branch", data: { leafKey: "u5" } };
const SEED: readonly unknown[] = [...TRUNK, ...FORK, MODEL_STATE, ACTIVE_BRANCH];
const POST = { role: "assistant" as const, content: "post-seed answer" };

describe("createMemorySessionStore(seedEntries) — ω99-58 memory seed laws", () => {
  it("law 1 (continuation): seeded entries load byte-identically and continue (N+1)", async () => {
    const store = createMemorySessionStore({ seeded: SEED });
    const entries = await store.loadSessionEntries("seeded");
    expect(entries).toEqual([...SEED]);
    expect(entries.map((e) => JSON.stringify(e))).toEqual(SEED.map((e) => JSON.stringify(e)));
    await store.appendEntry("seeded", POST);
    expect(await store.loadSessionEntries("seeded")).toEqual([...SEED, POST]);
  });

  it("law 2 (isolate-and-continue): seed junk is filtered, never thrown; adopt receipts the same junk", async () => {
    const { adoptSessionEntries } = await import("../src/session/adopt.js");
    const withJunk = [SEED[0], "not json {{{", { type: "future_thing", payload: 1 }, POST];
    const seeded = createMemorySessionStore({ iso: withJunk });
    const adoptedStore = createMemorySessionStore();
    const receipt = await adoptSessionEntries(adoptedStore, "iso", withJunk);
    expect(receipt).toEqual({ sessionId: "iso", adopted: 2, skipped: 2 });
    // seed ≡ adopt: identical store contents — the seed applies the same
    // filter law; adopt is where the skip receipt lives.
    expect(await seeded.loadSessionEntries("iso")).toEqual(await adoptedStore.loadSessionEntries("iso"));
    expect(await seeded.loadSessionEntries("iso")).toEqual([SEED[0], POST]);
  });

  it("law 4 (no overwrite): a seeded id is an existing id — adopting into it refuses with the typed conflict", async () => {
    const { adoptSessionEntries, SessionAdoptConflictError } = await import("../src/session/adopt.js");
    const store = createMemorySessionStore({ taken: SEED });
    const err = await adoptSessionEntries(store, "taken", [POST]).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(SessionAdoptConflictError);
    expect((err as InstanceType<typeof SessionAdoptConflictError>).sessionId).toBe("taken");
    expect(await store.loadSessionEntries("taken")).toEqual([...SEED]);
  });

  it("Map-form seeds equal Record-form seeds", async () => {
    const a = createMemorySessionStore({ m: SEED });
    const b = createMemorySessionStore(new Map([["m", SEED]]));
    expect(await a.loadSessionEntries("m")).toEqual(await b.loadSessionEntries("m"));
  });

  it("an empty or junk-only seed creates no session", async () => {
    const store = createMemorySessionStore({ empty: [], junkOnly: [42, "x", { type: "no_data" }] });
    expect(await store.list()).toEqual([]);
    expect(await store.loadSessionEntries("empty")).toEqual([]);
    expect(await store.loadSessionEntries("junkOnly")).toEqual([]);
  });

  it("seed ids follow the same shape/reservation law as writes (fail closed)", () => {
    expect(() => createMemorySessionStore({ "../evil": SEED })).toThrow(/invalid session id/);
    expect(() => createMemorySessionStore({ "side-x": SEED })).toThrow(/reserved/);
  });

  it("zero-arg construction is unchanged (the ω99-52 face)", async () => {
    const store = createMemorySessionStore();
    expect(await store.list()).toEqual([]);
    await store.append("fresh", { role: "user", content: "hi" });
    expect(await store.load("fresh")).toEqual([{ role: "user", content: "hi" }]);
  });
});
