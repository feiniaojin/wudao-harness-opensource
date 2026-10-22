// SDD 2026-08-23 persona Task 5 — the CRUD file helpers (spec §7: same
// package as loadPersonaRegistry). savePersonaDefinition is the ONE write
// path for global personas (~/.wudao/personas/<id>.json): validate → atomic
// tmp+rename 0600 write, per-field errors[] on refusal (the wire personaSave
// reply's shape — the settings form matches field-path prefixes back to its
// rows). deletePersonaDefinition is the delete half; personaIdsInDir is the
// origin scan personaList needs (the merged registry loses which tier a
// persona came from).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deletePersonaDefinition, personaIdsInDir, savePersonaDefinition } from "../src/persona/files.js";
import { loadPersonaRegistry } from "../src/persona/registry.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wudao-persona-files-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The UI's save payload shape (T6): the settings tab's source row. */
const UI_DEF = {
  id: "alpha",
  displayName: "Alpha",
  source: { kind: "workspace-source", provenance: "user-defined (wudao settings persona tab)", pinnedVersion: "1" },
  headers: { "openai-chat": { "x-custom": "1" } },
} as const;

describe("savePersonaDefinition", () => {
  it("writes a valid definition to <id>.json and it round-trips through the registry reader", async () => {
    const r = await savePersonaDefinition(dir, UI_DEF);
    expect(r).toEqual({ ok: true, id: "alpha" });
    const file = join(dir, "alpha.json");
    expect(existsSync(file)).toBe(true);
    // Atomic-write discipline: 0600 (same posture as the global settings /
    // providers.json writers). POSIX-only leg — win32 reports no enforced
    // mode bits (0666 regardless), so the octal assert skips there.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    const registry = await loadPersonaRegistry({ globalDir: dir });
    expect(registry.personas.map((p) => p.id)).toContain("alpha");
    expect(registry.errors).toEqual([]);
    const def = registry.personas.find((p) => p.id === "alpha");
    expect(def?.displayName).toBe("Alpha");
    expect(def?.headers).toEqual({ "openai-chat": { "x-custom": "1" } });
  });

  it("re-saves (updates) the same id in place", async () => {
    await savePersonaDefinition(dir, UI_DEF);
    const r = await savePersonaDefinition(dir, { ...UI_DEF, displayName: "Alpha 2" });
    expect(r).toEqual({ ok: true, id: "alpha" });
    expect(JSON.parse(readFileSync(join(dir, "alpha.json"), "utf8")).displayName).toBe("Alpha 2");
  });

  it("refuses an invalid definition with per-field errors — and writes NOTHING", async () => {
    const r = await savePersonaDefinition(dir, {
      id: "Bad_Id",
      displayName: "",
      // source missing entirely
      headers: { anthropic: { authorization: "Bearer x" } },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // Field-path messages (the web form's row matcher): id / displayName /
    // source / the forbidden header key.
    expect(r.errors.some((e) => e.startsWith("id:"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("displayName:"))).toBe(true);
    expect(r.errors.some((e) => e.startsWith("source:"))).toBe(true);
    expect(r.errors.some((e) => e.includes("forbidden persona header"))).toBe(true);
    expect(existsSync(dir)).toBe(true);
    // dir itself exists but is EMPTY — no file was written for a refused save.
    const registry = await loadPersonaRegistry({ globalDir: dir });
    expect(registry.personas.filter((p) => p.id === "Bad_Id")).toEqual([]);
  });

  it("refuses a non-object with a single error", async () => {
    const r = await savePersonaDefinition(dir, "nope");
    expect(r).toEqual({ ok: false, errors: ["persona: must be an object"] });
  });
});

describe("deletePersonaDefinition", () => {
  it("deletes an existing file → true, gone from disk", async () => {
    await savePersonaDefinition(dir, UI_DEF);
    expect(await deletePersonaDefinition(dir, "alpha")).toBe(true);
    expect(existsSync(join(dir, "alpha.json"))).toBe(false);
  });

  it("a missing file → false (nothing to delete)", async () => {
    expect(await deletePersonaDefinition(dir, "ghost")).toBe(false);
  });

  it("refuses a traversal-shaped id — false, no file touched", async () => {
    await savePersonaDefinition(dir, UI_DEF);
    // "../../evil" must never reach path resolution (the id is wire input).
    expect(await deletePersonaDefinition(dir, "../../evil")).toBe(false);
    expect(await deletePersonaDefinition(dir, "a/b")).toBe(false);
    expect(existsSync(join(dir, "alpha.json"))).toBe(true);
  });
});

describe("personaIdsInDir (the origin scan personaList uses)", () => {
  it("collects the PARSED ids (not filenames); skips non-.json and invalid JSON", async () => {
    await savePersonaDefinition(dir, UI_DEF);
    const { writeFile } = await import("node:fs/promises");
    // A mismatched filename still keys by its parsed id — same rule the
    // registry reader applies.
    await writeFile(join(dir, "zz-other.json"), JSON.stringify({ ...UI_DEF, id: "beta" }), "utf8");
    await writeFile(join(dir, "notes.txt"), "not a persona", "utf8");
    await writeFile(join(dir, "broken.json"), "{not json", "utf8");
    const ids = await personaIdsInDir(dir);
    expect([...ids].sort()).toEqual(["alpha", "beta"]);
  });

  it("a missing dir is the empty set, never an error", async () => {
    expect(await personaIdsInDir(join(dir, "nope"))).toEqual(new Set());
    expect(await personaIdsInDir(undefined)).toEqual(new Set());
  });
});
