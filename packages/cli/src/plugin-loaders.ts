// ω99 拆分运动 弧 B：plugins 的逐插件装载器族外提（skills/commands/agents/
// mcp/hooks 五装载器 + frontmatter 解析 + CC 工具别名映射 + 事件名规整 +
// 内建命令名册/可执行扩展名/isDir——原 plugins.ts 模块级段逐字保留；
// plugins.ts re-export 门面保公共面）。类型走 type-only 互引（无运行时环）。
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { isProviderName } from "@wudao/providers";
import { loadEffectiveProfiles } from "./provider-registry.js";
import { loadSkillsUnderDir, parseSkillFrontmatter } from "./skills.js";
import type { LoadedSkill } from "./skills.js";
import { normalizeServer } from "./mcp/config.js";
import type { McpServerConfig } from "./mcp/config.js";
import type { HookCommandConfig, HooksSettings, CanonicalHookEvent } from "./hooks-config.js";
import { CANONICAL_HOOK_EVENTS } from "./hooks-config.js";
import type { PluginAgent, PluginCommand } from "./plugins.js";

/** Builtin slash commands a plugin command must not shadow (warn + skip).
 *  `skill:` is a prefix — the whole /skill: namespace is builtin. B1 added
 *  `plugin` (the /plugin command face); provider/add-dir/doctor/tasks predate
 *  this list and are routed by parseReplCommand before plugin names anyway. */
const BUILTIN_COMMAND_NAMES: readonly string[] = ["exit", "quit", "clear", "help", "resume", "plan", "rewind", "skill", "compact", "context", "edit", "tree", "switch", "memory", "search", "status", "cost", "rename", "diff", "config", "init", "model", "effort", "permissions", "export", "review", "security-review", "mcp", "agents", "?", "loop", "goal", "schedule", "plugin", "trust", "mission"];

function isBuiltinCommandName(name: string): boolean {
  return BUILTIN_COMMAND_NAMES.includes(name) || name.startsWith("skill:");
}

/** Parse-time guard for the same rule (defense in depth: even if a caller
 *  registers a builtin-named plugin command, the REPL/TUI parser refuses to
 *  route it — builtins always win). */
export { isBuiltinCommandName };

/** Executable extensions we refuse to run (config packages only). */
const EXECUTABLE_EXTS = new Set([".ts", ".js", ".mjs", ".cjs"]);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** `skills/<name>/SKILL.md` → the same LoadedSkill list the workspace roots
 *  feed, tagged with the plugin name. Duplicate names within a plugin: first
 *  wins. D2: each skill also carries the plugin's install scope
 *  (pluginScope) — the dynamic-injection trust tier reads it at invocation. */
export function loadPluginSkills(
  dir: string,
  workspaceRoot: string,
  plugin: string,
  scope: "project" | "user" | "flag",
  warnings: string[],
): readonly LoadedSkill[] {
  const loaded = loadSkillsUnderDir(join(dir, "skills"), workspaceRoot, (m) => warnings.push(m), plugin);
  const byName = new Map<string, LoadedSkill>();
  for (const s of loaded) {
    const existing = byName.get(s.name);
    if (existing) {
      warnings.push(`skill name "${s.name}" already loaded from ${existing.filePath}; skipping ${s.filePath}`);
      continue;
    }
    byName.set(s.name, { ...s, pluginScope: scope });
  }
  return [...byName.values()];
}

/** `commands/*.md` → slash commands. Name = file stem; a stem colliding with
 *  a builtin command is warned + skipped (builtins always win). */
export function loadPluginCommands(dir: string, plugin: string, warnings: string[]): readonly PluginCommand[] {
  const root = join(dir, "commands");
  let entries: readonly Dirent[];
  try {
    entries = [...readdirSync(root, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return []; // no commands dir → no commands (silent)
  }
  const out: PluginCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(root, entry.name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue; // unreadable → skip the file
    }
    const stem = entry.name.slice(0, -3);
    if (isBuiltinCommandName(stem)) {
      warnings.push(`plugin ${plugin}: command "${stem}" collides with a builtin command; skipping ${filePath}`);
      continue;
    }
    out.push({
      name: stem,
      description: parseSkillFrontmatter(text).description,
      filePath,
      body: stripFrontmatter(text),
      plugin,
    });
  }
  return out;
}

/** Everything after a leading `--- … ---` frontmatter block (or the whole
 *  text when there is none). */
function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return text;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") return lines.slice(i + 1).join("\n").replace(/^\n+/, "");
  }
  return text; // unterminated frontmatter — treat the whole file as body
}

// ---------------------------------------------------------------------------
// M40 §2 — CC agents/*.md translation
// ---------------------------------------------------------------------------

/** Frontmatter keys the translation understands; everything else is warned
 *  as unsupported (orchestration fields like `whenToUse` are deliberately
 *  NOT semantic — see the spec's "不做"). */
const AGENT_FRONTMATTER_FIELDS: ReadonlySet<string> = new Set(["name", "description", "tools", "model", "memory"]);

export interface ParsedAgentFrontmatter {
  readonly name: string | undefined;
  readonly description: string;
  /** Raw comma list from `tools:` (untranslated — the caller maps it). */
  readonly tools: string | undefined;
  /** Raw `model:` value (the caller maps it to a provider/model pin). */
  readonly model: string | undefined;
  /** M64-B §B: the `memory:` tier (project|local|user; junk → undefined and
   *  the caller warns). */
  readonly memory: "project" | "local" | "user" | undefined;
  /** Keys seen that the translation does not support (warned, listed). */
  readonly unknownFields: readonly string[];
  /** Everything after the frontmatter (the agent's prompt body). */
  readonly body: string;
}

/** Parse a CC agent markdown file's frontmatter — the same tolerant
 *  line-style parse as skills (`key: value`, quotes stripped, prose lines
 *  ignored). Unterminated/absent frontmatter → the whole text is the body. */
export function parseAgentFrontmatter(text: string): ParsedAgentFrontmatter {
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") {
    return { name: undefined, description: "", tools: undefined, model: undefined, memory: undefined, unknownFields: [], body: text };
  }
  let name: string | undefined;
  let description = "";
  let tools: string | undefined;
  let model: string | undefined;
  let memory: "project" | "local" | "user" | undefined;
  const unknownFields: string[] = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "---") break;
    const m = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (!m) continue; // comment, prose, or malformed line — ignored
    const key = m[1] ?? "";
    const value = stripQuotes((m[2] ?? "").trim());
    switch (key) {
      case "name":
        if (value !== "") name = value;
        break;
      case "description":
        description = value;
        break;
      case "tools":
        if (value !== "") tools = value;
        break;
      case "model":
        if (value !== "") model = value;
        break;
      case "memory":
        // M64-B §B: the memory tier; anything else parses to undefined (the
        // caller warns and the role defaults to project).
        if (value === "project" || value === "local" || value === "user") memory = value;
        break;
      default:
        unknownFields.push(key);
    }
  }
  return { name, description, tools, model, memory, unknownFields, body: stripFrontmatter(text) };
}

function stripQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

/** CC tool names → ours (the same translation direction as the hook event
 *  map: a CC plugin's assets speak CC vocabulary). */
const CC_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit",
  Bash: "shell",
  Glob: "glob",
  Grep: "grep",
  Task: "task",
  TodoWrite: "todo_write",
};

const NATIVE_AGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file", "write_file", "edit", "shell", "glob", "grep", "todo_write",
  "task", "agent_await", "agent_status", "agent_cancel", "load_tools", "ask_user",
]);

/** Map the `tools:` comma list to toolNames. Order preserved; CC aliases
 *  translated; unknown names warn and drop (the roster's fail-closed
 *  posture — a typo can never widen into an unexpected tool). */
function mapAgentTools(raw: string, filePath: string, plugin: string, warnings: string[]): readonly string[] {
  const out: string[] = [];
  for (const item of raw.split(",")) {
    const name = item.trim();
    if (name === "") continue;
    const native = CC_TOOL_ALIASES[name] ?? name;
    if (NATIVE_AGENT_TOOL_NAMES.has(native) || native.startsWith("ext_") || native.startsWith("mcp__")) {
      out.push(native);
    } else {
      warnings.push(`plugin ${plugin}: ${filePath} agent tool "${name}" is unknown (supported: ${[...NATIVE_AGENT_TOOL_NAMES].join(", ")} + CC aliases ${Object.keys(CC_TOOL_ALIASES).join("/")}); ignored`);
    }
  }
  return out;
}

/** Map the `model:` frontmatter to a provider/model pin. Only values that
 *  name a KNOWN provider pin (exact → provider only; `<provider>-…` →
 *  provider + model); anything else warns and pins nothing (the child runs
 *  on the session model). Provider management: "known" = builtin ∪ registry
 *  (a `my-gateway` pin resolves exactly like a builtin pin); the `<x>-…`
 *  shorthand stays builtin-only (registry ids may contain dashes themselves,
 *  so prefix-splitting them would be ambiguous).
 *  M1 (review round 1): registry ids are CASE-SENSITIVE — the raw spelling
 *  is looked up first (a mixed-case id pins exactly); the historic lowercase
 *  tolerance survives as fallbacks (builtin table, then a case-insensitive
 *  registry hit) so old lowercase-insensitive pins keep working.
 *  R-N1 (T5): ONE trim semantics — the input is trimmed BEFORE every lookup
 *  (whitespace never gates) and the `<provider>-…` shorthand returns the
 *  TRIMMED model, never the raw string.
 *  Exported for the provider-registry gate tests. */
export function mapAgentModel(raw: string): { provider?: string; model?: string } {
  const trimmed = raw.trim();
  const bare = trimmed.toLowerCase();
  const profiles = loadEffectiveProfiles();
  if (profiles.has(trimmed)) return { provider: trimmed };
  if (isProviderName(bare)) return { provider: bare };
  const ciHit = [...profiles.keys()].find((id) => id.toLowerCase() === bare);
  if (ciHit !== undefined) return { provider: ciHit };
  for (const provider of ["deepseek", "glm", "qwen", "wudao", "anthropic"]) {
    if (bare.startsWith(`${provider}-`)) return { provider, model: trimmed };
  }
  // 0.3.12: claude-* model ids name the anthropic builtin (the model id
  // KEEPS its full claude- prefix — that is the real wire name).
  if (bare.startsWith("claude-")) return { provider: "anthropic", model: trimmed };
  return {};
}

/** `agents/*.md` → translated PluginAgents. Name = the frontmatter `name`
 *  (the file stem is NOT authoritative, unlike workspace .json); duplicate
 *  ids within one plugin: first wins. */
export function loadPluginAgents(dir: string, plugin: string, warnings: string[]): readonly PluginAgent[] {
  const root = join(dir, "agents");
  let entries: readonly Dirent[];
  try {
    entries = [...readdirSync(root, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return []; // no agents dir → no agents (silent)
  }
  const out: PluginAgent[] = [];
  const byId = new Map<string, PluginAgent>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(root, entry.name);
    let text: string;
    try {
      text = readFileSync(filePath, "utf8");
    } catch {
      continue; // unreadable → skip the file
    }
    const fm = parseAgentFrontmatter(text);
    if (fm.unknownFields.length > 0) {
      warnings.push(`plugin ${plugin}: ${filePath} has unsupported frontmatter field(s) ${fm.unknownFields.join(", ")} (supported: ${[...AGENT_FRONTMATTER_FIELDS].join("/")}); ignored`);
    }
    if (fm.name === undefined) {
      warnings.push(`plugin ${plugin}: ${filePath} has no "name:" in its frontmatter; skipping agent`);
      continue;
    }
    if (fm.description === "") {
      warnings.push(`plugin ${plugin}: ${filePath} has no "description:" in its frontmatter; skipping agent`);
      continue;
    }
    // M64-B fix round 1: a `name:` that is not a plain path segment would
    // otherwise ride into the roster and (for memory-bearing agents) aim the
    // harness's own memory mkdir/read outside the tier root. Reject here —
    // clearer than the roster's generic id check.
    if (!/^[A-Za-z0-9_-]+$/.test(fm.name)) {
      warnings.push(`plugin ${plugin}: ${filePath} name "${fm.name}" must be letters/digits/_/- (no path separators or dots); skipping agent`);
      continue;
    }
    const existing = byId.get(fm.name);
    if (existing) {
      warnings.push(`plugin ${plugin}: agent name "${fm.name}" already loaded from ${existing.filePath}; skipping ${filePath}`);
      continue;
    }
    // M64-B §B: a junk memory tier warns and stays unset (the project default).
    const rawMemory = /^memory:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (rawMemory !== undefined && rawMemory !== "" && fm.memory === undefined) {
      warnings.push(`plugin ${plugin}: ${filePath} memory "${rawMemory}" is not project|local|user; using the project default`);
    }
    const agent: PluginAgent = {
      profile: {
        id: fm.name,
        description: fm.description,
        systemPrompt: fm.body,
        ...(fm.memory !== undefined ? { memory: fm.memory } : {}),
        ...(fm.tools !== undefined ? { toolNames: mapAgentTools(fm.tools, filePath, plugin, warnings) } : {}),
        ...(() => {
          if (fm.model === undefined) return {};
          const pin = mapAgentModel(fm.model);
          if (pin.provider === undefined && pin.model === undefined) {
            warnings.push(`plugin ${plugin}: ${filePath} model "${fm.model}" names no known provider (deepseek/glm/qwen/wudao/anthropic or <provider>-prefixed); ignored`);
            return {};
          }
          return pin;
        })(),
      },
      filePath,
      plugin,
    };
    byId.set(fm.name, agent);
    out.push(agent);
  }
  return out;
}

/** `.mcp.json` (CC's name) or `mcp.json` (ours); `mcpServers` (CC) or
 *  `servers` (ours) as the server map. `.mcp.json` wins when both exist. */
export function loadPluginMcp(dir: string, plugin: string, warnings: string[]): Readonly<Record<string, McpServerConfig>> {
  const dotted = join(dir, ".mcp.json");
  const bare = join(dir, "mcp.json");
  let path: string | undefined;
  let haveDotted = false;
  let haveBare = false;
  try {
    readFileSync(dotted);
    haveDotted = true;
  } catch {
    /* absent */
  }
  try {
    readFileSync(bare);
    haveBare = true;
  } catch {
    /* absent */
  }
  if (haveDotted && haveBare) {
    warnings.push(`plugin ${plugin}: both .mcp.json and mcp.json present; using .mcp.json`);
    path = dotted;
  } else if (haveDotted) path = dotted;
  else if (haveBare) path = bare;
  else return {}; // no plugin-level MCP config (the common case — silent)

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    warnings.push(`plugin ${plugin}: ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ignoring plugin MCP config`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`plugin ${plugin}: ${path} must be an object with a "mcpServers" (or "servers") map; ignoring plugin MCP config`);
    return {};
  }
  const rec = parsed as Record<string, unknown>;
  const raw = rec["mcpServers"] ?? rec["servers"];
  if (raw === undefined) return {}; // no servers key → nothing declared
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`plugin ${plugin}: ${path} "mcpServers"/"servers" must be an object; ignoring plugin MCP config`);
    return {};
  }
  const out: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    const server = normalizeServer(name, value, (m) => warnings.push(`plugin ${plugin}: ${m}`));
    if (server) out[name] = server;
    else warnings.push(`plugin ${plugin}: mcp server "${name}" must have a string "command" (stdio) or "url" (http/https); skipping it`);
  }
  return out;
}

// CC hook event names → our canonical hook events (the full CANONICAL_HOOK_EVENTS
// surface — 21 configurable events today). Derived FROM the shared constant,
// never re-hardcoded here — the M63-A review finding that killed the
// triplicated fixed list: every canonical key maps to itself, the two v1
// short aliases pass through, and each CC name is the canonical name minus
// the leading "on" — except the two CC renames (UserPromptSubmit / Stop).
// Wudao-specific events with no CC spelling are excluded below so they grow
// no bogus alias. A regular future event lands in the map for free; anything
// else is warned + skipped.
const CC_EVENT_NAME_RENAMES: Readonly<Record<string, string>> = {
  onPromptSubmit: "UserPromptSubmit",
  onRunStop: "Stop",
};

// The anticipated exclusion case arrived with the M64 fleet merge: CC has no
// TeammateIdle hook, so "minus-on" would mint a bogus alias. New wudao-only
// events without a CC face land here.
const CC_EVENT_NAME_EXCLUSIONS: ReadonlySet<string> = new Set(["onTeammateIdle"]);

/** The accepted hooks.json event-key vocabulary → canonical faces. Exported
 *  as the mapping-matrix test seam (the vocabulary contract, pinned
 *  independently in tests/plugins.test.ts). */
export const HOOK_EVENT_MAP: Readonly<Record<string, CanonicalHookEvent>> = {
  ...Object.fromEntries(CANONICAL_HOOK_EVENTS.map((event) => [event, event] as const)),
  preToolUse: "onPreToolUse",
  postToolUse: "onPostToolUse",
  ...Object.fromEntries(
    CANONICAL_HOOK_EVENTS.filter((event) => !CC_EVENT_NAME_EXCLUSIONS.has(event)).map(
      (event) => [CC_EVENT_NAME_RENAMES[event] ?? event.slice(2), event] as const,
    ),
  ),
};

/** `hooks/hooks.json` → HooksSettings. Accepts CC's nested
 *  `{matcher?, hooks:[{type:"command",command}]} groups — the group's
 *  matcher is passed through onto each entry it contributes (CC's matcher
 *  vocabulary, e.g. superpowers' SessionStart "startup|resume", is identical
 *  to our native matcher semantics: comma/pipe exact-match list or RegExp) —
 *  and our flat `{command, timeoutMs?, matcher?}` entries. Every CC event
 *  name maps onto its canonical face (HOOK_EVENT_MAP). */
export function loadPluginHooks(dir: string, plugin: string, warnings: string[]): HooksSettings {
  const path = join(dir, "hooks", "hooks.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // no hooks → nothing (silent)
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warnings.push(`plugin ${plugin}: hooks/hooks.json is not valid JSON (${err instanceof Error ? err.message : String(err)}); ignoring plugin hooks`);
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    warnings.push(`plugin ${plugin}: hooks/hooks.json must be an object; ignoring plugin hooks`);
    return {};
  }
  // CC wraps the event map in a "hooks" key; a bare event map is tolerated.
  const wrapped = (parsed as Record<string, unknown>)["hooks"];
  const eventMap: unknown = typeof wrapped === "object" && wrapped !== null && !Array.isArray(wrapped) ? wrapped : parsed;

  const collected: Partial<Record<CanonicalHookEvent, readonly HookCommandConfig[]>> = {};
  for (const [key, value] of Object.entries(eventMap as Record<string, unknown>)) {
    const canonical = HOOK_EVENT_MAP[key];
    if (canonical === undefined) {
      warnings.push(`plugin ${plugin}: unknown hook event "${key}" (supported canonical names: ${CANONICAL_HOOK_EVENTS.join(", ")}; CC spellings like SessionStart/UserPromptSubmit/Stop also accepted); skipped`);
      continue;
    }
    if (!Array.isArray(value)) {
      warnings.push(`plugin ${plugin}: hooks event "${key}" must be an array; skipped`);
      continue;
    }
    const commands = parseHookEntries(plugin, dir, key, value, warnings);
    collected[canonical] = [...(collected[canonical] ?? []), ...commands];
  }
  // E1: the collected canonical keys spread straight out — enumerating key
  // names in a fixed return object (the old 4-key form) is exactly what
  // silently dropped every batch-A/B event.
  return { ...collected } as HooksSettings;
}

/** Flatten one event's entry list. Entries: our flat `{command, timeoutMs?,
 *  matcher?}` or a CC matcher group `{matcher?, hooks: […]}` — the group's
 *  matcher is stamped onto every entry it contributes (so superpowers'
 *  SessionStart "startup|resume" reaches our native matcher engine with the
 *  vocabulary intact); an entry's OWN matcher wins over the inherited one,
 *  and entries from groups without a matcher carry no matcher key at all. */
function parseHookEntries(plugin: string, dir: string, event: string, items: readonly unknown[], warnings: string[], groupMatcher?: string): HookCommandConfig[] {
  const out: HookCommandConfig[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`plugin ${plugin}: hooks.${event} entry must be an object; skipped`);
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec["command"] === "string" && rec["command"] !== "") {
      const rawTimeout = rec["timeoutMs"];
      const timeoutMs = typeof rawTimeout === "number" && Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : undefined;
      const ownMatcher = typeof rec["matcher"] === "string" && rec["matcher"] !== "" ? rec["matcher"] : undefined;
      const matcher = ownMatcher ?? groupMatcher;
      out.push({
        command: rec["command"],
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(matcher !== undefined ? { matcher } : {}),
        // E4: every plugin entry carries its install dir — CC's
        // ${CLAUDE_PLUGIN_ROOT} convention consumes it at fire time.
        pluginRoot: dir,
      });
      continue;
    }
    if (Array.isArray(rec["hooks"])) {
      const nested = typeof rec["matcher"] === "string" && rec["matcher"] !== "" ? rec["matcher"] : groupMatcher;
      out.push(...parseHookEntries(plugin, dir, event, rec["hooks"], warnings, nested));
      continue;
    }
    if (typeof rec["type"] === "string" && rec["type"] !== "command") {
      warnings.push(`plugin ${plugin}: hooks.${event} entry type "${rec["type"]}" is not "command" (no code/http execution for plugins); skipped`);
      continue;
    }
    warnings.push(`plugin ${plugin}: hooks.${event} entry must have a string "command"; skipped`);
  }
  return out;
}

/** Warn + skip everything we deliberately do not support. */
export function scanUnsupportedAssets(dir: string, plugin: string, warnings: string[]): void {
  if (isDir(join(dir, "themes"))) {
    warnings.push(`plugin ${plugin}: themes/ are not supported; skipped`);
  }
  // Executable payloads: plugin root + .claude-plugin/, non-recursive.
  for (const scope of [dir, join(dir, ".claude-plugin")]) {
    let entries: readonly Dirent[];
    try {
      entries = readdirSync(scope, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const dot = entry.name.lastIndexOf(".");
      const ext = dot === -1 ? "" : entry.name.slice(dot).toLowerCase();
      if (EXECUTABLE_EXTS.has(ext)) {
        warnings.push(`plugin ${plugin}: executable file ${join(scope, entry.name)} is not run (plugins are config packages — no code execution); skipped`);
      }
    }
  }
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
