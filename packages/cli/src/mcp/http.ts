// MCP streamable HTTP transport（96 队列 P2-16a）—— the remote-server face.
//
// 对应 stdio 的 JsonRpcClient，但无常驻进程：每个 JSON-RPC 消息是一次独立
// POST（streamable HTTP 的无状态用法），响应二形 —— `application/json` 单
// 消息直取，或 `text/event-stream` 逐 event 解析（取到对应 id 的响应即完
// 成；通知/服务器发起的请求忽略但计数）。Mcp-Session-Id 从 initialize 响
// 应头捕获、后续请求回带；服务器不发则不带（无会话形态）。
//
// 纪律（与 stdio 同款）：
// - fail-closed：每请求超时（AbortSignal.timeout）、非 2xx、坏 body、SSE
//   流结束无响应，全部以错误浮出到工具面；文案类复用 JsonRpcTimeoutError
//   /JsonRpcError（工具面看到的超时/错误文本与 stdio 字节一致）。
// - secrets 三面不泄漏（日志/错误文案/trace）：静态 headers 的值、捕获的
//   session id、URL 里的凭据（userinfo/query）绝不进入任何错误文本或 trace
//   记录 —— scrubSecrets 是最后一道网；非 2xx 的错误文案只含数字 status
//   （statusText/响应头/响应体都是服务器可控面，见过 token 的恶意服务器
//   可以原样回显，故一概不进文案）。
// - http:// 明文只允许显式写：不升级、不改写；https 直连。
// - 零新依赖：node 内建 fetch/TextDecoder/AbortSignal；fetch 可注入（测试
//   接缝，onStderr 先例）。
//
// 与 stdio 的已知分歧（有据）：close() 不中断在途请求（没有要杀的进程；
// 序列化链排空即返回，每次 POST 自带超时上界），后续请求按 stdio 同款
// 文案 fail-closed。
import { JsonRpcError, JsonRpcTimeoutError } from "./json-rpc.js";
import { capTraceBody, capTraceDetail, parseTraceEnv, type McpFrameRecord } from "./trace.js";

/** Per-request timeout default (same value as the stdio client's). */
const DEFAULT_HTTP_REQUEST_TIMEOUT_MS = 120_000;

/** The structural Response shape this transport consumes — node's global
 *  fetch (undici) satisfies it; tests hand-build fakes. The explicit
 *  interface keeps the build free of a DOM lib dependency. */
export interface McpHttpResponse {
  readonly ok?: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  /** JSON form reads the whole body as text. */
  readonly text?: () => Promise<string>;
  /** SSE form reads the body as a byte stream. */
  readonly body?: {
    getReader(): {
      read(): Promise<{ done?: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
  };
}

export interface McpHttpFetchInit {
  readonly method: "POST";
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Injectable fetch seam (tests inject scripted/fake transports). */
export type McpHttpFetch = (url: string, init: McpHttpFetchInit) => Promise<McpHttpResponse>;

/** node's global fetch satisfies the seam (cast: undici's ReadableStream
 *  variance vs. our structural reader is not worth a DOM lib). */
const globalFetch: McpHttpFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<McpHttpResponse>;

export interface McpHttpClientOptions {
  readonly url: string;
  /** Static headers merged into every POST (the API-token lane; OAuth's
   *  dynamic tokens are a later arc). Transport-owned names were already
   *  stripped at config normalization. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Default per-request timeout in ms (each request may override). Default 120_000. */
  readonly timeoutMs?: number;
  /** P2-16b: the dynamic OAuth seam — per-request Bearer injection plus the
   *  401 → refresh → retry-once lane. Absent (the default) = the 16a
   *  behavior, byte-stable. See McpHttpAuth. */
  readonly auth?: McpHttpAuth;
  /** Injectable fetch (the test seam — the onStderr precedent; absent →
   *  node's global fetch). */
  readonly fetch?: McpHttpFetch;
  /** Debug/trace sink override (the onStderr precedent; absent → WUDAO_MCP_TRACE decides). */
  readonly trace?: (r: McpFrameRecord) => void;
}

/** P2-16b — the access-token view the transport consumes (secret: the value
 *  joins the scrub set the moment it is put on the wire). */
export interface McpHttpAuthView {
  readonly accessToken: string;
  /** Epoch ms; the auth provider (mcp/oauth.ts) owns the proactive-refresh
   *  policy against it — the transport only sees the result. */
  readonly expiresAt?: number;
}

/** P2-16b — the OAuth seam the HTTP transport consumes. The client stays
 *  OAuth-agnostic: `getToken` answers "what bearer do I send" (the provider
 *  proactively refreshes when expiry is <60s away), `refresh` answers "get a
 *  fresh one" (undefined = no refresh_token exists → no retry; a throw = the
 *  refresh ran and failed → fail-closed with the /mcp auth hint). */
export interface McpHttpAuth {
  /** Config key of the server (error hints say `/mcp auth <serverName>`). */
  readonly serverName: string;
  getToken(): Promise<McpHttpAuthView | undefined>;
  refresh(): Promise<McpHttpAuthView | undefined>;
}

/** URL for logs/errors/trace: scheme//host/path only — userinfo and query
 *  (both legal places for credentials) never survive redaction. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}

/** Replace every occurrence of each secret with a visible marker — the last
 *  line of defense before any server-controlled text reaches an error
 *  message (a server that saw our Authorization header can echo it). */
export function scrubSecrets(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s.length === 0) continue;
    if (out.includes(s)) out = out.split(s).join("«redacted»");
  }
  return out;
}

/** A matched JSON-RPC response (the subset the client reads). */
interface JsonRpcResponseShape {
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

interface RequestContext {
  readonly method: string;
  readonly id: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly sentAt: number;
}

export class McpHttpClient {
  private readonly url: string;
  private readonly staticHeaders: Readonly<Record<string, string>>;
  private readonly defaultTimeoutMs: number;
  private readonly fetchImpl: McpHttpFetch;
  private readonly auth?: McpHttpAuth;
  private readonly traceSink?: (r: McpFrameRecord) => void;
  private traceSinkNoted = false;
  private sessionId: string | undefined;
  private closed = false;
  private nextId = 1;
  /** Outbound serialization: `notifications/initialized` must land before
   *  the next request (the MCP handshake law); every send rides this chain,
   *  which never rejects (a failed send never poisons the next one). */
  private chain: Promise<unknown> = Promise.resolve();
  /** Everything that must never surface in errors/traces: static header
   *  values, the captured session id, URL-embedded credentials, and (P2-16b)
   *  every access token that has touched the wire. */
  private readonly secrets = new Set<string>();
  /** Server→client notifications (and requests) seen in SSE streams —
   *  ignored but counted (the brief's "忽略但计数" lane; observable for
   *  tests and diagnostics). */
  public notificationsIgnored = 0;

  constructor(opts: McpHttpClientOptions) {
    this.url = opts.url;
    this.staticHeaders = opts.headers ?? {};
    this.defaultTimeoutMs = opts.timeoutMs ?? DEFAULT_HTTP_REQUEST_TIMEOUT_MS;
    this.fetchImpl = opts.fetch ?? globalFetch;
    this.auth = opts.auth;
    this.traceSink = opts.trace ?? parseTraceEnv(process.env.WUDAO_MCP_TRACE)?.sink;
    for (const value of Object.values(this.staticHeaders)) {
      if (value.length > 0) this.secrets.add(value);
    }
    // URL-embedded credentials (userinfo / query) must never surface raw.
    const userinfo = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+@/i.exec(opts.url);
    if (userinfo !== null) this.secrets.add(userinfo[0]);
    const q = opts.url.indexOf("?");
    if (q !== -1) this.secrets.add(opts.url.slice(q));
  }

  /** Send a request and resolve with the `result` member of the response. */
  request(method: string, params: unknown, opts?: { readonly timeoutMs?: number }): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("MCP server connection is closed"));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
    const send = (): Promise<unknown> =>
      this.post({ jsonrpc: "2.0", id, method, params }, { method, id, timeoutMs }, "request");
    const queued = this.chain.then(send, send);
    this.chain = queued.then(() => undefined, () => undefined);
    return queued;
  }

  /** Fire-and-forget notification (no id, response ignored — 202 Accepted is
   *  the spec shape). Swallows its own failures (stdio parity: a notify on a
   *  dead lane never throws at the caller). */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    const send = (): Promise<void> =>
      this.post({ jsonrpc: "2.0", method, params }, { method, id: -1, timeoutMs: this.defaultTimeoutMs }, "notify")
        .then(() => undefined, (err: Error) => {
          this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", method, bytes: 0, detail: capTraceDetail(`notification "${method}" failed: ${this.scrub(err.message)}`) });
        });
    this.chain = this.chain.then(send, send);
  }

  /** Graceful shutdown: no long-lived connection exists (each POST is
   *  independent) — mark closed, drain the in-flight chain (every send is
   *  bounded by its own timeout), done. Subsequent requests fail closed. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.chain;
    this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", bytes: 0, detail: capTraceDetail(`http transport closed (${redactUrl(this.url)})`) });
  }

  // -- internals -----------------------------------------------------------

  private scrub(text: string): string {
    const secrets = [...this.secrets];
    if (this.sessionId !== undefined) secrets.push(this.sessionId);
    return scrubSecrets(text, secrets);
  }

  private traceFrame(r: McpFrameRecord): void {
    if (this.traceSink === undefined) return;
    try {
      this.traceSink(r);
    } catch (err) {
      if (!this.traceSinkNoted) {
        this.traceSinkNoted = true;
        try {
          process.stderr.write(`mcp trace: record dropped (${err instanceof Error ? err.message : String(err)}) — tracing continues best-effort\n`);
        } catch {
          // nothing left to try — stay silent
        }
      }
    }
  }

  /** One POST — transport errors (network/abort) classified here so body
   *  reads can reuse the same classification. */
  private post(
    msg: { readonly jsonrpc: "2.0"; readonly method: string; readonly params: unknown; readonly id?: number },
    ctx: { readonly method: string; readonly id: number; readonly timeoutMs: number },
    mode: "request" | "notify",
  ): Promise<unknown> {
    return this.postWithAuth(msg, ctx, mode, true);
  }

  private async postWithAuth(
    msg: { readonly jsonrpc: "2.0"; readonly method: string; readonly params: unknown; readonly id?: number },
    ctx: { readonly method: string; readonly id: number; readonly timeoutMs: number },
    mode: "request" | "notify",
    allowAuthRetry: boolean,
    tokenOverride?: McpHttpAuthView,
  ): Promise<unknown> {
    // P2-16b: the dynamic bearer (absent seam / no token → undefined → the
    // header is simply not set — the 16a byte shape). A retry rides the token
    // refresh() just returned (not another lookup — deterministic, and no
    // chance of a second proactive refresh mid-retry).
    const token = tokenOverride ?? (this.auth === undefined ? undefined : await this.acquireToken());
    const payload = JSON.stringify(msg);
    const signal = AbortSignal.timeout(ctx.timeoutMs);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this.staticHeaders,
    };
    if (token !== undefined) {
      headers["Authorization"] = `Bearer ${token.accessToken}`;
      this.secrets.add(token.accessToken); // scrub 网延伸：上过线的 token 值
    }
    if (this.sessionId !== undefined) headers["Mcp-Session-Id"] = this.sessionId;
    const sentAt = Date.now();
    this.traceFrame({
      ts: new Date().toISOString(),
      dir: "→",
      method: msg.method,
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      bytes: Buffer.byteLength(payload, "utf8"),
      body: capTraceBody(payload),
    });
    let res: McpHttpResponse;
    try {
      res = await this.fetchImpl(this.url, { method: "POST", headers, body: payload, signal });
    } catch (err) {
      throw this.wrapTransportError(err, ctx.method, ctx.timeoutMs, signal);
    }
    // P2-16b: 401 + token on the wire → refresh ONCE and retry ONCE. A
    // second 401 (or a failed refresh) fails closed with the /mcp auth hint;
    // "no refresh_token" (refresh() → undefined) falls through to the
    // standard status error below (the 16a message, byte-identical).
    if (res.status === 401 && this.auth !== undefined && token !== undefined) {
      if (!allowAuthRetry) {
        this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", ...(ctx.id >= 0 ? { id: ctx.id } : {}), bytes: 0, detail: capTraceDetail(`HTTP 401 for ${ctx.method} after a token refresh`) });
        throw new Error(this.scrub(`MCP HTTP server rejected the token for "${this.auth.serverName}" (HTTP 401 for "${ctx.method}") after a refresh — token expired; rerun /mcp auth ${this.auth.serverName}`));
      }
      // Release the 401 body best-effort (it is server-controlled and never read).
      try {
        await res.body?.getReader().cancel();
      } catch {
        // already drained/dead — nothing to do
      }
      let fresh: McpHttpAuthView | undefined;
      try {
        fresh = await this.auth.refresh();
      } catch {
        // 刷新失败的细节不进文案：provider 层的报错文本不是本层可信任的
        // 面（自定义 seam 可能带未消毒值），且 scrub 集也覆盖不到从未上
        // 线的 refresh_token——fail-closed 只给指引（brief 红线 1）。
        throw new Error(this.scrub(`MCP HTTP token refresh for "${ctx.method}" on "${this.auth.serverName}" failed — token expired; rerun /mcp auth ${this.auth.serverName}`));
      }
      if (fresh !== undefined) {
        this.secrets.add(fresh.accessToken);
        this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", ...(ctx.id >= 0 ? { id: ctx.id } : {}), bytes: 0, detail: capTraceDetail(`HTTP 401 for ${ctx.method} — token refreshed, retrying once`) });
        return this.postWithAuth(msg, ctx, mode, false, fresh);
      }
    }
    if (mode === "notify") {
      // The response body is irrelevant (202 no-content is the spec shape) —
      // release it best-effort so the socket is not held by an unread body.
      try {
        await res.body?.getReader().cancel();
      } catch {
        // already drained/dead — nothing to do
      }
      return undefined;
    }
    return this.readResponse(res, { method: ctx.method, id: ctx.id, timeoutMs: ctx.timeoutMs, signal, sentAt });
  }

  /** getToken with a hard floor: a provider that throws means "no bearer"
   *  (its own layer owns the refresh fallback) — the request then rides the
   *  static/no-auth lane and the server's 401 owns the final verdict. */
  private async acquireToken(): Promise<McpHttpAuthView | undefined> {
    if (this.auth === undefined) return undefined;
    try {
      return await this.auth.getToken();
    } catch {
      return undefined;
    }
  }

  private wrapTransportError(err: unknown, method: string, timeoutMs: number, signal: AbortSignal): Error {
    if (signal.aborted) return new JsonRpcTimeoutError(method, timeoutMs);
    const raw = err instanceof Error ? err.message : String(err);
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return new Error(this.scrub(`MCP HTTP request "${method}" failed: ${capTraceDetail(`${raw}${cause}`)}`));
  }

  private async readResponse(res: McpHttpResponse, ctx: RequestContext): Promise<unknown> {
    if (res.status < 200 || res.status > 299) {
      // 只含数字 status：statusText/响应头/响应体都是服务器可控面（见过
      // token 的服务器可回显），一概不进文案。
      this.traceFrame({ ts: new Date().toISOString(), dir: "lifecycle", ...(ctx.id >= 0 ? { id: ctx.id } : {}), bytes: 0, detail: capTraceDetail(`HTTP ${res.status} for ${ctx.method} (${redactUrl(this.url)})`) });
      throw new Error(this.scrub(`MCP HTTP server responded HTTP ${res.status} for "${ctx.method}" (${redactUrl(this.url)})`));
    }
    // Session capture (spec: initialize; tolerant: any response — a server
    // rotating its id is honored). The id is quasi-secret: it joins the
    // scrub set and never appears in errors/traces by construction.
    const sid = res.headers.get("mcp-session-id");
    if (typeof sid === "string" && sid.length > 0) this.sessionId = sid;
    const ctype = (res.headers.get("content-type") ?? "").toLowerCase();
    if (ctype.includes("text/event-stream")) return this.readSseResponse(res, ctx);
    if (ctype !== "" && !ctype.includes("json")) {
      throw new Error(this.scrub(`MCP HTTP server for "${ctx.method}" responded with an unsupported content type (${capTraceDetail(ctype)})`));
    }
    return this.readJsonResponse(res, ctx);
  }

  private async readJsonResponse(res: McpHttpResponse, ctx: RequestContext): Promise<unknown> {
    let text = "";
    if (res.text !== undefined) {
      try {
        text = await res.text();
      } catch (err) {
        throw this.wrapTransportError(err, ctx.method, ctx.timeoutMs, ctx.signal);
      }
    }
    if (text.trim().length === 0) {
      throw new Error(`MCP HTTP server for "${ctx.method}" returned an empty body`);
    }
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch (err) {
      // JSON.parse 错误引文会引用 body 前缀（可携带服务器回显的 token）→ scrub + cap。
      throw new Error(this.scrub(`MCP HTTP response for "${ctx.method}" was not valid JSON (${capTraceDetail(err instanceof Error ? err.message : String(err))})`));
    }
    if (typeof msg !== "object" || msg === null) {
      throw new Error(`MCP HTTP server for "${ctx.method}" returned a non-object JSON body`);
    }
    const m = msg as { id?: unknown; method?: unknown } & JsonRpcResponseShape;
    if ("method" in m || !("id" in m)) {
      throw new Error(`MCP HTTP server for "${ctx.method}" returned a notification where a response was expected`);
    }
    if (m.id !== ctx.id) {
      throw new Error(`MCP HTTP server for "${ctx.method}" returned a response for a different request id`);
    }
    this.traceResponse(ctx, text);
    return this.settle(m);
  }

  private async readSseResponse(res: McpHttpResponse, ctx: RequestContext): Promise<unknown> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
      throw new Error(`MCP HTTP server for "${ctx.method}" sent an SSE response without a body`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    let dataLines: string[] = [];
    let matched: JsonRpcResponseShape | undefined;
    let matchedRaw = "";
    const dispatch = (): void => {
      if (matched !== undefined || dataLines.length === 0) return;
      const data = dataLines.join("\n");
      dataLines = [];
      let msg: unknown;
      try {
        msg = JSON.parse(data);
      } catch {
        return; // malformed event — skipped, stream stays usable
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as { id?: unknown } & JsonRpcResponseShape;
      // A RESPONSE has result/error and no method; notifications (no id) and
      // server→client requests (id + method) are both ignored — but counted.
      const isResponse = !("method" in m) && ("result" in m || "error" in m);
      if (isResponse && m.id === ctx.id) {
        matched = m;
        matchedRaw = data;
      } else {
        this.notificationsIgnored += 1;
      }
    };
    const onLine = (line: string): void => {
      if (line === "") {
        dispatch();
        return;
      }
      // The JSON-RPC message rides `data:` lines (SSE multi-line data joins
      // with \n); event:/id:/retry: fields and `:` comments are ignored.
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value !== undefined) buf += decoder.decode(value, { stream: true });
        if (done) break;
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          onLine(buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
        if (matched !== undefined) break; // 命中即止 —— 不等服务器关流（可保持长开的 SSE 形态）
      }
      if (matched === undefined) {
        buf += decoder.decode(); // flush the decoder
        if (buf !== "") {
          for (const line of buf.split("\n")) onLine(line.replace(/\r$/, ""));
        }
        dispatch(); // EOF flush: a final event without a trailing blank line still lands
      }
    } catch (err) {
      throw this.wrapTransportError(err, ctx.method, ctx.timeoutMs, ctx.signal);
    }
    const hit = matched as JsonRpcResponseShape | undefined;
    if (hit === undefined) {
      throw new Error(`MCP HTTP SSE stream for "${ctx.method}" ended without a response`);
    }
    // We have what we came for — release the stream (any trailing events
    // were never going to be read).
    void reader.cancel().catch(() => {});
    this.traceResponse(ctx, matchedRaw);
    return this.settle(hit);
  }

  /** Trace the ← record + settle a matched response (error member → the
   *  stdio JsonRpcError class; message scrubbed — server-controlled). */
  private traceResponse(ctx: RequestContext, raw: string): void {
    this.traceFrame({
      ts: new Date().toISOString(),
      dir: "←",
      id: ctx.id,
      bytes: Buffer.byteLength(raw, "utf8"),
      latencyMs: Math.max(0, Date.now() - ctx.sentAt),
      body: capTraceBody(this.scrub(raw)),
    });
  }

  private settle(m: JsonRpcResponseShape): unknown {
    if (m.error !== undefined) {
      throw new JsonRpcError(
        typeof m.error.code === "number" ? m.error.code : -32603,
        this.scrub(typeof m.error.message === "string" ? m.error.message : "unknown JSON-RPC error"),
      );
    }
    return m.result;
  }
}
