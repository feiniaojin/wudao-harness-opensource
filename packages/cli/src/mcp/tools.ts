// MCP server config → core Tool bridge (M17).
//
// Each configured server is connected AT STARTUP (simpler than lazy connect;
// the server list is small). A server that fails to start/list is skipped
// with a warning — never fatal. Every tool is fail-closed: connection loss,
// timeouts and server-side errors all surface as isError results.
//
// Connected clients live in a module-level registry so any frontend can shut
// them all down via closeMcpTools() at exit.
import { truncateSafe } from "@wudao/core"; // 113-A4
import { buildTool, capOutputLines, type Tool, type ToolParameter, type ToolParameterSchema } from "@wudao/core";
import type { McpConfig, McpServerConfig } from "./config.js";
import { isHttpMcpServer } from "./config.js";
import { JsonRpcClient } from "./json-rpc.js";
import { McpHttpClient } from "./http.js";
import { checkMcpCommand } from "./osv-check.js";
import { createMcpTokenAuth } from "./oauth.js";
import { VERSION } from "../version.js";

const PROTOCOL_VERSION = "2025-06-18";
/** 30s: stdio servers behind uvx/npx pay a cold-cache install (uvx with an
 *  invalidated cache measured 12s+) before the first initialize response —
 *  10s turned every cold start into a false "连接失败". Exported for the
 *  regression pin (a config override via mcpTimeouts.connectMs still wins). */
export const INITIALIZE_TIMEOUT_MS = 30_000;
const DEFAULT_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;

/** M62 §7: the settings' mcpTimeouts node (connect/request/shutdown, ms).
 *  Absent fields keep the defaults above (缺省=现行为). */
export interface McpTimeouts {
  readonly connectMs?: number;
  readonly requestMs?: number;
  readonly shutdownMs?: number;
}

function positiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Parse the `mcpTimeouts` settings node (tolerant — junk fields drop). */
export function parseMcpTimeouts(node: unknown): McpTimeouts {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return {};
  const rec = node as Record<string, unknown>;
  const connectMs = positiveInt(rec["connectMs"]);
  const requestMs = positiveInt(rec["requestMs"]);
  const shutdownMs = positiveInt(rec["shutdownMs"]);
  return {
    ...(connectMs !== undefined ? { connectMs } : {}),
    ...(requestMs !== undefined ? { requestMs } : {}),
    ...(shutdownMs !== undefined ? { shutdownMs } : {}),
  };
}

// Shape of the `result` member of a tools/call response (MCP spec subset).
interface McpCallResult {
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly isError?: boolean;
}

interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

// 夜移 021: MCP text boundary hygiene. Every string an MCP server sends
// across the wire — tool descriptions and tools/call text — is untrusted
// input to both the model's context and any terminal that renders tool
// results. The reference (claude-code mcp-client sanitization) strips C0
// controls and NFC-normalizes server responses; we go one further and also
// strip DEL + the C1 range (CSI-adjacent controls some terminals honor) and
// drop U+FFFD (mojibake smuggling). Tool descriptions additionally carry a
// cap so one verbose server cannot balloon the tool-list prefix.
export const MAX_MCP_DESCRIPTION_CHARS = 2048;

/** C0 controls minus \t\n\r, DEL, C1, and U+FFFD — stripped from all
 *  MCP-sourced text. */
const MCP_TEXT_SCRUB_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFD]/g;

/** NFC-normalize and scrub an MCP-sourced string (pure; idempotent). */
export function sanitizeMcpText(text: string): string {
  if (text.length === 0) return text;
  return text.normalize("NFC").replace(MCP_TEXT_SCRUB_RE, "");
}

/** OpenAI-compatible endpoints validate function names against
 *  ^[a-zA-Z0-9_-]+$ — one foreign character (a dot, a space, CJK…) in ANY
 *  tool name rejects the WHOLE request with a 400 (0.3.81 实机回执:
 *  `Invalid 'tools[N].function.name'`). MCP server ids and tool ids are
 *  foreign data we do not control, so every composed wire name passes
 *  through here: runs of invalid chars collapse to `_`, and an
 *  everything-invalid segment falls back to a stable word. Pure;
 *  idempotent (a sanitized name re-sanitizes to itself). The ORIGINAL ids
 *  stay verbatim in the description and the execute closure (the
 *  tools/call payload keeps addressing the server's real name). */
const WIRE_NAME_INVALID_RE = /[^a-zA-Z0-9_-]+/g;

export function sanitizeWireToolSegment(segment: string, fallback: string): string {
  const safe = segment.replace(WIRE_NAME_INVALID_RE, "_");
  return safe === "" || safe === "_" ? fallback : safe;
}

/** Cap a tool description at MAX_MCP_DESCRIPTION_CHARS with a visible
 *  truncation marker — the model sees that (and how much) text was cut,
 *  never a silently shortened description. */
function capMcpDescription(text: string): string {
  if (text.length <= MAX_MCP_DESCRIPTION_CHARS) return text;
  return `${truncateSafe(text, MAX_MCP_DESCRIPTION_CHARS)} …(+${text.length - MAX_MCP_DESCRIPTION_CHARS} chars truncated)`;
}

/** 夜移 021: the zero-process seam over the buildTool mapping — unit tests
 *  and release evals drive dirty descriptors/results through the exact
 *  boundary the JsonRpcClient wiring uses. */
export interface McpToolDeps {
  /** Execute a tools/call against the server (transport + timeout). */
  readonly call: (args: Record<string, unknown>) => Promise<McpCallResult>;
  /** Report a completed call for the /mcp runtime snapshot (error flag + latency). */
  readonly onCall: (isError: boolean, ms: number) => void;
}

export function mcpToolFromDescriptor(serverName: string, t: McpToolDescriptor, deps: McpToolDeps): Tool {
  return buildTool({
    // Both segments are FOREIGN data (the settings' server id, the server's
    // tool id) — sanitize for the provider wire name only. The execute
    // closure and the description below keep the ORIGINAL t.name: the
    // tools/call payload must address the server's real id, and the human
    // sees what actually got mapped.
    name: `mcp__${sanitizeWireToolSegment(serverName, "server")}__${sanitizeWireToolSegment(t.name, "tool")}`,
    description: capMcpDescription(sanitizeMcpText(
      typeof t.description === "string" && t.description.length > 0
        ? t.description
        : `Tool "${t.name}" from MCP server "${serverName}"`,
    )),
    parameters: toMcpParameters(t.inputSchema),
    // Fail-closed: any transport/timeout/server error becomes isError.
    execute: async (args: Record<string, unknown>) => {
      const callStart = Date.now();
      try {
        const result = await deps.call(args);
        const text = (result?.content ?? [])
          .filter((p) => p?.type === "text" && typeof p.text === "string")
          .map((p) => sanitizeMcpText(p.text as string))
          .join("\n");
        if (result?.isError === true) {
          deps.onCall(true, Date.now() - callStart);
          return { content: text || `mcp server "${serverName}" reported an error for tool "${t.name}"`, isError: true };
        }
        deps.onCall(false, Date.now() - callStart);
        // M49 §4: external-server content carries the MCP provenance mark
        // (taint-tracked by the frontends; never serialized onto messages).
        return { content: text, provenance: "mcp" };
      } catch (err) {
        deps.onCall(true, Date.now() - callStart);
        return { content: `mcp tool "${t.name}" failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
    // Risk flags: an MCP server runs arbitrary external logic — never
    // assume read-only or concurrency-safe. The permission gate treats
    // mcp__* as non-read tools (ask in default mode).
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    // M51 §3: MCP tools are open-world by definition (external server on
    // the network) — the sidecar's tool_flags and any policy layer read it.
    isOpenWorld: () => true,
  });
}

// ---------------------------------------------------------------------------
// P0-2（96 队列 #2）MCP resources 面 — 移植 CC ListMcpResourcesTool /
// ReadMcpResourceTool 到 wudao 的 mcp__<server>__* 桥。
//
// resources/list、resources/read 直接骑 JsonRpcClient.request（协议层零
// 改）。工具面由 initialize 的 capabilities.resources 决定：能力缺失不注
// 册（byte-stable —— 能力决定工具集，静态不抖，prompt 前缀不因服务器面
// 变化）。所有资源文本走夜移 021 的 sanitizeMcpText 边界；渲染输出套
// core 的 capOutputLines 有界。与 CC 的分歧：CC 把两只工具标为只读+并发
// 安全，wudao 沿用 mcp__ 桥的保守姿态（外部服务器跑任意逻辑，方法名不
// 构成安全承诺）——权限管线照旧按 mcp__* ask 处理。
// ---------------------------------------------------------------------------

/** resources/list 结果里的一个资源描述（MCP spec 子集）。 */
interface McpResourceDescriptor {
  readonly uri?: unknown;
  readonly name?: unknown;
  readonly description?: unknown;
  readonly mimeType?: unknown;
}

/** resources/read 结果里的一个内容块（text | blob 二选一）。 */
interface McpResourceContent {
  readonly uri?: unknown;
  readonly mimeType?: unknown;
  readonly text?: unknown;
  readonly blob?: unknown;
}

function asMcpResourceList(result: unknown): unknown {
  return (typeof result === "object" && result !== null
    ? (result as { resources?: unknown }).resources
    : undefined);
}

function asMcpResourceContents(result: unknown): unknown {
  return (typeof result === "object" && result !== null
    ? (result as { contents?: unknown }).contents
    : undefined);
}

/** resources/list → 紧凑清单（每资源一行：`uri [mime] 名称：描述`），
 *  有界。非数组/空/全无效 → 空清单文案（CC 同款语义：没有资源不代表
 *  服务器没有工具）。纯函数，导出供测试与零进程接缝复用。 */
export function renderResourceList(serverName: string, resources: unknown): string {
  const empty = `MCP 服务器 "${serverName}" 没有声明资源（服务器仍可能提供工具）。`;
  if (!Array.isArray(resources)) return empty;
  const lines: string[] = [];
  for (const r of resources) {
    if (typeof r !== "object" || r === null) continue;
    const d = r as McpResourceDescriptor;
    if (typeof d.uri !== "string" || d.uri.length === 0) continue; // 无 uri 的条目不可读，不列
    const parts = [d.uri];
    if (typeof d.mimeType === "string" && d.mimeType.length > 0) parts.push(`[${d.mimeType}]`);
    if (typeof d.name === "string" && d.name.length > 0) parts.push(d.name);
    let line = `- ${sanitizeMcpText(parts.join(" "))}`;
    if (typeof d.description === "string" && d.description.length > 0) {
      line += `：${sanitizeMcpText(d.description)}`;
    }
    lines.push(line);
  }
  if (lines.length === 0) return empty;
  return capOutputLines(`${lines.length} 个资源来自 MCP 服务器 "${serverName}"：\n${lines.join("\n")}`);
}

/** resources/read → 内容块渲染：每块 `[uri mime?]` 头 + 文本正文；blob
 *  只报解码字节数（base64 永不进入上下文 —— CC persistBinaryContent 的
 *  无落盘版本）；无法识别的块给显式标记。整体套 capOutputLines。 */
export function renderResourceContents(serverName: string, uri: string, contents: unknown): string {
  const empty = `MCP 服务器 "${serverName}" 的资源 "${uri}" 返回了空内容。`;
  if (!Array.isArray(contents)) return empty;
  const blocks: string[] = [];
  for (const c of contents) {
    if (typeof c !== "object" || c === null) continue;
    const d = c as McpResourceContent;
    const entryUri = typeof d.uri === "string" && d.uri.length > 0 ? d.uri : uri;
    const mime = typeof d.mimeType === "string" && d.mimeType.length > 0 ? ` ${d.mimeType}` : "";
    const head = sanitizeMcpText(`${entryUri}${mime}`);
    if (typeof d.text === "string") {
      blocks.push(`[${head}]\n${sanitizeMcpText(d.text)}`);
    } else if (typeof d.blob === "string") {
      const bytes = Buffer.from(d.blob, "base64").length;
      blocks.push(`[${head} · 二进制 ${bytes} 字节，base64 不进入上下文]`);
    } else {
      blocks.push(`[${head} · 无法渲染的内容]`);
    }
  }
  if (blocks.length === 0) return empty;
  return capOutputLines(blocks.join("\n\n"));
}

/** 夜移 021 同款零进程接缝，但给 resources 面：单测/发布评估直接驱动
 *  渲染与 fail-closed 边界，不 spawn 服务器进程。 */
export interface McpResourceDeps {
  /** 执行 resources/list（transport + timeout 由实现方持有）。 */
  readonly list: () => Promise<unknown>;
  /** 执行 resources/read。 */
  readonly read: (uri: string) => Promise<unknown>;
  /** 上报一次完成的调用（/mcp 运行时快照的 error 位 + 时延）。 */
  readonly onCall: (isError: boolean, ms: number) => void;
}

/** 一只资源工具的通用 fail-closed 执行壳：成功 → provenance:"mcp"；
 *  任何抛错（transport/timeout/JSON-RPC error）→ isError。 */
async function runResourceCall(
  serverName: string, label: string, deps: McpResourceDeps, invoke: () => Promise<string>,
): Promise<{ content: string; provenance: string } | { content: string; isError: boolean }> {
  const start = Date.now();
  try {
    const content = await invoke();
    deps.onCall(false, Date.now() - start);
    return { content, provenance: "mcp" };
  } catch (err) {
    deps.onCall(true, Date.now() - start);
    return {
      content: `mcp resource call "${label}" on server "${serverName}" failed: ${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    };
  }
}

/** 能力已声明时为服务器挂上的两只模型可见资源工具。 */
export function mcpResourceTools(serverName: string, deps: McpResourceDeps): Tool[] {
  const riskFlags = {
    // 保守姿态照 mcpToolFromDescriptor：外部服务器 ≠ 只读/并发安全，
    // 权限管线按 mcp__* 非只读工具处理（默认模式 ask）。
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isOpenWorld: () => true,
  };
  // Wire-name sanitation同 mcpToolFromDescriptor：server id 是设置里的外部数据。
  const wire = sanitizeWireToolSegment(serverName, "server");
  return [
    buildTool({
      name: `mcp__${wire}__list_resources`,
      description: `列出 MCP 服务器 "${serverName}" 声明的资源（resources/list）。每行一条：uri [mimeType] 名称：描述。先用本工具发现 uri，再用 mcp__${serverName}__read_resource 读取。输出有界（2000 行 / 50KB）。`,
      parameters: { type: "object", properties: {} },
      execute: async () => runResourceCall(serverName, "list_resources", deps, async () =>
        renderResourceList(serverName, asMcpResourceList(await deps.list()))),
      ...riskFlags,
    }),
    buildTool({
      name: `mcp__${wire}__read_resource`,
      description: `按 uri 读取 MCP 服务器 "${serverName}" 的一个资源（resources/read）。uri 来自 mcp__${serverName}__list_resources 的清单。文本内容按块渲染（uri + mimeType 头 + 正文）；二进制只报字节数，不内联 base64。输出有界（2000 行 / 50KB）。`,
      parameters: {
        type: "object",
        properties: { uri: { type: "string", description: "要读取的资源 URI（来自 mcp__" + serverName + "__list_resources 的清单）" } },
        required: ["uri"],
      },
      execute: async (args: Record<string, unknown>) => {
        const uri = args["uri"];
        if (typeof uri !== "string" || uri.length === 0) {
          // 防御性兜底：核心循环的参数校验先挡一层，这里保证零进程接缝
          // 直调也 fail-closed（副作用之前）。
          deps.onCall(true, 0);
          return {
            content: `mcp resource call "read_resource" on server "${serverName}" failed: missing required argument "uri" (expected: string，来自 mcp__${serverName}__list_resources 的资源 uri)`,
            isError: true,
          };
        }
        return runResourceCall(serverName, "read_resource", deps, async () =>
          renderResourceContents(serverName, uri, asMcpResourceContents(await deps.read(uri))));
      },
      ...riskFlags,
    }),
  ];
}

/** The transport seam both MCP transports satisfy (stdio child process or
 *  streamable HTTP — P2-16a). Everything above the connection (handshake,
 *  capability gating, tool registration, runtime accounting) is
 *  transport-agnostic: request/notify/close is all it sees. */
export interface McpConnection {
  request(method: string, params: unknown, opts?: { readonly timeoutMs?: number }): Promise<unknown>;
  notify(method: string, params: unknown): void;
  close(): Promise<void>;
}

/** Registry of live connections; drained by closeMcpTools(). */
const clients: McpConnection[] = [];

// M55 §B11 (/mcp): per-server runtime facts, observed where they happen —
// the handshake (initialize + tools/list) is timed at connect, every
// tools/call updates the last-latency/error counters. Module-level like the
// client registry so any frontend's /mcp reads the same truth.
export interface McpRuntimeInfo {
  /** false once the server failed to start/list, or after closeMcpTools(). */
  connected: boolean;
  /** Tools the handshake listed (0 on a failed connect). */
  tools: number;
  /** initialize + tools/list wall time (ms) — the startup cost. */
  readonly handshakeMs: number;
  /** Last tools/call wall time (ms); undefined before the first call. */
  lastCallMs?: number;
  /** Completed tools/call count (successes and errors). */
  calls: number;
  /** tools/call count that ended isError / threw. */
  errors: number;
  /** Set when the connect failed (the loader's warn text source). */
  readonly failure?: string;
}

const runtime = new Map<string, McpRuntimeInfo>();

/** The live per-server snapshot (read by /mcp; a copy, never the live map). */
export function mcpRuntimeSnapshot(): ReadonlyMap<string, McpRuntimeInfo> {
  return new Map(runtime);
}

function noteCall(server: string, ms: number, isError: boolean): void {
  const entry = runtime.get(server);
  if (entry === undefined) return;
  entry.lastCallMs = ms;
  entry.calls += 1;
  if (isError) entry.errors += 1;
}

export async function loadMcpTools(config: McpConfig, warn: (msg: string) => void = () => {}, timeouts: McpTimeouts = {}): Promise<Tool[]> {
  const tools: Tool[] = [];
  const takenNames = new Set<string>();
  const entries = Object.entries(config.servers);
  await Promise.all(entries.map(async ([name, server]) => {
    try {
      for (const tool of await connectServer(name, server, timeouts, warn)) {
        const finalName = uniqueToolName(tool.name, takenNames);
        if (finalName !== tool.name) {
          warn(`mcp tool name collision: "${tool.name}" already exists; renamed to "${finalName}"`);
        }
        takenNames.add(finalName);
        tools.push(finalName === tool.name ? tool : { ...tool, name: finalName });
      }
    } catch (err) {
      warn(`mcp server "${name}" unavailable (${err instanceof Error ? err.message : String(err)}); skipping`);
    }
  }));
  return tools;
}

/** First free name for a composed tool name: base, base-2, base-3, ... */
function uniqueToolName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

async function connectServer(name: string, server: McpServerConfig, timeouts: McpTimeouts = {}, warn: (msg: string) => void = () => {}): Promise<Tool[]> {
  // ω99-2a: supply-chain gate — before spawning an npx/uvx server, query OSV for
  // known MAL-* advisories on the package it cold-pulls. MAL hit → throw (the
  // loadMcpTools catch turns it into the standard warn+skip); network errors
  // fail OPEN inside the check (offline must not take every MCP server down).
  // http (url) servers don't cold-pull from a public registry — not checked.
  if (!isHttpMcpServer(server)) {
    await checkMcpCommand(server.command, server.args ?? []);
  }
  // P2-16a: the transport dispatch — `command` spawns the stdio child
  // (M17 path, byte-stable), `url` rides the streamable HTTP transport.
  // Only this constructor differs; the handshake below is shared.
  // P2-16b: `oauth: true` attaches the dynamic token seam — the store is read
  // PER REQUEST, so a `/mcp auth` mid-session lands on the next request (no
  // restart); absent the flag the constructor args are exactly 16a's.
  const client: McpConnection = isHttpMcpServer(server)
    ? new McpHttpClient({
        url: server.url,
        ...(server.headers !== undefined ? { headers: server.headers } : {}),
        ...(server.oauth === true ? { auth: createMcpTokenAuth(name) } : {}),
      })
    : new JsonRpcClient({
        command: server.command,
        args: server.args,
        env: server.env,
        // M62 §7: the settings' shutdown timeout stretches the stdin-EOF grace
        // before SIGTERM (slow servers get a longer drain window; the default
        // keeps the M17 behavior).
        ...(timeouts.shutdownMs !== undefined ? { shutdownGraceMs: timeouts.shutdownMs } : {}),
      });
  // Register at SPAWN time, before the handshake: a SIGTERM landing inside
  // the initialize window (boot → smoke kill ~1s; the user-level uvx entry
  // made the window real) must still find the child in `clients` — an
  // unregistered child's stdio pins keep the event loop alive forever.
  // close() is idempotent, so the failure path's close() below and a later
  // closeMcpTools() both stay safe on this entry.
  clients.push(client);
  // M62 §7: the settings' connect timeout (default keeps the M17 value).
  const initializeTimeoutMs = timeouts.connectMs ?? INITIALIZE_TIMEOUT_MS;
  // M55 §B11: the handshake clock — initialize through tools/list.
  const handshakeStart = Date.now();
  let listed: McpToolDescriptor[];
  // P0-2（96 队列 #2）: initialize 结果里的能力声明决定资源工具面。
  // capabilities.resources 存在（任意非 null 对象，含 {}）即视为声明；
  // 缺失 → 不注册（byte-stable：能力决定工具集）。
  let supportsResources = false;
  try {
    const init = await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "wudao-harness", version: VERSION },
    }, { timeoutMs: initializeTimeoutMs }) as { capabilities?: { resources?: unknown } } | null;
    supportsResources = typeof init?.capabilities?.resources === "object" && init.capabilities.resources !== null;
    client.notify("notifications/initialized", {});
    const result = await client.request("tools/list", {}, { timeoutMs: initializeTimeoutMs }) as { tools?: unknown };
    listed = Array.isArray(result?.tools) ? result.tools as McpToolDescriptor[] : [];
  } catch (err) {
    await client.close().catch(() => {});
    runtime.set(name, {
      connected: false,
      tools: 0,
      handshakeMs: Date.now() - handshakeStart,
      calls: 0,
      errors: 0,
      failure: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const usable = listed.filter((t) => typeof t?.name === "string" && t.name.length > 0);
  // Wire-name sanitation receipts (0.3.81): one invalid character in a tool
  // name 400s the WHOLE provider request — surface every rewrite so the
  // user understands which name their permission rules must match.
  const wireServer = sanitizeWireToolSegment(name, "server");
  if (wireServer !== name) {
    warn(`mcp server id "${name}" carries characters outside [a-zA-Z0-9_-]; its tools' wire names use "${wireServer}" — permission rules must match the sanitized form`);
  }
  for (const t of usable) {
    const wireTool = sanitizeWireToolSegment(t.name, "tool");
    if (wireTool !== t.name) {
      warn(`mcp server "${name}" tool "${t.name}" → wire name "${wireTool}" (provider function-name pattern)`);
    }
  }
  runtime.set(name, {
    connected: true,
    tools: usable.length,
    handshakeMs: Date.now() - handshakeStart,
    calls: 0,
    errors: 0,
  });
  const callTimeoutMs = server.timeoutMs ?? timeouts.requestMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const toolTools = usable
    .map((t) => mcpToolFromDescriptor(name, t, {
      call: (args) => client.request("tools/call", { name: t.name, arguments: args }, { timeoutMs: callTimeoutMs }) as Promise<McpCallResult>,
      onCall: (isError, ms) => noteCall(name, ms, isError),
    }));
  // P0-2: 资源调用与 tools/call 共用同一 per-server 超时与 /mcp 运行时
  // 计数（noteCall 的 calls/errors 口径覆盖一切服务器往返）。
  const resourceTools = supportsResources ? mcpResourceTools(name, {
    list: () => client.request("resources/list", {}, { timeoutMs: callTimeoutMs }),
    read: (uri) => client.request("resources/read", { uri }, { timeoutMs: callTimeoutMs }),
    onCall: (isError, ms) => noteCall(name, ms, isError),
  }) : [];
  return [...toolTools, ...resourceTools];
}

/**
 * MCP inputSchema → core ToolParameterSchema, sanitized at the boundary.
 *
 * Core's validateToolArguments runs on EVERY tool call and only understands
 * string/number/boolean properties; a raw passthrough of real-world MCP
 * schemas would (a) reject legal integer/array/object arguments and (b)
 * throw on `{type:"object"}` schemas without `properties`. Sanitization
 * rules:
 * - `properties` is always an object (default `{}`) — never undefined/null;
 * - property entries whose `type` is not exactly string|number|boolean are
 *   DROPPED: those arguments fall into the permissive unknown-arg path —
 *   not type-checked client-side, but still FORWARDED verbatim to the server;
 * - `additionalProperties` is never copied, so unknown args are not rejected;
 * - `required` keeps only entries that still exist in `properties`.
 */
const SUPPORTED_PARAM_TYPES: ReadonlySet<string> = new Set(["string", "number", "boolean"]);

export function toMcpParameters(raw: unknown): ToolParameterSchema {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || (raw as { type?: unknown }).type !== "object") {
    return { type: "object", properties: {} };
  }
  const src = raw as { properties?: unknown; required?: unknown };
  const properties: Record<string, ToolParameter> = {};
  if (typeof src.properties === "object" && src.properties !== null && !Array.isArray(src.properties)) {
    for (const [key, value] of Object.entries(src.properties)) {
      const type = (typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined);
      if (typeof type === "string" && SUPPORTED_PARAM_TYPES.has(type)) {
        properties[key] = value as ToolParameter;
      }
    }
  }
  const required = Array.isArray(src.required)
    ? src.required.filter((key): key is string => typeof key === "string" && key in properties)
    : undefined;
  return required !== undefined && required.length > 0
    ? { type: "object", properties, required }
    : { type: "object", properties };
}

/** Graceful shutdown of every connected MCP server (stdin EOF → ≤2s → SIGTERM). */
export async function closeMcpTools(): Promise<void> {
  const closing = clients.splice(0, clients.length);
  await Promise.all(closing.map((c) => c.close().catch(() => {})));
  // M55 §B11: the runtime snapshot follows the connections down (a closed
  // server is no longer "connected", its observed facts stay readable).
  for (const info of runtime.values()) info.connected = false;
}

/** Fire-and-forget variant for process "exit" hooks: close()'s synchronous
 *  part (stdin EOF — the graceful signal) runs immediately; the ≤2s wait and
 *  SIGTERM follow only if the event loop is still alive. */
export function bestEffortCloseMcpTools(): void {
  for (const c of clients.splice(0, clients.length)) {
    void c.close().catch(() => {});
  }
  for (const info of runtime.values()) info.connected = false;
}
