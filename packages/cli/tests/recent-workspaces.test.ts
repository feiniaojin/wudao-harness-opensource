// M75-ux1 §2 — the recentWorkspaces op's handler (settings-ops.ts): the
// workspace switcher's persistence. One file (WUDAO_GLOBAL_HOME-aware
// `<home>/recent-workspaces.json`, format `[{path, lastUsed}]`, max 5,
// most-recent-first). Read returns the list; `add` unshifts + dedupes +
// trims + persists, then returns the list (no separate write op — the
// switchWorkspace path writes through the same handler).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSettingsOps, recentWorkspacesPath, trimRecentWorkspaces } from "../src/driver/settings-ops.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "wudao-recws-home-"));
  root = mkdtempSync(join(tmpdir(), "wudao-recws-root-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const env = (): NodeJS.ProcessEnv => ({ WUDAO_GLOBAL_HOME: home });

/** The ops face over the isolated home (workspaceRoot is irrelevant here). */
const ops = () => createSettingsOps({ env: env(), workspaceRoot: root });

/** Seed the file with raw rows (lastUsed strings keep the fixture readable). */
const seed = (rows: readonly { path: string; lastUsed: string }[]): void => {
  writeFileSync(join(home, "recent-workspaces.json"), JSON.stringify(rows), "utf8");
};

/** The persisted rows, decoded. */
const onDisk = (): { path: string; lastUsed: string }[] =>
  JSON.parse(readFileSync(join(home, "recent-workspaces.json"), "utf8")) as { path: string; lastUsed: string }[];

describe("recentWorkspaces (M75-ux1 §2)", () => {
  it("reads empty when no file exists (and does not create one)", async () => {
    const r = await ops().recentWorkspaces();
    expect(r).toEqual({ workspaces: [] });
    expect(existsSync(join(home, "recent-workspaces.json"))).toBe(false);
  });

  it("add persists most-recent-first and returns the list", async () => {
    const r = await ops().recentWorkspaces("/a");
    expect(r.workspaces.map((w) => w.path)).toEqual(["/a"]);
    expect(typeof r.workspaces[0]?.lastUsed).toBe("string");
    // The file landed at <global home>/recent-workspaces.json, format [{path,lastUsed}].
    expect(onDisk()).toEqual([{ path: "/a", lastUsed: r.workspaces[0]?.lastUsed }]);
  });

  it("add dedupes by path: re-adding an existing workspace moves it to the front, never duplicates", async () => {
    seed([
      { path: "/b", lastUsed: "2026-01-02T00:00:00.000Z" },
      { path: "/a", lastUsed: "2026-01-01T00:00:00.000Z" },
    ]);
    const r = await ops().recentWorkspaces("/a");
    expect(r.workspaces.map((w) => w.path)).toEqual(["/a", "/b"]);
    expect(onDisk().map((w) => w.path)).toEqual(["/a", "/b"]);
  });

  it("add trims to 5: the oldest entry falls off", async () => {
    // Seeded most-recent-first (the file's own order): p5 used last, p1 oldest.
    seed([5, 4, 3, 2, 1].map((n) => ({ path: `/p${n}`, lastUsed: `2026-01-0${n}T00:00:00.000Z` })));
    const r = await ops().recentWorkspaces("/new");
    expect(r.workspaces.map((w) => w.path)).toEqual(["/new", "/p5", "/p4", "/p3", "/p2"]);
    expect(r.workspaces).toHaveLength(5);
  });

  it("write-read roundtrip: a fresh ops instance reads what the previous one wrote", async () => {
    await ops().recentWorkspaces("/one");
    const r = await ops().recentWorkspaces("/two");
    expect(r.workspaces.map((w) => w.path)).toEqual(["/two", "/one"]);
    // lastUsed is an ISO timestamp per row.
    for (const w of r.workspaces) expect(Number.isNaN(Date.parse(w.lastUsed))).toBe(false);
  });

  it("a corrupt file reads as empty and the next add repairs it", async () => {
    writeFileSync(join(home, "recent-workspaces.json"), "not json", "utf8");
    expect(await ops().recentWorkspaces()).toEqual({ workspaces: [] });
    const r = await ops().recentWorkspaces("/ok");
    expect(r.workspaces.map((w) => w.path)).toEqual(["/ok"]);
  });

  it("a foreign-shaped file (wrong row shape) keeps only well-formed rows", async () => {
    writeFileSync(
      join(home, "recent-workspaces.json"),
      JSON.stringify([{ path: "/keep" }, { noPath: 1 }, "junk", { path: 7 }]),
      "utf8",
    );
    const r = await ops().recentWorkspaces();
    expect(r.workspaces.map((w) => w.path)).toEqual(["/keep"]);
  });

  it("recentWorkspacesPath is WUDAO_GLOBAL_HOME-aware", () => {
    expect(recentWorkspacesPath(env())).toBe(join(home, "recent-workspaces.json"));
  });
});

describe("trimRecentWorkspaces (pure)", () => {
  const row = (path: string): { path: string; lastUsed: string } => ({ path, lastUsed: "t" });

  it("unshift-first + dedupe + cap 5 in one pass", () => {
    const out = trimRecentWorkspaces([row("/new"), row("/a"), row("/new"), row("/b"), row("/c"), row("/d"), row("/e"), row("/f")]);
    expect(out.map((w) => w.path)).toEqual(["/new", "/a", "/b", "/c", "/d"]);
  });

  it("an empty-ish path row is dropped (no blank recents in the menu)", () => {
    const out = trimRecentWorkspaces([row("  "), row("/a")]);
    expect(out.map((w) => w.path)).toEqual(["/a"]);
  });
});
