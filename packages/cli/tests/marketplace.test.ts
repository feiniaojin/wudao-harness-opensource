// cc-plugins A1 — the marketplace module: CC-compatible source parsing
// (owner/repo | git url#ref | local dir | local marketplace.json), the
// marketplace.json reader (unknown fields ignored, bad plugin entries
// dropped + counted, missing plugins array = typed error; E1b: CC
// object-form entry sources — url/git/github — normalize to the string
// grammar), and the
// add/list/update/remove lifecycle over `<globalHome>/marketplaces/` + the
// `marketplaces.json` registry. All git paths run against LOCAL fixture
// repos (`git init` in a tmpdir, cloned over file://) — the suite never
// touches the network.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseMarketSource,
  readMarketplaceFile,
  marketplaceAdd,
  marketplaceList,
  marketplaceUpdate,
  marketplaceRemove,
  pluginInstall,
  pluginUninstall,
  pluginEnable,
  pluginListInstalled,
  MarketplaceError,
  type MarketplaceDeps,
  type PluginEngineDeps,
} from "../src/marketplace.js";
import { loadPlugins } from "../src/plugins.js";

function tmpDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

/** Isolated global home per test — every op runs through deps.env, never the
 *  developer's real ~/.wudao. */
function tmpHomeDeps(): { home: string; deps: MarketplaceDeps; cleanup: () => void } {
  const { dir, cleanup } = tmpDir("wudao-market-home-");
  return { home: dir, deps: { env: { ...process.env, WUDAO_GLOBAL_HOME: dir } }, cleanup };
}

function writeMarketJson(root: string, manifest: Record<string, unknown>): string {
  const p = join(root, ".claude-plugin", "marketplace.json");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(manifest, null, 2), "utf8");
  return p;
}

/** A local-dir market fixture: marketplace.json + one plugin dir + a stray
 *  file (the copier must carry dotdirs like .claude-plugin too). */
function makeLocalMarket(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  writeMarketJson(dir, {
    name,
    description: `the ${name} market`,
    strict: true, // CC field we do not consume — must be ignored, not fatal
    plugins: [
      { name: "greet", source: "./plugins/greet", description: "greets", version: "1.0.0" },
      { name: "odd", source: "./plugins/odd", category: "bonus" }, // unknown entry field — ignored
    ],
  });
  mkdirSync(join(dir, "plugins", "greet", ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, "plugins", "greet", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "greet", version: "1.0.0" }), "utf8");
  writeFileSync(join(dir, "README.md"), "market readme\n", "utf8");
  return dir;
}

// Deterministic fixture commits: fixed author/committer dates so shas and
// clone results are byte-stable across runs.
const GIT_DATES = { GIT_AUTHOR_DATE: "2026-01-01T00:00:00.000Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00.000Z" };

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: { ...process.env, ...GIT_DATES }, stdio: "pipe" });
}

/** A local git repo containing a marketplace (v1). Cloned over file:// in
 *  the tests — the real `git clone --depth 1` path, minus the network. */
function makeGitMarket(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]); // branch-name-proof init
  git(dir, ["config", "user.name", "wudao-test"]);
  git(dir, ["config", "user.email", "wudao-test@example.com"]);
  writeMarketJson(dir, { name, description: "v1", plugins: [{ name: "greet", source: "./plugins/greet" }] });
  mkdirSync(join(dir, "plugins", "greet"), { recursive: true });
  writeFileSync(join(dir, "plugins", "greet", "marker.txt"), "v1\n", "utf8");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "v1"]);
  return dir;
}

function gitCommitChange(dir: string, rel: string, text: string, message: string, manifestPatch?: Record<string, unknown>): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text, "utf8");
  if (manifestPatch !== undefined) {
    writeMarketJson(dir, manifestPatch);
  }
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", message]);
}

// ---------------------------------------------------------------------------
// parseMarketSource — the four forms + rejections
// ---------------------------------------------------------------------------

describe("parseMarketSource", () => {
  it("owner/repo shorthand → github", () => {
    expect(parseMarketSource("obra/superpowers-marketplace")).toEqual({ kind: "github", repo: "obra/superpowers-marketplace" });
  });

  // cc-plugins E4 final-review M1: E1b's object-form normalization emits
  // `owner/repo#ref` — the shorthand must round-trip it back (parse-yes/
  // install-no was the gap).
  it("owner/repo#ref shorthand → github + ref", () => {
    expect(parseMarketSource("obra/superpowers-marketplace#v2")).toEqual({
      kind: "github",
      repo: "obra/superpowers-marketplace",
      ref: "v2",
    });
  });

  it("https git URL → git (no ref)", () => {
    expect(parseMarketSource("https://github.com/obra/superpowers-marketplace.git")).toEqual({
      kind: "git",
      url: "https://github.com/obra/superpowers-marketplace.git",
    });
  });

  it("git URL with #ref → git + ref", () => {
    expect(parseMarketSource("https://example.com/market.git#v2")).toEqual({ kind: "git", url: "https://example.com/market.git", ref: "v2" });
  });

  it("ssh scp-like URL → git", () => {
    expect(parseMarketSource("git@github.com:obra/superpowers-marketplace.git")).toEqual({
      kind: "git",
      url: "git@github.com:obra/superpowers-marketplace.git",
    });
  });

  it("file:// URL → git (local-git fixtures ride this form)", () => {
    const { dir, cleanup } = tmpDir("wudao-parse-");
    try {
      expect(parseMarketSource(pathToFileURL(dir).href)).toEqual({ kind: "git", url: pathToFileURL(dir).href });
    } finally {
      cleanup();
    }
  });

  it("existing directory → localDir (absolute)", () => {
    const { dir, cleanup } = tmpDir("wudao-parse-");
    try {
      expect(parseMarketSource(dir)).toEqual({ kind: "localDir", path: dir });
    } finally {
      cleanup();
    }
  });

  it("existing .json file → localJson", () => {
    const { dir, cleanup } = tmpDir("wudao-parse-");
    try {
      const p = join(dir, "market.json");
      writeFileSync(p, "{}", "utf8");
      expect(parseMarketSource(p)).toEqual({ kind: "localJson", path: p });
    } finally {
      cleanup();
    }
  });

  it("rejects: empty, whitespace, malformed shorthand, missing paths, non-json files", () => {
    const { dir, cleanup } = tmpDir("wudao-parse-");
    try {
      const txt = join(dir, "plain.txt");
      writeFileSync(txt, "x", "utf8");
      expect(parseMarketSource("")).toBeUndefined();
      expect(parseMarketSource("   ")).toBeUndefined();
      expect(parseMarketSource("owner/")).toBeUndefined(); // empty repo segment
      expect(parseMarketSource("a/b/c")).toBeUndefined(); // not owner/repo, not a URL, not existing
      expect(parseMarketSource("no spaces allowed")).toBeUndefined();
      expect(parseMarketSource("just-a-name")).toBeUndefined();
      expect(parseMarketSource(join(dir, "definitely-missing"))).toBeUndefined();
      expect(parseMarketSource(txt)).toBeUndefined(); // exists but is not .json
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// readMarketplaceFile — CC format, tolerant reads, typed failures
// ---------------------------------------------------------------------------

describe("readMarketplaceFile", () => {
  it("parses name/description/plugins and ignores unknown fields", () => {
    const { dir, cleanup } = tmpDir("wudao-mkf-");
    try {
      writeMarketJson(dir, {
        name: "fixture-market",
        description: "a fixture market",
        strict: true,
        metadata: { owner: "nobody" },
        plugins: [
          { name: "greet", source: "./plugins/greet", description: "d", version: "1.0.0", category: "x" },
          { name: "bare", source: "owner/repo" },
        ],
      });
      expect(readMarketplaceFile(dir)).toEqual({
        name: "fixture-market",
        description: "a fixture market",
        plugins: [
          { name: "greet", source: "./plugins/greet", description: "d", version: "1.0.0" },
          { name: "bare", source: "owner/repo" },
        ],
        skipped: 0,
      });
    } finally {
      cleanup();
    }
  });

  it("drops bad plugin entries and counts them", () => {
    const { dir, cleanup } = tmpDir("wudao-mkf-");
    try {
      writeMarketJson(dir, {
        name: "m",
        plugins: [
          { name: "ok", source: "./ok" },
          "a string",
          42,
          null,
          { name: "", source: "./x" }, // empty name
          { name: "no-source" },
          { source: "./no-name" },
          { name: 7, source: "./x" },
          { name: "bad-src", source: 9 },
        ],
      });
      const out = readMarketplaceFile(dir);
      expect(out.plugins.map((p) => p.name)).toEqual(["ok"]);
      expect(out.skipped).toBe(8);
    } finally {
      cleanup();
    }
  });

  it("missing file / bad JSON / not an object / missing or non-string name → typed error", () => {
    const { dir, cleanup } = tmpDir("wudao-mkf-");
    try {
      const bad = (fn: () => unknown): MarketplaceError => {
        try {
          fn();
        } catch (err) {
          expect(err).toBeInstanceOf(MarketplaceError);
          return err as MarketplaceError;
        }
        throw new Error("expected a throw");
      };
      expect(bad(() => readMarketplaceFile(dir)).code).toBe("invalid-marketplace"); // no file
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      const p = join(dir, ".claude-plugin", "marketplace.json");
      writeFileSync(p, "{ not json", "utf8");
      expect(bad(() => readMarketplaceFile(dir)).code).toBe("invalid-marketplace");
      writeFileSync(p, "[1,2]", "utf8");
      expect(bad(() => readMarketplaceFile(dir)).code).toBe("invalid-marketplace"); // top-level array
      writeFileSync(p, "{}", "utf8");
      expect(bad(() => readMarketplaceFile(dir)).code).toBe("invalid-marketplace"); // no name
      writeFileSync(p, JSON.stringify({ name: 42 }), "utf8");
      expect(bad(() => readMarketplaceFile(dir)).code).toBe("invalid-marketplace");
    } finally {
      cleanup();
    }
  });

  it("missing / non-array plugins → typed error", () => {
    const { dir, cleanup } = tmpDir("wudao-mkf-");
    try {
      writeMarketJson(dir, { name: "m" });
      try {
        readMarketplaceFile(dir);
        expect.unreachable("missing plugins must throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MarketplaceError);
        expect((err as MarketplaceError).code).toBe("invalid-marketplace");
      }
      writeMarketJson(dir, { name: "m", plugins: { not: "an array" } });
      try {
        readMarketplaceFile(dir);
        expect.unreachable("non-array plugins must throw");
      } catch (err) {
        expect((err as MarketplaceError).code).toBe("invalid-marketplace");
      }
    } finally {
      cleanup();
    }
  });

  it("non-string description/version on an entry are dropped, entry kept", () => {
    const { dir, cleanup } = tmpDir("wudao-mkf-");
    try {
      writeMarketJson(dir, {
        name: "m",
        description: 3, // wrong-typed known optional — ignored (treated absent)
        plugins: [{ name: "ok", source: "./ok", description: 1, version: true }],
      });
      const out = readMarketplaceFile(dir);
      expect(out.description).toBeUndefined();
      expect(out.plugins).toEqual([{ name: "ok", source: "./ok" }]);
      expect(out.skipped).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// E1b — CC object-form ENTRY sources. Real CC marketplaces (obra/
// superpowers-marketplace) spell each plugins[] entry's source as an OBJECT:
// {"source":"url","url":"https://github.com/obra/superpowers.git"} — the recon
// install saw 10/10 entries skipped because parseEntry only accepted strings.
// The three CC kinds normalize INTO the existing string grammar (url
// passthrough; git → url#ref; github → owner/repo[#ref]); `local` objects and
// any malformed shape stay bad entries (skipped + counted, market survives).
// ---------------------------------------------------------------------------

describe("readMarketplaceFile: CC object-form entry sources (E1b)", () => {
  it("the obra marketplace shape (url objects + version + strict ignored) parses 10/10 into string sources", () => {
    const { dir, cleanup } = tmpDir("wudao-e1b-obra-");
    try {
      // shaped after the REAL obra/superpowers-marketplace manifest the
      // controller installed: every entry's source is an object; unknown
      // fields (strict, …) must be ignored, not fatal
      const entries = Array.from({ length: 10 }, (_, i) => ({
        name: `sp-${i}`,
        source: { source: "url", url: `https://github.com/obra/sp-${i}.git` },
        description: `entry ${i}`,
        version: "1.2.3",
        strict: true,
      }));
      writeMarketJson(dir, { name: "superpowers-marketplace", strict: true, plugins: entries });
      const out = readMarketplaceFile(dir);
      expect(out.skipped).toBe(0);
      expect(out.plugins).toHaveLength(10); // the 10/10 fix, pinned
      expect(out.plugins.map((p) => p.source)).toEqual(Array.from({ length: 10 }, (_, i) => `https://github.com/obra/sp-${i}.git`));
      expect(out.plugins[0]).toEqual({ name: "sp-0", source: "https://github.com/obra/sp-0.git", description: "entry 0", version: "1.2.3" });
    } finally {
      cleanup();
    }
  });

  it("git/github objects normalize to url / url#ref / owner-repo / owner-repo#ref strings", () => {
    const { dir, cleanup } = tmpDir("wudao-e1b-obj-");
    try {
      writeMarketJson(dir, {
        name: "obj-market",
        plugins: [
          { name: "git-plain", source: { source: "git", url: "https://example.com/p.git" } },
          { name: "git-ref", source: { source: "git", url: "https://example.com/p.git", ref: "v2" } },
          { name: "git-ssh-ref", source: { source: "git", url: "git@github.com:obra/p.git", ref: "stable" } },
          { name: "gh-plain", source: { source: "github", owner: "obra", repo: "p" } },
          { name: "gh-ref", source: { source: "github", owner: "obra", repo: "p", ref: "v3" } },
        ],
      });
      const out = readMarketplaceFile(dir);
      expect(out.skipped).toBe(0);
      expect(out.plugins.map((p) => [p.name, p.source])).toEqual([
        ["git-plain", "https://example.com/p.git"],
        ["git-ref", "https://example.com/p.git#v2"],
        ["git-ssh-ref", "git@github.com:obra/p.git#stable"],
        ["gh-plain", "obra/p"],
        ["gh-ref", "obra/p#v3"],
      ]);
    } finally {
      cleanup();
    }
  });

  it("local objects, unknown kinds, and malformed url/owner/repo are skipped+counted without killing the market", () => {
    const { dir, cleanup } = tmpDir("wudao-e1b-bad-");
    try {
      writeMarketJson(dir, {
        name: "mixed-market",
        plugins: [
          { name: "ok", source: { source: "url", url: "https://example.com/ok.git" } },
          { name: "local-obj", source: { source: "local", path: "/somewhere/on/disk" } }, // CC has it; v1 does not → bad entry
          { name: "weird-kind", source: { source: "ipfs", url: "ipfs://qed" } }, // unknown kind
          { name: "url-not-string", source: { source: "url", url: 42 } },
          { name: "git-no-url", source: { source: "git", ref: "v1" } },
          { name: "gh-no-owner", source: { source: "github", repo: "p" } },
          { name: "no-kind", source: { url: "https://example.com/x.git" } }, // object without a source kind
          { name: "empty-url", source: { source: "url", url: "  " } },
        ],
      });
      const out = readMarketplaceFile(dir);
      expect(out.plugins.map((p) => p.name)).toEqual(["ok"]); // the good entry survives
      expect(out.skipped).toBe(7);
    } finally {
      cleanup();
    }
  });

  it("string sources ride unchanged alongside object entries (regression)", () => {
    const { dir, cleanup } = tmpDir("wudao-e1b-str-");
    try {
      writeMarketJson(dir, {
        name: "str-market",
        plugins: [
          { name: "rel", source: "./plugins/rel" },
          { name: "shorthand", source: "obra/p" },
          { name: "git-string", source: "https://example.com/p.git#v9" },
          { name: "obj", source: { source: "url", url: "https://example.com/o.git" } },
          { name: "empty-string", source: "" }, // still a bad entry
        ],
      });
      const out = readMarketplaceFile(dir);
      expect(out.skipped).toBe(1);
      expect(out.plugins.map((p) => [p.name, p.source])).toEqual([
        ["rel", "./plugins/rel"],
        ["shorthand", "obra/p"],
        ["git-string", "https://example.com/p.git#v9"],
        ["obj", "https://example.com/o.git"],
      ]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// add / list / remove — local directory market, full cycle
// ---------------------------------------------------------------------------

describe("marketplace add/list/remove (local dir)", () => {
  it("add copies the tree, registers one line, list reads it back, remove clears both", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(src.dir, "local-market");
      const info = await marketplaceAdd(src.dir, undefined, deps);
      expect(info.name).toBe("local-market");
      expect(info.source).toBe(src.dir);
      expect(info.description).toBe("the local-market market");
      expect(Date.parse(info.addedAt)).not.toBeNaN();

      const marketDir = join(home, "marketplaces", "local-market");
      expect(existsSync(join(marketDir, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(existsSync(join(marketDir, "plugins", "greet", ".claude-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(join(marketDir, "README.md"))).toBe(true);

      const registry = JSON.parse(readFileSync(join(home, "marketplaces.json"), "utf8")) as unknown[];
      expect(registry.length).toBe(1);
      expect((registry[0] as { name: string }).name).toBe("local-market");

      expect(await marketplaceList(deps)).toEqual([info]);

      const removed = await marketplaceRemove("local-market", deps);
      expect(removed.removedPlugins).toEqual([]);
      expect(existsSync(marketDir)).toBe(false);
      expect(await marketplaceList(deps)).toEqual([]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("an explicit opts.name overrides the derived name", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(src.dir, "local-market");
      const info = await marketplaceAdd(src.dir, { name: "renamed" }, deps);
      expect(info.name).toBe("renamed");
      expect(existsSync(join(home, "marketplaces", "renamed", ".claude-plugin", "marketplace.json"))).toBe(true);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("add of a local marketplace.json file registers the file's market name", async () => {
    const src = tmpDir("wudao-market-json-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      const p = join(src.dir, "market.json");
      writeFileSync(p, JSON.stringify({ name: "json-market", description: "from a bare json", plugins: [] }), "utf8");
      const info = await marketplaceAdd(p, undefined, deps);
      expect(info.name).toBe("json-market");
      expect(info.description).toBe("from a bare json");
      expect(existsSync(join(home, "marketplaces", "json-market", ".claude-plugin", "marketplace.json"))).toBe(true);
      const stored = JSON.parse(readFileSync(join(home, "marketplaces", "json-market", ".claude-plugin", "marketplace.json"), "utf8")) as { name: string };
      expect(stored.name).toBe("json-market");
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("add refuses an invalid source string and an invalid explicit name", async () => {
    const { deps, cleanup } = tmpHomeDeps();
    try {
      await expect(marketplaceAdd("definitely not a source", undefined, deps)).rejects.toMatchObject({ code: "invalid-source" });
      await expect(marketplaceAdd("obra/some-repo", { name: "../escape" }, deps)).rejects.toMatchObject({ code: "invalid-name" });
      await expect(marketplaceAdd("obra/some-repo", { name: "" }, deps)).rejects.toMatchObject({ code: "invalid-name" });
      expect(await marketplaceList(deps)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// git markets — local fixture repos over file:// (never the network)
// ---------------------------------------------------------------------------

describe("marketplace add/update/remove (local git fixture)", () => {
  it("add clones, update pulls forward, re-add errors with the existing name, remove cascades", async () => {
    const src = tmpDir("wudao-market-git-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeGitMarket(src.dir, "fixture-market");
      const url = pathToFileURL(src.dir).href;

      // add → dir exists + one registry line
      const info = await marketplaceAdd(url, undefined, deps);
      expect(info.name).toBe("fixture-market");
      expect(info.source).toBe(url);
      expect(info.description).toBe("v1");
      const marketDir = join(home, "marketplaces", "fixture-market");
      expect(existsSync(join(marketDir, ".claude-plugin", "marketplace.json"))).toBe(true);
      expect(readFileSync(join(marketDir, "plugins", "greet", "marker.txt"), "utf8")).toBe("v1\n");
      expect(existsSync(join(marketDir, ".git"))).toBe(true); // a real clone (pull-able)

      // same-name add → typed error carrying the existing name
      const dup = await marketplaceAdd("obra/some-other-repo", { name: "fixture-market" }, deps).catch((err: unknown) => err);
      expect(dup).toBeInstanceOf(MarketplaceError);
      expect((dup as MarketplaceError).code).toBe("already-exists");
      expect((dup as MarketplaceError).message).toContain("fixture-market");

      // new upstream commit → update advances the content, refreshes the
      // description, keeps addedAt
      gitCommitChange(
        src.dir,
        "plugins/greet/marker.txt",
        "v2\n",
        "v2",
        { name: "fixture-market", description: "v2", plugins: [{ name: "greet", source: "./plugins/greet" }] },
      );
      const updated = await marketplaceUpdate("fixture-market", deps);
      expect(updated.description).toBe("v2");
      expect(readFileSync(join(marketDir, "plugins", "greet", "marker.txt"), "utf8")).toBe("v2\n");
      const listed = await marketplaceList(deps);
      expect(listed.length).toBe(1);
      expect(listed[0]?.description).toBe("v2");
      expect(listed[0]?.addedAt).toBe(info.addedAt);

      // a plugin installed from this market (A2's pluginInstall writes this
      // registry; remove owns the cascade) → remove uninstalls it too
      const pluginsRoot = join(home, "plugins");
      mkdirSync(join(pluginsRoot, "greet", ".claude-plugin"), { recursive: true });
      writeFileSync(join(pluginsRoot, "greet", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "greet" }), "utf8");
      writeFileSync(
        join(pluginsRoot, "installed.json"),
        JSON.stringify([
          { name: "greet", market: "fixture-market", scope: "user" },
          { name: "other", market: "elsewhere", scope: "user" },
        ]),
        "utf8",
      );

      const removed = await marketplaceRemove("fixture-market", deps);
      expect(removed.removedPlugins).toEqual(["greet"]);
      expect(existsSync(join(pluginsRoot, "greet"))).toBe(false);
      const installedLeft = JSON.parse(readFileSync(join(pluginsRoot, "installed.json"), "utf8")) as { market: string }[];
      expect(installedLeft.map((r) => r.market)).toEqual(["elsewhere"]);
      expect(existsSync(marketDir)).toBe(false);
      expect(await marketplaceList(deps)).toEqual([]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("a #ref git URL clones that branch", async () => {
    const src = tmpDir("wudao-market-ref-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeGitMarket(src.dir, "ref-market");
      git(src.dir, ["branch", "stable"]); // stable pins v1; main moves on
      gitCommitChange(src.dir, "plugins/greet/marker.txt", "v2\n", "v2 on main");
      const url = `${pathToFileURL(src.dir).href}#stable`;

      const info = await marketplaceAdd(url, undefined, deps);
      expect(info.name).toBe("ref-market");
      const marketDir = join(home, "marketplaces", "ref-market");
      expect(readFileSync(join(marketDir, "plugins", "greet", "marker.txt"), "utf8")).toBe("v1\n");
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("a failing clone surfaces a typed git error and strands nothing", async () => {
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      const missing = pathToFileURL(join(home, "no-such-repo")).href;
      const err = await marketplaceAdd(missing, undefined, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketplaceError);
      expect((err as MarketplaceError).code).toBe("git");
      expect(existsSync(join(home, "marketplaces"))).toBe(false);
      expect(await marketplaceList(deps)).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// local-dir update + not-found paths
// ---------------------------------------------------------------------------

describe("marketplace update (local dir) + not-found paths", () => {
  it("re-copies a local market on update (upstream edits advance)", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(src.dir, "local-market");
      await marketplaceAdd(src.dir, undefined, deps);
      writeFileSync(join(src.dir, "README.md"), "edited upstream\n", "utf8");
      const updated = await marketplaceUpdate("local-market", deps);
      expect(updated.name).toBe("local-market");
      expect(readFileSync(join(home, "marketplaces", "local-market", "README.md"), "utf8")).toBe("edited upstream\n");
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("update/remove of an unknown market → typed not-found; corrupt registry → typed registry error", async () => {
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      await expect(marketplaceUpdate("ghost", deps)).rejects.toMatchObject({ code: "not-found" });
      await expect(marketplaceRemove("ghost", deps)).rejects.toMatchObject({ code: "not-found" });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "marketplaces.json"), "{ broken", "utf8");
      await expect(marketplaceList(deps)).rejects.toMatchObject({ code: "registry" });
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// review fix round 1 — no .staging-* residue on ANY failure path; a failed
// update never degrades the live market; the rename race is typed; a
// corrupt installed.json warns instead of silently skipping
// ---------------------------------------------------------------------------

/** Staging dirs leaked by a failed add/update (must always be []). */
function stagingResidue(home: string): string[] {
  try {
    return readdirSync(join(home, "marketplaces")).filter((n) => n.startsWith(".staging-"));
  } catch {
    return []; // no marketplaces dir at all — nothing to leak
  }
}

describe("review fix round 1: staging hygiene + race typing + warn", () => {
  it("an unsafe DERIVED manifest name fails typed with zero staging residue", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(src.dir, "../escape"); // manifest name is not a safe dir segment
      await expect(marketplaceAdd(src.dir, undefined, deps)).rejects.toMatchObject({ code: "invalid-name" });
      expect(stagingResidue(home)).toEqual([]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("re-adding an existing market (derived name) fails already-exists with zero staging residue", async () => {
    const a = tmpDir("wudao-market-src-");
    const b = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(a.dir, "dup-market");
      makeLocalMarket(b.dir, "dup-market");
      await marketplaceAdd(a.dir, undefined, deps);
      const err = await marketplaceAdd(b.dir, undefined, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketplaceError);
      expect((err as MarketplaceError).code).toBe("already-exists");
      expect((err as MarketplaceError).message).toContain("dup-market");
      expect(stagingResidue(home)).toEqual([]);
    } finally {
      a.cleanup();
      b.cleanup();
      cleanup();
    }
  });

  it("a name won by a concurrent add surfaces already-exists, not a raw rename error", async () => {
    const src = tmpDir("wudao-market-git-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeGitMarket(src.dir, "race-market");
      const finalDir = join(home, "marketplaces", "race-market");
      // git seam (git-kind source, so clone actually runs): the "clone"
      // lands the staged copy AND — as the side effect of the concurrent
      // winner — the final dir appears between the name-freeness check and
      // the rename (only reachable with an explicit name, which is checked
      // before materialization).
      const racedDeps: MarketplaceDeps = {
        ...deps,
        run: async (args) => {
          if (args[0] === "clone") {
            mkdirSync(finalDir, { recursive: true });
            writeFileSync(join(finalDir, "winner.txt"), "won\n", "utf8");
            cpSync(src.dir, args[args.length - 1] as string, { recursive: true });
          }
          return { stdout: "", stderr: "" };
        },
      };
      const err = await marketplaceAdd(pathToFileURL(src.dir).href, { name: "race-market" }, racedDeps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketplaceError);
      expect((err as MarketplaceError).code).toBe("already-exists");
      expect(readFileSync(join(finalDir, "winner.txt"), "utf8")).toBe("won\n"); // the loser clobbered nothing
      expect(stagingResidue(home)).toEqual([]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  // The mid-copy failure is INJECTED via chmod-000 on the plugins/ subdir —
  // win32 never denies the owner, and no owner-deniable equivalent exists
  // without an external exclusive-lock handle. The race-typing and staging
  // hygiene lanes are covered by the sibling tests on every platform.
  it.skipIf(process.platform === "win32")("a mid-copy localDir update failure leaves the live market and registry untouched", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    const locked = join(src.dir, "plugins");
    try {
      makeLocalMarket(src.dir, "local-market");
      await marketplaceAdd(src.dir, undefined, deps);
      const marketDir = join(home, "marketplaces", "local-market");
      const before = readFileSync(join(marketDir, "README.md"), "utf8");
      // upstream turns unreadable MID-COPY: top level reads, the plugins/
      // subdir does not (the copy starts, then fails part-way through).
      // win32: chmod never denies the owner — squat the subdir NAME with a
      // FILE instead (readdir/copy into it fails, same mid-copy break).
      if (process.platform === "win32") {
        rmSync(locked, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        writeFileSync(locked, "a file where plugins/ was");
      } else {
        chmodSync(locked, 0o000);
      }
      await expect(marketplaceUpdate("local-market", deps)).rejects.toMatchObject({ code: "invalid-source" });
      expect(readFileSync(join(marketDir, "README.md"), "utf8")).toBe(before);
      expect((await marketplaceList(deps)).length).toBe(1);
      expect(stagingResidue(home)).toEqual([]);
    } finally {
      if (process.platform === "win32") {
        // the win32 failure shape parked a FILE at the plugins/ name — make
        // it a dir again so cleanup's rm -rf walks the fixture.
        try {
          rmSync(locked, { force: true });
          mkdirSync(locked, { recursive: true });
        } catch { /* best-effort fixture restore */ }
      } else {
        chmodSync(locked, 0o755); // restore so cleanup can rm -rf the fixture
      }
      src.cleanup();
      cleanup();
    }
  });

  it("remove with a corrupt installed.json uninstalls nothing, warns naming the file, still removes the market", async () => {
    const src = tmpDir("wudao-market-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeLocalMarket(src.dir, "local-market");
      await marketplaceAdd(src.dir, undefined, deps);
      const pluginsRoot = join(home, "plugins");
      mkdirSync(join(pluginsRoot, "greet", ".claude-plugin"), { recursive: true });
      writeFileSync(join(pluginsRoot, "greet", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "greet" }), "utf8");
      const installedPath = join(pluginsRoot, "installed.json");
      writeFileSync(installedPath, "{ broken", "utf8");

      const warns: string[] = [];
      const removed = await marketplaceRemove("local-market", { ...deps, warn: (m) => warns.push(m) });
      expect(removed.removedPlugins).toEqual([]);
      expect(existsSync(join(pluginsRoot, "greet"))).toBe(true); // nothing guessed from a file we cannot parse
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain(installedPath);
      expect(existsSync(join(home, "marketplaces", "local-market"))).toBe(false);
      expect(await marketplaceList(deps)).toEqual([]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// A2 — the install engine. pluginInstall copies a market's plugin dir into a
// scope root (user: <globalHome>/plugins/, project: <ws>/.wudao/plugins/),
// registers it in installed.json, and dry-runs the loader for the preview
// counts; uninstall/enable/list ride the same registry.
// ---------------------------------------------------------------------------

const RICH_SKILL = (name: string) => `---\nname: ${name}\ndescription: The ${name} skill\n---\n\n# ${name}\n\nBody.\n`;

/** A full-featured plugin fixture: 2 skills, 1 command, 1 agent, 2 hook
 *  commands, 1 MCP server (plugin.json version 2.1.0 — distinct from the
 *  market entry's 1.0.0 so the precedence is pinnable). */
function makeRichPlugin(dir: string, pluginName = "rich"): string {
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: pluginName, version: "2.1.0" }), "utf8");
  mkdirSync(join(dir, "skills", "alpha"), { recursive: true });
  mkdirSync(join(dir, "skills", "beta"), { recursive: true });
  writeFileSync(join(dir, "skills", "alpha", "SKILL.md"), RICH_SKILL("alpha"), "utf8");
  writeFileSync(join(dir, "skills", "beta", "SKILL.md"), RICH_SKILL("beta"), "utf8");
  mkdirSync(join(dir, "commands"), { recursive: true });
  writeFileSync(join(dir, "commands", "hello.md"), "---\ndescription: Say hi\n---\n\nHi $ARGUMENTS\n", "utf8");
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(join(dir, "agents", "helper.md"), "---\nname: helper\ndescription: Helps\n---\n\nYou help.\n", "utf8");
  mkdirSync(join(dir, "hooks"), { recursive: true });
  writeFileSync(
    join(dir, "hooks", "hooks.json"),
    JSON.stringify({ hooks: { UserPromptSubmit: [{ type: "command", command: "echo one" }, { type: "command", command: "echo two" }] } }),
    "utf8",
  );
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { tools: { command: "echo" } } }), "utf8");
  return dir;
}

/** A local market fixture whose single plugin is `rich` under plugins/. */
function makeRichMarket(dir: string, marketName: string): string {
  mkdirSync(dir, { recursive: true });
  writeMarketJson(dir, {
    name: marketName,
    plugins: [{ name: "rich", source: "./plugins/rich", version: "1.0.0" }],
  });
  makeRichPlugin(join(dir, "plugins", "rich"));
  return dir;
}

/** A fixture plugin GIT repo (for git-sourced entries), committed at HEAD. */
function makeGitPluginRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  makeRichPlugin(dir);
  git(dir, ["init"]);
  git(dir, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(dir, ["config", "user.name", "wudao-test"]);
  git(dir, ["config", "user.email", "wudao-test@example.com"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "plugin v1"]);
  return dir;
}

describe("A2: pluginInstall (user scope)", () => {
  it("copies the plugin into <globalHome>/plugins/, registers it, dry-run counts the assets, and loadPlugins discovers it", async () => {
    const src = tmpDir("wudao-install-src-");
    const ws = tmpDir("wudao-install-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);

      const { dir, detail } = await pluginInstall("rich", "fixture-market", "user", deps);
      expect(dir).toBe(join(home, "plugins", "rich"));
      // the copy landed (assets + dotdirs), byte-identical
      expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(readFileSync(join(dir, "skills", "alpha", "SKILL.md"), "utf8")).toBe(RICH_SKILL("alpha"));
      expect(readFileSync(join(dir, ".mcp.json"), "utf8")).toBe(JSON.stringify({ mcpServers: { tools: { command: "echo" } } }));
      // the dry-run preview counts (loader parsing, no execution)
      expect(detail).toEqual({ skills: 2, commands: 1, agents: 1, hooks: 2, mcp: 1 });

      // one registry record; entry version (1.0.0) beats the plugin.json version
      const records = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { name: string; market: string; scope: string; version?: string }[];
      expect(records).toEqual([{ name: "rich", market: "fixture-market", scope: "user", version: "1.0.0" }]);

      // one list row, enabled by default (installed = enabled)
      expect(await pluginListInstalled(deps)).toEqual([
        { id: "rich@fixture-market", name: "rich", market: "fixture-market", scope: "user", enabled: true, version: "1.0.0" },
      ]);

      // discovery: the user root feeds loadPlugins after .wudao/plugins
      const plugins = loadPlugins(ws.dir, [], () => {}, { env: deps.env });
      expect(plugins.map((p) => p.name)).toEqual(["rich"]);
      expect(plugins[0]?.skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
      expect(existsSync(join(home, "marketplaces", "fixture-market", "plugins", "rich", ".claude-plugin", "plugin.json"))).toBe(true); // the market source is untouched
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("falls back to the plugin.json version when the entry declares none; skips symlinks like the market copier", async () => {
    const src = tmpDir("wudao-install-src-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      mkdirSync(src.dir, { recursive: true });
      writeMarketJson(src.dir, { name: "plain-market", plugins: [{ name: "rich", source: "./plugins/rich" }] });
      makeRichPlugin(join(src.dir, "plugins", "rich"));
      writeFileSync(join(src.dir, "plugins", "rich", "note.txt"), "target of the link\n", "utf8");
      symlinkSync(join(src.dir, "plugins", "rich", "note.txt"), join(src.dir, "plugins", "rich", "linked.txt"));
      await marketplaceAdd(src.dir, undefined, deps);

      const { detail } = await pluginInstall("rich", "plain-market", "user", deps);
      expect(detail).toEqual({ skills: 2, commands: 1, agents: 1, hooks: 2, mcp: 1 });
      expect(existsSync(join(home, "plugins", "rich", "linked.txt"))).toBe(false); // symlinks never ride the copy
      const records = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { version?: string }[];
      expect(records[0]?.version).toBe("2.1.0"); // the plugin.json version
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("an entry whose source is a git location clones (local fixture over file://) and pins the plugin's own commit", async () => {
    const src = tmpDir("wudao-install-git-");
    const repo = tmpDir("wudao-plugin-repo-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeGitPluginRepo(repo.dir);
      mkdirSync(src.dir, { recursive: true });
      writeMarketJson(src.dir, {
        name: "git-entries",
        plugins: [{ name: "rich", source: pathToFileURL(repo.dir).href }],
      });
      await marketplaceAdd(src.dir, undefined, deps);

      const { dir } = await pluginInstall("rich", "git-entries", "user", deps);
      expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
      expect(existsSync(join(dir, ".git"))).toBe(true); // a real clone
      const records = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { commit?: string }[];
      expect(records[0]?.commit).toMatch(/^[0-9a-f]{40}$/); // the plugin repo's HEAD
    } finally {
      src.cleanup();
      repo.cleanup();
      cleanup();
    }
  });

  it("typed failures: unknown market / unknown plugin / unsafe entry name / escaping or missing source / not-a-plugin source", async () => {
    const src = tmpDir("wudao-install-bad-");
    const { deps, cleanup } = tmpHomeDeps();
    try {
      mkdirSync(src.dir, { recursive: true });
      writeMarketJson(src.dir, {
        name: "bad-market",
        plugins: [
          { name: "../evil", source: "./plugins/rich" },
          { name: "escaper", source: "../../outside" },
          { name: "missing", source: "./plugins/nope" },
          { name: "notaplugin", source: "./plugins/empty" },
        ],
      });
      mkdirSync(join(src.dir, "plugins", "empty"), { recursive: true }); // exists, but no plugin.json
      await marketplaceAdd(src.dir, undefined, deps);

      await expect(pluginInstall("rich", "ghost-market", "user", deps)).rejects.toMatchObject({ code: "not-found" });
      await expect(pluginInstall("ghost", "bad-market", "user", deps)).rejects.toMatchObject({ code: "not-found" });
      await expect(pluginInstall("../evil", "bad-market", "user", deps)).rejects.toMatchObject({ code: "invalid-name" });
      await expect(pluginInstall("escaper", "bad-market", "user", deps)).rejects.toMatchObject({ code: "invalid-source" });
      await expect(pluginInstall("missing", "bad-market", "user", deps)).rejects.toMatchObject({ code: "invalid-source" });
      await expect(pluginInstall("notaplugin", "bad-market", "user", deps)).rejects.toMatchObject({ code: "invalid-plugin" });
      expect(existsSync(join(deps.env!["WUDAO_GLOBAL_HOME"]!, "plugins"))).toBe(false); // nothing was written
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("already-exists: a re-install of the same (name, market) and an orphan dest dir are both refused", async () => {
    const src = tmpDir("wudao-install-dup-");
    const ws = tmpDir("wudao-install-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      await pluginInstall("rich", "fixture-market", "user", deps);
      // same name+market in the OTHER scope is still a duplicate id
      await expect(pluginInstall("rich", "fixture-market", "project", { ...deps, workspaceRoot: ws.dir })).rejects.toMatchObject({ code: "already-exists" });
      await pluginUninstall("rich@fixture-market", deps);

      // an orphan dir (a crash between copy and register) blocks, naming the cleanup
      mkdirSync(join(home, "plugins", "rich"), { recursive: true });
      const err = await pluginInstall("rich", "fixture-market", "user", deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketplaceError);
      expect((err as MarketplaceError).code).toBe("already-exists");
      expect((err as MarketplaceError).message).toContain("remove");
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });
});

describe("A2: project scope + uninstall + enable", () => {
  it("install(project) lands under <ws>/.wudao/plugins/ with the root recorded; uninstall clears dir + record + the disable key", async () => {
    const src = tmpDir("wudao-proj-src-");
    const ws = tmpDir("wudao-proj-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);

      const { dir } = await pluginInstall("rich", "fixture-market", "project", { ...deps, workspaceRoot: ws.dir });
      expect(dir).toBe(join(ws.dir, ".wudao", "plugins", "rich"));
      const records = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { name: string; scope: string; root?: string }[];
      // A2-review piggyback: the recorded root is the workspace's REALPATH —
      // mkdtemp hands back /var/... on macOS while the canonical form is
      // /private/var/... (a symlinked install records the same canonical root)
      expect(records).toEqual([{ name: "rich", market: "fixture-market", scope: "project", version: "1.0.0", root: realpathSync(ws.dir) }]);
      expect((await pluginListInstalled(deps))[0]?.scope).toBe("project");
      // discovery hits the PROJECT root for this workspace
      expect(loadPlugins(ws.dir, [], () => {}, { env: deps.env }).map((p) => p.name)).toEqual(["rich"]);

      // disable (bare name — unique), then uninstall: dir, record AND settings key all gone
      await pluginEnable("rich", false, deps);
      const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> };
      expect(settings.enabledPlugins).toEqual({ "rich@fixture-market": false });
      await pluginUninstall("rich@fixture-market", deps);
      expect(existsSync(dir)).toBe(false);
      expect(await pluginListInstalled(deps)).toEqual([]);
      const after = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as { enabledPlugins?: Record<string, boolean> };
      expect(after.enabledPlugins).toBeUndefined(); // stale disable cleaned
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("disable hides the plugin from discovery and the list; enable brings it back and drops the settings key", async () => {
    const src = tmpDir("wudao-enable-src-");
    const ws = tmpDir("wudao-enable-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      await pluginInstall("rich", "fixture-market", "user", deps);
      const isolated: PluginEngineDeps = { ...deps, workspaceRoot: ws.dir };

      await pluginEnable("rich@fixture-market", false, deps);
      expect(loadPlugins(ws.dir, [], () => {}, { env: deps.env })).toEqual([]);
      expect((await pluginListInstalled(deps))[0]?.enabled).toBe(false);

      await pluginEnable("rich@fixture-market", true, deps);
      expect(loadPlugins(ws.dir, [], () => {}, { env: deps.env }).map((p) => p.name)).toEqual(["rich"]);
      expect((await pluginListInstalled(deps))[0]?.enabled).toBe(true);
      const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(settings["enabledPlugins"]).toBeUndefined(); // back to the default (installed = enabled)
      expect(existsSync(join(home, "plugins", "rich"))).toBe(true); // enable never touches the dir
      expect(isolated.workspaceRoot).toBeDefined();
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("a bare name that hits several markets is a typed ambiguous error; <name>@<market> disambiguates", async () => {
    const a = tmpDir("wudao-amb-a-");
    const b = tmpDir("wudao-amb-b-");
    const ws = tmpDir("wudao-amb-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(a.dir, "market-one");
      makeRichMarket(b.dir, "market-two");
      await marketplaceAdd(a.dir, undefined, deps);
      await marketplaceAdd(b.dir, undefined, deps);
      await pluginInstall("rich", "market-one", "user", deps);
      await pluginInstall("rich", "market-two", "project", { ...deps, workspaceRoot: ws.dir }); // same name, other market + scope

      const err = await pluginEnable("rich", false, deps).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MarketplaceError);
      expect((err as MarketplaceError).code).toBe("ambiguous");
      expect((err as MarketplaceError).message).toContain("rich@market-one");
      expect((err as MarketplaceError).message).toContain("rich@market-two");

      await pluginUninstall("rich@market-two", deps); // the project one only
      expect(existsSync(join(ws.dir, ".wudao", "plugins", "rich"))).toBe(false);
      expect(existsSync(join(home, "plugins", "rich"))).toBe(true);
      expect(await pluginListInstalled(deps)).toEqual([
        { id: "rich@market-one", name: "rich", market: "market-one", scope: "user", enabled: true, version: "1.0.0" },
      ]);
    } finally {
      a.cleanup();
      b.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("not-found for enable/uninstall of an unknown id; adhocPaths surface as scope \"adhoc\" rows", async () => {
    const src = tmpDir("wudao-adhoc-");
    const { deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      await expect(pluginEnable("ghost@nowhere", true, deps)).rejects.toMatchObject({ code: "not-found" });
      await expect(pluginUninstall("ghost", deps)).rejects.toMatchObject({ code: "not-found" });

      const rows = await pluginListInstalled({ ...deps, adhocPaths: [join(src.dir, "plugins", "rich")] });
      expect(rows).toEqual([{ id: "rich", name: "rich", market: "adhoc", scope: "adhoc", enabled: true, version: "2.1.0" }]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });

  it("a corrupt installed.json is a typed registry error for install/uninstall/list (never guessed past)", async () => {
    const src = tmpDir("wudao-corrupt-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      mkdirSync(join(home, "plugins"), { recursive: true });
      writeFileSync(join(home, "plugins", "installed.json"), "{ broken", "utf8");

      await expect(pluginInstall("rich", "fixture-market", "user", deps)).rejects.toMatchObject({ code: "registry" });
      await expect(pluginUninstall("rich@fixture-market", deps)).rejects.toMatchObject({ code: "registry" });
      await expect(pluginEnable("rich@fixture-market", false, deps)).rejects.toMatchObject({ code: "registry" });
      await expect(pluginListInstalled(deps)).rejects.toMatchObject({ code: "registry" });
    } finally {
      src.cleanup();
      cleanup();
    }
  });
});

describe("A2: marketplaceRemove cascade (both scopes + enabledPlugins cleanup)", () => {
  it("removes user- and project-scope dirs + records and clears their disable keys", async () => {
    const src = tmpDir("wudao-cascade-src-");
    const ws = tmpDir("wudao-cascade-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      mkdirSync(src.dir, { recursive: true });
      writeMarketJson(src.dir, {
        name: "fixture-market",
        plugins: [
          { name: "rich", source: "./plugins/rich", version: "1.0.0" },
          { name: "extra", source: "./plugins/extra", version: "1.0.0" },
        ],
      });
      makeRichPlugin(join(src.dir, "plugins", "rich"), "rich");
      makeRichPlugin(join(src.dir, "plugins", "extra"), "extra");
      await marketplaceAdd(src.dir, undefined, deps);
      await pluginInstall("rich", "fixture-market", "user", deps);
      await pluginInstall("extra", "fixture-market", "project", { ...deps, workspaceRoot: ws.dir });
      await pluginEnable("rich@fixture-market", false, deps);

      const removed = await marketplaceRemove("fixture-market", deps);
      expect([...removed.removedPlugins].sort()).toEqual(["extra", "rich"]);
      expect(existsSync(join(home, "plugins", "rich"))).toBe(false);
      expect(existsSync(join(ws.dir, ".wudao", "plugins", "extra"))).toBe(false);
      expect(await pluginListInstalled(deps)).toEqual([]);
      const settings = JSON.parse(readFileSync(join(home, "settings.json"), "utf8")) as Record<string, unknown>;
      expect(settings["enabledPlugins"]).toBeUndefined();
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("a project record without its root workspace is warned about and kept (no guessed deletions)", async () => {
    const src = tmpDir("wudao-cascade-noroot-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      const pluginsRoot = join(home, "plugins");
      mkdirSync(join(pluginsRoot, "rich", ".claude-plugin"), { recursive: true });
      writeFileSync(join(pluginsRoot, "rich", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rich" }), "utf8");
      writeFileSync(
        join(pluginsRoot, "installed.json"),
        JSON.stringify([{ name: "rich", market: "fixture-market", scope: "project" }]), // hand-written: no root
        "utf8",
      );

      const warns: string[] = [];
      const removed = await marketplaceRemove("fixture-market", { ...deps, warn: (m) => warns.push(m) });
      expect(removed.removedPlugins).toEqual([]);
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("rich");
      expect(warns[0]).toContain("root");
      // the record survives (still listed) — we refused to guess where its dir lives
      expect((await pluginListInstalled(deps)).map((r) => r.id)).toEqual(["rich@fixture-market"]);
    } finally {
      src.cleanup();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// A2 review piggybacks (landed with A3):
//   1. pluginUninstall on a rootless project record — the old
//      `match.root ?? deps.workspaceRoot ?? process.cwd()` chain was a cwd
//      guess (a same-named dir under a different workspace could be deleted).
//      It now mirrors the cascade's stance: warn + keep the record, delete
//      nothing.
//   2. project-scope roots are REALPATH-normalized at write, and the
//      discovery-side compare normalizes both sides — a symlinked workspace
//      (or macOS /var vs /private/var) no longer silently fails-open the
//      enabledPlugins filter.
// ---------------------------------------------------------------------------

describe("A2-review piggyback: uninstall + root normalization", () => {
  it("uninstall of a rootless project record warns, keeps the record, and deletes nothing (no cwd guess)", async () => {
    const src = tmpDir("wudao-un-noroot-");
    const ws = tmpDir("wudao-un-noroot-ws-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      // a hand-written rootless project record + a decoy dir a cwd guess
      // could have hit (same plugin name, DIFFERENT workspace)
      const decoy = join(ws.dir, ".wudao", "plugins", "rich");
      mkdirSync(join(decoy, ".claude-plugin"), { recursive: true });
      writeFileSync(join(decoy, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "rich" }), "utf8");
      const registry = join(home, "plugins", "installed.json");
      mkdirSync(join(home, "plugins"), { recursive: true });
      writeFileSync(registry, JSON.stringify([{ name: "rich", market: "fixture-market", scope: "project" }]), "utf8");

      const warns: string[] = [];
      await pluginUninstall("rich@fixture-market", { env: deps.env, warn: (m) => warns.push(m) });
      expect(warns.length).toBe(1);
      expect(warns[0]).toContain("rich");
      expect(warns[0]).toContain("root");
      // the record survives and the decoy dir is untouched
      expect((await pluginListInstalled(deps)).map((r) => r.id)).toEqual(["rich@fixture-market"]);
      expect(existsSync(decoy)).toBe(true);
    } finally {
      src.cleanup();
      ws.cleanup();
      cleanup();
    }
  });

  it("project-scope install records the REALPATH of the workspace root (symlinked installs normalize)", async () => {
    const src = tmpDir("wudao-real-src-");
    const realWs = tmpDir("wudao-real-ws-");
    const aliasParent = tmpDir("wudao-real-alias-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      const alias = join(aliasParent.dir, "ws");
      symlinkSync(realWs.dir, alias);

      await pluginInstall("rich", "fixture-market", "project", { ...deps, workspaceRoot: alias });
      const records = JSON.parse(readFileSync(join(home, "plugins", "installed.json"), "utf8")) as { root?: string }[];
      expect(records[0]?.root).toBe(realpathSync(realWs.dir)); // the canonical form, not the alias
      // discovery through EITHER spelling sees the install
      expect(loadPlugins(realWs.dir, [], () => {}, { env: deps.env }).map((p) => p.name)).toEqual(["rich"]);
      expect(loadPlugins(alias, [], () => {}, { env: deps.env }).map((p) => p.name)).toEqual(["rich"]);
    } finally {
      src.cleanup();
      realWs.cleanup();
      aliasParent.cleanup();
      cleanup();
    }
  });

  it("a disable set through one path spelling filters discovery through the other (compare is normalized)", async () => {
    const src = tmpDir("wudao-norm-src-");
    const realWs = tmpDir("wudao-norm-ws-");
    const aliasParent = tmpDir("wudao-norm-alias-");
    const { home, deps, cleanup } = tmpHomeDeps();
    try {
      makeRichMarket(src.dir, "fixture-market");
      await marketplaceAdd(src.dir, undefined, deps);
      const alias = join(aliasParent.dir, "ws");
      symlinkSync(realWs.dir, alias);

      // install + disable through the REAL path, then discover through the ALIAS
      await pluginInstall("rich", "fixture-market", "project", { ...deps, workspaceRoot: realWs.dir });
      await pluginEnable("rich@fixture-market", false, deps);
      // project records only disable in their own workspace — the alias IS the
      // same workspace once both sides are realpath-normalized (the old strict
      // compare failed OPEN here: alias !== real → the disable never applied)
      expect(loadPlugins(alias, [], () => {}, { env: deps.env })).toEqual([]);
      // and the real spelling keeps filtering too (cross-workspace isolation
      // is pinned separately in plugins.test.ts)
      expect(loadPlugins(realWs.dir, [], () => {}, { env: deps.env })).toEqual([]);
      void home;
    } finally {
      src.cleanup();
      realWs.cleanup();
      aliasParent.cleanup();
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// A1 review INFO — `foo/bar` vs a same-shaped existing relative dir: the
// GitHub shorthand wins; a local source must spell `./` or an absolute path.
// ---------------------------------------------------------------------------

describe("parseMarketSource: shorthand precedence over same-shaped local dirs", () => {
  it("`foo/bar` stays github even when ./foo/bar exists relative to cwd; `./foo/bar` is the local escape hatch", () => {
    const holder = tmpDir("wudao-parse-cwd-");
    const before = process.cwd();
    try {
      mkdirSync(join(holder.dir, "foo", "bar"), { recursive: true });
      process.chdir(holder.dir);
      const cwd = process.cwd(); // may be the realpath (macOS /var -> /private/var)
      expect(parseMarketSource("foo/bar")).toEqual({ kind: "github", repo: "foo/bar" }); // shorthand wins
      expect(parseMarketSource("./foo/bar")).toEqual({ kind: "localDir", path: join(cwd, "foo", "bar") }); // explicit local
      expect(parseMarketSource(join(holder.dir, "foo", "bar"))).toEqual({ kind: "localDir", path: join(holder.dir, "foo", "bar") }); // absolute local
    } finally {
      process.chdir(before);
      holder.cleanup();
    }
  });
});
