// P2-16b（96 队列 #16）MCP OAuth 流 v1 —— authorization_code + PKCE（S256）
// + 本地 127.0.0.1 回调 + token 交换 + refresh_token 刷新。
//
// 人触发（/trust 同款纪律——鉴权流是人动作，不给模型工具）：`/mcp auth
// <server>` 走 discovery → PKCE → 临时回调 server → 打印授权 URL（浏览器
// best-effort）→ 等回调（默认 5 分钟）→ POST token_endpoint → 0600 库。
//
// 纪律：
// - **三面永不泄漏**：access/refresh token、code_verifier、state 绝不进
//   错误文案/日志/trace。错误文案只含数字 status 与 redactUrl 后的地址；
//   服务器回显面（body/statusText）一概不进文案（16a 同款）。错误组装后
//   再过一遍 scrubSecrets（verifier/state/code/token 全值）作纵深防御。
// - **回调只绑 127.0.0.1**；state 不匹配 → 该回调被拒（400），流程继续
//   等待正确回调（CSRF 防护）。
// - **fail-closed**：发现失败/超时/交换失败/刷新失败全部以可见报文浮出
//   （含 /mcp auth <server> 指引），不静默。
// - **零新依赖**：node:crypto（手写 PKCE——SHA256+base64url 十行内）、
//   node:http、全局 fetch；fetch/now/openBrowser 全可注入（确定性测试）。
// - 非 oauth 路径零涉：本模块只被 oauth:true 的 server 与 /mcp 命令面引用。
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { redactUrl, scrubSecrets } from "./http.js";
import type { McpHttpAuth, McpHttpAuthView } from "./http.js";
import { capTraceDetail } from "./trace.js";
import { defaultMcpTokenStore } from "./tokens.js";
import type { McpStoredToken, McpTokenStore } from "./tokens.js";

// ---------------------------------------------------------------------------
// PKCE（RFC 7636，手写——零依赖红线）
// ---------------------------------------------------------------------------

/** 32 random bytes → 43 base64url chars（RFC 下界，单一形状）。 */
const CODE_VERIFIER_BYTES = 32;

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

/** 生成 code_verifier（43 字符，unreserved 子域 A-Za-z0-9-_，无填充）。 */
export function generateCodeVerifier(rand: (byteCount: number) => Uint8Array = randomBytes): string {
  return base64url(rand(CODE_VERIFIER_BYTES));
}

/** S256 code_challenge = base64url(sha256(verifier))，无填充。 */
export function pkceS256Challenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

// ---------------------------------------------------------------------------
// 发现（well-known 链 + config 直给 + fail-closed）
// ---------------------------------------------------------------------------

/** The endpoints the flow needs. */
export interface OAuthEndpoints {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
}

/** The structural OAuth HTTP response this module consumes (node fetch 满足). */
export interface OAuthHttpResponse {
  readonly status: number;
  readonly ok?: boolean;
  text(): Promise<string>;
}

export interface OAuthFetchInit {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
}

/** Injectable fetch seam（测试接缝；缺省 node 全局 fetch）。 */
export type OAuthFetch = (url: string, init: OAuthFetchInit) => Promise<OAuthHttpResponse>;

const globalOAuthFetch: OAuthFetch = (url, init) =>
  fetch(url, init as unknown as RequestInit) as unknown as Promise<OAuthHttpResponse>;

const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/** Config-carried explicit endpoints（mcp.json 的 authorizationUrl/tokenUrl）。 */
export interface OAuthConfigEndpoints {
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
}

function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    throw new Error(`MCP OAuth discovery failed: server url "${url}" is not a valid absolute URL`);
  }
}

function isHttpUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** GET one well-known doc. undefined = miss（404 / 200 但字段不可用）；
 *  throw = fail-closed（网络错 / 非 404 非 2xx / 坏 JSON——服务器有元数据
 *  但坏了，要让人看见，不当 miss 静默跳过）。 */
async function fetchWellKnown(url: string, fetchImpl: OAuthFetch): Promise<Record<string, unknown> | undefined> {
  let res: OAuthHttpResponse;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { Accept: "application/json" } });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP OAuth discovery request to ${redactUrl(url)} failed (${capTraceDetail(cause)})`);
  }
  if (res.status === 404) return undefined;
  if (res.status < 200 || res.status > 299) {
    throw new Error(`MCP OAuth discovery endpoint ${redactUrl(url)} responded HTTP ${res.status}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP OAuth discovery endpoint ${redactUrl(url)} returned an unreadable body (${cause})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined; // 200 + 非 JSON → 视为该候选不可用，链上继续
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

function endpointsFrom(doc: Record<string, unknown> | undefined): OAuthEndpoints | undefined {
  if (doc === undefined) return undefined;
  const a = doc["authorization_endpoint"];
  const t = doc["token_endpoint"];
  if (typeof a !== "string" || a.length === 0 || !isHttpUrl(a)) return undefined;
  if (typeof t !== "string" || t.length === 0 || !isHttpUrl(t)) return undefined;
  return { authorizationEndpoint: a, tokenEndpoint: t };
}

function firstAuthorizationServer(doc: Record<string, unknown> | undefined): string | undefined {
  if (doc === undefined) return undefined;
  const list = doc["authorization_servers"];
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const first = list[0];
  return typeof first === "string" && isHttpUrl(first) ? first : undefined;
}

/** 发现链：①`{origin}/.well-known/oauth-protected-resource`（直接给
 *  endpoints 的容忍形，或 authorization_servers[0] → 该 AS 的
 *  `.well-known/oauth-authorization-server`）；②404 → `{origin}/
 *  .well-known/oauth-authorization-server`；③再 404 → config 直给
 *  （两者齐才可用）；④全无 → fail-closed（报文给人，不静默）。 */
export async function discoverOAuthEndpoints(
  serverUrl: string,
  opts: { readonly fetch?: OAuthFetch; readonly configEndpoints?: OAuthConfigEndpoints } = {},
): Promise<OAuthEndpoints> {
  const fetchImpl = opts.fetch ?? globalOAuthFetch;
  const origin = originOf(serverUrl);
  const prDoc = await fetchWellKnown(`${origin}${PROTECTED_RESOURCE_PATH}`, fetchImpl);
  const direct = endpointsFrom(prDoc);
  if (direct !== undefined) return direct;
  const as = firstAuthorizationServer(prDoc);
  if (as !== undefined) {
    const asDoc = await fetchWellKnown(`${originOf(as)}${AUTHORIZATION_SERVER_PATH}`, fetchImpl);
    const chained = endpointsFrom(asDoc);
    if (chained !== undefined) return chained;
  }
  const fallbackDoc = await fetchWellKnown(`${origin}${AUTHORIZATION_SERVER_PATH}`, fetchImpl);
  const fallback = endpointsFrom(fallbackDoc);
  if (fallback !== undefined) return fallback;
  const cfgAuth = opts.configEndpoints?.authorizationUrl;
  const cfgToken = opts.configEndpoints?.tokenUrl;
  if (typeof cfgAuth === "string" && isHttpUrl(cfgAuth) && typeof cfgToken === "string" && isHttpUrl(cfgToken)) {
    return { authorizationEndpoint: cfgAuth, tokenEndpoint: cfgToken };
  }
  throw new Error(
    `MCP OAuth discovery failed for ${redactUrl(serverUrl)}: no usable ${PROTECTED_RESOURCE_PATH} or ${AUTHORIZATION_SERVER_PATH} metadata, and the config gives no explicit authorizationUrl/tokenUrl — set both on the server entry (mcp.json) or fix the server, then rerun /mcp auth`,
  );
}

// ---------------------------------------------------------------------------
// 授权码流（发现 → PKCE → 本地回调 → 交换 → 落库）
// ---------------------------------------------------------------------------

export const OAUTH_CALLBACK_PATH = "/callback";
export const DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS = 300_000;
/** expires_at 距今不足该窗 → 发请求前先刷新（省一次 401 往返）。 */
export const OAUTH_EXPIRY_REFRESH_SKEW_MS = 60_000;
/** The human-facing callback page (no secrets in it by construction). */
const CALLBACK_OK_PAGE = "✅ wudao-harness MCP 授权完成 — 可以关闭此页回到终端。";

export interface McpOAuthDeps {
  readonly fetch?: OAuthFetch;
  readonly now?: () => number;
  /** best-effort 浏览器打开（darwin `open` / linux `xdg-open`）；失败只打印。 */
  readonly openBrowser?: (url: string) => void;
  /** 人面输出（授权 URL 等；值不敏感之外的一切都走这里）。 */
  readonly log?: (line: string) => void;
  /** 授权 URL 就绪即回调（TUI/测试接缝——拿到 URL 的瞬间就能反应）。 */
  readonly onAuthorizationUrl?: (url: string) => void | Promise<void>;
}

export interface McpOAuthFlowOptions {
  readonly serverName: string;
  readonly serverUrl: string;
  readonly configEndpoints?: OAuthConfigEndpoints;
  /** 公共客户端可选：部分 AS 要求 client_id。 */
  readonly clientId?: string;
  /** 等回调上限（默认 5 分钟）。 */
  readonly timeoutMs?: number;
  readonly deps?: McpOAuthDeps;
  readonly tokenStore?: McpTokenStore;
}

export interface McpOAuthFlowResult {
  readonly serverName: string;
  readonly callbackPort: number;
  readonly token: McpStoredToken;
}

/** The in-flight flow handle（测试直调回调的接缝）。`state`/`codeVerifier`
 *  是机密：只活在内存句柄里，永不进日志/错误/trace。 */
export interface McpOAuthHandle {
  readonly authorizationUrl: string;
  readonly callbackUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
  /** 等回调 → 交换 → 落库 → 回执（超时/交换失败 fail-closed 抛错）。 */
  complete(): Promise<McpOAuthFlowResult>;
  /** 清理（关回调 server、清计时器）；已 settle 则幂等无害。 */
  cancel(): Promise<void>;
}

function formEncode(fields: ReadonlyArray<readonly [string, string]>): string {
  return fields.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

/** Launch the flow: discovery + PKCE + the loopback callback listener. The
 *  authorization URL is logged/opened BEFORE waiting (人动作面). */
export async function startMcpOAuth(opts: McpOAuthFlowOptions): Promise<McpOAuthHandle> {
  const deps = opts.deps ?? {};
  const fetchImpl = deps.fetch ?? globalOAuthFetch;
  const now = deps.now ?? Date.now;
  const store = opts.tokenStore ?? defaultMcpTokenStore();
  const endpoints = await discoverOAuthEndpoints(opts.serverUrl, {
    ...(deps.fetch !== undefined ? { fetch: fetchImpl } : {}),
    ...(opts.configEndpoints !== undefined ? { configEndpoints: opts.configEndpoints } : {}),
  });
  const codeVerifier = generateCodeVerifier();
  const state = randomBytes(24).toString("hex");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_OAUTH_CALLBACK_TIMEOUT_MS;

  // 本地回调：只绑 127.0.0.1（红线），临时端口。
  let settleResolve: ((code: string) => void) | undefined;
  let settleReject: ((err: Error) => void) | undefined;
  const callbackPromise = new Promise<string>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });
  const server = createServer((req, res) => {
    const finish = (status: number, body: string, ctype = "text/plain; charset=utf-8"): void => {
      res.writeHead(status, { "content-type": ctype, "cache-control": "no-store" });
      res.end(body);
    };
    void (async () => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== OAUTH_CALLBACK_PATH) return finish(404, "not found");
      // GET：query；POST（部分 AS 用 POST redirect）：urlencoded body。
      let code = u.searchParams.get("code");
      let cbState = u.searchParams.get("state");
      if (req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (code === null) code = form.get("code");
        if (cbState === null) cbState = form.get("state");
      } else if (req.method !== "GET") {
        return finish(405, "method not allowed");
      }
      if (cbState !== state) {
        // CSRF：拒绝该回调，流程继续等正确回调。
        return finish(400, "state mismatch — callback rejected (possible CSRF)");
      }
      if (code === null || code.length === 0) {
        return finish(400, "missing authorization code");
      }
      const r = settleResolve;
      finish(200, CALLBACK_OK_PAGE, "text/html; charset=utf-8");
      if (r !== undefined) r(code);
    })().catch(() => {
      try { res.destroy(); } catch { /* socket already gone */ }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const callbackUrl = `http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`;

  const authParams: ReadonlyArray<readonly [string, string]> = [
    ["response_type", "code"],
    ["redirect_uri", callbackUrl],
    ["state", state],
    ["code_challenge", pkceS256Challenge(codeVerifier)],
    ["code_challenge_method", "S256"],
    ...(opts.clientId !== undefined && opts.clientId.length > 0 ? ([["client_id", opts.clientId]] as const) : []),
  ];
  const authorizationUrl = `${endpoints.authorizationEndpoint}${endpoints.authorizationEndpoint.includes("?") ? "&" : "?"}${formEncode(authParams)}`;

  // 计时器：超时 → fail-closed + 关 server（waiting-on-browser 的上界）。
  const timer = setTimeout(() => {
    const r = settleReject;
    server.close(() => {});
    if (r !== undefined) {
      r(new Error(`MCP OAuth callback for "${opts.serverName}" timed out after ${Math.round(timeoutMs / 1000)}s — no authorization code arrived; rerun /mcp auth ${opts.serverName}`));
    }
  }, timeoutMs);
  timer.unref?.();

  const cleanup = (): void => {
    clearTimeout(timer);
    server.close(() => {});
  };
  callbackPromise.then(() => cleanup(), () => cleanup());

  deps.log?.(`mcp oauth [${opts.serverName}]: 授权 URL（${Math.round(timeoutMs / 1000)}s 内在浏览器完成授权）：`);
  deps.log?.(authorizationUrl);
  if (deps.openBrowser !== undefined) {
    try {
      deps.openBrowser(authorizationUrl);
    } catch {
      // best-effort：打不开只打印（URL 已在上一行）。
    }
  }
  if (deps.onAuthorizationUrl !== undefined) {
    try {
      await deps.onAuthorizationUrl(authorizationUrl);
    } catch {
      // 观察者失败隔离（Events ≠ Hooks）。
    }
  }

  const scrubAll = (text: string, extra: readonly string[] = []): string =>
    scrubSecrets(text, [codeVerifier, state, ...extra]);

  const exchange = async (code: string): Promise<McpOAuthFlowResult> => {
    const body = formEncode([
      ["grant_type", "authorization_code"],
      ["code", code],
      ["code_verifier", codeVerifier],
      ["redirect_uri", callbackUrl],
      ...(opts.clientId !== undefined && opts.clientId.length > 0 ? ([["client_id", opts.clientId]] as const) : []),
    ]);
    let res: OAuthHttpResponse;
    try {
      res = await fetchImpl(endpoints.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" failed: ${redactUrl(endpoints.tokenEndpoint)} unreachable (${cause})`, [code]));
    }
    if (res.status < 200 || res.status > 299) {
      // 服务器回显面（body/statusText）不进文案——见过 verifier/code 的
      // 服务器可以原样回显（16a 非 2xx 纪律同款）。
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" failed (HTTP ${res.status} from ${redactUrl(endpoints.tokenEndpoint)}) — rerun /mcp auth ${opts.serverName}`, [code]));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" returned an unreadable body (${cause})`, [code]));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" returned a non-JSON body — rerun /mcp auth ${opts.serverName}`, [code]));
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" returned a non-object body — rerun /mcp auth ${opts.serverName}`, [code]));
    }
    const r = parsed as Record<string, unknown>;
    const accessToken = r["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(scrubAll(`MCP OAuth token exchange for "${opts.serverName}" returned no access_token — rerun /mcp auth ${opts.serverName}`, [code]));
    }
    const refreshToken = typeof r["refresh_token"] === "string" && r["refresh_token"].length > 0 ? r["refresh_token"] : undefined;
    const expiresIn = typeof r["expires_in"] === "number" && Number.isFinite(r["expires_in"]) && r["expires_in"] > 0 ? r["expires_in"] : undefined;
    const scope = typeof r["scope"] === "string" && r["scope"].length > 0 ? r["scope"] : undefined;
    const token: McpStoredToken = {
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
      ...(expiresIn !== undefined ? { expiresAt: now() + expiresIn * 1000 } : {}),
      ...(scope !== undefined ? { scope } : {}),
      tokenUrl: endpoints.tokenEndpoint,
      obtainedAt: now(),
    };
    const tokens = store.load();
    tokens[opts.serverName] = token;
    store.save(tokens);
    return { serverName: opts.serverName, callbackPort: port, token };
  };

  return {
    authorizationUrl,
    callbackUrl,
    state,
    codeVerifier,
    complete: async () => {
      const code = await callbackPromise;
      try {
        return await exchange(code);
      } finally {
        cleanup();
      }
    },
    cancel: async () => {
      cleanup();
      const r = settleReject;
      if (r !== undefined) r(new Error(`MCP OAuth flow for "${opts.serverName}" cancelled`));
      await callbackPromise.catch(() => {});
    },
  };
}

/** One-shot：start + complete，失败自动 cancel 清理。 */
export async function runMcpOAuthFlow(opts: McpOAuthFlowOptions): Promise<McpOAuthFlowResult> {
  const handle = await startMcpOAuth(opts);
  try {
    return await handle.complete();
  } catch (err) {
    await handle.cancel().catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// McpHttpAuth 工厂（http.ts 的动态注入缝；expiry 策略在这里，传输策略在 http）
// ---------------------------------------------------------------------------

export function createMcpTokenAuth(
  serverName: string,
  opts: { readonly store?: McpTokenStore; readonly fetch?: OAuthFetch; readonly now?: () => number } = {},
): McpHttpAuth {
  const store = opts.store ?? defaultMcpTokenStore();
  const fetchImpl = opts.fetch ?? globalOAuthFetch;
  const now = opts.now ?? Date.now;

  /** POST token_endpoint 的公共壳：2xx → 解析；非 2xx → fail-closed（无回显
   *  body）；无 refresh 能力 → undefined。 */
  const doRefresh = async (): Promise<McpHttpAuthView | undefined> => {
    const entry = store.load()[serverName];
    if (entry === undefined || entry.refreshToken === undefined || entry.tokenUrl.length === 0) return undefined;
    let res: OAuthHttpResponse;
    try {
      res = await fetchImpl(entry.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: formEncode([["grant_type", "refresh_token"], ["refresh_token", entry.refreshToken]]),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" failed: ${redactUrl(entry.tokenUrl)} unreachable (${cause})`, [entry.accessToken, entry.refreshToken]));
    }
    if (res.status < 200 || res.status > 299) {
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" failed (HTTP ${res.status} from ${redactUrl(entry.tokenUrl)}) — rerun /mcp auth ${serverName}`, [entry.accessToken, entry.refreshToken]));
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" returned an unreadable body (${cause})`, [entry.accessToken, entry.refreshToken]));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" returned a non-JSON body (${cause}) — rerun /mcp auth ${serverName}`, [entry.accessToken, entry.refreshToken]));
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" returned a non-object body — rerun /mcp auth ${serverName}`, [entry.accessToken, entry.refreshToken]));
    }
    const r = parsed as Record<string, unknown>;
    const accessToken = r["access_token"];
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(scrubSecrets(`MCP OAuth token refresh for "${serverName}" returned no access_token — rerun /mcp auth ${serverName}`, [entry.accessToken, entry.refreshToken]));
    }
    const refreshToken = typeof r["refresh_token"] === "string" && r["refresh_token"].length > 0 ? r["refresh_token"] : entry.refreshToken;
    const expiresIn = typeof r["expires_in"] === "number" && Number.isFinite(r["expires_in"]) && r["expires_in"] > 0 ? r["expires_in"] : undefined;
    const scope = typeof r["scope"] === "string" && r["scope"].length > 0 ? r["scope"] : entry.scope;
    const updated: McpStoredToken = {
      accessToken,
      refreshToken,
      ...(expiresIn !== undefined ? { expiresAt: now() + expiresIn * 1000 } : {}),
      ...(scope !== undefined ? { scope } : {}),
      tokenUrl: entry.tokenUrl,
      obtainedAt: now(),
    };
    const tokens = store.load();
    tokens[serverName] = updated;
    store.save(tokens);
    return { accessToken: updated.accessToken, ...(updated.expiresAt !== undefined ? { expiresAt: updated.expiresAt } : {}) };
  };

  return {
    serverName,
    getToken: async () => {
      const entry = store.load()[serverName];
      if (entry === undefined) return undefined;
      const expiringSoon = entry.expiresAt !== undefined && entry.expiresAt - now() < OAUTH_EXPIRY_REFRESH_SKEW_MS;
      if (expiringSoon && entry.refreshToken !== undefined) {
        try {
          const fresh = await doRefresh();
          if (fresh !== undefined) return fresh;
        } catch {
          // 主动刷新失败 → 回退旧 token（最终裁决权在服务器 401 车道）。
        }
      }
      return { accessToken: entry.accessToken, ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}) };
    },
    refresh: doRefresh,
  };
}
