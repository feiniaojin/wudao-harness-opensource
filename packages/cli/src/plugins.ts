// M36: Claude Code plugin compatibility. A plugin = a directory with
// `.claude-plugin/plugin.json` ({name, version?, description?}). Discovery
// (A2): `.wudao/plugins/<dir>/` (project scope) + `<globalHome>/plugins/<dir>/`
// (user scope, after the project root) + `--plugin <path>` (one-shot mount);
// the global `enabledPlugins` filter (key `<name>@<market>`, resolved through
// the install registry) hides disabled installs from every mapping below.
//
// Plugins are CONFIG packages, not programs: their assets are mapped READ-ONLY
// onto mechanisms wudao already has —
//   skills/*/SKILL.md     → the skills system (same LoadedSkill list, tagged)
//   commands/*.md         → slash commands sharing the /skill: submission path
//   .mcp.json | mcp.json  → merged into MCP startup (user mcp.json wins)
//   hooks/hooks.json      → merged into the hooks config (event-name mapping)
//   agents/*.md           → translated AgentRoleProfiles in the roster's
//                           plugin layer (builtin < plugin < workspace, M40)
// Nothing is executed here: `*.ts/js` payloads and `themes/` are warned about
// and skipped. The only code a plugin can cause to run is hook/MCP commands
// the USER's config could equally declare — the same trust decision as
// hand-writing .wudao/settings.json. (The INSTALL engine — marketplace.ts —
// copies plugin dirs into the two roots; this file only ever reads them.)
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isProviderName } from "@wudao/providers";
// Provider management: the `model:` shorthand gate widens to registry ids.
import { loadEffectiveProfiles } from "./provider-registry.js";
import { loadSkillsUnderDir, parseSkillFrontmatter } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
// cc-plugins D2: the unified substitution expander (commands and skills share it).
import { expandSubstitutions } from "./skill-expand.js";
import { normalizeServer } from "./mcp/config.js";
import type { McpConfig, McpServerConfig } from "./mcp/config.js";
import type { HookCommandConfig, HooksSettings, CanonicalHookEvent } from "./hooks-config.js";
import { CANONICAL_HOOK_EVENTS } from "./hooks-config.js";
import type { AgentRoleProfile, RosterPluginAgent } from "@wudao/core";
import { readGlobalSettingsSync, resolveGlobalHome } from "./settings-layer.js";

export type PluginWarn = (msg: string) => void;

function defaultWarn(msg: string): void {
  process.stderr.write(`⚠️ ${msg}\n`);
}

export interface PluginManifest {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
}

/** A `commands/<name>.md` slash command: frontmatter description + a prompt
 *  template body (`$ARGUMENTS` / `$1..` placeholders). Invoked as
 *  `/<name> args` — the EXPANDED template rides the same submission pipeline
 *  as `/skill:name`. */
export interface PluginCommand {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the defining commands/<name>.md. */
  readonly filePath: string;
  /** Template text with the frontmatter stripped (placeholders intact). */
  readonly body: string;
  readonly plugin: string;
}

/** An `agents/<name>.md` CC agent translated to our roster: frontmatter
 *  name/description/tools?/model? + the markdown body as systemPrompt. */
export interface PluginAgent {
  /** The translated profile (id = the frontmatter name). */
  readonly profile: AgentRoleProfile;
  /** Absolute path of the defining agents/<file>.md. */
  readonly filePath: string;
  readonly plugin: string;
}

export interface LoadedPlugin {
  readonly name: string;
  readonly version?: string;
  readonly description?: string;
  /** Absolute plugin directory. */
  readonly dir: string;
  readonly source: "plugins-dir" | "flag";
  /** cc-plugins D2: the install scope the dir came from — "project"
   *  (.wudao/plugins, repo-carried), "user" (<globalHome>/plugins, the
   *  user's own install decision), or "flag" (an explicit --plugin mount).
   *  Stamped onto the plugin's skills as pluginScope, where it keys the
   *  dynamic-injection trust tier (skill-expand.skillInjectionTrusted). */
  readonly scope: "project" | "user" | "flag";
  /** plugin-compat：清单格式。absent ≡ "claude-plugin"（M36 既有路径的
   *  缺省）；"ccb-family" = 上游包格式（package.json 声明，经
   *  plugin-compat 归一化装载）。仅供 `plugin list --json`/回执展示与测
   *  试钉 — 不参与任何装载语义。 */
  readonly format?: PluginFormat;
  readonly skills: readonly LoadedSkill[];
  readonly commands: readonly PluginCommand[];
  /** M40: translated agents/*.md — collected into the roster's plugin layer
   *  by collectPluginAgents (builtin < plugin < workspace). */
  readonly agents: readonly PluginAgent[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly hooks: HooksSettings;
  /** Everything warn-worthy found while loading this plugin (shown by
   *  `wudao plugin list`). */
  readonly warnings: readonly string[];
}

// ---------------------------------------------------------------------------
// ω99 拆分运动 弧 B re-export 门面——保原 plugins.js 公共面（逐插件装载器族→
// plugin-loaders.ts：五装载器 + frontmatter/工具映射/事件规整 + 内建名册）。
// ---------------------------------------------------------------------------
export { isBuiltinCommandName, parseAgentFrontmatter, mapAgentModel, HOOK_EVENT_MAP, isDir } from "./plugin-loaders.js";
export type { ParsedAgentFrontmatter } from "./plugin-loaders.js";
// plugin-compat：多格式声明门面 — 格式类型 + 上游包格式装载器 + 名字/
// frontmatter 归一化纯函数（marketplace/命令面从这里取，不直连 compat 模块）。
export { loadCcbFamilyPlugin, isCcbFamilyManifest, ccbPluginName, normalizeCcbSkillFrontmatter } from "./plugin-compat.js";
export type { PluginFormat } from "./plugin-compat.js";
import { loadCcbFamilyPlugin } from "./plugin-compat.js";
import type { PluginFormat } from "./plugin-compat.js";
import {
  isBuiltinCommandName, loadPluginSkills, loadPluginCommands, loadPluginAgents,
  loadPluginMcp, loadPluginHooks, scanUnsupportedAssets, isDir,
} from "./plugin-loaders.js";

/** Injection seam for discovery (settings-layer pattern): `env` points the
 *  global home — and therefore the user plugins root + the enabledPlugins
 *  filter — at a test tmpdir. P1-5: `trustSuppressed` drops the PROJECT
 *  scope root (.wudao/plugins — repo-carried) from discovery; the user
 *  scope and every `--plugin` flag mount are explicit user choices and
 *  always load. Absent = no gate (byte-stable default). */
export interface PluginLoadDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly trustSuppressed?: boolean;
}

/** Load every plugin: `.wudao/plugins/*` (project scope, sorted by dir name),
 *  then `<globalHome>/plugins/*` (user scope, sorted — A2's install root), then
 *  the `--plugin <path>` mounts in argv order (relative paths resolve against
 *  the workspace root). Duplicate plugin names: first wins (project over user,
 *  any root over a flag mount), later ones warn. A plugin disabled through the
 *  global `enabledPlugins` map is skipped silently — the disable IS the intent;
 *  `--plugin` mounts are never filtered (explicit user choice). Never throws
 *  — a broken plugin warns and is skipped whole. */
export function loadPlugins(
  workspaceRoot: string,
  extraPaths: readonly string[] = [],
  warn: PluginWarn = defaultWarn,
  deps: PluginLoadDeps = {},
): readonly LoadedPlugin[] {
  const byName = new Map<string, LoadedPlugin>();
  const env = deps.env ?? process.env;
  const disabled = disabledPluginKeys(env, workspaceRoot, warn);

  const loadDir = (dir: string, source: "plugins-dir" | "flag", scope: "project" | "user" | "flag"): void => {
    const plugin = loadOnePlugin(dir, workspaceRoot, source, warn, scope);
    if (plugin === undefined) return;
    const existing = byName.get(plugin.name);
    if (existing) {
      warn(`plugin name "${plugin.name}" already loaded from ${existing.dir}; skipping ${plugin.dir}`);
      return;
    }
    for (const w of plugin.warnings) warn(w);
    byName.set(plugin.name, plugin);
  };

  // Project root first (it shadows the user root), user root second. P1-5:
  // an untrusted workspace's project root is skipped entirely (warn once
  // when it was actually present) — a clone must not mount its own plugins.
  const suppressProject = deps.trustSuppressed === true;
  if (suppressProject) {
    try {
      readdirSync(join(workspaceRoot, ".wudao", "plugins"));
      warn(`⚠️ project plugins (.wudao/plugins) skipped — workspace not trusted (/trust to review)`);
    } catch {
      /* absent — nothing to suppress, no noise */
    }
  }
  const roots: readonly { dir: string; tag: "project" | "user" }[] = [
    ...(suppressProject ? [] : [{ dir: join(workspaceRoot, ".wudao", "plugins"), tag: "project" as const }]),
    { dir: join(resolveGlobalHome(env), "plugins"), tag: "user" },
  ];
  for (const root of roots) {
    let entries: readonly Dirent[];
    try {
      entries = [...readdirSync(root.dir, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      continue; // no plugins dir → that scope is simply off, no noise
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue; // files (installed.json) are not plugins
      if (disabled.has(`${root.tag}:${entry.name}`)) continue;
      loadDir(join(root.dir, entry.name), "plugins-dir", root.tag);
    }
  }
  for (const p of extraPaths) loadDir(resolve(workspaceRoot, p), "flag", "flag");

  return [...byName.values()];
}

/** One install-registry record as discovery needs it (the strict shape lives
 *  in marketplace.ts — this tolerant mirror only maps dirs to ids). */
interface InstalledRecordRef {
  readonly name: string;
  readonly market: string;
  readonly scope: "user" | "project";
  readonly root?: string;
}

/** The enabledPlugins filter, reduced to the set of `<tag>:<dirName>` keys
 *  discovery must skip. The settings map names ids (`<name>@<market>`);
 *  discovery only knows a dir name + which root it came from, so the install
 *  registry bridges the two. A project record counts ONLY for the workspace
 *  in its `root` — one workspace's disable never leaks into another. */
function disabledPluginKeys(env: NodeJS.ProcessEnv, workspaceRoot: string, warn: PluginWarn): ReadonlySet<string> {
  const settings = readGlobalSettingsSync(env);
  const raw = settings["enabledPlugins"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return new Set();
  const disabledIds = new Set<string>();
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === false) disabledIds.add(key);
  }
  if (disabledIds.size === 0) return new Set();

  const skip = new Set<string>();
  for (const record of readInstalledRecordsTolerant(env, warn)) {
    if (!disabledIds.has(`${record.name}@${record.market}`)) continue;
    if (record.scope === "user") skip.add(`user:${record.name}`);
    else if (record.scope === "project" && sameWorkspaceRoot(record.root, workspaceRoot)) skip.add(`project:${record.name}`);
  }
  return skip;
}

/** `<globalHome>/plugins/installed.json` (== marketplace.installedPluginsPath
 *  — deliberately re-derived here so plugins.ts never imports its own importer)
 *  read TOLERANTLY: discovery must never die on a corrupt registry — warn
 *  once, filter nothing. (The install engine's reader is strict; that
 *  asymmetry is the point: writes guess nothing, reads break nothing.) */
function readInstalledRecordsTolerant(env: NodeJS.ProcessEnv, warn: PluginWarn): readonly InstalledRecordRef[] {
  const path = join(resolveGlobalHome(env), "plugins", "installed.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(`${path} is not valid JSON — plugin enable/disable states ignored (fix or remove it by hand)`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    warn(`${path} must be a JSON array — plugin enable/disable states ignored`);
    return [];
  }
  const out: InstalledRecordRef[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec["name"] !== "string" || typeof rec["market"] !== "string") continue;
    if (rec["scope"] !== "user" && rec["scope"] !== "project") continue;
    out.push({
      name: rec["name"],
      market: rec["market"],
      scope: rec["scope"],
      ...(typeof rec["root"] === "string" && rec["root"] !== "" ? { root: rec["root"] } : {}),
    });
  }
  return out;
}

/** Load + validate one plugin dir. undefined (with a warning) when it is not a
 *  usable plugin. `scope` is the install scope (D2's trust-tier input); the
 *  inspect path passes "project" (a preview has no live scope). */
function loadOnePlugin(
  dir: string,
  workspaceRoot: string,
  source: "plugins-dir" | "flag",
  warn: PluginWarn,
  scope: "project" | "user" | "flag",
): LoadedPlugin | undefined {
  const manifestPath = join(dir, ".claude-plugin", "plugin.json");
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    // plugin-compat：无 claude-plugin 清单 → 尝试上游 CCB 家族包格式
    // （package.json 声明）。有标记按上游语义装载；无标记（普通 npm 包）
    // 返回 undefined — 两种格式都不是才是「不是插件」。
    const ccb = loadCcbFamilyPlugin(dir, workspaceRoot, source, warn, scope);
    if (ccb !== undefined) return ccb;
    warn(`${dir} has no .claude-plugin/plugin.json and no CCB-family package.json declaration (dsh/engines.dsh); not a plugin`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`plugin ${dir}: .claude-plugin/plugin.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); skipping plugin`);
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as Record<string, unknown>)["name"] !== "string" || ((parsed as Record<string, unknown>)["name"] as string) === "") {
    warn(`plugin ${dir}: manifest must be an object with a string "name"; skipping plugin`);
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const manifest: PluginManifest = {
    name: record["name"] as string,
    ...(typeof record["version"] === "string" && record["version"] !== "" ? { version: record["version"] } : {}),
    ...(typeof record["description"] === "string" ? { description: record["description"] } : {}),
  };

  const warnings: string[] = [];
  const skills = loadPluginSkills(dir, workspaceRoot, manifest.name, scope, warnings);
  const commands = loadPluginCommands(dir, manifest.name, warnings);
  const agents = loadPluginAgents(dir, manifest.name, warnings);
  const mcpServers = loadPluginMcp(dir, manifest.name, warnings);
  const hooks = loadPluginHooks(dir, manifest.name, warnings);
  scanUnsupportedAssets(dir, manifest.name, warnings);

  return {
    name: manifest.name,
    ...(manifest.version !== undefined ? { version: manifest.version } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    dir,
    source,
    scope,
    format: "claude-plugin",
    skills,
    commands,
    agents,
    mcpServers,
    hooks,
    warnings,
  };
}

/** Dry-run result for one plugin dir: the same asset counts discovery would
 *  map (the install engine's 「将安装」 preview) + the manifest identity. */
export interface PluginInspect {
  readonly name: string;
  readonly detail: Readonly<{ skills: number; commands: number; agents: number; hooks: number; mcp: number }>;
  readonly version?: string;
  /** plugin-compat：dry-run 识别出的清单格式（安装回执展示用）。 */
  readonly format?: PluginFormat;
  readonly warnings: readonly string[];
}

/** Run the loader over a plugin dir WITHOUT wiring it anywhere — the install
 *  preview's counting path (no execution; the loader only ever reads files).
 *  undefined when the dir is not a loadable plugin. */
export function inspectPluginDir(dir: string, workspaceRoot: string): PluginInspect | undefined {
  const plugin = loadOnePlugin(dir, workspaceRoot, "plugins-dir", () => {}, "project");
  if (plugin === undefined) return undefined;
  return {
    name: plugin.name,
    detail: {
      skills: plugin.skills.length,
      commands: plugin.commands.length,
      agents: plugin.agents.length,
      hooks: countHookCommands(plugin.hooks),
      mcp: Object.keys(plugin.mcpServers).length,
    },
    ...(plugin.version !== undefined ? { version: plugin.version } : {}),
    format: plugin.format ?? "claude-plugin",
    warnings: plugin.warnings,
  };
}


// ---------------------------------------------------------------------------
// Workspace-root normalization (A2 review piggyback, landed with A3)
// ---------------------------------------------------------------------------

/** The canonical spelling of a workspace path: realpath when it resolves
 *  (symlinks, macOS /var vs /private/var, worktrees), the raw input when it
 *  does not (a deleted/phantom root must still compare/serialize, never
 *  throw). Project-scope install records store this form, so every later
 *  root compare — whatever spelling the live session hands in — matches. */
export function normalizeWorkspaceRoot(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Root equality under aliasing: both sides normalize (realpath with the raw
 *  fallback), then compare. Without this, a project-scope record written from
 *  one spelling silently fails-open against another (`record.root ===
 *  workspaceRoot` was strict string equality). */
export function sameWorkspaceRoot(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined || a === "" || b === "") return false;
  if (a === b) return true;
  return normalizeWorkspaceRoot(a) === normalizeWorkspaceRoot(b);
}

// ---------------------------------------------------------------------------
// Merges (the seams index.ts feeds)
// ---------------------------------------------------------------------------

/** Workspace skills first, then plugin skills; a plugin skill whose name is
 *  already loaded warns + is skipped (workspace wins). Returns the input list
 *  untouched when no plugin contributes a skill. */
export function appendPluginSkills(
  base: readonly LoadedSkill[],
  plugins: readonly LoadedPlugin[],
  warn: PluginWarn = defaultWarn,
): readonly LoadedSkill[] {
  const withSkills = plugins.filter((p) => p.skills.length > 0);
  if (withSkills.length === 0) return base;
  const byName = new Map<string, LoadedSkill>(base.map((s) => [s.name, s]));
  const added: LoadedSkill[] = [];
  for (const p of withSkills) {
    for (const s of p.skills) {
      const existing = byName.get(s.name);
      if (existing) {
        warn(`skill name "${s.name}" already loaded from ${existing.filePath}; skipping ${s.filePath}`);
        continue;
      }
      byName.set(s.name, s);
      added.push(s);
    }
  }
  return added.length > 0 ? [...base, ...added] : base;
}

/** Plugin commands in plugin order; cross-plugin name collisions: first
 *  plugin wins with a warning. (Builtin collisions were already filtered at
 *  load time.) */
export function collectPluginCommands(plugins: readonly LoadedPlugin[], warn: PluginWarn = defaultWarn): readonly PluginCommand[] {
  const byName = new Map<string, PluginCommand>();
  for (const p of plugins) {
    for (const c of p.commands) {
      const existing = byName.get(c.name);
      if (existing) {
        warn(`command "/${c.name}" already loaded from plugin "${existing.plugin}"; skipping plugin "${c.plugin}" copy`);
        continue;
      }
      byName.set(c.name, c);
    }
  }
  return [...byName.values()];
}

/** M40 §2: the roster's plugin layer — every translated plugin agent as a
 *  {profile, source} slot for loadRoleProfiles (which layers them builtin <
 *  plugin < workspace). Cross-plugin id collisions: first plugin wins with a
 *  warning; a later plugin never silently redefines an agent another plugin
 *  already contributed. */
export function collectPluginAgents(plugins: readonly LoadedPlugin[], warn: PluginWarn = defaultWarn): readonly RosterPluginAgent[] {
  const byId = new Map<string, RosterPluginAgent>();
  for (const p of plugins) {
    for (const a of p.agents) {
      const existing = byId.get(a.profile.id);
      if (existing) {
        warn(`plugin agent "${a.profile.id}" already loaded from ${existing.source}; skipping plugin "${p.name}" copy (${a.filePath})`);
        continue;
      }
      byId.set(a.profile.id, { profile: a.profile, source: `plugin ${p.name}: agents/${relativeName(a.filePath)}` });
    }
  }
  return [...byId.values()];
}

/** The `<file>.md` basename of an absolute agent path (for receipt labels). */
function relativeName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

/** User mcp.json + plugin servers → the one MCP startup list. User config has
 *  precedence: a plugin server whose name already exists is skipped + warned. */
export function mergeMcpConfigs(
  user: McpConfig,
  plugins: readonly LoadedPlugin[],
  warn: PluginWarn = defaultWarn,
): McpConfig {
  const servers: Record<string, McpServerConfig> = { ...user.servers };
  let added = false;
  for (const p of plugins) {
    for (const [name, server] of Object.entries(p.mcpServers)) {
      if (name in servers) {
        warn(`plugin ${p.name}: MCP server "${name}" already defined in the user mcp.json; skipping plugin side`);
        continue;
      }
      servers[name] = server;
      added = true;
    }
  }
  return added ? { servers } : user;
}

/** User hooks first, plugin hooks appended per event (a user hook always gets
 *  the first word).
 *  ω99-21 — source trust: a PROJECT-scope plugin's onPermissionRequest
 *  entries are stamped denyOnly (harness-stamped in memory; hooks-config's
 *  parse rebuilds entries field-by-field so the flag is never authorable):
 *  .wudao/plugins is agent-writable, and an allow from there is the injected
 *  authorizing itself — such a hook may DENY or stay silent, never ALLOW.
 *  user scope (<globalHome>/plugins) and flag mounts (--plugin) are explicit
 *  human install decisions: their allow stands, still under the immune-ask
 *  ceiling. Other event faces are never stamped (they have no allow-shaped
 *  decision to cap). */
export function mergeHooksSettings(user: HooksSettings, plugins: readonly LoadedPlugin[]): HooksSettings {
  // M63-A review fix: the event-key enumeration is THE shared constant
  // (hooks-config.CANONICAL_HOOK_EVENTS) — a local fixed list here silently
  // STRIPPED the batch-A keys once and would do it again for batch B/C.
  const out: Partial<Record<CanonicalHookEvent, readonly HookCommandConfig[]>> = {};
  for (const event of CANONICAL_HOOK_EVENTS) {
    const merged = [
      ...(user[event] ?? []),
      ...plugins.flatMap((p) =>
        event === "onPermissionRequest" && p.scope === "project"
          ? (p.hooks[event] ?? []).map((entry) => ({ ...entry, denyOnly: true }))
          : p.hooks[event] ?? []),
    ];
    if (merged.length > 0) out[event] = merged;
  }
  return { ...out } as HooksSettings;
}

// ---------------------------------------------------------------------------
// Slash command expansion
// ---------------------------------------------------------------------------

/** Expand a command template through the D2 unified substitution expander
 *  (skill-expand.expandSubstitutions): `$ARGUMENTS` → the whole (trimmed)
 *  arg string, `$ARGUMENTS[N]`/`$N` → shell-quoted positional args
 *  (0-BASED — real Claude Code semantics; the M36-era 1-based reading was
 *  the deviation, and CC's own plugin commands share the 0-based
 *  substituteArguments with skills), missing positions → "". Kept as the
 *  exported seam so existing callers/tests keep their surface. */
export function expandCommandTemplate(body: string, args: string): string {
  return expandSubstitutions(body, { args, skillDir: "", projectDir: "", sessionId: "" });
}

/** The user message `/<name> args` submits: the expanded template in a named
 *  envelope, through the normal prompt path (onPromptSubmit hooks see it like
 *  any prompt — same pipeline as /skill:name). D2: the SAME expander skills
 *  use, with the plugin root as ${CLAUDE_SKILL_DIR} (a command's bundled
 *  scripts are addressable the way a skill's are; projectDir/sessionId are
 *  not defined for commands — occurrences expand empty). */
export function buildPluginCommandMessage(cmd: PluginCommand, args: string): string {
  const pluginRoot = dirname(dirname(cmd.filePath));
  const body = expandSubstitutions(cmd.body, {
    args,
    skillDir: pluginRoot,
    projectDir: "",
    sessionId: "",
  });
  return `<plugin-command name="${cmd.name}" args="${args}">\n${body}\n</plugin-command>`;
}

/** Error text for a plugin command name that no longer resolves (defensive —
 *  parseReplCommand only matches loaded names). */
export function formatPluginCommandError(name: string, commands: readonly PluginCommand[]): string {
  if (commands.length === 0) return `⚠️ no plugin command "/${name}" (no plugins loaded)`;
  const list = commands.map((c) => `  - /${c.name}${c.description ? ` — ${c.description}` : ""} (plugin: ${c.plugin})`).join("\n");
  return `⚠️ no plugin command "/${name}". Available plugin commands:\n${list}`;
}

// ---------------------------------------------------------------------------
// `wudao plugin` CLI face
// ---------------------------------------------------------------------------

// B1: pluginMain (the `wudao plugin` / `/plugin` command face over the A1/A2
// marketplace engine) lives in commands/plugins-command.ts — NOT here. The
// engine (marketplace.ts) and the hot-rescan seam (extension-state.ts) both
// import this module (inspectPluginDir / loadPlugins), so growing engine
// subcommands inside pluginMain here would close a plugins ⇄ marketplace
// import cycle; the repo's import graph is acyclic and stays that way.
// formatPluginList below stays: it is the loader's table that face renders.

/** Total hook commands across every canonical event — A3's rescan count face
 *  (shared with formatPluginList so a widened event set moves both). */
export function countHookCommands(hooks: HooksSettings): number {
  // THE shared event enumeration (hooks-config.CANONICAL_HOOK_EVENTS) — a
  // fixed 4-event list here would silently stop counting when E1 widens the
  // plugin hook map to the full canonical set.
  let count = 0;
  for (const event of CANONICAL_HOOK_EVENTS) count += hooks[event]?.length ?? 0;
  return count;
}

/** One row per plugin (name, version, asset counts, warning count) plus the
 *  warning lines beneath. Read-only: listing never touches the plugin dirs. */
export function formatPluginList(plugins: readonly LoadedPlugin[]): string {
  if (plugins.length === 0) {
    return "no plugins installed — add .wudao/plugins/<name>/.claude-plugin/plugin.json, or mount one with --plugin <path>\n";
  }
  const header = `${"plugin".padEnd(24)} ${"version".padEnd(9)} ${"skills".padStart(6)} ${"cmds".padStart(4)} ${"agents".padStart(6)} ${"mcp".padStart(3)} ${"hooks".padStart(5)} ${"warn".padStart(4)}  description`;
  const lines = [header];
  for (const p of plugins) {
    lines.push(
      `${p.name.padEnd(24)} ${(p.version ?? "-").padEnd(9)} ${String(p.skills.length).padStart(6)} ${String(p.commands.length).padStart(4)} ${String(p.agents.length).padStart(6)} ${String(Object.keys(p.mcpServers).length).padStart(3)} ${String(countHookCommands(p.hooks)).padStart(5)} ${String(p.warnings.length).padStart(4)}  ${p.description ?? ""}`,
    );
    for (const w of p.warnings) lines.push(`  ⚠️ ${w}`);
  }
  return `${lines.join("\n")}\n`;
}
