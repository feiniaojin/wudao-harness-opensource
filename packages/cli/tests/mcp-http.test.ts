// P2-16a（96 队列 #16）MCP streamable HTTP transport —— 测试先行。
//
// 三层：
//   1. 传输单元（可注入 fetch —— 确定性、零网络）：JSON/SSE 二形解析、
//      Session-Id 捕获回带、超时 fail-closed、非 200 文案、secrets 三面
//      （日志 sink/错误文案/trace 记录）不泄漏。
//   2. 集成（node:http fake server）：initialize+capabilities 门控 →
//      工具/资源注册、tools/list+call 全链路、权限保守姿态、连接失败
//      fail-visible、真 fetch 超时路径。
//   3. /mcp 渲染面：url 型列 transport http（stdio 行字节不变）。
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import { McpHttpClient } from "../src/mcp/http.js";
import type { McpHttpResponse } from "../src/mcp/http.js";
import { JsonRpcError, JsonRpcTimeoutError } from "../src/mcp/json-rpc.js";
import { loadMcpTools, closeMcpTools, mcpRuntimeSnapshot } from "../src/mcp/tools.js";
import { buildMcpRows, formatMcpReport } from "../src/commands/mcp-status.js";
import type { McpConfig } from "../src/mcp/config.js";
import { makeResponse, jsonRpcResponse, scriptedFetch, sseStream, jsonBody, type SentPost } from "./mcp-http-test-helpers.js";

const TOKEN = "Bearer secret-token-do-not-leak-9f8e7d";
const SESSION_ID = "sess-abc-123";

// helpers — 16a/16b 共享的 injectable-fetch fakes（tests/mcp-http-test-helpers.ts）
const encoder = new TextEncoder(); // 两只手搓 SSE 块的用例本地用

// ---------------------------------------------------------------------------
// 1. transport units — JSON 响应形
// ---------------------------------------------------------------------------

describe("McpHttpClient — JSON 响应形", () => {
  it("POST {url} 单请求 JSON-RPC；Accept 双形 + Content-Type + 静态 headers 合并；解析 result 成员", async () => {
    const { f, posts } = scriptedFetch([jsonRpcResponse(1, { ok: true })]);
    const client = new McpHttpClient({ url: "https://mcp.example.com/api", headers: { Authorization: TOKEN, "X-Org": "acme" }, fetch: f });
    const result = await client.request("initialize", { protocolVersion: "2025-06-18" });
    expect(result).toEqual({ ok: true });
    expect(posts.length).toBe(1);
    expect(posts[0]?.url).toBe("https://mcp.example.com/api");
    expect(posts[0]?.headers["Content-Type"]).toBe("application/json");
    expect(posts[0]?.headers["Accept"]).toBe("application/json, text/event-stream");
    expect(posts[0]?.headers["Authorization"]).toBe(TOKEN);
    expect(posts[0]?.headers["X-Org"]).toBe("acme");
    expect(jsonBody(posts[0] ?? { body: "{}", url: "", headers: {} })).toMatchObject({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await client.close();
  });

  it("JSON-RPC error 成员 → JsonRpcError（code/message 浮出，与 stdio 同类）", async () => {
    const { f } = scriptedFetch([makeResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } }), { headers: { "content-type": "application/json" } })]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await expect(client.request("tools/call", {})).rejects.toMatchObject({ name: "JsonRpcError", code: -32000, message: "boom" });
    await client.close();
  });

  it("非 200 → fail-closed 错误文案含 HTTP status；不含响应 body/statusText（服务器可回显 token）", async () => {
    const { f } = scriptedFetch([
      makeResponse(`your token is ${TOKEN}`, { status: 500, headers: { "content-type": "text/plain", "www-authenticate": `Bearer error="invalid_token"` } }),
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", headers: { Authorization: TOKEN }, fetch: f });
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("HTTP 500");
    expect(err.message).toContain("tools/list");
    expect(err.message.includes(TOKEN)).toBe(false);       // 静态头值不进文案
    expect(err.message.includes("invalid_token")).toBe(false); // 响应头不进文案
    await client.close();
  });

  it("单 JSON 形返回了别人的 id → fail-closed（响应配对不误配）", async () => {
    const { f } = scriptedFetch([jsonRpcResponse(7, { nope: true })]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await expect(client.request("tools/list", {})).rejects.toThrow(/different request id/);
    await client.close();
  });

  it("响应体不是合法 JSON → fail-closed，且解析错误引文不携带 token", async () => {
    const { f } = scriptedFetch([makeResponse(`token=${TOKEN} is not json`, { headers: { "content-type": "application/json" } })]);
    const client = new McpHttpClient({ url: "https://x/mcp", headers: { Authorization: TOKEN }, fetch: f });
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("not valid JSON");
    expect(err.message.includes(TOKEN)).toBe(false);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 1b. transport units — SSE 响应形
// ---------------------------------------------------------------------------

describe("McpHttpClient — SSE 响应形", () => {
  it("多 event：中途 notification 与 server→client request 不误配对；目标响应才完成；通知计数", async () => {
    const { f } = scriptedFetch([
      makeResponse(sseStream([
        { jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "log" } }, // 无 id → 通知
        { jsonrpc: "2.0", id: 99, method: "sampling/createMessage", params: {} },                    // 有 id 但带 method → 服务器请求
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "echo" }] } },                             // 目标响应
        { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "late" }] } },                             // 完成后到达（被忽略）
      ]), { headers: { "content-type": "text/event-stream" } }),
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    const result = await client.request("tools/list", {});
    expect(result).toEqual({ tools: [{ name: "echo" }] }); // 不是 late —— 命中即返回
    expect(client.notificationsIgnored).toBe(2);
    await client.close();
  });

  it("多行 data 拼接（SSE 规范 \\n 连接）；event/id/retry/注释行忽略", async () => {
    const one = encoder.encode("event: message\nid: ignored\ndata: {\"jsonrpc\":\"2.0\",\ndata: \"id\":1,\"result\":{\"a\":true}}\nretry: 10\n: comment\n\n");
    const { f } = scriptedFetch([makeResponse([one], { headers: { "content-type": "text/event-stream" } })]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await expect(client.request("tools/list", {})).resolves.toEqual({ a: true });
    await client.close();
  });

  it("SSE 流结束（含 EOF 无尾随空行）仍无目标响应 → fail-closed", async () => {
    const { f } = scriptedFetch([
      makeResponse([encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`), encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 42, result: {} })}`)], { headers: { "content-type": "text/event-stream" } }),
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await expect(client.request("tools/list", {})).rejects.toThrow(/ended without a response/);
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 1c. transport units — 会话 / 超时 / 关闭 / 排序
// ---------------------------------------------------------------------------

describe("McpHttpClient — 会话、超时、关闭", () => {
  it("Mcp-Session-Id 捕获（initialize 响应头）→ 后续请求回带；未发会话头则不带", async () => {
    const { f, posts } = scriptedFetch([
      jsonRpcResponse(1, { protocolVersion: "2025-06-18" }, { "mcp-session-id": SESSION_ID }),
      jsonRpcResponse(2, { tools: [] }),
      jsonRpcResponse(1, { tools: [] }),
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await client.request("initialize", {});
    expect(posts[0]?.headers["Mcp-Session-Id"]).toBeUndefined();
    await client.request("tools/list", {});
    expect(posts[1]?.headers["Mcp-Session-Id"]).toBe(SESSION_ID);
    await client.close();
    const client2 = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await client2.request("tools/list", {});
    expect(posts[2]?.headers["Mcp-Session-Id"]).toBeUndefined(); // 服务器不要求会话 → 不带
    await client2.close();
  });

  it("每请求超时 fail-closed → JsonRpcTimeoutError（stdio 同款文案：method + ms）", async () => {
    async function hangingFetch(url: string, init: { headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<McpHttpResponse> {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: hangingFetch });
    const err = await client.request("tools/call", {}, { timeoutMs: 40 }).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(JsonRpcTimeoutError);
    expect(err.message).toContain("tools/call");
    expect(err.message).toContain("40ms");
    await client.close();
  });

  it("close() 后续请求 fail-closed（stdio 同款文案）；close 幂等", async () => {
    const { f } = scriptedFetch([jsonRpcResponse(1, {})]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await client.request("initialize", {});
    await client.close();
    await client.close();
    await expect(client.request("tools/list", {})).rejects.toThrow(/connection is closed/);
  });

  it("notify 排在下一个请求之前发送（initialized 先于 tools/list）；notify 自身不抛", async () => {
    const { f, posts } = scriptedFetch([
      jsonRpcResponse(1, {}),                                                      // initialize
      makeResponse("", { status: 202 }),                                           // notifications/initialized → 202 Accepted
      jsonRpcResponse(2, { tools: [] }),                                           // tools/list
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    await client.request("initialize", {});
    client.notify("notifications/initialized", {});
    await client.request("tools/list", {});
    expect(posts.map((p) => (jsonBody(p) as { method: string }).method)).toEqual([
      "initialize", "notifications/initialized", "tools/list",
    ]);
    const notification = jsonBody(posts[1] ?? { body: "{}", url: "", headers: {} });
    expect("id" in notification).toBe(false); // 通知无 id
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 2. secrets — 三面不泄漏（错误文案 / trace 记录 / warn 文案）
// ---------------------------------------------------------------------------

describe("secrets — 静态 headers 里的 token 三面不泄漏", () => {
  it("非 200 + 状态行/正文回显攻击 → 错误文案与 trace 记录均无 token、无会话 id", async () => {
    const { f } = scriptedFetch([
      jsonRpcResponse(1, {}, { "mcp-session-id": SESSION_ID }),                     // initialize（带会话）
      makeResponse(`echo ${TOKEN}`, { status: 401, headers: { "www-authenticate": `Bearer realm="${TOKEN}"` } }),
    ]);
    const records: unknown[] = [];
    const client = new McpHttpClient({
      url: "https://x/mcp?q=zzz",
      headers: { Authorization: TOKEN },
      fetch: f,
      trace: (r) => records.push(JSON.stringify(r)),
    });
    await client.request("initialize", {});
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err.message).toContain("HTTP 401");
    expect(err.message.includes(TOKEN)).toBe(false);
    expect(err.message.includes(SESSION_ID)).toBe(false);
    // trace 面：任何记录不携带头值/会话 id；URL 查询串剥离。
    const all = records.join("\n");
    expect(all.includes(TOKEN)).toBe(false);
    expect(all.includes(SESSION_ID)).toBe(false);
    expect(all.includes("q=zzz")).toBe(false);
    expect(all.includes("https://x/mcp")).toBe(true); // redactUrl 保留 scheme//host/path
    await client.close();
  });
});

// ---------------------------------------------------------------------------
// 3. integration — node:http fake server（真实 fetch，确定性路由）
// ---------------------------------------------------------------------------

interface CapturedRequest {
  readonly method: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown> | null;
}

interface FakeServerOptions {
  /** initialize 结果声明 capabilities.resources（P0-2 门控）。 */
  readonly resources?: boolean;
  /** initialize 响应带 Mcp-Session-Id。 */
  readonly session?: boolean;
  /** tools/list 与 tools/call 以 SSE 流响应（而非单 JSON）。 */
  readonly sse?: boolean;
  /** 一切请求都回这个状态码（连接失败面）。 */
  readonly failStatus?: number;
  /** 401/失败 body 回显 Authorization 值（泄漏试探）。 */
  readonly echoAuthInBody?: boolean;
  /** 状态行回显 Authorization 值（泄漏试探）。 */
  readonly echoAuthInStatusText?: boolean;
  /** 这些 JSON-RPC method 收到后挂起不答（超时面）。 */
  readonly hangMethods?: readonly string[];
}

interface FakeServer {
  readonly url: string;
  readonly requests: CapturedRequest[];
  close(): Promise<void>;
}

function startFakeMcpServer(opts: FakeServerOptions = {}): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const method = typeof body?.["method"] === "string" ? body["method"] : "?";
      requests.push({ method, headers: req.headers, body });
      const auth = typeof req.headers["authorization"] === "string" ? req.headers["authorization"] : "";
      const sendJson = (msg: unknown): void => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(msg));
      };
      const sendSse = (messages: readonly unknown[]): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join(""));
      };
      const id = body?.["id"];
      if (opts.failStatus !== undefined) {
        res.writeHead(opts.failStatus, opts.echoAuthInStatusText ? auth : undefined);
        res.end(opts.echoAuthInBody ? auth : "");
        return;
      }
      if (opts.hangMethods?.includes(method)) return; // 挂起 —— 超时面
      switch (method) {
        case "initialize":
          if (opts.session) res.setHeader("Mcp-Session-Id", SESSION_ID);
          sendJson({
            jsonrpc: "2.0", id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: opts.resources ? { resources: {} } : {},
              serverInfo: { name: "fake-http", version: "1.0" },
            },
          });
          return;
        case "notifications/initialized":
          res.writeHead(202);
          res.end();
          return;
        case "tools/list": {
          const result = { tools: [
            { name: "echo", description: "Echo the arguments back as text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
            { name: "fail", description: "Always reports a server-side error", inputSchema: { type: "object", properties: {} } },
          ] };
          if (opts.sse) {
            sendSse([
              { jsonrpc: "2.0", method: "notifications/message", params: { data: "starting" } },
              { jsonrpc: "2.0", id: 9001, method: "sampling/createMessage", params: {} },
              { jsonrpc: "2.0", id, result },
            ]);
          } else sendJson({ jsonrpc: "2.0", id, result });
          return;
        }
        case "tools/call": {
          const params = body?.["params"] as { name?: string; arguments?: Record<string, unknown> } | undefined;
          if (params?.name === "fail") {
            sendJson({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } });
            return;
          }
          const result = { content: [{ type: "text", text: JSON.stringify(params?.arguments ?? {}) }] };
          if (opts.sse) sendSse([{ jsonrpc: "2.0", id, result }]);
          else sendJson({ jsonrpc: "2.0", id, result });
          return;
        }
        case "resources/list":
          sendJson({ jsonrpc: "2.0", id, result: { resources: [{ uri: "memo://notes/todo", name: "todo.md", mimeType: "text/markdown", description: "今天要做什么" }] } });
          return;
        case "resources/read": {
          const uri = (body?.["params"] as { uri?: string } | undefined)?.uri;
          if (uri === "memo://notes/todo") {
            sendJson({ jsonrpc: "2.0", id, result: { contents: [{ uri, mimeType: "text/markdown", text: "# 待办" }] } });
          } else {
            sendJson({ jsonrpc: "2.0", id, error: { code: -32602, message: `unknown resource uri: ${uri}` } });
          }
          return;
        }
        default:
          sendJson({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

function remoteConfig(url: string, extra: Record<string, unknown> = {}): McpConfig {
  return { servers: { remote: { url, headers: { Authorization: TOKEN }, ...extra } } } as McpConfig;
}

afterEach(async () => {
  await closeMcpTools(); // drain the registry between tests
});

describe("集成 — fake HTTP server + loadMcpTools", () => {
  it("initialize → tools/list → 注册 mcp__remote__echo；headers 透传到服务器；Session-Id 捕获回带", async () => {
    const srv = await startFakeMcpServer({ session: true });
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        const echo = tools.find((t) => t.name === "mcp__remote__echo");
        expect(echo?.description).toBe("Echo the arguments back as text");
        expect(echo?.parameters.required).toEqual(["text"]);
        // initialize 无会话头；之后每个请求带会话头 + Authorization。
        const byMethod = srv.requests.map((r) => r.method);
        expect(byMethod).toEqual(["initialize", "notifications/initialized", "tools/list"]);
        expect(srv.requests[0]?.headers["mcp-session-id"]).toBeUndefined();
        for (const r of srv.requests.slice(1)) {
          expect(r.headers["mcp-session-id"]).toBe(SESSION_ID);
          expect(r.headers["authorization"]).toBe(TOKEN);
        }
        expect(srv.requests[0]?.headers["authorization"]).toBe(TOKEN);
        // tools/call 全链路：provenance mcp。
        const result = await echo?.execute({ text: "hello" }) ?? { content: "(missing)" };
        expect(result.isError).toBeFalsy();
        expect(result.provenance).toBe("mcp");
        expect(result.content).toBe(JSON.stringify({ text: "hello" }));
        const last = srv.requests[srv.requests.length - 1];
        expect(last?.method).toBe("tools/call");
        expect((last?.body?.["params"] as { name?: string })?.name).toBe("echo");
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("SSE 响应形全链路（tools/list 多 event 含通知+服务器请求不误配对；tools/call SSE）", async () => {
    const srv = await startFakeMcpServer({ sse: true });
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        const echo = tools.find((t) => t.name === "mcp__remote__echo");
        expect(echo).toBeDefined();
        const result = await echo?.execute({ text: "sse" }) ?? { content: "(missing)" };
        expect(result.isError).toBeFalsy();
        expect(result.content).toBe(JSON.stringify({ text: "sse" }));
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("capabilities.resources 声明 → 两只资源工具注册（P0-2 门控复用）；资源全链路", async () => {
    const srv = await startFakeMcpServer({ resources: true, session: true });
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        const list = tools.find((t) => t.name === "mcp__remote__list_resources");
        const read = tools.find((t) => t.name === "mcp__remote__read_resource");
        expect(list).toBeDefined();
        expect(read).toBeDefined();
        const listed = await list?.execute({}) ?? { content: "(missing)" };
        expect(listed.isError).toBeFalsy();
        expect(listed.provenance).toBe("mcp");
        expect(listed.content).toContain("- memo://notes/todo [text/markdown] todo.md");
        const readResult = await read?.execute({ uri: "memo://notes/todo" }) ?? { content: "(missing)" };
        expect(readResult.isError).toBeFalsy();
        expect(readResult.content).toContain("# 待办");
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("capabilities.resources 缺失 → 资源工具不注册（能力决定工具集）", async () => {
    const srv = await startFakeMcpServer({});
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        expect(tools.some((t) => t.name === "mcp__remote__list_resources" || t.name === "mcp__remote__read_resource")).toBe(false);
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("url 型工具权限保守姿态：非只读、非并发安全、open-world", async () => {
    const srv = await startFakeMcpServer({});
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        const echo = tools.find((t) => t.name === "mcp__remote__echo");
        expect(echo?.isReadOnly?.({})).toBe(false);
        expect(echo?.isConcurrencySafe?.({})).toBe(false);
        expect(echo?.isOpenWorld?.({})).toBe(true);
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("服务器侧 JSON-RPC error → 工具面 fail-closed isError（文案纪律同 stdio）", async () => {
    const srv = await startFakeMcpServer({});
    try {
      const tools = await loadMcpTools({ servers: { remote: { url: srv.url, headers: { Authorization: TOKEN } } } });
      try {
        const fail = tools.find((t) => t.name === "mcp__remote__fail");
        const result = await fail?.execute({}) ?? { content: "(missing)" };
        expect(result.isError).toBe(true);
        expect(result.content).toContain("boom");
        expect(result.content).toContain(`mcp tool "fail" failed:`); // stdio 同款文案纪律（服务器侧工具名）
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("连接失败（恒 401 + 状态行/正文回显 token）→ warn 跳过、无工具、runtime failure 无 token", async () => {
    const srv = await startFakeMcpServer({ failStatus: 401, echoAuthInBody: true, echoAuthInStatusText: true });
    try {
      const warnings: string[] = [];
      const tools = await loadMcpTools(remoteConfig(srv.url), (m) => warnings.push(m));
      expect(tools).toEqual([]);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("remote");
      expect(warnings[0]).toContain("HTTP 401");
      expect(warnings[0].includes(TOKEN)).toBe(false); // warn 面（日志同源）
      const snap = mcpRuntimeSnapshot().get("remote");
      expect(snap?.connected).toBe(false);
      expect(snap?.failure).toContain("HTTP 401");
      expect((snap?.failure ?? "").includes(TOKEN)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("真 fetch 超时路径：tools/call 挂起 → fail-closed isError，文案带 timed out", async () => {
    const srv = await startFakeMcpServer({ hangMethods: ["tools/call"] });
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url, { timeoutMs: 80 }));
      try {
        const echo = tools.find((t) => t.name === "mcp__remote__echo");
        const result = await echo?.execute({ text: "x" }) ?? { content: "(missing)" };
        expect(result.isError).toBe(true);
        expect(result.content).toContain("timed out");
        expect(result.content).toContain("80ms");
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });

  it("/mcp 快照：url 型 connected=true，tools 计数与调用时延入账", async () => {
    const srv = await startFakeMcpServer({});
    try {
      const tools = await loadMcpTools(remoteConfig(srv.url));
      try {
        const echo = tools.find((t) => t.name === "mcp__remote__echo");
        await echo?.execute({ text: "one" });
        const snap = mcpRuntimeSnapshot().get("remote");
        expect(snap?.connected).toBe(true);
        expect(snap?.tools).toBe(2); // echo + fail（tools/list 面的计数口径）
        expect(snap?.calls).toBe(1);
        expect(snap?.errors).toBe(0);
        expect(typeof snap?.lastCallMs).toBe("number");
      } finally {
        await closeMcpTools();
      }
    } finally {
      await srv.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. /mcp 渲染面
// ---------------------------------------------------------------------------

describe("/mcp 渲染 — url 型 transport 标注", () => {
  it("url 型行显示 `· http ·` 与脱敏 URL；stdio 行不带 transport 段（字节稳定）", () => {
    const httpRows = buildMcpRows({
      config: { servers: { remote: { url: "https://mcp.example.com/api?token=zzz", headers: { Authorization: "Bearer t" } } } },
      toolNames: ["mcp__remote__echo"],
      runtime: new Map(),
    });
    expect(httpRows[0]?.transport).toBe("http");
    const httpText = formatMcpReport(httpRows);
    expect(httpText).toContain("remote: 已连接 · http · 1 个工具"); // ω99-180: 钉随源演进
    expect(httpText).toContain("https://mcp.example.com/api"); // 脱敏 URL 仍可辨认
    expect(httpText.includes("token=zzz")).toBe(false);        // 查询串剥离
    const stdioText = formatMcpReport(buildMcpRows({
      config: { servers: { demo: { command: "node" } } },
      toolNames: [],
      runtime: new Map([["demo", { connected: true, tools: 1, handshakeMs: 12, calls: 0, errors: 0 }]]),
    }));
    expect(stdioText).toContain("demo: 已连接 · 1 个工具"); // ω99-180: 钉随源演进
    expect(stdioText.includes("http")).toBe(false);
  });
});

// 引用守卫：JsonRpcError 被复用于 http 错误成员（同 stdio 类）。
void JsonRpcError;
