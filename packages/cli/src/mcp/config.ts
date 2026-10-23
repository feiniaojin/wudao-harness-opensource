// `.wudao/mcp.json` loader (M17) + the M57 global tier. MCP servers are
// OPTIONAL: a missing file is silent (no servers); a malformed file or bad
// entry warns and is skipped — the CLI must never crash over an optional
// integration config.
//
// M57 §1 layering: `~/.wudao/mcp.json` (WUDAO_GLOBAL_HOME-aware) merges
// under the project file with PER-SERVER-NAME REPLACEMENT (CC semantics —
// a project server with the same name fully replaces the global one; no
// field-level merging of server commands).
//
// CC-format compatibility: every tier ALSO accepts the Claude Code/Cursor
// shape — a top-level `mcpServers` object instead of our `servers` — so a
// config copied verbatim from a CC setup just works (the per-server entries
// are already shape-identical: {command, args, env}; unknown CC fields like
// `type`/`cwd` are tolerated by the whitelist validation). `servers` wins
// when a file carries both. The project root additionally reads Claude
// Code's own project file `.mcp.json` — an existing CC project lights up
// with zero copying. Full layer order (later replaces same-name):
//   ~/.wudao/mcp.json  →  <root>/.mcp.json  →  <root>/.wudao/mcp.json
//
// P2-16a（96 队列 #16）: a server entry is one of two MUTUALLY EXCLUSIVE
// transports — `command` (stdio, the M17 shape, byte-stable) or `url`
// (streamable HTTP; http:// plaintext only as explicitly written — never
// rewritten/upgraded). The discriminator is structural ("url" in server):
// no injected kind field, so the stdio shape stays exactly as M17 parsed it.
import { truncateSafe } from "@wudao/core"; // 113-A4
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveGlobalHome } from "../settings-layer.js";

export interface McpStdioServerConfig {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** Per-request timeout for tools/call on this server (ms). Default 120_000
   *  (or the settings' mcpTimeouts.requestMs — the per-server value wins). */
  readonly timeoutMs?: number;
  /** M62 §6: `alwaysLoad: true` guarantees this server's tools ride the
   *  prompt prefix EAGERLY. Today every MCP server is eager by construction
   *  (the M35 boundary: MCP tools never defer), so the key pins that
   *  guarantee explicitly — and carries its cache cost: the prefix tool set
   *  is frozen per session, so any change to an alwaysLoad server's tool
   *  list invalidates the prefix cache for the session's first request. */
  readonly alwaysLoad?: true;
}

/** The `url` transport entry (P2-16a): a remote MCP server over streamable
 *  HTTP. `headers` is the static-token lane (Authorization etc.); P2-16b's
 *  `oauth: true` switches on the dynamic Bearer lane (`/mcp auth <name>`).
 *  Header values are SECRETS: they never appear in logs, error text or trace
 *  records (see mcp/http.ts). When both lanes carry an Authorization header
 *  the DYNAMIC token wins (it is set after the static merge, per request). */
export interface McpHttpServerConfig {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly alwaysLoad?: true;
  /** P2-16b: explicit opt-in to the OAuth lane — no 401 auto-sniffing (v1
   *  zero implicit behavior). Only literal `true` counts. */
  readonly oauth?: true;
  /** Optional explicit endpoints (skip discovery's config fallback lane):
   *  both must be absolute http(s) URLs to be usable. */
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  /** Public-client PKCE: some AS require a client_id. Optional. */
  readonly clientId?: string;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

/** Structural discriminator (no injected kind field — stdio entries keep
 *  their exact M17 shape). */
export function isHttpMcpServer(server: McpServerConfig): server is McpHttpServerConfig {
  return "url" in server;
}

export interface McpConfig {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
}

export const EMPTY_MCP_CONFIG: McpConfig = { servers: {} };

export function mcpConfigPath(cwd: string): string {
  return join(cwd, ".wudao", "mcp.json");
}

/** The project-root `.mcp.json` — Claude Code's own project-tier filename.
 *  Read as the tier BETWEEN global and `.wudao/mcp.json`, so a wudao-native
 *  entry always wins the name clash and CC projects migrate by osmosis. */
export function ccMcpConfigPath(cwd: string): string {
  return join(cwd, ".mcp.json");
}

/** The global tier's mcp.json (`~/.wudao/mcp.json`). */
export function globalMcpConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveGlobalHome(env), "mcp.json");
}

/** Per-header value cap: overlong values are truncated with a warning (4 KiB
 *  is far beyond any real token — the warn makes the cut visible instead of
 *  silently breaking auth). */
export const MAX_MCP_HEADER_VALUE_CHARS = 4096;

/** Header names the transport owns — a static config header may not override
 *  them (dropped with a warning; the entry survives). */
const RESERVED_HEADER_NAMES: ReadonlySet<string> = new Set([
  "content-type", "accept", "mcp-session-id", "host", "content-length",
]);

/** RFC 7230 token (a legal header name). */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Must parse as an absolute http/https URL (explicit scheme required — no
 *  implicit upgrades or rewrites of any kind). */
function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Whitelist-style header passthrough: names must be RFC 7230 tokens and
 *  values strings (anything else invalidates the ENTRY — fail-visible);
 *  transport-owned names drop with a warning; overlong values truncate with
 *  a warning. Returns undefined when a header is structurally invalid. */
function normalizeHeaders(
  name: string, headers: Record<string, unknown>, warn: (msg: string) => void,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [h, v] of Object.entries(headers)) {
    if (!HEADER_NAME_RE.test(h) || typeof v !== "string") return undefined;
    const lower = h.toLowerCase();
    if (RESERVED_HEADER_NAMES.has(lower)) {
      warn(`mcp server "${name}" header "${lower}" is transport-owned; dropping it`);
      continue;
    }
    if (v.length > MAX_MCP_HEADER_VALUE_CHARS) {
      out[h] = truncateSafe(v, MAX_MCP_HEADER_VALUE_CHARS);
      warn(`mcp server "${name}" header "${h}" exceeds ${MAX_MCP_HEADER_VALUE_CHARS} chars; value truncated (auth will likely fail)`);
      continue;
    }
    out[h] = v;
  }
  return out;
}

/** The fail-visible reason for a rejected entry (readMcpFile/plugin warn
 *  text — names the actual rule that failed, not a generic "no command"). */
function describeBadServer(raw: unknown): string {
  if (typeof raw !== "object" || raw === null) return `must be an object`;
  const { command, url, args, env, headers, oauth, authorizationUrl, tokenUrl, clientId } = raw as Record<string, unknown>;
  if (command !== undefined && url !== undefined) return `has both "command" and "url" (mutually exclusive — pick one transport)`;
  if (typeof url === "string" && url.length > 0) {
    if (!isHttpUrl(url)) return `has an invalid "url" (must be an absolute http:// or https:// URL)`;
    if (args !== undefined || env !== undefined) return `is a url entry but carries stdio-only fields ("args"/"env")`;
    if (headers !== undefined) return `has invalid "headers" (must be a flat {name: string-value} map with token-legal names)`;
    if (oauth !== undefined && oauth !== true) return `has "oauth" that is not the literal true`;
    if ((authorizationUrl !== undefined || tokenUrl !== undefined) && (typeof authorizationUrl !== "string" || !isHttpUrl(authorizationUrl) || typeof tokenUrl !== "string" || !isHttpUrl(tokenUrl))) {
      return `has invalid "authorizationUrl"/"tokenUrl" (both required, both absolute http(s) URLs)`;
    }
    if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) return `has an invalid "clientId" (must be a non-empty string)`;
  } else if (command !== undefined && (oauth !== undefined || authorizationUrl !== undefined || tokenUrl !== undefined || clientId !== undefined)) {
    return `is a stdio (command) entry but carries http-only fields ("oauth"/"authorizationUrl"/"tokenUrl"/"clientId")`;
  }
  return `must have a string "command" (stdio) or "url" (http/https)`;
}

/** Parse one mcp.json file into a server map ({} when absent/malformed —
 *  warnings name the file so the tier at fault is visible). */
function readMcpFile(path: string, label: string, warn: (msg: string) => void): Record<string, McpServerConfig> {
  let text: string | undefined;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {}; // no config file → MCP simply off there, no noise
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    warn(`${label} is not valid JSON (${err instanceof Error ? err.message : String(err)}); ignoring it`);
    return {};
  }
  // CC-format compat: `mcpServers` is accepted wherever `servers` is (paste
  // a Claude Code/Cursor config verbatim). `servers` wins when both appear.
  const record = (parsed ?? {}) as { servers?: unknown; mcpServers?: unknown };
  let servers = record.servers;
  if (servers === undefined) servers = record.mcpServers;
  else if (record.mcpServers !== undefined) {
    warn(`${label} has both "servers" and "mcpServers"; using "servers"`);
  }
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    warn(`${label} must have a {"servers": {...}} (or Claude Code-style {"mcpServers": {...}}) object; ignoring it`);
    return {};
  }
  const result: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    const entry = normalizeServer(name, raw, warn);
    if (entry) result[name] = entry;
    else warn(`${label} server "${name}" ${describeBadServer(raw)}; skipping it`);
  }
  return result;
}

/** The three tiers, kept SEPARATE (the /mcp report and the settings page's
 *  mcpList annotate where each server came from; loadMcpConfig folds these
 *  same maps). Key order: user → root → project, the replacement chain. */
export interface McpTiers {
  readonly user: Record<string, McpServerConfig>;
  readonly root: Record<string, McpServerConfig>;
  readonly project: Record<string, McpServerConfig>;
}

/** Read all three tiers WITHOUT folding (per-tier maps, replacement still
 *  expressed by name presence in a later tier). */
export function loadMcpTiers(cwd: string, warn: (msg: string) => void = () => {}): McpTiers {
  return {
    user: readMcpFile(globalMcpConfigPath(), "global mcp.json", warn),
    root: readMcpFile(ccMcpConfigPath(cwd), ".mcp.json", warn),
    project: readMcpFile(mcpConfigPath(cwd), "mcp.json", warn),
  };
}

/** The effective MCP config: global tier first, then the project-root
 *  `.mcp.json` (CC compat), then the wudao project tier — each REPLACING
 *  same-name servers (M57 §1 — per-server-name replacement, not merge). */
export function loadMcpConfig(cwd: string, warn: (msg: string) => void = () => {}): McpConfig {
  const tiers = loadMcpTiers(cwd, warn);
  const servers: Record<string, McpServerConfig> = { ...tiers.user };
  for (const [name, entry] of Object.entries(tiers.root)) servers[name] = entry;
  for (const [name, entry] of Object.entries(tiers.project)) servers[name] = entry;
  return { servers };
}

/** Validate + normalize one server entry; undefined when the entry is not a
 *  usable stdio {command, args?, env?, timeoutMs?, alwaysLoad?} or http
 *  {url, headers?, timeoutMs?, alwaysLoad?} (command/url mutually
 *  exclusive). M36: also used by the plugin loader for plugin-level
 *  mcp.json/.mcp.json, so both sources share rules. M62 §6: `alwaysLoad`
 *  counts only as the literal `true`. The optional `warn` receives the
 *  per-header details (reserved-name drops, truncations) — the entry stays
 *  usable in those cases, so they warn instead of rejecting. */
export function normalizeServer(name: string, raw: unknown, warn: (msg: string) => void = () => {}): McpServerConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { command, url, args, env, headers, timeoutMs, alwaysLoad, oauth, authorizationUrl, tokenUrl, clientId } = raw as Record<string, unknown>;
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs <= 0)) return undefined;
  if (command !== undefined && url !== undefined) return undefined; // mutually exclusive transports
  // stdio form (the M17 shape — unchanged, byte-stable).
  if (typeof command === "string" && command.length > 0) {
    if (headers !== undefined) return undefined; // http-only field on a stdio entry
    if (oauth !== undefined || authorizationUrl !== undefined || tokenUrl !== undefined || clientId !== undefined) return undefined; // P2-16b: http-only oauth fields
    if (args !== undefined && !Array.isArray(args)) return undefined;
    if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) return undefined;
    return {
      command,
      ...(args !== undefined ? { args: args as readonly string[] } : {}),
      ...(env !== undefined ? { env: env as Record<string, string> } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(alwaysLoad === true ? { alwaysLoad: true } : {}),
    };
  }
  // http form (P2-16a; P2-16b adds the optional oauth lane fields).
  if (typeof url === "string" && url.length > 0 && isHttpUrl(url)) {
    if (args !== undefined || env !== undefined) return undefined; // stdio-only fields on a url entry
    if (oauth !== undefined && oauth !== true) return undefined; // only the literal true counts
    const hasAuthUrls = authorizationUrl !== undefined || tokenUrl !== undefined;
    if (hasAuthUrls && (typeof authorizationUrl !== "string" || !isHttpUrl(authorizationUrl) || typeof tokenUrl !== "string" || !isHttpUrl(tokenUrl))) return undefined; // both, both absolute
    if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) return undefined;
    let normalizedHeaders: Record<string, string> | undefined;
    if (headers !== undefined) {
      if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return undefined;
      normalizedHeaders = normalizeHeaders(name, headers as Record<string, unknown>, warn);
      if (normalizedHeaders === undefined) return undefined;
    }
    return {
      url,
      ...(normalizedHeaders !== undefined ? { headers: normalizedHeaders } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(alwaysLoad === true ? { alwaysLoad: true } : {}),
      ...(oauth === true ? { oauth: true } : {}),
      ...(typeof authorizationUrl === "string" && typeof tokenUrl === "string" ? { authorizationUrl, tokenUrl } : {}),
      ...(typeof clientId === "string" && clientId.length > 0 ? { clientId } : {}),
    };
  }
  return undefined;
}
