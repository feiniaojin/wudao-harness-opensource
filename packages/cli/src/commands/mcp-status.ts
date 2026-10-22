// M55 §B11 — /mcp: server status from the loaded runtime. Three sources
// fold into one row per server:
//   - .wudao/mcp.json (the configured set — a server here with no runtime
//     row failed to start/list);
//   - the loaded tool set (the mcp__<server>__* tools this session actually
//     carries — the connection's user-visible footprint);
//   - the runtime snapshot the MCP bridge records (connected, handshake
//     latency, last tools/call latency, call/error counts).
// Pure formatting over injected inputs; the driver/REPL assemble them.
import type { McpConfig, McpServerConfig, McpTiers } from "../mcp/config.js";
import { isHttpMcpServer, loadMcpConfig, loadMcpTiers } from "../mcp/config.js";
import { mcpRuntimeSnapshot } from "../mcp/tools.js";
import type { McpRuntimeInfo } from "../mcp/tools.js";
import { parseTraceEnv } from "../mcp/trace.js";
import { redactUrl } from "../mcp/http.js";
import { defaultMcpTokenStore } from "../mcp/tokens.js";

/** The tool-name lane: `mcp__<server>__<tool>` → [server → tool count]. */
export function mcpToolCounts(toolNames: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const name of toolNames) {
    if (!name.startsWith("mcp__")) continue;
    const rest = name.slice("mcp__".length);
    const sep = rest.indexOf("__");
    if (sep === -1) continue;
    const server = rest.slice(0, sep);
    counts.set(server, (counts.get(server) ?? 0) + 1);
  }
  return counts;
}

export interface McpServerRow {
  readonly name: string;
  /** The configured command (stdio) or the REDACTED url (http — userinfo and
   *  query stripped in mcp/http.ts; a token in the query never lands here).
   *  "(不在 mcp.json 中)" for runtime-only rows. */
  readonly command: string;
  /** P2-16a: the configured transport; undefined for runtime-only rows.
   *  stdio rows render WITHOUT a transport segment (byte-stable). */
  readonly transport?: "stdio" | "http";
  /** P2-16b: the server declared `oauth: true` — the row gains the auth
   *  status annotation; undefined rows render exactly as before. */
  readonly oauth?: true;
  /** P2-16b: a token exists in the store for this server (authed vs
   *  "auth needed"). Only meaningful with oauth: true. */
  readonly authed?: boolean;
  /** Which tier's entry this row renders (the upstream format-format compat's three tiers);
   *  undefined = runtime-only (not in any mcp.json). */
  readonly source?: "user" | "root" | "project";
  /** The tiers whose same-name entry this row's tier REPLACED (the
   *  per-server-name replacement chain — a project entry shadowing the
   *  user-tier one names "user" here). */
  readonly replaces?: readonly ("user" | "root")[];
  readonly connected: boolean;
  readonly tools: number;
  readonly handshakeMs?: number;
  readonly lastCallMs?: number;
  readonly calls: number;
  readonly errors: number;
  readonly failure?: string;
}

/** The display label for one tier (the source detail line + the settings
 *  page share it). */
export function mcpTierLabel(tier: "user" | "root" | "project"): string {
  return tier === "user" ? "user ~/.wudao/mcp.json" : tier === "root" ? "root .mcp.json" : "project .wudao/mcp.json";
}

/** Fold the three sources into one row per known server (config order first,
 *  runtime-only stragglers after). `authStatus` (P2-16b) answers whether a
 *  server's OAuth token exists (the token store lookup — injected so the
 *  fold stays pure). `tiers` (the the upstream format-format three-tier read) annotates each
 *  configured row with its source tier and the tiers it replaced; absent,
 *  rows render without the source detail line (byte-stable pre-compat). */
export function buildMcpRows(args: {
  readonly config?: McpConfig;
  readonly toolNames: readonly string[];
  readonly runtime?: ReadonlyMap<string, McpRuntimeInfo>;
  readonly authStatus?: (server: string) => boolean;
  readonly tiers?: McpTiers;
}): readonly McpServerRow[] {
  const config = args.config;
  const runtime = args.runtime ?? mcpRuntimeSnapshot();
  const counts = mcpToolCounts(args.toolNames);
  const rows: McpServerRow[] = [];
  const seen = new Set<string>();
  const tierOf = (name: string): { source: "user" | "root" | "project"; replaces: ("user" | "root")[] } | undefined => {
    const t = args.tiers;
    if (t === undefined) return undefined;
    // The replacement chain's WINNER is the last tier carrying the name.
    if (Object.prototype.hasOwnProperty.call(t.project, name)) {
      const replaces: ("user" | "root")[] = [];
      if (Object.prototype.hasOwnProperty.call(t.root, name)) replaces.push("root");
      if (Object.prototype.hasOwnProperty.call(t.user, name)) replaces.push("user");
      return { source: "project", replaces };
    }
    if (Object.prototype.hasOwnProperty.call(t.root, name)) {
      return { source: "root", replaces: Object.prototype.hasOwnProperty.call(t.user, name) ? ["user"] : [] };
    }
    if (Object.prototype.hasOwnProperty.call(t.user, name)) return { source: "user", replaces: [] };
    return undefined;
  };
  const push = (name: string, server: McpServerConfig | undefined): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const info = runtime.get(name);
    const tools = counts.get(name) ?? info?.tools ?? 0;
    // Runtime truth first; a tool-lane-only row (no runtime entry, but this
    // session carries the server's tools — injected sets, tests) counts as
    // connected too. No row and no tools: configured-but-dead.
    const connected = info?.connected === true || (info === undefined && tools > 0);
    const tier = tierOf(name);
    rows.push({
      name,
      command: server === undefined
        ? "(不在 mcp.json 中)" // ω99-180: #1（数据值；ASCII 括号保行语法）
        : isHttpMcpServer(server)
          ? redactUrl(server.url)
          : server.command,
      ...(server !== undefined ? { transport: isHttpMcpServer(server) ? "http" as const : "stdio" as const } : {}),
      ...(server !== undefined && isHttpMcpServer(server) && server.oauth === true
        ? { oauth: true as const, authed: args.authStatus?.(name) === true }
        : {}),
      ...(tier !== undefined ? { source: tier.source, ...(tier.replaces.length > 0 ? { replaces: tier.replaces } : {}) } : {}),
      connected,
      tools,
      ...(info?.handshakeMs !== undefined ? { handshakeMs: info.handshakeMs } : {}),
      ...(info?.lastCallMs !== undefined ? { lastCallMs: info.lastCallMs } : {}),
      calls: info?.calls ?? 0,
      errors: info?.errors ?? 0,
      ...(info?.failure !== undefined ? { failure: info.failure } : {}),
    });
  };
  for (const [name, server] of Object.entries(config?.servers ?? {})) push(name, server);
  for (const name of [...counts.keys(), ...runtime.keys()]) push(name, undefined);
  return rows;
}

function ms(v: number | undefined): string {
  return v === undefined ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
}

/** The /mcp report (notice-rendered). */
export function formatMcpReport(rows: readonly McpServerRow[], opts: { readonly file?: string } = {}): string {
  if (rows.length === 0) {
    return `mcp：未配置服务器（${opts.file ?? "user ~/.wudao/mcp.json · root .mcp.json · project .wudao/mcp.json"} 均无，且未加载任何 mcp__ 工具）`; // ω99-180: #2（tier 串字节不动）
  }
  const lines = [`mcp 服务器（${opts.file ?? "user ~/.wudao/mcp.json · root .mcp.json · project .wudao/mcp.json"} + 已加载的运行时）：`]; // ω99-180: #3（tier 串字节不动）
  for (const r of rows) {
    const state = r.connected
      ? "已连接" // ω99-180: #6
      : r.failure !== undefined
        ? "失败" // ω99-180: #7
        : "已断开"; // ω99-180: #8
    const latency = [`握手 ${ms(r.handshakeMs)}`]; // ω99-180: #9
    if (r.lastCallMs !== undefined) latency.push(`最近调用 ${ms(r.lastCallMs)}`); // ω99-180: #10
    const traffic = r.calls > 0 ? ` · ${r.calls} 次调用${r.errors > 0 ? `，${r.errors} 次错误` : ""}` : ""; // ω99-180: #11（内层逗号全角）
    // P2-16a: http rows carry a transport segment + the redacted URL line;
    // stdio rows render EXACTLY as before (byte-stable). P2-16b: an oauth
    // row appends the auth-status segment — non-oauth rows stay byte-stable.
    const transportTag = r.transport === "http" ? "http · " : "";
    const oauthTag = r.oauth === true ? (r.authed === true ? " · oauth：已授权" : " · oauth：需授权") : ""; // ω99-180: #13（§零.2 与 mcp-oauth:726 strip-regex 锁步）
    lines.push(`  ${r.name}: ${state} · ${transportTag}${r.tools} 个工具 · ${latency.join(" · ")}${traffic}${oauthTag}`); // ω99-180: #12
    if (r.transport === "http") lines.push(`    (${r.command})`);
    if (r.source !== undefined) {
      // The the upstream format-format tier read: where this entry came from + which earlier
      // same-name entries it replaced (one line, the http-url idiom).
      const replaced = r.replaces !== undefined && r.replaces.length > 0
        ? ` · 取代 ${r.replaces.map(mcpTierLabel).join(", ")}` // ω99-180: #14（mcpTierLabel 调用不动）
        : "";
      lines.push(`    (来源：${mcpTierLabel(r.source)}${replaced})`); // ω99-180: #15（ASCII 括号保；tier 串不动）
    }
    if (r.failure !== undefined) lines.push(`    (${r.failure.split("\n")[0] ?? r.failure})`);
  }
  lines.push("  (mcp__ 工具的写入/命令始终询问；结果带 mcp 溯源标记)"); // ω99-180: #4
  // ω-5a I20: one-line trace readout — the env var's resolved mode, so a
  // debugging session can confirm the facility is actually recording.
  lines.push(`  (trace：${parseTraceEnv(process.env.WUDAO_MCP_TRACE)?.mode ?? "off"})`); // ω99-180: #5（label 冒号全角，模式值 token）
  return lines.join("\n");
}

/** End-to-end /mcp: re-read the config + live runtime, fold the tool lane in.
 *  P2-16b: oauth rows also read the token store (authed vs auth needed). */
export function runMcpStatusCommand(args: {
  readonly workspaceRoot: string;
  readonly toolNames: readonly string[];
}): string {
  const warnings: string[] = [];
  const tiers = loadMcpTiers(args.workspaceRoot, (m) => warnings.push(m));
  const config = loadMcpConfig(args.workspaceRoot);
  const tokens = defaultMcpTokenStore().load();
  const report = formatMcpReport(buildMcpRows({
    config,
    tiers,
    toolNames: args.toolNames,
    authStatus: (server) => tokens[server] !== undefined,
  }));
  // Config-load warnings (a malformed tier file is invisible otherwise — the
  // report would just lack that tier's servers with no why).
  return warnings.length > 0 ? `${warnings.join("\n")}\n${report}` : report;
}
