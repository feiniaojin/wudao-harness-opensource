// cc-plugins A1+A2 — the marketplace + install engine: CC-compatible plugin
// markets and copy-based installs from them. A market = a directory with
// `.claude-plugin/marketplace.json` ({name, description?, plugins:[{name,
// source, description?, version?}]} — CC's format verbatim; unknown fields
// ignored; an entry's `source` is a string or CC's object form — {source:
// "url"|"git"|"github"} — normalized to the string grammar at parse). Market
// (add) sources come in four forms: `owner/repo` (GitHub shorthand), a
// git URL with optional `#<ref>` (branch/tag), an existing local directory,
// or a bare marketplace.json path. add materializes the market under
// `<globalHome>/marketplaces/<name>/` (git → `git clone --depth 1
// [--branch ref]`; local → recursive copy) and appends one line to the
// `<globalHome>/marketplaces.json` registry; update re-pulls / re-copies;
// remove deletes + unregisters and CASCADES to the plugins the market
// installed.
//
// A2 — the install engine on top: pluginInstall copies a market's plugin
// directory into a scope root (user → `<globalHome>/plugins/<name>/`,
// project → `<workspace>/.wudao/plugins/<name>/`; git-location entry sources
// clone like a market) and registers it in `<globalHome>/plugins/
// installed.json`; uninstall/enable/list ride the same registry; enable
// state lives in the GLOBAL settings' `enabledPlugins` (`<name>@<market>`
// keys, default installed = enabled) which discovery (plugins.ts) filters by.
//
// Same law as plugins.ts: a market/plugin is a CONFIG package — nothing here
// ever executes its code (no postinstall, no hooks); materialization is
// clone-or-copy, full stop. Both registries are machine-written, so their
// writers' readers are STRICT: a malformed file is a typed error, not a
// silent half-read — install/uninstall/enable must never guess against a
// registry they cannot fully parse. (The one deliberate exception:
// marketplaceRemove's CASCADE warns and removes NOTHING on a corrupt
// install registry — deleting plugins is exactly the guess it refuses.)
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { readGlobalSettings, resolveGlobalHome, saveGlobalSettings } from "./settings-layer.js";
import { hardenedGitArgs } from "./git-hardened.js";
import { inspectPluginDir, normalizeWorkspaceRoot } from "./plugins.js";
import type { PluginFormat } from "./plugins.js";

const execFileAsync = promisify(execFile);

/** One git child-process budget (clone/pull of a real market repo). */
const GIT_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// ω99 拆分运动 弧 B re-export 门面——保原 marketplace.js 公共面（源解析层→
// marketplace-source.ts：类型/typed 错误/路径/名字安全/源语法/marketplace.json
// 读取 + 错误文本工具）。
// ---------------------------------------------------------------------------
export type { MarketplaceEntry, MarketplaceInfo, MarketSource, MarketplaceErrorCode, MarketplaceDeps, RunGit, PluginEngineDeps } from "./marketplace-source.js";
export { MarketplaceError } from "./marketplace-source.js";
export { marketplacesDir, marketplaceRegistryPath, installedPluginsPath } from "./marketplace-source.js";
export { parseMarketSource, readMarketplaceFile, parseMarketplaceText } from "./marketplace-source.js";
export type { MarketplaceFile } from "./marketplace-source.js";
import {
  MarketplaceError,
  marketplacesDir, marketplaceRegistryPath, installedPluginsPath,
  parseMarketSource, readMarketplaceFile, parseMarketplaceText,
  NAME_RE, isSafeName, isRecord, errorMessage, gitErrorText, oneLine, defaultWarn,
} from "./marketplace-source.js";
import type { MarketSource, MarketplaceEntry, MarketplaceInfo, MarketplaceFile, MarketplaceDeps, RunGit, PluginEngineDeps } from "./marketplace-source.js";

/** Strict read (machine-written file): absent → []; malformed → typed
 *  registry error naming the path — never a silent half-read. */
async function readRegistry(env: NodeJS.ProcessEnv): Promise<MarketplaceInfo[]> {
  const path = marketplaceRegistryPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MarketplaceError("registry", `${path} is not valid JSON — fix or remove it by hand`);
  }
  if (!Array.isArray(parsed)) {
    throw new MarketplaceError("registry", `${path} must be a JSON array — fix or remove it by hand`);
  }
  const out: MarketplaceInfo[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item["name"] !== "string" || !isSafeName(item["name"]) || typeof item["source"] !== "string" || item["source"] === "" || typeof item["addedAt"] !== "string" || item["addedAt"] === "") {
      throw new MarketplaceError("registry", `${path} has a malformed entry (expected {name, source, addedAt}) — fix or remove it by hand`);
    }
    const description = typeof item["description"] === "string" ? item["description"] : undefined;
    out.push({
      name: item["name"],
      source: item["source"],
      addedAt: item["addedAt"],
      ...(description !== undefined ? { description } : {}),
    });
  }
  return out;
}

async function writeRegistry(entries: readonly MarketplaceInfo[], env: NodeJS.ProcessEnv): Promise<void> {
  const path = marketplaceRegistryPath(env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Materialization (clone / copy)
// ---------------------------------------------------------------------------

async function runGitDefault(args: readonly string[], opts: { cwd?: string }): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsync("git", hardenedGitArgs(args), {
    cwd: opts.cwd,
    timeout: GIT_TIMEOUT_MS,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0", // never hang on a credential prompt
      // Byte-faithful checkouts: an operator's global core.autocrlf=true
      // (the Windows installer default) rewrites LF→CRLF at checkout, and
      // every newline-sensitive file (hook scripts, markers) silently
      // changes bytes. A materialized market is programmatic content —
      // eol translation must never apply.
      GIT_CONFIG_PARAMETERS: "'core.autocrlf=false'",
    },
  });
  return { stdout: stdout ?? "", stderr: stderr ?? "" };
}

/** Recursive copy for local sources — real files/dirs only: symlinks are
 *  skipped (a link can point outside the tree; a market is a config package
 *  we replicate, not a graph we follow). Dotdirs (.claude-plugin, .git)
 *  ride along like any other entry. */
async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of await readdir(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = join(src, entry.name);
    const to = join(dest, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
}

/** Remove a materialization; drop the (now maybe empty) parent so a failed
 *  add strands nothing. */
async function removeMaterialization(dir: string, env: NodeJS.ProcessEnv): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  try {
    await rmdir(marketplacesDir(env));
  } catch {
    /* other markets exist — keep the parent */
  }
}

/** `git clone --depth 1` into dest; a failed clone cleans its partial dir
 *  and surfaces a typed git error. No directory assumptions — callers place
 *  the destination (markets AND plugin installs share this one path). */
async function cloneRepo(url: string, ref: string | undefined, dest: string, run: RunGit): Promise<void> {
  try {
    await run(["clone", "--depth", "1", ...(ref !== undefined ? ["--branch", ref] : []), url, dest], {});
  } catch (err) {
    await rm(dest, { recursive: true, force: true }); // a failed clone can leave a partial dir
    throw new MarketplaceError("git", `git clone failed for ${url}: ${oneLine(gitErrorText(err))}`);
  }
}

/** Clone a MARKET materialization into the marketplaces dir. */
async function gitClone(url: string, ref: string | undefined, dest: string, env: NodeJS.ProcessEnv, run: RunGit): Promise<void> {
  await mkdir(marketplacesDir(env), { recursive: true });
  try {
    await cloneRepo(url, ref, dest, run);
  } catch (err) {
    await removeMaterialization(dest, env); // also drops the parent when this was the only market
    throw err;
  }
}

function gitUrlOf(parsed: MarketSource): { url: string; ref?: string } {
  return parsed.kind === "github"
    ? { url: `https://github.com/${parsed.repo}.git`, ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}) }
    : parsed.kind === "git"
      ? { url: parsed.url, ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}) }
      : { url: "" };
}

/** The registry stores the ORIGINAL input, except local paths which are
 *  stored RESOLVED — a relative source must still re-find its tree when
 *  update/remove run from a different cwd. */
function sourceForRegistry(parsed: MarketSource, input: string): string {
  return parsed.kind === "localDir" || parsed.kind === "localJson" ? parsed.path : input;
}

/** Refuse a name that is already taken: once by the registry (the real
 *  duplicate-add case) and once by an orphan dir (a crash between
 *  materialize and register) — overwriting either would be destructive. */
async function assertNameFree(registry: readonly MarketplaceInfo[], name: string, env: NodeJS.ProcessEnv): Promise<void> {
  const existing = registry.find((e) => e.name === name);
  if (existing !== undefined) {
    throw new MarketplaceError("already-exists", `marketplace "${name}" already exists (added from ${existing.source}) — remove it first or pass a different name`);
  }
  if (existsSync(join(marketplacesDir(env), name))) {
    throw new MarketplaceError("already-exists", `${join(marketplacesDir(env), name)} exists but is not a registered marketplace — remove the directory by hand and retry`);
  }
}

function assertSafeName(name: string): void {
  if (!isSafeName(name)) {
    throw new MarketplaceError("invalid-name", `marketplace name "${name}" is not a safe directory name (letter/digit first, then [A-Za-z0-9._-], ≤64 chars, no trailing . _ -)`);
  }
}

// ---------------------------------------------------------------------------
// add / list / update / remove
// ---------------------------------------------------------------------------

/** Add a market. The name is `opts.name` when given, else the
 *  materialized manifest's own `name` (CC's rule — that is why git/localDir
 *  sources stage into a scratch dir first: the name cannot be known before
 *  the manifest exists). Failures strand nothing: a scratch or invalid
 *  materialization is removed before the typed error leaves. */
export async function marketplaceAdd(
  source: string,
  opts: { name?: string } = {},
  deps: MarketplaceDeps = {},
): Promise<MarketplaceInfo> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runGitDefault;
  const parsed = parseMarketSource(source);
  if (parsed === undefined) {
    throw new MarketplaceError(
      "invalid-source",
      `cannot parse marketplace source "${source}" — expected owner/repo, a git URL (optional #ref), an existing marketplace directory, or a marketplace.json path`,
    );
  }
  const registry = await readRegistry(env);
  // An EXPLICIT name is checked before any materialization: a duplicate add
  // must fail fast, not after a pointless clone.
  if (opts.name !== undefined) {
    assertSafeName(opts.name);
    await assertNameFree(registry, opts.name, env);
  }

  if (parsed.kind === "localJson") {
    let text: string;
    try {
      text = await readFile(parsed.path, "utf8");
    } catch (err) {
      throw new MarketplaceError("invalid-source", `cannot read ${parsed.path}: ${errorMessage(err)}`);
    }
    const file = parseMarketplaceText(text, parsed.path);
    const name = opts.name ?? file.name;
    assertSafeName(name);
    if (opts.name === undefined) await assertNameFree(registry, name, env);
    const dir = join(marketplacesDir(env), name);
    await mkdir(join(dir, ".claude-plugin"), { recursive: true });
    await writeFile(join(dir, ".claude-plugin", "marketplace.json"), text, "utf8");
    const info: MarketplaceInfo = {
      name,
      source: sourceForRegistry(parsed, source.trim()),
      addedAt: new Date().toISOString(),
      ...(file.description !== undefined ? { description: file.description } : {}),
    };
    await writeRegistry([...registry, info], env);
    return info;
  }

  // github | git | localDir — stage, read the manifest for the name, move.
  const staging = newStagingPath(env);
  const { file, name } = await (async (): Promise<{ file: MarketplaceFile; name: string }> => {
    try {
      switch (parsed.kind) {
        case "github":
        case "git": {
          const { url, ref } = gitUrlOf(parsed);
          await gitClone(url, ref, staging, env, run);
          break;
        }
        case "localDir": {
          try {
            await copyTree(parsed.path, staging);
          } catch (err) {
            throw new MarketplaceError("invalid-source", `cannot copy ${parsed.path}: ${errorMessage(err)}`);
          }
          break;
        }
        default:
          throw new MarketplaceError("invalid-source", "unsupported source");
      }
      const file = readMarketplaceFile(staging);
      // The name checks run INSIDE this cleanup scope: an unsafe manifest
      // name or a duplicate add must take the whole staged copy with them —
      // a leaked .staging-* dir is a full orphaned clone.
      const name = opts.name ?? file.name;
      assertSafeName(name);
      if (opts.name === undefined) await assertNameFree(registry, name, env);
      return { file, name };
    } catch (err) {
      await removeMaterialization(staging, env);
      throw err;
    }
  })();
  const dir = join(marketplacesDir(env), name);
  try {
    await rename(staging, dir);
  } catch (err) {
    await removeMaterialization(staging, env);
    // Lost a race: another add renamed the same name into place between the
    // freeness check and this rename — map the raw fs code to the typed error.
    if (isRenameCollision(err)) {
      throw new MarketplaceError("already-exists", `marketplace "${name}" appeared while adding — it already exists; remove it first or pick another name`);
    }
    throw err;
  }
  const info: MarketplaceInfo = {
    name,
    source: sourceForRegistry(parsed, source.trim()),
    addedAt: new Date().toISOString(),
    ...(file.description !== undefined ? { description: file.description } : {}),
  };
  try {
    await writeRegistry([...registry, info], env);
  } catch (err) {
    await removeMaterialization(dir, env); // never leave an unregistered materialization
    throw err;
  }
  return info;
}

export async function marketplaceList(deps: MarketplaceDeps = {}): Promise<readonly MarketplaceInfo[]> {
  return readRegistry(deps.env ?? process.env);
}

export async function marketplaceUpdate(name: string, deps: MarketplaceDeps = {}): Promise<MarketplaceInfo> {
  const env = deps.env ?? process.env;
  const run = deps.run ?? runGitDefault;
  const registry = await readRegistry(env);
  const idx = registry.findIndex((e) => e.name === name);
  const entry = registry[idx];
  if (entry === undefined) throw new MarketplaceError("not-found", `marketplace "${name}" is not registered`);
  const parsed = parseMarketSource(entry.source);
  if (parsed === undefined) {
    throw new MarketplaceError("invalid-source", `registered source "${entry.source}" for marketplace "${name}" no longer parses — edit ${marketplaceRegistryPath(env)}`);
  }
  const dir = join(marketplacesDir(env), name);
  switch (parsed.kind) {
    case "github":
    case "git": {
      if (existsSync(dir)) {
        try {
          await run(["-C", dir, "pull", "--ff-only"], { cwd: dir });
        } catch (err) {
          throw new MarketplaceError("git", `git pull failed for marketplace "${name}": ${oneLine(gitErrorText(err))}`);
        }
      } else {
        // hand-deleted materialization — the registry is the truth, so
        // re-clone rather than strand a registered-but-absent market
        const { url, ref } = gitUrlOf(parsed);
        await gitClone(url, ref, dir, env, run);
      }
      break;
    }
    case "localDir": {
      // stage + swap (add's pattern): a failed re-copy must never degrade
      // the live market the registry still points at — copy to scratch,
      // then swap in one rm+rename once the copy is known good
      const staging = newStagingPath(env);
      try {
        await copyTree(parsed.path, staging);
        await rm(dir, { recursive: true, force: true });
        await rename(staging, dir);
      } catch (err) {
        await removeMaterialization(staging, env);
        throw new MarketplaceError("invalid-source", `cannot re-copy ${parsed.path}: ${errorMessage(err)}`);
      }
      break;
    }
    case "localJson": {
      let text: string;
      try {
        text = await readFile(parsed.path, "utf8");
      } catch (err) {
        throw new MarketplaceError("invalid-source", `cannot read ${parsed.path}: ${errorMessage(err)}`);
      }
      parseMarketplaceText(text, parsed.path); // validate before replacing
      await mkdir(join(dir, ".claude-plugin"), { recursive: true });
      await writeFile(join(dir, ".claude-plugin", "marketplace.json"), text, "utf8");
      break;
    }
  }
  const file = readMarketplaceFile(dir); // upstream went bad → typed error, registry untouched
  const updated: MarketplaceInfo = {
    name: entry.name,
    source: entry.source,
    addedAt: entry.addedAt, // update never re-dates the market
    ...(file.description !== undefined ? { description: file.description } : {}),
  };
  if (registry[idx]?.description !== updated.description) {
    registry[idx] = updated;
    await writeRegistry(registry, env);
  }
  return updated;
}

export async function marketplaceRemove(name: string, deps: MarketplaceDeps = {}): Promise<{ removedPlugins: readonly string[] }> {
  const env = deps.env ?? process.env;
  const registry = await readRegistry(env);
  const idx = registry.findIndex((e) => e.name === name);
  if (idx === -1) throw new MarketplaceError("not-found", `marketplace "${name}" is not registered`);
  // Cascade FIRST (so a failing uninstall surfaces before the market is
  // gone and the plugins become orphaned).
  const removedPlugins = await uninstallPluginsOfMarket(name, env, deps.warn ?? defaultWarn);
  await removeMaterialization(join(marketplacesDir(env), name), env);
  registry.splice(idx, 1);
  await writeRegistry(registry, env);
  return { removedPlugins };
}

/** Uninstall every plugin this market installed — BOTH scopes (A2: project
 *  records carry their workspace root; one without a root cannot be located
 *  without guessing → warned + kept). Reads the install registry TOLERANTLY:
 *  a malformed registry uninstalls NOTHING and SAYS SO on `warn` — guessing
 *  deletions from a file we cannot parse would be worse than leaving dirs
 *  behind, but skipping silently would look like a clean remove. Every
 *  removed id also loses its enabledPlugins key (no stale disables). */
async function uninstallPluginsOfMarket(market: string, env: NodeJS.ProcessEnv, warn: (msg: string) => void): Promise<readonly string[]> {
  const path = installedPluginsPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(`${path} is not valid JSON — no installed plugins removed for marketplace "${market}" (fix or remove it by hand)`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn(`${path} must be a JSON array — no installed plugins removed for marketplace "${market}" (fix or remove it by hand)`);
    return [];
  }
  const kept: unknown[] = [];
  const removedIds: string[] = [];
  const removed = new Set<string>(); // one name in two scopes is one plugin to the user
  const userPluginsRoot = join(resolveGlobalHome(env), "plugins");
  for (const item of parsed) {
    if (!isRecord(item)) {
      kept.push(item); // not shaped enough to touch — untouched
      continue;
    }
    const name = item["name"];
    if (typeof name !== "string" || !isSafeName(name) || item["market"] !== market) {
      kept.push(item); // not ours — untouched
      continue;
    }
    if (item["scope"] === "project") {
      const root = item["root"];
      if (typeof root !== "string" || root === "") {
        warn(`${path}: project-scope plugin "${name}" has no "root" — its directory is left in place (fix the record or remove the directory by hand)`);
        kept.push(item);
        continue;
      }
      await rm(join(root, ".wudao", "plugins", name), { recursive: true, force: true });
    } else {
      // isSafeName guarantees a single clean segment — join stays inside
      // the plugins root; a non-"project" scope is user-side (A1 stance).
      await rm(join(userPluginsRoot, name), { recursive: true, force: true });
    }
    removed.add(name);
    removedIds.push(`${name}@${market}`);
  }
  if (removed.size > 0) {
    const tmp = `${path}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(kept, null, 2)}\n`, "utf8");
    await rename(tmp, path);
  }
  await clearEnabledPluginKeys(removedIds, env, warn);
  return [...removed];
}

// ---------------------------------------------------------------------------
// A2 — the install engine: install / uninstall / enable / list
// ---------------------------------------------------------------------------

/** The 「将安装」 preview counts — what the loader's dry-run would map for the
 *  plugin (skills/commands/agents/hook-commands/MCP servers). */
export interface InstallDetail {
  readonly skills: number;
  readonly commands: number;
  readonly agents: number;
  readonly hooks: number;
  readonly mcp: number;
}

/** One installed.json record. The A1-pinned core {name, market, scope} plus
 *  provenance (version = the entry's declared version, else the plugin
 *  manifest's own; commit = the installed tree's HEAD when it is a git
 *  clone, else the market's HEAD — plain copies carry none) and, for project
 *  scope, the ABSOLUTE workspace root the install lives under (uninstall and
 *  the remove-cascade locate the dir through it — never a cwd guess). */
interface InstalledRecord {
  readonly name: string;
  readonly market: string;
  readonly scope: "user" | "project";
  readonly version?: string;
  readonly commit?: string;
  readonly root?: string;
}

/** One pluginListInstalled row. `adhoc` rows are the session's `--plugin`
 *  mounts (always enabled — explicit user choice, never filtered). */
export interface InstalledPluginRow {
  readonly id: string;
  readonly name: string;
  readonly market: string;
  readonly scope: "user" | "project" | "adhoc";
  readonly enabled: boolean;
  readonly version?: string;
}

/** Strict read of the install registry (machine-written file): absent → [];
 *  malformed → typed registry error naming the path. Writes must never guess
 *  against a registry they cannot fully parse. */
async function readInstalledRegistry(env: NodeJS.ProcessEnv): Promise<InstalledRecord[]> {
  const path = installedPluginsPath(env);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new MarketplaceError("registry", `${path} is not valid JSON — fix or remove it by hand`);
  }
  if (!Array.isArray(parsed)) {
    throw new MarketplaceError("registry", `${path} must be a JSON array — fix or remove it by hand`);
  }
  const out: InstalledRecord[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) {
      throw new MarketplaceError("registry", `${path} has a malformed entry (expected {name, market, scope: "user"|"project"}) — fix or remove it by hand`);
    }
    const name = item["name"];
    const market = item["market"];
    const scope = item["scope"];
    if (typeof name !== "string" || !isSafeName(name) || typeof market !== "string" || !isSafeName(market) || (scope !== "user" && scope !== "project")) {
      throw new MarketplaceError("registry", `${path} has a malformed entry (expected {name, market, scope: "user"|"project"}) — fix or remove it by hand`);
    }
    const root = item["root"];
    out.push({
      name,
      market,
      scope,
      ...(typeof item["version"] === "string" && item["version"] !== "" ? { version: item["version"] } : {}),
      ...(typeof item["commit"] === "string" && item["commit"] !== "" ? { commit: item["commit"] } : {}),
      ...(typeof root === "string" && root !== "" ? { root } : {}),
    });
  }
  return out;
}

async function writeInstalledRegistry(records: readonly InstalledRecord[], env: NodeJS.ProcessEnv): Promise<void> {
  const path = installedPluginsPath(env);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

/** Where a scope's installs live: user → `<globalHome>/plugins/<name>/`,
 *  project → `<workspace>/.wudao/plugins/<name>/`. */
function pluginInstallDir(name: string, scope: "user" | "project", env: NodeJS.ProcessEnv, ws: string): string {
  return scope === "user" ? join(resolveGlobalHome(env), "plugins", name) : join(ws, ".wudao", "plugins", name);
}

function assertSafePluginName(name: string): void {
  if (!isSafeName(name)) {
    throw new MarketplaceError("invalid-name", `plugin name "${name}" is not a safe directory name (letter/digit first, then [A-Za-z0-9._-], ≤64 chars, no trailing . _ -)`);
  }
}

/** Classify a plugin entry's source for install. Same grammar as a MARKET
 *  source for the git locations (`owner/repo` shorthand, URL with optional
 *  `#<ref>`); every other form is a PATH resolved against the MARKET ROOT
 *  (not the cwd — `./plugins/x` is the common spelling; a same-shaped bare
 *  `foo/bar` stays a GitHub shorthand, local needs `./` or an absolute
 *  path). A relative source must stay INSIDE the market (fail-closed:
 *  `../` escapes are refused); an absolute path is honored (the user vouched
 *  for the market when adding it). */
function classifyPluginSource(entry: MarketplaceEntry, marketDir: string): { kind: "git"; url: string; ref?: string } | { kind: "dir"; path: string } {
  const parsed = parseMarketSource(entry.source); // classification only — paths re-resolve below
  if (parsed?.kind === "github") return { kind: "git", url: `https://github.com/${parsed.repo}.git` };
  if (parsed?.kind === "git") {
    return { kind: "git", url: parsed.url, ...(parsed.ref !== undefined ? { ref: parsed.ref } : {}) };
  }
  const expanded = entry.source.startsWith("~") ? join(homedir(), entry.source.slice(1)) : entry.source;
  const abs = isAbsolute(expanded) ? expanded : resolve(marketDir, expanded);
  if (!isAbsolute(expanded)) {
    const rel = relative(marketDir, abs);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
      throw new MarketplaceError("invalid-source", `plugin "${entry.name}" source "${entry.source}" escapes the marketplace directory — refused`);
    }
  }
  let info;
  try {
    info = statSync(abs);
  } catch {
    throw new MarketplaceError("invalid-source", `plugin "${entry.name}" source "${entry.source}" resolves to ${abs}, which does not exist`);
  }
  if (!info.isDirectory()) {
    throw new MarketplaceError("invalid-source", `plugin "${entry.name}" source "${entry.source}" resolves to ${abs}, which is not a directory`);
  }
  return { kind: "dir", path: abs };
}

/** HEAD of a materialization when it is a git repo (local-dir markets and
 *  plain copies have no commit — the pin is simply omitted). A HEAD we
 *  cannot read never fails the install. */
async function gitHead(dir: string, run: RunGit): Promise<string | undefined> {
  if (!existsSync(join(dir, ".git"))) return undefined;
  try {
    const { stdout } = await run(["-C", dir, "rev-parse", "HEAD"], { cwd: dir });
    const sha = stdout.trim();
    return /^[0-9a-f]{7,40}$/.test(sha) ? sha : undefined;
  } catch {
    return undefined;
  }
}

/** Install a plugin from a registered market into a scope root. The order is
 *  the contract: everything that can fail WITHOUT side effects (market and
 *  entry lookup, name safety, duplicate/orphan checks, source resolution,
 *  the loader dry-run) runs before anything is written; a mid-install
 *  failure removes the partial destination — the registry is only appended
 *  after the tree is fully in place. Never executes plugin code; a
 *  git-location entry clones exactly like a market add. */
export async function pluginInstall(
  name: string,
  market: string,
  scope: "user" | "project",
  deps: PluginEngineDeps = {},
): Promise<{ dir: string; detail: InstallDetail }> {
  const env = deps.env ?? process.env;
  const ws = deps.workspaceRoot ?? process.cwd();
  const run = deps.run ?? runGitDefault;

  if (!(await readRegistry(env)).some((e) => e.name === market)) {
    throw new MarketplaceError("not-found", `marketplace "${market}" is not registered`);
  }
  assertSafePluginName(name);
  const marketDir = join(marketplacesDir(env), market);
  const entry = readMarketplaceFile(marketDir).plugins.find((p) => p.name === name);
  if (entry === undefined) {
    throw new MarketplaceError("not-found", `marketplace "${market}" has no plugin "${name}"`);
  }

  // Fail-closed against overwrites: one install per (name, market) — and an
  // orphan dir (a crash between copy and register) is reported, never clobbered.
  const installed = await readInstalledRegistry(env);
  const prior = installed.find((r) => r.name === name && r.market === market);
  const dest = pluginInstallDir(name, scope, env, ws);
  if (prior !== undefined) {
    throw new MarketplaceError("already-exists", `plugin "${name}" from marketplace "${market}" is already installed (${prior.scope} scope) — uninstall it first`);
  }
  if (existsSync(dest)) {
    throw new MarketplaceError("already-exists", `${dest} exists but is not a registered install — remove the directory by hand and retry`);
  }

  const src = classifyPluginSource(entry, marketDir);
  let version: string | undefined;
  let detail: InstallDetail;
  try {
    // The dry-run rides the SAME loader discovery uses — counts only, no
    // execution. Git sources must clone before anything can be inspected.
    const inspect =
      src.kind === "git"
        ? await (async () => {
            await mkdir(dirname(dest), { recursive: true });
            await cloneRepo(src.url, src.ref, dest, run);
            return inspectPluginDir(dest, ws);
          })()
        : inspectPluginDir(src.path, ws);
    if (inspect === undefined) {
      throw new MarketplaceError("invalid-plugin", `plugin "${name}" source "${entry.source}" is not a loadable plugin (missing or invalid .claude-plugin/plugin.json) — nothing was installed`);
    }
    if (src.kind === "dir") await copyTree(src.path, dest); // the A1 copier — symlinks never ride
    version = entry.version ?? inspect.version;
    detail = inspect.detail;
  } catch (err) {
    await rm(dest, { recursive: true, force: true }); // never leave a half install behind
    throw err instanceof MarketplaceError ? err : new MarketplaceError("invalid-source", `cannot install plugin "${name}" from ${entry.source}: ${errorMessage(err)}`);
  }

  const commit = (await gitHead(dest, run)) ?? (await gitHead(marketDir, run));
  const record: InstalledRecord = {
    name,
    market,
    scope,
    ...(version !== undefined ? { version } : {}),
    ...(commit !== undefined ? { commit } : {}),
    // A2-review piggyback: project roots store the workspace's REALPATH (raw
    // fallback) — every later root compare (the enabledPlugins filter, the
    // remove cascade, uninstall) normalizes the same way, so a symlinked
    // workspace or macOS /var vs /private/var never splits one workspace in
    // two (fail-open) or names a dir we would refuse to delete.
    ...(scope === "project" ? { root: normalizeWorkspaceRoot(ws) } : {}),
  };
  await writeInstalledRegistry([...installed, record], env);
  return { dir: dest, detail };
}

// ---------------------------------------------------------------------------
// plugin-compat — 本地路径安装：外部（CCB 家族）插件包的直装入口
// ---------------------------------------------------------------------------

/** 本地路径安装的固定市场名：installed.json 里 market="local" 的行就是「从
 *  本地目录直装的外部插件」，与市场安装（market=<市场名>）在登记层天然隔
 *  离；enable/disable/uninstall 经 `<name>@local` 走既有引擎，零新路径。 */
export const LOCAL_PLUGIN_MARKET = "local";

/** 从一个本地目录直装插件（`wudao plugin install <path>`）：dry-run 用同一
 *  个装载器识别格式（claude-plugin 或上游 CCB 家族包），拷入 PROJECT 作用
 *  域 `<workspace>/.wudao/plugins/<name>/`（外部插件与市场安装同根异册，
 *  命名空间即登记侧的 market="local"），登记进 installed.json。与
 *  pluginInstall 同一份契约：可失败的检查全部先于任何写入；中途失败清掉
 *  半成品目录；登记只在树完整落位后追加；永不执行插件代码。 */
export async function pluginInstallLocal(
  source: string,
  deps: PluginEngineDeps = {},
): Promise<{ dir: string; name: string; format: PluginFormat; detail: InstallDetail }> {
  const env = deps.env ?? process.env;
  const ws = deps.workspaceRoot ?? process.cwd();

  // 源路径：`~` 展开 + 相对路径按工作区根解析（与 classifyPluginSource 的
  // 展开规则一致）。
  const expanded = source.startsWith("~") ? join(homedir(), source.slice(1)) : source;
  const src = isAbsolute(expanded) ? expanded : resolve(ws, expanded);
  let info;
  try {
    info = statSync(src);
  } catch {
    throw new MarketplaceError("invalid-source", `cannot read plugin source "${source}" (${src} does not exist) — expected a local plugin directory (or <name>@<market> from a registered marketplace)`);
  }
  if (!info.isDirectory()) {
    throw new MarketplaceError("invalid-source", `plugin source "${source}" (${src}) is not a directory`);
  }

  // dry-run 与 pluginInstall 同一个装载器 — 两种清单格式都能识别与计数。
  const inspect = inspectPluginDir(src, ws);
  if (inspect === undefined) {
    throw new MarketplaceError("invalid-plugin", `"${source}" is not a loadable plugin (neither .claude-plugin/plugin.json nor a CCB-family package.json declaration) — nothing was installed`);
  }
  const name = inspect.name;
  assertSafePluginName(name);

  // fail-closed：同名 local 安装只此一份；孤儿目录（拷贝中途崩溃的残留）
  // 报告而非覆写。
  const installed = await readInstalledRegistry(env);
  const prior = installed.find((r) => r.name === name && r.market === LOCAL_PLUGIN_MARKET);
  const dest = pluginInstallDir(name, "project", env, ws);
  if (prior !== undefined) {
    throw new MarketplaceError("already-exists", `plugin "${name}" is already installed from a local path (${prior.scope} scope) — uninstall it first`);
  }
  if (existsSync(dest)) {
    throw new MarketplaceError("already-exists", `${dest} exists but is not a registered install — remove the directory by hand and retry`);
  }

  try {
    await copyTree(src, dest); // A1 同款拷贝器 — symlink 永不随行
  } catch (err) {
    await rm(dest, { recursive: true, force: true }); // never leave a half install behind
    throw err instanceof MarketplaceError ? err : new MarketplaceError("invalid-source", `cannot install plugin "${name}" from ${source}: ${errorMessage(err)}`);
  }

  const record: InstalledRecord = {
    name,
    market: LOCAL_PLUGIN_MARKET,
    scope: "project",
    ...(inspect.version !== undefined ? { version: inspect.version } : {}),
    // project 根存工作区 realpath（与 pluginInstall 同一 A2-review 规则）
    root: normalizeWorkspaceRoot(ws),
  };
  await writeInstalledRegistry([...installed, record], env);
  return { dir: dest, name, format: inspect.format ?? "claude-plugin", detail: inspect.detail };
}

/** Resolve an install id — `"<name>@<market>"` exact, or a bare `<name>` that
 *  must hit exactly one record. Zero hits → not-found; a bare name with
 *  several hits → ambiguous (the message names every candidate). */
function resolveInstalledId(id: string, installed: readonly InstalledRecord[], env: NodeJS.ProcessEnv): InstalledRecord {
  const at = id.indexOf("@"); // neither names nor markets can contain "@" (isSafeName)
  const matches =
    at === -1
      ? installed.filter((r) => r.name === id)
      : installed.filter((r) => r.name === id.slice(0, at) && r.market === id.slice(at + 1));
  if (matches.length === 0) {
    throw new MarketplaceError("not-found", `no installed plugin matches "${id}"`);
  }
  if (matches.length > 1) {
    throw new MarketplaceError(
      "ambiguous",
      at === -1
        ? `"${id}" is installed from several marketplaces (${matches.map((r) => `${r.name}@${r.market}`).join(", ")}) — use "<name>@<market>"`
        : `"${id}" is installed more than once (${matches.map((r) => r.scope).join(", ")}) — fix ${installedPluginsPath(env)} by hand`,
    );
  }
  return matches[0]!;
}

/** Uninstall: remove the scope dir, drop the record, and clear the id's
 *  enabledPlugins key (a stale disable must not hit a future install of the
 *  same name). A project record without its root cannot be located without
 *  GUESSING where its directory lives — the A2 review removed the old
 *  `root ?? deps.workspaceRoot ?? process.cwd()` fallback chain (a cwd guess
 *  could delete a same-named dir in a different workspace); the op now
 *  mirrors the remove-cascade's stance: warn, keep the record, delete
 *  nothing. */
export async function pluginUninstall(id: string, deps: PluginEngineDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? defaultWarn;
  const installed = await readInstalledRegistry(env);
  const match = resolveInstalledId(id, installed, env);
  if (match.scope === "project" && match.root === undefined) {
    warn(
      `${installedPluginsPath(env)}: project-scope plugin "${match.name}" has no "root" — nothing was uninstalled (fix the record or remove ${join("<workspace>", ".wudao", "plugins", match.name)} by hand)`,
    );
    return;
  }
  const ws = match.scope === "project" ? (match.root as string) : process.cwd();
  await rm(pluginInstallDir(match.name, match.scope, env, ws), { recursive: true, force: true });
  await writeInstalledRegistry(
    installed.filter((r) => r !== match),
    env,
  );
  await clearEnabledPluginKeys([`${match.name}@${match.market}`], env, warn);
}

/** Enable/disable a plugin via the GLOBAL settings' enabledPlugins map
 *  (`<name>@<market>` → false). Default = installed = enabled: disabling
 *  writes the key, re-enabling DELETES it (an absent key is the default —
 *  the settings file stays minimal). Discovery (plugins.ts) filters on it. */
export async function pluginEnable(id: string, on: boolean, deps: PluginEngineDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  const match = resolveInstalledId(id, await readInstalledRegistry(env), env);
  const key = `${match.name}@${match.market}`;
  await mutateEnabledPlugins(env, (map) => {
    if (on) {
      if (!(key in map)) return false; // already default-enabled
      delete map[key];
      return true;
    }
    if (map[key] === false) return false; // already disabled
    map[key] = false;
    return true;
  });
}

/** List the installed plugins (registry + enable state), plus the session's
 *  `--plugin` mounts as adhoc rows when deps carry them. */
export async function pluginListInstalled(deps: PluginEngineDeps = {}): Promise<readonly InstalledPluginRow[]> {
  const env = deps.env ?? process.env;
  const ws = deps.workspaceRoot ?? process.cwd();
  const disabled = await disabledPluginIds(env);
  const rows: InstalledPluginRow[] = (await readInstalledRegistry(env)).map((r) => {
    const id = `${r.name}@${r.market}`;
    return {
      id,
      name: r.name,
      market: r.market,
      scope: r.scope,
      enabled: !disabled.has(id),
      ...(r.version !== undefined ? { version: r.version } : {}),
    };
  });
  for (const p of deps.adhocPaths ?? []) {
    const inspect = inspectPluginDir(resolve(ws, p), ws);
    if (inspect === undefined) continue;
    rows.push({
      id: inspect.name,
      name: inspect.name,
      market: "adhoc",
      scope: "adhoc",
      enabled: true,
      ...(inspect.version !== undefined ? { version: inspect.version } : {}),
    });
  }
  return rows;
}

async function disabledPluginIds(env: NodeJS.ProcessEnv): Promise<ReadonlySet<string>> {
  const raw = (await readGlobalSettings(env))["enabledPlugins"];
  const out = new Set<string>();
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) if (value === false) out.add(key);
  }
  return out;
}

/** Apply `mutate` to the enabledPlugins map and save the global settings when
 *  it changed. The map is machine-managed (only this engine writes it): a
 *  malformed value is REPLACED, not trusted; an emptied map drops the key
 *  entirely (absent = default). `warn` given → a save failure warns (the
 *  caller's dir/registry writes already happened); absent → it throws (a
 *  failed enable/disable must not look like it succeeded). */
async function mutateEnabledPlugins(
  env: NodeJS.ProcessEnv,
  mutate: (map: Record<string, boolean>) => boolean,
  warn?: (msg: string) => void,
): Promise<void> {
  const settings = await readGlobalSettings(env);
  const raw = settings["enabledPlugins"];
  const map: Record<string, boolean> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"))
      : {};
  if (!mutate(map)) return;
  if (Object.keys(map).length === 0) delete settings["enabledPlugins"];
  else settings["enabledPlugins"] = map;
  try {
    await saveGlobalSettings(settings, env);
  } catch (err) {
    if (warn !== undefined) warn(`could not update enabledPlugins: ${errorMessage(err)}`);
    else throw err;
  }
}

/** Remove ids from enabledPlugins (uninstall + the remove-cascade) so a stale
 *  disable cannot linger over a future install of the same name. */
async function clearEnabledPluginKeys(ids: readonly string[], env: NodeJS.ProcessEnv, warn: (msg: string) => void): Promise<void> {
  if (ids.length === 0) return;
  await mutateEnabledPlugins(
    env,
    (map) => {
      let changed = false;
      for (const id of ids) {
        if (id in map) {
          delete map[id];
          changed = true;
        }
      }
      return changed;
    },
    warn,
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Scratch path for stage-then-rename materializations. Hidden `.` prefix —
 *  registry names can never collide with it (NAME_RE starts alnum), and the
 *  residue tests key on it. */
function newStagingPath(env: NodeJS.ProcessEnv): string {
  return join(marketplacesDir(env), `.staging-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
}

/** fs.rename onto an existing dir: the collision codes a losing concurrent
 *  add can see (ENOTEMPTY = target dir non-empty, EEXIST/ENOTDIR = target
 *  exists as the wrong shape). */
function isRenameCollision(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  // win32 surfaces a rename onto an existing non-empty dir as EPERM (not
  // ENOTEMPTY) — same race, same platform-native spelling.
  return code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR"
    || (process.platform === "win32" && code === "EPERM");
}
