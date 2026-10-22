// ω99 拆分运动 弧 B：marketplace 源解析层外提（类型/typed 错误/路径推导/
// 名字安全/源语法解析/marketplace.json 读取校验 + 错误文本小工具族——原
// marketplace.ts 模块级段逐字保留；marketplace.ts re-export 门面保公共面）。
import { truncateSafe } from "@wudao/core"; // 113-A4
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { resolveGlobalHome } from "./settings-layer.js";

// ---------------------------------------------------------------------------
// Types + typed errors
// ---------------------------------------------------------------------------

export interface MarketplaceEntry {
  readonly name: string;
  readonly description?: string;
  /** Where the plugin comes from — the upstream formatsemantics: a path RELATIVE to the
   *  market root (`./plugins/x`) or a git location; resolution is A2's
   *  pluginInstall job, the entry just carries the string. the upstream formatalso ships
   *  OBJECT sources ({source:"url"|"git"|"github", …}) — parseEntry
   *  normalizes those into this string form (url passthrough, `url#ref`,
   *  `owner/repo[#ref]`); `local` objects are v1-out-of-scope bad entries. */
  readonly source: string;
  readonly version?: string;
}

export interface MarketplaceInfo {
  readonly name: string;
  readonly source: string;
  readonly addedAt: string;
  readonly description?: string;
}

export type MarketSource =
  | { kind: "github"; repo: string; ref?: string }
  | { kind: "git"; url: string; ref?: string }
  | { kind: "localDir"; path: string }
  | { kind: "localJson"; path: string };

/** Stable failure codes (asserted by tests; surfaced by the B/C entries). */
export type MarketplaceErrorCode =
  | "invalid-source" // parseMarketSource could not classify the input / a plugin source won't resolve
  | "invalid-name" // explicit/derived name is not a safe directory segment
  | "invalid-marketplace" // .claude-plugin/marketplace.json missing/malformed
  | "already-exists" // add/install: the name (or an orphan dir) is taken
  | "not-found" // update/remove/install: no such registered market / plugin / id
  | "invalid-plugin" // install: the entry's source is not a loadable plugin dir
  | "ambiguous" // uninstall/enable: a bare name matches several markets
  | "git" // a git child process failed
  | "registry"; // marketplaces.json / installed.json is corrupt — fix or remove by hand

export class MarketplaceError extends Error {
  readonly code: MarketplaceErrorCode;

  constructor(code: MarketplaceErrorCode, message: string) {
    super(message);
    this.name = "MarketplaceError";
    this.code = code;
  }
}

/** Injection seams (settings-ops/credentials pattern): `env` points the
 *  global home at a test tmpdir; `run` is the git child-process seam. Real
 *  local-git fixtures over file:// are preferred over stubbing `run`.
 *  `warn` sinks non-fatal diagnostics (default: stderr). */
export interface MarketplaceDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: RunGit;
  readonly warn?: (msg: string) => void;
}

export type RunGit = (args: readonly string[], opts: { cwd?: string }) => Promise<{ stdout: string; stderr: string }>;

/** A2 — the install engine's deps: marketplace's seams plus the workspace a
 *  `project`-scope install/uninstall acts on (default process.cwd()) and the
 *  `--plugin` mounts pluginListInstalled should surface as adhoc rows. */
export interface PluginEngineDeps extends MarketplaceDeps {
  readonly workspaceRoot?: string;
  readonly adhocPaths?: readonly string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function marketplacesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "marketplaces");
}

export function marketplaceRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "marketplaces.json");
}

/** The install registry A2's pluginInstall writes; remove's cascade reads. */
export function installedPluginsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "plugins", "installed.json");
}

/** A name must be a safe single directory segment — it is joined under
 *  `<globalHome>/marketplaces/`, so `..`/absolute/separator tricks must
 *  never pass (fail-closed). */
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isSafeName(name: string): boolean {
  return NAME_RE.test(name) && !/[._-]$/.test(name);
}

// ---------------------------------------------------------------------------
// parseMarketSource
// ---------------------------------------------------------------------------

/** Classify a market source string. Order: `owner/repo` shorthand, git URL
 *  (scheme or scp-like, trailing `#<ref>` stripped as the ref), then local
 *  (existing dir, or existing `.json` file). Relative local paths resolve
 *  against the process cwd AT PARSE TIME; undefined = not a source. */
export function parseMarketSource(input: string): MarketSource | undefined {
  const raw = input.trim();
  if (raw === "") return undefined;

  // GitHub shorthand first: `foo/bar` keeps the upstream's GitHub meaning even when a
  // same-shaped relative path happens to exist (the upstream formatdocs use ./ or absolute
  // paths for local sources). cc-plugins E4 final-review M1: the shorthand
  // also carries `#ref` — E1b's object-form normalization emits
  // `owner/repo#ref`, which must round-trip back through install.
  const gh = /^([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)(?:#(\S+))?$/.exec(raw);
  if (gh !== null && gh[1] !== undefined) {
    return gh[2] === undefined ? { kind: "github", repo: gh[1] } : { kind: "github", repo: gh[1], ref: gh[2] };
  }

  const splitRef = (s: string): { url: string; ref?: string } => {
    const hash = s.lastIndexOf("#");
    if (hash === -1) return { url: s };
    const ref = s.slice(hash + 1);
    return ref === "" ? { url: s.slice(0, hash) } : { url: s.slice(0, hash), ref };
  };
  // file:// is a plain git URL — it is also how local-git test fixtures
  // ride the REAL clone path without touching the network.
  if (/^(https?|ssh|git|file):\/\/\S+$/i.test(raw)) {
    const { url, ref } = splitRef(raw);
    if (!/^(https?|ssh|git|file):\/\/\S+$/i.test(url)) return undefined; // everything was the ref ("https://x#" edge)
    return ref === undefined ? { kind: "git", url } : { kind: "git", url, ref };
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:\S+$/.test(raw)) {
    const { url, ref } = splitRef(raw);
    return ref === undefined ? { kind: "git", url } : { kind: "git", url, ref };
  }

  // Local: only existence decides (fail-closed — a typo is not a market).
  const expanded = raw.startsWith("~") ? join(homedir(), raw.slice(1)) : raw;
  const abs = resolve(expanded);
  let info;
  try {
    info = statSync(abs);
  } catch {
    return undefined;
  }
  if (info.isDirectory()) return { kind: "localDir", path: abs };
  if (info.isFile() && abs.endsWith(".json")) return { kind: "localJson", path: abs };
  return undefined;
}

// ---------------------------------------------------------------------------
// readMarketplaceFile
// ---------------------------------------------------------------------------

export interface MarketplaceFile {
  readonly name: string;
  readonly description?: string;
  readonly plugins: readonly MarketplaceEntry[];
  /** Bad plugin entries dropped at parse — callers surface the count. */
  readonly skipped: number;
}

/** Read + validate `<root>/.claude-plugin/marketplace.json`. Unknown fields
 *  (top level and per entry) are ignored; entries without a non-empty
 *  string name AND source are dropped and counted; a missing/invalid file,
 *  name, or `plugins` array is a typed error. */
export function readMarketplaceFile(root: string): MarketplaceFile {
  const path = join(root, ".claude-plugin", "marketplace.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new MarketplaceError("invalid-marketplace", `${root} has no .claude-plugin/marketplace.json — not a marketplace`);
  }
  return parseMarketplaceText(text, path);
}

export function parseMarketplaceText(text: string, label: string): MarketplaceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new MarketplaceError("invalid-marketplace", `${label} is not valid JSON (${errorMessage(err)})`);
  }
  if (!isRecord(parsed)) {
    throw new MarketplaceError("invalid-marketplace", `${label} must be a JSON object`);
  }
  const name = parsed["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new MarketplaceError("invalid-marketplace", `${label} must have a non-empty string "name"`);
  }
  const pluginsRaw = parsed["plugins"];
  if (!Array.isArray(pluginsRaw)) {
    throw new MarketplaceError("invalid-marketplace", `${label} must have a "plugins" array`);
  }
  const plugins: MarketplaceEntry[] = [];
  let skipped = 0;
  for (const item of pluginsRaw) {
    const entry = parseEntry(item);
    if (entry === undefined) {
      skipped += 1;
      continue;
    }
    plugins.push(entry);
  }
  const description = typeof parsed["description"] === "string" ? parsed["description"] : undefined;
  return { name, ...(description !== undefined ? { description } : {}), plugins, skipped };
}

/** One plugins[] entry, or undefined when it is malformed (dropped + counted
 *  — a bad entry must not take the whole market down). The `source` is the
 *  string grammar OR the upstream's object forms (E1b: real markets like obra/
 *  superpowers-marketplace ship objects), normalized by
 *  normalizeEntrySource into the string semantics every downstream consumer
 *  already speaks. */
function parseEntry(item: unknown): MarketplaceEntry | undefined {
  if (!isRecord(item)) return undefined;
  const name = item["name"];
  if (typeof name !== "string" || name.trim() === "") return undefined;
  const source = normalizeEntrySource(item["source"]);
  if (source === undefined) return undefined;
  const description = typeof item["description"] === "string" ? item["description"] : undefined;
  const version = typeof item["version"] === "string" ? item["version"] : undefined;
  return {
    name,
    source,
    ...(description !== undefined ? { description } : {}),
    ...(version !== undefined ? { version } : {}),
  };
}

/** the upstream's per-entry source field: the string form we ship natively (kept
 *  verbatim — relative paths and git locations ride unchanged), or one of the
 *  three object kinds, normalized INTO the string grammar: `url` → the url
 *  passthrough; `git` → `url` (+ `#ref` when given); `github` →
 *  `owner/repo` (+ `#ref`). A url/owner/repo that is not a non-empty string
 *  fails its kind; `local` objects (v1: out of scope) and unknown kinds are
 *  bad entries — undefined, the caller skips + counts. A wrong-typed `ref`
 *  is treated as absent (the entry-optional-field precedent: non-string
 *  description/version are ignored, not fatal). */
function normalizeEntrySource(raw: unknown): string | undefined {
  if (typeof raw === "string") return raw.trim() === "" ? undefined : raw;
  if (!isRecord(raw)) return undefined;
  const kind = raw["source"];
  if (typeof kind !== "string") return undefined;
  const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);
  const ref = nonEmpty(raw["ref"]);
  if (kind === "url") return nonEmpty(raw["url"]);
  if (kind === "git") {
    const url = nonEmpty(raw["url"]);
    return url === undefined ? undefined : ref !== undefined ? `${url}#${ref}` : url;
  }
  if (kind === "github") {
    const owner = nonEmpty(raw["owner"]);
    const repo = nonEmpty(raw["repo"]);
    return owner === undefined || repo === undefined ? undefined : `${owner}/${repo}${ref !== undefined ? `#${ref}` : ""}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Registry (marketplaces.json)
// ---------------------------------------------------------------------------

export function defaultWarn(msg: string): void {
  process.stderr.write(`⚠️ ${msg}\n`);
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** git's failure text: stderr first, then stdout, then the exception —
 *  collapsed to one capped line (stderr is multi-line and never structural
 *  here, just diagnostic). */
export function gitErrorText(err: unknown): string {
  if (err !== null && typeof err === "object") {
    const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    for (const field of [e.stderr, e.stdout, e.message]) {
      if (typeof field === "string" && field.trim() !== "") return field;
    }
  }
  return errorMessage(err);
}

export function oneLine(text: string): string {
  const collapsed = text.split(/\s+/).join(" ").trim();
  return collapsed.length > 300 ? `${truncateSafe(collapsed, 300)}…` : collapsed;
}

