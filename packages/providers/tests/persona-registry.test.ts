// packages/providers/tests/persona-registry.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readdir as actualReaddir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let mockReaddirOrder: string[] | null = null;

// Mock readdir at module level
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: async (path: string | URL) => {
      if (mockReaddirOrder && typeof path === "string" && path.endsWith("/g")) {
        return mockReaddirOrder;
      }
      return actual.readdir(path);
    },
  };
});

// Import after mock is set up
const { loadPersonaRegistry, lookupPersona } = await import("../src/persona/registry.js");
const { BUILTIN_PERSONAS } = await import("../src/persona/builtins.js");

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "persona-reg-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const valid = { id: "mine", displayName: "Mine", source: { kind: "workspace-source", provenance: "hand-written", pinnedVersion: "1" }, headers: { "openai-chat": { "x-mine": "1" } } };

describe("loadPersonaRegistry", () => {
  it("returns builtins alone when dirs are missing (ENOENT is not an error)", async () => {
    const r = await loadPersonaRegistry({ globalDir: join(dir, "nope"), workspaceDir: join(dir, "also-nope") });
    expect(r.errors).toEqual([]);
    expect(r.personas.length).toBeGreaterThanOrEqual(BUILTIN_PERSONAS.length);
  });
  it("global file adds a persona; workspace file with same id wins", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    await mkdir(join(dir, "w"), { recursive: true });
    await writeFile(join(dir, "g", "mine.json"), JSON.stringify(valid));
    await writeFile(join(dir, "w", "mine.json"), JSON.stringify({ ...valid, displayName: "Workspace wins" }));
    const r = await loadPersonaRegistry({ globalDir: join(dir, "g"), workspaceDir: join(dir, "w") });
    expect(lookupPersona(r, "mine")?.displayName).toBe("Workspace wins");
  });
  it("a broken file is collected into errors and skipped, others still load", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    await writeFile(join(dir, "g", "bad.json"), "{ not json");
    await writeFile(join(dir, "g", "mine.json"), JSON.stringify(valid));
    const r = await loadPersonaRegistry({ globalDir: join(dir, "g") });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]).toContain("bad.json");
    expect(lookupPersona(r, "mine")).toBeDefined();
  });
  it("an invalid schema (unknown key) is collected, not silently dropped", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    await writeFile(join(dir, "g", "evil.json"), JSON.stringify({ ...valid, id: "evil", wat: true }));
    const r = await loadPersonaRegistry({ globalDir: join(dir, "g") });
    expect(r.errors.some((e) => e.includes("evil.json") && e.includes("unknown"))).toBe(true);
  });
  it("non-.json files are ignored", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    await writeFile(join(dir, "g", "notes.txt"), "hi");
    const r = await loadPersonaRegistry({ globalDir: join(dir, "g") });
    expect(r.errors).toEqual([]);
  });
  it("same-tier same-id collision: sorted-later filename wins; personas array follows stable sort order", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    // Create files in reverse alphabetical order to test sorting
    await writeFile(join(dir, "g", "z-last.json"), JSON.stringify({ id: "collision", displayName: "Should win", source: { kind: "workspace-source", provenance: "p1", pinnedVersion: "1" }, headers: { "openai-chat": { "x-test": "z" } } }));
    await writeFile(join(dir, "g", "a-first.json"), JSON.stringify({ id: "collision", displayName: "Should lose", source: { kind: "workspace-source", provenance: "p2", pinnedVersion: "1" }, headers: { "openai-chat": { "x-test": "a" } } }));
    await writeFile(join(dir, "g", "m-middle.json"), JSON.stringify({ id: "other", displayName: "Other", source: { kind: "workspace-source", provenance: "p3", pinnedVersion: "1" }, headers: { "openai-chat": { "x-test": "m" } } }));
    const r = await loadPersonaRegistry({ globalDir: join(dir, "g") });
    // Collision: z-last (sorted later) should win over a-first (sorted earlier)
    expect(lookupPersona(r, "collision")?.displayName).toBe("Should win");
    // Stable order: personas should be in sorted filename order (a-first.json, m-middle.json, z-last.json)
    // But a-first lost the collision, so only m-middle and z-last appear, in that order.
    // Builtins (absent when this test was authored, present since Task 6's stub and
    // Task 4's five real personas) always sort first — assert the user-file tail,
    // robust to however many builtins the branch carries.
    const ids = r.personas.map((p) => p.id);
    expect(ids.slice(-2)).toEqual(["other", "collision"]);
    expect(ids.filter((i) => i === "collision")).toHaveLength(1);
  });
  it("readdir returning reverse-sorted names: inner names.sort() ensures correct collision winner", async () => {
    await mkdir(join(dir, "g"), { recursive: true });
    await writeFile(join(dir, "g", "z-last.json"), JSON.stringify({ id: "reverse-test", displayName: "Should win (sorted later)", source: { kind: "workspace-source", provenance: "p1", pinnedVersion: "1" }, headers: { "openai-chat": { "x-test": "z" } } }));
    await writeFile(join(dir, "g", "a-first.json"), JSON.stringify({ id: "reverse-test", displayName: "Should lose (sorted earlier)", source: { kind: "workspace-source", provenance: "p2", pinnedVersion: "1" }, headers: { "openai-chat": { "x-test": "a" } } }));

    // Set readdir to return reverse-sorted names (z-last.json before a-first.json)
    mockReaddirOrder = ["z-last.json", "a-first.json"];

    const r = await loadPersonaRegistry({ globalDir: join(dir, "g") });

    // The inner names.sort() should reorder to ["a-first.json", "z-last.json"],
    // so a-first is processed first (sets "Should lose"), then z-last overwrites (sets "Should win")
    expect(lookupPersona(r, "reverse-test")?.displayName).toBe("Should win (sorted later)");

    mockReaddirOrder = null;
  });
});
