// P2-16b（96 队列 #16）MCP OAuth 流 —— 测试先行。
//
// 七层（brief 测试清单）：
//   1. PKCE：verifier 长度/字符域/随机性；challenge=base64url(sha256(verifier))
//      的 RFC 7636 向量。
//   2. 发现：protected-resource 命中（含 authorization_servers 链）/ 直接
//      endpoints 容忍形 / fallback AS well-known / 都 404 + config 直给 /
//      全无 fail-closed。
//   3. 流程集成（fake discovery+token endpoint + 本地回调直调）：auth 全链
//      路 → 0600 库落 token；state 不匹配拒（CSRF）；code 换 token 请求体含
//      verifier；超时 fail-closed；换 token 400 的回显 body 不进错误。
//   4. 注入：有 token 请求带 Bearer；401+refresh → 刷新重试一次成功；刷新
//      也败 → 报文含 /mcp auth 指引且不含 token 值；无 refresh → 16a 同款
//      报文；无 auth → 字节稳定（单次 POST、同文案）。
//   5. scrub：错误路径全量断言 token/verifier/state 子串不出现。
//   6. 0600：新库权限断言；坏权限修正（warn）。
//   7. 命令面：/mcp 解析缝、runner 语法、config oauth 字段、/mcp 裸标注、
//      tools.ts oauth 端到端（Bearer 门控的 fake MCP server）。
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type AddressInfo } from "node:http";
import { mkdtempSync, rmSync, statSync, chmodSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateCodeVerifier,
  pkceS256Challenge,
  discoverOAuthEndpoints,
  startMcpOAuth,
  runMcpOAuthFlow,
  createMcpTokenAuth,
  OAUTH_CALLBACK_PATH,
  OAUTH_EXPIRY_REFRESH_SKEW_MS,
  type OAuthFetch,
  type OAuthHttpResponse,
} from "../src/mcp/oauth.js";
import {
  fileMcpTokenStore,
  defaultMcpTokenStore,
  mcpTokensPath,
  mcpTokenSecretValues,
} from "../src/mcp/tokens.js";
import { McpHttpClient } from "../src/mcp/http.js";
import type { McpHttpAuth } from "../src/mcp/http.js";
import { makeResponse, jsonRpcResponse, scriptedFetch } from "./mcp-http-test-helpers.js";
import { normalizeServer } from "../src/mcp/config.js";
import { buildMcpRows, formatMcpReport } from "../src/commands/mcp-status.js";
import { runMcpAuthCommand } from "../src/commands/mcp-auth.js";
import { loadMcpTools, closeMcpTools } from "../src/mcp/tools.js";
import { parseReplCommand } from "../src/repl.js";

const ACCESS = "at-secret-access-9f8e7d6c5b4a";
const REFRESH = "rt-secret-refresh-1a2b3c4d5e";
const STATE = "st-secret-state-77aa88bb99";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** A capture of one POST the http client issued (the fetch seam's view). */
interface OAuthSent {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

function oauthOk(body: unknown): OAuthHttpResponse {
  return { status: 200, ok: true, text: async () => JSON.stringify(body) };
}

function oauthStatus(status: number, body = ""): OAuthHttpResponse {
  return { status, ok: false, text: async () => body };
}

/** Scripted OAuthFetch keyed by exact URL; records every call. */
function routeFetch(routes: Record<string, OAuthHttpResponse | ((sent: OAuthSent) => OAuthHttpResponse)>): OAuthFetch & { sent: OAuthSent[] } {
  const sent: OAuthSent[] = [];
  const f = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<OAuthHttpResponse> => {
    const call: OAuthSent = { url, method: init.method, headers: { ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) };
    sent.push(call);
    const r = routes[url];
    if (r === undefined) return oauthStatus(404, `no route for ${url}`);
    return typeof r === "function" ? r(call) : r;
  };
  return Object.assign(f, { sent });
}

/** Scripted fetch for the McpHttpClient lane comes from mcp-http-test-helpers. */

function bearerAuth(over: Partial<McpHttpAuth> = {}): McpHttpAuth & { refreshes: number } {
  const auth = {
    serverName: "remote",
    refreshes: 0,
    getToken: async () => ({ accessToken: ACCESS, expiresAt: Date.now() + 3_600_000 }),
    refresh: async () => {
      auth.refreshes += 1;
      return { accessToken: ACCESS + "-2", expiresAt: Date.now() + 3_600_000 };
    },
    ...over,
  } as McpHttpAuth & { refreshes: number };
  return auth;
}

/** A fake authorization server: well-known + token endpoint over loopback. */
interface FakeOAuthServer {
  readonly origin: string;
  readonly tokenRequests: { readonly body: string; readonly headers: Record<string, string> }[];
  /** Scripted token-endpoint responses (urlencoded bodies), i-th POST wins. */
  setTokenResponse(responder: (body: URLSearchParams) => { status: number; body: string }): void;
  close(): Promise<void>;
}

function startFakeOAuthServer(opts: { readonly protectedResource?: boolean; readonly asMetadata?: boolean } = {}): Promise<FakeOAuthServer> {
  const tokenRequests: { body: string; headers: Record<string, string> }[] = [];
  let responder: (body: URLSearchParams) => { status: number; body: string } = () => ({
    status: 200,
    body: JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, scope: "read write", token_type: "Bearer" }),
  });
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: string, ctype = "application/json"): void => {
      res.writeHead(status, { "content-type": ctype });
      res.end(body);
    };
    if (req.method === "GET" && u.pathname === "/.well-known/oauth-protected-resource") {
      if (opts.protectedResource === false) return send(404, "not found", "text/plain");
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return send(200, JSON.stringify({ resource: origin, authorization_servers: [origin] }));
    }
    if (req.method === "GET" && u.pathname === "/.well-known/oauth-authorization-server") {
      if (opts.asMetadata === false) return send(404, "not found", "text/plain");
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return send(200, JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token` }));
    }
    if (req.method === "POST" && u.pathname === "/token") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        tokenRequests.push({ body: raw, headers: req.headers as Record<string, string> });
        const r = responder(new URLSearchParams(raw));
        send(r.status, r.body);
      });
      return;
    }
    send(404, "not found", "text/plain");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        tokenRequests,
        setTokenResponse: (r) => { responder = r; },
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

/** A fake MCP server whose every request requires `Authorization: Bearer <t>`. */
function startBearerGatedMcpServer(expected: string): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    if ((req.headers["authorization"] ?? "") !== `Bearer ${expected}`) {
      res.writeHead(401, { "content-type": "text/plain" });
      res.end(`bad token, saw ${req.headers["authorization"] ?? "(none)"}`);
      return;
    }
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const msg = JSON.parse(raw) as { id?: number; method?: string };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(msg?.method === "tools/list"
        ? { jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }] } }
        : { jsonrpc: "2.0", id: msg.id, result: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, close: () => new Promise<void>((done) => server.close(() => done())) });
    });
  });
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "wudao-mcp-oauth-"));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

// ---------------------------------------------------------------------------
// 1. PKCE
// ---------------------------------------------------------------------------
describe("PKCE", () => {
  it("verifier：43-128 字符、unreserved 字符域、随机不重复", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
      seen.add(v);
    }
    expect(seen.size).toBe(20);
  });

  it("challenge 向量：RFC 7636 附录 B（S256 = base64url(sha256(verifier))，无填充）", () => {
    expect(pkceS256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("注入 rand → verifier 确定性（base64url(32 bytes) = 43 字符）", () => {
    const rand = (n: number): Uint8Array => new Uint8Array(n).fill(7);
    expect(generateCodeVerifier(rand)).toBe(generateCodeVerifier(rand));
    expect(generateCodeVerifier(rand).length).toBe(43);
    expect(pkceS256Challenge(generateCodeVerifier(rand))).toBe(pkceS256Challenge(generateCodeVerifier(rand)));
  });
});

// ---------------------------------------------------------------------------
// 2. 发现
// ---------------------------------------------------------------------------
describe("OAuth 发现", () => {
  const SERVER = "https://mcp.example.com/api";

  it("protected-resource 命中 → authorization_servers[0] 的 AS 元数据取 endpoints", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthOk({ authorization_servers: ["https://as.example.com"] }),
      "https://as.example.com/.well-known/oauth-authorization-server": oauthOk({ authorization_endpoint: "https://as.example.com/authorize", token_endpoint: "https://as.example.com/token" }),
    });
    const eps = await discoverOAuthEndpoints(SERVER, { fetch: f });
    expect(eps).toEqual({ authorizationEndpoint: "https://as.example.com/authorize", tokenEndpoint: "https://as.example.com/token" });
    expect(f.sent.map((s) => s.url)).toEqual([
      "https://mcp.example.com/.well-known/oauth-protected-resource",
      "https://as.example.com/.well-known/oauth-authorization-server",
    ]);
  });

  it("protected-resource 直接给 endpoints（容忍形）→ 不再追 AS 元数据", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthOk({ authorization_endpoint: "https://pr.example.com/a", token_endpoint: "https://pr.example.com/t" }),
    });
    const eps = await discoverOAuthEndpoints(SERVER, { fetch: f });
    expect(eps).toEqual({ authorizationEndpoint: "https://pr.example.com/a", tokenEndpoint: "https://pr.example.com/t" });
    expect(f.sent.length).toBe(1);
  });

  it("protected-resource 404 → fallback AS well-known（server origin 上）命中", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthStatus(404),
      "https://mcp.example.com/.well-known/oauth-authorization-server": oauthOk({ authorization_endpoint: "https://mcp.example.com/authorize", token_endpoint: "https://mcp.example.com/token" }),
    });
    const eps = await discoverOAuthEndpoints(SERVER, { fetch: f });
    expect(eps).toEqual({ authorizationEndpoint: "https://mcp.example.com/authorize", tokenEndpoint: "https://mcp.example.com/token" });
  });

  it("两个 well-known 都 404 → config 直给 authorizationUrl/tokenUrl 用之", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthStatus(404),
      "https://mcp.example.com/.well-known/oauth-authorization-server": oauthStatus(404),
    });
    const eps = await discoverOAuthEndpoints(SERVER, {
      fetch: f,
      configEndpoints: { authorizationUrl: "https://cfg.example.com/authorize", tokenUrl: "https://cfg.example.com/token" },
    });
    expect(eps).toEqual({ authorizationEndpoint: "https://cfg.example.com/authorize", tokenEndpoint: "https://cfg.example.com/token" });
  });

  it("全无（well-known 404、config 缺一半）→ fail-closed 报文", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthStatus(404),
      "https://mcp.example.com/.well-known/oauth-authorization-server": oauthStatus(404),
    });
    const err = await discoverOAuthEndpoints(SERVER, { fetch: f, configEndpoints: { tokenUrl: "https://cfg.example.com/token" } })
      .then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toMatch(/discovery/i);
    expect(err?.message).toMatch(/fail/i);
  });

  it("well-known 返回 200 但缺 endpoints 字段 → fail-closed（不当 404 用）", async () => {
    const f = routeFetch({
      "https://mcp.example.com/.well-known/oauth-protected-resource": oauthOk({ resource: "https://mcp.example.com" }),
      "https://mcp.example.com/.well-known/oauth-authorization-server": oauthStatus(404),
    });
    await expect(discoverOAuthEndpoints(SERVER, { fetch: f })).rejects.toThrow(/discovery/i);
  });
});

// ---------------------------------------------------------------------------
// 3. 流程集成（fake discovery+token endpoint + 本地回调直调）
// ---------------------------------------------------------------------------
describe("OAuth 流程集成", () => {
  it("全链路：发现→PKCE→回调直调→换 token→0600 库；授权 URL 参数正确", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false }); // 走 fallback
    const store = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    const logs: string[] = [];
    const opened: string[] = [];
    const handle = await startMcpOAuth({
      serverName: "remote",
      serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: (u) => { opened.push(u); }, log: (l) => { logs.push(l); } },
      tokenStore: store,
    });
    try {
      // 授权 URL：response_type/code_challenge(S256)/redirect_uri=callbackUrl/state。
      const authUrl = new URL(handle.authorizationUrl);
      expect(authUrl.searchParams.get("response_type")).toBe("code");
      expect(authUrl.searchParams.get("code_challenge")).toBe(pkceS256Challenge(handle.codeVerifier));
      expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authUrl.searchParams.get("state")).toBe(handle.state);
      expect(authUrl.searchParams.get("redirect_uri")).toBe(handle.callbackUrl);
      expect(handle.callbackUrl.startsWith("http://127.0.0.1:")).toBe(true);
      expect(handle.callbackUrl.endsWith(OAUTH_CALLBACK_PATH)).toBe(true);
      expect(logs.some((l) => l.includes(handle.authorizationUrl))).toBe(true);
      expect(opened).toEqual([handle.authorizationUrl]);
      // 回调直调（真实 loopback fetch）→ 200 人话页。
      const cb = await fetch(`${handle.callbackUrl}?code=CODE-123&state=${encodeURIComponent(handle.state)}`);
      expect(cb.status).toBe(200);
      await cb.text();
      const result = await handle.complete();
      expect(result.serverName).toBe("remote");
      expect(result.token.accessToken).toBe(ACCESS);
      expect(result.token.refreshToken).toBe(REFRESH);
      expect(result.token.scope).toBe("read write");
      expect(result.token.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
      // 换 token 的请求体：authorization_code + code + verifier + redirect_uri。
      expect(srv.tokenRequests.length).toBe(1);
      const form = new URLSearchParams(srv.tokenRequests[0]?.body ?? "");
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("CODE-123");
      expect(form.get("code_verifier")).toBe(handle.codeVerifier);
      expect(form.get("redirect_uri")).toBe(handle.callbackUrl);
      expect((srv.tokenRequests[0]?.headers["content-type"] ?? "")).toContain("application/x-www-form-urlencoded");
      // 0600 库落 token（snake_case 键）。
      const stored = store.load();
      expect(stored["remote"]?.accessToken).toBe(ACCESS);
      expect(stored["remote"]?.tokenUrl).toBe(`${srv.origin}/token`);
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("state 不匹配 → 回调被拒（400），流程继续等；正确 state 到来仍完成（CSRF）", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const store = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    const handle = await startMcpOAuth({
      serverName: "remote",
      serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: store,
    });
    try {
      const bad = await fetch(`${handle.callbackUrl}?code=EVIL&state=${encodeURIComponent("wrong-state")}`);
      expect(bad.status).toBe(400);
      await bad.text();
      // 流程未被 evil 回调满足：随后正确回调仍换到 token。
      const good = await fetch(`${handle.callbackUrl}?code=GOOD-1&state=${encodeURIComponent(handle.state)}`);
      expect(good.status).toBe(200);
      const result = await handle.complete();
      expect(result.token.accessToken).toBe(ACCESS);
      expect(new URLSearchParams(srv.tokenRequests[0]?.body ?? "").get("code")).toBe("GOOD-1");
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("缺 code 的回调 → 400，流程继续等", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const handle = await startMcpOAuth({
      serverName: "remote", serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json")),
    });
    try {
      const bad = await fetch(`${handle.callbackUrl}?state=${encodeURIComponent(handle.state)}`);
      expect(bad.status).toBe(400);
      await bad.text();
      const good = await fetch(`${handle.callbackUrl}?code=LATE-2&state=${encodeURIComponent(handle.state)}`);
      expect(good.status).toBe(200);
      expect((await handle.complete()).token.accessToken).toBe(ACCESS);
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("POST 回调（form body）也接受 —— 一些 AS 用 POST redirect", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const handle = await startMcpOAuth({
      serverName: "remote", serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json")),
    });
    try {
      const res = await fetch(handle.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `code=POSTED-9&state=${encodeURIComponent(handle.state)}`,
      });
      expect(res.status).toBe(200);
      const result = await handle.complete();
      expect(new URLSearchParams(srv.tokenRequests[0]?.body ?? "").get("code")).toBe("POSTED-9");
      expect(result.token.refreshToken).toBe(REFRESH);
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("超时（timeoutMs 到点无回调）→ fail-closed 报文，不含 verifier/state", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const handle = await startMcpOAuth({
      serverName: "remote", serverUrl: `${srv.origin}/mcp`, timeoutMs: 80,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json")),
    });
    try {
      const err = await handle.complete().then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/timed out|timeout/i);
      expect(err?.message).not.toContain(handle.codeVerifier);
      expect(err?.message).not.toContain(handle.state);
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("换 token 端点 400（body 回显 verifier+code——服务器可控面）→ fail-closed，回显不进错误", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    srv.setTokenResponse((body) => ({
      status: 400,
      body: `invalid_grant echo verifier=${body.get("code_verifier")} code=${body.get("code")}`,
    }));
    const handle = await startMcpOAuth({
      serverName: "remote", serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json")),
    });
    try {
      const res = await fetch(`${handle.callbackUrl}?code=LEAK-1&state=${encodeURIComponent(handle.state)}`);
      expect(res.status).toBe(200);
      const err = await handle.complete().then(() => undefined, (e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toMatch(/token exchange|exchange/i);
      expect(err?.message).not.toContain(handle.codeVerifier);
      expect(err?.message).not.toContain("LEAK-1");
      expect(err?.message).not.toContain(handle.state);
    } finally {
      await handle.cancel().catch(() => {});
      await srv.close();
    }
  });

  it("runMcpOAuthFlow：一步到位（自动 cancel 清理），发现失败抛 fail-closed", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const store = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    const flow = runMcpOAuthFlow({
      serverName: "remote", serverUrl: `${srv.origin}/mcp`,
      deps: { openBrowser: () => {}, log: () => {} },
      tokenStore: store,
      timeoutMs: 60, // 不给回调 → 超时分支
    });
    // 发现成功 + 等回调超时 → fail-closed（超时）且 promise 不悬挂。
    const err = await flow.then(() => undefined, (e: Error) => e);
    expect(err?.message).toMatch(/timed out|timeout/i);
    // token 端点从未被调用（没有 code）。
    expect(srv.tokenRequests.length).toBe(0);
    await srv.close();
  });
});

// ---------------------------------------------------------------------------
// 4+5. 注入与续期（McpHttpClient auth 缝）+ scrub
// ---------------------------------------------------------------------------
describe("McpHttpClient auth 注入与续期", () => {
  it("有 token → 每请求注入 Bearer；token 值不进任何错误/trace", async () => {
    const { f, posts } = scriptedFetch([makeResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }), { headers: { "content-type": "application/json" } })]);
    const traces: string[] = [];
    const client = new McpHttpClient({
      url: "https://x/mcp",
      fetch: f,
      auth: bearerAuth(),
      trace: (r) => { traces.push(JSON.stringify(r)); },
    });
    await client.request("tools/list", {});
    expect(posts[0]?.headers["Authorization"]).toBe(`Bearer ${ACCESS}`);
    await client.close();
    expect(traces.join("\n")).not.toContain(ACCESS);
  });

  it("401 + refresh 成功 → 刷新一次重试一次成功（新 Bearer）", async () => {
    const { f, posts } = scriptedFetch([
      makeResponse("nope", { status: 401, headers: { "content-type": "text/plain" } }),
      makeResponse(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: 1 } }), { headers: { "content-type": "application/json" } }),
    ]);
    const auth = bearerAuth();
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f, auth });
    const result = await client.request("tools/list", {});
    expect(result).toEqual({ ok: 1 });
    expect(auth.refreshes).toBe(1);
    expect(posts.length).toBe(2);
    expect(posts[1]?.headers["Authorization"]).toBe(`Bearer ${ACCESS}-2`);
    await client.close();
  });

  it("401 + refresh 也 401 → fail-closed 报文含 /mcp auth 指引，不含 token 值（回显也不进）", async () => {
    const { f } = scriptedFetch([
      makeResponse(`your token ${ACCESS} is bad`, { status: 401, headers: { "content-type": "text/plain" } }),
      makeResponse(`still bad ${ACCESS}-2`, { status: 401, headers: { "content-type": "text/plain" } }),
    ]);
    const auth = bearerAuth();
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f, auth });
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain("/mcp auth remote");
    expect(err?.message).not.toContain(ACCESS);
    expect(err?.message).not.toContain(`${ACCESS}-2`);
    expect(auth.refreshes).toBe(1);
    await client.close();
  });

  it("401 + refresh 抛错（网络等）→ fail-closed 报文含 /mcp auth 指引，不含 token 值", async () => {
    const { f } = scriptedFetch([
      makeResponse(`echo ${ACCESS}`, { status: 401, headers: { "content-type": "text/plain" } }),
    ]);
    const auth = bearerAuth({
      refresh: async () => { throw new Error(`refresh blew up with ${REFRESH}`); },
    });
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f, auth });
    const err = await client.request("tools/call", {}).then(() => undefined, (e: Error) => e);
    expect(err?.message).toContain("/mcp auth remote");
    expect(err?.message).not.toContain(ACCESS);
    expect(err?.message).not.toContain(REFRESH);
    await client.close();
  });

  it("401 + 无 refresh_token → 直接 16a 同款报文（status-only），单次 POST 不重试", async () => {
    const { f, posts } = scriptedFetch([
      makeResponse("", { status: 401, headers: { "content-type": "text/plain" } }),
    ]);
    const auth = bearerAuth({ refresh: async () => undefined });
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f, auth });
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err?.message).toBe(`MCP HTTP server responded HTTP 401 for "tools/list" (https://x/mcp)`);
    expect(posts.length).toBe(1);
    await client.close();
  });

  it("无 auth 缝 + 401 → 与 16a 字节一致（同文案、单次 POST）", async () => {
    const { f, posts } = scriptedFetch([
      makeResponse("", { status: 401, headers: { "content-type": "text/plain" } }),
    ]);
    const client = new McpHttpClient({ url: "https://x/mcp", fetch: f });
    const err = await client.request("tools/list", {}).then(() => undefined, (e: Error) => e);
    expect(err?.message).toBe(`MCP HTTP server responded HTTP 401 for "tools/list" (https://x/mcp)`);
    expect(posts.length).toBe(1);
    expect(posts[0]?.headers["Authorization"]).toBeUndefined();
    await client.close();
  });

  it("expires_at 临近（<60s）→ getToken 先刷新（省一次 401 往返）；刷新失败回退旧 token", async () => {
    const path = join(tmpDir(), "mcp-tokens.json");
    const now = 1_000_000;
    const store = fileMcpTokenStore(path);
    store.save({ remote: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: now + OAUTH_EXPIRY_REFRESH_SKEW_MS / 2, tokenUrl: "https://as/token", obtainedAt: now } });
    const f = routeFetch({
      "https://as/token": oauthOk({ access_token: ACCESS + "-new", refresh_token: REFRESH + "-new", expires_in: 3600 }),
    });
    const auth = createMcpTokenAuth("remote", { store, fetch: f, now: () => now });
    const t = await auth.getToken();
    expect(t?.accessToken).toBe(ACCESS + "-new");
    expect(f.sent.length).toBe(1);
    expect(new URLSearchParams(f.sent[0]?.body ?? "").get("grant_type")).toBe("refresh_token");
    expect(new URLSearchParams(f.sent[0]?.body ?? "").get("refresh_token")).toBe(REFRESH);
    // 库已更新：refresh_token 轮换 + expires_at 前移。
    const after = store.load()["remote"];
    expect(after?.accessToken).toBe(ACCESS + "-new");
    expect(after?.refreshToken).toBe(REFRESH + "-new");
    // 有效期充足（>skew）→ 不再 fetch。
    const again = await auth.getToken();
    expect(again?.accessToken).toBe(ACCESS + "-new");
    expect(f.sent.length).toBe(1);
    // 刷新失败（400 invalid_grant）→ getToken 回退旧 token；refresh() 抛 fail-closed。
    const f2 = routeFetch({ "https://as/token": oauthStatus(400, "invalid_grant") });
    const store2 = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    store2.save({ remote: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: now + 1_000, tokenUrl: "https://as/token", obtainedAt: now } });
    const auth2 = createMcpTokenAuth("remote", { store: store2, fetch: f2, now: () => now });
    const fallback = await auth2.getToken();
    expect(fallback?.accessToken).toBe(ACCESS); // 旧 token 顶上（401 车道兜底）
    const refreshErr = await auth2.refresh().then(() => undefined, (e: Error) => e);
    expect(refreshErr?.message).toMatch(/refresh/i);
    expect(refreshErr?.message).not.toContain(REFRESH);
    expect(refreshErr?.message).not.toContain(ACCESS);
  });

  it("refresh_token 缺失 → refresh() 返回 undefined（http 层不重试）；无 proactive 刷新", async () => {
    const now = 1_000_000;
    const store = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    store.save({ remote: { accessToken: ACCESS, expiresAt: now + 1_000, tokenUrl: "https://as/token", obtainedAt: now } });
    const f = routeFetch({});
    const auth = createMcpTokenAuth("remote", { store, fetch: f, now: () => now });
    expect(await auth.refresh()).toBeUndefined();
    const t = await auth.getToken();
    expect(t?.accessToken).toBe(ACCESS);
    expect(f.sent.length).toBe(0);
  });

  it("响应不带 refresh_token → 保留旧 refresh_token（不丢续期能力）", async () => {
    const now = 1_000_000;
    const store = fileMcpTokenStore(join(tmpDir(), "mcp-tokens.json"));
    store.save({ remote: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: now + 1_000, tokenUrl: "https://as/token", obtainedAt: now } });
    const f = routeFetch({ "https://as/token": oauthOk({ access_token: ACCESS + "-r2", expires_in: 3600 }) });
    const auth = createMcpTokenAuth("remote", { store, fetch: f, now: () => now });
    await auth.getToken();
    expect(store.load()["remote"]?.refreshToken).toBe(REFRESH);
  });
});

// ---------------------------------------------------------------------------
// 6. token 库 0600
// ---------------------------------------------------------------------------
describe("token 库 0600", () => {
  it("新库落盘即 0600；snake_case 键；load 往返", () => {
    const path = join(tmpDir(), "mcp-tokens.json");
    const store = fileMcpTokenStore(path);
    store.save({ remote: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: 123, scope: "read", tokenUrl: "https://as/token", obtainedAt: 100 } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, unknown>>;
    expect(raw["remote"]?.["access_token"]).toBe(ACCESS);
    expect(raw["remote"]?.["refresh_token"]).toBe(REFRESH);
    expect(raw["remote"]?.["expires_at"]).toBe(123);
    expect(store.load()["remote"]?.accessToken).toBe(ACCESS);
    expect(mcpTokenSecretValues(store.load())).toContain(ACCESS);
    expect(mcpTokenSecretValues(store.load())).toContain(REFRESH);
  });

  it("已存在文件权限不对 → load 时修正到 0600 并 warn", () => {
    const path = join(tmpDir(), "mcp-tokens.json");
    const store = fileMcpTokenStore(path);
    store.save({ remote: { accessToken: ACCESS, tokenUrl: "https://as/token", obtainedAt: 1 } });
    chmodSync(path, 0o644);
    const warns: string[] = [];
    const reopened = fileMcpTokenStore(path, (m) => { warns.push(m); });
    reopened.load();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(warns.some((w) => w.includes("0600"))).toBe(true);
  });

  it("remove：命中删除返回 true；再删 false；库文件同步更新", () => {
    const path = join(tmpDir(), "mcp-tokens.json");
    const store = fileMcpTokenStore(path);
    store.save({
      remote: { accessToken: ACCESS, tokenUrl: "https://as/token", obtainedAt: 1 },
      other: { accessToken: ACCESS + "-o", tokenUrl: "https://as2/token", obtainedAt: 1 },
    });
    expect(store.remove("remote")).toBe(true);
    expect(store.remove("remote")).toBe(false);
    const left = store.load();
    expect(left["remote"]).toBeUndefined();
    expect(left["other"]?.accessToken).toBe(ACCESS + "-o");
  });

  it("坏 JSON / 非对象 → 空库 + warn（绝不崩）；路径走 resolveGlobalHome", () => {
    const path = join(tmpDir(), "mcp-tokens.json");
    writeFileSync(path, "{not json", { mode: 0o600 });
    const warns: string[] = [];
    const store = fileMcpTokenStore(path, (m) => { warns.push(m); });
    expect(store.load()).toEqual({});
    expect(warns.length).toBe(1);
    const home = tmpDir();
    expect(mcpTokensPath({ WUDAO_GLOBAL_HOME: home } as NodeJS.ProcessEnv)).toBe(join(home, "mcp-tokens.json"));
    expect(defaultMcpTokenStore({ WUDAO_GLOBAL_HOME: home } as NodeJS.ProcessEnv).load()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 7. 命令面 + config + /mcp 裸标注 + tools 端到端
// ---------------------------------------------------------------------------
describe("命令面与接缝", () => {
  it("parseReplCommand：/mcp 裸与 auth/unauth 子形；/mcpx 仍是 prompt", () => {
    expect(parseReplCommand("/mcp")).toEqual({ kind: "mcp", args: "" });
    expect(parseReplCommand("/mcp auth github")).toEqual({ kind: "mcp", args: "auth github" });
    expect(parseReplCommand("/mcp unauth github")).toEqual({ kind: "mcp", args: "unauth github" });
    expect(parseReplCommand("/mcpx hi")).toHaveProperty("kind", "prompt");
  });

  it("config：oauth/authorizationUrl/tokenUrl/clientId 进 http 形；stdio 带之被拒", () => {
    expect(normalizeServer("r", { url: "https://x/mcp", oauth: true })).toEqual({ url: "https://x/mcp", oauth: true });
    expect(normalizeServer("r", {
      url: "https://x/mcp", oauth: true,
      authorizationUrl: "https://as/authorize", tokenUrl: "https://as/token", clientId: "wudao",
    })).toEqual({ url: "https://x/mcp", oauth: true, authorizationUrl: "https://as/authorize", tokenUrl: "https://as/token", clientId: "wudao" });
    expect(normalizeServer("r", { command: "npx", oauth: true })).toBeUndefined();
    expect(normalizeServer("r", { url: "https://x/mcp", oauth: "yes" })).toBeUndefined();
    expect(normalizeServer("r", { url: "https://x/mcp", authorizationUrl: "not-a-url" })).toBeUndefined();
    // 非 oauth 的 http/stdio 形不变（16a 形零改动）。
    expect(normalizeServer("r", { command: "npx", args: ["x"] })).toEqual({ command: "npx", args: ["x"] });
    expect(normalizeServer("r", { url: "https://x/mcp" })).toEqual({ url: "https://x/mcp" });
  });

  it("/mcp 裸：oauth 行标注 authed/auth needed；非 oauth 行字节不变", () => {
    const config = {
      servers: {
        gh: { url: "https://gh/mcp", oauth: true },
        plain: { url: "https://plain/mcp" },
        local: { command: "npx", args: ["-y", "mcp"] },
      },
    };
    const withAuth = formatMcpReport(buildMcpRows({ config, toolNames: [], authStatus: (s) => s === "gh" }));
    expect(withAuth).toContain("gh:");
    expect(withAuth).toContain("oauth：已授权"); // ω99-180: 钉随源演进
    const withAuthMissing = formatMcpReport(buildMcpRows({ config, toolNames: [], authStatus: () => false }));
    expect(withAuthMissing).toContain("oauth：需授权"); // ω99-180: 钉随源演进
    // 非 oauth 行与不传 authStatus 的输出逐字节一致（oauth 标注是纯增量）。
    const without = formatMcpReport(buildMcpRows({ config, toolNames: [] }));
    const stripOauth = (s: string): string => s.replace(/ · oauth：(已授权|需授权)/g, ""); // ω99-180: 钉随源演进（功能钉，与 :162 源串锁步）
    expect(stripOauth(withAuth)).toBe(stripOauth(without));
    expect(stripOauth(withAuthMissing)).toBe(stripOauth(without));
    // 非 oauth 行原样逐字节（不 strip 也一致）。
    const plainLines = (s: string): readonly string[] => s.split("\n").filter((l) => !l.trimStart().startsWith("gh:"));
    expect(plainLines(withAuth)).toEqual(plainLines(without));
  });

  it("runMcpAuthCommand：语法/未知 server/非 oauth fail-closed 文案", async () => {
    const ws = tmpDir();
    expect(await runMcpAuthCommand({ args: "", workspaceRoot: ws })).toMatch(/用法：/); // ω99-166d-i: 泛 usage 钉演进（#29）
    expect(await runMcpAuthCommand({ args: "auth", workspaceRoot: ws })).toMatch(/用法：/); // ω99-166d-i: 泛 usage 钉演进（#29）
    expect(await runMcpAuthCommand({ args: "auth nowhere", workspaceRoot: ws })).toMatch(/nowhere/);
    mkdirSync(join(ws, ".wudao"), { recursive: true });
    writeFileSync(join(ws, ".wudao", "mcp.json"), JSON.stringify({ servers: { plain: { url: "https://plain/mcp" } } }));
    expect(await runMcpAuthCommand({ args: "auth plain", workspaceRoot: ws })).toMatch(/oauth/i);
    writeFileSync(join(ws, ".wudao", "mcp.json"), JSON.stringify({ servers: { gh: { url: "https://gh/mcp", oauth: true } } }));
    expect(await runMcpAuthCommand({ args: "unauth gh", workspaceRoot: ws })).toMatch(/gh/);
  });

  it("runMcpAuthCommand auth 全链路 → 库落 token；回执不带 token 值", async () => {
    const srv = await startFakeOAuthServer({ protectedResource: false });
    const ws = tmpDir();
    const home = tmpDir();
    const env = { WUDAO_GLOBAL_HOME: home } as NodeJS.ProcessEnv;
    mkdirSync(join(ws, ".wudao"), { recursive: true });
    writeFileSync(join(ws, ".wudao", "mcp.json"), JSON.stringify({
      servers: { gh: { url: `${srv.origin}/mcp`, oauth: true } },
    }));
    const logs: string[] = [];
    try {
      const receipt = await runMcpAuthCommand({
        args: "auth gh", workspaceRoot: ws, env,
        deps: {
          openBrowser: () => {},
          log: (l) => { logs.push(l); },
          // 回调直调：拿到授权 URL 即触发（人动作的确定性替身）。
          onAuthorizationUrl: async (url) => {
            const u = new URL(url);
            const cb = new URL(u.searchParams.get("redirect_uri") ?? "");
            cb.searchParams.set("code", "CMD-7");
            cb.searchParams.set("state", u.searchParams.get("state") ?? "");
            const r = await fetch(cb.toString());
            expect(r.status).toBe(200);
          },
        },
      });
      expect(receipt).toContain("gh");
      expect(receipt).not.toContain(ACCESS);
      expect(receipt).not.toContain(REFRESH);
      expect(logs.some((l) => l.includes("/authorize?"))).toBe(true);
      const stored = defaultMcpTokenStore(env).load()["gh"];
      expect(stored?.accessToken).toBe(ACCESS);
      expect(stored?.refreshToken).toBe(REFRESH);
      // unauth 忘却。
      const unauth = await runMcpAuthCommand({ args: "unauth gh", workspaceRoot: ws, env });
      expect(unauth).toMatch(/gh/);
      expect(defaultMcpTokenStore(env).load()["gh"]).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("tools.ts 端到端：oauth 服务器带库 token → Bearer 门控 fake server 连接成功；缺 token fail-visible", async () => {
    const home = tmpDir();
    const prevHome = process.env.WUDAO_GLOBAL_HOME;
    process.env.WUDAO_GLOBAL_HOME = home;
    try {
      const gated = await startBearerGatedMcpServer(ACCESS);
      try {
        // 缺 token → 握手 401 → fail-visible（warn + 零工具）。
        const warns: string[] = [];
        let tools = await loadMcpTools({ servers: { gated: { url: gated.url, oauth: true } } }, (m) => { warns.push(m); });
        await closeMcpTools();
        expect(tools.length).toBe(0);
        expect(warns.some((w) => w.includes("401"))).toBe(true);
        // 存 token → 连接成功，tools/call 带 Bearer。
        defaultMcpTokenStore().save({ gated: { accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 3_600_000, tokenUrl: "https://as/token", obtainedAt: Date.now() } });
        tools = await loadMcpTools({ servers: { gated: { url: gated.url, oauth: true } } });
        try {
          expect(tools.some((t) => t.name === "mcp__gated__echo")).toBe(true);
          const echo = tools.find((t) => t.name === "mcp__gated__echo");
          const result = await echo?.execute({}) ?? { content: "(missing)" };
          expect(result.isError).toBeFalsy();
        } finally {
          await closeMcpTools();
        }
      } finally {
        await gated.close();
      }
    } finally {
      if (prevHome === undefined) delete process.env.WUDAO_GLOBAL_HOME;
      else process.env.WUDAO_GLOBAL_HOME = prevHome;
      await closeMcpTools();
    }
  });
});
